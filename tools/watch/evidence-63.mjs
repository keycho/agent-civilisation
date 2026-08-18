/**
 * §63.5: one frame per city, unretouched, judged on a single question — does
 * it look like a machine took the world, or like a nice model of a town.
 *
 * Every step of §63 gets an a/b against the warm build, so anything that loses
 * more than it gains is reversible. The pair is taken at the same fixed,
 * settled, clock-frozen camera per city, the §56 discipline, so the only thing
 * that differs between an A and a B frame is the step under test.
 *
 * It also MEASURES the claim rather than only photographing it, because "cold
 * and dark except where agents are awake" is measurable: mean frame luminance,
 * the saturated fraction, and how much of the frame's warmth sits inside owned
 * stock. A frame that reads as architectural visualization is bright and
 * broadly warm; the target is dark, near-monochrome, with warmth concentrated.
 *
 *   node tools/watch/evidence-63.mjs <label> [chunk,chunk,...]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { decode } from './abdiff.mjs'

const LABEL = process.argv[2] ?? 'b-cold'
const CHUNKS = (process.argv[3] ?? 'schiedam-havens,london-deptford,paris-ourcq,tokyo-kyojima,brooklyn-redhook').split(',')
const OUT = `tools/watch/evidence/63/${LABEL}`
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const rows = []
for (const chunk of CHUNKS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION', chunk, e.message))
  // CIV_LIVE points every city at a running server, which is what §63.5's
  // acceptance frames need — a day-0 world has no agent light in it at all, so
  // it can prove the cold half and nothing about the warm one
  const live = process.env.CIV_LIVE
    ? `&server=${encodeURIComponent(`${process.env.CIV_LIVE}/ws/${chunk}`)}`
    : ''
  await page.goto(`${ORIGIN}/?chunk=${chunk}${live}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  await page.evaluate(() => {
    document.getElementById('watchBtn')?.click()
    window.civ.director.enabled = false
    window.civ.plate.home(true)
  })
  await page.waitForTimeout(4500)
  await page.evaluate(() => {
    window.civ.rig.settle()
    window.civ.freezeClock(42)
  })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/${chunk}.png` })

  /**
   * The measurement. Read the composited canvas back and reduce it to three
   * numbers: how bright the frame is, how much of it carries real saturation,
   * and how concentrated that saturation is. "Machine took the world" is dark
   * and near-monochrome with a few hot points; "nice model of a town" is
   * evenly lit and broadly coloured.
   */
  const stats = measure(`${OUT}/${chunk}.png`)
  rows.push({ chunk, ...stats })
  console.log(
    `  ${chunk.padEnd(20)} mean L ${stats.meanLuminance.toFixed(3)}  p90 L ${stats.p90Luminance.toFixed(
      3,
    )}  lit ${(stats.litFraction * 100).toFixed(1)}%  saturated ${(
      stats.saturatedFraction * 100
    ).toFixed(1)}%  warm ${(stats.warmFraction * 100).toFixed(1)}%`,
  )
  await page.close()
}

/**
 * A WebGL canvas cannot be read back with `drawImage` unless the context kept
 * its drawing buffer, and this one does not — the first version of this
 * measured every city at exactly zero and would have been believed. The
 * screenshot is the artifact anyway (§21.4: assert against what was emitted),
 * so the numbers come off the PNG.
 */
function measure(path) {
  const { w: width, h: height, ch: channels, data } = decode(path)
  let lum = 0
  let sat = 0
  let warm = 0
  let lit = 0
  const lums = []
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    const r = data[o] / 255
    const g = data[o + 1] / 255
    const b = data[o + 2] / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    lum += l
    lums.push(l)
    /**
     * Saturation is only meaningful where there is something to see. A
     * near-black pixel whose channels differ by one code value computes as
     * fully saturated, and in a frame that is mostly dark void that noise was
     * 60% of the "saturated fraction" — a number that barely moved between a
     * golden city and a black one, which is how it announced it was wrong.
     */
    if (l < 0.05) continue
    lit++
    const s = mx <= 0 ? 0 : (mx - mn) / mx
    if (s > 0.25) sat++
    // warm = saturated AND red-leading; the civilization's own light
    if (s > 0.25 && r > b + 0.06) warm++
  }
  const n = lums.length
  lums.sort((a, b) => a - b)
  return {
    meanLuminance: +(lum / n).toFixed(4),
    p90Luminance: +lums[Math.floor(0.9 * (n - 1))].toFixed(4),
    /** of the frame that is lit at all, how much carries real hue */
    saturatedFraction: +(lit ? sat / lit : 0).toFixed(4),
    /** and how much of THAT hue is the civilization's own warm */
    warmFraction: +(lit ? warm / lit : 0).toFixed(4),
    litFraction: +(lit / n).toFixed(4),
  }
}

await writeFile(`${OUT}/stats.json`, JSON.stringify({ label: LABEL, rows }, null, 2))
const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length
console.log(
  `\n${LABEL}: mean L ${mean('meanLuminance').toFixed(3)}, saturated ${(
    mean('saturatedFraction') * 100
  ).toFixed(1)}%, warm ${(mean('warmFraction') * 100).toFixed(1)}%`,
)
await browser.close()
