/**
 * Shared vocabulary. Everything that the importer, the simulation and the
 * renderer all have to agree about lives here and nowhere else.
 */

// ---------------------------------------------------------------------------
// geometry primitives
// ---------------------------------------------------------------------------

/** [x, y] in a chunk-local ENU metre frame. x = east, y = north. */
export type Vec2 = [number, number]

/** Closed ring, first point NOT repeated at the end, CCW = positive area. */
export type Ring = Vec2[]

/** Outer ring plus holes. Holes are ignored by most of the pipeline. */
export interface Polygon {
  outer: Ring
  holes?: Ring[]
}

export interface Bounds2 {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ---------------------------------------------------------------------------
// purpose
// ---------------------------------------------------------------------------

export const PURPOSES = [
  'residential',
  'retail',
  'commercial',
  'office',
  'industrial',
  'civic',
  'agricultural',
  'utility',
] as const

export type Purpose = (typeof PURPOSES)[number]

/** Index into the palette, written into the buildingData texture's blue channel. */
export const PURPOSE_INDEX: Record<Purpose, number> = {
  residential: 0,
  retail: 1,
  commercial: 2,
  office: 3,
  industrial: 4,
  civic: 5,
  agricultural: 6,
  utility: 7,
}

// ---------------------------------------------------------------------------
// archetypes
// ---------------------------------------------------------------------------

/**
 * Visual vocabulary. The first eight are the minimum set for European low-rise
 * fabric. The `agent_*` set is deliberately a separate vocabulary: agent-built
 * structures must be legible by silhouette alone, before any overlay is engaged.
 */
export const ARCHETYPES = [
  'rowhouse',
  'apartment',
  'warehouse',
  'industrial',
  'civic',
  'retail',
  'tower',
  'agricultural',
  // agent vocabulary — flat roofs, cleaner geometry, larger floorplates
  'agent_block',
  'agent_slab',
  'agent_tower',
  'agent_hall',
] as const

export type ArchetypeId = (typeof ARCHETYPES)[number]

export const AGENT_ARCHETYPES: ReadonlySet<string> = new Set([
  'agent_block',
  'agent_slab',
  'agent_tower',
  'agent_hall',
])

export function isAgentArchetype(a: ArchetypeId): boolean {
  return AGENT_ARCHETYPES.has(a)
}

// ---------------------------------------------------------------------------
// divergence (§8)
// ---------------------------------------------------------------------------

export const DIVERGENCE = {
  untouched: 0,
  owned: 1,
  renovated: 2,
  converted: 3,
  expanded: 4,
  cleared: 5,
  replaced: 6,
  agentOrigin: 7,
} as const

export type DivergenceClass = (typeof DIVERGENCE)[keyof typeof DIVERGENCE]

export const DIVERGENCE_LABEL: Record<number, string> = {
  0: 'untouched real',
  1: 'owned',
  2: 'renovated',
  3: 'converted',
  4: 'expanded',
  5: 'cleared',
  6: 'replaced',
  7: 'agent origin',
}

/**
 * How much each class counts toward the divergence index, and how strongly it
 * is pushed away from the base palette in divergence mode. Ownership alone is
 * a weak signal; a replacement or an agent-origin structure is a strong one.
 */
export const DIVERGENCE_WEIGHT: Record<number, number> = {
  0: 0.0,
  1: 0.15,
  2: 0.35,
  3: 0.55,
  4: 0.7,
  5: 0.8,
  6: 1.0,
  7: 1.0,
}

// ---------------------------------------------------------------------------
// building state
// ---------------------------------------------------------------------------

export const BUILDING_STATES = [
  'standing',
  'under_construction',
  'under_demolition',
  'demolished',
] as const

export type BuildingState = (typeof BUILDING_STATES)[number]

export type BuildingSource = 'real_world' | 'agent_built'

// ---------------------------------------------------------------------------
// roads (§7)
// ---------------------------------------------------------------------------

export const ROAD_CLASSES = [
  'primary',
  'secondary',
  'residential',
  'service',
  'pedestrian',
  'footpath',
] as const

export type RoadClass = (typeof ROAD_CLASSES)[number]

/**
 * `footpath` is kept apart from `pedestrian` for one specific reason: OSM draws
 * sidewalks and cycleways as their own lines running parallel to the road
 * centreline, so a graph that includes them encloses the *carriageway* as a
 * face. Those faces then look like empty city blocks and agents cheerfully
 * develop on top of the street. Only the classes in BLOCK_BOUNDING_CLASSES
 * bound blocks; footpaths still count for access.
 */
export const BLOCK_BOUNDING_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'primary',
  'secondary',
  'residential',
  'service',
  'pedestrian',
])

/** Metres. Drives ribbon generation and access scoring. */
export const ROAD_WIDTH: Record<RoadClass, number> = {
  primary: 12,
  secondary: 9,
  residential: 6.5,
  service: 4.5,
  pedestrian: 3.5,
  footpath: 2.2,
}

/**
 * Relative cost of traversing a class when scoring parcel access. Nothing here
 * is a travel time; it is a legibility weight — a parcel on a primary road is
 * worth more than one on a footpath.
 */
export const ROAD_ACCESS_VALUE: Record<RoadClass, number> = {
  primary: 1.0,
  secondary: 0.85,
  residential: 0.65,
  service: 0.4,
  pedestrian: 0.35,
  footpath: 0.22,
}

export interface RoadNode {
  id: string
  /** chunk-local ENU metres */
  x: number
  y: number
  lat: number
  lon: number
}

export interface RoadEdge {
  id: string
  a: string
  b: string
  class: RoadClass
  agentBuilt: boolean
  builtTick?: number
  /** cached length in metres */
  length: number
}

// ---------------------------------------------------------------------------
// chunk registry (§10)
// ---------------------------------------------------------------------------

export interface ChunkOrigin {
  /** WGS84 anchor for the chunk's local ENU frame */
  lat: number
  lon: number
  /** RD New (EPSG:28992) easting/northing of the same anchor, when in NL */
  rdX?: number
  rdY?: number
}

export interface ChunkMeta {
  id: string
  name: string
  origin: ChunkOrigin
  /** WGS84 bbox: [south, west, north, east] */
  bbox: [number, number, number, number]
  /** local-frame bounds in metres */
  localBounds: Bounds2
  sourceNote: string
}

// ---------------------------------------------------------------------------
// ordering (§20)
// ---------------------------------------------------------------------------

/**
 * §20: the world has history, the simulation has no calendar.
 *
 * The tick did not disappear — construction spans it, decay accumulates on it,
 * ordering requires it — but it is an internal monotonic sequence number that
 * is never rendered and never named as time. There is no date formatter in this
 * codebase, and `construction_year` on a building is a fact about that building
 * in the same way its footprint is, not a reading from a clock.
 */

/**
 * The tick window over which rates (yield, decay, maintenance) are quoted.
 * Purely an internal normalisation so the constants in economy.ts are legible
 * numbers rather than six-decimal fractions. It is not a year and nothing
 * converts it to one.
 */
export const RATE_WINDOW_TICKS = 365

/**
 * The vintage of the source data, used only to turn a real construction year
 * into a starting condition and an era tint at import. It is not a simulation
 * epoch: nothing advances from it and nothing renders it.
 */
export const SOURCE_DATA_YEAR = 2026

/**
 * §20.3: speed no longer sets time per second. It sets how fast the
 * civilization thinks — agent decisions issued per real second. The spectator
 * is dialling throughput, not a calendar.
 */
export const THROUGHPUT = [
  { label: 'pause', decisionsPerSecond: 0 },
  { label: 'slow', decisionsPerSecond: 3 },
  { label: 'normal', decisionsPerSecond: 14 },
  { label: 'fast', decisionsPerSecond: 55 },
  { label: 'surge', decisionsPerSecond: 220 },
] as const

export type ThroughputLevel = (typeof THROUGHPUT)[number]

/**
 * §3's presence-marker threshold, rekeyed off throughput. Above this, agents
 * stop interpolating and render as static markers with an activity pulse —
 * continuous motion at surge rates is nonsense either way.
 */
export const AGENT_MOTION_MAX_THROUGHPUT = 14
