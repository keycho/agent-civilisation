/**
 * §21.5. Terrain for a Dutch chunk, straight from AHN.
 *
 * voxcity is retired for Schiedam and the seam it used is kept: this emits the
 * same `Substrate` contract to the same `--substrate <file>` swap the importer
 * already has. What changes is where the ground comes from — AHN is downloadable
 * as GeoTIFF from PDOK with no credentials, where voxcity reaches AHN4 through
 * Google Earth Engine and returns exact zeros while reporting success.
 *
 * Elevation only. AHN is a terrain model, not a land-cover product, and the
 * canals already arrive through the importer's own OSM query — adopting a
 * land cover that has no water in a canal town is the other half of why voxcity
 * was retired here.
 *
 *   node --no-warnings tools/ahn/emit_substrate.ts \
 *     --chunk packages/client/public/world/schiedam-havens.json \
 *     --out   /tmp/schiedam.substrate.json
 *
 *   npm run import -w @civ/importer -- schiedam-havens \
 *     --substrate /tmp/schiedam.substrate.json
 *
 * Build-time only. Nothing here ships in the runtime image.
 */
import type { Substrate, WorldSeed } from '@civ/core'
import { readFile, writeFile } from 'node:fs/promises'
import { type Raster, readGeoTiff, sampleAt } from './geotiff.ts'

const WCS = 'https://service.pdok.nl/rws/ahn/wcs/v1_0'
/** The digital *terrain* model: buildings and vegetation removed. */
const COVERAGE = 'dtm_05m'
/** Substrate grid pitch, matching what the importer's flat datum emits. */
const CELL_M = 20
/** Metres of AHN pulled beyond the chunk, so edge cells have neighbours. */
const MARGIN_M = 40

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (!v && fallback === undefined) throw new Error(`missing --${name}`)
  return v ?? fallback!
}

const chunkPath = arg('chunk')
const outPath = arg('out')
const seed = JSON.parse(await readFile(chunkPath, 'utf8')) as WorldSeed
const { origin, localBounds } = seed.chunk
if (origin.rdX === undefined || origin.rdY === undefined) {
  throw new Error(
    `${chunkPath} has no RD origin. AHN covers the Netherlands only; a chunk ` +
      'outside it needs a different terrain source and the same Substrate contract.',
  )
}

const rd = {
  minX: origin.rdX + localBounds.minX - MARGIN_M,
  minY: origin.rdY + localBounds.minY - MARGIN_M,
  maxX: origin.rdX + localBounds.maxX + MARGIN_M,
  maxY: origin.rdY + localBounds.maxY + MARGIN_M,
}

console.log(`# ${seed.chunk.name}`)
console.log(
  `  RD bbox ${rd.minX.toFixed(0)} ${rd.minY.toFixed(0)} ${rd.maxX.toFixed(0)} ${rd.maxY.toFixed(0)}`,
)

const url =
  `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${COVERAGE}` +
  `&format=image/tiff&subset=x(${rd.minX.toFixed(0)},${rd.maxX.toFixed(0)})` +
  `&subset=y(${rd.minY.toFixed(0)},${rd.maxY.toFixed(0)})`

console.log(`  GET ${COVERAGE} from PDOK…`)
const res = await fetch(url)
if (!res.ok) throw new Error(`PDOK returned ${res.status} ${res.statusText}`)
const body = Buffer.from(await res.arrayBuffer())
// The WCS reports errors as XML with a 200, which would otherwise reach the
// TIFF reader as an unhelpful parse failure.
if (body.subarray(0, 5).toString('latin1').startsWith('<')) {
  throw new Error(`PDOK returned XML, not a coverage:\n${body.subarray(0, 600).toString('utf8')}`)
}

const raster = readGeoTiff(body)
const present = countValid(raster)
console.log(
  `  ${raster.width}x${raster.height} at ${raster.scaleX} m, ` +
    `${((present / raster.values.length) * 100).toFixed(0)}% of pixels carry data`,
)

// ---------------------------------------------------------------------------
// resample to the substrate grid
// ---------------------------------------------------------------------------

const cols = Math.max(2, Math.ceil((localBounds.maxX - localBounds.minX) / CELL_M) + 1)
const rows = Math.max(2, Math.ceil((localBounds.maxY - localBounds.minY) / CELL_M) + 1)
const elevation = new Array<number>(cols * rows).fill(Number.NaN)

// Mean of the valid AHN pixels inside each cell rather than a point sample: a
// DTM in dense fabric is mostly holes where buildings were removed, so a single
// probe lands in one of them about half the time.
const STEP = 2 // metres between probes inside a cell
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const cx = localBounds.minX + i * CELL_M
    const cy = localBounds.minY + j * CELL_M
    let sum = 0
    let n = 0
    for (let dy = -CELL_M / 2; dy <= CELL_M / 2; dy += STEP) {
      for (let dx = -CELL_M / 2; dx <= CELL_M / 2; dx += STEP) {
        const v = sampleAt(raster, origin.rdX + cx + dx, origin.rdY + cy + dy)
        if (Number.isFinite(v)) {
          sum += v
          n++
        }
      }
    }
    if (n > 0) elevation[j * cols + i] = sum / n
  }
}

const holes = elevation.filter((v) => !Number.isFinite(v)).length
fillHoles(elevation, cols, rows)
smooth(elevation, cols, rows)

const relief = Math.max(...elevation) - Math.min(...elevation)
console.log(
  `  ${cols}x${rows} substrate grid at ${CELL_M} m, ${holes} cells filled from neighbours`,
)
console.log(
  `  elevation ${Math.min(...elevation).toFixed(2)} to ${Math.max(...elevation).toFixed(2)} m NAP, ` +
    `${relief.toFixed(2)} m relief`,
)

// The same canary the importer applies, applied at the source. A DEM fetch that
// fails while reporting success is the failure mode this whole exercise came
// out of, and it should be caught before the file is written, not after.
if (relief < 0.01) {
  throw new Error(
    `AHN returned ${elevation.length} samples with no relief at all. That is a ` +
      'failed fetch wearing a success message, not flat terrain.',
  )
}

const substrate: Substrate = {
  cellSizeM: CELL_M,
  elevation: elevation.map((v) => Math.round(v * 1000) / 1000),
  cols,
  rows,
  originX: localBounds.minX,
  originY: localBounds.minY,
  // Elevation only. The importer keeps its own OSM surfaces for an `ahn`
  // substrate, which is what stops the canals disappearing.
  surfaces: [],
  provider: 'ahn',
}

await writeFile(outPath, JSON.stringify(substrate))
console.log(`\nwrote ${outPath}`)
console.log(`swap it in:  npm run import -w @civ/importer -- ${seed.chunk.id} --substrate ${outPath}`)

// ---------------------------------------------------------------------------

function countValid(r: Raster): number {
  let n = 0
  for (const v of r.values) if (Number.isFinite(v)) n++
  return n
}

/** Nearest-valid dilation. Cells with no AHN return at all sit under buildings. */
function fillHoles(grid: number[], cols: number, rows: number): void {
  for (let pass = 0; pass < cols + rows; pass++) {
    let remaining = 0
    const next = grid.slice()
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i
        if (Number.isFinite(grid[k])) continue
        let sum = 0
        let n = 0
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            const jj = j + dj
            if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue
            const v = grid[jj * cols + ii]
            if (Number.isFinite(v)) {
              sum += v
              n++
            }
          }
        }
        if (n > 0) next[k] = sum / n
        else remaining++
      }
    }
    grid.splice(0, grid.length, ...next)
    if (remaining === 0) return
  }
  for (let k = 0; k < grid.length; k++) if (!Number.isFinite(grid[k])) grid[k] = 0
}

/** One 3x3 pass, so the ground does not step between adjacent samples. */
function smooth(grid: number[], cols: number, rows: number): void {
  const src = grid.slice()
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0
      let n = 0
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue
          sum += src[jj * cols + ii]
          n++
        }
      }
      grid[j * cols + i] = sum / n
    }
  }
}
