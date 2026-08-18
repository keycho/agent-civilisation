/**
 * §56.1: bloom on emissives only — "their glow is bloom".
 *
 * The trick that makes this emissive-only rather than "bright-pixel-only" is
 * WHERE the bright pass reads. The scene renders into a half-float buffer with
 * NoToneMapping (§15), so what lands there is the authored linear radiance,
 * unclamped: lit fabric sits under 1.0 by construction (the §48.2 grade's ACES
 * curve is what maps it to display), while §50.3's window emissives are driven
 * deliberately past it. So a threshold at ~1.0 in LINEAR pre-grade space is not
 * a luminance guess — it is the line between "surface returning light" and
 * "surface emitting it".
 *
 * The composite then adds the glow AFTER the grade, per §56.1. Because bloom
 * skips the tonemap it gets its own soft compression instead, so a very hot
 * window cannot punch a white hole through the plate: gentle is a constraint,
 * not a taste.
 *
 * The chrome layer is DOM (§35.1), so it is structurally exempt — no pass in
 * this file can reach it.
 */
import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'

/** the glow is a small radius (§56.1) — half res is plenty and costs a quarter */
const DOWNSCALE = 2

function fullscreenVertex(): string {
  return /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `
}

function makeTarget(width: number, height: number): WebGLRenderTarget {
  const t = new WebGLRenderTarget(width, height, {
    format: RGBAFormat,
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })
  return t
}

export class BloomPass {
  private bright: WebGLRenderTarget
  private ping: WebGLRenderTarget
  private pong: WebGLRenderTarget
  private brightMaterial: ShaderMaterial
  private blurMaterial: ShaderMaterial
  private quad: Mesh
  private scene = new Scene()
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  /**
   * Linear radiance above which a pixel is treated as emitting. Sitting just
   * over 1.0 keeps sunlit fabric out of the glow at golden hour: nothing the
   * key light returns off a diffuse surface gets there, by authored intent.
   */
  threshold = 1.15
  /** soft knee, so a window crossing the line fades in rather than pops */
  knee = 0.55
  /** how much glow reaches the plate; the caller scales this per mode/hour */
  strength = 0

  constructor(width: number, height: number) {
    const w = Math.max(1, Math.floor(width / DOWNSCALE))
    const h = Math.max(1, Math.floor(height / DOWNSCALE))
    this.bright = makeTarget(w, h)
    this.ping = makeTarget(w, h)
    this.pong = makeTarget(w, h)

    this.brightMaterial = new ShaderMaterial({
      uniforms: {
        tColor: { value: null as Texture | null },
        uThreshold: { value: this.threshold },
        uKnee: { value: this.knee },
      },
      vertexShader: fullscreenVertex(),
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform float uThreshold, uKnee;

        void main() {
          vec3 c = texture2D(tColor, vUv).rgb;
          float lum = dot(c, vec3(0.299, 0.587, 0.114));
          // soft-knee bright pass: zero below the line, easing in across the
          // knee, so a window brightening with condition glows progressively
          float w = smoothstep(uThreshold, uThreshold + uKnee, lum);
          // keep the emitter's own colour, not a white core — §50.3's warmth
          // is the whole point of the glow
          gl_FragColor = vec4(c * w, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    this.blurMaterial = new ShaderMaterial({
      uniforms: {
        tColor: { value: null as Texture | null },
        uDirection: { value: new Vector2(1, 0) },
        uTexel: { value: new Vector2(1 / w, 1 / h) },
      },
      vertexShader: fullscreenVertex(),
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform vec2 uDirection, uTexel;

        // 9-tap gaussian, separable. Small radius by construction (§56.1):
        // the glow should sit around a light, not wash the block it is on.
        void main() {
          vec2 step = uDirection * uTexel;
          vec4 sum = texture2D(tColor, vUv) * 0.2270270270;
          sum += texture2D(tColor, vUv + step * 1.3846153846) * 0.3162162162;
          sum += texture2D(tColor, vUv - step * 1.3846153846) * 0.3162162162;
          sum += texture2D(tColor, vUv + step * 3.2307692308) * 0.0702702703;
          sum += texture2D(tColor, vUv - step * 3.2307692308) * 0.0702702703;
          gl_FragColor = sum;
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.brightMaterial)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  /** the blurred emissive-only buffer, for the composite to add post-grade */
  get texture(): Texture {
    return this.ping.texture
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / DOWNSCALE))
    const h = Math.max(1, Math.floor(height / DOWNSCALE))
    this.bright.setSize(w, h)
    this.ping.setSize(w, h)
    this.pong.setSize(w, h)
    this.blurMaterial.uniforms.uTexel.value.set(1 / w, 1 / h)
  }

  private draw(renderer: WebGLRenderer, material: ShaderMaterial, to: WebGLRenderTarget): void {
    this.quad.material = material
    renderer.setRenderTarget(to)
    renderer.clear()
    renderer.render(this.scene, this.camera)
  }

  /**
   * Build the glow from a linear scene buffer. Two blur iterations: the first
   * gives the tight core, the second widens the tail enough that the falloff
   * reads as light rather than as a disc.
   */
  generate(renderer: WebGLRenderer, source: Texture): void {
    this.brightMaterial.uniforms.tColor.value = source
    this.brightMaterial.uniforms.uThreshold.value = this.threshold
    this.brightMaterial.uniforms.uKnee.value = this.knee
    this.draw(renderer, this.brightMaterial, this.bright)

    let from: WebGLRenderTarget = this.bright
    for (let i = 0; i < 2; i++) {
      this.blurMaterial.uniforms.tColor.value = from.texture
      this.blurMaterial.uniforms.uDirection.value.set(1, 0)
      this.draw(renderer, this.blurMaterial, this.pong)

      this.blurMaterial.uniforms.tColor.value = this.pong.texture
      this.blurMaterial.uniforms.uDirection.value.set(0, 1)
      this.draw(renderer, this.blurMaterial, this.ping)
      from = this.ping
    }
    renderer.setRenderTarget(null)
  }

  dispose(): void {
    this.bright.dispose()
    this.ping.dispose()
    this.pong.dispose()
    this.brightMaterial.dispose()
    this.blurMaterial.dispose()
    this.quad.geometry.dispose()
  }
}
