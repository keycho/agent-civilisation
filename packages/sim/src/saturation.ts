/**
 * §22.3: when the reachable stock is used up.
 *
 * The same rule serves two jobs that must not be confused with each other.
 *
 *   tune.ts     runs to a *fixed* decision budget so twenty seeds are
 *               comparable. 65,000 is that rule's answer, measured once and
 *               frozen — a measurement device.
 *   the world   has no budget. It runs until this rule says the world has
 *               stopped changing, and then a season ends.
 *
 * Conflating them would give the shared world a hard ending nobody was told
 * about, which is exactly what §22.3 warns against. Defining the rule once and
 * applying it two ways is the relationship that keeps them separate: the budget
 * is derived from the rule, it does not govern the world.
 */

export const SATURATION = {
  /** decisions over which the gains below are measured */
  windowDecisions: 5_000,
  /** percentage points of divergence index */
  indexGain: 0.01,
  /** growth in agent-built and cleared counts */
  stockGrowth: 0.05,
  /**
   * A floor, so a world that is briefly quiet early — every agent saving for a
   * first purchase — is not mistaken for a finished one.
   */
  minimumDecisions: 20_000,
} as const

export interface SaturationSample {
  decisions: number
  index: number
  agentOrigin: number
  cleared: number
}

/**
 * Streaming form of the plateau `calibrate.ts` reads off a finished curve.
 * Keeps only what the window needs.
 */
export class SaturationWatch {
  private samples: SaturationSample[] = []

  /** Returns true once the world has stopped changing materially. */
  sample(s: SaturationSample): boolean {
    this.samples.push(s)
    // drop anything older than the window plus one, so `oldest` straddles it
    while (
      this.samples.length > 2 &&
      s.decisions - this.samples[1].decisions >= SATURATION.windowDecisions
    ) {
      this.samples.shift()
    }
    if (s.decisions < SATURATION.minimumDecisions) return false

    const oldest = this.samples[0]
    if (s.decisions - oldest.decisions < SATURATION.windowDecisions) return false

    const grew = (a: number, b: number) => (b - a) / Math.max(1, a)
    return (
      s.index - oldest.index < SATURATION.indexGain &&
      grew(oldest.agentOrigin, s.agentOrigin) < SATURATION.stockGrowth &&
      grew(oldest.cleared, s.cleared) < SATURATION.stockGrowth
    )
  }

  reset(): void {
    this.samples = []
  }
}
