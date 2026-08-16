/**
 * §37.3, re-registered under §41.2: the standing chunk admission suite. Every
 * chunk queues through this before its region seat.
 *
 * The first registration compared a feasibility prediction against per-seed
 * dark and conflated two things a feasibility test cannot see by
 * construction: a CAPITAL CEILING (rate-viable stock no agent can ever
 * afford — brooklyn's waterfront assets out-rank touched stock) and a BUDGET
 * BAND (stochastic rotation of which mid-size stock goes dark per seed). A
 * gap threshold on the raw number guarantees findings that are noise.
 *
 * Re-registration (§41.2), applied to seated chunks and all future ones:
 *
 *   admission compares   predicted-unviable            vs  stable dark
 *                        (income + conversion + site       (dark in EVERY
 *                         all infeasible at day 0)          seed)
 *   reports separately   budget-band width   (per-seed dark above the stable
 *                                             core, min..max)
 *                        capital-ceiling set (stable dark at or above median
 *                                             day-0 cap rank: rate-viable,
 *                                             never affordable, enumerated)
 *
 * The gate (§32) is the ruler: runs gated, dark measured over in-market
 * stock. §18.2 correlations with the §34 vacuity guard and the
 * enumerated-vs-chosen split stay as registered.
 *
 * PRE-REGISTERED thresholds:
 *   FINDING if |predicted-unviable - stable dark| > 0.15 over in-market stock
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
 * Day-0 probe under the gate: in-market stock, the three-leg §41.2 viability
 * (income, conversion, site), and the best cap for the rank read.
 */
function probeDayZero(): {
  inMarket: Set<string>
  unviable: Set<string>
  cap: Map<string, number>
  area: Map<string, number>
  accessCv: number
} {
  const probe = new Simulation(seed, new MemoryStore(), { agentCount: 0, seed: 'admission' })
  const w = probe.world
  const RATE = 365
  const inMarket = new Set<string>()
  const unviable = new Set<string>()
  const cap = new Map<string, number>()
  const area = new Map<string, number>()
  const access: number[] = []
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing') continue
    const parcel = w.parcelOf(b)
    if (!parcel) continue
    access.push(parcel.accessScore)
    if (!parcel.developable) continue
    inMarket.add(b.id)
    const price = acquisitionPrice(w, b)
    const capIncome = (b.yieldPerTick * RATE) / Math.max(1, price)
    let capConvert = Number.NEGATIVE_INFINITY
    for (const t of ['residential', 'retail', 'commercial', 'office'] as const) {
      if (t === b.purpose) continue
      const y = yieldPerTick(w, { ...b, purpose: t, condition: Math.max(b.condition, 0.85) })
      capConvert = Math.max(capConvert, (y * RATE) / Math.max(1, price + conversionCost(b)))
    }
    // §41.2 site leg: the land under it can itself justify the acquisition
    const siteFeasible = parcel.landValue > 0
    if (capIncome <= 0 && capConvert <= 0 && !siteFeasible) unviable.add(b.id)
    cap.set(b.id, Math.max(capIncome, capConvert))
    area.set(b.id, b.areaM2)
  }
  const mean = access.reduce((a, b) => a + b, 0) / Math.max(1, access.length)
  const sd = Math.sqrt(
    access.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, access.length),
  )
  return { inMarket, unviable, cap, area, accessCv: mean ? sd / mean : 0 }
}

const day0 = probeDayZero()
const predictedUnviable =
  day0.inMarket.size > 0 ? day0.unviable.size / day0.inMarket.size : 1
const ranked = [...day0.cap.entries()].sort((a, b) => a[1] - b[1])
const pctile = new Map(ranked.map(([id], i) => [id, i / Math.max(1, ranked.length - 1)]))

console.log(
  `# §37.3/§41.2 admission — ${CHUNK}, ${SEEDS} seeds, budget ${DECISION_BUDGET}, gate ${BOUNDARY.gate ? 'on' : 'OFF'}`,
)
console.log(
  `#   manifest: viableShare ${health?.viableShare ?? 'ABSENT'}  viableIncomeOnly ${health?.viableIncomeOnly ?? 'ABSENT'}  ownableShare ${health?.ownableShare ?? 'ABSENT'}`,
)
console.log(`#   in-market stock at day 0: ${day0.inMarket.size} buildings (gate holds out the rest)`)
console.log(
  `#   predicted-unviable (three legs, §41.2): ${(predictedUnviable * 100).toFixed(1)}%  ` +
    `(access cv ${day0.accessCv.toFixed(3)}${day0.accessCv < 0.05 ? ' — r_access NOT EVALUABLE, §34 step 1' : ''})`,
)

const darkCount = new Map<string, number>()
const perSeedDark: number[] = []
const rAccess: number[] = []
const rValue: number[] = []
const rAdjacency: number[] = []
const enumDark: number[] = []
const enumTouched: number[] = []
const enumById = new Map<string, number>()

for (let i = 0; i < SEEDS; i++) {
  const s = await runSeed(seed, `admit-${i}`)
  const untouched = new Set(s.untouchedIds)
  let darkInMarket = 0
  for (const id of day0.inMarket) {
    if (untouched.has(id)) {
      darkInMarket++
      darkCount.set(id, (darkCount.get(id) ?? 0) + 1)
    }
    enumById.set(id, Math.max(enumById.get(id) ?? 0, s.enumeratedByBuilding[id] ?? 0))
  }
  perSeedDark.push(day0.inMarket.size ? darkInMarket / day0.inMarket.size : 0)
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
    `#   seed ${i}: dark ${(perSeedDark[i] * 100).toFixed(1)}%  r_access ${s.correlations.access.toFixed(3)}`,
  )
}

// §41.2: stable dark is dark in EVERY seed
const stableDark = [...day0.inMarket].filter((id) => (darkCount.get(id) ?? 0) === SEEDS)
const stableShare = day0.inMarket.size ? stableDark.length / day0.inMarket.size : 0
const gap = Math.abs(predictedUnviable - stableShare)
const enumRatio = median(enumTouched) > 0 ? median(enumDark) / median(enumTouched) : 1

// the two separately-reported quantities
const bandWidths = perSeedDark.map((d) => d - stableShare)
const ceiling = stableDark.filter((id) => (pctile.get(id) ?? 0) >= 0.5)
const ceilingAreas = ceiling.map((id) => day0.area.get(id) ?? 0)
const ceilingEnum = ceiling.map((id) => enumById.get(id) ?? 0)

console.log('# admission record (§41.2)')
console.log(`#   stable dark (dark in ${SEEDS}/${SEEDS} seeds)   ${(stableShare * 100).toFixed(1)}%  (${stableDark.length} buildings)`)
console.log(`#   predicted-unviable                 ${(predictedUnviable * 100).toFixed(1)}%   gap ${(gap * 100).toFixed(1)} pts`)
console.log(
  `#   budget band (per-seed dark above stable core)  median ${(median(bandWidths) * 100).toFixed(1)} pts  ` +
    `range ${(Math.min(...bandWidths) * 100).toFixed(1)}..${(Math.max(...bandWidths) * 100).toFixed(1)}`,
)
console.log(
  `#   capital-ceiling set (stable dark, cap rank >= 0.5)  ${ceiling.length} buildings  ` +
    `median area ${median(ceilingAreas).toFixed(0)} m2  median enumerated ${median(ceilingEnum)}`,
)
console.log(
  `#   §18.2 correlations          access ${median(rAccess).toFixed(3)}${day0.accessCv < 0.05 ? ' (NOT EVALUABLE)' : ''}  ` +
    `landValue ${median(rValue).toFixed(3)}  adjacency ${median(rAdjacency).toFixed(3)}`,
)
console.log(
  `#   enumerated-vs-chosen        dark stock enumerated at ${(enumRatio * 100).toFixed(0)}% of touched stock's median`,
)

const findings: string[] = []
if (!health?.viableShare) findings.push('manifest lacks viability prediction; re-emit before admission')
if (gap > 0.15)
  findings.push(`predicted-unviable/stable-dark gap ${(gap * 100).toFixed(1)} pts exceeds 15`)
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
