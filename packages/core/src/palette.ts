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

/**
 * §63.2: how much of its hue untouched baseline stock loses with NO toggle
 * pressed. `UNTOUCHED_DESATURATION` above is the diff view's setting, reached
 * by holding `d`; this is the world's resting state, because §63.2 asks for
 * diff-by-default expressed through light rather than through a mode. Not the
 * full 0.85 — the world as we left it should still read as a city at night,
 * not as an absence — but far enough that a terracotta roof is grey until
 * somebody buys it.
 */
export const BASELINE_DESATURATION = 0.62

/**
 * §42.1: per-city material base, riding the palette lerp. The cities were
 * reading as the same place — deptford, ourcq and red hook all wore
 * schiedam's terracotta. Each chunk gets a restrained material base: a
 * multiplicative wall tint (value/hue shift, so purpose, jitter, era and
 * condition variation all survive) and a roof pull toward a city target at a
 * stated weight. §15's worldwide coherence holds — one family, shifted, no
 * new art directions. Authored in the §16.1 harness; the identity row keeps
 * schiedam exactly as built. Applied before the divergence lerp, so the diff
 * view stays grey-and-amber everywhere.
 */
export interface CityMaterial {
  /** multiplicative wall tint, authored near 1 */
  wall: [number, number, number]
  /** roof lerp target */
  roofTarget: string
  /** roof lerp weight, 0..1 */
  roofW: number
}

export const CITY_MATERIALS: Record<string, CityMaterial> = {
  // terracotta as built — the identity row
  'schiedam-havens': { wall: [1, 1, 1], roofTarget: '#b07a63', roofW: 0 },
  // london stock brick, yellow-brown, under slate
  'london-deptford': { wall: [1.05, 0.99, 0.84], roofTarget: '#6e7480', roofW: 0.55 },
  // limestone cream under zinc blue-grey
  'paris-ourcq': { wall: [1.07, 1.03, 0.95], roofTarget: '#77808a', roofW: 0.6 },
  // brownstone under dark membrane and tar
  'brooklyn-redhook': { wall: [0.97, 0.87, 0.79], roofTarget: '#4f4a46', roofW: 0.55 },
  // grey tile over wood and plaster
  'tokyo-kyojima': { wall: [0.99, 0.96, 0.9], roofTarget: '#6d7278', roofW: 0.65 },
}

export const CITY_MATERIAL_DEFAULT: CityMaterial = {
  wall: [1, 1, 1],
  roofTarget: '#b07a63',
  roofW: 0,
}

/**
 * §48.4: the ground stops being carpet. Roads drop to a dark asphalt ribbon
 * against a lighter pavement band (the kerb is the value step between them);
 * landcover deepens and varies; water goes darker and works for its keep.
 * The pale pre-§48 values washed the frame out under the golden key.
 */
export const ENVIRONMENT = {
  sky: '#c9d3d8',
  horizon: '#dfe2e0',
  fog: '#cfd6d8',
  ground: '#b2b1a3',
  water: '#5d7a8b',
  waterDeep: '#465f6d',
  grass: '#9daa82',
  park: '#90a375',
  parking: '#9c9b94',
  paving: '#aeaba1',
  /** §48.4: the lighter frontage band carriageways cut through */
  pavement: '#b4afa5',
  roadPrimary: '#7e7a72',
  roadSecondary: '#847f77',
  roadResidential: '#8b867e',
  roadService: '#928d85',
  roadPedestrian: '#a09b93',
  roadAgent: '#9a9184',
  sunWarm: '#fff2dd',
  shadowCool: '#5c6a78',
} as const

/**
 * §47.1: the void around the plate, in the chrome's own palette family. The
 * pale sky-grey backdrop read as a gis viewport; the diorama floats in the
 * terminal's darkness instead — near-black warm greys anchored on the
 * chrome's #0d0c0a, a slight lift overhead so the dark reads as air, the
 * horizon sinking into the page itself. These colour the SURROUND only:
 * backdrop, fog tint and vignette. Nothing here touches the world's lighting
 * or materials (§35.1).
 */
export const VOID = {
  /** faint warm lift straight up — air, not a ceiling */
  skyTop: '#1a1712',
  /** the chrome's own near-black at the horizon, so the plate sits on the page */
  skyBottom: '#0d0c0a',
  /** distance fog sinks into the same dark rather than into white */
  fog: '#131110',
} as const

/**
 * §48.1: light is the identity. One fixed golden hour, forever — a low warm
 * sun against a dusk-blue fill, so lit faces go golden and shade goes cool.
 * That two-temperature read is most of "painterly" on its own, and a fixed
 * beautiful hour beats a cycling mediocre one. Intensities re-balanced for
 * the low angle: the sun brighter (roofs catch less of a low sun), the fill
 * slightly down so the shade genuinely cools instead of washing grey.
 */
export const GOLDEN_HOUR = {
  /** ~3500K feel */
  sun: '#ffd9a3',
  sunIntensity: 4.6,
  /** dusk blue-grey fill from above, warm-neutral bounce from the ground */
  fillSky: '#8fa2bd',
  fillGround: '#8b877b',
  fillIntensity: 2.05,
  coolAmbient: '#4d5d74',
  coolAmbientIntensity: 0.5,
  /** low sun: long raking shadows are the point */
  elevationDeg: 26,
  bearingDefaultDeg: 205,
} as const

/**
 * §48.1: the bearing the light comes FROM, per chunk, in the chunk's own
 * local frame (degrees from +x toward +z in render space) — chosen so the
 * canal or the main street catches the rake. Rotated chunks (§24.2) carry
 * their fabric on the axes, so a near-axial bearing rakes down the primary
 * street; north-cut chunks get a value picked off their dominant frontage.
 */
/**
 * §50.2/§50.3: the authored hour, per city. §48.1 fixed one golden hour
 * globally; character wants five. Each entry is a complete light rig — the
 * §48.1 fields, plus how much of the hour is night.
 *
 * `night` is the weight on §50.3's window light: at schiedam's golden hour it
 * is nearly nothing (lit windows at 5pm are a mistake), at tokyo's blue
 * evening and brooklyn's dusk it is the identity of the frame. `windowWarm`
 * is the colour of the rooms behind the glass.
 *
 * Authored once and fixed forever: these are brand frames, not a day cycle
 * (§15). A chunk with no entry gets GOLDEN_HOUR and no night.
 */
export interface CityHour {
  sun: string
  sunIntensity: number
  fillSky: string
  fillGround: string
  fillIntensity: number
  coolAmbient: string
  coolAmbientIntensity: number
  elevationDeg: number
  /** 0 = full daylight, 1 = the window grid carries the frame */
  night: number
  windowWarm: string
  /**
   * §56.1: the street lamp's own warmth, which is not the window's. Interiors
   * are incandescent-ish and lamps are sodium — keeping them the same colour
   * flattens the street and the building into one light, and the reference's
   * depth comes partly from the fact that they differ. Only consulted where
   * the hour is dusk or darker; the default is a sodium warm.
   */
  lampWarm?: string
  /**
   * §50.2: how much light the ground still gets at this hour, as a
   * multiplier on substrate, road and canopy albedo. At golden hour the
   * raking key models the buildings and they hold their own against a pale
   * plate; after sunset there is no key, ambient light hits everything
   * equally, and the pale ground simply out-albedos the city standing on it —
   * the plate reads as a lit table with dark models on it, the exact inverse
   * of the reference. Dimming the ground at dark hours puts the buildings
   * back on top of their own frame.
   */
  groundScale?: number
  /** the void behind the plate, if this hour wants its own */
  sky?: string
}

/**
 * §63.2: THE INVERSION. Darkness is reality; light is what the agents did.
 *
 * §48.1 fixed one golden hour and §50.2 authored five. The accumulated result
 * was the complaint §63 opens with — a warm diorama with a terminal skin
 * around it, two registers that never become one thing. Golden-hour terracotta
 * says charming dutch town; the thesis is agents taking the earth.
 *
 * So every city's hour is now cold and after dark. The consequence is the
 * point, and it is a lighting change rather than new geometry: with no key
 * light, the only warm thing left in any frame is what the civilization lit —
 * windows in owned stock, worksite glow, construction lights, the diff amber.
 * The city is lit exactly where the civilization is awake. That is
 * diff-by-default expressed as light instead of as a colour toggle.
 *
 * §63.3: per-city identity moves to the COLD half. Each chunk keeps its §42.1
 * character in the temperature of its darkness — paris zinc, london slate,
 * schiedam grey-green, tokyo blue-grey, brooklyn charcoal — while the warm
 * half is identical everywhere, because it is the same civilization.
 *
 * GOLDEN_HOUR is not deleted. §63.2 retires it as the global default and
 * leaves it as an authored per-city hour, so a city that wants it can have it
 * by naming it here.
 */

/**
 * §63.3: the warm half, identical in every city. Interior light behind glass
 * where an agent owns the building. One colour, deliberately — a viewer
 * comparing two cities should see the same civilization in both.
 */
export const AGENT_WARM = '#ffb15c'

/**
 * §63.2: street lighting is INFRASTRUCTURE, not agent activity, so it may not
 * be warm — the whole rule is that warmth means the civilization is awake
 * here. §56.2's lamps stay, in the cold register: mercury-white, which is what
 * a modern street actually is anyway. Stated as a deviation from §56.1, which
 * authored them sodium.
 */
export const INFRASTRUCTURE_COLD = '#c8d4e0'

/** the cold rig a chunk gets when nobody has authored one for it */
export const NIGHT_HOUR: CityHour = {
  sun: '#7d8794',
  sunIntensity: 2.1,
  fillSky: '#63707e',
  fillGround: '#2f353c',
  /**
   * Dark, not absent. The first pass of §63.2 took the fabric down until the
   * plate measured 2% of the frame lit at all, which is not "the world as we
   * left it at night" — it is the world deleted, and a viewer cannot see what
   * the agents are changing if there is nothing to change. These are set so
   * untouched stock reads as cold grey MASS: legible silhouette, no hue, and
   * still an order below the warm light in the same frame.
   */
  fillIntensity: 4.6,
  coolAmbient: '#39414c',
  coolAmbientIntensity: 2.4,
  elevationDeg: 7,
  groundScale: 0.4,
  night: 1.0,
  windowWarm: AGENT_WARM,
  lampWarm: INFRASTRUCTURE_COLD,
}

export const CITY_HOUR: Record<string, CityHour> = {
  /**
   * Schiedam: grey-green. Estuary light with the green of brackish water and
   * wet brick in it — the coldest of the dutch chunks because it is the one
   * on the deep water.
   */
  'schiedam-havens': {
    ...NIGHT_HOUR,
    sun: '#78888a',
    fillSky: '#5f7370',
    fillGround: '#2c3634',
    coolAmbient: '#36443f',
    coolAmbientIntensity: 2.5,
    groundScale: 0.42,
  },

  /**
   * London: slate. Neutral, sootier, the least blue of the five — a cold that
   * is grey rather than a cold that is a colour.
   */
  'london-deptford': {
    ...NIGHT_HOUR,
    sun: '#818790',
    sunIntensity: 2.2,
    fillSky: '#666d74',
    fillGround: '#2f3134',
    fillIntensity: 4.9,
    coolAmbient: '#3b4045',
    elevationDeg: 10,
    groundScale: 0.46,
  },

  /**
   * Paris: zinc. The roofscape is the subject and zinc is what it is made of,
   * so the whole frame takes the roof's own colour after dark.
   */
  'paris-ourcq': {
    ...NIGHT_HOUR,
    sun: '#7f8ea3',
    fillSky: '#69798f',
    fillGround: '#31363f',
    coolAmbient: '#3d4859',
    coolAmbientIntensity: 2.3,
    elevationDeg: 6,
    groundScale: 0.38,
  },

  /**
   * Tokyo: blue-grey. The hour the shitamachi grain was imported for —
   * thousands of small lit boxes close together, against a sky that is still
   * faintly blue. The bluest cold, and the one where the windows carry most.
   */
  'tokyo-kyojima': {
    ...NIGHT_HOUR,
    sun: '#7d90ad',
    sunIntensity: 2.3,
    fillSky: '#5e7391',
    fillGround: '#2d3540',
    fillIntensity: 5.2,
    coolAmbient: '#374558',
    coolAmbientIntensity: 2.6,
    elevationDeg: 8,
    groundScale: 0.36,
  },

  /**
   * Brooklyn: cold charcoal. Almost no hue left — low industrial fabric read
   * as mass and silhouette, with the water taking what little sky remains.
   */
  'brooklyn-redhook': {
    ...NIGHT_HOUR,
    sun: '#787b80',
    sunIntensity: 1.8,
    fillSky: '#5c5f65',
    fillGround: '#2b2c2f',
    coolAmbient: '#36383d',
    coolAmbientIntensity: 2.2,
    elevationDeg: 5,
    groundScale: 0.36,
  },
}

export const SUN_BEARING_DEG: Record<string, number> = {
  'schiedam-havens': 197,
  'london-deptford': 218,
  'brooklyn-redhook': 205,
  'paris-ourcq': 212,
  'tokyo-kyojima': 222,
  'vlaardingen-westwijk': 205,
  'maasland-dorp': 205,
  'maassluis-haven': 200,
}

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
const float BASELINE_DESATURATION = ${BASELINE_DESATURATION.toFixed(3)};
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
