import { footprintMetrics, scaffoldOpacity, siteMarkOpacity } from '@civ/core'
import type { Ring } from '@civ/core'
import {
  AdditiveBlending,
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
  ShaderMaterial,
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
  /** texture slot — the stable key visual staging tracks a site by */
  slot: number
  footprint: Ring
  groundM: number
  heightM: number
  /** §16.5's single float */
  progress: number
  /** descending progress is a demolition */
  falling: boolean
}

const MAX_ACTIVE = 96
/**
 * §47.4: minimum visual dwell. The §16.5 stages were proportional to
 * progress, so a fast build popped from mark to mass in two frames. Display
 * progress chases the wire's, rate-capped through the scaffolding band so
 * frame -> mass -> facade always read as beats: the band spans 0.15 of
 * progress and may not cross faster than in SCAFFOLD_DWELL_S seconds.
 */
const SCAFFOLD_BAND: [number, number] = [0.1, 0.25]
const SCAFFOLD_DWELL_S = 1.6
const FAST_RATE = 0.85 // progress/s outside the band — quick but not a pop
const BAND_RATE = (SCAFFOLD_BAND[1] - SCAFFOLD_BAND[0]) / SCAFFOLD_DWELL_S

/** §47.4: crane markers over the biggest active builds, city-framing legible */
const CRANE_MIN_AREA_M2 = 220
const MAX_CRANES = 24

export class ConstructionOverlay {
  readonly scaffold: InstancedMesh
  readonly siteMarks: InstancedMesh
  readonly glow: InstancedMesh
  readonly cranes: InstancedMesh
  private dummy = new Object3D()
  private colour = new Color()
  /** §47.4 dwell state: display progress + a cached copy of the site, so a
   * build that completed on the wire still walks its remaining stages */
  private staging = new Map<number, { site: ConstructionSite; display: number; seen: boolean }>()
  private lastTime = 0

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

    /**
     * §46.2: worked sites glow — a soft additive pool of light under any
     * active site, sized past the footprint and pulsing gently, so the
     * ground shows where work happens even when the agent is four pixels.
     * World-palette ochre, not chrome amber (§35.1).
     */
    const glowGeometry = new PlaneGeometry(1, 1)
    glowGeometry.rotateX(-Math.PI / 2)
    const glowMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: new Color('#c79a52') } },
      vertexShader: /* glsl */ `
        varying vec2 vLocal;
        varying float vA;
        void main() {
          vLocal = position.xz;
          vA = instanceMatrix[1][1]; // per-instance pulse rides the unused y scale
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vLocal;
        varying float vA;
        void main() {
          float r = length(vLocal) * 2.0;
          float a = smoothstep(1.0, 0.15, r) * 0.34 * vA;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    })
    this.glow = new InstancedMesh(glowGeometry, glowMaterial, MAX_ACTIVE)
    this.glow.instanceMatrix.setUsage(DynamicDrawUsage)
    this.glow.frustumCulled = false
    this.glow.count = 0
    this.glow.renderOrder = 1

    /**
     * §47.4: construction sites are landmarks while active. A crane
     * silhouette — the §42.2 harness vocabulary at marker scale — stands
     * over any rising site above the size threshold and is removed at
     * completion. Members are deliberately chunky so the mast and jib still
     * read at city framing.
     */
    this.cranes = new InstancedMesh(
      craneGeometry(),
      new MeshLambertMaterial({ color: new Color('#6e675c') }),
      MAX_CRANES,
    )
    this.cranes.instanceMatrix.setUsage(DynamicDrawUsage)
    this.cranes.frustumCulled = false
    this.cranes.count = 0
  }

  update(sites: Iterable<ConstructionSite>, time: number): void {
    const dt = this.lastTime > 0 ? Math.min(0.1, time - this.lastTime) : 0.016
    this.lastTime = time

    // §47.4 dwell: fold the wire's sites into the staging cache, then advance
    // every display value toward its target at stage-capped rates. A site the
    // wire has finished with keeps rendering until its display catches up.
    for (const s of this.staging.values()) s.seen = false
    for (const raw of sites) {
      const s = this.staging.get(raw.slot)
      if (s) {
        s.site = raw
        s.seen = true
      } else {
        this.staging.set(raw.slot, {
          site: raw,
          // joining mid-build (hello after a refresh) starts at truth, not 0
          display: raw.progress,
          seen: true,
        })
      }
    }
    for (const [slot, s] of this.staging) {
      const target = s.seen ? s.site.progress : s.site.falling ? 0 : 1
      const d = s.display
      const inBand = d >= SCAFFOLD_BAND[0] && d < SCAFFOLD_BAND[1]
      const rate = inBand ? BAND_RATE : FAST_RATE
      s.display =
        target > d ? Math.min(target, d + rate * dt) : Math.max(target, d - rate * dt)
      if (!s.seen && (s.display >= 0.999 || s.display <= 0.001)) this.staging.delete(slot)
    }

    let cages = 0
    let marks = 0
    let glows = 0
    const craneSites: Array<{ cx: number; cy: number; angle: number; groundM: number; heightM: number; area: number }> = []

    for (const s of this.staging.values()) {
      const b: ConstructionSite = { ...s.site, progress: s.display }
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

      // §46.2: the ground pulse, any active site, readable from city framing
      if (glows < MAX_ACTIVE) {
        const span = Math.max(m.obb.length, m.obb.width) + 16
        const pulse = 0.72 + 0.28 * Math.sin(time * 2.2 + m.obb.cx * 0.05)
        this.dummy.position.set(m.obb.cx, b.groundM + 0.18, -m.obb.cy)
        this.dummy.rotation.set(0, 0, 0)
        // the shader reads the pulse off the y scale, which a flat quad
        // does not otherwise use
        this.dummy.scale.set(span, pulse, span)
        this.dummy.updateMatrix()
        this.glow.setMatrixAt(glows, this.dummy.matrix)
        glows++
      }

      if (!b.falling && m.area >= CRANE_MIN_AREA_M2) {
        craneSites.push({
          cx: m.obb.cx,
          cy: m.obb.cy,
          angle: m.obb.angle,
          groundM: b.groundM,
          heightM: b.heightM,
          area: m.area,
        })
      }
    }

    // §47.4: cranes over the largest active sites, removed at completion —
    // the site leaves the staging cache and the marker goes with it
    craneSites.sort((a, b) => b.area - a.area)
    let craneCount = 0
    for (const c of craneSites.slice(0, MAX_CRANES)) {
      const mast = Math.max(18, c.heightM * 1.5 + 12)
      this.dummy.position.set(c.cx, c.groundM, -c.cy)
      this.dummy.rotation.set(0, -c.angle + time * 0.05, 0)
      this.dummy.scale.set(1, mast / 30, 1)
      this.dummy.updateMatrix()
      this.cranes.setMatrixAt(craneCount, this.dummy.matrix)
      craneCount++
    }
    this.cranes.count = craneCount

    this.scaffold.count = cages
    this.siteMarks.count = marks
    this.glow.count = glows
    this.scaffold.instanceMatrix.needsUpdate = true
    this.siteMarks.instanceMatrix.needsUpdate = true
    this.glow.instanceMatrix.needsUpdate = true
    this.cranes.instanceMatrix.needsUpdate = true
    if (this.scaffold.instanceColor) this.scaffold.instanceColor.needsUpdate = true
    if (this.siteMarks.instanceColor) this.siteMarks.instanceColor.needsUpdate = true
  }
}

/**
 * §47.4: a tower crane at marker scale — mast, jib, counterjib, cab. Unit
 * mast height 30 m (instances scale y by mast/30); members chunky on purpose
 * so the silhouette survives city framing.
 */
function craneGeometry(): BufferGeometry {
  const parts: BoxGeometry[] = []
  const mast = new BoxGeometry(3.2, 30, 3.2)
  mast.translate(0, 15, 0)
  parts.push(mast)
  const jib = new BoxGeometry(46, 2.4, 2.4)
  jib.translate(17, 30.5, 0)
  parts.push(jib)
  const counter = new BoxGeometry(14, 2.6, 2.6)
  counter.translate(-9, 30.5, 0)
  parts.push(counter)
  const cab = new BoxGeometry(4.4, 3.6, 4.4)
  cab.translate(0, 28, 0)
  parts.push(cab)
  return mergeBoxes(parts)
}

function mergeBoxes(parts: BoxGeometry[]): BufferGeometry {
  let count = 0
  for (const g of parts) count += g.getAttribute('position').count
  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  let offset = 0
  for (const g of parts) {
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
