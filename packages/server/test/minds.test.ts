/**
 * §55 tier 1: the fallthrough is the feature.
 *
 * Everything here tests the same property from different sides — that no reply
 * from a model, however wrong, can put a false number in front of a reader or
 * stall a tick. A malformed reply, a fabricated yield, a relabelled action and
 * a capitalised sentence all have to land on the same outcome as the API being
 * down: the sim's own line stands.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { validate, type MindRequest } from '../src/minds.ts'

const req: MindRequest = {
  chunkId: 'schiedam-havens',
  rationale: '4 to 5 levels, returns 8.1% on cost',
  verb: 'expand',
  agentName: 'Edith Vermeer',
  weight: 100,
}

const reply = (o: Record<string, unknown>): string => JSON.stringify(o)

test('§55: a well-formed line in the register is accepted', () => {
  const line = validate(reply({ verb: 'expand', line: 'one more floor pays for itself at 8.1%' }), req)
  assert.equal(line, 'one more floor pays for itself at 8.1%')
})

test('§55: a fabricated number is refused', () => {
  /**
   * The guard that makes this safe to put in front of a log people read as a
   * record. 9.4% never came from the sim, so however fluent the sentence is,
   * the rule-based line stands.
   */
  assert.equal(validate(reply({ verb: 'expand', line: 'worth it at 9.4% on cost' }), req), null)
  assert.equal(validate(reply({ verb: 'expand', line: 'took it from 4 to 7 levels' }), req), null)
})

test('§55: a relabelled action is refused', () => {
  // fluent, in register, and about a demolition that did not happen
  assert.equal(
    validate(reply({ verb: 'demolish', line: 'cleared it, the frame was finished' }), req),
    null,
  )
})

test('§55: anything outside §35s register is refused', () => {
  assert.equal(validate(reply({ verb: 'expand', line: 'One More Floor' }), req), null)
  assert.equal(validate(reply({ verb: 'expand', line: 'he said "worth it"' }), req), null)
  assert.equal(validate(reply({ verb: 'expand', line: 'x'.repeat(200) }), req), null)
  assert.equal(validate(reply({ verb: 'expand', line: '   ' }), req), null)
})

test('§55: malformed output is refused rather than thrown on', () => {
  // every one of these is something a model can actually emit under load
  for (const bad of ['', 'not json', '{', '[]', 'null', '{"line":5}', '{"verb":"expand"}']) {
    assert.doesNotThrow(() => validate(bad, req))
    assert.equal(validate(bad, req), null)
  }
})

test('§55: numbers already in the facts may be reused freely', () => {
  const r: MindRequest = { ...req, rationale: '28m from the network, unusable without access' }
  assert.equal(
    validate(reply({ verb: 'acquire', line: '28m from a road is not a plot, it is a field' }), {
      ...r,
      verb: 'acquire',
    }),
    '28m from a road is not a plot, it is a field',
  )
})

test('§55: a trailing full stop is trimmed rather than failing the line', () => {
  assert.equal(
    validate(reply({ verb: 'expand', line: 'the site carries another floor.' }), req),
    'the site carries another floor',
  )
})
