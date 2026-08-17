import {
  type Ring,
  clamp01,
  generateArchetype,
  indexNodes,
  isAgentArchetype,
  type RoadEdge,
  type RoadNode,
  type WorldSeed,
} from '@civ/core'
import type { Frame, Hello, MaterialiseSpec, RoadEdgeWire } from '@civ/protocol'
import type { Mesh } from 'three'
import type { BuildingRenderer } from '../render/buildingRenderer.ts'
import { updateAgentRoads } from '../render/roadMesh.ts'
import type { ConstructionSite } from '../render/scaffold.ts'
import { eraTint, jitterFor, roofToneFor } from '../render/tones.ts'
import { fromBase64 } from './connection.ts'

/**
 * §21.6: what used to be `SimBridge`, inverted.
 *
 * The old one read a `World` this process owned and pushed it into the
 * renderer. This one takes a delta off a socket and does the same job with no
 * world behind it — the client holds geometry, a texture and enough of a lookup
 * to answer "which building is this pixel", and nothing else.
 *
 * Geometry generation stays here on purpose. §16.1's archetype generator is a
 * rendering concern, the baseline is already served as a static file, and
 * sending meshes over a socket instead of the twelve numbers they are generated
 * from would be a strange trade. The server says *what* was built; the client
 * decides what it looks like.
 */

const ROAD_GROWTH_TICKS = 150

export class Observer {
  private readonly renderer: BuildingRenderer
  private readonly agentRoadMesh: Mesh
  private readonly ground: (x: number, y: number) => number
  private readonly nodeIndex: Map<string, RoadNode>
  private readonly baselineSeed: WorldSeed
  private readonly agentEdges = new Map<string, RoadEdge>()
  /** what stands in each texture slot, so progress can drive scaffolding */
  private readonly shapeBySlot = new Map<number, ShapeRef>()
  private readonly progressBySlot = new Map<number, number>()
  private readonly fallingSlots = new Set<number>()
  private readonly baselineCount: number
  private lastRoadRebuildTick = -1
  private tick = 0
  private season = 0
  private dirty = false
  /** frames applied since the last render, for the lag readout */
  private appliedSinceRender = 0
  backlog = 0

  constructor(
    seed: WorldSeed,
    renderer: BuildingRenderer,
    agentRoadMesh: Mesh,
    ground: (x: number, y: number) => number,
  ) {
    this.renderer = renderer
    this.agentRoadMesh = agentRoadMesh
    this.ground = ground
    this.nodeIndex = indexNodes(seed.roads.nodes)
    this.baselineCount = seed.buildings.length
    this.baselineSeed = seed
    seed.buildings.forEach((b, i) => {
      this.shapeBySlot.set(i, {
        id: b.id,
        footprint: b.footprint,
        groundM: b.groundM,
        heightM: b.heightM,
      })
      this.progressBySlot.set(i, 1)
    })
  }

  /**
   * A joining spectator starts from the world as it is, not from day 0.
   *
   * §22.3: this is also the season turn. The server sends a `hello` when a
   * season ends, and it is the right message for it — "here is the world as it
   * is now" is what a spectator needs at a boundary as much as at a join. What
   * differs is that everything the last season built has to go first.
   */
  applyHello(h: Hello): void {
    if (this.season !== 0 && h.readouts.season !== this.season) this.resetToBaseline()
    this.season = h.readouts.season
    for (const spec of h.materialise) this.materialise(spec)
    for (const w of h.roads) this.addRoad(w)
    this.renderer.data.loadFrame(fromBase64(h.buildingData))
    this.syncProgressFromTexture()
    this.tick = h.readouts.tick
    this.rebuildRoads(true)
    this.dirty = true
  }

  applyFrame(f: Frame): void {
    this.tick = f.readouts.tick
    for (const spec of f.materialise) this.materialise(spec)
    for (const w of f.roads) this.addRoad(w)

    // §16.2: a state change is a texel write, and the wire carries only the
    // texels that changed since the last frame.
    const data = this.renderer.data.data
    for (let i = 0; i < f.texels.length; i += 5) {
      const slot = f.texels[i]
      const o = slot * 4
      if (o + 3 >= data.length) continue
      const before = data[o]
      data[o] = f.texels[i + 1]
      data[o + 1] = f.texels[i + 2]
      data[o + 2] = f.texels[i + 3]
      data[o + 3] = f.texels[i + 4]
      const now = data[o] / 255
      if (data[o] !== before) {
        // Progress rising is construction, falling is demolition. The wire does
        // not carry `state`, and it does not need to: the direction is the
        // distinction, and deriving it here keeps the frame four bytes wide.
        if (data[o] < before) this.fallingSlots.add(slot)
        else if (now >= 0.999) this.fallingSlots.delete(slot)
        this.progressBySlot.set(slot, now)
      }
    }
    this.renderer.data.markDirty()

    if (f.roads.length > 0 || this.roadsStillGrowing()) this.rebuildRoads()
    this.dirty = true
    this.appliedSinceRender++
  }

  /**
   * §21.6: applying a frame is CPU work; uploading is not. A viewer whose main
   * thread is busy will have several frames queued behind it, and doing a
   * texture upload and a batch rebuild for each one makes that worse in exactly
   * the situation where it can least afford it. Frames fold into the same
   * buffers and the render loop uploads once — which it has to do anyway.
   *
   * Frames are deltas, so they cannot be dropped: falling behind has to be
   * survivable rather than skippable. `backlog` is how far behind the last
   * render was, so a stalled viewer is visible instead of quietly stale.
   */
  flush(): void {
    this.backlog = Math.max(0, this.appliedSinceRender - 1)
    this.appliedSinceRender = 0
    if (!this.dirty) return
    this.dirty = false
    this.renderer.flush()
  }

  /** §22.3: back to the ground the first season started on. */
  private resetToBaseline(): void {
    this.renderer.resetToBaseline(this.baselineCount)
    this.agentEdges.clear()
    this.shapeBySlot.clear()
    this.progressBySlot.clear()
    this.fallingSlots.clear()
    this.baselineSeed.buildings.forEach((b, i) => {
      this.shapeBySlot.set(i, {
        id: b.id,
        footprint: b.footprint,
        groundM: b.groundM,
        heightM: b.heightM,
      })
      this.progressBySlot.set(i, 1)
    })
    this.lastRoadRebuildTick = -1
  }

  /** §20.4: the scrub is a texture swap, now from a server query. */
  applyScrubTexture(bytes: Uint8Array): void {
    this.renderer.data.loadFrame(bytes)
    this.syncProgressFromTexture()
    this.dirty = true
  }

  private syncProgressFromTexture(): void {
    const data = this.renderer.data.data
    this.fallingSlots.clear()
    for (const slot of this.shapeBySlot.keys()) {
      this.progressBySlot.set(slot, data[slot * 4] / 255)
    }
  }

  /** §16.5: what the construction overlay draws, derived from progress alone. */
  *sites(): Generator<ConstructionSite> {
    for (const [slot, progress] of this.progressBySlot) {
      if (progress <= 0.001 || progress >= 0.999) continue
      const shape = this.shapeBySlot.get(slot)
      if (!shape) continue
      yield {
        slot,
        footprint: shape.footprint,
        groundM: shape.groundM,
        heightM: shape.heightM,
        progress,
        falling: this.fallingSlots.has(slot),
      }
    }
  }

  idAt(index: number): string | undefined {
    return this.renderer.idAt(index)
  }

  private materialise(spec: MaterialiseSpec): void {
    const out = generateArchetype(
      {
        footprint: spec.footprint,
        heightM: spec.heightM,
        levels: spec.levels,
        purpose: spec.purpose,
        constructionYear: spec.constructionYear,
        source: spec.source,
        roofHint: spec.roofHint as never,
      },
      spec.id,
      spec.archetype as never,
    )
    const slot = this.renderer.setGeometry(spec.id, out.mesh, spec.groundM)
    this.renderer.data.setStatic(
      slot,
      roofToneFor(spec.archetype as never, out.roof, spec.constructionYear, out.metrics.area),
      jitterFor(spec.id),
      spec.source === 'agent_built' ? 0 : eraTint(spec.constructionYear),
      isAgentArchetype(spec.archetype as never),
    )
    this.shapeBySlot.set(slot, {
      id: spec.id,
      footprint: spec.footprint,
      groundM: spec.groundM,
      heightM: spec.heightM,
    })
    this.progressBySlot.set(slot, this.renderer.data.data[slot * 4] / 255)
  }

  private addRoad(w: RoadEdgeWire): void {
    // lat/lon are not on the wire and nothing downstream of the renderer reads
    // them: the client works in the chunk's local metre frame (§10)
    if (!this.nodeIndex.has(w.a)) {
      this.nodeIndex.set(w.a, { id: w.a, x: w.ax, y: w.ay, lat: 0, lon: 0 })
    }
    if (!this.nodeIndex.has(w.b)) {
      this.nodeIndex.set(w.b, { id: w.b, x: w.bx, y: w.by, lat: 0, lon: 0 })
    }
    this.agentEdges.set(w.id, {
      id: w.id,
      a: w.a,
      b: w.b,
      class: w.class,
      agentBuilt: true,
      builtTick: w.builtTick,
      length: Math.hypot(w.bx - w.ax, w.by - w.ay),
    })
  }

  private roadsStillGrowing(): boolean {
    if (this.tick === this.lastRoadRebuildTick) return false
    for (const e of this.agentEdges.values()) {
      if (this.tick - (e.builtTick ?? 0) < ROAD_GROWTH_TICKS) return true
    }
    return false
  }

  /** §16.6: growth is a length clip against ticks since `builtTick`. */
  private rebuildRoads(force = false): void {
    if (!force && this.agentEdges.size === 0) return
    this.lastRoadRebuildTick = this.tick
    updateAgentRoads(
      this.agentRoadMesh,
      this.nodeIndex,
      [...this.agentEdges.values()],
      this.ground,
      (e) => clamp01((this.tick - (e.builtTick ?? 0)) / ROAD_GROWTH_TICKS),
    )
  }
}

interface ShapeRef {
  id: string
  footprint: Ring
  groundM: number
  heightM: number
}
