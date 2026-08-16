// §35/§36 block verification: exercise the whole spectator surface against the
// live world and photograph each feature. Fresh context = first-visit state.
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/tf3'
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-gpu-sandbox',
  ],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))

// no ?server= on purpose: this exercises the servers.json per-chunk path
await page.goto('http://127.0.0.1:5173/?chunk=london-deptford', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}-boot.png` })
await page.waitForFunction(() => window.civ?.readouts != null, null, { timeout: 120000 })
await page.waitForTimeout(2600)

// 1. entry explainer over the live world
await page.screenshot({ path: `${OUT}-explainer.png` })

// 2. dismissed, at rest, framed square: normal then diff
await page.click('#watchBtn')
await page.evaluate(() => {
  window.civ.director.enabled = false
  window.civ.ui.home()
})
await page.waitForTimeout(2200)
await page.screenshot({ path: `${OUT}-rest-normal.png` })
await page.evaluate(() => window.civ.setMode(1))
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}-rest-diff.png` })
await page.evaluate(() => window.civ.setMode(0))

// 3. follow mode: card, chip, filtered log, tether
const followed = await page.evaluate(() => {
  const [id, who] = [...window.civ.roster.entries()][2] ?? []
  if (!id) return null
  window.civ.ui.agentCard(id)
  window.civ.follow(id)
  return who?.name ?? id
})
console.log('following', followed)
await page.waitForTimeout(3200)
await page.screenshot({ path: `${OUT}-follow.png` })
await page.evaluate(() => window.civ.follow(null))

// 4. crew pane
await page.evaluate(() => {
  window.civ.ui.home()
  window.civ.ui.crew(true)
})
await page.waitForTimeout(1600)
await page.screenshot({ path: `${OUT}-crew.png` })
await page.evaluate(() => window.civ.ui.crew(false))

// 5. help pane (vocabulary + credits)
await page.evaluate(() => window.civ.ui.help())
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}-help.png` })
await page.click('#helpClose')
await page.click('#explainerClose')

// 6. changelog rail on the log scrub
await page.evaluate(() => {
  const count = window.civ.readouts.eventCount
  window.civ.scrubTo(Math.floor(count * 0.6))
})
await page.waitForTimeout(1400)
await page.screenshot({ path: `${OUT}-changelog.png` })

// 7. city switcher: pane, then cycle with ] — a real navigation to schiedam
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.civ?.readouts != null, null, { timeout: 120000 })
await page.click('#chunkBtn')
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}-chunks.png` })
await page.keyboard.press(']')
await page.waitForFunction(() => window.civ?.readouts != null, null, { timeout: 120000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}-arrive.png` })
await page.waitForTimeout(2600)
const where = await page.evaluate(() => ({
  chunk: new URLSearchParams(location.search).get('chunk'),
  names: [...window.civ.roster.values()].slice(0, 3).map((a) => a.name),
}))
console.log('switched to', JSON.stringify(where))
await page.screenshot({ path: `${OUT}-schiedam.png` })

await browser.close()
console.log('done')
