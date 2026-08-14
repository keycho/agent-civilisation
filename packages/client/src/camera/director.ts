import type { WorldEvent, WorldStore } from '@civ/persistence'
import { Vector3 } from 'three'
import type { CameraRig } from './rig.ts'

/**
 * §17. "The requirement on the architecture is that the camera is driven by a
 * queue of intents, not by user input alone."
 *
 * The director selects from recent events ranked by cinematic_weight — which is
 * why that column went into the schema at stage 5 rather than being retrofitted
 * — and hands the rig a move. User input cancels the queue and takes control;
 * an idle timeout gives it back. That plus the timeout is ambient mode, which
 * is the "leave it running" experience §15 is actually describing.
 */

export type CameraIntent =
  | { kind: 'follow_construction'; buildingId: string }
  | { kind: 'follow_demolition'; buildingId: string }
  | { kind: 'follow_road'; edgeId: string }
  | { kind: 'follow_agent'; agentId: string }
  | { kind: 'district_pullback'; districtId: string }
  | { kind: 'before_after'; districtId: string; ordinalA: number; ordinalB: number }

interface QueuedIntent {
  intent: CameraIntent
  priority: number
  target: Vector3
  distance: number
  polar: number
  label: string
}

export interface DirectorHooks {
  /** where a building is, in render space, or null if it is gone */
  locateBuilding(id: string): Vector3 | null
  locateEdge(id: string): Vector3 | null
  locateAgent(id: string): Vector3 | null
  locatePoint(x: number, y: number): Vector3
  onShot?(label: string, intent: CameraIntent): void
}

const IDLE_BEFORE_RESUME_S = 12
const MIN_SHOT_S = 7
const MAX_SHOT_S = 16

export class CameraDirector {
  private queue: QueuedIntent[] = []
  private current: QueuedIntent | null = null
  private shotElapsed = 0
  private idleFor = 0
  private userHasControl = false
  private lastEventId = 0

  /** ambient mode: the director drives unless the user is touching the camera */
  enabled = true

  private readonly rig: CameraRig
  private readonly store: WorldStore
  private readonly hooks: DirectorHooks

  constructor(rig: CameraRig, store: WorldStore, hooks: DirectorHooks) {
    this.rig = rig
    this.store = store
    this.hooks = hooks
  }

  get activeLabel(): string | null {
    return this.current?.label ?? null
  }

  get inControl(): boolean {
    return this.enabled && !this.userHasControl
  }

  enqueue(intent: CameraIntent, priority: number): void {
    const shot = this.compose(intent, priority)
    if (!shot) return
    this.queue.push(shot)
    this.queue.sort((a, b) => b.priority - a.priority)
    if (this.queue.length > 8) this.queue.length = 8
  }

  /** User input cancels the queue and takes control (§17). */
  takeControl(): void {
    this.userHasControl = true
    this.idleFor = 0
    this.current = null
    this.queue.length = 0
  }

  update(dt: number, tick: number): void {
    if (this.userHasControl) {
      this.idleFor += dt
      if (this.idleFor >= IDLE_BEFORE_RESUME_S) {
        this.userHasControl = false
        this.idleFor = 0
      }
      return
    }
    if (!this.enabled) return

    this.harvest(tick)
    this.shotElapsed += dt

    const canCut = this.shotElapsed >= MIN_SHOT_S
    const mustCut = this.shotElapsed >= MAX_SHOT_S
    if ((canCut && this.queue.length > 0) || mustCut || !this.current) {
      const next = this.queue.shift()
      if (next) {
        this.current = next
        this.shotElapsed = 0
        this.rig.flyTo(next.target, next.distance, {
          azimuth: this.rig.azimuth + 0.55,
          polar: next.polar,
          duration: 3.2,
        })
        this.hooks.onShot?.(next.label, next.intent)
      } else if (mustCut) {
        // nothing worth watching: drift back out over the district
        this.shotElapsed = 0
        this.rig.flyTo(new Vector3(0, this.rig.target.y, 0), this.rig.limits.maxDistance * 0.78, {
          azimuth: this.rig.azimuth + 0.35,
          polar: 0.62,
          duration: 6,
        })
        this.current = null
      }
    }
  }

  /** Pull the highest-weight events since we last looked and turn them into shots. */
  private harvest(tick: number): void {
    const events = this.store.weightedEvents(Math.max(0, tick - 900), 12)
    for (const e of events) {
      if (e.id <= this.lastEventId) continue
      const intent = intentFor(e)
      if (intent) this.enqueue(intent, e.cinematicWeight)
    }
    if (events.length) {
      this.lastEventId = Math.max(this.lastEventId, ...events.map((e) => e.id))
    }
  }

  private compose(intent: CameraIntent, priority: number): QueuedIntent | null {
    switch (intent.kind) {
      case 'follow_construction':
      case 'follow_demolition': {
        const at = this.hooks.locateBuilding(intent.buildingId)
        if (!at) return null
        return {
          intent,
          priority,
          target: at,
          distance: 190,
          polar: 0.86,
          label: intent.kind === 'follow_construction' ? 'construction' : 'demolition',
        }
      }
      case 'follow_road': {
        const at = this.hooks.locateEdge(intent.edgeId)
        if (!at) return null
        return { intent, priority, target: at, distance: 260, polar: 0.74, label: 'new road' }
      }
      case 'follow_agent': {
        const at = this.hooks.locateAgent(intent.agentId)
        if (!at) return null
        return { intent, priority, target: at, distance: 150, polar: 0.9, label: 'agent' }
      }
      case 'district_pullback': {
        const [x, y] = intent.districtId.split(':').map(Number)
        const at = this.hooks.locatePoint(x || 0, y || 0)
        return { intent, priority, target: at, distance: 640, polar: 0.6, label: 'district' }
      }
      case 'before_after': {
        const [x, y] = intent.districtId.split(':').map(Number)
        const at = this.hooks.locatePoint(x || 0, y || 0)
        return { intent, priority, target: at, distance: 520, polar: 0.66, label: 'before / after' }
      }
    }
  }
}

function intentFor(e: WorldEvent): CameraIntent | null {
  switch (e.type) {
    case 'construction_started':
      return e.buildingId ? { kind: 'follow_construction', buildingId: e.buildingId } : null
    case 'demolition_started':
      return e.buildingId ? { kind: 'follow_demolition', buildingId: e.buildingId } : null
    case 'road_built':
      return e.edgeId ? { kind: 'follow_road', edgeId: e.edgeId } : null
    case 'parcels_assembled':
      return e.agentId ? { kind: 'follow_agent', agentId: e.agentId } : null
    case 'district_formed': {
      const p = e.payload as { x?: number; y?: number } | undefined
      return { kind: 'district_pullback', districtId: `${p?.x ?? 0}:${p?.y ?? 0}` }
    }
    default:
      return null
  }
}
