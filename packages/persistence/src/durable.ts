import postgres from 'postgres'
import type { WorldEvent } from './events.ts'
import { MemoryStore } from './memory.ts'
import type { EventQuery, Snapshot, WorldStore } from './store.ts'

/**
 * §21.6: the append-only log and the ordinal snapshots, in Postgres.
 *
 * `WorldStore` is synchronous and stays synchronous. The tick loop calls
 * `appendEvent` tens of thousands of times a run and awaiting a database inside
 * it would put network latency in the middle of the simulation — the reason a
 * single-writer sim server exists is precisely so the writer never blocks. So
 * this is a write-behind journal: the sim writes to memory at memory speed, and
 * a flusher drains the tail to Postgres on an interval.
 *
 * Reads split by who is asking. The simulation reads its own recent history
 * synchronously from memory, which is what `observe()` and the director need.
 * A *spectator* reading history — §20.4's scrub — goes to the database, because
 * that is the read that has to survive the process and be the same for everyone
 * watching. That asymmetry is the whole point and it is not an optimisation.
 *
 * With no connection string this degrades to exactly `MemoryStore`, and says
 * so, because a server that silently loses its world is the failure §18.3 is
 * about.
 */

type Sql = ReturnType<typeof postgres>

export interface DurableOptions {
  /** Postgres/Supabase connection string. Without one this is memory-only. */
  url?: string
  /** How often the tail is drained, in wall-clock ms. */
  flushMs?: number
  onError?: (e: unknown) => void
}

export class DurableStore implements WorldStore {
  private readonly memory = new MemoryStore()
  private readonly sql: Sql | null
  private readonly onError: (e: unknown) => void
  private pendingEvents: WorldEvent[] = []
  private pendingSnapshots: Snapshot[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private ready: Promise<void>

  readonly durability: 'postgres' | 'memory'

  constructor(opts: DurableOptions = {}) {
    this.onError = opts.onError ?? ((e) => console.error('[store]', e))
    this.sql = opts.url
      ? postgres(opts.url, { max: 4, onnotice: () => {}, prepare: false })
      : null
    this.durability = this.sql ? 'postgres' : 'memory'
    this.ready = this.sql ? this.migrate() : Promise.resolve()
    if (this.sql) {
      this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 1000)
      this.timer.unref?.()
    }
  }

  /** The tables the server needs, which are the §5 shapes from schema.sql. */
  private async migrate(): Promise<void> {
    const sql = this.sql!
    await sql`
      create table if not exists events (
        id               bigint primary key,
        chunk_id         text not null,
        tick             bigint not null,
        type             text not null,
        agent_id         text,
        building_id      text,
        parcel_id        text,
        rationale        text,
        cinematic_weight smallint not null default 0,
        payload          jsonb not null default '{}'::jsonb
      )`
    await sql`create index if not exists events_chunk_tick on events (chunk_id, tick)`
    await sql`create index if not exists events_building on events (building_id)`
    await sql`
      create table if not exists snapshots (
        chunk_id         text not null,
        event_ordinal    bigint not null,
        generation       int not null,
        tick             bigint not null,
        building_data    bytea not null,
        divergence_index real not null,
        stats            jsonb not null default '{}'::jsonb,
        primary key (chunk_id, event_ordinal)
      )`
    // §5's rule, enforced where it actually matters rather than by convention.
    await sql`
      create or replace function events_are_append_only() returns trigger as $$
      begin raise exception 'events are append-only'; end;
      $$ language plpgsql`
    await sql`drop trigger if exists events_no_update on events`
    await sql`
      create trigger events_no_update before update or delete on events
      for each row execute function events_are_append_only()`
  }

  // -- the simulation's side: synchronous, memory speed -----------------------

  appendEvent(e: Omit<WorldEvent, 'id'>): number {
    const id = this.memory.appendEvent(e)
    if (this.sql) this.pendingEvents.push({ ...e, id } as WorldEvent)
    return id
  }

  events(q?: EventQuery): WorldEvent[] {
    return this.memory.events(q)
  }

  weightedEvents(sinceTick: number, limit: number): WorldEvent[] {
    return this.memory.weightedEvents(sinceTick, limit)
  }

  putSnapshot(s: Snapshot): void {
    this.memory.putSnapshot(s)
    if (this.sql) this.pendingSnapshots.push(s)
  }

  snapshotAt(chunkId: string, ordinal: number): Snapshot | undefined {
    return this.memory.snapshotAt(chunkId, ordinal)
  }

  snapshotOrdinals(chunkId: string): number[] {
    return this.memory.snapshotOrdinals(chunkId)
  }

  eventCount(): number {
    return this.memory.eventCount()
  }

  // -- the spectator's side: asynchronous, durable ----------------------------

  /**
   * §21.6: "the client currently reads snapshots for the event scrub, which
   * becomes a server query rather than a memory read." This is that query. It
   * reads Postgres when there is one, so what a spectator scrubs to is what was
   * written rather than what happens to be in this process.
   */
  async querySnapshot(chunkId: string, ordinal: number): Promise<Snapshot | undefined> {
    if (!this.sql) return this.memory.snapshotAt(chunkId, ordinal)
    await this.settle()
    const rows = await this.sql<
      Array<{
        event_ordinal: string
        generation: number
        tick: string
        building_data: Buffer
        divergence_index: number
        stats: Record<string, number>
      }>
    >`
      select event_ordinal, generation, tick, building_data, divergence_index, stats
      from snapshots
      where chunk_id = ${chunkId} and event_ordinal <= ${ordinal}
      order by event_ordinal desc
      limit 1`
    const r = rows[0]
    if (!r) return undefined
    return {
      chunkId,
      ordinal: Number(r.event_ordinal),
      generation: r.generation,
      tick: Number(r.tick),
      buildingData: new Uint8Array(r.building_data),
      divergenceIndex: r.divergence_index,
      stats: r.stats,
    }
  }

  async queryOrdinals(chunkId: string): Promise<number[]> {
    if (!this.sql) return this.memory.snapshotOrdinals(chunkId)
    await this.settle()
    const rows = await this.sql<Array<{ event_ordinal: string }>>`
      select event_ordinal from snapshots where chunk_id = ${chunkId} order by event_ordinal`
    return rows.map((r) => Number(r.event_ordinal))
  }

  async queryBuildingHistory(buildingId: string, limit = 14): Promise<WorldEvent[]> {
    if (!this.sql) return this.memory.events({ buildingId, limit })
    await this.settle()
    const rows = await this.sql<Array<Record<string, unknown>>>`
      select * from events where building_id = ${buildingId} order by id desc limit ${limit}`
    return rows.map(rowToEvent)
  }

  // -- write-behind ----------------------------------------------------------

  /** Drain everything queued and wait for it — used before a spectator read. */
  async settle(): Promise<void> {
    await this.ready
    await this.flush()
  }

  private async flush(): Promise<void> {
    if (!this.sql || this.flushing) return
    if (this.pendingEvents.length === 0 && this.pendingSnapshots.length === 0) return
    this.flushing = true
    const events = this.pendingEvents
    const snapshots = this.pendingSnapshots
    this.pendingEvents = []
    this.pendingSnapshots = []
    try {
      await this.ready
      for (let i = 0; i < events.length; i += 500) {
        const chunk = events.slice(i, i + 500).map((e) => ({
          id: e.id,
          chunk_id: e.chunkId,
          tick: e.tick,
          type: e.type,
          agent_id: e.agentId ?? null,
          building_id: e.buildingId ?? null,
          parcel_id: e.parcelId ?? null,
          rationale: e.rationale ?? null,
          cinematic_weight: e.cinematicWeight,
          // jsonb column: the driver needs it marked, or it tries to infer a
          // scalar type from an object and fails at the boundary
          payload: this.sql!.json((e.payload ?? {}) as Record<string, never>),
        }))
        await this.sql`insert into events ${this.sql(chunk)} on conflict (id) do nothing`
      }
      for (const s of snapshots) {
        await this.sql`
          insert into snapshots (chunk_id, event_ordinal, generation, tick, building_data, divergence_index, stats)
          values (${s.chunkId}, ${s.ordinal}, ${s.generation}, ${s.tick},
                  ${Buffer.from(s.buildingData)}, ${s.divergenceIndex}, ${this.sql.json(s.stats)})
          on conflict (chunk_id, event_ordinal) do nothing`
      }
    } catch (e) {
      // Put them back rather than dropping them; a dropped event is a hole in
      // an append-only log, which is worse than a slow one.
      this.pendingEvents = events.concat(this.pendingEvents)
      this.pendingSnapshots = snapshots.concat(this.pendingSnapshots)
      this.onError(e)
    } finally {
      this.flushing = false
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (!this.sql) return
    await this.flush()
    await this.sql.end({ timeout: 5 })
  }
}

function rowToEvent(r: Record<string, unknown>): WorldEvent {
  return {
    id: Number(r.id),
    chunkId: r.chunk_id as string,
    tick: Number(r.tick),
    type: r.type as WorldEvent['type'],
    agentId: (r.agent_id as string) ?? undefined,
    buildingId: (r.building_id as string) ?? undefined,
    parcelId: (r.parcel_id as string) ?? undefined,
    rationale: (r.rationale as string) ?? undefined,
    cinematicWeight: Number(r.cinematic_weight),
    payload: (r.payload as Record<string, unknown>) ?? {},
  }
}
