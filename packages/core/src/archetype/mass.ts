import earcut from 'earcut'
import type { Ring, Vec2 } from '../types.ts'
import { type OBB, cleanRing, ensureCCW } from '../geo/polygon.ts'

/**
 * Low-level mass building. Everything an archetype form is made of goes
 * through here, so winding and normals are decided in one place.
 *
 * Working coordinates are the chunk-local 2D frame plus a height: (x east,
 * y north, h up). The renderer's convention is Y-up with north at -Z, so the
 * conversion happens once, on emit.
 *
 * Geometry is non-indexed with flat per-face normals on purpose. §15 asks for
 * clean silhouettes and faceted, readable masses rather than smooth
 * photoreal surfaces, and flat shading needs unshared vertices anyway.
 */

export const ROLE_WALL = 0
export const ROLE_ROOF = 1
export const ROLE_GROUND_FLOOR = 2
export const ROLE_TRIM = 3

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  /** 0 at the building's base, 1 at its apex. Drives the construction reveal. */
  localY: Float32Array
  /** ROLE_* — lets the shader tint roofs and shopfronts without extra draw calls. */
  role: Float32Array
  triangleCount: number
  height: number
}

type V3 = [number, number, number]

export class MassBuilder {
  private pos: number[] = []
  private nor: number[] = []
  private rol: number[] = []
  private maxH = 0

  get triangleCount(): number {
    return this.pos.length / 9
  }

  /** Vertices given in CCW order as seen from the side `outward` points at. */
  tri(a: V3, b: V3, c: V3, role: number, outward?: V3): void {
    let p = a
    let q = b
    let r = c
    let n = faceNormal(p, q, r)
    if (outward && dot(n, outward) < 0) {
      q = c
      r = b
      n = faceNormal(p, q, r)
    }
    for (const v of [p, q, r]) {
      this.pos.push(v[0], v[2], -v[1])
      this.nor.push(n[0], n[1], n[2])
      this.rol.push(role)
      if (v[2] > this.maxH) this.maxH = v[2]
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, role: number, outward?: V3): void {
    this.tri(a, b, c, role, outward)
    this.tri(a, c, d, role, outward)
  }

  /**
   * Vertical band of walls around a ring, from h0 to h1. No caps.
   * `faceInward` is for the inner leaf of a parapet.
   */
  wallBand(ring: Ring, h0: number, h1: number, role = ROLE_WALL, faceInward = false): void {
    const r = ensureCCW(cleanRing(ring))
    if (r.length < 3 || h1 <= h0) return
    const s = faceInward ? -1 : 1
    for (let i = 0, n = r.length; i < n; i++) {
      const p = r[i]
      const q = r[(i + 1) % n]
      const dx = q[0] - p[0]
      const dy = q[1] - p[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-4) continue
      // CCW ring keeps the interior on the left, so the right normal points out.
      const out: V3 = [(s * dy) / len, (-s * dx) / len, 0]
      this.quad(
        [p[0], p[1], h0],
        [q[0], q[1], h0],
        [q[0], q[1], h1],
        [p[0], p[1], h1],
        role,
        out,
      )
    }
  }

  /** Horizontal cap over a ring. `up = false` makes it face down (a soffit). */
  cap(ring: Ring, h: number, role = ROLE_ROOF, up = true): void {
    const r = ensureCCW(cleanRing(ring))
    if (r.length < 3) return
    const flat: number[] = []
    for (const p of r) flat.push(p[0], p[1])
    const tris = earcut(flat)
    const out: V3 = [0, 0, up ? 1 : -1]
    for (let i = 0; i < tris.length; i += 3) {
      const a = r[tris[i]]
      const b = r[tris[i + 1]]
      const c = r[tris[i + 2]]
      this.tri([a[0], a[1], h], [b[0], b[1], h], [c[0], c[1], h], role, out)
    }
  }

  /** Cap over a ring with a hole punched in it — the coping of a parapet. */
  capWithHole(outer: Ring, hole: Ring, h: number, role = ROLE_TRIM, up = true): void {
    const o = ensureCCW(cleanRing(outer))
    const i = ensureCCW(cleanRing(hole)).slice().reverse()
    if (o.length < 3 || i.length < 3) return this.cap(o, h, role, up)
    const flat: number[] = []
    for (const p of o) flat.push(p[0], p[1])
    for (const p of i) flat.push(p[0], p[1])
    const tris = earcut(flat, [o.length])
    const all = o.concat(i)
    const dir: V3 = [0, 0, up ? 1 : -1]
    for (let k = 0; k < tris.length; k += 3) {
      const a = all[tris[k]]
      const b = all[tris[k + 1]]
      const c = all[tris[k + 2]]
      this.tri([a[0], a[1], h], [b[0], b[1], h], [c[0], c[1], h], role, dir)
    }
  }

  /** Closed box: walls plus a top cap. The base is never drawn; nothing sees it. */
  prism(ring: Ring, h0: number, h1: number, role = ROLE_WALL, capRole = ROLE_ROOF): void {
    this.wallBand(ring, h0, h1, role)
    this.cap(ring, h1, capRole)
  }

  /**
   * Skirt between two rings at different heights — used for setbacks and for
   * the sloped shoulder under a parapet.
   */
  skirt(lower: Ring, upper: Ring, h0: number, h1: number, role = ROLE_TRIM): void {
    const a = ensureCCW(cleanRing(lower))
    const b = ensureCCW(cleanRing(upper))
    if (a.length !== b.length || a.length < 3) return
    for (let i = 0, n = a.length; i < n; i++) {
      const p0 = a[i]
      const p1 = a[(i + 1) % n]
      const q0 = b[i]
      const q1 = b[(i + 1) % n]
      const dx = p1[0] - p0[0]
      const dy = p1[1] - p0[1]
      const len = Math.hypot(dx, dy) || 1
      const out: V3 = [dy / len, -dx / len, 0.35]
      this.quad(
        [p0[0], p0[1], h0],
        [p1[0], p1[1], h0],
        [q1[0], q1[1], h1],
        [q0[0], q0[1], h1],
        role,
        out,
      )
    }
  }

  build(): MeshData {
    const n = this.pos.length / 3
    const localY = new Float32Array(n)
    const h = this.maxH || 1
    for (let i = 0; i < n; i++) localY[i] = this.pos[i * 3 + 1] / h
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nor),
      localY,
      role: new Float32Array(this.rol),
      triangleCount: n / 3,
      height: this.maxH,
    }
  }
}

function faceNormal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = c[0] - a[0]
  const vy = c[1] - a[1]
  const vz = c[2] - a[2]
  // cross product in working space, then rotated into render space (y up, -z north)
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, nz / len, -ny / len]
}

function dot(n: V3, o: V3): number {
  // `outward` is given in working space (x, y, h); rotate it the same way.
  return n[0] * o[0] + n[1] * o[2] + n[2] * -o[1]
}

// ---------------------------------------------------------------------------
// OBB helpers — every pitched roof form is built on the oriented bounding box
// ---------------------------------------------------------------------------

/** Map oriented-box coordinates (u along the long axis, v across) to world. */
export function obbPoint(box: OBB, u: number, v: number): Vec2 {
  const vx = -box.uy
  const vy = box.ux
  return [box.cx + box.ux * u + vx * v, box.cy + box.uy * u + vy * v]
}

/** The OBB as a ring, optionally inflated (positive) or shrunk (negative). */
export function obbRing(box: OBB, inflate = 0): Ring {
  const hl = box.length / 2 + inflate
  const hw = box.width / 2 + inflate
  return [
    obbPoint(box, -hl, -hw),
    obbPoint(box, hl, -hw),
    obbPoint(box, hl, hw),
    obbPoint(box, -hl, hw),
  ]
}

/**
 * Gable roof over the oriented box, ridge along the long axis.
 *
 * Real footprints are arbitrary polygons, so the walls are extruded from the
 * true footprint and the roof is formed on the OBB. Where the plan is close to
 * rectangular — which is most Dutch fabric — the two agree and the small
 * overhang reads as eaves. Where it is not, the selector picks a flat roof
 * instead rather than letting the roof drift off the walls.
 */
export function gableRoof(
  m: MassBuilder,
  box: OBB,
  eavesH: number,
  rise: number,
  overhang = 0.35,
  hipFraction = 0,
): void {
  const hl = box.length / 2 + overhang
  const hw = box.width / 2 + overhang
  const ridgeH = eavesH + rise
  // hipFraction pulls the ridge ends inward, turning gables into hips
  const rl = hl * (1 - Math.max(0, Math.min(0.9, hipFraction)))

  const c00 = obbPoint(box, -hl, -hw)
  const c10 = obbPoint(box, hl, -hw)
  const c11 = obbPoint(box, hl, hw)
  const c01 = obbPoint(box, -hl, hw)
  const r0 = obbPoint(box, -rl, 0)
  const r1 = obbPoint(box, rl, 0)

  const side1: V3 = [-(-box.uy), -box.ux, 0.6]
  const side2: V3 = [-box.uy, box.ux, 0.6]

  m.quad(
    [c00[0], c00[1], eavesH],
    [c10[0], c10[1], eavesH],
    [r1[0], r1[1], ridgeH],
    [r0[0], r0[1], ridgeH],
    ROLE_ROOF,
    side1,
  )
  m.quad(
    [c11[0], c11[1], eavesH],
    [c01[0], c01[1], eavesH],
    [r0[0], r0[1], ridgeH],
    [r1[0], r1[1], ridgeH],
    ROLE_ROOF,
    side2,
  )

  const endA: V3 = [-box.ux, -box.uy, 0]
  const endB: V3 = [box.ux, box.uy, 0]
  if (hipFraction > 0.02) {
    m.tri(
      [c00[0], c00[1], eavesH],
      [r0[0], r0[1], ridgeH],
      [c01[0], c01[1], eavesH],
      ROLE_ROOF,
      endA,
    )
    m.tri(
      [c11[0], c11[1], eavesH],
      [r1[0], r1[1], ridgeH],
      [c10[0], c10[1], eavesH],
      ROLE_ROOF,
      endB,
    )
  } else {
    m.tri(
      [c00[0], c00[1], eavesH],
      [r0[0], r0[1], ridgeH],
      [c01[0], c01[1], eavesH],
      ROLE_WALL,
      endA,
    )
    m.tri(
      [c11[0], c11[1], eavesH],
      [r1[0], r1[1], ridgeH],
      [c10[0], c10[1], eavesH],
      ROLE_WALL,
      endB,
    )
  }
}

/**
 * Stepped gable (trapgevel). Pure silhouette work — it is the single element
 * that makes a pre-1800 Dutch canal frontage recognisable from the city
 * camera, and it costs a dozen triangles.
 */
export function steppedGableEnd(
  m: MassBuilder,
  box: OBB,
  atPositiveEnd: boolean,
  eavesH: number,
  rise: number,
  steps: number,
  thickness = 0.35,
): void {
  const hl = box.length / 2
  const hw = box.width / 2
  const u = atPositiveEnd ? hl : -hl
  const uIn = atPositiveEnd ? hl - thickness : -hl + thickness

  for (let s = 0; s < steps; s++) {
    const t0 = s / steps
    const t1 = (s + 1) / steps
    // each step spans a band of the half-width and rises to a plateau
    const v0 = hw * (1 - t0)
    const h = eavesH + rise * t1

    const ring: Ring = [
      obbPoint(box, Math.min(u, uIn), -v0),
      obbPoint(box, Math.max(u, uIn), -v0),
      obbPoint(box, Math.max(u, uIn), v0),
      obbPoint(box, Math.min(u, uIn), v0),
    ]
    m.prism(ring, eavesH - 0.4, h, ROLE_TRIM, ROLE_TRIM)
  }
}

/** Sawtooth roof: a run of asymmetric ridges across the long axis. */
export function sawtoothRoof(
  m: MassBuilder,
  box: OBB,
  eavesH: number,
  rise: number,
  teeth: number,
): void {
  const hl = box.length / 2
  const hw = box.width / 2
  const step = box.length / teeth
  const up: V3 = [0, 0, 1]

  for (let i = 0; i < teeth; i++) {
    const u0 = -hl + i * step
    const u1 = u0 + step
    const uMid = u0 + step * 0.72

    const a0 = obbPoint(box, u0, -hw)
    const a1 = obbPoint(box, u0, hw)
    const m0 = obbPoint(box, uMid, -hw)
    const m1 = obbPoint(box, uMid, hw)
    const b0 = obbPoint(box, u1, -hw)
    const b1 = obbPoint(box, u1, hw)

    // sloped face rising to the ridge
    m.quad(
      [a0[0], a0[1], eavesH],
      [b0[0], b0[1], eavesH],
      [b1[0], b1[1], eavesH],
      [a1[0], a1[1], eavesH],
      ROLE_ROOF,
      up,
    )
    m.quad(
      [a0[0], a0[1], eavesH],
      [m0[0], m0[1], eavesH + rise],
      [m1[0], m1[1], eavesH + rise],
      [a1[0], a1[1], eavesH],
      ROLE_ROOF,
      up,
    )
    // vertical glazing face — the north light that makes a sawtooth readable
    m.quad(
      [m0[0], m0[1], eavesH + rise],
      [b0[0], b0[1], eavesH],
      [b1[0], b1[1], eavesH],
      [m1[0], m1[1], eavesH + rise],
      ROLE_TRIM,
      [box.ux, box.uy, 0.2],
    )
    // end walls closing the tooth
    const sideA: V3 = [-(-box.uy), -box.ux, 0]
    const sideB: V3 = [-box.uy, box.ux, 0]
    m.tri(
      [a0[0], a0[1], eavesH],
      [b0[0], b0[1], eavesH],
      [m0[0], m0[1], eavesH + rise],
      ROLE_WALL,
      sideA,
    )
    m.tri(
      [a1[0], a1[1], eavesH],
      [b1[0], b1[1], eavesH],
      [m1[0], m1[1], eavesH + rise],
      ROLE_WALL,
      sideB,
    )
  }
}

/** Pyramid or spire over a ring. */
export function spire(m: MassBuilder, ring: Ring, h0: number, rise: number): void {
  const r = ensureCCW(cleanRing(ring))
  if (r.length < 3) return
  let cx = 0
  let cy = 0
  for (const p of r) {
    cx += p[0]
    cy += p[1]
  }
  cx /= r.length
  cy /= r.length
  const apex: V3 = [cx, cy, h0 + rise]
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i]
    const q = r[(i + 1) % n]
    const mx = (p[0] + q[0]) / 2 - cx
    const my = (p[1] + q[1]) / 2 - cy
    const len = Math.hypot(mx, my) || 1
    m.tri([p[0], p[1], h0], [q[0], q[1], h0], apex, ROLE_ROOF, [mx / len, my / len, 0.5])
  }
}
