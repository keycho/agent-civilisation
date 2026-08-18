import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.waitForTimeout(14000)
const r = await p.evaluate(() => {
  const out = []
  for (const a of window.civ.presence.positions()) {
    if (a.activity !== 'building' && a.activity !== 'demolishing') continue
    const s = window.civ.agentSite.get(a.id)
    out.push({ act: a.activity, d: s ? Math.round(Math.hypot(a.x - s[0], a.y - s[1])) : null })
  }
  return out
})
const d = r.filter(x => x.d !== null).map(x => x.d).sort((a,b)=>a-b)
console.log('working agents:', r.length, 'with a known site:', d.length)
if (d.length) console.log('tether length m — min', d[0], 'median', d[Math.floor(d.length/2)], 'max', d[d.length-1], '| >50m:', d.filter(x=>x>50).length, '>200m:', d.filter(x=>x>200).length)
await b.close()
