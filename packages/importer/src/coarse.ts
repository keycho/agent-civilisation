/**
 * §27.2 / §28.2: build the coarse candidate layer for the Netherlands.
 *
 *   node --no-warnings packages/importer/src/coarse.ts
 *
 * Two CBS StatLine tables, joined on the municipality code:
 *
 *   70072ned   population, density, built-up land, total land, road km
 *   85036NED   average WOZ valuation of dwellings
 *
 * Licence checked before use, per §28.2's "if licensing permits, and say so
 * plainly if it does not". CBS states on its own copyright page that unless
 * marked otherwise its content is CC BY 4.0 — "hergebruik van de inhoud van
 * deze site is toegestaan, mits CBS als bron wordt vermeld". Attribution is
 * carried in the emitted artifact rather than only in this comment, because the
 * artifact is what gets published.
 *
 * §21.4: the checks at the end read the emitted file, not the in-memory value.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoarseLayer, CoarseSettlement } from '@civ/core'
import { estimateYield } from '@civ/core'
import { rdToWgs } from '@civ/core/geo/rd.ts'

const ODATA = 'https://opendata.cbs.nl/ODataApi/OData'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../../client/public/world/coarse/nl.json')

const KEYS = {
  population: 'InwonersOp31December_48',
  density: 'Bevolkingsdichtheid_27',
  built: 'BebouwdTerrein_225',
  land: 'TotaleOppervlakte_158',
  roadLocal: 'GemeentelijkeEnWaterschapswegen_181',
  roadProvincial: 'ProvincialeWegen_182',
  roadNational: 'Rijkswegen_183',
} as const

async function get<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return (await r.json()) as T
    } catch (e) {
      if (attempt >= 3) throw e
      await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt))
    }
  }
}

interface ODataRows<T> {
  value: T[]
}

console.log('# §27.2 coarse layer — Netherlands')

// -- the municipality dimension, which carries the names ---------------------
const regions = await get<ODataRows<{ Key: string; Title: string }>>(
  `${ODATA}/70072ned/RegioS?$format=json`,
)
const names = new Map<string, string>()
for (const r of regions.value) names.set(r.Key.trim(), r.Title.trim())
const municipalities = [...names.keys()].filter((k) => k.startsWith('GM'))
console.log(`  ${municipalities.length} municipalities in the region dimension`)

// -- the latest period that actually carries stock figures -------------------
const periods = await get<ODataRows<{ Key: string }>>(`${ODATA}/70072ned/Perioden?$format=json`)
const yearly = periods.value.map((p) => p.Key.trim()).filter((k) => k.endsWith('JJ00')).sort()

/**
 * CBS publishes the period skeleton ahead of the figures, so the newest period
 * is routinely all nulls. Walk backwards to the newest one that has data rather
 * than assuming, which is the same class of mistake as trusting a plateau.
 */
let period = ''
let stock: Array<Record<string, unknown>> = []
for (const candidate of [...yearly].reverse()) {
  const rows = await get<ODataRows<Record<string, unknown>>>(
    `${ODATA}/70072ned/TypedDataSet?$format=json&$filter=Perioden eq '${candidate}'`,
  )
  const withData = rows.value.filter(
    (r) => String(r.RegioS).trim().startsWith('GM') && r[KEYS.population] != null,
  )
  if (withData.length > 100) {
    period = candidate
    stock = withData
    break
  }
  console.log(`  ${candidate}: ${withData.length} municipalities with data, going back one`)
}
if (!period) throw new Error('no period in 70072ned carries municipal population')
console.log(`  stock measures from ${period}: ${stock.length} municipalities`)

/**
 * Fields in one CBS table do not share a publication cadence. Population is
 * annual; the land-use survey (bodemgebruik) is not, so `BebouwdTerrein` and
 * `TotaleOppervlakte` are null in the newest period for four municipalities —
 * Vlieland, Rozendaal, Zandvoort and Krimpen aan den IJssel.
 *
 * Walking those two fields back to an older period was tried and is worse: it
 * crosses municipal reorganisations and a unit change, and produced 77
 * settlements whose built land exceeded their total land. A wrong number that
 * passes type checks is exactly the silent-plausible-output class §18.3 exists
 * for.
 *
 * So the gap is recorded as a gap. §28.2's rule for price — real data or say so
 * plainly, never a formula standing in for it — is the right rule for the rest
 * of the record, and four missing land areas out of 342 is a fact about CBS
 * rather than something to model.
 */

// -- WOZ, on its own period ---------------------------------------------------
const wozPeriods = await get<ODataRows<{ Key: string }>>(`${ODATA}/85036NED/Perioden?$format=json`)
const wozYears = wozPeriods.value.map((p) => p.Key.trim()).filter((k) => k.endsWith('JJ00')).sort()
let wozPeriod = ''
const woz = new Map<string, number>()
for (const candidate of [...wozYears].reverse()) {
  // T001132 is the "all ownership types" total
  const rows = await get<ODataRows<Record<string, unknown>>>(
    `${ODATA}/85036NED/TypedDataSet?$format=json&$filter=Perioden eq '${candidate}' and Eigendom eq 'T001132'`,
  )
  const hits = rows.value.filter(
    (r) =>
      String(r.RegioS).trim().startsWith('GM') && r.GemiddeldeWOZWaardeVanWoningen_1 != null,
  )
  if (hits.length > 100) {
    wozPeriod = candidate
    for (const r of hits) {
      woz.set(String(r.RegioS).trim(), Number(r.GemiddeldeWOZWaardeVanWoningen_1))
    }
    break
  }
  console.log(`  woz ${candidate}: ${hits.length} municipalities, going back one`)
}
if (!wozPeriod) throw new Error('no period in 85036NED carries municipal WOZ')
console.log(`  woz from ${wozPeriod}: ${woz.size} municipalities`)

// -- centroids ----------------------------------------------------------------
/**
 * CBS has no coordinates. PDOK's open location server resolves a municipality
 * to a centroid in RD, which converts with the same function the fine importer
 * uses — so the two tiers share one coordinate frame rather than agreeing by
 * coincidence.
 */
async function centroidOf(name: string): Promise<{ lat: number; lon: number } | null> {
  const q = encodeURIComponent(name)
  const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${q}&fq=type:gemeente&rows=1&fl=centroide_rd,weergavenaam`
  try {
    const r = await get<{ response: { docs: Array<{ centroide_rd?: string }> } }>(url)
    const rd = r.response.docs[0]?.centroide_rd
    if (!rd) return null
    const m = rd.match(/POINT\(([-\d.]+) ([-\d.]+)\)/)
    if (!m) return null
    return rdToWgs(Number(m[1]), Number(m[2]))
  } catch {
    return null
  }
}

const settlements: CoarseSettlement[] = []
let missingCentroid = 0
let missingWoz = 0

// PDOK is polite but not infinitely so; a small pool keeps it under a second
// per batch without hammering a free public endpoint.
const POOL = 8
const queue = [...stock]
await Promise.all(
  Array.from({ length: POOL }, async () => {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      const id = String(row.RegioS).trim()
      const name = names.get(id) ?? id
      const c = await centroidOf(name)
      if (!c) {
        missingCentroid++
        continue
      }
      const num = (k: string): number => Number(row[k] ?? 0) || 0
      const w = woz.get(id)
      if (w === undefined) missingWoz++
      settlements.push({
        id,
        name,
        lat: Number(c.lat.toFixed(5)),
        lon: Number(c.lon.toFixed(5)),
        population: num(KEYS.population),
        densityPerKm2: num(KEYS.density),
        // CBS reports total area in ares; built terrain in hectares. Taken
        // from the land-use walk above, which may be an older period.
        builtHa: row[KEYS.built] == null ? undefined : Math.round(num(KEYS.built)),
        landHa: row[KEYS.land] == null ? undefined : Math.round(num(KEYS.land) / 100),
        roadKm:
          Math.round(num(KEYS.roadLocal) + num(KEYS.roadProvincial) + num(KEYS.roadNational)),
        wozThousandEur: w,
      })
    }
  }),
)
settlements.sort((a, b) => a.id.localeCompare(b.id))
console.log(`  ${settlements.length} settlements, ${missingCentroid} without a centroid, ${missingWoz} without WOZ`)

const layer: CoarseLayer = {
  country: 'NL',
  period,
  landPeriod: period,
  wozPeriod,
  source:
    'CBS StatLine 70072ned (regional key figures) and 85036NED (average WOZ value of dwellings); ' +
    'centroids from PDOK Locatieserver',
  licence: 'CC BY 4.0 — CBS as source, per cbs.nl/nl-nl/over-ons/website/copyright',
  settlements,
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(layer))
console.log(`\n  wrote ${OUT}`)

// ---------------------------------------------------------------------------
// §21.4: the checks read the file, not the object that was written
// ---------------------------------------------------------------------------
const emitted = JSON.parse(await (await import('node:fs/promises')).readFile(OUT, 'utf8')) as CoarseLayer
const s = emitted.settlements
let failures = 0
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`)
}

console.log('\n§27.2 canaries (against the emitted artifact)')
check(s.length >= 250, 'settlement candidates >= 250', String(s.length))
check(
  s.every((x) => x.lat > 50.5 && x.lat < 53.8 && x.lon > 3.2 && x.lon < 7.3),
  'every centroid is inside the Netherlands',
  `${s.filter((x) => !(x.lat > 50.5 && x.lat < 53.8 && x.lon > 3.2 && x.lon < 7.3)).length} outside`,
)
check(
  s.every((x) => x.population > 0),
  'every settlement has a population',
  `${s.filter((x) => !(x.population > 0)).length} bad`,
)
const withLand = s.filter((x) => x.landHa !== undefined && x.landHa > 0)
check(
  withLand.length / s.length > 0.95,
  'land use present for > 95% of settlements',
  `${((withLand.length / s.length) * 100).toFixed(0)}% (${s.length - withLand.length} gaps, recorded as gaps)`,
)
const withWoz = s.filter((x) => x.wozThousandEur !== undefined).length
check(withWoz / s.length > 0.9, 'WOZ present for > 90% of settlements', `${((withWoz / s.length) * 100).toFixed(0)}%`)
check(
  withLand.every((x) => (x.builtHa ?? 0) <= (x.landHa ?? 0)),
  'built land never exceeds total land',
  `${withLand.filter((x) => (x.builtHa ?? 0) > (x.landHa ?? 0)).length} bad`,
)

/**
 * §28.1's requirement, as a check rather than an intention: the estimate has to
 * be lossy. If it ranked settlements the same way population does, agents would
 * sort by size and "a place nobody selected became important" could not happen.
 */
const national =
  s.reduce((sum, x) => sum + (x.wozThousandEur ?? 0), 0) / Math.max(1, withWoz)
const byYield = [...s].sort((a, b) => estimateYield(b, national) - estimateYield(a, national))
const byPop = [...s].sort((a, b) => b.population - a.population)
const topTenYield = new Set(byYield.slice(0, Math.ceil(s.length / 10)).map((x) => x.id))
const topTenPop = new Set(byPop.slice(0, Math.ceil(s.length / 10)).map((x) => x.id))
let overlap = 0
for (const id of topTenYield) if (topTenPop.has(id)) overlap++
check(
  overlap / topTenYield.size < 0.5,
  'the yield estimate does not just rank by population',
  `${((overlap / topTenYield.size) * 100).toFixed(0)}% of the top decile shared`,
)
console.log(`  national average WOZ: ${national.toFixed(0)} thousand euro`)
console.log(`  highest estimated yield: ${byYield.slice(0, 5).map((x) => x.name).join(', ')}`)
console.log(`  largest by population:   ${byPop.slice(0, 5).map((x) => x.name).join(', ')}`)

if (failures) {
  throw new Error(`${failures} canary/canaries failed against the emitted coarse layer.`)
}
console.log('\nall coarse canaries passed')
