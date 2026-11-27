#!/usr/bin/env node
// Run VIEW in the simulator for all free cells and directions of a crawl map. Port of test/sim/run_viewsim.py.
//
// Usage: node test/sim/run_viewsim.js <crawl128.cd1> <walls.wsm>
// Builds viewsim.prg (cl65, target sim6502) and measures with sim65 -c:
//   cycles VIEW = cycles(mode 1) - cycles(mode 0); plus number of wall entries and length of the VCL list.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyFixed } from '../../tools/js/core/tex.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const [cd1, wsm] = process.argv.slice(2, 4).map((a) => resolve(a));
const c = new Uint8Array(readFileSync(cd1)).subarray(2);
const off = c[0], W = c[1], H = c[2];
const out = join(root, 'build', 'sim');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'simdata.inc'), `MAP_W = ${W}\nMAP_H = ${H}\nMAP_OFF = ${2 + off}\n.define MAPFILE "${cd1}"\n.define WSMFILE "${wsm}"\n`);
const prg = join(out, 'viewsim.prg');
const b = spawnSync('cl65', ['-t', 'sim6502', '-C', join(here, 'sim.cfg'), '-O', '--asm-define', 'SIM',
  '--asm-include-dir', out, '--asm-include-dir', join(root, 'engine'),
  '-o', prg, join(here, 'viewsim.c'), join(here, 'glue.s'), join(root, 'engine', 'lib.s')], { cwd: out, stdio: 'inherit' });
if (b.error) throw b.error;
if (b.status !== 0) {
  console.error(`cl65: exit code ${b.status}`);
  process.exit(1);
}
for (const o of [join(here, 'viewsim.o'), join(here, 'glue.o'), join(root, 'engine', 'lib.o')]) {
  if (existsSync(o)) rmSync(o);      // cl65 puts the objects next to the sources
}

function run(pos, d, mode) {
  const r = spawnSync('sim65', ['-c', prg, String(pos), String(d), String(mode)], { encoding: 'utf8' });
  if (r.error) throw r.error;
  const m = /(\d+) cycles/.exec(r.stdout + r.stderr);
  if (!m) throw new Error(`sim65: no cycle count in the output (exit code ${r.status}): ${r.stdout}${r.stderr}`);
  return [parseInt(m[1], 10), r.stdout.split('\n')[0]];
}

const rows = [];
for (let pos = 0; pos < W * H; pos++) {
  if (c[off + pos] & 1) continue;
  for (let d = 0; d < 4; d++) {
    const [c0] = run(pos, d, 0);
    const [c1] = run(pos, d, 1);
    const [, o] = run(pos, d, 2);
    const f = o.split(/\s+/).filter((x) => x).map((x) => {
      if (!/^[+-]?\d+$/.test(x)) throw new Error(`invalid literal for int() with base 10: '${x}'`);
      return parseInt(x, 10);
    });
    if (f.length !== 3) throw new Error(`expected 3 values, got ${f.length}`);
    const [err, nvis, ln] = f;
    rows.push([pos, d, c1 - c0, nvis, ln, err]);
  }
}
const col = (k) => rows.map((r) => r[k]);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
const cyc = col(2), nv = col(3), ln = col(4);
console.log(`${rows.length} views (${Math.floor(rows.length / 4)} cells x 4 directions), errors: ${rows.filter((r) => r[5]).length}`);
console.log(`VIEW cycles:     min ${min(cyc)}  mean ${pyFixed(mean(cyc), 0)}  max ${max(cyc)}`);
console.log(`wall entries:    min ${min(nv)}  mean ${pyFixed(mean(nv), 1)}  max ${max(nv)}`);
console.log(`VCL length bytes: min ${min(ln)}  mean ${pyFixed(mean(ln), 0)}  max ${max(ln)}`);
