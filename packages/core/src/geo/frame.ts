import type { ChunkOrigin, Ring, Vec2 } from '../types.ts'
import { rdToWgs, wgsToRd } from './rd.ts'

/**
 * Chunk-local ENU metre frame (§10). Every chunk is anchored to an origin and
 * works internally in metres; nothing in the pipeline attempts a global
 * projection.
 */
export interface ChunkFrame {
  origin: ChunkOrigin
  toLocal(lat: number, lon: number): Vec2
  toWgs(x: number, y: number): { lat: number; lon: number }
}

const EARTH_R = 6378137

/** Fallback frame for anywhere without a national metric grid. */
export function enuFrame(lat0: number, lon0: number): ChunkFrame {
  const mPerDegLat = (Math.PI / 180) * EARTH_R
  const mPerDegLon = mPerDegLat * Math.cos((lat0 * Math.PI) / 180)
  return {
    origin: { lat: lat0, lon: lon0 },
    toLocal(lat, lon) {
      return [(lon - lon0) * mPerDegLon, (lat - lat0) * mPerDegLat]
    },
    toWgs(x, y) {
      return { lat: lat0 + y / mPerDegLat, lon: lon0 + x / mPerDegLon }
    },
  }
}

/**
 * Netherlands frame: local metres are RD metres offset by the origin, so
 * 3DBAG geometry needs no reprojection to reach the renderer.
 */
export function rdFrame(lat0: number, lon0: number): ChunkFrame {
  const o = wgsToRd(lat0, lon0)
  return {
    origin: { lat: lat0, lon: lon0, rdX: o.x, rdY: o.y },
    toLocal(lat, lon) {
      const p = wgsToRd(lat, lon)
      return [p.x - o.x, p.y - o.y]
    },
    toWgs(x, y) {
      return rdToWgs(x + o.x, y + o.y)
    },
  }
}

/** Local metres straight from RD, skipping the WGS84 round trip. */
export function rdToLocal(frame: ChunkFrame, rdX: number, rdY: number): Vec2 {
  const ox = frame.origin.rdX
  const oy = frame.origin.rdY
  if (ox === undefined || oy === undefined) {
    const ll = rdToWgs(rdX, rdY)
    return frame.toLocal(ll.lat, ll.lon)
  }
  return [rdX - ox, rdY - oy]
}

export function ringToWgs(frame: ChunkFrame, ring: Ring): Array<[number, number]> {
  return ring.map(([x, y]) => {
    const ll = frame.toWgs(x, y)
    return [ll.lon, ll.lat] as [number, number]
  })
}

/** WKT for a PostGIS `geometry(polygon, 4326)` column. */
export function ringToWkt(frame: ChunkFrame, ring: Ring): string {
  const pts = ringToWgs(frame, ring)
  if (pts.length === 0) return 'POLYGON EMPTY'
  const closed = pts.concat([pts[0]])
  return `POLYGON((${closed.map(([lon, lat]) => `${lon.toFixed(8)} ${lat.toFixed(8)}`).join(',')}))`
}
