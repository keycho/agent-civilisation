import type { AgentIdentity, AgentWire } from '@civ/protocol'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
} from 'three'

/**
 * §16.6: "agents are instanced, and here instancing does work because they
 * share one mesh."
 *
 * §15 is specific about what they must not be: no realistic human models. These
 * are small stylized entities that read as inhabitants of a miniature world —
 * at 8 to 20 pixels the silhouette and the colour carry everything and geometry
 * detail carries nothing.
 *
 * §3/§20.3: above `normal` throughput, continuous motion is nonsense, so agents
 * stop interpolating and become static presence markers with an activity pulse.
 */

export const OCCUPATION_COLOR: Record<string, string> = {
  consolidator: '#d8b36a',
  renovator: '#8fbe86',
  developer: '#7fe3e0',
  converter: '#b57ad0',
}

const MARKER_HEIGHT = 5.2

export class AgentMarkers {
  readonly mesh: InstancedMesh
  private dummy = new Object3D()
  private colour = new Color()
  private capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    const geometry = markerGeometry()
    const material = new MeshLambertMaterial({ vertexColors: false })
    this.mesh = new InstancedMesh(geometry, material, capacity)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.count = 0
  }

  /**
   * §21.6: positions arrive already interpolated between server frames — this
   * process does not own the agents and has nothing to step. §3's threshold
   * still applies and still keys off throughput: above it, agents stop reading
   * as moving and become presence markers, which is what `motion` carries.
   */
  update(
    agents: Iterable<AgentPresence>,
    groundY: number,
    _dt: number,
    time: number,
  ): void {
    let i = 0
    for (const a of agents) {
      if (i >= this.capacity) break

      /**
       * §47.3's marker language: working = parked + bright + pulsing;
       * travelling/acquiring = normal; idle = dim and slightly smaller. The
       * loudest markers are the ones doing something a viewer can watch.
       */
      const working = a.activity === 'building' || a.activity === 'demolishing'
      const idle = a.activity === 'idle'
      const pulse = working
        ? 1 + 0.22 * Math.sin(time * 4 + a.colourIndex)
        : idle
          ? 0.82
          : 1
      this.dummy.position.set(a.x, groundY + MARKER_HEIGHT * 0.5 * pulse, -a.y)
      this.dummy.scale.set(idle ? 0.85 : 1, pulse, idle ? 0.85 : 1)
      this.dummy.rotation.y = a.colourIndex * 0.5
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)

      this.colour.set(OCCUPATION_COLOR[a.strategy] ?? '#c8c8c8')
      // a stable per-agent value shift so recurring characters stay recognisable
      this.colour.offsetHSL(0, 0, ((a.colourIndex % 6) - 3) * 0.028)
      if (working) this.colour.offsetHSL(0, 0.06, 0.1)
      else if (idle) this.colour.multiplyScalar(0.55)
      this.mesh.setColorAt(i, this.colour)
      i++
    }
    this.mesh.count = i
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

/** Position from the frame, identity from the roster the client remembers. */
export type AgentPresence = AgentWire & Pick<AgentIdentity, 'strategy' | 'colourIndex'>

/** A pin: a tapered body under a marker cap. Reads as a presence, not a person. */
function markerGeometry(): BufferGeometry {
  const body = new CylinderGeometry(0.55, 1.15, MARKER_HEIGHT * 0.62, 6)
  body.translate(0, -MARKER_HEIGHT * 0.19, 0)
  const cap = new ConeGeometry(1.5, MARKER_HEIGHT * 0.44, 6)
  cap.translate(0, MARKER_HEIGHT * 0.28, 0)
  return mergeGeometries([body, cap])
}

/** Minimal merge — three's BufferGeometryUtils lives in examples and is not worth the import here. */
function mergeGeometries(parts: BufferGeometry[]): BufferGeometry {
  let vertexCount = 0
  for (const g of parts) vertexCount += g.getAttribute('position').count

  const position = new Float32Array(vertexCount * 3)
  const normal = new Float32Array(vertexCount * 3)
  let offset = 0
  for (const g of parts) {
    const nonIndexed = g.index ? g.toNonIndexed() : g
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
    if (nonIndexed !== g) nonIndexed.dispose()
    g.dispose()
  }

  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(position, 3))
  out.setAttribute('normal', new BufferAttribute(normal, 3))
  return out
}
