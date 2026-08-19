import { DIVERGENCE, DIVERGENCE_WEIGHT, centroid } from '@civ/core'
import type { World } from './state.ts'

/**
 * §8 as amended by §20.7: the divergence index loses its denominator. It never
 * needed a time one — it is a scalar of current state: the percentage of
 * baseline stock touched, weighted by intensity of change. The curve plots
 * against cumulative agent decisions, not against a calendar.
 *
 * It is the number that says whether the economy constants are tuned, and the
 * most quotable stat in the product.
 */

export interface DivergenceReport {
  /** 0..1 — weighted share of the baseline stock that has been touched */
  index: number
  /** unweighted share of baseline buildings with any divergence at all */
  touchedShare: number
  /**
   * §70.2: baseline stock that still reads as the world we left it — standing,
   * and no further from its imported self than a renovation.
   *
   * This replaces §58.6's untouched floor, which measured the wrong quantity.
   * §26.2's fear was uniform REDEVELOPMENT, not uniform activity: a renovated
   * 1909 terrace is still a 1909 terrace and still supplies the contrast that
   * lets change read, while a cleared lot supplies none. The divergence classes
   * are monotonic and ordered by how far a building has moved from its import,
   * so the line falls naturally between renovated (2) and converted (3) — past
   * that point the building has changed purpose or massing and no longer reads
   * as what was there.
   */
  /**
   * §73.3: the grey, restated on MAGNITUDE rather than on incidence.
   *
   * §70.2's line was "standing and no further than a renovation", which is a
   * class comparison — and the classes record WHETHER something happened, not
   * how much. §72.5 bounded how far a structure can be expanded and the number
   * did not move by a tenth of a percent, because a terrace at 2→3 storeys and
   * one at 2→7 both read as `expanded`. A bar that cannot see the fix is not
   * measuring the thing the fix is about.
   *
   * So: a baseline building is grey while it still STANDS, still serves the
   * PURPOSE it was imported with, and is within 50% of its ORIGINAL HEIGHT.
   * A terrace grown from two floors to three is grey; at two to four it is not.
   * That is what the eye does with it, and it is what §26.2 was reaching for.
   */
  greyShare: number
  /**
   * §73.3: where the grey goes, condition by condition, as counts of baseline
   * stock. A bar that only reports its own value says nothing about which of
   * its three clauses is binding, and that is the first thing anyone asks.
   */
  greyLost: { gone: number; repurposed: number; taller: number }
  counts: Record<number, number>
  agentOrigin: number
  demolished: number
  replaced: number
  /** the most-changed sector — "one district unlike its baseline" (§20.8) */
  peakSector: { index: number; x: number; y: number } | null
  sectors: number[]
  sectorGrid: number
}

const SECTOR_GRID = 4

/**
 * §73.3: how far a baseline building's height may move and still read as
 * itself. Half again — a two-storey terrace at three storeys, a four at six.
 */
const GREY_HEIGHT_BAND = 0.5

export function divergenceReport(world: World): DivergenceReport {
  const counts: Record<number, number> = {}
  let weighted = 0
  let baselineCount = 0
  let touched = 0
  let grey = 0
  let gone = 0
  let repurposed = 0
  let taller = 0
  let agentOrigin = 0
  let demolished = 0
  let replaced = 0

  const span = Math.max(
    world.bounds.maxX - world.bounds.minX,
    world.bounds.maxY - world.bounds.minY,
  )
  const sectorWeighted = new Float64Array(SECTOR_GRID * SECTOR_GRID)
  const sectorCount = new Float64Array(SECTOR_GRID * SECTOR_GRID)
  // §73.3: the import, for the two comparisons the grey line makes against it
  const baseline = new Map(world.seed.buildings.map((b) => [b.id, b]))

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
    /**
     * §73.3: three conditions, all on the thing itself rather than on a record
     * of what was done to it. Standing, same purpose, and no more than half
     * again as tall as it was imported.
     *
     * Height rather than levels because that is what the frame shows — a
     * building whose storeys were subdivided has not changed the skyline, and
     * one that gained three metres of parapet has. The baseline height comes
     * from the seed rather than from `designLevels * 3.2`, so it is the
     * imported measurement and not a reconstruction of it.
     */
    const base = baseline.get(b.baselineId ?? b.id)
    const standing = b.state === 'standing'
    const tall = base ? Math.abs(b.heightM - base.heightM) > base.heightM * GREY_HEIGHT_BAND : false
    const moved = base ? b.purpose !== base.purpose : false
    if (standing && !tall && !moved) grey++
    // counted in order of finality, so each building is charged to one clause
    else if (!standing) gone++
    else if (moved) repurposed++
    else taller++
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
    greyShare: baselineCount ? grey / baselineCount : 0,
    greyLost: { gone, repurposed, taller },
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

/**
 * §23.6, found by watching rather than by measuring: the feed said "1094
 * buildings changed within 55 m of each other" in a chunk that holds 925
 * baseline buildings.
 *
 * The growth below is single-linkage — it chains transitively, so A near B and
 * B near C puts A and C in one group however far apart they are. In continuous
 * urban fabric almost every building has a neighbour inside 55 m, so once the
 * agents had worked over enough of the city the whole touched set collapsed
 * into a single "district" that was the city. The claim in the rationale was
 * false as written, and the count exceeded the baseline stock because
 * agent-built structures joined the same chain.
 *
 * §26.2 keeps the divergence index per district now that the global scalar is
 * retired, so a district that is the whole chunk is not a cosmetic problem: it
 * is the unit the headline is about to rest on.
 *
 * The bound is on extent, not on count. A district stays a connected cluster,
 * but it may not span more than this, which is roughly two blocks of Schiedam
 * and is about what the word has to mean at this scale. Anything larger is not
 * one district however well connected it is.
 */
export const DISTRICT_SPAN_M = 220

export function findDistricts(world: World): EmergentDistrict[] {
  const points: Array<{ id: string; x: number; y: number; w: number }> = []
  for (const b of world.buildings.values()) {
    const w = DIVERGENCE_WEIGHT[b.divergence] ?? 0
    if (w < 0.5) continue
    const c = centroid(b.footprint)
    points.push({ id: b.id, x: c[0], y: c[1], w })
  }

  const reach = DISTRICT_SPAN_M / 2
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
        // connected to the growing edge, and still inside the seed's span
        if (Math.hypot(q.x - cur.x, q.y - cur.y) > CLUSTER_RADIUS_M) continue
        if (Math.hypot(q.x - p.x, q.y - p.y) > reach) continue
        stack.push(q)
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
