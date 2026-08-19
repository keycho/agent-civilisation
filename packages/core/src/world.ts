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
  /**
   * §31.2: where the height came from. Absent means measured (the NL path is
   * all 3DBAG lidar). Adapters for countries without national height data set
   * 'estimated' — levels inferred from footprint area and purpose — and the
   * §31.5 import-health manifest reports the split per chunk.
   */
  heightSource?: 'measured' | 'estimated'
  /**
   * §42.2: what makes this building a landmark, when something does. Flagged
   * at import from OSM tags; the generator spends bespoke silhouette craft on
   * exactly these classes, the economics prices them expensive and
   * conversion-limited (never blanket-protected — a church converting to a
   * workshop is a legitimate high-weight feed event), and events on them ride
   * cinematic weight. `untouchable` marks the small per-chunk list that never
   * enters the market at all.
   */
  landmark?: { class: LandmarkClass; untouchable?: boolean }
}

/** §42.2: the landmark classes the importer recognises from OSM tags. */
export const LANDMARK_CLASSES = [
  'historic',
  'gasholder',
  'water_tower',
  'crane',
  'church',
  'station',
] as const
export type LandmarkClass = (typeof LANDMARK_CLASSES)[number]

/**
 * §42.2: linear landmarks — the petite ceinture cutting, a canal basin edge —
 * carried as their own seed layer so the ground treatment is theirs rather
 * than generic road or water.
 */
export interface LandmarkLine {
  class: 'rail' | 'canal'
  /** chunk-local metres */
  path: Array<[number, number]>
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
  /**
   * §72.5: the level count this structure was BUILT as, which never changes.
   *
   * Structural capacity is a property of the structure as designed, not of the
   * structure as it now stands — a rule read off `levels` re-reads itself after
   * every expansion and is therefore unbounded, which is what let six separate
   * one-floor additions land on a two-storey terrace.
   */
  designLevels?: number
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
  /**
   * §22.1: the parcels an agent developed this on. A structure standing on more
   * than one is the grain of the city having changed, not just its surface.
   */
  builtOnParcels?: string[]
  demolishedTick?: number
  name?: string
  /** cached, recomputed on geometry change */
  areaM2: number
  /** rent-equivalent produced per tick at condition 1 */
  yieldPerTick: number
  /** §42.2: carried from the baseline; agent-built stock never has one */
  landmark?: { class: LandmarkClass; untouchable?: boolean }
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
  /**
   * §30.3: within the boundary margin of the chunk edge, where the world this
   * parcel's economics depend on is partly outside the fetched extent. Flagged
   * at import so every number from here on is produced on a world that already
   * knows its perimeter — the gate itself (excluding these from the developable
   * set) stays off until the neighbouring chunk can materialise, and turns on
   * per chunk-pair. §29.5 costed the naive always-on gate at 22% of inventory,
   * which is why this is a flag and a switch rather than a rule.
   */
  boundaryAdjacent?: boolean
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
  /**
   * Where the ground came from. §21.5 retires voxcity for chunks in countries
   * with a national lidar product and keeps the seam: `ahn` carries elevation
   * only and leaves `surfaces` to the importer, because AHN is a terrain model
   * and the canals already arrive through OSM.
   */
  provider: 'flat-datum' | 'voxcity' | 'ahn'
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
  /** §42.2: linear landmarks with their own ground treatment */
  landmarkLines?: LandmarkLine[]
  provenance: Provenance[]
  stats: Record<string, number | string | Record<string, number>> & {
    /** §31.5: per-chunk import health, recorded in the artifact */
    importHealth?: {
      heightsReal: number
      yearsPresent: number
      boundaryParcels: number
      /** §33.1: ownable/imported — the region-join precondition */
      ownableShare?: number
      synthesisedParcels?: number
      rowsSplit?: number
      /** §34: share of stock with a positive best-use cap at day 0 */
      viableShare?: number
      /** the same with conversion blinded — the spread is conversion dependence */
      viableIncomeOnly?: number
    }
  }
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
