/**
 * §57.2: does a construction take its wall-clock floor ON SCREEN?
 *
 * Samples the visual progress channel of every transitioning slot and reports
 * how long each one takes to cross the stages. The sim's own duration is
 * irrelevant here — the claim is about the picture.
 */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 900, height: 600 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:8820/ws/schiedam-havens'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => { document.getElementById('watchBtn')?.click(); window.civ.director.enabled = false })
await p.waitForTimeout(4000)
await p.evaluate(() => {
  window.__track = new Map()
  window.__done = []
  setInterval(() => {
    const d = window.civ.buildings.data
    const t = performance.now()
    for (let i = 0; i < d.count; i++) {
      const v = d.data[i * 4] / 255
      const prev = window.__track.get(i)
      if (v > 0.002 && v < 0.998) {
        // only count transitions that BEGIN inside the window: a slot already
        // mid-build when tracking attached reports a fragment, not a duration
        if (!prev) { if (v < 0.05 || v > 0.95) window.__track.set(i, { start: t, first: v, rising: null, last: v }) }
        else { if (prev.rising === null && Math.abs(v - prev.first) > 0.004) prev.rising = v > prev.first; prev.last = v }
      } else if (prev) {
        window.__track.delete(i)
        // and only those that actually ARRIVED at an endpoint
        if (prev.rising !== null && (v <= 0.002 || v >= 0.998))
          window.__done.push({ secs: (t - prev.start) / 1000, rising: prev.rising, from: prev.first, to: v })
      }
    }
  }, 100)
})
await p.waitForTimeout(150000)
const r = await p.evaluate(() => window.__done)
const up = r.filter(x => x.rising).map(x => x.secs).sort((a,b)=>a-b)
const dn = r.filter(x => !x.rising).map(x => x.secs).sort((a,b)=>a-b)
const q = (a,f) => a.length ? a[Math.min(a.length-1, Math.floor(a.length*f))].toFixed(1) : '—'
console.log(`observed transitions: ${r.length}  (rising ${up.length}, falling ${dn.length})`)
console.log(`construction on screen  n=${up.length}  p10=${q(up,0.1)}s  median=${q(up,0.5)}s  p90=${q(up,0.9)}s   §57.2 floor 23s`)
console.log(`demolition on screen    n=${dn.length}  p10=${q(dn,0.1)}s  median=${q(dn,0.5)}s  p90=${q(dn,0.9)}s   §57.2 floor 6s`)
await b.close()
