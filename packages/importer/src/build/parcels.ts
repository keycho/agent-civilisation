import {
  type BaselineBuilding,
  type Block,
  type Parcel,
  type Ring,
  type RoadEdge,
  type RoadNode,
  BLOCK_BOUNDING_CLASSES,
  CARRIAGEWAY_SAMPLE_TS,
  ROAD_ACCESS_VALUE,
  type Vec2,
  area as ringArea,
  centroid,
  cleanRing,
  clipByConvex,
  containsPoint,
  distanceToRing,
  distanceToSegment,
  insetRing,
  convexHull,
  makeRng,
  quantiseRing,
  ringSelfIntersects,
} from '@civ/core'
import { Delaunay } from 'd3-delaunay'
import { GridIndex, ringBounds } from '../util/grid.ts'

/**
 * §6. Open cadastral data mostly does not exist, so parcels are derived.
 *
 * The spec's recipe is buildings-as-seeds, but seeding only on buildings gives
 * every cell a building and therefore no development inventory at all. Open
 * ground inside a block is seeded too — on a jittered lattice, kept only where
 * it is genuinely clear of the existing stock — so vacant parcels appear in
 * proportion to how open the fabric actually is, which is what makes `develop`
 * a real option rather than a dead branch.
 *
 * Crude versus a real cadastre and completely sufficient.
 */

export interface ParcelsResult {
  parcels: Parcel[]
  blocks: Block[]
  vacant: number
  occupied: number
  undevelopable: number
  orphanBuildings: number
  selfIntersectingDropped: number
  overCarriagewayDropped: number
}

const OPEN_SEED_SPACING_M = 15
const OPEN_SEED_CLEARANCE_M = 7.5
/**
 * A block face runs to the road centreline, so its outer metres are
 * carriageway. Parcels are cut from the block inset by at least this much — but
 * a fixed inset is wrong: a 12 m primary needs 6 m of setback and a fixed 3.5
 * put 188 parcels on the tarmac. The real inset is the half-width of the widest
 * road bounding that particular block, which extractBlocks now records.
 */
const ROAD_CORRIDOR_MIN_M = 3.5
const KERB_CLEARANCE_M = 0.75
const BLOCK_INSET_M = 1.6
/** Below this a vacant cell is a gap between buildings, not a development site. */
const MIN_VACANT_AREA_M2 = 40

interface Seed {
  p: Vec2
  building?: BaselineBuilding
}

export function deriveParcels(
  blocks: Block[],
  buildings: BaselineBuilding[],
  roadNodes: RoadNode[],
  roadEdges: RoadEdge[],
  water: Ring[],
  chunkId: string,
  clip: { minX: number; minY: number; maxX: number; maxY: number },
): ParcelsResult {
  const rng = makeRng('parcels')
  const inChunk = (p: Vec2) =>
    p[0] >= clip.minX && p[0] <= clip.maxX && p[1] >= clip.minY && p[1] <= clip.maxY

  const buildingIndex = new GridIndex<BaselineBuilding>(30)
  for (const b of buildings) buildingIndex.insert(ringBounds(b.footprint), b)

  const waterIndex = new GridIndex<Ring>(60)
  for (const w of water) waterIndex.insert(ringBounds(w), w)

  const nodeById = new Map<string, RoadNode>()
  for (const n of roadNodes) nodeById.set(n.id, n)
  const roadIndex = new GridIndex<{ a: Vec2; b: Vec2; edge: RoadEdge }>(30)
  for (const e of roadEdges) {
    const na = nodeById.get(e.a)
    const nb = nodeById.get(e.b)
    if (!na || !nb) continue
    const seg = { a: [na.x, na.y] as Vec2, b: [nb.x, nb.y] as Vec2, edge: e }
    roadIndex.insert(
      {
        minX: Math.min(na.x, nb.x),
        minY: Math.min(na.y, nb.y),
        maxX: Math.max(na.x, nb.x),
        maxY: Math.max(na.y, nb.y),
      },
      seg,
    )
  }

  const parcels: Parcel[] = []
  const claimed = new Set<string>()
  let selfIntersecting = 0
  let overCarriageway = 0

  for (const block of blocks) {
    // the developable interior of the block, off the carriageway
    const corridor = Math.max(ROAD_CORRIDOR_MIN_M, block.roadHalfWidthM + KERB_CLEARANCE_M)
    const domain = insetRing(block.polygon, corridor)
    if (!domain || ringArea(domain) < 25) continue
    const inner = insetRing(domain, BLOCK_INSET_M) ?? domain
    const bb = ringBounds(domain)

    // seeds: every building whose centroid falls in this block ...
    const seeds: Seed[] = []
    const blockBuildings: BaselineBuilding[] = []
    for (const b of buildingIndex.queryRadius(
      [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2],
      Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 + 20,
    )) {
      if (claimed.has(b.id)) continue
      const c = centroid(b.footprint)
      if (containsPoint(block.polygon, c)) {
        seeds.push({ p: c, building: b })
        blockBuildings.push(b)
      }
    }

    // ... plus open ground, which is the development inventory
    for (let x = bb.minX; x <= bb.maxX; x += OPEN_SEED_SPACING_M) {
      for (let y = bb.minY; y <= bb.maxY; y += OPEN_SEED_SPACING_M) {
        const p: Vec2 = [
          x + (rng() - 0.5) * OPEN_SEED_SPACING_M * 0.6,
          y + (rng() - 0.5) * OPEN_SEED_SPACING_M * 0.6,
        ]
        if (!containsPoint(inner, p)) continue
        let clear = true
        for (const b of buildingIndex.queryRadius(p, OPEN_SEED_CLEARANCE_M + 12)) {
          if (
            containsPoint(b.footprint, p) ||
            distanceToRing(p, b.footprint) < OPEN_SEED_CLEARANCE_M
          ) {
            clear = false
            break
          }
        }
        if (clear) seeds.push({ p })
      }
    }

    if (seeds.length === 0) continue

    let cells: Array<Ring | null>
    if (seeds.length === 1) {
      cells = [domain]
    } else {
      const del = Delaunay.from(
        seeds.map((s) => s.p),
        (p) => p[0],
        (p) => p[1],
      )
      const vor = del.voronoi([bb.minX - 50, bb.minY - 50, bb.maxX + 50, bb.maxY + 50])
      cells = seeds.map((_, i) => {
        const poly = vor.cellPolygon(i)
        if (!poly) return null
        const ring = poly.slice(0, -1).map(([x, y]) => [x, y] as Vec2)
        // Voronoi cells are convex, so they are legal Sutherland-Hodgman clips
        // and the concave block can safely be the subject. Quantise here, at
        // the point of creation, so what gets validated below is exactly what
        // gets serialised.
        return quantiseRing(cleanRing(clipByConvex(domain, ring)))
      })
    }

    for (let i = 0; i < seeds.length; i++) {
      const ring = cells[i]
      if (!ring || ring.length < 3) continue
      const a = ringArea(ring)
      if (a < 6) continue

      const seed = seeds[i]
      if (!seed.building && a < MIN_VACANT_AREA_M2) continue

      // A service road can dead-end inside a block: it has a degree-1 tip, so
      // it never forms a face and never bounds the block, but it is physically
      // there and a parcel must not be laid over it.
      let ring2 = ring
      if (overlapsCarriageway(roadIndex, nodeById, ring2)) {
        const pulled = insetRing(ring2, 3)
        if (!pulled || overlapsCarriageway(roadIndex, nodeById, pulled)) {
          overCarriageway++
          if (process.env.CIV_DIAGNOSE_DROPS) {
            const cc = centroid(ring2)
            console.error(`  drop over-carriageway at ${cc[0].toFixed(0)},${cc[1].toFixed(0)}`)
          }
          continue
        }
        ring2 = quantiseRing(pulled)
      }
      // Sutherland-Hodgman bridges disconnected pieces of a concave block with
      // a zero-width neck; the result is a legal-looking vertex list and an
      // illegal parcel.
      if (ringSelfIntersects(ring2)) {
        selfIntersecting++
        continue
      }
      const c = centroid(ring2)
      if (!inChunk(c)) continue
      const { distance, value } = nearestRoad(roadIndex, c)
      const inWater = isInWater(waterIndex, ring, c)

      if (seed.building) claimed.add(seed.building.id)

      parcels.push({
        id: `p-${parcels.length}`,
        chunkId,
        blockId: block.id,
        polygon: ring2,
        areaM2: ringArea(ring2),
        buildingId: seed.building?.id,
        accessScore: accessScore(distance, value),
        roadDistanceM: distance,
        landValue: 0, // the economy owns this; set on load (§4)
        developable: !inWater,
        centroid: [c[0], c[1]],
      })
      block.parcelIds.push(parcels[parcels.length - 1].id)
    }
  }

  // Buildings outside every block face — canal-side rows, edge-of-extract
  // fragments — still need something ownable, or a chunk of the baseline stock
  // is permanently unbuyable and divergence can never reach it.
  let orphanBuildings = 0
  for (const b of buildings) {
    if (claimed.has(b.id)) continue
    orphanBuildings++
    // Outsetting a concave footprint can fold a corner through an edge. The
    // hull is the last resort: always simple, and a plot boundary drawn around
    // a building is a reasonable thing for it to be.
    const grown = insetRing(b.footprint, -1.2)
    const candidate =
      grown && !ringSelfIntersects(quantiseRing(grown)) ? grown : b.footprint
    // An outset ring can cross the kerb of the street the building fronts on.
    // The building's own footprint cannot be on the carriageway, so that is the
    // fallback.
    const ring = quantiseRing(
      overlapsCarriageway(roadIndex, nodeById, candidate) ? b.footprint : candidate,
    )
    if (ringSelfIntersects(ring)) {
      selfIntersecting++
      continue
    }
    const c = centroid(ring)
    const { distance, value } = nearestRoad(roadIndex, c)
    parcels.push({
      id: `p-${parcels.length}`,
      chunkId,
      blockId: 'blk-orphan',
      polygon: ring,
      areaM2: ringArea(ring),
      buildingId: b.id,
      accessScore: accessScore(distance, value),
      roadDistanceM: distance,
      landValue: 0,
      developable: true,
      centroid: [c[0], c[1]],
    })
  }

  const occupied = parcels.filter((p) => p.buildingId).length
  return {
    parcels,
    blocks,
    vacant: parcels.length - occupied,
    occupied,
    undevelopable: parcels.filter((p) => !p.developable).length,
    orphanBuildings,
    selfIntersectingDropped: selfIntersecting,
    overCarriagewayDropped: overCarriageway,
  }
}

function nearestRoad(
  index: GridIndex<{ a: Vec2; b: Vec2; edge: RoadEdge }>,
  p: Vec2,
): { distance: number; value: number } {
  let best = Infinity
  let value = 0.3
  for (const r of [30, 70, 150, 320]) {
    for (const seg of index.queryRadius(p, r)) {
      const d = distanceToSegment(p, seg.a, seg.b)
      if (d < best) {
        best = d
        value = ROAD_ACCESS_VALUE[seg.edge.class]
      }
    }
    if (best < r) break
  }
  return { distance: Number.isFinite(best) ? best : 999, value }
}

/**
 * §4's access gradient. Landlocked parcels are cheap and useless until
 * someone builds a road, which is what makes `build_road` worth an agent's
 * capital.
 */
function accessScore(distanceM: number, classValue: number): number {
  return classValue * Math.exp(-Math.max(0, distanceM - 6) / 34)
}

/**
 * Does this ring contain a vehicular road centreline? Footways run through
 * courtyards and alleys legitimately; carriageways do not run through plots.
 */
function overlapsCarriageway(
  index: GridIndex<{ a: Vec2; b: Vec2; edge: RoadEdge }>,
  _nodes: Map<string, RoadNode>,
  ring: Ring,
): boolean {
  const c = centroid(ring)
  let radius = 0
  for (const v of ring) radius = Math.max(radius, Math.hypot(v[0] - c[0], v[1] - c[1]))
  for (const seg of index.queryRadius(c, radius + 6)) {
    if (!BLOCK_BOUNDING_CLASSES.has(seg.edge.class)) continue
    for (const t of CARRIAGEWAY_SAMPLE_TS) {
      const x = seg.a[0] + (seg.b[0] - seg.a[0]) * t
      const y = seg.a[1] + (seg.b[1] - seg.a[1]) * t
      if (containsPoint(ring, [x, y])) return true
    }
  }
  return false
}

function isInWater(index: GridIndex<Ring>, ring: Ring, c: Vec2): boolean {
  const probes: Vec2[] = [c]
  for (let i = 0; i < Math.min(4, ring.length); i++) {
    const v = ring[Math.floor((i * ring.length) / 4)]
    probes.push([(v[0] + c[0]) / 2, (v[1] + c[1]) / 2])
  }
  let hits = 0
  for (const p of probes) {
    for (const w of index.queryPoint(p)) {
      if (containsPoint(w, p)) {
        hits++
        break
      }
    }
  }
  return hits >= Math.ceil(probes.length / 2)
}
