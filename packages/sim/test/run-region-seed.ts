/**
 * One region seed, as a child process — region-run.ts forks these across
 * cores the way tune.ts forks run-seed.ts. Prints one RegionRunSummary
 * (the shape contract-region.ts pre-registered) as JSON on stdout.
 *
 *   node --no-warnings packages/sim/test/run-region-seed.ts <seed> [regionBudget] [controlBudget]
 *
 * §32.1: the region world runs with the boundary gate ON, and the control is
 * measured gate-on by the same process — the gate comes from the registered
 * REGION_RULES, not from an env knob, so the run cannot drift from the
 * contract it will be judged by.
 */
import { DIVERGENCE_WEIGHT, type MoranPoint, centroid } from '@civ/core'
import { MemoryStore } from '@civ/persistence'
import { RegionWorld } from '../src/region.ts'
import { BOUNDARY } from '../src/state.ts'
import { Simulation } from '../src/tick.ts'
import {
  type MigrationEvent,
  REGION_RULES,
  type RegionRunSummary,
} from './contract-region.ts'
import { SEEDED_FIVE, loadRoster } from './lib/region-info.ts'
import { DECISION_BUDGET } from './lib/summarise.ts'

BOUNDARY.gate = REGION_RULES.boundaryGate

const seed = process.argv[2] ?? 'region-seed-0'
const regionBudget = Number(process.argv[3] ?? 220_000)
const controlBudget = Number(process.argv[4] ?? DECISION_BUDGET)

const roster = await loadRoster()
const region = new RegionWorld({
  seeds: roster.seeds,
  info: roster.info,
  seeded: [...SEEDED_FIVE],
  rngSeed: seed,
})
await region.runToDecisionBudget(regionBudget)

/**
 * Divergence-surface points for the whole region, chunk-local coordinates:
 * each chunk is offset far beyond the 150 m Moran cutoff so cross-chunk pairs
 * are inert and the statistic reads within-chunk clustering only, summed over
 * the region — the same extraction summarise.ts uses on the single chunk.
 */
const moranPoints: MoranPoint[] = []
// materialisedEver, not sims: a warm-only chunk is loaded but never ticked
// (§28.3) — it is not part of the region's divergence surface, and a plane
// of zero-divergence points would distort the statistic
const orderedIds = [...region.materialisedEver].sort()
orderedIds.forEach((id, i) => {
  const sim = region.sims.get(id)
  if (!sim) return
  const off = (i + 1) * 100_000
  for (const b of sim.world.buildings.values()) {
    if (b.source === 'agent_built') continue
    const c = centroid(b.footprint)
    moranPoints.push({ x: c[0] + off, y: c[1], v: DIVERGENCE_WEIGHT[b.divergence] ?? 0 })
  }
})

// the control: single-chunk schiedam at the frozen budget, same gate, same
// process, same instrument (§30.4: "measured alongside rather than frozen as
// a constant")
const schiedamSeed = roster.seeds.get('schiedam-havens')
if (!schiedamSeed) throw new Error('control seed missing from roster')
const control = new Simulation(schiedamSeed, new MemoryStore(), {
  agentCount: 58,
  seed: `${seed}:control`,
})
await control.runToDecisionBudget(controlBudget)
const controlMoranPoints: MoranPoint[] = [...control.world.buildings.values()]
  .filter((b) => b.source !== 'agent_built')
  .map((b) => {
    const c = centroid(b.footprint)
    return { x: c[0], y: c[1], v: DIVERGENCE_WEIGHT[b.divergence] ?? 0 }
  })

// per-settlement attribution, straight off the sims
const activityBySettlement: Record<string, number> = {}
const decisionsBySettlement: Record<string, number> = {}
const contestBySettlement: Record<string, number> = {}
const chainCompletionsBySettlement: Record<string, number> = {}
let chains = 0
let decisions = 0
for (const [id, sim] of region.sims) {
  if (!region.materialisedEver.has(id)) continue // warm-only: loaded, never ticked
  const w = sim.world
  activityBySettlement[id] = w.appliedActions
  decisionsBySettlement[id] = sim.decisionsIssued
  decisions += sim.decisionsIssued
  // §44.2: the half-budget sample, not the terminal (saturated) surface.
  // 0 = the chunk never crossed its half-budget point before region end.
  contestBySettlement[id] = region.midContest.get(id) ?? 0
  const done = w.assemblies.filter((x) => x.clearedAfter && x.developedAfter).length
  chainCompletionsBySettlement[id] = done
  chains += done
}

const populationBySettlement: Record<string, number> = {}
const countryBySettlement: Record<string, string> = {}
for (const [id, info] of roster.info) {
  populationBySettlement[id] = info.population
  countryBySettlement[id] = info.country
}

const migrations: MigrationEvent[] = region.migrations.map((m) => ({
  agentId: m.agentId,
  fromChunk: m.fromChunk,
  toSettlement: m.toSettlement,
  departedTick: m.departedTick,
  arrivedTick: m.arrivedTick,
  offeredGap: m.offeredGap,
  destinationValueTier: m.destinationValueTier as MigrationEvent['destinationValueTier'],
  reversed: m.reversed,
  belowOriginAtGrace: m.belowOriginAtGrace,
}))

const summary: RegionRunSummary = {
  seed,
  decisions,
  materialised: [...region.materialisedEver].sort(),
  seeded: [...SEEDED_FIVE],
  activityBySettlement,
  populationBySettlement,
  countryBySettlement,
  migrations,
  abandonmentFlips: Object.fromEntries(region.drains),
  /**
   * §30.5: no dormancy machinery exists, and a drained chunk keeps ticking —
   * advanceConstruction runs regardless of population, so in-flight work
   * resolves rather than freezing. Both zeros are measured facts of the
   * architecture, not placeholders.
   */
  dormantConstruction: { becameRuin: 0, frozen: 0 },
  moranPoints,
  controlMoranPoints,
  importHealth: roster.importHealth,
  chainCompletionFlow: (chains / Math.max(1, decisions)) * 10_000,
  contestBySettlement,
  chainCompletionsBySettlement,
  decisionsBySettlement,
}

process.stdout.write(JSON.stringify(summary))
