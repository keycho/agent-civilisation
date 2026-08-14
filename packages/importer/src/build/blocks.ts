import {
  BLOCK_BOUNDING_CLASSES,
  type Block,
  ROAD_WIDTH,
  type Ring,
  type RoadEdge,
  type RoadNode,
  signedArea,
} from '@civ/core'

/**
 * §6 step 1: take the road graph and extract the planar faces it encloses.
 * Those are city blocks. Works anywhere there is a road network, which is the
 * whole point — open cadastral data mostly does not exist.
 *
 * Standard face traversal: at every node the neighbours are sorted by angle,
 * and the successor of an incoming half-edge is the next neighbour clockwise.
 * Following that rule around the graph walks each interior face exactly once,
 * counterclockwise. The single face that comes out clockwise is the unbounded
 * outside, and it is discarded.
 */

export interface BlocksResult {
  blocks: Block[]
  dropped: { tooSmall: number; tooLarge: number; degenerate: number }
}

export function extractBlocks(
  nodes: RoadNode[],
  allEdges: RoadEdge[],
  opts: { minAreaM2?: number; maxAreaM2?: number } = {},
): BlocksResult {
  const minArea = opts.minAreaM2 ?? 180
  const maxArea = opts.maxAreaM2 ?? 90_000

  // Sidewalks and cycleways are excluded here — see BLOCK_BOUNDING_CLASSES.
  const edges = allEdges.filter((e) => BLOCK_BOUNDING_CLASSES.has(e.class))

  const byId = new Map<string, RoadNode>()
  for (const n of nodes) byId.set(n.id, n)

  // adjacency, sorted counterclockwise by bearing
  const adj = new Map<string, string[]>()
  const widthByPair = new Map<string, number>()
  for (const e of edges) {
    if (!byId.has(e.a) || !byId.has(e.b)) continue
    push(adj, e.a, e.b)
    push(adj, e.b, e.a)
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`
    widthByPair.set(key, Math.max(widthByPair.get(key) ?? 0, ROAD_WIDTH[e.class]))
  }
  for (const [id, neighbours] of adj) {
    const self = byId.get(id)!
    neighbours.sort((p, q) => bearing(self, byId.get(p)!) - bearing(self, byId.get(q)!))
  }

  const visited = new Set<string>()
  const blocks: Block[] = []
  const dropped = { tooSmall: 0, tooLarge: 0, degenerate: 0 }

  for (const e of edges) {
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      const startKey = `${from}>${to}`
      if (visited.has(startKey)) continue

      const ring: Ring = []
      let u = from
      let v = to
      let guard = 0
      let ok = true
      let widest = 0

      while (guard++ < 4000) {
        visited.add(`${u}>${v}`)
        const pairKey = u < v ? `${u}|${v}` : `${v}|${u}`
        widest = Math.max(widest, widthByPair.get(pairKey) ?? 0)
        const nv = byId.get(v)
        if (!nv) {
          ok = false
          break
        }
        ring.push([nv.x, nv.y])

        const neighbours = adj.get(v)
        if (!neighbours || neighbours.length === 0) {
          ok = false
          break
        }
        const i = neighbours.indexOf(u)
        if (i < 0) {
          ok = false
          break
        }
        // step clockwise from the incoming edge to stay on the same face
        const w = neighbours[(i - 1 + neighbours.length) % neighbours.length]
        u = v
        v = w
        if (u === from && v === to) break
      }

      if (!ok || ring.length < 3) {
        dropped.degenerate++
        continue
      }
      const sa = signedArea(ring)
      if (sa <= 0) continue // the unbounded outer face
      const a = sa
      if (a < minArea) {
        dropped.tooSmall++
        continue
      }
      if (a > maxArea) {
        dropped.tooLarge++
        continue
      }
      blocks.push({
        id: `blk-${blocks.length}`,
        polygon: ring,
        areaM2: a,
        parcelIds: [],
        roadHalfWidthM: widest / 2,
      })
    }
  }

  return { blocks, dropped }
}

function push(m: Map<string, string[]>, k: string, v: string): void {
  const arr = m.get(k)
  if (arr) {
    if (!arr.includes(v)) arr.push(v)
  } else m.set(k, [v])
}

function bearing(a: RoadNode, b: RoadNode): number {
  return Math.atan2(b.y - a.y, b.x - a.x)
}
