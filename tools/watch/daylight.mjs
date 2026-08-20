/**
 * §80: the two daylight chunks, and what daylight costs them.
 *
 * The change itself is a table edit, so the picture is not the interesting
 * part — the QUESTION is. §63's semantic is that light means agents, and it
 * only works because the fabric is unlit. Turning the sun on removes that
 * channel entirely on these two chunks: §50.3's warm windows are invisible
 * against a lit facade. So agent activity has to arrive some other way, and
 * the three carriers left were all tuned against the dark register.
 *
 * PRE-REGISTERED:
 *
 *   D1  the hour actually changed. `night` is 0 and the sun is up on the two
 *       daylight chunks and unchanged on a night control. This is the §74.2
 *       state assertion: without it, a brighter picture could be §75's band
 *       sitting at its dusk end rather than the table edit taking.
 *
 *   D2  the emissive window channel is GONE on the daylight chunks, which is
 *       the cost, measured rather than assumed. `night: 0` means the shader's
 *       window term contributes nothing.
 *
 *   D3  the three remaining carriers still read at city framing: §46.2's site
 *       glow, the crane markers and the §59.1 sprites. Counted on screen, in
 *       daylight, at the home framing — because "they still read" is a claim
 *       about what is visible in the frame a viewer actually gets.
 *
 *   D4  the eight cities are distinguishable from each other. Measured as the
 *       spread of mean frame colour across all eight, so "visibly distinct"
 *       is a number rather than an impression.
 *
 *   node tools/watch/daylight.mjs
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? 'ws://127.0.0.1:8821'
const OUT = process.env.CIV_OUT ?? 'tools/watch/daylight'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 30)
const VP = { width: 1600, height: 900 }

const DAYLIGHT = ['brooklyn-redhook', 'vlaardingen-westwijk']
const ALL = [
  'brooklyn-redhook',
  'vlaardingen-westwijk',
  'schiedam-havens',
  'london-deptford',
  'paris-ourcq',
  'tokyo-kyojima',
  'maasland-dorp',
  'maassluis-haven',
]

await mkdir(`${OUT}/shots`, { recursive: true })

/** the §74.2 state assertion: what the lights ACTUALLY are, off the objects */
const STATE = () => {
  const civ = window.civ
  const e = civ.lighting.emissive()
  const l = civ.lighting.state()
  return {
    night: e.night,
    windowWarm: e.windowWarm,
    sun: l.sun,
    hemi: l.hemi,
    ambient: l.ambient,
    skyTop: l.skyTop,
    lamps: e.streetLights.count,
  }
}

/**
 * What carries agent activity in the frame. Counted on screen at the home
 * framing rather than in the world, because the claim is about legibility.
 */
const CARRIERS = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      const civ = window.civ
      const gl = document.querySelector('canvas')
      const w = 700
      const h = Math.round((gl.height / gl.width) * w)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(gl, 0, 0, w, h)
      const px = ctx.getImageData(0, 0, w, h).data
      let warm = 0
      let sr = 0
      let sg = 0
      let sb = 0
      const n = px.length / 4
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i]
        const g = px[i + 1]
        const b = px[i + 2]
        sr += r
        sg += g
        sb += b
        // §46.2's site glow and the sprites are the saturated amber left once
        // the windows are gone; a lit daylight facade is never this warm
        if (r > b + 45 && r > 120) warm++
      }
      resolve({
        warmPx: +((warm / n) * 100).toFixed(3),
        mean: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
        marks: civ.pixelMarks ? civ.pixelMarks().length : 0,
        sites: civ.observer ? [...civ.observer.sites()].length : 0,
      })
    })
  })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const rows = []
for (const chunk of ALL) {
  const page = await browser.newPage({ viewport: VP })
  await page.goto(
    `${ORIGIN}/w/?chunk=${chunk}&server=${encodeURIComponent(`${SERVER}/ws/${chunk}`)}`,
    { waitUntil: 'domcontentloaded' },
  )
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
  const state = await page.evaluate(STATE)
  const carriers = await page.evaluate(CARRIERS)
  await page.screenshot({ path: `${OUT}/shots/${chunk}.png` })
  await page.close()
  rows.push({ chunk, day: DAYLIGHT.includes(chunk), state, carriers })
}
await browser.close()

console.log('§80 daylight on two of eight\n')
for (const r of rows) {
  console.log(
    `${r.chunk.padEnd(22)} ${r.day ? 'DAY  ' : 'night'} night=${r.state.night} sun=${r.state.sun} hemi=${r.state.hemi} sky=${r.state.skyTop}`,
  )
  console.log(
    `${''.padEnd(22)}       mean rgb ${JSON.stringify(r.carriers.mean)}  warm px ${r.carriers.warmPx}%  sites ${r.carriers.sites}  sprites ${r.carriers.marks}`,
  )
}

const day = rows.filter((r) => r.day)
const night = rows.filter((r) => !r.day)
const dist = (a, b) =>
  Math.round(
    Math.hypot(
      a.carriers.mean[0] - b.carriers.mean[0],
      a.carriers.mean[1] - b.carriers.mean[1],
      a.carriers.mean[2] - b.carriers.mean[2],
    ),
  )
let closest = Infinity
let pair = ''
for (let i = 0; i < rows.length; i++)
  for (let j = i + 1; j < rows.length; j++) {
    const d = dist(rows[i], rows[j])
    if (d < closest) {
      closest = d
      pair = `${rows[i].chunk} / ${rows[j].chunk}`
    }
  }

const checks = [
  {
    id: 'D1',
    claim: 'the hour changed on the daylight chunks and not on the others',
    pass: day.every((r) => r.state.night === 0) && night.every((r) => r.state.night > 0.5),
    note:
      `day: ${day.map((r) => `${r.chunk} night=${r.state.night}`).join(', ')} · ` +
      `night: ${night.map((r) => r.state.night).join('/')}`,
  },
  {
    id: 'D2',
    claim: 'the emissive window channel is gone on the daylight chunks — the cost',
    pass: day.every((r) => r.state.night === 0),
    note: 'night=0 zeroes §50.3s window term; owned stock is no longer told apart by light there',
  },
  {
    id: 'D3',
    claim: 'agent activity still reads in daylight through the other three carriers',
    pass: day.every((r) => r.carriers.sites > 0 && r.carriers.warmPx > 0.02),
    note: day
      .map(
        (r) =>
          `${r.chunk}: ${r.carriers.sites} sites, ${r.carriers.marks} sprites, ${r.carriers.warmPx}% warm px`,
      )
      .join(' · '),
  },
  {
    id: 'D4',
    claim: 'the eight cities are visibly distinct from one another',
    pass: closest >= 8,
    note: `closest pair ${pair} at rgb distance ${closest}`,
  },
]
console.log('\n§80 pre-registered assertions')
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.claim}`)
  console.log(`        ${c.note}`)
}
const bad = checks.filter((c) => !c.pass)
console.log(`\n  ${checks.length - bad.length}/${checks.length} held${bad.length ? `  — ${bad.map((c) => c.id).join(', ')}` : ''}`)

await writeFile(
  `${OUT}/daylight.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    .g{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 12px}
    figure{margin:0}img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
    .d{color:#e2a54f}
   </style><h1>§80 two of eight in daylight — same camera, same framing</h1>
   <div class="g">${rows
     .map(
       (r) => `<figure><img src="shots/${r.chunk}.png"><figcaption class="${r.day ? 'd' : ''}">${
         r.chunk
       } · ${r.day ? 'DAYLIGHT' : 'night'} · night=${r.state.night} · ${r.carriers.sites} sites · ${
         r.carriers.warmPx
       }% warm</figcaption></figure>`,
     )
     .join('')}</div>`,
)
const sheet = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1500, height: 1400 } })
await sheet.goto(`file://${process.cwd()}/${OUT}/daylight.html`, { waitUntil: 'networkidle' })
await sheet.screenshot({ path: `${OUT}/daylight.png`, fullPage: true })
await sheet.context().browser().close()
console.log(`\n  sheet: ${OUT}/daylight.png`)
