/**
 * Stage 3 (§12): render day 0.
 *
 * "A recognisable real place, rendered as a stylized miniature, clickable,
 * before a single agent exists." Nothing in this file simulates anything.
 */
import { DIVERGENCE_LABEL, PURPOSE_INDEX, indexNodes, type WorldSeed } from '@civ/core'
import { Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three'
import { CameraRig, attachRigControls } from './camera/rig.ts'
import { TiltShiftPass } from './postfx/tiltShift.ts'
import { BuildingRenderer } from './render/buildingRenderer.ts'
import { configureRenderer, createEnvironment } from './render/environment.ts'
import { createRoadMeshes } from './render/roadMesh.ts'
import { createSubstrateView } from './render/substrateMesh.ts'
import { loadChunk } from './world/load.ts'

const canvas = document.createElement('canvas')
document.body.insertBefore(canvas, document.body.firstChild)

const renderer = new WebGLRenderer({ canvas, antialias: true })
configureRenderer(renderer)

const scene = new Scene()
const { seed, items, statics } = await loadChunk()

const radius = Math.max(
  seed.chunk.localBounds.maxX - seed.chunk.localBounds.minX,
  seed.chunk.localBounds.maxY - seed.chunk.localBounds.minY,
) / 2

// the plate stops just past the chunk, so the world reads as an object
const HALF_EXTENT = radius + 22
const substrate = createSubstrateView(seed.substrate, HALF_EXTENT)
scene.add(substrate.group)

const env = createEnvironment(scene, { radius, groundY: substrate.groundY })

const buildings = new BuildingRenderer(items, seed.buildings.length + 900)
seed.buildings.forEach((b, i) => {
  const s = statics[i]
  buildings.data.setStatic(i, s.roofTone, s.jitter, s.era, s.agent)
  buildings.data.set(i, 1, 0, PURPOSE_INDEX[b.purpose], 1)
})
buildings.flush()
scene.add(buildings.group)

const nodeIndex = indexNodes(seed.roads.nodes)
const roads = createRoadMeshes(seed.roads.nodes, seed.roads.edges, substrate.groundY, HALF_EXTENT)
scene.add(roads.baseline)
scene.add(roads.agent)

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------

const rig = new CameraRig(innerWidth / innerHeight)
rig.limits.panRadius = radius * 1.1
const CITY_FRAMING = rig.distanceToFrame(radius * 2.3)
rig.limits.maxDistance = CITY_FRAMING * 1.25
rig.distance = CITY_FRAMING
rig.target.set(0, substrate.groundY, 0)
rig.flyTo(new Vector3(0, substrate.groundY, 0), CITY_FRAMING, {
  azimuth: -0.5,
  polar: 0.66,
  duration: 0.01,
})
attachRigControls(rig, canvas, () => {
  /* stage 11 hands control back to the director on idle */
})

const tiltShift = new TiltShiftPass(innerWidth, innerHeight)

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

el('chunkName').textContent = seed.chunk.name
el('chunkNote').textContent = seed.chunk.sourceNote
el('chunkStats').innerHTML =
  `${seed.stats.baselineBuildings} baseline buildings · ${seed.stats.areaKm2} km²<br>` +
  `${seed.stats.parcels} parcels (${seed.stats.vacantParcels} vacant) · ${seed.stats.blocks} blocks<br>` +
  `${buildings.triangles.toLocaleString()} triangles · ${buildings.drawCalls} draw call`
el('chunkProv').innerHTML = seed.provenance
  .map((p) => `${p.source} — ${p.licence}`)
  .join('<br>')

el('date').textContent = '1 January 2026'

// no simulation yet: the speed control exists so stage 4 has somewhere to land
const speeds = el('speeds')
speeds.innerHTML = '<button aria-pressed="true" disabled>day 0</button>'

const modeInput = el<HTMLInputElement>('mode')
const modeOut = el<HTMLOutputElement>('modeOut')
modeInput.addEventListener('input', () => {
  const v = Number(modeInput.value)
  buildings.setDivergenceMode(v)
  modeOut.value = v < 0.02 ? 'normal' : v > 0.98 ? 'divergence' : v.toFixed(2)
})

const scrub = el<HTMLInputElement>('scrub')
scrub.disabled = true
el<HTMLOutputElement>('scrubOut').value = '2026'

// ---------------------------------------------------------------------------
// picking
// ---------------------------------------------------------------------------

const raycaster = new Raycaster()
const pointer = new Vector2()
const inspector = el('inspector')
let selected: number | null = null

canvas.addEventListener('click', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, rig.camera)
  const index = buildings.pick(raycaster)
  select(index)
})

el('close').addEventListener('click', () => select(null))

function select(index: number | null): void {
  selected = index
  buildings.setHighlight(index ?? -1)
  if (index === null || index >= seed.buildings.length) {
    inspector.classList.remove('on')
    return
  }
  const b = seed.buildings[index]
  inspector.classList.add('on')
  el('insTitle').textContent = b.name ?? titleFor(b.purpose)
  el('insSub').textContent = `${b.purpose} · untouched real`
  el('insFacts').innerHTML = facts([
    ['Built', b.constructionYear ? String(b.constructionYear) : 'unknown'],
    ['Height', `${b.heightM.toFixed(1)} m`],
    ['Levels', String(b.levels)],
    ['Archetype', b.archetype],
    ['Divergence', DIVERGENCE_LABEL[0]],
    ['BAG id', b.bagId?.replace('NL.IMBAG.Pand.', '') ?? '—'],
    ['OSM', b.osmId ?? 'no tag match'],
  ])
  el('insLineageBox').classList.add('hidden')
}

function titleFor(purpose: string): string {
  return purpose.charAt(0).toUpperCase() + purpose.slice(1) + ' building'
}

function facts(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false)
  rig.setAspect(innerWidth / innerHeight)
  const pr = renderer.getPixelRatio()
  tiltShift.setSize(Math.floor(innerWidth * pr), Math.floor(innerHeight * pr))
}
addEventListener('resize', resize)
resize()

el('loading').remove()

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now

  rig.update(dt)

  // §16.3: ortho-ish framing kills perspective falloff, so fog is explicit and
  // scaled to the camera distance rather than to the world.
  if (scene.fog && 'near' in scene.fog) {
    scene.fog.near = rig.distance * 0.8
    scene.fog.far = rig.distance * 2.1
  }
  env.sky.position.copy(rig.camera.position)

  tiltShift.focusRange = Math.max(30, rig.distance * 0.055)
  // the miniature read is a city-scale effect; at street level it is just blur
  const strength = 1 - rig.streetness * 0.85
  tiltShift.render(renderer, scene, rig.camera, rig.distance, strength)
})

// expose for tooling and for the stages that follow
;(window as unknown as Record<string, unknown>).civ = {
  rig,
  buildings,
  seed: seed as WorldSeed,
  substrate,
  roads,
  nodeIndex,
  select,
  get selected() {
    return selected
  },
}
