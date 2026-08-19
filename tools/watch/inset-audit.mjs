/**
 * §65.2's inset bound, audited on every camera path rather than on free orbit.
 *
 * The §62.2 fuzz drives the camera by hand and SETTLES before it measures. A
 * settled state is bounded — `settle()` calls `enforce()` — so the fuzz can
 * only ever find states the rig has already finished correcting. The reported
 * production frame is not a settled state: it is a camera part-way through a
 * move, and that is a region no harness has ever sampled.
 *
 * So this one steps the rig itself, at a fixed 1/60 s, sampling every step
 * through the transition. Stepping rather than waiting matters: under the
 * sandbox's software renderer the page runs near 1 fps and the rig's damping
 * is dt-driven, so a wall-clock wait samples a camera that has barely moved.
 * The question here is about the rig's arithmetic, not about pixels, and the
 * rig is deterministic — so drive it directly and let the renderer sit out.
 *
 * Per step, three numbers:
 *
 *   black      — of a grid of rays through the frame, the share that miss the
 *                DRAWN plate: past its edge, or above the horizon. This is the
 *                wedge in the reported frame, counted.
 *   offFabric  — the share whose ground hit is outside the fabric box. Ground
 *                without city on it; legitimate at the whole-plate framing,
 *                not at a street one.
 *   shortfall  — how much more inset the LIVE camera needed than `enforce`
 *                applied. `visibleGroundHalf()` reads `desiredDistance`; the
 *                camera is at `distance`. When a move is flying inward those
 *                are different numbers and the bound is computed for the one
 *                the shot is not at yet.
 *
 * All three are printed because a bound that is arithmetically wrong and
 * visually harmless is a different finding from one that shows.
 *
 *   node tools/watch/inset-audit.mjs [chunk]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const OUT = 'tools/watch/evidence/71'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`
/** 10 seconds of camera at 60 fps — longer than any move the director makes */
const STEPS = 600

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(`${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
await page.evaluate(() => document.getElementById('watchBtn')?.click())
// let a world arrive, so the fabric box is the measured city rather than a default
await page.waitForTimeout(8000)

await page.evaluate(() => {
  const civ = window.civ
  const V = civ.three.Vector3
  const rig = civ.rig

  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const clamp01 = (t) => Math.max(0, Math.min(1, t))
  const fovAt = (d) => {
    const l = rig.lens
    const t = clamp01((d - l.streetDistance) / (l.cityDistance - l.streetDistance))
    return l.streetFov + (l.cityFov - l.streetFov) * easeInOutCubic(t)
  }
  const halfGround = (d) => d * Math.tan(((fovAt(d) / 2) * Math.PI) / 180)

  const N = 13
  const scratch = new V()
  function sample() {
    const cam = rig.camera
    const gy = civ.plate.groundY
    const he = civ.plate.halfExtent
    const { panCentreX: cx, panCentreZ: cz, panHalfX: hx, panHalfZ: hz } = rig.limits
    let black = 0
    let off = 0
    let tot = 0
    /**
     * How far past the fabric's edge the frame's ground footprint actually
     * reaches, in metres. `black`/`off` are shares of the frame and answer "how
     * much of the picture is not city"; this answers "does the bound hold",
     * which is a different question with a different unit. A perspective
     * frustum meets the ground in a TRAPEZOID that runs away from the camera,
     * and `d * tan(fov/2)` is the half-width of a square — so the two can
     * disagree, and this is what says by how much.
     */
    let reach = -Infinity
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        tot++
        scratch.set(-1 + (2 * (ix + 0.5)) / N, -1 + (2 * (iy + 0.5)) / N, 0.5)
        scratch.unproject(cam)
        scratch.sub(cam.position).normalize()
        if (scratch.y > -1e-6) {
          black++
          off++
          continue
        }
        const t = (gy - cam.position.y) / scratch.y
        const px = cam.position.x + scratch.x * t
        const pz = cam.position.z + scratch.z * t
        if (Math.abs(px) > he || Math.abs(pz) > he) black++
        if (Math.abs(px - cx) > hx || Math.abs(pz - cz) > hz) off++
        // a ray that lands absurdly far away is grazing the horizon; it says
        // nothing useful about the bound and would swamp the maximum
        if (Math.abs(px - cx) < hx * 40 && Math.abs(pz - cz) < hz * 40) {
          reach = Math.max(reach, Math.abs(px - cx) - hx, Math.abs(pz - cz) - hz)
        }
      }
    }
    return { black: black / tot, off: off / tot, reach: reach === -Infinity ? 0 : reach }
  }

  /**
   * Step the rig itself. `takeControl` is deliberately NOT called: the point is
   * to measure the director's own path, and the director only ever calls
   * `flyTo`, which this drives to completion regardless of who issued it.
   */
  window.__auditRun = (steps) => {
    const trace = []
    for (let i = 0; i < steps; i++) {
      rig.update(1 / 60)
      const s = sample()
      trace.push({
        d: rig.distance,
        dd: rig.desiredDistance,
        used: halfGround(rig.desiredDistance),
        need: halfGround(rig.distance),
        slackX: rig.limits.panHalfX - Math.abs(rig.target.x - rig.limits.panCentreX),
        slackZ: rig.limits.panHalfZ - Math.abs(rig.target.z - rig.limits.panCentreZ),
        polar: rig.polar,
        black: s.black,
        off: s.off,
        reach: s.reach,
        oob: rig.outOfBounds().length,
      })
    }
    return trace
  }

  /** the fabric's own corner: where §65.2's bound is load-bearing */
  window.__auditCorner = () => {
    const [hxc, hyc] = civ.plate.city.half
    const [cx, cy] = civ.plate.city.centre
    return [cx + hxc * 0.98, cy + hyc * 0.98]
  }
})

const paths = [
  {
    label: 'first load → corner',
    setup: () => {
      const civ = window.civ
      civ.plate.home(true)
      const [x, y] = window.__auditCorner()
      civ.director.enqueue({ kind: 'follow_road', x, y }, 250)
      // the director issues the move on its own update; issue it here directly
      // so the trace starts at the cut rather than at whatever pacing allows
      civ.rig.flyTo(civ.pointAt(x, y), 280, { polar: 0.7, duration: 7.5 })
    },
  },
  {
    label: 'home',
    setup: () => {
      const [x, y] = window.__auditCorner()
      window.civ.rig.flyTo(window.civ.pointAt(x, y), 118, { polar: 0.97, duration: 1 })
      window.civ.rig.settle()
      window.civ.plate.home(false)
    },
  },
  ...[
    { name: 'road', d: 280, p: 0.7 },
    { name: 'assembly', d: 330, p: 0.72 },
    { name: 'district', d: 640, p: 0.58 },
    { name: 'before / after', d: 520, p: 0.64 },
    { name: 'demolition', d: 300, p: 0.62 },
    { name: 'construction', d: 175, p: 0.88 },
    { name: 'agent', d: 118, p: 0.97 },
  ].map(({ name, d, p }) => ({
    label: `director: ${name}`,
    /** from the framed whole-plate view, which is where every cut starts */
    setup: ({ d, p }) => {
      const civ = window.civ
      civ.plate.home(true)
      const [x, y] = window.__auditCorner()
      civ.rig.flyTo(civ.pointAt(x, y), d, { polar: p, duration: 3.2 })
    },
    args: { d, p },
  })),
  {
    label: 'follow (agent, from street)',
    setup: () => {
      const civ = window.civ
      const [x, y] = window.__auditCorner()
      civ.rig.flyTo(civ.pointAt(x, y), 118, { polar: 0.97, duration: 1 })
      civ.rig.settle()
      // a follow re-aims at a moving subject without changing the framing
      civ.rig.flyTo(civ.pointAt(x * 0.6, y * 0.6), 118, { polar: 0.97, duration: 2.4 })
    },
  },
]

const rows = []
for (const p of paths) {
  await page.evaluate(
    ({ src, args }) => {
      // eslint-disable-next-line no-new-func
      new Function('a', `return (${src})(a)`)(args)
    },
    { src: p.setup.toString(), args: p.args ?? null },
  )
  const trace = await page.evaluate((n) => window.__auditRun(n), STEPS)
  const maxBlack = Math.max(...trace.map((r) => r.black))
  const maxOff = Math.max(...trace.map((r) => r.off))
  const shortfall = Math.max(...trace.map((r) => Math.max(0, r.need - r.used)))
  const worstSlack = Math.min(...trace.map((r) => Math.min(r.slackX, r.slackZ) - r.need))
  const maxReach = Math.max(...trace.map((r) => r.reach))
  const reachAtRest = trace[trace.length - 1].reach
  const oob = trace.filter((r) => r.oob > 0).length
  const blackAtRest = trace[trace.length - 1].black
  rows.push({
    label: p.label,
    maxBlack,
    maxOff,
    shortfall,
    worstSlack,
    maxReach,
    reachAtRest,
    oob,
    blackAtRest,
  })
}
await browser.close()

console.log(`\n§65.2 inset audit — ${CHUNK}, ${STEPS} rig steps per path\n`)
console.log(
  '  path                        max black   at rest   inset shortfall   worst slack   reach past edge   at rest   oob',
)
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(27)} ${(r.maxBlack * 100).toFixed(1).padStart(8)}%  ${(
      r.blackAtRest * 100
    )
      .toFixed(1)
      .padStart(7)}%   ${r.shortfall.toFixed(0).padStart(14)}m   ${r.worstSlack
      .toFixed(0)
      .padStart(10)}m   ${r.maxReach.toFixed(0).padStart(14)}m   ${r.reachAtRest
      .toFixed(0)
      .padStart(7)}m   ${String(r.oob).padStart(3)}`,
  )
}
const worst = rows.reduce((a, b) => (b.maxBlack > a.maxBlack ? b : a))
console.log(
  `\n  worst: ${worst.label} — ${(worst.maxBlack * 100).toFixed(1)}% of frame past the drawn plate`,
)
console.log(
  `  'inset shortfall' is how much more ground the live camera sees than the bound was computed for.`,
)
console.log(
  `  'worst slack' is (edge distance - ground the shot can see); negative means the bound itself is violated.`,
)
console.log(
  `  'reach past edge' is how far the frame's ground footprint ACTUALLY runs past the fabric box, in metres.`,
)
await writeFile(`${OUT}/inset-audit.json`, JSON.stringify({ chunk: CHUNK, rows }, null, 2))
console.log(`  ${OUT}/inset-audit.json`)
