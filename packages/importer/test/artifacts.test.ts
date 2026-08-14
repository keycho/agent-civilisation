/**
 * §21.4: the committed artifacts are what the app and the simulation load, so
 * the checks run against them rather than against anything the importer held in
 * memory. This is the standing form of the rule — the importer runs these at
 * emit time and refuses to finish if they fail, and this runs them again on
 * whatever is actually in the repository.
 *
 *   npm test
 */
import { type WorldSeed, rdFrame, seedChecks, validateSeed } from '@civ/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AREAS } from '../src/areas.ts'
import { checkSql } from '../src/emit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHUNK = 'schiedam-havens'
const jsonPath = join(HERE, '..', '..', 'client', 'public', 'world', `${CHUNK}.json`)
const sqlPath = join(HERE, '..', '..', 'persistence', 'seed', `${CHUNK}.sql`)

const seed = JSON.parse(await readFile(jsonPath, 'utf8')) as WorldSeed

test('the committed seed passes every structural canary', () => {
  for (const c of seedChecks(validateSeed(seed))) {
    assert.ok(c.ok, `${c.label}: ${c.detail}`)
  }
})

test('the committed SQL round-trips to the same ground', async () => {
  const area = AREAS[CHUNK]
  const frame = rdFrame(area.lat, area.lon)
  const r = await checkSql(sqlPath, seed, frame)

  assert.equal(r.missing, 0, `${r.missing} baseline buildings missing from the SQL`)
  assert.equal(r.rows, seed.buildings.length)
  // RD -> WGS84 through the Schreutelkamp/van Hees polynomials and back, then
  // written at 8 decimal places. Sub-centimetre is the expectation; 5 cm is the
  // bound at which the projection would be the wrong one rather than imprecise.
  assert.ok(r.worstErrorM < 0.05, `worst round-trip error ${(r.worstErrorM * 1000).toFixed(1)} mm`)
})

test('the seed carries provenance for every layer it ships', () => {
  assert.ok(seed.provenance.length >= 4)
  for (const p of seed.provenance) {
    assert.ok(p.layer && p.source && p.licence && p.retrieved, `incomplete provenance: ${p.layer}`)
  }
})
