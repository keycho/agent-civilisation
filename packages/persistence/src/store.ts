import type { EventType, WorldEvent } from './events.ts'

/**
 * §5/§6 persistence contract, mirroring schema.sql exactly.
 *
 * The simulation talks to this and never to a database directly, which is what
 * lets the prototype run entirely in memory while the SQL schema stays the
 * durable definition of the same three lifecycles.
 */

export interface Snapshot {
  chunkId: string
  year: number
  tick: number
  /** one RGBA texel per building — the §16.2 data texture, verbatim */
  buildingData: Uint8Array
  divergenceIndex: number
  stats: Record<string, number>
}

export interface EventQuery {
  sinceTick?: number
  limit?: number
  minWeight?: number
  buildingId?: string
  agentId?: string
  types?: EventType[]
}

export interface WorldStore {
  /** Append-only. Returns the assigned id. */
  appendEvent(e: Omit<WorldEvent, 'id'>): number
  events(q?: EventQuery): WorldEvent[]
  /** Most recent events ranked by cinematic weight — §17's director input. */
  weightedEvents(sinceTick: number, limit: number): WorldEvent[]

  putSnapshot(s: Snapshot): void
  snapshot(chunkId: string, year: number): Snapshot | undefined
  snapshotYears(chunkId: string): number[]

  eventCount(): number
}
