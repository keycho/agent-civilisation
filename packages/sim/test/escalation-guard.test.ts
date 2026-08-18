/**
 * §58.6, PRE-REGISTERED before §58's escalation shipped.
 *
 * "Untouched baseline stock must remain above 25 percent at the end of a full
 * run. If escalation pushes the world to uniform redevelopment, the ambition
 * constants are too strong and the grey has been spent."
 *
 * §26.2 is the reason this is an assertion rather than a preference: the
 * untouched grey is the contrast that lets change read at all, and a world
 * uniformly rebuilt is exactly as unreadable as a world unchanged. Escalation
 * is a trajectory, not a saturation.
 *
 * The number is registered here before the escalation constants exist, so it
 * cannot be chosen to fit what they turn out to do. If this fails after §58,
 * the finding is that the ambition constants are too strong — it is not an
 * invitation to move the line.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { BOUNDARY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

/** §58.6's line, registered ahead of the mechanism it constrains */
export const UNTOUCHED_FLOOR = 0.25

test('§58.6: escalation leaves the grey standing', async () => {
  BOUNDARY.gate = true
  const world = await loadSeed()
  const summary = await runSeed(world, 'seed-escalation-guard', DECISION_BUDGET, false)
  const share = summary.untouchedShare

  console.log(
    `§58.6 contrast guard — untouched baseline stock ${(share * 100).toFixed(1)}% ` +
      `at the end of a full run (floor ${(UNTOUCHED_FLOOR * 100).toFixed(0)}%)`,
  )

  assert.ok(
    share > UNTOUCHED_FLOOR,
    `untouched share ${(share * 100).toFixed(1)}% is at or below the ${(
      UNTOUCHED_FLOOR * 100
    ).toFixed(0)}% floor: escalation has spent the grey that makes change legible`,
  )
})
