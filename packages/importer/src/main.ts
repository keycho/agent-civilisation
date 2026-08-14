/**
 * Stage 1 (§12): import one small real area — buildings, road graph, derived
 * parcels — and emit a world seed plus SQL.
 *
 *   npm run import                    # default area
 *   npm run import -- dordrecht-old
 *
 * This is a build-time pipeline. Nothing here ships in the runtime image; the
 * committed output in packages/client/public/world is what the app loads.
 */
import type { ChunkMeta, Provenance, Substrate, WorldSeed } from '@civ/core'
import { boundsOfMany, rdFrame } from '@civ/core'
import { AREAS, rdBboxOf, wgsBboxOf } from './areas.ts'
import { extractBlocks } from './build/blocks.ts'
import { buildBaselineBuildings } from './build/buildings.ts'
import { deriveParcels } from './build/parcels.ts'
import { buildRoadGraph } from './build/roads.ts'
import { buildSubstrate, waterRings } from './build/substrate.ts'
import { emitSeed, emitSql } from './emit.ts'
import { readFile } from 'node:fs/promises'
import {
  overpass,
  queryBuildings,
  queryLandcover,
  queryRoads,
  queryWater,
} from './sources/overpass.ts'
import { fetchBag } from './sources/threedbag.ts'

const which = process.argv[2] ?? 'schiedam-havens'
const area = AREAS[which]
if (!area) throw new Error(`unknown area '${which}'; have ${Object.keys(AREAS).join(', ')}`)

const t0 = Date.now()
const log = (s: string) => console.log(s)

log(`# importing ${area.name}`)
const frame = rdFrame(area.lat, area.lon)
const rd = rdBboxOf(area)
const wgs = wgsBboxOf(area)
const r = area.radiusM
const clip = { minX: -r, minY: -r, maxX: r, maxY: r }

log('\n[1/6] fetching sources')
const bag = await fetchBag(rd)
const osmBuildings = await overpass(queryBuildings(wgs), 'buildings')
const osmRoads = await overpass(queryRoads(wgs), 'roads')
const osmWater = await overpass(queryWater(wgs), 'water')
const osmLand = await overpass(queryLandcover(wgs), 'landcover')
log(
  `      3dbag=${bag.length}  osm buildings=${osmBuildings.elements.length}  ` +
    `highways=${osmRoads.elements.length}  water=${osmWater.elements.length}  landcover=${osmLand.elements.length}`,
)

log('\n[2/6] buildings: 3dbag geometry + osm tags')
const built = buildBaselineBuildings(bag, osmBuildings.elements, frame, area.id, clip)
log(
  `      ${built.buildings.length} baseline buildings  (tag match ${built.matched}, fallback ${built.unmatched})`,
)
log(`      purpose   ${fmtCounts(built.purposeCounts)}`)
log(`      archetype ${fmtCounts(built.archetypeCounts)}`)

log('\n[3/6] road graph')
const graph = buildRoadGraph(osmRoads.elements, frame)
log(`      ${graph.nodes.length} nodes  ${graph.edges.length} edges  ${fmtCounts(graph.classCounts)}`)

log('\n[4/6] blocks from planar faces')
const { blocks, dropped } = extractBlocks(graph.nodes, graph.edges)
log(
  `      ${blocks.length} blocks  (dropped: ${dropped.tooSmall} small, ${dropped.tooLarge} large, ${dropped.degenerate} degenerate)`,
)

log('\n[5/6] substrate + parcels')
const localBounds = boundsOfMany([
  built.buildings.flatMap((b) => b.footprint),
  [
    [clip.minX, clip.minY],
    [clip.maxX, clip.maxY],
  ],
])
let substrate = buildSubstrate(
  osmWater.elements,
  osmLand.elements,
  built.buildings,
  frame,
  localBounds,
)

// §12 stage 10: the substrate is a swap, not a rewrite. If a voxcity run has
// emitted one (tools/voxcity/emit_substrate.py), it replaces the flat datum
// here and nothing downstream is aware of the difference.
const substrateArg = process.argv.indexOf('--substrate')
if (substrateArg >= 0 && process.argv[substrateArg + 1]) {
  const path = process.argv[substrateArg + 1]
  const loaded = JSON.parse(await readFile(path, 'utf8')) as Substrate
  if (loaded.provider !== 'voxcity') {
    throw new Error(`${path}: expected provider "voxcity", got "${loaded.provider}"`)
  }
  if (!Array.isArray(loaded.elevation) || loaded.elevation.length !== loaded.cols * loaded.rows) {
    throw new Error(`${path}: elevation grid does not match cols x rows`)
  }
  substrate = loaded
  log(`      substrate replaced from ${path} (voxcity)`)
}
const parcels = deriveParcels(
  blocks,
  built.buildings,
  graph.nodes,
  graph.edges,
  waterRings(substrate),
  area.id,
  clip,
)
log(
  `      ${parcels.parcels.length} parcels  (${parcels.occupied} occupied, ${parcels.vacant} vacant, ` +
    `${parcels.undevelopable} undevelopable, ${parcels.orphanBuildings} orphan buildings)`,
)
log(`      substrate: ${substrate.surfaces.length} surfaces, ${substrate.cols}x${substrate.rows} elevation grid`)

const today = new Date().toISOString().slice(0, 10)
const provenance: Provenance[] = [
  {
    layer: 'buildings (footprint, height, levels, construction year, roof type)',
    source: '3DBAG v2023.10.08 via api.3dbag.nl',
    licence: 'CC BY 4.0',
    retrieved: today,
  },
  {
    layer: 'building purpose tags, road graph, water, landcover',
    source: 'OpenStreetMap via Overpass API',
    licence: 'ODbL 1.0 — share-alike applies to published derived databases',
    retrieved: today,
  },
  {
    layer: 'terrain, landcover, water (substrate)',
    source:
      substrate.provider === 'voxcity'
        ? 'voxcity (build-time pipeline, tools/voxcity)'
        : 'OSM landcover + datum interpolated from BAG ground heights',
    licence: substrate.provider === 'voxcity' ? 'per voxcity source layers' : 'ODbL 1.0 / CC BY 4.0',
    retrieved: today,
  },
  {
    layer: 'blocks, parcels',
    source: 'derived from the road graph (§6)',
    licence: 'follows the ODbL road graph it is derived from',
    retrieved: today,
  },
]

const chunk: ChunkMeta = {
  id: area.id,
  name: area.name,
  origin: frame.origin,
  bbox: [wgs[0], wgs[1], wgs[2], wgs[3]],
  localBounds,
  sourceNote: area.note,
}

const seed: WorldSeed = {
  version: 3,
  chunk,
  buildings: built.buildings,
  roads: { nodes: graph.nodes, edges: graph.edges },
  blocks,
  parcels: parcels.parcels,
  substrate,
  districts: [],
  provenance,
  stats: {
    baselineBuildings: built.buildings.length,
    tagMatchRate: +(built.matched / Math.max(1, built.buildings.length)).toFixed(3),
    parcels: parcels.parcels.length,
    vacantParcels: parcels.vacant,
    roadEdges: graph.edges.length,
    blocks: blocks.length,
    areaKm2: +(((area.radiusM * 2) / 1000) ** 2).toFixed(3),
  },
}

log('\n[6/6] emitting')
const { jsonPath, bytes } = await emitSeed(seed)
const sqlPath = await emitSql(seed, frame)
log(`      ${jsonPath}  (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
log(`      ${sqlPath}`)

log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
log(
  `\nratio check (§2): ${built.buildings.length} baseline buildings in ${seed.stats.areaKm2} km2 — ` +
    (built.buildings.length >= 400 && built.buildings.length <= 1500
      ? 'inside the 400-1500 band'
      : 'OUTSIDE the 400-1500 band, resize before tuning anything else'),
)

function fmtCounts(c: Record<string, number>): string {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}
