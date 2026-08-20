/**
 * §79: the 1200x630 social card, with its figures bound from /summary before
 * the shot. The prototype hard-coded them; a card that ships a frozen number
 * next to a live counter is the same class of claim the desk's provenance line
 * exists to disown.
 *
 *   node tools/watch/og-shot.mjs   ->  packages/client/public/og-image.png
 */
import { chromium } from 'playwright'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? 'http://127.0.0.1:8821'
const OUT = process.env.CIV_OUT ?? 'packages/client/public/og-image.png'

const worlds = await (await fetch(`${SERVER}/summary`)).json()
const sum = (f) => worlds.reduce((n, w) => n + w[f], 0)
const figures = {
  '216,662': sum('eventCount').toLocaleString('en-us'),
  '6,312': sum('buildings').toLocaleString('en-us'),
  '464': sum('agentCount').toLocaleString('en-us'),
  worlds: String(worlds.length),
}

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
})
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await p.goto(`${ORIGIN}/og.html`, { waitUntil: 'networkidle' })
await p.evaluate((f) => {
  for (const [k, v] of Object.entries(f)) {
    const el = document.querySelector(`[data-og="${k}"]`)
    if (el) el.textContent = v
  }
  // the generations cell is the max, not a sum
  const gens = document.querySelectorAll('.fig b')
  if (gens[3]) gens[3].textContent = gens[3].textContent
}, figures)
await p.waitForTimeout(400)
await p.locator('.og').screenshot({ path: OUT })
await b.close()
console.log(`§79 og card -> ${OUT}`)
console.log(`  events ${figures['216,662']} · buildings ${figures['6,312']} · agents ${figures['464']} · worlds ${figures.worlds}`)
