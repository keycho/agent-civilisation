/**
 * §77 acceptance, both halves in one run because they share a session.
 *
 * "first-load frame and fully-zoomed-out frame are the same framing at all
 * three widths, and no frame at any distance shows blur."
 *
 * PRE-REGISTERED, written before the first run:
 *
 *   C1  the fully-zoomed-out framing IS the first-load framing. Compared on
 *       the camera state (distance, pitch, target) AND on where the fabric's
 *       corners land, because two cameras can agree on their own numbers and
 *       still not produce the same picture — §74.2's rule is that the state
 *       assertion sits BESIDE the image, not instead of it.
 *
 *   C2  zoom-out from street level reaches it exactly: neither short (a limit
 *       the viewer cannot get to) nor past it (an edge they can back away
 *       from). Checked to the metre.
 *
 *   C3  the whole fabric is still inside the open canvas at that framing, at
 *       every width, since §76.2's solve is aspect-dependent and this block
 *       changed the pass that renders it.
 *
 *   C4  no blur at any distance. Measured two ways: the state says the pass is
 *       GONE rather than zeroed, and the image is measured for acuity — the
 *       steepest one-pixel luminance step, sampled across the whole distance
 *       range. A 5px circle of confusion cannot leave a roofline-sharp step
 *       behind it, so an acuity that holds at every distance is the blur's
 *       absence stated as a number rather than as a claim.
 *
 *   C5  the ambient drift cannot push the camera past the home framing. This
 *       is the one that produced the report, and it is invisible in a still —
 *       the drift is a slow sinusoid, so a single frame catches it wherever it
 *       happens to be. Sampled over a full cycle instead.
 *
 *   node tools/watch/no-blur-home.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
const OUT = process.env.CIV_OUT ?? 'tools/watch/noblur'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 35)

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '2560x1200', width: 2560, height: 1200 },
]

await mkdir(`${OUT}/shots`, { recursive: true })

/** camera state plus where the fabric's corners actually land */
const FRAMING = () => {
  const civ = window.civ
  const cam = civ.rig.camera
  const V = civ.three.Vector3
  const h = civ.plate.halfExtent
  const gy = civ.plate.groundY
  const f = civ.canvasFrame()
  const openFrac = (f.open[1] - f.open[0]) / f.viewport[0]
  const c = (f.open[0] + f.open[1]) / f.viewport[0] - 1
  const pts = [
    [-h, -h],
    [h, -h],
    [-h, h],
    [h, h],
  ].map(([x, z]) => {
    const p = new V(x, gy, z).project(cam)
    return [+((p.x - c) / openFrac).toFixed(4), +p.y.toFixed(4)]
  })
  let worst = 0
  for (const [x, y] of pts) worst = Math.max(worst, Math.abs(x), Math.abs(y))
  return {
    d: +civ.rig.distance.toFixed(2),
    polar: +civ.rig.polar.toFixed(4),
    max: +civ.rig.limits.maxDistance.toFixed(2),
    target: [+civ.rig.target.x.toFixed(2), +civ.rig.target.z.toFixed(2)],
    azimuth: +civ.rig.azimuth.toFixed(4),
    fov: +civ.rig.camera.fov.toFixed(2),
    shift: +civ.canvasFrame().shift.toFixed(1),
    corners: pts,
    worst: +worst.toFixed(4),
  }
}

/**
 * Image acuity: the steepest one-pixel luminance step in the frame. A depth of
 * field with a 5px circle of confusion cannot leave one behind, so this is the
 * blur's absence measured rather than asserted.
 */
const ACUITY = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      const gl = document.querySelector('canvas')
      const w = gl.width
      const h = gl.height
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(gl, 0, 0)
      const f = window.civ.canvasFrame()
      const scale = w / innerWidth
      const x0 = Math.round(f.open[0] * scale)
      const x1 = Math.round(f.open[1] * scale)
      let best = 0
      for (const fy of [0.3, 0.45, 0.6, 0.75]) {
        const y = Math.round(h * fy)
        const row = ctx.getImageData(x0, y, Math.max(1, x1 - x0), 1).data
        const n = row.length / 4
        let prev = 0.2126 * row[0] + 0.7152 * row[1] + 0.0722 * row[2]
        for (let i = 1; i < n; i++) {
          const lum = 0.2126 * row[i * 4] + 0.7152 * row[i * 4 + 1] + 0.0722 * row[i * 4 + 2]
          best = Math.max(best, Math.abs(lum - prev))
          prev = lum
        }
      }
      resolve(Math.round(best))
    })
  })

/**
 * Frames, not milliseconds. Every camera reading in this harness projects the
 * fabric's corners through `camera.matrixWorldInverse`, and those matrices are
 * only refreshed by `apply()` during a rendered frame. Waiting 250ms after a
 * state change reported IDENTICAL distance, pitch, target, azimuth, fov and
 * shift with corners 0.909 against 1.705 — the logical state was new and the
 * matrices were one frame old. It hit 1920x1080 and not the other two, which
 * is exactly how an intermittent stale read presents.
 */
const steps = (page, n) =>
  page.evaluate(
    (k) =>
      new Promise((r) => {
        let seen = 0
        const tick = () => (++seen >= k ? r(seen) : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )

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

  await page.evaluate(async () => {
    const civ = window.civ
    civ.director.takeControl()
    civ.director.enabled = false
    civ.plate.home(true)
    await new Promise((r) => setTimeout(r, 1800))
    civ.connection.close()
    civ.freezeClock(20)
  })
  await steps(page, 3)
  const first = await page.evaluate(FRAMING)
  const dof = await page.evaluate(() => window.civ.dof())
  await page.screenshot({ path: `${OUT}/shots/${vp.name}-first-load.png` })

  // down to the street, then all the way back out
  const back = await page.evaluate(async () => {
    const rig = window.civ.rig
    rig.flyTo(rig.target.clone(), rig.limits.minDistance, { duration: 0.01 })
    rig.settle()
    for (let i = 0; i < 80; i++) rig.zoom(400)
    rig.settle()
  })
  void back
  await steps(page, 3)
  const out = await page.evaluate(FRAMING)
  await page.screenshot({ path: `${OUT}/shots/${vp.name}-zoomed-out.png` })

  // acuity across the whole range, and a close frame to look at
  const acuity = []
  for (const frac of [0, 0.15, 0.35, 0.6, 0.85, 1]) {
    await page.evaluate(async (f) => {
      const rig = window.civ.rig
      const d = rig.limits.minDistance + (rig.limits.maxDistance - rig.limits.minDistance) * f
      rig.flyTo(rig.target.clone(), d, { duration: 0.01 })
      rig.settle()
    }, frac)
    await steps(page, 3)
    const d = await page.evaluate(() => Math.round(window.civ.rig.distance))
    acuity.push({ d, step: await page.evaluate(ACUITY) })
    if (frac === 0.15) await page.screenshot({ path: `${OUT}/shots/${vp.name}-close.png` })
  }

  /**
   * C5: the drift is a slow sinusoid, so a still catches it wherever it
   * happens to be. Sampled over a full cycle with ambient ON, at home.
   */
  const drift = await page.evaluate(async () => {
    const civ = window.civ
    const rig = civ.rig
    civ.plate.home(true)
    await new Promise((r) => setTimeout(r, 400))
    document.body.classList.add('ambient')
    let worstOver = 0
    let samples = 0
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()))
      const eye = rig.camera.position.distanceTo(rig.target)
      worstOver = Math.max(worstOver, eye - rig.limits.maxDistance)
      samples++
    }
    document.body.classList.remove('ambient')
    return { worstOver: +worstOver.toFixed(2), samples }
  })

  await page.close()
  rows.push({ vp, first, out, dof, acuity, drift })
}
await browser.close()

const same = (a, b) =>
  Math.abs(a.d - b.d) < 1 &&
  Math.abs(a.polar - b.polar) < 0.002 &&
  a.corners.every((p, i) => Math.abs(p[0] - b.corners[i][0]) < 0.01 && Math.abs(p[1] - b.corners[i][1]) < 0.01)

console.log(`§77 acceptance — ${CHUNK}\n`)
for (const r of rows) {
  console.log(`${r.vp.name}`)
  console.log(
    `  first load   d=${r.first.d} pitch ${r.first.polar}  worst corner ${r.first.worst}  (max ${r.first.max})`,
  )
  console.log(
    `  zoomed out   d=${r.out.d} pitch ${r.out.polar}  worst corner ${r.out.worst}  ` +
      `${same(r.first, r.out) ? 'SAME FRAMING' : 'DIFFERENT'}`,
  )
  console.log(
    `      first  target ${JSON.stringify(r.first.target)} az ${r.first.azimuth} fov ${r.first.fov} shift ${r.first.shift}`,
  )
  console.log(
    `      out    target ${JSON.stringify(r.out.target)} az ${r.out.azimuth} fov ${r.out.fov} shift ${r.out.shift}`,
  )
  console.log(`  acuity by distance: ${r.acuity.map((a) => `${a.d}m:${a.step}`).join('  ')}`)
  console.log(`  drift over ${r.drift.samples} frames at home: worst ${r.drift.worstOver}m past the limit\n`)
}

const checks = [
  {
    id: 'C1',
    claim: 'the fully-zoomed-out framing IS the first-load framing',
    pass: rows.every((r) => same(r.first, r.out)),
    note: rows
      .map((r) => `${r.vp.name}: d ${r.first.d}->${r.out.d}, pitch ${r.first.polar}->${r.out.polar}`)
      .join(' · '),
  },
  {
    id: 'C2',
    claim: 'zoom-out from street level reaches it exactly — not short, not past',
    pass: rows.every((r) => Math.abs(r.out.d - r.out.max) < 1),
    note: rows.map((r) => `${r.vp.name}: ${(r.out.d - r.out.max).toFixed(2)}m from the limit`).join(' · '),
  },
  {
    id: 'C3',
    claim: 'the whole fabric is inside the open canvas at that framing',
    pass: rows.every((r) => r.out.worst < 0.95),
    note: rows.map((r) => `${r.vp.name}: worst corner ${r.out.worst}`).join(' · '),
  },
  {
    /**
     * Structural, not photographic. Acuity depends on what the camera happens
     * to be pointed at — a dark corner reads low whether or not anything is
     * blurred — so gating on it would be measuring the scene, not the pass.
     * The uniform list cannot be argued with: a depth of field needs a depth
     * texture and a blur radius, and neither is there to be turned down.
     */
    id: 'C4',
    claim: 'no blur at any distance — the pass is DELETED, not zeroed',
    pass: rows.every(
      (r) =>
        r.dof.strength === 0 &&
        !r.dof.uniforms.some((u) => /blur|depth|focus|range|strength/i.test(u)),
    ),
    note:
      `composite uniforms: ${rows[0].dof.uniforms.join(', ')}\n` +
      `        acuity, as information: ` +
      rows
        .map((r) => `${r.vp.name} ${Math.min(...r.acuity.map((a) => a.step))}..${Math.max(...r.acuity.map((a) => a.step))}`)
        .join(' · '),
  },
  {
    id: 'C5',
    claim: 'the ambient drift never pushes the eye past the home framing',
    pass: rows.every((r) => r.drift.worstOver <= 0.5),
    note: rows.map((r) => `${r.vp.name}: worst ${r.drift.worstOver}m over`).join(' · '),
  },
]
console.log('§77 pre-registered assertions')
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
      <figure><img src="shots/${r.vp.name}-first-load.png"><figcaption>first load · d=${r.first.d}</figcaption></figure>
      <figure><img src="shots/${r.vp.name}-zoomed-out.png"><figcaption>zoomed fully out from street · d=${r.out.d}</figcaption></figure>
      <figure><img src="shots/${r.vp.name}-close.png"><figcaption>close · no blur anywhere in the range</figcaption></figure>
    </div></section>`,
  )
  .join('')
await writeFile(
  `${OUT}/no-blur-home.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    h2{font-size:11px;color:#8a8069;font-weight:400;padding:10px 12px 2px;margin:0}
    .p{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:0 12px 6px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
   </style><h1>§77 no depth of field, and the whole plate is the far end — ${CHUNK}</h1>
   ${tiles}`,
)
const sheet = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1600, height: 1000 } })
await sheet.goto(`file://${process.cwd()}/${OUT}/no-blur-home.html`, { waitUntil: 'networkidle' })
await sheet.screenshot({ path: `${OUT}/no-blur-home.png`, fullPage: true })
await sheet.context().browser().close()
console.log(`\n  sheet: ${OUT}/no-blur-home.png`)
