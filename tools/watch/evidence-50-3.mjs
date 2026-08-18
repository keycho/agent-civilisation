/**
 * §50.3 a/b: emissive windows, at a fixed camera on a dead server.
 *
 * Windows are driven by ownership, and at day 0 nothing is owned — so the rig
 * writes a *deterministic* ownership pattern into the client's own data
 * texture (a hash over the slot index, same every run, no server involved).
 * That keeps the a/b honest: identical plate, identical camera, identical
 * ownership, the only variable being the shader under test.
 *
 * Frames:
 *   a-unowned       nothing owned — the whole plate must be dark
 *   b-owned         the authored ownership pattern at the city's own hour
 *   c-night-check   the same, with night forced up: a mechanism check, not an
 *                   art-direction claim (the authored night lands in §50.2)
 *   d-working       a site mid-construction: work lights, no window grid
 *   e-relight       a conversion pulse caught mid-climb, floor by floor
 *
 *   node tools/watch/evidence-50-3.mjs <out-dir> [chunk]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/50-3'
const CHUNK = process.argv[3] ?? 'schiedam-havens'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
page.on('console', (m) => {
  const t = m.text()
  if (/shader|GLSL|WebGL|program/i.test(t)) console.log('CONSOLE:', t.slice(0, 400))
})
await page.goto(
  `http://127.0.0.1:5173/?chunk=${CHUNK}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.waitForTimeout(3000)

// one fixed camera for every frame in the set: closer than the plate framing
// so the window grid is at the scale a viewer actually reads it at
await page.evaluate(() => {
  document.getElementById('watchBtn')?.click()
  document.body.classList.add('ambient')
  window.civ.director.enabled = false
  window.civ.rig.flyTo(new (window.civ.rig.target.constructor)(0, window.civ.rig.target.y, 0), 520, {
    azimuth: 0.35,
    polar: 0.95,
    duration: 0.01,
  })
})
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/a-unowned.png` })

// deterministic ownership: a stable hash over the slot index, so the pattern
// is identical on every run and between a and b
const owned = await page.evaluate(() => {
  const d = window.civ.buildings.data
  const hash = (i) => {
    const x = Math.sin(i * 12.9898) * 43758.5453
    return x - Math.floor(x)
  }
  let n = 0
  for (let i = 0; i < d.count; i++) {
    const h = hash(i)
    // a coherent district rather than confetti: the western half is where the
    // agents went, plus a scatter elsewhere
    const inDistrict = h < 0.55
    if (!inDistrict) continue
    d.data[i * 4 + 1] = h < 0.18 ? 1 : h < 0.34 ? 2 : h < 0.46 ? 3 : 6
    n++
  }
  d.markDirty()
  window.civ.buildings.flush()
  return { n, count: d.count }
})
console.log('ownership written:', JSON.stringify(owned))
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/b-owned.png` })

// mechanism check: force the night weight up so the grid is unambiguous
await page.evaluate(() => window.civ.buildings.setNight(0.85, '#ffc27a'))
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/c-night-check.png` })

// work lights: put a band of buildings mid-construction
await page.evaluate(() => {
  const d = window.civ.buildings.data
  for (let i = 0; i < d.count; i += 7) d.data[i * 4] = Math.round(0.5 * 255)
  d.markDirty()
  window.civ.buildings.flush()
})
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/d-working.png` })

// relight: drive the client's own conversion pulse and catch it mid-climb
const pulse = await page.evaluate(() => {
  const d = window.civ.buildings.data
  for (let i = 0; i < d.count; i++) {
    d.data[i * 4] = 255 // everything standing again
    if (d.data[i * 4 + 1] >= 1) d.relight(i)
  }
  d.markDirty()
  window.civ.buildings.flush()
  return d.pulseData.filter((_, i) => i % 4 === 0).reduce((n, v) => n + (v > 0 ? 1 : 0), 0)
})
console.log('relighting slots:', pulse)
await page.waitForTimeout(950)
const midClimb = await page.evaluate(() => {
  const d = window.civ.buildings.data
  let max = 0
  for (let i = 0; i < d.count; i++) max = Math.max(max, d.pulseData[i * 4])
  return max
})
console.log('pulse still climbing (0-255):', midClimb)
await page.screenshot({ path: `${OUT}/e-relight.png` })

console.log(`§50.3 evidence -> ${OUT}`)
await browser.close()
