import type { Building, Parcel, Purpose } from '@civ/core'
import { RATE_WINDOW_TICKS, clamp, clamp01 } from '@civ/core'
import { type Agent, type World, floorArea } from './state.ts'

/**
 * §4. The economy is property, not survival.
 *
 *   capital -> acquire -> improve/convert/redevelop -> yield -> reinvest ->
 *   acquire adjacent
 *
 * Four gradients make clustering rational rather than scripted:
 *   access cost      graph distance to the road network sets usable value
 *   adjacency yield  retail earns on foot traffic from nearby intensity
 *   land value       rises with built intensity within a radius
 *   condition decay  stops the world stabilising at year 6
 *
 * Every constant below is a tuning knob. §4 is explicit that if a district of
 * this size does not reach 30% divergence in 20 years, the constants are wrong
 * rather than the code — so they are gathered here and nowhere else, and
 * test/tune.ts measures them.
 */

export const ECONOMY = {
  /** capital per m² of land at the weakest access and lowest intensity */
  landBase: 0.55,
  /** capital per m² of floor area to build new */
  buildCost: 1.75,
  /** replacement value per m² of floor area at condition 1 */
  replacementValue: 1.35,

  /** rent per m² of floor area per RATE_WINDOW_TICKS */
  rentPerM2: {
    residential: 0.135,
    retail: 0.225,
    commercial: 0.185,
    office: 0.195,
    industrial: 0.085,
    civic: 0.03,
    agricultural: 0.035,
    utility: 0.045,
  } as Record<Purpose, number>,

  /** maintenance per rate window, as a fraction of replacement value */
  maintenanceRate: 0.012,
  /**
   * Condition lost per rate window. §20.2: decay stays per internal tick and
   * the ratio of decay to agent throughput is a model constant, not a
   * spectator control. This is what keeps quiet districts under pressure.
   */
  decayPerWindow: 0.021,
  /** premium a seller extracts over assessed value */
  acquisitionPremium: 0.12,

  /**
   * §23.3: transfer duty, paid by the buyer on top of the price.
   *
   * Build 4 measured 6.77 acquisitions per altered building and a worst case of
   * fifteen trades. That is what a scoring function does when buying is free:
   * there is no penalty for being wrong and no reward for holding, so it churns.
   * Friction is most of what makes real holders hold.
   *
   * Not an invented number. Dutch overdrachtsbelasting on property that is not
   * the buyer's own home is 10.4%, which is the rate that applies to every
   * transaction an agent here makes, in the country this chunk is in.
   */
  transferDuty: 0.104,

  renovateCostPerM2: 0.34,
  convertCostPerM2: 0.55,
  expandCostPerM2: 2.0,
  demolishCostPerM2: 0.3,
  roadCostPerM: 7.5,

  /** starting capital range for a first-generation agent */
  startingCapital: [1400, 4200] as [number, number],

  /**
   * §21.1's capital constraint.
   *
   * Build 2 gave every agent a flat draw per rate window regardless of what it
   * owned or owed, which is an allowance rather than a balance sheet: capital
   * was never the thing that stopped anyone buying. What stops real buyers is
   * credit, and credit is secured against a portfolio and costs interest.
   *
   * So an agent can borrow up to `loanToValue` of what it holds, plus a small
   * unsecured line that lets a first purchase happen at all, and pays
   * `interestPerWindow` on the drawn balance. Buying more requires either
   * income to service it or equity to secure it, which is the rate limit §21.1
   * asks for — and it is what stops site value turning every building into a
   * redevelopment candidate at once.
   *
   * Values are ordinary commercial-property terms rather than fitted numbers:
   * a ~65% LTV against income-producing property at a ~5% cost of debt.
   */
  loanToValue: 0.65,
  interestPerWindow: 0.05,
  /** unsecured line, so an agent holding nothing can still transact */
  seedCredit: 1200,

  /**
   * The yield an income buyer capitalises at, used to convert a rent stream
   * into a price and a redevelopment residual back into a yield (§21.1).
   */
  capRate: 0.06,
  /**
   * Developer's profit and risk, as a share of gross development value. This
   * is §21.1's "risk discount": the standard deduction in a residual land
   * appraisal, not a knob. Without it a site is worth its full theoretical
   * upside and every scheme pencils.
   */
  developmentRisk: 0.17,

  /** radius over which built intensity is felt, metres */
  intensityRadius: 80,
} as const

// ---------------------------------------------------------------------------
// intensity field
// ---------------------------------------------------------------------------

/**
 * Built volume per cell, box-blurred to the intensity radius, plus the same
 * field split by purpose.
 *
 * The per-purpose split is what stops the market degenerating. Retail rent is
 * well above residential, so with a purpose-blind demand model every building
 * in the district converts to retail and the whole run collapses into one
 * divergence class. Local saturation makes the tenth shop on a street worth
 * much less than the first, which is both true and what keeps the mix mixed.
 */
export function recomputeIntensity(world: World): void {
  const cell = world.intensityCell
  const cols = Math.max(1, Math.ceil((world.bounds.maxX - world.bounds.minX) / cell) + 1)
  const rows = Math.max(1, Math.ceil((world.bounds.maxY - world.bounds.minY) / cell) + 1)
  world.intensityCols = cols
  world.intensityRows = rows

  const raw = new Float32Array(cols * rows)
  const byPurpose = new Map<Purpose, Float32Array>()
  const floorTotal = new Float32Array(cols * rows)

  for (const b of world.buildings.values()) {
    if (b.state === 'demolished') continue
    const c = b.footprint.length ? centroidFast(b) : null
    if (!c) continue
    const i = Math.round((c[0] - world.bounds.minX) / cell)
    const j = Math.round((c[1] - world.bounds.minY) / cell)
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue
    const k = j * cols + i
    raw[k] += b.areaM2 * b.heightM
    const fa = b.areaM2 * Math.max(1, b.levels)
    floorTotal[k] += fa
    let arr = byPurpose.get(b.purpose)
    if (!arr) {
      arr = new Float32Array(cols * rows)
      byPurpose.set(b.purpose, arr)
    }
    arr[k] += fa
  }

  const r = Math.max(1, Math.round(ECONOMY.intensityRadius / cell))
  const cellArea = (2 * r + 1) ** 2 * cell * cell
  world.intensity = boxBlur(raw, cols, rows, r, cellArea)
  world.floorTotal = boxBlur(floorTotal, cols, rows, r, 1)
  const blurredByPurpose = new Map<Purpose, Float32Array>()
  for (const [purpose, arr] of byPurpose) {
    blurredByPurpose.set(purpose, boxBlur(arr, cols, rows, r, 1))
  }
  world.floorByPurpose = blurredByPurpose
}

/** Separable box blur, normalised by `divisor` (pass 1 to keep raw sums). */
function boxBlur(
  src: Float32Array,
  cols: number,
  rows: number,
  r: number,
  divisor: number,
): Float32Array {
  const tmp = new Float32Array(cols * rows)
  const out = new Float32Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      for (let d = -r; d <= r; d++) {
        const ii = i + d
        if (ii < 0 || ii >= cols) continue
        s += src[j * cols + ii]
      }
      tmp[j * cols + i] = s
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      for (let d = -r; d <= r; d++) {
        const jj = j + d
        if (jj < 0 || jj >= rows) continue
        s += tmp[jj * cols + i]
      }
      out[j * cols + i] = s / divisor
    }
  }
  return out
}

/** Share of nearby floor area already given over to a purpose, 0..1. */
export function purposeShare(world: World, x: number, y: number, purpose: Purpose): number {
  if (!world.floorTotal || !world.floorByPurpose) return 0
  const cell = world.intensityCell
  const i = Math.round((x - world.bounds.minX) / cell)
  const j = Math.round((y - world.bounds.minY) / cell)
  if (i < 0 || j < 0 || i >= world.intensityCols || j >= world.intensityRows) return 0
  const k = j * world.intensityCols + i
  const total = world.floorTotal[k]
  if (total <= 1) return 0
  return clamp01((world.floorByPurpose.get(purpose)?.[k] ?? 0) / total)
}

/**
 * How much a marginal square metre of a purpose is worth given how much of it
 * is already there. The first shop on a street is valuable; the tenth is not.
 */
export function saturationFactor(share: number, tolerance: number): number {
  return clamp(1.3 - share / Math.max(0.05, tolerance), 0.12, 1.3)
}

function centroidFast(b: Building): [number, number] {
  let x = 0
  let y = 0
  for (const p of b.footprint) {
    x += p[0]
    y += p[1]
  }
  return [x / b.footprint.length, y / b.footprint.length]
}

/** Built volume per m² of ground within the intensity radius. */
export function intensityAt(world: World, x: number, y: number): number {
  if (!world.intensity) return 0
  const cell = world.intensityCell
  const i = Math.round((x - world.bounds.minX) / cell)
  const j = Math.round((y - world.bounds.minY) / cell)
  if (i < 0 || j < 0 || i >= world.intensityCols || j >= world.intensityRows) return 0
  return world.intensity[j * world.intensityCols + i]
}

/** 0..1, where 1 is about as dense as this fabric gets. */
export function normalisedIntensity(world: World, x: number, y: number): number {
  return clamp01(intensityAt(world, x, y) / 9)
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/**
 * §27.5: "price must respond to competition — agents bidding, capital chasing a
 * finite parcel supply. Then the good place gets expensive, yields compress,
 * and the marginal agent finds the cheap town is the better return."
 *
 * These are shipped and verified in the single chunk, before anything
 * multi-region, because pricing is the mechanism migration depends on. If it
 * went in alongside multi-chunk and migration did not happen, there would be no
 * way to tell whether the pricing was wrong or the plumbing was.
 */
export const COMPETITION = {
  /**
   * §29.1: what a fully bid-up locality adds to the price of an asset there.
   *
   * CALIBRATED against the inversion criterion, then frozen. The criterion is
   * a mechanism specification anchored to a real fact: competition bids prime
   * up until prime yields compress below secondary, and that inversion is what
   * pushes capital out of prime markets. The rule, written before any sweep
   * ran: the lowest gain at which contested ground returns less than quiet
   * ground, margin 0.95.
   *
   * The ruler broke twice before the number meant anything, and both breaks
   * are worth keeping:
   *
   *   - ranking transactions by raw competition sorted them by WHEN, not
   *     WHERE — the surface saturates as supply exhausts, so early-vs-late
   *     masqueraded as quiet-vs-contested and "inverted" for the wrong reason.
   *   - transacted returns cannot invert at all while agents are
   *     return-rational: clearing selects on the deal beating the buyer's
   *     alternatives, so the traded sample in a bid-up place is precisely the
   *     survivors. Transaction counts falling with gain (815 -> 531 across the
   *     sweep) is where being priced out is actually visible.
   *
   * So the criterion reads the OFFERED surface — what a marginal buyer would
   * earn on each still-standing building, duty in — at HALF budget, while the
   * market is differentiated rather than terminally saturated. Offered
   * contested/quiet at 40,000 decisions, 2 seeds:
   *
   *   0.85  1.089    upright
   *   1.50  0.873    inverted            <- chosen, the §29.1 state
   *   2.50  1.002    flat (2-seed noise)
   *   6.00  0.672    inverted hard, and transactions thin toward nothing
   *
   * The same value the broken ruler chose, kept for the right reason.
   */
  gain: 1.5,
  /**
   * How fast the price tracks demand, per market step. Deliberately slow.
   * §28.4: "if price responds too fast, capital oscillates between two
   * settlements forever. Damping is a real requirement, not a polish item."
   */
  smoothing: 0.11,
  /** bids per still-available parcel at which the pressure term saturates */
  saturationRatio: 2.5,
  /** share of accumulated demand that survives each market step */
  decay: 0.72,
}

/** §27.5: one agent wanting one parcel here, cleared or priced out. */
export function recordDemand(world: World, x: number, y: number, n = 1): void {
  if (!world.demand) return
  const cell = world.intensityCell
  const i = Math.round((x - world.bounds.minX) / cell)
  const j = Math.round((y - world.bounds.minY) / cell)
  if (i < 0 || j < 0 || i >= world.intensityCols || j >= world.intensityRows) return
  world.demand[j * world.intensityCols + i] += n
}

/** 0..1 — how bid-up this locality is. */
export function competitionAt(world: World, x: number, y: number): number {
  if (!world.competition) return 0
  const cell = world.intensityCell
  const i = Math.round((x - world.bounds.minX) / cell)
  const j = Math.round((y - world.bounds.minY) / cell)
  if (i < 0 || j < 0 || i >= world.intensityCols || j >= world.intensityRows) return 0
  return world.competition[j * world.intensityCols + i]
}

/**
 * Demand against the supply that is still there to buy. A locality where ten
 * agents bid on the last two parcels prices very differently from one where ten
 * agents bid across forty, which is the whole point: scarcity, not popularity.
 *
 * Supply is counted over a 3x3 neighbourhood so a single-parcel cell does not
 * saturate on one bid. Demand decays, so a place that was fought over and then
 * abandoned becomes cheap again — §28.4's "falling prices in an abandoned place
 * should eventually make it attractive again", reachable here without a second
 * chunk.
 */
export function recomputeCompetition(world: World): void {
  const cols = world.intensityCols
  const rows = world.intensityRows
  if (!cols || !rows) return
  if (!world.demand || world.demand.length !== cols * rows) {
    world.demand = new Float32Array(cols * rows)
    world.competition = new Float32Array(cols * rows)
  }

  const supply = new Float32Array(cols * rows)
  const cell = world.intensityCell
  for (const p of world.parcels.values()) {
    // still on the market: nobody owns it, or it is owned but undeveloped
    const standing = p.buildingId ? world.standing(p.buildingId) : undefined
    if (p.ownerId && standing) continue
    if (!p.developable) continue
    const i = Math.round((p.centroid[0] - world.bounds.minX) / cell)
    const j = Math.round((p.centroid[1] - world.bounds.minY) / cell)
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue
    supply[j * cols + i] += 1
  }

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let near = 0
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di
          const b = j + dj
          if (a < 0 || b < 0 || a >= cols || b >= rows) continue
          near += supply[b * cols + a]
        }
      }
      const k = j * cols + i
      const ratio = world.demand[k] / Math.max(1, near)
      const target = clamp01(ratio / COMPETITION.saturationRatio)
      world.competition[k] += (target - world.competition[k]) * COMPETITION.smoothing
      world.demand[k] *= COMPETITION.decay
    }
  }

  // the spatial median over live cells, for time-controlling the transaction
  // record. Cells with no supply and no demand are dead ground, not quiet.
  const live: number[] = []
  for (let k = 0; k < cols * rows; k++) {
    if (supply[k] > 0 || world.demand[k] > 0.01) live.push(world.competition[k])
  }
  live.sort((a, b) => a - b)
  world.competitionMedian = live.length ? live[live.length >> 1] : 0
}

export function landValuePerM2(world: World, p: Parcel): number {
  const access = 0.35 + 0.65 * clamp01(p.accessScore)
  const intensity = 0.45 + 1.35 * normalisedIntensity(world, p.centroid[0], p.centroid[1])
  return ECONOMY.landBase * access * intensity
}

/**
 * §29.1: what competition adds to the price of an asset here.
 *
 * Build 6 put this term on land value and it barely moved the outcome, because
 * land is 17% of what a standing building is worth. Multiplying 17% of the
 * price by up to 1.85 moves the price by 1.14, against a yield gradient of
 * 1.63 — the mechanism was applied to the wrong sixth of the thing being bid
 * for, which is a mechanism fault rather than a constant that wanted turning up.
 *
 * A bidding war is over the asset. Nobody bids for the land component of a
 * building they intend to keep; the split into land and structure is an
 * accounting decomposition, not what changes hands. So the premium goes on the
 * transaction, once, and land value goes back to being the fundamental that
 * §21.1's site value reads.
 */
export function competitionPremium(world: World, x: number, y: number): number {
  return 1 + COMPETITION.gain * competitionAt(world, x, y)
}

export function recomputeLandValues(world: World): void {
  for (const p of world.parcels.values()) {
    p.landValue = landValuePerM2(world, p)
  }
}

export function parcelPrice(world: World, p: Parcel): number {
  const bid = competitionPremium(world, p.centroid[0], p.centroid[1])
  return p.landValue * p.areaM2 * (1 + ECONOMY.acquisitionPremium) * bid
}

export function buildingValue(world: World, b: Building): number {
  const parcel = world.parcelOf(b)
  const land = parcel ? parcel.landValue * parcel.areaM2 : b.areaM2 * ECONOMY.landBase
  const structure = floorArea(b) * ECONOMY.replacementValue * clamp(b.condition, 0.15, 1)
  return land + structure
}

/**
 * §42.2: a landmark trades at a premium and converts at a multiple — real
 * heritage economics without blanket protection. The numbers are stated here
 * once: acquiring costs 2.2x, converting costs 3x the ordinary rate. A church
 * that still becomes a workshop earned its high-weight feed event.
 */
export const LANDMARK_PRICE_MULT = 2.2
export const LANDMARK_CONVERT_MULT = 3

export function acquisitionPrice(world: World, b: Building): number {
  const c = centroidFast(b)
  return (
    buildingValue(world, b) *
    (1 + ECONOMY.acquisitionPremium) *
    competitionPremium(world, c[0], c[1]) *
    (b.landmark ? LANDMARK_PRICE_MULT : 1)
  )
}

/**
 * §23.2: what it costs to take a parcel, including whatever stands on it.
 *
 * `assemble` could only ever gather vacant land, which made §4's "consolidate
 * adjacent lots and redevelop at higher intensity" structurally unbuildable —
 * assemble -> demolish -> develop measured exactly 0, not merely rare. Buying
 * the standing buildings is what the real transaction is, and it is a large
 * capital gate that is probably self-limiting without any extra rule.
 */
export function parcelTakeoverPrice(world: World, p: Parcel): number {
  const land = parcelPrice(world, p)
  const b = p.buildingId ? world.buildings.get(p.buildingId) : undefined
  const standing = b && b.state !== 'demolished' ? acquisitionPrice(world, b) : 0
  return land + standing
}

/** §23.3: what a purchase actually costs, duty included. */
export function withDuty(price: number): number {
  return price * (1 + ECONOMY.transferDuty)
}

/** A rent stream expressed as a price, at the market's capitalisation rate. */
export function capitalise(perTick: number): number {
  return (perTick * RATE_WINDOW_TICKS) / ECONOMY.capRate
}

// ---------------------------------------------------------------------------
// §21.1 credit
// ---------------------------------------------------------------------------

/** Property only. Cash is not collateral and debt is netted off separately. */
export function portfolioValue(world: World, agent: Agent): number {
  let sum = 0
  for (const id of agent.holdings) {
    const b = world.standing(id)
    if (b) sum += buildingValue(world, b)
  }
  for (const id of agent.parcels) {
    const p = world.parcels.get(id)
    if (p && !p.buildingId) sum += p.landValue * p.areaM2
  }
  return sum
}

export function creditLimit(world: World, agent: Agent): number {
  return ECONOMY.seedCredit + ECONOMY.loanToValue * portfolioValue(world, agent)
}

export function creditHeadroom(world: World, agent: Agent): number {
  return Math.max(0, creditLimit(world, agent) - agent.debt)
}

/**
 * What an agent can actually commit: cash plus undrawn credit. Every
 * affordability test in the engine and every one in `actions.ts` reads this
 * rather than the cash balance, so the constraint binds in one place.
 */
export function availableFunds(world: World, agent: Agent): number {
  return agent.capital + creditHeadroom(world, agent)
}

/** Draw on the facility, tracking the high-water mark. */
export function borrow(agent: Agent, amount: number): void {
  agent.debt += amount
  if (agent.debt > agent.peakDebt) agent.peakDebt = agent.debt
}

/** Cash first, then the facility. Returns false if the money is not there. */
export function spend(world: World, agent: Agent, amount: number): boolean {
  if (amount <= agent.capital) {
    agent.capital -= amount
    return true
  }
  const draw = amount - agent.capital
  if (draw > creditHeadroom(world, agent)) return false
  agent.capital = 0
  borrow(agent, draw)
  return true
}

/**
 * Proceeds retire debt before they become spendable cash. Without this a sale
 * hands the seller a lump sum it immediately redeploys, which is how build 1
 * produced 28,000 acquisitions that changed nothing.
 */
export function receive(agent: Agent, amount: number): void {
  const repay = Math.min(agent.debt, amount)
  agent.debt -= repay
  agent.capital += amount - repay
}

/**
 * §4's adjacency yield. Converted retail earns on foot traffic from nearby
 * residential intensity — intensity begets intensity, which is what makes a
 * cluster worth more than the same buildings scattered.
 */
/** How much of a district can plausibly be given over to each purpose. */
const SATURATION_TOLERANCE: Record<Purpose, number> = {
  retail: 0.22,
  office: 0.25,
  commercial: 0.25,
  residential: 0.8,
  industrial: 0.3,
  civic: 0.2,
  agricultural: 0.3,
  utility: 0.2,
}

export function demandFactor(world: World, b: Building): number {
  const c = centroidFast(b)
  const intensity = normalisedIntensity(world, c[0], c[1])
  const parcel = world.parcelOf(b)
  const access = parcel ? clamp01(parcel.accessScore) : 0.4
  const saturation = saturationFactor(
    purposeShare(world, c[0], c[1], b.purpose),
    SATURATION_TOLERANCE[b.purpose] ?? 0.3,
  )

  let base: number
  switch (b.purpose) {
    case 'retail':
      // §4's adjacency yield: retail earns on foot traffic from nearby
      // residential intensity, and is then divided by how much retail is
      // already competing for it.
      base = 0.35 + 1.5 * intensity + 0.35 * access
      break
    case 'commercial':
    case 'office':
      base = 0.5 + 0.95 * intensity + 0.4 * access
      break
    case 'residential':
      base = 0.72 + 0.5 * intensity + 0.3 * access
      break
    case 'industrial':
      // industry wants access, not neighbours
      base = 0.75 + 0.55 * access - 0.25 * intensity
      break
    default:
      base = 0.6 + 0.3 * access
  }
  return Math.max(0.05, base * saturation)
}

export function yieldPerTick(world: World, b: Building): number {
  if (b.state !== 'standing') return 0
  const rent = ECONOMY.rentPerM2[b.purpose] ?? 0.1
  const gross = floorArea(b) * rent * clamp(b.condition, 0.1, 1) * demandFactor(world, b)
  const maintenance = floorArea(b) * ECONOMY.replacementValue * ECONOMY.maintenanceRate
  return (gross - maintenance) / RATE_WINDOW_TICKS
}

export function recomputeYields(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.state === 'demolished') continue
    b.yieldPerTick = yieldPerTick(world, b)
  }
}

/** What an agent would gain per tick by restoring a building to condition 1. */
export function renovationUplift(world: World, b: Building): number {
  const before = yieldPerTick(world, b)
  const after = yieldPerTick(world, { ...b, condition: 1 })
  return after - before
}

export function renovationCost(b: Building): number {
  return floorArea(b) * ECONOMY.renovateCostPerM2 * (1 - clamp01(b.condition))
}

export function conversionCost(b: Building): number {
  return floorArea(b) * ECONOMY.convertCostPerM2 * (b.landmark ? LANDMARK_CONVERT_MULT : 1)
}

export function demolitionCost(b: Building): number {
  return b.areaM2 * ECONOMY.demolishCostPerM2
}

export function developmentCost(footprintM2: number, levels: number): number {
  return footprintM2 * levels * ECONOMY.buildCost
}

export function expansionCost(b: Building, addLevels: number): number {
  return b.areaM2 * addLevels * ECONOMY.expandCostPerM2
}

/**
 * Simple payback test used by every improvement decision: how many rate
 * windows of net yield are needed to repay the cost. Agents accept different
 * thresholds by strategy, which is most of what makes them behave differently.
 */
export function paybackWindows(cost: number, upliftPerTick: number): number {
  if (upliftPerTick <= 0) return Infinity
  return cost / (upliftPerTick * RATE_WINDOW_TICKS)
}

export function decayStep(world: World, ticks: number): void {
  const d = (ECONOMY.decayPerWindow * ticks) / RATE_WINDOW_TICKS
  for (const b of world.buildings.values()) {
    if (b.state !== 'standing') continue
    b.condition = Math.max(0.05, b.condition - d)
  }
}
