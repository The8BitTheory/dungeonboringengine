// Perspective-correct wall, floor and ceiling images from flat patterns (docs/specs/P5-textures.md, 10.3).
// Port of tools/dbepersp.py (same floating point operations in the same order, so results are identical).
//
// Model (from geom.json: viewport.width_px, planes[k].W/T/B):
//   World coordinates in cells: X sideways (0 = center), Z depth, Y downward. Plane k lies at Z_k = W_1 / W_k.
//   Screen: x = C + X * W(Z), W = W_1 / Z, C = width_px / 2.
//   Front (plane d): u = X = (x - C) / W_d, v = (y - T_d) / W_d.
//   Side at lateral edge e: W(x) = (x - C) / e, u = Z = W_1 / W(x), v = (y - top(x)) / W(x).
//   Floor: W(y) linear between W_d at B_d and W_{d+1} at B_{d+1}; u = X, v = Z = W_1 / W. Ceiling with T_k.
// Patterns are functions pattern(u, v) -> palette index | null; `bias` {color: weight} keeps thin joints visible.
import { PALETTE } from './tex.js';
import { decodeImage } from './io/image.js';

export const PAL = PALETTE;

/** Python a % b for floats (result has the sign of b). */
const fmod = (a, b) => { const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; };

export class PerspError extends Error {
  constructor(msg) { super(msg); this.name = 'PerspError'; }
}

/** World mapping for one geometry (geom.json as object). */
export class Persp {
  constructor(geom) {
    this.geom = geom;
    this.C = geom.viewport.width_px / 2;
    this.pl = geom.planes;
    this.W1 = this.pl[1].W;
  }

  frontMap(d) {
    const W = this.pl[d].W, T = this.pl[d].T;
    return (x, y) => [(x - this.C) / W, (y - T) / W];
  }

  sideMap(e) {
    const d = e.d;
    const a = this.pl[d], b = this.pl[d + 1];
    const edge = (e.polygon[0][0] - this.C) / a.W;      // lateral position u of the edge, in cell widths
    return (x, y) => {
      const W = (x - this.C) / edge;
      const t = (a.W - W) / (a.W - b.W);
      const top = a.T + (b.T - a.T) * t;
      return [this.W1 / W, (y - top) / W];
    };
  }

  /** Floor (key 'B') or ceiling (key 'T') between planes d and d+1. */
  flatMap(d, key) {
    const a = this.pl[d], b = this.pl[d + 1];
    return (x, y) => {
      const W = a.W + (b.W - a.W) * (y - a[key]) / (b[key] - a[key]);
      return [(x - this.C) / W, this.W1 / W];
    };
  }

  elementMap(e) {
    const art = e.art;
    if (art === 'front') return this.frontMap(e.d);
    if (art === 'side') return this.sideMap(e);
    if (art === 'floor' || art === 'floorband') return this.flatMap(e.d, 'B');
    if (art === 'ceil' || art === 'ceilband') return this.flatMap(e.d, 'T');
    throw new PerspError(`no perspective for ${art}`);
  }
}

/** Color of the pixel [x0, x0+1) x [y0, y0+1): weighted majority of the n x n subsamples (null = transparent).
 *  bias: Map or object {color: weight}. */
export function shade(mapfn, pattern, x0, y0, n = 4, bias = null) {
  const cnt = new Map();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [u, v] = mapfn(x0 + (i + 0.5) / n, y0 + (j + 0.5) / n);
      const c = pattern(u, v);
      const k = c === undefined ? null : c;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  let best = null, bw = -1;
  const keys = [...cnt.keys()].sort((a, b) => (a === null ? -1 : a) - (b === null ? -1 : b));
  for (const c of keys) {
    let wt = 1;
    if (bias) {
      const bv = bias instanceof Map ? bias.get(c) : c !== null ? bias[c] : undefined;
      if (bv !== undefined) wt = bv;
    }
    const w = cnt.get(c) * wt;
    if (w > bw) { best = c; bw = w; }
  }
  return best;
}

/** fn(px, r) -> color for texdemo paint (px, r relative to the rectangle corner, px in pixels). */
export function elementFn(persp, e, pattern, n = 4, bias = null) {
  const mp = persp.elementMap(e);
  const x0 = 2 * e.rect[0], y0 = e.rect[1];
  return (px, r) => shade(mp, pattern, x0 + px, y0 + r, n, bias);
}

/** Pattern from a flat image (bytes of a PNG/BMP or a decoded {width, height, rgba}): ppc = image pixels per cell,
 *  tiles in u and v. Colors map to the nearest palette color, alpha < `alpha` is transparent. */
export function flatPattern(img, ppc, ox = 0.0, oy = 0.0, alpha = 128) {
  if (img instanceof Uint8Array) img = decodeImage(img);
  const { width: w, height: h, rgba: px } = img;
  const cache = new Map();
  const pal = (r, g, b) => {
    const k = (r << 16) | (g << 8) | b;
    if (!cache.has(k)) {
      let bi = 0, bd = -1;
      for (let i = 0; i < 16; i++) {
        const p = PAL[i];
        const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (bd < 0 || d < bd) { bd = d; bi = i; }
      }
      cache.set(k, bi);
    }
    return cache.get(k);
  };
  const imod = (a, b) => ((a % b) + b) % b;
  return (u, v) => {
    const x = imod(Math.floor((u + ox) * ppc), w), y = imod(Math.floor((v + oy) * ppc), h);
    const o = (y * w + x) * 4;
    return px[o + 3] < alpha ? null : pal(px[o], px[o + 1], px[o + 2]);
  };
}

/** Bricks in stretcher bond in cells (default: 4 bricks per cell, 16 rows per cell height). */
export function brickPattern(bw = 0.25, bh = 0.0625, joint = 0.008, cJoint = 14, cols = [12, 8]) {
  return (u, v) => {
    const row = Math.floor(v / bh);
    const rr = v - row * bh;
    const uu = u + (fmod(row, 2) ? bw / 2 : 0);
    const col = Math.floor(uu / bw);
    const cc = uu - col * bw;
    if (rr < joint || cc < joint) return cJoint;
    return cols[fmod(col + row, 2)];
  };
}
