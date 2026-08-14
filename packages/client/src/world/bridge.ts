import {
  PURPOSE_INDEX,
  type Building,
  clamp01,
  generateArchetype,
  indexNodes,
  isAgentArchetype,
} from '@civ/core'
import type { WorldStore } from '@civ/persistence'
import type { Simulation } from '@civ/sim'
import type { Mesh } from 'three'
import type { BuildingRenderer } from '../render/buildingRenderer.ts'
import { updateAgentRoads } from '../render/roadMesh.ts'
import { eraTint, jitterFor, roofToneFor } from '../render/tones.ts'

/**
 * Connects the running simulation to the renderer.
 *
 * The mutable half of the §16.2 data texture is rewritten wholesale every
 * frame. That sounds wasteful and is not: at this scale it is four kilobytes,
 * and the alternative — tracking dirty buildings across nine action types,
 * construction progress and condition decay — is a source of silent staleness
 * for no measurable gain.
 *
 * Geometry is the opposite. It only changes on expand, develop and replace, and
 * each of those moves a building out of the static baseline batch permanently
 * (§16.2), so those are handled explicitly through the pending queues.
 */

const ROAD_GROWTH_TICKS = 150

export class SimBridge {
  private readonly nodeIndex: ReturnType<typeof indexNodes>
  private lastRoadCount = 0

  private readonly sim: Simulation
  private readonly renderer: BuildingRenderer
  private readonly agentRoadMesh: Mesh
  private readonly groundY: number
  private readonly store: WorldStore

  constructor(
    sim: Simulation,
    renderer: BuildingRenderer,
    agentRoadMesh: Mesh,
    groundY: number,
    store: WorldStore,
  ) {
    this.sim = sim
    this.renderer = renderer
    this.agentRoadMesh = agentRoadMesh
    this.groundY = groundY
    this.store = store
    this.nodeIndex = indexNodes([...sim.world.nodes.values()])
  }

  /** Push everything the simulation changed into the renderer. */
  sync(): void {
    const world = this.sim.world

    // new or reshaped geometry first, so the texture write below finds a slot
    if (world.pendingGeometry.length > 0) {
      for (const id of world.pendingGeometry) {
        const b = world.buildings.get(id)
        if (!b) continue
        this.materialise(b)
      }
      world.pendingGeometry.length = 0
    }

    for (const b of world.buildings.values()) {
      const index = this.renderer.indexOf(b.id)
      if (index === undefined) continue
      this.renderer.data.set(
        index,
        progressOf(b),
        b.divergence,
        PURPOSE_INDEX[b.purpose] ?? 0,
        clamp01(b.condition),
      )
    }

    // agent roads grow outward from the network (§16.6); the mesh is rebuilt
    // while any of them is still extending
    const agentEdges = [...world.edges.values()].filter((e) => e.agentBuilt)
    const growing = agentEdges.some(
      (e) => world.tick - (e.builtTick ?? 0) < ROAD_GROWTH_TICKS,
    )
    if (agentEdges.length !== this.lastRoadCount || growing) {
      this.lastRoadCount = agentEdges.length
      for (const n of world.nodes.values()) {
        if (!this.nodeIndex.has(n.id)) this.nodeIndex.set(n.id, n)
      }
      updateAgentRoads(this.agentRoadMesh, this.nodeIndex, agentEdges, this.groundY, (e) =>
        clamp01((world.tick - (e.builtTick ?? 0)) / ROAD_GROWTH_TICKS),
      )
    }
    world.pendingRoads.length = 0

    this.renderer.flush()
  }

  /** Generate the stylized mass for a building the simulation created or changed. */
  private materialise(b: Building): void {
    const out = generateArchetype(
      {
        footprint: b.footprint,
        heightM: b.heightM,
        levels: b.levels,
        purpose: b.purpose,
        constructionYear: b.constructionYear,
        source: b.source,
        roofHint: b.roofHint,
      },
      b.id,
      b.archetype,
    )
    const index = this.renderer.setGeometry(b.id, out.mesh, b.groundM)
    this.renderer.data.setStatic(
      index,
      roofToneFor(b.archetype, out.roof, b.constructionYear, out.metrics.area),
      jitterFor(b.id),
      b.source === 'agent_built' ? 0 : eraTint(b.constructionYear),
      isAgentArchetype(b.archetype),
    )
  }

  /**
   * §20.4: snapshots key on event ordinal. §16.2: "the scrub is a texture swap
   * from a snapshot" — what is stored is literally the data texture, so
   * travelling the history is an upload rather than a replay of the log.
   */
  captureSnapshot(
    ordinal: number,
    generation: number,
    divergenceIndex: number,
    stats: Record<string, number>,
  ): void {
    this.store.putSnapshot({
      chunkId: this.sim.world.chunkId,
      ordinal,
      generation,
      tick: this.sim.world.tick,
      buildingData: this.renderer.data.snapshot(),
      divergenceIndex,
      stats,
    })
  }

  /** Travel to the nearest snapshot at or before `ordinal`. */
  restoreSnapshot(ordinal: number): { generation: number; divergenceIndex: number } | null {
    const snap = this.store.snapshotAt(this.sim.world.chunkId, ordinal)
    if (!snap) return null
    this.renderer.data.loadFrame(snap.buildingData)
    this.renderer.flush()
    return { generation: snap.generation, divergenceIndex: snap.divergenceIndex }
  }
}

function progressOf(b: Building): number {
  switch (b.state) {
    case 'standing':
      return 1
    case 'demolished':
      return 0
    default:
      return clamp01(b.progress)
  }
}
