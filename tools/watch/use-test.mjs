/**
 * §75's acceptance: a real session, driven the way a person drives it.
 *
 * Not a coverage number. §66.3, §72.3 and §74 each made the camera's invariants
 * more correct and the camera stayed unusable, because every one of those bars
 * measured a state rather than a use. This drives the session §75 names and
 * photographs every step of it:
 *
 *   from first load, pan across the whole fabric corner to corner
 *   rotate 360 at three distances
 *   zoom whole-city -> street -> back, three times
 *   enter follow on an agent, then exit
 *
 * Two things must hold on EVERY frame:
 *   the city occupies the majority of the viewport
 *   no frame shows the plate edge with void beyond it
 *
 * Both are measured, not eyeballed, and the contact sheet is the verdict a
 * person reads. §74.2's rule applies — the state is printed beside the image,
 * because an a/b of a live world can confirm anything.
 *
 *   node tools/watch/use-test.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/75'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

/** §75: the city must be the majority of the viewport */
const CITY_FLOOR = 0.5
/** and no frame may show the plate edge with void beyond it */
const VOID_CEILING = 0.02
/**
 * §75, third clause and the one the first run of this needed: the frame has to
 * contain some of the GROUND the city stands on.
 *
 * The first contact sheet scored four frames at 100% city and 0% void, and all
 * four were the lens pressed against a facade at the minimum distance — every
 * ray hit a roofline, so by the majority test they were perfect. That is
 * §66.3's fault inverted, and it means "how much of the frame is city" cannot
 * judge a frame on its own. A picture of a city has streets in it.
 */
const GROUND_FLOOR = 0.1

await mkdir(`${OUT}/frames`, { recursive: true })

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
await page.evaluate(() => document.getElementById('watchBtn')?.click())
await page.waitForTimeout(12000)
// the session is the viewer's; the director must not take the camera back
await page.evaluate(() => window.civ.director.takeControl())

await page.evaluate(() => {
  const civ = window.civ
  const V = civ.three.Vector3
  const scratch = new V()

  /**
   * What the frame is made of, by ray.
   *
   * `city` counts rays that land on the CITY — either on a roofline or on the
   * ground inside the fabric box. Rooflines alone under-read a top-down frame
   * badly, because most of a city seen from above is street, canal and yard;
   * §66.3 learned the mirror of this when its coverage bar counted bare ground
   * as city. What a person means by "the city occupies the viewport" is the
   * city's footprint, so that is what is counted.
   *
   * `void` counts rays that leave over the horizon, miss the drawn plate, or
   * land far enough past the fabric to have been faded to the void colour by
   * §73.2. That last one is the point: ground beyond the fade band is black, so
   * it is void whether or not a mesh is technically under it.
   */
  const FADE_BAND = 110
  const N = 15
  /**
   * §74.2: report where the void is, not only how much. The world.log pane
   * covers a third of the viewport, so a ray through it is not something a
   * person sees — and a metric that cannot tell "past the plate edge, in the
   * open" from "past the plate edge, behind a pane" cannot answer §75's
   * question. Split, not excluded: the open share is the one that judges.
   */
  const chromeRects = () =>
    [...document.querySelectorAll('.pane, header, footer, #hud, [data-pane]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 40 && r.height > 20)

  window.__frame = () => {
    const rig = civ.rig
    const cam = rig.camera
    const gy = civ.plate.groundY
    const he = civ.plate.halfExtent
    const roof = civ.plate.roofAt
    const ceiling = civ.plate.tallest
    let city = 0
    let ground = 0
    let empty = 0
    let openEmpty = 0
    let total = 0
    const rects = chromeRects()
    const underChrome = (ndcX, ndcY) => {
      const px = ((ndcX + 1) / 2) * innerWidth
      const py = ((1 - ndcY) / 2) * innerHeight
      return rects.some((r) => px >= r.x && px <= r.right && py >= r.y && py <= r.bottom)
    }
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        total++
        const ndcX = -1 + (2 * (ix + 0.5)) / N
        const ndcY = -1 + (2 * (iy + 0.5)) / N
        const seen = !underChrome(ndcX, ndcY)
        scratch.set(ndcX, ndcY, 0.5)
        scratch.unproject(cam)
        scratch.sub(cam.position).normalize()
        if (scratch.y > -1e-6) {
          empty++
          if (seen) openEmpty++
          continue
        }
        // march for a roofline first; the fabric is what the eye reads
        const step = Math.max(2, rig.distance * 0.012)
        let hit = false
        for (let s = 1; s <= 300; s++) {
          const t = s * step
          const y = cam.position.y + scratch.y * t
          if (y > ceiling && scratch.y > 0) break
          if (y < gy - 2) break
          if (y < roof(cam.position.x + scratch.x * t, cam.position.z + scratch.z * t)) {
            hit = true
            break
          }
        }
        if (hit) {
          city++
          continue
        }
        const t = (gy - cam.position.y) / scratch.y
        const px = cam.position.x + scratch.x * t
        const pz = cam.position.z + scratch.z * t
        const { panCentreX: cx, panCentreZ: cz, panHalfX: hx, panHalfZ: hz } = rig.limits
        const out = Math.max(Math.abs(px - cx) - hx, Math.abs(pz - cz) - hz)
        if (out <= 0) {
          city++
          ground++
        }
        else if (out > FADE_BAND || Math.abs(px) > he || Math.abs(pz) > he) {
          empty++
          if (seen) openEmpty++
        }
      }
    }
    return {
      city: city / total,
      ground: ground / total,
      void: empty / total,
      openVoid: openEmpty / total,
      d: Math.round(rig.distance),
      polar: +rig.polar.toFixed(2),
      azimuth: +rig.azimuth.toFixed(2),
      target: [Math.round(rig.target.x), Math.round(rig.target.z)],
      oob: rig.outOfBounds(),
    }
  }

  /** step the rig itself: the renderer is not part of what is being tested */
  window.__step = (n) => {
    for (let i = 0; i < n; i++) civ.rig.update(1 / 60)
    return window.__frame()
  }
})

const frames = []
let shotIndex = 0

async function capture(label, { shoot = false } = {}) {
  const state = await page.evaluate(() => window.__frame())
  let file = null
  if (shoot) {
    file = `frames/${String(shotIndex++).padStart(2, '0')}.png`
    await page.screenshot({ path: `${OUT}/${file}` })
  }
  frames.push({ label, file, ...state })
  return state
}

/** drive an input and sample every step of the move, photographing the last */
async function move(label, fn, steps = 90, shots = 1) {
  await page.evaluate(fn)
  const every = Math.max(1, Math.floor(steps / 6))
  for (let i = 0; i < steps; i += every) {
    await page.evaluate((n) => window.__step(n), every)
    await capture(label)
  }
  for (let i = 0; i < shots; i++) await capture(label, { shoot: true })
}

console.log(`§75 use test — ${CHUNK}\n`)

// ---- first load ------------------------------------------------------------
await page.evaluate(() => window.civ.plate.home(true))
await capture('first load', { shoot: true })

// ---- pan corner to corner --------------------------------------------------
/**
 * The pan is driven at a street-ish distance, because that is where a viewer
 * pans and where the old scheme put the city in the corner. `pan` is called
 * with a large drag repeatedly, so the control runs to its own stop rather
 * than to a number this harness chose.
 */
await page.evaluate(() => {
  window.civ.rig.zoom(-2600)
  window.civ.rig.settle()
})
for (const [name, dx, dy] of [
  ['pan to the far corner', -1400, -900],
  ['pan to the near corner', 1400, 900],
  ['pan across the width', -1400, 900],
]) {
  await move(
    name,
    () => {},
    1,
    0,
  )
  await page.evaluate(
    ({ dx, dy }) => {
      for (let i = 0; i < 14; i++) window.civ.rig.pan(dx / 14, dy / 14)
    },
    { dx, dy },
  )
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__step(15))
    await capture(name)
  }
  await capture(name, { shoot: true })
}

// ---- rotate 360 at three distances -----------------------------------------
for (const [name, d] of [
  ['rotate 360, whole city', 1.0],
  ['rotate 360, district', 0.35],
  ['rotate 360, street', 0.06],
]) {
  await page.evaluate((frac) => {
    const rig = window.civ.rig
    const lo = rig.limits.minDistance
    const hi = rig.limits.maxDistance
    rig.zoom(20000)
    rig.settle()
    // walk down to the fraction with the control that exists, not by assignment
    let guard = 0
    while (rig.distance > lo + (hi - lo) * frac && guard++ < 400) {
      rig.zoom(-40)
      rig.update(1 / 60)
    }
    rig.settle()
  }, d)
  await capture(name)
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      for (let k = 0; k < 20; k++) window.civ.rig.orbit(-45, 0)
    })
    await page.evaluate(() => window.__step(20))
    await capture(name)
  }
  await capture(name, { shoot: true })
}

// ---- zoom whole-city -> street -> back, three times ------------------------
for (let pass = 0; pass < 3; pass++) {
  // settle first: reading a target mid-damp reports the damping as drift, which
  // is what the first run of this did
  const before = await page.evaluate(() => {
    window.civ.rig.settle()
    return { x: Math.round(window.civ.rig.target.x), z: Math.round(window.civ.rig.target.z) }
  })
  for (const [name, delta] of [
    [`zoom in, pass ${pass + 1}`, -2600],
    [`zoom out, pass ${pass + 1}`, 2600],
  ]) {
    await page.evaluate((d) => {
      for (let i = 0; i < 20; i++) window.civ.rig.zoom(d / 20)
    }, delta)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__step(18))
      await capture(name)
    }
    await capture(name, { shoot: pass === 0 })
  }
  const after = await page.evaluate(() => {
    window.civ.rig.settle()
    return { x: Math.round(window.civ.rig.target.x), z: Math.round(window.civ.rig.target.z) }
  })
  const drift = Math.hypot(after.x - before.x, after.z - before.z)
  console.log(
    `  zoom pass ${pass + 1}: target ${drift < 1 ? 'returned exactly' : `drifted ${drift.toFixed(1)} m`}`,
  )
}

// ---- follow an agent, then exit --------------------------------------------
const followed = await page.evaluate(() => {
  /**
   * The crew pane may not be open, and the first version of this looked for a
   * selector that does not exist — so the follow leg §75 asks for silently did
   * not run. Take an id from the agents the client is actually drawing.
   */
  const marks = window.civ.pixelMarks?.() ?? []
  const id = marks[0]?.id
  if (!id) return false
  window.civ.follow(id)
  return true
})
if (followed) {
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__step(25))
    await capture('following an agent')
  }
  await capture('following an agent', { shoot: true })
  await page.evaluate(() => window.civ.follow(null))
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__step(25))
    await capture('follow released')
  }
  await capture('follow released', { shoot: true })
} else {
  console.log('  (follow: no agent row to click)')
}

// ---- `0` back to home ------------------------------------------------------
await page.evaluate(() => window.civ.plate.home(false))
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window.__step(20))
  await capture('0 back to home')
}
await capture('0 back to home', { shoot: true })

await browser.close()

// ---- the verdict -----------------------------------------------------------
const bad = (f) => f.city < CITY_FLOOR || f.openVoid > VOID_CEILING || f.ground < GROUND_FLOOR
const failed = frames.filter(bad)
const byLabel = new Map()
for (const f of frames) {
  const cur = byLabel.get(f.label) ?? {
    n: 0,
    minCity: 1,
    minGround: 1,
    maxVoid: 0,
    maxOpen: 0,
    bad: 0,
  }
  cur.n++
  cur.minCity = Math.min(cur.minCity, f.city)
  cur.minGround = Math.min(cur.minGround, f.ground)
  cur.maxVoid = Math.max(cur.maxVoid, f.void)
  cur.maxOpen = Math.max(cur.maxOpen, f.openVoid)
  if (bad(f)) cur.bad++
  byLabel.set(f.label, cur)
}
console.log(
  '\n  step                        frames   min city   min ground   max void   in the open   failing',
)
for (const [label, s] of byLabel) {
  console.log(
    `  ${label.padEnd(27)} ${String(s.n).padStart(6)}   ${(s.minCity * 100)
      .toFixed(1)
      .padStart(7)}%   ${(s.minGround * 100).toFixed(1).padStart(9)}%   ${(s.maxVoid * 100)
      .toFixed(1)
      .padStart(7)}%   ${(s.maxOpen * 100).toFixed(1).padStart(10)}%   ${String(s.bad).padStart(7)}`,
  )
}
const oob = frames.filter((f) => f.oob.length)
console.log(
  `\n  ${frames.length} frames sampled, ${failed.length} failing, ${oob.length} with a rig complaint`,
)
if (oob.length) console.log(`    first: ${oob[0].label} — ${oob[0].oob.join('; ')}`)

const tiles = frames
  .filter((f) => f.file)
  .map(
    (f) =>
      `<figure class="${bad(f) ? 'bad' : ''}">` +
      `<img src="${f.file}">` +
      `<figcaption>${f.label}<br>city ${(f.city * 100).toFixed(0)}% · void ${(f.void * 100).toFixed(
        0,
      )}% · d=${f.d} · pitch ${f.polar}</figcaption></figure>`,
  )
  .join('')
await writeFile(
  `${OUT}/use-test.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    .g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:10px 12px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figure.bad img{border-color:#8c3a2a}
    figcaption{padding-top:3px}
   </style><h1>§75 use test — ${CHUNK} — ${frames.length} frames, ${failed.length} failing</h1>
   <div class="g">${tiles}</div>`,
)
console.log(`\n  ${OUT}/use-test.html`)
await writeFile(`${OUT}/use-test.json`, JSON.stringify({ chunk: CHUNK, frames }, null, 2))
{
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
  const sheet = await b.newPage({ viewport: { width: 1400, height: 1000 } })
  await sheet.goto(`file://${process.cwd()}/${OUT}/use-test.html`, { waitUntil: 'networkidle' })
  await sheet.screenshot({ path: `${OUT}/use-test.png`, fullPage: true })
  await b.close()
  console.log(`  ${OUT}/use-test.png`)
}
console.log(
  `\n  VERDICT: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ` +
    `${frames.length - failed.length}/${frames.length} frames hold the city above ` +
    `${CITY_FLOOR * 100}% with no void past the plate edge`,
)
process.exit(failed.length ? 1 : 0)
