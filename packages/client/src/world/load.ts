import {
  type BaselineBuilding,
  type WorldSeed,
  generateArchetype,
  selectRoof,
  footprintMetrics,
} from '@civ/core'
import type { BatchItem } from '../render/batch.ts'
import { eraTint, jitterFor, roofToneFor } from '../render/tones.ts'

export interface ChunkEntry {
  id: string
  name: string
  file: string
}

export interface LoadedChunk {
  seed: WorldSeed
  items: BatchItem[]
  statics: Array<{ roofTone: number; jitter: number; era: number; agent: boolean }>
  /** every chunk the index lists — §36.1's switcher reads this */
  chunks: ChunkEntry[]
  entry: ChunkEntry
  /** §36.1: one server per chunk, so the switcher needs to know where each
   *  world lives. Optional static file; absent means the default url applies. */
  servers: Record<string, string>
}

export async function loadChunk(base = '/world'): Promise<LoadedChunk> {
  const [index, servers] = await Promise.all([
    (await fetch(`${base}/index.json`)).json() as Promise<{ chunks: ChunkEntry[] }>,
    fetch(`${base}/servers.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : ({} as Record<string, string>)))
      .catch(() => ({}) as Record<string, string>),
  ])
  // §31: the index now lists more than one chunk. ?chunk= selects; the default
  // stays the first entry. The real fix is selecting by the server's hello,
  // which lands with the multi-chunk client (§31.6-6).
  const want = new URLSearchParams(location.search).get('chunk')
  const entry = index.chunks.find((c) => c.id === want) ?? index.chunks[0]
  const seed = (await (await fetch(`${base}/${entry.file}`)).json()) as WorldSeed

  const items: BatchItem[] = []
  const statics: LoadedChunk['statics'] = []

  for (const b of seed.buildings) {
    const out = generateArchetype(
      {
        footprint: b.footprint,
        heightM: b.heightM,
        levels: b.levels,
        purpose: b.purpose,
        constructionYear: b.constructionYear,
        source: 'real_world',
        roofHint: b.roofHint,
      },
      b.id,
    )
    items.push({ id: b.id, mesh: out.mesh, baseY: b.groundM })
    statics.push({
      roofTone: roofToneFor(out.archetype, out.roof, b.constructionYear ?? 1900, out.metrics.area),
      jitter: jitterFor(b.id),
      era: eraTint(b.constructionYear),
      agent: false,
    })
  }

  return { seed, items, statics, chunks: index.chunks, entry, servers }
}

/** Static texture values for a building the simulation has just created. */
export function staticsForAgentBuilding(b: BaselineBuilding & { archetype: string }): {
  roofTone: number
  jitter: number
  era: number
  agent: boolean
} {
  const m = footprintMetrics(b.footprint)
  const roof = selectRoof(b.archetype as never, m, b.roofHint, b.constructionYear ?? 2030)
  return {
    roofTone: roofToneFor(b.archetype as never, roof, b.constructionYear ?? 2030, m.area),
    jitter: jitterFor(b.id),
    era: 0,
    agent: true,
  }
}
