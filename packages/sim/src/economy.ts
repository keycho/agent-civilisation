import type { Building, Parcel, Purpose } from '@civ/core'
import { DAYS_PER_YEAR, clamp, clamp01 } from '@civ/core'
import { type World, floorArea } from './state.ts'

/**
 * §4. The economy is property, not survival.
 *
 *   capital -> acquire -> improve/convert/redevelop -> yield -> reinvest ->
 *   acquire adjacent
 *
 * Four gradients make clustering rational rather than scripted:
 *   access cost      graph distance to the road network sets usable value
 *   adjacency yield  retail earns on foot traffic from nearby intensity
 *   land value       rises with built intensity within a radius
 *   condition decay  stops the world stabilising at year 6
 *
 * Every constant below is a tuning knob. §4 is explicit that if a district of
 * this size does not reach 30% divergence in 20 years, the constants are wrong
 * rather than the code — so they are gathered here and nowhere else, and
 * test/tune.ts measures them.
 */

export const ECONOMY = {
  /** capital per m² of land at the weakest access and lowest intensity */
  landBase: 0.55,
  /** capital per m² of floor area to build new */
  buildCost: 1.75,
  /** replacement value per m² of floor area at condition 1 */
  replacementValue: 1.35,

  rentPerM2Year: {
    residential: 0.135,
    retail: 0.225,
    commercial: 0.185,
    office: 0.195,
    industrial: 0.085,
    civic: 0.03,
    agricultural: 0.035,
    utility: 0.045,
  } as Record<Purpose, number>,

  /** annual maintenance as a fraction of replacement value */
  maintenanceRate: 0.012,
  /** condition lost per simulated year */
  decayPerYear: 0.021,
  /** premium a seller extracts over assessed value */
  acquisitionPremium: 0.12,

  renovateCostPerM2: 0.34,
  convertCostPerM2: 0.55,
  expandCostPerM2: 2.0,
  demolishCostPerM2: 0.3,
  roadCostPerM: 7.5,

  /** starting capital range for a first-generation agent */
  startingCapital: [1400, 4200] as [number, number],
  /** capital an agent draws from outside the chunk each year (financing) */
  annualFinancing: 260,

  /** radius over which built intensity is felt, metres */
  intensityRadius: 80,
} as const

// ---------------------------------------------------------------------------
// intensity field
// ---------------------------------------------------------------------------

/**
 * Built volume per cell, box-blurred to the intensity radius, plus the same
 * field split by purpose.
 *
 * The per-purpose split is what stops the market degenerating. Retail rent is
 * well above residential, so with a purpose-blind demand model every building
 * in the district converts to retail and the whole run collapses into one
 * divergence class. Local saturation makes the tenth shop on a street worth
 * much less than the first, which is both true and what keeps the mix mixed.
 */
export function recomputeIntensity(world: World): void {
  const cell = world.intensityCell
  const cols = Math.max(1, Math.ceil((world.bounds.maxX - world.bounds.minX) / cell) + 1)
  const rows = Math.max(1, Math.ceil((world.bounds.maxY - world.bounds.minY) / cell) + 1)
  world.intensityCols = cols
  world.intensityRows = rows

  const raw = new Float32Array(cols * rows)
  const byPurpose = new Map<Purpose, Float32Array>()
  const floorTotal = new Float32Array(cols * rows)

  for (const b of world.buildings.values()) {
    if (b.state === 'demolished') continue
    const c = b.footprint.length ? centroidFast(b) : null
    if (!c) continue
    const i = Math.round((c[0] - world.bounds.minX) / cell)
    const j = Math.round((c[1] - world.bounds.minY) / cell)
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue
    const k = j * cols + i
    raw[k] += b.areaM2 * b.heightM
    const fa = b.areaM2 * Math.max(1, b.levels)
    floorTotal[k] += fa
    let arr = byPurpose.get(b.purpose)
    if (!arr) {
      arr = new Float32Array(cols * rows)
      byPurpose.set(b.purpose, arr)
    }
    arr[k] += fa
  }

  const r = Math.max(1, Math.round(ECONOMY.intensityRadius / cell))
  const cellArea = (2 * r + 1) ** 2 * cell * cell
  world.intensity = boxBlur(raw, cols, rows, r, cellArea)
  world.floorTotal = boxBlur(floorTotal, cols, rows, r, 1)
  const blurredByPurpose = new Map<Purpose, Float32Array>()
  for (const [purpose, arr] of byPurpose) {
    blurredByPurpose.set(purpose, boxBlur(arr, cols, rows, r, 1))
  }
  world.floorByPurpose = blurredByPurpose
}

/** Separable box blur, normalised by `divisor` (pass 1 to keep raw sums). */
function boxBlur(
  src: Float32Array,
  cols: number,
  rows: number,
  r: number,
  divisor: number,
): Float32Array {
  const tmp = new Float32Array(cols * rows)
  const out = new Float32Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      for (let d = -r; d <= r; d++) {
        const ii = i + d
        if (ii < 0 || ii >= cols) continue
        s += src[j * cols + ii]
      }
      tmp[j * cols + i] = s
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      for (let d = -r; d <= r; d++) {
        const jj = j + d
        if (jj < 0 || jj >= rows) continue
        s += tmp[jj * cols + i]
      }
      out[j * cols + i] = s / divisor
    }
  }
  return out
}

/** Share of nearby floor area already given over to a purpose, 0..1. */
export function purposeShare(world: World, x: number, y: number, purpose: Purpose): number {
  if (!world.floorTotal || !world.floorByPurpose) return 0
  const cell = world.intensityCell
  const i = Math.round((x - world.bounds.minX) / cell)
  const j = Math.round((y - world.bounds.minY) / cell)
  if (i < 0 || j < 0 || i >= world.intensityCols || j >= world.intensityRows) return 0
  const k = j * world.intensityCols + i
  const total = world.floorTotal[k]
  if (total <= 1) return 0
  return clamp01((world.floorByPurpose.get(purpose)?.[k] ?? 0) / total)
}

/**
 * How much a marginal square metre of a purpose is worth given how much of it
 * is already there. The first shop on a street is valuable; the tenth is not.
 */
export function saturationFactor(share: number, tolerance: number): number {
  return clamp(1.3 - share / Math.max(0.05, tolerance), 0.12, 1.3)
}

function centroidFast(b: Building): [number, number] {
  let x = 0
  let y = 0
  for (const p of b.footprint) {
    x += p[0]
    y += p[1]
  }
  return [x / b.footprint.length, y / b.footprint.length]
}

/** Built volume per m² of ground within the intensity radius. */
export function intensityAt(world: World, x: number, y: number): number {
  if (!world.intensity) return 0
  const cell = world.intensityCell
  const i = Math.round((x - world.bounds.minX) / cell)
  const j = Math.round((y - world.bounds.minY) / cell)
  if (i < 0 || j < 0 || i >= world.intensityCols || j >= world.intensityRows) return 0
  return world.intensity[j * world.intensityCols + i]
}

/** 0..1, where 1 is about as dense as this fabric gets. */
export function normalisedIntensity(world: World, x: number, y: number): number {
  return clamp01(intensityAt(world, x, y) / 9)
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

export function landValuePerM2(world: World, p: Parcel): number {
  const access = 0.35 + 0.65 * clamp01(p.accessScore)
  const intensity = 0.45 + 1.35 * normalisedIntensity(world, p.centroid[0], p.centroid[1])
  return ECONOMY.landBase * access * intensity
}

export function recomputeLandValues(world: World): void {
  for (const p of world.parcels.values()) {
    p.landValue = landValuePerM2(world, p)
  }
}

export function parcelPrice(world: World, p: Parcel): number {
  return p.landValue * p.areaM2 * (1 + ECONOMY.acquisitionPremium)
}

export function buildingValue(world: World, b: Building): number {
  const parcel = world.parcelOf(b)
  const land = parcel ? parcel.landValue * parcel.areaM2 : b.areaM2 * ECONOMY.landBase
  const structure = floorArea(b) * ECONOMY.replacementValue * clamp(b.condition, 0.15, 1)
  return land + structure
}

export function acquisitionPrice(world: World, b: Building): number {
  return buildingValue(world, b) * (1 + ECONOMY.acquisitionPremium)
}

/**
 * §4's adjacency yield. Converted retail earns on foot traffic from nearby
 * residential intensity — intensity begets intensity, which is what makes a
 * cluster worth more than the same buildings scattered.
 */
/** How much of a district can plausibly be given over to each purpose. */
const SATURATION_TOLERANCE: Record<Purpose, number> = {
  retail: 0.22,
  office: 0.25,
  commercial: 0.25,
  residential: 0.8,
  industrial: 0.3,
  civic: 0.2,
  agricultural: 0.3,
  utility: 0.2,
}

export function demandFactor(world: World, b: Building): number {
  const c = centroidFast(b)
  const intensity = normalisedIntensity(world, c[0], c[1])
  const parcel = world.parcelOf(b)
  const access = parcel ? clamp01(parcel.accessScore) : 0.4
  const saturation = saturationFactor(
    purposeShare(world, c[0], c[1], b.purpose),
    SATURATION_TOLERANCE[b.purpose] ?? 0.3,
  )

  let base: number
  switch (b.purpose) {
    case 'retail':
      // §4's adjacency yield: retail earns on foot traffic from nearby
      // residential intensity, and is then divided by how much retail is
      // already competing for it.
      base = 0.35 + 1.5 * intensity + 0.35 * access
      break
    case 'commercial':
    case 'office':
      base = 0.5 + 0.95 * intensity + 0.4 * access
      break
    case 'residential':
      base = 0.72 + 0.5 * intensity + 0.3 * access
      break
    case 'industrial':
      // industry wants access, not neighbours
      base = 0.75 + 0.55 * access - 0.25 * intensity
      break
    default:
      base = 0.6 + 0.3 * access
  }
  return Math.max(0.05, base * saturation)
}

export function yieldPerTick(world: World, b: Building): number {
  if (b.state !== 'standing') return 0
  const rent = ECONOMY.rentPerM2Year[b.purpose] ?? 0.1
  const gross = floorArea(b) * rent * clamp(b.condition, 0.1, 1) * demandFactor(world, b)
  const maintenance = floorArea(b) * ECONOMY.replacementValue * ECONOMY.maintenanceRate
  return (gross - maintenance) / DAYS_PER_YEAR
}

export function recomputeYields(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.state === 'demolished') continue
    b.yieldPerTick = yieldPerTick(world, b)
  }
}

/** What an agent would gain per tick by restoring a building to condition 1. */
export function renovationUplift(world: World, b: Building): number {
  const before = yieldPerTick(world, b)
  const after = yieldPerTick(world, { ...b, condition: 1 })
  return after - before
}

export function renovationCost(b: Building): number {
  return floorArea(b) * ECONOMY.renovateCostPerM2 * (1 - clamp01(b.condition))
}

export function conversionCost(b: Building): number {
  return floorArea(b) * ECONOMY.convertCostPerM2
}

export function demolitionCost(b: Building): number {
  return b.areaM2 * ECONOMY.demolishCostPerM2
}

export function developmentCost(footprintM2: number, levels: number): number {
  return footprintM2 * levels * ECONOMY.buildCost
}

export function expansionCost(b: Building, addLevels: number): number {
  return b.areaM2 * addLevels * ECONOMY.expandCostPerM2
}

/**
 * Simple payback test used by every improvement decision: the years of net
 * yield needed to repay the cost. Agents accept different thresholds by
 * strategy, which is most of what makes them behave differently.
 */
export function paybackYears(cost: number, upliftPerTick: number): number {
  if (upliftPerTick <= 0) return Infinity
  return cost / (upliftPerTick * DAYS_PER_YEAR)
}

export function decayStep(world: World, ticks: number): void {
  const d = (ECONOMY.decayPerYear * ticks) / DAYS_PER_YEAR
  for (const b of world.buildings.values()) {
    if (b.state !== 'standing') continue
    b.condition = Math.max(0.05, b.condition - d)
  }
}
