/**
 * Deterministic RNG. The archetype generator, the parcel derivation and the
 * simulation all need per-entity jitter that is stable across runs — a building
 * that shuffles its roof pitch every reload destroys the before/after
 * comparison that the whole product rests on.
 */

export interface Rng {
  (): number
  int(maxExclusive: number): number
  range(lo: number, hi: number): number
  pick<T>(items: readonly T[]): T
  chance(p: number): boolean
}

/** FNV-1a. Turns any stable id into a seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 */
export function makeRng(seed: number | string): Rng {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng = next as Rng
  rng.int = (maxExclusive: number) => Math.floor(next() * maxExclusive)
  rng.range = (lo: number, hi: number) => lo + next() * (hi - lo)
  rng.pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  rng.chance = (p: number) => next() < p
  return rng
}
