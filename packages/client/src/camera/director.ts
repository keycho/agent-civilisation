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
  /**
   * §47.4: ambient's idle intents weight toward work in progress. When the
   * event queue is dry, this offers somewhere a build is actually happening;
   * the director alternates it with the home drift so the framed view still
   * returns. Absent or null, every idle beat drifts home.
   */
  idleSite?(): Vector3 | null
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
  private idleBeat = 0

  /** ambient mode: the director drives unless the user is touching the camera */
  enabled = true

  /**
   * §66.1: the opening. A viewer needs to SEE the city before being taken into
   * it, so the first load holds the whole-plate framing motionless and the
   * director is not allowed an intent until the dwell is up. Production dived
   * to street level 29 seconds after first load, which teaches a stranger that
   * this is a camera flying around rather than a place they are looking at.
   *
   * And the first move out of the dwell is SLOW — twice a normal shot's
   * duration — because the transition is what teaches that the camera travels
   * rather than cuts. Every intent after it behaves as before.
   */
  /**
   * WALL CLOCK, not accumulated dt.
   *
   * The dwell was first written as a countdown fed by the render loop's delta,
   * which is clamped to 50 ms so that a stalled tab cannot teleport every
   * animation on resume. That clamp turns any dt-driven timer into a count of
   * RENDERED FRAMES: measured under software GL the nine-second dwell burned
   * 0.6 s of its budget in fourteen seconds of wall clock, and would have run
   * for minutes. The dwell is a promise to a person about how long they get to
   * look at the city, so it is measured the way that person measures it. Every
   * other timer here is about pacing shots against the animation and correctly
   * stays on dt.
   */
  private dwellUntil = 0
  private firstMovePending = false

  private dwellFrom = 0

  /** hold the framed view for `seconds`, then let the first intent be slow */
  openWith(seconds: number): void {
    this.dwellFrom = performance.now()
    this.dwellUntil = this.dwellFrom + seconds * 1000
    this.firstMovePending = true
  }

  /** §66.1: is the opening dwell still running? for the harness and the ui */
  get dwelling(): boolean {
    return performance.now() < this.dwellUntil
  }

  /**
   * §66.1: when the dwell ends, on the page's own performance timeline.
   * The acceptance asserts against this rather than against "seconds since the
   * harness noticed the page was live", which is a different and later origin.
   */
  get dwellEndsAt(): number {
    return this.dwellUntil
  }

  /** §66.1: when the framing was presented and the hold began */
  get dwellStartedAt(): number {
    return this.dwellFrom
  }

  /** §66.1: the last move the director issued — what it was and how slow */
  lastMove: { at: number; duration: number; slow: boolean; label: string } | null = null

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

    // §66.1: the opening dwell. Nothing is queued, nothing cuts, the camera
    // does not move — the city is simply on screen, whole, for long enough to
    // be read.
    if (this.dwelling) {
      this.queue.length = 0
      return
    }

    this.shotElapsed += dt

    const canCut = this.shotElapsed >= MIN_SHOT_S
    const mustCut = this.shotElapsed >= MAX_SHOT_S
    if ((canCut && this.queue.length > 0) || mustCut || !this.current) {
      const next = this.queue.shift()
      if (next) {
        this.current = next
        this.shotElapsed = 0
        // §66.1: the move out of the opening is slow, so the first thing the
        // camera does in front of a stranger is travel rather than cut
        const slow = this.firstMovePending
        this.firstMovePending = false
        const duration = slow ? 7.5 : 3.2
        // §66.1: what the director actually did, for the acceptance harness.
        // Asserting the SHOT rather than sampling the camera's wall-clock
        // travel matters because shot pacing runs on the render loop's dt,
        // which is clamped — under a software renderer the sampled version
        // measures the frame rate rather than the decision.
        this.lastMove = { at: performance.now(), duration, slow, label: next.label }
        this.rig.flyTo(next.target, next.distance, {
          azimuth: this.rig.azimuth + (slow ? 0.28 : 0.55),
          polar: next.polar,
          duration,
        })
        this.hooks.onShot?.(next.label, next.intent)
      } else if (mustCut) {
        this.shotElapsed = 0
        // §47.4: with the queue dry, two idle beats out of three go to work
        // in progress; the third drifts home so the framed view still returns
        const site = this.idleBeat++ % 3 === 2 ? null : (this.hooks.idleSite?.() ?? null)
        if (site) {
          this.current = {
            intent: { kind: 'follow_road', x: site.x, y: -site.z },
            priority: 0,
            target: site,
            distance: 320,
            polar: 0.74,
            label: 'work in progress',
          }
          this.rig.flyTo(site, 320, {
            azimuth: this.rig.azimuth + 0.4,
            polar: 0.74,
            duration: 4.5,
          })
        } else {
          // nothing worth watching: drift back out over the district,
          // returning to the framed orientation when configured (§35.6)
          this.rig.flyTo(new Vector3(0, this.rig.target.y, 0), this.rig.limits.maxDistance * 0.78, {
            azimuth: this.hooks.homeAzimuth ?? this.rig.azimuth + 0.35,
            polar: 0.62,
            duration: 6,
          })
          this.current = null
        }
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
