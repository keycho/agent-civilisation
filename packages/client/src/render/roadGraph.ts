/**
 * §56: the road graph as a placement surface.
 *
 * Street lights (§56.1), traffic (§56.3) and street trees (§56.5) all want the
 * same thing — points spaced along the network, offset to the kerb, with the
 * edge's direction and class in hand. Deriving that three times invites three
 * different answers about which side of the road is which, so it is derived
 * once here.
 *
 * The one trap this module exists to contain: the world is authored in chunk
 * metres (x, y) and rendered with z NEGATED (x, height, -y). A perpendicular
 * computed after that flip points the wrong way, which would put every lamp on
 * the far kerb and every right-hand traffic lane in oncoming traffic. So all
 * geometry here is done in CHUNK space and converted exactly once, at the end,
 * by `toRender`.
 */
import { ROAD_WIDTH, type RoadClass, type RoadEdge, type RoadNode } from '@civ/core'

export interface FrontagePoint {
  /** render space, ready to place */
  x: number
  y: number
  z: number
  /** unit direction along the edge, in RENDER space (x, z), y is always 0 */
  dx: number
  dz: number
  /** which kerb: +1 left of travel, -1 right, 0 for centreline samples */
  side: number
  cls: RoadClass
  /** how far along this edge, 0..1 — lets callers phase things per point */
  t: number
  /** the edge's full length in metres */
  length: number
  /** stable per-point hash, 0..1 */
  hash: number
}

export interface SampleOptions {
  /** metres between samples, per class; omit or 0 to skip the class entirely */
  spacing: Partial<Record<RoadClass, number>>
  /** metres from the carriageway centreline to the sample, per class */
  offset?: Partial<Record<RoadClass, number>>
  /** true to emit on both kerbs, per class (default: one, chosen per edge) */
  bothSides?: Partial<Record<RoadClass, boolean>>
  /** skip agent-built roads (they animate their own growth) */
  baselineOnly?: boolean
  /** metres above the sampled ground */
  lift?: number
}

/** stable hash in 0..1 — placement must survive a reload unchanged */
export function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Walk the network and return placement points. `ground` is sampled in chunk
 * coordinates, exactly as the road ribbons do it, so a lamp stands on the quay
 * rather than floating over it.
 */
export function sampleRoadFrontage(
  nodes: RoadNode[],
  edges: RoadEdge[],
  ground: (x: number, y: number) => number,
  halfExtentM: number,
  opts: SampleOptions,
): FrontagePoint[] {
  const byId = new Map<string, RoadNode>()
  for (const n of nodes) byId.set(n.id, n)

  const out: FrontagePoint[] = []
  const lift = opts.lift ?? 0

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]
    if (opts.baselineOnly && e.agentBuilt) continue
    const spacing = opts.spacing[e.class] ?? 0
    if (spacing <= 0) continue

    const a = byId.get(e.a)
    const b = byId.get(e.b)
    if (!a || !b) continue

    // the graph deliberately overruns the plate; placements stop at its edge
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    if (Math.abs(mx) > halfExtentM || Math.abs(my) > halfExtentM) continue

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 4) continue
    const ux = dx / len
    const uy = dy / len
    // chunk-space perpendicular, BEFORE the render flip
    const px = -uy
    const py = ux

    const off = opts.offset?.[e.class] ?? ROAD_WIDTH[e.class] / 2 + 1.6
    const both = opts.bothSides?.[e.class] ?? false
    // one-sided runs alternate kerb per edge so a district does not end up
    // lit down one axis only
    const chosen = hash01(ei * 7.13) < 0.5 ? 1 : -1
    const sides = both ? [1, -1] : [chosen]

    /**
     * Start the walk at a per-edge phase rather than at a fixed half-spacing.
     * Starting fixed meant any edge shorter than the spacing got either
     * exactly one placement or none, and this network's mean edge is 23 m
     * against a 38 m residential spacing — so most of the city fell in the
     * "none" case and brooklyn lit 353 lamps across 57 km of street, one every
     * 160 m. With a hashed phase the expected count is len/spacing for every
     * edge regardless of length, short edges included, and the density comes
     * out at the spacing that was asked for. Still deterministic.
     */
    for (let s = hash01(ei * 3.77) * spacing; s < len; s += spacing) {
      const t = s / len
      for (const side of sides) {
        const cx = a.x + ux * s + px * off * side
        const cy = a.y + uy * s + py * off * side
        if (Math.abs(cx) > halfExtentM || Math.abs(cy) > halfExtentM) continue
        out.push({
          x: cx,
          y: ground(cx, cy) + lift,
          z: -cy,
          dx: ux,
          dz: -uy,
          side,
          cls: e.class,
          t,
          length: len,
          hash: hash01(ei * 131.7 + s * 0.37 + (side > 0 ? 0 : 51.1)),
        })
      }
    }
  }
  return out
}

/**
 * Edges as render-space polylines, for anything that has to travel the network
 * rather than sit beside it (§56.3's traffic). Returns chunk-space endpoints
 * plus the render-space conversion already applied.
 */
export interface TravelEdge {
  ax: number
  az: number
  bx: number
  bz: number
  /** ground height at each end, already lifted */
  ay: number
  by: number
  length: number
  cls: RoadClass
}

export function travelEdges(
  nodes: RoadNode[],
  edges: RoadEdge[],
  ground: (x: number, y: number) => number,
  halfExtentM: number,
  classes: Partial<Record<RoadClass, boolean>>,
  lift = 0.6,
): TravelEdge[] {
  const byId = new Map<string, RoadNode>()
  for (const n of nodes) byId.set(n.id, n)
  const out: TravelEdge[] = []
  for (const e of edges) {
    if (!classes[e.class]) continue
    const a = byId.get(e.a)
    const b = byId.get(e.b)
    if (!a || !b) continue
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    if (Math.abs(mx) > halfExtentM || Math.abs(my) > halfExtentM) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 8) continue
    out.push({
      ax: a.x,
      az: -a.y,
      bx: b.x,
      bz: -b.y,
      ay: ground(a.x, a.y) + lift,
      by: ground(b.x, b.y) + lift,
      length: len,
      cls: e.class,
    })
  }
  return out
}
