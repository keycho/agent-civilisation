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
  /** §22.3: which run of this chunk. Ordinals restart when a season does. */
  season: number
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
  /**
   * §55 tier 1: attach the agent-voice line to an already-written event.
   *
   * Not a mutation of the record — `rationale` is untouched and no event is
   * added, removed or reordered. The frame re-reads its event window every
   * tick, so a line attached here reaches every client on the next frame with
   * no protocol change and no push.
   */
  voiceEvent(id: number, voice: string): void
  /** Most recent events ranked by cinematic weight — §17's director input. */
  weightedEvents(chunkId: string, sinceTick: number, limit: number): WorldEvent[]
  /**
   * §40.6: total cinematic weight since a tick — how much watchable work a
   * chunk has done lately, as one number. Deliberately NOT weightedEvents
   * summed: that returns the top N by weight, so on any busy world every
   * chunk hits N times the maximum weight and the measure saturates. This
   * walks the window and adds it up.
   */
  weightSince(chunkId: string, sinceTick: number): number

  putSnapshot(s: Snapshot): void
  /** nearest snapshot at or before `ordinal` */
  snapshotAt(chunkId: string, ordinal: number): Snapshot | undefined
  snapshotOrdinals(chunkId: string): number[]

  eventCount(): number

  /**
   * §72.1: the id the next event will be given.
   *
   * §20.4's ordinals used `eventCount()` — the in-memory log's LENGTH — for
   * both the snapshot key and the season's origin. Those agreed only while the
   * log started empty at id 1 and nothing was ever removed from it. A store
   * that rejoins a durable table starts its allocator high and hydrates a
   * window of old rows, and under that a length is neither monotonic with the
   * ids nor comparable across a restart. The id is both.
   */
  nextEventId(): number

  /**
   * §72.1: put already-written events back into memory, with the ids they were
   * written under.
   *
   * Two jobs, both required for a world to resume rather than restart. It moves
   * the id allocator above everything the durable table already holds, which is
   * the fix for ids restarting at 1 and colliding; and it refills the recent
   * window `observe()` reads, because §60's decision input includes the last
   * 180 ticks of the log and a world that resumes with an empty one makes
   * different decisions for its first 180 ticks.
   *
   * Never used on the write path. A store that is given an id it has already
   * issued must say so rather than accept it.
   */
  hydrate(events: WorldEvent[]): void

  /**
   * §64.2: when this chunk's world first existed, in epoch milliseconds.
   *
   * Not process start — a deploy restarts the process and a season turn
   * rebuilds the world, and a status line that resets to `up 0d` on either is
   * telling the viewer something false about the thing it is describing.
   * Recorded once, on the first boot that ever touched this chunk, and read
   * back forever after. A store with no durable place to put it answers with
   * the moment it was constructed, which is the truth available to it.
   */
  genesisAt(chunkId: string): number
}
