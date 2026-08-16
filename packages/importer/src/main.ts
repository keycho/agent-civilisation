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
import { boundsOfMany, enuFrame,
  rdFrame, seedChecks, validateSeed } from '@civ/core'
import { AREAS, rdBboxOf, wgsBboxOf } from './areas.ts'
import { extractBlocks } from './build/blocks.ts'
import { buildBaselineBuildings } from './build/buildings.ts'
import { buildFromOsm } from './build/osm-only.ts'
import { deriveParcels } from './build/parcels.ts'
import { buildRoadGraph } from './build/roads.ts'
import { buildSubstrate, waterRings } from './build/substrate.ts'
import { checkSql, emitSeed, emitSql } from './emit.ts'
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
/**
 * §31.2: the frame and the geometry source are the two things that vary by
 * country. NL works in RD so 3DBAG needs no reprojection; everywhere else is a
 * local ENU frame and OSM is both geometry and tags.
 */
const frame =
  area.country === 'NL'
    ? rdFrame(area.lat, area.lon, area.bearingDeg ?? 0)
    : enuFrame(area.lat, area.lon, area.bearingDeg ?? 0)
const wgs = wgsBboxOf(area)
const r = area.radiusM
const clip = { minX: -r, minY: -r, maxX: r, maxY: r }

log('\n[1/7] fetching sources')
const bag = area.country === 'NL' ? await fetchBag(rdBboxOf(area)) : []
const osmBuildings = await overpass(queryBuildings(wgs), 'buildings')
const osmRoads = await overpass(queryRoads(wgs), 'roads')
const osmWater = await overpass(queryWater(wgs), 'water')
const osmLand = await overpass(queryLandcover(wgs), 'landcover')
log(
  `      3dbag=${bag.length}  osm buildings=${osmBuildings.elements.length}  ` +
    `highways=${osmRoads.elements.length}  water=${osmWater.elements.length}  landcover=${osmLand.elements.length}`,
)

log(area.country === 'NL' ? '\n[2/7] buildings: 3dbag geometry + osm tags' : '\n[2/7] buildings: osm only (§31.2 fallback adapter)')
const built =
  area.country === 'NL'
    ? buildBaselineBuildings(bag, osmBuildings.elements, frame, area.id, clip)
    : buildFromOsm(osmBuildings.elements, frame, area.id, clip)
log(
  `      ${built.buildings.length} baseline buildings  (tag match ${built.matched}, fallback ${built.unmatched})` +
    (built.rowsSplit ? `  rows split at party walls: ${built.rowsSplit} (§33.2)` : ''),
)
log(`      purpose   ${fmtCounts(built.purposeCounts)}`)
log(`      archetype ${fmtCounts(built.archetypeCounts)}`)

log('\n[3/7] road graph')
const graph = buildRoadGraph(osmRoads.elements, frame)
log(`      ${graph.nodes.length} nodes  ${graph.edges.length} edges  ${fmtCounts(graph.classCounts)}`)

log('\n[4/7] blocks from planar faces')
const { blocks, dropped } = extractBlocks(graph.nodes, graph.edges)
log(
  `      ${blocks.length} blocks  (dropped: ${dropped.tooSmall} small, ${dropped.tooLarge} large, ${dropped.degenerate} degenerate)`,
)

log('\n[5/7] substrate + parcels')
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

// §12 stage 10: the substrate is a swap, not a rewrite. An external pipeline
// emits the same contract to a file and it replaces the flat datum here, with
// nothing downstream aware of the difference.
//
// §21.5: two providers now sit behind that seam and they carry different
// amounts. voxcity fuses terrain *and* land cover, so it replaces the whole
// struct. AHN is a terrain model, so it replaces the ground and leaves the
// surfaces alone — which is the fix for the finding that retired voxcity here,
// that its land cover has no water in it and adopting it deletes every canal in
// a canal town.
const substrateArg = process.argv.indexOf('--substrate')
if (substrateArg >= 0 && process.argv[substrateArg + 1]) {
  const path = process.argv[substrateArg + 1]
  const loaded = JSON.parse(await readFile(path, 'utf8')) as Substrate
  if (loaded.provider !== 'voxcity' && loaded.provider !== 'ahn') {
    throw new Error(`${path}: expected provider "voxcity" or "ahn", got "${loaded.provider}"`)
  }
  if (!Array.isArray(loaded.elevation) || loaded.elevation.length !== loaded.cols * loaded.rows) {
    throw new Error(`${path}: elevation grid does not match cols x rows`)
  }

  // voxcity reports "Dem complete" and hands back an all-zero grid when its DEM
  // source needs credentials it does not have — AHN4 is served through Google
  // Earth Engine. A substrate with no relief at all is that failure, not a flat
  // country: real polder still varies by tens of centimetres. The canary stays
  // whatever the provider is, because the failure shape is not voxcity's alone.
  const relief = Math.max(...loaded.elevation) - Math.min(...loaded.elevation)
  if (relief < 0.01 && !process.argv.includes('--allow-flat')) {
    throw new Error(
      `${path}: elevation grid has zero relief across ${loaded.elevation.length} samples. ` +
        'That is an unauthenticated DEM fetch, not flat terrain. Pass --allow-flat to override.',
    )
  }

  const elevationOnly = loaded.provider === 'ahn'
  if (!elevationOnly && !loaded.surfaces.some((s) => s.kind === 'water') && waterRings(substrate).length > 0) {
    log(
      `      WARNING: replacement substrate has no water but the OSM one had ` +
        `${waterRings(substrate).length} bodies — the canals would be lost`,
    )
  }
  substrate = elevationOnly ? { ...loaded, surfaces: substrate.surfaces } : loaded
  log(
    `      substrate replaced from ${path} (${loaded.provider}): ` +
      `${relief.toFixed(2)} m relief, ` +
      (elevationOnly
        ? `elevation only, keeping ${substrate.surfaces.length} OSM surfaces`
        : `${loaded.surfaces.length} surfaces`),
  )
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
    `${parcels.undevelopable} undevelopable, ${parcels.orphanBuildings} orphan buildings, ` +
    `${parcels.selfIntersectingDropped} self-intersecting and ` +
    `${parcels.overCarriagewayDropped} on-carriageway dropped)`,
)
log(`      substrate: ${substrate.surfaces.length} surfaces, ${substrate.cols}x${substrate.rows} elevation grid`)

const SUBSTRATE_SOURCE: Record<Substrate['provider'], string> = {
  'flat-datum':
    area.country === 'NL'
      ? 'OSM landcover + datum interpolated from BAG ground heights'
      : 'OSM landcover + flat datum (no national DTM wired for this country yet)',
  voxcity: 'voxcity (build-time pipeline, tools/voxcity)',
  ahn: 'AHN dtm_05m via PDOK WCS (build-time pipeline, tools/ahn)',
}
const SUBSTRATE_LICENCE: Record<Substrate['provider'], string> = {
  'flat-datum': 'ODbL 1.0 / CC BY 4.0',
  voxcity: 'per voxcity source layers',
  ahn: 'CC BY 4.0 (Rijkswaterstaat / AHN)',
}

const today = new Date().toISOString().slice(0, 10)
/**
 * §21.4 applies to provenance too: the first London render showed a panel
 * claiming 3DBAG and AHN over a chunk built from neither. Provenance is
 * assembled from what THIS import actually used, not from what the pipeline
 * was first written against.
 */
const provenance: Provenance[] = [
  area.country === 'NL'
    ? {
        layer: 'buildings (footprint, height, levels, construction year, roof type)',
        source: '3DBAG v2023.10.08 via api.3dbag.nl',
        licence: 'CC BY 4.0',
        retrieved: today,
      }
    : {
        layer:
          'buildings (footprint; height/levels from OSM tags where present, ' +
          `estimated otherwise — ${Math.round((built.buildings.filter((b) => b.heightSource !== 'estimated').length / Math.max(1, built.buildings.length)) * 100)}% measured)`,
        source: 'OpenStreetMap via Overpass API',
        licence: 'ODbL 1.0 — share-alike applies to published derived databases',
        retrieved: today,
      },
  {
    layer: 'building purpose tags, road graph, water, landcover',
    source: 'OpenStreetMap via Overpass API',
    licence: 'ODbL 1.0 — share-alike applies to published derived databases',
    retrieved: today,
  },
  {
    layer:
      substrate.provider === 'ahn'
        ? 'terrain (substrate elevation)'
        : 'terrain, landcover, water (substrate)',
    source: SUBSTRATE_SOURCE[substrate.provider],
    licence: SUBSTRATE_LICENCE[substrate.provider],
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
  adminCode: area.adminCode,
  country: area.country,
}

/**
 * §30.3: flag the perimeter at import. A parcel with a vertex inside the margin
 * sits on ground whose blocks, roads and neighbours are partly outside the
 * fetched extent — its economics are computed against a world that is cut off
 * mid-street. The flag records that; the gate that acts on it lives in the sim
 * and is off by default.
 */
const BOUNDARY_MARGIN_M = 25
let boundaryFlagged = 0
for (const p of parcels.parcels) {
  const near = p.polygon.some(
    ([x, y]) =>
      x - clip.minX < BOUNDARY_MARGIN_M ||
      clip.maxX - x < BOUNDARY_MARGIN_M ||
      y - clip.minY < BOUNDARY_MARGIN_M ||
      clip.maxY - y < BOUNDARY_MARGIN_M,
  )
  if (near) {
    p.boundaryAdjacent = true
    boundaryFlagged++
  }
}
log(`      ${boundaryFlagged} parcels flagged boundary-adjacent (§30.3, gate off by default)`)

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
    /**
     * §31.5: per-chunk import health, in the manifest rather than in a log
     * line, so "the pipeline half-worked on this country's data" is a recorded
     * property of the artifact and not something to rediscover.
     */
    importHealth: {
      heightsReal: +(
        built.buildings.filter((b) => b.heightSource !== 'estimated').length /
        Math.max(1, built.buildings.length)
      ).toFixed(3),
      yearsPresent: +(
        built.buildings.filter((b) => b.constructionYear != null).length /
        Math.max(1, built.buildings.length)
      ).toFixed(3),
      boundaryParcels: boundaryFlagged,
      /**
       * §33.1: ownable stock over imported stock, the line that decides
       * whether a chunk may join the region world. Orphan synthesis is what
       * keeps this at 1.0 — a building outside every block face gets a parcel
       * drawn around its own footprint rather than being silently excluded
       * from the market. The synthesis stats sit beside it so the fallback is
       * a measured thing, not an assumption.
       */
      ownableShare: +(
        (() => {
          const claimed = new Set(
            parcels.parcels.filter((p) => p.buildingId).map((p) => p.buildingId as string),
          )
          return (
            built.buildings.filter((b) => claimed.has(b.id)).length /
            Math.max(1, built.buildings.length)
          )
        })()
      ).toFixed(3),
      synthesisedParcels: parcels.parcels.filter((p) => p.blockId === 'blk-orphan').length,
      rowsSplit: built.rowsSplit ?? 0,
    },
  },
}

log('\n[6/7] emitting')
const { jsonPath, bytes, written } = await emitSeed(seed)
const sqlPath = await emitSql(seed, frame)
log(`      ${jsonPath}  (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
log(`      ${sqlPath}`)

/**
 * §21.4. The canaries run here, on the files that were just written and read
 * back, not on the objects above. Twenty self-intersecting parcels once
 * survived a fix because the validator saw the unrounded ring and the emitter
 * wrote millimetre-quantised coordinates; a validator that never reads the
 * artifact cannot catch anything the artifact introduces.
 */
log('\n[7/7] validating the emitted artifacts')
const checks = seedChecks(validateSeed(written))
for (const c of checks) log(`      ${c.ok ? 'ok  ' : 'FAIL'} ${c.label.padEnd(46)} ${c.detail}`)

/**
 * §33.1's floor: ownable stock over imported stock, asserted at import. The
 * denominator is what entered derivation — a building dropped between there
 * and the artifact is exactly the silent market shrinkage §18.2 exists to
 * catch, and the emitted-artifact canaries cannot see it because the dropped
 * building is not in the artifact. A chunk below the floor does not join the
 * region world (REGION_RULES in the contract mirrors this number).
 */
const OWNABLE_FLOOR = 0.97
const claimedIds = new Set(written.parcels.filter((p) => p.buildingId).map((p) => p.buildingId))
const ownable = built.buildings.filter((b) => claimedIds.has(b.id)).length
const ownableShare = ownable / Math.max(1, built.buildings.length)
const ownableOk = ownableShare >= OWNABLE_FLOOR
log(
  `      ${ownableOk ? 'ok  ' : 'FAIL'} ${'ownable / imported >= 97% (§33.1)'.padEnd(46)} ` +
    `${ownable}/${built.buildings.length} = ${(ownableShare * 100).toFixed(1)}%`,
)

const sql = await checkSql(sqlPath, written, frame)
const sqlOk = sql.missing === 0 && sql.worstErrorM < 0.05
log(
  `      ${sqlOk ? 'ok  ' : 'FAIL'} ${'sql round-trips to within 5 cm'.padEnd(46)} ` +
    `${sql.rows} rows, worst ${(sql.worstErrorM * 1000).toFixed(1)} mm` +
    (sql.missing ? `, ${sql.missing} MISSING` : ''),
)

const failed = checks.filter((c) => !c.ok).length + (sqlOk ? 0 : 1) + (ownableOk ? 0 : 1)
if (failed > 0) {
  throw new Error(
    `${failed} structural check(s) failed against the emitted artifact. ` +
      'The files are written; do not commit them.',
  )
}

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
