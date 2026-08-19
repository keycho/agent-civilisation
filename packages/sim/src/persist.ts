/**
 * §72.1: the world resumes rather than restarts.
 *
 * `constructHosts()` called `newSeason(host, 1)` unconditionally from the
 * on-disk seed, so every redeploy started every chunk over at season 1
 * generation 1. A world that resets whenever the platform deploys can never
 * accumulate the generational history the product is about.
 *
 * §72.1 asks for "restore from the latest snapshot plus events since". That is
 * not possible as written, and the reason is worth recording rather than
 * quietly working around: the §16.2 snapshot is a picture, not a state. It
 * carries the building data TEXTURE — four bytes per building, progress,
 * divergence, purpose, condition — because its job is the §20.4 scrub. It has
 * no agents, no capital, no debt, no ownership, no plans, no land values, no
 * rng position. And the event log is a narrative log rather than a redo log:
 * `acquired`, `demolition_started`, `district_formed` describe what happened
 * for a spectator to read, not the field-level mutations needed to replay it.
 * Restoring from those two would produce a world that looks like the one that
 * stopped and behaves like a different one.
 *
 * So this is the missing third thing: the world's own state, captured whole and
 * put back whole. Plain JSON rather than a binary format, because the thing it
 * has to survive is a schema that is still moving — a readable blob with a
 * version on it can be inspected and migrated, and at this size the bytes are
 * not the constraint.
 *
 * What is NOT captured is everything derivable from the seed plus what is
 * captured: parcel adjacency, baseline areas, the intensity/floor/competition
 * grids. `restoreWorld` rebuilds those after loading, which is both smaller and
 * safer — a derived field that drifts from its inputs is a bug that survives a
 * restart, and recomputing it cannot.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Block, Building, Parcel, Purpose, RoadEdge, RoadNode } from '@civ/core'
import type { WorldEvent } from '@civ/persistence'
import { buildAdjacency } from './state.ts'
import type { Agent, Assembly, SitePlan, World } from './state.ts'

/** bump when a field changes meaning; an older blob is refused, not guessed at */
export const WORLD_STATE_VERSION = 3

/**
 * How far back `observe()` in engine.ts looks. Kept here as the width of the
 * log window a resume has to carry — if that query's horizon moves, this moves
 * with it or the resume silently stops being exact.
 */
const OBSERVE_WINDOW_TICKS = 180

/** An agent with its two Sets flattened, which is the only shape JSON cannot take. */
type AgentState = Omit<Agent, 'holdings' | 'parcels'> & {
  holdings: string[]
  parcels: string[]
}

export interface WorldState {
  v: number
  chunkId: string
  /** §72.1: the season this state belongs to, checked on load */
  season: number
  /**
   * §22.3: snapshot ordinals are season-local — `ordinal - firstEventId`. The
   * subtrahend is captured when the season begins, so a resumed season has to
   * carry it or its scrub range restarts at zero half way through.
   */
  firstEventId: number
  tick: number
  decisionsIssued: number
  appliedActions: number
  competitionMedian: number
  /** mulberry32's u32, so the stream continues rather than replays */
  worldRng: number
  simRng: number
  serials: { building: number; node: number; edge: number; plan: number; heir: number }
  buildings: Building[]
  parcels: Parcel[]
  blocks: Block[]
  agents: AgentState[]
  nodes: RoadNode[]
  edges: RoadEdge[]
  sitePlans: SitePlan[]
  planByParcel: Array<[string, string]>
  lastTransfer: Array<[string, number]>
  acquisitionCount: Array<[string, number]>
  enumerated: Array<[string, number]>
  actionCounts: Array<[string, number]>
  decisionMargins: Array<[string, number[]]>
  assemblies: Assembly[]
  transactions: World['transactions']
  pendingGeometry: string[]
  pendingRoads: string[]
  /** §60(d): which buildings already belong to an announced district */
  districted: string[]
  lastSnapshotEventCount: number
  /**
   * §72.1: the log window `observe()` reads, carried with the state.
   *
   * This one was found by the round-trip test rather than by inspection, and it
   * is the reason that test exists. `observe()` includes
   * `store.events({ sinceTick: tick - 180, limit: 60 })` in what an agent
   * decides against, so the recent log is a simulation INPUT and not only a
   * spectator's feed. A world restored with an empty store made measurably
   * different choices — four applied actions out of 2,290 — for its first 180
   * ticks, which is exactly the kind of near-miss that boots cleanly and is not
   * the world that stopped.
   *
   * Carried in the blob rather than re-queried so a world state is
   * self-sufficient: it restores the same way whether the store behind it is
   * Postgres or memory, and the resume path has no second thing that can fail.
   */
  recentEvents: WorldEvent[]
  /**
   * §72.1: every grid, carried rather than recomputed — and the reason is a
   * correction to how this file was first written.
   *
   * The first cut rebuilt these from the restored stock, on the argument that a
   * derived field which drifts from its inputs is a bug that survives a restart
   * and recomputing it cannot. The round-trip test falsified that: NONE of them
   * is a pure function of the current stock. `intensity` and the floor fields
   * carry decay accumulated per tick, `demand` accrues bids that never cleared,
   * `competition` is a damped follower of demand (§28.4 requires the damping),
   * and the site residual is a cache filled under an earlier market. Recomputing
   * produced a world that was plausible and different — intensity off in the
   * third decimal, the competition median reset to zero, 150 cached residuals
   * gone — and four applied actions had diverged 1,500 decisions later.
   *
   * So the rule for this file is now: capture everything mutable, recompute
   * nothing except what is provably a pure function of what was captured.
   * Parcel adjacency is the only thing that qualifies, and it is checked.
   */
  grid: { cols: number; rows: number }
  intensity: number[]
  floorTotal: number[]
  floorByPurpose: Array<[string, number[]]>
  demand: number[]
  competition: number[]
  siteResidualCache: Array<[string, number]>
}

export function captureWorld(w: World, season: number, sim: SimCapture): WorldState {
  return {
    v: WORLD_STATE_VERSION,
    chunkId: w.chunkId,
    season,
    firstEventId: sim.firstEventId,
    tick: w.tick,
    decisionsIssued: w.decisionsIssued,
    appliedActions: w.appliedActions,
    competitionMedian: w.competitionMedian,
    worldRng: w.rng.save(),
    simRng: sim.rng,
    serials: { ...w.captureSerials(), heir: sim.nextHeirSerial },
    buildings: [...w.buildings.values()],
    parcels: [...w.parcels.values()],
    blocks: [...w.blocks.values()],
    agents: [...w.agents.values()].map((a) => ({
      ...a,
      holdings: [...a.holdings],
      parcels: [...a.parcels],
    })),
    nodes: [...w.nodes.values()],
    edges: [...w.edges.values()],
    sitePlans: [...w.sitePlans.values()],
    planByParcel: [...w.planByParcel],
    lastTransfer: [...w.lastTransfer],
    acquisitionCount: [...w.acquisitionCount],
    enumerated: [...w.enumerated],
    actionCounts: [...w.actionCounts],
    decisionMargins: [...w.decisionMargins].map(([k, v]) => [k, [...v]] as [string, number[]]),
    assemblies: [...w.assemblies],
    transactions: [...w.transactions],
    pendingGeometry: [...w.pendingGeometry],
    pendingRoads: [...w.pendingRoads],
    districted: [...sim.districted],
    lastSnapshotEventCount: sim.lastSnapshotEventCount,
    recentEvents: w.store.events({ sinceTick: w.tick - OBSERVE_WINDOW_TICKS }).reverse(),
    grid: { cols: w.intensityCols, rows: w.intensityRows },
    intensity: [...w.intensity],
    floorTotal: [...w.floorTotal],
    floorByPurpose: [...w.floorByPurpose].map(([k, v]) => [k, [...v]] as [string, number[]]),
    demand: [...w.demand],
    competition: [...w.competition],
    siteResidualCache: [...w.siteResidualCache],
  }
}

/** The bits of `Simulation` that are not on the world but are still its state. */
export interface SimCapture {
  rng: number
  firstEventId: number
  nextHeirSerial: number
  districted: Set<string>
  lastSnapshotEventCount: number
}

/**
 * Put a captured world back into a freshly seeded one.
 *
 * The world passed in must have been constructed from the SAME seed the state
 * was captured from — the baseline maps (`baselineAreaByParcel`, footprints of
 * unmutated stock) come from there and are not in the blob. That is checked as
 * far as it can be: the chunk id must match, and the version must be exact.
 */
export function restoreWorld(w: World, s: WorldState): void {
  if (s.v !== WORLD_STATE_VERSION) {
    throw new Error(
      `world state is version ${s.v}, this build reads ${WORLD_STATE_VERSION} — ` +
        `refusing to guess at a schema that has moved`,
    )
  }
  if (s.chunkId !== w.chunkId) {
    throw new Error(`world state is for chunk '${s.chunkId}', this world is '${w.chunkId}'`)
  }

  w.store.hydrate(s.recentEvents)

  w.tick = s.tick
  w.decisionsIssued = s.decisionsIssued
  w.appliedActions = s.appliedActions
  w.competitionMedian = s.competitionMedian
  w.rng.load(s.worldRng)
  w.restoreSerials(s.serials)

  replaceById(w.buildings, s.buildings)
  replaceById(w.parcels, s.parcels)
  replaceById(w.blocks, s.blocks)
  replaceById(w.nodes, s.nodes)
  replaceById(w.edges, s.edges)
  replaceById(w.sitePlans, s.sitePlans)

  w.agents.clear()
  for (const a of s.agents) {
    w.agents.set(a.id, { ...a, holdings: new Set(a.holdings), parcels: new Set(a.parcels) })
  }

  replaceEntries(w.planByParcel, s.planByParcel)
  replaceEntries(w.lastTransfer, s.lastTransfer)
  replaceEntries(w.acquisitionCount, s.acquisitionCount)
  replaceEntries(w.enumerated, s.enumerated)
  replaceEntries(w.actionCounts, s.actionCounts)
  replaceEntries(w.decisionMargins, s.decisionMargins)

  replaceArray(w.assemblies, s.assemblies)
  replaceArray(w.transactions, s.transactions)
  replaceArray(w.pendingGeometry, s.pendingGeometry)
  replaceArray(w.pendingRoads, s.pendingRoads)

  // the parcel <-> building backlink is not stored twice; it is re-derived,
  // because a link that disagrees with itself after a restart is the worst
  // possible outcome and re-deriving it cannot disagree
  for (const b of w.buildings.values()) b.parcelId = undefined
  for (const p of w.parcels.values()) {
    const b = p.buildingId ? w.buildings.get(p.buildingId) : undefined
    if (b) b.parcelId = p.id
  }

  // the one genuinely derived structure: parcel adjacency is a pure function of
  // the parcels, and the round-trip test confirms it reproduces exactly
  buildAdjacency(w)

  if (s.grid.cols !== w.intensityCols || s.grid.rows !== w.intensityRows) {
    throw new Error(
      `world state was captured on a ${s.grid.cols}x${s.grid.rows} market grid and this ` +
        `world has ${w.intensityCols}x${w.intensityRows} — the seed or the cell size has moved`,
    )
  }
  w.intensity.set(s.intensity)
  w.floorTotal.set(s.floorTotal)
  w.floorByPurpose.clear()
  for (const [k, v] of s.floorByPurpose) w.floorByPurpose.set(k as Purpose, Float32Array.from(v))
  w.demand.set(s.demand)
  w.competition.set(s.competition)
  replaceEntries(w.siteResidualCache, s.siteResidualCache)
}

function replaceById<T extends { id: string }>(map: Map<string, T>, items: T[]): void {
  map.clear()
  for (const it of items) map.set(it.id, it)
}

function replaceEntries<V>(map: Map<string, V>, entries: Array<[string, V]>): void {
  map.clear()
  for (const [k, v] of entries) map.set(k, v)
}

function replaceArray<T>(target: T[], items: T[]): void {
  target.length = 0
  target.push(...items)
}

/**
 * §72.1: what actually goes to the database.
 *
 * gzip because the blob is mostly repeated keys and long id strings — measured
 * at roughly a tenth of the raw size — and because a world that is cheap to
 * save gets saved often, which is the whole point of a resume path.
 */
export function encodeWorldState(s: WorldState): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(s), 'utf8'))
}

export function decodeWorldState(bytes: Uint8Array): WorldState {
  return JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8')) as WorldState
}
