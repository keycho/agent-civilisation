/**
 * §20.9: "calibrate the budget once by finding the action count at which the
 * current build reaches its present end state, then freeze it and never tune it
 * again."
 *
 * §21.2 permits exactly one recalibration, because §21.1 added a mechanism the
 * model did not have rather than tuning a constant against an outcome. This is
 * that recalibration, and the rule below was written before the number was
 * read.
 *
 * The build-2 rule pointed at a prior end state — 34.6% divergence, 135
 * agent-built, 85 cleared — which the new model has no reason to reproduce and
 * which §21.1 explicitly disowns. So the end state is now defined by a property
 * of the run instead of by a remembered number: the point at which the world
 * stops changing materially. All three of the index, the agent-built count and
 * the cleared count must go quiet together, because a plateau in the index
 * alone can hide construction still finishing.
 *
 * It is not run by the test suite and must not be used to chase a target — read
 * the plateau, write the number down, stop.
 *
 *   node --no-warnings packages/sim/test/calibrate.ts [maxDecisions]
 */
import { SATURATION } from '../src/index.ts'
import { loadSeed, runSeed } from './lib/summarise.ts'

/**
 * Saturation: over a window this wide, gains fall below all three bounds.
 * §22.3: the constants live in `src/saturation.ts` because the live world uses
 * the same rule to end a season. One definition, two jobs — the budget is
 * derived from the rule, it does not govern the world.
 */
const { windowDecisions: WINDOW, indexGain: INDEX_GAIN, stockGrowth: STOCK_GROWTH } = SATURATION

const max = Number(process.argv[2] ?? 90_000)
const world = await loadSeed()

console.log(`# calibration: ${world.buildings.length} baseline buildings, one seed`)
console.log(`# running to ${max.toLocaleString()} decisions and reading the plateau\n`)

const t0 = Date.now()
const s = await runSeed(world, 'calibration', max, true)
const elapsed = (Date.now() - t0) / 1000

console.log('decisions   divergence   agent-built   cleared   gen')
for (const p of s.curve) {
  console.log(
    `${String(p.decisions).padStart(9)}   ${(p.index * 100).toFixed(1).padStart(9)}%   ` +
      `${String(p.agentOrigin).padStart(11)}   ${String(p.cleared).padStart(7)}   ${String(p.generation).padStart(3)}`,
  )
}

let plateau: number | null = null
for (const here of s.curve) {
  const later = s.curve.find((p) => p.decisions >= here.decisions + WINDOW)
  if (!later) break
  const grew = (a: number, b: number) => (b - a) / Math.max(1, a)
  if (
    later.index - here.index < INDEX_GAIN &&
    grew(here.agentOrigin, later.agentOrigin) < STOCK_GROWTH &&
    grew(here.cleared, later.cleared) < STOCK_GROWTH
  ) {
    plateau = here.decisions
    break
  }
}

console.log(
  `\nfinal: index ${(s.divergenceIndex * 100).toFixed(1)}%, ` +
    `touched ${(s.touchedShare * 100).toFixed(0)}%, ` +
    `${s.agentOrigin} agent-built, ${s.cleared} cleared, ` +
    `generation ${s.generation}, ${s.generationsCompleted} completed`,
)
console.log(
  `leverage: ${s.leverage.withDebt}/${s.leverage.agents} agents carrying debt, ` +
    `median debt ${s.leverage.medianDebt.toFixed(0)}, median cash ${s.leverage.medianCash.toFixed(0)}`,
)
console.log(`site-led acquisitions: ${s.siteLedAcquisitions}`)
console.log(`ran ${s.decisions.toLocaleString()} decisions over ${s.ticks.toLocaleString()} ticks in ${elapsed.toFixed(1)}s`)
console.log(
  plateau
    ? `\nplateau: index gains under ${INDEX_GAIN * 100}pp and stock growth under ` +
        `${STOCK_GROWTH * 100}% per ${WINDOW.toLocaleString()} decisions from ~${plateau.toLocaleString()}`
    : '\nno plateau within the range — the world is still changing',
)
console.log('\nwrite the plateau into DECISION_BUDGET in lib/summarise.ts and leave it alone.')
