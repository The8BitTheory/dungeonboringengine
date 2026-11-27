// Sprite sets v2 (S2, P5b): builder (Aseprite export or PNG with image list -> S2 + VRL), S2 reader, index lookup,
// clipping, reports and preview. Port of tools/dbespr.py (docs/specs/P5b-sprites.md).
//
// API (no file system access; files referenced by the TOML are read through resolve(path) => Uint8Array | null,
// paths joined like os.path.join(dirname(toml path), value)):
//   loadConf(src, {path, out, strict, key}) -> conf
//   buildSpriteset(conf, resolve) -> {ss, warnings, infos, sources}   sources: Map "f,ai,d" -> text
//   toS2(ss, load) -> Uint8Array (S2 PRG);  fromS2(prg, vram) -> SpriteSet
//   buildSpr(src, {path, resolve, out, strict, key, preview}) -> {files, report, warnings, infos, ss, conf, geom,
//     previews, stream}   (the whole `build` command)
//   buildReport, reportMd, vclBytes, preview(ss, geom, vram, d, phase, a, vb) -> {width, height, rgb},
//   renderImage, clipImage, lookup, viewAngle
import {
  TexError, Core, checkVms, crcHqx, toIndices, classify, chooseCores, packImage, resolveAlphaConflict, coreBytes,
  readRgba, readVia, loadGeom, simVmc, simVms, fbToImage, toml, checkKeys, int, pyBool, pyStr, pyFixed, pyDumps,
  REPORT_FLOATS, Bytes, checkBank1, pjoin, pdirname,
} from './tex.js';
import * as vrl from './vrl.js';
import * as mem from './mem.js';
import { readAseprite, frameList } from './io/aseprite.js';
import { pyRepr } from './map.js';

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

export { crcHqx };

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

// ---------------------------------------------------------------- Drawing (render_image)

/** Draws image imgIndex via clipImage + simulators. vp = viewport object of the geometry (stride, origin).
 *  clip = [cx0, cx1, cy0, cy1] in window coordinates or null (unclipped); limited to the image rectangle.
 *  Returns false if there is nothing to draw. */
export function renderImage(ss, imgIndex, vram, fb, x0, y0, vp, { ap = 0, vb = 0, clip = null } = {}) {
  const img = ss.images[imgIndex];
  const stride = vp.stride;
  const base = (ap + (vp.origin || 0)) & 0xFFFF;
  let cx0, cx1, cy0, cy1;
  if (clip === null) [cx0, cx1, cy0, cy1] = [x0, x0 + img.w, y0, y0 + img.h];
  else {
    cx0 = Math.max(clip[0], x0); cx1 = Math.min(clip[1], x0 + img.w);
    cy0 = Math.max(clip[2], y0); cy1 = Math.min(clip[3], y0 + img.h);
    if (cx0 >= cx1 || cy0 >= cy1) return false;
  }
  const c = clipImage(img, x0, y0, cx0, cx1, cy0, cy1, stride);
  for (const [src, x, y, w, h, st] of c.cores) simVmc(vram, vb + src, base + y * stride + x, w, h, stride, st, fb);
  if (c.vms) simVms(vram, vb + c.edgeSrc, base + c.ref[1] * stride + c.ref[0], c.vms, fb);
  return true;
}

// ---------------------------------------------------------------- Configuration (3.1)

export const SPRITE_KEYS = ['name', 'geom', 'dvg', 'out', 'load', 'vrl_load', 'angles', 'angle_map', 'phases', 'max_cores',
  'core_min', 'key', 'alpha_threshold', 'any_geometry', 'mirror', 'derive'];
export const SOURCE_KEYS = ['aseprite', 'png'];
export const IMAGE_KEYS = ['box', 'foot', 'phase', 'angle', 'depth'];

const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d) => (has(o, k) ? o[k] : d);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** Python int(str) (decimal, optional sign, underscores between digits, surrounding whitespace) or null. */
function pyIntStr(s) {
  if (typeof s !== 'string' || !/^\s*[+-]?\d+(_\d+)*\s*$/.test(s)) return null;
  return parseInt(s.replace(/_/g, '').trim(), 10);
}

/** spr.toml -> conf (dbespr.load_conf); src bytes or string, path of the TOML (paths are joined to its directory). */
export function loadConf(src, { path = 'spr.toml', out = null, strict = false, key = null } = {}) {
  const cfg = toml(src, path);
  const base = pdirname(path);
  checkKeys(path, cfg, ['format', 'version', 'sprite', 'source', 'image']);
  if (get(cfg, 'format', null) !== 'dbespr' || get(cfg, 'version', null) !== 1) {
    throw new SprError(`${path}: format = "dbespr" and version = 1 expected`);
  }
  const sp = { ...(get(cfg, 'sprite', null) || {}) };
  checkKeys(`${path} [sprite]`, sp, SPRITE_KEYS);
  for (const k of ['name', 'geom']) if (!has(sp, k)) throw new SprError(`${path} [sprite]: ${k} missing`);
  const na = int('angles', get(sp, 'angles', 1), 1, 4);
  const amap = get(sp, 'angle_map', DEFAULT_MAP[na]);
  if (!Array.isArray(amap) || amap.length !== 4 || amap.some((v) => !isInt(v) || !(v >= 0 && v < na))) {
    throw new SprError(`${path}: angle_map needs 4 values < angles (${na})`);
  }
  const mirror = new globalThis.Map();
  for (const [k, v] of Object.entries(get(sp, 'mirror', null) || {})) {
    const t = pyIntStr(k);
    if (t === null) throw new SprError(`${path}: mirror: key ${pyRepr(k)} is not a number`);
    if (!(isInt(v) && t >= 0 && t < na && v >= 0 && v < na && t !== v)) {
      throw new SprError(`${path}: mirror ${k} = ${pyStr(v)}: only between different existing view angles < ${na}`);
    }
    mirror.set(t, v);
  }
  const derive = get(sp, 'derive', 'none');
  if (derive !== 'none' && derive !== 'nearest') throw new SprError(`${path}: derive = "none" or "nearest" expected`);
  const c = {
    name: pyStr(sp.name), geom: pjoin(base, sp.geom), dvg: pyBool(get(sp, 'dvg', null)) ? pjoin(base, sp.dvg) : null,
    out: out || pjoin(base, get(sp, 'out', '.')),
  };
  c.load = int('load', get(sp, 'load', mem.defaultLoad('s2')), 0, 0xFFFF);
  c.vrl_load = int('vrl_load', get(sp, 'vrl_load', 0x4000), 0, 0xFFFF);
  c.angles = na; c.angle_map = amap.slice(); c.mirror = mirror; c.derive = derive;
  c.phases = has(sp, 'phases') ? int('phases', sp.phases, 1, 32) : null;
  c.max_cores = int('max_cores', get(sp, 'max_cores', 4), 0, 16);
  c.core_min = int('core_min', get(sp, 'core_min', 16), 1, 65535);
  c.key = key !== null && key !== undefined ? key : get(sp, 'key', null);
  c.alpha_threshold = int('alpha_threshold', get(sp, 'alpha_threshold', 0), 0, 255);
  c.any_geometry = pyBool(get(sp, 'any_geometry', false));
  c.strict = strict;
  const srcT = { ...(get(cfg, 'source', null) || {}) };
  checkKeys(`${path} [source]`, srcT, SOURCE_KEYS);
  if (has(srcT, 'png') === has(srcT, 'aseprite')) throw new SprError(`${path} [source]: exactly one source (aseprite or png) expected`);
  const images = get(cfg, 'image', null) || [];
  if (has(srcT, 'aseprite')) {
    if (pyBool(images)) throw new SprError(`${path}: [[image]] only together with png`);
    c.aseprite = pjoin(base, srcT.aseprite);
  } else {
    if (!pyBool(images)) throw new SprError(`${path}: png needs [[image]] entries`);
    c.png = pjoin(base, srcT.png);
    c.images = [];
    images.forEach((im, i) => {
      const where = `${path} [[image]] ${i}`;
      checkKeys(where, im, IMAGE_KEYS);
      for (const k of ['box', 'phase', 'angle', 'depth']) if (!has(im, k)) throw new SprError(`${where}: ${k} missing`);
      const box = im.box;
      if (!(Array.isArray(box) && box.length === 4 && box.every(isInt))) throw new SprError(`${where}: box = [x, y, w, h] expected`);
      const foot = get(im, 'foot', null);
      if (foot !== null && !(Array.isArray(foot) && foot.length === 2 && foot.every(isInt))) throw new SprError(`${where}: foot = [x, y] expected`);
      c.images.push({
        box: box.slice(), foot: pyBool(foot) ? foot.slice() : null,
        phase: int('phase', im.phase, 0, 31), angle: int('angle', im.angle, 0, 3), depth: int('depth', im.depth, 0, 255),
      });
    });
  }
  return c;
}

// ---------------------------------------------------------------- Sources

/** Painted image of one cell: pix rows (palette index | null, even width), foot point in pixels, kind/note. */
export class Raw {
  constructor(pix, footpx, fy, kind = 'eigen', note = '') { Object.assign(this, { pix, footpx, fy, kind, note }); }
}

/** Crop rows (width wpx, left edge on pixel column x) -> byte raster (3.4). */
export function raster(rows, x, footX, footY) {
  const wpx = rows[0].length;
  const lead = x & 1;
  let tw = lead + wpx;
  tw += tw & 1;
  const pix = rows.map((r) => [...new Array(lead).fill(null), ...r, ...new Array(tw - lead - wpx).fill(null)]);
  return new Raw(pix, lead + footX, footY);
}

const cropRows = (pix, x, y, w, h) => pix.slice(y, y + h).map((row) => row.slice(x, x + w));

function bbox(pix) {
  const ys = [];
  pix.forEach((row, r) => { if (row.some((v) => v !== null)) ys.push(r); });
  if (!ys.length) return null;
  let x0 = Infinity, x1 = -Infinity;
  for (const row of pix) row.forEach((v, c) => { if (v !== null) { x0 = Math.min(x0, c); x1 = Math.max(x1, c); } });
  return [x0, ys[0], x1 - x0 + 1, ys[ys.length - 1] - ys[0] + 1];
}

/** Cell key "f,ai,d" and back. */
export const cellKey = (f, ai, d) => `${f},${ai},${d}`;
const unKey = (k) => k.split(',').map(Number);
const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

const LAYER_RE = /^v(\d+)_d(\d+)$/;

function footInfo(raw, name, infos) {
  if (raw.footpx & 1) infos.push(`${name}: foot point rounded to byte boundary`);
}

/** -> [cells Map "f,ai,d" -> Raw, tags [name, from, to, direction], durations Map f -> ms, NP from the source]. */
export function loadAseprite(conf, geom, warns, infos, resolve) {
  const path = conf.aseprite;
  const { js, meta } = readAseprite(readVia(resolve, path), path, SprError);
  const sheet = readRgba(resolve, pjoin(pdirname(path), meta.image));
  const D = geom.viewport.depth, NA = conf.angles;
  const key = conf.key, thr = conf.alpha_threshold;
  const slices = new globalThis.Map();
  for (const sl of get(meta, 'slices', [])) {
    if (slices.has(sl.name)) throw new SprError(`${path}: Slice ${pyRepr(sl.name)} duplicated`);
    slices.set(sl.name, get(sl, 'keys', []).slice().sort((a, b) => a.frame - b.frame));
  }
  const cells = new globalThis.Map(), dur = new globalThis.Map(), ignored = new Set();
  let maxf = -1;
  for (const e of frameList(js, path, SprError, true)) {
    const fn = get(e, 'filename', '');
    if (!fn.includes('#')) {
      throw new SprError(`${path}: file name ${pyRepr(fn)} is not <layer>#<frame> (--filename-format '{layer}#{frame}')`);
    }
    const cut = fn.lastIndexOf('#');
    const layer = fn.slice(0, cut), fs = fn.slice(cut + 1);
    const f = pyIntStr(fs);
    if (f === null) throw new SprError(`${path}: file name ${pyRepr(fn)}: invalid frame number`);
    if (pyBool(get(e, 'rotated', null)) || pyBool(get(e, 'trimmed', null))) {
      throw new SprError(`${path}: Frame ${fn} is rotated/trimmed - export without --trim`);
    }
    if (!dur.has(f)) dur.set(f, get(e, 'duration', 100));
    const m = LAYER_RE.exec(layer);
    if (!m) {
      if (!ignored.has(layer)) { ignored.add(layer); infos.push(`layer ${pyRepr(layer)} does not match v<ai>_d<d>, ignored`); }
      continue;
    }
    const ai = parseInt(m[1], 10), d = parseInt(m[2], 10);
    if (ai >= NA) throw new SprError(`${path}: layer ${layer}: view angle ${ai} >= angles ${NA}`);
    if (!(d >= 1 && d <= D)) throw new SprError(`${path}: layer ${layer}: depth ${d} outside 1 ... ${D}`);
    maxf = Math.max(maxf, f);
    const ck = cellKey(f, ai, d);
    if (cells.has(ck)) throw new SprError(`${path}: ${fn} duplicated`);
    const fr = e.frame;
    const [pix, w] = toIndices(sheet, [fr.x, fr.y, fr.w, fr.h], key, thr, conf.strict);
    warns.push(...w.map((x) => `${fn}: ${x}`));
    const keys = (slices.get(layer) || []).filter((k) => k.frame <= f);
    const k = keys.length ? keys[keys.length - 1] : null;
    if (k !== null) {
      const b = k.bounds;
      if (b.x < 0 || b.y < 0 || b.x + b.w > fr.w || b.y + b.h > fr.h) throw new SprError(`${path}: Slice ${layer}: frame lies outside the canvas`);
      const rows = cropRows(pix, b.x, b.y, b.w, b.h);
      const count = (p) => p.reduce((a, row) => a + row.filter((v) => v !== null).length, 0);
      const tot = count(pix), inn = count(rows);
      if (tot > inn) warns.push(`${fn}: ${tot - inn} pixels outside the slice, discarded`);
      if (inn === 0) continue;
      const foot = has(k, 'pivot') ? [k.pivot.x, k.pivot.y] : [Math.floor(b.w / 2), b.h - 1];
      cells.set(ck, raster(rows, b.x, foot[0], foot[1]));
    } else {
      const bb = bbox(pix);
      if (bb === null) continue;
      const rows = cropRows(pix, ...bb);
      infos.push(`${fn}: foot point automatic`);
      cells.set(ck, raster(rows, bb[0], Math.floor(bb[2] / 2), bb[3] - 1));
    }
    footInfo(cells.get(ck), fn, infos);
  }
  const tags = get(meta, 'frameTags', []).map((t) => [t.name, t.from, t.to, get(t, 'direction', 'forward')]);
  return [cells, tags, dur, maxf + 1];
}

export function loadPng(conf, geom, warns, infos, resolve) {
  const img = readRgba(resolve, conf.png);
  const D = geom.viewport.depth, NA = conf.angles;
  const cells = new globalThis.Map();
  let maxf = -1;
  conf.images.forEach((im, i) => {
    const f = im.phase, ai = im.angle, d = im.depth;
    const name = `image ${i} (f${f}, ai${ai}, d${d})`;
    if (ai >= NA) throw new SprError(`${name}: view angle >= angles ${NA}`);
    if (!(d >= 1 && d <= D)) throw new SprError(`${name}: depth outside 1 ... ${D}`);
    const ck = cellKey(f, ai, d);
    if (cells.has(ck)) throw new SprError(`${name}: (phase, view angle, depth) duplicated`);
    const [x, y, w, h] = im.box;
    const [pix, ws] = toIndices(img, [x, y, w, h], conf.key, conf.alpha_threshold, conf.strict);
    warns.push(...ws.map((m) => `${name}: ${m}`));
    if (pix.every((row) => row.every((v) => v === null))) { warns.push(`${name}: empty, no image`); return; }
    const foot = im.foot || [Math.floor(w / 2), h - 1];
    if (!im.foot) infos.push(`${name}: foot point automatic`);
    cells.set(ck, raster(pix, x, foot[0], foot[1]));
    footInfo(cells.get(ck), name, infos);
    maxf = Math.max(maxf, f);
  });
  return [cells, [], new globalThis.Map(), maxf + 1];
}

// ---------------------------------------------------------------- Mirroring, deriving (5.3, 5.4)

export function mirrorRaw(raw) {
  const tw = raw.pix[0].length;
  return new Raw(raw.pix.map((row) => row.slice().reverse()), tw - 1 - raw.footpx, raw.fy, 'gespiegelt');
}

export function planeW(geom, d) {
  const pl = geom.planes;
  return 1.0 / (0.5 / pl[d].W + 0.5 / pl[d + 1].W);
}

export function deriveRaw(raw, k) {
  const h = raw.pix.length, tw = raw.pix[0].length;
  const rw = Math.max(1, Math.trunc(tw * k + 0.5)), nh = Math.max(1, Math.trunc(h * k + 0.5));
  const nw = rw + (rw & 1);
  const pix = [];
  for (let j = 0; j < nh; j++) {
    const row = [];
    for (let i = 0; i < nw; i++) {
      row.push(i < rw ? raw.pix[Math.min(h - 1, Math.trunc((j + 0.5) / k))][Math.min(tw - 1, Math.trunc((i + 0.5) / k))] : null);
    }
    pix.push(row);
  }
  return new Raw(pix, Math.min(rw - 1, Math.trunc(raw.footpx * k + 0.5)), Math.min(nh - 1, Math.trunc(raw.fy * k + 0.5)), 'abgeleitet');
}

// ---------------------------------------------------------------- Build

export function tagName(n, warns, used) {
  let s = String(n).toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  const cp = Array.from(s);
  if (cp.length > 8) {
    s = cp.slice(0, 8).join('');
    warns.push(`Tag ${pyRepr(n)}: shortened to 8 characters (${s})`);
  }
  if (used.has(s)) warns.push(`Tag ${pyRepr(n)}: name ${s} duplicated`);
  used.add(s);
  return s;
}

const pixKey = (pix) => pix.map((r) => r.map((v) => (v === null ? '-' : v.toString(16))).join('')).join('/');

/** -> {ss, warnings, infos, sources}; sources: Map "f,ai,d" -> source text of the index entry.
 *  conf.geomData may hold the parsed geometry (then conf.geom/conf.dvg are not read). */
export function buildSpriteset(conf, resolve) {
  const geom = conf.geomData || loadGeom(resolve, conf.geom, get(conf, 'dvg', null));
  const warns = [], infos = [];
  const vp = geom.viewport;
  const D = vp.depth, stride = vp.stride, VW = vp.width_px >> 1, VH = vp.height;
  const NA = conf.angles;
  const [cells, tags, dur, npSrc] = has(conf, 'aseprite')
    ? loadAseprite(conf, geom, warns, infos, resolve) : loadPng(conf, geom, warns, infos, resolve);
  if (!cells.size) throw new SprError('no images in the source');
  const NP = conf.phases || Math.max(npSrc, 1);
  if (NP > 32) throw new SprError(`NP ${NP} > 32`);
  for (const k of cells.keys()) {
    const [f] = unKey(k);
    if (f >= NP) throw new SprError(`image in phase ${f} >= phases ${NP}`);
  }
  // Mirroring
  const mirror = conf.mirror instanceof globalThis.Map ? [...conf.mirror] : Object.entries(conf.mirror || {}).map(([k, v]) => [+k, v]);
  mirror.sort((a, b) => cmpTuple(a, b));
  for (const [tgt, src] of mirror) {
    const ks = [...cells.keys()].map(unKey).filter((k) => k[1] === src).sort(cmpTuple);
    for (const [f, ai, d] of ks) {
      const tk = cellKey(f, tgt, d);
      if (!cells.has(tk)) {
        const m = mirrorRaw(cells.get(cellKey(f, ai, d)));
        m.note = `v${src}_d${d}`;
        cells.set(tk, m);
        if (m.footpx & 1) infos.push(`v${tgt}_d${d}#${f}: foot point rounded to byte boundary`);
      }
    }
  }
  // Deriving
  if (conf.derive === 'nearest') {
    const painted = new globalThis.Map(cells);
    for (let f = 0; f < NP; f++) {
      for (let ai = 0; ai < NA; ai++) {
        for (let d = 1; d <= D; d++) {
          if (cells.has(cellKey(f, ai, d)) || (f > 0 && cells.has(cellKey(0, ai, d)))) continue;
          const srcs = [];
          for (let dd = 1; dd < d; dd++) if (painted.has(cellKey(f, ai, dd))) srcs.push(dd);
          if (!srcs.length) continue;
          const ds = Math.max(...srcs);
          const k = planeW(geom, d) / planeW(geom, ds);
          const r = deriveRaw(painted.get(cellKey(f, ai, ds)), k);
          r.note = `v${ai}_d${ds}`;
          cells.set(cellKey(f, ai, d), r);
          warns.push(`v${ai}_d${d}#${f}: depth ${d} derived from depth ${ds}`);
        }
      }
    }
  }
  // Images
  const images = [], keys = new globalThis.Map(), vram = [], sources = new globalThis.Map(), index = [];
  const slot0 = {};
  for (const s of geom.slots) if (s.s === 0) slot0[s.d] = s;
  for (let f = 0; f < NP; f++) {
    for (let ai = 0; ai < NA; ai++) {
      for (let d = 1; d <= D; d++) {
        const ck = cellKey(f, ai, d);
        const raw = cells.get(ck);
        const name = `v${ai}_d${d}#${f}`;
        if (raw === undefined) {
          if (f === 0) {
            index.push(NOIMG);
            if (conf.derive === 'none') warns.push(`phase 0 without image for v${ai}_d${d}`);
            sources.set(ck, '$FE');
          } else { index.push(FALLBACK); sources.set(ck, '$FF'); }
          continue;
        }
        const h = raw.pix.length, tw = raw.pix[0].length;
        const w = tw >> 1, fx = Math.floor(raw.footpx / 2), fy = raw.fy;
        const wmax = Math.min(VW, 127);
        if (!(w >= 1 && w <= wmax) || !(h >= 1 && h <= VH)) {
          throw new SprError(`${name}: image size ${w} bytes x ${h} rows outside 1 ... ${wmax} x 1 ... ${VH}`);
        }
        if (!(fx >= 0 && fx < w && fy >= 0 && fy < h)) throw new SprError(`${name}: foot point (${fx}, ${fy}) outside the image ${w} x ${h}`);
        const top = slot0[d].anchors_px[0][1] - fy;
        if (top < geom.planes[d].T) {
          warns.push(`${name}: image extends above the wall top edge (top edge ${top} < T ${geom.planes[d].T})`);
        }
        const key = `${pixKey(raw.pix)}|${w}|${h}|${fx}|${fy}`;
        if (keys.has(key)) {
          index.push(keys.get(key));
          sources.set(ck, `shared with image ${keys.get(key)}`);
          continue;
        }
        const pix = raw.pix.map((r) => r.slice());
        const states = classify(pix);
        const nres = resolveAlphaConflict(pix, states);
        if (nres) warns.push(`${name}: all 16 colors in half-R bytes, ${nres} bytes made full`);
        const cores = chooseCores(states, conf.max_cores, conf.core_min);
        const [, edge, vms] = packImage(pix, states, cores, stride);
        const im = new Img(w, h, fx, fy, { pix });
        for (const kk of cores) {
          im.cores.push(new Core(vram.length, kk[0], kk[1], kk[2], kk[3], 0));
          for (const b of coreBytes(pix, [kk])) vram.push(b);
        }
        if (edge.length) {
          im.edgeOfs = vram.length; im.edgeLen = edge.length; im.edge = edge; im.vms = vms;
          for (const b of edge) vram.push(b);
        }
        images.push(im);
        keys.set(key, images.length - 1);
        index.push(images.length - 1);
        sources.set(ck, { eigen: 'own', gespiegelt: `mirrored from ${raw.note}`, abgeleitet: `derived from ${raw.note}` }[raw.kind]);
      }
    }
  }
  if (images.length > 254) throw new SprError(`too many images: ${images.length} > 254`);
  if (vram.length > 65535) throw new SprError(`VRAM data ${vram.length} > 65535 bytes`);
  const nk = images.reduce((a, i) => a + i.cores.length, 0);
  if (nk > 65535) throw new SprError(`too many cores: ${nk}`);
  // Tags
  const tl = [], used = new Set();
  if (tags.length > 32) throw new SprError(`${tags.length} Tags > 32`);
  for (const [n, a, b, dr0] of tags) {
    let dr = dr0;
    if (!(a >= 0 && a <= b && b < NP)) throw new SprError(`Tag ${pyRepr(n)}: frames ${a}-${b} outside 0 ... ${NP - 1}`);
    if (!has(MODES, dr)) { warns.push(`Tag ${pyRepr(n)}: direction ${pyRepr(dr)} unknown, forward`); dr = 'forward'; }
    const ds = [];
    for (let f = a; f <= b; f++) ds.push(dur.has(f) ? dur.get(f) : 100);
    if (new Set(ds).size > 1) warns.push(`Tag ${pyRepr(n)}: unequal durations ${pyRepr(ds)}, using mean`);
    const ms = ds.reduce((x, y) => x + y, 0) / ds.length;
    const j = Math.min(255, Math.max(1, Math.trunc(ms * 60 / 1000 + 0.5)));
    tl.push(new Tag(tagName(n, warns, used), a, b - a + 1, MODES[dr], j));
  }
  const v = Uint8Array.from(vram);
  const ss = new SpriteSet(conf.any_geometry ? 0 : geom.geometry_id, D, stride, NA, NP, conf.angle_map.slice(),
    NA === 1 ? F_ITEM : 0, index, images, tl, v);
  ss.u = v.length; ss.crc = crcHqx(v, 0xFFFF); ss.nk = nk;
  ss.geom = geom;
  return { ss, warnings: warns, infos, sources };
}

// ---------------------------------------------------------------- S2 (4)

export function toS2(ss, load = null) {
  if (load === null || load === undefined) load = mem.defaultLoad('s2');
  const NP = ss.np, NA = ss.na, D = ss.depth, NI = ss.images.length, NT = ss.tags.length;
  const nk = ss.images.reduce((a, i) => a + i.cores.length, 0);
  if (NI > 254 || NP > 32 || NA > 4 || NT > 32 || nk > 65535 || ss.vram.length > 65535) {
    throw new SprError('limits exceeded (NI <= 254, NP <= 32, NA <= 4, NT <= 32, NK <= 65535, U <= 65535)');
  }
  const oIdx = HEAD;
  const oDir = oIdx + NP * NA * D;
  const oCore = oDir + 16 * NI;
  const oTag = oCore + 8 * nk;
  const oData = oTag + 12 * NT;
  const dirs = new Bytes(), cores = new Bytes(), data = [];
  let kpos = oCore;
  for (const im of ss.images) {
    let kofs = 0;
    if (im.cores.length) {
      kofs = kpos;
      for (const k of im.cores) cores.u16(k.src).u8(k.dx, k.dy, k.w, k.h).u16(0);
      kpos += 8 * im.cores.length;
    }
    let vofs = 0, vlen = 0;
    if (im.vms.length) {
      vofs = oData + data.length; vlen = im.vms.length;
      for (const b of im.vms) data.push(b);
    }
    dirs.u8(im.flags, im.w, im.h, im.fx, im.fy, im.cores.length).u16(kofs, im.edgeOfs, im.edgeLen, vofs, vlen);
  }
  const tags = new Bytes();
  for (const t of ss.tags) {
    const nm = Array.from(t.name, (c) => c.charCodeAt(0));
    if (nm.some((c) => c > 127)) throw new SprError(`'ascii' codec can't encode tag name ${pyRepr(t.name)}`);
    while (nm.length < 8) nm.push(0);
    tags.raw(nm).u8(t.first, t.count, t.mode, t.dur);
  }
  const total = oData + data.length;
  if (total > 8192) throw new SprError(`S2 content ${total} > 8192 bytes (does not fit into the sprite area of the memory map)`);
  const out = new Bytes().u16(load).u8(0x53, 0x32, 1, ss.flags).u16(ss.geometryId).u8(D, NA, NP, NI).u16(nk)
    .u8(...ss.angleMap).u16(oIdx, oDir, oCore, oTag).u8(NT, 0)
    .u16(oData, total, ss.vram.length, crcHqx(ss.vram, 0xFFFF), ss.stride).u8(0, 0, 0, 0);
  out.raw(ss.index).raw(dirs.a).raw(cores.a).raw(tags.a).raw(data);
  if (out.length !== 2 + total) throw new SprError('internal error: S2 length');
  return out.bytes();
}

// ---------------------------------------------------------------- Report (7)

export function vclBytes(im) { return 11 * im.cores.length + (im.edgeLen ? 7 : 0); }

/** sources: Map "f,ai,d" -> text (as returned by buildSpriteset). */
export function buildReport(ss, conf, warns, infos, sources, stream, s2len) {
  const st = vrl.stats(stream);
  const src = (k) => (sources instanceof globalThis.Map ? sources.get(k) : sources[k]);
  const rows = [];
  for (let f = 0; f < ss.np; f++) {
    for (let ai = 0; ai < ss.na; ai++) {
      for (let d = 1; d <= ss.depth; d++) {
        const v = ss.index[(f * ss.na + ai) * ss.depth + d - 1];
        const r = { phase: f, angle: ai, depth: d, value: v, source: src(cellKey(f, ai, d)) };
        if (v < NOIMG) {
          const im = ss.images[v];
          Object.assign(r, {
            entry: v, w: im.w, h: im.h, foot: [im.fx, im.fy], cores: im.cores.length,
            core_bytes: im.cores.reduce((a, k) => a + k.w * k.h, 0), edge: im.edgeLen, vms: im.vms.length, vcl: vclBytes(im),
          });
        }
        rows.push(r);
      }
    }
  }
  const mv = ss.images.reduce((a, i) => Math.max(a, i.vms.length), 0);
  const mt = ss.images.reduce((a, i) => Math.max(a, vclBytes(i) + i.vms.length), 0);
  warns = warns.slice();
  const third = Math.floor(VMS_BUFFER_SHARED / 3);
  ss.images.forEach((im, i) => {
    const n = vclBytes(im) + im.vms.length;
    if (n > third) warns.push(`image ${i}: VCL + VMS ${n} bytes > 1/3 of the buffer (${third})`);
  });
  if (s2len >= 4096) warns.push(`S2 content ${s2len} bytes >= 4096 (more than half of the 8 KB sprite area, P6 2.4)`);
  const tags = ss.tags.map((t) => ({ name: t.name, first: t.first, count: t.count, mode: MODE_NAMES[t.mode], dur: t.dur }));
  const basic = `REM ${conf.name.toUpperCase()}: ` + tags.map((t) => `${t.name} ${t.first}-${t.first + t.count - 1} ${t.dur}J`).join(', ');
  return {
    name: conf.name, geometry_id: ss.geometryId, d: ss.depth, na: ss.na, np: ss.np,
    ni: ss.images.length, nk: ss.nk, nt: ss.tags.length, s2_bytes: s2len, vram: ss.u,
    vrl_bytes: st.stream_bytes, vrl_ratio: st.ratio, max_vms: mv, max_vcl_vms: mt,
    buffer: VMS_BUFFER_SHARED, rows, tags, tag_basic: tags.length ? basic : '', warnings: warns, infos,
  };
}

const h2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');

export function reportMd(rp) {
  const L = [`# ${rp.name} (sprite set)`, '',
    `Geometry ID ${rp.geometry_id}, NA ${rp.na}, NP ${rp.np}, D ${rp.d}, NI ${rp.ni}, NK ${rp.nk}, NT ${rp.nt}`, '',
    `- S2 content (bank 1): ${rp.s2_bytes} bytes`, `- VRAM U: ${rp.vram} bytes`,
    rp.vrl_ratio !== null ? `- VRL stream: ${rp.vrl_bytes} bytes, ratio ${pyFixed(rp.vrl_ratio, 3)}` : `- VRL stream: ${rp.vrl_bytes} bytes`,
    `- Buffer: largest VMS list ${rp.max_vms}, largest sum VCL + VMS ${rp.max_vcl_vms} (shared buffer ${rp.buffer})`, '',
    '## Images', '', '| Phase | Angle | Depth | Value | Image | Source | w x h | Foot | Cores | Core bytes | Edge | VMS | VCL |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rp.rows) {
    if (has(r, 'entry')) {
      L.push(`| ${r.phase} | ${r.angle} | ${r.depth} | ${r.value} | ${r.entry} | ${r.source} | ${r.w} x ${r.h} | `
        + `${r.foot[0]},${r.foot[1]} | ${r.cores} | ${r.core_bytes} | ${r.edge} | ${r.vms} | ${r.vcl} |`);
    } else L.push(`| ${r.phase} | ${r.angle} | ${r.depth} | $${h2(r.value)} |  | ${r.source} |  |  |  |  |  |  |  |`);
  }
  if (rp.tags.length) {
    L.push('', '## Tags', '', '| Name | Phase | Count | Mode | Jiffies |', '|---|---|---|---|---|');
    for (const t of rp.tags) L.push(`| ${t.name} | ${t.first} | ${t.count} | ${t.mode} | ${t.dur} |`);
    L.push('', '```', rp.tag_basic, '```');
  }
  if (rp.warnings.length) L.push('', '## Warnings', '', ...rp.warnings.map((w) => `- ${w}`));
  if (rp.infos.length) L.push('', '## Infos', '', ...rp.infos.map((w) => `- ${w}`));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- Preview (8)

/** Sets a pixel of an RGB image if inside. */
function setRgb(im, x, y, c) {
  if (x < 0 || y < 0 || x >= im.width || y >= im.height) return;
  im.rgb.set(c, (y * im.width + x) * 3);
}

/** All sub-positions of the cells (d, s) of one depth, clipped at the window edge, x4 -> {width, height, rgb}. */
export function preview(ss, geom, vram, d = 1, phase = 0, a = 0, vb = 0x4000) {
  const vp = geom.viewport;
  const VW = vp.width_px >> 1, VH = vp.height, stride = vp.stride;
  if (vb + vram.length > 65536) throw new SprError('Preview: VRAM data does not fit behind the preview base');
  const m = new Uint8Array(65536);
  m.set(vram, vb);
  for (let r = 0; r < VH; r++) for (let bx = 0; bx < VW; bx++) m[r * stride + bx] = (Math.floor(bx / 5) + (r >> 3)) & 1 ? 0x11 : 0x00;
  const idx = lookup(ss, phase, a, d);
  const marks = [];
  const slots = geom.slots.filter((s) => s.d === d).sort((x, y) => x.s - y.s);
  for (const sl of slots) {
    for (const p of [0, 1, 2, 3, 4]) {
      const [ax, ay] = sl.anchors_px[p];
      const axb = Math.floor(ax / 2);
      marks.push([axb, ay]);
      if (idx === null) continue;
      const im = ss.images[idx];
      renderImage(ss, idx, m, m, axb - im.fx, ay - im.fy, vp, { vb, clip: [0, VW, 0, VH] });
    }
  }
  const out = fbToImage(m, VW, VH, stride, 0, 4);
  const Y = [255, 255, 0];
  for (const [ax, ay] of marks) {
    const x = ax * 8 + 4, y = ay * 4 + 2;
    if (x >= 0 && x < out.width && y >= 0 && y < out.height) {
      for (let i = x - 4; i <= x + 4; i++) setRgb(out, i, y, Y);
      for (let j = y - 4; j <= y + 4; j++) setRgb(out, x, j, Y);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Whole command (CLI and editors)

/** dbespr build: spr.toml -> {files: {<name>.s2, <name>.vrl, <name>.spr.json, <name>.spr.md}, report, warnings
 *  (report warnings incl. the report's own), infos, ss, conf, geom, sources, previews: [{name: <name>_preview.png,
 *  image: {width, height, rgb}}], stream}. */
export function buildSpr(src, { path = 'spr.toml', resolve, out = null, strict = false, key = null, preview: withPreview = true } = {}) {
  const conf = loadConf(src, { path, out, strict, key });
  const { ss, warnings, infos, sources } = buildSpriteset(conf, resolve);
  const s2 = toS2(ss, conf.load);
  checkBank1('s2', conf.load, s2.length - 2);
  const stream = vrl.encode(Array.from(ss.vram));
  const rp = buildReport(ss, conf, warnings, infos, sources, stream, s2.length - 2);
  const name = conf.name;
  const files = {
    [name + '.s2']: s2, [name + '.vrl']: vrl.packFile(stream, conf.vrl_load),
    [name + '.spr.json']: pyDumps(rp, { indent: 1, ascii: false, floats: REPORT_FLOATS }) + '\n',
    [name + '.spr.md']: reportMd(rp),
  };
  const previews = [];
  if (withPreview) previews.push({ name: name + '_preview.png', image: preview(ss, ss.geom, ss.vram, 1) });
  return { files, report: rp, warnings: rp.warnings, infos, ss, conf, geom: ss.geom, sources, previews, stream };
}
