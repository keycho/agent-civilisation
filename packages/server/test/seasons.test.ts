/**
 * §22.3: the season boundary.
 *
 * The log spans every season and a new season's tick restarts at 0, so anything
 * that filters recent events by tick alone hands a joining spectator the
 * *previous* season's feed. That is the kind of fault §18.3 is about — the
 * world looks fine, the feed is busy, and none of it is happening.
 */
import { type WorldSeed } from '@civ/core'
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

test('a new season does not report the previous season\'s events', async () => {
  const store = new DurableStore()
  const first = new WorldService({ seed, store, season: 1, rngSeed: 'test-1', throughput: 4 })
  // enough for the first season to have a feed worth replaying
  for (let i = 0; i < 40; i++) await first.advance(0.2)
  first.nextFrame()
  const before = store.eventCount()
  assert.ok(before > 50, `expected the first season to write events, got ${before}`)
  assert.ok(first.hello(1).events.length > 0, 'the first season should have a feed')

  const second = new WorldService({ seed, store, season: 2, rngSeed: 'test-2', throughput: 4 })
  // Before it has run at all, the second season has nothing to say — even
  // though the shared log is full of the first season's events and the new
  // world's tick is back at 0.
  assert.equal(
    second.hello(1).events.length,
    0,
    'a fresh season must not hand out the previous one as its history',
  )
  assert.equal(second.nextFrame().events.length, 0)

  // and once it runs, it reports its own
  for (let i = 0; i < 10; i++) await second.advance(0.2)
  assert.ok(store.eventCount() > before)
  const own = second.nextFrame().events
  assert.ok(own.length > 0, 'the second season should report its own events')
  await store.close()
})

test('the season is on the readouts a spectator sees', async () => {
  const store = new DurableStore()
  const w = new WorldService({ seed, store, season: 7, rngSeed: 'test-7' })
  assert.equal(w.readouts().season, 7)
  assert.equal(w.hello(1).readouts.season, 7)
  await store.close()
})
