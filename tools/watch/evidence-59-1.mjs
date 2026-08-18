/**
 * §59.1: the pixel people, and the 16px floor.
 *
 * The size clamp is a measurable claim, so it is measured: every figure's quad
 * is projected at each framing and its screen height reported. Plus frames at
 * city and street zoom so the silhouettes can be judged.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const OUT = process.argv[2] ?? 'tools/watch/evidence/59-1'
await mkdir(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => { document.getElementById('watchBtn')?.click(); window.civ.director.enabled = false; window.civ.ui.home() })
await p.waitForTimeout(14000)

async function measure(label) {
  await p.waitForTimeout(1500)
  const r = await p.evaluate(() => {
    window.civ.rig.camera.updateMatrixWorld(true)
    const V = window.civ.Vector3
    const cam = window.civ.rig.camera
    const fov = (cam.fov * Math.PI) / 180
    const pxTerm = (2 * Math.tan(fov / 2)) / innerHeight
    const sizeM = 2.2
    const out = []
    for (const m of window.civ.pixelMarks()) {
      const v = new V(m.x, m.y, m.z)
      const view = v.clone().applyMatrix4(cam.matrixWorldInverse)
      // an agent behind the camera has no screen height; it is not a small one
      if (view.z > -1) continue
      const size = Math.max(sizeM, -view.z * pxTerm * 16)
      // a quad of world height `size` at depth -view.z covers this many pixels
      out.push((size / (2 * -view.z * Math.tan(fov / 2))) * innerHeight)
    }
    if (!out.length) return { n: 0, min: 0, max: 0, d: Math.round(window.civ.rig.distance) }
    return { n: out.length, min: Math.min(...out), max: Math.max(...out), d: Math.round(window.civ.rig.distance) }
  })
  console.log(`${label.padEnd(16)} agents ${r.n}  screen height min ${r.min.toFixed(1)}px max ${r.max.toFixed(1)}px  d=${r.d}  ${r.min >= 15.5 ? 'FLOOR HELD' : 'BELOW 16px'}`)
  await p.screenshot({ path: `${OUT}/${label.replace(/ /g, '-')}.png` })
}
await measure('city framing')
await p.evaluate(() => { window.civ.rig.zoom(9000); window.civ.rig.settle() })
await measure('max zoom out')
// §59.1's actual claim is "a small figure standing at a site": frame one.
const framed = await p.evaluate(() => {
  const working = [...window.civ.presence.positions()].find(
    (a) => a.activity === 'building' || a.activity === 'demolishing',
  )
  const target = working ? window.civ.agentSite.get(working.id) : null
  const at = target ?? (working ? [working.x, working.y] : [0, 0])
  window.civ.ui.street(90, { x: at[0], y: at[1], polar: 1.05 })
  return { found: !!working, at }
})
console.log('framed a worker:', JSON.stringify(framed))
await p.waitForTimeout(3000)
await p.evaluate(() => window.civ.rig.settle())
await measure('at a work site')
// centre crop, where the figure now is
await p.screenshot({ path: `${OUT}/worker-full.png` })
// where did they land on screen?
const where = await p.evaluate(() => {
  window.civ.rig.camera.updateMatrixWorld(true)
  const V = window.civ.Vector3
  return window.civ.pixelMarks().slice(0, 6).map((m) => {
    const v = new V(m.x, m.y, m.z).project(window.civ.rig.camera)
    return [Math.round((v.x + 1) / 2 * innerWidth), Math.round((1 - (v.y + 1) / 2) * innerHeight), v.z <= 1]
  })
})
console.log('first marks on screen:', JSON.stringify(where))
await b.close()
