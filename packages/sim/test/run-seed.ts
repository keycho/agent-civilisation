/**
 * One seed, as a child process. tune.ts forks these across cores because 20
 * seeds at the frozen budget is several minutes serially and the whole point of
 * §18.1 is that it gets run rather than skipped.
 *
 *   node --no-warnings packages/sim/test/run-seed.ts <seed> [budget] [--curve]
 */
import { BOUNDARY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

/**
 * §32.1: the boundary gate ships ON in the region world — Moran's I nearly
 * doubled with the perimeter gated (0.123 -> 0.217), which means an ungated
 * ruler dilutes every §30.4 spectacle comparison with edge development that
 * exists because the boundary is arbitrary (§24.3), not because agents chose
 * it. The harness therefore measures the control AS IT WILL RUN in the region
 * world: gate on by default here. The live single-chunk server keeps the gate
 * off until it has neighbours, per §30.3's per-chunk-pair rule.
 *
 * CIV_BOUNDARY_GATE=0 opts out, for measuring the ungated delta.
 */
BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const seed = process.argv[2] ?? 'seed-0'
const budget = Number(process.argv[3] ?? DECISION_BUDGET)
const world = await loadSeed()
const summary = await runSeed(world, seed, budget, process.argv.includes('--curve'))
process.stdout.write(JSON.stringify(summary))
