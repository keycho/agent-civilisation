import { DIVERGENCE, DIVERGENCE_WEIGHT, centroid } from '@civ/core'
import type { World } from './state.ts'

/**
 * §8. "Divergence index: scalar per district per year, percentage of baseline
 * stock touched weighted by intensity of change. The number that tells you
 * whether the economy constants are tuned, and the most quotable stat in the
 * product."
 */

export interface DivergenceReport {
  /** 0..1 — weighted share of the baseline stock that has been touched */
  index: number
  /** unweighted share of baseline buildings with any divergence at all */
  touchedShare: number
  counts: Record<number, number>
  agentOrigin: number
  demolished: number
  replaced: number
  /** the most-changed sector, which is what "one district unlike its 2026 self" means */
  peakSector: { index: number; x: number; y: number } | null
  sectors: number[]
  sectorGrid: number
}

const SECTOR_GRID = 4

export function divergenceReport(world: World): DivergenceReport {
  const counts: Record<number, number> = {}
  let weighted = 0
  let baselineCount = 0
  let touched = 0
  let agentOrigin = 0
  let demolished = 0
  let replaced = 0

  const span = Math.max(
    world.bounds.maxX - world.bounds.minX,
    world.bounds.maxY - world.bounds.minY,
  )
  const sectorWeighted = new Float64Array(SECTOR_GRID * SECTOR_GRID)
  const sectorCount = new Float64Array(SECTOR_GRID * SECTOR_GRID)

  for (const b of world.buildings.values()) {
    const c = centroid(b.footprint)
    const si = sectorIndex(world, c[0], c[1], span)

    if (b.source === 'agent_built') {
      agentOrigin++
      if (b.divergence === DIVERGENCE.replaced) replaced++
      continue
    }

    baselineCount++
    const cls = b.divergence
    counts[cls] = (counts[cls] ?? 0) + 1
    const w = DIVERGENCE_WEIGHT[cls] ?? 0
    weighted += w
    if (cls > 0) touched++
    if (b.state === 'demolished') demolished++

    if (si >= 0) {
      sectorWeighted[si] += w
      sectorCount[si] += 1
    }
  }

  const sectors: number[] = []
  let peak: DivergenceReport['peakSector'] = null
  for (let i = 0; i < sectorWeighted.length; i++) {
    // A sector holding a handful of buildings can hit 100% on one acquisition,
    // which is noise, not a district. Require some stock before it counts.
    const value = sectorCount[i] >= 12 ? sectorWeighted[i] / sectorCount[i] : 0
    sectors.push(value)
    if (!peak || value > peak.index) {
      const gx = i % SECTOR_GRID
      const gy = Math.floor(i / SECTOR_GRID)
      peak = {
        index: value,
        x: world.bounds.minX + ((gx + 0.5) * span) / SECTOR_GRID,
        y: world.bounds.minY + ((gy + 0.5) * span) / SECTOR_GRID,
      }
    }
  }

  return {
    index: baselineCount ? weighted / baselineCount : 0,
    touchedShare: baselineCount ? touched / baselineCount : 0,
    counts,
    agentOrigin,
    demolished,
    replaced,
    peakSector: peak,
    sectors,
    sectorGrid: SECTOR_GRID,
  }
}

function sectorIndex(world: World, x: number, y: number, span: number): number {
  const gx = Math.floor(((x - world.bounds.minX) / span) * SECTOR_GRID)
  const gy = Math.floor(((y - world.bounds.minY) / span) * SECTOR_GRID)
  if (gx < 0 || gy < 0 || gx >= SECTOR_GRID || gy >= SECTOR_GRID) return -1
  return gy * SECTOR_GRID + gx
}

/**
 * Emergent districts (§4): a cluster of agent work that has cohered enough to
 * be worth naming. Nothing lays these out; they are found.
 */
export interface EmergentDistrict {
  id: string
  buildingIds: string[]
  centroid: [number, number]
  intensity: number
}

const CLUSTER_RADIUS_M = 55
const CLUSTER_MIN = 7

export function findDistricts(world: World): EmergentDistrict[] {
  const points: Array<{ id: string; x: number; y: number; w: number }> = []
  for (const b of world.buildings.values()) {
    const w = DIVERGENCE_WEIGHT[b.divergence] ?? 0
    if (w < 0.5) continue
    const c = centroid(b.footprint)
    points.push({ id: b.id, x: c[0], y: c[1], w })
  }

  const seen = new Set<string>()
  const out: EmergentDistrict[] = []
  for (const p of points) {
    if (seen.has(p.id)) continue
    const group: typeof points = []
    const stack = [p]
    while (stack.length) {
      const cur = stack.pop()!
      if (seen.has(cur.id)) continue
      seen.add(cur.id)
      group.push(cur)
      for (const q of points) {
        if (seen.has(q.id)) continue
        if (Math.hypot(q.x - cur.x, q.y - cur.y) <= CLUSTER_RADIUS_M) stack.push(q)
      }
    }
    if (group.length < CLUSTER_MIN) continue
    let x = 0
    let y = 0
    let w = 0
    for (const g of group) {
      x += g.x
      y += g.y
      w += g.w
    }
    out.push({
      id: `d-${Math.round(x / group.length)}-${Math.round(y / group.length)}`,
      buildingIds: group.map((g) => g.id),
      centroid: [x / group.length, y / group.length],
      intensity: w / group.length,
    })
  }
  return out.sort((a, b) => b.buildingIds.length - a.buildingIds.length)
}
