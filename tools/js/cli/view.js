// dbe view: command line of core/view.js, same commands and options as tools/dbeview.py.
//   view render SCENE.toml [--out PNG] [--zoom N] [--clear]   draw scene (image of the view window)
//   view dump   SCENE.toml                                    VCL list decoded
//   view budget SCENE.toml...                                 largest VCL + VMS, warning if A != 0
// Errors are thrown (ViewError, TexError, MapError ...; usage errors with .usage = true).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as presolve } from 'node:path';
import * as V from '../core/view.js';
import { encodePng } from '../core/io/png.js';

function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

function parse(argv, flags, pos, defaults = {}, rest = false) {
  const res = { ...defaults }, args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2).replace(/-/g, '_');
      if (!(name in flags)) throw usage(`unrecognized arguments: ${a}`);
      if (flags[name] === 'bool') { res[name] = true; continue; }
      if (i + 1 >= argv.length) throw usage(`argument ${a}: expected one argument`);
      const v = argv[++i];
      if (flags[name] === 'int') {
        if (!/^[+-]?\d+$/.test(v.trim())) throw usage(`argument ${a}: invalid int value: '${v}'`);
        res[name] = parseInt(v, 10);
      } else res[name] = v;
    } else args.push(a);
  }
  if (args.length < pos.length) throw usage(`the following arguments are required: ${pos.slice(args.length).join(', ')}`);
  if (!rest && args.length > pos.length) throw usage(`unrecognized arguments: ${args.slice(pos.length).join(' ')}`);
  pos.forEach((n, i) => { res[n] = rest && i === pos.length - 1 ? args.slice(i) : args[i]; });
  return res;
}

/** load_scene with file access relative to the scene file. */
export function loadSceneFile(path) {
  const base = dirname(presolve(path));
  return V.loadScene(readFileSync(path), (n) => new Uint8Array(readFileSync(join(base, n))), path);
}

const h4 = (v) => '0x' + v.toString(16).padStart(4, '0');
const tuple = (e) => '(' + e.join(', ') + (e.length === 1 ? ',' : '') + ')';

export function viewCli(argv, io) {
  const cmd = argv[0];
  if (cmd === 'render') {
    const a = parse(argv.slice(1), { out: 'str', zoom: 'int', clear: 'bool' }, ['scene'], { out: null, zoom: 4, clear: false });
    const sc = loadSceneFile(a.scene);
    const [vram, res] = V.renderView(sc, a.clear ? new Uint8Array(65536) : null);
    const out = a.out || a.scene.replace(/\.[^./\\]*$/, '') + '.png';
    writeFileSync(out, encodePng(V.windowImage(sc, vram, a.zoom)));
    io.out(`${out}: A = ${res.a}, VCL ${res.vcllen} + VMS ${res.vmslen} bytes, ${res.x} entries, OBJVIS ${h4(res.objvis)}`);
  } else if (cmd === 'dump') {
    const a = parse(argv.slice(1), {}, ['scene']);
    const res = V.view(loadSceneFile(a.scene));
    io.out(`A = ${res.a}, X = ${res.x}, VCLADR ${h4(res.p0)}, VCLLEN ${res.vcllen}, VMSLEN ${res.vmslen}, OBJVIS ${h4(res.objvis)}`);
    for (const e of V.decodeVcl(res.buffer)) io.out(`  ${tuple(e)}`);
  } else if (cmd === 'budget') {
    const a = parse(argv.slice(1), {}, ['scene'], {}, true);
    const rep = V.budget(a.scene.map(loadSceneFile));
    io.out(`${rep.scenes} scenes: VCL max ${rep.max_vcl}, VMS max ${rep.max_vms}, total max ${rep.max_total}, `
      + `entries max ${rep.max_entries}, visibility list max ${rep.max_items}`);
    for (const w of rep.warnings) io.out(`Warning: ${w}`);
  } else throw usage('view: command render|dump|budget');
}

export default viewCli;
