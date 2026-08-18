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
 *
 * §35: the chrome is terminal — mono, lowercase, amber/cream on near-black —
 * and the world underneath stays the §15 diorama. Nothing in the ui layer
 * touches the render's palette, and nothing in this file advances the world.
 */
import {
  AGENT_MOTION_MAX_THROUGHPUT,
  BUILDING_SLOT_SPARE,
  CITY_HOUR,
  CITY_MATERIALS,
  CITY_MATERIAL_DEFAULT,
  DIVERGENCE_LABEL,
  PURPOSE_INDEX,
} from '@civ/core'
import type { BuildingDetail, EventWire, Frame, Hello, Readouts, ScrubResult } from '@civ/protocol'
import { FRAME_INTERVAL_MS } from '@civ/protocol'
import {
  BufferAttribute,
  Color,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { CameraDirector } from './camera/director.ts'
import { CameraRig, attachRigControls } from './camera/rig.ts'
import { TiltShiftPass } from './postfx/tiltShift.ts'
import { RealityGhost } from './render/ghost.ts'
import { WorldSound } from './audio/worldSound.ts'
import {
  AgentMarkers,
  agentColour,
  agentColourHex,
  type AgentPresence,
} from './render/agents.ts'
import { BuildingRenderer } from './render/buildingRenderer.ts'
import { configureRenderer, createEnvironment, dimGround } from './render/environment.ts'
import { createLandmarkLines } from './render/landmarkLines.ts'
import { createRoadMeshes } from './render/roadMesh.ts'
import { ConstructionOverlay } from './render/scaffold.ts'
import { createSubstrateView } from './render/substrateMesh.ts'
import { createTrees } from './render/trees.ts'
import { PunctuationLayer } from './render/punctuation.ts'
import { FloatLights } from './render/floatlights.ts'
import { GLOBE_HOME, GLOBE_HOME_SPAN, GLOBE_ZOOM, GlobeView, orbitFor } from './render/globe.ts'
import { AgentInterpolator, Connection, fromBase64 } from './world/connection.ts'
import { loadChunk } from './world/load.ts'
import { Observer } from './world/observer.ts'

const canvas = document.createElement('canvas')
document.body.insertBefore(canvas, document.body.firstChild)
const renderer = new WebGLRenderer({ canvas, antialias: true })
configureRenderer(renderer)

const scene = new Scene()
// §49: the world lives under one root so the globe can take the stage
const cityRoot = new Group()
scene.add(cityRoot)
// The baseline is immutable and served as a static file (§5, §21.6): it never
// travels over the socket, and every viewer already has the same copy.
const { seed, items, statics, chunks, entry, servers } = await loadChunk()

const radius =
  Math.max(
    seed.chunk.localBounds.maxX - seed.chunk.localBounds.minX,
    seed.chunk.localBounds.maxY - seed.chunk.localBounds.minY,
  ) / 2

// the plate stops just past the chunk, so the world reads as an object
const HALF_EXTENT = radius + 22
const substrate = createSubstrateView(seed.substrate, HALF_EXTENT)
cityRoot.add(substrate.group)
const env = createEnvironment(scene, { radius, groundY: substrate.groundY, chunkId: entry.id })

const buildings = new BuildingRenderer(items, seed.buildings.length + BUILDING_SLOT_SPARE)
seed.buildings.forEach((b, i) => {
  const s = statics[i]
  buildings.data.setStatic(i, s.roofTone, s.jitter, s.era, s.agent)
  buildings.data.set(i, 1, 0, PURPOSE_INDEX[b.purpose], 1)
})
buildings.flush()
// §42.1: the chunk wears its own material base — schiedam's identity row
// keeps it exactly as built
buildings.setCityMaterial(CITY_MATERIALS[seed.chunk.id] ?? CITY_MATERIAL_DEFAULT)
// §50.3: the authored hour decides how much of the frame the windows carry
const cityHour = CITY_HOUR[seed.chunk.id]
buildings.setNight(cityHour?.night ?? 0.1, cityHour?.windowWarm ?? '#ffc27a')
cityRoot.add(buildings.group)

const roads = createRoadMeshes(seed.roads.nodes, seed.roads.edges, substrate.heightAt, HALF_EXTENT)
cityRoot.add(roads.baseline)
cityRoot.add(roads.agent)

// §42.2: linear landmarks — the petite ceinture reads as a cutting, not a road
if (seed.landmarkLines?.length) {
  cityRoot.add(createLandmarkLines(seed.landmarkLines, substrate.heightAt))
}

// §48.4: stylized canopy over green landcover, chunk-palette tinted
cityRoot.add(
  createTrees(
    seed.substrate.surfaces,
    substrate.heightAt,
    HALF_EXTENT,
    CITY_MATERIALS[seed.chunk.id] ?? CITY_MATERIAL_DEFAULT,
  ),
)

// §50.2: at a dark hour the pale substrate out-albedos the city standing on
// it. Applied once, after the ground is built and before anything animated
// joins the root, so only the plate, its landcover, the roads and the canopy
// are touched.
dimGround(cityRoot, cityHour?.groundScale ?? 1)

const construction = new ConstructionOverlay()
cityRoot.add(construction.scaffold)
cityRoot.add(construction.siteMarks)
cityRoot.add(construction.glow)
cityRoot.add(construction.cranes)

// §46.2: one frame of punctuation at the §16.5 staging endpoints
const punctuation = new PunctuationLayer()
punctuation.setGround(substrate.groundY)
cityRoot.add(punctuation.dust)
cityRoot.add(punctuation.flash)

const agentMarkers = new AgentMarkers(200)
cityRoot.add(agentMarkers.mesh)

/**
 * §36.2: the site tether. A thin line linking a working agent's marker to the
 * site its plan is at, so attending a site reads as attending it. The line
 * takes the agent's own marker colour — the world layer keeps its own palette
 * (§35.1), so no chrome amber down here.
 */
const TETHER_MAX = 128
const tetherGeo = new BufferGeometry()
const tetherPos = new Float32Array(TETHER_MAX * 6)
const tetherCol = new Float32Array(TETHER_MAX * 6)
tetherGeo.setAttribute('position', new BufferAttribute(tetherPos, 3))
tetherGeo.setAttribute('color', new BufferAttribute(tetherCol, 3))
const tether = new LineSegments(
  tetherGeo,
  new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false }),
)
tether.frustumCulled = false
cityRoot.add(tether)

/**
 * §47.3a: the floating lights — agent glyphs over the miniature, chrome
 * register. §49 reuses the identical grammar for migration arcs on the globe.
 */
const floatLights = new FloatLights()
cityRoot.add(floatLights.group)

// §49: the globe, same void, same grade
const globe = new GlobeView(
  HALF_EXTENT * 0.92,
  chunks.map((c) => c.id),
  new Map(chunks.map((c) => [c.id, c.name])),
)
scene.add(globe.group)
const globeArcs = new FloatLights()
globe.group.add(globeArcs.group)

/**
 * §49 deviation, stated: migration events are NOT on the wire — migration
 * lives in the region harness (§31.6-5), and live servers do not move
 * agents. The arcs replay the committed record of a real region run
 * (world/region/migrations.json); absent that artifact, the globe simply
 * shows no arcs. When live migration exists, this feed swaps for the wire.
 */
let migrationRecord: Array<{ fromChunk: string; toSettlement: string }> = []
void fetch('/world/region/migrations.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((list: { migrations?: typeof migrationRecord } | typeof migrationRecord) => {
    migrationRecord = Array.isArray(list) ? list : (list.migrations ?? [])
  })
  .catch(() => {})
let arcCursor = 0
let arcTimer = 0


// ---------------------------------------------------------------------------
// the connection to the world (§21.6)
// ---------------------------------------------------------------------------

const observer = new Observer(seed, buildings, roads.agent, substrate.heightAt)
const presence = new AgentInterpolator(FRAME_INTERVAL_MS)
/** Who each agent is, remembered from birth — the wire only sends where. */
const roster = new Map<string, { name: string; strategy: string; colourIndex: number; generation: number }>()
/** Where things happened, so §17's director can point the camera at them. */
const places = new Map<string, [number, number]>()
/** §36.2: where each agent's active plan is, derived from its started events. */
const agentSite = new Map<string, [number, number]>()

let readouts: Readouts | null = null
let durability: Hello['durability'] = 'memory'
let scrubbing = false
let liveTick = 0
let wrongWorld = false

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const connection = new Connection(serverUrl(), {
  onHello(h: Hello) {
    // §21.4 in spirit: assert the serving world against the loaded artifact.
    // One server per chunk means a misrouted url would otherwise paint another
    // city's mutations onto this baseline.
    if (h.chunkId !== entry.id) {
      wrongWorld = true
      el('link').textContent = `wrong world, server runs ${h.chunkId}`
      el('link').className = 'lost'
      connection.close()
      return
    }
    for (const a of h.agents) roster.set(a.id, a)
    observer.applyHello(h)
    for (const e of h.events) ingest(e)
    durability = h.durability
    acceptReadouts(h.readouts)
    bootAttached()
  },
  onFrame(f: Frame) {
    for (const a of f.born) roster.set(a.id, a)
    for (const id of f.retired) {
      // §46.3: a retirement is a death the session witnessed, by name
      const gone = roster.get(id)
      if (gone) {
        watched.died.push(gone.name)
        renderWatched()
      }
      roster.delete(id)
      agentSite.delete(id)
      if (followId === id) follow(null)
    }
    observer.applyFrame(f)
    presence.accept(f.agents, f.retired)
    for (const e of f.events) {
      if (e.x !== undefined && e.y !== undefined && e.buildingId) places.set(e.buildingId, [e.x, e.y])
      ingest(e)
      director.consider(e)
    }
    acceptReadouts(f.readouts)
  },
  onScrub(s: ScrubResult) {
    observer.applyScrubTexture(fromBase64(s.buildingData))
    scrubbing = true
    scrubOut.value = `gen ${s.generation}`
    setReadouts(s.divergenceIndex, s.generation, true)
    // §40.2: the answer says how far back the store still goes; the probe
    // that opened a timelapse turns that into the replay's own range
    availableOrdinals = s.available
    timelapseBegin()
  },
  onBuilding(b: BuildingDetail) {
    showInspector(b)
  },
  onAgent(a) {
    // §51.3: every read is cached — the sheet asked for it, or a hover did
    if (a.found) agentCache.set(a.id, a)
    if (hoverId === a.id) renderMiniCard(a.id, lastPointer[0], lastPointer[1])
    showAgentSheet(a)
  },
  onStatus(state) {
    if (wrongWorld) return
    el('link').textContent =
      state === 'live' ? 'live' : state === 'connecting' ? 'connecting…' : 'reconnecting…'
    el('link').className = state
  },
})

/**
 * Where the world is. Vercel serves this file; the sim server is elsewhere, so
 * the origin cannot be assumed. §36.1: one server per chunk, so the chunk index
 * carries a per-chunk url map; an entry a https page cannot use (ws://) is
 * skipped rather than mixed-content-blocked.
 */
function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server')
  if (override) return override
  const mapped = servers[entry.id]
  if (mapped && (location.protocol !== 'https:' || mapped.startsWith('wss'))) return mapped
  const configured = (import.meta as { env?: Record<string, string> }).env?.VITE_SERVER_URL
  if (configured) return withChunkPath(configured)
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return withChunkPath(`${scheme}://${location.hostname}:8787`)
}

/**
 * §44.5: one service hosts every chunk behind `/ws/<chunkId>`, and a bare
 * origin only upgrades on a server hosting exactly one chunk. An operator
 * naturally sets VITE_SERVER_URL to the bare origin — production did, and
 * every upgrade came back 404, which the client showed as a permanent
 * `reconnecting…`. The client knows the path shape, so it completes the url
 * itself. Both server shapes accept `/ws/<chunkId>`, so this is safe for a
 * single-chunk deployment too; an url that already names a path is left
 * exactly as given.
 */
function withChunkPath(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.includes('/ws/') ? trimmed : `${trimmed}/ws/${entry.id}`
}

let lastGen = 0
let actionsThisGen = 0

function acceptReadouts(r: Readouts): void {
  readouts = r
  liveTick = r.tick
  el('pace').textContent = r.pace.label
  el('season').textContent = `s${r.season}`
  // §22.5: the presence-marker threshold, keyed off the server's rate
  presence.motion = r.pace.decisionsPerSecond <= AGENT_MOTION_MAX_THROUGHPUT
  el('durability').textContent =
    `${r.viewers} watching` + (durability === 'postgres' ? '' : ' · in memory')
  if (r.generation !== lastGen) {
    lastGen = r.generation
    actionsThisGen = archive.reduce((n, e) => n + (e.generation === r.generation ? 1 : 0), 0)
  }
  el('actionsGen').textContent = `${actionsThisGen} actions this gen`
  el('agentsBtn').textContent = `agents ${roster.size}`
  el('logMeta').textContent = `${r.eventCount} events`
  if (scrubbing) return
  setReadouts(r.divergenceIndex, r.generation, false)
  scrub.max = String(Math.max(1, r.eventCount))
  scrub.value = String(r.eventCount)
}

// ---------------------------------------------------------------------------
// camera and director
// ---------------------------------------------------------------------------

const rig = new CameraRig(innerWidth / innerHeight)
rig.limits.panRadius = radius * 1.1

/**
 * §24.1: "zoom so the diamond's width fills the frame width, accepting corner
 * crop."
 *
 * `distanceToFrame` fits a span to the *vertical* fov, so framing the plate
 * that way put the whole horizontal margin on screen as dead grey — at 16:9 the
 * camera was showing about 1.8x more world across than down, and the plate is
 * only as wide as it is tall. Frame on the width instead and let the corners go
 * off-frame.
 *
 * The plate is a square seen rotated, which is the §24.2 problem showing up in
 * the camera: a square of half-extent h turned by `az` projects to a horizontal
 * half-width of h*(|cos az| + |sin az|), independent of the tilt, since tilt
 * compresses the vertical only. At the default azimuth that is 1.36 h rather
 * than h — the diamond really is wider than the square it is cut from, and the
 * framing has to know that or it crops the corners it was told to keep.
 */
/**
 * §35.6: at rest the plate presents square, not as a rotated diamond. §24.2
 * already cut the chunk along its fabric axis, so in local coordinates the
 * plate's edges are the fabric — azimuth 0 faces it squarely, and the old
 * three-quarter azimuth was the pre-cut habit surviving into the camera. The
 * spread term stays general for any azimuth a shot lands on.
 */
const CITY_AZIMUTH = 0
function frameThePlate(aspect: number, azimuth = CITY_AZIMUTH): number {
  const spread = Math.abs(Math.cos(azimuth)) + Math.abs(Math.sin(azimuth))
  const widthM = 2 * HALF_EXTENT * spread
  return rig.distanceToFrame(widthM / aspect)
}
const CITY_FRAMING = frameThePlate(innerWidth / innerHeight)
rig.limits.maxDistance = CITY_FRAMING * 1.25
rig.distance = CITY_FRAMING
rig.target.set(0, substrate.groundY, 0)

/**
 * §36.1: arriving from a chunk switch flies in rather than cutting — the
 * switch is a navigation, so the camera treats it as one. A plain load lands
 * on the frame directly.
 */
const arriving = sessionStorage.getItem('tf-arrive') === '1'
sessionStorage.removeItem('tf-arrive')
if (arriving) {
  rig.flyTo(new Vector3(0, substrate.groundY, 0), CITY_FRAMING * 1.6, {
    azimuth: CITY_AZIMUTH + 0.8,
    polar: 0.34,
    duration: 0.01,
  })
  rig.update(0.05)
  rig.flyTo(new Vector3(0, substrate.groundY, 0), CITY_FRAMING, {
    azimuth: CITY_AZIMUTH,
    polar: 0.66,
    duration: 2.8,
  })
} else {
  rig.flyTo(new Vector3(0, substrate.groundY, 0), CITY_FRAMING, {
    azimuth: CITY_AZIMUTH,
    polar: 0.66,
    duration: 0.01,
  })
}

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
  // §35.6: at rest the ambient camera returns to the framed orientation
  homeAzimuth: CITY_AZIMUTH,
  // §47.4: idle beats weight toward active sites — a viewer left watching is
  // taken to work in progress rather than orbiting quiet fabric
  idleSite() {
    const active: Array<[number, number]> = []
    for (const s of observer.sites()) {
      const [x, y] = s.footprint[0]
      active.push([x, y])
      if (active.length >= 24) break
    }
    if (!active.length) return null
    const [x, y] = active[Math.floor(Math.random() * active.length)]
    return pointAt(x, y)
  },
})

function pointAt(x: number, y: number): Vector3 {
  return new Vector3(x, substrate.groundY, -y)
}

/**
 * §46.4: first load and every ambient return present the §24.1 framed view.
 * The director's queue fills within the first frames off the socket and its
 * first cut used to land the opening camera on an event close-up — often at
 * the plate's far corner, opening on void. Every load now holds the director
 * until the frame has presented; the arrival sweep keeps its longer hold.
 */
director.enabled = false
setTimeout(
  () => {
    if (!followId && mode === 'city') director.enabled = true
  },
  arriving ? 3400 : 2600,
)

// ---------------------------------------------------------------------------
// §49: the scale chain — city <-> globe
// ---------------------------------------------------------------------------

let mode: 'city' | 'globe' = 'city'
/** §49 r3: seconds since the globe camera was last touched */
let globeIdle = 0

/**
 * §49 r3: the globe's own §24.1. One fixed home framing — full disc, limb all
 * the way round, europe centred, comfortable margin — that zoom-out lands on
 * and ambient returns to. Free zoom is clamped either side so the frame never
 * degenerates into coastline scribbles at one end or a speck at the other.
 */
function globeHomeDistance(): number {
  return rig.distanceToFrame(globe.radius * GLOBE_HOME_SPAN)
}

function frameGlobeHome(duration: number): void {
  const orbit = orbitFor(GLOBE_HOME.lat, GLOBE_HOME.lon)
  rig.flyTo(new Vector3(0, 0, 0), globeHomeDistance(), { ...orbit, duration })
}

function toGlobe(): void {
  if (mode === 'globe') return
  mode = 'globe'
  if (followId) follow(null)
  director.enabled = false
  cityRoot.visible = false
  globe.group.visible = true
  rig.limits.minDistance = rig.distanceToFrame(globe.radius * GLOBE_ZOOM.minSpan)
  rig.limits.maxDistance = rig.distanceToFrame(globe.radius * GLOBE_ZOOM.maxSpan)
  rig.limits.panRadius = 0
  frameGlobeHome(2.0)
  el('chunkBtn').textContent = 'earth'
  document.body.classList.add('globe')
  void pollSummaries()
}

/**
 * §40.6/§49.2: the dive — fly to the marker, then descend into the city.
 * Same-chunk dives are one unbroken move; a cross-chunk dive flies to the
 * marker, navigates, and the §36.1 arrival sweep finishes the descent with
 * the boot caption on the far side of the load.
 */
function diveTo(id: string): void {
  const m = globe.markers.find((x) => x.id === id)
  if (!m) return
  rig.flyTo(m.position.clone().multiplyScalar(1.12), globe.radius * 0.7, { duration: 1.7 })
  setTimeout(() => {
    if (id === entry.id) toCity()
    else {
      sessionStorage.setItem('tf-arrive', '1')
      switchTo(id)
    }
  }, 1750)
}

function toCity(): void {
  mode = 'city'
  document.body.classList.remove('globe')
  el('globeCard').classList.remove('on')
  el('chunkBtn').textContent = placeName(entry.name)
  globe.group.visible = false
  cityRoot.visible = true
  rig.limits.minDistance = 40
  rig.limits.maxDistance = frameThePlate(innerWidth / innerHeight) * 1.25
  rig.limits.panRadius = radius * 1.1
  rig.flyTo(new Vector3(0, substrate.groundY, 0), CITY_FRAMING * 1.55, {
    azimuth: CITY_AZIMUTH + 0.7,
    polar: 0.36,
    duration: 0.01,
  })
  rig.update(0.05)
  rig.flyTo(new Vector3(0, substrate.groundY, 0), CITY_FRAMING, {
    azimuth: CITY_AZIMUTH,
    polar: 0.66,
    duration: 2.6,
  })
  setTimeout(() => {
    if (!followId && mode === 'city') director.enabled = true
  }, 3000)
}

/**
 * §49: labels are chrome — mono, lowercase, crisp screen-space divs projected
 * per frame, never pushed through the world render. Hover shows the city's
 * §46.1 card; click dives.
 */
const globeLabels = el('globeLabels')
const labelEls = new Map<string, HTMLElement>()
const leaderEls = new Map<string, HTMLElement>()
for (const m of globe.markers) {
  const leader = document.createElement('div')
  leader.className = 'gleader'
  globeLabels.appendChild(leader)
  leaderEls.set(m.id, leader)
  const div = document.createElement('div')
  div.className = 'glabel'
  div.textContent = m.name.toLowerCase()
  div.dataset.id = m.id
  globeLabels.appendChild(div)
  labelEls.set(m.id, div)
}
globeLabels.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).dataset?.id
  if (id) diveTo(id)
})
globeLabels.addEventListener('mouseover', (e) => {
  const id = (e.target as HTMLElement).dataset?.id
  if (id) showGlobeCard(id)
})

const labelV = new Vector3()
const camDir = new Vector3()

/**
 * §49 r3: labels anchor to their marks. Each sits immediately beside its mark
 * and only moves when its box genuinely collides with one already placed —
 * then by the smallest step that clears, with a leader line back to the mark
 * so the geography stays honest. The visible label set is exactly the visible
 * mark set: a city behind the limb drops both.
 */
function updateGlobeLabels(): void {
  camDir.copy(rig.camera.position).normalize()
  const live: Array<{ m: (typeof globe.markers)[number]; sx: number; sy: number; div: HTMLElement }> = []
  for (const m of globe.markers) {
    const div = labelEls.get(m.id)
    if (!div) continue
    // one test drives both: behind the limb means no mark and no label
    const facing = m.position.clone().normalize().dot(camDir) > 0.08
    labelV.copy(m.position).project(rig.camera)
    const onScreen = facing && labelV.z <= 1
    m.sprite.visible = onScreen
    if (!onScreen) {
      div.classList.remove('on')
      continue
    }
    live.push({
      m,
      sx: ((labelV.x + 1) / 2) * innerWidth,
      sy: (1 - (labelV.y + 1) / 2) * innerHeight,
      div,
    })
  }

  // north-first placement keeps the ladder deterministic between frames
  live.sort((a, b) => a.sy - b.sy || a.sx - b.sx)
  const placed: Array<{ x: number; y: number; w: number; h: number }> = []
  const GAP = 11
  for (const item of live) {
    item.div.classList.add('on')
    const w = item.div.offsetWidth || 120
    const h = item.div.offsetHeight || 18
    // adjacent first, then the smallest displacement that clears
    const candidates: Array<[number, number]> = [
      [GAP, -h / 2],
      [GAP, -h / 2 - (h + 3)],
      [GAP, -h / 2 + (h + 3)],
      [-w - GAP, -h / 2],
      [GAP, -h / 2 + 2 * (h + 3)],
      [-w - GAP, -h / 2 - (h + 3)],
      [GAP, -h / 2 - 2 * (h + 3)],
    ]
    // beyond the fixed ladder, keep stepping down until something clears —
    // a label printed on top of another is worse than one row further out
    for (let k = 3; k <= 9; k++) candidates.push([GAP, -h / 2 + k * (h + 3)])
    let chosen = candidates[0]
    for (const c of candidates) {
      const box = { x: item.sx + c[0], y: item.sy + c[1], w, h }
      const hits = placed.some(
        (p) => box.x < p.x + p.w + 4 && box.x + box.w + 4 > p.x && box.y < p.y + p.h + 2 && box.y + box.h + 2 > p.y,
      )
      if (!hits) {
        chosen = c
        break
      }
    }
    const x = item.sx + chosen[0]
    const y = item.sy + chosen[1]
    placed.push({ x, y, w, h })
    item.div.style.left = `${x}px`
    item.div.style.top = `${y}px`
    // a leader only when the label had to leave its mark's side
    const displaced = chosen !== candidates[0]
    const leader = leaderEls.get(item.m.id)
    if (leader) {
      if (displaced) {
        const tx = chosen[0] < 0 ? x + w : x
        const ty = y + h / 2
        const len = Math.hypot(tx - item.sx, ty - item.sy)
        leader.style.width = `${len}px`
        leader.style.left = `${item.sx}px`
        leader.style.top = `${item.sy}px`
        leader.style.transform = `rotate(${Math.atan2(ty - item.sy, tx - item.sx)}rad)`
        leader.classList.add('on')
      } else {
        leader.classList.remove('on')
      }
    }
  }
}

/** §46.1's card, docked to the marker being hovered */
function showGlobeCard(id: string): void {
  const s = citySummaries.get(id)
  const c = chunks.find((x) => x.id === id)
  if (!c) return
  const facts = s
    ? `gen ${s.generation ?? '·'} · ${((s.divergenceIndex ?? 0) * 100).toFixed(1)}% diff · ${s.agentCount ?? '·'} active`
    : 'unreached — baseline only'
  el('globeCardBody').innerHTML =
    `<b>${escapeHtml(placeName(c.name))}</b><br>${escapeHtml(facts)}` +
    (s?.lastEvent ? `<br><span class="dim">last: ${escapeHtml(s.lastEvent.text)}</span>` : '')
  el('globeCard').classList.add('on')
}

el('candidatesBtn').addEventListener('click', () => {
  globe.setCandidates(!globe.candidatesOn)
  el('candidatesBtn').classList.toggle('on', globe.candidatesOn)
})

// zooming out past the city framing lifts off to the globe
let liftPressure = 0
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'city' || !bootDone) return
  if (e.deltaY > 0 && rig.distance >= rig.limits.maxDistance * 0.995) {
    liftPressure += 1
    if (liftPressure >= 3) {
      liftPressure = 0
      toGlobe()
    }
  } else if (e.deltaY < 0) {
    liftPressure = 0
  }
})

// on the globe, clicking a marker dives; the cards pane stays one keypress away
canvas.addEventListener('click', (e) => {
  if (mode !== 'globe') return
  const v = new Vector3()
  let best: { id: string; d: number } | null = null
  for (const m of globe.markers) {
    v.copy(m.position).project(rig.camera)
    if (v.z > 1) continue
    const sx = ((v.x + 1) / 2) * innerWidth
    const sy = (1 - (v.y + 1) / 2) * innerHeight
    const d = Math.hypot(sx - e.clientX, sy - e.clientY)
    if (d < 28 && (!best || d < best.d)) best = { id: m.id, d }
  }
  if (best) diveTo(best.id)
})

// ---------------------------------------------------------------------------
// §40: the spectacle set — ghost, timelapse, milestone cinematics, sound
// ---------------------------------------------------------------------------

// §40.1: built once from the immutable baseline, held on `b`
const ghost = new RealityGhost(seed.buildings, substrate.heightAt)
cityRoot.add(ghost.lines)

const sound = new WorldSound()
el('soundBtn').addEventListener('click', () => {
  const on = sound.setEnabled(!sound.on)
  el('soundBtn').setAttribute('aria-pressed', String(on))
  el('soundBtn').textContent = on ? 'sound on' : 'sound off'
})

/** §40.2/§40.4: one line of caption over the world, in the pane grammar */
let cardTimer: ReturnType<typeof setTimeout> | null = null
function titleCard(text: string | null, holdMs = 5000): void {
  const card = el('titleCard')
  if (cardTimer) clearTimeout(cardTimer)
  if (!text) {
    card.classList.remove('on')
    return
  }
  el('titleCardText').textContent = text
  card.classList.add('on')
  cardTimer = setTimeout(() => card.classList.remove('on'), holdMs)
}

/**
 * Wishlist: where an event fired, relative to what the camera is looking at,
 * so the ear can place it. Distance is normalised on the orbit radius — an
 * event at the target is close, one a plate away is far — and the pan is
 * which side of frame centre it projects to.
 */
const soundV = new Vector3()
function placementOf(x: number, y: number): { distance: number; pan: number } {
  soundV.copy(pointAt(x, y))
  const d = soundV.distanceTo(rig.camera.position) / Math.max(1, rig.distance)
  soundV.project(rig.camera)
  return { distance: Math.max(0, d - 0.7), pan: Math.max(-1, Math.min(1, soundV.x)) }
}

/**
 * §40.4: milestone cinematics. A high-weight event earns an ambient viewer a
 * slow pullback and a one-line title card; a viewer who is following,
 * inspecting or driving the camera is never interrupted, which is the whole
 * rule — the cinematic is what the world does when nobody is asking it for
 * anything.
 */
const CINEMATIC_WEIGHT = 70
const CINEMATIC_COOLDOWN_S = 45
let cinematicCooldown = 0

function maybeCinematic(e: EventWire): void {
  if (e.cinematicWeight < CINEMATIC_WEIGHT) return
  if (cinematicCooldown > 0 || timelapse) return
  // active viewers are exempt: following, a sheet open, or hands on the camera
  if (followId || selectedAgentId !== null || selectedIndex !== null) return
  if (!document.body.classList.contains('ambient')) return
  if (mode !== 'city') return
  cinematicCooldown = CINEMATIC_COOLDOWN_S
  const line = e.rationale ?? e.type.replace(/_/g, ' ')
  titleCard(`${line} · gen ${e.generation}`, 5000)
  sound.swell()
  // the pullback: hold whatever is on screen and rise off it for five seconds
  director.takeControl()
  const at = e.x !== undefined && e.y !== undefined ? pointAt(e.x, e.y) : rig.target.clone()
  rig.flyTo(at, Math.min(rig.limits.maxDistance, rig.distance * 1.9), {
    polar: Math.max(rig.limits.minPolar + 0.1, rig.polar - 0.18),
    duration: 5,
  })
  setTimeout(() => {
    // release: the director resumes its own idle beats from here
    if (!followId && document.body.classList.contains('ambient')) director.enabled = true
  }, 5200)
}

/**
 * §40.2: timelapse. `t` holds the camera, rewinds as far back as the world
 * still remembers, and replays from there in about twenty seconds by walking
 * the scrub the server already answers — then an end card, then live.
 *
 * FINDING, and the reason this does not say "rewinds to gen 0": snapshots are
 * retained for a bounded number of seasons (civ.retention, four by default),
 * so a world that has run past that no longer has an early snapshot to show.
 * Asking for one gets `no snapshot at or before that ordinal`. Rather than
 * replay a span the server cannot answer and call the gaps a style, the walk
 * is over the ordinals the server SAYS it holds: one scrub is issued first,
 * its answer carries the available set, and the replay samples that. On a
 * young world that is the whole history; on an old one it is the retained
 * window, and the end card says which it was. Replaying from the true fork
 * needs retention or an oldest-ordinal readout, both server-side, and this
 * block is client-only.
 *
 * The walk is coarse on purpose: sixty steps, not sixty thousand. Each step
 * is one snapshot question, and the jump between two snapshots is exactly
 * what a viewer reads as time passing.
 */
const TIMELAPSE_S = 20
const TIMELAPSE_STEPS = 60
let timelapse: {
  ordinals: number[]
  step: number
  timer: ReturnType<typeof setInterval> | null
} | null = null

/** the scrub answer hands back every ordinal the store still holds */
let availableOrdinals: number[] = []

function startTimelapse(): void {
  if (timelapse || !readouts || readouts.eventCount < 2) return
  director.takeControl()
  titleCard(`${placeName(entry.name)} · rewinding`, 2400)
  // ask once at the newest ordinal — that snapshot certainly exists, and its
  // answer is what tells us how far back the world goes
  timelapse = { ordinals: [], step: 0, timer: null }
  connection.send({ t: 'scrub', ordinal: readouts.eventCount })
}

/** called from onScrub once the probe lands, with the available set in hand */
function timelapseBegin(): void {
  if (!timelapse || timelapse.timer) return
  const all = availableOrdinals.filter((o) => o > 0).sort((a, b) => a - b)
  if (all.length < 2) {
    titleCard(`${placeName(entry.name)} · no history retained to replay`, 3600)
    timelapse = null
    setTimeout(() => exitScrub(), 3600)
    return
  }
  // sample the retained set evenly rather than taking its first sixty
  const pick: number[] = []
  for (let i = 0; i < TIMELAPSE_STEPS; i++) {
    pick.push(all[Math.min(all.length - 1, Math.round((i * (all.length - 1)) / (TIMELAPSE_STEPS - 1)))])
  }
  timelapse.ordinals = pick
  timelapse.timer = setInterval(() => {
    if (!timelapse) return
    const o = timelapse.ordinals[timelapse.step++]
    if (o === undefined) {
      endTimelapse(all[0], all[all.length - 1])
      return
    }
    connection.send({ t: 'scrub', ordinal: o })
  }, (TIMELAPSE_S * 1000) / TIMELAPSE_STEPS)
}

function endTimelapse(from: number, to: number): void {
  if (!timelapse) return
  if (timelapse.timer) clearInterval(timelapse.timer)
  timelapse = null
  const gens = readouts?.generation ?? lastGen
  const diff = ((readouts?.divergenceIndex ?? 0) * 100).toFixed(0)
  const span = from <= 1 ? 'from the fork' : `events ${from}–${to}`
  titleCard(`${placeName(entry.name)} · ${gens} generations · ${diff}% diverged · ${span}`, 4600)
  sound.swell()
  // rejoining live is the scrub's own exit: the world is re-asked from scratch
  setTimeout(() => exitScrub(), 4600)
}

/**
 * §51.1, absolute rule: any pointer input exits ambient instantly and hands
 * the camera over, with the mode flip announced. Ambient only resumes after
 * 60s of idleness, and only if it was on before the input.
 */
let ambientWasOn = false
let ambientResumeTimer: ReturnType<typeof setTimeout> | null = null

function announceMode(text: string): void {
  const m = el('modeFlip')
  m.textContent = text
  m.classList.add('on')
  setTimeout(() => m.classList.remove('on'), 1400)
}

function inputWinsCamera(): void {
  globeIdle = 0
  if (document.body.classList.contains('ambient')) {
    ambientWasOn = true
    document.body.classList.remove('ambient')
    el('ambient').setAttribute('aria-pressed', 'false')
    announceMode('manual')
  }
  if (ambientResumeTimer) clearTimeout(ambientResumeTimer)
  ambientResumeTimer = setTimeout(() => {
    if (ambientWasOn && !followId && !document.body.classList.contains('ambient')) {
      document.body.classList.add('ambient')
      el('ambient').setAttribute('aria-pressed', 'true')
      director.enabled = true
      announceMode('ambient')
    }
  }, 60_000)
  director.takeControl()
  // §36.2: grabbing the camera releases the tether — following is a mode the
  // viewer leaves by looking elsewhere, not a lock
  if (followId) follow(null)
}

attachRigControls(rig, canvas, inputWinsCamera)

const tiltShift = new TiltShiftPass(innerWidth, innerHeight)
// §50.2: the grade stands down where the authored hour is night
tiltShift.night = cityHour?.night ?? 0
// DOF r2: the focus toggle, soft by default. Off is a real setting, not a
// debug flag — someone reading a street wants the whole street.
let focusOn = true
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

// ---------------------------------------------------------------------------
// chrome (§35): status line, bars, panes
// ---------------------------------------------------------------------------

/** `London — Deptford Riverside` is data; the chrome says `deptford riverside, london`. */
function placeName(raw: string): string {
  const parts = raw.split(/\s+—\s+/)
  return (parts.length === 2 ? `${parts[1]}, ${parts[0]}` : raw).toLowerCase()
}

el('chunkBtn').textContent = placeName(entry.name)
el('exPlace').textContent = `this is ${placeName(entry.name)}. real place, real buildings.`

/** §20.6: divergence index primary, generation secondary, no third readout. */
function setReadouts(index: number, generation: number, inScrub: boolean): void {
  const detail =
    readouts && !inScrub ? ` · ${readouts.agentOrigin} builds · ${readouts.demolished} demolitions` : ''
  el('diffStat').innerHTML = `<b>${(index * 100).toFixed(1)}%</b> diff${detail}${inScrub ? ' at this point in the log' : ''}`
  el('genN').textContent = `gen ${generation}`
}

const modeInput = el<HTMLInputElement>('mode')
const modeOut = el<HTMLOutputElement>('modeOut')
modeInput.addEventListener('input', () => {
  const v = Number(modeInput.value)
  buildings.setDivergenceMode(v)
  // §35.3: normal is "as built", the overlay is the diff
  modeOut.value = v < 0.02 ? 'as built' : v > 0.98 ? 'diff view' : v.toFixed(2)
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
  // §36.4: scrubbing the log opens the changelog rail alongside
  renderChangelog()
  el('changelog').classList.add('on')
  connection.send({ t: 'scrub', ordinal })
})

function exitScrub(): void {
  if (!scrubbing) return
  scrubbing = false
  scrubOut.value = 'live'
  el('changelog').classList.remove('on')
  // rejoin the world where it is now: ask for the current texture again
  connection.close()
  location.reload()
}

// ---------------------------------------------------------------------------
// the event archive (§36): everything this session has watched happen
// ---------------------------------------------------------------------------

const archive: EventWire[] = []
let lastEventId = 0

function ingest(e: EventWire): void {
  if (e.id <= lastEventId) return
  lastEventId = e.id
  archive.push(e)
  if (archive.length > 6000) archive.splice(0, 1000)
  if (readouts && e.generation === readouts.generation) actionsThisGen++
  // §36.2: a started event pins the agent's active site; completion releases it
  if ((e.type === 'construction_started' || e.type === 'demolition_started') && e.agentId) {
    if (e.x !== undefined && e.y !== undefined) agentSite.set(e.agentId, [e.x, e.y])
  } else if (
    (e.type === 'construction_completed' || e.type === 'demolition_completed') &&
    e.agentId
  ) {
    agentSite.delete(e.agentId)
  }
  // §46.2/§46.3: the staging endpoints get one frame of punctuation, and the
  // session's own tally advances
  const placed =
    e.x !== undefined && e.y !== undefined && mode === 'city' ? placementOf(e.x, e.y) : undefined
  if (e.type === 'construction_completed') {
    watched.built++
    if (e.x !== undefined && e.y !== undefined) punctuation.constructionFlash(e.x, e.y)
    // §40.5: the only figure in the vocabulary that lifts
    sound.rise(placed)
  } else if (e.type === 'demolition_completed') {
    watched.demolished++
    if (e.x !== undefined && e.y !== undefined) punctuation.demolitionDust(e.x, e.y)
    sound.thud(placed)
  } else {
    sound.tick(placed)
  }
  maybeCinematic(e)
  renderWatched()
  // world.log stays the world's; the followed agent narrates in its own pane
  queueFeedRow(e)
  if (followId && e.agentId === followId) queueAgentRow(e)
}

/**
 * §46.3 (§40.3 shipped): the session-personal line, computed from the frame
 * stream since connect — the direct answer to "what are they doing" for
 * anyone who just arrived.
 */
const watched = { built: 0, demolished: 0, died: [] as string[] }

function renderWatched(): void {
  const bits: string[] = []
  if (watched.built) bits.push(`${watched.built} built`)
  if (watched.demolished) bits.push(`${watched.demolished} demolished`)
  if (watched.died.length) {
    const last = watched.died[watched.died.length - 1].split(' ')[0].toLowerCase()
    bits.push(watched.died.length === 1 ? `${last} died` : `${last} + ${watched.died.length - 1} died`)
  }
  el('watched').textContent = bits.length ? `while you watched: ${bits.join(' · ')}` : ''
}

// ---------------------------------------------------------------------------
// world.log (§8, §35.7) — the world narrating itself
// ---------------------------------------------------------------------------

const feedList = el('feedList')

/**
 * §51.2: the log is for reading, the world is for watching — so the feed
 * refuses the throughput race. Events arrive at whatever rate the world runs
 * at; rows are rendered at most one per FEED_RATE_MS, the excess coalescing
 * into the ×N collapse or waiting behind a `+n more` roll-up. Routine lines
 * (the dim class) don't enter the queue at all by default: they count into a
 * per-generation total that expands on click, or with the verbose toggle.
 */
const FEED_RATE_MS = 500
const FEED_MAX_ROWS = 12
/** the typing tick is decoration: anyone who asked for less motion gets none */
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches

interface FeedItem {
  e: EventWire
  n: number
}
const feedQueue: FeedItem[] = []
let feedHovered = false
let feedPausedByKey = false
let verboseFeed = false
let routineGen = -1
let routineCount = 0
// §35.6: one plan's constituent actions share a rationale and would otherwise
// print it once per action. Consecutive same-agent same-line events collapse
// into the newest row with a ×N count instead.
let lastFeedKey = ''
let lastFeedCount = 0

/** §35.7: severity by colour, driven by the weight column. */
function severity(w: number): string {
  return w >= 50 ? 'high' : w >= 20 ? 'cream' : ''
}

function feedKey(e: EventWire): string {
  return `${e.agentId ?? ''}|${e.type}|${e.rationale ?? e.type}`
}

const feedHeld = (): boolean => feedHovered || feedPausedByKey

/**
 * §51.2 intake. Routine lines are counted rather than queued; the detail a
 * viewer follows an agent for now lives in that agent's own pane, which is
 * unfiltered, so world.log stays the world's at every zoom.
 */
function queueFeedRow(e: EventWire): void {
  if (!verboseFeed && severity(e.cinematicWeight) === '') {
    if (e.generation !== routineGen) {
      routineGen = e.generation
      routineCount = 0
    }
    routineCount++
    renderFeedTail()
    return
  }
  const tail = feedQueue[feedQueue.length - 1]
  if (tail && feedKey(tail.e) === feedKey(e)) {
    tail.n++
    tail.e = e
  } else {
    feedQueue.push({ e, n: 1 })
    if (feedQueue.length > 400) feedQueue.splice(0, feedQueue.length - 400)
  }
  renderFeedTail()
}

setInterval(() => {
  if (!feedHeld()) {
    const item = feedQueue.shift()
    if (item) pushFeedRow(item.e, item.n)
  }
  renderFeedTail()
}, FEED_RATE_MS)

/** the two pace rows: what's still waiting, and what was never worth a row */
function renderFeedTail(): void {
  let roll = feedList.querySelector('.e.roll') as HTMLElement | null
  const waiting = feedQueue.reduce((n, i) => n + i.n, 0)
  if (waiting > 0) {
    if (!roll) {
      roll = document.createElement('div')
      roll.className = 'e roll'
      roll.innerHTML = '<span class="ord">+</span><span class="t"></span>'
      feedList.insertAdjacentElement('afterbegin', roll)
    } else if (roll !== feedList.firstElementChild) {
      feedList.insertAdjacentElement('afterbegin', roll)
    }
    roll.querySelector('.t')!.textContent = `${waiting} more${feedHeld() ? ' · held' : ''}`
  } else roll?.remove()

  let count = feedList.querySelector('.e.count') as HTMLElement | null
  if (!verboseFeed && routineCount > 0) {
    if (!count) {
      count = document.createElement('div')
      count.className = 'e count'
      count.innerHTML = '<span class="ord">·</span><span class="t"></span>'
    }
    feedList.insertAdjacentElement('beforeend', count)
    count.querySelector('.t')!.textContent = `${routineCount} routine this gen`
  } else count?.remove()

  el('logState').classList.toggle('hidden', !feedHeld())
}

/** click the roll-up and the pace steps aside: everything held renders now */
function flushFeed(): void {
  for (const item of feedQueue.splice(0, feedQueue.length).slice(-FEED_MAX_ROWS)) {
    pushFeedRow(item.e, item.n, true)
  }
  renderFeedTail()
}

function setVerbose(on: boolean): void {
  verboseFeed = on
  el('verboseBtn').setAttribute('aria-pressed', String(on))
  renderFeedTail()
}
el('verboseBtn').addEventListener('click', () => setVerbose(!verboseFeed))

// §51.2: hovering the log pauses the stream — a line being read must not be
// pushed off the bottom mid-sentence. Buffered, resumes on leave.
el('log').addEventListener('pointerenter', () => {
  feedHovered = true
  renderFeedTail()
})
el('log').addEventListener('pointerleave', () => {
  feedHovered = false
  renderFeedTail()
})

function pushFeedRow(e: EventWire, times = 1, instant = false): void {
  const text = e.rationale ?? e.type.replace(/_/g, ' ')
  const key = feedKey(e)
  const head = feedList.querySelector('.e:not(.roll):not(.count)') as HTMLElement | null
  const at = feedPlace(e)
  if (key === lastFeedKey && head) {
    lastFeedCount += times
    const n = head.querySelector('.n')
    if (n) n.textContent = ` ×${lastFeedCount}`
    const ord = head.querySelector('.ord')
    if (ord) ord.textContent = String(e.id)
    // the collapsed row keeps pointing at the newest occurrence
    if (at) {
      head.dataset.x = String(at[0])
      head.dataset.y = String(at[1])
    }
    return
  }
  lastFeedKey = key
  lastFeedCount = times
  // §35.7: ordinal gutter, never clock time (§20). §20.2 still holds: the
  // ordinal is the log's own key, not a rendering of the tick.
  // §46.2: rows carry their place — the feed says wilhelmina is clearing a
  // site; clicking goes there.
  const row = document.createElement('div')
  row.className = `e ${severity(e.cinematicWeight)}${at ? ' place' : ''}`
  if (at) {
    row.dataset.x = String(at[0])
    row.dataset.y = String(at[1])
  }
  // §51.3 identity colour: the name in the line is the agent's own accent, the
  // same value its marker, tether, chip and sheet carry
  const who = e.agentId ? roster.get(e.agentId) : undefined
  const tone = who ? agentColourHex(who.strategy, who.colourIndex) : ''
  row.innerHTML =
    `<span class="ord">${e.id}</span>` +
    `<span class="t">${
      e.agentName
        ? `<b${tone ? ` style="color:${tone}"` : ''}>${escapeHtml(e.agentName.split(' ')[0])}</b> `
        : ''
    }<span class="tx"></span><span class="n">${times > 1 ? ` ×${times}` : ''}</span></span>`
  const tx = row.querySelector('.tx') as HTMLElement
  feedList.insertAdjacentElement('afterbegin', row)
  typeInto(tx, text, instant)
  const rows = feedList.querySelectorAll('.e:not(.roll):not(.count)')
  for (let i = FEED_MAX_ROWS; i < rows.length; i++) rows[i].remove()
  renderFeedTail()
}

/**
 * The line writes itself in. Subtle by construction: it is rate-capped by the
 * feed's own pace (never more than one row per FEED_RATE_MS), finishes well
 * inside that window, and any row still typing when the next arrives is
 * completed immediately rather than racing it.
 */
const TYPE_MS = 240
let typing: { el: HTMLElement; text: string; done: () => void } | null = null

function typeInto(target: HTMLElement, text: string, instant: boolean): void {
  if (typing) typing.done()
  if (instant || REDUCED_MOTION || !text) {
    target.textContent = text
    return
  }
  const started = performance.now()
  target.classList.add('typing')
  const done = (): void => {
    target.textContent = text
    target.classList.remove('typing')
    if (typing?.el === target) typing = null
  }
  typing = { el: target, text, done }
  const step = (now: number): void => {
    if (typing?.el !== target) return
    const t = Math.min(1, (now - started) / TYPE_MS)
    target.textContent = text.slice(0, Math.max(1, Math.round(text.length * t)))
    if (t >= 1) done()
    else requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function feedPlace(e: EventWire): [number, number] | null {
  if (e.x !== undefined && e.y !== undefined) return [e.x, e.y]
  const p = e.buildingId ? places.get(e.buildingId) : undefined
  return p ?? null
}

// §46.2-1: the single highest-value missing link — clicking a log line flies
// to where it happened
feedList.addEventListener('click', (ev) => {
  const row = (ev.target as HTMLElement).closest('.e') as HTMLElement | null
  if (!row) return
  // §51.2: the two pace rows expand rather than fly
  if (row.classList.contains('roll')) {
    flushFeed()
    return
  }
  if (row.classList.contains('count')) {
    setVerbose(true)
    return
  }
  if (!row.dataset.x) return
  director.takeControl()
  rig.flyTo(pointAt(Number(row.dataset.x), Number(row.dataset.y)), 240, {
    polar: 0.82,
    duration: 2.0,
  })
})

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
/** the agent the inspector is currently about, when it is about one */
let selectedAgentId: string | null = null

canvas.addEventListener('click', (e) => {
  if (mode !== 'city') return
  // §36.2: agents are clickable ahead of the fabric — a marker is a few pixels
  // and a raycast against instanced cones is not worth the precision
  const hitAgent = pickAgent(e.clientX, e.clientY)
  if (hitAgent) {
    showAgentCard(hitAgent)
    return
  }
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, rig.camera)
  select(buildings.pick(raycaster))
})
el('close').addEventListener('click', () => select(null))

/** §51.1: double-click a building or parcel for a focus orbit around it */
canvas.addEventListener('dblclick', (e) => {
  if (mode !== 'city') return
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, rig.camera)
  const hit = buildings.pick(raycaster)
  if (hit !== null) {
    const id = observer.idAt(hit)
    const at = id ? places.get(id) : undefined
    const target = at ? pointAt(at[0], at[1]) : intersectGround()
    if (target) focusOrbit(target)
  } else {
    const g = intersectGround()
    if (g) focusOrbit(g)
  }
})

function intersectGround(): Vector3 | null {
  const t = (substrate.groundY - raycaster.ray.origin.y) / raycaster.ray.direction.y
  if (!Number.isFinite(t) || t <= 0) return null
  return raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, t)
}

function focusOrbit(at: Vector3): void {
  inputWinsCamera()
  rig.flyTo(at, Math.min(Math.max(rig.distance * 0.5, 130), 240), { polar: 0.86, duration: 1.6 })
}

function pickAgent(cx: number, cy: number): string | null {
  const v = new Vector3()
  let best: string | null = null
  let bestD = 20
  for (const a of presence.positions()) {
    v.set(a.x, substrate.groundY + 4, -a.y).project(rig.camera)
    if (v.z > 1) continue
    const sx = ((v.x + 1) / 2) * innerWidth
    const sy = ((1 - (v.y + 1) / 2)) * innerHeight
    const d = Math.hypot(sx - cx, sy - cy)
    if (d < bestD) {
      bestD = d
      best = a.id
    }
  }
  return best
}

function select(index: number | null): void {
  selectedIndex = index
  selectedAgentId = null
  el('followBtn').classList.add('hidden')
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

function shortId(id: string): string {
  const digits = id.replace(/\D/g, '')
  return digits.slice(-4) || id.slice(-4)
}

function showInspector(b: BuildingDetail): void {
  if (!b.found) {
    inspector.classList.remove('on')
    return
  }
  selectedAgentId = null
  el('followBtn').classList.add('hidden')
  inspector.classList.add('on')
  el('insName').textContent = `bldg ${shortId(b.id)}`
  el('insMeta').textContent = b.purpose ?? ''
  el('insTitle').textContent = b.name ?? titleFor(b.purpose ?? 'building', b.divergence ?? 0)
  el('insSub').textContent =
    `${DIVERGENCE_LABEL[b.divergence ?? 0]}` +
    (b.state && b.state !== 'standing' ? ` · ${b.state.replace(/_/g, ' ')}` : '')

  // §35.2: field labels read like keys
  el('insFacts').innerHTML = facts([
    // §20.1: a real building's construction year is a fact about it, the same
    // kind of fact as its footprint. It stays, and it is shown.
    ['built:', b.constructionYear ? String(b.constructionYear) : 'agent-built, new'],
    ['height:', `${(b.heightM ?? 0).toFixed(1)} m`],
    ['levels:', String(b.levels ?? 0)],
    ['archetype:', b.archetype ?? '·'],
    // §42.2: a landmark says so, and says whether the market can reach it
    ...(b.landmark
      ? ([
          [
            'landmark:',
            `${b.landmark.class.replace(/_/g, ' ')}${b.landmark.untouchable ? ' · untouchable' : ''}`,
          ],
        ] as Array<[string, string]>)
      : []),
    ['condition:', `${((b.condition ?? 0) * 100).toFixed(0)}%`],
    ['owner:', b.ownerName ? `${b.ownerName} (gen ${b.ownerGeneration})` : 'unowned'],
    // §23.3: a real objective rather than a shrug
    ...(b.ownerIntent ? ([['doing:', b.ownerIntent]] as Array<[string, string]>) : []),
    ...(b.ownerTraits
      ? ([
          [
            'character:',
            `risk ${b.ownerTraits.risk} · patience ${b.ownerTraits.horizon} · density ${b.ownerTraits.intensity}`,
          ],
        ] as Array<[string, string]>)
      : []),
    ['value:', (b.value ?? 0).toFixed(0)],
    // §35.3: baseline provenance is the fork's upstream
    ...(b.baseline
      ? ([
          ['was:', `${b.baseline.purpose}, ${b.baseline.levels} levels`],
          ['upstream:', b.baseline.bagId?.replace('NL.IMBAG.Pand.', '') ?? 'imported baseline'],
        ] as Array<[string, string]>)
      : ([['origin:', 'built by an agent']] as Array<[string, string]>)),
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
  return divergence === 7 ? `${purpose} · agent built` : `${purpose} building`
}

function facts(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
}

// ---------------------------------------------------------------------------
// §36.2: watching a worker — agent card, follow mode, crew
// ---------------------------------------------------------------------------

let followId: string | null = null
let followRefit = 0

function showAgentCard(id: string): void {
  const who = roster.get(id)
  if (!who) return
  selectedIndex = null
  selectedAgentId = id
  buildings.setHighlight(-1)
  const first = who.name.split(' ')[0]
  inspector.classList.add('on')
  el('insName').textContent = `agent ${first.toLowerCase()}`
  // §51.3: the sheet wears the identity colour too
  el('insName').style.color = agentColourHex(who.strategy, who.colourIndex)
  el('insMeta').textContent = who.strategy
  el('insTitle').textContent = who.name
  el('insSub').textContent = `gen ${who.generation} · ${who.strategy}`
  el('insFacts').innerHTML = facts([['reading:', 'the ledger…']])
  el('insLineageBox').classList.add('hidden')
  const btn = el('followBtn')
  btn.classList.remove('hidden')
  btn.classList.toggle('on', followId === id)
  btn.textContent = followId === id ? 'following (f to release)' : 'follow (f)'
  // §47.2: the sheet is a server read, like a building's provenance
  connection.send({ t: 'inspectAgent', agentId: id })
}

/** text bar in the pane grammar: ▓▓▓░░ */
function bar(frac: number, n = 8): string {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)))
  return '▓'.repeat(k) + '░'.repeat(n - k)
}

function traitWords(t: { risk: number; horizon: number; intensity: number }): string {
  const w: string[] = []
  w.push(t.risk >= 0.66 ? 'bold' : t.risk <= 0.33 ? 'careful' : 'measured')
  w.push(t.horizon >= 0.66 ? 'patient' : t.horizon <= 0.33 ? 'short-horizon' : 'steady')
  w.push(t.intensity >= 0.66 ? 'intensifier' : t.intensity <= 0.33 ? 'light touch' : 'moderate')
  return w.join(' · ')
}

/**
 * §47.2: the character sheet — plan with its ground secured, the ledger at
 * the facility's terms, holdings that fly when clicked, the §23.1 vector as
 * plain words, and the §20.5 effort budget as a life bar.
 */
function showAgentSheet(a: import('@civ/protocol').AgentDetail): void {
  if (!a.found || selectedAgentId !== a.id) return
  let activity = 'idle'
  for (const p of presence.positions()) if (p.id === a.id) activity = p.activity
  const recent = [...archive]
    .reverse()
    .filter((e) => e.agentId === a.id)
    .slice(0, 3)
    .map((e) => e.rationale ?? e.type.replace(/_/g, ' '))
  const lifeFrac = a.effortBudget ? (a.effortSpent ?? 0) / a.effortBudget : 0
  el('insFacts').innerHTML = facts([
    ...(a.plan
      ? ([
          ['plan:', `${a.plan.text}  ${bar(a.plan.done / Math.max(1, a.plan.total), 5)} ${a.plan.done}/${a.plan.total}`],
        ] as Array<[string, string]>)
      : ([['doing:', activity]] as Array<[string, string]>)),
    [
      'balance:',
      `${(a.capital ?? 0).toLocaleString()} · debt ${(a.debt ?? 0).toLocaleString()} @ ${Math.round((a.ltv ?? 0) * 100)}% ltv`,
    ],
    [
      'holdings:',
      `${a.holdings?.length ?? 0} buildings · ${a.parcelCount ?? 0} parcels · est. ${(
        a.holdings?.reduce((s, h) => s + h.value, 0) ?? 0
      ).toLocaleString()}`,
    ],
    ...(a.traits ? ([['traits:', traitWords(a.traits)]] as Array<[string, string]>) : []),
    ['life:', `${bar(lifeFrac)} ${Math.round(lifeFrac * 100)}% of effort spent`],
    ...(recent.length ? ([['recent:', recent.join(' · ')]] as Array<[string, string]>) : []),
    ...(agentSite.get(a.id) ? ([['site:', 'attending, tether shows it']] as Array<[string, string]>) : []),
  ])
  // holdings as clickable rows, lineage-style — each flies to the asset
  const box = el('insLineageBox')
  if (a.holdings?.length) {
    box.classList.remove('hidden')
    el('insLineage').innerHTML = a.holdings
      .map(
        (h) =>
          `<div class="step hold" data-x="${h.x}" data-y="${h.y}"><span class="yr">${h.value.toLocaleString()}</span>` +
          `<span>${escapeHtml(h.label)}</span></div>`,
      )
      .join('')
  } else {
    box.classList.add('hidden')
  }
}

el('insLineage').addEventListener('click', (ev) => {
  const row = (ev.target as HTMLElement).closest('.hold') as HTMLElement | null
  if (!row?.dataset.x) return
  director.takeControl()
  rig.flyTo(pointAt(Number(row.dataset.x), Number(row.dataset.y)), 210, {
    polar: 0.84,
    duration: 2.0,
  })
})

/**
 * §36.2: follow mode. The camera tethers loosely — a damped flyTo re-issued as
 * the agent drifts, never a hard lock — and the log filters to the agent.
 */
function follow(id: string | null): void {
  followId = id
  followRefit = 0
  openAgentLog(id)
  if (id) {
    // following suspends the director and surfaces the chrome; release
    // re-arms the director, whose idle-resume rules take it from there
    director.enabled = false
    document.body.classList.remove('ambient')
    el('ambient').setAttribute('aria-pressed', 'false')
  } else {
    director.enabled = true
  }
  if (selectedAgentId) {
    const btn = el('followBtn')
    btn.classList.toggle('on', !!id)
    btn.textContent = id ? 'following (f to release)' : 'follow (f)'
  }
}

el('followBtn').addEventListener('click', () => {
  if (selectedAgentId) follow(followId === selectedAgentId ? null : selectedAgentId)
})

function agentPos(id: string): Vector3 | null {
  for (const a of presence.positions()) if (a.id === id) return pointAt(a.x, a.y)
  return null
}

function updateFollow(dt: number): void {
  if (!followId) return
  const at = agentPos(followId)
  if (!at) return
  followRefit -= dt
  // re-aim only when the agent has moved away from the last aim point, so the
  // camera lags and settles rather than gliding on rails
  if (followRefit <= 0 && at.distanceTo(rig.target) > 6) {
    rig.flyTo(at, Math.min(Math.max(rig.distance, 150), 260), { duration: 1.4 })
    followRefit = 0.7
  }
}

// crew (§36.2): the chunk's most active agents this generation
const crewPane = el('crew')
let crewTimer = 0

/** §51.3: status at a glance, in one glyph */
const STATUS_GLYPH: Record<string, string> = { working: '▲', travelling: '→', idle: '·' }

function agentStatus(activity: string | undefined): 'working' | 'travelling' | 'idle' {
  if (activity === 'building' || activity === 'demolishing') return 'working'
  if (activity === 'acquiring' || activity === 'moving') return 'travelling'
  return 'idle'
}

/** the plan the crew and the mini-card both read: the agent's own last line */
function lastPlanOf(id: string): string {
  for (let i = archive.length - 1; i >= 0; i--) {
    const e = archive[i]
    if (e.agentId === id) return e.rationale ?? e.type.replace(/_/g, ' ')
  }
  return ''
}

/**
 * §51.3: the crew pane lists everyone, not a top-8 — a stranger opening it is
 * looking for the roster, not a leaderboard. Working agents sort first, then
 * travelling, then idle; within a band, by what they have done this
 * generation. The chip carries the §51.3 identity colour.
 */
function renderCrew(): void {
  const gen = readouts?.generation ?? 0
  const counts = new Map<string, number>()
  for (const e of archive) {
    if (e.generation !== gen || !e.agentId) continue
    counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + 1)
  }
  const live = new Map<string, string>()
  for (const p of presence.positions()) live.set(p.id, p.activity)
  const RANK = { working: 0, travelling: 1, idle: 2 }
  const rows = [...roster.entries()]
    .map(([id, who]) => ({ id, who, status: agentStatus(live.get(id)), n: counts.get(id) ?? 0 }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.n - a.n || a.who.name.localeCompare(b.who.name))
  el('crewMeta').textContent = `${rows.length} · gen ${gen}`
  if (rows.length === 0) {
    el('crewList').innerHTML = '<span class="dim">no agents yet</span>'
    return
  }
  let band = ''
  el('crewList').innerHTML = rows
    .map((r) => {
      const head = r.status === band ? '' : `<div class="grp">${r.status}</div>`
      band = r.status
      const tone = agentColourHex(r.who.strategy, r.who.colourIndex)
      return (
        head +
        `<div class="a ${r.status}" data-id="${r.id}"><span class="chip" style="background:${tone}"></span>` +
        `<span class="st">${STATUS_GLYPH[r.status]}</span>` +
        `<span class="nm" style="color:${tone}">${escapeHtml(r.who.name.split(' ')[0])}</span>` +
        `<span class="plan">${escapeHtml(lastPlanOf(r.id) || `gen ${r.who.generation} · ${r.who.strategy}`)}</span>` +
        `<span class="ct">${r.n || ''}</span></div>`
      )
    })
    .join('')
}

el('crewList').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('.a') as HTMLElement | null
  const id = row?.dataset.id
  if (!id) return
  showAgentCard(id)
  follow(id)
})

function toggleCrew(force?: boolean): void {
  const on = force ?? !crewPane.classList.contains('on')
  crewPane.classList.toggle('on', on)
  if (on) renderCrew()
}
el('crewClose').addEventListener('click', () => toggleCrew(false))
// §51.3: the same pane the `r` key opens, reachable by anyone who never
// learned there was an `r` key
el('agentsBtn').addEventListener('click', () => toggleCrew())

// DOF r2: the focus toggle sits in the bottom bar, beside where the §40.5
// sound toggle lands — the two settings a viewer might actually want off
el('focusBtn').addEventListener('click', () => {
  focusOn = !focusOn
  el('focusBtn').setAttribute('aria-pressed', String(focusOn))
  el('focusBtn').textContent = focusOn ? 'focus soft' : 'focus off'
})

/**
 * §51.3: the mini-card. Hovering a floating marker names the agent, its plan
 * and its balance, without the commitment of a follow. The balance is a
 * server read like the sheet's — asked once per agent and cached, so sweeping
 * the cursor across a working street costs one question per character.
 */
const agentCache = new Map<string, import('@civ/protocol').AgentDetail>()
const asked = new Set<string>()
let hoverId: string | null = null
const lastPointer: [number, number] = [0, 0]

function markAt(px: number, py: number): string | null {
  if (mode !== 'city') return null
  const v = new Vector3()
  let best: { id: string; d: number } | null = null
  for (const m of floatLights.marks) {
    v.copy(m.position).project(rig.camera)
    if (v.z > 1) continue
    const sx = ((v.x + 1) / 2) * innerWidth
    const sy = (1 - (v.y + 1) / 2) * innerHeight
    const d = Math.hypot(sx - px, sy - py)
    if (d < 26 && (!best || d < best.d)) best = { id: m.id, d }
  }
  return best?.id ?? null
}

function renderMiniCard(id: string, px: number, py: number): void {
  const who = roster.get(id)
  if (!who) return
  const card = el('miniCard')
  const detail = agentCache.get(id)
  const tone = agentColourHex(who.strategy, who.colourIndex)
  const plan = detail?.plan?.text ?? lastPlanOf(id) ?? ''
  const balance = detail
    ? `${(detail.capital ?? 0).toLocaleString()} · debt ${(detail.debt ?? 0).toLocaleString()}`
    : 'reading the ledger…'
  card.innerHTML =
    `<span class="nm" style="color:${tone}">${escapeHtml(who.name.split(' ')[0])}</span> ` +
    `<span class="dim">${escapeHtml(who.strategy)}</span>` +
    (plan ? `<div class="ln">${escapeHtml(plan)}</div>` : '') +
    `<div class="ln">${escapeHtml(balance)}</div>`
  card.classList.add('on')
  // keep the card on screen: flip it left/up near the edges
  const w = card.offsetWidth
  const h = card.offsetHeight
  card.style.left = `${Math.min(px + 14, innerWidth - w - 8)}px`
  card.style.top = `${Math.min(Math.max(8, py - h - 12), innerHeight - h - 8)}px`
}

canvas.addEventListener('pointermove', (e) => {
  lastPointer[0] = e.clientX
  lastPointer[1] = e.clientY
  const id = markAt(e.clientX, e.clientY)
  if (!id) {
    hoverId = null
    el('miniCard').classList.remove('on')
    return
  }
  hoverId = id
  if (!asked.has(id)) {
    asked.add(id)
    connection.send({ t: 'inspectAgent', agentId: id })
  }
  renderMiniCard(id, e.clientX, e.clientY)
})
canvas.addEventListener('pointerleave', () => {
  hoverId = null
  el('miniCard').classList.remove('on')
})

// ---------------------------------------------------------------------------
// <name>.log — while following, the agent narrates its own work
// ---------------------------------------------------------------------------

const agentFeed = el('agentFeed')
const agentQueue: EventWire[] = []

function queueAgentRow(e: EventWire): void {
  agentQueue.push(e)
  if (agentQueue.length > 60) agentQueue.shift()
}

setInterval(() => {
  const e = agentQueue.shift()
  if (!e || !followId) return
  const row = document.createElement('div')
  row.className = `e ${severity(e.cinematicWeight)}`
  row.innerHTML =
    `<span class="ord">${e.id}</span><span class="t"><span class="tx"></span></span>`
  agentFeed.insertAdjacentElement('afterbegin', row)
  typeInto(row.querySelector('.tx') as HTMLElement, e.rationale ?? e.type.replace(/_/g, ' '), false)
  while (agentFeed.childElementCount > 9) agentFeed.lastElementChild?.remove()
}, 420)

/** the pane belongs to one agent: opening it on another starts it empty */
function openAgentLog(id: string | null): void {
  agentQueue.length = 0
  agentFeed.innerHTML = ''
  document.body.classList.toggle('following', !!id)
  if (!id) return
  const who = roster.get(id)
  const first = (who?.name.split(' ')[0] ?? 'agent').toLowerCase()
  el('agentLogName').textContent = `${first}.log`
  el('agentLogName').style.color = who ? agentColourHex(who.strategy, who.colourIndex) : ''
  el('agentLogMeta').textContent = who ? `gen ${who.generation} · ${who.strategy}` : ''
  // seed with what this session already watched them do
  for (const e of archive.filter((x) => x.agentId === id).slice(-9)) {
    const row = document.createElement('div')
    row.className = `e ${severity(e.cinematicWeight)}`
    row.innerHTML =
      `<span class="ord">${e.id}</span><span class="t">${escapeHtml(
        e.rationale ?? e.type.replace(/_/g, ' '),
      )}</span>`
    agentFeed.insertAdjacentElement('afterbegin', row)
  }
}
el('agentLogClose').addEventListener('click', () => follow(null))

// ---------------------------------------------------------------------------
// §36.1: the city switcher, over the chunk index the loader already reads
// ---------------------------------------------------------------------------

const chunksPane = el('chunks')

/**
 * §46.1: the switcher is live city cards fed by /summary — the data is
 * already served; the switcher spends it. Every distinct server origin is
 * asked once (production: one origin answers for all eight; local dev: one
 * per port) and the arrays merge by chunk id.
 */
interface CitySummary {
  id: string
  generation?: number
  divergenceIndex?: number
  agentCount?: number
  activityRate?: number
  /** §40.6: summed cinematic weight over the recent window — watchability */
  heat?: number
  lastEvent?: { text: string; weight: number }
}
const citySummaries = new Map<string, CitySummary>()
const citySpark = new Map<string, number[]>()

function summaryOrigins(): string[] {
  const origins = new Set<string>()
  for (const c of chunks) {
    const ws = c.id === entry.id ? serverUrl() : servers[c.id]
    if (!ws) continue
    if (location.protocol === 'https:' && ws.startsWith('ws://')) continue
    origins.add(ws.replace(/^ws/, 'http').replace(/\/ws\/.*$/, '').replace(/\/$/, ''))
  }
  return [...origins]
}

async function pollSummaries(): Promise<void> {
  await Promise.all(
    summaryOrigins().map(async (origin) => {
      try {
        const r = await fetch(`${origin}/summary`, { signal: AbortSignal.timeout(4000) })
        const list = (await r.json()) as CitySummary[]
        for (const s of list) {
          if (!chunks.some((c) => c.id === s.id)) continue
          citySummaries.set(s.id, s)
          const hist = citySpark.get(s.id) ?? []
          hist.push(s.activityRate ?? 0)
          if (hist.length > 10) hist.shift()
          citySpark.set(s.id, hist)
        }
      } catch {
        // an unreachable origin leaves its cards static; the pane still works
      }
    }),
  )
  renderCityCards()
}

const SPARK_GLYPHS = '▁▂▃▄▅▆▇'
function sparkline(id: string): string {
  const hist = citySpark.get(id)
  if (!hist?.length) return ''
  const max = Math.max(...hist, 1e-6)
  return hist.map((v) => SPARK_GLYPHS[Math.min(6, Math.floor((v / max) * 6.99))]).join('')
}

function renderCityCards(): void {
  const rows = chunks
    .map((c) => ({ c, s: citySummaries.get(c.id) }))
    .sort((a, b) => (b.s?.heat ?? b.s?.activityRate ?? -1) - (a.s?.heat ?? a.s?.activityRate ?? -1))
  el('chunkList').innerHTML = rows
    .map(({ c, s }) => {
      const mat = CITY_MATERIALS[c.id] ?? CITY_MATERIAL_DEFAULT
      const facts = s
        ? `gen ${s.generation ?? '·'} · ${((s.divergenceIndex ?? 0) * 100).toFixed(1)}% diff · ${s.agentCount ?? '·'} active`
        : 'unreached — baseline only'
      const spark = sparkline(c.id)
      const last = s?.lastEvent ? `last: ${s.lastEvent.text}` : ''
      return (
        `<div class="c card${c.id === entry.id ? ' here' : ''}" data-id="${c.id}">` +
        `<div class="hd"><span class="sw" style="background:${mat.roofTarget}"></span>` +
        `<span class="nm">${escapeHtml(placeName(c.name))}</span>` +
        `<span class="where">${c.id === entry.id ? 'here' : ''}</span></div>` +
        `<div class="ln">${escapeHtml(facts)}</div>` +
        (spark ? `<div class="ln spark">${spark} activity</div>` : '') +
        (last ? `<div class="ln dim">${escapeHtml(last)}</div>` : '') +
        `</div>`
      )
    })
    .join('')
}

renderCityCards()
let summaryTimer: ReturnType<typeof setInterval> | null = null

function openChunksPane(on: boolean): void {
  chunksPane.classList.toggle('on', on)
  if (on) {
    void pollSummaries()
    summaryTimer ??= setInterval(() => {
      if (chunksPane.classList.contains('on')) void pollSummaries()
    }, 10_000)
  }
}

el('chunkBtn').addEventListener('click', () => openChunksPane(!chunksPane.classList.contains('on')))
el('chunksClose').addEventListener('click', () => openChunksPane(false))
el('chunkList').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('.c') as HTMLElement | null
  if (row?.dataset.id) switchTo(row.dataset.id)
})

function switchTo(id: string): void {
  if (id === entry.id || !chunks.some((c) => c.id === id)) return
  const q = new URLSearchParams(location.search)
  q.set('chunk', id)
  // §36.1: the destination's server comes from the per-chunk map, not from the
  // override that pointed at this one
  q.delete('server')
  sessionStorage.setItem('tf-arrive', '1')
  location.search = q.toString()
}

function cycleChunk(step: number): void {
  const i = chunks.findIndex((c) => c.id === entry.id)
  switchTo(chunks[(i + step + chunks.length) % chunks.length].id)
}

// ---------------------------------------------------------------------------
// §36.4: the changelog rail — what happened, per generation, while you were gone
// ---------------------------------------------------------------------------

function renderChangelog(): void {
  const gens = new Map<number, EventWire[]>()
  for (const e of archive) {
    const g = gens.get(e.generation) ?? []
    g.push(e)
    gens.set(e.generation, g)
  }
  const parts: string[] = []
  for (const [gen, evs] of [...gens.entries()].sort((a, b) => b[0] - a[0])) {
    const builds = evs.filter((e) => e.type === 'construction_completed').length
    const demos = evs.filter((e) => e.type === 'demolition_completed').length
    const assemblies = evs.filter((e) => e.type === 'parcels_assembled').length
    const top = [...evs].sort((a, b) => b.cinematicWeight - a.cinematicWeight).slice(0, 5)
    parts.push(
      `<div class="g"><div class="hd">g${gen} · ${evs.length} actions · ${builds} builds · ${demos} demolitions · ${assemblies} assemblies</div>` +
        top
          .map(
            (e, i) =>
              `<div class="ev" data-g="${gen}" data-i="${i}"><span class="w">${Math.round(
                e.cinematicWeight,
              )}</span><span class="t">${
                e.agentName ? `${escapeHtml(e.agentName.split(' ')[0])} ` : ''
              }${escapeHtml(e.rationale ?? e.type.replace(/_/g, ' '))}</span></div>`,
          )
          .join('') +
        '</div>',
    )
  }
  el('changelogList').innerHTML =
    parts.join('') || '<span class="dim">nothing observed yet this session</span>'
  // remember what each row points at, for the click-to-fly
  changelogTop.clear()
  for (const [gen, evs] of gens) {
    changelogTop.set(
      gen,
      [...evs].sort((a, b) => b.cinematicWeight - a.cinematicWeight).slice(0, 5),
    )
  }
}

const changelogTop = new Map<number, EventWire[]>()

el('changelogList').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('.ev') as HTMLElement | null
  if (!row) return
  const ev = changelogTop.get(Number(row.dataset.g))?.[Number(row.dataset.i)]
  if (!ev) return
  const at =
    ev.x !== undefined && ev.y !== undefined
      ? pointAt(ev.x, ev.y)
      : ev.buildingId && places.get(ev.buildingId)
        ? pointAt(...(places.get(ev.buildingId) as [number, number]))
        : null
  if (!at) return
  director.takeControl()
  rig.flyTo(at, 260, { polar: 0.8, duration: 2.2 })
})

// ---------------------------------------------------------------------------
// §35.2 boot and §36.3 entry explainer
// ---------------------------------------------------------------------------

const boot = el('boot')
const BOOT_MIN_MS = 2000
const bootStarted = performance.now()
let bootDone = false

function bootLine(text: string, cls = ''): HTMLElement {
  const div = document.createElement('div')
  div.textContent = text
  if (cls) div.className = cls
  el('bootLines').appendChild(div)
  return div
}

function endBoot(): void {
  if (bootDone) return
  bootDone = true
  sessionStorage.setItem('tf-boot', '1')
  boot.classList.add('fading')
  setTimeout(() => boot.remove(), 700)
  maybeExplain()
}

let attachEl: HTMLElement | null = null
if (sessionStorage.getItem('tf-boot') === '1') {
  bootDone = true
  boot.remove()
  maybeExplain()
} else {
  el('bootLines').firstElementChild?.classList.add('done')
  bootLine(`reading baseline… ${seed.stats.baselineBuildings.toLocaleString()} buildings`, 'done')
  setTimeout(() => {
    if (!bootDone && !attachEl) attachEl = bootLine('attaching to world…')
  }, 500)
  setTimeout(endBoot, BOOT_MIN_MS)
  // skippable: any interaction ends it
  addEventListener('pointerdown', endBoot, { once: true })
  addEventListener('keydown', endBoot, { once: true })
}

function bootAttached(): void {
  if (bootDone) return
  attachEl ??= bootLine('attaching to world…')
  attachEl.textContent = 'attaching to world… live'
  attachEl.className = 'live'
  const elapsed = performance.now() - bootStarted
  if (elapsed >= BOOT_MIN_MS) endBoot()
}

function maybeExplain(): void {
  if (localStorage.getItem('tf-explained') === '1') return
  el('explainer').style.display = ''
}

function openCards(withHelp: boolean): void {
  el('explainer').style.display = ''
  el('help').classList.toggle('on', withHelp)
}

function dismissCards(): void {
  localStorage.setItem('tf-explained', '1')
  el('explainer').style.display = 'none'
  el('help').classList.remove('on')
}

el('watchBtn').addEventListener('click', dismissCards)
el('explainerClose').addEventListener('click', dismissCards)
el('helpClose').addEventListener('click', () => el('help').classList.remove('on'))
el('helpBtn').addEventListener('click', () => openCards(true))
// §36.3: dismiss on click-through or any interaction with the world
canvas.addEventListener('pointerdown', () => {
  if (el('explainer').style.display !== 'none') dismissCards()
})

// §36.3: data credits, deduped, licence text behind the ? pane rather than
// printed twice in a corner panel (§35.6)
const creditSeen = new Set<string>()
el('credits').innerHTML =
  seed.provenance
    .map((p) => `${p.source} · ${p.licence}`.replace(/\s+—\s+/g, ' · '))
    .filter((l) => !creditSeen.has(l) && (creditSeen.add(l), true))
    .map((l) => `<div>${escapeHtml(l)}</div>`)
    .join('') + '<div><a href="/preview/">archetype harness</a></div>'

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/**
 * Ambient mode: §15's "leave it running". The director is on by default — the
 * attract camera is the default experience, chrome or no chrome — so ambient
 * is purely the chrome receding. The old toggle flipped the director instead,
 * which on first press turned the auto-camera off and left every panel up:
 * the opposite of ambient, while the button claimed otherwise.
 */
function toggleAmbient(): void {
  if (followId) follow(null)
  const on = !document.body.classList.contains('ambient')
  ambientWasOn = on
  if (ambientResumeTimer) clearTimeout(ambientResumeTimer)
  // §24.1: "panels ... gone entirely in ambient." The top bar keeps the ambient
  // button itself reachable, so it is exempt — leaving it running must not mean
  // leaving it with no way out.
  document.body.classList.toggle('ambient', on)
  el('ambient').setAttribute('aria-pressed', String(on))
  if (on) {
    // §46.4: an ambient return presents the framed view before the director
    // resumes its cuts — the same rule as first load
    director.enabled = false
    rig.flyTo(new Vector3(0, substrate.groundY, 0), frameThePlate(innerWidth / innerHeight), {
      azimuth: CITY_AZIMUTH,
      polar: 0.66,
      duration: 1.6,
    })
    setTimeout(() => {
      if (!followId && document.body.classList.contains('ambient')) director.enabled = true
    }, 2400)
  } else {
    director.enabled = true
  }
}
el('ambient').addEventListener('click', toggleAmbient)

// §40.1: the ghost is a HOLD, so it needs the release too — and a blur, or a
// tab switch mid-hold would leave the world wearing its own past forever
addEventListener('keyup', (e) => {
  if (e.key === 'b') ghost.held = false
})
addEventListener('blur', () => {
  ghost.held = false
})

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  // the boot's own once-listener consumes the first key as a skip
  if (!bootDone) return
  switch (e.key) {
    case 'a':
      toggleAmbient()
      break
    case 'd': {
      // §36.3: "press d for the diff against reality"
      const to = Number(modeInput.value) < 0.5 ? 1 : 0
      modeInput.value = String(to)
      modeInput.dispatchEvent(new Event('input'))
      break
    }
    case 'f':
      if (followId) follow(null)
      else if (selectedAgentId) follow(selectedAgentId)
      break
    case 'p':
      // §51.2: a sticky hold on the stream, for reading rather than watching
      feedPausedByKey = !feedPausedByKey
      renderFeedTail()
      break
    case 'b':
      // §40.1: hold to see what was here
      if (mode === 'city') ghost.held = true
      break
    case 't':
      if (mode === 'city') startTimelapse()
      break
    case 'v':
      setVerbose(!verboseFeed)
      break
    case 'r':
      toggleCrew()
      break
    case '[':
      cycleChunk(-1)
      break
    case ']':
      cycleChunk(1)
      break
    case '?':
      openCards(true)
      break
    case '0':
      // §51.1: 0 returns to the chunk's home framing
      if (mode === 'city') civHome()
      else frameGlobeHome(1.6)
      break
    case 'Escape':
      select(null)
      chunksPane.classList.remove('on')
      break
  }
})

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false)
  const aspect = innerWidth / innerHeight
  rig.setAspect(aspect)
  // §24.1: the city framing is derived from the frame width, so a narrower
  // window has to pull back or it crops the plate rather than filling with it.
  // Clamping into the new limit is enough on its own: a viewer who has zoomed
  // in is already below the maximum and is left alone, and one sitting at city
  // framing lands on the new city framing.
  rig.limits.maxDistance = frameThePlate(aspect) * 1.25
  rig.distance = Math.min(rig.distance, rig.limits.maxDistance)
  const pr = renderer.getPixelRatio()
  tiltShift.setSize(Math.floor(innerWidth * pr), Math.floor(innerHeight * pr))
}
addEventListener('resize', resize)
resize()

let last = performance.now()
let clock = 0
const chipV = new Vector3()
const tetherColour = new Color()

function updateTethers(): void {
  let n = 0
  for (const a of presence.positions()) {
    if (n >= TETHER_MAX) break
    if (a.activity !== 'building' && a.activity !== 'demolishing') continue
    const site = agentSite.get(a.id)
    if (!site) continue
    const i = n * 6
    tetherPos[i] = a.x
    tetherPos[i + 1] = substrate.groundY + 3.4
    tetherPos[i + 2] = -a.y
    tetherPos[i + 3] = site[0]
    tetherPos[i + 4] = substrate.groundY + 0.6
    tetherPos[i + 5] = -site[1]
    const who = roster.get(a.id)
    // §51.3: the tether is the agent's own colour, so which worker owns which
    // site reads without reading a name
    tetherColour.copy(agentColour(who?.strategy ?? '', who?.colourIndex ?? 0))
    tetherCol[i] = tetherColour.r
    tetherCol[i + 1] = tetherColour.g
    tetherCol[i + 2] = tetherColour.b
    tetherCol[i + 3] = tetherColour.r
    tetherCol[i + 4] = tetherColour.g
    tetherCol[i + 5] = tetherColour.b
    n++
  }
  tetherGeo.setDrawRange(0, n * 2)
  ;(tetherGeo.getAttribute('position') as BufferAttribute).needsUpdate = true
  ;(tetherGeo.getAttribute('color') as BufferAttribute).needsUpdate = true
}

/** §35.6: the shot chip is anchored to what it labels, lowercase, in chrome. */
function updateChip(): void {
  const chip = el('chip')
  let world: Vector3 | null = null
  let who = ''
  let what = ''
  if (followId) {
    world = agentPos(followId)
    who = (roster.get(followId)?.name.split(' ')[0] ?? 'agent').toLowerCase()
    what = ' · following'
  } else if (director.inControl && director.shotTarget) {
    const intent = director.shotIntent
    if (intent?.kind === 'follow_agent') {
      world = agentPos(intent.agentId) ?? director.shotTarget
      who = (roster.get(intent.agentId)?.name.split(' ')[0] ?? '').toLowerCase()
      what = who ? ` · ${director.activeLabel ?? ''}` : (director.activeLabel ?? '')
    } else {
      world = director.shotTarget
      what = director.activeLabel ?? ''
    }
  }
  if (!world) {
    chip.classList.remove('on')
    return
  }
  chipV.copy(world)
  chipV.y += 9
  chipV.project(rig.camera)
  if (chipV.z > 1) {
    chip.classList.remove('on')
    return
  }
  chip.style.left = `${((chipV.x + 1) / 2) * innerWidth}px`
  chip.style.top = `${(1 - (chipV.y + 1) / 2) * innerHeight}px`
  el('chipWho').textContent = who
  el('chipWhat').textContent = what
  chip.classList.add('on')
}

renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  clock += dt

  // §5/§21.6: positions are interpolated between frames rather than simulated.
  // Nothing in this loop advances the world.
  presence.advance(dt)

  updateFollow(dt)
  rig.update(dt)
  director.update(dt, liveTick)

  // §50.3: relights run down before the upload, so a converted building's
  // windows climb it in the same frame the texel change landed
  buildings.tickLights(dt, clock)
  ghost.update(dt)
  sound.update(dt, readouts?.pace.decisionsPerSecond ?? 0)
  if (cinematicCooldown > 0) cinematicCooldown -= dt
  // §21.6: one upload per rendered frame, however many arrived since the last
  observer.flush()
  agentMarkers.update(withIdentity(), substrate.groundY, dt, clock)
  construction.update(observer.sites(), clock)
  punctuation.update(dt)
  updateTethers()
  updateChip()

  if (mode === 'city') {
    floatLights.setAgents(floatAgents(), substrate.groundY, rig.distance)
    floatLights.update(dt)
  } else {
    // §49: the recorded migrations replay as travelling lights
    globeArcs.update(dt)
    arcTimer -= dt
    if (arcTimer <= 0 && migrationRecord.length) {
      arcTimer = 2.6
      const m = migrationRecord[arcCursor++ % migrationRecord.length]
      const from = globe.markers.find((x) => x.id === m.fromChunk)?.position
      const to = globe.markers.find((x) => x.id === m.toSettlement)?.position
      if (from && to) globeArcs.launchArc(from, to)
    }
  }

  crewTimer += dt
  if (crewTimer > 1.5) {
    crewTimer = 0
    if (crewPane.classList.contains('on')) renderCrew()
  }

  if (scene.fog && 'near' in scene.fog) {
    scene.fog.near = rig.distance * 0.8
    scene.fog.far = rig.distance * 2.1
  }
  env.sky.position.copy(rig.camera.position)
  substrate.tick(clock)

  /**
   * §24.1: "widen the tilt-shift sharp band so it covers the plate rather than
   * a strip."
   *
   * At 0.055 the sharp band was about 100 m of depth against a plate that
   * spans roughly 370 m front to back at this tilt, so the top and bottom
   * thirds blurred out and the world read as small rather than as miniature.
   * Those are different effects and the old setting delivered both.
   *
   * The width is derived rather than dialled. A 604 m plate seen from 52
   * degrees above the horizontal has a depth extent of 604*cos(52) = 370 m, so
   * half of that is 185 m either side of the focal plane — and at the city
   * distance of about 1835 m that is 0.10. Which is the number to use: it puts
   * the plate inside the band and nothing else, so the falloff still lands on
   * the water and the far edge, which is where the diorama read comes from. A
   * first pass at 0.16 covered the plate and a long way past it, and turned the
   * effect off.
   *
   * §39: that 0.10 baked in the city-framing tilt. The visible depth extent
   * scales with sin(polar) — cos of the elevation — so an oblique director
   * shot has more depth in frame than the framed orientation and the fixed
   * ratio melted the near corner. Same derivation, evaluated for the current
   * view: identical at the calibrated case (polar 0.66), wider as the camera
   * comes down, narrower toward top-down where there is no depth to keep.
   */
  /**
   * DOF r2. The §39 derivation was right about the mechanism and much too
   * timid about the amount: sin(polar) alone widens the band by about half
   * between the home framing and the pitch floor, and an oblique frame does
   * not have half again as much depth in it — it has the whole plate, from
   * the near kerb to the far skyline, all of it subject. The melted-church
   * frame is what that costs.
   *
   * So obliquity now drives the band hard, and proximity drives it harder
   * still: at the home framing the diorama read is untouched, by the pitch
   * floor the band is several times wider, and at street framing it covers
   * everything in front of the camera — which is the same thing as off.
   */
  const oblique = clamp01((rig.polar - 0.66) / (rig.limits.maxPolar - 0.66))
  // `streetness` is the LENS ramp — it is already 0.74 at 430 m, because the
  // fov starts opening long before the camera is in a street. Borrowing it for
  // the focal band widened the band on a neighbourhood view that still wants
  // the diorama read. Proximity gets its own ramp, which stays at zero until
  // the camera is genuinely close.
  const close = clamp01((rig.lens.cityDistance * 0.35 - rig.distance) / (rig.lens.cityDistance * 0.35 - rig.lens.streetDistance))
  tiltShift.focusRange = Math.max(
    30,
    rig.distance * 0.1 * (1 + 7 * oblique * oblique) * (1 + 6 * close * close),
  )
  // §49: the globe is fully exempt from the miniature's depth of field — the
  // grade and vignette still apply, the blur does not
  tiltShift.render(
    renderer,
    scene,
    rig.camera,
    // focus follows attention: rig.distance is the distance to the orbit
    // target, so the plane sits on whatever the camera is pointed at — the
    // double-click focus, the followed agent, the log line's fly-to
    rig.distance,
    mode === 'globe' || !focusOn ? 0 : (1 - close) * (1 - close),
  )
  if (mode === 'globe') {
    globe.updateLOD(rig.distance)
    updateGlobeLabels()
    // §49 r3: ambient returns to the home framing, the globe's drift-back
    globeIdle += dt
    if (globeIdle > 14 && document.body.classList.contains('ambient')) {
      globeIdle = -24
      frameGlobeHome(3.4)
    }
  }
})

function* floatAgents(): Generator<import('./render/floatlights.ts').FloatAgent> {
  for (const a of presence.positions()) {
    const who = roster.get(a.id)
    if (!who) continue
    yield {
      id: a.id,
      x: a.x,
      y: a.y,
      activity: a.activity,
      strategy: who.strategy,
      colourIndex: who.colourIndex,
      name: who.name,
      followed: followId === a.id,
    }
  }
}

function* withIdentity(): Generator<AgentPresence> {
  for (const a of presence.positions()) {
    const who = roster.get(a.id)
    yield { ...a, strategy: who?.strategy ?? 'consolidator', colourIndex: who?.colourIndex ?? 0 }
  }
}

/** §51.1: the chunk's home framing — 0 lands here, as do load and switch */
function civHome(): void {
  director.takeControl()
  rig.flyTo(new Vector3(0, substrate.groundY, 0), frameThePlate(innerWidth / innerHeight), {
    azimuth: CITY_AZIMUTH,
    polar: 0.66,
    duration: 1.2,
  })
}

// exposed for tooling and for driving screenshots
;(window as unknown as Record<string, unknown>).civ = {
  rig,
  buildings,
  observer,
  director,
  connection,
  select,
  follow,
  get readouts() {
    return readouts
  },
  get roster() {
    return roster
  },
  /** §40 hooks for the capture rigs */
  ghost: () => ({ held: ghost.held, visible: ghost.lines.visible }),
  timelapseRunning: () => timelapse !== null,
  retainedOrdinals: () => availableOrdinals.length,
  /** DOF r2: what the focal band is doing right now, for the capture rigs */
  dof: () => ({
    range: tiltShift.focusRange,
    strength: tiltShift.lastStrength,
    maxBlurPx: tiltShift.maxBlurPx,
    on: focusOn,
  }),
  /** §51.3 hooks for the capture rigs: what floats, who is followed, what colour */
  floatMarks: () => floatLights.marks,
  followedId: () => followId,
  colourOf: (strategy: string, colourIndex: number) => agentColourHex(strategy, colourIndex),
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
  ui: {
    explainer: () => openCards(false),
    help: () => openCards(true),
    crew: (on?: boolean) => toggleCrew(on),
    agentCard: (id: string) => showAgentCard(id),
    chunks: () => chunks,
    switchTo,
    toGlobe,
    diveTo,
    orbitFor,
    /** return to the §24.1 framed orientation, for tooling and captures */
    home: civHome,
  },
}


/**
 * §49.4: first load is boot -> globe -> one beat -> dive to the busiest
 * city. Once per session: a switch or a refresh mid-visit lands directly in
 * its city, and the intro never traps a returning viewer.
 */
const bareLoad = !new URLSearchParams(location.search).has('chunk')
if (bareLoad && !arriving && !sessionStorage.getItem('tf-globe-seen')) {
  sessionStorage.setItem('tf-globe-seen', '1')
  toGlobe()
  void pollSummaries().then(() => {
    setTimeout(() => {
      if (mode !== 'globe') return
      // §40.6: the busiest city is the one with the most watchable work in
      // it, not the one filing the most paperwork — heat is the summed
      // cinematic weight of the recent window, and only falls back to the raw
      // rate for a chunk too old to be serving it
      let busiest = entry.id
      let best = -1
      for (const [id, s] of citySummaries) {
        const score = s.heat ?? s.activityRate ?? 0
        if (score > best) {
          best = score
          busiest = id
        }
      }
      diveTo(busiest)
    }, 2600)
  })
}
