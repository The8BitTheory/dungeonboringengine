// Crawl converters on the command line: same commands, options and texts as the Python scripts.
//   crawlconvCli    OUT_DIR (--d81 IMAGE.d81 | --dir DIR) [--max-part N] [--font-bytes N] [--json]   (crawlconv.py)
//   crawlmapCli     CRAWL128.CD1 OUT.dmp | --d81 IMAGE.d81 OUT.dmp  [--toml OUT.toml] [--load ADDR] [--items 2,4]
//                   [--floor N] [--ceiling N]                                                          (crawlmap.py)
//   crawl01Cli      compare (--d81 IMAGE.d81 | --dir DIR) [--quick] [--workers N] [--json OUT.json]   (crawl01.py)
//   wallconvCli     WALLS.VDC OUT.wsm [--load ADDR] [-v]                                               (wallconv.py)
//   crawlspritesCli RED.VDC RED1.VDC OUTDIR                                                            (crawlsprites.py)
// Each takes (argv, io) with io = {out(line), err(line)} and returns the exit code (0 ok, 1 error); usage errors are
// thrown as Error with .usage = true (the caller prints them, exit code 2). Converter errors are printed as
// "Error: <message>" like the Python main(). runCrawl(cli, argv) collects {code, stdout, stderr}.
// crawl01 compare with --workers > 1 splits the jobs over worker threads and waits synchronously (Atomics).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, workerData, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import * as crawlconv from '../core/crawl/crawlconv.js';
import * as crawlmap from '../core/crawl/crawlmap.js';
import * as crawl01 from '../core/crawl/crawl01.js';
import * as wallconv from '../core/crawl/wallconv.js';
import * as crawlsprites from '../core/crawl/crawlsprites.js';
import * as dbemap from '../core/map.js';
import { pyRepr } from '../core/map.js';
import { pyInt0, pyInt10 } from '../core/crawl/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

export function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

/** Python OSError text for Node fs errors ("[Errno 2] No such file or directory: 'p'"). */
export function osErrorText(e) {
  const no = { ENOENT: [2, 'No such file or directory'], EACCES: [13, 'Permission denied'], EISDIR: [21, 'Is a directory'],
    ENOTDIR: [20, 'Not a directory'], EEXIST: [17, 'File exists'] }[e.code];
  return no && e.path ? `[Errno ${no[0]}] ${no[1]}: ${pyRepr(e.path)}` : e.message;
}

const isOsError = (e) => e instanceof Error && typeof e.code === 'string' && typeof e.syscall === 'string';

/** argparse subset: long options (unique prefixes, --opt=value), short aliases, positional names (last may end in
 *  '+' = one or more), groups of mutually exclusive required options. */
function parse(argv, { flags = {}, short = {}, pos = [], groups = [] }) {
  const res = {}, args = [];
  for (const [k, t] of Object.entries(flags)) res[k] = t === 'bool' ? false : null;
  const names = Object.keys(flags);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let name = null, val = null;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
      name = a.slice(2).replace(/-/g, '_');
      if (!(name in flags)) {
        const m = names.filter((n) => n.startsWith(name));
        if (m.length > 1) throw usage(`ambiguous option: ${a} could match ${m.map((n) => '--' + n.replace(/_/g, '-')).join(', ')}`);
        if (!m.length) throw usage(`unrecognized arguments: ${argv[i]}`);
        name = m[0];
      }
    } else if (a in short) name = short[a];
    else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) throw usage(`unrecognized arguments: ${a}`);
    if (name === null) { args.push(a); continue; }
    const t = flags[name];
    const opt = '--' + name.replace(/_/g, '-');
    if (t === 'bool') {
      if (val !== null) throw usage(`argument ${opt}: ignored explicit argument ${pyRepr(val)}`);
      res[name] = true;
      continue;
    }
    if (val === null) {
      if (i + 1 >= argv.length || (argv[i + 1].startsWith('-') && argv[i + 1].length > 1 && !/^-\d/.test(argv[i + 1]))) {
        throw usage(`argument ${opt}: expected one argument`);
      }
      val = argv[++i];
    }
    if (t === 'int') {
      const v = pyInt10(val);
      if (v === null) throw usage(`argument ${opt}: invalid int value: ${pyRepr(val)}`);
      res[name] = v;
    } else if (t === 'int0') {
      const v = pyInt0(val);
      if (v === null) throw usage(`argument ${opt}: invalid <lambda> value: ${pyRepr(val)}`);
      res[name] = v;
    } else res[name] = val;
  }
  for (const g of groups) {
    const set = g.filter((n) => res[n] !== null && res[n] !== false);
    if (set.length > 1) throw usage(`argument --${set[1]}: not allowed with argument --${set[0]}`);
    if (!set.length) throw usage(`one of the arguments ${g.map((n) => '--' + n).join(' ')} is required`);
  }
  const plus = pos.length && pos[pos.length - 1].endsWith('+');
  if (args.length < pos.length) throw usage(`the following arguments are required: ${pos.slice(args.length).map((p) => p.replace('+', '')).join(', ')}`);
  if (!plus && args.length > pos.length) throw usage(`unrecognized arguments: ${args.slice(pos.length).join(' ')}`);
  pos.forEach((n, i) => { if (n.endsWith('+')) res[n.slice(0, -1)] = args.slice(i); else res[n] = args[i]; });
  return res;
}

/** Resolver of a folder: bytes or null if the file does not exist. */
export function dirResolver(dir) {
  return (n) => {
    const p = join(dir, n);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  };
}

/** crawlconv.read_dir: input files from a folder. */
export const readDir = (dir) => crawlconv.readFiles(dirResolver(dir), dir);

/** crawlconv.read_d81: read the input files from the image via c1541 into workDir, then readDir(workDir). */
export function readD81(image, workDir) {
  mkdirSync(workDir, { recursive: true });
  for (const n of [...crawlconv.FILES, ...crawlconv.OPTIONAL]) {
    const out = join(workDir, n);
    if (existsSync(out)) rmSync(out);
    const r = spawnSync('c1541', ['-attach', image, '-read', n, out], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') throw Object.assign(new Error(`[Errno 2] No such file or directory: 'c1541'`), { code: 'ENOENT', syscall: 'spawn' });
    if (!existsSync(out) && crawlconv.FILES.includes(n)) {
      throw new crawlconv.ConvError(`c1541 could not read ${n} from ${image}: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  return readDir(workDir);
}

/** crawlmap.read_d81: crawl128.cd1 from a D81 image via c1541 (temporary folder). */
export function readCd1FromD81(image) {
  const td = mkdtempSync(join(tmpdir(), 'crawlmap-'));
  try {
    const out = join(td, 'crawl128.cd1');
    const r = spawnSync('c1541', ['-attach', image, '-read', 'crawl128.cd1', out], { encoding: 'utf8' });
    if (!existsSync(out)) {
      throw new dbemap.MapError(`c1541 could not read crawl128.cd1 from ${image}: ${(r.stderr || '').trim() || (r.stdout || '').trim()}`);
    }
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(td, { recursive: true, force: true });
  }
}

function writeOut(path, data) { writeFileSync(path, typeof data === 'string' ? data : data); }

const isConvError = (e) => e instanceof crawlconv.ConvError || (e instanceof Error && ['ViewError', 'TexError', 'MapError', 'VrlError'].includes(e.name));

// ---------------------------------------------------------------- crawlconv

export function crawlconvCli(argv, io) {
  const a = parse(argv, {
    flags: { d81: 'str', dir: 'str', max_part: 'int', font_bytes: 'int', json: 'bool' }, pos: ['out_dir'], groups: [['d81', 'dir']],
  });
  const maxPart = a.max_part === null ? 0 : a.max_part;
  let r;
  try {
    const files = a.d81 ? readD81(a.d81, join(a.out_dir, 'in')) : readDir(a.dir);
    r = crawlconv.build(files, maxPart, a.font_bytes);
    mkdirSync(a.out_dir, { recursive: true });
    for (const [n, d] of Object.entries(crawlconv.outputs(r, a.json))) writeOut(join(a.out_dir, n), d);
  } catch (e) {
    if (isConvError(e) || isOsError(e)) { io.err(`Error: ${isOsError(e) ? osErrorText(e) : e.message}`); return 1; }
    throw e;
  }
  const i = r.info;
  io.out(`${a.out_dir}: ${r.dvg.elems.length} elements, gid 0x${r.dvg.gid.toString(16).padStart(4, '0')}; `
    + Object.keys(r.files).sort().map((n) => `${n} ${r.files[n].length}`).join(', '));
  io.out(`VRAM: DA ${i.DA}, GA(0) ${i.GA0}, GA(1) ${i.GA1}, MA ${i.MA}, end ${i.vram_end} `
    + `(reserve ${i.vram_reserve}); wall VRL parts N = ${r.nparts}`);
  return 0;
}

// ---------------------------------------------------------------- crawlmap

export function crawlmapCli(argv, io) {
  const a = parse(argv, {
    flags: { d81: 'str', toml: 'str', load: 'str', items: 'str', floor: 'int', ceiling: 'int' }, pos: ['paths+'],
  });
  const load0 = a.load ?? '0x4000', items0 = a.items ?? '2,4', floor = a.floor ?? 0, ceiling = a.ceiling ?? 0;
  try {
    if (a.paths.length !== (a.d81 ? 1 : 2)) throw usage('Usage: CRAWL128.CD1 OUT.dmp  or  --d81 IMAGE.d81 OUT.dmp');
    const out = a.paths[a.paths.length - 1];
    const data = a.d81 ? readCd1FromD81(a.d81) : new Uint8Array(readFileSync(a.paths[0]));
    const items = [];
    for (const x of items0.split(',')) {
      if (!x.trim()) continue;
      const v = pyInt10(x);
      if (v === null) throw new dbemap.MapError(`invalid literal for int() with base 10: ${pyRepr(x)}`);
      items.push(v);
    }
    if (items.some((i) => !(i >= 1 && i <= 63))) throw new dbemap.MapError('--items: values 1 ... 63 expected');
    for (const v of [floor, ceiling]) if (!(v >= 0 && v <= 255)) throw new dbemap.MapError('--floor/--ceiling: 0 ... 255 expected');
    const { m, warn } = crawlmap.convert(data, { items, floor, ceiling });
    for (const w of warn) io.err(`Warning: ${w}`);
    const ls = load0.replace(/\$/g, '0x');
    const load = pyInt0(ls);
    if (load === null) throw new dbemap.MapError(`invalid literal for int() with base 0: ${pyRepr(ls)}`);
    const dmp = dbemap.toDmp(m, load);
    dbemap.checkBank1(load, dmp.length - 2);
    writeFileSync(out, dmp);
    if (a.toml) writeFileSync(a.toml, dbemap.toToml(m, crawlmap.legendFor(m)), 'utf8');
    io.out(`${out}: ${dmp.length} bytes, ${m.width} x ${m.height}, ${m.tiles.length} tiles, `
      + `${m.content.filter((c) => c).length} items, ${m.events.length} events, `
      + `start (${m.start % m.width}, ${Math.floor(m.start / m.width)}) direction ${dbemap.DIRS[m.direction]}`);
    return 0;
  } catch (e) {
    if (e instanceof dbemap.MapError || isOsError(e)) { io.err(`Error: ${isOsError(e) ? osErrorText(e) : e.message}`); return 1; }
    throw e;
  }
}

// ---------------------------------------------------------------- crawl01

const WORKER_TAG = 'crawl01-compare';

/** Full comparison over worker threads (workers > 1; synchronous: waits with Atomics.wait). progress(i, n) as in
 *  Python (every 50 jobs). Same report as crawl01.compare (results merged in job order). */
export function compareParallel(files, { quick = false, workers = 1, fontBytes = 1732, progress = null } = {}) {
  const env = new crawl01.Env(files, fontBytes);
  const all = crawl01.jobs(env, quick);
  workers = Math.max(1, Math.min(workers, Math.ceil(all.length / 4)));
  if (workers === 1) {
    return crawl01.merge(env, all.map(([p, v, q], i) => { if (progress && i % 50 === 0) progress(i, all.length); return crawl01.job(env, p, v, q); }), quick);
  }
  const sab = new SharedArrayBuffer(8);
  const cnt = new Int32Array(sab);                 // [0] jobs done, [1] workers finished
  const ports = [], threads = [];
  for (let k = 0; k < workers; k++) {
    const ch = new MessageChannel();
    // chunks of 4 jobs, interleaved over the workers
    const idx = all.map((_, i) => i).filter((i) => Math.floor(i / 4) % workers === k);
    threads.push(new Worker(fileURLToPath(import.meta.url), {
      workerData: { tag: WORKER_TAG, files, quick, fontBytes, idx, port: ch.port2, sab }, transferList: [ch.port2],
    }));
    ports.push(ch.port1);
  }
  let shown = -1;
  for (;;) {
    const fin = Atomics.load(cnt, 1);
    const done = Atomics.load(cnt, 0);
    if (progress) {
      for (let i = (Math.floor(shown / 50) + 1) * 50; i <= done && i < all.length; i += 50) { progress(i, all.length); shown = i; }
    }
    if (fin >= workers) break;
    Atomics.wait(cnt, 1, fin, 500);                // guard timeout: re-check progress and errors
  }
  const results = new Array(all.length);
  for (const port of ports) {
    const msg = receiveMessageOnPort(port);
    if (!msg) throw new Error('crawl01: worker sent no result');
    if (msg.message.error) throw new Error(`crawl01 worker: ${msg.message.error}`);
    for (const [i, r] of msg.message.results) results[i] = r;
    port.close();
  }
  for (const t of threads) t.terminate();
  return crawl01.merge(env, results, quick);
}

function workerMain() {
  const { files, quick, fontBytes, idx, port, sab } = workerData;
  const cnt = new Int32Array(sab);
  try {
    const env = new crawl01.Env(files, fontBytes);
    const all = crawl01.jobs(env, quick);
    const results = [];
    for (const i of idx) {
      const [p, v, q] = all[i];
      results.push([i, crawl01.job(env, p, v, q)]);
      Atomics.add(cnt, 0, 1);
    }
    port.postMessage({ results });
  } catch (e) {
    port.postMessage({ error: String(e && e.stack ? e.stack : e) });
  }
  Atomics.add(cnt, 1, 1);
  Atomics.notify(cnt, 1);
}

if (!isMainThread && workerData && workerData.tag === WORKER_TAG) workerMain();

export function crawl01Cli(argv, io) {
  const a = parse(argv, { flags: { d81: 'str', dir: 'str', quick: 'bool', workers: 'int', json: 'str' }, pos: ['cmd'], groups: [['d81', 'dir']] });
  if (a.cmd !== 'compare') throw usage(`argument cmd: invalid choice: ${pyRepr(a.cmd)} (choose from 'compare')`);
  const workers = a.workers ?? (cpus().length || 1);
  let files;
  try {
    if (a.d81) {
      const b = join(ROOT, 'build');
      const work = mkdtempSync(join(existsSync(b) && statSync(b).isDirectory() ? b : tmpdir(), 'crawl01-'));
      files = readD81(a.d81, work);
    } else files = readDir(a.dir);
  } catch (e) {
    if (isConvError(e) || isOsError(e)) { io.err(`Error: ${isOsError(e) ? osErrorText(e) : e.message}`); return 1; }
    throw e;
  }
  const rep = compareParallel(files, { quick: a.quick, workers, progress: workers > 1 ? (i, n) => io.err(`  ${i}/${n}`) : null });
  for (const l of crawl01.summary(rep)) io.out(l);
  if (a.json) writeFileSync(a.json, crawl01.reportJson(rep));
  return crawl01.exitCode(rep);
}

// ---------------------------------------------------------------- wallconv, crawlsprites

export function wallconvCli(argv, io) {
  const a = parse(argv, { flags: { load: 'int0', v: 'bool' }, short: { '-v': 'v' }, pos: ['walls_vdc', 'out_wsm'] });
  const load = a.load ?? 0xE000;
  const { prg, out, ents } = wallconv.toWsm(new Uint8Array(readFileSync(a.walls_vdc)), load);
  writeFileSync(a.out_wsm, prg);
  if (a.v) {
    for (const [, d, s, flags, w, h, src, dest, col] of ents) {
      io.out(`d=${d} s=${s < 0 ? s : '+' + s} flags=${flags} w=${String(w).padStart(2)} h=${String(h).padStart(2)} `
        + `src=${String(src).padStart(5)} dest=${dest} col=${col}`);
    }
  }
  io.out(`${ents.length} entries, ${out.length} bytes -> ${a.out_wsm}`);
  return 0;
}

export function crawlspritesCli(argv, io) {
  if (argv.length < 3) throw usage('Usage: crawlsprites.py RED.VDC RED1.VDC <output directory>');
  const [red, red1, outdir] = argv;
  const r = crawlsprites.build(new Uint8Array(readFileSync(red)), new Uint8Array(readFileSync(red1)));
  for (const [n, d] of Object.entries(r.files)) writeFileSync(join(outdir, n), d);
  for (const l of r.lines) io.out(l);
  return 0;
}

/** Run one of the CLIs in-process: {code, stdout, stderr} (lines with "\n"; usage errors as in dbe.js, code 2). */
export function runCrawl(cli, argv) {
  const out = [], err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  let code;
  try {
    code = cli(argv, io);
  } catch (e) {
    if (e && e.usage) { err.push(`dbe.js: ${e.message}`); code = 2; } else throw e;
  }
  const txt = (l) => l.map((s) => s + '\n').join('');
  return { code, stdout: txt(out), stderr: txt(err) };
}
