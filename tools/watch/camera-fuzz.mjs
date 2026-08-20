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

/**
 * §66.3: the bars measure FRAMED, not "not lost".
 *
 * 4% was a floor against losing the city, and a frame with 4% of it in shot is
 * a frame nobody would post. These are what a composed shot looks like: the
 * fabric filling nearly half the frame under free camera, more than half at
 * the home framing, and its centroid close enough to the middle that the shot
 * reads as being ABOUT the city rather than containing it.
 *
 * REVISED after the first contact sheet, which is what the contact sheet is
 * for. Raising the floor to 40% passed, and three of the ten frames were
 * unpostable: an empty yard with one silo, a flat roof plane, and the lens
 * pressed into a window wall. The number had gone up and still meant "not
 * lost", because coverage counted any ray landing inside the fabric's BOUNDING
 * BOX — bare ground included, the inside of a building included. It is now
 * counted against the built grid, so an empty yard scores what it looks like.
 */
const MIN_ON = 0.4
/**
 * §66.3, third pass: how much of the frame is BUILDING — REPORTED, NOT A BAR.
 *
 * Built to be a bar and falsified before it became one. The hypothesis was that
 * the tile score counts ground-with-something-on-it while the eye judges screen
 * area of standing geometry, so a floor on the latter would separate the frames
 * worth posting from the frames that are not. Measured against the sheet it is
 * ANTI-correlated: the two frames nobody would post — an empty olive yard with
 * a silo, and a wall of grey planes — score 99% and 76%, while the best frame
 * on the sheet scores 21%. Close to the ground at a shallow pitch, nearly every
 * ray eventually passes under some roofline, whatever the picture looks like.
 *
 * It stays in the report because a number that disagrees with the tile score is
 * worth seeing, and it does not become a floor, because putting a floor on a
 * measurement that runs the wrong way is how a bar starts measuring the harness
 * instead of the product. What the sheet actually separates on is LIGHT, which
 * is a property of where the camera is rather than of how it is bounded — see
 * docs/adapter-assumptions.md §19.
 */
const MIN_BUILT = Number(process.env.CIV_MIN_BUILT ?? 0)
/** the home framing is a portrait of the city, and has to be filled by it */
const HOME_MIN_ON = 0.6
/** after `0`, the fabric's centroid must land this close to screen centre */
const HOME_RADIUS = 0.05

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
await page.goto(`${ORIGIN}/w/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
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
  ({ minOn, minBuilt }) => {
    const civ = window.civ

    /**
     * §66.3: how much of the FRAME has city in it.
     *
     * Cast a grid of rays at the ground plane and ask what they land on. The
     * obvious version (project the four plate corners, intersect the boxes) is
     * wrong at street zoom and said so loudly: at 40 m with the camera looking
     * down at a corner, two plate corners fall behind the near plane, their
     * projections mirror, the box collapses and the metric reports 0% of a
     * frame that is entirely city. Rays never have that problem — one that
     * points at the sky simply misses.
     *
     * What a ray landing COUNTS AS is the §66.3 correction. Landing inside the
     * fabric's bounding box is not landing on city: schiedam's port district
     * is largely yard and water, and the frame the sheet caught was bare olive
     * ground with a single silo on it, scoring 100%. So a ray counts when
     * something stands where it lands.
     *
     * And it is scored by TILE, not by ray. Counting built rays would measure
     * the city's density — a low number in an open dock and a high one in a
     * terrace — when the question is whether the frame is FULL of city. A tile
     * counts when any ray in it finds something standing, so a well-composed
     * wide shot of a sparse district scores what it looks like: full.
     */
    const TILES = 6
    const PER = 4
    window.__coverage = () => {
      const cam = civ.rig.camera
      cam.updateMatrixWorld(true)
      const map = civ.plate.mode !== 'city'
      const groundY = map ? 0 : civ.plate.groundY
      const half = map
        ? { x: civ.plate.map.halfWidth, z: civ.plate.map.halfHeight }
        : { x: civ.plate.city.half[0], z: civ.plate.city.half[1] }
      const centre = map ? { x: 0, z: 0 } : { x: civ.plate.city.world[0], z: civ.plate.city.world[1] }
      // ray directions are bilinear in NDC before normalisation, so the basis
      // is lifted once rather than unprojecting a Vector3 per sample
      const e = cam.matrixWorld.elements
      const th = Math.tan((cam.fov * Math.PI) / 360)
      const tw = th * cam.aspect
      const px = cam.position.x
      const py = cam.position.y
      const pz = cam.position.z
      let on = 0
      for (let ty = 0; ty < TILES; ty++) {
        for (let tx = 0; tx < TILES; tx++) {
          let found = false
          for (let sy = 0; sy < PER && !found; sy++) {
            for (let sx = 0; sx < PER && !found; sx++) {
              const u = ((tx * PER + sx + 0.5) / (TILES * PER)) * 2 - 1
              const v = ((ty * PER + sy + 0.5) / (TILES * PER)) * 2 - 1
              const a = u * tw
              const b = v * th
              const dx = -e[8] + a * e[0] + b * e[4]
              const dy = -e[9] + a * e[1] + b * e[5]
              const dz = -e[10] + a * e[2] + b * e[6]
              if (Math.abs(dy) < 1e-9) continue
              const t = (groundY - py) / dy
              if (t <= 0) continue
              const gx = px + dx * t
              const gz = pz + dz * t
              if (Math.abs(gx - centre.x) > half.x || Math.abs(gz - centre.z) > half.z) continue
              // the map plate is uniformly the thing; the city has to be built on
              if (map || civ.plate.builtAt(gx, gz)) found = true
            }
          }
          if (found) on++
        }
      }
      return on / (TILES * TILES)
    }

    /**
     * §66.3, third pass: how much of the frame is BUILDING.
     *
     * The tile score above answers "is the frame full of city" and it is the
     * right answer to that question, but the second contact sheet showed it is
     * not the whole question. A dock at street distance lights up most tiles —
     * there IS something standing in each of them — and still photographs as an
     * empty olive yard with a silo in it. What the eye is actually judging is
     * how much of the picture is occupied by buildings, and that is a different
     * quantity from how much of the ground under the picture is built on.
     *
     * So: march each ray against the built grid as a heightfield and ask
     * whether it meets a wall or a roof. That is the screen area of standing
     * geometry, which is the thing being looked at. No pixels are read — the
     * context does not preserve its drawing buffer (§63 found that the hard
     * way) — and none are needed, because the grid already knows the shape.
     */
    const MARCH = 12
    window.__buildingCover = () => {
      const cam = civ.rig.camera
      cam.updateMatrixWorld(true)
      const e = cam.matrixWorld.elements
      const th = Math.tan((cam.fov * Math.PI) / 360)
      const tw = th * cam.aspect
      const px = cam.position.x
      const py = cam.position.y
      const pz = cam.position.z
      const roof = civ.plate.roofAt
      const ceiling = civ.plate.tallest
      const step = Math.max(2, civ.rig.distance * 0.012)
      let hit = 0
      let total = 0
      for (let iy = 0; iy < MARCH; iy++) {
        for (let ix = 0; ix < MARCH; ix++) {
          total++
          const a = (((ix + 0.5) / MARCH) * 2 - 1) * tw
          const b = (((iy + 0.5) / MARCH) * 2 - 1) * th
          let dx = -e[8] + a * e[0] + b * e[4]
          let dy = -e[9] + a * e[1] + b * e[5]
          let dz = -e[10] + a * e[2] + b * e[6]
          const len = Math.hypot(dx, dy, dz)
          dx /= len
          dy /= len
          dz /= len
          for (let s = 1; s <= 260; s++) {
            const t = s * step
            const y = py + dy * t
            // above everything and still climbing: this ray is sky
            if (y > ceiling && dy > 0) break
            // under the ground the whole fabric stands on: it has passed all of it
            if (y < civ.plate.groundY - 2) break
            if (y < roof(px + dx * t, pz + dz * t)) {
              hit++
              break
            }
          }
        }
      }
      return hit / total
    }

    window.__fuzz = {
      worst: 1,
      violations: [],
      frames: 0,
      modeFlips: 0,
      worstClearance: Infinity,
      worstBuilt: 1,
    }
    let lastMode = civ.plate.mode
    const tick = () => {
      if (civ.plate.mode !== lastMode) {
        lastMode = civ.plate.mode
        window.__fuzz.modeFlips++
        requestAnimationFrame(tick)
        return // the transition itself flies; judge it once it has landed
      }
      const onScreen = window.__coverage()
      const built = window.__buildingCover()
      window.__fuzz.frames++
      if (onScreen < window.__fuzz.worst) window.__fuzz.worst = onScreen
      if (built < window.__fuzz.worstBuilt) window.__fuzz.worstBuilt = built
      const clear = civ.rig.eyeClearance()
      if (clear < window.__fuzz.worstClearance) window.__fuzz.worstClearance = clear
      // §66.3's second finding rides `outOfBounds`, which now reports the eye
      const bad = civ.rig.outOfBounds()
      if (onScreen < minOn) bad.push(`city fills ${(onScreen * 100).toFixed(2)}% of the frame`)
      if (built < minBuilt) bad.push(`buildings cover ${(built * 100).toFixed(2)}% of the frame`)
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

    /**
     * §72.3: the same checks, run over a TRANSITION, by stepping the rig
     * instead of waiting for it.
     *
     * The fuzz above is per-frame and looks like it covers transitions, but it
     * cannot: it is driven by requestAnimationFrame, the rig's damping is
     * dt-driven with dt clamped to 50 ms, and under a software renderer at
     * ~1 fps a move takes minutes of wall clock and is sampled a handful of
     * times near its endpoints. Worse, every harness that settles before
     * measuring is looking at a state `enforce()` has already finished
     * correcting — which is exactly how a bound that was wrong on every
     * distance-changing path stayed invisible through four camera blocks.
     *
     * So: drive `rig.update(1/60)` directly and assert on every step. The rig
     * is deterministic and the renderer is not in the loop.
     */
    window.__stepFuzz = (steps) => {
      const out = { steps: 0, worst: 1, worstClearance: Infinity, violations: [] }
      for (let i = 0; i < steps; i++) {
        civ.rig.update(1 / 60)
        out.steps++
        const onScreen = window.__coverage()
        if (onScreen < out.worst) out.worst = onScreen
        const clear = civ.rig.eyeClearance()
        if (clear < out.worstClearance) out.worstClearance = clear
        const bad = civ.rig.outOfBounds()
        if (onScreen < minOn) bad.push(`city fills ${(onScreen * 100).toFixed(2)}% of the frame`)
        if (bad.length && out.violations.length < 8) {
          out.violations.push({
            step: i,
            why: bad,
            d: Math.round(civ.rig.distance),
            polar: +civ.rig.polar.toFixed(3),
            target: [+civ.rig.target.x.toFixed(1), +civ.rig.target.z.toFixed(1)],
          })
        }
      }
      return out
    }

    /** the fabric's own corner: where §65.2's bound is load-bearing */
    window.__corner = () => {
      const [hx, hy] = civ.plate.city.half
      const [cx, cy] = civ.plate.city.centre
      return [cx + hx * 0.98, cy + hy * 0.98]
    }

    window.__fuzzReset = () => {
      window.__fuzz = {
      worst: 1,
      violations: [],
      frames: 0,
      modeFlips: 0,
      worstClearance: Infinity,
      worstBuilt: 1,
    }
    }
  },
  { minOn: MIN_ON, minBuilt: MIN_BUILT },
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
let worstClearance = Infinity
let worstBuilt = 1

await mkdir(`${OUT}/contact`, { recursive: true })
const sheet = []

for (let s = 0; s < SEQUENCES; s++) {
  await page.evaluate(() => window.__fuzzReset())
  const inputs = []
  const steps = 4 + Math.floor(rnd() * 5)
  /**
   * §66.3: one frame per sequence, at a random step inside it, for the contact
   * sheet. The numbers can only say a frame is not broken; ten frames a person
   * looks at say whether it is a frame you would post, which is the thing the
   * numbers were failing to measure.
   */
  const snapAt = Math.floor(rnd() * steps)
  for (let i = 0; i < steps; i++) {
    const kind = pick(['orbit', 'pan', 'pan', 'wheel', 'orbit'])
    if (kind === 'wheel') inputs.push(await wheel(between(-2400, 2400)))
    else inputs.push(await drag(kind, between(-900, 900), between(-600, 600)))
    await page.waitForTimeout(140)
    if (i === snapAt) {
      await page.waitForTimeout(900)
      const shot = `${OUT}/contact/seq-${String(s).padStart(2, '0')}.png`
      await page.screenshot({ path: shot })
      const [tiles, built] = await page.evaluate(() => [window.__coverage(), window.__buildingCover()])
      sheet.push({
        file: `contact/seq-${String(s).padStart(2, '0')}.png`,
        sequence: s,
        step: i,
        tiles,
        built,
      })
    }
  }
  // let the damping finish moving wherever the inputs sent it
  await page.waitForTimeout(1600)
  const r = await page.evaluate(() => window.__fuzz)
  totalFrames += r.frames
  modeFlips += r.modeFlips
  worstOverall = Math.min(worstOverall, r.worst)
  worstBuilt = Math.min(worstBuilt, r.worstBuilt)
  worstClearance = Math.min(worstClearance, r.worstClearance)
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
  `  worst city coverage at any instant: ${(worstOverall * 100).toFixed(2)}% ` +
    `(floor ${(MIN_ON * 100).toFixed(0)}%)`,
)
console.log(
  `  worst building area in frame:       ${(worstBuilt * 100).toFixed(2)}% ` +
    `(floor ${(MIN_BUILT * 100).toFixed(0)}%)`,
)
console.log(
  `  least eye headroom over the roofline: ${
    Number.isFinite(worstClearance) ? `${worstClearance.toFixed(1)} m` : 'open ground throughout'
  }`,
)
console.log(`  sequences with a violating frame: ${failures.length}/${SEQUENCES}`)
console.log(`  §57.4 city<->map handovers seen: ${modeFlips}`)

// ---------------------------------------------------------------------------
// §72.3: director-driven states, stepped through the transition
// ---------------------------------------------------------------------------
/**
 * Every framing the director composes, aimed at the fabric's corner, driven
 * from the whole-plate view each shot starts from — and asserted on every step
 * of the way in rather than once it has arrived.
 */
const DIRECTOR_SHOTS = [
  { name: 'road', d: 280, p: 0.7 },
  { name: 'assembly', d: 330, p: 0.72 },
  { name: 'demolition', d: 300, p: 0.62 },
  { name: 'construction', d: 175, p: 0.88 },
  { name: 'agent', d: 118, p: 0.97 },
  { name: 'district', d: 640, p: 0.58 },
  { name: 'before / after', d: 520, p: 0.64 },
]
const stepped = []
for (const shot of DIRECTOR_SHOTS) {
  const r = await page.evaluate(
    ({ d, p }) => {
      const civ = window.civ
      civ.plate.home(true)
      const [x, y] = window.__corner()
      civ.rig.flyTo(civ.pointAt(x, y), d, { polar: p, duration: 3.2 })
      return window.__stepFuzz(600)
    },
    shot,
  )
  stepped.push({ ...shot, ...r })
}
// ...and home, which is the move back out
const homeStep = await page.evaluate(() => {
  const civ = window.civ
  const [x, y] = window.__corner()
  civ.rig.flyTo(civ.pointAt(x, y), 118, { polar: 0.97, duration: 1 })
  civ.rig.settle()
  civ.plate.home(false)
  return window.__stepFuzz(600)
})
// labelled for what it is: the move OUT, and its first steps are still the
// street state it was given, so a violation at step 0 belongs to that state
stepped.push({ name: 'home (from street)', d: 0, p: 0, ...homeStep })

const steppedBad = stepped.filter((r) => r.violations.length)
console.log(
  `\n§72.3 director-driven, stepped through the transition — ${stepped.length} framings, ` +
    `${stepped.reduce((a, r) => a + r.steps, 0)} steps asserted`,
)
for (const r of stepped) {
  console.log(
    `  ${r.name.padEnd(16)} worst coverage ${(r.worst * 100).toFixed(1).padStart(5)}%   ` +
      `least headroom ${
        Number.isFinite(r.worstClearance) ? `${r.worstClearance.toFixed(0)} m` : 'open ground'
      }   ${r.violations.length ? `${r.violations.length} VIOLATING STEPS` : 'clean'}`,
  )
  for (const v of r.violations.slice(0, 2)) {
    console.log(`      step ${v.step}: ${v.why.join('; ')} (d=${v.d} polar=${v.polar})`)
  }
}
console.log(`  framings with a violating step: ${steppedBad.length}/${stepped.length}`)

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

/**
 * §66.3: the home framing is a portrait. Measured with the SAME function the
 * per-frame sampler uses, so "60% of the frame is city" means the same thing in
 * both places — a second copy of the measurement here was how the two could
 * have drifted into disagreeing about what was being asserted.
 */
const homeCover = await page.evaluate(() => window.__coverage())
const homeOk = home.offCentre <= HOME_RADIUS && homeCover >= HOME_MIN_ON
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
  `  ${homeOk ? 'PASS' : 'FAIL'}  fabric centroid ${home.offCentre.toFixed(
    4,
  )} from screen centre (radius ${HOME_RADIUS}), fills ${(homeCover * 100).toFixed(
    1,
  )}% of the frame (floor ${(HOME_MIN_ON * 100).toFixed(0)}%)`,
)

/**
 * §66.3: the contact sheet, as one image.
 *
 * Ten frames pulled at random moments out of the fuzz sequences, tiled and
 * shot in one pass. No image library is needed for this and none is available:
 * a page that lays the files out in a grid and a screenshot of that page IS
 * the composite. The point of it is the one thing the numbers cannot do — if a
 * tile looks like a frame you would not post, the numbers are still measuring
 * the wrong thing.
 */
if (sheet.length) {
  const tiles = sheet
    .slice(0, 10)
    .map(
      (t) =>
        `<figure><img src="${t.file}"><figcaption>seq ${t.sequence} · ${(t.tiles * 100).toFixed(0)}% city · ` +
        `<b>${(t.built * 100).toFixed(0)}% building</b></figcaption></figure>`,
    )
    .join('')
  await writeFile(
    `${OUT}/contact-sheet.html`,
    `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#0d0c0a;color:#8a8069;
        font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
      h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
      .g{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:10px 12px}
      figure{margin:0}
      img{width:100%;display:block;border:1px solid #2a2620}
      figcaption{padding-top:3px}
      figcaption b{color:#e2a54f;font-weight:400}
     </style><h1>§66.3 contact sheet — seed ${SEED}, ${sheet.length} frames from ${SEQUENCES} sequences</h1>
     <div class="g">${tiles}</div>`,
  )
  const sheetPage = await browser.newPage({ viewport: { width: 1400, height: 700 } })
  await sheetPage.goto(`file://${process.cwd()}/${OUT}/contact-sheet.html`, {
    waitUntil: 'networkidle',
  })
  await sheetPage.screenshot({ path: `${OUT}/contact-sheet.png`, fullPage: true })
  await sheetPage.close()
  console.log(`\n  contact sheet: ${OUT}/contact-sheet.png (${sheet.length} frames)`)
}

await writeFile(
  `${OUT}/fuzz.json`,
  JSON.stringify(
    {
      seed: SEED,
      sequences: SEQUENCES,
      totalFrames,
      worstOverall,
      worstBuilt,
      worstClearance,
      modeFlips,
      bars: { MIN_ON, MIN_BUILT, HOME_MIN_ON, HOME_RADIUS },
      failures,
      bad,
      home,
      homeCover,
      homeOk,
      sheet,
    },
    null,
    2,
  ),
)
await browser.close()
process.exit(failures.length === 0 && homeOk ? 0 : 1)
