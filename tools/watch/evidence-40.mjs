/**
 * §40 evidence: the spectacle set.
 *
 *   a-ghost-off / b-ghost-on   the reality ghost, held on `b`, at one camera
 *   c-timelapse-early/late     the replay walking the log, with its cards
 *   d-end-card                 the end card before it rejoins live
 *   e-cinematic                a milestone title card over a pullback
 *
 * The ghost runs on the dead server (it is baseline geometry, so day 0 is the
 * honest case and the a/b is reproducible). Timelapse and cinematics need a
 * history to replay and events to fire, so they run against the live local
 * supervisor and report what they observed rather than being judged by eye.
 *
 *   node tools/watch/evidence-40.mjs <out-dir> [ws-url]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/40'
const WS = process.argv[3] ?? 'ws://127.0.0.1:8820/ws/schiedam-havens'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

// ---------------------------------------------------------------------------
// §40.1 the ghost — dead server, one fixed camera, held vs released
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION (ghost)', e.message))
  await page.goto(
    `http://127.0.0.1:5173/?chunk=schiedam-havens&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2600)
  await page.evaluate(() => {
    document.getElementById('watchBtn')?.click()
    document.body.classList.add('ambient')
    window.civ.director.enabled = false
    const { rig } = window.civ
    const V = rig.target.constructor
    rig.flyTo(new V(0, rig.target.y, 0), 460, { azimuth: 0.3, polar: 1.05, duration: 0.01 })
    for (let i = 0; i < 60; i++) rig.update(0.2)
  })
  await page.waitForTimeout(2200)
  await page.screenshot({ path: `${OUT}/a-ghost-off.png` })

  // hold b: a real keydown, and the fade has to be given its 340ms
  await page.keyboard.down('b')
  await page.waitForTimeout(2400)
  const ghostState = await page.evaluate(() => window.civ.ghost())
  console.log('ghost held:', JSON.stringify(ghostState))
  await page.screenshot({ path: `${OUT}/b-ghost-on.png` })
  await page.keyboard.up('b')
  await page.waitForTimeout(6000)
  const released = await page.evaluate(() => window.civ.ghost())
  console.log('ghost released:', JSON.stringify(released))
  await page.close()
}

// ---------------------------------------------------------------------------
// §40.2/§40.4/§40.5 — live world
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION (live)', e.message))
  await page.goto(`http://127.0.0.1:5173/?chunk=schiedam-havens&server=${encodeURIComponent(WS)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.evaluate(() => document.getElementById('watchBtn')?.click())
  await page.waitForTimeout(6000)

  // the sound toggle is a real user gesture, which is what WebAudio requires
  const sound = await page.evaluate(() => {
    document.getElementById('soundBtn').click()
    return {
      pressed: document.getElementById('soundBtn').getAttribute('aria-pressed'),
      label: document.getElementById('soundBtn').textContent,
    }
  })
  console.log('sound toggle:', JSON.stringify(sound))

  // §40.2: run the timelapse and watch the scrub walk
  const before = await page.evaluate(() => ({
    events: window.civ.readouts?.eventCount ?? 0,
    scrub: document.getElementById('scrubOut').value,
  }))
  await page.keyboard.press('t')
  await page.waitForTimeout(2500)
  const early = await page.evaluate(() => ({
    card: document.getElementById('titleCard').classList.contains('on'),
    text: document.getElementById('titleCardText').textContent,
    scrub: document.getElementById('scrubOut').value,
    running: window.civ.timelapseRunning(),
    retained: window.civ.retainedOrdinals(),
  }))
  console.log('timelapse start:', JSON.stringify({ before, early }))
  await page.screenshot({ path: `${OUT}/c-timelapse-early.png` })

  await page.waitForTimeout(9000)
  const mid = await page.evaluate(() => ({
    scrub: document.getElementById('scrubOut').value,
    running: window.civ.timelapseRunning(),
  }))
  console.log('timelapse mid:', JSON.stringify(mid))
  await page.screenshot({ path: `${OUT}/c-timelapse-late.png` })

  // the end card lands when the walk finishes and holds for a few seconds
  // before the scrub's own exit rejoins live, so poll for it rather than
  // guessing a wait that a slow harness will miss on either side
  let end = null
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500)
    const c = await page.evaluate(() => ({
      card: document.getElementById('titleCard')?.classList.contains('on') ?? false,
      text: document.getElementById('titleCardText')?.textContent ?? '',
      running: window.civ?.timelapseRunning?.() ?? null,
    })).catch(() => null)
    if (c?.card && c.text.includes('diverged')) {
      end = c
      await page.screenshot({ path: `${OUT}/d-end-card.png` })
      break
    }
  }
  console.log('timelapse end:', JSON.stringify(end))
  await page.close()
}

// ---------------------------------------------------------------------------
// §40.4 the cinematic — ambient, untouched, waiting for a high-weight event
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION (cinematic)', e.message))
  await page.goto(`http://127.0.0.1:5173/?chunk=schiedam-havens&server=${encodeURIComponent(WS)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.evaluate(() => document.getElementById('watchBtn')?.click())
  await page.waitForTimeout(1200)
  await page.keyboard.press('a') // ambient: the only mode a cinematic may interrupt
  let fired = null
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500)
    const c = await page.evaluate(() => ({
      on: document.getElementById('titleCard').classList.contains('on'),
      text: document.getElementById('titleCardText').textContent,
    }))
    if (c.on && c.text) {
      fired = c
      break
    }
  }
  console.log('cinematic:', JSON.stringify(fired))
  await page.screenshot({ path: `${OUT}/e-cinematic.png` })
  await page.close()
}

await browser.close()
console.log(`§40 evidence -> ${OUT}`)
