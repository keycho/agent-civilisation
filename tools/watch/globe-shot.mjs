import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto('http://127.0.0.1:5173/?chunk=schiedam-havens', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.waitForTimeout(2500)
await page.evaluate(() => document.getElementById('watchBtn')?.click())
// hold on the globe: cancel the auto-dive by re-entering globe mode
await page.waitForTimeout(1200)
await page.evaluate(() => window.civ.ui.toGlobe())
await page.waitForTimeout(9000)
await page.screenshot({ path: 'tools/watch/ab/globe.png' })
console.log('globe.png')
await browser.close()
