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
  ShaderMaterial,
} from 'three'

/**
 * The ground, drawn from the §10 substrate contract and nothing else.
 *
 * The contract was written at stage 1 and has now been filled three ways
 * without this file learning where the ground came from: a datum interpolated
 * from BAG heights, a voxcity run, and AHN lidar via PDOK. That is the entire
 * point of writing it early — §21.5 swapped the terrain source out and the
 * renderer only had to start believing the elevation grid.
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
  /** §48.4: advances the water's moving glint; called once per frame */
  tick(time: number): void
  /**
   * §56.3: the water bodies and the level each one actually sits at. Already
   * derived here (a canal is level, and its surface is the lowest ground the
   * body touches), so the reflection cheat mirrors through the same plane the
   * water is drawn on rather than guessing a datum and floating above it.
   */
  waterPlanes: Array<{ ring: Ring; level: number }>
}

/**
 * §48.4: water works for its keep — darker, slightly glossy, a moving
 * specular glint, all in one flat-surface shader. The glint is a grazing
 * highlight toward the camera modulated by two drifting waves; nothing here
 * simulates water, it just stops the canal being the flattest thing in the
 * frame.
 */
function waterMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: DoubleSide,
    transparent: false,
    depthWrite: false,
    uniforms: {
      uShallow: { value: new Color(ENVIRONMENT.water) },
      uDeep: { value: new Color(ENVIRONMENT.waterDeep) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform float uTime;
      varying vec3 vWorld;
      void main() {
        vec3 toCam = normalize(cameraPosition - vWorld);
        // grazing angles read shallow-bright, steep looks read deep
        float grazing = 1.0 - abs(toCam.y);
        vec3 base = mix(uDeep, uShallow, 0.25 + 0.45 * grazing);
        // the moving glint: three incommensurate drifting waves gate a soft
        // sparkle — the third breaks the grid the first two make alone
        float w1 = sin(vWorld.x * 0.53 + uTime * 0.9 + sin(vWorld.z * 0.21));
        float w2 = sin(vWorld.z * 0.47 - uTime * 0.7 + vWorld.x * 0.13);
        float w3 = sin((vWorld.x + vWorld.z) * 0.29 + uTime * 0.35);
        float glint = pow(max(0.0, w1 * w2 * w3), 10.0) * (0.35 + 0.65 * grazing);
        base += vec3(1.0, 0.92, 0.75) * glint * 0.38;
        gl_FragColor = vec4(base, 1.0);
      }
    `,
  })
}

/**
 * §48.4: soft edge-darkening along the quays — a thin inset band at each
 * water ring's boundary. Every earcut vertex lies on the ring, so the band
 * is real geometry: the ring edge and a copy pushed inward.
 */
function quayBands(water: Array<{ ring: Ring; level: number }>): BufferGeometry | null {
  const positions: number[] = []
  const BAND = 1.7
  for (const { ring, level } of water) {
    if (ring.length < 3) continue
    // signed area decides which perpendicular points inward
    let area2 = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area2 += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1])
    }
    const sign = area2 > 0 ? 1 : -1
    const n = ring.length
    const y = level + 0.015
    for (let i = 0; i < n; i++) {
      const p0 = ring[i]
      const p1 = ring[(i + 1) % n]
      const dx = p1[0] - p0[0]
      const dy = p1[1] - p0[1]
      const len = Math.hypot(dx, dy)
      if (len < 0.05) continue
      const nx = (-dy / len) * sign * BAND
      const ny = (dx / len) * sign * BAND
      positions.push(p0[0], y, -p0[1], p1[0], y, -p1[1], p1[0] + nx, y, -(p1[1] + ny))
      positions.push(p0[0], y, -p0[1], p1[0] + nx, y, -(p1[1] + ny), p0[0] + nx, y, -(p0[1] + ny))
    }
  }
  if (!positions.length) return null
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
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

  // one merged mesh per kind: a handful of draw calls for the whole ground
  const byKind = new Map<SubstrateSurface['kind'], Ring[]>()
  for (const s of substrate.surfaces) {
    const clipped = cleanRing(clipByConvex(s.polygon, bound))
    if (clipped.length < 3) continue
    const arr = byKind.get(s.kind)
    if (arr) arr.push(clipped)
    else byKind.set(s.kind, [clipped])
  }

  /**
   * A canal is level, and AHN has no returns off water at all — the cells under
   * one were filled from the quays on either side, so the terrain grid says the
   * ground there is at quay height. Taking the lowest ground each body touches
   * puts the surface where the water actually is; carving the plate to match is
   * what stops the quay-level ground poking through it in a grid-shaped
   * staircase. §15 wants the canal cut into the ground, and this is that.
   */
  const water = (byKind.get('water') ?? []).map((ring) => {
    let lo = Infinity
    for (const [x, y] of ring) lo = Math.min(lo, sampleElevation(substrate, x, y))
    return { ring, level: lo + LAYER.water }
  })
  const groundOrWater = (x: number, y: number): number => {
    for (const w of water) if (pointInRing(w.ring, x, y)) return w.level
    return sampleElevation(substrate, x, y)
  }

  // §15: bounded, not infinite. A ground plane running to the horizon reads as
  // a map viewport; a plate that ends just past the chunk reads as an object
  // sitting in space, which is most of what makes the world feel handmade.
  //
  // §21.5: it is also displaced now rather than flat. Under `flat-datum` there
  // was nothing to displace by and a plane was honest; with AHN under it there
  // are 3.5 m of real quay-and-canal relief, and drawing that away would repeat
  // the complaint that retired voxcity — a substrate swap you cannot see.
  const segments = Math.max(1, Math.min(160, Math.round((halfExtentM * 2) / substrate.cellSizeM) * 2))
  const plate = new PlaneGeometry(halfExtentM * 2, halfExtentM * 2, segments, segments)
  const pos = plate.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    // still in plane space here: x is x, y is +north, z becomes height
    pos.setZ(i, groundOrWater(pos.getX(i), pos.getY(i)) - groundY - PLATE_DROP)
  }
  plate.computeVertexNormals()
  const base = new Mesh(plate, new MeshLambertMaterial({ color: new Color(ENVIRONMENT.ground) }))
  base.rotation.x = -Math.PI / 2
  base.position.y = groundY
  base.receiveShadow = true
  base.renderOrder = -4
  group.add(base)

  let waterMat: ShaderMaterial | null = null
  for (const [kind, rings] of byKind) {
    // Overlapping polygons of the same kind — a river drawn over its harbours —
    // are exactly coplanar and z-fight into stripes. A per-ring micro-stagger
    // is below the eye and above the depth buffer.
    // Land follows the ground; water is level, at the height computed above.
    const heightFor =
      kind === 'water'
        ? (ring: Ring) => {
            const level = water.find((w) => w.ring === ring)?.level ?? groundY + LAYER.water
            return () => level
          }
        : () => (x: number, y: number) => sampleElevation(substrate, x, y) + LAYER[kind]
    // §48.4: per-ring value jitter keyed off the ring itself — yards, lots
    // and greens stop matching their neighbours exactly
    const geo = triangulateRings(rings, heightFor, 0.03, kind !== 'water')
    if (!geo) continue
    const mesh =
      kind === 'water'
        ? new Mesh(geo, (waterMat = waterMaterial()))
        : new Mesh(
            geo,
            new MeshLambertMaterial({
              color: new Color(COLOR[kind]),
              side: DoubleSide,
              vertexColors: true,
            }),
          )
    mesh.receiveShadow = kind !== 'water'
    // A river polygon drawn over its own harbours is coplanar with itself. The
    // stagger separates them, and dropping depth writes for water makes the
    // remaining overlaps resolve by paint order instead of by a coin flip.
    mesh.renderOrder = kind === 'water' ? -3 : -2
    group.add(mesh)

    if (kind === 'water') {
      const bands = quayBands(water)
      if (bands) {
        const band = new Mesh(
          bands,
          new MeshLambertMaterial({
            color: new Color('#31434d'),
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
          }),
        )
        band.renderOrder = -2
        group.add(band)
      }
    }
  }

  return {
    group,
    groundY,
    heightAt(x, y) {
      return sampleElevation(substrate, x, y)
    },
    tick(time) {
      if (waterMat) waterMat.uniforms.uTime.value = time
    },
    waterPlanes: water,
  }
}

/** `heightFor` returns a per-vertex height function for each ring. */
function triangulateRings(
  rings: Ring[],
  heightFor: (ring: Ring) => (x: number, y: number) => number,
  stagger = 0,
  jitterColors = false,
): BufferGeometry | null {
  const positions: number[] = []
  const colors: number[] = []
  let n = 0
  for (const ring of rings) {
    if (ring.length < 3) continue
    const height = heightFor(ring)
    const lift = n++ * stagger
    // §48.4: a stable per-ring value shift — hashed off the ring's own first
    // vertex, so it never flickers between loads
    let v = 1
    if (jitterColors) {
      const h = Math.sin(ring[0][0] * 12.9898 + ring[0][1] * 78.233) * 43758.5453
      v = 0.93 + (h - Math.floor(h)) * 0.13
    }
    const flat: number[] = []
    for (const p of ring) flat.push(p[0], p[1])
    const tris = earcut(flat)
    for (let i = 0; i < tris.length; i += 3) {
      for (const k of [tris[i], tris[i + 1], tris[i + 2]]) {
        const [x, y] = ring[k]
        positions.push(x, height(x, y) + lift, -y)
        if (jitterColors) colors.push(v, v, v)
      }
    }
  }
  if (positions.length === 0) return null
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  if (jitterColors) geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
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
