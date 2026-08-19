/**
 * One seed, run to the frozen decision budget, reduced to everything §18 asks
 * about. Shared by calibrate.ts (one seed, verbose) and tune.ts (N seeds,
 * distribution).
 */
import {
  DIVERGENCE_WEIGHT,
  RATE_WINDOW_TICKS,
  type SeedReport,
  type WorldSeed,
  centroid,
  distanceToSegment,
  moransI,
  validateSeed,
} from '@civ/core'
import { MemoryStore } from '@civ/persistence'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Simulation, structuralClass } from '../../src/index.ts'
import { acquisitionPrice, competitionAt, withDuty } from '../../src/economy.ts'
import { DISTRICT_SPAN_M, findDistricts } from '../../src/divergence.ts'
import type { World } from '../../src/state.ts'

export { DISTRICT_SPAN_M }

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * §20.9: the run budget, in agent decisions.
 *
 * CALIBRATED, then frozen. Recalibrated twice, each time with an authorisation
 * that names its reason: §21.2 for build 3 (a mechanism the model lacked),
 * §29.3 for build 7 (the criterion itself was at fault).
 *
 *   build 2   39,000   the decision count at which the pre-calendar end state
 *                      (34.6% / 135 agent-built / 85 cleared) was reached
 *   build 3   65,000   the plateau of the model that has site value and a
 *                      capital constraint in it
 *   build 4   80,000   the plateau of the model that has traits and argmax
 *                      (§23.1), assembly on occupied lots (§23.2) and
 *                      transaction cost with intent (§23.3) in it
 *   build 7   34,000   the touched-share crossing of the model that has
 *                      competitive pricing at the §29.1 inversion in it,
 *                      measured at 33,799 before §29.2 landed
 *
 * The criterion changed at build 7 and that is the point. The plateau rule
 * asked when the aggregate went quiet, and the index plateaus long after the
 * world is used up — a plateau-sized budget runs its last quarter as agents
 * re-treading stock, which §29.3 calls "a criterion fault, not a number
 * fault". The budget became the decision count at which the touched share
 * crosses 80%, the ceiling §21.1 set from what real cities do not do.
 *
 * Then §29.2 landed in the same build and the crossing stopped existing:
 * with plans living on sites, touched reaches 73% at 90,000 decisions and is
 * still creeping, no plateau, no crossing. Agents go deep on planned ground
 * instead of sweeping the chunk. That is §29.3's own forecast — "a world
 * where saturation produces migration needs no budget; the budget survives
 * only as the harness's unit" — arriving one build early and in one chunk.
 * So the number stays at the last criterion-derived value and is now purely
 * the unit of comparison across seeds. It has no claim to being the world's
 * lifetime, which §22.3 already established it never was.
 *
 * It is not adjusted until the assertions pass. Tuning the budget to hit a
 * target is precisely the hill-climb error §18 exists to catch, so this number
 * does not move.
 */
export const DECISION_BUDGET = 34_000

export const ALL_ACTION_KINDS = [
  'acquire_building',
  'acquire_parcel',
  'renovate',
  'convert',
  'expand',
  'demolish',
  'develop',
  'assemble',
  'build_road',
] as const

export interface Summary {
  seed: string
  decisions: number
  ticks: number
  divergenceIndex: number
  touchedShare: number
  peakSector: number
  agentOrigin: number
  cleared: number
  /**
   * §70, pre-registered: what the ground looks like at the end of the run.
   *
   * `cleared` counts demolition EVENTS, which says how busy the agents were and
   * nothing about what is standing. These two say what a viewer sees: how much
   * of the chunk is a hole, and how much of the original city is still up.
   */
  clearedUnbuiltShare: number
  standingShare: number
  /** demolitions completed per construction completed — 3:1 before §70 */
  clearToBuild: number
  generation: number
  /** §23.5: agent lifetimes ended, not generations */
  livesCompleted: number
  deepestLineage: number
  events: number
  actionCounts: Record<string, number>
  eventCounts: Record<string, number>
  /** §18.3 */
  acquisitionsPerMutation: number
  actionKindsFired: number
  /** §21.1: the new mechanism, and the constraint that is supposed to bind */
  siteLedAcquisitions: number
  /** share of applied actions taken by the single most common kind */
  dominantActionShare: number
  leverage: {
    medianDebt: number
    medianCash: number
    withDebt: number
    agents: number
    everBorrowedShare: number
    medianPeakDebt: number
  }
  /** §22.1: grain, not divergence — is the lot pattern actually changing? */
  grain: GrainReport
  /** §22.1: is this a construction narrative or a property market? */
  churn: ChurnReport
  /** §18.2 */
  untouchedIds: string[]
  untouchedShare: number
  /**
   * §70.2: baseline stock that still reads as the world we left it — standing
   * and no further than a renovation from its import. This is the bar; the
   * untouched share above it is now reported as information.
   */
  greyShare: number
  greyLost: { gone: number; repurposed: number; taller: number }
  /**
   * §72.5: how much taller the inherited city got, which is a different
   * question from how many buildings expansion touched.
   *
   * §70.2's bar counts a building as spent the moment its class reaches
   * `expanded`, so one added floor and four are the same to it. Structural
   * capacity bounds the AMOUNT, so the amount has to be measured or the
   * mechanism is invisible to every instrument in the suite.
   */
  expansion: { touched: number; levelsAdded: number; meanAdded: number; maxAdded: number }
  /** §72.5: what the classifier decided the inherited fabric is made of */
  structuralClasses: Record<string, number>
  /** §70.2: the class histogram, so a failing fabric bar can name its cause */
  divergenceCounts: Record<number, number>
  /** §34 step 3: observation-candidate appearances per baseline building */
  enumeratedByBuilding: Record<string, number>
  /** §21.3: divergence class per baseline building, for cross-seed entropy */
  divergenceByBuilding: Record<string, number>
  /**
   * §22.2: median decision margin per baseline building, for the correlation
   * that separates tie-break noise from real path variation.
   */
  marginByBuilding: Record<string, number>
  /** parcel area and adjacency degree per building, for the same correlation */
  siteByBuilding: Record<string, { areaM2: number; degree: number }>
  /**
   * Purpose mix of the residue. A whole class appearing here at 100% is the
   * signature of structural exclusion rather than economic disinterest, which
   * is exactly what the first §18.2 run turned up.
   */
  untouchedByPurpose: Record<string, { untouched: number; total: number }>
  correlations: { access: number; landValue: number; adjacency: number }
  /**
   * §23.6/§26.2: emergent districts, and how big they actually got. The feed
   * claimed 1094 buildings in one district of a 925-building chunk, because
   * single-linkage growth chained the whole touched set together. §26.2 retires
   * the global scalar and keeps the index per district, so district extent is
   * now a load-bearing quantity rather than a label on a feed line.
   */
  districts: { count: number; largest: number; medianSize: number; maxExtentM: number }
  /**
   * §30.4: the spectacle statistic on this run's divergence surface, computed
   * by the same pre-registered instrument the multi-chunk contract will use.
   * This single-chunk value IS the baseline that contract compares against.
   */
  moransI: number
  /** §30.2: completed chains per 10,000 decisions — the flow, not the window rate */
  chainCompletionFlow: number
  /**
   * §27.5: competitive pricing, measured in the single chunk before anything
   * multi-region exists — while agents still have nowhere to go, so a failure
   * here cannot be confused with a failure of the migration plumbing.
   *
   * `contestedCapRate` and `quietCapRate` are yield on land value, taken over
   * the most and least bid-up quartile of localities. §27.5's claim is that the
   * good place gets expensive and yields compress there, so contested must come
   * out below quiet. Written before the first 20-seed run.
   */
  pricing: {
    contestedCapRate: number
    quietCapRate: number
    /** contested / quiet — below 1 is compression */
    capRateRatio: number
    /** the same split over transactions: return on the price actually paid */
    contestedReturn: number
    quietReturn: number
    returnRatio: number
    transactions: number
    /**
     * §29.1's deciding pair, measured at half budget. `offeredMidRatio` is the
     * contested/quiet ratio of what a marginal buyer WOULD earn on standing
     * stock — the quantity that inverts in real markets and the one migration
     * keys off. `transactedMidRatio` is the same split over purchases that
     * cleared, which selection keeps above 1 however hard the premium binds;
     * it is reported so the difference between the two stays visible.
     */
    offeredMidRatio: number
    transactedMidRatio: number
    competitionP10: number
    competitionP90: number
    landValueP10: number
    landValueP90: number
  }
  /** structural canaries over the emitted artifact (§21.4) */
  structural: SeedReport
  curve: Array<{ decisions: number; index: number; touched: number; agentOrigin: number; cleared: number; generation: number; compP10: number; compP90: number }>
}

/**
 * §22.1. "Replacement at 1:1 on inherited footprints leaves the 1909 urban
 * grain intact. The street reads as the same street with newer buildings on
 * it." So the question is not how much was replaced but whether the lot pattern
 * underneath it changed — which is what `assemble` exists to do, and what makes
 * a district read as a different place rather than a refreshed one.
 */
export interface GrainReport {
  assemblies: number
  medianParcelsPerAssembly: number
  /**
   * Assemblies ever followed by demolish *and* develop on the same holding.
   * Weaker than it sounds: a develop on one lot of three sets it. Read
   * `chainConsolidated` for the number that means the grain moved.
   */
  chainCompleted: number
  /** the chain that ended with one structure across more than one of the lots */
  chainConsolidated: number
  /** followed by a demolition on the assembled ground */
  chainCleared: number
  /** followed by a building on it — the half that is reachable at all */
  chainDeveloped: number
  /** neither: a consolidation that changed nothing */
  chainDormant: number
  agentBuilt: number
  /** agent-built structures standing on more than one parcel */
  agentBuiltMultiParcel: number
  /** their footprint against what stood on that ground at baseline */
  medianFootprintRatio: number
  /** the same ratio over every agent-built structure with a baseline under it */
  medianFootprintRatioAll: number
  /**
   * §23.2's prediction. Land value where assemblies happen, against the chunk
   * median. Above 1 and concentrated means the capital gate is binding and the
   * gradient is doing the selecting; near 1 and flat means it is not.
   */
  assemblyLandValueRatio: number
  assemblyLandValueP90: number
  /** share of applied actions that were assemblies — "rare in count" */
  assemblyShareOfActions: number
  /** lots taken with something standing on them, per assembly */
  medianOccupiedPerAssembly: number
}

/**
 * §22.1. "If a building changes hands four times and is altered once, that is a
 * property market rather than a construction narrative." Acquisition is 45.7%
 * of decisions and nothing a spectator can see, so the ratio of trades to
 * alterations is the honest measure of how much agent activity reaches the
 * screen.
 */
export interface ChurnReport {
  acquisitions: number
  buildingsEverAcquired: number
  /** divergence >= 2: anything beyond a change of deed */
  buildingsAltered: number
  /** expanded, cleared, replaced or agent-origin — a changed silhouette */
  buildingsResilhouetted: number
  acquisitionsPerAltered: number
  acquisitionsPerResilhouetted: number
  /** how many times the most-traded building changed hands */
  worstChurn: number
  /** share of acquisitions that land on a building never altered by anyone */
  intoNothingShare: number
}

/**
 * §70: cleared-and-unbuilt ground, and what is left standing.
 *
 * A parcel counts as a hole when something was demolished on it and nothing
 * stands there now. Counting demolished BUILDINGS instead would double-count an
 * assembled site that cleared three lots to build one mass, which is exactly
 * the case the ratio has to be able to forgive.
 */
function groundState(w: {
  buildings: Map<string, { state: string; parcelId?: string; source: string }>
  parcels: Map<string, unknown>
}): { clearedUnbuiltShare: number; standingShare: number } {
  const standingParcels = new Set<string>()
  let standing = 0
  let baseline = 0
  for (const b of w.buildings.values()) {
    if (b.source === 'real_world') baseline++
    if (b.state === 'standing') {
      standing++
      if (b.parcelId) standingParcels.add(b.parcelId)
    }
  }
  const holes = new Set<string>()
  for (const b of w.buildings.values()) {
    if (b.state !== 'demolished' || !b.parcelId) continue
    if (!standingParcels.has(b.parcelId)) holes.add(b.parcelId)
  }
  const parcels = w.parcels.size || 1
  return {
    clearedUnbuiltShare: holes.size / parcels,
    standingShare: baseline > 0 ? standing / baseline : 0,
  }
}

/**
 * §72.5: added floors on baseline stock, counted against what each structure
 * was built as.
 */
function expansionOf(w: World): Summary['expansion'] {
  let touched = 0
  let levelsAdded = 0
  let maxAdded = 0
  for (const b of w.buildings.values()) {
    if (b.source !== 'real_world') continue
    const design = b.designLevels ?? b.levels
    const added = b.levels - design
    if (added <= 0) continue
    touched++
    levelsAdded += added
    if (added > maxAdded) maxAdded = added
  }
  return { touched, levelsAdded, meanAdded: touched ? levelsAdded / touched : 0, maxAdded }
}

export async function loadSeed(chunk = 'schiedam-havens'): Promise<WorldSeed> {
  const p = join(HERE, '..', '..', '..', 'client', 'public', 'world', `${chunk}.json`)
  return JSON.parse(await readFile(p, 'utf8')) as WorldSeed
}

export async function runSeed(
  world: WorldSeed,
  seed: string,
  budget = DECISION_BUDGET,
  captureCurve = false,
): Promise<Summary> {
  const store = new MemoryStore()
  const curve: Summary['curve'] = []
  const sim = new Simulation(world, store, {
    agentCount: 58,
    seed,
    onSnapshot({ report, generation }) {
      if (captureCurve) {
        const comps = [...(sim.world.competition ?? [])].sort((a, b) => a - b)
        curve.push({
          decisions: sim.decisionsIssued,
          index: report.index,
          touched: report.touchedShare,
          agentOrigin: report.agentOrigin,
          cleared: report.demolished,
          generation,
          compP10: comps.length ? comps[Math.floor(comps.length * 0.1)] : 0,
          compP90: comps.length ? comps[Math.floor(comps.length * 0.9)] : 0,
        })
      }
    },
  })

  // §29.1: spatial pricing is judged at half budget, while the surface is
  // differentiated. Measured at the end of a supply-exhausted run it reads
  // saturated-flat everywhere, which is the terminal state working rather
  // than the mechanism failing — and it broke three measurements in a row
  // before this line existed.
  await sim.runToDecisionBudget(Math.floor(budget / 2))
  const offeredMidRatio = offeredRatioOf(sim.world)
  const transactedMidRatio = transactedRatioOf(sim.world)
  await sim.runToDecisionBudget(budget)
  const r = sim.refreshReport()
  const w = sim.world

  const eventCounts: Record<string, number> = {}
  // §21.1: how many acquisitions were led by the site rather than by the rent.
  // A mechanism that is present in the code and never fires is not in the
  // model, which is the same class of fault as a dead action branch (§18.3).
  let siteLedAcquisitions = 0
  for (const e of store.events({ limit: 1e9 })) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1
    // §23.3 rewrote the rationale strings and this counter, which matched on
    // one, silently read zero for a whole calibration run. It reads the payload
    // now: a measurement that depends on prose is not a measurement.
    if (e.type === 'building_acquired' && e.payload?.intent === 'redevelop') {
      siteLedAcquisitions++
    }
  }

  const actionCounts: Record<string, number> = {}
  for (const k of ALL_ACTION_KINDS) actionCounts[k] = w.actionCounts.get(k) ?? 0

  // §18.3: unreachable land looks like pure acquisition, so this ratio is the
  // general form of the 28,000-acquisitions run and is kept permanently.
  const acquisitions = actionCounts.acquire_building + actionCounts.acquire_parcel
  const mutations =
    actionCounts.renovate +
    actionCounts.convert +
    actionCounts.expand +
    actionCounts.demolish +
    actionCounts.develop +
    actionCounts.build_road
  const acquisitionsPerMutation = acquisitions / Math.max(1, mutations)

  // §18.2: the untouched set is a diagnostic, not a result
  //
  // Purpose is read from the emitted seed rather than from the building in
  // memory (§21.4). Converting is a mutation of `purpose`, so a class measured
  // after the run loses exactly the members that were touched: every class an
  // agent converts *out of* reads as more untouched than it is, and one that is
  // wholly converted away reads as 100% untouched while being 100% touched.
  // Build 2's "all industrial is excluded" was partly this.
  const baselinePurpose = new Map(world.buildings.map((b) => [b.id, b.purpose]))
  const untouchedIds: string[] = []
  const byPurpose: Record<string, { untouched: number; total: number }> = {}
  const divergenceByBuilding: Record<string, number> = {}
  const marginByBuilding: Record<string, number> = {}
  const siteByBuilding: Record<string, { areaM2: number; degree: number }> = {}
  const flags: number[] = []
  const access: number[] = []
  const value: number[] = []
  const degree: number[] = []
  for (const b of w.buildings.values()) {
    if (b.source !== 'real_world') continue
    const parcel = w.parcelOf(b)
    if (!parcel) continue
    const untouched = b.divergence === 0 ? 1 : 0
    const row = (byPurpose[baselinePurpose.get(b.id) ?? b.purpose] ??= { untouched: 0, total: 0 })
    row.total++
    if (untouched) {
      row.untouched++
      untouchedIds.push(b.id)
    }
    // §21.3: the class each baseline building ended in, for the cross-seed
    // entropy that separates "many paths to one equilibrium" from "one path".
    divergenceByBuilding[b.id] = b.divergence
    // §22.3: and how clear-cut the decisions that put it there were
    const margins = w.decisionMargins.get(b.id)
    if (margins?.length) marginByBuilding[b.id] = median(margins)
    const deg = (w.adjacency.get(parcel.id) ?? []).length
    siteByBuilding[b.id] = { areaM2: Math.round(parcel.areaM2), degree: deg }
    flags.push(untouched)
    access.push(parcel.accessScore)
    value.push(parcel.landValue)
    degree.push(deg)
  }

  return {
    seed,
    decisions: sim.decisionsIssued,
    ticks: w.tick,
    divergenceIndex: r.index,
    touchedShare: r.touchedShare,
    peakSector: r.peakSector?.index ?? 0,
    agentOrigin: r.agentOrigin,
    cleared: r.demolished,
    ...groundState(w),
    greyShare: r.greyShare,
    greyLost: r.greyLost,
    divergenceCounts: r.counts,
    expansion: expansionOf(w),
    structuralClasses: (() => {
      const out: Record<string, number> = {}
      for (const b of w.buildings.values()) {
        if (b.source !== 'real_world') continue
        const k = structuralClass(b)
        out[k] = (out[k] ?? 0) + 1
      }
      return out
    })(),
    clearToBuild:
      (eventCounts.construction_completed ?? 0) > 0
        ? (eventCounts.demolition_completed ?? 0) / (eventCounts.construction_completed ?? 1)
        : (eventCounts.demolition_completed ?? 0),
    generation: w.generation,
    livesCompleted: w.livesCompleted,
    deepestLineage: w.deepestLineage,
    events: store.eventCount(),
    actionCounts,
    eventCounts,
    acquisitionsPerMutation,
    actionKindsFired: ALL_ACTION_KINDS.filter((k) => actionCounts[k] > 0).length,
    siteLedAcquisitions,
    dominantActionShare:
      Math.max(...ALL_ACTION_KINDS.map((k) => actionCounts[k])) /
      Math.max(1, ALL_ACTION_KINDS.reduce((sum, k) => sum + actionCounts[k], 0)),
    leverage: leverageOf(w),
    grain: {
      ...grainOf(w),
      assemblyShareOfActions:
        actionCounts.assemble /
        Math.max(1, ALL_ACTION_KINDS.reduce((sum, k) => sum + actionCounts[k], 0)),
    },
    churn: churnOf(w, actionCounts.acquire_building),
    untouchedIds,
    divergenceByBuilding,
    enumeratedByBuilding: Object.fromEntries(sim.world.enumerated),
    marginByBuilding,
    siteByBuilding,
    untouchedByPurpose: byPurpose,
    untouchedShare: flags.length ? flags.reduce((a, b) => a + b, 0) / flags.length : 0,
    correlations: {
      access: pearson(flags, access),
      landValue: pearson(flags, value),
      adjacency: pearson(flags, degree),
    },
    structural: validateSeed(world),
    districts: districtsOf(sim.world),
    moransI: moransI(
      [...sim.world.buildings.values()]
        .filter((b) => b.source !== 'agent_built')
        .map((b) => {
          const c = centroid(b.footprint)
          return { x: c[0], y: c[1], v: DIVERGENCE_WEIGHT[b.divergence] ?? 0 }
        }),
    ),
    chainCompletionFlow:
      (sim.world.assemblies.filter((x) => x.clearedAfter && x.developedAfter).length /
        Math.max(1, sim.decisionsIssued)) *
      10_000,
    pricing: { ...pricingOf(sim.world, curve), offeredMidRatio, transactedMidRatio },
    curve,
  }
}

/**
 * §27.5. Yield on land value, per locality, split by how bid-up the locality
 * got. "The good place gets expensive, yields compress, and the marginal agent
 * finds the cheap town is the better return" — the first two clauses are
 * testable here, in one chunk, with nowhere to migrate to.
 *
 * Cap rate rather than rent, because rent alone does not compress: what
 * compresses is what an agent earns per unit of capital committed. Cells need
 * some stock before they count, for the same reason the sector index does — a
 * cell holding one building reports its own noise.
 */
/** §29.1: offered contested/quiet over standing stock, at the moment called. */
function offeredRatioOf(w: World): number {
  const offers: Array<{ comp: number; y: number }> = []
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing') continue
    const price = withDuty(acquisitionPrice(w, b))
    if (price <= 0) continue
    const c = centroid(b.footprint)
    offers.push({
      comp: competitionAt(w, c[0], c[1]),
      y: (b.yieldPerTick * RATE_WINDOW_TICKS) / price,
    })
  }
  offers.sort((a, b) => a.comp - b.comp)
  const q = Math.max(1, Math.floor(offers.length / 4))
  const avg = (xs: typeof offers) => (xs.length ? xs.reduce((s, x) => s + x.y, 0) / xs.length : 0)
  const quiet = avg(offers.slice(0, q))
  return quiet > 0 ? avg(offers.slice(-q)) / quiet : 1
}

/** Time-controlled transacted contested/quiet over purchases made so far. */
function transactedRatioOf(w: World): number {
  const tx = [...w.transactions].sort(
    (a, b) =>
      a.competition - a.competitionMedianAtBuy - (b.competition - b.competitionMedianAtBuy),
  )
  const q = Math.max(1, Math.floor(tx.length / 4))
  const avg = (xs: typeof tx) =>
    xs.length ? xs.reduce((s, x) => s + x.returnOnPrice, 0) / xs.length : 0
  const quiet = avg(tx.slice(0, q))
  return quiet > 0 ? avg(tx.slice(-q)) / quiet : 1
}

function pricingOf(
  w: World,
  curve: Summary['curve'],
) {
  const cols = w.intensityCols
  const rows = w.intensityRows
  const cell = w.intensityCell
  const n = cols * rows
  const yieldSum = new Float64Array(n)
  const valueSum = new Float64Array(n)
  const stock = new Float64Array(n)

  const at = (x: number, y: number): number => {
    const i = Math.round((x - w.bounds.minX) / cell)
    const j = Math.round((y - w.bounds.minY) / cell)
    if (i < 0 || j < 0 || i >= cols || j >= rows) return -1
    return j * cols + i
  }

  for (const b of w.buildings.values()) {
    if (b.state !== 'standing') continue
    const c = centroid(b.footprint)
    const k = at(c[0], c[1])
    if (k < 0) continue
    yieldSum[k] += b.yieldPerTick
    stock[k] += 1
  }
  for (const p of w.parcels.values()) {
    const k = at(p.centroid[0], p.centroid[1])
    if (k < 0) continue
    valueSum[k] += p.landValue * p.areaM2
  }

  const live: Array<{ comp: number; cap: number }> = []
  for (let k = 0; k < n; k++) {
    if (stock[k] < 6 || valueSum[k] <= 0) continue
    live.push({ comp: w.competition?.[k] ?? 0, cap: yieldSum[k] / valueSum[k] })
  }
  live.sort((a, b) => a.comp - b.comp)

  const q = Math.max(1, Math.floor(live.length / 4))
  const quiet = live.slice(0, q)
  const contested = live.slice(-q)
  const mean = (xs: Array<{ cap: number }>): number =>
    xs.length ? xs.reduce((s, x) => s + x.cap, 0) / xs.length : 0

  /**
   * The surface spread is read MID-RUN, not at the end. A single chunk whose
   * supply has been bought out ends with competition saturated everywhere —
   * demand over near-zero supply — which is §27.5's terminal state working,
   * not its differentiation failing. The question "is the mechanism spatially
   * differentiated" has to be asked while there is still a market to
   * differentiate, so it reads the curve point nearest half budget.
   */
  const mid = curve.length
    ? curve.reduce((best, p) =>
        Math.abs(p.decisions - curve[curve.length - 1].decisions / 2) <
        Math.abs(best.decisions - curve[curve.length - 1].decisions / 2)
          ? p
          : best,
      )
    : undefined
  const lvs = [...w.parcels.values()].map((p) => p.landValue)
  const contestedCapRate = mean(contested)
  const quietCapRate = mean(quiet)

  /**
   * The transaction-side measure, which is the one §27.5's claim is about.
   *
   * Ranked by competition RELATIVE to the chunk median at the moment of
   * purchase. Build 7's first cut ranked raw competition, and on a run whose
   * surface saturates as supply exhausts, that sorted transactions by *when*
   * they happened rather than *where* — the "inversion" it reported was early
   * buyers beating late buyers, which is true and is not the mechanism. A pass
   * for the wrong reason is the silent-plausible-output class again, in a
   * measurement.
   */
  const tx = [...w.transactions].sort(
    (a, b) => a.competition - a.competitionMedianAtBuy - (b.competition - b.competitionMedianAtBuy),
  )
  const tq = Math.max(1, Math.floor(tx.length / 4))
  const avg = (xs: typeof tx): number =>
    xs.length ? xs.reduce((s, x) => s + x.returnOnPrice, 0) / xs.length : 0
  const quietReturn = avg(tx.slice(0, tq))
  const contestedReturn = avg(tx.slice(-tq))

  return {
    contestedCapRate,
    quietCapRate,
    capRateRatio: quietCapRate > 0 ? contestedCapRate / quietCapRate : 1,
    contestedReturn,
    quietReturn,
    returnRatio: quietReturn > 0 ? contestedReturn / quietReturn : 1,
    transactions: tx.length,
    competitionP10: mid?.compP10 ?? 0,
    competitionP90: mid?.compP90 ?? 0,
    landValueP10: percentile(lvs, 0.1),
    landValueP90: percentile(lvs, 0.9),
  }
}

/**
 * §23.6/§26.2. Extent is measured off the buildings the district actually
 * contains rather than off the constant that is supposed to bound them, so the
 * canary in `tune.ts` is checking the result and not restating the input.
 */
function districtsOf(w: Parameters<typeof findDistricts>[0]) {
  const ds = findDistricts(w)
  const sizes = ds.map((d) => d.buildingIds.length).sort((a, b) => a - b)
  let maxExtent = 0
  for (const d of ds) {
    const pts = d.buildingIds
      .map((id) => w.buildings.get(id))
      .filter((b): b is NonNullable<typeof b> => !!b)
      .map((b) => centroid(b.footprint))
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const e = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
        if (e > maxExtent) maxExtent = e
      }
    }
  }
  return {
    count: ds.length,
    largest: sizes.length ? sizes[sizes.length - 1] : 0,
    medianSize: median(sizes),
    maxExtentM: Math.round(maxExtent),
  }
}

/**
 * §21.1: is capital actually the constraint? A population sitting on idle cash
 * with no borrowings has a credit mechanism that does nothing.
 */
function leverageOf(w: {
  agents: Map<string, { diedTick?: number; debt: number; peakDebt: number; capital: number }>
}) {
  const all = [...w.agents.values()]
  const living = all.filter((a) => !a.diedTick)
  return {
    medianDebt: median(living.map((a) => a.debt)),
    medianCash: median(living.map((a) => a.capital)),
    withDebt: living.filter((a) => a.debt > 0).length,
    agents: living.length,
    // Over a whole life, not at the moment the run stopped. A mature portfolio
    // deleverages, so an end-of-run snapshot understates how hard the
    // constraint bit while the buying was happening.
    everBorrowedShare: all.filter((a) => a.peakDebt > 0).length / Math.max(1, all.length),
    medianPeakDebt: median(all.map((a) => a.peakDebt)),
  }
}


/**
 * §22.1: the assemble chain, followed on the ground. `assemble` firing is not
 * the event of interest — an assembly that is never built on has changed
 * nothing, and the chain assemble -> demolish -> develop is what actually moves
 * the lot pattern.
 */
function grainOf(w: {
  assemblies: Array<{
    parcelIds: string[]
    clearedAfter: boolean
    developedAfter: boolean
    spannedByOneBuilding: number
    landValueRatio: number
    occupiedCount: number
  }>
  buildings: Map<string, { source: string; state: string; areaM2: number; builtOnParcels?: string[] }>
  baselineAreaByParcel: Map<string, number>
}): GrainReport {
  const a = w.assemblies
  const agentBuilt: Array<{ areaM2: number; parcels: string[] }> = []
  for (const b of w.buildings.values()) {
    if (b.source !== 'agent_built' || b.state === 'demolished') continue
    agentBuilt.push({ areaM2: b.areaM2, parcels: b.builtOnParcels ?? [] })
  }

  const ratios: number[] = []
  const multiRatios: number[] = []
  let multi = 0
  for (const b of agentBuilt) {
    const baseline = b.parcels.reduce((sum, id) => sum + (w.baselineAreaByParcel.get(id) ?? 0), 0)
    if (b.parcels.length > 1) multi++
    if (baseline <= 0) continue
    const ratio = b.areaM2 / baseline
    ratios.push(ratio)
    if (b.parcels.length > 1) multiRatios.push(ratio)
  }

  return {
    assemblies: a.length,
    medianParcelsPerAssembly: median(a.map((x) => x.parcelIds.length)),
    chainCompleted: a.filter((x) => x.clearedAfter && x.developedAfter).length,
    chainConsolidated: a.filter((x) => x.spannedByOneBuilding > 1).length,
    chainCleared: a.filter((x) => x.clearedAfter).length,
    chainDeveloped: a.filter((x) => x.developedAfter).length,
    chainDormant: a.filter((x) => !x.clearedAfter && !x.developedAfter).length,
    agentBuilt: agentBuilt.length,
    agentBuiltMultiParcel: multi,
    medianFootprintRatio: median(multiRatios),
    medianFootprintRatioAll: median(ratios),
    assemblyLandValueRatio: median(a.map((x) => x.landValueRatio)),
    assemblyLandValueP90: percentile(a.map((x) => x.landValueRatio), 0.9),
    assemblyShareOfActions: 0, // filled by the caller, which knows the totals
    medianOccupiedPerAssembly: median(a.map((x) => x.occupiedCount)),
  }
}

/** §22.1: trades against alterations. */
function churnOf(
  w: {
    buildings: Map<string, { source: string; divergence: number }>
    acquisitionCount: Map<string, number>
  },
  acquisitions: number,
): ChurnReport {
  let altered = 0
  let resilhouetted = 0
  for (const b of w.buildings.values()) {
    // 2+ is anything past a change of deed; 4+ changed shape or is gone
    if (b.divergence >= 2) altered++
    if (b.divergence >= 4) resilhouetted++
  }
  const counts = [...w.acquisitionCount.values()]
  let intoNothing = 0
  for (const [id, n] of w.acquisitionCount) {
    const b = w.buildings.get(id)
    if (b && b.divergence < 2) intoNothing += n
  }
  return {
    acquisitions,
    buildingsEverAcquired: w.acquisitionCount.size,
    buildingsAltered: altered,
    buildingsResilhouetted: resilhouetted,
    acquisitionsPerAltered: acquisitions / Math.max(1, altered),
    acquisitionsPerResilhouetted: acquisitions / Math.max(1, resilhouetted),
    worstChurn: counts.length ? Math.max(...counts) : 0,
    intoNothingShare: acquisitions > 0 ? intoNothing / acquisitions : 0,
  }
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den < 1e-12 ? 0 : num / den
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))))]
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export { distanceToSegment }
