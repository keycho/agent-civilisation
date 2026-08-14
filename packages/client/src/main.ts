/**
 * Stages 3, 7, 8, 9 and 11 (§12): the running world, watched.
 *
 * §15's world-as-spectacle: the default experience is mostly world, UI is
 * secondary, and the thing can be left running.
 *
 * §21.6: and it is not this process that runs it. There is no `Simulation`
 * here, no `World`, no store and no rng — one server owns those and every
 * viewer is looking at the same one. What is left in this file is a renderer, a
 * camera, and a socket.
 */
import {
  AGENT_MOTION_MAX_THROUGHPUT,
  BUILDING_SLOT_SPARE,
  DIVERGENCE_LABEL,
  EVENT_TONE,
  PURPOSE_INDEX,
} from '@civ/core'
import type { BuildingDetail, EventWire, Frame, Hello, Readouts, ScrubResult } from '@civ/protocol'
import { FRAME_INTERVAL_MS } from '@civ/protocol'
import { Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three'
import { CameraDirector } from './camera/director.ts'
import { CameraRig, attachRigControls } from './camera/rig.ts'
import { TiltShiftPass } from './postfx/tiltShift.ts'
import { AgentMarkers, type AgentPresence } from './render/agents.ts'
import { BuildingRenderer } from './render/buildingRenderer.ts'
import { configureRenderer, createEnvironment } from './render/environment.ts'
import { createRoadMeshes } from './render/roadMesh.ts'
import { ConstructionOverlay } from './render/scaffold.ts'
import { createSubstrateView } from './render/substrateMesh.ts'
import { AgentInterpolator, Connection, fromBase64 } from './world/connection.ts'
import { loadChunk } from './world/load.ts'
import { Observer } from './world/observer.ts'

const canvas = document.createElement('canvas')
document.body.insertBefore(canvas, document.body.firstChild)
const renderer = new WebGLRenderer({ canvas, antialias: true })
configureRenderer(renderer)

const scene = new Scene()
// The baseline is immutable and served as a static file (§5, §21.6): it never
// travels over the socket, and every viewer already has the same copy.
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

const buildings = new BuildingRenderer(items, seed.buildings.length + BUILDING_SLOT_SPARE)
seed.buildings.forEach((b, i) => {
  const s = statics[i]
  buildings.data.setStatic(i, s.roofTone, s.jitter, s.era, s.agent)
  buildings.data.set(i, 1, 0, PURPOSE_INDEX[b.purpose], 1)
})
buildings.flush()
scene.add(buildings.group)

const roads = createRoadMeshes(seed.roads.nodes, seed.roads.edges, substrate.heightAt, HALF_EXTENT)
scene.add(roads.baseline)
scene.add(roads.agent)

const construction = new ConstructionOverlay()
scene.add(construction.scaffold)
scene.add(construction.siteMarks)

const agentMarkers = new AgentMarkers(200)
scene.add(agentMarkers.mesh)

// ---------------------------------------------------------------------------
// the connection to the world (§21.6)
// ---------------------------------------------------------------------------

const observer = new Observer(seed, buildings, roads.agent, substrate.heightAt)
const presence = new AgentInterpolator(FRAME_INTERVAL_MS)
/** Who each agent is, remembered from birth — the wire only sends where. */
const roster = new Map<string, { name: string; strategy: string; colourIndex: number; generation: number }>()
/** Where things happened, so §17's director can point the camera at them. */
const places = new Map<string, [number, number]>()

let readouts: Readouts | null = null
let durability: Hello['durability'] = 'memory'
let scrubbing = false
let liveTick = 0

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const connection = new Connection(serverUrl(), {
  onHello(h: Hello) {
    for (const a of h.agents) roster.set(a.id, a)
    observer.applyHello(h)
    for (const e of h.events) pushFeedRow(e)
    durability = h.durability
    acceptReadouts(h.readouts)
  },
  onFrame(f: Frame) {
    for (const a of f.born) roster.set(a.id, a)
    for (const id of f.retired) roster.delete(id)
    observer.applyFrame(f)
    presence.accept(f.agents, f.retired)
    for (const e of f.events) {
      if (e.x !== undefined && e.y !== undefined && e.buildingId) places.set(e.buildingId, [e.x, e.y])
      pushFeedRow(e)
      director.consider(e)
    }
    acceptReadouts(f.readouts)
  },
  onScrub(s: ScrubResult) {
    observer.applyScrubTexture(fromBase64(s.buildingData))
    scrubbing = true
    scrubOut.value = `gen ${s.generation}`
    setReadouts(s.divergenceIndex, s.generation, 'at this point in the record')
  },
  onBuilding(b: BuildingDetail) {
    showInspector(b)
  },
  onStatus(state) {
    el('link').textContent =
      state === 'live' ? 'live' : state === 'connecting' ? 'connecting…' : 'reconnecting…'
    el('link').className = state
  },
})

/**
 * Where the world is. Vercel serves this file; the sim server is elsewhere, so
 * the origin cannot be assumed.
 */
function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server')
  if (override) return override
  const configured = (import.meta as { env?: Record<string, string> }).env?.VITE_SERVER_URL
  if (configured) return configured
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.hostname}:8787`
}

function acceptReadouts(r: Readouts): void {
  readouts = r
  liveTick = r.tick
  el('pace').textContent = r.pace.label
  el('season').textContent = `season ${r.season}`
  // §22.5: the presence-marker threshold, keyed off the server's rate
  presence.motion = r.pace.decisionsPerSecond <= AGENT_MOTION_MAX_THROUGHPUT
  el('durability').textContent =
    `${r.viewers} watching` + (durability === 'postgres' ? '' : ' · in memory')
  if (scrubbing) return
  setReadouts(r.divergenceIndex, r.generation, `baseline stock touched · ${r.agentOrigin} agent-built`)
  scrub.max = String(Math.max(1, r.eventCount))
  scrub.value = String(r.eventCount)
}

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

const director = new CameraDirector(rig, {
  locateBuilding(id) {
    const at = places.get(id)
    return at ? pointAt(at[0], at[1]) : null
  },
  locateAgent(id) {
    for (const a of presence.positions()) if (a.id === id) return pointAt(a.x, a.y)
    return null
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

el('chunkName').textContent = seed.chunk.name
el('chunkNote').textContent = seed.chunk.sourceNote
el('chunkStats').innerHTML =
  `${seed.stats.baselineBuildings} baseline buildings · ${seed.stats.areaKm2} km²<br>` +
  `${seed.stats.parcels} parcels (${seed.stats.vacantParcels} vacant) · ${seed.stats.blocks} blocks<br>` +
  `${buildings.triangles.toLocaleString()} triangles`
el('chunkProv').innerHTML = seed.provenance.map((p) => `${p.source} — ${p.licence}`).join('<br>')

const modeInput = el<HTMLInputElement>('mode')
const modeOut = el<HTMLOutputElement>('modeOut')
modeInput.addEventListener('input', () => {
  const v = Number(modeInput.value)
  buildings.setDivergenceMode(v)
  modeOut.value = v < 0.02 ? 'normal' : v > 0.98 ? 'divergence' : v.toFixed(2)
})

/**
 * §20.4: the scrub travels the event log, keyed on event ordinal, and its
 * handle is labelled by generation. §21.6: and it is a question asked of the
 * server, not a read of this tab's memory — which is what makes it the same
 * history for everyone watching, and what makes it survive a refresh.
 */
const scrub = el<HTMLInputElement>('scrub')
const scrubOut = el<HTMLOutputElement>('scrubOut')
scrub.addEventListener('input', () => {
  const ordinal = Number(scrub.value)
  if (readouts && ordinal >= readouts.eventCount) {
    exitScrub()
    return
  }
  connection.send({ t: 'scrub', ordinal })
})

function exitScrub(): void {
  if (!scrubbing) return
  scrubbing = false
  scrubOut.value = 'live'
  // rejoin the world where it is now: ask for the current texture again
  connection.close()
  location.reload()
}

/** §20.6: divergence index primary, generation secondary, no third readout. */
function setReadouts(index: number, generation: number, label: string): void {
  el('divN').textContent = `${(index * 100).toFixed(1)}%`
  el('divL').innerHTML = `divergence index<br>${label}`
  el('genN').textContent = `generation ${generation}`
}

// ---------------------------------------------------------------------------
// live feed (§8) — the world narrating itself
// ---------------------------------------------------------------------------

const feedList = el('feedList')
let lastFeedId = 0

function pushFeedRow(e: EventWire): void {
  if (e.id <= lastFeedId) return
  lastFeedId = e.id
  const who = e.agentId ? roster.get(e.agentId) : undefined
  const text = e.rationale ?? e.type.replace(/_/g, ' ')
  // §20.2: the feed never prints the tick. Generation is the public vocabulary.
  feedList.insertAdjacentHTML(
    'afterbegin',
    `<div class="e"><span class="dot" style="background:${EVENT_TONE[e.type]}"></span>` +
      `<span class="yr">g${who?.generation ?? e.generation}</span>` +
      `<span class="t">${
        e.agentName ? `<b>${escapeHtml(e.agentName.split(' ')[0])}</b> ` : ''
      }${escapeHtml(text)}</span></div>`,
  )
  while (feedList.childElementCount > 11) feedList.lastElementChild?.remove()
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)
}

// ---------------------------------------------------------------------------
// inspection: provenance and lineage, answered by the writer
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
  const id = observer.idAt(index)
  if (!id) {
    inspector.classList.remove('on')
    return
  }
  // §21.6: what this building is, and what happened to it, is a server query.
  connection.send({ t: 'inspect', buildingId: id })
}

function showInspector(b: BuildingDetail): void {
  if (!b.found) {
    inspector.classList.remove('on')
    return
  }
  inspector.classList.add('on')
  el('insTitle').textContent = b.name ?? titleFor(b.purpose ?? 'building', b.divergence ?? 0)
  el('insSub').textContent =
    `${b.purpose} · ${DIVERGENCE_LABEL[b.divergence ?? 0]}` +
    (b.state && b.state !== 'standing' ? ` · ${b.state.replace(/_/g, ' ')}` : '')

  el('insFacts').innerHTML = facts([
    // §20.1: a real building's construction year is a fact about it, the same
    // kind of fact as its footprint. It stays, and it is shown.
    ['Built', b.constructionYear ? String(b.constructionYear) : 'agent-built, new'],
    ['Height', `${(b.heightM ?? 0).toFixed(1)} m`],
    ['Levels', String(b.levels ?? 0)],
    ['Archetype', b.archetype ?? '—'],
    ['Condition', `${((b.condition ?? 0) * 100).toFixed(0)}%`],
    ['Owner', b.ownerName ? `${b.ownerName} (gen ${b.ownerGeneration})` : 'unowned'],
    ['Value', (b.value ?? 0).toFixed(0)],
    ...(b.baseline
      ? ([
          ['Was', `${b.baseline.purpose}, ${b.baseline.levels} levels`],
          ['BAG id', b.baseline.bagId?.replace('NL.IMBAG.Pand.', '') ?? '—'],
        ] as Array<[string, string]>)
      : ([['Origin', 'built by an agent']] as Array<[string, string]>)),
  ])

  // §5: clicking a 2045 tower should walk back to the warehouse under it
  const box = el('insLineageBox')
  const steps = [...b.lineage, ...b.history]
  if (steps.length > 1) {
    box.classList.remove('hidden')
    el('insLineage').innerHTML = steps
      .map(
        (c) =>
          `<div class="step"><span class="yr">${escapeHtml(c.label)}</span><span>${escapeHtml(
            c.text,
          )}</span></div>`,
      )
      .join('')
  } else {
    box.classList.add('hidden')
  }
}

function titleFor(purpose: string, divergence: number): string {
  const p = purpose.charAt(0).toUpperCase() + purpose.slice(1)
  return divergence === 7 ? `${p} — agent built` : `${p} building`
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
let clock = 0

renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  clock += dt

  // §5/§21.6: positions are interpolated between frames rather than simulated.
  // Nothing in this loop advances the world.
  presence.advance(dt)

  rig.update(dt)
  director.update(dt, liveTick)
  if (!director.inControl) el('shot').classList.remove('on')

  // §21.6: one upload per rendered frame, however many arrived since the last
  observer.flush()
  agentMarkers.update(withIdentity(), substrate.groundY, dt, clock)
  construction.update(observer.sites(), clock)

  if (scene.fog && 'near' in scene.fog) {
    scene.fog.near = rig.distance * 0.8
    scene.fog.far = rig.distance * 2.1
  }
  env.sky.position.copy(rig.camera.position)

  tiltShift.focusRange = Math.max(30, rig.distance * 0.055)
  tiltShift.render(renderer, scene, rig.camera, rig.distance, 1 - rig.streetness * 0.85)
})

function* withIdentity(): Generator<AgentPresence> {
  for (const a of presence.positions()) {
    const who = roster.get(a.id)
    yield { ...a, strategy: who?.strategy ?? 'consolidator', colourIndex: who?.colourIndex ?? 0 }
  }
}

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
  buildings,
  observer,
  director,
  connection,
  select,
  get readouts() {
    return readouts
  },
  get roster() {
    return roster
  },
  setMode(v: number) {
    modeInput.value = String(v)
    modeInput.dispatchEvent(new Event('input'))
  },
  scrubTo(ordinal: number) {
    scrub.value = String(ordinal)
    scrub.dispatchEvent(new Event('input'))
  },
  get selected() {
    return selectedIndex
  },
}
