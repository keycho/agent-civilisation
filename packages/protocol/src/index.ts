import type { EventType, Purpose, Ring, RoadClass } from '@civ/core'

/**
 * §21.6. The wire between the authoritative simulation and its spectators.
 *
 * One world, many viewers. The server owns the tick loop, the rng and the
 * store; a client receives what changed and draws it. Everything here is a
 * consequence of that split:
 *
 *   the baseline never travels     it is immutable and already served as a
 *                                  static file, so only mutations go over the
 *                                  socket
 *   frames are deltas              a joining client gets the full data texture
 *                                  once in `hello`, and changed texels after
 *   movement is not an event       §5 — agent positions ride in the frame and
 *                                  are discarded, and the client interpolates
 *                                  between the ~10 Hz frames rather than being
 *                                  sent a path
 *   history is a query             §20.4's scrub reads snapshots from the
 *                                  server's store, not from tab memory
 *
 * JSON with base64 blobs rather than a binary protocol. A frame at normal
 * throughput is a couple of kilobytes; if that stops being true the encoding is
 * the thing to change and none of the shapes below have to.
 */

export const PROTOCOL_VERSION = 1

/** How often the server broadcasts, in wall-clock milliseconds. */
export const FRAME_INTERVAL_MS = 100

/** §20.3: what the world's pace is, so a viewer can be told and not set it. */
export interface Pace {
  label: string
  decisionsPerSecond: number
}

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

/** A building the client has to generate a mass for: agent-built or reshaped. */
export interface MaterialiseSpec {
  id: string
  footprint: Ring
  groundM: number
  heightM: number
  levels: number
  purpose: Purpose
  archetype: string
  source: 'real_world' | 'agent_built'
  constructionYear?: number
  roofHint?: string
}

export interface RoadEdgeWire {
  id: string
  a: string
  b: string
  class: RoadClass
  agentBuilt: boolean
  builtTick?: number
  /** endpoints inlined so the client does not need a node fetch */
  ax: number
  ay: number
  bx: number
  by: number
}

/**
 * §5: presence, not pathing. Position and activity are all that change, so
 * that is all a frame carries — who an agent *is* travels once, when it is
 * born, and is remembered by the client for as long as it lives.
 */
export interface AgentWire {
  id: string
  x: number
  y: number
  activity: 'idle' | 'acquiring' | 'building' | 'demolishing'
}

/** Sent when an agent first appears, and in `hello` for everyone alive. */
export interface AgentIdentity {
  id: string
  name: string
  strategy: string
  /** §16.6: the stable marker assigned at birth, so characters stay recognisable */
  colourIndex: number
  generation: number
}

export interface EventWire {
  id: number
  type: EventType
  agentId?: string
  agentName?: string
  generation: number
  buildingId?: string
  rationale?: string
  cinematicWeight: number
  /** where it happened, for §17's director; absent when it has no place */
  x?: number
  y?: number
}

export interface Readouts {
  /**
   * §22.3: which run of this chunk. The world has a horizon rather than a
   * budget — when the reachable stock saturates the season turns, and that is a
   * product event rather than the world stalling.
   */
  season: number
  /** §20.3: the world's throughput, reported. A viewer reads it, never sets it. */
  pace: Pace
  /** §20.6: primary */
  divergenceIndex: number
  /** §20.6: the only secondary */
  generation: number
  touchedShare: number
  agentOrigin: number
  demolished: number
  /** §20.2: internal ordering key. Sent because construction and road growth
   *  animate against it; never rendered as time. */
  tick: number
  decisions: number
  eventCount: number
  /** how many people are watching this world right now */
  viewers: number
}

export interface Frame {
  t: 'frame'
  readouts: Readouts
  /** §16.2 data-texture delta, packed as [index, r, g, b, a] repeated */
  texels: number[]
  materialise: MaterialiseSpec[]
  roads: RoadEdgeWire[]
  agents: AgentWire[]
  /** agents born since the last frame, including heirs (§12) */
  born: AgentIdentity[]
  events: EventWire[]
  /** agents that ended their §20.5 budget since the last frame */
  retired: string[]
}

export interface Hello {
  t: 'hello'
  protocol: number
  chunkId: string
  /** full §16.2 data texture, base64 — a joining client starts from now */
  buildingData: string
  /** every agent-built structure standing right now */
  materialise: MaterialiseSpec[]
  roads: RoadEdgeWire[]
  agents: AgentIdentity[]
  readouts: Readouts
  /** the last events, so a joining spectator's feed is not empty */
  events: EventWire[]
  viewers: number
  /** what the store is actually writing to, so the client can say so */
  durability: 'postgres' | 'memory'
}

/** §20.4: the answer to a scrub. The texture at an ordinal, from the store. */
export interface ScrubResult {
  t: 'scrub'
  ordinal: number
  generation: number
  divergenceIndex: number
  buildingData: string
  /** ordinals the store actually holds, so the slider can snap to them */
  available: number[]
}

/** §9's inspector, which the client can no longer answer from memory. */
export interface BuildingDetail {
  t: 'building'
  id: string
  found: boolean
  purpose?: Purpose
  archetype?: string
  levels?: number
  heightM?: number
  condition?: number
  divergence?: number
  state?: string
  name?: string
  constructionYear?: number
  value?: number
  ownerName?: string
  ownerGeneration?: number
  /** §23.1: who the owner is, not just which archetype */
  ownerTraits?: { risk: number; horizon: number; intensity: number }
  /** §23.3: what the owner is currently trying to do with it */
  ownerIntent?: string
  /** §42.2: the landmark class, when the building carries one */
  landmark?: { class: string; untouchable?: boolean }
  baseline?: { purpose: string; levels: number; bagId?: string }
  lineage: Array<{ label: string; text: string }>
  history: Array<{ label: string; text: string }>
}

export interface ServerError {
  t: 'error'
  message: string
}

export type ServerMessage = Hello | Frame | ScrubResult | BuildingDetail | ServerError

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

/**
 * Note what is *not* here: nothing that advances the world. A spectator cannot
 * step, seed or steer the simulation — that is what "single writer" means, and
 * it is the difference between a shared world and a synchronised one. Throughput
 * is a property of the world, not of a viewer's session.
 */
export type ClientMessage =
  | { t: 'scrub'; ordinal: number }
  | { t: 'inspect'; buildingId: string }
  | { t: 'ping' }

export function encode(m: ServerMessage | ClientMessage): string {
  return JSON.stringify(m)
}

export function decode<T>(raw: string): T {
  return JSON.parse(raw) as T
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
