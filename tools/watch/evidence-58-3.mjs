/**
 * §58.3: a monument falling.
 *
 * Four frames at one fixed, settled, frozen camera. `settle()` lands the rig
 * and `freezeClock` pins the animation phase, which is what made the §56 diffs
 * mean anything — nothing moves between a pair except the thing under test.
 *
 *   a-before      the world as it stands, chrome up
 *   b-feed-row    the same, one monument down: the loudest line in the feed
 *   c-cinematic   ambient, one monument down: title card, ghost, push-in
 *   d-following   the rule §58.3 does NOT get to break — a viewer who is
 *                 following keeps their camera, however loud the world gets
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/58-3'
await mkdir(OUT, { recursive: true })

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', (e) => console.log('ERR', e.message))
await p.goto(
  'http://127.0.0.1:5173/?chunk=schiedam-havens&server=' +
    encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'),
  { waitUntil: 'domcontentloaded' },
)
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => {
  document.getElementById('watchBtn')?.click()
  window.civ.director.enabled = false
  window.civ.ui.home()
})
await p.waitForTimeout(14000)

/** the §56 discipline: land the rig, pin the clock, then capture */
async function pin() {
  await p.evaluate(() => {
    window.civ.rig.settle()
    window.civ.freezeClock(42)
  })
  await p.waitForTimeout(900)
}
const shot = (name) => p.screenshot({ path: `${OUT}/${name}.png` })
const cam = () =>
  p.evaluate(() => ({
    azimuth: +window.civ.rig.azimuth.toFixed(4),
    polar: +window.civ.rig.polar.toFixed(4),
    distance: Math.round(window.civ.rig.distance),
  }))

// -- A: the world as it stands, chrome up -----------------------------------
await pin()
const camA = await cam()
await shot('a-before')

// -- B: the loudest line the feed has ---------------------------------------
const queued = await p.evaluate(
  () => document.querySelector('#log .e.roll .t')?.textContent ?? 'empty',
)
// read the top row in the same task the event lands in — the pace interval
// inserts its own rows above afterwards, which is not a failure of this claim
const landedOnTop = await p.evaluate(() => {
  window.civ.monumentDemolition('the gasholder')
  return document.querySelector('#log .e:not(.roll):not(.count)')?.classList.contains('monument')
})
// §51.2's typing animation writes the line in over ~240 ms and runs on rAF,
// so under swiftshader it can still be mid-word at a fixed wait. Wait for the
// row to finish rather than sampling it and calling a half-typed line missing.
await p
  .waitForFunction(
    () => !document.querySelector('#log .e.monument .tx.typing'),
    null,
    { timeout: 8000 },
  )
  .catch(() => {})
const row = await p.evaluate(() => {
  const r = document.querySelector('#log .e.monument')
  return r ? { text: r.querySelector('.tx')?.textContent ?? '', cls: r.className } : null
})
await shot('b-feed-row')

// -- C: the director cut, in ambient -----------------------------------------
await p.evaluate(() => {
  document.body.classList.add('ambient')
  window.civ.ui.home()
})
await p.waitForTimeout(2600)
await pin()
const camC0 = await cam()
await p.evaluate(() => window.civ.monumentDemolition('the pumping station'))
await p.waitForTimeout(1400)
const state = await p.evaluate(() => ({
  card: document.getElementById('titleCard')?.classList.contains('on')
    ? document.getElementById('titleCardText')?.textContent
    : null,
  ghost: window.civ.ghost(),
}))
await pin()
const camC1 = await cam()
await shot('c-cinematic')

// -- D: the rule it must not break -------------------------------------------
await p.evaluate(() => {
  document.body.classList.remove('ambient')
  const first = [...window.civ.roster.values()][0]
  if (first) window.civ.follow(first.id)
})
await p.waitForTimeout(2600)
await pin()
const camD0 = await cam()
await p.evaluate(() => {
  document.body.classList.add('ambient')
  window.civ.monumentDemolition('the water tower')
})
await p.waitForTimeout(1500)
const camD1 = await cam()
const following = await p.evaluate(() => window.civ.followedId())
await shot('d-following')

console.log('§58.3 monument treatment')
console.log(
  `  feed row            ${row ? `"${row.text}"  [${row.cls}]` : 'MISSING'}`,
)
console.log(
  `  skipped the pace    ${landedOnTop ? 'yes — top row on arrival' : 'NO'} ` +
    `(queue held "${queued}" at the time)`,
)
console.log(`  title card          ${state.card ? `"${state.card}"` : 'MISSING'}`)
console.log(
  `  §40.1 ghost         ${state.ghost.held ? 'HELD' : 'not held'} / ${
    state.ghost.visible ? 'visible' : 'hidden'
  }`,
)
console.log(
  `  director push-in    d ${camC0.distance} -> ${camC1.distance} ` +
    `(${camC1.distance < camC0.distance ? 'IN' : 'OUT — expected IN'})`,
)
console.log(
  `  §40.4 exemption     following ${following ?? 'nobody'}; d ${camD0.distance} -> ${
    camD1.distance
  } — ${camD1.distance === camD0.distance ? 'CAMERA LEFT ALONE' : 'CAMERA STOLEN'}`,
)

await writeFile(
  `${OUT}/report.json`,
  JSON.stringify({ queued, landedOnTop, row, state, camA, camC0, camC1, camD0, camD1 }, null, 2),
)
await b.close()
