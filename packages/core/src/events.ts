/**
 * §5's event vocabulary. Types are property-centric — nothing here is about
 * walking, gathering or eating.
 *
 * §21.6: the names, the cinematic weights and the feed tones live in core
 * rather than in persistence, because the client needs all three and must not
 * be able to reach a store. `WorldEvent` itself, which is a row, stays where
 * rows live.
 */

export const EVENT_TYPES = [
  'building_acquired',
  'building_renovated',
  'building_converted',
  'building_expanded',
  'demolition_started',
  'demolition_completed',
  'construction_started',
  'construction_completed',
  'parcel_acquired',
  'parcels_assembled',
  'road_built',
  'agent_born',
  'agent_died',
  'estate_transferred',
  'district_formed',
  'season_ended',
  'season_began',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * Base weight per type. The writer adds situational weight on top — a
 * replacement of a 1907 warehouse outscores a replacement of a 1994 shed, and
 * an assembly followed by demolition and construction compounds.
 */
export const BASE_CINEMATIC_WEIGHT: Record<EventType, number> = {
  // §22.3: a season boundary is the largest thing that happens to this world
  season_ended: 100,
  season_began: 100,
  district_formed: 90,
  parcels_assembled: 60,
  construction_started: 45,
  demolition_started: 50,
  road_built: 55,
  construction_completed: 30,
  demolition_completed: 20,
  building_expanded: 25,
  building_converted: 18,
  estate_transferred: 22,
  building_acquired: 8,
  parcel_acquired: 6,
  building_renovated: 5,
  agent_born: 4,
  agent_died: 12,
}

/**
 * §60(d): what the default feed is FOR.
 *
 * Weight was already colouring the feed; it was never deciding what entered
 * it, and the §57.1 measurement is why that had to change. Over 1166 live
 * tokyo events the weight distribution runs >=10 100%, >=20 80%, >=50 26%,
 * >=90 8% — so the old "cream and above" intake admitted four fifths of all
 * traffic, which is not a selection at all. The mix says the same thing from
 * the other side: building_expanded 28%, building_converted 22%,
 * building_renovated 9%. Six in ten events were an agent tidying.
 *
 * So inclusion is by KIND, which is what a viewer actually distinguishes: a
 * building coming down is a story whatever it scores, and a level added to a
 * terrace is not one however well it happened to price. Everything outside
 * this set still reaches the archive, the changelog, an agent's own pane and
 * the verbose feed — it stops competing for the twelve rows a stranger reads.
 *
 * Seasons and districts are in because they are the largest structural events
 * this world has (weight 100 and 90). Migrations and ignitions belong in this
 * set by §60(d) and are not here yet: neither is on the wire (§53.1).
 */
export const DRAMA_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'parcels_assembled',
  'demolition_started',
  'demolition_completed',
  'construction_started',
  'construction_completed',
  'road_built',
  'district_formed',
  'agent_died',
  'season_ended',
  'season_began',
])

/**
 * §60(d): the exception that keeps the filter honest. A routine kind that
 * scores exceptionally is still a story — a renovation of a listed church
 * outranks a development of a shed — so situational weight can readmit one
 * without readmitting its whole kind. Set above the 90th percentile of live
 * traffic (measured: >=90 is 8% of events, and only 18% reach 70).
 */
export const DRAMA_WEIGHT_FLOOR = 88

/** §60(d): is this event worth one of the twelve rows a stranger reads? */
export function isDrama(type: EventType, cinematicWeight: number): boolean {
  return DRAMA_TYPES.has(type) || cinematicWeight >= DRAMA_WEIGHT_FLOOR
}

/** Feed colour per event family, so the live feed reads at a glance. */
export const EVENT_TONE: Record<EventType, string> = {
  building_acquired: '#d8b36a',
  parcel_acquired: '#d8b36a',
  parcels_assembled: '#c9a24d',
  building_renovated: '#8fbe86',
  building_converted: '#5fb2ae',
  building_expanded: '#6f9ed6',
  demolition_started: '#c17b62',
  demolition_completed: '#a9634c',
  construction_started: '#7fe3e0',
  construction_completed: '#5fc8c5',
  road_built: '#b8a48d',
  agent_born: '#9aa0a6',
  agent_died: '#8d8d8d',
  estate_transferred: '#b57ad0',
  district_formed: '#7fe3e0',
  season_ended: '#e0d5b0',
  season_began: '#e0d5b0',
}
