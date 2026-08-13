/**
 * Measures a candidate area against §2's ratio band before any of the
 * derivation work is written against it. Run: npm run probe -w @civ/importer
 */
import { AREAS, rdBboxOf, wgsBboxOf } from './areas.ts'
import { overpass, queryBuildings, queryRoads, queryWater } from './sources/overpass.ts'
import { fetchBag } from './sources/threedbag.ts'

const which = process.argv[2] ?? 'schiedam-havens'
const area = AREAS[which]
if (!area) throw new Error(`unknown area ${which}; have ${Object.keys(AREAS).join(', ')}`)

const rd = rdBboxOf(area)
const wgs = wgsBboxOf(area)
const km2 = ((area.radiusM * 2) / 1000) ** 2

console.log(`# ${area.name}  ${(area.radiusM * 2).toFixed(0)}m square = ${km2.toFixed(3)} km2`)
console.log(`  rd bbox  ${rd.map((v) => v.toFixed(0)).join(', ')}`)
console.log(`  wgs bbox ${wgs.map((v) => v.toFixed(5)).join(', ')}`)

const bag = await fetchBag(rd)
console.log(`\n3DBAG buildings: ${bag.length}   (${(bag.length / km2).toFixed(0)} per km2)`)

const withYear = bag.filter((b) => b.constructionYear).length
const withLevels = bag.filter((b) => b.levels).length
console.log(
  `  construction year: ${((100 * withYear) / bag.length).toFixed(1)}%   levels: ${((100 * withLevels) / bag.length).toFixed(1)}%   height: 100%`,
)

const years = bag.map((b) => b.constructionYear).filter((y): y is number => !!y && y > 1000)
years.sort((a, b) => a - b)
const q = (p: number) => years[Math.floor(p * (years.length - 1))]
console.log(`  year p05/p25/p50/p75/p95: ${q(0.05)} ${q(0.25)} ${q(0.5)} ${q(0.75)} ${q(0.95)}`)

const heights = bag.map((b) => b.heightM).sort((a, b) => a - b)
const qh = (p: number) => heights[Math.floor(p * (heights.length - 1))].toFixed(1)
console.log(`  height p05/p50/p95/max: ${qh(0.05)} ${qh(0.5)} ${qh(0.95)} ${qh(1)} m`)

const areas = bag.map((b) => b.groundArea ?? 0).sort((a, b) => a - b)
const qa = (p: number) => areas[Math.floor(p * (areas.length - 1))].toFixed(0)
console.log(`  footprint p05/p50/p95/max: ${qa(0.05)} ${qa(0.5)} ${qa(0.95)} ${qa(1)} m2`)

const roofs = new Map<string, number>()
for (const b of bag) roofs.set(b.roofType ?? '?', (roofs.get(b.roofType ?? '?') ?? 0) + 1)
console.log(`  roof types: ${[...roofs].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`)

const osmB = await overpass(queryBuildings(wgs), 'buildings')
const tagCount = new Map<string, number>()
for (const el of osmB.elements) {
  const t = el.tags?.building ?? '?'
  tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
}
console.log(`\nOSM buildings (tag join source): ${osmB.elements.length}`)
console.log(
  `  ${[...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${v}`).join('  ')}`,
)

const osmR = await overpass(queryRoads(wgs), 'roads')
const classes = new Map<string, number>()
for (const el of osmR.elements) {
  const t = el.tags?.highway ?? '?'
  classes.set(t, (classes.get(t) ?? 0) + 1)
}
console.log(`\nOSM highways: ${osmR.elements.length}`)
console.log(`  ${[...classes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`)

const osmW = await overpass(queryWater(wgs), 'water')
console.log(`\nOSM water ways: ${osmW.elements.length}`)
