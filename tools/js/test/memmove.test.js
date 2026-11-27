// Ports of test/tools/test_dbemem.py (areas, range check, dbemap CLI) and test/tools/test_dbemove.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mem from '../core/mem.js';
import * as M from '../core/map.js';
import * as V from '../core/view.js';
import { move } from '../core/move.js';
import { main } from '../cli/dbe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DEMO_MAP = join(ROOT, 'docs', 'specs', 'examples', 'demo.toml');
const FIX = join(HERE, 'golden', 'view');
const rd = (n) => new Uint8Array(readFileSync(join(FIX, n)));

test('mem defaults', () => {
  const want = { dmp: 0x4000, s2: 0x6000, wall: 0x8000, dvg: 0xE800, floor: 0xEE00, ceiling: 0xF600, dbg: 0xFB80 };
  for (const [k, v] of Object.entries(want)) assert.equal(mem.defaultLoad(k), v, k);
});

test('mem areas valid', () => {
  const spans = Object.entries(mem.AREAS).map(([k, [a, e]]) => [a, e, k]).sort((x, y) => x[0] - y[0]);
  for (let i = 0; i + 1 < spans.length; i++) assert.ok(spans[i][1] <= spans[i + 1][0], `${spans[i][2]} and ${spans[i + 1][2]} overlap`);
  for (const [k, [a, e]] of Object.entries(mem.AREAS)) assert.ok(mem.WINDOWS.some(([wa, we]) => wa <= a && e <= we), k);
  assert.ok(spans[0][0] >= 0x4000);
  assert.ok(spans[spans.length - 1][1] <= 0xFC00);
  for (const [a, e, k] of spans) assert.ok(!(a < 0xE800 && e > 0xB000 && a >= 0xB000), k);
});

test('mem rangeError', () => {
  const f = mem.rangeError;
  assert.equal(f('dmp', 0x4000, 0x2000), null);
  assert.match(f('dmp', 0x4000, 0x2001), /area end/);
  assert.equal(f('wall', 0x8000, 0x3000), null);
  assert.match(f('wall', 0x8000, 0x3001), /area end/);
  assert.equal(f('dbg', 0xFB80, 0x80), null);
  assert.match(f('dbg', 0xFB80, 0x81), /area end/);
  assert.equal(f('ceiling', 0xF600, 0x580), null);
  assert.match(f('ceiling', 0xF600, 0x581), /area end/);
  assert.equal(f('floor', 0xEE00, 0x800), null);
  assert.match(f('floor', 0xEE00, 0x801), /area end/);
  assert.equal(f('ceiling', 0xF000, 0xBFF), null);
  assert.match(f('ceiling', 0xF000, 0xC01), /free/);
  assert.equal(f('floor', 0x4000, 0x6FFF), null);
  assert.match(f('floor', 0x4000, 0x7001), /free/);
  for (const bad of [0x2000, 0x3FFF, 0xB000, 0xDC00, 0xE7FF, 0xFC00, 0xFF00]) assert.match(f('wall', bad, 16), /load address/);
});

test('dbemap CLI range check', () => {
  const d = mkdtempSync(join(tmpdir(), 'dbe-mem-'));
  const run = (...a) => { const err = []; const st = main(['map', ...a], { out: () => {}, err: (s) => err.push(s) }); return { st, err: err.join('\n') }; };
  try {
    const out = join(d, 'm.dmp');
    assert.equal(run('build', DEMO_MAP, out).st, 0);
    assert.deepEqual([...readFileSync(out).subarray(0, 2)], [0x00, 0x40]);
    let r = run('build', DEMO_MAP, out, '--load', '0x5FF0');
    assert.equal(r.st, 1);
    assert.match(r.err, /area end/);
    r = run('build', DEMO_MAP, out, '--load', '0x2000');
    assert.equal(r.st, 1);
    assert.match(r.err, /load address/);
  } finally { rmSync(d, { recursive: true }); }
});

// ---------------------------------------------------------------- move
function smallMap() {
  const t = [new M.Tile([0, 0, 0, 0], 1, 1, 0, 0), new M.Tile([1, 1, 1, 1], 0, 0, 1 | 4, 0)];
  const rows = ['####', '#..#', '#..#', '####'];
  const content = new Array(16).fill(0);
  content[5] = 5;
  const m = new M.Map('t', 4, 4, t, rows.join('').split('').map((c) => (c === '#' ? 1 : 0)), content,
    [new M.Event(5, 4, 1), new M.Event(5, 4, 2), new M.Event(10, 3, 0)], 5, 1, 1);
  M.validate(m);
  return m;
}
const pick = (r, ...k) => k.map((x) => r[x]);

test('move steps and turns', () => {
  const m = smallMap();
  assert.deepEqual(pick(move(m, 5, 1, [], 0), 'a', 'x', 'y', 'pos', 'dir', 'p1', 'p2'), [0, 0, 0, 6, 1, 0, 0xFFFF]);
  assert.deepEqual(pick(move(m, 5, 1, [], 1), 'x', 'y', 'pos', 'p1', 'p2'), [1, 1, 5, 5, 0]);
  assert.deepEqual(pick(move(m, 5, 0, [], 0), 'x', 'y'), [1, 1]);
  assert.deepEqual(pick(move(m, 5, 2, [], 3), 'x', 'pos'), [1, 5]);
  assert.deepEqual(pick(move(m, 6, 1, [], 0), 'x', 'y'), [1, 1]);
  assert.deepEqual(pick(move(m, 10, 0, [], 6), 'x', 'y', 'dir', 'pos', 'p2'), [0, 0, 2, 10, 2]);
  assert.deepEqual([0, 1, 2, 3].map((v) => move(m, 5, v, [], 4).dir), [3, 0, 1, 2]);
  assert.deepEqual([0, 1, 2, 3].map((v) => move(m, 5, v, [], 5).dir), [1, 2, 3, 0]);
});

test('move outside', () => {
  const m = smallMap();
  m.cells[0] = 0;
  assert.deepEqual(pick(move(m, 0, 0, [], 0), 'x', 'y', 'pos'), [1, m.outside, 0]);
});

test('move objects and events', () => {
  const m = smallMap();
  assert.deepEqual(pick(move(m, 5, 1, [new V.Obj(6, 0)], 0), 'x', 'y', 'pos'), [2, 0, 5]);
  for (const o of [new V.Obj(6, 0, 0, 0, 4, false, true), new V.Obj(6, 0, 0, 0, 4, true, false)]) {
    assert.deepEqual(pick(move(m, 5, 1, [o], 0), 'x', 'pos'), [0, 6]);
  }
  const objs = [...new Array(16).fill(new V.Obj(0, 0)), new V.Obj(6, 0)];
  assert.equal(move(m, 5, 1, objs, 0).x, 0);
  assert.equal(move(m, 5, 1, objs, 0, 1).x, 0);
  assert.equal(move(m, 5, 1, [new V.Obj(6, 0)], 0, 0).x, 0);
  assert.equal(move(m, 5, 1, [], 7).a, 6);
});

test('automap reference', () => {
  const A = V.assetsFromFiles({
    dvg: rd('west140.dvg'), walls: [rd('walls.dts'), rd('walls.vram')], floor: [rd('floor.dts'), rd('floor.vram')],
    ceil: [rd('ceil.dts'), rd('ceil.vram')], dbg: [rd('sky.dbg'), rd('sky.vram')],
    sprites: [0, 1, 2, 3].map((i) => [rd(`s2_${i}.s2`), rd(`s2_${i}.vram`)]),
  });
  const demo = M.loadsToml(readFileSync(DEMO_MAP), DEMO_MAP);
  const sc = V.makeScene(A, demo, { pos: demo.start, direction: demo.direction });
  const c0 = demo.content.slice();
  V.view(sc);
  assert.deepEqual(demo.content, c0);
  sc.automap = true;
  V.view(sc);
  const marked = c0.map((a, i) => (a !== demo.content[i] ? i : -1)).filter((i) => i >= 0);
  assert.ok(marked.length);
  assert.ok(marked.every((i) => demo.content[i] === (c0[i] | 0x40)));
  assert.ok(marked.includes(demo.start));
});

// ---------------------------------------------------------------- editor writer
test('toTomlNamed keeps names and legend, same DMP', () => {
  const maps = [DEMO_MAP, join(ROOT, 'demo', 'demo.toml'), join(ROOT, 'docs', 'specs', 'examples', 'crawl128.toml')];
  for (const p of maps) {
    const text = readFileSync(p, 'utf8');
    const m = M.loadsToml(text, p);
    const out = M.toTomlNamed(m, M.legendFromToml(text, m));
    const m2 = M.loadsToml(out, 'out.toml');
    assert.deepEqual(M.toDmp(m2), M.toDmp(m), p);
    assert.deepEqual(m2.tiles.map((t) => t.name), m.tiles.map((t) => t.name), p);
    // edit: new tile + item + event, still round trips
    const e = m.clone();
    const t = M.nullTile(); t.name = 'altar room'; t.floor = 1;
    e.tiles.push(t);
    e.cells[e.start] = e.tiles.length - 1;
    e.content[e.start] = 7;
    e.events.push(new M.Event(e.start, 3, 1));
    e.events = M.sortEvents(e.events);
    const e2 = M.loadsToml(M.toTomlNamed(e, M.legendFromToml(text, m)), 'e.toml');
    assert.deepEqual(M.toDmp(e2), M.toDmp(e), p);
  }
});
