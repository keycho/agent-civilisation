import type { BaselineBuilding, ChunkFrame, Ring, Substrate, SubstrateSurface } from '@civ/core'
import { cleanRing, simplifyRing } from '@civ/core'
import type { OsmElement } from '../sources/overpass.ts'

/**
 * §10/§12: the substrate contract is defined at stage 1 and held to.
 *
 * Today this is filled from OSM landcover and a flat NAP datum interpolated
 * from the BAG ground heights we already have. At stage 10 voxcity fills the
 * same struct with real terrain, canopy and coastline, and nothing downstream
 * changes. Anything that wants to know about the ground reads Substrate and
 * nothing else — that is the whole point of writing it now rather than later.
 */

const SURFACE_FOR: Array<{ key: string; value: string; kind: SubstrateSurface['kind'] }> = [
  { key: 'natural', value: 'water', kind: 'water' },
  { key: 'waterway', value: 'riverbank', kind: 'water' },
  { key: 'waterway', value: 'river', kind: 'water' },
  { key: 'waterway', value: 'canal', kind: 'water' },
  { key: 'leisure', value: 'park', kind: 'park' },
  { key: 'leisure', value: 'garden', kind: 'park' },
  { key: 'leisure', value: 'pitch', kind: 'grass' },
  { key: 'leisure', value: 'playground', kind: 'grass' },
  { key: 'landuse', value: 'grass', kind: 'grass' },
  { key: 'landuse', value: 'meadow', kind: 'grass' },
  { key: 'landuse', value: 'village_green', kind: 'grass' },
  { key: 'landuse', value: 'recreation_ground', kind: 'grass' },
  { key: 'landuse', value: 'cemetery', kind: 'park' },
  { key: 'landuse', value: 'allotments', kind: 'farmland' },
  { key: 'landuse', value: 'farmland', kind: 'farmland' },
  { key: 'landuse', value: 'orchard', kind: 'farmland' },
  { key: 'landuse', value: 'forest', kind: 'wood' },
  { key: 'landuse', value: 'brownfield', kind: 'paving' },
  { key: 'landuse', value: 'greenfield', kind: 'grass' },
  { key: 'landuse', value: 'railway', kind: 'rail' },
  { key: 'natural', value: 'wood', kind: 'wood' },
  { key: 'natural', value: 'scrub', kind: 'grass' },
  { key: 'natural', value: 'grassland', kind: 'grass' },
  { key: 'natural', value: 'wetland', kind: 'grass' },
  { key: 'natural', value: 'sand', kind: 'paving' },
  { key: 'amenity', value: 'parking', kind: 'parking' },
]

export function buildSubstrate(
  waterWays: OsmElement[],
  landcoverWays: OsmElement[],
  buildings: BaselineBuilding[],
  frame: ChunkFrame,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cellSizeM = 20,
): Substrate {
  const surfaces: SubstrateSurface[] = []

  const add = (el: OsmElement) => {
    // relation members come back without geometry; nothing to place
    if (!el.geometry || el.geometry.length < 3) return
    // `waterway=canal` is a centreline, not an area. Reading an open way as a
    // ring produces a self-intersecting polygon that swallows half the district
    // in point-in-polygon tests, so only closed ways become surfaces.
    if (!isClosed(el)) return
    const kind = kindOf(el)
    if (!kind) return
    const ring = cleanRing(el.geometry.map((g) => frame.toLocal(g.lat, g.lon)))
    if (ring.length < 3) return
    const simplified = simplifyRing(ring, 0.6)
    surfaces.push({
      kind,
      polygon: simplified.length >= 3 ? simplified : ring,
      name: el.tags?.name,
    })
  }
  for (const el of waterWays) add(el)
  for (const el of landcoverWays) add(el)

  // Water first so parks drawn over a canal do not win the depth fight.
  surfaces.sort((a, b) => rank(a.kind) - rank(b.kind))

  return {
    cellSizeM,
    ...elevationGrid(buildings, bounds, cellSizeM),
    surfaces,
    provider: 'flat-datum',
  }
}

function isClosed(el: OsmElement): boolean {
  const g = el.geometry
  if (!g || g.length < 4) return false
  const a = g[0]
  const b = g[g.length - 1]
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9
}

function kindOf(el: OsmElement): SubstrateSurface['kind'] | null {
  const tags = el.tags
  if (!tags) return null
  for (const rule of SURFACE_FOR) {
    if (tags[rule.key] === rule.value) return rule.kind
  }
  if (tags.landuse === 'industrial') return 'paving'
  return null
}

function rank(k: SubstrateSurface['kind']): number {
  switch (k) {
    case 'rail':
      return 0
    case 'farmland':
      return 1
    case 'wood':
      return 2
    case 'park':
      return 3
    case 'grass':
      return 4
    case 'parking':
      return 5
    case 'paving':
      return 6
    case 'water':
      return 7
  }
}

/**
 * Ground heights. BAG gives `b3_h_maaiveld` per building — the real ground
 * level under each one — so the datum is interpolated from those rather than
 * assumed to be zero. In Schiedam the spread is small, but the contract needs
 * to carry real values from day one or stage 10 becomes a rewrite.
 */
function elevationGrid(
  buildings: BaselineBuilding[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cellSizeM: number,
): { elevation: number[]; cols: number; rows: number; originX: number; originY: number } {
  const cols = Math.max(2, Math.ceil((bounds.maxX - bounds.minX) / cellSizeM) + 1)
  const rows = Math.max(2, Math.ceil((bounds.maxY - bounds.minY) / cellSizeM) + 1)
  const sum = new Float64Array(cols * rows)
  const count = new Float64Array(cols * rows)

  for (const b of buildings) {
    let cx = 0
    let cy = 0
    for (const p of b.footprint) {
      cx += p[0]
      cy += p[1]
    }
    cx /= b.footprint.length
    cy /= b.footprint.length
    const i = Math.round((cx - bounds.minX) / cellSizeM)
    const j = Math.round((cy - bounds.minY) / cellSizeM)
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue
    sum[j * cols + i] += b.groundM
    count[j * cols + i]++
  }

  let mean = 0
  let n = 0
  for (let k = 0; k < sum.length; k++) {
    if (count[k] > 0) {
      mean += sum[k] / count[k]
      n++
    }
  }
  mean = n > 0 ? mean / n : 0

  const elevation = new Array<number>(cols * rows)
  for (let k = 0; k < elevation.length; k++) {
    elevation[k] = count[k] > 0 ? sum[k] / count[k] : mean
  }
  // one smoothing pass so the datum does not step between adjacent samples
  const smoothed = elevation.slice()
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      let c = 0
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue
          s += elevation[jj * cols + ii]
          c++
        }
      }
      smoothed[j * cols + i] = s / c
    }
  }

  return { elevation: smoothed, cols, rows, originX: bounds.minX, originY: bounds.minY }
}

/** Water polygons in local metres, for the parcel clip in §6 step 4. */
export function waterRings(substrate: Substrate): Ring[] {
  return substrate.surfaces.filter((s) => s.kind === 'water').map((s) => s.polygon)
}
