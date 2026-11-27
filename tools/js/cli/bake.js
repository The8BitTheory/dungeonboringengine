// dbe.js bake build BAKE.toml [--out DIR]   |   dbe.js bake check BAKE.toml
// build: visibility check, baked animations (DAP + VRL), layout report; check: only the messages (exit 1 on errors).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as presolve, join, dirname } from 'node:path';
import { buildBake } from '../core/bake.js';

const fsResolve = (p) => { try { return new Uint8Array(readFileSync(p)); } catch { return null; } };

export function bakeCli(argv, io) {
  const [cmd, file, ...rest] = argv;
  if (!['build', 'check'].includes(cmd) || !file) throw Object.assign(new Error('usage: bake build|check BAKE.toml [--out DIR]'), { usage: true });
  let out = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out' && i + 1 < rest.length) out = rest[++i];
    else throw Object.assign(new Error(`unknown option ${rest[i]}`), { usage: true });
  }
  const path = presolve(file);
  const r = buildBake(readFileSync(path, 'utf8'), { path, resolve: fsResolve });
  for (const w of r.warnings) io.err(`warning: ${w}`);
  for (const e of r.errors) io.err(`error: ${e}`);
  const rep = r.report;
  io.out(`${rep.name}: ${rep.viewpoints} viewpoints, ${rep.faces_seen} faces, ${rep.problems} problems, `
    + `${rep.anims.length} animations, pool end ${rep.layout.pool_end}, load ${rep.layout.load_ms} ms`);
  if (cmd === 'build') {
    const dir = out ? presolve(out) : r.conf.out;
    for (const [n, d] of Object.entries(r.files)) {
      mkdirSync(dirname(join(dir, n)), { recursive: true });
      writeFileSync(join(dir, n), d);
    }
  }
  return r.errors.length ? 1 : 0;
}
