import { deflateSync } from 'node:zlib'

function chunk(type, payload) {
  const bytes = Buffer.concat([Buffer.from(type), payload])
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  const header = Buffer.alloc(4),
    trailer = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([header, bytes, trailer])
}

/** Deterministic noisy pixels exercise real large native image records without external assets. */
export function syntheticNativeProbeImage() {
  const size = 384,
    pixels = Buffer.alloc((size * 3 + 1) * size),
    header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  let seed = 1234567
  for (let row = 0; row < size; row++) {
    for (let column = 1; column <= size * 3; column++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      pixels[row * (size * 3 + 1) + column] = seed >>> 24
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
