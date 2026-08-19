import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  BoxGeometry,
} from 'three'

/**
 * §69.3: cleared ground must read as cleared.
 *
 * Until now a demolished lot rendered as nothing — the building stopped being
 * drawn and the substrate showed through, identical to ground that never held
 * anything. That is the model's best story told as its worst frame: a city
 * being taken apart and rebuilt looks like a city that was never built. §57.2
 * asked for a rubble tint persisting a generation and nothing shipped.
 *
 * A cleared lot now says what happened to it, in three registers that read at
 * three distances:
 *
 *   - the SLAB, the footprint itself as a flat pad in a rubble tone. This is
 *     what carries at city framing: the fabric keeps its plan even where the
 *     mass is gone, so a cleared block reads as a block, not as a hole.
 *   - the HOARDING, a line around the perimeter at head height. This is what
 *     carries at block framing — a site is fenced, and the fence is the one
 *     thing that says a lot is held rather than abandoned.
 *   - the RUBBLE, a few low blocks inside the footprint. This is what carries
 *     at street framing, and it is deterministic per building so a lot does
 *     not reshuffle its debris every time the set is rebuilt.
 *
 * §40.1's ghost already remembers what stood here — this is the ground the
 * ghost stands on, and the two are meant to be read together.
 *
 * The whole set is rebuilt when the cleared set changes, which is on
 * demolition and on a build that reclaims a lot. That is rare enough that
 * three rebuilt buffers cost nothing, and it keeps the geometry exact — real
 * footprints rather than a box fitted to them.
 */

export interface ClearedLot {
  footprint: ReadonlyArray<readonly [number, number]>
  /** NAP ground level the building stood on */
  groundM: number
}

/** deterministic per-lot jitter, so debris does not move between rebuilds */
function hashed(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

const RUBBLE_PER_LOT = 4
const HOARDING_H = 1.9
const MAX_RUBBLE = 4096

export class ClearedGround {
  readonly group = new Group()
  private slab: Mesh
  private hoarding: LineSegments
  private rubble: InstancedMesh
  private dummy = new Object3D()
  private lots: ReadonlyArray<ClearedLot>
  private heightAt: (x: number, y: number) => number
  private shown = new Set<number>()

  constructor(
    lots: ReadonlyArray<ClearedLot>,
    heightAt: (x: number, y: number) => number,
    tone: string,
  ) {
    this.lots = lots
    this.heightAt = heightAt

    const slabMaterial = new MeshLambertMaterial({
      color: new Color(tone),
      side: DoubleSide,
      // the pad sits a few centimetres over the substrate; polygon offset keeps
      // it from fighting the ground it is lying on at grazing angles
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.slab = new Mesh(new BufferGeometry(), slabMaterial)
    this.slab.receiveShadow = true
    this.slab.frustumCulled = false
    this.group.add(this.slab)

    /**
     * The hoarding is drawn in the CHROME register, not in the rubble tone.
     *
     * Tone-on-tone was the first cut and the a/b pair showed why it fails: §63's
     * night desaturation flattens a warm grey outline into the warm grey ground
     * it is drawn on, and the layer rendered correctly while reading as nothing.
     * Cream at low alpha is how this product annotates the world everywhere else
     * — the §63.4 site readouts, the §40.1 ghost — and a cleared lot is exactly
     * an annotation: a line saying the plan of this block outlived its mass.
     */
    this.hoarding = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({
        color: new Color('#e6ddc6'),
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      }),
    )
    this.hoarding.frustumCulled = false
    this.group.add(this.hoarding)

    this.rubble = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshLambertMaterial({ color: new Color(tone) }),
      MAX_RUBBLE,
    )
    this.rubble.count = 0
    this.rubble.castShadow = true
    this.rubble.frustumCulled = false
    this.group.add(this.rubble)
  }

  /** how many lots are currently drawn as cleared */
  get count(): number {
    return this.shown.size
  }

  /**
   * `ids` are indices into the lot list. A no-op when the set has not changed,
   * because this is called from the frame path and the set changes on
   * demolition rather than on frames.
   */
  show(ids: Set<number>): void {
    if (ids.size === this.shown.size && [...ids].every((i) => this.shown.has(i))) return
    this.shown = new Set(ids)
    this.rebuild()
  }

  private rebuild(): void {
    const pos: number[] = []
    const nor: number[] = []
    const lines: number[] = []
    let rubbleAt = 0

    for (const i of this.shown) {
      const lot = this.lots[i]
      if (!lot || lot.footprint.length < 3) continue
      const fp = lot.footprint
      const base = this.heightAt(fp[0][0], fp[0][1]) + lot.groundM + 0.06

      // the slab: a fan from the footprint's centroid. Real footprints are
      // simple and near-convex, and a flat pad is forgiving of the artefact a
      // fan leaves on the rare concave one — a box fitted to the bounds would
      // lose the plan, which is the whole point of drawing it.
      let cx = 0
      let cy = 0
      for (const p of fp) {
        cx += p[0]
        cy += p[1]
      }
      cx /= fp.length
      cy /= fp.length
      for (let k = 0; k < fp.length; k++) {
        const a = fp[k]
        const b = fp[(k + 1) % fp.length]
        pos.push(cx, base, -cy, a[0], base, -a[1], b[0], base, -b[1])
        nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0)
        // the hoarding: the perimeter at head height, plus a post at each corner
        lines.push(a[0], base + HOARDING_H, -a[1], b[0], base + HOARDING_H, -b[1])
        lines.push(a[0], base, -a[1], a[0], base + HOARDING_H, -a[1])
      }

      // the rubble: a few low blocks inside the footprint's own bounds
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = -Infinity
      for (const p of fp) {
        if (p[0] < x0) x0 = p[0]
        if (p[0] > x1) x1 = p[0]
        if (p[1] < y0) y0 = p[1]
        if (p[1] > y1) y1 = p[1]
      }
      for (let r = 0; r < RUBBLE_PER_LOT && rubbleAt < MAX_RUBBLE; r++) {
        // biased toward the middle so debris does not sit on the hoarding line
        const u = 0.25 + hashed(i, r * 2 + 1) * 0.5
        const v = 0.25 + hashed(i, r * 2 + 2) * 0.5
        const w = 0.9 + hashed(i, r + 40) * 2.2
        const h = 0.35 + hashed(i, r + 70) * 0.8
        this.dummy.position.set(x0 + (x1 - x0) * u, base + h / 2, -(y0 + (y1 - y0) * v))
        this.dummy.rotation.set(0, hashed(i, r + 90) * Math.PI, 0)
        this.dummy.scale.set(w, h, w * (0.6 + hashed(i, r + 110) * 0.7))
        this.dummy.updateMatrix()
        this.rubble.setMatrixAt(rubbleAt++, this.dummy.matrix)
      }
    }

    const slabGeo = new BufferGeometry()
    slabGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    slabGeo.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
    this.slab.geometry.dispose()
    this.slab.geometry = slabGeo

    const lineGeo = new BufferGeometry()
    lineGeo.setAttribute('position', new BufferAttribute(new Float32Array(lines), 3))
    this.hoarding.geometry.dispose()
    this.hoarding.geometry = lineGeo

    this.rubble.count = rubbleAt
    this.rubble.instanceMatrix.needsUpdate = true
  }
}
