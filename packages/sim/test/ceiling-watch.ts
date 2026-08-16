/**
 * §41.3: the capital ceiling is a mechanism gap, logged not built. Rate-viable
 * stock no agent can afford is real urban economics — large assets are
 * institutional and the model has no capital aggregation. The decision is to
 * WATCH, not add: inherited capital compounds, so the one cheap longitudinal
 * question is whether dynastic accumulation reaches the ceiling class over
 * more generations. If the waterfront assets start trading by gen 8-10 in
 * longer runs, the model self-solves and the gap closes free. If they never
 * trade, syndication becomes a §4-class mechanism decision later.
 *
 * This runs a chunk at a multiple of the standard budget and reports, for the
 * day-0 capital-ceiling candidates (top area decile at or above median cap
 * rank), whether and when they were first touched — by generation.
 *
 *   node packages/sim/test/ceiling-watch.ts <chunk> [seeds=2] [budgetX=3]
 */
import { MemoryStore } from '@civ/persistence'
import { Simulation } from '@civ/sim'
import { acquisitionPrice, conversionCost, yieldPerTick } from '@civ/sim/economy.ts'
import { BOUNDARY } from '@civ/sim/state.ts'
import { DECISION_BUDGET, loadSeed } from './lib/summarise.ts'

BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const CHUNK = process.argv[2] ?? 'brooklyn-redhook'
const SEEDS = Number(process.argv[3] ?? 2)
const BUDGET_X = Number(process.argv[4] ?? 3)

const seed = await loadSeed(CHUNK)

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** day-0 ceiling candidates: top area decile, cap rank >= 0.5, in market */
function ceilingCandidates(): Set<string> {
  const probe = new Simulation(seed, new MemoryStore(), { agentCount: 0, seed: 'ceiling' })
  const w = probe.world
  const RATE = 365
  const caps: Array<[string, number, number]> = []
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing') continue
    const parcel = w.parcelOf(b)
    if (!parcel?.developable) continue
    const price = acquisitionPrice(w, b)
    let cap = (b.yieldPerTick * RATE) / Math.max(1, price)
    for (const t of ['residential', 'retail', 'commercial', 'office'] as const) {
      if (t === b.purpose) continue
      const y = yieldPerTick(w, { ...b, purpose: t, condition: Math.max(b.condition, 0.85) })
      cap = Math.max(cap, (y * RATE) / Math.max(1, price + conversionCost(b)))
    }
    caps.push([b.id, cap, b.areaM2])
  }
  caps.sort((a, b) => a[1] - b[1])
  const rank = new Map(caps.map(([id], i) => [id, i / Math.max(1, caps.length - 1)]))
  const areas = caps.map((c) => c[2]).sort((a, b) => a - b)
  const areaP90 = areas[Math.floor(0.9 * (areas.length - 1))]
  const out = new Set<string>()
  for (const [id, , area] of caps) {
    if (area >= areaP90 && (rank.get(id) ?? 0) >= 0.5) out.add(id)
  }
  return out
}

const candidates = ceilingCandidates()
console.log(
  `# §41.3 ceiling watch — ${CHUNK}, ${SEEDS} seeds at ${BUDGET_X}x budget (${DECISION_BUDGET * BUDGET_X} decisions), gate ${BOUNDARY.gate ? 'on' : 'OFF'}`,
)
console.log(`#   ceiling candidates at day 0 (top area decile, cap rank >= 0.5): ${candidates.size}`)

for (let i = 0; i < SEEDS; i++) {
  const store = new MemoryStore()
  // event rows carry tick, not generation — the tick->generation map comes
  // from the snapshot stream, the same boundary the product uses
  const genAt: Array<[number, number]> = []
  const sim = new Simulation(seed, store, {
    agentCount: 58,
    seed: `ceiling-${i}`,
    onSnapshot({ generation }) {
      genAt.push([sim.world.tick, generation])
    },
  })
  await sim.runToDecisionBudget(DECISION_BUDGET * BUDGET_X)
  const w = sim.world
  const genOfTick = (t: number): number => {
    let g = 1
    for (const [st, sg] of genAt) {
      if (st <= t) g = sg
      else break
    }
    return g
  }

  const firstGen = new Map<string, number>()
  for (const e of store.events({ limit: 1e9 })) {
    const id = e.buildingId
    if (!id || !candidates.has(id) || firstGen.has(id)) continue
    if (e.type === 'agent_born' || e.type === 'agent_died') continue
    firstGen.set(id, genOfTick(e.tick))
  }
  const touched = [...firstGen.values()]
  const never = candidates.size - touched.length
  const byGen: Record<number, number> = {}
  for (const g of touched) byGen[g] = (byGen[g] ?? 0) + 1
  console.log(
    `#   seed ${i}: reached gen ${w.generation}; ceiling touched ${touched.length}/${candidates.size} ` +
      `(median first-touch gen ${median(touched)})  never ${never}  by gen: ${Object.entries(byGen)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([g, n]) => `g${g}:${n}`)
        .join(' ')}`,
  )
}
console.log('#   reading: candidates trading by gen 8-10 means the model self-solves free;')
console.log('#   candidates never trading holds syndication as a later mechanism decision.')
