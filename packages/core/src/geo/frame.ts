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

/**
 * Fallback frame for anywhere without a national metric grid. Carries the same
 * §24.2 fabric-axis rotation as the RD frame, because London's streets are no
 * more north-aligned than Schiedam's canals.
 */
export function enuFrame(lat0: number, lon0: number, bearingDeg = 0): ChunkFrame {
  const mPerDegLat = (Math.PI / 180) * EARTH_R
  const mPerDegLon = mPerDegLat * Math.cos((lat0 * Math.PI) / 180)
  const t = (-bearingDeg * Math.PI) / 180
  const c = Math.cos(t)
  const sn = Math.sin(t)
  return {
    origin: { lat: lat0, lon: lon0, bearingDeg },
    toLocal(lat, lon) {
      const dx = (lon - lon0) * mPerDegLon
      const dy = (lat - lat0) * mPerDegLat
      return [dx * c - dy * sn, dx * sn + dy * c]
    },
    toWgs(x, y) {
      const dx = x * c + y * sn
      const dy = -x * sn + y * c
      return { lat: lat0 + dy / mPerDegLat, lon: lon0 + dx / mPerDegLon }
    },
  }
}

/**
 * Netherlands frame: local metres are RD metres offset by the origin, so
 * 3DBAG geometry needs no reprojection to reach the renderer.
 *
 * §24.2: optionally rotated. The chunk is a square in *this* frame, so giving
 * the frame the bearing of the fabric cuts the chunk along the canals instead
 * of along grid north. Everything downstream — parcel derivation, the local
 * bounds, the plate, the camera — is already expressed in local metres and does
 * not need to know.
 *
 * Schiedam's road graph runs at 45.4 degrees to north, measured off the emitted
 * seed by binning edge bearings weighted by length. That is close to the worst
 * case available: a square cut against a 45-degree fabric projects to a diamond
 * whose width is sqrt(2) times its side, which is where the dead corners and
 * the rotated plate came from. It was never a camera choice.
 */
export function rdFrame(lat0: number, lon0: number, bearingDeg = 0): ChunkFrame {
  const o = wgsToRd(lat0, lon0)
  const t = (-bearingDeg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return {
    origin: { lat: lat0, lon: lon0, rdX: o.x, rdY: o.y, bearingDeg },
    toLocal(lat, lon) {
      const p = wgsToRd(lat, lon)
      return rotate(p.x - o.x, p.y - o.y, c, s)
    },
    toWgs(x, y) {
      // the inverse rotation is the transpose, so -s rather than a second cos/sin
      const dx = x * c + y * s
      const dy = -x * s + y * c
      return rdToWgs(dx + o.x, dy + o.y)
    },
  }
}

function rotate(dx: number, dy: number, c: number, s: number): Vec2 {
  return [dx * c - dy * s, dx * s + dy * c]
}

/** Local metres straight from RD, skipping the WGS84 round trip. */
export function rdToLocal(frame: ChunkFrame, rdX: number, rdY: number): Vec2 {
  const ox = frame.origin.rdX
  const oy = frame.origin.rdY
  if (ox === undefined || oy === undefined) {
    const ll = rdToWgs(rdX, rdY)
    return frame.toLocal(ll.lat, ll.lon)
  }
  const t = (-(frame.origin.bearingDeg ?? 0) * Math.PI) / 180
  return rotate(rdX - ox, rdY - oy, Math.cos(t), Math.sin(t))
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
