/**
 * §31.6-5: the settlement roster the region world runs over, joined from
 * emitted artifacts only (§21.4): fine anchors from each chunk seed's own
 * manifest, populations and value tiers from the coarse layer the importer
 * emitted. Nothing here re-derives from source data, and nothing here invents
 * a number the emitters did not write.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorldSeed } from '@civ/core'
import type { SettlementInfo } from '../../src/region.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORLD_DIR = join(HERE, '..', '..', '..', 'client', 'public', 'world')

/** the §31.4 five: materialised and ticking from tick zero */
export const SEEDED_FIVE = [
  'schiedam-havens',
  'london-deptford',
  'brooklyn-redhook',
  'paris-ourcq',
  'tokyo-kyojima',
] as const

/**
 * The §31.6-5 dormant candidates: the NL constellation around the control.
 * Close enough that transit is affordable (the §28.3 commitment made
 * physical), real enough that materialisation means loading a real import.
 */
export const DORMANT_NL = ['vlaardingen-westwijk', 'maasland-dorp', 'maassluis-haven'] as const

/**
 * settlement id -> the global coarse layer's exact (name, country) candidate.
 * The chunk is a district; the candidate is its city — the same join the
 * spectator's global view makes. maasland-dorp is handled below: the village
 * (~4k people) sits under geonames' cities15000 cutoff and has no global
 * candidate.
 */
const GLOBAL_CANDIDATE: Record<string, [name: string, country: string]> = {
  'schiedam-havens': ['Schiedam', 'NL'],
  'london-deptford': ['London', 'GB'],
  'brooklyn-redhook': ['Brooklyn', 'US'],
  'paris-ourcq': ['Paris', 'FR'],
  'tokyo-kyojima': ['Tokyo', 'JP'],
  'vlaardingen-westwijk': ['Vlaardingen', 'NL'],
  'maassluis-haven': ['Maassluis', 'NL'],
}

/**
 * maasland-dorp's municipality in the CBS layer (Midden-Delfland). Its
 * valueIndex uses the same WOZ normalisation the global emitter applied to
 * the other NL candidates — the constant is recovered from the Schiedam pair
 * (global valueIndex / CBS wozThousandEur) rather than restated here, so it
 * cannot drift from the emitter. The population is the municipality's, which
 * is coarser semantics than the city-proper entries; safe only because the
 * ordering cannot flip — maasland is the smallest NL settlement under either
 * semantic, so no §32.3 leader comparison can be decided by the join.
 */
const MAASLAND_GEMEENTE = 'GM1842'
const WOZ_REFERENCE_PAIR = { settlement: 'GM0606', candidate: ['Schiedam', 'NL'] } as const

export interface ImportHealthEntry {
  heightsReal: number
  yearsPresent: number
  boundaryParcels: number
  ownableShare?: number
}

export interface RegionRoster {
  seeds: Map<string, WorldSeed>
  info: Map<string, SettlementInfo>
  importHealth: Record<string, ImportHealthEntry>
}

interface GlobalCandidate {
  name: string
  country: string
  lat: number
  lon: number
  population: number
  valueIndex?: number
  valueTier: string
}

interface NlSettlement {
  id: string
  name: string
  lat: number
  lon: number
  population: number
  wozThousandEur?: number
}

export async function loadRoster(): Promise<RegionRoster> {
  const ids = [...SEEDED_FIVE, ...DORMANT_NL]
  const seeds = new Map<string, WorldSeed>()
  for (const id of ids) {
    const path = join(WORLD_DIR, `${id}.json`)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      throw new Error(
        `region roster incomplete: ${id} has no emitted seed at ${path} — ` +
          `import it before the region suite runs (§31.6-5 runs the full roster or not at all)`,
      )
    }
    seeds.set(id, JSON.parse(raw) as WorldSeed)
  }

  const global = JSON.parse(
    await readFile(join(WORLD_DIR, 'coarse', 'global.json'), 'utf8'),
  ) as { candidates: GlobalCandidate[] }
  const nl = JSON.parse(await readFile(join(WORLD_DIR, 'coarse', 'nl.json'), 'utf8')) as {
    settlements: NlSettlement[]
  }

  const candidateOf = (name: string, country: string): GlobalCandidate => {
    const hit = global.candidates.find((c) => c.name === name && c.country === country)
    if (!hit) throw new Error(`coarse layer has no candidate ${name}/${country}`)
    return hit
  }

  const info = new Map<string, SettlementInfo>()
  const importHealth: Record<string, ImportHealthEntry> = {}

  for (const id of ids) {
    const seed = seeds.get(id)
    if (!seed) continue
    const health = seed.stats.importHealth
    if (!health)
      throw new Error(`${id}: seed manifest carries no importHealth — §31.5 requires it`)
    importHealth[id] = {
      heightsReal: health.heightsReal,
      yearsPresent: health.yearsPresent,
      boundaryParcels: health.boundaryParcels,
      ownableShare: health.ownableShare,
    }

    const base = {
      id,
      name: seed.chunk.name,
      country: seed.chunk.country ?? 'NL',
      // the chunk's own anchor, not the city centroid — transit distance is
      // between the places agents actually are
      lat: seed.chunk.origin.lat,
      lon: seed.chunk.origin.lon,
    }

    if (id === 'maasland-dorp') {
      const gemeente = nl.settlements.find((s) => s.id === MAASLAND_GEMEENTE)
      const refNl = nl.settlements.find((s) => s.id === WOZ_REFERENCE_PAIR.settlement)
      const refGlobal = candidateOf(...WOZ_REFERENCE_PAIR.candidate)
      if (!gemeente?.wozThousandEur || !refNl?.wozThousandEur || !refGlobal.valueIndex)
        throw new Error('maasland-dorp: CBS join incomplete — cannot recover WOZ normalisation')
      const k = refGlobal.valueIndex / refNl.wozThousandEur
      info.set(id, {
        ...base,
        population: gemeente.population,
        valueIndex: k * gemeente.wozThousandEur,
        valueTier: 'national-valuation',
      })
      continue
    }

    const mapping = GLOBAL_CANDIDATE[id]
    if (!mapping) throw new Error(`${id}: no coarse candidate mapping registered`)
    const c = candidateOf(...mapping)
    info.set(id, {
      ...base,
      population: c.population,
      valueIndex: c.valueIndex,
      valueTier: c.valueTier,
    })
  }

  return { seeds, info, importHealth }
}
