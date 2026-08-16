/**
 * §30.4: the spectacle statistic, pre-registered.
 *
 * "At global view, activity renders as identifiable clusters, and the spatial
 * concentration of change is measurably higher than the single-chunk world's
 * uniform 30.8 percent. Use a plain spatial statistic on the divergence surface
 * (nearest-neighbour or moran's i, pick one and pre-register it) so 'clusters'
 * is a number, not an impression."
 *
 * The pick is Moran's I, and it is made here, before the multi-chunk world
 * exists, with the parameters written down:
 *
 *   variable   per-building divergence weight (DIVERGENCE_WEIGHT of its class)
 *   points     baseline-building centroids, chunk-local metres
 *   weights    inverse distance, cutoff 150 m, no self-pairs
 *   scope      all baseline buildings of all materialised chunks; cross-chunk
 *              pairs sit far past the cutoff in any shared frame, so per-chunk
 *              local coordinates are safe and the statistic decomposes into
 *              within-fabric structure, which is the thing being claimed
 *
 * Moran's I over nearest-neighbour because the claim is about *intensity*
 * clustering (a district half-converted next to another half-converted), not
 * about the point pattern of which buildings exist — the building stock is
 * fixed and inherited, so a point-pattern statistic would mostly measure
 * Schiedam's street grid.
 *
 * Interpretation, pre-registered with it: I near 0 is spatial noise — §29.4's
 * "everywhere, equally". Positive I is concentration. The multi-chunk contract
 * asserts the multi-chunk world's I exceeds the single-chunk baseline measured
 * by this same function at the frozen budget.
 */

export interface MoranPoint {
  x: number
  y: number
  /** the variable — divergence weight 0..1 */
  v: number
}

export const MORAN_CUTOFF_M = 150

export function moransI(points: MoranPoint[]): number {
  const n = points.length
  if (n < 3) return 0
  const mean = points.reduce((s, p) => s + p.v, 0) / n
  let denom = 0
  for (const p of points) denom += (p.v - mean) ** 2
  if (denom === 0) return 0

  /**
   * A uniform grid keeps the pair scan near-linear: with a 150 m cutoff only
   * the 3x3 neighbourhood of a point's cell can hold partners, so the harness
   * can afford this on every seed rather than on a showcase run.
   */
  const cell = MORAN_CUTOFF_M
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`
  points.forEach((p, i) => {
    const k = key(p.x, p.y)
    const arr = grid.get(k)
    if (arr) arr.push(i)
    else grid.set(k, [i])
  })

  let num = 0
  let s0 = 0
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx}:${cy + dy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j === i) continue
          const q = points[j]
          const d = Math.hypot(p.x - q.x, p.y - q.y)
          if (d > MORAN_CUTOFF_M || d === 0) continue
          const w = 1 / d
          num += w * (p.v - mean) * (q.v - mean)
          s0 += w
        }
      }
    }
  }
  if (s0 === 0) return 0
  return (n / s0) * (num / denom)
}
