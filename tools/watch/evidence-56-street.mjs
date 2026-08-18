/**
 * §56: the street-framing check. City zoom proves density; only a close frame
 * proves the lamps are actually ON the kerb, that the poles arrive, and that
 * traffic runs down the carriageway rather than through the buildings.
 *
 *   node tools/watch/evidence-56-street.mjs <out-dir> [chunk ...] [--dist N]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const args = process.argv.slice(2)
const distArg = args.indexOf('--dist')
const DIST = distArg >= 0 ? Number(args[distArg + 1]) : 260
const rest = distArg >= 0 ? args.slice(0, distArg) : args
const OUT = rest[0] ?? 'tools/watch/evidence/56/street'
const CHUNKS = rest.slice(1).length ? rest.slice(1) : ['brooklyn-redhook', 'tokyo-kyojima']
await mkdir(OUT, { recursive: true })
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
  await page.evaluate(() => { document.getElementById('watchBtn')?.click(); document.body.classList.add('ambient'); window.civ.director.enabled = false })
  // own everything so windows are lit, then drop into the street
  await page.evaluate(() => {
    const d = window.civ.buildings.data
    const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x) }
    for (let i = 0; i < d.count; i++) { const h = hash(i); if (h > 0.72) continue; d.data[i * 4 + 1] = h < 0.2 ? 1 : h < 0.4 ? 2 : 6 }
    d.markDirty(); window.civ.buildings.flush()
  })
  await page.waitForTimeout(6000)
  await page.evaluate((dist) => window.civ.ui.street(dist), DIST)
  await page.waitForTimeout(1500)
  await page.evaluate(() => { window.civ.freezeClock(120); window.civ.rig.settle() })
  await page.waitForTimeout(1400)
  const info = await page.evaluate(() => ({ d: Math.round(window.civ.rig.distance), lamps: window.civ.streetLightCount?.() ?? null }))
  await page.screenshot({ path: `${OUT}/${chunk}.png` })
  console.log(chunk, JSON.stringify(info), '->', `${OUT}/${chunk}.png`)
  await page.close()
}
await browser.close()
