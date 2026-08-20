/**
 * §79: the desk, captured at the three breakpoints the handoff specifies, with
 * the state it is bound to printed beside the picture (§74.2).
 *
 * The boot overlay is skipped by seeding the session flag, except in the one
 * capture that exists to show it.
 */
import { chromium } from 'playwright'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const OUT = 'tools/watch/desk'
const VPS = [
  { name: '1680x900', width: 1680, height: 900 },
  { name: '1280x820', width: 1280, height: 820 },
  { name: '390x844', width: 390, height: 844 },
]
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
})
for (const vp of VPS) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height } })
  const p = await ctx.newPage()
  await p.addInitScript(() => { try { sessionStorage.setItem('tf.booted','1') } catch {} })
  await p.goto(ORIGIN + (process.env.CIV_Q ?? ''), { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.wrow', { timeout: 30000 }).catch(() => {})
  await p.waitForTimeout(5000)
  const state = await p.evaluate(() => ({
    worlds: [...document.querySelectorAll('.wrow')].map((r) => ({
      name: r.querySelector('.wrow__name')?.textContent,
      diff: r.querySelector('.wrow__diff')?.textContent,
      work: r.querySelector('.wrow__work')?.textContent,
      href: r.getAttribute('href'),
      lit: r.querySelectorAll('i[data-meter-fill]').length,
    })),
    events: document.querySelector('.counter__n')?.textContent,
    rate: document.querySelector('[data-live="events-rate"]')?.textContent,
    stats: [...document.querySelectorAll('.stat__n')].map((n) => n.textContent),
    wire: [...document.querySelectorAll('.wire__row')].length,
    ca: document.querySelector('#ca')?.textContent,
    caUnset: document.querySelector('#ca')?.getAttribute('data-unset'),
    buyDisabled: document.querySelector('#buy')?.getAttribute('aria-disabled'),
  }))
  await p.screenshot({ path: `${OUT}/${vp.name}.png`, fullPage: vp.width < 800 })
  console.log(`\n${vp.name}`)
  console.log(`  events ${state.events}  rate ${state.rate}  stats ${JSON.stringify(state.stats)}`)
  console.log(`  contract: "${state.ca}"  unset=${state.caUnset}  buy disabled=${state.buyDisabled}`)
  console.log(`  wire rows ${state.wire}`)
  for (const w of state.worlds) console.log(`    ${String(w.name).padEnd(26)} ${w.diff}  ${String(w.work).padEnd(11)} ${w.lit}/12  -> ${w.href}`)
  await ctx.close()
}
// and one of the boot, which only ever plays on a fresh session
const ctx = await b.newContext({ viewport: { width: 1680, height: 900 } })
const p = await ctx.newPage()
await p.goto(ORIGIN + (process.env.CIV_Q ?? ''), { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.screenshot({ path: `${OUT}/boot.png` })
await ctx.close()
await b.close()
console.log(`\n  shots in ${OUT}/`)
