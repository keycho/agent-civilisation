import {
  type Building,
  type Parcel,
  type Purpose,
  type Ring,
  type RoadEdge,
  DIVERGENCE,
  area as ringArea,
  centroid,
  constructionDuration,
  insetRing,
  obb,
  obbRing,
  selectArchetype,
} from '@civ/core'
import { BASE_CINEMATIC_WEIGHT, type EventType } from '@civ/persistence'
import {
  ECONOMY,
  acquisitionPrice,
  availableFunds,
  buildingValue,
  conversionCost,
  demolitionCost,
  developmentCost,
  expansionCost,
  parcelPrice,
  parcelTakeoverPrice,
  receive,
  renovationCost,
  spend,
  withDuty,
} from './economy.ts'
import { type Agent, type Intent, type World, floorArea } from './state.ts'

/**
 * §4's action set. Everything an agent can do to the built environment.
 * `inspect` is not here — it is the observation, not a mutation.
 */
export type AgentAction =
  | {
      kind: 'acquire_building'
      buildingId: string
      rationale: string
      /** §23.3: the plan this purchase is for; the agent commits to it */
      intent?: Intent
    }
  | { kind: 'acquire_parcel'; parcelId: string; rationale: string }
  | { kind: 'renovate'; buildingId: string; rationale: string }
  | { kind: 'convert'; buildingId: string; to: Purpose; rationale: string }
  | { kind: 'expand'; buildingId: string; addLevels: number; rationale: string }
  | { kind: 'demolish'; buildingId: string; rationale: string }
  | {
      kind: 'develop'
      parcelIds: string[]
      purpose: Purpose
      levels: number
      rationale: string
    }
  | { kind: 'assemble'; parcelIds: string[]; rationale: string; intent?: Intent }
  | { kind: 'build_road'; parcelId: string; rationale: string }

/**
 * §22.2: how far the chosen option's score sat above the runner-up, as a
 * fraction of the chosen score. The engine samples the top three, so this is
 * the difference between "the seed picked between two equivalent moves" and
 * "the seed sent this site down a different path".
 */
export type ScoredAction = AgentAction & { margin?: number }

export interface ActionOutcome {
  ok: boolean
  reason?: string
  spent?: number
}

export function applyAction(world: World, agent: Agent, action: ScoredAction): ActionOutcome {
  const outcome = dispatch(world, agent, action)
  if (outcome.ok) recordDecision(world, agent, action)
  return outcome
}

/**
 * §22: the measurements that separate a repainted city from a rebuilt one.
 * Kept beside the dispatch rather than inside each action, so adding an action
 * cannot silently escape being counted.
 */
function recordDecision(world: World, agent: Agent, action: ScoredAction): void {
  // §22.2: attribute the margin to the ground it landed on
  if (action.margin !== undefined) {
    const targets =
      'buildingId' in action
        ? [action.buildingId]
        : action.kind === 'develop'
          ? [world.lastDevelopedId].filter((id): id is string => !!id)
          : []
    for (const id of targets) {
      const arr = world.decisionMargins.get(id)
      if (arr) arr.push(action.margin)
      else world.decisionMargins.set(id, [action.margin])
    }
  }

  // §23.3: a purchase commits the agent to what it bought the thing for
  if ((action.kind === 'acquire_building' || action.kind === 'assemble') && action.intent) {
    agent.intent = action.intent
  }

  /**
   * §23.3: a plan that has been carried out is over. Clearing it is what lets
   * the agent go shopping again — the commitment is a period of doing the thing
   * rather than a cooling-off timer wearing a plan's clothes.
   */
  const i = agent.intent
  if (i && i.kind !== 'assemble') {
    const done =
      (i.kind === 'convert' && action.kind === 'convert' && action.buildingId === i.buildingId) ||
      (i.kind === 'renovate' && action.kind === 'renovate' && action.buildingId === i.buildingId) ||
      (i.kind === 'redevelop' && action.kind === 'develop')
    if (done) agent.intent = undefined
  } else if (i && i.kind === 'assemble' && action.kind === 'develop') {
    agent.intent = undefined
  }

  // §22.2: churn per building
  if (action.kind === 'acquire_building') {
    world.acquisitionCount.set(
      action.buildingId,
      (world.acquisitionCount.get(action.buildingId) ?? 0) + 1,
    )
  }

  // §22.1: the assemble chain, followed on the ground rather than in the log
  if (action.kind === 'assemble') {
    /**
     * §23.2's prediction, recorded so it can be tested rather than assumed:
     * assembly should stay rare and concentrate where the land value gradient
     * is steepest. If it goes common and flat across the chunk, the capital
     * gate is not binding and the gradient is too weak.
     */
    const values = action.parcelIds
      .map((id) => world.parcels.get(id)?.landValue ?? 0)
      .filter((v) => v > 0)
    const here = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    world.assemblies.push({
      agentId: agent.id,
      parcelIds: [...action.parcelIds],
      tick: world.tick,
      clearedAfter: false,
      developedAfter: false,
      spannedByOneBuilding: 0,
      baselineAreaM2: action.parcelIds.reduce((sum, id) => sum + baselineAreaOf(world, id), 0),
      builtAreaM2: 0,
      landValueRatio: here / Math.max(1e-9, medianLandValue(world)),
      occupiedCount: action.parcelIds.filter((id) => {
        const b = world.parcels.get(id)?.buildingId
        return !!b && !!world.standing(b)
      }).length,
    })
  }
  if (action.kind === 'demolish') {
    const parcelId = world.buildings.get(action.buildingId)?.parcelId
    if (parcelId) {
      for (const a of world.assemblies) {
        if (sameHolding(a.agentId, agent.id) && a.parcelIds.includes(parcelId)) a.clearedAfter = true
      }
    }
  }
  if (action.kind === 'develop') {
    const built = world.lastDevelopedId ? world.buildings.get(world.lastDevelopedId) : undefined
    for (const a of world.assemblies) {
      if (!sameHolding(a.agentId, agent.id)) continue
      const span = action.parcelIds.filter((id) => a.parcelIds.includes(id)).length
      if (span === 0) continue
      a.developedAfter = true
      a.builtAreaM2 += built?.areaM2 ?? 0
      // §21.4 applied to a metric: how much of the assembly one structure
      // actually covers, read off the building rather than off the sequence.
      if (span > a.spannedByOneBuilding) a.spannedByOneBuilding = span
    }
  }
}

/**
 * An heir is the same holding (§12): property inherits, so a dynasty that
 * assembles in one generation and redevelops in the next has completed the
 * chain. Ids are `agent-4`, then `agent-4-g2-17`, then `agent-4-g2-17-g3-42`.
 */
function sameHolding(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}-g`) || b.startsWith(`${a}-g`)
}

/** The chunk's median parcel land value right now, for the ratio above. */
function medianLandValue(world: World): number {
  const vs: number[] = []
  for (const p of world.parcels.values()) vs.push(p.landValue)
  if (vs.length === 0) return 1
  vs.sort((a, b) => a - b)
  return vs[vs.length >> 1]
}

/** Baseline floor area that stood on a parcel at day 0, from the seed. */
function baselineAreaOf(world: World, parcelId: string): number {
  return world.baselineAreaByParcel.get(parcelId) ?? 0
}

function dispatch(world: World, agent: Agent, action: ScoredAction): ActionOutcome {
  switch (action.kind) {
    case 'acquire_building':
      return acquireBuilding(world, agent, action.buildingId, action.rationale, action.intent)
    case 'acquire_parcel':
      return acquireParcel(world, agent, action.parcelId, action.rationale)
    case 'renovate':
      return renovate(world, agent, action.buildingId, action.rationale)
    case 'convert':
      return convert(world, agent, action.buildingId, action.to, action.rationale)
    case 'expand':
      return expand(world, agent, action.buildingId, action.addLevels, action.rationale)
    case 'demolish':
      return demolish(world, agent, action.buildingId, action.rationale)
    case 'develop':
      return develop(world, agent, action)
    case 'assemble':
      return assemble(world, agent, action.parcelIds, action.rationale)
    case 'build_road':
      return buildRoad(world, agent, action.parcelId, action.rationale)
  }
}

// ---------------------------------------------------------------------------
// event helper
// ---------------------------------------------------------------------------

interface EmitOptions {
  agent?: Agent
  building?: Building
  parcelId?: string
  edgeId?: string
  extraWeight?: number
  rationale?: string
  payload?: Record<string, unknown>
}

function emit(world: World, type: EventType, opts: EmitOptions): void {
  let weight = BASE_CINEMATIC_WEIGHT[type] + (opts.extraWeight ?? 0)
  // §17: weight is situational as well as typed. Replacing a pre-war building
  // is a better shot than replacing a 1994 shed, and a big mass outranks a
  // small one.
  if (opts.building) {
    const b = opts.building
    if (b.constructionYear && b.constructionYear < 1940) weight += 12
    if (b.name) weight += 10
    weight += Math.min(20, Math.round(floorArea(b) / 220))
  }
  world.store.appendEvent({
    chunkId: world.chunkId,
    tick: world.tick,
    type,
    agentId: opts.agent?.id,
    buildingId: opts.building?.id,
    parcelId: opts.parcelId,
    edgeId: opts.edgeId,
    cinematicWeight: Math.max(0, Math.min(127, weight)),
    rationale: opts.rationale,
    payload: opts.payload,
  })
}

/** Divergence only ever ratchets upward for a given building (§8). */
function raiseDivergence(b: Building, cls: number): void {
  if (cls > b.divergence) b.divergence = cls
}

// ---------------------------------------------------------------------------
// acquisition
// ---------------------------------------------------------------------------

function acquireBuilding(
  world: World,
  agent: Agent,
  buildingId: string,
  rationale: string,
  intent?: Intent,
): ActionOutcome {
  const b = world.standing(buildingId)
  if (!b) return { ok: false, reason: 'gone' }
  if (b.ownerId === agent.id) return { ok: false, reason: 'already owned' }
  const price = acquisitionPrice(world, b)
  // §23.3: duty is a cost to the buyer and not income to the seller. It leaves
  // the economy, which is exactly why it makes holding rational.
  const cost = withDuty(price)
  const seller = b.ownerId ? world.agents.get(b.ownerId) : undefined
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }
  if (seller) {
    receive(seller, price)
    seller.holdings.delete(b.id)
  }
  b.ownerId = agent.id
  agent.holdings.add(b.id)
  world.lastTransfer.set(b.id, world.tick)
  raiseDivergence(b, DIVERGENCE.owned)

  const parcel = world.parcelOf(b)
  if (parcel) {
    parcel.ownerId = agent.id
    agent.parcels.add(parcel.id)
  }

  agent.activity = 'acquiring'
  agent.memory.push({ tick: world.tick, note: `acquired ${b.id}` })
  emit(world, 'building_acquired', {
    agent,
    building: b,
    parcelId: parcel?.id,
    rationale,
    payload: {
      price: round(price),
      duty: round(cost - price),
      from: seller?.name ?? 'unowned',
      // §21.1's mechanism, recorded as data rather than inferred from the
      // rationale text. §23.3 rewrote those strings and the string-matching
      // counter silently read zero — a measurement that breaks quietly is the
      // §18.3 failure shape pointed at the instruments instead of the model.
      intent: intent?.kind,
    },
  })
  return { ok: true, spent: cost }
}

function acquireParcel(
  world: World,
  agent: Agent,
  parcelId: string,
  rationale: string,
): ActionOutcome {
  const p = world.parcels.get(parcelId)
  if (!p) return { ok: false, reason: 'no parcel' }
  if (p.ownerId === agent.id) return { ok: false, reason: 'already owned' }
  if (!p.developable) return { ok: false, reason: 'undevelopable' }
  const price = parcelPrice(world, p)
  const cost = withDuty(price)
  const seller = p.ownerId ? world.agents.get(p.ownerId) : undefined
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }
  if (seller) {
    receive(seller, price)
    seller.parcels.delete(p.id)
  }
  p.ownerId = agent.id
  agent.parcels.add(p.id)
  world.lastTransfer.set(p.id, world.tick)
  emit(world, 'parcel_acquired', {
    agent,
    parcelId: p.id,
    rationale,
    payload: { price: round(price), duty: round(cost - price), areaM2: round(p.areaM2) },
  })
  return { ok: true, spent: cost }
}

/**
 * §4: "assemble is what produces districts. Real developers consolidate
 * adjacent lots and redevelop at higher intensity, and that is what makes a
 * recognisable new district emerge from local decisions."
 */
function assemble(
  world: World,
  agent: Agent,
  parcelIds: string[],
  rationale: string,
): ActionOutcome {
  const parcels = parcelIds.map((id) => world.parcels.get(id)).filter(Boolean) as Parcel[]
  if (parcels.length < 2) return { ok: false, reason: 'nothing to assemble' }

  /**
   * §23.2: assembling occupied ground means buying what stands on it. The whole
   * takeover is priced before anything is committed, because half an assembly
   * is worse than none — an agent that buys two of three lots and runs out of
   * capital has spent the money and changed nothing.
   */
  let total = 0
  for (const p of parcels) {
    if (p.ownerId === agent.id) continue
    total += withDuty(parcelTakeoverPrice(world, p))
  }
  if (availableFunds(world, agent) < total) return { ok: false, reason: 'insufficient capital' }

  let occupied = 0
  for (const p of parcels) {
    if (p.ownerId === agent.id) continue
    const standing = p.buildingId ? world.standing(p.buildingId) : undefined
    if (standing && standing.ownerId !== agent.id) {
      const bought = acquireBuilding(world, agent, standing.id, rationale)
      if (!bought.ok) return bought
      occupied++
    }
    if (world.parcels.get(p.id)?.ownerId !== agent.id) {
      const r = acquireParcel(world, agent, p.id, rationale)
      if (!r.ok) return r
    }
  }

  emit(world, 'parcels_assembled', {
    agent,
    parcelId: parcels[0].id,
    extraWeight: Math.min(40, parcels.length * 8 + occupied * 6),
    rationale,
    payload: {
      count: parcels.length,
      occupied,
      areaM2: round(parcels.reduce((s, p) => s + p.areaM2, 0)),
      parcelIds: parcels.map((p) => p.id),
    },
  })
  return { ok: true, spent: total }
}

// ---------------------------------------------------------------------------
// improvement
// ---------------------------------------------------------------------------

function renovate(
  world: World,
  agent: Agent,
  buildingId: string,
  rationale: string,
): ActionOutcome {
  const b = world.standing(buildingId)
  if (!b || b.ownerId !== agent.id) return { ok: false, reason: 'not owned' }
  if (b.condition > 0.94) return { ok: false, reason: 'already sound' }
  const cost = renovationCost(b)
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }

  b.condition = 1
  raiseDivergence(b, DIVERGENCE.renovated)
  emit(world, 'building_renovated', {
    agent,
    building: b,
    rationale,
    payload: { cost: round(cost) },
  })
  return { ok: true, spent: cost }
}

function convert(
  world: World,
  agent: Agent,
  buildingId: string,
  to: Purpose,
  rationale: string,
): ActionOutcome {
  const b = world.standing(buildingId)
  if (!b || b.ownerId !== agent.id) return { ok: false, reason: 'not owned' }
  if (b.purpose === to) return { ok: false, reason: 'no change' }
  const cost = conversionCost(b)
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }

  const from = b.purpose
  b.purpose = to
  b.condition = Math.max(b.condition, 0.85)
  // The archetype is re-selected: a converted warehouse should stop reading as
  // a warehouse. Its real footprint and height are unchanged.
  b.archetype = selectArchetype({
    footprint: b.footprint,
    heightM: b.heightM,
    levels: b.levels,
    purpose: to,
    constructionYear: b.constructionYear,
    source: b.source,
    roofHint: b.roofHint,
  }).archetype
  raiseDivergence(b, DIVERGENCE.converted)
  emit(world, 'building_converted', {
    agent,
    building: b,
    rationale,
    payload: { from, to, cost: round(cost) },
  })
  return { ok: true, spent: cost }
}

function expand(
  world: World,
  agent: Agent,
  buildingId: string,
  addLevels: number,
  rationale: string,
): ActionOutcome {
  const b = world.standing(buildingId)
  if (!b || b.ownerId !== agent.id) return { ok: false, reason: 'not owned' }
  if (addLevels < 1) return { ok: false, reason: 'nothing to add' }
  const cost = expansionCost(b, addLevels)
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }

  const before = b.levels
  b.levels += addLevels
  b.heightM += addLevels * 3.2
  b.condition = Math.max(b.condition, 0.9)
  b.archetype = selectArchetype({
    footprint: b.footprint,
    heightM: b.heightM,
    levels: b.levels,
    purpose: b.purpose,
    constructionYear: b.constructionYear,
    source: b.source,
    roofHint: b.roofHint,
  }).archetype
  raiseDivergence(b, DIVERGENCE.expanded)
  // geometry actually changed, so it leaves the static batch (§16.2)
  world.pendingGeometry.push(b.id)
  emit(world, 'building_expanded', {
    agent,
    building: b,
    rationale,
    payload: { from: before, to: b.levels, cost: round(cost) },
  })
  return { ok: true, spent: cost }
}

// ---------------------------------------------------------------------------
// demolition and construction
// ---------------------------------------------------------------------------

function demolish(
  world: World,
  agent: Agent,
  buildingId: string,
  rationale: string,
): ActionOutcome {
  const b = world.standing(buildingId)
  if (!b || b.ownerId !== agent.id) return { ok: false, reason: 'not owned' }
  if (b.state !== 'standing') return { ok: false, reason: 'busy' }
  const cost = demolitionCost(b)
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }

  b.state = 'under_demolition'
  b.progress = 1
  agent.activity = 'demolishing'
  emit(world, 'demolition_started', {
    agent,
    building: b,
    parcelId: b.parcelId,
    rationale,
    payload: { cost: round(cost), duration: constructionDuration(b.areaM2 * b.heightM, true) },
  })
  return { ok: true, spent: cost }
}

/**
 * Build on cleared or vacant land. Footprint is derived from the parcels: the
 * oriented bounding box of the holding, set back from the boundary. That is
 * both what a developer actually does and what gives agent structures the
 * larger, cleaner floorplates §16.1 asks for.
 */
function develop(
  world: World,
  agent: Agent,
  action: Extract<AgentAction, { kind: 'develop' }>,
): ActionOutcome {
  const parcels = action.parcelIds
    .map((id) => world.parcels.get(id))
    .filter((p): p is Parcel => !!p && p.ownerId === agent.id && p.developable)
  if (parcels.length === 0) return { ok: false, reason: 'no owned land' }
  for (const p of parcels) {
    if (p.buildingId && world.standing(p.buildingId)) return { ok: false, reason: 'occupied' }
  }

  const footprint = developableFootprint(parcels)
  if (!footprint) return { ok: false, reason: 'plot too small' }
  const areaM2 = ringArea(footprint)
  if (areaM2 < 45) return { ok: false, reason: 'plot too small' }

  const levels = Math.max(1, Math.round(action.levels))
  const cost = developmentCost(areaM2, levels)
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }

  const heightM = levels * 3.4 + 1.2
  const replaced = parcels.map((p) => p.buildingId).find((id) => id && world.buildings.get(id))

  const id = world.newBuildingId()
  const archetype = selectArchetype({
    footprint,
    heightM,
    levels,
    purpose: action.purpose,
    source: 'agent_built',
  }).archetype

  const b: Building = {
    id,
    source: 'agent_built',
    chunkId: world.chunkId,
    parcelId: parcels[0].id,
    footprint,
    groundM: groundOf(world, parcels[0]),
    heightM,
    levels,
    purpose: action.purpose,
    archetype,
    condition: 1,
    ownerId: agent.id,
    state: 'under_construction',
    progress: 0,
    // §8: 7 if the land was empty at day 0, 6 if it stands on a demolished
    // baseline building. This is the distinction the whole overlay turns on.
    divergence: replaced ? DIVERGENCE.replaced : DIVERGENCE.agentOrigin,
    replaces: replaced ?? undefined,
    // §20.1: construction_year is a fact about a real building, not a clock
    // reading. An agent-built structure has no year — it is simply new, and
    // the inspector says so.
    constructionYear: undefined,
    createdTick: world.tick,
    // §22.1: standing on more than one parcel is the grain having changed
    builtOnParcels: parcels.map((p) => p.id),
    areaM2,
    yieldPerTick: 0,
  }

  world.buildings.set(id, b)
  agent.holdings.add(id)
  for (const p of parcels) p.buildingId = id
  world.pendingGeometry.push(id)
  world.lastDevelopedId = id
  agent.activity = 'building'

  emit(world, 'construction_started', {
    agent,
    building: b,
    parcelId: parcels[0].id,
    extraWeight: parcels.length > 1 ? 18 : 0,
    rationale: action.rationale,
    payload: {
      cost: round(cost),
      levels,
      purpose: action.purpose,
      parcels: parcels.length,
      onCleared: !!replaced,
      duration: constructionDuration(areaM2 * heightM),
    },
  })
  return { ok: true, spent: cost }
}

const SETBACK_M = 2.4

export function developableFootprint(parcels: Parcel[]): Ring | null {
  const pts = parcels.flatMap((p) => p.polygon)
  if (pts.length < 3) return null
  const box = obb(pts)
  // an assembled holding is built as one clean mass, not as the union of its
  // former lot lines
  const inset = Math.min(SETBACK_M, Math.min(box.width, box.length) * 0.22)
  const ring = obbRing(box, -inset)
  return ring.length >= 3 ? ring : null
}

function groundOf(world: World, p: Parcel): number {
  const near = world.buildings.get(p.buildingId ?? '')
  if (near) return near.groundM
  let sum = 0
  let n = 0
  for (const b of world.buildings.values()) {
    if (n > 24) break
    sum += b.groundM
    n++
  }
  return n ? sum / n : 0
}

// ---------------------------------------------------------------------------
// roads
// ---------------------------------------------------------------------------

/**
 * §4/§7: landlocked parcels are cheap and useless until someone builds a road.
 * The new edge inserts into the same graph, so it appears in the divergence
 * overlay and in access scoring for free.
 */
function buildRoad(
  world: World,
  agent: Agent,
  parcelId: string,
  rationale: string,
): ActionOutcome {
  const p = world.parcels.get(parcelId)
  if (!p) return { ok: false, reason: 'no parcel' }
  if (p.roadDistanceM < 22) return { ok: false, reason: 'already served' }

  // nearest existing node is where the extension attaches
  let best: { id: string; d: number } | null = null
  for (const n of world.nodes.values()) {
    const d = Math.hypot(n.x - p.centroid[0], n.y - p.centroid[1])
    if (!best || d < best.d) best = { id: n.id, d }
  }
  if (!best) return { ok: false, reason: 'no network' }

  const cost = best.d * ECONOMY.roadCostPerM
  if (!spend(world, agent, cost)) return { ok: false, reason: 'insufficient capital' }

  const from = world.nodes.get(best.id)!
  const nodeId = world.newNodeId()
  world.nodes.set(nodeId, {
    id: nodeId,
    x: p.centroid[0],
    y: p.centroid[1],
    lat: 0,
    lon: 0,
  })
  const edge: RoadEdge = {
    id: world.newEdgeId(),
    a: from.id,
    b: nodeId,
    class: 'service',
    agentBuilt: true,
    builtTick: world.tick,
    length: best.d,
  }
  world.edges.set(edge.id, edge)
  world.pendingRoads.push(edge.id)

  // every parcel the new edge now serves gets its access re-scored
  for (const q of world.parcels.values()) {
    const d = Math.hypot(q.centroid[0] - p.centroid[0], q.centroid[1] - p.centroid[1])
    if (d < 60) {
      q.roadDistanceM = Math.min(q.roadDistanceM, d)
      q.accessScore = Math.max(q.accessScore, 0.4 * Math.exp(-Math.max(0, d - 6) / 34))
    }
  }

  emit(world, 'road_built', {
    agent,
    parcelId: p.id,
    edgeId: edge.id,
    extraWeight: Math.min(25, Math.round(best.d / 6)),
    rationale,
    payload: { lengthM: round(best.d), cost: round(cost) },
  })
  return { ok: true, spent: cost }
}

// ---------------------------------------------------------------------------
// progress, driven by the tick rather than by an agent
// ---------------------------------------------------------------------------

export function advanceConstruction(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.state === 'under_construction') {
      const total = constructionDuration(b.areaM2 * b.heightM)
      b.progress = Math.min(1, b.progress + 1 / total)
      if (b.progress >= 1) {
        b.state = 'standing'
        b.progress = 1
        const owner = b.ownerId ? world.agents.get(b.ownerId) : undefined
        if (owner) owner.activity = 'idle'
        emit(world, 'construction_completed', {
          agent: owner,
          building: b,
          parcelId: b.parcelId,
          payload: { purpose: b.purpose, levels: b.levels },
        })
      }
    } else if (b.state === 'under_demolition') {
      const total = constructionDuration(b.areaM2 * b.heightM, true)
      b.progress = Math.max(0, b.progress - 1 / total)
      if (b.progress <= 0) {
        b.state = 'demolished'
        b.progress = 0
        b.demolishedTick = world.tick
        // §8: the parcel is now cleared. §5: never hard delete — "there used to
        // be a 1907 warehouse here" is a large part of what makes the change
        // land emotionally.
        b.divergence = DIVERGENCE.cleared
        const parcel = world.parcelOf(b)
        if (parcel) parcel.buildingId = undefined
        const owner = b.ownerId ? world.agents.get(b.ownerId) : undefined
        if (owner) {
          owner.holdings.delete(b.id)
          owner.activity = 'idle'
        }
        emit(world, 'demolition_completed', {
          agent: owner,
          building: b,
          parcelId: parcel?.id,
          payload: { wasBuilt: b.constructionYear ?? null },
        })
      }
    }
  }
}

export function agentNetWorth(world: World, agent: Agent): number {
  let sum = agent.capital - agent.debt
  for (const id of agent.holdings) {
    const b = world.standing(id)
    if (b) sum += buildingValue(world, b)
  }
  for (const id of agent.parcels) {
    const p = world.parcels.get(id)
    if (p && !p.buildingId) sum += p.landValue * p.areaM2
  }
  return sum
}

export function parcelCentroid(p: Parcel): [number, number] {
  const c = centroid(p.polygon)
  return [c[0], c[1]]
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}

export function insetOrSelf(ring: Ring, d: number): Ring {
  return insetRing(ring, d) ?? ring
}
