/**
 * §76.2 acceptance: the opening is an orienting shot.
 *
 * "0 and first load present the entire fabric within the open canvas with a
 * small margin on all sides, and the distance range extends both further out
 * (to hold that) and as close as it does now."
 *
 * PRE-REGISTERED, written before the first run:
 *
 *   B1  at first load, all four corners of the fabric project INSIDE the open
 *       canvas, with margin. Measured on the corners rather than on a coverage
 *       percentage, because "the entire fabric" is a statement about the
 *       extremes and a percentage cannot see a cropped corner.
 *
 *   B2  and it fills that canvas rather than sitting in it as a small
 *       rectangle — the ray-marched majority of the open canvas is fabric.
 *       This is the half that the pitch curve's far end has to buy; a frame
 *       can pass B1 by simply retreating until the plate is a stamp.
 *
 *   B3  the tighter framing still works: at 2040, the distance that used to be
 *       home, the frame is a district view filling the open canvas. The
 *       opening prioritises comprehension, and this is what you get once you
 *       are in.
 *
 *   B4  zoom-out from ANY state reaches the home framing rather than stopping
 *       short. Checked from four genuinely different states — zoomed to the
 *       floor, panned to a corner, rotated, and mid-tween — because a limit
 *       that is only reachable from rest is not a limit a viewer can use.
 *
 *   B5  the pitch curve's far end lands exactly at the home distance, so home
 *       is on the curve rather than beside it. This is the invariant that
 *       keeps §75's "pitch is a function of distance" true after §76.2 gave
 *       the curve a second segment.
 *
 *   node tools/watch/opening.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
const OUT = process.env.CIV_OUT ?? 'tools/watch/opening'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 35)

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '2560x1200', width: 2560, height: 1200 },
]

await mkdir(`${OUT}/shots`, { recursive: true })

/** where the fabric's corners land, in units of the OPEN canvas half-extent */
const CORNERS = () => {
  const civ = window.civ
  const cam = civ.rig.camera
  const V = civ.three.Vector3
  const h = civ.plate.halfExtent
  const gy = civ.plate.groundY
  const f = civ.canvasFrame()
  const openFrac = (f.open[1] - f.open[0]) / f.viewport[0]
  /**
   * §76.1 shifts the frame so the target lands at the OPEN canvas centre,
   * which is not NDC 0. The first cut of this probe compared |ndc.x| against
   * the open half-width as though it were, and reported the fabric 44% outside
   * a canvas the solve had just fitted it into. The solve is right — it
   * projects through an unshifted probe camera, where the two centres do
   * coincide — and the check was measuring from the wrong origin.
   */
  const openCentreNdc = ((f.open[0] + f.open[1]) / f.viewport[0]) - 1
  let worstX = 0
  let worstY = 0
  for (const [x, z] of [
    [-h, -h],
    [h, -h],
    [-h, h],
    [h, h],
  ]) {
    const p = new V(x, gy, z).project(cam)
    // 1.0 means exactly on the edge of the visible canvas; over 1 is cropped
    worstX = Math.max(worstX, Math.abs(p.x - openCentreNdc) / openFrac)
    worstY = Math.max(worstY, Math.abs(p.y))
  }
  return {
    worstX: +worstX.toFixed(3),
    worstY: +worstY.toFixed(3),
    d: Math.round(civ.rig.distance),
    polar: +civ.rig.polar.toFixed(3),
    maxD: Math.round(civ.rig.limits.maxDistance),
    minD: Math.round(civ.rig.limits.minDistance),
    homePitch: +civ.rig.homePitch.toFixed(3),
    pitchAtMax: +civ.rig.pitchFor(civ.rig.limits.maxDistance).toFixed(3),
    openFrac: +openFrac.toFixed(4),
  }
}

/**
 * How much of the OPEN canvas is FABRIC, by ray march.
 *
 * The first cut counted only rays that struck a ROOF, which measures built
 * mass — at a whole-plate framing that is 9-23% of the canvas whatever the
 * camera does, because a city seen whole is mostly ground. B2 asks whether the
 * fabric fills the frame, so the hit test is "the ray lands on the plate",
 * and built coverage is reported alongside as information.
 */
const FILL = () => {
  const civ = window.civ
  const rig = civ.rig
  const cam = rig.camera
  const gy = civ.plate.groundY
  const roof = civ.plate.roofAt
  const V = civ.three.Vector3
  const s = new V()
  const f = civ.canvasFrame()
  const openFrac = (f.open[1] - f.open[0]) / f.viewport[0]
  /**
   * The open canvas in NDC, which after §76.1 is NOT centred on zero — the
   * frame is shifted so the target lands at the open centre instead. This
   * probe sampled a band about zero and so measured a rectangle that was
   * partly behind the chrome and partly off the left of the canvas, reporting
   * 47% for a frame whose plate visibly spans 89% of the width. The same fault
   * was fixed in CORNERS above and missed here.
   */
  const c = (f.open[0] + f.open[1]) / f.viewport[0] - 1
  const lo = c - openFrac
  const hi = c + openFrac
  const half = civ.plate.halfExtent
  const N = 48
  let hit = 0
  let built = 0
  let total = 0
  for (let ix = 0; ix < N; ix++) {
    for (let iy = 0; iy < N; iy++) {
      const nx = lo + ((hi - lo) * (ix + 0.5)) / N
      const ny = -1 + (2 * (iy + 0.5)) / N
      s.set(nx, ny, 0.5)
      s.unproject(cam)
      s.sub(cam.position).normalize()
      total++
      if (s.y > -1e-6) continue
      const step = Math.max(2, rig.distance * 0.012)
      let onBuilt = false
      for (let k = 1; k <= 320; k++) {
        const t = k * step
        const y = cam.position.y + s.y * t
        if (y < gy - 2) break
        if (y < roof(cam.position.x + s.x * t, cam.position.z + s.z * t)) {
          onBuilt = true
          break
        }
      }
      if (onBuilt) {
        hit++
        built++
        continue
      }
      // no roof: does the ray land on the plate itself?
      const t = (gy - cam.position.y) / s.y
      const px = cam.position.x + s.x * t
      const pz = cam.position.z + s.z * t
      if (Math.abs(px) <= half && Math.abs(pz) <= half) hit++
    }
  }
  return { fabric: +((hit / total) * 100).toFixed(1), built: +((built / total) * 100).toFixed(1) }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const rows = []
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
  await page.goto(`${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.evaluate(() => document.getElementById('watchBtn')?.click())
  await page.waitForTimeout(BUILD_S * 1000)

  // the OPENING, as a viewer gets it: settle the arrival, take nothing else
  await page.evaluate(async () => {
    const civ = window.civ
    civ.director.takeControl()
    civ.director.enabled = false
    civ.plate.home(true)
    await new Promise((r) => setTimeout(r, 1800))
    civ.connection.close()
    civ.freezeClock(20)
  })
  const open = { corners: await page.evaluate(CORNERS), fill: await page.evaluate(FILL) }
  // the most a SQUARE plate can occupy of this canvas, seen from overhead:
  // filling the height fills only 1/openAspect of the width, and the margin
  // costs a factor on each axis
  {
    const f = await page.evaluate(() => window.civ.canvasFrame())
    const openAspect = (f.open[1] - f.open[0]) / vp.height
    open.ceiling = (100 / (openAspect * 1.1 * 1.1))
  }
  await page.screenshot({ path: `${OUT}/shots/${vp.name}-opening.png` })

  // the district framing: PITCH_FULL_AT, where the curve reaches PITCH_MID
  await page.evaluate(async () => {
    const rig = window.civ.rig
    rig.flyTo(rig.target.clone(), 1200, { duration: 0.01 })
    rig.settle()
  })
  /**
   * Frames, not milliseconds — the fault this harness's own header records,
   * still present on this one path. A 300 ms wait need not contain a rendered
   * frame under swiftshader, and every probe below projects through matrices
   * that only `apply()` refreshes.
   */
  await page.evaluate(
    () =>
      new Promise((r) => {
        let n = 0
        const tick = () => (++n >= 3 ? r() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
  )
  const near = { corners: await page.evaluate(CORNERS), fill: await page.evaluate(FILL) }
  await page.screenshot({ path: `${OUT}/shots/${vp.name}-district.png` })

  /**
   * B4: four genuinely different states, then scroll out hard. A limit only
   * reachable from rest is not a limit a viewer can use.
   */
  const reach = await page.evaluate(async () => {
    const civ = window.civ
    const rig = civ.rig
    const out = []
    const states = [
      ['zoomed to the floor', () => rig.flyTo(rig.target.clone(), rig.limits.minDistance, { duration: 0.01 })],
      ['panned to a corner', () => { rig.pan(-4000, -4000) }],
      ['rotated 140 degrees', () => { rig.orbit(600, 0) }],
      ['mid-tween', () => rig.flyTo(rig.target.clone(), 900, { duration: 3 })],
    ]
    for (const [name, set] of states) {
      set()
      await new Promise((r) => setTimeout(r, 300))
      for (let i = 0; i < 60; i++) rig.zoom(400)
      /**
       * Settle rather than wait. The first cut waited 1.4 s and reported the
       * camera up to 497 m short of the limit — which is the exponential damp
       * still in flight, not a limit the viewer cannot reach. The claim is
       * about the REACHABLE SET, so the measurement has to be taken where the
       * motion ends.
       */
      rig.settle()
      await new Promise((r) => setTimeout(r, 200))
      out.push({
        name,
        d: Math.round(rig.distance),
        max: Math.round(rig.limits.maxDistance),
        short: Math.round(rig.limits.maxDistance - rig.distance),
      })
    }
    return out
  })

  await page.close()
  rows.push({ vp, open, near, reach })
}
await browser.close()

console.log(`§76.2 the opening — ${CHUNK}\n`)
for (const r of rows) {
  const o = r.open.corners
  console.log(
    `${r.vp.name}  open canvas ${(o.openFrac * 100).toFixed(0)}% of the window  ` +
      `distance range ${o.minD}..${o.maxD}`,
  )
  console.log(
    `  opening   d=${o.d} pitch ${o.polar}  fabric corners at ` +
      `${o.worstX} across / ${o.worstY} down (1.0 = the edge)  fills ${r.open.fill.fabric}% fabric (${r.open.fill.built}% built)`,
  )
  const n = r.near.corners
  console.log(
    `  district  d=${n.d} pitch ${n.polar}  fills ${r.near.fill.fabric}% fabric (${r.near.fill.built}% built)`,
  )
  console.log(`  zoom-out reaches home from:`)
  for (const s of r.reach) {
    console.log(`      ${s.name.padEnd(22)} -> d=${s.d} of ${s.max}  (${s.short}m short)`)
  }
  console.log()
}

const checks = [
  {
    id: 'B1',
    claim: 'first load presents the ENTIRE fabric inside the open canvas, with margin',
    pass: rows.every((r) => r.open.corners.worstX < 0.95 && r.open.corners.worstY < 0.95),
    note: rows
      .map((r) => `${r.vp.name}: ${r.open.corners.worstX} across, ${r.open.corners.worstY} down`)
      .join(' · '),
  },
  {
    /**
     * SUPERSEDED BY §78, and restated rather than retuned.
     *
     * B2 asked for more than half the open canvas to be fabric, and that
     * number was calibrated against §76.2's oblique home framing, which fitted
     * the plate by foreshortening its depth away. §78 retires that framing on
     * purpose: the opening looks DOWN at the plate now, and an unforeshortened
     * square costs framing distance, so it reads smaller. That was stated as
     * the accepted trade, not discovered as a regression.
     *
     * A flat percentage cannot survive the change because a square plate seen
     * from overhead has a hard CEILING in a wide canvas: filling the height
     * fills only `1/openAspect` of the width, so the most it can ever occupy
     * is `1 / (openAspect * margin^2)` — 78.9% at 1280x800 and 46.8% at
     * 2560x1200. The old bar was unreachable at the wide end by geometry
     * alone.
     *
     * So the bar becomes a fraction of what is ACHIEVABLE, which is what it
     * was always really asking: is the plate as big as this frame allows, or
     * has the camera retreated past the point of the shot. Recorded before and
     * after: 60.9 / 66 / 61.5 under §76.2, against 75.5 / 64 / 49.5 now — and
     * the third of those is 106% of its own ceiling.
     */
    id: 'B2',
    claim: 'the plate is as large as an overhead framing allows, not retreated past it',
    pass: rows.every((r) => r.open.fill.fabric >= r.open.ceiling * 0.9),
    note: rows
      .map(
        (r) =>
          `${r.vp.name}: ${r.open.fill.fabric}% of a ${r.open.ceiling.toFixed(1)}% ceiling ` +
          `(${((r.open.fill.fabric / r.open.ceiling) * 100).toFixed(0)}%)`,
      )
      .join(' · '),
  },
  {
    /**
     * Also restated by §78, for a duller reason: it sampled d=2040 because
     * that was the home distance §76.2 replaced. With home now at 2711-2867
     * that number is a historical accident rather than a framing anyone
     * reaches. It samples PITCH_FULL_AT instead — the distance at which the
     * pitch curve reaches PITCH_MID, which is the district view the curve
     * actually defines rather than one a previous block happened to leave
     * behind.
     */
    id: 'B3',
    claim: 'the district framing fills the open canvas once you are in',
    pass: rows.every((r) => r.near.fill.fabric > 60),
    note: rows.map((r) => `${r.vp.name}: ${r.near.fill.fabric}% fabric at d=${r.near.corners.d}`).join(' · '),
  },
  {
    id: 'B4',
    claim: 'zoom-out from any state reaches the home framing, not short of it',
    pass: rows.every((r) => r.reach.every((s) => Math.abs(s.short) <= 2)),
    note: rows
      .map((r) => `${r.vp.name}: worst ${Math.max(...r.reach.map((s) => Math.abs(s.short)))}m short`)
      .join(' · '),
  },
  {
    id: 'B5',
    claim: "the pitch curve's far end lands exactly at the home distance",
    pass: rows.every(
      (r) => Math.abs(r.open.corners.pitchAtMax - r.open.corners.homePitch) < 0.005,
    ),
    note: rows
      .map((r) => `${r.vp.name}: pitch(max)=${r.open.corners.pitchAtMax} home=${r.open.corners.homePitch}`)
      .join(' · '),
  },
]
console.log('§76.2 pre-registered assertions')
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.claim}`)
  console.log(`        ${c.note}`)
}
const bad = checks.filter((c) => !c.pass)
console.log(
  `\n  ${checks.length - bad.length}/${checks.length} held` +
    (bad.length ? `  — ${bad.map((c) => c.id).join(', ')} to escalate` : ''),
)

const tiles = rows
  .map(
    (r) => `<section><h2>${r.vp.name}</h2><div class="p">
      <figure><img src="shots/${r.vp.name}-opening.png"><figcaption>opening · d=${r.open.corners.d} pitch ${r.open.corners.polar} · whole fabric, ${r.open.fill.fabric}% fabric</figcaption></figure>
      <figure><img src="shots/${r.vp.name}-district.png"><figcaption>once you are in · d=${r.near.corners.d} pitch ${r.near.corners.polar} · ${r.near.fill.fabric}% fabric</figcaption></figure>
    </div></section>`,
  )
  .join('')
await writeFile(
  `${OUT}/opening.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    h2{font-size:11px;color:#8a8069;font-weight:400;padding:10px 12px 2px;margin:0}
    .p{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 12px 6px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
   </style><h1>§76.2 the opening is an orienting shot — ${CHUNK}</h1>
   ${tiles}`,
)
const sheet = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1500, height: 1100 } })
await sheet.goto(`file://${process.cwd()}/${OUT}/opening.html`, { waitUntil: 'networkidle' })
await sheet.screenshot({ path: `${OUT}/opening.png`, fullPage: true })
await sheet.context().browser().close()
console.log(`\n  sheet: ${OUT}/opening.png`)
