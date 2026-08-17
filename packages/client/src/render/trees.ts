/**
 * §48.4: stylized vegetation, finally. Canopy blobs instanced over green
 * landcover — three sizes, chunk-palette tinted, deterministic placement
 * hashed off each surface ring so the same seed always grows the same
 * trees. §15's rule holds: entities that read as inhabitants of a
 * miniature, not botany.
 */
import type { CityMaterial, Ring, SubstrateSurface } from '@civ/core'
import {
  Color,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
} from 'three'

const MAX_TREES = 720
/** attempted stems per square metre, by cover kind */
const DENSITY: Partial<Record<SubstrateSurface['kind'], number>> = {
  wood: 1 / 140,
  park: 1 / 320,
  grass: 1 / 900,
  farmland: 1 / 2600,
}
const SIZES = [2.6, 3.6, 4.8]

export function createTrees(
  surfaces: SubstrateSurface[],
  heightAt: (x: number, y: number) => number,
  halfExtentM: number,
  city: CityMaterial,
): InstancedMesh {
  const geo = new IcosahedronGeometry(1, 1)
  geo.scale(1, 0.82, 1)
  const material = new MeshLambertMaterial({ color: new Color('#ffffff') })
  const mesh = new InstancedMesh(geo, material, MAX_TREES)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.castShadow = true
  mesh.frustumCulled = false

  const dummy = new Object3D()
  const colour = new Color()
  const base = new Color('#6f8757')
  let n = 0

  for (const s of surfaces) {
    const density = DENSITY[s.kind]
    if (!density || n >= MAX_TREES) continue
    const ring = s.polygon
    if (ring.length < 3) continue
    const [minX, minY, maxX, maxY] = bbox(ring)
    if (maxX < -halfExtentM || minX > halfExtentM || maxY < -halfExtentM || minY > halfExtentM)
      continue
    const area = Math.abs(ringArea(ring))
    const want = Math.min(60, Math.floor(area * density))
    if (want < 1) continue
    // deterministic per-ring stream: same seed, same trees, every load
    let h = Math.abs(Math.sin(ring[0][0] * 12.9898 + ring[0][1] * 78.233) * 43758.5453) % 1
    const rand = () => (h = (h * 9301 + 0.49297) % 1)
    let placed = 0
    for (let attempt = 0; attempt < want * 6 && placed < want && n < MAX_TREES; attempt++) {
      const x = minX + rand() * (maxX - minX)
      const y = minY + rand() * (maxY - minY)
      if (Math.abs(x) > halfExtentM || Math.abs(y) > halfExtentM) continue
      if (!pointInRing(ring, x, y)) continue
      const size = SIZES[Math.floor(rand() * SIZES.length)]
      const squash = 0.9 + rand() * 0.25
      dummy.position.set(x, heightAt(x, y) + size * 0.62, -y)
      dummy.scale.set(size, size * squash, size)
      dummy.rotation.y = rand() * Math.PI
      dummy.updateMatrix()
      mesh.setMatrixAt(n, dummy.matrix)
      colour.copy(base)
      colour.offsetHSL((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.1, (rand() - 0.5) * 0.09)
      // chunk-palette tinted: the same restrained wall tint the city wears
      colour.multiply(new Color(city.wall[0], city.wall[1], city.wall[2]))
      mesh.setColorAt(n, colour)
      n++
      placed++
    }
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

function bbox(ring: Ring): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return [minX, minY, maxX, maxY]
}

function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
  }
  return a / 2
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
