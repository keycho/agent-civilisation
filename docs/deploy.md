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

```
DATABASE_URL     the Supabase pooler string
CHUNK            schiedam-havens (which world this server runs; one server, one chunk)
THROUGHPUT       2 (normal). 0 pauses, 4 is surge.
RETAIN_SEASONS   4
RNG_SEED         any string; changing it changes the world's evolution
```

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
`wss://` url per chunk id instead, one Railway service each. Resolution order
per chunk is `?server=` override, then `servers.json`, then `VITE_SERVER_URL`.
The committed file carries local dev `ws://` entries, which an https page
skips automatically, so a single-chunk deployment can ignore it. The client
also checks the server's hello against the loaded chunk id and refuses the
socket on a mismatch ("wrong world"), so a misrouted url degrades to a
baseline view rather than painting another city's mutations onto this one.

`?server=wss://…` overrides it at runtime, which is the quickest way to point a
deployed client at a different world.

## What is not built

**Resume.** A restart begins a new season rather than continuing the old one.
The durable log is a record, not a restore point — a snapshot is the §16.2 data
texture, not ownership, capital or parcels. Redeploys are therefore season
boundaries, which is coherent with §22.3 but worth knowing before you push on a
Friday.

**Multi-chunk.** `CHUNK` selects which world to run and one server runs one.
