/**
 * Action-mix readout for a chunk against the schiedam control — the §29
 * distribution comparison as a one-command instrument. Used first for
 * brooklyn's no-years note (§31.6-4a): with construction years absent,
 * startingCondition flattens to 0.7 and fabricQuality to 0.78, so the
 * renovate gradient loses its day-0 spread — this prints what the mix does.
 *
 *   node packages/sim/test/mix.ts <chunk> [seeds=3]
 */
import { BOUNDARY } from '@civ/sim/state.ts'
import { loadSeed, runSeed } from './lib/summarise.ts'

BOUNDARY.gate = process.env.CIV_BOUNDARY_GATE !== '0'

const CHUNK = process.argv[2] ?? 'brooklyn-redhook'
const SEEDS = Number(process.argv[3] ?? 3)

const KINDS = [
  'acquire_building',
  'renovate',
  'convert',
  'expand',
  'demolish',
  'develop',
  'assemble',
  'build_road',
] as const

async function mixOf(chunk: string): Promise<Record<string, number>> {
  const seed = await loadSeed(chunk)
  const totals: Record<string, number> = {}
  for (let i = 0; i < SEEDS; i++) {
    const s = await runSeed(seed, `mix-${i}`)
    for (const k of KINDS) totals[k] = (totals[k] ?? 0) + (s.actionCounts[k] ?? 0)
  }
  return totals
}

function shares(t: Record<string, number>): string {
  const sum = Object.values(t).reduce((a, b) => a + b, 0)
  return KINDS.map((k) => `${k} ${((100 * (t[k] ?? 0)) / Math.max(1, sum)).toFixed(1)}%`).join('  ')
}

console.log(`# action mix — ${CHUNK} vs schiedam-havens control, ${SEEDS} seeds each, gate ${BOUNDARY.gate ? 'on' : 'OFF'}`)
const target = await mixOf(CHUNK)
console.log(`# ${CHUNK}`)
console.log(`#   ${shares(target)}`)
const control = await mixOf('schiedam-havens')
console.log('# schiedam-havens')
console.log(`#   ${shares(control)}`)
