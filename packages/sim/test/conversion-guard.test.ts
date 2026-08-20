/**
 * §74.4: do not recreate §34's dark stock.
 *
 * §34 cost several builds to a dark mass caused by stock that could not find a
 * viable use, and §74.3 has just made conversion the third mechanism bounded by
 * physical form. Over-constraining it is exactly how that comes back, so the
 * constraint is checked before the economy is asked about it: every form must
 * keep somewhere to go, on every chunk, at day 0.
 *
 * This is the cheap half of the guard and it runs in the suite. The expensive
 * half — the §37.3 admission suite and the §18.2 dark-mass instrument, re-run
 * across all chunks — is `packages/sim/test/admission.ts`, and a rise in stable
 * dark there outranks the grey bar whatever this says.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { conversionClass, conversionTargets, conversionTable } from '../src/index.ts'
import { World } from '../src/state.ts'
import { MemoryStore } from '@civ/persistence'
import { loadSeed } from './lib/summarise.ts'

/** §74.4's line: fewer than this and a form has nowhere to go */
export const MIN_TARGETS = 2

const CHUNKS = [
  'schiedam-havens',
  'london-deptford',
  'brooklyn-redhook',
  'paris-ourcq',
  'tokyo-kyojima',
  'vlaardingen-westwijk',
  'maasland-dorp',
  'maassluis-haven',
]

test('§74.4: every form keeps at least two things it can become', () => {
  for (const { kind, targets } of conversionTable()) {
    assert.ok(
      targets.length >= MIN_TARGETS,
      `'${kind}' has ${targets.length} conversion target(s) — §34's dark mass was ` +
        `stock that could not find a viable use, and this is how it returns`,
    )
  }
})

test('§74.4: and no building on any chunk is left with nowhere to go', async () => {
  const rows: string[] = []
  for (const chunk of CHUNKS) {
    const seed = await loadSeed(chunk)
    const world = new World(seed, new MemoryStore(), `targets-${chunk}`)
    const byClass = new Map<string, number>()
    let stranded = 0
    let worstId = ''
    for (const b of world.buildings.values()) {
      const kind = conversionClass(b)
      byClass.set(kind, (byClass.get(kind) ?? 0) + 1)
      /**
       * The count that matters is targets it can move TO, so its current
       * purpose does not count toward its own escape. A civic hall whose only
       * listed target is `civic` would pass a naive length check and have
       * nowhere to go.
       */
      const elsewhere = conversionTargets(b).filter((t) => t !== b.purpose)
      if (elsewhere.length < MIN_TARGETS) {
        stranded++
        if (!worstId) worstId = `${b.id} (${b.archetype}/${b.purpose} -> ${kind})`
      }
    }
    const hist = [...byClass].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`)
    rows.push(`  ${chunk.padEnd(22)} ${hist.join('  ')}`)
    assert.equal(
      stranded,
      0,
      `${chunk}: ${stranded} of ${world.buildings.size} baseline buildings have fewer than ` +
        `${MIN_TARGETS} purposes to move to — first is ${worstId}`,
    )
  }
  console.log(`§74.4 forms by chunk\n${rows.join('\n')}`)
})
