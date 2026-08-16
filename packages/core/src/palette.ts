import { DIVERGENCE_WEIGHT, PURPOSE_INDEX, type Purpose } from './types.ts'

/**
 * §15/§16.4. One palette, art-directed, not GIS convention.
 *
 * Divergence is NOT a second colour scheme. It is a per-building saturation and
 * value move driven by the divergence channel already in the data texture, so
 * there is one set of colours to art-direct and the mode transition animates
 * instead of hard-cutting.
 *
 * These numbers are the single source of truth: the shader, the legend and the
 * archetype preview harness all read them from here.
 */

export type RGB = [number, number, number]

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

export function rgbToHex(c: RGB): string {
  const b = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${b(c[0])}${b(c[1])}${b(c[2])}`
}

/**
 * Wall tones. Deliberately all in one warm-grey family — purpose shifts the
 * hue a few degrees and the value a few percent, nothing more. A city where
 * industry is purple and retail is orange is a thematic map, not a place.
 */
export const PURPOSE_COLOR: Record<Purpose, string> = {
  residential: '#c3b2a1',
  retail: '#d0bca5',
  commercial: '#bab5ac',
  office: '#aeb3b7',
  industrial: '#a9a6a1',
  civic: '#d2cab8',
  agricultural: '#bdaf96',
  utility: '#a4a39f',
}

/** Indexed by PURPOSE_INDEX, for the palette lookup in the shader. */
export const PURPOSE_COLORS_ORDERED: RGB[] = (() => {
  const out: RGB[] = new Array(8).fill(null).map(() => [0, 0, 0] as RGB)
  for (const [p, i] of Object.entries(PURPOSE_INDEX)) {
    out[i] = hexToRgb(PURPOSE_COLOR[p as Purpose])
  }
  return out
})()

/** Roof tones, selected per building at import from archetype and era. */
export const ROOF_TONES: RGB[] = [
  hexToRgb('#b07a63'), // 0 clay tile — pre-war pitched
  hexToRgb('#98827a'), // 1 weathered tile
  hexToRgb('#868a8e'), // 2 slate
  hexToRgb('#9a9c9e'), // 3 modern flat / membrane
  hexToRgb('#aeb1b4'), // 4 agent-built flat — cleaner, cooler
]

export const GROUND_FLOOR_DARKEN = 0.88
export const TRIM_LIGHTEN = 1.07

/**
 * Divergence targets (§8 classes). Untouched has no target — in divergence
 * mode it desaturates toward the neutral below, which is the "grey reality"
 * half of the effect §15 asks for.
 *
 * §39: the fork's work is amber, one accent family across world and chrome —
 * one constant in the lerp, not seven hues. Class identity survives through
 * DIVERGENCE_WEIGHT, which ramps the lerp from faint (owned, 0.15) to full
 * (replaced and agent origin, 1.0); what class a building is stays an
 * inspector fact, and the diff view carries the thesis: grey is ours, amber
 * is theirs.
 */
const FORK_AMBER = '#e2a54f'
export const DIVERGENCE_COLOR: string[] = [
  '#8f8d8a', // 0 untouched (neutral target)
  FORK_AMBER, // 1 owned
  FORK_AMBER, // 2 renovated
  FORK_AMBER, // 3 converted
  FORK_AMBER, // 4 expanded
  FORK_AMBER, // 5 cleared
  FORK_AMBER, // 6 replaced
  FORK_AMBER, // 7 agent origin
]

export const DIVERGENCE_COLORS_RGB: RGB[] = DIVERGENCE_COLOR.map(hexToRgb)

/** How grey an untouched building goes at full divergence mode. */
export const UNTOUCHED_DESATURATION = 0.85

export const ENVIRONMENT = {
  sky: '#c9d3d8',
  horizon: '#dfe2e0',
  fog: '#cfd6d8',
  ground: '#bcbdb1',
  water: '#7f97a3',
  waterDeep: '#5d7683',
  grass: '#a8b394',
  park: '#9db088',
  parking: '#a5a49f',
  paving: '#bab7b0',
  roadPrimary: '#a09c95',
  roadSecondary: '#a5a19a',
  roadResidential: '#aaa69f',
  roadService: '#aeaaa3',
  roadPedestrian: '#b6b2ab',
  roadAgent: '#b9b2a4',
  sunWarm: '#fff2dd',
  shadowCool: '#5c6a78',
} as const

/**
 * The one place the palette crosses into GLSL. Emitting it rather than
 * duplicating it by hand is what keeps §16.4's "one palette" true.
 */
/**
 * The palette above is authored in sRGB, the way a designer picks colours. The
 * renderer's working space is linear, so handing those numbers straight to the
 * shader would render every colour lighter and flatter than it was chosen to
 * be. Converting here — once, at the boundary — is what keeps "one palette"
 * from quietly meaning "two".
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function paletteGlsl(): string {
  const vec3 = (c: RGB) =>
    `vec3(${c.map((v) => srgbToLinear(v).toFixed(4)).join(',')})`
  return `
const vec3 PURPOSE_COLORS[8] = vec3[8](${PURPOSE_COLORS_ORDERED.map(vec3).join(',')});
const vec3 DIVERGENCE_COLORS[8] = vec3[8](${DIVERGENCE_COLORS_RGB.map(vec3).join(',')});
const vec3 ROOF_TONES[5] = vec3[5](${ROOF_TONES.map(vec3).join(',')});
const float DIVERGENCE_WEIGHTS[8] = float[8](${Array.from({ length: 8 }, (_, i) => DIVERGENCE_WEIGHT[i].toFixed(3)).join(',')});
const float UNTOUCHED_DESATURATION = ${UNTOUCHED_DESATURATION.toFixed(3)};
const float GROUND_FLOOR_DARKEN = ${GROUND_FLOOR_DARKEN.toFixed(3)};
const float TRIM_LIGHTEN = ${TRIM_LIGHTEN.toFixed(3)};
`
}

/** CPU-side twin of the shader's colour resolve, for legends and the inspector. */
export function resolveColor(
  purpose: Purpose,
  divergenceClass: number,
  mode: number,
  condition = 1,
): RGB {
  const base = hexToRgb(PURPOSE_COLOR[purpose])
  const w = DIVERGENCE_WEIGHT[divergenceClass] ?? 0
  const target = DIVERGENCE_COLORS_RGB[divergenceClass] ?? DIVERGENCE_COLORS_RGB[0]
  const out: RGB = [0, 0, 0]
  const lum = base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114
  for (let i = 0; i < 3; i++) {
    // untouched stock desaturates as the mode comes up
    const grey = base[i] + (lum - base[i]) * UNTOUCHED_DESATURATION
    const dulled = base[i] + (grey - base[i]) * mode * (1 - w)
    out[i] = dulled + (target[i] - dulled) * mode * w
    // condition darkens and dulls, the same move the shader makes
    out[i] *= 0.78 + 0.22 * condition
  }
  return out
}
