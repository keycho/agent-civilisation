/**
 * §56.3: traffic as light. "No vehicle geometry at city zoom; the lights are
 * the life."
 *
 * Two populations, one grammar — a small billboarded point travelling a path:
 *
 *   - CARS run the road graph. Warm-white one way, red the other. There is no
 *     oneway flag, no lane count and no direction anywhere in RoadEdge, so
 *     "direction" here means direction of travel along the corridor: a light
 *     going one way is a headlight, going the other it is a tail light, and
 *     the lateral offset flips with it so the two streams sit on their own
 *     sides of the centreline instead of stacking.
 *   - BOATS run the water's edge, slowly, where a chunk has any.
 *
 * Particles travel CORRIDORS, not edges. The graph is OSM-noded: the median
 * edge is 5-13 m, so a particle confined to one edge would cross it in under a
 * second and respawn, and a street would read as a row of blinking dots rather
 * than as moving traffic. Corridors are built once at load by chaining edges
 * through the straightest continuation at each node, which is also what makes
 * a car follow a street around a bend instead of turning at random.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
} from 'three'
import type { RoadClass, RoadEdge, RoadNode } from '@civ/core'
import { hash01 } from './roadGraph.ts'

/** which classes carry traffic, and how much relative to their length */
const TRAFFIC_WEIGHT: Partial<Record<RoadClass, number>> = {
  primary: 1,
  secondary: 0.72,
  residential: 0.45,
  service: 0.2,
}

/** metres per second, by class — a primary moves, a service road crawls */
const TRAFFIC_SPEED: Record<string, number> = {
  primary: 13,
  secondary: 10,
  residential: 6.5,
  service: 4,
}

/**
 * One light per this many metres of PRIMARY corridor, divided by the class
 * weight for the rest. Set from the network rather than by feel: about 15 km
 * of traffic-carrying road falls inside a plate (the lamp pass counts 409 at
 * 38 m spacing, which is the same 15 km), so 30 m here is a few hundred lights
 * per city. A first pass at 95 m gave brooklyn 38 cars for a whole borough.
 */
const METRES_PER_CAR = 30

const HEADLIGHT = '#fff0d2'
const TAILLIGHT = '#ff4d2a'

interface Corridor {
  /** render-space polyline: x, y, z triples */
  pts: Float32Array
  /** cumulative length at each point */
  cum: Float32Array
  length: number
  cls: RoadClass
}

interface Particle {
  corridor: number
  s: number
  speed: number
  dir: 1 | -1
  lateral: number
}

function fullscreenQuadShader(): { vertexShader: string; fragmentShader: string } {
  return {
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aScale;
      varying vec2 vUv;
      varying vec3 vColor;
      uniform float uSizeM, uMinScreen;
      void main() {
        vUv = uv;
        vColor = aColor;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float size = max(uSizeM, -mv.z * uMinScreen) * aScale;
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      uniform float uIntensity;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        if (r > 1.0) discard;
        float core = pow(max(0.0, 1.0 - r), 3.0);
        float skirt = pow(max(0.0, 1.0 - r), 1.2) * 0.22;
        gl_FragColor = vec4(vColor * (core + skirt) * uIntensity, 1.0);
      }
    `,
  }
}

/**
 * Chain edges into corridors. At each node the walk continues through the
 * neighbour whose bearing is closest to the incoming one, so a corridor is a
 * street rather than an arbitrary path through the network.
 */
function buildCorridors(
  nodes: RoadNode[],
  edges: RoadEdge[],
  ground: (x: number, y: number) => number,
  halfExtentM: number,
  lift: number,
): Corridor[] {
  const byId = new Map<string, RoadNode>()
  for (const n of nodes) byId.set(n.id, n)

  const usable: number[] = []
  const adj = new Map<string, number[]>()
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (e.agentBuilt) continue
    if (!TRAFFIC_WEIGHT[e.class]) continue
    const a = byId.get(e.a)
    const b = byId.get(e.b)
    if (!a || !b) continue
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    if (Math.abs(mx) > halfExtentM || Math.abs(my) > halfExtentM) continue
    usable.push(i)
    for (const id of [e.a, e.b]) {
      const list = adj.get(id)
      if (list) list.push(i)
      else adj.set(id, [i])
    }
  }

  const used = new Set<number>()
  const corridors: Corridor[] = []

  const bearing = (from: RoadNode, to: RoadNode): number => Math.atan2(to.y - from.y, to.x - from.x)

  /** walk from `node` outward, never revisiting an edge, straightest first */
  const walk = (startEdge: number, fromNode: string): string[] => {
    const chain: string[] = [fromNode]
    let edge = startEdge
    let node = fromNode
    for (let guard = 0; guard < 400; guard++) {
      const e = edges[edge]
      const next = e.a === node ? e.b : e.a
      chain.push(next)
      used.add(edge)
      const here = byId.get(node)
      const there = byId.get(next)
      if (!here || !there) break
      const incoming = bearing(here, there)
      let best = -1
      let bestTurn = Infinity
      for (const cand of adj.get(next) ?? []) {
        if (used.has(cand)) continue
        const ce = edges[cand]
        const other = ce.a === next ? ce.b : ce.a
        const on = byId.get(other)
        if (!on) continue
        let turn = Math.abs(bearing(there, on) - incoming)
        while (turn > Math.PI) turn = Math.abs(turn - Math.PI * 2)
        // a corridor is a street: anything past a right angle is a junction,
        // not a continuation
        if (turn < bestTurn && turn < Math.PI * 0.4) {
          bestTurn = turn
          best = cand
        }
      }
      if (best < 0) break
      edge = best
      node = next
    }
    return chain
  }

  for (const i of usable) {
    if (used.has(i)) continue
    const e = edges[i]
    // walk both ways from the seed edge so a corridor is not truncated at its
    // own starting point
    const forward = walk(i, e.a)
    used.add(i)
    const backChain: string[] = []
    for (const cand of adj.get(e.a) ?? []) {
      if (used.has(cand)) continue
      const bc = walk(cand, e.a)
      backChain.push(...bc.slice(1).reverse())
      break
    }
    const chain = [...backChain, ...forward]
    if (chain.length < 2) continue

    const pts = new Float32Array(chain.length * 3)
    const cum = new Float32Array(chain.length)
    let total = 0
    for (let k = 0; k < chain.length; k++) {
      const n = byId.get(chain[k])
      if (!n) continue
      pts[k * 3] = n.x
      pts[k * 3 + 1] = ground(n.x, n.y) + lift
      pts[k * 3 + 2] = -n.y
      if (k > 0) {
        const dx = pts[k * 3] - pts[(k - 1) * 3]
        const dz = pts[k * 3 + 2] - pts[(k - 1) * 3 + 2]
        total += Math.hypot(dx, dz)
      }
      cum[k] = total
    }
    if (total < 30) continue
    corridors.push({ pts, cum, length: total, cls: e.class })
  }
  return corridors
}

/** ring of a water polygon, inset toward its centroid, as a closed corridor */
export function waterCorridors(
  surfaces: Array<{ kind: string; polygon: number[][] }>,
  ground: (x: number, y: number) => number,
  halfExtentM: number,
): Corridor[] {
  const out: Corridor[] = []
  for (const s of surfaces) {
    if (s.kind !== 'water') continue
    const ring = s.polygon
    if (!ring || ring.length < 8) continue
    let cx = 0
    let cy = 0
    for (const p of ring) {
      cx += p[0]
      cy += p[1]
    }
    cx /= ring.length
    cy /= ring.length
    let per = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      per += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    // a puddle is not a harbour
    if (per < 300) continue

    const pts: number[] = []
    for (let i = 0; i <= ring.length; i++) {
      const p = ring[i % ring.length]
      // pull off the bank so a boat is on the water, not on the quay
      const dx = cx - p[0]
      const dy = cy - p[1]
      const d = Math.hypot(dx, dy) || 1
      const inset = Math.min(18, d * 0.35)
      const x = p[0] + (dx / d) * inset
      const y = p[1] + (dy / d) * inset
      if (Math.abs(x) > halfExtentM || Math.abs(y) > halfExtentM) continue
      pts.push(x, ground(x, y) + 1.2, -y)
    }
    if (pts.length < 12) continue
    const arr = new Float32Array(pts)
    const cum = new Float32Array(arr.length / 3)
    let total = 0
    for (let k = 1; k < cum.length; k++) {
      const dx = arr[k * 3] - arr[(k - 1) * 3]
      const dz = arr[k * 3 + 2] - arr[(k - 1) * 3 + 2]
      total += Math.hypot(dx, dz)
      cum[k] = total
    }
    if (total < 200) continue
    out.push({ pts: arr, cum, length: total, cls: 'primary' })
  }
  return out
}

export class Traffic {
  readonly group = new Group()
  private mesh: InstancedMesh | null = null
  private corridors: Corridor[] = []
  private particles: Particle[] = []
  private matrix = new Matrix4()
  /** capture switch, so an a/b pair can isolate the traffic */
  on = true
  /** 0..1, driven by the chunk's decision rate — §56.3's "activity" */
  activity = 0.5
  /** render-space positions of the boats, for §56.6 to mirror */
  readonly boatCount: number = 0

  constructor(
    nodes: RoadNode[],
    edges: RoadEdge[],
    surfaces: Array<{ kind: string; polygon: number[][] }>,
    ground: (x: number, y: number) => number,
    halfExtentM: number,
    opts: { night: number },
  ) {
    // headlights at golden hour are as wrong as lit street lamps; the same
    // authored hour decides both (§50.2)
    if (opts.night < 0.45) return

    const road = buildCorridors(nodes, edges, ground, halfExtentM, 0.55)
    const water = waterCorridors(surfaces, ground, halfExtentM)
    this.corridors = [...road, ...water]
    if (!this.corridors.length) return
    const firstWater = road.length

    // how many lights, from corridor length weighted by class
    const specs: Particle[] = []
    for (let ci = 0; ci < this.corridors.length; ci++) {
      const c = this.corridors[ci]
      const isBoat = ci >= firstWater
      const weight = isBoat ? 1 : (TRAFFIC_WEIGHT[c.cls] ?? 0)
      // Boats are spaced against the length that survives the plate clip, not
      // against the river's full ring — tokyo's arakawa is 5.3 km around but
      // only a few hundred metres of it are inside the chunk.
      const per = isBoat ? 180 : METRES_PER_CAR / Math.max(0.08, weight)
      // Probabilistic rounding on a stable hash: a 200 m residential corridor
      // wants 3.0 cars and gets 3, but a 40 m one wants 0.6 and must not
      // always round to 1 (every stub lit) or always to 0 (the small streets
      // empty). Expected count stays length/per at any corridor length.
      const want = c.length / per
      const frac = want - Math.floor(want)
      const n = isBoat
        ? Math.max(1, Math.round(want))
        : Math.floor(want) + (hash01(ci * 5.31) < frac ? 1 : 0)
      for (let k = 0; k < n; k++) {
        const h = hash01(ci * 977 + k * 31.7)
        const dir: 1 | -1 = h < 0.5 ? 1 : -1
        specs.push({
          corridor: ci,
          s: (k / Math.max(1, n)) * c.length + h * 12,
          speed: isBoat
            ? 2.2 + h * 1.4
            : (TRAFFIC_SPEED[c.cls] ?? 8) * (0.82 + 0.36 * hash01(ci * 13.3 + k)),
          dir,
          // right-hand side of travel, so the two streams separate
          lateral: isBoat ? 0 : dir * 3.1,
        })
      }
    }
    if (!specs.length) return
    this.particles = specs
    ;(this as { boatCount: number }).boatCount = specs.filter((p) => p.corridor >= firstWater).length

    const n = specs.length
    const geo = new PlaneGeometry(1, 1)
    const colors = new Float32Array(n * 3)
    const scales = new Float32Array(n)
    const warm = new Color(HEADLIGHT)
    const red = new Color(TAILLIGHT)
    const boatWhite = new Color('#cfe4ff')
    for (let i = 0; i < n; i++) {
      const p = specs[i]
      const isBoat = p.corridor >= firstWater
      const c = isBoat ? boatWhite : p.dir > 0 ? warm : red
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
      // tail lights read smaller than headlights, as they do at any distance
      scales[i] = isBoat ? 1.15 : p.dir > 0 ? 1 : 0.82
    }
    geo.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))
    geo.setAttribute('aScale', new InstancedBufferAttribute(scales, 1))

    const shaders = fullscreenQuadShader()
    const mat = new ShaderMaterial({
      uniforms: {
        // above the §56.1 threshold, so a car's light blooms like every other
        // emitter in the frame
        uIntensity: { value: 1.5 },
        uSizeM: { value: 2.4 },
        uMinScreen: { value: 0.0019 },
      },
      vertexShader: shaders.vertexShader,
      fragmentShader: shaders.fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })

    const mesh = new InstancedMesh(geo, mat, n)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.renderOrder = 6
    this.mesh = mesh
    this.group.add(mesh)
    this.advance(0)
  }

  /** where along a corridor, with the lateral offset applied */
  private place(c: Corridor, s: number, lateral: number, out: Float32Array): void {
    const wrapped = ((s % c.length) + c.length) % c.length
    // walk the cumulative table; corridors are short enough that linear is
    // cheaper than the branch cost of a binary search here
    let k = 1
    while (k < c.cum.length - 1 && c.cum[k] < wrapped) k++
    const prev = c.cum[k - 1]
    const seg = Math.max(0.001, c.cum[k] - prev)
    const f = (wrapped - prev) / seg
    const ax = c.pts[(k - 1) * 3]
    const ay = c.pts[(k - 1) * 3 + 1]
    const az = c.pts[(k - 1) * 3 + 2]
    const bx = c.pts[k * 3]
    const by = c.pts[k * 3 + 1]
    const bz = c.pts[k * 3 + 2]
    const dx = bx - ax
    const dz = bz - az
    const d = Math.hypot(dx, dz) || 1
    out[0] = ax + dx * f - (dz / d) * lateral
    out[1] = ay + (by - ay) * f
    out[2] = az + dz * f + (dx / d) * lateral
  }

  private scratch = new Float32Array(3)

  /**
   * Position is a function of ABSOLUTE time, never an accumulation of dt.
   * Accumulating would make the traffic's state depend on how many frames had
   * been rendered, which is exactly what §56's pinned capture clock exists to
   * remove — a paused clock would still leave the cars drifting, and no a/b
   * pair involving a street would ever repeat.
   */
  private advance(time: number): void {
    const mesh = this.mesh
    if (!mesh) return
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      const c = this.corridors[p.corridor]
      const s = p.s + p.speed * p.dir * time
      this.place(c, s, p.lateral, this.scratch)
      this.matrix.makeTranslation(this.scratch[0], this.scratch[1], this.scratch[2])
      mesh.setMatrixAt(i, this.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  /**
   * §56.3: density scales with the chunk's activity. A quiet world is a quiet
   * street; a world mid-boom has its roads busy. Density is expressed by how
   * many of the lights are switched on, not by reallocating the buffer.
   */
  update(time: number, decisionsPerSecond: number): void {
    if (!this.mesh) return
    this.mesh.visible = this.on
    if (!this.on) return
    this.activity = Math.min(1, decisionsPerSecond / 6)
    // A quiet world still has traffic on it — the activity scale is the
    // difference between a street at night and a street mid-boom, not the
    // difference between a street and an empty one. The floor matters for
    // captures too: the a/b rig runs against a dead server, where the decision
    // rate is zero by construction.
    const live = Math.round(this.particles.length * (0.55 + 0.45 * this.activity))
    this.mesh.count = Math.min(this.particles.length, live)
    this.advance(time)
  }

  get count(): number {
    return this.particles.length
  }

  dispose(): void {
    if (!this.mesh) return
    this.mesh.geometry.dispose()
    ;(this.mesh.material as { dispose(): void }).dispose()
    this.group.remove(this.mesh)
  }
}
