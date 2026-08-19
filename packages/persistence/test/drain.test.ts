/**
 * §72.4: the write-behind queue is bounded, and says how it is doing.
 *
 * In production it grew monotonically — 701 to 10,736 to 18,256 queued events
 * across 1,000 seconds of uptime — and nothing reported why. Two things were
 * wrong with that. It is a leak, since the queue is memory nothing ever
 * reclaims; and it quietly falsifies §22.4's promise, which fixes the width of
 * what a crash loses at `flushMs`. An unbounded queue makes that width the
 * whole uptime.
 *
 * So the queue has a ceiling, crossing it is visible, and the tick loop stops
 * advancing the world while it is crossed. Dropping events is not a lever; the
 * only two available are a faster drain and a slower emitter.
 *
 * Needs a database, and says so rather than passing quietly without one.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import postgres from 'postgres'
import { DurableStore } from '../src/durable.ts'

const URL = process.env.CIV_TEST_DATABASE_URL
const CHUNK = 'test-drain-chunk'
/** must exceed QUEUE_CEILING in durable.ts */
const BEYOND_CEILING = 20_100

async function scrub(): Promise<void> {
  const sql = postgres(URL!, { max: 1, prepare: false, onnotice: () => {} })
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('civ.retention', 'on', true)`
      await tx`delete from events where chunk_id = ${CHUNK}`
      await tx`delete from worlds where chunk_id = ${CHUNK}`
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

test(
  '§72.4: a queue past its ceiling reports saturated, and clears',
  { skip: URL ? false : 'set CIV_TEST_DATABASE_URL to run the drain test' },
  async () => {
    await scrub()
    // a flush interval long enough that nothing drains on its own: the queue
    // has to be filled and inspected before the flusher touches it
    const store = new DurableStore({ url: URL, flushMs: 3_600_000 })
    await store.loadEventCursor()

    assert.equal(store.saturated, false, 'an empty queue is not saturated')
    for (let i = 0; i < BEYOND_CEILING; i++) {
      store.appendEvent({
        chunkId: CHUNK,
        tick: i,
        type: 'building_acquired',
        cinematicWeight: 1,
      })
    }
    assert.equal(
      store.saturated,
      true,
      `${BEYOND_CEILING} queued events must read as saturated — this is the signal the ` +
        `tick loop stops on, and without it the queue grows for as long as the process runs`,
    )

    const t0 = Date.now()
    await store.settle()
    const took = Date.now() - t0

    assert.equal(store.lag.events, 0, 'and settling clears it')
    assert.equal(store.saturated, false)
    assert.ok(
      store.drain.rowsPerSecond > 0,
      'the drain rate is measured, not inferred from a queue depth that grows',
    )

    const sql = postgres(URL!, { max: 1, prepare: false, onnotice: () => {} })
    try {
      const rows = await sql<Array<{ n: string }>>`
        select count(*) as n from events where chunk_id = ${CHUNK}`
      assert.equal(Number(rows[0].n), BEYOND_CEILING, 'every queued row is on disk')
    } finally {
      await sql.end({ timeout: 5 })
      await store.close()
    }

    console.log(
      `§72.4 drain — ${BEYOND_CEILING.toLocaleString()} events queued and cleared in ` +
        `${(took / 1000).toFixed(1)}s (${Math.round(BEYOND_CEILING / (took / 1000)).toLocaleString()} rows/s), ` +
        `busy ${store.drain.busy}`,
    )
  },
)
