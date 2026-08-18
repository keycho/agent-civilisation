/**
 * §56.3: the water reflection cheat. "Mirrored emissive sprites for lights
 * within n metres of water edges, fresnel-graded darkening — no true
 * reflections, just the evidence of them."
 *
 * Each qualifying lamp gets a second, dimmer light mirrored through the water
 * plane, stretched vertically the way a real reflection smears on a moving
 * surface. Two honesty constraints make this read rather than look like a bug:
 *
 *   - it is painted just ABOVE the water plane rather than mirrored beneath it.
 *     Mirroring below is what a real reflection does, and it is invisible here:
 *     our water is an opaque surface that writes depth, so the first version of
 *     this drew 34 reflections in tokyo that changed exactly zero pixels. The
 *     cheat is evidence ON the water, not geometry under it;
 *   - it dims with the lamp's distance from the bank, standing in for the
 *     grazing-angle falloff a real fresnel term would give. A lamp far inland
 *     has no business appearing in the canal.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  type Vector3,
} from 'three'

/** how far from a bank a lamp can stand and still show in the water */
const REACH_M = 42

interface WaterPlane {
  ring: number[][]
  level: number
}

/** shortest distance from a point to a ring's edges, in chunk metres */
function distanceToRing(ring: number[][], x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / len2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = a[0] + dx * t
    const py = a[1] + dy * t
    const d = Math.hypot(x - px, y - py)
    if (d < best) best = d
  }
  return best
}

export function createWaterReflections(
  lamps: Vector3[],
  water: WaterPlane[],
  warm: string,
  night: number,
): Group {
  const group = new Group()
  if (!lamps.length || !water.length || night < 0.45) return group

  const mirrored: Array<{ x: number; y: number; z: number; fade: number }> = []
  for (const p of lamps) {
    // lamp positions are render space (x, y, -chunkY)
    const cx = p.x
    const cy = -p.z
    let best = Infinity
    let level = 0
    for (const w of water) {
      const d = distanceToRing(w.ring, cx, cy)
      if (d < best) {
        best = d
        level = w.level
      }
    }
    if (best > REACH_M) continue
    // the stand-in for fresnel: presence falls off with distance from the bank
    const fade = 1 - best / REACH_M
    // sit on the surface, not under it — see the note at the top
    if (p.y <= level) continue
    mirrored.push({ x: p.x, y: level + 0.15, z: p.z, fade: fade * fade })
  }
  if (!mirrored.length) return group

  const geo = new PlaneGeometry(1, 1)
  const fades = new Float32Array(mirrored.length)
  for (let i = 0; i < mirrored.length; i++) fades[i] = mirrored[i].fade
  geo.setAttribute('aFade', new InstancedBufferAttribute(fades, 1))

  const mat = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(warm) },
      uIntensity: { value: 0.85 },
      uSizeM: { value: 3.4 },
      uMinScreen: { value: 0.0026 },
      /** how much taller than wide a reflection smears */
      uStretch: { value: 3.6 },
    },
    vertexShader: /* glsl */ `
      attribute float aFade;
      varying vec2 vUv;
      varying float vFade;
      uniform float uSizeM, uMinScreen, uStretch;
      void main() {
        vUv = uv;
        vFade = aFade;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float size = max(uSizeM, -mv.z * uMinScreen);
        // a reflection is a vertical smear, not a disc — the surface is moving
        // hang the smear downward from the surface, the way a reflection
        // trails toward the viewer rather than straddling the waterline
        mv.xy += vec2(position.x * size, position.y * size * uStretch - size * uStretch * 0.42);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFade;
      uniform vec3 uColor;
      uniform float uIntensity;
      void main() {
        vec2 d = vUv - 0.5;
        // elliptical falloff: tight across, long down
        float r = length(vec2(d.x * 2.6, d.y)) * 2.0;
        if (r > 1.0) discard;
        float body = pow(max(0.0, 1.0 - r), 2.1);
        gl_FragColor = vec4(uColor * body * uIntensity * vFade, 1.0);
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  })

  const mesh = new InstancedMesh(geo, mat, mirrored.length)
  mesh.frustumCulled = false
  // after the opaque world, before the lamps that cast it
  mesh.renderOrder = 5
  const m = new Matrix4()
  for (let i = 0; i < mirrored.length; i++) {
    const r = mirrored[i]
    m.makeTranslation(r.x, r.y, r.z)
    mesh.setMatrixAt(i, m)
  }
  mesh.instanceMatrix.needsUpdate = true
  group.add(mesh)
  group.userData.count = mirrored.length
  return group
}
