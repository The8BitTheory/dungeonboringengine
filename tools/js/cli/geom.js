// dbe geom: command line of core/geom.js, same commands and options as tools/dbegeom.py.
//   geom view.toml [--out DIR] [--name NAME] [--check]
//   geom --preset westwood --width 140 --height 96 [--stride 80 --origin 0] [--out DIR] [--name NAME] [--check]
// Writes <name>.dvg, .geom.json, .budget.md, .aseprite, _atlas.png, _view.png and tpl/*.png to the output directory
// ([output].dir relative to the TOML file, or to the working directory with --preset).
// Errors are thrown (GeomError; usage errors with .usage = true).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as presolve, join } from 'node:path';
import * as G from '../core/geom.js';
import { parseToml } from '../core/io/toml.js';

function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

const FLAGS = { out: 'str', name: 'str', check: 'bool', preset: 'str', width: 'int', height: 'int', stride: 'int', origin: 'int' };

export const HELP = `usage: dbegeom.py [-h] [--out OUT] [--name NAME] [--check] [--preset PRESET] [--width WIDTH] [--height HEIGHT]
                  [--stride STRIDE] [--origin ORIGIN]
                  [toml]

Generate viewport geometry (DVG, JSON, templates, budget)`;

/** Python int(s) (base 10, whitespace and underscores allowed) or null. */
function pyInt(s) {
  const t = s.trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) return null;
  return parseInt(t.replace(/_/g, ''), 10);
}

/** argparse subset: long options with unique prefixes, --opt=value, one optional positional. */
function parse(argv) {
  const res = { toml: null, check: false }, pos = [];
  for (const k of Object.keys(FLAGS)) if (FLAGS[k] !== 'bool') res[k] = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a.startsWith('--') && a.length > 2) {
      let [opt, val] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), null];
      let name = opt in FLAGS ? opt : null;
      if (!name) {
        const cand = Object.keys(FLAGS).filter((k) => k.startsWith(opt));
        if (cand.length > 1) throw usage(`ambiguous option: --${opt} could match ${cand.map((k) => '--' + k).join(', ')}`);
        if (!cand.length) throw usage(`unrecognized arguments: ${a}`);
        name = cand[0];
      }
      if (FLAGS[name] === 'bool') {
        if (val !== null) throw usage(`argument --${name}: ignored explicit argument '${val}'`);
        res[name] = true;
        continue;
      }
      if (val === null) {
        if (i + 1 >= argv.length) throw usage(`argument --${name}: expected one argument`);
        val = argv[++i];
      }
      if (FLAGS[name] === 'int') {
        const v = pyInt(val);
        if (v === null) throw usage(`argument --${name}: invalid int value: '${val}'`);
        res[name] = v;
      } else res[name] = val;
    } else pos.push(a);
  }
  if (pos.length > 1) throw usage(`unrecognized arguments: ${pos.slice(1).join(' ')}`);
  res.toml = pos[0] ?? null;
  return res;
}

/** os.path.join(base, p) (no normalisation). */
const pyJoin = (base, p) => (p.startsWith('/') ? p : base.endsWith('/') ? base + p : `${base}/${p}`);

/** Write the files of generate() below outdir. */
export function writeFiles(outdir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const p = join(outdir, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (typeof data === 'string') writeFileSync(p, data, 'utf8'); else writeFileSync(p, data);
  }
}

export function geomCli(argv, io) {
  const a = parse(argv);
  if (a.help) { io.out(HELP); return; }
  let base = process.cwd(), cfg;
  if (a.toml) {
    const raw = readFileSync(a.toml);
    try {
      cfg = parseToml(raw);
    } catch (e) {
      if (e instanceof G.GeomError) throw e;
      throw new G.GeomError(`TOML: ${e.message}`);
    }
    base = dirname(presolve(a.toml));
  } else if (a.preset && a.width && a.height) {
    const vp = { preset: a.preset, width_px: a.width, height: a.height };
    if (a.stride !== null) vp.stride = a.stride;
    if (a.origin !== null) vp.origin = a.origin;
    cfg = { viewport: vp };
  } else throw usage('Usage: dbegeom.py view.toml | --preset P --width W --height H');
  const conf = G.parseConfig(cfg);
  const name = a.name || conf.name;
  const outdir = a.out ? a.out : pyJoin(base, conf.dir);
  if (a.check) {
    io.out(G.checkLines(new G.Geometry(conf)).join('\n'));
    return;
  }
  const res = G.generate(conf, name);
  writeFiles(outdir, res.files);
  io.out(`${name}: ${res.geo.elements.length} elements, wall style ${res.bud.wall_style} bytes -> ${outdir}`);
}

export default geomCli;
