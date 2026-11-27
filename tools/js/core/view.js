// Reference of the engine function VIEW (P6b): VCL list, VCL interpreter, independent painter. Port of tools/dbeview.py.
//
// Specification: docs/specs/P6-engine.md (sections 5 and 9.1); geometry P3 (DVG), map P4 (DMP), textures P5
// (DTS, DBG), sprites P5b (S2). The 6502 version must produce the list of view() byte for byte.
//
// API:
//   Scene, Obj, Result                 input and result
//   view(scene) -> Result              VCL and VMS bytes per P6 section 5 (a, x, vcl, vms, vcllen, vmslen, objvis)
//   runVcl(bank0, vram, addr)          VCL interpreter (types 1-8, 12, 13; VMS 1, 2, 3, 8; RXV via vrl)
//   paintReference(scene, vram)        painter without coverage and spans (plan order, everything that exists)
//   renderView(scene, vram)            view + runVcl into a VRAM image
//   decodeVcl(buf, off)                VCL list as arrays (for error messages when comparing lists)
//   loadScene(toml, resolve) / randomScene(seed, assets, ...) / budget(scenes)
//   buildDemoAssets({geomJson, dvg}) / makeS2 / makeSpriteSet / spritePixels   demo assets (P8 phase 2)
// assetsFromFiles() builds the same assets object from the DVG/DTS/DBG/S2 files.
import { PyRandom } from './pyrandom.js';
import { FLAGS, SUBPOS_VIEW, Map as DbeMap, Tile, validate as validateMap, loadsToml, fromDmp } from './map.js';
import * as tex from './tex.js';
import { fromS2 } from './spr.js';
import * as vrl from './vrl.js';
import { parseToml } from './io/toml.js';
import { encodePng } from './io/png.js';
import * as texdemo from './demo/texdemo.js';

export const ART_FRONT = 0, ART_SIDE = 1, ART_FLOOR = 2, ART_CEIL = 3, ART_OBJ = 4;
export const KIND_WALL = 0, KIND_FLOOR = 1, KIND_CEIL = 2;
export const { F_OCCLUDING, F_CUTOUT, F_ROWS, F_EDGE } = tex;
export const DVG_COVER = 1, DVG_BANDCOVER = 8;
export const T_SOLID = FLAGS.solid, T_OCCLUDING = FLAGS.occluding, T_CONTENT = FLAGS.content;
export const T_DISTANT = FLAGS.distant;               // P6 5.7a: inverts the ceiling rule of the far view
export const MAXITEM = 96;
export const MAX_SPANS = 4;
export const DEFAULT_BUF = Object.freeze([0x1300, 0x1C00]);
export const MAXCELL = 48, MAXWALL = 96, MAXPEND = 16, MAXCELLELEM = 16;   // GEOMSET limits of the element table (P6 7)
export const DEFAULT_DTS_ADDR = Object.freeze([0x8000, 0xEE00, 0xF600]);  // bank 1 addresses of the DTS (P6 2.4)
export const DEFAULT_S2_ADDR = 0x6000;                                     // bank 1 address of the first S2 (P6 2.4)
export const E_OK = 0, E_TOOMANY = 2, E_PARTIAL = 3;
export const FORE = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);     // F per direction v (N, E, S, W)
export const RIGHT = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]);    // R per direction v

/** Tunable limits (tests lower maxItem like the Python tests patch dbeview.MAXITEM). */
export const config = { maxItem: MAXITEM };

export class ViewError extends Error {
  constructor(msg) { super(msg); this.name = 'ViewError'; }
}

const EMPTY = new Uint8Array(0);
const hex4 = (v) => '0x' + v.toString(16).padStart(4, '0');
const u16 = (c, o) => c[o] | (c[o + 1] << 8);
const s8 = (b) => (b > 127 ? b - 256 : b);
const all = (a, c0, c1) => { for (let c = c0; c < c1; c++) if (!a[c]) return false; return true; };

// ---------------------------------------------------------------- DVG

export class Elem {
  constructor(index, art, d, s, flags, f = {}) {
    Object.assign(this, { index, art, d, s, flags, x: 0, y: 0, w: 0, h: 0, kx: 0, ky: 0, kw: 0, kh: 0, c0: 0, c1: 0, srcDx: 0, anchors: [] }, f);
  }

  clone() { const e = new Elem(this.index, this.art, this.d, this.s, this.flags, this); e.anchors = this.anchors.map((a) => a.slice()); return e; }
}

export class DepthRow {
  constructor(cy0, cy1, fy0, fy1, first, n, fw, fx) { Object.assign(this, { cy0, cy1, fy0, fy1, first, n, fw, fx }); }
  clone() { return new DepthRow(this.cy0, this.cy1, this.fy0, this.fy1, this.first, this.n, this.fw, this.fx); }
}

export class Dvg {
  constructor(vw, vh, D, S, stride, origin, gid, hy0, hy1, depth, elems) {
    Object.assign(this, { vw, vh, D, S, stride, origin, gid, hy0, hy1, depth, elems });
  }

  row(y) { return (this.origin + y * this.stride) & 0xFFFF; }

  /** Deep copy (copy.deepcopy). */
  clone() {
    return new Dvg(this.vw, this.vh, this.D, this.S, this.stride, this.origin, this.gid, this.hy0, this.hy1,
      this.depth.map((d) => d.clone()), this.elems.map((e) => e.clone()));
  }
}

/** DVG (PRG with load address) -> Dvg; ViewError on format errors. */
export function parseDvg(data, prg = true) {
  const c = prg ? data.subarray(2) : data;
  if (c.length < 24 || c[0] !== 0x44 || c[1] !== 0x56 || c[2] !== 1) throw new ViewError('DVG: magic/version');
  const vw = c[3], vh = c[4], D = c[5], S = c[6], ne = c[7];
  const stride = u16(c, 8), origin = u16(c, 10), gid = u16(c, 12);
  const hy0 = c[14], hy1 = c[15], elen = c[16], dlen = c[17];
  const oD = u16(c, 18), oE = u16(c, 20), total = u16(c, 22);
  if (elen !== 16 || dlen !== 8 || c.length < total || oD !== 24 || oE !== 24 + 8 * (D + 1) || total !== oE + 16 * ne) {
    throw new ViewError('DVG: lengths/offsets');
  }
  if (vw > 80 || vh > 100 || D > 7 || ne < 1) throw new ViewError('DVG: VW/VH/D/NE out of bounds');
  const depth = [];
  for (let d = 0; d <= D; d++) depth.push(new DepthRow(...c.subarray(oD + 8 * d, oD + 8 * d + 8)));
  const elems = [];
  for (let i = 0; i < ne; i++) {
    const r = c.subarray(oE + 16 * i, oE + 16 * i + 16);
    const e = new Elem(i, r[0], r[1], s8(r[2]), r[3]);
    if (e.art === ART_OBJ) {
      for (let p = 0; p < 5; p++) e.anchors.push([s8(r[4 + 2 * p]), r[5 + 2 * p]]);
    } else {
      Object.assign(e, { x: r[4], y: r[5], w: r[6], h: r[7], kx: r[8], ky: r[9], kw: r[10], kh: r[11], c0: r[12], c1: r[13], srcDx: r[14] });
    }
    elems.push(e);
  }
  checkElems(vw, vh, D, S, depth, elems);
  return new Dvg(vw, vh, D, S, stride, origin, gid, hy0, hy1, depth, elems);
}

/** Checks of the element table as in GEOMSET (P6 7); ViewError on violation. */
export function checkElems(vw, vh, D, S, depth, elems) {
  let ncell = 0, nwall = 0;
  depth.forEach((dt, d) => {
    if (dt.first + dt.n > elems.length) throw new ViewError(`DVG: depth ${d}: first + n > NE`);
    const seen = new Set();
    let cur = null, pend = 0, nel = 0, nfl = 0, nce = 0;
    for (const e of elems.slice(dt.first, dt.first + dt.n)) {
      if (e.art > ART_OBJ || Math.abs(e.s) > S) throw new ViewError(`DVG: Element ${e.index}: kind or s out of range`);
      if (e.s !== cur) {
        if (seen.has(e.s)) throw new ViewError(`DVG: elements of cell (${d}, ${e.s}) not contiguous (P3 5.3)`);
        seen.add(e.s);
        cur = e.s; nel = 0; nfl = 0; nce = 0;
        ncell++;
      }
      nel++;
      if (nel > MAXCELLELEM) throw new ViewError(`DVG: cell (${d}, ${e.s}) with more than ${MAXCELLELEM} elements`);
      if (e.art === ART_OBJ) continue;
      if (e.x + e.w > vw || e.y + e.h > vh) throw new ViewError(`DVG: Element ${e.index} outside the window`);
      if (e.art === ART_FRONT || e.art === ART_SIDE) {
        if (!(e.c0 <= e.c1 && e.c1 <= vw)) throw new ViewError(`DVG: Element ${e.index}: columns c0/c1`);
        nwall++;
        if (e.flags & DVG_COVER && (e.art === ART_SIDE || !(e.flags & DVG_BANDCOVER))) pend++;
      } else if (e.art === ART_FLOOR) nfl++;
      else nce++;
      if (nfl > 1 || nce > 1) throw new ViewError(`DVG: cell (${d}, ${e.s}) with more than one floor or ceiling element`);
    }
    if (pend > MAXPEND) throw new ViewError(`DVG: depth ${d}: more than ${MAXPEND} opaque sides/fronts without bit 3`);
  });
  if (ncell > MAXCELL || nwall > MAXWALL) throw new ViewError(`DVG: more than ${MAXCELL} cells or ${MAXWALL} walls`);
}

// ---------------------------------------------------------------- Scene

export class Obj {
  constructor(cell, set, dir = 0xFF, phase = 0, q = 4, hidden = false, noblock = false) {
    Object.assign(this, { cell, set, dir, phase, q, hidden, noblock });
  }

  byte5() { return (this.q & 7) | (this.hidden ? 0x40 : 0) | (this.noblock ? 0x80 : 0); }
}

export class Scene {
  constructor(dvg, dmp) {
    this.dvg = dvg;
    this.dmp = dmp;                              // map.js Map
    this.dts = [null, null, null];               // TexSet per kind (with .vram)
    this.dbg = null;                             // tex.fromDbg
    this.dbgVram = EMPTY;
    this.bgfill = 0;                             // fill byte without DBG (BGSET)
    this.farfill = null;                         // far-view fill byte (P6 5.7a), null = off
    this.s2 = new Array(8).fill(null);           // SpriteSet per set
    this.vramBases = { dts: [0, 0, 0], dbg: 0, s2: new Array(8).fill(0) };
    this.itemtab = new Array(64).fill(0);        // set + 1
    this.objects = [];
    this.itemph = 0;
    this.pos = 0;
    this.dir = 0;
    this.ap = 0;
    this.automap = false;                        // P6f: set automap bit 6 in dmp.content (view modifies dmp!)
    this.buf = DEFAULT_BUF.slice();
    this.bufFix = false;                         // P6j: BUFSET X bit 0 (fixed list address, jump at B0)
    this.vmsBank1 = false;                       // unclipped VMS lists from bank 1 (VCL type 9)
    this.dtsAddr = DEFAULT_DTS_ADDR.slice();     // bank 1 addresses of the DTS (content start), only for vmsBank1
    this.s2Addr = null;                          // bank 1 addresses of the S2 per set; null: packed from $6000
  }

  /** Shallow copy (copy.copy: lists and vramBases are shared). */
  copy() { return Object.assign(Object.create(Scene.prototype), this); }

  /** Bank 1 address (content start) of sprite set k. */
  s2Bank1(k) {
    if (this.s2Addr !== null) return this.s2Addr[k];
    let a = DEFAULT_S2_ADDR;
    const seen = new globalThis.Map();
    for (let j = 0; j < this.s2.length; j++) {
      const ss = this.s2[j];
      if (ss === null) continue;
      if (!seen.has(ss)) { seen.set(ss, a); a += s2Content(ss).length; }
      if (j === k) return seen.get(ss);
    }
    return 0;
  }

  /** Addresses of all window bytes (Set). */
  window() {
    const g = this.dvg, out = new Set();
    for (let y = 0; y < g.vh; y++) for (let x = 0; x < g.vw; x++) out.add((this.ap + g.row(y) + x) & 0xFFFF);
    return out;
  }

  /** [name, base, bytes] of all assets in VRAM. */
  assets() {
    const out = [];
    this.dts.forEach((ts, k) => { if (ts !== null && ts.vram.length) out.push([`dts${k}`, this.vramBases.dts[k], ts.vram]); });
    if (this.dbg !== null && this.dbgVram.length) out.push(['dbg', this.vramBases.dbg, this.dbgVram]);
    this.s2.forEach((ss, i) => { if (ss !== null && ss.vram.length) out.push([`s2_${i}`, this.vramBases.s2[i], ss.vram]); });
    return out;
  }

  /** 64 KB VRAM with random content (random.Random(seed)) and the assets at their bases. */
  makeVram(seed = 0) {
    const rnd = new PyRandom(seed);
    const vram = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) vram[i] = rnd.getrandbits(8);
    for (const [name, base, data] of this.assets()) {
      if (base + data.length > 65536) throw new ViewError(`${name}: base ${'0x' + base.toString(16).padStart(4, '0')} + ${data.length} bytes extends beyond the VRAM`);
      vram.set(data, base);
    }
    return vram;
  }

  /** Address ranges [from, to) of the view window (one range, two on overflow past 65535). */
  windowRanges() {
    const g = this.dvg;
    const w0 = (this.ap + g.origin) & 0xFFFF;
    const w1 = w0 + (g.vh - 1) * g.stride + g.vw;
    return w1 <= 65536 ? [[w0, w1]] : [[w0, 65536], [0, w1 - 65536]];
  }

  /** Do assets overlap each other or the window? */
  checkLayout() {
    const spans = this.assets().map(([n, b, d]) => [b, b + d.length, n])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
    for (let i = 0; i + 1 < spans.length; i++) {
      if (spans[i + 1][0] < spans[i][1]) throw new ViewError(`VRAM: ${spans[i][2]} and ${spans[i + 1][2]} overlap`);
    }
    for (const [a0, a1, n] of spans) {
      for (const [w0, w1] of this.windowRanges()) if (a0 < w1 && a1 > w0) throw new ViewError(`VRAM: ${n} overlaps the view window`);
    }
  }
}

/** Places the asset bases packed one after another: from the end of the view window (if it lies in the lower half
 *  of the VRAM) or from 0. */
export function layoutVram(scene, start = null, align = 1) {
  const wr = scene.windowRanges();
  if (start === null || start === undefined) start = wr.length === 2 ? wr[1][1] : (wr[0][1] <= 0x8000 ? wr[0][1] : 0);
  let p = start;
  const take = (n) => { const a = p; p = Math.floor((p + n + align - 1) / align) * align; return a; };
  scene.dts.forEach((ts, k) => { scene.vramBases.dts[k] = ts !== null ? take(ts.vram.length) : 0; });
  if (scene.dbg !== null) scene.vramBases.dbg = take(scene.dbgVram.length);
  scene.s2.forEach((ss, i) => { scene.vramBases.s2[i] = ss !== null ? take(ss.vram.length) : 0; });
  if (p > 65536) throw new ViewError(`VRAM pool too large: end 0x${p.toString(16)}`);
  scene.checkLayout();
  return scene;
}

export class Result {
  constructor(f = {}) {
    Object.assign(this, { a: 0, x: 0, y: 0, p0: 0, b0: 0, b1: 0, fix: false, vcl: EMPTY, vms: EMPTY, vcllen: 0, vmslen: 0,
      objvis: 0, partial: false, items: 0, lists1: new globalThis.Map() }, f);
  }

  /** VCL list (from the real start l0), then VMS lists (as the sim65 harness delivers it). */
  get buffer() { const b = new Uint8Array(this.vcl.length + this.vms.length); b.set(this.vcl); b.set(this.vms, this.vcl.length); return b; }

  /** Real start of the VCL list (= B1 - VCLLEN). */
  get l0() { return this.b1 - this.vcl.length; }

  /** Start of the VMS lists. */
  get m0() { return this.b0 + (this.fix ? 3 : 0); }

  /** Jump entry at B0 (bufFix only). */
  jump() { return this.fix ? Uint8Array.from([10, this.l0 & 255, this.l0 >> 8]) : EMPTY; }

  bank0() {
    const b = new Uint8Array(65536);
    b.set(this.vms, this.m0);
    b.set(this.vcl, this.l0);
    b.set(this.jump(), this.b0);
    return b;
  }

  bank1() {
    const b = new Uint8Array(65536);
    for (const [a, lst] of this.lists1) b.set(lst, a);
    return b;
  }
}

// ---------------------------------------------------------------- S2 access (only via the API from P5b 6.3)

/** Image index (P5b 4.2/6.3) or null; independent of spr.lookup, same rules. */
export function lookupImage(ss, phase, a, d) {
  if (!(d >= 1 && d <= ss.depth)) return null;
  if (phase >= ss.np) phase = 0;
  const ai = ss.angleMap[a & 3];
  let v = ss.index[(phase * ss.na + ai) * ss.depth + d - 1];
  if (v === 0xFF) v = ss.index[ai * ss.depth + d - 1];
  return v >= 0xFE ? null : v;
}

/** Clipping per P5b 6 (own version, reference for VIEW).
 *  img: w, h, cores (src, dx, dy, w, h, srcstep), vms (bytes or empty).
 *  Returns [cores, vms, ref]: cores = [[srcRel, x, y, w, reps, srcstep]] in the view window, vms = Uint8Array or null,
 *  ref = reference point [x, y] of the VMS list. */
export function clipImage(img, stride, x0, y0, cx0, cx1, cy0, cy1) {
  const L = cx0 - x0, R = cx1 - x0, T = cy0 - y0, B = cy1 - y0;
  const cores = [];
  for (const k of img.cores) {
    const st = k.srcstep || k.w;
    const a = Math.max(k.dx, L), b = Math.min(k.dx + k.w, R);
    const c = Math.max(k.dy, T), e = Math.min(k.dy + k.h, B);
    if (a >= b || c >= e) continue;
    cores.push([k.src + (c - k.dy) * st + (a - k.dx), x0 + a, y0 + c, b - a, e - c,
      a === k.dx && b === k.dx + k.w ? k.srcstep : st]);
  }
  const vms = img.vms && img.vms.length ? img.vms : null;
  if (!vms) return [cores, null, [x0, y0]];
  if (L === 0 && R === img.w && T === 0 && B === img.h) return [cores, vms, [x0, y0]];
  const cnt = vms[1] | (vms[2] << 8);
  const out = [];
  let n = 0, p = 3, r = 0, rs = 0, k = 0;
  for (let i = 0; i < cnt; i++) {
    const t = vms[p];
    const ofs = vms[p + 1] | (vms[p + 2] << 8);
    while (ofs >= rs + stride) { rs += stride; r++; }
    if (r >= B) break;
    const col = ofs - rs;
    if (t === 1) {
      const ln = vms[p + 3];
      p += 4;
      if (T <= r && r < B && col < R && col + ln > L) {
        const a = Math.max(col, L), b = Math.min(col + ln, R);
        k += a - col;
        if (k > 0) { out.push(3, k & 255, k >> 8); n++; k = 0; }
        const o = (r - T) * stride + (a - L);
        out.push(1, o & 255, o >> 8, b - a); n++;
        k += col + ln - b;
      } else k += ln;
    } else if (t === 8) {
      p += 3;
      if (T <= r && r < B && L <= col && col < R) {
        if (k > 0) { out.push(3, k & 255, k >> 8); n++; k = 0; }
        const o = (r - T) * stride + (col - L);
        out.push(8, o & 255, o >> 8); n++;
      } else k += 1;
    } else throw new ViewError(`VMS list: type ${t} in image`);
  }
  if (!out.length) return [cores, null, [cx0, cy0]];          // type 3 only precedes a visible command
  return [cores, Uint8Array.from([vms[0], n & 255, n >> 8, ...out]), [cx0, cy0]];
}

// ---------------------------------------------------------------- common helpers (view and painter)

export class Ctx {
  constructor(sc) {
    this.sc = sc;
    this.g = sc.dvg;
    this.m = sc.dmp;
    this.VW = this.g.vw; this.VH = this.g.vh; this.D = this.g.D;
    this.stride = this.g.stride;
    this.ne = this.g.elems.length;
    this.v = sc.dir & 3;
    this.px = sc.pos % this.m.width;
    this.py = Math.floor(sc.pos / this.m.width);
  }

  row(y) { return this.g.row(y); }

  cell(d, s) {
    const [fx, fy] = FORE[this.v], [rx, ry] = RIGHT[this.v];
    const x = this.px + d * fx + s * rx, y = this.py + d * fy + s * ry;
    if (x >= 0 && x < this.m.width && y >= 0 && y < this.m.height) return y * this.m.width + x;
    return null;
  }

  tile(c) { return this.m.tiles[c === null ? this.m.outside : this.m.cells[c]]; }

  content(c) { return c === null ? 0 : this.m.content[c]; }

  static faces(t) { return t.walls.some((w) => w); }

  static blocked(t) { return !!(t.flags & T_OCCLUDING) && t.walls.every((w) => w); }

  faceOf(e) {
    if (e.art === ART_FRONT) return (this.v + 2) & 3;
    return e.s < 0 ? (this.v + 1) & 3 : (this.v + 3) & 3;
  }

  /** [style, slot] of the image or null (P6 5.1 resolve). */
  resolveIdx(kind, slotindex, n) {
    const ts = this.sc.dts[kind];
    if (n === 0 || ts === null) return null;
    const st = n - 1;
    if (st >= ts.styles.length) return null;
    const k = ts.slotMap[slotindex];
    if (k === tex.FALLBACK) return null;
    let b = ts.styles[st][k];
    if (b === tex.FALLBACK) b = ts.styles[0][k];
    if (b >= tex.NOIMG) return null;
    return [st, k];
  }

  resolve(kind, slotindex, n) {
    const r = this.resolveIdx(kind, slotindex, n);
    if (r === null) return null;
    const ts = this.sc.dts[kind];
    const [st, k] = r;
    let b = ts.styles[st][k];
    if (b === tex.FALLBACK) b = ts.styles[0][k];
    return ts.entries[b];
  }

  bandSlot(kind, d) { return kind === KIND_CEIL ? this.ne + d : this.ne + this.D + 1 + d; }

  occ(e, t, ent) { return !!(e.flags & DVG_COVER) && !!(t.flags & T_OCCLUDING) && !!(ent.flags & F_OCCLUDING); }

  /** Cells of depth d: list [s, [elements]] as contiguous groups of equal s (P3 5.3). */
  cellsOf(d) {
    const dt = this.g.depth[d];
    const out = [];
    for (const e of this.g.elems.slice(dt.first, dt.first + dt.n)) {
      if (!out.length || out[out.length - 1][0] !== e.s) {
        if (out.some(([s]) => s === e.s)) throw new ViewError(`DVG: elements of cell (${d}, ${e.s}) not contiguous (P3 5.3)`);
        out.push([e.s, []]);
      }
      out[out.length - 1][1].push(e);
    }
    return out;
  }

  /** Order of the elements of a cell during the visibility pass: DVG order; with CONTENT flag and faces
   *  first fronts, then object slot, then sides (output backwards: sides, objects, fronts). */
  cellOrder(ce, t) {
    if (Ctx.faces(t) && t.flags & T_CONTENT) {
      return [...ce.filter((e) => e.art === ART_FRONT), ...ce.filter((e) => e.art === ART_OBJ),
        ...ce.filter((e) => e.art === ART_SIDE), ...ce.filter((e) => e.art === ART_FLOOR || e.art === ART_CEIL)];
    }
    return ce;
  }

  /** Far view (P6 5.7a): cell s of depth D per column of the horizon band. */
  farCols() {
    const dt = this.g.depth[this.D];
    const sides = this.g.elems.slice(dt.first, dt.first + dt.n).filter((e) => e.art === ART_SIDE);
    const out = [];
    for (let c = 0; c < this.VW; c++) {
      let s = 0;
      for (const e of sides) {
        if (e.s < 0) s -= c < e.x + e.w ? 1 : 0;
        else s += c >= e.x ? 1 : 0;
      }
      out.push(s);
    }
    return out;
  }

  /** Far view (P6 5.7a): Map s -> true = fill, for the cells of depth D.
   *  Ceiling style != 0 -> fill, ceiling style 0 -> wallpaper; tile flag DISTANT (bit 6) inverts this. */
  farDec() {
    const out = new globalThis.Map();
    for (const [s] of this.cellsOf(this.D)) {
      const t = this.tile(this.cell(this.D, s));
      out.set(s, (t.ceiling !== 0) !== !!(t.flags & T_DISTANT));
    }
    return out;
  }

  /** Decision for floor or ceiling band and tiles of depth d (P6 5.6, steps 1-4).
   *  null (nothing to draw) or {rows: [y0, y1], gap, ground: ['band', st, ent] | 'wallpaper' | null,
   *  tiles: [[element, n]] in DVG order, kind, bslot}. */
  bandPlan(d, kind) {
    const dt = this.g.depth[d];
    const [y0, y1] = kind === KIND_FLOOR ? [dt.fy0, dt.fy1] : [dt.cy0, dt.cy1];
    if (y1 <= y0) return null;
    const art = kind === KIND_FLOOR ? ART_FLOOR : ART_CEIL;
    const ts = this.sc.dts[kind];
    const info = [];                       // [element, n, style | 'any' | 'gap']
    for (const e of this.g.elems.slice(dt.first, dt.first + dt.n)) {
      if (e.art !== art) continue;
      const t = this.tile(this.cell(d, e.s));
      if (Ctx.blocked(t)) { info.push([e, 0, 'any']); continue; }
      const n = kind === KIND_FLOOR ? t.floor : t.ceiling;
      if (n === 0 || ts === null || n - 1 >= ts.styles.length) info.push([e, n, 'gap']);
      else info.push([e, n, n - 1]);
    }
    const live = info.filter((i) => i[2] !== 'any');
    if (!live.length) return null;
    const hasGap = live.some((i) => i[2] === 'gap');
    const styles = new Set(live.filter((i) => i[2] !== 'gap').map((i) => i[2]));
    const bslot = this.bandSlot(kind, d);
    const plan = { rows: [y0, y1], gap: false, ground: null, tiles: [], kind, bslot };
    if (!hasGap && styles.size === 1) {
      const st = [...styles][0];
      const ent = this.resolve(kind, bslot, st + 1);
      if (ent !== null) { plan.ground = ['band', st, ent]; return plan; }
    }
    if (hasGap) {
      plan.gap = true;
      plan.ground = 'wallpaper';
      plan.tiles = live.filter(([, , s]) => s !== 'gap').map(([e, n]) => [e, n]);
    } else {
      let st0 = null;
      for (const [, , s] of live) {
        if (this.resolve(kind, bslot, s + 1) !== null) { st0 = s; break; }
      }
      if (st0 !== null) {
        plan.ground = ['band', st0, this.resolve(kind, bslot, st0 + 1)];
        plan.tiles = live.filter(([, , s]) => s !== st0).map(([e, n]) => [e, n]);
      } else plan.tiles = live.map(([e, n]) => [e, n]);
    }
    return plan;
  }

  /** Objects of a cell in paint order: [p, set, direction, phase, object index | null]. */
  candidates(c) {
    if (c === null) return [];
    const out = [];
    this.sc.objects.slice(0, 16).forEach((o, i) => {
      if (o.cell === c && !o.hidden) out.push([SUBPOS_VIEW[this.v][Math.min(o.q & 7, 4)], 1 + i, o.set, o.dir, o.phase, i]);
    });
    const g = this.content(c) & 63;
    if (g && this.sc.itemtab[g]) out.push([2, 0, this.sc.itemtab[g] - 1, 0xFF, this.sc.itemph, null]);
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return out.map(([p, , s, dr, ph, oi]) => [p, s, dr, ph, oi]);
  }

  /** [SpriteSet, image, set] for the candidate at depth d or null (P6 5.8 step 3). */
  spriteImage(cand, d) {
    const [, setn, dr, ph] = cand;
    if (!(setn >= 0 && setn < 8) || this.sc.s2[setn] === null || this.sc.s2[setn] === undefined) return null;
    const ss = this.sc.s2[setn];
    const a = dr === 0xFF ? 0 : (2 + this.v - dr) & 3;
    const idx = lookupImage(ss, ph, a, d);
    if (idx === null) return null;
    return [ss, ss.images[idx], setn];
  }
}

// ---------------------------------------------------------------- VIEW

class Stop {}

/** Visibility list entry: list of VCL entries.
 *  ['vmc', src, dst, count, reps, step, srcstep] | ['vmf', vaddr, byte, count, reps, step] | ['vms', src, dst, bytes]
 *  | ['vms1', src, dst, bank1-address, bytes]: unclipped list from bank 1 (VCL type 9, no buffer bytes) */
export class Item {
  constructor(ents, obj = null) { this.ents = ents; this.obj = obj; }

  get v() {
    let n = 0;
    for (const e of this.ents) {
      if (e[0] === 'vmc') n += e[6] === 0 ? 11 : 13;
      else if (e[0] === 'vmf') n += e[4] === 1 ? 7 : 11;
      else n += 7;
    }
    return n;
  }

  get m() { let n = 0; for (const e of this.ents) if (e[0] === 'vms') n += e[3].length; return n; }

  stripEdge() { this.ents = this.ents.filter((e) => e[0] !== 'vms' && e[0] !== 'vms1'); }
}

/** VCL entry of a core; srcstep = length is type 2 (srcstep 0, P6h). The wallpaper always stays type 3. */
function coreVmc(src, dst, cnt, reps, step, ss) { return ['vmc', src, dst, cnt, reps, step, ss === cnt ? 0 : ss]; }

/** Group consecutive equal fill bytes: [[first row, count, byte]]. */
function fillGroups(fills) {
  const out = [];
  fills.forEach((b, i) => {
    if (out.length && out[out.length - 1][2] === b) out[out.length - 1][1]++;
    else out.push([i, 1, b]);
  });
  return out;
}

export class View extends Ctx {
  constructor(sc) {
    super(sc);
    this.cover = new Array(this.VW).fill(0);
    this.bcov = new Array(this.VW).fill(0);
    this.ncov = 0;
    this.items = [];
    this.nv = 1; this.nm = 0;
    this.err = 0;
    this.partial = false;
    this.objvis = 0;
    this.fix = sc.bufFix;
    this.BL = sc.buf[1] - sc.buf[0] - (this.fix ? 3 : 0);    // P6j: jump entry at B0
    this.pend = [];
    this.gap = { [KIND_FLOOR]: false, [KIND_CEIL]: false };
    this.far = false;
  }

  // ---- Masks
  mark(m, c0, c1) {
    for (let c = c0; c < c1; c++) {
      if (!m[c]) { m[c] = 1; if (m === this.cover) this.ncov++; }
    }
  }

  allcov(m, c0, c1) { return all(m, c0, c1); }

  spans(m) {
    const out = [];
    let c = 0;
    while (c < this.VW) {
      if (m[c]) { c++; continue; }
      const s = c;
      while (c < this.VW && !m[c]) c++;
      out.push([s, c]);
    }
    if (out.length > MAX_SPANS) return [[out[0][0], out[out.length - 1][1]]];
    return out;
  }

  // ---- Visibility list
  add(item) {
    if (this.items.length === config.maxItem) { this.err = E_TOOMANY; throw new Stop(); }
    let v = item.v, m = item.m;
    if (this.nv + v + this.nm + m <= this.BL) { /* fits */ } else if (m > 0 && v > 7 && this.nv + v - 7 + this.nm <= this.BL) {
      item.stripEdge();
      v -= 7; m = 0;
      this.partial = true;
    } else if (m > 0 && v === 7) {
      this.partial = true;
      return false;
    } else { this.err = E_TOOMANY; throw new Stop(); }
    this.items.push(item);
    this.nv += v;
    this.nm += m;
    if (item.obj !== null) this.objvis |= 1 << item.obj;
    return true;
  }

  // ---- Entries
  wallItem(kind, e, ent) {
    const sc = this.sc;
    const vb = sc.vramBases.dts[kind];
    const t0 = (sc.ap + this.row(e.y) + e.x) & 0xFFFF;
    if (ent.flags & F_ROWS) {
      return new Item(fillGroups(Array.from(ent.fill)).map(([r, n, b]) =>
        ['vmf', (sc.ap + this.row(e.y + r) + e.x) & 0xFFFF, b, e.w, n, this.stride]));
    }
    const ents = ent.cores.map((k) => coreVmc((vb + k.src) & 0xFFFF, (t0 + k.dy * this.stride + k.dx) & 0xFFFF, k.w, k.h,
      this.stride, k.srcstep));
    if (ent.flags & F_EDGE) ents.push(this.vmsEnt(kind, ent, (vb + ent.edgeOfs) & 0xFFFF, t0));
    return new Item(ents);
  }

  /** Unclipped VMS list: into the buffer or, with vmsBank1, as a reference to bank 1 (type 9). */
  vmsEnt(kind, ent, src, dst) {
    if (!this.sc.vmsBank1) return ['vms', src, dst, ent.vms];
    return ['vms1', src, dst, (this.sc.dtsAddr[kind] + vmsOffsets(this.sc.dts[kind]).get(ent)) & 0xFFFF, ent.vms];
  }

  /** BAND(ent, y0, c0, c1): band image (width VW, height rows) in the section [c0, c1) (P6 5.6). */
  bandItem(kind, ent, y0, rows, c0, c1) {
    const sc = this.sc;
    const vb = sc.vramBases.dts[kind];
    if (ent.flags & F_ROWS) {
      return new Item(fillGroups(Array.from(ent.fill)).map(([r, n, b]) =>
        ['vmf', (sc.ap + this.row(y0 + r) + c0) & 0xFFFF, b, c1 - c0, n, this.stride]));
    }
    const img = { w: this.VW, h: rows, cores: ent.cores, vms: ent.flags & F_EDGE ? ent.vms : EMPTY };
    const [cores, vms, ref] = clipImage(img, this.stride, 0, y0, c0, c1, y0, y0 + rows);
    if (vms && this.sc.vmsBank1 && c0 === 0 && c1 === this.VW) {          // full width: unclipped
      const item = this.clippedItem(vb, cores, null, ref, ent.edgeOfs);
      item.ents.push(this.vmsEnt(kind, ent, (vb + ent.edgeOfs) & 0xFFFF, (sc.ap + this.row(ref[1]) + ref[0]) & 0xFFFF));
      return item;
    }
    return this.clippedItem(vb, cores, vms, ref, ent.edgeOfs);
  }

  clippedItem(vb, cores, vms, ref, edgeOfs, obj = null) {
    const sc = this.sc;
    const ents = cores.map(([src, x, y, w, reps, ss]) =>
      coreVmc((vb + src) & 0xFFFF, (sc.ap + this.row(y) + x) & 0xFFFF, w, reps, this.stride, ss));
    if (vms) ents.push(['vms', (vb + edgeOfs) & 0xFFFF, (sc.ap + this.row(ref[1]) + ref[0]) & 0xFFFF, vms]);
    return new Item(ents, obj);
  }

  bgItem(r0, r1, c0, c1) {
    const sc = this.sc, stride = this.stride;
    const ents = [];
    if (sc.dbg === null) {
      ents.push(['vmf', (sc.ap + this.row(r0) + c0) & 0xFFFF, sc.bgfill, c1 - c0, r1 - r0, stride]);
      return new Item(ents);
    }
    const bg = sc.dbg;
    const { y0, h, P } = bg;
    const o = bg.offsets[this.v];
    const vb = sc.vramBases.dbg;
    const fillRows = (a, b) => {
      if (b <= a) return;
      const f = [];
      for (let i = a; i < b; i++) f.push(bg.fill[i]);
      for (const [r, n, byte] of fillGroups(f)) ents.push(['vmf', (sc.ap + this.row(a + r) + c0) & 0xFFFF, byte, c1 - c0, n, stride]);
    };
    fillRows(r0, Math.min(r1, y0));
    const a = Math.max(r0, y0), b = Math.min(r1, y0 + h);
    if (b > a) {
      const q = (o + c0) % P;
      const n = c1 - c0;
      const src = vb + (a - y0) * P;
      const dst = sc.ap + this.row(a) + c0;
      if (q + n <= P) ents.push(['vmc', (src + q) & 0xFFFF, dst & 0xFFFF, n, b - a, stride, P]);
      else {
        const n1 = P - q;
        ents.push(['vmc', (src + q) & 0xFFFF, dst & 0xFFFF, n1, b - a, stride, P]);
        ents.push(['vmc', src & 0xFFFF, (dst + n1) & 0xFFFF, n - n1, b - a, stride, P]);
      }
    }
    fillRows(Math.max(r0, y0 + h), r1);
    return new Item(ents);
  }

  // ---- Pass
  run() {
    try {
      for (let d = 0; d <= this.D; d++) {
        this.pend = [];
        this.gap = { [KIND_FLOOR]: false, [KIND_CEIL]: false };
        this.depthCells(d);
        this.seenFloor(d);
        this.bands(d, KIND_FLOOR);
        this.bands(d, KIND_CEIL);
        this.wallpaper(d);
        for (const [c0, c1, ziel] of this.pend) {
          this.mark(this.bcov, c0, c1);
          if (ziel === 'both') this.mark(this.cover, c0, c1);
        }
        if (this.far) this.distant();
        if (this.ncov === this.VW) break;
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
    }
    return this.output();
  }

  // ---- Automap (P6f): bit 6 "seen" of the content plane, only with Scene.automap
  seen(c) { if (this.sc.automap && c !== null) this.m.content[c] |= 0x40; }

  /** Cells with a not fully covered floor element mark themselves as seen (see dbeview.py). */
  seenFloor(d) {
    const dt = this.g.depth[d];
    if (!this.sc.automap || dt.fy1 <= dt.fy0) return;
    for (const e of this.g.elems.slice(dt.first, dt.first + dt.n)) {
      if (e.art !== ART_FLOOR) continue;
      const c = this.cell(d, e.s);
      if (c !== null && !Ctx.blocked(this.tile(c)) && !this.allcov(this.bcov, e.x, e.x + e.w)) this.seen(c);
    }
  }

  depthCells(d) {
    for (const [s, ce] of this.cellsOf(d)) {
      const c = this.cell(d, s);
      const t = this.tile(c);
      const faces = Ctx.faces(t);
      for (const e of this.cellOrder(ce, t)) {
        if (e.art === ART_FRONT || e.art === ART_SIDE) {
          if (!faces) continue;
          const ent = this.resolve(KIND_WALL, e.index, t.walls[this.faceOf(e)]);
          if (ent === null || this.allcov(this.cover, e.x, e.x + e.w)) continue;
          this.seen(c);
          this.add(this.wallItem(KIND_WALL, e, ent));
          if (this.occ(e, t, ent)) {
            if (e.art === ART_FRONT) {
              this.mark(this.cover, e.c0, e.c1);
              if (e.flags & DVG_BANDCOVER) this.mark(this.bcov, e.c0, e.c1);
              else this.pend.push([e.c0, e.c1, 'bcov']);
            } else this.pend.push([e.c0, e.c1, 'both']);
          }
        } else if (e.art === ART_OBJ && d >= 1 && (!faces || t.flags & T_CONTENT)) this.objects(d, e, c);
      }
    }
  }

  objects(d, e, c) {
    for (const cand of this.candidates(c).reverse()) {
      const r = this.spriteImage(cand, d);
      if (r === null) continue;
      const [ss, img, setn] = r;
      const p = cand[0], oi = cand[4];
      const [ax, ay] = e.anchors[p];
      const x0 = ax - img.fx, y0 = ay - img.fy;
      const cx0 = Math.max(x0, 0), cx1 = Math.min(x0 + img.w, this.VW);
      const cy0 = Math.max(y0, 0), cy1 = Math.min(y0 + img.h, this.sc.dvg.vh);
      if (cx0 >= cx1 || cy0 >= cy1) continue;
      if (this.allcov(this.cover, cx0, cx1)) continue;     // fully covered -> discard (P6i: occlusion via paint order)
      const [cores, vms, ref] = clipImage(img, this.stride, x0, y0, cx0, cx1, cy0, cy1);
      const vb = this.sc.vramBases.s2[setn];
      let item;
      if (vms && this.sc.vmsBank1 && cx0 === x0 && cx1 === x0 + img.w && cy0 === y0 && cy1 === y0 + img.h) {
        item = this.clippedItem(vb, cores, null, ref, img.edgeOfs, oi);          // unclipped: type 9
        item.ents.push(['vms1', (vb + img.edgeOfs) & 0xFFFF, (this.sc.ap + this.row(y0) + x0) & 0xFFFF,
          (this.sc.s2Bank1(setn) + s2Vofs(ss).get(img)) & 0xFFFF, img.vms]);
      } else item = this.clippedItem(vb, cores, vms, ref, img.edgeOfs, oi);
      if (item.v === 0) continue;
      this.add(item);
    }
  }

  bands(d, kind) {
    const plan = this.bandPlan(d, kind);
    if (plan === null) return;
    this.gap[kind] = plan.gap;
    const [y0, y1] = plan.rows;
    for (const [e, n] of plan.tiles) {
      const ent = this.resolve(kind, e.index, n);
      if (ent === null || this.allcov(this.bcov, e.x, e.x + e.w)) continue;
      this.add(this.wallItem(kind, e, ent));
    }
    const g = plan.ground;
    if (Array.isArray(g)) {
      for (const [c0, c1] of this.spans(this.bcov).reverse()) this.add(this.bandItem(kind, g[2], y0, y1 - y0, c0, c1));
    }
  }

  wallpaper(d) {
    const g = this.g.depth[d];
    const rows = [];
    if (this.gap[KIND_CEIL]) rows.push([g.cy0, g.cy1]);
    if (d === this.D && this.sc.farfill !== null && this.sc.farfill !== undefined) {
      this.fdec = this.farDec();
      this.far = [...this.fdec.values()].some((x) => x);       // otherwise as without far-view fill
    }
    if (d === this.D && !this.far) rows.push([this.g.hy0, this.g.hy1]);
    if (this.gap[KIND_FLOOR]) rows.push([g.fy0, g.fy1]);
    const merged = [];
    for (const [r0, r1] of rows) {
      if (r1 <= r0) continue;
      if (merged.length && merged[merged.length - 1][1] === r0) merged[merged.length - 1] = [merged[merged.length - 1][0], r1];
      else merged.push([r0, r1]);
    }
    const sp = this.spans(this.bcov);
    for (const [r0, r1] of merged.reverse()) {
      for (const [c0, c1] of sp.slice().reverse()) this.add(this.bgItem(r0, r1, c0, c1));
    }
  }

  /** Far view (P6 5.7a): horizon band of depth D after the waiting area, per run from right to left. */
  distant() {
    const r0 = this.g.hy0, r1 = this.g.hy1;
    if (r1 <= r0) return;
    const cols = this.farCols();
    if (cols.some((s) => !this.fdec.has(s))) {
      throw new ViewError('DVG: far-view column without cell of depth D (P6 5.7a: one side per cell, cells gapless)');
    }
    const f = cols.map((s) => this.fdec.get(s));
    for (const [c0, c1] of this.spans(this.bcov).reverse()) {
      let c = c1;
      while (c > c0) {
        let a = c - 1;
        while (a > c0 && f[a - 1] === f[c - 1]) a--;
        if (f[c - 1]) {
          this.add(new Item([['vmf', (this.sc.ap + this.row(r0) + a) & 0xFFFF, this.sc.farfill, c - a, r1 - r0, this.stride]]));
        } else this.add(this.bgItem(r0, r1, a, c));
        c = a;
      }
    }
  }

  // ---- Output (single pass, P6d-opt)
  /** Entries in generation order (front -> back); VMS lists upwards from B0, VCL entries downwards from B1. */
  output() {
    const [b0, b1] = this.sc.buf;
    const m0 = b0 + (this.fix ? 3 : 0);
    const parts = [], vmsParts = [], lists1 = new globalThis.Map();
    let vmsLen = 0;
    const rec = (t, ...ws) => { const a = [t]; for (const w of ws) a.push(w & 255, (w >> 8) & 255); return a; };
    for (const item of this.items) {
      for (const e of item.ents) {
        if (e[0] === 'vmc') {
          const [, src, dst, cnt, reps, step, ss] = e;
          parts.push(ss === 0 ? rec(2, src, dst, cnt, reps, step) : rec(3, src, dst, cnt, reps, step, ss));
        } else if (e[0] === 'vmf') {
          const [, va, byte, cnt, reps, step] = e;
          parts.push(reps === 1 ? rec(4, va, byte, cnt) : rec(5, va, byte, cnt, reps, step));
        } else if (e[0] === 'vms') {
          const [, src, dst, lst] = e;
          parts.push(rec(12, src, dst, (m0 + vmsLen) & 0xFFFF));
          vmsParts.push(lst);
          vmsLen += lst.length;
        } else {
          const [, src, dst, addr, lst] = e;
          parts.push(rec(9, src, dst, addr));
          lists1.set(addr, lst);
        }
      }
    }
    let n = 1;
    for (const p of parts) n += p.length;
    const vcl = new Uint8Array(n);
    let o = 0;
    for (let i = parts.length - 1; i >= 0; i--) { vcl.set(parts[i], o); o += parts[i].length; }
    const vms = new Uint8Array(vmsLen);
    o = 0;
    for (const l of vmsParts) { vms.set(l, o); o += l.length; }
    if (vcl.length !== this.nv || vms.length !== this.nm) {
      throw new ViewError(`internal error: size calculation ${this.nv}/${this.nm} != ${vcl.length}/${vms.length}`);
    }
    const a = this.err ? E_TOOMANY : (this.partial ? E_PARTIAL : E_OK);
    const p0 = this.fix ? b0 : b1 - vcl.length;          // P6j: fixed list address (jump at B0)
    return new Result({ a, x: Math.min(parts.length, 255), y: 0, p0, b0, b1, fix: this.fix, vcl, vms,
      vcllen: vcl.length, vmslen: vms.length, objvis: this.objvis, partial: this.partial, items: this.items.length, lists1 });
  }
}

const vofsCache = new WeakMap();

/** Map(directory entry -> vofs) (content-relative offset of the VMS list in the DTS file, P5). */
export function vmsOffsets(ts) {
  let cache = vofsCache.get(ts);
  if (!cache) {
    const c = (ts.dtsPrg || tex.toDts(ts)).subarray(2);
    const oDir = c[16] | (c[17] << 8);
    cache = new globalThis.Map(ts.entries.map((e, b) => [e, c[oDir + 16 * b + 10] | (c[oDir + 16 * b + 11] << 8)]));
    vofsCache.set(ts, cache);
  }
  return cache;
}

/** Content of the S2 file (without load address). */
export function s2Content(ss) {
  if (!ss.s2Content) throw new ViewError('S2 file bytes missing (ss.s2Content; to_s2 follows in phase 2)');
  return ss.s2Content;
}

const s2vofsCache = new WeakMap();

/** Map(image -> vofs) (content-relative offset of the VMS list in the S2 file, P5b). */
export function s2Vofs(ss) {
  let cache = s2vofsCache.get(ss);
  if (!cache) {
    const c = s2Content(ss);
    const oDir = c[18] | (c[19] << 8);
    cache = new globalThis.Map(ss.images.map((im, b) => [im, c[oDir + 16 * b + 12] | (c[oDir + 16 * b + 13] << 8)]));
    s2vofsCache.set(ss, cache);
  }
  return cache;
}

/** VIEW per P6 section 5: VMS lists from scene.buf[0], VCL list from Result.p0 to scene.buf[1] (single pass). */
export function view(scene) {
  if (!scene.dvg || !scene.dmp) throw new ViewError('E_STATE: DVG/map missing');
  return new View(scene).run();
}

// ---------------------------------------------------------------- VCL interpreter

function copyBytes(vram, s, d, n) {
  if (n <= 0) return;
  if (s + n <= 65536 && d + n <= 65536 && (d <= s || d >= s + n)) { vram.copyWithin(d, s, s + n); return; }
  for (let i = 0; i < n; i++) vram[(d + i) & 0xFFFF] = vram[(s + i) & 0xFFFF];
}

const sw = (v) => (v > 32767 ? v - 65536 : v);

/** VDC-BASIC VMC: srcstep 0 = source after the previous run. */
export function vmc(vram, src, dst, count, reps = 1, step = 0, srcstep = 0) {
  for (let r = 0; r < reps; r++) copyBytes(vram, (src + r * (srcstep || count)) & 0xFFFF, (dst + r * step) & 0xFFFF, count);
}

export function vmf(vram, dst, byte, count, reps = 1, step = 0) {
  const n = count || 65536;
  for (let r = 0; r < reps; r++) {
    const d = (dst + r * step) & 0xFFFF;
    for (let i = 0; i < n; i++) vram[(d + i) & 0xFFFF] = byte & 255;
  }
}

/** VDC-BASIC VMS per vms-format.md: Type 1, 8, 3 (v3), 2. */
export function vms(bank0, vram, src, dst, addr, rowstep = 80) {
  const alpha = bank0[addr];
  const n = bank0[addr + 1] | (bank0[addr + 2] << 8);
  let p = addr + 3, rd = src;
  for (let k = 0; k < n; k++) {
    const t = bank0[p];
    if (t === 1) {
      const ofs = bank0[p + 1] | (bank0[p + 2] << 8), ln = bank0[p + 3];
      p += 4;
      copyBytes(vram, rd & 0xFFFF, (dst + ofs) & 0xFFFF, ln);
      rd += ln;
    } else if (t === 8) {
      const ofs = bank0[p + 1] | (bank0[p + 2] << 8);
      p += 3;
      const b = vram[rd & 0xFFFF];
      rd += 1;
      const a = (dst + ofs) & 0xFFFF;
      if ((b & 15) === alpha) vram[a] = (b & 0xF0) | (vram[a] & 15);
      else vram[a] = (vram[a] & 0xF0) | (b & 15);
    } else if (t === 3) {
      rd += bank0[p + 1] | (bank0[p + 2] << 8);
      p += 3;
    } else if (t === 2) {
      const cnt = bank0[p + 1] | (bank0[p + 2] << 8), reps = bank0[p + 3] | (bank0[p + 4] << 8);
      p += 5;
      vmc(vram, rd & 0xFFFF, dst, cnt, reps, rowstep);
    } else throw new ViewError(`INVALID VMS COMMAND ${t}`);
  }
}

export function rxv(bank0, vram, src, dst) {
  let pos = dst;
  for (const t of vrl.decodeTokens(bank0.subarray(src))) {
    if (t.kind === 'end') break;
    if (t.kind === 'lit') t.value.forEach((b, i) => { vram[(pos + i) & 0xFFFF] = b; });
    else if (t.kind === 'run' || t.kind === 'lrun') for (let i = 0; i < t.length; i++) vram[(pos + i) & 0xFFFF] = t.value;
    pos += t.length;
  }
}

/** Executes the VCL list at addr in bank0 (vcl-format.md); modifies vram. Returns the number of entries.
 *  Type 13 (SYN) does nothing; type 9 like 12 with the list in bank1; type 10 continues at the address. */
export function runVcl(bank0, vram, addr, rowstep = 80, bank1 = null) {
  let p = addr, count = 0;
  const w = (i) => bank0[p + i] | (bank0[p + i + 1] << 8);
  for (;;) {
    const t = bank0[p];
    if (t === 0) return count;
    count++;
    if (t === 1) { vmc(vram, w(1), w(3), w(5)); p += 7; }
    else if (t === 2) { vmc(vram, w(1), w(3), w(5), (w(7) & 255) || 256, sw(w(9))); p += 11; }
    else if (t === 3) { vmc(vram, w(1), w(3), w(5), (w(7) & 255) || 256, sw(w(9)), sw(w(11))); p += 13; }
    else if (t === 4) { vmf(vram, w(1), w(3) & 255, w(5)); p += 7; }
    else if (t === 5) { vmf(vram, w(1), w(3) & 255, w(5), (w(7) & 255) || 256, sw(w(9))); p += 11; }
    else if (t === 6) { vram[w(1)] = w(3) & 255; p += 5; }
    else if (t === 7) {
      const reps = (w(5) & 255) || 1;
      for (let r = 0; r < reps; r++) vram[(w(1) + r * sw(w(7))) & 0xFFFF] = w(3) & 255;
      p += 9;
    } else if (t === 8) { rxv(bank0, vram, w(1), w(3)); p += 5; }
    else if (t === 12) { vms(bank0, vram, w(1), w(3), w(5), rowstep); p += 7; }
    else if (t === 9 && bank1 !== null) { vms(bank1, vram, w(1), w(3), w(5), rowstep); p += 7; }
    else if (t === 13) p += 3 + 4 * (w(1) & 255);
    else if (t === 10) { count--; p = w(1); }             // VDC-BASIC v3 P2e: continue at address (not an entry)
    else throw new ViewError(`INVALID VCL type ${t} at ${hex4(p)}`);
  }
}

const VCL_LENS = { 1: 3, 2: 5, 3: 6, 4: 3, 5: 5, 6: 2, 7: 4, 8: 2, 9: 3, 12: 3 };

/** VCL list from buf[off] as a list of arrays [type, parameters...] up to the end byte (excluding it). */
export function decodeVcl(buf, off = 0) {
  const out = [];
  let p = off;
  while (buf[p]) {
    const t = buf[p];
    if (t === 13) {
      const n = (buf[p + 1] | (buf[p + 2] << 8)) & 255;
      out.push([13, n]);
      p += 3 + 4 * n;
      continue;
    }
    const n = VCL_LENS[t];
    if (n === undefined) throw new ViewError(`${t}`);       // Python: KeyError
    const e = [t];
    for (let i = 0; i < n; i++) e.push(buf[p + 1 + 2 * i] | (buf[p + 2 + 2 * i] << 8));
    out.push(e);
    p += 1 + 2 * n;
  }
  return out;
}

/** view() and runVcl() into a VRAM image (random content if not given). Returns [vram, Result]. */
export function renderView(scene, vram = null, res = null, seed = 0) {
  res = res || view(scene);
  if (vram === null) vram = scene.makeVram(seed);
  runVcl(res.bank0(), vram, res.p0, 80, res.bank1());
  return [vram, res];
}

// ---------------------------------------------------------------- independent painter

class Painter extends Ctx {
  constructor(sc, vram) {
    super(sc);
    this.vram = vram;
    this.ts = sc.dts.map((ts) => {
      if (ts === null) return null;
      const w = ts.copy();
      w.slots = this.synthSlots(ts);
      return w;
    });
  }

  synthSlots(ts) {
    const slots = new Array(ts.slotMap.filter((v) => v !== tex.FALLBACK).length).fill(null);
    ts.slotMap.forEach((k, pos) => {
      if (k === tex.FALLBACK) return;
      if (pos < this.ne) {
        const e = this.g.elems[pos];
        slots[k] = { rect: [e.x, e.y, e.w, e.h] };
      } else {
        const i = pos - this.ne;
        const d = i <= this.D ? i : i - this.D - 1;
        const dt = this.g.depth[d];
        const [y0, y1] = i <= this.D ? [dt.cy0, dt.cy1] : [dt.fy0, dt.fy1];
        slots[k] = { rect: [0, y0, this.VW, y1 - y0] };
      }
    });
    return slots;
  }

  putEntry(kind, st, k, x, y) {
    const sc = this.sc;
    const t0 = (sc.ap + this.row(y) + x) & 0xFFFF;
    tex.render(this.ts[kind], st, k, this.vram, this.vram, { stride: this.stride, vb: sc.vramBases.dts[kind], t0 });
  }

  /** Wallpaper for the rows [r0, r1), full width, bytewise (independent of spans and VMC). */
  rowFill(r0, r1) {
    const sc = this.sc;
    for (let r = r0; r < r1; r++) {
      const base = sc.ap + this.row(r);
      if (sc.dbg === null) {
        for (let x = 0; x < this.VW; x++) this.vram[(base + x) & 0xFFFF] = sc.bgfill;
        continue;
      }
      const bg = sc.dbg;
      const { y0, h, P } = bg;
      if (y0 <= r && r < y0 + h) {
        const o = bg.offsets[this.v];
        for (let x = 0; x < this.VW; x++) {
          this.vram[(base + x) & 0xFFFF] = this.vram[(sc.vramBases.dbg + (r - y0) * P + (o + x) % P) & 0xFFFF];
        }
      } else for (let x = 0; x < this.VW; x++) this.vram[(base + x) & 0xFFFF] = bg.fill[r];
    }
  }

  /** Draws the image clipped at the window: image unclipped into two scratch buffers (0x00 / 0xFF),
   *  nibbles that are equal in both were written by the image; only those go into the window. */
  sprite(ss, img, setn, x0, y0) {
    const sc = this.sc, stride = this.stride;
    const vb = sc.vramBases.s2[setn];
    const size = img.h * stride + 130;
    const bufs = [0x00, 0xFF].map((fill) => {
      const fb = new Uint8Array(size).fill(fill);
      for (const k of img.cores) tex.simVmc(this.vram, vb + k.src, k.dy * stride + k.dx, k.w, k.h, stride, k.srcstep, fb);
      if (img.vms && img.vms.length) tex.simVms(this.vram, vb + img.edgeOfs, 0, img.vms, fb);
      return fb;
    });
    const [a, b] = bufs;
    for (let r = 0; r < img.h; r++) {
      const wy = y0 + r;
      if (!(wy >= 0 && wy < this.VH)) continue;
      for (let bx = 0; bx < img.w; bx++) {
        const wx = x0 + bx;
        if (!(wx >= 0 && wx < this.VW)) continue;
        const va = a[r * stride + bx], vb2 = b[r * stride + bx];
        const addr = (sc.ap + this.row(wy) + wx) & 0xFFFF;
        let cur = this.vram[addr];
        if (va >> 4 === vb2 >> 4) cur = (cur & 0x0F) | (va & 0xF0);
        if ((va & 15) === (vb2 & 15)) cur = (cur & 0xF0) | (va & 15);
        this.vram[addr] = cur;
      }
    }
  }

  objects(d, e, c) {
    for (const cand of this.candidates(c)) {
      const r = this.spriteImage(cand, d);
      if (r === null) continue;
      const [ss, img, setn] = r;
      const [ax, ay] = e.anchors[cand[0]];
      this.sprite(ss, img, setn, ax - img.fx, ay - img.fy);
    }
  }

  band(d, kind) {
    const plan = this.bandPlan(d, kind);
    if (plan === null) return;
    const [y0] = plan.rows;
    const g = plan.ground;
    if (Array.isArray(g)) {
      const r = this.resolveIdx(kind, plan.bslot, g[1] + 1);
      this.putEntry(kind, r[0], r[1], 0, y0);
    }
    for (const [e, n] of plan.tiles.slice().reverse()) {     // outside -> inside (edge pixels of neighbours overlap)
      const r = this.resolveIdx(kind, e.index, n);
      if (r !== null) this.putEntry(kind, r[0], r[1], e.x, e.y);
    }
  }

  run() {
    for (let d = this.D; d >= 0; d--) {
      const pf = this.bandPlan(d, KIND_FLOOR), pc = this.bandPlan(d, KIND_CEIL);
      const dt = this.g.depth[d];
      const rows = [];
      if (pc && pc.gap) rows.push([dt.cy0, dt.cy1]);
      if (d === this.D) rows.push([this.g.hy0, this.g.hy1]);
      if (pf && pf.gap) rows.push([dt.fy0, dt.fy1]);
      for (const [r0, r1] of rows) this.rowFill(r0, r1);
      if (d === this.D && this.sc.farfill !== null && this.sc.farfill !== undefined) {   // far view (5.7a)
        const dec = this.farDec();
        this.farCols().forEach((s, x) => {
          if (dec.get(s)) {
            for (let r = this.g.hy0; r < this.g.hy1; r++) this.vram[(this.sc.ap + this.row(r) + x) & 0xFFFF] = this.sc.farfill;
          }
        });
      }
      this.band(d, KIND_CEIL);
      this.band(d, KIND_FLOOR);
      for (const [s, ce] of this.cellsOf(d).reverse()) {
        const c = this.cell(d, s);
        const t = this.tile(c);
        const faces = Ctx.faces(t);
        const order = this.cellOrder(ce, t).slice().reverse();     // paint order = reverse of the visibility order
        for (const e of order) {
          if ((e.art === ART_FRONT || e.art === ART_SIDE) && faces) {
            const r = this.resolveIdx(KIND_WALL, e.index, t.walls[this.faceOf(e)]);
            if (r !== null) this.putEntry(KIND_WALL, r[0], r[1], e.x, e.y);
          } else if (e.art === ART_OBJ && d >= 1 && (!faces || t.flags & T_CONTENT)) this.objects(d, e, c);
        }
      }
    }
  }
}

/** Paints everything that exists per map and styles, in plan order (plan 5): without coverage and spans,
 *  bands and wallpaper full width, sprites clipped only at the window. Modifies only the view window. */
export function paintReference(scene, vram) {
  new Painter(scene, vram).run();
  return vram;
}

// ---------------------------------------------------------------- Image of the view window

/** RGB image {width, height, rgb} of the view window (dbetex.fb_to_image). */
export function windowImage(scene, vram, zoom = 1) {
  const g = scene.dvg;
  return tex.fbToImage(vram, g.vw, g.vh, g.stride, (scene.ap + g.origin) & 0xFFFF, zoom);
}

/** Window bytes as an array of rows (Uint8Array). */
export function windowBytes(scene, vram) {
  const g = scene.dvg, out = [];
  for (let y = 0; y < g.vh; y++) {
    const r = new Uint8Array(g.vw);
    for (let x = 0; x < g.vw; x++) r[x] = vram[(scene.ap + g.row(y) + x) & 0xFFFF];
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- Assets

/** Assets object (dbeview.Assets) from the files of build_demo_assets:
 *  {dvg: DVG PRG, walls/floor/ceil: [DTS PRG, VRAM bytes], dbg: [DBG PRG, VRAM bytes], sprites: [[S2 PRG, VRAM bytes] | null]}. */
export function assetsFromFiles(f) {
  const sprites = new Array(8).fill(null);
  (f.sprites || []).forEach((s, i) => { if (s) sprites[i] = fromS2(s[0], s[1]); });
  return {
    dvg: parseDvg(f.dvg), geom: f.geom || null, walls: tex.fromDts(f.walls[0], f.walls[1]),
    floor: tex.fromDts(f.floor[0], f.floor[1]), ceil: tex.fromDts(f.ceil[0], f.ceil[1]),
    dbg: f.dbg ? tex.fromDbg(f.dbg[0]) : null, dbgVram: f.dbg ? Uint8Array.from(f.dbg[1]) : EMPTY,
    sprites, dir: f.dir || '', dvgPrg: Uint8Array.from(f.dvg),
  };
}

/** Copy of the Dvg with DVG flag bit 3 (band coverage) set on all fronts that contain the band rows. */
export function withBandCover(dvg) {
  const d2 = dvg.clone();
  for (const e of d2.elems) {
    if (e.art === ART_FRONT) {
      const dt = d2.depth[e.d];
      if (e.y <= dt.cy0 && e.y + e.h >= dt.fy1) e.flags |= DVG_BANDCOVER;
    }
  }
  return d2;
}

/** Copy of the Dvg without DVG flag bit 3. */
export function withoutBandCover(dvg) {
  const d2 = dvg.clone();
  for (const e of d2.elems) e.flags &= ~DVG_BANDCOVER;
  return d2;
}

/** Dvg -> DVG PRG (P3 5); the geometry ID is kept (not recomputed). */
export function dvgBytes(dvg, load = 0xE800) {
  const D = dvg.D, ne = dvg.elems.length;
  const oD = 24, oE = 24 + 8 * (D + 1), total = oE + 16 * ne;
  const out = new Uint8Array(2 + total);
  const w16 = (o, v) => { out[o] = v & 255; out[o + 1] = (v >> 8) & 255; };
  w16(0, load);
  out.set([0x44, 0x56, 1, dvg.vw, dvg.vh, D, dvg.S, ne], 2);
  w16(10, dvg.stride); w16(12, dvg.origin); w16(14, dvg.gid);
  out.set([dvg.hy0, dvg.hy1, 16, 8], 16);
  w16(20, oD); w16(22, oE); w16(24, total);
  dvg.depth.forEach((dt, d) => out.set([dt.cy0, dt.cy1, dt.fy0, dt.fy1, dt.first, dt.n, dt.fw, dt.fx], 2 + oD + 8 * d));
  dvg.elems.forEach((e, i) => {
    const r = e.art === ART_OBJ
      ? [e.art, e.d, e.s & 255, 0, ...e.anchors.flatMap(([ax, ay]) => [ax & 255, ay]), 0, 0]
      : [e.art, e.d, e.s & 255, e.flags, e.x, e.y, e.w, e.h, e.kx, e.ky, e.kw, e.kh, e.c0, e.c1, e.srcDx, 0];
    out.set(r, 2 + oE + 16 * i);
  });
  return out;
}

/** Synthetic geometry with two front faces per cell (P6 9.3 random / 9.5 Crawl); see dbeview.double_fronts.
 *  Returns assets with new Dvg and adjusted slot maps of the three DTS (dvgPrg regenerated). */
export function doubleFronts(assets, objs = false) {
  const g = assets.dvg;
  const elems = [], src = [], depth = [];
  let k = 0;
  const after = new globalThis.Map();         // copy -> reference element (Python attribute _after)
  g.depth.forEach((dt, d) => {
    const first = elems.length;
    const cells = [];
    for (const e of g.elems.slice(dt.first, dt.first + dt.n)) {
      if (!cells.length || cells[cells.length - 1][0] !== e.s) cells.push([e.s, []]);
      cells[cells.length - 1][1].push(e);
    }
    for (const [, ce] of cells) {
      const out = [];
      for (const e of ce) {
        out.push(e);
        if (e.art === ART_FRONT && d >= 1) {
          let sh = [-1, 1, 0][k % 3];
          if (e.x + sh < 0 || e.x + e.w + sh > g.vw) sh = 0;
          const dup = e.clone();
          dup.x += sh;
          if (dup.flags & DVG_COVER) { dup.c0 = e.c0 + sh; dup.c1 = e.c1 + sh; }
          if (k & 1) {                       // behind the side of the cell
            const side = ce.find((x) => x.art === ART_SIDE);
            after.set(dup, side || e);
          } else after.set(dup, e);
          k++;
          out.push(dup);
        } else if (objs && e.art === ART_OBJ && d >= 1) {
          const dup = e.clone();
          dup.anchors = e.anchors.map(([ax, ay]) => [Math.max(-128, Math.min(127, ax + (k & 1 ? 3 : -3))), Math.min(255, ay + 1)]);
          after.set(dup, e);
          k++;
          out.push(dup);
        }
      }
      // re-sort copies behind their reference element
      const ordered = out.filter((x) => !after.has(x));
      for (const x of out.filter((y) => after.has(y))) {
        let i = ordered.indexOf(after.get(x));
        while (i + 1 < ordered.length && after.has(ordered[i + 1])) i++;
        ordered.splice(i + 1, 0, x);
      }
      for (const x of ordered) {
        src.push(x.index);
        const y = x.clone();
        y.index = elems.length;
        elems.push(y);
      }
    }
    depth.push(new DepthRow(dt.cy0, dt.cy1, dt.fy0, dt.fy1, first, elems.length - first, dt.fw, dt.fx));
  });
  if (elems.length > 255) throw new ViewError('double_fronts: more than 255 elements');
  const g2 = new Dvg(g.vw, g.vh, g.D, g.S, g.stride, g.origin, g.gid, g.hy0, g.hy1, depth, elems);

  const ts2 = (ts) => {
    const t = ts.copy();
    t.slotMap = [...src.map((i) => ts.slotMap[i]), ...ts.slotMap.slice(g.elems.length)];
    t.ne = elems.length;
    // DTS bytes: the file of the template with longer slot map and shifted offsets
    if (!ts.dtsPrg) throw new ViewError('DTS file bytes missing (ts.dtsPrg; to_dts follows in phase 2)');
    const c = Uint8Array.from(ts.dtsPrg.subarray(2));
    const r16 = (o) => c[o] | (c[o + 1] << 8);
    const w16 = (o, v) => { c[o] = v & 255; c[o + 1] = (v >> 8) & 255; };
    const delta = t.slotMap.length - ts.slotMap.length;
    const [oSlot, oStyle, oDir, oCore, oData, total] = [12, 14, 16, 18, 20, 22].map(r16);
    const ni = c[10];
    for (let i = 0; i < ni; i++) {
      for (const off of [4, 10]) {
        const v = r16(oDir + 16 * i + off);
        if (v) w16(oDir + 16 * i + off, v + delta);
      }
    }
    c[6] = t.ne;
    [oSlot, oStyle + delta, oDir + delta, oCore + delta, oData + delta, total + delta].forEach((v, i) => w16(12 + 2 * i, v));
    const prg = new Uint8Array(2 + oSlot + t.slotMap.length + (c.length - oStyle));
    prg.set([0x00, 0x80]);
    prg.set(c.subarray(0, oSlot), 2);
    prg.set(t.slotMap, 2 + oSlot);
    prg.set(c.subarray(oStyle), 2 + oSlot + t.slotMap.length);
    t.dtsPrg = prg;
    const t2 = tex.fromDts(prg, ts.vram);
    if (t2.slotMap.join() !== t.slotMap.join()) throw new ViewError('double_fronts: slot map check failed');
    return t;
  };
  return { ...assets, dvg: g2, walls: ts2(assets.walls), floor: ts2(assets.floor), ceil: ts2(assets.ceil), dvgPrg: dvgBytes(g2) };
}

/** Scene from assets and map (dbeview.make_scene); options with Python's keyword names in camelCase. */
export function makeScene(assets, dmp, { pos = null, direction = null, objects = [], itemtab = null, itemph = 0, ap = 0,
  dbg = true, bgfill = 0x33, bandCover = false, buf = DEFAULT_BUF, sprites = true, start = null, farfill = null } = {}) {
  const sc = new Scene(bandCover ? withBandCover(assets.dvg) : withoutBandCover(assets.dvg), dmp);
  sc.dts = [assets.walls, assets.floor, assets.ceil];
  if (dbg) { sc.dbg = assets.dbg; sc.dbgVram = assets.dbgVram; }
  sc.bgfill = bgfill;
  sc.farfill = farfill;
  if (sprites) sc.s2 = assets.sprites.slice();
  sc.itemtab = itemtab && itemtab.length ? itemtab.slice() : new Array(64).fill(0);
  sc.objects = objects.slice();
  sc.itemph = itemph;
  sc.pos = pos === null ? dmp.start : pos;
  sc.dir = direction === null ? dmp.direction : direction;
  sc.ap = ap;
  sc.buf = buf.slice();
  return layoutVram(sc, start);
}

// ---------------------------------------------------------------- Random scenes

/** Random map with wall, grate, door, abyss and floor tiles (P6 9.3 random). rnd: PyRandom. */
export function randomMap(rnd, w, h, ntStyles = [4, 3, 3], name = 'random') {
  const [nw, nf, nc] = ntStyles;
  const T = (walls, floor, ceil, flags, ch, n = '') => new Tile(walls, floor, ceil, flags, ch, n);
  const tiles = [T([0, 0, 0, 0], 1, 1, 0, 0, 'corridor')];
  const nTiles = rnd.randint(8, 14);
  for (let i = 0; i < nTiles; i++) {
    let kind = rnd.choice(['wall', 'wall', 'grating', 'door', 'free', 'free', 'free', 'abyss', 'block']);
    if (i < 2) kind = ['wall', 'grating'][i];        // at least one wall and one grate tile
    const floor = kind !== 'wall' && kind !== 'block' ? rnd.choice([0, 1, 1, 2, 3, nf + 1]) : rnd.choice([0, 1]);
    const ceil = rnd.choice([0, 1, 1, 2, 3, nc + 1]);
    if (kind === 'wall') {
      const st = rnd.randint(1, nw);
      const walls = rnd.random() < 0.7 ? [st, st, st, st] : [0, 1, 2, 3].map(() => rnd.randint(1, nw));
      tiles.push(T(walls, 0, 0, T_SOLID | T_OCCLUDING, 0));
    } else if (kind === 'block') {                   // opaque, but not all faces -> floor/ceiling count
      const a = rnd.randint(1, nw), b = rnd.randint(1, nw), c = rnd.randint(0, nw);
      tiles.push(T([a, 0, b, c], floor, ceil, T_SOLID | T_OCCLUDING, 0));
    } else if (kind === 'grating' || kind === 'door') {
      const st = rnd.randint(1, nw);
      let fl = (rnd.random() < 0.5 ? T_SOLID : 0) | (rnd.random() < 0.3 ? T_OCCLUDING : 0);
      fl |= rnd.random() < 0.5 ? T_CONTENT : 0;
      const a = rnd.randint(0, nw), b = rnd.randint(0, nw);
      tiles.push(T([st, a, st, b], floor, ceil, fl, 0));
    } else if (kind === 'abyss') tiles.push(T([0, 0, 0, 0], 0, rnd.choice([0, 1]), 0, 0));
    else tiles.push(T([0, 0, 0, 0], floor, ceil, 0, 0));
  }
  const nt = tiles.length;
  // Room structure: contiguous random areas
  const walls = [], opens = [];
  tiles.forEach((t, i) => (t.walls.some((x) => x) ? walls : opens).push(i));
  const cells = [];
  for (let i = 0; i < w * h; i++) cells.push(rnd.random() < 0.35 ? rnd.choice(walls) : rnd.choice(opens));
  const nCorr = Math.floor(w * h / 3);
  for (let i = 0; i < nCorr; i++) {                   // corridors
    let x = rnd.randrange(w), y = rnd.randrange(h);
    const [dx, dy] = rnd.choice([[1, 0], [0, 1]]);
    const t = rnd.choice([...opens.slice(0, 3), ...opens]);
    const len = rnd.randint(3, 8);
    for (let k = 0; k < len; k++) {
      if (x >= 0 && x < w && y >= 0 && y < h) cells[y * w + x] = t;
      x += dx; y += dy;
    }
  }
  const content = [];
  for (let i = 0; i < w * h; i++) content.push(rnd.choice([0, 0, 0, 0, 0, 0, 0, 1, 2, 3]));
  let start = cells.findIndex((c) => !(tiles[c].flags & T_SOLID));
  if (start < 0) start = 0;
  if (tiles[cells[start]].flags & T_SOLID) cells[start] = 0;
  const m = new DbeMap(name, w, h, tiles, cells, content, [], start, rnd.randrange(4), rnd.randrange(nt));
  validateMap(m);
  return m;
}

/** n objects in cells in front of the camera (and some arbitrary ones). */
export function randomObjects(rnd, m, pos, v, n) {
  const objs = [];
  const [fx, fy] = FORE[v], [rx, ry] = RIGHT[v];
  const px = pos % m.width, py = Math.floor(pos / m.width);
  for (let i = 0; i < n; i++) {
    const d = rnd.randint(1, 3), s = rnd.randint(-3, 3);
    const x = px + d * fx + s * rx, y = py + d * fy + s * ry;
    let c;
    if (!(x >= 0 && x < m.width && y >= 0 && y < m.height) || rnd.random() < 0.1) c = rnd.randrange(m.width * m.height);
    else c = y * m.width + x;
    const set = rnd.choice([0, 0, 1, 2, 3, 5]), dir = rnd.choice([0, 1, 2, 3, 0xFF]);
    const phase = rnd.randint(0, 3), q = rnd.randint(0, 7);
    const hidden = rnd.random() < 0.1, noblock = rnd.random() < 0.2;
    objs.push(new Obj(c, set, dir, phase, q, hidden, noblock));
  }
  return objs;
}

/** Random scene (map, position, direction, objects, items, ITEMPH) from the demo assets. */
export function randomScene(seed, assets, { w = null, h = null, nobj = null, bandCover = null, dbg = null, ap = 0,
  buf = DEFAULT_BUF, start = null } = {}) {
  const rnd = new PyRandom(seed);
  w = w || rnd.randint(8, 24);
  h = h || rnd.randint(8, 24);
  const nst = [assets.walls.styles.length, assets.floor.styles.length, assets.ceil.styles.length];
  const m = randomMap(rnd, w, h, nst);
  const free = [];
  m.cells.forEach((c, i) => { if (!(m.tiles[c].flags & T_SOLID)) free.push(i); });
  const pos = rnd.choice(free);
  const v = rnd.randrange(4);
  nobj = nobj === null ? rnd.randint(0, 16) : nobj;
  const objs = randomObjects(rnd, m, pos, v, nobj);
  const itemtab = new Array(64).fill(0);
  for (const g of [1, 2, 3]) itemtab[g] = rnd.choice([0, 2, 3, 2]);
  const itemph = rnd.randint(0, 3);
  const dbgv = dbg === null ? rnd.random() < 0.7 : dbg;
  const bgfill = rnd.choice([0x00, 0x33, 0x55]);
  const bc = bandCover === null ? rnd.random() < 0.5 : bandCover;
  return makeScene(assets, m, { pos, direction: v, objects: objs, itemtab, itemph, ap, dbg: dbgv, bgfill, bandCover: bc, buf, start });
}

/** Far-view variant of a scene (P6 5.7a): fill byte (random if null) and in some of the tiles the flag DISTANT
 *  toggled (copy of the map). */
export function farVariant(sc, seed, farfill = null, pDistant = 0.3) {
  const rnd = new PyRandom(BigInt(seed) ^ 0x5F5Fn);
  const s2 = sc.copy();
  s2.dmp = sc.dmp.clone();
  for (const t of s2.dmp.tiles) if (rnd.random() < pDistant) t.flags ^= T_DISTANT;
  s2.farfill = farfill === null ? rnd.choice([0x00, 0x11, 0xF0]) : farfill;
  return s2;
}

// ---------------------------------------------------------------- Scene file

function dirOf(v) {
  if (typeof v === 'number') return v;
  const r = { N: 0, E: 1, S: 2, W: 3, '-': 0xFF }[String(v).toUpperCase()];
  if (r === undefined) throw new ViewError(`${String(v).toUpperCase()}`);      // Python: KeyError
  return r;
}

/** Scene from TOML (text, bytes or parsed object). resolve(relPath) -> Uint8Array (synchronous) reads the files
 *  the scene references (relative to the scene file); path names the scene in error messages.
 *  Keys: see dbeview.load_scene. Missing bases are assigned packed after the view window. */
export function loadScene(src, resolve, path = 'scene.toml') {
  const cfg = typeof src === 'string' || src instanceof Uint8Array ? parseToml(src) : src;
  if (cfg.format !== 'dbeview' || cfg.version !== 1) throw new ViewError(`${path}: format = "dbeview" and version = 1 expected`);
  const s = cfg.scene;
  if (!s) throw new ViewError('scene');                  // Python: KeyError
  const need = (o, k) => { if (!(k in o)) throw new ViewError(`${k}`); return o[k]; };
  const rd = (n) => resolve(n);
  const dvg = parseDvg(rd(need(s, 'dvg')));
  const mp = need(s, 'map');
  const m = mp.endsWith('.toml') ? loadsToml(rd(mp), mp) : fromDmp(rd(mp));
  const sc = new Scene(dvg, m);
  ['walls', 'floor', 'ceil'].forEach((key, k) => {
    if (key in cfg) {
      const vr = vrl.decode(vrl.unpackFile(rd(need(cfg[key], 'vrl'))).stream);
      sc.dts[k] = tex.fromDts(rd(need(cfg[key], 'dts')), vr);
      if ('base' in cfg[key]) sc.vramBases.dts[k] = cfg[key].base;
    }
  });
  if ('background' in cfg) {
    const b = cfg.background;
    sc.dbg = tex.fromDbg(rd(need(b, 'dbg')));
    sc.dbgVram = vrl.decode(vrl.unpackFile(rd(need(b, 'vrl'))).stream);
    sc.vramBases.dbg = b.base ?? 0;
  }
  for (const sp of cfg.sprites || []) {
    const vr = vrl.decode(vrl.unpackFile(rd(need(sp, 'vrl'))).stream);
    sc.s2[need(sp, 'set')] = fromS2(rd(need(sp, 's2')), vr);
    sc.vramBases.s2[sp.set] = sp.base ?? 0;
  }
  for (const [k, v] of Object.entries(cfg.items || {})) sc.itemtab[parseInt(k, 10)] = v + 1;
  for (const o of cfg.object || []) {
    const cell = 'cell' in o ? o.cell : need(o, 'at')[1] * m.width + o.at[0];
    sc.objects.push(new Obj(cell, need(o, 'set'), dirOf(o.dir ?? '-'), o.phase ?? 0, o.sub ?? 4, o.hidden ?? false, o.noblock ?? false));
  }
  sc.itemph = s.itemph ?? 0;
  sc.bgfill = s.bgfill ?? 0;
  sc.farfill = s.farfill ?? null;
  sc.ap = s.ap ?? 0;
  sc.buf = (s.buf ?? DEFAULT_BUF).slice();
  sc.bufFix = !!(s.buf_fix ?? false);
  sc.pos = 'pos' in s ? s.pos[1] * m.width + s.pos[0] : m.start;
  sc.dir = 'dir' in s ? dirOf(s.dir) : m.direction;
  const explicit = ['walls', 'floor', 'ceil', 'background'].some((k) => k in cfg && 'base' in cfg[k]);
  if (!explicit) layoutVram(sc);
  return sc;
}

// ---------------------------------------------------------------- Budget

/** Report on a list of scenes: largest VCL + VMS, entries, scenes with A != 0. */
export function budget(scenes) {
  const rep = { scenes: 0, max_total: 0, max_vcl: 0, max_vms: 0, max_entries: 0, max_items: 0, warnings: [], codes: {} };
  scenes.forEach((sc, i) => {
    const r = view(sc);
    rep.scenes++;
    rep.max_total = Math.max(rep.max_total, r.vcllen + r.vmslen);
    rep.max_vcl = Math.max(rep.max_vcl, r.vcllen);
    rep.max_vms = Math.max(rep.max_vms, r.vmslen);
    rep.max_entries = Math.max(rep.max_entries, r.x);
    rep.max_items = Math.max(rep.max_items, r.items);
    rep.codes[r.a] = (rep.codes[r.a] || 0) + 1;
    if (r.a) {
      rep.warnings.push(`Scene ${i}: A = ${r.a} (${r.a === 2 ? 'truncated' : 'edges omitted'}), `
        + `VCL ${r.vcllen} + VMS ${r.vmslen} of ${sc.buf[1] - sc.buf[0]}`);
    }
  });
  return rep;
}

// ---------------------------------------------------------------- Sprite sets (minimal S2 writer for tests)

/** dbespr default angle map for NA view angles. */
export function dbesprDefaultMap(na) {
  return { 1: [0, 0, 0, 0], 2: [0, 0, 1, 0], 3: [0, 1, 2, 1], 4: [0, 1, 2, 3] }[na];
}

const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

/** Minimal S2 writer per P5b 4 (dbeview.make_s2; dbespr is the actual importer).
 *  images: Map or array of [[phase, ai, d], [rows, fx, fy]] (rows = pixel rows, palette index 0-15 or null, even
 *  width). Missing images: phase 0 -> $FE, phase >= 1 -> $FF. Identical images are merged. Returns [S2 PRG, VRAM data]. */
export function makeS2(images, D, NA, NP, stride, { angleMap = null, gid = 0, flags = 0, maxCores = 4, coreMin = 16, load = 0x6000 } = {}) {
  const amap = angleMap || dbesprDefaultMap(NA);
  const order = [...images].sort((a, b) => cmpTuple(a[0], b[0]));
  const ents = [], keys = new globalThis.Map(), vram = [];
  const index = new Array(NP * NA * D).fill(0xFE);
  for (const [[f, ai, d], [rows, fx, fy]] of order) {
    const key = JSON.stringify([rows, fx, fy]);
    if (!keys.has(key)) {
      const pix = rows.map((r) => r.slice());
      const states = tex.classify(pix);
      tex.resolveAlphaConflict(pix, states);
      const cores = tex.chooseCores(states, maxCores, coreMin);
      const [, edge, vmsList] = tex.packImage(pix, states, cores, stride);
      const e = { w: rows[0].length >> 1, h: rows.length, fx, fy, cores: [], vms: vmsList, edgeOfs: 0, edgeLen: edge.length };
      for (const k of cores) {
        e.cores.push([vram.length, ...k]);
        for (const b of tex.coreBytes(pix, [k])) vram.push(b);
      }
      e.edgeOfs = edge.length ? vram.length : 0;
      for (const b of edge) vram.push(b);
      keys.set(key, ents.length);
      ents.push(e);
    }
    index[(f * NA + ai) * D + d - 1] = keys.get(key);
  }
  for (let f = 1; f < NP; f++) {
    for (let ai = 0; ai < NA; ai++) {
      for (let d = 1; d <= D; d++) {
        const i = (f * NA + ai) * D + d - 1;
        if (index[i] === 0xFE) index[i] = 0xFF;
      }
    }
  }
  const ni = ents.length;
  const nk = ents.reduce((a, e) => a + e.cores.length, 0);
  const oIdx = 40, oDir = oIdx + index.length, oCore = oDir + 16 * ni, oTag = oCore + 8 * nk, oData = oTag;
  const dirs = new tex.Bytes(), cores = new tex.Bytes(), data = [];
  let kpos = oCore;
  for (const e of ents) {
    let kofs = 0;
    if (e.cores.length) {
      kofs = kpos;
      for (const [src, kx, ky, kw, kh] of e.cores) cores.u16(src).u8(kx, ky, kw, kh).u16(0);
      kpos += 8 * e.cores.length;
    }
    let vofs = 0, vlen = 0;
    if (e.vms.length) { vofs = oData + data.length; vlen = e.vms.length; data.push(...e.vms); }
    dirs.u8(e.edgeLen ? 8 : 0, e.w, e.h, e.fx, e.fy, e.cores.length).u16(kofs, e.edgeOfs, e.edgeLen, vofs, vlen);
  }
  const total = oData + data.length;
  const v = Uint8Array.from(vram);
  const out = new tex.Bytes().u16(load).u8(0x53, 0x32, 1, flags).u16(gid).u8(D, NA, NP, ni).u16(nk).u8(...amap)
    .u16(oIdx, oDir, oCore, oTag).u8(0, 0).u16(oData, total, v.length, tex.crcHqx(v, 0xFFFF), stride).u8(0, 0, 0, 0);
  out.raw(index).raw(dirs.a).raw(cores.a).raw(data);
  if (out.length !== 2 + total) throw new ViewError('make_s2: length');
  return [out.bytes(), v];
}

/** S2 PRG + VRAM data -> SpriteSet (dbespr.from_s2, P5b 6.3). */
export function readS2(prg, vram) { return fromS2(prg, vram); }

// ---------------------------------------------------------------- Demo assets

/** Pixel image (rows with palette index or null) for test sprites; image angle ai and phase f change the pattern. */
export function spritePixels(kind, wPx, h, ai, f) {
  const pix = Array.from({ length: h }, () => new Array(wPx).fill(null));
  for (let r = 0; r < h; r++) {
    // outline: ellipse (enemy) or rhombus (item)
    const t = (r + 0.5) / h;
    let half;
    if (kind === 'gem') half = (0.5 - Math.abs(t - 0.5)) * wPx * (1.1 + 0.15 * (f & 1));
    else {
      const q = 2 * t - 1;
      half = 0 < t && t < 1 ? wPx / 2 * Math.sqrt(1 - q * q) : 0;
    }
    for (let x = 0; x < wPx; x++) {
      if (Math.abs(x + 0.5 - wPx / 2) <= half) pix[r][x] = kind !== 'gem' ? [9, 13, 5, 3][ai & 3] : [11, 7][f & 1];
    }
  }
  if (kind !== 'gem') {
    // eyes (hole) and stripes depending on the image angle
    const ey = Math.max(1, Math.floor(h / 4));
    const ex = Math.floor(wPx / 2) + [-1, 0, 1, 0][ai & 3] * Math.max(1, Math.floor(wPx / 5));
    for (const dx of [-1, 0]) {
      for (let dy = 0; dy < Math.max(1, Math.floor(h / 8)); dy++) {
        const x = ex + dx - (ai & 1 ? 1 : 0), y = ey + dy;
        if (y >= 0 && y < h && x >= 0 && x < wPx && pix[y][x] !== null && ai !== 2) pix[y][x] = f === 0 ? null : 15;
      }
    }
    const sy = Math.floor(h * 2 / 3);
    for (let x = 0; x < wPx; x++) if (pix[sy][x] !== null && (x + f) % 4 < 2) pix[sy][x] = 0;
    for (let x = 0; x < wPx; x += 5) if (pix[h >> 1][x] !== null) pix[h >> 1][x] = null;   // single pixels: half bytes
  }
  return pix;
}

/** Images per (phase, angle, depth), scaled to the cell width; height at most wall height of the depth (5.4).
 *  phasesDepths: null or array of [f, d]. Returns [SpriteSet, VRAM data, PRG]. */
export function makeSpriteSet(dvg, { name = 'blob', NA = 4, NP = 2, phasesDepths = null, wide = 1.0, height = 0.8, kind = 'blob', odd = 0 } = {}) {
  const D = dvg.D, stride = dvg.stride;
  const images = [];
  const pd = phasesDepths ? new Set(phasesDepths.map(([f, d]) => `${f},${d}`)) : null;
  for (let d = 1; d <= D; d++) {
    const dt = dvg.depth[d];
    const fw = dt.fw;
    const hmax = dt.fy0 - dt.cy0 + 1;
    const wB = Math.max(2, Math.trunc(fw * 0.4 * wide));
    const wPx = 2 * wB;
    const h = Math.max(3, Math.min(hmax, Math.trunc((dt.fy1 - dt.cy0) * height)));
    for (let f = 0; f < NP; f++) {
      for (let ai = 0; ai < NA; ai++) {
        if (pd !== null && !pd.has(`${f},${d}`) && f > 0) continue;
        let pix = spritePixels(kind, wPx, h, ai, f);
        if (odd) pix = pix.map((r) => [null, ...r.slice(0, -1)]);    // image starts on an odd pixel column
        images.push([[f, ai, d], [pix, wB >> 1, h - 1]]);
      }
    }
  }
  void name;
  const [prg, vram] = makeS2(images, D, NA, NP, stride, { flags: kind === 'gem' ? 1 : 0 });
  return [readS2(prg, vram), vram, prg];
}

export const GEN_FLOOR_TOML = `format  = "dbetex"
version = 1

[texset]
name = "{name}"
kind = "{kind}"
geom = "west140.geom.json"
out  = "build"
load = {load}
max_cores = 4

{styles}`;

/** Additional floor and ceiling styles: textured band gradient (no ROWS), puddle with holes, without bands.
 *  Returns {name: RGBA image}. */
export function atlasStyles(geom) {
  const make = (arts, fnBand, fnTile) => {
    const im = texdemo.newImage(...geom.atlas_size);
    for (const [name, d, rect, mask, [ax, ay]] of texdemo.boxes(geom, arts)) {
      texdemo.paint(im, ax, ay, rect, mask, name.includes('band') ? fnBand : fnTile(d));
    }
    return im;
  };
  return {
    'grass_atlas.png': make(['floor', 'floorband'], (px, r) => (((px / 3 | 0) + r) % 5 ? 4 : 5), () => (px, r) => ((px + r) % 4 ? 4 : 5)),
    'puddle_atlas.png': make(['floor', 'floorband'], () => 3, () => (px, r) => (((px >> 1) + (r >> 1)) % 3 === 0 ? null : 3)),
    'hole_atlas.png': make(['ceil', 'ceilband'], () => 10, () => (px, r) => (((px >> 2) + (r / 3 | 0)) % 2 === 0 ? null : 10)),
  };
}

/** dbeview.build_demo_assets without a file system: geomJson/dvg = default geometry (Westwood 140 x 96, the bytes of
 *  docs/specs/examples/tex/west140.geom.json + .dvg; dbegeom builds them in Python). Generates DVG, wall DTS
 *  (4 styles), floor DTS (3 styles), ceiling DTS (3 styles), DBG and sprite sets and returns the assets
 *  (as assetsFromFiles) plus assets.files: {name: bytes | string} of the generated project (virtual directory dir). */
export function buildDemoAssets({ geomJson, dvg, dir = '/demo' }) {
  const gen = texdemo.generate({ geomJson, dvg });
  const files = { ...gen.files };
  const P = (n) => tex.pjoin(dir, n);
  const resolve = (p) => {
    const n = p.startsWith(dir + '/') ? p.slice(dir.length + 1) : null;
    const v = n !== null ? files[n] : undefined;
    return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v) : v;
  };
  const geom = tex.loadGeom(resolve, P('west140.geom.json'), P('west140.dvg'));
  const dvgPrg = Uint8Array.from(files['west140.dvg']);
  const g = parseDvg(dvgPrg);
  for (const [n, im] of Object.entries(atlasStyles(geom))) files[n] = encodePng(im);
  const fmt = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k]);
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const emptyF = range(g.D + 1).map((d) => `"floorband_d${d}"`).join(', ');
  const emptyC = range(g.D + 1).map((d) => `"ceilband_d${d}"`).join(', ');
  files['floor3.toml'] = fmt(GEN_FLOOR_TOML, { name: 'demo_floor3', kind: 'floor', load: '0xEE00', styles:
    '[[style]]\nname = "stone"\npng = "stone_atlas.png"\n\n[[style]]\nname = "grass"\npng = "grass_atlas.png"\n\n'
    + `[[style]]\nname = "puddle"\npng = "puddle_atlas.png"\nempty = [${emptyF}]\n` });
  files['ceil3.toml'] = fmt(GEN_FLOOR_TOML, { name: 'demo_ceil3', kind: 'ceiling', load: '0xF600', styles:
    '[[style]]\nname = "wood"\npng = "wood_atlas.png"\n\n'
    + `[[style]]\nname = "hole"\npng = "hole_atlas.png"\nempty = [${emptyC}]\n` });
  const build = (n) => {
    const { ts } = tex.buildTexset(tex.loadTexConf(files[n], { path: P(n) }), resolve);
    ts.dtsPrg = tex.toDts(ts);
    return ts;
  };
  const walls = build('walls.toml'), floor = build('floor3.toml'), ceil = build('ceil3.toml');
  const bgr = tex.buildBackground(tex.loadBgConf(files['bg.toml'], { path: P('bg.toml') }), resolve);
  const sprites = new Array(8).fill(null);
  sprites[0] = makeSpriteSet(g, { name: 'blob', NA: 4, NP: 2, wide: 0.4, height: 0.4 })[0];
  sprites[1] = makeSpriteSet(g, { name: 'gem', NA: 1, NP: 2, kind: 'gem', wide: 0.5, height: 0.3 })[0];
  sprites[2] = makeSpriteSet(g, { name: 'guard', NA: 2, NP: 1, wide: 0.35, height: 0.6, odd: 1 })[0];
  sprites[3] = makeSpriteSet(g, { name: 'wide', NA: 2, NP: 2, wide: 1.8, height: 0.2, phasesDepths: [[1, 1]] })[0];
  return {
    dvg: g, geom, walls, floor, ceil, dbg: tex.fromDbg(bgr.dbg), dbgVram: bgr.vram, sprites, dir, dvgPrg,
    dbgPrg: bgr.dbg, files,
  };
}
