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
 * is a fair question, and this is the sheet of them.
 *
 * §72.6: STEPPED, not waited on.
 *
 * The first version waited on `director.lastMove` changing and gave up after
 * 180 seconds having seen one move. Shot pacing is `shotElapsed += dt` and the
 * render loop clamps dt to 50 ms, so under this sandbox's software renderer at
 * ~1 fps MIN_SHOT_S of 7 needs about 140 seconds of wall clock and MAX_SHOT_S
 * of 16 needs 320. The instrument was measuring the frame rate, not the
 * director — the same fault §68.4 found in the opening dwell and §72.3 found in
 * the camera fuzz.
 *
 * So the director and the rig are STEPPED at a fixed 1/60 s, the way the inset
 * audit steps the rig, and the page is only left to run in real time when the
 * thing being waited for is the WIRE — events have to arrive before there is
 * anything to compose. Deterministic where the client is deterministic, real
 * where the world is.
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
await page.goto(`${ORIGIN}/w/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
// ambient is the mode these shots exist for
await page.evaluate(() => document.getElementById('watchBtn')?.click())

const sheet = []

/**
 * The stepper. `director.update` and `rig.update` are both pure functions of
 * dt, so driving them directly gives the director its shot clock in simulated
 * seconds while the renderer sits out.
 */
await page.evaluate(() => {
  const civ = window.civ
  window.__stepDirector = (seconds) => {
    const before = civ.director.lastMove?.at ?? 0
    const steps = Math.round(seconds * 60)
    for (let i = 0; i < steps; i++) {
      civ.director.update(1 / 60, civ.readouts?.tick ?? 0)
      civ.rig.update(1 / 60)
      const now = civ.director.lastMove?.at ?? 0
      if (now !== before) {
        return { moved: true, after: i / 60, move: { ...civ.director.lastMove } }
      }
    }
    return { moved: false, after: seconds, move: null }
  }
  /** run the rig on past a cut until the move has landed and the damping is done */
  window.__settleShot = (seconds) => {
    const steps = Math.round(seconds * 60)
    for (let i = 0; i < steps; i++) civ.rig.update(1 / 60)
    return {
      d: Math.round(civ.rig.distance),
      polar: +civ.rig.polar.toFixed(2),
      animating: civ.rig.isAnimating,
    }
  }
})

// the opening is the product's first frame and belongs on this sheet
await page.evaluate(() => window.civ.rig.settle())
await page.screenshot({ path: `${OUT}/shots/00-opening.png` })
sheet.push({ file: 'shots/00-opening.png', label: 'the opening — whole plate, held' })

/**
 * Then one frame per director shot. The wire is real time — events have to
 * arrive before there is anything worth cutting to — so each round gives the
 * socket a couple of seconds and then steps the director's clock forward until
 * it decides, up to a generous simulated budget.
 */
for (let i = 1; i <= SHOTS; i++) {
  let moved = null
  for (let round = 0; round < 8 && !moved; round++) {
    // real time, for the world to happen in
    await page.waitForTimeout(2200)
    // simulated time, for the director to think in
    const r = await page.evaluate(() => window.__stepDirector(20))
    if (r.moved) moved = r.move
  }
  if (!moved) {
    console.log(`  the director issued no further shot after ${i - 1}`)
    break
  }
  // let the move land before photographing it — a frame mid-fly is a frame of
  // the transition, and the transition is not what is being judged
  const state = await page.evaluate((d) => window.__settleShot(d + 1.5), moved.duration)
  const file = `shots/${String(i).padStart(2, '0')}.png`
  await page.screenshot({ path: `${OUT}/${file}` })
  sheet.push({ file, label: `${moved.label} · d=${state.d} · pitch ${state.polar}` })
  console.log(
    `  ${i}/${SHOTS}  ${moved.label} (${moved.duration} s, d=${state.d}, pitch ${state.polar})`,
  )
}

/**
 * §68.3's acceptance is not a count of draw calls, it is whether ten frames
 * are ten ideas. Two shots of the same kind at the same distance and pitch are
 * one idea photographed twice, and that is what the first sheet was: seven of
 * ten labelled `agent` at d=150 pitch 0.9.
 */
const shots = sheet.slice(1)
const setups = new Set(shots.map((t) => t.label))
const kinds = new Map()
for (const t of shots) {
  const kind = t.label.split(' · ')[0]
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
}
const commonest = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]
console.log(
  `\n  §68.3 variety — ${setups.size}/${shots.length} distinct setups, ` +
    `${kinds.size} intent kinds` +
    (commonest ? `, commonest '${commonest[0]}' ${commonest[1]}/${shots.length}` : ''),
)

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
