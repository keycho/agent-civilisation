import { BASE_CINEMATIC_WEIGHT, RATE_WINDOW_TICKS, THROUGHPUT, type WorldSeed } from '@civ/core'
import { DurableStore } from '@civ/persistence'
import type { AgentIdentity, EventWire, Frame, Hello, MaterialiseSpec, Readouts, RoadEdgeWire } from '@civ/protocol'
import { toBase64 } from '@civ/protocol'
import { SaturationWatch, Simulation, type WorldState } from '@civ/sim'
import {
  BuildingTexture,
  agentIdentity,
  agentWire,
  eventWire,
  learnNames,
  materialiseSpec,
  progressOf,
  purposeIndexOf,
  roadWire,
} from './frames.ts'

/**
 * §21.6: the authoritative world. One instance, one writer, one tick loop.
 *
 * The rng lives here — that is what makes the world shared rather than
 * synchronised. Two viewers are not running the same seed in parallel and
 * hoping; there is one world and they are both looking at it.
 *
 * Throughput is a property of the world, not of a session. A spectator cannot
 * step it, seed it or steer it, so nothing a client sends can advance the
 * simulation. That is the difference the protocol enforces.
 */

export interface WorldServiceOptions {
  seed: WorldSeed
  databaseUrl?: string
  /** index into THROUGHPUT; the pace the world thinks at */
  throughput?: number
  agentCount?: number
  snapshotEveryEvents?: number
  /** run seed for the rng — fixed for reproducibility, one per world */
  rngSeed?: string
  /** §22.3: which season this is. Increments when the world saturates. */
  season?: number
  /** §22.3/§23.4: called when the season should turn, with why */
  onSaturated?: (season: number, reason: SeasonEndReason) => void
  /** existing store, so a new season keeps writing to the same log */
  store?: DurableStore
  /**
   * §72.1: resume this world instead of founding it. When set, the season's
   * ordinal origin comes with it rather than from the current event count —
   * `firstEventId` was captured when THIS season began, possibly in a previous
   * process, and re-deriving it here would restart the scrub's range mid-season.
   */
  resumeFrom?: WorldState
}

/** §23.4: a season ends for one of two reasons and they are not the same news. */
export type SeasonEndReason = 'saturation' | 'slot_pressure'

/** Turn at this share of the building data texture, whatever the world is doing. */
const SLOT_PRESSURE_TURN = 0.85

/** §72.2: how far back the measured-rate window looks. */
const RATE_WINDOW_MS = 5_000

export class WorldService {
  readonly sim: Simulation
  readonly store: DurableStore
  readonly texture: BuildingTexture
  readonly chunkId: string
  /** §22.3: which run of this chunk the spectator is watching */
  readonly season: number

  private throughputIndex: number
  private lastBroadcastBytes: Uint8Array
  private lastEventId = 0
  /**
   * §22.3: the log spans every season, but a new season's tick restarts at 0 —
   * so filtering recent events by tick alone would hand a joining spectator the
   * *previous* season's feed. Everything this world reports is bounded below by
   * the id the log had reached when the season began.
   */
  private readonly firstEventId: number
  /** every agent-built structure ever materialised, for clients that join late */
  private readonly materialised = new Map<string, MaterialiseSpec>()
  private readonly agentRoads = new Map<string, RoadEdgeWire>()
  private pendingMaterialise: MaterialiseSpec[] = []
  private pendingRoads: RoadEdgeWire[] = []
  private retiredSinceFrame: string[] = []
  private bornSinceFrame: AgentIdentity[] = []
  private known = new Set<string>()
  private ticking = false
  /** §72.2: fractional decision budget, carried between frames */
  private credit = 0
  /** §72.4: frames this world sat out because the durable queue was full */
  private stalled = 0

  get stalledFrames(): number {
    return this.stalled
  }
  /**
   * §72.2: what the world is actually doing, over a rolling window.
   *
   * /health reported `decisions / uptime` — a lifetime average whose numerator
   * resets on a season turn, so a chunk that had just turned read slow and one
   * that had not read true. A window says what the pace IS.
   */
  private readonly rateSamples: Array<{ at: number; n: number }> = []
  private readonly saturation = new SaturationWatch()
  private readonly onSaturated?: (season: number, reason: SeasonEndReason) => void
  private saturatedAlready = false

  constructor(opts: WorldServiceOptions) {
    this.store = opts.store ?? new DurableStore({ url: opts.databaseUrl })
    this.firstEventId = opts.resumeFrom?.firstEventId ?? this.store.nextEventId()
    this.lastEventId = this.store.nextEventId()
    this.chunkId = opts.seed.chunk.id
    this.season = opts.season ?? 1
    this.onSaturated = opts.onSaturated
    this.throughputIndex = opts.throughput ?? 2
    this.store.season = this.season
    /**
     * §63.1: the retained log is read for the names it carries before anything
     * is served from it. A season turn rebuilds the world from the seed, so
     * rows written by earlier seasons — and rows written before this fix, which
     * carry no name of their own — have no live agent to resolve against. Their
     * `agent_born` and `estate_transferred` rows always did carry the name; one
     * pass at boot puts it where the wire can reach it.
     */
    learnNames(this.store.events({ limit: 40_000 }))
    this.sim = new Simulation(opts.seed, this.store, {
      agentCount: opts.agentCount ?? 58,
      seed: opts.rngSeed ?? 'world-1',
      resumeFrom: opts.resumeFrom,
      snapshotEveryEvents: opts.snapshotEveryEvents ?? 350,
      onSnapshot: ({ ordinal, generation, report }) => {
        this.pump()
        /**
         * §20.4: keyed on event ordinal. This is what the scrub later queries.
         *
         * §22.3: the ordinal is season-local. The log is shared and its ids run
         * on across seasons, but a spectator scrubs *this* season — so a slider
         * whose range is the global count would spend most of its travel
         * sitting on the season's first snapshot.
         */
        this.store.putSnapshot({
          chunkId: this.chunkId,
          season: this.season,
          ordinal: ordinal - this.firstEventId,
          generation,
          tick: this.sim.world.tick,
          buildingData: this.texture.bytes.slice(),
          divergenceIndex: report.index,
          stats: {
            touched: report.touchedShare,
            agentOrigin: report.agentOrigin,
            demolished: report.demolished,
          },
        })
      },
    })

    this.texture = new BuildingTexture(opts.seed.buildings.map((b) => b.id))
    /**
     * §72.1: a resumed world has to re-materialise what it already built.
     *
     * The texture is seeded from the BASELINE ids, and everything an agent put
     * up got its slot from `pendingGeometry` as it was built. A resumed world's
     * agent-built stock is back in the simulation but has never been through
     * that queue in this process, so without this it would have no slot, no
     * geometry on the client, and no place in the data texture — a city that
     * resumed with two hundred of its buildings invisible.
     *
     * Pushed in `buildings` insertion order, which the capture preserves, so
     * the slots come out where they were. That matters beyond tidiness: §20.4's
     * scrub compares texture bytes across ordinals, and a reshuffle would make
     * every snapshot taken before the restart disagree with every one after it.
     */
    if (opts.resumeFrom) {
      for (const b of this.sim.world.buildings.values()) {
        if (b.source !== 'real_world') this.sim.world.pendingGeometry.push(b.id)
      }
    }
    for (const b of this.sim.world.buildings.values()) this.known.add(b.id)
    this.pump()
    // the founding population arrives in `hello`, not as a birth
    this.bornSinceFrame = []
    this.lastBroadcastBytes = this.texture.bytes.slice()
    // §72.1: only a world that is BEGINNING writes the season's ordinal-0
    // snapshot. A resumed one would be writing a second row under a key the
    // season already has, which is the collision this block exists to end.
    if (!opts.resumeFrom) {
      this.store.putSnapshot({
        chunkId: this.chunkId,
        season: this.season,
        ordinal: 0,
        generation: 1,
        tick: 0,
        buildingData: this.texture.bytes.slice(),
        divergenceIndex: 0,
        stats: {},
      })
    }
  }

  /** §72.1: this world, whole, for the store. */
  capture(): WorldState {
    return this.sim.capture(this.season, this.firstEventId)
  }

  get throughput(): number {
    return this.throughputIndex
  }

  private sampleRate(issued: number): void {
    const now = Date.now()
    this.rateSamples.push({ at: now, n: issued })
    while (this.rateSamples.length && now - this.rateSamples[0].at > RATE_WINDOW_MS) {
      this.rateSamples.shift()
    }
  }

  /** §72.2: measured decisions per second over the last few seconds. */
  get measuredRate(): number {
    if (this.rateSamples.length < 2) return 0
    const span = (Date.now() - this.rateSamples[0].at) / 1000
    if (span <= 0) return 0
    let total = 0
    for (const s of this.rateSamples) total += s.n
    return +(total / span).toFixed(1)
  }

  /**
   * Advance the world by wall-clock time at the current throughput. The loop
   * calls this; nothing a client sends does.
   */
  async advance(dtSeconds: number): Promise<void> {
    if (this.ticking) return
    const dps = THROUGHPUT[this.throughputIndex].decisionsPerSecond
    if (dps <= 0) return

    /**
     * §72.2: the loop targets decisions per SECOND, with the fraction carried
     * across frames.
     *
     * It used to ask for `Math.max(1, Math.round(dps * dtSeconds))`. At the
     * 100 ms frame that is `max(1, round(1.4))` = 1 at 'normal' and
     * `max(1, round(0.3))` = 1 at 'slow' — the same number, so two of the five
     * dial positions were identical. And `runToThroughput` stops as soon as
     * `issued >= target` while one `step()` issues however many decisions it
     * happens to issue, so exactly one step ran per frame and the world's rate
     * was (decisions per step) x 10, with nothing reading it back. Measured on
     * production: 4.15 decisions per step, 41.1 per second, against a dial
     * saying 14.
     *
     * A budget that accumulates fixes both halves. The fraction survives
     * between frames, so 3/s and 14/s are different rates; and the overshoot is
     * SPENT rather than forgiven — a step that issues four decisions against a
     * budget of 1.4 leaves the credit at -2.6 and the next two frames run no
     * steps at all. That is what makes the average come out at the number on
     * the dial instead of at whatever the world felt like.
     */
    /**
     * §72.4: a world that is producing history faster than history can be
     * written down stops producing it.
     *
     * The write-behind queue grew monotonically in production — 701 to 18,256
     * events across 1,000 seconds — which is a slow leak and, worse, a
     * data-loss window that widens with uptime: everything queued is gone if
     * the process dies. §22.4 fixes the width of that window at `flushMs`, and
     * an unbounded queue quietly makes that promise false. So when the queue is
     * past its ceiling the world waits. It is the only lever that does not
     * involve dropping events, and dropping events is not a lever.
     */
    if (this.store.saturated) {
      this.stalled++
      return
    }

    this.credit = Math.min(this.credit + dps * dtSeconds, dps)
    if (this.credit < 1) return
    const target = Math.floor(this.credit)

    this.ticking = true
    try {
      const before = this.sim.decisionsIssued
      await this.sim.runToThroughput(target, 60)
      const issued = this.sim.decisionsIssued - before
      this.credit -= issued
      this.sampleRate(issued)
      const r = this.sim.refreshReport()
      this.pump()

      /**
       * §22.3: the world has no budget, it has a horizon. When the reachable
       * stock is used up the season ends rather than the world stalling with
       * agents trading a finished city — the alternative §22.3 names as the
       * cost of running continuously.
       */
      if (!this.saturatedAlready) {
        const saturated = this.saturation.sample({
          decisions: this.sim.decisionsIssued,
          index: r.index,
          agentOrigin: r.agentOrigin,
          cleared: r.demolished,
        })
        // §23.4: pressure turns the season regardless of what the world is
        // doing, so the texture ceiling cannot be reached rather than being
        // estimated not to be.
        const pressed = this.texture.pressure >= SLOT_PRESSURE_TURN
        const reason: SeasonEndReason = saturated ? 'saturation' : 'slot_pressure'
        if (saturated || pressed) {
          this.saturatedAlready = true
          this.store.appendEvent({
            chunkId: this.chunkId,
            tick: this.sim.world.tick,
            type: 'season_ended',
            cinematicWeight: BASE_CINEMATIC_WEIGHT.season_ended,
            rationale:
              `season ${this.season} reached ${(r.index * 100).toFixed(1)}% divergence over ` +
              `${this.sim.world.livesCompleted} agent lifetimes and ` +
              (reason === 'saturation'
                ? 'stopped changing'
                : `filled ${(this.texture.pressure * 100).toFixed(0)}% of its building slots`),
            payload: {
              season: this.season,
              reason,
              slotPressure: +this.texture.pressure.toFixed(3),
              divergenceIndex: r.index,
              agentOrigin: r.agentOrigin,
              cleared: r.demolished,
              decisions: this.sim.decisionsIssued,
            },
          })
          this.onSaturated?.(this.season, reason)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Fold everything the simulation changed into the texture and the queues. */
  private pump(): void {
    const w = this.sim.world

    if (w.pendingGeometry.length > 0) {
      for (const id of w.pendingGeometry) {
        const b = w.buildings.get(id)
        if (!b) continue
        const spec = materialiseSpec(b)
        this.texture.reslot(b.id)
        this.materialised.set(b.id, spec)
        this.pendingMaterialise.push(spec)
      }
      w.pendingGeometry.length = 0
    }

    for (const b of w.buildings.values()) {
      const slot = this.texture.slotOf(b.id)
      if (slot === undefined) continue
      this.texture.set(slot, progressOf(b), b.divergence, purposeIndexOf(b), b.condition)
    }

    for (const e of w.edges.values()) {
      if (!e.agentBuilt || this.agentRoads.has(e.id)) continue
      const wire = roadWire(this.sim, e.id)
      if (!wire) continue
      this.agentRoads.set(e.id, wire)
      this.pendingRoads.push(wire)
    }
    w.pendingRoads.length = 0

    // §12: an heir is a new agent with a name and a colour, and the client has
    // to be told who it is once rather than every frame.
    for (const a of w.agents.values()) {
      if (a.diedTick) {
        if (this.known.delete(a.id)) this.retiredSinceFrame.push(a.id)
      } else if (!this.known.has(a.id)) {
        this.known.add(a.id)
        this.bornSinceFrame.push(agentIdentity(a))
      }
    }
  }

  /** Set by the transport; it is the only thing here that is not the world. */
  viewers = 0

  readouts(): Readouts {
    const r = this.sim.report
    return {
      viewers: this.viewers,
      season: this.season,
      pace: {
        label: THROUGHPUT[this.throughputIndex].label,
        decisionsPerSecond: this.measuredRate,
        target: THROUGHPUT[this.throughputIndex].decisionsPerSecond,
      },
      divergenceIndex: r.index,
      generation: this.sim.generation,
      touchedShare: r.touchedShare,
      agentOrigin: r.agentOrigin,
      demolished: r.demolished,
      tick: this.sim.world.tick,
      decisions: this.sim.decisionsIssued,
      // §22.3: this season's log, which is what the scrub travels
      eventCount: Math.max(0, this.store.nextEventId() - this.firstEventId),
    }
  }

  /** The delta since the last broadcast, as [slot, r, g, b, a] runs. */
  nextFrame(): Frame {
    const texels: number[] = []
    const now = this.texture.bytes
    const before = this.lastBroadcastBytes
    for (let i = 0; i < now.length; i += 4) {
      if (
        now[i] !== before[i] ||
        now[i + 1] !== before[i + 1] ||
        now[i + 2] !== before[i + 2] ||
        now[i + 3] !== before[i + 3]
      ) {
        texels.push(i >> 2, now[i], now[i + 1], now[i + 2], now[i + 3])
        before[i] = now[i]
        before[i + 1] = now[i + 1]
        before[i + 2] = now[i + 2]
        before[i + 3] = now[i + 3]
      }
    }

    const fresh = this.store
      .events({ sinceTick: Math.max(0, this.sim.world.tick - 400), limit: 60, minWeight: 15 })
      .filter((e) => e.id > this.lastEventId && e.id > this.firstEventId)
      .reverse()
    if (fresh.length) this.lastEventId = Math.max(...fresh.map((e) => e.id))

    const frame: Frame = {
      t: 'frame',
      readouts: this.readouts(),
      texels,
      materialise: this.pendingMaterialise,
      roads: this.pendingRoads,
      agents: agentWire(this.sim),
      born: this.bornSinceFrame,
      events: fresh.map((e) => eventWire(this.sim, e)),
      retired: this.retiredSinceFrame,
    }
    this.pendingMaterialise = []
    this.pendingRoads = []
    this.retiredSinceFrame = []
    this.bornSinceFrame = []
    return frame
  }

  /** Everything a joining spectator needs to be looking at *now*. */
  hello(viewers: number): Hello {
    const recent = this.store
      .events({ sinceTick: Math.max(0, this.sim.world.tick - 900), limit: 11, minWeight: 15 })
      .filter((e) => e.id > this.firstEventId)
      .reverse()
    return {
      t: 'hello',
      protocol: 1,
      chunkId: this.chunkId,
      buildingData: toBase64(this.texture.bytes),
      materialise: [...this.materialised.values()],
      roads: [...this.agentRoads.values()],
      agents: [...this.sim.world.agents.values()]
        .filter((a) => !a.diedTick)
        .map((a) => agentIdentity(a)),
      readouts: this.readouts(),
      events: recent.map((e) => eventWire(this.sim, e)),
      viewers,
      durability: this.store.durability,
      // §64.2: since genesis, not since this process started
      uptimeSeconds: Math.max(0, Math.round((Date.now() - this.store.genesisAt(this.chunkId)) / 1000)),
    }
  }

  /** Recent history for a client that has just connected, oldest first. */
  recentEvents(limit: number): EventWire[] {
    return this.store
      .events({ limit, minWeight: 15 })
      .filter((e) => e.id > this.firstEventId)
      .reverse()
      .map((e) => eventWire(this.sim, e))
  }

  /** §20.2: never rendered, but the log's window is expressed in it. */
  get rateWindow(): number {
    return RATE_WINDOW_TICKS
  }
}
