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
import { moransI, type MoranPoint, type ValueTier } from '@civ/core'

/**
 * RE-REGISTRATION (build 8, §32, before any region run): three amendments
 * directed by the operator after the coarse layer landed, none loosening.
 *
 *   §32.1  the region world runs with the boundary gate ON, and the control
 *          baseline is measured gate-on by the same harness — an ungated
 *          ruler was measured diluting Moran's I by ~2x with perimeter
 *          artifact.
 *   §32.2  standing rule: no migration is emergence if the destination's
 *          advantage exists only in proxied fields. Migration events carry
 *          the destination's value tier; the gap report line shows it.
 *   §32.3  the population-leader assertion is evaluated within-country —
 *          geonames whole-municipality entries over-weight some countries'
 *          leaders, and a cross-country comparison could satisfy it for free.
 */

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

/**
 * §43.2, joined before the first region run: the chain bars held at
 * single-chunk scale and both went to WATCH; the region is the world §29.1's
 * prediction was made for. Migration concentrates capital, gradients steepen
 * in hot chunks, and the most-contested chunk's chain rate must rise above
 * the single-chunk floor — completions per 34k-decision-equivalent, the same
 * unit the §41.1 bar speaks. If it does not, the chain economy is
 * structurally marginal and gets a mechanism look, not a constant retune. If
 * it concentrates as predicted, the single-chunk decline was gradient
 * starvation and the bars were right to hold.
 *
 * RE-REGISTRATION (§44.2, operator-directed, after run 1): the premise was
 * wrong and being wrong is the finding. Run 1 measured chains ravenous in
 * the migration-DESTINATION chunks (maasland 58-188 per 34k, maassluis
 * 148-293) while contest pointed elsewhere — migration flows toward
 * affordable supply, which is by construction where per-cell competition is
 * low; development booms at the affordable frontier, not the contested
 * core. The pre-registration encoded the opposite. Two changes, neither a
 * bar move:
 *
 *   instrument   contest is sampled at HALF budget per chunk (§29.1's own
 *                terminal-saturation practice — run 1 measured contest 1.00
 *                in every chunk at end-of-run, an argmax over ties)
 *   assertion    chain rate concentrates in migration-destination chunks
 *                (destination rate exceeds the rest-of-region rate) and
 *                exceeds the single-chunk floor there
 *
 * The report (rate vs contest rank, all chunks) is kept, now measurable.
 * The floor itself is unchanged. The single-chunk WATCH resolves with this
 * citation: the decline was gradient starvation in a capped world.
 */
export const CHAIN_SINGLE_CHUNK_FLOOR_PER_34K = 7

/**
 * §32.1/§33.1: the region world's rules, pre-registered. minOwnableShare
 * mirrors the importer's floor — a chunk whose ownable/imported ratio sits
 * below it is not ready to join the region world regardless of how good it
 * looks, because its offered surface would be computed over a subset market
 * (§18.2's fault wearing real data).
 */
export const REGION_RULES = { boundaryGate: true, minOwnableShare: 0.97 } as const

// ---------------------------------------------------------------------------
// the shape the region harness must produce
// ---------------------------------------------------------------------------

export interface MigrationEvent {
  agentId: string
  /** §67: who moved, so the world listing can write the move as a sentence */
  agentName: string
  fromChunk: string
  toSettlement: string
  departedTick: number
  arrivedTick?: number
  /** §30.4: offered-yield gap origin -> destination estimate at departure */
  offeredGap: number
  /** §32.2: where the destination's coarse value came from, carried per event */
  destinationValueTier: ValueTier
  reversed: boolean
  /**
   * §44.3's counterfactual: at grace-window end, was the destination's
   * realised yield below the origin's? True = a member of the
   * would-have-reversed set — they stayed because they planted, which is the
   * commitment device doing real work. If the set is empty across a suite,
   * the §28.1 estimate is not lossy enough for failure to be visible.
   */
  belowOriginAtGrace?: boolean
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
  /** country per settlement, for §32.3's within-country evaluation */
  countryBySettlement: Record<string, string>
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
    { heightsReal: number; yearsPresent: number; boundaryParcels: number; ownableShare?: number }
  >
  /** §30.2 */
  chainCompletionFlow: number
  /**
   * §43.2/§44.2: median competition where agents concentrate, per
   * materialised chunk — sampled at HALF budget per chunk (17k decisions,
   * §20.9's frozen 34k over two), because the terminal surface saturates to
   * 1.00 everywhere and ranks nothing (§29.1's documented practice).
   */
  contestBySettlement: Record<string, number>
  /** §43.2: completed chains per materialised chunk */
  chainCompletionsBySettlement: Record<string, number>
  /** §43.2: decisions attributed per materialised chunk, the rate denominator */
  decisionsBySettlement: Record<string, number>
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

  /**
   * §32.3: evaluated within-country. Cross-country population comparisons ride
   * on geonames' mixed city-proper/whole-municipality semantics, so a Chinese
   * whole-municipality entry could hold "the largest" forever and satisfy the
   * cross-country form for free. Within one country the semantics are
   * consistent and the comparison means what it says.
   *
   * A run is evaluable only where some country has at least two materialised
   * settlements — with one chunk per country the seed CHOICE would otherwise
   * decide the answer, not the sim. Runs without an evaluable country are
   * reported loudly rather than counted as passes.
   */
  const evaluable = runs.filter((r) => {
    const byCountry = new Map<string, number>()
    for (const m of r.materialised) {
      const c = r.countryBySettlement[m]
      if (c) byCountry.set(c, (byCountry.get(c) ?? 0) + 1)
    }
    return [...byCountry.values()].some((n) => n >= 2)
  })
  if (evaluable.length === 0) {
    report(
      'within-country population-leader test NOT EVALUABLE',
      'no country has 2+ materialised settlements yet — not counted as a pass',
    )
  } else {
    const hit = evaluable.filter((r) => {
      const byCountry = new Map<string, string[]>()
      for (const m of r.materialised) {
        const c = r.countryBySettlement[m]
        if (!c) continue
        const arr = byCountry.get(c)
        if (arr) arr.push(m)
        else byCountry.set(c, [m])
      }
      for (const [country, ids] of byCountry) {
        if (ids.length < 2) continue
        const winner = ids.sort(
          (x, y) => (r.activityBySettlement[y] ?? 0) - (r.activityBySettlement[x] ?? 0),
        )[0]
        const leader = Object.entries(r.populationBySettlement)
          .filter(([id]) => r.countryBySettlement[id] === country)
          .sort((x, y) => y[1] - x[1])[0]?.[0]
        if (winner !== undefined && leader !== undefined && winner !== leader) return true
      }
      return false
    })
    assert(
      hit.length >= evaluable.length / 4,
      'within-country: most active is not the population leader (>= 1/4 of evaluable seeds)',
      `${hit.length}/${evaluable.length} evaluable of ${runs.length}`,
    )
  }

  const reversed = runs.map((r) => r.migrations.filter((m) => m.reversed).length)
  report(
    'reversed migrations per seed (>0 expected; 0 means the estimate is too accurate, §28.1)',
    reversed.join(', '),
  )
  /**
   * §32.2, standing rule: a migration to a destination whose entire coarse
   * appeal is proxied fields is the formula talking, not emergence. The gap
   * report carries the destination tier per event class so the rule is
   * checkable per event; emergence-grade counts only non-proxy destinations.
   */
  const byTier = new Map<string, number[]>()
  for (const m of runs.flatMap((r) => r.migrations)) {
    const arr = byTier.get(m.destinationValueTier)
    if (arr) arr.push(m.offeredGap)
    else byTier.set(m.destinationValueTier, [m.offeredGap])
  }
  report(
    'offered-yield gap at migration, by destination value tier',
    byTier.size
      ? [...byTier.entries()]
          .map(
            ([t, g]) =>
              `${t}: median ${[...g].sort((a, b) => a - b)[g.length >> 1].toFixed(4)} x${g.length}`,
          )
          .join('  ')
      : 'no migrations',
  )
  const emergenceGrade = runs.map(
    (r) =>
      r.migrations.filter(
        (m) => !m.reversed && m.destinationValueTier === 'national-valuation',
      ).length,
  )
  report(
    'emergence-grade migrations per seed (destination value not proxy-only, §32.2)',
    emergenceGrade.join(', '),
  )
  /**
   * §31.6's stated prediction, recorded to be falsified: the first migration
   * in the multi-chunk world originates in schiedam, the only chunk with a
   * mature, compressed offered surface at start.
   *
   * RE-REGISTRATION (§43 block, after run 1, instrument only): this line
   * originally sorted by departedTick, but ticks are chunk-local clocks — a
   * late-gated village's tick 300 sorted before schiedam's tick 2000, and
   * the report named an origin that was dormant when the region started,
   * which is impossible. The region's own event order (array order, the
   * order the harness recorded them) is the comparable ordering. The
   * prediction itself is unchanged.
   */
  const firstOrigins = runs.map((r) => r.migrations[0]?.fromChunk).filter(Boolean)
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
  assert(
    runs.every((r) =>
      Object.values(r.importHealth).every(
        (h) => (h.ownableShare ?? 1) >= REGION_RULES.minOwnableShare,
      ),
    ),
    `every joined chunk meets ownable/imported >= ${REGION_RULES.minOwnableShare} (§33.1)`,
    '',
  )

  // -- §30.2 ----------------------------------------------------------------
  const flow = medianOf(runs.map((r) => r.chainCompletionFlow))
  assert(
    flow >= CHAIN_FLOW_BAR_PER_10K,
    `chain completion flow >= ${CHAIN_FLOW_BAR_PER_10K} per 10k decisions, region-wide`,
    flow.toFixed(1),
  )

  // -- §43.2 as re-registered by §44.2: chains concentrate where migration
  // -- delivers capital — the destination chunks — and clear the floor there
  const destRates = runs.map((r) => {
    const dests = new Set(r.migrations.filter((m) => !m.reversed).map((m) => m.toSettlement))
    let dChains = 0
    let dDec = 0
    let oChains = 0
    let oDec = 0
    for (const [id, dec] of Object.entries(r.decisionsBySettlement)) {
      const chains = r.chainCompletionsBySettlement[id] ?? 0
      if (dests.has(id)) {
        dChains += chains
        dDec += dec
      } else {
        oChains += chains
        oDec += dec
      }
    }
    return {
      dest: dDec > 0 ? (dChains / dDec) * 34_000 : 0,
      rest: oDec > 0 ? (oChains / oDec) * 34_000 : 0,
    }
  })
  assert(
    medianOf(destRates.map((x) => x.dest)) >= CHAIN_SINGLE_CHUNK_FLOOR_PER_34K,
    `migration-destination chunks' chain rate >= single-chunk floor (${CHAIN_SINGLE_CHUNK_FLOOR_PER_34K}/34k)`,
    `median ${medianOf(destRates.map((x) => x.dest)).toFixed(1)} per 34k-equivalent`,
  )
  assert(
    medianOf(destRates.map((x) => x.dest)) > medianOf(destRates.map((x) => x.rest)),
    'chain rate concentrates in migration-destination chunks (dest > rest of region)',
    `dest ${medianOf(destRates.map((x) => x.dest)).toFixed(1)} vs rest ${medianOf(
      destRates.map((x) => x.rest),
    ).toFixed(1)}`,
  )
  report(
    'chain rate vs chunk contest rank (per 34k-equivalent, mid-run contest, hottest first)',
    runs
      .map((r) =>
        Object.entries(r.contestBySettlement)
          .sort((a, b) => b[1] - a[1])
          .map(([id, c]) => {
            const dec = r.decisionsBySettlement[id] ?? 0
            const ch = r.chainCompletionsBySettlement[id] ?? 0
            return `${id.split('-')[0]}(${c.toFixed(2)}):${dec > 0 ? ((ch / dec) * 34_000).toFixed(0) : '·'}`
          })
          .join(' '),
      )
      .join(' | '),
  )

  // -- §44.3: the would-have-reversed set, before the zero is trusted -------
  const wouldHave = runs.map(
    (r) => r.migrations.filter((m) => !m.reversed && m.belowOriginAtGrace === true).length,
  )
  report(
    'would-have-reversed per seed (§44.3: below origin realised at grace end; nonempty = the commitment device works, empty = §28.1 not lossy enough)',
    wouldHave.join(', '),
  )

  return out
}

// Standalone invocation states its status honestly rather than passing vacuously.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('§30.4/§31.5 contract: pre-registered, awaiting the region harness.')
  console.log('The schiedam regression guard is tune.ts itself: it must run green,')
  console.log('unchanged, after each international adapter lands (§31.5).')
}
