// dbe spr: command line of core/spr.js, same commands, options and texts as tools/dbespr.py.
//   spr build   SPR.toml [--out DIR] [--strict] [--key RRGGBB] [--no-preview]
//   spr dump    FILE.s2 [--vrl FILE.vrl] [--json]
//   spr preview FILE.s2 --vrl FILE.vrl --geom G.json [--d D] [--phase F] [--angle A] [--out PNG]
//   spr budget  FILE... --pool N [--pool-start ADDR] [--vms-buffer N] [--json]
// sprCli(argv, io) returns the exit code (0/1); usage errors are thrown with .usage = true, format/validation errors
// as TexError (the caller prints "Error: <message>", exit code 1). runSpr(argv) does that and collects the output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as presolve, dirname, join } from 'node:path';
import * as S from '../core/spr.js';
import * as T from '../core/tex.js';
import * as vrl from '../core/vrl.js';
import { encodePng } from '../core/io/png.js';
import { pyRepr } from '../core/map.js';

export function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

/** File resolver of the CLI: bytes, or null for a missing file (readVia formats the Python message). */
export function fileResolver(p) {
  try {
    return new Uint8Array(readFileSync(p));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'EISDIR') throw new Error(`[Errno 21] Is a directory: ${pyRepr(p)}`);
    throw e;
  }
}

const read = (p) => T.readVia(fileResolver, p);

function pyInt(v) {
  if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(v)) return null;
  return parseInt(v.replace(/_/g, '').trim(), 10);
}

/** dbetex._addr: $hex or Python int(s, 0); 0 ... 65535. */
export function addr(s) {
  s = String(s).trim();
  let v = null;
  const body = s.replace(/_/g, '');
  if (s.startsWith('$')) v = /^\$[0-9a-fA-F]+(_[0-9a-fA-F]+)*$/.test(s) ? parseInt(body.slice(1), 16) : null;
  else if (/^[+-]?0[xX]_?[0-9a-fA-F]+(_[0-9a-fA-F]+)*$/.test(s)) v = parseInt(body.replace(/0[xX]/, ''), 16);
  else if (/^[+-]?0[oO]_?[0-7]+(_[0-7]+)*$/.test(s)) v = parseInt(body.replace(/0[oO]/, ''), 8);
  else if (/^[+-]?0[bB]_?[01]+(_[01]+)*$/.test(s)) v = parseInt(body.replace(/0[bB]/, ''), 2);
  else if (/^[+-]?([1-9](_?\d)*|0(_?0)*)$/.test(s)) v = parseInt(body, 10);
  if (v === null || Number.isNaN(v)) throw usage(`invalid _addr value: ${pyRepr(s)}`);
  if (!(v >= 0 && v <= 0xFFFF)) throw usage(`Address outside 0 ... 65535: ${s}`);
  return v;
}

/** Small argparse: flags {name: 'bool'|'int'|'str'|'addr'}, positional names (last may be '+'), required options. */
export function parse(argv, { flags = {}, pos = [], rest = false, required = [], defaults = {} }) {
  const res = { ...defaults }, args = [];
  for (const [k, t] of Object.entries(flags)) if (!(k in res)) res[k] = t === 'bool' ? false : null;
  const names = Object.keys(flags);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      let val = null;
      const eq = a.indexOf('=');
      if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
      let name = a.slice(2).replace(/-/g, '_');
      if (!(name in flags)) {
        const m = names.filter((n) => n.startsWith(name));
        if (m.length !== 1) throw usage(`unrecognized arguments: ${argv[i]}`);
        name = m[0];
      }
      const t = flags[name];
      if (t === 'bool') { if (val !== null) throw usage(`argument ${a}: ignored explicit argument ${pyRepr(val)}`); res[name] = true; continue; }
      if (val === null) {
        if (i + 1 >= argv.length) throw usage(`argument ${a}: expected one argument`);
        val = argv[++i];
      }
      if (t === 'int') {
        const v = pyInt(val);
        if (v === null) throw usage(`argument ${a}: invalid int value: ${pyRepr(val)}`);
        res[name] = v;
      } else if (t === 'addr') res[name] = addr(val);
      else res[name] = val;
    } else args.push(a);
  }
  if (args.length < pos.length) throw usage(`the following arguments are required: ${pos.slice(args.length).join(', ')}`);
  if (!rest && args.length > pos.length) throw usage(`unrecognized arguments: ${args.slice(pos.length).join(' ')}`);
  pos.forEach((n, i) => { res[n] = rest && i === pos.length - 1 ? args.slice(i) : args[i]; });
  for (const r of required) if (res[r] === null) throw usage(`the following arguments are required: --${r.replace(/_/g, '-')}`);
  return res;
}

function write(path, data) {
  mkdirSync(dirname(path) || '.', { recursive: true });
  writeFileSync(path, data);
}

/** os.path.splitext (POSIX). */
export function splitext(p) {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot <= slash) return [p, ''];
  let i = slash + 1;
  while (i < dot && p[i] === '.') i++;
  return i === dot ? [p, ''] : [p.slice(0, dot), p.slice(dot)];
}

const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

/** dbetex cmd_budget (shared by both CLIs). */
export function cmdBudget(argv, io) {
  const a = parse(argv, {
    flags: { pool: 'int', pool_start: 'addr', vms_buffer: 'int', json: 'bool' }, pos: ['files'], rest: true,
    required: ['pool'], defaults: { vms_buffer: T.VMS_BUFFER },
  });
  const r = T.budget(a.files, a.pool, { vmsBuffer: a.vms_buffer, poolStart: a.pool_start, resolve: fileResolver });
  if (a.json) io.out(T.pyDumps(r, { indent: 1, floats: T.REPORT_FLOATS }));
  else {
    for (const f of r.files) {
      const base = 'base' in f ? `  base ${h4(f.base)}` : '';
      if (f.share === null) throw new T.TexError("unsupported operand type(s) for *: 'int' and 'NoneType'");
      io.out(`${f.file}: ${f.kind}, U ${f.u}, ${T.pyFixed(100 * f.share, 1)} % of the pool${base}`);
    }
    io.out(`Sum ${r.sum} / Pool ${r.pool}, free for sprites: ${r.free}`);
    io.out(`VMS bound ${r.vms_sum} / ${r.vms_buffer}` + (r.vms_over ? ' - warning: buffer too small' : ''));
  }
  if (r.over) { io.err(`Pool exceeded by ${r.over} bytes`); return 1; }
  return 0;
}

function cmdBuild(argv, io) {
  const a = parse(argv, { flags: { out: 'str', strict: 'bool', key: 'str', no_preview: 'bool' }, pos: ['toml'] });
  const path = presolve(a.toml);
  const src = read(path);
  const r = S.buildSpr(src, {
    path, resolve: fileResolver, out: a.out, strict: a.strict, key: a.key, preview: !a.no_preview,
  });
  const out = r.conf.out, name = r.conf.name;
  for (const [n, v] of Object.entries(r.files)) write(join(out, n), v);
  for (const p of r.previews) write(join(out, p.name), encodePng(p.image));
  const ss = r.ss, rp = r.report;
  io.out(`${name}: ${ss.na} angles, ${ss.np} phases, ${ss.images.length} images, S2 ${r.files[name + '.s2'].length - 2} bytes, `
    + `VRAM ${ss.u} bytes, VRL ${rp.vrl_bytes} bytes, VMS max ${rp.max_vms}`);
  for (const w of rp.warnings) io.err('Warning: ' + w);
  return 0;
}

function readVram(p) {
  const { stream } = vrl.unpackFile(read(p));
  return vrl.decode(stream);
}

function cmdDump(argv, io) {
  const a = parse(argv, { flags: { vrl: 'str', json: 'bool' }, pos: ['file'] });
  const data = read(a.file);
  const vram = a.vrl ? readVram(a.vrl) : null;
  const ss = S.fromS2(data, vram);
  const d = {
    geometry_id: ss.geometryId, d: ss.depth, na: ss.na, np: ss.np, ni: ss.images.length, nk: ss.nk,
    nt: ss.tags.length, flags: ss.flags, angle_map: ss.angleMap, u: ss.u, crc: ss.crc, stride: ss.stride,
    length: ss.total, index: ss.index,
    images: ss.images.map((im, i) => ({
      index: i, w: im.w, h: im.h, foot: [im.fx, im.fy],
      cores: im.cores.map((k) => ({ src: k.src, dx: k.dx, dy: k.dy, w: k.w, h: k.h, srcstep: k.srcstep })),
      edge_ofs: im.edgeOfs, edge_len: im.edgeLen, vms_len: im.vms.length,
    })),
    tags: ss.tags.map((t) => ({ name: t.name, first: t.first, count: t.count, mode: S.MODE_NAMES[t.mode], dur: t.dur })),
  };
  if (a.json) { io.out(T.pyDumps(d, { indent: 1 })); return 0; }
  io.out(`S2 ID ${d.geometry_id} D ${d.d} NA ${d.na} NP ${d.np} NI ${d.ni} NK ${d.nk} NT ${d.nt} `
    + `U ${d.u} CRC ${h4(d.crc)} stride ${d.stride} length ${d.length} angle_map ${pyRepr(d.angle_map)}`);
  for (let f = 0; f < ss.np; f++) {
    for (let ai = 0; ai < ss.na; ai++) {
      const row = ss.index.slice((f * ss.na + ai) * ss.depth, (f * ss.na + ai + 1) * ss.depth);
      io.out(`Phase ${f} angle ${ai}: ` + row.map(T.h2).join(' '));
    }
  }
  for (const i of d.images) {
    io.out(`Image ${i.index}: ${i.w}x${i.h} foot ${pyRepr(i.foot)} cores ${i.cores.length} edge ${i.edge_len} vms ${i.vms_len}`);
  }
  for (const t of d.tags) io.out(`Tag ${t.name}: Phase ${t.first} x${t.count} ${t.mode} ${t.dur} jiffies`);
  return 0;
}

function cmdPreview(argv, io) {
  const a = parse(argv, {
    flags: { vrl: 'str', geom: 'str', d: 'int', phase: 'int', angle: 'int', out: 'str' }, pos: ['file'],
    required: ['vrl', 'geom'], defaults: { d: 1, phase: 0, angle: 0 },
  });
  const data = read(a.file);
  const vram = readVram(a.vrl);
  const ss = S.fromS2(data, vram);
  const geom = T.loadGeom(fileResolver, a.geom);
  if (geom.geometry_id !== ss.geometryId && ss.geometryId !== 0) {
    throw new S.SprError(`Geometry ID ${geom.geometry_id} != ${ss.geometryId} in S2`);
  }
  const out = a.out || splitext(a.file)[0] + '_preview.png';
  write(out, encodePng(S.preview(ss, geom, vram, a.d, a.phase, a.angle)));
  io.out(`Preview: ${out}`);
  return 0;
}

const CMDS = { build: cmdBuild, dump: cmdDump, preview: cmdPreview, budget: cmdBudget };

export function sprCli(argv, io) {
  const cmd = argv[0];
  if (!CMDS[cmd]) throw usage(cmd === undefined ? 'the following arguments are required: cmd'
    : `argument cmd: invalid choice: ${pyRepr(cmd)} (choose from 'build', 'dump', 'preview', 'budget')`);
  return CMDS[cmd](argv.slice(1), io);
}

/** Error of the tools (printed as "Error: ..."), not a programming error. */
export function isToolError(e) {
  return e instanceof Error && !e.usage && !(e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError
    || e instanceof RangeError);
}

/** Runs sprCli in-process: {code, stdout, stderr} (texts as Python prints them). */
export function runSpr(argv) {
  const out = [], err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  let code;
  try {
    code = sprCli(argv, io);
  } catch (e) {
    if (e && e.usage) { err.push(`usage: dbespr.py: error: ${e.message}`); code = 2; } else if (isToolError(e)) { err.push(`Error: ${e.message}`); code = 1; } else throw e;
  }
  const j = (l) => l.map((s) => s + '\n').join('');
  return { code, stdout: j(out), stderr: j(err) };
}

export default sprCli;
