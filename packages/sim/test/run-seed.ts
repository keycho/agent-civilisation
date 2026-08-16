/**
 * One seed, as a child process. tune.ts forks these across cores because 20
 * seeds at the frozen budget is several minutes serially and the whole point of
 * §18.1 is that it gets run rather than skipped.
 *
 *   node --no-warnings packages/sim/test/run-seed.ts <seed> [budget] [--curve]
 */
import { BOUNDARY } from '../src/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

// §30.3's one run of cost: flip the boundary gate on for a measured delta.
if (process.env.CIV_BOUNDARY_GATE === '1') BOUNDARY.gate = true

const seed = process.argv[2] ?? 'seed-0'
const budget = Number(process.argv[3] ?? DECISION_BUDGET)
const world = await loadSeed()
const summary = await runSeed(world, seed, budget, process.argv.includes('--curve'))
process.stdout.write(JSON.stringify(summary))
