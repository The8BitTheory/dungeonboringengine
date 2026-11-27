// Textures (P5): DTS and DBG readers, constants and the reference simulators of VDC-BASIC VMC/VMF/VMS.
// Port of the reader/runtime part of tools/dbetex.py. The builders (build_texset, to_dts, build_background,
// presets, reports) follow in P8 phase 2 (docs/specs/P8-js-tools.md).

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
 *  Needs ts.slots (slot rectangles) unless t0 is given and the entry is not a row fill; the geometry variant
 *  (slot_infos of a geom JSON) follows in phase 2. */
export function render(ts, style, slot, vram, fb, { ap = 0, origin = 0, stride = null, vb = 0, t0 = null } = {}) {
  stride = stride || ts.stride;
  let v = ts.styles[style][slot];
  if (v === FALLBACK) v = ts.styles[0][slot];
  if (v >= NOIMG) return false;
  const e = ts.entries[v];
  const slots = ts.slots;
  if (!slots) throw new TexError('render: slot rectangles (ts.slots) missing; geometry slots follow in phase 2');
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
