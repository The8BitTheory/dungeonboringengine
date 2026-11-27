// Parity of core/view.js with tools/dbeview.py: goldens from test/golden/mkgolden_view.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../core/view.js';
import * as dbemap from '../core/map.js';
import { PyRandom } from '../core/pyrandom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIX = join(HERE, 'golden', 'view');
const G = JSON.parse(readFileSync(join(HERE, 'golden', 'view.json'), 'utf8'));
const BIG = [0x0200, 0x1C00];
const rd = (n) => new Uint8Array(readFileSync(join(FIX, n)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');

const A = V.assetsFromFiles({
  dvg: rd('west140.dvg'), walls: [rd('walls.dts'), rd('walls.vram')], floor: [rd('floor.dts'), rd('floor.vram')],
  ceil: [rd('ceil.dts'), rd('ceil.vram')], dbg: [rd('sky.dbg'), rd('sky.vram')],
  sprites: [0, 1, 2, 3].map((i) => [rd(`s2_${i}.s2`), rd(`s2_${i}.vram`)]),
});
const map = (rel) => dbemap.loadsToml(readFileSync(join(ROOT, rel)), rel);
const DEMO = map('docs/specs/examples/demo.toml');
const DEMO2 = map('demo/demo.toml');

function wsha(sc, vram) {
  const rows = V.windowBytes(sc, vram);
  const h = createHash('sha256');
  for (const r of rows) h.update(r);
  return h.digest('hex');
}

function check(sc, g, seed, msg, pixels = true) {
  const res = V.view(sc);
  const got = { a: res.a, x: res.x, p0: res.p0, objvis: res.objvis, vcllen: res.vcllen, vmslen: res.vmslen, items: res.items,
    partial: res.partial, lists1: res.lists1.size };
  const exp = Object.fromEntries(Object.keys(got).map((k) => [k, g[k]]));
  assert.deepEqual(got, exp, msg);
  if (g.vcl) assert.equal(hex(res.vcl), g.vcl, msg);
  if (g.vms) assert.equal(hex(res.vms), g.vms, msg);
  assert.equal(sha(res.vcl), g.vcl_sha, msg + ' VCL');
  assert.equal(sha(res.vms), g.vms_sha, msg + ' VMS');
  if (pixels && g.win_sha) {
    const vram = sc.makeVram(seed);
    const before = Uint8Array.from(vram);
    V.renderView(sc, vram, res);
    assert.equal(wsha(sc, vram), g.win_sha, msg + ' window');
    assert.equal(wsha(sc, V.paintReference(sc, before)), g.ref_sha, msg + ' paint_reference');
  }
  return res;
}

test('random scenes', () => {
  for (const g of G.random) {
    const sc = V.randomScene(g.seed, A, { buf: BIG });
    const msg = `random scene ${g.seed}`;
    assert.equal(sha(dbemap.toDmp(sc.dmp)), g.dmp_sha, msg + ' map');
    assert.deepEqual(sc.objects.map((o) => [o.cell, o.set, o.dir, o.phase, o.q, o.hidden, o.noblock]), g.objects, msg);
    assert.deepEqual([sc.pos, sc.dir, sc.vramBases], [g.pos, g.dir, g.bases], msg);
    check(sc, g, g.seed, msg);
  }
});

test('far view (random and demo maps)', () => {
  const maps = { demo: DEMO, demo_demo: DEMO2 };
  for (const g of G.far) {
    let sc;
    if (g.map === undefined) sc = V.farVariant(V.randomScene(g.seed, A, { buf: BIG }), g.seed);
    else {
      sc = V.makeScene(A, maps[g.map], { pos: g.pos, direction: g.dir, bandCover: g.bc, buf: BIG, farfill: g.farfill,
        dbg: g.dbg, bgfill: 0x5A });
    }
    assert.equal(sc.farfill, g.farfill);
    check(sc, g, g.seed ?? g.pos * 4 + g.dir, `far ${g.map} ${g.seed ?? g.pos}/${g.dir}`);
  }
});

test('fixed list address', () => {
  for (const g of G.fixed) {
    const sc = V.randomScene(g.seed, A);
    sc.bufFix = g.fix;
    check(sc, g, 0, `fixed ${g.seed} ${g.fix}`, false);
  }
});

test('demo map, all free views, band cover off/on', () => {
  for (const g of G.demo) {
    const sc = V.makeScene(A, DEMO, { pos: g.pos, direction: g.dir, bandCover: g.bc });
    check(sc, g, g.pos * 4 + g.dir, `demo ${g.pos}/${g.dir} bc ${g.bc}`);
  }
});

test('double fronts', () => {
  const a2 = V.doubleFronts(A);
  assert.deepEqual(a2.dvgPrg, rd('double_fronts.dvg'));
  assert.deepEqual([a2.walls, a2.floor, a2.ceil].map((t) => sha(t.dtsPrg)), G.double_dts_sha);
  for (const g of G.double) {
    const sc = g.seed !== undefined ? V.randomScene(g.seed, a2, { buf: BIG })
      : V.makeScene(a2, DEMO, { pos: g.pos, direction: g.dir, bandCover: g.bc, buf: BIG });
    check(sc, g, g.seed !== undefined ? g.seed - 1000 : g.pos * 4 + g.dir, `double ${g.seed ?? g.pos}/${g.dir}`);
  }
});

test('VMS lists from bank 1 (type 9)', () => {
  const rnd = new PyRandom(9);
  const s2a = [];
  let adr = 0x4000;
  for (const ss of A.sprites) { s2a.push(ss ? adr : 0); adr += ss ? V.s2Content(ss).length : 0; }
  G.bank1.forEach((g, k) => {
    const objs = V.randomObjects(rnd, DEMO, g.pos, g.dir, g.nobj);
    const sc = V.makeScene(A, DEMO, { pos: g.pos, direction: g.dir, objects: objs, itemtab: [0, 2, 3, 2, ...new Array(60).fill(0)] });
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((j) => sc.s2Bank1(j)), g.default_s2);
    const sc1 = sc.copy();
    sc1.vmsBank1 = true;
    sc1.s2Addr = s2a;
    const res = check(sc1, g, k, `bank1 ${k}`);
    assert.equal(sha(res.bank1()), g.lists1_sha);
  });
});

test('scene files (load_scene)', () => {
  for (const g of G.scenes) {
    const dir = join(FIX, dirname(g.file));
    const sc = V.loadScene(readFileSync(join(FIX, g.file)), (n) => new Uint8Array(readFileSync(join(dir, n))), g.file);
    assert.deepEqual(sc.vramBases, g.bases);
    const res = check(sc, g, 0, g.file);
    assert.deepEqual(V.decodeVcl(res.buffer), g.dump);
    const img = V.windowImage(sc, V.renderView(sc, new Uint8Array(65536))[0], 2);
    assert.equal(sha(img.rgb), g.image_sha);
  }
});
