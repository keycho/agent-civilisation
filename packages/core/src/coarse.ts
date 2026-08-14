/**
 * §27.2: the coarse layer.
 *
 * "A small town becoming a major centre requires that the town was a candidate
 * before any agent went there. If eight cities are imported, agents choose
 * among eight, and the surprise is theatre."
 *
 * So the world is two tiers. This is the wide one: every settlement in the
 * country as a handful of numbers, with no buildings, no parcels and no
 * geometry beyond a point. A fine chunk materialises only where agents commit.
 *
 * Every field here is a real measurement rather than a derived quantity, which
 * matters for the same reason 3DBAG heights and BAG construction years matter:
 * agents should be discovering the Netherlands, not discovering whatever
 * assumption produced a formula. §28.2 makes that explicit for price, and it is
 * the rule for the rest of the record too.
 */

export interface CoarseSettlement {
  /** CBS region code, e.g. GM0606 */
  id: string
  name: string
  /** WGS84 centroid — a point, not a footprint. §27.2 needs no more. */
  lat: number
  lon: number
  population: number
  /** inhabitants per km² */
  densityPerKm2: number
  /**
   * Built-up land and total land area, hectares. Optional: CBS publishes the
   * bodemgebruik survey on a slower cadence than population, so a few
   * municipalities have no figure in the current period. Left absent rather
   * than back-filled — see the note in the importer.
   */
  builtHa?: number
  landHa?: number
  /** road kilometres of all classes, the §27.2 connectivity term */
  roadKm: number
  /**
   * §28.2: average WOZ valuation of dwellings, thousands of euros.
   *
   * "A derived formula built from density and connectivity would encode
   * whatever assumption produced it, and agents would then discover that
   * assumption rather than discovering anything about the Netherlands."
   *
   * This is the real per-municipality valuation CBS publishes, not a proxy.
   * Undefined where CBS suppresses the figure, which happens and is left as a
   * gap rather than filled in.
   */
  wozThousandEur?: number
}

export interface CoarseLayer {
  country: string
  /** the CBS period the stock measures come from, e.g. 2024JJ00 */
  period: string
  /**
   * The period(s) the land-use figures come from. CBS publishes the bodemgebruik
   * survey on a slower cadence than population, so this can be older than
   * `period` and can differ between municipalities. Recorded rather than
   * flattened, because a stock measure from another year is a property of the
   * artifact.
   */
  landPeriod: string
  /** the period the WOZ valuations come from; often ahead of the rest */
  wozPeriod: string
  source: string
  licence: string
  settlements: CoarseSettlement[]
}

/**
 * §28.1: what a place is worth going to, guessed from what can be known
 * without going there.
 *
 * "The estimate must be lossy on purpose. If the coarse prediction matched fine
 * reality, agents would sort by it and the outcome would be a lookup. Discovery
 * lives in the gap."
 *
 * So this is deliberately built from stock measures that a real prospector
 * could read off a table, and it is deliberately not the quantity it predicts.
 * Yield is a realised return and none of these inputs is a return:
 *
 *   headroom     land that is not built on yet, as a share of the whole. A
 *                place with nowhere to build cannot reward a developer however
 *                rich it is.
 *   cheapness    inverse of the WOZ level against the national average. Buying
 *                low is most of where return comes from, and it is the term
 *                that should send capital away from Amsterdam.
 *   reach        road kilometres per unit of built land — a crude connectivity
 *                read, and the one most likely to be wrong, since it cannot
 *                tell a bypass from a high street.
 *
 * It will be wrong often. That is the design: §28.1 wants agents to arrive and
 * find the bet was bad, and reversed migrations in the log are the mechanism
 * working rather than failing.
 */
export function estimateYield(s: CoarseSettlement, nationalWozThousandEur: number): number {
  // A settlement with no land-use figure gets the neutral headroom rather than
  // a fabricated one, so the gap costs it nothing and wins it nothing.
  const built = Math.max(1, s.builtHa ?? 0)
  const headroom =
    s.builtHa === undefined || s.landHa === undefined
      ? 0.5
      : Math.max(0, 1 - built / Math.max(1, s.landHa))
  const woz = s.wozThousandEur ?? nationalWozThousandEur
  const cheapness = nationalWozThousandEur / Math.max(1, woz)
  const reach = Math.min(2, s.roadKm / Math.max(1, s.builtHa ?? s.roadKm))
  return headroom * 0.9 + cheapness * 0.8 + reach * 0.35
}
