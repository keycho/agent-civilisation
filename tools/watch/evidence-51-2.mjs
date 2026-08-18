/**
 * §51.2 evidence: the feed paces itself to a reader. Unlike the art-direction
 * a/b captures this one needs a live event stream, so it runs against the
 * local supervisor and *measures* rather than judging by eye:
 *
 *   - rendered rows per second over a 12s window (cap is ~2/s)
 *   - the `+n more` roll-up appears when the world outruns the pace
 *   - hover holds the stream; `p` holds it stickily; leaving resumes
 *   - routine lines are counted, not printed, until verbose
 *   - the typing tick fires on new rows
 *
 *   node tools/watch/evidence-51-2.mjs <out-dir> [ws-url]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/51-2'
const WS = process.argv[3] ?? 'ws://127.0.0.1:8820/ws/schiedam-havens'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(
  `http://127.0.0.1:5173/?chunk=schiedam-havens&server=${encodeURIComponent(WS)}`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.evaluate(() => document.getElementById('watchBtn')?.click())

// instrument: count row insertions and typing starts
await page.evaluate(() => {
  window.__feed = { rows: 0, typed: 0, since: performance.now() }
  const list = document.getElementById('feedList')
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue
        if (n.classList.contains('e') && !n.classList.contains('roll') && !n.classList.contains('count')) {
          window.__feed.rows++
          if (n.querySelector('.tx.typing')) window.__feed.typed++
        }
      }
    }
  }).observe(list, { childList: true })
})

await page.waitForTimeout(12000)
const rate = await page.evaluate(() => {
  const f = window.__feed
  const secs = (performance.now() - f.since) / 1000
  return { rows: f.rows, typed: f.typed, secs: +secs.toFixed(1), perSec: +(f.rows / secs).toFixed(2) }
})
console.log('render rate:', JSON.stringify(rate))

const state = await page.evaluate(() => ({
  roll: document.querySelector('#feedList .e.roll')?.textContent ?? null,
  count: document.querySelector('#feedList .e.count')?.textContent ?? null,
  rows: document.querySelectorAll('#feedList .e:not(.roll):not(.count)').length,
}))
console.log('feed state:', JSON.stringify(state))
await page.screenshot({ path: `${OUT}/a-paced.png` })

// hover holds the stream
await page.hover('#log')
await page.waitForTimeout(2500)
const held = await page.evaluate(() => ({
  held: !document.getElementById('logState').classList.contains('hidden'),
  roll: document.querySelector('#feedList .e.roll')?.textContent ?? null,
}))
console.log('hover held:', JSON.stringify(held))
await page.screenshot({ path: `${OUT}/b-hover-held.png` })
await page.mouse.move(400, 400)
await page.waitForTimeout(1200)

// p is a sticky hold; while it holds, rows must not advance
await page.keyboard.press('p')
await page.evaluate(() => { window.__feed.rows = 0 })
await page.waitForTimeout(4000)
const pauseCheck = await page.evaluate(() => ({
  rowsWhilePaused: window.__feed.rows,
  state: document.getElementById('logState').textContent,
  hidden: document.getElementById('logState').classList.contains('hidden'),
}))
console.log('p pause:', JSON.stringify(pauseCheck))
await page.screenshot({ path: `${OUT}/c-key-paused.png` })

// the roll-up expands on click
await page.click('#feedList .e.roll').catch(() => console.log('no roll-up to click'))
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/d-rollup-expanded.png` })
await page.keyboard.press('p')

// verbose shows everything the counter was holding
const beforeVerbose = await page.evaluate(
  () => document.querySelector('#feedList .e.count')?.textContent ?? null,
)
await page.click('#verboseBtn')
await page.waitForTimeout(4000)
const afterVerbose = await page.evaluate(() => ({
  count: document.querySelector('#feedList .e.count')?.textContent ?? null,
  pressed: document.getElementById('verboseBtn').getAttribute('aria-pressed'),
}))
console.log('verbose:', JSON.stringify({ before: beforeVerbose, after: afterVerbose }))
await page.screenshot({ path: `${OUT}/e-verbose.png` })

console.log(`§51.2 evidence -> ${OUT}`)
await browser.close()
