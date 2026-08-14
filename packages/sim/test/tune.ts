/**
 * §4: "tune until a district of 400 buildings shows over 30 percent divergence
 * within 20 sim years. If it does not, the constants are wrong, not the code."
 * §14: "if the index stays under 10 percent at year 20, the area is too large
 * or capital is too scarce. Shrink the area before touching the code."
 *
 * This is the instrument for that. It runs the full 2026-2045 window headless
 * and prints the first-run targets, so tuning is measured rather than guessed.
 *
 *   node --no-warnings packages/sim/test/tune.ts [agentCount]
 */
import { DIVERGENCE_LABEL, type WorldSeed } from '@civ/core'
import { MemoryStore } from '@civ/persistence'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Simulation } from '../src/tick.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const seedPath = join(HERE, '..', '..', 'client', 'public', 'world', 'schiedam-havens.json')
const seed = JSON.parse(await readFile(seedPath, 'utf8')) as WorldSeed

const agentCount = Number(process.argv[2] ?? 58)
const store = new MemoryStore()

const milestones = new Map<number, string>()
const sim = new Simulation(seed, store, {
  agentCount,
  onYear(year, report) {
    const line =
      `${year}  index ${(report.index * 100).toFixed(1).padStart(5)}%  ` +
      `touched ${(report.touchedShare * 100).toFixed(1).padStart(5)}%  ` +
      `peak sector ${((report.peakSector?.index ?? 0) * 100).toFixed(1).padStart(5)}%  ` +
      `agent-built ${String(report.agentOrigin).padStart(3)}  ` +
      `cleared ${String(report.demolished).padStart(3)}  ` +
      `events ${store.eventCount()}`
    console.log(line)
    milestones.set(year, line)
  },
})

console.log(`# ${seed.chunk.name}: ${seed.buildings.length} baseline buildings, ${agentCount} agents`)
console.log(`# engine: ${sim.engine.name}, tick = 1 day, 2026 -> 2045\n`)
console.log('year  divergence      touched      peak district   agent-built  cleared  events')

const t0 = Date.now()
await sim.run(20 * 365)
const elapsed = (Date.now() - t0) / 1000

const r = sim.report
console.log(`\nran 7,300 ticks in ${elapsed.toFixed(1)}s (${Math.round(7300 / elapsed)} ticks/s)`)

console.log('\ndivergence classes across the baseline stock:')
for (const [cls, n] of Object.entries(r.counts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const pct = ((n / seed.buildings.length) * 100).toFixed(1)
  console.log(`  ${cls} ${DIVERGENCE_LABEL[Number(cls)].padEnd(16)} ${String(n).padStart(4)}  ${pct.padStart(5)}%`)
}

const counts = new Map<string, number>()
for (const e of store.events({ limit: 1e9 })) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
console.log('\nevents:')
for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(24)} ${n}`)
}

// §14's first-run targets, checked rather than asserted in prose
console.log('\n§14 first-run targets:')
check(2, milestones.has(2028), 'first acquisitions by year 2')
check(8, (r.demolished ?? 0) > 0, 'first demolition and replacement by year 8')
check(15, store.events({ types: ['road_built'] }).length > 0, 'first agent-built road by year 15')
check(15, store.events({ types: ['parcels_assembled'] }).length > 0, 'first assembled block by year 15')
check(20, r.index > 0.3, `divergence index over 30% at year 20 (got ${(r.index * 100).toFixed(1)}%)`)
check(
  20,
  (r.peakSector?.index ?? 0) > 0.45,
  `one district visibly unlike 2026 (peak sector ${((r.peakSector?.index ?? 0) * 100).toFixed(1)}%)`,
)

function check(year: number, ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  y${String(year).padStart(2)}  ${label}`)
}
