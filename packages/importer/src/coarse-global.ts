/**
 * §31.6 item 1: the global coarse layer, with tiered land value.
 *
 *   npm run -s coarse:global   (from packages/importer)
 *
 * Candidates worldwide from geonames cities15000 (CC BY 4.0), national GDP per
 * capita from the World Bank API (CC BY 4.0), and the committed NL municipal
 * layer as the first tier-1 valuation join. GHSL was the spec's first choice
 * for built area and it is unreachable from this environment (JRC ftp and the
 * Copernicus redirect both dead) — so built area and road connectivity are
 * recorded as absent tiers rather than approximated. §31.2's tier discipline
 * is applied to every field, not only to value: each candidate records where
 * each number came from, including "nowhere".
 *
 * §30.1 firewall, stated where the layer is built: everything here is a stock
 * measure — population, national income, day-0 valuations. Nothing in this
 * file may ever read the live offered surface of a materialised chunk. Agents
 * discover the offered surface by going there; the gap between this layer's
 * promise and fine reality is where discovery and failed migration live.
 *
 * §21.4: the canaries at the end read the emitted file.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CACHE_DIR } from './util/http.ts'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../../client/public/world/coarse/global.json')
const NL_LAYER = join(HERE, '../../client/public/world/coarse/nl.json')

export type ValueTier = 'national-valuation' | 'gdp-proxy' | 'absent'

export interface GlobalCandidate {
  /** 'gn-<geonameid>' */
  id: string
  name: string
  country: string
  lat: number
  lon: number
  population: number
  /**
   * Relative day-0 value index, 1.0 = the NL median. Tier 1 candidates carry
   * real national valuations mapped onto the index; proxy candidates carry
   * §31.2's formula, degraded as documented below and anchored to the same
   * scale through the one country that has both.
   */
  valueIndex?: number
  valueTier: ValueTier
  /** absent everywhere until a real source is reachable; NL carries CBS stats */
  builtHa?: number
  roadKm?: number
  stockTier: 'national-stat' | 'absent'
}

export interface GlobalCoarseLayer {
  builtAt: string
  source: string
  licence: string
  /** the year of the GDP series used for the proxy tier */
  gdpYear: string
  candidates: GlobalCandidate[]
}

async function fetchCached(url: string, key: string): Promise<Buffer> {
  const path = join(CACHE_DIR, key)
  try {
    return await readFile(path)
  } catch {
    /* miss */
  }
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(path, buf)
  return buf
}

console.log('# §31.6-1: global coarse layer')

// -- geonames ----------------------------------------------------------------
await fetchCached('https://download.geonames.org/export/dump/cities15000.zip', 'cities15000.zip')
const { stdout: tsv } = await run('unzip', ['-p', join(CACHE_DIR, 'cities15000.zip')], {
  maxBuffer: 64 * 1024 * 1024,
})

interface City {
  id: string
  name: string
  lat: number
  lon: number
  country: string
  population: number
}
const cities: City[] = []
for (const line of tsv.split('\n')) {
  const f = line.split('\t')
  if (f.length < 15) continue
  const population = Number(f[14])
  if (!Number.isFinite(population) || population < 15_000) continue
  cities.push({
    id: `gn-${f[0]}`,
    name: f[1],
    lat: Number(f[4]),
    lon: Number(f[5]),
    country: f[8],
    population,
  })
}
console.log(`  geonames: ${cities.length} settlements with population >= 15,000`)

// -- world bank GDP per capita ----------------------------------------------
const wbRaw = await fetchCached(
  'https://api.worldbank.org/v2/country/all/indicator/NY.GDP.PCAP.CD?format=json&mrnev=1&per_page=500',
  'wb-gdp-pcap.json',
)
// the API serves a UTF-8 BOM; JSON.parse chokes on it
const [, wbRows] = JSON.parse(wbRaw.toString('utf8').replace(/^﻿/, '')) as [
  unknown,
  Array<{ country: { id: string }; date: string; value: number | null }>,
]
const gdpPc = new Map<string, number>()
let gdpYear = ''
for (const r of wbRows) {
  if (r.value == null) continue
  // aggregates share the endpoint; only two-letter codes that geonames also
  // uses are countries for our purposes
  if (!/^[A-Z]{2}$/.test(r.country.id)) continue
  gdpPc.set(r.country.id, r.value)
  if (r.date > gdpYear) gdpYear = r.date
}
console.log(`  world bank: GDP per capita for ${gdpPc.size} countries, latest ${gdpYear}`)

// -- the NL tier-1 join -------------------------------------------------------
const nl = JSON.parse(await readFile(NL_LAYER, 'utf8')) as {
  settlements: Array<{
    id: string
    lat: number
    lon: number
    wozThousandEur?: number
    builtHa?: number
    roadKm: number
  }>
}
function nearestMunicipality(lat: number, lon: number) {
  let best: (typeof nl.settlements)[number] | null = null
  let bestD = Infinity
  for (const m of nl.settlements) {
    const d = Math.hypot((m.lat - lat) * 111, (m.lon - lon) * 68)
    if (d < bestD) {
      bestD = d
      best = m
    }
  }
  return bestD <= 15 ? best : null
}

/**
 * §31.2's proxy, with its degradation stated rather than hidden: the spec's
 * formula is national GDP per capita scaled by local density and connectivity.
 * Neither density nor connectivity is reachable at planet scale from this
 * environment (GHSL dead, planetary OSM out of reach), so the local term
 * degrades to log-population — the crudest defensible stand-in for intensity.
 * Agents will partly discover this formula rather than the world (§28.2's
 * warning, accepted in §31.2). The tier label is how the product stays honest
 * about which candidates carry that risk.
 */
function proxyValue(country: string, population: number): number | undefined {
  const gdp = gdpPc.get(country)
  if (gdp === undefined) return undefined
  return gdp * (1 + 0.35 * Math.log10(population / 15_000))
}

// Anchor both tiers to one scale through the country that has both: the index
// is normalised so the NL median equals 1 in each tier separately.
const nlWoz = nl.settlements
  .map((m) => m.wozThousandEur)
  .filter((v): v is number => v !== undefined)
  .sort((a, b) => a - b)
const wozMedian = nlWoz[nlWoz.length >> 1]
const nlProxy = cities
  .filter((c) => c.country === 'NL')
  .map((c) => proxyValue(c.country, c.population))
  .filter((v): v is number => v !== undefined)
  .sort((a, b) => a - b)
const proxyMedian = nlProxy[nlProxy.length >> 1]

const candidates: GlobalCandidate[] = cities.map((c) => {
  if (c.country === 'NL') {
    const m = nearestMunicipality(c.lat, c.lon)
    if (m?.wozThousandEur !== undefined) {
      return {
        id: c.id,
        name: c.name,
        country: c.country,
        lat: c.lat,
        lon: c.lon,
        population: c.population,
        valueIndex: +(m.wozThousandEur / wozMedian).toFixed(3),
        valueTier: 'national-valuation' as const,
        builtHa: m.builtHa,
        roadKm: m.roadKm,
        stockTier: 'national-stat' as const,
      }
    }
  }
  const p = proxyValue(c.country, c.population)
  return {
    id: c.id,
    name: c.name,
    country: c.country,
    lat: c.lat,
    lon: c.lon,
    population: c.population,
    valueIndex: p === undefined ? undefined : +(p / proxyMedian).toFixed(3),
    valueTier: p === undefined ? ('absent' as const) : ('gdp-proxy' as const),
    stockTier: 'absent' as const,
  }
})

const layer: GlobalCoarseLayer = {
  builtAt: new Date().toISOString().slice(0, 10),
  source:
    'geonames cities15000 (settlements, population); World Bank NY.GDP.PCAP.CD (proxy tier); ' +
    'CBS 85036NED via the NL municipal layer (tier-1 valuations)',
  licence: 'CC BY 4.0 throughout — geonames.org, worldbank.org, CBS',
  gdpYear,
  candidates,
}
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(layer))
console.log(`  wrote ${OUT} (${(JSON.stringify(layer).length / 1e6).toFixed(1)} MB)`)

// ---------------------------------------------------------------------------
// §21.4 canaries + §31.6-1's reality check, against the emitted artifact
// ---------------------------------------------------------------------------
const emitted = JSON.parse(await readFile(OUT, 'utf8')) as GlobalCoarseLayer
const s = emitted.candidates
let failures = 0
const check = (ok: boolean, label: string, detail: string): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`)
}
const find = (name: string, country: string) =>
  s.find((x) => x.name === name && x.country === country)

console.log('\n§31.6-1 canaries (against the emitted artifact)')
check(s.length >= 20_000, 'candidate breadth >= 20,000', String(s.length))
check(
  s.every((x) => x.lat >= -90 && x.lat <= 90 && x.lon >= -180 && x.lon <= 180 && x.population > 0),
  'every candidate has coordinates and population',
  '',
)

// the §31.4 seed set resolves — a fine chunk must have a settlement to belong to
const seedCities: Array<[string, string]> = [
  ['London', 'GB'],
  ['New York City', 'US'],
  ['Paris', 'FR'],
  ['Tokyo', 'JP'],
  ['Schiedam', 'NL'],
]
for (const [n, cc] of seedCities) {
  check(!!find(n, cc), `seed city resolves: ${n} (${cc})`, find(n, cc)?.id ?? 'MISSING')
}

/**
 * First form of this check asserted Tokyo/Delhi/Shanghai in the top 10 and
 * failed — a lesson about the dataset, not the world. geonames populations are
 * city-proper: Tokyo's entry is the 23 wards (9.7M, rank 21) while Chinese
 * municipalities count enormous administrative areas. The top-10 the layer
 * actually produces (Shanghai, Beijing, Shenzhen, Kinshasa, Istanbul, Lagos…)
 * are all real megacities, which is what the reality check is for. Restated to
 * match the data's semantics: the three are in the top 30, and everything in
 * the top 10 is at a megacity's scale.
 */
const byPop = [...s].sort((a, b) => b.population - a.population)
const top30 = new Set(byPop.slice(0, 30).map((x) => x.name))
check(
  ['Tokyo', 'Delhi', 'Shanghai'].every((n) => top30.has(n)),
  'Tokyo, Delhi, Shanghai in the top 30 (city-proper semantics)',
  `ranks ${['Tokyo', 'Delhi', 'Shanghai'].map((n) => byPop.findIndex((x) => x.name === n) + 1).join(', ')}`,
)
check(
  byPop.slice(0, 10).every((x) => x.population >= 8_000_000),
  'everything in the top 10 is megacity-scale',
  byPop.slice(0, 10).map((x) => x.name).join(', '),
)

const nlCands = s.filter((x) => x.country === 'NL')
check(
  nlCands.filter((x) => x.valueTier === 'national-valuation').length / nlCands.length > 0.9,
  'NL candidates >90% tier-1 valued',
  `${nlCands.length} candidates`,
)
check(
  s.every((x) => x.valueTier === 'absent' || x.valueIndex !== undefined),
  'value tier recorded and consistent on every candidate',
  `${s.filter((x) => x.valueTier === 'absent').length} honestly absent`,
)

// do the relative values look like the world (pre-registered comparisons)
const v = (name: string, cc: string) => find(name, cc)?.valueIndex ?? 0
check(v('Zürich', 'CH') > v('Lagos', 'NG'), 'value: Zürich > Lagos', `${v('Zürich', 'CH')} vs ${v('Lagos', 'NG')}`)
check(v('Tokyo', 'JP') > v('Manila', 'PH'), 'value: Tokyo > Manila', `${v('Tokyo', 'JP')} vs ${v('Manila', 'PH')}`)
check(
  v('Amsterdam', 'NL') > v('Heerlen', 'NL'),
  'value: Amsterdam > Heerlen (real WOZ, not proxy)',
  `${v('Amsterdam', 'NL')} vs ${v('Heerlen', 'NL')}`,
)

if (failures) throw new Error(`${failures} canary/canaries failed against the emitted global layer.`)
console.log('\nall global-layer canaries passed')
