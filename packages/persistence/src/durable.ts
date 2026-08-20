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

/**
 * §72.4: how deep the write-behind queue may get before the world is made to
 * wait for it.
 *
 * Sized as roughly ten seconds of a busy eight-chunk process at the §72.2 pace,
 * so an ordinary latency spike is absorbed and a sustained shortfall is not.
 * Crossing it is not an error — it is the queue saying the database is the
 * constraint, and the only honest response is to stop producing history faster
 * than history can be written down.
 */
const QUEUE_CEILING = 20_000

/** the window the drain rate is measured over */
const DRAIN_WINDOW_MS = 30_000

/** §72.4: a queue this deep after a flush gets another one immediately */
const CATCH_UP_AT = 2_000

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
  /** §72.1: the next flush is re-sending a batch that already failed once */
  private retrying = false
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
    /**
     * §64.2: when each chunk's world first existed. One row per chunk, written
     * on the first boot that ever touched it and never updated — a deploy
     * restarts the process and a season turn rebuilds the world, and an
     * `up 6d` that resets on either is a false statement about the thing the
     * status line is describing.
     */
    await sql`
      create table if not exists genesis (
        chunk_id text primary key,
        at       timestamptz not null default now()
      )`
    /**
     * §72.1: where a world goes when the process stops.
     *
     * `season` here is the monotonic sequence the spec asks for — one row per
     * chunk, incremented on a turn, never reset. It is deliberately in the same
     * row as the state blob so that "which season is this" and "what was the
     * world doing" cannot disagree: one upsert writes both.
     */
    await sql`
      create table if not exists worlds (
        chunk_id       text primary key,
        season         int not null default 1,
        tick           bigint not null default 0,
        first_event_id bigint not null default 0,
        decisions      bigint not null default 0,
        saved_at       timestamptz not null default now(),
        state          bytea
      )`
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

  /**
   * §55 tier 1: the voice line is attached in memory only, deliberately.
   *
   * It is presentation written after the fact, and the durable log's job is
   * the record — `rationale`, which is already written and unchanged. Not
   * persisting it means a restored world shows the sim's own lines for its
   * restored window and fresh voice lines from there on, which is the correct
   * degradation: no history is lost, and nothing spends the ceiling replaying
   * lines that were already read.
   */
  voiceEvent(id: number, voice: string): void {
    this.memory.voiceEvent(id, voice)
  }

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

  /**
   * §72.4: what the flusher is achieving, so a queue that is falling behind can
   * be seen falling behind rather than inferred from a number that grows.
   *
   * Production went 701 -> 10,736 -> 18,256 queued events across 1,000 seconds,
   * monotonic, and nothing reported why. `rowsPerSecond` is what the drain
   * actually sustains; `busy` is the share of wall clock spent inside a flush.
   * When busy approaches 1 and the queue still grows, the database is the
   * ceiling and the emit rate has to be bounded by it — which is what
   * `saturated` says and what the tick loop now reads.
   */
  get drain(): { rowsPerSecond: number; lastMs: number; busy: number; saturated: boolean } {
    const span = Math.max(1, Date.now() - this.drainSince)
    return {
      rowsPerSecond: +((this.drainRows / span) * 1000).toFixed(0),
      lastMs: this.lastFlushMs,
      busy: +Math.min(1, this.drainMs / span).toFixed(2),
      saturated: this.saturated,
    }
  }

  /**
   * §72.4: the queue is deeper than the flusher can clear in a few intervals.
   *
   * The tick loop reads this and stops advancing the world until it clears. "A
   * permanently growing queue is a slow leak plus a data-loss window" — the
   * only two ways out are a faster drain or a slower emitter, and when the
   * drain is already saturated the emitter is the one that has to give.
   */
  get saturated(): boolean {
    return this.pendingEvents.length > QUEUE_CEILING
  }

  private drainRows = 0
  private drainMs = 0
  private drainSince = Date.now()
  private lastFlushMs = 0

  snapshotAt(chunkId: string, ordinal: number): Snapshot | undefined {
    return this.memory.snapshotAt(chunkId, ordinal)
  }

  snapshotOrdinals(chunkId: string): number[] {
    return this.memory.snapshotOrdinals(chunkId)
  }

  eventCount(): number {
    return this.memory.eventCount()
  }

  hydrate(events: WorldEvent[]): void {
    this.memory.hydrate(events)
  }

  nextEventId(): number {
    return this.memory.nextEventId()
  }

  /**
   * §72.1: move the id allocator above everything the durable table already
   * holds, before a single event is written.
   *
   * `events.id` is a `bigint primary key` filled from an in-memory counter that
   * started at 1 on every boot, and the flush said `on conflict (id) do
   * nothing` — so after a redeploy every event the new world wrote collided
   * with a row from the previous one and was silently dropped, for as long as
   * it took the counter to pass the old total. Reading `max(id)` once at boot
   * is the whole fix, and it must happen before `constructHosts` builds
   * anything, because construction itself appends.
   */
  async loadEventCursor(): Promise<number> {
    if (!this.sql) return this.memory.cursor
    await this.ready
    const rows = await this.sql<Array<{ max: string | null }>>`select max(id) from events`
    const next = Number(rows[0]?.max ?? 0) + 1
    this.memory.seekTo(next)
    return next
  }

  /**
   * §72.1: the tail of a season's log, oldest first, for a resuming world to
   * observe against.
   *
   * §60's decision input includes `store.events({ sinceTick: tick - 180 })`, so
   * the recent log is a simulation input and not only a spectator's feed. A
   * world that resumes with an empty one is a world making its first 180 ticks
   * of decisions blind.
   */
  async loadRecentEvents(chunkId: string, season: number, limit = 4000): Promise<WorldEvent[]> {
    if (!this.sql) return []
    await this.ready
    const rows = await this.sql<Array<Record<string, unknown>>>`
      select * from events
      where chunk_id = ${chunkId} and season = ${season}
      order by id desc limit ${limit}`
    return rows.map(rowToEvent).reverse()
  }

  private readonly genesis = new Map<string, number>()

  genesisAt(chunkId: string): number {
    return this.genesis.get(chunkId) ?? this.memory.genesisAt(chunkId)
  }

  /**
   * §64.2: claim this chunk's genesis if nobody has, then read back whatever
   * is recorded — which on every boot after the first is the original. Async
   * and called once at startup; `genesisAt` is the synchronous read the frame
   * path uses, and falls back to process start until this lands.
   */
  async loadGenesis(chunkId: string): Promise<number> {
    if (!this.sql) return this.memory.genesisAt(chunkId)
    try {
      // the table is created by `migrate`, which is still in flight at boot —
      // without this the insert lands on a table that does not exist yet and
      // the catch below swallows it into a world that never learns its own age
      await this.ready
      await this.sql`insert into genesis (chunk_id) values (${chunkId}) on conflict do nothing`
      const rows = await this.sql<Array<{ at: Date }>>`
        select at from genesis where chunk_id = ${chunkId}`
      const at = rows[0]?.at ? new Date(rows[0].at).getTime() : Date.now()
      this.genesis.set(chunkId, at)
      return at
    } catch (err) {
      // a world that cannot read its own age still runs; it just says so
      console.error('[genesis] could not read', chunkId, err)
      return this.memory.genesisAt(chunkId)
    }
  }

  // -- §72.1: resume ---------------------------------------------------------

  /**
   * The season this chunk is on, and the world it was in the middle of.
   *
   * Called once per chunk at boot, before anything is constructed. The row is
   * created at season 1 if this chunk has never run; otherwise whatever the
   * last process left is returned untouched. Nothing here ever writes a lower
   * season than it read — that is what "monotonic sequence, never reset to 1"
   * has to mean if a redeploy is going to stop starting the world over.
   */
  async resumePoint(
    chunkId: string,
  ): Promise<{ season: number; firstEventId: number; state: Uint8Array | null }> {
    if (!this.sql) return { season: 1, firstEventId: 0, state: null }
    await this.ready
    const rows = await this.sql<
      Array<{ season: number; first_event_id: string; state: Uint8Array | null }>
    >`
      insert into worlds (chunk_id, season) values (${chunkId}, 1)
      on conflict (chunk_id) do update set chunk_id = excluded.chunk_id
      returning season, first_event_id, state`
    const r = rows[0]
    let season = r?.season ?? 1
    /**
     * The migration case, and the invariant it protects: a season number is
     * used by exactly one world.
     *
     * A chunk can have a log without having a saved state — every deploy before
     * §72.1 was exactly that, and so is any future boot where the blob is lost
     * or refused. Reusing season 1 there would start a second world under a
     * number the first one already wrote snapshots under, and those keys are
     * `(chunk_id, season, event_ordinal)` — which is the collision this block
     * exists to end, not to move somewhere else. So when there is history but
     * no state, the world begins ABOVE everything the log has seen.
     */
    if (!r?.state) {
      const seen = await this.sql<Array<{ max: number | null }>>`
        select max(season) as max from events where chunk_id = ${chunkId}`
      const highest = seen[0]?.max ?? 0
      if (highest >= season) {
        season = highest + 1
        await this.sql`
          update worlds set season = ${season}, first_event_id = 0, tick = 0
          where chunk_id = ${chunkId}`
      }
    }
    return {
      season,
      firstEventId: r?.state ? Number(r?.first_event_id ?? 0) : 0,
      state: r?.state ?? null,
    }
  }

  /**
   * Turn the season for this chunk and return the new number.
   *
   * The increment happens in the database rather than in the process, so two
   * processes racing on the same chunk cannot both decide they are season 5.
   * The state blob is dropped in the same statement: a new season starts from
   * the seed, and a stale blob from the season before it is exactly the thing
   * that must not be resumed into.
   */
  async turnSeason(chunkId: string): Promise<number> {
    if (!this.sql) return this.season + 1
    await this.ready
    const rows = await this.sql<Array<{ season: number }>>`
      insert into worlds (chunk_id, season) values (${chunkId}, 2)
      on conflict (chunk_id) do update
        set season = worlds.season + 1, state = null, tick = 0, first_event_id = 0
      returning season`
    return rows[0]?.season ?? this.season + 1
  }

  /** Write the world's own state. One row per chunk; the newest wins. */
  async saveWorldState(
    chunkId: string,
    season: number,
    tick: number,
    firstEventId: number,
    decisions: number,
    state: Uint8Array,
  ): Promise<void> {
    if (!this.sql) return
    await this.ready
    await this.sql`
      insert into worlds (chunk_id, season, tick, first_event_id, decisions, saved_at, state)
      values (${chunkId}, ${season}, ${tick}, ${firstEventId}, ${decisions}, now(), ${Buffer.from(state)})
      on conflict (chunk_id) do update set
        season = excluded.season, tick = excluded.tick,
        first_event_id = excluded.first_event_id, decisions = excluded.decisions,
        saved_at = excluded.saved_at, state = excluded.state`
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
    let ok = true
    const t0 = Date.now()
    const events = this.pendingEvents
    const snapshots = this.pendingSnapshots
    /**
     * §72.1: `on conflict do nothing` on an append-only log is silent data loss
     * wearing the clothes of idempotency. It stays only where a conflict is
     * PROVABLY a retry of the same row, and this flag is that proof.
     *
     * A batch that failed part-way is put back below and re-sent; postgres
     * inserts a multi-row statement atomically, so the only way a re-sent row
     * can conflict is that it landed and the acknowledgement did not. Anything
     * else — an id the allocator has issued twice, a second process writing the
     * same chunk — is a fault, and on a first attempt it now raises instead of
     * disappearing.
     */
    const retry = this.retrying
    this.retrying = false
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
        // see `retry` above: a first attempt raises on conflict, a re-send does not
        await (retry
          ? this.sql`insert into events ${this.sql(chunk)} on conflict (id) do nothing`
          : this.sql`insert into events ${this.sql(chunk)}`)
      }
      this.highWaterOrdinal = Math.max(
        this.highWaterOrdinal,
        events.length ? events[events.length - 1].id : this.highWaterOrdinal,
      )
      /**
       * §72.4: snapshots go in one statement rather than one round trip each.
       *
       * At `snapshotEveryEvents` and eight chunks this was a handful of
       * sequential awaits per flush, each carrying a few kilobytes of bytea —
       * and on a pooled connection to a database a continent away the round
       * trips, not the bytes, are what the interval is spent on.
       */
      const ready: Snapshot[] = []
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
        ready.push(s)
      }
      for (let i = 0; i < ready.length; i += 100) {
        const rows = ready.slice(i, i + 100).map((s) => ({
          chunk_id: s.chunkId,
          season: s.season,
          event_ordinal: s.ordinal,
          generation: s.generation,
          tick: s.tick,
          building_data: Buffer.from(s.buildingData),
          divergence_index: s.divergenceIndex,
          stats: this.sql!.json(s.stats as Record<string, never>),
        }))
        await (retry
          ? this.sql`insert into snapshots ${this.sql(rows)}
              on conflict (chunk_id, season, event_ordinal) do nothing`
          : this.sql`insert into snapshots ${this.sql(rows)}`)
      }
    } catch (e) {
      // Put them back rather than dropping them; a dropped event is a hole in
      // an append-only log, which is worse than a slow one. The next attempt is
      // a RETRY, and only a retry is allowed to swallow a conflict.
      this.pendingEvents = events.concat(this.pendingEvents)
      this.pendingSnapshots = snapshots.concat(this.pendingSnapshots)
      this.retrying = true
      ok = false
      this.onError(e)
    } finally {
      this.lastFlushMs = Date.now() - t0
      this.drainMs += this.lastFlushMs
      this.drainRows += events.length + snapshots.length
      // roll the measurement window rather than averaging over the process's
      // whole life, which is the mistake /health's old rate figure made
      if (Date.now() - this.drainSince > DRAIN_WINDOW_MS) {
        this.drainSince = Date.now() - DRAIN_WINDOW_MS / 2
        this.drainRows = Math.round(this.drainRows / 2)
        this.drainMs = Math.round(this.drainMs / 2)
      }
      this.flushing = false
    }
    /**
     * §72.4: when the queue is still deep, flush again now rather than waiting
     * out the rest of the interval.
     *
     * A fixed 1 s tick spends its idle capacity doing nothing while the backlog
     * grows: measured locally, a drain clearing 311 rows/s is busy 27% of the
     * time, so three quarters of the interval was available and unused. The
     * interval is the promise about how STALE the log may be (§22.4); it was
     * never meant to be a ceiling on how fast it may catch up.
     *
     * ONLY ON SUCCESS. The first version re-flushed unconditionally, and the
     * test suite found what that does the moment the database is gone: a failed
     * flush re-queues its batch, sees a queue over the threshold, and calls
     * itself again immediately — 51,791 `CONNECTION_ENDED` errors in one suite
     * run, a hot loop on the event loop and a log nobody can read. A failure
     * waits for the interval, which is the backoff.
     */
    if (ok && this.pendingEvents.length > CATCH_UP_AT) void this.flush()
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
    /**
     * §72.1: retention can never reach a season the current world has not
     * passed.
     *
     * It used to prune by season NUMBER against a counter that restarted at 1
     * on every deploy, so a process that got to season 5 deleted the PREVIOUS
     * deploy's season 1 along with its own. With `worlds.season` monotonic that
     * cannot happen by construction, but the guarantee is asserted here rather
     * than inferred from somewhere else: the cutoff is clamped below the
     * running season, so the season being played and everything after it are
     * out of reach whatever `keep` says.
     */
    const cutoff = Math.min(this.season - keep + 1, this.season)
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
