/**
 * §42.2: linear landmarks get their own ground treatment. A rail alignment —
 * working or dismantled — draws as a dark ballast ribbon; a canal line draws
 * as a stone quay edging beside the water the substrate already carries.
 * Flat ribbons, no geometry above the ground plane: these are marks on the
 * plate, not structures, and they stay inside the §15 palette.
 */
import type { LandmarkLine } from '@civ/core'
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
} from 'three'

const STYLE: Record<LandmarkLine['class'], { color: string; width: number; lift: number }> = {
  rail: { color: '#7a746a', width: 4.2, lift: 0.14 },
  canal: { color: '#b3aa97', width: 2.6, lift: 0.1 },
}

export function createLandmarkLines(
  lines: LandmarkLine[],
  heightAt: (x: number, y: number) => number,
): Group {
  const group = new Group()
  const byClass = new Map<LandmarkLine['class'], LandmarkLine[]>()
  for (const l of lines) {
    const list = byClass.get(l.class) ?? []
    list.push(l)
    byClass.set(l.class, list)
  }

  for (const [cls, ls] of byClass) {
    const style = STYLE[cls]
    const positions: number[] = []
    for (const l of ls) {
      const half = style.width / 2
      for (let i = 0; i < l.path.length - 1; i++) {
        const [ax, ay] = l.path[i]
        const [bx, by] = l.path[i + 1]
        const dx = bx - ax
        const dy = by - ay
        const len = Math.hypot(dx, dy)
        if (len < 0.5) continue
        const nx = (-dy / len) * half
        const ny = (dx / len) * half
        const za = heightAt(ax, ay) + style.lift
        const zb = heightAt(bx, by) + style.lift
        // two triangles for the segment quad, in render space (y up, z = -y)
        const quad: Array<[number, number, number]> = [
          [ax + nx, za, -(ay + ny)],
          [bx + nx, zb, -(by + ny)],
          [bx - nx, zb, -(by - ny)],
          [ax - nx, za, -(ay - ny)],
        ]
        positions.push(...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3])
      }
    }
    if (!positions.length) continue
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geo.computeVertexNormals()
    const mesh = new Mesh(
      geo,
      new MeshLambertMaterial({ color: style.color, side: DoubleSide }),
    )
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}
