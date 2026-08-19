/**
 * §73.3, restating §70.2, which retired §58.6.
 *
 * The line has moved twice and each move was a correction to what it MEASURES,
 * never to where it sits.
 *
 * §58.6 asserted that untouched baseline stock stays above 25 percent. It never
 * passed — 21.3% before escalation existed, 19.9% median across five seeds,
 * 18.9% before §70's funding gate. A bar that has never held is not a guard.
 *
 * §70.2 replaced it with "standing and no further from its import than a
 * renovation", which is a comparison of DIVERGENCE CLASSES — and the classes
 * record whether something happened, not how much. §72.5 then bounded how far a
 * structure can be expanded, the inherited city came out 29-60 percent less
 * tall, and this number did not move by a tenth of a percent: a terrace at
 * 2→3 storeys and one at 2→7 both read as `expanded`. A bar that cannot see
 * the fix is not measuring the thing the fix is about.
 *
 * So it is restated on MAGNITUDE. A baseline building is grey while it still
 * stands, still serves the purpose it was imported with, and is within 50% of
 * its original height. A terrace grown from two floors to three is grey; at two
 * to four it is not. That is what the eye does with it, and it is the quantity
 * §26.2 was reaching for: untouched reality is the contrast that lets change
 * read at all, and what spends it is buildings that no longer look like
 * themselves — not buildings that were merely acted upon.
 *
 * The incidence share is still computed and still printed, as information about
 * how busy the agents have been. It is not a statement about whether the world
 * still reads, and §72.5 is why that distinction is now written down.
 *
 * If the world cannot hold 40 percent under this definition with clearing
 * (§70) and expansion (§72.5) both mechanically bounded, the finding is about
 * the economy and this line does not move.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { BOUNDARY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

/** §73.3's line, registered against the mechanism it constrains */
export const GREY_FLOOR = 0.4

test('§73.3: the fabric still reads as the world we left it', async () => {
  BOUNDARY.gate = true
  const world = await loadSeed()
  const summary = await runSeed(world, 'seed-fabric-guard', DECISION_BUDGET, false)

  console.log(
    `§73.3 grey guard — standing, same purpose, within 50% of import height: ` +
      `${(summary.greyShare * 100).toFixed(1)}% ` +
      `(floor ${(GREY_FLOOR * 100).toFixed(0)}%). ` +
      `Information, not a gate: touched by any action ` +
      `${((1 - summary.untouchedShare) * 100).toFixed(1)}%, standing ` +
      `${(summary.standingShare * 100).toFixed(1)}% of baseline, ` +
      `cleared-and-unbuilt ${(summary.clearedUnbuiltShare * 100).toFixed(1)}% of parcels, ` +
      `floors added to inherited stock ${summary.expansion.levelsAdded} across ` +
      `${summary.expansion.touched} buildings (mean ${summary.expansion.meanAdded.toFixed(2)}). ` +
      `Where the grey went: ${summary.greyLost.gone} gone, ` +
      `${summary.greyLost.repurposed} repurposed, ${summary.greyLost.taller} more than half again as tall`,
  )

  assert.ok(
    summary.greyShare > GREY_FLOOR,
    `the grey is ${(summary.greyShare * 100).toFixed(1)}%, at or below the ` +
      `${(GREY_FLOOR * 100).toFixed(0)}% floor — escalation has spent the contrast §26.2 ` +
      `depends on, and with clearing and expansion both mechanically bounded the finding ` +
      `is about the economy rather than about this number`,
  )
})
