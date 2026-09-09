// Generates the PWA PNG icons from the same mark as public/favicon.svg
// (dark rounded square + gradient "N"), with zero image dependencies.
// Run: node scripts/gen-icons.mjs   (writes into public/)
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BG = [0x0b, 0x0f, 0x17]
const A = [0x63, 0x66, 0xf1] // #6366f1
const B = [0x22, 0xd3, 0xee] // #22d3ee

// The "N" from favicon.svg (64-unit grid): left bar, right bar, diagonal band.
function inN(x, y) {
  if (x >= 18 && x <= 23 && y >= 18 && y <= 46) return true
  if (x >= 41 && x <= 46 && y >= 18 && y <= 46) return true
  if (x >= 23 && x <= 41) {
    const top = 18 + ((x - 23) * 20) / 18
    return y >= top && y <= top + 8
  }
  return false
}

function inRoundedSquare(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function render(size, { maskable = false, supersample = 3 } = {}) {
  const px = new Uint8Array(size * size * 4)
  const r = size * 0.22
  // Maskable icons get the safe-zone treatment: full-bleed background, mark at 80%.
  const scale = maskable ? 0.8 : 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0, inside = 0, gr = 0, gg = 0, gb = 0
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const fx = x + (sx + 0.5) / supersample
          const fy = y + (sy + 0.5) / supersample
          if (maskable || inRoundedSquare(fx, fy, size, r)) cov++
          const ux = ((fx - size / 2) / scale + size / 2) * (64 / size)
          const uy = ((fy - size / 2) / scale + size / 2) * (64 / size)
          if (inN(ux, uy)) {
            inside++
            const t = (fx + fy) / (2 * size)
            gr += A[0] + (B[0] - A[0]) * t
            gg += A[1] + (B[1] - A[1]) * t
            gb += A[2] + (B[2] - A[2]) * t
          }
        }
      }
      const n = supersample * supersample
      const i = (y * size + x) * 4
      if (!cov) { px[i + 3] = 0; continue }
      const alpha = cov / n
      const nf = inside / n
      const col = nf
        ? [gr / inside, gg / inside, gb / inside].map((c, k) => c * nf + BG[k] * (1 - nf))
        : BG
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = Math.round(alpha * 255)
    }
  }
  return px
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }], // iOS rounds corners itself
]
for (const [name, size, opts] of targets) {
  writeFileSync(path.join(OUT, name), png(size, render(size, opts)))
  console.log('wrote', name)
}
