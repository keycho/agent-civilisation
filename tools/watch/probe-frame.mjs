/**
 * §65: where is the city, actually?
 *
 * The operator's evidence: the §63.4 world readouts spread across the whole
 * black field, local x roughly -280..+270 and y -260..+213, while the rendered
 * geometry sits in the bottom-right corner. Two transforms that disagree.
 *
 * So this measures, in world space and from the objects themselves rather than
 * from any metadata:
 *
 *   - the bounding box of every rendered layer, separately, so the one that
 *     disagrees names itself
 *   - the camera target, and where the local-frame origin actually lands
 *   - the box `frameThePlate` and §62's target clamp are derived from
 *
 * Prints all of them. If the geometry's centre and the camera target differ,
 * every reset aims correctly at the wrong point and orbit sweeps empty ground,
 * which is precisely what §62's per-frame clamping could not repair — the
 * clamps were right about a box that was not where the city is.
 *
 *   node tools/watch/probe-frame.mjs [chunk]
 */
import { chromium } from 'playwright'

const CHUNK = process.argv[2] ?? 'schiedam-havens'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER = process.env.CIV_SERVER ?? `ws://127.0.0.1:8820/ws/${CHUNK}`

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const [VW, VH] = (process.env.CIV_VIEWPORT ?? '1280x800').split('x').map(Number)
const page = await browser.newPage({ viewport: { width: VW, height: VH } })
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message))
await page.goto(`${ORIGIN}/?chunk=${CHUNK}&server=${encodeURIComponent(SERVER)}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
/**
 * NOTHING is touched here beyond dismissing the explainer. Every previous
 * probe called `plate.home(true)` first, which snaps the camera to a framing
 * it computes — so it could only ever measure whether that framing is
 * self-consistent, never whether the camera a stranger actually gets is
 * pointed at the city. The operator's frame is the untouched first load.
 */
await page.evaluate(() => document.getElementById('watchBtn')?.click())
await page.waitForTimeout(Number(process.env.CIV_SETTLE ?? 16000))

const m = await page.evaluate(() => {
  const civ = window.civ
  const THREE = civ.three
  const box = (obj) => {
    const b = new THREE.Box3()
    let any = false
    obj.traverseVisible((o) => {
      if (!o.isMesh && !o.isLineSegments && !o.isPoints) return
      if (!o.geometry) return
      o.geometry.computeBoundingBox?.()
      if (!o.geometry.boundingBox) return
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
      if (!isFinite(bb.min.x) || !isFinite(bb.max.x)) return
      b.union(bb)
      any = true
    })
    if (!any) return null
    const c = b.getCenter(new THREE.Vector3())
    const s = b.getSize(new THREE.Vector3())
    return {
      min: [+b.min.x.toFixed(1), +b.min.y.toFixed(1), +b.min.z.toFixed(1)],
      max: [+b.max.x.toFixed(1), +b.max.y.toFixed(1), +b.max.z.toFixed(1)],
      centre: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)],
      size: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)],
    }
  }
  civ.cityRoot.updateMatrixWorld(true)

  // per-layer, so whichever layer disagrees names itself
  const layers = {}
  for (const child of civ.cityRoot.children) {
    const name = child.name || child.type
    const b = box(child)
    if (b) layers[name] = b
  }

  // where the local frame's own origin lands, through the same helper the
  // §63.4 readouts and every flyTo target use
  const o = civ.pointAt(0, 0)
  const corner = civ.pointAt(civ.plate.halfExtent, civ.plate.halfExtent)

  return {
    whole: box(civ.cityRoot),
    layers,
    target: [+civ.rig.target.x.toFixed(1), +civ.rig.target.y.toFixed(1), +civ.rig.target.z.toFixed(1)],
    pointAtOrigin: [+o.x.toFixed(1), +o.y.toFixed(1), +o.z.toFixed(1)],
    pointAtCorner: [+corner.x.toFixed(1), +corner.y.toFixed(1), +corner.z.toFixed(1)],
    halfExtent: civ.plate.halfExtent,
    city: civ.plate.city,
    limits: {
      panHalfX: civ.rig.limits.panHalfX,
      panHalfZ: civ.rig.limits.panHalfZ,
      maxDistance: Math.round(civ.rig.limits.maxDistance),
    },
    cityRootPosition: [
      +civ.cityRoot.position.x.toFixed(1),
      +civ.cityRoot.position.y.toFixed(1),
      +civ.cityRoot.position.z.toFixed(1),
    ],
    // and the readouts, in the same space, to test the operator's other point
    marks: civ.siteMarkPoints ? civ.siteMarkPoints() : null,
    /**
     * Where each thing lands ON SCREEN, which is the operator's actual
     * complaint: the plate covering the frame while the city sits in a corner
     * of it is a different fault from the camera being aimed off the plate.
     */
    screen: (() => {
      const cam = civ.rig.camera
      cam.updateMatrixWorld(true)
      const bounds = (pts) => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const [x, y, z] of pts) {
          const v = new THREE.Vector3(x, y, z).project(cam)
          minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x)
          minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
        }
        return [ +minX.toFixed(2), +maxX.toFixed(2), +minY.toFixed(2), +maxY.toFixed(2) ]
      }
      const h = civ.plate.halfExtent
      const gy = civ.plate.groundY
      const plate = bounds([[-h, gy, -h], [h, gy, -h], [h, gy, h], [-h, gy, h]])
      /**
       * The FABRIC, not the scene box. The scene includes the road meshes,
       * which run out to the plate edge and past it by design, so projecting
       * the scene box measures how well the roads are framed rather than how
       * well the city is.
       */
      const c = civ.plate.city
      const [wx, wz] = c.world
      const [hx, hz] = c.half
      const geo = bounds([
        [wx - hx, gy, wz - hz], [wx + hx, gy, wz - hz],
        [wx + hx, gy, wz + hz], [wx - hx, gy, wz + hz],
      ])
      return { plate, geo }
    })(),
  }
})

const fmt = (b) =>
  b
    ? `centre (${b.centre[0]}, ${b.centre[2]})  size ${b.size[0]} x ${b.size[2]}  ` +
      `x[${b.min[0]}, ${b.max[0]}] z[${b.min[2]}, ${b.max[2]}]`
    : 'empty'

console.log(`# §65 frame probe — ${CHUNK} at ${VW}x${VH}`)
console.log(`  rendered geometry     ${fmt(m.whole)}`)
for (const [name, b] of Object.entries(m.layers)) {
  console.log(`    ${name.padEnd(18)} ${fmt(b)}`)
}
console.log(`  cityRoot.position     (${m.cityRootPosition.join(', ')})`)
console.log(`  camera target         (${m.target[0]}, ${m.target[2]})`)
console.log(`  pointAt(0, 0)         (${m.pointAtOrigin[0]}, ${m.pointAtOrigin[2]})`)
console.log(
  `  pointAt(+${m.halfExtent.toFixed(0)}, +${m.halfExtent.toFixed(0)})   (${m.pointAtCorner[0]}, ${m.pointAtCorner[2]})`,
)
console.log(
  `  §62 target clamp      ±${m.limits.panHalfX.toFixed(0)} x ±${m.limits.panHalfZ.toFixed(0)}  (maxDistance ${m.limits.maxDistance})`,
)
console.log(
  `\n  plate on screen       x[${m.screen.plate[0]}, ${m.screen.plate[1]}]  y[${m.screen.plate[2]}, ${m.screen.plate[3]}]`,
)
console.log(
  `  fabric on screen      x[${m.screen.geo[0]}, ${m.screen.geo[1]}]  y[${m.screen.geo[2]}, ${m.screen.geo[3]}]   (viewport is [-1, 1])`,
)
/**
 * The operator's second point: the §63.4 readouts should attach to parcels,
 * not float. Their coordinates come from event x/y, which is the same local
 * frame the footprints are in — so "in empty space" would mean the world layer
 * and the geometry disagree. Measure it: how many marks fall inside the
 * fabric's own bounding box.
 */
if (m.marks && m.marks.length) {
  const hx = m.city.half[0]
  const hy = m.city.half[1]
  const cx = m.city.centre[0]
  const cy = m.city.centre[1]
  const inside = m.marks.filter(
    (k) => Math.abs(k.local[0] - cx) <= hx + 1 && Math.abs(k.local[1] - cy) <= hy + 1,
  ).length
  console.log(
    `\n  §63.4 readouts        ${inside}/${m.marks.length} inside the fabric box ` +
      `(centre ${cx.toFixed(0)}, ${cy.toFixed(0)} half ${hx.toFixed(0)} x ${hy.toFixed(0)})`,
  )
  for (const k of m.marks.slice(0, 4)) {
    console.log(`    ${k.id.padEnd(28)} local (${k.local[0]}, ${k.local[1]})  world (${k.world.join(', ')})`)
  }
}
{
  const dx = m.city.world[0] - m.target[0]
  const dz = m.city.world[1] - m.target[2]
  const off = Math.hypot(dx, dz)
  console.log(
    `\n  OFFSET fabric centre vs camera target: ${off.toFixed(1)} m  (dx ${dx.toFixed(1)}, dz ${dz.toFixed(1)})`,
  )
  console.log(
    `  ${off < 20 ? 'the camera is aimed at the city' : 'THE CAMERA IS AIMED AT EMPTY GROUND'}`,
  )
}
await browser.close()
