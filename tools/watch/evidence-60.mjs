/**
 * §60: the narrative hierarchy against a LIVE world.
 *
 * Unlike the §56 rig this one deliberately does not freeze anything — a
 * headline that is held while true, a story that accumulates stages and a
 * digest over a rolling window are all claims about time passing, and a
 * pinned clock would prove none of them.
 *
 *   node tools/watch/evidence-60.mjs <out-dir> [chunk] [watch-seconds]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const OUT = process.argv[2] ?? 'tools/watch/evidence/60'
const CHUNK = process.argv[3] ?? 'schiedam-havens'
const WATCH = Number(process.argv[4] ?? 70)
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(
  `http://127.0.0.1:5173/?chunk=${CHUNK}&server=${encodeURIComponent('ws://127.0.0.1:8820/ws/' + CHUNK)}`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.waitForTimeout(3000)
await page.evaluate(() => {
  document.getElementById('watchBtn')?.click()
  window.civ.director.enabled = false
  window.civ.ui.home()
})
// open the panes a stranger would meet, so the layout is under real pressure
await page.evaluate(() => window.civ.ui.crew(true))
for (let i = 1; i <= 3; i++) {
  await page.waitForTimeout((WATCH / 3) * 1000)
  const state = await page.evaluate(() => ({
    headline: document.getElementById('headlineText')?.textContent,
    why: document.getElementById('headlineWho')?.textContent,
    stories: [...document.querySelectorAll('#storyList .s')].map(
      (n) => `${n.querySelector('.who')?.textContent}: ${n.querySelector('.stage')?.textContent}`,
    ),
    digest: document.getElementById('digest')?.textContent,
    feedRows: document.querySelectorAll('#feedList .e').length,
  }))
  console.log(`\n--- t+${Math.round((WATCH / 3) * i)}s ---`)
  console.log('headline:', state.headline, '|', state.why)
  console.log('stories :', state.stories.length ? state.stories.join(' || ') : '(none)')
  console.log('digest  :', state.digest || '(empty)')
  console.log('feedrows:', state.feedRows)
  await page.screenshot({ path: `${OUT}/${CHUNK}-t${i}.png` })
}
// overlap check: no two panes in a rail may intersect, and all must be onscreen
const overlaps = await page.evaluate(() => {
  const ids = ['headline', 'stories', 'inspector', 'log', 'crew', 'changelog']
  const boxes = ids
    .map((id) => ({ id, el: document.getElementById(id) }))
    .filter((x) => x.el && getComputedStyle(x.el).display !== 'none')
    .map((x) => ({ id: x.id, r: x.el.getBoundingClientRect() }))
  const bad = []
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i].r
    if (a.bottom > innerHeight - 40 || a.top < 38 || a.right > innerWidth || a.left < 0)
      bad.push(`${boxes[i].id} offscreen`)
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j].r
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
        bad.push(`${boxes[i].id} x ${boxes[j].id}`)
    }
  }
  return { shown: boxes.map((b) => b.id), bad }
})
console.log('\npanes shown:', overlaps.shown.join(', '))
console.log('collisions :', overlaps.bad.length ? overlaps.bad.join(' | ') : 'none')
await browser.close()
