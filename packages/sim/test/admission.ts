/**
 * §37.3: the standing chunk admission suite. Every chunk queues through this
 * before its region seat — london like any other (§37.4).
 *
 * Three instruments, all §34-shaped, run against the emitted artifact:
 *
 *   §18.2 correlation      does touch correlate with access, land value,
 *                          adjacency — with the §34 vacuity guard: r against a
 *                          near-constant surface is NOT EVALUABLE, not zero
 *   enumerated-vs-chosen   dark stock that is enumerated as often as touched
 *                          stock and chosen never is an economics finding;
 *                          dark stock that is never enumerated is an
 *                          enumeration fault (§34 step 3)
 *   predicted-vs-measured  the manifest's viability numbers against the run:
 *                          a chunk is admitted with a predicted dark share and
 *                          a measured one, and a large gap is a FINDING
 *
 * The gate (§32) is the ruler: runs are gated, and dark is measured over
 * in-market stock — boundary-gated parcels are a known structural exclusion,
 * not a finding. The manifest predicts over all stock, so the predicted dark
 * is recomputed here over the in-market set with the same §34 formulas.
 *
 * PRE-REGISTERED before london's first admission run:
 *   FINDING if |predicted dark - measured dark| > 0.15 over in-market stock
 *   FINDING if dark stock's median enumeration < 25% of touched stock's
 *            (the enumeration-fault signature; §34 found the opposite)
 *   NOT EVALUABLE (note, not a finding) if access cv < 0.05 (§34 step 1)
 * Exit code 1 when findings exist; the print is the admission record.
 *
 *   node packages/sim/test/admission.ts <chunk> [seeds=6]
 */
import { MemoryStore } from '@civ/persistence'
import { Simulation } from '@civ/sim'
import { acquisitionPrice, conversionCost, yieldPerTick } from '@civ/sim/economy.ts'
import { BOUNDARY } from '@civ/sim/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const SEEDS = Number(process.argv[3] ?? 6)

const seed = await loadSeed(CHUNK)
const health = (seed.stats.importHealth ?? null) as {
  viableShare?: number
  viableIncomeOnly?: number
  ownableShare?: number
} | null

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * Day-0 probe under the gate: which buildings are in the market at all, and
 * the §34 viability of each, with the manifest's own formulas.
 */
function probeDayZero(): {
  inMarket: Set<string>
  viable: Set<string>
  accessCv: number
} {
  const probe = new Simulation(seed, new MemoryStore(), { agentCount: 0, seed: 'admission' })
  const w = probe.world
  const RATE = 365
  const inMarket = new Set<string>()
  const viable = new Set<string>()
  const access: number[] = []
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing') continue
    const parcel = w.parcelOf(b)
    if (!parcel) continue
    access.push(parcel.accessScore)
    if (!parcel.developable) continue
    inMarket.add(b.id)
    const price = acquisitionPrice(w, b)
    let cap = (b.yieldPerTick * RATE) / Math.max(1, price)
    for (const t of ['residential', 'retail', 'commercial', 'office'] as const) {
      if (t === b.purpose) continue
      const y = yieldPerTick(w, { ...b, purpose: t, condition: Math.max(b.condition, 0.85) })
      cap = Math.max(cap, (y * RATE) / Math.max(1, price + conversionCost(b)))
    }
    if (cap > 0) viable.add(b.id)
  }
  const mean = access.reduce((a, b) => a + b, 0) / Math.max(1, access.length)
  const sd = Math.sqrt(
    access.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, access.length),
  )
  return { inMarket, viable, accessCv: mean ? sd / mean : 0 }
}

const day0 = probeDayZero()
const predictedDark =
  day0.inMarket.size > 0 ? 1 - day0.viable.size / day0.inMarket.size : 1

console.log(`# §37.3 admission — ${CHUNK}, ${SEEDS} seeds, budget ${DECISION_BUDGET}, gate ${BOUNDARY.gate ? 'on' : 'OFF'}`)
console.log(
  `#   manifest: viableShare ${health?.viableShare ?? 'ABSENT'}  viableIncomeOnly ${health?.viableIncomeOnly ?? 'ABSENT'}  ownableShare ${health?.ownableShare ?? 'ABSENT'}`,
)
console.log(
  `#   in-market stock at day 0: ${day0.inMarket.size} buildings (gate holds out the rest)`,
)
console.log(
  `#   predicted dark over in-market stock: ${(predictedDark * 100).toFixed(1)}%  ` +
    `(access cv ${day0.accessCv.toFixed(3)}${day0.accessCv < 0.05 ? ' — r_access NOT EVALUABLE, §34 step 1' : ''})`,
)

const darks: number[] = []
const rAccess: number[] = []
const rValue: number[] = []
const rAdjacency: number[] = []
const enumDark: number[] = []
const enumTouched: number[] = []

for (let i = 0; i < SEEDS; i++) {
  const s = await runSeed(seed, `admit-${i}`)
  const untouched = new Set(s.untouchedIds)
  // dark over in-market stock: the gate is structure, not finding
  const darkInMarket = [...day0.inMarket].filter((id) => untouched.has(id)).length
  darks.push(day0.inMarket.size ? darkInMarket / day0.inMarket.size : 0)
  rAccess.push(s.correlations.access)
  rValue.push(s.correlations.landValue)
  rAdjacency.push(s.correlations.adjacency)
  const eD: number[] = []
  const eT: number[] = []
  for (const id of day0.inMarket) {
    const n = s.enumeratedByBuilding[id] ?? 0
    if (untouched.has(id)) eD.push(n)
    else eT.push(n)
  }
  enumDark.push(median(eD))
  enumTouched.push(median(eT))
  console.log(
    `#   seed ${i}: dark ${(darks[i] * 100).toFixed(1)}%  r_access ${s.correlations.access.toFixed(3)}  ` +
      `enum dark ${median(eD)} vs touched ${median(eT)}`,
  )
}

const measuredDark = median(darks)
const gap = Math.abs(predictedDark - measuredDark)
const enumRatio = median(enumTouched) > 0 ? median(enumDark) / median(enumTouched) : 1

console.log('# admission record')
console.log(`#   measured dark (in-market)   median ${(measuredDark * 100).toFixed(1)}%`)
console.log(`#   predicted dark              ${(predictedDark * 100).toFixed(1)}%   gap ${(gap * 100).toFixed(1)} pts`)
console.log(
  `#   §18.2 correlations          access ${median(rAccess).toFixed(3)}${day0.accessCv < 0.05 ? ' (NOT EVALUABLE)' : ''}  ` +
    `landValue ${median(rValue).toFixed(3)}  adjacency ${median(rAdjacency).toFixed(3)}`,
)
console.log(
  `#   enumerated-vs-chosen        dark stock enumerated at ${(enumRatio * 100).toFixed(0)}% of touched stock's median`,
)

const findings: string[] = []
if (!health?.viableShare) findings.push('manifest lacks viability prediction; re-emit before admission')
if (gap > 0.15) findings.push(`predicted/measured dark gap ${(gap * 100).toFixed(1)} pts exceeds 15`)
if (enumRatio < 0.25)
  findings.push(
    `dark stock enumerated at ${(enumRatio * 100).toFixed(0)}% of touched — enumeration-fault signature (§34 step 3)`,
  )

if (findings.length === 0) {
  console.log(`# ADMITTED: ${CHUNK} — no findings`)
} else {
  console.log(`# FINDINGS (${findings.length}) — not admitted until each is named a mechanism or accepted:`)
  for (const f of findings) console.log(`#   FINDING: ${f}`)
  process.exitCode = 1
}
