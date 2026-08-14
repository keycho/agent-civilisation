/**
 * One seed, run to the frozen decision budget, reduced to everything §18 asks
 * about. Shared by calibrate.ts (one seed, verbose) and tune.ts (N seeds,
 * distribution).
 */
import {
  BLOCK_BOUNDING_CLASSES,
  type Parcel,
  type Ring,
  type WorldSeed,
  distanceToSegment,
} from '@civ/core'
import { MemoryStore } from '@civ/persistence'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Simulation } from '../../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * §20.9: the run budget, in agent decisions.
 *
 * CALIBRATED ONCE, then frozen. Recalibrated once, under §21.2, because §21.1
 * added a mechanism the model lacked rather than tuning a constant against an
 * outcome — "the freeze blocks tuning constants against observed outcomes, it
 * does not block adding a mechanism the model lacks."
 *
 *   build 2   39,000   the decision count at which the pre-calendar end state
 *                      (34.6% / 135 agent-built / 85 cleared) was reached
 *   build 3   65,000   the plateau of the model that has site value and a
 *                      capital constraint in it
 *
 * The build-3 rule was written into calibrate.ts before the number was read,
 * and it names no target: the first point past which the index gains under 1pp
 * and both the agent-built and cleared counts grow under 5% over the following
 * 5,000 decisions. All three together, because a flat index can hide
 * construction still finishing. Measured at 64,894 on one seed.
 *
 * The larger budget is not the model being slower. It is ~40% more stock being
 * reachable and every purchase now competing for finite credit, so the same
 * world takes more decisions to arrive at.
 *
 * It is not adjusted until the assertions pass. Tuning the budget to hit a
 * target is precisely the hill-climb error §18 exists to catch, so this number
 * does not move. One recalibration, not an iterative approach to a target.
 */
export const DECISION_BUDGET = 65_000

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
  generation: number
  generationsCompleted: number
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
  /** §18.2 */
  untouchedIds: string[]
  untouchedShare: number
  /** §21.3: divergence class per baseline building, for cross-seed entropy */
  divergenceByBuilding: Record<string, number>
  /**
   * Purpose mix of the residue. A whole class appearing here at 100% is the
   * signature of structural exclusion rather than economic disinterest, which
   * is exactly what the first §18.2 run turned up.
   */
  untouchedByPurpose: Record<string, { untouched: number; total: number }>
  correlations: { access: number; landValue: number; adjacency: number }
  /** structural canaries over the seed itself */
  structural: StructuralReport
  curve: Array<{ decisions: number; index: number; agentOrigin: number; cleared: number; generation: number }>
}

export interface StructuralReport {
  parcels: number
  developableVacantShare: number
  roadReachableShare: number
  buildingsWithBackLinkedParcel: number
  buildingsTotal: number
  selfIntersectingParcels: number
  /** derived (Voronoi) parcels laid over a carriageway — must be zero */
  derivedParcelsOverCarriageway: number
  /**
   * Footprint-derived parcels containing a carriageway. These are real BAG
   * buildings that OSM draws a road through — gatehouses, arcades, service
   * passages. The parcel is the building's own footprint and the building
   * genuinely stands there; dropping it would make a real building unownable,
   * which is the unreachable-land class §18.2 exists to catch.
   */
  footprintParcelsOverCarriageway: number
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
        curve.push({
          decisions: sim.decisionsIssued,
          index: report.index,
          agentOrigin: report.agentOrigin,
          cleared: report.demolished,
          generation,
        })
      }
    },
  })

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
    if (e.type === 'building_acquired' && (e.rationale ?? '').startsWith('site is worth')) {
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
    flags.push(untouched)
    access.push(parcel.accessScore)
    value.push(parcel.landValue)
    degree.push((w.adjacency.get(parcel.id) ?? []).length)
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
    generation: w.generation,
    generationsCompleted: w.generationsCompleted,
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
    untouchedIds,
    divergenceByBuilding,
    untouchedByPurpose: byPurpose,
    untouchedShare: flags.length ? flags.reduce((a, b) => a + b, 0) / flags.length : 0,
    correlations: {
      access: pearson(flags, access),
      landValue: pearson(flags, value),
      adjacency: pearson(flags, degree),
    },
    structural: structuralReport(world),
    curve,
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

// ---------------------------------------------------------------------------
// §18.3 structural canaries — properties of the seed, checked once
// ---------------------------------------------------------------------------

export function structuralReport(world: WorldSeed): StructuralReport {
  const parcels = world.parcels
  const byId = new Map(parcels.map((p) => [p.id, p]))

  const occupied = new Set<string>()
  let backLinked = 0
  for (const p of parcels) if (p.buildingId) occupied.add(p.buildingId)
  for (const b of world.buildings) if (occupied.has(b.id)) backLinked++

  const vacantDevelopable = parcels.filter((p) => !p.buildingId && p.developable).length
  const reachable = parcels.filter((p) => p.roadDistanceM <= 60).length

  let selfIntersecting = 0
  for (const p of parcels) if (ringSelfIntersects(p.polygon)) selfIntersecting++

  const over = countParcelsOverCarriageway(world, byId)

  return {
    parcels: parcels.length,
    developableVacantShare: vacantDevelopable / Math.max(1, parcels.length),
    roadReachableShare: reachable / Math.max(1, parcels.length),
    buildingsWithBackLinkedParcel: backLinked,
    buildingsTotal: world.buildings.length,
    selfIntersectingParcels: selfIntersecting,
    derivedParcelsOverCarriageway: over.derived,
    footprintParcelsOverCarriageway: over.footprint,
  }
}

/** O(n²) over a ring's segments; rings here are under ~30 vertices. */
function ringSelfIntersects(ring: Ring): boolean {
  const n = ring.length
  if (n < 4) return false
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]
    const a2 = ring[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // shares the closing vertex
      const b1 = ring[j]
      const b2 = ring[(j + 1) % n]
      if (segmentsCross(a1, a2, b1, b2)) return true
    }
  }
  return false
}

function segmentsCross(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number],
): boolean {
  const d = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = d(b1, b2, a1)
  const d2 = d(b1, b2, a2)
  const d3 = d(a1, a2, b1)
  const d4 = d(a1, a2, b2)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

/**
 * A parcel must not sit on the carriageway. Sampling the road centrelines and
 * asserting no sample lands inside a parcel is the direct test — this is the
 * sidewalk-as-block-face bug from build 1, which produced parcels covering the
 * street and looked entirely plausible in the numbers.
 */
function countParcelsOverCarriageway(
  world: WorldSeed,
  byId: Map<string, Parcel>,
): { derived: number; footprint: number } {
  const nodes = new Map(world.roads.nodes.map((n) => [n.id, n]))
  const grid = new Map<string, Parcel[]>()
  const CELL = 30
  const key = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`
  for (const p of byId.values()) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of p.polygon) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    for (let x = minX; x <= maxX + CELL; x += CELL) {
      for (let y = minY; y <= maxY + CELL; y += CELL) {
        const k = key(x, y)
        const arr = grid.get(k)
        if (arr) arr.push(p)
        else grid.set(k, [p])
      }
    }
  }

  const offenders = new Set<string>()
  for (const e of world.roads.edges) {
    // Footways and cycleways run through courtyards and alleys; a parcel
    // containing one is normal. Only vehicular carriageways are the fault.
    if (!BLOCK_BOUNDING_CLASSES.has(e.class)) continue
    const a = nodes.get(e.a)
    const b = nodes.get(e.b)
    if (!a || !b) continue
    for (const t of [0.25, 0.5, 0.75]) {
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      for (const p of grid.get(key(x, y)) ?? []) {
        if (offenders.has(p.id)) continue
        if (pointInRing(p.polygon, x, y)) offenders.add(p.id)
      }
    }
  }
  let derived = 0
  let footprint = 0
  for (const id of offenders) {
    if (byId.get(id)?.blockId === 'blk-orphan') footprint++
    else derived++
  }
  return { derived, footprint }
}

function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
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
