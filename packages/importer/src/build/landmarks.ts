/**
 * §42.2: landmark classification from OSM tags, at import.
 *
 * The classes are deliberately few and physical — things whose silhouette the
 * generator will spend bespoke craft on. historic=* is the catch-all for
 * stock that is protected-ish in the real world; the physical classes
 * (gasholder, water tower, crane, church, station) each get their own form.
 * The flag is data, not policy: economics prices landmarks expensive and
 * conversion-limited, and only the small per-chunk untouchable list is ever
 * out of the market.
 */
import type { LandmarkClass } from '@civ/core'
import type { OsmTags } from '../sources/overpass.ts'

export function landmarkClassOf(tags: OsmTags): LandmarkClass | undefined {
  const manMade = tags['man_made']
  if (manMade === 'gasometer') return 'gasholder'
  if (manMade === 'water_tower') return 'water_tower'
  if (manMade === 'crane') return 'crane'
  const building = tags['building']
  if (building === 'church' || building === 'cathedral' || building === 'chapel') return 'church'
  if (tags['amenity'] === 'place_of_worship') return 'church'
  if (building === 'train_station' || tags['railway'] === 'station') return 'station'
  if (tags['historic'] && tags['historic'] !== 'no') return 'historic'
  return undefined
}
