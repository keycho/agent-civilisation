import {
  type ChunkFrame,
  type RoadClass,
  type RoadEdge,
  type RoadNode,
  roadClassOf,
} from '@civ/core'
import type { OsmElement } from '../sources/overpass.ts'

/**
 * §7: graph, never geometry.
 *
 * OSM ways are polylines; what the simulation needs is a node/edge graph it can
 * path over, score access from, and insert agent-built edges into. Ribbon
 * geometry is generated from this at load time and never imported.
 */

export interface RoadGraphResult {
  nodes: RoadNode[]
  edges: RoadEdge[]
  classCounts: Record<string, number>
}

/** OSM shares junction nodes exactly, so rounding the projected metres reunites them. */
function nodeKey(x: number, y: number): string {
  return `${Math.round(x * 10)}:${Math.round(y * 10)}`
}

export function buildRoadGraph(ways: OsmElement[], frame: ChunkFrame): RoadGraphResult {
  const nodes = new Map<string, RoadNode>()
  const edges = new Map<string, RoadEdge>()
  const classCounts: Record<string, number> = {}

  const nodeIdFor = (lat: number, lon: number): string => {
    const [x, y] = frame.toLocal(lat, lon)
    const key = nodeKey(x, y)
    const existing = nodes.get(key)
    if (existing) return existing.id
    const id = `n${nodes.size}`
    nodes.set(key, { id, x, y, lat, lon })
    return id
  }

  // key -> RoadNode is what we build with; the emitted array is id-ordered
  const byId = new Map<string, RoadNode>()

  for (const way of ways) {
    const highway = way.tags?.highway
    if (!highway || !way.geometry || way.geometry.length < 2) continue
    const cls = roadClassOf(highway)
    if (!cls) continue
    classCounts[cls] = (classCounts[cls] ?? 0) + 1

    for (let i = 0; i + 1 < way.geometry.length; i++) {
      const p = way.geometry[i]
      const q = way.geometry[i + 1]
      const a = nodeIdFor(p.lat, p.lon)
      const b = nodeIdFor(q.lat, q.lon)
      if (a === b) continue
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      if (edges.has(key)) {
        // keep the more important class where ways overlap
        const cur = edges.get(key)!
        if (rank(cls) > rank(cur.class)) cur.class = cls
        continue
      }
      edges.set(key, {
        id: `e${edges.size}`,
        a,
        b,
        class: cls,
        agentBuilt: false,
        length: 0,
      })
    }
  }

  for (const n of nodes.values()) byId.set(n.id, n)
  for (const e of edges.values()) {
    const na = byId.get(e.a)!
    const nb = byId.get(e.b)!
    e.length = Math.hypot(nb.x - na.x, nb.y - na.y)
  }

  return { nodes: [...byId.values()], edges: [...edges.values()], classCounts }
}

function rank(c: RoadClass): number {
  switch (c) {
    case 'primary':
      return 5
    case 'secondary':
      return 4
    case 'residential':
      return 3
    case 'service':
      return 2
    case 'pedestrian':
      return 1
    default:
      return 0
  }
}
