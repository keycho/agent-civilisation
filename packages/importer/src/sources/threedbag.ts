import type { Ring, Vec2 } from '@civ/core'
import { cached, fetchWithRetry } from '../util/http.ts'

/**
 * 3DBAG (api.3dbag.nl, CC BY 4.0) is the building spine.
 *
 * §2 asks for footprints with real heights and construction years. 3DBAG has
 * all three for all ~10 million Dutch buildings: BAG registry footprints, AHN
 * lidar heights, and `oorspronkelijkbouwjaar`. Construction year does double
 * duty — it grounds day 0 in real history and it feeds the archetype selector,
 * so a 1907 warehouse and a 1975 apartment block diverge automatically.
 *
 * Only the LOD-0 footprint is read. §16.1 makes building mass *generated*, so
 * importing the LOD-2.2 solids would be importing geometry we then throw away.
 */

const BASE = 'https://api.3dbag.nl/collections/pand/items'

export interface BagBuilding {
  /** NL.IMBAG.Pand.xxxxxxxx */
  id: string
  /** footprint in RD metres (EPSG:28992) */
  ringRd: Ring
  /** roof height above ground, metres */
  heightM: number
  /** ground level in NAP metres */
  groundM: number
  levels: number | null
  constructionYear: number | null
  roofType: string | null
  groundArea: number | null
}

interface CityJsonFeature {
  id: string
  vertices: number[][]
  CityObjects: Record<
    string,
    {
      type: string
      attributes?: Record<string, unknown>
      geometry?: Array<{ lod: string; type: string; boundaries: unknown }>
    }
  >
}

interface ItemsPage {
  features: CityJsonFeature[]
  links: Array<{ rel: string; href: string }>
  numberMatched: number
  numberReturned: number
  metadata?: { transform?: { scale: number[]; translate: number[] } }
}

/** RD bbox: [minX, minY, maxX, maxY] in metres. */
export type RdBbox = [number, number, number, number]

export async function fetchBag(bbox: RdBbox, pageSize = 250): Promise<BagBuilding[]> {
  return cached(`3dbag:v2:${bbox.join(',')}:${pageSize}`, async () => {
    const out: BagBuilding[] = []
    let url = `${BASE}?bbox=${bbox.join(',')}&limit=${pageSize}`
    let page = 0
    let matched = -1

    while (url) {
      const res = await fetchWithRetry(
        url,
        { headers: { 'User-Agent': 'agent-civilisation/3.0 (importer)' } },
        { attempts: 5, baseDelayMs: 3000, timeoutMs: 180_000, label: '3dbag' },
      )
      const body = (await res.json()) as ItemsPage
      if (matched < 0) matched = body.numberMatched
      // The transform is per page, not per collection. Applying a stale one
      // silently translates a whole page by hundreds of metres.
      const transform = body.metadata?.transform
      if (!transform) throw new Error('3dbag page is missing metadata.transform')

      for (const f of body.features) {
        const b = parseFeature(f, transform)
        if (b) out.push(b)
      }
      page++
      process.stderr.write(`  3dbag page ${page}: ${out.length}/${matched}\n`)

      const next = body.links.find((l) => l.rel === 'next')
      if (!next || body.numberReturned === 0) break
      url = next.href
    }
    return out
  })
}

function parseFeature(
  f: CityJsonFeature,
  transform: { scale: number[]; translate: number[] },
): BagBuilding | null {
  const [sx, sy] = transform.scale
  const [tx, ty] = transform.translate

  let building: CityJsonFeature['CityObjects'][string] | null = null
  let id = f.id
  for (const [key, obj] of Object.entries(f.CityObjects)) {
    if (obj.type === 'Building') {
      building = obj
      id = key
      break
    }
  }
  if (!building) return null

  const lod0 = building.geometry?.find((g) => g.lod === '0')
  if (!lod0) return null

  // MultiSurface: boundaries = [ [ [v0, v1, ...] ] ] — one surface, outer ring first.
  const surfaces = lod0.boundaries as number[][][]
  const first = surfaces?.[0]?.[0]
  if (!Array.isArray(first) || first.length < 3) return null

  const ringRd: Ring = first.map((vi) => {
    const v = f.vertices[vi]
    return [v[0] * sx + tx, v[1] * sy + ty] as Vec2
  })

  const a = building.attributes ?? {}
  const num = (k: string): number | null => {
    const v = a[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  const ground = num('b3_h_maaiveld') ?? 0
  // 70th-percentile roof height reads as the dominant roof plane; `max` chases
  // chimneys and aerials, which makes a whole street look spiky.
  const roof = num('b3_h_dak_70p') ?? num('b3_h_dak_50p') ?? num('b3_h_dak_max')
  if (roof === null) return null
  const heightM = roof - ground
  if (!Number.isFinite(heightM) || heightM <= 0.5) return null

  return {
    id,
    ringRd,
    heightM,
    groundM: ground,
    levels: num('b3_bouwlagen'),
    constructionYear: num('oorspronkelijkbouwjaar'),
    roofType: typeof a.b3_dak_type === 'string' ? a.b3_dak_type : null,
    groundArea: num('b3_opp_grond'),
  }
}
