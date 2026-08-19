/**
 * §66.3: the contact sheet that is actually the product's responsibility.
 *
 * The §62.2 fuzz sheet samples frames from RANDOM free-camera states, and after
 * three metrics its unpostable frames all turned out to be the same thing: the
 * camera parked close to the ground in an unlit corner of the plate. No measure
 * of the fabric separates those from a good street framing, because
 * geometrically they are identical — what differs is whether there is any light
 * where the camera is standing, and that is a property of the place, not of how
 * the camera is bounded. A viewer who pans into a dark dock and stops there has
 * taken the camera; that frame is theirs.
 *
 * The frames the PRODUCT presents are the opening, the home framing, and every
 * shot the director composes. Those are the ones where "would you post this"
 * is a fair question, and this is the sheet of them: one frame from each of the
 * first N shots the director chooses, captured after it has settled, labelled
 * with the intent that caused it.
 *
 *   node tools/watch/director-sheet.mjs [shots=10] [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const SHOTS = Number(process.argv[2] ?? 10)
const CHUNK = process.argv[3] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/66'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

await mkdir(`${OUT}/shots`, { recursive: true })

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
// ambient is the mode these shots exist for
await page.evaluate(() => document.getElementById('watchBtn')?.click())

const sheet = []

// the opening is the product's first frame and belongs on this sheet
await page.evaluate(() => window.civ.rig.settle())
await page.screenshot({ path: `${OUT}/shots/00-opening.png` })
sheet.push({ file: 'shots/00-opening.png', label: 'the opening — whole plate, held' })

/**
 * Then one frame per director shot. The director stamps every move it issues
 * (§66.1's `lastMove`), so waiting on that stamp changing is waiting on the
 * decision itself rather than on a fixed number of seconds — which matters
 * because shot pacing runs on the render loop's clamped dt and this sandbox's
 * software renderer makes that much slower than wall clock.
 */
let seen = null
for (let i = 1; i <= SHOTS; i++) {
  const move = await page.evaluate(async (prev) => {
    const t0 = performance.now()
    while (performance.now() - t0 < 180000) {
      const m = window.civ.director.lastMove
      if (m && m.at !== prev) return m
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  }, seen)
  if (!move) {
    console.log(`  the director issued no further shot after ${i - 1}`)
    break
  }
  seen = move.at
  // let the move land before photographing it — a frame mid-fly is a frame of
  // the transition, and the transition is not what is being judged
  await page.waitForTimeout(move.duration * 1000 + 1200)
  const file = `shots/${String(i).padStart(2, '0')}.png`
  await page.screenshot({ path: `${OUT}/${file}` })
  const state = await page.evaluate(() => ({
    d: Math.round(window.civ.rig.distance),
    polar: +window.civ.rig.polar.toFixed(2),
  }))
  sheet.push({ file, label: `${move.label} · d=${state.d} · pitch ${state.polar}` })
  console.log(`  ${i}/${SHOTS}  ${move.label} (${move.duration} s, d=${state.d})`)
}

const tiles = sheet
  .map(
    (t) =>
      `<figure><img src="${t.file}"><figcaption>${t.label}</figcaption></figure>`,
  )
  .join('')
await writeFile(
  `${OUT}/director-sheet.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    .g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:10px 12px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
   </style><h1>§66.3 director sheet — ${CHUNK}, ${sheet.length} frames the product composed</h1>
   <div class="g">${tiles}</div>`,
)
const sheetPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await sheetPage.goto(`file://${process.cwd()}/${OUT}/director-sheet.html`, {
  waitUntil: 'networkidle',
})
await sheetPage.screenshot({ path: `${OUT}/director-sheet.png`, fullPage: true })
console.log(`\n  director sheet: ${OUT}/director-sheet.png (${sheet.length} frames)`)
await browser.close()
