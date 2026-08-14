/**
 * §24.1: one frame, one camera, for judging the framing by looking.
 *
 * `season.mjs` watches a run over time. This takes a single pair — normal and
 * divergence — at the default city framing, which is the frame §24 is about.
 *
 *   node tools/watch/frame.mjs <ws-url> <out-prefix> [ambient]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const WS = process.argv[2] ?? 'ws://127.0.0.1:8790'
const OUT = process.argv[3] ?? 'tools/watch/frame/city'
const AMBIENT = process.argv[4] === 'ambient'

await mkdir(dirname(OUT), { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-gpu-sandbox',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(`http://127.0.0.1:5173/?server=${encodeURIComponent(WS)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ?.readouts != null, null, { timeout: 120000 })
await page.waitForTimeout(6000)

if (AMBIENT) {
  await page.keyboard.press('a')
  await page.waitForTimeout(1200)
}

// §21.4 in spirit: read the framing off the running camera, not off the source
const cam = await page.evaluate(() => ({
  distance: Math.round(window.civ.rig.distance),
  index: window.civ.readouts.divergenceIndex,
}))
console.log(`camera distance ${cam.distance} m, index ${(cam.index * 100).toFixed(1)}%`)

await page.screenshot({ path: `${OUT}-normal.png` })
await page.evaluate(() => window.civ.setMode(1))
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}-divergence.png` })
console.log(`wrote ${OUT}-normal.png and ${OUT}-divergence.png`)

await browser.close()
