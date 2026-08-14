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
| `RNG_SEED` | `world-1` | one world, one seed — this is what makes it *shared* |

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

## Verified

Two browsers on one server, both settled:

```
viewer A {"tick":1130,"decisions":4686,"index":35.9}
viewer B {"tick":1130,"decisions":4686,"index":35.9}
```

Identical tick, identical decision count, frames arriving ~60 ms apart. The
scrub asks the server for an ordinal and gets back a row that is in Postgres —
`select event_ordinal, length(building_data) from snapshots` shows the 7,300-byte
data textures the scrub uploads.
