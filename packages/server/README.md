# The sim server (§21.6)

Authoritative, single writer, owns the tick loop. The world runs whether or not
anyone is watching, which is the whole point: a spectator platform is many
viewers on one continuing world, not many copies of one seed running privately
in tabs.

```
railway    this process
supabase   DATABASE_URL — events append-only, snapshots on event ordinal
vercel     packages/client, a pure observer with no simulation code in it
transport  websocket, frames batched at ~10 Hz, client interpolates
```

## Running it

```bash
npm run server                                     # memory store, port 8787
PORT=8080 DATABASE_URL=postgres://… npm run server # durable
```

| env | default | |
|---|---|---|
| `PORT` | 8787 | Railway sets this |
| `DATABASE_URL` | — | Supabase's pooled connection string. Without one the world is memory-only and says so, in the logs and in the client. |
| `CHUNK` | `schiedam-havens` | which world to run |
| `THROUGHPUT` | 2 (`normal`) | index into `THROUGHPUT`; the pace the world thinks at |
| `RNG_SEED` | `world` | one world, one seed — this is what makes it *shared*. The season number is appended. |
| `FLUSH_MS` | 1000 | write-behind window; the exact width of what a crash loses |
| `RETAIN_SEASONS` | 4 | seasons of events kept before the older ones are pruned |
| `PG_MAX` | 3 | pool ceiling. Small on purpose — see below. |

`GET /health` returns the world's state as JSON, for Railway's health check and
for anyone who wants to know what the world is doing without opening a browser.

The client finds the server through `VITE_SERVER_URL` at build time on Vercel,
or `?server=ws://…` for a local one.

## What is actually enforced here

**Single writer.** Look at `ClientMessage` in `@civ/protocol`: a spectator can
ask for an ordinal and ask about a building. There is no message that advances,
seeds or steers the world, so there is no code path by which a viewer could.
Throughput is a property of the world, not of a session — which is why the
client's speed buttons are gone and the pace is a readout.

**The rng is server-side.** `WorldService` constructs the `Simulation` with one
seed. Two viewers are not running the same seed in parallel and hoping they
agree; there is one world and they are both looking at it. That is the
difference between shared and synchronised, and it is why `@civ/sim` is not a
dependency of `@civ/client` — not a rule to remember, a missing edge in the
dependency graph.

**Append-only means append-only.** `DurableStore` creates a trigger that raises
on `update` and `delete`. Verified against a live Postgres:

```
=> update events set rationale = 'tampered' where id = 1;
ERROR:  events are append-only
```

## Seasons (§22.3)

65,000 decisions is a measurement device for `tune.ts` — twenty seeds are only
comparable if they all stop at the same point. **It does not govern the live
world**, and `packages/server/test/boundaries.test.ts` asserts that it cannot:
no source file outside the test harness may reference `DECISION_BUDGET`, and
neither server nor client may call `runToDecisionBudget`.

The world has a horizon instead. `SaturationWatch` applies the same rule
`calibrate.ts` reads off a finished curve — index gaining under 1pp and both
agent-built and cleared growing under 5% over 5,000 decisions — to the running
world. When it trips:

```
season_ended     written to the log with the final state
season_began     a new world on the same baseline, new rng seed
hello            every viewer is handed the new world
prune            events and snapshots older than RETAIN_SEASONS are dropped
```

One definition of the rule, two jobs. The budget is derived from the rule; the
rule does not answer to the budget. The alternative — running continuously —
means the last decades are agents trading a finished city, and the reset is a
product event rather than a failure.

## Three exposures, closed (§22.4)

**The hello loop.** Falling back to a full `hello` under send backpressure sends
the largest message this server has to the client already failing to keep up,
and the naive form retried every frame — an underpowered viewer resyncs forever
and each attempt makes its buffer worse. Now: one resync in flight at a time,
backoff of 2s / 8s / 20s, three attempts, then `close(1013, 'connection cannot
keep up with the world')`. A viewer that recovers has its strikes cleared.

**Write-behind durability.** `FLUSH_MS` is the exact width of what a crash
loses, it is printed at startup and it is on `/health` along with the current
queue depth. At `normal` throughput 1,000 ms is about 14 decisions.

A snapshot ahead of its flushed events would be worse than either — the scrub
would land on a state the log cannot account for. Two things prevent it: the
queues are captured in one pass with no `await` between them, so a snapshot is
always batched with events that were already queued when it was taken; and
events are inserted before snapshots within that batch. `highWaterOrdinal`
makes the invariant checkable rather than merely intended, and raises loudly if
it is ever violated.

What write-behind does **not** give you is resume. The durable log is a record,
not a restore point: a snapshot is the §16.2 data texture, not ownership,
capital or parcels, so a restart begins a new season rather than continuing the
old one. That is coherent with seasons and it is a deliberate limit, not an
oversight — full resume needs a state snapshot that does not exist yet.

**Deploy specifics.** One pool, opened once and held for the process's life;
nothing in the tick loop touches the database, it hands work to the write-behind
queue. `PG_MAX` defaults to 3 because Supabase's transaction pooler is a shared
resource and a generous `max` is how one service starves a whole project;
`prepare: false` is required by that pooler, and `application_name` makes this
process identifiable in `pg_stat_activity`.

The tick loop is a long-running `setInterval`, not a request handler. Nothing
here can prove the host is not suspending it between requests, so `/health`
reports `uptimeSeconds` and the actual `decisionsPerSecond`: if that sits below
the configured pace, the loop is not running when nobody is asking and the
deployment is wrong.

Retention is by season, decided now rather than at 150 million rows. Measured
rather than guessed: this world writes **0.275 events per decision** — most
decisions are a pass or an unaffordable option — which at `normal` throughput is
3.8 events a second, or about 330,000 rows a day if it never stopped.

But it does stop. A season saturates at roughly 65,000 decisions, which is
around 18,000 events and ~77 minutes at `normal`; `RETAIN_SEASONS` keeps the
last N whole and drops the ones before them, snapshots with their events. At the
default of 4 the steady state is on the order of 70,000 rows and a few hundred
megabytes of snapshot bytea — measured at 1.9 MB per 6,200 events and 8.4 kB per
snapshot. Seasons are what make retention easy: the table is bounded by the
horizon rather than by uptime.

That collides with append-only, and the resolution is to say what append-only
actually means: the simulation must never rewrite what happened. The trigger now
refuses every `update` unconditionally and allows a `delete` only inside a
transaction that has set `civ.retention`, which nothing in the write path does.

## Two things that shaped the design

**The store is write-behind, and that is not an optimisation.** `WorldStore` is
synchronous and stays synchronous: the tick loop calls `appendEvent` tens of
thousands of times a run, and awaiting a database inside it would put network
latency in the middle of the simulation. So the sim writes to memory at memory
speed and a flusher drains the tail to Postgres on an interval. Reads split by
who is asking — the simulation reads its own recent history from memory, and a
*spectator* reading history goes to the database, because that is the read that
has to survive the process and be the same for everyone watching.

**Frames are deltas, so a slow viewer cannot simply be sent fewer of them.** A
skipped delta is a texel that never gets its update and a building that is wrong
for the rest of the session. When a socket's send buffer runs away the server
stops sending diffs and re-sends `hello`: more bytes than one frame, fewer than
the backlog it replaces, and it lands the viewer exactly on the current state.

## Verified, seasons

Two browsers on one server, both settled:

```
viewer A {"tick":1130,"decisions":4686,"index":35.9}
viewer B {"tick":1130,"decisions":4686,"index":35.9}
```

Identical tick, identical decision count, frames arriving ~60 ms apart. The
scrub asks the server for an ordinal and gets back a row that is in Postgres —
`select event_ordinal, length(building_data) from snapshots` shows the 7,300-byte
data textures the scrub uploads.

A season turning, at `surge` against the same Postgres:

```
season 1 saturated; turning over

 season | events  |     type     | rationale
--------+---------+--------------+-------------------------------------------------
      1 |  15,704 | season_ended | season 1 reached 49.9% divergence over 199
      2 |   2,097 |              | completed generations and stopped changing
        |         | season_began | season 2 begins on the same ground

 season | snapshots | first_ordinal | last_ordinal
--------+-----------+---------------+--------------
      1 |        45 |             0 |       15,432
      2 |         7 |             0 |        1,823
```

The first run of that turn surfaced two ordering faults, both fixed above, both
covered by `test/seasons.test.ts`, and both visible in the table: `season_ended`
belongs to season 1 rather than to the season it announced the end of, and
season 2's ordinals restart at 0 rather than continuing the shared log.

`season_ended` was filed under season 2 because the flusher stamped the season
at flush time and the turn happens between append and flush. Snapshot ordinals
were positions in the shared log while the scrub's range was the global count,
so a new season's slider spent 85% of its travel on the season's first snapshot.

A third was found by reading rather than running: the log spans seasons but a
new season's tick restarts at 0, so anything filtering recent events by tick
alone would have handed a joining spectator the *previous* season's feed.

A fourth was found by pointing a browser at a running season: the §16.2 data
texture had 900 spare slots, which a world that does not stop exhausts in
minutes. See the root README.
