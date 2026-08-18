/**
 * §56.1 verification: with the acceptance fixture owned and the clock pinned,
 * toggle the glow off/on/off in ONE page and diff. If off#1 == off#2 the rig is
 * sound, and whatever separates them from `on` is the glow and nothing else.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const CHUNKS = process.argv.slice(2).length ? process.argv.slice(2) : ['schiedam-havens', 'brooklyn-redhook']
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
for (const chunk of CHUNKS) {
  for (const d of ['off1', 'on', 'off2']) await mkdir(`tools/watch/evidence/56/probe-${d}`, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('ERR', e.message))
  await page.goto(`http://127.0.0.1:5173/?chunk=${chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2800)
  await page.evaluate(() => { document.getElementById('watchBtn')?.click(); document.body.classList.add('ambient'); window.civ.director.enabled = false; window.civ.ui.home() })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    const d = window.civ.buildings.data, o = window.civ.observer
    const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x) }
    const at = []
    for (let i = 0; i < d.count; i++) { const fp = o.footprintAt(i); if (!fp || !fp.length) { at.push(null); continue }
      let cx = 0, cy = 0; for (const p of fp) { cx += p[0]; cy += p[1] }; at.push([cx / fp.length, cy / fp.length]) }
    const xs = at.filter(Boolean).map(p => p[0]).sort((a, b) => a - b), ys = at.filter(Boolean).map(p => p[1]).sort((a, b) => a - b)
    const xCut = xs[Math.floor(xs.length * 0.55)], yCut = ys[Math.floor(ys.length * 0.45)], span = (xs[xs.length - 1] - xs[0]) * 0.14
    for (let i = 0; i < d.count; i++) { const p = at[i]; if (!p) continue; const h = hash(i); const f = (h - 0.5) * span
      if (!(p[0] < xCut + f && p[1] > yCut + f) && h > 0.06) continue
      d.data[i * 4 + 1] = h < 0.18 ? 1 : h < 0.34 ? 2 : h < 0.46 ? 3 : 6 }
    d.markDirty(); window.civ.buildings.flush()
  })
  // let the §50.3 relight pulses finish BEFORE pinning the clock
  await page.waitForTimeout(9000)
  await page.evaluate(() => { window.civ.freezeClock(120); window.civ.rig.settle() })
  await page.waitForTimeout(1500)
  for (const [dir, v] of [['off1', 0], ['on', null], ['off2', 0]]) {
    await page.evaluate((vv) => window.civ.bloom.override(vv), v)
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `tools/watch/evidence/56/probe-${dir}/${chunk}.png` })
  }
  console.log('probed', chunk)
  await page.close()
}
await browser.close()
