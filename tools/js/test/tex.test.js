// Port of test/tools/test_dbetex.py (docs/specs/P5-textures.md, section 10): core/tex.js, core/demo/texdemo.js,
// cli/tex.js. The example assets of dbetexdemo are generated in memory (virtual directory /T/tex, default geometry =
// docs/specs/examples/tex/west140.geom.json + .dvg); geometry made by dbegeom in Python (other size, paint template)
// comes from the fixtures of test/golden/mkgolden_tex.py (golden/tex/). CLI tests run in-process on a temp directory.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../core/tex.js';
import * as vrl from '../core/vrl.js';
import * as texdemo from '../core/demo/texdemo.js';
import { PyRandom } from '../core/pyrandom.js';
import { decodeImage } from '../core/io/image.js';
import { encodePng } from '../core/io/png.js';
import { deflate, crc32 } from '../core/io/inflate.js';
import { runTex, fsResolve } from '../cli/tex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIX = join(HERE, 'golden', 'tex');
const EX = join(ROOT, 'docs', 'specs', 'examples', 'tex');
const DEMO_MAP = join(ROOT, 'docs', 'specs', 'examples', 'demo.toml');
const PAL = T.PALETTE;
const VB = 0x5000;
const rdf = (p) => new Uint8Array(readFileSync(p));
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// ---------------------------------------------------------------- virtual files

const VFS = new Map();
const put = (p, v) => VFS.set(posix.normalize(p), typeof v === 'string' ? enc(v) : v);
const resolve = (p) => VFS.get(posix.normalize(p)) ?? null;
const text = (p) => dec(resolve(p));
const TMPS = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dbetex-t-')); TMPS.push(d); return d; };
after(() => { for (const d of TMPS) rmSync(d, { recursive: true, force: true }); });

function genInto(dir, opts) {
  const r = texdemo.generate(opts);
  for (const [n, v] of Object.entries(r.files)) put(`${dir}/${n}`, v);
  return r;
}

const DEFAULT = () => ({ geomJson: rdf(join(EX, 'west140.geom.json')), dvg: rdf(join(EX, 'west140.dvg')) });

let ENV = null;
function env() {
  if (ENV === null) {
    const dir = '/T/tex';
    genInto(dir, DEFAULT());
    const geom = T.loadGeom(resolve, `${dir}/west140.geom.json`, `${dir}/west140.dvg`);
    const conf = (n) => T.loadTexConf(resolve(`${dir}/${n}`), { path: `${dir}/${n}` });
    const wconf = conf('walls.toml'), fconf = conf('floor.toml'), cconf = conf('ceil.toml');
    ENV = { dir, geom, wconf, fconf, cconf, walls: T.buildTexset(wconf, resolve), floor: T.buildTexset(fconf, resolve),
      ceil: T.buildTexset(cconf, resolve) };
  }
  return ENV;
}

function confWith(base, styles = null, kw = {}) {
  const c = structuredClone(base);
  if (styles !== null) c.styles = structuredClone(styles);
  return Object.assign(c, kw);
}

/** Expected pixels (palette index | null) for slot si of the style, independent of the entry construction. */
function expectedPixels(conf, geom, styleIdx, slots, si, cache) {
  const key = `${styleIdx},${si}`;
  if (cache.has(key)) return cache.get(key);
  const st = conf.styles[styleIdx];
  const slot = slots[si];
  let res = null;
  if (st.empty.includes(slot.name)) res = null;
  else if (slot.partial) {
    const names = new Map(slots.map((s, i) => [s.name, i]));
    const full = expectedPixels(conf, geom, styleIdx, slots, names.get(`front_d${slot.d}_s+0`), cache);
    if (full !== null) {
      const sdx = slot.src_dx, w = slot.rect[2], h = slot.rect[3];
      res = T.applyMask(full.slice(0, h).map((row) => row.slice(2 * sdx, 2 * (sdx + w))), slot.mask)[0];
    }
  } else {
    const src = 'png' in st ? new T.PngSource(st.png, geom, null, 0, resolve)
      : new T.AseSource(st.aseprite, geom, st.tag, st.frame, null, 0, resolve);
    const box = src.box(slot, []);
    if (box !== null) {
      const [pix] = T.toIndices(src.img, box);
      if (!pix.every((r) => r.every((v) => v === null))) res = T.applyMask(pix, slot.mask)[0];
    }
  }
  cache.set(key, res);
  return res;
}

const randomBytes = (rnd, n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = rnd.randrange(256); return b; };

/** Renders all styles/slots after VRL unpacking and compares with the expected image. */
function runRoundtrip(ts, conf, geom, seed = 1) {
  const slots = ts.slots;
  const stream = vrl.encode(Array.from(ts.vram));
  const mem = new Uint8Array(65536);
  mem.set(vrl.decode(stream), VB);
  const stride = ts.stride;
  const rnd = new PyRandom(seed);
  const cache = new Map();
  for (let sti = 0; sti < ts.styles.length; sti++) {
    slots.forEach((slot, si) => {
      const v = ts.styles[sti][si];
      const use = v === T.FALLBACK ? 0 : sti;
      const bg = randomBytes(rnd, 65536);
      const fb = Uint8Array.from(bg);
      T.render(ts, sti, si, mem, fb, { stride, vb: VB });
      const exp = expectedPixels(conf, geom, use, slots, si, cache);
      const [x, y, w, h] = slot.rect;
      const ref = Uint8Array.from(bg);
      if (exp !== null) {
        for (let r = 0; r < h; r++) {
          for (let px = 0; px < 2 * w; px++) {
            const c = exp[r][px];
            if (c === null) continue;
            const a = (y + r) * stride + x + (px >> 1);
            ref[a] = px % 2 === 0 ? (c << 4) | (ref[a] & 15) : (ref[a] & 0xF0) | c;
          }
        }
      }
      assert.ok(eqBytes(fb, ref), `Style ${sti} slot ${slot.name}`);
    });
  }
}

describe('TestFixed', () => {
  test('brick', () => {
    const e = env();
    const { ts, warnings } = T.buildTexset(confWith(e.wconf, e.wconf.styles.slice(0, 1)), resolve);
    assert.equal(ts.vram.length, 11094);
    assert.equal(ts.entries.length, 25);
    assert.equal(ts.entries.filter((x) => x.flags & T.F_CUTOUT).length, 8);
    const fullW = { 1: 50, 2: 32, 3: 20 };
    for (const en of ts.entries) {
      assert.ok(en.flags & T.F_OCCLUDING);
      const slot = ts.slots[en.slot];
      if (en.flags & T.F_CUTOUT) {
        assert.deepEqual([en.edgeLen, en.vms.length], [0, 0]);
        assert.equal(en.cores.length, 1);
        assert.equal(en.cores[0].srcstep, fullW[slot.d]);
      } else {
        const k = en.cores[0];
        assert.deepEqual([k.dx, k.dy, k.w, k.h], slot.kernel);
      }
    }
    assert.equal(ts.entries.filter((x) => !(x.flags & T.F_CUTOUT)).length, 17);
    assert.deepEqual(warnings, []);
  });

  test('floor_ceiling', () => {
    const e = env();
    const ts = e.floor.ts;
    assert.equal(ts.vram.length, 3640);
    const z = ts.entries.filter((x) => x.flags & T.F_ROWS);
    assert.deepEqual(z.map((x) => x.h), [13, 19, 13, 6]);
    assert.ok(z.every((x) => !x.cores.length && !x.vms.length));
    assert.equal(e.ceil.ts.vram.length, 1540 + 1574);
    assert.ok(!e.ceil.ts.entries.some((x) => x.flags & T.F_ROWS));
  });

  test('ns_and_slotmap', () => {
    const e = env();
    assert.equal(e.walls.ts.ns, 25);
    assert.equal(e.floor.ts.ns, 22);
    assert.equal(e.ceil.ts.ns, 22);
    const sm = e.walls.ts.slotMap;
    const names = new Map(e.geom.elements.map((x) => [x.index, x.name]));
    const got = Object.fromEntries([3, 7, 11, 15].map((i) => [names.get(i), sm[i]]));
    assert.deepEqual(got, { 'side_d0_s-1': 0, 'side_d0_s+1': 1, 'front_d1_s+0': 2, 'front_d1_s-1': 3 });
    for (const el of e.geom.elements) if (['floor', 'ceil', 'obj'].includes(el.art)) assert.equal(sm[el.index], 0xFF);
    const ne = e.geom.elements.length;
    assert.deepEqual(sm.slice(ne), new Array(8).fill(0xFF));
    const fm = e.floor.ts.slotMap;
    const D = e.geom.viewport.depth;
    assert.deepEqual(fm.slice(ne + D + 1).sort((a, b) => a - b), [18, 19, 20, 21]);
    assert.ok(fm.slice(ne, ne + D + 1).every((v) => v === 0xFF));
  });

  test('header_and_roundtrip', () => {
    const e = env();
    const ts = e.walls.ts;
    const dts = T.toDts(ts, 0xA000);
    const c = dts.subarray(2);
    const u16 = (b, o) => b[o] | (b[o + 1] << 8);
    assert.equal(u16(dts, 0), 0xA000);
    assert.deepEqual(Array.from(c.subarray(0, 3)), [0x44, 0x54, 1]);
    assert.equal(u16(c, 4), e.geom.geometry_id);
    assert.deepEqual([c[6], c[7], c[8], c[9]], [e.geom.elements.length, 3, 25, 4]);
    const o = range(6).map((i) => u16(c, 12 + 2 * i));
    const ns = 25, nst = 4, ni = c[10], nk = c[11];
    const nsm = e.geom.elements.length + 8;
    assert.deepEqual(o.slice(0, 5), [32, 32 + nsm, 32 + nsm + nst * ns, 32 + nsm + nst * ns + 16 * ni,
      32 + nsm + nst * ns + 16 * ni + 8 * nk]);
    assert.equal(o[5], c.length);
    const stream = vrl.encode(Array.from(ts.vram));
    assert.equal(u16(c, 24), vrl.unpackedLength(stream));
    assert.equal(u16(c, 26), T.crcHqx(ts.vram, 0xFFFF));
    assert.equal(u16(c, 28), 80);
    const back = T.fromDts(dts, ts.vram);
    assert.deepEqual(back.styles, ts.styles);
    assert.deepEqual(back.slotMap, ts.slotMap);
    assert.equal(back.entries.length, ts.entries.length);
    back.entries.forEach((a, i) => {
      const b = ts.entries[i];
      assert.deepEqual([a.flags, a.slot, a.cores, a.edgeOfs, Array.from(a.edge), Array.from(a.vms), Array.from(a.fill), a.source],
        [b.flags, b.slot, b.cores, b.edgeOfs, Array.from(b.edge), Array.from(b.vms), Array.from(b.fill), b.source]);
    });
  });

  test('vrl_roundtrip_data', () => {
    const ts = env().walls.ts;
    const file = vrl.packFile(vrl.encode(Array.from(ts.vram)), 0x4000);
    const { stream } = vrl.unpackFile(file);
    assert.ok(eqBytes(vrl.decode(stream), ts.vram));
  });
});

describe('TestRoundtrip', () => {
  test('walls', () => { const e = env(); runRoundtrip(e.walls.ts, e.wconf, e.geom); });
  test('floor', () => { const e = env(); runRoundtrip(e.floor.ts, e.fconf, e.geom); });
  test('ceil', () => { const e = env(); runRoundtrip(e.ceil.ts, e.cconf, e.geom); });
});

/** Packs an image, draws it with the simulators and returns {fb, ref, edge, vms, alpha, cores}. */
function simPack(pix, stride, maxCores = 0, coreMin = 16, bg = null) {
  const h = pix.length, w2 = pix[0].length;
  const st = T.classify(pix);
  const cores = T.chooseCores(st, maxCores, coreMin);
  const [alpha, edge, vms] = T.packImage(pix, st, cores, stride);
  const mem = new Uint8Array(65536);
  const kb = T.coreBytes(pix, cores);
  mem.set(kb, 0x4000);
  mem.set(edge, 0x4000 + kb.length);
  const fb = bg === null ? randomBytes(new PyRandom(5), 65536) : Uint8Array.from(bg);
  const ref = Uint8Array.from(fb);
  let src = 0x4000;
  for (const [kx, ky, kw, kh] of cores) {
    T.simVmc(mem, src, ky * stride + kx, kw, kh, stride, 0, fb);
    src += kw * kh;
  }
  if (vms.length) T.simVms(mem, src, 0, vms, fb);
  for (let r = 0; r < h; r++) {
    for (let p = 0; p < w2; p++) {
      const c = pix[r][p];
      if (c === null) continue;
      const a = r * stride + (p >> 1);
      ref[a] = p % 2 === 0 ? (c << 4) | (ref[a] & 15) : (ref[a] & 0xF0) | c;
    }
  }
  return { fb, ref, edge, vms, alpha, cores };
}

describe('TestPacking', () => {
  test('alpha', () => {
    // half-R bytes in color 0 -> alpha != 0
    let r = simPack([[null, 0, null, 3, 5, 6, null, 0]], 20);
    assert.notEqual(r.alpha, 0);
    assert.equal(r.vms[0], r.alpha);
    assert.ok(eqBytes(r.fb, r.ref));
    // half-L byte: alpha on the right
    r = simPack([[4, null, 7, 7, 9, null]], 20);
    assert.equal(r.alpha, 0);
    assert.equal(r.edge[0], 0x40);
    assert.ok(eqBytes(r.fb, r.ref));
  });

  test('alpha_all_16', () => {
    const pix = [range(16).flatMap((c) => [null, c])];
    const st = T.classify(pix);
    assert.equal(T.resolveAlphaConflict(pix, st), 1);
    assert.ok(st[0].every((s) => 'FR'.includes(s)));
    const r = simPack(pix, 40);
    assert.ok(eqBytes(r.fb, r.ref));
    // warning via the builder
    const e = env();
    const { slots, smap } = T.slotInfos(e.geom, 'wall');
    const b = new T.Builder(e.wconf, e.geom, slots, smap);
    const si = slots.findIndex((s) => s.name === 'front_d1_s+0');
    const w = slots[si].rect[2], h = slots[si].rect[3];
    const full = range(h).map(() => new Array(2 * w).fill(1));
    for (let i = 0; i < 16; i++) { full[0][2 * i] = null; full[0][2 * i + 1] = i; }
    b.imageEntry(si, full, slots[si].mask, 't');
    assert.ok(b.warns.some((x) => x.includes('16 colors')));
  });

  test('vms_list_structure', () => {
    for (const en of env().walls.ts.entries) {
      if (!en.vms.length) continue;
      const n = en.vms[1] | (en.vms[2] << 8);
      let p = 3, used = 0;
      for (let i = 0; i < n; i++) {
        const t = en.vms[p];
        if (t === 1) {
          const ln = en.vms[p + 3];
          assert.ok(ln >= 1 && ln <= 255);
          used += ln;
          p += 4;
        } else {
          assert.equal(t, 8);
          used += 1;
          p += 3;
        }
      }
      assert.equal(p, en.vms.length);
      assert.equal(used, en.edgeLen);
    }
  });

  test('vms_only_for_non_core', () => {
    // type 8 exactly for half bytes, type 1 for full ones, nothing for empty and core bytes
    const pix = [[null, null, 1, 2, 3, null, null, 4, 5, 6, 7, 8],
      [null, null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1],
      [null, null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1]];
    const st = T.classify(pix);
    const cores = T.chooseCores(st, 1, 1);
    const [, edge, vms] = T.packImage(pix, st, cores, 6);
    const cmds = [];
    let p = 3;
    while (p < vms.length) { cmds.push([vms[p], vms[p + 1] | (vms[p + 2] << 8)]); p += vms[p] === 1 ? 4 : 3; }
    assert.deepEqual(cores, [[1, 1, 5, 2]]);
    assert.deepEqual(cmds, [[1, 1], [8, 2], [8, 3], [1, 4]]);
    assert.equal(edge.length, 1 + 1 + 1 + 2);
    assert.equal(vms[vms.length - 1], 2);       // last command: type 1 with length 2
  });

  test('long_run', () => {
    const r = simPack([new Array(600).fill(7)], 320);
    assert.ok(eqBytes(r.fb, r.ref));
    assert.equal(r.edge.length, 300);
    const n = r.vms[1];
    const lens = [];
    let p = 3;
    for (let i = 0; i < n; i++) { lens.push(r.vms[p + 3]); p += 4; }
    assert.deepEqual(lens, [255, 45]);
    assert.equal(lens.reduce((a, b) => a + b, 0), r.edge.length);
  });

  test('cores', () => {
    const e = env();
    const ts = e.walls.ts;
    for (const en of ts.entries) assert.ok(en.cores.length <= 4);
    // grid front
    const si = ts.slots.findIndex((s) => s.name === 'front_d1_s+0');
    const g = ts.entries[ts.styles[1][si]];
    assert.ok(g.cores.length >= 2);
    // only full bytes and disjoint: re-read the grid image
    const ts1 = T.buildTexset(confWith(e.wconf, e.wconf.styles.slice(1, 2), { max_cores: 1 }), resolve).ts;
    const g1 = ts1.entries[ts1.styles[0][si]];
    assert.equal(g1.cores.length, 1);
    assert.ok(g.vms.length < g1.vms.length);
    const ts0 = T.buildTexset(confWith(e.wconf, e.wconf.styles.slice(1, 2), { max_cores: 0 }), resolve).ts;
    const g0 = ts0.entries[ts0.styles[0][si]];
    assert.deepEqual(g0.cores, []);
    assert.equal(g0.edgeLen, g.edgeLen + g.cores.reduce((a, k) => a + k.w * k.h, 0));
    // further cores: h >= 2 and area >= core_min
    for (const en of ts.entries) {
      for (const k of en.cores.slice(1)) {
        if (!(en.flags & T.F_CUTOUT)) { assert.ok(k.h >= 2); assert.ok(k.w * k.h >= 16); }
      }
    }
    // directly: disjoint
    let pix = range(10).map(() => new Array(20).fill(3));
    const st = T.classify(pix);
    assert.deepEqual(T.chooseCores(st, 4, 16), [[0, 0, 10, 10]]);
    pix = range(10).map(() => new Array(20).fill(3));
    for (let r = 0; r < 10; r++) { pix[r][10] = null; pix[r][11] = null; }
    const ks = T.chooseCores(T.classify(pix), 4, 16);
    assert.equal(ks.length, 2);
    const cells = new Set();
    for (const [kx, ky, kw, kh] of ks) {
      for (let r = ky; r < ky + kh; r++) {
        for (let c = kx; c < kx + kw; c++) {
          assert.ok(!cells.has(`${r},${c}`));
          cells.add(`${r},${c}`);
        }
      }
    }
    assert.deepEqual(T.chooseCores(st, 0, 16), []);
  });
});

describe('TestOccluding', () => {
  test('flags', () => {
    const ts = env().walls.ts;
    ts.slots.forEach((s, si) => {
      assert.ok(ts.entries[ts.styles[0][si]].flags & T.F_OCCLUDING, s.name);
      if (s.art === 'front') assert.ok(!(ts.entries[ts.styles[1][si]].flags & T.F_OCCLUDING), s.name);
    });
  });

  test('side_transparent_pixel', () => {
    const e = env();
    const { slots } = T.slotInfos(e.geom, 'wall');
    const names = new Map(slots.map((s, i) => [s.name, i]));
    const si = names.get('side_d1_s-1');
    const pix = expectedPixels(e.wconf, e.geom, 0, slots, si, new Map()).map((r) => r.slice());
    const slot = slots[si];
    const [x, y, w] = slot.rect;
    const [c0] = slot.cover;
    const pl = e.geom.planes[slot.d + 1];
    const st = T.classify(pix);
    assert.ok(T.isOccluding(slot, st, e.geom));
    // above T_{d+1}: stays opaque
    const rOut = pl.T - 1 - y;
    const cols = range(w).filter((bx) => st[rOut][bx] === 'F');
    assert.ok(cols.length);
    const p2 = structuredClone(pix);
    p2[rOut][2 * cols[0]] = null;
    assert.ok(T.isOccluding(slot, T.classify(p2), e.geom));
    // within the column range: not opaque
    const p3 = structuredClone(pix);
    p3[pl.T + 1 - y][2 * (c0 - x)] = null;
    assert.ok(!T.isOccluding(slot, T.classify(p3), e.geom));
  });
});

/** Copy of a PNG in the VFS with pixels edited (edit(img) on {width, height, rgba}). */
function copyPngWith(src, dst, edit) {
  const im = decodeImage(resolve(src));
  edit(im);
  put(dst, encodePng(im));
}

const setPx = (im, x, y, c) => im.rgba.set(c, (y * im.width + x) * 4);

describe('TestStyles', () => {
  const blankPng = (rectName, out) => {
    const e = env();
    const el = e.geom.elements.find((x) => x.name === rectName);
    const [ax, ay] = el.atlas;
    const p = `/T/styles/${out}`;
    copyPngWith(`${e.dir}/brick_atlas.png`, p, (im) => {
      for (let r = 0; r < el.rect[3]; r++) for (let c = 0; c < el.rect[2] * 2; c++) setPx(im, ax + c, ay + r, [0, 0, 0, 0]);
    });
    return p;
  };

  test('missing_image', () => {
    const e = env();
    const p = blankPng('front_d2_s+0', 'gap.png');
    let st = [e.wconf.styles[0], { name: 'gap', png: p, empty: [], tag: null, frame: null }];
    let { ts, warnings, infos } = T.buildTexset(confWith(e.wconf, st), resolve);
    let names = new Map(ts.slots.map((s, i) => [s.name, i]));
    for (const n of ['front_d2_s+0', 'front_d2_s-1', 'front_d2_s+1']) {
      assert.equal(ts.styles[1][names.get(n)], 0xFF, n);
      assert.ok(ts.styles[0][names.get(n)] < 0xFE);
    }
    assert.equal(ts.styles[1][names.get('front_d1_s+0')], ts.styles[0][names.get('front_d1_s+0')]);
    assert.ok(infos.some((i) => i.includes('not painted')));
    // identical images: same index, VRAM once
    assert.equal(ts.vram.length, 11094);
    // style 0 without image
    st = [st[1], st[0]];
    ({ ts, warnings, infos } = T.buildTexset(confWith(e.wconf, st), resolve));
    names = new Map(ts.slots.map((s, i) => [s.name, i]));
    for (const n of ['front_d2_s+0', 'front_d2_s-1', 'front_d2_s+1']) assert.equal(ts.styles[0][names.get(n)], 0xFE);
    assert.ok(warnings.some((w) => w.includes('Style 0 without image') && w.includes('front_d2_s+0')));
    assert.ok(ts.styles[1][names.get('front_d2_s+0')] < 0xFE);
  });

  test('empty_and_identical', () => {
    const e = env();
    const s0 = { ...e.wconf.styles[0] };
    const s1 = { ...s0, name: 'copy', empty: ['side_d3_s-3', 'side_d3_s+3'] };
    const { ts } = T.buildTexset(confWith(e.wconf, [s0, s1]), resolve);
    const names = new Map(ts.slots.map((s, i) => [s.name, i]));
    assert.equal(ts.styles[1][names.get('side_d3_s-3')], 0xFE);
    assert.equal(ts.styles[1][names.get('side_d3_s+3')], 0xFE);
    for (const n of names.keys()) {
      if (n !== 'side_d3_s-3' && n !== 'side_d3_s+3') assert.equal(ts.styles[1][names.get(n)], ts.styles[0][names.get(n)], n);
    }
    assert.equal(ts.vram.length, 11094);
    assert.equal(ts.entries.length, 25);
    assert.throws(() => T.buildTexset(confWith(e.wconf, [{ ...s0, empty: ['doesnotexist'] }]), resolve), T.TexError);
  });

  test('partial_follows_empty_full', () => {
    const e = env();
    const s0 = { ...e.wconf.styles[0] };
    const s1 = { ...s0, name: 'x', empty: ['front_d1_s+0'] };
    const { ts } = T.buildTexset(confWith(e.wconf, [s0, s1]), resolve);
    const names = new Map(ts.slots.map((s, i) => [s.name, i]));
    for (const n of ['front_d1_s+0', 'front_d1_s-1', 'front_d1_s+1']) assert.equal(ts.styles[1][names.get(n)], 0xFE);
  });
});

/** RGBA image of the given size, transparent, with pixels px {"x,y": [r, g, b, a]}. */
function img(px, size = [4, 2]) {
  const im = texdemo.newImage(size[0], size[1]);
  for (const [k, v] of Object.entries(px)) { const [x, y] = k.split(',').map(Number); setPx(im, x, y, v); }
  return im;
}

/** Indexed PNG (colour type 3, 8 bit) with a 256-entry palette (like Pillow mode "P"). */
function palettePng(w, h, pal, indices) {
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(enc(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) raw.set(indices.slice(y * w, (y + 1) * w), y * (w + 1) + 1);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Uint8Array.from(pal)),
    chunk('IDAT', deflate(raw)), chunk('IEND', new Uint8Array(0))];
  return Uint8Array.from(parts.flatMap((p) => Array.from(p)));
}

describe('TestInputs', () => {
  test('palette', () => {
    const im = img({ '0,0': [...PAL[3], 255], '1,0': [0x55, 0x55, 0xFE, 255], '2,0': [0x56, 0x56, 0xFC, 255] });
    const [pix, w] = T.toIndices(im, [0, 0, 4, 2]);
    assert.deepEqual(pix[0].slice(0, 3), [3, 3, 3]);
    assert.equal(w.length, 1);
    assert.ok(w[0].includes('2 pixels not in the VDC palette'));
    assert.ok(w[0].includes('max. distance'));
    assert.throws(() => T.toIndices(im, [0, 0, 4, 2], null, 0, true), T.TexError);
    assert.deepEqual(T.toIndices(img({ '0,0': [...PAL[3], 255] }), [0, 0, 4, 2], null, 0, true)[1], []);
  });

  test('alpha', () => {
    const im = img({ '0,0': [255, 0, 0, 128] });
    assert.throws(() => T.toIndices(im, [0, 0, 4, 2]), (e) => e instanceof T.TexError && e.message.includes('mask layer'));
    assert.equal(T.toIndices(im, [0, 0, 4, 2], null, 100)[0][0][0], T.nearest([255, 0, 0])[0]);
    assert.equal(T.toIndices(im, [0, 0, 4, 2], null, 200)[0][0][0], null);
  });

  test('key', () => {
    const im = texdemo.newImage(2, 1, [255, 0, 255, 255]);
    setPx(im, 1, 0, [...PAL[5], 255]);
    assert.deepEqual(T.toIndices(im, [0, 0, 2, 1], 'FF00FF')[0], [[null, 5]]);
  });

  test('indexed_reordered', () => {
    const pal = new Array(768).fill(0);
    pal.splice(3 * 7, 3, ...PAL[12]);      // index 7 in the PNG = color 12
    pal.splice(3 * 2, 3, ...PAL[4]);
    put('/T/inputs/i.png', palettePng(2, 1, pal, [7, 2]));
    assert.deepEqual(T.toIndices(T.readRgba(resolve, '/T/inputs/i.png'), [0, 0, 2, 1])[0], [[12, 4]]);
  });

  test('outside_mask', () => {
    const e = env();
    const { slots, smap } = T.slotInfos(e.geom, 'wall');
    const si = slots.findIndex((s) => s.name === 'side_d1_s-1');
    const slot = slots[si];
    const w = slot.rect[2], h = slot.rect[3];
    const b = new T.Builder(e.wconf, e.geom, slots, smap);
    b.imageEntry(si, range(h).map(() => new Array(2 * w).fill(6)), slot.mask, 't');
    assert.ok(b.warns.some((x) => x.includes('outside the mask') && x.includes('clipped')));
  });

  test('template_unpainted', () => {
    const e = env();
    put('/F/t_atlas.png', rdf(join(FIX, 't_atlas.png')));
    const st = [{ name: 'empty', png: '/F/t_atlas.png', empty: [], tag: null, frame: null }];
    const { ts, infos } = T.buildTexset(confWith(e.wconf, st), resolve);
    assert.equal(ts.entries.length, 0);
    assert.equal(infos.filter((i) => i.includes('not painted')).length, 25 - 8);
  });

  test('atlas_too_small', () => {
    const e = env();
    const im = decodeImage(resolve(`${e.dir}/brick_atlas.png`));
    const small = texdemo.newImage(100, 100);
    for (let y = 0; y < 100; y++) small.rgba.set(im.rgba.subarray(y * im.width * 4, (y * im.width + 100) * 4), y * 400);
    put('/T/inputs/small.png', encodePng(small));
    const st = [{ name: 'k', png: '/T/inputs/small.png', empty: [], tag: null, frame: null }];
    assert.throws(() => T.buildTexset(confWith(e.wconf, st), resolve), T.TexError);
  });

  test('unknown_keys', () => {
    const src = 'format="dbetex"\nversion=1\n[texset]\nname="a"\nkind="wall"\ngeom="g.json"\nfoo=1\n[[style]]\nname="s"\npng="a.png"\n';
    assert.throws(() => T.loadTexConf(src, { path: '/T/inputs/t.toml' }), T.TexError);
  });
});

describe('TestAseprite', () => {
  const setup = () => {
    const e = env();
    const js = JSON.parse(text(`${e.dir}/window.json`));
    put('/T/ase/window.png', resolve(`${e.dir}/window.png`));
    return { e, js };
  };
  const write = (js) => { put('/T/ase/f.json', JSON.stringify(js)); return '/T/ase/f.json'; };
  const src = (e, js, tag = 'window', frame = null) => new T.AseSource(write(js), e.geom, tag, frame, null, 0, resolve);
  const confOf = (e, js) => confWith(e.wconf, [e.wconf.styles[0], { name: 'f', aseprite: write(js), tag: 'window', frame: null, empty: [] }]);

  test('array_hash_tag_frame', () => {
    const { e, js } = setup();
    const a = src(e, js);
    const h = structuredClone(js);
    h.frames = Object.fromEntries(h.frames.map((fr) => [fr.filename, fr]));
    const b = src(e, h);
    assert.deepEqual(a.slices, b.slices);
    assert.deepEqual(a.warn, []);
    const c = src(e, js, 'arch');
    const d = src(e, js, null, 1);
    assert.deepEqual(c.slices, d.slices);
    const fw = js.frames[1].frame.x;
    assert.equal(c.slices.get('front_d1_s+0')[0] - a.slices.get('front_d1_s+0')[0], fw);
  });

  test('slice_key_by_frame', () => {
    const { e, js: js0 } = setup();
    const js = structuredClone(js0);
    const sl = js.meta.slices[0];
    const b0 = sl.keys[0].bounds;
    sl.keys.push({ frame: 1, bounds: { ...b0, x: b0.x + 7 } });
    const a = src(e, js, 'window');
    const c = src(e, js, 'arch');
    const fw = js.frames[1].frame.x;
    assert.equal(a.slices.get(sl.name)[0], b0.x);
    assert.equal(c.slices.get(sl.name)[0], fw + b0.x + 7);
  });

  test('errors_and_warnings', () => {
    const { e, js } = setup();
    let j = structuredClone(js);
    j.meta.slices[0].keys[0].bounds.w += 2;
    assert.throws(() => T.buildTexset(confOf(e, j), resolve), T.TexError);
    j = structuredClone(js);
    j.frames[0].trimmed = true;
    assert.throws(() => src(e, j), T.TexError);
    j = structuredClone(js);
    j.meta.slices.push({ name: 'somethingelse', keys: [{ frame: 0, bounds: { x: 0, y: 0, w: 1, h: 1 } }] });
    assert.ok(src(e, j).warn.some((w) => w.includes('somethingelse')));
    j = structuredClone(js);
    j.meta.slices.push(structuredClone(j.meta.slices[0]));
    assert.throws(() => src(e, j), T.TexError);
  });

  test('moved_slice_found', () => {
    const e = env();
    const ts = e.walls.ts;
    const names = new Map(ts.slots.map((s, i) => [s.name, i]));
    assert.ok(ts.styles[2][names.get('front_d3_s+0')] < 0xFE);
    // window style has no sides -> fallback
    assert.equal(ts.styles[2][names.get('side_d1_s-1')], 0xFF);
  });
});

describe('TestGeometry', () => {
  test('dvg_id_mismatch', () => {
    const e = env();
    put('/F/w136.dvg', rdf(join(FIX, 'w136.dvg')));
    assert.throws(() => T.loadGeom(resolve, `${e.dir}/west140.geom.json`, '/F/w136.dvg'), T.TexError);
  });

  test('check_other_geometry', () => {
    const e = env();
    put('/T/g/w136.geom.json', rdf(join(FIX, 'w136.geom.json')));
    genInto('/T/g/d', { geomJson: resolve('/T/g/w136.geom.json'), geomRef: '../w136.geom.json' });
    const c = T.loadTexConf(resolve('/T/g/d/walls.toml'), { path: '/T/g/d/walls.toml' });
    c.styles = c.styles.slice(0, 1);
    const { ts } = T.buildTexset(c, resolve);
    const t = tmp();
    const p136 = join(t, 'w136.dts'), p140 = join(t, 'w140.dts'), dvg140 = join(t, 'west140.dvg');
    writeFileSync(p136, T.toDts(ts));
    writeFileSync(p140, T.toDts(e.walls.ts));
    writeFileSync(dvg140, resolve(`${e.dir}/west140.dvg`));
    assert.equal(runTex(['check', DEMO_MAP, '--walls', p136, '--dvg', dvg140]).code, 1);
    assert.equal(runTex(['check', DEMO_MAP, '--walls', p140, '--dvg', dvg140]).code, 0);
  });
});

describe('TestBackground', () => {
  const conf = () => T.loadBgConf(resolve(`${env().dir}/bg.toml`), { path: `${env().dir}/bg.toml` });

  test('header_and_roundtrip', () => {
    const e = env();
    const c = conf();
    const { dbg, vram } = T.buildBackground(c, resolve);
    const bg = T.fromDbg(dbg);
    const g = e.geom;
    assert.deepEqual([bg.vw, bg.vh, bg.geometry_id], [70, 96, g.geometry_id]);
    assert.equal(bg.P, 280);
    const [hy0, hy1] = g.horizon;
    assert.equal(bg.h, hy1 - hy0 + 6);
    assert.equal(bg.y0, hy0 - 3);
    assert.deepEqual(bg.offsets, [0, 70, 140, 210]);
    assert.ok(bg.wrap);
    assert.equal(bg.u, vram.length);
    assert.equal(bg.crc, T.crcHqx(vram, 0xFFFF));
    for (let r = 0; r < 96; r++) {
      if (r < bg.y0) assert.equal(bg.fill[r], 0x33);
      else if (r >= bg.y0 + bg.h) assert.equal(bg.fill[r], 0x11);
      else assert.equal(bg.fill[r], 0);
    }
    const mem = new Uint8Array(65536);
    mem.set(vrl.decode(vrl.encode(Array.from(vram))), VB);
    const pano = range(bg.h).map((i) => vram.subarray(i * 280, (i + 1) * 280));
    for (let v = 0; v < 4; v++) {
      const fb = new Uint8Array(65536);
      T.renderBackground(bg, mem, v, fb, { vb: VB, stride: 80 });
      for (let r = 0; r < 96; r++) {
        const row = fb.subarray(r * 80, r * 80 + 70);
        const exp = bg.y0 <= r && r < bg.y0 + bg.h ? range(70).map((i) => pano[r - bg.y0][(bg.offsets[v] + i) % 280])
          : new Array(70).fill(bg.fill[r]);
        assert.deepEqual(Array.from(row), exp, `${v} ${r}`);
      }
    }
    // offset chosen so that it wraps
    const bg2 = T.fromDbg(T.buildBackground({ ...c, offsets: [0, 100, 230, 270] }, resolve).dbg);
    const fb = new Uint8Array(65536);
    T.renderBackground(bg2, mem, 3, fb, { vb: VB, stride: 80 });
    const r = bg2.y0;
    assert.deepEqual(Array.from(fb.subarray(r * 80, r * 80 + 70)), range(70).map((i) => pano[0][(270 + i) % 280]));
  });

  test('errors', () => {
    const c = conf();
    const im = decodeImage(resolve(c.png));
    put('/T/bg/w.png', encodePng(texdemo.newImage(2 * 278, im.height, [...PAL[3], 255])));
    const p = '/T/bg/w.png';
    assert.throws(() => T.buildBackground({ ...c, png: p }, resolve), T.TexError);         // P=278 not divisible by 4, auto
    assert.throws(() => T.buildBackground({ ...c, png: p, offsets: [0, 70, 140, 209], wrap: false }, resolve), T.TexError);
    const im2 = { ...im, rgba: Uint8Array.from(im.rgba) };
    setPx(im2, 3, 3, [0, 0, 0, 0]);
    put('/T/bg/t.png', encodePng(im2));
    assert.throws(() => T.buildBackground({ ...c, png: '/T/bg/t.png' }, resolve), T.TexError);
    T.buildBackground({ ...c, png: p, offsets: [0, 70, 140, 208], wrap: true }, resolve);   // valid with WRAP
  });
});

/** Generated demo files on disk (for the CLI tests). */
let DISK = null;
function disk() {
  if (DISK === null) {
    DISK = tmp();
    const d = join(DISK, 'tex');
    mkdirSync(d);
    for (const [n, v] of Object.entries(texdemo.generate(DEFAULT()).files)) writeFileSync(join(d, n), v);
  }
  return join(DISK, 'tex');
}

describe('TestBudgetCheckCli', () => {
  const setup = () => {
    const e = env();
    const t = tmp();
    const paths = {};
    for (const k of ['walls', 'floor', 'ceil']) {
      paths[k] = join(t, k + '.dts');
      writeFileSync(paths[k], T.toDts(e[k].ts));
    }
    const { dbg } = T.buildBackground(T.loadBgConf(resolve(`${e.dir}/bg.toml`), { path: `${e.dir}/bg.toml` }), resolve);
    paths.bg = join(t, 'bg.dbg');
    writeFileSync(paths.bg, dbg);
    return { e, t, paths };
  };

  test('budget', () => {
    const { e, paths } = setup();
    const fs = [paths.walls, paths.floor, paths.ceil];
    const total = e.walls.ts.vram.length + e.floor.ts.vram.length + e.ceil.ts.vram.length;
    let r = T.budget(fs, total, { resolve: fsResolve });
    assert.equal(r.sum, total);
    assert.equal(r.over, 0);
    r = T.budget(fs, total - 1, { resolve: fsResolve });
    assert.equal(r.over, 1);
    r = T.budget([...fs, paths.bg], 30000, { poolStart: 0x2000, resolve: fsResolve });
    assert.equal(r.files[1].base, 0x2000 + e.walls.ts.vram.length);
    assert.equal(runTex(['budget', ...fs, '--pool', String(total)]).code, 0);
    assert.equal(runTex(['budget', ...fs, '--pool', String(total - 1)]).code, 1);
  });

  test('check_demo_map', () => {
    const { e, t, paths } = setup();
    const { ts: ts1 } = T.buildTexset(confWith(e.wconf, e.wconf.styles.slice(0, 1)), resolve);
    const p1 = join(t, 'w1.dts');
    writeFileSync(p1, T.toDts(ts1));
    const dvg = join(t, 'west140.dvg');
    writeFileSync(dvg, resolve(`${e.dir}/west140.dvg`));
    const args = ['check', DEMO_MAP, '--floors', paths.floor, '--ceils', paths.ceil, '--dvg', dvg];
    let r = runTex([...args, '--walls', p1]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('grating'));
    assert.ok(!r.stderr.includes('Traceback'));
    r = runTex([...args, '--walls', paths.walls]);
    assert.equal(r.code, 0, r.stderr);
  });

  test('cli', () => {
    const t = tmp();
    const d = disk();
    const out = join(t, 'o');
    for (const toml of ['walls', 'floor', 'ceil']) {
      const r = runTex(['build', join(d, toml + '.toml'), '--out', out, '--no-preview']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('styles'));
    }
    let r = runTex(['bg', join(d, 'bg.toml'), '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    for (const f of ['demo_walls.dts', 'demo_walls.vrl', 'demo_walls.tex.md', 'demo_walls.tex.json', 'demo_sky.dbg',
      'demo_sky.vrl', 'demo_floor.dts']) assert.ok(existsSync(join(out, f)), f);
    r = runTex(['dump', join(out, 'demo_walls.dts'), '--vrl', join(out, 'demo_walls.vrl'), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const dd = JSON.parse(r.stdout);
    assert.equal(dd.ns, 25);
    assert.equal(dd.nst, 4);
    r = runTex(['dump', join(out, 'demo_sky.dbg')]);
    assert.equal(r.code, 0, r.stderr);
    r = runTex(['budget', join(out, 'demo_walls.dts'), '--pool', '100']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('Pool exceeded'));
    // format error
    const bad = join(t, 'bad.dts');
    writeFileSync(bad, Uint8Array.from([0, 0, 0x44, 0x58, ...new Array(60).fill(0)]));
    r = runTex(['dump', bad]);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes('Traceback'));
    r = runTex(['build', join(t, 'missing.toml')]);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes('Traceback'));
    assert.equal(runTex(['nothing']).code, 2);
  });

  test('determinism', () => {
    const e = env();
    const ts2 = T.buildTexset(e.wconf, resolve).ts;
    assert.ok(eqBytes(T.toDts(ts2), T.toDts(e.walls.ts)));
    assert.ok(eqBytes(ts2.vram, e.walls.ts.vram));
    assert.ok(eqBytes(vrl.encode(Array.from(ts2.vram)), vrl.encode(Array.from(e.walls.ts.vram))));
    const c = T.loadBgConf(resolve(`${e.dir}/bg.toml`), { path: `${e.dir}/bg.toml` });
    const b1 = T.buildBackground(c, resolve), b2 = T.buildBackground(c, resolve);
    assert.ok(eqBytes(b1.dbg, b2.dbg) && eqBytes(b1.vram, b2.vram));
    const g = texdemo.generate(DEFAULT()).files;
    for (const n of ['brick_atlas.png', 'window.json', 'sky.png']) {
      const a = g[n], b = resolve(`${e.dir}/${n}`);
      assert.ok(eqBytes(typeof a === 'string' ? enc(a) : a, b), n);
    }
  });

  test('vms_reference_example', () => {
    // Independent anchor: example from vdc-basic docs/reference/vms-format.md (alpha 5, 3 x 2 bytes)
    const mem = new Uint8Array(65536);
    mem.set([0x51, 0x11, 0x15, 0x22, 0x22], 0x100);
    const fb = new Uint8Array(65536);
    fb.set([0xAB, 0xCD, 0xEF], 1000);
    fb.set([0x99, 0x99, 0x99], 1080);
    const lst = Uint8Array.from([5, 4, 0, 8, 0, 0, 1, 1, 0, 1, 8, 2, 0, 1, 80, 0, 2]);
    T.simVms(mem, 0x100, 1000, lst, fb);
    assert.deepEqual(Array.from(fb.subarray(1000, 1003)), [0xA1, 0x11, 0x1F]);
    assert.deepEqual(Array.from(fb.subarray(1080, 1083)), [0x22, 0x22, 0x99]);
    // pack_image produces exactly this list and data for the same pixels (alpha here 0 instead of 5)
    const pix = [[null, 1, 1, 1, 1, null], [2, 2, 2, 2, null, null]];
    const [alpha, edge, vms] = T.packImage(pix, T.classify(pix), [], 80);
    assert.deepEqual([alpha, Array.from(edge)], [0, [0x01, 0x11, 0x10, 0x22, 0x22]]);
    assert.deepEqual(Array.from(vms), [0, 4, 0, 8, 0, 0, 1, 1, 0, 1, 8, 2, 0, 1, 80, 0, 2]);
  });

  test('vmc_srcstep_sim', () => {
    const mem = Uint8Array.from({ length: 65536 }, (_, i) => i & 255);
    const fb = new Uint8Array(65536);
    T.simVmc(mem, 10, 1000, 3, 2, 100, 50, fb);
    assert.deepEqual(Array.from(fb.subarray(1000, 1003)), Array.from(mem.subarray(10, 13)));
    assert.deepEqual(Array.from(fb.subarray(1100, 1103)), Array.from(mem.subarray(60, 63)));
    T.simVmc(mem, 10, 2000, 3, 2, 100, 0, fb);
    assert.deepEqual(Array.from(fb.subarray(2100, 2103)), Array.from(mem.subarray(13, 16)));
  });
});
