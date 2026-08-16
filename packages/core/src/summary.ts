/**
 * §27.3: the regional summary is first-class simulation state.
 *
 * "An agent cannot observe every chunk. It needs a cheap read of everywhere
 * else. Each place, coarse or fine, maintains a rolling summary ... agents read
 * summaries to choose where, and full observations only for where they are.
 * The same object renders the global view."
 *
 * One shape for both tiers, which is the point: the migration substrate and
 * the spatial divergence surface are one dataset, computed once. A field that
 * only a fine chunk can know is optional and absent on coarse-only places —
 * absent, not zero, because a zero is a measurement and an absence is the
 * honest statement that nobody has been there to measure.
 */

export interface RegionalSummary {
  /**
   * §31: the coarse candidate this place is, in the global layer's id space
   * (e.g. 'gn-2747891' for a geonames-derived candidate). The join from fine
   * chunk to settlement is geometric at assembly time — no national admin
   * scheme survives going international.
   */
  settlementId: string
  name: string
  lat: number
  lon: number
  /** 'coarse' until a fine chunk materialises; then that chunk's id */
  chunkId?: string
  /** whether a fine world currently ticks here */
  state: 'coarse' | 'active' | 'dormant'

  // -- the §27.3 fields, in its order --------------------------------------
  /** median parcel land value (fine) or the WOZ level in k€ (coarse) */
  medianLandValue?: number
  /** share of parcels with nothing standing on them (fine only) */
  vacancy?: number
  /** applied actions per 1000 decisions over the recent window (fine only) */
  activityRate?: number
  /** living agents' capital per m² of standing floor area (fine only) */
  capitalDensity?: number
  /** median return on price over recent transactions (fine only) */
  realisedYield?: number
  agentCount: number

  /**
   * §28.1: the estimate an agent must rely on where nothing is realised.
   * For a coarse place this is `estimateYield` mapped onto the yield scale;
   * for a fine place it is the offered yield off the standing stock. The two
   * are deliberately not the same computation — the gap between the estimate
   * and what an arriving agent actually finds is where discovery lives.
   */
  expectedYield: number

  /** §26.2: the spatial divergence surface, for the global view (fine only) */
  divergenceIndex?: number
}
