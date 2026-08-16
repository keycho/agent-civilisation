/**
 * §37.3 follow-up: diagnose london's admission FINDING to a mechanism.
 *
 * The question as posed: is the ~20% measured dark new dark stock the
 * predictor cannot see, or a predictor miscalibrated on uk fabric? The §34
 * instrument set answers it — enumerated-vs-chosen said economics (dark stock
 * enumerated at 127% of touched, chosen never), so this instrument reads the
 * offered surface on the dark set: where does dark stock sit in the day-0
 * best-cap RANK, and what is it made of.
 *
 * The predictor (capConvert > 0, §34's own formula) is a feasibility test. The
 * market is a rank economy: a building that always clears the bar and never
 * wins a rank stays dark. If the dark set concentrates in the bottom tail of
 * the day-0 cap distribution, the predictor is miscalibrated as an admission
 * ruler everywhere — it predicts feasibility, not rank success — and the uk
 * question becomes whether the §33.2 split deepened the tail.
 *
 * PRE-REGISTERED before running (mine, cheap and falsifiable):
 *   - london's stable-dark set sits in the bottom quartile of day-0 best-cap
 *     rank (median dark percentile < 0.25)
 *   - terrace-split pieces are overrepresented in the dark set >= 1.5x their
 *     share of the stock (the split manufactured rank-tail depth: uk-fabric
 *     deepening, not a uk-specific predictor fault)
 *   - schiedam's dark set shows the same rank-tail signature at smaller depth
 *
 *   node packages/sim/test/dark-rank.ts <chunk> [seeds=6]
 */
import { MemoryStore } from '@civ/persistence'
import { Simulation } from '@civ/sim'
import { acquisitionPrice, conversionCost, yieldPerTick } from '@civ/sim/economy.ts'
import { BOUNDARY } from '@civ/sim/state.ts'
import { DECISION_BUDGET, loadSeed, runSeed } from './lib/summarise.ts'

BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const CHUNK = process.argv[2] ?? 'london-deptford'
const SEEDS = Number(process.argv[3] ?? 6)

const seed = await loadSeed(CHUNK)

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** day-0 offered surface over in-market stock: best cap per building */
function dayZeroCaps(): Map<string, { cap: number; area: number; split: boolean }> {
  const probe = new Simulation(seed, new MemoryStore(), { agentCount: 0, seed: 'rank' })
  const w = probe.world
  const RATE = 365
  const out = new Map<string, { cap: number; area: number; split: boolean }>()
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
    out.set(b.id, { cap, area: b.areaM2, split: /-t\d+$/.test(b.id) })
  }
  return out
}

const caps = dayZeroCaps()
const ranked = [...caps.entries()].sort((a, b) => a[1].cap - b[1].cap)
const pctile = new Map(ranked.map(([id], i) => [id, i / Math.max(1, ranked.length - 1)]))

console.log(`# dark-rank — ${CHUNK}, ${SEEDS} seeds, budget ${DECISION_BUDGET}, gate ${BOUNDARY.gate ? 'on' : 'OFF'}`)
console.log(`#   in-market standing stock: ${caps.size}`)
const splitShare = [...caps.values()].filter((v) => v.split).length / Math.max(1, caps.size)
console.log(`#   split pieces in stock: ${(splitShare * 100).toFixed(1)}%`)

// stable darkness across seeds
const darkCount = new Map<string, number>()
for (let i = 0; i < SEEDS; i++) {
  const s = await runSeed(seed, `admit-${i}`)
  for (const id of s.untouchedIds) if (caps.has(id)) darkCount.set(id, (darkCount.get(id) ?? 0) + 1)
  console.log(`#   seed ${i} done`)
}

const stableDark = [...caps.keys()].filter((id) => (darkCount.get(id) ?? 0) >= Math.ceil(SEEDS * 0.67))
const touched = [...caps.keys()].filter((id) => (darkCount.get(id) ?? 0) === 0)

const darkPct = stableDark.map((id) => pctile.get(id) ?? 0)
const touchedPct = touched.map((id) => pctile.get(id) ?? 0)
const darkSplitShare = stableDark.filter((id) => caps.get(id)?.split).length / Math.max(1, stableDark.length)
const darkAreas = stableDark.map((id) => caps.get(id)?.area ?? 0)
const touchedAreas = touched.map((id) => caps.get(id)?.area ?? 0)

console.log('# offered-surface read on the dark set')
console.log(`#   stable dark (>=${Math.ceil(SEEDS * 0.67)}/${SEEDS} seeds): ${stableDark.length} of ${caps.size} (${((stableDark.length / caps.size) * 100).toFixed(1)}%)`)
console.log(`#   median day-0 cap percentile   dark ${median(darkPct).toFixed(2)}   touched ${median(touchedPct).toFixed(2)}`)
console.log(`#   dark in bottom quartile of rank: ${((darkPct.filter((p) => p < 0.25).length / Math.max(1, darkPct.length)) * 100).toFixed(0)}%`)
console.log(`#   split pieces: ${(darkSplitShare * 100).toFixed(1)}% of dark vs ${(splitShare * 100).toFixed(1)}% of stock (${splitShare > 0 ? (darkSplitShare / splitShare).toFixed(2) : 'n/a'}x)`)
console.log(`#   median area m2                dark ${median(darkAreas).toFixed(0)}   touched ${median(touchedAreas).toFixed(0)}`)

const rankTail = median(darkPct) < 0.25
const splitDeepened = splitShare > 0 && darkSplitShare / splitShare >= 1.5
if (rankTail) {
  console.log('# MECHANISM: rank-tail dark — the predictor is a feasibility test and the')
  console.log('#   market is a rank economy; stock that always clears the bar and never wins')
  console.log(`#   a rank stays dark. ${splitDeepened ? 'Split pieces overrepresent: the §33.2 split deepens the tail on this fabric.' : 'Split pieces do NOT overrepresent: the tail is not split-manufactured.'}`)
} else {
  console.log('# MECHANISM NOT rank-tail: dark stock is spread through the rank — the excess')
  console.log('#   dark is stochastic budget allocation, not offered-surface position.')
}
