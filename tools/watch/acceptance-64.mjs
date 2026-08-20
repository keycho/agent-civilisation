/**
 * §64.5: "a first-load frame containing a status line, the world, and a
 * readable log — nothing else — that still answers what this is and what is
 * happening. if a stranger needs a key legend to understand the screen, the
 * default is still too full."
 *
 * Two halves, and both are assertions rather than opinions.
 *
 * NOTHING ELSE is countable: enumerate every element that paints over the
 * world and check the set is exactly {status line, bottom controls, log}. A
 * screenshot cannot make that claim — a pane can be present and empty, or
 * hidden behind another, and look absent while still being in the product.
 *
 * STILL ANSWERS is countable too, in the weaker sense that matters: the status
 * line has to name what this is, where it is and that it cannot be driven, and
 * the log has to be carrying readable sentences rather than being an empty box.
 *
 * Then every surface is opened by its key and closed by the same key, because
 * §64.1's grammar is only worth having if it is uniform, and Escape has to put
 * the screen back however many are open.
 *
 *   node tools/watch/acceptance-64.mjs [out-dir] [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/acceptance/64'
const CHUNK = process.argv[3] ?? 'schiedam-havens'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))

const results = []
const claim = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${detail}`)
}

await page.goto(`${ORIGIN}/w/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
// the stranger's single act: dismiss the explainer. Everything after this is
// the default view, untouched.
await page.waitForTimeout(3500)
await page.evaluate(() => document.getElementById('watchBtn')?.click())
await page.waitForTimeout(14000)

/** every element that paints over the world, by id, ignoring empty containers */
const VISIBLE = () =>
  page.evaluate(() => {
    const out = []
    /**
     * World annotations, not surfaces. The grain and the §63.4 site marks
     * belong to the picture; `chip` is §46's label for whatever the director
     * is currently looking at, positioned in world space and moving with it.
     * §64.1 enumerates what must hide — crew, changelog, stories, digest, map,
     * headline, the toggles, timelapse, ghost — and none of these is on that
     * list, so counting them would be measuring something the spec did not ask
     * for rather than measuring the default view.
     */
    const skip = new Set(['boot', 'grain', 'siteMarks', 'globeLabels', 'chip'])
    for (const el of document.querySelectorAll('.pane, .bar, #chip, #titleCard, #miniCard, #globeTools')) {
      if (skip.has(el.id)) continue
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const painted =
        cs.display !== 'none' &&
        cs.visibility !== 'hidden' &&
        Number(cs.opacity) > 0.02 &&
        r.width > 2 &&
        r.height > 2
      if (painted) out.push(el.id || el.className)
    }
    return out.sort()
  })

// ---------------------------------------------------------------------------
// 1. nothing else
// ---------------------------------------------------------------------------
const onScreen = await VISIBLE()
const EXPECTED = ['barBottom', 'barTop', 'log']
claim(
  '§64.1 default view is three things',
  JSON.stringify(onScreen) === JSON.stringify(EXPECTED),
  onScreen.join(', ') || 'nothing painted',
)

// ---------------------------------------------------------------------------
// 2. the status line answers what this is
// ---------------------------------------------------------------------------
const status = await page.evaluate(() => ({
  line: document.getElementById('barTop')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
  observer: document.getElementById('observer')?.textContent?.trim() ?? '',
  uptime: document.getElementById('uptime')?.textContent?.trim() ?? '',
  place: document.getElementById('chunkBtn')?.textContent?.trim() ?? '',
  gen: document.getElementById('genN')?.textContent?.trim() ?? '',
  link: document.getElementById('link')?.textContent?.trim() ?? '',
}))
claim(
  '§64.2 status line states the constraint',
  status.observer === 'observer' &&
    /^up \d/.test(status.uptime) &&
    status.place.length > 2 &&
    /gen \d/.test(status.gen) &&
    status.link === 'live',
  `"${status.line}"`,
)

// ---------------------------------------------------------------------------
// 3. the log is readable, and carrying sentences
// ---------------------------------------------------------------------------
const log = await page.evaluate(() => {
  const pane = document.getElementById('log')
  const rows = [...document.querySelectorAll('#feedList .e:not(.roll):not(.count)')]
  const texts = rows.map((r) => r.querySelector('.t')?.textContent?.trim() ?? '').filter(Boolean)
  return {
    width: Math.round(pane.getBoundingClientRect().width),
    rows: texts.length,
    longest: texts.reduce((a, t) => Math.max(a, t.length), 0),
    sample: texts[0] ?? '',
    // does any line wrap? a readable log holds a clause on one line
    wrapped: rows.filter((r) => r.getBoundingClientRect().height > 26).length,
  }
})
claim(
  '§64.1 the log is the star, not a sidebar',
  log.width >= 400 && log.rows >= 3 && log.longest >= 20,
  `${log.width}px, ${log.rows} rows, longest ${log.longest} chars — "${log.sample}"`,
)
await page.screenshot({ path: `${OUT}/1-default-view.png` })

// ---------------------------------------------------------------------------
// 4. every surface opens on its key and closes on the same key
// ---------------------------------------------------------------------------
const SURFACES = [
  { key: 'n', ids: ['headline', 'stories'] },
  { key: 'r', ids: ['crew'] },
  { key: 'c', ids: ['changelog'] },
  { key: 'g', ids: ['digest'] },
]
const grammar = []
for (const s of SURFACES) {
  await page.keyboard.press(s.key)
  await page.waitForTimeout(700)
  const opened = await VISIBLE()
  await page.keyboard.press(s.key)
  await page.waitForTimeout(700)
  const closed = await VISIBLE()
  const appeared = s.ids.every((id) => opened.includes(id))
  const gone = s.ids.every((id) => !closed.includes(id))
  grammar.push({ key: s.key, appeared, gone })
}
claim(
  '§64.1 one key opens, the same key closes',
  grammar.every((g) => g.appeared && g.gone),
  grammar.map((g) => `${g.key}:${g.appeared ? 'open' : 'NO'}/${g.gone ? 'close' : 'NO'}`).join(' '),
)

// ---------------------------------------------------------------------------
// 5. escape puts the screen back, whatever is open
// ---------------------------------------------------------------------------
for (const s of SURFACES) {
  await page.keyboard.press(s.key)
  await page.waitForTimeout(220)
}
await page.waitForTimeout(700)
const crowded = await VISIBLE()
await page.screenshot({ path: `${OUT}/2-everything-open.png` })
await page.keyboard.press('Escape')
await page.waitForTimeout(900)
const restored = await VISIBLE()
claim(
  '§64.1 escape restores the default view',
  JSON.stringify(restored) === JSON.stringify(EXPECTED),
  `${crowded.length} panes open -> ${restored.join(', ')}`,
)
await page.screenshot({ path: `${OUT}/3-after-escape.png` })

// ---------------------------------------------------------------------------
// 6. §64.3: the bottom bar is controls, not a menu
// ---------------------------------------------------------------------------
const bottom = await page.evaluate(() => {
  const bar = document.getElementById('barBottom')
  return {
    text: bar?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    controls: bar?.querySelectorAll('input, button').length ?? 0,
    advertised: (bar?.querySelectorAll('#keys b').length ?? 0),
  }
})
claim(
  '§64.3 the legend is behind `?`',
  bottom.controls <= 3 && bottom.advertised <= 1,
  `${bottom.controls} controls, ${bottom.advertised} shortcuts advertised — "${bottom.text}"`,
)

const passed = results.filter((r) => r.ok).length
console.log(`\n§64 acceptance: ${passed}/${results.length} claims pass`)
await writeFile(
  `${OUT}/acceptance.json`,
  JSON.stringify({ chunk: CHUNK, onScreen, status, log, grammar, bottom, results }, null, 2),
)
await browser.close()
process.exit(passed === results.length ? 0 : 1)
