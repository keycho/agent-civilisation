import {
  BufferAttribute,
  BufferGeometry,
  Color,
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
  footprint: ReadonlyArray<readonly [number, number]>
  groundM: number
  heightM: number
}

export class RealityGhost {
  readonly lines: LineSegments
  private material: LineBasicMaterial
  /** 0 hidden, 1 fully faded in */
  private amount = 0
  private want = 0

  constructor(
    buildings: ReadonlyArray<GhostBuilding>,
    heightAt: (x: number, y: number) => number,
  ) {
    const segments: number[] = []
    for (const b of buildings) {
      const fp = b.footprint
      if (fp.length < 3) continue
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
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(segments), 3))
    this.material = new LineBasicMaterial({
      color: new Color('#e6ddc6'),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
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

  update(dt: number): void {
    if (this.amount === this.want) return
    const step = dt / 0.34
    this.amount =
      this.want > this.amount
        ? Math.min(this.want, this.amount + step)
        : Math.max(this.want, this.amount - step)
    this.material.opacity = this.amount * 0.34
    this.lines.visible = this.amount > 0.002
  }

  dispose(): void {
    this.lines.geometry.dispose()
    this.material.dispose()
  }
}
