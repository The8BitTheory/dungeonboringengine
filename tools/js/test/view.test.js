// Port of test/tools/test_dbeview.py (docs/specs/P6-engine.md, sections 5 and 9; P6b).
//
// Pixel check: runVcl(view(scene)) == paintReference(scene) in the view window; no byte outside the window
// modified (whole 64 KB field with random content). The demo assets come from fixtures written by
// test/golden/mkgolden_view.py (dbeview.build_demo_assets needs the texture builder, phase 2);
// dbetex.preview images are compared through their golden hashes. Full random set: DBEVIEW_FULL=1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../core/view.js';
import * as dbemap from '../core/map.js';
import * as tex from '../core/tex.js';
import * as spr from '../core/spr.js';
import * as vrl from '../core/vrl.js';
import { PyRandom } from '../core/pyrandom.js';
import { viewCli } from '../cli/view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIX = join(HERE, 'golden', 'view');
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'view.json'), 'utf8'));
const DEMO_MAP = join(ROOT, 'docs', 'specs', 'examples', 'demo.toml');
const BIG = [0x0200, 0x1C00];          // large buffer: pixel tests without overflow
const HUGE = [0x0200, 0x4200];         // for extreme scenes (tile pattern with holes in every byte)
const FULL = !!process.env.DBEVIEW_FULL;

const rd = (n) => new Uint8Array(readFileSync(join(FIX, n)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const zeros = (n) => new Array(n).fill(0);

let ENV = null;
function env() {
  if (ENV === null) {
    const assets = V.assetsFromFiles({
      dvg: rd('west140.dvg'), walls: [rd('walls.dts'), rd('walls.vram')], floor: [rd('floor.dts'), rd('floor.vram')],
      ceil: [rd('ceil.dts'), rd('ceil.vram')], dbg: [rd('sky.dbg'), rd('sky.vram')],
      sprites: [0, 1, 2, 3].map((i) => [rd(`s2_${i}.s2`), rd(`s2_${i}.vram`)]),
    });
    ENV = { assets, demo: dbemap.loadsToml(readFileSync(DEMO_MAP), DEMO_MAP) };
  }
  return ENV;
}

function outsideUnchanged(sc, before, after, msg = '') {
  const g = sc.dvg;
  const tmp = Uint8Array.from(before);
  for (let y = 0; y < g.vh; y++) {
    const a = (sc.ap + g.row(y)) & 0xFFFF;
    for (let x = 0; x < g.vw; x++) tmp[(a + x) & 0xFFFF] = after[(a + x) & 0xFFFF];
  }
  assert.ok(eqBytes(tmp, after), 'Byte outside the view window modified ' + msg);
}

function firstDiff(sc, a, b) {
  const A = V.windowBytes(sc, a), B = V.windowBytes(sc, b);
  for (let y = 0; y < A.length; y++) {
    for (let x = 0; x < A[0].length; x++) {
      if (A[y][x] !== B[y][x]) {
        return `first difference at row ${y}, column ${x}: view ${A[y][x].toString(16)} / reference ${B[y][x].toString(16)}`;
      }
    }
  }
  return null;
}

/** view -> runVcl against paintReference; returns Result. */
function checkPixels(sc, seed = 0, msg = '', expectOk = true) {
  const res = V.view(sc);
  if (expectOk) assert.equal(res.a, 0, msg);
  const vram = sc.makeVram(seed);
  const before = Uint8Array.from(vram);
  V.renderView(sc, vram, res);
  outsideUnchanged(sc, before, vram, msg);
  const ref = V.paintReference(sc, Uint8Array.from(before));
  outsideUnchanged(sc, before, ref, '(paint_reference) ' + msg);
  const d = firstDiff(sc, vram, ref);
  assert.equal(d, null, `${msg}: ${d}`);
  return res;
}

const T = (walls, floor, ceil, flags, ch) => new dbemap.Tile(walls, floor, ceil, flags, ch);
const { T_SOLID: SOLID, T_OCCLUDING: OCC, T_CONTENT: CNT } = V;

function mkMap(rows, tiles, legend, { outside = 0, start = null, direction = 0, content = null } = {}) {
  const cells = rows.flatMap((r) => Array.from(r, (ch) => legend[ch]));
  const m = new dbemap.Map('t', rows[0].length, rows.length, tiles, cells, content || zeros(rows.length * rows[0].length),
    [], 0, direction, outside);
  m.start = start !== null ? start : m.cells.findIndex((c) => !(tiles[c].flags & SOLID));
  dbemap.validate(m);
  return m;
}

function openRoom(w = 13, h = 13, floor = 1, ceil = 1) {
  const t = [T([0, 0, 0, 0], floor, ceil, 0, 0)];
  return mkMap(new Array(h).fill('.'.repeat(w)), t, { '.': 0 }, { start: Math.floor(h / 2) * w + Math.floor(w / 2) });
}

const freeViews = (m) => m.cells.flatMap((c, i) => (m.tiles[c].flags & SOLID ? [] : [0, 1, 2, 3].map((v) => [i, v])));
const scene = (m, o = {}) => V.makeScene(env().assets, m, o);

// ---------------------------------------------------------------- DVG, scene

describe('TestDvg', () => {
  test('test_header_and_depth', () => {
    const g = env().assets.dvg;
    assert.deepEqual([g.vw, g.vh, g.D, g.stride, g.hy0, g.hy1], [70, 96, 3, 80, 22, 45]);
    assert.equal(g.elems.length, 79);
    assert.deepEqual(g.depth.map((d) => [d.cy0, d.cy1, d.fy0, d.fy1]), [[0, 6, 83, 96], [6, 13, 64, 83], [13, 19, 51, 64], [19, 22, 45, 51]]);
    const front = g.elems.find((e) => e.art === V.ART_FRONT && e.d === 1 && e.s === -1);
    assert.deepEqual([front.x, front.y, front.w, front.h, front.srcDx], [0, 6, 10, 77, 40]);
    const obj = g.elems.find((e) => e.art === V.ART_OBJ && e.d === 1 && e.s === 0);
    assert.deepEqual(obj.anchors, [[26, 67], [44, 67], [35, 71], [24, 76], [46, 76]]);
  });

  test('test_bad_dvg', () => {
    assert.throws(() => V.parseDvg(Uint8Array.from([0, 0, 0x58, 0x58, ...zeros(30)])), V.ViewError);
  });

  test('test_band_cover_flag_variant', () => {
    const g = V.withBandCover(env().assets.dvg);
    assert.ok(g.elems.filter((e) => e.art === V.ART_FRONT).every((e) => e.flags & 8));
    assert.ok(env().assets.dvg.elems.filter((e) => e.art === V.ART_FRONT).every((e) => e.flags & 8));
    assert.ok(!V.withoutBandCover(env().assets.dvg).elems.some((e) => e.flags & 8));
  });

  test('test_cells_contiguous', () => {
    const sc = scene(env().demo);
    assert.deepEqual(new V.Ctx(sc).cellsOf(1).map(([s]) => s).slice(0, 3), [0, -1, 1]);
    sc.dvg = sc.dvg.clone();
    const dt = sc.dvg.depth[1];
    sc.dvg.elems[dt.first + dt.n - 1].s = 0;          // last element of the depth to cell s = 0
    assert.throws(() => new V.Ctx(sc).cellsOf(1), V.ViewError);
  });

  test('test_layout_checks', () => {
    const sc = scene(env().demo);
    assert.ok(Math.min(...sc.assets().map(([, b]) => b)) >= 7670);
    sc.vramBases.dbg = 10;
    assert.throws(() => sc.checkLayout(), V.ViewError);
  });
});

// ---------------------------------------------------------------- VCL interpreter

describe('TestRunVcl', () => {
  let vram, b0;
  const setUp = () => {
    vram = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) vram[i] = i & 255;
    b0 = new Uint8Array(65536);
  };
  const w = (...vals) => vals.flatMap((v) => [v & 255, (v >> 8) & 255]);
  const run = (data, at = 0x1300) => { b0.set(data, at); return V.runVcl(b0, vram, at); };
  const sl = (a, b) => Array.from(vram.subarray(a, b));

  test('test_type1_2_3', () => {
    setUp();
    const v0 = Uint8Array.from(vram);
    const s0 = (a, b) => Array.from(v0.subarray(a, b));
    run([1, ...w(100, 5000, 4), 0]);
    assert.deepEqual(sl(5000, 5004), s0(100, 104));
    run([2, ...w(1000, 6000, 3, 2, 80), 0]);          // packed: source consecutive
    assert.deepEqual(sl(6000, 6003), s0(1000, 1003));
    assert.deepEqual(sl(6080, 6083), s0(1003, 1006));
    run([3, ...w(1000, 7000, 3, 2, 80, 40), 0]);      // source step 40
    assert.deepEqual(sl(7080, 7083), s0(1040, 1043));
    run([3, ...w(1000, 8160, 2, 3, -80, 10), 0]);     // negative destination step
    assert.deepEqual(sl(8000, 8002), s0(1020, 1022));
    assert.deepEqual(sl(8160, 8162), s0(1000, 1002));
  });

  test('test_reps_zero_is_256_and_count_zero', () => {
    setUp();
    vram.fill(0);
    vram[0] = 7;
    run([2, ...w(0, 9000, 1, 0, 1), 0]);             // reps 0 = 256 repetitions
    assert.deepEqual(sl(9000, 9256), [7, ...zeros(255)]);
    const v0 = Uint8Array.from(vram);
    run([1, ...w(0, 9500, 0), 0]);                     // count 0 copies nothing
    assert.ok(eqBytes(vram, v0));
  });

  test('test_overlap_smears_forward', () => {
    setUp();
    vram.fill(0);
    vram[100] = 9;
    run([1, ...w(100, 101, 5), 0]);
    assert.deepEqual(sl(100, 106), new Array(6).fill(9));
  });

  test('test_fill_and_pokes', () => {
    setUp();
    run([4, ...w(300, 0x1AB, 5), 5, ...w(400, 0x11, 2, 3, 80), 6, ...w(900, 0x2C), 7, ...w(1000, 0x5E, 4, 10), 0]);
    assert.deepEqual(sl(300, 305), new Array(5).fill(0xAB));
    for (let r = 0; r < 3; r++) assert.deepEqual(sl(400 + 80 * r, 402 + 80 * r), [0x11, 0x11]);
    assert.equal(vram[900], 0x2C);
    assert.deepEqual(range(4).map((i) => vram[1000 + 10 * i]), [0x5E, 0x5E, 0x5E, 0x5E]);
  });

  test('test_syn_is_noop_and_returns_count', () => {
    setUp();
    const v0 = Uint8Array.from(vram);
    const n = run([13, ...w(0), 13, ...w(2, 12, 64, 13, 0), 0]);
    assert.equal(n, 2);
    assert.ok(eqBytes(vram, v0));
  });

  test('test_vms_types', () => {
    setUp();
    vram.fill(0);
    vram.set([0x51, 0x11, 0x15, 0x22, 0x22, 0x33, 0x44, 0x55], 2000);
    for (let i = 0; i < 200; i++) vram[5000 + i] = 0xA7;
    const lst = [5, 4, 0, 8, 0, 0, 1, 1, 0, 1, 8, 2, 0, 1, 80, 0, 2];   // example from vms-format.md (alpha 5)
    b0.set(lst, 0x1400);
    run([12, ...w(2000, 5000, 0x1400), 0]);
    assert.equal(vram[5000], 0xA1);
    assert.equal(vram[5001], 0x11);
    assert.equal(vram[5002], 0x17);
    assert.deepEqual(sl(5080, 5082), [0x22, 0x22]);
  });

  test('test_vms_type3_skip', () => {
    setUp();
    vram.fill(0);
    vram.set([0x51, 0x11, 0x15, 0x22, 0x22], 2000);
    b0.set([5, 2, 0, 3, 3, 0, 1, 0, 0, 2], 0x1400);       // example "first row cut off"
    run([12, ...w(2000, 5000, 0x1400), 0]);
    assert.deepEqual(sl(5000, 5003), [0x22, 0x22, 0]);
  });

  test('test_vms_type2_and_bad', () => {
    setUp();
    b0.set([0, 1, 0, 2, 3, 0, 2, 0], 0x1400);
    run([12, ...w(100, 5000, 0x1400), 0]);
    assert.deepEqual(sl(5000, 5003), sl(100, 103));
    assert.deepEqual(sl(5080, 5083), sl(103, 106));
    b0.set([0, 1, 0, 9], 0x1400);
    assert.throws(() => run([12, ...w(100, 5000, 0x1400), 0]), V.ViewError);
  });

  test('test_rxv_and_unknown', () => {
    setUp();
    const stream = vrl.encode([1, 2, 3, 3, 3, 3, vrl.SKIP, 9]);
    b0.set(stream, 0x1500);
    vram.fill(0);
    vram[7] = 0xEE;
    run([8, ...w(0x1500, 6), 0]);
    assert.deepEqual(sl(6, 13), [1, 2, 3, 3, 3, 3, 0]);
    assert.throws(() => run([9, 0]), V.ViewError);
  });

  test('test_decode_vcl_roundtrip', () => {
    const data = Uint8Array.from([2, ...w(1, 2, 3, 4, 5), 12, ...w(6, 7, 8), 4, ...w(1, 2, 3), 0]);
    assert.deepEqual(V.decodeVcl(data), [[2, 1, 2, 3, 4, 5], [12, 6, 7, 8], [4, 1, 2, 3]]);
  });
});

// ---------------------------------------------------------------- Clipping

describe('TestClip', () => {
  const sprite = () => {
    const ss = env().assets.sprites[0];
    return [ss, ss.images.find((i) => i.vms.length && i.cores.length)];
  };

  test('test_clip_matches_p5b_text', () => {
    const [ss, img] = sprite();
    const stride = 80;
    const rnd = new PyRandom(5);
    const vram0 = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) vram0[i] = rnd.getrandbits(8);
    const vb = 0x4000;
    vram0.set(ss.vram, vb);
    const x0 = 10, y0 = 20;
    const full = Uint8Array.from(vram0);
    let [cores, vms, ref] = V.clipImage(img, stride, x0, y0, x0, x0 + img.w, y0, y0 + img.h);
    assert.ok(eqBytes(vms, img.vms));
    for (const [src, x, y, ww, reps, st] of cores) V.vmc(full, vb + src, y * stride + x, ww, reps, stride, st);
    const bank0 = new Uint8Array(65536);
    bank0.set(vms, 0x1400);
    V.vms(bank0, full, vb + img.edgeOfs, ref[1] * stride + ref[0], 0x1400);
    const W = img.w, H = img.h;
    for (const [L, R] of [[0, W], [1, W], [Math.floor(W / 2), W - 1], [0, 1], [W - 1, W]]) {
      for (const [Tt, B] of [[0, H], [1, H], [0, H - 1], [H - 1, H], [3, 7]]) {
        if (L >= R || Tt >= B) continue;
        const vr = Uint8Array.from(vram0);
        [cores, vms, ref] = V.clipImage(img, stride, x0, y0, x0 + L, x0 + R, y0 + Tt, y0 + B);
        for (const [src, x, y, ww, reps, st] of cores) V.vmc(vr, vb + src, y * stride + x, ww, reps, stride, st);
        if (vms) {
          const cmds = [];
          let p = 3;
          while (p < vms.length) { const t = vms[p]; cmds.push(t); p += t === 1 ? 4 : 3; }
          assert.notEqual(cmds[cmds.length - 1], 3, 'Type 3 am Ende');
          assert.ok(!cmds.some((a, i) => i > 0 && a === 3 && cmds[i - 1] === 3));
          assert.ok(cmds.every((c) => [1, 3, 8].includes(c)));
          bank0.set(vms, 0x1400);
          V.vms(bank0, vr, vb + img.edgeOfs, ref[1] * stride + ref[0], 0x1400);
        }
        for (let r = 0; r < img.h; r++) {
          for (let c = 0; c < img.w; c++) {
            const a = (y0 + r) * stride + x0 + c;
            const want = L <= c && c < R && Tt <= r && r < B ? full[a] : vram0[a];
            assert.equal(vr[a], want, `L${L} R${R} T${Tt} B${B} row ${r} column ${c}`);
          }
        }
      }
    }
  });

  test('test_clip_equals_dbespr', () => {
    for (const ss of env().assets.sprites.slice(0, 4)) {
      for (const img of ss.images) {
        for (const [L, R, Tt, B] of [[0, img.w, 0, img.h], [1, img.w - 1, 2, img.h], [0, Math.floor(img.w / 2) + 1, 0, 3],
          [Math.floor(img.w / 2), img.w, 1, img.h - 1]]) {
          if (L >= R || Tt >= B) continue;
          const [cores, vms, ref] = V.clipImage(img, 80, 5, 7, 5 + L, 5 + R, 7 + Tt, 7 + B);
          const c = spr.clipImage(img, 5, 7, 5 + L, 5 + R, 7 + Tt, 7 + B, 80);
          assert.deepEqual(cores, c.cores);
          assert.deepEqual(vms, c.vms);
          assert.deepEqual(ref, c.ref);
        }
      }
    }
  });

  test('test_srcstep_rule', () => {
    const k = new tex.Core(100, 2, 1, 6, 4, 0);
    const img = { w: 10, h: 8, cores: [k], vms: new Uint8Array(0) };
    assert.deepEqual(V.clipImage(img, 80, 0, 0, 0, 10, 0, 8)[0], [[100, 2, 1, 6, 4, 0]]);
    assert.deepEqual(V.clipImage(img, 80, 0, 0, 0, 10, 2, 8)[0], [[106, 2, 2, 6, 3, 0]]);   // T > 0, full width: stays type 2
    assert.deepEqual(V.clipImage(img, 80, 0, 0, 3, 10, 0, 8)[0], [[101, 3, 1, 5, 4, 6]]);   // width cut: srcstep = kw
    const k2 = new tex.Core(100, 2, 1, 6, 4, 20);
    assert.deepEqual(V.clipImage({ w: 10, h: 8, cores: [k2], vms: new Uint8Array(0) }, 80, 0, 0, 0, 10, 2, 8)[0], [[120, 2, 2, 6, 3, 20]]);
  });
});

// ---------------------------------------------------------------- Structure of the list

describe('TestResult', () => {
  test('test_demo_structure', () => {
    const sc = scene(env().demo);
    const res = V.view(sc);
    assert.deepEqual([res.a, res.y, res.p0, res.b0], [0, 0, 0x1C00 - res.vcllen, 0x1300]);
    assert.equal(res.vcllen, res.vcl.length);
    assert.equal(res.vmslen, res.vms.length);
    assert.equal(res.vcl[res.vcl.length - 1], 0);
    const ents = V.decodeVcl(res.buffer);
    assert.equal(res.x, ents.length);
    const sizes = { 2: 11, 3: 13, 4: 7, 5: 11, 12: 7 };
    assert.equal(ents.reduce((a, e) => a + sizes[e[0]], 0) + 1, res.vcllen);
    const b0 = res.bank0();
    let ptr = res.b0;
    for (const e of ents.slice().reverse()) {
      if (e[0] === 12) {
        assert.equal(e[3], ptr);
        const lst = b0.subarray(ptr);
        const n = lst[1] | (lst[2] << 8);
        let p = 3;
        for (let i = 0; i < n; i++) p += { 1: 4, 8: 3, 3: 3 }[lst[p]];
        ptr += p;
      }
    }
    assert.equal(ptr, res.b0 + res.vmslen);
    assert.equal(b0[0x1C00 - 1], 0);
    assert.ok(res.b0 + res.vmslen <= res.p0);
  });

  test('test_deterministic_and_custom_buffer', () => {
    const sc = scene(env().demo);
    const a = V.view(sc), b = V.view(sc);
    assert.deepEqual([a.vcl, a.vms, a.objvis], [b.vcl, b.vms, b.objvis]);
    sc.buf = [0x0800, 0x1A00];
    const c = V.view(sc);
    assert.deepEqual([c.p0, c.b0], [0x1A00 - c.vcl.length, 0x0800]);
    assert.equal(c.vcl.length, a.vcl.length);
    const da = V.decodeVcl(a.buffer), dc = V.decodeVcl(c.buffer);
    assert.deepEqual(da.map((e) => e.slice(0, 3)), dc.map((e) => e.slice(0, 3)));
    assert.deepEqual(a.vms, c.vms);
  });

  test('test_vms_bank1', () => {
    const e = env();
    let n9 = 0, n9s = 0;
    const rnd = new PyRandom(9);
    const s2a = [];
    let a = 0x4000;                         // S2 packed from $4000
    for (const ss of e.assets.sprites) { s2a.push(ss !== null ? a : 0); a += ss !== null ? V.s2Content(ss).length : 0; }
    const cases = [[9, 0, 0], [9, 1, 0], [16, 2, 0], [22, 3, 0], [9, 0, 5], [16, 2, 5], [22, 1, 5], [9, 3, 5]];
    cases.forEach(([i, v, nobj], k) => {
      const objs = V.randomObjects(rnd, e.demo, i, v, nobj);
      const sc = scene(e.demo, { pos: i, direction: v, objects: objs, itemtab: [0, 2, 3, 2, ...zeros(60)] });
      const ref = V.view(sc);
      const sc1 = sc.copy();
      sc1.vmsBank1 = true;
      sc1.s2Addr = s2a;
      const res = V.view(sc1);
      const ents = V.decodeVcl(res.buffer);
      n9 += ents.filter((x) => x[0] === 9).length;
      n9s += ents.filter((x) => x[0] === 9 && x[3] >= 0x4000 && x[3] < a).length;
      assert.equal(ents.length, V.decodeVcl(ref.buffer).length);
      assert.ok(res.vmslen <= ref.vmslen);
      assert.equal(res.objvis, ref.objvis);
      for (const x of ents) if (x[0] === 9) assert.ok(res.lists1.has(x[3]));
      checkPixels(sc1, k, `vms_bank1 ${i}/${v}/${nobj}`);
    });
    assert.ok(n9 > 0);
    assert.ok(n9s > 0);                 // unclipped sprites as type 9
  });

  test('test_back_to_front_order', () => {
    const ents = V.decodeVcl(V.view(scene(env().demo)).buffer);
    assert.ok([3, 4, 5].includes(ents[0][0]));      // wallpaper/floor/ceiling first
  });
});

// ---------------------------------------------------------------- Pixel check

describe('TestDemoPixels', () => {
  test('test_all_free_cells_no_objects', () => {
    for (const bc of [false, true]) {
      for (const [i, v] of freeViews(env().demo)) {
        checkPixels(scene(env().demo, { pos: i, direction: v, bandCover: bc }), i * 4 + v, `Cell ${i} direction ${v} band_cover ${bc}`);
      }
    }
  });

  test('test_all_free_cells_with_objects', () => {
    const rnd = new PyRandom(2025);
    const m = env().demo;
    for (const n of [1, 5]) {
      for (const [i, v] of freeViews(m)) {
        const objs = V.randomObjects(rnd, m, i, v, n);
        const sc = scene(m, { pos: i, direction: v, objects: objs, itemtab: [0, 2, 3, ...zeros(61)], itemph: i % 4,
          bandCover: !!((i + v) & 1), buf: BIG });
        checkPixels(sc, i * 4 + v, `Cell ${i} direction ${v} Objects ${n}`);
      }
    }
  });

  test('test_no_dbg_uses_fill_byte', () => {
    const res = checkPixels(scene(env().demo, { dbg: false, bgfill: 0x5A }));
    assert.ok(V.decodeVcl(res.buffer).filter((e) => e[0] === 4 || e[0] === 5).map((e) => e[2]).includes(0x5A));
  });

  test('test_ap_nonzero', () => {
    for (const ap of [0x0123, 0xE200, 0xF800]) {       // 0xF800: the window runs past 65535
      let sc = scene(env().demo, { ap });
      assert.equal(sc.windowRanges().length, ap === 0xF800 ? 2 : 1);
      checkPixels(sc, 3, `ap ${ap}`);
      sc = scene(env().demo, { pos: 9, direction: 1, ap, bandCover: true });
      checkPixels(sc, 4, `ap ${ap}`);
    }
  });

  test('test_rotated_viewport_origin', () => {
    const g = env().assets.dvg.clone();
    g.origin = 123;
    const sc = scene(env().demo);
    sc.dvg = g;
    V.layoutVram(sc);
    checkPixels(sc, 1, 'origin 123');
  });
});

function abyssMap() {
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0), T([0, 0, 0, 0], 0, 1, 0, 0),
    T([0, 0, 0, 0], 2, 0, 0, 0), T([2, 0, 2, 0], 1, 1, SOLID, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0),
    T([3, 3, 3, 3], 0, 0, SOLID | OCC, 0), T([0, 0, 0, 0], 3, 2, 0, 0)];
  const rows = ['###########', '#....:....#', '#.##..##..#', '#.#:..:#..#', '#...++....#', '#.:....:..#',
    '#.#.##.#.m#', '#..:..:...#', '###########'];
  const legend = { '#': 1, '.': 0, ':': 2, '+': 4, m: 7, b: 5, w: 6, ',': 3 };
  return mkMap(rows, t, legend, { outside: 1, start: 5 * 11 + 5 });
}

function distantMap() {
  const DISTANT = V.T_DISTANT;
  const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0), T([0, 0, 0, 0], 1, 0, 0, 0),
    T([3, 3, 3, 3], 1, 1, SOLID, 0), T([2, 2, 2, 2], 1, 1, SOLID | CNT, 0), T([0, 0, 0, 0], 1, 1, DISTANT, 0),
    T([0, 0, 0, 0], 1, 0, DISTANT, 0), T([0, 0, 0, 0], 0, 0, 0, 0)];
  const rows = ['################', '#......F.......F', '#.####.#.####.##', '#,,,,,,,,,,,,,,#', '#.####+#.####.##',
    '#.uuuu.#.oooo..#', '#.#F##.#.##F#..#', '#.....,,,,.....#', '################'];
  const legend = { '.': 0, '#': 1, ',': 2, F: 3, '+': 4, u: 5, o: 6 };
  return mkMap(rows, t, legend, { outside: 7, start: 1 * 16 + 1 });
}

describe('TestDistant', () => {
  test('test_pixels_and_runs', () => {
    const e = env();
    const stats = { fill: 0, split: 0, same: 0 };
    let k = 0;
    const demo2 = dbemap.loadsToml(readFileSync(join(ROOT, 'demo', 'demo.toml')), 'demo.toml');
    for (const m of [distantMap(), demo2, e.demo]) {
      for (const [i, v] of freeViews(m)) {
        k++;
        const bc = !!(k & 1);
        const [ff, dbg] = [[0x00, true], [0x96, false]][(k >> 1) & 1];
        const sc = scene(m, { pos: i, direction: v, bandCover: bc, buf: BIG, farfill: ff, dbg, bgfill: 0x5A });
        const res = checkPixels(sc, k, `${m.name} ${i}/${v} bc ${bc} ff ${ff}`);
        const ref = V.view(scene(m, { pos: i, direction: v, bandCover: bc, buf: BIG, dbg, bgfill: 0x5A }));
        const g = sc.dvg;
        const ents = V.decodeVcl(res.buffer);
        const inRow = (a) => a - g.row(g.hy0) >= 0 && a - g.row(g.hy0) < g.vw;
        const fill = ents.some((en) => en[0] === 5 && en[2] === ff && en[4] === g.hy1 - g.hy0 && inRow(en[1]));
        stats.fill += fill;
        stats.same += eqBytes(res.buffer, ref.buffer);
        stats.split += fill && dbg && ents.some((en) => en[0] === 3 && inRow(en[2]));
      }
    }
    assert.ok(stats.fill > 150, JSON.stringify(stats));
    assert.ok(stats.same > 150, JSON.stringify(stats));
    assert.ok(stats.split > 10, JSON.stringify(stats));
  });

  test('test_flag_and_columns', () => {
    const m = distantMap();
    const sc = scene(m, { pos: 5 * 16 + 1, direction: 1, farfill: 0 });
    const ctx = new V.Ctx(sc);
    const cols = ctx.farCols();
    assert.deepEqual(cols, cols.slice().sort((a, b) => a - b));
    assert.equal(cols.length, sc.dvg.vw);
    assert.ok(cols.includes(0));
    assert.equal(ctx.farDec().get(0), false);             // u: ceiling, DISTANT -> wallpaper
    const sc2 = scene(m, { pos: 5 * 16 + 8, direction: 1, farfill: 0 });
    assert.equal(new V.Ctx(sc2).farDec().get(0), true);   // o: sky, DISTANT -> fill
  });

  test('test_off_unchanged', () => {
    const m = distantMap();
    freeViews(m).filter((_, j) => j % 5 === 0).forEach(([i, v]) => {
      const a = V.view(scene(m, { pos: i, direction: v }));
      const b = V.view(scene(m, { pos: i, direction: v, farfill: null }));
      assert.deepEqual(a.buffer, b.buffer);
    });
  });

  test('test_random', () => {
    let n = 0;
    for (let k = 0; k < (FULL ? 1000 : 120); k++) {
      const sc = V.farVariant(V.randomScene(k, env().assets, { buf: BIG }), k);
      if (V.view(sc).a === 2) continue;
      checkPixels(sc, k, `random scene ${k} far view`);
      n++;
    }
    assert.ok(n > 100);
  });
});

describe('TestAbyss', () => {
  test('test_all_views', () => {
    const m = abyssMap();
    let n = 0;
    const rnd = new PyRandom(7);
    m.cells.forEach((c, i) => {
      if (m.tiles[c].flags & SOLID) return;
      for (let v = 0; v < 4; v++) {
        const objs = V.randomObjects(rnd, m, i, v, rnd.choice([0, 2, 4]));
        const sc = scene(m, { pos: i, direction: v, objects: objs, itemtab: [0, 2, 3, ...zeros(61)], itemph: v,
          bandCover: !!(i & 1), buf: BIG });
        checkPixels(sc, n, `abyss Cell ${i} direction ${v}`);
        n++;
      }
    });
    assert.ok(n > 100);
  });
});

describe('TestRandom', () => {
  test('test_random_scenes', () => {
    const [nmaps, nviews] = FULL ? [200, 20] : [25, 8];
    let ok = 0;
    for (let k = 0; k < nmaps * nviews; k++) {
      const sc = V.randomScene(k, env().assets, { buf: BIG });
      if (V.view(sc).a === 2) continue;      // visibility list full (MAXITEM): no pixel comparison
      checkPixels(sc, k, `random scene ${k}`);
      ok++;
    }
    assert.ok(ok > nmaps * nviews * 0.9);
    assert.ok(V.view(V.randomScene(3, env().assets, { buf: BIG })).items > 0);
  });

  test('test_random_scenes_have_objects_and_clipping', () => {
    let vis = 0, clipped = 0;
    for (let k = 0; k < 60; k++) {
      const res = V.view(V.randomScene(k, env().assets, { buf: BIG }));
      vis += res.objvis !== 0;
      const b0 = res.bank0();
      for (const ent of V.decodeVcl(res.buffer)) {
        if (ent[0] === 12) {
          const lst = b0.subarray(ent[3]);
          let p = 3;
          const n = lst[1] | (lst[2] << 8);
          for (let i = 0; i < n; i++) {
            if (lst[p] === 3) { clipped++; break; }
            p += { 1: 4, 8: 3, 3: 3 }[lst[p]];
          }
        }
      }
    }
    assert.ok(vis > 20);
    assert.ok(clipped > 5);
  });
});

describe('TestDoubleFronts', () => {
  let a2 = null;
  const A2 = () => { if (a2 === null) a2 = V.doubleFronts(env().assets); return a2; };

  test('test_geometry', () => {
    const g = A2().dvg, g0 = env().assets.dvg;
    assert.equal(JSON.stringify(V.parseDvg(A2().dvgPrg).elems), JSON.stringify(g.elems));
    const cells = (d) => new V.Ctx(V.makeScene(A2(), env().demo)).cellsOf(d);
    for (let d = 1; d <= g.D; d++) {
      for (const [s, ce] of cells(d)) {
        const n0 = g0.elems.filter((e) => e.d === d && e.s === s && e.art === V.ART_FRONT).length;
        assert.equal(ce.filter((e) => e.art === V.ART_FRONT).length, 2 * n0);
      }
    }
    let found = false;
    for (let d = 1; d <= g.D; d++) for (const [, ce] of cells(d)) if (ce.slice(0, 3).map((e) => e.art).join() === '0,1,0') found = true;
    assert.ok(found);
  });

  test('test_demo_pixels', () => {
    const m = env().demo;
    for (const bc of [false, true]) {
      for (const [i, v] of freeViews(m)) {
        checkPixels(V.makeScene(A2(), m, { pos: i, direction: v, bandCover: bc, buf: BIG }), i * 4 + v,
          `zwei Fronten: Cell ${i} direction ${v} bc ${bc}`);
      }
    }
  });

  test('test_random_pixels', () => {
    let ok = 0;
    for (let k = 0; k < (FULL ? 60 : 20); k++) {
      const sc = V.randomScene(1000 + k, A2(), { buf: BIG });
      if (V.view(sc).a === 2) continue;
      checkPixels(sc, k, `two fronts: random scene ${k}`);
      ok++;
    }
    assert.ok(ok > 10);
  });
});

describe('TestEdge', () => {
  test('test_edges', () => {
    const m = openRoom();
    let n = 0;
    for (const setn of [0, 2, 3]) {
      for (const d of [1, 2, 3]) {
        for (const s of [-2, -1, 0, 1, 2]) {
          const cx = m.start % m.width, cy = Math.floor(m.start / m.width);
          const cell = (cy - d) * m.width + cx + s;
          for (let q = 0; q < 5; q++) {
            const o = new V.Obj(cell, setn, 2, 1, q);
            checkPixels(scene(m, { objects: [o], buf: BIG, bandCover: !!(n & 1) }), n, `Satz ${setn} d ${d} s ${s} q ${q}`);
            n++;
          }
        }
      }
    }
    assert.equal(n, 225);
  });

  test('test_edges_with_walls_in_front', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0)];
    const rows = ['#########', '#.......#', '#.#####.#', '#.#...#.#', '#.#...#.#', '#...#...#', '#########'];
    const m = mkMap(rows, t, { '#': 1, '.': 0 }, { outside: 1, start: 5 * 9 + 2, direction: 0 });
    let n = 0;
    m.cells.forEach((c, i) => {
      if (m.tiles[c].flags & SOLID) return;
      for (let v = 0; v < 4; v++) {
        for (const setn of [0, 2, 3]) {
          const objs = [];
          for (let j = 0; j < m.cells.length; j++) {
            for (const q of [0, 4]) if (!(m.tiles[m.cells[j]].flags & SOLID) && (j + q) % 3 === 0) objs.push(new V.Obj(j, setn, 2, 0, q));
          }
          checkPixels(scene(m, { pos: i, direction: v, objects: objs.slice(0, 16), buf: BIG }), n, `Cell ${i} v ${v} Satz ${setn}`);
          n++;
        }
      }
    });
  });
});

describe('TestSpansAndMasks', () => {
  const viewObj = () => new V.View(scene(env().demo));

  test('test_spans', () => {
    const v = viewObj();
    let m = zeros(70);
    assert.deepEqual(v.spans(m), [[0, 70]]);
    m = new Array(70).fill(1);
    assert.deepEqual(v.spans(m), []);
    for (const [a, b] of [[0, 5], [10, 12], [20, 30], [40, 41]]) m.fill(0, a, b);
    assert.deepEqual(v.spans(m), [[0, 5], [10, 12], [20, 30], [40, 41]]);   // exactly 4 runs
    m.fill(0, 50, 52);
    assert.deepEqual(v.spans(m), [[0, 52]]);                                  // more than 4: one run
  });

  test('test_mark_counts_cover_only', () => {
    const v = viewObj();
    v.mark(v.cover, 3, 8);
    v.mark(v.cover, 5, 10);
    assert.equal(v.ncov, 7);
    v.mark(v.bcov, 0, 70);
    assert.equal(v.ncov, 7);
    assert.ok(v.allcov(v.cover, 3, 10));
    assert.ok(!v.allcov(v.cover, 2, 10));
  });
});

// ---------------------------------------------------------------- Band decision

describe('TestBands', () => {
  const plan = (m, d, kind, pos = null, v = 0) => {
    const sc = scene(m, { pos, direction: v, buf: BIG });
    return [new V.Ctx(sc).bandPlan(d, kind), sc];
  };

  test('test_uniform', () => {
    const [p] = plan(openRoom(13, 13, 2), 2, V.KIND_FLOOR);
    assert.deepEqual(p.ground.slice(0, 2), ['band', 1]);
    assert.deepEqual(p.tiles, []);
    assert.equal(p.gap, false);
  });

  test('test_mixed_tiles_for_other_styles', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([0, 0, 0, 0], 2, 1, 0, 0)];
    const rows = [...new Array(3).fill('.........'), '....,....', ...new Array(3).fill('.........')];
    const m = mkMap(rows, t, { '.': 0, ',': 1 }, { start: 6 * 9 + 4 });
    const [p] = plan(m, 3, V.KIND_FLOOR);
    assert.deepEqual(p.ground.slice(0, 2), ['band', 1]);
    assert.deepEqual(p.tiles.map(([e]) => e.s).sort((a, b) => a - b), [-3, -2, -1, 1, 2, 3]);
    assert.ok(p.tiles.every(([, n]) => n === 1));
    assert.equal(p.gap, false);
  });

  test('test_gap_gives_wallpaper', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([0, 0, 0, 0], 0, 1, 0, 0)];
    const rows = [...new Array(3).fill('.........'), '.....,...', ...new Array(3).fill('.........')];
    const m = mkMap(rows, t, { '.': 0, ',': 1 }, { start: 6 * 9 + 4 });
    const [p] = plan(m, 3, V.KIND_FLOOR);
    assert.equal(p.gap, true);
    assert.equal(p.ground, 'wallpaper');
    assert.ok(p.tiles.every(([, n]) => n === 1));
    assert.ok(!p.tiles.map(([e]) => e.s).includes(1));   // the gap is the cell (3, +1)
  });

  test('test_blocked_cells_are_any', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0)];
    const m = mkMap(['#######', '#.....#', '#.....#', '#######'], t, { '#': 1, '.': 0 }, { outside: 1, start: 2 * 7 + 3 });
    const [p] = plan(m, 1, V.KIND_FLOOR);
    assert.deepEqual(p.ground.slice(0, 2), ['band', 0]);
    const [p2] = plan(m, 2, V.KIND_FLOOR);           // row y = 0: all wall -> all irrelevant
    assert.equal(p2, null);
  });

  test('test_block_without_all_faces_is_gap', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 0], 0, 0, SOLID | OCC, 0)];   // one face missing
    const m = mkMap(['#####', '#...#', '#####'], t, { '#': 1, '.': 0 }, { outside: 1, start: 7 });
    const sc = scene(m, { pos: 7, direction: 0, buf: BIG });
    assert.equal(new V.Ctx(sc).bandPlan(1, V.KIND_FLOOR).gap, true);
  });

  test('test_out_of_range_style_is_gap_and_no_dts', () => {
    const [p, sc] = plan(openRoom(13, 13, 9), 1, V.KIND_FLOOR);       // style 9 > NST: gap
    assert.equal(p.gap, true);
    sc.dts[V.KIND_FLOOR] = null;
    const sc2 = scene(openRoom(13, 13, 1), { buf: BIG });
    sc2.dts[V.KIND_FLOOR] = null;
    assert.equal(new V.Ctx(sc2).bandPlan(1, V.KIND_FLOOR).gap, true);
    checkPixels(sc2, 1, 'without floor DTS');
  });

  test('test_ground_empty_when_band_missing', () => {
    const [p] = plan(openRoom(13, 13, 3), 2, V.KIND_FLOOR);
    assert.equal(p.ground, null);
    assert.equal(p.tiles.length, 5);
  });

  test('test_decisions_pixel_equal', () => {
    for (const floor of [1, 2, 3, 9]) {
      for (const ceil of [1, 2, 3, 0]) {
        const m = openRoom(13, 13, floor, ceil);
        for (const v of [0, 1]) {
          const sc = scene(m, { direction: v, buf: HUGE, bandCover: !!(floor & 1) });
          checkPixels(sc, floor * 10 + ceil, `floor ${floor} ceil ${ceil}`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- Comparison with the dbetex preview (golden hashes)

describe('TestPreviewCompare', () => {
  const windowZero = (sc) => {
    const vram = sc.makeVram(1);
    const g = sc.dvg;
    for (let y = 0; y < g.vh; y++) {
      const a = (sc.ap + g.row(y)) & 0xFFFF;
      vram.fill(0, a, a + g.vw);
    }
    return vram;
  };

  test('test_walls_corridor', () => {
    const t = [T([0, 0, 0, 0], 0, 0, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0)];
    const rows = [...new Array(4).fill('#########'), ...new Array(3).fill('####.####')];
    const m = mkMap(rows, t, { '#': 1, '.': 0 }, { outside: 1, start: 6 * 9 + 4, direction: 0 });
    const prev = GOLD.preview.walls;
    const sc = scene(m, { dbg: false, bgfill: 0 });
    const img = V.windowImage(sc, V.paintReference(sc, windowZero(sc)), 4);
    assert.deepEqual([img.width, img.height], prev.size);
    assert.equal(sha(img.rgb), prev.rgb_sha);
    const sc2 = scene(m, { dbg: false, bgfill: 0 });
    const vram = windowZero(sc2);
    V.renderView(sc2, vram);
    assert.equal(sha(V.windowImage(sc2, vram, 4).rgb), prev.rgb_sha);
  });

  test('test_floor_ceiling_tiles', () => {
    for (const [kind, art] of [[V.KIND_FLOOR, 'floor'], [V.KIND_CEIL, 'ceil']]) {
      const m = openRoom(13, 13, kind === V.KIND_FLOOR ? 3 : 0, kind === V.KIND_CEIL ? 2 : 0);
      const sc = scene(m, { dbg: false, bgfill: 0 });
      const img = V.windowImage(sc, V.paintReference(sc, windowZero(sc)), 4);
      const prev = GOLD.preview[art];
      assert.deepEqual([img.width, img.height], prev.size);
      assert.equal(sha(img.rgb), prev.rgb_sha, art);
    }
  });
});

// ---------------------------------------------------------------- Objects

describe('TestObjects', () => {
  const sceneO = (objs, { itemtab = null, itemph = 0, content = null, v = 0, m = null } = {}) => {
    m = m || openRoom();
    if (content) {
      m = m.clone();
      for (const [c, g] of content) m.content[c] = g;
    }
    return [scene(m, { direction: v, objects: objs, itemtab, itemph, buf: BIG }), m];
  };
  const cellAt = (m, d, s, v = 0) => {
    const cx = m.start % m.width, cy = Math.floor(m.start / m.width);
    const [fx, fy] = V.FORE[v], [rx, ry] = V.RIGHT[v];
    return (cy + d * fy + s * ry) * m.width + cx + d * fx + s * rx;
  };
  const srcSets = (sc, res) => {
    const out = [];
    for (const e of V.decodeVcl(res.buffer)) {
      if ([2, 3, 12].includes(e[0])) {
        sc.vramBases.s2.forEach((b, i) => {
          const ss = sc.s2[i];
          if (ss !== null && b <= e[1] && e[1] < b + ss.vram.length) out.push(i);
        });
      }
    }
    return out;
  };

  test('test_item_sets_and_objvis', () => {
    let [sc] = sceneO([], { itemtab: [0, 2, 0, ...zeros(61)], content: [[cellAt(openRoom(), 2, 0), 1]] });
    let res = V.view(sc);
    assert.equal(res.objvis, 0);                      // items do not set an OBJVIS bit
    assert.deepEqual([...new Set(srcSets(sc, res))], [1]);
    [sc] = sceneO([], { itemtab: [0, 2, ...zeros(62)] });
    res = V.view(sc);
    assert.deepEqual(srcSets(sc, res), []);
  });

  test('test_hidden_and_invalid', () => {
    const m = openRoom();
    const c = cellAt(m, 2, 0);
    const objs = [new V.Obj(c, 0, 0, 0, 4, true), new V.Obj(c, 6, 0, 0, 4), new V.Obj(c, 1, 0xFF, 0, 4)];
    const [sc] = sceneO(objs);
    const res = V.view(sc);
    assert.equal(res.objvis, 0b100);
    assert.deepEqual([...new Set(srcSets(sc, res))], [1]);
  });

  test('test_order_by_subposition_item_first', () => {
    const m = openRoom();
    const c = cellAt(m, 2, 0);
    const objs = [new V.Obj(c, 0, 2, 0, 3), new V.Obj(c, 2, 2, 0, 0), new V.Obj(c, 3, 2, 0, 4), new V.Obj(c, 2, 2, 0, 7)];
    const [sc] = sceneO(objs, { itemtab: [0, 2, ...zeros(62)], content: [[c, 1]] });
    const res = V.view(sc);
    const sets = srcSets(sc, res);
    assert.equal(res.objvis, 0b1111);
    const seq = [];
    for (const s of sets) if (!seq.length || seq[seq.length - 1] !== s) seq.push(s);
    assert.deepEqual(seq, [2, 1, 3, 2, 0]);
  });

  test('test_subposition_rotates_with_view', () => {
    const m = openRoom();
    for (let v = 0; v < 4; v++) {
      const c = cellAt(m, 2, 0, v);
      const [sc] = sceneO([new V.Obj(c, 0, 2, 0, 0), new V.Obj(c, 2, 2, 0, 3)], { v });
      const sets = srcSets(sc, V.view(sc));
      const exp = dbemap.SUBPOS_VIEW[v][0] < dbemap.SUBPOS_VIEW[v][3] ? 0 : 2;
      assert.equal(sets[0], exp, `Blick ${v}`);
    }
  });

  test('test_angle_and_phase_selection', () => {
    const m = openRoom();
    const ss = env().assets.sprites[0];
    const c = cellAt(m, 1, 0);
    const seen = new Set();
    for (let o = 0; o < 4; o++) {
      for (const ph of [0, 1, 5]) {
        const [sc] = sceneO([new V.Obj(c, 0, o, ph, 2)], { v: 0 });
        const res = V.view(sc);
        const a = (2 + 0 - o) & 3;
        const idx = V.lookupImage(ss, ph, a, 1);
        const img = ss.images[idx];
        const ents = V.decodeVcl(res.buffer).filter((x) => [2, 3, 12].includes(x[0]));
        const base = sc.vramBases.s2[0];
        if (img.cores.length) assert.ok(ents.some((x) => x[1] === base + img.cores[0].src));
        seen.add(idx);
      }
    }
    assert.ok(seen.size > 4);
  });

  test('test_depth_zero_not_drawn', () => {
    const m = openRoom();
    const [sc] = sceneO([new V.Obj(m.start, 0, 2, 0, 4)]);
    assert.equal(V.view(sc).objvis, 0);
  });

  test('test_hidden_behind_cover', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0)];
    const rows = ['#######', '#.....#', '###.###', '###.###', '###.###', '#######'];
    const m = mkMap(rows, t, { '#': 1, '.': 0 }, { outside: 1, start: 4 * 7 + 3 });
    const c = 1 * 7 + 3;
    const [sc] = sceneO([new V.Obj(c, 0, 2, 0, 4)], { m });
    assert.equal(V.view(sc).objvis, 1);
    const m2 = m.clone();
    m2.cells[2 * 7 + 3] = 1;
    const [sc2] = sceneO([new V.Obj(c, 0, 2, 0, 4)], { m: m2 });
    assert.equal(checkPixels(sc2, 1).objvis, 0);
  });

  test('test_objn_over_16_reads_16', () => {
    const m = openRoom();
    const c = cellAt(m, 2, 0);
    const o = new V.Obj(c, 0, 2, 0, 4);
    const [sc] = sceneO(new Array(20).fill(o));
    assert.equal(V.view(sc).objvis, 0xFFFF);
  });

  test('test_item_phase', () => {
    const m = openRoom();
    const c = cellAt(m, 2, 0);
    const bufs = [0, 1].map((ph) => V.view(sceneO([], { itemtab: [0, 2, ...zeros(62)], itemph: ph, content: [[c, 1]] })[0]).buffer);
    assert.ok(!eqBytes(bufs[0], bufs[1]));
  });
});

describe('TestContent', () => {
  const build = (content, occ = false) => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([2, 2, 2, 2], 1, 1, SOLID | (occ ? OCC : 0) | (content ? CNT : 0), 0),
      T([1, 1, 1, 1], 0, 0, SOLID | OCC, 0)];
    const rows = ['#########', '#########', '#...+...#', '#.......#', '#.......#', '#.......#', '#########'];
    return mkMap(rows, t, { '#': 2, '.': 0, '+': 1 }, { outside: 2, start: 5 * 9 + 4, direction: 0 });
  };
  const run = (content, setn = 0, q = 4, occ = false) => {
    const m = build(content, occ);
    const cell = 2 * 9 + 4;
    return [scene(m, { objects: [new V.Obj(cell, setn, 2, 0, q)], buf: BIG, bandCover: true }), m, cell];
  };

  test('test_objects_only_with_flag', () => {
    let [sc] = run(false);
    assert.equal(V.view(sc).objvis, 0);
    [sc] = run(true);
    assert.equal(checkPixels(sc, 1, 'CONTENT with object').objvis, 1);
  });

  test('test_order_side_objects_front', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([2, 2, 2, 2], 1, 1, SOLID | CNT, 0)];
    const rows = ['#########', '#########', '#...#...#', '#.......#', '#.......#', '#.......#', '#########'];
    const m = mkMap(rows, t, { '#': 1, '.': 0 }, { outside: 1, start: 5 * 9 + 4, direction: 0 });
    m.cells[3 * 9 + 3] = 1;
    const cell = 3 * 9 + 3;
    for (const inh of [false, true]) {
      const mm = m.clone();
      if (!inh) mm.tiles[1].flags &= ~CNT;
      const sc = scene(mm, { objects: [new V.Obj(cell, 0, 2, 0, 4)], buf: BIG });
      const ents = V.decodeVcl(V.view(sc).buffer);
      const base = sc.vramBases.s2[0], wallb = sc.vramBases.dts[0];
      const idx = (lo, n) => ents.map((e, i) => ([2, 3, 12].includes(e[0]) && lo <= e[1] && e[1] < lo + n ? i : -1)).filter((i) => i >= 0);
      const posSprite = idx(base, sc.s2[0].vram.length);
      const wallp = idx(wallb, sc.dts[0].vram.length);
      if (!inh) { assert.deepEqual(posSprite, []); continue; }
      assert.ok(posSprite.length);
      assert.ok(wallp.some((p) => p < posSprite[0]) && wallp.some((p) => p > posSprite[posSprite.length - 1]));
      checkPixels(sc, 2, 'CONTENT Reihenfolge');
    }
  });

  test('test_cell_group_order_in_visibility_list', () => {
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([2, 2, 2, 2], 1, 1, SOLID | CNT, 0)];
    const rows = ['#####', '#...#', '#...#', '#...#', '#####'];
    const m = mkMap(rows, t, { '#': 1, '.': 0 }, { outside: 1, start: 3 * 5 + 2, direction: 0 });
    m.cells[2 * 5 + 1] = 1;                           // (d 1, s -1)
    const v = new V.View(scene(m, { objects: [new V.Obj(2 * 5 + 1, 0, 2, 0, 4)], buf: BIG }));
    const ceOf = (vv) => new globalThis.Map(vv.cellsOf(1)).get(-1);
    const order = v.cellOrder(ceOf(v), v.tile(v.cell(1, -1))).map((e) => e.art);
    assert.deepEqual(order.slice(0, 3), [V.ART_FRONT, V.ART_OBJ, V.ART_SIDE]);
    const plain = m.clone();
    plain.tiles[1].flags &= ~CNT;
    const v2 = new V.View(scene(plain, { buf: BIG }));
    const order2 = v2.cellOrder(ceOf(v2), v2.tile(v2.cell(1, -1))).map((e) => e.art);
    assert.deepEqual(order2.slice(0, 3), [V.ART_FRONT, V.ART_SIDE, V.ART_FLOOR]);
  });

  test('test_content_pixels_random', () => {
    const rnd = new PyRandom(99);
    let n = 0;
    for (let k = 0; k < 120; k++) {
      const sc = V.randomScene(1000 + k, env().assets, { nobj: 0, buf: BIG });
      const m = sc.dmp;
      const inh = new Set(m.cells.map((c, i) => (m.tiles[c].flags & CNT && m.tiles[c].walls.some((x) => x) ? i : -1)).filter((i) => i >= 0));
      if (!inh.size) continue;
      const ctx = new V.Ctx(sc);
      const objs = [];
      for (const d of [1, 2, 3]) {
        for (let s = -3; s <= 3; s++) {
          const c = ctx.cell(d, s);
          if (c !== null && inh.has(c)) {
            const set = rnd.choice([0, 2, 3]), dir = rnd.randrange(4), ph = rnd.randint(0, 1);
            objs.push(new V.Obj(c, set, dir, ph, rnd.randint(0, 4)));
          }
        }
      }
      if (!objs.length) continue;
      sc.objects = objs.slice(0, 16);
      if (V.view(sc).a) continue;
      checkPixels(sc, k, `CONTENT-Scene ${k}`);
      n++;
    }
    assert.ok(n > 5);
  });
});

// ---------------------------------------------------------------- Overflow

describe('TestOverflow', () => {
  const scenes = () => {
    const e = env();
    const out = [];
    for (const i of [9, 16, 22]) for (let v = 0; v < 4; v++) out.push(scene(e.demo, { pos: i, direction: v }));
    const t = [T([0, 0, 0, 0], 1, 1, 0, 0), T([2, 2, 2, 2], 1, 1, SOLID, 0)];
    const m = mkMap([...new Array(3).fill('#######'), ...new Array(4).fill('#.....#')], t, { '#': 1, '.': 0 }, { outside: 1, start: 6 * 7 + 3 });
    out.push(scene(m, { bandCover: true }));            // grate scene
    out.push(V.randomScene(5, e.assets, { buf: BIG }));
    return out;
  };
  const withBuf = (sc, buf) => { const s = sc.copy(); s.buf = buf; return s; };

  test('test_invariants_for_small_buffers', () => {
    scenes().forEach((sc, k) => {
      const full = V.view(withBuf(sc, [0x1300, 0x1300 + 6000]));
      for (const size of [64, 128, 256, 512, 1024, 2304]) {
        const s = withBuf(sc, [0x1300, 0x1300 + size]);
        const res = V.view(s);
        assert.ok(res.vcllen + res.vmslen <= size, `Scene ${k} buffer ${size}`);
        assert.equal(res.vcl[res.vcl.length - 1], 0);
        assert.ok([0, 2, 3].includes(res.a));
        if (res.a === 0 && res.vcllen === full.vcllen && res.vmslen === full.vmslen) assert.deepEqual(res.vcl, full.vcl);
        if (size >= full.vcllen + full.vmslen) {
          assert.equal(res.a, 0);
          assert.equal(res.vcllen, full.vcllen);
          assert.equal(res.vmslen, full.vmslen);
        }
        const vram = s.makeVram(k);
        const before = Uint8Array.from(vram);
        V.runVcl(res.bank0(), vram, res.p0);
        outsideUnchanged(s, before, vram, `Scene ${k} buffer ${size}`);
      }
    });
  });

  test('test_exact_model', () => {
    scenes().forEach((sc, k) => {
      const v = new V.View(withBuf(sc, BIG));
      v.run();
      const offered = v.items.map((it) => [it.v, it.m]);
      if (offered.length >= V.MAXITEM) return;
      for (const size of [64, 100, 128, 200, 256, 400, 512, 700, 1024, 1500, 2304]) {
        let nv = 1, nm = 0, n = 0, partial = false, stop = false;
        for (const [iv, im] of offered) {
          if (n === V.MAXITEM) { stop = true; break; }
          if (nv + iv + nm + im <= size) { nv += iv; nm += im; n++; }
          else if (im > 0 && iv > 7 && nv + iv - 7 + nm <= size) { nv += iv - 7; n++; partial = true; }
          else if (im > 0 && iv === 7) partial = true;
          else { stop = true; break; }
        }
        const res = V.view(withBuf(sc, [0x1300, 0x1300 + size]));
        assert.deepEqual([res.vcllen, res.vmslen], [nv, nm], `Scene ${k} buffer ${size}`);
        assert.equal(res.a, stop ? 2 : (partial ? 3 : 0), `Scene ${k} buffer ${size}`);
        assert.equal(res.items, n);
      }
    });
  });

  test('test_partial_rule_happens', () => {
    let found = 0;
    for (const sc of scenes()) {
      for (let size = 300; size < 1400; size += 7) {
        const res = V.view(withBuf(sc, [0x1300, 0x1300 + size]));
        if (res.a === 3) {
          found++;
          V.decodeVcl(res.buffer);
          assert.ok(res.vcllen + res.vmslen <= size);
          break;
        }
      }
    }
    assert.ok(found >= 1);
  });

  test('test_truncation_loses_back_parts', () => {
    const sc = scene(env().demo, { pos: 9, direction: 1 });
    const full = V.decodeVcl(V.view(withBuf(sc, BIG)).buffer);
    const r = V.view(withBuf(sc, [0x1300, 0x1300 + 400]));
    assert.equal(r.a, 2);
    const part = V.decodeVcl(r.buffer);
    assert.ok(part.length < full.length);
    const strip = (es) => es.map((e) => (e[0] === 12 ? e.slice(0, 3) : e));
    assert.deepEqual(strip(part).slice(-3), strip(full).slice(-3));
  });

  test('test_maxitem', () => {
    const tiles = [T([0, 0, 0, 0], 2, 2, 0, 0), T([0, 0, 0, 0], 3, 1, 0, 0)];
    const m2 = mkMap(new Array(13).fill('01'.repeat(7)), tiles, { 0: 0, 1: 1 }, { start: 6 * 14 + 6 });
    const sc = scene(m2, { buf: BIG });
    assert.ok([0, 2].includes(V.view(sc).a));
    sc.buf = [0x0200, 0x1C00];
    const v = new V.View(sc);
    v.run();
    assert.ok(v.items.length <= V.MAXITEM);
  });

  test('test_maxitem_forced', () => {
    const sc = scene(env().demo, { pos: 9, direction: 1, buf: BIG });
    const orig = V.config.maxItem;
    let res;
    try {
      V.config.maxItem = 5;
      res = V.view(sc);
    } finally {
      V.config.maxItem = orig;
    }
    assert.deepEqual([res.a, res.items], [2, 5]);
    V.runVcl(res.bank0(), sc.makeVram(0), res.p0);
  });

  test('test_a2_has_priority', (t) => {
    for (const sc of scenes()) {
      for (let size = 64; size < 600; size += 5) {
        const r = V.view(withBuf(sc, [0x1300, 0x1300 + size]));
        if (r.partial && r.a === 2) return;
      }
    }
    t.skip('no case with A = 2 and edge omitted found');
  });
});

// ---------------------------------------------------------------- Budget, scene file, CLI

describe('TestBudgetAndCli', () => {
  test('test_budget_report', () => {
    const e = env();
    const sc = [0, 1, 2, 3].map((v) => scene(e.demo, { pos: 9, direction: v }));
    const small = scene(e.demo, { pos: 9, direction: 1, buf: [0x1300, 0x1300 + 300] });
    const rep = V.budget([...sc, small]);
    assert.equal(rep.scenes, 5);
    assert.equal(rep.warnings.length, 1);
    assert.ok(rep.warnings[0].includes('A = 2'));
    assert.ok(rep.max_total > 800);
    assert.equal(rep.codes[0], 4);
  });

  test('test_load_scene_and_cli', () => {
    // scene directory with the files of the dbetex CLI (fixture, see mkgolden_view.py)
    const sdir = join(FIX, 'scene');
    const sfile = join(sdir, 'scene.toml');
    const sc = V.loadScene(readFileSync(sfile), (n) => new Uint8Array(readFileSync(join(sdir, n))), sfile);
    assert.deepEqual([sc.dir, sc.pos], [1, 9]);
    const res = checkPixels(sc, 0, 'load_scene');
    const td = mkdtempSync(join(tmpdir(), 'dbeview-'));
    const run = (argv) => {
      const out = [], err = [];
      let code = 0;
      try {
        viewCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
      } catch (e) {
        if (e.usage) code = 2;
        else if (e instanceof Error && (e.name !== 'Error' || e.code === 'ENOENT')) { code = 1; err.push(e.message); }
        else throw e;
      }
      return { code, stdout: out.join('\n'), stderr: err.join('\n') };
    };
    try {
      let r = run(['render', sfile, '--out', join(td, 'o.png'), '--zoom', '2']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(statSync(join(td, 'o.png')).size > 100);
      assert.ok(r.stdout.includes(`VCL ${res.vcllen}`));
      r = run(['dump', sfile]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(`VCLADR 0x${(0x1C00 - res.vcllen).toString(16).padStart(4, '0')}`));   // VCL list ends at B1
      r = run(['budget', sfile]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('1 scenes'));
      r = run(['render', join(td, 'fehlt.toml')]);
      assert.equal(r.code, 1);
      assert.ok(!r.stderr.includes('Traceback'));
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('TestFixedAddress', () => {
  test('test_fixed', () => {
    for (let k = 0; k < 12; k++) {
      const sc = V.randomScene(700 + k, env().assets);
      const sc2 = sc.copy();
      sc2.bufFix = true;
      const r1 = V.view(sc), r2 = V.view(sc2);
      assert.deepEqual([r2.p0, r2.vcllen, r2.vmslen, r2.x], [0x1300, r2.vcl.length, r2.vms.length, r1.x]);
      const b0 = r2.bank0();
      const l0 = 0x1C00 - r2.vcllen;
      assert.deepEqual(Array.from(b0.subarray(0x1300, 0x1303)), [10, l0 & 255, l0 >> 8]);
      const vptr = V.decodeVcl(r2.buffer).filter((e) => e[0] === 12).map((e) => e[3]);
      if (vptr.length) assert.equal(Math.min(...vptr), 0x1303);
      if (r1.a === 0 && r2.a === 0) {
        const v1 = new Uint8Array(65536), v2 = new Uint8Array(65536);
        V.runVcl(r1.bank0(), v1, r1.p0, 80, r1.bank1());
        V.runVcl(r2.bank0(), v2, r2.p0, 80, r2.bank1());
        assert.ok(eqBytes(v1, v2));
      }
    }
  });

  test('test_overflow_three_bytes', () => {
    const sc = scene(env().demo);
    const r = V.view(sc);
    const n = r.vcllen + r.vmslen;
    sc.buf = [0x1300, 0x1300 + n];
    assert.equal(V.view(sc).a, 0);
    const sc2 = sc.copy();
    sc2.bufFix = true;
    assert.notEqual(V.view(sc2).a, 0);
    sc2.buf = [0x1300, 0x1300 + n + 3];
    assert.equal(V.view(sc2).a, 0);
  });
});
