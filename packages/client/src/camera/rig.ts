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
 * §62.1/§65: where the target is allowed to be.
 *
 * §62 bounded the target to the plate's footprint and called it done, and the
 * §62.2 fuzz agreed for four seeds. Seed 11 found the hole: at the minimum
 * distance, near-horizontal, with the target legally parked on the fabric's
 * CORNER, the frame contains two street trees and a lamp against black. The
 * target was on the city and the city was still not on screen, because a
 * camera looking outward from an edge sees what is past the edge.
 *
 * So the bound is not the fabric — it is the fabric inset by how much ground
 * this shot can see. `d * tan(fov/2)` is half the visible ground extent at the
 * current distance, and requiring the target to sit that far inside the edge
 * means the frame is filled with city wherever it is pointed. The inset is
 * capped at the half-extent, so at the whole-city framing the target is pinned
 * to the centre — which is what "the plate is always framed whole" means for
 * the city, and is the same rule §57.3 gives the map.
 */
function clampToPlate(v: Vector3, limits: RigLimits, inset: number): void {
  const hx = Math.max(0, limits.panHalfX - inset)
  const hz = Math.max(0, limits.panHalfZ - inset)
  v.x = MathUtils.clamp(v.x, limits.panCentreX - hx, limits.panCentreX + hx)
  v.z = MathUtils.clamp(v.z, limits.panCentreZ - hz, limits.panCentreZ + hz)
}

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
    minDistance: 40,
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

  orbit(dx: number, dy: number): void {
    this.cancelTween()
    this.desiredAzimuth -= dx * 0.0042
    this.desiredPolar = MathUtils.clamp(
      this.desiredPolar - dy * 0.0032,
      this.limits.minPolar,
      this.limits.maxPolar,
    )
  }

  pan(dx: number, dy: number): void {
    this.cancelTween()
    // pan in the camera's ground plane, scaled so it feels the same at any zoom
    const scale = this.desiredDistance * 0.0011
    const cos = Math.cos(this.desiredAzimuth)
    const sin = Math.sin(this.desiredAzimuth)
    this.desiredTarget.x -= (dx * cos - dy * sin) * scale
    this.desiredTarget.z -= (dx * sin + dy * cos) * scale
    this.clampTarget()
  }

  zoom(delta: number): void {
    this.cancelTween()
    this.desiredDistance = MathUtils.clamp(
      this.desiredDistance * Math.pow(1.0015, delta),
      this.limits.minDistance,
      this.limits.maxDistance,
    )
  }

  /** Cinematic move. §17's director drives this; user input cancels it. */
  flyTo(
    target: Vector3,
    distance: number,
    opts: { azimuth?: number; polar?: number; duration?: number } = {},
  ): void {
    const toA = opts.azimuth ?? this.desiredAzimuth
    this.tween = {
      fromT: this.desiredTarget.clone(),
      toT: target.clone(),
      fromD: this.desiredDistance,
      toD: MathUtils.clamp(distance, this.limits.minDistance, this.limits.maxDistance),
      fromA: this.desiredAzimuth,
      // take the short way round
      toA: this.desiredAzimuth + wrapAngle(toA - this.desiredAzimuth),
      fromP: this.desiredPolar,
      toP: MathUtils.clamp(opts.polar ?? this.desiredPolar, this.limits.minPolar, this.limits.maxPolar),
      t: 0,
      duration: opts.duration ?? 2.4,
    }
  }

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
    const inset = this.visibleGroundHalf()
    clampToPlate(this.desiredTarget, this.limits, inset)
    clampToPlate(this.target, this.limits, inset)
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
    this.desiredPolar = MathUtils.clamp(
      this.desiredPolar,
      this.limits.minPolar,
      this.limits.maxPolar,
    )
    this.polar = MathUtils.clamp(this.polar, this.limits.minPolar, this.limits.maxPolar)
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

  private clampTarget(): void {
    clampToPlate(this.desiredTarget, this.limits, this.visibleGroundHalf())
  }

  /**
   * Half the ground this shot can see, at the current distance and lens — the
   * inset `clampToPlate` keeps the target away from the fabric's edge by.
   */
  private visibleGroundHalf(): number {
    const t = MathUtils.clamp(
      (this.desiredDistance - this.lens.streetDistance) /
        (this.lens.cityDistance - this.lens.streetDistance),
      0,
      1,
    )
    const fov = MathUtils.lerp(this.lens.streetFov, this.lens.cityFov, easeInOutCubic(t))
    return this.desiredDistance * Math.tan(((fov / 2) * Math.PI) / 180)
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
  home(
    at: Vector3,
    distance: number,
    azimuth: number,
    polar: number,
    opts: { duration?: number; snap?: boolean } = {},
  ): void {
    this.cancelTween()
    if (opts.snap) {
      this.desiredTarget.copy(at)
      this.desiredDistance = distance
      this.desiredAzimuth = azimuth
      this.desiredPolar = polar
      this.settle()
      return
    }
    this.flyTo(at, distance, { azimuth, polar, duration: opts.duration ?? 1.2 })
  }

  /**
   * §62.2: the invariants as a predicate, so a harness asserts against what
   * the rig believes rather than re-deriving the bands from constants that
   * might have drifted apart from it.
   */
  outOfBounds(): string[] {
    const out: string[] = []
    const { panCentreX, panCentreZ } = this.limits
    const inset = this.visibleGroundHalf()
    const panHalfX = Math.max(0, this.limits.panHalfX - inset)
    const panHalfZ = Math.max(0, this.limits.panHalfZ - inset)
    if (
      Math.abs(this.target.x - panCentreX) > panHalfX + 1.0 ||
      Math.abs(this.target.z - panCentreZ) > panHalfZ + 1.0
    ) {
      out.push(
        `target (${this.target.x.toFixed(1)}, ${this.target.z.toFixed(1)}) outside ` +
          `(${panCentreX.toFixed(0)}, ${panCentreZ.toFixed(0)}) ±${panHalfX.toFixed(0)} x ±${panHalfZ.toFixed(0)}`,
      )
    }
    if (this.distance < this.limits.minDistance - 1e-3 || this.distance > this.limits.maxDistance + 1e-3) {
      out.push(
        `distance ${this.distance.toFixed(0)} outside [${this.limits.minDistance.toFixed(
          0,
        )}, ${this.limits.maxDistance.toFixed(0)}]`,
      )
    }
    if (this.polar < this.limits.minPolar - 1e-3 || this.polar > this.limits.maxPolar + 1e-3) {
      out.push(
        `polar ${this.polar.toFixed(3)} outside [${this.limits.minPolar}, ${this.limits.maxPolar}]`,
      )
    }
    return out
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
