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
  /** how far the target may stray from the chunk centre, metres */
  panRadius: number
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
    panRadius: 520,
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
    this.apply(k)
  }

  private apply(_k: number): void {
    const sinP = Math.sin(this.polar)
    this.camera.position.set(
      this.target.x + this.distance * sinP * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.cos(this.polar),
      this.target.z + this.distance * sinP * Math.cos(this.azimuth),
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
    const r = this.limits.panRadius
    const d = Math.hypot(this.desiredTarget.x, this.desiredTarget.z)
    if (d > r) {
      this.desiredTarget.x *= r / d
      this.desiredTarget.z *= r / d
    }
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
