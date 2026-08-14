/**
 * Stages 3, 7, 8, 9 and 11 (§12): the running world.
 *
 * §15's world-as-spectacle: the default experience is mostly world, UI is
 * secondary, and the thing can be left running.
 */
import {
  DIVERGENCE_LABEL,
  EPOCH_YEAR,
  PURPOSE_INDEX,
  SPEEDS,
  type WorldSeed,
  tickToDate,
  tickToYear,
  yearToTick,
} from '@civ/core'
import { EVENT_TONE, MemoryStore, type WorldEvent } from '@civ/persistence'
import { Simulation, agentNetWorth, buildingValue } from '@civ/sim'
import { Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three'
import { CameraDirector } from './camera/director.ts'
import { CameraRig, attachRigControls } from './camera/rig.ts'
import { TiltShiftPass } from './postfx/tiltShift.ts'
import { AgentMarkers } from './render/agents.ts'
import { BuildingRenderer } from './render/buildingRenderer.ts'
import { configureRenderer, createEnvironment } from './render/environment.ts'
import { createRoadMeshes } from './render/roadMesh.ts'
import { ConstructionOverlay } from './render/scaffold.ts'
import { createSubstrateView } from './render/substrateMesh.ts'
import { SimBridge } from './world/bridge.ts'
import { loadChunk } from './world/load.ts'

const canvas = document.createElement('canvas')
document.body.insertBefore(canvas, document.body.firstChild)
const renderer = new WebGLRenderer({ canvas, antialias: true })
configureRenderer(renderer)

const scene = new Scene()
const { seed, items, statics } = await loadChunk()

const radius =
  Math.max(
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

const roads = createRoadMeshes(seed.roads.nodes, seed.roads.edges, substrate.groundY, HALF_EXTENT)
scene.add(roads.baseline)
scene.add(roads.agent)

const construction = new ConstructionOverlay()
scene.add(construction.scaffold)
scene.add(construction.siteMarks)

const agentMarkers = new AgentMarkers(160)
scene.add(agentMarkers.mesh)

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

const store = new MemoryStore()
const sim = new Simulation(seed as WorldSeed, store, {
  agentCount: 58,
  onYear(year, report) {
    bridge.sync()
    bridge.captureSnapshot(year, report.index, {
      touched: report.touchedShare,
      agentOrigin: report.agentOrigin,
      demolished: report.demolished,
    })
    availableYears.add(year)
    refreshDivergence()
  },
})
const bridge = new SimBridge(sim, buildings, roads.agent, substrate.groundY, store)
const availableYears = new Set<number>([EPOCH_YEAR])
bridge.captureSnapshot(EPOCH_YEAR, 0, {})

// ---------------------------------------------------------------------------
// camera and director
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

const director = new CameraDirector(rig, store, {
  locateBuilding(id) {
    const b = sim.world.buildings.get(id)
    if (!b || !b.footprint.length) return null
    return pointAt(b.footprint[0][0], b.footprint[0][1])
  },
  locateEdge(id) {
    const e = sim.world.edges.get(id)
    const n = e ? sim.world.nodes.get(e.b) : undefined
    return n ? pointAt(n.x, n.y) : null
  },
  locateAgent(id) {
    const a = sim.world.agents.get(id)
    return a ? pointAt(a.x, a.y) : null
  },
  locatePoint: (x, y) => pointAt(x, y),
  onShot(label) {
    el('shot').textContent = label
    el('shot').classList.add('on')
  },
})

function pointAt(x: number, y: number): Vector3 {
  return new Vector3(x, substrate.groundY, -y)
}

attachRigControls(rig, canvas, () => director.takeControl())

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
  `${buildings.triangles.toLocaleString()} triangles · 58 agents`
el('chunkProv').innerHTML = seed.provenance.map((p) => `${p.source} — ${p.licence}`).join('<br>')

let speedIndex = 0
const speeds = el('speeds')
speeds.innerHTML = SPEEDS.map(
  (s, i) => `<button data-i="${i}" aria-pressed="${i === 0}">${s.label}</button>`,
).join('')
speeds.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button')
  if (!btn) return
  speedIndex = Number(btn.dataset.i)
  for (const b of speeds.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.i) === speedIndex))
  }
  if (scrubbing) exitScrub()
})

const modeInput = el<HTMLInputElement>('mode')
const modeOut = el<HTMLOutputElement>('modeOut')
modeInput.addEventListener('input', () => {
  const v = Number(modeInput.value)
  buildings.setDivergenceMode(v)
  modeOut.value = v < 0.02 ? 'normal' : v > 0.98 ? 'divergence' : v.toFixed(2)
})

// §8's year scrub: same viewpoint, 2026 versus 2045, straight from snapshots
const scrub = el<HTMLInputElement>('scrub')
const scrubOut = el<HTMLOutputElement>('scrubOut')
let scrubbing = false
scrub.addEventListener('input', () => {
  const year = Number(scrub.value)
  if (year >= tickToYear(sim.tick)) {
    exitScrub()
    return
  }
  const nearest = [...availableYears].filter((y) => y <= year).sort((a, b) => b - a)[0]
  if (nearest === undefined) return
  scrubbing = true
  bridge.restoreSnapshot(nearest)
  scrubOut.value = String(nearest)
  const snap = store.snapshot(sim.world.chunkId, nearest)
  if (snap) setDivergenceReadout(snap.divergenceIndex, `${nearest} snapshot`)
})

function exitScrub(): void {
  if (!scrubbing) return
  scrubbing = false
  scrubOut.value = 'live'
  bridge.sync()
  refreshDivergence()
}

function refreshDivergence(): void {
  if (scrubbing) return
  const r = sim.report
  setDivergenceReadout(r.index, `baseline stock touched<br>${r.agentOrigin} agent-built`)
  scrub.max = String(Math.max(EPOCH_YEAR, tickToYear(sim.tick)))
}

function setDivergenceReadout(index: number, label: string): void {
  el('divN').textContent = `${(index * 100).toFixed(1)}%`
  el('divL').innerHTML = `divergence index<br>${label}`
}

// ---------------------------------------------------------------------------
// live feed (§8) — the world narrating itself
// ---------------------------------------------------------------------------

const feedList = el('feedList')
let lastFeedId = 0

function pumpFeed(): void {
  const fresh = store
    .events({ sinceTick: Math.max(0, sim.tick - 400), limit: 40, minWeight: 15 })
    .filter((e) => e.id > lastFeedId)
    .reverse()
  if (fresh.length === 0) return
  lastFeedId = Math.max(lastFeedId, ...fresh.map((e) => e.id))
  for (const e of fresh) feedList.insertAdjacentHTML('afterbegin', feedRow(e))
  while (feedList.childElementCount > 11) feedList.lastElementChild?.remove()
}

function feedRow(e: WorldEvent): string {
  const agent = e.agentId ? sim.world.agents.get(e.agentId)?.name : undefined
  const text = e.rationale ?? describe(e)
  return (
    `<div class="e"><span class="dot" style="background:${EVENT_TONE[e.type]}"></span>` +
    `<span class="yr">${tickToYear(e.tick)}</span>` +
    `<span class="t">${agent ? `<b>${escapeHtml(agent.split(' ')[0])}</b> ` : ''}${escapeHtml(text)}</span></div>`
  )
}

function describe(e: WorldEvent): string {
  return e.type.replace(/_/g, ' ')
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)
}

// ---------------------------------------------------------------------------
// inspection: provenance and lineage
// ---------------------------------------------------------------------------

const raycaster = new Raycaster()
const pointer = new Vector2()
const inspector = el('inspector')
let selectedIndex: number | null = null

canvas.addEventListener('click', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, rig.camera)
  select(buildings.pick(raycaster))
})
el('close').addEventListener('click', () => select(null))

function select(index: number | null): void {
  selectedIndex = index
  buildings.setHighlight(index ?? -1)
  if (index === null) {
    inspector.classList.remove('on')
    return
  }
  const id = buildings.idAt(index)
  const b = id ? sim.world.buildings.get(id) : undefined
  if (!b) {
    inspector.classList.remove('on')
    return
  }
  inspector.classList.add('on')

  const baseline = b.baselineId ? seed.buildings.find((x) => x.id === b.baselineId) : undefined
  const owner = b.ownerId ? sim.world.agents.get(b.ownerId) : undefined

  el('insTitle').textContent = b.name ?? titleFor(b.purpose, b.source)
  el('insSub').textContent =
    `${b.purpose} · ${DIVERGENCE_LABEL[b.divergence]}` +
    (b.state !== 'standing' ? ` · ${b.state.replace(/_/g, ' ')}` : '')

  el('insFacts').innerHTML = facts([
    ['Built', b.constructionYear ? String(b.constructionYear) : 'unknown'],
    ['Height', `${b.heightM.toFixed(1)} m`],
    ['Levels', String(b.levels)],
    ['Archetype', b.archetype],
    ['Condition', `${(b.condition * 100).toFixed(0)}%`],
    ['Owner', owner ? `${owner.name} (g${owner.generation})` : 'unowned'],
    ['Value', buildingValue(sim.world, b).toFixed(0)],
    ['Yield', `${(b.yieldPerTick * 365).toFixed(1)} / yr`],
    ...(baseline
      ? ([
          ['Was', `${baseline.purpose}, ${baseline.levels} levels`],
          ['BAG id', baseline.bagId?.replace('NL.IMBAG.Pand.', '') ?? '—'],
        ] as Array<[string, string]>)
      : ([['Origin', 'built by an agent']] as Array<[string, string]>)),
  ])

  // §5: clicking a 2045 tower should walk back to the warehouse under it
  const chain = lineage(b.id)
  const history = store.events({ buildingId: b.id, limit: 14 })
  const box = el('insLineageBox')
  if (chain.length > 1 || history.length > 0) {
    box.classList.remove('hidden')
    el('insLineage').innerHTML =
      chain
        .map(
          (c) =>
            `<div class="step"><span class="yr">${c.year}</span><span>${escapeHtml(c.text)}</span></div>`,
        )
        .join('') +
      history
        .slice(0, 8)
        .reverse()
        .map(
          (e) =>
            `<div class="step"><span class="yr">${tickToYear(e.tick)}</span><span>${escapeHtml(
              e.rationale ?? describe(e),
            )}</span></div>`,
        )
        .join('')
  } else {
    box.classList.add('hidden')
  }
}

function lineage(id: string): Array<{ year: number; text: string }> {
  const out: Array<{ year: number; text: string }> = []
  let cur = sim.world.buildings.get(id)
  let guard = 0
  while (cur && guard++ < 8) {
    out.push({
      year: cur.constructionYear ?? EPOCH_YEAR,
      text:
        cur.source === 'agent_built'
          ? `agent-built ${cur.purpose}, ${cur.levels} levels`
          : `${cur.purpose}${cur.demolishedTick !== undefined ? ' — demolished' : ''}`,
    })
    cur = cur.replaces ? sim.world.buildings.get(cur.replaces) : undefined
  }
  return out.reverse()
}

function titleFor(purpose: string, source: string): string {
  const p = purpose.charAt(0).toUpperCase() + purpose.slice(1)
  return source === 'agent_built' ? `${p} — agent built` : `${p} building`
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

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

let last = performance.now()
let stepping = false
let clock = 0

renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  clock += dt

  const tps = SPEEDS[speedIndex].ticksPerSecond
  if (tps > 0 && !stepping && !scrubbing) {
    // budgeted so a fast speed never starves the frame (§3's month-per-second)
    stepping = true
    void sim.runBudgeted(Math.ceil(tps * dt) + 1, 7).then(() => {
      stepping = false
      bridge.sync()
      pumpFeed()
      refreshDivergence()
    })
  }

  const d = tickToDate(sim.tick)
  el('date').textContent = `${d.day} ${MONTHS[d.month - 1]} ${d.year}`
  if (!scrubbing) scrub.value = String(tickToYear(sim.tick))

  rig.update(dt)
  director.update(dt, sim.tick)
  if (!director.inControl) el('shot').classList.remove('on')

  agentMarkers.update(sim.world.agents.values(), substrate.groundY, dt, tps, clock)
  construction.update(sim.world.buildings.values(), clock)

  if (scene.fog && 'near' in scene.fog) {
    scene.fog.near = rig.distance * 0.8
    scene.fog.far = rig.distance * 2.1
  }
  env.sky.position.copy(rig.camera.position)

  tiltShift.focusRange = Math.max(30, rig.distance * 0.055)
  tiltShift.render(renderer, scene, rig.camera, rig.distance, 1 - rig.streetness * 0.85)
})

// ambient mode: §15's "leave it running"
function toggleAmbient(): void {
  director.enabled = !director.enabled
  el('ambient').setAttribute('aria-pressed', String(director.enabled))
}
el('ambient').addEventListener('click', toggleAmbient)
addEventListener('keydown', (e) => {
  if (e.key === 'a') toggleAmbient()
})

// exposed for tooling and for driving screenshots
;(window as unknown as Record<string, unknown>).civ = {
  rig,
  sim,
  store,
  buildings,
  bridge,
  director,
  select,
  setSpeed(i: number) {
    speedIndex = i
    for (const b of speeds.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.i) === speedIndex))
    }
  },
  setMode(v: number) {
    modeInput.value = String(v)
    modeInput.dispatchEvent(new Event('input'))
  },
  async runYears(years: number) {
    director.takeControl()
    await sim.run(Math.round(years * 365))
    bridge.sync()
    pumpFeed()
    refreshDivergence()
    scrub.max = String(tickToYear(sim.tick))
  },
  scrubTo(year: number) {
    scrub.value = String(year)
    scrub.dispatchEvent(new Event('input'))
  },
  netWorth: (id: string) => {
    const a = sim.world.agents.get(id)
    return a ? agentNetWorth(sim.world, a) : 0
  },
  yearToTick,
  get selected() {
    return selectedIndex
  },
}
