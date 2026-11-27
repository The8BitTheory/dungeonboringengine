#!/usr/bin/env node
// P6g analysis: VCL cost per entry and per VMS command in VICE (scenes from test/vice_view.js, interpreted only).
// Port of test/vice_vclprof.py onto tools/js/core/view.js, test/lib/vice.js and test/vice_view.js
// (same options, output, JSON file and exit codes).
//
// Usage: node test/vice_vclprof.js [--port N] [--timeout S] [--static] [--json FILE]
//   --static  model only: entries by origin, bytes written, overdraw (no VICE)
//
// Breakpoints (monitor stopwatch) in the VCL interpreter of VDC-BASIC v3: entry `vcl`, `.vcl_next_command` (before each
// entry), `.vcl_done` (end), in VMS `.vms_arg_loop` (before each command) and `.vms_done`. The local labels are not
// in vdcbasic3.sym; they are read from the ACME report (`acme -r`, build of a copy in the temp directory, checked
// against vdcbasic3.bin; vice.js vdcLabels). Between `vcl` and `.vcl_done` the I flag is set (no Kernal IRQs).
// Event-driven: breakpoints, debug cartridge; timeout only as a guard. Port as in vice_view.js (DBE_VICE_PORT).
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as V from '../tools/js/core/view.js';
import * as vv from './vice_view.js';
import * as vs from './lib/vice.js';

const ROOT = vs.ROOT, OUT = vs.OUT;

// ------------------------------------------------------------------ Origin of the entries (mark the reference)
// The View methods are wrapped on the prototype (the Python version patches dbeview._View the same way).
const P = V.View.prototype;
const KN = { [V.KIND_WALL]: 'wall', [V.KIND_FLOOR]: 'floor', [V.KIND_CEIL]: 'ceiling' };
const orig = { wallItem: P.wallItem, bandItem: P.bandItem, bgItem: P.bgItem, objects: P.objects, add: P.add, output: P.output };

P.wallItem = function (kind, e, ent) {
  const it = orig.wallItem.call(this, kind, e, ent);
  it.tag = kind === V.KIND_WALL ? 'wall' : 'tile';
  it.tagk = KN[kind];
  return it;
};

P.bandItem = function (kind, ent, y0, rows, c0, c1) {
  const it = orig.bandItem.call(this, kind, ent, y0, rows, c0, c1);
  it.tag = 'band'; it.tagk = KN[kind];
  return it;
};

P.bgItem = function (...a) {
  const it = orig.bgItem.apply(this, a);
  it.tag = 'wallpaper'; it.tagk = 'wallpaper';
  return it;
};

P.objects = function (...a) {
  this._inObj = true;
  try {
    return orig.objects.apply(this, a);
  } finally {
    this._inObj = false;
  }
};

P.add = function (item) {
  if (this._inObj) { item.tag = 'sprite'; item.tagk = 'sprite'; }
  return orig.add.call(this, item);
};

P.output = function () {
  const res = orig.output.call(this);
  const tags = [];
  this.items.forEach((item, i) => {
    for (const e of item.ents) tags.push([item.tag, item.tagk, e[0], i]);
  });
  res.tags = tags.reverse();                     // order of the VCL list (back -> front)
  return res;
};

// ------------------------------------------------------------------ Python-compatible output
const die = (msg) => { console.error(msg); process.exit(1); };
const sw = (v) => (v > 32767 ? v - 65536 : v);
const inc = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

/** format(x, '.<f>f') as in Python (round half to even on exact ties; toFixed rounds them up). */
function pyFixed(x, f) {
  const s = x.toFixed(f);
  const long = Math.abs(x).toFixed(Math.min(100, f + 60));
  const tail = long.slice(long.indexOf('.') + 1 + f);
  if (!/^50*$/.test(tail)) return s;
  // exact tie: toFixed picked the larger magnitude; Python picks the even last digit
  const digits = s.replace('-', '').replace('.', '');
  if (Number(digits[digits.length - 1]) % 2 === 0) return s;
  const down = (Math.trunc(Math.abs(x) * 10 ** f) / 10 ** f).toFixed(f);
  return (x < 0 ? '-' : '') + down;
}

/** json.dump with Python's default separators (Map = dict with int keys, insertion order). */
function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
  const ent = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return `{${ent.map(([k, x]) => `${JSON.stringify(String(k))}: ${pyJson(x)}`).join(', ')}}`;
}

const pyRepr = (v) => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False'
  : Array.isArray(v) ? `[${v.map(pyRepr).join(', ')}]` : String(v));

// ------------------------------------------------------------------ Decompose entries, count bytes
/** Per VCL entry {type, tag, kind, et, item, rows, bytes, cmds (Map), cbytes, writes: [[adr, n]], ...}. */
function entries(res) {
  const b0 = res.bank0(), b1 = res.bank1();
  let p = res.l0;
  const out = [];
  const w = (i) => b0[p + i] | (b0[p + i + 1] << 8);
  for (const [tag, kind, et, item] of res.tags) {
    const t = b0[p];
    const E = { type: t, tag, kind, et, item, rows: 0, bytes: 0, cmds: new Map(), cbytes: 0, writes: [] };
    if ([2, 3, 4, 5].includes(t)) {
      const cnt = w(5);
      const reps = [2, 3, 5].includes(t) ? ((w(7) & 255) || 256) : 1;
      const step = [2, 3, 5].includes(t) ? sw(w(9)) : 0;
      const dst = [2, 3].includes(t) ? w(3) : w(1);
      E.rows = reps; E.bytes = cnt * reps; E.cnt = cnt;
      for (let r = 0; r < reps; r++) E.writes.push([(dst + r * step) & 0xFFFF, cnt]);
      p += { 2: 11, 3: 13, 4: 7, 5: 11 }[t];
    } else if (t === 9 || t === 12) {
      const mem = t === 9 ? b1 : b0;
      const dst = w(3), a = w(5);
      const n = mem[a + 1] | (mem[a + 2] << 8);
      let q = a + 3;
      for (let k = 0; k < n; k++) {
        const c = mem[q];
        inc(E.cmds, c);
        (E.seq || (E.seq = [])).push(c);
        if (c === 1) {
          const ofs = mem[q + 1] | (mem[q + 2] << 8), ln = mem[q + 3];
          E.writes.push([(dst + ofs) & 0xFFFF, ln]);
          E.cbytes += ln;
          q += 4;
        } else if (c === 8) {
          const ofs = mem[q + 1] | (mem[q + 2] << 8);
          E.writes.push([(dst + ofs) & 0xFFFF, 1]);
          q += 3;
        } else if (c === 3) {
          E.writes.push([null, 0]);
          q += 3;
        } else die(`VMS command ${c}`);
      }
      E.bytes = E.cbytes + (E.cmds.get(8) || 0);
      E.ncmd = n;
      p += 7;
    } else die(`VCL type ${t} unexpected`);
    out.push(E);
  }
  if (b0[p] !== 0) throw new Error('AssertionError: end of the VCL list not reached');
  return out;
}

/** Category for the table. */
function cat(E) {
  const { tag, type: t } = E;
  if (tag === 'wallpaper') return [4, 5].includes(t) ? 'Wallpaper VMF (rows above/below panorama)' : 'Wallpaper VMC (panorama)';
  if (tag === 'sprite') return [2, 3].includes(t) ? 'Sprite VMC (kernels)' : `Sprite VMS (type ${t})`;
  if (tag === 'wall') return [2, 3].includes(t) ? 'Wall VMC (kernels)' : ([4, 5].includes(t) ? 'Wall VMF (ROWS)' : `Wall VMS (type ${t})`);
  const k = tag === 'tile' ? 'Tile' : 'Band';
  if ([4, 5].includes(t)) return `${k} VMF (gradient/ROWS)`;
  return [2, 3].includes(t) ? `${k} VMC (kernels)` : `${k} VMS (type ${t})`;
}

/** Write counter per window byte: {total written, window, window bytes >= 1 time, overdrawn-written per category}. */
function overdraw(sc, ents) {
  const g = sc.dvg;
  const win = new Map();
  for (let y = 0; y < g.vh; y++) for (let x = 0; x < g.vw; x++) win.set((sc.ap + g.row(y) + x) & 0xFFFF, 0);
  const last = new Map();
  const wasted = new Map();
  let total = 0;
  for (const E of ents) {
    const c = cat(E);
    for (const [a, n] of E.writes) {
      for (let i = 0; i < n; i++) {
        const ad = (a + i) & 0xFFFF;
        total++;
        if (last.has(ad)) inc(wasted, last.get(ad));
        last.set(ad, c);
        if (win.has(ad)) win.set(ad, win.get(ad) + 1);
        else inc(wasted, 'OUTSIDE');
      }
    }
  }
  let covered = 0;
  for (const v of win.values()) if (v) covered++;
  return { total, window: win.size, covered, wasted };
}

// ------------------------------------------------------------------ VICE run
async function runProf(d64, bootPrg, port, tmo, L) {
  const res = { scenes: [], errors: [], end: false };

  const script = async (m) => {
    const ev = await m.mem(0x300, 2);
    const errAt = ev[0] | (ev[1] << 8);
    await m.bp(errAt);
    for (const a of [vv.M_VIEW, vv.M_DONE, vv.M_END]) await m.bp(a);
    const names = { vcl: 'c', '.vcl_next_command': 'n', '.vcl_done': 'e', '.vms_arg_loop': 'v', '.vms_done': 'd' };
    const at = new Map(Object.entries(names).map(([k, v]) => [L[k], v]));
    const ids = [];
    for (const a of at.keys()) ids.push(await m.bp(a));
    for (const i of ids) await m.cmd(`disable ${i}`);
    let evs = [], fl = 0;
    const hex2 = (v) => v.toString(16).padStart(2, '0');
    for (;;) {
      let pc;
      try {
        [pc] = await m.go();
      } catch (e) {
        if (e instanceof vs.Exited) return;
        throw e;
      }
      if (pc === errAt) {
        res.errors.push(res.scenes.length);
        m.send('quit\n');
        return;
      }
      if (pc === vv.M_VIEW) {
        evs = [];
        for (const i of ids) await m.cmd(`enable ${i}`);
      } else if (at.has(pc)) {
        const k = at.get(pc);
        if (k === 'c') {
          await m.cmd('stopwatch reset');
          fl = await vv.flags(m);
          await m.cmd(`r fl = $${hex2(fl | 4)}`);
          evs.push(['c', 0]);
        } else {
          evs.push([k, await vv.stopwatch(m)]);
          if (k === 'e') await m.cmd(`r fl = $${hex2(((await vv.flags(m)) & ~4) | (fl & 4))}`);
        }
      } else if (pc === vv.M_DONE) {
        for (const i of ids) await m.cmd(`disable ${i}`);
        res.scenes.push(evs);
      } else if (pc === vv.M_END) res.end = true;
    }
  };

  const args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
    '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', bootPrg,
    '-limitcycles', '3000000000'];
  const [, rc] = await vs.runVice(args, port, tmo, script);
  return [rc, res];
}

/** Events of a scene -> [total, [entry: {t, vms: [command times], v0, vd}], time of the end byte, first 'n']. */
function split(ev) {
  if (!(ev[0][0] === 'c' && ev[ev.length - 1][0] === 'e')) throw new Error(`AssertionError: ${JSON.stringify(ev.slice(0, 3))}`);
  const nIdx = [];
  ev.forEach(([k], i) => { if (k === 'n') nIdx.push(i); });
  const out = [];
  nIdx.forEach((i, j) => {
    const t0 = ev[i][1];
    const nxt = j + 1 < nIdx.length ? nIdx[j + 1] : ev.length - 1;
    const t1 = ev[nxt][1];
    const inner = ev.slice(i + 1, nxt);
    const vt = inner.filter(([k]) => k === 'v').map(([, t]) => t);
    const dt = inner.filter(([k]) => k === 'd').map(([, t]) => t);
    const cmds = [];
    if (vt.length) {
      const ends = [...vt.slice(1), ...dt.slice(0, 1)];
      for (let q = 0; q < Math.min(vt.length, ends.length); q++) cmds.push(ends[q] - vt[q]);
    }
    out.push({ t: t1 - t0, vms: cmds, v0: vt.length ? vt[0] - t0 : null, vd: dt.length ? t1 - dt[0] : null });
  });
  // the last 'n' reads the end byte: that is not an entry
  const last = out.pop();
  return [ev[ev.length - 1][1], out, last.t, nIdx.length ? ev[nIdx[0]][1] : []];
}

function parseArgs(argv) {
  const a = { port: null, timeout: 3600, static: false, json: null };
  const usage = () => { console.error('usage: vice_vclprof.js [--port PORT] [--timeout TIMEOUT] [--static] [--json JSON]'); process.exit(2); };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) usage(); return argv[++i]; };
    const int = (s) => { if (!/^[+-]?\d+$/.test(s.trim())) usage(); return parseInt(s, 10); };
    if (k === '--port') a.port = int(val());
    else if (k === '--timeout') a.timeout = int(val());
    else if (k === '--static') a.static = true;
    else if (k === '--json') a.json = val();
    else usage();
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  vs.requireVdc();
  vs.sh('sh', [join(ROOT, 'engine', 'build.sh')], { stdio: ['ignore', 'ignore', 'inherit'] });
  const world = new vv.World();
  const exp = world.expected();
  const stat = exp.map((e) => {
    const ents = entries(e.res);
    return { name: e.step.name, ents, od: overdraw(e.scene, ents) };
  });
  const out = { scenes: [] };
  for (const s of stat) {
    out.scenes.push({ name: s.name, od: { ...s.od, wasted: new Map(s.od.wasted) },
      ents: s.ents.map((E) => {
        const o = {};
        for (const [k, v] of Object.entries(E)) if (k !== 'writes') o[k] = v instanceof Map ? new Map(v) : v;
        return o;
      }) });
  }
  if (!a.static) {
    const L = vs.vdcLabels();
    mkdirSync(OUT, { recursive: true });
    const port = await vs.choosePort(a.port);
    const bootPrg = vs.makeBoot(OUT);
    const srcBas = join(OUT, 'view.bas');
    writeFileSync(srcBas, vv.basicListing(world));
    const wd = join(OUT, 'prof-files');
    rmSync(wd, { recursive: true, force: true });
    mkdirSync(wd);
    const prg = join(OUT, 'view-i.prg');
    vs.tok(srcBas, prg, '0x4001');
    const d64 = join(OUT, 'prof-i.d64');
    vv.makeDisk(world, d64, bootPrg, prg, wd);
    const [rc, got] = await runProf(d64, bootPrg, port, a.timeout, L);
    console.log(`VICE: exit ${rc === null ? 'None' : rc}, errors ${pyRepr(got.errors)}, end ${pyRepr(got.end)}, scenes ${got.scenes.length}`);
    if (got.scenes.length !== exp.length || got.errors.length) return 1;
    for (let i = 0; i < stat.length; i++) {
      const s = stat[i], ev = got.scenes[i], o = out.scenes[i];
      const [total, per, tail, head] = split(ev);
      if (per.length !== s.ents.length) die(`${s.name}: ${per.length} entries measured, ${s.ents.length} expected`);
      o.total = total; o.tail = tail; o.head = head;
      o.ents.forEach((E, k) => {
        const Pm = per[k];
        E.t = Pm.t; E.vmsc = Pm.vms; E.v0 = Pm.v0; E.vd = Pm.vd;
        if ((E.type === 9 || E.type === 12) && Pm.vms.length !== E.ncmd) {
          die(`${s.name}: VMS ${Pm.vms.length} commands measured, ${E.ncmd} expected`);
        }
      });
    }
  }
  if (a.json) writeFileSync(a.json, pyJson(out));
  // Short report
  const agg = new Map();
  for (const o of out.scenes) {
    for (const E of o.ents) {
      const k = cat(E);
      if (!agg.has(k)) agg.set(k, { n: 0, bytes: 0, rows: 0, cmds: 0, t: 0 });
      const c = agg.get(k);
      c.n += 1;
      c.bytes += E.bytes;
      c.rows += E.rows;
      for (const v of E.cmds.values()) c.cmds += v;
      c.t += E.t ?? 0;
    }
  }
  const n = out.scenes.length;
  console.log(`${'Category'.padEnd(42)} ${'Entries'.padStart(7)} ${'Rows'.padStart(7)} ${'VMS cmds'.padStart(8)} ${'Bytes'.padStart(8)} ${'Cycles'.padStart(9)}  (per scene)`);
  const key = (k) => (-agg.get(k).t) || (-agg.get(k).bytes);
  for (const k of [...agg.keys()].sort((x, y) => key(x) - key(y))) {
    const c = agg.get(k);
    console.log(`${k.padEnd(42)} ${pyFixed(c.n / n, 1).padStart(7)} ${pyFixed(c.rows / n, 1).padStart(7)} ${pyFixed(c.cmds / n, 1).padStart(8)} `
      + `${pyFixed(c.bytes / n, 0).padStart(8)} ${pyFixed(c.t / n, 0).padStart(9)}`);
  }
  const tb = out.scenes.reduce((s, o) => s + o.od.total, 0) / n;
  console.log(`written per scene ${pyFixed(tb, 0)} bytes, window ${out.scenes[0].od.window} bytes`);
  return 0;
}

main().then((rc) => { process.exitCode = rc; }, (e) => { console.error(e); process.exitCode = 1; });
