import { STAGE, paletteGlsl } from '@civ/core'
import { Color, MeshStandardMaterial, type Texture, type WebGLProgramParametersWithUniforms } from 'three'
import type { BuildingDataTexture } from './buildingData.ts'

/**
 * One material for every building in a chunk.
 *
 * Everything that varies per building — colour, roof tone, construction
 * progress, condition, divergence class — is read from the data texture in the
 * vertex shader and carried down as varyings. Nothing here is per-object, so
 * the whole chunk is one draw call (§16.2).
 *
 * Built on MeshStandardMaterial via onBeforeCompile rather than a bespoke
 * ShaderMaterial so that shadows, fog and tone mapping keep working; §15 wants
 * soft shadows and atmospheric depth, and reimplementing those is not craft.
 */

export interface BuildingMaterialUniforms {
  uBuildingData: { value: Texture }
  uBuildingStatic: { value: Texture }
  uDataSize: { value: [number, number] }
  uDivergenceMode: { value: number }
  uHighlight: { value: number }
  uHighlightColor: { value: Color }
  /** §42.1: per-city material base — wall tint and roof pull */
  uCityWall: { value: Color }
  uCityRoof: { value: Color }
  uCityRoofW: { value: number }
}

export interface BuildingMaterial extends MeshStandardMaterial {
  civ: BuildingMaterialUniforms
}

export function createBuildingMaterial(data: BuildingDataTexture): BuildingMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.0,
  }) as BuildingMaterial

  const civ: BuildingMaterialUniforms = {
    uBuildingData: { value: data.texture },
    uBuildingStatic: { value: data.staticTexture },
    uDataSize: { value: [data.width, data.height] },
    uDivergenceMode: { value: 0 },
    uHighlight: { value: -1 },
    uHighlightColor: { value: new Color('#ffe6a8') },
    uCityWall: { value: new Color(1, 1, 1) },
    uCityRoof: { value: new Color('#b07a63') },
    uCityRoofW: { value: 0 },
  }
  material.civ = civ

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, civ)

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute float aBuildingIndex;
        attribute float aLocalY;
        attribute float aRole;
        attribute float aHeight;

        uniform sampler2D uBuildingData;
        uniform sampler2D uBuildingStatic;
        uniform vec2 uDataSize;
        uniform float uHighlight;

        varying vec4 vData;
        varying vec4 vStatic;
        varying float vRole;
        varying float vLocalY;
        varying float vHighlight;
        varying float vPitch;

        vec2 civDataUv(float index) {
          float x = mod(index, uDataSize.x);
          float y = floor(index / uDataSize.x);
          return (vec2(x, y) + 0.5) / uDataSize;
        }
      `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>

        vec2 civUv = civDataUv(aBuildingIndex);
        vData = texture2D(uBuildingData, civUv);
        vStatic = texture2D(uBuildingStatic, civUv);
        vRole = aRole;
        vLocalY = aLocalY;
        vHighlight = (abs(uHighlight - aBuildingIndex) < 0.5) ? 1.0 : 0.0;
        // §48.3: how pitched this face is, for the ridge highlight — a flat
        // slab top (|ny| ~ 1) reads 0 and takes no line
        vPitch = smoothstep(0.98, 0.80, abs(objectNormal.y));

        // §16.5: the mass rises out of the ground between massStart and
        // facadeStart. Sinking the whole building and letting the opaque
        // ground occlude it keeps the roof intact and the silhouette clean,
        // which a clip plane through a hollow shell would not.
        float civProgress = vData.r;
        float reveal = smoothstep(${STAGE.massStart.toFixed(3)}, ${STAGE.facadeStart.toFixed(3)}, civProgress);
        transformed.y -= (1.0 - reveal) * (aHeight + 0.6);
      `,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec4 vData;
        varying vec4 vStatic;
        varying float vRole;
        varying float vLocalY;
        varying float vHighlight;
        varying float vPitch;

        uniform float uDivergenceMode;
        uniform vec3 uHighlightColor;
        uniform vec3 uCityWall;
        uniform vec3 uCityRoof;
        uniform float uCityRoofW;

        ${paletteGlsl()}
      `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>

        int purposeIdx = int(floor(vData.b * 255.0 + 0.5));
        int divIdx     = int(floor(vData.g * 255.0 + 0.5));
        float condition = vData.a;
        float progress  = vData.r;

        int roofToneIdx = int(floor(vStatic.r * 255.0 + 0.5));
        float jitter    = vStatic.g;
        float era       = vStatic.b;

        vec3 base = PURPOSE_COLORS[clamp(purposeIdx, 0, 7)];

        // roles: 0 wall, 1 roof, 2 ground floor, 3 trim
        if (vRole > 0.5 && vRole < 1.5) {
          base = mix(base, ROOF_TONES[clamp(roofToneIdx, 0, 4)], 0.88);
          // §42.1: the city's roof material — slate, zinc, membrane, tile —
          // pulled at an authored weight so the tone family still varies
          base = mix(base, uCityRoof, uCityRoofW);
        } else if (vRole > 1.5 && vRole < 2.5) {
          base *= GROUND_FLOOR_DARKEN * uCityWall;
        } else if (vRole > 2.5) {
          base *= TRIM_LIGHTEN * uCityWall;
        } else {
          // §42.1: wall material base — a value/hue shift, never a repaint,
          // so purpose, jitter, era and condition all keep reading through
          base *= uCityWall;
        }

        // §48.3: per-building variation within the material family — the
        // value jitter that was here, plus a small stable warm/cool hue tilt
        // hashed off the same channel, so no two adjacent facades match
        base *= 0.93 + 0.14 * jitter;
        float hueT = fract(jitter * 7.31);
        base *= mix(vec3(1.025, 0.995, 0.955), vec3(0.965, 1.0, 1.045), hueT);

        // §48.3: age shows — older stock (era toward 1) warms and weathers
        // down a step beyond the old tint
        base = mix(base, base * vec3(1.06, 0.99, 0.90), era);
        base *= 1.0 - 0.06 * era;

        // condition: dulls and darkens as a building decays (§4); §48.3 also
        // greys a poor roof toward slate-neutral
        base *= 0.76 + 0.24 * condition;
        if (vRole > 0.5 && vRole < 1.5) {
          float roofGrey = (1.0 - condition) * 0.45;
          float rlum = dot(base, vec3(0.299, 0.587, 0.114));
          base = mix(base, vec3(rlum), roofGrey);
          // §48.3: the ridge highlight — one lighter line where a pitched
          // face meets the top of its mass; reads as form at city zoom
          base *= 1.0 + 0.17 * vPitch * smoothstep(0.955, 0.995, vLocalY);
        }

        // §16.4: divergence is a lerp, not a second palette. Untouched stock
        // desaturates toward neutral as agent work saturates.
        float w = DIVERGENCE_WEIGHTS[clamp(divIdx, 0, 7)];
        vec3 target = DIVERGENCE_COLORS[clamp(divIdx, 0, 7)];
        float lum = dot(base, vec3(0.299, 0.587, 0.114));
        vec3 grey = mix(base, vec3(lum), UNTOUCHED_DESATURATION);
        base = mix(base, grey, uDivergenceMode * (1.0 - w));
        base = mix(base, target, uDivergenceMode * w);

        // Raw structure before the facade treatment lands (§16.5, 0.85-1.00).
        float facade = smoothstep(${STAGE.facadeStart.toFixed(3)}, 1.0, progress);
        vec3 raw = mix(vec3(lum), vec3(0.62, 0.60, 0.57), 0.5);
        base = mix(raw, base, facade);

        // §16.3 asks for exaggerated ambient occlusion; §48.1 pushes it
        // further. A vertical gradient is not SSAO, but at city scale it is
        // what reads: it grounds every mass and costs nothing. Deeper at the
        // base, and a touch of it returning under the eave line.
        float ao = mix(0.55, 1.0, smoothstep(0.0, 0.26, vLocalY));
        ao *= 1.0 - 0.08 * smoothstep(0.88, 1.0, vLocalY) * step(vRole, 0.5);
        base *= ao;

        base = mix(base, uHighlightColor, vHighlight * 0.45);

        diffuseColor.rgb *= base;
      `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(0.96, 0.68, vData.a);
      `,
      )
  }

  // force a recompile if the material is reused across chunks
  material.customProgramCacheKey = () => 'civ-building-v2'
  return material
}
