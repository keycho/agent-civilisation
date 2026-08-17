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
// (1) home framing — the globe's own §24.1, no camera arguments at all
await page.evaluate(() => window.civ.ui.toGlobe())
await page.waitForTimeout(9000)
await page.screenshot({ path: 'tools/watch/ab/globe-home.png' })
console.log('globe-home.png')

// (2) mid-zoom on the nl cluster
await page.evaluate(() => {
  const V = window.civ.rig.target.constructor
  const o = window.civ.ui.orbitFor(51.9, 4.35)
  window.civ.rig.flyTo(new V(0, 0, 0), window.civ.rig.limits.minDistance * 1.04, { ...o, duration: 2.2 })
})
await page.waitForTimeout(7000)
await page.screenshot({ path: 'tools/watch/ab/globe-nl.png' })
console.log('globe-nl.png')
await browser.close()
