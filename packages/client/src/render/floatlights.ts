/**
 * §47.3a + §49: one moving-light system, two worlds.
 *
 * In the city: a working agent carries a billboarded occupation-colour glyph
 * floating above its site at city zoom, gaining its mono name closer in;
 * idle agents stay ground-level (the §16.6 cones); a followed agent is
 * always marked; a travelling agent's glyph glides with it. On the globe the
 * same grammar is the migration arc — a light travelling origin →
 * destination and fading.
 *
 * The lights live in the CHROME register: instrumentation floating over the
 * miniature, never objects in it — billboards, no depth test, chrome mono
 * for names, §36.2 occupation colours for identity. Nothing here casts a
 * shadow or occludes the world.
 */
import { agentColourHex } from './agents.ts'
import {
  CanvasTexture,
  Group,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'

/** LOD: below this camera distance the glyph gains its mono name */
const NAME_DISTANCE = 760

const textureCache = new Map<string, CanvasTexture>()

function glyphTexture(colour: string, name?: string): CanvasTexture {
  const key = `${colour}|${name ?? ''}`
  const hit = textureCache.get(key)
  if (hit) return hit
  const w = name ? 256 : 64
  const h = 64
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  // the glyph: a diamond of the occupation colour on a breath of dark
  ctx.translate(32, 32)
  ctx.rotate(Math.PI / 4)
  ctx.fillStyle = 'rgba(13,12,10,0.72)'
  ctx.fillRect(-13, -13, 26, 26)
  ctx.fillStyle = colour
  ctx.fillRect(-9, -9, 18, 18)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (name) {
    ctx.font = '20px ui-monospace, monospace'
    ctx.textBaseline = 'middle'
    const label = name.toLowerCase()
    const tw = Math.min(180, ctx.measureText(label).width + 12)
    ctx.fillStyle = 'rgba(13,12,10,0.78)'
    ctx.fillRect(56, 16, tw, 32)
    ctx.fillStyle = '#e8ddc8'
    ctx.fillText(label, 62, 33, 172)
  }
  const tex = new CanvasTexture(canvas)
  textureCache.set(key, tex)
  return tex
}

export interface FloatAgent {
  id: string
  x: number
  y: number
  activity: string
  strategy: string
  colourIndex: number
  name: string
  followed: boolean
}

/** where a glyph currently floats — §51.3 hit-tests these for the mini-card */
export interface FloatMark {
  id: string
  position: Vector3
}

interface Arc {
  from: Vector3
  to: Vector3
  t: number
  duration: number
  sprite: Sprite
  /** arc height as a fraction of the chord */
  lift: number
  liftAxis: 'radial' | 'up'
}

export class FloatLights {
  readonly group = new Group()
  /** this frame's glyph positions, for the §51.3 hover hit-test */
  readonly marks: FloatMark[] = []
  private pool: Sprite[] = []
  private used = 0
  private arcs: Arc[] = []

  constructor() {
    this.group.renderOrder = 10
  }

  private take(): Sprite {
    let s = this.pool[this.used]
    if (!s) {
      s = new Sprite(new SpriteMaterial({ depthTest: false, transparent: true }))
      this.pool[this.used] = s
      this.group.add(s)
    }
    this.used++
    s.visible = true
    return s
  }

  /**
   * §47.3a: the city pass. Working and travelling agents float a glyph;
   * idle floats nothing (their ground cone stays); followed always shows,
   * with its name at any distance.
   */
  setAgents(agents: Iterable<FloatAgent>, groundY: number, cameraDistance: number): void {
    this.used = this.arcs.length // arc sprites occupy the pool head
    this.marks.length = 0
    const near = cameraDistance < NAME_DISTANCE
    for (const a of agents) {
      const working = a.activity === 'building' || a.activity === 'demolishing'
      const travelling = a.activity === 'acquiring'
      if (!working && !travelling && !a.followed) continue
      const s = this.take()
      const withName = near || a.followed
      // §51.3: the identity colour, the same value the ground marker, tether,
      // crew chip and log line carry
      const colour = agentColourHex(a.strategy, a.colourIndex)
      const mat = s.material as SpriteMaterial
      mat.map = glyphTexture(colour, withName ? a.name.split(' ')[0] : undefined)
      mat.opacity = working || a.followed ? 0.95 : 0.7
      mat.needsUpdate = true
      const scale = withName ? 26 : 10
      s.scale.set(withName ? scale * 4 : scale, scale, 1)
      s.center.set(withName ? 0.125 : 0.5, 0.5)
      s.position.set(a.x, groundY + (working ? 16 : 11), -a.y)
      this.marks.push({ id: a.id, position: s.position })
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false
  }

  /**
   * §49: the migration arc — the same light, travelling. Positions are in
   * whatever space the group lives in (globe or city render space).
   */
  launchArc(
    from: Vector3,
    to: Vector3,
    colour = '#e2a54f',
    duration = 6,
    /**
     * §57.3: which way is "up" for the arc's lift. On the globe it was radial
     * (away from the planet's centre); on the flat map it is simply up, and
     * the radial rule would have bent every migration sideways across the
     * plate instead of over it.
     */
    liftAxis: 'radial' | 'up' = 'radial',
  ): void {
    const sprite = new Sprite(
      new SpriteMaterial({ map: glyphTexture(colour), depthTest: false, transparent: true }),
    )
    sprite.scale.set(9, 9, 1)
    this.group.add(sprite)
    this.arcs.push({ from: from.clone(), to: to.clone(), t: 0, duration, sprite, lift: 0.22, liftAxis })
  }

  /** advance travelling lights; the caller owns per-frame agent updates */
  update(dt: number): void {
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i]
      a.t += dt / a.duration
      if (a.t >= 1) {
        this.group.remove(a.sprite)
        ;(a.sprite.material as SpriteMaterial).dispose()
        this.arcs.splice(i, 1)
        continue
      }
      const t = a.t
      const p = a.sprite.position
      p.copy(a.from).lerp(a.to, t)
      // a lifted path: rise along the normal of the chord midpoint (globe
      // space: away from origin; city space: up)
      const liftDir =
        a.liftAxis === 'up' || p.lengthSq() <= 1 ? new Vector3(0, 1, 0) : p.clone().normalize()
      p.addScaledVector(liftDir, Math.sin(t * Math.PI) * a.from.distanceTo(a.to) * a.lift)
      const mat = a.sprite.material as SpriteMaterial
      mat.opacity = t > 0.8 ? (1 - t) / 0.2 : 1
    }
  }

  get activeArcs(): number {
    return this.arcs.length
  }
}
