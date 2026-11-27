// BMP decoder (uncompressed BI_RGB: 1/4/8 bit indexed, 24 bit; 32 bit as RGB like Pillow) in plain JS.
// decodeBmp(bytes) -> {width, height, mode, rgba, palette?, indices?}; rgba = Pillow convert("RGBA").

export class BmpError extends Error {}

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const s32 = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);

export function isBmp(bytes) { return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D; }

export function decodeBmp(bytes) {
  if (!isBmp(bytes)) throw new BmpError('BMP: wrong signature');
  const off = u32(bytes, 10), hsz = u32(bytes, 14);
  let w, h, bpp, comp = 0, ncol = 0;
  if (hsz === 12) { w = u16(bytes, 18); h = u16(bytes, 20); bpp = u16(bytes, 24); }
  else { w = s32(bytes, 18); h = s32(bytes, 22); bpp = u16(bytes, 28); comp = u32(bytes, 30); ncol = u32(bytes, 46); }
  if (comp !== 0) throw new BmpError(`BMP: compression ${comp} not supported`);
  const top = h < 0;
  h = Math.abs(h);
  let palette = null;
  if (bpp <= 8) {
    const n = ncol || 1 << bpp, ent = hsz === 12 ? 3 : 4, ps = 14 + hsz;
    palette = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      palette[i * 3] = bytes[ps + i * ent + 2];
      palette[i * 3 + 1] = bytes[ps + i * ent + 1];
      palette[i * 3 + 2] = bytes[ps + i * ent];
    }
  } else if (bpp !== 24 && bpp !== 32) throw new BmpError(`BMP: ${bpp} bits per pixel not supported`);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const rgba = new Uint8Array(w * h * 4), indices = palette ? new Uint8Array(w * h) : null;
  for (let y = 0; y < h; y++) {
    const row = off + (top ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (palette) {
        const per = 8 / bpp, byte = bytes[row + Math.floor(x / per)];
        const k = (byte >> (8 - bpp * ((x % per) + 1))) & ((1 << bpp) - 1);
        indices[i] = k;
        const q = k * 3 < palette.length ? k * 3 : 0;
        rgba.set([palette[q], palette[q + 1], palette[q + 2], 255], i * 4);
      } else {
        const q = row + x * (bpp >> 3);
        rgba.set([bytes[q + 2], bytes[q + 1], bytes[q], 255], i * 4);
      }
    }
  }
  return palette ? { width: w, height: h, mode: 'P', rgba, palette, indices } : { width: w, height: h, mode: 'RGB', rgba };
}
