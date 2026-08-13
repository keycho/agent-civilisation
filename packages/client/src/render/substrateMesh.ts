import {
  ENVIRONMENT,
  type Ring,
  type Substrate,
  type SubstrateSurface,
  cleanRing,
  clipByConvex,
} from '@civ/core'
import earcut from 'earcut'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
} from 'three'

/**
 * The ground, drawn from the §10 substrate contract and nothing else.
 *
 * Today the contract is filled by the importer from OSM landcover plus a datum
 * interpolated from BAG ground heights. At stage 10 voxcity fills the same
 * struct and this file does not change — that is the entire point of writing
 * the contract at stage 1.
 */

/**
 * Draw order by kind, as a small vertical offset above the datum. Coplanar
 * polygons z-fight, so everything gets its own millimetric shelf.
 *
 * Water is recessed, which is what makes a canal read as cut into the ground —
 * but it still has to sit above the base plate. Below it, the plate is opaque
 * and every canal in the district silently vanishes.
 */
const LAYER: Record<SubstrateSurface['kind'], number> = {
  rail: 0.04,
  farmland: 0.06,
  wood: 0.10,
  park: 0.12,
  grass: 0.14,
  parking: 0.16,
  paving: 0.18,
  water: -0.18,
}

/** How far the base plate sits below the datum, clearing every surface layer. */
const PLATE_DROP = 0.6

const COLOR: Record<SubstrateSurface['kind'], string> = {
  rail: '#9d9a94',
  farmland: '#b3b491',
  wood: '#8fa07c',
  park: ENVIRONMENT.park,
  grass: ENVIRONMENT.grass,
  parking: ENVIRONMENT.parking,
  paving: ENVIRONMENT.paving,
  water: ENVIRONMENT.water,
}

export interface SubstrateView {
  group: Group
  /** mean ground level, the datum everything else is placed against */
  groundY: number
  heightAt(x: number, y: number): number
}

/**
 * `halfExtentM` bounds the drawn world. The importer deliberately keeps landcover
 * and roads from beyond the chunk — blocks on the edge need roads outside it —
 * but drawing that overspill leaves surfaces floating past the plate in the
 * void. The data stays whole; only the render is clipped.
 */
export function createSubstrateView(substrate: Substrate, halfExtentM: number): SubstrateView {
  const group = new Group()
  const groundY = meanElevation(substrate)
  const bound: Ring = [
    [-halfExtentM, -halfExtentM],
    [halfExtentM, -halfExtentM],
    [halfExtentM, halfExtentM],
    [-halfExtentM, halfExtentM],
  ]

  // §15: bounded, not infinite. A ground plane running to the horizon reads as
  // a map viewport; a plate that ends just past the chunk reads as an object
  // sitting in space, which is most of what makes the world feel handmade.
  const base = new Mesh(
    new PlaneGeometry(halfExtentM * 2, halfExtentM * 2),
    new MeshLambertMaterial({ color: new Color(ENVIRONMENT.ground) }),
  )
  base.rotation.x = -Math.PI / 2
  base.position.y = groundY - PLATE_DROP
  base.receiveShadow = true
  base.renderOrder = -4
  group.add(base)

  // one merged mesh per kind: a handful of draw calls for the whole ground
  const byKind = new Map<SubstrateSurface['kind'], Ring[]>()
  for (const s of substrate.surfaces) {
    const clipped = cleanRing(clipByConvex(s.polygon, bound))
    if (clipped.length < 3) continue
    const arr = byKind.get(s.kind)
    if (arr) arr.push(clipped)
    else byKind.set(s.kind, [clipped])
  }

  for (const [kind, rings] of byKind) {
    // Overlapping polygons of the same kind — a river drawn over its harbours —
    // are exactly coplanar and z-fight into stripes. A per-ring micro-stagger
    // is below the eye and above the depth buffer.
    const geo = triangulateRings(rings, groundY + LAYER[kind], 0.03)
    if (!geo) continue
    const mesh = new Mesh(
      geo,
      new MeshLambertMaterial({
        color: new Color(COLOR[kind]),
        side: DoubleSide,
        // water sits below the datum; letting it take shadow makes canals read
        // as solid, so only land receives
        ...(kind === 'water' ? { emissive: new Color(ENVIRONMENT.waterDeep), emissiveIntensity: 0.18 } : {}),
      }),
    )
    mesh.receiveShadow = kind !== 'water'
    // A river polygon drawn over its own harbours is coplanar with itself. The
    // stagger separates them, and dropping depth writes for water makes the
    // remaining overlaps resolve by paint order instead of by a coin flip.
    if (kind === 'water') mesh.material.depthWrite = false
    mesh.renderOrder = kind === 'water' ? -3 : -2
    group.add(mesh)
  }

  return {
    group,
    groundY,
    heightAt(x, y) {
      return sampleElevation(substrate, x, y)
    },
  }
}

function triangulateRings(rings: Ring[], y: number, stagger = 0): BufferGeometry | null {
  const positions: number[] = []
  let n = 0
  for (const ring of rings) {
    if (ring.length < 3) continue
    const yr = y + n++ * stagger
    const flat: number[] = []
    for (const p of ring) flat.push(p[0], p[1])
    const tris = earcut(flat)
    for (let i = 0; i < tris.length; i += 3) {
      for (const k of [tris[i], tris[i + 1], tris[i + 2]]) {
        positions.push(ring[k][0], yr, -ring[k][1])
      }
    }
  }
  if (positions.length === 0) return null
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

function meanElevation(s: Substrate): number {
  let sum = 0
  for (const v of s.elevation) sum += v
  return s.elevation.length ? sum / s.elevation.length : 0
}

/** Bilinear sample of the elevation grid, clamped at the edges. */
export function sampleElevation(s: Substrate, x: number, y: number): number {
  const fx = (x - s.originX) / s.cellSizeM
  const fy = (y - s.originY) / s.cellSizeM
  const i0 = Math.max(0, Math.min(s.cols - 1, Math.floor(fx)))
  const j0 = Math.max(0, Math.min(s.rows - 1, Math.floor(fy)))
  const i1 = Math.min(s.cols - 1, i0 + 1)
  const j1 = Math.min(s.rows - 1, j0 + 1)
  const tx = Math.max(0, Math.min(1, fx - i0))
  const ty = Math.max(0, Math.min(1, fy - j0))
  const a = s.elevation[j0 * s.cols + i0]
  const b = s.elevation[j0 * s.cols + i1]
  const c = s.elevation[j1 * s.cols + i0]
  const d = s.elevation[j1 * s.cols + i1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}
