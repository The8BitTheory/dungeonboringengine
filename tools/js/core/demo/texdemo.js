// Deterministic example textures for dbetex (docs/specs/P5-textures.md, section 10.1). Port of tools/dbetexdemo.py.
//
// generate({geomJson, dvg, geomRef}) -> {files: {name: Uint8Array | string}, geom}
//   brick_atlas.png, grating_atlas.png, window.json/.png, stone_atlas.png, wood_atlas.png, sky.png,
//   walls.toml floor.toml ceil.toml bg.toml, and (without geomRef) west140.geom.json + west140.dvg.
// The geometry comes from the caller: geomJson = bytes (or object) of a dbegeom geom.json. Without geomRef the
// default geometry is meant (Westwood 140 x 96, dbetexdemo.default_geom(); the same bytes as
// docs/specs/examples/tex/west140.geom.json + .dvg) and is written as west140.geom.json/.dvg; with geomRef
// (path of the geometry relative to the output directory, Python --geom) no geometry files are written.
import { encodePng } from '../io/png.js';
import { PALETTE, pyDumps, pyRound } from '../tex.js';
import { Persp, elementFn, brickPattern } from '../persp.js';

export const PAL = PALETTE;

/** RGBA image {width, height, rgba} filled with one color (Image.new("RGBA", size, color)). */
export function newImage(w, h, color = [0, 0, 0, 0]) {
  const rgba = new Uint8Array(w * h * 4);
  if (color.some((c) => c)) for (let i = 0; i < w * h; i++) rgba.set(color, i * 4);
  return { width: w, height: h, rgba };
}

export function putPixel(im, x, y, c) {
  if (x < 0 || y < 0 || x >= im.width || y >= im.height) throw new RangeError('image index out of range');
  im.rgba.set(c.length === 3 ? [...c, 255] : c, (y * im.width + x) * 4);
}

/** [name, d, rect, mask, atlas] of the images with an atlas slot. */
export function boxes(geom, arts) {
  const res = [];
  for (const e of geom.elements) if (arts.includes(e.art) && e.atlas && e.atlas.length) res.push([e.name, e.d, e.rect, e.mask, e.atlas]);
  for (const b of geom.band_images) {
    if (arts.includes(b.art)) {
      const w = b.rect[2], h = b.rect[3];
      res.push([b.name, b.d, b.rect, new Array(h).fill('#'.repeat(w)), b.atlas]);
    }
  }
  return res;
}

/** Element or band objects (with art, name, d, rect, mask, atlas) of the images with an atlas slot. */
export function boxesE(geom, arts) {
  const res = [];
  for (const e of geom.elements) if (arts.includes(e.art) && e.atlas && e.atlas.length) res.push(e);
  for (const b of geom.band_images) {
    if (arts.includes(b.art)) res.push({ ...b, mask: new Array(b.rect[3]).fill('#'.repeat(b.rect[2])) });
  }
  return res;
}

/** fn(px, r) -> palette index | null for each pixel of the mask; the rest stays transparent. */
export function paint(im, ox, oy, rect, mask, fn) {
  mask.forEach((line, r) => {
    for (let bx = 0; bx < line.length; bx++) {
      const ch = line[bx];
      for (const side of [0, 1]) {
        if (ch === '#' || (ch === 'L' && side === 0) || (ch === 'R' && side === 1)) {
          const c = fn(2 * bx + side, r);
          if (c !== null && c !== undefined) putPixel(im, ox + 2 * bx + side, oy + r, PAL[c]);
        }
      }
    }
  });
}

export const BRICK = brickPattern();
export const JOINT = new Map([[14, 3]]);           // joints stay visible even below one pixel width

const wallFn = (P, e, pattern = BRICK, bias = JOINT) => elementFn(P, e, pattern, 4, bias);

/** Wall, opaque: bricks in wall space (fronts and sides, perspective). */
export function makeBrick(geom) {
  const P = new Persp(geom);
  const im = newImage(...geom.atlas_size);
  for (const e of boxesE(geom, ['front', 'side'])) paint(im, e.atlas[0], e.atlas[1], e.rect, e.mask, wallFn(P, e));
  return im;
}

/** Wall, non-opaque: full fronts as grid, sides like bricks (perspective). */
export function makeGrating(geom) {
  const P = new Persp(geom);
  const im = newImage(...geom.atlas_size);
  const W1 = geom.planes[1].W;
  for (const e of boxesE(geom, ['front', 'side'])) {
    let fn;
    if (e.art === 'front') {
      const Wd = geom.planes[e.d].W, h = e.rect[3];
      const per = Math.max(2, pyRound(Wd / 12));          // bar spacing in bytes
      const rail = Math.max(1, pyRound(2 * Wd / W1));
      const q = Math.floor(h / 4), q3 = Math.floor(3 * h / 4);
      fn = (px, r) => {
        if ((q <= r && r < q + rail) || (q3 <= r && r < q3 + rail)) return 15;
        if ((px >> 1) % per === Math.floor(per / 2)) return 7;
        return null;
      };
    } else fn = wallFn(P, e);
    paint(im, e.atlas[0], e.atlas[1], e.rect, e.mask, fn);
  }
  return im;
}

function frontWindow(w2, h, arch, baseFn) {
  return (px, r) => {
    const base = baseFn(px, r);
    let hole;
    if (arch) {
      const cx = w2 / 2, rad = w2 * 0.18;
      const cy = h * 0.4, bot = h * 0.8;
      const x = px + 0.5 - cx;
      const dy = (r + 0.5 - cy) * 1.0;
      hole = (Math.abs(x) <= rad && cy <= r && r < bot) || (r < cy && x * x + dy * dy <= rad * rad);
    } else {
      const p0 = Math.trunc(w2 * 0.35) | 1, p1 = Math.trunc(w2 * 0.65) | 1;
      hole = p0 <= px && px < p1 && Math.floor(h / 4) <= r && r < Math.floor(h * 6 / 10);
    }
    return hole ? null : base;
  };
}

/** -> {sheet: image, json: string} (Aseprite-style export window.json/window.png). */
export function makeWindow(geom, pngName = 'window.png') {
  const fronts = boxes(geom, ['front']).filter((b) => b[0].endsWith('_s+0'));
  const pos = new Map();
  let x = 4;
  const row2 = 4 + Math.max(...fronts.slice(0, 2).map((f) => f[2][3])) + 4;
  fronts.forEach((f, i) => {
    const w2 = f[2][2] * 2;
    if (i < 2) { pos.set(f[0], [x, 4]); x += w2 + 4; } else pos.set(f[0], [4, row2]);       // shifted slice
  });
  const SW = Math.max(x, 4 + fronts[2][2][2] * 2 + 4);
  const SH = row2 + fronts[2][2][3] + 4;
  const sheet = newImage(2 * SW, SH);
  const P = new Persp(geom);
  const emap = new Map(geom.elements.map((e) => [e.name, e]));
  [false, true].forEach((arch, fi) => {
    for (const [name, , rect, mask] of fronts) {
      const [ax, ay] = pos.get(name);
      const base = wallFn(P, emap.get(name));
      paint(sheet, fi * SW + ax, ay, rect, mask, frontWindow(rect[2] * 2, rect[3], arch, base));
    }
  });
  const js = {
    frames: [0, 1].map((i) => ({
      filename: `window ${i}`, frame: { x: i * SW, y: 0, w: SW, h: SH }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: SW, h: SH }, sourceSize: { w: SW, h: SH }, duration: 100,
    })),
    meta: {
      app: 'dbetexdemo', version: '1', image: pngName, format: 'RGBA8888', size: { w: 2 * SW, h: SH }, scale: '1',
      frameTags: [{ name: 'window', from: 0, to: 0, direction: 'forward' }, { name: 'arch', from: 1, to: 1, direction: 'forward' }],
      slices: fronts.map(([n, , r]) => ({
        name: n, color: '#0000ffff', keys: [{ frame: 0, bounds: { x: pos.get(n)[0], y: pos.get(n)[1], w: r[2] * 2, h: r[3] } }],
      })),
    },
  };
  return { sheet, json: pyDumps(js, { indent: 1 }) };
}

const frac = (x) => x - Math.floor(x);
const pmod2 = (k) => ((k % 2) + 2) % 2;

/** Paving in floor space: squares of 1/4 cell, checkerboard 14/7, joint 1. */
export function stone(u, v, t = 0.25, j = 0.012) {
  const cu = u / t, cv = v / t;
  const fu = frac(cu), fv = frac(cv);
  if (fu < j / t || fv < j / t) return 1;
  return pmod2(Math.floor(cu) + Math.floor(cv)) === 0 ? 14 : 7;
}

/** Planks in ceiling space: boards of 1/6 cell (colors 8/12 alternating), butt joint every 1/2 cell. */
export function wood(u, v, pw = 1 / 6, pl = 0.5, j = 0.012) {
  const cu = u / pw;
  const k = Math.floor(cu);
  if (cu - k < j / pw) return 6;
  const vv = v / pl + (pmod2(k) ? 0.5 : 0);
  if (vv - Math.floor(vv) < j / pl) return 6;
  return pmod2(k + Math.floor(vv)) === 0 ? 8 : 12;
}

function flatAtlas(geom, arts, tile, bandfn) {
  const P = new Persp(geom);
  const im = newImage(...geom.atlas_size);
  for (const e of boxesE(geom, arts)) {
    const fn = e.art.endsWith('band') ? bandfn(e, P) : elementFn(P, e, tile, 4, new Map([[1, 3], [6, 3]]));
    paint(im, e.atlas[0], e.atlas[1], e.rect, e.mask, fn);
  }
  return im;
}

/** Floor: tiles as paving in floor space; bands as single-color rows (gradient dark gray -> black, ROWS). */
export function makeStone(geom) {
  return flatAtlas(geom, ['floor', 'floorband'], stone, (e) => { const h = e.rect[3]; return (px, r) => (2 * r < h ? 1 : 0); });
}

/** Ceiling: tiles and bands as planks in ceiling space (bands without ROWS). */
export function makeWood(geom) {
  return flatAtlas(geom, ['ceil', 'ceilband'], wood, (e, P) => elementFn(P, e, wood, 4, new Map([[6, 3]])));
}

export function makeSky(geom) {
  const vw = geom.viewport.width_px >> 1;
  const [hy0, hy1] = geom.horizon;
  const P = 4 * vw, h = hy1 - hy0 + 6;
  const im = newImage(2 * P, h, [0, 0, 0, 255]);
  const half = Math.floor(P / 2);
  for (let x = 0; x < 2 * P; x++) {
    const q = Math.floor(x / half);
    const n = q + 1;                                 // number of mountains in the quarter
    const local = (x % half) / half;
    const phase = (local * n) % 1.0;
    const peak = 1 - Math.abs(2 * phase - 1);        // peak 0 ... 1
    const top = Math.trunc(h * 0.7 - peak * h * 0.45);
    for (let y = 0; y < h; y++) putPixel(im, x, y, PAL[y >= top ? 1 : 3]);
  }
  for (let q = 0; q < 4; q++) {                      // feature per quarter: sun in alternating color
    const x0 = Math.floor(q * P / 2) * 1 + 8;
    for (let yy = 2; yy < 5; yy++) for (let xx = x0; xx < x0 + 6; xx++) putPixel(im, xx, yy, PAL[[10, 7, 9, 13][q]]);
  }
  return im;
}

export const WALLS_TOML = `format  = "dbetex"
version = 1

[texset]
name       = "demo_walls"
kind       = "wall"
geom       = "{geom}"
dvg        = "{dvg}"
out        = "build"
load       = 0x8000
vrl_load   = 0x4000
pool_bytes = 26624

[[style]]
name = "brick"
png  = "brick_atlas.png"

[[style]]
name = "grating"
png  = "grating_atlas.png"

[[style]]
name     = "window"
aseprite = "window.json"
tag      = "window"

[[style]]
name     = "arch"
aseprite = "window.json"
tag      = "arch"
`;

export const FLOOR_TOML = `format  = "dbetex"
version = 1

[texset]
name = "demo_floor"
kind = "floor"
geom = "{geom}"
out  = "build"
load = 0xEE00

[[style]]
name = "stone"
png  = "stone_atlas.png"
`;

export const CEIL_TOML = FLOOR_TOML.replaceAll('demo_floor', 'demo_ceil').replaceAll('"floor"', '"ceiling"')
  .replaceAll('stone_atlas', 'wood_atlas').replaceAll('"stone"', '"wood"').replaceAll('0xEE00', '0xF600');

export const BG_TOML = `format  = "dbebg"
version = 1

[background]
name    = "demo_sky"
geom    = "{geom}"
png     = "sky.png"
y0      = "horizon"
offsets = "auto"
wrap    = true
above   = 3
below   = 1
out     = "build"
load    = 0xFB80
`;

const fmt = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k]);
const parseGeom = (g) => (g instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(g)) : g);

/** All example files (see the header); PNG files encoded with encodePng (compare them by decoded pixels). */
export function generate({ geomJson, dvg = null, geomRef = null } = {}) {
  if (!geomJson) throw new Error('texdemo.generate: geomJson (dbegeom geom.json of the geometry) missing');
  const geom = parseGeom(geomJson);
  const files = {};
  let gref, dref;
  if (geomRef) { gref = geomRef; dref = ''; } else {
    files['west140.geom.json'] = geomJson instanceof Uint8Array ? geomJson : JSON.stringify(geomJson);
    if (dvg) files['west140.dvg'] = dvg;
    gref = 'west140.geom.json'; dref = 'west140.dvg';
  }
  const images = {
    'brick_atlas.png': makeBrick(geom), 'grating_atlas.png': makeGrating(geom),
    'stone_atlas.png': makeStone(geom), 'wood_atlas.png': makeWood(geom), 'sky.png': makeSky(geom),
  };
  const win = makeWindow(geom, 'window.png');
  files['brick_atlas.png'] = encodePng(images['brick_atlas.png']);
  files['grating_atlas.png'] = encodePng(images['grating_atlas.png']);
  files['window.png'] = encodePng(win.sheet);
  files['window.json'] = win.json;
  files['stone_atlas.png'] = encodePng(images['stone_atlas.png']);
  files['wood_atlas.png'] = encodePng(images['wood_atlas.png']);
  files['sky.png'] = encodePng(images['sky.png']);
  let wt = fmt(WALLS_TOML, { geom: gref, dvg: dref });
  if (!dref) wt = wt.split('\n').filter((l) => !l.startsWith('dvg')).join('\n');
  files['walls.toml'] = wt;
  files['floor.toml'] = fmt(FLOOR_TOML, { geom: gref });
  files['ceil.toml'] = fmt(CEIL_TOML, { geom: gref });
  files['bg.toml'] = fmt(BG_TOML, { geom: gref });
  images['window.png'] = win.sheet;
  return { files, geom, images };
}
