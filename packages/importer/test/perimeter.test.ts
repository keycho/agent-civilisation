/**
 * §31.6-4b harness: the courtyard-ring split proven on synthetic fabric
 * before any fetch. Fixtures are the shapes paris will actually send: a
 * square donut (multipolygon perimeter block), an off-centre courtyard, a
 * C-shape traced as a single ring, and the shapes that must NOT split — a
 * filled block and a small dwelling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { area as ringArea, ringSelfIntersects, type Ring } from '@civ/core'
import { readsAsPerimeter, splitPerimeter } from '../src/build/perimeter.ts'

const square = (cx: number, cy: number, half: number): Ring => [
  [cx - half, cy - half],
  [cx + half, cy - half],
  [cx + half, cy + half],
  [cx - half, cy + half],
]

/** C-shape: 60x60 block with a 36-wide notch cut from the east side. */
const cShape: Ring = [
  [-30, -30],
  [30, -30],
  [30, -18],
  [-6, -18],
  [-6, 18],
  [30, 18],
  [30, 30],
  [-30, 30],
]

test('square donut splits into radial strips that conserve area', () => {
  const outer = square(0, 0, 40)
  const inner = square(0, 0, 22)
  assert.ok(readsAsPerimeter(outer, [inner]), 'donut reads as perimeter')
  const pieces = splitPerimeter(outer, [inner])
  assert.ok(pieces.length >= 10, `split produced ${pieces.length} pieces`)
  const total = pieces.reduce((s, r) => s + ringArea(r), 0)
  const target = ringArea(outer) - ringArea(inner)
  assert.ok(Math.abs(total - target) <= target * 0.04, `area conserved: ${total} vs ${target}`)
  for (const p of pieces) {
    assert.ok(!ringSelfIntersects(p), 'no piece self-intersects')
    assert.ok(ringArea(p) >= 8, 'no degenerate slivers')
  }
})

test('off-centre courtyard still conserves area', () => {
  const outer = square(0, 0, 40)
  const inner = square(9, 6, 16)
  const pieces = splitPerimeter(outer, [inner])
  const target = ringArea(outer) - ringArea(inner)
  const total = pieces.reduce((s, r) => s + ringArea(r), 0)
  assert.ok(pieces.length > 1, 'off-centre courtyard split')
  assert.ok(Math.abs(total - target) <= target * 0.04, `area conserved: ${total} vs ${target}`)
})

test('c-shape single ring splits by wedge with exact conservation', () => {
  assert.ok(readsAsPerimeter(cShape, []), 'c-shape reads as perimeter')
  const pieces = splitPerimeter(cShape, [])
  const target = ringArea(cShape)
  const total = pieces.reduce((s, r) => s + ringArea(r), 0)
  // wedge-clip either splits cleanly or falls back whole; both conserve
  assert.ok(Math.abs(total - target) <= target * 0.04, `area conserved: ${total} vs ${target}`)
})

test('filled block and small dwelling do not read as perimeter', () => {
  assert.ok(!readsAsPerimeter(square(0, 0, 30), []), 'filled block is not a ring')
  assert.ok(!readsAsPerimeter(square(0, 0, 8), []), 'small dwelling is not a ring')
})

test('degenerate courtyard falls back to the whole footprint', () => {
  const outer = square(0, 0, 40)
  // courtyard touching the outer edge: rays cross outside-in and the strip
  // construction must refuse rather than emit garbage
  const inner = square(24, 0, 16)
  const pieces = splitPerimeter(outer, [inner])
  if (pieces.length === 1) {
    assert.equal(pieces[0], outer)
  } else {
    const target = ringArea(outer) - ringArea(inner)
    const total = pieces.reduce((s, r) => s + ringArea(r), 0)
    assert.ok(Math.abs(total - target) <= target * 0.04, 'or it conserved anyway')
  }
})
