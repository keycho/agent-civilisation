import type { Building, Parcel, Purpose } from '@civ/core'
import { DAYS_PER_YEAR, clamp01 } from '@civ/core'
import type { AgentAction } from './actions.ts'
import { developableFootprint } from './actions.ts'
import {
  ECONOMY,
  acquisitionPrice,
  buildingValue,
  conversionCost,
  demolitionCost,
  developmentCost,
  expansionCost,
  normalisedIntensity,
  parcelPrice,
  paybackYears,
  renovationCost,
  renovationUplift,
  yieldPerTick,
} from './economy.ts'
import { type Agent, type MemoryEntry, type World, floorArea } from './state.ts'

/**
 * §9. Async, may return null, carries a rationale on the action.
 *
 * The observation includes the neighbourhood because every interesting
 * decision is relational — and `adjacentToHoldings` is specifically what makes
 * assembly emerge rather than needing to be scripted.
 */

export interface BuildingRef {
  id: string
  purpose: Purpose
  levels: number
  areaM2: number
  condition: number
  heightM: number
  constructionYear?: number
  value: number
  yieldPerTick: number
  ownerId?: string
  parcelId?: string
}

export interface ParcelRef {
  id: string
  areaM2: number
  accessScore: number
  landValue: number
  price: number
  developable: boolean
  hasBuilding: boolean
  ownedBySelf: boolean
}

export interface Observation {
  self: {
    id: string
    name: string
    capital: number
    strategy: string
    holdingCount: number
    tick: number
    year: number
  }
  holdings: BuildingRef[]
  candidates: {
    forSale: BuildingRef[]
    vacantParcels: ParcelRef[]
    /** drives assembly (§9) */
    adjacentToHoldings: ParcelRef[]
  }
  neighbourhood: {
    intensity: number
    landValue: number
    accessScore: number
    recentActivity: number
  }
  market: { materialCost: number; capitalRate: number }
  memory: MemoryEntry[]
}

export interface DecisionEngine {
  readonly name: string
  decide(obs: Observation, world: World, agent: Agent): Promise<AgentAction | null>
}

// ---------------------------------------------------------------------------
// observation
// ---------------------------------------------------------------------------

const SEARCH_RADIUS_M = 170

export function observe(world: World, agent: Agent): Observation {
  const holdings: BuildingRef[] = []
  for (const id of agent.holdings) {
    const b = world.standing(id)
    if (b) holdings.push(refOf(world, b))
  }

  const focus = focusPoint(world, agent)
  const forSale: BuildingRef[] = []
  const vacantParcels: ParcelRef[] = []
  const adjacentIds = new Set<string>()

  for (const id of agent.parcels) {
    for (const n of world.adjacency.get(id) ?? []) adjacentIds.add(n)
  }
  for (const id of agent.holdings) {
    const b = world.standing(id)
    if (!b?.parcelId) continue
    for (const n of world.adjacency.get(b.parcelId) ?? []) adjacentIds.add(n)
  }

  for (const b of world.buildings.values()) {
    if (b.state === 'demolished' || b.ownerId === agent.id) continue
    if (b.purpose === 'civic') continue // not for sale
    const c = b.footprint[0]
    if (!c) continue
    if (Math.hypot(c[0] - focus[0], c[1] - focus[1]) > SEARCH_RADIUS_M) continue
    forSale.push(refOf(world, b))
  }

  for (const p of world.parcels.values()) {
    const occupied = !!(p.buildingId && world.standing(p.buildingId))
    if (occupied) continue
    if (!p.developable) continue
    const near = Math.hypot(p.centroid[0] - focus[0], p.centroid[1] - focus[1]) <= SEARCH_RADIUS_M
    const adjacent = adjacentIds.has(p.id)
    if (!near && !adjacent && p.ownerId !== agent.id) continue
    const ref = parcelRef(world, p, agent)
    if (adjacent || p.ownerId === agent.id) vacantParcels.push(ref)
    else if (near) vacantParcels.push(ref)
  }

  const adjacentToHoldings: ParcelRef[] = []
  for (const id of adjacentIds) {
    const p = world.parcels.get(id)
    if (p) adjacentToHoldings.push(parcelRef(world, p, agent))
  }

  const recent = world.store.events({ sinceTick: world.tick - 180, limit: 60 })

  return {
    self: {
      id: agent.id,
      name: agent.name,
      capital: agent.capital,
      strategy: agent.strategy,
      holdingCount: agent.holdings.size,
      tick: world.tick,
      year: world.year,
    },
    holdings,
    candidates: { forSale, vacantParcels, adjacentToHoldings },
    neighbourhood: {
      intensity: normalisedIntensity(world, focus[0], focus[1]),
      landValue: averageLandValue(world, focus),
      accessScore: averageAccess(world, focus),
      recentActivity: recent.length / 60,
    },
    market: { materialCost: ECONOMY.buildCost, capitalRate: 0.05 },
    memory: agent.memory.slice(-12),
  }
}

function refOf(world: World, b: Building): BuildingRef {
  return {
    id: b.id,
    purpose: b.purpose,
    levels: b.levels,
    areaM2: b.areaM2,
    condition: b.condition,
    heightM: b.heightM,
    constructionYear: b.constructionYear,
    value: buildingValue(world, b),
    yieldPerTick: b.yieldPerTick,
    ownerId: b.ownerId,
    parcelId: b.parcelId,
  }
}

function parcelRef(world: World, p: Parcel, agent: Agent): ParcelRef {
  return {
    id: p.id,
    areaM2: p.areaM2,
    accessScore: p.accessScore,
    landValue: p.landValue,
    price: parcelPrice(world, p),
    developable: p.developable,
    hasBuilding: !!(p.buildingId && world.standing(p.buildingId)),
    ownedBySelf: p.ownerId === agent.id,
  }
}

/** Agents look around what they already own; a first purchase anchors them. */
function focusPoint(world: World, agent: Agent): [number, number] {
  let x = 0
  let y = 0
  let n = 0
  for (const id of agent.holdings) {
    const b = world.standing(id)
    if (!b) continue
    const c = b.footprint[0]
    if (!c) continue
    x += c[0]
    y += c[1]
    n++
  }
  if (n === 0) return [agent.x, agent.y]
  return [x / n, y / n]
}

function averageLandValue(world: World, focus: [number, number]): number {
  let sum = 0
  let n = 0
  for (const p of world.parcels.values()) {
    if (Math.hypot(p.centroid[0] - focus[0], p.centroid[1] - focus[1]) > 90) continue
    sum += p.landValue
    n++
  }
  return n ? sum / n : 0
}

function averageAccess(world: World, focus: [number, number]): number {
  let sum = 0
  let n = 0
  for (const p of world.parcels.values()) {
    if (Math.hypot(p.centroid[0] - focus[0], p.centroid[1] - focus[1]) > 90) continue
    sum += p.accessScore
    n++
  }
  return n ? sum / n : 0
}

// ---------------------------------------------------------------------------
// rule-based engine
// ---------------------------------------------------------------------------

interface Scored {
  action: AgentAction
  score: number
}

/**
 * The engine that ships. Weighting adjacent acquisitions above distant ones is
 * the whole mechanism behind district formation (§9) — nothing tells an agent
 * to build a district.
 */
export class RuleBasedDecisionEngine implements DecisionEngine {
  readonly name = 'rule-based'

  async decide(obs: Observation, world: World, agent: Agent): Promise<AgentAction | null> {
    const options: Scored[] = []
    const s = STRATEGY[agent.strategy]

    // -- improve what is already owned
    for (const h of obs.holdings) {
      const b = world.standing(h.id)
      if (!b || b.state !== 'standing') continue

      if (b.condition < 0.82) {
        const cost = renovationCost(b)
        const payback = paybackYears(cost, renovationUplift(world, b))
        if (cost <= agent.capital && payback < s.maxPayback) {
          options.push({
            action: {
              kind: 'renovate',
              buildingId: b.id,
              rationale: `condition ${b.condition.toFixed(2)}, payback ${payback.toFixed(1)}y`,
            },
            score: s.renovate * (s.maxPayback / Math.max(1, payback)),
          })
        }
      }

      const best = bestConversion(world, b)
      if (best && conversionCost(b) <= agent.capital) {
        const payback = paybackYears(conversionCost(b), best.uplift)
        if (payback < s.maxPayback) {
          options.push({
            action: {
              kind: 'convert',
              buildingId: b.id,
              to: best.purpose,
              rationale: `${b.purpose} to ${best.purpose}, payback ${payback.toFixed(1)}y`,
            },
            score: s.convert * (s.maxPayback / Math.max(1, payback)),
          })
        }
      }

      // Expansion needs intensity to pay off, which is why it clusters.
      //
      // It is also capped hard, and that cap is doing real work: adding floors
      // is always cheaper per square metre than replacing a building, so
      // uncapped it wins every comparison and the entire historic centre
      // quietly grows storeys instead of ever being redeveloped. You cannot
      // stack two floors on a worn-out 1909 rowhouse.
      // Pre-war structures are not extended. In fabric with a median
      // construction year of 1909 this is the rule that decides the shape of
      // the whole run: without it every old rowhouse simply gains a floor and
      // 80% of the district ends up in one divergence class. With it, the
      // inherited stock has to be renovated, converted or replaced — which is
      // what §14's "first demolition and replacement" milestone describes.
      const expandable = b.source === 'agent_built' || (b.constructionYear ?? 1900) >= 1945
      const maxLevels = b.source === 'agent_built' ? 8 : 6
      const addLevels = b.source === 'agent_built' && b.levels <= 3 ? 2 : 1
      const cost = expansionCost(b, addLevels)
      if (
        expandable &&
        cost <= agent.capital &&
        b.levels + addLevels <= maxLevels &&
        b.condition >= 0.5
      ) {
        const uplift =
          yieldPerTick(world, { ...b, levels: b.levels + addLevels, heightM: b.heightM + addLevels * 3.2 }) -
          b.yieldPerTick
        const payback = paybackYears(cost, uplift)
        if (payback < s.maxPayback) {
          options.push({
            action: {
              kind: 'expand',
              buildingId: b.id,
              addLevels,
              rationale: `${b.levels} to ${b.levels + addLevels} levels, payback ${payback.toFixed(1)}y`,
            },
            score: s.expand * (s.maxPayback / Math.max(1, payback)) * (0.6 + obs.neighbourhood.intensity),
          })
        }
      }

      // Redevelop when what could stand here is worth clearly more than what
      // does. Comparing land value to structure value never fires in low-rise
      // fabric — the developer's actual question is about the replacement.
      const parcel = world.parcelOf(b)
      // Redevelopment is driven by density as well as by decay: a sound
      // two-storey building on a lot that could carry six is still worth
      // replacing. Gating only on condition means one renovation protects a
      // building forever and the redevelopment chain never starts.
      const worn = b.condition < 0.72
      if (parcel && parcel.ownerId === agent.id) {
        const potential = developPotential(world, agent, parcel, obs.neighbourhood.intensity, s)
        if (potential) {
          const cost = demolitionCost(b) + potential.cost
          const uplift = potential.yieldPerTick - b.yieldPerTick
          const payback = paybackYears(cost, uplift)
          const ratio = potential.yieldPerTick / Math.max(1e-6, b.yieldPerTick)
          if (
            cost <= agent.capital &&
            (worn ? ratio > 1.5 : ratio > 2.2) &&
            payback < s.maxPayback * 1.7
          ) {
            options.push({
              action: {
                kind: 'demolish',
                buildingId: b.id,
                rationale:
                  `${potential.levels} levels of ${potential.purpose} would yield ` +
                  `${(potential.yieldPerTick / Math.max(1e-6, b.yieldPerTick)).toFixed(1)}x, payback ${payback.toFixed(1)}y`,
              },
              score: s.demolish * (s.maxPayback / Math.max(1, payback)),
            })
          }
        }
      }
    }

    // -- build on land already held
    const ownedVacant = obs.candidates.vacantParcels.filter((p) => p.ownedBySelf && !p.hasBuilding)
    if (ownedVacant.length > 0) {
      const cluster = clusterOwned(world, agent, ownedVacant.map((p) => p.id))
      for (const group of cluster) {
        const parcels = group.map((id) => world.parcels.get(id)!).filter(Boolean)
        const footprint = developableFootprint(parcels)
        if (!footprint) continue
        const area = areaOf(footprint)
        const levels = chooseLevels(obs.neighbourhood.intensity, s.intensityAppetite)
        const cost = developmentCost(area, levels)
        if (cost > agent.capital) continue
        const purpose = choosePurpose(world, parcels[0], obs.neighbourhood.intensity)
        const uplift =
          (area * levels * (ECONOMY.rentPerM2Year[purpose] ?? 0.1) * 1.1) / DAYS_PER_YEAR
        const payback = paybackYears(cost, uplift)
        if (payback > s.maxPayback * 1.5) continue
        options.push({
          action: {
            kind: 'develop',
            parcelIds: group,
            purpose,
            levels,
            rationale:
              group.length > 1
                ? `redevelop ${group.length} assembled lots at ${levels} levels`
                : `develop ${area.toFixed(0)}m2 at ${levels} levels`,
          },
          score: s.develop * (1 + 0.5 * (group.length - 1)) * (s.maxPayback / Math.max(1, payback)),
        })
      }
    }

    // -- assemble adjacent land
    const assemblable = obs.candidates.adjacentToHoldings.filter((p) => {
      if (p.hasBuilding || !p.developable || p.ownedBySelf) return false
      const traded = world.lastTransfer.get(p.id)
      return traded === undefined || world.tick - traded >= RESALE_LOCK_TICKS
    })
    if (assemblable.length >= 1 && agent.parcels.size >= 1) {
      const affordable = assemblable
        .filter((p) => p.price <= agent.capital)
        .sort((a, b) => b.areaM2 / b.price - a.areaM2 / a.price)
        .slice(0, 3)
      if (affordable.length >= 2) {
        const total = affordable.reduce((sum, p) => sum + p.price, 0)
        if (total <= agent.capital) {
          options.push({
            action: {
              kind: 'assemble',
              parcelIds: affordable.map((p) => p.id),
              rationale: `consolidating ${affordable.length} adjacent lots`,
            },
            score: s.assemble * affordable.length * (0.7 + obs.neighbourhood.intensity),
          })
        }
      } else if (affordable.length === 1) {
        options.push({
          action: {
            kind: 'acquire_parcel',
            parcelId: affordable[0].id,
            rationale: 'adjacent to existing holding',
          },
          score: s.assemble * 0.9,
        })
      }
    }

    // -- unlock landlocked land
    for (const id of agent.parcels) {
      const p = world.parcels.get(id)
      if (!p || p.buildingId) continue
      if (p.roadDistanceM < 24) continue
      const cost = p.roadDistanceM * ECONOMY.roadCostPerM * 1.4
      if (cost > agent.capital * 0.5) continue
      options.push({
        action: {
          kind: 'build_road',
          parcelId: p.id,
          rationale: `${p.roadDistanceM.toFixed(0)}m from the network, unusable without access`,
        },
        score: s.road * (p.areaM2 / 240),
      })
    }

    // -- acquire
    for (const cand of obs.candidates.forSale) {
      const b = world.standing(cand.id)
      if (!b) continue
      if (b.state !== 'standing') continue
      // Recently traded stock is off the market. Without this the population
      // churns the same buildings forever and nothing is ever improved.
      const traded = world.lastTransfer.get(b.id)
      if (traded !== undefined && world.tick - traded < RESALE_LOCK_TICKS) continue

      const price = acquisitionPrice(world, b)
      if (price > agent.capital) continue
      const annual = b.yieldPerTick * DAYS_PER_YEAR
      const cap = annual / Math.max(1, price)
      // §9: adjacency is weighted above yield, which is what consolidates blocks
      const adjacent = b.parcelId ? isAdjacentToHoldings(world, agent, b.parcelId) : false
      const upside = b.condition < 0.7 ? 1.3 : 1
      // Buying out another agent is real but should not be the default move;
      // unowned baseline stock is where the divergence actually comes from.
      const fromAgent = b.ownerId ? 0.3 : 1
      options.push({
        action: {
          kind: 'acquire_building',
          buildingId: b.id,
          rationale: adjacent
            ? `adjacent to holdings, ${(cap * 100).toFixed(1)}% yield`
            : `${(cap * 100).toFixed(1)}% yield on ${price.toFixed(0)}`,
        },
        score: s.acquire * cap * 12 * upside * fromAgent * (adjacent ? s.adjacencyBonus : 1),
      })
    }

    // -- buy land to build on. Vacant lots are rarely adjacent to what an agent
    // already owns in fabric this dense, so without this branch `develop`,
    // `assemble` and `build_road` are all unreachable.
    for (const p of obs.candidates.vacantParcels) {
      if (p.ownedBySelf || p.hasBuilding || !p.developable) continue
      if (p.price > agent.capital * 0.6) continue
      const parcel = world.parcels.get(p.id)
      if (!parcel) continue
      const lastTraded = world.lastTransfer.get(p.id)
      if (lastTraded !== undefined && world.tick - lastTraded < RESALE_LOCK_TICKS) continue
      // land held by someone else is worth chasing only next to your own
      if (parcel.ownerId && !isAdjacentToHoldings(world, agent, p.id)) continue
      const potential = developPotential(world, agent, parcel, obs.neighbourhood.intensity, s)
      if (!potential) continue
      const payback = paybackYears(p.price + potential.cost, potential.yieldPerTick)
      if (payback > s.maxPayback * 1.6) continue
      const adjacent = isAdjacentToHoldings(world, agent, p.id)
      options.push({
        action: {
          kind: 'acquire_parcel',
          parcelId: p.id,
          rationale: `${p.areaM2.toFixed(0)}m2 of buildable land, payback ${payback.toFixed(1)}y`,
        },
        score:
          s.develop * 0.9 * (s.maxPayback / Math.max(1, payback)) * (adjacent ? s.adjacencyBonus * 0.6 : 1),
      })
    }

    if (options.length === 0) return null
    options.sort((a, b) => b.score - a.score)
    // a little noise so identical agents do not converge on identical moves
    const top = options.slice(0, 3)
    const pick = top[Math.floor(world.rng() * top.length)]
    return pick.score > s.threshold ? pick.action : null
  }
}

/**
 * §9: "LLMDecisionEngine exists as a file satisfying the interface with a
 * throwing stub. Day-tick granularity makes an llm engine affordable in a way
 * minute-tick granularity never was."
 */
export class LLMDecisionEngine implements DecisionEngine {
  readonly name = 'llm'

  async decide(_obs: Observation, _world: World, _agent: Agent): Promise<AgentAction | null> {
    throw new Error(
      'LLMDecisionEngine is a stub. The Observation shape is the contract: serialise it, ' +
        'prompt for one action from the §4 set plus a rationale, and validate against AgentAction.',
    )
  }
}

// ---------------------------------------------------------------------------
// strategy weights
// ---------------------------------------------------------------------------

interface StrategyWeights {
  acquire: number
  renovate: number
  convert: number
  expand: number
  demolish: number
  develop: number
  assemble: number
  road: number
  adjacencyBonus: number
  maxPayback: number
  intensityAppetite: number
  threshold: number
}

const STRATEGY: Record<string, StrategyWeights> = {
  consolidator: {
    acquire: 1.3,
    renovate: 0.7,
    convert: 0.6,
    expand: 0.8,
    demolish: 0.7,
    develop: 1.0,
    assemble: 2.1,
    road: 1.0,
    adjacencyBonus: 3.2,
    maxPayback: 17,
    intensityAppetite: 1.1,
    threshold: 0.7,
  },
  renovator: {
    acquire: 1.0,
    renovate: 2.2,
    convert: 1.1,
    expand: 0.7,
    demolish: 0.3,
    develop: 0.5,
    assemble: 0.7,
    road: 0.5,
    adjacencyBonus: 1.6,
    maxPayback: 21,
    intensityAppetite: 0.7,
    threshold: 0.6,
  },
  developer: {
    acquire: 0.9,
    renovate: 0.4,
    convert: 0.7,
    expand: 1.5,
    demolish: 1.8,
    develop: 2.4,
    assemble: 1.6,
    road: 1.5,
    adjacencyBonus: 2.2,
    maxPayback: 15,
    intensityAppetite: 1.5,
    threshold: 0.75,
  },
  converter: {
    acquire: 1.1,
    renovate: 0.9,
    convert: 2.4,
    expand: 1.0,
    demolish: 0.5,
    develop: 0.7,
    assemble: 0.9,
    road: 0.5,
    adjacencyBonus: 1.8,
    maxPayback: 19,
    intensityAppetite: 1.0,
    threshold: 0.6,
  },
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bestConversion(
  world: World,
  b: Building,
): { purpose: Purpose; uplift: number } | null {
  if (b.purpose === 'civic') return null
  const targets: Purpose[] = ['residential', 'retail', 'commercial', 'office']
  let best: { purpose: Purpose; uplift: number } | null = null
  for (const t of targets) {
    if (t === b.purpose) continue
    const uplift = yieldPerTick(world, { ...b, purpose: t, condition: Math.max(b.condition, 0.85) }) - b.yieldPerTick
    if (uplift > 0 && (!best || uplift > best.uplift)) best = { purpose: t, uplift }
  }
  return best
}

function isAdjacentToHoldings(world: World, agent: Agent, parcelId: string): boolean {
  for (const n of world.adjacency.get(parcelId) ?? []) {
    const p = world.parcels.get(n)
    if (p?.ownerId === agent.id) return true
  }
  return false
}

/** Groups of owned vacant parcels that touch each other, largest first. */
function clusterOwned(world: World, agent: Agent, ids: string[]): string[][] {
  const set = new Set(ids)
  const seen = new Set<string>()
  const groups: string[][] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const group: string[] = []
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      group.push(cur)
      for (const n of world.adjacency.get(cur) ?? []) {
        if (set.has(n) && !seen.has(n) && world.parcels.get(n)?.ownerId === agent.id) stack.push(n)
      }
    }
    groups.push(group)
  }
  return groups.sort((a, b) => b.length - a.length).slice(0, 3)
}

function chooseLevels(intensity: number, appetite: number): number {
  return Math.max(2, Math.min(8, Math.round((2.2 + intensity * 5.5) * appetite)))
}

/** §4's land-value gradient expressed as a programme choice. */
function choosePurpose(world: World, parcel: Parcel, intensity: number): Purpose {
  const access = clamp01(parcel.accessScore)
  if (access > 0.66 && intensity > 0.42) return 'retail'
  if (intensity > 0.55) return 'office'
  if (access < 0.3) return 'industrial'
  return 'residential'
}

/** Resale cooling-off, in ticks (§4 has no opinion; degenerate churn does). */
const RESALE_LOCK_TICKS = 365 * 3

interface Potential {
  levels: number
  purpose: Purpose
  areaM2: number
  cost: number
  yieldPerTick: number
}

/**
 * What could be built on this land, and what it would earn. Shared by the
 * buy-land, redevelop and develop branches so all three agree about the
 * upside — otherwise an agent demolishes for a building it then declines to
 * put up.
 */
function developPotential(
  world: World,
  agent: Agent,
  parcel: Parcel,
  intensity: number,
  s: StrategyWeights,
): Potential | null {
  const footprint = developableFootprint([parcel])
  if (!footprint) return null
  const areaM2 = areaOf(footprint)
  if (areaM2 < 45) return null
  const levels = chooseLevels(intensity, s.intensityAppetite)
  const purpose = choosePurpose(world, parcel, intensity)
  const cost = developmentCost(areaM2, levels)
  const hypothetical = {
    id: 'hypothetical',
    source: 'agent_built' as const,
    chunkId: world.chunkId,
    parcelId: parcel.id,
    footprint,
    groundM: 0,
    heightM: levels * 3.4 + 1.2,
    levels,
    purpose,
    archetype: 'agent_block' as const,
    condition: 1,
    state: 'standing' as const,
    progress: 1,
    divergence: 7,
    createdTick: world.tick,
    areaM2,
    yieldPerTick: 0,
    ownerId: agent.id,
  }
  return { levels, purpose, areaM2, cost, yieldPerTick: yieldPerTick(world, hypothetical) }
}

function areaOf(ring: Array<[number, number]>): number {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a) / 2
}
