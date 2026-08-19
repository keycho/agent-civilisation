/**
 * §72.1's durable half: what happens when a second process opens a table the
 * first one was writing to.
 *
 * This is the corruption the instruments found in production, reproduced at
 * the seam where it lives. Before the fix, a fresh `DurableStore` allocated
 * event ids from 1 and the flush said `on conflict (id) do nothing`, so every
 * event a redeployed world wrote collided with a row from the previous deploy
 * and was dropped without a word — for as long as it took the counter to pass
 * the old total. Snapshots went the same way on `(chunk_id, season, ordinal)`,
 * seasons restarted at 1 so the rng stream replayed, and retention pruned by
 * season NUMBER, which meant reaching season 5 deleted the previous deploy's
 * season 1.
 *
 * Needs a database. Skipped without CIV_TEST_DATABASE_URL, because a test that
 * silently passes when it cannot reach the thing it is testing is the same
 * failure shape in a different coat.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import postgres from "postgres";
import { DurableStore } from "../src/durable.ts";

const URL = process.env.CIV_TEST_DATABASE_URL;
const CHUNK = "test-resume-chunk";

/**
 * The append-only trigger allows a delete only while `civ.retention` is on, and
 * `set_config(..., true)` is TRANSACTION-local — so the scrub has to be one
 * transaction or the setting is gone before the delete runs. The first version
 * of this used three separate statements and swallowed the resulting error,
 * which left rows from an earlier test in the table and made the retention test
 * fail on 85 rows it had not written. Errors here are thrown, not caught: a
 * scrub that quietly does nothing is worse than one that stops the run.
 */
async function scrub(): Promise<void> {
  const sql = postgres(URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('civ.retention', 'on', true)`;
      await tx`delete from events where chunk_id = ${CHUNK}`;
      await tx`delete from snapshots where chunk_id = ${CHUNK}`;
      await tx`delete from worlds where chunk_id = ${CHUNK}`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * §72.1's design assumes ONE writer per database: ids are allocated in the
 * process from `max(id) + 1` read at boot, which is what the spec offers as the
 * alternative to a sequence and what the server actually is. `node --test` runs
 * files concurrently, so two suites against one database break that assumption
 * and collide — and with §72.1 a collision now RAISES rather than being
 * swallowed, which is the point of the change and also why it shows up here.
 *
 * A Postgres advisory lock serialises them, which is the assumption stated as
 * code rather than worked around.
 */
async function withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
  const sql = postgres(URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(72001)`;
    return await fn();
  } finally {
    await sql`select pg_advisory_unlock(72001)`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

const wrote = (store: DurableStore, n: number, tick: number): number[] =>
  Array.from({ length: n }, (_, i) =>
    store.appendEvent({
      chunkId: CHUNK,
      tick: tick + i,
      type: "building_acquired",
      cinematicWeight: 10,
      rationale: `row ${tick + i}`,
    }),
  );

test(
  "§72.1: a second process continues the log instead of colliding with it",
  {
    skip: URL
      ? false
      : "set CIV_TEST_DATABASE_URL to run the durable resume test",
  },
  async () =>
    withWriterLock(async () => {
      await scrub();

      const first = new DurableStore({ url: URL, flushMs: 50 });
      await first.loadEventCursor();
      const firstIds = wrote(first, 40, 100);
      await first.settle();
      await first.close();

      // a redeploy: a brand new store against the table the last one left
      const second = new DurableStore({ url: URL, flushMs: 50 });
      const cursor = await second.loadEventCursor();
      assert.ok(
        cursor > Math.max(...firstIds),
        `the second process must start above the last written id — ` +
          `cursor ${cursor}, previous high ${Math.max(...firstIds)}`,
      );
      const secondIds = wrote(second, 40, 500);
      await second.settle();

      const sql = postgres(URL!, {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      try {
        const rows = await sql<Array<{ n: string }>>`
        select count(*) as n from events where chunk_id = ${CHUNK}`;
        assert.equal(
          Number(rows[0].n),
          80,
          "every event from both processes is on disk — before §72.1 the second " +
            "process's forty rows collided with the first's and were swallowed",
        );
      } finally {
        await sql.end({ timeout: 5 });
        await second.close();
      }
      assert.equal(
        new Set([...firstIds, ...secondIds]).size,
        80,
        "and no id was issued twice",
      );
    }),
);

test(
  "§72.1: the season sequence is monotonic across processes and never resets",
  {
    skip: URL
      ? false
      : "set CIV_TEST_DATABASE_URL to run the durable resume test",
  },
  async () =>
    withWriterLock(async () => {
      await scrub();

      const first = new DurableStore({ url: URL, flushMs: 50 });
      assert.equal(
        (await first.resumePoint(CHUNK)).season,
        1,
        "a chunk that has never run is at 1",
      );
      assert.equal(await first.turnSeason(CHUNK), 2);
      assert.equal(await first.turnSeason(CHUNK), 3);
      await first.close();

      const second = new DurableStore({ url: URL, flushMs: 50 });
      const point = await second.resumePoint(CHUNK);
      assert.equal(
        point.season,
        3,
        "a redeploy picks the season back up — this is the line that used to read 1, " +
          "which is why every deploy replayed the same rng stream from the beginning",
      );
      assert.equal(await second.turnSeason(CHUNK), 4);
      await second.close();
    }),
);

test(
  "§72.1: retention cannot reach a season the current world has not passed",
  {
    skip: URL
      ? false
      : "set CIV_TEST_DATABASE_URL to run the durable resume test",
  },
  async () =>
    withWriterLock(async () => {
      await scrub();
      const store = new DurableStore({ url: URL, flushMs: 50 });
      await store.loadEventCursor();

      for (const season of [1, 2, 3]) {
        store.season = season;
        wrote(store, 5, season * 1000);
      }
      await store.settle();

      // keep=4 while the world is only on season 3: nothing may be deleted
      store.season = 3;
      const kept = await store.pruneSeasons(CHUNK, 4);
      assert.equal(
        kept.events,
        0,
        "a keep window wider than the world has lived deletes nothing",
      );

      const pruned = await store.pruneSeasons(CHUNK, 2);
      assert.equal(
        pruned.events,
        5,
        "keep=2 on season 3 drops season 1 and nothing else",
      );

      const sql = postgres(URL!, {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      try {
        const rows = await sql<Array<{ season: number }>>`
        select distinct season from events where chunk_id = ${CHUNK} order by season`;
        assert.deepEqual(
          rows.map((r) => r.season),
          [2, 3],
          "the running season survives whatever `keep` says",
        );
      } finally {
        await sql.end({ timeout: 5 });
        await store.close();
      }
    }),
);

test(
  "§72.1: a world state round-trips through the store",
  {
    skip: URL
      ? false
      : "set CIV_TEST_DATABASE_URL to run the durable resume test",
  },
  async () =>
    withWriterLock(async () => {
      await scrub();
      const store = new DurableStore({ url: URL, flushMs: 50 });
      const blob = new Uint8Array([1, 2, 3, 250, 251, 252]);

      await store.resumePoint(CHUNK);
      await store.saveWorldState(CHUNK, 5, 9_000, 1_234, 77_000, blob);

      const back = await new DurableStore({
        url: URL,
        flushMs: 50,
      }).resumePoint(CHUNK);
      assert.equal(back.season, 5);
      assert.equal(back.firstEventId, 1_234);
      assert.deepEqual([...(back.state ?? [])], [...blob]);

      // ...and a season turn drops it, because a new season must not resume into
      // the world the last one ended with
      await store.turnSeason(CHUNK);
      const after = await store.resumePoint(CHUNK);
      assert.equal(after.season, 6);
      assert.equal(after.state, null);
      await store.close();
    }),
);
