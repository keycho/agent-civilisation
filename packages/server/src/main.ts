/**
 * §21.6: the sim server. Authoritative, single writer, owns the tick loop.
 *
 *   npm run server
 *   PORT=8080 DATABASE_URL=postgres://… npm run server
 *
 * §44.5 deploy shape (chosen: one service, one origin): the server can host
 * ONE chunk (CHUNK=schiedam-havens, the shape every local dev server uses)
 * or MANY (CHUNKS=all, or CHUNKS=a,b,c) — every hosted chunk ticks in this
 * one process behind one ws origin, routed by path:
 *
 *   wss://host/                 the sole chunk (single-chunk mode only)
 *   wss://host/ws/<chunkId>     that chunk (either mode)
 *   GET  /health                aggregate; per-chunk blocks inside
 *   GET  /summary               §27.3 summaries for every hosted chunk, one
 *                               fetch — the global view's poll
 *
 * One DurableStore spans all hosted chunks: every row is chunk-scoped
 * already, so eight worlds share a DATABASE_URL the way eight processes
 * would have. In-process rather than child processes is a chosen trade —
 * fate-sharing accepted for one deploy, one health surface, one bill; the
 * worlds have run for days without taking a process down, and isolation is
 * a later hardening if one ever does.
 *
 *   railway    this process (one service, whichever shape)
 *   supabase   DATABASE_URL — events append-only, snapshots on event ordinal
 *   vercel     the client, a pure observer with no simulation code in it
 *   transport  websocket, frames batched at ~10 Hz, client interpolates
 *
 * The world runs whether or not anyone is watching, which is the point: a
 * spectator platform is many viewers on one continuing world, not many copies
 * of the same seed running privately in tabs.
 */
import { BASE_CINEMATIC_WEIGHT, type WorldSeed, THROUGHPUT } from '@civ/core'
import { DurableStore } from '@civ/persistence'
import {
  type ClientMessage,
  FRAME_INTERVAL_MS,
  PROTOCOL_VERSION,
  type ScrubResult,
  type ServerMessage,
  encode,
  toBase64,
} from '@civ/protocol'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { NAME_POOLS } from '@civ/sim/names.ts'
import { fineSummaryOf } from '@civ/sim/region.ts'
import { buildingDetail } from './frames.ts'
import { WorldService } from './world.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_DIR = join(HERE, '..', '..', 'client', 'public', 'world')
const PORT = Number(process.env.PORT ?? 8787)
const THROUGHPUT_INDEX = Number(process.env.THROUGHPUT ?? 2)
/** §22.4: retention, decided now rather than at 150 million rows. */
const RETAIN_SEASONS = Number(process.env.RETAIN_SEASONS ?? 4)
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL
const RNG_SEED = process.env.RNG_SEED ?? 'world'

const STARTED = Date.now()

/** §44.5: which chunks this process hosts. CHUNKS wins; CHUNK is the
 * single-chunk shape every existing invocation uses. */
async function rosterIds(): Promise<string[]> {
  const index = JSON.parse(await readFile(join(WORLD_DIR, 'index.json'), 'utf8')) as {
    chunks: Array<{ id: string }>
  }
  return index.chunks.map((c) => c.id)
}

async function resolveChunkIds(): Promise<string[]> {
  const many = process.env.CHUNKS?.trim()
  // case-insensitive: the first production deploy set CHUNKS=ALL and the
  // strict comparison sent the literal down the comma-list path, so the
  // process tried to host a chunk named "ALL" and died on ALL.json
  if (many && many.toLowerCase() === 'all') return rosterIds()
  if (many) return many.split(',').map((s) => s.trim()).filter(Boolean)
  return [process.env.CHUNK ?? 'schiedam-havens']
}

/**
 * §22.3: seasons. The world runs to a horizon rather than to a budget — when
 * the reachable stock saturates the season ends, the log stays queryable as
 * history, and a new one begins with a fresh rng seed on the same baseline.
 *
 * One store spans every chunk and every season: the log is append-only
 * across all of them and each row carries its chunk and season.
 */
const store = new DurableStore({
  url: DATABASE_URL,
  flushMs: Number(process.env.FLUSH_MS ?? 1000),
  maxConnections: Number(process.env.PG_MAX ?? 3),
})

interface ChunkHost {
  id: string
  seed: WorldSeed
  world: WorldService
  sockets: Set<WebSocket>
}

const hosts = new Map<string, ChunkHost>()
const single = () => (hosts.size === 1 ? [...hosts.values()][0] : null)

function newSeason(host: Pick<ChunkHost, 'id' | 'seed'>, season: number): WorldService {
  return new WorldService({
    seed: host.seed,
    store,
    throughput: THROUGHPUT_INDEX,
    season,
    rngSeed: `${RNG_SEED}-${host.id}-${season}`,
    onSaturated: (ended, reason) => {
      console.log(`\n[${host.id}] season ${ended} ended on ${reason}; turning over`)
      turnSeason(host.id, ended + 1)
    },
  })
}

/**
 * The turn itself. Everyone watching is told, then handed the new world — a
 * `hello` is exactly the message for "here is the world as it is now".
 */
function turnSeason(id: string, next: number): void {
  const host = hosts.get(id)
  if (!host) return
  host.world = newSeason(host, next)
  // §23.6: the new world starts with viewers at 0 and the count is only
  // re-stamped on connect/disconnect — the audience does not empty because
  // the season did.
  host.world.viewers = host.sockets.size
  store.appendEvent({
    chunkId: host.world.chunkId,
    tick: 0,
    type: 'season_began',
    cinematicWeight: BASE_CINEMATIC_WEIGHT.season_began,
    rationale: `season ${next} begins on the same ground`,
    payload: { season: next },
  })
  for (const ws of host.sockets) send(ws, host.world.hello(host.sockets.size))
  void store
    .pruneSeasons(host.world.chunkId, RETAIN_SEASONS)
    .then((n) => {
      if (n.events || n.snapshots) {
        console.log(
          `  [${id}] pruned ${n.events} events and ${n.snapshots} snapshots past ${RETAIN_SEASONS} seasons`,
        )
      }
    })
    .catch((e) => console.error('[retention]', e))
}

/**
 * §44.5, hardened after the first production attempt: eight worlds take
 * longer to construct than a 30-second healthcheck, and the listener used to
 * bind only after the last one — so the deploy was killed while the boot was
 * healthy. The roster is resolved up front, the http server binds FIRST, and
 * /health answers 200 throughout with per-chunk boot status; chunks then
 * construct one at a time with an event-loop yield between them so the
 * healthcheck (and a human) can watch the boot instead of inferring it.
 */
const ROSTER = await resolveChunkIds()
const boot = { constructing: null as string | null, done: false }

async function constructHosts(): Promise<void> {
  for (const id of ROSTER) {
    boot.constructing = id
    const t0 = Date.now()
    const seedPath =
      hosts.size === 0 && process.env.SEED_PATH && !process.env.CHUNKS
        ? process.env.SEED_PATH
        : join(WORLD_DIR, `${id}.json`)
    let raw: string
    try {
      raw = await readFile(seedPath, 'utf8')
    } catch {
      // a typo'd chunk id should fail with the roster in hand, not a raw ENOENT
      throw new Error(
        `no seed for chunk '${id}' at ${seedPath}. ` +
          `CHUNKS=all (any case) hosts the full roster; known ids: ${(await rosterIds()).join(', ')}`,
      )
    }
    const seed = JSON.parse(raw) as WorldSeed
    const host: ChunkHost = { id, seed, world: null as unknown as WorldService, sockets: new Set() }
    host.world = newSeason(host, 1)
    hosts.set(id, host)
    console.log(
      `# ${seed.chunk.name}: ${seed.buildings.length} baseline buildings (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    )
    // let queued /health requests answer between constructions
    await new Promise((r) => setImmediate(r))
  }
  boot.constructing = null
  boot.done = true
  console.log(
    `boot complete: ${hosts.size} chunk${hosts.size === 1 ? '' : 's'} in ${((Date.now() - STARTED) / 1000).toFixed(1)}s`,
  )
  console.log(`  store:      ${store.durability}${DATABASE_URL ? '' : ' (set DATABASE_URL for durability)'}`)
  console.log(`  throughput: ${THROUGHPUT[THROUGHPUT_INDEX].label}`)
  console.log(`  frames:     every ${FRAME_INTERVAL_MS} ms`)
  console.log(`  flush:      every ${store.flushMs} ms (write-behind; see README)`)
  console.log(`  retention:  ${RETAIN_SEASONS} seasons of events`)
}

/**
 * §35.6-1's durable fix, house-prediction style: the dutch-names-on-deptford
 * class was a stale PROCESS serving an old name pool while the source was
 * correct, caught only by eye. This asserts the running artifact: the live
 * world's spawned names are looked up against the pool its chunk's country
 * selects. False here means the process is serving code older than its seed.
 */
function nameCultureCheck(host: ChunkHost): { country: string; ok: boolean } {
  const country = host.seed.chunk.country ?? 'NL'
  const pool = NAME_POOLS[country] ?? NAME_POOLS.NL
  const firsts = new Set(pool.first)
  let sampled = 0
  let matched = 0
  for (const a of host.world.sim.world.agents.values()) {
    if (sampled >= 8) break
    sampled++
    if (firsts.has(a.name.split(' ')[0])) matched++
  }
  return { country, ok: sampled > 0 && matched === sampled }
}

function healthOfChunk(host: ChunkHost): Record<string, unknown> {
  const r = host.world.readouts()
  return {
    nameCulture: nameCultureCheck(host),
    chunk: host.world.chunkId,
    viewers: host.sockets.size,
    season: host.world.season,
    divergenceIndex: r.divergenceIndex,
    generation: r.generation,
    decisions: r.decisions,
    events: r.eventCount,
    /** §23.4: how close the season is to turning on pressure rather than saturation */
    slotPressure: +host.world.texture.pressure.toFixed(3),
    /**
     * §22.4: "the tick loop is a long-running process and must not be
     * treated as a request handler." If decisionsPerSecond sits below pace,
     * the loop is not running when nobody is asking, and the deployment is
     * wrong.
     */
    decisionsPerSecond: +(r.decisions / Math.max(1, (Date.now() - STARTED) / 1000)).toFixed(1),
  }
}

/**
 * §27.3: the settlement summary, served from the same computation the region
 * harness reads (fineSummaryOf — "one dataset, computed once"). Identity and
 * fine body only: population and value tier live in the coarse layer the
 * client already has, joined there, so this endpoint cannot drift from the
 * artifact that owns those fields.
 */
function summaryOfChunk(host: ChunkHost): Record<string, unknown> {
  return {
    id: host.world.chunkId,
    country: host.seed.chunk.country ?? 'NL',
    materialised: true,
    tick: host.world.sim.world.tick,
    ...fineSummaryOf(host.world.sim.world),
  }
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

const JSON_HEAD = { 'content-type': 'application/json', 'access-control-allow-origin': '*' }

const http = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  // A health endpoint Railway can read, and a human can too. Single-chunk
  // mode keeps the flat shape every existing probe reads; multi-chunk nests
  // one block per hosted chunk under the shared process facts.
  if (path === '/health' || path === '/') {
    const shared = {
      ok: true,
      protocol: PROTOCOL_VERSION,
      durability: store.durability,
      // §22.4: the width of what a crash loses, and how far behind it is now
      flushMs: store.flushMs,
      lag: store.lag,
      retainSeasons: RETAIN_SEASONS,
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
    }
    res.writeHead(200, JSON_HEAD)
    if (!boot.done) {
      // 200 while booting on purpose: the deploy is healthy, just not done —
      // and the status shows exactly where the boot is
      res.end(
        JSON.stringify({
          ...shared,
          booting: {
            constructing: boot.constructing,
            ready: [...hosts.keys()],
            pending: ROSTER.filter((id) => !hosts.has(id) && id !== boot.constructing),
          },
        }),
      )
      return
    }
    const one = single()
    res.end(
      JSON.stringify(
        one
          ? { ...shared, ...healthOfChunk(one) }
          : {
              ...shared,
              chunks: Object.fromEntries([...hosts.values()].map((h) => [h.id, healthOfChunk(h)])),
            },
      ),
    )
    return
  }
  if (path.startsWith('/health/')) {
    const host = hosts.get(path.slice('/health/'.length))
    if (!host) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, JSON_HEAD)
    res.end(JSON.stringify({ ok: true, ...healthOfChunk(host) }))
    return
  }
  // §27.3/§44.5: every hosted chunk's summary in one fetch — the global
  // view's poll. Always an array, in either mode.
  if (path === '/summary') {
    res.writeHead(200, JSON_HEAD)
    res.end(JSON.stringify([...hosts.values()].map((h) => summaryOfChunk(h))))
    return
  }
  if (path.startsWith('/summary/')) {
    const id = path.slice('/summary/'.length)
    const host = hosts.get(id)
    if (!host) {
      // still constructing = try again shortly; unknown = not a chunk here
      res.writeHead(!boot.done && ROSTER.includes(id) ? 503 : 404).end()
      return
    }
    res.writeHead(200, JSON_HEAD)
    res.end(JSON.stringify(summaryOfChunk(host)))
    return
  }
  res.writeHead(404).end()
})

/**
 * §44.5: one ws origin, path-routed. `/ws/<chunkId>` reaches that chunk in
 * either mode; bare `/` reaches the sole chunk in single-chunk mode (the
 * shape every existing local url uses). The client needs no changes — its
 * hello already carries the chunk id and the wrong-world guard refuses a
 * mismatch, so a bad path degrades exactly like a misrouted url.
 */
const wss = new WebSocketServer({ noServer: true })

http.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '/').split('?')[0]
  let requested: string | null = null
  if (path.startsWith('/ws/')) requested = path.slice('/ws/'.length)
  else if (path === '/' || path === '') requested = ROSTER.length === 1 ? ROSTER[0] : null
  const host = requested ? hosts.get(requested) ?? null : null
  if (!host) {
    // a chunk still constructing gets "try again later", not "not found"
    const pending = !boot.done && requested !== null && ROSTER.includes(requested)
    socket.write(pending ? 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 10\r\n\r\n' : 'HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const target = host
  wss.handleUpgrade(req, socket, head, (ws) => {
    connect(target, ws)
  })
})

function connect(host: ChunkHost, ws: WebSocket): void {
  host.sockets.add(ws)
  host.world.viewers = host.sockets.size
  send(ws, host.world.hello(host.sockets.size))

  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return send(ws, { t: 'error', message: 'unparseable message' })
    }
    void handle(host, ws, msg)
  })
  const gone = () => {
    host.sockets.delete(ws)
    host.world.viewers = host.sockets.size
  }
  ws.on('close', gone)
  ws.on('error', gone)
}

async function handle(host: ChunkHost, ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.t) {
    case 'ping':
      return
    case 'scrub': {
      // §21.6: "the client currently reads snapshots for the event scrub,
      // which becomes a server query rather than a memory read."
      const snap = await host.world.store.querySnapshot(
        host.world.chunkId,
        Math.max(0, msg.ordinal | 0),
      )
      if (!snap) return send(ws, { t: 'error', message: 'no snapshot at or before that ordinal' })
      const result: ScrubResult = {
        t: 'scrub',
        ordinal: snap.ordinal,
        generation: snap.generation,
        divergenceIndex: snap.divergenceIndex,
        buildingData: toBase64(snap.buildingData),
        available: await host.world.store.queryOrdinals(host.world.chunkId),
      }
      return send(ws, result)
    }
    case 'inspect': {
      const history = await host.world.store.queryBuildingHistory(msg.buildingId, 14)
      const detail = buildingDetail(host.world.sim, msg.buildingId, history)
      return send(
        ws,
        detail
          ? { t: 'building', ...detail }
          : { t: 'building', id: msg.buildingId, found: false, lineage: [], history: [] },
      )
    }
  }
}

function send(ws: WebSocket, m: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(encode(m))
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

/**
 * §22.4's first exposure. Falling back to a full `hello` under send
 * backpressure sends the largest message this server has to the client that
 * is already failing to keep up, and the naive form retries it every frame.
 * So: at most one resync in flight, a widening gap between attempts, a cap,
 * and then a close with a reason.
 */
const BACKPRESSURE_BYTES = 256 * 1024
const RESYNC_LIMIT = 3
const RESYNC_BACKOFF_MS = [2_000, 8_000, 20_000]
/** 1013 is "try again later" — the right thing for a viewer, not a fault. */
const TOO_SLOW = 1013

interface Health {
  resyncs: number
  nextResyncAt: number
  inFlight: boolean
}
const health = new WeakMap<WebSocket, Health>()

function healthOf(ws: WebSocket): Health {
  let h = health.get(ws)
  if (!h) {
    h = { resyncs: 0, nextResyncAt: 0, inFlight: false }
    health.set(ws, h)
  }
  return h
}

let last = Date.now()

setInterval(() => {
  const now = Date.now()
  const dt = Math.min(0.5, (now - last) / 1000)
  last = now

  for (const host of hosts.values()) {
    // The world advances on wall-clock time whether or not anyone is connected.
    void host.world.advance(dt)

    if (host.sockets.size === 0) {
      // Still fold state forward so a joining client sees the world as it
      // is; just do not compute a delta nobody will read.
      continue
    }

    const frame = encode(host.world.nextFrame())
    for (const ws of host.sockets) {
      if (ws.readyState !== ws.OPEN) continue
      /**
       * Frames are deltas, so a slow viewer cannot simply be sent fewer of
       * them — a skipped delta is a texel that never gets its update. When a
       * socket's buffer runs away, stop sending diffs and re-send the world:
       * one `hello` costs more bytes than one frame and less than the
       * backlog it replaces.
       */
      if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
        const h = healthOf(ws)
        if (h.inFlight || now < h.nextResyncAt) continue
        if (h.resyncs >= RESYNC_LIMIT) {
          ws.close(TOO_SLOW, 'connection cannot keep up with the world')
          host.sockets.delete(ws)
          host.world.viewers = host.sockets.size
          continue
        }
        h.inFlight = true
        h.nextResyncAt = now + RESYNC_BACKOFF_MS[Math.min(h.resyncs, RESYNC_BACKOFF_MS.length - 1)]
        h.resyncs++
        ws.send(encode(host.world.hello(host.sockets.size)), () => {
          h.inFlight = false
        })
        continue
      }
      // caught up: a viewer that recovers should not carry its strikes forever
      if (ws.bufferedAmount === 0) healthOf(ws).resyncs = 0
      ws.send(frame)
    }
  }
}, FRAME_INTERVAL_MS)

// bind before constructing anything: the healthcheck must be able to watch
// the boot rather than time out behind it
http.listen(PORT, () =>
  console.log(
    `listening on :${PORT}  (${ROSTER.length} chunk${ROSTER.length === 1 ? '' : 's'} booting: ` +
      `${ROSTER.join(', ')}; ws on /ws/<chunk>${ROSTER.length === 1 ? ' and /' : ''}, GET /health, /summary)`,
  ),
)

// registered before the boot loop so a mid-boot SIGTERM still drains
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig}: draining the write-behind journal…`)
    void store.close().then(() => process.exit(0))
  })
}

await constructHosts()
