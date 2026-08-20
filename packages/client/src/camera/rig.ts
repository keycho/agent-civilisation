import { MathUtils, PerspectiveCamera, Vector3 } from 'three'

/**
 * §16.3. Near-orthographic conflicts with street level, and swapping
 * projection mid-transition is a visible discontinuity.
 *
 * So: one perspective camera with a very long focal length, positioned far
 * back. At city range the fov is ~15 degrees and the image reads as
 * orthographic; coming down to the street the fov opens toward ~40 and real
 * perspective returns. Distance and fov animate together, so there is never a
 * projection swap to hide.
 *
 * Camera language is deliberately composed rather than an infinite viewport:
 * bounded target, bounded pitch, damped everything.
 */

export interface RigLimits {
  minDistance: number
  maxDistance: number
  /**
   * §75: kept for the preview harness's own rig, which is a tool rather than
   * the product and drives polar directly. The city camera derives pitch from
   * distance and never reads these.
   */
  minPolar: number
  maxPolar: number
  /**
   * §62.1/§65: the rectangle the orbit target may occupy, as a CENTRE and
   * half-extents in metres — the city's own measured footprint plus a margin.
   *
   * Was `panRadius`, a circle about the origin, which is the wrong shape for
   * either plate: it cut the corners off the region a viewer may look at while
   * letting the target out past the edge mid-side. §62 made it a rectangle and
   * left it centred on the origin, which §65 showed is not where the city is —
   * brooklyn's centre is 52 m off it and london's 44 m, so the region a viewer
   * could pan over was offset from the thing they were panning over.
   */
  panCentreX: number
  panCentreZ: number
  panHalfX: number
  panHalfZ: number
}

/**
 * §75: the target lives in FABRIC COORDINATES, and that is the whole change.
 *
 * Six blocks of work made the inset bound more and more correct — §62 bounded
 * the target to the plate, §65.2 inset it by what the shot could see, §72.3
 * made the inset ask at the live distance — and the camera stayed unusable.
 * The constraint work was right about the constraint and wrong about the
 * problem: it was CLAMPING a free-flying target after the fact, so every input
 * could produce an illegal state and every frame had to correct one.
 *
 * The reachable set is now the correct set by construction. The target is a
 * point `(u, v)` in the fabric's own square, the controls move `u` and `v`, and
 * the mapping back to world space cannot produce a point off the fabric because
 * `u` and `v` are clamped where they are WRITTEN — in the input, once, on a
 * number that has no meaning outside [0, 1].
 *
 * `reach` is what remains of the inset arithmetic, and it is worth being
 * straight about: the geometry did not stop being true, it moved to where it
 * belongs. A frame at the fabric's corner still sees past the fabric, so the
 * DOMAIN of the pan control is the fabric drawn in by a share of the ground the
 * shot covers. At the whole-city framing that domain collapses to the centre,
 * which is correct — there is nothing to pan to when the city is already whole
 * on screen. What is gone is the clamp, the second opinion, and the free pitch
 * axis that let a viewer end up horizontal at altitude.
 */
function fabricPoint(v: Vector3, limits: RigLimits, u: number, w: number, reach: number): void {
  const hx = Math.max(0, limits.panHalfX - reach)
  const hz = Math.max(0, limits.panHalfZ - reach)
  v.x = limits.panCentreX + (u * 2 - 1) * hx
  v.z = limits.panCentreZ + (w * 2 - 1) * hz
}

/** the inverse, for a target handed in from outside — follow, a card, a shot */
function fabricCoords(
  x: number,
  z: number,
  limits: RigLimits,
  reach: number,
): { u: number; w: number } {
  const hx = Math.max(1e-3, limits.panHalfX - reach)
  const hz = Math.max(1e-3, limits.panHalfZ - reach)
  return {
    u: clamp01(((x - limits.panCentreX) / hx + 1) / 2),
    w: clamp01(((z - limits.panCentreZ) / hz + 1) / 2),
  }
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/**
 * §75: pitch is a function of distance. One dial.
 *
 * Higher when far, leaning as you come down, and floored so there is no way to
 * end up horizontal at altitude — which is what three of the reported
 * production frames were. It is not an axis the controls can touch, so the
 * state that produced those frames is not reachable.
 *
 * The far end is 0.62 rather than the near-top-down §75 asks for, and the use
 * test is why. At 0.36 the whole-city frame got WORSE, not better: this plate
 * is 1300 m across, so a camera far enough back to frame it top-down sees the
 * city as a small rectangle in a much larger field of nothing — measured at
 * 14.7% city and 29.3% void on the first-load frame. Obliquity is what fills a
 * frame with a small plate, because the ground recedes into it. 0.62 is 35
 * degrees off vertical, which is nowhere near horizontal and is the pitch the
 * approved opening was composed at.
 */
const PITCH_FAR = 0.62
const PITCH_NEAR = 0.86

/**
 * The distance by which the pitch has reached its far value.
 *
 * A FIXED reference rather than `limits.maxDistance`, because the home framing
 * is computed from the pitch and the max distance is computed from the home
 * framing — reading the limit here would close that loop and make the curve
 * depend on the city's size. Above this the camera is simply top-down.
 */
const PITCH_FULL_AT = 1200

/**
 * How much of the ground a shot covers must still be fabric when the pan
 * control is at its limit. 0.5 puts the target half a frame-depth inside the
 * edge, so the majority of the ground in view is city even at the stop.
 */
const PAN_INSET_SHARE = 0.5

/** grazing rays run to the horizon and say nothing; stop short of it */
const HORIZON_LIMIT = Math.PI / 2 - 0.06

export interface LensConfig {
  cityFov: number
  streetFov: number
  /** at or below this distance the lens is fully open */
  streetDistance: number
  /** at or above this distance the lens is fully long */
  cityDistance: number
}

/**
 * A 15-degree lens sees 2*d*tan(7.5deg) of the world, so framing a 560 m chunk
 * needs to sit ~2.1 km back. That is the price of the orthographic read and
 * the distance limits have to be built for it, not for a normal lens.
 */
/**
 * §66.3: how far below the horizon the top of frame must stay, in degrees.
 * At zero the far edge of the plate sits exactly on the horizon line and the
 * shot reads as a photograph of an edge; eight degrees puts ground behind it.
 */
const HORIZON_MARGIN_DEG = 8

/**
 * §66.3: how far above the local roofline the eye must stay, in metres.
 *
 * The contact sheet's second finding. Every camera invariant up to here was
 * about the TARGET — where the camera is pointed, whether the fabric is on
 * screen, how much of it fills the frame. None of them said anything about
 * where the eye is, and a legal state put the lens inside a facade: the target
 * was on the fabric, the coverage was over its floor, and the frame was one
 * building's window wall in extreme close-up. Seven metres clears a low roof
 * and a two-storey terrace, which is the height at which the shot stops being
 * masonry and starts being a street.
 */
const EYE_CLEARANCE_M = 7

/**
 * How wide a neighbourhood the eye has to clear, as a fraction of distance.
 * Bounded below so a street framing still checks its immediate surroundings and
 * above because past a few tens of metres the question stops being "what is
 * next to the lens".
 */
const CLEARANCE_RADIUS = { of: 0.15, min: 6, max: 40 }

export const CITY_LENS: LensConfig = {
  cityFov: 15,
  streetFov: 42,
  streetDistance: 90,
  cityDistance: 1400,
}

/** The preview harness is a tool, not the product; it uses a normal lens. */
export const TOOL_LENS: LensConfig = {
  cityFov: 30,
  streetFov: 45,
  streetDistance: 60,
  cityDistance: 600,
}

export class CameraRig {
  readonly camera: PerspectiveCamera
  readonly target = new Vector3()

  /**
   * §66.3: the tallest roofline within `radius` metres of a world point, or
   * -Infinity where nothing stands. The city supplies it from its measured
   * built grid; the flat map has no fabric to collide with and leaves it null,
   * which turns the clearance invariant off rather than guessing.
   */
  ceilingNear: ((x: number, z: number, radius: number) => number) | null = null

  distance = 700
  azimuth = -0.6
  polar = 0.62

  private desiredTarget = new Vector3()
  private desiredDistance = 700
  private desiredAzimuth = -0.6
  private desiredPolar = 0.62

  private tween: {
    fromT: Vector3
    toT: Vector3
    fromD: number
    toD: number
    fromA: number
    toA: number
    fromP: number
    toP: number
    t: number
    duration: number
  } | null = null

  limits: RigLimits = {
    /**
     * §75: the closest a viewer can get, and it is a COMPOSITION limit rather
     * than a collision one.
     *
     * 40 m let the scroll run until the frame was one facade — the use test's
     * contact sheet has four of them, every one scoring 100% "city" because
     * every ray hit a roofline, which is §66.3's fault wearing the opposite
     * coat. §66.3's clearance keeps the eye out of the masonry and says nothing
     * about whether what is left is a picture of a city or a picture of a wall.
     * At 110 m a street framing has a street in it.
     */
    minDistance: 110,
    maxDistance: 2800,
    minPolar: 0.12,
    maxPolar: 1.32,
    panCentreX: 0,
    panCentreZ: 0,
    panHalfX: 520,
    panHalfZ: 520,
  }

  lens: LensConfig = CITY_LENS

  /** true while a scripted move is running and the user has not taken over */
  get isAnimating(): boolean {
    return this.tween !== null
  }

  constructor(aspect: number, lens: LensConfig = CITY_LENS) {
    this.lens = lens
    this.camera = new PerspectiveCamera(lens.cityFov, aspect, 1, 12000)
    this.apply(1)
  }

  /** Distance at which a span of `metres` fills the vertical frame. */
  distanceToFrame(metres: number): number {
    const fov = (this.lens.cityFov * Math.PI) / 180
    return metres / (2 * Math.tan(fov / 2))
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  /**
   * §75: drag rotates azimuth around the target. That is all it does.
   *
   * `dy` is accepted and ignored, because the callers pass a two-axis drag and
   * the SIGNATURE is not the place to argue about it — pitch is a function of
   * distance now, and a second axis here would be a way back to the state this
   * block exists to remove. A full 360 always works and always keeps the city
   * on screen, because the camera is on a sphere about a point that is on the
   * city by construction.
   */
  orbit(dx: number, _dy: number): void {
    this.cancelTween()
    this.desiredAzimuth -= dx * 0.0042
  }

  /**
   * §75: panning translates the target across the ground plane, in the fabric's
   * own coordinates. It cannot be given a value off the fabric because the
   * mapping does not produce one.
   */
  pan(dx: number, dy: number): void {
    this.cancelTween()
    const reach = this.panInset(this.desiredDistance)
    const hx = Math.max(1, this.limits.panHalfX - reach)
    const hz = Math.max(1, this.limits.panHalfZ - reach)
    // the drag is in screen space; rotate it into the ground plane, then divide
    // by the reachable half-extent so the units are the fabric's, not metres
    const scale = this.desiredDistance * 0.0011
    const cos = Math.cos(this.desiredAzimuth)
    const sin = Math.sin(this.desiredAzimuth)
    const mx = -(dx * cos - dy * sin) * scale
    const mz = -(dx * sin + dy * cos) * scale
    this.u = clamp01(this.u + mx / (2 * hx))
    this.w = clamp01(this.w + mz / (2 * hz))
    fabricPoint(this.desiredTarget, this.limits, this.u, this.w, reach)
  }

  /**
   * §75: scroll changes distance only. It never moves the target, so zooming
   * out from street level and back returns to the same place.
   */
  zoom(delta: number): void {
    this.cancelTween()
    this.desiredDistance = MathUtils.clamp(
      this.desiredDistance * Math.pow(1.0015, delta),
      this.limits.minDistance,
      this.limits.maxDistance,
    )
  }

  /** §75: the one dial. Pitch is read off distance and never stored free. */
  pitchFor(distance: number): number {
    const t = clamp01(
      (distance - this.limits.minDistance) / Math.max(1, PITCH_FULL_AT - this.limits.minDistance),
    )
    return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * easeInOutCubic(t)
  }

  /**
   * §75: how far from the target the frame's ground footprint actually runs.
   *
   * §72.3's measurement, kept because it was right: a frustum meets the ground
   * in a TRAPEZOID that runs away from the camera, and `d * tan(fov/2)` — a
   * square's half-width — understates it by 100-290 m at these pitches. It is
   * no longer used to clamp anything. It sizes the pan control's domain.
   */
  groundReachAt(distance: number): number {
    const polar = this.pitchFor(distance)
    const fovY = (this.fovAt(distance) * Math.PI) / 180
    const half = fovY / 2
    const h = distance * Math.cos(polar)
    const far = Math.min(polar + half, HORIZON_LIMIT)
    const near = Math.max(0, polar - half)
    const atTarget = h * Math.tan(polar)
    const along = Math.max(h * Math.tan(far) - atTarget, atTarget - h * Math.tan(near))
    const fovX = 2 * Math.atan(Math.tan(half) * this.camera.aspect)
    const wide = (h / Math.cos(far)) * Math.tan(fovX / 2)
    return Math.hypot(along, wide)
  }

  private panInset(distance: number): number {
    return this.groundReachAt(distance) * PAN_INSET_SHARE
  }

  /** §75: where the target sits in the fabric, so callers can put it back */
  private u = 0.5
  private w = 0.5

  /**
   * §75: aim at a world point by converting it into fabric coordinates first.
   * Everything that moves the target — follow, a feed card, a director shot —
   * comes through here, so there is one definition of where the target may be.
   */
  aimAt(x: number, z: number, distance = this.desiredDistance): void {
    const reach = this.panInset(distance)
    const c = fabricCoords(x, z, this.limits, reach)
    this.u = c.u
    this.w = c.w
    fabricPoint(this.desiredTarget, this.limits, this.u, this.w, reach)
  }

  /** Cinematic move. §17's director drives this; user input cancels it. */
  flyTo(
    target: Vector3,
    distance: number,
    opts: { azimuth?: number; polar?: number; duration?: number } = {},
  ): void {
    const toA = opts.azimuth ?? this.desiredAzimuth
    const toD = MathUtils.clamp(distance, this.limits.minDistance, this.limits.maxDistance)
    /**
     * §75: the destination goes through the fabric mapping like every other
     * target. A shot aimed at a point the pan domain cannot reach at its own
     * distance lands at the nearest point that IS reachable, rather than flying
     * somewhere illegal and being corrected on arrival.
     *
     * `opts.polar` is accepted and ignored. Pitch is a function of distance, so
     * the director varies its framings by varying DISTANCE — which it already
     * does, per kind, and which produces the pitch variation for free.
     */
    const reach = this.panInset(toD)
    const c = fabricCoords(target.x, target.z, this.limits, reach)
    const to = target.clone()
    fabricPoint(to, this.limits, c.u, c.w, reach)
    this.tweenU = c.u
    this.tweenW = c.w
    this.tween = {
      fromT: this.desiredTarget.clone(),
      toT: to,
      fromD: this.desiredDistance,
      toD,
      fromA: this.desiredAzimuth,
      // take the short way round
      toA: this.desiredAzimuth + wrapAngle(toA - this.desiredAzimuth),
      fromP: this.desiredPolar,
      toP: this.pitchFor(toD),
      t: 0,
      duration: opts.duration ?? 2.4,
    }
  }

  /** §75: where a running tween is taking the fabric coordinate */
  private tweenU = 0.5
  private tweenW = 0.5

  cancelTween(): void {
    this.tween = null
  }

  update(dt: number): void {
    if (this.tween) {
      const tw = this.tween
      tw.t = Math.min(1, tw.t + dt / tw.duration)
      const e = easeInOutCubic(tw.t)
      this.desiredTarget.lerpVectors(tw.fromT, tw.toT, e)
      this.desiredDistance = tw.fromD + (tw.toD - tw.fromD) * e
      this.desiredAzimuth = tw.fromA + (tw.toA - tw.fromA) * e
      this.desiredPolar = tw.fromP + (tw.toP - tw.fromP) * e
      /**
       * §75: the fabric coordinate is the state, so a tween has to move IT and
       * not only the world point. Interpolating the point alone leaves `(u, w)`
       * where the move started, and `enforce` — which recomputes the target
       * from `(u, w)` every frame — would drag the camera straight back.
       */
      const startReach = this.panInset(tw.fromD)
      const from = fabricCoords(tw.fromT.x, tw.fromT.z, this.limits, startReach)
      this.u = from.u + (this.tweenU - from.u) * e
      this.w = from.w + (this.tweenW - from.w) * e
      if (tw.t >= 1) this.tween = null
    }

    // critically-damped-ish follow; nothing in this camera ever snaps
    const k = 1 - Math.pow(0.0015, dt)
    this.target.lerp(this.desiredTarget, k)
    this.distance += (this.desiredDistance - this.distance) * k
    this.azimuth += (this.desiredAzimuth - this.azimuth) * k
    this.polar += (this.desiredPolar - this.polar) * k
    this.enforce()
    this.apply(k)
  }

  /**
   * §62.1: the invariants, enforced EVERY FRAME after any input — which is the
   * whole finding of §62. Clamping inside `pan` and `zoom` and again at `0`
   * bounds the endpoints those functions produce; it says nothing about the
   * states reachable between them. A `flyTo` target was never clamped at all,
   * `resize` could shrink `maxDistance` under a camera already further out,
   * and a limits change (city -> map -> city) left the live state wherever the
   * old limits had allowed. Each of those is a way to be outside the envelope
   * while every individual clamp is still correct, and the plate goes off
   * screen for exactly as long as the damping takes to not fix it.
   *
   * So: both the desired state and the damped live state are pulled inside the
   * bands here, on every frame, whatever moved them.
   */
  private enforce(): void {
    /**
     * §75: what is left to enforce, now that the reachable set is the correct
     * set.
     *
     * The plate clamp is gone — the target is a fabric coordinate and cannot be
     * off the fabric — and so is the pitch band, because pitch is read off
     * distance rather than stored. What remains is the distance range, the
     * pitch that follows from it, and §66.3's roofline clearance, which is a
     * different invariant about a different thing: the eye must not end up
     * inside the masonry it is looking at.
     */
    this.desiredDistance = MathUtils.clamp(
      this.desiredDistance,
      this.limits.minDistance,
      this.limits.maxDistance,
    )
    this.distance = MathUtils.clamp(
      this.distance,
      this.limits.minDistance,
      this.limits.maxDistance,
    )
    this.desiredPolar = this.pitchFor(this.desiredDistance)
    this.polar = this.pitchFor(this.distance)

    // §66.3: and the eye stays out of the masonry, on both states
    const lifted = this.clearRoofline(this.desiredPolar, this.desiredDistance, this.desiredAzimuth)
    this.desiredPolar = lifted.polar
    this.desiredDistance = lifted.distance
    const live = this.clearRoofline(this.polar, this.distance, this.azimuth)
    this.polar = live.polar
    this.distance = live.distance

    /**
     * §75: the pan domain narrows as the camera pulls back, so a target that
     * was legal up close has to come in with it. Recomputing from `(u, w)`
     * rather than clamping the point is the same idea as everywhere else here:
     * the coordinate is the state, and the world position is derived from it.
     */
    fabricPoint(this.desiredTarget, this.limits, this.u, this.w, this.panInset(this.desiredDistance))

    // §62.5: azimuth is free, and the one thing that must not accumulate — an
    // unwrapped angle grows without bound under continuous orbiting and
    // eventually loses precision in the sines that place the camera. Shifting
    // both angles by the same whole turn is invisible; a tween holds absolute

    // endpoints, so it is left to finish before the shift is taken.
    if (!this.tween && (this.azimuth > Math.PI || this.azimuth < -Math.PI)) {
      const shift = wrapAngle(this.azimuth) - this.azimuth
      this.azimuth += shift
      this.desiredAzimuth += shift
    }
  }

  /**
   * §66.3: lift the eye clear of whatever it is standing in.
   *
   * Pitching UP is the cheap move and the wrong one — it would swing the shot
   * off the fabric the other invariants just spent their effort keeping on
   * screen. Pitching toward vertical raises the eye and keeps the target
   * exactly where the viewer put it, so the fix costs the shot its obliquity
   * and nothing else. Lowering polar also walks the eye horizontally, over
   * different buildings, so this iterates rather than solving once.
   *
   * If even a plan view cannot clear the roofline the camera is closer to the
   * fabric than the fabric is tall, and only backing off fixes that.
   */
  private clearRoofline(
    polar: number,
    distance: number,
    azimuth: number,
  ): { polar: number; distance: number } {
    if (!this.ceilingNear) return { polar, distance }
    const radius = MathUtils.clamp(
      distance * CLEARANCE_RADIUS.of,
      CLEARANCE_RADIUS.min,
      CLEARANCE_RADIUS.max,
    )
    let p = polar
    let need = -Infinity
    for (let i = 0; i < 4; i++) {
      const sinP = Math.sin(p)
      const top = this.ceilingNear(
        this.target.x + distance * sinP * Math.sin(azimuth),
        this.target.z + distance * sinP * Math.cos(azimuth),
        radius,
      )
      if (!Number.isFinite(top)) return { polar: p, distance }
      need = top + EYE_CLEARANCE_M
      if (this.target.y + distance * Math.cos(p) >= need) return { polar: p, distance }
      const next = Math.max(
        this.limits.minPolar,
        Math.acos(MathUtils.clamp((need - this.target.y) / distance, -1, 1)),
      )
      if (next >= p - 1e-4) {
        p = next
        break
      }
      p = next
    }
    // still short at the flattest pitch allowed: back the lens off instead
    if (this.target.y + distance * Math.cos(p) < need) {
      distance = MathUtils.clamp(
        (need - this.target.y) / Math.max(Math.cos(p), 0.2),
        distance,
        this.limits.maxDistance,
      )
    }
    return { polar: p, distance }
  }

  /**
   * §56 capture discipline. The damping above is asymptotic on purpose —
   * "nothing in this camera ever snaps" — which means the rig is still
   * converging long after a fly-to visually arrives. Between two frames of an
   * a/b pair that residual drift can rotate the plate by a fraction of a
   * degree, which at city distance displaces far edges by tens of pixels and
   * swamps whatever the pair was meant to isolate. This finishes any running
   * tween and lands the damped state exactly on the desired one, so a capture
   * pair differs by the step under test alone. Never called in normal play.
   */
  settle(): void {
    if (this.tween) {
      const tw = this.tween
      this.desiredTarget.copy(tw.toT)
      this.desiredDistance = tw.toD
      this.desiredAzimuth = tw.toA
      this.desiredPolar = tw.toP
      // §75: and the coordinate the target is derived from
      this.u = this.tweenU
      this.w = this.tweenW
      this.tween = null
    }
    this.target.copy(this.desiredTarget)
    this.distance = this.desiredDistance
    this.azimuth = this.desiredAzimuth
    this.polar = this.desiredPolar
    // a capture must not be drifting: §56.8 is deliberately never still, and
    // an a/b pair taken during it would differ by the breath rather than by
    // the step under test
    this.driftTarget = 0
    this.driftAmount = 0
    this.enforce()
    this.apply(1)
  }

  /**
   * §56.3: ambient drift. "Stillness reads as screenshot; drift reads as film."
   *
   * The offset is applied at PLACEMENT time and never written back into the
   * rig's state. That is the whole trick: the damping above pulls the state
   * toward its desired value every frame, so a drift stored in azimuth or
   * distance would be fought and flattened, and a drift written into the
   * desired value would be overwritten by any running flyTo tween. Offsetting
   * only where the camera is computed leaves the tween, the damping and the
   * director's cuts all working exactly as before, with the camera never
   * quite still on top of them.
   */
  driftTarget = 0
  private driftAmount = 0
  private driftT = 0

  advanceDrift(dt: number): void {
    this.driftT += dt
    // ease in and out rather than switching: a drift that starts abruptly is
    // a nudge, which reads as a bug rather than as breath
    this.driftAmount += (this.driftTarget - this.driftAmount) * (1 - Math.pow(0.2, dt))
  }

  private apply(_k: number): void {
    // three incommensurate periods, so the path never visibly repeats
    const a = this.driftAmount
    const azimuth = this.azimuth + Math.sin(this.driftT * 0.062) * 0.105 * a
    const polar = this.polar + Math.sin(this.driftT * 0.047 + 1.7) * 0.030 * a
    const distance = this.distance * (1 + Math.sin(this.driftT * 0.035 + 0.6) * 0.055 * a)
    const sinP = Math.sin(polar)
    this.camera.position.set(
      this.target.x + distance * sinP * Math.sin(azimuth),
      this.target.y + distance * Math.cos(polar),
      this.target.z + distance * sinP * Math.cos(azimuth),
    )
    this.camera.lookAt(this.target)

    // The long lens sits kilometres back, and a near plane of 1 m there leaves
    // the depth buffer resolving about a third of a metre — which silently
    // collapses every ground layer (canals, roads, parcel decals) into the base
    // plate. Near and far have to track the camera, not be set once.
    const near = Math.max(0.4, this.distance * 0.05)
    const far = this.distance * 3 + 2500
    if (Math.abs(this.camera.near - near) > near * 0.02) {
      this.camera.near = near
      this.camera.far = far
      this.camera.updateProjectionMatrix()
    }

    // fov and distance move together — this is the whole trick
    const t = MathUtils.clamp(
      (this.distance - this.lens.streetDistance) / (this.lens.cityDistance - this.lens.streetDistance),
      0,
      1,
    )
    const fov = MathUtils.lerp(this.lens.streetFov, this.lens.cityFov, easeInOutCubic(t))
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
    }
  }

  /** the lens at a given distance — the same ramp `apply` uses to set it */
  private fovAt(distance: number): number {
    const t = MathUtils.clamp(
      (distance - this.lens.streetDistance) / (this.lens.cityDistance - this.lens.streetDistance),
      0,
      1,
    )
    return MathUtils.lerp(this.lens.streetFov, this.lens.cityFov, easeInOutCubic(t))
  }



  /**
   * §62.4: `0`. The reported failure — "lands at the plate's border with the
   * city in a corner, and rotating sweeps around a point that is not the
   * city" — is what a home framing looks like when the DISTANCE is recomputed
   * for the plate but the TARGET is not brought back to its centre. The rig
   * therefore owns the reset rather than leaving it as four arguments a caller
   * has to remember to pass together: target, distance, pitch and azimuth land
   * as one operation, and nothing is optional.
   *
   * `snap` exists for the same reason `settle` does — a capture, and a
   * recovery from a state a viewer wants out of NOW, should not have to wait
   * out the damping.
   */
  /**
   * §75: `0` resets DISTANCE and PITCH to the home framing and leaves azimuth
   * alone. A viewer who has turned the city to an angle they like and then asks
   * for the whole thing back should get the whole thing at that angle, not be
   * spun to north as well.
   *
   * The `azimuth` and `polar` arguments are still accepted because the capture
   * rigs pass them and a fixed-camera a/b wants to name its own bearing; a
   * caller that omits azimuth keeps the one it has.
   */
  home(
    at: Vector3,
    distance: number,
    azimuth: number | null,
    _polar: number,
    opts: { duration?: number; snap?: boolean } = {},
  ): void {
    this.cancelTween()
    const toA = azimuth ?? this.desiredAzimuth
    if (opts.snap) {
      this.aimAt(at.x, at.z, distance)
      this.desiredDistance = distance
      this.desiredAzimuth = toA
      this.desiredPolar = this.pitchFor(distance)
      this.settle()
      return
    }
    this.flyTo(at, distance, { azimuth: toA, duration: opts.duration ?? 1.2 })
  }

  /**
   * §62.2: the invariants as a predicate, so a harness asserts against what
   * the rig believes rather than re-deriving the bands from constants that
   * might have drifted apart from it.
   */
  outOfBounds(): string[] {
    const out: string[] = []
    /**
     * §75: what is left to assert.
     *
     * The target bound is gone from here because it is gone from the rig — the
     * target is a fabric coordinate and there is no state in which it is off
     * the fabric, so a predicate saying so would be the "second opinion" §75
     * asked to delete. The two lines below are checks on things that CAN still
     * be wrong: a distance outside its range, and a pitch that has come adrift
     * from the curve it is supposed to be a function of. The second is the one
     * that would catch a future caller reintroducing a free pitch axis.
     */
    if (this.distance < this.limits.minDistance - 1e-3 || this.distance > this.limits.maxDistance + 1e-3) {
      out.push(
        `distance ${this.distance.toFixed(0)} outside [${this.limits.minDistance.toFixed(
          0,
        )}, ${this.limits.maxDistance.toFixed(0)}]`,
      )
    }
    /**
     * §66.3's clearance lifts the pitch off the curve on purpose, so the check
     * is one-sided: the eye may be raised out of the masonry, never dropped
     * below what the curve allows.
     */
    if (this.polar > this.pitchFor(this.distance) + 1e-3) {
      out.push(
        `polar ${this.polar.toFixed(3)} is below the curve's ` +
          `${this.pitchFor(this.distance).toFixed(3)} at d=${this.distance.toFixed(0)} — ` +
          `pitch is a function of distance and something has written it free`,
      )
    }
    // §66.3: measured where the camera actually IS, after drift, because drift
    // is applied at placement time and never written back into the rig's state
    const clearance = this.eyeClearance()
    if (clearance < 0) {
      out.push(
        `eye ${(-clearance).toFixed(1)} m inside the roofline ` +
          `(needs ${EYE_CLEARANCE_M} m of it) at d=${this.distance.toFixed(0)}`,
      )
    }
    return out
  }

  /**
   * §66.3: metres of headroom the eye has over its neighbourhood's roofline,
   * beyond the margin it is required to keep. Negative is a lens in masonry.
   * Infinite where nothing stands nearby, and where the map has no fabric.
   */
  eyeClearance(): number {
    if (!this.ceilingNear) return Infinity
    const p = this.camera.position
    const radius = MathUtils.clamp(
      this.distance * CLEARANCE_RADIUS.of,
      CLEARANCE_RADIUS.min,
      CLEARANCE_RADIUS.max,
    )
    const top = this.ceilingNear(p.x, p.z, radius)
    if (!Number.isFinite(top)) return Infinity
    return p.y - (top + EYE_CLEARANCE_M)
  }

  /** How close to street level we are, 0..1 — used to fade the tilt-shift out. */
  get streetness(): number {
    return MathUtils.clamp(
      1 - (this.distance - this.lens.streetDistance) / (this.lens.cityDistance - this.lens.streetDistance),
      0,
      1,
    )
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

/** Pointer wiring. Kept out of the rig so the director can drive it headless. */
export function attachRigControls(rig: CameraRig, el: HTMLElement, onUserInput?: () => void): void {
  let dragging: 'orbit' | 'pan' | null = null
  let lastX = 0
  let lastY = 0

  el.addEventListener('pointerdown', (e) => {
    dragging = e.button === 2 || e.shiftKey ? 'pan' : 'orbit'
    lastX = e.clientX
    lastY = e.clientY
    el.setPointerCapture(e.pointerId)
    onUserInput?.()
  })
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    if (dragging === 'orbit') rig.orbit(dx, dy)
    else rig.pan(dx, dy)
    onUserInput?.()
  })
  const end = (e: PointerEvent) => {
    dragging = null
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  el.addEventListener('contextmenu', (e) => e.preventDefault())
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      rig.zoom(e.deltaY)
      onUserInput?.()
    },
    { passive: false },
  )
}
