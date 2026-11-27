// Sprite sets (P5b): S2 reader, index lookup and clipping. Port of the reader/runtime part of tools/dbespr.py.
// The builder (build_spriteset, to_s2, Aseprite/PNG import, reports, preview) follows in P8 phase 2.
import { TexError, Core, checkVms } from './tex.js';

export const SprError = TexError;
export const HEAD = 40;
export const NOIMG = 0xFE, FALLBACK = 0xFF;
export const F_ITEM = 1, F_EDGE = 8;
export const MODES = Object.freeze({ forward: 0, reverse: 1, pingpong: 2 });
export const MODE_NAMES = Object.freeze(['forward', 'reverse', 'pingpong']);
export const DEFAULT_MAP = Object.freeze({ 1: [0, 0, 0, 0], 2: [0, 0, 1, 0], 3: [0, 1, 2, 1], 4: [0, 1, 2, 3] });
export const VMS_BUFFER_SHARED = 2304;

const EMPTY = new Uint8Array(0);

export class Img {
  constructor(w, h, fx, fy, { cores = [], edgeOfs = 0, edgeLen = 0, edge = EMPTY, vms = EMPTY, pix = [] } = {}) {
    Object.assign(this, { w, h, fx, fy, cores, edgeOfs, edgeLen, edge, vms, pix });
  }

  get flags() { return this.edgeLen ? F_EDGE : 0; }
}

export class Tag {
  constructor(name, first, count, mode, dur) { Object.assign(this, { name, first, count, mode, dur }); }
}

export class SpriteSet {
  constructor(geometryId, depth, stride, na, np, angleMap, flags, index, images, tags, vram = EMPTY) {
    Object.assign(this, { geometryId, depth, stride, na, np, angleMap, flags, index, images, tags, vram });
    this.u = 0; this.crc = 0; this.total = 0; this.nk = 0;
  }
}

/** binascii.crc_hqx (CRC-CCITT, polynomial 0x1021, not reflected). */
export function crcHqx(data, crc) {
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

const u16 = (c, o) => c[o] | (c[o + 1] << 8);

/** S2 PRG -> SpriteSet (vram optional). TexError on format errors.
 *  The content (without load address) is kept as ss.s2Content (VIEW needs offsets of the file for VCL type 9). */
export function fromS2(data, vram = null) {
  if (data.length < 2 + HEAD) throw new SprError('S2: file shorter than the header');
  const c = data.subarray(2);
  if (c[0] !== 0x53 || c[1] !== 0x32) throw new SprError("S2: wrong magic (expected 'S2')");
  if (c[2] !== 1) throw new SprError(`S2: version ${c[2]} not supported`);
  const flags = c[3], gid = u16(c, 4);
  const D = c[6], NA = c[7], NP = c[8], NI = c[9];
  const nk = u16(c, 10);
  const amap = Array.from(c.subarray(12, 16));
  const [oIdx, oDir, oCore, oTag] = [16, 18, 20, 22].map((o) => u16(c, o));
  const NT = c[24];
  const [oData, total, u, crc, stride] = [26, 28, 30, 32, 34].map((o) => u16(c, o));
  if (!(NA >= 1 && NA <= 4) || !(NP >= 1 && NP <= 32) || NI > 254 || NT > 32 || D < 1) {
    throw new SprError('S2: NA/NP/NI/NT/D outside the limits');
  }
  if (amap.some((v) => v >= NA)) throw new SprError('S2: angle_map refers to view angle >= NA');
  const ni = NP * NA * D;
  const exp = [HEAD, HEAD + ni, HEAD + ni + 16 * NI, HEAD + ni + 16 * NI + 8 * nk, HEAD + ni + 16 * NI + 8 * nk + 12 * NT];
  if ([oIdx, oDir, oCore, oTag, oData].some((v, i) => v !== exp[i])) {
    throw new SprError('S2: offsets in the header do not match the counts (areas not contiguous)');
  }
  if (c.length < total || total < oData) throw new SprError(`S2: file too short (${c.length} < ${total})`);
  if (vram !== null && (vram.length !== u || crcHqx(vram, 0xFFFF) !== crc)) {
    throw new SprError(`S2: VRL does not match (U ${vram.length} / ${u}, CRC)`);
  }
  const index = Array.from(c.subarray(oIdx, oIdx + ni));
  index.forEach((v, i) => {
    if (v < NOIMG && v >= NI) throw new SprError(`S2: index table refers to image ${v} >= NI ${NI}`);
    if (v === FALLBACK && i < NA * D) throw new SprError('S2: $FF in phase 0');
  });
  const images = [];
  for (let i = 0; i < NI; i++) {
    const o = oDir + 16 * i;
    const fl = c[o], w = c[o + 1], h = c[o + 2], fx = c[o + 3], fy = c[o + 4], nkk = c[o + 5];
    const kofs = u16(c, o + 6), rofs = u16(c, o + 8), rlen = u16(c, o + 10), vofs = u16(c, o + 12), vlen = u16(c, o + 14);
    if (!(w >= 1 && w <= 127 && h >= 1 && fx < w && fy < h)) throw new SprError(`S2: image ${i}: size/foot point invalid`);
    const im = new Img(w, h, fx, fy, { edgeOfs: rofs, edgeLen: rlen });
    if (!!(fl & F_EDGE) !== !!rlen) throw new SprError(`S2: image ${i}: EDGE flag does not match the edge length`);
    for (let j = 0; j < nkk; j++) {
      const k = kofs + 8 * j;
      const kw = c[k + 4], kh = c[k + 5], dx = c[k + 2], dy = c[k + 3];
      if (dx + kw > w || dy + kh > h) throw new SprError(`S2: image ${i}: core outside the image`);
      im.cores.push(new Core(u16(c, k), dx, dy, kw, kh, u16(c, k + 6)));
    }
    if (vlen) {
      if (vofs < oData || vofs + vlen > total) throw new SprError(`S2: image ${i}: VMS list outside the data area`);
      im.vms = c.slice(vofs, vofs + vlen);
      checkVms(im.vms, w, h, stride, `S2: image ${i}`);
    }
    if (vram !== null && rlen) im.edge = Uint8Array.from(vram.subarray(rofs, rofs + rlen));
    im.vofs = vofs;
    images.push(im);
  }
  const tags = [];
  for (let i = 0; i < NT; i++) {
    const b = c.subarray(oTag + 12 * i, oTag + 12 * i + 12);
    let e = 8;
    while (e > 0 && b[e - 1] === 0) e--;
    tags.push(new Tag(String.fromCharCode(...b.subarray(0, e)), b[8], b[9], b[10], b[11]));
  }
  const ss = new SpriteSet(gid, D, stride, NA, NP, amap, flags, index, images, tags, vram !== null ? Uint8Array.from(vram) : EMPTY);
  Object.assign(ss, { u, crc, total, nk });
  ss.s2Content = Uint8Array.from(c.subarray(0, total));
  return ss;
}

/** View angle a from player direction v and object direction o ($FF -> 0). */
export function viewAngle(v, o) { return o === 0xFF ? 0 : (2 + v - o) & 3; }

/** Image index for (phase, view angle a, depth d) or null (draw nothing). */
export function lookup(ss, phase, a, d) {
  if (!(d >= 1 && d <= ss.depth)) return null;
  if (phase >= ss.np) phase = 0;
  const ai = ss.angleMap[a & 3];
  let v = ss.index[(phase * ss.na + ai) * ss.depth + d - 1];
  if (v === FALLBACK) v = ss.index[ai * ss.depth + d - 1];
  return v >= NOIMG ? null : v;
}

/** Clips image entry img with top-left corner (x0, y0) to [cx0, cx1) x [cy0, cy1) (viewport coordinates).
 *  Returns {cores: [[src, x, y, w, h, srcstep]], vms: Uint8Array | null, edgeSrc, ref: [x, y]}. */
export function clipImage(img, x0, y0, cx0, cx1, cy0, cy1, stride) {
  const L = cx0 - x0, R = cx1 - x0, T = cy0 - y0, B = cy1 - y0;
  const full = L === 0 && R === img.w && T === 0 && B === img.h;
  const cores = [];
  for (const k of img.cores) {
    const st = k.srcstep || k.w;
    const a = Math.max(k.dx, L), b = Math.min(k.dx + k.w, R);
    const c = Math.max(k.dy, T), e = Math.min(k.dy + k.h, B);
    if (a >= b || c >= e) continue;
    const src = k.src + (c - k.dy) * st + (a - k.dx);
    const ss = a === k.dx && b === k.dx + k.w ? k.srcstep : st;
    cores.push([src, x0 + a, y0 + c, b - a, e - c, ss]);
  }
  if (full) return { cores, vms: img.vms && img.vms.length ? img.vms : null, edgeSrc: img.edgeOfs, ref: [x0, y0] };
  const out = [];
  let n = 0, has = false;
  if (img.vms && img.vms.length) {
    const v = img.vms;
    const cnt = v[1] | (v[2] << 8);
    let p = 3, r = 0, rs = 0, k = 0;
    for (let i = 0; i < cnt; i++) {
      const t = v[p];
      const ofs = v[p + 1] | (v[p + 2] << 8);
      while (ofs >= rs + stride) { rs += stride; r++; }
      if (r >= B) break;
      const col = ofs - rs;
      if (t === 1) {
        const ln = v[p + 3];
        p += 4;
        if (T <= r && r < B && col < R && col + ln > L) {
          const a = Math.max(col, L), b = Math.min(col + ln, R);
          k += a - col;
          if (k) { out.push(3, k & 255, k >> 8); n++; k = 0; }
          const o = (r - T) * stride + (a - L);
          out.push(1, o & 255, o >> 8, b - a); n++; has = true;
          k += col + ln - b;
        } else k += ln;
      } else if (t === 8) {
        p += 3;
        if (T <= r && r < B && L <= col && col < R) {
          if (k) { out.push(3, k & 255, k >> 8); n++; k = 0; }
          const o = (r - T) * stride + (col - L);
          out.push(8, o & 255, o >> 8); n++; has = true;
        } else k += 1;
      } else throw new SprError(`VMS list: type ${t} in image`);
    }
  }
  const vms = has ? Uint8Array.from([img.vms[0], n & 255, n >> 8, ...out]) : null;
  return { cores, vms, edgeSrc: img.edgeOfs, ref: [cx0, cy0] };
}
