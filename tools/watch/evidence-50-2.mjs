/**
 * §50.2 + §50.3: the five cities at their own authored hours, with windows.
 *
 * Dead server, day-0 plate, fixed camera per city, and the same deterministic
 * ownership pattern written into the client's data texture for every one —
 * so the frames differ only by the authored hour and the fabric beneath it.
 *
 * Two frames per city:
 *   <chunk>-unowned.png   the hour alone, nothing owned
 *   <chunk>.png           the same hour with the civilization in it
 *
 *   node tools/watch/evidence-50-2.mjs <out-dir> [chunk ...]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/50-2'
const CHUNKS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['schiedam-havens', 'london-deptford', 'paris-ourcq', 'tokyo-kyojima', 'brooklyn-redhook']

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

for (const chunk of CHUNKS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log(`PAGE EXCEPTION (${chunk})`, e.message))
  await page.goto(
    `http://127.0.0.1:5173/?chunk=${chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2800)
  // the §48 poster camera: the plate framing, chrome receded, director off
  await page.evaluate(() => {
    document.getElementById('watchBtn')?.click()
    document.body.classList.add('ambient')
    window.civ.director.enabled = false
    window.civ.ui.home()
  })
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `${OUT}/${chunk}-unowned.png` })

  const owned = await page.evaluate(() => {
    const d = window.civ.buildings.data
    const o = window.civ.observer
    const hash = (i) => {
      const x = Math.sin(i * 12.9898) * 43758.5453
      return x - Math.floor(x)
    }
    // §50.3's claim is that the night view is a map of where the civilization
    // LIVES, so the fixture has to be a district rather than confetti: one
    // coherent quarter of the plate, its edge feathered by the same stable
    // hash, plus a thin scatter beyond it for the outliers every chunk has.
    // Bounds come from the plate itself so the same rule frames every city.
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
    return { n, shapes: xs.length, count: d.count, xCut, yCut }
  })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/${chunk}.png` })
  console.log(`${chunk}:`, JSON.stringify(owned), `-> ${OUT}/${chunk}.png`)
  await page.close()
}
await browser.close()
