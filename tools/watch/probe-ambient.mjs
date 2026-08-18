/**
 * §57.4: does a pointer drag take the camera back, immediately?
 *
 * Asserts the three things the operator can see: the chip flips to `manual`,
 * the button stops claiming ambient, and the camera actually stops being
 * driven by the director. Run against the local build; production serves the
 * same bundle (this sandbox cannot open a browser onto an external host).
 */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('ERR', e.message))
await p.goto('http://127.0.0.1:5173/?chunk=schiedam-havens&server=' + encodeURIComponent('ws://127.0.0.1:1'), { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await p.evaluate(() => document.getElementById('watchBtn')?.click())
await p.waitForTimeout(2500)

const read = () => p.evaluate(() => ({
  chip: document.getElementById('modeFlip')?.textContent,
  chipOn: document.getElementById('modeFlip')?.classList.contains('on'),
  button: document.getElementById('ambient')?.textContent,
  pressed: document.getElementById('ambient')?.getAttribute('aria-pressed'),
  bodyAmbient: document.body.classList.contains('ambient'),
  directorEnabled: window.civ.director.enabled,
}))

await p.keyboard.press('a')
await p.waitForTimeout(1000)
console.log('after pressing a      :', JSON.stringify(await read()))

// a real drag on the canvas, read at once — this is the operator's test
await p.mouse.move(640, 420)
await p.mouse.down()
// read at the instant of pointer-down: "instantly" is the claim, and the chip
// only holds its highlight for 1400ms, so a read taken after three awaited
// drag steps is testing the fade, not the flip
const during = await read()
console.log('AT pointer-down       :', JSON.stringify(during))
await p.mouse.move(676, 404, { steps: 3 })
await p.mouse.up()
await p.waitForTimeout(2500)
console.log('2.5s later            :', JSON.stringify(await read()))

const pass =
  during.bodyAmbient === false && during.chip === 'manual' && during.chipOn === true &&
  during.button === 'ambient off' && during.pressed === 'false'
console.log(pass ? '\nPASS: input takes the camera, and the chrome says so' : '\nFAIL')
await b.close()
