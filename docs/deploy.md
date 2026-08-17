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
