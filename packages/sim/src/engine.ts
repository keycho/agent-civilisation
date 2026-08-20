import type { Building, Parcel, Purpose } from '@civ/core'
import { RATE_WINDOW_TICKS, clamp01 } from '@civ/core'
import type { AgentAction, ScoredAction } from './actions.ts'
import { developableFootprint } from './actions.ts'
import {
  ECONOMY,
  acquisitionPrice,
  availableFunds,
  buildingValue,
  capitalise,
  creditHeadroom,
  conversionCost,
  demolitionCost,
  developmentCost,
  expansionCost,
  normalisedIntensity,
  parcelPrice,
  parcelTakeoverPrice,
  paybackWindows,
  portfolioValue,
  recordDemand,
  renovationCost,
  renovationUplift,
  withDuty,
  yieldPerTick,
} from './economy.ts'
import { type Agent, ESCALATION, FUNDED_PLAN, type MemoryEntry, type PlanSpec, type SitePlan, THIRD_USE, type World, floorArea } from './state.ts'
import { conversionPenalty, conversionTargets, expansionHeadroom } from './structure.ts'

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
  /** §23.2: price including any standing building, which assembly must pay */
  takeoverPrice: number
  developable: boolean
  hasBuilding: boolean
  ownedBySelf: boolean
}

export interface Observation {
  self: {
    id: string
    name: string
    capital: number
    /** §21.1: drawn credit, and what is still undrawn against the portfolio */
    debt: number
    creditAvailable: number
    portfolioValue: number
    strategy: string
    /**
     * §23.1: who this agent is. An LLM engine given a personality is doing the
     * same thing the rule engine does with more nuance, against the same
     * scoring surface — which is what makes the §9 swap continuous rather than
     * a replacement.
     */
    traits: { risk: number; horizon: number; intensity: number; purpose: Record<string, number> }
    /** §23.3: the plan this agent is committed to, if any */
    intent?: { kind: string; purpose?: string; buildingId?: string; expiresIn: number }
    holdingCount: number
    /** internal ordering key, never rendered (§20.2) */
    tick: number
    generation: number
    /** §20.5: what is left of this agent's finite budget, 0..1 */
    budgetRemaining: number
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
  decide(obs: Observation, world: World, agent: Agent): Promise<ScoredAction | null>
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
    world.enumerated.set(b.id, (world.enumerated.get(b.id) ?? 0) + 1)
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
    if (p) {
      adjacentToHoldings.push(parcelRef(world, p, agent))
      const b = p.buildingId ? world.standing(p.buildingId) : undefined
      if (b) world.enumerated.set(b.id, (world.enumerated.get(b.id) ?? 0) + 1)
    }
  }

  const recent = world.store.events({ sinceTick: world.tick - 180, limit: 60 })

  return {
    self: {
      id: agent.id,
      name: agent.name,
      capital: agent.capital,
      debt: agent.debt,
      creditAvailable: creditHeadroom(world, agent),
      portfolioValue: portfolioValue(world, agent),
      strategy: agent.strategy,
      traits: {
        risk: agent.traits.risk,
        horizon: agent.traits.horizon,
        intensity: agent.traits.intensity,
        purpose: agent.traits.purpose as Record<string, number>,
      },
      intent: (() => {
        // §29.2: read off the site, not off the agent
        const plan = world.activePlan(agent)
        return plan
          ? {
              kind: plan.kind,
              purpose: plan.purpose,
              buildingId: plan.buildingId,
              expiresIn: Math.max(0, plan.setTick + INTENT_TICKS - world.tick),
            }
          : undefined
      })(),
      holdingCount: agent.holdings.size,
      tick: world.tick,
      generation: agent.generation,
      budgetRemaining: Math.max(
        0,
        1 - agent.effortSpent / Math.max(1, agent.effortBudget),
      ),
    },
    holdings,
    candidates: { forSale, vacantParcels, adjacentToHoldings },
    neighbourhood: {
      intensity: normalisedIntensity(world, focus[0], focus[1]),
      landValue: averageLandValue(world, focus),
      accessScore: averageAccess(world, focus),
      recentActivity: recent.length / 60,
    },
    market: { materialCost: ECONOMY.buildCost, capitalRate: ECONOMY.interestPerWindow },
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
    /** §23.2: land plus whatever stands on it — what taking this lot costs */
    takeoverPrice: parcelTakeoverPrice(world, p),
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

/**
 * §18.4: what a square metre added to this structure earns, relative to new
 * build. The discount is fabric, not maintenance — renovation restores
 * condition but a 1909 shell keeps 1909 floorplates, ceiling heights and party
 * walls. Year sharpens it where a year exists; the fallback is the generic
 * old-fabric discount, which is what an adapter without years (§31.2) gets.
 */
function fabricQuality(b: { source: string; constructionYear?: number }): number {
  if (b.source === 'agent_built') return 1
  const y = b.constructionYear
  if (y === undefined) return 0.78
  if (y < 1920) return 0.62
  if (y < 1945) return 0.7
  if (y < 1980) return 0.82
  return 0.9
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

  async decide(obs: Observation, world: World, agent: Agent): Promise<ScoredAction | null> {
    const options: Scored[] = []
    // §23.1: this agent's weights, not its archetype's
    const s = weightsFor(agent)
    // §21.1: what an agent can commit is cash plus undrawn credit, and credit
    // is secured against the portfolio. §23.1: how far into that credit it will
    // reach is a trait.
    const funds = usableFunds(world, agent)
    /**
     * §23.3: an agent that has bought something for a reason is committed to it
     * and is not shopping. This is what kills churn structurally — 6.77 trades
     * per alteration was a scoring function with nothing holding it to a plan —
     * rather than by making buying expensive and hoping.
     */
    const shopping = !committed(world, agent)

    // -- improve what is already owned
    for (const h of obs.holdings) {
      const b = world.standing(h.id)
      if (!b || b.state !== 'standing') continue

      if (b.condition < 0.82) {
        const cost = renovationCost(b)
        const payback = paybackWindows(cost, renovationUplift(world, b))
        if (cost <= funds && payback < s.maxPayback) {
          options.push({
            action: {
              kind: 'renovate',
              buildingId: b.id,
              rationale: `condition ${b.condition.toFixed(2)}, returns ${returnOnCost(payback)} on cost`,
            },
            score: s.renovate * (s.maxPayback / Math.max(1, payback)),
          })
        }
      }

      const best = bestConversion(world, b, agent)
      // §74.3: a purpose-built civic structure converts dear rather than freely
      const convCost = conversionCost(b) * conversionPenalty(b)
      if (best && convCost <= funds) {
        const payback = paybackWindows(convCost, best.uplift)
        if (payback < s.maxPayback) {
          options.push({
            action: {
              kind: 'convert',
              buildingId: b.id,
              to: best.purpose,
              rationale: `${b.purpose} to ${best.purpose}, returns ${returnOnCost(payback)} on cost`,
            },
            score: s.convert * (s.maxPayback / Math.max(1, payback)),
          })
        }
      }

      // Expansion needs intensity to pay off, which is why it clusters.
      //
      // §18.4, landed here by §31.2 because London has no construction years
      // for a gate to read: the era gate is retired and the asymmetry it
      // proxied is priced instead. "A floor added to a 1909 building is
      // 1909-quality space inheriting a 1909 decay curve, while replacement
      // yields new stock on a fresh curve with a modern floorplate."
      //
      // So everything is expandable, and added floors on inherited stock earn
      // at the structure's fabric quality rather than at new-build rent. Where
      // a construction year exists it sharpens the price (a 1909 shell takes a
      // deeper discount than a 1975 one); where it does not, the generic
      // old-fabric discount applies. Agent-built structures price at par —
      // they are the modern floorplate the comparison is against. The cap and
      // the condition floor stay: they are physics, not era.
      /**
       * §72.5: how much the structure can carry, not how much a constant says.
       *
       * This was `agent_built ? 8 : 6` — a flat ceiling over every inherited
       * building whatever it was made of, so a two-storey 1909 terrace could
       * take four more floors. §70.2 measured what that produced: expanded
       * stock rose from 38.1% to 73.0% of the baseline once §70 stopped
       * agents spending on demolition. Era and construction type set the
       * ceiling now, measured from what the structure was BUILT as so that
       * repeated expansions cannot ratchet past it.
       */
      const headroom = expansionHeadroom(b)
      const addLevels = Math.min(headroom, b.source === 'agent_built' && b.levels <= 3 ? 2 : 1)
      const cost = expansionCost(b, addLevels)
      if (headroom > 0 && cost <= funds && b.condition >= 0.5) {
        const grown = yieldPerTick(world, {
          ...b,
          levels: b.levels + addLevels,
          heightM: b.heightM + addLevels * 3.2,
        })
        const uplift = (grown - b.yieldPerTick) * fabricQuality(b)
        const payback = paybackWindows(cost, uplift)
        if (payback < s.maxPayback) {
          options.push({
            action: {
              kind: 'expand',
              buildingId: b.id,
              addLevels,
              rationale: `${b.levels} to ${b.levels + addLevels} levels, returns ${returnOnCost(payback)} on cost`,
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
        /**
         * §29.2: on planned ground, clearing IS the plan. The ratio and
         * payback gates below appraise a single lot on its own merits, and an
         * assembled site never passes lot-by-lot — the third of three lots is
         * a small building on a small parcel however good the site is. That
         * gate was why §29.2's first cut consolidated exactly nothing: the
         * develop guard held the site until it was clear, and the clearing
         * was vetoed by an appraisal the plan had already superseded. The
         * plan carried the economics when the ground was bought; execution is
         * gated by funds alone.
         */
        const sitePlanId = world.planByParcel.get(parcel.id)
        const sitePlan = sitePlanId ? world.sitePlans.get(sitePlanId) : undefined
        if (
          sitePlan &&
          (sitePlan.kind === 'assemble' || sitePlan.kind === 'redevelop') &&
          /**
           * §70: FUNDED FOR THE WHOLE PLAN, not for the next step.
           *
           * This gate read `demolitionCost(b) <= funds` — the cost of knocking
           * down THIS building — while the unplanned redevelopment branch three
           * lines below has always priced `demolitionCost(b) + potential.cost`.
           * Two adjacent branches, one asking what the step costs and the other
           * asking what the plan costs, and the comment above said so plainly:
           * "execution is gated by funds alone."
           *
           * Measured over 21,081 cleared parcels: 76% never even started
           * construction, 81% were never rebuilt, and 82% of assemblies never
           * produced a building. Clearing is cheap, unappraised and score-
           * boosted; building is expensive, payback-gated and unboosted, so an
           * agent could afford to flatten ground it could never afford to
           * build on — and did, four times out of five.
           *
           * A lender does not release demolition finance without construction
           * finance, because clearing an income-producing asset you cannot
           * afford to replace destroys value. The gate now prices the same
           * thing the plan will actually cost to finish.
           */
          (FUNDED_PLAN.on
            ? sitePlanCost(world, sitePlan, obs.neighbourhood.intensity, s.intensityAppetite)
            : demolitionCost(b)) <= funds
        ) {
          options.push({
            action: {
              kind: 'demolish',
              buildingId: b.id,
              rationale: `clearing the ${b.purpose} for the site plan`,
            },
            score: s.demolish * 1.6,
          })
        }
        const potential = developPotential(world, agent, parcel, obs.neighbourhood.intensity, s)
        if (potential) {
          const cost = demolitionCost(b) + potential.cost
          const uplift = potential.yieldPerTick - b.yieldPerTick
          const payback = paybackWindows(cost, uplift)
          const ratio = potential.yieldPerTick / Math.max(1e-6, b.yieldPerTick)
          if (
            !sitePlan &&
            cost <= funds &&
            (worn ? ratio > 1.5 : ratio > 2.2) &&
            payback < s.maxPayback * 1.7
          ) {
            options.push({
              action: {
                kind: 'demolish',
                buildingId: b.id,
                rationale:
                  `${potential.levels} levels of ${potential.purpose} would yield ` +
                  `${(potential.yieldPerTick / Math.max(1e-6, b.yieldPerTick)).toFixed(1)}x, returns ${returnOnCost(payback)} on cost`,
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
        /**
         * §23.2/§23.3: do not build on a third of an assembly.
         *
         * An agent that assembles three lots and develops the first one it
         * clears has spent the assembly and got a single-lot building — which
         * is why 218 assemblies produced one multi-parcel structure. The plan
         * is the site, so the site waits until it is clear.
         */
        /**
         * §29.2 re-grounds this: the hold is a property of the SITE. If any
         * parcel in this group belongs to a plan whose ground still carries
         * standing stock, the site is not ready and building on a fragment of
         * it would spend the plan for a single-lot structure. No commitment
         * window and no owner check — an heir or a buyer inherits the wait
         * along with the plan.
         */
        const planId = group.map((id) => world.planByParcel.get(id)).find(Boolean)
        if (planId) {
          const plan = world.sitePlans.get(planId)
          const stillStanding = plan?.parcelIds.some((id) => {
            const p = world.parcels.get(id)
            return !!p?.buildingId && !!world.standing(p.buildingId)
          })
          if (stillStanding) continue
        }
        const parcels = group.map((id) => world.parcels.get(id)!).filter(Boolean)
        const footprint = developableFootprint(parcels)
        if (!footprint) continue
        const area = areaOf(footprint)
        const levels = chooseLevels(obs.neighbourhood.intensity, s.intensityAppetite)
        const cost = developmentCost(area, levels)
        if (cost > funds) continue
        const purpose = choosePurpose(world, parcels[0], obs.neighbourhood.intensity, agent)
        const uplift =
          (area * levels * (ECONOMY.rentPerM2[purpose] ?? 0.1) * 1.1) / RATE_WINDOW_TICKS
        const payback = paybackWindows(cost, uplift)
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

        /**
         * §58.2: and the ambitious reading of the same ground, offered
         * alongside rather than instead. It competes on score like everything
         * else, so it wins only where the site, the dynasty's capital and the
         * agent's own appetite all say it should.
         */
        const tall = ambitiousLevels(area, funds, levels)
        if (tall > levels) {
          const tallCost = developmentCost(area, tall)
          const tallUplift =
            (area * tall * (ECONOMY.rentPerM2[purpose] ?? 0.1) * 1.1) / RATE_WINDOW_TICKS
          const tallPayback = paybackWindows(tallCost, tallUplift)
          // a tower is a long-horizon bet; the window it is judged against is
          // the agent's own patience, widened by how much it wants density
          if (tallPayback <= s.maxPayback * (1.8 + 1.4 * agent.traits.intensity)) {
            options.push({
              action: {
                kind: 'develop',
                parcelIds: group,
                purpose,
                levels: tall,
                rationale: `${tall} levels on ${group.length > 1 ? `${group.length} assembled lots` : 'the cleared site'} — the site carries it`,
              },
              // §23.1: the intensifier's option, weighted by the intensifier
              score:
                s.develop *
                (1 + 0.5 * (group.length - 1)) *
                (0.45 + 1.35 * agent.traits.intensity) *
                (s.maxPayback / Math.max(1, tallPayback)),
            })
          }
        }
      }
    }

    // -- assemble adjacent land
    /**
     * §23.2: assembly can gather occupied lots now.
     *
     * The filter used to drop anything with a building on it, which meant
     * assemble -> demolish -> develop was structurally impossible rather than
     * rare — there was never anything standing on assembled ground to clear.
     * The cost of taking an occupied lot includes buying the building, which is
     * the real transaction and a large capital gate.
     */
    const assemblable = obs.candidates.adjacentToHoldings.filter((p) => {
      if (!p.developable || p.ownedBySelf) return false
      const traded = world.lastTransfer.get(p.id)
      return traded === undefined || world.tick - traded >= RESALE_LOCK_TICKS
    })
    if (shopping && assemblable.length >= 1 && agent.parcels.size >= 1) {
      const affordable = assemblable
        .filter((p) => withDuty(p.takeoverPrice) <= funds)
        .sort((a, b) => b.areaM2 / b.takeoverPrice - a.areaM2 / a.takeoverPrice)
        .slice(0, 3)
      if (affordable.length >= 2) {
        const total = affordable.reduce((sum, p) => sum + withDuty(p.takeoverPrice), 0)
        if (total <= funds) {
          const occupied = affordable.filter((p) => p.hasBuilding).length
          options.push({
            action: {
              kind: 'assemble',
              parcelIds: affordable.map((p) => p.id),
              rationale: occupied
                ? `assembling ${affordable.length} adjacent lots, clearing ${occupied}`
                : `consolidating ${affordable.length} adjacent lots`,
              // §29.2: the spec names the ground via the action's parcelIds;
              // apply files it on those parcels
              intent: { kind: 'assemble', value: total },
            },
            score: s.assemble * affordable.length * (0.7 + obs.neighbourhood.intensity),
          })
        }
      } else if (affordable.length === 1 && !affordable[0].hasBuilding) {
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
      if (cost > funds * 0.5) continue
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
    for (const cand of shopping ? obs.candidates.forSale : []) {
      const b = world.standing(cand.id)
      if (!b) continue
      if (b.state !== 'standing') continue
      // Recently traded stock is off the market. Without this the population
      // churns the same buildings forever and nothing is ever improved.
      const traded = world.lastTransfer.get(b.id)
      if (traded !== undefined && world.tick - traded < RESALE_LOCK_TICKS) continue

      const price = acquisitionPrice(world, b)
      if (withDuty(price) > funds) {
        // §27.5: an agent that wanted this and could not afford it is demand
        // that did not clear, and it is the half of the signal that makes a
        // place expensive *before* its supply runs out. Recording only
        // completed purchases would price on absorption alone and always lag.
        const at = world.parcelOf(b)
        if (at) recordDemand(world, at.centroid[0], at.centroid[1])
        continue
      }

      /**
       * §21.1. A building is worth the better of what it earns and what its
       * site is worth cleared:
       *
       *   acquire score = max(income value, site value - demolition - risk)
       *
       * Scoring on income alone made a whole purpose class structurally
       * invisible: utility stock — garages, sheds — earns rent barely above its
       * own maintenance, so its cap rate is ~0 and no agent considered one
       * under any seed. All of it, plus most industrial, survived every run in
       * the §18.2 residue: excluded rather than unattractive. That is not a
       * fastidious edge case. Buying a low-earning structure because the land
       * under it is worth more than the building on it is the most common
       * redevelopment transaction there is, and a model that cannot express it
       * is not producing 35% divergence, it is producing 35% of a subset.
       *
       * Both terms are converted to an annual return before scoring, so the
       * strategy weights and thresholds keep their old meaning and the
       * expression reduces exactly to the old one wherever income wins.
       */
      const incomeAnnual = b.yieldPerTick * RATE_WINDOW_TICKS
      const site = siteValue(world, agent, b, s)
      const annual = Math.max(incomeAnnual, site * ECONOMY.capRate)
      /**
       * §34 step 3's verdict, and §21.1's lesson repeating one level up: the
       * London dark mass (44% of the chunk untouched in every seed) was
       * enumerated as often as the touched stock and never chosen, because its
       * net yield is negative — maintenance beats rent at 54 m² pieces under
       * these constants — and a buyer here priced only current income or
       * clearance. The stock's best use was a different purpose, and the
       * mechanism that expresses that (convert) was only reachable AFTER an
       * acquisition that could never win a rank.
       *
       * So the third use enters the max: the conversion rate, over the
       * project's capital rather than the price alone — buying to convert
       * commits price plus conversion cost, and pricing it over price alone
       * would flatter every marginal conversion.
       */
      const conv = THIRD_USE.on ? bestConversion(world, b, agent) : null
      const capConvert = conv
        ? ((b.yieldPerTick + conv.uplift) * RATE_WINDOW_TICKS) /
          Math.max(1, price + conversionCost(b) * conversionPenalty(b))
        : Number.NEGATIVE_INFINITY
      const cap = Math.max(annual / Math.max(1, price), capConvert)
      const forSite = site * ECONOMY.capRate > incomeAnnual
      // §23.3: what this purchase is *for*. Scoring a buy independently of what
      // follows makes it a terminal action, and a scoring function with a
      // terminal buy churns.
      const plan = planFor(world, agent, b, s, forSite)

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
          // §23.3: "acquiring 14 Havenstraat to convert to retail" and then
          // doing it is legible in a way that buying and shrugging is not.
          rationale: planRationale(plan, b, cap, price, adjacent),
          intent: plan,
        },
        score: s.acquire * cap * 12 * upside * fromAgent * (adjacent ? s.adjacencyBonus : 1),
      })
    }

    // -- buy land to build on. Vacant lots are rarely adjacent to what an agent
    // already owns in fabric this dense, so without this branch `develop`,
    // `assemble` and `build_road` are all unreachable.
    for (const p of shopping ? obs.candidates.vacantParcels : []) {
      if (p.ownedBySelf || p.hasBuilding || !p.developable) continue
      if (withDuty(p.price) > funds * 0.6) {
        const at = world.parcels.get(p.id)
        if (at) recordDemand(world, at.centroid[0], at.centroid[1])
        continue
      }
      const parcel = world.parcels.get(p.id)
      if (!parcel) continue
      const lastTraded = world.lastTransfer.get(p.id)
      if (lastTraded !== undefined && world.tick - lastTraded < RESALE_LOCK_TICKS) continue
      // land held by someone else is worth chasing only next to your own
      if (parcel.ownerId && !isAdjacentToHoldings(world, agent, p.id)) continue
      const potential = developPotential(world, agent, parcel, obs.neighbourhood.intensity, s)
      if (!potential) continue
      const payback = paybackWindows(withDuty(p.price) + potential.cost, potential.yieldPerTick)
      if (payback > s.maxPayback * 1.6) continue
      const adjacent = isAdjacentToHoldings(world, agent, p.id)
      options.push({
        action: {
          kind: 'acquire_parcel',
          parcelId: p.id,
          rationale: `${p.areaM2.toFixed(0)}m2 of buildable land, returns ${returnOnCost(payback)} on cost`,
        },
        score:
          s.develop * 0.9 * (s.maxPayback / Math.max(1, payback)) * (adjacent ? s.adjacencyBonus * 0.6 : 1),
      })
    }

    /**
     * §23.3: the plan pulls. Blocking further shopping stops churn; this is
     * what makes the commitment mean something — an agent that bought a
     * warehouse to convert it gets on with converting it rather than drifting
     * into whatever scored highest this tick.
     */
    // §29.2: the pull is indefinite. The commitment window bounds shopping, not
    // the plan — a plan pulls its owner toward completion for as long as the
    // holding masters the site, across generations if it takes that long.
    const active = world.activePlan(agent)
    if (active) {
      for (const o of options) if (servesPlan(world, o.action, active)) o.score *= INTENT_PULL
    }

    if (options.length === 0) return null
    options.sort((a, b) => b.score - a.score)
    /**
     * §23.1: argmax, not sampling.
     *
     * Build 4 took a uniform pick over the top three, which above a 0.25 margin
     * discarded a materially better move two times in three — variety by
     * deliberate error. Variety comes from `weightsFor` now, and what is left
     * here is a band narrow enough that a clear-cut decision is never
     * overturned: at 4%, an option 25% behind can never win.
     */
    const best = options[0].score
    const band = options.filter((o) => o.score >= best * (1 - TIE_BAND))
    const pick = band.length === 1 ? band[0] : band[Math.floor(world.rng() * band.length)]
    if (pick.score <= s.threshold) return null
    /**
     * §22.2: how much better the best option was than the runner-up, as a
     * fraction of the best. This is the number that says whether the sampling
     * above is choosing between equivalent moves or between materially
     * different ones — which is the difference between a sort order with noise
     * on it and agents that take different paths.
     */
    const margin =
      options.length > 1
        ? (options[0].score - options[1].score) / Math.max(1e-9, Math.abs(options[0].score))
        : 1
    return { ...pick.action, margin }
  }
}

/**
 * §9: "LLMDecisionEngine exists as a file satisfying the interface with a
 * throwing stub. Day-tick granularity makes an llm engine affordable in a way
 * minute-tick granularity never was."
 */
export class LLMDecisionEngine implements DecisionEngine {
  readonly name = 'llm'

  async decide(_obs: Observation, _world: World, _agent: Agent): Promise<ScoredAction | null> {
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

/**
 * §23.1: the archetype, then the individual.
 *
 * Strategy stays the coarse type — it is what the marker colour reads and what
 * "recognise a recurring character" hangs on. Traits bend the weights within
 * it, so two developers are both developers and one of them is reckless. Every
 * term below is a trait doing something a viewer could name: a patient agent
 * accepts a longer payback, a risk-taker clears standing stock and levers up,
 * a cautious one renovates what it has.
 */
function weightsFor(agent: Agent): StrategyWeights {
  const base = STRATEGY[agent.strategy]
  const t = agent.traits
  return {
    ...base,
    maxPayback: base.maxPayback * (0.6 + 0.8 * t.horizon),
    renovate: base.renovate * (1.4 - 0.7 * t.risk),
    demolish: base.demolish * (0.4 + 1.3 * t.risk),
    develop: base.develop * (0.6 + 0.9 * t.risk),
    assemble: base.assemble * (0.5 + 1.1 * t.risk),
    intensityAppetite: base.intensityAppetite * (0.55 + 0.9 * t.intensity),
  }
}

/**
 * §23.1: how much of its credit line an agent will actually reach for. The
 * facility is the same for everyone; the willingness to draw it is not.
 */
function usableFunds(world: World, agent: Agent): number {
  return agent.capital + creditHeadroom(world, agent) * (0.3 + 0.7 * agent.traits.risk)
}

/** A trait's opinion of a purpose, as a multiplier on anything it would earn. */
function purposeBias(agent: Agent, purpose: Purpose): number {
  return agent.traits.purpose[purpose] ?? 1
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
// §23.3 intent
// ---------------------------------------------------------------------------

/** How long an agent stays committed to the plan it bought for, in ticks. */
const INTENT_TICKS = 365

/**
 * How hard the plan pulls. Large enough to win against ordinary alternatives,
 * finite so that an agent whose plan has become absurd — the market moved, the
 * building burned through its condition — is not trapped in it forever.
 */
const INTENT_PULL = 2.5

/**
 * The best thing this agent could do with a building it does not yet own. The
 * purchase is scored by the plan, the agent is committed to the plan, and the
 * commitment is what stops the next decision being another purchase.
 */
function planFor(
  world: World,
  agent: Agent,
  b: Building,
  s: StrategyWeights,
  forSite: boolean,
): PlanSpec {
  const base = { buildingId: b.id }
  if (forSite) {
    return { ...base, kind: 'redevelop', value: siteValue(world, agent, b, s) }
  }
  const conversion = bestConversion(world, b, agent)
  const renovation = b.condition < 0.82 ? renovationUplift(world, b) : 0
  if (conversion && conversion.uplift >= renovation) {
    return { ...base, kind: 'convert', purpose: conversion.purpose, value: conversion.uplift }
  }
  if (renovation > 0) return { ...base, kind: 'renovate', value: renovation }
  // nothing to do with it beyond holding it; `convert` is the loosest plan and
  // it still commits, which is the point
  return { ...base, kind: 'convert', purpose: b.purpose, value: 0 }
}

function planRationale(
  plan: PlanSpec,
  b: Building,
  cap: number,
  price: number,
  adjacent: boolean,
): string {
  const where = b.name ?? `the ${b.purpose}`
  switch (plan.kind) {
    case 'redevelop':
      return `buying ${where} to clear and rebuild the site`
    case 'renovate':
      return `buying ${where} to restore it`
    case 'convert':
      return plan.purpose && plan.purpose !== b.purpose
        ? `buying ${where} to convert to ${plan.purpose}`
        : adjacent
          ? `buying ${where}, adjacent to holdings, ${(cap * 100).toFixed(1)}% yield`
          : `buying ${where} at ${(cap * 100).toFixed(1)}% yield on ${price.toFixed(0)}`
    default:
      return `buying ${where}`
  }
}

/** Does this action carry the site's plan forward? */
function servesPlan(world: World, action: AgentAction, plan: SitePlan): boolean {
  switch (plan.kind) {
    case 'convert':
      return action.kind === 'convert' && action.buildingId === plan.buildingId
    case 'renovate':
      return action.kind === 'renovate' && action.buildingId === plan.buildingId
    case 'redevelop':
      return (
        (action.kind === 'demolish' && action.buildingId === plan.buildingId) ||
        (action.kind === 'develop' &&
          action.parcelIds.some((id) => plan.parcelIds.includes(id)))
      )
    case 'assemble': {
      if (
        action.kind === 'develop' &&
        action.parcelIds.some((id) => plan.parcelIds.includes(id))
      ) {
        return true
      }
      // a demolish serves the plan only on the plan's own ground — the §23.3
      // version accepted any demolition anywhere, which let the pull subsidise
      // unrelated clearances
      if (action.kind === 'demolish') {
        const pid = world.buildings.get(action.buildingId)?.parcelId
        return !!pid && plan.parcelIds.includes(pid)
      }
      return false
    }
  }
}

/**
 * §23.3 as amended by §29.2: an agent is out of the market while its plan is
 * young. The window bounds the shopping freeze only — the plan itself lives on
 * the site until it is carried out or built over, however long that takes and
 * whoever ends up holding the ground.
 */
function committed(world: World, agent: Agent): boolean {
  const plan = world.activePlan(agent)
  if (!plan) return false
  if (world.tick >= plan.setTick + INTENT_TICKS) return false
  // a plan whose subject is gone is carried by demolition, not voided, for
  // redevelop/assemble; for the others the retire hooks already removed it
  return true
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bestConversion(
  world: World,
  b: Building,
  agent: Agent,
): { purpose: Purpose; uplift: number } | null {
  /**
   * §74.3: the targets come from the building's FORM.
   *
   * This was a flat `['residential', 'retail', 'commercial', 'office']` for
   * every structure in every city, which is how a 1909 masonry terrace could
   * become a factory — and the §73.3 decomposition measured what that cost:
   * 422-529 baseline buildings per chunk changed purpose, an order of magnitude
   * more than clearing and expansion together after §70 and §72.5 bounded them.
   *
   * The blanket `b.purpose === 'civic'` refusal goes with it. §74.3's table
   * gives civic few targets and makes them expensive rather than forbidding
   * them, which is what actually happens to churches and station sheds; the
   * cost multiplier is in `conversionPenalty` and §42.2's landmark gate still
   * applies on top.
   */
  const targets = conversionTargets(b)
  let best: { purpose: Purpose; uplift: number } | null = null
  for (const t of targets) {
    if (t === b.purpose) continue
    const uplift = yieldPerTick(world, { ...b, purpose: t, condition: Math.max(b.condition, 0.85) }) - b.yieldPerTick
    // §23.1: an agent that likes retail converts to retail sooner than one that
    // does not, and both are acting on the same yield surface
    const seen = uplift * purposeBias(agent, t)
    if (uplift > 0 && (!best || seen > best.uplift)) best = { purpose: t, uplift: seen }
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

/**
 * §70: what finishing this plan costs — every building still standing on it
 * cleared, and the one that replaces them built.
 *
 * Deliberately the SAME arithmetic the develop branch will run when the ground
 * is finally clear: `developableFootprint` over the plan's parcels, `areaOf`,
 * `chooseLevels` on the same intensity and appetite. If the two ever diverge,
 * an agent could pass the funding gate on one estimate and then fail the build
 * on another, which is the bug this exists to prevent rather than a new one to
 * introduce. A plan whose ground cannot be read as a footprint is priced at its
 * clearance alone, which is the honest floor.
 */
function sitePlanCost(
  world: World,
  plan: SitePlan,
  intensity: number,
  appetite: number,
): number {
  let clearance = 0
  const parcels: Parcel[] = []
  for (const id of plan.parcelIds) {
    const p = world.parcels.get(id)
    if (!p) continue
    parcels.push(p)
    const standing = p.buildingId ? world.standing(p.buildingId) : null
    if (standing) clearance += demolitionCost(standing)
  }
  const footprint = developableFootprint(parcels)
  if (!footprint) return clearance
  return clearance + developmentCost(areaOf(footprint), chooseLevels(intensity, appetite))
}

function chooseLevels(intensity: number, appetite: number): number {
  return Math.max(2, Math.min(8, Math.round((2.2 + intensity * 5.5) * appetite)))
}

/**
 * §58.2: how slender a mass may be, as height over the square root of its
 * footprint. MEASURED, not chosen — across all 5,458 buildings in the eight
 * imported chunks the ratio runs p50 0.99, p90 1.63, p99 3.13, and the tail
 * above that is spires and one 81 m London point block on a 74 m2 base. 3.0
 * is therefore the 99th percentile of what actually stands in these cities:
 * an agent may build as slender as the top one percent of the real fabric,
 * and no slenderer.
 *
 * The consequence is the point. Height needs GROUND — a 76 m2 schiedam lot
 * carries seven levels however rich its owner is, a 600 m2 assembled site
 * carries twenty-one. §58's "ground a dynasty spent generations gathering"
 * falls out of the measurement rather than being asserted by a tier table.
 */
export const SLENDERNESS = 3.0

/** the tallest mass this footprint may carry, before money is considered */
export function siteCeiling(areaM2: number): number {
  return Math.floor((SLENDERNESS * Math.sqrt(areaM2) - 1.2) / 3.4)
}

/**
 * §58.2: the max-intensity branch. `chooseLevels` only ever asks what the
 * NEXT floor is worth, and a scoring function that can only ask that can never
 * decide to build a tower. This asks the other question — what is the most
 * this site could carry? — and offers the answer alongside, to compete.
 *
 * Three gates, in order, and none of them authorial: the site (slenderness,
 * measured above), the money (`developmentCost <= funds`, walked down until it
 * fits), and then §23.1's own taste in the score. It can never propose LESS
 * than the marginal reading, so it is strictly an addition to the option set.
 *
 * There is deliberately no generation term. The first version of this gated
 * ambition on dynasty depth (8 levels at gen 1-2, 14 at gen 3-5, 28 at gen 6+)
 * and measurement killed it: a season's median living lineage reaches
 * generation 2 and the deepest single dynasty reaches 4, because a season
 * turn rebuilds the world from the seed and resets every lineage to 1.
 * Production agrees — every live chunk reports generation 1 or 2 at seasons
 * 31 to 121. The third tier was unreachable and the second covered 13% of
 * develop decisions; the branch fired 197 times in a full run and won zero.
 * See docs/adapter-assumptions.md §58.
 */
function ambitiousLevels(area: number, funds: number, marginal: number): number {
  if (!ESCALATION.on) return 0
  let levels = siteCeiling(area)
  if (levels <= marginal) return 0
  // the tallest the money reaches, within what the ground will hold
  while (levels > marginal && developmentCost(area, levels) > funds) levels--
  return levels > marginal ? levels : 0
}

/**
 * §4's land-value gradient expressed as a programme choice, and §23.1's
 * preference expressed as who builds what. The site proposes; the agent's taste
 * can overrule it where the margin is not decisive.
 */
function choosePurpose(world: World, parcel: Parcel, intensity: number, agent?: Agent): Purpose {
  const access = clamp01(parcel.accessScore)
  const site: Purpose =
    access > 0.66 && intensity > 0.42
      ? 'retail'
      : intensity > 0.55
        ? 'office'
        : access < 0.3
          ? 'industrial'
          : 'residential'
  if (!agent) return site
  let best: Purpose = site
  let bestScore = purposeBias(agent, site) * 1.15 // the site's own case
  for (const p of ['residential', 'retail', 'commercial', 'office', 'industrial'] as Purpose[]) {
    const score = purposeBias(agent, p)
    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }
  return best
}

/**
 * Payback is measured in internal rate windows, which is not something a
 * spectator should ever be shown (§20.2). Its reciprocal is a return on cost,
 * which carries the same information and names no unit of time.
 */
function returnOnCost(paybackWindows: number): string {
  if (!Number.isFinite(paybackWindows) || paybackWindows <= 0) return '0%'
  return `${(100 / paybackWindows).toFixed(1)}%`
}

/** Resale cooling-off, in ticks (§4 has no opinion; degenerate churn does). */
const RESALE_LOCK_TICKS = 365 * 3

/**
 * §23.1: how close two options must be before the seed is allowed to choose
 * between them. Small enough that §22.2's 0.25 margin is never overturned —
 * which is the whole point, since a sampler that can overturn a clear decision
 * is the thing traits replace.
 */
const TIE_BAND = 0.04

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
  const purpose = choosePurpose(world, parcel, intensity, agent)
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

/**
 * §21.1's site value: the developer's residual.
 *
 *   site value = capitalised value of what could stand here
 *              - what it costs to build
 *              - what it costs to clear what is there now
 *              - profit and risk
 *
 * Which is the standard residual land appraisal, and the only way a garage on
 * a good corner can be worth more than the rent it collects.
 *
 * Intensity is read at the parcel rather than from the observer, so the number
 * is a property of the site and not of who happens to be looking at it — and
 * because it varies across the chunk, so does what agents go after.
 */
function siteValue(world: World, agent: Agent, b: Building, s: StrategyWeights): number {
  const parcel = world.parcelOf(b)
  if (!parcel || !parcel.developable) return 0

  // The residual depends on the site and the strategy's appetite for density,
  // not on the caller, and both are stable between market recomputes. Without
  // the cache this runs once per candidate per decision and dominates the run.
  const key = `${parcel.id}:${s.intensityAppetite}`
  let residual = world.siteResidualCache.get(key)
  if (residual === undefined) {
    const intensity = normalisedIntensity(world, parcel.centroid[0], parcel.centroid[1])
    const potential = developPotential(world, agent, parcel, intensity, s)
    residual = potential
      ? capitalise(potential.yieldPerTick) * (1 - ECONOMY.developmentRisk) - potential.cost
      : 0
    world.siteResidualCache.set(key, residual)
  }
  return Math.max(0, residual - demolitionCost(b))
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
