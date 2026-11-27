#!/usr/bin/env node
// Proof for the zero page block of the lib (docs/specs/P6-engine.md, decisions after the P6d review, item 3).
// Port of test/vice_zp.py onto test/lib/vice.js and test/vice_view.js (same options, output and exit codes).
//
// Usage: node test/vice_zp.js [--port N] [--timeout S] [--only i|c] [--control | --funcs]
// The stub saves $63-$72 (ZPB, FAC/ARG of the interpreter) before the lib calls that use it (VIEW, GEOMSET,
// test function 253; since P6j only these), and writes the block back afterwards; the lib uses it freely there.
// test/vice/zp.bas (interpreted and as a Blitz! compilation, image 2) calls test function 253 20 times (fill block,
// wait about 330,000 cycles, check pattern) while interrupts are running (jiffy clock/keyboard, SOUND with sweep,
// MOVSPR), and afterwards checks floating point (SIN, STR$, VAL, division) and that clock and sprite kept running.
// In addition the script sets a watchpoint (read and write) on $63-$72 that is only active between JSR LIB and the
// return in the stub (breakpoints call_lib/call_ret from build/stub.lbl). Every hit with $FF00 <> $7F
// (i.e. not from the lib, e.g. from an interrupt routine with ROM) is an error.
// --control checks the method: the same run with the watchpoint on the jiffy clock $A0-$A2 must find foreign accesses
// (Kernal IRQ during the call).
// --funcs (P6j): zero page usage per function. Program and files of test/vice_view.js (all setter calls, scenes with
// SETPOS/MOVE and VIEW), plus CELL, SETCELL, SETITEM, BUFSET with X = 1 and X = 0 and unimplemented functions (7, 8, 17).
// Per lib call (breakpoints call_lib/call_ret, F = A on entry) two watchpoints (read and write) are active:
// ZPB ($63-$72) and ZP0/ZP1 ($FA-$FD); the first hit per range and call is recorded with $FF00 and the watchpoint
// is disabled until the end of the call. Expected: ZPB only for F in {4, 12} (ZPB_F1/ZPB_F2 from engine/dbe.inc, the
// functions for which the stub saves the block), no hits with $FF00 <> $7F, every function 0-16 except 7/8 called at
// least once; output: table F -> calls, ZPB, ZP0/ZP1.
// Event-driven (breakpoints, watchpoint, debug cartridge), timeout/-limitcycles only as guards; port rule as in
// vice_smoke.py (DBE_VICE_PORT), only the own VICE process is terminated.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vs from './lib/vice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = vs.ROOT, OUT = vs.OUT, VERSION = vs.VERSION;

// ------------------------------------------------------------------ Python-style output (same text as vice_zp.py)
/** repr() of a Python str. */
function pyStr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let o = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') o += '\\\\';
    else if (ch === q) o += '\\' + q;
    else if (ch === '\n') o += '\\n';
    else if (ch === '\r') o += '\\r';
    else if (ch === '\t') o += '\\t';
    else if (c < 0x20 || (c >= 0x7F && c < 0xA1) || c === 0xAD) o += '\\x' + c.toString(16).padStart(2, '0');
    else o += ch;
  }
  return o + q;
}

/** Tuple marker for pyRepr (arrays are lists). */
const tup = (...a) => ({ tuple: a });

function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return pyStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (typeof v === 'object' && v.tuple) return v.tuple.length === 1 ? `(${pyRepr(v.tuple[0])},)` : `(${v.tuple.map(pyRepr).join(', ')})`;
  return String(v);
}

/** out.strip().splitlines()[-2:] */
function lastLines(out) {
  const ls = out.trim().split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  return ls.slice(-2);
}

const pyRc = (rc) => (rc === null || rc === undefined ? 'None' : String(rc));

// ------------------------------------------------------------------ helpers
function stubLabels() {
  const d = {};
  for (const line of readFileSync(join(ROOT, 'build', 'stub.lbl'), 'latin1').split('\n')) {
    const m = /^al ([0-9A-Fa-f]+) \.(\S+)/.exec(line);
    if (m) d[m[2]] = parseInt(m[1], 16);
  }
  return d;
}

/** Disk as vice_smoke.make_disk: boot, VDC-BASIC, stub, test lib, program 't'. */
function makeDisk(d64, bootPrg, tPrg) {
  vs.sh('c1541', ['-format', 'dbe,01', 'd64', d64,
    '-write', bootPrg, 'boot',
    '-write', join(vs.VDC, 'vdcbasic3.bin'), 'vdcbasic3',
    '-write', join(ROOT, 'build', `dbe${VERSION}.stub`), `dbe${VERSION}.stub`,
    '-write', join(ROOT, 'build', `dbe${VERSION}-test.lib`), `dbe${VERSION}-test.lib`,
    '-write', tPrg, 't'], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const viceArgs = (d64, bootPrg, cycles) => ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
  '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', bootPrg, '-limitcycles', String(cycles)];

const watchNo = (t) => parseInt(/WATCH: (\d+)/.exec(t)[1], 10);

async function runOne(d64, bootPrg, port, tmo, rng = '63 72') {
  const L = stubLabels();
  const res = { errors: [], viol: [], hits: 0, calls: 0 };

  const script = async (m) => {
    const ev = await m.mem(0x300, 2);
    const errAt = ev[0] | (ev[1] << 8);
    await m.bp(errAt);
    await m.bp(L.call_lib);
    await m.bp(L.call_ret);
    const w = watchNo(await m.cmd(`watch ${rng}`));
    await m.cmd(`disable ${w}`);
    for (;;) {
      let pc, out;
      try {
        [pc, out] = await m.go();
      } catch (e) {
        if (e instanceof vs.Exited) return;
        throw e;
      }
      if (/Stop on\s+(load|store)/.test(out)) {
        res.hits++;
        const cr = (await m.mem(0xFF00, 1))[0];
        if (cr !== 0x7F) res.viol.push(tup(pc, cr, lastLines(out)));
      } else if (pc === L.call_lib) {
        res.calls++;
        await m.cmd(`enable ${w}`);
      } else if (pc === L.call_ret) {
        await m.cmd(`disable ${w}`);
      } else if (pc === errAt) {
        const [lo, hi] = await m.mem(0x3B, 2);
        res.errors.push(tup(await m.regX(), lo | (hi << 8)));
      }
    }
  };

  const [, rc] = await vs.runVice(viceArgs(d64, bootPrg, 600000000), port, tmo, script);
  return [rc, res];
}

function zpbFuncs() {
  const d = {};
  for (const line of readFileSync(join(ROOT, 'engine', 'dbe.inc'), 'latin1').split('\n')) {
    const m = /^(ZPB_F\w+)\s*=\s*(\d+)/.exec(line);
    if (m) d[m[1]] = parseInt(m[2], 10);
  }
  return new Set(Object.entries(d).filter(([k]) => k !== 'ZPB_FT').map(([, v]) => v));
}

const NAMES = ['INIT', 'MAPINIT', 'SETPOS', 'MOVE', 'VIEW', 'CELL', 'SETCELL', '(7)', '(8)', 'SPRITESET', 'ITEMSET',
  'POOLSET', 'GEOMSET', 'TEXSET', 'BGSET', 'BUFSET', 'SETITEM'];

/** --funcs: zero page usage per function (program of vice_view, extended). */
async function funcsMain(a, port) {
  const vv = await import('./vice_view.js');
  const world = new vv.World();
  const B = vv.BUF;
  const extra = ['1900 p0=0:p1=0:f=5:x=0:y=0:gosub 9500:if a<>0 then r=90:goto 8995',            // CELL 0
    '1901 t=x:i=y:p0=0:f=6:x=t:y=0:gosub 9500:if a<>0 then r=91:goto 8995',                    // SETCELL 0 (unchanged)
    '1902 p0=0:f=16:x=i:gosub 9500:if a<>0 then r=92:goto 8995',                               // SETITEM 0 (unchanged)
    `1903 p0=${B[0]}:p1=${B[1]}:f=15:x=1:gosub 9500:if a<>0 then r=93:goto 8995`,             // BUFSET X = 1
    `1904 p0=${B[0]}:p1=${B[1]}:f=15:x=0:gosub 9500:if a<>0 then r=94:goto 8995`,             // BUFSET X = 0
    '1905 for f=7 to 8:p0=0:x=0:gosub 9500:if a<>255 then r=95:goto 8995',
    '1906 next:f=17:gosub 9500:if a<>255 then r=96:goto 8995'];
  const text = vv.basicListing(world).split('\n');
  const i = text.findIndex((l) => l.startsWith('2000 '));
  if (i < 0) throw new Error('line 2000 not found in the listing');
  text.splice(i, 0, ...extra);
  mkdirSync(OUT, { recursive: true });
  const src = join(OUT, 'zpf.bas');
  writeFileSync(src, text.join('\n'));
  const prg = join(OUT, 'zpf.prg');
  vs.tok(src, prg, '0x4001');
  const bootPrg = join(OUT, 'boot.prg');
  const wd = join(OUT, 'zpf-files');
  rmSync(wd, { recursive: true, force: true });
  mkdirSync(wd);
  const d64 = join(OUT, 'zpf.d64');
  vv.makeDisk(world, d64, bootPrg, prg, wd);
  const L = stubLabels();
  const calls = new Map(), zpb = new Map(), zp01 = new Map(), foreign = [], errors = [];

  const script = async (m) => {
    const ev = await m.mem(0x300, 2);
    const errAt = ev[0] | (ev[1] << 8);
    await m.bp(errAt);
    await m.bp(L.call_lib);
    await m.bp(L.call_ret);
    const wb = watchNo(await m.cmd('watch 63 72'));
    const wz = watchNo(await m.cmd('watch fa fd'));
    await m.cmd(`disable ${wb}`);
    await m.cmd(`disable ${wz}`);
    let f = null;
    for (;;) {
      let pc, out;
      try {
        [pc, out] = await m.go();
      } catch (e) {
        if (e instanceof vs.Exited) return;
        throw e;
      }
      const hit = /#(\d+) \(Stop on\s+(load|store)/.test(out) || /Stop on\s+(load|store)/.test(out);
      if (hit) {
        const cr = (await m.mem(0xFF00, 1))[0];
        const wn = /#(\d+)/.exec(out);
        let w = wn ? parseInt(wn[1], 10) : null;
        if (w === null) w = wb;          // watchpoint number not recognized: record as ZPB
        const rng = w === wb ? zpb : zp01;
        if (cr !== 0x7F) foreign.push(tup(f, pc, cr, lastLines(out)));
        if (!rng.has(f)) rng.set(f, new Set());
        rng.get(f).add(cr);
        await m.cmd(`disable ${w}`);
      } else if (pc === L.call_lib) {
        const all = [...(await m.cmd('r')).matchAll(/\.;[0-9a-f]{4} ([0-9a-f]{2})/g)];
        f = parseInt(all[all.length - 1][1], 16);
        calls.set(f, (calls.get(f) || 0) + 1);
        await m.cmd(`enable ${wb}`);
        await m.cmd(`enable ${wz}`);
      } else if (pc === L.call_ret) {
        await m.cmd(`disable ${wb}`);
        await m.cmd(`disable ${wz}`);
        f = null;
      } else if (pc === errAt) {
        const [lo, hi] = await m.mem(0x3B, 2);
        errors.push(tup(await m.regX(), lo | (hi << 8)));
      }
    }
  };

  const [, rc] = await vs.runVice(viceArgs(d64, bootPrg, 1500000000), port, a.timeout, script);
  const want = zpbFuncs();
  const num = (x, y) => x - y;
  console.log(`--funcs (interpreted, program of vice_view.js): exit ${pyRc(rc)}, BASIC error ${pyRepr(errors)}`);
  console.log('  F  Function    Calls    ZPB $63-$72  ZP0/ZP1 $FA-$FD');
  for (const f of [...calls.keys()].sort(num)) {
    const n = f < NAMES.length ? NAMES[f] : `(${f})`;
    console.log(`  ${String(f).padEnd(3)}${n.padEnd(12)}${String(calls.get(f)).padStart(7)}  ${(zpb.has(f) ? 'yes' : 'no').padEnd(11)}  ${zp01.has(f) ? 'yes' : 'no'}`);
  }
  // sorted() of keys that may contain None (hit outside a call) would fail in Python as well; None sorts first here
  const used = [...zpb.keys()].sort((x, y) => (x === null ? -1 : y === null ? 1 : x - y));
  const wantS = [...want].sort(num);
  const missing = [];
  for (let f = 0; f < 17; f++) if (f !== 7 && f !== 8 && !calls.has(f)) missing.push(f);
  const sameSet = used.length === wantS.length && used.every((v, k) => v === wantS[k]);
  const ok = rc === 0 && !errors.length && !foreign.length && sameSet && !missing.length;
  console.log(`  ZPB used by ${pyRepr(used)}, stub saves for ${pyRepr(wantS)}; foreign accesses ${foreign.length}; `
    + `not called ${pyRepr(missing)} -> ${ok ? 'ok' : 'ERROR'}`);
  for (const v of foreign.slice(0, 10)) console.log('  foreign:', pyRepr(v));
  return ok ? 0 : 1;
}

function parseArgs(argv) {
  const a = { port: null, timeout: 300, only: null, control: false, funcs: false };
  const usage = () => { console.error('usage: vice_zp.js [--port PORT] [--timeout TIMEOUT] [--only {i,c}] [--control] [--funcs]'); process.exit(2); };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) usage(); return argv[++i]; };
    const int = (s) => { if (!/^[+-]?\d+$/.test(s.trim())) usage(); return parseInt(s, 10); };
    if (k === '--port') a.port = int(val());
    else if (k === '--timeout') a.timeout = int(val());
    else if (k === '--only') { a.only = val(); if (!['i', 'c'].includes(a.only)) usage(); }
    else if (k === '--control') a.control = true;
    else if (k === '--funcs') a.funcs = true;
    else usage();
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  vs.requireVdc();
  vs.sh('sh', [join(ROOT, 'engine', 'build.sh')], { stdio: ['ignore', 'ignore', 'inherit'] });
  mkdirSync(OUT, { recursive: true });
  const port = await vs.choosePort(a.port);
  const bootPrg = vs.makeBoot(OUT);
  if (a.funcs) return funcsMain(a, port);
  const srcBas = join(HERE, 'vice', 'zp.bas');
  let bad = 0;
  const rng = a.control ? 'a0 a2' : '63 72';

  const report = (name, rc, r) => {
    const ok = rc === 0 && (r.viol.length > 0) === a.control && !r.errors.length && r.calls >= 21;
    console.log(`${name}: exit ${pyRc(rc)}, calls ${r.calls}, watchpoint hits ${r.hits} (lib), `
      + `foreign accesses ${r.viol.length}, BASIC error ${pyRepr(r.errors)} -> ${ok ? 'ok' : 'ERROR'}`);
    for (const v of r.viol.slice(0, a.control ? 3 : 10)) console.log('  foreign:', pyRepr(v));
    return ok ? 0 : 1;
  };

  if (a.only !== 'c') {
    const prg = join(OUT, 'zp-i.prg');
    vs.tok(srcBas, prg, '0x4001');
    const d64 = join(OUT, 'zp-i.d64');
    makeDisk(d64, bootPrg, prg);
    const [rc, r] = await runOne(d64, bootPrg, port, a.timeout, rng);
    bad |= report('interpreted', rc, r);
  }
  if (a.only !== 'i') {
    const node = vs.findNode(), blitzc = vs.findBlitzc();
    if (!node || !blitzc) {
      console.log('compiled: SKIP (blitzc not found)');
      bad |= 2;
    } else {
      const prep = join(OUT, 'zp-b.bas');
      vs.sh('python3', ['-B', join(vs.VDC, 'test', 'blitzprep.py'), srcBas, prep]);
      const src = join(OUT, 'zp-src.prg');
      vs.tok(prep, src);
      const cdir = join(OUT, 'zp-blitz');
      rmSync(cdir, { recursive: true, force: true });
      const c = spawnSync(node, [blitzc, src, cdir, '--name', 'T', '--runtime', vs.blitzRuntime()], { encoding: 'utf8' });
      const cprg = join(cdir, 'c.prg');
      const hdr = existsSync(cprg) ? readFileSync(cprg).subarray(0, 2) : null;
      if (c.status || !hdr || hdr.length < 2 || hdr[0] !== 0x01 || hdr[1] !== 0x40) {
        console.log(`compiled: compiler rc ${pyRc(c.status)}: ${(c.stdout || '').trim()}`);
        bad |= 1;
      } else {
        const d64 = join(OUT, 'zp-c.d64');
        makeDisk(d64, bootPrg, cprg);
        const [rc, r] = await runOne(d64, bootPrg, port, a.timeout, rng);
        bad |= report('compiled (Blitz!, image 2)', rc, r);
      }
    }
  }
  return bad ? 1 : 0;
}

main().then((rc) => { process.exitCode = rc; }, (e) => { console.error(e); process.exitCode = 1; });
