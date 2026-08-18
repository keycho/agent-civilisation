/**
 * §22.3 and §21.6, as standing checks rather than things someone confirmed once.
 *
 * Both are boundaries that hold only as long as nobody crosses them, and both
 * are the kind of thing that would be crossed by accident and look fine: a
 * client that imports the simulation still renders, and a server that runs to
 * the calibration budget still serves frames — right up until the world stops
 * dead at 65,000 decisions and nobody has been told why.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function sources(pkg: string, exclude: string[] = []): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      if (exclude.some((e) => relative(ROOT, p).startsWith(e))) continue
      if (entry.isDirectory()) await walk(p)
      else if (entry.name.endsWith('.ts')) out.push(p)
    }
  }
  await walk(join(ROOT, pkg))
  return out
}

test('the calibration budget does not govern the live world (§22.3)', async () => {
  // 65,000 is a measurement device for tune.ts: twenty seeds are only
  // comparable if they all stop at the same point. The world has no budget —
  // it runs until the saturation rule ends a season. Conflating them would give
  // the shared world a hard ending no spectator has been told about.
  // The budget itself belongs to the harness and appears nowhere else.
  for (const f of [
    ...(await sources('packages/sim/src')),
    ...(await sources('packages/server/src')),
    ...(await sources('packages/client/src')),
    ...(await sources('packages/protocol/src')),
  ]) {
    const text = await readFile(f, 'utf8')
    assert.ok(
      !text.includes('DECISION_BUDGET'),
      `${relative(ROOT, f)} references DECISION_BUDGET; it belongs to the test harness only`,
    )
  }

  // `runToDecisionBudget` is legitimately *defined* in the simulation — it is
  // §20.9's unit and twenty seeds are only comparable if they stop together.
  // What must not happen is the live world calling it.
  for (const f of [
    ...(await sources('packages/server/src')),
    ...(await sources('packages/client/src')),
  ]) {
    const text = await readFile(f, 'utf8')
    assert.ok(
      !text.includes('runToDecisionBudget'),
      `${relative(ROOT, f)} runs to a decision budget; the live world runs to saturation`,
    )
  }
})

test('the client has no path to the simulation (§21.6)', async () => {
  // The strongest form of "pure observer" is that the simulation is
  // unreachable, not that nobody calls it.
  for (const f of await sources('packages/client/src')) {
    const text = await readFile(f, 'utf8')
    assert.ok(
      !/from '@civ\/sim/.test(text),
      `${relative(ROOT, f)} imports @civ/sim; the client is an observer`,
    )
  }
  const pkg = JSON.parse(await readFile(join(ROOT, 'packages/client/package.json'), 'utf8'))
  assert.ok(!pkg.dependencies['@civ/sim'], '@civ/client must not depend on @civ/sim')
  const vite = await readFile(join(ROOT, 'packages/client/vite.config.ts'), 'utf8')
  assert.ok(!vite.includes("'@civ/sim'"), 'vite must not alias @civ/sim into the client bundle')
})

test('nothing a client can send advances the world (§21.6)', async () => {
  const protocol = await readFile(join(ROOT, 'packages/protocol/src/index.ts'), 'utf8')
  const body = protocol.slice(protocol.indexOf('export type ClientMessage'))
  const kinds = [...body.matchAll(/t: '(\w+)'/g)].map((m) => m[1])
  /**
   * The canary fires whenever the client vocabulary grows, and the answer is
   * a confirmation, not an edit. Confirmed for each:
   *
   *   inspect       reads one building out of the sim and replies
   *   inspectAgent  §47.2's character sheet — `agentDetail` reads the agent,
   *                 its plan and its holdings and replies; it writes nothing,
   *                 queues nothing, and cannot name a building into existence
   *   ping          answers with the frame clock
   *   scrub         a store query for a snapshot at an ordinal
   *
   * None of them advance the tick, seed a world, or steer an agent — every
   * one is a question the server answers about a world it alone drives.
   */
  assert.deepEqual(
    kinds.sort(),
    ['inspect', 'inspectAgent', 'ping', 'scrub'],
    'a new client message appeared; confirm it cannot advance, seed or steer the world',
  )
})
