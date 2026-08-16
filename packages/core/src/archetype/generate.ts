import type { ArchetypeId, Ring } from '../types.ts'
import { type FootprintMetrics, insetRing, outsetRing } from '../geo/polygon.ts'
import { makeRng } from '../rng.ts'
import {
  MassBuilder,
  type MeshData,
  ROLE_GROUND_FLOOR,
  ROLE_ROOF,
  ROLE_TRIM,
  ROLE_WALL,
  gableRoof,
  obbPoint,
  obbRing,
  sawtoothRoof,
  spire,
  steppedGableEnd,
} from './mass.ts'
import { type ArchetypeInput, type RoofForm, selectArchetype, selectRoof } from './select.ts'

export interface ArchetypeOutput {
  archetype: ArchetypeId
  roof: RoofForm
  reason: string
  mesh: MeshData
  metrics: FootprintMetrics
}

const GROUND_FLOOR_H = 3.3

/**
 * §16.1. A building's visual form is generated, not authored and not imported.
 *
 * The real footprint is preserved exactly — it is the wall line, always. What
 * is invented is everything above it: roof form, floor banding, setbacks,
 * plinths and silhouette elements. That split is what lets the city stay a
 * real place while looking nothing like a GIS extrusion.
 */
export function generateArchetype(
  input: ArchetypeInput,
  seedKey: string,
  /** the preview harness pins a form so every archetype can be compared side by side */
  override?: ArchetypeId,
): ArchetypeOutput {
  const selected = selectArchetype(input)
  const choice = override ? { ...selected, archetype: override, reason: `forced: ${override}` } : selected
  const m = choice.metrics
  const year = input.constructionYear ?? 1900
  const roof = selectRoof(choice.archetype, m, input.roofHint, year)
  const rng = makeRng(seedKey)
  const levels = input.levels > 0 ? input.levels : Math.max(1, Math.round(input.heightM / 3.2))
  const b = new MassBuilder()

  const ctx: FormCtx = {
    b,
    ring: input.footprint,
    h: Math.max(2.2, input.heightM),
    levels,
    metrics: m,
    roof,
    year,
    rng: rng,
  }

  switch (choice.archetype) {
    case 'rowhouse':
      rowhouse(ctx)
      break
    case 'apartment':
      apartment(ctx)
      break
    case 'warehouse':
      warehouse(ctx)
      break
    case 'industrial':
      industrial(ctx)
      break
    case 'civic':
      civic(ctx)
      break
    case 'retail':
      retail(ctx)
      break
    case 'tower':
      tower(ctx)
      break
    case 'agricultural':
      agricultural(ctx)
      break
    case 'brownstone_row':
      brownstoneRow(ctx)
      break
    case 'setback_industrial':
      setbackIndustrial(ctx)
      break
    case 'agent_block':
      agentBlock(ctx)
      break
    case 'agent_slab':
      agentSlab(ctx)
      break
    case 'agent_tower':
      agentTower(ctx)
      break
    case 'agent_hall':
      agentHall(ctx)
      break
  }

  return {
    archetype: choice.archetype,
    roof,
    reason: choice.reason,
    mesh: b.build(),
    metrics: m,
  }
}

interface FormCtx {
  b: MassBuilder
  ring: Ring
  h: number
  levels: number
  metrics: FootprintMetrics
  roof: RoofForm
  year: number
  rng: ReturnType<typeof makeRng>
}

// ---------------------------------------------------------------------------
// shared elements
// ---------------------------------------------------------------------------

/** Wall from 0 to `top`, with the ground floor marked so the shader can tint it. */
function walls(b: MassBuilder, ring: Ring, top: number, groundH = GROUND_FLOOR_H): void {
  const g = Math.min(groundH, top * 0.85)
  b.wallBand(ring, 0, g, ROLE_GROUND_FLOOR)
  if (top > g) b.wallBand(ring, g, top, ROLE_WALL)
}

/**
 * Protruding floor lines. §15 asks for simplified windows — this is the
 * substitute: at city scale a horizontal band reads as storeys far more
 * cleanly than any window texture, and it survives being 12 pixels tall.
 */
function floorBands(
  b: MassBuilder,
  ring: Ring,
  fromH: number,
  toH: number,
  levels: number,
  protrusion: number,
  thickness = 0.1,
): void {
  if (levels < 2 || levels > 14) return
  const band = outsetRing(ring, protrusion)
  if (!band) return
  const span = toH - fromH
  if (span <= 0) return
  const step = span / levels
  for (let i = 1; i < levels; i++) {
    const z = fromH + step * i
    b.wallBand(band, z - thickness, z + thickness, ROLE_TRIM)
    b.cap(band, z + thickness, ROLE_TRIM)
    b.cap(band, z - thickness, ROLE_TRIM, false)
  }
}

/** Flat roof with a raised rim. The default for anything modern or agent-built. */
function parapet(b: MassBuilder, ring: Ring, topH: number, rimH = 0.85, thickness = 0.4): void {
  const deck = topH - rimH
  const inner = insetRing(ring, thickness)
  if (!inner) {
    b.cap(ring, topH, ROLE_ROOF)
    return
  }
  b.cap(inner, deck, ROLE_ROOF)
  b.wallBand(ring, deck, topH, ROLE_TRIM)
  b.wallBand(inner, deck, topH, ROLE_TRIM, true)
  b.capWithHole(ring, inner, topH, ROLE_TRIM)
}

/** Eaves overhang expressed as a cornice ring just under the roof. */
function cornice(b: MassBuilder, ring: Ring, atH: number, out = 0.3, thick = 0.3): void {
  const r = outsetRing(ring, out)
  if (!r) return
  b.wallBand(r, atH - thick, atH + thick, ROLE_TRIM)
  b.cap(r, atH + thick, ROLE_TRIM)
  b.cap(r, atH - thick, ROLE_TRIM, false)
}

function pitchedTop(ctx: FormCtx, eavesH: number, rise: number, form: RoofForm): void {
  const { b, metrics } = ctx
  switch (form) {
    case 'gable':
      gableRoof(b, metrics.obb, eavesH, rise, 0.35)
      break
    case 'stepped_gable':
      gableRoof(b, metrics.obb, eavesH, rise, 0.1)
      steppedGableEnd(b, metrics.obb, true, eavesH, rise, 4)
      steppedGableEnd(b, metrics.obb, false, eavesH, rise, 4)
      break
    case 'hip':
      gableRoof(b, metrics.obb, eavesH, rise, 0.4, 0.32)
      break
    case 'barn':
      gableRoof(b, metrics.obb, eavesH, rise, 0.6, 0.08)
      break
    case 'shallow':
      gableRoof(b, metrics.obb, eavesH, Math.min(rise, 1.1), 0.25, 0.45)
      break
    default:
      b.cap(ctx.ring, eavesH + rise, ROLE_ROOF)
  }
}

// ---------------------------------------------------------------------------
// inherited fabric
// ---------------------------------------------------------------------------

function rowhouse(ctx: FormCtx): void {
  const { b, ring, h, metrics, roof } = ctx
  if (roof === 'parapet') {
    walls(b, ring, h)
    cornice(b, ring, h - 1.1)
    parapet(b, ring, h, 0.7, 0.35)
    return
  }
  // Narrow and deep with the ridge along the long axis: the gable faces the
  // street, which is what makes a Dutch row read as a row.
  const rise = Math.min(h * 0.5, Math.max(1.7, metrics.obb.width * 0.44))
  const eaves = Math.max(2.2, h - rise)
  walls(b, ring, eaves)
  cornice(b, ring, eaves - 0.15, 0.22, 0.18)
  pitchedTop(ctx, eaves, rise, roof)
}

function apartment(ctx: FormCtx): void {
  const { b, ring, h, levels, roof } = ctx
  if (roof === 'hip') {
    const rise = Math.min(h * 0.28, 3.0)
    const eaves = h - rise
    walls(b, ring, eaves)
    floorBands(b, ring, GROUND_FLOOR_H, eaves, levels, 0.07)
    cornice(b, ring, eaves - 0.2, 0.35, 0.25)
    pitchedTop(ctx, eaves, rise, 'hip')
    return
  }
  walls(b, ring, h)
  floorBands(b, ring, GROUND_FLOOR_H, h - 0.9, levels, 0.07)
  parapet(b, ring, h, 0.9, 0.4)
}

function warehouse(ctx: FormCtx): void {
  const { b, ring, h, metrics, roof, levels } = ctx
  if (roof === 'sawtooth') {
    const eaves = h - Math.min(2.6, h * 0.22)
    walls(b, ring, eaves)
    sawtoothRoof(b, metrics.obb, eaves, h - eaves, Math.max(2, Math.round(metrics.obb.length / 11)))
    return
  }
  if (roof === 'parapet') {
    walls(b, ring, h)
    floorBands(b, ring, GROUND_FLOOR_H, h - 1, Math.min(levels, 6), 0.09, 0.12)
    cornice(b, ring, h - 1.3, 0.35, 0.3)
    parapet(b, ring, h, 0.8, 0.4)
    return
  }
  const rise = Math.min(h * 0.34, Math.max(1.6, metrics.obb.width * 0.24))
  const eaves = Math.max(2.4, h - rise)
  walls(b, ring, eaves, 4.2)
  // Warehouse floor lines sit further apart and read heavier than a dwelling's.
  floorBands(b, ring, 4.2, eaves, Math.min(levels, 6), 0.1, 0.13)
  cornice(b, ring, eaves - 0.2, 0.4, 0.3)
  pitchedTop(ctx, eaves, rise, roof)
}

function industrial(ctx: FormCtx): void {
  const { b, ring, h, metrics, roof, rng } = ctx
  if (roof === 'sawtooth') {
    const eaves = h - Math.min(3.2, h * 0.3)
    walls(b, ring, eaves, 4.5)
    sawtoothRoof(b, metrics.obb, eaves, h - eaves, Math.max(2, Math.round(metrics.obb.length / 14)))
    return
  }
  const rise = Math.min(h * 0.22, 2.0)
  const eaves = Math.max(2.6, h - rise)
  walls(b, ring, eaves, 4.5)
  if (roof === 'flat') {
    parapet(b, ring, h, 0.7, 0.45)
  } else {
    pitchedTop(ctx, eaves, rise, 'shallow')
  }
  // Roof plant: irregular massing is what separates industrial from warehouse.
  const vents = 1 + rng.int(3)
  for (let i = 0; i < vents; i++) {
    const u = (rng() - 0.5) * metrics.obb.length * 0.6
    const v = (rng() - 0.5) * metrics.obb.width * 0.5
    const s = 1.2 + rng() * 2.2
    const c = obbPoint(metrics.obb, u, v)
    const box: Ring = [
      [c[0] - s, c[1] - s],
      [c[0] + s, c[1] - s],
      [c[0] + s, c[1] + s],
      [c[0] - s, c[1] + s],
    ]
    b.prism(box, h - 0.2, h + 1.0 + rng() * 1.8, ROLE_TRIM, ROLE_TRIM)
  }
}

function civic(ctx: FormCtx): void {
  const { b, ring, h, metrics } = ctx
  // Nave plus a tall narrow element. The tower carries the silhouette; the
  // body is deliberately plain so the tower still reads at 20 pixels.
  //
  // BAG's height is the dominant roof plane, which for a church is the nave,
  // not the tower — so the tower is built as a multiple of it rather than
  // clamped to it. A tower level with its own nave reads as a shed.
  const naveH = h * 0.66
  const rise = Math.min(naveH * 0.6, metrics.obb.width * 0.45)
  const eaves = Math.max(2.5, naveH - rise)
  walls(b, ring, eaves, 4.5)
  pitchedTop(ctx, eaves, rise, 'gable')

  const side = Math.max(4.5, Math.min(metrics.obb.width * 0.78, 12))
  const at = metrics.obb.length / 2 - side * 0.5
  const c = obbPoint(metrics.obb, -at, 0)
  const towerRing: Ring = [
    [c[0] - side / 2, c[1] - side / 2],
    [c[0] + side / 2, c[1] - side / 2],
    [c[0] + side / 2, c[1] + side / 2],
    [c[0] - side / 2, c[1] + side / 2],
  ]
  const towerH = h * 1.55
  b.wallBand(towerRing, 0, towerH, ROLE_WALL)
  // a belfry stage, set in slightly, then the spire
  cornice(b, towerRing, towerH - side * 0.55, 0.3, 0.25)
  const belfry = insetRing(towerRing, side * 0.1) ?? towerRing
  b.capWithHole(towerRing, belfry, towerH, ROLE_TRIM)
  spire(b, belfry, towerH, Math.max(5, h * 0.85))
}

function retail(ctx: FormCtx): void {
  const { b, ring, h, levels } = ctx
  // Articulated ground floor, plain above (§16.1): the shopfront is recessed
  // so the upper mass casts a shadow onto it.
  const shop = insetRing(ring, 0.55)
  const g = Math.min(GROUND_FLOOR_H + 0.4, h * 0.8)
  if (shop) {
    b.wallBand(shop, 0, g, ROLE_GROUND_FLOOR)
    b.cap(shop, g, ROLE_TRIM)
  } else {
    b.wallBand(ring, 0, g, ROLE_GROUND_FLOOR)
  }
  if (h > g) {
    b.wallBand(ring, g, h, ROLE_WALL)
    b.cap(ring, g, ROLE_TRIM, false)
    floorBands(b, ring, g, h - 0.9, Math.max(1, levels - 1), 0.07)
  }
  if (ctx.roof === 'gable') {
    const rise = Math.min(h * 0.32, 2.6)
    pitchedTop(ctx, h, rise, 'gable')
  } else {
    cornice(b, ring, h - 1.2, 0.32, 0.28)
    parapet(b, ring, h, 0.8, 0.4)
  }
}

function tower(ctx: FormCtx): void {
  const { b, ring, h, levels } = ctx
  const stages = h > 45 ? 3 : 2
  let cur: Ring = ring
  let z = 0
  for (let i = 0; i < stages; i++) {
    const top = h * ((i + 1) / stages)
    walls(b, cur, top, i === 0 ? GROUND_FLOOR_H : 0.01)
    floorBands(b, cur, z, top - 0.6, Math.max(2, Math.round(levels / stages)), 0.06)
    if (i < stages - 1) {
      const next = insetRing(cur, Math.max(0.8, Math.sqrt(ctx.metrics.area) * 0.06))
      if (!next) break
      b.capWithHole(cur, next, top, ROLE_TRIM)
      cur = next
      z = top
    } else {
      parapet(b, cur, top, 1.0, 0.45)
    }
  }
}

function agricultural(ctx: FormCtx): void {
  const { b, ring, h, metrics } = ctx
  // Barn: low walls under a very large simple roof.
  const eaves = Math.max(2.0, h * 0.42)
  walls(b, ring, eaves, 3.0)
  pitchedTop(ctx, eaves, h - eaves, ctx.roof === 'barn' ? 'barn' : 'shallow')
  void metrics
}

// ---------------------------------------------------------------------------
// §31.6-4a: the us family
// ---------------------------------------------------------------------------

/**
 * A brownstone reads through three elements at city scale: the raised parlor
 * floor over a half-sunk basement (the stoop is sub-pixel; the tall base is
 * not), the flat roof, and above all the heavy projecting cornice — which is
 * the single strongest difference from the Dutch row's street-facing gable.
 */
function brownstoneRow(ctx: FormCtx): void {
  const { b, ring, h } = ctx
  // basement half-storey + parlor: the base band runs taller than a Dutch
  // ground floor and the first band sits high
  const base = Math.min(4.6, h * 0.42)
  b.wallBand(ring, 0, base, ROLE_GROUND_FLOOR)
  const eaves = h - 0.55
  if (eaves > base) {
    b.wallBand(ring, base, eaves, ROLE_WALL)
    floorBands(b, ring, base, eaves, Math.max(2, ctx.levels - 1), 0.06)
  }
  // the cornice: deeper than anything in the NL vocabulary, and doubled
  cornice(b, ring, eaves - 0.28, 0.5, 0.22)
  cornice(b, ring, eaves + 0.02, 0.34, 0.14)
  parapet(b, ring, h, 0.5, 0.3)
}

/**
 * The daylight factory / 1916-zoning loft: big masonry floorplates with heavy
 * banding, stepping back as they rise, a water tank on the roof. The setback
 * tiers and the tank are the new york silhouette.
 */
function setbackIndustrial(ctx: FormCtx): void {
  const { b, ring, h, levels, metrics, rng } = ctx
  const tiers = h >= 20 && metrics.area >= 600 ? 2 : 1
  const tierTop = tiers === 2 ? h * 0.72 : h
  b.wallBand(ring, 0, 4.4, ROLE_GROUND_FLOOR)
  b.wallBand(ring, 4.4, tierTop, ROLE_WALL)
  floorBands(b, ring, 4.4, tierTop - 0.8, Math.min(Math.max(2, levels), 8), 0.12, 0.15)
  if (tiers === 2) {
    const upper = insetRing(ring, Math.max(1.4, Math.sqrt(metrics.area) * 0.07))
    if (upper) {
      b.capWithHole(ring, upper, tierTop, ROLE_TRIM)
      b.wallBand(upper, tierTop, h, ROLE_WALL)
      floorBands(b, upper, tierTop, h - 0.7, Math.max(1, Math.round(levels * 0.3)), 0.12, 0.15)
      parapet(b, upper, h, 0.9, 0.4)
    } else {
      parapet(b, ring, h, 0.9, 0.45)
    }
  } else {
    parapet(b, ring, h, 0.9, 0.45)
  }
  cornice(b, ring, tierTop - 1.0, 0.35, 0.25)
  // the water tank: one small raised drum on legs, expressed as a box — the
  // roofline element every new york industrial block carries
  const s = 1.6 + rng() * 0.9
  const u = (rng() - 0.5) * metrics.obb.length * 0.45
  const v = (rng() - 0.5) * metrics.obb.width * 0.35
  const c = obbPoint(metrics.obb, u, v)
  const tank: Ring = [
    [c[0] - s, c[1] - s],
    [c[0] + s, c[1] - s],
    [c[0] + s, c[1] + s],
    [c[0] - s, c[1] + s],
  ]
  b.prism(tank, h + 0.7, h + 3.1 + rng() * 1.2, ROLE_TRIM, ROLE_TRIM)
}

// ---------------------------------------------------------------------------
// agent vocabulary (§16.1) — flat roofs, cleaner geometry, larger floorplates
// ---------------------------------------------------------------------------

function agentBlock(ctx: FormCtx): void {
  const { b, ring, h, levels } = ctx
  const g = Math.min(4.0, h * 0.4)
  b.wallBand(ring, 0, g, ROLE_GROUND_FLOOR)
  // A recessed top storey gives the block a crisp two-part silhouette that
  // nothing in the inherited fabric has.
  const capH = h - 0.9
  const topStart = Math.max(g, capH - Math.max(3.0, capH * 0.16))
  b.wallBand(ring, g, topStart, ROLE_WALL)
  floorBands(b, ring, g, topStart, Math.max(2, levels - 1), 0.13, 0.15)
  const top = insetRing(ring, 1.1)
  if (top) {
    b.capWithHole(ring, top, topStart, ROLE_TRIM)
    b.wallBand(top, topStart, capH, ROLE_WALL)
    parapet(b, top, h, 0.9, 0.35)
  } else {
    b.wallBand(ring, topStart, capH, ROLE_WALL)
    parapet(b, ring, h, 0.9, 0.4)
  }
}

function agentSlab(ctx: FormCtx): void {
  const { b, ring, h, levels, metrics } = ctx
  b.wallBand(ring, 0, Math.min(4.2, h * 0.35), ROLE_GROUND_FLOOR)
  b.wallBand(ring, Math.min(4.2, h * 0.35), h, ROLE_WALL)
  floorBands(b, ring, Math.min(4.2, h * 0.35), h - 1.0, levels, 0.14, 0.16)
  parapet(b, ring, h, 1.0, 0.45)

  // Circulation core expressed as a taller element at one end.
  const side = Math.min(metrics.obb.width * 0.8, 9)
  const c = obbPoint(metrics.obb, metrics.obb.length / 2 - side * 0.6, 0)
  const core: Ring = [
    [c[0] - side / 2, c[1] - side / 2],
    [c[0] + side / 2, c[1] - side / 2],
    [c[0] + side / 2, c[1] + side / 2],
    [c[0] - side / 2, c[1] + side / 2],
  ]
  b.wallBand(core, h - 0.9, h + Math.max(2.5, h * 0.16), ROLE_WALL)
  parapet(b, core, h + Math.max(2.5, h * 0.16), 0.6, 0.3)
}

function agentTower(ctx: FormCtx): void {
  const { b, ring, h, levels } = ctx
  const stages = 3
  let cur: Ring = ring
  let z = 0
  for (let i = 0; i < stages; i++) {
    const top = h * [0.42, 0.76, 1.0][i]
    b.wallBand(cur, z, top - (i === stages - 1 ? 1.0 : 0), i === 0 ? ROLE_GROUND_FLOOR : ROLE_WALL)
    floorBands(b, cur, z, top - 1.0, Math.max(2, Math.round(levels * 0.33)), 0.11, 0.13)
    if (i < stages - 1) {
      const next = insetRing(cur, Math.max(1.0, Math.sqrt(ctx.metrics.area) * 0.09))
      if (!next) {
        parapet(b, cur, h, 1.0, 0.45)
        return
      }
      b.capWithHole(cur, next, top, ROLE_TRIM)
      cur = next
      z = top
    } else {
      parapet(b, cur, top, 1.2, 0.45)
    }
  }
}

function agentHall(ctx: FormCtx): void {
  const { b, ring, h, metrics } = ctx
  b.wallBand(ring, 0, Math.min(5.0, h * 0.6), ROLE_GROUND_FLOOR)
  b.wallBand(ring, Math.min(5.0, h * 0.6), h, ROLE_WALL)
  parapet(b, ring, h, 0.9, 0.5)
  // Raised clerestory band down the middle: large span, expressed simply.
  const hw = metrics.obb.width * 0.28
  const hl = metrics.obb.length * 0.45
  const cl: Ring = [
    obbPoint(metrics.obb, -hl, -hw),
    obbPoint(metrics.obb, hl, -hw),
    obbPoint(metrics.obb, hl, hw),
    obbPoint(metrics.obb, -hl, hw),
  ]
  b.wallBand(cl, h - 0.9, h + 1.8, ROLE_TRIM)
  b.cap(cl, h + 1.8, ROLE_ROOF)
}
