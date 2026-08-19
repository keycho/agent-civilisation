/**
 * §66/§67 acceptance.
 *
 * Assertions pre-registered before the first run, in the order the operator
 * asked for them:
 *
 * §66.1 the opening
 *   1. first load holds the whole-plate framing MOTIONLESS for 8-10 s before
 *      the director takes an intent
 *   2. the director's first move is a move, not a cut — duration >= 7 s
 *
 * §66.2 home and ambient
 *   3. `0` from a deliberately bad state comes home AND leaves ambient off
 *   4. pointer input turns ambient off and never re-arms it
 *
 * §67 the listing
 *   5. boot reads `mounting /earth · N worlds attached`
 *   6. one row per chunk, each carrying city, country, generation, diff,
 *      activity meter and a live working count
 *   7. rows are sorted by activity, busiest first
 *   8. arrows move the selection; enter dives
 *   9. a click dives
 *  10. `[` `]` still cycle
 *  11. the migration line names a person, an origin and a destination
 *  12. the map is GONE, not hidden: no mapView, no mapMarkers, no toGlobe,
 *      and `plate.mode` is a constant
 *
 * §69 /earth as the homepage
 *  13. a bare first load opens /earth and HOLDS — no auto-navigation
 *  14. the status line names the world count, not a generation
 *  15. uptime comes from the server's genesis, and reads `—` when the server
 *      does not report one rather than `0s`
 *  16. the half below the listing carries the premise, a live aggregate, a
 *      ticker and the credits
 *  17. §68's canary: the batch is inside the fabric box and fills it
 *
 *   node tools/watch/acceptance-66-67.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/67'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

await mkdir(OUT, { recursive: true })

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
const url = `${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`
await page.goto(url, { waitUntil: 'domcontentloaded' })

// ---------------------------------------------------------------------------
// §67.5: the boot line, read before it fades
// ---------------------------------------------------------------------------
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
const bootText = await page.evaluate(
  () => document.getElementById('bootLines')?.firstElementChild?.textContent ?? '',
)
const chunkCount = await page.evaluate(() => window.civ.ui.chunks().length)
check(
  '§67.5 boot reads `mounting /earth · N worlds attached`',
  bootText === `mounting /earth · ${chunkCount} worlds attached`,
  JSON.stringify(bootText),
)

// ---------------------------------------------------------------------------
// §66.1: the dwell. Sampled from the moment the page is live, so the window
// measured is the one a viewer actually sits through.
// ---------------------------------------------------------------------------
/**
 * Measured in PIXELS, which is the only unit "motionless" is stated in.
 *
 * A first version weighted the rig's raw polar by 400 to make it commensurate
 * with metres of target travel, and reported the opening as broken at 4.2 s.
 * The camera had not moved: target and distance were fixed for the whole
 * twenty seconds and the pitch had settled by 0.86° — an artifact of the
 * instrument's own made-up exchange rate. Projecting the fabric's own corners
 * and watching where they land needs no exchange rate.
 */
const dwell = await page.evaluate(async () => {
  const civ = window.civ
  const V = civ.Vector3
  const c = civ.plate.city
  const corners = [
    [c.world[0] - c.half[0], c.world[1] - c.half[1]],
    [c.world[0] + c.half[0], c.world[1] - c.half[1]],
    [c.world[0] - c.half[0], c.world[1] + c.half[1]],
    [c.world[0] + c.half[0], c.world[1] + c.half[1]],
  ]
  const shot = () => {
    civ.rig.camera.updateMatrixWorld(true)
    return corners.map(([x, z]) => {
      const v = new V(x, civ.plate.groundY, z).project(civ.rig.camera)
      return [((v.x + 1) / 2) * innerWidth, (1 - (v.y + 1) / 2) * innerHeight]
    })
  }
  const t0 = performance.now()
  const navStart = 0
  const start = shot()
  let firstMoveAt = null
  let maxStill = 0
  let dwellEndedAt = null
  return await new Promise((done) => {
    const tick = () => {
      const now = (performance.now() - t0) / 1000
      const px = Math.max(...shot().map(([x, y], i) => Math.hypot(x - start[i][0], y - start[i][1])))
      if (firstMoveAt === null) {
        if (px > 24) firstMoveAt = now
        else if (px > maxStill) maxStill = px
      }
      if (dwellEndedAt === null && !civ.director.dwelling) dwellEndedAt = now
      if (performance.now() - t0 > 16000) {
        // the dwell's own deadline, on the page's timeline — measured from
        // navigation rather than from whenever the harness first looked
        done({
          firstMoveAt,
          maxStill,
          dwellEndedAt,
          t0,
          navStart,
          startedAt: civ.director.dwellStartedAt,
          endsAt: civ.director.dwellEndsAt,
          lastMove: civ.director.lastMove,
        })
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
})
/**
 * The hold is measured from the moment the framing is PRESENTED — when the
 * director is constructed — not from navigation. The seed load in front of it
 * is a separate variable and folding it in silently would make the bar mean
 * "8-10 s minus however long the network took"; it is reported alongside.
 *
 * Both ends come from the director's own wall-clock stamps rather than from
 * when this sampler noticed the release. Under software GL the sampler's rAF
 * ticks are more than a second apart, so its observation of the release lags
 * the release by more than the bar's whole tolerance — it is reported, and the
 * assertion that the dwell was still HOLDING while the frame sat motionless is
 * what the sampler is actually good for.
 */
const hold = (dwell.endsAt - dwell.startedAt) / 1000
check(
  '§66.1 the opening holds the framing for 8-10 s before the first intent',
  hold >= 8 && hold <= 10 && dwell.dwellEndedAt !== null,
  `held ${hold.toFixed(1)} s from presentation, released ` +
    `${(dwell.endsAt / 1000).toFixed(1)} s after navigation (load included); ` +
    `sampler saw the release at ${dwell.dwellEndedAt === null ? 'never' : `+${(dwell.t0 / 1000 + dwell.dwellEndedAt).toFixed(1)} s`}`,
)
check(
  '§66.1 and it is genuinely motionless, not merely slow',
  dwell.maxStill < 6 && (dwell.firstMoveAt === null || dwell.firstMoveAt > dwell.dwellEndedAt),
  `worst fabric-corner drift during the hold: ${dwell.maxStill.toFixed(1)} px`,
)

/**
 * The first move is a MOVE. Asserted on the shot the director ISSUED, not on
 * how far the camera got in four seconds of wall clock: shot pacing runs on
 * the render loop's clamped dt, so a sampled version measures this sandbox's
 * software renderer rather than the decision under test.
 */
const firstMove = await page.evaluate(async () => {
  const t0 = performance.now()
  while (performance.now() - t0 < 90000) {
    if (window.civ.director.lastMove) return window.civ.director.lastMove
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
})
check(
  '§66.1 that first move is a slow move, not a cut',
  !!firstMove && firstMove.slow && firstMove.duration >= 7,
  firstMove ? `${firstMove.duration} s to "${firstMove.label}"` : 'the director never took an intent',
)

// ---------------------------------------------------------------------------
// §66.2: home stops ambient, and so does the pointer
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  document.body.classList.add('ambient')
  window.civ.rig.flyTo(
    new window.civ.Vector3(window.civ.plate.city.world[0] + 120, window.civ.plate.groundY, window.civ.plate.city.world[1] - 200),
    45,
    { polar: 1.1, azimuth: -1.2, duration: 0.01 },
  )
})
await page.waitForTimeout(900)
await page.keyboard.press('0')
await page.waitForTimeout(2200)
const afterZero = await page.evaluate(() => {
  const civ = window.civ
  civ.rig.settle()
  // settle() places the camera but does not refresh its inverse world matrix,
  // and `project` reads that. Without this the check reads whatever matrix the
  // last rendered frame left behind — which, once §66.1 let the director start
  // taking shots before this block runs, was a close-up pointing elsewhere and
  // put the city's centre 2.79 off screen.
  civ.rig.camera.updateMatrixWorld(true)
  const v = new civ.Vector3(civ.plate.city.world[0], civ.plate.groundY, civ.plate.city.world[1]).project(
    civ.rig.camera,
  )
  return {
    ambient: document.body.classList.contains('ambient'),
    d: Math.round(civ.rig.distance),
    offCentre: Math.hypot(v.x, v.y),
  }
})
check(
  '§66.2 `0` comes home from a bad state and turns ambient OFF',
  !afterZero.ambient && afterZero.offCentre < 0.05 && afterZero.d > 500,
  `ambient ${afterZero.ambient ? 'still on' : 'off'}, d=${afterZero.d}, centroid ${afterZero.offCentre.toFixed(3)} off centre`,
)

// pointer input: ambient off, and it must not come back on its own
await page.evaluate(() => document.body.classList.add('ambient'))
await page.mouse.move(700, 450)
await page.mouse.down({ button: 'left' })
await page.mouse.move(820, 500)
await page.mouse.up({ button: 'left' })
await page.waitForTimeout(1200)
const afterDrag = await page.evaluate(() => document.body.classList.contains('ambient'))
await page.waitForTimeout(9000)
const rearmed = await page.evaluate(() => document.body.classList.contains('ambient'))
check(
  '§66.2 pointer input turns ambient off and it does not re-arm',
  !afterDrag && !rearmed,
  `off after drag: ${!afterDrag}; still off 9 s later: ${!rearmed}`,
)

// ---------------------------------------------------------------------------
// §67: the listing
// ---------------------------------------------------------------------------
/**
 * A navigation here reloads a whole chunk seed under software GL, which is not
 * a fixed number of milliseconds. Waiting a fixed 2.5 s reported three dives as
 * broken that had in fact all navigated — the harness was reading the url
 * before the browser had committed it.
 */
const divedTo = async (from, ms = 30000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const now = new URL(page.url()).searchParams.get('chunk')
    if (now && now !== from) return now
    await page.waitForTimeout(250)
  }
  return new URL(page.url()).searchParams.get('chunk')
}

// the pointer must be OFF the list for the sort assertion: §67 freezes the
// order under the pointer on purpose, so a mouse left over a row would make
// the harness assert a frozen order against live rates
await page.mouse.move(12, 12)
await page.keyboard.press('m')
await page.waitForTimeout(4500)
await page.screenshot({ path: `${OUT}/earth.png` })

const listing = await page.evaluate(() => {
  // VISUAL order, not document order: §67 reseats rows with flex `order` so
  // that a live re-sort never detaches the element under the pointer, which
  // means querySelectorAll returns them in the order they were created
  const rows = [...document.querySelectorAll('#worldsList .row')]
    .sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0))
    .map((r) => ({
    id: r.dataset.id,
    nm: r.querySelector('.nm')?.textContent ?? '',
    cc: r.querySelector('.cc')?.textContent ?? '',
    gen: r.querySelector('.gen')?.textContent ?? '',
    diff: r.querySelector('.diff')?.textContent ?? '',
    act: r.querySelector('.act')?.textContent ?? '',
    wk: r.querySelector('.wk')?.textContent ?? '',
    sel: r.classList.contains('sel'),
  }))
  return {
    rows,
    chunks: window.civ.ui.chunks().map((c) => c.id),
    rates: window.civ.ui.summaries().map((s) => s.activityRate ?? 0),
    order: rows.map((r) => window.civ.ui.summaries().find((s) => s.id === r.id)?.activityRate ?? -1),
    migration: document.getElementById('worldsMigration')?.textContent ?? '',
    fullFrame: (() => {
      const b = document.getElementById('worlds').getBoundingClientRect()
      return b.width >= innerWidth - 2 && b.height > innerHeight * 0.8
    })(),
  }
})

check(
  '§67.6 one row per mounted world',
  listing.rows.length === listing.chunks.length &&
    listing.chunks.every((id) => listing.rows.some((r) => r.id === id)),
  `${listing.rows.length} rows for ${listing.chunks.length} chunks`,
)
const complete = listing.rows.every(
  (r) => r.nm && /^[a-z]{2}$/.test(r.cc) && /^g\d/.test(r.gen) && /%$/.test(r.diff) && r.act && /\d/.test(r.wk),
)
check(
  '§67.6 every row carries city, country, generation, diff, meter and working',
  complete,
  JSON.stringify(listing.rows[0]),
)
const sorted = listing.order.every((v, i) => i === 0 || listing.order[i - 1] >= v - 1e-9)
check('§67.7 sorted by activity, busiest first', sorted, listing.order.map((v) => v.toFixed(3)).join(' > '))
check('§67 the listing is full-frame', listing.fullFrame)
check(
  '§67.11 the migration line names a person, an origin and a destination',
  /^\S+ left \S.* for \S/.test(listing.migration.trim()),
  JSON.stringify(listing.migration.split('replayed')[0].trim()),
)

// §67.8: arrows move the selection
const selBefore = await page.evaluate(
  () => [...document.querySelectorAll('#worldsList .row')].findIndex((r) => r.classList.contains('sel')),
)
await page.keyboard.press('ArrowDown')
await page.waitForTimeout(200)
const selAfter = await page.evaluate(
  () => [...document.querySelectorAll('#worldsList .row')].findIndex((r) => r.classList.contains('sel')),
)
check('§67.8 arrows move the selection', selAfter !== selBefore && selAfter >= 0, `${selBefore} -> ${selAfter}`)

// §67.8: enter dives. The selection is on a world that is not this one, so the
// dive is a navigation — asserted by the url the page lands on.
const target = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#worldsList .row')]
  const i = rows.findIndex((r) => r.classList.contains('sel'))
  return rows[i]?.dataset.id
})
await page.keyboard.press('Enter')
const landed = await divedTo(CHUNK)
check('§67.8 enter dives into the selected world', landed === target, `${landed} (wanted ${target})`)

// §67.9: a click dives too
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.keyboard.press('m')
await page.waitForTimeout(3000)
const beforeClick = new URL(page.url()).searchParams.get('chunk')
const clickTarget = await page.evaluate((here) => {
  const rows = [...document.querySelectorAll('#worldsList .row')]
  return rows.find((r) => r.dataset.id !== here)?.dataset.id
}, beforeClick)
await page.click(`#worldsList .row[data-id="${clickTarget}"]`)
const clicked = await divedTo(beforeClick)
check('§67.9 a click dives', clicked === clickTarget, `${clicked} (wanted ${clickTarget})`)

// §67.10: `[` `]` still cycle
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
const beforeCycle = new URL(page.url()).searchParams.get('chunk')
await page.keyboard.press(']')
const afterCycle = await divedTo(beforeCycle)
check('§67.10 `[` `]` still cycle', afterCycle !== beforeCycle && !!afterCycle, `${beforeCycle} -> ${afterCycle}`)

// §67.12: the map is gone, not hidden
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
const gone = await page.evaluate(() => ({
  mapView: 'mapView' in window.civ,
  mapMarkers: 'mapMarkers' in window.civ,
  toGlobe: 'toGlobe' in window.civ.ui,
  mode: window.civ.plate.mode,
  plateMap: 'map' in window.civ.plate,
  bodyGlobe: document.body.classList.contains('globe'),
  globeEls: document.querySelectorAll('#globeLabels, #globeCard, #globeTools, .glabel').length,
}))
check(
  '§67.12 the map is deleted, not flagged off',
  !gone.mapView && !gone.mapMarkers && !gone.toGlobe && !gone.plateMap && gone.mode === 'city' && gone.globeEls === 0,
  JSON.stringify(gone),
)

// ---------------------------------------------------------------------------
// §69: the homepage
// ---------------------------------------------------------------------------
const home = await browser.newPage({ viewport: { width: 1440, height: 900 } })
home.on('pageerror', (e) => console.log('PAGE EXCEPTION (home)', e.message))
await home.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await home.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await home.waitForTimeout(11000)
const opened = await home.evaluate(() => document.body.classList.contains('worlds'))
const bareAtFirst = new URL(home.url()).search === ''
// the whole point: it is a destination, so it must still be here later
await home.waitForTimeout(18000)
const held = await home.evaluate(() => document.body.classList.contains('worlds'))
const bareStill = new URL(home.url()).search === ''
check(
  '§69.13 a bare load opens /earth and holds — no auto-navigation',
  opened && bareAtFirst && held && bareStill,
  `opened ${opened}, still there 18 s later ${held}, url untouched ${bareStill}`,
)

const bar = await home.evaluate(() => ({
  text: document.getElementById('barTop')?.innerText.replace(/\n/g, ' ') ?? '',
  genShown: !!document.getElementById('genN')?.offsetParent,
  count: document.getElementById('worldCount')?.textContent ?? '',
  uptime: document.getElementById('uptime')?.textContent ?? '',
}))
check(
  '§69.14 the status line names the world count, not a generation',
  !bar.genShown && /^\d+ worlds$/.test(bar.count),
  `"${bar.count}" (gen slot hidden: ${!bar.genShown})`,
)
check(
  '§69.15 uptime comes from genesis, and is never a page-load counter',
  /^up (—|\d+[dhms])$/.test(bar.uptime) && bar.uptime !== 'up 0s',
  `"${bar.uptime}"`,
)

const below = await home.evaluate(() => ({
  premise: (document.getElementById('worldsPremise')?.innerText ?? '').trim().length,
  totals: document.getElementById('worldsTotals')?.innerText ?? '',
  ticker: document.querySelectorAll('#worldsTicker .e').length,
  credits: (document.getElementById('worldsCredits')?.innerText ?? '').toLowerCase(),
  emptyBelowFold: (() => {
    const b = document.getElementById('worldsBelow')?.getBoundingClientRect()
    return b ? b.height : 0
  })(),
}))
check(
  '§69.16 the half below the listing is filled',
  below.premise > 120 &&
    /events/.test(below.totals) &&
    /agents alive/.test(below.totals) &&
    below.ticker > 0 &&
    below.credits.includes('openstreetmap') &&
    below.credits.includes('simulated') &&
    below.emptyBelowFold > 200,
  `premise ${below.premise} chars, ${below.ticker} ticker rows, ${below.emptyBelowFold.toFixed(0)} px tall · ${below.totals.replace(/\n/g, ' · ')}`,
)

const canary = await home.evaluate(() => ({
  fault: window.civ.plate.batchFault,
  batch: window.civ.plate.batch,
}))
check(
  '§69.17 §68 canary: the batch is inside the fabric box and fills it',
  canary.fault === null && (canary.batch?.fills ?? 0) >= 0.6,
  canary.fault ?? `${canary.batch?.outside} m outside, fills ${((canary.batch?.fills ?? 0) * 100).toFixed(0)}%`,
)
await home.screenshot({ path: `${OUT}/earth.png` })
await home.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n§66/§67 acceptance: ${results.length - failed.length}/${results.length}`)
await writeFile(`${OUT}/acceptance.json`, JSON.stringify({ chunk: CHUNK, results }, null, 2))
await browser.close()
process.exit(failed.length ? 1 : 0)
