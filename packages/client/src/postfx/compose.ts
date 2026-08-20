import {
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'
import { BloomPass } from './bloom.ts'

/**
 * The one post chain: an HDR scene buffer, §48.2's grade, §47.1's vignette and
 * §56.1's glow. Nothing else.
 *
 * §77.1 DELETED the tilt-shift depth of field this file was named for. §16.3
 * specced it as "the single cheapest signal for handcrafted diorama", and it
 * bought that read at a price that kept rising: melted foregrounds in the
 * maassluis frames, unreadable labels, and — once §76.2 let the camera come in
 * close — a blurred city at exactly the distance a viewer has chosen in order
 * to look at something. The night register (§63) and the pixel sprites (§59.1)
 * carry the handcrafted quality on their own, and they carry it without
 * spending legibility to do it.
 *
 * Deleted rather than turned down, so there is no dial left at zero for a
 * later block to find and reach for. The depth texture goes with it: nothing
 * else in the chain reads depth, and keeping the attachment allocated for a
 * pass that no longer exists is the same mistake in storage.
 */
/** first index whose value is >= t, in a sorted array */
function lowerBound(sorted: number[], t: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class ComposePass {
  private target: WebGLRenderTarget
  private quad: Mesh
  private scene = new Scene()
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private material: ShaderMaterial

  /** §50.2: how much of this city's authored hour is night */
  night = 0

  /** §56.1: the glow, built from this pass's own linear buffer */
  readonly bloom: BloomPass

  constructor(width: number, height: number) {
    this.target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      // §56.1: half-float, so the scene buffer keeps authored radiance above
      // 1.0 instead of clamping it, and the bright pass has an
      // emitter/reflector distinction to threshold on rather than a guess.
      type: HalfFloatType,
    })
    this.bloom = new BloomPass(width, height)

    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        uVignette: { value: 0.42 },
        uExposure: { value: 1.06 },
        uContrast: { value: 0.32 },
        uDesat: { value: 0.18 },
        uNight: { value: 0 },
        tBloom: { value: this.bloom.texture },
        uBloom: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform sampler2D tBloom;
        uniform float uVignette, uExposure, uContrast, uDesat, uNight, uBloom;

        /**
         * §48.2: filmic tonemap (ACES approximation), a gentle contrast
         * s-curve, and a slight desaturation of the mids with the warm band
         * protected, so terracotta and the fork's amber keep their voice while
         * the greys quiet down. The divergence lerp reads through: it is a
         * relative move in the same gamut, and the protection is exactly its
         * hue family.
         */
        vec3 grade(vec3 c) {
          vec3 x = c * uExposure;
          vec3 tm = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
          // §50.2: the s-curve was authored against a daylight plate, where it
          // buys snap. On an authored night hour it is pure crush — the fabric
          // is already living in the bottom of the curve, and a contrast pull
          // there does not deepen the mass, it deletes it. Contrast and the
          // §47.1 vignette both stand down as the hour goes dark.
          vec3 sc = mix(tm, tm * tm * (3.0 - 2.0 * tm), uContrast * (1.0 - 0.85 * uNight));
          float lum = dot(sc, vec3(0.299, 0.587, 0.114));
          float mids = smoothstep(0.10, 0.34, lum) * (1.0 - smoothstep(0.62, 0.92, lum));
          float warm = clamp((sc.r - max(sc.g, sc.b)) * 4.0, 0.0, 1.0);
          return mix(sc, vec3(lum), uDesat * mids * (1.0 - warm));
        }

        void main() {
          vec4 c = texture2D(tColor, vUv);
          // §47.1: subtle radial falloff toward the void, so the plate edge
          // reads as an object sitting in darkness rather than a viewport crop
          float r = length(vUv * 2.0 - 1.0);
          float v = 1.0 - uVignette * (1.0 - 0.65 * uNight) * smoothstep(0.62, 1.42, r);
          vec3 lit = grade(c.rgb);
          // §56.1: the glow joins AFTER the grade, carrying its emitter's own
          // warmth, with its own soft compression standing in for the tonemap
          // it skipped — so a hot window blooms without punching a white hole
          // through the plate. It rides the vignette with everything else.
          vec3 b = texture2D(tBloom, vUv).rgb * uBloom;
          lit += b / (1.0 + b);
          gl_FragColor = vec4(lit * v, c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  /**
   * §77.1: the composite's own uniform list, so "the depth of field is DELETED
   * rather than turned down" is checkable rather than assertable. A pass that
   * still carried `uMaxBlur` at zero would pass every image test and would be
   * the thing this block was asked not to leave behind.
   */
  uniformNames(): string[] {
    return Object.keys(this.material.uniforms)
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height)
    this.bloom.setSize(width, height)
    // setSize reallocates, so the composite's handle has to be re-bound
    this.material.uniforms.tBloom.value = this.bloom.texture
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    this.material.uniforms.uNight.value = this.night

    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)

    // §56.1: the glow is built from the linear buffer BEFORE the grade reads
    // it, then handed to the composite to add after. Skipped entirely when the
    // caller has asked for no glow, so golden-hour cities pay nothing for it.
    this.material.uniforms.uBloom.value = this.bloom.strength
    if (this.bloom.strength > 0.001) {
      this.bloom.generate(renderer, this.target.texture)
      this.material.uniforms.tBloom.value = this.bloom.texture
    }
    renderer.render(this.scene, this.camera)
  }

  /**
   * §56.1 calibration instrument. The bright pass claims a line between
   * "surface returning light" and "surface emitting it" at 1.0 linear — that
   * claim is measurable, not a matter of taste, so this reads the half-float
   * scene buffer back and reports where the plate's radiance actually sits.
   * Used by tools/watch to set the threshold from the frame rather than from
   * an argument about it.
   */
  measureLinear(renderer: WebGLRenderer, samples = 64): Record<string, number> {
    const w = this.target.width
    const h = this.target.height
    const buf = new Uint16Array(w * h * 4)
    renderer.readRenderTargetPixels(this.target, 0, 0, w, h, buf)
    const half = (u: number): number => {
      const s = (u & 0x8000) >> 15
      const e = (u & 0x7c00) >> 10
      const f = u & 0x03ff
      if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024)
      if (e === 0x1f) return f ? Number.NaN : (s ? -1 : 1) * Number.POSITIVE_INFINITY
      return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024)
    }
    const lums: number[] = []
    let max = 0
    for (let i = 0; i < w * h; i++) {
      const r = half(buf[i * 4])
      const g = half(buf[i * 4 + 1])
      const b = half(buf[i * 4 + 2])
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      if (Number.isFinite(l)) {
        if (l > max) max = l
        lums.push(l)
      }
    }
    lums.sort((a, b) => a - b)
    const q = (p: number): number => lums[Math.min(lums.length - 1, Math.floor(lums.length * p))] ?? 0
    const over = (t: number): number => lums.length - lowerBound(lums, t)
    void samples
    return {
      max,
      p50: q(0.5),
      p90: q(0.9),
      p99: q(0.99),
      p999: q(0.999),
      fracOver0_8: over(0.8) / lums.length,
      fracOver1_0: over(1.0) / lums.length,
      fracOver1_3: over(1.3) / lums.length,
    }
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
    this.quad.geometry.dispose()
    this.bloom.dispose()
  }
}
