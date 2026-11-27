// Port of test/tools/test_vrl.py (spec docs/specs/P1-vrl.md, section 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { main } from '../cli/dbe.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vrl from '../core/vrl.js';
import { PyRandom } from '../core/pyrandom.js';

const N = null;
const hx = (s) => Uint8Array.from(s.trim().split(/\s+/).filter(Boolean), (b) => parseInt(b, 16));
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'dbe.js');
const rep = (v, n) => new Array(n).fill(v);
const range = (n) => Array.from({ length: n }, (_, i) => i);

test('encode vectors', () => {
  const r128 = range(127).map((i) => i.toString(16).padStart(2, '0')).join(' ');
  const cases = [
    [[], '00'], [[5], '01 05 00'], [[7, 7], '80 07 00'], [rep(7, 3), '81 07 00'],
    [rep(7, 127), 'FD 07 00'], [rep(7, 128), 'FF 80 00 07 00'],
    [rep(7, 65535), 'FF FF FF 07 00'],
    [[...rep(7, 128), 1, 2], 'FD 07 03 07 01 02 00'],
    [[1, 2, 3], '03 01 02 03 00'], [[1, 1, 1, 2], '81 01 01 02 00'],
    [[1, 1, 2, 2, 3], '05 01 01 02 02 03 00'],
    [range(128), '7F ' + r128 + ' 01 7F 00'],
    [[N, 5], 'FE 01 00 01 05 00'], [[5, N], '01 05 00'], [rep(N, 3), '00'],
    [[5, N, N, 5], '01 05 FE 02 00 01 05 00'],
    [[...rep(N, 65534), 1], 'FE FE FF 01 01 00'],
    [rep(N, 70000), '00'],
    [[9, 9, N, 9, 9], '80 09 FE 01 00 80 09 00'],
    [[1, 1, 1, 2, 3, 3, 3], '81 01 01 02 81 03 00'],
  ];
  for (const [data, exp] of cases) assert.deepEqual(vrl.encode(data), hx(exp));
  assert.deepEqual(vrl.encode(new Uint8Array(0)), hx('00'));
  assert.deepEqual(vrl.encode(Uint8Array.of(5)), hx('01 05 00'));
});

test('encode errors', () => {
  for (const data of [rep(7, 65536), [...rep(N, 65535), 1], [256], [-1]]) {
    assert.throws(() => vrl.encode(data), vrl.VrlError);
  }
});

test('encodeRect', () => {
  assert.deepEqual(vrl.encodeRect([1, 2, 3, 4], 2, 2, 80), hx('02 01 02 FE 4E 00 02 03 04 00'));
  assert.deepEqual(vrl.encodeRect(rep(5, 8), 4, 2, 4), hx('86 05 00'));
  assert.deepEqual(vrl.encodeRect(rep(5, 4), 4, 1, 4, [1, 0, 0, 1]), hx('01 05 FE 02 00 01 05 00'));
  assert.deepEqual(vrl.encodeRect([1, 2, 3, 4], 2, 2, 10, [1, 0, 0, 1]), hx('01 01 FE 0A 00 01 04 00'));
  assert.deepEqual(vrl.encodeRect([1, 2], 2, 1, 80, [0, 0]), hx('00'));
  assert.throws(() => vrl.encodeRect([1, 2], 2, 1, 1), vrl.VrlError);
  assert.throws(() => vrl.encodeRect([1, 2], 2, 0, 2), vrl.VrlError);
});

function expectedImage(x, base) {
  const img = Uint8Array.from(base);
  x.forEach((v, i) => { if (v !== null) img[i] = v; });
  return img;
}

function brute(x0) {
  const x = x0.slice();
  while (x.length && x[x.length - 1] === null) x.pop();
  const memo = new Map();
  const f = (i) => {
    if (i === x.length) return 0;
    if (memo.has(i)) return memo.get(i);
    let best = 1e9;
    if (x[i] === null) {
      let k = i;
      while (k < x.length && x[k] === null) k++;
      best = 3 + f(k);
    } else {
      let j = i;
      while (j < x.length && x[j] !== null) j++;
      for (let n = 1; n <= j - i; n++) best = Math.min(best, 1 + n + f(i + n));
      for (let L = 2; L <= j - i; L++) {
        if (new Set(x.slice(i, i + L)).size === 1) best = Math.min(best, (L <= 127 ? 2 : 4) + f(i + L));
      }
    }
    memo.set(i, best);
    return best;
  };
  return f(0);
}

test('roundtrip', () => {
  const rng = new PyRandom(1);
  for (let t = 0; t < 2000; t++) {
    const n = rng.randint(0, 600);
    const alpha = rng.choice([2, 5, 256]);
    const skipfrac = rng.choice([0, 0.1, 0.5]);
    let x = [];
    while (x.length < n) {
      if (rng.random() < 0.03) {
        const v = rng.random() < skipfrac ? null : rng.randrange(alpha);
        x.push(...rep(v, rng.randint(2, 300)));
      } else x.push(rng.random() < skipfrac ? null : rng.randrange(alpha));
    }
    x = x.slice(0, n);
    const s = vrl.encode(x);
    let u = x.length;
    while (u && x[u - 1] === null) u--;
    const base = Uint8Array.from({ length: u + 5 }, () => rng.randrange(256));
    assert.deepEqual(vrl.decode(s, base), expectedImage(x.slice(0, u), base));
    assert.equal(vrl.unpackedLength(s), u);
  }
});

test('optimal', () => {
  const rng = new PyRandom(2);
  for (let t = 0; t < 300; t++) {
    const x = Array.from({ length: rng.randint(0, 12) }, () => rng.choice([0, 1, 2, null]));
    assert.equal(vrl.encode(x).length - 1, brute(x), JSON.stringify(x));
  }
});

test('determinism', () => {
  const r = new PyRandom(3);
  const x = Array.from({ length: 500 }, () => r.choice([1, 2, null]));
  assert.deepEqual(vrl.encode(x), vrl.encode(x));
});

test('limits', () => {
  for (const n of [127, 128]) assert.equal(vrl.encode(range(n)).length - 1, n + (n === 127 ? 1 : 2));
  for (const L of [127, 128, 129, 255, 256, 257, 65534, 65535]) {
    const x = rep(7, L);
    const s = vrl.encode(x);
    assert.equal(s.length, L <= 127 ? 3 : 5);
    assert.deepEqual(vrl.decode(s), Uint8Array.from(x));
  }
  for (const k of [65533, 65534]) {
    const s = vrl.encode([...rep(N, k), 1]);
    const exp = new Uint8Array(k + 1);
    exp[k] = 1;
    assert.deepEqual(vrl.decode(s), exp);
    assert.equal(vrl.unpackedLength(s), k + 1);
  }
  assert.throws(() => vrl.encode(rep(7, 65536)), vrl.VrlError);
});

test('decoder errors', () => {
  for (const s of ['', '03 01', '81', 'FE 01', 'FF 00 00', '01 05']) {
    assert.throws(() => vrl.decode(hx(s)), vrl.VrlError, s);
  }
  assert.throws(() => vrl.decode(hx('FE 00 00 FE 01 00 00')), vrl.VrlError);
});

test('decoder foreign', () => {
  assert.deepEqual(vrl.decode(hx('FF 01 00 07 00')), Uint8Array.of(7));
  assert.deepEqual(vrl.decode(hx('80 07 80 07 00')), Uint8Array.from(rep(7, 4)));
  assert.deepEqual(vrl.decode(hx('FE 05 00 00')), new Uint8Array(5));
  assert.equal(vrl.unpackedLength(hx('FE 05 00 00')), 5);
  assert.equal(vrl.decode(hx('FF 00 00 07 00')).length, 65536);
  const t = vrl.decodeTokens(hx('01 05 81 07 FE 02 00 FF 03 00 09 00'));
  assert.deepEqual(t.map((x) => x.kind), ['lit', 'run', 'skip', 'lrun', 'end']);
  assert.deepEqual(t[0], { kind: 'lit', length: 1, value: Uint8Array.of(5), offset: 0 });
  assert.deepEqual(t.map((x) => x.offset), [0, 2, 4, 7, 11]);
});

test('file frame', () => {
  const s = vrl.encode([1, 2, 3, N, 4]);
  const f = vrl.packFile(s, 0x3000);
  assert.deepEqual(vrl.unpackFile(f), { load: 0x3000, version: 1, u: 5, stream: s });
  assert.deepEqual(f.slice(0, 7), hx('00 30 56 52 01 05 00'));
  const bad = (p, v) => { const g = f.slice(); g.set(v, p); return g; };
  assert.throws(() => vrl.unpackFile(bad(2, [0x58, 0x58])), vrl.VrlError);
  assert.throws(() => vrl.unpackFile(bad(4, [2])), vrl.VrlError);
  assert.throws(() => vrl.unpackFile(bad(5, [6])), vrl.VrlError);
});

const STAT_X = [...rep(7, 300), 1, 2, 3, ...rep(N, 10), 4];

test('stats', () => {
  const s = vrl.encode(STAT_X);
  assert.deepEqual(s, hx('FF 2C 01 07 03 01 02 03 FE 0A 00 01 04 00'));
  const st = vrl.stats(s, 15);
  assert.deepEqual(st.tokens, { lit: 2, run: 0, lrun: 1, skip: 1 });
  assert.deepEqual([st.written, st.skipped, st.unpacked], [304, 10, 314]);
  assert.equal(st.cycles, 4 * 30 + (200 + 300 + 30) + 3 * 22 + 80 + 22);
  assert.equal(st.cycles, 818);
  assert.deepEqual(st.bytes_by_kind, { lit: 4, run_cpu: 0, run_fill: 300 });
  assert.equal(st.run_hist['> 256'], 1);
  assert.equal(st.stream_bytes, s.length);
  assert.ok(Math.abs(st.ratio - s.length / 304) < 1e-12);
});

test('threshold', () => {
  assert.equal(vrl.threshold({}), 14);
  assert.equal(vrl.stats(vrl.encode(rep(5, 14))).bytes_by_kind.run_fill, 14);
  assert.equal(vrl.stats(vrl.encode(rep(5, 13))).bytes_by_kind.run_cpu, 13);
  assert.equal(vrl.threshold({ fill_byte: 15 }), 65537);
  assert.equal(vrl.threshold({ fill_byte: 20 }), 65537);
});

test('benchParams', () => {
  const b = vrl.benchParams({ engine: { tok: 40, T: 9, unknown: 1 } });
  assert.equal(b.tok, 40);
  assert.equal(b.T, 9);
  assert.equal(b.cpu_byte, vrl.PLACEHOLDER.cpu_byte);
  assert.ok(!('unknown' in b));
  assert.equal(vrl.stats(vrl.encode(rep(5, 12)), null, b).T, 9);
  assert.throws(() => vrl.benchParams({}), vrl.VrlError);
});

// ---------------------------------------------------------------- CLI
// in-process (a Node start costs seconds on this machine); one real process start in 'cli process'
function runCli(...args) {
  const out = [], err = [];
  const status = main(['vrl', ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('cli process', () => {
  const r = spawnSync(process.execPath, [CLI, 'vrl', 'encode']);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /expected IN OUT/);
});

test('cli roundtrip', () => {
  const d = mkdtempSync(join(tmpdir(), 'dbe-vrl-'));
  try {
    const rng = new PyRandom(5);
    const raw = Uint8Array.from({ length: 3000 }, () => rng.choice([0, 0, 0, 1, 2]));
    const [a, b, c] = ['a.bin', 'a.vrl', 'c.bin'].map((n) => join(d, n));
    writeFileSync(a, raw);
    assert.equal(runCli('encode', a, b, '--load', '$3000').status, 0);
    assert.deepEqual(new Uint8Array(readFileSync(b)).slice(0, 4), hx('00 30 56 52'));
    assert.equal(runCli('decode', b, c).status, 0);
    assert.deepEqual(new Uint8Array(readFileSync(c)), raw);
    const prg = new Uint8Array(raw.length + 2);
    prg.set([0, 0x40]); prg.set(raw, 2);
    writeFileSync(a, prg);
    assert.equal(runCli('encode', a, b, '--raw', '--in-prg').status, 0);
    assert.equal(runCli('decode', b, c, '--raw', '--out-prg', '0x4000').status, 0);
    assert.deepEqual(new Uint8Array(readFileSync(c)), prg);
    const r = runCli('stats', b, '--raw', '--json');
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).unpacked, raw.length);
    assert.equal(runCli('stats', b, '--raw').status, 0);
  } finally { rmSync(d, { recursive: true }); }
});

test('cli rect and base', () => {
  const d = mkdtempSync(join(tmpdir(), 'dbe-vrl-'));
  try {
    const [a, m, o, base, out] = ['a', 'm', 'o', 'base', 'out'].map((n) => join(d, n));
    writeFileSync(a, Uint8Array.of(1, 2, 3, 4));
    writeFileSync(m, Uint8Array.of(1, 0, 0, 1));
    writeFileSync(base, new Uint8Array(12).fill(9));
    assert.equal(runCli('rect', a, o, '--width', '2', '--height', '2', '--stride', '10', '--mask', m, '--raw').status, 0);
    assert.deepEqual(new Uint8Array(readFileSync(o)), hx('01 01 FE 0A 00 01 04 00'));
    assert.equal(runCli('decode', o, out, '--raw', '--base', base).status, 0);
    assert.deepEqual(new Uint8Array(readFileSync(out)), Uint8Array.from([1, ...rep(9, 10), 4]));
  } finally { rmSync(d, { recursive: true }); }
});

test('cli format error', () => {
  const d = mkdtempSync(join(tmpdir(), 'dbe-vrl-'));
  try {
    const a = join(d, 'bad');
    writeFileSync(a, Uint8Array.of(3, 1));
    let r = runCli('decode', a, join(d, 'o'), '--raw');
    assert.equal(r.status, 1);
    assert.ok(r.stderr.length && !r.stderr.includes('    at '));
    r = runCli('decode', a, join(d, 'o'));
    assert.equal(r.status, 1);
    assert.equal(runCli('encode').status, 2);
  } finally { rmSync(d, { recursive: true }); }
});
