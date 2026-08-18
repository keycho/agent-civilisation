/**
 * §63.1 canary: no rendered agent label is ever an internal id.
 *
 * The regression this exists to catch shipped to production and was measured
 * there: on a fresh connection, 166 of 288 events carried no `agentName`, and
 * the client's `?? id` fallbacks put `agent-56-g2-23-g3-105-g4-171` into the
 * headline, into every story card and through the log. Names carry §60's
 * stories, §59's identity colours and §15's recurring characters, so an id in
 * that slot is not a cosmetic fault — it is the narrative layer failing open.
 *
 * The cause was that the wire resolved `agentId -> name` against the LIVE
 * world while the store retains four seasons, and a season turn rebuilds the
 * world from the seed. Every heir of a previous season resolved to nothing.
 * Generation-1 agents appeared to work only by collision: `agent-0` exists in
 * every season, so it resolved — to the wrong person.
 *
 * This asserts the fix at the level the failure occurred: events written by
 * one season must still be nameable by the NEXT season's service, which is
 * exactly what a spectator joining after a turn asks for.
 *
 * The fixture is driven by DECISIONS, not by `advance(seconds)`. Wall-clock
 * advance does as much work as the machine allows in the time given, so under
 * a loaded suite it produced fewer heirs than when the file ran alone — and a
 * canary that depends on how busy the box is will be believed when it is
 * quiet and ignored when it is not.
 */
import { type WorldSeed } from '@civ/core'
import { DurableStore } from '@civ/persistence'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WorldService } from '../src/world.ts'
import { eventWire, forgetNames } from '../src/frames.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(
  await readFile(join(HERE, '..', '..', 'client', 'public', 'world', 'schiedam-havens.json'), 'utf8'),
) as WorldSeed

/** what an internal id looks like, and what a name must never look like */
const AGENT_ID = /^agent-\d/

/** enough decisions for the first generation to die and heirs to act */
const DECISIONS = 9_000

test('§63.1: every event on the wire names its agent, across a season turn', async () => {
  forgetNames()
  const store = new DurableStore()
  const first = new WorldService({ seed, store, season: 1, rngSeed: 'names-1', throughput: 4 })
  // far enough that the first generation has died and heirs are acting —
  // heirs are the case that broke, because their ids are season-unique
  await first.sim.runToDecisionBudget(DECISIONS)
  first.nextFrame()

  const written = store.events({ limit: 1e9 })
  const heirEvents = written.filter((e) => e.agentId && /-g\d+-/.test(e.agentId))
  assert.ok(
    heirEvents.length > 0,
    `the fixture must reach a second generation to test it; saw ${written.length} events, no heirs`,
  )

  // the turn: a new world from the same seed, sharing the log
  const second = new WorldService({ seed, store, season: 2, rngSeed: 'names-2', throughput: 4 })
  await second.sim.runToDecisionBudget(20)

  const nameless: string[] = []
  const idAsName: string[] = []
  for (const e of written) {
    if (!e.agentId) continue
    const wire = eventWire(second.sim, e)
    if (!wire.agentName) nameless.push(`${e.id} ${e.type} ${e.agentId}`)
    else if (AGENT_ID.test(wire.agentName)) idAsName.push(`${e.id} ${wire.agentName}`)
  }

  console.log(
    `§63.1 name canary — ${written.length} events, ${heirEvents.length} by heirs; ` +
      `nameless after the turn: ${nameless.length}`,
  )
  assert.equal(
    idAsName.length,
    0,
    `an internal id was carried as a name: ${idAsName.slice(0, 3).join(', ')}`,
  )
  assert.equal(
    nameless.length,
    0,
    `${nameless.length} events lost their agent's name across a season turn, ` +
      `e.g. ${nameless.slice(0, 3).join(', ')}`,
  )
})

test('§63.1: rows written before the fix are still named, from agent_born', async () => {
  // production's actual state: four retained seasons of rows that carry no
  // `agentName`, because they were written before it was added. `agent_born`
  // has always carried the name, so an in-order read names everything behind it.
  const store = new DurableStore()
  const svc = new WorldService({ seed, store, season: 1, rngSeed: 'names-4', throughput: 4 })
  await svc.sim.runToDecisionBudget(DECISIONS)

  const legacy = store.events({ limit: 1e9 }).map((e) => {
    if (e.type === 'agent_born' || e.type === 'agent_died' || e.type === 'estate_transferred') {
      return e
    }
    const { agentName: _dropped, ...rest } = (e.payload ?? {}) as Record<string, unknown>
    return { ...e, payload: rest }
  })
  assert.ok(
    legacy.some((e) => e.agentId && !(e.payload as Record<string, unknown>)?.agentName),
    'the fixture must contain rows stripped of their name',
  )

  forgetNames()
  const after = new WorldService({ seed, store, season: 2, rngSeed: 'names-5', throughput: 4 })
  await after.sim.runToDecisionBudget(20)
  const nameless = legacy
    .filter((e) => e.agentId)
    .filter((e) => !eventWire(after.sim, e).agentName)
  console.log(`§63.1 legacy rows — ${legacy.length} events replayed, nameless: ${nameless.length}`)
  assert.equal(
    nameless.length,
    0,
    `${nameless.length} pre-fix rows could not be named, e.g. ${nameless
      .slice(0, 3)
      .map((e) => `${e.id} ${e.agentId}`)
      .join(', ')}`,
  )
})

test('§63.1: an heir is named after a person, not after its id', async () => {
  const store = new DurableStore()
  const svc = new WorldService({ seed, store, season: 1, rngSeed: 'names-3', throughput: 4 })
  await svc.sim.runToDecisionBudget(DECISIONS)

  const heirs = [...svc.sim.world.agents.values()].filter((a) => a.generation > 1)
  assert.ok(heirs.length > 0, 'the fixture must produce heirs')
  for (const h of heirs) {
    assert.ok(
      h.name && !AGENT_ID.test(h.name),
      `heir ${h.id} is named ${JSON.stringify(h.name)}`,
    )
    assert.ok(
      !/undefined/.test(h.name),
      `heir ${h.id} has a hole in its name: ${JSON.stringify(h.name)}`,
    )
    // §15: a dynasty keeps its house name across generations
    assert.ok(h.name.split(' ').length >= 2, `heir ${h.id} lost its house name: ${h.name}`)
  }
  console.log(`§63.1 heir naming — ${heirs.length} heirs, all named, e.g. ${heirs[0].name}`)
})
