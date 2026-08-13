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

  /** metres either side of the focal plane that stay sharp */
  focusRange = 130
  maxBlurPx = 9
  strength = 1

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
        uniform float uNear, uFar, uFocus, uRange, uMaxBlur, uStrength;

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
            gl_FragColor = texture2D(tColor, vUv);
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
          gl_FragColor = sum / total;
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
