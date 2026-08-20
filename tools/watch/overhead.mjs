/**
 * §78 acceptance: the opening looks DOWN at the plate, on three chunks.
 *
 * §78 retired §76.2's derived far pitch. That derivation took "obliquity is
 * free until the frame runs out of horizontal room" and drove the home pitch
 * to 0.97 on a wide window — a camera lying beside the plate looking across
 * it. It fit the foreshortened depth, so the solve passed, and the overhead
 * view was unreachable by construction because the curve's far end was its
 * most oblique point.
 *
 * Verified per CHUNK rather than per window width, because that is the axis
 * §78 named: maasland-dorp and schiedam-havens are rotated cuts, and
 * london-deptford is not, so the plate's relationship to its city differs.
 * (The width axis was checked at 1280/1920/2560 when the solve landed.)
 *
 * PRE-REGISTERED:
 *
 *   C1  every SIDE has margin. Reported as four numbers rather than as a worst
 *       corner, because "runs off three edges" is the reported symptom and a
 *       single worst-case cannot say which edge, or that three of them are
 *       tight while one is generous.
 *
 *   C2  the camera is clearly ABOVE the city, not beside it. polar <= 0.35,
 *       which is §78's stated band.
 *
 *   C3  first load and fully-zoomed-out are the SAME framing. This is the
 *       §77.2 invariant restated per chunk: if they differ, there is a state
 *       from which the orienting shot is unavailable.
 *
 *   C4  zoom-out from street level reaches maxDistance exactly — neither short
 *       of it nor past it.
 *
 * The verdict is the frames. These numbers exist so a failure can be located,
 * not so a pass can be declared without looking.
 *
 *   node tools/watch/overhead.mjs
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNKS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['maasland-dorp', 'schiedam-havens', 'london-deptford']
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const OUT = process.env.CIV_OUT ?? 'tools/watch/overhead'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 30)
const VP = { width: 1920, height: 1080 }

await mkdir(`${OUT}/shots`, { recursive: true })

/** the plate's projected box in OPEN-CANVAS units, per side */
const FRAME = () => {
  const civ = window.civ
  const cam = civ.rig.camera
  const V = civ.three.Vector3
  const h = civ.plate.halfExtent
  const gy = civ.plate.groundY
  const f = civ.canvasFrame()
  const openFrac = (f.open[1] - f.open[0]) / f.viewport[0]
  // §76.1 shifts the frame, so the open canvas is not centred on NDC zero
  const c = (f.open[0] + f.open[1]) / f.viewport[0] - 1
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, z] of [
    [-h, -h],
    [h, -h],
    [-h, h],
    [h, h],
  ]) {
    const p = new V(x, gy, z).project(cam)
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  // margin as a share of the open canvas half-extent; negative means cropped
  return {
    left: +((minX - (c - openFrac)) / openFrac).toFixed(3),
    right: +(((c + openFrac) - maxX) / openFrac).toFixed(3),
    bottom: +((minY - -1) / 1).toFixed(3),
    top: +((1 - maxY) / 1).toFixed(3),
    d: Math.round(civ.rig.distance),
    polar: +civ.rig.polar.toFixed(3),
    maxD: Math.round(civ.rig.limits.maxDistance),
    halfExtent: Math.round(h),
    target: [+civ.rig.target.x.toFixed(1), +civ.rig.target.z.toFixed(1)],
  }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const rows = []
for (const chunk of CHUNKS) {
  const server = `ws://127.0.0.1:8820/ws/${chunk}`
  const page = await browser.newPage({ viewport: VP })
  await page.goto(`${ORIGIN}/w/?chunk=${chunk}&server=${encodeURIComponent(server)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.evaluate(() => document.getElementById('watchBtn')?.click())
  await page.waitForTimeout(BUILD_S * 1000)

  // FIRST LOAD, as a viewer gets it
  await page.evaluate(async () => {
    const civ = window.civ
    civ.director.takeControl()
    civ.director.enabled = false
    civ.plate.home(true)
    await new Promise((r) => setTimeout(r, 1800))
    civ.connection.close()
    civ.freezeClock(20)
  })
  const first = await page.evaluate(FRAME)
  await page.screenshot({ path: `${OUT}/shots/${chunk}-first-load.png` })

  // drop to street, then scroll all the way back out
  const out = await page.evaluate(async () => {
    const rig = window.civ.rig
    rig.flyTo(rig.target.clone(), rig.limits.minDistance, { duration: 0.01 })
    rig.settle()
    await new Promise((r) => setTimeout(r, 300))
    const street = { d: Math.round(rig.distance), polar: +rig.polar.toFixed(3) }
    for (let i = 0; i < 80; i++) rig.zoom(400)
    rig.settle()
    await new Promise((r) => setTimeout(r, 300))
    return street
  })
  const back = await page.evaluate(FRAME)
  await page.screenshot({ path: `${OUT}/shots/${chunk}-zoomed-out.png` })

  await page.close()
  rows.push({ chunk, first, back, street: out })
}
await browser.close()

console.log(`§78 the opening looks down at the plate — ${VP.width}x${VP.height}\n`)
for (const r of rows) {
  const f = r.first
  console.log(
    `${r.chunk.padEnd(18)} plate ${f.halfExtent * 2}m across  d=${f.d} of ${f.maxD}  polar ${f.polar}`,
  )
  console.log(
    `  margin  left ${f.left}  right ${f.right}  top ${f.top}  bottom ${f.bottom}   (share of the open canvas half)`,
  )
  console.log(
    `  street d=${r.street.d} polar ${r.street.polar} -> zoomed out d=${r.back.d} polar ${r.back.polar}\n`,
  )
}

const checks = [
  {
    id: 'C1',
    claim: 'every side of the plate has margin inside the open canvas',
    pass: rows.every(
      (r) => r.first.left > 0 && r.first.right > 0 && r.first.top > 0 && r.first.bottom > 0,
    ),
    note: rows
      .map(
        (r) =>
          `${r.chunk}: L${r.first.left} R${r.first.right} T${r.first.top} B${r.first.bottom}`,
      )
      .join(' · '),
  },
  {
    id: 'C2',
    claim: 'the camera is above the city, not beside it',
    pass: rows.every((r) => r.first.polar <= 0.35),
    note: rows.map((r) => `${r.chunk}: polar ${r.first.polar}`).join(' · '),
  },
  {
    id: 'C3',
    claim: 'first load and fully-zoomed-out are the same framing',
    pass: rows.every(
      (r) => Math.abs(r.first.d - r.back.d) <= 1 && Math.abs(r.first.polar - r.back.polar) < 0.005,
    ),
    note: rows
      .map((r) => `${r.chunk}: d ${r.first.d}/${r.back.d}, polar ${r.first.polar}/${r.back.polar}`)
      .join(' · '),
  },
  {
    id: 'C4',
    claim: 'zoom-out from street level lands exactly on maxDistance',
    pass: rows.every((r) => Math.abs(r.back.d - r.back.maxD) <= 1),
    note: rows.map((r) => `${r.chunk}: ${r.back.d} of ${r.back.maxD}`).join(' · '),
  },
]
console.log('§78 pre-registered assertions')
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.claim}`)
  console.log(`        ${c.note}`)
}
const bad = checks.filter((c) => !c.pass)
console.log(
  `\n  ${checks.length - bad.length}/${checks.length} held` +
    (bad.length ? `  — ${bad.map((c) => c.id).join(', ')} to escalate` : '') +
    `\n  the verdict is the frames; these locate a failure, they do not declare a pass.`,
)

await writeFile(
  `${OUT}/overhead.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    h2{font-size:11px;color:#8a8069;font-weight:400;padding:10px 12px 2px;margin:0}
    .p{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 12px 6px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
   </style><h1>§78 the opening looks down at the plate — first load beside fully zoomed out</h1>
   ${rows
     .map(
       (r) => `<section><h2>${r.chunk} · plate ${r.first.halfExtent * 2}m · d=${r.first.d} · polar ${r.first.polar}</h2><div class="p">
       <figure><img src="shots/${r.chunk}-first-load.png"><figcaption>first load</figcaption></figure>
       <figure><img src="shots/${r.chunk}-zoomed-out.png"><figcaption>zoomed out from street level</figcaption></figure>
     </div></section>`,
     )
     .join('')}`,
)
const sheet = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1500, height: 1200 } })
await sheet.goto(`file://${process.cwd()}/${OUT}/overhead.html`, { waitUntil: 'networkidle' })
await sheet.screenshot({ path: `${OUT}/overhead.png`, fullPage: true })
await sheet.context().browser().close()
console.log(`\n  sheet: ${OUT}/overhead.png`)
