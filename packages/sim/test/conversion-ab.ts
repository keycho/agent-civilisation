/**
 * §74.5's prediction, run so it can be falsified.
 *
 * "Bounding conversion moves the grey above 40 percent in at least two of three
 * chunks. If it does not, the 40 percent floor is the thing that is wrong
 * rather than the economy, and it gets restated once against what a fully
 * bounded world produces — not moved to fit."
 *
 * Both arms have §70's funding gate and §72.5's structural capacity on, so the
 * only difference is whether conversion is bounded by form. That makes the
 * after-arm the FULLY BOUNDED world §74.5 wants the floor restated against, if
 * it comes to that.
 *
 *   node --no-warnings packages/sim/test/conversion-ab.ts [chunk...] [budget]
 */
import { BOUNDARY, CONVERSION } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

const args = process.argv.slice(2)
const budget = Number(args.find((a) => /^\d+$/.test(a)) ?? DECISION_BUDGET)
const chunks = args.filter((a) => !/^\d+$/.test(a))
const CHUNKS = chunks.length ? chunks : ['schiedam-havens', 'london-deptford', 'brooklyn-redhook']

/** §74.5's line, registered before the run */
const GREY_FLOOR = 0.4

BOUNDARY.gate = true

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const results: Array<{ chunk: string; before: number; after: number }> = []

for (const chunk of CHUNKS) {
  console.log(`\n${chunk}  (${budget.toLocaleString()} decisions)`)
  const arm: Record<string, number> = {}
  for (const on of [false, true]) {
    CONVERSION.on = on
    const world = await loadSeed(chunk)
    const s = await runSeed(world, `seed-conversion-${chunk}`, budget, false)
    arm[on ? 'after' : 'before'] = s.greyShare
    console.log(
      `  ${(on ? 'bounded  ' : 'unbounded').padEnd(10)} ` +
        `grey ${pct(s.greyShare).padStart(6)}   ` +
        `standing ${pct(s.standingShare).padStart(6)}   ` +
        `touched ${pct(1 - s.untouchedShare).padStart(6)}   ` +
        `divergence ${pct(s.divergenceIndex).padStart(6)}`,
    )
    console.log(
      `             grey lost to: ${s.greyLost.gone} gone, ${s.greyLost.repurposed} repurposed, ` +
        `${s.greyLost.taller} more than half again as tall`,
    )
    console.log(
      `             conversions applied: ${s.actionCounts.convert ?? 0}, ` +
        `expansions ${s.actionCounts.expand ?? 0}, demolitions ${s.actionCounts.demolish ?? 0}`,
    )
  }
  results.push({ chunk, before: arm.before, after: arm.after })
}

const cleared = results.filter((r) => r.after > GREY_FLOOR)
console.log(
  `\n§74.5 prediction — grey above ${pct(GREY_FLOOR)} in at least two of ${results.length}: ` +
    `${cleared.length}/${results.length} ${cleared.length >= 2 ? 'HELD' : 'FALSIFIED'}`,
)
for (const r of results) {
  console.log(
    `  ${r.chunk.padEnd(22)} ${pct(r.before)} -> ${pct(r.after)}  ` +
      `${r.after > GREY_FLOOR ? 'over' : 'under'} the floor`,
  )
}
if (cleared.length < 2) {
  console.log(
    `\n  §74.5's own reading of this outcome: the floor is what is wrong rather than the\n` +
      `  economy, and it gets restated once against what this fully bounded world produces.`,
  )
}
