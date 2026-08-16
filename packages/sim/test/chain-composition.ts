/**
 * §37.2: the chain-flow KNOWN, settled by composition rather than rate.
 *
 * Chain flow fell 5.3 -> 2.4 per 10k when the third use (buy-to-convert,
 * §37.1) entered the acquisition score. The rate cannot answer whether that is
 * crowding-out or the honest price of a fuller market, because the denominator
 * changed meaning when conversions entered it. This instrument runs the same
 * seeds through both engines — THIRD_USE on and off, the §30.3 mutable-toggle
 * pattern, no mixed code — and reports composition:
 *
 *   absolute completed chains per run          not per 10k decisions
 *   completions on conversion-viable ground    true competition for the site
 *   completions on conversion-nonviable ground should be unchanged; if this
 *                                              fell, something else moved
 *   median land value ratio of chain sites     where the surviving chains sit
 *
 * Ground is conversion-viable when, at day 0, a standing baseline building on
 * the assembly's parcels clears the manifest's own capConvert formula
 * (converted yield over price plus conversion cost, §34) — the same predictor
 * `viableIncomeOnly` is derived from, so the split is auditable against the
 * artifact rather than against a judgement.
 *
 * DEGENERACY, found at smoke and recorded before the measurement run: a
 * completed chain requires clearedAfter, which requires standing stock on the
 * ground, and capConvert > 0 holds for essentially all standing stock — so
 * every completed chain sits on "viable" ground by construction and the
 * nonviable cell is structurally empty. The pre-registered split stays and is
 * reported (its emptiness is itself the fact that conversion competes for all
 * chain ground here), and a second, competitive split is reported alongside:
 * ground where conversion was strictly the better project at day 0
 * (capConvert > capIncome, the §34 differential class the third use
 * unlocked). The verdict keys on composition across both, stated explicitly.
 *
 * PRE-REGISTERED (§37.2, before running):
 *   honest price   chains fell only where conversion competed for the ground;
 *                  absolute chains on nonviable ground held; surviving chain
 *                  sites sit at or above the old land-value ratio.
 *                  -> accept 2.4, restate the bar on composition.
 *   crowding-out   chains fell on nonviable ground too.
 *                  -> budget-allocation artifact; fix decision ordering or
 *                  capital gating, never scores (§21.2).
 * Operator prediction on record: the honest price.
 *
 *   node packages/sim/test/chain-composition.ts [chunk] [seeds]
 */
import { MemoryStore } from '@civ/persistence'
import { Simulation } from '@civ/sim'
import { acquisitionPrice, conversionCost, yieldPerTick } from '@civ/sim/economy.ts'
import { BOUNDARY, THIRD_USE } from '@civ/sim/state.ts'
import { DECISION_BUDGET, loadSeed } from './lib/summarise.ts'

// §32: the gated ruler is the ruler. The 5.3 -> 2.4 KNOWN was measured with
// the boundary gate on, so the composition runs under the same configuration.
BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const SEEDS = Number(process.argv[3] ?? 8)

const seed = await loadSeed(CHUNK)

/**
 * Day-0 conversion-viability per parcel, manifest formula (§34). Computed once
 * on an untouched world; the ground's character, not the run's.
 */
function convertViableParcels(): { viable: Set<string>; preferred: Set<string> } {
  const probe = new Simulation(seed, new MemoryStore(), { agentCount: 0, seed: 'viability' })
  const w = probe.world
  const RATE = 365
  const viable = new Set<string>()
  const preferred = new Set<string>()
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing' || !b.parcelId) continue
    const price = acquisitionPrice(w, b)
    const capIncome = (b.yieldPerTick * RATE) / Math.max(1, price)
    let capConvert = Number.NEGATIVE_INFINITY
    for (const t of ['residential', 'retail', 'commercial', 'office'] as const) {
      if (t === b.purpose) continue
      const y = yieldPerTick(w, { ...b, purpose: t, condition: Math.max(b.condition, 0.85) })
      const c = (y * RATE) / Math.max(1, price + conversionCost(b))
      if (c > capConvert) capConvert = c
    }
    if (capConvert > 0) viable.add(b.parcelId)
    if (capConvert > capIncome) preferred.add(b.parcelId)
  }
  return { viable, preferred }
}

interface ArmRun {
  completed: number
  onViable: number
  onNonviable: number
  onPreferred: number
  offPreferred: number
  landValueRatios: number[]
  consolidated: number
  conversions: number
}

async function runArm(
  rng: string,
  thirdUse: boolean,
  ground: { viable: Set<string>; preferred: Set<string> },
): Promise<ArmRun> {
  THIRD_USE.on = thirdUse
  const store = new MemoryStore()
  const sim = new Simulation(seed, store, { agentCount: 58, seed: rng })
  await sim.runToDecisionBudget(DECISION_BUDGET)
  THIRD_USE.on = true

  const w = sim.world
  const done = w.assemblies.filter((a) => a.clearedAfter && a.developedAfter)
  const onViable = done.filter((a) => a.parcelIds.some((p) => ground.viable.has(p)))
  const onPreferred = done.filter((a) => a.parcelIds.some((p) => ground.preferred.has(p)))
  let conversions = 0
  for (const e of store.events({ limit: 1e9 })) if (e.type === 'building_converted') conversions++
  return {
    completed: done.length,
    onViable: onViable.length,
    onNonviable: done.length - onViable.length,
    onPreferred: onPreferred.length,
    offPreferred: done.length - onPreferred.length,
    landValueRatios: done.map((a) => a.landValueRatio),
    consolidated: w.assemblies.filter((a) => a.spannedByOneBuilding > 1).length,
    conversions,
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const ground = convertViableParcels()

/**
 * §41.1 standing rule: a pre-registered split gets a power check — assert the
 * discriminating cell can be populated on the fabric it will run against,
 * BEFORE the run. Here the cell is "completed chains on conversion-nonviable
 * ground", and a completed chain needs standing stock on its parcels, so the
 * cell is populatable only if standing stock exists outside the viable set.
 * An empty cell discovered after is a wasted run; --force runs anyway for
 * explicitly exploratory measurement.
 */
{
  const probe = new Simulation(seed, new MemoryStore(), { agentCount: 0, seed: 'power' })
  let standingNonviable = 0
  for (const b of probe.world.buildings.values()) {
    if (b.state === 'standing' && b.parcelId && !ground.viable.has(b.parcelId)) standingNonviable++
  }
  if (standingNonviable === 0 && !process.argv.includes('--force')) {
    console.log(`# POWER CHECK FAILED (§41.1): no standing stock outside the conversion-viable`)
    console.log(`#   set on ${CHUNK} — the nonviable cell cannot be populated and the split`)
    console.log(`#   cannot discriminate. Not running. Pass --force for exploratory arms.`)
    process.exit(1)
  }
  console.log(`# power check: ${standingNonviable} standing buildings on conversion-nonviable ground`)
}

console.log(`# §37.2 chain composition — ${CHUNK}, ${SEEDS} paired seeds, budget ${DECISION_BUDGET}`)
console.log(
  `#   conversion-viable ground at day 0 (capConvert>0): ${ground.viable.size} of ${seed.parcels.length} parcels ` +
    `(${((ground.viable.size / Math.max(1, seed.parcels.length)) * 100).toFixed(1)}%)`,
)
console.log(
  `#   conversion-preferred ground (capConvert>capIncome, §34 differential): ${ground.preferred.size} parcels ` +
    `(${((ground.preferred.size / Math.max(1, seed.parcels.length)) * 100).toFixed(1)}%)`,
)

const before: ArmRun[] = []
const after: ArmRun[] = []
for (let i = 0; i < SEEDS; i++) {
  const rng = `chain-${i}`
  before.push(await runArm(rng, false, ground))
  after.push(await runArm(rng, true, ground))
  const b = before[i]
  const a = after[i]
  console.log(
    `#   seed ${i}  before ${b.completed} chains (${b.onPreferred} conv-preferred / ${b.offPreferred} not)  ` +
      `after ${a.completed} (${a.onPreferred} / ${a.offPreferred})  ` +
      `conversions ${b.conversions} -> ${a.conversions}`,
  )
}

function tabulate(arm: ArmRun[], name: string): void {
  console.log(`# ${name}`)
  console.log(`#   completed chains per run       median ${median(arm.map((r) => r.completed))}  (${arm.map((r) => r.completed).join(', ')})`)
  console.log(`#   on conversion-viable ground    median ${median(arm.map((r) => r.onViable))}  (${arm.map((r) => r.onViable).join(', ')})`)
  console.log(`#   on nonviable ground            median ${median(arm.map((r) => r.onNonviable))}  (${arm.map((r) => r.onNonviable).join(', ')})`)
  console.log(`#   on conv-preferred ground       median ${median(arm.map((r) => r.onPreferred))}  (${arm.map((r) => r.onPreferred).join(', ')})`)
  console.log(`#   off conv-preferred ground      median ${median(arm.map((r) => r.offPreferred))}  (${arm.map((r) => r.offPreferred).join(', ')})`)
  console.log(`#   land value ratio of chain sites median ${median(arm.flatMap((r) => r.landValueRatios)).toFixed(2)}`)
  console.log(`#   assemblies consolidated        median ${median(arm.map((r) => r.consolidated))}`)
  console.log(`#   conversions per run            median ${median(arm.map((r) => r.conversions))}`)
}

tabulate(before, 'before the third use (THIRD_USE off)')
tabulate(after, 'after the third use (current engine)')

// paired deltas, the actual question
const dNon = after.map((a, i) => a.onNonviable - before[i].onNonviable)
const dViable = after.map((a, i) => a.onViable - before[i].onViable)
const dOffPreferred = after.map((a, i) => a.offPreferred - before[i].offPreferred)
const dOnPreferred = after.map((a, i) => a.onPreferred - before[i].onPreferred)
const dAll = after.map((a, i) => a.completed - before[i].completed)
const lvBefore = median(before.flatMap((r) => r.landValueRatios))
const lvAfter = median(after.flatMap((r) => r.landValueRatios))
console.log('# paired deltas (after - before), per seed')
console.log(`#   all chains            ${dAll.join(', ')}   median ${median(dAll)}`)
console.log(`#   viable ground         ${dViable.join(', ')}   median ${median(dViable)}`)
console.log(`#   nonviable ground      ${dNon.join(', ')}   median ${median(dNon)}`)
console.log(`#   conv-preferred ground ${dOnPreferred.join(', ')}   median ${median(dOnPreferred)}`)
console.log(`#   off-preferred ground  ${dOffPreferred.join(', ')}   median ${median(dOffPreferred)}`)
console.log(`#   chain-site land value ratio ${lvBefore.toFixed(2)} -> ${lvAfter.toFixed(2)}`)

const beforeNonTotal = before.reduce((n, r) => n + r.onNonviable, 0)
if (beforeNonTotal === 0) {
  console.log('# NOTE: the pre-registered nonviable cell is structurally empty (a completed')
  console.log('#   chain requires standing stock, and all standing stock clears capConvert>0),')
  console.log('#   so that split cannot discriminate here; the competitive split and the land')
  console.log('#   value migration carry the question instead.')
}

// §37.2's two branches, applied to the numbers. The call is composition-led:
// chains holding on ground conversion does not want is the honest-price
// signature; falling there too is crowding-out. "Holding" for a paired count
// this small is a median delta of zero-ish without a systematic one-direction
// drift. Where the pre-registered split is degenerate, the competitive split
// (off-preferred ground) is the operative cell.
const opDeltas = beforeNonTotal === 0 ? dOffPreferred : dNon
const opName = beforeNonTotal === 0 ? 'off-preferred' : 'nonviable'
const opFell = median(opDeltas) < 0 && opDeltas.filter((d) => d < 0).length > SEEDS / 2
const contested = beforeNonTotal === 0 ? dOnPreferred : dViable
const contestedFell = median(contested) < 0
if (!opFell && contestedFell) {
  console.log('# VERDICT: consistent with the HONEST PRICE (operator prediction) —')
  console.log(`#   the decline concentrates where conversion competes for the ground; ${opName}`)
  console.log(`#   chains held (median delta ${median(opDeltas)}), and surviving chain sites moved`)
  console.log(`#   ${lvBefore.toFixed(2)} -> ${lvAfter.toFixed(2)} x median land value.`)
} else if (opFell) {
  console.log(`# VERDICT: CROWDING-OUT signature — chains fell on ${opName} ground too,`)
  console.log('#   which conversion does not want. Fix belongs in decision ordering or capital')
  console.log('#   gating, not in scores (§37.2).')
} else {
  console.log('# VERDICT: NOT EVALUABLE on these splits — contested-ground chains did not fall;')
  console.log('#   the rate change came from somewhere else. Report, do not restyle.')
}
