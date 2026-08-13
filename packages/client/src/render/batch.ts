import type { MeshData } from '@civ/core/archetype/mass.ts'
import { BufferAttribute, BufferGeometry } from 'three'

/**
 * §16.2. Real footprints are arbitrary polygons, so every building is unique
 * geometry and InstancedMesh is simply the wrong tool — this is the correction
 * that matters most in the spec.
 *
 * Instead: bake the archetype geometry once, merge it into one batched mesh per
 * chunk, and write a building index into a vertex attribute on every vertex of
 * that building. All mutable per-building state then lives in a data texture
 * indexed by the same number, so a building changing state is one texel write
 * rather than a geometry re-upload.
 *
 * One draw call per chunk regardless of building count.
 */

export interface BatchItem {
  id: string
  mesh: MeshData
  /** NAP ground level the building sits on */
  baseY: number
}

export interface BuildingBatch {
  geometry: BufferGeometry
  ids: string[]
  indexOf: Map<string, number>
  /** vertex ranges, so a single building can be found from a raycast hit */
  vertexStart: Uint32Array
  vertexCount: Uint32Array
  triangles: number
}

export function buildBatch(items: BatchItem[]): BuildingBatch {
  let vertices = 0
  for (const it of items) vertices += it.mesh.positions.length / 3

  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const buildingIndex = new Float32Array(vertices)
  const localY = new Float32Array(vertices)
  const role = new Float32Array(vertices)
  const height = new Float32Array(vertices)

  const ids: string[] = []
  const indexOf = new Map<string, number>()
  const vertexStart = new Uint32Array(items.length)
  const vertexCount = new Uint32Array(items.length)

  let v = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const m = it.mesh
    const n = m.positions.length / 3
    ids.push(it.id)
    indexOf.set(it.id, i)
    vertexStart[i] = v
    vertexCount[i] = n

    for (let k = 0; k < n; k++) {
      positions[(v + k) * 3] = m.positions[k * 3]
      // the mass is generated with its base at 0; place it on its own ground
      positions[(v + k) * 3 + 1] = m.positions[k * 3 + 1] + it.baseY
      positions[(v + k) * 3 + 2] = m.positions[k * 3 + 2]
      normals[(v + k) * 3] = m.normals[k * 3]
      normals[(v + k) * 3 + 1] = m.normals[k * 3 + 1]
      normals[(v + k) * 3 + 2] = m.normals[k * 3 + 2]
      buildingIndex[v + k] = i
      localY[v + k] = m.localY[k]
      role[v + k] = m.role[k]
      height[v + k] = m.height
    }
    v += n
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('aBuildingIndex', new BufferAttribute(buildingIndex, 1))
  geometry.setAttribute('aLocalY', new BufferAttribute(localY, 1))
  geometry.setAttribute('aRole', new BufferAttribute(role, 1))
  geometry.setAttribute('aHeight', new BufferAttribute(height, 1))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()

  return { geometry, ids, indexOf, vertexStart, vertexCount, triangles: vertices / 3 }
}

/** Which building a raycast hit belongs to. */
export function buildingIndexAtVertex(batch: BuildingBatch, vertexIndex: number): number {
  const attr = batch.geometry.getAttribute('aBuildingIndex') as BufferAttribute
  return Math.round(attr.getX(vertexIndex))
}
