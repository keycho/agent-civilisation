/**
 * §66.3 negative control for the eye-clearance invariant.
 *
 * An invariant that never fires is indistinguishable from an invariant that is
 * not wired up. This puts the camera in the SAME constructed state twice —
 * pointed at the tallest thing in the chunk from street distance, at the pitch
 * that lays the lens along the ground — once with the roofline probe attached
 * and once with it detached, and reports the eye's headroom each way.
 *
 * A first version drove the same mouse inputs both ways and proved nothing: the
 * guard resists exactly the inputs that would breach it, so the guarded run
 * ended up somewhere the unguarded run never went, and the two numbers were not
 * about the same frame. Constructing the state removes that.
 *
 *   node tools/watch/clearance-control.mjs [chunk]
 */
import { chromium } from 'playwright'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

async function run(guarded) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
  await page.goto(`${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2000)

  const out = await page.evaluate((on) => {
    const civ = window.civ
    civ.director.enabled = false
    // the tallest cell in the fabric, found with the same probe the rig uses
    const c = civ.plate.city
    let best = { y: -Infinity, x: 0, z: 0 }
    for (let z = c.world[1] - c.half[1]; z <= c.world[1] + c.half[1]; z += 6) {
      for (let x = c.world[0] - c.half[0]; x <= c.world[0] + c.half[0]; x += 6) {
        const y = civ.plate.ceilingNear(x, z, 0)
        if (y > best.y) best = { y, x, z }
      }
    }
    // detach or attach the ENFORCEMENT; the probe itself stays reachable so
    // both runs measure the same quantity
    civ.rig.ceilingNear = on ? civ.plate.ceilingNear : null
    /**
     * Aim so the EYE lands on the tall roof, not the target.
     *
     * A first version pointed the camera AT the tallest building and neither
     * run breached: at 40 m and the pitch the lens limits allow, the eye sits
     * about 35 m back from what it is looking at, which put it over a low
     * building on the other side of the street. The state that breaches is the
     * one where the camera itself is inside the fabric, so the target is
     * solved backwards from where the eye has to be.
     */
    const d = 40
    const polar = 1.25
    const azimuth = 0.6
    const reach = d * Math.sin(polar)
    civ.rig.flyTo(
      new civ.Vector3(
        best.x - reach * Math.sin(azimuth),
        civ.plate.groundY,
        best.z - reach * Math.cos(azimuth),
      ),
      d,
      { polar, azimuth, duration: 0.01 },
    )
    civ.rig.settle()
    const cam = civ.rig.camera
    const radius = Math.max(6, Math.min(40, civ.rig.distance * 0.15))
    const top = civ.plate.ceilingNear(cam.position.x, cam.position.z, radius)
    return {
      tallest: +best.y.toFixed(1),
      headroom: Number.isFinite(top) ? +(cam.position.y - (top + 7)).toFixed(1) : null,
      eyeY: +cam.position.y.toFixed(1),
      polar: +civ.rig.polar.toFixed(3),
      d: Math.round(civ.rig.distance),
    }
  }, guarded)

  await page.screenshot({
    path: `tools/watch/evidence/62/clearance-${guarded ? 'a-guarded' : 'b-control'}.png`,
  })
  await page.close()
  return out
}

const guarded = await run(true)
const control = await run(false)
console.log('§66.3 eye-clearance negative control')
console.log(`  same constructed state, aimed at the tallest roof in ${CHUNK} (${guarded.tallest} m)`)
console.log(`  guarded    headroom ${fmt(guarded.headroom)}  eye ${guarded.eyeY} m, polar ${guarded.polar}, d=${guarded.d}`)
console.log(`  unguarded  headroom ${fmt(control.headroom)}  eye ${control.eyeY} m, polar ${control.polar}, d=${control.d}`)
/**
 * A null headroom on the GUARDED run is the strongest pass there is, not a
 * missing measurement: it means the lift carried the eye clear of every
 * roofline in reach. The first version of this line required a number and
 * called that outcome a failure.
 */
const ok =
  (guarded.headroom === null || guarded.headroom >= -0.5) &&
  control.headroom !== null &&
  control.headroom < -0.5
console.log(`  the guard pitched ${control.polar} -> ${guarded.polar} and lifted the eye ${(guarded.eyeY - control.eyeY).toFixed(1)} m`)
console.log(`  ${ok ? 'PASS' : 'FAIL'}  the guard holds and the control breaches`)
function fmt(v) {
  return v === null ? 'not over built ground' : `${v > 0 ? '+' : ''}${v} m`
}
await browser.close()
process.exit(ok ? 0 : 1)
