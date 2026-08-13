import { cached, fetchWithRetry, sleep } from '../util/http.ts'

/**
 * OSM supplies three things the BAG registry cannot: what a building is
 * *for*, the road graph, and the water. Footprints and heights come from
 * 3DBAG instead (see sources/threedbag.ts).
 *
 * Licence note (§2): OSM is ODbL and share-alike bites derived databases you
 * publish. 3DBAG is CC BY 4.0. The emitted seed therefore records provenance
 * per layer so the question stays answerable before it is load bearing.
 */

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

export interface OsmTags {
  [k: string]: string
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  nodes?: number[]
  tags?: OsmTags
  members?: Array<{ type: string; ref: number; role: string }>
  geometry?: Array<{ lat: number; lon: number }>
}

export interface OsmResponse {
  elements: OsmElement[]
}

export async function overpass(query: string, label: string): Promise<OsmResponse> {
  return cached(`overpass:${query}`, async () => {
    let lastErr: unknown
    for (let round = 0; round < 3; round++) {
      for (const mirror of MIRRORS) {
        try {
          process.stderr.write(`  overpass ${label} via ${new URL(mirror).host}\n`)
          const res = await fetchWithRetry(
            mirror,
            {
              method: 'POST',
              body: new URLSearchParams({ data: query }),
              headers: { 'User-Agent': 'agent-civilisation/3.0 (importer)' },
            },
            { attempts: 2, baseDelayMs: 8000, timeoutMs: 240_000, label },
          )
          const text = await res.text()
          if (!text.trimStart().startsWith('{')) {
            throw new Error(`non-JSON reply: ${text.slice(0, 200)}`)
          }
          return JSON.parse(text) as OsmResponse
        } catch (err) {
          lastErr = err
          process.stderr.write(`  mirror ${new URL(mirror).host} failed: ${String(err)}\n`)
        }
      }
      await sleep(10_000 * (round + 1))
    }
    throw new Error(`overpass ${label}: all mirrors failed — ${String(lastErr)}`)
  })
}

export type Bbox = [south: number, west: number, north: number, east: number]

const bboxStr = (b: Bbox) => `${b[0]},${b[1]},${b[2]},${b[3]}`

/** Buildings, tags only. Geometry comes from 3DBAG; this is purely the tag join. */
export function queryBuildings(b: Bbox): string {
  return `[out:json][timeout:180];
(
  way["building"](${bboxStr(b)});
  relation["building"](${bboxStr(b)});
);
out geom tags;`
}

/** Anything an agent could plausibly use as access, plus the fabric that shapes blocks. */
export function queryRoads(b: Bbox): string {
  return `[out:json][timeout:180];
way["highway"]["highway"!~"^(proposed|construction|raceway|bus_guideway|escape|elevator|corridor)$"](${bboxStr(b)});
out geom tags;`
}

export function queryWater(b: Bbox): string {
  return `[out:json][timeout:180];
(
  way["natural"="water"](${bboxStr(b)});
  relation["natural"="water"](${bboxStr(b)});
  way["waterway"="riverbank"](${bboxStr(b)});
  way["waterway"~"^(river|canal)$"](${bboxStr(b)});
);
out geom tags;`
}

/** Landcover the substrate swap (§10) will eventually own, kept as a patchable layer. */
export function queryLandcover(b: Bbox): string {
  return `[out:json][timeout:180];
(
  way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|allotments|farmland|orchard|brownfield|greenfield|railway|industrial)$"](${bboxStr(b)});
  way["leisure"~"^(park|garden|pitch|playground)$"](${bboxStr(b)});
  way["natural"~"^(wood|scrub|grassland|sand|wetland)$"](${bboxStr(b)});
  way["amenity"="parking"](${bboxStr(b)});
);
out geom tags;`
}
