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

/**
 * §23.1. Variety in an agent civilization should come from agents differing,
 * not from dice.
 *
 * Build 4 got its variety from sampling uniformly over the top three scored
 * options, which above a 0.25 margin discards a materially better move two
 * times in three. That is injected variety: real in its effects, but produced
 * by agents being deliberately wrong rather than by agents being different.
 *
 * Traits replace it. A slumlord who buys cheap and renovates to minimum, a
 * developer who assembles and rebuilds, and a landlord who holds should score
 * the same parcel differently and all three be acting optimally for who they
 * are. Then argmax, with a band narrow enough that a clear-cut decision is
 * never overturned.
 *
 * Three things follow. Population composition becomes the variance source,
 * which is an explanation rather than a dice roll. Traits inherit with drift,
 * so dynasties acquire character. And §15's recurring characters become
 * possible at all — an agent that picks randomly from its top three has no
 * character to recognise.
 */
export interface Traits {
  /** appetite for leverage, and for clearing standing stock. 0..1 */
  risk: number
  /** patience: a discount rate on future yield, as a payback multiplier. 0..1 */
  horizon: number
  /** appetite for higher-density redevelopment. 0..1 */
  intensity: number
  /** multiplicative bias per purpose, around 1 */
  purpose: Partial<Record<Purpose, number>>
}

/**
 * §23.3 introduced the plan: an acquisition is *for* something, and scoring a
 * purchase independently of what follows makes buying a terminal action — a
 * scoring function with a terminal buy churns (6.77 trades per alteration).
 *
 * §29.2: the development plan belongs to the site, not to the agent.
 *
 * §23.3 hung the plan on the agent as `intent`, scoped to a commitment window,
 * and that scoping is why assembly never completed: the plan lapsed when the
 * window closed, and vanished entirely when the land passed to an heir who
 * inherited the ground without the intent. The capital gate §23.2's prediction
 * assumed would bind was never binding, because the plan died before the
 * capital was committed.
 *
 * So the plan is now a property of the parcels it covers. It persists past the
 * commitment window, transfers with the land at inheritance without any code
 * at the inheritance site — the heir gets the parcels and the parcels carry the
 * plan — and is sold with the site: buy a planned site and the plan is yours,
 * which is how real assembly and entitlement outlive the developer who started
 * them. A half-assembled block with a stated purpose is a tradeable asset and
 * a narrative object that survives generations.
 *
 * An agent is *committed* to a plan while it owns every parcel the plan
 * covers. Ownership fragmenting leaves the plan dormant on the land, waiting
 * for someone to reassemble it. The commitment window (INTENT_TICKS) now
 * bounds only how long the plan blocks its owner from shopping — the plan
 * itself does not expire.
 */
/** What an action proposes to file, before the world assigns it a home. */
export interface PlanSpec {
  kind: SitePlan['kind']
  purpose?: Purpose
  buildingId?: string
  /** what the plan was worth when it was formed, for the inspector */
  value: number
}

export interface SitePlan {
  id: string
  kind: 'convert' | 'redevelop' | 'renovate' | 'assemble'
  /** the ground the plan covers; ownership of all of it makes the plan active */
  parcelIds: string[]
  buildingId?: string
  purpose?: Purpose
  /** what the plan was worth when it was formed, for the inspector */
  value: number
  setTick: number
}

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
  /** §23.1: who this one is, persistent from spawn and inherited with drift */
  traits: Traits
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
 * builds on it.
 *
 * Those two flags are a record of *intentions in sequence*, and that turned out
 * to be the weaker measurement: `developedAfter` fires when a develop touches
 * any one lot of the assembly, so a run of 201 "completed chains" contained 13
 * buildings that actually spanned more than one lot. `spannedByOneBuilding` is
 * the §21.4 form of the same question asked of the artifact — how many of these
 * lots ended up under a single structure. 1 means the assembly was spent and
 * the grain did not move.
 */
export interface Assembly {
  agentId: string
  parcelIds: string[]
  tick: number
  clearedAfter: boolean
  developedAfter: boolean
  /** most of these lots ever covered by one agent-built structure */
  spannedByOneBuilding: number
  /** baseline floor area that stood on this ground at day 0 */
  baselineAreaM2: number
  /** footprint of what the agent put there, 0 until it develops */
  builtAreaM2: number
  /** §23.2: land value where it happened, against the chunk median at the time */
  landValueRatio: number
  /** how many of the lots had something standing on them */
  occupiedCount: number
}

/**
 * §30.3. `gate: true` removes boundary-adjacent parcels from the developable
 * set at world load. The default is off; see the note at the load site.
 */
export const BOUNDARY = { gate: false }

export class World {
  /**
   * §20.2: an internal monotonic sequence number. Construction spans it, decay
   * accumulates on it, ordering requires it. It is never rendered and never
   * named as time.
   */
  tick = 0
  /** cumulative decisions issued — the x axis divergence is plotted against (§20.7) */
  decisionsIssued = 0
  /** §27.3: applied (not merely issued) actions, for the activity-rate summary */
  appliedActions = 0
  /**
   * §34 step 3: per-building count of appearances in any observation candidate
   * set. Dark and never enumerated is an enumeration fault; dark, enumerated
   * and never chosen is economics. The counter stays cheap (one map increment
   * per candidate per observation) and permanent — it is the §18.2 instrument
   * extended one level down the pipeline.
   */
  readonly enumerated = new Map<string, number>()
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

  /**
   * §27.5: competitive pricing.
   *
   * Land value has been `landBase * access * intensity` — built intensity
   * inside a radius, which is a proxy for desirability and not a market. Under
   * it, capital piles into the best place forever and nobody is ever priced out
   * of anywhere, so the marginal agent has no reason to look elsewhere.
   *
   * `demand` accumulates bids per cell on the intensity grid, both the
   * acquisitions that cleared and the ones an agent wanted and could not
   * afford. `competition` is that demand against the supply still available
   * there, smoothed. Two arrays rather than one because the raw flow is spiky
   * and the price must not be: §28.4 warns that a price responding too fast
   * makes capital oscillate, and calls damping a requirement rather than a
   * polish item.
   */
  demand!: Float32Array
  competition!: Float32Array

  /**
   * §27.5, measured on transactions rather than on stock.
   *
   * Cap rate over standing stock is confounded: the dense centre has both the
   * highest rents and the highest competition, so a cross-section of it cannot
   * separate "bid up" from "always was worth more". What §27.5 actually claims
   * is about the *marginal agent* — that the return available on a purchase in
   * a contested place falls below the return in a quiet one, which is what
   * would eventually send capital elsewhere.
   *
   * So record the return on the price actually paid, against how bid-up that
   * spot was when it was paid. Both halves of this are recorded before the
   * first 20-seed run, so the metric cannot be chosen after seeing which one
   * flatters the mechanism.
   */
  readonly transactions: Array<{
    competition: number
    returnOnPrice: number
    /**
     * The chunk-median competition at the moment of purchase. Ranking raw
     * competition mixes time into space — late purchases all see a saturated
     * surface, early ones a cold one — so "contested" must mean contested
     * relative to the market the buyer was actually standing in.
     */
    competitionMedianAtBuy: number
  }> = []

  /** running spatial median of the competition surface, updated per market step */
  competitionMedian = 0

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

  /**
   * §29.2: development plans, living on the world and attached to parcels.
   * `planByParcel` is the index that makes "is this ground spoken for" a map
   * lookup during option generation.
   */
  readonly sitePlans = new Map<string, SitePlan>()
  readonly planByParcel = new Map<string, string>()
  private nextPlanSerial = 0

  newPlanId(): string {
    return `plan-${this.nextPlanSerial++}`
  }

  /** File a plan on its ground, displacing whatever plan was there before. */
  filePlan(plan: SitePlan): void {
    for (const pid of plan.parcelIds) {
      const old = this.planByParcel.get(pid)
      if (old && old !== plan.id) this.retirePlan(old)
      this.planByParcel.set(pid, plan.id)
    }
    this.sitePlans.set(plan.id, plan)
  }

  retirePlan(id: string): void {
    const plan = this.sitePlans.get(id)
    if (!plan) return
    for (const pid of plan.parcelIds) {
      if (this.planByParcel.get(pid) === id) this.planByParcel.delete(pid)
    }
    this.sitePlans.delete(id)
  }

  /**
   * The plan this holding is currently the master of: one whose every parcel
   * it owns. Ownership fragmenting leaves the plan dormant — still on the
   * land, binding nobody — until someone owns the whole site again.
   */
  activePlan(agent: Agent): SitePlan | undefined {
    for (const pid of agent.parcels) {
      const planId = this.planByParcel.get(pid)
      if (!planId) continue
      const plan = this.sitePlans.get(planId)
      if (!plan) continue
      if (plan.parcelIds.every((p) => this.parcels.get(p)?.ownerId === agent.id)) return plan
    }
    return undefined
  }

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
    /**
     * §30.3: the boundary gate, applied once at load rather than checked at
     * nine read sites. The importer flags parcels within the boundary margin of
     * the chunk edge; while the gate is on they are simply not developable, so
     * every downstream decision already respects it. Off by default — §29.5
     * costed the naive gate at 22% of inventory — and turned on per chunk-pair
     * as neighbours materialise, or wholesale by the harness to measure the
     * delta before it matters (§30.3's one run of cost).
     */
    if (BOUNDARY.gate) {
      for (const p of this.parcels.values()) {
        if (p.boundaryAdjacent) p.developable = false
      }
    }
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

  /**
   * §20.6: generation is the public vocabulary, and §23.5 asks what it counts
   * before it goes on screen as the second number.
   *
   * It is the depth of the *typical* living lineage — the median, not the
   * deepest. A population where one dynasty has reached its eighth heir and
   * everyone else is on their third is not eight generations old, and "the
   * deepest anyone got" is not a claim a viewer would read from the word.
   */
  get generation(): number {
    const depths: number[] = []
    for (const a of this.agents.values()) if (!a.diedTick) depths.push(a.generation)
    if (depths.length === 0) return 1
    depths.sort((x, y) => x - y)
    return depths[depths.length >> 1]
  }

  /** The deepest single lineage, for the inspector rather than the headline. */
  get deepestLineage(): number {
    let g = 1
    for (const a of this.agents.values()) if (!a.diedTick && a.generation > g) g = a.generation
    return g
  }

  /**
   * §23.5: agents that have spent their §20.5 budget and died.
   *
   * This was called `generationsCompleted`, and season 1 reported 199 of them —
   * which read as 199 generations and is not what it counts. With 58 lineages
   * that is about three and a half lifetimes each. A life is not a generation
   * and the label was doing work it could not support.
   */
  get livesCompleted(): number {
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
 * §23.1: a personality, rolled once at spawn.
 *
 * Strategy stays as the coarse archetype — it is what the marker colour reads
 * and what §15's "recognise a recurring character" hangs on — and traits are
 * the individual within it. Two developers are both developers and one of them
 * is reckless.
 */
export function rollTraits(rng: () => number, strategy: Strategy): Traits {
  // centred on the archetype, spread wide enough that neighbours differ
  const around = (mid: number, spread: number) =>
    Math.max(0, Math.min(1, mid + (rng() * 2 - 1) * spread))
  const base: Record<Strategy, { risk: number; horizon: number; intensity: number }> = {
    consolidator: { risk: 0.5, horizon: 0.7, intensity: 0.5 },
    renovator: { risk: 0.25, horizon: 0.75, intensity: 0.3 },
    developer: { risk: 0.75, horizon: 0.4, intensity: 0.8 },
    converter: { risk: 0.45, horizon: 0.5, intensity: 0.5 },
  }
  const b = base[strategy]
  const purpose: Partial<Record<Purpose, number>> = {}
  // one purpose this agent likes and one it does not, so a preference is a
  // recognisable habit rather than a uniform tilt
  const kinds: Purpose[] = ['residential', 'retail', 'commercial', 'office', 'industrial']
  const liked = kinds[Math.floor(rng() * kinds.length)]
  const disliked = kinds[Math.floor(rng() * kinds.length)]
  purpose[liked] = 1 + 0.35 * rng()
  if (disliked !== liked) purpose[disliked] = 0.6 + 0.25 * rng()
  return {
    risk: around(b.risk, 0.28),
    horizon: around(b.horizon, 0.28),
    intensity: around(b.intensity, 0.28),
    purpose,
  }
}

/**
 * §23.1: an heir is recognisably its parent, and not identical to it. Drift is
 * small enough that a dynasty keeps a character across several generations.
 */
export function inheritTraits(t: Traits, rng: () => number): Traits {
  const drift = (v: number) => Math.max(0, Math.min(1, v + (rng() * 2 - 1) * 0.12))
  const purpose: Partial<Record<Purpose, number>> = {}
  for (const [k, v] of Object.entries(t.purpose)) {
    purpose[k as Purpose] = Math.max(0.4, Math.min(1.6, (v ?? 1) + (rng() * 2 - 1) * 0.08))
  }
  return {
    risk: drift(t.risk),
    horizon: drift(t.horizon),
    intensity: drift(t.intensity),
    purpose,
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
      /**
       * §33.1: the same-block requirement was written when blocks partitioned
       * space, and it silently made synthesised parcels invisible to the
       * relational machinery — an orphan could never neighbour block stock, so
       * assemble, adjacent-to-holdings and site scoring were blind across the
       * seam. In Deptford the seam is 60% of the market, and the §18.2 run
       * read the consequence: orphan stock untouched at 86% against 49%, with
       * the correlates-with-nothing signature (access r = 0). A synthesised
       * parcel is a real parcel; touching decides adjacency for it.
       */
      const sameBlock = q.blockId === p.blockId
      const orphanSide = p.blockId === 'blk-orphan' || q.blockId === 'blk-orphan'
      if (!sameBlock && !orphanSide) continue
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
