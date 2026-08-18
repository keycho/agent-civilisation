import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
} from 'three'

/**
 * §40.1: the reality ghost.
 *
 * Hold `b` and the world as we left it fades in inside the fork — the
 * demolished warehouse standing as a wireframe inside the block that replaced
 * it. The baseline is immutable and already in hand at import, so this costs
 * one geometry built once and never touched again: the footprint ring at
 * ground and at eaves, plus a vertical at each corner. A wireframe rather
 * than a translucent solid on purpose — a solid inside a solid reads as a
 * z-fighting artefact, a wireframe reads as a drawing of what was there.
 *
 * Chrome register (§35.1's sibling rule for the world layer): cream ink, no
 * depth write, additive-free so it never tints what it overlays. It draws
 * through the buildings deliberately — the point is to see the ghost of the
 * thing standing where the thing is.
 */

export interface GhostBuilding {
  id?: string
  footprint: ReadonlyArray<readonly [number, number]>
  groundM: number
  heightM: number
}

/**
 * §63.4: the ghost becomes part of the AMBIENT register — the world quietly
 * remembering what stood on ground the agents have just cleared, at an alpha
 * that reads as an afterimage rather than as an overlay. Holding `b` still
 * raises the whole baseline at §40.1's strength; this is the resting state,
 * and it is per building rather than global.
 */
const AMBIENT_ALPHA = 0.13
/** how long a cleared site keeps its afterimage, in seconds */
const AMBIENT_FADE_S = 90

export class RealityGhost {
  readonly lines: LineSegments
  private material: LineBasicMaterial
  /** 0 hidden, 1 fully faded in */
  private amount = 0
  private want = 0
  /** §63.4: where each building's vertices live, so one can be raised alone */
  private span = new Map<string, [start: number, count: number]>()
  private ghosting = new Map<string, number>()
  private aGhost: BufferAttribute | null = null

  constructor(
    buildings: ReadonlyArray<GhostBuilding>,
    heightAt: (x: number, y: number) => number,
  ) {
    const segments: number[] = []
    for (const b of buildings) {
      const fp = b.footprint
      if (fp.length < 3) continue
      const start = segments.length / 3
      // ground follows the terrain the way the building itself does
      const base = heightAt(fp[0][0], fp[0][1]) + b.groundM
      const top = base + Math.max(1, b.heightM)
      for (let i = 0; i < fp.length; i++) {
        const a = fp[i]
        const c = fp[(i + 1) % fp.length]
        // the eaves ring, which is what reads at city zoom
        segments.push(a[0], top, -a[1], c[0], top, -c[1])
        // the ground ring, fainter in effect because it sits in the fabric
        segments.push(a[0], base, -a[1], c[0], base, -c[1])
        // one vertical per corner
        segments.push(a[0], base, -a[1], a[0], top, -a[1])
      }
      if (b.id) this.span.set(b.id, [start, segments.length / 3 - start])
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(segments), 3))
    // §63.4: one float per vertex, 0 at rest, 1 while this building is being
    // remembered. Kept as an attribute rather than as a second mesh so a
    // cleared site costs nothing beyond the write that raises it.
    this.aGhost = new BufferAttribute(new Float32Array(segments.length / 3), 1)
    this.aGhost.setUsage(DynamicDrawUsage)
    geometry.setAttribute('aGhost', this.aGhost)
    this.material = new LineBasicMaterial({
      color: new Color('#e6ddc6'),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    /**
     * The hold and the ambient afterimage are one draw. `opacity` carries the
     * §40.1 hold for every line; `aGhost` lifts the handful of cleared ones
     * above it, so the resting frame shows only what was just taken.
     */
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uAmbient = { value: AMBIENT_ALPHA }
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute float aGhost;\nvarying float vGhost;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGhost = aGhost;')
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float uAmbient;\nvarying float vGhost;\nvoid main() {')
        .replace(
          '#include <opaque_fragment>',
          'diffuseColor.a = max(diffuseColor.a, vGhost * uAmbient);\n#include <opaque_fragment>',
        )
    }
    this.material.customProgramCacheKey = () => 'ghost-ambient'
    this.lines = new LineSegments(geometry, this.material)
    this.lines.frustumCulled = false
    this.lines.visible = false
    this.lines.renderOrder = 6
  }

  /** held down or released — the fade does the rest */
  set held(on: boolean) {
    this.want = on ? 1 : 0
  }

  get held(): boolean {
    return this.want > 0.5
  }

  /**
   * §63.4: a site has just been cleared — start remembering it. Called from the
   * event path, so the afterimage arrives with the demolition rather than with
   * a poll of the world.
   */
  remember(buildingId: string): void {
    if (!this.span.has(buildingId)) return
    this.ghosting.set(buildingId, AMBIENT_FADE_S)
    this.write(buildingId, 1)
  }

  private write(buildingId: string, v: number): void {
    const at = this.span.get(buildingId)
    if (!at || !this.aGhost) return
    const arr = this.aGhost.array as Float32Array
    arr.fill(v, at[0], at[0] + at[1])
    this.aGhost.needsUpdate = true
  }

  update(dt: number): void {
    if (this.ghosting.size) {
      for (const [id, left] of this.ghosting) {
        const next = left - dt
        if (next <= 0) {
          this.ghosting.delete(id)
          this.write(id, 0)
        } else {
          this.ghosting.set(id, next)
          // the last fifth of the window fades out rather than switching off
          this.write(id, Math.min(1, next / (AMBIENT_FADE_S * 0.2)))
        }
      }
      this.lines.visible = true
    }
    if (this.amount === this.want) {
      if (this.ghosting.size === 0 && this.amount <= 0.002) this.lines.visible = false
      return
    }
    const step = dt / 0.34
    this.amount =
      this.want > this.amount
        ? Math.min(this.want, this.amount + step)
        : Math.max(this.want, this.amount - step)
    this.material.opacity = this.amount * 0.34
    this.lines.visible = this.amount > 0.002 || this.ghosting.size > 0
  }

  dispose(): void {
    this.lines.geometry.dispose()
    this.material.dispose()
  }
}
