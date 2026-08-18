/** §57: which object draws the bars across the plate? Hide each, measure. */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => { document.getElementById('watchBtn')?.click(); window.civ.director.enabled = false; window.civ.ui.home() })
await p.waitForTimeout(20000)
await p.evaluate(() => { window.civ.freezeClock(120); window.civ.rig.settle() })
await p.waitForTimeout(1500)

const list = await p.evaluate(() => {
  const out = []
  window.civ.cityRoot.traverse((o) => {
    if (!o.visible || !o.geometry) return
    const c = o.geometry.getAttribute?.('position')?.count ?? 0
    out.push({ uuid: o.uuid, type: o.type, mat: o.material?.type ?? '?', verts: c, order: o.renderOrder })
  })
  return out
})
await p.screenshot({ path: 'tools/watch/evidence/60/streak-all.png' })
await p.evaluate(() => {
  window.civ.cityRoot.traverse((o) => {
    if (o.type === 'LineSegments') {
      const pos = o.geometry.getAttribute('position')
      let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9,minz=1e9,maxz=-1e9
      for (let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i)
        minx=Math.min(minx,x);maxx=Math.max(maxx,x);miny=Math.min(miny,y);maxy=Math.max(maxy,y);minz=Math.min(minz,z);maxz=Math.max(maxz,z)}
      window.__box = {count: pos.count, x:[Math.round(minx),Math.round(maxx)], y:[Math.round(miny),Math.round(maxy)], z:[Math.round(minz),Math.round(maxz)]}
    }
  })
})
await p.waitForTimeout(1200)
await p.screenshot({ path: 'tools/watch/evidence/60/streak-no-linesegs.png' })
console.log('linesegs extent:', JSON.stringify(await p.evaluate(() => window.__box)))
await b.close()
