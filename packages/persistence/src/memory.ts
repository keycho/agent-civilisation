import type { WorldEvent } from './events.ts'
import type { EventQuery, Snapshot, WorldStore } from './store.ts'

/**
 * In-memory implementation of the §5 contract, used by the running prototype.
 *
 * The append-only rule is enforced here the same way the SQL trigger enforces
 * it: events are frozen on write and there is no update path. Twenty sim years
 * at this scale is on the order of 10^4 events, which fits comfortably.
 */
export class MemoryStore implements WorldStore {
  private log: WorldEvent[] = []
  private snapshots = new Map<string, Snapshot>()
  private nextId = 1
  private byBuilding = new Map<string, WorldEvent[]>()
  private byAgent = new Map<string, WorldEvent[]>()
  /**
   * FINDING: one store spans every hosted chunk (§44.5), but the two
   * ranked reads below walked the whole log. On a multi-chunk process that
   * made every city card's "last:" line the same globally-top event, each
   * server then resolving its author against its OWN roster — so eight cards
   * showed one event under eight different names. Ranked reads are
   * chunk-scoped now, and this index is what makes that cheap.
   */
  private byChunk = new Map<string, WorldEvent[]>()

  appendEvent(e: Omit<WorldEvent, 'id'>): number {
    const id = this.nextId++
    const event = Object.freeze({ ...e, id }) as WorldEvent
    this.log.push(event)
    if (event.buildingId) push(this.byBuilding, event.buildingId, event)
    if (event.agentId) push(this.byAgent, event.agentId, event)
    push(this.byChunk, event.chunkId, event)
    return id
  }

  events(q: EventQuery = {}): WorldEvent[] {
    let source = this.log
    if (q.buildingId) source = this.byBuilding.get(q.buildingId) ?? []
    else if (q.agentId) source = this.byAgent.get(q.agentId) ?? []

    const out: WorldEvent[] = []
    for (let i = source.length - 1; i >= 0; i--) {
      const e = source[i]
      if (q.sinceTick !== undefined && e.tick < q.sinceTick) break
      if (q.minWeight !== undefined && e.cinematicWeight < q.minWeight) continue
      if (q.types && !q.types.includes(e.type)) continue
      out.push(e)
      if (q.limit && out.length >= q.limit) break
    }
    return out
  }

  weightSince(chunkId: string, sinceTick: number): number {
    const source = this.byChunk.get(chunkId) ?? []
    let total = 0
    for (let i = source.length - 1; i >= 0; i--) {
      if (source[i].tick < sinceTick) break
      total += source[i].cinematicWeight
    }
    return total
  }

  weightedEvents(chunkId: string, sinceTick: number, limit: number): WorldEvent[] {
    const source = this.byChunk.get(chunkId) ?? []
    const recent: WorldEvent[] = []
    for (let i = source.length - 1; i >= 0; i--) {
      if (source[i].tick < sinceTick) break
      recent.push(source[i])
    }
    recent.sort((a, b) => b.cinematicWeight - a.cinematicWeight || b.tick - a.tick)
    return recent.slice(0, limit)
  }

  putSnapshot(s: Snapshot): void {
    this.snapshots.set(`${s.chunkId}:${s.season}:${s.ordinal}`, s)
  }

  /** Nearest snapshot at or before `ordinal` — the scrub lands between writes. */
  snapshotAt(chunkId: string, ordinal: number): Snapshot | undefined {
    let best: Snapshot | undefined
    for (const s of this.snapshots.values()) {
      if (s.chunkId !== chunkId || s.ordinal > ordinal) continue
      if (!best || s.ordinal > best.ordinal) best = s
    }
    return best
  }

  snapshotOrdinals(chunkId: string): number[] {
    const out: number[] = []
    for (const s of this.snapshots.values()) if (s.chunkId === chunkId) out.push(s.ordinal)
    return out.sort((a, b) => a - b)
  }

  eventCount(): number {
    return this.log.length
  }
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}
