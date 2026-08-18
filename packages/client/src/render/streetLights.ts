/**
 * §56.1: street lights. "The road graph exists; this is an instancing pass."
 *
 * Two objects, two draw calls, however many thousand lamps:
 *
 *   - the LIGHT, which is what a lamp is at city zoom. A billboarded quad with
 *     a radial falloff, additive, emitting past the §56.1 bloom threshold so
 *     the glow pass finds it. It carries a screen-space size floor: a 5 m lamp
 *     two kilometres back is a third of a pixel, and a light that dims to
 *     nothing with distance is exactly the density the reference has and we
 *     don't.
 *   - the POLE, which only exists inside street framing. At city zoom it would
 *     be a grey speck under a light that is already reading; per §56.1 the
 *     light is the object up there.
 *
 * Lamps burn only where the authored hour is dusk or darker (§50.2). That is
 * not a switch on top of the art direction, it IS the art direction: a lit
 * street lamp at golden hour is a mistake, and `night` already says which
 * cities are past that.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { RoadClass, RoadEdge, RoadNode } from '@civ/core'
import { sampleRoadFrontage } from './roadGraph.ts'

/** metres between lamps, by class. Footpaths get none: they are not streets. */
const LAMP_SPACING: Partial<Record<RoadClass, number>> = {
  primary: 30,
  secondary: 32,
  residential: 38,
  service: 56,
  pedestrian: 46,
}

/** the wide roads get both kerbs; the small ones alternate, per edge */
const LAMP_BOTH_SIDES: Partial<Record<RoadClass, boolean>> = {
  primary: true,
  secondary: true,
}

/** mounting height, metres */
const LAMP_HEIGHT: Record<string, number> = {
  primary: 9,
  secondary: 8,
  residential: 6.2,
  service: 5.4,
  pedestrian: 4.6,
}

/** below this camera distance the poles are worth drawing */
const POLE_DISTANCE = 420

/** the hour at which lamps come on — see CITY_HOUR.night */
export function lampsForNight(night: number): number {
  return night <= 0.45 ? 0 : night >= 0.7 ? 1 : (night - 0.45) / 0.25
}

export class StreetLights {
  readonly group = new Group()
  private glow: InstancedMesh | null = null
  private poles: InstancedMesh | null = null
  /** render-space lamp positions, for §56.6's reflections to mirror */
  readonly positions: Vector3[] = []

  constructor(
    nodes: RoadNode[],
    edges: RoadEdge[],
    ground: (x: number, y: number) => number,
    halfExtentM: number,
    opts: { night: number; warm: string },
  ) {
    const strength = lampsForNight(opts.night)
    if (strength <= 0) return

    const points = sampleRoadFrontage(nodes, edges, ground, halfExtentM, {
      spacing: LAMP_SPACING,
      bothSides: LAMP_BOTH_SIDES,
      baselineOnly: true,
    })
    if (!points.length) return

    const n = points.length
    const warm = new Color(opts.warm)

    // ---- the light -------------------------------------------------------
    const glowGeo = new PlaneGeometry(1, 1)
    const seeds = new Float32Array(n)
    const mat = new ShaderMaterial({
      uniforms: {
        uColor: { value: warm },
        // emits past the §56.1 threshold (1.15 linear) so the bloom pass
        // treats a lamp as an emitter, which is what it is
        /**
         * §63.2: lamps are INFRASTRUCTURE, and warmth in this frame means the
         * civilization is awake here — so a street lamp may not compete with a
         * lit window. §56.1 set this at 1.7 sodium against a golden-hour city;
         * against a dark one the same value read as snow across the plate. It
         * is now a quarter of that, in the cold register, and the frame's
         * bright points are agents again.
         */
        uIntensity: { value: 0.42 * strength },
        uSizeM: { value: 3.0 },
        /**
         * Screen-space floor, in units of view-z. Sized from the frame, not
         * from taste: the 15-degree lens sees ~474 m across 1280 px at city
         * framing, so a metre is about 2.7 px. A first pass at 0.0075 gave a
         * 13 m quad up there — a lamp wider than the building it stands
         * against, and the plate disappeared behind its own street lighting.
         * At 0.0022 the quad is ~4 m, whose hot core lands around two pixels:
         * a point of light, which is what the reference is made of thousands
         * of.
         */
        uMinScreen: { value: 0.0016 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        varying vec2 vUv;
        varying float vSeed;
        uniform float uSizeM, uMinScreen;
        void main() {
          vUv = uv;
          vSeed = aSeed;
          // billboard: take the instance ORIGIN into view space, then offset
          // by the quad's own corner. Rotating the quad would be the same
          // work with a matrix that can be skewed by instance scale.
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float size = max(uSizeM, -mv.z * uMinScreen);
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vSeed;
        uniform vec3 uColor;
        uniform float uIntensity;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          // a hot core with a soft skirt: the core is what blooms, the skirt
          // is the lamp's own throw onto the air around it
          float core = pow(max(0.0, 1.0 - r), 3.2);
          float skirt = pow(max(0.0, 1.0 - r), 1.15) * 0.28;
          // sodium lamps are not uniform; a stable per-lamp tint keeps a
          // street from reading as a repeated decal
          float tint = 0.88 + 0.24 * vSeed;
          gl_FragColor = vec4(uColor * tint * (core + skirt) * uIntensity, 1.0);
        }
      `,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })
    const glow = new InstancedMesh(glowGeo, mat, n)
    glow.instanceMatrix.setUsage(DynamicDrawUsage)
    glow.frustumCulled = false

    // ---- the pole --------------------------------------------------------
    const poleGeo = new BoxGeometry(0.16, 1, 0.16)
    // pivot at the base so one unit-tall box scales to any mounting height
    poleGeo.translate(0, 0.5, 0)
    // dark, but not so dark it is the void: a pole at night is a silhouette
    // against the ground its own lamp is lighting, not an absence
    const poleMat = new MeshLambertMaterial({ color: '#43403b' })
    const poles = new InstancedMesh(poleGeo, poleMat, n)
    poles.frustumCulled = false
    poles.castShadow = false
    poles.receiveShadow = false

    const m = new Matrix4()
    for (let i = 0; i < n; i++) {
      const p = points[i]
      const h = LAMP_HEIGHT[p.cls] ?? 6
      seeds[i] = p.hash
      this.positions.push(new Vector3(p.x, p.y + h, p.z))
      m.makeTranslation(p.x, p.y + h, p.z)
      glow.setMatrixAt(i, m)
      m.makeScale(1, h, 1)
      m.setPosition(p.x, p.y, p.z)
      poles.setMatrixAt(i, m)
    }
    glow.instanceMatrix.needsUpdate = true
    poles.instanceMatrix.needsUpdate = true
    glowGeo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1))

    // additive glows must draw after the opaque world or they blend with
    // whatever was in the buffer first
    glow.renderOrder = 6
    poles.visible = false

    this.glow = glow
    this.poles = poles
    this.group.add(poles)
    this.group.add(glow)
  }

  /** §56.1: poles appear only once the camera is in the street */
  update(cameraDistance: number): void {
    if (this.poles) this.poles.visible = this.on && cameraDistance < POLE_DISTANCE
    if (this.glow) this.glow.visible = this.on
  }

  /** capture-rig switch, so an a/b pair can isolate the lamps themselves */
  on = true

  get count(): number {
    return this.glow?.count ?? 0
  }

  dispose(): void {
    for (const o of [this.glow, this.poles]) {
      if (!o) continue
      o.geometry.dispose()
      ;(o.material as { dispose(): void }).dispose()
      this.group.remove(o as unknown as Mesh)
    }
  }
}
