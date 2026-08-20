/**
 * §72.5: what a building can physically carry.
 *
 * §70.2's bar failed at 9.7% against a 40% floor and the cause was expansion,
 * not clearing — expanded stock went 38.1% to 73.0% while cleared fell 31.3% to
 * 13.7%. §70's funding gate stopped agents spending capital on demolition and
 * they spent it on storeys instead. The bar is measuring the right thing: a
 * 1909 terrace that has grown from two floors to six is not the world we left,
 * whatever the action was called.
 *
 * The answer is not a cap. It is that **an 1909 masonry terrace cannot carry
 * six added floors and a modern frame can**. Load-bearing brick walls are sized
 * for the loads above them and thicken as they go down; there is no spare
 * capacity designed in, and adding storeys means underpinning and rebuilding
 * the lower walls — which is redevelopment wearing an extension's name. A
 * portal-frame shed carries a roof, not a floor. A post-war concrete frame was
 * designed to a code with some redundancy. A modern frame can take a light
 * addition.
 *
 * So era and construction type set the ceiling, and the ceiling is a property
 * of the structure AS BUILT rather than of the structure as it now stands.
 * That distinction is the whole mechanism: a rule of "current levels plus two"
 * re-reads itself after every expansion and is unbounded — six expansions of
 * one floor each are indistinguishable from one of six, and that is exactly the
 * ratchet that spent the grey. `designLevels` is what the structure was built
 * as, and it never moves.
 *
 * The push this produces is the one §58 wants: capital that cannot go into
 * stacking storeys on victorian brick goes into clearing and rebuilding at
 * height, which is what actually happens to cities under pressure.
 */
import type { Building, Purpose } from '@civ/core'
import { CONVERSION, STRUCTURAL_CAPACITY } from './state.ts'

/**
 * How the structure carries its loads. Not a field on the seed — no importer
 * has it — so it is derived from what the seed does carry: era where a
 * construction year survived the import, and the archetype where it did not.
 */
export type StructuralClass =
  | 'masonry'
  | 'timber'
  | 'shed'
  | 'monument'
  | 'early_frame'
  | 'post_war_frame'
  | 'modern_frame'

/**
 * Total levels the structure can stand at, including the ones it has.
 *
 * `masonry` and `timber` get one floor because that is roughly what a
 * strengthened wall or a reframed roof will take before the work becomes a
 * rebuild. `shed` and `monument` get none: a single-storey portal frame and a
 * gasholder are not structures with a spare floor in them. The frames get more
 * as their codes get newer, and every class is bounded absolutely as well as
 * relatively, because "plus three" on a fourteen-storey slab is a different
 * proposition from "plus three" on a four-storey one.
 */
const HEADROOM: Record<StructuralClass, { add: number; ceiling: number }> = {
  monument: { add: 0, ceiling: 0 },
  shed: { add: 0, ceiling: 0 },
  timber: { add: 1, ceiling: 3 },
  masonry: { add: 1, ceiling: 5 },
  early_frame: { add: 2, ceiling: 8 },
  post_war_frame: { add: 3, ceiling: 12 },
  modern_frame: { add: 4, ceiling: 16 },
}

/** archetypes that are a structure for one purpose and have no floor to add */
const SHEDS = new Set(['industrial', 'setback_industrial', 'warehouse', 'agricultural'])
const MONUMENTS = new Set(['gasholder', 'water_tower', 'crane', 'station_shed'])
/** §31.6-4c: shitamachi is wood under grey tile, and wood does not stack */
const TIMBER = new Set(['machiya_row'])
/** the masonry vernaculars: brick and stone walls carrying floors directly */
const MASONRY = new Set(['rowhouse', 'brownstone_row', 'mansard_block'])

export function structuralClass(b: Building): StructuralClass {
  if (MONUMENTS.has(b.archetype)) return 'monument'
  if (TIMBER.has(b.archetype)) return 'timber'
  /**
   * §72.5: agent-built stock carries its design.
   *
   * It is the modern floorplate §18.4's pricing compares everything else
   * against, so it gets the modern frame's headroom — and, like everything
   * else, it gets it once, measured from what it was built as.
   */
  if (b.source === 'agent_built') return 'modern_frame'

  const design = designLevels(b)
  // a shed is single-storey by construction; a four-storey mill is a frame
  // building that happens to be industrial, and those are converted all the time
  if (SHEDS.has(b.archetype) && design <= 2) return 'shed'

  const year = b.constructionYear
  if (year === undefined) {
    /**
     * §31.2/§18.4: London's import carries no construction years, so the era
     * has to be read off the fabric. Height is the honest proxy at this grain —
     * load-bearing masonry in these neighbourhoods does not reach six storeys,
     * and something that does is a frame whatever its date.
     */
    if (design >= 6) return 'post_war_frame'
    if (design >= 4) return 'early_frame'
    return MASONRY.has(b.archetype) || design <= 3 ? 'masonry' : 'early_frame'
  }
  if (year < 1919) return 'masonry'
  if (year < 1946) return MASONRY.has(b.archetype) ? 'masonry' : 'early_frame'
  if (year < 1981) return 'post_war_frame'
  return 'modern_frame'
}

/**
 * What the structure was built as, which is what its capacity is measured from.
 *
 * Absent on stock that predates this field, and there `levels` is the best
 * available answer — for a building that has never been expanded it is the
 * right one, and for one that has it is generous rather than wrong, which is
 * the correct direction to be imprecise in.
 */
export function designLevels(b: Building): number {
  return b.designLevels ?? b.levels
}

/** The most levels this structure can stand at. Never below what it already is. */
export function structuralCapacity(b: Building): number {
  // the a/b's before-arm: the flat ceiling §72.5 replaces, so the comparison is
  // against an identical seed in one process rather than a remembered number
  if (!STRUCTURAL_CAPACITY.on) return b.source === 'agent_built' ? 8 : 6
  const { add, ceiling } = HEADROOM[structuralClass(b)]
  const design = designLevels(b)
  return Math.max(b.levels, Math.min(design + add, Math.max(design, ceiling)))
}

/** How many levels could still be added to this structure. Often zero. */
export function expansionHeadroom(b: Building): number {
  return Math.max(0, structuralCapacity(b) - b.levels)
}

/**
 * §74.3: what a building's FORM will let it become.
 *
 * The last of the three mechanisms that spend the grey. §70 bounded clearing by
 * making a plan fund its whole self; §72.5 bounded expansion by what the
 * structure can carry; and the §73.3 decomposition then measured what was left:
 * 422-529 baseline buildings per chunk change purpose, 45-57 percent of stock,
 * an order of magnitude more than the two bounded mechanisms cost together. A
 * 1909 masonry terrace could become a factory.
 *
 * The same real reason applies. Floor loading, column spacing, floorplate,
 * servicing and access decide what a conversion can be, and they are properties
 * of the form rather than of the market. Terrace to factory does not happen.
 * Warehouse to loft apartments happens constantly.
 *
 * Keyed on FORM rather than on `structuralClass`, which is a deliberate reading
 * of §74.3's call rather than a literal one. `structuralClass` answers what the
 * thing is made of and how it carries load, which is what a HEIGHT limit turns
 * on; conversion turns on plan and floorplate, and §74.3's own table names
 * forms — terrace, warehouse, civic, slab, tower — not eras. A four-storey
 * brick mill and a four-storey brick terrace share a structural class and
 * convert nothing alike.
 */
export type ConversionClass = 'fine_grain' | 'open_floorplate' | 'civic_monument' | 'slab' | 'tower'

/** terraces and shopfronts: narrow frontage, party walls, stairs not lifts */
const FINE_GRAIN = new Set(['rowhouse', 'brownstone_row', 'mansard_block', 'machiya_row', 'retail'])
/** the permissive one — big clear spans, loading, floor loading already there */
const OPEN_PLATE = new Set([
  'warehouse',
  'industrial',
  'setback_industrial',
  'agricultural',
  'agent_hall',
])
/** structures built for one purpose, with the fabric to prove it */
const CIVIC_MONUMENT = new Set(['civic', 'gasholder', 'water_tower', 'crane', 'station_shed'])
const SLAB = new Set(['apartment', 'agent_block', 'agent_slab'])
const TOWER = new Set(['tower', 'agent_tower'])

/**
 * §74.4's guard lives in this table, and in the test that reads it: every class
 * keeps at least two targets, so no form is left with nowhere to go. §34 cost
 * several builds to stock that could not find a viable use, and
 * over-constraining conversion is exactly how that comes back.
 */
const CONVERSION_TARGETS: Record<ConversionClass, readonly Purpose[]> = {
  // a shop or a small practice on the ground floor and flats above. Nothing
  // that wants a floorplate or a loading bay: the frontage is five metres.
  fine_grain: ['residential', 'retail', 'office'],
  // §74.3's asymmetry, and the point of it: conversion pressure lands on the
  // post-industrial stock these seed cities were chosen for, because that stock
  // is genuinely the easiest thing to convert
  open_floorplate: ['residential', 'office', 'retail'],
  // few, and dear. `civic` is listed so a civic building that stays civic is
  // not counted as having nowhere to go; `bestConversion` skips the current
  // purpose, so in practice this is two targets.
  civic_monument: ['civic', 'office', 'retail'],
  slab: ['residential', 'office', 'retail'],
  /**
   * §74.3's table says "tower: office <-> residential", which is two targets
   * and therefore ONE place for any given tower to go — and §74.4's guard
   * caught that before the economy was asked, which is what it is for. Retail
   * is the honest third and it is where it actually is: the podium. A tower's
   * lower floors take shopfront the way a slab's do, and §74.3 grants the slab
   * exactly that.
   */
  tower: ['office', 'residential', 'retail'],
}

/** §74.3: converting a purpose-built civic structure is dear, not impossible */
const CIVIC_CONVERSION_PENALTY = 2.4

/** the a/b's before-arm: any building could become any of these */
const LEGACY_TARGETS: readonly Purpose[] = ['residential', 'retail', 'commercial', 'office']

export function conversionClass(b: Building): ConversionClass {
  if (CIVIC_MONUMENT.has(b.archetype)) return 'civic_monument'
  if (OPEN_PLATE.has(b.archetype)) return 'open_floorplate'
  if (TOWER.has(b.archetype)) return 'tower'
  if (SLAB.has(b.archetype)) return 'slab'
  if (FINE_GRAIN.has(b.archetype)) return 'fine_grain'
  /**
   * An archetype the table has not met. Decided on the two things that actually
   * separate the classes — how much floor there is per storey, and how many
   * storeys — rather than defaulted, because a default here is a silent policy
   * applied to whatever the next importer adds.
   */
  const perFloor = b.areaM2 / Math.max(1, b.levels)
  if (b.levels >= 9) return 'tower'
  if (perFloor >= 600) return 'open_floorplate'
  if (b.levels >= 4) return 'slab'
  return 'fine_grain'
}

/** The purposes this form can take. Never empty, and never fewer than two. */
export function conversionTargets(b: Building): readonly Purpose[] {
  return CONVERSION.on ? CONVERSION_TARGETS[conversionClass(b)] : LEGACY_TARGETS
}

/** What converting this form costs, as a multiple of the base. */
export function conversionPenalty(b: Building): number {
  if (!CONVERSION.on) return 1
  return conversionClass(b) === 'civic_monument' ? CIVIC_CONVERSION_PENALTY : 1
}

/** §74.4: the guard's own input — every class and what it may become. */
export function conversionTable(): Array<{ kind: ConversionClass; targets: readonly Purpose[] }> {
  return (Object.keys(CONVERSION_TARGETS) as ConversionClass[]).map((kind) => ({
    kind,
    targets: CONVERSION_TARGETS[kind],
  }))
}
