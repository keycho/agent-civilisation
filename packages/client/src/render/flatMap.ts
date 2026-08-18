/**
 * §57.3: the flat map, which replaces the globe.
 *
 * Three rounds of repair and the sphere still showed labels detached from
 * marks over a mostly-black field, because the failures were structural rather
 * than cosmetic: half the world is always facing away, marks near the limb
 * project into a few pixels, labels have to be culled against a horizon test
 * that never quite agrees with the marks, and the projection blurs exactly
 * where the eight cities happen to sit. §49's own fallback was written for
 * this moment.
 *
 * Equirectangular, no rotation, no limb, no hidden hemisphere. Every city is
 * visible in one frame, always — which is the whole job of a selector. It
 * inherits the globe's marks, cards, arcs and dive behaviour unchanged; only
 * the projection differs, so this class deliberately presents the same surface
 * the globe did (group, radius, markers, updateLOD, setCandidates).
 *
 * The land is a filled mass against a colder ocean with the coastline as the
 * value edge, exactly as §49 r3 established — that part was right, it was the
 * sphere under it that was not.
 */
import earcut from 'earcut'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Vector3,
} from 'three'

/** where each chunk sits on the earth (§27.2's anchors, unchanged) */
export const CHUNK_ANCHORS: Record<string, [lat: number, lon: number]> = {
  'schiedam-havens': [51.9186, 4.3889],
  'vlaardingen-westwijk': [51.9042, 4.3333],
  'maassluis-haven': [51.9231, 4.2494],
  'maasland-dorp': [51.9366, 4.2758],
  'london-deptford': [51.4795, -0.0265],
  'paris-ourcq': [48.8875, 2.3806],
  'brooklyn-redhook': [40.6752, -74.0111],
  'tokyo-kyojima': [35.7156, 139.8207],
}

/**
 * The plate is 2:1, the projection's own aspect. `radius` keeps the name the
 * globe used because every camera distance in main.ts is expressed in it.
 */
export const MAP_ASPECT = 2

/** §57.3: the map is always framed whole; these bound how far a viewer may go */
export const MAP_ZOOM = { minSpan: 0.35, maxSpan: 1.25 } as const

/** the framing that shows every city at once — the map's home */
export const MAP_HOME_SPAN = 1.06

/**
 * §57.3: a flat map is looked AT, not orbited. Diving still wants an approach
 * angle, so this gives one straight above the mark with a breath of tilt so
 * the dive has somewhere to travel from.
 */
export function orbitFor(_lat: number, _lon: number): { azimuth: number; polar: number } {
  return { azimuth: 0, polar: 0.16 }
}

export interface FlatMapMarker {
  id: string
  position: Vector3
  sprite: Sprite
  /** labels render in the crisp chrome layer, so the name ships raw */
  name: string
}

export class FlatMapView {
  readonly group = new Group()
  readonly radius: number
  readonly markers: FlatMapMarker[] = []
  private tailPoints: Points | null = null
  private candidatesLoaded = false
  private candidateGroup = new Group()

  /** half-width and half-height of the plate, in render units */
  get halfWidth(): number {
    return this.radius
  }
  get halfHeight(): number {
    return this.radius / MAP_ASPECT
  }

  /**
   * Equirectangular, into the same render space the city uses (x east, z
   * NEGATED north, y up). No subdivision: a plane's chords are the plane, and
   * no winding flip either — the sphere needed DoubleSide because latLonTo
   * negated z and inverted handedness, which does not arise here. It is kept
   * on the fill anyway so a top-down camera cannot cull the world by sign.
   */
  project(lat: number, lon: number, out = new Vector3()): Vector3 {
    return out.set((lon / 180) * this.halfWidth, 0, (-lat / 90) * this.halfHeight)
  }

  constructor(radius: number, chunkIds: string[], names: Map<string, string>) {
    this.radius = radius
    this.group.visible = false

    // -- the ocean: one quad, unlit, flat, legible at every permitted zoom --
    const ocean = new Mesh(
      new PlaneGeometry(this.halfWidth * 2, this.halfHeight * 2),
      new MeshBasicMaterial({ color: new Color('#18222c') }),
    )
    ocean.rotation.x = -Math.PI / 2
    ocean.position.y = -0.6
    ocean.renderOrder = -2
    this.group.add(ocean)

    // faint graticule every 30 degrees, so the plate reads as the earth
    const grat: number[] = []
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = this.project(lat, -180)
      const b = this.project(lat, 180)
      grat.push(a.x, -0.2, a.z, b.x, -0.2, b.z)
    }
    for (let lon = -180; lon <= 180; lon += 30) {
      const a = this.project(-90, lon)
      const b = this.project(90, lon)
      grat.push(a.x, -0.2, a.z, b.x, -0.2, b.z)
    }
    const gratGeo = new BufferGeometry()
    gratGeo.setAttribute('position', new BufferAttribute(new Float32Array(grat), 3))
    this.group.add(
      new LineSegments(
        gratGeo,
        new LineBasicMaterial({ color: new Color('#2b3540'), transparent: true, opacity: 0.5 }),
      ),
    )

    void this.loadCoastline()

    // -- the eight marks --------------------------------------------------
    const tex = markTexture()
    for (const id of chunkIds) {
      const at = CHUNK_ANCHORS[id]
      if (!at) continue
      const position = this.project(at[0], at[1])
      position.y = 0.6
      const sprite = new Sprite(
        new SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
      )
      sprite.position.copy(position)
      sprite.scale.setScalar(radius * 0.035)
      sprite.renderOrder = 12
      this.group.add(sprite)
      this.markers.push({ id, position, sprite, name: shortName(names.get(id) ?? id) })
    }
    this.group.add(this.candidateGroup)
  }

  /** the tail of coarse candidates fades in on approach, as on the globe */
  updateLOD(cameraDistance: number): void {
    if (!this.tailPoints) return
    const t = Math.max(0, Math.min(1, (this.radius * 2.4 - cameraDistance) / (this.radius * 1.2)))
    ;(this.tailPoints.material as PointsMaterial).opacity = 0.8 * t
  }

  setCandidates(on: boolean): void {
    this.candidateGroup.visible = on
    if (on && !this.candidatesLoaded) {
      this.candidatesLoaded = true
      void this.loadCandidates()
    }
  }

  get candidatesOn(): boolean {
    return this.candidateGroup.visible
  }

  private async loadCoastline(): Promise<void> {
    try {
      const r = await fetch('/world/coarse/land-110m.json')
      const gj = (await r.json()) as {
        features: Array<{ geometry: { type: string; coordinates: number[][][] | number[][][][] } }>
      }
      const polygons: number[][][][] = []
      for (const f of gj.features) {
        if (f.geometry.type === 'Polygon') polygons.push(f.geometry.coordinates as number[][][])
        else if (f.geometry.type === 'MultiPolygon')
          for (const poly of f.geometry.coordinates as number[][][][]) polygons.push(poly)
      }

      const fill: number[] = []
      const v = new Vector3()
      for (const poly of polygons) {
        // a ring spanning almost the whole width is an antimeridian artifact
        // of flat triangulation, not a landmass; it would paint a band
        const lons = poly[0].map((p) => p[0])
        if (Math.max(...lons) - Math.min(...lons) > 340) continue
        const flat: number[] = []
        const holes: number[] = []
        poly.forEach((ring, i) => {
          if (i > 0) holes.push(flat.length / 2)
          for (const [lon, lat] of ring) flat.push(lon, lat)
        })
        const idx = earcut(flat, holes)
        for (const k of idx) {
          this.project(flat[k * 2 + 1], flat[k * 2], v)
          fill.push(v.x, 0, v.z)
        }
      }
      const fillGeo = new BufferGeometry()
      fillGeo.setAttribute('position', new BufferAttribute(new Float32Array(fill), 3))
      const land = new Mesh(
        fillGeo,
        new MeshBasicMaterial({ color: new Color('#5d5442'), side: DoubleSide }),
      )
      land.renderOrder = -1
      this.group.add(land)

      // the coastline as the value edge, on top of the fill
      const positions: number[] = []
      const a = new Vector3()
      const b = new Vector3()
      for (const poly of polygons) {
        for (const ring of poly) {
          for (let i = 0; i < ring.length - 1; i++) {
            // a segment that jumps the antimeridian would draw straight across
            if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) continue
            this.project(ring[i][1], ring[i][0], a)
            this.project(ring[i + 1][1], ring[i + 1][0], b)
            positions.push(a.x, 0.25, a.z, b.x, 0.25, b.z)
          }
        }
      }
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
      this.group.add(
        new LineSegments(
          geo,
          new LineBasicMaterial({ color: new Color('#9c9078'), transparent: true, opacity: 0.95 }),
        ),
      )
    } catch {
      /* the map still selects without its coastline */
    }
  }

  private async loadCandidates(): Promise<void> {
    try {
      const r = await fetch('/world/coarse/global.json')
      const gj = (await r.json()) as {
        settlements?: Array<{ lat: number; lon: number; landValue?: number }>
      }
      const all = gj.settlements ?? []
      if (!all.length) return
      const ranked = [...all].sort((x, y) => (y.landValue ?? 0) - (x.landValue ?? 0))
      const head = ranked.slice(0, 3200)
      const tail = ranked.slice(3200)
      const v = new Vector3()
      const build = (list: typeof head, size: number, opacity: number): Points => {
        const pos: number[] = []
        for (const s of list) {
          this.project(s.lat, s.lon, v)
          pos.push(v.x, 0.4, v.z)
        }
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
        return new Points(
          g,
          new PointsMaterial({
            color: new Color('#b9ad91'),
            size,
            sizeAttenuation: false,
            transparent: true,
            opacity,
          }),
        )
      }
      this.candidateGroup.add(build(head, 2, 0.85))
      this.tailPoints = build(tail, 1, 0.35)
      this.candidateGroup.add(this.tailPoints)
    } catch {
      /* candidates are an optional layer */
    }
  }
}

function markTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')!
  g.translate(32, 32)
  g.rotate(Math.PI / 4)
  g.fillStyle = '#0d0c0a'
  g.fillRect(-14, -14, 28, 28)
  g.fillStyle = '#e2a54f'
  g.fillRect(-10, -10, 20, 20)
  return new CanvasTexture(c)
}

/**
 * `London — Deptford Riverside` is data; the map says `deptford`. A first word
 * of three letters or fewer is not a name on its own, though — Red Hook came
 * out as `red` — so those keep their second word.
 */
function shortName(raw: string): string {
  const parts = raw.split(/\s+—\s+/)
  const tail = (parts.length === 2 ? parts[1] : raw).toLowerCase()
  const words = tail.split(/\s+/)
  return words[0].length <= 3 && words[1] ? `${words[0]} ${words[1]}` : words[0]
}
