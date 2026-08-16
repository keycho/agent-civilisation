/**
 * §21.6: the sim server. Authoritative, single writer, owns the tick loop.
 *
 *   npm run server
 *   PORT=8080 DATABASE_URL=postgres://… npm run server
 *
 * Deployment shape:
 *
 *   railway    this process
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
import { buildingDetail } from './frames.ts'
import { WorldService } from './world.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)
const CHUNK = process.env.CHUNK ?? 'schiedam-havens'
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL
const THROUGHPUT_INDEX = Number(process.env.THROUGHPUT ?? 2)
/** §22.4: retention, decided now rather than at 150 million rows. */
const RETAIN_SEASONS = Number(process.env.RETAIN_SEASONS ?? 4)
const SEED_PATH =
  process.env.SEED_PATH ??
  join(HERE, '..', '..', 'client', 'public', 'world', `${CHUNK}.json`)

const STARTED = Date.now()

function nameCultureCheck(): { country: string; ok: boolean } {
  const country = seed.chunk.country ?? 'NL'
  const pool = NAME_POOLS[country] ?? NAME_POOLS.NL
  const firsts = new Set(pool.first)
  let sampled = 0
  let matched = 0
  for (const a of world.sim.world.agents.values()) {
    if (sampled >= 8) break
    sampled++
    if (firsts.has(a.name.split(' ')[0])) matched++
  }
  return { country, ok: sampled > 0 && matched === sampled }
}
const seed = JSON.parse(await readFile(SEED_PATH, 'utf8')) as WorldSeed

/**
 * §22.3: seasons. The world runs to a horizon rather than to a budget — when
 * the reachable stock saturates the season ends, the log stays queryable as
 * history, and a new one begins with a fresh rng seed on the same baseline.
 * The alternative is a continuous world whose last decades are agents trading a
 * finished city, and the reset is a product event rather than a failure.
 *
 * One store spans every season: the log is append-only across all of them and
 * each row carries the season it belongs to.
 */
const store = new DurableStore({
  url: DATABASE_URL,
  flushMs: Number(process.env.FLUSH_MS ?? 1000),
  maxConnections: Number(process.env.PG_MAX ?? 3),
})
const RNG_SEED = process.env.RNG_SEED ?? 'world'

let world = newSeason(1)

function newSeason(season: number): WorldService {
  return new WorldService({
    seed,
    store,
    throughput: THROUGHPUT_INDEX,
    season,
    rngSeed: `${RNG_SEED}-${season}`,
    onSaturated: (ended, reason) => {
      console.log(`\nseason ${ended} ended on ${reason}; turning over`)
      turnSeason(ended + 1)
    },
  })
}

/**
 * The turn itself. Everyone watching is told, then handed the new world — a
 * `hello` is exactly the message for "here is the world as it is now", which is
 * what a spectator needs at a season boundary as much as at a join.
 */
function turnSeason(next: number): void {
  world = newSeason(next)
  // §23.6, found by watching one: the new world starts with viewers at 0 and the
  // count is only re-stamped on connect and disconnect, so every spectator read
  // "0 watching" from the turn until somebody happened to join or leave. The
  // audience does not empty because the season did.
  world.viewers = sockets.size
  store.appendEvent({
    chunkId: world.chunkId,
    tick: 0,
    type: 'season_began',
    cinematicWeight: BASE_CINEMATIC_WEIGHT.season_began,
    rationale: `season ${next} begins on the same ground`,
    payload: { season: next },
  })
  for (const ws of sockets) send(ws, world.hello(sockets.size))
  void store
    .pruneSeasons(world.chunkId, RETAIN_SEASONS)
    .then((n) => {
      if (n.events || n.snapshots) {
        console.log(`  pruned ${n.events} events and ${n.snapshots} snapshots past ${RETAIN_SEASONS} seasons`)
      }
    })
    .catch((e) => console.error('[retention]', e))
}

console.log(`# ${seed.chunk.name}: ${seed.buildings.length} baseline buildings`)
console.log(`  store:      ${store.durability}${DATABASE_URL ? '' : ' (set DATABASE_URL for durability)'}`)
console.log(`  throughput: ${THROUGHPUT[THROUGHPUT_INDEX].label}`)
console.log(`  frames:     every ${FRAME_INTERVAL_MS} ms`)
console.log(`  flush:      every ${store.flushMs} ms (write-behind; see README)`)
console.log(`  retention:  ${RETAIN_SEASONS} seasons of events`)

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

const http = createServer((req, res) => {
  // A health endpoint Railway can read, and a human can too.
  if (req.url === '/health' || req.url === '/') {
    const r = world.readouts()
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(
      JSON.stringify({
        ok: true,
        /**
         * §35.6-1's durable fix, house-prediction style: the dutch-names-on-
         * deptford class was a stale PROCESS serving an old name pool while
         * the source was correct, caught only by eye. This asserts the
         * running artifact: the live world's spawned names are looked up
         * against the pool its chunk's country selects. False here means the
         * process is serving code older than its seed.
         */
        nameCulture: nameCultureCheck(),
        protocol: PROTOCOL_VERSION,
        chunk: world.chunkId,
        durability: store.durability,
        viewers: sockets.size,
        season: world.season,
        divergenceIndex: r.divergenceIndex,
        generation: r.generation,
        decisions: r.decisions,
        events: r.eventCount,
        // §22.4: the width of what a crash loses, and how far behind it is now
        flushMs: store.flushMs,
        lag: store.lag,
        retainSeasons: RETAIN_SEASONS,
        /** §23.4: how close the season is to turning on pressure rather than saturation */
        slotPressure: +world.texture.pressure.toFixed(3),
        /**
         * §22.4: "the tick loop is a long-running process and must not be
         * treated as a request handler." Nothing here can prove the host is
         * not suspending it between requests, but this makes it visible: if
         * `decisionsPerSecond` sits below `pace`, the loop is not running when
         * nobody is asking, and the deployment is wrong.
         */
        uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
        decisionsPerSecond: +(
          r.decisions / Math.max(1, (Date.now() - STARTED) / 1000)
        ).toFixed(1),
      }),
    )
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server: http })
const sockets = new Set<WebSocket>()

wss.on('connection', (ws) => {
  sockets.add(ws)
  world.viewers = sockets.size
  send(ws, world.hello(sockets.size))

  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return send(ws, { t: 'error', message: 'unparseable message' })
    }
    void handle(ws, msg)
  })
  const gone = () => {
    sockets.delete(ws)
    world.viewers = sockets.size
  }
  ws.on('close', gone)
  ws.on('error', gone)
})

async function handle(ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.t) {
    case 'ping':
      return
    case 'scrub': {
      // §21.6: "the client currently reads snapshots for the event scrub, which
      // becomes a server query rather than a memory read."
      const snap = await world.store.querySnapshot(world.chunkId, Math.max(0, msg.ordinal | 0))
      if (!snap) return send(ws, { t: 'error', message: 'no snapshot at or before that ordinal' })
      const result: ScrubResult = {
        t: 'scrub',
        ordinal: snap.ordinal,
        generation: snap.generation,
        divergenceIndex: snap.divergenceIndex,
        buildingData: toBase64(snap.buildingData),
        available: await world.store.queryOrdinals(world.chunkId),
      }
      return send(ws, result)
    }
    case 'inspect': {
      const history = await world.store.queryBuildingHistory(msg.buildingId, 14)
      const detail = buildingDetail(world.sim, msg.buildingId, history)
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
 * backpressure sends the largest message this server has to the client that is
 * already failing to keep up, and the naive form retries it every frame — an
 * underpowered viewer resyncs forever, and each attempt makes its buffer worse.
 *
 * So: at most one resync in flight, a widening gap between attempts, a cap, and
 * then a close with a reason. A viewer that cannot keep up is told so rather
 * than being held in a loop it cannot win.
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

  // The world advances on wall-clock time whether or not anyone is connected.
  void world.advance(dt)

  if (sockets.size === 0) {
    // Still fold state forward so a joining client sees the world as it is;
    // just do not compute a delta nobody will read.
    return
  }

  const frame = encode(world.nextFrame())
  for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) continue
    /**
     * Frames are deltas, so a slow viewer cannot simply be sent fewer of them —
     * a skipped delta is a texel that never gets its update and a building that
     * is wrong for the rest of the session. When a socket's buffer runs away,
     * the fix is to stop sending diffs and re-send the world: one `hello` costs
     * more bytes than one frame and less than the backlog it replaces, and it
     * lands the viewer on the current state exactly.
     */
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
      const h = healthOf(ws)
      if (h.inFlight || now < h.nextResyncAt) continue
      if (h.resyncs >= RESYNC_LIMIT) {
        ws.close(TOO_SLOW, 'connection cannot keep up with the world')
        sockets.delete(ws)
        world.viewers = sockets.size
        continue
      }
      h.inFlight = true
      h.nextResyncAt = now + RESYNC_BACKOFF_MS[Math.min(h.resyncs, RESYNC_BACKOFF_MS.length - 1)]
      h.resyncs++
      ws.send(encode(world.hello(sockets.size)), () => {
        h.inFlight = false
      })
      continue
    }
    // caught up: a viewer that recovers should not carry its strikes forever
    if (ws.bufferedAmount === 0) healthOf(ws).resyncs = 0
    ws.send(frame)
  }
}, FRAME_INTERVAL_MS)


http.listen(PORT, () => console.log(`\nlistening on :${PORT}  (ws://…/ and GET /health)`))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig}: draining the write-behind journal…`)
    void world.store.close().then(() => process.exit(0))
  })
}
