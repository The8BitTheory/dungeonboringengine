#!/usr/bin/env node
// dbe: command line of the JS tools (docs/specs/P8-js-tools.md). Same commands and options as the Python CLIs.
//   dbe.js vrl encode IN OUT [--load ADDR] [--raw] [--in-prg]
//   dbe.js vrl rect   IN OUT --width W --height H --stride S [--mask MASK] [--load ADDR] [--raw] [--in-prg]
//   dbe.js vrl decode IN OUT [--raw] [--base BASE] [--out-prg ADDR]
//   dbe.js vrl stats  IN [--raw] [-T N] [--bench P0.json] [--json]
//   dbe.js map build|dump|check ...   (as dbemap.py)
//   dbe.js view render|dump|budget ... (as dbeview.py)
// Exit code: 0 ok, 1 format error, 2 wrong usage.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vrl from '../core/vrl.js';
import { mapCli } from './map.js';
import { viewCli } from './view.js';
import { geomCli } from './geom.js';
import { texCli } from './tex.js';
import { sprCli } from './spr.js';

class Usage extends Error {}

/** Minimal argparse: spec = {flags: {name: 'bool'|'int'|'addr'|'str'}, pos: [names], required: [names]} */
function parseArgs(argv, spec) {
  const res = {}, pos = [];
  for (const [k, t] of Object.entries(spec.flags)) res[k] = t === 'bool' ? false : spec.defaults?.[k] ?? null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const name = a.replace(/^--?/, '').replace(/-/g, '_');
      const t = spec.flags[name];
      if (!t) throw new Usage(`unknown option ${a}`);
      if (t === 'bool') { res[name] = true; continue; }
      if (i + 1 >= argv.length) throw new Usage(`option ${a} needs a value`);
      const v = argv[++i];
      res[name] = t === 'int' ? toInt(v, a) : t === 'addr' ? addr(v) : v;
    } else pos.push(a);
  }
  if (pos.length !== spec.pos.length) throw new Usage(`expected ${spec.pos.join(' ')}`);
  spec.pos.forEach((n, i) => { res[n] = pos[i]; });
  for (const r of spec.required || []) if (res[r] === null) throw new Usage(`option --${r} is required`);
  return res;
}

function toInt(v, name) {
  if (!/^-?\d+$/.test(v)) throw new Usage(`${name}: not an integer: ${v}`);
  return parseInt(v, 10);
}

function addr(s) {
  s = s.trim();
  const v = s.startsWith('$') ? parseInt(s.slice(1), 16) : /^0x/i.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
  if (!(v >= 0 && v <= 0xFFFF)) throw new Usage(`Address outside 0..65535: ${s}`);
  return v;
}

const read = (p, skipPrg = false) => {
  const d = new Uint8Array(readFileSync(p));
  if (skipPrg) {
    if (d.length < 2) throw new vrl.VrlError('VRL: PRG input without load address');
    return d.slice(2);
  }
  return d;
};

const VRL = {
  encode: { flags: { load: 'addr', raw: 'bool', in_prg: 'bool' }, defaults: { load: 0x2000 }, pos: ['IN', 'OUT'] },
  rect: {
    flags: { load: 'addr', raw: 'bool', in_prg: 'bool', width: 'int', height: 'int', stride: 'int', mask: 'str' },
    defaults: { load: 0x2000 }, pos: ['IN', 'OUT'], required: ['width', 'height', 'stride'],
  },
  decode: { flags: { raw: 'bool', base: 'str', out_prg: 'addr' }, pos: ['IN', 'OUT'] },
  stats: { flags: { raw: 'bool', T: 'int', bench: 'str', json: 'bool' }, pos: ['IN'] },
};

function cmdVrl(argv, io) {
  const log = io.out;
  const cmd = argv[0];
  if (!VRL[cmd]) throw new Usage('vrl: command encode|rect|decode|stats');
  const a = parseArgs(argv.slice(1), VRL[cmd]);
  const emit = (stream) => writeFileSync(a.OUT, a.raw ? stream : vrl.packFile(stream, a.load));
  const streamIn = () => { const d = read(a.IN); return a.raw ? d : vrl.unpackFile(d).stream; };
  if (cmd === 'encode') emit(vrl.encode(read(a.IN, a.in_prg)));
  else if (cmd === 'rect') emit(vrl.encodeRect(read(a.IN, a.in_prg), a.width, a.height, a.stride, a.mask ? read(a.mask) : null));
  else if (cmd === 'decode') {
    let out = vrl.decode(streamIn(), a.base ? read(a.base) : null);
    if (a.out_prg !== null) { const p = new Uint8Array(out.length + 2); p.set([a.out_prg & 255, a.out_prg >> 8]); p.set(out, 2); out = p; }
    writeFileSync(a.OUT, out);
  } else {
    const params = a.bench ? vrl.benchParams(JSON.parse(readFileSync(a.bench, 'utf8')), a.bench) : null;
    const st = vrl.stats(streamIn(), a.T, params);
    if (a.json) { log(JSON.stringify(st, null, 2)); return; }
    const pad = (s, n) => String(s).padEnd(n);
    for (const k of ['stream_bytes', 'unpacked', 'written', 'skipped']) log(`${pad(k, 14)} ${st[k]}`);
    log(`${pad('ratio', 14)} ${st.ratio === null ? '-' : st.ratio.toFixed(3)}`);
    log(`${pad('tokens', 14)} ${Object.entries(st.tokens).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    log(`${pad('bytes_by_kind', 14)} ${Object.entries(st.bytes_by_kind).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    log('run_hist');
    for (const [k, v] of Object.entries(st.run_hist)) log(`  ${pad(k, 8)} ${v}`);
    log(`${pad('T', 14)} ${st.T}`);
    log(`${pad('cycles', 14)} ${st.cycles}`);
  }
}

const TOOLS = { vrl: cmdVrl, map: mapCli, view: viewCli, geom: geomCli, tex: texCli, spr: sprCli };

/** Run the CLI in-process: returns the exit code; io.out/io.err receive lines (default console). */
export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const tool = TOOLS[argv[0]];
  try {
    if (!tool) throw new Usage(`usage: dbe.js <tool> ... (tools: ${Object.keys(TOOLS).join(', ')})`);
    const rc = tool(argv.slice(1), io);
    return typeof rc === 'number' ? rc : 0;
  } catch (e) {
    if (e instanceof Usage || e.usage) { io.err(`dbe.js: ${e.message}`); return 2; }
    if (e instanceof Error && (e.name !== 'Error' || e.code === 'ENOENT' || e instanceof vrl.VrlError)) {
      io.err(`dbe.js: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
