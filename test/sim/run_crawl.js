#!/usr/bin/env node
// sim65 measurement and verification of the lib with the crawl scene (P7a, docs/specs/P7-crawl.md 6.2).
// Port of test/sim/run_crawl.py onto tools/js (core/crawl/crawl01.js, test/sim/run_sim.js).
//
// Usage:  node test/sim/run_crawl.js (--d81 IMAGE.d81 | --dir DIR) [--quick] [--workers N] [--no-verify] [--no-cycles]
//                                    [--fix] [--json OUT]
//   --fix:   fixed list address like crawl 1.1 from P6j (BUFSET X = 1: VCL list from B0, VIEW copies it there)
//   verify:  all views (free cells x 4 directions x no ghost/ghost in every cell (d, s) x 4 directions) run in the
//            simulator and compared byte for byte with view.js view (A, X, VCL, VMS, OBJVIS)
//   cycles:  cycles of VIEW as in run_sim timeView (run with F = 4 minus run with F = 7), mean and maximum
//            without and with ghost, target from P6 8: <= 2 x 0.1 = 28 382 cycles (finding, not an acceptance blocker)
// Builds the harness (run_sim build()) only if build/sim/viewsim.prg is missing. --workers N: worker threads
// (default: number of CPUs), each runs its share of the jobs (one sim65 process at a time).
import { existsSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import * as crawl01 from '../../tools/js/core/crawl/crawl01.js';
import * as V from '../../tools/js/core/view.js';
import { readDir, readD81 } from '../../tools/js/cli/crawl.js';
import { pyJson } from '../../tools/js/core/crawl/util.js';
import * as runSim from './run_sim.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export const TARGET = 28382;

const ghostRepr = (g) => (g === null ? 'None' : `(${g[0]}, ${g[1]})`);

/** Environment of one thread: crawl01.Env with the --fix setting. */
export function makeEnv(files, fix = false) {
  const env = new crawl01.Env(files);
  env.sc.bufFix = fix;
  return env;
}

/** All configurations of a view: [variant, ghost]. */
export function* configs(e, pos, v, quick = false, variants = [0, 1]) {
  const cells = e.visibleCells(pos, v);
  for (const variant of variants) {
    yield [variant, null];
    for (const [, , c] of cells) for (const gd of (quick ? [v, (v + 2) & 3] : [0, 1, 2, 3])) yield [variant, [c, gd]];
  }
}

function setScene(e, pos, v, variant, ghost) {
  const sc = e.sc;
  sc.dmp = variant ? e.m1 : e.m;
  sc.pos = pos; sc.dir = v;
  sc.objects = ghost === null ? [] : [new V.Obj(ghost[0], 0, ghost[1], 0, crawl01.QG[v])];
  return sc;
}

/** One verify job: all configurations of (pos, v) in one sim65 run. -> [nview, fails, codes]. */
export function verifyJob(e, [pos, v, quick]) {
  const R = new runSim.ViewRunner();
  for (const [variant, ghost] of configs(e, pos, v, quick)) {
    const sc = setScene(e, pos, v, variant, ghost);
    R.add(`pos ${pos} dir ${v} var ${variant} ghost ${ghostRepr(ghost)}`, sc, true);
  }
  const { nview, fails, codes } = R.run();
  return [nview, fails, codes];
}

/** One cycle job: per configuration (variant 0) the VIEW cycles. -> [[withGhost, cycles, pos, v, ghost]]. */
export function cycleJob(e, [pos, v, quick]) {
  const R = new runSim.ViewRunner();
  R.reset();
  let sc = setScene(e, pos, v, 0, null);
  sc.vmsBank1 = R.bank1;
  sc.dtsAddr = runSim.P6D_ADDR.dts.slice();
  R.setup(sc);
  sc.s2Addr = sc.s2.map((ss) => (ss !== null ? R.s2Addr(ss) : 0));
  const base = R.scene.b;
  const out = [];
  for (const [variant, ghost] of configs(e, pos, v, quick, [0])) {
    sc = setScene(e, pos, v, variant, ghost);
    const kw = runSim.ViewRunner.objargs(sc);
    const runs = [4, 7].map((f) => {
      const s = new runSim.Scene(base);
      s.call(2, v, 0, { p: [pos, 0, 0, 0], quiet: true });
      s.call(f, 0, 0, { p: [sc.ap, 0, 0, 0], quiet: true, ...kw });
      return runSim.run(s, R.prg).cycles;
    });
    out.push([ghost !== null, runs[0] - runs[1], pos, v, ghost]);
  }
  return out;
}

const JOBS = { verify: verifyJob, cycles: cycleJob };

/** Runs kind ('verify' | 'cycles') over all jobs, in job order; workers > 1: worker threads. */
async function mapJobs(kind, files, { quick = false, workers = 1, fix = false } = {}) {
  const e = makeEnv(files, fix);
  const jobs = e.free.flatMap((p) => [0, 1, 2, 3].map((v) => [p, v, quick]));
  workers = Math.max(1, Math.min(workers, jobs.length));
  if (workers === 1) return jobs.map((j) => JOBS[kind](e, j));
  const res = new Array(jobs.length);
  await Promise.all(Array.from({ length: workers }, (_, k) => new Promise((resolve, reject) => {
    // chunks of 2 jobs, interleaved over the workers (Python: imap chunksize 2)
    const idx = jobs.map((_, i) => i).filter((i) => Math.floor(i / 2) % workers === k);
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { tag: 'run_crawl', kind, files, fix, idx, jobs } });
    w.on('message', (m) => {
      if (m.error) reject(new Error(m.error));
      else { for (const [i, r] of m.results) res[i] = r; resolve(); }
    });
    w.on('error', reject);
    w.on('exit', (c) => { if (c) reject(new Error(`worker exit code ${c}`)); });
  })));
  return res;
}

if (!isMainThread && workerData && workerData.tag === 'run_crawl') {
  const { kind, files, fix, idx, jobs } = workerData;
  try {
    const e = makeEnv(files, fix);
    parentPort.postMessage({ results: idx.map((i) => [i, JOBS[kind](e, jobs[i])]) });
  } catch (err) {
    parentPort.postMessage({ error: String(err && err.stack ? err.stack : err) });
  }
}

export const verify = (files, opts) => mapJobs('verify', files, opts);

/** Python round(sum / n) (half to even, exact). */
function roundMean(sum, n) {
  const q = Math.floor(sum / n), r = sum - q * n;
  return 2 * r > n || (2 * r === n && q % 2 !== 0) ? q + 1 : q;
}

export async function cycles(files, opts) {
  const res = (await mapJobs('cycles', files, opts)).flat();
  const rep = {};
  for (const [name, sel] of [['no ghost', res.filter((r) => !r[0])], ['with ghost', res.filter((r) => r[0])], ['all', res]]) {
    const c = sel.map((r) => r[1]);
    let worst = sel[0];
    for (const r of sel) if (r[1] > worst[1]) worst = r;
    rep[name] = {
      n: c.length, mean: roundMean(c.reduce((a, b) => a + b, 0), c.length), max: Math.max(...c), min: Math.min(...c),
      worst: { pos: worst[2], dir: worst[3], ghost: worst[4] }, over_target: c.filter((x) => x > TARGET).length,
    };
  }
  return rep;
}

function parseArgs(argv) {
  const a = { d81: null, dir: null, quick: false, workers: cpus().length || 1, verify: true, cycles: true, fix: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`argument ${x}: expected one argument`); return argv[++i]; };
    if (x === '--d81') a.d81 = val();
    else if (x === '--dir') a.dir = val();
    else if (x === '--quick') a.quick = true;
    else if (x === '--workers') {
      a.workers = parseInt(val(), 10);
      if (!Number.isInteger(a.workers)) throw new Error(`argument --workers: invalid int value: '${argv[i]}'`);
    } else if (x === '--no-verify') a.verify = false;
    else if (x === '--no-cycles') a.cycles = false;
    else if (x === '--fix') a.fix = true;
    else if (x === '--json') a.json = val();
    else throw new Error(`unrecognized arguments: ${x}`);
  }
  if ((a.d81 === null) === (a.dir === null)) throw new Error('one of the arguments --d81 --dir is required (not both)');
  return a;
}

const pyCodes = (codes) => '{' + [...codes.entries()].map(([k, v]) => `${k}: ${v}`).join(', ') + '}';
const pyWorst = (w) => `{'pos': ${w.pos}, 'dir': ${w.dir}, 'ghost': ${ghostRepr(w.ghost)}}`;

export async function main(argv) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`run_crawl.js: error: ${e.message}\n`);
    return 2;
  }
  if (!existsSync(runSim.PRG)) runSim.build();
  const files = a.d81 ? readD81(a.d81, mkdtempSync(join(ROOT, 'build', 'crawlsim-'))) : readDir(a.dir);
  const out = {};
  let rc = 0;
  const opts = { quick: a.quick, workers: a.workers, fix: a.fix };
  if (a.verify) {
    const res = await verify(files, opts);
    const nview = res.reduce((s, r) => s + r[0], 0);
    const fails = res.flatMap((r) => r[1]);
    const codes = new Map();
    for (const r of res) for (const [k, c] of Object.entries(r[2])) codes.set(+k, (codes.get(+k) || 0) + c);
    console.log(`sim65 vs dbeview.view: ${nview} views, mismatches ${fails.length}, error codes ${pyCodes(codes)}`);
    for (const f of fails.slice(0, 10)) console.log('   ' + f);
    out.verify = { views: nview, fails: fails.length, codes: new Map([...codes].map(([k, v]) => [String(k), v])) };
    if (fails.length || [...codes.keys()].some((k) => k !== 0)) rc = 1;
  }
  if (a.cycles) {
    const rep = await cycles(files, opts);
    for (const [k, v] of Object.entries(rep)) {
      console.log(`VIEW cycles ${k}: ${v.n} views, mean ${v.mean}, min ${v.min}, max ${v.max} `
        + `(target ${TARGET}, above: ${v.over_target}); most expensive: ${pyWorst(v.worst)}`);
    }
    out.cycles = rep;
  }
  if (a.json) writeFileSync(a.json, pyJson(out, 1));
  return rc;
}

if (isMainThread && process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; });
}
