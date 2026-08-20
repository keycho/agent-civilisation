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
  /**
   * §55 tier 1: the same decision said in the agent's voice.
   *
   * A SEPARATE field rather than a rewrite of `rationale`, because §5 says the
   * log is the record and the record is what the simulation actually decided.
   * `rationale` keeps the sim's own words forever; `voice` is presentation,
   * written later, by a model, and always optional. Everything that reads the
   * log for meaning reads `rationale`; only the surfaces a person reads prefer
   * `voice`. That also makes the a/b trivial — both lines are on the row.
   */
  voice?: string
  payload?: Record<string, unknown>
}

