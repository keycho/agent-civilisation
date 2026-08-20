/**
 * §76.1: where the city sits inside the part of the window a viewer can see.
 *
 * The report from production is "the plate pushed right with a black column
 * down the left third". A straight vertical edge is the signature of a centring
 * offset rather than a camera fault — a camera looking past the fabric makes a
 * wedge, because the ground plane recedes. So this measures COLUMNS: for each
 * screen column, is there city in it, and where do the empty ones fall relative
 * to the chrome.
 *
 * §35 makes the chrome DOM over the render surface, so the canvas is the whole
 * window and `#railRight` covers its rightmost 442px. The open canvas is what
 * is left. Every number here is reported against THAT, not against the
 * viewport, because the viewport is not what anyone is looking at.
 *
 * The two arms are the same world at the same camera — wire closed, clock
 * pinned, camera homed once before either arm, and the offset toggled in place
 * rather than reloaded (§74.2). The state assertion is `canvasFrame()`, which
 * says where the chrome actually is and how far the frame is being shifted, so
 * an arm that did not take is visible in the numbers.
 *
 *   node tools/watch/wide-frame.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
const OUT = process.env.CIV_OUT ?? 'tools/watch/wide'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 35)

/** the pane is a FIXED 442px, so its share of the window falls as the window grows */
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '2560x1200', width: 2560, height: 1200 },
]

await mkdir(`${OUT}/shots`, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

/**
 * Per-column coverage by ray march, which is what "is there city here" means
 * when the question is about a silhouette. Returns one entry per column band so
 * a black COLUMN is visible as a run of empty bands rather than averaged away
 * into a coverage percentage.
 */
const COLUMN_PROBE = () =>
  // eslint-disable-next-line
  new Promise((resolve) => {
    const civ = window.civ
    const rig = civ.rig
    const cam = rig.camera
    const gy = civ.plate.groundY
    const roof = civ.plate.roofAt
    const ceiling = civ.plate.tallest
    const V = civ.three.Vector3
    const s = new V()
    const COLS = 64
    const ROWS = 24
    const cols = []
    for (let ix = 0; ix < COLS; ix++) {
      let hits = 0
      for (let iy = 0; iy < ROWS; iy++) {
        s.set(-1 + (2 * (ix + 0.5)) / COLS, -1 + (2 * (iy + 0.5)) / ROWS, 0.5)
        s.unproject(cam)
        s.sub(cam.position).normalize()
        if (s.y > -1e-6) continue
        const step = Math.max(2, rig.distance * 0.012)
        for (let k = 1; k <= 300; k++) {
          const t = k * step
          const y = cam.position.y + s.y * t
          if (y < gy - 2) break
          if (y < roof(cam.position.x + s.x * t, cam.position.z + s.z * t)) {
            hits++
            break
          }
        }
      }
      cols.push(hits / ROWS)
    }
    resolve(cols)
  })

/**
 * §76.1's RESTATED void bar.
 *
 * §75's use test asked that no frame show "the plate edge with void beyond it".
 * At a wide aspect that bar fails a frame that is correct: a square city in a
 * 21:10 window has horizontal room left over whatever the camera does, and §74
 * made past-the-fabric dark and FADED rather than a visible grey plane, so what
 * is left reads as a lit city sitting in night rather than as a world that
 * stopped. Judged by eye first, then restated — in that order, because the
 * whole point of §69.3 is that the frame is the acceptance.
 *
 * So the bar stops counting VOID and starts measuring EDGE. A hard boundary
 * where the fabric ends is still a failure, always. Darkness around a lit city
 * is composition.
 *
 * Measured without a fourth invented threshold, by making the frame calibrate
 * itself: the steepest one-pixel luminance step inside the city (building
 * silhouettes, which are legitimately hard edges and are the sharpest thing the
 * renderer draws) against the steepest step out in the margin. §73.2 ramps the
 * ground to black over 110 m, which at the home framing is ~250 px, so a
 * correct margin cannot contain a step anywhere near a roofline's. If it ever
 * does, that is a real plate edge and the bar catches it.
 */
const EDGE_PROBE = (band) =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      const gl = document.querySelector('canvas')
      const open = window.civ.canvasFrame().open
      const w = gl.width
      const h = gl.height
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(gl, 0, 0)
      const scale = w / innerWidth
      const x0 = Math.round(open[0] * scale)
      const x1 = Math.round(open[1] * scale)
      /**
       * The margin band is MEASURED, not a fixed fraction of the frame. The
       * first cut took the outer sixth and reported margin == city at 1280,
       * where centring leaves no margin at all: the band was sampling
       * ROOFLINES and calling them a plate edge. Same fault as the three §75
       * restated — a fixed geometric assumption over a frame whose geometry is
       * the variable. `band` comes from the column probe, so it is the empty
       * run that actually exists; where there is none, there is no edge to
       * find and the check says so instead of measuring the city.
       */
      const mLo = Math.round(band.lo * scale)
      const mHi = Math.round(band.hi * scale)
      // three scanlines across the middle of the frame, so one unlucky row of
      // sky or water does not decide it
      let cityStep = 0
      let marginStep = 0
      for (const fy of [0.35, 0.5, 0.65]) {
        const y = Math.round(h * fy)
        const row = ctx.getImageData(x0, y, Math.max(1, x1 - x0), 1).data
        const n = row.length / 4
        const lum = new Array(n)
        for (let i = 0; i < n; i++) {
          lum[i] = 0.2126 * row[i * 4] + 0.7152 * row[i * 4 + 1] + 0.0722 * row[i * 4 + 2]
        }
        // outer sixth on each side is "margin"; the middle half is "city"
        for (let i = 1; i < n; i++) {
          const px = x0 + i
          const d = Math.abs(lum[i] - lum[i - 1])
          if (px >= mLo && px <= mHi) marginStep = Math.max(marginStep, d)
          else if (i > n * 0.25 && i < n * 0.75) cityStep = Math.max(cityStep, d)
        }
      }
      resolve({
        cityStep: Math.round(cityStep),
        marginStep: Math.round(marginStep),
        marginPx: Math.round((mHi - mLo) / scale),
      })
    })
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

  // freeze, then home once, so both arms are the same world at the same camera
  await page.evaluate(async () => {
    const civ = window.civ
    civ.director.takeControl()
    civ.director.enabled = false
    civ.plate.home(true)
    await new Promise((r) => setTimeout(r, 1600))
    civ.connection.close()
    civ.freezeClock(20)
  })

  const arms = {}
  for (const on of [false, true]) {
    await page.evaluate((v) => window.civ.centreOnOpenCanvas(v), on)
    await page.evaluate(
      () =>
        new Promise((r) => {
          let n = 0
          const tick = () => (++n >= 3 ? r() : requestAnimationFrame(tick))
          requestAnimationFrame(tick)
        }),
    )
    const frame = await page.evaluate(() => window.civ.canvasFrame())
    const cols = await page.evaluate(COLUMN_PROBE)
    const d = await page.evaluate(() => Math.round(window.civ.rig.distance))
    const g = widestGap(cols, frame.open[0], frame.open[1], vp.width)
    const edge = await page.evaluate(EDGE_PROBE, { lo: g.lo, hi: g.hi })
    const file = `shots/${vp.name}-${on ? 'centred' : 'viewport'}.png`
    await page.screenshot({ path: `${OUT}/${file}` })
    arms[on ? 'after' : 'before'] = { frame, cols, d, edge, file }
  }
  await page.close()
  rows.push({ vp, ...arms })
}
await browser.close()

const bar = (cols, openL, openR, w) => {
  const n = cols.length
  return cols
    .map((c, i) => {
      const px = ((i + 0.5) / n) * w
      const under = px < openL || px > openR
      if (under) return c > 0.02 ? '░' : ' ' // hidden behind chrome
      return c > 0.35 ? '█' : c > 0.02 ? '▒' : '.'
    })
    .join('')
}

/** the widest run of empty columns inside the open canvas, in px */
function widestGap(cols, openL, openR, w) {
  const n = cols.length
  let best = 0
  let side = ''
  let bestStart = 0
  let run = 0
  let runStart = 0
  for (let i = 0; i <= n; i++) {
    const px = ((i + 0.5) / n) * w
    const inside = i < n && px >= openL && px <= openR
    const empty = inside && cols[i] <= 0.02
    if (empty) {
      if (run === 0) runStart = i
      run++
    } else {
      if (run > best) {
        best = run
        bestStart = runStart
        side = runStart < n / 2 ? 'left' : 'right'
      }
      run = 0
    }
  }
  return {
    px: Math.round((best / n) * w),
    side,
    lo: (bestStart / n) * w,
    hi: ((bestStart + best) / n) * w,
  }
}

console.log(`§76.1 wide framing — ${CHUNK}\n`)
const checks = []
for (const r of rows) {
  const w = r.vp.width
  const [oL, oR] = r.before.frame.open
  const openW = oR - oL
  console.log(
    `${r.vp.name}  open canvas ${oL}..${Math.round(oR)} of ${w} ` +
      `(${((openW / w) * 100).toFixed(0)}% visible, chrome takes ${w - Math.round(openW)}px)  d=${r.before.d}`,
  )
  const gB = widestGap(r.before.cols, oL, oR, w)
  const gA = widestGap(r.after.cols, oL, oR, w)
  console.log(`  before  shift ${r.before.frame.shift}px   ${bar(r.before.cols, oL, oR, w)}`)
  console.log(`          widest empty run inside the open canvas: ${gB.px}px on the ${gB.side}`)
  console.log(`  after   shift ${Math.round(r.after.frame.shift)}px   ${bar(r.after.cols, oL, oR, w)}`)
  console.log(`          widest empty run inside the open canvas: ${gA.px}px on the ${gA.side}\n`)
  console.log(
    `          steepest one-pixel step: city ${r.after.edge.cityStep}, margin ` +
      `${r.after.edge.marginStep} — the margin is ` +
      `${(r.after.edge.marginStep / Math.max(1, r.after.edge.cityStep)).toFixed(2)}x the city's\n`,
  )
  checks.push({
    vp: r.vp.name,
    before: gB,
    after: gA,
    shift: Math.round(r.after.frame.shift),
    edge: r.after.edge,
  })
}
console.log('  █ city   ▒ sparse   . empty   ░ behind the chrome\n')

console.log('§76.1 assertions')
const a1 = checks.every((c) => c.after.px < c.before.px)
const a2 = checks.every((c) => c.shift > 0)
console.log(
  `  ${a1 ? 'PASS' : 'FAIL'}  the widest void run inside the open canvas shrinks at every width\n` +
    checks
      .map((c) => `        ${c.vp}: ${c.before.px}px ${c.before.side} -> ${c.after.px}px ${c.after.side}`)
      .join('\n'),
)
console.log(
  `  ${a2 ? 'PASS' : 'FAIL'}  the shift is applied and positive (frame moves left, into the pane's room)\n` +
    `        ${checks.map((c) => `${c.vp}: ${c.shift}px`).join(' · ')}`,
)
/**
 * Only widths that HAVE a margin can be asked whether their margin ends at an
 * edge. At 1280 centring leaves none, which is not a pass and not a failure —
 * there is nothing to measure, and saying so is the difference between a check
 * and a number that happens to be green.
 */
const judged = checks.filter((c) => c.edge.marginPx > 40)
const a3 = judged.length > 0 && judged.every((c) => c.edge.marginStep < c.edge.cityStep * 0.25)
console.log(
  `  ${a3 ? 'PASS' : 'FAIL'}  §76.1 restated: where a margin remains, it FADES rather than ending at an edge\n` +
    `        the frame calibrates itself — a roofline is the sharpest step the renderer draws,\n` +
    `        so a margin carrying a real plate edge would step like one\n` +
    checks
      .map((c) =>
        c.edge.marginPx > 40
          ? `        ${c.vp}: margin ${c.edge.marginPx}px · steepest step: city ${c.edge.cityStep}, ` +
            `margin ${c.edge.marginStep} (${(c.edge.marginStep / Math.max(1, c.edge.cityStep)).toFixed(2)}x)`
          : `        ${c.vp}: no margin left to judge — the city fills the open canvas`,
      )
      .join('\n'),
)

const tiles = rows
  .map(
    (r) => `<section><h2>${r.vp.name} · d=${r.before.d}</h2><div class="p">
      <figure><img src="${r.before.file}"><figcaption>before · centred on the viewport</figcaption></figure>
      <figure><img src="${r.after.file}"><figcaption>after · centred on the open canvas (shift ${Math.round(r.after.frame.shift)}px)</figcaption></figure>
    </div></section>`,
  )
  .join('')
await writeFile(
  `${OUT}/wide-frame.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    h2{font-size:11px;color:#8a8069;font-weight:400;padding:10px 12px 2px;margin:0}
    .p{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 12px 6px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
   </style><h1>§76.1 the city centred on the open canvas — ${CHUNK}, same world, same camera</h1>
   ${tiles}`,
)
const sheet = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1500, height: 1000 } })
await sheet.goto(`file://${process.cwd()}/${OUT}/wide-frame.html`, { waitUntil: 'networkidle' })
await sheet.screenshot({ path: `${OUT}/wide-frame.png`, fullPage: true })
await sheet.context().browser().close()
console.log(`\n  sheet: ${OUT}/wide-frame.png`)
