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
  /**
   * §68.3: an assembly is not an agent shot.
   *
   * `parcels_assembled` mapped to `follow_agent`, and assembly is the commonest
   * high-weight event this world produces — which is the actual reason seven of
   * ten shots on the first director sheet were labelled `agent` at one framing.
   * Consolidating three lots is a change to a BLOCK and wants to be seen at
   * block scale; the agent doing it is incidental to the picture.
   */
  | { kind: 'follow_assembly'; x: number; y: number; agentId?: string }
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
  /**
   * §68.3: how much standing city is around a point, 0..1.
   *
   * After §63 light IS the signal of activity, and the §66.3 director sheet's
   * one unpostable frame was a correctly-chosen agent standing in an unlit part
   * of the plate — a shot of nothing, taken because the ranking could not tell
   * the difference. Every metric that tried to judge a frame's geometry came
   * apart (§68.1); this does not try. It asks the one question the world can
   * answer cheaply: is there anything here that would be lit.
   */
  litnessAt?(at: Vector3): number
}

const IDLE_BEFORE_RESUME_S = 12
const MIN_SHOT_S = 7
const MAX_SHOT_S = 16

/**
 * §68.3: how far an unlit subject falls in the ranking.
 *
 * A floor rather than a veto. Drama still wins — a demolition in a dark dock is
 * a real event and the director should be allowed to take it — but between two
 * comparable events the lit one is the one worth pointing a camera at, and a
 * routine event in the dark should lose to a routine event in the light.
 */
const UNLIT_FLOOR = 0.3

/**
 * §68.3: the same intent twice running is one idea repeated. Seven of ten shots
 * on the first director sheet were `agent` at exactly d=150 pitch 0.9 — not
 * because the compositions were identical but because one kind owned the queue.
 * A shot of the kind just taken has to be clearly better to win again.
 */
const REPEAT_PENALTY = 0.55

/** §72.6: how many cuts back the repeat penalty remembers */
const RECENT_SHOTS = 5

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
    /**
     * §68.3: rank on drama AND on whether there is anything to see.
     *
     * Both factors are applied here rather than inside `compose`, because
     * compose answers "where would this shot stand" and this answers "is it
     * worth standing there" — and only the second needs to know what the
     * director just did.
     */
    const lit = this.hooks.litnessAt?.(shot.target) ?? 1
    shot.priority *= UNLIT_FLOOR + (1 - UNLIT_FLOOR) * Math.max(0, Math.min(1, lit))
    this.queue.push(shot)
    /**
     * §72.6: the QUEUE CAP is where the diversity is won or lost.
     *
     * Ranking at dequeue was not enough and the sheet said so — it went from
     * seven of ten `agent` to eight of ten `assembly`. The reason is this line:
     * the queue holds eight and was truncated by BASE priority, so with
     * assemblies arriving at 42 a minute at weight 60 and demolitions at 16 a
     * minute at weight 50, every demolition was pushed out of the queue before
     * the dequeue ever saw it. A preference among what survived could not
     * matter, because nothing else survived.
     *
     * So the cap ranks by the same recency-adjusted score the cut does. Once a
     * few assemblies have been shown, an incoming assembly is worth less than a
     * demolition that has been waiting, and it is the assembly that gets
     * dropped.
     */
    this.queue.sort((a, b) => this.effective(b) - this.effective(a))
    if (this.queue.length > 8) this.queue.length = 8
  }

  /**
   * §72.6: what this shot is worth GIVEN WHAT THE DIRECTOR HAS JUST SHOWN.
   *
   * The repeat penalty was applied once, at enqueue, and only against the shot
   * currently running. That cannot hold against an event type that wins on both
   * axes at once, and `parcels_assembled` does: measured on the wire it is 42
   * of the 73 intent-bearing events a minute, and at weight 60 it also outranks
   * every other intent except a district. One multiplication by 0.55 does not
   * change that ordering, so the sheet went from seven of ten labelled `agent`
   * to seven of ten labelled `assembly` — the same failure at a new name.
   *
   * So the penalty compounds over the last few cuts and is applied at DEQUEUE,
   * where the recent history is current. Five assemblies in a row take an
   * assembly from 60 to 3 and a demolition at 50 wins. The moment something
   * else has been shown the assembly is back near the top, which is the
   * behaviour wanted: not a quota, a preference for the thing not just seen.
   */
  private effective(shot: QueuedIntent): number {
    let repeats = 0
    for (const kind of this.recent) if (kind === shot.intent.kind) repeats++
    return shot.priority * REPEAT_PENALTY ** repeats
  }

  /** the kinds of the last few cuts, most recent first */
  private recent: string[] = []

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
      // §72.6: ranked against what has just been shown, not against what was
      // in the queue when this arrived
      let best = -1
      let bestScore = -Infinity
      for (let i = 0; i < this.queue.length; i++) {
        const score = this.effective(this.queue[i])
        if (score > bestScore) {
          bestScore = score
          best = i
        }
      }
      const next = best >= 0 ? this.queue.splice(best, 1)[0] : undefined
      if (next) {
        this.current = next
        this.shotElapsed = 0
        this.recent.unshift(next.intent.kind)
        if (this.recent.length > RECENT_SHOTS) this.recent.length = RECENT_SHOTS
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

  /**
   * §68.3: two shots of the same kind must not be the same frame.
   *
   * A counter rather than a random: the sequence is then reproducible, which
   * matters because the acceptance for this is a contact sheet somebody looks
   * at and a sheet that reshuffles between runs cannot be compared to the last
   * one. The spread is deliberately wide enough to read as a different setup
   * and narrow enough that a kind keeps its character.
   */
  private shotIndex = 0

  private vary(distance: number, polar: number): { distance: number; polar: number } {
    const n = this.shotIndex++
    const d = [1, 0.78, 1.24, 0.9][n % 4]
    const p = [0, -0.1, 0.07, -0.05][n % 4]
    return { distance: distance * d, polar: Math.max(0.24, polar + p) }
  }

  private compose(intent: CameraIntent, priority: number): QueuedIntent | null {
    switch (intent.kind) {
      case 'follow_construction':
      case 'follow_demolition': {
        const at = this.hooks.locateBuilding(intent.buildingId)
        if (!at) return null
        /**
         * §68.3: a demolition is a wider, higher shot than a construction.
         * Something coming down is about the hole it leaves in the block, so
         * the block has to be in frame; something going up is about the
         * scaffold, which needs to be close enough to read as scaffold.
         */
        const falling = intent.kind === 'follow_demolition'
        return {
          intent,
          priority,
          target: at,
          ...this.vary(falling ? 300 : 175, falling ? 0.62 : 0.88),
          label: falling ? 'demolition' : 'construction',
        }
      }
      case 'follow_road': {
        const at = this.hooks.locatePoint(intent.x, intent.y)
        return { intent, priority, target: at, ...this.vary(280, 0.7), label: 'new road' }
      }
      case 'follow_assembly': {
        const at =
          intent.agentId && (intent.x === 0 || intent.y === 0)
            ? (this.hooks.locateAgent(intent.agentId) ?? this.hooks.locatePoint(intent.x, intent.y))
            : this.hooks.locatePoint(intent.x, intent.y)
        return { intent, priority, target: at, ...this.vary(330, 0.72), label: 'assembly' }
      }
      case 'follow_agent': {
        const at = this.hooks.locateAgent(intent.agentId)
        if (!at) return null
        // an agent is a person doing something: closer, and low enough that the
        // street they are standing in is the subject rather than the roofscape
        return { intent, priority, target: at, ...this.vary(118, 0.97), label: 'agent' }
      }
      case 'district_pullback': {
        const [x, y] = intent.districtId.split(':').map(Number)
        const at = this.hooks.locatePoint(x || 0, y || 0)
        return { intent, priority, target: at, ...this.vary(640, 0.58), label: 'district' }
      }
      case 'before_after': {
        const [x, y] = intent.districtId.split(':').map(Number)
        const at = this.hooks.locatePoint(x || 0, y || 0)
        return { intent, priority, target: at, ...this.vary(520, 0.64), label: 'before / after' }
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
      return e.x !== undefined || e.agentId
        ? { kind: 'follow_assembly', x: e.x ?? 0, y: e.y ?? 0, agentId: e.agentId }
        : null
    // an agent's own moment is a purchase — the one event that is about a
    // person rather than about ground
    case 'building_acquired':
      return e.agentId ? { kind: 'follow_agent', agentId: e.agentId } : null
    case 'district_formed':
      return { kind: 'district_pullback', districtId: `${e.x ?? 0}:${e.y ?? 0}` }
    default:
      return null
  }
}
