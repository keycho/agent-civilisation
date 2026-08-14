import { ringSelfIntersects } from './geo/polygon.ts'
import { BLOCK_BOUNDING_CLASSES, type Ring } from './types.ts'
import type { Parcel, WorldSeed } from './world.ts'

/**
 * §18.3's structural canaries, and §21.4's rule about where they run.
 *
 * Twenty self-intersecting parcels survived a fix because the validator read
 * the unrounded ring while the emitter wrote millimetre-quantised coordinates.
 * What was checked was not what was written. The general form:
 *
 *   every canary asserts against the emitted artifact, after quantisation,
 *   serialisation and any lossy step, never against the in-memory value that
 *   preceded it. Where a validator and an emitter both exist, the validator
 *   reads the emitter's output file.
 *
 * So this lives in core rather than in the test harness: the importer runs it
 * on the JSON it has just written and re-read, and `tune.ts` runs the same
 * function on the same file. There is one implementation and it only ever sees
 * artifacts.
 */

export interface SeedReport {
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

export interface Check {
  ok: boolean
  label: string
  detail: string
}

export function validateSeed(world: WorldSeed): SeedReport {
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

/** The report as pass/fail checks, so the importer and `tune.ts` agree. */
export function seedChecks(r: SeedReport): Check[] {
  return [
    {
      ok: r.buildingsWithBackLinkedParcel === r.buildingsTotal,
      label: 'every building has a parcel that points back',
      detail: `${r.buildingsWithBackLinkedParcel}/${r.buildingsTotal}`,
    },
    {
      ok: r.developableVacantShare > 0.05,
      label: 'developable vacant parcels > 5% of parcels',
      detail: `${(r.developableVacantShare * 100).toFixed(1)}%`,
    },
    {
      ok: r.roadReachableShare > 0.95,
      label: 'parcels reachable from the road graph > 95%',
      detail: `${(r.roadReachableShare * 100).toFixed(1)}%`,
    },
    {
      ok: r.selfIntersectingParcels === 0,
      label: 'no parcel geometry self-intersects',
      detail: `${r.selfIntersectingParcels} bad`,
    },
    {
      ok: r.derivedParcelsOverCarriageway === 0,
      label: 'no derived parcel overlaps a carriageway',
      detail: `${r.derivedParcelsOverCarriageway} over`,
    },
    {
      ok: r.footprintParcelsOverCarriageway <= Math.ceil(r.parcels * 0.01),
      label: 'footprint parcels over a carriageway within 1%',
      detail: `${r.footprintParcelsOverCarriageway} (OSM draws a road through the building)`,
    },
  ]
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
