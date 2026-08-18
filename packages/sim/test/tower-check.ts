/**
 * §58.4: "the setback tower is selectable in every chunk."
 *
 * §16.1's archetype selector reaches `agent_tower` at 26 m, which is eight
 * levels — so the claim is not about the branch existing, it is about whether
 * every fabric actually produces one. Fine-grain chunks have small lots and
 * §58.2's slenderness ceiling is a function of lot size, so this is a real
 * question per chunk rather than a formality.
 *
 *   node packages/sim/test/tower-check.ts [seeds=1]
 */
import { MemoryStore } from '@civ/persistence'
import { Simulation } from '@civ/sim'
import { BOUNDARY } from '@civ/sim/state.ts'
import { selectArchetype } from '@civ/core'
import { DECISION_BUDGET, loadSeed } from './lib/summarise.ts'

BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'
const SEEDS = Number(process.argv[2] ?? 1)

const CHUNKS = [
  'schiedam-havens',
  'vlaardingen-westwijk',
  'maassluis-haven',
  'maasland-dorp',
  'london-deptford',
  'paris-ourcq',
  'brooklyn-redhook',
  'tokyo-kyojima',
]

console.log(`# §58.4 tower check — ${SEEDS} seed(s) per chunk, gate ${BOUNDARY.gate ? 'on' : 'OFF'}`)
for (const chunk of CHUNKS) {
  const seed = await loadSeed(chunk)
  let towers = 0
  let builds = 0
  let tallest = 0
  for (let i = 0; i < SEEDS; i++) {
    const sim = new Simulation(seed, new MemoryStore(), { agentCount: 58, seed: `tower-${i}` })
    await sim.runToDecisionBudget(DECISION_BUDGET)
    for (const b of sim.world.buildings.values()) {
      if (b.source !== 'agent_built') continue
      builds++
      if (b.heightM > tallest) tallest = b.heightM
      const a = selectArchetype({
        source: b.source,
        purpose: b.purpose,
        heightM: b.heightM,
        areaM2: b.areaM2,
        footprint: b.footprint,
        levels: b.levels,
        constructionYear: b.constructionYear,
        chunkId: b.chunkId,
        landmark: b.landmark,
      } as Parameters<typeof selectArchetype>[0])
      if (a.archetype === 'agent_tower') towers++
    }
  }
  console.log(
    `#   ${chunk.padEnd(23)} agent builds ${String(builds).padStart(4)}  towers ${String(
      towers,
    ).padStart(4)}  tallest ${tallest.toFixed(0)} m  ${towers > 0 ? 'SELECTABLE' : '-- NONE --'}`,
  )
}
