/**
 * §5's append-only event log. Types are property-centric — nothing here is
 * about walking, gathering or eating.
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
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface WorldEvent {
  id: number
  chunkId: string
  tick: number
  type: EventType
  agentId?: string
  buildingId?: string
  parcelId?: string
  edgeId?: string
  /**
   * §17. Assigned when the event is written, not derived later: the director
   * ranks recent events by this to decide what is worth watching.
   */
  cinematicWeight: number
  rationale?: string
  payload?: Record<string, unknown>
}

/**
 * Base weight per type. The writer adds situational weight on top — a
 * replacement of a 1907 warehouse outscores a replacement of a 1994 shed, and
 * an assembly followed by demolition and construction compounds.
 */
export const BASE_CINEMATIC_WEIGHT: Record<EventType, number> = {
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
}
