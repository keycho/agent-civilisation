/** isolate the glow's own contribution: same build, bloom off vs bloom on */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const CHUNKS = ['schiedam-havens', 'london-deptford', 'paris-ourcq', 'brooklyn-redhook', 'tokyo-kyojima']
const OUTOFF = 'tools/watch/evidence/56/iso-off'
const OUTON = 'tools/watch/evidence/56/iso-on'
await mkdir(OUTOFF, { recursive: true }); await mkdir(OUTON, { recursive: true })
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
for (const chunk of CHUNKS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('ERR', chunk, e.message))
  await page.goto(`http://127.0.0.1:5173/?chunk=${chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2800)
  await page.evaluate(() => { document.getElementById('watchBtn')?.click(); document.body.classList.add('ambient'); window.civ.director.enabled = false; window.civ.ui.home() })
  await page.waitForTimeout(2600)
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
  await page.waitForTimeout(3500)
  // pin the clock: the pair must differ by the glow alone, not by the water
  await page.evaluate(() => window.civ.freezeClock(120))
  await page.waitForTimeout(700)
  await page.evaluate(() => window.civ.bloom.override(0))
  await page.waitForTimeout(900)
  const cam1 = await page.evaluate(() => ({ d: window.civ.rig.distance, p: window.civ.rig.polar, a: window.civ.rig.azimuth, tx: window.civ.rig.target.x, ty: window.civ.rig.target.y, tz: window.civ.rig.target.z }))
  await page.screenshot({ path: `${OUTOFF}/${chunk}.png` })
  await page.evaluate(() => window.civ.bloom.override(null))
  await page.waitForTimeout(900)
  const cam2 = await page.evaluate(() => ({ d: window.civ.rig.distance, p: window.civ.rig.polar, a: window.civ.rig.azimuth, tx: window.civ.rig.target.x, ty: window.civ.rig.target.y, tz: window.civ.rig.target.z }))
  await page.screenshot({ path: `${OUTON}/${chunk}.png` })
  console.log('  cam1', JSON.stringify(cam1))
  console.log('  cam2', JSON.stringify(cam2))
  console.log('done', chunk)
  await page.close()
}
await browser.close()
