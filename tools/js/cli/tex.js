// dbe tex: command line of core/tex.js, same commands, options and texts as tools/dbetex.py.
//   tex build  TEX.toml [--out DIR] [--strict] [--key RRGGBB] [--alpha-threshold N] [--no-preview]
//   tex bg     BG.toml  [--out DIR] [--strict]
//   tex dump   FILE.dts|FILE.dbg [--vrl FILE.vrl] [--json]
//   tex budget FILE... --pool N [--pool-start ADDR] [--vms-buffer N] [--json]
//   tex check  MAP.dmp|MAP.toml [--walls W.dts] [--floors F.dts] [--ceils C.dts] [--dvg G.dvg]
// texCli(argv, io) returns the exit code (0 ok, 1 budget exceeded / check errors); format and validation errors are
// thrown (TexError, MapError, VrlError ...), usage errors as Error with .usage = true. runTex(argv) wraps that like
// the Python main(): {code, stdout, stderr} with "Error: <message>" and exit codes 0/1/2.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve as presolve } from 'node:path';
import * as T from '../core/tex.js';
import * as vrl from '../core/vrl.js';
import { loadsToml, fromDmp, pyRepr } from '../core/map.js';
import { encodePng } from '../core/io/png.js';

export function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

/** File resolver of the CLI: bytes, or null if the file does not exist (core formats the Python OSError text). */
export function fsResolve(p) {
  try {
    return new Uint8Array(readFileSync(p));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'EISDIR') throw new Error(`[Errno 21] Is a directory: ${pyRepr(p)}`);
    throw e;
  }
}

/** Python int(s, 0) / dbetex._addr. */
export function pyInt0(s) {
  const t = String(s).trim().replace(/_/g, '');
  let m;
  if ((m = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 16);
  if ((m = /^([+-]?)0[oO]([0-7]+)$/.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 8);
  if ((m = /^([+-]?)0[bB]([01]+)$/.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 2);
  if (/^[+-]?(0+|[1-9]\d*)$/.test(t)) return parseInt(t, 10);
  return NaN;
}

export function addr(s) {
  s = String(s).trim();
  const v = s.startsWith('$') ? (/^[0-9a-fA-F_]+$/.test(s.slice(1)) ? parseInt(s.slice(1).replace(/_/g, ''), 16) : NaN) : pyInt0(s);
  if (Number.isNaN(v)) throw usage(`invalid _addr value: '${s}'`);
  if (!(v >= 0 && v <= 0xFFFF)) throw usage('Address outside 0 ... 65535: ' + s);
  return v;
}

/** Minimal argparse: flags {name: 'bool'|'int'|'str'|'addr'}; pos: positional names (last may be '...' list). */
export function parse(argv, flags, pos, defaults = {}, required = []) {
  const res = { ...defaults }, args = [];
  for (const k of Object.keys(flags)) if (!(k in res)) res[k] = flags[k] === 'bool' ? false : null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      let name = a.slice(2), val = null;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      name = name.replace(/-/g, '_');
      if (!(name in flags)) throw usage(`unrecognized arguments: ${a}`);
      if (flags[name] === 'bool') { res[name] = true; continue; }
      if (val === null) {
        if (i + 1 >= argv.length) throw usage(`argument ${a}: expected one argument`);
        val = argv[++i];
      }
      if (flags[name] === 'int') {
        if (!/^\s*[+-]?\d+\s*$/.test(val)) throw usage(`argument ${a}: invalid int value: '${val}'`);
        res[name] = parseInt(val, 10);
      } else if (flags[name] === 'addr') res[name] = addr(val);
      else res[name] = val;
    } else args.push(a);
  }
  const many = pos.length && pos[pos.length - 1].endsWith('...');
  const need = many ? pos.length : pos.length;
  if (args.length < need) throw usage(`the following arguments are required: ${pos.slice(args.length).map((p) => p.replace('...', '')).join(', ')}`);
  if (!many && args.length > pos.length) throw usage(`unrecognized arguments: ${args.slice(pos.length).join(' ')}`);
  pos.forEach((n, i) => { if (n.endsWith('...')) res[n.slice(0, -3)] = args.slice(i); else res[n] = args[i]; });
  for (const r of required) if (res[r] === null) throw usage(`the following arguments are required: --${r.replace(/_/g, '-')}`);
  return res;
}

/** dbetex.write: creates the directory; strings as UTF-8. */
export function write(path, data) {
  mkdirSync(dirname(path) || '.', { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : data);
}

const read = (p) => T.readVia(fsResolve, p);
const n = T.groupThousands;
const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

function cmdBuild(a, io) {
  const path = presolve(a.toml);
  const r = T.buildTex(read(a.toml), {
    path, resolve: fsResolve, out: a.out, strict: a.strict, key: a.key, alphaThreshold: a.alpha_threshold, preview: !a.no_preview,
  });
  const out = r.conf.out;
  for (const [name, data] of Object.entries(r.files)) write(join(out, name), data);
  for (const p of r.previews) write(join(out, p.name), encodePng(p.image));
  const rp = r.report;
  io.out(`${r.conf.name}: ${r.ts.styles.length} styles, ${r.ts.entries.length} images, VRAM ${n(rp.vram)} bytes, `
    + `VRL ${n(rp.vrl_bytes)} bytes, VMS bound ${n(rp.vms_bound)}/${T.VMS_BUFFER}`);
  for (const w of r.warnings) io.err('Warning: ' + w);
  return 0;
}

function cmdBg(a, io) {
  const r = T.buildBg(read(a.toml), { path: presolve(a.toml), resolve: fsResolve, out: a.out, strict: a.strict });
  for (const [name, data] of Object.entries(r.files)) write(join(r.conf.out, name), data);
  io.out(`${r.conf.name}: wallpaper, VRAM ${r.vram.length} bytes, VRL ${r.stream.length} bytes`);
  for (const w of r.warnings) io.err('Warning: ' + w);
  return 0;
}

const pyVal = (v) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'number' ? String(v) : T.pyStr(v));

/** dbetex dump as data: {kind: 'dbg'|'dts', data, text} (text = lines of the non-JSON output). */
export function dumpData(data, file, vrlData = null, geomJson = null) {
  const k = T.fileKind(data, file);
  let vramdata = null, vinfo = null;
  if (vrlData) {
    const { u, stream } = vrl.unpackFile(vrlData);
    vramdata = vrl.decode(stream);
    vinfo = { u, crc: T.crcHqx(vramdata, 0xFFFF) };
  }
  if (k === 's2') throw new T.TexError(`${file}: sprite set - use dbespr.py dump`);
  if (k === 'dbg') {
    const bg = T.fromDbg(data);
    if (vinfo) {
      bg.vrl_check = { u_ok: vinfo.u === bg.u, crc_ok: vinfo.crc === bg.crc };
      if (!(bg.vrl_check.u_ok && bg.vrl_check.crc_ok)) throw new T.TexError('VRL does not match the DBG (U/CRC)');
    }
    return { kind: 'dbg', data: bg, text: [Object.entries(bg).map(([kk, v]) => `${kk}: ${pyVal(v)}`).join('\n')] };
  }
  const ts = T.fromDts(data, vramdata);
  if (vinfo && (vinfo.u !== ts.u || vinfo.crc !== ts.crc)) {
    throw new T.TexError(`VRL does not match the DTS: U ${vinfo.u} / ${ts.u}, CRC ${h4(vinfo.crc)} / ${h4(ts.crc)}`);
  }
  let names = null;
  if (geomJson) {
    try {
      const g = T.loadGeom(() => geomJson, 'geom.json');
      if (g.geometry_id === ts.geometryId) names = T.slotInfos(g, T.KIND_NAMES[ts.kind]).slots;
    } catch (e) {
      if (!(e instanceof T.TexError)) throw e;
    }
  }
  const d = {
    kind: T.KIND_NAMES[ts.kind], geometry_id: ts.geometryId, ne: ts.ne, depth: ts.depth, ns: ts.ns,
    nst: ts.styles.length, ni: ts.entries.length, nk: ts.nk, u: ts.u, crc: ts.crc, stride: ts.stride,
    length: ts.total, slot_map: ts.slotMap, styles: ts.styles,
    entries: ts.entries.map((e, i) => ({
      index: i, slot: e.slot, name: names ? names[e.slot].name : null, flags: e.flags, h: e.h, source: e.source,
      edge_ofs: e.edgeOfs, edge_len: e.edgeLen, vms_len: e.vms.length,
      cores: e.cores.map((kk) => ({ src: kk.src, dx: kk.dx, dy: kk.dy, w: kk.w, h: kk.h, srcstep: kk.srcstep })),
      fill: Array.from(e.fill),
    })),
  };
  const text = [`DTS ${d.kind} ID ${d.geometry_id} NE ${d.ne} D ${d.depth} NS ${d.ns} NST ${d.nst} `
    + `NI ${d.ni} NK ${d.nk} U ${d.u} CRC ${h4(d.crc)} stride ${d.stride} length ${d.length}`,
  'Slot map: ' + T.pyStr(ts.slotMap)];
  ts.styles.forEach((s, i) => text.push(`Style ${i}: ` + s.map(T.h2).join(' ')));
  for (const e of d.entries) {
    text.push(`Image ${e.index}: slot ${e.slot} ${e.name || ''} flags ${e.flags.toString(16).toUpperCase()} h ${e.h} `
      + `cores ${e.cores.length} edge ${e.edge_len} vms ${e.vms_len}`);
  }
  return { kind: 'dts', data: d, text };
}

function cmdDump(a, io) {
  const data = read(a.file);
  const vrlData = a.vrl ? read(a.vrl) : null;
  const gj = a.file.replace(/\.[^./]*$/, '') + '.geom.json';
  const geomJson = T.fileKind(data, a.file) === 'dts' && existsSync(gj) ? new Uint8Array(readFileSync(gj)) : null;
  const r = dumpData(data, a.file, vrlData, geomJson);
  if (a.json) io.out(T.pyDumps(r.data, { indent: 1 }));
  else for (const l of r.text) io.out(l);
  return 0;
}

/** dbetex cmd_budget (also used by dbespr budget). */
export function cmdBudget(a, io, resolve = fsResolve) {
  const r = T.budget(a.files, a.pool, { vmsBuffer: a.vms_buffer, poolStart: a.pool_start, resolve });
  if (a.json) io.out(T.pyDumps(r, { indent: 1, floats: T.REPORT_FLOATS }));
  else {
    for (const f of r.files) {
      const base = 'base' in f ? `  base ${h4(f.base)}` : '';
      io.out(`${f.file}: ${f.kind}, U ${f.u}, ${T.pyFixed(100 * f.share, 1)} % of the pool${base}`);
    }
    io.out(`Sum ${r.sum} / Pool ${r.pool}, free for sprites: ${r.free}`);
    io.out(`VMS bound ${r.vms_sum} / ${r.vms_buffer}` + (r.vms_over ? ' - warning: buffer too small' : ''));
  }
  if (r.over) { io.err(`Pool exceeded by ${r.over} bytes`); return 1; }
  return 0;
}

function cmdCheck(a, io) {
  const data = read(a.map);
  const m = a.map.endsWith('.toml') ? loadsToml(data, a.map) : fromDmp(data);
  const opt = (p) => (p ? [p, read(p)] : null);
  const r = T.check(m, { walls: opt(a.walls), floors: opt(a.floors), ceils: opt(a.ceils), dvg: opt(a.dvg) });
  if (r.errors.length) {
    for (const e of r.errors) io.err('Error: ' + e);
    return 1;
  }
  io.out(`check: ok (${r.used} tiles checked)`);
  return 0;
}

export const COMMANDS = {
  build: [{ out: 'str', strict: 'bool', key: 'str', alpha_threshold: 'int', no_preview: 'bool' }, ['toml'], cmdBuild],
  bg: [{ out: 'str', strict: 'bool' }, ['toml'], cmdBg],
  dump: [{ vrl: 'str', json: 'bool' }, ['file'], cmdDump],
  budget: [{ pool: 'int', pool_start: 'addr', vms_buffer: 'int', json: 'bool' }, ['files...'], cmdBudget,
    { vms_buffer: T.VMS_BUFFER }, ['pool']],
  check: [{ walls: 'str', floors: 'str', ceils: 'str', dvg: 'str' }, ['map'], cmdCheck],
};

export function texCli(argv, io) {
  const c = COMMANDS[argv[0]];
  if (!c) throw usage(`argument cmd: invalid choice: ${argv[0] === undefined ? 'None' : `'${argv[0]}'`} (choose from build, bg, dump, budget, check)`);
  const [flags, pos, fn, defaults = {}, required = []] = c;
  return fn(parse(argv.slice(1), flags, pos, defaults, required), io);
}

/** Python-style main: {code, stdout, stderr} (stdout/stderr as text with "\n" per line). */
export function runTex(argv, cli = texCli) {
  const out = [], err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  let code;
  try {
    code = cli(argv, io);
  } catch (e) {
    if (e && e.usage) { err.push(`usage error: ${e.message}`); code = 2; }
    else if (e instanceof Error && (e.name !== 'Error' || e instanceof vrl.VrlError || e.code)) { err.push(`Error: ${e.message}`); code = 1; }
    else throw e;
  }
  const txt = (l) => l.map((s) => s + '\n').join('');
  return { code, stdout: txt(out), stderr: txt(err) };
}

export default texCli;
