/**
 * §31.6-4b: the courtyard-ring split, solved in the harness before import.
 *
 * Paris perimeter blocks defeat the §33.2 slab splitter: a slab cut across a
 * ring crosses the courtyard and the pieces stop meaning parcels. The
 * mansard-block parcel is a RADIAL slice of the ring — frontage on the
 * street, depth to the courtyard — so the cut is radial:
 *
 *   single closed way (C / U / full perimeter traced as one ring, no hole in
 *   the data): radial wedges from the centroid, each convex, clipped with the
 *   existing exact clip. A wedge that slices two arms of a C produces a
 *   degenerate piece and the whole ring falls back unsplit, same discipline
 *   as §33.2.
 *
 *   multipolygon donut (outer + inner rings): radial STRIPS ray-cast between
 *   the outer and inner boundaries, so no piece ever covers the courtyard.
 *
 * Both cases assert area conservation before returning pieces — against the
 * outer area for rings, against outer minus inners for donuts — and fall back
 * to the unsplit footprint on any degeneracy. "A wrong split is worse than a
 * coarse asset."
 *
 * Typology, not survey: haussmannian/faubourien parcels run 12-18 m of street
 * frontage, so the ring is cut nearest 15 m along its outer perimeter.
 */
import type { Ring } from '@civ/core'
import {
  area as ringArea,
  centroid,
  cleanRing,
  clipByConvex,
  quantiseRing,
  ringSelfIntersects,
} from '@civ/core'

export const PLOT_FRONTAGE_FR_M = 15

/** Distance from `c` along direction θ to the nearest crossing of `ring`. */
function rayHit(ring: Ring, c: [number, number], theta: number): number | null {
  const dx = Math.cos(theta)
  const dy = Math.sin(theta)
  let best: number | null = null
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[(i + 1) % ring.length]
    const ex = bx - ax
    const ey = by - ay
    const den = dx * ey - dy * ex
    if (Math.abs(den) < 1e-12) continue
    const t = ((ax - c[0]) * ey - (ay - c[1]) * ex) / den
    const s = ((ax - c[0]) * dy - (ay - c[1]) * dx) / den
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9) {
      if (best === null || t < best) best = t
    }
  }
  return best
}

function perimeterOf(ring: Ring): number {
  let p = 0
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[(i + 1) % ring.length]
    p += Math.hypot(bx - ax, by - ay)
  }
  return p
}

/**
 * Does this footprint read as a perimeter block worth a radial cut? Area big
 * enough to be a block, ring thin relative to its extent (a filled square
 * has 2A/P equal to half its side; an annulus's 2A/P is its thickness), and
 * poor fill of its own bounding circle.
 */
export function readsAsPerimeter(outer: Ring, inners: Ring[]): boolean {
  const a = ringArea(outer) - inners.reduce((s, r) => s + ringArea(r), 0)
  if (a < 600) return false
  const thickness = (2 * a) / Math.max(1e-9, perimeterOf(outer) + inners.reduce((s, r) => s + perimeterOf(r), 0))
  if (inners.length > 0) return thickness >= 6 && thickness <= 26
  // single ring: require the shape to wrap — thin relative to its span
  const c = centroid(outer)
  const maxR = Math.max(...outer.map(([x, y]) => Math.hypot(x - c[0], y - c[1])))
  const fill = a / Math.max(1e-9, Math.PI * maxR * maxR)
  return thickness >= 6 && thickness <= 26 && fill < 0.62
}

/**
 * Split a perimeter block into radial pieces of ~frontage along the outer
 * edge. Returns [outer] (with holes ignored) when the split degenerates —
 * the §33.2 whole-fallback discipline.
 */
export function splitPerimeter(
  outer: Ring,
  inners: Ring[],
  frontageM = PLOT_FRONTAGE_FR_M,
): Ring[] {
  const c = centroid(outer)
  const per = perimeterOf(outer)
  const n = Math.min(48, Math.max(3, Math.round(per / frontageM)))
  const grossOuter = ringArea(outer)
  const innerArea = inners.reduce((s, r) => s + ringArea(r), 0)
  const target = grossOuter - innerArea

  if (inners.length === 0) {
    // wedge-and-clip: wedges are convex triangles from the centroid past the
    // ring's extent, so the exact convex clip applies
    const maxR = 2 * Math.max(...outer.map(([x, y]) => Math.hypot(x - c[0], y - c[1])))
    const pieces: Ring[] = []
    for (let k = 0; k < n; k++) {
      const t0 = (k / n) * Math.PI * 2
      const t1 = ((k + 1) / n) * Math.PI * 2
      const wedge: Ring = [
        [c[0], c[1]],
        [c[0] + Math.cos(t0) * maxR, c[1] + Math.sin(t0) * maxR],
        [c[0] + Math.cos((t0 + t1) / 2) * maxR, c[1] + Math.sin((t0 + t1) / 2) * maxR],
        [c[0] + Math.cos(t1) * maxR, c[1] + Math.sin(t1) * maxR],
      ]
      const piece = quantiseRing(cleanRing(clipByConvex(outer, wedge)))
      if (piece.length < 3 || ringSelfIntersects(piece) || ringArea(piece) < 8) return [outer]
      pieces.push(piece)
    }
    const total = pieces.reduce((s, r) => s + ringArea(r), 0)
    if (Math.abs(total - target) > target * 0.04) return [outer]
    return pieces
  }

  // donut: radial strips between the outer boundary and the nearest inner
  // boundary, sampled densely enough that curved frontages keep their area
  const SAMPLES = 4
  function ringAt(theta: number): { out: [number, number]; inn: [number, number] } | null {
    const ro = rayHit(outer, c, theta)
    if (ro === null) return null
    let ri: number | null = null
    for (const inner of inners) {
      const hit = rayHit(inner, c, theta)
      if (hit !== null && (ri === null || hit < ri)) ri = hit
    }
    if (ri === null || ri >= ro) return null
    return {
      out: [c[0] + Math.cos(theta) * ro, c[1] + Math.sin(theta) * ro],
      inn: [c[0] + Math.cos(theta) * ri, c[1] + Math.sin(theta) * ri],
    }
  }
  const pieces: Ring[] = []
  for (let k = 0; k < n; k++) {
    const t0 = (k / n) * Math.PI * 2
    const t1 = ((k + 1) / n) * Math.PI * 2
    const outs: Array<[number, number]> = []
    const inns: Array<[number, number]> = []
    for (let s = 0; s <= SAMPLES; s++) {
      const at = ringAt(t0 + ((t1 - t0) * s) / SAMPLES)
      if (!at) return [outer]
      outs.push(at.out)
      inns.push(at.inn)
    }
    const piece = quantiseRing(cleanRing([...outs, ...inns.reverse()]))
    if (piece.length < 3 || ringSelfIntersects(piece) || ringArea(piece) < 8) return [outer]
    pieces.push(piece)
  }
  const total = pieces.reduce((s, r) => s + ringArea(r), 0)
  if (Math.abs(total - target) > target * 0.04) return [outer]
  return pieces
}
