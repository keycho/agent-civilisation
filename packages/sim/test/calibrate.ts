/**
 * §20.9: "calibrate the budget once by finding the action count at which the
 * current build reaches its present end state, then freeze it and never tune it
 * again."
 *
 * This is that calibration, kept so the number in DECISION_BUDGET is
 * reproducible and its provenance is visible. It prints the divergence curve
 * against cumulative decisions (§20.7's x axis) and reports where the curve
 * flattens. It is not run by the test suite and must not be used to chase a
 * target — read the plateau, write the number down, stop.
 *
 *   node --no-warnings packages/sim/test/calibrate.ts [maxDecisions]
 */
import { loadSeed, runSeed } from './lib/summarise.ts'

const max = Number(process.argv[2] ?? 60_000)
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

// §20.9's definition: the decision count at which the build reaches the end
// state it already had before the calendar was removed.
const PRIOR_END_STATE = { index: 0.346, agentOrigin: 135, cleared: 85 }
const match = s.curve.find(
  (p) =>
    p.index >= PRIOR_END_STATE.index &&
    p.agentOrigin >= PRIOR_END_STATE.agentOrigin &&
    p.cleared >= PRIOR_END_STATE.cleared,
)
console.log(
  match
    ? `\nprior end state (34.6% / 135 agent-built / 85 cleared) first reached at ${match.decisions.toLocaleString()} decisions`
    : '\nprior end state not reached within the range',
)

// where does it flatten? report the first point past which the index gains
// less than 1 percentage point over the following 5,000 decisions
const PLATEAU_GAIN = 0.01
const PLATEAU_WINDOW = 5000
let plateau: number | null = null
for (let i = 0; i < s.curve.length; i++) {
  const here = s.curve[i]
  const later = s.curve.find((p) => p.decisions >= here.decisions + PLATEAU_WINDOW)
  if (!later) break
  if (later.index - here.index < PLATEAU_GAIN) {
    plateau = here.decisions
    break
  }
}

console.log(`\nfinal: index ${(s.divergenceIndex * 100).toFixed(1)}%, ` +
  `${s.agentOrigin} agent-built, ${s.cleared} cleared, ` +
  `generation ${s.generation}, ${s.generationsCompleted} completed`)
console.log(`ran ${s.decisions.toLocaleString()} decisions over ${s.ticks.toLocaleString()} ticks in ${elapsed.toFixed(1)}s`)
console.log(
  plateau
    ? `\nplateau: gains fall below ${PLATEAU_GAIN * 100}pp per ${PLATEAU_WINDOW.toLocaleString()} decisions at ~${plateau.toLocaleString()}`
    : '\nno plateau within the range — the curve is still climbing',
)
console.log('\nwrite the plateau into DECISION_BUDGET in lib/summarise.ts and leave it alone.')
