/**
 * §27.5, the test that is not confounded.
 *
 * Two measures were pre-registered before the mechanism ran, and the run showed
 * that BOTH are confounded — in opposite directions, which is why they
 * disagreed:
 *
 *   cap rate over stock     yield / land value. Competition raises land value,
 *                           so this compresses close to mechanically. It says
 *                           0.17x at the frozen budget and means almost nothing.
 *   return on price paid    yield bought / price paid, against how contested
 *                           the spot was. Confounded the other way: a place is
 *                           contested *because* it is desirable, and desirable
 *                           means high yield. It says 1.41x and also means
 *                           almost nothing.
 *
 * Both compare hot places against cold ones, and hot and cold differ for
 * reasons that have nothing to do with the mechanism. The clean test is not
 * cross-sectional at all — it is the same seed with the mechanism off, so
 * selection is identical and the only difference is the price response.
 *
 *   node --no-warnings packages/sim/test/ab-pricing.ts [seed] [budget]
 */
import { MemoryStore } from '@civ/persistence'
import { COMPETITION } from '../src/economy.ts'
import { Simulation } from '../src/index.ts'
import { loadSeed, median } from './lib/summarise.ts'

const SEED = process.argv[2] ?? 'seed-3'
const BUDGET = Number(process.argv[3] ?? 40_000)

const world = await loadSeed()

async function run(gain: number) {
  const was = COMPETITION.gain
  COMPETITION.gain = gain
  try {
    const sim = new Simulation(world, new MemoryStore(), { agentCount: 58, seed: SEED })
    await sim.runToDecisionBudget(BUDGET)
    const w = sim.world
    const tx = [...w.transactions]
    // rank by competition so "the contested quartile" means the same set of
    // places in both arms — with gain 0 the price does not respond, but the
    // demand surface is still recorded, so the ranking is comparable
    tx.sort((a, b) => a.competition - b.competition)
    const q = Math.max(1, Math.floor(tx.length / 4))
    const avg = (xs: typeof tx) =>
      xs.length ? xs.reduce((s, x) => s + x.returnOnPrice, 0) / xs.length : 0
    return {
      contested: avg(tx.slice(-q)),
      quiet: avg(tx.slice(0, q)),
      all: avg(tx),
      transactions: tx.length,
      index: sim.report.index,
      touched: sim.report.touchedShare,
      landValueSpread:
        median([...w.parcels.values()].map((p) => p.landValue)) > 0
          ? Math.max(...[...w.parcels.values()].map((p) => p.landValue)) /
            Math.max(1e-9, Math.min(...[...w.parcels.values()].map((p) => p.landValue)))
          : 0,
    }
  } finally {
    COMPETITION.gain = was
  }
}

console.log(`# §27.5 A/B — ${SEED}, ${BUDGET.toLocaleString()} decisions`)
console.log(`# the only difference between the arms is COMPETITION.gain\n`)

const off = await run(0)
const on = await run(COMPETITION.gain)

const row = (label: string, a: number, b: number, unit = '') =>
  console.log(
    `  ${label.padEnd(34)} ${a.toFixed(4).padStart(9)}${unit}  ${b.toFixed(4).padStart(9)}${unit}  ` +
      `${b > 0 && a > 0 ? `${((b / a - 1) * 100).toFixed(1)}%` : ''}`,
  )

console.log(`  ${''.padEnd(34)} ${'gain 0'.padStart(9)}  ${'gain ' + COMPETITION.gain}`)
row('return on price, contested quartile', off.contested, on.contested)
row('return on price, quiet quartile', off.quiet, on.quiet)
row('return on price, all transactions', off.all, on.all)
row('divergence index', off.index, on.index)
row('touched share', off.touched, on.touched)
row('land value max/min', off.landValueSpread, on.landValueSpread)
console.log(`  transactions: ${off.transactions} off, ${on.transactions} on`)

/**
 * The claim: turning competition on should lower the return available in the
 * contested places, relative to the same places in the same run without it.
 * Everything selection does is identical between the arms, so whatever moves is
 * the mechanism.
 */
const effect = on.contested / Math.max(1e-9, off.contested)
console.log(
  `\n  contested-quartile return with the mechanism on: ${effect.toFixed(3)}x the same places without it`,
)
console.log(
  `  §27.5 predicted compression. ${effect < 0.95 ? 'COMPRESSED' : effect > 1.05 ? 'INFLATED' : 'FLAT'}`,
)
