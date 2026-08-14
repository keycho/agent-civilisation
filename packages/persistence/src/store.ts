import type { EventType, WorldEvent } from './events.ts'

/**
 * §5/§6 persistence contract, mirroring schema.sql exactly.
 *
 * The simulation talks to this and never to a database directly, which is what
 * lets the prototype run entirely in memory while the SQL schema stays the
 * durable definition of the same three lifecycles.
 */

/**
 * §20.4: snapshots key on event ordinal, not on a year. The event log was
 * already the source of truth and the year boundaries were an arbitrary
 * overlay on it — "show me 2033" becomes "show me generation 3".
 */
export interface Snapshot {
  chunkId: string
  /** number of events in the log when this was taken; the scrub's x axis */
  ordinal: number
  /** the public label for this point in the run (§20.6) */
  generation: number
  /** internal ordering key, never rendered */
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
  /** nearest snapshot at or before `ordinal` */
  snapshotAt(chunkId: string, ordinal: number): Snapshot | undefined
  snapshotOrdinals(chunkId: string): number[]

  eventCount(): number
}
