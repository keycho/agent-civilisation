import { wgsToRd } from '@civ/core/geo/rd.ts'
import type { Bbox } from './sources/overpass.ts'
import type { RdBbox } from './sources/threedbag.ts'

export interface AreaDef {
  id: string
  name: string
  /** anchor for the chunk-local frame */
  lat: number
  lon: number
  /** half-extent in metres; the chunk is a 2r x 2r square in the local frame */
  radiusM: number
  /**
   * §24.2: the axis of the fabric, in degrees clockwise from grid north. The
   * chunk is cut along this rather than along north, so the same building count
   * fills a rectangle instead of a diamond and the corners stop being dead grey.
   *
   * Measured, not chosen: bin the road graph's edge bearings mod 90, weight
   * each by its length so arterials outvote alleys, and take the peak.
   */
  bearingDeg?: number
  note: string
}

/**
 * §2's ratio problem is the reason this file exists and is short.
 *
 * Dutch historic fabric runs about 3,400 buildings per km², so the spec's
 * "0.5 to 1 km²" would land at 1,700-3,400 baseline buildings — above the
 * 400-1,500 band where divergence can saturate. The area is sized by building
 * count, not by area, and the count is the thing that was measured.
 *
 * Schiedam-Havens is chosen against §2's list rather than for postcard value:
 *   low/mid rise      old town is 2-5 storeys throughout, nothing immovable
 *   vacancy           the harbour edge carries surface parking and cleared
 *                     post-industrial plots, so agents have somewhere to build
 *   terrain character the Lange Haven and Nieuwe Haven cut through the middle
 *   variety           distillery warehouses, rowhouses, a church, industrial
 *                     sheds and the tallest windmills in the world, all inside
 *                     one 550 m square — the archetype system gets real work
 *   height coverage   3DBAG, so 100%
 */
export const AREAS: Record<string, AreaDef> = {
  'schiedam-havens': {
    id: 'schiedam-havens',
    name: 'Schiedam — Havens',
    lat: 51.9159,
    lon: 4.3959,
    radiusM: 280,
    /**
     * §24.2, MEASURED AND NOT YET APPLIED. The fabric axis here is 45.4 degrees,
     * binned off the emitted seed's road graph and weighted by edge length —
     * which is the worst case available, since a square cut against a 45-degree
     * fabric projects to a diamond of sqrt(2) its width. That is where the dead
     * corners came from, and it confirms §24.2: the rotation was never a camera
     * choice.
     *
     * Setting `bearingDeg: 45.4` here cuts along the canals and the whole
     * pipeline handles it — the re-import runs clean through parcel derivation
     * and emits 936 buildings against the current 925. It is off because the
     * emitted artifact then fails a structural canary: 2 derived parcels land
     * over a carriageway where the north-cut chunk has 0. §21.4 says the canary
     * reads the emitted file, and the importer refused to let it be committed,
     * which is the discipline working. Turning the cut on means clearing that
     * first, and it is a parcel-derivation question rather than a framing one.
     */
    // bearingDeg: 45.4,
    note: 'Historic harbour district: Lange Haven and Nieuwe Haven, distillery warehouses, post-industrial edge.',
  },
  'schiedam-wide': {
    id: 'schiedam-wide',
    name: 'Schiedam — Havens (wide)',
    lat: 51.9159,
    lon: 4.3959,
    radiusM: 420,
    note: 'Wider frame for measuring; above the ratio band.',
  },
  'dordrecht-old': {
    id: 'dordrecht-old',
    name: 'Dordrecht — Oude Haven',
    lat: 51.8162,
    lon: 4.665,
    radiusM: 260,
    note: 'Fallback: older and denser, less vacant land.',
  },
}

/**
 * §24.2: the source query is axis-aligned in RD whatever the chunk's bearing
 * is, so a rotated chunk needs a wider fetch — the bounding box of the rotated
 * square, which is r*(|cos| + |sin|) on each side and worst at 45 degrees,
 * where it is r*sqrt(2). The surplus is clipped against the local bounds after
 * import; fetching it is the price of cutting on the fabric.
 */
export function rotatedReach(a: AreaDef): number {
  const t = ((a.bearingDeg ?? 0) * Math.PI) / 180
  return a.radiusM * (Math.abs(Math.cos(t)) + Math.abs(Math.sin(t)))
}

export function rdBboxOf(a: AreaDef): RdBbox {
  const c = wgsToRd(a.lat, a.lon)
  const r = rotatedReach(a)
  return [c.x - r, c.y - r, c.x + r, c.y + r]
}

/**
 * OSM is queried on a slightly larger footprint than the chunk. Roads just
 * outside the edge still bound blocks inside it, and clipping the graph at the
 * chunk boundary would leave the outer ring of parcels unbounded.
 */
export function wgsBboxOf(a: AreaDef, marginM = 220): Bbox {
  const reach = rotatedReach(a) + marginM
  const dLat = reach / 111_320
  const dLon = reach / (111_320 * Math.cos((a.lat * Math.PI) / 180))
  return [a.lat - dLat, a.lon - dLon, a.lat + dLat, a.lon + dLon]
}
