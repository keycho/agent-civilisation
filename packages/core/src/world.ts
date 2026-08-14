import type {
  ArchetypeId,
  BuildingSource,
  BuildingState,
  ChunkMeta,
  Purpose,
  Ring,
  RoadClass,
  RoadEdge,
  RoadNode,
} from './types.ts'
import type { RoofHint } from './archetype/select.ts'

/**
 * The seed emitted by the importer and the shape the runtime keeps in memory.
 *
 * §5's three lifecycles are kept apart here as they are in the SQL: the
 * baseline is written once and never touched again, the current state is
 * mutable, and events are append-only. Conflating them destroys the comparison
 * that the product is built on.
 */

// ---------------------------------------------------------------------------
// baseline — written once at import, never updated
// ---------------------------------------------------------------------------

export interface BaselineBuilding {
  id: string
  chunkId: string
  /** BAG pand identifier, and the OSM way the tags came from */
  bagId?: string
  osmId?: string
  /** chunk-local metres. The real footprint, preserved. */
  footprint: Ring
  /** ground level in NAP metres — the substrate contract (§10) must reproduce this */
  groundM: number
  heightM: number
  levels: number
  constructionYear?: number
  purpose: Purpose
  archetype: ArchetypeId
  roofHint?: RoofHint
  name?: string
}

// ---------------------------------------------------------------------------
// current — mutable
// ---------------------------------------------------------------------------

export interface Building {
  id: string
  baselineId?: string
  source: BuildingSource
  chunkId: string
  parcelId?: string
  footprint: Ring
  groundM: number
  heightM: number
  levels: number
  purpose: Purpose
  archetype: ArchetypeId
  roofHint?: RoofHint
  condition: number
  ownerId?: string
  state: BuildingState
  progress: number
  divergence: number
  /** the building this one stands in place of — walks the redevelopment chain */
  replaces?: string
  constructionYear?: number
  createdTick: number
  demolishedTick?: number
  name?: string
  /** cached, recomputed on geometry change */
  areaM2: number
  /** rent-equivalent produced per tick at condition 1 */
  yieldPerTick: number
}

export interface Parcel {
  id: string
  chunkId: string
  blockId: string
  polygon: Ring
  areaM2: number
  /** building currently standing on it, if any */
  buildingId?: string
  ownerId?: string
  /** 0..1, from graph distance to the road network */
  accessScore: number
  /** metres to the nearest road edge */
  roadDistanceM: number
  /** derived land value per m², updated as intensity changes around it */
  landValue: number
  /** false when water or protected landcover makes it undevelopable */
  developable: boolean
  centroid: [number, number]
}

export interface Block {
  id: string
  polygon: Ring
  areaM2: number
  parcelIds: string[]
  /**
   * Half the width of the widest road bounding this face. A block face runs to
   * the road centreline, so parcels have to be set back by at least this or
   * they sit on the carriageway — a 12 m primary needs 6 m, not the 3.5 m that
   * a residential street needs.
   */
  roadHalfWidthM: number
}

export interface DistrictSeed {
  id: string
  name: string
  polygon: Ring
}

// ---------------------------------------------------------------------------
// substrate contract (§10) — defined at stage 1, held to when voxcity lands
// ---------------------------------------------------------------------------

export interface SubstrateSurface {
  kind: 'water' | 'park' | 'grass' | 'wood' | 'parking' | 'paving' | 'farmland' | 'rail'
  polygon: Ring
  name?: string
}

/**
 * Everything the renderer needs about the ground. Today it is filled from OSM
 * landcover and a flat NAP datum; at stage 10 voxcity fills the same fields
 * with terrain, canopy and coastline. Nothing downstream may read anything
 * about the ground that is not in here.
 */
export interface Substrate {
  /** metres per sample in the elevation grid */
  cellSizeM: number
  /** row-major, (cols x rows) samples of ground height in NAP metres */
  elevation: number[]
  cols: number
  rows: number
  /** local-frame position of elevation sample (0,0) */
  originX: number
  originY: number
  surfaces: SubstrateSurface[]
  provider: 'flat-datum' | 'voxcity'
}

// ---------------------------------------------------------------------------
// the seed file
// ---------------------------------------------------------------------------

export interface Provenance {
  layer: string
  source: string
  licence: string
  retrieved: string
}

export interface WorldSeed {
  version: 3
  chunk: ChunkMeta
  buildings: BaselineBuilding[]
  roads: {
    nodes: RoadNode[]
    edges: RoadEdge[]
  }
  blocks: Block[]
  parcels: Parcel[]
  substrate: Substrate
  districts: DistrictSeed[]
  provenance: Provenance[]
  stats: Record<string, number | string>
}

export function roadClassOf(highway: string): RoadClass | null {
  switch (highway) {
    case 'motorway':
    case 'trunk':
    case 'primary':
    case 'motorway_link':
    case 'trunk_link':
    case 'primary_link':
      return 'primary'
    case 'secondary':
    case 'tertiary':
    case 'secondary_link':
    case 'tertiary_link':
    case 'busway':
      return 'secondary'
    case 'residential':
    case 'unclassified':
    case 'living_street':
      return 'residential'
    case 'service':
    case 'track':
      return 'service'
    case 'pedestrian':
      return 'pedestrian'
    case 'footway':
    case 'path':
    case 'cycleway':
    case 'steps':
    case 'bridleway':
      return 'footpath'
    default:
      return null
  }
}

export function buildingVolume(b: Pick<Building, 'areaM2' | 'heightM'>): number {
  return b.areaM2 * b.heightM
}

/** Node lookup keyed by id, rebuilt on load rather than serialised as a Map. */
export function indexNodes(nodes: RoadNode[]): Map<string, RoadNode> {
  const m = new Map<string, RoadNode>()
  for (const n of nodes) m.set(n.id, n)
  return m
}
