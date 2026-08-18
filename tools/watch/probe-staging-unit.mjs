/**
 * §57.2, measured without the world: aim one slot from 0 to 1 and time how
 * long the PICTURE takes to get there. Dead server, so nothing else touches
 * the channel — no season turn, no scrub, no delta.
 */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 640, height: 400 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:1'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => document.getElementById('watchBtn')?.click())
await p.waitForTimeout(2500)
for (const [label, from, to, floor] of [['construction 0 -> 1', 0, 1, 23], ['demolition 1 -> 0', 1, 0, 6]]) {
  // Driven at a known dt rather than by the render loop: the loop clamps dt to
  // 0.05s a frame, so under swiftshader's frame rate a wall-clock measurement
  // reports the capture box and not the floor. This asks the only question the
  // floor makes a claim about — how much TIME the picture needs.
  const secs = await p.evaluate(([from, to]) => {
    const d = window.civ.buildings.data
    const slot = 3
    d.data[slot * 4] = Math.round(from * 255)
    d.markDirty()
    window.civ.observer.aimForCheck(slot, to)
    const dt = 1 / 60
    let frames = 0
    while (frames < 60 * 240) {
      window.civ.observer.advanceVisual(dt)
      frames++
      const v = d.data[slot * 4] / 255
      if (Math.abs(v - to) < 0.006) break
    }
    return (frames * dt)
  }, [from, to])
  const ok = secs >= floor * 0.95
  console.log(`${label.padEnd(22)} took ${secs.toFixed(1)}s on screen   floor ${floor}s   ${ok ? 'FLOOR HELD' : 'TOO FAST'}`)
}
await b.close()
