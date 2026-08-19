/**
 * §68: do the layers agree about where the city is?
 *
 * A production paris frame showed pixel agents, scaffolds and worksite lights
 * standing on bare plate ground with the building geometry off in a corner
 * behind a hard diagonal edge. The camera was aiming correctly at the measured
 * fabric box — which is why the §65 fuzz passes — so the box and the buildings
 * disagree, and everything else in the world is in a third opinion or a fourth.
 *
 * This prints, per chunk, in WORLD space:
 *
 *   (a) the rendered building batch geometry's bounding box
 *   (b) the fabric box the camera derives from
 *   (c) the agent sprites and the worksite lights
 *   (d) the plate mesh
 *
 * Measured off what is actually in the scene graph — geometry bounding boxes
 * transformed by their own world matrices — rather than off the seed the
 * geometry was generated from. §21.4's rule: assert against what was emitted.
 *
 *   node tools/watch/frames-of-reference.mjs [chunk...]
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const CHUNKS = process.argv.slice(2)
const OUT = 'tools/watch/evidence/68'
const ORIGIN = process.env.CIV_ORIGIN ?? 'http://127.0.0.1:5173'
const SERVER_BASE = process.env.CIV_SERVER_BASE ?? 'ws://127.0.0.1:8820/ws'

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

async function measure(chunk) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log(`  PAGE EXCEPTION (${chunk})`, e.message))
  await page.goto(
    `${ORIGIN}/?chunk=${chunk}&server=${encodeURIComponent(`${SERVER_BASE}/${chunk}`)}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.civ != null, null, { timeout: 120000 })
  /**
   * WAIT FOR THE THINGS UNDER TEST TO EXIST.
   *
   * The first run of this reported "none on the wire yet" for both agents and
   * worksites on every chunk and drew a conclusion anyway. The frame being
   * diagnosed has agents, scaffolds and worksite lights in it; measuring a
   * scene with none of those cannot say anything about where they are.
   */
  await page
    .waitForFunction(
      () => window.civ.presence.positions().length > 0 && window.civ.observer.sites().length > 0,
      null,
      { timeout: 90000 },
    )
    .catch(() => {})
  // and a beat for the scaffold and the lights to be built for those sites
  await page.waitForTimeout(4000)

  const out = await page.evaluate(() => {
    const civ = window.civ
    const { Box3, Vector3 } = civ.three
    civ.cityRoot.updateMatrixWorld(true)

    /**
     * A layer's bounds in world space.
     *
     * INSTANCED MESHES NEED THEIR INSTANCES. A first version took
     * `geometry.computeBoundingBox()` and pushed it through the object's world
     * matrix, which for an InstancedMesh is the bounds of the ONE unit box the
     * instances are copies of — so every instanced layer (agents, lamps,
     * traffic, trees, scaffold) reported a metre-wide box at the origin and
     * looked catastrophically displaced when it was simply not being measured.
     * The per-instance matrices are where those layers actually are.
     */
    const worldBox = (obj) => {
      const box = new Box3()
      let found = false
      const v = new Vector3()
      const m = new civ.three.Matrix4()
      obj.traverse((o) => {
        const g = o.geometry
        if (!g?.attributes?.position || g.attributes.position.count === 0) return
        g.computeBoundingBox()
        if (!g.boundingBox) return
        if (o.isInstancedMesh) {
          const live = o.count ?? 0
          if (live === 0) return
          for (let i = 0; i < live; i++) {
            o.getMatrixAt(i, m)
            m.premultiply(o.matrixWorld)
            const b = g.boundingBox.clone().applyMatrix4(m)
            if (!Number.isFinite(b.min.x)) continue
            box.union(b)
            found = true
          }
          return
        }
        if (o.isPoints || o.isSprite || o.isLine || o.isMesh) {
          const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld)
          if (!Number.isFinite(b.min.x)) return
          box.union(b)
          found = true
        }
        void v
      })
      return found ? box : null
    }
    const fmt = (b) =>
      b === null
        ? null
        : {
            x: [+b.min.x.toFixed(1), +b.max.x.toFixed(1)],
            y: [+b.min.y.toFixed(1), +b.max.y.toFixed(1)],
            z: [+b.min.z.toFixed(1), +b.max.z.toFixed(1)],
            centre: [+((b.min.x + b.max.x) / 2).toFixed(1), +((b.min.z + b.max.z) / 2).toFixed(1)],
            half: [+((b.max.x - b.min.x) / 2).toFixed(1), +((b.max.z - b.min.z) / 2).toFixed(1)],
          }

    // (a) the rendered building batch — the static baseline mesh and whatever
    // the sim has built since, measured separately so a displaced baseline and
    // a displaced agent build can be told apart
    const meshes = []
    civ.buildings.group.traverse((o) => {
      if (o.geometry?.attributes?.position?.count) meshes.push(o)
    })
    const batch = { total: fmt(worldBox(civ.buildings.group)), parts: [] }
    for (const m of meshes) {
      m.geometry.computeBoundingBox()
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)
      batch.parts.push({ verts: m.geometry.attributes.position.count, box: fmt(b) })
    }

    // (b) the fabric box the camera is anchored on
    const c = civ.plate.city
    const fabric = {
      centre: [+c.world[0].toFixed(1), +c.world[1].toFixed(1)],
      half: [+c.half[0].toFixed(1), +c.half[1].toFixed(1)],
      x: [+(c.world[0] - c.half[0]).toFixed(1), +(c.world[0] + c.half[0]).toFixed(1)],
      z: [+(c.world[1] - c.half[1]).toFixed(1), +(c.world[1] + c.half[1]).toFixed(1)],
      localCentre: c.centre,
    }

    // (c) what is standing on the ground: the agents and the worksites
    const pts = (list) => {
      if (!list.length) return null
      let x0 = Infinity
      let x1 = -Infinity
      let z0 = Infinity
      let z1 = -Infinity
      for (const [x, z] of list) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (z < z0) z0 = z
        if (z > z1) z1 = z
      }
      return {
        n: list.length,
        x: [+x0.toFixed(1), +x1.toFixed(1)],
        z: [+z0.toFixed(1), +z1.toFixed(1)],
        centre: [+((x0 + x1) / 2).toFixed(1), +((z0 + z1) / 2).toFixed(1)],
        sample: list.slice(0, 3).map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]),
      }
    }
    // agents come off the wire in chunk-local metres; pointAt is the one
    // conversion the whole client agrees on, so it is what this uses
    const agents = pts(
      civ.presence.positions().map((a) => {
        const p = civ.pointAt(a.x, a.y)
        return [p.x, p.z]
      }),
    )
    const sites = pts(
      civ.observer.sites().map((s) => {
        const p = civ.pointAt(s.footprint[0][0], s.footprint[0][1])
        return [p.x, p.z]
      }),
    )

    // (d) the plate, and every other layer as its own opinion — each is
    // generated from the same seed by a different path
    const named = {}
    for (const child of civ.cityRoot.children) {
      const b = worldBox(child)
      if (b) named[child.name || `${child.type}#${child.id}`] = fmt(b)
    }

    return {
      batch,
      fabric,
      agents,
      sites,
      plateHalfExtent: civ.plate.halfExtent,
      groundY: civ.plate.groundY,
      layers: named,
      counts: {
        agents: civ.presence.positions().length,
        sites: civ.observer.sites().length,
      },
      link: document.getElementById('link')?.textContent ?? '',
    }
  })

  await page.screenshot({ path: `${OUT}/${chunk}.png` })
  await page.close()
  return out
}

const index = await (await fetch(`${ORIGIN}/world/index.json`)).json()
const list = CHUNKS.length ? CHUNKS : index.chunks.map((c) => c.id)

const all = {}
const verdicts = []
for (const chunk of list) {
  const m = await measure(chunk)
  all[chunk] = m
  const b = m.batch.total
  const f = m.fabric
  console.log(`\n${chunk}`)
  console.log(`  (a) building batch   x ${JSON.stringify(b?.x)}  z ${JSON.stringify(b?.z)}  centre ${JSON.stringify(b?.centre)}  half ${JSON.stringify(b?.half)}`)
  console.log(`  (b) fabric box       x ${JSON.stringify(f.x)}  z ${JSON.stringify(f.z)}  centre ${JSON.stringify(f.centre)}  half ${JSON.stringify(f.half)}`)
  console.log(`  (c) agents           ${m.agents ? `n=${m.agents.n}  x ${JSON.stringify(m.agents.x)}  z ${JSON.stringify(m.agents.z)}` : 'none on the wire yet'}`)
  console.log(`      worksites        ${m.sites ? `n=${m.sites.n}  x ${JSON.stringify(m.sites.x)}  z ${JSON.stringify(m.sites.z)}` : 'none open yet'}`)
  console.log(`  (d) plate half-extent ${m.plateHalfExtent.toFixed(1)}   groundY ${m.groundY.toFixed(2)}`)
  for (const [name, box] of Object.entries(m.layers)) {
    console.log(`      ${name.padEnd(22)} x ${JSON.stringify(box.x).padEnd(18)} z ${JSON.stringify(box.z)}`)
  }
  console.log(`      link ${m.link} · ${JSON.stringify(m.counts)}`)
  if (b) {
    const dx = Math.max(Math.abs(b.x[0] - f.x[0]), Math.abs(b.x[1] - f.x[1]))
    const dz = Math.max(Math.abs(b.z[0] - f.z[0]), Math.abs(b.z[1] - f.z[1]))
    const agree = dx <= 6 && dz <= 6
    verdicts.push({ chunk, dx, dz, agree })
    console.log(`  => batch vs fabric: worst edge disagreement ${dx.toFixed(1)} m in x, ${dz.toFixed(1)} m in z — ${agree ? 'AGREE' : 'DISAGREE'}`)
  }
}

console.log('\n§68 summary')
for (const v of verdicts) {
  console.log(`  ${v.agree ? 'ok  ' : 'FAIL'} ${v.chunk.padEnd(22)} dx ${v.dx.toFixed(1)} m  dz ${v.dz.toFixed(1)} m`)
}
await writeFile(`${OUT}/frames.json`, JSON.stringify(all, null, 2))
await browser.close()
process.exit(verdicts.every((v) => v.agree) ? 0 : 1)
