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
 * CALIBRATED ONCE, then frozen.
 *
 * Measured by calibrate.ts: running one seed and recording the decision count
 * at which the build first reaches the end state it already had before the
 * calendar was removed — 34.6% divergence, 135 agent-built structures, 85
 * cleared. All three together, not whichever arrives first; the index alone
 * crosses 34.6% at ~22,600 while the physical stock is still less than half
 * built. The composite lands at 39,050.
 *
 * It is not adjusted until the assertions pass. Tuning the budget to hit a
 * target is precisely the hill-climb error §18 exists to catch, so this number
 * does not move. If the model changes enough to invalidate it, re-run
 * calibrate.ts deliberately and record why in the commit.
 */
export const DECISION_BUDGET = 39_000

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
  /** §18.2 */
  untouchedIds: string[]
  untouchedShare: number
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
  for (const e of store.events({ limit: 1e9 })) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1
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
  const untouchedIds: string[] = []
  const byPurpose: Record<string, { untouched: number; total: number }> = {}
  const flags: number[] = []
  const access: number[] = []
  const value: number[] = []
  const degree: number[] = []
  for (const b of w.buildings.values()) {
    if (b.source !== 'real_world') continue
    const parcel = w.parcelOf(b)
    if (!parcel) continue
    const untouched = b.divergence === 0 ? 1 : 0
    const row = (byPurpose[b.purpose] ??= { untouched: 0, total: 0 })
    row.total++
    if (untouched) {
      row.untouched++
      untouchedIds.push(b.id)
    }
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
    untouchedIds,
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
