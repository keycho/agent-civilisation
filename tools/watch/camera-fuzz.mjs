/**
 * §62.2: verification must be interactive.
 *
 * §57.4 was verified by CONSTRUCTING camera states — home framing, maximum
 * zoom-out — and measuring those. Both can be correct while free orbit walks
 * outside the envelope on the way between them, which is exactly what
 * production did. So this harness drives real pointer and wheel events at the
 * canvas, in randomised sequences, and asserts on EVERY FRAME that:
 *
 *   - the plate's projected bounds intersect the viewport by at least MIN_ON
 *   - target, pitch and distance are inside the rig's own limits
 *
 * The per-frame sampler runs inside the page on rAF, so it sees the same
 * states the renderer does rather than the endpoints the driver constructed.
 * A failing sequence prints its input list, seeded, so it replays exactly.
 *
 *   node tools/watch/camera-fuzz.mjs [sequences=12] [seed=1] [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const SEQUENCES = Number(process.argv[2] ?? 12)
const SEED = Number(process.argv[3] ?? 1)
const CHUNK = process.argv[4] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/62'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

/** the plate must never cover less of the frame than this, at any instant */
const MIN_ON = 0.04
/** after `0`, the plate's centroid must land this close to screen centre */
const HOME_RADIUS = 0.12

await mkdir(OUT, { recursive: true })

/** deterministic, so a failing sequence is reproducible from its seed alone */
let rngState = SEED >>> 0
function rnd() {
  rngState = (rngState * 1664525 + 1013904223) >>> 0
  return rngState / 4294967296
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const between = (a, b) => a + rnd() * (b - a)

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(`${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.evaluate(() => {
  document.getElementById('watchBtn')?.click()
  window.civ.director.enabled = false
})
await page.waitForTimeout(9000)

// ---------------------------------------------------------------------------
// the per-frame sampler, installed in the page
// ---------------------------------------------------------------------------
await page.evaluate(
  ({ minOn }) => {
    const civ = window.civ
    const V = civ.Vector3
    // §57.4 lets a zoom-out past the city's maximum hand over to the flat map,
    // which is product behaviour and not a violation — so the assertion is
    // against whichever plate is on screen. Both must stay findable.
    const plateNow = () => {
      if (civ.plate.mode === 'city') {
        const h = civ.plate.halfExtent
        return { y: civ.plate.groundY, half: { x: h, z: h } }
      }
      const { halfWidth: x, halfHeight: z } = civ.plate.map
      return { y: 0, half: { x, z } }
    }
    window.__fuzz = { worst: 1, violations: [], frames: 0, modeFlips: 0 }
    let lastMode = civ.plate.mode
    const tick = () => {
      const cam = civ.rig.camera
      cam.updateMatrixWorld(true)
      if (civ.plate.mode !== lastMode) {
        lastMode = civ.plate.mode
        window.__fuzz.modeFlips++
        requestAnimationFrame(tick)
        return // the transition itself flies; judge it once it has landed
      }
      const { y: groundY, half } = plateNow()
      /**
       * How much of the FRAME is city — measured by casting a grid of viewport
       * samples at the ground plane and asking which land on the plate.
       *
       * The obvious version (project the four plate corners, intersect the
       * boxes) is wrong at street zoom and said so loudly: at 40 m with the
       * camera looking down at a corner, two plate corners fall behind the
       * near plane, their projections mirror, the box collapses and the metric
       * reports 0% of a frame that is entirely city. Rays never have that
       * problem — one that points at the sky simply misses.
       */
      let hit = 0
      let total = 0
      for (let iy = 0; iy < 13; iy++) {
        for (let ix = 0; ix < 13; ix++) {
          total++
          const ndc = new V((ix / 6) - 1, (iy / 6) - 1, 0.5).unproject(cam)
          const dir = ndc.sub(cam.position)
          if (Math.abs(dir.y) < 1e-6) continue
          const t = (groundY - cam.position.y) / dir.y
          if (t <= 0) continue
          const gx = cam.position.x + dir.x * t
          const gz = cam.position.z + dir.z * t
          if (Math.abs(gx) <= half.x && Math.abs(gz) <= half.z) hit++
        }
      }
      const onScreen = hit / total
      window.__fuzz.frames++
      if (onScreen < window.__fuzz.worst) window.__fuzz.worst = onScreen
      const bad = civ.rig.outOfBounds()
      if (onScreen < minOn) bad.push(`plate covers ${(onScreen * 100).toFixed(2)}% of the frame`)
      if (bad.length && window.__fuzz.violations.length < 12) {
        window.__fuzz.violations.push({
          at: window.__fuzz.frames,
          why: bad,
          d: Math.round(civ.rig.distance),
          polar: +civ.rig.polar.toFixed(3),
          target: [+civ.rig.target.x.toFixed(1), +civ.rig.target.z.toFixed(1)],
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__fuzzReset = () => {
      window.__fuzz = { worst: 1, violations: [], frames: 0, modeFlips: 0 }
    }
  },
  { minOn: MIN_ON },
)

// ---------------------------------------------------------------------------
// real input
// ---------------------------------------------------------------------------
const CX = 640
const CY = 400

async function drag(kind, dx, dy, steps = 10) {
  const x0 = between(300, 980)
  const y0 = between(200, 600)
  await page.mouse.move(x0, y0)
  if (kind === 'pan') await page.keyboard.down('Shift')
  await page.mouse.down({ button: 'left' })
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps)
  }
  await page.mouse.up({ button: 'left' })
  if (kind === 'pan') await page.keyboard.up('Shift')
  return { kind, x0: Math.round(x0), y0: Math.round(y0), dx: Math.round(dx), dy: Math.round(dy) }
}

async function wheel(delta) {
  await page.mouse.move(CX, CY)
  await page.mouse.wheel(0, delta)
  return { kind: 'wheel', delta: Math.round(delta) }
}

const failures = []
let worstOverall = 1
let totalFrames = 0
let modeFlips = 0

for (let s = 0; s < SEQUENCES; s++) {
  await page.evaluate(() => window.__fuzzReset())
  const inputs = []
  const steps = 4 + Math.floor(rnd() * 5)
  for (let i = 0; i < steps; i++) {
    const kind = pick(['orbit', 'pan', 'pan', 'wheel', 'orbit'])
    if (kind === 'wheel') inputs.push(await wheel(between(-2400, 2400)))
    else inputs.push(await drag(kind, between(-900, 900), between(-600, 600)))
    await page.waitForTimeout(140)
  }
  // let the damping finish moving wherever the inputs sent it
  await page.waitForTimeout(1600)
  const r = await page.evaluate(() => window.__fuzz)
  totalFrames += r.frames
  modeFlips += r.modeFlips
  worstOverall = Math.min(worstOverall, r.worst)
  if (r.violations.length) {
    failures.push({ sequence: s, seed: SEED, inputs, worst: r.worst, violations: r.violations })
    console.log(
      `  seq ${s}: ${r.violations.length} violating frames, worst coverage ${(
        r.worst * 100
      ).toFixed(2)}%`,
    )
    for (const v of r.violations.slice(0, 3)) console.log(`      ${v.why.join('; ')}`)
    console.log(`      inputs: ${JSON.stringify(inputs)}`)
  }
}

console.log(
  `\n§62.2 interactive fuzz — ${SEQUENCES} sequences, ${totalFrames} frames asserted, seed ${SEED}`,
)
console.log(
  `  worst plate coverage at any instant: ${(worstOverall * 100).toFixed(2)}% ` +
    `(floor ${(MIN_ON * 100).toFixed(0)}%)`,
)
console.log(`  sequences with a violating frame: ${failures.length}/${SEQUENCES}`)
console.log(`  §57.4 city<->map handovers seen: ${modeFlips}`)

// ---------------------------------------------------------------------------
// §62.4: `0` recovers from any state, including a deliberately bad one
// ---------------------------------------------------------------------------
// §62.4 is about the CITY camera, so come back if the fuzz handed over to the
// map on the way — and give the arrival its sweep before driving off again
if (await page.evaluate(() => window.civ.plate.mode !== 'city')) {
  await page.evaluate(() => window.civ.ui.diveTo(window.civ.ui.chunks()[0]?.id ?? 'schiedam-havens'))
  await page.waitForTimeout(6000)
}
// drive the camera as far from home as the inputs can take it, then capture
for (let i = 0; i < 6; i++) {
  await drag('pan', 900, 600, 12)
  await page.waitForTimeout(80)
}
await wheel(-2400)
await drag('orbit', 700, -420, 12)
await page.waitForTimeout(1800)
const bad = await page.evaluate(() => ({
  mode: window.civ.plate.mode,
  d: Math.round(window.civ.rig.distance),
  polar: +window.civ.rig.polar.toFixed(3),
  target: [+window.civ.rig.target.x.toFixed(1), +window.civ.rig.target.z.toFixed(1)],
  azimuth: +window.civ.rig.azimuth.toFixed(3),
  coverage: window.__fuzz.worst,
}))
await page.screenshot({ path: `${OUT}/a-worst-state.png` })

await page.keyboard.press('0')
await page.waitForTimeout(2200)
const home = await page.evaluate(() => {
  const civ = window.civ
  civ.rig.settle()
  civ.rig.camera.updateMatrixWorld(true)
  const y = civ.plate.mode === 'city' ? civ.plate.groundY : 0
  const v = new civ.Vector3(0, y, 0).project(civ.rig.camera)
  return {
    mode: civ.plate.mode,
    offCentre: Math.hypot(v.x, v.y),
    d: Math.round(civ.rig.distance),
    polar: +civ.rig.polar.toFixed(3),
    azimuth: +civ.rig.azimuth.toFixed(3),
    target: [+civ.rig.target.x.toFixed(1), +civ.rig.target.z.toFixed(1)],
  }
})
await page.screenshot({ path: `${OUT}/b-after-zero.png` })

const homeOk = home.offCentre <= HOME_RADIUS
console.log(`\n§62.4 \`0\` from a deliberately bad state`)
console.log(
  `  before: ${bad.mode} d=${bad.d} polar=${bad.polar} azimuth=${bad.azimuth} target=(${bad.target.join(', ')})`,
)
console.log(
  `  after:  ${home.mode} d=${home.d} polar=${home.polar} azimuth=${home.azimuth} target=(${home.target.join(
    ', ',
  )})`,
)
console.log(
  `  ${homeOk ? 'PASS' : 'FAIL'}  plate centroid ${home.offCentre.toFixed(
    4,
  )} from screen centre (radius ${HOME_RADIUS})`,
)

await writeFile(
  `${OUT}/fuzz.json`,
  JSON.stringify(
    { seed: SEED, sequences: SEQUENCES, totalFrames, worstOverall, modeFlips, failures, bad, home, homeOk },
    null,
    2,
  ),
)
await browser.close()
process.exit(failures.length === 0 && homeOk ? 0 : 1)
