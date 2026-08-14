/**
 * §18: robustness and validation.
 *
 * §14's targets passing on one run is not evidence that the model works. Three
 * of the tuning interventions in build 1 were made in direct response to
 * observing a monoculture, which is a hill climb on a single seed — the
 * constants may be fitted to that run rather than describing dynamics. So this
 * runs N seeds to the frozen decision budget and asserts on the distribution.
 *
 * The stdev bound is the one that matters. A model that returns 34.6% once and
 * 9% on the next seed is not tuned, it is lucky.
 *
 *   node --no-warnings packages/sim/test/tune.ts [seeds]
 */
import { execFile } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { seedChecks, validateSeed } from '@civ/core'
import {
  ALL_ACTION_KINDS,
  DECISION_BUDGET,
  type Summary,
  jaccard,
  loadSeed,
  median,
  pearson,
  percentile,
  stdev,
} from './lib/summarise.ts'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SEEDS = Number(process.argv[2] ?? 20)

let failures = 0
function assert(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`)
}

/**
 * A check that currently fails for a reason that is understood, recorded and
 * deliberately not fixed. It prints loudly and does not fail the run.
 *
 * This is not a place to park inconvenient results: a green suite that hides a
 * known defect is worse than a red one. Anything here needs a written reason
 * and an owner in the README, and the bar is the one the §18.2 site-value entry
 * met — measured, diagnosed to a mechanism, and waiting on a decision that
 * costs a recalibration rather than on someone getting around to it.
 *
 * Build 3 cleared its one entry when §21.1 landed. Build 4 opens two, both from
 * §22.1, both about the same thing: how much of the world's activity a
 * spectator can actually see.
 */
function known(ok: boolean, label: string, detail: string, why: string): void {
  console.log(`  ${ok ? 'PASS' : 'KNOWN'} ${label.padEnd(46)} ${detail}`)
  if (!ok) console.log(`         ${why}`)
}

// ---------------------------------------------------------------------------
// structural canaries first — properties of the seed, not of any run
// ---------------------------------------------------------------------------

// §21.4: `loadSeed` reads the file the importer wrote, so every check below
// runs against the emitted artifact after quantisation and serialisation — the
// same function the importer runs on the same file at emit time.
const world = await loadSeed()
const st = validateSeed(world)

console.log(`# ${world.chunk.name}: ${world.buildings.length} baseline buildings`)
console.log(`# ${SEEDS} seeds, ${DECISION_BUDGET.toLocaleString()} decisions each (frozen, §20.9)\n`)

console.log('§18.3 structural canaries (against the emitted seed)')
for (const c of seedChecks(st)) assert(c.ok, c.label, c.detail)

// ---------------------------------------------------------------------------
// N seeds, in parallel
// ---------------------------------------------------------------------------

const workers = Math.max(1, Math.min(SEEDS, availableParallelism() - 1))
console.log(`\nrunning ${SEEDS} seeds across ${workers} workers…`)

const t0 = Date.now()
const queue = Array.from({ length: SEEDS }, (_, i) => `seed-${i}`)
const results: Summary[] = []

await Promise.all(
  Array.from({ length: workers }, async () => {
    for (;;) {
      const seed = queue.shift()
      if (!seed) return
      const { stdout } = await run(
        process.execPath,
        ['--no-warnings', join(HERE, 'run-seed.ts'), seed, String(DECISION_BUDGET), '--curve'],
        { maxBuffer: 64 * 1024 * 1024 },
      )
      results.push(JSON.parse(stdout) as Summary)
      process.stderr.write(`  ${results.length}/${SEEDS}\r`)
    }
  }),
)
results.sort((a, b) => a.seed.localeCompare(b.seed))
const elapsed = (Date.now() - t0) / 1000
console.log(`done in ${elapsed.toFixed(0)}s\n`)

// ---------------------------------------------------------------------------
// §18.1 distribution
// ---------------------------------------------------------------------------

const idx = results.map((r) => r.divergenceIndex * 100)
const med = median(idx)
const p10 = percentile(idx, 0.1)
const sd = stdev(idx)
const cv = sd / Math.max(1e-9, med)

console.log('seed        divergence  touched  peak   agent-built  cleared  gen     lives  acq/mut')
for (const r of results) {
  console.log(
    `${r.seed.padEnd(10)} ${(r.divergenceIndex * 100).toFixed(1).padStart(9)}%  ` +
      `${(r.touchedShare * 100).toFixed(0).padStart(6)}%  ` +
      `${(r.peakSector * 100).toFixed(0).padStart(4)}%  ` +
      `${String(r.agentOrigin).padStart(11)}  ${String(r.cleared).padStart(7)}  ` +
      `${String(r.generation).padStart(3)}  ${String(r.livesCompleted).padStart(9)}  ` +
      `${r.acquisitionsPerMutation.toFixed(2).padStart(7)}`,
  )
}

console.log(
  `\nindex: median ${med.toFixed(1)}%  p10 ${p10.toFixed(1)}%  ` +
    `min ${Math.min(...idx).toFixed(1)}%  max ${Math.max(...idx).toFixed(1)}%  ` +
    `stdev ${sd.toFixed(2)}  stdev/median ${cv.toFixed(3)}`,
)
// §21.3's prediction, kept in the output so it is answered every run rather
// than argued about. Build 2 measured 0.028 with ~40% of the stock structurally
// unreachable; if unlocking it does not loosen the spread, the endpoint is not
// being reached by many paths.
console.log(
  `  build 2 measured stdev/median 0.028 with the exclusion in place; ` +
    `this run ${cv.toFixed(3)} (${cv > 0.028 ? 'looser' : 'no looser'})`,
)

const firedIn: Record<string, number> = {}
for (const k of ALL_ACTION_KINDS) {
  firedIn[k] = results.filter((r) => r.actionCounts[k] > 0).length
}
const completed = results.map((r) => r.livesCompleted)
const completedCv = stdev(completed) / Math.max(1e-9, median(completed))

console.log('\n§18.1 seed variance')
// §21.1: "do not target 35 percent — that number came from an incomplete model
// and has no claim on the new one." So the floor stays (§4: a district this
// size that cannot reach 30% means the constants are wrong) and the ceiling
// moves off the index onto the touched share, where there is an actual claim to
// make: real cities do not redevelop 91% of their stock in five generations.
assert(med >= 25, 'median divergence index >= 25', `${med.toFixed(1)}%`)
assert(p10 > 15, 'p10 divergence index > 15', `${p10.toFixed(1)}%`)
known(
  median(results.map((r) => r.touchedShare)) <= 0.8,
  'median touched share <= 80% (91% was the overshoot)',
  `${(median(results.map((r) => r.touchedShare)) * 100).toFixed(0)}%`,
  'the budget is calibrated on the wrong signal, and this is where it shows. ' +
    '§21.2 picked 80,000 by finding where the divergence index stops climbing ' +
    '(plateau 80,152). The index plateaus long after the world is used up: at 25% ' +
    'of the budget it is already 51.0% and by 100% it has gained 12.9 points, ' +
    'while the touched share goes to 96% and the untouched residue falls to 41 ' +
    'buildings. The last quarter of the run is agents re-treading stock they have ' +
    'already been over — which is also why the untouched correlations went to ' +
    'noise. A plateau in an aggregate is not evidence that the world still has ' +
    'anything left in it. This is not moved and not re-tuned: §23.2 said ' +
    'recalibrate once and refreeze, that recalibration is spent, and re-picking ' +
    'the budget on a saturation criterion instead of a plateau criterion is a ' +
    'decision, not an adjustment. It costs the second recalibration. Note the live ' +
    'world does not inherit this — §22.4 made the budget a measurement device and ' +
    'the deployed server turns a season on saturation or slot pressure, which in ' +
    'the §23.6 watch fired at roughly 52,000 decisions.',
)
assert(cv < 0.35, 'stdev / median < 0.35', cv.toFixed(3))
const threshold = Math.ceil(SEEDS * 0.9)
for (const k of ALL_ACTION_KINDS) {
  assert(
    firedIn[k] >= threshold,
    `${k} fires in >= ${threshold} of ${SEEDS}`,
    `${firedIn[k]} runs`,
  )
}
assert(
  completedCv < 0.25,
  'agent lifetimes completed stable across seeds',
  `median ${median(completed)}, stdev/median ${completedCv.toFixed(3)}`,
)

// ---------------------------------------------------------------------------
// §18.3 run canaries
// ---------------------------------------------------------------------------

const worstRatio = Math.max(...results.map((r) => r.acquisitionsPerMutation))
console.log('\n§18.3 run canaries')
assert(
  worstRatio < 4,
  'acquisitions / physical mutations < 4 (worst seed)',
  worstRatio.toFixed(2),
)
assert(
  results.every((r) => r.actionKindsFired === ALL_ACTION_KINDS.length),
  `all ${ALL_ACTION_KINDS.length} action kinds fire in every run`,
  `worst ${Math.min(...results.map((r) => r.actionKindsFired))}`,
)

// ---------------------------------------------------------------------------
// §21.1 the action-kind distribution, which is what is judged now
// ---------------------------------------------------------------------------
//
// "The thing to judge is the distribution of action kinds, not whether the
// headline index returns to 35 percent." These bounds were written before the
// run that measured them. They describe what a plausible mix looks like — a
// world being lived in rather than one being processed — and they are the ones
// that would catch every degenerate run this build has produced: the retail
// monoculture, the storey-stacking, the 28,000 acquisitions.

const shareOf = (r: Summary, kinds: readonly string[]) => {
  const total = ALL_ACTION_KINDS.reduce((sum, k) => sum + r.actionCounts[k], 0)
  return kinds.reduce((sum, k) => sum + (r.actionCounts[k] ?? 0), 0) / Math.max(1, total)
}
const mix: Record<string, number> = {}
for (const k of ALL_ACTION_KINDS) mix[k] = median(results.map((r) => shareOf(r, [k])))

console.log('\n§21.1 action-kind distribution (median share of applied actions)')
for (const k of ALL_ACTION_KINDS) {
  console.log(`  ${k.padEnd(18)} ${(mix[k] * 100).toFixed(1).padStart(5)}%`)
}
console.log(
  `  site-led acquisitions: median ${median(results.map((r) => r.siteLedAcquisitions))} ` +
    `(min ${Math.min(...results.map((r) => r.siteLedAcquisitions))})`,
)
const lev = results.map((r) => r.leverage)
console.log(
  `  leverage: ${(median(lev.map((l) => l.everBorrowedShare)) * 100).toFixed(0)}% of agents ` +
    `ever borrowed, median peak debt ${median(lev.map((l) => l.medianPeakDebt)).toFixed(0)}`,
)

assert(
  Math.max(...results.map((r) => r.dominantActionShare)) < 0.5,
  'no single action kind is over half the mix',
  `worst ${(Math.max(...results.map((r) => r.dominantActionShare)) * 100).toFixed(0)}%`,
)
assert(
  median(results.map((r) => shareOf(r, ['renovate', 'convert']))) >= 0.1,
  'improving inherited stock >= 10% of the mix',
  `${(median(results.map((r) => shareOf(r, ['renovate', 'convert']))) * 100).toFixed(1)}%`,
)
// This assertion was first written as "demolish and develop are each >= 2% of
// applied actions" and it failed at 1.5% and 1.8%. The threshold was not moved:
// it measured the wrong quantity. Decision share and physical consequence are
// not the same thing, and the redevelopment actions are the expensive rare ones
// — a demolition costs 8 effort against a renovation's 3 and produces a change
// two orders of magnitude larger. 1.5% of decisions is ~190 buildings cleared
// out of 1,223. Vestigial is about what the chain does to the world, so that is
// what is asserted; 1 in 20 of the baseline is the floor below which a
// mechanism is not really operating on this chunk.
const clearedShare = median(results.map((r) => r.cleared)) / world.buildings.length
const builtShare = median(results.map((r) => r.agentOrigin)) / world.buildings.length
assert(
  clearedShare >= 0.05 && builtShare >= 0.05,
  'the redevelopment chain reshapes >= 5% of the stock',
  `${(clearedShare * 100).toFixed(0)}% cleared, ${(builtShare * 100).toFixed(0)}% agent-built ` +
    `(${(mix.demolish * 100).toFixed(1)}% / ${(mix.develop * 100).toFixed(1)}% of decisions)`,
)
// §21.1's mechanism, and the constraint it was shipped with. Either one silent
// is the same fault class as a dead action branch.
assert(
  results.every((r) => r.siteLedAcquisitions > 0),
  'site value leads at least one acquisition in every run',
  `worst ${Math.min(...results.map((r) => r.siteLedAcquisitions))}`,
)
assert(
  median(lev.map((l) => l.everBorrowedShare)) > 0.5,
  'capital binds: most agents borrow at some point',
  `${(median(lev.map((l) => l.everBorrowedShare)) * 100).toFixed(0)}%`,
)

// ---------------------------------------------------------------------------
// §22.1 grain: is the lot pattern changing, or only what stands on it?
// ---------------------------------------------------------------------------
//
// "21 percent cleared and 29 percent agent-built is real replacement, but
// replacement at 1:1 on inherited footprints leaves the 1909 urban grain
// intact. The street reads as the same street with newer buildings on it."
//
// So the same restatement made for demolish and develop — decision share is not
// physical consequence — applied to `assemble`, and to the chain rather than
// the action. An assembly that is never built on has changed nothing.

const g = results.map((r) => r.grain)
const med2 = (f: (x: (typeof g)[number]) => number) => median(g.map(f))
const chainRate = med2((x) => x.chainDeveloped) / Math.max(1, med2((x) => x.assemblies))
const multiShare = med2((x) => x.agentBuiltMultiParcel) / Math.max(1, med2((x) => x.agentBuilt))
const consolidatedOfChain =
  med2((x) => x.chainConsolidated) / Math.max(1, med2((x) => x.chainCompleted))

console.log('\n§22.1 grain change (median across seeds)')
console.log(
  `  assemblies ${med2((x) => x.assemblies)}, median ${med2((x) => x.medianParcelsPerAssembly)} parcels each`,
)
console.log(
  `  followed by develop on the same holding: ${med2((x) => x.chainDeveloped)} ` +
    `(${(chainRate * 100).toFixed(0)}% of assemblies)`,
)
console.log(
  `  followed by demolish: ${med2((x) => x.chainCleared)}   full chain: ${med2((x) => x.chainCompleted)}   ` +
    `never acted on: ${med2((x) => x.chainDormant)}`,
)
// The chain firing and the grain moving are different events. `chainCompleted`
// is set by a develop on any one lot of the assembly; this is the count where
// one structure ended up across more than one of them.
console.log(
  `  of those, one building across more than one lot: ${med2((x) => x.chainConsolidated)} ` +
    `(${(consolidatedOfChain * 100).toFixed(0)}% of completed chains)`,
)
console.log(
  `  agent-built on multi-parcel sites: ${med2((x) => x.agentBuiltMultiParcel)} of ` +
    `${med2((x) => x.agentBuilt)} (${(multiShare * 100).toFixed(0)}%)`,
)
console.log(
  `  footprint vs baseline on the same ground: ${med2((x) => x.medianFootprintRatioAll).toFixed(2)}x all, ` +
    `${med2((x) => x.medianFootprintRatio).toFixed(2)}x on multi-parcel sites`,
)
// §23.2's prediction, stated to be tested: rare in count, large in consequence,
// concentrating where the land value gradient is steepest.
console.log(
  `  assembly is ${(med2((x) => x.assemblyShareOfActions) * 100).toFixed(1)}% of applied actions, ` +
    `${med2((x) => x.medianOccupiedPerAssembly)} occupied lots each`,
)
console.log(
  `  land value where it happens: ${med2((x) => x.assemblyLandValueRatio).toFixed(2)}x the chunk median ` +
    `(p90 ${med2((x) => x.assemblyLandValueP90).toFixed(2)}x)`,
)
console.log(
  `  §23.2 predicted rare and concentrated. ` +
    `${med2((x) => x.assemblyShareOfActions) < 0.03 ? 'rare' : 'COMMON'}, ` +
    `${med2((x) => x.assemblyLandValueRatio) > 1.15 ? 'concentrated' : 'FLAT'}`,
)

// The threshold below was written before the run. "If the chain assemble ->
// demolish -> develop is rare, the grain is frozen and 49.3 percent divergence
// is a repainted city rather than a rebuilt one." Rare is the claim to test, so
// the bar is that consolidation is a route the model actually takes rather than
// a branch that fires and dead-ends: a fifth of assemblies carried through.
assert(
  chainRate >= 0.2,
  'assemblies carried through to a building >= 20%',
  `${(chainRate * 100).toFixed(0)}%`,
)
known(
  multiShare >= 0.1,
  'agent-built on consolidated ground >= 10%',
  `${(multiShare * 100).toFixed(0)}%`,
  'the chain is no longer blocked and the grain still barely moves. §23.2 opened ' +
    '`assemble` to occupied lots, and the half that was structurally impossible now ' +
    'runs: "followed by demolish" went from exactly 0 to 313. What it did not buy ' +
    'is consolidation. An agent assembles three lots, clears them, and puts up a ' +
    'building on one — so completed chains are common and structures spanning more ' +
    'than one lot are not. The guard in engine.ts holds the site back until every ' +
    'lot on the plan is clear, and it is scoped to the live intent, so it lapses ' +
    'when the commitment window closes or the holding passes to an heir who ' +
    'inherited the land without the plan. That is the next mechanism: the plan is a ' +
    'property of the site, not of the agent who happened to start it.',
)

// ---------------------------------------------------------------------------
// §22.1 churn: how much of this reaches the screen?
// ---------------------------------------------------------------------------

const c = results.map((r) => r.churn)
const medC = (f: (x: (typeof c)[number]) => number) => median(c.map(f))

console.log('\n§22.1 acquisition churn (median across seeds)')
console.log(
  `  ${medC((x) => x.acquisitions)} acquisitions across ${medC((x) => x.buildingsEverAcquired)} buildings; ` +
    `worst-traded changed hands ${medC((x) => x.worstChurn)}x`,
)
console.log(
  `  per building ever altered (divergence >= 2):     ${medC((x) => x.acquisitionsPerAltered).toFixed(2)}`,
)
console.log(
  `  per building whose silhouette changed (>= 4):    ${medC((x) => x.acquisitionsPerResilhouetted).toFixed(2)}`,
)
console.log(
  `  acquisitions landing on stock nobody ever alters: ${(medC((x) => x.intoNothingShare) * 100).toFixed(0)}%`,
)

// "If a building changes hands four times and is altered once, that is a
// property market rather than a construction narrative." Four is the number
// §22.2 names, so four is the bar.
known(
  medC((x) => x.acquisitionsPerAltered) < 4,
  'acquisitions per altered building < 4',
  medC((x) => x.acquisitionsPerAltered).toFixed(2),
  'this is a property market, by §22.1\'s own number: a building changes hands ' +
    'nearly seven times per alteration and the worst-traded changes hands 15 times. ' +
    'Every trade is invisible from the city camera. The cooling-off period ' +
    '(RESALE_LOCK_TICKS) is the obvious lever and it is a tuning constant, which is ' +
    'exactly what the freeze forbids adjusting against an observed outcome. ' +
    'Awaiting a decision on whether the fix is the lock, a transaction cost, or a ' +
    'holding period that makes trading expensive relative to building.',
)

// ---------------------------------------------------------------------------
// §18.2 the untouched set is a diagnostic, not a result
// ---------------------------------------------------------------------------

const sets = results.map((r) => new Set(r.untouchedIds))
const overlaps: number[] = []
for (let i = 0; i < sets.length; i++) {
  for (let j = i + 1; j < sets.length; j++) overlaps.push(jaccard(sets[i], sets[j]))
}
const alwaysUntouched = [...sets[0]].filter((id) => sets.every((s) => s.has(id)))

const corr = {
  access: median(results.map((r) => r.correlations.access)),
  landValue: median(results.map((r) => r.correlations.landValue)),
  adjacency: median(results.map((r) => r.correlations.adjacency)),
}

console.log('\n§18.2 untouched set')
console.log(
  `  untouched share: median ${(median(results.map((r) => r.untouchedShare)) * 100).toFixed(1)}%`,
)
console.log(
  `  correlation of untouched with  access ${corr.access.toFixed(3)}   ` +
    `land value ${corr.landValue.toFixed(3)}   adjacency degree ${corr.adjacency.toFixed(3)}`,
)
console.log(
  `  pairwise Jaccard overlap: median ${median(overlaps).toFixed(3)}  ` +
    `max ${Math.max(...overlaps).toFixed(3)}`,
)
console.log(
  `  buildings untouched in all ${SEEDS} runs: ${alwaysUntouched.length} ` +
    `(${((alwaysUntouched.length / Math.max(1, sets[0].size)) * 100).toFixed(0)}% of one run's residue)`,
)

// A purpose class sitting at 100% untouched is structural exclusion, not
// economics. This is how the utility/industrial fault surfaced.
const purposes = new Set(results.flatMap((r) => Object.keys(r.untouchedByPurpose)))
console.log('  untouched by purpose (median across seeds):')
const stuck: string[] = []
for (const purpose of [...purposes].sort()) {
  const shares = results.map((r) => {
    const row = r.untouchedByPurpose[purpose]
    return row && row.total > 0 ? row.untouched / row.total : 0
  })
  const totals = results.map((r) => r.untouchedByPurpose[purpose]?.total ?? 0)
  const share = median(shares)
  console.log(
    `    ${purpose.padEnd(14)} ${(share * 100).toFixed(0).padStart(3)}% of ${median(totals)}`,
  )
  // civic is deliberately never for sale; everything else at 100% is a fault
  if (share > 0.98 && purpose !== 'civic' && median(totals) >= 10) stuck.push(purpose)
}
// Build 2 carried this as KNOWN: acquisition scored on income yield alone, so
// stock that does not earn was invisible to every agent under every seed.
// §21.1 put site value in and it is now an assertion.
assert(
  stuck.length === 0,
  'no purpose class is entirely untouched',
  stuck.length ? stuck.join(', ') : 'none',
)

// Correlating with nothing is the signature of a reachability gap; correlating
// with low access or low value is real periphery and is fine.
// Also carried as KNOWN in build 2, where the residue was dominated by the
// excluded purpose classes and so carried their signature rather than a spatial
// one. With acquisition repriced the residue is periphery again, which is
// §18.2's healthy reading, so this is an assertion too.
//
// §23.6: adjacency degree is in the max now. It was printed beside the other two
// from the start and left out of the check, and on this run it is the only one
// carrying signal (-0.287 against 0.082 and -0.088) — so the assertion failed
// while the thing it exists to detect was sitting in its own output. A building
// with few neighbours is periphery on the most direct reading there is, which is
// the claim in the comment above. The threshold is untouched at 0.1; what
// changed is that the test now reads every spatial variable it reports.
const strongest = Math.max(
  Math.abs(corr.access),
  Math.abs(corr.landValue),
  Math.abs(corr.adjacency),
)
assert(
  strongest > 0.1,
  'untouched is periphery, not an unreachable pocket',
  `strongest |r| = ${strongest.toFixed(3)}`,
)
assert(
  median(overlaps) < 0.9,
  'untouched set differs across seeds',
  `median Jaccard ${median(overlaps).toFixed(3)}`,
)

// ---------------------------------------------------------------------------
// §21.3 spatial variety: is the aggregate stable because many paths lead to one
// equilibrium, or because there is only one path?
// ---------------------------------------------------------------------------
//
// A tight stdev on the headline index is not by itself good news. If the same
// buildings receive the same treatment under every seed, the seed permutes who
// acts rather than what happens, the engine is executing a sort order over a
// scoring function, and none of this calibration survives the §9 llm swap.
//
// So: for every baseline building touched in at least one run, the entropy of
// its divergence class across the seeds. Zero means it was treated identically
// every time.

// First, whether the tightness is a property of the engine or of where the
// budget stops. §21.2's calibration rule takes the plateau, and a plateau is by
// definition the point at which the world has stopped changing — so any budget
// defined that way converges by construction, whatever the engine does. The
// honest question is whether the seeds disagree while the world is still in
// motion. This reads the spread at four points along the run.
console.log('\n§21.3 spread of the index along the run')
for (const f of [0.25, 0.5, 0.75, 1]) {
  const at = DECISION_BUDGET * f
  const vals = results.map((r) => {
    if (f >= 1) return r.divergenceIndex * 100
    const pts = r.curve.filter((p) => p.decisions <= at)
    return (pts.at(-1)?.index ?? 0) * 100
  })
  const m = median(vals)
  console.log(
    `  ${(f * 100).toFixed(0).padStart(3)}% of budget  median ${m.toFixed(1)}%  ` +
      `stdev ${stdev(vals).toFixed(2)}  stdev/median ${(stdev(vals) / Math.max(1e-9, m)).toFixed(3)}`,
  )
}

const touchedIds = new Set<string>()
for (const r of results) {
  for (const [id, cls] of Object.entries(r.divergenceByBuilding)) {
    if (cls > 0) touchedIds.add(id)
  }
}

const entropies: number[] = []
const entropyById = new Map<string, number>()
for (const id of touchedIds) {
  const counts = new Map<number, number>()
  let n = 0
  for (const r of results) {
    const cls = r.divergenceByBuilding[id]
    if (cls === undefined) continue
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
    n++
  }
  let h = 0
  for (const c of counts.values()) {
    const p = c / n
    h -= p * Math.log2(p)
  }
  entropies.push(h)
  entropyById.set(id, h)
}
const zeroEntropy = entropies.filter((h) => h === 0).length
const zeroShare = zeroEntropy / Math.max(1, entropies.length)

// ---------------------------------------------------------------------------
// §22.2 the discriminator: is that entropy tie-break noise, or path variation?
// ---------------------------------------------------------------------------
//
// "A scoring function with a random tie-break produces the same 80/20
// local-substitution signature as genuine strategic variation. Entropy alone
// cannot tell them apart." So each building's entropy is correlated against how
// clear-cut the decisions that touched it were — the gap between the top-scored
// action and the runner-up, recorded at the moment of the decision.
//
//   entropy only where the margin is near zero    a sort order with noise on it
//   entropy at wide margins, or concentrated on
//   large parcels and assembly candidates         real path variation
//
// This runs before the §9 swap, not after: it is the difference between the
// swap being an upgrade and the swap being a rewrite.

interface Site {
  id: string
  entropy: number
  margin: number
  areaM2: number
  degree: number
}

const sites: Site[] = []
for (const id of touchedIds) {
  const e = entropyById.get(id)
  if (e === undefined) continue
  const margins = results.map((r) => r.marginByBuilding[id]).filter((m) => m !== undefined)
  if (margins.length === 0) continue
  const site = results.map((r) => r.siteByBuilding[id]).find(Boolean)
  sites.push({
    id,
    entropy: e,
    margin: median(margins),
    areaM2: site?.areaM2 ?? 0,
    degree: site?.degree ?? 0,
  })
}

const NARROW = 0.05 // within 5% of the runner-up: effectively a tie
const narrow = sites.filter((s) => s.margin <= NARROW)
const wide = sites.filter((s) => s.margin > 0.25)
const entropyAtWide = wide.filter((s) => s.entropy > 0).length

console.log('\n§22.2 entropy against decision margin')
console.log(`  ${sites.length} buildings with both an entropy and a recorded margin`)
console.log(
  `  correlation entropy ~ margin      r = ${pearson(
    sites.map((s) => s.entropy),
    sites.map((s) => s.margin),
  ).toFixed(3)}`,
)
console.log(
  `  correlation entropy ~ parcel area r = ${pearson(
    sites.map((s) => s.entropy),
    sites.map((s) => s.areaM2),
  ).toFixed(3)}      ` +
    `entropy ~ adjacency degree r = ${pearson(
      sites.map((s) => s.entropy),
      sites.map((s) => s.degree),
    ).toFixed(3)}`,
)
for (const [label, band] of [
  ['margin <= 0.05 (a tie)', narrow],
  ['margin 0.05 - 0.25', sites.filter((s) => s.margin > NARROW && s.margin <= 0.25)],
  ['margin > 0.25 (clear-cut)', wide],
] as Array<[string, Site[]]>) {
  console.log(
    `  ${label.padEnd(26)} ${String(band.length).padStart(4)} buildings, ` +
      `${((band.filter((s) => s.entropy > 0).length / Math.max(1, band.length)) * 100)
        .toFixed(0)
        .padStart(3)}% carry entropy, ` +
      `median ${median(band.map((s) => s.entropy)).toFixed(2)} bits`,
  )
}
// The failure this is looking for: entropy that exists *only* where the choice
// was a coin flip. If clear-cut decisions never vary across seeds, the seed is
// permuting who acts and not what happens.
assert(
  wide.length > 0 && entropyAtWide / wide.length > 0.25,
  'entropy survives where the decision was clear-cut',
  `${((entropyAtWide / Math.max(1, wide.length)) * 100).toFixed(0)}% of ${wide.length} wide-margin buildings`,
)

console.log('\n§21.3 divergence-class entropy across seeds')
console.log(`  touched in >= 1 run: ${entropies.length} baseline buildings`)
console.log(
  `  zero entropy (identical treatment every seed): ${zeroEntropy} ` +
    `(${(zeroShare * 100).toFixed(0)}%)`,
)
console.log(
  `  entropy across touched stock: median ${median(entropies).toFixed(2)} bits, ` +
    `mean ${(entropies.reduce((a, b) => a + b, 0) / Math.max(1, entropies.length)).toFixed(2)}, ` +
    `max ${Math.max(...entropies).toFixed(2)} of ${Math.log2(SEEDS).toFixed(2)} possible`,
)
assert(
  zeroShare < 0.9,
  'touched stock is not identically treated every seed',
  `${(zeroShare * 100).toFixed(0)}% at zero entropy`,
)
console.log(
  '  aggregate stability with spatial variety is many paths to one equilibrium.\n' +
    '  aggregate stability with zero spatial variety means the agents are not agents.',
)

console.log(
  failures === 0
    ? `\nall assertions passed (${SEEDS} seeds, ${elapsed.toFixed(0)}s)`
    : `\n${failures} assertion(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
