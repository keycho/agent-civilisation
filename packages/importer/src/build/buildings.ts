import {
  type BaselineBuilding,
  type ChunkFrame,
  type Purpose,
  type Ring,
  type RoofHint,
  area as ringArea,
  centroid,
  cleanRing,
  containsPoint,
  rdToLocal,
  selectArchetype,
  simplifyRing,
} from '@civ/core'
import type { OsmElement, OsmTags } from '../sources/overpass.ts'
import type { BagBuilding } from '../sources/threedbag.ts'
import { GridIndex, ringBounds } from '../util/grid.ts'
import { purposeFromTags } from './purpose.ts'

/**
 * 3DBAG is the geometry and the physics; OSM is the meaning.
 *
 * The join is centroid-in-polygon rather than geometric matching: a BAG
 * footprint and the OSM way drawn over it are the same building but not the
 * same polygon, and we only want the tags. Where nothing matches, purpose
 * falls back to size and height (see purpose.ts).
 */

export interface BuildingsResult {
  buildings: BaselineBuilding[]
  matched: number
  unmatched: number
  purposeCounts: Record<string, number>
  archetypeCounts: Record<string, number>
}

const SIMPLIFY_TOLERANCE_M = 0.28

export function buildBaselineBuildings(
  bag: BagBuilding[],
  osmBuildings: OsmElement[],
  frame: ChunkFrame,
  chunkId: string,
  clip: { minX: number; minY: number; maxX: number; maxY: number },
): BuildingsResult {
  // index the OSM footprints so the tag join is not 973 x 3030
  const index = new GridIndex<{ ring: Ring; tags: OsmTags; id: number }>(40)
  for (const el of osmBuildings) {
    if (!el.geometry || el.geometry.length < 3) continue
    const ring: Ring = el.geometry.map((g) => frame.toLocal(g.lat, g.lon))
    index.insert(ringBounds(ring), { ring, tags: el.tags ?? {}, id: el.id })
  }

  const buildings: BaselineBuilding[] = []
  let matched = 0
  let unmatched = 0
  const purposeCounts: Record<string, number> = {}
  const archetypeCounts: Record<string, number> = {}

  for (const b of bag) {
    const localRing = cleanRing(b.ringRd.map(([x, y]) => rdToLocal(frame, x, y)))
    if (localRing.length < 3) continue

    const c = centroid(localRing)
    if (c[0] < clip.minX || c[0] > clip.maxX || c[1] < clip.minY || c[1] > clip.maxY) continue

    // BAG footprints carry a lot of collinear detail. Simplifying at import
    // is what keeps §15's "clean silhouettes, readable masses" cheap.
    const simplified = simplifyRing(localRing, SIMPLIFY_TOLERANCE_M)
    const ring = simplified.length >= 3 ? simplified : localRing
    const a = ringArea(ring)
    if (a < 4) continue

    let tags: OsmTags | undefined
    let osmId: string | undefined
    let best = -1
    for (const cand of index.queryPoint(c)) {
      if (containsPoint(cand.ring, c)) {
        // smallest containing polygon wins: a shop inside a block outline
        const ca = ringArea(cand.ring)
        if (best < 0 || ca < best) {
          best = ca
          tags = cand.tags
          osmId = `way/${cand.id}`
        }
      }
    }
    if (tags) matched++
    else unmatched++

    const heightM = Math.max(2.2, b.heightM)
    const purpose: Purpose = purposeFromTags(tags, a, heightM)
    const levels = b.levels && b.levels > 0 ? b.levels : Math.max(1, Math.round(heightM / 3.2))
    const roofHint = normaliseRoofHint(b.roofType)

    const choice = selectArchetype({
      footprint: ring,
      heightM,
      levels,
      purpose,
      constructionYear: b.constructionYear ?? undefined,
      source: 'real_world',
      roofHint,
    })

    purposeCounts[purpose] = (purposeCounts[purpose] ?? 0) + 1
    archetypeCounts[choice.archetype] = (archetypeCounts[choice.archetype] ?? 0) + 1

    buildings.push({
      id: `b-${b.id.replace('NL.IMBAG.Pand.', '')}`,
      chunkId,
      bagId: b.id,
      osmId,
      footprint: ring,
      groundM: b.groundM,
      heightM,
      levels,
      constructionYear: b.constructionYear ?? undefined,
      purpose,
      archetype: choice.archetype,
      roofHint,
      name: tags?.name,
    })
  }

  return { buildings, matched, unmatched, purposeCounts, archetypeCounts }
}

function normaliseRoofHint(t: string | null): RoofHint {
  switch (t) {
    case 'slanted':
      return 'slanted'
    case 'horizontal':
      return 'horizontal'
    case 'multiple horizontal':
      return 'multiple horizontal'
    case 'mixed':
      return 'mixed'
    default:
      return 'unknown'
  }
}
