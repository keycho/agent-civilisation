import { BUILDING_SLOT_SPARE, PURPOSE_INDEX, type Building, centroid, clamp01 } from '@civ/core'
import type { WorldEvent } from '@civ/persistence'
import type {
  AgentDetail,
  AgentIdentity,
  AgentWire,
  EventWire,
  MaterialiseSpec,
  RoadEdgeWire,
} from '@civ/protocol'
import type { Simulation } from '@civ/sim'
import { ECONOMY, buildingValue } from '@civ/sim'

/**
 * The authoritative world, reduced to what a spectator needs.
 *
 * This is the piece that used to be `SimBridge` on the client. Moving it here
 * is most of what §21.6 means: the client stops holding a `World` and starts
 * holding pixels, and the only thing that crosses is a diff.
 */

/** §16.2's data texture, kept server-side so the diff can be computed once. */
export class BuildingTexture {
  readonly bytes: Uint8Array
  private readonly index = new Map<string, number>()
  private next: number
  private readonly baseline: number
  private warnedFull = false

  constructor(baselineIds: string[], spare = BUILDING_SLOT_SPARE) {
    this.baseline = baselineIds.length
    this.bytes = new Uint8Array((baselineIds.length + spare) * 4)
    baselineIds.forEach((id, i) => this.index.set(id, i))
    this.next = baselineIds.length
  }

  slotOf(id: string): number | undefined {
    return this.index.get(id)
  }

  /**
   * §23.4: how much of the texture is spent, 0..1.
   *
   * 2,400 spare slots fixes the instance; the class stays open while the only
   * thing that reclaims them is a season turn and the turn condition is
   * saturation, which is soft. Any mechanism that makes more stock reachable
   * lengthens a season — §23.2 and §23.3 both do — so pressure becomes a turn
   * trigger of its own and the ceiling stops being reachable by construction.
   */
  get pressure(): number {
    return this.next / (this.bytes.length >> 2)
  }

  /**
   * §16.2: a building that changes shape leaves the static baseline batch for
   * good and takes a new slot. The old one is set to progress 0, which sinks it
   * under the ground rather than leaving a ghost standing.
   */
  reslot(id: string): number {
    const old = this.index.get(id)
    if (old !== undefined && old < this.baseline) this.bytes[old * 4] = 0
    const slot = this.next++
    /**
     * Writing past a Uint8Array is silently dropped, so running out of slots
     * here would look exactly like a world that had stopped changing — the
     * §18.3 failure shape, on the server, where nobody would see it. Loud, and
     * once.
     */
    if (slot * 4 + 3 >= this.bytes.length && !this.warnedFull) {
      this.warnedFull = true
      console.error(
        `[texture] out of building slots at ${slot} of ${this.bytes.length >> 2}. ` +
          'Updates past this point are dropped; raise BUILDING_SLOT_SPARE.',
      )
    }
    this.index.set(id, slot)
    return slot
  }

  set(slot: number, progress: number, divergence: number, purpose: number, condition: number): void {
    const o = slot * 4
    this.bytes[o] = Math.round(clamp01(progress) * 255)
    this.bytes[o + 1] = Math.round((divergence / 7) * 255)
    this.bytes[o + 2] = Math.round((purpose / 7) * 255)
    this.bytes[o + 3] = Math.round(clamp01(condition) * 255)
  }
}

export function progressOf(b: Building): number {
  switch (b.state) {
    case 'standing':
      return 1
    case 'demolished':
      return 0
    default:
      return clamp01(b.progress)
  }
}

export function materialiseSpec(b: Building): MaterialiseSpec {
  return {
    id: b.id,
    footprint: b.footprint,
    groundM: b.groundM,
    heightM: b.heightM,
    levels: b.levels,
    purpose: b.purpose,
    archetype: b.archetype,
    source: b.source,
    constructionYear: b.constructionYear,
    roofHint: b.roofHint,
  }
}

export function roadWire(sim: Simulation, id: string): RoadEdgeWire | null {
  const e = sim.world.edges.get(id)
  if (!e) return null
  const a = sim.world.nodes.get(e.a)
  const b = sim.world.nodes.get(e.b)
  if (!a || !b) return null
  return {
    id: e.id,
    a: e.a,
    b: e.b,
    class: e.class,
    agentBuilt: !!e.agentBuilt,
    builtTick: e.builtTick,
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
  }
}

export function agentWire(sim: Simulation): AgentWire[] {
  const out: AgentWire[] = []
  for (const a of sim.world.agents.values()) {
    if (a.diedTick) continue
    out.push({ id: a.id, x: round(a.x), y: round(a.y), activity: a.activity })
  }
  return out
}

/** Who an agent is. Travels once, at birth, and the client remembers it. */
export function agentIdentity(a: {
  id: string
  name: string
  strategy: string
  colourIndex: number
  generation: number
}): AgentIdentity {
  return {
    id: a.id,
    name: a.name,
    strategy: a.strategy,
    colourIndex: a.colourIndex,
    generation: a.generation,
  }
}

export function eventWire(sim: Simulation, e: WorldEvent): EventWire {
  const agent = e.agentId ? sim.world.agents.get(e.agentId) : undefined
  const b = e.buildingId ? sim.world.buildings.get(e.buildingId) : undefined
  // §17 needs somewhere to point the camera. A building event points at the
  // building, a road event at the far end of the new edge, and a district at
  // the centroid it was named for.
  const at = b?.footprint[0] ?? edgeHead(sim, e.edgeId) ?? payloadPoint(e)
  return {
    id: e.id,
    type: e.type,
    agentId: e.agentId,
    agentName: agent?.name ?? storedName(e),
    generation: agent?.generation ?? sim.generation,
    buildingId: e.buildingId,
    rationale: e.rationale,
    cinematicWeight: e.cinematicWeight,
    x: at ? round(at[0]) : undefined,
    y: at ? round(at[1]) : undefined,
    monument: monumentName(e),
  }
}

/**
 * §63.1: the name as the row recorded it, for every event the live world can
 * no longer account for — anything written before the current season turned.
 * `agent_born`/`agent_died`/`estate_transferred` already wrote it under `name`
 * and `to`; everything from the action emitter now writes `agentName`.
 *
 * The index exists for the rows already in the store when this shipped, which
 * carry no name of their own. It fills itself from the log as the log is read:
 * `agent_born` has always carried `payload.name` and always precedes that
 * agent's other rows, so one in-order pass over a backfill names everything
 * behind it. Bounded because a season turn prunes, and cheap because it is one
 * string per agent that has ever acted in the retained window.
 */
const nameIndex = new Map<string, string>()

/** the name a row carries itself, if it carries one */
function ownName(e: WorldEvent): string | undefined {
  const p = e.payload as { agentName?: string; name?: string; to?: string } | undefined
  const n = p?.agentName ?? p?.name ?? (e.type === 'estate_transferred' ? p?.to : undefined)
  return typeof n === 'string' && n.length > 0 ? n : undefined
}

/**
 * §63.1: read a batch of rows for the names they carry, before any of them are
 * wired. Deliberately a separate pass rather than learning as rows are mapped:
 * the store returns newest-first, so an agent's own `agent_born` row arrives
 * AFTER the rows that need it, and a learn-as-you-go index would name a
 * backfill in exactly the wrong direction. Order-independent by construction.
 */
export function learnNames(events: Iterable<WorldEvent>): void {
  for (const e of events) {
    if (!e.agentId) continue
    const n = ownName(e)
    if (n) nameIndex.set(e.agentId, n)
  }
}

function storedName(e: WorldEvent): string | undefined {
  return ownName(e) ?? (e.agentId ? nameIndex.get(e.agentId) : undefined)
}

/** for tests: the index is process-wide, so a fresh case starts from nothing */
export function forgetNames(): void {
  nameIndex.clear()
}

/** §58.3: the sim stamps the fact; the wire carries only the name. */
function monumentName(e: WorldEvent): string | undefined {
  const p = e.payload as { monument?: boolean; monumentName?: string } | undefined
  return p?.monument ? (p.monumentName ?? 'a landmark') : undefined
}

function edgeHead(sim: Simulation, edgeId?: string): [number, number] | null {
  const e = edgeId ? sim.world.edges.get(edgeId) : undefined
  const n = e ? sim.world.nodes.get(e.b) : undefined
  return n ? [n.x, n.y] : null
}

function payloadPoint(e: WorldEvent): [number, number] | null {
  const p = e.payload as { x?: number; y?: number } | undefined
  return typeof p?.x === 'number' && typeof p?.y === 'number' ? [p.x, p.y] : null
}

/**
 * §9's inspector, answered by the writer. The client used to read this straight
 * out of its own `World`; it no longer has one.
 */
export function buildingDetail(sim: Simulation, id: string, history: WorldEvent[]) {
  const w = sim.world
  const b = w.buildings.get(id)
  if (!b) return null
  const owner = b.ownerId ? w.agents.get(b.ownerId) : undefined
  const baselineSeed = b.baselineId ? w.seed.buildings.find((x) => x.id === b.baselineId) : undefined

  const lineage: Array<{ label: string; text: string }> = []
  let cur: Building | undefined = b
  let guard = 0
  while (cur && guard++ < 8) {
    lineage.push({
      // §20.1: the real construction year where there is one, 'new' where the
      // structure is an agent's. No invented dates.
      label: cur.constructionYear ? String(cur.constructionYear) : 'new',
      text:
        cur.source === 'agent_built'
          ? `agent-built ${cur.purpose}, ${cur.levels} levels`
          : `${cur.purpose}${cur.demolishedTick !== undefined ? ' — demolished' : ''}`,
    })
    cur = cur.replaces ? w.buildings.get(cur.replaces) : undefined
  }
  lineage.reverse()

  return {
    id,
    found: true,
    purpose: b.purpose,
    archetype: b.archetype,
    levels: b.levels,
    heightM: b.heightM,
    condition: b.condition,
    divergence: b.divergence,
    state: b.state,
    name: b.name,
    constructionYear: b.constructionYear,
    value: buildingValue(w, b),
    ownerName: owner?.name,
    ownerGeneration: owner?.generation,
    // §23.1/§23.3: a name, a character and a stated objective — which is what
    // makes an owner someone rather than a uuid
    ownerTraits: owner
      ? {
          risk: +owner.traits.risk.toFixed(2),
          horizon: +owner.traits.horizon.toFixed(2),
          intensity: +owner.traits.intensity.toFixed(2),
        }
      : undefined,
    // §29.2: the plan lives on the site now. Reading it through the owner
    // keeps the inspector's sentence the same while making it survive
    // inheritance and sale.
    ownerIntent: (() => {
      const plan = owner ? w.activePlan(owner) : undefined
      return plan ? describeIntent(plan) : undefined
    })(),
    landmark: b.landmark,
    baseline: baselineSeed
      ? { purpose: baselineSeed.purpose, levels: baselineSeed.levels, bagId: baselineSeed.bagId }
      : undefined,
    lineage,
    history: history
      .slice(0, 8)
      .reverse()
      .map((e) => {
        const g = e.agentId ? w.agents.get(e.agentId)?.generation : undefined
        return { label: g ? `g${g}` : '·', text: e.rationale ?? e.type.replace(/_/g, ' ') }
      }),
  }
}

/** §23.3: the objective, in words a spectator can read. */
function describeIntent(i: {
  kind: string
  purpose?: string
  buildingId?: string
  parcelIds?: string[]
}): string {
  switch (i.kind) {
    case 'convert':
      return i.purpose ? `converting to ${i.purpose}` : 'converting'
    case 'renovate':
      return 'restoring it'
    case 'redevelop':
      return 'clearing the site to rebuild'
    case 'assemble':
      return `assembling ${i.parcelIds?.length ?? 0} lots`
    default:
      return i.kind
  }
}

/**
 * §47.2: the agent as a character sheet, read the way `inspect` reads a
 * building — every field something the sim already holds. The plan line
 * prefers the active plan (ground fully secured) and otherwise reports the
 * securing itself, lots owned of lots needed.
 */
export function agentDetail(sim: Simulation, id: string): Omit<AgentDetail, 't'> | null {
  const w = sim.world
  const a = w.agents.get(id)
  if (!a || a.diedTick) return null

  let plan: AgentDetail['plan']
  const active = w.activePlan(a)
  if (active) {
    plan = {
      text: describeIntent(active),
      done: active.parcelIds.length,
      total: active.parcelIds.length,
    }
  } else {
    for (const pid of a.parcels) {
      const planId = w.planByParcel.get(pid)
      const p = planId ? w.sitePlans.get(planId) : undefined
      if (!p) continue
      const owned = p.parcelIds.filter((x) => w.parcels.get(x)?.ownerId === a.id).length
      if (owned > 0 && owned < p.parcelIds.length) {
        plan = { text: `securing ground: ${describeIntent(p)}`, done: owned, total: p.parcelIds.length }
        break
      }
    }
  }

  const holdings: NonNullable<AgentDetail['holdings']> = []
  for (const bid of a.holdings) {
    const b = w.buildings.get(bid)
    if (!b || b.state === 'demolished') continue
    const c = centroid(b.footprint)
    holdings.push({
      id: bid,
      label: `${b.purpose}${b.landmark ? ' · landmark' : ''}`,
      value: Math.round(buildingValue(w, b)),
      x: c[0],
      y: c[1],
    })
  }
  holdings.sort((x, y) => y.value - x.value)

  return {
    id,
    found: true,
    name: a.name,
    strategy: a.strategy,
    generation: a.generation,
    capital: Math.round(a.capital),
    debt: Math.round(a.debt),
    ltv: ECONOMY.loanToValue,
    effortBudget: a.effortBudget,
    effortSpent: a.effortSpent,
    traits: {
      risk: +a.traits.risk.toFixed(2),
      horizon: +a.traits.horizon.toFixed(2),
      intensity: +a.traits.intensity.toFixed(2),
    },
    plan,
    holdings: holdings.slice(0, 8),
    parcelCount: a.parcels.size,
  }
}

export function purposeIndexOf(b: Building): number {
  return PURPOSE_INDEX[b.purpose] ?? 0
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
