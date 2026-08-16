/**
 * §31.2: the fallback country adapter — baseline buildings from OSM alone.
 *
 * The NL path joins 3DBAG lidar geometry to OSM tags. Everywhere without a
 * national height dataset, OSM is both the geometry and the only height
 * signal, and the height signal is thin: London carries `height` or
 * `building:levels` on a minority of footprints. Where both are absent the
 * levels are estimated from purpose and footprint area, and the building says
 * so — `heightSource: 'estimated'` — which rolls up into the §31.5 import
 * health manifest rather than passing as measurement.
 *
 * Construction years come from OSM `start_date` where parseable, which for
 * London is rare. That absence is what forces the §18.4 rework: the era gate
 * cannot run here, so the quality/decay asymmetry it proxied is priced
 * directly in the engine instead.
 */
import type { ChunkFrame, Purpose, Ring, RoofHint } from '@civ/core'
import type { OsmTags } from '../sources/overpass.ts'
import {
  type BaselineBuilding,
  area as ringArea,
  centroid,
  cleanRing,
  clipByConvex,
  obb,
  quantiseRing,
  ringSelfIntersects,
  selectArchetype,
  simplifyRing,
} from '@civ/core'
import type { OsmElement } from '../sources/overpass.ts'
import { purposeFromTags } from './purpose.ts'
import type { BuildingsResult } from './buildings.ts'

const SIMPLIFY_TOLERANCE_M = 0.28

/**
 * Levels by purpose when OSM carries nothing, informed by the fabric this
 * adapter is for (London low-rise): terraces and houses 2, warehouses and
 * industrial sheds 1, flats scale gently with footprint. Deliberately dumb —
 * a wrong flat estimate is visible and correctable; a clever one calcifies.
 */
function estimateLevels(purpose: Purpose, areaM2: number): number {
  switch (purpose) {
    case 'industrial':
    case 'agricultural':
    case 'utility':
      return 1
    case 'retail':
    case 'commercial':
      return 2
    case 'residential':
      return areaM2 > 400 ? Math.min(5, 3 + Math.floor(areaM2 / 600)) : 2
    default:
      return 2
  }
}

function parseHeightM(tags: OsmTags): number | undefined {
  const raw = tags['height'] ?? tags['building:height']
  if (!raw) return undefined
  const m = raw.match(/([\d.]+)/)
  if (!m) return undefined
  const v = Number(m[1])
  return Number.isFinite(v) && v > 1.8 && v < 220 ? v : undefined
}

function parseLevels(tags: OsmTags): number | undefined {
  const raw = tags['building:levels']
  if (!raw) return undefined
  const v = Number(raw)
  return Number.isFinite(v) && v >= 1 && v <= 60 ? Math.round(v) : undefined
}

function parseYear(tags: OsmTags): number | undefined {
  const raw = tags['start_date']
  if (!raw) return undefined
  const m = raw.match(/\b(1[5-9]\d\d|20[0-2]\d)\b/)
  return m ? Number(m[1]) : undefined
}

/**
 * §33.2, decided rather than inherited: terrace rows split at estimated
 * party-wall intervals.
 *
 * UK OSM maps whole rows as single ways, which pre-assembles the street: an
 * agent would buy 30 dwellings as one asset, one conversion would recolour
 * 100 m, and §22.1's grain metrics would measure the dataset's habit instead
 * of the world. Splitting makes UK grain comparable to NL grain and makes
 * assembling a terrace work again — "assembly of a terrace should be work,
 * not a data gift." Brooklyn brownstone rows get the same treatment.
 *
 * The interval is typology, not survey: UK terrace plots run 4.5-6.5 m of
 * frontage, so the row is cut into equal slabs nearest 5.2 m along its long
 * axis. Pieces are clipped from the real footprint (slabs are convex, so the
 * clip is exact even on rows with back extensions). If any piece degenerates
 * the whole row stays unsplit — a wrong split is worse than a coarse asset.
 *
 * §21.4: the emitted pieces flow through every existing geometry canary, and
 * the builder asserts area conservation per row (±4%) before emitting.
 */
const PLOT_FRONTAGE_M = 5.2
/** §33.2 travels: brooklyn brownstone lots run 20 ft, so the us row cuts at 6.1. */
const PLOT_FRONTAGE_US_M = 6.1

function splitRow(ring: Ring, tags: OsmTags, purpose: Purpose, frontageM: number): Ring[] {
  const forced = tags.building === 'terrace'
  const box = obb(ring)
  const aspect = box.length / Math.max(1e-6, box.width)
  if (!forced && !(purpose === 'residential' || purpose === 'retail')) return [ring]
  if (!forced && (box.length < 18 || aspect < 2.5)) return [ring]
  const n = Math.min(40, Math.max(2, Math.round(box.length / frontageM)))
  if (n < 2) return [ring]

  const { cx, cy, ux, uy, length, width } = box
  const vx = -uy
  const vy = ux
  const halfW = width / 2 + 2
  const step = length / n
  const pieces: Ring[] = []
  for (let k = 0; k < n; k++) {
    const lo = -length / 2 + k * step
    const hi = lo + step
    const slab: Ring = [
      [cx + ux * lo + vx * halfW, cy + uy * lo + vy * halfW],
      [cx + ux * hi + vx * halfW, cy + uy * hi + vy * halfW],
      [cx + ux * hi - vx * halfW, cy + uy * hi - vy * halfW],
      [cx + ux * lo - vx * halfW, cy + uy * lo - vy * halfW],
    ]
    const piece = quantiseRing(cleanRing(clipByConvex(ring, slab)))
    if (piece.length < 3 || ringSelfIntersects(piece) || ringArea(piece) < 8) return [ring]
    pieces.push(piece)
  }
  const total = pieces.reduce((sum, r) => sum + ringArea(r), 0)
  const original = ringArea(ring)
  if (Math.abs(total - original) > original * 0.04) return [ring]
  return pieces
}

export function buildFromOsm(
  osmBuildings: OsmElement[],
  frame: ChunkFrame,
  chunkId: string,
  clip: { minX: number; minY: number; maxX: number; maxY: number },
  opts: { split?: boolean; country?: string } = {},
): BuildingsResult {
  const doSplit = opts.split !== false
  const frontageM = opts.country === 'US' ? PLOT_FRONTAGE_US_M : PLOT_FRONTAGE_M
  const buildings: BaselineBuilding[] = []
  let matched = 0
  let unmatched = 0
  let rowsSplit = 0
  const purposeCounts: Record<string, number> = {}
  const archetypeCounts: Record<string, number> = {}

  for (const el of osmBuildings) {
    if (!el.geometry || el.geometry.length < 3) continue
    const tags = el.tags ?? {}
    const localRing = cleanRing(el.geometry.map((g) => frame.toLocal(g.lat, g.lon)))
    if (localRing.length < 3) continue

    const c = centroid(localRing)
    if (c[0] < clip.minX || c[0] > clip.maxX || c[1] < clip.minY || c[1] > clip.maxY) continue

    const simplified = simplifyRing(localRing, SIMPLIFY_TOLERANCE_M)
    const ring =
      simplified.length >= 3 && !ringSelfIntersects(simplified) ? simplified : localRing
    const a = ringArea(ring)
    if (a < 4) continue

    const taggedHeight = parseHeightM(tags)
    const taggedLevels = parseLevels(tags)
    // Purpose needs a height for its tower heuristics; give it the tagged one
    // or a provisional floor before the estimate exists.
    const purpose: Purpose = purposeFromTags(tags, a, taggedHeight ?? 6)
    const measured = taggedHeight !== undefined || taggedLevels !== undefined
    if (measured) matched++
    else unmatched++

    const levels =
      taggedLevels ??
      (taggedHeight !== undefined
        ? Math.max(1, Math.round(taggedHeight / 3.2))
        : estimateLevels(purpose, a))
    const heightM = taggedHeight ?? Math.max(2.6, levels * 3.1 + 0.8)
    const constructionYear = parseYear(tags)

    const rowPieces = doSplit ? splitRow(ring, tags, purpose, frontageM) : [ring]
    if (rowPieces.length > 1) rowsSplit++

    for (let k = 0; k < rowPieces.length; k++) {
      const piece = rowPieces[k]
      const choice = selectArchetype({
        footprint: piece,
        heightM,
        levels,
        purpose,
        constructionYear,
        source: 'real_world',
        country: opts.country,
        // no national roof dataset here: the archetype selector treats roof
        // form as a hint, absent is a supported value (§31.2)
        roofHint: 'unknown',
      })

      purposeCounts[purpose] = (purposeCounts[purpose] ?? 0) + 1
      archetypeCounts[choice.archetype] = (archetypeCounts[choice.archetype] ?? 0) + 1

      buildings.push({
        id: rowPieces.length > 1 ? `b-osm-${el.id}-t${k}` : `b-osm-${el.id}`,
        chunkId,
        osmId: `way/${el.id}`,
        footprint: piece,
        // flat-datum substrate for this adapter's first pass; the seam accepts
        // a real DTM later without this field changing meaning
        groundM: 0,
        heightM,
        levels,
        constructionYear,
        purpose,
        archetype: choice.archetype,
        roofHint: 'unknown' as RoofHint,
        name: k === 0 ? tags.name : undefined,
        heightSource: measured ? 'measured' : 'estimated',
      })
    }
  }

  return { buildings, matched, unmatched, purposeCounts, archetypeCounts, rowsSplit }
}
