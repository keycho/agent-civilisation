/**
 * DOF r2 a/b: the focal band widens with obliquity and proximity.
 *
 * The operator's named test case is the melted-church frame — maassluis
 * haven, oblique, where the church cluster AND the foreground both have to
 * resolve. Plus a street-level shot, where the band should be effectively
 * off, and the home framing, which must keep the diorama look untouched.
 *
 * Dead server, day-0 plate, three fixed cameras, before/after by checking out
 * the other revision — this run captures whatever is currently built.
 *
 *   node tools/watch/evidence-dof.mjs <out-dir>
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'tools/watch/evidence/dof'
await mkdir(OUT, { recursive: true })

const SHOTS = [
  // the named case: oblique over the haven, the church cluster mid-frame
  { chunk: 'maassluis-haven', name: 'church-oblique', distance: 430, polar: 1.16, azimuth: 0.5 },
  // the home framing — the diorama read this whole feature exists for
  { chunk: 'maassluis-haven', name: 'home', distance: null, polar: 0.66, azimuth: 0 },
  // street framing: the band must cover the plate, i.e. be off in effect
  { chunk: 'schiedam-havens', name: 'street', distance: 105, polar: 1.24, azimuth: 0.9 },
]

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

for (const shot of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log(`PAGE EXCEPTION (${shot.name})`, e.message))
  await page.goto(
    `http://127.0.0.1:5173/?chunk=${shot.chunk}&server=${encodeURIComponent('ws://127.0.0.1:1')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.waitForTimeout(2600)
  await page.evaluate((s) => {
    document.getElementById('watchBtn')?.click()
    document.body.classList.add('ambient')
    window.civ.director.enabled = false
    const { rig } = window.civ
    if (s.distance === null) {
      window.civ.ui.home()
      for (let i = 0; i < 60; i++) rig.update(0.2)
      return
    }
    const V = rig.target.constructor
    rig.flyTo(new V(0, rig.target.y, 0), s.distance, {
      azimuth: s.azimuth,
      polar: s.polar,
      duration: 0.01,
    })
    // the rig damps toward its target and this harness renders under
    // swiftshader at well under a frame a second, so the camera would still be
    // in transit when the shutter opened. Drive it to convergence directly.
    for (let i = 0; i < 60; i++) rig.update(0.2)
  }, shot)
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `${OUT}/${shot.name}.png` })
  // the pre-r2 build has no dof() hook; the frames are still the comparison
  const state = await page.evaluate(() => {
    const d = window.civ.dof?.()
    return {
      distance: +window.civ.rig.distance.toFixed(1),
      polar: +window.civ.rig.polar.toFixed(3),
      band: d ? +d.range.toFixed(1) : null,
      strength: d ? +d.strength.toFixed(3) : null,
      maxBlurPx: d ? d.maxBlurPx : null,
    }
  })
  console.log(`${shot.name}:`, JSON.stringify(state))

  // and the same frame with focus off, for the toggle
  if (shot.name === 'church-oblique') {
    // ambient hides the bars, so the toggle is driven directly
    const hasToggle = await page.evaluate(() => {
      const b = document.getElementById('focusBtn')
      if (!b) return false
      b.click()
      return true
    })
    if (!hasToggle) console.log('  (no focus toggle in this build)')
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/${shot.name}-focus-off.png` })
  }
  await page.close()
}
await browser.close()
console.log(`DOF r2 evidence -> ${OUT}`)
