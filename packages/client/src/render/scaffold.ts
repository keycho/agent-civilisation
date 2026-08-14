import { footprintMetrics, scaffoldOpacity, siteMarkOpacity } from '@civ/core'
import type { Ring } from '@civ/core'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
} from 'three'

/**
 * §15/§16.5's construction stages, the parts that are not the mass itself.
 *
 *   0.00 - 0.10  site marked, boundary decal on the parcel
 *   0.10 - 0.25  scaffolding / framework emerges
 *   0.25 - 0.85  mass grows (that part lives in the building shader)
 *   0.85 - 1.00  scaffolding fades, facade treatment applies
 *
 * Both of these are instanced: a scaffold cage is a generic box frame scaled to
 * a building's oriented bounding box, and a site mark is a quad. Unlike the
 * buildings themselves, they genuinely do share one mesh.
 *
 * §21.6: this takes sites rather than `Building`s, because the client no longer
 * has any. Everything it needs is the shape, where the ground is, and which way
 * the progress float is travelling.
 */

export interface ConstructionSite {
  footprint: Ring
  groundM: number
  heightM: number
  /** §16.5's single float */
  progress: number
  /** descending progress is a demolition */
  falling: boolean
}

const MAX_ACTIVE = 96

export class ConstructionOverlay {
  readonly scaffold: InstancedMesh
  readonly siteMarks: InstancedMesh
  private dummy = new Object3D()
  private colour = new Color()

  constructor() {
    const cageMaterial = new MeshLambertMaterial({
      color: new Color('#9a927f'),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    this.scaffold = new InstancedMesh(cageGeometry(), cageMaterial, MAX_ACTIVE)
    this.scaffold.instanceMatrix.setUsage(DynamicDrawUsage)
    this.scaffold.frustumCulled = false
    this.scaffold.count = 0

    const markGeometry = new PlaneGeometry(1, 1)
    markGeometry.rotateX(-Math.PI / 2)
    const markMaterial = new MeshBasicMaterial({
      color: new Color('#d8c48a'),
      transparent: true,
      opacity: 0.75,
      side: DoubleSide,
      depthWrite: false,
    })
    this.siteMarks = new InstancedMesh(markGeometry, markMaterial, MAX_ACTIVE)
    this.siteMarks.instanceMatrix.setUsage(DynamicDrawUsage)
    this.siteMarks.frustumCulled = false
    this.siteMarks.count = 0
    this.siteMarks.renderOrder = 2
  }

  update(sites: Iterable<ConstructionSite>, time: number): void {
    let cages = 0
    let marks = 0

    for (const b of sites) {
      const m = footprintMetrics(b.footprint)

      const scaffoldA = scaffoldOpacity(b.progress)
      if (scaffoldA > 0.02 && cages < MAX_ACTIVE) {
        // the cage rises with the work rather than standing full height from
        // the first day
        const h = Math.max(2.5, b.heightM * Math.min(1, 0.35 + b.progress * 0.8))
        this.dummy.position.set(m.obb.cx, b.groundM + h / 2, -m.obb.cy)
        this.dummy.rotation.set(0, -m.obb.angle, 0)
        this.dummy.scale.set(m.obb.length + 1.4, h, m.obb.width + 1.4)
        this.dummy.updateMatrix()
        this.scaffold.setMatrixAt(cages, this.dummy.matrix)
        this.colour.set(b.falling ? '#a8705c' : '#9a927f')
        this.scaffold.setColorAt(cages, this.colour)
        cages++
      }

      const markA = siteMarkOpacity(b.progress)
      if (markA > 0.02 && marks < MAX_ACTIVE) {
        const pulse = 1 + 0.03 * Math.sin(time * 3)
        this.dummy.position.set(m.obb.cx, b.groundM + 0.35, -m.obb.cy)
        this.dummy.rotation.set(0, -m.obb.angle, 0)
        this.dummy.scale.set((m.obb.length + 3) * pulse, 1, (m.obb.width + 3) * pulse)
        this.dummy.updateMatrix()
        this.siteMarks.setMatrixAt(marks, this.dummy.matrix)
        this.colour.set(b.falling ? '#c98a6e' : '#d8c48a')
        this.siteMarks.setColorAt(marks, this.colour)
        marks++
      }
    }

    this.scaffold.count = cages
    this.siteMarks.count = marks
    this.scaffold.instanceMatrix.needsUpdate = true
    this.siteMarks.instanceMatrix.needsUpdate = true
    if (this.scaffold.instanceColor) this.scaffold.instanceColor.needsUpdate = true
    if (this.siteMarks.instanceColor) this.siteMarks.instanceColor.needsUpdate = true
  }
}

/** A unit box drawn as bars: four posts, three lifts. Scaled per instance. */
function cageGeometry(): BufferGeometry {
  const bars: BufferGeometry[] = []
  const t = 0.035

  for (const x of [-0.5, 0.5]) {
    for (const z of [-0.5, 0.5]) {
      const post = new BoxGeometry(t, 1, t)
      post.translate(x, 0, z)
      bars.push(post)
    }
  }
  for (const y of [-0.32, 0.04, 0.4]) {
    for (const z of [-0.5, 0.5]) {
      const rail = new BoxGeometry(1, t, t)
      rail.translate(0, y, z)
      bars.push(rail)
    }
    for (const x of [-0.5, 0.5]) {
      const rail = new BoxGeometry(t, t, 1)
      rail.translate(x, y, 0)
      bars.push(rail)
    }
  }

  let count = 0
  for (const g of bars) count += g.getAttribute('position').count
  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  let offset = 0
  for (const g of bars) {
    const nonIndexed = g.toNonIndexed()
    const p = nonIndexed.getAttribute('position')
    const n = nonIndexed.getAttribute('normal')
    for (let i = 0; i < p.count; i++) {
      position[(offset + i) * 3] = p.getX(i)
      position[(offset + i) * 3 + 1] = p.getY(i)
      position[(offset + i) * 3 + 2] = p.getZ(i)
      normal[(offset + i) * 3] = n.getX(i)
      normal[(offset + i) * 3 + 1] = n.getY(i)
      normal[(offset + i) * 3 + 2] = n.getZ(i)
    }
    offset += p.count
    nonIndexed.dispose()
    g.dispose()
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(position, 3))
  out.setAttribute('normal', new BufferAttribute(normal, 3))
  return out
}

export type { Mesh }
