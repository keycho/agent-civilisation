import type { Bounds2, Ring, Vec2 } from '../types.ts'

export function signedArea(ring: Ring): number {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

export function area(ring: Ring): number {
  return Math.abs(signedArea(ring))
}

export function ensureCCW(ring: Ring): Ring {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring
}

export function ensureCW(ring: Ring): Ring {
  return signedArea(ring) > 0 ? ring.slice().reverse() : ring
}

export function centroid(ring: Ring): Vec2 {
  const a = signedArea(ring)
  if (Math.abs(a) < 1e-12) return meanPoint(ring)
  let cx = 0
  let cy = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % n]
    const cross = p[0] * q[1] - q[0] * p[1]
    cx += (p[0] + q[0]) * cross
    cy += (p[1] + q[1]) * cross
  }
  return [cx / (6 * a), cy / (6 * a)]
}

export function meanPoint(ring: Ring): Vec2 {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

export function bounds(ring: Ring): Bounds2 {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

export function boundsOfMany(rings: Ring[]): Bounds2 {
  const b: Bounds2 = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const r of rings) {
    const rb = bounds(r)
    b.minX = Math.min(b.minX, rb.minX)
    b.minY = Math.min(b.minY, rb.minY)
    b.maxX = Math.max(b.maxX, rb.maxX)
    b.maxY = Math.max(b.maxY, rb.maxY)
  }
  return b
}

export function perimeter(ring: Ring): number {
  let p = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    p += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return p
}

/** Ray casting. Points exactly on the boundary are not guaranteed either way. */
export function containsPoint(ring: Ring, pt: Vec2): boolean {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1])
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

export function distanceToRing(p: Vec2, ring: Ring): number {
  let d = Infinity
  for (let i = 0, n = ring.length; i < n; i++) {
    d = Math.min(d, distanceToSegment(p, ring[i], ring[(i + 1) % n]))
  }
  return d
}

// ---------------------------------------------------------------------------
// convex hull + minimum-area oriented bounding box
// ---------------------------------------------------------------------------

export function convexHull(points: Vec2[]): Vec2[] {
  if (points.length < 4) return points.slice()
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const lower: Vec2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: Vec2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

export interface OBB {
  /** centre in world coordinates */
  cx: number
  cy: number
  /** long axis direction, unit length */
  ux: number
  uy: number
  /** extent along the long axis (the larger of the two) */
  length: number
  /** extent across the long axis */
  width: number
  /** rotation of the long axis, radians */
  angle: number
}

/**
 * Minimum-area enclosing rectangle by rotating calipers over the hull edges.
 * The long axis becomes the ridge direction for every pitched roof form, so
 * this is load bearing for the archetype generator, not just a metric.
 */
export function obb(ring: Ring): OBB {
  const hull = convexHull(ring)
  if (hull.length < 3) {
    const b = bounds(ring)
    return {
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      ux: 1,
      uy: 0,
      length: Math.max(1e-3, b.maxX - b.minX),
      width: Math.max(1e-3, b.maxY - b.minY),
      angle: 0,
    }
  }

  let best: OBB | null = null
  let bestArea = Infinity

  for (let i = 0, n = hull.length; i < n; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % n]
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const len = Math.hypot(ex, ey)
    if (len < 1e-9) continue
    const ux = ex / len
    const uy = ey / len
    // perpendicular
    const vx = -uy
    const vy = ux

    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy
      const v = p[0] * vx + p[1] * vy
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const w = maxU - minU
    const h = maxV - minV
    const a2 = w * h
    if (a2 < bestArea) {
      bestArea = a2
      const midU = (minU + maxU) / 2
      const midV = (minV + maxV) / 2
      const cx = ux * midU + vx * midV
      const cy = uy * midU + vy * midV
      // orient so that `length` is always the larger extent
      if (w >= h) {
        best = { cx, cy, ux, uy, length: w, width: h, angle: Math.atan2(uy, ux) }
      } else {
        best = { cx, cy, ux: vx, uy: vy, length: h, width: w, angle: Math.atan2(vy, vx) }
      }
    }
  }

  return best ?? obbFallback(ring)
}

function obbFallback(ring: Ring): OBB {
  const b = bounds(ring)
  return {
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
    ux: 1,
    uy: 0,
    length: Math.max(1e-3, b.maxX - b.minX),
    width: Math.max(1e-3, b.maxY - b.minY),
    angle: 0,
  }
}

export interface FootprintMetrics {
  area: number
  perimeter: number
  obb: OBB
  /** long / short. 1 = square. */
  aspect: number
  /** footprint area / obb area. 1 = a perfect rectangle. Drives roof choice. */
  rectangularity: number
  /** 4*pi*A / P^2. 1 = a circle, low = a spindly or very articulated plan. */
  compactness: number
  centroid: Vec2
}

export function footprintMetrics(ring: Ring): FootprintMetrics {
  const box = obb(ring)
  const a = area(ring)
  const p = perimeter(ring)
  const boxArea = Math.max(1e-6, box.length * box.width)
  return {
    area: a,
    perimeter: p,
    obb: box,
    aspect: box.length / Math.max(1e-6, box.width),
    rectangularity: Math.min(1, a / boxArea),
    compactness: (4 * Math.PI * a) / Math.max(1e-6, p * p),
    centroid: centroid(ring),
  }
}

// ---------------------------------------------------------------------------
// simplification and inset
// ---------------------------------------------------------------------------

/** Ramer-Douglas-Peucker on a closed ring. Keeps silhouettes clean and low poly. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring.slice()
  const open = ring.concat([ring[0]])
  const kept = rdp(open, tolerance)
  kept.pop()
  return kept.length >= 3 ? kept : ring.slice()
}

function rdp(points: Vec2[], tol: number): Vec2[] {
  if (points.length < 3) return points.slice()
  let maxD = 0
  let idx = 0
  const first = points[0]
  const last = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i], first, last)
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= tol) return [first, last]
  const left = rdp(points.slice(0, idx + 1), tol)
  const right = rdp(points.slice(idx), tol)
  left.pop()
  return left.concat(right)
}

/**
 * Naive inward offset: move every vertex along its angle bisector. Good enough
 * for plinths, setbacks and banding on convex-ish plans; degenerate results are
 * rejected by the caller comparing areas.
 */
export function insetRing(ring: Ring, d: number): Ring | null {
  const n = ring.length
  if (n < 3) return null
  const ccw = ensureCCW(ring)
  const out: Ring = []
  for (let i = 0; i < n; i++) {
    const prev = ccw[(i - 1 + n) % n]
    const cur = ccw[i]
    const next = ccw[(i + 1) % n]

    let e1x = cur[0] - prev[0]
    let e1y = cur[1] - prev[1]
    let e2x = next[0] - cur[0]
    let e2y = next[1] - cur[1]
    const l1 = Math.hypot(e1x, e1y) || 1
    const l2 = Math.hypot(e2x, e2y) || 1
    e1x /= l1
    e1y /= l1
    e2x /= l2
    e2y /= l2

    // inward normals for a CCW ring
    const n1x = e1y
    const n1y = -e1x
    const n2x = e2y
    const n2y = -e2x

    let bx = n1x + n2x
    let by = n1y + n2y
    const bl = Math.hypot(bx, by)
    if (bl < 1e-6) {
      bx = n1x
      by = n1y
    } else {
      bx /= bl
      by /= bl
    }
    // scale so the offset distance is measured perpendicular to the edges
    const cosHalf = Math.max(0.25, bx * n1x + by * n1y)
    const step = d / cosHalf
    out.push([cur[0] - bx * step, cur[1] - by * step])
  }

  const outArea = area(out)
  const inArea = area(ccw)
  if (signedArea(out) * signedArea(ccw) < 0) return null
  // negative d is an outward offset, used for cornices and eaves bands
  if (d > 0 && (outArea < 1e-3 || outArea >= inArea)) return null
  if (d < 0 && outArea <= inArea) return null
  return out
}

/** Outward offset. Positive `d` grows the ring. */
export function outsetRing(ring: Ring, d: number): Ring | null {
  return insetRing(ring, -Math.abs(d))
}

/**
 * Sutherland-Hodgman. The CLIP polygon must be convex; the subject may be
 * concave. Used to trim Voronoi cells (convex) against city blocks (concave)
 * by passing the block as subject and the cell as clip.
 */
export function clipByConvex(subject: Ring, convexClip: Ring): Ring {
  let output = ensureCCW(subject)
  const clip = ensureCCW(convexClip)
  for (let i = 0, n = clip.length; i < n; i++) {
    if (output.length === 0) return []
    const a = clip[i]
    const b = clip[(i + 1) % n]
    const input = output
    output = []
    const inside = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]
      const prev = input[(j - 1 + input.length) % input.length]
      const curIn = inside(cur)
      const prevIn = inside(prev)
      if (curIn) {
        if (!prevIn) output.push(lineIntersect(prev, cur, a, b))
        output.push(cur)
      } else if (prevIn) {
        output.push(lineIntersect(prev, cur, a, b))
      }
    }
  }
  return output
}

function lineIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 {
  const d1x = p2[0] - p1[0]
  const d1y = p2[1] - p1[1]
  const d2x = p4[0] - p3[0]
  const d2y = p4[1] - p3[1]
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-12) return [p1[0], p1[1]]
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den
  return [p1[0] + t * d1x, p1[1] + t * d1y]
}

/** Removes consecutive duplicates and near-collinear spikes. */
export function cleanRing(ring: Ring, eps = 0.05): Ring {
  const out: Ring = []
  for (const p of ring) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p)
  }
  while (out.length > 1) {
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop()
    else break
  }
  return out
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1)
}
