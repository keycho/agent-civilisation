/**
 * §20.9: "calibrate the budget once by finding the action count at which the
 * current build reaches its present end state, then freeze it and never tune it
 * again."
 *
 * §21.2 permitted one recalibration for the §21.1 mechanism; §29.3 permits a
 * second because the CRITERION was at fault, not the number: "the index
 * plateaus long after the world is used up, so calibrating on the plateau
 * guarantees an over-run world." The plateau rule measured when the aggregate
 * went quiet; agents spend the last quarter of such a budget re-treading stock
 * they have already been over, which is what pushed the touched share to 96%
 * against an 80% ceiling and washed the untouched correlations out to noise.
 *
 * So the budget now reads off the touched share, and the rule — written before
 * the number, §29.3's discipline as ever — is:
 *
 *   the decision count at which the touched share crosses 80%,
 *   the ceiling §21.1 set from what real cities do not do
 *
 * ("real cities do not redevelop 91% of their stock in five generations").
 * The plateau detector stays in the output as a diagnostic, because the gap
 * between the two numbers is the re-treading and worth seeing.
 *
 * §29.3 also names the expectation that this concept retires at multi-chunk —
 * a world where saturation produces migration needs no budget, and the budget
 * survives only as the harness's unit.
 *
 * It is not run by the test suite and must not be used to chase a target — read
 * the crossing, write the number down, stop.
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

console.log('decisions   divergence   touched   agent-built   cleared   gen')
for (const p of s.curve) {
  console.log(
    `${String(p.decisions).padStart(9)}   ${(p.index * 100).toFixed(1).padStart(9)}%   ` +
      `${(p.touched * 100).toFixed(0).padStart(6)}%   ` +
      `${String(p.agentOrigin).padStart(11)}   ${String(p.cleared).padStart(7)}   ${String(p.generation).padStart(3)}`,
  )
}

/**
 * §29.3's criterion: the crossing of the touched-share ceiling, interpolated
 * between the two snapshots that straddle it.
 */
const CEILING = 0.8
let crossing: number | null = null
for (let i = 1; i < s.curve.length; i++) {
  const a = s.curve[i - 1]
  const b = s.curve[i]
  if (a.touched < CEILING && b.touched >= CEILING) {
    const f = (CEILING - a.touched) / Math.max(1e-9, b.touched - a.touched)
    crossing = Math.round(a.decisions + f * (b.decisions - a.decisions))
    break
  }
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
    `generation ${s.generation} (deepest ${s.deepestLineage}), ${s.livesCompleted} lives completed`,
)
console.log(
  `leverage: ${s.leverage.withDebt}/${s.leverage.agents} agents carrying debt, ` +
    `median debt ${s.leverage.medianDebt.toFixed(0)}, median cash ${s.leverage.medianCash.toFixed(0)}`,
)
console.log(`site-led acquisitions: ${s.siteLedAcquisitions}`)
console.log(`ran ${s.decisions.toLocaleString()} decisions over ${s.ticks.toLocaleString()} ticks in ${elapsed.toFixed(1)}s`)
console.log(
  crossing
    ? `\ntouched share crosses ${CEILING * 100}% at ~${crossing.toLocaleString()} decisions  <- §29.3, the budget`
    : `\ntouched share never reaches ${CEILING * 100}% in the range`,
)
console.log(
  plateau
    ? `plateau (diagnostic only): from ~${plateau.toLocaleString()} — the gap to the crossing is re-treading`
    : 'no plateau within the range',
)
console.log('\nwrite the crossing into DECISION_BUDGET in lib/summarise.ts and leave it alone.')
