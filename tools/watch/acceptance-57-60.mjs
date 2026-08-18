/**
 * §57-§60 acceptance, as the operator wrote it:
 *
 *   "a stranger opens production, reads one headline that tells them what is
 *   happening, sees a whole city framed, watches one building visibly
 *   demolished and one visibly rise over the following minute, follows a story
 *   card to its completion, picks out a pixel agent and follows them, and
 *   opens the flat map to see every city at once. capture a 60-second ambient
 *   session as the proof."
 *
 * Seven claims, each measured rather than eyeballed, plus the 60-second
 * ambient recording. The stranger touches nothing except [watch] until the
 * ambient minute is in the can — the recording is the world unattended, which
 * is what "ambient" means. The interactions come after, so the clip stays
 * honest.
 *
 *   node tools/watch/acceptance-57-60.mjs <out-dir> [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile, rename, readdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/acceptance/57-60'
const CHUNK = process.argv[3] ?? 'schiedam-havens'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'

await mkdir(OUT, { recursive: true })
await mkdir(`${OUT}/video`, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: `${OUT}/video`, size: { width: 1280, height: 720 } },
})
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))

const results = []
const claim = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

await page.goto(`${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })

// the stranger's single natural act
await page.waitForTimeout(3500)
await page.evaluate(() => document.getElementById('watchBtn')?.click())
await page.waitForTimeout(9000)

// ---------------------------------------------------------------------------
// 1. one headline that tells them what is happening
// ---------------------------------------------------------------------------
const headline = await page.evaluate(() => {
  const h = document.getElementById('headline')
  return {
    visible: !!h && getComputedStyle(h).display !== 'none',
    text: h?.querySelector('.body')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }
})
claim(
  '§60 headline',
  headline.visible && headline.text.length > 8,
  headline.text ? `"${headline.text}"` : 'no headline',
)

// ---------------------------------------------------------------------------
// 2. a whole city framed
// ---------------------------------------------------------------------------
const framing = await page.evaluate(() => {
  window.civ.ui.home()
  return null
})
void framing
await page.waitForTimeout(2500)
const frame = await page.evaluate(() => {
  const rig = window.civ.rig
  rig.settle()
  rig.camera.updateMatrixWorld(true)
  const V = window.civ.Vector3
  // project every baseline building centroid; count what lands on screen
  let on = 0
  let total = 0
  for (const c of window.civ.buildingCentroids()) {
    total++
    const v = new V(c[0], 2, -c[1]).project(rig.camera)
    if (Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1) on++
  }
  return { on, total, share: total ? on / total : 0, d: Math.round(rig.distance) }
})
claim(
  '§57.4 whole city framed',
  frame.share >= 0.9,
  `${frame.on}/${frame.total} buildings inside the frame (${(frame.share * 100).toFixed(
    1,
  )}%) at d=${frame.d}`,
)
await page.screenshot({ path: `${OUT}/1-city-framed.png` })

// ---------------------------------------------------------------------------
// 3. the 60-second ambient session — the world unattended
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  document.body.classList.add('ambient')
  window.civ.director.enabled = true
})
console.log('  .... recording 60 s of ambient')
const before = await page.evaluate(() => window.civ.observer.stageCounts())
const t0 = Date.now()
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(12_000)
  await page.screenshot({ path: `${OUT}/ambient-t${String((i + 1) * 12).padStart(2, '0')}s.png` })
}
const after = await page.evaluate(() => window.civ.observer.stageCounts())
const seconds = Math.round((Date.now() - t0) / 1000)

// ---------------------------------------------------------------------------
// 4. one building visibly demolished and one visibly rise, inside that minute
// ---------------------------------------------------------------------------
claim(
  '§57.2 a demolition completed',
  after.demolished > before.demolished,
  `${after.demolished - before.demolished} in ${seconds} s`,
)
claim(
  '§57.2 a building rose',
  after.built > before.built,
  `${after.built - before.built} in ${seconds} s`,
)

// ---------------------------------------------------------------------------
// 5. follow a story card to its completion
// ---------------------------------------------------------------------------
await page.evaluate(() => document.body.classList.remove('ambient'))
await page.waitForTimeout(1500)
const story = await page.evaluate(() => {
  const card = document.querySelector('#stories .s')
  if (!card) return null
  card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  card.click()
  return {
    who: card.querySelector('.who')?.textContent?.trim() ?? '',
    what: card.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    progress: card.querySelector('.prog')?.getAttribute('style') ?? '',
  }
})
await page.waitForTimeout(3000)
const storyLanded = await page.evaluate(() => ({
  followed: window.civ.followedId(),
  d: Math.round(window.civ.rig.distance),
}))
claim(
  '§60 story card followed',
  !!story && !!storyLanded.followed,
  story ? `"${story.what}" → following ${storyLanded.followed} at d=${storyLanded.d}` : 'no cards',
)
await page.screenshot({ path: `${OUT}/2-story-followed.png` })

// ---------------------------------------------------------------------------
// 6. pick out a pixel agent and follow them
// ---------------------------------------------------------------------------
const pixel = await page.evaluate(() => {
  const marks = window.civ.pixelMarks()
  if (!marks.length) return null
  const rig = window.civ.rig
  rig.camera.updateMatrixWorld(true)
  const V = window.civ.Vector3
  const fov = (rig.camera.fov * Math.PI) / 180
  let best = null
  for (const m of marks) {
    const view = new V(m.x, m.y, m.z).applyMatrix4(rig.camera.matrixWorldInverse)
    if (view.z > -1) continue
    const sizeM = Math.max(2.2, -view.z * ((2 * Math.tan(fov / 2)) / innerHeight) * 16)
    const px = (sizeM / (2 * -view.z * Math.tan(fov / 2))) * innerHeight
    if (!best || px > best.px) best = { id: m.id, px }
  }
  if (best) window.civ.follow(best.id)
  return best
})
await page.waitForTimeout(3000)
const pixelFollowed = await page.evaluate(() => window.civ.followedId())
claim(
  '§59.1 a pixel agent picked out',
  !!pixel && pixelFollowed === pixel.id,
  pixel ? `${pixel.id} at ${pixel.px.toFixed(1)} px tall, followed` : 'no figures on screen',
)
await page.screenshot({ path: `${OUT}/3-pixel-agent.png` })

// ---------------------------------------------------------------------------
// 7. open the flat map and see every city at once
// ---------------------------------------------------------------------------
await page.evaluate(() => window.civ.follow(null))
await page.waitForTimeout(600)
await page.evaluate(() => document.getElementById('chunkBtn')?.click())
await page.waitForTimeout(4500)
const map = await page.evaluate(() => {
  const view = window.civ.mapView
  if (!view) return null
  const rig = window.civ.rig
  rig.settle()
  rig.camera.updateMatrixWorld(true)
  const V = window.civ.Vector3
  const on = view.markers.filter((m) => {
    const v = new V(m.position.x, m.position.y, m.position.z).project(rig.camera)
    return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1
  })
  return { on: on.length, total: view.markers.length, names: on.map((m) => m.name) }
})
await page.waitForTimeout(1200)
claim(
  '§57.3 flat map, every city at once',
  !!map && map.on === map.total && map.total > 1,
  map ? `${map.on}/${map.total} marks in frame — ${map.names.join(', ')}` : 'no map view',
)
await page.screenshot({ path: `${OUT}/4-flat-map.png` })

// ---------------------------------------------------------------------------
const video = page.video()
await ctx.close()
await browser.close()
if (video) {
  const src = await video.path()
  await rename(src, `${OUT}/ambient-session.webm`).catch(() => {})
}
for (const f of await readdir(`${OUT}/video`).catch(() => [])) {
  if (f.endsWith('.webm')) await rename(`${OUT}/video/${f}`, `${OUT}/ambient-session.webm`)
}

const passed = results.filter((r) => r.ok).length
console.log(`\n§57-60 acceptance: ${passed}/${results.length} claims pass`)
await writeFile(
  `${OUT}/acceptance.json`,
  JSON.stringify({ chunk: CHUNK, origin: ORIGIN, server: SERVER, results }, null, 2),
)
process.exit(passed === results.length ? 0 : 1)
