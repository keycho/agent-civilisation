/**
 * §46/§47 acceptance: a fresh visitor on the url, touching nothing for two
 * minutes — one click on [watch] (the visitor's single natural act), then
 * hands off. The director drives; frames land every ~12s. The judge looks
 * for: dark-framed city, glowing worksites, a crane over an active site,
 * the feed narrating with clickable lines, the camera carried to work.
 *
 *   node tools/watch/ambient.mjs <out-dir> [chunk] [minutes]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/ambient-session'
const CHUNK = process.argv[3] ?? 'schiedam-havens'
const MINUTES = Number(process.argv[4] ?? 2)

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(`http://127.0.0.1:5173/?chunk=${CHUNK}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
// the visitor's one act: [watch] on the explainer. Nothing after.
await page.waitForTimeout(3500)
await page.evaluate(() => document.getElementById('watchBtn')?.click())

const EVERY_MS = 12_000
const frames = Math.round((MINUTES * 60_000) / EVERY_MS)
for (let i = 0; i < frames; i++) {
  await page.waitForTimeout(EVERY_MS)
  const name = `${OUT}/t${String(i * (EVERY_MS / 1000)).padStart(3, '0')}s.png`
  await page.screenshot({ path: name })
  console.log(name)
}
await browser.close()
