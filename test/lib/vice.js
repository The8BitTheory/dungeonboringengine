// VICE helpers of the engine harnesses: monitor connection, port choice, own-process handling, disk and BASIC helpers.
// Node port of VDC-BASIC's test/vicemon.py (monitor, port, run_vice) plus the helpers of test/vice_smoke.py
// (sh, tok, VERSION, boot program) and the VDC-BASIC label helpers of test/vice_view.py (stub_rts, vdc_labels,
// stopwatch, flags). vice_smoke.py stays Python.
//
// Rules (review-notes A): port --port, else DBE_VICE_PORT, else 6631; range 6631-6649; bind test on 127.0.0.1.
// VICE with -remotemonitor -remotemonitoraddress ip4://127.0.0.1:<port>. Only the own process is terminated (SIGTERM,
// after 10 s SIGKILL), never pkill/killall. Event-driven: breakpoints and monitor prompts; timeouts are only guards.
//
// API:
//   ROOT, VDC, VERSION, OUT          repository root, VDC-BASIC directory (VDCBASIC_DIR), engine version, build/vice
//   sh(cmd, args, opts)              run a command, exit with 'Error (rc): ...' on failure (vice_smoke.sh)
//   tok(bas, prg, start)             tokenize with VDC-BASIC test/bastok.py (vice_smoke.tok)
//   makeBoot(outDir)                 boot.bas of VDC-BASIC with '50 RUN"T"', tokenized -> path of boot.prg
//   portFree(p), choosePort(arg)     async; choosePort exits with code 2 like vicemon.choose_port
//   Exited                           error: VICE has ended (debug cartridge)
//   Monitor                          remote monitor: cmd, go, mem, bp, regX, send
//   runVice(args, port, tmo, script) async: x128 + monitor, await script(monitor), own process ended -> [result, exit code]
//   symbols(path)                    ACME symbol list -> {name: value}
//   findNode(), findBlitzc(), blitzRuntime()
//   stubRts(), vdcLabels(), stopwatch(m), flags(m)
import { spawn, spawnSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { readFileSync, writeFileSync, existsSync, accessSync, constants, mkdtempSync, rmSync, cpSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { ROOT } from './assets.js';

export { ROOT };
export const VDC = process.env.VDCBASIC_DIR || join(homedir(), 'git', 'vdc-basic');
export const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
export const OUT = join(ROOT, 'build', 'vice');
export const PROMPT = /\(C:\$([0-9a-f]{4})\) /g;

/** Requirement check of the harnesses (vice_smoke.py at import time). */
export function requireVdc() {
  if (!existsSync(join(VDC, 'test', 'vicemon.py'))) {
    console.error(`VDC-BASIC not found: ${VDC}/test/vicemon.py (set VDCBASIC_DIR)`);
    process.exit(1);
  }
}

/** Runs a command; on a non-zero exit code: 'Error (rc): cmd' and exit 1. opts: spawnSync options. */
export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error || r.status) {
    console.error(`Error (${r.error ? r.error.code : r.status}): ${[cmd, ...args].join(' ')}`);
    process.exit(1);
  }
  return r;
}

/** Tokenizes a BASIC listing with VDC-BASIC's bastok.py (start address e.g. '0x4001'). */
export function tok(bas, prg, start = null) {
  sh('python3', ['-B', join(VDC, 'test', 'bastok.py'), ...(start ? ['--start', start] : []), bas, prg]);
}

/** boot.bas of VDC-BASIC with line 50 = RUN"T" (starts the test program 't'), tokenized into outDir/boot.prg. */
export function makeBoot(outDir = OUT) {
  mkdirSync(outDir, { recursive: true });
  const bas = join(outDir, 'boot.bas');
  const lines = readFileSync(join(VDC, 'boot', 'boot.bas'), 'utf8').split(/(?<=\n)/);
  writeFileSync(bas, lines.map((l) => (l.startsWith('50 ') ? '50 RUN"T"\n' : l)).join(''));
  const prg = join(outDir, 'boot.prg');
  tok(bas, prg);
  return prg;
}

// ------------------------------------------------------------------ port choice
/** Can the port be bound on 127.0.0.1? (Node sets SO_REUSEADDR like VICE: TIME_WAIT of a previous run is free.) */
export function portFree(p) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export async function choosePort(arg = null) {
  if (arg !== null && arg !== undefined) {
    if (!(await portFree(arg))) {
      console.error(`Port ${arg} ist belegt (explizit angegeben)`);
      process.exit(2);
    }
    return arg;
  }
  const p0 = parseInt(process.env.DBE_VICE_PORT || '6631', 10);
  if (!(p0 >= 6631 && p0 <= 6649)) {
    console.error(`DBE_VICE_PORT=${p0} liegt nicht in 6631-6649`);
    process.exit(2);
  }
  if (await portFree(p0)) return p0;
  for (let p = 6631; p < 6650; p++) {
    if (await portFree(p)) {
      console.log(`Port ${p0} belegt, nehme ${p}`);
      return p;
    }
  }
  console.error('Kein freier Port in 6631-6649');
  process.exit(2);
}

// ------------------------------------------------------------------ monitor
/** VICE has ended (e.g. via the debug cartridge). */
export class Exited extends Error {
  constructor(msg = 'VICE exited') { super(msg); this.name = 'Exited'; }
}

export class TimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'TimeoutError'; }
}

/** Remote monitor of VICE (text protocol). All waits end on a prompt, on the end of the connection or at the guard deadline. */
export class Monitor {
  constructor(sock, deadline, proc) {
    this.s = sock;
    this.deadline = deadline;          // guard for the whole run (ms since epoch)
    this.proc = proc;
    this.buf = '';
    this.pc = null;
    this.closed = false;
    this.waiter = null;
    sock.setEncoding('latin1');
    sock.on('data', (x) => { this.buf += x; this._check(); });
    const end = () => { this.closed = true; this._check(); };
    sock.on('end', end);
    sock.on('close', end);
    sock.on('error', end);             // ECONNRESET counts as end of the connection
  }

  /** Connects to VICE (retry only until VICE opens the port), stops the emulation (two prompts). */
  static async connect(port, tmo, proc) {
    const deadline = Date.now() + tmo * 1000;
    for (;;) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`VICE vor dem Monitor-Verbindungsaufbau beendet (${proc.exitCode})`);
      const sock = await new Promise((resolve) => {
        const s = createConnection({ port, host: '127.0.0.1' });
        s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
        s.once('error', () => { s.destroy(); resolve(null); });
      });
      if (sock) {
        const m = new Monitor(sock, deadline, proc);
        m.send('\n');
        await m._prompt(2);
        return m;
      }
      if (Date.now() > deadline) throw new TimeoutError('Monitor-Port oeffnet nicht');
      // the port is not open yet: VICE writes no log line for the monitor server, so the connect is repeated
      await new Promise((r) => {
        const done = () => { clearTimeout(t); proc.off('exit', done); r(); };
        const t = setTimeout(done, 50);
        proc.once('exit', done);
      });
    }
  }

  _check() {
    const w = this.waiter;
    if (!w) return;
    const ends = [...this.buf.matchAll(PROMPT)].map((m) => m.index + m[0].length);
    if (ends.length >= w.n) {
      const end = ends[w.n - 1];
      const out = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(out);
    } else if (this.closed) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(new Exited());
    }
  }

  /** Waits for n prompts; returns the text up to the n-th prompt. */
  _prompt(n = 1) {
    return new Promise((resolve, reject) => {
      const rest = this.deadline - Date.now();
      if (rest <= 0) { reject(new TimeoutError('Waechter-Timeout abgelaufen')); return; }
      const timer = setTimeout(() => { this.waiter = null; reject(new TimeoutError('Waechter-Timeout abgelaufen')); }, rest);
      this.waiter = { n, resolve, reject, timer };
      this._check();
    });
  }

  send(text) { if (!this.closed) this.s.write(text, 'latin1'); }

  async cmd(c) {
    this.send(c + '\n');
    return this._prompt();
  }

  /** Continue until the next stop; returns [PC, text]. Throws Exited when VICE ends. */
  async go() {
    this.send('x\n');
    const out = await this._prompt();
    const all = [...out.matchAll(/\(C:\$([0-9a-f]{4})\)/g)];
    this.pc = parseInt(all[all.length - 1][1], 16);
    return [this.pc, out];
  }

  async mem(a, n = 1) {
    const t = await this.cmd(`m ${a.toString(16).padStart(4, '0')} ${(a + n - 1).toString(16).padStart(4, '0')}`);
    const data = new Map();
    for (const mm of t.matchAll(/>C:([0-9a-f]{4})((?:\s+[0-9a-f]{2}){1,16})/g)) {
      mm[2].trim().split(/\s+/).forEach((x, k) => data.set(parseInt(mm[1], 16) + k, parseInt(x, 16)));
    }
    const out = [];
    for (let k = 0; k < n; k++) {
      if (!data.has(a + k)) throw new Error(`monitor: no data for $${(a + k).toString(16)}`);
      out.push(data.get(a + k));
    }
    return out;
  }

  async bp(a, cond = null) {
    const t = await this.cmd(`break ${a.toString(16).padStart(4, '0')}` + (cond ? ` if ${cond}` : ''));
    return parseInt(/BREAK: (\d+)/.exec(t)[1], 10);
  }

  async regX() {
    const all = [...(await this.cmd('r')).matchAll(/\.;[0-9a-f]{4} [0-9a-f]{2} ([0-9a-f]{2})/g)];
    return parseInt(all[all.length - 1][1], 16);
  }

  close() { this.s.destroy(); }
}

/** Starts x128 with the remote monitor, awaits script(monitor), ends the own process.
 *  Returns [result of script, exit code of VICE or null]. */
export async function runVice(args, port, tmo, script, emu = 'x128') {
  const cmd = [...args, '-remotemonitor', '-remotemonitoraddress', `ip4://127.0.0.1:${port}`];
  const vice = spawn(emu, cmd, { stdio: 'ignore' });
  const exited = new Promise((resolve) => vice.once('exit', (code, sig) => resolve(code !== null ? code : -1)));
  let m = null;
  try {
    m = await Monitor.connect(port, tmo, vice);
    const res = await script(m);
    // wait for the own process to end (debug cartridge), at most until the guard deadline (at least 1 s)
    const rest = Math.max(1000, m.deadline - Date.now());
    let timer;
    const rc = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r(null), rest); })]);
    clearTimeout(timer);
    return [res, rc];
  } finally {
    if (m) m.close();
    if (vice.exitCode === null && vice.signalCode === null) {
      vice.kill('SIGTERM');
      let timer;
      const done = await Promise.race([exited.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), 10000); })]);
      clearTimeout(timer);
      if (!done) { vice.kill('SIGKILL'); await exited; }
    }
  }
}

/** ACME symbol list (acme -l) -> {name: value}. */
export function symbols(path) {
  const sym = {};
  for (const line of readFileSync(path, 'latin1').split('\n')) {
    const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*\$([0-9a-fA-F]+)/.exec(line);
    if (m) sym[m[1]] = parseInt(m[2], 16);
  }
  return sym;
}

export function findNode() {
  if (process.env.NODE) return process.env.NODE;
  for (const d of (process.env.PATH || '').split(delimiter)) {
    const p = join(d, 'node');
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  const base = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(base)) {
    const c = readdirSync(base).map((v) => join(base, v, 'bin', 'node')).filter((p) => existsSync(p))
      .sort((a, b) => {
        const ka = (a.split('/node/')[1].match(/\d+/g) || []).map(Number), kb = (b.split('/node/')[1].match(/\d+/g) || []).map(Number);
        for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? -1) !== (kb[i] ?? -1)) return (ka[i] ?? -1) - (kb[i] ?? -1);
        return 0;
      });
    if (c.length) return c[c.length - 1];
  }
  return process.execPath;               // this process is a node as well
}

/** Runtime for blitzc: env BLITZ_RUNTIME (original|fixed|improved), default improved (= blitzc default). */
export const blitzRuntime = () => process.env.BLITZ_RUNTIME || 'improved';

export function findBlitzc() {
  const p = process.env.BLITZC || join(homedir(), 'git', 'blitz-compiler', 'blitz128', 'blitzc', 'js', 'cli.js');
  return existsSync(p) ? p : null;
}

// ------------------------------------------------------------------ stub and VDC-BASIC labels
/** Address of the RTS at the end of the stub (exit of SYS 3331): label call_rts from build/stub.lbl. */
export function stubRts() {
  const stub = `dbe${VERSION}.stub`;
  for (const line of readFileSync(join(ROOT, 'build', 'stub.lbl'), 'latin1').split('\n')) {
    const m = /^al ([0-9A-Fa-f]+) \.call_rts$/.exec(line.trim());
    if (m) {
      const a = parseInt(m[1], 16);
      const d = readFileSync(join(ROOT, 'build', stub));
      if (d[2 + a - (d[0] | (d[1] << 8))] !== 0x60) throw new Error('RTS at call_rts not found');
      return a;
    }
  }
  console.error('call_rts missing in build/stub.lbl');
  process.exit(1);
}

let LABELS = null;

/** Addresses of local labels of VDC-BASIC v3 (not in vdcbasic3.sym): ACME report of a copy in the temp directory,
 *  checked against vdcbasic3.bin. {'vcl', '.vcl_next_command', '.vcl_done', '.vms_arg_loop', '.vms_done'}. */
export function vdcLabels() {
  if (LABELS) return LABELS;
  const want = ['vcl', '.vcl_next_command', '.vcl_done', '.vms_arg_loop', '.vms_done'];
  const tmp = mkdtempSync(join(tmpdir(), 'dbevdc-'));
  let rep;
  try {
    cpSync(join(VDC, 'src'), join(tmp, 'src'), { recursive: true });
    const env = { ...process.env, ACME: process.env.ACME || join(homedir(), '.local', 'share', 'acme', 'ACME_Lib') };
    const r = spawnSync('acme', ['-r', 'r.txt', 'src/vdcbasic.asm'], { cwd: tmp, env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.error || r.status) throw new Error(`acme: exit code ${r.error ? r.error.code : r.status}`);
    if (!readFileSync(join(tmp, 'vdcbasic3.bin')).equals(readFileSync(join(VDC, 'vdcbasic3.bin')))) {
      console.error('ACME build differs from vdcbasic3.bin (rebuild VDC-BASIC)');
      process.exit(1);
    }
    rep = readFileSync(join(tmp, 'r.txt'), 'latin1').split('\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const out = {};
  rep.forEach((l, i) => {
    const m = /^\s*\d+\s+(\S+)\s*(;.*)?$/.exec(l);
    if (m && want.includes(m[1])) {
      for (const l2 of rep.slice(i + 1, i + 6)) {
        const m2 = /^\s*\d+\s+([0-9a-f]{4})\s+[0-9a-f]{2}/.exec(l2);
        if (m2) { out[m[1]] = parseInt(m2[1], 16); break; }
      }
    }
  });
  if (Object.keys(out).length !== want.length) {
    console.error(`Labels not found in the ACME report: ${JSON.stringify(out)}`);
    process.exit(1);
  }
  LABELS = out;
  return out;
}

/** Status register of the monitor ('r'). */
export async function flags(m) {
  const all = [...(await m.cmd('r')).matchAll(/\.;[0-9a-f]{4}(?: [0-9a-f]{2}){6} ([01]{8})/g)];
  return parseInt(all[all.length - 1][1], 2);
}

/** Monitor stopwatch (clocks). */
export async function stopwatch(m) {
  return parseInt(/Stopwatch:\s*(\d+)/.exec(await m.cmd('stopwatch'))[1], 10);
}
