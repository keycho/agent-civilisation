import type { ArchetypeId, RoofForm } from '@civ/core'

/**
 * Which entry in the palette's ROOF_TONES a building gets. Baked into the
 * static half of the data texture at load, never changed afterwards unless the
 * building is rebuilt.
 *
 * Roof colour carries more of the day-0 read than wall colour does — from the
 * city camera you are mostly looking at roofs — so this is where the real
 * construction year earns its keep.
 */
export function roofToneFor(
  archetype: ArchetypeId,
  roof: RoofForm,
  year: number,
  areaM2 = 100,
): number {
  if (archetype.startsWith('agent_')) return 4
  if (roof === 'parapet' || roof === 'flat') return 3
  if (roof === 'spire') return 2
  // Clay pantile is a small-span roof. Schiedam's historic warehouses do have
  // it, but a 7,700 m² shed under clay tile reads as a mistake at any zoom.
  if (areaM2 > 600 && (archetype === 'industrial' || archetype === 'warehouse')) return 3
  if (roof === 'sawtooth') return 2
  if (year < 1900) return 0
  if (year < 1945) return year % 3 === 0 ? 1 : 0
  return year % 2 === 0 ? 2 : 1
}

/** Older stock reads warmer. 1650 -> 1, 2000+ -> 0. */
export function eraTint(year: number | undefined): number {
  if (!year) return 0.4
  return Math.max(0, Math.min(1, (2000 - year) / 300))
}

/** Stable per-building facade variation, so a street is not uniform. */
export function jitterFor(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 1000) / 1000
}
