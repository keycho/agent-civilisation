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
  /**
   * §21.1: drawn credit. An agent borrows against what it holds and pays
   * interest on the balance, so a portfolio is leverage as well as income and
   * over-extending is a real way to stop being able to act.
   */
  debt: number
  /** high-water mark of drawn credit, so "did capital ever bind?" is answerable */
  peakDebt: number
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

/**
 * §22.1. One consolidation of adjacent lots, and what became of it.
 *
 * `clearedAfter` and `developedAfter` are set when the same agent — or its
 * heir, since a dynasty is one holding — demolishes on this ground and then
 * builds on it. An assembly with neither is a purchase; an assembly with both
 * is the grain of the city actually changing.
 */
export interface Assembly {
  agentId: string
  parcelIds: string[]
  tick: number
  clearedAfter: boolean
  developedAfter: boolean
  /** baseline floor area that stood on this ground at day 0 */
  baselineAreaM2: number
  /** footprint of what the agent put there, 0 until it develops */
  builtAreaM2: number
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

  /**
   * §21.1's site residual, per parcel and density appetite. Cleared whenever
   * the market is recomputed, which is the only thing that can change it.
   */
  readonly siteResidualCache = new Map<string, number>()

  /**
   * §22.2: how clear-cut each applied decision was, per building it landed on.
   *
   * The engine sorts scored options and samples the top three, so the same
   * building can end a run in different divergence classes across seeds. That
   * variation means two entirely different things depending on the gap between
   * the options being sampled: a near-zero gap is a coin flip between
   * equivalent moves — a sort order with noise on top — and a wide gap is the
   * seed genuinely sending a site down a different path. Recording the margin
   * at the moment of the decision is the only way to tell them apart after the
   * fact.
   */
  readonly decisionMargins = new Map<string, number[]>()

  /**
   * §22.1: assembly as a chain rather than an action. §4 calls `assemble` the
   * mechanism that produces districts, so what matters is not how often it
   * fires but how often it is carried through to a building on the assembled
   * ground.
   */
  readonly assemblies: Assembly[] = []

  /** §22.1: buildings that have ever changed hands, and how often. */
  readonly acquisitionCount = new Map<string, number>()

  /** The building a `develop` just created, for attributing the decision to it. */
  lastDevelopedId?: string

  /**
   * §22.1: baseline floor area per parcel, read from the seed rather than from
   * live state. By the time an agent develops on assembled ground, whatever
   * stood there has usually been cleared — the question is what *was* there.
   */
  readonly baselineAreaByParcel = new Map<string, number>()

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
    // §22.1: what stood on each parcel at day 0, kept from the seed because
    // live state forgets it the moment an agent clears the ground
    for (const p of seed.parcels) {
      const b = p.buildingId ? this.buildings.get(p.buildingId) : undefined
      if (b) this.baselineAreaByParcel.set(p.id, b.areaM2)
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
