/**
 * §57.4: does `0` actually frame the whole plate, from any state?
 *
 * Projects the plate's four corners to screen and reports the fraction of the
 * frame they occupy and whether any falls outside it. A framing that crops is
 * a framing with a corner off-screen, which is a number, not an opinion.
 *
 *   node tools/watch/probe-framing.mjs [chunk]
 */
import { chromium } from 'playwright'
const CHUNK = process.argv[2] ?? 'schiedam-havens'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
async function check(page, label) {
  const r = await page.evaluate(() => {
    const THREE_V = window.civ.rig.camera
    // project() reads matrixWorldInverse, which three refreshes during render.
    // Measuring straight after settle() otherwise reads the PREVIOUS camera and
    // reports a framing the viewer never saw.
    THREE_V.updateMatrixWorld(true)
    const H = window.civ.halfExtent
    const gy = window.civ.groundY
    const pts = [[-H,-H],[H,-H],[H,H],[-H,H]]
    const out = []
    for (const [x, y] of pts) {
      const v = new (window.civ.Vector3)(x, gy, -y)
      v.project(THREE_V)
      out.push([(v.x + 1) / 2 * innerWidth, (1 - (v.y + 1) / 2) * innerHeight])
    }
    const xs = out.map(p => p[0]), ys = out.map(p => p[1])
    return {
      minx: Math.round(Math.min(...xs)), maxx: Math.round(Math.max(...xs)),
      miny: Math.round(Math.min(...ys)), maxy: Math.round(Math.max(...ys)),
      w: innerWidth, h: innerHeight, dist: Math.round(window.civ.rig.distance),
      maxDist: Math.round(window.civ.rig.limits.maxDistance),
    }
  })
  const insideX = r.minx >= 0 && r.maxx <= r.w
  const insideY = r.miny >= 0 && r.maxy <= r.h
  const fillX = ((r.maxx - r.minx) / r.w * 100).toFixed(0)
  const fillY = ((r.maxy - r.miny) / r.h * 100).toFixed(0)
  console.log(`${label.padEnd(26)} plate x[${r.minx},${r.maxx}] y[${r.miny},${r.maxy}] of ${r.w}x${r.h}` +
    `  fills ${fillX}%x${fillY}%  d=${r.dist}/${r.maxDist}  ${insideX && insideY ? 'WHOLE PLATE IN FRAME' : 'CROPPED'}`)
  return insideX && insideY
}
for (const vp of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  const page = await b.newPage({ viewport: vp })
  page.on('pageerror', e => console.log('ERR', e.message))
  await page.goto(`http://127.0.0.1:5173/?chunk=${CHUNK}&server=` + encodeURIComponent('ws://127.0.0.1:1'), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.evaluate(() => { document.getElementById('watchBtn')?.click(); window.civ.director.enabled = false })
  await page.waitForTimeout(2500)
  console.log(`\n--- viewport ${vp.width}x${vp.height} ---`)
  // 1: straight home
  await page.evaluate(() => window.civ.ui.home())
  await page.waitForTimeout(500); await page.evaluate(() => window.civ.rig.settle()); await page.waitForTimeout(350)
  await check(page, 'after 0 (from load)')
  // 2: from a street-level corner, then home
  await page.evaluate(() => window.civ.ui.street(120, { x: 200, y: -180, polar: 1.25, azimuth: 1.1 }))
  await page.waitForTimeout(400); await page.evaluate(() => window.civ.rig.settle()); await page.waitForTimeout(350)
  await check(page, 'at street framing')
  await page.evaluate(() => window.civ.ui.home())
  await page.waitForTimeout(500); await page.evaluate(() => window.civ.rig.settle()); await page.waitForTimeout(350)
  await check(page, 'after 0 (from street)')
  // 3: free zoom-out to the clamp
  await page.evaluate(() => { window.civ.rig.zoom(9000) })
  await page.waitForTimeout(400); await page.evaluate(() => window.civ.rig.settle()); await page.waitForTimeout(350)
  await check(page, 'at max zoom-out')
  await page.close()
}
await b.close()
