// Example assets for dbespr (P5b, section 9.1): deterministic, no randomness. Port of tools/dbesprdemo.py.
//
// generate({geomJson, dvg, geomRef}) -> {files: {name: Uint8Array | string}, geom, images}
//   blob.json + blob.png (Aseprite-like export, --split-layers names), blob_m.json (without view angle 3),
//   gem.png + gem.toml (PNG with image list), blob.toml, blob_m.toml; without geomRef also west140.geom.json + .dvg
//   (geomJson/dvg = the default geometry, see core/demo/texdemo.js).
import { encodePng } from '../io/png.js';
import { pyDumps } from '../tex.js';
import { PAL, newImage, putPixel } from './texdemo.js';

export const CW = 48, CH = 64;              // canvas in pixels (Aseprite)
export const SIZES = { 1: [31, 54], 2: [19, 34], 3: [11, 21] };     // figure per depth (pixels)
export const BODY = { 0: PAL[5], 1: PAL[13], 2: PAL[10], 3: PAL[13] };
export const OUTLINE = PAL[0];
export const DURATION = 150;

const sq = (x) => x * x;

/** Body (ellipse) plus head (smaller ellipse) of a figure of size w x h. */
function inside(x, y, w, h, bob) {
  y -= bob;
  if (y < 0) return false;
  const cx = (w - 1) / 2;
  const body = sq((x - cx) / (w / 2)) + sq((y - 0.64 * h) / (0.36 * h)) <= 1;
  const head = sq((x - cx) / (0.28 * w)) + sq((y - 0.2 * h) / (0.2 * h)) <= 1;
  return body || head;
}

/** RGBA canvas CW x CH of view ai at depth d, phase frame. */
export function figure(ai, d, frame) {
  if (ai === 0 && d === 3 && frame === 1) return newImage(CW, CH);
  const [w, h] = SIZES[d];
  const bob = frame === 0 ? 0 : -1;
  const im = newImage(CW, CH);
  const ox = Math.floor((CW - w) / 2) + (d === 1 ? 1 : 0);
  const oy = CH - 2 - h + (frame ? bob : 0);
  const ins = new Set();
  const K = (x, y) => `${x},${y}`;
  for (let y = 0; y < h + 1; y++) for (let x = 0; x < w; x++) if (inside(x, y, w, h, 0) && y < h) ins.add(K(x, y));
  for (const k of ins) {
    const [x, y] = k.split(',').map(Number);
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !ins.has(K(x + dx, y + dy)));
    let col = edge ? OUTLINE : BODY[ai];
    if (!edge && ai === 2 && Math.floor(y / 3) % 2) col = PAL[11];
    putPixel(im, ox + x, oy + y, col);
  }
  const ey = Math.trunc(0.2 * h);
  let holes = [];
  const w2 = Math.floor(w / 2), w6 = Math.floor(w / 6);
  if (ai === 0) holes = [[w2 - Math.max(2, w6), ey], [w2 + Math.max(1, w6), ey]];
  else if (ai === 1) holes = [[w2 + Math.max(2, w6), ey]];
  else if (ai === 3) holes = [[w2 - Math.max(2, w6), ey]];
  for (const [hx, hy] of holes) {
    for (let dy = 0; dy < (frame ? 1 : 2); dy++) {
      for (let dx = 0; dx < (d === 1 ? 2 : 1); dx++) {
        if (ins.has(K(hx + dx, hy + dy))) putPixel(im, ox + hx + dx, oy + hy + dy, [0, 0, 0, 0]);
      }
    }
  }
  return im;
}

/** Bounding box [x0, y0, x1, y1] (exclusive) of the pixels with alpha != 0, or null (getbbox of the alpha channel). */
export function alphaBbox(im) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      if (im.rgba[(y * im.width + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/** Image.paste without mask: replaces the pixels (incl. alpha). */
function paste(dst, src, x, y) {
  for (let r = 0; r < src.height; r++) {
    if (y + r < 0 || y + r >= dst.height) continue;
    for (let c = 0; c < src.width; c++) {
      if (x + c < 0 || x + c >= dst.width) continue;
      dst.rgba.set(src.rgba.subarray((r * src.width + c) * 4, (r * src.width + c) * 4 + 4), ((y + r) * dst.width + x + c) * 4);
    }
  }
}

/** -> {sheet, blob: json text, blobM: json text}. */
export function makeBlob() {
  const layers = [];
  for (let ai = 0; ai < 4; ai++) for (const d of [1, 2, 3]) layers.push(`v${ai}_d${d}`);
  layers.push('ref');
  const cols = 6;
  const cells = [];
  const slices = new Map();
  for (const ln of layers) {
    for (let f = 0; f < 2; f++) {
      let im;
      if (ln === 'ref') {
        im = newImage(CW, CH);
        for (let i = 0; i < CW; i += 8) putPixel(im, i, CH - 1, PAL[1]);
      } else {
        const ai = +ln[1], d = +ln[4];
        im = figure(ai, d, f);
        const bb = alphaBbox(im);
        if (bb && d !== 2) {
          const [x0, y0, x1, y1] = bb;
          const w = x1 - x0, h = y1 - y0;
          const key = { frame: f, bounds: { x: x0, y: y0, w, h } };
          if (d === 1) key.pivot = { x: Math.floor(w / 2) - 1, y: h - 2 };
          if (!slices.has(ln)) slices.set(ln, []);
          slices.get(ln).push(key);
        }
      }
      cells.push([ln, f, im]);
    }
  }
  const rows = Math.floor((cells.length + cols - 1) / cols);
  const sheet = newImage(cols * CW, rows * CH);
  const frames = [];
  cells.forEach(([ln, f, im], i) => {
    const x = (i % cols) * CW, y = Math.floor(i / cols) * CH;
    paste(sheet, im, x, y);
    frames.push({
      filename: `${ln}#${f}`, frame: { x, y, w: CW, h: CH }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CW, h: CH }, sourceSize: { w: CW, h: CH }, duration: DURATION,
    });
  });
  const meta = {
    app: 'dbesprdemo', version: '1', image: 'blob.png', format: 'RGBA8888', size: { w: sheet.width, h: sheet.height }, scale: '1',
    frameTags: [{ name: 'idle', from: 0, to: 0, direction: 'forward' }, { name: 'walk', from: 0, to: 1, direction: 'pingpong' }],
    layers: layers.map((n) => ({ name: n })),
    slices: [...slices].map(([n, k]) => ({ name: n, color: '#0000ffff', keys: k })),
  };
  const blob = pyDumps({ frames, meta }, { indent: 1 });
  const fm = frames.filter((e) => !e.filename.startsWith('v3_'));
  const mm = { ...meta, slices: meta.slices.filter((s) => !s.name.startsWith('v3_')), layers: meta.layers.filter((l) => !l.name.startsWith('v3_')) };
  return { sheet, blob, blobM: pyDumps({ frames: fm, meta: mm }, { indent: 1 }) };
}

/** -> {image, entries: [[phase, d, box]]}. */
export function makeGem() {
  const im = newImage(64, 32);
  const spec = { 1: [12, 10], 2: [8, 7], 3: [5, 5] };
  const entries = [];
  for (let phase = 0; phase < 2; phase++) {
    let x = 1 + phase * 30;
    for (const d of [1, 2, 3]) {
      const [w, h] = spec[d];
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const cx = (w - 1) / 2, cy = (h - 1) / 2;
          const t = Math.abs(xx - cx) / (w / 2) + Math.abs(yy - cy) / (h / 2);
          if (t <= 1) putPixel(im, x + xx, 1 + yy, t > 0.7 ? PAL[3] : PAL[14]);
        }
      }
      if (phase === 1) {
        putPixel(im, x + 1, 1 + 1, PAL[15]);
        putPixel(im, x + Math.floor(w / 2), 1 + Math.floor(h / 2), PAL[15]);
      }
      entries.push([phase, d, [x, 1, w, h]]);
      x += w + 2;
    }
  }
  return { image: im, entries };
}

export const BLOB_TOML = `format  = "dbespr"
version = 1

[sprite]
name      = "{name}"
geom      = "{geom}"
{dvg}out       = "build"
load      = 0x6000
vrl_load  = 0x4000
angles    = 4
phases    = 2
max_cores = 4
core_min  = 16
{extra}
[source]
aseprite = "{src}"
`;

export const GEM_TOML = `format  = "dbespr"
version = 1

[sprite]
name      = "gem"
geom      = "{geom}"
{dvg}out       = "build"
angles    = 1
phases    = 2
max_cores = 2
core_min  = 8

[source]
png = "gem.png"
`;

const fmt = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k]);

export function generate({ geomJson, dvg = null, geomRef = null } = {}) {
  if (!geomJson) throw new Error('sprdemo.generate: geomJson (dbegeom geom.json of the geometry) missing');
  const geom = geomJson instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(geomJson)) : geomJson;
  const files = {};
  let gref, dv;
  if (geomRef) { gref = geomRef; dv = ''; } else {
    files['west140.geom.json'] = geomJson instanceof Uint8Array ? geomJson : JSON.stringify(geomJson);
    if (dvg) files['west140.dvg'] = dvg;
    gref = 'west140.geom.json'; dv = 'dvg       = "west140.dvg"\n';
  }
  const b = makeBlob();
  files['blob.png'] = encodePng(b.sheet);
  files['blob.json'] = b.blob;
  files['blob_m.json'] = b.blobM;
  const g = makeGem();
  files['gem.png'] = encodePng(g.image);
  let gem = fmt(GEM_TOML, { geom: gref, dvg: dv });
  for (const [phase, d, box] of g.entries) {
    const foot = d !== 2 ? `foot  = [${Math.floor(box[2] / 2)}, ${box[3] - 1}]\n` : '';
    gem += `\n[[image]]\nbox   = [${box.join(', ')}]\n${foot}phase = ${phase}\nangle = 0\ndepth = ${d}\n`;
  }
  files['gem.toml'] = gem;
  files['blob.toml'] = fmt(BLOB_TOML, { name: 'blob', geom: gref, dvg: dv, extra: '', src: 'blob.json' });
  files['blob_m.toml'] = fmt(BLOB_TOML, { name: 'blob_m', geom: gref, dvg: dv, extra: 'mirror    = { 3 = 1 }\n', src: 'blob_m.json' });
  return { files, geom, images: { 'blob.png': b.sheet, 'gem.png': g.image } };
}
