#!/usr/bin/env node
// VICE scenes P6g (docs/specs/P6-engine.md 9.4): engine and VDC-BASIC v3 in the real x128, event-driven.
// Port of test/vice_view.py onto tools/js/core and test/lib/vice.js.
//
// Usage: node test/vice_view.js [--port N] [--timeout S] [--only i|c] [--check] [--png DIR] [--control] [--no-sim]
//                               [--no-fast] [--byte-edges] [--fix]
//   --check   reference only: build scenes, check memory map, view/runVcl against paintReference (no VICE)
//   --png DIR write images of the expected windows (montage)
//   --control control run: model of scene 5 corrupted, the run must report exactly one deviation (exit code 0)
//   --no-sim  without sim65 cross-measurement of the cycles (column sim65)
//   --no-fast without the second run at 2 MHz (FAST, VIC display off during VIEW and VCL); otherwise two VICE runs per mode,
//             cycles of both clocks in the table (columns "2M", stopwatch in clocks at 1 MHz, i.e. in µs)
//   --byte-edges  demo geometry with the view.toml switch byte_edges (edges on whole bytes) instead of pixel-exact
//   --fix     P6j: fixed list address (BUFSET X = 1, VCL type 10 at B0, needs VDC-BASIC v3 with P2e); the program
//             calls ::VCL with the constant B0 instead of P0, the model computes with bufFix
//
// Flow (test/vice/view.bas, interpreted and as a Blitz! compilation with runtime image 2):
//   BOOT (VDC-BASIC v3) -> POKE 57,0:POKE 58,64:CLR -> load stub and lib, INIT -> chunky mode as in Crawl (VDC registers per
//   crawl.bas 10059-10135, 64 KB VRAM cleared beforehand) -> DVG, DMP, DTS (3), DBG, S2 (4 sets) at the addresses of the memory
//   map (P6 2.4) in bank 1, VRL of the textures/wallpaper/sprites via RXV into the VRAM pool -> POOLSET, GEOMSET, TEXSET, BGSET,
//   SPRITESET, ITEMSET, MAPINIT -> per step of the scene table (bank 0 $8000, SETPOS or MOVE, object list): VIEW, ::VCL.
// Markers (RTS in bank 0): $0C4C (before VIEW), $0C4D (after ::VCL, scene done), $0C4E (end of table).
// The harness stops at the markers, reads the whole VRAM there (`bank vdc`, bsave), the buffer and the results
// and compares pixel-exactly with the VRAM model (runVcl on the 64 KB model, plus paintReference in the window).
// Cycles: monitor stopwatch from $0C4C; breakpoints at stub entry/exit (VIEW) and at start/end of VCL in VDC-BASIC
// (`vcl` from vdcbasic3.sym, `.vcl_done` from the ACME report, vdcLabels).
// Event-driven: breakpoints, debug cartridge ($D7FF); -limitcycles and the timeout are only guards.
// Port rule (review-notes A): --port, else DBE_VICE_PORT, else 6631, range 6631-6649, bind test, only the own process.
// Requirement: VDC-BASIC v3 (VDCBASIC_DIR, default ~/git/vdc-basic, branch v3; nothing is changed there);
// Blitz! run additionally needs node and blitzc (otherwise message SKIP).
//
// Exported for other harnesses (test/vice_demo.js): stubRts, vdcLabels, stopwatch, flags (re-exported from lib/vice.js),
// World, buildAssets, buildMap, buildSteps, modelRun, compare, report.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../tools/js/core/view.js';
import * as M from '../tools/js/core/map.js';
import * as tex from '../tools/js/core/tex.js';
import * as spr from '../tools/js/core/spr.js';
import * as vrl from '../tools/js/core/vrl.js';
import { move as dbemove } from '../tools/js/core/move.js';
import { PAL, newImage, putPixel } from '../tools/js/core/demo/texdemo.js';
import { encodePng } from '../tools/js/core/io/png.js';
import { demoAssets } from './lib/assets.js';
import * as vs from './lib/vice.js';

export { stubRts, vdcLabels, stopwatch, flags } from './lib/vice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = vs.ROOT;

// ------------------------------------------------------------------ memory map (P6 2.4) and VRAM
// Default P6 2.4 (MEMSIZ $4000, P6h): DMP $4000, S2 $6000, wall DTS $8000 (12 KB), lib $B000-$DBFF, DVG $E800, floor $EE00,
// ceiling $F600, DBG $FB80. The improved Blitz! runtime (image 2) makes the upper 1 KB ($FC00-$FFFF) shared and occupies
// $FC00-$FEFF; data there destroys it on BLOAD. The small test assets are packed densely here in $E800-$FBFF (5 KB).
export const HIGH = [0xE800, 0xFC00];
export const LOW = { dmp: [0x4000, 0x6000], dts0: [0x8000, 0xB000] };      // range (from, to exclusive)
export const S2_START = 0x6000, S2_END = 0x8000;
export const POOL = [9600, 46335];          // VRAM pool: after the attribute RAM (AP 0, 2 x 9600) up to the screen RAM
export const SCN_ADDR = 0x8000;             // scene table, bank 0
export const VRL_ADDR = 0x9000;             // load buffer of the VRL files, bank 0 (RXV source from +5)
export const BUF = [0x1300, 0x1C00];
export const M_VIEW = 0x0C4C, M_DONE = 0x0C4D, M_END = 0x0C4E;
const VERSION = vs.VERSION;
const LIBNAME = `dbe${VERSION}.lib`, STUBNAME = `dbe${VERSION}.stub`;
const OUT = vs.OUT;

const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
const range = (n) => Array.from({ length: n }, (_, i) => i);
const bytesEq = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
const w16 = (b, i) => b[i] | (b[i + 1] << 8);
const die = (msg) => { console.error(msg); process.exit(1); };
const rowsEq = (a, b) => a.length === b.length && a.every((r, i) => bytesEq(r, b[i]));
const pyHex = (v) => '0x' + v.toString(16);
const pyBases = (b) => `{'dts': [${b.dts.join(', ')}], 'dbg': ${b.dbg}, 's2': [${b.s2.join(', ')}]}`;

// ------------------------------------------------------------------ small assets
/** Panorama P = 2 * VW bytes (instead of 4 * VW in the demo): half as much VRAM. */
function makeSky(geom) {
  const vw = geom.viewport.width_px >> 1;
  const [hy0, hy1] = geom.horizon;
  const P = 2 * vw, h = hy1 - hy0 + 6;
  const im = newImage(2 * P, h, [0, 0, 0, 255]);
  const half = Math.floor(P / 2);
  for (let x = 0; x < 2 * P; x++) {
    const q = Math.floor(x / half);
    const n = q + 1;
    const local = (x % half) / half;
    const peak = 1 - Math.abs(2 * ((local * n) % 1.0) - 1);
    const top = Math.trunc(h * 0.7 - peak * h * 0.45);
    for (let y = 0; y < h; y++) putPixel(im, x, y, [...PAL[y >= top ? 1 : 3], 255]);
  }
  for (let q = 0; q < 4; q++) {
    const x0 = Math.floor(q * P / 2) + 8;
    for (let yy = 2; yy < 5; yy++) for (let xx = x0; xx < x0 + 6; xx++) putPixel(im, xx, yy, [...PAL[[10, 7, 9, 13][q]], 255]);
  }
  return im;
}

/** Small sets that fit into the ranges of P6 2.4 and into the VRAM pool: wall 3 styles (brick, grating, window;
 *  demo: 4), floor 1 style, ceiling 1 style, wallpaper with half the panorama width, 4 sprite sets (blob, gem, guard, wide). */
export function buildAssets() {
  const A = demoAssets();                            // atlases, geometry and TOMLs as files of the virtual directory A.dir
  const files = { ...A.files };
  const dir = A.dir;
  const P = (n) => tex.pjoin(dir, n);
  const text = (n) => (typeof files[n] === 'string' ? files[n] : new TextDecoder().decode(files[n]));
  const resolve = (p) => {
    const n = p.startsWith(dir + '/') ? p.slice(dir.length + 1) : null;
    const v = n !== null ? files[n] : undefined;
    return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v) : v;
  };
  const geom = JSON.parse(text('west140.geom.json'));
  files['sky2.png'] = encodePng(makeSky(geom));
  files['w3.toml'] = text('walls.toml').replace('[[style]]\nname     = "arch"\naseprite = "window.json"\ntag      = "arch"\n', '');
  const fmt = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k]);
  files['f1.toml'] = fmt(V.GEN_FLOOR_TOML, { name: 'vice_floor', kind: 'floor', load: '0xEE00', styles: '[[style]]\nname = "stone"\npng = "stone_atlas.png"\n' });
  files['c1.toml'] = fmt(V.GEN_FLOOR_TOML, { name: 'vice_ceil', kind: 'ceiling', load: '0xF600', styles: '[[style]]\nname = "wood"\npng = "wood_atlas.png"\n' });
  files['bg2.toml'] = text('bg.toml').replaceAll('sky.png', 'sky2.png');
  const build = (n) => tex.buildTexset(tex.loadTexConf(files[n], { path: P(n) }), resolve).ts;
  const bgr = tex.buildBackground(tex.loadBgConf(files['bg2.toml'], { path: P('bg2.toml') }), resolve);
  return {
    dvg: A.dvg, dvgPrg: A.dvgPrg, sprites: A.sprites, walls: build('w3.toml'), floor: build('f1.toml'), ceil: build('c1.toml'),
    dbgPrg: bgr.dbg, dbgVram: bgr.vram, dbg: tex.fromDbg(bgr.dbg), dir,
  };
}

// ------------------------------------------------------------------ map
const T = (walls, floor, ceil, flags, ch, name = '') => new M.Tile(walls, floor, ceil, flags, ch, name);
const { T_SOLID: SOLID, T_OCCLUDING: OCC, T_CONTENT: CNT } = V;

/** Demo map 15 x 11: corridors, room with sky (wallpaper), grate, window wall, abyss, CONTENT door, item. */
export function buildMap() {
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0, 'corridor'),           // 0
    T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0, 'wall'),                // 1 brick
    T([0, 0, 0, 0], 0, 1, 0, 0, 'abyss'),                         // 2 no floor
    T([0, 0, 0, 0], 1, 0, 0, 0, 'sky'),                           // 3 no ceiling: wallpaper
    T([2, 0, 2, 0], 1, 1, SOLID, 0, 'grating'),                   // 4 grate, not opaque
    T([3, 3, 3, 3], 0, 0, SOLID | OCC, 0, 'window'),              // 5 window wall
    T([2, 2, 2, 2], 1, 1, SOLID | CNT, 0, 'door'),                // 6 CONTENT cell (grate, objects inside)
    T([0, 0, 0, 0], 1, 1, 0, 0, 'item')];                         // 7 corridor with item
  const rows = ['###############',
    '#.....#,,,,,,,#',
    '#.###.#,.....,#',
    '#.#:..#.......#',
    '#.#.#.+.#...#.#',
    '#...#...#.m.#.#',
    '#.#.###.#...#.#',
    '#.#...:.D.....#',
    '#.#.#.#.#...#.#',
    '#.....#.wwww..#',
    '###############'];
  const leg = { '.': 0, '#': 1, ':': 2, ',': 3, '+': 4, w: 5, D: 6, m: 7 };
  const w = rows[0].length, h = rows.length;
  const cells = rows.flatMap((r) => Array.from(r, (c) => leg[c]));
  const content = new Array(w * h).fill(0);
  content[5 * w + 10] = 2;                                          // item 2 at 'm'
  const m = new M.Map('vice', w, h, t, cells, content, [], 1 * w + 1, 2, 1);
  M.validate(m);
  return m;
}

const W = 15;
const cell = (x, y) => y * W + x;

// ------------------------------------------------------------------ steps
class Step {
  constructor(name, kind, { cell: c = 0, dir = 0, action = 0, objs = null, itemph = 0, keep = false } = {}) {
    Object.assign(this, { name, kind, cell: c, dir, action, objs: objs || [], itemph, keep });
  }
}

const Obj = V.Obj;

/** Camera cells must be walkable (no blocked(t)); buildSteps checks this at the end. */
export function buildSteps() {
  const S = [];
  const pos = (n, x, y, d, objs = null, ph = 0) => S.push(new Step(n, 'pos', { cell: cell(x, y), dir: d, objs, itemph: ph }));
  // Walls, floor, ceiling, wallpaper (without objects)
  pos('Corridor south', 1, 1, 2);
  pos('Corridor south, side corridor', 1, 4, 2);
  pos('Wall ahead (east)', 1, 1, 1);
  pos('Corridor west-east', 5, 5, 1);
  pos('Room with sky/wallpaper, east', 8, 2, 1);
  pos('Room with sky/wallpaper, south', 10, 1, 2);
  pos('Room west (wall, wallpaper)', 13, 2, 3);
  pos('Grate west', 7, 4, 3);
  pos('Grate east', 5, 4, 1);
  pos('Grate north', 6, 5, 0);
  pos('Window south d=1', 10, 8, 2);
  pos('Window south d=2', 9, 7, 2);
  pos('Window east', 7, 9, 1);                    // Review P6g: previously (8, 9) = inside the window wall
  // Abyss
  pos('Abyss east', 3, 7, 1);
  pos('Abyss north', 3, 4, 0);                    // Review P6g: previously (4, 5) = inside a wall
  pos('Abyss south', 3, 5, 2);
  pos('Abyss south 2', 5, 5, 2);
  // Item and objects (centered, clipped at the edge)
  pos('Item (content layer)', 9, 5, 1);
  pos('Blob centered d=1', 1, 1, 2, [new Obj(cell(1, 2), 0, 2, 0, 4)]);
  pos('Blob centered d=2 and 3', 1, 1, 2, [new Obj(cell(1, 3), 0, 0, 1, 4), new Obj(cell(1, 4), 0, 1, 1, 4)]);
  pos('Blob subpositions', 1, 5, 2, [...range(4).map((q) => new Obj(cell(1, 6), 0, 2, 0, q)), new Obj(cell(1, 7), 2, 0, 0, 4)]);
  pos('Guard, gem, ITEMPH', 5, 1, 2, [new Obj(cell(5, 3), 2, 2, 0, 4), new Obj(cell(5, 2), 1, 0xFF, 1, 1)], 1);
  pos('wide, left edge d=1', 13, 2, 3, [new Obj(cell(12, 3), 3, 2, 1, 4)]);
  pos('wide, right edge d=1', 13, 2, 3, [new Obj(cell(12, 1), 3, 2, 1, 4)]);
  pos('wide, edge d=2, s=+-1', 13, 2, 3, [new Obj(cell(11, 1), 3, 2, 1, 0), new Obj(cell(11, 3), 3, 2, 1, 3)]);
  pos('Objects in the open room', 13, 2, 3, [new Obj(cell(12, 1), 0, 2, 0, 4), new Obj(cell(12, 3), 0, 2, 0, 1),
    new Obj(cell(11, 2), 2, 0, 0, 4), new Obj(cell(10, 1), 3, 1, 1, 2), new Obj(cell(10, 3), 0, 3, 0, 4)]);
  // CONTENT cell (door with object inside)
  pos('CONTENT door empty', 11, 7, 3);
  pos('CONTENT door with blob d=3', 11, 7, 3, [new Obj(cell(8, 7), 0, 1, 0, 4)]);
  pos('CONTENT door with blob d=2', 10, 7, 3, [new Obj(cell(8, 7), 0, 1, 0, 4)]);
  pos('CONTENT door, blobs d=1', 9, 7, 3, [new Obj(cell(8, 7), 0, 1, 0, 0), new Obj(cell(8, 7), 0, 3, 1, 3)]);
  // MOVE sequence: down the corridor, turn, against the wall, against the object
  S.push(new Step('MOVE Start', 'pos', { cell: cell(1, 1), dir: 2, objs: [new Obj(cell(1, 5), 0, 2, 0, 4)] }));
  for (const [a, n] of [[0, 'forward'], [0, 'forward'], [4, 'turn left'], [5, 'turn right'], [0, 'forward'], [2, 'sideways left'],
    [0, 'forward (object blocks)'], [6, 'turn around'], [0, 'forward'], [3, 'sideways right'], [1, 'back']]) {
    S.push(new Step('MOVE ' + n, 'move', { action: a, keep: true }));
  }
  const m = buildMap();
  for (const st of S) {
    if (st.kind === 'pos' && m.tiles[m.cells[st.cell]].flags & OCC) die(`Scene '${st.name}': camera in an opaque cell`);
  }
  return S;
}

// ------------------------------------------------------------------ scenes, expectation
/** [address, content] of the sprite sets packed from $6000 (16-byte alignment); one file per set. */
function s2Layout(assets) {
  let a = S2_START;
  const out = [];
  for (const ss of assets.sprites.slice(0, 4)) {
    const data = spr.toS2(ss).slice(2);
    out.push([a, data]);
    a = (a + data.length + 15) & ~15;
  }
  if (a > S2_END) die(`S2 (${a - S2_START} bytes) does not fit in $6000-$7FFF`);
  return out;
}

const u16le = (v) => Uint8Array.from([v & 255, (v >> 8) & 255]);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Everything agreed between the reference and VICE: files, bases, scene sequence, VRAM model. */
export class World {
  constructor() {
    const A = this.assets = buildAssets();
    this.map = buildMap();
    this.pack();
    this.steps = buildSteps();
    this.itemtab = [0, 2, 3, ...new Array(61).fill(0)];         // item 1 -> set 1 (gem), 2 -> set 2 (guard)
    this.s2 = s2Layout(A);
    this.s2addr = [...this.s2.map(([a]) => a), 0, 0, 0, 0];
    const sc = this.sc0 = V.makeScene(A, this.map, { itemtab: this.itemtab, buf: BUF, bandCover: true, start: POOL[0] });
    sc.vmsBank1 = true; sc.dtsAddr = this.dtsAddr.slice(); sc.s2Addr = this.s2addr.slice();
    this.bases = { dts: sc.vramBases.dts.slice(), dbg: sc.vramBases.dbg, s2: sc.vramBases.s2.slice() };
    const end = Math.max(...sc.assets().map(([, b, d]) => b + d.length));
    if (end > POOL[1]) die(`VRAM pool: end ${end} > ${POOL[1]}`);
    this.poolEnd = end;
    this.files = this.collectFiles();
    this.vram0 = this.initialVram();
  }

  /** File contents and their addresses in bank 1 (see HIGH). */
  pack() {
    const A = this.assets;
    this.blob = { dvg: V.dvgBytes(V.withBandCover(A.dvg)).slice(2), dts0: tex.toDts(A.walls).slice(2), dts1: tex.toDts(A.floor).slice(2),
      dts2: tex.toDts(A.ceil).slice(2), dbg: A.dbgPrg.slice(2), dmp: M.toDmp(this.map).slice(2) };
    const a = { dmp: LOW.dmp[0], dts0: LOW.dts0[0] };
    let p = HIGH[0];
    for (const n of ['dvg', 'dts2', 'dts1', 'dbg']) {
      a[n] = p;
      p = (p + this.blob[n].length + 15) & ~15;
    }
    if (p - 16 + this.blob.dbg.length > HIGH[1] || p > HIGH[1] + 15) {
      die(`DVG, DTS and DBG (${p - HIGH[0]} bytes) do not fit in $${hex4(HIGH[0])}-$${hex4(HIGH[1] - 1)}`);
    }
    for (const n of ['dmp', 'dts0']) {
      if (a[n] + this.blob[n].length > LOW[n][1]) die(`${n}: ${this.blob[n].length} bytes extend beyond $${hex4(LOW[n][1])}`);
    }
    this.addr = a;
    this.dtsAddr = [a.dts0, a.dts1, a.dts2];
  }

  /** Files [name, load address, content, limit] for bank 1 and the VRL files. */
  collectFiles() {
    const sc = this.sc0;
    const f = ['dvg', 'dmp', 'dbg', 'dts0', 'dts1', 'dts2'].map((n) => [n, this.addr[n], this.blob[n], 0x10000]);
    this.s2.forEach(([a_, d], k) => f.push([`s2${k}`, a_, d, S2_END]));
    for (const [n, a_, d] of f) {
      if (a_ < 0x4000 || a_ + d.length > 0xFC00 || (a_ < 0xD000 && 0xD000 < a_ + d.length) || (a_ >= 0xD000 && a_ < 0xE000)) {
        die(`${n}: $${hex4(a_)}+${d.length} is not within $4000-$CFFF/$E000-$FBFF (type 9, Blitz! runtime)`);
      }
    }
    // overlaps among each other
    const spans = f.map(([n, a, d]) => [a, a + d.length, n]).sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : 1));
    for (let i = 0; i + 1 < spans.length; i++) {
      if (spans[i + 1][0] < spans[i][1]) die(`Memory map: ${spans[i][2]} and ${spans[i + 1][2]} overlap`);
    }
    this.bank1 = f.map(([n, a, d]) => [n, a, d]);
    this.vrls = sc.assets().map(([name, base, data]) => {
      const st = vrl.encode(data);
      return [name, base, vrl.packFile(st, VRL_ADDR), st.length];
    });
    return f;
  }

  /** VRAM after the start of the test program (after the RXVs, before the first scene), 64 KB. */
  initialVram() {
    const v = new Uint8Array(65536);
    v.fill(0x1F, 8000, 9600);
    v.fill(15, 46335, 46335 + 16000);
    for (const [, base, data] of this.sc0.assets()) v.set(data, base);
    return v;
  }

  /** Per step: {step, scene, res (V.Result), move (move result | null), pos, dir}. */
  expected() {
    const out = [];
    let pos = 0, v = 0, objs = [], itemph = 0;
    const m = this.map;
    for (const st of this.steps) {
      let mv = null;
      if (st.kind === 'pos') {
        pos = st.cell; v = st.dir; objs = st.objs.slice(); itemph = st.itemph;
      } else {
        mv = dbemove(m, pos, v, objs, st.action);
        if (mv.a !== 0) throw new Error('AssertionError: MOVE A <> 0');
        pos = mv.pos; v = mv.dir;
      }
      const sc = this.sc0.copy();
      sc.pos = pos; sc.dir = v; sc.objects = objs.slice(); sc.itemph = itemph;
      sc.dmp = m.clone();
      sc.vramBases = { dts: this.bases.dts.slice(), dbg: this.bases.dbg, s2: this.bases.s2.slice() };
      const res = V.view(sc);
      out.push({ step: st, scene: sc, res, move: mv, pos, dir: v });
    }
    return out;
  }

  sceneTable() {
    const parts = [];
    for (const st of this.steps) {
      if (st.kind === 'pos') {
        parts.push(Uint8Array.from([0, st.cell & 255, st.cell >> 8, st.dir, st.itemph, st.objs.length]));
        for (const o of st.objs) parts.push(Uint8Array.from([o.cell & 255, o.cell >> 8, o.set, o.dir, o.phase, o.byte5()]));
      } else parts.push(Uint8Array.from([1, 0, 0, st.action, 0, 255]));
    }
    parts.push(Uint8Array.from([2, 0, 0, 0, 0, 0]));
    return cat(u16le(SCN_ADDR), ...parts);
  }
}

/** VRAM model: runVcl per step in sequence (state carries over). Returns: list [vram_after, paint_ref_window]. */
export function modelRun(world, exp) {
  const vram = Uint8Array.from(world.vram0);
  return exp.map(({ scene: sc, res }) => {
    const before = Uint8Array.from(vram);
    V.runVcl(res.bank0(), vram, res.p0, 80, res.bank1());
    const ref = res.a === 0 ? V.paintReference(sc, Uint8Array.from(before)) : null;
    return [Uint8Array.from(vram), ref];
  });
}

// ------------------------------------------------------------------ BASIC program
/** test/vice/view.bas with the placeholders @LOADS@ (load files) and @SETUP@ (setter calls). */
function basicListing(world, fast = false) {
  const sc = world.sc0;
  const fix = sc.bufFix ? 1 : 0;
  const B = world.bases;
  const loads = [];
  for (const [n] of world.bank1) loads.push(`bload"dbe.${n}",b1,u8:if ds<>0 then r=61:goto 8995`);
  loads.push('bload"dbe.scn",b0,u8:if ds<>0 then r=62:goto 8995');
  world.vrls.forEach(([, base], i) => {
    loads.push(`bload"dbe.v${i}",b0,u8:if ds<>0 then r=63:goto 8995`);
    loads.push(`rxv ${VRL_ADDR + 5},${base}`);
  });
  const calls = [[11, 0, 0, POOL[0], POOL[1]], [12, 0, 0, world.addr.dvg, 65535]];
  for (let k = 0; k < 3; k++) calls.push([13, k, 0, world.dtsAddr[k], B.dts[k]]);
  calls.push([14, sc.bgfill, 0, world.addr.dbg, B.dbg]);
  for (let k = 0; k < 4; k++) calls.push([9, k, 0, world.s2addr[k], B.s2[k]]);
  for (let g = 0; g < 64; g++) if (world.itemtab[g]) calls.push([10, g, world.itemtab[g], 0, 0]);
  calls.push([1, 0, 0, world.addr.dmp, 0]);
  calls.push([15, fix, 0, BUF[0], BUF[1]]);
  const setup = calls.map(([f, x, y, p0, p1], i) => `p0=${p0}:p1=${p1}:f=${f}:x=${x}:y=${y}:gosub 9500:if a<>0 then r=${20 + i}:goto 8995`);
  let text = readFileSync(join(HERE, 'vice', 'view.bas'), 'utf8').replaceAll('@VERSION@', VERSION);
  text = text.replaceAll('@FAST@', fast ? 'fast:' : '').replaceAll('@SLOW@', fast ? 'slow' : 'rem');
  if (fix) text = text.replaceAll('2120 v=peek(3072)+256*peek(3073):', `2120 v=${BUF[0]}:`);   // P6j: list always from B0, ::VCL with the constant
  const out = [];
  let n = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s === '@LOADS@' || s === '@SETUP@') {
      for (const body of s === '@LOADS@' ? loads : setup) {
        n++;
        out.push(`${300 + n} ${body}`);
      }
      continue;
    }
    out.push(line);
  }
  if (!(300 + n < 2000)) throw new Error('AssertionError: too many lines for the block');
  return out.join('\n');
}

/** sim65 cycles per step (VIEW only, without stub): run with F = 4 minus run with F = 7 (as run_sim timeView), with
 *  objects and items. Returns a list or null (without sim65). */
async function simCycles(world, exp) {
  const which = spawnSync('sh', ['-c', 'command -v sim65'], { encoding: 'utf8' });
  if (which.status !== 0) return null;
  const rs = await import('./sim/run_sim.js');
  rs.build();
  return exp.map((e) => {
    const sc = e.scene.copy();
    const R = new rs.ViewRunner();
    R.dbgBytes = world.blob.dbg;
    sc.vmsBank1 = true; sc.dtsAddr = rs.P6D_ADDR.dts.slice();
    R.setup(sc);
    const r = [4, 7].map((f) => rs.run(R.scene.clone().call(f, 0, 0, { p: [sc.ap, 0, 0, 0], quiet: true, ...rs.ViewRunner.objargs(sc) }), R.prg).cycles);
    return r[0] - r[1];
  });
}

// ------------------------------------------------------------------ disk and run
function makeDisk(world, d64, bootPrg, tPrg, workdir) {
  const files = [['boot', bootPrg], ['vdcbasic3', join(vs.VDC, 'vdcbasic3.bin')],
    [STUBNAME, join(ROOT, 'build', STUBNAME)], [LIBNAME, join(ROOT, 'build', LIBNAME)], ['t', tPrg]];
  for (const [n, a, d] of world.bank1) {
    const p = join(workdir, `dbe.${n}`);
    writeFileSync(p, cat(u16le(a), d));
    files.push([`dbe.${n}`, p]);
  }
  const p = join(workdir, 'dbe.scn');
  writeFileSync(p, world.sceneTable());
  files.push(['dbe.scn', p]);
  world.vrls.forEach(([, , f], i) => {
    const q = join(workdir, `dbe.v${i}`);
    writeFileSync(q, f);
    files.push([`dbe.v${i}`, q]);
  });
  const cmd = ['-format', 'dbe,01', 'd64', d64];
  for (const [n, q] of files) cmd.push('-write', q, n);
  vs.sh('c1541', cmd, { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** One VICE run. Returns [rc, {scenes, errors, end}]. */
async function runOne(world, d64, bootPrg, port, tmo, workdir) {
  const syms = vs.symbols(join(vs.VDC, 'build', 'vdcbasic3.sym'));
  const RTS = vs.stubRts();
  const VD = 0x0D03;
  const res = { scenes: [], errors: [], end: false };
  const vramf = join(workdir, 'vram.bin');

  const script = async (m) => {
    const ev = await m.mem(0x300, 2);
    const errAt = ev[0] | (ev[1] << 8);
    await m.bp(errAt);
    for (const a of [M_VIEW, M_DONE, M_END]) await m.bp(a);
    // End of VCL: .vcl_done (local label, from the ACME report). complex_instruction_shared_exit does not work: every
    // VMC/VMF and every VMS copy command ends there (the I flag would be free again from the first entry on).
    const timing = { vd: VD, ve: RTS, ce: syms.vcl, cx: vs.vdcLabels()['.vcl_done'] };
    const ids = {};
    for (const [k, a] of Object.entries(timing)) ids[k] = await m.bp(a);
    const at = new Map(Object.entries(timing).map(([k, a]) => [a, k]));
    for (const i of Object.values(ids)) await m.cmd(`disable ${i}`);
    let t = {};
    for (;;) {
      let pc;
      try {
        [pc] = await m.go();
      } catch (e) {
        if (e instanceof vs.Exited) return;
        throw e;
      }
      if (pc === errAt) {
        const [lo, hi] = await m.mem(0x3B, 2);
        res.errors.push([await m.regX(), lo | (hi << 8), res.scenes.length]);
        m.send('quit\n');
        return;
      } else if (pc === M_VIEW) {
        t = {};
        await m.cmd('stopwatch reset');
        for (const i of Object.values(ids)) await m.cmd(`enable ${i}`);
      } else if (at.has(pc)) {
        const k = at.get(pc);
        t[k] = await vs.stopwatch(m);
        if (k === 'vd' || k === 'ce') {             // set I flag: cycles without Kernal IRQ (comparable to sim65)
          const fl = await vs.flags(m);
          t.fl = fl;
          await m.cmd(`r fl = $${(fl | 4).toString(16).padStart(2, '0')}`);
        } else {                                    // exit: I flag as before (SYS/::VCL return to BASIC)
          await m.cmd(`r fl = $${(((await vs.flags(m)) & ~4) | (t.fl & 4)).toString(16).padStart(2, '0')}`);
        }
      } else if (pc === M_DONE) {
        t.done = await vs.stopwatch(m);
        for (const i of Object.values(ids)) await m.cmd(`disable ${i}`);
        await m.cmd('bank ram00');
        const pb = await m.mem(0x0C00, 0x20);
        const tb = await m.mem(0x0C40, 8);
        const buf = await m.mem(BUF[0], BUF[1] - BUF[0]);
        await m.cmd('bank vdc');
        if (existsSync(vramf)) rmSync(vramf);
        await m.cmd(`bsave "${vramf}" 0 0000 ffff`);
        await m.cmd('bank ram00');
        res.scenes.push({ t, pb, tb, buf, vram: new Uint8Array(readFileSync(vramf)) });
      } else if (pc === M_END) res.end = true;
    }
  };

  const args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
    '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', bootPrg,
    '-limitcycles', '1500000000'];
  const [, rc] = await vs.runVice(args, port, tmo, script);
  return [rc, res];
}

/** Comparison per scene. Returns [lines, number of errors]. */
export function compare(world, exp, model, got, sim = null) {
  const lines = [];
  let bad = 0;
  if (got.scenes.length !== exp.length) {
    lines.push(`ERROR: ${got.scenes.length} scenes reported, expected ${exp.length}`);
    bad++;
  }
  const n = Math.min(exp.length, model.length, got.scenes.length);
  for (let k = 0; k < n; k++) {
    const e = exp[k], [vram, ref] = model[k], g = got.scenes[k];
    const { res, scene: sc, step: st } = e;
    const msg = [];
    const { pb, tb } = g;
    if (tb[0] !== res.a || tb[1] !== res.x) msg.push(`A/X VICE ${tb[0]}/${tb[1]} <> reference ${res.a}/${res.x}`);
    if (w16(pb, 0x0A) !== res.p0 || w16(pb, 0x0C) !== res.vcllen || w16(pb, 0x0E) !== res.vmslen || w16(pb, 0x10) !== res.objvis) {
      msg.push(`VCLADR/VCLLEN/VMSLEN/OBJVIS VICE [${[0x0A, 0x0C, 0x0E, 0x10].map((i) => `'${pyHex(w16(pb, i))}'`).join(', ')}] <> `
        + `[${[res.p0, res.vcllen, res.vmslen, res.objvis].map((v) => `'${pyHex(v)}'`).join(', ')}]`);
    }
    const mv = e.move;
    if (mv !== null && (tb[2] !== mv.a || tb[3] !== mv.x || tb[4] !== mv.y || w16(tb, 5) !== mv.p0)) {
      msg.push(`MOVE VICE A/X/Y/P0 ${tb[2]}/${tb[3]}/${tb[4]}/${w16(tb, 5)} <> ${mv.a}/${mv.x}/${mv.y}/${mv.p0}`);
    }
    // buffer: VCL list [VCLADR, B1) and VMS lists [B0, B0 + VMSLEN) as in the reference
    const buf = Uint8Array.from(g.buf), b0 = BUF[0];
    const vcl = buf.slice(res.l0 - b0, res.l0 - b0 + res.vcl.length);
    const vms = buf.slice(res.m0 - b0, res.m0 - b0 + res.vms.length);
    if (res.fix && !bytesEq(buf.slice(0, 3), res.jump())) {
      msg.push(`Jump at B0 ${Buffer.from(buf.slice(0, 3)).toString('hex')} <> ${Buffer.from(res.jump()).toString('hex')}`);
    }
    if (!bytesEq(vcl, res.vcl) || !bytesEq(vms, res.vms)) msg.push('buffer (VCL/VMS) differs from the reference');
    // VRAM: whole (64 KB) against the model, window against paintReference
    const v = g.vram;
    const veq = bytesEq(v, vram);
    if (!veq) {
      const idx = range(65536).filter((i) => v[i] !== vram[i]);
      const i0 = idx[0];
      msg.push(`VRAM ${idx.length} bytes wrong, first $${hex4(i0)}: VICE ${(v[i0] ?? 0).toString(16).toUpperCase().padStart(2, '0')} <> model ${vram[i0].toString(16).toUpperCase().padStart(2, '0')}`);
    }
    const pix = ref === null || rowsEq(V.windowBytes(sc, v), V.windowBytes(sc, ref));
    const t = g.t;
    const cyc = { view: t.ve - t.vd, vcl: t.cx - t.ce, total: t.done };
    cyc.sum = cyc.view + cyc.vcl;
    cyc.sim = sim ? sim[k] : 0;
    g.cyc = cyc;
    const ok = !msg.length;
    bad += ok ? 0 : 1;
    lines.push({ k, name: st.name, kind: st.kind, a: res.a, x: res.x, items: res.items, nv: res.vcllen, nm: res.vmslen,
      pix: ok && veq, ref: ref === null ? '-' : (pix ? 'yes' : 'NO'), cyc, msg, ok });
    if (ref !== null && !pix) {
      lines[lines.length - 1].msg.push('window differs from paint_reference (VICE = run_vcl model: ' + (veq ? 'yes' : 'no') + ')');
    }
  }
  return [lines, bad];
}

const rj = (v, n) => String(v).padStart(n);
const lj = (v, n) => String(v).padEnd(n);

/** Cycles: monitor stopwatch (clocks at 1 MHz). Columns with 2M: run with FAST (2 MHz, VIC off), if present. */
export function report(name, lines, bad) {
  const two = lines.some((L) => typeof L === 'object' && 'cyc2' in L);
  console.log(`--- ${name}`);
  console.log(`${rj('#', 2)} ${lj('Scene', 34)} ${rj('A', 1)} ${rj('X', 3)} ${rj('VCL', 4)} ${rj('VMS', 5)} ${rj('Model', 6)} ${rj('Ref', 4)} ${rj('VIEW', 7)} ${rj('VCL', 9)} `
    + `${rj('VIEW+VCL', 9)} ${rj('with BASIC', 9)} ${rj('sim65', 7)}` + (two ? ` | ${rj('VIEW 2M', 7)} ${rj('VCL 2M', 9)} ${rj('V+V 2M', 9)}` : ''));
  for (const L of lines) {
    if (typeof L !== 'object') { console.log(L); continue; }
    const c = L.cyc;
    console.log(`${rj(L.k, 2)} ${lj(L.name, 34)} ${rj(L.a, 1)} ${rj(L.x, 3)} ${rj(L.nv, 4)} ${rj(L.nm, 5)} `
      + `${rj(L.pix ? 'yes' : 'NO', 6)} ${rj(L.ref, 4)} ${rj(c.view, 7)} ${rj(c.vcl, 9)} ${rj(c.sum, 9)} ${rj(c.total, 9)} ${rj(c.sim || '-', 7)}`
      + ('cyc2' in L ? ` | ${rj(L.cyc2.view, 7)} ${rj(L.cyc2.vcl, 9)} ${rj(L.cyc2.sum, 9)}` : ''));
    for (const m_ of L.msg) console.log('      ', m_);
  }
  const ds = lines.filter((L) => typeof L === 'object');
  if (ds.length) {
    const n = ds.length;
    for (const [key, lab] of [['view', 'VIEW'], ['vcl', 'VCL'], ['sum', 'VIEW+VCL'], ['total', 'with BASIC'], ['sim', 'sim65']]) {
      const vals = ds.map((L) => L.cyc[key]);
      if (!vals.some((x) => x)) continue;
      console.log(`    ${lj(lab, 10)} mean ${rj(Math.floor(vals.reduce((a, b) => a + b, 0) / n), 9)}  min ${rj(Math.min(...vals), 9)}  max ${rj(Math.max(...vals), 9)}`);
    }
    if (two) {
      for (const [key, lab] of [['view', 'VIEW'], ['vcl', 'VCL'], ['sum', 'VIEW+VCL']]) {
        const v1 = ds.map((L) => L.cyc[key]), v2 = ds.map((L) => L.cyc2[key]);
        const s1 = v1.reduce((a, b) => a + b, 0), s2 = v2.reduce((a, b) => a + b, 0);
        console.log(`    ${lj(lab + ' 2 MHz', 14)} mean ${rj(Math.floor(s2 / n), 9)}  min ${rj(Math.min(...v2), 9)}  max ${rj(Math.max(...v2), 9)}`
          + `  (ratio to 1 MHz ${tex.pyFixed(s2 / s1, 2)})`);
      }
    }
  }
  console.log(`    ${!bad ? 'all equal' : bad + ' errors'}`);
}

function checkOnly(world, exp, model, png = null) {
  let bad = 0;
  exp.forEach((e, k) => {
    const [vram, ref] = model[k];
    const res = e.res;
    let note = '';
    if (res.a !== 0) note = ` A=${res.a}`;
    if (ref !== null && !rowsEq(V.windowBytes(e.scene, vram), V.windowBytes(e.scene, ref))) {
      note += ' paint_reference differs';
      bad++;
    }
    console.log(`${rj(k, 2)} ${lj(e.step.name, 34)} pos ${rj(e.pos, 3)} dir ${e.dir} VCL ${rj(res.vcllen, 4)} VMS ${rj(res.vmslen, 5)} `
      + `entries ${rj(res.x, 3)} objvis 0x${res.objvis.toString(16).padStart(4, '0')}${note}`);
  });
  if (png) {
    mkdirSync(png, { recursive: true });
    const ims = exp.map((e, k) => V.windowImage(e.scene, model[k][0], 2));
    const cols = 6;
    const w = ims[0].width, h = ims[0].height;
    const SW = cols * (w + 4), SH = Math.ceil(ims.length / cols) * (h + 4);
    const rgb = new Uint8Array(SW * SH * 3);
    for (let i = 0; i < SW * SH; i++) rgb.set([40, 40, 40], 3 * i);
    ims.forEach((im, i) => {
      const ox = (i % cols) * (w + 4), oy = Math.floor(i / cols) * (h + 4);
      for (let y = 0; y < h; y++) rgb.set(im.rgb.subarray(y * w * 3, (y + 1) * w * 3), ((oy + y) * SW + ox) * 3);
    });
    writeFileSync(join(png, 'scenes.png'), encodePng({ width: SW, height: SH, rgb }));
  }
  console.log('Memory map:', [...world.bank1].sort((x, y) => x[1] - y[1]).map(([n, a, d]) => `${n} $${hex4(a)}-$${hex4(a + d.length - 1)}`).join(', '));
  console.log(`VRAM pool: $${hex4(POOL[0])}-$${hex4(world.poolEnd - 1)} of ${POOL[0]}-${POOL[1] - 1}, bases ${pyBases(world.bases)}`);
  return bad;
}

function parseArgs(argv) {
  const a = { port: null, timeout: 900, only: null, check: false, png: null, control: false, noSim: false, byteEdges: false,
    noFast: false, fix: false };
  const usage = () => die('usage: vice_view.js [--port N] [--timeout S] [--only {i,c}] [--check] [--png DIR] [--control] [--no-sim] [--byte-edges] [--no-fast] [--fix]');
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) usage(); return argv[++i]; };
    if (k === '--port') a.port = parseInt(val(), 10);
    else if (k === '--timeout') a.timeout = parseInt(val(), 10);
    else if (k === '--only') { a.only = val(); if (!['i', 'c'].includes(a.only)) usage(); }
    else if (k === '--check') a.check = true;
    else if (k === '--png') a.png = val();
    else if (k === '--control') a.control = true;
    else if (k === '--no-sim') a.noSim = true;
    else if (k === '--byte-edges') a.byteEdges = true;
    else if (k === '--no-fast') a.noFast = true;
    else if (k === '--fix') a.fix = true;
    else usage();
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  vs.requireVdc();
  vs.sh('sh', [join(ROOT, 'engine', 'build.sh')], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (a.byteEdges) process.env.DBE_BYTE_EDGES = '1';          // default geometry with byte_edges (lib/assets.js)
  const world = new World();
  world.sc0.bufFix = a.fix;
  const exp = world.expected();
  const model = modelRun(world, exp);
  if (a.check || a.png) return checkOnly(world, exp, model, a.png) ? 1 : 0;
  if (a.control) {
    const v = Uint8Array.from(model[5][0]);
    v[3 * 80 + 10] ^= 0x11;
    model[5] = [v, model[5][1]];
  }
  const sim = a.noSim ? null : await simCycles(world, exp);
  mkdirSync(OUT, { recursive: true });
  const port = await vs.choosePort(a.port);
  const bootPrg = vs.makeBoot(OUT);
  const wd = join(OUT, 'view-files');
  rmSync(wd, { recursive: true, force: true });
  mkdirSync(wd);
  let bad = 0;
  const node = vs.findNode(), blitzc = vs.findBlitzc();

  /** Build the program (interpreted: tokenized from $4001; compiled: Blitz!). Returns the PRG or null. */
  const build = (compiled, fast) => {
    const suf = (compiled ? 'c' : 'i') + (fast ? 'f' : '');
    const srcBas = join(OUT, `view${fast ? '-f' : ''}.bas`);
    writeFileSync(srcBas, basicListing(world, fast));
    if (!compiled) {
      const prg = join(OUT, `view-${suf}.prg`);
      vs.tok(srcBas, prg, '0x4001');
      return prg;
    }
    const prep = join(OUT, `view-b${fast ? 'f' : ''}.bas`);
    vs.sh('python3', ['-B', join(vs.VDC, 'test', 'blitzprep.py'), srcBas, prep]);
    const src = join(OUT, `view-src${fast ? 'f' : ''}.prg`);
    vs.tok(prep, src);
    const cdir = join(OUT, `view-blitz${fast ? '-f' : ''}`);
    rmSync(cdir, { recursive: true, force: true });
    const c = spawnSync(node, [blitzc, src, cdir, '--name', 'T', '--runtime', vs.blitzRuntime()], { encoding: 'utf8' });
    const cprg = join(cdir, 'c.prg');
    const hdr = existsSync(cprg) ? readFileSync(cprg).subarray(0, 2) : null;
    if (c.status || !hdr || hdr[0] !== 0x01 || hdr[1] !== 0x40) {
      console.log(`compiled: compiler rc ${c.status}: ${(c.stdout || '').trim()}`);
      const scr = join(cdir, 'screen.txt');
      if (existsSync(scr)) console.log(readFileSync(scr, 'utf8'));
      return null;
    }
    return cprg;
  };

  /** One run. Returns [lines, number of errors, error bit] or null if the program could not be built. */
  const one = async (compiled, fast) => {
    const prg = build(compiled, fast);
    if (prg === null) return null;
    const d64 = join(OUT, `view-${compiled ? 'c' : 'i'}${fast ? 'f' : ''}.d64`);
    makeDisk(world, d64, bootPrg, prg, wd);
    const [rc, got] = await runOne(world, d64, bootPrg, port, a.timeout, wd);
    const what = compiled ? 'compiled (Blitz!, image 2)' : 'interpreted';
    const errs = `[${got.errors.map((e) => `(${e.join(', ')})`).join(', ')}]`;
    console.log(`${what}${fast ? ', 2 MHz (FAST)' : ''}: exit ${rc === null ? 'None' : rc}, BASIC error ${errs}, end reached ${got.end ? 'True' : 'False'}`);
    const [lines, b] = compare(world, exp, model, got, sim);
    return [lines, b, (rc !== 0) | (b !== (a.control ? 1 : 0)) | (got.errors.length > 0) | (!got.end)];
  };

  for (const compiled of [false, true]) {
    if ((a.only === 'c' && !compiled) || (a.only === 'i' && compiled)) continue;
    if (compiled && (!node || !blitzc)) {
      console.log('compiled: SKIP (blitzc not found)');
      bad |= 2;
      continue;
    }
    const r1 = await one(compiled, false);
    if (r1 === null) { bad |= 1; continue; }
    const [lines1, b1, e1] = r1;
    bad |= e1;
    const name = compiled ? 'compiled (Blitz!, image 2)' : 'interpreted';
    if (!a.noFast) {
      // second run with FAST (2 MHz, VIC display off during VIEW and VCL): same check, cycles as cyc2
      const r2 = await one(compiled, true);
      if (r2 === null) bad |= 1;
      else {
        const [lines2, , e2] = r2;
        bad |= e2;
        for (let i = 0; i < Math.min(lines1.length, lines2.length); i++) {
          const L1 = lines1[i], L2 = lines2[i];
          if (typeof L1 === 'object' && typeof L2 === 'object') {
            L1.cyc2 = L2.cyc;
            L1.msg.push(...L2.msg.map((m_) => `(2 MHz) ${m_}`));
          }
        }
      }
    }
    report(name, lines1, b1);
  }
  return bad ? 1 : 0;
}

// Used by test/vice_zp.js (--funcs) and test/vice_vclprof.js.
export { basicListing, makeDisk };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((rc) => { process.exitCode = rc; }, (e) => { console.error(e); process.exitCode = 1; });
}
