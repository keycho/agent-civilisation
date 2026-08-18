/**
 * §56 the cinematic pass: one a/b rig for every numbered step.
 *
 * Same discipline as §50.2 (dead server, day-0 plate, fixed home camera, and
 * the same deterministic ownership district written into the data texture for
 * every city) so a pair of stages differs ONLY by the step under test. The
 * ownership fixture is copied from evidence-50-2.mjs deliberately: §56 is
 * judged on light, and light needs the civilization switched on.
 *
 *   node tools/watch/evidence-56.mjs <stage-dir> [chunk ...]
 *
 * Stage dirs are the a/b ledger: a0 (pre-§56), then one per shipped item.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/56/a0'
const CHUNKS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['brooklyn-redhook', 'tokyo-kyojima', 'schiedam-havens', 'london-deptford', 'paris-ourcq']

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

/** the §50.2 district fixture: a coherent owned quarter, feathered, plus outliers */
async function ownDistrict(page) {
  return page.evaluate(() => {
    const d = window.civ.buildings.data
    const o = window.civ.observer
    const hash = (i) => {
      const x = Math.sin(i * 12.9898) * 43758.5453
      return x - Math.floor(x)
    }
    const at = []
    for (let i = 0; i < d.count; i++) {
      const fp = o.footprintAt(i)
      if (!fp || !fp.length) {
        at.push(null)
        continue
      }
      let cx = 0
      let cy = 0
      for (const p of fp) {
        cx += p[0]
        cy += p[1]
      }
      at.push([cx / fp.length, cy / fp.length])
    }
    const xs = at.filter(Boolean).map((p) => p[0]).sort((a, b) => a - b)
    const ys = at.filter(Boolean).map((p) => p[1]).sort((a, b) => a - b)
    const xCut = xs[Math.floor(xs.length * 0.55)]
    const yCut = ys[Math.floor(ys.length * 0.45)]
    const span = (xs[xs.length - 1] - xs[0]) * 0.14
    let n = 0
    for (let i = 0; i < d.count; i++) {
      const p = at[i]
      if (!p) continue
      const h = hash(i)
      const feather = (h - 0.5) * span
      const inDistrict = p[0] < xCut + feather && p[1] > yCut + feather
      if (!inDistrict && h > 0.06) continue
      d.data[i * 4 + 1] = h < 0.18 ? 1 : h < 0.34 ? 2 : h < 0.46 ? 3 : 6
      n++
    }
    d.markDirty()
    window.civ.buildings.flush()
    return n
  })
}

for (const chunk of CHUNKS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log(`PAGE EXCEPTION (${chunk})`, e.message))
  await page.goto(
    `http://127.0.0.1:5173/?chunk=${chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2800)
  await page.evaluate(() => {
    document.getElementById('watchBtn')?.click()
    document.body.classList.add('ambient')
    window.civ.director.enabled = false
    window.civ.ui.home()
  })
  await page.waitForTimeout(2600)
  const n = await ownDistrict(page)
  // let the §50.3 relight pulses run out before anything is pinned
  await page.waitForTimeout(9000)
  // Reproducibility, the hard way. The rig damps asymptotically and the world
  // animates, so two frames of "the same" view are never the same frame: the
  // residual camera drift alone displaces far edges by tens of pixels, which
  // reads as a change the step under test did not make. Pinning the clock and
  // landing the camera exactly makes stage-to-stage diffs bit-identical where
  // nothing changed — measured, not assumed (tools/watch/abdiff.mjs).
  await page.evaluate(() => {
    window.civ.freezeClock(120)
    window.civ.rig.settle()
  })
  await page.waitForTimeout(1400)
  await page.screenshot({ path: `${OUT}/${chunk}.png` })
  console.log(`${chunk}: ${n} owned -> ${OUT}/${chunk}.png`)
  await page.close()
}
await browser.close()
