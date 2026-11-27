// dbe map: command line of core/map.js, same commands and options as tools/dbemap.py.
//   map build MAP.toml OUT.dmp [--load ADDR]
//   map dump  IN.dmp [--toml OUT.toml]     (without --toml: text overview)
//   map check MAP.toml
// Errors are thrown (format errors as MapError, usage errors with .usage = true); warnings go to io.err.
import { readFileSync, writeFileSync } from 'node:fs';
import * as dbemap from '../core/map.js';

function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

/** Minimal argparse: flags {name: 'bool' | 'str'}, positional names. */
function parse(argv, flags, pos, defaults = {}) {
  const res = { ...defaults }, args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2).replace(/-/g, '_');
      if (!(name in flags)) throw usage(`unrecognized arguments: ${a}`);
      if (flags[name] === 'bool') { res[name] = true; continue; }
      if (i + 1 >= argv.length) throw usage(`argument ${a}: expected one argument`);
      res[name] = argv[++i];
    } else args.push(a);
  }
  if (args.length < pos.length) throw usage(`the following arguments are required: ${pos.slice(args.length).join(', ')}`);
  if (args.length > pos.length) throw usage(`unrecognized arguments: ${args.slice(pos.length).join(' ')}`);
  pos.forEach((n, i) => { res[n] = args[i]; });
  return res;
}

/** Python int(s.replace("$", "0x"), 0). */
export function pyInt0(s) {
  const t = s.replace(/\$/g, '0x').trim().replace(/_/g, '');
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|[1-9][0-9]*|0+)$/.exec(t);
  if (!m) throw new dbemap.MapError(`invalid literal for int() with base 0: ${dbemap.pyRepr(s.replace(/\$/g, '0x'))}`);
  const body = m[2];
  const v = /^0[xX]/.test(body) ? parseInt(body.slice(2), 16) : /^0[oO]/.test(body) ? parseInt(body.slice(2), 8)
    : /^0[bB]/.test(body) ? parseInt(body.slice(2), 2) : parseInt(body, 10);
  return m[1] === '-' ? -v : v;
}

const readMap = (path) => dbemap.loadsToml(readFileSync(path), String(path));

export function mapCli(argv, io) {
  const cmd = argv[0];
  if (cmd === 'dump') {
    const a = parse(argv.slice(1), { toml: 'str' }, ['input'], { toml: null });
    const m = dbemap.fromDmp(new Uint8Array(readFileSync(a.input)));
    if (a.toml) writeFileSync(a.toml, dbemap.toToml(m), 'utf8');
    else io.out(dbemap.describe(m));
    return;
  }
  if (cmd !== 'build' && cmd !== 'check') throw usage("map: command build|dump|check");
  const a = cmd === 'build' ? parse(argv.slice(1), { load: 'str' }, ['map', 'out'], { load: '0x4000' })
    : parse(argv.slice(1), {}, ['map']);
  const m = readMap(a.map);
  for (const w of dbemap.warningsFor(m)) io.err(`Warning: ${w}`);
  if (cmd === 'build') {
    const load = pyInt0(a.load);
    const data = dbemap.toDmp(m, load);
    dbemap.checkBank1(load, data.length - 2);
    writeFileSync(a.out, data);
    io.out(`${a.out}: ${data.length} bytes, ${m.width} x ${m.height}, ${m.tiles.length} tiles, ${m.events.length} events`);
  } else io.out(`${a.map}: ok (${m.width} x ${m.height}, ${m.tiles.length} tiles)`);
}

export default mapCli;
