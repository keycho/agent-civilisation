/**
 * §30.4 / §31.5: the multi-chunk contract, pre-registered before the block.
 *
 * "The discipline that has worked is writing the criteria before the run.
 * These are the criteria, written before the architecture exists." This file
 * compiles and its assertions are executable; the RegionRunSummary it consumes
 * does not exist yet. When the region harness lands it produces that shape and
 * calls `assertContract` — it does not edit this file. Any change here after
 * the first region run is a re-registration and says so in its commit.
 *
 * The §31 additions are folded in: the layer is global, the seed set is
 * international, and the schiedam control's regression suite is the guard for
 * the whole block.
 */
import { moransI, type MoranPoint } from '@civ/core'

// ---------------------------------------------------------------------------
// pre-registered constants
// ---------------------------------------------------------------------------

/**
 * The spectacle margin. §30.4 asks that concentration be "measurably higher"
 * than the single-chunk world; this is what measurably means here, chosen
 * before any region world has been run: the region's Moran's I (instrument in
 * core/spatial.ts, cutoff 150 m, inverse distance) must exceed 1.25x the
 * schiedam control's I measured in the same run by the same function. The
 * control is measured alongside rather than frozen as a constant, so the
 * comparison can never drift apart from its instrument.
 */
export const SPECTACLE_MARGIN = 1.25

/**
 * §30.4's oscillation watch: a chunk flipping active/abandoned more than twice
 * in one run means the §28.4 damping is insufficient.
 */
export const MAX_ACTIVE_ABANDONED_FLIPS = 2

/** §30.2's flow bar, shared with the single-chunk suite. */
export const CHAIN_FLOW_BAR_PER_10K = 4

// ---------------------------------------------------------------------------
// the shape the region harness must produce
// ---------------------------------------------------------------------------

export interface MigrationEvent {
  agentId: string
  fromChunk: string
  toSettlement: string
  departedTick: number
  arrivedTick?: number
  /** §30.4: offered-yield gap origin -> destination estimate at departure */
  offeredGap: number
  reversed: boolean
}

export interface RegionRunSummary {
  seed: string
  decisions: number
  /** settlement ids that ever held a materialised, ticking fine chunk */
  materialised: string[]
  /** settlement ids seeded at start (the §31.4 five) */
  seeded: string[]
  /** per settlement: applied actions attributed to its chunk */
  activityBySettlement: Record<string, number>
  /** day-0 population per settlement, from the coarse layer */
  populationBySettlement: Record<string, number>
  migrations: MigrationEvent[]
  /** per chunk: count of active->abandoned transitions */
  abandonmentFlips: Record<string, number>
  /** in-flight construction present when a chunk went dormant, and its fate */
  dormantConstruction: { becameRuin: number; frozen: number }
  /** divergence-surface points for the whole region, chunk-local coordinates */
  moranPoints: MoranPoint[]
  /** the control chunk's own points, for the same-instrument comparison */
  controlMoranPoints: MoranPoint[]
  /** §31.5: importHealth as read from each chunk manifest */
  importHealth: Record<
    string,
    { heightsReal: number; yearsPresent: number; boundaryParcels: number }
  >
  /** §30.2 */
  chainCompletionFlow: number
}

// ---------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------

export interface ContractResult {
  label: string
  ok: boolean
  detail: string
  kind: 'assert' | 'report'
}

export function assertContract(runs: RegionRunSummary[]): ContractResult[] {
  const out: ContractResult[] = []
  const assert = (ok: boolean, label: string, detail: string) =>
    out.push({ ok, label, detail, kind: 'assert' })
  const report = (label: string, detail: string) =>
    out.push({ ok: true, label, detail, kind: 'report' })

  // -- migration (§30.4, population assertions unchanged by §31.5) ----------
  const nonSeededMaterialised = runs.filter((r) =>
    r.materialised.some((m) => !r.seeded.includes(m)),
  )
  assert(
    nonSeededMaterialised.length >= runs.length / 2,
    'a non-seeded settlement materialises in >= half of seeds',
    `${nonSeededMaterialised.length}/${runs.length}`,
  )

  const sets = runs.map((r) => new Set(r.materialised))
  let allIdentical = true
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].size !== sets[0].size || [...sets[i]].some((x) => !sets[0].has(x))) {
      allIdentical = false
      break
    }
  }
  assert(!allIdentical, 'the set of materialised settlements varies across seeds', '')

  const winnerNotBiggest = runs.filter((r) => {
    const winner = Object.entries(r.activityBySettlement).sort((a, b) => b[1] - a[1])[0]?.[0]
    const biggest = Object.entries(r.populationBySettlement).sort((a, b) => b[1] - a[1])[0]?.[0]
    return winner !== undefined && winner !== biggest
  })
  assert(
    winnerNotBiggest.length >= runs.length / 4,
    'most active settlement is not the largest in >= 1/4 of seeds',
    `${winnerNotBiggest.length}/${runs.length}`,
  )

  const reversed = runs.map((r) => r.migrations.filter((m) => m.reversed).length)
  report(
    'reversed migrations per seed (>0 expected; 0 means the estimate is too accurate, §28.1)',
    reversed.join(', '),
  )
  const gaps = runs.flatMap((r) => r.migrations.map((m) => m.offeredGap))
  report(
    'offered-yield gap at migration events',
    gaps.length
      ? `median ${gaps.sort((a, b) => a - b)[gaps.length >> 1].toFixed(4)} over ${gaps.length}`
      : 'no migrations',
  )
  // §31.6's stated prediction, recorded to be falsified: the first migration
  // in the multi-chunk world originates in schiedam, the only chunk with a
  // mature, compressed offered surface at start.
  const firstOrigins = runs
    .map((r) => [...r.migrations].sort((a, b) => a.departedTick - b.departedTick)[0]?.fromChunk)
    .filter(Boolean)
  report('first migration origin per seed (predicted: schiedam-havens)', firstOrigins.join(', '))

  // -- spectacle (§30.4, sharpened by §31.5 to a world map) -----------------
  const regionI = runs.map((r) => moransI(r.moranPoints))
  const controlI = runs.map((r) => moransI(r.controlMoranPoints))
  const medianOf = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0
  assert(
    medianOf(regionI) > SPECTACLE_MARGIN * medianOf(controlI),
    `region Moran's I exceeds ${SPECTACLE_MARGIN}x the control's, same instrument`,
    `region ${medianOf(regionI).toFixed(4)} vs control ${medianOf(controlI).toFixed(4)}`,
  )

  // -- abandonment (§30.4; §30.5 forbids building it speculatively) ---------
  const anyDrained = runs.some((r) => Object.keys(r.abandonmentFlips).length > 0)
  if (anyDrained) {
    assert(
      runs.every((r) => Object.values(r.abandonmentFlips).every((f) => f <= MAX_ACTIVE_ABANDONED_FLIPS)),
      `no chunk flips active/abandoned more than ${MAX_ACTIVE_ABANDONED_FLIPS}x`,
      '',
    )
    const frozen = runs.reduce((s, r) => s + r.dormantConstruction.frozen, 0)
    assert(
      frozen === 0,
      'in-flight construction resolves to ruin, never freezes',
      `${frozen} frozen`,
    )
  } else {
    report(
      'abandonment untested — no chunk drained',
      'the §28.4 machinery stays unbuilt until migration produces a drain (§30.5)',
    )
  }

  // -- import health (§31.5) ------------------------------------------------
  assert(
    runs.every((r) =>
      Object.values(r.importHealth).every(
        (h) => Number.isFinite(h.heightsReal) && Number.isFinite(h.yearsPresent),
      ),
    ),
    'every chunk manifest carries import health',
    '',
  )

  // -- §30.2 ----------------------------------------------------------------
  const flow = medianOf(runs.map((r) => r.chainCompletionFlow))
  assert(
    flow >= CHAIN_FLOW_BAR_PER_10K,
    `chain completion flow >= ${CHAIN_FLOW_BAR_PER_10K} per 10k decisions, region-wide`,
    flow.toFixed(1),
  )

  return out
}

// Standalone invocation states its status honestly rather than passing vacuously.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('§30.4/§31.5 contract: pre-registered, awaiting the region harness.')
  console.log('The schiedam regression guard is tune.ts itself: it must run green,')
  console.log('unchanged, after each international adapter lands (§31.5).')
}
