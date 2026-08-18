/**
 * §59.1: agents become pixel people.
 *
 * §47.3a put them in the chrome register — billboarded diamonds, instrumentation
 * hovering over the miniature. §15 had asked for "small stylized entities
 * readable from the city camera... inhabitants of a miniature world", and a
 * diamond is not an inhabitant. A pixel sprite is.
 *
 * The register mix is deliberate: smooth stylized architecture, pixel
 * inhabitants. It reads as intent rather than accident, and it is what finally
 * makes "watch an agent work" land — a small figure standing at a site swinging
 * something is legible in a way a coloured diamond never was.
 *
 * One atlas, drawn procedurally at load (no assets to ship), sampled NEAREST so
 * it stays pixels rather than becoming mush. One InstancedMesh, one draw call,
 * whatever the population.
 *
 * The accent colour is a palette swap: the atlas paints one element — hat band,
 * scarf — in pure magenta, and the shader substitutes each agent's own colour
 * for it. That is how one texture carries a stable per-agent identity without a
 * texture per agent.
 */
import {
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NearestFilter,
  PlaneGeometry,
  ShaderMaterial,
} from 'three'
import type { CityMaterial } from '@civ/core'

/** the pixel grid a figure is drawn on */
const CELL = 16
/** columns: idle, walk a, walk b, work a, work b, work c */
const FRAMES = 6
/** rows, in this order */
const OCCUPATIONS = ['developer', 'renovator', 'consolidator', 'converter', 'landlord'] as const
export type Occupation = (typeof OCCUPATIONS)[number]

/** the one colour the shader replaces with the agent's own */
const ACCENT_KEY = '#ff00ff'

export interface PixelAgent {
  id: string
  x: number
  y: number
  activity: string
  strategy: string
  colour: string
  followed: boolean
}

type Ctx = CanvasRenderingContext2D

/** a pixel, in cell coordinates */
function px(c: Ctx, x: number, y: number, w = 1, h = 1): void {
  c.fillRect(x, y, w, h)
}

/**
 * Draw one figure. `lean` shifts the legs for a walk frame, `arm` raises the
 * working arm. Everything is deliberately blocky: at 16 px a silhouette is all
 * that survives, so the silhouettes are what differ between occupations.
 */
function figure(
  c: Ctx,
  occ: Occupation,
  opts: { lean: number; arm: number; skin: string; cloth: string; dark: string },
): void {
  const { lean, arm, skin, cloth, dark } = opts

  // legs
  c.fillStyle = dark
  px(c, 6 - lean, 12, 2, 4)
  px(c, 8 + lean, 12, 2, 4)
  // body
  c.fillStyle = cloth
  px(c, 5, 7, 6, 5)
  // head
  c.fillStyle = skin
  px(c, 6, 3, 4, 4)

  // arms — the working arm rises, which is the whole animation at this size
  c.fillStyle = cloth
  px(c, 4, 8 - arm, 1, 3)
  px(c, 11, 8 - arm, 1, 3)

  // the accent element and the occupation's tell, one silhouette each
  c.fillStyle = ACCENT_KEY
  switch (occ) {
    case 'developer':
      // hard hat, brim proud of the head
      px(c, 5, 2, 6, 1)
      px(c, 6, 1, 4, 1)
      break
    case 'renovator':
      // headband, and a tool held out
      px(c, 6, 3, 4, 1)
      px(c, 12, 7 - arm, 1, 4)
      break
    case 'consolidator':
      // flat cap and a ledger under the arm
      px(c, 5, 2, 6, 1)
      px(c, 3, 9, 2, 3)
      break
    case 'converter':
      // scarf, and a raised marker
      px(c, 5, 7, 6, 1)
      px(c, 12, 5 - arm, 1, 3)
      break
    case 'landlord':
      // tall hat: the one silhouette that is unmistakable at 16 px
      px(c, 6, 0, 4, 3)
      px(c, 5, 3, 6, 1)
      break
  }

  // a dark base line so the figure sits on the ground rather than floating
  c.fillStyle = dark
  px(c, 5, 15, 6, 1)
}

function buildAtlas(city: CityMaterial): { texture: CanvasTexture; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas')
  canvas.width = CELL * FRAMES
  canvas.height = CELL * OCCUPATIONS.length
  const c = canvas.getContext('2d')!
  c.imageSmoothingEnabled = false

  // §59.1: the palette comes from the chunk's own material family, so the
  // inhabitants sit inside each city's colour identity rather than beside it
  const wall = new Color(city.wall[0], city.wall[1], city.wall[2])
  const skin = new Color('#c8a081').multiply(wall).getStyle()
  const cloth = new Color('#5d6b7a').multiply(wall).getStyle()
  const dark = new Color('#2b2f36').multiply(wall).getStyle()

  OCCUPATIONS.forEach((occ, row) => {
    for (let f = 0; f < FRAMES; f++) {
      c.save()
      c.translate(f * CELL, row * CELL)
      // idle 0 | walk 1,2 | work 3,4,5
      const lean = f === 1 ? 1 : f === 2 ? -1 : 0
      const arm = f === 3 ? 0 : f === 4 ? 2 : f === 5 ? 3 : 0
      figure(c, occ, { lean, arm, skin, cloth, dark })
      c.restore()
    }
  })

  const tex = new CanvasTexture(canvas)
  // pixels stay pixels: this is the whole register
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.generateMipmaps = false
  return { texture: tex, canvas }
}

function occupationRow(strategy: string): number {
  const i = OCCUPATIONS.indexOf(strategy as Occupation)
  return i >= 0 ? i : OCCUPATIONS.indexOf('consolidator')
}

const MAX_AGENTS = 256

export class PixelAgents {
  readonly group = new Group()
  private mesh: InstancedMesh
  private material: ShaderMaterial
  private frames: InstancedBufferAttribute
  private accents: InstancedBufferAttribute
  private dims: InstancedBufferAttribute
  private matrix = new Matrix4()
  private colour = new Color()
  /** the atlas as drawn, for inspection */
  readonly atlasCanvas: HTMLCanvasElement
  /** where each agent ended up, for the chrome's name labels and hit-testing */
  readonly marks: Array<{ id: string; x: number; y: number; z: number; followed: boolean }> = []

  constructor(city: CityMaterial) {
    const geo = new PlaneGeometry(1, 1)
    // pivot at the feet, so a figure stands on the ground rather than in it
    geo.translate(0, 0.5, 0)
    const n = MAX_AGENTS
    this.frames = new InstancedBufferAttribute(new Float32Array(n * 2), 2)
    this.accents = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.dims = new InstancedBufferAttribute(new Float32Array(n), 1)
    geo.setAttribute('aFrame', this.frames)
    geo.setAttribute('aAccent', this.accents)
    geo.setAttribute('aDim', this.dims)

    const atlas = buildAtlas(city)
    this.atlasCanvas = atlas.canvas
    this.material = new ShaderMaterial({
      uniforms: {
        tAtlas: { value: atlas.texture },
        uCell: { value: [1 / FRAMES, 1 / OCCUPATIONS.length] },
        /**
         * World metres a figure stands, before the screen-size floor. A PERSON,
         * because at street framing this is what sets the figure against the
         * buildings — the first pass used 9 m so that the figure would still be
         * visible at city zoom, which made a three-storey pedestrian the moment
         * the camera came down. The 16 px floor is what keeps them visible far
         * away; the world size only has to be true up close.
         */
        uSizeM: { value: 2.2 },
        /**
         * §59.1: "size-clamped so they never fall below roughly 16 px at any
         * zoom". This is that clamp, expressed exactly: a quad of world size S
         * at view depth z covers S/(2*z*tan(fov/2)) of the frame, so the size
         * that guarantees 16 px is 16 * 2*tan(fov/2)/heightPx * z. The lens
         * opens as the camera descends (§16.3), so the caller feeds the term
         * per frame rather than baking it.
         */
        uPxTerm: { value: 0.0006 },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aFrame;
        attribute vec3 aAccent;
        attribute float aDim;
        varying vec2 vUv;
        varying vec3 vAccent;
        varying float vDim;
        uniform vec2 uCell;
        uniform float uSizeM, uPxTerm;
        void main() {
          vUv = (uv + aFrame) * uCell;
          vAccent = aAccent;
          vDim = aDim;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float size = max(uSizeM, -mv.z * uPxTerm * 16.0);
          // billboard, feet on the anchor: the quad rises from the position
          mv.xy += vec2(position.x * size, position.y * size);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vAccent;
        varying float vDim;
        uniform sampler2D tAtlas;
        void main() {
          vec4 t = texture2D(tAtlas, vUv);
          if (t.a < 0.5) discard;
          // the palette swap: magenta is not a colour, it is a slot
          float isAccent = step(0.6, t.r) * step(0.6, t.b) * (1.0 - step(0.35, t.g));
          vec3 rgb = mix(t.rgb, vAccent, isAccent);
          gl_FragColor = vec4(rgb * vDim, 1.0);
        }
      `,
      transparent: true,
      depthWrite: true,
      side: DoubleSide,
    })

    this.mesh = new InstancedMesh(geo, this.material, n)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.group.add(this.mesh)
  }

  /**
   * §59.1: state determines animation — working is a three-frame loop at the
   * site, travelling a two-frame walk, idle is still and dimmed.
   */
  setAgents(agents: Iterable<PixelAgent>, groundY: number, time: number, pxTerm: number): void {
    this.material.uniforms.uPxTerm.value = pxTerm
    this.marks.length = 0
    let i = 0
    for (const a of agents) {
      if (i >= MAX_AGENTS) break
      const working = a.activity === 'building' || a.activity === 'demolishing'
      const travelling = a.activity === 'acquiring'
      const phase = Math.floor(time * (working ? 6 : 3) + i * 0.7)
      const frame = working ? 3 + (phase % 3) : travelling ? 1 + (phase % 2) : 0
      this.frames.setXY(i, frame, occupationRow(a.strategy))
      this.colour.set(a.colour)
      this.accents.setXYZ(i, this.colour.r, this.colour.g, this.colour.b)
      // idle is still AND dim; a followed agent is never dim
      const lit = a.id === this.highlight ? 1.7 : working || travelling || a.followed ? 1 : 0.55
      this.dims.setX(i, lit)
      this.matrix.makeTranslation(a.x, groundY + 0.4, -a.y)
      this.mesh.setMatrixAt(i, this.matrix)
      this.marks.push({ id: a.id, x: a.x, y: groundY + 0.4, z: -a.y, followed: a.followed })
      i++
    }
    this.mesh.count = i
    this.mesh.instanceMatrix.needsUpdate = true
    this.frames.needsUpdate = true
    this.accents.needsUpdate = true
    this.dims.needsUpdate = true
  }

  /**
   * §59.2: one agent's sprite as a data URL, for the roster's thumbnail. Drawn
   * from the same atlas the world uses with the same palette swap, so the row
   * and the figure standing in the street are visibly the same person — which
   * is the whole reason the roster carries a picture at all.
   */
  thumbnail(strategy: string, accent: string, scale = 3): string {
    const key = `${strategy}|${accent}|${scale}`
    const hit = this.thumbs.get(key)
    if (hit) return hit
    const c = document.createElement('canvas')
    c.width = CELL * scale
    c.height = CELL * scale
    const g = c.getContext('2d')!
    g.imageSmoothingEnabled = false
    g.drawImage(
      this.atlasCanvas,
      0,
      occupationRow(strategy) * CELL,
      CELL,
      CELL,
      0,
      0,
      c.width,
      c.height,
    )
    // the same magenta-is-a-slot rule the shader applies
    const img = g.getImageData(0, 0, c.width, c.height)
    const a = new Color(accent)
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] > 150 && img.data[i + 2] > 150 && img.data[i + 1] < 90) {
        img.data[i] = Math.round(a.r * 255)
        img.data[i + 1] = Math.round(a.g * 255)
        img.data[i + 2] = Math.round(a.b * 255)
      }
    }
    g.putImageData(img, 0, 0)
    const url = c.toDataURL('image/png')
    this.thumbs.set(key, url)
    return url
  }

  /** §59.2: hovering a roster row lights that agent up in the world */
  highlight: string | null = null

  private thumbs = new Map<string, string>()

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.group.remove(this.mesh)
  }
}
