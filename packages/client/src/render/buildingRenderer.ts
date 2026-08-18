import type { MeshData } from '@civ/core/archetype/mass.ts'
import { Group, Mesh, type Raycaster } from 'three'
import { type BatchItem, type BuildingBatch, buildBatch } from './batch.ts'
import { BuildingDataTexture } from './buildingData.ts'
import { type BuildingMaterial, createBuildingMaterial } from './buildingMaterial.ts'

/**
 * §16.2's two-batch split.
 *
 * "The baseline stock is the large static case and it stays static. Keep a
 * second batch for buildings whose geometry has actually changed shape and
 * move a building into it on first geometric mutation. Purely visual changes
 * never leave the baseline batch."
 *
 * A building's texture index is its identity in the shader. When its geometry
 * mutates it is issued a *new* index and the old one is retired to progress 0,
 * which sinks the stale copy under the ground and out of sight without
 * touching the static geometry at all.
 */

export interface BuildingSlot {
  id: string
  index: number
  batch: 'static' | 'dynamic'
}

export class BuildingRenderer {
  readonly group = new Group()
  readonly data: BuildingDataTexture
  readonly material: BuildingMaterial

  private staticBatch: BuildingBatch
  private staticMesh: Mesh
  private dynamicMesh: Mesh
  private dynamicBatch: BuildingBatch | null = null
  private dynamicItems: BatchItem[] = []
  private dynamicDirty = false

  private slots = new Map<string, BuildingSlot>()
  private nextIndex: number
  private warnedFull = false

  constructor(baseline: BatchItem[], capacity: number) {
    this.data = new BuildingDataTexture(Math.max(capacity, baseline.length))
    this.material = createBuildingMaterial(this.data)

    this.staticBatch = buildBatch(baseline)
    this.staticMesh = new Mesh(this.staticBatch.geometry, this.material)
    this.staticMesh.castShadow = true
    this.staticMesh.receiveShadow = true
    this.group.add(this.staticMesh)

    this.dynamicMesh = new Mesh(buildBatch([]).geometry, this.material)
    this.dynamicMesh.castShadow = true
    this.dynamicMesh.receiveShadow = true
    this.dynamicMesh.frustumCulled = false
    this.group.add(this.dynamicMesh)

    baseline.forEach((item, i) => {
      this.slots.set(item.id, { id: item.id, index: i, batch: 'static' })
    })
    this.nextIndex = baseline.length
  }

  get triangles(): number {
    return this.staticBatch.triangles + (this.dynamicBatch?.triangles ?? 0)
  }

  get drawCalls(): number {
    return this.dynamicItems.length > 0 ? 2 : 1
  }

  indexOf(id: string): number | undefined {
    return this.slots.get(id)?.index
  }

  idAt(index: number): string | undefined {
    for (const s of this.slots.values()) if (s.index === index) return s.id
    return undefined
  }

  /**
   * Add or reshape a building. Called for agent construction, expansion and
   * replacement — anything that changes geometry rather than just state.
   */
  setGeometry(id: string, mesh: MeshData, baseY: number): number {
    const existing = this.slots.get(id)
    if (existing) {
      // retire the old copy: progress 0 sinks it under the ground
      this.data.setProgress(existing.index, 0)
      if (existing.batch === 'dynamic') {
        const i = this.dynamicItems.findIndex((it) => it.id === indexKey(existing.index))
        if (i >= 0) this.dynamicItems.splice(i, 1)
      }
    }

    const index = this.nextIndex++
    if (index >= this.data.count) {
      // Throwing here fires once per new building, every frame, forever — which
      // buries the cause under its own symptom. Say it once and keep drawing
      // what is already standing.
      if (!this.warnedFull) {
        this.warnedFull = true
        console.error(
          `building data texture is full (${this.data.count}); raise BUILDING_SLOT_SPARE. ` +
            'New structures will not appear until the season turns.',
        )
      }
      this.nextIndex--
      return this.slots.get(id)?.index ?? 0
    }
    this.slots.set(id, { id, index, batch: 'dynamic' })
    this.dynamicItems.push({ id: indexKey(index), mesh, baseY })
    this.dynamicDirty = true
    return index
  }

  /**
   * §22.3: a season turns and everything the last one built is gone. Drops the
   * dynamic batch and returns every slot past the baseline, so the next season
   * starts from the same ground the first one did rather than accumulating.
   */
  resetToBaseline(baselineCount: number): void {
    this.warnedFull = false
    this.dynamicItems = []
    this.dynamicDirty = true
    for (const [id, slot] of this.slots) if (slot.index >= baselineCount) this.slots.delete(id)
    this.nextIndex = baselineCount
  }

  /** Rebuild the dynamic batch if anything moved. Call once per frame. */
  flush(): void {
    if (this.dynamicDirty) {
      this.dynamicBatch = buildBatch(this.dynamicItems)
      // batch indices are positional; remap them to the real texture indices
      const attr = this.dynamicBatch.geometry.getAttribute('aBuildingIndex')
      for (let i = 0; i < this.dynamicItems.length; i++) {
        const realIndex = keyIndex(this.dynamicItems[i].id)
        const start = this.dynamicBatch.vertexStart[i]
        const count = this.dynamicBatch.vertexCount[i]
        for (let v = start; v < start + count; v++) attr.setX(v, realIndex)
      }
      attr.needsUpdate = true
      this.dynamicMesh.geometry.dispose()
      this.dynamicMesh.geometry = this.dynamicBatch.geometry
      this.dynamicDirty = false
    }
    this.data.flush()
  }

  setDivergenceMode(mode: number): void {
    this.material.civ.uDivergenceMode.value = mode
  }

  /** §42.1: the chunk's material base — wall tint and roof pull. */
  setCityMaterial(m: { wall: [number, number, number]; roofTarget: string; roofW: number }): void {
    this.material.civ.uCityWall.value.setRGB(m.wall[0], m.wall[1], m.wall[2])
    this.material.civ.uCityRoof.value.set(m.roofTarget)
    this.material.civ.uCityRoofW.value = m.roofW
  }

  setHighlight(index: number): void {
    this.material.civ.uHighlight.value = index
  }

  /** §50.3: how much of the authored hour is night, and what colour the rooms are */
  setNight(night: number, warm: string): void {
    this.material.civ.uNight.value = night
    this.material.civ.uWindowWarm.value.set(warm)
  }

  /** §50.3: advance the window breath and run the relight pulses down */
  tickLights(dt: number, time: number): void {
    this.material.civ.uTime.value = time
    this.data.decayPulses(dt)
  }

  /** Which building the pointer is over, as a texture index. */
  pick(raycaster: Raycaster): number | null {
    const hits = raycaster.intersectObjects([this.staticMesh, this.dynamicMesh], false)
    for (const hit of hits) {
      if (!hit.face) continue
      const geo = (hit.object as Mesh).geometry
      const attr = geo.getAttribute('aBuildingIndex')
      if (!attr) continue
      const index = Math.round(attr.getX(hit.face.a))
      // a retired copy is under the ground; never pick it
      if (this.data.data[index * 4] === 0) continue
      return index
    }
    return null
  }
}

// The dynamic batch keys items by texture index rather than by building id,
// because a building can occupy several indices over its life.
function indexKey(index: number): string {
  return `#${index}`
}

function keyIndex(key: string): number {
  return Number(key.slice(1))
}
