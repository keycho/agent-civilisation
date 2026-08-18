/**
 * a/b frame differ for the §56 stages.
 *
 * The point is not "did the picture change" — it is "did it change ONLY where
 * the step under test should have touched it". A step that claims to be
 * emissive-only has to leave the golden-hour plates numerically alone, and
 * that is an assertion a screenshot pair cannot make on its own.
 *
 *   node tools/watch/abdiff.mjs <dirA> <dirB> [chunk ...]
 */
import { inflateSync } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** minimal PNG reader: 8-bit, non-interlaced, which is what playwright emits */
export function decode(path) {
  const d = readFileSync(path)
  let pos = 8
  let w = 0
  let h = 0
  let depth = 8
  let colour = 6
  const idat = []
  while (pos < d.length) {
    const len = d.readUInt32BE(pos)
    const type = d.toString('ascii', pos + 4, pos + 8)
    if (type === 'IHDR') {
      w = d.readUInt32BE(pos + 8)
      h = d.readUInt32BE(pos + 12)
      depth = d[pos + 16]
      colour = d[pos + 17]
      if (d[pos + 20] !== 0) throw new Error(`${path}: interlaced PNG unsupported`)
    } else if (type === 'IDAT') {
      idat.push(d.subarray(pos + 8, pos + 8 + len))
    }
    pos += 12 + len
  }
  if (depth !== 8) throw new Error(`${path}: bit depth ${depth} unsupported`)
  const ch = CHANNELS[colour]
  if (!ch) throw new Error(`${path}: colour type ${colour} unsupported`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(stride * h)
  let prev = Buffer.alloc(stride)
  let i = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[i++]
    const line = Buffer.from(raw.subarray(i, i + stride))
    i += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { w, h, ch, data: out }
}

// importing this module for `decode` must not run the differ
const SELF = import.meta.url.endsWith(process.argv[1]?.split('/').pop() ?? '\u0000')
const [dirA, dirB, ...rest] = SELF ? process.argv.slice(2) : []
if (SELF) {
const CHUNKS = rest.length
  ? rest
  : ['brooklyn-redhook', 'tokyo-kyojima', 'schiedam-havens', 'london-deptford', 'paris-ourcq']

console.log(`${dirA}  ->  ${dirB}`)
for (const chunk of CHUNKS) {
  const pa = `${dirA}/${chunk}.png`
  const pb = `${dirB}/${chunk}.png`
  if (!existsSync(pa) || !existsSync(pb)) {
    console.log(`${chunk.padEnd(18)} MISSING`)
    continue
  }
  const A = decode(pa)
  const B = decode(pb)
  if (A.w !== B.w || A.h !== B.h) {
    console.log(`${chunk.padEnd(18)} SIZE MISMATCH`)
    continue
  }
  const n = A.w * A.h
  let touched = 0
  let material = 0
  let sum = 0
  let brightened = 0
  for (let p = 0; p < n; p++) {
    const i = p * A.ch
    const j = p * B.ch
    const dr = B.data[j] - A.data[i]
    const dg = B.data[j + 1] - A.data[i + 1]
    const db = B.data[j + 2] - A.data[i + 2]
    const mag = Math.abs(dr) + Math.abs(dg) + Math.abs(db)
    if (mag > 0) touched++
    if (mag > 12) material++
    if (dr + dg + db > 12) brightened++
    sum += mag
  }
  const pct = (v) => `${((v / n) * 100).toFixed(2)}%`
  console.log(
    `${chunk.padEnd(18)} touched=${pct(touched)} material=${pct(material)} ` +
      `brighter=${pct(brightened)} mean|d|=${(sum / n / 3).toFixed(3)}`,
  )
}
}
