/**
 * §49 (simplified): the globe is a SELECTOR, not a world visualization. The
 * default view is the dark legible earth — lifted coastline ink over a
 * minimally-lit blue-grey body, never void-black — and the eight active-city
 * marks; labels live in the crisp screen-space chrome layer. The 34k coarse
 * candidates are preserved behind a layer toggle and return as the default
 * only when on-demand materialisation ships to production, when an unseeded
 * town igniting is something a spectator could actually witness.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'

/**
 * Anchors from each seed's chunk.origin (the importer's own emitted values),
 * restated here because the client loads one seed at a time and the globe
 * needs all eight. If a chunk moves, its seed moves, and this table is wrong
 * until updated — the values carry their provenance for exactly that check.
 */
export const CHUNK_ANCHORS: Record<string, [lat: number, lon: number]> = {
  'schiedam-havens': [51.916, 4.396],
  'london-deptford': [51.4816, -0.0266],
  'brooklyn-redhook': [40.6752, -74.0088],
  'paris-ourcq': [48.8905, 2.3831],
  'tokyo-kyojima': [35.7143, 139.8211],
  'vlaardingen-westwijk': [51.9048, 4.3268],
  'maasland-dorp': [51.9366, 4.2758],
  'maassluis-haven': [51.9224, 4.2492],
}

export function latLonTo(radius: number, lat: number, lon: number, out = new Vector3()): Vector3 {
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  out.set(
    radius * Math.cos(la) * Math.cos(lo),
    radius * Math.sin(la),
    -radius * Math.cos(la) * Math.sin(lo),
  )
  return out
}

interface Candidate {
  lat: number
  lon: number
  population: number
  valueIndex?: number
}

export interface GlobeMarker {
  id: string
  position: Vector3
  sprite: Sprite
  /** §49 r2: labels render in the crisp chrome layer, so the name ships raw */
  name: string
}

export class GlobeView {
  readonly group = new Group()
  readonly radius: number
  readonly markers: GlobeMarker[] = []
  private tailPoints: Points | null = null

  /** §49 r2: the long tail fades in below ~2.4 radii and is gone far out */
  updateLOD(cameraDistance: number): void {
    if (!this.tailPoints) return
    const t = Math.max(0, Math.min(1, (this.radius * 2.4 - cameraDistance) / (this.radius * 1.2)))
    ;(this.tailPoints.material as PointsMaterial).opacity = 0.8 * t
  }

  constructor(radius: number, chunkIds: string[], names: Map<string, string>) {
    this.radius = radius
    this.group.visible = false

    // §49 r2: a very dark blue-grey body, minimally lit — the planet is a
    // form against the void, never void-black itself
    const sphere = new Mesh(
      new SphereGeometry(radius, 48, 32),
      new MeshLambertMaterial({ color: new Color('#182029'), emissive: new Color('#0b0f14') }),
    )
    this.group.add(sphere)

    // faint graticule, every 15 degrees
    const grat: number[] = []
    const seg = 72
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let i = 0; i < seg; i++) {
        const a = latLonTo(radius + 0.5, lat, (i / seg) * 360 - 180)
        const b = latLonTo(radius + 0.5, lat, ((i + 1) / seg) * 360 - 180)
        grat.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    for (let lon = -180; lon < 180; lon += 15) {
      for (let i = 0; i < seg; i++) {
        const a = latLonTo(radius + 0.5, (i / seg) * 180 - 90, lon)
        const b = latLonTo(radius + 0.5, ((i + 1) / seg) * 180 - 90, lon)
        grat.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    const gratGeo = new BufferGeometry()
    gratGeo.setAttribute('position', new BufferAttribute(new Float32Array(grat), 3))
    this.group.add(
      new LineSegments(
        gratGeo,
        new LineBasicMaterial({ color: new Color('#2a2721'), transparent: true, opacity: 0.35 }),
      ),
    )

    // amber marks + labels for the active chunks
    for (const id of chunkIds) {
      const anchor = CHUNK_ANCHORS[id]
      if (!anchor) continue
      const position = latLonTo(radius + 2, anchor[0], anchor[1])
      const mark = new Sprite(
        new SpriteMaterial({ map: markTexture(), depthTest: false, transparent: true }),
      )
      mark.scale.set(radius * 0.028, radius * 0.028, 1)
      mark.position.copy(position)
      this.group.add(mark)
      this.markers.push({ id, position, sprite: mark, name: shortName(names.get(id) ?? id) })
    }

    void this.loadCoastline()
  }

  private candidatesLoaded = false
  private candidateGroup = new Group()

  /** §49: the candidates layer toggle — off by default, lazy on first use */
  setCandidates(on: boolean): void {
    if (on && !this.candidatesLoaded) {
      this.candidatesLoaded = true
      this.group.add(this.candidateGroup)
      void this.loadCandidates()
    }
    this.candidateGroup.visible = on
  }

  get candidatesOn(): boolean {
    return this.candidatesLoaded && this.candidateGroup.visible
  }

  /** coastline in the dim register, from the committed 110m land asset */
  private async loadCoastline(): Promise<void> {
    try {
      const r = await fetch('/world/coarse/land-110m.json')
      const gj = (await r.json()) as {
        features: Array<{ geometry: { type: string; coordinates: number[][][] | number[][][][] } }>
      }
      const positions: number[] = []
      const push = (ring: number[][]) => {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = latLonTo(this.radius + 0.8, ring[i][1], ring[i][0])
          const b = latLonTo(this.radius + 0.8, ring[i + 1][1], ring[i + 1][0])
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
      }
      for (const f of gj.features) {
        if (f.geometry.type === 'Polygon')
          for (const ring of f.geometry.coordinates as number[][][]) push(ring)
        else if (f.geometry.type === 'MultiPolygon')
          for (const poly of f.geometry.coordinates as number[][][][])
            for (const ring of poly) push(ring)
      }
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
      this.group.add(
        new LineSegments(
          geo,
          new LineBasicMaterial({ color: new Color('#6b6353'), transparent: true, opacity: 0.85 }),
        ),
      )
    } catch {
      // the globe stands without a coastline; the asset ships with the build
    }
  }

  /** the quiet world: 34k candidates as dim points, brightness by weight */
  private async loadCandidates(): Promise<void> {
    try {
      const r = await fetch('/world/coarse/global.json')
      const j = (await r.json()) as { candidates: Candidate[] }
      const positions = new Float32Array(j.candidates.length * 3)
      const colors = new Float32Array(j.candidates.length * 3)
      const v = new Vector3()
      j.candidates.forEach((c, i) => {
        latLonTo(this.radius + 1.2, c.lat, c.lon, v)
        positions[i * 3] = v.x
        positions[i * 3 + 1] = v.y
        positions[i * 3 + 2] = v.z
        const w = Math.min(1, Math.log10(Math.max(10, c.population)) / 7) * (c.valueIndex ?? 0.8)
        const b = 0.1 + 0.62 * Math.pow(w, 1.4)
        colors[i * 3] = b * 1.05
        colors[i * 3 + 1] = b * 0.92
        colors[i * 3 + 2] = b * 0.72
      })
      // §49 r2: hierarchy, not noise — the top of the population order is
      // always lit; the long tail fades in as the camera approaches
      const order = j.candidates
        .map((c, i) => ({ i, p: c.population }))
        .sort((a, b) => b.p - a.p)
      const TOP = 3200
      const build = (idx: Array<{ i: number }>) => {
        const pos = new Float32Array(idx.length * 3)
        const col = new Float32Array(idx.length * 3)
        idx.forEach(({ i }, k) => {
          pos[k * 3] = positions[i * 3]
          pos[k * 3 + 1] = positions[i * 3 + 1]
          pos[k * 3 + 2] = positions[i * 3 + 2]
          col[k * 3] = colors[i * 3]
          col[k * 3 + 1] = colors[i * 3 + 1]
          col[k * 3 + 2] = colors[i * 3 + 2]
        })
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(pos, 3))
        g.setAttribute('color', new BufferAttribute(col, 3))
        return g
      }
      const major = new Points(
        build(order.slice(0, TOP)),
        new PointsMaterial({ size: 2.6, vertexColors: true, transparent: true, opacity: 0.95, sizeAttenuation: false }),
      )
      this.tailPoints = new Points(
        build(order.slice(TOP)),
        new PointsMaterial({ size: 1.8, vertexColors: true, transparent: true, opacity: 0, sizeAttenuation: false }),
      )
      this.candidateGroup.add(major)
      this.candidateGroup.add(this.tailPoints)
    } catch {
      // without the coarse layer the marks still say where civilization is
    }
  }
}

function markTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48
  const ctx = canvas.getContext('2d')!
  ctx.translate(24, 24)
  ctx.rotate(Math.PI / 4)
  ctx.fillStyle = '#e2a54f'
  ctx.fillRect(-9, -9, 18, 18)
  ctx.strokeStyle = 'rgba(226,165,79,0.4)'
  ctx.lineWidth = 3
  ctx.strokeRect(-15, -15, 30, 30)
  return new CanvasTexture(canvas)
}

function shortName(raw: string): string {
  const parts = raw.split(/\s+—\s+/)
  return parts.length === 2 ? `${parts[1]}, ${parts[0]}` : raw
}
