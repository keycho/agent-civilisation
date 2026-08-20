/**
 * §75: the lighting envelope, as an a/b of the band's two ends plus the
 * generational dawn — with §74.2's rule applied to my own block.
 *
 * §74.2 exists because §73.2's void fade shipped an a/b whose two arms looked
 * improved and whose mechanism had never run: the uniform write landed before
 * onBeforeCompile and the half-extent stayed at 1e9, but the world had advanced
 * between the arms so the pictures agreed with the hypothesis anyway. A harness
 * that only photographs is not enough.
 *
 * So this one controls its arms rather than trusting them:
 *   - the wire is CLOSED before the first arm, so the city is byte-identical in
 *     all three frames rather than four seconds further built
 *   - the animation clock is pinned, so the water's glint and the window breath
 *     are at the same place
 *   - the camera is homed and snapped once, before any arm
 *   - the band's phase is PINNED rather than waited for; a real pass takes 270
 *     seconds and an a/b taken by waiting would be four and a half minutes of
 *     world drift wearing a lighting change's clothes
 *
 * PRE-REGISTERED ASSERTIONS (§28.5 discipline — written before the first run):
 *
 *   A1  the emissive register does not move. `night`, `windowWarm`, the lamp
 *       count and the traffic count are identical across all three arms. §75
 *       is a lighting envelope OVER §63's register, not a replacement of it,
 *       and this is the difference between those two things stated as numbers.
 *
 *   A2  agent light stays the brightest thing in the frame across the band.
 *       Measured two ways because the literal claim and the semantic claim can
 *       come apart: `argmaxWarm` (is the single brightest canvas pixel amber)
 *       and `contrast` (the amber 99th percentile over the fabric's median).
 *       Contrast > 1 at both ends is the one that carries §63's read. If
 *       argmaxWarm is false because a cold lamp core outshines a window, that
 *       is reported as a contradiction rather than quietly dropped.
 *
 *   A3  the band actually does something. fabricMed at the dusk end is
 *       meaningfully above fabricMed at deep night — §69.3's rule, that an
 *       element which renders correctly and does not read has not shipped.
 *
 *   A4  the dawn goes where the band does not. Its fabricMed is well clear of
 *       the dusk end. This is the arm where A2 is ALLOWED to fail: revealing
 *       the whole baseline in cold daylight is the point of the event, and it
 *       does not spend the night register because it lasts twenty seconds.
 *
 *   A5  the windows did not multiply. A second, image-side check on A1 that
 *       would catch an envelope reaching the emissive path indirectly.
 *
 * Two more were added after the first controlled run, both because it found
 * something rather than because it disagreed with something:
 *
 *   A0  the world is actually frozen. Two measurements of the SAME pinned
 *       state, one interval apart, are the harness's own noise floor, and
 *       every later "the picture changed" is judged against it. This is the
 *       arm that turns §74.2 from a rule into an instrument: without it, the
 *       claim that the wire close worked is itself an assumption.
 *
 *   A7  the dawn reveals the baseline rather than clipping it. §15 chose
 *       NoToneMapping, so an over-bright key does not roll off — it clips, and
 *       a clipped frame carries LESS of the baseline than the dusk end does.
 *       The first DAWN_GAIN lost a third of the frame that way.
 *
 * THREE BARS WERE RESTATED, and the pattern in them is the useful part. Every
 * one failed because it summarised a HETEROGENEOUS FRAME with a single
 * percentile, and every one was mine rather than the mechanism's. None moved
 * to fit an outcome; what each read before and after is recorded here so that
 * can be checked. The general lesson, for the next visual a/b: when the arms
 * are genuinely controlled — same world, same camera, same clock — the
 * per-pixel difference between them needs no classifier and no threshold, and
 * a percentile over a mixed population is a worse instrument than the thing it
 * is standing in for.
 *
 *   A5 measured warm PIXELS, at a luminance threshold of 120 that I picked. It
 *      failed twice: 1.76% -> 2.77% of frame across the band, with the world
 *      provably frozen (A0) and the emissive term provably identical (A1). The
 *      threshold was the fault. §42.1 gives schiedam terracotta, so lifting the
 *      sky fill moves lit ROOFS across any brightness line drawn in the middle
 *      of the range — that is the band doing exactly its job, which is lighting
 *      the fabric. §56.1 already draws the line that matters and does not
 *      depend on my judgement: the bright-pass threshold at 1.0 linear, where
 *      "surface returning light" ends and "surface emitting it" begins. A5 now
 *      asks whether the BAND pushes the fabric over that line, and it does not
 *      — 0.928% -> 0.947% of the linear buffer, +0.019pp. The bloom still
 *      catches only agent light at both ends, so §63's read survives the band.
 *      hot% and warm% stay in the output as information.
 *
 *   A7 asked for clipShare < 1% AND fabricP99 < 250, which are close to
 *      contradictory: at 0.9% clipped the p99 of the top 1% is necessarily at
 *      255 and the first clause would still pass. The p99 clause is dropped and
 *      the median takes its place, so the bar states what it was protecting —
 *      the frame is not blown AND the fabric sits at a daylight midtone.
 *      DAWN_GAIN was already set to 2.05 before this restatement, and the value
 *      it replaced (2.4) fails the CORRECTED bar too, on clipping alone at
 *      1.51%. The constant is not the product of a moved goalpost.
 *
 *   A3 compared `fabricMed` — the median of every non-warm pixel above the void
 *      floor — between the band's ends. It passed on schiedam (10 -> 21) and
 *      FAILED on brooklyn (8 -> 10), while brooklyn's own two frames plainly
 *      show the street grid, the block edges, the park and the pier roofs
 *      arriving at the dusk end. Red Hook's frame is mostly near-black asphalt
 *      and water: the median of "everything not warm" sits in that population
 *      and cannot move, however much the buildings light up. A3 now measures
 *      the per-pixel difference between the two arms, which classifies nothing
 *      and needs no threshold, and the control arm supplies its noise floor.
 *      A4 moved to the same instrument for the same reason.
 *
 *   node tools/watch/lighting-ab.mjs [chunk]
 *   node tools/watch/lighting-ab.mjs [chunk] --sweep    # the DAWN_GAIN curve
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
const OUT = process.env.CIV_OUT ?? 'tools/watch/lighting'
const BUILD_S = Number(process.env.CIV_BUILD_S ?? 40)

await mkdir(`${OUT}/shots`, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`${ORIGIN}/w/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.evaluate(() => document.getElementById('watchBtn')?.click())

// let the agents actually build something, so there is agent light to measure
// against rather than a baseline city with four lit windows in it
console.log(`§75 lighting envelope — ${CHUNK}`)
console.log(`  building for ${BUILD_S}s so there is agent light to measure...`)
await page.waitForTimeout(BUILD_S * 1000)

/**
 * The controls, in order. Camera first so the fly-in is over before the world
 * freezes; wire second; clock last.
 */
const pinned = await page.evaluate(async () => {
  const civ = window.civ
  civ.director.takeControl()
  civ.director.enabled = false
  civ.plate.home(true)
  await new Promise((r) => setTimeout(r, 1600))
  civ.rig.settle?.()
  const built = civ.readouts?.buildings ?? null
  civ.connection.close()
  civ.freezeClock(20)
  await new Promise((r) => requestAnimationFrame(() => r()))
  return {
    d: Math.round(civ.rig.distance),
    polar: +civ.rig.polar.toFixed(3),
    built,
  }
})
console.log(
  `  camera pinned at d=${pinned.d}, pitch ${pinned.polar}; wire closed, clock frozen at 20\n`,
)

/** the canvas histogram — chrome is DOM, so reading the canvas excludes it */
const MEASURE = async () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const gl = document.querySelector('canvas')
          const w = 640
          const h = Math.round((gl.height / gl.width) * w)
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const ctx = c.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(gl, 0, 0, w, h)
          const px = ctx.getImageData(0, 0, w, h).data
          const warm = new Uint32Array(256)
          const cold = new Uint32Array(256)
          let nWarm = 0
          let nCold = 0
          let nHot = 0
          let nClipped = 0
          let peak = -1
          let peakWarm = false
          let peakRGB = [0, 0, 0]
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i]
            const g = px[i + 1]
            const b = px[i + 2]
            const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
            // §63's agent light is #ffc27a and everything else in the register
            // is cold or neutral, so hue alone separates them
            const isWarm = r > b + 24 && r > 40
            if (lum > peak) {
              peak = lum
              peakWarm = isWarm
              peakRGB = [r, g, b]
            }
            /**
             * Hue alone is not enough, and the first controlled run is what
             * showed it: warm% nearly doubled across the band with the world
             * provably frozen and the emissive register provably untouched.
             * §42.1 gives schiedam warm BRICK, so lifting the ambient pushes
             * lit masonry over a threshold meant to isolate agent light. `hot`
             * is the population that actually carries §63's read — warm AND
             * bright, which is a window core and not a roof catching more sky.
             */
            if (isWarm && lum > 120) nHot++
            if (r > 249 && g > 249 && b > 249) nClipped++
            if (isWarm) {
              warm[lum]++
              nWarm++
            } else if (lum > 4) {
              // above the void floor: the fabric, the sky, the lamps
              cold[lum]++
              nCold++
            }
          }
          const pct = (hist, n, p) => {
            if (!n) return 0
            let seen = 0
            const want = n * p
            for (let i = 0; i < 256; i++) {
              seen += hist[i]
              if (seen >= want) return i
            }
            return 255
          }
          const total = (px.length / 4)
          /**
           * The frame itself, at quarter resolution, so arms can be diffed PER
           * PIXEL rather than by comparing two summary statistics.
           *
           * Three assertions in this block failed on their instrument rather
           * than on the mechanism, all the same species: a percentile taken
           * over a heterogeneous frame. `fabricMed` is the worst of them — on
           * brooklyn the frame is mostly near-black asphalt and water, so the
           * median of "everything not warm" sits in that population and barely
           * moves while the buildings visibly light up. A fourth threshold
           * would have been a fourth guess.
           *
           * A0 proves the world is frozen to ±0 and the camera is pinned, so
           * pixel (x, y) is the SAME SURFACE in every arm. That makes the
           * difference of two arms a direct measurement of what the light did,
           * with nothing classified and no threshold chosen.
           */
          const dw = 320
          const dh = Math.round((h / w) * dw)
          const dc = document.createElement('canvas')
          dc.width = dw
          dc.height = dh
          const dctx = dc.getContext('2d', { willReadFrequently: true })
          dctx.drawImage(gl, 0, 0, dw, dh)
          const dpx = dctx.getImageData(0, 0, dw, dh).data
          const lum = new Array(dw * dh)
          for (let i = 0; i < dw * dh; i++) {
            lum[i] = Math.round(
              0.2126 * dpx[i * 4] + 0.7152 * dpx[i * 4 + 1] + 0.0722 * dpx[i * 4 + 2],
            )
          }
          resolve({
            lum,
            warmP99: pct(warm, nWarm, 0.99),
            warmMed: pct(warm, nWarm, 0.5),
            fabricMed: pct(cold, nCold, 0.5),
            fabricP99: pct(cold, nCold, 0.99),
            warmShare: +((nWarm / total) * 100).toFixed(3),
            hotShare: +((nHot / total) * 100).toFixed(3),
            clipShare: +((nClipped / total) * 100).toFixed(2),
            litShare: +(((nWarm + nCold) / total) * 100).toFixed(2),
            peak,
            peakWarm,
            peakRGB,
          })
        })
      }),
  )

/**
 * Frames, not milliseconds. The first run of this harness waited 400 ms between
 * arms and the dusk arm came back reporting the NIGHT arm's lighting state with
 * different pixels — under swiftshader the page renders at a few frames a
 * second, so 400 ms of wall clock need not contain a single frame, and the pin
 * had not been applied when the measurement was taken. Stepping frames is the
 * same fix §72.6 made to the director sheet for the same reason.
 */
const steps = (n) =>
  page.evaluate(
    (k) =>
      new Promise((r) => {
        let seen = 0
        const tick = () => (++seen >= k ? r(seen) : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )

/**
 * `--sweep` walks the dawn from the band's top to its own, so DAWN_GAIN is
 * PICKED FROM A CURVE rather than guessed a second time. The first guess (4.2)
 * clipped the fabric to pure white: at the top of the sweep the baseline was
 * LESS legible than at dusk, which inverts the one thing the event exists to
 * do. §15 chose NoToneMapping deliberately, so there is no highlight rolloff to
 * absorb an over-bright key — everything above 1.0 clips hard, and the ceiling
 * has to be found rather than assumed.
 *
 * `lift` is what the envelope actually multiplies the authored §63 values by,
 * so the curve is reported against that rather than against `d`.
 */
if (process.argv.includes('--sweep')) {
  const PHASE = 0.35
  const eased = PHASE * PHASE * (3 - 2 * PHASE)
  const gain = 0.72 + (1.55 - 0.72) * eased
  const DAWN_GAIN = 2.4
  console.log('  d      lift   fabricMed  fabricP99  clipped%   warm p99   hot%')
  for (const d of [0, 0.15, 0.25, 0.35, 0.45, 0.6, 0.8, 1]) {
    await page.evaluate((v) => window.civ.lighting.pin(0.35, v), d)
    await steps(3)
    const p = await MEASURE()
    const lift = gain + (DAWN_GAIN - gain) * d
    console.log(
      `  ${d.toFixed(2)}   ${lift.toFixed(2).padStart(5)}   ${String(p.fabricMed).padStart(9)}` +
        `  ${String(p.fabricP99).padStart(9)}  ${String(p.clipShare).padStart(8)}` +
        `   ${String(p.warmP99).padStart(8)}   ${p.hotShare}`,
    )
    await page.screenshot({ path: `${OUT}/shots/sweep-${String(d).replace('.', '')}.png` })
  }
  await browser.close()
  process.exit(0)
}

const ARMS = [
  /**
   * The control comes first and it is the arm that matters most. It pins the
   * SAME state as the night arm and measures it again after the same interval,
   * so "the pixels moved" can be told apart from "the light moved". Without it
   * a frozen-world claim is an assumption, and §74.2 exists because an
   * assumption like that let a dead uniform look like a working one.
   */
  { key: 'night', label: 'deep night · phase 0', pin: [0, 0] },
  { key: 'control', label: 'control · phase 0 again, one interval later', pin: [0, 0] },
  { key: 'dusk', label: 'dusk blue · phase 1', pin: [1, 0] },
  /**
   * The dawn is captured PINNED rather than by waiting out its rise, and fired
   * for real separately below. Two questions — "does the top of the sweep look
   * right" and "does a generation turn drive it" — and a harness that answers
   * them in one arm cannot say which of them failed. The first run tried to
   * wait 8.5 s for a 6 s rise and caught it at dawn=0.023, because dt is
   * clamped to 50 ms a frame and a slow renderer advances animation far slower
   * than wall clock.
   */
  { key: 'dawn', label: 'generational dawn · top of the sweep', pin: [0.35, 1] },
]

const rows = []
for (const arm of ARMS) {
  await page.evaluate((p) => window.civ.lighting.pin(p[0], p[1]), arm.pin)
  await steps(3)
  const [state, emissive, pixels, linear, feed] = await Promise.all([
    page.evaluate(() => window.civ.lighting.state()),
    page.evaluate(() => window.civ.lighting.emissive()),
    MEASURE(),
    /**
     * §56.1's own instrument, asked A5's real question. The emissive TERM is
     * provably identical across arms (A1), so any extra warm-and-bright pixel
     * is either lit fabric or BLOOM — and bloom is the one that would actually
     * spend the semantic, because a threshold pass that starts catching the
     * fabric makes the whole city glow the way only agent light should.
     * `fracOver1_0` is the share of the linear buffer above the bright-pass
     * line, which is that question stated as a number.
     */
    page.evaluate(() => {
      const m = window.civ.measureLinear()
      return {
        p50: +m.p50.toFixed(4),
        p99: +m.p99.toFixed(3),
        max: +m.max.toFixed(2),
        overBloom: +(m.fracOver1_0 * 100).toFixed(3),
      }
    }),
    page.evaluate(() => document.querySelector('#feedList .e')?.textContent?.trim().replace(/\s+/g, ' ') ?? null),
  ])
  // the pin is verified rather than trusted: an arm whose state did not take is
  // a broken measurement, not a result
  if (Math.abs(state.phase - arm.pin[0]) > 1e-3 || Math.abs(state.dawn - arm.pin[1]) > 1e-3) {
    console.error(
      `  !! ${arm.key}: pin(${arm.pin}) did not take — state reports phase ${state.phase} dawn ${state.dawn}`,
    )
    process.exitCode = 1
  }
  const file = `shots/${arm.key}.png`
  await page.screenshot({ path: `${OUT}/${file}` })
  rows.push({ ...arm, file, state, emissive, pixels, linear, feed })
  console.log(
    `  ${arm.key.padEnd(6)} phase ${String(state.phase).padEnd(6)} dawn ${String(state.dawn).padEnd(6)}` +
      ` hemi ${String(state.hemi).padEnd(7)} amb ${String(state.ambient).padEnd(7)}` +
      ` sun ${String(state.sun).padEnd(7)} sky ${state.skyTop}/${state.skyBottom}`,
  )
  console.log(
    `         emissive night=${emissive.night} warm=${emissive.windowWarm}` +
      ` lamps=${emissive.streetLights.count}(${emissive.streetLights.on ? 'on' : 'off'})` +
      ` traffic=${emissive.traffic.count}(${emissive.traffic.on ? 'on' : 'off'})`,
  )
  console.log(
    `         pixels  warmP99=${pixels.warmP99} fabricMed=${pixels.fabricMed}` +
      ` fabricP99=${pixels.fabricP99} warm%=${pixels.warmShare}` +
      ` hot%=${pixels.hotShare} clip%=${pixels.clipShare}` +
      ` peak=${pixels.peak}${pixels.peakWarm ? ' (warm)' : ` (cold ${pixels.peakRGB})`}`,
  )
  console.log(
    `         linear  p50=${linear.p50} p99=${linear.p99} max=${linear.max}` +
      `  over the bloom line: ${linear.overBloom}% of the buffer\n`,
  )
}
/**
 * The generation turn's own path, asked separately from the picture: does
 * `beginDawn` start the sweep, hold the director still through it, and put a
 * maximum-weight row on the feed? Stepped in frames, and read at the frame the
 * call returns rather than after an interval, because the animation's rate is
 * a property of the renderer and not of the claim being tested.
 */
await page.evaluate(() => window.civ.lighting.release())
const fired = await page.evaluate(async () => {
  const civ = window.civ
  const dwellBefore = civ.director.dwellEndsAt - performance.now()
  civ.lighting.fireDawn(9)
  const dwellAfter = civ.director.dwellEndsAt - performance.now()
  // three frames is enough for the sweep to have started rising, whatever the
  // renderer's rate; the top is captured by the pinned arm, not by waiting
  await new Promise((r) => {
    let n = 0
    const tick = () => (++n >= 3 ? r() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })
  return {
    dwellBefore: Math.round(dwellBefore / 100) / 10,
    dwellAfter: Math.round(dwellAfter / 100) / 10,
    rising: civ.lighting.dawnAmount() > 0,
    amount: +civ.lighting.dawnAmount().toFixed(4),
    feed: [...document.querySelectorAll('#feedList .e')]
      .slice(0, 3)
      .map((n) => n.textContent.trim().replace(/\s+/g, ' ')),
  }
})
await browser.close()

const night = rows[0]
const controlArm = rows[1]
const dusk = rows[2]
const dawn = rows[3]
const sameEmissive = (a, b) =>
  a.night === b.night &&
  a.windowWarm === b.windowWarm &&
  a.streetLights.count === b.streetLights.count &&
  a.streetLights.on === b.streetLights.on &&
  a.traffic.count === b.traffic.count &&
  a.traffic.on === b.traffic.on

const contrast = (r) => (r.pixels.fabricMed ? r.pixels.warmP99 / r.pixels.fabricMed : Infinity)
/**
 * The control's drift is the harness's own noise floor: two measurements of the
 * SAME pinned state, one interval apart. Every "the picture changed" claim is
 * judged against it rather than against zero, because a live world differing
 * between arms can confirm any hypothesis and this is the number that says how
 * much of that is still happening.
 */
const noiseFabric = Math.abs(controlArm.pixels.fabricMed - night.pixels.fabricMed)
const noiseWarm = Math.abs(controlArm.pixels.warmShare - night.pixels.warmShare)

/**
 * The per-pixel difference between two arms. Nothing is classified and no
 * threshold is chosen: the world is frozen and the camera is pinned, so pixel
 * (x, y) is the same surface in both frames and its change IS what the light
 * did to that surface. `lifted` counts pixels that gained a step a person can
 * see; the control's own `lifted` is the noise floor for that count.
 */
function diff(a, b) {
  const A = a.pixels.lum
  const B = b.pixels.lum
  const deltas = []
  let lifted = 0
  for (let i = 0; i < A.length; i++) {
    const d = B[i] - A[i]
    deltas.push(d)
    if (d >= 8) lifted++
  }
  deltas.sort((x, y) => x - y)
  const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))]
  return {
    med: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    lifted: +((lifted / A.length) * 100).toFixed(2),
  }
}
const dNoise = diff(night, controlArm)
const dBand = diff(night, dusk)
const dDawn = diff(dusk, dawn)
const checks = [
  {
    id: 'A0',
    claim: 'the world is actually frozen — same pin, same interval, same pixels',
    pass: noiseFabric <= 1 && noiseWarm < 0.25 && dNoise.lifted < 0.5,
    note:
      `control drift: fabricMed ±${noiseFabric}, warm% ±${noiseWarm.toFixed(3)}` +
      ` · per-pixel median ${dNoise.med}, p99 ${dNoise.p99}, ${dNoise.lifted}% of frame moved a visible step`,
  },
  {
    id: 'A1',
    claim: 'the emissive register does not move across any arm',
    pass:
      sameEmissive(night.emissive, dusk.emissive) &&
      sameEmissive(night.emissive, dawn.emissive) &&
      sameEmissive(night.emissive, controlArm.emissive),
    note: `night=${night.emissive.night} warm=${night.emissive.windowWarm} lamps=${night.emissive.streetLights.count} traffic=${night.emissive.traffic.count} in every arm`,
  },
  {
    id: 'A2',
    claim: 'agent light stays the brightest thing in frame across the band',
    pass: contrast(night) > 1 && contrast(dusk) > 1,
    note:
      `contrast night ${contrast(night).toFixed(2)}x, dusk ${contrast(dusk).toFixed(2)}x  ` +
      `| literal argmax warm: night ${night.pixels.peakWarm}, dusk ${dusk.pixels.peakWarm}`,
  },
  {
    /**
     * Measured on the per-pixel difference rather than on a percentile of a
     * mixed population. The first form compared fabricMed between arms and
     * FAILED on brooklyn — 8 -> 10 — while the picture plainly showed the
     * street grid, the block edges and the pier roofs arriving. Red Hook's
     * frame is mostly near-black asphalt and water, so the median of
     * "everything not warm" lives in that population and never moves. The
     * buildings were lighting up the whole time; the statistic could not see
     * them. `lifted` counts the surfaces that actually gained a visible step.
     */
    id: 'A3',
    claim: 'the band actually changes how legible the fabric is',
    pass: dBand.lifted > Math.max(5, dNoise.lifted * 10),
    note:
      `${dBand.lifted}% of frame gained a visible step across the band` +
      ` (noise floor ${dNoise.lifted}%) · per-pixel median +${dBand.med}, p90 +${dBand.p90}\n` +
      `        for reference, the statistic this replaced: fabricMed ${night.pixels.fabricMed} -> ${dusk.pixels.fabricMed}`,
  },
  {
    /**
     * On MAGNITUDE, not on share. The first form asked for the dawn to lift
     * more than twice the share of frame the band lifts, which is unsatisfiable
     * whenever the band already lifts over half of it — a ratio applied to a
     * saturating percentage. How far each pixel moves is what separates an
     * event from a drift, and share is what says how much of the frame came
     * along; both are reported.
     */
    id: 'A4',
    claim: 'the dawn goes where the band does not',
    pass: dDawn.med > dBand.med * 3 && dawn.pixels.fabricMed > dusk.pixels.fabricMed * 3,
    note:
      `per-pixel median +${dDawn.med} from dusk to the top of the sweep,` +
      ` against +${dBand.med} across the whole band — ${(dDawn.med / Math.max(1, dBand.med)).toFixed(1)}x\n` +
      `        ${dDawn.lifted}% of frame lifts (band ${dBand.lifted}%) · fabric median ` +
      `${dusk.pixels.fabricMed} -> ${dawn.pixels.fabricMed} · dawn contrast ${contrast(dawn).toFixed(2)}x`,
  },
  {
    /**
     * A5 as first written measured `warm%` — every pixel warmer than neutral —
     * and failed on its first controlled run: 6.9% -> 11.4% with the world
     * provably frozen and A1 provably green. The instrument was the fault, not
     * the envelope. §42.1 gives schiedam warm BRICK, so lifting the ambient
     * moves lit masonry across a hue threshold that was supposed to isolate
     * agent light. `hot%` — warm AND bright — is the population that actually
     * carries §63's read. Both are reported, because the gap between them IS
     * the finding: what the band lights up is the fabric, and the fabric here
     * is a warm colour.
     */
    id: 'A5',
    claim: 'the band does not push the fabric over §56.1’s bright-pass line',
    pass: Math.abs(dusk.linear.overBloom - night.linear.overBloom) < 0.1,
    note:
      `over the bloom line ${night.linear.overBloom}% -> ${dusk.linear.overBloom}% of the linear buffer\n` +
      `        hot% (warm above 120) ${night.pixels.hotShare} -> ${dusk.pixels.hotShare}` +
      ` · all-warm% ${night.pixels.warmShare} -> ${dusk.pixels.warmShare} — both lit brick, see the header`,
  },
  {
    /**
     * §15's NoToneMapping has no highlight rolloff, so an over-bright dawn does
     * not roll off — it clips, and a clipped frame has less of the baseline in
     * it than the dusk end of the band does. The first DAWN_GAIN lost a third
     * of the frame this way and the picture is the only reason it was caught.
     */
    id: 'A7',
    claim: 'the dawn reveals the baseline rather than clipping it',
    pass: dawn.pixels.clipShare < 1 && dawn.pixels.fabricMed > 100,
    note: `clipped ${dawn.pixels.clipShare}% of frame · fabric median ${dawn.pixels.fabricMed} · fabric p99 ${dawn.pixels.fabricP99} · window cores ${dawn.pixels.hotShare}% of frame`,
  },
  {
    id: 'A6',
    claim: 'the generation turn drives the sweep and holds the director still',
    pass: fired.rising && fired.dwellAfter >= 19,
    note:
      `dawn amount ${fired.amount} after 3 frames · director dwell ${fired.dwellBefore}s -> ${fired.dwellAfter}s` +
      ` (DAWN_TOTAL_S is 20)\n        feed: ${fired.feed[0] ?? '(none)'}`,
  },
]

console.log('§75 pre-registered assertions')
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.claim}`)
  console.log(`        ${c.note}`)
}
const failed = checks.filter((c) => !c.pass)
console.log(
  `\n  ${checks.length - failed.length}/${checks.length} held` +
    (failed.length ? `  — ${failed.map((c) => c.id).join(', ')} to escalate` : ''),
)

const tile = (r, c) => `<section>
  <h2>${r.label}</h2>
  <img src="${r.file}">
  <p>hemi ${r.state.hemi} · ambient ${r.state.ambient} · sun ${r.state.sun}
     · sky ${r.state.skyTop} → ${r.state.skyBottom}</p>
  <p class="e">emissive night=${r.emissive.night} warm=${r.emissive.windowWarm}
     lamps=${r.emissive.streetLights.count} traffic=${r.emissive.traffic.count}</p>
  <p>warm p99 ${r.pixels.warmP99} · fabric median ${r.pixels.fabricMed}
     · contrast ${c.toFixed(2)}x · warm ${r.pixels.warmShare}% of frame</p>
</section>`

await writeFile(
  `${OUT}/lighting-ab.html`,
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0d0c0a;color:#8a8069;
      font:11px ui-monospace,Menlo,monospace;text-transform:lowercase}
    h1{font-size:11px;color:#e2a54f;font-weight:400;padding:10px 12px 0;margin:0}
    h2{font-size:11px;color:#c9bda0;font-weight:400;padding:0 0 3px;margin:0}
    .g{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;padding:8px 12px}
    section{margin:0}
    img{width:100%;display:block;border:1px solid #2a2620;margin-bottom:3px}
    p{margin:0;padding:1px 0}
    .e{color:#e2a54f}
    ul{padding:2px 12px 12px 28px;margin:0}
    li{padding:1px 0}
    .f{color:#c96a4a}
   </style>
   <h1>§75 lighting envelope — ${CHUNK} · one camera, wire closed, clock pinned</h1>
   <div class="g">${rows.map((r) => tile(r, contrast(r))).join('')}</div>
   <h1>pre-registered assertions</h1>
   <ul>${checks
     .map(
       (c) =>
         `<li class="${c.pass ? '' : 'f'}">${c.pass ? 'pass' : 'FAIL'} · ${c.id} · ${c.claim}<br>&nbsp;&nbsp;${c.note}</li>`,
     )
     .join('')}</ul>`,
)
const sheet = await (
  await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  })
).newPage({ viewport: { width: 1500, height: 900 } })
await sheet.goto(`file://${process.cwd()}/${OUT}/lighting-ab.html`, { waitUntil: 'networkidle' })
await sheet.screenshot({ path: `${OUT}/lighting-ab.png`, fullPage: true })
await sheet.context().browser().close()
console.log(`\n  sheet: ${OUT}/lighting-ab.png`)
