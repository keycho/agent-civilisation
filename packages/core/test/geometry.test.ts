import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DIVERGENCE_WEIGHT,
  area,
  clipByConvex,
  containsPoint,
  footprintMetrics,
  generateArchetype,
  massReveal,
  obb,
  rdToWgs,
  scaffoldOpacity,
  selectArchetype,
  simplifyRing,
  wgsToRd,
  type Ring,
} from '../src/index.ts'

const rect = (w: number, d: number): Ring => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, d / 2],
  [-w / 2, d / 2],
]

test('RD and WGS84 round-trip within a decimetre', () => {
  for (const [lat, lon] of [
    [51.9159, 4.3959],
    [52.3702, 4.8952],
    [53.2194, 6.5665],
  ]) {
    const rd = wgsToRd(lat, lon)
    const back = rdToWgs(rd.x, rd.y)
    // 1e-6 degrees is about 0.11 m of latitude
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat drift ${back.lat - lat}`)
    assert.ok(Math.abs(back.lon - lon) < 2e-6, `lon drift ${back.lon - lon}`)
  }
})

test('oriented bounding box finds the long axis of a rotated rectangle', () => {
  const angle = 0.7
  const ring: Ring = rect(30, 8).map(([x, y]) => [
    x * Math.cos(angle) - y * Math.sin(angle),
    x * Math.sin(angle) + y * Math.cos(angle),
  ])
  const box = obb(ring)
  assert.ok(Math.abs(box.length - 30) < 0.2, `length ${box.length}`)
  assert.ok(Math.abs(box.width - 8) < 0.2, `width ${box.width}`)
  assert.ok(Math.abs(normalise(box.angle) - normalise(angle)) < 0.02)
})

function normalise(a: number): number {
  while (a < 0) a += Math.PI
  while (a >= Math.PI) a -= Math.PI
  return a
}

test('rectangularity separates boxy plans from articulated ones', () => {
  assert.ok(footprintMetrics(rect(20, 10)).rectangularity > 0.99)
  const lShape: Ring = [
    [0, 0],
    [20, 0],
    [20, 6],
    [8, 6],
    [8, 18],
    [0, 18],
  ]
  assert.ok(footprintMetrics(lShape).rectangularity < 0.7)
})

test('Sutherland-Hodgman clips a concave subject against a convex window', () => {
  const concave: Ring = [
    [0, 0],
    [20, 0],
    [20, 20],
    [12, 20],
    [12, 8],
    [8, 8],
    [8, 20],
    [0, 20],
  ]
  const window: Ring = rect(12, 12).map(([x, y]) => [x + 10, y + 10])
  const clipped = clipByConvex(concave, window)
  assert.ok(clipped.length >= 3)
  assert.ok(area(clipped) < area(concave))
  assert.ok(containsPoint(clipped, [6, 6]))
})

test('simplify keeps a ring closed and reduces collinear detail', () => {
  const noisy: Ring = []
  for (let i = 0; i <= 20; i++) noisy.push([i, 0])
  noisy.push([20, 10], [0, 10])
  const simplified = simplifyRing(noisy, 0.25)
  assert.ok(simplified.length < noisy.length)
  assert.ok(Math.abs(area(simplified) - area(noisy)) < 1)
})

test('construction thresholds agree with §16.5', () => {
  assert.equal(scaffoldOpacity(0.05), 0)
  assert.ok(scaffoldOpacity(0.2) > 0 && scaffoldOpacity(0.2) < 1)
  assert.equal(scaffoldOpacity(0.5), 1)
  assert.ok(scaffoldOpacity(1) < 0.01)
  assert.equal(massReveal(0.2), 0)
  assert.equal(massReveal(0.9), 1)
})

test('agent-built structures select a separate silhouette vocabulary (§16.1)', () => {
  const real = selectArchetype({
    footprint: rect(7, 13),
    heightM: 10,
    levels: 3,
    purpose: 'residential',
    constructionYear: 1905,
    source: 'real_world',
  })
  assert.equal(real.archetype, 'rowhouse')

  const agent = selectArchetype({
    footprint: rect(7, 13),
    heightM: 10,
    levels: 3,
    purpose: 'residential',
    constructionYear: 2038,
    source: 'agent_built',
  })
  assert.ok(agent.archetype.startsWith('agent_'), agent.archetype)
})

test('every archetype generates non-degenerate geometry on every fixture', () => {
  const fixtures: Ring[] = [
    rect(6, 13),
    rect(19, 11),
    rect(44, 24),
    [
      [0, 0],
      [22, 0],
      [22, 8],
      [9, 8],
      [9, 16],
      [0, 16],
    ],
  ]
  for (const footprint of fixtures) {
    for (const height of [4, 11, 30]) {
      const out = generateArchetype(
        {
          footprint,
          heightM: height,
          levels: Math.max(1, Math.round(height / 3.2)),
          purpose: 'residential',
          constructionYear: 1909,
          source: 'real_world',
        },
        'test',
      )
      assert.ok(out.mesh.triangleCount > 0, `${out.archetype} produced no triangles`)
      assert.ok(out.mesh.height > 0)
      assert.ok(
        out.mesh.positions.every(Number.isFinite),
        `${out.archetype} produced non-finite positions`,
      )
      // localY must stay normalised or the construction reveal misbehaves
      for (const v of out.mesh.localY) assert.ok(v >= -1e-6 && v <= 1 + 1e-6)
    }
  }
})

test('divergence weights are monotonic in intensity of change (§8)', () => {
  for (let i = 1; i < 8; i++) {
    if (i === 6 || i === 7) continue // replaced and agent origin are both maximal
    assert.ok(
      DIVERGENCE_WEIGHT[i] > DIVERGENCE_WEIGHT[i - 1],
      `weight ${i} not above ${i - 1}`,
    )
  }
  assert.equal(DIVERGENCE_WEIGHT[0], 0)
  assert.equal(DIVERGENCE_WEIGHT[7], 1)
})
