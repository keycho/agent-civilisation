/**
 * Just enough GeoTIFF to read a PDOK AHN coverage, which is a strip-per-row
 * float32 image with deflate compression and the floating-point predictor.
 *
 * Not a general reader and not trying to be. The alternative was a Python
 * environment with GDAL in it for one array of ground heights, and the whole
 * point of §21.5 is that the direct path here is short.
 */
import { inflateSync } from 'node:zlib'

export interface Raster {
  width: number
  height: number
  /** row-major, `width * height`, NaN where the source has no data */
  values: Float32Array
  /** world coordinates of the top-left corner of pixel (0,0) */
  originX: number
  originY: number
  /** metres per pixel; y decreases down the image */
  scaleX: number
  scaleY: number
}

const TAG = {
  width: 256,
  height: 257,
  bitsPerSample: 258,
  compression: 259,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  predictor: 317,
  sampleFormat: 339,
  pixelScale: 33550,
  tiePoint: 33922,
  noData: 42113,
} as const

interface Entry {
  type: number
  count: number
  offset: number
  inline: Buffer
}

export function readGeoTiff(buf: Buffer): Raster {
  const little = buf.toString('latin1', 0, 2) === 'II'
  if (!little && buf.toString('latin1', 0, 2) !== 'MM') throw new Error('not a TIFF')
  const u16 = (o: number) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o: number) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const f64 = (o: number) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o))
  if (u16(2) !== 42) throw new Error('BigTIFF is not supported')

  const ifd = u32(4)
  const count = u16(ifd)
  const entries = new Map<number, Entry>()
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    entries.set(u16(e), {
      type: u16(e + 2),
      count: u32(e + 4),
      offset: u32(e + 8),
      inline: buf.subarray(e + 8, e + 12),
    })
  }

  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 }
  function nums(tag: number): number[] {
    const e = entries.get(tag)
    if (!e) return []
    const size = SIZE[e.type] ?? 1
    const total = size * e.count
    const at = total <= 4 ? -1 : e.offset
    const out: number[] = []
    for (let i = 0; i < e.count; i++) {
      const o = (at < 0 ? 0 : at) + i * size
      const src = at < 0 ? e.inline : buf
      switch (e.type) {
        case 1:
        case 2:
          out.push(src.readUInt8(o))
          break
        case 3:
          out.push(little ? src.readUInt16LE(o) : src.readUInt16BE(o))
          break
        case 4:
          out.push(little ? src.readUInt32LE(o) : src.readUInt32BE(o))
          break
        case 5:
          out.push(
            (little ? src.readUInt32LE(o) : src.readUInt32BE(o)) /
              (little ? src.readUInt32LE(o + 4) : src.readUInt32BE(o + 4)),
          )
          break
        case 12:
          out.push(f64(o))
          break
        default:
          out.push(0)
      }
    }
    return out
  }

  const width = nums(TAG.width)[0]
  const height = nums(TAG.height)[0]
  const bits = nums(TAG.bitsPerSample)[0] ?? 32
  const samples = nums(TAG.samplesPerPixel)[0] ?? 1
  const format = nums(TAG.sampleFormat)[0] ?? 1
  const compression = nums(TAG.compression)[0] ?? 1
  const predictor = nums(TAG.predictor)[0] ?? 1
  const rowsPerStrip = nums(TAG.rowsPerStrip)[0] ?? height
  const offsets = nums(TAG.stripOffsets)
  const counts = nums(TAG.stripByteCounts)

  if (bits !== 32 || format !== 3 || samples !== 1) {
    throw new Error(`expected single-band float32, got ${samples}x${bits}-bit format ${format}`)
  }
  if (compression !== 1 && compression !== 8 && compression !== 32946) {
    throw new Error(`unsupported compression ${compression}`)
  }

  const noDataTag = entries.get(TAG.noData)
  const noDataText = noDataTag
    ? buf
        .subarray(noDataTag.offset, noDataTag.offset + noDataTag.count)
        .toString('latin1')
        .replace(/\0+$/, '')
    : ''
  const noData = noDataText ? Number(noDataText) : Number.NaN

  const values = new Float32Array(width * height)
  const rowBytes = width * 4
  for (let s = 0; s < offsets.length; s++) {
    const raw = buf.subarray(offsets[s], offsets[s] + counts[s])
    const data = compression === 1 ? Buffer.from(raw) : Buffer.from(inflateSync(raw))
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip)
    for (let r = 0; r < rows; r++) {
      const row = data.subarray(r * rowBytes, (r + 1) * rowBytes)
      const out = predictor === 3 ? undoFloatPredictor(row, width, little) : row
      const y = s * rowsPerStrip + r
      for (let x = 0; x < width; x++) {
        const v = little ? out.readFloatLE(x * 4) : out.readFloatBE(x * 4)
        values[y * width + x] = v === noData || !Number.isFinite(v) ? Number.NaN : v
      }
    }
  }

  const scale = nums(TAG.pixelScale)
  const tie = nums(TAG.tiePoint)
  return {
    width,
    height,
    values,
    originX: tie[3] ?? 0,
    originY: tie[4] ?? 0,
    scaleX: scale[0] ?? 1,
    scaleY: scale[1] ?? 1,
  }
}

/**
 * TIFF predictor 3. Bytes are horizontally differenced and then split into
 * planes, most significant byte first, so a naive read produces plausible
 * garbage rather than an error — which is exactly the failure shape §18.3 is
 * about, and how this was caught: the first decode gave a 1e38 metre relief.
 */
function undoFloatPredictor(row: Buffer, width: number, little: boolean): Buffer {
  const acc = Buffer.from(row)
  for (let i = 1; i < acc.length; i++) acc[i] = (acc[i] + acc[i - 1]) & 0xff
  const out = Buffer.allocUnsafe(acc.length)
  for (let i = 0; i < width; i++) {
    for (let k = 0; k < 4; k++) {
      out[i * 4 + (little ? 3 - k : k)] = acc[k * width + i]
    }
  }
  return out
}

/** Bilinear sample in world coordinates; NaN if any corner has no data. */
export function sampleAt(r: Raster, x: number, y: number): number {
  const px = (x - r.originX) / r.scaleX
  const py = (r.originY - y) / r.scaleY
  const i = Math.floor(px)
  const j = Math.floor(py)
  if (i < 0 || j < 0 || i >= r.width - 1 || j >= r.height - 1) return Number.NaN
  const fx = px - i
  const fy = py - j
  const a = r.values[j * r.width + i]
  const b = r.values[j * r.width + i + 1]
  const c = r.values[(j + 1) * r.width + i]
  const d = r.values[(j + 1) * r.width + i + 1]
  if (!Number.isFinite(a + b + c + d)) return Number.NaN
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}
