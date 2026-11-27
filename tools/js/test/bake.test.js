// Tests for core/bake.js (P8 phase 3): visibility, check, baking, DAP, packing, build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from '../core/bake.js';
import * as V from '../core/view.js';
import * as M from '../core/map.js';
import * as vrl from '../core/vrl.js';
import { parseToml } from '../core/io/toml.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENE = join(HERE, 'golden', 'view', 'scene', 'scene.toml');
const fsResolve = (p) => { try { return new Uint8Array(readFileSync(p)); } catch { return null; } };

function scene() {
  const dir = dirname(SCENE);
  return V.loadScene(parseToml(readFileSync(SCENE, 'utf8')), (rel) => fsResolve(join(dir, rel)), SCENE);
}

test('viewpoints: non-solid cells x 4', () => {
  const sc = scene();
  const vps = B.viewpoints(sc.dmp);
  const free = sc.dmp.cells.filter((t) => !(sc.dmp.tiles[t].flags & M.FLAGS.solid)).length;
  assert.equal(vps.length, free * 4);
});

test('visibility: every traced face is uncovered and resolves consistently', () => {
  const sc = scene();
  const recs = B.visibility(sc, B.viewpoints(sc.dmp).slice(0, 40));
  assert.ok(recs.length > 0);
  for (const r of recs) {
    assert.ok(['own', 'fallback', 'none', 'nostyle'].includes(r.res));
    assert.equal(r.drawn, r.res === 'own' || r.res === 'fallback');
    assert.equal(sc.dmp.tiles[sc.dmp.cells[r.cell]].walls[r.face], r.style);
  }
  // the scene itself is not changed (trace only on the copy)
  assert.equal(sc.trace, undefined);
});

test('visibility: front face straight ahead is seen at depth 1', () => {
  // 3 x 3 room: corridor in the middle, walls of style 1 around, looking north from the centre
  const T = (w, f) => new M.Tile([w, w, w, w], 1, 1, f, 0);
  const m = new M.Map('t', 3, 3, [T(0, 0), T(1, M.FLAGS.solid | M.FLAGS.occluding)], [1, 1, 1, 1, 0, 1, 1, 1, 1],
    new Array(9).fill(0), [], 4, 0, 1);
  const sc = scene();
  sc.dmp = m;
  const recs = B.visibility(sc, [{ pos: 4, dir: 0 }]);
  const ahead = recs.find((r) => r.cell === 1 && r.face === 2);
  assert.ok(ahead, 'south face of the cell ahead');
  assert.equal(B.slotName(ahead), 'front_d1_s+0');
  assert.equal(ahead.res, 'own');
});

test('checkVisibility groups by style, cell and face', () => {
  const recs = [
    { pos: 1, dir: 0, cell: 5, face: 2, style: 3, art: 1, d: 1, s: -1, res: 'fallback' },
    { pos: 2, dir: 0, cell: 5, face: 2, style: 3, art: 1, d: 1, s: -1, res: 'fallback' },
    { pos: 2, dir: 0, cell: 5, face: 2, style: 3, art: 0, d: 2, s: 0, res: 'own' },
    { pos: 2, dir: 0, cell: 6, face: 2, style: 1, art: 1, d: 1, s: 1, res: 'none' },
    { pos: 3, dir: 1, cell: 5, face: 2, style: 3, art: 1, d: 2, s: 1, res: 'none' },
  ];
  const c = B.checkVisibility(recs);
  assert.equal(c.problems.length, 1);
  const p = c.problems[0];
  assert.deepEqual([p.style, p.cell, p.face], [3, 5, 2]);
  assert.deepEqual(p.slots.map((s) => [s.slot, s.res, s.from.length]), [['side_d1_s-1', 'fallback', 2], ['side_d2_s+1', 'none', 1]]);
  assert.deepEqual(c.styles[3].own, ['front_d2_s+0']);
});

test('bakeAnim: patches cover every change, frame patches recreate the frames', () => {
  const sc = scene();
  const m = sc.dmp;
  // a wall face seen from the start, changed from style 1 to style 2
  const recs = B.visibility(sc, [{ pos: m.start, dir: m.direction }]);
  const r = recs.find((x) => x.res === 'own' && x.art === 0);
  assert.ok(r, 'a front face from the start');
  const anim = { name: 't', at: [r.cell % m.width, Math.floor(r.cell / m.width)], face: r.face, frames: [r.style, r.style === 1 ? 2 : 1],
    views: [{ x: m.start % m.width, y: Math.floor(m.start / m.width), dir: m.direction }], depths: null };
  const a = B.bakeAnim(sc, anim);
  assert.equal(a.views.length, 1);
  const v = a.views[0];
  assert.ok(v.rect.w > 0 && v.rect.h > 0);
  const win = anim.frames.map((st) => {
    const s = sc.copy();
    s.dmp = B.withFace(m, r.cell, r.face, st);
    s.pos = m.start; s.dir = m.direction;
    return B.windowRows(s);
  });
  for (let f = 0; f < 2; f++) {
    const w = win[0].map((row) => row.slice());
    for (let y = 0; y < v.rect.h; y++) w[v.rect.y + y].set(v.frames[f].subarray(y * v.rect.w, (y + 1) * v.rect.w), v.rect.x);
    assert.deepEqual(w, win[f], `frame ${f}`);
  }
  const { dap, vram } = B.toDap([a], 0x5000);
  assert.deepEqual([...dap.subarray(0, 6)], [0x00, 0x50, 0x44, 0x41, B.FORMAT_VERSION, 1]);
  assert.equal(vram.length, v.rect.w * v.rect.h * 2);
  assert.equal(dap[6] | (dap[7] << 8), r.cell);
  assert.deepEqual([...dap.subarray(14, 18)], [v.rect.x, v.rect.y, v.rect.w, v.rect.h]);
});

test('pack: overlap, ranges, pool and free bank 1 space', () => {
  const l = B.pack([{ name: 'a', kind: 'dmp', load: 0x4000, len: 0x100 }, { name: 'b', kind: 's2', load: 0x40F0, len: 0x10 },
    { name: 'w', kind: 'wall', load: 0x8000, len: 0x3001 }], [{ name: 'x', len: 100, stream: 50 }, { name: 'y', len: 50, stream: 40 }],
  { pool: [1000, 1120], rxvUsPerByte: 10 });
  assert.ok(l.errors.some((e) => /a and b overlap/.test(e)));
  assert.ok(l.errors.some((e) => /area end/.test(e)));
  assert.ok(l.errors.some((e) => /pool: end 1150 > 1120/.test(e)));
  assert.deepEqual(l.vram.map((v) => v.base), [1000, 1100]);
  assert.equal(l.loadUs, 1500);
  assert.equal(B.freeBank1([{ load: 0x4000, end: 0x4100 }, { load: 0x4200, end: 0xB000 }], 0x80), 0x4100);
  assert.equal(B.freeBank1([{ load: 0x4000, end: 0x4100 }, { load: 0x4120, end: 0xB000 }], 0x80), 0xE800);
});

test('loadBakeConf errors', () => {
  const bad = [
    ['format = "x"\nversion = 1', /format = "dbebake"/],
    ['format = "dbebake"\nversion = 1\n[bake]\nname = "a"', /scene missing/],
    ['format = "dbebake"\nversion = 1\n[bake]\nscene = "s"\nfoo = 1', /unknown key 'foo'/],
    ['format = "dbebake"\nversion = 1\n[bake]\nscene = "s"\n[[anim]]\nat = [1, 1]\nframes = [1]', /at least 2/],
    ['format = "dbebake"\nversion = 1\n[bake]\nscene = "s"\n[[anim]]\nat = [1, 1]\nframes = [1, 2]\nface = "X"', /N, E, S or W/],
  ];
  for (const [src, re] of bad) assert.throws(() => B.loadBakeConf(src, { path: 'b.toml' }), re);
});

test('buildBake on the fixture scene', () => {
  const dir = dirname(SCENE);
  const src = `format = "dbebake"\nversion = 1\n[bake]\nname = "t"\nscene = "scene.toml"\n[pack]\npool = [9600, 60000]\n`
    + '[[anim]]\nname = "g"\nat = [1, 1]\nface = "E"\nframes = [1, 2]\ndepths = [1]\n';
  const r = B.buildBake(src, { path: join(dir, 'bake.toml'), resolve: fsResolve });
  assert.deepEqual(Object.keys(r.files).sort(), ['t.bake.json', 't.bake.md', 't.dap', 't.vrl']);
  assert.equal(JSON.parse(r.files['t.bake.json']).name, 't');
  const v = vrl.unpackFile(r.files['t.vrl']);
  assert.equal(v.u, r.baked[0].views.reduce((a, x) => a + x.rect.w * x.rect.h * 2, 0));
  assert.ok(r.layout.vram.some((x) => x.name === 'anims'));
  assert.equal(r.errors.length, 0, r.errors.join('\n'));
});
