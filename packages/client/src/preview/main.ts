/**
 * Stage 2 (§16.1): a static archetype preview harness.
 *
 * "Iterating on the generator against the live sim is slow and miserable.
 * Iterating against the harness is fast." Nothing here loads the simulation;
 * it renders one of each archetype across a range of footprints and heights,
 * and can swap in real footprints from the imported chunk to check what the
 * selector actually does to the inherited stock.
 */
import {
  ARCHETYPES,
  type ArchetypeId,
  type Purpose,
  PURPOSE_INDEX,
  type Ring,
  type RoofHint,
  type WorldSeed,
  generateArchetype,
  makeRng,
  selectArchetype,
} from '@civ/core'
import { Mesh, Scene, Vector3, WebGLRenderer } from 'three'
import { CameraRig, TOOL_LENS, attachRigControls } from '../camera/rig.ts'
import { type BatchItem, buildBatch } from '../render/batch.ts'
import { BuildingDataTexture } from '../render/buildingData.ts'
import { createBuildingMaterial } from '../render/buildingMaterial.ts'
import { createPreviewEnvironment, createPreviewGround } from '../render/environment.ts'
import { roofToneFor } from '../render/tones.ts'

const canvas = document.createElement('canvas')
document.body.appendChild(canvas)
const renderer = new WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true

const scene = new Scene()
createPreviewEnvironment(scene)
scene.add(createPreviewGround(2000))

const rig = new CameraRig(innerWidth / innerHeight, TOOL_LENS)
rig.limits.panRadius = 900
rig.limits.maxDistance = 3200
rig.limits.minDistance = 30
const FRAME = rig.distanceToFrame(760)
rig.distance = FRAME
rig.azimuth = 0.32
rig.polar = 0.62
rig.flyTo(new Vector3(0, 0, 0), FRAME, { azimuth: 0.32, polar: 0.62, duration: 0.01 })
attachRigControls(rig, canvas)

// exposed so tools/shot.mjs can frame a single row while iterating on a form
;(window as unknown as Record<string, unknown>).civPreview = {
  rig,
  focus(archetype: string, distance = 70) {
    const row = ARCHETYPES.indexOf(archetype as ArchetypeId)
    if (row < 0) return
    rig.flyTo(new Vector3(0, 6, row * ROW_SPACING - centreZ()), distance, {
      azimuth: 0.5,
      polar: 0.82,
      duration: 0.01,
    })
  },
}

// ---------------------------------------------------------------------------
// footprint fixtures — the shapes the generator has to survive
// ---------------------------------------------------------------------------

const rect = (w: number, d: number): Ring => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, d / 2],
  [-w / 2, d / 2],
]

const lShape = (w: number, d: number): Ring => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, 0],
  [0, 0],
  [0, d / 2],
  [-w / 2, d / 2],
]

function irregular(seedKey: string, r: number, n = 7): Ring {
  const rng = makeRng(seedKey)
  const out: Ring = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const rad = r * (0.66 + rng() * 0.55)
    out.push([Math.cos(a) * rad, Math.sin(a) * rad])
  }
  return out
}

interface Variant {
  label: string
  footprint: Ring
  levels: number
  /** metres at the midpoint of the height slider */
  baseHeight: number
}

const VARIANTS: Variant[] = [
  { label: 'narrow 6×13', footprint: rect(6, 13), levels: 3, baseHeight: 10 },
  { label: 'wide 19×11', footprint: rect(19, 11), levels: 3, baseHeight: 11 },
  { label: 'square 15×15', footprint: rect(15, 15), levels: 4, baseHeight: 13 },
  { label: 'L-plan 22×16', footprint: lShape(22, 16), levels: 3, baseHeight: 11 },
  { label: 'irregular r=11', footprint: irregular('preview-irr', 11), levels: 3, baseHeight: 11 },
  { label: 'large 44×24', footprint: rect(44, 24), levels: 2, baseHeight: 12 },
]

const PURPOSE_FOR: Record<ArchetypeId, Purpose> = {
  rowhouse: 'residential',
  apartment: 'residential',
  warehouse: 'industrial',
  industrial: 'industrial',
  civic: 'civic',
  retail: 'retail',
  tower: 'office',
  agricultural: 'agricultural',
  agent_block: 'residential',
  agent_slab: 'residential',
  agent_tower: 'office',
  agent_hall: 'commercial',
}

// ---------------------------------------------------------------------------
// build / rebuild
// ---------------------------------------------------------------------------

const COL_SPACING = 56
const ROW_SPACING = 50

let mesh: Mesh | null = null
let labels: Array<{ el: HTMLDivElement; pos: Vector3 }> = []
const labelHost = document.getElementById('labels') as HTMLDivElement

const ui = {
  height: document.getElementById('height') as HTMLInputElement,
  heightOut: document.getElementById('heightOut') as HTMLOutputElement,
  year: document.getElementById('year') as HTMLInputElement,
  yearOut: document.getElementById('yearOut') as HTMLOutputElement,
  roof: document.getElementById('roof') as HTMLSelectElement,
  stats: document.getElementById('stats') as HTMLDivElement,
  mode: document.getElementById('mode') as HTMLDivElement,
}

let mode: 'grid' | 'real' = 'grid'
let realSeed: WorldSeed | null = null

function heightScale(): number {
  // 0..1 slider -> 0.45x .. 3.2x the variant's base height
  const t = Number(ui.height.value)
  return 0.45 + t * t * 2.75
}

function rebuild(): void {
  if (mesh) {
    scene.remove(mesh)
    mesh.geometry.dispose()
    mesh = null
  }
  for (const l of labels) l.el.remove()
  labels = []

  const items: BatchItem[] = []
  const statics: Array<{ tone: number; jitter: number; era: number; agent: boolean; purpose: Purpose }> = []
  let triangles = 0

  if (mode === 'grid') {
    const scale = heightScale()
    const year = Number(ui.year.value)
    const roofHint = ui.roof.value as RoofHint

    ARCHETYPES.forEach((archetype, row) => {
      addLabel(
        `<b>${archetype}</b>`,
        new Vector3(-COL_SPACING * (VARIANTS.length / 2 + 0.55), 0, row * ROW_SPACING - centreZ()),
      )
      VARIANTS.forEach((variant, col) => {
        const heightM = Math.max(3, variant.baseHeight * scale)
        const levels = Math.max(1, Math.round(heightM / 3.2))
        const purpose = PURPOSE_FOR[archetype]
        const out = generateArchetype(
          {
            footprint: variant.footprint,
            heightM,
            levels,
            purpose,
            constructionYear: year,
            source: archetype.startsWith('agent_') ? 'agent_built' : 'real_world',
            roofHint,
          },
          `${archetype}-${col}`,
          archetype,
        )
        triangles += out.mesh.triangleCount
        const x = (col - (VARIANTS.length - 1) / 2) * COL_SPACING
        const z = row * ROW_SPACING - centreZ()
        items.push({ id: `${archetype}-${col}`, mesh: translate(out.mesh, x, z), baseY: 0 })
        statics.push({
          tone: roofToneFor(archetype, out.roof, year),
          jitter: (col * 37) % 100 / 100,
          era: eraTint(year),
          agent: archetype.startsWith('agent_'),
          purpose,
        })
        if (row === 0) {
          addLabel(`<span>${variant.label}</span>`, new Vector3(x, 0, -centreZ() - ROW_SPACING * 0.62))
        }
      })
    })
  } else if (realSeed) {
    // real footprints, real heights, real years — what the selector actually does
    const sample = realSeed.buildings.slice(0, 240)
    const cols = 16
    sample.forEach((b, i) => {
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
      triangles += out.mesh.triangleCount
      const x = ((i % cols) - cols / 2) * 34
      const z = Math.floor(i / cols) * 34 - 120
      const c = centroidOf(b.footprint)
      items.push({ id: b.id, mesh: translate(out.mesh, x - c[0], z + c[1]), baseY: 0 })
      statics.push({
        tone: roofToneFor(out.archetype, out.roof, b.constructionYear ?? 1900, out.metrics.area),
        jitter: (i * 53) % 100 / 100,
        era: eraTint(b.constructionYear ?? 1900),
        agent: false,
        purpose: b.purpose,
      })
    })
  }

  if (items.length === 0) return

  const batch = buildBatch(items)
  const data = new BuildingDataTexture(items.length)
  statics.forEach((s, i) => {
    data.setStatic(i, s.tone, s.jitter, s.era, s.agent)
    data.set(i, 1, 0, PURPOSE_INDEX[s.purpose], 1)
  })
  data.flush()

  const material = createBuildingMaterial(data)
  mesh = new Mesh(batch.geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  scene.add(mesh)

  ui.stats.innerHTML =
    `${items.length} masses · ${triangles.toLocaleString()} triangles · 1 draw call<br>` +
    (mode === 'grid'
      ? `${ARCHETYPES.length} archetypes × ${VARIANTS.length} footprints`
      : `${items.length} real buildings — ${describeSelection()}`)
}

function centreZ(): number {
  return ((ARCHETYPES.length - 1) * ROW_SPACING) / 2
}

function describeSelection(): string {
  if (!realSeed) return ''
  const counts = new Map<string, number>()
  for (const b of realSeed.buildings.slice(0, 240)) {
    const a = selectArchetype({
      footprint: b.footprint,
      heightM: b.heightM,
      levels: b.levels,
      purpose: b.purpose,
      constructionYear: b.constructionYear,
      source: 'real_world',
      roofHint: b.roofHint,
    }).archetype
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
}

function translate(m: ReturnType<typeof generateArchetype>['mesh'], dx: number, dz: number) {
  const p = m.positions.slice()
  for (let i = 0; i < p.length; i += 3) {
    p[i] += dx
    p[i + 2] += dz
  }
  return { ...m, positions: p }
}

function centroidOf(ring: Ring): [number, number] {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

function eraTint(year: number): number {
  // older stock reads warmer; 1650 -> 1, 2045 -> 0
  return Math.max(0, Math.min(1, (2000 - year) / 300))
}

function addLabel(html: string, pos: Vector3): void {
  const el = document.createElement('div')
  el.className = 'label'
  el.innerHTML = html
  labelHost.appendChild(el)
  labels.push({ el, pos })
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

for (const input of [ui.height, ui.year]) {
  input.addEventListener('input', () => {
    syncOutputs()
    rebuild()
  })
}
ui.roof.addEventListener('change', rebuild)

ui.mode.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button')
  if (!btn) return
  mode = btn.dataset.mode as 'grid' | 'real'
  for (const b of ui.mode.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === btn))
  }
  if (mode === 'real' && !realSeed) {
    const index = await fetch('/world/index.json').then((r) => r.json())
    realSeed = await fetch(`/world/${index.chunks[0].file}`).then((r) => r.json())
  }
  rebuild()
})

function syncOutputs(): void {
  ui.heightOut.value = `${heightScale().toFixed(2)}×`
  ui.yearOut.value = ui.year.value
}

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false)
  rig.setAspect(innerWidth / innerHeight)
}
addEventListener('resize', resize)
resize()
syncOutputs()
rebuild()

const projected = new Vector3()
let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  rig.update(dt)

  for (const l of labels) {
    projected.copy(l.pos).project(rig.camera)
    const visible = projected.z < 1
    l.el.style.display = visible ? 'block' : 'none'
    if (visible) {
      l.el.style.left = `${((projected.x + 1) / 2) * innerWidth}px`
      l.el.style.top = `${((-projected.y + 1) / 2) * innerHeight}px`
    }
  }

  renderer.render(scene, rig.camera)
})
