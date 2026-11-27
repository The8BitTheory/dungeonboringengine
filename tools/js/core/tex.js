// Textures (P5): DTS/DBG builder and readers, reports, budget, check and the reference simulators of
// VDC-BASIC VMC/VMF/VMS. Port of tools/dbetex.py (docs/specs/P5-textures.md).
//
// API (no file system access: files referenced by a project are read through a resolver (path) => Uint8Array;
// paths are joined like os.path.join(dirname(toml path), value), the resolver receives them unchanged):
//   loadTexConf(src, {path, out, strict, key, alphaThreshold})   tex.toml (bytes/string) -> conf
//   buildTexset(conf, resolve) -> {ts, warnings, infos}             TexSet with ts.slots, ts.styleNames, ts.geom
//   toDts(ts, load) -> Uint8Array                                    DTS PRG
//   buildTex(src, {path, resolve, ...}) -> {files, report, warnings, infos, ts, conf, previews}   `build` command
//   loadBgConf / buildBackground(conf, resolve) -> {dbg, vram, warnings}; buildBg(src, {...}) -> {files, ...}
//   fromDts, fromDbg, render, renderBackground, preview (-> {width, height, rgb}), budget, check, vmsBound
import * as vrl from './vrl.js';
import * as mem from './mem.js';
import { decodeImage } from './io/image.js';
import { parseToml } from './io/toml.js';
import { readAseprite, frameList } from './io/aseprite.js';
import { pyRepr } from './map.js';

export const PALETTE = Object.freeze([[0x00, 0x00, 0x00], [0x55, 0x55, 0x55], [0x00, 0x00, 0xAA], [0x55, 0x55, 0xFF],
  [0x00, 0xAA, 0x00], [0x55, 0xFF, 0x55], [0x00, 0xAA, 0xAA], [0x55, 0xFF, 0xFF],
  [0xAA, 0x00, 0x00], [0xFF, 0x55, 0x55], [0xAA, 0x00, 0xAA], [0xFF, 0x55, 0xFF],
  [0xAA, 0x55, 0x00], [0xFF, 0xFF, 0x55], [0xAA, 0xAA, 0xAA], [0xFF, 0xFF, 0xFF]]);   // dbegeom.PALETTE
export const VMS_BUFFER = 1300;
export const KINDS = Object.freeze({ wall: 0, floor: 1, ceiling: 2 });
export const KIND_NAMES = Object.freeze({ 0: 'wall', 1: 'floor', 2: 'ceiling' });
export const KIND_ARTS = Object.freeze({ wall: ['front', 'side'], floor: ['floor'], ceiling: ['ceil'] });
export const BAND_ART = Object.freeze({ wall: null, floor: 'floorband', ceiling: 'ceilband' });
export const F_OCCLUDING = 1, F_CUTOUT = 2, F_ROWS = 4, F_EDGE = 8;
export const HEAD = 32;
export const NOIMG = 0xFE, FALLBACK = 0xFF;

export class TexError extends Error {
  constructor(msg) { super(msg); this.name = 'TexError'; }
}

const EMPTY = new Uint8Array(0);
const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d) => (has(o, k) ? o[k] : d);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const range = (n) => Array.from({ length: n }, (_, i) => i);

export class Core {
  constructor(src, dx, dy, w, h, srcstep = 0) { Object.assign(this, { src, dx, dy, w, h, srcstep }); }
}

export class Entry {
  constructor({ slot, flags = 0, cores = [], edge = EMPTY, edgeOfs = 0, vms = EMPTY, fill = EMPTY, source = 0,
    styleNames = [], h = 0, edgeLen = 0 }) {
    Object.assign(this, { slot, flags, cores, edge, edgeOfs, vms, fill, source, styleNames, h, edgeLen });
  }
}

export class TexSet {
  constructor(kind, geometryId, ne, depth, stride, slotMap, styles, entries, vram = EMPTY) {
    Object.assign(this, { kind, geometryId, ne, depth, stride, slotMap, styles, entries, vram });
  }

  /** Shallow copy (copy.copy). */
  copy() { return Object.assign(Object.create(Object.getPrototypeOf(this)), this); }
}

const u16 = (c, o) => c[o] | (c[o + 1] << 8);

// ---------------------------------------------------------------- Python helpers (formatting, paths)

/** binascii.crc_hqx (CRC-CCITT, polynomial 0x1021, not reflected). */
export function crcHqx(data, crc) {
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/** Python round(): half to even (exact for the doubles that occur). */
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python truthiness of a TOML value (bool(v)). */
export function pyBool(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && !(v instanceof Date)) return Object.keys(v).length > 0;
  return true;
}

/** Exact value of a double x >= 0 as [BigInt mantissa, binary exponent] (x = m * 2^e). */
function exact(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  let e = Number((bits >> 52n) & 0x7FFn);
  let m = bits & ((1n << 52n) - 1n);
  if (e === 0) e = 1; else m |= 1n << 52n;
  return [m, e - 1075];
}

/** Python format(x, '.Nf'): correctly rounded, ties to even on the exact binary value. */
export function pyFixed(x, n) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const [m, e] = exact(Math.abs(x));
  let num = m * 10n ** BigInt(n), den = 1n;
  if (e >= 0) num <<= BigInt(e); else den <<= BigInt(-e);
  let q = num / den;
  const r2 = 2n * (num % den);
  if (r2 > den || (r2 === den && (q & 1n))) q += 1n;
  const s = q.toString().padStart(n + 1, '0');
  return (neg ? '-' : '') + (n ? s.slice(0, s.length - n) + '.' + s.slice(s.length - n) : s);
}

/** Python repr(float). */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, ex] = x.toExponential().split('e');
  const e = parseInt(ex, 10);
  const digits = mant.replace('-', '').replace('.', '');
  const sign = x < 0 ? '-' : '';
  if (e >= -4 && e < 16) {         // Python repr: fixed notation for -4 <= exponent < 16
    if (e >= 0) {
      const ip = digits.length > e + 1 ? digits.slice(0, e + 1) : digits.padEnd(e + 1, '0');
      const fp = digits.length > e + 1 ? digits.slice(e + 1) : '0';
      return sign + ip + '.' + fp;
    }
    return sign + '0.' + '0'.repeat(-e - 1) + digits;
  }
  const m = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
  return sign + m + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
}

function jsonStr(s, ascii) {
  let out = JSON.stringify(s);
  if (ascii) out = out.replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return out;
}

/** json.dumps(v, indent=indent, ensure_ascii=ascii); numbers under a key in `floats` are written as Python floats. */
export function pyDumps(v, { indent = null, ascii = true, floats = new Set() } = {}) {
  const nl = (lvl) => (indent === null ? '' : '\n' + ' '.repeat(indent * lvl));
  const sepItem = indent === null ? ', ' : ',';
  const enc = (x, lvl, isFloat) => {
    if (x === null || x === undefined) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (typeof x === 'number') {
      if (isFloat || !Number.isInteger(x)) {
        if (Number.isNaN(x)) return 'NaN';
        if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
        return pyFloatRepr(x);
      }
      return String(x);
    }
    if (typeof x === 'string') return jsonStr(x, ascii);
    if (x instanceof Uint8Array) x = Array.from(x);
    if (Array.isArray(x)) {
      if (!x.length) return '[]';
      return '[' + x.map((y) => nl(lvl + 1) + enc(y, lvl + 1, isFloat)).join(sepItem) + nl(lvl) + ']';
    }
    const ks = Object.keys(x);
    if (!ks.length) return '{}';
    return '{' + ks.map((k) => nl(lvl + 1) + jsonStr(k, ascii) + ': ' + enc(x[k], lvl + 1, floats.has(k))).join(sepItem) + nl(lvl) + '}';
  };
  return enc(v, 0, false);
}

/** os.path.dirname (POSIX). */
export function pdirname(p) {
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  const head = p.slice(0, i + 1);
  return /^\/+$/.test(head) ? head : head.replace(/\/+$/, '');
}

/** os.path.join (POSIX, no normalisation). */
export function pjoin(a, ...rest) {
  let p = a;
  for (const b of rest) {
    if (b.startsWith('/')) p = b;
    else if (!p || p.endsWith('/')) p += b;
    else p += '/' + b;
  }
  return p;
}

/** Python repr of a tuple of ints. */
export const tup = (a) => '(' + a.join(', ') + (a.length === 1 ? ',' : '') + ')';

/** Reads a file through the resolver; resolver errors become TexError "<path>: <message>". */
export function readVia(resolve, path) {
  if (typeof resolve !== 'function') throw new TexError(`${path}: no file resolver`);
  let d;
  try {
    d = resolve(path);
  } catch (e) {
    if (e instanceof TexError) throw e;
    throw new TexError(`${path}: ${e.message}`);
  }
  if (d === null || d === undefined) throw new TexError(`${path}: [Errno 2] No such file or directory: ${pyRepr(path)}`);
  return d instanceof Uint8Array ? d : new Uint8Array(d);
}

// ---------------------------------------------------------------- Geometry

export function dvgId(content) {
  const tmp = Uint8Array.from(content);
  tmp.fill(0, 10, 14);
  return crcHqx(tmp, 0xFFFF) || 1;
}

/** Geometry JSON of dbegeom; with dvgPath also checks the DVG (ID, NE). */
export function loadGeom(resolve, path, dvgPath = null) {
  let g;
  const data = readVia(resolve, path);
  try {
    g = JSON.parse(new TextDecoder('utf-8').decode(data));
  } catch (e) {
    throw new TexError(`${path}: ${e.message}`);
  }
  if (g === null || typeof g !== 'object' || g.format !== 'dbegeom' || g.version !== 1) {
    throw new TexError(`${path}: not a dbegeom JSON (format/version)`);
  }
  if (dvgPath) {
    const dv = readVia(resolve, dvgPath);
    const c = dv.subarray(2);
    if (c.length < 24 || c[0] !== 0x44 || c[1] !== 0x56 || c[2] !== 1) throw new TexError(`${dvgPath}: not a DVG v1`);
    const stored = u16(c, 12);
    if (stored !== dvgId(c)) throw new TexError(`${dvgPath}: geometry ID in the header does not match the content`);
    if (stored !== g.geometry_id) throw new TexError(`${dvgPath}: geometry ID ${stored} != ${g.geometry_id} in ${path}`);
    if (c[7] !== g.elements.length) throw new TexError(`${dvgPath}: NE ${c[7]} != ${g.elements.length} in ${path}`);
  }
  return g;
}

/** {slots, smap}: drawing slots of the kind in slot order (4.2). */
export function slotInfos(geom, kind) {
  const ne = geom.elements.length;
  const D = geom.viewport.depth;
  const smap = new Array(ne + 2 * (D + 1)).fill(FALLBACK);
  const slots = [];
  const arts = KIND_ARTS[kind];
  for (const e of geom.elements) {
    if (arts.includes(e.art)) {
      smap[e.index] = slots.length;
      slots.push({
        name: e.name, art: e.art, d: e.d, s: e.s, rect: e.rect.slice(), mask: e.mask, kernel: e.kernel.slice(),
        cover: e.cover.slice(), flags: e.flags, src_dx: e.src_dx, atlas: e.atlas, band: false,
        partial: e.flags.includes('partial'), pos: e.index,
      });
    }
  }
  const ba = BAND_ART[kind];
  if (ba) {
    const bands = geom.band_images.slice().sort((a, b) => a.d - b.d);
    for (const b of bands) {
      if (b.art !== ba) continue;
      const pos = ba === 'ceilband' ? ne + b.d : ne + (D + 1) + b.d;
      smap[pos] = slots.length;
      const w = b.rect[2], h = b.rect[3];
      slots.push({
        name: b.name, art: ba, d: b.d, s: 0, rect: b.rect.slice(), mask: new Array(h).fill('#'.repeat(w)),
        kernel: [0, 0, w, h], cover: [0, 0], flags: [], src_dx: 0, atlas: b.atlas, band: true, partial: false, pos,
      });
    }
  }
  return { slots, smap };
}

// ---------------------------------------------------------------- Pixel

/** Image file -> RGBA image {width, height, rgba} (Pillow convert("RGBA")). */
export function readRgba(resolve, path) {
  const data = readVia(resolve, path);
  try {
    return decodeImage(data, path);
  } catch (e) {
    throw new TexError(`${path}: ${e.message}`);
  }
}

export function parseKey(k) {
  if (k === null || k === undefined || k === '') return null;
  if (Array.isArray(k)) return k;
  let s = String(k).trim().replace(/^#+/, '');
  if (!/^\s*[+-]?(0[xX])?_?[0-9a-fA-F]+(_[0-9a-fA-F]+)*\s*$/.test(s)) throw new TexError(`key: invalid color ${pyRepr(s)}`);
  s = s.replace(/_/g, '').trim();
  const v = Number.parseInt(s.replace(/^([+-]?)0[xX]/, '$1'), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const palCache = new globalThis.Map();

/** [index, squared distance] of the nearest palette color. */
export function nearest(rgb) {
  const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  let r = palCache.get(key);
  if (r === undefined) {
    let bd = -1, bi = 0;
    PALETTE.forEach((p, i) => {
      const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
      if (bd < 0 || d < bd) { bd = d; bi = i; }
    });
    r = [bi, bd];
    palCache.set(key, r);
  }
  return r;
}

/** Region box = [x, y, width_px, height] -> [rows of int | null, warnings]. */
export function toIndices(img, box, key = null, alphaThreshold = 0, strict = false) {
  const [x0, y0, bw, bh] = box;
  if (x0 < 0 || y0 < 0 || x0 + bw > img.width || y0 + bh > img.height) {
    throw new TexError(`Region (${x0}, ${y0}, ${bw}x${bh}) lies outside the image ${img.width}x${img.height}`);
  }
  key = parseKey(key);
  const px = img.rgba, W = img.width;
  const rows = [], half = [], off = [];
  for (let r = 0; r < bh; r++) {
    const line = [];
    for (let c = 0; c < bw; c++) {
      const o = ((y0 + r) * W + x0 + c) * 4;
      const R = px[o], G = px[o + 1], B = px[o + 2], A = px[o + 3];
      if (key !== null && R === key[0] && G === key[1] && B === key[2]) { line.push(null); continue; }
      if (alphaThreshold) {
        if (A < alphaThreshold) { line.push(null); continue; }
      } else if (A === 0) { line.push(null); continue; }
      else if (A !== 255) { half.push([c, r]); line.push(null); continue; }
      const [idx, dist] = nearest([R, G, B]);
      if (dist) off.push([dist, c, r]);
      line.push(idx);
    }
    rows.push(line);
  }
  if (half.length) {
    throw new TexError(`${half.length} pixels with semi-transparency, first at ${tup(half[0])} - semi-transparency: `
      + 'mask layer of the template exported as well? Aseprite: --layer Image');
  }
  const warns = [];
  if (off.length) {
    let mx = off[0], first = off[0];
    for (const t of off) {
      if (t[0] > mx[0] || (t[0] === mx[0] && (t[1] > mx[1] || (t[1] === mx[1] && t[2] > mx[2])))) mx = t;
      if (t[2] < first[2] || (t[2] === first[2] && t[1] < first[1])) first = t;
    }
    const msg = `${off.length} pixels not in the VDC palette, max. distance ${pyRound(Math.sqrt(mx[0]))} at `
      + `(${mx[1]}, ${mx[2]}), first at (${first[1]}, ${first[2]})`;
    if (strict) throw new TexError(msg);
    warns.push(msg);
  }
  return [rows, warns];
}

export function maskAllows(ch, side) {
  return ch === '#' || (ch === 'L' && side === 0) || (ch === 'R' && side === 1);
}

/** Pixels outside the mask become transparent; returns [pix, number of discarded opaque pixels]. */
export function applyMask(pix, mask) {
  const out = [];
  let n = 0;
  pix.forEach((row, r) => {
    const line = [];
    row.forEach((v, c) => {
      if (v !== null && !maskAllows(mask[r][c >> 1], c & 1)) { n++; v = null; }
      line.push(v);
    });
    out.push(line);
  });
  return [out, n];
}

/** Byte states 'F' full, 'L' left only, 'R' right only, '.' empty (2.4). */
export function classify(pix, mask = null) {
  if (mask !== null) pix = applyMask(pix, mask)[0];
  return pix.map((row) => {
    const line = [];
    for (let bx = 0; bx < row.length >> 1; bx++) {
      const a = row[2 * bx] !== null, b = row[2 * bx + 1] !== null;
      line.push(a && b ? 'F' : a ? 'L' : b ? 'R' : '.');
    }
    return line;
  });
}

/** If all 16 colors are used in half-R bytes: half-R bytes of the rarest color become full (2.4).
 *  Modifies pix/states in place; returns the number of replaced bytes. */
export function resolveAlphaConflict(pix, states) {
  const cnt = new globalThis.Map();
  states.forEach((row, r) => row.forEach((st, bx) => {
    if (st === 'R') { const c = pix[r][2 * bx + 1]; cnt.set(c, (cnt.get(c) || 0) + 1); }
  }));
  if (cnt.size < 16) return 0;
  let col = null;
  for (const [c, n] of cnt) if (col === null || n < cnt.get(col) || (n === cnt.get(col) && c < col)) col = c;
  let n = 0;
  states.forEach((row, r) => row.forEach((st, bx) => {
    if (st === 'R' && pix[r][2 * bx + 1] === col) { pix[r][2 * bx] = col; row[bx] = 'F'; n++; }
  }));
  return n;
}

/** [length, start] of the longest run of ones in acc (width w); on a tie the leftmost (dbegeom.longest_run). */
function longestRun(acc, w) {
  let bl = 0, bs = 0, i = 0;
  while (i < w) {
    if (acc[i]) {
      let j = i;
      while (j < w && acc[j]) j++;
      if (j - i > bl) { bl = j - i; bs = i; }
      i = j;
    } else i++;
  }
  return [bl, bs];
}

/** Largest rectangle of ones in the rows (arrays of booleans) (dbegeom.best_rect): maximum area, then greater
 *  width, smaller ky, smaller kx. Result [kx, ky, kw, kh] or null. */
export function bestRect(rows, w) {
  const h = rows.length;
  let best = null, bk = null;
  const acc = new Uint8Array(w);
  for (let ky = 0; ky < h; ky++) {
    acc.fill(1);
    for (let ke = ky; ke < h; ke++) {
      const row = rows[ke];
      let any = false;
      for (let i = 0; i < w; i++) { acc[i] = acc[i] && row[i] ? 1 : 0; if (acc[i]) any = true; }
      if (!any) break;
      const [ln, kx] = longestRun(acc, w);
      const kh = ke - ky + 1;
      const key = [ln * kh, ln, -ky, -kx];
      if (bk === null || key[0] > bk[0] || (key[0] === bk[0] && (key[1] > bk[1] || (key[1] === bk[1]
        && (key[2] > bk[2] || (key[2] === bk[2] && key[3] > bk[3])))))) {
        bk = key;
        best = [kx, ky, ln, kh];
      }
    }
  }
  return best;
}

/** Up to maxCores disjoint rectangles [kx, ky, kw, kh] of full bytes (5.4). */
export function chooseCores(states, maxCores, coreMin) {
  const h = states.length;
  const w = h ? states[0].length : 0;
  const free = states.map((row) => row.map((st) => st === 'F'));
  const cores = [];
  while (cores.length < maxCores) {
    const b = bestRect(free, w);
    if (!b) break;
    const [kx, ky, kw, kh] = b;
    if (cores.length && !(kh >= 2 && kw * kh >= coreMin)) break;
    cores.push(b);
    for (let r = ky; r < ky + kh; r++) for (let c = kx; c < kx + kw; c++) free[r][c] = false;
  }
  return cores;
}

export function inCore(cores, bx, r) {
  return cores.some(([kx, ky, kw, kh]) => kx <= bx && bx < kx + kw && ky <= r && r < ky + kh);
}

/** Format rules of the stored lists (P5b 4.6): only type 1/8, length matches the count, ofs = row * stride + column
 *  with row < h, column + len <= w <= stride, commands in ofs order without overlap. TexError on violation. */
export function checkVms(vms, w, h, stride, what = 'VMS list') {
  if (w > stride) throw new TexError(`${what}: width ${w} > stride ${stride}`);
  if (vms.length < 3) throw new TexError(`${what}: shorter than the header`);
  const n = vms[1] | (vms[2] << 8);
  let p = 3, end = 0;
  for (let i = 0; i < n; i++) {
    if (p + 3 > vms.length || (vms[p] !== 1 && vms[p] !== 8) || (vms[p] === 1 && p + 4 > vms.length)) {
      throw new TexError(`${what}: command at ${p} invalid (only type 1/8) or list too short`);
    }
    const ofs = vms[p + 1] | (vms[p + 2] << 8);
    const ln = vms[p] === 1 ? vms[p + 3] : 1;
    const r = Math.floor(ofs / stride), col = ofs % stride;
    if (ofs < end || r >= h || ln === 0 || col + ln > w) {
      throw new TexError(`${what}: command at ${p} violates the format rules (order, row, column + length)`);
    }
    end = ofs + ln;
    p += vms[p] === 1 ? 4 : 3;
  }
  if (p !== vms.length) throw new TexError(`${what}: length does not match the command count`);
}

/** [alpha, edge, vms]: packed edge bytes and VMS list (5.2); alpha per 2.4. */
export function packImage(pix, states, cores, stride) {
  const h = states.length;
  const w = h ? states[0].length : 0;
  const used = new Set();
  for (let r = 0; r < h; r++) {
    for (let bx = 0; bx < w; bx++) if (states[r][bx] === 'R' && !inCore(cores, bx, r)) used.add(pix[r][2 * bx + 1]);
  }
  let alpha = 0;
  while (alpha < 17 && used.has(alpha)) alpha++;
  if (alpha > 15) throw new TexError('internal error: all 16 colors in half-R bytes (resolve_alpha_conflict forgotten)');
  const edge = [], cmds = [];
  let ncmd = 0;
  for (let r = 0; r < h; r++) {
    let bx = 0;
    while (bx < w) {
      const st = states[r][bx];
      if (st === '.' || inCore(cores, bx, r)) { bx++; continue; }
      const ofs = r * stride + bx;
      if (st === 'F') {
        let j = bx;
        while (j < w && states[r][j] === 'F' && !inCore(cores, j, r) && j - bx < 255) {
          edge.push((pix[r][2 * j] << 4) | pix[r][2 * j + 1]);
          j++;
        }
        cmds.push(1, ofs & 255, ofs >> 8, j - bx);
        ncmd++;
        bx = j;
      } else {
        edge.push(st === 'L' ? (pix[r][2 * bx] << 4) | alpha : pix[r][2 * bx + 1]);
        cmds.push(8, ofs & 255, ofs >> 8);
        ncmd++;
        bx++;
      }
    }
  }
  if (!ncmd) return [0, EMPTY, EMPTY];
  const vms = new Uint8Array(3 + cmds.length);
  vms.set([alpha, ncmd & 255, ncmd >> 8]);
  vms.set(cmds, 3);
  return [alpha, Uint8Array.from(edge), vms];
}

export function coreBytes(pix, cores) {
  const out = [];
  for (const [kx, ky, kw, kh] of cores) {
    for (let r = ky; r < ky + kh; r++) for (let bx = kx; bx < kx + kw; bx++) out.push((pix[r][2 * bx] << 4) | pix[r][2 * bx + 1]);
  }
  return Uint8Array.from(out);
}

export function isOccluding(slot, states, geom) {
  const [c0, c1] = slot.cover;
  if (!slot.flags.includes('cover') || c1 <= c0) return false;
  const pl = geom.planes[slot.d + 1];
  const VH = geom.viewport.height;
  const r0 = Math.max(pl.T, 0), r1 = Math.min(pl.B, VH);
  const [x, y, , h] = slot.rect;
  for (let r = r0; r < r1; r++) {
    if (!(y <= r && r < y + h)) return false;
    for (let c = c0; c < c1; c++) if (states[r - y][c - x] !== 'F') return false;
  }
  return true;
}

// ---------------------------------------------------------------- Sources

export class PngSource {
  constructor(path, geom, key, alphaThreshold, resolve) {
    this.path = path;
    this.img = readRgba(resolve, path);
    this.key = key; this.thr = alphaThreshold;
    const [aw, ah] = geom.atlas_size;
    if (this.img.width < aw || this.img.height < ah) {
      throw new TexError(`${path}: atlas ${this.img.width}x${this.img.height} smaller than ${aw}x${ah}`);
    }
  }

  box(slot) {
    if (!pyBool(slot.atlas)) return null;
    const [x, y] = slot.atlas;
    return [x, y, slot.rect[2] * 2, slot.rect[3]];
  }
}

export class AseSource {
  constructor(path, geom, tag, frame, key, alphaThreshold, resolve) {
    this.path = path;
    this.key = key; this.thr = alphaThreshold;
    const { js, meta } = readAseprite(readVia(resolve, path), path, TexError);
    this.img = readRgba(resolve, pjoin(pdirname(path), meta.image));
    const fr = frameList(js, path, TexError, false);
    fr.forEach((f, i) => {
      if (pyBool(get(f, 'rotated', null)) || pyBool(get(f, 'trimmed', null))) {
        throw new TexError(`${path}: frame ${i} is rotated/trimmed - export without --trim/--sheet-pack rotation`);
      }
    });
    this.warn = [];
    if (tag !== null && tag !== undefined) {
      const tg = get(meta, 'frameTags', []).filter((t) => get(t, 'name', null) === tag);
      if (!tg.length) throw new TexError(`${path}: tag ${pyRepr(tag)} not found`);
      if (tg[0].to !== tg[0].from) this.warn.push(`${path}: tag ${pyRepr(tag)} spans several frames, the first one is used`);
      frame = tg[0].from;
    }
    frame = frame || 0;
    if (!(frame >= 0 && frame < fr.length)) throw new TexError(`${path}: frame ${frame} does not exist`);
    const fx = fr[frame].frame.x, fy = fr[frame].frame.y;
    this.slices = new globalThis.Map();
    for (const sl of get(meta, 'slices', [])) {
      const name = sl.name;
      if (this.slices.has(name)) throw new TexError(`${path}: slice ${pyRepr(name)} duplicated`);
      let best = null;
      for (const k of get(sl, 'keys', [])) if (k.frame <= frame && (best === null || k.frame >= best.frame)) best = k;
      if (best !== null) {
        const b = best.bounds;
        this.slices.set(name, [fx + b.x, fy + b.y, b.w, b.h]);
      }
    }
    const known = new Set([...geom.elements.map((e) => e.name), ...geom.band_images.map((b) => b.name)]);
    for (const n of this.slices.keys()) if (!known.has(n)) this.warn.push(`${path}: slice ${pyRepr(n)} unknown`);
  }

  box(slot) {
    const b = this.slices.get(slot.name);
    if (b === undefined) return null;
    const w2 = slot.rect[2] * 2, h = slot.rect[3];
    if (b[2] !== w2 || b[3] !== h) throw new TexError(`${this.path}: slice ${slot.name}: size ${b[2]}x${b[3]}, expected ${w2}x${h}`);
    return [b[0], b[1], w2, h];
  }
}

export function isTemplate(img, box, slot) {
  const [x0, y0, bw, bh] = box;
  const [kx, ky, kw, kh] = slot.kernel;
  const px = img.rgba, W = img.width;
  for (let r = 0; r < bh; r++) {
    for (let c = 0; c < bw; c++) {
      const o = ((y0 + r) * W + x0 + c) * 4;
      if (maskAllows(slot.mask[r][c >> 1], c & 1)) {
        const p = kx <= c >> 1 && c >> 1 < kx + kw && ky <= r && r < ky + kh ? PALETTE[1] : PALETTE[14];
        if (px[o] !== p[0] || px[o + 1] !== p[1] || px[o + 2] !== p[2] || px[o + 3] !== 255) return false;
      } else if (px[o + 3] !== 0) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- Configuration

export const TEXSET_KEYS = ['name', 'kind', 'geom', 'dvg', 'out', 'load', 'vrl_load', 'pool_bytes', 'max_cores', 'core_min',
  'fill_rows', 'key', 'alpha_threshold'];
export const STYLE_KEYS = ['name', 'png', 'aseprite', 'tag', 'frame', 'empty'];

export function checkKeys(where, d, allowed) {
  for (const k of Object.keys(d)) if (!allowed.includes(k)) throw new TexError(`${where}: unknown key ${pyRepr(k)}`);
}

/** TOML bytes/string -> object; errors as TexError "<path>: TOML: ...". */
export function toml(src, path) {
  try {
    return parseToml(src);
  } catch (e) {
    throw new TexError(`${path}: TOML: ${e.message}`);
  }
}

export function int(where, v, lo, hi) {
  if (!isInt(v) || !(v >= lo && v <= hi)) throw new TexError(`${where}: integer ${lo} ... ${hi} expected, found ${pyRepr(v)}`);
  return v;
}

/** str(v) of a TOML value. */
export const pyStr = (v) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'string' ? v : pyRepr(v));
const pyList = (v) => (typeof v === 'string' ? Array.from(v) : Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? Object.keys(v) : []);

/** tex.toml -> conf (dbetex.load_tex_conf). src: bytes or string; path: path of the TOML (paths are joined to its
 *  directory; pass an absolute path to get the same messages as Python). */
export function loadTexConf(src, { path = 'tex.toml', out = null, strict = false, key = null, alphaThreshold = null } = {}) {
  const cfg = toml(src, path);
  const base = pdirname(path);
  checkKeys(path, cfg, ['format', 'version', 'texset', 'style']);
  if (get(cfg, 'format', null) !== 'dbetex' || get(cfg, 'version', null) !== 1) {
    throw new TexError(`${path}: format = "dbetex" and version = 1 expected`);
  }
  const ts = { ...(get(cfg, 'texset', null) || {}) };
  checkKeys(`${path} [texset]`, ts, TEXSET_KEYS);
  for (const k of ['name', 'kind', 'geom']) if (!has(ts, k)) throw new TexError(`${path} [texset]: ${k} missing`);
  if (!has(KINDS, ts.kind)) throw new TexError(`${path} [texset] kind: wall, floor or ceiling expected`);
  const c = {
    name: pyStr(ts.name), kind: ts.kind, geom: pjoin(base, ts.geom),
    dvg: pyBool(get(ts, 'dvg', null)) ? pjoin(base, ts.dvg) : null,
    out: out || pjoin(base, get(ts, 'out', '.')),
    load: int('load', get(ts, 'load', mem.defaultLoad(ts.kind)), 0, 0xFFFF),
    vrl_load: int('vrl_load', get(ts, 'vrl_load', 0x4000), 0, 0xFFFF),
    pool_bytes: int('pool_bytes', get(ts, 'pool_bytes', 26624), 0, 1 << 24),
    max_cores: int('max_cores', get(ts, 'max_cores', 4), 0, 4),
    core_min: int('core_min', get(ts, 'core_min', 16), 1, 65535),
    fill_rows: pyBool(get(ts, 'fill_rows', true)),
    key: key !== null && key !== undefined ? key : get(ts, 'key', null),
    alpha_threshold: int('alpha_threshold', alphaThreshold !== null && alphaThreshold !== undefined ? alphaThreshold
      : get(ts, 'alpha_threshold', 0), 0, 255),
    strict,
  };
  const styles = get(cfg, 'style', null) || [];
  if (!(styles.length >= 1 && styles.length <= 32)) throw new TexError(`${path}: 1 ... 32 styles expected, found ${styles.length}`);
  const names = new Set();
  c.styles = [];
  styles.forEach((st, i) => {
    const where = `${path} [[style]] ${i}`;
    checkKeys(where, st, STYLE_KEYS);
    if (!has(st, 'name')) throw new TexError(`${where}: name missing`);
    if (names.has(st.name)) throw new TexError(`${where}: name ${pyRepr(st.name)} duplicated`);
    names.add(st.name);
    if (has(st, 'png') === has(st, 'aseprite')) throw new TexError(`${where}: exactly one source (png or aseprite) expected`);
    const s = { name: st.name, empty: pyList(get(st, 'empty', [])), tag: get(st, 'tag', null), frame: get(st, 'frame', null) };
    if (has(st, 'png')) s.png = pjoin(base, st.png);
    else s.aseprite = pjoin(base, st.aseprite);
    c.styles.push(s);
  });
  return c;
}

// ---------------------------------------------------------------- Building the texture set

const pixKey = (si, pix) => si + '|' + pix.map((r) => r.map((v) => (v === null ? '-' : v.toString(16))).join('')).join('/');

/** dbetex._Builder: collects entries (deduplicated), VRAM data, warnings and infos. */
export class Builder {
  constructor(conf, geom, slots, smap) {
    Object.assign(this, { conf, geom, slots, smap });
    this.entries = [];
    this.keys = new globalThis.Map();
    this.vram = [];
    this.warns = []; this.infos = [];
    this.stride = geom.viewport.stride;
    this.prep = new globalThis.Map();      // "style\0slot" -> [pix, states, entry index]
  }

  imageEntry(si, pix, mask, stylename) {
    const slot = this.slots[si];
    const w = slot.rect[2], h = slot.rect[3];
    let disc;
    [pix, disc] = applyMask(pix, mask);
    if (disc) this.warns.push(`${stylename}/${slot.name}: ${disc} pixels outside the mask, painted over, clipped`);
    const states = classify(pix);
    if (states.every((row) => row.every((st) => st === '.'))) return null;
    const n = resolveAlphaConflict(pix, states);
    if (n) this.warns.push(`${stylename}/${slot.name}: all 16 colors in half-R bytes, ${n} bytes made full`);
    const key = pixKey(si, pix);
    const pk = stylename + '\0' + si;
    if (this.keys.has(key)) {
      const idx = this.keys.get(key);
      this.entries[idx].styleNames.push(stylename);
      this.prep.set(pk, [pix, states, idx]);
      return idx;
    }
    const e = new Entry({ slot: si, h, styleNames: [stylename] });
    const occ = isOccluding(slot, states, this.geom);
    if (slot.band && this.conf.fill_rows) {         // row fill
      const fills = [];
      let ok = true;
      for (let r = 0; r < states.length; r++) {
        if (states[r].some((st) => st !== 'F')) { ok = false; break; }
        const bs = new Set(range(w).map((bx) => (pix[r][2 * bx] << 4) | pix[r][2 * bx + 1]));
        if (bs.size !== 1) { ok = false; break; }
        fills.push([...bs][0]);
      }
      if (ok) {
        e.flags = F_ROWS; e.fill = Uint8Array.from(fills);
        this.entries.push(e);
        const idx = this.entries.length - 1;
        this.keys.set(key, idx);
        e.source = idx;
        this.prep.set(pk, [pix, states, idx]);
        return idx;
      }
    }
    const cores = chooseCores(states, this.conf.max_cores, this.conf.core_min);
    const [, edge, vms] = packImage(pix, states, cores, this.stride);
    for (const k of cores) {
      e.cores.push(new Core(this.vram.length, k[0], k[1], k[2], k[3], 0));
      for (const b of coreBytes(pix, [k])) this.vram.push(b);
    }
    e.edgeOfs = this.vram.length; e.edge = edge; e.edgeLen = edge.length; e.vms = vms;
    for (const b of edge) this.vram.push(b);
    if (!edge.length) e.edgeOfs = 0;
    else e.flags |= F_EDGE;
    if (occ) e.flags |= F_OCCLUDING;
    this.entries.push(e);
    const idx = this.entries.length - 1;
    this.keys.set(key, idx);
    e.source = idx;
    this.prep.set(pk, [pix, states, idx]);
    return idx;
  }

  /** Crop of the full front (fsi) for partial front si (5.3). */
  partialEntry(si, fsi, stylename) {
    const slot = this.slots[si], fslot = this.slots[fsi];
    const [fpix, , fidx] = this.prep.get(stylename + '\0' + fsi);
    const fe = this.entries[fidx];
    const key = `${si}|part|${fidx}`;
    if (this.keys.has(key)) {
      const idx = this.keys.get(key);
      this.entries[idx].styleNames.push(stylename);
      return idx;
    }
    const [, y, w, h] = slot.rect;
    const [, fy, fw, fh] = fslot.rect;
    const sdx = slot.src_dx, ry = y - fy;
    if (sdx < 0 || sdx + w > fw || ry < 0 || ry + h > fh) {
      throw new TexError(`${slot.name}: partial front does not lie within the image of the full front`);
    }
    let cpix = fpix.slice(ry, ry + h).map((row) => row.slice(2 * sdx, 2 * (sdx + w)));
    cpix = applyMask(cpix, slot.mask)[0];
    const cstates = classify(cpix);
    const e = new Entry({ slot: si, flags: F_CUTOUT, h, styleNames: [stylename], source: fidx });
    const lk = [];
    for (const k of fe.cores) {
      const a = Math.max(k.dx, sdx), b = Math.min(k.dx + k.w, sdx + w);
      const r0 = Math.max(k.dy, ry), r1 = Math.min(k.dy + k.h, ry + h);
      if (a >= b || r0 >= r1) continue;
      for (let r = r0 - ry; r < r1 - ry; r++) {
        for (let c = a - sdx; c < b - sdx; c++) {
          if (cstates[r][c] !== 'F') throw new TexError(`${slot.name}: core of the full front does not lie fully within the partial front`);
        }
      }
      lk.push([a - sdx, r0 - ry, b - a, r1 - r0]);
      e.cores.push(new Core(k.src + (r0 - k.dy) * k.w + (a - k.dx), a - sdx, r0 - ry, b - a, r1 - r0, k.w));
    }
    const [, edge, vms] = packImage(cpix, cstates, lk, this.stride);
    if (edge.length) {
      e.edgeOfs = this.vram.length; e.edge = edge; e.edgeLen = edge.length; e.vms = vms;
      e.flags |= F_EDGE;
      for (const b of edge) this.vram.push(b);
    }
    if (isOccluding(slot, cstates, this.geom)) e.flags |= F_OCCLUDING;
    this.entries.push(e);
    const idx = this.entries.length - 1;
    this.keys.set(key, idx);
    return idx;
  }
}

/** -> {ts, warnings, infos}; conf as in loadTexConf, resolve(path) -> bytes for geom/dvg/png/aseprite files.
 *  conf.geomData may hold the parsed geometry (then conf.geom/conf.dvg are not read). */
export function buildTexset(conf, resolve) {
  const geom = conf.geomData || loadGeom(resolve, conf.geom, get(conf, 'dvg', null));
  const kind = conf.kind;
  const { slots, smap } = slotInfos(geom, kind);
  if (!slots.length) throw new TexError(`Geometry has no drawing slots of kind ${kind}`);
  const b = new Builder(conf, geom, slots, smap);
  const key = get(conf, 'key', null);
  const thr = conf.alpha_threshold;
  const names = new globalThis.Map(slots.map((s, i) => [s.name, i]));
  const styles = [];
  for (const st of conf.styles) {
    const sn = st.name;
    for (const en of st.empty) {
      if (!names.has(en)) throw new TexError(`Style ${sn}: empty: ${pyRepr(en)} is not a drawing slot of kind ${kind}`);
    }
    let src;
    if (has(st, 'png')) src = new PngSource(st.png, geom, key, thr, resolve);
    else {
      src = new AseSource(st.aseprite, geom, st.tag, st.frame, key, thr, resolve);
      b.warns.push(...src.warn);
    }
    const vals = new Array(slots.length).fill(null);
    slots.forEach((slot, si) => {          // non-derived images first
      if (slot.partial) return;
      if (st.empty.includes(slot.name)) { vals[si] = NOIMG; return; }
      const box = src.box(slot, b.warns);
      if (box === null) return;
      const [pix, w] = toIndices(src.img, box, key, thr, conf.strict);
      b.warns.push(...w.map((m) => `${sn}/${slot.name}: ${m}`));
      if (has(st, 'png') && isTemplate(src.img, box, slot)) { b.infos.push(`${sn}/${slot.name}: not painted`); return; }
      const idx = b.imageEntry(si, pix, slot.mask, sn);
      if (idx === null) { b.infos.push(`${sn}/${slot.name}: not painted (empty)`); return; }
      vals[si] = idx;
    });
    slots.forEach((slot, si) => {
      if (!slot.partial) return;
      const fsi = names.get(`front_d${slot.d}_s+0`);
      if (st.empty.includes(slot.name)) vals[si] = NOIMG;
      else if (fsi !== undefined && vals[fsi] !== null && vals[fsi] < NOIMG) vals[si] = b.partialEntry(si, fsi, sn);
      else if (fsi !== undefined && vals[fsi] === NOIMG) vals[si] = NOIMG;
    });
    styles.push(vals);
  }
  // Style table: missing -> $FF (style >= 1) / $FE (style 0)
  styles.forEach((vals, sti) => vals.forEach((v, si) => {
    if (v !== null) return;
    if (sti === 0) {
      vals[si] = NOIMG;
      if (!slots[si].partial) b.warns.push(`Style 0 without image for ${slots[si].name}`);
    } else vals[si] = FALLBACK;
  }));
  if (b.entries.length > 254) throw new TexError(`too many images: ${b.entries.length} > 254 - split styles across two DTS files`);
  if (b.vram.length > 65535) throw new TexError(`VRAM data ${b.vram.length} > 65535 bytes`);
  const nk = b.entries.reduce((a, e) => a + e.cores.length, 0);
  if (nk > 255) throw new TexError(`too many cores: ${nk} > 255`);
  const vp = geom.viewport;
  const vram = Uint8Array.from(b.vram);
  const ts = new TexSet(KINDS[kind], geom.geometry_id, geom.elements.length, vp.depth, vp.stride, smap, styles, b.entries, vram);
  ts.slots = slots;
  ts.ns = slots.length; ts.nk = nk; ts.u = vram.length;
  ts.crc = crcHqx(vram, 0xFFFF); ts.total = 0;
  ts.styleNames = conf.styles.map((s) => s.name);
  ts.geom = geom;
  return { ts, warnings: b.warns, infos: b.infos };
}

// ---------------------------------------------------------------- DTS

/** Little-endian byte collector (struct.pack). */
export class Bytes {
  constructor() { this.a = []; }
  u8(...v) { for (const x of v) this.a.push(x & 255); return this; }
  u16(...v) { for (const x of v) this.a.push(x & 255, (x >> 8) & 255); return this; }
  raw(b) { for (const x of b) this.a.push(x); return this; }
  get length() { return this.a.length; }
  bytes() { return Uint8Array.from(this.a); }
}

export function toDts(ts, load = null) {
  if (load === null || load === undefined) load = mem.defaultLoad(KIND_NAMES[ts.kind]);
  const ne = ts.ne, D = ts.depth;
  const ns = ts.slotMap.filter((v) => v !== FALLBACK).length;
  const nst = ts.styles.length, ni = ts.entries.length;
  const nk = ts.entries.reduce((a, e) => a + e.cores.length, 0);
  const oSlot = HEAD;
  const oStyle = oSlot + ts.slotMap.length;
  const oDir = oStyle + nst * ns;
  const oCore = oDir + 16 * ni;
  const oData = oCore + 8 * nk;
  const data = [], dirs = new Bytes(), cores = new Bytes();
  let kpos = oCore;
  ts.entries.forEach((e, i) => {
    let kofs = 0;
    if (e.cores.length) {
      kofs = kpos;
      for (const k of e.cores) cores.u16(k.src).u8(k.dx, k.dy, k.w, k.h).u16(k.srcstep);
      kpos += 8 * e.cores.length;
    }
    let vofs = 0, vlen = 0;
    if (e.fill.length) {
      kofs = oData + data.length;
      data.push(...e.fill);
    }
    if (e.vms.length) {
      vofs = oData + data.length; vlen = e.vms.length;
      data.push(...e.vms);
    }
    dirs.u8(e.flags, e.slot, e.cores.length, e.fill.length ? e.fill.length : e.h).u16(kofs, e.edgeOfs, e.edgeLen, vofs, vlen)
      .u8(e.flags & F_CUTOUT ? e.source : i, 0);
  });
  const total = oData + data.length;
  if (total > 65535) throw new TexError(`DTS content ${total} > 65535 bytes`);
  const out = new Bytes().u16(load).u8(0x44, 0x54, 1, ts.kind).u16(ts.geometryId).u8(ne, D, ns, nst, ni, nk)
    .u16(oSlot, oStyle, oDir, oCore, oData, total).u16(ts.vram.length, crcHqx(ts.vram, 0xFFFF), ts.stride).u8(0, 0);
  out.raw(ts.slotMap);
  for (const vals of ts.styles) out.raw(vals);
  out.raw(dirs.a).raw(cores.a).raw(data);
  if (out.length !== 2 + total) throw new TexError('internal error: DTS length');
  return out.bytes();
}

/** DTS PRG -> TexSet (vram optional; without it the edge bytes stay empty). TexError on format errors.
 *  The file is kept as ts.dtsPrg (VIEW needs the VMS offsets of the file for VCL type 9). */
export function fromDts(data, vram = null) {
  if (data.length < 2 + HEAD) throw new TexError('DTS: file shorter than the header');
  const c = data.subarray(2);
  if (c[0] !== 0x44 || c[1] !== 0x54) throw new TexError("DTS: wrong magic (expected 'DT')");
  if (c[2] !== 1) throw new TexError(`DTS: version ${c[2]} not supported`);
  const kind = c[3], gid = u16(c, 4), ne = c[6], D = c[7], ns = c[8], nst = c[9], ni = c[10], nk = c[11];
  const [oSlot, oStyle, oDir, oCore, oData, total] = [12, 14, 16, 18, 20, 22].map((o) => u16(c, o));
  const u = u16(c, 24), crc = u16(c, 26), stride = u16(c, 28);
  const nsm = ne + 2 * (D + 1);
  if (kind > 2) throw new TexError(`DTS: kind ${kind} invalid`);
  const exp = [HEAD, HEAD + nsm, HEAD + nsm + nst * ns, HEAD + nsm + nst * ns + 16 * ni,
    HEAD + nsm + nst * ns + 16 * ni + 8 * nk];
  if ([oSlot, oStyle, oDir, oCore, oData].some((v, i) => v !== exp[i])) {
    throw new TexError('DTS: offsets in the header do not match the counts (ranges not contiguous)');
  }
  if (c.length < total || total < oData) throw new TexError(`DTS: file too short (${c.length} < ${total})`);
  const smap = Array.from(c.subarray(oSlot, oSlot + nsm));
  const styles = [];
  for (let i = 0; i < nst; i++) styles.push(Array.from(c.subarray(oStyle + i * ns, oStyle + (i + 1) * ns)));
  styles.forEach((vals, i) => {
    for (const v of vals) if (v < NOIMG && v >= ni) throw new TexError(`DTS: style ${i} refers to image ${v} >= NI ${ni}`);
    if (i === 0 && vals.includes(FALLBACK)) throw new TexError('DTS: $FF in style 0');
  });
  const entries = [];
  for (let i = 0; i < ni; i++) {
    const o = oDir + 16 * i;
    const fl = c[o], slot = c[o + 1], nkk = c[o + 2], h = c[o + 3], kofs = u16(c, o + 4), rofs = u16(c, o + 6);
    const rlen = u16(c, o + 8), vofs = u16(c, o + 10), vlen = u16(c, o + 12), src = c[o + 14];
    const e = new Entry({ slot, flags: fl, h, edgeOfs: rofs, edgeLen: rlen, source: src });
    if (fl & F_ROWS) e.fill = c.slice(kofs, kofs + h);
    else {
      for (let j = 0; j < nkk; j++) {
        const k = kofs + 8 * j;
        e.cores.push(new Core(u16(c, k), c[k + 2], c[k + 3], c[k + 4], c[k + 5], u16(c, k + 6)));
      }
    }
    if (vlen) {
      e.vms = c.slice(vofs, vofs + vlen);
      checkVms(e.vms, stride, h, stride, `DTS: image ${i}`);
    }
    if (vram !== null && rlen) e.edge = Uint8Array.from(vram.subarray(rofs, rofs + rlen));
    entries.push(e);
  }
  const ts = new TexSet(kind, gid, ne, D, stride, smap, styles, entries, vram !== null ? Uint8Array.from(vram) : EMPTY);
  Object.assign(ts, { u, crc, total, ns, nk });
  ts.dtsPrg = Uint8Array.from(data.subarray(0, 2 + total));
  return ts;
}

/** DBG PRG -> plain object (vw, vh, geometry_id, P, y0, h, wrap, offsets, u, crc, fill), keys as in Python. */
export function fromDbg(data) {
  if (data.length < 2 + 24) throw new TexError('DBG: file shorter than the header');
  const c = data.subarray(2);
  if (c[0] !== 0x44 || c[1] !== 0x42) throw new TexError("DBG: wrong magic (expected 'DB')");
  if (c[2] !== 1) throw new TexError(`DBG: version ${c[2]} not supported`);
  const vw = c[3], vh = c[4];
  if (c.length !== 24 + vh) throw new TexError(`DBG: length ${c.length} != ${24 + vh}`);
  return {
    vw, vh, geometry_id: u16(c, 5), P: u16(c, 7), y0: c[9], h: c[10], wrap: !!(c[11] & 1),
    offsets: [12, 14, 16, 18].map((o) => u16(c, o)), u: u16(c, 20), crc: u16(c, 22), fill: Array.from(c.subarray(24, 24 + vh)),
  };
}

// ---------------------------------------------------------------- Simulators (VDC-BASIC VMC / VMF / VMS)

/** Copies reps rows of count bytes each; srcstep 0 = source contiguous. */
export function simVmc(vram, src, dst, count, reps = 1, dststep = 0, srcstep = 0, fb = null) {
  fb = fb === null ? vram : fb;
  for (let r = 0; r < reps; r++) {
    const s = (src + r * (srcstep || count)) & 0xFFFF;
    const d = (dst + r * dststep) & 0xFFFF;
    for (let i = 0; i < count; i++) fb[(d + i) & 0xFFFF] = vram[(s + i) & 0xFFFF];
  }
}

export function simVmf(vram, dst, byte, count) {
  for (let i = 0; i < count; i++) vram[(dst + i) & 0xFFFF] = byte;
}

/** VMS list per vms-format.md (type 1, 8 and 3 = source skip). */
export function simVms(vram, src, dst, vmsList, fb = null) {
  fb = fb === null ? vram : fb;
  if (vmsList.length < 3) throw new TexError('VMS list shorter than the header');
  const alpha = vmsList[0];
  const n = vmsList[1] | (vmsList[2] << 8);
  let p = 3, rd = src;
  for (let k = 0; k < n; k++) {
    const t = vmsList[p];
    const ofs = vmsList[p + 1] | (vmsList[p + 2] << 8);
    if (t === 1) {
      const ln = vmsList[p + 3];
      p += 4;
      for (let i = 0; i < ln; i++) fb[(dst + ofs + i) & 0xFFFF] = vram[(rd + i) & 0xFFFF];
      rd += ln;
    } else if (t === 3) {
      p += 3;
      rd = (rd + ofs) & 0xFFFF;
    } else if (t === 8) {
      p += 3;
      const b = vram[rd & 0xFFFF];
      rd += 1;
      const a = (dst + ofs) & 0xFFFF;
      if ((b & 15) === alpha) fb[a] = (b & 0xF0) | (fb[a] & 15);
      else fb[a] = (fb[a] & 0xF0) | (b & 15);
    } else throw new TexError(`VMS: invalid command ${t}`);
  }
}

// ---------------------------------------------------------------- Reference renderer

/** Draws entry (style, slot) per 4.4; $FF -> style 0, $FE -> nothing. vb = VRAM base of the data.
 *  Slot rectangles from ts.slots, or from geom (slot_infos) if given. */
export function render(ts, style, slot, vram, fb, { ap = 0, origin = 0, stride = null, vb = 0, geom = null, t0 = null } = {}) {
  stride = stride || ts.stride;
  let v = ts.styles[style][slot];
  if (v === FALLBACK) v = ts.styles[0][slot];
  if (v >= NOIMG) return false;
  const e = ts.entries[v];
  const slots = ts.slots || (geom ? slotInfos(geom, KIND_NAMES[ts.kind]).slots : null);
  if (!slots) throw new TexError('render: slot rectangles missing (ts.slots or geom)');
  if (t0 === null) {
    const [x, y] = slots[slot].rect;
    t0 = ap + origin + y * stride + x;
  }
  if (e.flags & F_ROWS) {
    const w = slots[slot].rect[2];
    e.fill.forEach((b, i) => simVmf(fb, t0 + i * stride, b, w));
    return true;
  }
  for (const k of e.cores) simVmc(vram, vb + k.src, t0 + k.dy * stride + k.dx, k.w, k.h, stride, k.srcstep, fb);
  if (e.flags & F_EDGE) simVms(vram, vb + e.edgeOfs, t0, e.vms, fb);
  return true;
}

/** Frame buffer -> RGB image {width, height, rgb} (2 pixels per byte, palette PALETTE), zoom by pixel repetition. */
export function fbToImage(fb, vw, h, stride, base = 0, zoom = 1) {
  const W = vw * 2 * zoom, H = h * zoom;
  const rgb = new Uint8Array(W * H * 3);
  for (let r = 0; r < h; r++) {
    const line = new Uint8Array(W * 3);
    for (let bx = 0; bx < vw; bx++) {
      const b = fb[(base + r * stride + bx) & 0xFFFF];
      for (let half = 0; half < 2; half++) {
        const col = PALETTE[half ? b & 15 : b >> 4];
        for (let z = 0; z < zoom; z++) line.set(col, ((2 * bx + half) * zoom + z) * 3);
      }
    }
    for (let z = 0; z < zoom; z++) rgb.set(line, (r * zoom + z) * W * 3);
  }
  return { width: W, height: H, rgb };
}

/** Preview image of a style (7.3) as {width, height, rgb} (x4). */
export function preview(ts, geom, style, vb = 0x4000) {
  const vp = geom.viewport;
  const vw = vp.width_px >> 1, h = vp.height, stride = vp.stride;
  const m = new Uint8Array(65536);
  if (vb + ts.vram.length > 65536) throw new TexError('Preview: VRAM data does not fit behind the preview base');
  m.set(ts.vram, vb);
  const slots = ts.slots || slotInfos(geom, KIND_NAMES[ts.kind]).slots;
  const D = ts.depth;
  const order = [];
  const idx = (f) => slots.map((s, i) => (f(s) ? i : -1)).filter((i) => i >= 0);
  if (ts.kind === 0) {
    // Painter's algorithm: side d lies between planes d and d + 1, i.e. behind front d
    for (let d = D; d >= 0; d--) {
      order.push(...idx((s) => s.art === 'side' && s.d === d && Math.abs(s.s) === 1));
      if (d === D) {
        const fr = idx((s) => s.art === 'front' && s.d === d);
        order.push(...fr.sort((a, b) => Math.abs(slots[b].s) - Math.abs(slots[a].s)));
      }
    }
  } else {
    order.push(...idx((s) => s.band));
    order.push(...idx((s) => !s.band));
  }
  const t2 = ts.slots ? ts : Object.assign(ts.copy(), { slots });
  for (const si of order) render(t2, style, si, m, m, { stride, vb });
  return fbToImage(m, vw, h, stride, 0, 4);
}

// ---------------------------------------------------------------- DBG (wallpaper)

export const BG_KEYS = ['name', 'geom', 'png', 'y0', 'offsets', 'wrap', 'above', 'below', 'out', 'load', 'vrl_load', 'key'];

export function loadBgConf(src, { path = 'bg.toml', out = null, strict = false } = {}) {
  const cfg = toml(src, path);
  const base = pdirname(path);
  checkKeys(path, cfg, ['format', 'version', 'background']);
  if (get(cfg, 'format', null) !== 'dbebg' || get(cfg, 'version', null) !== 1) {
    throw new TexError(`${path}: format = "dbebg" and version = 1 expected`);
  }
  const bg = { ...(get(cfg, 'background', null) || {}) };
  checkKeys(`${path} [background]`, bg, BG_KEYS);
  for (const k of ['name', 'geom', 'png']) if (!has(bg, k)) throw new TexError(`${path} [background]: ${k} missing`);
  return {
    name: pyStr(bg.name), geom: pjoin(base, bg.geom), png: pjoin(base, bg.png),
    y0: get(bg, 'y0', 'horizon'), offsets: get(bg, 'offsets', 'auto'), wrap: pyBool(get(bg, 'wrap', true)),
    above: get(bg, 'above', 0), below: get(bg, 'below', 0),
    out: out || pjoin(base, get(bg, 'out', '.')),
    load: int('load', get(bg, 'load', mem.defaultLoad('dbg')), 0, 0xFFFF),
    vrl_load: int('vrl_load', get(bg, 'vrl_load', 0x4000), 0, 0xFFFF),
    key: get(bg, 'key', null), strict,
  };
}

function bgFill(v, n, what) {
  if (isInt(v) || typeof v === 'boolean') v = new Array(Math.max(0, n)).fill(+v);
  if (!Array.isArray(v) || v.length !== n || !v.every((c) => (isInt(c) || typeof c === 'boolean') && c >= 0 && c <= 15)) {
    throw new TexError(`${what}: color 0 ... 15 or list of ${n} colors expected`);
  }
  return v.map((c) => +c);
}

/** -> {dbg: DBG PRG, vram, warnings}. */
export function buildBackground(conf, resolve) {
  const geom = conf.geomData || loadGeom(resolve, conf.geom, get(conf, 'dvg', null));
  const vp = geom.viewport;
  const VW = vp.width_px >> 1, VH = vp.height;
  const img = readRgba(resolve, conf.png);
  if (img.width % 2) throw new TexError(`${conf.png}: width ${img.width} not even`);
  const P = img.width >> 1, h = img.height;
  const [pix, warns] = toIndices(img, [0, 0, img.width, h], get(conf, 'key', null), 0, get(conf, 'strict', false));
  if (pix.some((row) => row.some((v) => v === null))) throw new TexError(`${conf.png}: panorama has transparent pixels`);
  if (P < VW) throw new TexError(`Panorama width ${P} < viewport width ${VW}`);
  if (P * h > 65535) throw new TexError(`Panorama ${P} x ${h} = ${P * h} > 65535 bytes`);
  let y0 = conf.y0;
  if (y0 === 'horizon') {
    const [hy0, hy1] = geom.horizon;
    y0 = hy0 + Math.floor((hy1 - hy0 - h) / 2);
  }
  y0 = int('y0', y0, -1000, 1000);
  if (y0 < 0 || y0 + h > VH) throw new TexError(`y0 ${y0} + h ${h} does not lie within the viewport (0 ... ${VH})`);
  let off = conf.offsets;
  if (off === 'auto') {
    if (P % 4) throw new TexError(`offsets = auto: panorama width ${P} not divisible by 4`);
    off = range(4).map((v) => Math.floor(v * P / 4));
  }
  if (!(Array.isArray(off) && off.length === 4 && off.every((o) => isInt(o) && o >= 0 && o < P))) {
    throw new TexError(`offsets: 4 values 0 ... ${P - 1} expected`);
  }
  if (!conf.wrap && off.some((o) => o + VW > P)) throw new TexError('without wrap, o_v + VW <= P must hold for all directions');
  const above = bgFill(conf.above, y0, 'above');
  const below = bgFill(conf.below, VH - (y0 + h), 'below');
  const fill = [...above.map((c) => c * 17), ...new Array(h).fill(0), ...below.map((c) => c * 17)];
  const vram = new Uint8Array(P * h);
  pix.forEach((row, r) => { for (let i = 0; i < P; i++) vram[r * P + i] = (row[2 * i] << 4) | row[2 * i + 1]; });
  const out = new Bytes().u16(conf.load).u8(0x44, 0x42, 1, VW, VH).u16(geom.geometry_id, P).u8(y0, h, conf.wrap ? 1 : 0)
    .u16(...off).u16(vram.length, crcHqx(vram, 0xFFFF));
  out.raw(fill);
  return { dbg: out.bytes(), vram, warnings: warns };
}

/** Horizon rows for view direction v into fb using simVmc/simVmf (6.2). */
export function renderBackground(bg, vram, v, fb, { vb = 0, ap = 0, stride = 80 } = {}) {
  const vw = bg.vw, P = bg.P, o = bg.offsets[v];
  for (let r = 0; r < bg.vh; r++) {
    const t0 = ap + r * stride;
    if (bg.y0 <= r && r < bg.y0 + bg.h) {
      const src = vb + (r - bg.y0) * P;
      const n1 = Math.min(vw, P - o);
      simVmc(vram, src + o, t0, n1, 1, 0, 0, fb);
      if (n1 < vw) {
        if (!bg.wrap) throw new TexError('DBG: access beyond P without WRAP');
        simVmc(vram, src, t0 + n1, vw - n1, 1, 0, 0, fb);
      }
    } else simVmf(fb, t0, bg.fill[r], vw);
  }
}

// ---------------------------------------------------------------- Report and budget

/** Upper bound for the VMS lists of a view: per slot the maximum over the styles (8.1). Returns [walls, bands]. */
export function vmsBound(ts) {
  const tot = [0, 0];
  const smap = ts.slotMap;
  const bandSlots = new Set(smap.filter((v, i) => i >= ts.ne && v !== FALLBACK));
  const n = smap.filter((v) => v !== FALLBACK).length;
  for (let k = 0; k < n; k++) {
    let m = 0;
    for (const vals of ts.styles) {
      let v = vals[k];
      if (v === FALLBACK) v = ts.styles[0][k];
      if (v < NOIMG) m = Math.max(m, ts.entries[v].vms.length);
    }
    tot[bandSlots.has(k) ? 1 : 0] += m;
  }
  return tot;
}

/** Keys whose numbers are Python floats in the JSON outputs (report vrl_ratio, budget share). */
export const REPORT_FLOATS = new Set(['vrl_ratio', 'share', 'ratio']);

export function buildReport(ts, conf, warns, infos, vrlStream, dtsLen) {
  const st = vrl.stats(vrlStream);
  const slots = ts.slots;
  const rows = [], seen = new Set(), perStyle = [];
  ts.styles.forEach((vals, si) => {
    let vram = 0, vms = 0;
    vals.forEach((v, k) => {
      const row = { style: ts.styleNames[si], slot: slots[k].name, value: v };
      if (v >= NOIMG) row.source = v === FALLBACK ? '$FF -> style 0' : '$FE';
      else {
        const e = ts.entries[v];
        const own = e.styleNames.length ? e.styleNames[0] : '';
        row.entry = v;
        row.source = own === ts.styleNames[si] ? 'own' : `shared with ${own}`;
        if (e.flags & F_CUTOUT) row.source += `, crop of ${e.source}`;
        row.cores = e.cores.length;
        row.core_bytes = !(e.flags & F_CUTOUT) ? e.cores.reduce((a, kk) => a + kk.w * kk.h, 0) : 0;
        row.edge = e.edgeLen;
        row.vms = e.vms.length;
        row.alpha = e.vms.length ? e.vms[0] : null;
        row.occluding = !!(e.flags & F_OCCLUDING);
        row.rows = !!(e.flags & F_ROWS);
        if (!seen.has(v)) { seen.add(v); vram += row.core_bytes + e.edgeLen; }
        vms += e.vms.length;
      }
      rows.push(row);
    });
    perStyle.push({ style: ts.styleNames[si], vram, vms });
  });
  const [b0, b1] = vmsBound(ts);
  warns = warns.slice();
  if (b0 > VMS_BUFFER) warns.push(`VMS bound ${b0} > VMS buffer ${VMS_BUFFER}`);
  ts.entries.forEach((e, i) => {
    if (e.vms.length > VMS_BUFFER) {
      warns.push(`Image ${i} (${slots[e.slot].name}, ${e.styleNames.join('/')}): VMS list ${e.vms.length} bytes `
        + `> VMS buffer ${VMS_BUFFER} - not drawable, paint more cores or wider runs`);
    }
  });
  return {
    name: conf.name, kind: KIND_NAMES[ts.kind], geometry_id: ts.geometryId, ns: ts.ns,
    nst: ts.styles.length, ni: ts.entries.length, nk: ts.nk, dts_bytes: dtsLen,
    vram: ts.vram.length, vrl_bytes: st.stream_bytes, vrl_ratio: st.ratio,
    vms_bound: b0, vms_bound_bands: b1, vms_buffer: VMS_BUFFER,
    pool_bytes: conf.pool_bytes, styles: perStyle, rows, warnings: warns, infos,
  };
}

export const h2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');

export function reportMd(rp) {
  const L = [`# ${rp.name} (${rp.kind})`, '',
    `Geometry ID ${rp.geometry_id}, NS ${rp.ns}, NST ${rp.nst}, NI ${rp.ni}, NK ${rp.nk}`, '',
    `- DTS content: ${rp.dts_bytes} bytes`,
    `- VRAM U: ${rp.vram} bytes (Pool ${rp.pool_bytes})`,
    rp.vrl_ratio !== null ? `- VRL stream: ${rp.vrl_bytes} bytes, ratio ${pyFixed(rp.vrl_ratio, 3)}` : `- VRL stream: ${rp.vrl_bytes} bytes`,
    `- VMS bound: ${rp.vms_bound} / ${rp.vms_buffer} (bands separate: ${rp.vms_bound_bands})`, '',
    '## Totals per style', '', '| Style | VRAM | VMS |', '|---|---|---|'];
  for (const s of rp.styles) L.push(`| ${s.style} | ${s.vram} | ${s.vms} |`);
  L.push('', '## Images', '', '| Style | Slot | Value | Entry | Source | Cores | Core bytes | Edge | VMS | Alpha | OCCLUDING | ROWS |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rp.rows) {
    if (has(r, 'entry')) {
      L.push(`| ${r.style} | ${r.slot} | ${r.value} | ${r.entry} | ${r.source} | ${r.cores} | `
        + `${r.core_bytes} | ${r.edge} | ${r.vms} | ${r.alpha !== null ? r.alpha : ''} | `
        + `${+r.occluding} | ${+r.rows} |`);
    } else L.push(`| ${r.style} | ${r.slot} | $${h2(r.value)} |  | ${r.source} |  |  |  |  |  |  |  |`);
  }
  if (rp.warnings.length) L.push('', '## Warnings', '', ...rp.warnings.map((w) => `- ${w}`));
  if (rp.infos.length) L.push('', '## Infos', '', ...rp.infos.map((w) => `- ${w}`));
  return L.join('\n') + '\n';
}

export function fileKind(data, path = '') {
  const a = data[2], b = data[3];
  if (a === 0x44 && b === 0x54) return 'dts';
  if (a === 0x44 && b === 0x42) return 'dbg';
  if (a === 0x53 && b === 0x32) return 's2';
  throw new TexError(`${path}: neither DTS, DBG nor S2`);
}

/** VRAM budget over DTS/DBG/S2 files (dbetex.budget); the files are read through resolve(path). */
export function budget(paths, pool, { vmsBuffer = VMS_BUFFER, poolStart = null, resolve } = {}) {
  const files = [];
  let total = 0, vmsSum = 0;
  for (const p of paths) {
    const data = readVia(resolve, p);
    const k = fileKind(data, p);
    let u;
    if (k === 'dts') {
      const ts = fromDts(data);
      u = ts.u;
      const [b0, b1] = vmsBound(ts);
      files.push({ file: p, kind: KIND_NAMES[ts.kind], u, vms_bound: b0, vms_bound_bands: b1 });
      vmsSum += b0;
    } else if (k === 's2') {
      if (data.length < 2 + 32) throw new TexError(`${p}: S2 shorter than the header`);
      u = u16(data, 2 + 30);
      files.push({ file: p, kind: 'sprite', u });
    } else {
      u = fromDbg(data).u;
      files.push({ file: p, kind: 'background', u });
    }
    total += u;
  }
  let pos = poolStart;
  for (const f of files) {
    f.share = pool ? f.u / pool : null;
    if (pos !== null && pos !== undefined) { f.base = pos; pos += f.u; }
  }
  return {
    files, sum: total, pool, over: Math.max(0, total - pool), free: Math.max(0, pool - total),
    vms_sum: vmsSum, vms_buffer: vmsBuffer, vms_over: vmsSum > vmsBuffer,
  };
}

/** Checks the style numbers of a map against the DTS (dbetex check). m: dbemap Map; walls/floors/ceils:
 *  [path, DTS bytes] or null; dvg: [path, DVG PRG] or null. Returns {errors, used} (used = number of tiles checked). */
export function check(m, { walls = null, floors = null, ceils = null, dvg = null } = {}) {
  let gid = null;
  if (dvg) {
    const c = dvg[1].subarray(2);
    gid = u16(c, 12);
    if (gid !== dvgId(c)) throw new TexError(`${dvg[0]}: geometry ID does not match the content`);
  }
  const errs = [], sets = {};
  [[0, walls], [1, floors], [2, ceils]].forEach(([kind, f]) => {
    if (!f) return;
    const [path, data] = f;
    const ts = fromDts(data);
    if (ts.kind !== kind) { errs.push(`${path}: kind ${KIND_NAMES[ts.kind]}, expected ${KIND_NAMES[kind]}`); return; }
    sets[kind] = [ts, path];
    if (gid === null) gid = ts.geometryId;
    if (ts.geometryId !== gid) errs.push(`${path}: geometry ID ${ts.geometryId} != ${gid}`);
  });
  const used = [...new Set([...m.cells, m.outside])].sort((a, b) => a - b);
  for (const ti of used) {
    const t = m.tiles[ti];
    const nm = `${t.name} (tile ${ti})`;
    const groups = [[0, t.walls.map((v, i) => [v, `wall style ${'NESW'[i]}`])], [1, [[t.floor, 'floor style']]],
      [2, [[t.ceiling, 'ceiling style']]]];
    for (const [kind, vals] of groups) {
      if (!sets[kind]) continue;
      const nst = sets[kind][0].styles.length;
      for (const [v, what] of vals) if (v >= 1 && v - 1 >= nst) errs.push(`Tile ${nm}: ${what} ${v} > NST ${nst} in ${sets[kind][1]}`);
    }
  }
  return { errors: errs, used: used.length };
}

/** Abort if the file extends beyond its range of the bank 1 memory map (dbemem). */
export function checkBank1(kind, load, length) {
  const err = mem.rangeError(kind, load, length);
  if (err) throw new TexError(err);
}

/** f"{v:,}" with spaces as separators. */
export const groupThousands = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// ---------------------------------------------------------------- Whole commands (CLI and editors)

/** dbetex build: tex.toml -> {files: {name: Uint8Array | string}, report, warnings, infos, ts, conf, previews, stream}.
 *  files: <name>.dts, <name>.vrl, <name>.tex.json, <name>.tex.md; previews: [{name: <name>_<style>_preview.png,
 *  image: {width, height, rgb}}] (encode with io/png.js encodePng). */
export function buildTex(src, { path = 'tex.toml', resolve, out = null, strict = false, key = null, alphaThreshold = null,
  preview: withPreview = true } = {}) {
  const conf = loadTexConf(src, { path, out, strict, key, alphaThreshold });
  const { ts, warnings, infos } = buildTexset(conf, resolve);
  const dts = toDts(ts, conf.load);
  checkBank1(KIND_NAMES[ts.kind], conf.load, dts.length - 2);
  const stream = vrl.encode(Array.from(ts.vram));
  const vrlf = vrl.packFile(stream, conf.vrl_load);
  const rp = buildReport(ts, conf, warnings, infos, stream, dts.length - 2);
  const name = conf.name;
  const files = {
    [name + '.dts']: dts, [name + '.vrl']: vrlf,
    [name + '.tex.json']: pyDumps(rp, { indent: 1, ascii: false, floats: REPORT_FLOATS }) + '\n',
    [name + '.tex.md']: reportMd(rp),
  };
  const previews = [];
  if (withPreview) ts.styleNames.forEach((sn, i) => previews.push({ name: `${name}_${sn}_preview.png`, image: preview(ts, ts.geom, i) }));
  return { files, report: rp, warnings, infos, ts, conf, previews, stream };
}

/** dbetex bg: bg.toml -> {files: {<name>.dbg, <name>.vrl}, dbg, vram, warnings, conf, stream}. */
export function buildBg(src, { path = 'bg.toml', resolve, out = null, strict = false } = {}) {
  const conf = loadBgConf(src, { path, out, strict });
  const { dbg, vram, warnings } = buildBackground(conf, resolve);
  checkBank1('dbg', conf.load, dbg.length - 2);
  const stream = vrl.encode(Array.from(vram));
  const files = { [conf.name + '.dbg']: dbg, [conf.name + '.vrl']: vrl.packFile(stream, conf.vrl_load) };
  return { files, dbg, vram, warnings, conf, stream };
}
