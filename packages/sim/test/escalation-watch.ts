/**
 * §58.2: what the max-intensity branch actually does to a chunk.
 *
 * The pre-registered guard (§70.2's fabric-guard.test.ts, which replaced §58.6's
 * escalation-guard) answers one question —
 * is there grey left? — and it answered it BEFORE this mechanism existed, at
 * 21.3%, already under its own 25% floor. So the absolute level is a
 * pre-existing property of the economics and the only thing §58 can be held
 * to is the DELTA. This runs both arms against identical seeds in one process
 * via §37.2's toggle idiom, so the delta is paired rather than remembered.
 *
 * The second half is what escalation bought for that delta: the height
 * histogram, the tall builds' footprints, and the dynasty depth the run
 * reaches — because §58's first draft was keyed on dynasty depth and this is
 * the instrument that showed the axis has no range.
 *
 *   node packages/sim/test/escalation-watch.ts <chunk> [seeds=5]
 */
import { MemoryStore } from '@civ/persistence'
import { Simulation } from '@civ/sim'
import { BOUNDARY, ESCALATION } from '@civ/sim/state.ts'
import { siteCeiling } from '@civ/sim/engine.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const SEEDS = Number(process.argv[3] ?? 5)
const seed = await loadSeed(CHUNK)

/** the cap `chooseLevels` still clamps the marginal reading to */
const MARGINAL_CAP = 8

const names = ['seed-escalation-guard', ...Array.from({ length: SEEDS - 1 }, (_, i) => `spread-${i}`)]

console.log(
  `# §58.2 escalation watch — ${CHUNK}, ${names.length} seeds, gate ${BOUNDARY.gate ? 'on' : 'OFF'}`,
)

// -- arm A/B: the untouched share, paired ------------------------------------
const pairs: Array<[string, number, number]> = []
for (const name of names) {
  ESCALATION.on = false
  const off = (await runSeed(await loadSeed(CHUNK), name, DECISION_BUDGET, false)).untouchedShare
  ESCALATION.on = true
  const on = (await runSeed(await loadSeed(CHUNK), name, DECISION_BUDGET, false)).untouchedShare
  pairs.push([name, off, on])
  console.log(
    `#   ${name.padEnd(22)} untouched  off ${(off * 100).toFixed(1)}%  on ${(on * 100).toFixed(
      1,
    )}%   delta ${((on - off) * 100).toFixed(1)}pp`,
  )
}
const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]
console.log(
  `#   median: off ${(med(pairs.map((p) => p[1])) * 100).toFixed(1)}%  on ${(
    med(pairs.map((p) => p[2])) * 100
  ).toFixed(1)}%  delta ${(med(pairs.map((p) => p[2] - p[1])) * 100).toFixed(1)}pp`,
)

// -- what the delta bought ---------------------------------------------------
ESCALATION.on = true
const sim = new Simulation(seed, new MemoryStore(), { agentCount: 58, seed: names[0] })
await sim.runToDecisionBudget(DECISION_BUDGET)
const w = sim.world
const built = [...w.buildings.values()].filter((b) => b.source === 'agent_built')
const hist = new Map<number, number>()
for (const b of built) hist.set(b.levels, (hist.get(b.levels) ?? 0) + 1)
const tall = built.filter((b) => b.levels > MARGINAL_CAP)
const areas = tall.map((b) => b.areaM2).sort((a, b) => a - b)

console.log(
  `#   agent-built ${built.length}, tallest ${Math.max(0, ...built.map((b) => b.levels))} levels`,
)
console.log(
  `#     levels: ${[...hist]
    .sort((a, b) => a[0] - b[0])
    .map(([l, n]) => `${l}L:${n}`)
    .join(' ')}`,
)
console.log(
  `#     above the marginal cap: ${tall.length}` +
    (tall.length
      ? `  footprints ${Math.round(areas[0])}-${Math.round(areas[areas.length - 1])} m2 ` +
        `(median ${Math.round(areas[areas.length >> 1])}, site ceiling there ${siteCeiling(
          areas[areas.length >> 1],
        )}L)`
      : ''),
)
if (tall.length) {
  const assembled = tall.filter((b) => (b.builtOnParcels?.length ?? 1) > 1).length
  console.log(`#     of those, on assembled ground: ${assembled}/${tall.length}`)
}
const byGen = new Map<number, number>()
for (const a of w.agents.values()) byGen.set(a.generation, (byGen.get(a.generation) ?? 0) + 1)
console.log(
  `#     dynasty depth: median living ${w.generation}, deepest ${w.deepestLineage}, ` +
    `agents ever ${[...byGen]
      .sort((a, b) => a[0] - b[0])
      .map(([g, n]) => `g${g}:${n}`)
      .join(' ')}`,
)
console.log('#   reading: the delta is what §58 is answerable for; the absolute level is not.')
