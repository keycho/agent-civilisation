/**
 * §70: what the funded-plan gate changed, as an a/b against identical seeds.
 *
 * Before-arm and after-arm run in one process with the same seed and the same
 * decision budget, so the difference is the gate and nothing else — the §58.2
 * pattern. A number remembered from another tree is not a control.
 *
 *   node --no-warnings packages/sim/test/funded-plan-ab.ts [chunk...] [budget]
 */
import { BOUNDARY, FUNDED_PLAN } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

const args = process.argv.slice(2)
const budget = Number(args.find((a) => /^\d+$/.test(a)) ?? DECISION_BUDGET)
const chunks = args.filter((a) => !/^\d+$/.test(a))
const CHUNKS = chunks.length ? chunks : ['schiedam-havens', 'london-deptford', 'brooklyn-redhook']

BOUNDARY.gate = true

const rows: Array<{
  chunk: string
  arm: string
  holes: number
  standing: number
  ratio: number
  cleared: number
  built: number
  diff: number
  touched: number
}> = []

for (const chunk of CHUNKS) {
  for (const on of [false, true]) {
    FUNDED_PLAN.on = on
    // a fresh parse per arm: runSeed mutates nothing it is given, but a seed
    // shared across arms is one accidental mutation away from a false control
    const world = await loadSeed(chunk)
    const s = await runSeed(world, `seed-funded-${chunk}`, budget, false)
    rows.push({
      chunk,
      arm: on ? 'funded' : 'control',
      holes: s.clearedUnbuiltShare,
      standing: s.standingShare,
      ratio: s.clearToBuild,
      cleared: s.eventCounts.demolition_completed ?? 0,
      built: s.eventCounts.construction_completed ?? 0,
      diff: s.divergenceIndex,
      touched: s.touchedShare,
    })
    console.log(
      `${chunk.padEnd(20)} ${(on ? 'funded ' : 'control')}  ` +
        `holes ${(s.clearedUnbuiltShare * 100).toFixed(1)}%  ` +
        `standing ${(s.standingShare * 100).toFixed(1)}%  ` +
        `clear:build ${s.clearToBuild.toFixed(2)}:1  ` +
        `(${s.eventCounts.demolition_completed ?? 0} cleared, ${s.eventCounts.construction_completed ?? 0} built)  ` +
        `diff ${(s.divergenceIndex * 100).toFixed(1)}%  touched ${(s.touchedShare * 100).toFixed(1)}%`,
    )
  }
}
FUNDED_PLAN.on = true

console.log('\n§70 a/b — the gate is the only difference between the arms')
for (const chunk of CHUNKS) {
  const a = rows.find((r) => r.chunk === chunk && r.arm === 'control')
  const b = rows.find((r) => r.chunk === chunk && r.arm === 'funded')
  if (!a || !b) continue
  console.log(
    `  ${chunk.padEnd(20)} holes ${(a.holes * 100).toFixed(1)}% -> ${(b.holes * 100).toFixed(1)}%  ` +
      `standing ${(a.standing * 100).toFixed(1)}% -> ${(b.standing * 100).toFixed(1)}%  ` +
      `ratio ${a.ratio.toFixed(2)} -> ${b.ratio.toFixed(2)}  ` +
      `diff ${(a.diff * 100).toFixed(1)}% -> ${(b.diff * 100).toFixed(1)}%`,
  )
}
console.log(JSON.stringify(rows))
