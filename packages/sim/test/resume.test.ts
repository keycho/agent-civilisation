/**
 * §72.1's acceptance: a resumed world is the same world, not a similar one.
 *
 * The failure this guards is the one that makes "resume" worthless while
 * looking like it worked. A world restored with the right buildings and the
 * wrong rng position, or the right agents and the wrong effort budgets, boots
 * cleanly, renders correctly, and then diverges from the world that stopped —
 * and nobody can tell, because there is nothing to compare it to. So the test
 * is not "does it load". It is: run a world, capture it, keep running the
 * original; separately restore the capture into a fresh process-equivalent and
 * run it the same distance. The two must end in the same place, field for
 * field.
 *
 * That is a strictly stronger check than any structural assertion, because it
 * fails on anything the capture missed — including fields nobody thought of,
 * which is precisely the category that hurts.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { MemoryStore } from '@civ/persistence'
import { Simulation, type WorldState, decodeWorldState, encodeWorldState } from '../src/index.ts'
import { BOUNDARY } from '../src/state.ts'
import { loadSeed } from './lib/summarise.ts'

/** far enough in that agents have died, plans exist and the market has moved */
const RUN_TO = 3_000
/** far enough after the capture that a wrong rng position cannot stay hidden */
const CONTINUE_FOR = 1_500

/** everything a spectator or a guard would ever read, in one comparable shape */
function fingerprint(sim: Simulation): Record<string, unknown> {
  const w = sim.world
  const r = sim.refreshReport()
  const agents = [...w.agents.values()].map(
    (a) =>
      `${a.id}|${a.name}|${a.capital.toFixed(4)}|${a.debt.toFixed(4)}|${a.effortSpent}|` +
      `${a.decisionsMade}|${a.generation}|${a.diedTick ?? '-'}|${[...a.holdings].sort().join(',')}|` +
      `${[...a.parcels].sort().join(',')}`,
  )
  const buildings = [...w.buildings.values()].map(
    (b) =>
      `${b.id}|${b.state}|${b.levels}|${b.heightM.toFixed(3)}|${b.divergence}|` +
      `${b.condition.toFixed(4)}|${b.purpose}|${b.progress.toFixed(4)}`,
  )
  const parcels = [...w.parcels.values()].map(
    (p) => `${p.id}|${p.ownerId ?? '-'}|${p.buildingId ?? '-'}|${p.landValue.toFixed(4)}`,
  )
  return {
    tick: w.tick,
    decisionsIssued: w.decisionsIssued,
    appliedActions: w.appliedActions,
    generation: w.generation,
    livesCompleted: w.livesCompleted,
    index: +r.index.toFixed(9),
    touchedShare: +r.touchedShare.toFixed(9),
    agentOrigin: r.agentOrigin,
    demolished: r.demolished,
    plans: [...w.sitePlans.keys()].sort().join(','),
    actionCounts: [...w.actionCounts].sort().map(([k, v]) => `${k}=${v}`),
    agents: agents.sort(),
    buildings: buildings.sort(),
    parcels: parcels.sort(),
  }
}

async function build(seedKey: string, resumeFrom?: WorldState): Promise<Simulation> {
  const seed = await loadSeed()
  return new Simulation(seed, new MemoryStore(), { agentCount: 58, seed: seedKey, resumeFrom })
}

test('§72.1: a restored world continues the same world, decision for decision', async () => {
  BOUNDARY.gate = true
  const seedKey = 'seed-resume'

  const original = await build(seedKey)
  await original.runToDecisionBudget(RUN_TO)

  // the blob takes the same trip it takes in production: encode, decode
  const blob = encodeWorldState(original.capture(7, 42))
  const state = decodeWorldState(blob)
  assert.equal(state.season, 7, 'the capture carries the season it belongs to')
  assert.equal(state.firstEventId, 42, "...and the season's ordinal origin")

  // the original keeps going, exactly as the process that never restarted would
  await original.runToDecisionBudget(RUN_TO + CONTINUE_FOR)

  // ...and a fresh one is restored into and run the same distance
  const resumed = await build(seedKey, state)
  assert.equal(
    resumed.world.decisionsIssued,
    state.decisionsIssued,
    'the restore lands on the captured decision count',
  )
  await resumed.runToDecisionBudget(RUN_TO + CONTINUE_FOR)

  const a = fingerprint(original)
  const b = fingerprint(resumed)
  for (const key of Object.keys(a)) {
    assert.deepEqual(
      b[key],
      a[key],
      `${key} diverged after the restore — the capture is missing state ` +
        `the simulation reads, so a resumed world is not the world that stopped`,
    )
  }

  console.log(
    `§72.1 resume — captured at ${RUN_TO} decisions, both sides run to ` +
      `${RUN_TO + CONTINUE_FOR}: identical across ${Object.keys(a).length} fields ` +
      `(${original.world.buildings.size} buildings, ${original.world.agents.size} agents, ` +
      `blob ${(blob.byteLength / 1024).toFixed(0)} KiB gzipped)`,
  )
})

test('§72.1: a state from another schema or another chunk is refused, not guessed at', async () => {
  const sim = await build('seed-resume-guard')
  const state = sim.capture(1)

  await assert.rejects(
    async () => build('seed-resume-guard', { ...state, v: state.v + 1 }),
    /version/,
    'a state written by a different build must not be loaded on a hope',
  )
  await assert.rejects(
    async () => build('seed-resume-guard', { ...state, chunkId: 'somewhere-else' }),
    /chunk/,
    "a state for another chunk must not be painted onto this one's baseline",
  )
})
