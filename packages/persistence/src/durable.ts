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
  /** §22.4: pool ceiling. Small on purpose — see the constructor. */
  maxConnections?: number
  onError?: (e: unknown) => void
}

export class DurableStore implements WorldStore {
  private readonly memory = new MemoryStore()
  private readonly sql: Sql | null
  private readonly onError: (e: unknown) => void
  /**
   * Queued with the season they were written in, not the one current at flush
   * time. The event that *ends* a season is appended before the turn and
   * flushed after it, so stamping at flush time filed it under the season it
   * announced the end of.
   */
  private pendingEvents: Array<WorldEvent & { season: number }> = []
  private pendingSnapshots: Snapshot[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private ready: Promise<void>

  readonly durability: 'postgres' | 'memory'
  /**
   * §22.4: how far behind the durable log can be, in wall-clock ms. This is the
   * exact width of what a crash loses — see the server README. It is reported at
   * startup and on /health rather than being an implementation detail, because
   * on a continuously running spectator world it is visible as history
   * un-happening.
   */
  readonly flushMs: number
  /**
   * §22.3: stamped on each event as it is appended. A season boundary is a new
   * run of the same chunk, and the previous one stays queryable as history
   * rather than being overwritten or thrown away.
   */
  season = 1

  constructor(opts: DurableOptions = {}) {
    this.onError = opts.onError ?? ((e) => console.error('[store]', e))
    /**
     * §22.4: "one long-lived pooled connection from the sim server, never per
     * tick, given the connection exhaustion on hoodscan."
     *
     * One pool, opened once here and held for the process's life. Nothing in the
     * tick loop opens a connection: the loop hands work to the write-behind
     * queue and never touches the database at all.
     *
     * The ceiling is deliberately small. This server needs one connection for
     * the flusher and one or two for spectator queries, and Supabase's
     * transaction pooler is a shared resource where a generous `max` is how a
     * single service starves everything else on the project. `prepare: false`
     * is required by that pooler; `application_name` is what makes this process
     * identifiable in `pg_stat_activity` when connections do run short.
     */
    this.sql = opts.url
      ? postgres(opts.url, {
          max: opts.maxConnections ?? 3,
          idle_timeout: 30,
          connect_timeout: 15,
          prepare: false,
          onnotice: () => {},
          connection: { application_name: 'civ-sim-server' },
        })
      : null
    this.durability = this.sql ? 'postgres' : 'memory'
    this.flushMs = opts.flushMs ?? 1000
    this.ready = this.sql ? this.migrate() : Promise.resolve()
    if (this.sql) {
      this.timer = setInterval(() => void this.flush(), this.flushMs)
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
        season           int not null default 1,
        tick             bigint not null,
        type             text not null,
        agent_id         text,
        building_id      text,
        parcel_id        text,
        rationale        text,
        cinematic_weight smallint not null default 0,
        payload          jsonb not null default '{}'::jsonb
      )`
    await sql`create index if not exists events_chunk_tick on events (chunk_id, season, tick)`
    await sql`create index if not exists events_building on events (building_id)`
    await sql`
      create table if not exists snapshots (
        chunk_id         text not null,
        season           int not null default 1,
        event_ordinal    bigint not null,
        generation       int not null,
        tick             bigint not null,
        building_data    bytea not null,
        divergence_index real not null,
        stats            jsonb not null default '{}'::jsonb,
        primary key (chunk_id, season, event_ordinal)
      )`
    /**
     * §5's rule, enforced where it actually matters rather than by convention.
     *
     * §22.4 needed retention, and retention deletes rows — so the rule has to
     * say what it actually means. An update is never allowed: the simulation
     * must not be able to rewrite what happened. A delete is allowed only under
     * an explicit session flag that nothing in the write path ever sets, which
     * is how an administrative prune differs from history being edited.
     */
    await sql`
      create or replace function events_are_append_only() returns trigger as $$
      begin
        if tg_op = 'DELETE' and current_setting('civ.retention', true) = 'on' then
          return old;
        end if;
        raise exception 'events are append-only';
      end;
      $$ language plpgsql`
    await sql`drop trigger if exists events_no_update on events`
    await sql`
      create trigger events_no_update before update or delete on events
      for each row execute function events_are_append_only()`
  }

  // -- the simulation's side: synchronous, memory speed -----------------------

  appendEvent(e: Omit<WorldEvent, 'id'>): number {
    const id = this.memory.appendEvent(e)
    if (this.sql) this.pendingEvents.push({ ...e, id, season: this.season } as WorldEvent & { season: number })
    return id
  }

  events(q?: EventQuery): WorldEvent[] {
    return this.memory.events(q)
  }

  weightedEvents(chunkId: string, sinceTick: number, limit: number): WorldEvent[] {
    return this.memory.weightedEvents(chunkId, sinceTick, limit)
  }

  weightSince(chunkId: string, sinceTick: number): number {
    return this.memory.weightSince(chunkId, sinceTick)
  }

  /**
   * §22.4: "a snapshot ahead of its flushed events is worse than either."
   *
   * A snapshot is keyed on an event ordinal, so a snapshot that reaches the
   * database before the events it counts describes a history that has not been
   * written yet — the scrub would land on a state the log cannot account for.
   * Two things prevent it. The queues are drained in one pass with no await
   * between capturing them, so a snapshot is always batched with events that
   * were already queued when it was taken; and events are inserted before
   * snapshots within that batch, so the ordering holds even if the process dies
   * mid-flush. `highWaterOrdinal` makes the invariant checkable rather than
   * merely intended.
   */
  putSnapshot(s: Snapshot): void {
    this.memory.putSnapshot(s)
    if (this.sql) this.pendingSnapshots.push(s)
  }

  /** The event ordinal the durable log has actually reached. */
  highWaterOrdinal = 0

  /** Events and snapshots still waiting to be written. */
  get lag(): { events: number; snapshots: number } {
    return { events: this.pendingEvents.length, snapshots: this.pendingSnapshots.length }
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
  async querySnapshot(chunkId: string, ordinal: number, season = this.season): Promise<Snapshot | undefined> {
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
      where chunk_id = ${chunkId} and season = ${season} and event_ordinal <= ${ordinal}
      order by event_ordinal desc
      limit 1`
    const r = rows[0]
    if (!r) return undefined
    return {
      chunkId,
      season,
      ordinal: Number(r.event_ordinal),
      generation: r.generation,
      tick: Number(r.tick),
      buildingData: new Uint8Array(r.building_data),
      divergenceIndex: r.divergence_index,
      stats: r.stats,
    }
  }

  async queryOrdinals(chunkId: string, season = this.season): Promise<number[]> {
    if (!this.sql) return this.memory.snapshotOrdinals(chunkId)
    await this.settle()
    const rows = await this.sql<Array<{ event_ordinal: string }>>`
      select event_ordinal from snapshots
      where chunk_id = ${chunkId} and season = ${season} order by event_ordinal`
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
          season: e.season,
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
      this.highWaterOrdinal = Math.max(
        this.highWaterOrdinal,
        events.length ? events[events.length - 1].id : this.highWaterOrdinal,
      )
      for (const s of snapshots) {
        if (s.ordinal > this.highWaterOrdinal) {
          // Should be unreachable: the drain above wrote every event queued
          // when this snapshot was taken. Loud rather than silent, because a
          // snapshot describing unwritten history is the §18.3 failure shape.
          this.onError(
            new Error(
              `snapshot at ordinal ${s.ordinal} is ahead of the flushed log (${this.highWaterOrdinal})`,
            ),
          )
        }
        await this.sql`
          insert into snapshots (chunk_id, season, event_ordinal, generation, tick, building_data, divergence_index, stats)
          values (${s.chunkId}, ${s.season}, ${s.ordinal}, ${s.generation}, ${s.tick},
                  ${Buffer.from(s.buildingData)}, ${s.divergenceIndex}, ${this.sql.json(s.stats)})
          on conflict (chunk_id, season, event_ordinal) do nothing`
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

  /**
   * §22.4: "the events table grows unbounded on a world that never stops, so
   * decide retention or partitioning before it is 150 million rows rather than
   * after."
   *
   * At `normal` throughput this world writes roughly one event per decision and
   * 14 decisions a second — about 1.2 million rows a day, so 150 million is
   * four months of uptime. Retention is by season, because a season is the unit
   * a spectator understands and the unit the scrub queries within: keep the
   * last N seasons whole, drop the ones before them. Snapshots go with their
   * events, since a snapshot without its log is a picture with no account of
   * how it got there.
   */
  async pruneSeasons(chunkId: string, keep: number): Promise<{ events: number; snapshots: number }> {
    if (!this.sql || keep < 1) return { events: 0, snapshots: 0 }
    await this.settle()
    const cutoff = this.season - keep + 1
    if (cutoff <= 1) return { events: 0, snapshots: 0 }
    return this.sql.begin(async (tx) => {
      // the one place this is set, and it is set for a single transaction
      await tx`select set_config('civ.retention', 'on', true)`
      const ev = await tx`delete from events where chunk_id = ${chunkId} and season < ${cutoff}`
      const sn = await tx`delete from snapshots where chunk_id = ${chunkId} and season < ${cutoff}`
      return { events: ev.count ?? 0, snapshots: sn.count ?? 0 }
    }) as Promise<{ events: number; snapshots: number }>
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
