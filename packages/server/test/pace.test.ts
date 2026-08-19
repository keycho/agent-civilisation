/**
 * §72.2: the dial controls the pace.
 *
 * It did not. `advance(dt)` asked for `Math.max(1, Math.round(dps * dt))`
 * decisions, and at the 100 ms frame that is 1 at 'slow' (3/s) and also 1 at
 * 'normal' (14/s) — two of the five positions were the same number. Then
 * `runToThroughput` stops as soon as `issued >= target` while a single `step()`
 * issues however many decisions it happens to issue, so exactly one step ran
 * per frame and the world's rate was (decisions per step) x 10. Nothing read it
 * back. Production ran at 41.1/s with the dial on 14 and the readout saying 14.
 *
 * So this asserts the two things that were false: that the positions differ,
 * and that each lands near the number written on it. The tolerance is wide on
 * purpose — a step is granular and the budget can only average over the
 * overshoot, it cannot prevent it — but wide is not the same as absent, and 3
 * and 14 have to be distinguishable or the dial is decoration.
 */
import { type WorldSeed, THROUGHPUT } from '@civ/core'
import { DurableStore } from '@civ/persistence'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WorldService } from '../src/world.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(
  await readFile(join(HERE, '..', '..', 'client', 'public', 'world', 'schiedam-havens.json'), 'utf8'),
) as WorldSeed

/** the server's own frame, so the test drives what production drives */
const DT = 0.1
const FRAMES = 600 // 60 simulated seconds

async function rateAt(throughput: number): Promise<number> {
  const store = new DurableStore()
  const world = new WorldService({
    seed,
    store,
    season: 1,
    rngSeed: `pace-${throughput}`,
    throughput,
  })
  const before = world.sim.decisionsIssued
  for (let i = 0; i < FRAMES; i++) await world.advance(DT)
  return (world.sim.decisionsIssued - before) / (FRAMES * DT)
}

test('§72.2: each throughput position runs at the rate written on it', async () => {
  const measured: Array<{ label: string; want: number; got: number }> = []
  for (let i = 1; i < THROUGHPUT.length; i++) {
    const want = THROUGHPUT[i].decisionsPerSecond
    const got = await rateAt(i)
    measured.push({ label: THROUGHPUT[i].label, want, got })
  }

  console.log(
    `§72.2 pace — ${measured
      .map((m) => `${m.label} ${m.got.toFixed(1)}/s (asked ${m.want})`)
      .join(', ')}`,
  )

  for (const m of measured) {
    // a step is granular, so the budget averages over the overshoot rather than
    // preventing it; ±35% is the room that granularity needs and no more
    assert.ok(
      m.got >= m.want * 0.65 && m.got <= m.want * 1.35,
      `'${m.label}' asked for ${m.want} decisions/s and ran at ${m.got.toFixed(1)} — ` +
        `the dial is not controlling the pace`,
    )
  }

  const slow = measured.find((m) => m.label === 'slow')!
  const normal = measured.find((m) => m.label === 'normal')!
  assert.ok(
    normal.got > slow.got * 2,
    `'slow' ran at ${slow.got.toFixed(1)}/s and 'normal' at ${normal.got.toFixed(1)}/s — ` +
      `these were IDENTICAL before §72.2, because max(1, round(dps * 0.1)) is 1 for both`,
  )
})

test('§72.2: the readout reports what the world did, not what it was asked', async () => {
  const store = new DurableStore()
  const world = new WorldService({ seed, store, season: 1, rngSeed: 'pace-readout', throughput: 2 })
  for (let i = 0; i < 200; i++) await world.advance(DT)

  const pace = world.readouts().pace
  assert.equal(pace.target, 14, 'the dial position is still reported, as a separate fact')
  assert.ok(pace.decisionsPerSecond > 0, 'and the measured rate is populated')
  assert.ok(
    Math.abs(pace.decisionsPerSecond - world.measuredRate) < 0.001,
    'the wire carries the same measurement /health does',
  )
})
