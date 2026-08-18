/**
 * §56.1 calibration: where does each city's plate actually sit in linear
 * radiance? The bright pass draws its line at "above 1.0 = emitting"; this is
 * the measurement that says whether that line lands where the claim says it
 * does — on windows in the dusk cities, and on nothing at golden hour.
 *
 *   node tools/watch/measure-linear.mjs [chunk ...]
 */
import { chromium } from 'playwright'

const CHUNKS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['brooklyn-redhook', 'tokyo-kyojima', 'schiedam-havens', 'london-deptford', 'paris-ourcq']

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

for (const chunk of CHUNKS) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
  page.on('pageerror', (e) => console.log(`PAGE EXCEPTION (${chunk})`, e.message))
  await page.goto(
    `http://127.0.0.1:5173/?chunk=${chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2600)
  const out = await page.evaluate(() => {
    document.getElementById('watchBtn')?.click()
    document.body.classList.add('ambient')
    window.civ.director.enabled = false
    window.civ.ui.home()
  })
  void out
  await page.waitForTimeout(2600)
  // own a district so there is something emitting to measure
  await page.evaluate(() => {
    const d = window.civ.buildings.data
    const hash = (i) => {
      const x = Math.sin(i * 12.9898) * 43758.5453
      return x - Math.floor(x)
    }
    for (let i = 0; i < d.count; i++) {
      const h = hash(i)
      if (h > 0.5) continue
      d.data[i * 4 + 1] = h < 0.18 ? 1 : h < 0.34 ? 2 : 6
    }
    d.markDirty()
    window.civ.buildings.flush()
  })
  await page.waitForTimeout(2500)
  const m = await page.evaluate(() => ({
    night: window.civ.bloom.strength,
    ...window.civ.measureLinear(),
  }))
  const f = (v) => (typeof v === 'number' ? v.toFixed(4) : String(v))
  console.log(
    `${chunk.padEnd(17)} bloomS=${f(m.night)} max=${f(m.max)} p50=${f(m.p50)} p99=${f(m.p99)} ` +
      `p999=${f(m.p999)} >0.8=${f(m.fracOver0_8)} >1.0=${f(m.fracOver1_0)} >1.3=${f(m.fracOver1_3)}`,
  )
  await page.close()
}
await browser.close()
