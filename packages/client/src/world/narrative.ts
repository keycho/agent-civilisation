/**
 * §60: the narrative hierarchy — headline, stories, digest.
 *
 * The feed answers "what just happened". A stranger's first question is "what
 * is happening", and their second is "did anything matter". Those are three
 * different time horizons over the same event stream, so they are derived
 * here, once, rather than three times in the chrome:
 *
 *   headline — the most dramatic action currently IN PROGRESS, held while it
 *              stays true. Not the loudest recent line: an event that has
 *              already finished is not what is happening.
 *   stories  — a campaign per agent, accumulating its stages (acquired 3 ▸
 *              cleared 3 ▸ building 40%), opened on commitment and closed on
 *              completion, abandonment or death.
 *   digest   — a rolling window: what this city did in the last while.
 *
 * §29.2 puts the plan on the SITE, and a story is really that plan's arc. The
 * wire does not carry a plan id (EventWire is id/type/agent/building/weight/
 * place), so stories key on the AGENT instead — which is faithful in practice
 * because an agent runs one plan at a time, and is stated as the deviation it
 * is rather than pretended otherwise.
 */
import { DRAMA_TYPES, type EventType } from '@civ/core'
import type { EventWire } from '@civ/protocol'

/** an action that has started and not yet finished */
export interface OpenAction {
  key: string
  type: EventType
  weight: number
  agentId?: string
  agentName?: string
  at: number
  x?: number
  y?: number
  rationale?: string
}

export interface Story {
  agentId: string
  agentName: string
  /** stage counters, in the order a campaign runs them */
  acquired: number
  assembled: number
  cleared: number
  building: number
  built: number
  /** the highest weight this campaign has reached — its drama */
  weight: number
  opened: number
  touched: number
  x?: number
  y?: number
  /** set when the campaign ends, so the chrome can retire the card */
  closed: 'completed' | 'died' | 'stalled' | null
}

export interface DigestLine {
  label: string
  n: number
}

const PAIRED: Partial<Record<EventType, EventType>> = {
  construction_started: 'construction_completed',
  demolition_started: 'demolition_completed',
}

/** how long a story sits untouched before it is treated as abandoned */
const STORY_STALL_MS = 90_000
/** the digest's window */
const DIGEST_WINDOW_MS = 60 * 60 * 1000

function placeKey(e: EventWire): string {
  return e.buildingId ?? `${e.x ?? '?'},${e.y ?? '?'}`
}

export class Narrative {
  private open = new Map<string, OpenAction>()
  private stories = new Map<string, Story>()
  private recent: Array<{ type: EventType; at: number; weight: number; name?: string }> = []
  /** stories that ended, newest first — the changelog's intake */
  readonly finished: Story[] = []

  /** wall clock, injected so captures can pin it exactly as the renderer does */
  now: () => number = () => Date.now()

  ingest(e: EventWire): void {
    const t = this.now()

    // ---- in-progress tracking, for the headline ------------------------
    const pairEnd = PAIRED[e.type]
    if (pairEnd) {
      this.open.set(`${e.type}|${placeKey(e)}`, {
        key: `${e.type}|${placeKey(e)}`,
        type: e.type,
        weight: e.cinematicWeight,
        agentId: e.agentId,
        agentName: e.agentName,
        at: t,
        x: e.x,
        y: e.y,
        rationale: e.rationale,
      })
    } else {
      for (const [startType, endType] of Object.entries(PAIRED)) {
        if (e.type === endType) this.open.delete(`${startType}|${placeKey(e)}`)
      }
    }

    // ---- stories -------------------------------------------------------
    if (e.agentId) {
      let s = this.stories.get(e.agentId)
      if (!s && this.opensAStory(e.type)) {
        s = {
          agentId: e.agentId,
          agentName: e.agentName ?? e.agentId,
          acquired: 0,
          assembled: 0,
          cleared: 0,
          building: 0,
          built: 0,
          weight: 0,
          opened: t,
          touched: t,
          closed: null,
        }
        this.stories.set(e.agentId, s)
      }
      if (s) {
        s.touched = t
        s.weight = Math.max(s.weight, e.cinematicWeight)
        if (e.agentName) s.agentName = e.agentName
        if (e.x !== undefined) {
          s.x = e.x
          s.y = e.y
        }
        switch (e.type) {
          case 'building_acquired':
          case 'parcel_acquired':
            s.acquired++
            break
          case 'parcels_assembled':
            s.assembled++
            break
          case 'demolition_completed':
            s.cleared++
            break
          case 'construction_started':
            s.building++
            break
          case 'construction_completed':
            s.built++
            // a campaign that has built what it cleared has arrived
            if (s.built >= Math.max(1, s.building)) this.close(s, 'completed')
            break
          case 'agent_died':
            this.close(s, 'died')
            break
        }
      }
    }

    // ---- digest --------------------------------------------------------
    if (DRAMA_TYPES.has(e.type)) {
      this.recent.push({ type: e.type, at: t, weight: e.cinematicWeight, name: e.agentName })
      // the window is an hour; the cap is so a runaway chunk cannot grow this
      // without bound between prunes
      if (this.recent.length > 4000) this.recent.splice(0, 1000)
    }
  }

  private opensAStory(type: EventType): boolean {
    // §60(b): a story opens on COMMITMENT, not on a glance. Acquiring or
    // assembling ground is the first act an agent cannot take back cheaply.
    return (
      type === 'building_acquired' ||
      type === 'parcel_acquired' ||
      type === 'parcels_assembled' ||
      type === 'demolition_started' ||
      type === 'construction_started'
    )
  }

  private close(s: Story, how: Story['closed']): void {
    if (s.closed) return
    s.closed = how
    this.stories.delete(s.agentId)
    this.finished.unshift(s)
    if (this.finished.length > 40) this.finished.pop()
  }

  /** §60(a): the most dramatic thing currently under way, or null if quiet */
  headline(): OpenAction | null {
    const t = this.now()
    let best: OpenAction | null = null
    for (const [k, a] of this.open) {
      // an action that never completed is not "in progress" forever; §57.1
      // measured construction at 30-60s, so five minutes is far past honest
      if (t - a.at > 300_000) {
        this.open.delete(k)
        continue
      }
      if (!best || a.weight > best.weight || (a.weight === best.weight && a.at > best.at)) best = a
    }
    return best
  }

  /** §60(b): the campaigns worth showing, most dramatic first */
  topStories(limit = 5): Story[] {
    const t = this.now()
    for (const s of [...this.stories.values()]) {
      if (t - s.touched > STORY_STALL_MS) this.close(s, 'stalled')
    }
    return [...this.stories.values()]
      .sort((a, b) => b.weight - a.weight || b.touched - a.touched)
      .slice(0, limit)
  }

  /**
   * §60(c): "in the last hour: 3 towers rose · a church fell · 2 dynasties
   * ended". Counts by kind over the rolling window, largest first.
   */
  digest(windowMs = DIGEST_WINDOW_MS): DigestLine[] {
    const t = this.now()
    const cut = t - windowMs
    while (this.recent.length && this.recent[0].at < cut) this.recent.shift()
    const counts = new Map<EventType, number>()
    for (const r of this.recent) counts.set(r.type, (counts.get(r.type) ?? 0) + 1)
    const say = (type: EventType, n: number): string | null => {
      switch (type) {
        case 'construction_completed':
          return n === 1 ? 'a building rose' : `${n} buildings rose`
        case 'demolition_completed':
          return n === 1 ? 'a building fell' : `${n} buildings fell`
        case 'parcels_assembled':
          return n === 1 ? 'a site was assembled' : `${n} sites assembled`
        case 'agent_died':
          return n === 1 ? 'a dynasty ended' : `${n} dynasties ended`
        case 'district_formed':
          return n === 1 ? 'a district formed' : `${n} districts formed`
        case 'road_built':
          return n === 1 ? 'a road was cut' : `${n} roads were cut`
        case 'season_ended':
          return n === 1 ? 'a season turned' : `${n} seasons turned`
        default:
          return null
      }
    }
    const out: DigestLine[] = []
    for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const label = say(type, n)
      if (label) out.push({ label, n })
    }
    return out.slice(0, 4)
  }

  get openCount(): number {
    return this.open.size
  }
}
