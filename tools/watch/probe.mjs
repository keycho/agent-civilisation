/**
 * Live-state probe: read the running client's roster and readouts through the
 * real websocket path, for verifying the served world rather than the module.
 *
 *   node tools/watch/probe.mjs <ws-url> [chunk]
 */
import { chromium } from 'playwright'

const WS = process.argv[2] ?? 'ws://127.0.0.1:8790'
const CHUNK = process.argv[3] ? `&chunk=${process.argv[3]}` : ''

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
await page.goto(`http://127.0.0.1:5173/?server=${encodeURIComponent(WS)}${CHUNK}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ?.readouts != null && window.civ.roster.size > 0, null, {
  timeout: 120000,
})
await page.waitForTimeout(1500)

const out = await page.evaluate(() => ({
  agents: window.civ.roster.size,
  names: [...window.civ.roster.values()].slice(0, 12).map((a) => a.name),
  index: window.civ.readouts.divergenceIndex,
  generation: window.civ.readouts.generation,
}))
console.log(JSON.stringify(out, null, 2))
await browser.close()
