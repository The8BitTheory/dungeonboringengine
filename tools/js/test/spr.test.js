// Port of test/tools/test_dbespr.py (docs/specs/P5b-sprites.md, section 9): core/spr.js, core/demo/sprdemo.js,
// cli/spr.js. The demo assets live in an in-memory file map (virtual directory /T/spr, default geometry from
// docs/specs/examples/tex/west140.geom.json + .dvg); the CLI tests run in-process in a real temporary directory.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../core/spr.js';
import * as T from '../core/tex.js';
import * as vrl from '../core/vrl.js';
import * as sprdemo from '../core/demo/sprdemo.js';
import { newImage, putPixel } from '../core/demo/texdemo.js';
import { encodePng } from '../core/io/png.js';
import { decodeImage } from '../core/io/image.js';
import { PyRandom } from '../core/pyrandom.js';
import { runSpr } from '../cli/spr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const EX = join(ROOT, 'docs', 'specs', 'examples', 'tex');
const PAL = T.PALETTE;
const VB = 0x5000;
const X0 = 10, Y0 = 20;

const FILES = new Map();
const enc = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
const put = (p, v) => FILES.set(p, enc(v));
const resolve = (p) => FILES.get(p) ?? null;
const eqBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
const sorted = (s) => [...s].sort((a, b) => a - b);

let ENV = null;
function env() {
  if (ENV) return ENV;
  const dir = '/T/spr';
  const g = sprdemo.generate({ geomJson: new Uint8Array(readFileSync(join(EX, 'west140.geom.json'))), dvg: new Uint8Array(readFileSync(join(EX, 'west140.dvg'))) });
  for (const [n, v] of Object.entries(g.files)) put(`${dir}/${n}`, v);
  const geomPath = `${dir}/west140.geom.json`;
  const geom = T.loadGeom(resolve, geomPath, `${dir}/west140.dvg`);
  const sets = {};
  for (const n of ['blob', 'blob_m', 'gem']) {
    const conf = S.loadConf(FILES.get(`${dir}/${n}.toml`), { path: `${dir}/${n}.toml` });
    const r = S.buildSpriteset(conf, resolve);
    sets[n] = { conf, ...r };
  }
  ENV = { dir, files: g.files, geomPath, geom, vp: geom.viewport, stride: geom.viewport.stride, sets };
  return ENV;
}

/** List -> [[type, ofs_or_n, length]] */
function vmsCmds(lst) {
  const out = [];
  let p = 3;
  const n = lst[1] | (lst[2] << 8);
  for (let i = 0; i < n; i++) {
    const t = lst[p], v = lst[p + 1] | (lst[p + 2] << 8);
    if (t === 1) { out.push([1, v, lst[p + 3]]); p += 4; } else { out.push([t, v, 0]); p += 3; }
  }
  assert.equal(p, lst.length);
  return out;
}

/** Expected image: opaque pixels from img.pix, only inside clip [cx0, cx1, cy0, cy1]. */
function expectedFb(bg, img, x0, y0, stride, clip = null) {
  const fb = Uint8Array.from(bg);
  img.pix.forEach((row, r) => {
    for (let bx = 0; bx < img.w; bx++) {
      if (clip && !(clip[0] <= x0 + bx && x0 + bx < clip[1] && clip[2] <= y0 + r && y0 + r < clip[3])) continue;
      const a = row[2 * bx], b = row[2 * bx + 1];
      const ad = (y0 + r) * stride + x0 + bx;
      if (a !== null && b !== null) fb[ad] = (a << 4) | b;
      else if (a !== null) fb[ad] = (a << 4) | (fb[ad] & 15);
      else if (b !== null) fb[ad] = (fb[ad] & 0xF0) | b;
    }
  });
  return fb;
}

function memFor(ss, seed = 1) {
  const rng = new PyRandom(seed);
  const m = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) m[i] = rng.randrange(256);
  m.set(vrl.decode(vrl.encode(Array.from(ss.vram))), VB);
  return m;
}

// ---------------------------------------------------------------- Helpers for small sources

let tmpN = 0;
const tmpDir = () => `/W${tmpN++}`;

/** Aseprite-like export. cells: [[layer, frame, [[x, y, palidx], ...]]]; returns the path of the JSON. */
function mkAse(tmp, name, cells, { slices = null, tags = null, fmt = 'array', cw = 16, ch = 16, extra = null } = {}) {
  const keys = cells.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const sheet = newImage(cw * keys.length, ch);
  const frames = [];
  keys.forEach(([ln, f, px], i) => {
    for (const [x, y, c] of px) putPixel(sheet, i * cw + x, y, PAL[c]);
    const e = { filename: `${ln}#${f}`, frame: { x: i * cw, y: 0, w: cw, h: ch }, rotated: false, trimmed: false, duration: 100 };
    Object.assign(e, (extra || {})[`${ln}#${f}`] || {});
    frames.push(e);
  });
  put(`${tmp}/${name}.png`, encodePng(sheet));
  const meta = { image: name + '.png', frameTags: tags || [], slices: Object.entries(slices || {}).map(([n, k]) => ({ name: n, keys: k })) };
  const fr = fmt === 'array' ? frames : Object.fromEntries(frames.map((e) => {
    const { filename, ...rest } = e;
    return [filename, rest];
  }));
  put(`${tmp}/${name}.json`, JSON.stringify({ frames: fr, meta }));
  return `${tmp}/${name}.json`;
}

function mkToml(tmp, name, source, geom, extra = '', kw = {}) {
  const sp = { name, geom, angles: 4, ...kw };
  const lines = ['format = "dbespr"', 'version = 1', '', '[sprite]'];
  for (const [k, v] of Object.entries(sp)) {
    lines.push(`${k} = ${v !== null && typeof v === 'object' && !Array.isArray(v)
      ? '{ ' + Object.entries(v).map(([a, b]) => `${a} = ${b}`).join(', ') + ' }' : JSON.stringify(v)}`);
  }
  lines.push('', '[source]', source, extra);
  const p = `${tmp}/${name}.toml`;
  put(p, lines.join('\n') + '\n');
  return p;
}

const rect = (x, y, w, h, c = 5) => {
  const out = [];
  for (let xx = x; xx < x + w; xx++) for (let yy = y; yy < y + h; yy++) out.push([xx, yy, c]);
  return out;
};

const load = (p) => S.loadConf(FILES.get(p), { path: p });
const build = (p) => { const r = S.buildSpriteset(load(p), resolve); return [r.ss, r.warnings, r.infos, r.sources]; };

function buildAse(cells, { slices = null, tags = null, fmt = 'array', extra = null, ...kw } = {}) {
  const tmp = tmpDir();
  mkAse(tmp, 't', cells, { slices, tags, fmt, extra });
  return build(mkToml(tmp, 't', 'aseprite = "t.json"', env().geomPath, '', kw));
}

const imgEq = (a, b) => a.w === b.w && a.h === b.h && a.fx === b.fx && a.fy === b.fy && a.edgeOfs === b.edgeOfs
  && a.edgeLen === b.edgeLen && eqBytes(a.edge, b.edge) && eqBytes(a.vms, b.vms) && a.cores.length === b.cores.length
  && a.cores.every((k, i) => JSON.stringify(k) === JSON.stringify(b.cores[i]));

// ---------------------------------------------------------------- Aseprite

describe('Aseprite', () => {
  test('slice pivot and default foot', () => {
    const c = [['v0_d1', 0, rect(2, 3, 5, 4)], ['v0_d2', 0, rect(2, 3, 5, 4)]];
    const sl = {
      v0_d1: [{ frame: 0, bounds: { x: 2, y: 3, w: 5, h: 4 }, pivot: { x: 1, y: 2 } }],
      v0_d2: [{ frame: 0, bounds: { x: 2, y: 3, w: 5, h: 4 } }],
    };
    const [ss] = buildAse(c, { slices: sl });
    const a = ss.images[ss.index[0]], b = ss.images[ss.index[1]];
    assert.deepEqual([a.w, a.h, a.fx, a.fy], [3, 4, 0, 2]);
    assert.deepEqual([b.fx, b.fy], [1, 3]);
  });

  test('key selection per frame', () => {
    const c = [0, 1, 2].map((f) => ['v0_d1', f, rect(2, 2, 4 + f, 3)]);
    const sl = { v0_d1: [{ frame: 0, bounds: { x: 2, y: 2, w: 4, h: 3 } }, { frame: 2, bounds: { x: 2, y: 2, w: 6, h: 3 } }] };
    const [ss, w] = buildAse(c, { slices: sl });
    assert.deepEqual([0, 1, 2].map((f) => ss.images[ss.index[f * 4 * 3]].w), [2, 2, 3]);
    assert.ok(w.some((x) => x.includes('outside the slice')));
  });

  test('bbox without slice and info', () => {
    const [ss, , infos] = buildAse([['v0_d1', 0, rect(3, 5, 4, 6)]]);
    const im = ss.images[0];
    assert.deepEqual([im.w, im.h, im.fx, im.fy], [3, 6, 1, 5]);
    assert.ok(infos.some((x) => x.includes('foot point automatic')));
  });

  test('empty cel, unknown layer, phase 0 warning', () => {
    const c = [['v0_d1', 0, rect(1, 1, 4, 4)], ['v0_d1', 1, []], ['ref', 0, rect(0, 0, 2, 2)], ['v1_d1', 1, rect(1, 1, 4, 4)]];
    const [ss, w, infos] = buildAse(c, { angles: 2, phases: 2 });
    assert.equal(ss.index[(1 * 2 + 0) * 3], S.FALLBACK);
    assert.equal(ss.index[(0 * 2 + 1) * 3], S.NOIMG);
    assert.ok(w.some((x) => x.includes('phase 0 without image')));
    assert.ok(infos.some((x) => x.includes("'ref'")));
  });

  test('errors', () => {
    const cases = [[[['v4_d1', 0, rect(0, 0, 2, 2)]], {}], [[['v0_d4', 0, rect(0, 0, 2, 2)]], {}],
      [[['v0_d0', 0, rect(0, 0, 2, 2)]], {}], [[['v0_d1', 0, rect(0, 0, 2, 2)]], { 'v0_d1#0': { trimmed: true } }],
      [[['v0_d1', 0, rect(0, 0, 2, 2)]], { 'v0_d1#0': { rotated: true } }]];
    for (const [cells, extra] of cases) assert.throws(() => buildAse(cells, { extra }), T.TexError, cells[0][0]);
  });

  test('json hash equals array', () => {
    const c = [['v0_d1', 0, rect(2, 2, 5, 5)], ['v0_d1', 1, rect(2, 2, 6, 5)]];
    const [a] = buildAse(c, { fmt: 'array' });
    const [b] = buildAse(c, { fmt: 'hash' });
    assert.ok(eqBytes(S.toS2(a), S.toS2(b)));
  });

  test('tags', () => {
    const c = [0, 1, 2].map((f) => ['v0_d1', f, rect(2, 2, 4, 4)]);
    const tg = [{ name: 'walk cycle_long', from: 0, to: 2, direction: 'pingpong' }, { name: 'x', from: 1, to: 1 }];
    const [ss, w] = buildAse(c, { tags: tg, extra: { 'v0_d1#2': { duration: 200 } } });
    const t = ss.tags;
    assert.deepEqual([t[0].name, t[0].first, t[0].count, t[0].mode], ['WALK_CYC', 0, 3, 2]);
    assert.equal(t[0].dur, T.pyRound((100 + 100 + 200) / 3 * 60 / 1000));
    assert.deepEqual([t[1].mode, t[1].dur], [0, 6]);
    assert.ok(w.some((x) => x.includes('shortened')) && w.some((x) => x.includes('unequal durations')));
  });
});

// ---------------------------------------------------------------- PNG

describe('PNG', () => {
  const png = (tmp, rects, size = [40, 40]) => {
    const im = newImage(...size);
    for (const [x, y, w, h] of rects) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) putPixel(im, xx, yy, PAL[5]);
    put(`${tmp}/p.png`, encodePng(im));
  };
  const conf = (tmp, images, kw = {}) => {
    const extra = images.map(([b, p, d, f]) => `[[image]]\nbox = [${b.join(', ')}]\nphase = ${p}\nangle = 0\ndepth = ${d}\n${f}\n`).join('');
    return mkToml(tmp, 'p', 'png = "p.png"', env().geomPath, extra, { angles: 1, ...kw });
  };

  test('byte raster odd x', () => {
    const tmp = tmpDir();
    png(tmp, [[3, 2, 3, 4]]);
    const [ss, , infos] = build(conf(tmp, [[[3, 2, 3, 4], 0, 1, 'foot = [2, 3]']]));
    const im = ss.images[0];
    assert.deepEqual([im.w, im.h, im.fx, im.fy], [2, 4, 1, 3]);
    assert.deepEqual(im.pix[0], [null, 5, 5, 5]);
    assert.ok(infos.some((x) => x.includes('byte boundary')));
  });

  test('errors', () => {
    const tmp = tmpDir();
    png(tmp, [[3, 2, 3, 4]]);
    assert.throws(() => build(conf(tmp, [[[3, 2, 3, 4], 0, 1, ''], [[3, 2, 3, 4], 0, 1, '']])), T.TexError);   // duplicated
    assert.throws(() => build(conf(tmp, [[[3, 2, 3, 4], 0, 4, '']])), T.TexError);                          // depth > D
    png(tmp, [[0, 0, 8, 4]], [8, 4]);
    assert.throws(() => build(conf(tmp, [[[0, 0, 8, 4], 0, 1, 'foot = [9, 1]']])), T.TexError);             // foot outside
  });

  test('height warning', () => {
    const tmp = tmpDir();
    png(tmp, [[0, 0, 8, 80]], [8, 80]);
    const [, w] = build(conf(tmp, [[[0, 0, 8, 80], 0, 1, '']]));
    assert.ok(w.some((x) => x.includes('wall top edge')));
  });

  test('unknown key and conflicts', () => {
    const tmp = tmpDir();
    assert.throws(() => load(mkToml(tmp, 'k', 'png = "p.png"', env().geomPath, '', { bogus: 1 })), T.TexError);
    for (const kw of [{ angle_map: [0, 1, 2, 4] }, { angles: 2, mirror: { 1: 1 } }, { derive: 'x' }, { phases: 33 }]) {
      assert.throws(() => load(mkToml(tmp, 'k', 'aseprite = "t.json"', env().geomPath, '', kw)), T.TexError, JSON.stringify(kw));
    }
  });

  test('default angle maps', () => {
    const tmp = tmpDir();
    for (const [na, m] of Object.entries(S.DEFAULT_MAP)) {
      assert.deepEqual(load(mkToml(tmp, 'k', 'aseprite = "t.json"', env().geomPath, '', { angles: +na })).angle_map, m);
    }
  });

  test('derive', () => {
    const tmp = tmpDir();
    png(tmp, [[0, 0, 20, 16]]);
    const [ss, w] = build(conf(tmp, [[[0, 0, 20, 16], 0, 1, 'foot = [10, 15]']], { derive: 'nearest' }));
    const pl = env().geom.planes;
    const Wf = (d) => 1 / (0.5 / pl[d].W + 0.5 / pl[d + 1].W);
    for (const d of [2, 3]) {
      const k = Wf(d) / Wf(1);
      const im = ss.images[ss.index[d - 1]];
      const nw = T.pyRound(20 * k), nh = T.pyRound(16 * k);
      assert.deepEqual([im.w, im.h], [Math.floor((nw + 1) / 2), nh]);
      assert.equal(im.pix[0].length, 2 * im.w);
      assert.ok(im.pix.every((row) => row.slice(0, nw).every((v) => v === 5)));
    }
    assert.ok(w.some((x) => x.includes('derived from depth 1')));
    assert.ok(!w.some((x) => x.includes('phase 0 without image')));
  });
});

// ---------------------------------------------------------------- Build

describe('Build', () => {
  const blob = () => env().sets.blob;

  test('roundtrip unclipped', () => {
    const { ss } = blob(), st = env().stride;
    const m = memFor(ss);
    ss.images.forEach((im, i) => {
      const fb = Uint8Array.from(m);
      assert.ok(S.renderImage(ss, i, fb, fb, X0, Y0, env().vp, { vb: VB }));
      assert.ok(eqBytes(fb, expectedFb(m, im, X0, Y0, st)), `image ${i}`);
    });
  });

  test('clipping exhaustive', () => {
    const { ss } = blob(), st = env().stride;
    const m = memFor(ss, 2);
    let n = 0;
    ss.images.forEach((im, i) => {
      const xs = sorted(new Set([0, 1, im.w >> 1, im.w - 1, im.w])), ys = sorted(new Set([0, 1, im.h - 1, im.h]));
      for (const L of xs) for (const R of xs) for (const Tp of ys) for (const B of ys) {
        if (L >= R || Tp >= B) continue;
        const clip = [X0 + L, X0 + R, Y0 + Tp, Y0 + B];
        n++;
        const fb = Uint8Array.from(m);
        S.renderImage(ss, i, fb, fb, X0, Y0, env().vp, { vb: VB, clip });
        assert.ok(eqBytes(fb, expectedFb(m, im, X0, Y0, st, clip)), `image ${i} ${[L, R, Tp, B]}`);
        const c = S.clipImage(im, X0, Y0, ...clip, st);
        if (c.vms) {
          const cmds = vmsCmds(c.vms);
          assert.ok(cmds.every(([t]) => [1, 3, 8].includes(t)));
          assert.notEqual(cmds[cmds.length - 1][0], 3);
          assert.ok(cmds.every((a, j) => j === 0 || !(a[0] === 3 && cmds[j - 1][0] === 3)));
          const used = cmds.reduce((acc, [t, v, ln]) => acc + (t === 1 ? ln : t === 3 ? v : 1), 0);
          assert.ok(used <= im.edgeLen);
          assert.ok(cmds.some(([t]) => t !== 3));
        }
      }
    });
    assert.ok(n > 1000);
  });

  test('unclipped list identical', () => {
    for (const im of blob().ss.images) {
      const c = S.clipImage(im, X0, Y0, X0, X0 + im.w, Y0, Y0 + im.h, env().stride);
      assert.equal(c.vms, im.vms.length ? im.vms : null);
      assert.deepEqual(c.ref, [X0, Y0]);
    }
  });

  test('core srcstep rule', () => {
    const im = new S.Img(8, 6, 0, 0, { cores: [new T.Core(100, 0, 0, 8, 6, 0), new T.Core(500, 0, 0, 8, 6, 20)] });
    let c = S.clipImage(im, 0, 0, 0, 8, 2, 6, 80);
    assert.deepEqual(c.cores, [[100 + 16, 0, 2, 8, 4, 0], [500 + 40, 0, 2, 8, 4, 20]]);
    c = S.clipImage(im, 0, 0, 1, 5, 0, 6, 80);
    assert.deepEqual(c.cores, [[101, 1, 0, 4, 6, 8], [501, 1, 0, 4, 6, 20]]);
    assert.equal(c.vms, null);
  });

  test('vms format rules', () => {
    for (const { ss } of Object.values(env().sets)) {
      for (const im of ss.images) {
        if (!im.vms.length) continue;
        let prev = -1;
        for (const [t, ofs, ln] of vmsCmds(im.vms)) {
          assert.ok(t === 1 || t === 8);
          assert.ok(ofs >= prev);
          prev = ofs + (ln || 1);
          assert.ok(Math.floor(ofs / ss.stride) < im.h);
          assert.ok((ofs % ss.stride) + (ln || 1) <= im.w);
        }
      }
    }
  });

  test('check vms', () => {
    const ok = Uint8Array.from([0, 2, 0, 1, 2, 0, 3, 8, 5, 0]);
    T.checkVms(ok, 6, 1, 10);
    const bad = [[0, 2, 0, 1, 2, 0, 3, 8, 4, 0], [0, 1, 0, 1, 4, 0, 3], [0, 1, 0, 8, 10, 0], [0, 1, 0, 3, 2, 0],
      [0, 2, 0, 8, 5, 0, 8, 2, 0], [0, 2, 0, 8, 5, 0]];
    for (const b of bad) assert.throws(() => T.checkVms(Uint8Array.from(b), 6, 1, 10), T.TexError);
    assert.throws(() => T.checkVms(ok, 11, 1, 10), T.TexError);
  });

  test('lookup', () => {
    const { ss } = blob();
    for (let f = 0; f < 4; f++) {
      for (let a = 0; a < 4; a++) {
        for (let d = 1; d < 4; d++) {
          const ai = ss.angleMap[a];
          const ff = f < ss.np ? f : 0;
          let v = ss.index[(ff * ss.na + ai) * ss.depth + d - 1];
          if (v === S.FALLBACK) v = ss.index[ai * ss.depth + d - 1];
          assert.equal(S.lookup(ss, f, a, d), v >= S.NOIMG ? null : v);
        }
      }
    }
    assert.equal(S.lookup(ss, 1, 0, 3), S.lookup(ss, 0, 0, 3));
    assert.equal(S.lookup(ss, 5, 1, 1), S.lookup(ss, 0, 1, 1));
    assert.equal(S.lookup(ss, 0, 0, 0), null);
    assert.equal(S.lookup(ss, 0, 0, 4), null);
    const s2 = { ...ss, index: new Array(ss.index.length).fill(S.NOIMG) };
    assert.equal(S.lookup(s2, 0, 0, 1), null);
    assert.deepEqual([[0, 2], [0, 0], [1, 3], [3, 0], [2, 0xFF]].map(([v, o]) => S.viewAngle(v, o)), [0, 2, 0, 1, 0]);
  });

  test('lookup angle map per NA', () => {
    const ss = { ...blob().ss };
    for (const [na, m] of Object.entries(S.DEFAULT_MAP)) {
      ss.na = +na; ss.angleMap = m;
      ss.index = Array.from({ length: ss.np * ss.na * ss.depth }, (_, i) => Math.min(i, 0xFD));
      for (let a = 0; a < 4; a++) assert.equal(S.lookup(ss, 0, a, 2), ss.index[m[a] * ss.depth + 1]);
    }
  });

  test('mirror', () => {
    const { ss, sources } = env().sets.blob_m;
    for (let f = 0; f < 2; f++) {
      for (let d = 1; d < 4; d++) {
        const v3 = ss.index[(f * 4 + 3) * 3 + d - 1], v1 = ss.index[(f * 4 + 1) * 3 + d - 1];
        if (v3 >= S.NOIMG) continue;
        const a = ss.images[v3], b = ss.images[v1];
        assert.deepEqual(a.pix, b.pix.map((r) => r.slice().reverse()));
        assert.deepEqual([a.w, a.h, a.fy], [b.w, b.h, b.fy]);
        assert.equal(a.fx, b.w - 1 - b.fx);
        assert.ok(sources.get(S.cellKey(f, 3, d)).includes('mirrored'));
      }
    }
    const m = memFor(ss, 3);
    ss.images.forEach((im, i) => {
      const fb = Uint8Array.from(m);
      S.renderImage(ss, i, fb, fb, X0, Y0, env().vp, { vb: VB });
      assert.ok(eqBytes(fb, expectedFb(m, im, X0, Y0, env().stride)));
    });
  });

  test('blob properties', () => {
    const { ss, infos } = blob();
    assert.deepEqual([ss.na, ss.np, ss.depth, ss.tags.length], [4, 2, 3, 2]);
    assert.equal(ss.index[(1 * 4 + 0) * 3 + 2], S.FALLBACK);
    assert.deepEqual(ss.tags.map((t) => t.name), ['IDLE', 'WALK']);
    assert.equal(ss.tags[1].mode, 2);
    assert.equal(ss.tags[1].dur, T.pyRound(150 * 60 / 1000));
    assert.ok(infos.some((x) => x.includes('ref')));
    assert.ok(ss.images.some((im) => im.vms.length && vmsCmds(im.vms).some(([t]) => t === 8)));
    const front = ss.images[ss.index[0]];
    assert.ok(front.pix.some((row) => row.some((v, c) => v === null && row.slice(0, c).some((x) => x !== null)
      && row.slice(c).some((x) => x !== null))));
  });

  test('format', () => {
    const { ss } = blob();
    const data = S.toS2(ss, 0x6000);
    assert.deepEqual([data[0], data[1]], [0x00, 0x60]);
    const c = data.subarray(2);
    const u16 = (o) => c[o] | (c[o + 1] << 8);
    assert.deepEqual([...c.subarray(0, 3)], [0x53, 0x32, 1]);
    const NP = c[8], NA = c[7], D = c[6], NI = c[9];
    const nk = u16(10);
    const o = [16, 18, 20, 22].map(u16);
    assert.deepEqual(o, [40, 40 + NP * NA * D, 40 + NP * NA * D + 16 * NI, 40 + NP * NA * D + 16 * NI + 8 * nk]);
    const [oData, total, u, crc, stride] = [26, 28, 30, 32, 34].map(u16);
    assert.equal(oData, o[3] + 12 * c[24]);
    assert.equal(total, c.length);
    assert.equal(u, ss.vram.length);
    assert.equal(crc, T.crcHqx(ss.vram, 0xFFFF));
    assert.equal(stride, 80);
    assert.equal(u16(4), env().geom.geometry_id);
    assert.deepEqual([...c.subarray(12, 16)], [0, 1, 2, 3]);
    const uf = vrl.unpackFile(vrl.packFile(vrl.encode(Array.from(ss.vram)), 0x4000));
    assert.equal(uf.u, u);
    assert.ok(eqBytes(vrl.decode(uf.stream), ss.vram));
    const back = S.fromS2(data, ss.vram);
    assert.equal(back.images.length, ss.images.length);
    back.images.forEach((im, i) => assert.ok(imgEq(im, ss.images[i]), `image ${i}`));
    assert.deepEqual([back.index, back.tags, back.angleMap, back.np, back.na, back.depth, back.stride].map((x) => JSON.stringify(x)),
      [ss.index, ss.tags, ss.angleMap, ss.np, ss.na, ss.depth, ss.stride].map((x) => JSON.stringify(x)));
    assert.ok(eqBytes(S.toS2(back, 0x6000), data));
    const ss2 = S.buildSpriteset(load(`${env().dir}/blob.toml`), resolve).ss;
    assert.ok(eqBytes(S.toS2(ss2), data));
    assert.ok(eqBytes(ss2.vram, ss.vram));
  });

  test('from_s2 errors', () => {
    const { ss } = blob();
    const data = S.toS2(ss);
    const cat = (...p) => Uint8Array.from(p.flatMap((x) => [...x]));
    const bad = [data.slice(0, 20), cat(data.slice(0, 2), [0x58, 0x58], data.slice(4)), cat(data.slice(0, 4), [2], data.slice(5)),
      data.slice(0, -5)];
    for (const b of bad) assert.throws(() => S.fromS2(b), T.TexError);
    const off = Uint8Array.from(data);
    off[2 + 18] += 1;
    assert.throws(() => S.fromS2(off), T.TexError);
    assert.throws(() => S.fromS2(data, ss.vram.slice(0, -1)), T.TexError);
  });

  test('limits', () => {
    const base = blob().ss;
    let ss = Object.assign(Object.create(Object.getPrototypeOf(base)), base, { images: new Array(255).fill(base.images[0]) });
    assert.throws(() => S.toS2(ss), T.TexError);
    const big = new S.Img(4, 4, 0, 0, { vms: new Uint8Array(9000), edgeLen: 1 });
    ss = Object.assign(Object.create(Object.getPrototypeOf(base)), base, { images: [big], index: new Array(base.index.length).fill(0) });
    assert.throws(() => S.toS2(ss), T.TexError);
  });

  test('gem item', () => {
    const { ss } = env().sets.gem;
    assert.deepEqual([ss.na, ss.np, ss.flags & 1], [1, 2, 1]);
    assert.deepEqual(ss.angleMap, [0, 0, 0, 0]);
    const m = memFor(ss, 4);
    ss.images.forEach((im, k) => {
      const fb = Uint8Array.from(m);
      S.renderImage(ss, k, fb, fb, X0, Y0, env().vp, { vb: VB });
      assert.ok(eqBytes(fb, expectedFb(m, im, X0, Y0, env().stride)));
    });
  });

  test('any geometry', () => {
    const tmp = tmpDir();
    assert.equal(load(mkToml(tmp, 't', 'aseprite = "x.json"', env().geomPath, '', { any_geometry: true })).any_geometry, true);
    const conf = { ...blob().conf, any_geometry: true };
    const d = S.toS2(S.buildSpriteset(conf, resolve).ss);
    assert.equal(d[6] | (d[7] << 8), 0);
  });

  test('report and budget', () => {
    const { conf, ss, warnings, infos, sources } = blob();
    const stream = vrl.encode(Array.from(ss.vram));
    const rp = S.buildReport(ss, conf, warnings, infos, sources, stream, S.toS2(ss).length - 2);
    assert.equal(rp.rows.length, 2 * 4 * 3);
    assert.equal(rp.max_vms, Math.max(...ss.images.map((x) => x.vms.length)));
    assert.ok(rp.tag_basic.startsWith('REM BLOB: IDLE 0-0'));
    assert.ok(S.reportMd(rp).includes('VCL'));
  });

  test('sim_vms type 3', () => {
    const vram = new Uint8Array(512).map((_, i) => i & 255);
    const fb = new Uint8Array(512).fill(0xA0);
    T.simVms(vram, 10, 100, Uint8Array.from([5, 3, 0, 3, 3, 0, 1, 0, 0, 2, 8, 9, 0]), fb);
    assert.deepEqual([fb[100], fb[101]], [13, 14]);
    assert.equal(fb[109], 0xAF);
    assert.equal(fb[102], 0xA0);
  });
});

// ---------------------------------------------------------------- CLI

describe('CLI', () => {
  test('build, dump, preview, budget', () => {
    const e = env();
    const td = mkdtempSync(join(tmpdir(), 'sprcli-'));
    try {
      const sd = join(td, 'spr');
      mkdirSync(sd);
      for (const [n, v] of Object.entries(e.files)) writeFileSync(join(sd, n), v);
      const out = join(td, 'o');
      let r = runSpr(['build', join(sd, 'blob.toml'), '--out', out]);
      assert.equal(r.code, 0, r.stderr);
      for (const f of ['blob.s2', 'blob.vrl', 'blob.spr.md', 'blob.spr.json', 'blob_preview.png']) assert.ok(existsSync(join(out, f)), f);
      r = runSpr(['dump', join(out, 'blob.s2'), '--vrl', join(out, 'blob.vrl'), '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).ni, 20);
      assert.equal(runSpr(['dump', join(out, 'blob.s2')]).code, 0);
      r = runSpr(['preview', join(out, 'blob.s2'), '--vrl', join(out, 'blob.vrl'), '--geom', join(sd, 'west140.geom.json'),
        '--d', '2', '--out', join(out, 'p.png')]);
      assert.equal(r.code, 0, r.stderr);
      const pim = decodeImage(new Uint8Array(readFileSync(join(out, 'p.png'))));
      assert.deepEqual([pim.width, pim.height], [560, 384]);
      r = runSpr(['budget', join(out, 'blob.s2'), '--pool', '10000']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('sprite'));
      // the P5 budget (core/tex.js) also reads S2
      const b = T.budget([join(out, 'blob.s2')], 10000, { resolve: (p) => new Uint8Array(readFileSync(p)) });
      assert.equal(b.over, 0);
      assert.equal(b.files[0].kind, 'sprite');
    } finally { rmSync(td, { recursive: true, force: true }); }
  });

  test('format errors exit 1', () => {
    const td = mkdtempSync(join(tmpdir(), 'sprcli-'));
    try {
      const bad = join(td, 'bad.s2');
      writeFileSync(bad, Uint8Array.from([0x00, 0x70, 0x53, 0x32, 0x01, ...new Array(10).fill(0)]));
      let r = runSpr(['dump', bad]);
      assert.equal(r.code, 1);
      assert.ok(r.stderr.startsWith('Error: '));
      r = runSpr(['build', join(td, 'missing.toml')]);
      assert.equal(r.code, 1);
      assert.ok(r.stderr.startsWith('Error: '));
      assert.equal(runSpr([]).code, 2);
    } finally { rmSync(td, { recursive: true, force: true }); }
  });
});
