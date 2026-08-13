import { ENVIRONMENT } from '@civ/core'
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PCFSoftShadowMap,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type WebGLRenderer,
} from 'three'

/**
 * §15's material and light direction: strong ambient, soft shadows,
 * atmospheric depth, restrained texture.
 *
 * §16.3 notes that ortho-ish framing kills natural perspective falloff, so
 * distance fog has to be explicit — it does not come free the way it does in a
 * wide-angle view.
 */

export interface EnvironmentOptions {
  radius: number
  groundY: number
}

export function createEnvironment(scene: Scene, opts: EnvironmentOptions): {
  sun: DirectionalLight
  sky: Mesh
} {
  scene.background = new Color(ENVIRONMENT.sky)
  scene.fog = new Fog(new Color(ENVIRONMENT.fog).getHex(), opts.radius * 1.5, opts.radius * 5.2)

  // Strong sky-to-ground ambient is what keeps a stylised world readable in
  // shadow without needing bounce lighting.
  const hemi = new HemisphereLight(
    new Color(ENVIRONMENT.sky).getHex(),
    new Color(ENVIRONMENT.ground).getHex(),
    1.55,
  )
  scene.add(hemi)
  scene.add(new AmbientLight(new Color(ENVIRONMENT.shadowCool).getHex(), 0.28))

  const sun = new DirectionalLight(new Color(ENVIRONMENT.sunWarm).getHex(), 2.15)
  sun.position.set(-0.55, 0.72, 0.42).multiplyScalar(opts.radius * 2.2)
  sun.target.position.set(0, opts.groundY, 0)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const s = opts.radius * 1.25
  sun.shadow.camera.left = -s
  sun.shadow.camera.right = s
  sun.shadow.camera.top = s
  sun.shadow.camera.bottom = -s
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = opts.radius * 6
  // long soft contact shadows rather than hard architectural ones (§16.3)
  sun.shadow.bias = -0.0008
  sun.shadow.normalBias = 0.5
  sun.shadow.radius = 3.5
  scene.add(sun)
  scene.add(sun.target)

  const sky = createSkyDome(opts.radius * 12)
  scene.add(sky)

  return { sun, sky }
}

export function configureRenderer(renderer: WebGLRenderer): void {
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.02
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
}

/** A flat background colour reads as a void. A two-stop gradient reads as air. */
function createSkyDome(radius: number): Mesh {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new Color(ENVIRONMENT.sky) },
      uBottom: { value: new Color(ENVIRONMENT.horizon) },
    },
    vertexShader: /* glsl */ `
      varying float vH;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vH = normalize(world.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      varying float vH;
      void main() {
        float t = smoothstep(-0.08, 0.42, vH);
        gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
      }
    `,
  })
  const mesh = new Mesh(new SphereGeometry(radius, 32, 16), material)
  mesh.renderOrder = -1000
  mesh.frustumCulled = false
  return mesh
}

/** Simple preview lighting for the archetype harness — no fog, no sky. */
export function createPreviewEnvironment(scene: Scene): DirectionalLight {
  scene.background = new Color('#d9dcdb')
  scene.add(new HemisphereLight(0xdfe6e8, 0x9a9c92, 1.7))
  scene.add(new AmbientLight(0x8899aa, 0.3))
  const sun = new DirectionalLight(0xfff2dd, 2.2)
  sun.position.set(-40, 70, 45)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const s = 90
  sun.shadow.camera.left = -s
  sun.shadow.camera.right = s
  sun.shadow.camera.top = s
  sun.shadow.camera.bottom = -s
  sun.shadow.camera.far = 400
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.4
  sun.shadow.radius = 3
  scene.add(sun)
  return sun
}

export function createPreviewGround(size: number): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(size, size),
    new MeshLambertMaterial({ color: new Color('#c6c8c1') }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  return mesh
}

export const SUN_DIRECTION = new Vector3(-0.55, 0.72, 0.42).normalize()
