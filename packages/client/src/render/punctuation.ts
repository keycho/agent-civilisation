/**
 * §46.2: transient event effects, restrained. A brief dust puff when a
 * demolition completes, a small settle flash when a construction completes —
 * the §16.5 staging endpoints given one frame of punctuation each. Nothing
 * loops: an effect is born, plays out in under a second, and is gone.
 * World-palette tones, no chrome amber (§35.1).
 */
import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
} from 'three'

const MAX = 16
const DUST_LIFE_S = 0.9
const FLASH_LIFE_S = 0.65

interface Effect {
  x: number
  y: number
  age: number
}

function radialMaterial(colour: string, ring: boolean, additive: boolean): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
    uniforms: { uColor: { value: new Color(colour) } },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      varying float vFade;
      void main() {
        vLocal = position.xz;
        vFade = instanceMatrix[1][1]; // fade rides the unused y scale
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: ring
      ? /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vLocal;
      varying float vFade;
      void main() {
        float r = length(vLocal) * 2.0;
        float band = smoothstep(0.5, 0.72, r) * smoothstep(0.98, 0.78, r);
        gl_FragColor = vec4(uColor, band * 0.55 * vFade);
      }
    `
      : /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vLocal;
      varying float vFade;
      void main() {
        float r = length(vLocal) * 2.0;
        float a = smoothstep(1.0, 0.2, r) * 0.5 * vFade;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
}

export class PunctuationLayer {
  readonly dust: InstancedMesh
  readonly flash: InstancedMesh
  private dustFx: Effect[] = []
  private flashFx: Effect[] = []
  private dummy = new Object3D()
  private groundY = 0

  constructor() {
    const quad = new PlaneGeometry(1, 1)
    quad.rotateX(-Math.PI / 2)
    this.dust = new InstancedMesh(quad, radialMaterial('#8d8172', false, false), MAX)
    this.flash = new InstancedMesh(quad.clone(), radialMaterial('#e8d9b0', true, true), MAX)
    for (const m of [this.dust, this.flash]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage)
      m.frustumCulled = false
      m.count = 0
      m.renderOrder = 3
    }
  }

  setGround(y: number): void {
    this.groundY = y
  }

  demolitionDust(x: number, y: number): void {
    if (this.dustFx.length < MAX) this.dustFx.push({ x, y, age: 0 })
  }

  constructionFlash(x: number, y: number): void {
    if (this.flashFx.length < MAX) this.flashFx.push({ x, y, age: 0 })
  }

  update(dt: number): void {
    this.advance(this.dust, this.dustFx, DUST_LIFE_S, dt, (t) => 10 + t * 26)
    this.advance(this.flash, this.flashFx, FLASH_LIFE_S, dt, (t) => 8 + t * 34)
  }

  private advance(
    mesh: InstancedMesh,
    fx: Effect[],
    life: number,
    dt: number,
    radius: (t: number) => number,
  ): void {
    let i = 0
    for (let k = fx.length - 1; k >= 0; k--) {
      const e = fx[k]
      e.age += dt
      if (e.age >= life) {
        fx.splice(k, 1)
        continue
      }
      const t = e.age / life
      const fade = 1 - t
      const r = radius(t)
      this.dummy.position.set(e.x, this.groundY + 0.4 + t * 2.2, -e.y)
      this.dummy.scale.set(r, fade, r)
      this.dummy.rotation.set(0, 0, 0)
      this.dummy.updateMatrix()
      mesh.setMatrixAt(i, this.dummy.matrix)
      i++
    }
    mesh.count = i
    mesh.instanceMatrix.needsUpdate = true
  }
}
