/**
 * §70.2, replacing §58.6.
 *
 * §58.6 asserted that untouched baseline stock stays above 25 percent. It never
 * passed: 21.3% before escalation existed, a median of 19.9% across five seeds,
 * 18.9% before §70's funding gate and 8.3% after it. A bar that has never held
 * is not a guard, it is a wish — and it was measuring the wrong quantity, which
 * is why relaxing it to whatever the economy currently produces would have made
 * it meaningless in the other direction rather than fixing it.
 *
 * What it was protecting is real. §26.2's argument is that untouched reality is
 * the contrast that lets change read at all, and the failure it feared was
 * uniform REDEVELOPMENT — not uniform activity. Renovation and conversion leave
 * the fabric standing; they are not what spends the grey visually. A renovated
 * 1909 terrace still reads as a 1909 terrace. A cleared lot does not.
 *
 * So the bar moves to the quantity that matters to the picture: baseline stock
 * still STANDING and no further from its import than a renovation. If the world
 * cannot hold 40 percent of that, the finding is about escalation and this line
 * does not move — that is the whole reason §58.6 is being retired rather than
 * lowered.
 *
 * The untouched-by-any-action share is still computed and still printed. It is
 * information about how busy the agents have been, which is worth knowing and
 * is not a statement about whether the world still reads.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { BOUNDARY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

/** §70.2's line, registered against the mechanism it constrains */
export const INTACT_FLOOR = 0.4

test('§70.2: the fabric still reads as the world we left it', async () => {
  BOUNDARY.gate = true
  const world = await loadSeed()
  const summary = await runSeed(world, 'seed-fabric-guard', DECISION_BUDGET, false)

  console.log(
    `§70.2 fabric guard — baseline standing and unconverted ` +
      `${(summary.standingUnconvertedShare * 100).toFixed(1)}% ` +
      `(floor ${(INTACT_FLOOR * 100).toFixed(0)}%). ` +
      `Information, not a gate: untouched by any action ` +
      `${(summary.untouchedShare * 100).toFixed(1)}%, standing ` +
      `${(summary.standingShare * 100).toFixed(1)}% of baseline, ` +
      `cleared-and-unbuilt ${(summary.clearedUnbuiltShare * 100).toFixed(1)}% of parcels`,
  )

  assert.ok(
    summary.standingUnconvertedShare > INTACT_FLOOR,
    `baseline stock still reading as imported is ${(summary.standingUnconvertedShare * 100).toFixed(1)}%, ` +
      `at or below the ${(INTACT_FLOOR * 100).toFixed(0)}% floor — escalation has spent the contrast ` +
      `§26.2 depends on, and the finding is about escalation rather than about this number`,
  )
})
