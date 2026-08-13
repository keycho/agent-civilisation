import { wgsToRd } from '@civ/core/geo/rd.ts'
import type { Bbox } from './sources/overpass.ts'
import type { RdBbox } from './sources/threedbag.ts'

export interface AreaDef {
  id: string
  name: string
  /** anchor for the chunk-local frame */
  lat: number
  lon: number
  /** half-extent in metres; the chunk is a 2r x 2r square in RD metres */
  radiusM: number
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

export function rdBboxOf(a: AreaDef): RdBbox {
  const c = wgsToRd(a.lat, a.lon)
  return [c.x - a.radiusM, c.y - a.radiusM, c.x + a.radiusM, c.y + a.radiusM]
}

/**
 * OSM is queried on a slightly larger footprint than the chunk. Roads just
 * outside the edge still bound blocks inside it, and clipping the graph at the
 * chunk boundary would leave the outer ring of parcels unbounded.
 */
export function wgsBboxOf(a: AreaDef, marginM = 220): Bbox {
  const dLat = (a.radiusM + marginM) / 111_320
  const dLon = (a.radiusM + marginM) / (111_320 * Math.cos((a.lat * Math.PI) / 180))
  return [a.lat - dLat, a.lon - dLon, a.lat + dLat, a.lon + dLon]
}
