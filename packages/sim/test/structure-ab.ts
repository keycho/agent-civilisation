/**
 * §72.5: what structural capacity changed, as an a/b against identical seeds.
 *
 * §70.2's bar — baseline stock still standing and no further from its import
 * than a renovation — failed at 9.7% against a 40% floor, and the class
 * histogram named the cause: expanded 38.1% -> 73.0% while cleared fell
 * 31.3% -> 13.7%. §70 stopped agents spending capital on demolition and they
 * spent it on storeys instead.
 *
 * The before-arm restores the flat `agent_built ? 8 : 6` ceiling; the after-arm
 * runs era and construction type. Same seed, same budget, one process, so the
 * difference is the mechanism and nothing else.
 *
 * §70.2's rule stands over the result: if the grey still cannot hold 40 percent
 * with both clearing and expansion mechanically bounded, that is a finding
 * about the economy rather than a number to move.
 *
 *   node --no-warnings packages/sim/test/structure-ab.ts [chunk...] [budget]
 */
import { BOUNDARY, STRUCTURAL_CAPACITY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

const args = process.argv.slice(2)
const budget = Number(args.find((a) => /^\d+$/.test(a)) ?? DECISION_BUDGET)
const chunks = args.filter((a) => !/^\d+$/.test(a))
const CHUNKS = chunks.length ? chunks : ['schiedam-havens', 'london-deptford', 'brooklyn-redhook']

BOUNDARY.gate = true

/** §16.2's monotonic classes, by the numbers `divergenceCounts` is keyed on */
const CLASS_ORDER: Array<[string, number]> = [
  ['untouched', 0],
  ['owned', 1],
  ['renovated', 2],
  ['converted', 3],
  ['expanded', 4],
  ['cleared', 5],
  ['replaced', 6],
]

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

for (const chunk of CHUNKS) {
  console.log(`\n${chunk}  (${budget.toLocaleString()} decisions)`)
  for (const on of [false, true]) {
    STRUCTURAL_CAPACITY.on = on
    // a fresh parse per arm: a seed shared across arms is one accidental
    // mutation away from a false control
    const world = await loadSeed(chunk)
    const s = await runSeed(world, `seed-structure-${chunk}`, budget, false)
    const total = Object.values(s.divergenceCounts).reduce((a, b) => a + b, 0) || 1
    const classes = CLASS_ORDER.map(
      ([name, k]) => `${name} ${pct((s.divergenceCounts[k] ?? 0) / total)}`,
    ).join('  ')
    console.log(
      `  ${(on ? 'structure' : 'flat cap ').padEnd(10)} ` +
        `§73.3 grey ${pct(s.greyShare).padStart(6)}   ` +
        `standing ${pct(s.standingShare).padStart(6)}   ` +
        `touched ${pct(1 - s.untouchedShare).padStart(6)}   ` +
        `divergence ${pct(s.divergenceIndex).padStart(6)}`,
    )
    console.log(`             classes: ${classes}`)
    console.log(
      `             grey lost to: ${s.greyLost.gone} gone, ${s.greyLost.repurposed} repurposed, ` +
        `${s.greyLost.taller} more than half again as tall`,
    )
    console.log(
      `             floors added to inherited stock: ${s.expansion.levelsAdded} across ` +
        `${s.expansion.touched} buildings (mean ${s.expansion.meanAdded.toFixed(2)}, ` +
        `worst ${s.expansion.maxAdded})`,
    )
    if (on) {
      const fabric = Object.entries(s.structuralClasses)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join('  ')
      console.log(`             fabric: ${fabric}`)
    }
  }
}
