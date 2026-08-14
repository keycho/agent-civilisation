import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from 'three'

/**
 * §16.2's data texture. RGBA per texel, one texel per building:
 *
 *   r  progress    0..1, drives the construction reveal
 *   g  divergence  0..7, drives the palette lerp
 *   b  purpose     index into the palette
 *   a  condition   0..1, drives roughness and facade treatment
 *
 * A second, static texture carries what never changes after import — roof
 * tone, per-building jitter, era tint — so the mutable texture stays four
 * bytes wide and a state change is a single write.
 *
 * The year scrub (§8) is then just swapping the mutable texture's contents for
 * a snapshot's, with no geometry involved at all.
 */

const WIDTH = 256

export class BuildingDataTexture {
  readonly count: number
  readonly width: number
  readonly height: number
  readonly data: Uint8Array<ArrayBuffer>
  readonly staticData: Uint8Array<ArrayBuffer>
  readonly texture: DataTexture
  readonly staticTexture: DataTexture
  private dirty = true
  private staticDirty = true

  constructor(count: number) {
    this.count = count
    this.width = WIDTH
    this.height = Math.max(1, Math.ceil(count / WIDTH))
    const n = this.width * this.height * 4
    this.data = new Uint8Array(n)
    this.staticData = new Uint8Array(n)

    this.texture = makeTexture(this.data, this.width, this.height)
    this.staticTexture = makeTexture(this.staticData, this.width, this.height)

    // Every slot starts at progress 0 — "does not exist" — and the caller sets
    // the baseline stock to 1. That default is what makes the year scrub honest:
    // a slot allocated in 2038 reads as 0 in the 2031 snapshot, so restoring
    // that snapshot sinks the building back under the ground it was built on.
    // Defaulting to 1 instead leaves every future structure standing in the
    // past, which looks like a working scrub and is not one.
    for (let i = 0; i < count; i++) {
      this.data[i * 4 + 3] = 255
    }
  }

  setProgress(i: number, v: number): void {
    this.data[i * 4] = clampByte(v * 255)
    this.dirty = true
  }

  setDivergence(i: number, cls: number): void {
    this.data[i * 4 + 1] = clampByte(cls)
    this.dirty = true
  }

  setPurpose(i: number, purposeIndex: number): void {
    this.data[i * 4 + 2] = clampByte(purposeIndex)
    this.dirty = true
  }

  setCondition(i: number, v: number): void {
    this.data[i * 4 + 3] = clampByte(v * 255)
    this.dirty = true
  }

  set(i: number, progress: number, divergence: number, purposeIndex: number, condition: number): void {
    const o = i * 4
    this.data[o] = clampByte(progress * 255)
    this.data[o + 1] = clampByte(divergence)
    this.data[o + 2] = clampByte(purposeIndex)
    this.data[o + 3] = clampByte(condition * 255)
    this.dirty = true
  }

  /** roofTone: index into ROOF_TONES. jitter/era: 0..1. agentBuilt: silhouette flag. */
  setStatic(i: number, roofTone: number, jitter: number, era: number, agentBuilt: boolean): void {
    const o = i * 4
    this.staticData[o] = clampByte(roofTone)
    this.staticData[o + 1] = clampByte(jitter * 255)
    this.staticData[o + 2] = clampByte(era * 255)
    this.staticData[o + 3] = agentBuilt ? 255 : 0
    this.staticDirty = true
  }

  /** §21.6: the frame delta writes `data` straight, then says so. */
  markDirty(): void {
    this.dirty = true
  }

  /** Bulk replace for the event scrub — a snapshot is just the mutable half. */
  loadFrame(frame: Uint8Array): void {
    this.data.set(frame.subarray(0, this.data.length))
    this.dirty = true
  }

  snapshot(): Uint8Array {
    return this.data.slice(0, this.count * 4)
  }

  flush(): void {
    if (this.dirty) {
      this.texture.needsUpdate = true
      this.dirty = false
    }
    if (this.staticDirty) {
      this.staticTexture.needsUpdate = true
      this.staticDirty = false
    }
  }
}

function makeTexture(data: Uint8Array<ArrayBuffer>, w: number, h: number): DataTexture {
  const t = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType)
  t.magFilter = NearestFilter
  t.minFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}
