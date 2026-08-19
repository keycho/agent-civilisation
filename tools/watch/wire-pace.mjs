/**
 * §71: what the production wire is ACTUALLY doing, per second.
 *
 * /health's `decisionsPerSecond` is decisions-since-boot over uptime-since-boot
 * — a lifetime average whose numerator resets on every season turn, so a chunk
 * that has just turned reads slow and a chunk that has not reads true. This
 * reads the wire instead: frames, ticks, decisions per STEP, and how long the
 * server takes to drive one building slot from 0 to 255. That last one is the
 * quantity §57.2's wall-clock floors are a floor ON — a build the server
 * finishes faster than the client's floor is a build the picture cannot show
 * whole, and the floor stops being a minimum and becomes a lag.
 *
 *   node tools/watch/wire-pace.mjs [chunk] [seconds]
 */
import WebSocket from 'ws'
const chunk = process.argv[2] ?? 'london-deptford'
const SECS = Number(process.argv[3] ?? 90)
const HOST = process.env.CIV_WIRE ?? 'wss://agent-civilisation-production.up.railway.app'
const ws = new WebSocket(`${HOST}/ws/${chunk}`)
const t0 = Date.now()
let frames = 0, texels = 0, events = 0
const state = new Map()   // slot -> {p, startedMs, reversals, dir}
const builds = [], demos = []
let reversals = 0, concurrent = 0, maxConcurrent = 0
ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString()) } catch { return }
  if (m.t !== 'frame') return
  frames++
  const now = Date.now()
  events += m.events?.length ?? 0
  const tx = m.texels ?? []
  for (let i = 0; i + 4 < tx.length; i += 5) {
    texels++
    const slot = tx[i], p = tx[i + 1]
    const s = state.get(slot)
    if (!s) { state.set(slot, { p, startedMs: now, dir: 0, from: p }); continue }
    if (p === s.p) continue
    const dir = p > s.p ? 1 : -1
    if (s.dir !== 0 && dir !== s.dir) reversals++
    // a run that reaches an end stop is a completed visible change
    if (dir === 1 && p >= 255 && s.dir === 1) { builds.push((now - s.startedMs) / 1000); s.startedMs = now; s.dir = 0; s.p = p; continue }
    if (dir === -1 && p <= 0 && s.dir === -1) { demos.push((now - s.startedMs) / 1000); s.startedMs = now; s.dir = 0; s.p = p; continue }
    if (s.dir !== dir) { s.startedMs = now; s.from = s.p }
    s.dir = dir; s.p = p
  }
  const active = [...state.values()].filter((s) => s.dir !== 0).length
  concurrent += active; maxConcurrent = Math.max(maxConcurrent, active)
})
ws.on('error', (e) => console.log('ERR', e.message))
const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)].toFixed(1) : 'n/a')
setTimeout(() => {
  const s = (Date.now() - t0) / 1000
  console.log(`${chunk} over ${s.toFixed(0)}s — server-side visible change, against §57.2's floors`)
  console.log(`  frames ${frames} (${(frames / s).toFixed(1)}/s), texel writes ${(texels / s).toFixed(0)}/s, events ${(events / s).toFixed(1)}/s`)
  console.log(`  builds run to completion on the wire: n=${builds.length} p10 ${q(builds, 0.1)}s p50 ${q(builds, 0.5)}s p90 ${q(builds, 0.9)}s   (§57.2 floor 23s)`)
  console.log(`  demolitions: n=${demos.length} p50 ${q(demos, 0.5)}s   (§57.2 floor 6.5s)`)
  console.log(`  direction reversals mid-run: ${reversals}`)
  console.log(`  slots in motion at once: mean ${(concurrent / Math.max(1, frames)).toFixed(1)}, max ${maxConcurrent}`)
  ws.close(); process.exit(0)
}, SECS * 1000)
