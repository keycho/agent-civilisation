import type { BuildingState } from './types.ts'

/**
 * §16.5. The six construction stages of §15 map onto a single `progress`
 * float. These thresholds are shared by whoever advances the simulation and
 * whoever draws it, so there is no client-side animation state to drift.
 *
 *   0.00 - 0.10   site marked, boundary decal on the parcel
 *   0.10 - 0.25   scaffolding / frame blended in
 *   0.25 - 0.85   mass grows, vertical reveal rises
 *   0.85 - 1.00   scaffolding fades, facade treatment applies
 *   1.00          complete, joins the standing batch
 */
export const STAGE = {
  siteMarked: 0.0,
  scaffoldStart: 0.1,
  massStart: 0.25,
  facadeStart: 0.85,
  complete: 1.0,
} as const

/** 0 before the frame appears, 1 once it is fully up, fading out at the end. */
export function scaffoldOpacity(progress: number): number {
  if (progress < STAGE.scaffoldStart) return 0
  if (progress < STAGE.massStart) {
    return (progress - STAGE.scaffoldStart) / (STAGE.massStart - STAGE.scaffoldStart)
  }
  if (progress < STAGE.facadeStart) return 1
  return 1 - (progress - STAGE.facadeStart) / (STAGE.complete - STAGE.facadeStart)
}

/** How much of the mass is out of the ground, 0..1. */
export function massReveal(progress: number): number {
  if (progress <= STAGE.massStart) return 0
  if (progress >= STAGE.facadeStart) return 1
  return (progress - STAGE.massStart) / (STAGE.facadeStart - STAGE.massStart)
}

/** 0 while the facade is still raw, 1 once the treatment has been applied. */
export function facadeBlend(progress: number): number {
  if (progress < STAGE.facadeStart) return 0
  return (progress - STAGE.facadeStart) / (STAGE.complete - STAGE.facadeStart)
}

export function siteMarkOpacity(progress: number): number {
  if (progress >= STAGE.massStart) return Math.max(0, 1 - (progress - STAGE.massStart) * 4)
  return Math.min(1, progress / Math.max(1e-4, STAGE.scaffoldStart))
}

/**
 * Ticks a build takes. 200-600, so that construction reads as a smooth rise
 * over several seconds at normal throughput rather than a pop.
 */
export function constructionDuration(volumeM3: number, isDemolition = false): number {
  const base = 200 + Math.min(400, Math.sqrt(Math.max(1, volumeM3)) * 5.5)
  return Math.round(isDemolition ? base * 0.45 : base)
}

export function isTransitioning(state: BuildingState): boolean {
  return state === 'under_construction' || state === 'under_demolition'
}
