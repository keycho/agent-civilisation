import {
  DAYS_PER_YEAR,
  type WorldSeed,
  centroid,
  makeRng,
  tickToYear,
} from '@civ/core'
import { BASE_CINEMATIC_WEIGHT, type WorldStore } from '@civ/persistence'
import { advanceConstruction, applyAction } from './actions.ts'
import {
  ECONOMY,
  decayStep,
  recomputeIntensity,
  recomputeLandValues,
  recomputeYields,
} from './economy.ts'
import { type DecisionEngine, RuleBasedDecisionEngine, observe } from './engine.ts'
import { type DivergenceReport, divergenceReport, findDistricts } from './divergence.ts'
import { type Agent, type Strategy, World, buildAdjacency } from './state.ts'

/**
 * §3: tick = one simulated day. The narrative spans 2026 to 2045, which is
 * about 7,000 ticks — a watchable run, not the ten million a minute-tick would
 * have needed.
 */

export interface SimulationOptions {
  agentCount?: number
  engine?: DecisionEngine
  seedKey?: string
  /** ticks between an agent reconsidering its position */
  decisionInterval?: number
  onYear?: (year: number, report: DivergenceReport) => void
}

const FIRST_NAMES = [
  'Wilhelmina', 'Cornelis', 'Adriana', 'Hendrik', 'Margriet', 'Joris', 'Sanne',
  'Bram', 'Femke', 'Teun', 'Roosmarijn', 'Kasper', 'Lieke', 'Maarten', 'Anouk',
  'Sietse', 'Nynke', 'Ruben', 'Elske', 'Wouter',
]
const HOUSE_NAMES = [
  'Vermeer', 'Haan', 'Kluyver', 'Bruggink', 'Nooteboom', 'Verhoeven', 'Slagter',
  'Oosterhuis', 'Rietveld', 'Dijkgraaf', 'Wielinga', 'Ketelaar',
]

export class Simulation {
  readonly world: World
  readonly engine: DecisionEngine
  private readonly decisionInterval: number
  private readonly onYear?: SimulationOptions['onYear']
  private readonly rng: ReturnType<typeof makeRng>
  private namedDistricts = new Set<string>()
  private lastReport: DivergenceReport

  constructor(seed: WorldSeed, store: WorldStore, opts: SimulationOptions = {}) {
    this.world = new World(seed, store)
    this.engine = opts.engine ?? new RuleBasedDecisionEngine()
    this.decisionInterval = opts.decisionInterval ?? 14
    this.onYear = opts.onYear
    this.rng = makeRng(opts.seedKey ?? 'sim')

    buildAdjacency(this.world)
    recomputeIntensity(this.world)
    recomputeLandValues(this.world)
    recomputeYields(this.world)

    this.spawnAgents(opts.agentCount ?? 58)
    this.lastReport = divergenceReport(this.world)
  }

  get tick(): number {
    return this.world.tick
  }

  get year(): number {
    return this.world.year
  }

  get report(): DivergenceReport {
    return this.lastReport
  }

  private spawnAgents(count: number): void {
    const w = this.world
    const strategies: Strategy[] = ['consolidator', 'renovator', 'developer', 'converter']
    // seed agents where there is something to work with, not uniformly
    const anchors = [...w.parcels.values()].filter((p) => p.developable && p.accessScore > 0.3)

    for (let i = 0; i < count; i++) {
      const anchor = anchors.length ? anchors[Math.floor(this.rng() * anchors.length)] : null
      const id = `agent-${i}`
      const agent: Agent = {
        id,
        name: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${HOUSE_NAMES[i % HOUSE_NAMES.length]}`,
        capital:
          ECONOMY.startingCapital[0] +
          this.rng() * (ECONOMY.startingCapital[1] - ECONOMY.startingCapital[0]),
        strategy: strategies[i % strategies.length],
        bornTick: 0,
        generation: 1,
        colourIndex: i % 12,
        holdings: new Set(),
        parcels: new Set(),
        memory: [],
        // stagger so the whole population does not act on the same day
        nextDecisionTick: Math.floor(this.rng() * this.decisionInterval),
        x: anchor?.centroid[0] ?? 0,
        y: anchor?.centroid[1] ?? 0,
        targetX: anchor?.centroid[0] ?? 0,
        targetY: anchor?.centroid[1] ?? 0,
        activity: 'idle',
      }
      w.agents.set(id, agent)
      w.store.appendEvent({
        chunkId: w.chunkId,
        tick: 0,
        type: 'agent_born',
        agentId: id,
        cinematicWeight: BASE_CINEMATIC_WEIGHT.agent_born,
        payload: { name: agent.name, strategy: agent.strategy, generation: 1 },
      })
    }
  }

  /** One simulated day. */
  async step(): Promise<void> {
    const w = this.world
    w.tick++

    advanceConstruction(w)

    // Weekly, not daily: yields barely move day to day and this is the hot loop.
    if (w.tick % 7 === 0) {
      for (const agent of w.agents.values()) {
        if (agent.diedTick) continue
        let income = 0
        for (const id of agent.holdings) {
          const b = w.standing(id)
          if (b?.state === 'standing') income += b.yieldPerTick * 7
        }
        agent.capital += income
      }
    }

    if (w.tick % 30 === 0) {
      decayStep(w, 30)
      recomputeIntensity(w)
      recomputeLandValues(w)
      recomputeYields(w)
    }

    for (const agent of w.agents.values()) {
      if (agent.diedTick) continue
      if (w.tick < agent.nextDecisionTick) continue
      agent.nextDecisionTick = w.tick + this.decisionInterval
      const obs = observe(w, agent)
      const action = await this.engine.decide(obs, w, agent)
      if (action) applyAction(w, agent, action)
      this.moveAgent(agent)
    }

    if (w.tick % DAYS_PER_YEAR === 0) this.yearBoundary()
  }

  /** Run `ticks` days. Returns when done. */
  async run(ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i++) await this.step()
  }

  /**
   * Advance until the wall clock budget is spent. The render loop uses this so
   * a fast speed never starves the frame.
   */
  async runBudgeted(maxTicks: number, budgetMs: number): Promise<number> {
    const start = performance.now()
    let done = 0
    while (done < maxTicks && performance.now() - start < budgetMs) {
      await this.step()
      done++
    }
    return done
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

  private yearBoundary(): void {
    const w = this.world
    const year = tickToYear(w.tick)

    // financing: agents draw capital from outside the chunk, which is what
    // keeps the economy from stalling once the cheap stock is bought
    for (const agent of w.agents.values()) {
      if (agent.diedTick) continue
      agent.capital += ECONOMY.annualFinancing * (0.6 + this.rng() * 0.8)
    }

    this.generations(year)
    this.nameDistricts(year)

    this.lastReport = divergenceReport(w)
    this.onYear?.(year, this.lastReport)
  }

  /**
   * §12 stage 12. Property inherits, dynasties form, holdings consolidate over
   * decades — nearly free once estate transfer exists, and it is how real
   * cities work.
   *
   * Careers are 13-21 years rather than lifetimes, so the 2026-2045 window
   * actually contains a generational handover instead of implying one.
   */
  private generations(year: number): void {
    const w = this.world
    for (const agent of [...w.agents.values()]) {
      if (agent.diedTick) continue
      const careerYears = 13 + (hash(agent.id) % 9)
      if (year - tickToYear(agent.bornTick) < careerYears) continue

      agent.diedTick = w.tick
      const heirId = `${agent.id}-g${agent.generation + 1}`
      const heir: Agent = {
        ...agent,
        id: heirId,
        name: `${FIRST_NAMES[hash(heirId) % FIRST_NAMES.length]} ${agent.name.split(' ').slice(1).join(' ')}`,
        capital: agent.capital * 0.82,
        bornTick: w.tick,
        diedTick: undefined,
        generation: agent.generation + 1,
        heirId: undefined,
        holdings: new Set(agent.holdings),
        parcels: new Set(agent.parcels),
        memory: [{ tick: w.tick, note: `inherited from ${agent.name}` }],
        nextDecisionTick: w.tick + 1,
      }
      agent.heirId = heirId
      agent.capital = 0
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
        payload: { name: agent.name, generation: agent.generation },
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
  }

  private nameDistricts(year: number): void {
    const w = this.world
    for (const d of findDistricts(w)) {
      if (this.namedDistricts.has(d.id)) continue
      this.namedDistricts.add(d.id)
      w.store.appendEvent({
        chunkId: w.chunkId,
        tick: w.tick,
        type: 'district_formed',
        cinematicWeight: BASE_CINEMATIC_WEIGHT.district_formed,
        rationale: `${d.buildingIds.length} buildings changed within 55 m of each other`,
        payload: {
          districtId: d.id,
          size: d.buildingIds.length,
          x: Math.round(d.centroid[0]),
          y: Math.round(d.centroid[1]),
          year,
        },
      })
    }
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
