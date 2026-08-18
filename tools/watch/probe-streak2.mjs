import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => { document.getElementById('watchBtn')?.click(); window.civ.director.enabled = false; window.civ.ui.home() })
await p.waitForTimeout(25000)
const r = await p.evaluate(() => {
  const out = []
  for (const y of [205, 250, 292, 337]) {
    const el = document.elementFromPoint(200, y)
    const stack = []
    let e = el
    while (e && stack.length < 4) { stack.push(`${e.tagName}#${e.id || ''}.${e.className || ''}`); e = e.parentElement }
    out.push({ y, stack })
  }
  // also list every DOM element whose box is wide and short in that band
  const wide = []
  document.querySelectorAll('*').forEach((n) => {
    const r = n.getBoundingClientRect()
    if (r.width > 200 && r.height > 4 && r.height < 40 && r.top > 180 && r.top < 360 && r.left < 300)
      wide.push(`${n.tagName}#${n.id || ''}.${typeof n.className === 'string' ? n.className : ''} @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`)
  })
  return { out, wide }
})
console.log(JSON.stringify(r, null, 1))
await b.close()
