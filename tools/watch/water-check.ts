/**
 * §56.3: how much navigable water each chunk actually has inside its plate.
 *
 * Boats are gated to dusk-or-darker hours for the same reason street lamps are
 * — a lit navigation light at golden hour is wrong. That gate plus the plate
 * clip is what decides whether the boats ever appear, so the answer belongs in
 * a runnable check rather than in a claim.
 *
 *   node tools/watch/water-check.ts
 */
import { readFileSync } from 'node:fs'
import { CITY_HOUR } from '@civ/core'
import { waterCorridors } from '../../packages/client/src/render/traffic.ts'

const CHUNKS = [
  'schiedam-havens',
  'london-deptford',
  'paris-ourcq',
  'tokyo-kyojima',
  'brooklyn-redhook',
]
// the client's plate is radius + 22; radius comes from the seed's own extent
for (const c of CHUNKS) {
  const seed = JSON.parse(readFileSync(`packages/client/public/world/${c}.json`, 'utf8'))
  const night = CITY_HOUR[c]?.night ?? 0
  for (const half of [302, 900]) {
    const cs = waterCorridors(seed.substrate.surfaces, () => 0, half)
    const len = Math.round(cs.reduce((a, x) => a + x.length, 0))
    const boats = cs.reduce((a, x) => a + Math.max(1, Math.round(x.length / 180)), 0)
    console.log(
      `${c.padEnd(17)} night=${night.toFixed(2)} half=${String(half).padEnd(4)} ` +
        `corridors=${cs.length} len=${len}m boats=${cs.length ? boats : 0}` +
        (night < 0.45 ? '  (golden hour: gated off)' : ''),
    )
  }
}
