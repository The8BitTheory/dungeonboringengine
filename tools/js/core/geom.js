// Viewport geometry (view.toml) -> DVG, geom.json, paint templates, Aseprite atlas and budget. Port of
// tools/dbegeom.py (docs/specs/P3-geometry.md). All rounding is exact: Frac is a BigInt rational (Python's
// fractions.Fraction), rnd(v) = floor(v + 1/2).
//
// API (no DOM, no fs):
//   parseConfig(cfg) -> conf                    validate the TOML object (GeomError with the Python texts)
//   new Geometry(conf)                          planes Wp/T/B, images (front/side/floor/ceil), elements (incl. Slot),
//                                               bands, bandRows, horizon; X(k, u) -> Frac
//   layoutAtlas(geo) -> [w, h]                  sets im.atlas = [x, y]
//   imagePixels(im) -> rows of 0/1/2            0 empty, 1 mask, 2 kernel
//   renderTemplates(geo, zoom) / renderAtlas(geo, size) / renderView(geo, zoom)   pixel buffers {width, height, rgba|rgb}
//   buildAseprite(geo, size) -> Uint8Array      .aseprite (byte-identical with Python)
//   buildDvg(geo) -> {content, gid}             DVG without load address
//   computeBudget(geo) / budgetMarkdown(geo, bud) / buildJson(geo, gid, bud) / geomJsonText(obj)
//   checkLines(geo) -> [string]                 output of --check
//   generate(conf, name, {png}) -> {files, images, geo, bud, gid, json}
import * as dbemem from './mem.js';
import { encodePng } from './io/png.js';
import * as ase from './io/asewrite.js';

export const ART_FRONT = 0, ART_SIDE = 1, ART_FLOOR = 2, ART_CEIL = 3, ART_OBJ = 4;
export const ART_NAMES = Object.freeze({ 0: 'front', 1: 'side', 2: 'floor', 3: 'ceil', 4: 'obj' });
export const FLAG_COVER = 1, FLAG_PARTIAL = 2, FLAG_CLIPPED = 4, FLAG_BANDCOVER = 8;
export const VMS_BUFFER = 1300;

export const WESTWOOD = Object.freeze({
  ref_size: [176, 120],
  center_x: 88,
  width: [208, 128, 80, 48, 32],
  top: [-16, 8, 16, 24, 28],
  bottom: [144, 104, 80, 64, 56],
});

export const PALETTE = Object.freeze([[0x00, 0x00, 0x00], [0x55, 0x55, 0x55], [0x00, 0x00, 0xAA], [0x55, 0x55, 0xFF],
  [0x00, 0xAA, 0x00], [0x55, 0xFF, 0x55], [0x00, 0xAA, 0xAA], [0x55, 0xFF, 0xFF],
  [0xAA, 0x00, 0x00], [0xFF, 0x55, 0x55], [0xAA, 0x00, 0xAA], [0xFF, 0x55, 0xFF],
  [0xAA, 0x55, 0x00], [0xFF, 0xFF, 0x55], [0xAA, 0xAA, 0xAA], [0xFF, 0xFF, 0xFF]]);

export class GeomError extends Error {
  constructor(msg) { super(msg); this.name = 'GeomError'; }
}

// ---------------------------------------------------------------- exact rationals

const babs = (a) => (a < 0n ? -a : a);
function bgcd(a, b) { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a; }
// floor division of BigInts (BigInt / truncates toward zero)
function bfloordiv(a, b) { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; }

/** Exact rational number (fractions.Fraction). */
export class Frac {
  constructor(n, d = 1n) {
    n = BigInt(n); d = BigInt(d);
    if (d === 0n) throw new RangeError('Fraction(n, 0)');
    if (d < 0n) { n = -n; d = -d; }
    const g = bgcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }

  /** int, bigint, Frac or (exactly converted) float. */
  static of(v) {
    if (v instanceof Frac) return v;
    if (typeof v === 'bigint') return new Frac(v);
    if (Number.isInteger(v)) return new Frac(BigInt(v));
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`Frac: not a number: ${v}`);
    let d = 1n, x = v;
    while (!Number.isInteger(x)) { x *= 2; d *= 2n; }
    return new Frac(BigInt(x), d);
  }

  add(o) { o = Frac.of(o); return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = Frac.of(o); return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = Frac.of(o); return new Frac(this.n * o.n, this.d * o.d); }
  div(o) { o = Frac.of(o); if (o.n === 0n) throw new RangeError('Fraction division by zero'); return new Frac(this.n * o.d, this.d * o.n); }
  neg() { return new Frac(-this.n, this.d); }
  cmp(o) { o = Frac.of(o); const a = this.n * o.d, b = o.n * this.d; return a < b ? -1 : a > b ? 1 : 0; }
  eq(o) { return this.cmp(o) === 0; }
  /** v // 1 as Number. */
  floor() { return Number(bfloordiv(this.n, this.d)); }
  /** int(v): truncation toward zero. */
  trunc() { return Number(this.n / this.d); }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}

const HALF = new Frac(1n, 2n);

/** round(v) = floor(v + 1/2), exact. */
export function rnd(v) { return Frac.of(v).add(HALF).floor(); }

const fdiv = (a, b) => Math.floor(a / b);   // Python // on ints (exact for |a| < 2^53)

// anchors per cell: (lateral a, depth t)
const SLOT_POS = [[new Frac(-1n, 4n), new Frac(3n, 4n)], [new Frac(1n, 4n), new Frac(3n, 4n)], [new Frac(0n), HALF],
  [new Frac(-1n, 4n), new Frac(1n, 4n)], [new Frac(1n, 4n), new Frac(1n, 4n)]];

// ---------------------------------------------------------------- Configuration

const VIEWPORT_KEYS = new Set(['preset', 'width_px', 'height', 'origin', 'stride', 'depth', 'byte_edges']);
const OUTPUT_KEYS = new Set(['name', 'dir', 'load', 'pool_bytes', 'zoom']);
const PLANE_KEYS = new Set(['ref_size', 'center_x', 'width', 'top', 'bottom']);

const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const isInt = (v) => (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint';

/** Python str() of a TOML value (for error texts). */
function pyStr(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (isDict(v)) return '{' + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ') + '}';
  if (typeof v === 'number' && !Number.isInteger(v)) return String(v);
  return String(v);
}
function pyRepr(v) {
  if (typeof v === 'string') return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return pyStr(v);
}

function checkKeys(section, data, allowed) {
  for (const k of Object.keys(data)) if (!allowed.has(k)) throw new GeomError(`[${section}] unknown key '${k}'`);
}

function toInt(section, key, v) {
  if (!isInt(v)) throw new GeomError(`[${section}] ${key}: integer expected`);
  return Number(v);
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Validate raw data (object from TOML); returns the configuration object. */
export function parseConfig(cfg) {
  if (!isDict(cfg)) throw new GeomError('invalid configuration');
  for (const k of Object.keys(cfg)) {
    if (!['viewport', 'output', 'planes'].includes(k)) throw new GeomError(`unknown section '${k}'`);
  }
  const vp = { ...(cfg.viewport ?? {}) };
  const out = { ...(cfg.output ?? {}) };
  checkKeys('viewport', vp, VIEWPORT_KEYS);
  checkKeys('output', out, OUTPUT_KEYS);
  const preset = has(vp, 'preset') ? vp.preset : 'westwood';
  if (preset !== 'westwood' && preset !== 'custom') throw new GeomError(`[viewport] preset: unknown '${pyStr(preset)}'`);
  if (!has(vp, 'width_px')) throw new GeomError('[viewport] width_px missing');
  if (!has(vp, 'height')) throw new GeomError('[viewport] height missing');
  const width = toInt('viewport', 'width_px', vp.width_px);
  const height = toInt('viewport', 'height', vp.height);
  const origin = toInt('viewport', 'origin', has(vp, 'origin') ? vp.origin : 0);
  const stride = toInt('viewport', 'stride', has(vp, 'stride') ? vp.stride : 80);
  const byteEdges = has(vp, 'byte_edges') ? vp.byte_edges : false;
  if (typeof byteEdges !== 'boolean') throw new GeomError('[viewport] byte_edges: true or false expected');
  if (width % 4 !== 0) throw new GeomError('[viewport] width_px: must be a multiple of 4');
  if (!(width >= 16 && width <= 160)) throw new GeomError('[viewport] width_px: range 16 ... 160');
  if (!(height >= 8 && height <= 100)) throw new GeomError('[viewport] height: range 8 ... 100');
  if (origin < 0) throw new GeomError('[viewport] origin: must not be negative');
  if (stride < fdiv(width, 2)) throw new GeomError('[viewport] stride: smaller than width_px/2');
  if (stride > 255) throw new GeomError('[viewport] stride: greater than 255');
  if (origin + (height - 1) * stride + fdiv(width, 2) > 65535) {
    throw new GeomError('[viewport] origin/stride/height: buffer exceeds 65535');
  }
  let planes;
  if (preset === 'westwood') {
    if (has(cfg, 'planes')) throw new GeomError('[planes] only with preset = "custom"');
    planes = { ...WESTWOOD };
  } else {
    if (!has(cfg, 'planes')) throw new GeomError('[planes] missing (preset = "custom")');
    planes = { ...cfg.planes };
    checkKeys('planes', planes, PLANE_KEYS);
    for (const k of ['ref_size', 'width', 'top', 'bottom']) if (!has(planes, k)) throw new GeomError(`[planes] ${k} missing`);
    for (const k of ['width', 'top', 'bottom', 'ref_size']) {
      const v = planes[k];
      if (!Array.isArray(v) || v.some((x) => !isInt(x))) throw new GeomError(`[planes] ${k}: list of integers expected`);
      planes[k] = v.map(Number);
    }
    if (planes.ref_size.length !== 2 || planes.ref_size[0] <= 0 || planes.ref_size[1] <= 0) {
      throw new GeomError('[planes] ref_size: two positive values expected');
    }
    const half = new Frac(BigInt(planes.ref_size[0]), 2n);
    const cx = has(planes, 'center_x') ? planes.center_x : half;
    if (!(cx instanceof Frac || (typeof cx === 'number' && Number.isFinite(cx)) || typeof cx === 'bigint')
      || !Frac.of(cx).eq(half)) {
      throw new GeomError('[planes] center_x: must be ref_size[0] / 2 (symmetric viewport)');
    }
  }
  const n = planes.width.length;
  if (n < 3) throw new GeomError('[planes] width: at least 3 values');
  if (planes.top.length !== n) throw new GeomError('[planes] top: length does not match width');
  if (planes.bottom.length !== n) throw new GeomError('[planes] bottom: length does not match width');
  if (planes.ref_size.length !== 2 || planes.ref_size[0] <= 0 || planes.ref_size[1] <= 0) {
    throw new GeomError('[planes] ref_size: two positive values expected');
  }
  for (let i = 0; i + 1 < n; i++) if (!(planes.width[i] > planes.width[i + 1])) throw new GeomError('[planes] width: not strictly decreasing');
  for (let i = 0; i + 1 < n; i++) if (!(planes.top[i] < planes.top[i + 1])) throw new GeomError('[planes] top: not increasing');
  for (let i = 0; i + 1 < n; i++) if (!(planes.bottom[i] > planes.bottom[i + 1])) throw new GeomError('[planes] bottom: not decreasing');
  for (let k = 0; k < n; k++) if (planes.top[k] >= planes.bottom[k]) throw new GeomError(`[planes] top[${k}] >= bottom[${k}]`);
  const depth = n - 2;
  if (has(vp, 'depth') && toInt('viewport', 'depth', vp.depth) !== depth) {
    throw new GeomError(`[viewport] depth: ${pyStr(vp.depth)} does not match ${n} planes (expected ${depth})`);
  }
  if (preset === 'westwood' && depth !== 3) throw new GeomError('[viewport] depth: Westwood has exactly 3');
  const name = has(out, 'name') ? out.name : `${preset}${width}`;
  return {
    preset, width, height, origin, stride,
    byte_edges: byteEdges,
    depth, planes,
    name: pyStr(name), dir: pyStr(has(out, 'dir') ? out.dir : 'build/geom'),
    load: toInt('output', 'load', has(out, 'load') ? out.load : dbemem.defaultLoad('dvg')),
    pool_bytes: toInt('output', 'pool_bytes', has(out, 'pool_bytes') ? out.pool_bytes : 26624),
    zoom: toInt('output', 'zoom', has(out, 'zoom') ? out.zoom : 4),
  };
}

// ---------------------------------------------------------------- Geometry

/** An element or band with rectangle, mask, kernel etc. rect/kernel/cover are arrays (Python tuples). */
export class Image {
  constructor(name, art, d, s) {
    this.name = name; this.art = art; this.d = d; this.s = s;
    this.polygon = [];
    this.rect = [0, 0, 0, 0];       // x, y, w, h (bytes, rows)
    this.mask = [];                 // strings of '#', 'L', 'R', '.'
    this.kernel = [0, 0, 0, 0];
    this.cover = [0, 0];
    this.flags = 0;
    this.srcDx = 0;
    this.atlas = null;              // [x, y] in pixels or null
    this.isBand = false;
  }

  get artName() { return typeof this.art === 'string' ? this.art : ART_NAMES[this.art]; }
}

/** Object slot (Python: dict with art, d, s, name, anchors). */
export class Slot {
  constructor(d, s, name, anchors) { this.art = ART_OBJ; this.d = d; this.s = s; this.name = name; this.anchors = anchors; }
}

export const isSlot = (e) => e instanceof Slot;

const sgn = (s) => (s >= 0 ? `+${s}` : `${s}`);

export function elemName(art, d, s) { return `${art}_d${d}_s${sgn(s)}`; }

/** Anchor in DVG form: byte column saturated to -128 ... 127, row to 0 ... 255 (spec 4.3). */
export function anchorByte(xp, yp) { return [Math.max(-128, Math.min(127, fdiv(xp, 2))), Math.min(255, yp)]; }

/** Row bitmask (number, bigint or array of 0/1) -> Uint8Array of w bits. */
function toBits(v, w) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v, (x) => (x ? 1 : 0));
  const b = new Uint8Array(w), x = BigInt(v);
  for (let i = 0; i < w; i++) b[i] = Number((x >> BigInt(i)) & 1n);
  return b;
}

/** [length, start] of the longest run of ones (width w); on a tie the leftmost. v: bitmask or bit array. */
export function longestRun(v, w) {
  const b = toBits(v, w);
  let bl = 0, bs = 0, i = 0;
  while (i < w) {
    if (b[i]) {
      let j = i;
      while (j < w && b[j]) j++;
      if (j - i > bl) { bl = j - i; bs = i; }
      i = j;
    } else i++;
  }
  return [bl, bs];
}

/** Largest rectangle of ones in the rows (spec 4.4): maximum area, then greater width, smaller ky, smaller kx.
 *  Result [kx, ky, kw, kh] or null. rows: bitmasks (number/bigint) or bit arrays. Also used by dbetex. */
export function bestRect(rows, w) {
  const bits = rows.map((r) => toBits(r, w));
  const h = bits.length;
  let best = null, bk = null;
  const acc = new Uint8Array(w);
  for (let ky = 0; ky < h; ky++) {
    acc.fill(1);
    for (let ke = ky; ke < h; ke++) {
      const row = bits[ke];
      let any = false;
      for (let i = 0; i < w; i++) { acc[i] &= row[i]; if (acc[i]) any = true; }
      if (!any) break;
      const [ln, kx] = longestRun(acc, w);
      const kh = ke - ky + 1;
      const key = [ln * kh, ln, -ky, -kx];
      if (bk === null || cmpKey(key, bk) > 0) { bk = key; best = [kx, ky, ln, kh]; }
    }
  }
  return best;
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Bit arrays per mask row: bit i = byte column i full. */
export function fullRows(mask) { return mask.map((line) => Uint8Array.from(line, (ch) => (ch === '#' ? 1 : 0))); }

const key = (px, r) => r * 65536 + px;

export class Geometry {
  constructor(conf) {
    this.conf = conf;
    const W = conf.width, H = conf.height;
    this.width = W; this.height = H; this.D = conf.depth;
    this.VW = fdiv(W, 2);
    const pl = conf.planes;
    const sx = new Frac(BigInt(W), BigInt(pl.ref_size[0]));
    const sy = new Frac(BigInt(H), BigInt(pl.ref_size[1]));
    const n = this.D + 2;
    this.Wp = []; this.T = []; this.B = [];
    for (let k = 0; k < n; k++) {
      this.Wp.push(4 * rnd(Frac.of(pl.width[k]).mul(sx).div(4)));
      this.T.push(rnd(Frac.of(pl.top[k]).mul(sy)));
      this.B.push(rnd(Frac.of(pl.bottom[k]).mul(sy)));
    }
    this.C = fdiv(W, 2);
    for (let k = 0; k < n - 1; k++) {
      if (!(this.Wp[k] > this.Wp[k + 1])) throw new GeomError(`plane ${k}: scaled width not strictly decreasing`);
    }
    if (this.Wp[n - 1] <= 0) throw new GeomError('scaled width of the last plane <= 0');
    for (let k = 0; k < n; k++) if (!(this.T[k] < this.B[k])) throw new GeomError(`plane ${k}: T >= B after scaling`);
    for (let d = 1; d <= this.D; d++) if (this.Wp[d] > W) throw new GeomError('full front wider than the window');
    this.S = this.D;
    this.images = [];       // front, side, floor, ceiling in element order per cell
    this.elements = [];     // everything incl. object slots (Image or Slot)
    this.bands = [];        // Image (isBand)
    this.horizon = [0, 0];
    this.bandRows = [];     // per depth [[ceil y0, y1], [floor y0, y1]]
    this.atlasSize = null;
    this._build();
  }

  /** X(k, u) = C + u * W'_k (exact). */
  X(k, u) { return Frac.of(u).mul(this.Wp[k]).add(this.C); }

  _polygons(d, s) {
    const h = HALF, X = (k, u) => this.X(k, u), T = this.T, B = this.B;
    const S = Frac.of(s);
    const res = {};
    if (d >= 1) res[ART_FRONT] = [[X(d, S.sub(h)), T[d]], [X(d, S.add(h)), T[d]], [X(d, S.add(h)), B[d]], [X(d, S.sub(h)), B[d]]];
    if (s !== 0) {
      const u = s < 0 ? S.add(h) : S.sub(h);
      res[ART_SIDE] = [[X(d, u), T[d]], [X(d + 1, u), T[d + 1]], [X(d + 1, u), B[d + 1]], [X(d, u), B[d]]];
    }
    res[ART_FLOOR] = [[X(d + 1, S.sub(h)), B[d + 1]], [X(d + 1, S.add(h)), B[d + 1]], [X(d, S.add(h)), B[d]], [X(d, S.sub(h)), B[d]]];
    res[ART_CEIL] = [[X(d + 1, S.sub(h)), T[d + 1]], [X(d + 1, S.add(h)), T[d + 1]], [X(d, S.add(h)), T[d]], [X(d, S.sub(h)), T[d]]];
    return res;
  }

  /** Set of the pixels whose center lies in the convex polygon (exact, integer-doubled). Keys r * 65536 + px. */
  _maskPixels(poly) {
    const W = this.width, H = this.height;
    const pts = poly.map(([x, y]) => [Frac.of(x).mul(2).trunc(), Frac.of(y).mul(2).trunc()]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    if (area === 0) return new Set();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const px0 = Math.max(0, fdiv(Math.min(...xs), 2) - 1);
    const px1 = Math.min(W - 1, fdiv(Math.max(...xs), 2) + 1);
    const r0 = Math.max(0, fdiv(Math.min(...ys), 2) - 1);
    const r1 = Math.min(H - 1, fdiv(Math.max(...ys), 2) + 1);
    let res = new Set();
    const edges = pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
    for (let r = r0; r <= r1; r++) {
      const cy = 2 * r + 1;
      for (let px = px0; px <= px1; px++) {
        const cx = 2 * px + 1;
        let pos = false, neg = false;
        for (const [[x1, y1], [x2, y2]] of edges) {
          const c = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1);
          if (c > 0) pos = true; else if (c < 0) neg = true;
        }
        if (!(pos && neg)) res.add(key(px, r));
      }
    }
    if (this.conf.byte_edges) res = Geometry._roundBytes(res, edges, r0, r1, px0, px1);
    return res;
  }

  /** Round half bytes to whole bytes (see dbegeom.py _round_bytes). */
  static _roundBytes(res, edges, r0, r1, px0, px1) {
    const out = new Set();
    for (let r = r0; r <= r1; r++) {
      const cy = 2 * r + 1;
      for (let bx = fdiv(px0, 2); bx <= fdiv(px1, 2); bx++) {
        const left = res.has(key(2 * bx, r)), right = res.has(key(2 * bx + 1, r));
        if (left && right) { out.add(key(2 * bx, r)); out.add(key(2 * bx + 1, r)); } else if (left || right) {
          const cx = 4 * bx + 2;
          let onEdge = false, pos = false, neg = false;
          for (const [[x1, y1], [x2, y2]] of edges) {
            const c = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1);
            if (c === 0) onEdge = true;
            if (c > 0) pos = true;
            if (c < 0) neg = true;
          }
          const outside = pos && neg;
          if (!outside && (!onEdge || left)) { out.add(key(2 * bx, r)); out.add(key(2 * bx + 1, r)); }
        }
      }
    }
    return out;
  }

  /** Rectangle, mask, clipping from a pixel set. */
  _fillImage(im, pix, poly) {
    im.polygon = poly.map(([x, y]) => [Frac.of(x).trunc(), Frac.of(y).trunc()]);
    const xs = im.polygon.map((p) => p[0]), ys = im.polygon.map((p) => p[1]);
    if (Math.min(...xs) < 0 || Math.max(...xs) > this.width || Math.min(...ys) < 0 || Math.max(...ys) > this.height) {
      im.flags |= FLAG_CLIPPED;
    }
    let pxMin = Infinity, pxMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (const k of pix) {
      const px = k % 65536, r = Math.floor(k / 65536);
      if (px < pxMin) pxMin = px;
      if (px > pxMax) pxMax = px;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
    }
    const bx0 = fdiv(pxMin, 2), bx1 = fdiv(pxMax, 2);
    im.rect = [bx0, rMin, bx1 - bx0 + 1, rMax - rMin + 1];
    const rows = [];
    for (let r = rMin; r <= rMax; r++) {
      let line = '';
      for (let bx = bx0; bx <= bx1; bx++) {
        const l = pix.has(key(2 * bx, r)), rr = pix.has(key(2 * bx + 1, r));
        line += l && rr ? '#' : l ? 'L' : rr ? 'R' : '.';
      }
      rows.push(line);
    }
    im.mask = rows;
  }

  _kernel(im) { im.kernel = bestRect(fullRows(im.mask), im.rect[2]) || [0, 0, 0, 0]; }

  _cover(im) {
    const d = im.d;
    const [x, y, w, h] = im.rect;
    const r0 = Math.max(this.T[d + 1], 0), r1 = Math.min(this.B[d + 1], this.height);
    if (r1 <= r0) { im.cover = [0, 0]; return; }
    const rows = fullRows(im.mask);
    const acc = new Uint8Array(w).fill(1);
    for (let r = r0; r < r1; r++) {
      if (r < y || r >= y + h) { acc.fill(0); break; }
      const row = rows[r - y];
      for (let i = 0; i < w; i++) acc[i] &= row[i];
    }
    const [ln, st] = longestRun(acc, w);
    im.cover = ln ? [x + st, x + st + ln] : [0, 0];
    if (ln) im.flags |= FLAG_COVER;
  }

  _anchors(d, s) {
    const Wp = this.Wp, B = this.B;
    const res = [];
    for (const [a, t] of SLOT_POS) {
      const one = new Frac(1n);
      const Wt = one.div(one.sub(t).div(Wp[d]).add(t.div(Wp[d + 1])));
      const x = Frac.of(s).add(a).mul(Wt).add(this.C);
      const y = new Frac(BigInt(B[d + 1] - B[d])).mul(Frac.of(Wp[d]).sub(Wt)).div(Wp[d] - Wp[d + 1]).add(B[d]);
      const xp = rnd(x), yp = rnd(y);
      if (yp < 0) throw new GeomError(`anchor d=${d} s=${s}: row ${yp} above the window`);
      res.push([xp, yp]);
    }
    return res;
  }

  _build() {
    const D = this.D, S = this.S;
    const elems = [];
    for (let d = 0; d <= D; d++) {
      const cells = [0];
      for (let k = 1; k <= S; k++) cells.push(-k, k);
      for (const s of cells) {
        const polys = this._polygons(d, s);
        let hasFloor = false;
        for (const art of [ART_FRONT, ART_SIDE, ART_FLOOR, ART_CEIL]) {
          if (!(art in polys)) continue;
          const pix = this._maskPixels(polys[art]);
          if (!pix.size) continue;
          const im = new Image(elemName(ART_NAMES[art], d, s), art, d, s);
          this._fillImage(im, pix, polys[art]);
          this._kernel(im);
          if (art === ART_FRONT || art === ART_SIDE) this._cover(im);
          if (art === ART_FRONT && s !== 0) {
            im.flags |= FLAG_PARTIAL;
            im.srcDx = fdiv(im.rect[0] * 2 - this.X(d, Frac.of(s).sub(HALF)).trunc(), 2);
          }
          if (art === ART_FLOOR) hasFloor = true;
          elems.push(im);
        }
        if (hasFloor) elems.push(new Slot(d, s, `obj_d${d}_s${sgn(s)}`, this._anchors(d, s)));
      }
    }
    if (elems.length > 255) throw new GeomError(`too many elements: ${elems.length} (max. 255)`);
    this.elements = elems;
    this.images = elems.filter((e) => e instanceof Image);
    if (!this.images.some((i) => i.art === ART_FRONT && i.s === 0)) throw new GeomError('no front present');
    const H = this.height;
    const clip = (a, b) => {
      a = Math.max(0, Math.min(a, H)); b = Math.max(0, Math.min(b, H));
      return [a, Math.max(a, b)];
    };
    this.bandRows = [];
    for (let d = 0; d <= D; d++) this.bandRows.push([clip(this.T[d], this.T[d + 1]), clip(this.B[d + 1], this.B[d])]);
    this.horizon = clip(this.T[D + 1], this.B[D + 1]);
    // DVG flag bit 3 (band cover, P6 5.1): fronts whose rectangle contains the band rows of their depth
    for (const im of this.images) {
      if (im.art === ART_FRONT) {
        const [[c0], [, f1]] = this.bandRows[im.d];
        if (im.rect[1] <= c0 && im.rect[1] + im.rect[3] >= f1) im.flags |= FLAG_BANDCOVER;
      }
    }
    // check for gaps
    const cover = new Array(H).fill(0);
    for (const [[c0, c1], [f0, f1]] of this.bandRows) {
      for (let r = c0; r < c1; r++) cover[r]++;
      for (let r = f0; r < f1; r++) cover[r]++;
    }
    for (let r = this.horizon[0]; r < this.horizon[1]; r++) cover[r]++;
    if (cover.some((c) => c !== 1)) throw new GeomError('bands do not cover the rows gap-free and overlap-free');
    for (let d = 0; d <= D; d++) {
      for (const [art, [y0, y1]] of [['ceilband', this.bandRows[d][0]], ['floorband', this.bandRows[d][1]]]) {
        if (y1 > y0) {
          const im = new Image(`${art}_d${d}`, art, d, 0);
          im.isBand = true;
          im.rect = [0, y0, this.VW, y1 - y0];
          im.mask = new Array(y1 - y0).fill('#'.repeat(this.VW));
          im.kernel = [0, 0, this.VW, y1 - y0];
          this.bands.push(im);
        }
      }
    }
  }

  byName(name) { return this.images.concat(this.bands).find((im) => im.name === name) ?? null; }

  /** Images in atlas order, grouped by rows (list of lists). */
  atlasImages() {
    const D = this.D, rows = [];
    rows.push(this.images.filter((i) => i.art === ART_FRONT && i.s === 0));
    for (let d = 0; d <= D; d++) rows.push(this.images.filter((i) => i.art === ART_SIDE && i.d === d));
    rows.push(this.bands.filter((b) => b.art === 'floorband'));
    rows.push(this.bands.filter((b) => b.art === 'ceilband'));
    for (let d = 0; d <= D; d++) rows.push(this.images.filter((i) => i.art === ART_FLOOR && i.d === d));
    for (let d = 0; d <= D; d++) rows.push(this.images.filter((i) => i.art === ART_CEIL && i.d === d));
    return rows.filter((r) => r.length);
  }
}

// ---------------------------------------------------------------- Atlas

/** Compute the atlas layout; sets im.atlas, returns [width, height]. */
export function layoutAtlas(geo) {
  const rows = geo.atlasImages();
  let widest = 0;
  for (const r of rows) widest = Math.max(widest, r.reduce((a, i) => a + i.rect[2] * 2, 0) + 4 * (r.length - 1));
  const aw = Math.max(geo.width, widest) + 8;
  let y = 4;
  for (const r of rows) {
    let x = 4, rh = 0;
    for (const im of r) {
      im.atlas = [x, y];
      x += im.rect[2] * 2 + 4;
      rh = Math.max(rh, im.rect[3]);
    }
    y += rh + 4;
  }
  return [aw, y];
}

/** For every pixel of the image rectangle 0 = empty, 1 = mask, 2 = kernel (list of rows). */
export function imagePixels(im) {
  const w = im.rect[2];
  const [kx, ky, kw, kh] = im.kernel;
  return im.mask.map((line, r) => {
    const row = [];
    for (let bx = 0; bx < w; bx++) {
      const ch = line[bx];
      const inker = kw && kx <= bx && bx < kx + kw && ky <= r && r < ky + kh;
      for (const side of [0, 1]) {
        const on = ch === '#' || (ch === 'L' && side === 0) || (ch === 'R' && side === 1);
        row.push(!on ? 0 : inker ? 2 : 1);
      }
    }
    return row;
  });
}

const COLORS = { 1: [...PALETTE[14], 255], 2: [...PALETTE[1], 255] };

/** Nearest-neighbour upscale by an integer factor (PIL resize NEAREST); ch = bytes per pixel. */
function zoomImage(img, zoom) {
  if (zoom <= 1) return img;
  const ch = img.rgba ? 4 : 3, src = img.rgba || img.rgb;
  const W = img.width * zoom, H = img.height * zoom, dst = new Uint8Array(W * H * ch);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / zoom);
    for (let x = 0; x < W; x++) {
      const s = (sy * img.width + Math.floor(x / zoom)) * ch, d = (y * W + x) * ch;
      for (let c = 0; c < ch; c++) dst[d + c] = src[s + c];
    }
  }
  return { width: W, height: H, [ch === 4 ? 'rgba' : 'rgb']: dst };
}

/** Paint template per atlas image (tpl/<name>.png): {name: {width, height, rgba}}, enlarged by zoom. */
export function renderTemplates(geo, zoom) {
  const res = {};
  for (const im of geo.images.concat(geo.bands)) {
    if (im.atlas === null) continue;
    const w = im.rect[2] * 2, h = im.rect[3], rgba = new Uint8Array(w * h * 4);
    imagePixels(im).forEach((row, r) => row.forEach((v, c) => { if (v) rgba.set(COLORS[v], (r * w + c) * 4); }));
    res[im.name] = zoomImage({ width: w, height: h, rgba }, zoom);
  }
  return res;
}

/** Paint template 1:1 (<name>_atlas.png, RGBA). */
export function renderAtlas(geo, atlasSize = geo.atlasSize) {
  const [aw, ah] = atlasSize, rgba = new Uint8Array(aw * ah * 4);
  for (const im of geo.images.concat(geo.bands)) {
    if (im.atlas === null) continue;
    const [ax, ay] = im.atlas;
    imagePixels(im).forEach((row, r) => row.forEach((v, c) => {
      const x = ax + c, y = ay + r;
      if (v && x >= 0 && x < aw && y >= 0 && y < ah) rgba.set(COLORS[v], (y * aw + x) * 4);
    }));
  }
  return { width: aw, height: ah, rgba };
}

/** Overview (<name>_view.png, RGB): polygon outlines per depth, band markers, anchors; enlarged by zoom. */
export function renderView(geo, zoom) {
  const W = geo.width, H = geo.height, rgb = new Uint8Array(W * H * 3);
  const point = (x, y, col) => { if (x >= 0 && x < W && y >= 0 && y < H) rgb.set(col, (y * W + x) * 3); };
  // PIL ImagingDrawLine (Bresenham, end point excluded); draw_lines adds the last point
  const line = (x0, y0, x1, y1, col) => {
    let dx = x1 - x0, dy = y1 - y0, xs = 1, ys = 1;
    if (dx < 0) { dx = -dx; xs = -1; }
    if (dy < 0) { dy = -dy; ys = -1; }
    if (dx === 0) { for (let i = 0; i < dy; i++) { point(x0, y0, col); y0 += ys; } } else if (dy === 0) {
      for (let i = 0; i < dx; i++) { point(x0, y0, col); x0 += xs; }
    } else if (dx > dy) {
      const n = dx; dy += dy; let e = dy - dx; dx += dx;
      for (let i = 0; i < n; i++) { point(x0, y0, col); if (e >= 0) { y0 += ys; e -= dx; } e += dy; x0 += xs; }
    } else {
      const n = dy; dx += dx; let e = dx - dy; dy += dy;
      for (let i = 0; i < n; i++) { point(x0, y0, col); if (e >= 0) { x0 += xs; e -= dy; } e += dx; y0 += ys; }
    }
  };
  const rect = (x0, y0, x1, y1, col) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) point(x, y, col); };
  const dcol = [PALETTE[9], PALETTE[13], PALETTE[5], PALETTE[3]];
  for (const im of geo.images) {
    const col = dcol[im.d % 4], pts = im.polygon.concat([im.polygon[0]]);
    for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], col);
    const last = pts[pts.length - 1];
    if (pts.length > 1) point(last[0], last[1], col);
  }
  for (const [[c0, c1], [f0, f1]] of geo.bandRows) {
    if (c1 > c0) rect(0, c0, 3, c1 - 1, PALETTE[7]);
    if (f1 > f0) rect(0, f0, 3, f1 - 1, PALETTE[12]);
  }
  if (geo.horizon[1] > geo.horizon[0]) rect(0, geo.horizon[0], 3, geo.horizon[1] - 1, PALETTE[11]);
  for (const e of geo.elements) {
    if (!isSlot(e)) continue;
    for (const [ax, ay] of e.anchors) {
      for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) point(ax + dx, ay + dy, [255, 255, 255]);
    }
  }
  return zoomImage({ width: W, height: H, rgb }, zoom);
}

// ---------------------------------------------------------------- Aseprite

/** .aseprite of the atlas: layers Mask (indexed 1/14/16) and Image (empty), slices per image with user data. */
export function buildAseprite(geo, atlasSize = geo.atlasSize) {
  const [aw, ah] = atlasSize;
  const chunks = [];
  chunks.push(ase.colorProfileChunk());
  chunks.push(ase.paletteChunk(PALETTE.map(([r, g, b]) => [r, g, b, 255]).concat([[0, 0, 0, 0]])));
  chunks.push(ase.layerChunk(1, 128, 'Mask'));
  chunks.push(ase.layerChunk(1 | 2, 255, 'Image'));
  const buf = new Uint8Array(aw * ah).fill(16);
  for (const im of geo.images.concat(geo.bands)) {
    if (im.atlas === null) continue;
    const [ax, ay] = im.atlas;
    imagePixels(im).forEach((row, r) => row.forEach((v, c) => { if (v) buf[(ay + r) * aw + ax + c] = v === 1 ? 14 : 1; }));
  }
  chunks.push(ase.compressedCelChunk(0, 0, 0, aw, ah, buf));
  chunks.push(ase.compressedCelChunk(1, 0, 0, aw, ah, new Uint8Array(aw * ah).fill(16)));
  for (const r of geo.atlasImages()) {
    for (const im of r) {
      const [ax, ay] = im.atlas;
      const [kx, ky, kw, kh] = im.kernel;
      chunks.push(ase.sliceChunk(im.name, ax, ay, im.rect[2] * 2, im.rect[3], kw > 0 ? [kx * 2, ky, kw * 2, kh] : null));
      // json.dumps with ensure_ascii=True: non-ASCII as \uXXXX (UTF-16 units)
      const ud = JSON.stringify({ art: im.artName, d: im.d, s: im.s, src_dx: im.srcDx }).replace(/[^\x00-\x7f]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      chunks.push(ase.userDataChunk(ud));
    }
  }
  return ase.aseFile(aw, ah, chunks);
}

// ---------------------------------------------------------------- DVG

/** CRC-CCITT as binascii.crc_hqx. */
export function crcHqx(data, crc) {
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

function bytesOf(vals, single = false) {
  for (const v of vals) {
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(single ? 'byte must be in range(0, 256)' : 'bytes must be in range(0, 256)');
  }
  return Uint8Array.from(vals);
}

/** Returns {content, gid}; content without load address, geometry ID already inserted. */
export function buildDvg(geo) {
  const D = geo.D, conf = geo.conf, elems = geo.elements, ne = elems.length;
  const total = 24 + 8 * (D + 1) + 16 * ne;
  const smax = Math.max(...elems.map((e) => Math.abs(e.s)));
  const content = new Uint8Array(total);
  const u16 = (o, v) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) throw new RangeError("'H' format requires 0 <= number <= 65535");
    content[o] = v & 255; content[o + 1] = v >> 8;
  };
  content.set([0x44, 0x56, 1]);
  content.set(bytesOf([geo.VW, geo.height, D, smax, ne], true), 3);
  u16(8, conf.stride); u16(10, conf.origin);
  content.set(bytesOf(geo.horizon, true), 14);
  content[16] = 16; content[17] = 8;
  u16(18, 24); u16(20, 24 + 8 * (D + 1)); u16(22, total);
  let o = 24;
  for (let d = 0; d <= D; d++) {
    const idx = [];
    elems.forEach((e, i) => { if (e.d === d) idx.push(i); });
    const [[c0, c1], [f0, f1]] = geo.bandRows[d];
    let fw = 0, fc = 0;
    if (d !== 0) {
      const fr = geo.images.find((i) => i.art === ART_FRONT && i.d === d && i.s === 0);
      fw = fdiv(geo.Wp[d], 2); fc = fr.rect[0];
    }
    content.set(bytesOf([c0, c1, f0, f1, idx[0], idx.length, fw, fc]), o);
    o += 8;
  }
  for (const e of elems) {
    let row;
    if (isSlot(e)) {
      row = new Uint8Array(16);
      row[0] = ART_OBJ; row[1] = bytesOf([e.d], true)[0]; row[2] = e.s & 255;
      e.anchors.forEach(([ax, ay], p) => {
        const [bc, by] = anchorByte(ax, ay);
        row[4 + 2 * p] = bc & 255;
        row[5 + 2 * p] = bytesOf([by], true)[0];
      });
    } else {
      const [x, y, w, h] = e.rect;
      row = bytesOf([e.art, e.d, e.s & 255, e.flags, x, y, w, h, ...e.kernel, e.cover[0], e.cover[1], e.srcDx, 0], true);
    }
    content.set(row, o);
    o += 16;
  }
  const tmp = Uint8Array.from(content);
  tmp[10] = 0; tmp[11] = 0;           // origin (position, not shape) does not enter the ID
  const gid = crcHqx(tmp, 0xFFFF) || 1;
  u16(12, gid);
  return { content, gid };
}

// ---------------------------------------------------------------- Budget

/** [kernel bytes, edge bytes, vms length]. */
export function imageBudget(im) {
  const [kx, ky, kw, kh] = im.kernel;
  const core = kw * kh;
  let edge = 0, vms = 3;
  im.mask.forEach((line, r) => {
    let cmds = 0, prevFull = false;
    for (let bx = 0; bx < line.length; bx++) {
      const ch = line[bx];
      if (kw && kx <= bx && bx < kx + kw && ky <= r && r < ky + kh) { prevFull = false; continue; }
      if (ch === '.') { prevFull = false; continue; }
      edge++;
      if (ch === '#') { if (!prevFull) cmds += 4; prevFull = true; } else { cmds += 3; prevFull = false; }
    }
    vms += cmds;
  });
  if (edge === 0) vms = 0;
  return [core, edge, vms];
}

export function computeBudget(geo) {
  const pool = geo.conf.pool_bytes;
  const rows = [];
  for (const im of geo.images.concat(geo.bands)) {
    const [core, edge, vms] = imageBudget(im);
    const partial = im.art === ART_FRONT && im.s !== 0;
    const vram = partial ? 0 : core + edge;
    rows.push({ name: im.name, art: im.artName, rect: [...im.rect], kernel: [...im.kernel], core: partial ? 0 : core,
      edge: partial ? 0 : edge, vram, vms: partial ? 0 : vms });
  }
  const sums = {};
  for (const r of rows) sums[r.art] = (sums[r.art] ?? 0) + r.vram;
  const g = (k) => sums[k] ?? 0;
  const wall = g('front') + g('side');
  const floorb = g('floorband'), ceilb = g('ceilband');
  const base = floorb + ceilb;
  const nStyles = wall ? Math.max(0, fdiv(pool - base, wall)) : 0;
  const vmsWall = rows.filter((r) => r.art === 'front' || r.art === 'side').reduce((a, r) => a + r.vms, 0);
  return {
    rows,
    sum_front: g('front'), sum_side: g('side'),
    wall_style: wall, floor_bands: floorb, ceil_bands: ceilb,
    floor_tiles: g('floor'), ceil_tiles: g('ceil'),
    pool_bytes: pool, wall_styles_in_pool: nStyles,
    vms_wall_total: vmsWall, vms_buffer: VMS_BUFFER, vms_overflow: vmsWall > VMS_BUFFER,
  };
}

export function budgetMarkdown(geo, bud) {
  const c = geo.conf;
  const L = [`# Budget ${c.name} (${geo.width} x ${geo.height})`, '',
    '| Name | Rectangle | Kernel | Edge | VRAM | VMS list |', '|---|---|---|---|---|---|'];
  for (const r of bud.rows) L.push(`| ${r.name} | (${r.rect.join(', ')}) | ${r.core} | ${r.edge} | ${r.vram} | ${r.vms} |`);
  L.push('', '## Totals per style', '',
    `- Full fronts: ${bud.sum_front} bytes`,
    `- Sides: ${bud.sum_side} bytes`,
    `- **Wall style (front + side): ${bud.wall_style} bytes**`,
    `- Floor bands: ${bud.floor_bands} bytes (tiles additionally: ${bud.floor_tiles} bytes)`,
    `- Ceiling bands: ${bud.ceil_bands} bytes (tiles additionally: ${bud.ceil_tiles} bytes)`,
    '', '## Pool', '',
    `- Pool: ${bud.pool_bytes} bytes; floor + ceiling style (bands): ${bud.floor_bands + bud.ceil_bands} bytes`,
    `- Wall styles that fit into the pool together with 1 floor and 1 ceiling style each: ${bud.wall_styles_in_pool}`,
    '', '## VMS buffer', '',
    `- Sum of the VMS lists of all wall elements of a style (upper bound): ${bud.vms_wall_total} bytes`
    + ` (buffer ${bud.vms_buffer} bytes)`);
  if (bud.vms_overflow) L.push('- WARNING: sum exceeds the VMS buffer.');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- JSON

const flagNames = (f) => [[FLAG_COVER, 'cover'], [FLAG_PARTIAL, 'partial'], [FLAG_CLIPPED, 'clipped'],
  [FLAG_BANDCOVER, 'bandcover']].filter(([b]) => f & b).map(([, n]) => n);

/** Object of <name>.geom.json (key order as Python). */
export function buildJson(geo, gid, bud) {
  const c = geo.conf;
  const planes = [];
  for (let k = 0; k < geo.D + 2; k++) {
    planes.push({ k, W: geo.Wp[k], x_left: geo.X(k, new Frac(-1n, 2n)).trunc(), x_right: geo.X(k, HALF).trunc(),
      T: geo.T[k], B: geo.B[k] });
  }
  const bands = geo.bandRows.map(([[c0, c1], [f0, f1]], d) => ({ d, ceil: [c0, c1], floor: [f0, f1] }));
  const bandImgs = geo.bands.map((b) => ({ name: b.name, art: b.art, d: b.d, rect: [...b.rect], atlas: b.atlas ? [...b.atlas] : null }));
  const elements = [], slots = [];
  geo.elements.forEach((e, i) => {
    if (isSlot(e)) {
      slots.push({ index: i, name: e.name, d: e.d, s: e.s, anchors_px: e.anchors.map((a) => [...a]) });
      elements.push({ index: i, name: e.name, art: 'obj', d: e.d, s: e.s,
        anchors: e.anchors.map((a, p) => ({ name: `${e.name}_p${p}`, px: [...a], byte: anchorByte(...a) })) });
    } else {
      elements.push({ index: i, name: e.name, art: ART_NAMES[e.art], d: e.d, s: e.s,
        rect: [...e.rect], kernel: [...e.kernel], cover: [...e.cover],
        flags: flagNames(e.flags), src_dx: e.srcDx, polygon: e.polygon, mask: e.mask,
        atlas: e.atlas ? [...e.atlas] : null });
    }
  });
  return {
    format: 'dbegeom', version: 1, geometry_id: gid,
    viewport: { preset: c.preset, width_px: geo.width, height: geo.height,
      origin: c.origin, stride: c.stride, depth: geo.D, byte_edges: c.byte_edges },
    planes, bands, band_images: bandImgs, horizon: [...geo.horizon],
    atlas_size: [...geo.atlasSize],
    elements, slots, budget: bud,
  };
}

/** json.dump(obj, indent=indent, ensure_ascii=False) of Python. */
export function pyJsonDumps(obj, indent = 1) {
  const enc = (v, lvl) => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return String(v);
      if (Number.isNaN(v)) return 'NaN';
      if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
      return pyFloatRepr(v);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return JSON.stringify(v);
    const pad = '\n' + ' '.repeat(indent * (lvl + 1)), end = '\n' + ' '.repeat(indent * lvl);
    if (Array.isArray(v)) return v.length ? '[' + v.map((x) => pad + enc(x, lvl + 1)).join(',') + end + ']' : '[]';
    const ent = Object.entries(v);
    return ent.length ? '{' + ent.map(([k, x]) => pad + JSON.stringify(k) + ': ' + enc(x, lvl + 1)).join(',') + end + '}' : '{}';
  };
  return enc(obj, 0);
}

function pyFloatRepr(v) {
  let s = String(v);
  if (/e/.test(s)) {
    const [m, e] = s.split('e');
    const ex = parseInt(e, 10);
    s = `${m}e${ex < 0 ? '-' : '+'}${String(Math.abs(ex)).padStart(2, '0')}`;
  } else if (!s.includes('.')) s += '.0';
  return s;
}

/** Text of <name>.geom.json (json.dump indent=1, no trailing newline). */
export const geomJsonText = (obj) => pyJsonDumps(obj, 1);

// ---------------------------------------------------------------- check / generate

/** Lines of --check. */
export function checkLines(geo) {
  return geo.elements.map((e) => {
    if (isSlot(e)) return `d=${e.d} s=${e.s} obj anchors=` + e.anchors.map((a) => `(${anchorByte(...a).join(',')})`).join(' ');
    const [x, y, w, h] = e.rect;
    return `d=${e.d} s=${e.s} ${ART_NAMES[e.art]} x=${x} y=${y} w=${w} h=${h} core=${e.kernel.join(',')}`
      + ` cov=${e.cover[0]}..${e.cover[1]} src_dx=${e.srcDx}`;
  });
}

/** All outputs of dbegeom generate(): files {relative path: Uint8Array | string}, pixel buffers in images
 *  {relative path of the PNG: {width, height, rgba|rgb}}. With png = false the PNGs are not encoded (only images). */
export function generate(conf, name = conf.name, { png = true } = {}) {
  const geo = new Geometry(conf);
  geo.atlasSize = layoutAtlas(geo);
  const { content, gid } = buildDvg(geo);
  const err = dbemem.rangeError('dvg', conf.load, content.length);
  if (err) throw new GeomError(err);
  const files = {};
  const dvg = new Uint8Array(content.length + 2);
  dvg[0] = conf.load & 255; dvg[1] = (conf.load >> 8) & 255;
  dvg.set(content, 2);
  files[`${name}.dvg`] = dvg;
  const bud = computeBudget(geo);
  const json = buildJson(geo, gid, bud);
  files[`${name}.geom.json`] = geomJsonText(json);
  files[`${name}.budget.md`] = budgetMarkdown(geo, bud);
  files[`${name}.aseprite`] = buildAseprite(geo, geo.atlasSize);
  const images = {};
  for (const [n, img] of Object.entries(renderTemplates(geo, conf.zoom))) images[`tpl/${n}.png`] = img;
  images[`${name}_atlas.png`] = renderAtlas(geo, geo.atlasSize);
  images[`${name}_view.png`] = renderView(geo, conf.zoom);
  if (png) for (const [n, img] of Object.entries(images)) files[n] = encodePng(img);
  return { files, images, geo, bud, gid, json };
}
