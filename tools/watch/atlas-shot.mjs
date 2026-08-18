/** §59.1: the sprite atlas as drawn, upscaled 8x so the pixels are visible. */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
await mkdir('tools/watch/evidence/59-1', { recursive: true })
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 900, height: 500 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:1'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.waitForTimeout(2000)
const dataUrl = await p.evaluate(() => {
  // find the atlas canvas the sprite material is sampling
  const src = window.civ.agentAtlas()
  const S = 8, pad = 30
  const c = document.createElement('canvas')
  c.width = src.width * S
  c.height = src.height * S + pad
  const g = c.getContext('2d')
  g.fillStyle = '#0d0c0a'; g.fillRect(0, 0, c.width, c.height)
  g.imageSmoothingEnabled = false
  g.drawImage(src, 0, 0, c.width, src.height * S)
  g.fillStyle = '#8a8069'
  g.font = '16px ui-monospace, monospace'
  const cols = ['idle', 'walk a', 'walk b', 'work a', 'work b', 'work c']
  cols.forEach((t, i) => g.fillText(t, i * 16 * S + 6, src.height * S + 20))
  const rows = ['developer', 'renovator', 'consolidator', 'converter', 'landlord']
  g.fillStyle = '#e2a54f'
  rows.forEach((t, i) => g.fillText(t, 6 * 16 * S - 400, i * 16 * S + 20))
  return c.toDataURL('image/png')
})
await writeFile('tools/watch/evidence/59-1/atlas.png', Buffer.from(dataUrl.split(',')[1], 'base64'))
console.log('wrote tools/watch/evidence/59-1/atlas.png')
await b.close()
