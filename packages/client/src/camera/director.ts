import type { EventWire } from '@civ/protocol'
import { Vector3 } from 'three'
import type { CameraRig } from './rig.ts'

/**
 * §17. "The requirement on the architecture is that the camera is driven by a
 * queue of intents, not by user input alone."
 *
 * The director selects from recent events ranked by cinematic_weight — which is
 * why that column went into the schema at stage 5 rather than being retrofitted
 * — and hands the rig a move. §21.6: those events now arrive in frames off a
 * socket rather than being pulled out of a store this process owns, so it is
 * offered each one as it lands and keeps the ranking it always did. User input cancels the queue and takes control;
 * an idle timeout gives it back. That plus the timeout is ambient mode, which
 * is the "leave it running" experience §15 is actually describing.
 */

export type CameraIntent =
  | { kind: 'follow_construction'; buildingId: string }
  | { kind: 'follow_demolition'; buildingId: string }
  | { kind: 'follow_road'; x: number; y: number }
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
  locateAgent(id: string): Vector3 | null
  locatePoint(x: number, y: number): Vector3
  onShot?(label: string, intent: CameraIntent): void
  /**
   * §35.6: with nothing worth watching, the drift-back returns to the §24.1
   * framed orientation rather than persisting an arbitrary orbit. Absent, the
   * old behaviour (keep drifting) applies.
   */
  homeAzimuth?: number
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
  private readonly hooks: DirectorHooks

  constructor(rig: CameraRig, hooks: DirectorHooks) {
    this.rig = rig
    this.hooks = hooks
  }

  get activeLabel(): string | null {
    return this.current?.label ?? null
  }

  /** where the active shot is looking, so the ui can anchor its chip there */
  get shotTarget(): Vector3 | null {
    return this.current?.target ?? null
  }

  get shotIntent(): CameraIntent | null {
    return this.current?.intent ?? null
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
        // nothing worth watching: drift back out over the district, returning
        // to the framed orientation when one is configured (§35.6)
        this.shotElapsed = 0
        this.rig.flyTo(new Vector3(0, this.rig.target.y, 0), this.rig.limits.maxDistance * 0.78, {
          azimuth: this.hooks.homeAzimuth ?? this.rig.azimuth + 0.35,
          polar: 0.62,
          duration: 6,
        })
        this.current = null
      }
    }
  }

  /**
   * Offer the director an event. It keeps what is worth watching and the queue
   * stays ranked by cinematic weight, so a low-weight renovation never displaces
   * a demolition that arrived in the same frame.
   */
  consider(e: EventWire): void {
    if (e.id <= this.lastEventId) return
    this.lastEventId = e.id
    const intent = intentFor(e)
    if (intent) this.enqueue(intent, e.cinematicWeight)
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
        const at = this.hooks.locatePoint(intent.x, intent.y)
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

function intentFor(e: EventWire): CameraIntent | null {
  switch (e.type) {
    case 'construction_started':
      return e.buildingId ? { kind: 'follow_construction', buildingId: e.buildingId } : null
    case 'demolition_started':
      return e.buildingId ? { kind: 'follow_demolition', buildingId: e.buildingId } : null
    case 'road_built':
      return e.x !== undefined && e.y !== undefined
        ? { kind: 'follow_road', x: e.x, y: e.y }
        : null
    case 'parcels_assembled':
      return e.agentId ? { kind: 'follow_agent', agentId: e.agentId } : null
    case 'district_formed':
      return { kind: 'district_pullback', districtId: `${e.x ?? 0}:${e.y ?? 0}` }
    default:
      return null
  }
}
