// Port of test/tools/test_crawl01.py: model of VIEW 0.1 and offline full comparison 0.1 against 0.2, plus parity
// with tools/crawl01.py (golden/crawl/crawl.json of mkgolden_crawl.py: sample views, control counts, full report).
// The full comparison covers all free cells x 4 directions x (no ghost, ghost in every cell d = 0..3 with
// 4 directions) x (gems present / collected), 19136 views, about 3 s.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as crawl01 from '../core/crawl/crawl01.js';
import * as crawlconv from '../core/crawl/crawlconv.js';
import * as V from '../core/view.js';
import { readDir, compareParallel, crawl01Cli, runCrawl } from '../cli/crawl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DATA = join(ROOT, 'test', 'tools', 'data');
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'crawl', 'crawl.json'), 'utf8')).crawl01;
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b) : b).digest('hex');

const FILES = readDir(DATA);
let ENV = null;
before(() => { ENV = new crawl01.Env(FILES); });

const pyGhost = (g) => (g === null ? 'None' : `(${g[0]}, ${g[1]})`);

describe('model (test_crawl01.py TestModel)', () => {
  test('start view entries', () => {
    const e = ENV;
    const [vis, err] = e.model.view(e.cells0, e.w, e.h, e.m.start, 0, []);
    assert.equal(err, 0);
    assert.equal(vis.length, 10);
    assert.equal(vis.filter((x) => x[0] === 'wall').length, 6);
    assert.deepEqual(new Set(vis.filter((x) => x[0] === 'spr').map((x) => x[1])), new Set([1]));
  });

  test('order and cover', () => {
    const e = ENV;
    for (const pos of e.free) {
      for (let v = 0; v < 4; v++) {
        const [vis] = e.model.view(e.cells0, e.w, e.h, pos, v, []);
        const walls = vis.filter((x) => x[0] === 'wall').map((x) => x[1].join());
        assert.equal(walls.length, new Set(walls).size, 'wall image duplicated');
        assert.ok(vis.length <= crawl01.MAXVIS);
      }
    }
  });

  test('ghost parts and items', () => {
    const e = ENV;
    let found = false;
    for (const pos of e.free) {
      for (let v = 0; v < 4; v++) {
        for (const [d, , c] of e.visibleCells(pos, v)) {
          if (d < 1 || e.cells0[c] !== crawl01.ITEM_GEM) continue;
          const [vis] = e.model.view(e.cells0, e.w, e.h, pos, v, [[c, 0, 0]]);
          const sets = vis.filter((x) => x[0] === 'spr').map((x) => x[1]);
          if (sets.includes(0) && sets.includes(1)) {
            found = true;
            assert.ok(sets.indexOf(0) < sets.length);
          }
          const [vis2] = e.model.view(e.cells1, e.w, e.h, pos, v, [[c, 0, 0]]);
          assert.ok(!vis2.filter((x) => x[0] === 'spr').map((x) => x[1]).includes(1));
        }
      }
    }
    assert.ok(found);
  });

  test('linear cell arithmetic', () => {
    const e = ENV;
    const [vis] = e.model.view(new Array(e.w * e.h).fill(0), e.w, e.h, 0, 0, []);
    assert.ok(vis.length);
  });

  test('budget and no error', () => {
    const e = ENV;
    for (const pos of e.free.slice(0, 10)) {
      for (let v = 0; v < 4; v++) {
        const r = e.one(pos, v, 0, null);
        assert.deepEqual([r.a, r.a01], [0, 0]);
        assert.ok(r.total <= 2304);
        assert.deepEqual(r.diff, []);
        assert.equal(r.outside, false);
      }
    }
  });
});

function* views(env, ghost = false) {
  for (const pos of env.free) {
    for (let v = 0; v < 4; v++) {
      if (ghost) for (const [, , c] of env.visibleCells(pos, v)) yield [pos, v, [c, 0]];
      else yield [pos, v, null];
    }
  }
}

function countBad(env, ghost = false, limit = 80) {
  let n = 0, i = 0;
  for (const [pos, v, g] of views(env, ghost)) {
    if (i++ >= limit) break;
    const r = env.one(pos, v, 0, g);
    n += r.diff.length || r.outside || r.a ? 1 : 0;
  }
  return n;
}

describe('controls (TestControls): the comparison finds deliberately introduced errors; counts as in Python', () => {
  const C = GOLD.controls;
  test('baseline clean', () => {
    const env = new crawl01.Env(FILES);
    assert.deepEqual([countBad(env), countBad(env, true)], [0, 0]);
    assert.deepEqual(C.baseline, [0, 0]);
  });

  test('wrong background fill', () => {
    const env = new crawl01.Env(FILES);
    env.sc.bgfill = 7;
    const n = countBad(env);
    assert.ok(n > 0);
    assert.equal(n, C.bgfill);
  });

  test('wall pixel flipped', () => {
    const env = new crawl01.Env(FILES);
    env.base2[crawlconv.CA + 1732 + 5000] ^= 0x10;
    const n = countBad(env, false, 400);
    assert.ok(n > 0);
    assert.equal(n, C.wall_pixel);
  });

  test('ghost anchor shifted', () => {
    const env = new crawl01.Env(FILES);
    for (const e of env.sc.dvg.elems) if (e.art === V.ART_OBJ) e.anchors[3] = [e.anchors[3][0] + 1, e.anchors[3][1]];
    assert.equal(countBad(env), 0);                    // invisible without ghost
    const n = countBad(env, true, 300);
    assert.ok(n > 0);
    assert.deepEqual([0, n], C.ghost_anchor);
  });

  test('gem anchor shifted', () => {
    const env = new crawl01.Env(FILES);
    for (const e of env.sc.dvg.elems) if (e.art === V.ART_OBJ) e.anchors[2] = [e.anchors[2][0], e.anchors[2][1] - 1];
    const n = countBad(env, false, 400);
    assert.ok(n > 0);
    assert.equal(n, C.gem_anchor);
  });

  test('ghost mask inverted', () => {
    const env = new crawl01.Env(FILES);
    env.conv.ghost.images[0].cores = [];               // image loses its cores
    const n = countBad(env, true, 300);
    assert.ok(n > 0);
    assert.equal(n, C.ghost_cores);
  });

  test('outside write detected', () => {
    const env = new crawl01.Env(FILES);
    let v2 = env.base2.slice();
    assert.equal(env.outsideChanged(v2), false);
    const g = env.sc.dvg;
    v2[g.origin + 3 * g.stride + g.vw] ^= 1;          // column 68 of window row 3: outside
    assert.equal(env.outsideChanged(v2), true);
    v2 = env.base2.slice();
    v2[10] ^= 1;
    assert.equal(env.outsideChanged(v2), true);
  });
});

describe('parity with crawl01.py', () => {
  test('VRAM images, start view, visible cells', () => {
    const e = ENV;
    assert.equal(sha(e.base1), GOLD.base1);
    assert.equal(sha(e.base2), GOLD.base2);
    const [vis, err] = e.model.view(e.cells0, e.w, e.h, e.m.start, 0, []);
    assert.deepEqual({ err, entries: vis.map((x) => [x[0], x[0] === 'wall' ? x[1] : [x[1], x[2].d, x[2].s, x[2].src]]) }, GOLD.start_view);
    for (const [k, want] of Object.entries(GOLD.visible)) {
      const [p, v] = k.split(',').map(Number);
      assert.deepEqual(e.visibleCells(p, v), want, k);
    }
  });

  test('sample views', () => {
    const e = ENV;
    const got = {};
    for (const pos of e.free.slice(0, 12)) {
      for (let v = 0; v < 4; v++) {
        const cells = e.visibleCells(pos, v);
        for (const variant of [0, 1]) {
          for (const ghost of [null, ...cells.slice(0, 2).map(([, , c]) => [c, (v + 1) & 3])]) {
            const r = e.one(pos, v, variant, ghost);
            const o = {};
            for (const k of ['a', 'outside', 'a01', 'nvis01', 'total', 'vcl', 'vms']) o[k] = r[k];
            o.ndiff = r.diff.length;
            got[`${pos},${v},${variant},${pyGhost(ghost)}`] = o;
          }
        }
      }
    }
    assert.deepEqual(got, GOLD.samples);
  });

  test('deviations with wrong background fill', () => {
    const env = new crawl01.Env(FILES);
    env.sc.bgfill = 7;
    assert.deepEqual(env.free.slice(0, 3).map((pos) => {
      const r = env.one(pos, 0, 0, null);
      return { ndiff: r.diff.length, first: r.diff.slice(0, 3) };
    }), GOLD.bgfill_first);
  });
});

describe('full comparison (TestFullCompare)', () => {
  test('full', () => {
    const rep = compareParallel(FILES, { quick: false, workers: Math.max(1, Math.min(4, cpus().length || 1)) });
    assert.equal(rep.positions, 100);
    assert.equal(rep.views, 19136);
    assert.deepEqual(rep.bad, []);
    assert.equal(rep.a_nonzero, 0);
    assert.equal(rep.outside, 0);
    assert.equal(rep.a01, 0);                         // the 0.1 model does not truncate any view
    assert.ok(rep.max_total <= 2304);
    assert.ok(rep.nvis01_max <= crawl01.MAXVIS);
    const { bad, ...rest } = rep;
    assert.deepEqual(rest, GOLD.full.summary);
    assert.equal(sha(crawl01.reportJson(rep)), GOLD.full.json);
  });

  test('CLI (quick, 2 workers, --json)', () => {
    const td = realpathSync(mkdtempSync(join(tmpdir(), 'crawl01-')));
    try {
      const r = runCrawl(crawl01Cli, ['compare', '--dir', DATA, '--quick', '--workers', '2', '--json', join(td, 'r.json')]);
      assert.equal(r.code, 0, r.stderr);
      const s = GOLD.quick.summary;
      assert.ok(r.stdout.startsWith(`${s.views} views (${s.positions} cells x 4 directions, of which ${s.ghost_views} with ghost), deviations: 0`));
      assert.equal(sha(readFileSync(join(td, 'r.json'))), GOLD.quick.json);
      assert.equal(runCrawl(crawl01Cli, ['check', '--dir', DATA]).code, 2);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });
});
