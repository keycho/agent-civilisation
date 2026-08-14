import {
  type Block,
  type Building,
  type Bounds2,
  type Parcel,
  type Purpose,
  type Ring,
  type RoadEdge,
  type RoadNode,
  type Vec2,
  type WorldSeed,
  SOURCE_DATA_YEAR,
  area as ringArea,
  centroid,
  distanceToRing,
  makeRng,
} from '@civ/core'
import type { WorldStore } from '@civ/persistence'

/**
 * Runtime world state. Mirrors the §5 tables: an immutable baseline, a mutable
 * current state, and an append-only log reached through the store.
 */

export interface MemoryEntry {
  tick: number
  note: string
}

export type Strategy = 'consolidator' | 'renovator' | 'developer' | 'converter'

export interface Agent {
  id: string
  name: string
  capital: number
  strategy: Strategy
  bornTick: number
  diedTick?: number
  generation: number
  heirId?: string
  /**
   * §20.5: an agent is born with a finite number of decisions and dies when it
   * spends them. A life is measured by what it did, not by how long it sat
   * there — so passing is cheap and acting is dear, and an aggressive agent
   * burns out while a cautious one persists. Generational turnover becomes a
   * function of activity: a busy district cycles through owners, a quiet one
   * does not.
   */
  effortBudget: number
  effortSpent: number
  decisionsMade: number
  /** stable identity marker assigned at birth so recurring characters are recognisable (§16.6) */
  colourIndex: number
  holdings: Set<string>
  parcels: Set<string>
  memory: MemoryEntry[]
  nextDecisionTick: number
  /** render-only presence. Movement is never an event (§5). */
  x: number
  y: number
  targetX: number
  targetY: number
  /** what the agent is doing right now, for the presence pulse */
  activity: 'idle' | 'acquiring' | 'building' | 'demolishing'
}

export interface ParcelAdjacency {
  /** parcel id -> ids sharing a boundary */
  neighbours: Map<string, string[]>
}

export class World {
  /**
   * §20.2: an internal monotonic sequence number. Construction spans it, decay
   * accumulates on it, ordering requires it. It is never rendered and never
   * named as time.
   */
  tick = 0
  /** cumulative decisions issued — the x axis divergence is plotted against (§20.7) */
  decisionsIssued = 0
  /**
   * §18.3: how many times each action kind was actually applied. A dead branch
   * is a missing kind, and every bug in the first build produced plausible
   * output — so what fired is asserted rather than assumed.
   */
  readonly actionCounts = new Map<string, number>()
  readonly chunkId: string
  readonly seed: WorldSeed
  readonly store: WorldStore
  readonly rng: ReturnType<typeof makeRng>

  readonly buildings = new Map<string, Building>()
  readonly parcels = new Map<string, Parcel>()
  readonly blocks = new Map<string, Block>()
  readonly agents = new Map<string, Agent>()
  readonly nodes = new Map<string, RoadNode>()
  readonly edges = new Map<string, RoadEdge>()

  /** parcel adjacency drives `assemble`, which is what produces districts (§4) */
  adjacency = new Map<string, string[]>()

  readonly bounds: Bounds2
  /** coarse built-volume field, recomputed periodically (see economy.ts) */
  intensity!: Float32Array
  /** blurred floor area, total and split by purpose — drives demand saturation */
  floorTotal!: Float32Array
  floorByPurpose!: Map<Purpose, Float32Array>
  intensityCols = 0
  intensityRows = 0
  readonly intensityCell = 20

  /** buildings created by agents, needing geometry on the client */
  readonly pendingGeometry: string[] = []
  /** road edges created by agents, needing a ribbon rebuild */
  readonly pendingRoads: string[] = []

  /**
   * When each building last changed hands. Without a cooling-off period the
   * population trades the same stock back and forth forever — a sale hands the
   * seller capital, which they immediately spend buying something else — and
   * the log fills with tens of thousands of acquisitions that change nothing.
   */
  readonly lastTransfer = new Map<string, number>()

  private nextBuildingSerial = 0
  private nextNodeSerial = 0
  private nextEdgeSerial = 0

  constructor(seed: WorldSeed, store: WorldStore, seedKey = 'world') {
    this.seed = seed
    this.store = store
    // §18.1: the run's randomness is seeded per run, so seed variance is a
    // thing that can actually be measured rather than a fixed single sample.
    this.rng = makeRng(`${seedKey}:world`)
    this.chunkId = seed.chunk.id
    this.bounds = seed.chunk.localBounds

    for (const b of seed.buildings) {
      const areaM2 = ringArea(b.footprint)
      this.buildings.set(b.id, {
        id: b.id,
        baselineId: b.id,
        source: 'real_world',
        chunkId: b.chunkId,
        footprint: b.footprint,
        groundM: b.groundM,
        heightM: b.heightM,
        levels: b.levels,
        purpose: b.purpose,
        archetype: b.archetype,
        roofHint: b.roofHint,
        // §4: the inherited stock starts partly worn, which is what puts it
        // under pressure to be renovated or replaced instead of sitting
        // untouched for twenty years.
        condition: startingCondition(b.constructionYear),
        state: 'standing',
        progress: 1,
        divergence: 0,
        constructionYear: b.constructionYear,
        createdTick: 0,
        name: b.name,
        areaM2,
        yieldPerTick: 0,
      })
    }

    for (const p of seed.parcels) this.parcels.set(p.id, { ...p })
    // The seed points parcels at buildings; the link has to exist in both
    // directions or nothing that reasons about land — value, demolition,
    // assembly, roads — can find the ground a building stands on.
    for (const p of this.parcels.values()) {
      const b = p.buildingId ? this.buildings.get(p.buildingId) : undefined
      if (b) b.parcelId = p.id
    }
    for (const b of seed.blocks) this.blocks.set(b.id, { ...b })
    for (const n of seed.roads.nodes) this.nodes.set(n.id, { ...n })
    for (const e of seed.roads.edges) this.edges.set(e.id, { ...e })

    this.nextNodeSerial = this.nodes.size
    this.nextEdgeSerial = this.edges.size
  }

  /** §20.6: generation is the public vocabulary. Highest living generation. */
  get generation(): number {
    let g = 1
    for (const a of this.agents.values()) {
      if (!a.diedTick && a.generation > g) g = a.generation
    }
    return g
  }

  /** Generations that have completed, i.e. agents that spent their budget. */
  get generationsCompleted(): number {
    let n = 0
    for (const a of this.agents.values()) if (a.diedTick) n++
    return n
  }

  newBuildingId(): string {
    return `ab-${this.nextBuildingSerial++}`
  }

  newNodeId(): string {
    return `an${this.nextNodeSerial++}`
  }

  newEdgeId(): string {
    return `ae${this.nextEdgeSerial++}`
  }

  /** Standing, non-demolished buildings only. */
  standing(id: string | undefined): Building | undefined {
    if (!id) return undefined
    const b = this.buildings.get(id)
    return b && b.state !== 'demolished' ? b : undefined
  }

  parcelOf(building: Building): Parcel | undefined {
    return building.parcelId ? this.parcels.get(building.parcelId) : undefined
  }
}

/**
 * Age-derived starting condition. A 1909 building is not new, and pretending
 * otherwise means the whole baseline sits at condition 1.0 and nothing is ever
 * worth renovating.
 */
export function startingCondition(constructionYear: number | undefined): number {
  if (!constructionYear) return 0.7
  // SOURCE_DATA_YEAR is the vintage of the BAG extract, not a simulation clock:
  // it turns a real construction year into a starting condition once, at load.
  const age = SOURCE_DATA_YEAR - constructionYear
  return Math.max(0.32, Math.min(1, 1 - age / 230))
}

/**
 * What a decision costs an agent from its §20.5 budget. Passing is nearly free;
 * committing capital and changing the world is not.
 */
export const EFFORT_COST: Record<string, number> = {
  pass: 1,
  acquire_building: 4,
  acquire_parcel: 3,
  renovate: 3,
  convert: 5,
  expand: 6,
  demolish: 8,
  develop: 10,
  assemble: 7,
  build_road: 9,
}

/** Uniform bucket index over the chunk, used for every spatial query. */
export class SpatialIndex<T> {
  private cells = new Map<number, T[]>()
  private readonly cell: number
  private readonly minX: number
  private readonly minY: number
  private readonly cols: number

  constructor(bounds: Bounds2, cellSize: number) {
    this.cell = cellSize
    this.minX = bounds.minX
    this.minY = bounds.minY
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize) + 1)
  }

  private key(x: number, y: number): number {
    const i = Math.floor((x - this.minX) / this.cell)
    const j = Math.floor((y - this.minY) / this.cell)
    return j * this.cols + i
  }

  insert(p: Vec2, item: T): void {
    const k = this.key(p[0], p[1])
    const arr = this.cells.get(k)
    if (arr) arr.push(item)
    else this.cells.set(k, [item])
  }

  near(p: Vec2, radius: number): T[] {
    const out: T[] = []
    const r = Math.ceil(radius / this.cell)
    const i0 = Math.floor((p[0] - this.minX) / this.cell)
    const j0 = Math.floor((p[1] - this.minY) / this.cell)
    for (let j = j0 - r; j <= j0 + r; j++) {
      for (let i = i0 - r; i <= i0 + r; i++) {
        const arr = this.cells.get(j * this.cols + i)
        if (arr) out.push(...arr)
      }
    }
    return out
  }
}

/**
 * Parcel adjacency: two parcels touch if any vertex of one is within a metre
 * or so of the other's boundary. Derived once — the parcel set only grows when
 * an agent builds a road, and that does not change who is next to whom.
 */
export function buildAdjacency(world: World): void {
  const index = new SpatialIndex<Parcel>(world.bounds, 30)
  for (const p of world.parcels.values()) index.insert(p.centroid, p)

  const neighbours = new Map<string, string[]>()
  for (const p of world.parcels.values()) {
    const radius = Math.sqrt(p.areaM2) + 22
    const found: string[] = []
    for (const q of index.near(p.centroid, radius)) {
      if (q.id === p.id) continue
      if (q.blockId !== p.blockId) continue
      if (touches(p.polygon, q.polygon)) found.push(q.id)
    }
    neighbours.set(p.id, found)
  }
  world.adjacency = neighbours
}

const TOUCH_M = 1.6

function touches(a: Ring, b: Ring): boolean {
  for (const v of a) {
    if (distanceToRing(v, b) < TOUCH_M) return true
  }
  return false
}

export function footprintCentroid(b: Building): Vec2 {
  return centroid(b.footprint)
}

export function floorArea(b: Building): number {
  return b.areaM2 * Math.max(1, b.levels)
}

export const PURPOSE_CONVERSION_TARGETS: Purpose[] = [
  'residential',
  'retail',
  'commercial',
  'office',
  'industrial',
]
