// Minimal animated-GIF (GIF89a) encoder for the blink export: no dependency.
//
// Palette: one GLOBAL palette for all frames (so colours don't flicker between epochs), built by
// popularity: every pixel's colour is reduced to 6 bits per channel, the 256 most common reduced
// colours become the palette, and every other colour maps to its nearest palette entry. The
// blink frames are mostly a grey ramp plus a few overlay colours, so 64 grey levels survive.
// Compression: standard GIF LZW (variable code size 9-12 bits, clear code when the table fills).

const BITS = 6
const SHIFT = 8 - BITS

function keyOf(r: number, g: number, b: number): number {
  return ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT)
}

function buildPalette(frames: ImageData[]): { palette: Uint8Array; index: (frame: ImageData) => Uint8Array } {
  const counts = new Map<number, number>()
  for (const f of frames) {
    const d = f.data
    for (let i = 0; i < d.length; i += 4) {
      const k = keyOf(d[i], d[i + 1], d[i + 2])
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k)
  const half = 1 << (SHIFT - 1)
  const rgb = keys.map((k) => [
    (((k >> (2 * BITS)) & 63) << SHIFT) | half,
    (((k >> BITS) & 63) << SHIFT) | half,
    ((k & 63) << SHIFT) | half,
  ])
  const palette = new Uint8Array(256 * 3)
  rgb.forEach((c, i) => palette.set(c, i * 3))
  const cache = new Int16Array(1 << (3 * BITS)).fill(-1)
  keys.forEach((k, i) => (cache[k] = i))
  const nearest = (k: number) => {
    const r = ((k >> (2 * BITS)) & 63) << SHIFT
    const g = ((k >> BITS) & 63) << SHIFT
    const b = (k & 63) << SHIFT
    let best = 0
    let bd = Infinity
    rgb.forEach(([pr, pg, pb], i) => {
      const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    })
    cache[k] = best
    return best
  }
  const index = (f: ImageData) => {
    const d = f.data
    const out = new Uint8Array(d.length / 4)
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const k = keyOf(d[i], d[i + 1], d[i + 2])
      const c = cache[k]
      out[j] = c >= 0 ? c : nearest(k)
    }
    return out
  }
  return { palette, index }
}

/** GIF LZW, min code size 8, packed LSB-first into 255-byte sub-blocks. */
function lzw(indices: Uint8Array, out: number[]): void {
  const MIN = 8
  const CLEAR = 1 << MIN
  const EOI = CLEAR + 1
  let size = MIN + 1
  let next = EOI + 1
  let table = new Map<number, number>()
  const bytes: number[] = []
  let acc = 0
  let nbits = 0
  const emit = (code: number) => {
    acc |= code << nbits
    nbits += size
    while (nbits >= 8) {
      bytes.push(acc & 0xff)
      acc >>>= 8
      nbits -= 8
    }
  }
  emit(CLEAR)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const key = (prefix << 8) | k
    const hit = table.get(key)
    if (hit !== undefined) {
      prefix = hit
      continue
    }
    emit(prefix)
    if (next === 4096) {
      emit(CLEAR)
      table = new Map()
      size = MIN + 1
      next = EOI + 1
    } else {
      if (next >= 1 << size) size++
      table.set(key, next++)
    }
    prefix = k
  }
  emit(prefix)
  emit(EOI)
  if (nbits > 0) bytes.push(acc & 0xff)
  out.push(MIN)
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i)
    out.push(n)
    for (let j = 0; j < n; j++) out.push(bytes[i + j])
  }
  out.push(0)
}

/** Encode same-sized RGBA frames as a looping GIF; delay in milliseconds per frame. */
export function encodeGif(frames: ImageData[], delayMs: number): Blob {
  const w = frames[0].width
  const h = frames[0].height
  const { palette, index } = buildPalette(frames)
  const out: number[] = []
  const u16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff)
  for (const c of 'GIF89a') out.push(c.charCodeAt(0))
  u16(w)
  u16(h)
  out.push(0xf7, 0, 0) // global colour table, 8 bits/channel resolution, 256 entries
  for (const v of palette) out.push(v)
  // loop forever (NETSCAPE2.0 application extension)
  out.push(0x21, 0xff, 0x0b)
  for (const c of 'NETSCAPE2.0') out.push(c.charCodeAt(0))
  out.push(0x03, 0x01, 0, 0, 0)
  const cs = Math.max(2, Math.round(delayMs / 10))
  for (const f of frames) {
    out.push(0x21, 0xf9, 0x04, 0x00) // graphic control: no transparency, no disposal
    u16(cs)
    out.push(0, 0)
    out.push(0x2c)
    u16(0)
    u16(0)
    u16(w)
    u16(h)
    out.push(0) // no local colour table, not interlaced
    lzw(index(f), out)
  }
  out.push(0x3b)
  return new Blob([new Uint8Array(out)], { type: 'image/gif' })
}
