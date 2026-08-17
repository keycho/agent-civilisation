/**
 * §31.6-5: the region world. Several fine chunks under one budget, with the
 * §27.3 summary object between them.
 *
 * The pieces, in the order the spec builds them:
 *
 *   summaries   each settlement keeps one rolling RegionalSummary — median
 *               land value, vacancy, activity, capital density, realised
 *               yield, agent count, contest. Agents read summaries to choose
 *               where; the global view renders the same object (§27.3: "one
 *               dataset, computed once").
 *   transit     migrating costs capital scaled by real distance between the
 *               settlements' anchors. Cheap inside the NL constellation,
 *               expensive intercontinentally — the §28.3 commitment made
 *               physical.
 *   materialise gated and warmed (§28.3): a migration into a dormant
 *               settlement pays a commitment that is forfeit on reversal, and
 *               the top dormant candidate by estimated yield is speculatively
 *               warmed in the background so the common case is resident.
 *   migration   last and smallest (§30.5): only agents in the bottom third of
 *               local realised yield consider it, at a low cadence, one hop
 *               per generation, and the §28.1 estimate is lossy on purpose —
 *               discovery lives in the gap, and failed migration (reversal)
 *               is supported and counted, never patched away.
 *
 * Abandonment stays unbuilt until a chunk actually drains (§30.5); a drain is
 * detected and counted, nothing more.
 */
import type { WorldSeed } from '@civ/core'
import { MemoryStore } from '@civ/persistence'
import { availableFunds, spend } from './economy.ts'
import { Simulation } from './tick.ts'
import type { Strategy, World } from './state.ts'
import { makeRng } from '@civ/core'

export interface SettlementInfo {
  id: string
  name: string
  country: string
  lat: number
  lon: number
  population: number
  valueIndex?: number
  valueTier: string
}

/** §27.3: the one object. Serves agent destination choice and the global view. */
export interface RegionalSummary extends SettlementInfo {
  materialised: boolean
  agentCount: number
  medianLandValue: number
  vacancyShare: number
  /** applied actions per 1k decisions attributed here, rolling */
  activityRate: number
  capitalDensity: number
  /** realised: median standing yield over value, annualised */
  realisedYield: number
  /** median competition where agents concentrate */
  contest: number
  /**
   * §28.1: the coarse estimate everyone reads before committing. Lossy on
   * purpose — anchored on the coarse value index, blind to parcel supply,
   * grain and vacancy, so the fine reality can be better or worse than
   * advertised. For a materialised settlement the estimate still carries a
   * stated lag behind realised truth.
   */
  estimatedYield: number
}

export interface RegionMigration {
  agentId: string
  fromChunk: string
  toSettlement: string
  departedTick: number
  arrivedTick?: number
  offeredGap: number
  destinationValueTier: string
  reversed: boolean
  /** what the §28.3 gate collected; forfeit when the migration reverses */
  commitment: number
  /**
   * §44.3: at grace-window end, destination realised < origin realised —
   * the would-have-reversed marker, evaluated once per migration
   */
  belowOriginAtGrace?: boolean
}

export interface RegionOptions {
  /** every settlement with a fine seed available on disk */
  seeds: Map<string, WorldSeed>
  /** settlement metadata from the coarse layer */
  info: Map<string, SettlementInfo>
  /** the settlements that start materialised and ticking */
  seeded: string[]
  rngSeed: string
  agentsPerChunk?: number
}

const SLICE_DECISIONS = 400
const SUMMARY_RATE_YEAR = 365

/**
 * §28.1: the advertised yield's anchor. The coarse office advertises what a
 * MATURE market achieves, not what the unoptimised day-0 stock earns — the
 * five adapters' realised standing yield at the frozen budget measured
 * 0.133–0.192 (median 0.148, §31.6-5 calibration run), against day-0 medians
 * of −0.010–0.049. An estimate anchored on day-0 would sit below every live
 * market forever and migration would be structurally impossible — not lossy,
 * just wrong in scale. The loss §28.1 asks for stays where it belongs: the
 * value-index distortion, the blindness to parcel supply, grain and vacancy,
 * and the lag blend below.
 */
const ESTIMATE_REF_YIELD = 0.15
const ESTIMATE_SPREAD = 0.5

/**
 * Transit, in capital units, against the economy's own scales (measured:
 * seedCredit 1200, holdings-empty agents hold ~0 cash and fund moves on
 * credit). Base is the fixed cost of uprooting; distance does the rest.
 * NL-constellation hops (~8–12 km) land near 160–170 — affordable on the
 * facility, §28.3's "cheap inside the NL constellation". London–Schiedam
 * (~320 km) lands near 910 — most of the facility. Brooklyn or Tokyo
 * (5,900–9,300 km) land at 14k–22k — prohibitive for the §30.5 migrant
 * class, which is the physical claim, not a bug: the poor do not fly.
 */
const TRANSIT_BASE = 140
const TRANSIT_PER_KM = 2.4

/**
 * §28.3: the materialisation commitment, forfeit on reversal. About a third
 * of the credit facility: it stings — reversing burns it — without walling
 * the constellation off (at 1200 it WAS the facility and no dormant
 * settlement could ever be opened).
 */
const MATERIALISE_COMMITMENT = 350
/** arrive able to act at all — a floor on post-move funds, not a fund */
const MIN_ARRIVAL_STAKE = 180

/**
 * The horizon the yield advantage is weighed over, in SUMMARY_RATE_YEAR
 * units. Measured at the frozen budget: a 34k-decision run spans ~8,200
 * ticks ≈ 22 years and ~2 generations, so one active life ≈ 10–11 years.
 * A migrant weighs the advertised advantage over roughly a life.
 */
const HORIZON_YEARS = 10

/** migration cadence and caps — last and smallest */
const MIGRATION_EVERY_SLICES = 4
const MAX_MIGRATIONS_PER_PASS = 2
const REVERSAL_WINDOW_TICKS = 2200
const GAP_MARGIN = 1.35

/**
 * §44.2: contest is sampled when a chunk crosses HALF the frozen
 * single-chunk budget (§20.9: 34k over two), per §29.1's documented
 * terminal-saturation practice — at end-of-run the competition median reads
 * 1.00 in every chunk and ranks nothing. Run 1 measured exactly that.
 */
const CONTEST_SAMPLE_DECISIONS = 17_000

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** the fine-side body of a RegionalSummary — what only a live sim can know */
export interface FineSummary {
  agentCount: number
  medianLandValue: number
  vacancyShare: number
  activityRate: number
  capitalDensity: number
  realisedYield: number
  contest: number
}

/**
 * §27.3: "one dataset, computed once." This is the one computation — the
 * region harness reads it per chunk and the live chunk server serves it at
 * GET /summary, so the global view and agent destination choice can never
 * disagree about what a settlement looks like.
 */
export function fineSummaryOf(w: World): FineSummary {
  const values: number[] = []
  let vacant = 0
  let total = 0
  for (const p of w.parcels.values()) {
    // land value is landBase x access x intensity, and intensity is sparse:
    // the all-parcel median reads the fabric's dead zones and sits at 0. The
    // summary reports what land the market prices at all.
    if (p.landValue > 0) values.push(p.landValue)
    total++
    if (!p.buildingId) vacant++
  }
  const yields: number[] = []
  let capital = 0
  for (const b of w.buildings.values()) {
    if (b.state !== 'standing' || b.source !== 'real_world') continue
    const price = Math.max(1, b.areaM2)
    yields.push((b.yieldPerTick * SUMMARY_RATE_YEAR) / price)
  }
  let agentCount = 0
  for (const a of w.agents.values())
    if (!a.diedTick) {
      capital += a.capital
      agentCount++
    }
  return {
    agentCount,
    medianLandValue: median(values),
    vacancyShare: total ? vacant / total : 0,
    activityRate: w.decisionsIssued > 0 ? w.appliedActions / w.decisionsIssued : 0,
    capitalDensity: total ? capital / total : 0,
    realisedYield: median(yields),
    // "median competition where agents concentrate" — the live-cell median
    // the market step already maintains (§27.5), not the full-grid median,
    // which is dominated by cells nobody bids on and reads near zero
    contest: w.competitionMedian,
  }
}

export class RegionWorld {
  readonly sims = new Map<string, Simulation>()
  readonly summaries = new Map<string, RegionalSummary>()
  readonly migrations: RegionMigration[] = []
  readonly materialisedEver = new Set<string>()
  readonly decisionsBy = new Map<string, number>()
  readonly drains = new Map<string, number>()
  /** §44.2: per-chunk contest at its half-budget crossing, sampled once */
  readonly midContest = new Map<string, number>()
  private readonly lastAlive = new Map<string, number>()
  /**
   * §28.3: a warmed chunk is CONSTRUCTED but not TICKING — the pre-load is
   * infrastructure, not world semantics. Its residents exist and are frozen;
   * nothing about the settlement is simulated until a migrant pays the gate
   * and opens it. The contract's `materialised` means ticking, and warm
   * membership here is exactly what keeps those two honest.
   */
  private readonly warmOnly = new Set<string>()
  warmed = 0
  gated = 0

  private readonly opts: RegionOptions
  private readonly rng: ReturnType<typeof makeRng>
  private slice = 0
  /** arrivals watching their bet inside the reversal window */
  private watching: Array<{
    migration: RegionMigration
    newAgentId: string
    estimateAtCommit: number
    deadlineTick: number
  }> = []

  constructor(opts: RegionOptions) {
    this.opts = opts
    this.rng = makeRng(`${opts.rngSeed}:region`)
    for (const id of opts.seeded) this.materialise(id, 'seeded')
    for (const [id] of opts.seeds) this.refreshSummary(id)
  }

  private materialise(id: string, how: 'seeded' | 'warm' | 'gate'): Simulation | null {
    const existing = this.sims.get(id)
    if (existing) {
      // a gate on a warm chunk is the §28.3 common case: the sim is already
      // resident, the gate just opens the world
      if (how === 'gate' && this.warmOnly.has(id)) {
        this.warmOnly.delete(id)
        this.materialisedEver.add(id)
        this.gated++
        this.refreshSummary(id)
      }
      return existing
    }
    const seed = this.opts.seeds.get(id)
    if (!seed) return null
    const sim = new Simulation(seed, new MemoryStore(), {
      agentCount: this.opts.agentsPerChunk ?? 58,
      seed: `${this.opts.rngSeed}:${id}`,
    })
    this.sims.set(id, sim)
    this.decisionsBy.set(id, sim.decisionsIssued)
    if (how === 'warm') {
      this.warmOnly.add(id)
      this.warmed++
    } else {
      this.materialisedEver.add(id)
      if (how === 'gate') this.gated++
    }
    this.refreshSummary(id)
    return sim
  }

  private refreshSummary(id: string): void {
    const info = this.opts.info.get(id)
    if (!info) return
    // a warm chunk is dormant to every reader (§28.3): the coarse office
    // cannot see inside a world that is not being simulated
    const active = this.sims.has(id) && !this.warmOnly.has(id)
    const sim = active ? this.sims.get(id) : undefined
    const base: RegionalSummary = {
      ...info,
      materialised: active,
      agentCount: 0,
      medianLandValue: 0,
      vacancyShare: 0,
      activityRate: 0,
      capitalDensity: 0,
      realisedYield: 0,
      contest: 0,
      estimatedYield:
        ESTIMATE_REF_YIELD * (1 + ESTIMATE_SPREAD * ((info.valueIndex ?? 1) - 1)),
    }
    if (sim) {
      Object.assign(base, fineSummaryOf(sim.world))
      // §28.1: even for a resident chunk the ESTIMATE stays coarse — the lag
      // between advertisement and reality is where reversal comes from
      base.estimatedYield = base.estimatedYield * 0.6 + base.realisedYield * 0.4
    }
    this.summaries.set(id, base)
  }

  private transitCost(fromId: string, toId: string): number {
    const a = this.opts.info.get(fromId)
    const b = this.opts.info.get(toId)
    if (!a || !b) return Number.POSITIVE_INFINITY
    return TRANSIT_BASE + TRANSIT_PER_KM * haversineKm(a.lat, a.lon, b.lat, b.lon)
  }

  /**
   * §28.3's warm path: the top dormant candidate by estimated yield is
   * constructed in the background — loaded, not simulated — so the common
   * gate destination is resident before anyone pays for it. One warm slot:
   * when a warm chunk is opened by a gate, the next pass warms the new
   * favourite.
   */
  private warmPass(): void {
    if (this.warmOnly.size > 0) return
    const dormant = [...this.opts.seeds.keys()].filter((id) => !this.sims.has(id))
    if (!dormant.length) return
    const top = dormant.sort(
      (a, b) =>
        (this.summaries.get(b)?.estimatedYield ?? 0) - (this.summaries.get(a)?.estimatedYield ?? 0),
    )[0]
    if (top) this.materialise(top, 'warm')
  }

  /**
   * §30.5: migration last and smallest.
   *
   * WHO: agents holding nothing. In this economy wealth is holdings and
   * liquid capital hovers near zero for everyone (measured: mid-run capital
   * median 0, bottom third in debt), so "the bottom third of local realised
   * yield" is computed honestly as the agents whose own realised yield is
   * exactly zero — the ones nothing anchors here.
   *
   * HOW IT'S PAID: through the economy's own affordability primitive.
   * availableFunds (cash + undrawn credit) admits the move, spend() pays for
   * it, and any drawn credit rides the migrant's own debt ledger to the
   * destination. No new money is minted and no new machinery exists.
   *
   * THE TEST: the advertised yield is an annual rate; the move is a one-off
   * cost. They are made commensurable over a working life: move when
   * est(to) x HORIZON x funds covers the cost with margin.
   */
  private migrationPass(): void {
    let moved = 0
    for (const [fromId, sim] of this.sims) {
      if (moved >= MAX_MIGRATIONS_PER_PASS) break
      if (this.warmOnly.has(fromId)) continue
      const from = this.summaries.get(fromId)
      if (!from) continue
      const w = sim.world
      const alive = [...w.agents.values()].filter((a) => !a.diedTick)
      if (alive.length <= 8) continue // a drained chunk sends nobody
      const pool = alive.filter((a) => !a.id.startsWith('migrant') && a.holdings.size === 0)
      if (!pool.length) continue
      const agent = pool[Math.floor(this.rng() * pool.length)]
      if (!agent) continue
      const funds = availableFunds(w, agent)
      if (funds <= MIN_ARRIVAL_STAKE) continue

      // read the summaries, §27.3: choose the destination with the best
      // surplus of advertised yield over the cost of getting there
      let best: { id: string; surplus: number; cost: number; commitment: number } | null = null
      for (const [toId, to] of this.summaries) {
        if (toId === fromId || !this.opts.seeds.has(toId)) continue
        const transit = this.transitCost(fromId, toId)
        const commitment = to.materialised ? 0 : MATERIALISE_COMMITMENT
        const cost = transit + commitment
        if (funds < cost + MIN_ARRIVAL_STAKE) continue
        const carry = cost / (Math.max(1, funds - cost) * HORIZON_YEARS)
        const surplus = to.estimatedYield - carry * GAP_MARGIN
        if (surplus <= 0) continue
        if (!best || surplus > best.surplus) best = { id: toId, surplus, cost, commitment }
      }
      if (!best) continue

      const toId = best.id
      // pay before departing: cash first, then the facility (economy.ts).
      // If the money is not there after all, nobody moves.
      if (!spend(w, agent, best.cost)) continue
      const departed = sim.departAgent(agent.id)
      if (!departed) continue
      const target = this.materialise(toId, 'gate')
      if (!target) continue
      const newId = target.arriveMigrant(
        departed.name,
        departed.strategy as Strategy,
        departed.capital,
        departed.debt,
        departed.peakDebt,
      )
      const migration: RegionMigration = {
        agentId: agent.id,
        fromChunk: fromId,
        toSettlement: toId,
        departedTick: w.tick,
        arrivedTick: target.world.tick,
        // the contract's gap semantics: destination advertisement against the
        // origin market's realised rate. Negative is possible and honest —
        // a holdings-empty agent moves toward an advertisement below a local
        // market it is priced out of.
        offeredGap: (this.summaries.get(toId)?.estimatedYield ?? 0) - from.realisedYield,
        destinationValueTier: this.summaries.get(toId)?.valueTier ?? 'absent',
        reversed: false,
        commitment: best.commitment,
      }
      this.migrations.push(migration)
      this.watching.push({
        migration,
        newAgentId: newId,
        estimateAtCommit: this.summaries.get(toId)?.estimatedYield ?? 0,
        deadlineTick: target.world.tick + REVERSAL_WINDOW_TICKS,
      })
      moved++
    }
  }

  /**
   * §28.1: failed migration is a feature. An arrival whose destination's
   * realised surface undershoots the estimate it committed on — by more than
   * the estimate's own stated spread — writes the bet off and goes home,
   * forfeiting the commitment. The return trip is paid the same way the
   * outbound was (cash, then credit); an arrival that cannot fund the way
   * back is stuck with its bet, which is expensive and correct.
   */
  private reversalPass(): void {
    const still: typeof this.watching = []
    for (const watch of this.watching) {
      const target = this.sims.get(watch.migration.toSettlement)
      const summary = this.summaries.get(watch.migration.toSettlement)
      if (!target || !summary) continue
      const agent = target.world.agents.get(watch.newAgentId)
      if (!agent || agent.diedTick) continue
      if (target.world.tick < watch.deadlineTick) {
        // a bet is written off only after a real attempt: a quarter of the
        // window must pass before disappointment is allowed to decide
        const graceOver =
          target.world.tick >= watch.deadlineTick - Math.floor(REVERSAL_WINDOW_TICKS * 0.75)
        // §44.3: the counterfactual, evaluated once at grace-window end —
        // would this migrant have been better off staying? Recorded whether
        // or not reversal fires, so zero reversals can be told apart from
        // "failure is invisible".
        if (graceOver && watch.migration.belowOriginAtGrace === undefined) {
          const origin = this.summaries.get(watch.migration.fromChunk)
          watch.migration.belowOriginAtGrace =
            origin !== undefined && summary.realisedYield < origin.realisedYield
        }
        const disappointment = watch.estimateAtCommit - summary.realisedYield
        if (
          graceOver &&
          disappointment > watch.estimateAtCommit * 0.45 &&
          agent.holdings.size === 0
        ) {
          const origin = this.sims.get(watch.migration.fromChunk)
          const back = this.transitCost(watch.migration.toSettlement, watch.migration.fromChunk)
          if (origin && spend(target.world, agent, back)) {
            const departed = target.departAgent(watch.newAgentId)
            if (departed) {
              origin.arriveMigrant(
                departed.name,
                departed.strategy as Strategy,
                departed.capital,
                departed.debt,
                departed.peakDebt,
              )
              watch.migration.reversed = true
              continue
            }
          }
        }
        still.push(watch)
      }
    }
    this.watching = still
  }

  /**
   * Drains are detected and counted; the machinery stays unbuilt (§30.5).
   * What is counted is the TRANSITION populated -> empty, so the count is the
   * §30.4 flip count and not "how many passes saw it empty".
   */
  private drainWatch(): void {
    for (const [id, sim] of this.sims) {
      if (this.warmOnly.has(id)) continue
      const alive = [...sim.world.agents.values()].filter((a) => !a.diedTick).length
      const wasAlive = this.lastAlive.get(id)
      if (alive === 0 && (wasAlive === undefined || wasAlive > 0))
        this.drains.set(id, (this.drains.get(id) ?? 0) + 1)
      this.lastAlive.set(id, alive)
    }
  }

  async runToDecisionBudget(total: number): Promise<void> {
    const issued = () => [...this.sims.values()].reduce((s, x) => s + x.decisionsIssued, 0)
    while (issued() < total) {
      for (const [id, sim] of [...this.sims]) {
        if (this.warmOnly.has(id)) continue // loaded, not simulated (§28.3)
        const before = sim.decisionsIssued
        await sim.runToDecisionBudget(before + SLICE_DECISIONS)
        this.decisionsBy.set(id, sim.decisionsIssued)
        // §44.2: sample contest as the chunk crosses its half-budget point
        if (!this.midContest.has(id) && sim.decisionsIssued >= CONTEST_SAMPLE_DECISIONS)
          this.midContest.set(id, fineSummaryOf(sim.world).contest)
      }
      for (const [id] of this.opts.seeds) this.refreshSummary(id)
      this.slice++
      if (this.slice % MIGRATION_EVERY_SLICES === 0) {
        this.warmPass()
        this.migrationPass()
        this.reversalPass()
        this.drainWatch()
      }
    }
  }
}
