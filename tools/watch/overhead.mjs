/**
 * §78 acceptance: the opening looks DOWN at the plate.
 *
 * "one first-load frame per chunk where the entire plate is visible with
 * margin on all four sides and the camera is clearly above the city rather
 * than beside it. verify on maasland and schiedam, which are rotated cuts, and
 * deptford, which is not."
 *
 * §76.2 derived the far pitch from "obliquity costs no framing distance until
 * the frame runs out of horizontal room". Sound argument, wrong question: what
 * it optimises is fitting the FORESHORTENED depth, and the cheapest way to fit
 * a depth is to foreshorten it away. At 2560x1200 it drove the home pitch to
 * 0.97 — a camera lying beside the plate looking across it — the solve passed,
 * and there was no distance at which a viewer could be above the city.
 *
 * PRE-REGISTERED, written before the first run:
 *
 *   D1  the camera is clearly ABOVE the city at the home framing: polar in
 *       0.25..0.35, at every chunk and every width. The number is the point of
 *       the block, so it is asserted directly rather than inferred from a
 *       coverage figure that a low camera can also satisfy.
 *
 *   D2  the entire plate is inside the open canvas with margin on ALL FOUR
 *       sides — each of the four corners checked separately, and the four
 *       edge clearances reported, because "runs off three edges" is a
 *       statement about sides and a worst-corner number can hide which.
 *
 *   D3  maxDistance IS the solve, and zoom-out reaches it from every state:
 *       street level, panned to a corner, rotated, mid-tween. No state from
 *       which the overhead view is unavailable.
 *
 *   D4  the curve is monotonic — pitch falls as distance rises, at every
 *       sample. §76.2's far end made it turn back on itself, which is the
 *       shape that hid the fault: the most oblique point in the whole range
 *       was the one furthest out.
 *
 *   D5  the close end keeps its obliquity. The street framing is still 0.86
 *       and PITCH_FULL_AT still 0.62, so what changed is the far end alone.
 *
 *   node tools/watch/overhead.mjs
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const OUT = process.env.CIV_OUT ?? 'tools/watch/overhead'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 30)

const CHUNKS = [
  { id: 'schiedam-havens', note: 'rotated cut' },
  { id: 'maasland-dorp', note: 'rotated cut' },
  { id: 'london-deptford', note: 'not rotated' },
]
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '2560x1200', width: 2560, height: 1200 },
]

await mkdir(`${OUT}/shots`, { recursive: true })

/** the four corners, and how much room each of the four SIDES has left */
const EDGES = () => {
  const civ = window.civ
  const cam = civ.rig.camera
  const V = civ.three.Vector3
  const h = civ.plate.halfExtent
  const gy = civ.plate.groundY
  const f = civ.canvasFrame()
  const openFrac = (f.open[1] - f.open[0]) / f.viewport[0]
  const c = (f.open[0] + f.open[1]) / f.viewport[0] - 1
  let minX = 9
  let maxX = -9
  let minY = 9
  let maxY = -9
  for (const [x, z] of [
    [-h, -h],
    [h, -h],
    [-h, h],
    [h, h],
  ]) {
    const p = new V(x, gy, z).project(cam)
    const nx = (p.x - c) / openFrac
    minX = Math.min(minX, nx)
    maxX = Math.max(maxX, nx)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  // clearance to each edge, in units of the half-extent: > 0 is inside
  return {
    left: +(1 + minX).toFixed(3),
    right: +(1 - maxX).toFixed(3),
    bottom: +(1 + minY).toFixed(3),
    top: +(1 - maxY).toFixed(3),
    d: Math.round(civ.rig.distance),
    max: Math.round(civ.rig.limits.maxDistance),
    polar: +civ.rig.polar.toFixed(4),
    halfExtent: Math.round(h),
  }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
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

const rows = []
for (const chunk of CHUNKS) {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
    const server = `ws://127.0.0.1:8820/ws/${chunk.id}`
    await page.goto(`${ORIGIN}/?chunk=${chunk.id}&server=${encodeURIComponent(server)}`, {
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
    const first = await page.evaluate(EDGES)
    await page.screenshot({ path: `${OUT}/shots/${chunk.id}-${vp.name}.png` })

    // the curve, sampled across the whole range
    const curve = await page.evaluate(() => {
      const rig = window.civ.rig
      const out = []
      for (let i = 0; i <= 10; i++) {
        const d = rig.limits.minDistance + ((rig.limits.maxDistance - rig.limits.minDistance) * i) / 10
        out.push({ d: Math.round(d), p: +rig.pitchFor(d).toFixed(4) })
      }
      return out
    })

    // reachability from four genuinely different states
    const reach = await page.evaluate(async () => {
      const rig = window.civ.rig
      const out = []
      const states = [
        ['street level', () => rig.flyTo(rig.target.clone(), rig.limits.minDistance, { duration: 0.01 })],
        ['panned to a corner', () => rig.pan(-4000, -4000)],
        ['rotated', () => rig.orbit(600, 0)],
        ['mid-tween', () => rig.flyTo(rig.target.clone(), 900, { duration: 3 })],
      ]
      for (const [name, set] of states) {
        set()
        await new Promise((r) => setTimeout(r, 250))
        for (let i = 0; i < 80; i++) rig.zoom(400)
        rig.settle()
        out.push({
          name,
          short: +(rig.limits.maxDistance - rig.distance).toFixed(2),
          polar: +rig.pitchFor(rig.distance).toFixed(4),
        })
      }
      return out
    })

    await page.close()
    rows.push({ chunk, vp, first, curve, reach })
  }
}
await browser.close()

console.log('§78 the opening looks down at the plate\n')
for (const r of rows) {
  const e = r.first
  console.log(
    `${r.chunk.id} (${r.chunk.note})  ${r.vp.name}  plate ${e.halfExtent * 2}m across`,
  )
  console.log(
    `  d=${e.d} of ${e.max}   polar ${e.polar}   margin  left ${e.left}  right ${e.right}  top ${e.top}  bottom ${e.bottom}`,
  )
  console.log(
    `  zoom-out: ${r.reach.map((s) => `${s.name} ${s.short}m short`).join(' · ')}`,
  )
}

const allEdges = (e) => [e.left, e.right, e.top, e.bottom]
const checks = [
  {
    id: 'D1',
    claim: 'the camera is clearly ABOVE the city at the home framing (polar 0.25..0.35)',
    pass: rows.every((r) => r.first.polar >= 0.25 && r.first.polar <= 0.35),
    note: rows.map((r) => `${r.chunk.id}/${r.vp.name}: ${r.first.polar}`).join(' · '),
  },
  {
    id: 'D2',
    claim: 'the entire plate is inside the open canvas with margin on ALL FOUR sides',
    pass: rows.every((r) => allEdges(r.first).every((v) => v > 0.02)),
    note: rows
      .map((r) => `${r.chunk.id}/${r.vp.name}: worst side ${Math.min(...allEdges(r.first)).toFixed(3)}`)
      .join(' · '),
  },
  {
    id: 'D3',
    claim: 'zoom-out reaches the home framing from every state',
    pass: rows.every((r) => r.reach.every((s) => Math.abs(s.short) < 1)),
    note: rows
      .map((r) => `${r.chunk.id}/${r.vp.name}: worst ${Math.max(...r.reach.map((s) => Math.abs(s.short))).toFixed(2)}m`)
      .join(' · '),
  },
  {
    id: 'D4',
    claim: 'the pitch curve is monotonic — further out is always more overhead',
    pass: rows.every((r) => r.curve.every((s, i) => i === 0 || s.p <= r.curve[i - 1].p + 1e-6)),
    note: `${rows[0].chunk.id}/${rows[0].vp.name}: ${rows[0].curve.map((s) => s.p).join(' → ')}`,
  },
  {
    id: 'D5',
    claim: 'the close end keeps its obliquity — only the far end moved',
    pass: rows.every((r) => r.curve[0].p > 0.8),
    note: rows.map((r) => `${r.chunk.id}/${r.vp.name}: street ${r.curve[0].p}`).join(' · '),
  },
]
console.log('\n§78 pre-registered assertions')
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.claim}`)
  console.log(`        ${c.note}`)
}
const bad = checks.filter((c) => !c.pass)
console.log(
  `\n  ${checks.length - bad.length}/${checks.length} held` +
    (bad.length ? `  — ${bad.map((c) => c.id).join(', ')} to escalate` : ''),
)

const tiles = CHUNKS.map((c) => {
  const mine = rows.filter((r) => r.chunk.id === c.id)
  return `<section><h2>${c.id} · ${c.note}</h2><div class="p">${mine
    .map(
      (r) =>
        `<figure><img src="shots/${r.chunk.id}-${r.vp.name}.png"><figcaption>${r.vp.name} · d=${r.first.d} · polar ${r.first.polar}</figcaption></figure>`,
    )
    .join('')}</div></section>`
}).join('')
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
   </style><h1>§78 the opening looks down at the plate — first load, three chunks</h1>
   ${tiles}`,
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
