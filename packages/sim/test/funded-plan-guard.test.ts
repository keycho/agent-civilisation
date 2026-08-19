/**
 * §70, PRE-REGISTERED before the funded-plan gate was measured.
 *
 * The operator's two lines, recorded verbatim ahead of the run so they cannot
 * be chosen to fit what it turns out to do:
 *
 *   "cleared-and-unbuilt parcels as a share of all parcels must fall below 10
 *    percent at end of run, and standing stock must not fall below 60 percent
 *    of baseline in any chunk."
 *
 * What made them necessary, measured over the retained event store before any
 * change (21,081 cleared parcels, 47,567 assemblies):
 *
 *   19.2%  of cleared parcels are ever rebuilt
 *   22.5%  ever even start construction — and once started, 87% complete
 *   18.3%  of assemblies ever produce a building
 *   8,974  mean ticks a still-empty lot has been empty, against a median
 *          rebuild wait of 510 — they are abandoned, not queued
 *
 * The joint: §29.2 gated clearing on planned ground by `demolitionCost(b) <=
 * funds` — this building's clearing cost — while the unplanned redevelopment
 * branch beside it has always priced clearance plus construction. Clearing was
 * cheap, unappraised and score-boosted; building was expensive, payback-gated
 * and unboosted. §70 prices the whole plan at the clearing decision.
 *
 * If this fails, the finding is that the whole-plan gate is not sufficient — it
 * is not an invitation to move the line. The two failure directions read
 * differently and both are informative:
 *   - holes still high: something other than funding is stopping the build
 *   - standing stock too LOW while holes are low: agents stopped clearing at
 *     all and the world went inert, which is the §26.2 failure in the other
 *     direction
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { BOUNDARY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

/** §69.2's lines, registered ahead of the mechanism they constrain */
export const HOLE_CEILING = 0.1
export const STANDING_FLOOR = 0.6

test('§70: a plan that clears must be funded to build', async () => {
  BOUNDARY.gate = true
  const world = await loadSeed()
  const summary = await runSeed(world, 'seed-funded-plan', DECISION_BUDGET, false)

  console.log(
    `§70 funded-plan guard — cleared-and-unbuilt ${(summary.clearedUnbuiltShare * 100).toFixed(1)}% ` +
      `of parcels (ceiling ${(HOLE_CEILING * 100).toFixed(0)}%), standing stock ` +
      `${(summary.standingShare * 100).toFixed(1)}% of baseline (floor ${(STANDING_FLOOR * 100).toFixed(0)}%), ` +
      `clearing:building ${summary.clearToBuild.toFixed(2)}:1`,
  )

  assert.ok(
    summary.clearedUnbuiltShare < HOLE_CEILING,
    `cleared-and-unbuilt ground is ${(summary.clearedUnbuiltShare * 100).toFixed(1)}% of all ` +
      `parcels, at or above the ${(HOLE_CEILING * 100).toFixed(0)}% ceiling — the plan is still ` +
      `clearing ground it does not finish`,
  )
  assert.ok(
    summary.standingShare > STANDING_FLOOR,
    `standing stock is ${(summary.standingShare * 100).toFixed(1)}% of baseline, at or below the ` +
      `${(STANDING_FLOOR * 100).toFixed(0)}% floor — the city has been taken down faster than it ` +
      `is being put back up`,
  )
})
