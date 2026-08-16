/**
 * §23.6: watch a season, from a fixed camera, and write down what it looked
 * like.
 *
 * Four builds of instrumentation and nothing judged by looking. This is not a
 * test — there is nothing to assert. It parks a browser in front of a running
 * world at one camera position, takes the same frame repeatedly as the season
 * progresses, and captures what the feed said, so the questions §23.6 asks can
 * be answered from evidence rather than from the index.
 *
 *   node tools/watch/season.mjs <ws-url> <http-url> <out-dir> [minutes] [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const WS = process.argv[2] ?? 'ws://127.0.0.1:8790'
const HTTP = process.argv[3] ?? 'http://127.0.0.1:8790'
const OUT = process.argv[4] ?? 'tools/watch/out'
const MINUTES = Number(process.argv[5] ?? 12)
const CHUNK = process.argv[6] ? `&chunk=${process.argv[6]}` : ''

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-gpu-sandbox',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))

await page.goto(`http://127.0.0.1:5173/?server=${encodeURIComponent(WS)}${CHUNK}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ?.readouts != null, null, { timeout: 120000 })
// the watch is the frame, not the onboarding: dismiss the §36.3 card if shown
await page.waitForTimeout(2600)
await page.evaluate(() => document.getElementById('watchBtn')?.click())

/** One fixed frame, so two shots of it are comparable. §8's "same viewpoint". */
async function park() {
  await page.evaluate(() => {
    window.civ.director.enabled = false
    window.civ.director.takeControl()
    const r = window.civ.rig
    r.desiredTarget.set(0, 0, 0)
    r.desiredDistance = r.limits.maxDistance * 0.82
    // §35.6: the fixed watch uses the framed orientation. Both the live and
    // the desired angles, or the damper walks the park away.
    r.polar = r.desiredPolar = 0.62
    r.azimuth = r.desiredAzimuth = 0
  })
  await page.waitForTimeout(2500)
}
await park()

const log = []
const started = Date.now()
let shot = 0
let lastSeason = null

while ((Date.now() - started) / 60000 < MINUTES) {
  await park()
  const r = await page.evaluate(() => ({
    ...window.civ.readouts,
    roster: window.civ.roster.size,
    names: [...window.civ.roster.values()].slice(0, 60).map((a) => `${a.name}|g${a.generation}`),
  }))
  const feed = await page.$$eval('#feedList .e', (rows) =>
    rows.map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
  )
  const health = await fetch(`${HTTP}/health`).then((x) => x.json()).catch(() => null)

  const label = String(shot).padStart(2, '0')
  await page.screenshot({ path: `${OUT}/${label}-normal.png` })
  // §16.4: and the same frame in divergence, which is the mode that carries
  // the thesis
  await page.evaluate(() => window.civ.setMode(1))
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${label}-divergence.png` })
  await page.evaluate(() => window.civ.setMode(0))

  const entry = {
    shot: label,
    elapsedS: Math.round((Date.now() - started) / 1000),
    season: r.season,
    index: +(r.divergenceIndex * 100).toFixed(1),
    generation: r.generation,
    agentOrigin: r.agentOrigin,
    demolished: r.demolished,
    decisions: r.decisions,
    roster: r.roster,
    seasonTurned: lastSeason !== null && r.season !== lastSeason,
    feed,
    names: r.names,
    slotPressureFromHealth: health?.slotPressure,
  }
  log.push(entry)
  console.log(
    `${label}  season ${r.season}  index ${entry.index}%  gen ${r.generation}  ` +
      `built ${r.agentOrigin}  cleared ${r.demolished}  feed ${feed.length}` +
      (entry.seasonTurned ? '   <-- SEASON TURNED' : ''),
  )
  lastSeason = r.season
  shot++
  await page.waitForTimeout(20000)
}

await writeFile(`${OUT}/log.json`, JSON.stringify(log, null, 2))
console.log(`\n${shot} frames -> ${OUT}`)
await browser.close()
