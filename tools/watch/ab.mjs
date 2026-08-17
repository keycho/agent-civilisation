/**
 * §48: a/b capture at fixed cameras, never against the live sim. Same frame
 * as cities.mjs but pinned to a dead server so the world stays day-0 — an
 * evolving live world between the a and the b of a pair would pollute the
 * attribution the §48.6 order exists to keep.
 *
 *   node tools/watch/ab.mjs <out-dir> [chunk ...]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/ab/a'
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
  // server=ws://127.0.0.1:1 never connects: day-0 baseline, reproducible
  await page.goto(
    `http://127.0.0.1:5173/?chunk=${chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    document.getElementById('watchBtn')?.click()
    document.body.classList.add('ambient')
    window.civ.director.enabled = false
    window.civ.ui.home()
  })
  await page.waitForTimeout(2800)
  await page.screenshot({ path: `${OUT}/${chunk}.png` })
  console.log(`${chunk} -> ${OUT}/${chunk}.png`)
  await page.close()
}
await browser.close()
