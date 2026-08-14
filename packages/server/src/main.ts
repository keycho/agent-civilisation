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
import { type WorldSeed, THROUGHPUT } from '@civ/core'
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
import { buildingDetail } from './frames.ts'
import { WorldService } from './world.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)
const CHUNK = process.env.CHUNK ?? 'schiedam-havens'
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL
const THROUGHPUT_INDEX = Number(process.env.THROUGHPUT ?? 2)
const SEED_PATH =
  process.env.SEED_PATH ??
  join(HERE, '..', '..', 'client', 'public', 'world', `${CHUNK}.json`)

const seed = JSON.parse(await readFile(SEED_PATH, 'utf8')) as WorldSeed
const world = new WorldService({
  seed,
  databaseUrl: DATABASE_URL,
  throughput: THROUGHPUT_INDEX,
  rngSeed: process.env.RNG_SEED ?? 'world-1',
})

console.log(`# ${seed.chunk.name}: ${seed.buildings.length} baseline buildings`)
console.log(`  store:      ${world.store.durability}${DATABASE_URL ? '' : ' (set DATABASE_URL for durability)'}`)
console.log(`  throughput: ${THROUGHPUT[THROUGHPUT_INDEX].label}`)
console.log(`  frames:     every ${FRAME_INTERVAL_MS} ms`)

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
        protocol: PROTOCOL_VERSION,
        chunk: world.chunkId,
        durability: world.store.durability,
        viewers: sockets.size,
        divergenceIndex: r.divergenceIndex,
        generation: r.generation,
        decisions: r.decisions,
        events: r.eventCount,
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

/** About a second of frames at normal throughput. */
const BACKPRESSURE_BYTES = 256 * 1024
const resyncing = new WeakSet<WebSocket>()

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
      if (!resyncing.has(ws)) {
        resyncing.add(ws)
        ws.send(encode(world.hello(sockets.size)), () => resyncing.delete(ws))
      }
      continue
    }
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
