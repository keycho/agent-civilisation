/**
 * §29.1: calibrate COMPETITION.gain once, against the inversion criterion.
 *
 * "The target is not 'compress a little more'. The target is that the yield
 * ordering inverts: contested ground should end up returning less than quiet
 * ground." That is a mechanism specification anchored to how property markets
 * actually work — prime yields sit below secondary, and that inversion is what
 * pushes capital out of prime — rather than a threshold chased against an
 * outcome, so §21.2 permits the recalibration.
 *
 * The rule is written here before the sweep runs, and it names no value: take
 * the LOWEST gain at which the contested quartile returns less than the quiet
 * quartile, with a margin wide enough that it is not a coin flip. Lowest rather
 * than best, because a bigger number would invert harder and there is no reason
 * to want that — the criterion is the ordering, not the gap.
 *
 *   node --no-warnings packages/sim/test/calibrate-pricing.ts
 */
import { RATE_WINDOW_TICKS, centroid } from '@civ/core'
import { MemoryStore } from '@civ/persistence'
import { COMPETITION, acquisitionPrice, competitionAt, withDuty } from '../src/economy.ts'
import { Simulation } from '../src/index.ts'
import { loadSeed } from './lib/summarise.ts'

const BUDGET = 40_000
const SEEDS = ['seed-3', 'seed-7']
/** inverted, and by enough that seed noise cannot flip it back */
const MARGIN = 0.95

const world = await loadSeed()

/**
 * The offered surface: what a buyer standing in front of each still-standing
 * building WOULD earn per unit of price, duty in. This is the quantity §29.1's
 * mechanism sentence is about — "the marginal agent finds the cheap town is
 * the better return" is a statement about offers, and the agent who declines
 * one leaves no transaction to measure.
 *
 * Transacted returns structurally cannot invert while agents are
 * return-rational: clearing selects on the return beating the buyer's
 * alternatives, so the traded sample in a bid-up place is exactly the deals
 * good enough to survive the premium. The first sweep read that selection
 * effect and the ratio *rose* with gain while transaction counts fell — the
 * falling counts being the priced-out behaviour §27.5 wants, visible in the
 * only place it can be.
 */
/** time-controlled transacted ratio over the purchases made so far */
function transactedRatio(sim: InstanceType<typeof Simulation>): number {
  const tx = [...sim.world.transactions].sort(
    (a, b) =>
      a.competition - a.competitionMedianAtBuy - (b.competition - b.competitionMedianAtBuy),
  )
  const q = Math.max(1, Math.floor(tx.length / 4))
  const avg = (xs: typeof tx) =>
    xs.length ? xs.reduce((s, x) => s + x.returnOnPrice, 0) / xs.length : 0
  const quiet = avg(tx.slice(0, q))
  return quiet > 0 ? avg(tx.slice(-q)) / quiet : Number.POSITIVE_INFINITY
}

function offeredRatio(sim: InstanceType<typeof Simulation>): number {
  const w = sim.world
  const offers: Array<{ comp: number; y: number }> = []
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing') continue
    const price = withDuty(acquisitionPrice(w, b))
    if (price <= 0) continue
    const c = centroid(b.footprint)
    offers.push({
      comp: competitionAt(w, c[0], c[1]),
      y: (b.yieldPerTick * RATE_WINDOW_TICKS) / price,
    })
  }
  offers.sort((a, b) => a.comp - b.comp)
  const q = Math.max(1, Math.floor(offers.length / 4))
  const avg = (xs: typeof offers) =>
    xs.length ? xs.reduce((s, x) => s + x.y, 0) / xs.length : 0
  const quiet = avg(offers.slice(0, q))
  const contested = avg(offers.slice(-q))
  return quiet > 0 ? contested / quiet : Number.POSITIVE_INFINITY
}

async function ratioAt(gain: number, seed: string) {
  const was = COMPETITION.gain
  COMPETITION.gain = gain
  try {
    const sim = new Simulation(world, new MemoryStore(), { agentCount: 58, seed })
    /**
     * Spatial pricing measures are taken at HALF budget, while the surface is
     * differentiated. Three measurements in a row read flat or inverted-for-
     * the-wrong-reason because they sampled the end of a run whose supply was
     * exhausted and whose competition surface had saturated at 1 everywhere.
     * The end state is §27.5's terminal condition working; the question "does
     * the premium invert the offer" only has meaning while there is a market.
     */
    await sim.runToDecisionBudget(Math.floor(BUDGET / 2))
    const offeredMid = offeredRatio(sim)
    const txMid = transactedRatio(sim)
    await sim.runToDecisionBudget(BUDGET)
    return {
      ratio: txMid,
      offered: offeredMid,
      index: sim.report.index,
      touched: sim.report.touchedShare,
      transactions: sim.world.transactions.length,
    }
  } finally {
    COMPETITION.gain = was
  }
}

console.log('# §29.1 — calibrating COMPETITION.gain against the inversion criterion')
console.log(`# rule, written before the sweep: lowest gain where contested/quiet < ${MARGIN}`)
console.log(`# ${SEEDS.length} seeds, ${BUDGET.toLocaleString()} decisions each\n`)
console.log('  gain   transacted(mid)   OFFERED(mid)   index  touched   tx')

let chosen: number | null = null
for (const gain of [0.85, 1.5, 2.5, 4, 6, 9]) {
  const rs = await Promise.all(SEEDS.map((s) => ratioAt(gain, s)))
  const mean = (f: (r: (typeof rs)[number]) => number) =>
    rs.reduce((s, r) => s + f(r), 0) / rs.length
  const ratio = mean((r) => r.ratio)
  const offered = mean((r) => r.offered)
  console.log(
    `  ${gain.toFixed(2).padStart(4)}   ${ratio.toFixed(3).padStart(16)}   ${offered.toFixed(3).padStart(13)}   ` +
      `${(mean((r) => r.index) * 100).toFixed(1)}%    ${(mean((r) => r.touched) * 100).toFixed(0)}%  ` +
      `${Math.round(mean((r) => r.transactions))}`,
  )
  // the rule, unchanged: lowest gain that inverts, margin 0.95 — applied to the
  // offered surface, which is the quantity the mechanism sentence names
  if (chosen === null && offered < MARGIN) chosen = gain
}

console.log(
  chosen === null
    ? '\n  NO GAIN IN THE SWEEP INVERTS THE ORDERING. That is a finding, not a reason to widen the sweep.'
    : `\n  first gain that inverts: ${chosen}. Set COMPETITION.gain to it and refreeze.`,
)
