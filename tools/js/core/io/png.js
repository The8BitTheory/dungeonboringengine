// PNG decoder and encoder in plain JS (no canvas: pixels must be bit-exact).
// decodePng(bytes) -> {width, height, mode, rgba: Uint8Array(w*h*4), palette?, indices?}
//   rgba follows Pillow's Image.open(...).convert("RGBA") (the Python tools read images that way):
//   16-bit gray is clipped to 255 like Pillow's I;16 -> L, 16-bit colour takes the high byte,
//   1/2/4-bit gray is scaled to 0..255, tRNS gives alpha 0 for the key colour / per palette entry.
// encodePng({width, height, rgba} | {width, height, rgb}) -> Uint8Array (8-bit RGBA or RGB, filter 0).

import { inflate, deflate, crc32 } from './inflate.js';

export class PngError extends Error {}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function u32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }

export function isPng(bytes) { return bytes.length >= 8 && SIG.every((v, i) => bytes[i] === v); }

export function decodePng(bytes) {
  if (!isPng(bytes)) throw new PngError('PNG: wrong signature');
  let p = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (p + 12 + len > bytes.length) throw new PngError(`PNG: chunk ${type} beyond the end of the file`);
    if (type === 'IHDR') {
      ihdr = { width: u32(data, 0), height: u32(data, 4), depth: data[8], ctype: data[9], interlace: data[12] };
      if (data[10] !== 0 || data[11] !== 0) throw new PngError('PNG: unknown compression or filter method');
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new PngError('PNG: IHDR missing');
  const { width: w, height: h, depth, ctype, interlace } = ihdr;
  const ch = CHANNELS[ctype];
  if (!ch) throw new PngError(`PNG: unknown colour type ${ctype}`);
  if (ctype === 3 && !plte) throw new PngError('PNG: palette missing');
  const total = idat.reduce((a, d) => a + d.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const d of idat) { z.set(d, o); o += d.length; }
  const raw = inflate(z);
  const bpp = Math.max(1, (ch * depth) >> 3);   // bytes per complete pixel for the filter
  // samples[y*w + x][c] as integers of the source bit depth
  const samples = new Uint16Array(w * h * ch);
  let rp = 0;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * ch * depth) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      if (rp + 1 + stride > raw.length) throw new PngError('PNG: image data too short');
      const ft = raw[rp];
      const line = raw.slice(rp + 1, rp + 1 + stride);
      rp += 1 + stride;
      unfilter(ft, line, prev, bpp);
      for (let x = 0; x < pw; x++) {
        const px = (y0 + y * dy) * w + x0 + x * dx;
        for (let c = 0; c < ch; c++) samples[px * ch + c] = sample(line, x * ch + c, depth);
      }
      prev = line;
    }
  }
  return toRgba(w, h, ctype, depth, samples, plte, trns);
}

function unfilter(ft, line, prev, bpp) {
  const n = line.length;
  switch (ft) {
    case 0: break;
    case 1: for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 255; break;
    case 2: for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 255; break;
    case 3:
      for (let i = 0; i < n; i++) line[i] = (line[i] + (((i >= bpp ? line[i - bpp] : 0) + prev[i]) >> 1)) & 255;
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      break;
    default: throw new PngError(`PNG: unknown filter type ${ft}`);
  }
}

function sample(line, i, depth) {
  if (depth === 8) return line[i];
  if (depth === 16) return (line[2 * i] << 8) | line[2 * i + 1];
  const per = 8 / depth, byte = line[Math.floor(i / per)], sh = 8 - depth * ((i % per) + 1);
  return (byte >> sh) & ((1 << depth) - 1);
}

function toRgba(w, h, ctype, depth, s, plte, trns) {
  const n = w * h, rgba = new Uint8Array(n * 4);
  const scale = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
  let mode;
  if (ctype === 0) {
    mode = depth === 1 ? '1' : depth === 16 ? 'I;16' : 'L';
    const key = trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
    for (let i = 0; i < n; i++) {
      const v = s[i], g = depth === 16 ? Math.min(v, 255) : scale(v);
      rgba.set([g, g, g, v === key ? 0 : 255], i * 4);
    }
  } else if (ctype === 2) {
    mode = 'RGB';
    const key = trns && trns.length >= 6 ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;
    for (let i = 0; i < n; i++) {
      const r = s[i * 3], g = s[i * 3 + 1], b = s[i * 3 + 2];
      const t = key && r === key[0] && g === key[1] && b === key[2];
      rgba.set([scale(r), scale(g), scale(b), t ? 0 : 255], i * 4);
    }
  } else if (ctype === 3) {
    mode = 'P';
    const np = plte.length / 3;
    for (let i = 0; i < n; i++) {
      const k = s[i];
      if (k >= np) { rgba.set([0, 0, 0, 255], i * 4); continue; }
      rgba.set([plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], trns && k < trns.length ? trns[k] : 255], i * 4);
    }
    const indices = Uint8Array.from(s.subarray(0, n));
    return { width: w, height: h, mode, rgba, palette: Uint8Array.from(plte), indices };
  } else if (ctype === 4) {
    mode = 'LA';
    for (let i = 0; i < n; i++) {
      const g = scale(s[i * 2]);
      rgba.set([g, g, g, scale(s[i * 2 + 1])], i * 4);
    }
  } else {
    mode = 'RGBA';
    for (let i = 0; i < n * 4; i++) rgba[i] = scale(s[i]);
  }
  return { width: w, height: h, mode, rgba };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const t = Uint8Array.from(type, (c) => c.charCodeAt(0));
  out.set([data.length >>> 24, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255]);
  out.set(t, 4);
  out.set(data, 8);
  const c = crc32(out.subarray(4, 8 + data.length));
  out.set([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255], 8 + data.length);
  return out;
}

export function encodePng(img) {
  const { width: w, height: h } = img;
  const ch = img.rgba ? 4 : 3, src = img.rgba || img.rgb;
  if (!src || src.length !== w * h * ch) throw new PngError('PNG: pixel data does not match width x height');
  const raw = new Uint8Array(h * (1 + w * ch));
  for (let y = 0; y < h; y++) raw.set(src.subarray(y * w * ch, (y + 1) * w * ch), y * (1 + w * ch) + 1);
  const ihdr = new Uint8Array(13);
  ihdr.set([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255,
    8, ch === 4 ? 6 : 2, 0, 0, 0]);
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
