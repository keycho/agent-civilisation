import { wgsToRd } from '@civ/core/geo/rd.ts'
import type { Bbox } from './sources/overpass.ts'
import type { RdBbox } from './sources/threedbag.ts'

export interface AreaDef {
  id: string
  name: string
  /** anchor for the chunk-local frame */
  lat: number
  lon: number
  /** half-extent in metres; the chunk is a 2r x 2r square in the local frame */
  radiusM: number
  /** national admin code where one exists (NL: CBS GMxxxx). Provenance, not a join key. */
  adminCode: string
  /**
   * §31.2: which source adapter imports this area. 'NL' is the 3DBAG+BAG+AHN
   * path; 'GB' (and every later country) is the OSM-only fallback adapter with
   * estimated heights until a national dataset is wired. Also selects the
   * frame: RD for NL, local ENU elsewhere.
   */
  country: 'NL' | 'GB' | 'US' | 'FR' | 'JP'
  /**
   * §24.2: the axis of the fabric, in degrees clockwise from grid north. The
   * chunk is cut along this rather than along north, so the same building count
   * fills a rectangle instead of a diamond and the corners stop being dead grey.
   *
   * Measured, not chosen: bin the road graph's edge bearings mod 90, weight
   * each by its length so arterials outvote alleys, and take the peak.
   */
  bearingDeg?: number
  note: string
}

/**
 * §2's ratio problem is the reason this file exists and is short.
 *
 * Dutch historic fabric runs about 3,400 buildings per km², so the spec's
 * "0.5 to 1 km²" would land at 1,700-3,400 baseline buildings — above the
 * 400-1,500 band where divergence can saturate. The area is sized by building
 * count, not by area, and the count is the thing that was measured.
 *
 * Schiedam-Havens is chosen against §2's list rather than for postcard value:
 *   low/mid rise      old town is 2-5 storeys throughout, nothing immovable
 *   vacancy           the harbour edge carries surface parking and cleared
 *                     post-industrial plots, so agents have somewhere to build
 *   terrain character the Lange Haven and Nieuwe Haven cut through the middle
 *   variety           distillery warehouses, rowhouses, a church, industrial
 *                     sheds and the tallest windmills in the world, all inside
 *                     one 550 m square — the archetype system gets real work
 *   height coverage   3DBAG, so 100%
 */
/**
 * §33.3: the cut heuristic gets a threshold. "Cut along the fabric" was a
 * single-axis assumption — NL-shaped, another entry in the assumptions doc.
 * Rotation is only applied when the bearing histogram's peak bin carries at
 * least this share of road length (uniform is 1.1%; schiedam's true axis
 * carried 8.7%). Below it the fabric has no single axis, the chunk is cut
 * north-aligned, and the §24.1 width-framing absorbs the shape — a forced
 * rotation to a weak axis is noise presented as intention.
 */
export const CUT_PEAK_SHARE_MIN = 0.06

export const AREAS: Record<string, AreaDef> = {
  'schiedam-havens': {
    id: 'schiedam-havens',
    name: 'Schiedam — Havens',
    lat: 51.9159,
    lon: 4.3959,
    radiusM: 280,
    adminCode: 'GM0606',
    country: 'NL',
    /**
     * §24.2, measured and applied. The fabric axis here is 45.4 degrees,
     * binned off the emitted seed's road graph and weighted by edge length —
     * which is the worst case available, since a square cut against a 45-degree
     * fabric projects to a diamond of sqrt(2) its width. That is where the dead
     * corners came from, and it confirms §24.2: the rotation was never a camera
     * choice.
     *
     * The 2 carriageway overlaps this first tripped were not caused by the
     * rotation. The drop pass and the seed validator were sampling road
     * segments at different points along their length, so a parcel covering a
     * road at midspan could be missed by the one that could drop it and caught
     * by the one that could only complain. Under one shared sample set the
     * north cut turns out to carry one such parcel too — it was passing by luck
     * rather than by construction. See CARRIAGEWAY_SAMPLE_TS.
     */
    bearingDeg: 45.4,
    note: 'Historic harbour district: Lange Haven and Nieuwe Haven, distillery warehouses, post-industrial edge.',
  },
  /**
   * §27.9: "three to five fine chunks at start, deliberately mixed: the
   * historic district already built, a postwar suburb, a village, a port edge."
   *
   * Each sits in its own municipality, because migration is between
   * settlements and a settlement needs its own coarse record, WOZ level and
   * population — three chunks inside GM0606 would make "the settlement became
   * active" unmeasurable. All four are within 10 km of each other on the
   * Nieuwe Waterweg, so 3DBAG, AHN and the OSM tagging culture are constant
   * and the §25.3 variable is the fabric alone.
   *
   * bearingDeg on the new three starts unset: imported north-cut first, the
   * fabric axis measured off the emitted road graph, then set and re-imported
   * — same §24.2 procedure schiedam went through, not a guess.
   */
  'vlaardingen-westwijk': {
    id: 'vlaardingen-westwijk',
    name: 'Vlaardingen — Westwijk',
    lat: 51.9048,
    lon: 4.3268,
    radiusM: 300,
    adminCode: 'GM0622',
    country: 'NL',
    note: 'Postwar expansion district: 1950s-60s slab blocks, rowhouses, green courts.',
  },
  'maasland-dorp': {
    id: 'maasland-dorp',
    name: 'Maasland — Dorp',
    lat: 51.9366,
    lon: 4.2758,
    radiusM: 300,
    adminCode: 'GM1842',
    country: 'NL',
    note: 'Polder village core: church, dike streets, farmyards on the edge.',
  },
  'maassluis-haven': {
    id: 'maassluis-haven',
    name: 'Maassluis — Haven',
    lat: 51.9224,
    lon: 4.2492,
    radiusM: 280,
    adminCode: 'GM0556',
    country: 'NL',
    note: 'Small port town: historic haven, locks, working waterfront edge.',
  },
  /**
   * §31.4: london — thames-side post-industrial. Anchored on Convoys Wharf,
   * the former royal dockyard at Deptford: a large cleared post-industrial
   * site on the river (visible vacancy, §2's list), Victorian terraces and
   * council estates south of it, wharf sheds along the creek. Recognisably
   * London at the water; nothing in frame is immovable.
   */
  'london-deptford': {
    id: 'london-deptford',
    name: 'London — Deptford Riverside',
    lat: 51.4855,
    lon: -0.031,
    radiusM: 400,
    /**
     * §33.3 applied: measured 86.6 deg at 3.5% peak share, below the 6%
     * threshold — multi-axial fabric (riverside curve plus grids at 87/56/31),
     * so the cut is north-aligned and the measurement stays here as the
     * record. Schiedam's 45.4 at 8.7% is what a real axis looks like.
     */
    adminCode: 'E09000023',
    country: 'GB',
    note: 'Thames-side post-industrial: Convoys Wharf, Deptford terraces, creek-mouth sheds.',
  },
  /**
   * §31.4, the remaining three. Defined ahead of import so the axis
   * measurement and the archetype-family harness gate (§31.6-4: family
   * through the §16.1 harness BEFORE import) have somewhere to point.
   * Standing predictions to record on import, either way: tokyo's parcel
   * derivation is the strangest of the four; brooklyn's grid clears the 6%
   * axis bar.
   */
  'brooklyn-redhook': {
    id: 'brooklyn-redhook',
    name: 'Brooklyn — Red Hook',
    lat: 40.6768,
    lon: -74.011,
    radiusM: 360,
    adminCode: '36047',
    country: 'US',
    note: 'Low-rise industrial waterfront edge: brownstone rows, warehouses, working piers.',
  },
  'paris-ourcq': {
    id: 'paris-ourcq',
    name: 'Paris — Ourcq / Petite Ceinture',
    lat: 48.8895,
    lon: 2.3825,
    radiusM: 320,
    adminCode: '75119',
    country: 'FR',
    note: 'Periphery fringe, 19e: canal basin, rail belt remnants, workshops under mansard blocks.',
  },
  'tokyo-kyojima': {
    id: 'tokyo-kyojima',
    name: 'Tokyo — Kyojima',
    lat: 35.7095,
    lon: 139.8215,
    radiusM: 300,
    adminCode: '13107',
    country: 'JP',
    note: 'Shitamachi fine-grain: wooden rowhouses on alleys, small workshops, pocket shrines.',
  },
  'schiedam-wide': {
    id: 'schiedam-wide',
    name: 'Schiedam — Havens (wide)',
    lat: 51.9159,
    lon: 4.3959,
    radiusM: 420,
    adminCode: 'GM0606',
    country: 'NL',
    note: 'Wider frame for measuring; above the ratio band.',
  },
  'dordrecht-old': {
    id: 'dordrecht-old',
    name: 'Dordrecht — Oude Haven',
    lat: 51.8162,
    lon: 4.665,
    radiusM: 260,
    adminCode: 'GM0505',
    country: 'NL',
    note: 'Fallback: older and denser, less vacant land.',
  },
}

/**
 * §24.2: the source query is axis-aligned in RD whatever the chunk's bearing
 * is, so a rotated chunk needs a wider fetch — the bounding box of the rotated
 * square, which is r*(|cos| + |sin|) on each side and worst at 45 degrees,
 * where it is r*sqrt(2). The surplus is clipped against the local bounds after
 * import; fetching it is the price of cutting on the fabric.
 */
export function rotatedReach(a: AreaDef): number {
  const t = ((a.bearingDeg ?? 0) * Math.PI) / 180
  return a.radiusM * (Math.abs(Math.cos(t)) + Math.abs(Math.sin(t)))
}

export function rdBboxOf(a: AreaDef): RdBbox {
  const c = wgsToRd(a.lat, a.lon)
  const r = rotatedReach(a)
  return [c.x - r, c.y - r, c.x + r, c.y + r]
}

/**
 * OSM is queried on a slightly larger footprint than the chunk. Roads just
 * outside the edge still bound blocks inside it, and clipping the graph at the
 * chunk boundary would leave the outer ring of parcels unbounded.
 */
export function wgsBboxOf(a: AreaDef, marginM = 220): Bbox {
  const reach = rotatedReach(a) + marginM
  const dLat = reach / 111_320
  const dLon = reach / (111_320 * Math.cos((a.lat * Math.PI) / 180))
  return [a.lat - dLat, a.lon - dLon, a.lat + dLat, a.lon + dLon]
}
