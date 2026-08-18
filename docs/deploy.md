# Deploying it (§21.6, §23.6)

Two services. The client is useless without the server — it is a pure observer
and with nothing to observe it sits on "connecting…" — so the server goes first.

## 1. Supabase

Create a project. Take the **transaction pooler** connection string (port 6543),
not the direct one: the sim server holds a small long-lived pool and the pooler
is what that is for. No schema to run — `DurableStore` creates its two tables and
the append-only trigger on first connect.

## 2. Railway — the sim server

Deploy this repository. `railway.json` sets the start command and points the
health check at `/health`.

**Chosen deploy shape (§44.5): one service, one origin, every chunk in this
process.** Set `CHUNKS=all` and the service hosts the full `index.json`
roster behind one ws origin with path routing — one deploy, one health
surface, one DATABASE_URL (every store row is chunk-scoped already). This is
in-process rather than child-process supervision: fate-sharing is the
accepted trade for one bill and one ops surface, and per-chunk isolation is
a later hardening if a chunk ever takes the process down. Size the instance
at 2 GB / 2 vCPU: eight worlds tick at `THROUGHPUT=2` well inside that.

```
DATABASE_URL     the Supabase pooler string
CHUNKS           all            (or a comma list; omit and set CHUNK for the
                                 single-chunk shape local dev uses)
THROUGHPUT       2 (normal). 0 pauses, 4 is surge.
RETAIN_SEASONS   4
RNG_SEED         any string; changing it changes the world's evolution
```

Endpoints in multi-chunk mode: `wss://host/ws/<chunkId>` per chunk;
`GET /health` aggregates with one block per chunk (`/health/<chunkId>` for
one); `GET /summary` returns every hosted chunk's §27.3 summary as one
array — the global view's poll. Single-chunk mode keeps the flat `/health`
and bare-`/` ws every existing local url uses; `/summary` is an array in
both modes.

**Boot is progressive.** The listener binds before any world is
constructed, so `/health` answers 200 within a couple of seconds of
process start; while chunks construct it carries a `booting` block
(`constructing` / `ready` / `pending`) instead of the per-chunk stats, and
a ws upgrade or `/summary/<id>` for a chunk still constructing returns 503
with `Retry-After` rather than 404. `railway.json` sets
`healthcheckTimeout: 300` — generous headroom over the worst boot, but the
check actually passes on the first probe because of the early bind, and
the boot is watchable through it rather than inferred from a timeout.

`PORT` is set by Railway. Everything else has a default; `packages/server/README.md`
lists them.

Confirm it before moving on:

```bash
curl https://<your-app>.railway.app/health
```

`durability` must read `postgres`. If it reads `memory` the connection string did
not arrive and the world will not survive a restart. `decisionsPerSecond` should
sit near the configured pace — if it is far below, the host is suspending the
process between requests and the tick loop is being treated as a request
handler, which is the §22.4 failure.

## 3. Vercel — the client

Deploy the same repository. `vercel.json` sets the build.

```
VITE_SERVER_URL   wss://<your-app>.railway.app
```

It must be `wss://`, not `ws://` — the page is served over https and a browser
will refuse the mixed connection. Without the variable the client guesses
`wss://<its own hostname>:8787`, which is wrong on Vercel.

With more than one chunk deployed (§36.1's city switcher), one env var cannot
name them all: fill `packages/client/public/world/servers.json` with a
`wss://` url per chunk id. Under the chosen one-service shape every entry
points at the same origin with a different path:

```json
"schiedam-havens":      "wss://<your-app>.railway.app/ws/schiedam-havens",
"london-deptford":      "wss://<your-app>.railway.app/ws/london-deptford",
… one line per chunk in index.json …
```

Resolution order
per chunk is `?server=` override, then `servers.json`, then `VITE_SERVER_URL`.
The committed file carries local dev `ws://` entries, which an https page
skips automatically, so a single-chunk deployment can ignore it. The client
also checks the server's hello against the loaded chunk id and refuses the
socket on a mismatch ("wrong world"), so a misrouted url degrades to a
baseline view rather than painting another city's mutations onto this one.

`?server=wss://…` overrides it at runtime, which is the quickest way to point a
deployed client at a different world.

## 4. What the region world adds (§31.6-5)

**Chunk index.** `packages/client/public/world/index.json` is the roster the
client's switcher reads; the importer maintains it. Eight chunks as of §31.6-5:
the five cities plus the NL constellation (vlaardingen-westwijk, maasland-dorp,
maassluis-haven). All of `world/` — seeds, `index.json`, `servers.json`, and
the `coarse/` layer (`global.json`, `nl.json`) — is static and ships with the
client build; nothing serves it but the CDN.

**Summary endpoint.** Each chunk server exposes `GET /summary`: the §27.3
settlement summary's fine-side body (agent count, median land value, vacancy,
activity rate, capital density, realised yield, contest) computed by the same
`fineSummaryOf` the region harness reads — one dataset, computed once. The
endpoint carries identity (`id`, `country`) and `tick` only; population and
value tier are joined from the coarse layer the client already has, so the
endpoint cannot drift from the artifact that owns those fields.

**One service, every chunk (§44.5, chosen).** The region SIMULATION
(migration, gated materialisation, the §28.3 transit economics) lives in the
harness (`packages/sim/test/region-run.ts`) against the pre-registered
contract; the deployed topology is one process hosting every chunk sim
behind one ws origin (`CHUNKS=all`, path routing) — there is still no
region master doing cross-chunk mechanics, and the global view is a client
concern fed by one `/summary` poll plus the static coarse layer. The
operator pastes back exactly two values: `DATABASE_URL` on the Railway
service, and the production origin into `servers.json`'s wss urls (plus
`VITE_SERVER_URL` as the fallback).

## 5. Genesis: standing a world up from nothing

The runbook for a fresh world — new database, new service, no history. Every
step is a command or a paste; nothing here is inferred.

**0. What you need.** A Postgres url, a Railway (or any Node 22.18+ host)
project, a Vercel project. Node >= 22.18 is load-bearing: the packages ship
TypeScript sources and rely on native type stripping being on by default.

**1. The database.** Run the DDL from §1 above in the Supabase SQL editor —
`events` (app-assigned bigint id, chunk, season), `snapshots` (PK on
chunk/season/event ordinal), the append-only trigger and its `civ.retention`
escape. Do **not** paste `packages/persistence/schema.sql`; it is a different,
older shape (bigserial ids, no season, FKs to an unpopulated `chunks` table)
and the server will not write against it.

The server also calls `migrate()` on boot and will create these itself against
an empty database. Running the DDL by hand is for the case where you want to
see it before the process does.

**2. The seeds.** A world is its imported places. `packages/client/public/world/`
already carries eight, committed, and they ship with both the client build and
the server image — genesis needs no import run. To add a place instead:

    npm run import -- --area <area-id>        # writes world/<chunk>.json + index.json

Then re-run the §41.2 admission suite for the new chunk before it goes near a
deploy, and author its hour in `CITY_HOUR` (§50.2) — an unauthored chunk
renders at schiedam's golden hour, which is a fallback, not a decision.

**3. The sim service.** One service, whichever shape:

    CHUNKS=all DATABASE_URL=postgres://…  npm run server      # the whole roster
    CHUNK=schiedam-havens DATABASE_URL=…  npm run server      # one chunk

`CHUNKS` is case-insensitive and wins over `CHUNK`. On Railway set
`DATABASE_URL` and `CHUNKS=all`, and leave `healthcheckTimeout` at the 300 in
`railway.json` — eight worlds take longer to construct than the 30s default,
and the listener binds before they do so `/health` answers `booting` with
per-chunk status throughout.

Boot is progressive and visible:

    curl -s https://<host>/health  | head -c 400     # booting -> ok, per chunk
    curl -s https://<host>/summary | head -c 400     # one object per chunk

**4. The client.** Vercel: build `npm run build -w @civ/client`, output
`packages/client/dist`. Point it at the sim with EITHER

  * `VITE_SERVER_URL=wss://<host>` — a bare origin is fine, the client
    completes it to `wss://<host>/ws/<chunkId>` itself; or
  * `packages/client/public/world/servers.json` — per-chunk urls, which is
    what a split-topology deploy would use.

**5. Verify before announcing.** In order, because each answer makes the next
question meaningful:

    curl -s https://<host>/health   # every chunk ready, durability postgres
    curl -s https://<host>/summary  # tick advancing between two calls
    node tools/watch/prodcheck.mjs  # what url the built bundle resolves, and
                                    # a real ws hello against it

Note the sandbox caveat recorded in `prodcheck.mjs`: headless Chromium here
cannot reach external hosts through the egress proxy (ERR_CONNECTION_RESET),
while curl and node can. A browser-based check failing in this environment is
not evidence about production.

**6. What genesis does not give you.** The world starts at season 1 on the
baseline, with no history — the scrub, the changelog and §40.2's timelapse
have nothing to show until events accumulate. Divergence begins at 0.0% and
the first structural change takes a few minutes of wall clock at the default
throughput. That is the world being new, not the deploy being broken.

## What is not built

**Resume.** A restart begins a new season rather than continuing the old one.
The durable log is a record, not a restore point — a snapshot is the §16.2 data
texture, not ownership, capital or parcels. Redeploys are therefore season
boundaries, which is coherent with §22.3 but worth knowing before you push on a
Friday.

**Cross-server migration.** Live servers do not move agents between processes;
migration exists in the region harness only. The §30.3 per-chunk-pair boundary
rule and any live migration transport are future mechanism decisions, not
half-shipped here.
