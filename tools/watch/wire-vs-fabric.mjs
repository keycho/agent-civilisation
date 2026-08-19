/**
 * §68: do the positions on the WIRE stand on the buildings in the SEED?
 *
 * The browser harness can only reach a local server — this sandbox's chromium
 * has no route off the host — and the frame under diagnosis came from
 * production. This connects to a chunk server directly from node, which does
 * have a route, and checks the wire's own numbers against the committed seed:
 * for every agent and every open worksite, is there a baseline building
 * footprint where it is standing?
 *
 * The comparison needs no renderer and no camera. If the wire and the seed
 * agree here, any displacement is downstream of both.
 *
 *   node tools/watch/wire-vs-fabric.mjs [chunk] [wsBase]
 *
 * wsBase defaults to the local server; pass the production origin to check it.
 */
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'

const CHUNK = process.argv[2] ?? 'paris-ourcq'
const WS_BASE = process.argv[3] ?? 'ws://127.0.0.1:8820/ws'
const SEED_DIR = 'packages/client/public/world'

const seed = JSON.parse(await readFile(`${SEED_DIR}/${CHUNK}.json`, 'utf8'))

/**
 * The §66.3 built grid, rebuilt here from the same footprints the client
 * rasterises — 6 m cells, interiors by cell centre plus a walk along every
 * wall. Duplicated deliberately: the point of this harness is to check the
 * wire against the SEED without a browser in the loop, so it must not borrow
 * the browser's copy of the answer.
 */
const CELL = 6
let minX = Infinity
let minY = Infinity
let maxX = -Infinity
let maxY = -Infinity
for (const b of seed.buildings)
  for (const [x, y] of b.footprint) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
const cols = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1)
const rows = Math.max(1, Math.ceil((maxY - minY) / CELL) + 1)
const built = new Uint8Array(cols * rows)
const mark = (c, r) => {
  if (c >= 0 && r >= 0 && c < cols && r < rows) built[r * cols + c] = 1
}
function inRing(ring, x, y) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
for (const b of seed.buildings) {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [x, y] of b.footprint) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  for (let r = Math.floor((y0 - minY) / CELL); r <= Math.floor((y1 - minY) / CELL); r++) {
    for (let c = Math.floor((x0 - minX) / CELL); c <= Math.floor((x1 - minX) / CELL); c++) {
      if (inRing(b.footprint, minX + (c + 0.5) * CELL, minY + (r + 0.5) * CELL)) mark(c, r)
    }
  }
  for (let i = 0, j = b.footprint.length - 1; i < b.footprint.length; j = i++) {
    const [ax, ay] = b.footprint[j]
    const [bx, by] = b.footprint[i]
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL * 0.5)))
    for (let s = 0; s <= steps; s++) {
      mark(
        Math.floor((ax + ((bx - ax) * s) / steps - minX) / CELL),
        Math.floor((ay + ((by - ay) * s) / steps - minY) / CELL),
      )
    }
  }
}
const isBuilt = (x, y) => {
  const c = Math.floor((x - minX) / CELL)
  const r = Math.floor((y - minY) / CELL)
  return c >= 0 && r >= 0 && c < cols && r < rows && built[r * cols + c] === 1
}

const url = `${WS_BASE}/${CHUNK}`
console.log(`${CHUNK}  <-  ${url}`)
console.log(
  `  seed: ${seed.buildings.length} baseline buildings, footprints span ` +
    `x [${minX.toFixed(0)}, ${maxX.toFixed(0)}]  y [${minY.toFixed(0)}, ${maxY.toFixed(0)}]`,
)

const ws = new WebSocket(url)
const frames = []
let hello = null
const seenTypes = new Set()
const done = new Promise((resolve) => {
  ws.on('open', () => console.log('  socket open'))
  ws.on('close', (c, r) => console.log(`  socket closed ${c} ${String(r)}`))
  ws.on('unexpected-response', (_q, res) => console.log(`  unexpected response ${res.statusCode}`))
  ws.on('message', (raw) => {
    seenTypes.add(JSON.parse(String(raw)).t)
    const m = JSON.parse(String(raw))
    if (m.t === 'hello') hello = m
    if (m.t === 'frame') {
      frames.push(m)
      if (frames.length >= 3) resolve()
    }
  })
  ws.on('error', (e) => {
    console.log('  socket error:', e.message)
    resolve()
  })
  setTimeout(resolve, 45000)
})
await done
ws.close()

if (!frames.length) {
  console.log(`  no frames arrived (message types seen: ${[...seenTypes].join(', ') || 'none'})`)
  process.exit(1)
}
const f = frames[frames.length - 1]
const agents = f.agents ?? []
const sites = f.sites ?? f.construction ?? []
console.log(`  hello: ${hello ? `generation ${hello.generation ?? '·'}, tick ${hello.tick ?? '·'}` : 'none'}`)
console.log(`  frame keys: ${Object.keys(f).join(', ')}`)
if (!agents.length) console.log('  agents field empty; frame sample:', JSON.stringify(f).slice(0, 400))

const range = (list, k) =>
  list.length
    ? `[${Math.min(...list.map((a) => a[k])).toFixed(0)}, ${Math.max(...list.map((a) => a[k])).toFixed(0)}]`
    : 'n/a'

const share = (list, dx = 0, dy = 0) =>
  list.length ? list.filter((a) => isBuilt(a.x + dx, a.y + dy)).length / list.length : null

console.log(`  agents on the wire: ${agents.length}  x ${range(agents, 'x')}  y ${range(agents, 'y')}`)
const onBuilt = share(agents)
console.log(
  `  agents standing on a baseline footprint: ${onBuilt === null ? 'n/a' : `${(onBuilt * 100).toFixed(0)}%`}`,
)
// if a constant displacement were in play, some offset would beat zero
const sweep = []
for (const d of [-400, -300, -200, -100, -50, 50, 100, 200, 300, 400]) {
  sweep.push(`x${d >= 0 ? '+' : ''}${d}:${((share(agents, d, 0) ?? 0) * 100).toFixed(0)}%`)
  sweep.push(`y${d >= 0 ? '+' : ''}${d}:${((share(agents, 0, d) ?? 0) * 100).toFixed(0)}%`)
}
console.log(`  offset sweep (zero should win): ${sweep.join(' ')}`)
const flips = {
  '-x': agents.length ? agents.filter((a) => isBuilt(-a.x, a.y)).length / agents.length : 0,
  '-y': agents.length ? agents.filter((a) => isBuilt(a.x, -a.y)).length / agents.length : 0,
  swap: agents.length ? agents.filter((a) => isBuilt(a.y, a.x)).length / agents.length : 0,
}
console.log(
  `  mirrors: ${Object.entries(flips)
    .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
    .join(' ')}`,
)

/**
 * What the world has DONE to the fabric. If the agents and the seed agree
 * about where things are, the other way a city ends up as bare ground with
 * worksites on it is that the buildings have been cleared — which is the
 * product working, not a coordinate fault, and it is worth telling the two
 * apart before touching any transform.
 */
console.log(`  readouts: ${JSON.stringify(f.readouts)}`)
console.log(
  `  this frame: ${f.materialise?.length ?? 0} masses to generate, ` +
    `${f.events?.length ?? 0} events, ${f.roads?.length ?? 0} road updates, ` +
    `${f.retired?.length ?? 0} retired`,
)

/**
 * WHERE the standing buildings are.
 *
 * "The buildings sit in a corner behind a hard diagonal boundary" is a claim
 * about spatial distribution, and it has two possible causes: the geometry is
 * displaced, or the fabric outside that region has been demolished. The hello's
 * §16.2 data texture carries one texel per building with progress in `r`, and
 * building index is seed order, so the standing set can be laid back over the
 * footprints and looked at.
 */
if (hello?.buildingData) {
  const bytes = Buffer.from(hello.buildingData, 'base64')
  const centre = (b) => {
    let x = 0
    let y = 0
    for (const [px, py] of b.footprint) {
      x += px
      y += py
    }
    return [x / b.footprint.length, y / b.footprint.length]
  }
  let standing = 0
  let gone = 0
  const G = 6
  const grid = Array.from({ length: G * G }, () => ({ up: 0, down: 0 }))
  const span = { x: maxX - minX, y: maxY - minY }
  seed.buildings.forEach((b, i) => {
    const progress = bytes[i * 4] ?? 0
    const [cx, cy] = centre(b)
    const gx = Math.min(G - 1, Math.max(0, Math.floor(((cx - minX) / span.x) * G)))
    const gy = Math.min(G - 1, Math.max(0, Math.floor(((cy - minY) / span.y) * G)))
    const cell = grid[gy * G + gx]
    if (progress > 0) {
      standing++
      cell.up++
    } else {
      gone++
      cell.down++
    }
  })
  console.log(`  baseline standing: ${standing}/${seed.buildings.length}  cleared: ${gone}`)
  console.log('  standing share by cell (north row first, . = no baseline here):')
  for (let gy = G - 1; gy >= 0; gy--) {
    const row = []
    for (let gx = 0; gx < G; gx++) {
      const c = grid[gy * G + gx]
      const n = c.up + c.down
      row.push(n === 0 ? '  . ' : `${String(Math.round((c.up / n) * 100)).padStart(3)}%`)
    }
    console.log(`    ${row.join(' ')}`)
  }
}
