/**
 * §51.1 evidence: input wins the camera. Three states at the schiedam fixed
 * camera, dead server (day-0 reproducible, same discipline as ab.mjs):
 *   a — ambient on, chrome receded
 *   b — mid pointer-drag: ambient exited instantly, `manual` flip visible
 *   c — after double-click on fabric: focus orbit landed
 *
 *   node tools/watch/evidence-51-1.mjs <out-dir>
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/51-1'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(
  `http://127.0.0.1:5173/?chunk=schiedam-havens&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.waitForTimeout(3000)
await page.evaluate(() => {
  document.getElementById('watchBtn')?.click()
  window.civ.ui.home()
})
await page.waitForTimeout(2000)

// a: ambient via the real toggle (the a key), chrome recedes
await page.keyboard.press('a')
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/a-ambient.png` })

// b: a real pointer drag on the canvas — ambient must exit instantly and the
// flip chip must read `manual`; screenshot immediately, inside the flip window
// (swiftshader frames are slow: every awaited step eats into the 1400ms)
await page.mouse.move(640, 380)
await page.mouse.down()
await page.mouse.move(662, 372, { steps: 2 })
const flip = await page.evaluate(() => ({
  text: document.getElementById('modeFlip')?.textContent,
  on: document.getElementById('modeFlip')?.classList.contains('on'),
  ambient: document.body.classList.contains('ambient'),
}))
console.log('after drag:', JSON.stringify(flip))
await page.screenshot({ path: `${OUT}/b-input-wins.png` })
await page.mouse.up()

// c: double-click the fabric = focus orbit
await page.waitForTimeout(1600)
await page.mouse.dblclick(640, 400)
await page.waitForTimeout(2200)
await page.screenshot({ path: `${OUT}/c-focus-orbit.png` })

console.log(`§51.1 evidence -> ${OUT}`)
await browser.close()
