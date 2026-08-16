/**
 * §42.1 acceptance: one frame per city at city zoom with the chrome hidden.
 * The five frames must be tellable apart with the status line covered — that
 * is the whole test, judged by looking. Servers are optional: the baseline
 * paints without one, which is all a material read needs.
 *
 *   node tools/watch/cities.mjs <out-dir> [chunk ...]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/cities'
const CHUNKS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['schiedam-havens', 'london-deptford', 'brooklyn-redhook', 'paris-ourcq', 'tokyo-kyojima']

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

for (const chunk of CHUNKS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log(`PAGE EXCEPTION (${chunk})`, e.message))
  await page.goto(`http://127.0.0.1:5173/?chunk=${chunk}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(3000)
  await page.evaluate(() => document.getElementById('watchBtn')?.click())
  await page.evaluate(() => {
    window.civ.director.enabled = false
    window.civ.ui.home()
  })
  await page.waitForTimeout(2400)
  // ambient hides every pane and both bars — the status line is covered
  await page.keyboard.press('a')
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${chunk}.png` })
  console.log(`${chunk} -> ${OUT}/${chunk}.png`)
  await page.close()
}
await browser.close()
