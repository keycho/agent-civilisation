import type { ArchetypeId, BuildingSource, Purpose, Ring } from '../types.ts'
import type { LandmarkClass } from '../world.ts'
import { type FootprintMetrics, footprintMetrics } from '../geo/polygon.ts'

/** What 3DBAG's `b3_dak_type` tells us about the real roof. */
export type RoofHint = 'slanted' | 'horizontal' | 'multiple horizontal' | 'mixed' | 'unknown'

export interface ArchetypeInput {
  /** the real footprint, chunk-local metres. Preserved, never replaced. */
  footprint: Ring
  heightM: number
  levels: number
  purpose: Purpose
  constructionYear?: number
  source: BuildingSource
  roofHint?: RoofHint
  /**
   * §31.6-4: which fabric this stock belongs to. Selection is country-aware
   * because the same metrics mean different buildings in different cities — a
   * narrow deep three-storey residential is a rowhouse in schiedam and a
   * brownstone in red hook. Absent means the NL rules, which is what every
   * pre-§31.6-4 caller was getting.
   */
  country?: string
  /** §42.2: landmark class routes to the bespoke silhouettes before any rule */
  landmarkClass?: LandmarkClass
  /** precomputed to avoid recomputing the OBB twice */
  metrics?: FootprintMetrics
}

export interface ArchetypeChoice {
  archetype: ArchetypeId
  /** why, for the preview harness and the inspector */
  reason: string
  metrics: FootprintMetrics
}

/**
 * §16.1. Selection reads footprint area, aspect ratio, height, purpose tag and
 * construction year.
 *
 * Construction year is not decoration here. A 1907 warehouse and a 1975
 * apartment block have to land on different forms without anyone hand-tagging
 * them, and in this fabric the median building is from 1909 — so the pre/post
 * war split is doing most of the work of making the day-0 city look like
 * itself.
 */
export function selectArchetype(input: ArchetypeInput): ArchetypeChoice {
  const m = input.metrics ?? footprintMetrics(input.footprint)
  const { area, aspect } = m
  const width = m.obb.width
  const h = input.heightM
  const year = input.constructionYear ?? 1900
  const pick = (archetype: ArchetypeId, reason: string): ArchetypeChoice => ({
    archetype,
    reason,
    metrics: m,
  })

  // -- agent vocabulary (§16.1): a separate silhouette language, not a recolour
  if (input.source === 'agent_built') {
    if (h >= 26) return pick('agent_tower', `agent build, ${h.toFixed(0)}m`)
    if (area >= 800 && h < 14) return pick('agent_hall', `agent build, ${area.toFixed(0)}m2 floorplate`)
    if (aspect >= 2.4 && h >= 9) return pick('agent_slab', `agent build, aspect ${aspect.toFixed(1)}`)
    return pick('agent_block', 'agent build')
  }

  /**
   * §42.2: landmarks get their silhouette regardless of any other rule — a
   * gasholder must read as a gasholder. `historic` carries no form of its
   * own; it keeps the fabric rules and rides economics and weight instead.
   */
  switch (input.landmarkClass) {
    case 'gasholder':
      return pick('gasholder', 'landmark: gasholder')
    case 'water_tower':
      return pick('water_tower', 'landmark: water tower')
    case 'crane':
      return pick('crane', 'landmark: crane')
    case 'station':
      return pick('station_shed', 'landmark: station')
    case 'church':
      return pick('civic', 'landmark: church')
    default:
      break
  }

  // -- inherited fabric
  if (input.purpose === 'civic') return pick('civic', 'civic purpose')
  if (input.purpose === 'agricultural') return pick('agricultural', 'agricultural purpose')

  if (h >= 26 || input.levels >= 9) return pick('tower', `${h.toFixed(0)}m / ${input.levels} levels`)

  /**
   * §31.6-4a: the us fabric. No construction years in us data (§18.4 note
   * travels with the adapter), so these rules read form only — width, area,
   * height — never the year the NL rules lean on.
   */
  if (input.country === 'US') {
    if (
      input.purpose === 'residential' &&
      width <= 8.5 &&
      aspect >= 1.15 &&
      area <= 260 &&
      input.levels <= 5
    ) {
      return pick('brownstone_row', `us narrow ${width.toFixed(1)}m, ${input.levels} levels`)
    }
    if (
      (input.purpose === 'industrial' ||
        input.purpose === 'utility' ||
        input.purpose === 'commercial') &&
      area >= 450 &&
      h >= 12
    ) {
      return pick('setback_industrial', `us bulk ${area.toFixed(0)}m2, ${h.toFixed(0)}m`)
    }
  }

  /**
   * §31.6-4c: the jp fabric. Shitamachi grain is the smallest in the set —
   * wooden two-storey dwellings and workshop-houses on alley plots. Form
   * only, like the us rules: jp data carries years rarely.
   */
  if (input.country === 'JP') {
    if (
      (input.purpose === 'residential' || input.purpose === 'retail' || input.purpose === 'industrial') &&
      input.levels <= 3 &&
      area <= 180 &&
      h <= 11
    ) {
      return pick('machiya_row', `jp fine grain ${area.toFixed(0)}m2, ${input.levels} levels`)
    }
  }

  /**
   * §31.6-4b: the fr fabric. The mansard block is the haussmannian/faubourien
   * perimeter parcel: mid-rise, deep, continuous roofline. Height carries the
   * rule (4-8 storeys); the perimeter split hands this selector pieces of
   * roughly 15 m frontage, and small low stock falls through to the shared
   * rules.
   */
  if (input.country === 'FR') {
    if (
      (input.purpose === 'residential' ||
        input.purpose === 'commercial' ||
        input.purpose === 'office' ||
        input.purpose === 'retail') &&
      h >= 11 &&
      input.levels >= 4 &&
      area >= 120
    ) {
      return pick('mansard_block', `fr mid-rise ${input.levels} levels, ${area.toFixed(0)}m2`)
    }
  }

  if (input.purpose === 'industrial' || input.purpose === 'utility') {
    return area >= 700
      ? pick('industrial', `industrial, ${area.toFixed(0)}m2`)
      : pick('warehouse', `industrial, ${area.toFixed(0)}m2`)
  }

  // Pre-war commercial bulk on a big plot is a warehouse in this fabric — the
  // Schiedam distillery stock is exactly this, and it is the most characterful
  // silhouette in the area.
  if (year < 1940 && area >= 320 && input.purpose !== 'residential') {
    return pick('warehouse', `pre-war bulk ${area.toFixed(0)}m2, built ${year}`)
  }

  if (input.purpose === 'retail') return pick('retail', 'retail purpose')

  if (input.purpose === 'commercial' || input.purpose === 'office') {
    if (input.levels <= 3) return pick('retail', `${input.purpose}, low`)
    return pick('apartment', `${input.purpose}, ${input.levels} levels`)
  }

  // residential
  if (width <= 9.5 && aspect >= 1.25 && area <= 300 && year < 1970) {
    return pick('rowhouse', `narrow ${width.toFixed(1)}m, deep, built ${year}`)
  }
  if (area <= 130 && h <= 9) {
    return pick('rowhouse', `small dwelling ${area.toFixed(0)}m2`)
  }
  if (year >= 1945 || input.levels >= 4) {
    return pick('apartment', `post-war residential, ${input.levels} levels`)
  }
  if (area >= 400) return pick('warehouse', `large pre-war mass ${area.toFixed(0)}m2`)
  return pick('rowhouse', `default residential, built ${year}`)
}

/** Roof forms the generator can build. Chosen from archetype plus real evidence. */
export type RoofForm =
  | 'gable'
  | 'stepped_gable'
  | 'hip'
  | 'flat'
  | 'parapet'
  | 'sawtooth'
  | 'shallow'
  | 'barn'
  | 'spire'

/**
 * The roof is where real data and stylisation meet. 3DBAG's `b3_dak_type` is
 * derived from lidar, so it knows whether a given building actually has a
 * pitched roof — but a pitched roof is only *buildable* on the OBB when the
 * plan is close to rectangular, otherwise the roof drifts off its walls.
 * Rectangularity is therefore a hard gate, not a preference.
 */
export function selectRoof(
  archetype: ArchetypeId,
  m: FootprintMetrics,
  hint: RoofHint | undefined,
  year: number,
): RoofForm {
  const boxy = m.rectangularity >= 0.82
  const slanted = hint === 'slanted' || hint === 'mixed'
  const flatEvidence = hint === 'horizontal' || hint === 'multiple horizontal'

  switch (archetype) {
    case 'agent_block':
    case 'agent_slab':
    case 'agent_tower':
    case 'agent_hall':
      return 'parapet'
    case 'tower':
      return 'parapet'
    case 'civic':
      return 'spire'
    case 'agricultural':
      return boxy ? 'barn' : 'shallow'
    case 'warehouse':
      if (flatEvidence) return 'parapet'
      if (boxy && m.aspect >= 1.9 && m.area >= 500) return 'sawtooth'
      return boxy ? 'gable' : 'shallow'
    case 'industrial':
      if (flatEvidence) return 'flat'
      return boxy && m.aspect >= 1.6 ? 'sawtooth' : 'shallow'
    case 'retail':
      return flatEvidence || !boxy ? 'parapet' : 'gable'
    case 'apartment':
      if (slanted && boxy) return 'hip'
      return 'parapet'
    case 'rowhouse':
      if (flatEvidence) return 'parapet'
      if (!boxy) return 'shallow'
      // Stepped gables are a pre-industrial canal-frontage element. Gating on
      // year keeps them where they belong instead of sprinkling them.
      return year < 1830 ? 'stepped_gable' : 'gable'
    // §31.6-4a: both us forms are flat-roofed types — the cornice and the
    // setback tiers carry the silhouette, never a pitch.
    case 'brownstone_row':
    case 'setback_industrial':
      return 'parapet'
    // §31.6-4b: the mansard band is built by the generator, not the roof
    // system — the roof slot stays flat above it.
    case 'mansard_block':
      return 'parapet'
    // §31.6-4c: the machiya's gentle tiled gable is the type; flat evidence
    // still wins where osm says so.
    case 'machiya_row':
      return flatEvidence ? 'parapet' : 'shallow'
    // §42.2: landmark forms own their tops in the generator
    case 'gasholder':
    case 'water_tower':
    case 'crane':
      return 'flat'
    case 'station_shed':
      return 'gable'
    default:
      return 'gable'
  }
}
