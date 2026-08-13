import type { Bounds2, Ring, Vec2 } from '@civ/core'

/** Uniform bucket grid. Everything spatial in the importer is a few thousand
 * items over a 600 m square, so this is plenty and has no dependencies. */
export class GridIndex<T> {
  private cells = new Map<string, T[]>()
  private readonly cellSize: number

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`
  }

  insert(b: Bounds2, item: T): void {
    const x0 = Math.floor(b.minX / this.cellSize)
    const x1 = Math.floor(b.maxX / this.cellSize)
    const y0 = Math.floor(b.minY / this.cellSize)
    const y1 = Math.floor(b.maxY / this.cellSize)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y)
        const arr = this.cells.get(k)
        if (arr) arr.push(item)
        else this.cells.set(k, [item])
      }
    }
  }

  queryPoint(p: Vec2): T[] {
    return this.cells.get(this.key(Math.floor(p[0] / this.cellSize), Math.floor(p[1] / this.cellSize))) ?? []
  }

  queryRadius(p: Vec2, r: number): T[] {
    const out = new Set<T>()
    const x0 = Math.floor((p[0] - r) / this.cellSize)
    const x1 = Math.floor((p[0] + r) / this.cellSize)
    const y0 = Math.floor((p[1] - r) / this.cellSize)
    const y1 = Math.floor((p[1] + r) / this.cellSize)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const it of this.cells.get(this.key(x, y)) ?? []) out.add(it)
      }
    }
    return [...out]
  }
}

export function ringBounds(ring: Ring): Bounds2 {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}
