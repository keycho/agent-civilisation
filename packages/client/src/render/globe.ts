/**
 * §49: the globe — the top of the scale chain, floating in §47.1's void and
 * wearing §48.2's grade like everything else. A stylized sphere from data
 * that already exists: 34k coarse candidates as dim points, active chunks as
 * amber marks with pane-grammar labels, coastline from one committed
 * Natural Earth 110m asset drawn in the dim register, a faint graticule.
 * No basemap, no terrain, nothing traversable — §15 at planetary scale.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Line,
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

function labelTexture(text: string): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 40
  const ctx = canvas.getContext('2d')!
  ctx.font = '20px ui-monospace, monospace'
  const label = text.toLowerCase()
  const w = Math.min(240, ctx.measureText(label).width + 14)
  ctx.fillStyle = 'rgba(13,12,10,0.78)'
  ctx.fillRect(0, 0, w, 40)
  ctx.fillStyle = '#e2a54f'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 7, 21, 226)
  return new CanvasTexture(canvas)
}

export interface GlobeMarker {
  id: string
  position: Vector3
  sprite: Sprite
}

export class GlobeView {
  readonly group = new Group()
  readonly radius: number
  readonly markers: GlobeMarker[] = []

  constructor(radius: number, chunkIds: string[], names: Map<string, string>) {
    this.radius = radius
    this.group.visible = false

    const sphere = new Mesh(
      new SphereGeometry(radius, 48, 32),
      new MeshLambertMaterial({ color: new Color('#16140f') }),
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
      mark.scale.set(radius * 0.045, radius * 0.045, 1)
      mark.position.copy(position)
      this.group.add(mark)
      const label = new Sprite(
        new SpriteMaterial({
          map: labelTexture(shortName(names.get(id) ?? id)),
          depthTest: false,
          transparent: true,
        }),
      )
      label.scale.set(radius * 0.34, radius * 0.053, 1)
      label.center.set(-0.06, 0.5)
      label.position.copy(position)
      this.group.add(label)
      this.markers.push({ id, position, sprite: mark })
    }

    void this.loadCoastline()
    void this.loadCandidates()
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
          new LineBasicMaterial({ color: new Color('#3d3931'), transparent: true, opacity: 0.55 }),
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
        const b = 0.16 + 0.3 * w
        colors[i * 3] = b * 1.05
        colors[i * 3 + 1] = b * 0.92
        colors[i * 3 + 2] = b * 0.72
      })
      const geo = new BufferGeometry()
      geo.setAttribute('position', new BufferAttribute(positions, 3))
      geo.setAttribute('color', new BufferAttribute(colors, 3))
      this.group.add(
        new Points(
          geo,
          new PointsMaterial({ size: 2.2, vertexColors: true, transparent: true, opacity: 0.85, sizeAttenuation: false }),
        ),
      )
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
