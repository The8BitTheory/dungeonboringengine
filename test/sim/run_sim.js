#!/usr/bin/env node
// sim65 scaffold for the lib (docs/specs/P6-engine.md 9.2). Port of test/sim/run_sim.py onto tools/js/core.
//
// Usage:   node test/sim/run_sim.js          builds the harness and runs the tests of the substeps (P6a, P6c, P6d, P6e,
//                                            P6f, P6l; P6d, P6e, P6l twice: standard build (untrimmed VMS lists as type 9)
//                                            and build switch VMS_COPY)
//          Environment: DBEVIEW_FULL=1 full random set (200 x 20), DBE_NOCYCLES=1 without cycle measurement
//          node test/sim/run_sim.js --build  build only
//
// Building blocks (exported, used by test/sim/run_crawl.js and test/vice_view.js):
//   Scene            build a scene (segments, calls, readbacks) and encode it as a scene file
//   Call             call record of the result file
//   build()          cl65: viewsim.c + glue.s + engine/lib.s (--asm-define SIM) -> build/sim/viewsim.prg + labels
//   labels()         {name: address} of build/sim/viewsim.lbl
//   run(scene, prg)  run sim65, read the result file -> {items, cycles}
//   decodeVcl(buf)   split a VCL list into entries; firstDiff(a, b) -> text of the first differing position
//   ViewRunner       scene file from view.js scenes, every VIEW reply compared byte for byte with view()
//   timeView(r, sc)  cycles of one VIEW (run with VIEW minus run with F = 7)
// Format of the scene and result file: header of viewsim.c.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../../tools/js/core/view.js';
import * as M from '../../tools/js/core/map.js';
import * as tex from '../../tools/js/core/tex.js';
import * as spr from '../../tools/js/core/spr.js';
import { move as dbemove } from '../../tools/js/core/move.js';
import { PyRandom } from '../../tools/js/core/pyrandom.js';
import { demoAssets, loadMap } from '../lib/assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT = join(ROOT, 'build', 'sim');
export const PRG = join(OUT, 'viewsim.prg');
export const LBL = join(OUT, 'viewsim.lbl');
export const PRGC = join(OUT, 'viewsimc.prg');      // build switch VMS_COPY (untrimmed VMS lists into the buffer)
export const PRGM = join(OUT, 'viewsimm.prg');      // test only: MAXITEM = 8 (abort via the entry count)

// ------------------------------------------------------------------ small Python-compatible helpers
export const range = (a, b, s = 1) => {
  if (b === undefined) { b = a; a = 0; }
  const out = [];
  for (let i = a; s > 0 ? i < b : i > b; i += s) out.push(i);
  return out;
};
const zeros = (n) => new Array(n).fill(0);
const every = (a, s) => a.filter((_, i) => i % s === 0);         // a[::s]
const sum = (a) => a.reduce((x, y) => x + y, 0);
const fdiv = (a, b) => Math.floor(a / b);
export const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const s8 = (b) => (b > 127 ? b - 256 : b);
export const hexs = (b) => Buffer.from(b).toString('hex');
export const bytesEq = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length)
  .equals(Buffer.from(b.buffer, b.byteOffset, b.length));
const cat = (...parts) => {
  const n = sum(parts.map((p) => p.length));
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const U8 = (a) => Uint8Array.from(a);
const pk16 = (...vals) => {
  const out = new Uint8Array(2 * vals.length);
  vals.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) throw new RangeError("'H' format requires 0 <= number <= 65535");
    out[2 * i] = v & 255; out[2 * i + 1] = v >> 8;
  });
  return out;
};
const pk8 = (...vals) => {
  for (const v of vals) if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError('byte must be in range(0, 256)');
  return U8(vals);
};
/** Python repr of numbers, booleans, null, strings, arrays (as tuples) and byte arrays. */
export function pyr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return `'${v}'`;
  if (v instanceof Uint8Array) return `b'${Array.from(v, (c) => (c >= 32 && c < 127 && c !== 39 && c !== 92 ? String.fromCharCode(c) : '\\x' + c.toString(16).padStart(2, '0'))).join('')}'`;
  if (Array.isArray(v)) return v.length === 1 ? `(${pyr(v[0])},)` : `(${v.map(pyr).join(', ')})`;
  return String(v);
}
const pyList = (a) => `[${a.map(pyr).join(', ')}]`;
/** dict(sorted(codes.items())) of integer keys */
export const pyDict = (o) => `{${Object.keys(o).map(Number).sort((a, b) => a - b).map((k) => `${k}: ${o[k]}`).join(', ')}}`;
const hexp = (v) => '0x' + v.toString(16);
const tupEq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
function norm(v) {
  if (v instanceof Uint8Array) return { b: hexs(v) };
  if (Array.isArray(v)) return v.map(norm);
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

// ------------------------------------------------------------------ scene file, build, run
export class Call {
  constructor(f, a, x, y, p, pb, buf) { Object.assign(this, { f, a, x, y, p, pb, buf }); }   // p: 4 words, pb: 10 bytes $0C08-$0C11
}

export class Scene {
  constructor(b = null) { this.parts = [U8([0x44, 0x42, 0x53, 0x31])]; if (b) this.parts = [U8(b)]; }

  /** Bytes so far (without the end record). */
  get b() { return cat(...this.parts); }

  /** Copy (Python: Scene(); s.b = bytearray(base)). */
  clone() { const s = new Scene(); s.parts = this.parts.slice(); return s; }

  seg(addr, data) {
    data = U8(data);
    this.parts.push(cat(pk8(1), pk16(addr, data.length)), data);
    return this;
  }

  call(f, x = 0, y = 0, { p = [0, 0, 0, 0], itemph = 0, objn = 0, objl = new Uint8Array(0), quiet = false } = {}) {
    this.parts.push(cat(pk8(quiet ? 4 : 2, f, x, y), pk16(...p), pk8(itemph, objn, objl.length)), U8(objl));
    return this;
  }

  dump(addr, n) {
    this.parts.push(cat(pk8(3), pk16(addr, n)));
    return this;
  }

  encode() { return cat(...this.parts, U8([0])); }
}

const NODE_TMP = mkdtempSync(join(tmpdir(), 'dbesim-'));
process.on('exit', () => rmSync(NODE_TMP, { recursive: true, force: true }));
let tmpN = 0;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: exit code ${r.status}`);
  return r;
}

export function build() {
  mkdirSync(OUT, { recursive: true });
  const src = [join(HERE, 'viewsim.c'), join(HERE, 'glue.s'), join(ROOT, 'engine', 'lib.s')];
  for (const [prg, lbl, defs, cfg] of [[PRG, LBL, [], 'sim.cfg'],
    [PRGC, join(OUT, 'viewsimc.lbl'), ['--asm-define', 'VMS_COPY'], 'simc.cfg'],
    [PRGM, join(OUT, 'viewsimm.lbl'), ['--asm-define', 'MAXITEM_T=8'], 'sim.cfg']]) {
    sh('cl65', ['-t', 'sim6502', '-g', '-C', join(HERE, cfg), '-O', '--asm-define', 'SIM', ...defs,
      '--asm-include-dir', join(ROOT, 'engine'), '-Ln', lbl, '-m', prg.replace(/\.prg$/, '.map'), '-o', prg, ...src], { cwd: OUT });
  }
  for (const s of src) {                 // older cl65 versions leave object files next to the sources
    const o = s.replace(/\.[^.]+$/, '.o');
    if (existsSync(o)) rmSync(o);
  }
}

/** ld65 -Ln: 'al 00E000 .name' -> {name: address} */
export function labels(lbl = LBL) {
  const d = {};
  for (const line of readFileSync(lbl, 'latin1').split('\n')) {
    const m = /^al ([0-9A-Fa-f]+) \.(\S+)/.exec(line);
    if (m) d[m[2]] = parseInt(m[1], 16);
  }
  return d;
}

/** Runs sim65 on the scene; returns {items: [Call | [addr, bytes]], cycles}. */
export function run(scene, prg = PRG) {
  const n = tmpN++;
  const sc = join(NODE_TMP, `scene${n}`), rs = join(NODE_TMP, `result${n}`);
  writeFileSync(sc, scene.encode());
  const r = spawnSync('sim65', ['-c', prg, sc, rs], { encoding: 'utf8', timeout: 300000 });   // guard against hangs
  if (r.error) throw r.error;
  if (r.status) throw new Error(`sim65 Exitcode ${r.status}: ${r.stdout}${r.stderr}`);
  const cyc = parseInt(/(\d+) cycles/.exec(r.stdout + r.stderr)[1], 10);
  const d = new Uint8Array(readFileSync(rs));
  rmSync(sc); rmSync(rs);
  if (!(d[0] === 0x44 && d[1] === 0x42 && d[2] === 0x52 && d[3] === 0x31)) throw new Error('result file: magic');
  let i = 4;
  const items = [];
  while (i < d.length) {
    const t = d[i];
    if (t === 0x43) {
      const [f, a, x, y] = d.subarray(i + 1, i + 5);
      const p = [0, 1, 2, 3].map((k) => u16(d, i + 5 + 2 * k));
      const pb = d.slice(i + 13, i + 23);
      const bl = u16(d, i + 23);
      items.push(new Call(f, a, x, y, p, pb, d.slice(i + 25, i + 25 + bl)));
      i += 25 + bl;
    } else if (t === 0x44) {
      const addr = u16(d, i + 1), nn = u16(d, i + 3);
      items.push([addr, d.slice(i + 5, i + 5 + nn)]);
      i += 5 + nn;
    } else throw new Error(`result file: record ${t} at ${i}`);
  }
  return { items, cycles: cyc };
}

export const VCL_LEN = { 0: 1, 2: 11, 3: 13, 4: 7, 5: 11, 9: 7, 12: 7 };     // P6 section 6

/** -> list [offset, type, bytes]; stops at an unknown type with one entry. */
export function decodeVcl(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const t = buf[i];
    const n = VCL_LEN[t];
    if (n === undefined || i + n > buf.length) { out.push([i, t, buf.slice(i)]); break; }
    out.push([i, t, buf.slice(i, i + n)]);
    i += n;
    if (t === 0) break;
  }
  return out;
}

export function firstDiff(a, b) {
  const ea = decodeVcl(a), eb = decodeVcl(b);
  const fmt = (x) => (x ? `(${x[1]}, '${hexs(x[2])}')` : 'None');
  for (let k = 0; k < Math.max(ea.length, eb.length); k++) {
    const x = ea[k], y = eb[k];
    if (!x || !y || x[0] !== y[0] || x[1] !== y[1] || !bytesEq(x[2], y[2])) return `entry ${k}: sim ${fmt(x)} <> reference ${fmt(y)}`;
  }
  return bytesEq(a, b) ? null : 'VCL equal, VMS bytes differ';
}

const isCall = (it) => it instanceof Call;

// ------------------------------------------------------------------ P6a: INIT, BUFSET, POOLSET, dispatcher
function testP6a() {
  const L = labels();
  const bss = L.bss_start, bssEnd = L.bss_end, codeEnd = L.code_end;
  const fails = [];
  const check = (name, cond, info = '') => { if (!cond) fails.push(`${name} ${info}`); };
  const vr = (d, name, n = 2) => { const o = L[name] - bss; return n === 1 ? d[o] : d[o] | (d[o + 1] << 8); };
  const n = bssEnd - bss;
  const s = new Scene();
  s.seg(bss, new Uint8Array(n).fill(0xAA)).seg(0x0C08, new Uint8Array(10).fill(0x55));       // 0: dirty state
  s.call(0, 0, 0, { objn: 5 });                                                              // INIT
  s.dump(bss, n).dump(0x0C08, 10).dump(0x0C50, 1);
  for (const f of [17, 18, 255, 7, 8, 4, 3]) s.call(f);                                       // not implemented
  const bs = (x, p0, p1) => s.call(15, x, 0, { p: [p0, p1, 0, 0] }).dump(bss, n);
  bs(0, 0x1300, 0x1C00);              // BUFSET ok, default
  bs(0, 0x1300, 0x1340);              // exactly 64 bytes ok
  bs(0, 0x1400, 0x143F);              // 63 bytes: 6, unchanged
  bs(0, 0x12FF, 0x1800);              // start < $1300 (window)
  bs(0, 0x1400, 0x1C01);              // end > $1C00
  bs(0, 0x1600, 0x1400);              // end < start
  bs(0, 0x1400, 0x1400);              // length 0
  bs(0, 0x0200, 0x0240);              // $0200: 6 (Kernal vectors)
  bs(0, 0x1B00, 0x1C00);              // ok, 256 bytes at the end
  bs(1, 0x1300, 0x1C00);              // P6j: X bit 0 = fixed list address
  bs(3, 0x1400, 0x1C01);              // error: mode is kept
  bs(2, 0x1B00, 0x1C00);              // X bit 0 = 0: off (bit 1 irrelevant)
  const ps = (p0, p1) => s.call(11, 0, 0, { p: [p0, p1, 0, 0] }).dump(bss, n);
  ps(0, 0); ps(0x7000, 0x9000); ps(0x9000, 0x7000); ps(0x7000, 0x7000); ps(0x7000, 0); ps(0, 0x100); ps(0, 0);
  s.call(0).dump(bss, n);                                                                    // INIT resets everything
  const r = run(s);
  let idx = 0;
  const nxt = () => r.items[idx++];

  let c = nxt(); let d = nxt()[1]; const pb = nxt()[1]; const objn = nxt()[1];
  check('INIT A/X/Y', c.a === 0 && c.x === 3 && c.y === 0, pyr([c.a, c.x, c.y]));
  check('INIT P0 = code end', c.p[0] === codeEnd, `${c.p[0].toString(16).padStart(4, '0')} <> ${codeEnd.toString(16).padStart(4, '0')}`);
  check('INIT P1 = BSS end', c.p[1] === bssEnd, `${c.p[1].toString(16).padStart(4, '0')} <> ${bssEnd.toString(16).padStart(4, '0')}`);
  check('INIT buffer', vr(d, 'buf_b0') === 0x1300 && vr(d, 'buf_b1') === 0x1C00);
  check('INIT pool off', vr(d, 'pool_on', 1) === 0 && vr(d, 'pool_a') === 0 && vr(d, 'pool_b') === 0);
  const o0 = L.buf_b0 - bss;
  check('INIT clears all variables except the buffer', Array.from(d).every((v, i) => v === 0 || (o0 <= i && i < o0 + 4)));
  check('INIT parameter block $0C08-$0C11', bytesEq(pb, U8([0, 0, 0, 0x13, 0, 0, 0, 0, 0, 0])), hexs(pb));   // only VCLADR = $1300
  check('INIT OBJN = 0', objn.length === 1 && objn[0] === 0);
  for (const f of [17, 18, 255, 7, 8, 4, 3]) {
    c = nxt();
    const want = f === 3 || f === 4 ? [5, 0, 0] : [255, 0, 0];   // VIEW/MOVE without GEOMSET/MAPINIT: E_STATE (MOVE since P6f)
    check(`F=${f} ${f === 3 || f === 4 ? 'E_STATE' : 'E_NOTIMPL'}`, tupEq([c.a, c.x, c.y], want), pyr([c.a, c.x, c.y]));
  }
  const bufcase = (name, wantA, wantBuf) => {
    c = nxt(); d = nxt()[1];
    check(`BUFSET ${name} A`, c.a === wantA, `${c.a} <> ${wantA}`);
    const got = [vr(d, 'buf_b0'), vr(d, 'buf_b1')];
    check(`BUFSET ${name} buffer`, tupEq(got, wantBuf), `${got[0].toString(16).padStart(4, '0')},${got[1].toString(16).padStart(4, '0')} <> ` + pyr(wantBuf));
  };
  let cur = [0x1300, 0x1C00];
  for (const [name, a, newbuf] of [['Default', 0, [0x1300, 0x1C00]], ['64 bytes', 0, [0x1300, 0x1340]],
    ['63 bytes', 6, null], ['Start < $1300', 6, null], ['End > $1C00', 6, null], ['End < start', 6, null],
    ['Length 0', 6, null], ['$0200', 6, null], ['256 bytes at the end', 0, [0x1B00, 0x1C00]]]) {
    const want = newbuf || cur;
    bufcase(name, a, want);
    cur = want;
  }
  for (const [name, a, want, fix] of [['X = 1', 0, [0x1300, 0x1C00], 0x80], ['X = 3, error', 6, [0x1300, 0x1C00], 0x80],
    ['X = 2', 0, [0x1B00, 0x1C00], 0]]) {
    c = nxt(); d = nxt()[1];
    check(`BUFSET ${name} A`, c.a === a, `${c.a} <> ${a}`);
    check(`BUFSET ${name} buffer`, tupEq([vr(d, 'buf_b0'), vr(d, 'buf_b1')], want));
    check(`BUFSET ${name} buf_fix`, (vr(d, 'buf_fix', 1) & 0x80) === fix, vr(d, 'buf_fix', 1).toString(16).padStart(2, '0'));
    cur = want;
  }
  const poolcase = (name, wantA, want) => {
    c = nxt(); d = nxt()[1];
    const got = [vr(d, 'pool_on', 1), vr(d, 'pool_a'), vr(d, 'pool_b')];
    check(`POOLSET ${name} A`, c.a === wantA, `${c.a} <> ${wantA}`);
    check(`POOLSET ${name} state`, tupEq(got, want), pyr(got) + ' <> ' + pyr(want));
    check(`POOLSET ${name} buffer unchanged`, tupEq([vr(d, 'buf_b0'), vr(d, 'buf_b1')], cur));
  };
  let pool = [0, 0, 0];
  for (const [name, a, want] of [['off', 0, [0, 0, 0]], ['$7000-$9000', 0, [1, 0x7000, 0x9000]], ['End < start', 6, null],
    ['empty', 6, null], ['up to 65536', 0, [1, 0x7000, 0]], ['from 0', 0, [1, 0, 0x100]], ['off again', 0, null]]) {
    const w = want || pool;
    if (name === 'off again') {          // pool_on = 0, limits are left untouched (irrelevant)
      c = nxt(); d = nxt()[1];
      check('POOLSET off again', c.a === 0 && vr(d, 'pool_on', 1) === 0);
      continue;
    }
    poolcase(name, a, w);
    pool = w;
  }
  c = nxt(); d = nxt()[1];
  check('INIT again A/X', c.a === 0 && c.x === 3);
  check('INIT again: variables cleared and default', tupEq([vr(d, 'buf_b0'), vr(d, 'buf_b1'), vr(d, 'pool_on', 1),
    vr(d, 'pool_a'), vr(d, 'pool_b')], [0x1300, 0x1C00, 0, 0, 0]));
  for (const f of fails) console.log('FAIL', f);
  console.log(`P6a sim: ${!fails.length ? 'ok' : fails.length + ' errors'}  (total cycles ${r.cycles})`);
  return !fails.length;
}

// ------------------------------------------------------------------ P6c: map and assets
export const DEMO_MAP = join(ROOT, 'docs', 'specs', 'examples', 'demo.toml');
const HDR = 0x1400;             // space for header copies with deliberate errors (shared RAM)
const HDR2 = 0xA700;            // header copies that must be valid (S2 and DTS from $4000 because of VCL type 9; free in P6c)

/** BSS dump of the lib, access via the labels. */
export class Bss {
  constructor(d, L) { this.d = d; this.L = L; this.o = L.bss_start; }
  at(name, off = 0) { return this.L[name] - this.o + off; }
  b(name, off = 0) { return this.d[this.at(name, off)]; }
  w(name, off = 0) { const i = this.at(name, off); return this.d[i] | (this.d[i + 1] << 8); }
  raw(name, n, off = 0) { const i = this.at(name, off); return this.d.slice(i, i + n); }
}

/** Sequence of calls, each with a BSS dump; checks run after the sim65 run. */
export class Seq {
  constructor(L) {
    this.L = L;
    this.n = L.bss_end - L.bss_start;
    this.scene = new Scene();
    this.steps = [];
    this.fails = [];
  }

  seg(addr, data) { this.scene.seg(addr, data); }

  /** BSS without argx/argy and intermediate values (t0 ... val) */
  stable(d) {
    d = Uint8Array.from(d);
    const o = this.L.bss_start;
    const x = this.L.argx - o;
    d.fill(0, x, x + 2);
    d.fill(0, this.L.t0 - o, this.L.val + 2 - o);
    return d;
  }

  /** a/rx/ry: expected return value (rx, ry null = do not check); rp: expected P0..P3 (null = do not check);
   *  same: BSS unchanged compared with the previous step; check(bss): further check (list of error texts). */
  call(name, f, { x = 0, y = 0, p = [0, 0, 0, 0], pre = [], a = 0, rx = null, ry = null, rp = null, check = null, same = false,
    objn = 0, dump = [] } = {}) {
    for (const [addr, data] of pre) this.scene.seg(addr, data);
    this.scene.call(f, x, y, { p, objn });
    this.scene.dump(this.L.bss_start, this.n);
    for (const [addr, n] of dump) this.scene.dump(addr, n);
    this.steps.push({ name, a, rx, ry, rp, check, same, nd: dump.length });
  }

  run() {
    const r = run(this.scene);
    let k = 0;
    let prev = null;
    for (const { name, a, rx, ry, rp, check, same, nd } of this.steps) {
      const c = r.items[k++];
      const d = r.items[k++][1];
      const extra = [];
      for (let j = 0; j < nd; j++) extra.push(r.items[k++][1]);
      const bss = new Bss(d, this.L);
      bss.extra = extra;
      bss.call = c;
      if (c.a !== a) this.fails.push(`${name}: A = ${c.a}, erwartet ${a}`);
      if (rx !== null && c.x !== rx) this.fails.push(`${name}: X = ${c.x}, erwartet ${rx}`);
      if (ry !== null && c.y !== ry) this.fails.push(`${name}: Y = ${c.y}, erwartet ${ry}`);
      if (rp !== null && !tupEq(c.p.slice(0, rp.length), rp)) {
        this.fails.push(`${name}: P = ${pyList(c.p.map(hexp))}, erwartet ${pyList(rp.map(hexp))}`);
      }
      if (same && prev !== null) {
        const s1 = this.stable(d), s0 = this.stable(prev);
        if (!bytesEq(s1, s0)) {
          const diff = range(d.length).filter((i) => s1[i] !== s0[i]).slice(0, 6);
          this.fails.push(`${name}: BSS changed (offsets [${diff.join(', ')}])`);
        }
      }
      if (check) for (const msg of check(bss) || []) this.fails.push(`${name}: ${msg}`);
      prev = d;
    }
    return r.cycles;
  }
}

/** Header copy (n bytes) with changes [offset, value(, length)]; value > 255 -> word */
export function patched(data, edits, n = 40) {
  const h = Uint8Array.from(data.subarray(0, n));
  for (const e of edits) {
    const [off, val] = e;
    const ln = e.length > 2 ? e[2] : (val > 255 ? 2 : 1);
    if (val >= 2 ** (8 * ln)) throw new RangeError('int too big to convert');
    for (let i = 0; i < ln; i++) h[off + i] = Math.floor(val / 2 ** (8 * i)) & 255;
  }
  return h;
}

const free = (m) => range(m.cells.length).filter((i) => !(m.tiles[m.cells[i]].flags & V.T_SOLID));
const copyBases = (vb) => ({ dts: vb.dts.slice(), dbg: vb.dbg, s2: vb.s2.slice() });

/** GEOMSET checks the element table (P6d-opt, section 7): error cases A = 1 and no valid geometry
 *  (geom_ok = 0), boundary cases A = 0; view.js parseDvg throws ViewError in the same cases. */
function testGeomcheck() {
  const L = labels();
  const A = demoAssets();
  const base = V.dvgBytes(A.dvg).slice(2);
  const A2 = V.doubleFronts(A);
  const base2 = V.dvgBytes(V.withoutBandCover(A2.dvg)).slice(2);   // depth 3: exactly 16 occluding sides/fronts without bit 3

  const el = (data, i, off, val) => {
    const d = Uint8Array.from(data);
    d[24 + 8 * (d[5] + 1) + 16 * i + off] = val & 255;
    return d;
  };
  const depth3Ceil = (data) => {                   // a ceiling element of depth 3 as an occluding side
    const d = Uint8Array.from(data);
    const oE = 24 + 8 * (d[5] + 1);
    const f3 = d[24 + 8 * 3 + 4], n3 = d[24 + 8 * 3 + 5];
    for (let i = f3; i < f3 + n3; i++) {
      if (d[oE + 16 * i] === 3) {
        d[oE + 16 * i] = 1;
        d[oE + 16 * i + 3] = 1;
        d[oE + 16 * i + 12] = d[oE + 16 * i + 13] = 0;
        return d;
      }
    }
    throw new Error('AssertionError');
  };
  // synthetic geometries via V.Dvg (reassemble cells per depth, recompute first/n)
  const rebuild = (fn, S = null) => {
    const g = A.dvg.clone();
    let cells = range(g.D + 1).map((d) => V.Ctx.prototype.cellsOf.call({ g }, d));
    cells = cells.map((c) => c.map(([s, es]) => [s, es.slice()]));
    fn(g, cells);
    const elems = [];
    cells.forEach((c, d) => {
      g.depth[d].first = elems.length;
      g.depth[d].n = sum(c.map(([, es]) => es.length));
      for (const [s, es] of c) {
        for (const e of es) {
          const e2 = e.clone();
          e2.d = d; e2.s = s;
          elems.push(e2);
        }
      }
    });
    g.elems = elems;
    if (S !== null) g.S = S;
    return V.dvgBytes(g).slice(2);
  };
  const protoObj = A.dvg.elems.find((e) => e.art === 4);
  const protoSide = A.dvg.elems.find((e) => e.art === 1).clone();
  protoSide.flags = 0;                             // not occluding: no waiting area
  const protoCeil = A.dvg.elems.find((e) => e.art === 3);
  const padCell = (n) => (g, cells) => {          // pad cell (1, -1) with object slots up to n elements
    const es = cells[1].find(([s]) => s === -1)[1];
    while (es.length < n) es.push(protoObj.clone());
  };
  const moreCells = (ncell, nwall) => (g, cells) => {   // new cells (S = 15) with object slot and walls
    const have = sum(cells.map((c) => c.length));
    let walls = 0;
    for (const c of cells) for (const [, es] of c) for (const e of es) if (e.art < 2) walls++;
    const freeC = [];
    for (const d of [3, 2, 1]) {
      for (const s of [...range(4, 16), ...range(-15, -3)]) if (cells[d].every(([t]) => s !== t)) freeC.push([d, s]);
    }
    for (let k = 0; k < ncell - have; k++) {
      const [d, s] = freeC[k];
      cells[d].push([s, [protoObj.clone()]]);
    }
    let k = 0;
    while (walls < nwall) {
      const [d, s] = freeC[fdiv(k, 15)];
      cells[d].find(([t]) => t === s)[1].push(protoSide.clone());
      walls++;
      k++;
    }
  };
  const twoCeils = (g, cells) => {
    cells[2].find(([, es]) => es.some((e) => e.art === 3))[1].push(protoCeil.clone());
  };
  const nd = base[5];
  const cases = [
    ['16 elements in one cell', rebuild(padCell(16)), 0],
    ['17 elements in one cell', rebuild(padCell(17)), 1],
    ['48 cells', rebuild(moreCells(48, 0), 15), 0],
    ['49 cells', rebuild(moreCells(49, 0), 15), 1],
    ['96 walls', rebuild(moreCells(30, 96), 15), 0],
    ['97 walls', rebuild(moreCells(30, 97), 15), 1],
    ['two ceiling elements', rebuild(twoCeils), 1],
    ['demo', base, 0], ['two fronts (16 waiting)', base2, 0],
    ['17 waiting at depth 3', depth3Ceil(base2), 1],
    ['cell not contiguous', el(base, 12, 2, 1), 1],
    ['two floor elements', el(base, 13, 0, 2), 1],
    ['x + w > VW', el(base, 11, 4, 30), 1],
    ['c1 > VW', el(base, 11, 13, 71), 1],
    ['c0 > c1', el(base, 11, 12, 61), 1],
    ['y + h > VH', el(base, 11, 5, 30), 1],
    ['|s| > S', el(base, 3, 2, -4), 1],
    ['Art 5', el(base, 2, 0, 5), 1],
    ['first + n > NE', cat(base.subarray(0, 24 + 8 * nd + 5), U8([base[24 + 8 * nd + 5] + 1]), base.subarray(24 + 8 * nd + 6)), 1],
  ];
  const S = new Seq(L);
  const GP = { p: [0xE800, 0xFFFF, 0, 0] };
  S.call('INIT', 0, { a: 0 });
  S.call('GEOMSET demo', 12, { ...GP, pre: [[0xE800, base]], a: 0 });
  const fails = [];
  for (const [name, data, a] of cases) {
    S.call(`GEOMSET ${name}`, 12, { ...GP, pre: [[0xE800, data]], a, check: (b) => (b.b('geom_ok') === (a === 0 ? 1 : 0) ? [] : ['geom_ok']) });
    let py;
    try {
      V.parseDvg(data, false);
      py = 0;
    } catch (e) {
      if (!(e instanceof V.ViewError)) throw e;
      py = 1;
    }
    if (py !== a) fails.push(`parse_dvg ${name}: ViewError ${pyr(!!py)}, erwartet ${pyr(!!a)}`);
    if (!a) S.call(`GEOMSET ${name} back`, 12, { ...GP, pre: [[0xE800, base]], a: 0 });
  }
  // VIEW after failed GEOMSET: A = 5 (no valid geometry), 0 again after a valid one
  const dmp = M.toDmp(loadMap(DEMO_MAP)).slice(2);
  S.call('GEOMSET demo', 12, { ...GP, pre: [[0xE800, base]], a: 0 });
  S.call('MAPINIT', 1, { p: [0x5000, 0, 0, 0], pre: [[0x5000, dmp]], a: 0 });
  S.call('VIEW valid', 4, { a: 0 });
  S.call('GEOMSET 17 elements', 12, { ...GP, pre: [[0xE800, rebuild(padCell(17))]], a: 1 });
  S.call('VIEW after failed GEOMSET', 4, { a: 5 });
  S.call('GEOMSET demo again', 12, { ...GP, pre: [[0xE800, base]], a: 0 });
  S.call('VIEW valid again', 4, { a: 0 });
  S.run();
  fails.push(...S.fails);
  for (const f of fails) console.log('FAIL', f);
  console.log(`GEOMSET checks: ${cases.length} cases + VIEW after error, ${fails.length} errors`);
  return !fails.length;
}

function testP6c() {
  const L = labels();
  const fails = [];
  const A = demoAssets();

  // ---- Data at their bank 1 addresses (2.4)
  // sim65: lib code at $B000 as on the C128; the demo DTS are larger than the areas of map 2.4 (sim.cfg):
  // DVG $E800, ceiling from $EE00 (3.2 KB instead of 1.25 KB, ends before DBG), DBG $FB80 (default); everything below $FC00 (runtime)
  const ADDR = { dmp: 0x5000, dvg: 0xE800, wall: 0x6000, floor: 0x8300, ceil: 0xEE00, dbg: 0xFB80, bigmap: 0x2E00 };
  const S2A = [0x4000, 0x5040, 0x5340, 0x5840];   // type 9: S2 from $4000 (SPRITESET checks); the DMP loads scene B only ($5000)
  const dvg = A.dvgPrg.slice(2);
  const dts = [A.walls, A.floor, A.ceil].map((t) => tex.toDts(t).slice(2));
  const dtsa = [ADDR.wall, ADDR.floor, ADDR.ceil];
  const dbg = A.dbgPrg.slice(2);
  const s2 = A.sprites.slice(0, 4).map((x) => spr.toS2(x).slice(2));
  const gidDvg = u16(dvg, 12);
  for (const k of [0, 2]) s2[k] = patched(s2[k], [[4, gidDvg]], s2[k].length);   // records 0 and 2 with geometry ID, 1 and 3 with ID 0
  const m = loadMap(DEMO_MAP);
  const dmp = M.toDmp(m).slice(2);
  const W = m.width, H = m.height, NT = m.tiles.length;
  if (!(u16(dvg, 12) && dvg[5] === 3 && dbg[5] === dvg[12] && dbg[6] === dvg[13])) throw new Error('AssertionError');

  const baseSegs = (s) => {
    s.seg(ADDR.dvg, dvg);
    for (let k = 0; k < 3; k++) s.seg(dtsa[k], dts[k]);
    s.seg(ADDR.dbg, dbg);
    for (let k = 0; k < 4; k++) s.seg(S2A[k], s2[k]);
  };

  // ================================================================ scene A: geometry and assets
  const S = new Seq(L);
  baseSegs(S.scene);
  const GD = ADDR.dvg, TD = dtsa, DB = ADDR.dbg;
  const VR = [0x0000, 0x4000, 0x8000];      // VRAM bases
  const P = (...a) => [...a, 0, 0, 0, 0].slice(0, 4);
  S.call('INIT', 0, { a: 0, rx: 3 });
  // order: without map / without geometry
  for (const [nm, f, x] of [['CELL', 5, 0], ['SETPOS', 2, 0], ['SETCELL', 6, 0], ['SETITEM', 16, 0]]) {
    S.call(`${nm} without MAPINIT`, f, { x, a: 5, rx: 0, ry: 0, same: true });
  }
  S.call('TEXSET without GEOMSET', 13, { x: 0, p: P(TD[0], VR[0]), a: 5, same: true });
  S.call('BGSET without GEOMSET', 14, { x: 0x22, p: P(DB), a: 5, check: (b) => (b.b('bgfill') === 0x22 ? [] : ['bgfill']) });
  S.call('SPRITESET without GEOMSET', 9, { x: 0, p: P(S2A[0]), a: 5, same: true });
  S.call('TEXSET clear without GEOMSET', 13, { x: 2, a: 0, same: true });
  S.call('BGSET no wallpaper', 14, { x: 0x44, a: 0, check: (b) => (b.b('bgfill') === 0x44 && b.b('dbg_ok') === 0 ? [] : ['bgfill/dbg_ok']) });
  S.call('SPRITESET clear', 9, { x: 7, a: 0 });
  S.call('SPRITESET record 8', 9, { x: 8, p: P(S2A[0]), a: 6 });
  S.call('TEXSET Art 3', 13, { x: 3, p: P(TD[0]), a: 6 });
  // GEOMSET: format errors
  const gerr = [['Magic', [0, 0x58]], ['Version', [2, 2]], ['Element length', [16, 15]], ['Depth entry', [17, 7]],
    ['VW 81', [3, 81]], ['VW 0', [3, 0]], ['VH 101', [4, 101]], ['VH 0', [4, 0]], ['D 8', [5, 8]],
    ['NE 0', [7, 0]], ['S 16', [6, 16]]];
  for (const [nm, e] of gerr) S.call(`GEOMSET ${nm}`, 12, { p: P(HDR, 0xFFFF), pre: [[HDR, patched(dvg, [e])]], a: 1, same: true });
  S.call('TEXSET after GEOMSET error', 13, { x: 0, p: P(TD[0]), a: 5, same: true });

  const geomCheck = (src, origin, dvgaddr) => (b) => {
    const out = [];
    const [vw, vh, D, Sx, ne] = src.subarray(3, 8);
    const stride = u16(src, 8);
    let org = u16(src, 10);
    if (origin !== 0xFFFF) org = origin;
    const got = [b.b('geom_ok'), b.raw('dvg_vw', 5), b.w('dvg_vw', 5), b.w('dvg_vw', 7), b.w('dvg_vw', 9), b.raw('dvg_vw', 2, 11)];
    const want = [1, U8([vw, vh, D, Sx, ne]), stride, org, u16(src, 12), src.slice(14, 16)];
    if (!tupEq(got, want)) out.push(`DVG state ${pyr(got)} <> ${pyr(want)}`);
    if (b.w('ptrs', 8) !== dvgaddr + u16(src, 18) || b.w('ptrs', 10) !== dvgaddr + u16(src, 20)) out.push('Depth/element table');
    const rows = pk16(...range(vh).map((y) => (org + y * stride) & 0xFFFF));
    if (!bytesEq(b.raw('rows', 200), cat(rows, new Uint8Array(200 - rows.length)))) out.push('Row table');
    const dt = u16(src, 18) + 8 * D;                // far view (5.7a): s + 15 per horizon column from the
    const first = src[dt + 4], n = src[dt + 5];     // sides of depth D (as in dbeview far_cols)
    const sides = range(first, first + n).map((j) => src.subarray(u16(src, 20) + 16 * j, u16(src, 20) + 16 * j + 8))
      .filter((e) => e[0] === 1).map((e) => [s8(e[2]), e[4], e[6]]);
    const hs = U8(range(vw).map((c) => 15 + sum(sides.map(([s, x, w]) => (s < 0 ? -(c < x + w) : +(c >= x))))));
    if (!bytesEq(b.raw('hs', vw), hs)) out.push(`hs ${hexs(b.raw('hs', vw))} <> ${hexs(hs)}`);
    return out;
  };

  S.call('GEOMSET', 12, { p: P(GD, 0xFFFF), a: 0, rx: 0, ry: 0, check: geomCheck(dvg, 0xFFFF, GD) });
  S.call('GEOMSET origin 0x1234', 12, { p: P(GD, 0x1234), a: 0, rx: 0, ry: 0, check: geomCheck(dvg, 0x1234, GD) });
  S.call('GEOMSET origin from DVG', 12, { p: P(GD, 0xFFFF), a: 0, check: geomCheck(dvg, 0xFFFF, GD) });

  // ---- TEXSET
  /** kind 'dts' | 's2': record k of the record table */
  const recCheck = (k, src, baseAddr, vram, kind) => (b) => {
    const r = b.raw('recs', 16, 16 * k);
    let want;
    if (kind === 'dts') {
      want = cat(pk8(1), pk16(vram), pk8(src[8], src[9], 0, 0, 0),
        pk16(baseAddr, baseAddr + u16(src, 12), baseAddr + u16(src, 14), baseAddr + u16(src, 16)));
    } else {
      want = cat(pk8(1), pk16(vram), pk8(src[7], src[8]), src.subarray(4, 6), pk8(0),
        pk16(baseAddr, baseAddr + u16(src, 16), baseAddr + u16(src, 18)), pk8(src[7] * dvg[5], 0));
    }
    return bytesEq(r, want) ? [] : [`Record ${k}: ${hexs(r)} <> ${hexs(want)}`];
  };
  for (let k = 0; k < 3; k++) {
    S.call(`TEXSET Art ${k}`, 13, { x: k, p: P(TD[k], VR[k]), a: 0, rx: 0, ry: 0, check: recCheck(k, dts[k], TD[k], VR[k], 'dts') });
  }
  S.call('TEXSET Art falsch', 13, { x: 1, p: P(TD[0]), a: 1, same: true });
  S.call('TEXSET below $4000', 13, { x: 0, p: P(0x3FC0, VR[0]), pre: [[0x3FC0, dts[0].subarray(0, 64)]], a: 6, same: true });
  const terr = [['Magic', 1, [1, 0x58]], ['Version', 1, [2, 2]], ['NST 0', 1, [9, 0]], ['NST 33', 1, [9, 33]], ['Art', 1, [3, 2]]];
  for (const [nm, , e] of terr) S.call(`TEXSET ${nm}`, 13, { x: 0, p: P(HDR), pre: [[HDR, patched(dts[0], [e])]], a: 1, same: true });
  const gid = u16(dts[0], 4);
  for (const [nm, e] of [['ID', [4, gid ^ 0x100]], ['NE', [6, dts[0][6] + 1]], ['D', [7, dts[0][7] + 1]],
    ['Stride', [28, u16(dts[0], 28) + 1]]]) {
    S.call(`TEXSET ${nm}`, 13, { x: 0, p: P(HDR), pre: [[HDR, patched(dts[0], [e], 32)]], a: 4, same: true });
  }
  // Pool
  const U = dts.map((t) => u16(t, 24));
  S.call('POOLSET', 11, { p: P(0x1000, 0xA000), a: 0 });
  S.call('TEXSET pool: base < start', 13, { x: 0, p: P(TD[0], 0x0FFF), a: 6, same: true });
  S.call('TEXSET pool: end exceeded', 13, { x: 0, p: P(TD[0], 0xA000 - U[0] + 1), a: 6, same: true });
  S.call('TEXSET pool: exactly at the end', 13, { x: 0, p: P(TD[0], 0xA000 - U[0]), a: 0, check: recCheck(0, dts[0], TD[0], 0xA000 - U[0], 'dts') });
  S.call('TEXSET pool: exactly at the start', 13, { x: 0, p: P(TD[0], 0x1000), a: 0, check: recCheck(0, dts[0], TD[0], 0x1000, 'dts') });
  S.call('POOLSET up to 65536', 11, { p: P(0x1000, 0), a: 0 });
  S.call('TEXSET pool 65536: exact', 13, { x: 0, p: P(TD[0], (0x10000 - U[0]) & 0xFFFF), a: 0, check: recCheck(0, dts[0], TD[0], 0x10000 - U[0], 'dts') });
  S.call('TEXSET pool 65536: overflow', 13, { x: 0, p: P(TD[0], (0x10001 - U[0]) & 0xFFFF), a: 6 });
  S.call('POOLSET off', 11, { a: 0 });
  S.call('TEXSET kind 0 again', 13, { x: 0, p: P(TD[0], VR[0]), a: 0, check: recCheck(0, dts[0], TD[0], VR[0], 'dts') });
  S.call('TEXSET clear ceiling', 13, { x: 2, a: 0, check: (b) => (b.b('recs', 32) === 0 ? [] : ['Record not cleared']) });
  S.call('TEXSET ceiling', 13, { x: 2, p: P(TD[2], VR[2]), a: 0, check: recCheck(2, dts[2], TD[2], VR[2], 'dts') });

  // ---- BGSET
  const bgCheck = (vram, fill) => (b) => {
    const want = [1, vram, DB, u16(dbg, 7), dbg[9], dbg[10], dbg[11], fill];
    const got = [b.b('dbg_ok'), b.w('dbg_vram'), b.w('dbg_base'), b.w('dbg_p'), b.b('dbg_p', 2), b.b('dbg_p', 3), b.b('dbg_p', 4), b.b('bgfill')];
    return tupEq(got, want) ? [] : [`DBG ${pyr(got)} <> ${pyr(want)}`];
  };
  S.call('BGSET', 14, { x: 0x77, p: P(DB, 0x6000), a: 0, rx: 0, ry: 0, check: bgCheck(0x6000, 0x77) });
  for (const [y, p2, want] of [[2, 0x1234, [2, 0x34]], [0, 0x5678, [0, 0x78]]]) {    // far view (5.7a): Y, P2 low
    S.call(`BGSET Distant view Y = ${y}`, 14, { x: 0x77, y, p: P(DB, 0x6000, p2), a: 0,
      check: (b) => (b.b('ffon') === want[0] && b.b('ffill') === want[1] ? [] : [`ffon/ffill <> ${pyr(want)}`]) });
  }
  for (const [nm, e, a] of [['Magic', [1, 0x58], 1], ['Version', [2, 9], 1], ['P 0', [7, 0, 2], 1], ['VW', [3, dbg[3] + 1], 4],
    ['VH', [4, dbg[4] - 1], 4], ['ID', [5, u16(dbg, 5) ^ 1], 4]]) {
    S.call(`BGSET ${nm}`, 14, { x: 0x11, p: P(HDR, 0x7000), pre: [[HDR, patched(dbg, [e], 32)]], a,
      check: (b) => (b.b('bgfill') === 0x11 && b.w('dbg_vram') === 0x6000 ? [] : ['State']) });
  }
  const Ub = u16(dbg, 20);
  S.call('POOLSET for BGSET', 11, { p: P(0x4000, 0x8000), a: 0 });
  S.call('BGSET Pool', 14, { x: 0x77, p: P(DB, 0x8000 - Ub + 1), a: 6 });
  S.call('BGSET Pool ok', 14, { x: 0x77, p: P(DB, 0x8000 - Ub), a: 0, check: bgCheck(0x8000 - Ub, 0x77) });
  S.call('POOLSET off 2', 11, { a: 0 });

  // ---- SPRITESET
  for (let k = 0; k < 4; k++) {
    S.call(`SPRITESET ${k}`, 9, { x: k, p: P(S2A[k], 0x1000 * k), a: 0, rx: 0, ry: 0, check: recCheck(3 + k, s2[k], S2A[k], 0x1000 * k, 's2') });
  }
  for (const [nm, e, a] of [['Magic', [0, 0x58], 1], ['Version', [2, 2], 1], ['NA 0', [7, 0], 1], ['NA 5', [7, 5], 1],
    ['NP 0', [8, 0], 1], ['ID', [4, u16(s2[0], 4) ^ 1], 4], ['D', [6, s2[0][6] + 1], 4], ['Stride', [34, u16(s2[0], 34) + 2], 4]]) {
    S.call(`SPRITESET ${nm}`, 9, { x: 5, p: P(HDR), pre: [[HDR, patched(s2[0], [e])]], a,
      check: (b) => (b.b('recs', 16 * 8) === 0 ? [] : ['Record 5 set']) });
  }
  S.call('POOLSET for SPRITESET', 11, { p: P(0x4000, 0x8000), a: 0 });
  const Us = u16(s2[1], 30);
  S.call('SPRITESET Pool', 9, { x: 1, p: P(S2A[1], 0x8000 - Us + 1), a: 6 });
  S.call('SPRITESET Pool ok', 9, { x: 1, p: P(S2A[1], 0x8000 - Us), a: 0, check: recCheck(4, s2[1], S2A[1], 0x8000 - Us, 's2') });
  S.call('POOLSET off 3', 11, { a: 0 });
  S.call('SPRITESET 1 again', 9, { x: 1, p: P(S2A[1], 0x1000), a: 0 });
  // record 4: ID 0, record 7: copy of record 2 (header copy, tables as addresses only)
  S.call('SPRITESET below $4000', 9, { x: 4, p: P(0x3FC0, 0x5000), pre: [[0x3FC0, patched(s2[3], [[4, 0, 2]])]], a: 6,
    check: (b) => (b.b('recs', 16 * 7) === 0 ? [] : ['Record 4 set']) });
  S.call('SPRITESET ID 0', 9, { x: 4, p: P(HDR2, 0x5000), pre: [[HDR2, patched(s2[3], [[4, 0, 2]])]], a: 0,
    check: recCheck(7, patched(s2[3], [[4, 0, 2]]), HDR2, 0x5000, 's2') });
  S.call('SPRITESET 7', 9, { x: 7, p: P(S2A[2], 0x6000), a: 0, check: recCheck(10, s2[2], S2A[2], 0x6000, 's2') });

  // ---- ITEMSET
  const itemCheck = (vals) => (b) => (bytesEq(b.raw('itemtab', 64), U8(vals)) ? [] : ['itemtab']);
  const it = zeros(64);
  S.call('ITEMSET 0,0', 10, { x: 0, y: 0, a: 0, check: itemCheck(it.slice()) });
  it[5] = 8; it[63] = 3;
  const it58 = zeros(64); it58[5] = 8;
  S.call('ITEMSET 5,8', 10, { x: 5, y: 8, a: 0, check: itemCheck(it58) });
  S.call('ITEMSET 63,3', 10, { x: 63, y: 3, a: 0, check: itemCheck(it.slice()) });
  S.call('ITEMSET 64', 10, { x: 64, y: 1, a: 6, same: true });
  S.call('ITEMSET record 9', 10, { x: 5, y: 9, a: 6, same: true });
  // ---- GEOMSET: same ID (new origin), other ID, other D / stride
  S.call('GEOMSET same ID, origin 7', 12, { p: P(GD, 7), a: 0, rx: 0, ry: 0, check: geomCheck(dvg, 7, GD) });
  S.call('Record 0 still valid after same ID', 15, { p: P(0x1300, 0x1C00), a: 0,
    check: (b) => (b.b('recs', 0) === 1 && b.b('dbg_ok') === 1 && b.b('recs', 48) === 1 ? [] : ['cleared']) });
  const dvg2 = patched(dvg, [[12, gid ^ 0x55]], dvg.length);
  S.call('GEOMSET andere ID', 12, { p: P(HDR + 0x400, 0xFFFF), pre: [[HDR + 0x400, dvg2]], a: 0, rx: 0x85, ry: 0x0F,
    check: geomCheck(dvg2, 0xFFFF, HDR + 0x400) });                                       // S2 with ID: records 0, 2, 7
  S.call('Records with ID 0 remain', 15, { p: P(0x1300, 0x1C00), a: 0,
    check: (b) => (tupEq(range(8).map((k) => b.b('recs', 16 * (3 + k))), [0, 1, 0, 1, 1, 0, 0, 0])
      && b.b('recs', 0) === 0 && b.b('dbg_ok') === 0 ? [] : ['Records 1, 3, 4']) });
  S.call('TEXSET with old ID', 13, { x: 0, p: P(TD[0]), a: 4, same: true });
  S.call('BGSET with old ID', 14, { x: 0, p: P(DB), a: 4 });
  const dvg3 = patched(dvg, [[12, gid ^ 0x66], [5, 2]], dvg.length);
  S.call('GEOMSET other ID and D', 12, { p: P(HDR + 0x400, 0xFFFF), pre: [[HDR + 0x400, dvg3]], a: 0, rx: 0x1A, ry: 0,
    check: geomCheck(dvg3, 0xFFFF, HDR + 0x400) });
  S.call('GEOMSET back', 12, { p: P(GD, 0xFFFF), a: 0, rx: 0, ry: 0, check: geomCheck(dvg, 0xFFFF, GD) });
  S.call('SPRITESET ID 0 again', 9, { x: 4, p: P(HDR2, 0x5000), pre: [[HDR2, patched(s2[3], [[4, 0, 2]])]], a: 0 });
  const dvg4 = patched(dvg, [[12, gid ^ 0x77], [8, u16(dvg, 8) + 2]], dvg.length);
  S.call('GEOMSET other ID and stride', 12, { p: P(HDR + 0x400, 0xFFFF), pre: [[HDR + 0x400, dvg4]], a: 0, rx: 0x10, ry: 0 });
  S.call('GEOMSET back 2', 12, { p: P(GD, 0xFFFF), a: 0, rx: 0, ry: 0 });
  S.call('SPRITESET ID 0 and same ID', 9, { x: 4, p: P(HDR2, 0x5000), pre: [[HDR2, patched(s2[3], [[4, 0, 2]])]], a: 0 });
  S.call('GEOMSET same ID: record 4 remains', 12, { p: P(GD, 0x10), a: 0, rx: 0, ry: 0 });
  S.call('INIT clears everything', 0, { a: 0, rx: 3,
    check: (b) => (bytesEq(b.raw('recs', 176), new Uint8Array(176)) && b.b('geom_ok') === 0 ? [] : ['State']) });
  let cyc = S.run();
  fails.push(...S.fails);
  console.log(`P6c sim A (geometry, assets): ${S.steps.length} calls, ${S.fails.length} errors, cycles ${cyc}`);

  // ================================================================ scene B: map
  const SB = new Seq(L);
  SB.seg(ADDR.dmp, dmp);
  SB.call('INIT', 0, { a: 0 });
  const mp = P(ADDR.dmp);
  // format errors (header copies)
  const c = dmp;
  const wh = W * H;
  const bad = [['Magic', [0, 0x58]], ['Version', [2, 2]], ['W 0', [3, 0]], ['H 0', [4, 0]],
    ['W*H > 16384', [3, 255], [4, 255]], ['W*H = 16512', [3, 129], [4, 128]],
    ['Start >= W*H', [8, wh]], ['Direction 4', [10, 4]], ['Outside tile >= NT', [11, NT]],
    ['Offset 12', [12, 25]], ['Offset 14', [14, 24 + wh + 1]], ['Offset 16', [16, 24 + 2 * wh + 8]],
    ['Offset 18', [18, u16(c, 18) + 1]], ['Length', [20, u16(c, 20) + 1]], ['NT', [5, NT + 1]],
    ['NE', [6, u16(c, 6) + 1]], ['NE 16384 (4 NE = 65536)', [6, 0x4000], [20, u16(c, 18)]],
    ['Length over 65535', [6, 0x3FFF], [20, (u16(c, 18) + 4 * 0x3FFF) & 0xFFFF]]];
  for (const [nm, ...e] of bad) {
    SB.call(`MAPINIT ${nm}`, 1, { p: P(HDR), pre: [[HDR, patched(c, e, 24)]], a: 1, check: (b) => (b.b('map_ok') === 0 ? [] : ['map_ok']) });
    SB.call(`CELL after faulty MAPINIT (${nm})`, 5, { a: 5 });
  }

  const mapCheck = (m_, copyaddr, auto, dmpaddr = ADDR.dmp) => {
    const n = m_.width * m_.height;
    return (b) => {
      const out = [];
      const got = [b.b('map_ok'), b.b('map_w'), b.b('map_h'), b.w('map_wh'), b.w('map_nt'), b.w('map_ne'), b.w('pos'),
        b.b('vdir'), b.b('map_out'), b.b('map_auto'), b.b('px'), b.b('py')];
      const want = [1, m_.width, m_.height, n, m_.tiles.length, m_.events.length, m_.start, m_.direction, m_.outside, auto,
        m_.start % m_.width, fdiv(m_.start, m_.width)];
      if (!tupEq(got, want)) out.push(`Map ${pyr(got)} <> ${pyr(want)}`);
      const cells = copyaddr || dmpaddr + 24;
      if (b.w('ptrs', 0) !== cells || b.w('ptrs', 2) !== cells + n) out.push('Layer pointers');
      if (b.w('ptrs', 4) !== dmpaddr + 24 + 2 * n || b.w('ptrs', 6) !== dmpaddr + 24 + 2 * n + 8 * m_.tiles.length) out.push('Table pointers');
      return out;
    };
  };
  SB.call('MAPINIT', 1, { p: mp, objn: 5, a: 0, rx: W, ry: H, rp: [m.start, m.direction], check: mapCheck(m, 0, 0), dump: [[0x0C50, 1]] });
  SB.call('OBJN = 0', 15, { p: P(0x1300, 0x1C00), a: 0 });
  SB.call('MAPINIT with working copy and automap', 1, { x: 1, p: P(ADDR.dmp, 0x6000), objn: 3, a: 0, rx: W, ry: H,
    rp: [m.start, m.direction], check: mapCheck(m, 0x6000, 1), dump: [[0x0C50, 1], [0x6000, 2 * W * H]] });
  // CELL, SETPOS
  for (let i = 0; i < W * H; i++) {
    const t = m.cells[i];
    SB.call(`CELL ${i}`, 5, { p: P(i), a: 0, rx: t, ry: m.content[i], rp: [i, m.tiles[t].flags] });
  }
  SB.call('CELL outside', 5, { p: P(W * H), a: 6, rx: m.outside, ry: 0, rp: [W * H, m.tiles[m.outside].flags] });
  SB.call('CELL 0xFFFF', 5, { p: P(0xFFFF), a: 6, rx: m.outside, ry: 0 });
  for (let i = 0; i < W * H; i++) {
    const v = (i * 3) % 4;
    SB.call(`SETPOS ${i}`, 2, { x: v, p: P(i), a: 0, rx: 0, ry: 0,
      check: (b) => (tupEq([b.w('pos'), b.b('vdir'), b.b('px'), b.b('py')], [i, v, i % W, fdiv(i, W)]) ? []
        : [`pos/v/px/py ${pyr([b.w('pos'), b.b('vdir'), b.b('px'), b.b('py')])}`]) });
  }
  SB.call('SETPOS outside', 2, { x: 1, p: P(W * H), a: 6, same: true });
  SB.call('SETPOS direction 4', 2, { x: 4, p: P(3), a: 6, same: true });
  // SETCELL / SETITEM (with working copy: DMP stays, copy changes)
  SB.call('SETCELL 3 = tile 2', 6, { x: 2, p: P(3), a: 0 });
  SB.call('CELL 3 after SETCELL', 5, { p: P(3), a: 0, rx: 2, ry: m.content[3], rp: [3, m.tiles[2].flags] });
  SB.call('SETCELL tile = NT', 6, { x: NT, p: P(3), a: 6, same: true });
  SB.call('SETCELL tile 255', 6, { x: 255, p: P(3), a: 6, same: true });
  SB.call('SETCELL cell outside', 6, { x: 0, p: P(W * H), a: 6, same: true });
  SB.call('SETITEM 10 = $45', 16, { x: 0x45, p: P(10), a: 0 });
  SB.call('CELL 10 after SETITEM', 5, { p: P(10), a: 0, rx: m.cells[10], ry: 0x45 });
  SB.call('SETITEM 34 = 255', 16, { x: 255, p: P(34), a: 0 });
  SB.call('SETITEM outside', 16, { x: 1, p: P(W * H), a: 6, same: true });
  SB.call('SETITEM $FFFF', 16, { x: 1, p: P(0xFFFF), a: 6, same: true });
  const cells2 = U8([...m.cells.slice(0, 3), 2, ...m.cells.slice(4)]);
  const cont2 = U8(m.content);
  cont2[10] = 0x45; cont2[34] = 255;
  SB.call('Check copy and DMP', 15, { p: P(0x1300, 0x1C00), a: 0, dump: [[0x6000, 2 * W * H], [0x5000 + 24, 2 * W * H]],
    check: (b) => [...(bytesEq(b.extra[0], cat(cells2, cont2)) ? [] : ['Working copy']),
      ...(bytesEq(b.extra[1], cat(U8(m.cells), U8(m.content))) ? [] : ['DMP changed'])] });
  // without working copy: SETCELL writes into the DMP
  SB.call('MAPINIT without copy', 1, { p: mp, a: 0, check: mapCheck(m, 0, 0) });
  SB.call('SETCELL in DMP', 6, { x: 1, p: P(0), a: 0, dump: [[0x5000 + 24, 1]],
    check: (b) => (b.extra[0][0] === 1 ? [] : ['DMP not changed']) });
  // target of the working copy (P6d): [P1, P1 + 2 W H) must lie in $4000 ... LIB ($B000), otherwise E_RANGE
  const n2 = 2 * W * H;
  for (const [nm, dst, a] of [['exactly below LIB', 0xB000 - n2, 0], ['one byte above LIB', 0xB000 - n2 + 1, 6],
    ['from LIB', 0xB000, 6], ['BSS', 0xE000, 6], ['DVG', 0xE800, 6], ['below $4000', 0x3FFF, 6],
    ['$2000', 0x2000, 6], ['$0400', 0x0400, 6], ['Overflow 65536', 0x10000 - n2 + 2, 6], ['I/O', 0xD000 - 4, 6]]) {
    SB.call(`MAPINIT working copy ${nm}`, 1, { p: P(ADDR.dmp, dst), a,
      check: (b) => [...(b.b('map_ok') === (a === 0 ? 1 : 0) ? [] : ['map_ok']), ...(a || b.w('ptrs', 0) === dst ? [] : ['Copy not used'])] });
    SB.call(`CELL after MAPINIT ${nm}`, 5, { a: a === 0 ? 0 : 5 });
  }
  cyc = SB.run();
  fails.push(...SB.fails);
  console.log(`P6c sim B (map, ${W}x${H}): ${SB.steps.length} calls, ${SB.fails.length} errors, cycles ${cyc}`);

  // ---- random maps and boundary cases of the size (NT = 256, 128 x 128, 255 x 64, random sizes)
  const SC = new Seq(L);
  SC.call('INIT', 0, { a: 0 });
  const rnd = new PyRandom(6);
  const maps = [];
  for (const [w, h, nt] of [[128, 128, 3], [255, 64, 5], [1, 255, 2], [255, 1, 256], [1, 1, 1], [17, 9, 256], [40, 40, 7]]) {
    const tiles = range(nt).map(() => new M.Tile([0, 0, 0, 0], 1, 1, 0, 0));
    const cells = range(w * h).map(() => rnd.randrange(nt));
    const content = range(w * h).map(() => rnd.randrange(256));
    const start = rnd.randrange(w * h);
    const dir = rnd.randrange(4);
    maps.push(new M.Map('z', w, h, tiles, cells, content, [], start, dir, rnd.randrange(nt)));
  }
  for (const mm of maps) {
    const w = mm.width, h = mm.height;
    const n = w * h;
    const data = M.toDmp(mm).slice(2);
    const nm = `${w}x${h} NT ${mm.tiles.length}`;
    const useCopy = n <= 2048;
    SC.call(`MAPINIT ${nm}`, 1, { p: P(ADDR.bigmap, useCopy ? 0x8000 : 0), pre: [[ADDR.bigmap, data]], a: 0, rx: w & 255, ry: h & 255,
      rp: [mm.start, mm.direction], check: mapCheck(mm, useCopy ? 0x8000 : 0, 0, ADDR.bigmap) });
    const pr = [0, n - 1, mm.start, fdiv(n, 2)];
    pr.push(rnd.randrange(n)); pr.push(rnd.randrange(n));
    const probe = [...new Set(pr)].sort((a, b) => a - b);
    for (const i of probe) {
      SC.call(`${nm} CELL ${i}`, 5, { p: P(i), a: 0, rx: mm.cells[i] & 255, ry: mm.content[i], rp: [i, 0] });
      SC.call(`${nm} SETPOS ${i}`, 2, { x: 3, p: P(i), a: 0,
        check: (b) => (b.b('px') === i % w && b.b('py') === fdiv(i, w) ? [] : [`px/py ${pyr([b.b('px'), b.b('py')])}`]) });
    }
    SC.call(`${nm} SETCELL highest tile`, 6, { x: (mm.tiles.length - 1) & 255, p: P(n - 1), a: 0 });
    SC.call(`${nm} SETCELL NT`, 6, { x: mm.tiles.length & 255, p: P(n - 1), a: mm.tiles.length === 256 ? 0 : 6 });
  }
  cyc = SC.run();
  fails.push(...SC.fails);
  console.log(`P6c sim C (sizes, random): ${SC.steps.length} calls, ${SC.fails.length} errors, cycles ${cyc}`);
  for (const f of fails.slice(0, 40)) console.log('FAIL', f);
  return !fails.length;
}

// ------------------------------------------------------------------ P6d: VIEW without objects
// demo DTS larger than the areas of 2.4: DVG $E800 (up to 1.8 KB), ceiling $EF00-$FBAE (everything below $FC00), DBG in the gap
// between wall and floor (room there for wall DTS with double slots)
export const P6D_ADDR = Object.freeze({ dmp: 0x2E00, dvg: 0xE800, dts: Object.freeze([0x6000, 0x8300, 0xEF00]), dbg: 0x8280 });
export const BIGBUF = Object.freeze([0x1300, 0x1C00]);   // largest allowed buffer (BUFSET window, P6d-opt)
export const S2_AREAS = Object.freeze([[0x4000, 0x6000], [0xA700, 0xB000]]);   // free areas for S2 (sim.cfg; from $4000 because of type 9)

const oids = new WeakMap();
let oidNext = 1;
/** Stable identity of an object (Python id()). */
const oid = (o) => { if (o === null || o === undefined) return 0; if (!oids.has(o)) oids.set(o, oidNext++); return oids.get(o); };

/** Object list of the parameter block: 6 bytes per object (cell, set, dir, phase, byte5). */
export const objBytes = (objs) => cat(...objs.map((o) => cat(pk16(o.cell), pk8(o.set, o.dir, o.phase, o.byte5()))));

/** Builds a scene file from view.js scenes (only necessary set calls between the views) and compares
 *  every VIEW reply byte for byte with V.view. */
export class ViewRunner {
  constructor(vcopy = false) {
    this.mapx = 0; this.mapp1 = 0;             // MAPINIT: X and working copy (P6f: automap)
    this.S2_AREAS = S2_AREAS;
    this.bank1 = !vcopy;
    this.prg = vcopy ? PRGC : PRG;
    this.dbgBytes = null;                     // DBG content (without load address), loaded once at P6D_ADDR.dbg
    this.reset();
  }

  reset() {
    this.scene = new Scene();
    this.scene.call(0);
    this.state = new globalThis.Map();
    this.expect = [];           // [name, result] per VIEW, ['setup', A] for set calls
  }

  _call(f, x = 0, y = 0, { p = [0, 0, 0, 0], want = null, itemph = 0, objn = 0, objl } = {}) {
    this.scene.call(f, x, y, { p, itemph, objn, objl });
    this.expect.push(want);
  }

  /** Set calls for sc. */
  setup(sc) {
    const st = this.state;
    const dvg = V.dvgBytes(sc.dvg).slice(2);
    if (!st.has('dvg') || !bytesEq(st.get('dvg'), dvg)) {
      this.scene.seg(P6D_ADDR.dvg, dvg);
      this._call(12, 0, 0, { p: [P6D_ADDR.dvg, 0xFFFF, 0, 0], want: ['setup', 0] });
      st.set('dvg', dvg);
      st.delete('dts');
      st.delete('bg');
      for (let k = 0; k < 8; k++) st.delete(`s2/${k}`);
    }
    for (let k = 0; k < 3; k++) {
      const ts = sc.dts[k];
      const key = `${oid(ts)},${ts ? ts.ne : 0},${sc.vramBases.dts[k]}`;
      if (st.get(`dts/${k}`) !== key || !st.has('dts')) {
        if (ts === null) this._call(13, k, 0, { want: ['setup', 0] });
        else {
          const data = (ts.dtsPrg || tex.toDts(ts)).slice(2);
          if (!st.has(`dtsdata/${k}`) || !bytesEq(st.get(`dtsdata/${k}`), data)) {
            this.scene.seg(P6D_ADDR.dts[k], data);
            st.set(`dtsdata/${k}`, data);
          }
          this._call(13, k, 0, { p: [P6D_ADDR.dts[k], sc.vramBases.dts[k], 0, 0], want: ['setup', 0] });
        }
        st.set(`dts/${k}`, key);
      }
    }
    st.set('dts', true);
    const bg = `${sc.dbg !== null},${sc.bgfill},${sc.vramBases.dbg},${sc.farfill}`;
    if (st.get('bg') !== bg) {
      if (sc.dbg !== null && !st.get('dbgdata')) {
        this.scene.seg(P6D_ADDR.dbg, this.dbgBytes);
        st.set('dbgdata', true);
      }
      const ff = sc.farfill;                // far view (P6 5.7a): Y <> 0 = on, P2 low = fill byte
      this._call(14, sc.bgfill, ff === null ? 0 : 1 + (ff & 1), {
        p: [sc.dbg !== null ? P6D_ADDR.dbg : 0, sc.vramBases.dbg, ff === null ? 0x5A00 : ff | 0xA500, 0], want: ['setup', 0] });
      st.set('bg', bg);
    }
    const dmp = M.toDmp(sc.dmp).slice(2);
    if (!st.has('dmp') || !bytesEq(st.get('dmp'), dmp)) {
      this.scene.seg(P6D_ADDR.dmp, dmp);
      this._call(1, this.mapx, 0, { p: [P6D_ADDR.dmp, this.mapp1, 0, 0], want: ['setup', 0] });
      st.set('dmp', dmp);
      st.delete('pos');
    }
    if (st.get('pos') !== `${sc.pos},${sc.dir}`) {
      this._call(2, sc.dir, 0, { p: [sc.pos, 0, 0, 0], want: ['setup', 0] });
      st.set('pos', `${sc.pos},${sc.dir}`);
    }
    const bk = `${sc.buf[0]},${sc.buf[1]},${!!sc.bufFix}`;
    if (st.get('buf') !== bk) {
      this._call(15, sc.bufFix ? 1 : 0, 0, { p: [sc.buf[0], sc.buf[1], 0, 0], want: ['setup', 0] });
      st.set('buf', bk);
    }
    // sprite records (S2 at fixed addresses per record object, P6e) and ITEMSET
    for (let k = 0; k < 8; k++) {
      const ss = sc.s2[k];
      const key = ss !== null ? `${oid(ss)},${sc.vramBases.s2[k]}` : null;
      if ((st.has(`s2/${k}`) ? st.get(`s2/${k}`) : 'new') === key) continue;
      if (ss === null) this._call(9, k, 0, { want: ['setup', 0] });
      else this._call(9, k, 0, { p: [this.s2Addr(ss), sc.vramBases.s2[k], 0, 0], want: ['setup', 0] });
      st.set(`s2/${k}`, key);
    }
    if (!st.has('itemtab')) st.set('itemtab', zeros(64));
    const it = st.get('itemtab');
    for (let g = 0; g < 64; g++) {
      if (it[g] !== sc.itemtab[g]) {
        this._call(10, g, sc.itemtab[g], { want: ['setup', 0] });
        it[g] = sc.itemtab[g];
      }
    }
  }

  /** Bank 1 address of a sprite record; loads it on first use (areas S2_AREAS, packed). */
  s2Addr(ss) {
    if (!this.state.has('s2addr')) this.state.set('s2addr', new globalThis.Map());
    const tab = this.state.get('s2addr');
    if (tab.has(ss)) return tab.get(ss);
    const data = spr.toS2(ss).slice(2);
    if (!this.state.has('s2used')) this.state.set('s2used', this.S2_AREAS.map(([a]) => a));
    const used = this.state.get('s2used');
    let addr = null;
    for (let i = 0; i < this.S2_AREAS.length; i++) {
      if (used[i] + data.length <= this.S2_AREAS[i][1]) {
        addr = used[i];
        used[i] += (data.length + 15) & ~15;
        break;
      }
    }
    if (addr === null) throw new Error('no room for the sprite record in sim65 memory');
    this.scene.seg(addr, data);
    tab.set(ss, addr);
    return addr;
  }

  /** objs: take over objects, items (itemtab) and ITEMPH of the scene (P6e), otherwise without objects (P6d);
   *  objn: OBJN differing from the length of the list (test > 16). */
  add(name, sc, objs = false, objn = null) {
    if (!objs) {
      sc.objects = [];
      sc.itemtab = zeros(64);
    }
    sc.vmsBank1 = this.bank1;
    sc.dtsAddr = P6D_ADDR.dts.slice();
    this.setup(sc);
    sc.s2Addr = sc.s2.map((ss) => (ss !== null ? this.s2Addr(ss) : 0));
    this._call(4, 0, 0, { p: [sc.ap, 0, 0, 0], want: [name, V.view(sc)], ...ViewRunner.objargs(sc, objn) });
  }

  static objargs(sc, objn = null) {
    return { itemph: sc.itemph, objn: objn === null ? sc.objects.length : objn, objl: objBytes(sc.objects.slice(0, 16)) };
  }

  /** -> {nview, fails, codes, cycles} */
  run() {
    const r = run(this.scene, this.prg);
    this.lastItems = r.items;
    const calls = r.items.filter(isCall);
    if (calls.length !== this.expect.length + 1) throw new Error(`AssertionError: ${calls.length} calls, ${this.expect.length + 1} expected`);
    const fails = [], codes = {};
    let nview = 0;
    this.expect.forEach(([name, res], i) => {
      const c = calls[i + 1];
      if (name === 'setup') {
        if (c.a !== res) fails.push(`Set call F=${c.f}: A = ${c.a}`);
        return;
      }
      nview++;
      codes[res.a] = (codes[res.a] || 0) + 1;
      const pb = [2, 4, 6, 8].map((o) => u16(c.pb, o));          // VCLADR, VCLLEN, VMSLEN, OBJVIS
      const got = [c.a, c.x, c.y, c.p[0], pb];
      const want = [res.a, res.x, 0, res.p0, [res.p0, res.vcllen, res.vmslen, res.objvis]];
      const buf = res.buffer;
      if (!tupEq(got, want) || !bytesEq(c.buf, buf)) {
        let msg = `${name}: A/X/Y/P0/PB sim ${pyr(got)} <> Referenz ${pyr(want)}`;
        if (!bytesEq(c.buf, buf)) msg += '; ' + (firstDiff(c.buf, buf) || 'length');
        fails.push(msg);
      }
    });
    return { nview, fails, codes, cycles: r.cycles };
  }
}

/** Corridor with occluding walls and uniform floor/ceiling (cycle target 8, row 2). */
export function corridorMap(n = 24) {
  const t = [new M.Tile([0, 0, 0, 0], 1, 1, 0, 0), new M.Tile([1, 1, 1, 1], 0, 0, 1 | 4, 0)];
  const w = n, h = 5;
  const cells = new Array(w * h).fill(1);
  for (let x = 1; x < w - 1; x++) cells[2 * w + x] = 0;
  for (const y of [1, 3]) for (let x = 4; x < w - 1; x += 6) cells[y * w + x] = 0;     // side corridors
  const m = new M.Map('corridor', w, h, t, cells, zeros(w * h), [], 2 * w + 1, 1, 1);
  M.validate(m);
  return m;
}

/** Cycles of a VIEW: run with VIEW minus run with F = 7 in its place (same scene). */
export function timeView(runner, sc) {
  runner.reset();
  sc.objects = []; sc.itemtab = zeros(64);
  runner.setup(sc);
  const a = runner.scene.clone().call(4, 0, 0, { p: [sc.ap, 0, 0, 0], quiet: true });
  const b = runner.scene.clone().call(7, 0, 0, { p: [sc.ap, 0, 0, 0], quiet: true });
  return run(a, runner.prg).cycles - run(b, runner.prg).cycles;
}

// ---- maps of test/tools/test_dbeview.py
const T = (walls, floor, ceil, flags, ch) => new M.Tile(walls, floor, ceil, flags, ch);
const { T_SOLID: SOLID, T_OCCLUDING: OCC, T_CONTENT: CNT } = V;

export function mkMap(rows, tiles, legend, { outside = 0, start = null, direction = 0, content = null } = {}) {
  const cells = rows.flatMap((r) => Array.from(r, (ch) => legend[ch]));
  const m = new M.Map('t', rows[0].length, rows.length, tiles, cells, content || zeros(rows.length * rows[0].length),
    [], 0, direction, outside);
  m.start = start !== null ? start : m.cells.findIndex((c) => !(tiles[c].flags & SOLID));
  M.validate(m);
  return m;
}

export function openRoom(w = 13, h = 13, floor = 1, ceil = 1) {
  const t = [T([0, 0, 0, 0], floor, ceil, 0, 0)];
  return mkMap(new Array(h).fill('.'.repeat(w)), t, { '.': 0 }, { start: fdiv(h, 2) * w + fdiv(w, 2) });
}

export function abyssMap() {
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0), T([0, 0, 0, 0], 0, 1, 0, 0),
    T([0, 0, 0, 0], 2, 0, 0, 0), T([2, 0, 2, 0], 1, 1, SOLID, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0),
    T([3, 3, 3, 3], 0, 0, SOLID | OCC, 0), T([0, 0, 0, 0], 3, 2, 0, 0)];
  const rows = ['###########', '#....:....#', '#.##..##..#', '#.#:..:#..#', '#...++....#', '#.:....:..#',
    '#.#.##.#.m#', '#..:..:...#', '###########'];
  const legend = { '#': 1, '.': 0, ':': 2, '+': 4, m: 7, b: 5, w: 6, ',': 3 };
  return mkMap(rows, t, legend, { outside: 1, start: 5 * 11 + 5 });
}

export function distantMap() {
  const DISTANT = V.T_DISTANT;
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0), T([0, 0, 0, 0], 1, 0, 0, 0),
    T([3, 3, 3, 3], 1, 1, SOLID, 0), T([2, 2, 2, 2], 1, 1, SOLID | CNT, 0), T([0, 0, 0, 0], 1, 1, DISTANT, 0),
    T([0, 0, 0, 0], 1, 0, DISTANT, 0), T([0, 0, 0, 0], 0, 0, 0, 0)];
  const rows = ['################', '#......F.......F', '#.####.#.####.##', '#,,,,,,,,,,,,,,#', '#.####+#.####.##',
    '#.uuuu.#.oooo..#', '#.#F##.#.##F#..#', '#.....,,,,.....#', '################'];
  const legend = { '.': 0, '#': 1, ',': 2, F: 3, '+': 4, u: 5, o: 6 };
  return mkMap(rows, t, legend, { outside: 7, start: 1 * 16 + 1 });
}

const ms = (A, m, pos, direction, o = {}) => V.makeScene(A, m, { pos, direction, ...o });
const stats = (cy) => `n = ${cy.length}, min ${Math.min(...cy)}, mean ${fdiv(sum(cy), cy.length)}, max ${Math.max(...cy)}`;

function testP6d(vcopy = false) {
  const full = !!process.env.DBEVIEW_FULL;
  const A = demoAssets();
  const A2 = V.doubleFronts(A);
  const dbgBytes = A.dbgPrg.slice(2);
  const demo = loadMap(DEMO_MAP);
  let ok = true, total = 0;
  const allcodes = {};
  const tag = vcopy ? ' (VMS_COPY)' : '';

  const go = (label, scenes) => {
    const R = new ViewRunner(vcopy);
    R.dbgBytes = dbgBytes;
    for (const [name, sc] of scenes) R.add(name, sc);
    const { nview, fails, codes } = R.run();
    total += nview;
    for (const [k, v] of Object.entries(codes)) allcodes[k] = (allcodes[k] || 0) + v;
    console.log(`P6d sim${tag} ${label}: ${nview} views, ${fails.length} deviations, A-Codes ${pyDict(codes)}`);
    for (const f of fails.slice(0, 10)) console.log('FAIL', f);
    ok = ok && !fails.length;
    return codes;
  };

  // demo: all free cells x 4 directions, bit 3 off/on, without DBG, ap != 0, origin
  const scDemo = [];
  for (const bc of [false, true]) {
    for (const i of free(demo)) for (let v = 0; v < 4; v++) scDemo.push([`demo ${i}/${v} bc${+bc}`, ms(A, demo, i, v, { bandCover: bc })]);
  }
  for (const i of every(free(demo), 3)) {
    for (let v = 0; v < 4; v++) scDemo.push([`demo without DBG ${i}/${v}`, ms(A, demo, i, v, { dbg: false, bgfill: 0x5A })]);
  }
  for (const ap of [0x0123, 0xE200, 0xF800]) {
    for (const i of every(free(demo), 4)) {
      scDemo.push([`demo ap 0x${ap.toString(16)} ${i}`, ms(A, demo, i, (i + ap) & 3, { ap, bandCover: !!(i & 1) })]);
    }
  }
  const g = A.dvg.clone();
  g.origin = 123;
  for (const i of every(free(demo), 2)) {
    const sc = ms(A, demo, i, i & 3);
    sc.dvg = g;
    V.layoutVram(sc);
    scDemo.push([`demo origin 123 ${i}`, sc]);
  }
  go('demo', scDemo);
  // abyss
  const m = abyssMap();
  const sa = [];
  for (const i of free(m)) for (let v = 0; v < 4; v++) sa.push([`abyss ${i}/${v}`, ms(A, m, i, v, { bandCover: !!(i & 1) })]);
  go('abyss', sa);
  // corridor
  const gm = corridorMap();
  const sco = [];
  for (const i of free(gm)) for (let v = 0; v < 4; v++) sco.push([`corridor ${i}/${v}`, ms(A, gm, i, v, { bandCover: !!(v & 1) })]);
  go('corridor', sco);
  // random (without objects): random maps (CONTENT, gaps, blocked cells), bit 3 random, DBG random
  const [nmaps, nviews] = full ? [200, 20] : [60, 6];
  for (let part = 0; part < nmaps; part += 20) {
    const scs = [];
    for (let k = part; k < Math.min(part + 20, nmaps); k++) {
      const base = V.randomScene(k, A, { nobj: 0, buf: k % 3 === 0 ? BIGBUF : V.DEFAULT_BUF });
      const rnd = new PyRandom(k);
      const fr = free(base.dmp);
      for (let j = 0; j < nviews; j++) {
        const sc = base.copy();
        sc.vramBases = copyBases(base.vramBases);
        sc.pos = rnd.choice(fr); sc.dir = rnd.randrange(4);
        if (j === nviews - 1) {
          sc.ap = rnd.choice([0x0040, 0x0123]);
          V.layoutVram(sc);
        }
        scs.push([`random ${k}/${j}`, sc]);
      }
    }
    go(`random ${part}-${Math.min(part + 20, nmaps) - 1}`, scs);
  }
  // overflow: small buffers (A = 2/3, truncation, edges omitted)
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([2, 2, 2, 2], 1, 1, 1, 0)];
  const rows = [...new Array(3).fill('#######'), ...new Array(4).fill('#.....#')];
  const gm2 = new M.Map('grating', 7, 7, t, rows.flatMap((r) => Array.from(r, (ch) => (ch === '#' ? 1 : 0))), zeros(49), [], 6 * 7 + 3, 0, 1);
  const ov = [];
  for (const i of every(free(demo), 2)) for (let v = 0; v < 4; v++) ov.push(ms(A, demo, i, v));
  for (let x = 1; x < 6; x++) for (const v of [0, 1, 3]) ov.push(ms(A, gm2, 6 * 7 + x, v, { bandCover: true }));
  for (let k = 300; k < 312; k++) ov.push(V.randomScene(k, A, { nobj: 0 }));
  let scs = [];
  ov.forEach((sc, n_) => {
    for (const size of [64, 128, 256, 512, 1024]) {
      const s2 = sc.copy();
      s2.buf = [0x1300, 0x1300 + size];
      scs.push([`overflow ${n_} ${size}`, s2]);
    }
  });
  go('overflow', scs);
  // P6j: fixed list address (BUFSET X bit 0): jump (VCL type 10) at B0, VMS lists from B0 + 3
  scs = [];
  [...every(ov, 2), ...range(400, 430).map((k) => V.randomScene(k, A, { nobj: 0 }))].forEach((sc, n_) => {
    for (const size of [64, 256, 1024, 2304]) {
      const s2 = sc.copy();
      s2.buf = [0x1300, 0x1300 + size]; s2.bufFix = true;
      scs.push([`fest ${n_} ${size}`, s2]);
    }
  });
  let codes = go('fixed list address', scs);
  ok = ok && (codes[0] || 0) > 0;
  // abort via the entry count (K4): build with MAXITEM = 8 against the reference with MAXITEM = 8
  if (!vcopy) {
    const orig = V.config.maxItem;
    let res;
    try {
      V.config.maxItem = 8;
      const R = new ViewRunner();
      R.prg = PRGM;
      R.dbgBytes = dbgBytes;
      for (const i of every(free(demo), 3)) for (let v = 0; v < 4; v++) R.add(`MAXITEM 8 demo ${i}/${v}`, ms(A, demo, i, v));
      res = R.run();
    } finally {
      V.config.maxItem = orig;
    }
    total += res.nview;
    console.log(`P6d sim MAXITEM = 8: ${res.nview} views, ${res.fails.length} deviations, A-Codes ${pyDict(res.codes)}`);
    for (const f of res.fails.slice(0, 10)) console.log('FAIL', f);
    ok = ok && !res.fails.length && (res.codes[2] || 0) > 0;
  }
  // two fronts per cell (synthetic DVG)
  scs = [];
  for (const bc of [false, true]) for (const i of free(demo)) for (let v = 0; v < 4; v++) scs.push([`2F demo ${i}/${v} bc${+bc}`, ms(A2, demo, i, v, { bandCover: bc })]);
  for (let k = 0; k < 80; k++) scs.push([`2F random ${k}`, V.randomScene(1000 + k, A2, { nobj: 0 })]);
  go('two fronts', scs);
  console.log(`P6d sim${tag}: ${total} views compared byte-identical, A codes total ${pyDict(allcodes)} -> ${ok ? 'ok' : 'ERROR'}`);

  // cycles per VIEW (difference of two runs)
  if (process.env.DBE_NOCYCLES) return ok;
  const R = new ViewRunner(vcopy);
  R.dbgBytes = dbgBytes;
  const samples = [
    ['Corridor (occluding, uniform)', free(gm).flatMap((i) => [1, 3].map((v) => ms(A, gm, i, v)))],
    ['demo', free(demo).flatMap((i) => [0, 1, 2, 3].map((v) => ms(A, demo, i, v)))],
    ['random (open, mixed)', range(40).map((k) => V.randomScene(k, A, { nobj: 0 }))],
    ['two fronts', every(free(demo), 2).flatMap((i) => [0, 1, 2, 3].map((v) => ms(A2, demo, i, v)))],
  ];
  for (const [label, sl] of samples) {
    const cy = sl.map((sc) => timeView(R, sc));
    console.log(`P6d cycles${tag} ${label}: ${stats(cy)}`);
  }
  return ok;
}

// ------------------------------------------------------------------ P6e: VIEW with objects
/** Additional sprite records for the edge test: 'up' (taller than the window above the anchor, sticks out at the top),
 *  'left' (foot point at the far right: sticks out on the left), 'right' (foot point at the left: sticks out on the right;
 *  without image for d = 2, index $FE). */
export function tallSets(dvg) {
  const D = dvg.D, stride = dvg.stride;
  const out = [];
  for (const [name, wb, h, fxf] of [['up', 4, 90, 0.5], ['left', 30, 20, 1.0], ['right', 30, 20, 0.0]]) {
    const images = [];
    for (let d = 1; d <= D; d++) {
      if (name === 'right' && d === 2) continue;       // no image: index $FE (P5b 6.3, object is dropped)
      const w = Math.max(2, wb >> (d - 1));
      const hh = name !== 'up' ? Math.max(3, h >> (d - 1)) : h;
      const pix = V.spritePixels('blob', 2 * w, hh, d & 3, 0);
      images.push([[0, 0, d], [pix, Math.min(w - 1, Math.trunc(w * fxf)), hh - 1]]);
    }
    const [prg, vram] = V.makeS2(images, D, 1, 1, stride);
    out.push(V.readS2(prg, vram));
  }
  // 'grating': wide, per row offset run (3 bytes), half byte (type 8) and gap, no cores: long lists
  // (over 300 bytes) with runs trimmed left/right at all positions relative to the ZP1 advance (Y >= $FC)
  const images = [];
  for (let d = 1; d <= D; d++) {
    const w = Math.max(5, 26 >> (d - 1)), hh = Math.max(3, 12 >> (d - 1));
    const pix = range(hh).map(() => new Array(2 * w).fill(null));
    for (let r = 0; r < hh; r++) {
      for (let x = 0; x < w; x++) {
        const m_ = (x + r) % 6;
        if (m_ !== 0 && m_ !== 4) {
          pix[r][2 * x] = 9 + (r & 3);
          if (m_ > 1) pix[r][2 * x + 1] = 5;
        }
      }
    }
    images.push([[0, 0, d], [pix, w >> 1, hh - 1]]);
  }
  const [prg, vram] = V.makeS2(images, D, 1, 1, stride);
  out.push(V.readS2(prg, vram));
  return out;
}

/** VIEW with objects and items (5.8), trimming with VMS type 3, OBJVIS: byte-identical with V.view. */
function testP6e(vcopy = false) {
  const full = !!process.env.DBEVIEW_FULL;
  const A = demoAssets();
  const dbgBytes = A.dbgPrg.slice(2);
  const demo = loadMap(DEMO_MAP);
  const extra = tallSets(A.dvg);
  const tag = vcopy ? ' (VMS_COPY)' : '';
  let ok = true, total = 0;
  const allcodes = {};
  const st = { obj: 0, vis: 0 };

  const go = (label, scenes, prg = null, maxitem = null) => {
    const R = new ViewRunner(vcopy);
    if (prg) R.prg = prg;
    R.dbgBytes = dbgBytes;
    const orig = V.config.maxItem;
    try {
      if (maxitem) V.config.maxItem = maxitem;
      for (const sc_ of scenes) {
        const [name, sc] = sc_;
        R.add(name, sc, true, sc_.length > 2 ? sc_[2] : null);
        const res = R.expect[R.expect.length - 1][1];
        st.obj += sc.objects.length;
        st.vis += res.objvis.toString(2).split('1').length - 1;
      }
    } finally {
      V.config.maxItem = orig;
    }
    const { nview, fails, codes } = R.run();
    total += nview;
    for (const [k, v] of Object.entries(codes)) allcodes[k] = (allcodes[k] || 0) + v;
    console.log(`P6e sim${tag} ${label}: ${nview} views, ${fails.length} deviations, A-Codes ${pyDict(codes)}`);
    for (const f of fails.slice(0, 10)) console.log('FAIL', f);
    ok = ok && !fails.length;
    return codes;
  };

  const withExtra = (sc) => {
    sc.s2 = [sc.s2[0], null, ...sc.s2.slice(2, 4), ...extra];    // record 1 free (room); 4-7: up, left, right, grating
    return V.layoutVram(sc);
  };

  const items = [0, 2, 3, 2, ...zeros(60)];
  // demo: all free cells x 4 directions with 0, 1 and 5 objects (fixed seed), items, ITEMPH
  let rnd = new PyRandom(2025);
  let scs = [];
  for (const n of [0, 1, 5]) {
    for (const i of free(demo)) {
      for (let v = 0; v < 4; v++) {
        const objs = V.randomObjects(rnd, demo, i, v, n);
        scs.push([`demo ${n} Obj ${i}/${v}`, ms(A, demo, i, v, { objects: objs, itemtab: items, itemph: (i + v) & 3, bandCover: !!((i + v) & 1) })]);
      }
    }
  }
  go('demo 0/1/5 objects', scs);
  // edge: sprites at the window edges (s = -2 ... 2, d = 1 ... 3, all q), out at the top, out left/right
  const m = openRoom();
  const cx = m.start % m.width, cy = fdiv(m.start, m.width);
  scs = [];
  for (const setn of [0, 2, 3, 4, 5, 6, 7]) {
    for (const d of [1, 2, 3]) {
      for (const s_ of [-2, -1, 0, 1, 2]) {
        for (let q = 0; q < 5; q++) {
          const o = new V.Obj((cy - d) * m.width + cx + s_, setn, 2, 1, q);
          const sc = withExtra(V.makeScene(A, m, { objects: [o], buf: BIGBUF, bandCover: !!(q & 1) }));
          scs.push([`edge record ${setn} d ${d} s ${s_} q ${q}`, sc]);
        }
      }
    }
  }
  go('edge', scs);
  // edge behind walls: objects partly occluded
  let t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0)];
  let rows = ['#########', '#.......#', '#.#####.#', '#.#...#.#', '#.#...#.#', '#...#...#', '#########'];
  const mw = mkMap(rows, t, { '#': 1, '.': 0 }, { outside: 1, start: 5 * 9 + 2, direction: 0 });
  scs = [];
  for (const i of free(mw)) {
    for (let v = 0; v < 4; v++) {
      for (const setn of [0, 3, 5]) {
        const objs = [];
        for (let j = 0; j < mw.cells.length; j++) {
          for (const q of [0, 4]) {
            if (!(mw.tiles[mw.cells[j]].flags & SOLID) && (j + q) % 3 === 0) objs.push(new V.Obj(j, setn, (j + v) & 3, j & 1, q));
          }
        }
        scs.push([`occluded ${i}/${v} record ${setn}`, withExtra(ms(A, mw, i, v, { objects: objs.slice(0, 16) }))]);
      }
    }
  }
  go('edge occluded', scs);
  // CONTENT: doors/grids with flag CONTENT (occluding and not), objects and items on them
  t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0), T([2, 0, 2, 0], 1, 1, CNT, 0),
    T([3, 3, 3, 3], 1, 2, CNT | OCC, 0), T([2, 2, 2, 2], 1, 1, SOLID, 0)];
  rows = ['#########', '#.D.G...#', '#.#E#.#.#', '#.......#', '#.G.D.E.#', '#########'];
  const mi = mkMap(rows, t, { '#': 1, '.': 0, D: 2, E: 3, G: 4 }, { outside: 1, start: 3 * 9 + 1, direction: 1 });
  mi.cells.forEach((c, j) => { if (c === 2 || c === 3) mi.content[j] = 1 + (j % 3); });
  scs = [];
  for (const i of free(mi)) {
    for (let v = 0; v < 4; v++) {
      const objs = [];
      mi.cells.forEach((c, j) => { if (c === 2 || c === 3 || c === 4) objs.push(new V.Obj(j, (j + v) % 4, v, j & 1, (j + v) % 6)); });
      scs.push([`CONTENT ${i}/${v}`, ms(A, mi, i, v, { objects: objs.slice(0, 16), itemtab: items, itemph: v, bandCover: !!(i & 1) })]);
    }
  }
  go('CONTENT', scs);
  // two fronts and two object slots per cell (k_ob < k_oe, synthetic DVG): demo and random with objects
  const A3 = V.doubleFronts(A, true);
  rnd = new PyRandom(33);
  scs = [];
  for (const i of every(free(demo), 2)) {
    for (let v = 0; v < 4; v++) {
      scs.push([`2F2O demo ${i}/${v}`, ms(A3, demo, i, v, { objects: V.randomObjects(rnd, demo, i, v, 6), itemtab: items, itemph: v, bandCover: !!(i & 1) })]);
    }
  }
  for (let k = 0; k < 40; k++) scs.push([`2F2O random ${k}`, V.randomScene(2000 + k, A3, { nobj: 12 })]);
  go('two fronts, two object slots', scs);
  // random with objects (up to 16, bit 6/7, items, ITEMPH), OBJN > 16
  const [nmaps, nviews] = full ? [200, 20] : [60, 6];
  for (let part = 0; part < nmaps; part += 20) {
    scs = [];
    for (let k = part; k < Math.min(part + 20, nmaps); k++) {
      const base = V.randomScene(k, A, { buf: k % 3 === 0 ? BIGBUF : V.DEFAULT_BUF });
      const r = new PyRandom(k);
      const fr = free(base.dmp);
      for (let j = 0; j < nviews; j++) {
        const sc = base.copy();
        sc.vramBases = copyBases(base.vramBases);
        sc.pos = r.choice(fr); sc.dir = r.randrange(4);
        sc.objects = V.randomObjects(r, sc.dmp, sc.pos, sc.dir, r.randint(0, 16));
        sc.itemph = r.randrange(4);
        if (j === nviews - 1) {
          sc.ap = r.choice([0x0040, 0x0123]);
          V.layoutVram(sc);
        }
        if (j === 1) {                   // OBJN = 20: only the first 16 count
          sc.objects = V.randomObjects(r, sc.dmp, sc.pos, sc.dir, 20);
          scs.push([`random ${k}/${j} OBJN 20`, sc]);
        } else scs.push([`random ${k}/${j}`, sc]);
      }
    }
    go(`random ${part}-${Math.min(part + 20, nmaps) - 1}`, scs);
  }
  // overflow with objects: small buffers (A = 2/3)
  rnd = new PyRandom(77);
  const ov = [];
  for (const i of every(free(demo), 2)) {
    for (let v = 0; v < 4; v++) ov.push(ms(A, demo, i, v, { objects: V.randomObjects(rnd, demo, i, v, 6), itemtab: items, itemph: 1 }));
  }
  for (let k = 300; k < 312; k++) ov.push(V.randomScene(k, A, { nobj: 12 }));
  scs = [];
  ov.forEach((sc, n_) => {
    for (const size of [64, 128, 256, 512, 1024]) {
      const s2 = sc.copy();
      s2.buf = [0x1300, 0x1300 + size];
      scs.push([`overflow ${n_} ${size}`, s2]);
    }
  });
  go('overflow', scs);
  // P6j: fixed list address (BUFSET X bit 0) with objects (trimmed sprites: VMS lists from B0 + 3)
  scs = [];
  [...every(ov, 2), ...range(400, 430).map((k) => V.randomScene(k, A, { nobj: 12 }))].forEach((sc, n_) => {
    for (const size of [128, 1024, 2304]) {
      const s2 = sc.copy();
      s2.buf = [0x1300, 0x1300 + size]; s2.bufFix = true;
      scs.push([`fest ${n_} ${size}`, s2]);
    }
  });
  const codes = go('fixed list address', scs);
  ok = ok && (codes[0] || 0) > 0;
  // MAXITEM = 8 with objects (empty sprite entries do not count)
  if (!vcopy) {
    go('MAXITEM = 8', range(30).map((k) => [`MAXITEM 8 ${k}`, V.randomScene(500 + k, A, { nobj: 16, buf: BIGBUF })]), PRGM, 8);
  }
  console.log(`P6e sim${tag}: ${total} views compared byte-identical, A codes total ${pyDict(allcodes)},`
    + ` objects ${st.obj}, of which output (OBJVIS) ${st.vis} -> ${ok ? 'ok' : 'ERROR'}`);
  if (process.env.DBE_NOCYCLES || vcopy) return ok;
  // cycles: per VIEW with objects, and per object (difference to the view without objects)
  const R = new ViewRunner(vcopy);
  R.dbgBytes = dbgBytes;
  const tv = (sc) => {
    R.reset();
    R.setup(sc);
    const oa = ViewRunner.objargs(sc);
    const a = R.scene.clone().call(4, 0, 0, { p: [sc.ap, 0, 0, 0], quiet: true, ...oa });
    const b = R.scene.clone().call(7, 0, 0, { p: [sc.ap, 0, 0, 0], quiet: true, ...oa });
    return run(a, R.prg).cycles - run(b, R.prg).cycles;
  };
  rnd = new PyRandom(5);
  for (const n of [1, 5]) {
    const cyc = [];
    for (const i of free(demo)) {
      for (let v = 0; v < 4; v++) cyc.push(tv(ms(A, demo, i, v, { objects: V.randomObjects(rnd, demo, i, v, n), itemtab: items, itemph: 0 })));
    }
    console.log(`P6e cycles demo ${n} objects: ${stats(cyc)}`);
  }
  const cyr = range(40).map((k) => tv(V.randomScene(k, A)));
  console.log(`P6e cycles random (0-16 objects): ${stats(cyr)}`);
  // per object: open room, one object at (d, s) with record; difference to the empty view
  for (const [label, setn, cases] of [['untrimmed', 0, [[1, 0, 4], [2, 0, 2], [3, 0, 4], [2, 1, 1]]],
    ['trimmed (edge)', 3, [[1, -1, 0], [1, 1, 4], [2, -2, 0], [2, 2, 1]]],
    ['trimmed (top)', 4, [[1, 0, 4], [2, 0, 4], [3, 0, 4]]]]) {
    const per = [];
    for (const [d, s_, q] of cases) {
      const o = new V.Obj((fdiv(m.start, m.width) - d) * m.width + m.start % m.width + s_, setn, 2, 0, q);
      const sc1 = withExtra(V.makeScene(A, m, { objects: [o], buf: BIGBUF }));
      const sc0 = withExtra(V.makeScene(A, m, { objects: [], buf: BIGBUF }));
      const res = V.view(sc1);
      per.push([tv(sc1) - tv(sc0), res.vms.length, res.objvis]);
    }
    console.log(`P6e cycles per object ${label}: ` + per.map(([c, b, v]) => `${c} (${b} VMS byte${v ? '' : ', invisible'})`).join(', '));
  }
  return ok;
}

// ------------------------------------------------------------------ P6f: MOVE, automap, cycles
export const AUTO_ADDR = 0x4000;    // working copy of the map (2 W H bytes) in the automap tests (MAPINIT from $4000)
export const AUTO_S2 = Object.freeze([[0x4800, 0x6000], [0xA700, 0xB000]]);    // S2 areas there: $4000-$47FF belongs to the working copy

/** Sorted set of tuples (Python sorted({...})). */
function sortedTupleSet(tuples) {
  const seen = new Set(), out = [];
  for (const t of tuples) { const k = t.join(','); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out.sort((a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
}

/** Maps for the MOVE test: [name, map]. With events (several per cell, indices > 255), doors, objects
 *  in the list only; edge cases W = 255 (px + 1 = $FF), W = 1, H = 1. */
function moveMaps() {
  const rnd = new PyRandom(61);
  const out = [['demo', loadMap(DEMO_MAP)], ['abyss', abyssMap()]];
  for (let k = 0; k < 6; k++) {
    const w = rnd.randint(3, 20), h = rnd.randint(3, 20);
    out.push([`random ${k}`, V.randomMap(rnd, w, h)]);
  }
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, 1 | 4, 0), T([2, 2, 2, 2], 1, 1, 1 | 8, 0)];
  for (const [name, w, h] of [['wide 255', 255, 4], ['narrow 1', 1, 40], ['flat 40', 40, 1], ['tall 4', 4, 255], ['1x1', 1, 1]]) {
    const cells = range(w * h).map(() => rnd.choice([0, 0, 0, 1, 2]));
    const content = cells.map(() => { const a = rnd.randrange(64); return a | rnd.choice([0, 0x40, 0x80]); });
    out.push([name, new M.Map(name, w, h, t, cells, content, [], 0, 0, rnd.choice([0, 1]))]);
  }
  for (const [name, m] of out) {
    const n = m.width * m.height;
    if (name !== 'demo') {                                  // demo keeps its three events
      const nev = name === 'wide 255' ? 600 : (n > 40 ? rnd.choice([0, 3, 40, 300]) : 5);   // index > 255
      const evs = sortedTupleSet(range(nev).map(() => {
        const c = rnd.randrange(n), ty = rnd.choice([1, 2, 3, 4, 200]);
        return [c, ty, rnd.randrange(256)];
      }));
      m.events = evs.map((e) => new M.Event(...e));
    }
    let st = m.cells.findIndex((c) => !(m.tiles[c].flags & 1));
    m.start = st < 0 ? 0 : st;
    if (m.tiles[m.cells[m.start]].flags & 1) m.cells[m.start] = 0;
    M.validate(m);
  }
  return out;
}

/** MOVE (3.4): all cells x directions x actions against core/move.js; random chains (state pos/vdir/px/py
 *  between the calls), objects with bit 6/7 on the neighbouring cells, error cases. */
function testP6fMove() {
  const L = labels();
  const posA = L.pos;
  let total = 0;
  const fails = [], xs = { 0: 0, 1: 0, 2: 0 };
  const rnd = new PyRandom(6);

  /** Objects around the cell: on the neighbouring cells (also blocking), with bit 6/7, plus random ones */
  const nobjs = (m, cell) => {
    const w = m.width;
    const near = [cell - w, cell + w, cell - 1, cell + 1].filter((c) => c >= 0 && c < w * m.height);
    const n = rnd.choice([0, 0, 1, 2, 5, 16]);
    const objs = [];
    for (let i = 0; i < n; i++) {
      const c = near.length && rnd.random() < 0.7 ? rnd.choice(near) : rnd.randrange(w * m.height);
      const set = rnd.randrange(3), dir = rnd.choice([0, 1, 2, 3, 0xFF]), phase = rnd.randrange(4), q = rnd.randrange(8);
      const hidden = rnd.random() < 0.25, noblock = rnd.random() < 0.3;
      objs.push(new V.Obj(c, set, dir, phase, q, hidden, noblock));
    }
    return objs;
  };

  for (const [name, m] of moveMaps()) {
    const w = m.width, h = m.height;
    const n = w * h;
    const sc = new Scene();
    sc.call(0);
    sc.seg(P6D_ADDR.dmp, M.toDmp(m).slice(2));
    sc.call(1, 0, 0, { p: [P6D_ADDR.dmp, 0, 0, 0] });
    const exp = [];                                        // [reference, cell, direction, action]
    const cells = n <= 60 ? range(n) : [...rnd.sample(range(n), 60).sort((a, b) => a - b), 0, n - 1, w - 1, n - w];
    for (const cell of cells) {
      for (let v = 0; v < 4; v++) {
        for (let act = 0; act < 7; act++) {
          const objs = nobjs(m, cell, v);
          sc.call(2, v, 0, { p: [cell, 0, 0, 0] });
          const nn = objs.length < 16 || rnd.random() < 0.7 ? objs.length : 20;     // OBJN > 16: only 16 read
          sc.call(3, act, 0, { objn: nn, objl: objBytes(objs) });
          sc.dump(posA, 7);
          exp.push([dbemove(m, cell, v, objs, act, nn), cell, v, act]);
        }
      }
    }
    // random chain: MOVE without SETPOS in between, with fixed objects (bit 6/7 mixed)
    let cell = m.start, v = m.direction;
    sc.call(2, v, 0, { p: [cell, 0, 0, 0] });
    let objs = nobjs(m, cell, v);
    objs = [...objs, ...nobjs(m, rnd.randrange(n), 0)].slice(0, 16);
    const ob = objBytes(objs);
    for (let k = 0; k < 300; k++) {
      const act = rnd.choice([0, 0, 0, 1, 2, 3, 4, 5, 6]);
      const r = dbemove(m, cell, v, objs, act);
      sc.call(3, act, 0, { objn: objs.length, objl: ob });
      sc.dump(posA, 7);
      exp.push([r, cell, v, act]);
      cell = r.pos; v = r.dir;
    }
    const r = run(sc);
    // evaluation: call order = SETPOS, MOVE, dump per entry (chains: SETPOS first)
    const items = r.items.slice(2);
    let k = 0;
    exp.forEach(([ref, c0, v0, act], ei) => {
      let itMv, dump;
      if (ei < exp.length - 300) {
        itMv = items[k + 1]; dump = items[k + 2][1]; k += 3;
      } else {
        if (ei === exp.length - 300) k += 1;                // SETPOS of the chain
        itMv = items[k]; dump = items[k + 1][1]; k += 2;
      }
      const want = [ref.a, ref.x, ref.y, ref.p0, ref.p1, ref.p2];
      const c = itMv;
      const have = [c.a, c.x, c.y, c.p[0], c.p[1], c.p[2]];
      const stt = [dump[0] | (dump[1] << 8), dump[2], dump[5], dump[6]];
      const wst = [ref.pos, ref.dir, ref.pos % w, fdiv(ref.pos, w)];
      total++;
      xs[ref.x] = (xs[ref.x] || 0) + 1;
      if (!tupEq(have, want) || !tupEq(stt, wst)) fails.push(`${name} cell ${c0} v ${v0} action ${act}: sim ${pyr(have)} ${pyr(stt)} <> reference ${pyr(want)} ${pyr(wst)}`);
    });
    console.log(`P6f MOVE ${name} (${w}x${h}, ${m.events.length} events): ${exp.length} calls, ${fails.length} deviations so far`);
  }
  console.log(`P6f MOVE: ${total} calls compared (X = 0: ${xs[0]}, 1: ${xs[1]}, 2: ${xs[2]})`);
  // error cases: X >= 7, MOVE without MAPINIT
  const sc = new Scene();
  sc.call(0);
  sc.call(3, 0);
  const m = loadMap(DEMO_MAP);
  sc.seg(P6D_ADDR.dmp, M.toDmp(m).slice(2));
  sc.call(1, 0, 0, { p: [P6D_ADDR.dmp, 0, 0, 0] });
  sc.call(3, 7);
  sc.call(3, 255);
  sc.dump(posA, 7);
  const r = run(sc);
  const c = r.items.filter(isCall);
  const exp_ = [[5, 0, 0], [0, 7, 5], [6, 0, 0], [6, 0, 0]];     // MOVE without MAPINIT, MAPINIT (W, H), X = 7, X = 255
  c.slice(1).forEach((cc, i) => {
    if (i < exp_.length && !tupEq([cc.a, cc.x, cc.y], exp_[i])) fails.push(`Fehlerfall: A/X/Y ${pyr([cc.a, cc.x, cc.y])} <> ${pyr(exp_[i])}`);
  });
  const d = r.items[r.items.length - 1][1];
  if ((d[0] | (d[1] << 8)) !== m.start || d[2] !== m.direction) fails.push('Error case: state changed');
  for (const f of fails.slice(0, 10)) console.log('FAIL', f);
  const ok = !fails.length;
  console.log(`P6f MOVE -> ${ok ? 'ok' : 'ERROR'}`);
  return ok;
}

/** Automap bit 6 in VIEW: working copy of the content layer after every view = V.view (Scene.automap). */
function testP6fAuto() {
  const full = !!process.env.DBEVIEW_FULL;
  const A = demoAssets();
  const A2 = V.doubleFronts(A);
  const dbgBytes = A.dbgPrg.slice(2);
  const demo = loadMap(DEMO_MAP);
  let ok = true, total = 0;
  const marked = [0, 0];

  class AutoRunner extends ViewRunner {
    constructor(vcopy = false) {
      super(vcopy);
      this.mapx = 1; this.mapp1 = AUTO_ADDR;
      this.S2_AREAS = AUTO_S2;
      this.dbgBytes = dbgBytes;
      this.ref = null; this.refkey = null; this.dumps = [];
    }

    add(name, sc) {
      sc.objects = []; sc.itemtab = zeros(64);
      sc.vmsBank1 = this.bank1; sc.dtsAddr = P6D_ADDR.dts.slice();
      this.setup(sc);
      const key = M.toDmp(sc.dmp);
      if (this.refkey === null || !bytesEq(this.refkey, key)) {   // new map: MAPINIT has freshly created the copy
        this.refkey = key; this.ref = sc.dmp.clone();
      }
      sc.s2Addr = sc.s2.map((ss) => (ss !== null ? this.s2Addr(ss) : 0));
      const sc2 = sc.copy();
      sc2.dmp = this.ref; sc2.automap = true;
      const before = this.ref.content.slice();
      this._call(4, 0, 0, { p: [sc.ap, 0, 0, 0], want: [name, V.view(sc2)] });
      const n = this.ref.width * this.ref.height;
      this.scene.dump(AUTO_ADDR, 2 * n);
      this.dumps.push([name, cat(U8(this.ref.cells), U8(this.ref.content))]);
      marked[0] += before.filter((a, i) => a !== this.ref.content[i]).length;
      marked[1] += 1;
    }
  }

  const go = (label, scenes) => {
    const R = new AutoRunner();
    for (const [name, sc] of scenes) R.add(name, sc);
    const { nview, fails, codes } = R.run();
    const dumps = R.lastItems.filter((i) => !isCall(i));
    R.dumps.forEach(([name, want], i) => {
      if (i >= dumps.length) return;
      const got = dumps[i][1];
      if (!bytesEq(got, want)) {
        const badOffs = range(got.length).filter((j) => got[j] !== want[j]).slice(0, 4);
        fails.push(`${name}: working copy deviates (offsets [${badOffs.join(', ')}])`);
      }
    });
    total += nview;
    console.log(`P6f Automap ${label}: ${nview} views, ${fails.length} deviations, A-Codes ${pyDict(codes)}`);
    for (const f of fails.slice(0, 10)) console.log('FAIL', f);
    ok = ok && !fails.length;
  };

  // chains over the same map (marks accumulate): demo, abyss, open_room, corridor
  const rnd = new PyRandom(8);
  const gm = corridorMap();
  for (const [label, m] of [['demo', demo], ['abyss', abyssMap()], ['room', openRoom()], ['corridor', gm]]) {
    const fr = free(m);
    const scs = [];
    for (const bc of [false, true]) {
      for (const i of rnd.sample(fr, fr.length)) for (let v = 0; v < 4; v++) scs.push([`${label} ${i}/${v} bc${+bc}`, ms(A, m, i, v, { bandCover: bc })]);
    }
    go(label, scs);
  }
  // random (CONTENT, gaps, blocked cells), two fronts, small buffers (abort: marks up to that point)
  const [nmaps, nv] = full ? [60, 8] : [24, 6];
  let scs = [];
  for (let k = 0; k < nmaps; k++) {
    const base = V.randomScene(k, A, { nobj: 0 });
    const rr = new PyRandom(k);
    for (let j = 0; j < nv; j++) {
      const sc = base.copy();
      sc.vramBases = copyBases(base.vramBases);
      sc.pos = rr.choice(free(base.dmp)); sc.dir = rr.randrange(4);
      if (j === nv - 1) sc.buf = [0x1300, 0x1300 + rr.choice([64, 128, 256])];
      scs.push([`random ${k}/${j}`, sc]);
    }
  }
  go('random', scs);
  scs = [];
  for (const i of free(demo)) for (let v = 0; v < 4; v++) scs.push([`2F demo ${i}/${v}`, ms(A2, demo, i, v)]);
  for (let k = 0; k < 20; k++) scs.push([`2F random ${k}`, V.randomScene(1000 + k, A2, { nobj: 0 })]);
  go('two fronts', scs);
  // without working copy (X = 1, P1 = 0) and with X = 0: no marks, DMP unchanged
  for (const [label, mx] of [['X=1 without copy', 1], ['X=0 with copy', 0]]) {
    const R = new ViewRunner();
    R.dbgBytes = dbgBytes;
    R.S2_AREAS = AUTO_S2;
    R.mapx = mx; R.mapp1 = mx ? 0 : AUTO_ADDR;
    for (const i of free(demo)) for (let v = 0; v < 4; v++) R.add(`${label} ${i}/${v}`, ms(A, demo, i, v));
    const dmpRef = M.toDmp(demo);
    R.scene.dump(P6D_ADDR.dmp, dmpRef.length - 2);
    const { nview, fails } = R.run();
    const nc = R.lastItems.filter((i) => !isCall(i));
    const got = nc[nc.length - 1][1];
    if (!bytesEq(got, dmpRef.slice(2))) fails.push('DMP changed');
    console.log(`P6f Automap ${label}: ${nview} views, ${fails.length} deviations`);
    ok = ok && !fails.length;
    for (const f of fails.slice(0, 5)) console.log('FAIL', f);
  }
  console.log(`P6f automap: ${total} views, ${marked[0]} cells marked (over ${marked[1]} views) -> ${ok && marked[0] ? 'ok' : 'ERROR'}`);
  return ok && marked[0] > 0;
}

/** Cycles: MOVE per case (run with MOVE minus run with F = 7) and VIEW without/with automap. */
function testP6fCycles() {
  const A = demoAssets();
  const dbgBytes = A.dbgPrg.slice(2);
  const demo = loadMap(DEMO_MAP);

  const mvCycles = (m, cell, v, act, objs = []) => {
    const pre = new Scene();
    pre.call(0);
    pre.seg(P6D_ADDR.dmp, M.toDmp(m).slice(2));
    pre.call(1, 0, 0, { p: [P6D_ADDR.dmp, 0, 0, 0] });
    pre.call(2, v, 0, { p: [cell, 0, 0, 0] });
    const ol = objBytes(objs);
    const a = pre.clone().call(3, act, 0, { quiet: true, objn: objs.length, objl: ol });
    const b = pre.clone().call(7, act, 0, { quiet: true, objn: objs.length, objl: ol });
    return run(a).cycles - run(b).cycles;
  };

  const cases = new globalThis.Map();
  for (let cell = 0; cell < demo.width * demo.height; cell++) {
    for (let v = 0; v < 4; v++) {
      for (let act = 0; act < 7; act++) {
        const r = dbemove(demo, cell, v, [], act);
        const kind = act >= 4 ? 'turn' : (r.x === 0 ? 'step ok' : (r.x === 1 ? 'step map/SOLID' : 'object'));
        if (!cases.has(kind)) cases.set(kind, []);
        cases.get(kind).push([cell, v, act]);
      }
    }
  }
  const rnd = new PyRandom(3);
  for (const kind of [...cases.keys()].sort()) {
    const lst = cases.get(kind);
    const cy = rnd.sample(lst, Math.min(lst.length, 12)).map((c) => mvCycles(demo, ...c));
    console.log(`P6f cycles MOVE demo ${kind}: ${stats(cy)}`);
  }
  // object on the target cell: 16 objects, the blocking one last (worst case of the loop)
  const cell = demo.start;
  const tgt = cell + 1;
  const o0 = new V.Obj(0, 0, 0, 0, 4, false, false);
  const objs = [...new Array(15).fill(o0), new V.Obj(tgt, 0, 0, 0, 4)];
  console.log(`P6f cycles MOVE object, 16 objects (blocking last): ${mvCycles(demo, cell, 1, 0, objs)}`);
  // events: search over the whole list (no match), 600 events
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0)];
  let m;
  for (const ne of [0, 3, 100, 600]) {
    m = new M.Map('ev', 40, 30, t, zeros(1200), zeros(1200), range(100, 100 + ne).map((c) => new M.Event(c, 4, 1)), 0, 0, 0);
    console.log(`P6f cycles MOVE turning with ${ne} events (none at the position): ${mvCycles(m, 5, 0, 4)}`);
  }
  m.events = range(1, 601).map((c) => new M.Event(c, 4, 1));
  console.log(`P6f cycles MOVE turning, event at position 600 (last): ${mvCycles(m, 600, 0, 4)}`);
  // VIEW: automap off / on
  for (const [label, mx] of [['without automap', 0], ['with automap', 1]]) {
    const R = new ViewRunner();
    R.dbgBytes = dbgBytes;
    R.S2_AREAS = AUTO_S2;
    R.mapx = mx; R.mapp1 = mx ? AUTO_ADDR : 0;
    const gm = corridorMap();
    for (const [nm, mm] of [['Corridor', gm], ['demo', demo]]) {
      const fr = free(mm);
      const scs = fr.flatMap((i) => (mm === gm ? [1, 3] : [0, 1, 2, 3]).map((v) => ms(A, mm, i, v)));
      const cy = scs.map((sc) => timeView(R, sc));
      console.log(`P6f cycles VIEW ${nm} ${label}: ${stats(cy)}`);
    }
    const cy = range(40).map((k) => timeView(R, V.randomScene(k, A, { nobj: 0 })));
    console.log(`P6f cycles VIEW random ${label}: ${stats(cy)}`);
  }
  return true;
}

// ------------------------------------------------------------------ P6l: far view fill (5.7a)
function testP6l() {
  const A = demoAssets();
  const A2 = V.doubleFronts(A);
  const dbgBytes = A.dbgPrg.slice(2);
  const maps = [distantMap(), loadMap(join(ROOT, 'demo', 'demo.toml')), loadMap(DEMO_MAP)];
  const names = ['distant_map', 'demo/demo.toml', 'Example map'];
  let ok = true, total = 0;

  const go = (label, scenes, vcopy = false, objs = false) => {
    const R = new ViewRunner(vcopy);
    R.dbgBytes = dbgBytes;
    for (const [name, sc] of scenes) R.add(name, sc, objs);
    const { nview, fails, codes } = R.run();
    total += nview;
    console.log(`P6l sim${vcopy ? ' (VMS_COPY)' : ''} ${label}: ${nview} views, ${fails.length} deviations, A-Codes ${pyDict(codes)}`);
    for (const f of fails.slice(0, 10)) console.log('FAIL', f);
    ok = ok && !fails.length;
  };

  for (const vcopy of [false, true]) {
    maps.forEach((m, mi) => {
      const scs = [];
      let k = 0;
      for (const i of free(m)) {
        for (let v = 0; v < 4; v++) {
          k++;
          const [ff, dbg] = [[0x00, true], [0x96, false], [0x3C, true]][k % 3];
          scs.push([`${names[mi]} ${i}/${v}`, ms(A, m, i, v, { bandCover: !!(k & 4), farfill: ff, dbg, bgfill: 0x5A })]);
        }
      }
      go(names[mi], scs, vcopy);
    });
    go('random', range(120).map((k) => [`random ${k}`, V.farVariant(V.randomScene(k, A), k)]), vcopy, true);
  }
  go('two fronts', range(60).map((k) => [`2F ${k}`, V.farVariant(V.randomScene(2000 + k, A2, { nobj: 0 }), k)]));
  const ov = [];
  for (const i of every(free(maps[0]), 3)) for (let v = 0; v < 4; v++) ov.push(ms(A, maps[0], i, v, { farfill: 0 }));
  for (let k = 500; k < 520; k++) ov.push(V.farVariant(V.randomScene(k, A, { nobj: 0 }), k));
  const scs = [];
  ov.forEach((sc, n_) => {
    for (const size of [64, 128, 256, 512, 1024]) {
      const s2 = sc.copy();
      s2.buf = [0x1300, 0x1300 + size]; s2.bufFix = !!(n_ & 1);
      scs.push([`overflow ${n_} ${size}`, s2]);
    }
  });
  go('overflow', scs);
  console.log(`P6l sim: ${total} views compared byte-identical -> ${ok ? 'ok' : 'ERROR'}`);
  if (process.env.DBE_NOCYCLES) return ok;
  // cycles VIEW: demo map (demo/demo.toml) with demo assets, all free cells x 4 directions, without/with fill
  const R = new ViewRunner();
  R.dbgBytes = dbgBytes;
  const m = maps[1];
  for (const [label, ff] of [['without fill', null], ['with fill', 0]]) {
    const cy = free(m).flatMap((i) => [0, 1, 2, 3].map((v) => timeView(R, ms(A, m, i, v, { farfill: ff }))));
    console.log(`P6l cycles demo/demo.toml ${label}: n = ${cy.length}, mean ${fdiv(sum(cy), cy.length)}, max ${Math.max(...cy)}`);
  }
  return ok;
}

function main() {
  build();
  if (process.argv.includes('--build')) return 0;
  let ok = testP6a();
  ok = testP6c() && ok;
  ok = testGeomcheck() && ok;
  ok = testP6d() && ok;
  ok = testP6d(true) && ok;
  ok = testP6e() && ok;
  ok = testP6e(true) && ok;
  ok = testP6fMove() && ok;
  ok = testP6fAuto() && ok;
  ok = testP6l() && ok;
  if (!process.env.DBE_NOCYCLES) ok = testP6fCycles() && ok;
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
