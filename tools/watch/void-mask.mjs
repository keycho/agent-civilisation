/**
 * §75: where the use test thinks the void is, as a picture of the mask.
 *
 * The first-load frame reads 20.9% void and looks, to a person, like a clean
 * whole-city opening with no visible edge. One of those is wrong and guessing
 * which is how a metric gets quietly tuned until it agrees. This prints the
 * mask itself — city, ground, void — over the frame, so the disagreement is
 * located rather than argued about.
 *
 *   node tools/watch/void-mask.mjs [chunk]
 */
import { chromium } from 'playwright'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`${ORIGIN}/w/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.evaluate(() => document.getElementById('watchBtn')?.click())
await page.waitForTimeout(10000)

const out = await page.evaluate(() => {
  const civ = window.civ
  civ.director.takeControl()
  civ.plate.home(true)
  const rig = civ.rig
  const cam = rig.camera
  const gy = civ.plate.groundY
  const he = civ.plate.halfExtent
  const roof = civ.plate.roofAt
  const ceiling = civ.plate.tallest
  const V = civ.three.Vector3
  const s = new V()
  const N = 30
  const FADE = 110
  const rows = []
  for (let iy = N - 1; iy >= 0; iy--) {
    let line = ''
    for (let ix = 0; ix < N; ix++) {
      s.set(-1 + (2 * (ix + 0.5)) / N, -1 + (2 * (iy + 0.5)) / N, 0.5)
      s.unproject(cam)
      s.sub(cam.position).normalize()
      if (s.y > -1e-6) {
        line += 'S' // sky
        continue
      }
      const step = Math.max(2, rig.distance * 0.012)
      let hit = false
      for (let k = 1; k <= 300; k++) {
        const t = k * step
        const y = cam.position.y + s.y * t
        if (y > ceiling && s.y > 0) break
        if (y < gy - 2) break
        if (y < roof(cam.position.x + s.x * t, cam.position.z + s.z * t)) {
          hit = true
          break
        }
      }
      if (hit) {
        line += '#' // roofline
        continue
      }
      const t = (gy - cam.position.y) / s.y
      const px = cam.position.x + s.x * t
      const pz = cam.position.z + s.z * t
      const { panCentreX: cx, panCentreZ: cz, panHalfX: hx, panHalfZ: hz } = rig.limits
      const outM = Math.max(Math.abs(px - cx) - hx, Math.abs(pz - cz) - hz)
      if (outM <= 0) line += '+' // ground inside the fabric
      else if (outM > FADE || Math.abs(px) > he || Math.abs(pz) > he) line += '.' // void
      else line += '~' // in the fade band
    }
    rows.push(line)
  }
  // where the chrome actually is, so "under a pane" can be told from "in the open"
  const panes = [...document.querySelectorAll('.pane, header, footer, #hud, [data-pane]')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 40 && r.height > 20)
    .map((r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`)
  return { rows, d: Math.round(rig.distance), polar: +rig.polar.toFixed(2), panes }
})
await browser.close()

console.log(`§75 void mask — ${CHUNK}, d=${out.d}, pitch ${out.polar}`)
console.log('  # roofline   + fabric ground   ~ fade band   . void   S sky\n')
for (const r of out.rows) console.log(`  ${r}`)
console.log(`\n  chrome rects: ${out.panes.join(' | ') || '(none matched)'}`)
