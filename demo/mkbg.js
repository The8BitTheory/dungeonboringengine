#!/usr/bin/env node
// Wallpaper of the demo: panorama "landscape" from tree1-3.bmp and water1-4.bmp (Crawl graphics, see demo/README.md).
// Port of demo/mkbg.py (same pixels; the PNG bytes come from the JS encoder).
//
// Usage: node demo/mkbg.js OUT.png [--geom GEOM.json] [--rows N]
//   The panorama is 2 * P pixels wide (P = 2 * VW bytes, as in test/vice_view.py) and N rows high (default 36); it sits
//   at y0 = 14 in the viewport (bg.toml); the horizon (window row 34 = middle of the horizon band 22 .. 44) is
//   panorama row 20.
//   Sky above the panorama comes from `above` (color 3), below the panorama from `below` (0, abyss): bg.toml.
// The panorama is drawn cyclically (wrap): trees and water are painted modulo width, the seam is invisible.
// Colors only from the VDC palette (geom.js PALETTE); transparency of the source images (255, 85, 255) is not carried over.
// API: build(rows, vw, art) -> {width, height, rgb}; main(argv, io) -> exit code.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE } from '../tools/js/core/geom.js';
import { decodeImage } from '../tools/js/core/io/image.js';
import { encodePng } from '../tools/js/core/io/png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ART = join(HERE, 'art');
export const KEY = [255, 85, 255];
export const SKY = 3, HILL = 1, GRASS = 4, DGRASS = 5, WATER = 6;
const PAL = PALETTE;

/** RGB image {width, height, rgb} filled with color c. */
export function newRgb(w, h, c) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set(c, i * 3);
  return { width: w, height: h, rgb };
}

/** Image file -> RGB image (Pillow Image.open(...).convert('RGB')). */
export function loadRgb(path) {
  const im = decodeImage(new Uint8Array(readFileSync(path)), path);
  const rgb = new Uint8Array(im.width * im.height * 3);
  for (let i = 0; i < im.width * im.height; i++) rgb.set(im.rgba.subarray(i * 4, i * 4 + 3), i * 3);
  return { width: im.width, height: im.height, rgb };
}

const put = (im, x, y, c) => { im.rgb.set(c, (y * im.width + x) * 3); };
const get = (im, x, y) => im.rgb.subarray((y * im.width + x) * 3, (y * im.width + x) * 3 + 3);
const pmod = (a, b) => ((a % b) + b) % b;

/** Paint source image at (x0, y0) (top left), transparency = KEY; x cyclic. */
export function paint(im, x0, y0, name, art = ART, onlyBelow = null) {
  const sp = loadRgb(join(art, name));
  const W = im.width, H = im.height;
  for (let y = 0; y < sp.height; y++) {
    for (let x = 0; x < sp.width; x++) {
      const c = get(sp, x, y);
      if ((c[0] === KEY[0] && c[1] === KEY[1] && c[2] === KEY[2]) || !(y0 + y >= 0 && y0 + y < H)) continue;
      if (onlyBelow !== null && y0 + y < onlyBelow) continue;
      put(im, pmod(x0 + x, W), y0 + y, c);
    }
  }
}

export function build(rows = 36, vw = 70, art = ART) {
  const P = 2 * vw;
  const W = 2 * P, H = rows;
  const HZ = 20;                                     // horizon: panorama row
  const im = newRgb(W, H, PAL[SKY]);
  // Hills (dark gray) behind everything: triangles with apex (x, row) and slopes 3 : 4, foot on row HZ + 4
  const peaks = [[30, 10], [90, 6], [150, 12], [215, 7], [262, 11]];
  for (let x = 0; x < W; x++) {
    const tops = peaks.map(([q, py]) => py + Math.floor(Math.abs(x - q) * 3 / 4));
    for (let y = Math.min(...tops, HZ + 4); y < HZ + 4; y++) put(im, x, y, PAL[HILL]);
  }
  // Ground: dark green from horizon + 4, grass dots
  for (let y = HZ + 4; y < H; y++) for (let x = 0; x < W; x++) put(im, x, y, PAL[(x * 7 + y * 13) % 11 ? GRASS : DGRASS]);
  // Lake: sector 150 .. 250, water (cyan) with water tiles as wave edge
  for (let y = HZ + 4; y < H; y++) for (let x = 150; x < 250; x++) put(im, x, y, PAL[6]);
  for (let x0 = 150; x0 < 250; x0 += 16) paint(im, x0, HZ + 4, 'water4.bmp', art);
  for (const [x0, y0] of [[158, HZ + 11], [200, HZ + 9], [232, HZ + 12]]) paint(im, x0, y0, 'water2.bmp', art);
  // Trees (foot on row 31 or 33)
  for (const [x0, y0, n] of [[6, -1, 'tree1.bmp'], [50, 1, 'tree2.bmp'], [92, -1, 'tree3.bmp'], [122, 2, 'tree1.bmp'],
    [262 - 12, 0, 'tree2.bmp'], [268, 1, 'tree3.bmp']]) paint(im, x0, y0, n, art);
  return im;
}

/** Writes the panorama; vw from the geometry JSON (viewport.width_px // 2) or 70. Returns the image. */
export function writeBg(out, { geom = null, rows = 36 } = {}) {
  let vw = 70;
  if (geom) vw = JSON.parse(readFileSync(geom, 'utf8')).viewport.width_px >> 1;
  const im = build(rows, vw);
  mkdirSync(dirname(presolve(out)), { recursive: true });
  writeFileSync(out, encodePng(im));
  return im;
}

export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let out = null, geom = null, rows = 36;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--geom') geom = argv[++i];
    else if (a === '--rows') {
      rows = parseInt(argv[++i], 10);
      if (!Number.isInteger(rows)) { io.err(`mkbg.js: argument --rows: invalid int value: '${argv[i]}'`); return 2; }
    } else if (out === null && !a.startsWith('--')) out = a;
    else { io.err(`mkbg.js: unrecognized arguments: ${a}`); return 2; }
  }
  if (out === null) { io.err('mkbg.js: the following arguments are required: out'); return 2; }
  const im = writeBg(out, { geom, rows });
  io.out(`${out}: ${im.width} x ${im.height} pixels, P = ${Math.floor(im.width / 4) * 2} bytes`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
