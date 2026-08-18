import {
  DepthTexture,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedShortType,
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'

/**
 * §16.3: "tilt-shift depth of field — the single cheapest signal for
 * handcrafted diorama. Focal band tied to camera target distance."
 *
 * Depth-based rather than a screen-space gradient, so the band actually tracks
 * what the camera is looking at instead of smearing the top and bottom of the
 * frame regardless of content. It fades out as the camera comes down to street
 * level, where a miniature read is wrong and just looks out of focus.
 */
export class TiltShiftPass {
  private target: WebGLRenderTarget
  private quad: Mesh
  private scene = new Scene()
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private material: ShaderMaterial

  /** §50.2: how much of this city's authored hour is night */
  night = 0

  /** metres either side of the focal plane that stay sharp */
  focusRange = 130
  /**
   * DOF r2: capped well below the old 9. At 9px the far field stopped being
   * soft and became formless — a smear where a skyline used to be. The point
   * of the miniature read is that the far field is out of focus, not that it
   * is gone.
   */
  maxBlurPx = 5
  strength = 1
  /** what the last frame actually asked for, for the capture rigs */
  lastStrength = 1

  constructor(width: number, height: number) {
    const depth = new DepthTexture(width, height, UnsignedShortType)
    this.target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      depthTexture: depth,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    })

    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: depth },
        uTexel: { value: new Vector2(1 / width, 1 / height) },
        uNear: { value: 1 },
        uFar: { value: 12000 },
        uFocus: { value: 600 },
        uRange: { value: this.focusRange },
        uMaxBlur: { value: this.maxBlurPx },
        uStrength: { value: 1 },
        uVignette: { value: 0.42 },
        uExposure: { value: 1.06 },
        uContrast: { value: 0.32 },
        uDesat: { value: 0.18 },
        uNight: { value: 0 },
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
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        uniform float uNear, uFar, uFocus, uRange, uMaxBlur, uStrength, uVignette;
        uniform float uExposure, uContrast, uDesat;
        uniform float uNight;

        /**
         * §48.2: the one post chain — filmic tonemap (ACES approximation),
         * a gentle contrast s-curve, and a slight desaturation of the mids
         * with the warm band protected, so terracotta and the fork's amber
         * keep their voice while the greys quiet down. The divergence lerp
         * reads through: it is a relative move in the same gamut, and the
         * protection is exactly its hue family.
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

        // §47.1: subtle radial falloff toward the void, so the plate edge
        // reads as an object sitting in darkness rather than a viewport crop
        vec4 vignetted(vec4 c) {
          float r = length(vUv * 2.0 - 1.0);
          float v = 1.0 - uVignette * (1.0 - 0.65 * uNight) * smoothstep(0.62, 1.42, r);
          return vec4(grade(c.rgb) * v, c.a);
        }

        float viewZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          // perspective depth -> positive distance from the camera
          return (2.0 * uNear * uFar) / (uFar + uNear - (2.0 * d - 1.0) * (uFar - uNear));
        }

        void main() {
          float z = viewZ(vUv);
          float coc = clamp(abs(z - uFocus) / uRange, 0.0, 1.0);
          coc = pow(coc, 1.35) * uMaxBlur * uStrength;

          if (coc < 0.35) {
            gl_FragColor = vignetted(texture2D(tColor, vUv));
            return;
          }

          // golden-angle spiral: even coverage for very few taps
          vec4 sum = texture2D(tColor, vUv);
          float total = 1.0;
          const int TAPS = 12;
          for (int i = 0; i < TAPS; i++) {
            float fi = float(i) + 1.0;
            float a = fi * 2.39996323;
            float r = sqrt(fi / float(TAPS)) * coc;
            vec2 offset = vec2(cos(a), sin(a)) * r * uTexel;
            vec2 uv = vUv + offset;
            // do not drag sharp foreground over a blurred background
            float w = step(uFocus - uRange * 4.0, viewZ(uv));
            sum += texture2D(tColor, uv) * w;
            total += w;
          }
          gl_FragColor = vignetted(sum / total);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height)
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height)
  }

  render(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    focusDistance: number,
    strength: number,
  ): void {
    const u = this.material.uniforms
    u.uNear.value = camera.near
    u.uFar.value = camera.far
    u.uFocus.value = focusDistance
    u.uRange.value = this.focusRange
    u.uMaxBlur.value = this.maxBlurPx
    u.uStrength.value = strength
    this.lastStrength = strength
    u.uNight.value = this.night

    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)

    if (strength <= 0.01) {
      // nothing to do; still needs the blit so the frame is not blank
      u.uStrength.value = 0
    }
    renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
    this.quad.geometry.dispose()
  }
}
