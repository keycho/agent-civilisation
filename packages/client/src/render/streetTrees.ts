/**
 * §56.3: street trees. "The reference is full of them; they break up every
 * street line."
 *
 * §48.4 already grows canopy over green landcover. What the reference has and
 * we did not is trees along the STREET — the line of stems that turns a road
 * into an avenue. Those go on the frontage, not on the parkland.
 *
 * Which frontage is a judgement the seed cannot answer directly: parcels carry
 * geometry, area, access and land value, but no use class. Buildings do carry
 * purpose, so "a residential or retail frontage" is derived as "a kerb with
 * residential or retail stock standing close behind it" — which is what the
 * phrase means on the ground anyway. An industrial yard edge or an open
 * carriageway with nothing behind it gets no trees, which is correct.
 */
import type { CityMaterial } from '@civ/core'
import type { RoadClass, RoadEdge, RoadNode } from '@civ/core'
import {
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
} from 'three'
import { sampleRoadFrontage } from './roadGraph.ts'

/** metres between street trees, by class — an avenue is denser than a lane */
const TREE_SPACING: Partial<Record<RoadClass, number>> = {
  secondary: 22,
  residential: 19,
  pedestrian: 17,
}

/** how far behind the kerb stock has to stand for this to be a frontage */
const FRONTAGE_REACH_M = 34

/** and how many neighbours make it a street rather than an outlier */
const FRONTAGE_MIN = 2

const MAX_STREET_TREES = 900

interface Seedling {
  x: number
  y: number
  z: number
  scale: number
}

/** coarse bucket grid over building centroids of the purposes that line streets */
function frontageIndex(
  buildings: Array<{ purpose: string; footprint: number[][] }>,
  cell: number,
): Map<number, Array<[number, number]>> {
  const grid = new Map<number, Array<[number, number]>>()
  for (const b of buildings) {
    if (b.purpose !== 'residential' && b.purpose !== 'retail') continue
    const fp = b.footprint
    if (!fp?.length) continue
    let cx = 0
    let cy = 0
    for (const p of fp) {
      cx += p[0]
      cy += p[1]
    }
    cx /= fp.length
    cy /= fp.length
    const key = Math.floor(cx / cell) * 100000 + Math.floor(cy / cell)
    const list = grid.get(key)
    if (list) list.push([cx, cy])
    else grid.set(key, [[cx, cy]])
  }
  return grid
}

export function createStreetTrees(
  nodes: RoadNode[],
  edges: RoadEdge[],
  buildings: Array<{ purpose: string; footprint: number[][] }>,
  ground: (x: number, y: number) => number,
  halfExtentM: number,
  city: CityMaterial,
  night: number,
): Group {
  const group = new Group()
  const cell = FRONTAGE_REACH_M
  const grid = frontageIndex(buildings, cell)

  const points = sampleRoadFrontage(nodes, edges, ground, halfExtentM, {
    spacing: TREE_SPACING,
    // stand them just outside the pavement band so a trunk is never in the
    // carriageway the §48.4 ribbon draws
    offset: { secondary: 8.5, residential: 6.8, pedestrian: 5.4 },
    baselineOnly: true,
  })

  const chosen: Seedling[] = []
  for (const p of points) {
    if (chosen.length >= MAX_STREET_TREES) break
    // §56.3: a frontage is a kerb with stock behind it
    const gx = Math.floor(p.x / cell)
    const gy = Math.floor(-p.z / cell)
    let near = 0
    for (let dx = -1; dx <= 1 && near < FRONTAGE_MIN; dx++) {
      for (let dy = -1; dy <= 1 && near < FRONTAGE_MIN; dy++) {
        const list = grid.get((gx + dx) * 100000 + (gy + dy))
        if (!list) continue
        for (const [bx, by] of list) {
          if (Math.hypot(bx - p.x, by + p.z) < FRONTAGE_REACH_M) {
            near++
            if (near >= FRONTAGE_MIN) break
          }
        }
      }
    }
    if (near < FRONTAGE_MIN) continue
    // a street tree is a street tree: less size spread than the parkland ones
    chosen.push({ x: p.x, y: p.y, z: p.z, scale: 2.9 + p.hash * 1.5 })
  }
  if (!chosen.length) return group

  const geo = new IcosahedronGeometry(1, 1)
  geo.scale(0.86, 1.05, 0.86)
  /**
   * §50.2 dims the ground, the roads and the §48.4 canopy at a dark hour so
   * the buildings sit on top of their own plate. Street trees are added after
   * that pass and carry their own authored dusk value instead: run through
   * dimGround as well they land at pure black, and a black disc beside a lit
   * lamp reads as a hole in the frame rather than as a tree.
   */
  const base = new Color('#6f8757').lerp(new Color(city.wall[0], city.wall[1], city.wall[2]), 0.12)
  const dusk = base.clone().multiplyScalar(1 - 0.55 * Math.min(1, night))
  const material = new MeshLambertMaterial({ color: dusk })

  const mesh = new InstancedMesh(geo, material, chosen.length)
  mesh.castShadow = true
  mesh.frustumCulled = false
  const dummy = new Object3D()
  for (let i = 0; i < chosen.length; i++) {
    const t = chosen[i]
    dummy.position.set(t.x, t.y + t.scale * 0.95, t.z)
    dummy.scale.setScalar(t.scale)
    dummy.rotation.y = t.scale * 2.7
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true

  // a trunk, so a street tree at street framing is not a floating ball
  const trunkGeo = new IcosahedronGeometry(1, 0)
  trunkGeo.scale(0.3, 1, 0.3)
  const trunk = new InstancedMesh(
    trunkGeo,
    new MeshLambertMaterial({ color: new Color('#4a4038').multiplyScalar(1 - 0.5 * night) }),
    chosen.length,
  )
  trunk.frustumCulled = false
  for (let i = 0; i < chosen.length; i++) {
    const t = chosen[i]
    dummy.position.set(t.x, t.y + t.scale * 0.42, t.z)
    dummy.scale.set(1, t.scale * 0.5, 1)
    dummy.rotation.y = 0
    dummy.updateMatrix()
    trunk.setMatrixAt(i, dummy.matrix)
  }
  trunk.instanceMatrix.needsUpdate = true

  group.add(mesh)
  group.add(trunk)
  group.userData.count = chosen.length
  return group
}
