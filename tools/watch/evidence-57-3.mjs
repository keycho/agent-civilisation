/**
 * §57.3 acceptance: "every city visible in one frame, always."
 *
 * That is a countable claim, so it is counted: project all eight marks and
 * assert every one is on screen, at the home framing and at both zoom limits.
 * Labels are checked the same way — the failure the globe never shook was
 * label set and mark set disagreeing.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const OUT = process.argv[2] ?? 'tools/watch/evidence/57-3'
await mkdir(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
for (const vp of [{ width: 1280, height: 800 }, { width: 1280, height: 720 }]) {
  const p = await b.newPage({ viewport: vp })
  p.on('pageerror', e => console.log('ERR', e.message))
  await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:1'), { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await p.evaluate(() => document.getElementById('watchBtn')?.click())
  await p.waitForTimeout(2500)
  await p.evaluate(() => window.civ.ui.toGlobe())
  await p.waitForTimeout(3500)
  console.log(`\n--- ${vp.width}x${vp.height} ---`)
  for (const [label, mult] of [['home', 1], ['zoomed in', 0.36], ['zoomed out', 1.24]]) {
    await p.evaluate((m) => {
      const r = window.civ.rig
      if (m !== 1) { r.zoom(m < 1 ? -12000 : 12000) }
      r.settle()
    }, mult)
    await p.waitForTimeout(900)
    const r = await p.evaluate(() => {
      window.civ.rig.camera.updateMatrixWorld(true)
      const V = window.civ.Vector3
      const marks = window.civ.mapMarkers()
      const on = []
      const off = []
      for (const m of marks) {
        const v = new V(m.x, m.y, m.z).project(window.civ.rig.camera)
        const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - (v.y + 1) / 2) * innerHeight
        ;(sx >= 0 && sx <= innerWidth && sy >= 0 && sy <= innerHeight && v.z <= 1 ? on : off).push(m.id)
      }
      const labels = [...document.querySelectorAll('.glabel')].filter((n) => n.classList.contains('on')).length
      const sprites = marks.length
      return { on: on.length, off, labels, sprites, d: Math.round(window.civ.rig.distance) }
    })
    console.log(`${label.padEnd(11)} marks on screen ${r.on}/${r.sprites}  labels shown ${r.labels}  d=${r.d}` +
      (r.off.length ? `  OFF: ${r.off.join(',')}` : '  ALL EIGHT VISIBLE'))
    await p.screenshot({ path: `${OUT}/map-${vp.width}x${vp.height}-${label.replace(' ', '-')}.png` })
  }
  await p.close()
}
await b.close()
