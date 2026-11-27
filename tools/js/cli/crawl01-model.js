#!/usr/bin/env node
// Bridge for scripts outside this repository (game repo test/vice_crawl.py): the crawl01 model (VIEW 0.1) as JSON.
//   node crawl01-model.js env    --d81 crawl128-100f.d81            -> {w, h, cells0, exits}
//   node crawl01-model.js render --d81 crawl128-100f.d81 < REQ.json  -> [{rows: hex, ...}] per request
// REQ.json: [{cells: [...], pos, v, ghosts: [[cell, phase, dir], ...]}]; each result is VRAM bytes 400 ... 8079
// (rows 5-100 of the 80-byte screen) after env.base1, row 100 preset to $A5, model.render (as vice_crawl.py did).
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Env } from '../core/crawl/crawl01.js';
import { EVENT_TYPES } from '../core/map.js';
import { readD81 } from './crawl.js';

const argv = process.argv.slice(2);
const cmd = argv[0], i = argv.indexOf('--d81');
if (!['env', 'render'].includes(cmd) || i < 0 || !argv[i + 1]) {
  console.error('usage: crawl01-model.js env|render --d81 IMAGE.d81 [< requests.json]');
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), 'crawl01-'));
let env;
try { env = new Env(readD81(argv[i + 1], work)); } finally { rmSync(work, { recursive: true, force: true }); }
if (cmd === 'env') {
  const exits = env.m.events.filter((e) => e.type === EVENT_TYPES.exit).map((e) => e.cell);
  process.stdout.write(JSON.stringify({ w: env.w, h: env.h, cells0: env.cells0, exits }));
} else {
  const reqs = JSON.parse(readFileSync(0, 'utf8'));
  const out = reqs.map((q) => {
    const [vis] = env.model.view(q.cells, env.w, env.h, q.pos, q.v, q.ghosts);
    const base = Uint8Array.from(env.base1);
    base.fill(0xA5, 8000, 8080);
    env.model.render(base, vis);
    return Buffer.from(base.subarray(400, 8080)).toString('hex');
  });
  process.stdout.write(JSON.stringify(out));
}
