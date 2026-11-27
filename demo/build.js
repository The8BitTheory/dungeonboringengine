#!/usr/bin/env node
// Build the demo (docs/specs/P7-crawl.md 8.4): geometry, textures, wallpaper, sprites, map, program, disk.
// Port of demo/build.py on the JS tools (tools/js/core); same files byte for byte.
//
// Usage: node demo/build.js [--out DIR] [--no-disk] [--budget [N]] [--blitz] [-q]
//   Without options: all files to build/demo/files/, disk build/demo/dbe-demo.d81 (+ .d64, interpreted), report
//   build/demo/report.md, layout build/demo/layout.json.
//   --out DIR     output folder instead of build/demo; unlike build.py also the intermediate outputs of the tools
//                 (geom/, tex/, spr/, art/), which the TOMLs place in ../build/demo, go to DIR (paths remapped)
//   --budget [N]  view.js budget over all views of the map (4 directions per walkable cell) with 0 to 3 goblins;
//                 N = number of random goblin states (default 30); A must be 0 everywhere.
//   --blitz       additionally the Blitz! version (disk dbe-demo-blitz.d81; needs node and blitzc)
//   --no-disk     files only (assets: needs only Node, no cc65/VICE/VDC-BASIC)
//
// Build steps (JS tools, sources in demo/): geom view.toml -> DVG, tex build (walls/floor/ceil), mkbg.js + tex bg
// (wallpaper), goblin sheet + spr build (goblin, gem), map build -> demo.dmp. Then: bank 1 ranges (mem.js, already
// checked by the tools), VRAM pool (bases packed from 9600, end <= 46335), DATA lines of demo.bas against the layout,
// program size (< $9000).
// External tools as in build.py: c1541 (VICE), VDC-BASIC v3 (VDCBASIC_DIR, read only: boot/boot.bas, vdcbasic3.bin,
// test/bastok.py, test/blitzprep.py; the tokenizer and blitzprep are Python scripts of VDC-BASIC), sh engine/build.sh.
// API: build(opts), loadWorld(out) -> [scene, layout], routes(basPath), budget(out, step, log), layout(files),
// expectedData(L), buildFiles(out, log), makeGoblinPng(out), program/bootPrg/makeDisk.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve as presolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as G from '../tools/js/core/geom.js';
import * as T from '../tools/js/core/tex.js';
import * as S from '../tools/js/core/spr.js';
import * as V from '../tools/js/core/view.js';
import * as dbemap from '../tools/js/core/map.js';
import * as vrl from '../tools/js/core/vrl.js';
import { rangeError } from '../tools/js/core/mem.js';
import { parseToml } from '../tools/js/core/io/toml.js';
import { encodePng } from '../tools/js/core/io/png.js';
import { PyRandom } from '../tools/js/core/pyrandom.js';
import { pyJson } from '../tools/js/core/crawl/util.js';
import { loadRgb, newRgb, writeBg } from './mkbg.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

export const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
export const VDC = process.env.VDCBASIC_DIR || join(homedir(), 'git', 'vdc-basic');
export const OUT = join(ROOT, 'build', 'demo');
export const FARFILL = 0x11;          // far-view fill byte (BGSET Y = 1, P2; P6 5.7a): dark gray, 2 pixels of color 1
export const POOL = Object.freeze([9600, 46335]);   // VRAM pool: after the attribute RAM up to the screen RAM
export const VRL_BUF = 0x9000;        // load buffer of the VRL files in bank 0 (vrl_load in the TOMLs), RXV source from +5
export const BAS_LIMIT = VRL_BUF;     // the program (interpreted or compiled) must end below it

// Bank 1 load addresses (memory map P6 2.4); DMP and S2 are in the TOMLs or here
export const ADDR = Object.freeze({
  dmp: 0x4000, work: 0x5000, 'goblin.s2': 0x6000, 'gem.s2': 0x6500, 'walls.dts': 0x8000,
  'demo.dvg': 0xE800, 'floor.dts': 0xEE00, 'ceil.dts': 0xF600, 'land.dbg': 0xFB80,
});
// order of the VRL files = order of the VRAM bases = DATA 600
export const VRL_NAMES = Object.freeze(['walls', 'floor', 'ceil', 'land', 'goblin', 'gem']);

/** sys.exit(message) of build.py: printed to stderr by main(), exit code 1. */
export class BuildError extends Error {
  constructor(msg) { super(msg); this.name = 'BuildError'; }
}

const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
const rd = (p) => new Uint8Array(readFileSync(p));

/** subprocess.run(cmd) with BuildError on a non-zero exit code; stdout 'inherit' | 'ignore' | 'pipe'. */
function sh(cmd, { stdout = 'inherit' } = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: ['inherit', stdout, 'inherit'], encoding: 'utf8' });
  if (r.error) throw new BuildError(`Error (${r.error.code}): ${cmd.join(' ')}`);
  if (r.status) throw new BuildError(`Error (${r.status}): ${cmd.join(' ')}`);
  return r;
}

// ------------------------------------------------------------------ paths of the tool outputs

/** Path mapping for --out: the TOMLs place their outputs in ../build/demo; with another out they are redirected.
 *  Returns map(p): p unchanged if out is build/demo (texts then equal build.py) or p does not lie below it. */
export function pathMap(out) {
  const o = presolve(out);
  if (o === OUT) return (p) => p;
  return (p) => {
    const a = presolve(p);
    const rel = relative(OUT, a);
    return rel === '' ? o : !rel.startsWith('..') && !isAbsolute(rel) ? join(o, rel) : p;
  };
}

function fsResolver(map) {
  return (p) => {
    const q = map(p);
    try {
      return new Uint8Array(readFileSync(q));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
}

function writeFile(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

// ------------------------------------------------------------------ Build

/** Sheet from goblin1.bmp: images 0, 2, 4, 6 (4 phases), scaled 2x (64 x 64 per phase), black (1, 1, 1) -> (0, 0, 0)
 *  (VDC palette), background stays the key 5555FF (goblin.toml). */
export function makeGoblinPng(out) {
  const src = loadRgb(join(HERE, 'art', 'goblin1.bmp'));
  const sheet = newRgb(64 * 4, 64, [0x55, 0x55, 0xFF]);
  [0, 2, 4, 6].forEach((f, i) => {
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        // crop (f * 32, 0, f * 32 + 32, 32) and resize to 64 x 64 NEAREST: source pixel (x >> 1, y >> 1)
        const s = (((y >> 1) * src.width) + f * 32 + (x >> 1)) * 3;
        let c = [src.rgb[s], src.rgb[s + 1], src.rgb[s + 2]];
        if (c[0] === 1 && c[1] === 1 && c[2] === 1) c = [0, 0, 0];
        sheet.rgb.set(c, (y * sheet.width + 64 * i + x) * 3);
      }
    }
  });
  writeFile(out, encodePng(sheet));
}

/** All files of the disk (except program and VDC-BASIC) to out/files. Returns: {name: path}. */
export function buildFiles(out, log) {
  const F = join(out, 'files');
  const map = pathMap(out);
  const resolve = fsResolver(map);
  rmSync(F, { recursive: true, force: true });
  for (const d of [F, join(out, 'tex'), join(out, 'spr'), join(out, 'art'), join(out, 'geom')]) mkdirSync(d, { recursive: true });
  const D = (n) => join(HERE, n);
  const warn = (w) => process.stderr.write(`Warning: ${w}\n`);
  // dbegeom view.toml
  {
    const conf = G.parseConfig(parseToml(readFileSync(D('view.toml'))));
    const outdir = map(T.pjoin(HERE, conf.dir));
    const res = G.generate(conf, conf.name);
    for (const [rel, data] of Object.entries(res.files)) writeFile(join(outdir, rel), data);
    log(`${conf.name}: ${res.geo.elements.length} elements, wall style ${res.bud.wall_style} bytes -> ${outdir}`);
  }
  writeBg(join(out, 'art', 'land.png'), { geom: join(out, 'geom', 'west140.geom.json') });
  makeGoblinPng(join(out, 'art', 'goblin.png'));
  for (const t of ['walls', 'floor', 'ceil']) {
    const path = D(t + '.toml'), src = rd(path);
    const r = T.buildTex(src, { path, resolve, out: map(T.loadTexConf(src, { path }).out) });
    for (const [name, data] of Object.entries(r.files)) writeFile(join(r.conf.out, name), data);
    for (const p of r.previews) writeFile(join(r.conf.out, p.name), encodePng(p.image));
    const rp = r.report;
    log(`${r.conf.name}: ${r.ts.styles.length} styles, ${r.ts.entries.length} images, VRAM ${T.groupThousands(rp.vram)} bytes, `
      + `VRL ${T.groupThousands(rp.vrl_bytes)} bytes, VMS bound ${T.groupThousands(rp.vms_bound)}/${T.VMS_BUFFER}`);
    r.warnings.forEach(warn);
  }
  {
    const path = D('bg.toml'), src = rd(path);
    const r = T.buildBg(src, { path, resolve, out: map(T.loadBgConf(src, { path }).out) });
    for (const [name, data] of Object.entries(r.files)) writeFile(join(r.conf.out, name), data);
    log(`${r.conf.name}: wallpaper, VRAM ${r.vram.length} bytes, VRL ${r.stream.length} bytes`);
    r.warnings.forEach(warn);
  }
  for (const s of ['goblin', 'gem']) {
    const path = D(s + '.toml'), src = rd(path);
    const r = S.buildSpr(src, { path, resolve, out: map(S.loadConf(src, { path }).out) });
    for (const [n, v] of Object.entries(r.files)) writeFile(join(r.conf.out, n), v);
    for (const p of r.previews) writeFile(join(r.conf.out, p.name), encodePng(p.image));
    const ss = r.ss, rp = r.report, name = r.conf.name;
    log(`${name}: ${ss.na} angles, ${ss.np} phases, ${ss.images.length} images, S2 ${r.files[name + '.s2'].length - 2} bytes, `
      + `VRAM ${ss.u} bytes, VRL ${rp.vrl_bytes} bytes, VMS max ${rp.max_vms}`);
    rp.warnings.forEach(warn);
  }
  {
    const m = dbemap.loadsToml(readFileSync(D('demo.toml')), D('demo.toml'));
    dbemap.warningsFor(m).forEach(warn);
    const data = dbemap.toDmp(m, ADDR.dmp);
    dbemap.checkBank1(ADDR.dmp, data.length - 2);
    writeFile(join(F, 'demo.dmp'), data);
  }
  const src = {
    'demo.dvg': 'geom/west140.dvg', 'walls.dts': 'tex/walls.dts', 'floor.dts': 'tex/floor.dts',
    'ceil.dts': 'tex/ceil.dts', 'land.dbg': 'tex/land.dbg', 'goblin.s2': 'spr/goblin.s2', 'gem.s2': 'spr/gem.s2',
    'walls.vrl': 'tex/walls.vrl', 'floor.vrl': 'tex/floor.vrl', 'ceil.vrl': 'tex/ceil.vrl',
    'land.vrl': 'tex/land.vrl', 'goblin.vrl': 'spr/goblin.vrl', 'gem.vrl': 'spr/gem.vrl',
  };
  const files = { 'demo.dmp': join(F, 'demo.dmp') };
  for (const [n, s] of Object.entries(src)) {
    copyFileSync(join(out, s), join(F, n));
    files[n] = join(F, n);
  }
  return files;
}

const KIND = {
  'demo.dmp': 'dmp', 'goblin.s2': 's2', 'gem.s2': 's2', 'walls.dts': 'wall', 'demo.dvg': 'dvg', 'floor.dts': 'floor',
  'ceil.dts': 'ceiling', 'land.dbg': 'dbg',
};

/** Layout from the built files: bank 1 addresses (load address in the PRG header), VRAM bases (packed from POOL[0]). */
export function layout(files) {
  const L = { bank1: {}, vram: {}, vrl_buf: VRL_BUF };
  for (const [n, p] of Object.entries(files)) {
    if (n.endsWith('.vrl')) continue;
    const d = rd(p);
    L.bank1[n] = [d[0] | (d[1] << 8), d.length - 2];
  }
  for (const [n, a] of Object.entries(ADDR)) {
    if (n in L.bank1 && L.bank1[n][0] !== a) throw new BuildError(`${n}: load address $${h4(L.bank1[n][0])} in the PRG header, expected $${h4(a)}`);
  }
  let base = POOL[0];
  for (const n of VRL_NAMES) {
    const { load, u } = vrl.unpackFile(rd(files[n + '.vrl']));
    if (load !== VRL_BUF) throw new BuildError(`${n}.vrl: load address $${h4(load)}, expected $${h4(VRL_BUF)} (vrl_load in the TOML)`);
    L.vram[n] = [base, u];
    base += u;
  }
  L.pool_end = base;
  if (base > POOL[1]) throw new BuildError(`VRAM pool: end ${base} > ${POOL[1]} (cut list P7 8.4: arch, goblin phases, panorama height)`);
  // bank 1 ranges and overlaps (the tools only check their own range)
  const spans = Object.entries(L.bank1).map(([name, [a, n]]) => [a, a + n, name])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  for (let i = 0; i + 1 < spans.length; i++) {
    if (spans[i + 1][0] < spans[i][1]) throw new BuildError(`Bank 1: ${spans[i][2]} and ${spans[i + 1][2]} overlap`);
  }
  for (const [a0, a1, name] of spans) {
    const err = rangeError(KIND[name], a0, a1 - a0);
    if (err) throw new BuildError(err);
  }
  const m = dbemap.fromDmp(rd(files['demo.dmp']));
  L.map = { w: m.width, h: m.height, work: ADDR.work, work_end: ADDR.work + 2 * m.width * m.height };
  if (L.map.work_end > 0x6000) throw new BuildError('working copy of the map extends beyond $5FFF');
  if (ADDR.work < L.bank1['demo.dmp'][0] + L.bank1['demo.dmp'][1]) throw new BuildError('working copy overlaps the DMP');
  return L;
}

/** DATA lines of demo.bas: line number -> text (bases and setter calls). */
export function expectedData(L) {
  const v = L.vram, b1 = L.bank1;
  const ex = { 600: VRL_NAMES.map((n) => String(v[n][0])).join(',') };
  const calls = [[11, 0, 0, POOL[0], POOL[1], 0], [12, 0, 0, b1['demo.dvg'][0], 65535, 0],
    [13, 0, 0, b1['walls.dts'][0], v.walls[0], 0], [13, 1, 0, b1['floor.dts'][0], v.floor[0], 0],
    [13, 2, 0, b1['ceil.dts'][0], v.ceil[0], 0],
    [14, 0x33, 1, b1['land.dbg'][0], v.land[0], FARFILL],       // Y = 1, P2 = far-view fill byte
    [9, 0, 0, b1['goblin.s2'][0], v.goblin[0], 0], [9, 1, 0, b1['gem.s2'][0], v.gem[0], 0],
    [10, 1, 2, 0, 0, 0], [1, 1, 0, b1['demo.dmp'][0], ADDR.work, 0]];
  calls.forEach((c, i) => { ex[610 + i] = c.join(','); });
  return ex;
}

/** DATA lines of a BASIC listing: {line number: text without blanks}. */
function dataLines(basPath) {
  const got = {};
  for (const line of readFileSync(basPath, 'utf8').split('\n')) {
    const m = /^(\d+)\s+data\s+(.*)$/.exec(line.trim());
    if (m) got[parseInt(m[1], 10)] = m[2].replace(/ /g, '');
  }
  return got;
}

export function checkBas(L, basPath) {
  const ex = expectedData(L);
  const got = dataLines(basPath);
  const bad = Object.keys(ex).filter((n) => got[n] !== ex[n]);
  if (bad.length) {
    const msg = bad.map((n) => `${n} data ${ex[n]}   (in demo.bas: ${got[n] === undefined ? 'None' : got[n]})`).join('\n');
    throw new BuildError(`demo.bas does not match the built layout, change the DATA lines:\n${msg}`);
  }
}

// ------------------------------------------------------------------ World (model) for tests

/** view.js Scene from the built files (exactly the bytes on the disk), with bank 1 addresses, bases and
 *  ITEMSET as in demo.bas. Returns [scene, layout]. */
export function loadWorld(out = OUT) {
  const F = join(out, 'files');
  const L = JSON.parse(readFileSync(join(out, 'layout.json'), 'utf8'));
  const dvg = V.parseDvg(rd(join(F, 'demo.dvg')));
  const m = dbemap.fromDmp(rd(join(F, 'demo.dmp')));
  const sc = new V.Scene(dvg, m);
  const vram = (n) => vrl.decode(vrl.unpackFile(rd(join(F, n + '.vrl'))).stream);
  ['walls', 'floor', 'ceil'].forEach((n, k) => {
    sc.dts[k] = T.fromDts(rd(join(F, n + '.dts')), vram(n));
    sc.vramBases.dts[k] = L.vram[n][0];
  });
  sc.dbg = T.fromDbg(rd(join(F, 'land.dbg')));
  sc.dbgVram = vram('land');
  sc.vramBases.dbg = L.vram.land[0];
  ['goblin', 'gem'].forEach((n, i) => {
    sc.s2[i] = V.readS2(rd(join(F, n + '.s2')), vram(n));
    sc.vramBases.s2[i] = L.vram[n][0];
  });
  sc.itemtab[1] = 2;                       // item 1 -> set 1 (gem)
  sc.bgfill = 0x33;
  sc.farfill = FARFILL;                    // BGSET Y = 1, P2 = $11 (P6 5.7a): far view under ceilings dark gray
  sc.ap = 0;
  sc.buf = [0x1300, 0x1C00];
  sc.bufFix = true;                        // BUFSET X = 1 (demo.bas 315, P6j): jump at $1300
  sc.vmsBank1 = true;
  sc.dtsAddr = ['walls', 'floor', 'ceil'].map((n) => L.bank1[n + '.dts'][0]);
  sc.s2Addr = [L.bank1['goblin.s2'][0], L.bank1['gem.s2'][0], 0, 0, 0, 0, 0, 0];
  sc.automap = true;                       // MAPINIT with automap bit (X = 1)
  sc.checkLayout();
  return [sc, L];
}

/** Goblin routes from the DATA lines 620 ff. of demo.bas: list of lists [x, y]. */
export function routes(basPath) {
  const nums = [];
  for (const line of readFileSync(basPath, 'utf8').split('\n')) {
    const m = /^(\d+)\s+data\s+(.*)$/.exec(line.trim());
    if (m && parseInt(m[1], 10) >= 620) nums.push(...m[2].replace(/ /g, '').split(',').map((x) => parseInt(x, 10)));
  }
  const out = [];
  let i = 0;
  while (i < nums.length) {
    const n = nums[i];
    out.push(Array.from({ length: n }, (_, k) => [nums[i + 1 + 2 * k], nums[i + 2 + 2 * k]]));
    i += 1 + 2 * n;
  }
  return out;
}

/** Python repr of nested tuples of ints. */
const tupRepr = (t) => (Array.isArray(t) ? '(' + t.map(tupRepr).join(', ') + (t.length === 1 ? ',' : '') + ')' : String(t));

/** view.js budget: all walkable cells x 4 directions, with 0 goblins and with 1 to 3 goblins in `step` random
 *  states of the routes (fixed seed), all items. A must be 0 everywhere. */
export function budget(out, step, log) {
  const [sc0] = loadWorld(out);
  const m = sc0.dmp;
  const R = routes(join(HERE, 'demo.bas'));
  const walk = [];
  for (let c = 0; c < m.width * m.height; c++) if (!(m.tiles[m.cells[c]].flags & dbemap.FLAGS.solid)) walk.push(c);
  const rnd = new PyRandom(1);
  const states = [[]];
  for (let k = 0; k < step; k++) {                 // random states of the three routes, also with only 1 or 2 goblins
    const st = R.map((r) => rnd.randrange(r.length));
    states.push(st.slice(0, 1), st.slice(0, 2), st);
  }
  const rep = { views: 0, max_total: 0, max_vcl: 0, max_vms: 0, max_entries: 0, bad: [] };
  for (const st of states) {
    const objs = st.map((i, g) => new V.Obj(R[g][i][1] * m.width + R[g][i][0], 0, 0xFF, (g + 1) & 3, 4));
    for (const pos of walk) {
      if (objs.some((o) => o.cell === pos)) continue;
      for (let d = 0; d < 4; d++) {
        const sc = sc0.copy();
        sc.dmp = m.clone();
        sc.vramBases = { dts: sc0.vramBases.dts.slice(), dbg: sc0.vramBases.dbg, s2: sc0.vramBases.s2.slice() };
        sc.pos = pos; sc.dir = d; sc.objects = objs.slice();
        const r = V.view(sc);
        rep.views++;
        rep.max_total = Math.max(rep.max_total, r.vcllen + r.vmslen);
        rep.max_vcl = Math.max(rep.max_vcl, r.vcllen);
        rep.max_vms = Math.max(rep.max_vms, r.vmslen);
        rep.max_entries = Math.max(rep.max_entries, r.x);
        if (r.a) rep.bad.push([pos, d, st, r.a]);
      }
    }
  }
  log(`Budget: ${rep.views} views, VCL max ${rep.max_vcl}, VMS max ${rep.max_vms}, total max `
    + `${rep.max_total} of ${sc0.buf[1] - sc0.buf[0]}, entries max ${rep.max_entries}, A != 0: ${rep.bad.length}`);
  rep.badRepr = (b) => tupRepr(b);
  return rep;
}

// ------------------------------------------------------------------ Program and disk

export function tok(bas, prg, start = null) {
  sh(['python3', '-B', join(VDC, 'test', 'bastok.py'), ...(start ? ['--start', start] : []), bas, prg]);
}

/** vicemon.find_node / find_blitzc of VDC-BASIC (environment NODE, PATH; BLITZC or the default path). */
export function findNode() {
  if (process.env.NODE) return process.env.NODE;
  for (const d of (process.env.PATH || '').split(':')) {
    const p = join(d, 'node');
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return process.execPath;
}

export function findBlitzc() {
  const p = process.env.BLITZC || join(homedir(), 'git', 'blitz-compiler', 'blitz128', 'blitzc', 'js', 'cli.js');
  return existsSync(p) ? p : null;
}

/** Program PRG: interpreted (tokenized from $4001) or Blitz! compilation (image 2). fs: value of line 3 (1 =
 *  2 MHz during VIEW/VCL, 0 = 1 MHz), otherwise as in demo.bas. Returns path or null (without Blitz). */
export function program(out, { compiled = false, fs = null, tag = '' } = {}) {
  let text = readFileSync(join(HERE, 'demo.bas'), 'utf8');
  if (fs !== null) {
    text = text.replace('3 fs=1:', `3 fs=${fs}:`);
    if (!text.includes(`3 fs=${fs}:`)) throw new BuildError(`demo.bas: line 3 "3 fs=1:" not found`);
  }
  const bas = join(out, `demo${tag}.bas`);
  writeFileSync(bas, text);
  if (!compiled) {
    const prg = join(out, `demo${tag}.prg`);
    tok(bas, prg, '0x4001');
    const size = statSync(prg).size - 2;
    if (0x4001 + size > BAS_LIMIT) throw new BuildError(`Program ends at $${h4(0x4001 + size)}, VRL load buffer from $${h4(BAS_LIMIT)}`);
    return prg;
  }
  const node = findNode(), blitzc = findBlitzc();
  if (!node || !blitzc) return null;
  const prep = join(out, `demo${tag}-b.bas`);
  sh(['python3', '-B', join(VDC, 'test', 'blitzprep.py'), bas, prep]);
  const src = join(out, `demo${tag}-src.prg`);
  tok(prep, src);
  const cdir = join(out, `blitz${tag}`);
  rmSync(cdir, { recursive: true, force: true });
  const c = spawnSync(node, [blitzc, src, cdir, '--name', 'DEMO', '--runtime', process.env.BLITZ_RUNTIME || 'improved'], { encoding: 'utf8' });
  const cprg = join(cdir, 'c.prg');
  if (c.status || !existsSync(cprg) || rd(cprg)[0] !== 0x01 || rd(cprg)[1] !== 0x40) {
    throw new BuildError(`Blitz! compiler rc ${c.status}: ${(c.stdout || '').trim()}`);
  }
  const size = statSync(cprg).size - 2;
  if (0x4001 + size > BAS_LIMIT) throw new BuildError(`Compilation ends at $${h4(0x4001 + size)}, VRL load buffer from $${h4(BAS_LIMIT)}`);
  return cprg;
}

/** Boot loader of VDC-BASIC v3 (boot/boot.bas) with `50 RUN"DEMO"` instead of `50 NEW`. */
export function bootPrg(out, run = 'DEMO') {
  const bas = join(out, 'boot.bas');
  const text = readFileSync(join(VDC, 'boot', 'boot.bas'), 'utf8');
  const lines = text.split(/(?<=\n)/).map((l) => (l.startsWith('50 ') ? `50 RUN"${run}"\n` : l));
  writeFileSync(bas, lines.join(''));
  const prg = join(out, 'boot.prg');
  tok(bas, prg);
  return prg;
}

/** Disk (d81 or d64 by extension): boot, vdcbasic3, stub, lib, demo (program), data. */
export function makeDisk(path, files, prog, boot, name = 'dbe demo') {
  if (existsSync(path)) rmSync(path);
  const kind = path.slice(path.lastIndexOf('.') + 1);
  const cmd = ['c1541', '-format', `${name},01`, kind, path,
    '-write', boot, 'boot', '-write', join(VDC, 'vdcbasic3.bin'), 'vdcbasic3',
    '-write', join(ROOT, 'build', `dbe${VERSION}.stub`), `dbe${VERSION}.stub`,
    '-write', join(ROOT, 'build', `dbe${VERSION}.lib`), `dbe${VERSION}.lib`,
    '-write', prog, 'demo'];
  for (const [n, p] of Object.entries(files)) cmd.push('-write', p, n);
  sh(cmd, { stdout: 'ignore' });
}

/** Build stub and lib if they are missing or older than the sources. */
export function engineBuild() {
  const [stub, lib] = ['stub', 'lib'].map((e) => join(ROOT, 'build', `dbe${VERSION}.${e}`));
  const srcs = readdirSync(join(ROOT, 'engine')).map((n) => join(ROOT, 'engine', n));
  const mt = (p) => statSync(p).mtimeMs;
  if ([stub, lib].every((p) => existsSync(p)) && Math.min(mt(stub), mt(lib)) >= Math.max(...srcs.map(mt))) return;
  sh(['sh', join(ROOT, 'engine', 'build.sh')], { stdout: 'ignore' });
}

export function report(out, L, files, rep, extra) {
  const lines = ['# Demo: layout and budget', '', `Files: ${Object.keys(files).length} files in \`build/demo/files/\`.`, '',
    '## Bank 1', '', '| File | Load address | Length | End |', '|---|---|---|---|'];
  for (const [n, [a, ln]] of Object.entries(L.bank1).sort((x, y) => x[1][0] - y[1][0])) {
    lines.push(`| ${n} | $${h4(a)} | ${ln} | $${h4(a + ln - 1)} |`);
  }
  lines.push(`| Working copy of map | $${h4(L.map.work)} | ${2 * L.map.w * L.map.h} | $${h4(L.map.work_end - 1)} |`, '',
    '## VRAM pool', '', '| Name | Base | Length |', '|---|---|---|');
  for (const n of VRL_NAMES) {
    const [b, u] = L.vram[n];
    lines.push(`| ${n} | ${b} | ${u} |`);
  }
  lines.push('', `Pool ${POOL[0]} .. ${POOL[1] - 1} (${POOL[1] - POOL[0]} bytes): used ${L.pool_end - POOL[0]}, `
    + `free ${POOL[1] - L.pool_end} bytes.`, '');
  lines.push(...extra);
  if (rep) {
    lines.push('## Budget (dbeview)', '', `${rep.views} views with 0 to 3 goblins: VCL max ${rep.max_vcl}, VMS max `
      + `${rep.max_vms}, total max ${rep.max_total}, entries max ${rep.max_entries}, `
      + `A != 0 in ${rep.bad.length} views.`, '');
  }
  writeFileSync(join(out, 'report.md'), lines.join('\n'));
}

export function build({ out = OUT, disk = true, blitz = false, budgetStep = null, quiet = false } = {}) {
  const log = quiet ? () => {} : (s) => console.log(s);
  mkdirSync(out, { recursive: true });
  const files = buildFiles(out, log);       // assets: JS tools only (Node is enough, e.g. for the editors' live view)
  const L = layout(files);
  checkBas(L, join(HERE, 'demo.bas'));
  writeFileSync(join(out, 'layout.json'), pyJson(L, 1));
  log(`VRAM pool: ${L.pool_end - POOL[0]} of ${POOL[1] - POOL[0]} bytes used, free ${POOL[1] - L.pool_end}`);
  const rep = budgetStep ? budget(out, budgetStep, log) : null;
  if (rep && rep.bad.length) throw new BuildError(`Budget: ${rep.bad.length} views with A != 0, first: ${rep.badRepr(rep.bad[0])}`);
  report(out, L, files, rep, []);
  if (disk) {
    engineBuild();                          // stub and lib for the disk (cc65)
    const boot = bootPrg(out);
    const prog = program(out);
    makeDisk(join(out, 'dbe-demo.d81'), files, prog, boot);
    makeDisk(join(out, 'dbe-demo.d64'), files, prog, boot);
    log(`${out}/dbe-demo.d81, .d64 (${statSync(prog).size - 2} bytes program)`);
    if (blitz) {
      const cp = program(out, { compiled: true, tag: '-c' });
      if (cp === null) log('Blitz! version: SKIP (node or blitzc not found)');
      else {
        makeDisk(join(out, 'dbe-demo-blitz.d81'), files, cp, boot);
        log(`${out}/dbe-demo-blitz.d81 (${statSync(cp).size - 2} bytes program)`);
      }
    }
  }
  return [files, L];
}

/** argparse of build.py: --out DIR, --no-disk, --blitz, --budget [N] (default 30), -q/--quiet. */
export function parseArgs(argv) {
  const a = { out: OUT, disk: true, blitz: false, budgetStep: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--out') {
      if (i + 1 >= argv.length) throw new BuildError('argument --out: expected one argument');
      a.out = argv[++i];
    } else if (x.startsWith('--out=')) a.out = x.slice(6);
    else if (x === '--no-disk') a.disk = false;
    else if (x === '--blitz') a.blitz = true;
    else if (x === '-q' || x === '--quiet') a.quiet = true;
    else if (x === '--budget') {
      if (i + 1 < argv.length && /^[+-]?\d+$/.test(argv[i + 1])) a.budgetStep = parseInt(argv[++i], 10);
      else a.budgetStep = 30;
    } else if (x.startsWith('--budget=')) a.budgetStep = parseInt(x.slice(9), 10);
    else throw new BuildError(`unrecognized arguments: ${x}`);
  }
  return a;
}

export function main(argv) {
  try {
    build(parseArgs(argv));
    return 0;
  } catch (e) {
    if (e instanceof BuildError) { process.stderr.write(e.message + '\n'); return 1; }
    throw e;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
