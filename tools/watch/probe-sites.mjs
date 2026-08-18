/** §57: how big are the sites agents are actually building on? */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.waitForTimeout(40000)
const r = await p.evaluate(() => {
  const out = []
  for (const s of window.civ.observer.sites()) {
    const fp = s.footprint
    if (!fp || fp.length < 3) continue
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, A = 0
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], c = fp[(i + 1) % fp.length]
      minx = Math.min(minx, a[0]); maxx = Math.max(maxx, a[0])
      miny = Math.min(miny, a[1]); maxy = Math.max(maxy, a[1])
      A += a[0] * c[1] - c[0] * a[1]
    }
    out.push({ w: Math.round(maxx - minx), h: Math.round(maxy - miny), area: Math.round(Math.abs(A) / 2) })
  }
  return out
})
const span = r.map(x => Math.max(x.w, x.h)).sort((a, b) => a - b)
console.log('active sites:', r.length)
if (span.length) {
  console.log('longest dimension m — min', span[0], 'median', span[Math.floor(span.length/2)], 'max', span[span.length-1])
  console.log('over 100m:', span.filter(x=>x>100).length, ' over 250m:', span.filter(x=>x>250).length)
  console.log('worst 5:', r.slice().sort((a,b)=>Math.max(b.w,b.h)-Math.max(a.w,a.h)).slice(0,5).map(x=>`${x.w}x${x.h}m area ${x.area}`).join(' | '))
}
await b.close()
