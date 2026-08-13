/**
 * Screenshot the running dev server. The whole point of spec v3 is that the
 * visual identity is part of the product, so being able to actually look at
 * the thing is part of the build loop, not a nicety.
 *
 *   node tools/shot.mjs /preview/ out.png [--wait 2500] [--size 1600x1000]
 *       [--eval "window.civ.setYear(2040)"]
 */
import { chromium } from 'playwright'

const [route = '/', out = 'shot.png'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const [w, h] = arg('size', '1600x1000').split('x').map(Number)
const wait = Number(arg('wait', '2500'))
const evalScript = arg('eval', null)
const base = arg('base', 'http://127.0.0.1:5173')

// The container ships a pinned Chromium build that will not match whatever
// revision the installed Playwright expects, so point at it directly.
const browser = await chromium.launch({
  executablePath: arg('chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'),
  args: [
    // software WebGL — there is no GPU in this container
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
})
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

await page.goto(base + route, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(wait)
if (evalScript) {
  await page.evaluate(evalScript)
  await page.waitForTimeout(Number(arg('wait2', '1500')))
}
await page.screenshot({ path: out })
await browser.close()

if (errors.length) {
  console.log('--- console ---')
  for (const e of [...new Set(errors)].slice(0, 25)) console.log(e)
}
console.log(`wrote ${out}`)
