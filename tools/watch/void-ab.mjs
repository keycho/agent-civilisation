/**
 * §73.2: the void, before and after, at identical cameras.
 *
 * §72.3 measured the frame reaching 100-290 m past the fabric with the inset
 * bound satisfied, and §73.2's call is that closing that geometrically costs
 * more than it buys — ~250 m of inset at street level against a 520 m
 * half-extent would put the docks permanently out of reach at eye level. The
 * fault is not that the camera sees past the fabric. It is that past the fabric
 * there is nothing.
 *
 * The first fix tried was distance fog closing before the fabric's edge. This
 * harness falsified it: from a camera near an edge the void is not further away
 * than the city, so any distance term strong enough to close the void closed
 * the city with it — the opening lost most of its light. What is measured here
 * now is the POSITION-keyed version: the ground fades to the void by how far
 * outside the fabric box it lies, which buildings can never be.
 *
 * Both arms are captured in ONE session from the SAME camera states —
 * `civ.setVoidFade(false)` restores the plate as drawn ground — because an a/b
 * across two builds shares neither the world nor the framing and is not a
 * control.
 *
 * The framings are the ones the §72.6 contact sheet produced that still carried
 * a dark wedge, aimed at the fabric's corner where the wedge lives.
 *
 *   node tools/watch/void-ab.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/73'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

/** the framings the director actually composes, at the pitches it uses */
const SHOTS = [
  { name: 'street, looking out', d: 118, p: 0.97, at: 0.98 },
  { name: 'construction', d: 158, p: 0.83, at: 0.98 },
  { name: 'assembly, wide', d: 409, p: 0.79, at: 0.9 },
  { name: 'assembly, mid', d: 297, p: 0.67, at: 0.94 },
  { name: 'demolition', d: 234, p: 0.52, at: 0.96 },
  { name: 'the opening', d: 0, p: 0, at: 0 },
]

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
await page.evaluate(() => document.getElementById('watchBtn')?.click())
// let a world arrive, so the fabric box is the measured city and there is light
await page.waitForTimeout(12000)
// the camera is placed by hand here; the director must not take it back
await page.evaluate(() => window.civ.director.takeControl())

const rows = []
/**
 * The fog is recomputed in the RENDER loop, so `fogState()` read straight after
 * placing the camera reports the previous frame's values — the first run of
 * this printed every shot's numbers one row late. Two frames, then read.
 */
const settled = () =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )

for (const shot of SHOTS) {
  const arm = {}
  for (const bound of [false, true]) {
    await page.evaluate(
      ({ d, p, at, bound }) => {
        const civ = window.civ
        civ.setVoidFade(bound)
        if (d === 0) {
          civ.plate.home(true)
        } else {
          const [hx, hy] = civ.plate.city.half
          const [cx, cy] = civ.plate.city.centre
          civ.rig.flyTo(civ.pointAt(cx + hx * at, cy + hy * at), d, { polar: p, duration: 1 })
          civ.rig.settle()
        }
      },
      { ...shot, bound },
    )
    await settled()
    arm[bound ? 'after' : 'before'] = await page.evaluate(() => window.civ.voidFade())
    const file = `shots/${shot.name.replace(/[^a-z]+/gi, '-')}-${bound ? 'after' : 'before'}.png`
    await page.screenshot({ path: `${OUT}/${file}` })
    if (bound) arm.file = file
  }
  rows.push({ ...shot, ...arm })
  const r = rows.at(-1)
  console.log(
    `  ${shot.name.padEnd(22)} fade on: ${r.after.on}   fabric half ${JSON.stringify(
      r.after.half,
    )}   band ${r.after.band} m   over ${r.after.materials} ground materials`,
  )
}
await browser.close()

const tiles = rows
  .map(
    (r) =>
      `<section><h2>${r.name} · d=${r.d || 'home'} · pitch ${r.p || '—'}</h2>
       <div class="p">
         <figure><img src="${r.file.replace('-after', '-before')}"><figcaption>before · plate drawn to its own extent</figcaption></figure>
         <figure><img src="${r.file}"><figcaption>after · ground fades to the void ${r.after.band} m past the fabric</figcaption></figure>
       </div></section>`,
  )
  .join('')
await writeFile(
  `${OUT}/void-ab.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    h2{font-size:11px;color:#8a8069;font-weight:400;padding:10px 12px 2px;margin:0}
    .p{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 12px 6px}
    figure{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620}
    figcaption{padding-top:3px}
   </style><h1>§73.2 the void — ${CHUNK}, same camera, ground fade off then on</h1>
   ${tiles}`,
)
const sheetPage = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1300, height: 1000 } })
await sheetPage.goto(`file://${process.cwd()}/${OUT}/void-ab.html`, { waitUntil: 'networkidle' })
await sheetPage.screenshot({ path: `${OUT}/void-ab.png`, fullPage: true })
await sheetPage.context().browser().close()
console.log(`\n  §73.2 a/b: ${OUT}/void-ab.png (${rows.length} pairs)`)
