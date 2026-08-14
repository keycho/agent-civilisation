import {
  ENVIRONMENT,
  ROAD_WIDTH,
  type RoadClass,
  type RoadEdge,
  type RoadNode,
  clamp01,
} from '@civ/core'
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshLambertMaterial } from 'three'

/**
 * §7/§16.6: roads generate ribbon geometry from the graph at load. Never
 * imported as polygons, never drawn as GIS lines.
 *
 * The baseline network is static and merged once. Agent-built edges live in a
 * second mesh that is rebuilt while any of them is still growing, so the
 * growth animation of §16.6 is a length clip on the ribbon rather than
 * special-case animation code — the road simply extends outward from wherever
 * it was attached to the existing network.
 */

const CLASS_COLOR: Record<RoadClass, string> = {
  primary: ENVIRONMENT.roadPrimary,
  secondary: ENVIRONMENT.roadSecondary,
  residential: ENVIRONMENT.roadResidential,
  service: ENVIRONMENT.roadService,
  pedestrian: ENVIRONMENT.roadPedestrian,
  footpath: ENVIRONMENT.roadPedestrian,
}

/** Slight vertical stagger so a service road does not z-fight a primary. */
const CLASS_LAYER: Record<RoadClass, number> = {
  primary: 0.34,
  secondary: 0.32,
  residential: 0.30,
  service: 0.28,
  pedestrian: 0.26,
  footpath: 0.24,
}

export interface RoadMeshes {
  baseline: Mesh
  agent: Mesh
}

/**
 * §21.5: the ground is no longer a plane, so `ground(x, y)` is sampled per
 * vertex rather than taken once. A ribbon laid at the mean datum floats over
 * the quay and sinks into the canal the moment there is real relief under it.
 */
export function createRoadMeshes(
  nodes: RoadNode[],
  edges: RoadEdge[],
  ground: (x: number, y: number) => number,
  halfExtentM: number,
): RoadMeshes {
  const byId = new Map<string, RoadNode>()
  for (const n of nodes) byId.set(n.id, n)

  // The graph reaches past the chunk on purpose (blocks on the edge need it);
  // the ribbons stop at the plate.
  const inside = (e: RoadEdge) => {
    const a = byId.get(e.a)
    const b = byId.get(e.b)
    if (!a || !b) return false
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    return Math.abs(mx) <= halfExtentM && Math.abs(my) <= halfExtentM
  }

  const baselineGeo = buildRibbons(
    edges.filter((e) => !e.agentBuilt && inside(e)),
    byId,
    ground,
    () => 1,
  )
  const baseline = new Mesh(baselineGeo, roadMaterial())
  baseline.receiveShadow = true
  baseline.renderOrder = -1

  const agent = new Mesh(new BufferGeometry(), agentRoadMaterial())
  agent.receiveShadow = true
  agent.renderOrder = -1
  agent.frustumCulled = false

  return { baseline, agent }
}

/**
 * Rebuild the agent-road mesh. `growth(edge)` returns 0..1 of how much of the
 * ribbon has been laid, which the caller derives from ticks since builtTick.
 */
export function updateAgentRoads(
  mesh: Mesh,
  nodes: Map<string, RoadNode>,
  edges: RoadEdge[],
  ground: (x: number, y: number) => number,
  growth: (e: RoadEdge) => number,
): void {
  mesh.geometry.dispose()
  mesh.geometry = buildRibbons(edges, nodes, ground, growth)
}

function buildRibbons(
  edges: RoadEdge[],
  nodes: Map<string, RoadNode>,
  ground: (x: number, y: number) => number,
  growth: (e: RoadEdge) => number,
): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const tmp = new Color()

  // junction discs, sized to the widest incident edge, keep corners from gapping
  const junction = new Map<string, number>()
  for (const e of edges) {
    const w = ROAD_WIDTH[e.class]
    junction.set(e.a, Math.max(junction.get(e.a) ?? 0, w))
    junction.set(e.b, Math.max(junction.get(e.b) ?? 0, w))
  }

  for (const e of edges) {
    const a = nodes.get(e.a)
    const b = nodes.get(e.b)
    if (!a || !b) continue
    const g = clamp01(growth(e))
    if (g <= 0.001) continue

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 0.05) continue
    const ux = dx / len
    const uy = dy / len
    const hw = ROAD_WIDTH[e.class] / 2
    const lift = CLASS_LAYER[e.class]

    // length clip: the ribbon grows outward from `a`
    const ex = a.x + ux * len * g
    const ey = a.y + uy * len * g

    tmp.set(CLASS_COLOR[e.class])
    if (e.agentBuilt) tmp.lerp(new Color(ENVIRONMENT.roadAgent), 0.75)

    // Both ends take their own ground height; a carriageway is a plane across
    // its width, which is why the two corners at each end share one sample.
    const ya = ground(a.x, a.y) + lift
    const yb = ground(ex, ey) + lift
    quad(
      positions,
      colors,
      tmp,
      [a.x - uy * hw, ya, -(a.y + ux * hw)],
      [a.x + uy * hw, ya, -(a.y - ux * hw)],
      [ex + uy * hw, yb, -(ey - ux * hw)],
      [ex - uy * hw, yb, -(ey + ux * hw)],
    )
  }

  for (const [id, width] of junction) {
    const n = nodes.get(id)
    if (!n) continue
    const r = width / 2
    const cls = 'residential' as RoadClass
    const y = ground(n.x, n.y) + CLASS_LAYER[cls] + 0.01
    tmp.set(CLASS_COLOR.residential)
    const seg = 6
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2
      const a1 = ((i + 1) / seg) * Math.PI * 2
      tri(
        positions,
        colors,
        tmp,
        [n.x, y, -n.y],
        [n.x + Math.cos(a0) * r, y, -(n.y + Math.sin(a0) * r)],
        [n.x + Math.cos(a1) * r, y, -(n.y + Math.sin(a1) * r)],
      )
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

type V3 = [number, number, number]

function quad(pos: number[], col: number[], c: Color, a: V3, b: V3, d: V3, e: V3): void {
  tri(pos, col, c, a, b, d)
  tri(pos, col, c, a, d, e)
}

function tri(pos: number[], col: number[], c: Color, a: V3, b: V3, d: V3): void {
  pos.push(...a, ...b, ...d)
  for (let i = 0; i < 3; i++) col.push(c.r, c.g, c.b)
}

function roadMaterial(): MeshLambertMaterial {
  return new MeshLambertMaterial({ vertexColors: true })
}

function agentRoadMaterial(): MeshLambertMaterial {
  return new MeshLambertMaterial({ vertexColors: true })
}
