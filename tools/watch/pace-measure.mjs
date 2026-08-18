/**
 * §57.1: measure the pace before setting it.
 *
 * Connects to a live server as a spectator and times the visual events a human
 * is supposed to be able to watch — construction from started to completed,
 * demolition from started to completed — in WALL CLOCK, which is the only unit
 * §57.1's targets are written in. Also counts how many events per second reach
 * the feed, chunk-wide, which is the third target.
 *
 * A construction that begins before the probe attaches cannot be timed, so
 * only pairs where BOTH ends were observed are reported, and the count of
 * unpaired completions is printed rather than hidden — with a fast world and a
 * short window, the unpaired ones are the majority and that itself is a
 * finding.
 *
 *   node tools/watch/pace-measure.mjs <wss-base> <seconds> [chunk ...]
 */
import { WebSocket } from 'ws'
import { isDrama } from '@civ/core'

const BASE = process.argv[2] ?? 'wss://agent-civilisation-production.up.railway.app'
const SECONDS = Number(process.argv[3] ?? 180)
const CHUNKS = process.argv.slice(4).length
  ? process.argv.slice(4)
  : ['brooklyn-redhook', 'maasland-dorp', 'schiedam-havens']

const PAIRS = [
  ['construction_started', 'construction_completed'],
  ['demolition_started', 'demolition_completed'],
]

function keyOf(e) {
  return e.buildingId ?? `${e.agentId}@${e.x},${e.y}`
}

async function watch(chunk) {
  const url = `${BASE}/ws/${chunk}`
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const open = new Map()
    const durations = new Map(PAIRS.map(([s]) => [s, []]))
    const unpaired = new Map(PAIRS.map(([s]) => [s, 0]))
    let events = 0
    let notable = 0
    let drama = 0
    const weights = []
    const byType = new Map()
    let firstAt = 0
    let lastOrdinal = 0
    let firstOrdinal = 0
    let hello = null
    const started = Date.now()

    const done = () => {
      try {
        ws.close()
      } catch {
        /* already gone */
      }
      const elapsed = (Date.now() - started) / 1000
      resolve({
        chunk,
        elapsed,
        hello,
        events,
        notable,
        eventsPerSecond: events / elapsed,
        notablePerSecond: notable / elapsed,
        drama,
        dramaPerSecond: drama / elapsed,
        ordinalsAdvanced: lastOrdinal - firstOrdinal,
        durations: Object.fromEntries([...durations].map(([k, v]) => [k, v])),
        weights,
        byType: [...byType].sort((a, b) => b[1] - a[1]),
        unpaired: Object.fromEntries(unpaired),
      })
    }

    ws.on('error', (e) => {
      resolve({ chunk, error: String(e.message ?? e) })
    })
    ws.on('message', (raw) => {
      let m
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.t === 'hello') {
        hello = { pace: m.readouts?.pace, generation: m.readouts?.generation, season: m.readouts?.season }
        return
      }
      if (m.t !== 'frame') return
      const now = Date.now()
      for (const e of m.events ?? []) {
        events++
        if (!firstAt) firstAt = now
        if (!firstOrdinal) firstOrdinal = e.id
        lastOrdinal = Math.max(lastOrdinal, e.id)
        // §60's own definition of notable, used here so the count means the
        // same thing the feed will mean by it
        if ((e.cinematicWeight ?? 0) >= 20) notable++
        // §60(d): what the DEFAULT feed will actually admit, using the shipped rule
        if (isDrama(e.type, e.cinematicWeight ?? 0)) drama++
        const w = e.cinematicWeight ?? 0
        weights.push(w)
        byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
        for (const [startType, endType] of PAIRS) {
          if (e.type === startType) open.set(`${startType}|${keyOf(e)}`, now)
          else if (e.type === endType) {
            const k = `${startType}|${keyOf(e)}`
            const at = open.get(k)
            if (at === undefined) unpaired.set(startType, unpaired.get(startType) + 1)
            else {
              durations.get(startType).push((now - at) / 1000)
              open.delete(k)
            }
          }
        }
      }
    })
    setTimeout(done, SECONDS * 1000)
  })
}

const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null)
const f = (v) => (v === null ? '  —  ' : v.toFixed(1).padStart(5))

console.log(`§57.1 pace measurement — ${BASE}, ${SECONDS}s per chunk, ${CHUNKS.length} chunks`)
const results = await Promise.all(CHUNKS.map(watch))
for (const r of results) {
  if (r.error) {
    console.log(`${r.chunk.padEnd(20)} ERROR ${r.error}`)
    continue
  }
  const paceLabel = r.hello?.pace ? `${r.hello.pace.label} (${r.hello.pace.decisionsPerSecond}/s target)` : '?'
  console.log(
    `\n${r.chunk}  configured pace: ${paceLabel}  gen ${r.hello?.generation ?? '?'} season ${r.hello?.season ?? '?'}`,
  )
  console.log(
    `  events ${r.events} over ${r.elapsed.toFixed(0)}s = ${r.eventsPerSecond.toFixed(2)}/s` +
      `   old intake (w>=20) ${r.notablePerSecond.toFixed(2)}/s   §60d drama intake ${r.dramaPerSecond.toFixed(2)}/s   ordinals +${r.ordinalsAdvanced}`,
  )
  const w = r.weights ?? []
  if (w.length) {
    const cut = (t) => ((w.filter((x) => x >= t).length / w.length) * 100).toFixed(0)
    console.log(
      `  weight distribution: >=10 ${cut(10)}%  >=20 ${cut(20)}%  >=30 ${cut(30)}%  ` +
        `>=50 ${cut(50)}%  >=70 ${cut(70)}%  >=90 ${cut(90)}%   max ${Math.max(...w)}`,
    )
    console.log(
      '  by type: ' +
        (r.byType ?? []).slice(0, 8).map(([t, n]) => `${t} ${((n / w.length) * 100).toFixed(0)}%`).join('  '),
    )
  }
  for (const [startType] of PAIRS) {
    const d = r.durations[startType] ?? []
    console.log(
      `  ${startType.replace('_started', '').padEnd(12)} n=${String(d.length).padStart(3)}` +
        `  p10=${f(q(d, 0.1))}s  median=${f(q(d, 0.5))}s  p90=${f(q(d, 0.9))}s` +
        `  (unpaired completions: ${r.unpaired[startType]})`,
    )
  }
}
