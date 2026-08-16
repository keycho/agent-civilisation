import { RATE_WINDOW_TICKS, type WorldSeed, centroid, makeRng } from '@civ/core'
import { BASE_CINEMATIC_WEIGHT, type WorldStore } from '@civ/persistence'
import { advanceConstruction, applyAction } from './actions.ts'
import {
  ECONOMY,
  borrow,
  creditHeadroom,
  decayStep,
  receive,
  recomputeCompetition,
  recomputeIntensity,
  recomputeLandValues,
  recomputeYields,
} from './economy.ts'
import { type DecisionEngine, RuleBasedDecisionEngine, observe } from './engine.ts'
import {
  DISTRICT_SPAN_M,
  type DivergenceReport,
  divergenceReport,
  findDistricts,
} from './divergence.ts'
import {
  EFFORT_COST,
  type Agent,
  type Strategy,
  World,
  buildAdjacency,
  inheritTraits,
  rollTraits,
} from './state.ts'

/**
 * §20: the world evolves by agent action, not by elapsed time.
 *
 * The tick is an internal ordering key — construction spans it and decay
 * accumulates on it — but nothing here converts it to a date and nothing
 * downstream renders it. What the spectator dials is throughput: how fast the
 * civilization thinks. What the spectator reads is the divergence index and the
 * generation count.
 */

export interface SnapshotSignal {
  /** event-log ordinal this snapshot is keyed on (§20.4) */
  ordinal: number
  generation: number
  report: DivergenceReport
}

export interface SimulationOptions {
  agentCount?: number
  engine?: DecisionEngine
  /** seeds the whole run: agent spawn, strategy jitter, tie-breaks, budgets */
  seed?: string
  /** ticks between an agent reconsidering its position */
  decisionInterval?: number
  /** §20.4: snapshots key on event ordinal. Write one every N events. */
  snapshotEveryEvents?: number
  onSnapshot?: (s: SnapshotSignal) => void
}

/**
 * §15's recurring characters, localised: the first London render had Sietse
 * and Roosmarijn redeveloping Deptford, which breaks the fiction the names
 * exist to carry. The pool follows the chunk's country; NL is the default and
 * the fallback for countries without a pool yet.
 */
const NAME_POOLS: Record<string, { first: string[]; house: string[] }> = {
  NL: {
    first: [
      'Wilhelmina', 'Cornelis', 'Adriana', 'Hendrik', 'Margriet', 'Joris', 'Sanne',
      'Bram', 'Femke', 'Teun', 'Roosmarijn', 'Kasper', 'Lieke', 'Maarten', 'Anouk',
      'Sietse', 'Nynke', 'Ruben', 'Elske', 'Wouter',
    ],
    house: [
      'Vermeer', 'Haan', 'Kluyver', 'Bruggink', 'Nooteboom', 'Verhoeven', 'Slagter',
      'Oosterhuis', 'Rietveld', 'Dijkgraaf', 'Wielinga', 'Ketelaar',
    ],
  },
  GB: {
    first: [
      'Nell', 'Arthur', 'Iris', 'Alfred', 'Vera', 'Sidney', 'Mabel', 'Reg',
      'Doris', 'Ernest', 'Peggy', 'Wilf', 'Edith', 'Stan', 'Rose', 'Albert',
      'Florence', 'Harold', 'Ivy', 'Len',
    ],
    house: [
      'Hartley', 'Webb', 'Sullivan', 'Prescott', 'Drake', 'Whitmore', 'Cobb',
      'Fletcher', 'Ainsworth', 'Rowe', 'Tanner', 'Gould',
    ],
  },
}

/**
 * §20.5's budget, in effort units. Spread rather than fixed so the population
 * does not turn over in lockstep. Calibrated once against the build's end state
 * and frozen — see docs and §20.9: tuning this to hit a target is the same
 * hill-climb error §18 exists to catch.
 */
const EFFORT_BUDGET_RANGE: [number, number] = [340, 620]

/** Housekeeping cadences, in internal ticks. */
const INCOME_EVERY = 7
const MARKET_EVERY = 30

export class Simulation {
  readonly world: World
  readonly engine: DecisionEngine
  private readonly decisionInterval: number
  private readonly snapshotEvery: number
  private readonly onSnapshot?: SimulationOptions['onSnapshot']
  private readonly rng: ReturnType<typeof makeRng>
  private namedDistricts = new Set<string>()
  /** §15: name culture follows the chunk's country; NL is the fallback */
  private readonly names: { first: string[]; house: string[] }
  private lastReport: DivergenceReport
  private lastSnapshotEventCount = 0
  private nextHeirSerial = 0

  constructor(seed: WorldSeed, store: WorldStore, opts: SimulationOptions = {}) {
    const seedKey = opts.seed ?? 'sim'
    this.world = new World(seed, store, seedKey)
    this.engine = opts.engine ?? new RuleBasedDecisionEngine()
    this.decisionInterval = opts.decisionInterval ?? 14
    this.snapshotEvery = opts.snapshotEveryEvents ?? 350
    this.onSnapshot = opts.onSnapshot
    this.rng = makeRng(`${seedKey}:sim`)
    this.names = NAME_POOLS[seed.chunk.country ?? 'NL'] ?? NAME_POOLS.NL

    buildAdjacency(this.world)
    recomputeIntensity(this.world)
    // sizes the competition grid before the first land values are read
    recomputeCompetition(this.world)
    recomputeLandValues(this.world)
    recomputeYields(this.world)

    this.spawnAgents(opts.agentCount ?? 58)
    this.lastReport = divergenceReport(this.world)
  }

  get tick(): number {
    return this.world.tick
  }

  get generation(): number {
    return this.world.generation
  }

  get decisionsIssued(): number {
    return this.world.decisionsIssued
  }

  get report(): DivergenceReport {
    return this.lastReport
  }

  private spawnAgents(count: number): void {
    const w = this.world
    const strategies: Strategy[] = ['consolidator', 'renovator', 'developer', 'converter']
    const anchors = [...w.parcels.values()].filter((p) => p.developable && p.accessScore > 0.3)

    for (let i = 0; i < count; i++) {
      const anchor = anchors.length ? anchors[Math.floor(this.rng() * anchors.length)] : null
      const id = `agent-${i}`
      w.agents.set(id, {
        id,
        name: `${this.names.first[i % this.names.first.length]} ${this.names.house[i % this.names.house.length]}`,
        capital:
          ECONOMY.startingCapital[0] +
          this.rng() * (ECONOMY.startingCapital[1] - ECONOMY.startingCapital[0]),
        debt: 0,
        peakDebt: 0,
        strategy: strategies[i % strategies.length],
        // §23.1: who this one is, and the reason two neighbours with the same
        // strategy do different things with the same building
        traits: rollTraits(this.rng, strategies[i % strategies.length]),
        bornTick: 0,
        generation: 1,
        colourIndex: i % 12,
        holdings: new Set(),
        parcels: new Set(),
        memory: [],
        effortBudget: this.rollBudget(),
        effortSpent: 0,
        decisionsMade: 0,
        // stagger so the whole population does not act on the same tick
        nextDecisionTick: Math.floor(this.rng() * this.decisionInterval),
        x: anchor?.centroid[0] ?? 0,
        y: anchor?.centroid[1] ?? 0,
        targetX: anchor?.centroid[0] ?? 0,
        targetY: anchor?.centroid[1] ?? 0,
        activity: 'idle',
      })
      w.store.appendEvent({
        chunkId: w.chunkId,
        tick: 0,
        type: 'agent_born',
        agentId: id,
        cinematicWeight: BASE_CINEMATIC_WEIGHT.agent_born,
        payload: { name: w.agents.get(id)!.name, strategy: w.agents.get(id)!.strategy, generation: 1 },
      })
    }
  }

  private rollBudget(): number {
    const [lo, hi] = EFFORT_BUDGET_RANGE
    return Math.round(lo + this.rng() * (hi - lo))
  }

  /** One internal step. Returns how many decisions were issued during it. */
  async step(): Promise<number> {
    const w = this.world
    w.tick++
    let decisions = 0

    advanceConstruction(w)

    if (w.tick % INCOME_EVERY === 0) {
      for (const agent of w.agents.values()) {
        if (agent.diedTick) continue
        let income = 0
        for (const id of agent.holdings) {
          const b = w.standing(id)
          if (b?.state === 'standing') income += b.yieldPerTick * INCOME_EVERY
        }
        // §21.1: income services debt before it accrues to the owner, and what
        // is left over pays it down. §20.2: both accrue per tick rather than on
        // a calendar boundary; there are no boundaries any more.
        const interest =
          (agent.debt * ECONOMY.interestPerWindow * INCOME_EVERY) / RATE_WINDOW_TICKS
        receive(agent, Math.max(0, income - interest))
        if (income < interest) agent.capital -= interest - income
        // an unserviced balance rolls onto the facility where there is room for
        // it, and where there is not the agent simply cannot afford to act
        if (agent.capital < 0) {
          const draw = Math.min(-agent.capital, creditHeadroom(w, agent))
          agent.capital += draw
          borrow(agent, draw)
        }
      }
    }

    if (w.tick % MARKET_EVERY === 0) {
      decayStep(w, MARKET_EVERY)
      recomputeIntensity(w)
      // §27.5: competition before values — the price is demand against what is
      // still there to buy, so the market term has to be current when land
      // value reads it.
      recomputeCompetition(w)
      recomputeLandValues(w)
      recomputeYields(w)
      w.siteResidualCache.clear()
    }

    for (const agent of w.agents.values()) {
      if (agent.diedTick) continue
      if (w.tick < agent.nextDecisionTick) continue
      agent.nextDecisionTick = w.tick + this.decisionInterval

      const obs = observe(w, agent)
      const action = await this.engine.decide(obs, w, agent)
      decisions++
      w.decisionsIssued++
      agent.decisionsMade++

      if (action) {
        const outcome = applyAction(w, agent, action)
        if (outcome.ok) {
          w.actionCounts.set(action.kind, (w.actionCounts.get(action.kind) ?? 0) + 1)
        }
        // effort is charged for what was actually done: a refused action costs
        // what deliberating cost, not what acting would have
        agent.effortSpent += outcome.ok ? (EFFORT_COST[action.kind] ?? 4) : EFFORT_COST.pass
      } else {
        agent.effortSpent += EFFORT_COST.pass
      }

      this.moveAgent(agent)
      if (agent.effortSpent >= agent.effortBudget) this.retire(agent)
    }

    this.nameDistricts()
    this.maybeSnapshot()
    return decisions
  }

  /** Advance a fixed number of internal steps. */
  async run(steps: number): Promise<void> {
    for (let i = 0; i < steps; i++) await this.step()
  }

  /**
   * §20.9: run to a decision budget rather than to a span. This is the unit
   * `tune.ts` freezes.
   */
  async runToDecisionBudget(budget: number, maxSteps = 500_000): Promise<void> {
    let steps = 0
    while (this.world.decisionsIssued < budget && steps < maxSteps) {
      await this.step()
      steps++
    }
  }

  /**
   * §20.3: advance until `targetDecisions` have been issued, or the wall-clock
   * budget is spent. The render loop drives this, so throughput is what the
   * spectator is actually dialling and a fast setting never starves the frame.
   */
  async runToThroughput(targetDecisions: number, budgetMs: number): Promise<number> {
    const start = performance.now()
    let issued = 0
    let guard = 0
    while (issued < targetDecisions && performance.now() - start < budgetMs && guard < 20_000) {
      issued += await this.step()
      guard++
    }
    return issued
  }

  /**
   * Presence, not pathing. §5 is explicit that movement is never an event: it
   * is mutable state broadcast in the frame and discarded.
   */
  private moveAgent(agent: Agent): void {
    const w = this.world
    let target: [number, number] | null = null
    for (const id of agent.holdings) {
      const b = w.standing(id)
      if (b && (b.state === 'under_construction' || b.state === 'under_demolition')) {
        target = centroid(b.footprint)
        break
      }
    }
    if (!target) {
      const ids = [...agent.holdings]
      if (ids.length) {
        const b = w.standing(ids[Math.floor(this.rng() * ids.length)])
        if (b) target = centroid(b.footprint)
      }
    }
    if (target) {
      agent.targetX = target[0]
      agent.targetY = target[1]
    }
  }

  /**
   * §20.5 / §12: an agent that has spent its budget dies and its estate passes
   * to an heir. Property inherits, dynasties form, holdings consolidate — and
   * because the budget is effort rather than elapsed time, a busy district
   * cycles through owners while a quiet one does not.
   */
  private retire(agent: Agent): void {
    const w = this.world
    agent.diedTick = w.tick

    const heirId = `${agent.id}-g${agent.generation + 1}-${this.nextHeirSerial++}`
    const heir: Agent = {
      ...agent,
      id: heirId,
      name: `${this.names.first[hash(heirId) % this.names.first.length]} ${agent.name.split(' ').slice(1).join(' ')}`,
      // cash takes an estate haircut; debt passes at face value with the
      // property that secures it, so a leveraged dynasty inherits its leverage
      capital: agent.capital * 0.82,
      debt: agent.debt,
      peakDebt: agent.debt,
      // §23.1: recognisably its parent, and not identical to it
      traits: inheritTraits(agent.traits, this.rng),
      bornTick: w.tick,
      diedTick: undefined,
      generation: agent.generation + 1,
      heirId: undefined,
      holdings: new Set(agent.holdings),
      parcels: new Set(agent.parcels),
      memory: [{ tick: w.tick, note: `inherited from ${agent.name}` }],
      effortBudget: this.rollBudget(),
      effortSpent: 0,
      decisionsMade: 0,
      nextDecisionTick: w.tick + 1 + Math.floor(this.rng() * this.decisionInterval),
    }
    agent.heirId = heirId
    agent.capital = 0
    agent.debt = 0
    w.agents.set(heirId, heir)

    for (const id of heir.holdings) {
      const b = w.buildings.get(id)
      if (b) b.ownerId = heirId
    }
    for (const id of heir.parcels) {
      const p = w.parcels.get(id)
      if (p) p.ownerId = heirId
    }
    agent.holdings.clear()
    agent.parcels.clear()

    w.store.appendEvent({
      chunkId: w.chunkId,
      tick: w.tick,
      type: 'agent_died',
      agentId: agent.id,
      cinematicWeight: BASE_CINEMATIC_WEIGHT.agent_died,
      rationale: `spent ${agent.effortSpent} of a ${agent.effortBudget} budget over ${agent.decisionsMade} decisions`,
      payload: { name: agent.name, generation: agent.generation, decisions: agent.decisionsMade },
    })
    w.store.appendEvent({
      chunkId: w.chunkId,
      tick: w.tick,
      type: 'estate_transferred',
      agentId: heirId,
      cinematicWeight:
        BASE_CINEMATIC_WEIGHT.estate_transferred + Math.min(30, heir.holdings.size * 3),
      rationale: `${heir.holdings.size} holdings pass to generation ${heir.generation}`,
      payload: {
        from: agent.name,
        to: heir.name,
        holdings: heir.holdings.size,
        generation: heir.generation,
      },
    })
  }

  private nameDistricts(): void {
    const w = this.world
    // cheap enough to check on a cadence, expensive enough not to do per step
    if (w.tick % 120 !== 0) return
    for (const d of findDistricts(w)) {
      if (this.namedDistricts.has(d.id)) continue
      this.namedDistricts.add(d.id)
      w.store.appendEvent({
        chunkId: w.chunkId,
        tick: w.tick,
        type: 'district_formed',
        cinematicWeight: BASE_CINEMATIC_WEIGHT.district_formed,
        // §23.6: the old wording claimed every pair was within 55 m, which
        // single-linkage growth never guaranteed. The bound that is actually
        // enforced is the district's span.
        rationale: `${d.buildingIds.length} buildings changed across the same ${DISTRICT_SPAN_M} m`,
        payload: {
          districtId: d.id,
          size: d.buildingIds.length,
          x: Math.round(d.centroid[0]),
          y: Math.round(d.centroid[1]),
          generation: w.generation,
        },
      })
    }
  }

  /** §20.4: snapshots key on event ordinal. */
  private maybeSnapshot(): void {
    const count = this.world.store.eventCount()
    if (count - this.lastSnapshotEventCount < this.snapshotEvery) return
    this.lastSnapshotEventCount = count
    this.lastReport = divergenceReport(this.world)
    this.onSnapshot?.({
      ordinal: count,
      generation: this.world.generation,
      report: this.lastReport,
    })
  }

  /** Recompute the divergence report without waiting for a snapshot boundary. */
  refreshReport(): DivergenceReport {
    this.lastReport = divergenceReport(this.world)
    return this.lastReport
  }
}

function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
