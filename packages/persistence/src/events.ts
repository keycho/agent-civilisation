import type { EventType } from '@civ/core'

export type { EventType }
export { EVENT_TYPES, BASE_CINEMATIC_WEIGHT, EVENT_TONE } from '@civ/core'

/**
 * §5's append-only log row. The vocabulary it uses lives in `@civ/core` so a
 * client can name an event without being able to reach a store (§21.6).
 */
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

