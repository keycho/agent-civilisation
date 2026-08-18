/**
 * §56.4 acceptance: the ambient drift clip.
 *
 * Twenty seconds of the world left alone — ambient on, director cutting
 * between its own intents, the §56.3 drift running underneath so the camera is
 * never quite still. Recorded through playwright's own video capture; there is
 * no ffmpeg on this machine and none is needed.
 *
 * Honest limitation: this renders under swiftshader (software GL), so the
 * clip's frame rate is a property of the capture box, not of the product. It
 * demonstrates the motion, not the smoothness.
 *
 *   node tools/watch/drift-clip.mjs <out-dir> [chunk] [seconds]
 */
import { chromium } from 'playwright'
import { mkdir, readdir, rename } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/56/drift'
const CHUNK = process.argv[3] ?? 'brooklyn-redhook'
const SECONDS = Number(process.argv[4] ?? 20)
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
})
const page = await context.newPage()
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(
  `http://127.0.0.1:5173/?chunk=${CHUNK}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.waitForTimeout(2600)
await page.evaluate(() => {
  document.getElementById('watchBtn')?.click()
  document.body.classList.add('ambient')
  window.civ.ui.home()
})
// the civilization has to be switched on, or the clip is an empty plate
await page.waitForTimeout(2600)
await page.evaluate(() => {
  const d = window.civ.buildings.data
  const o = window.civ.observer
  const hash = (i) => {
    const x = Math.sin(i * 12.9898) * 43758.5453
    return x - Math.floor(x)
  }
  const at = []
  for (let i = 0; i < d.count; i++) {
    const fp = o.footprintAt(i)
    if (!fp || !fp.length) {
      at.push(null)
      continue
    }
    let cx = 0
    let cy = 0
    for (const p of fp) {
      cx += p[0]
      cy += p[1]
    }
    at.push([cx / fp.length, cy / fp.length])
  }
  const xs = at.filter(Boolean).map((p) => p[0]).sort((a, b) => a - b)
  const ys = at.filter(Boolean).map((p) => p[1]).sort((a, b) => a - b)
  const xCut = xs[Math.floor(xs.length * 0.55)]
  const yCut = ys[Math.floor(ys.length * 0.45)]
  const span = (xs[xs.length - 1] - xs[0]) * 0.14
  for (let i = 0; i < d.count; i++) {
    const p = at[i]
    if (!p) continue
    const h = hash(i)
    const f = (h - 0.5) * span
    if (!(p[0] < xCut + f && p[1] > yCut + f) && h > 0.06) continue
    d.data[i * 4 + 1] = h < 0.18 ? 1 : h < 0.34 ? 2 : h < 0.46 ? 3 : 6
  }
  d.markDirty()
  window.civ.buildings.flush()
})
// let the relight pulses finish, then hand the camera to the director and roll
await page.waitForTimeout(7000)
await page.evaluate(() => {
  window.civ.director.enabled = true
})
const drift = []
const started = Date.now()
while (Date.now() - started < SECONDS * 1000) {
  await page.waitForTimeout(1000)
  drift.push(
    await page.evaluate(() => ({
      d: Math.round(window.civ.rig.distance),
      a: Number(window.civ.rig.azimuth.toFixed(4)),
      p: Number(window.civ.rig.polar.toFixed(4)),
      cam: [
        Math.round(window.civ.rig.camera.position.x),
        Math.round(window.civ.rig.camera.position.y),
        Math.round(window.civ.rig.camera.position.z),
      ],
    })),
  )
}
await page.close()
await context.close()
await browser.close()

// name the file for what it is
const files = await readdir(OUT)
const webm = files.filter((f) => f.endsWith('.webm') && !f.startsWith(CHUNK))
for (const f of webm) await rename(`${OUT}/${f}`, `${OUT}/${CHUNK}-drift-${SECONDS}s.webm`)

/**
 * The proof that the clip is not a still: the rig's own state barely moves
 * between director cuts, while the CAMERA POSITION does. That gap is the
 * drift, which lives at placement time by design.
 */
console.log(`${OUT}/${CHUNK}-drift-${SECONDS}s.webm`)
console.log('per-second camera position (drift is the movement with a stable rig state):')
for (const s of drift) {
  console.log(`  d=${s.d} az=${s.a} pol=${s.p} cam=[${s.cam.join(', ')}]`)
}
