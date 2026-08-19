/**
 * §69.3 a/b: does cleared ground read as cleared?
 *
 * Same camera, same instant, the layer off and on. §48's rule — a pair that
 * differs by one step and nothing else, or the pair proves nothing.
 *
 *   node tools/watch/evidence-69-3.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const CHUNK = process.argv[2] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/69'
await mkdir(OUT, { recursive: true })
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', (e) => console.log('PAGEERR:', e.message))
await p.goto(`http://127.0.0.1:5173/?chunk=${CHUNK}&server=${encodeURIComponent(`ws://127.0.0.1:8820/ws/${CHUNK}`)}`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 90000 })
await p.waitForTimeout(22000)
// chrome off and the camera pinned, so the pair differs by the layer alone
await p.evaluate(() => {
  window.civ.director.enabled = false
  document.querySelectorAll('.pane, .bar, #cards').forEach((e) => { e.style.display = 'none' })
  window.civ.ui.street(420, { polar: 0.78, azimuth: 0.5 })
  window.civ.freezeClock?.(1200)
})
await p.waitForTimeout(2500)
await p.evaluate(() => window.civ.rig.settle())
for (const on of [false, true]) {
  await p.evaluate((v) => {
    const g = window.civ.cityRoot.children.find((c) => c.name === 'clearedGround')
    if (g) g.visible = v
  }, on)
  await p.waitForTimeout(900)
  await p.screenshot({ path: `${OUT}/${on ? 'b-cleared-on' : 'a-cleared-off'}.png` })
}
const n = await p.evaluate(() => {
  const g = window.civ.cityRoot.children.find((c) => c.name === 'clearedGround')
  let rubble = 0
  g?.traverse((o) => { if (o.isInstancedMesh) rubble = o.count })
  return rubble
})
console.log(`§69.3 a/b written to ${OUT}/ — ${n} rubble instances over the cleared lots`)
await b.close()
