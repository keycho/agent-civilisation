import type { Purpose } from '@civ/core'
import type { OsmTags } from '../sources/overpass.ts'

/**
 * OSM tags -> the eight purposes the palette and the economy understand.
 *
 * OSM tagging is not a taxonomy, it is a pile of conventions, so this reads
 * several keys and takes the most specific answer. `building=yes` carries no
 * information at all and is very common (906 of 3,030 ways in this extract),
 * which is why the size and height fallback at the bottom matters.
 */

const BUILDING_PURPOSE: Record<string, Purpose> = {
  house: 'residential',
  detached: 'residential',
  semidetached_house: 'residential',
  terrace: 'residential',
  terraced_house: 'residential',
  residential: 'residential',
  apartments: 'residential',
  bungalow: 'residential',
  dormitory: 'residential',
  houseboat: 'residential',
  static_caravan: 'residential',

  retail: 'retail',
  shop: 'retail',
  supermarket: 'retail',
  kiosk: 'retail',
  mall: 'retail',

  commercial: 'commercial',
  hotel: 'commercial',

  office: 'office',

  industrial: 'industrial',
  warehouse: 'industrial',
  manufacture: 'industrial',
  factory: 'industrial',
  works: 'industrial',
  hangar: 'industrial',

  church: 'civic',
  chapel: 'civic',
  cathedral: 'civic',
  mosque: 'civic',
  synagogue: 'civic',
  temple: 'civic',
  monastery: 'civic',
  civic: 'civic',
  public: 'civic',
  government: 'civic',
  school: 'civic',
  college: 'civic',
  university: 'civic',
  hospital: 'civic',
  museum: 'civic',
  train_station: 'civic',
  transportation: 'civic',
  fire_station: 'civic',
  castle: 'civic',
  tower: 'civic',
  windmill: 'civic',
  watermill: 'civic',

  farm: 'agricultural',
  farm_auxiliary: 'agricultural',
  barn: 'agricultural',
  stable: 'agricultural',
  cowshed: 'agricultural',
  greenhouse: 'agricultural',
  silo: 'agricultural',
  sty: 'agricultural',

  garage: 'utility',
  garages: 'utility',
  carport: 'utility',
  shed: 'utility',
  hut: 'utility',
  service: 'utility',
  transformer_tower: 'utility',
  water_tower: 'utility',
  storage_tank: 'utility',
  roof: 'utility',
  parking: 'utility',
}

const AMENITY_PURPOSE: Record<string, Purpose> = {
  place_of_worship: 'civic',
  school: 'civic',
  college: 'civic',
  university: 'civic',
  library: 'civic',
  townhall: 'civic',
  courthouse: 'civic',
  police: 'civic',
  fire_station: 'civic',
  hospital: 'civic',
  clinic: 'civic',
  theatre: 'civic',
  community_centre: 'civic',
  arts_centre: 'civic',
  restaurant: 'retail',
  cafe: 'retail',
  bar: 'retail',
  pub: 'retail',
  fast_food: 'retail',
  bank: 'retail',
  pharmacy: 'retail',
  marketplace: 'retail',
}

export function purposeFromTags(tags: OsmTags | undefined, areaM2: number, heightM: number): Purpose {
  if (tags) {
    if (tags.shop) return 'retail'
    if (tags.office) return 'office'
    if (tags.tourism === 'hotel' || tags.tourism === 'museum') {
      return tags.tourism === 'museum' ? 'civic' : 'commercial'
    }
    const amenity = tags.amenity ? AMENITY_PURPOSE[tags.amenity] : undefined
    if (amenity) return amenity
    if (tags.man_made === 'windmill' || tags.historic) return 'civic'
    if (tags.landuse === 'industrial') return 'industrial'

    const b = tags.building
    if (b && b !== 'yes' && b !== 'construction') {
      const p = BUILDING_PURPOSE[b]
      if (p) return p
    }
  }

  // building=yes, or no OSM match at all. Size and height are the only
  // evidence left, and in this fabric they are reasonably diagnostic.
  if (areaM2 >= 900) return 'industrial'
  if (areaM2 >= 350 && heightM <= 9) return 'industrial'
  if (areaM2 <= 26 && heightM <= 4.5) return 'utility'
  return 'residential'
}
