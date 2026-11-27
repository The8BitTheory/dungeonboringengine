// Port of test/tools/test_crawlmap.py, plus parity with tools/crawlmap.py (golden/crawl/crawl.json, mkgolden_crawl.py).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as crawlmap from '../core/crawl/crawlmap.js';
import * as dbemap from '../core/map.js';
import { MapError } from '../core/map.js';
import { mapCli } from '../cli/map.js';
import { crawlmapCli, runCrawl } from '../cli/crawl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const CRAWL = join(ROOT, 'test', 'tools', 'data', 'crawl128.cd1');
const D81 = '/home/martin/git/dungeoncrawlerjam2025/game/crawl.d81';
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'crawl', 'crawl.json'), 'utf8')).crawlmap;
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b) : b).digest('hex');
const hasC1541 = () => spawnSync('c1541', ['-version'], { encoding: 'utf8' }).error === undefined;

const readCrawl = () => new Uint8Array(readFileSync(CRAWL));

function synth(w, h, vals, records, { name = [0x54, 0x45, 0x53, 0x54], gems = 0 } = {}) {
  const os_ = 5 + 3 * records.length;
  const b = [0x3c, 0x21, os_, w, h, gems & 255, gems >> 8];
  for (const [ch, cell] of records) b.push(ch.charCodeAt(0), cell & 255, cell >> 8);
  return Uint8Array.from([...b, ...vals, ...name]);
}

function withTmp(fn) {
  const td = realpathSync(mkdtempSync(join(tmpdir(), 'crawlmap-')));
  try { return fn(td); } finally { rmSync(td, { recursive: true, force: true }); }
}
const evs = (m) => m.events.map((e) => [e.cell, e.type, e.param]);

describe('crawlmap (test_crawlmap.py)', () => {
  test('convert', () => {
    const data = readCrawl();
    assert.equal(data.length, 244);
    const { m, warn } = crawlmap.convert(data);
    assert.deepEqual(warn, []);
    assert.deepEqual([m.width, m.height, m.tiles.length, m.start, m.direction], [20, 11, 43, 198, 0]);
    for (const v of [0, 2, 4, 6, 18, 40]) {
      const t = m.tiles[v];
      assert.deepEqual([t.walls, t.floor, t.ceiling, t.flags], [[0, 0, 0, 0], 0, 0, 0]);
    }
    assert.equal(m.tiles[1].flags, 0x17);
    assert.deepEqual(m.tiles[1].walls, [1, 1, 1, 1]);
    assert.deepEqual(m.cells, Array.from(data.subarray(2 + 14, 2 + 14 + 220)));
    assert.equal(m.content.filter((c) => c === 2).length, 92);
    assert.equal(m.content.filter((c) => c === 4).length, 2);
    assert.equal(m.content.filter((c) => c).length, 94);
    assert.deepEqual(evs(m), [[29, 3, 0], [68, 1, 1]]);
    assert.equal(m.outside, 1);
    assert.deepEqual([m.tiles[42].flags, m.tiles[41].flags], [0, 0x17]);
  });

  test('floor ceiling', () => {
    const { m } = crawlmap.convert(readCrawl(), { floor: 3, ceiling: 4 });
    assert.deepEqual([m.tiles[0].floor, m.tiles[0].ceiling], [3, 4]);
    assert.deepEqual([m.tiles[1].floor, m.tiles[1].ceiling], [0, 0]);
  });

  test('items', () => {
    const { m } = crawlmap.convert(readCrawl(), { items: [4] });
    assert.equal(m.content.filter((c) => c).length, 2);
  });

  test('toml build identical', () => withTmp((td) => {
    const { m } = crawlmap.convert(readCrawl());
    const direct = dbemap.toDmp(m);
    const [dmp, tml, dmp2] = ['a.dmp', 'a.toml', 'b.dmp'].map((n) => join(td, n));
    assert.equal(runCrawl(crawlmapCli, [CRAWL, dmp, '--toml', tml]).code, 0);
    mapCli(['build', tml, dmp2], { out: () => {}, err: () => {} });
    assert.deepEqual(new Uint8Array(readFileSync(dmp)), direct);
    assert.deepEqual(new Uint8Array(readFileSync(dmp2)), direct);
  }));

  test('synthetic', () => {
    const { m, warn } = crawlmap.convert(synth(3, 2, [1, 0, 6, 8, 8, 42], [['6', 2], ['8', 3], ['8', 4], ['Z', 5], ['Q', 0]]));
    assert.deepEqual(evs(m), [[0, 255, 81], [3, 2, 1], [4, 2, 1], [5, 3, 1]]);
    assert.equal(warn.length, 1);
    assert.ok(warn[0].includes("'Q'"));
    assert.equal(m.start, 2);
    assert.equal(m.tiles.length, 43);
  });

  test('duplicate records', () => {
    assert.throws(() => crawlmap.convert(synth(2, 1, [0, 0], [['6', 0], ['6', 1]])), (e) => e instanceof MapError && /'6'.*repeated/.test(e.message));
    assert.throws(() => crawlmap.convert(synth(3, 1, [8, 8, 8], [['6', 0], ['8', 0], ['8', 1], ['8', 2]])), /two/);
    const { warn } = crawlmap.convert(synth(2, 1, [0, 0], [['6', 0], ['X', 0], ['X', 1]]));
    assert.equal(warn.length, 1);
    assert.ok(warn[0].includes("'X' repeated"));
  });

  test('missing start', () => {
    assert.throws(() => crawlmap.convert(synth(2, 1, [0, 0], [['8', 0]])), /'6'/);
  });

  test('record out of range', () => {
    assert.throws(() => crawlmap.convert(synth(2, 1, [0, 0], [['6', 2]])), /cell 2/);
  });

  test('gem warning and name', () => {
    const { warn } = crawlmap.convert(synth(2, 1, [2, 0], [['6', 1]], { name: [0xff], gems: 5 }));
    assert.equal(warn.length, 2);
  });

  test('cli warning', () => withTmp((td) => {
    const src = join(td, 's.cd1'), out = join(td, 's.dmp');
    writeFileSync(src, synth(2, 1, [0, 0], [['6', 1], ['Q', 0]]));
    const r = runCrawl(crawlmapCli, [src, out]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes('Warning'));
  }));

  test('legend limit', () => {
    const { m } = crawlmap.convert(synth(2, 1, [80, 6], [['6', 1]]));
    assert.throws(() => crawlmap.legendFor(m), /78/);
  });

  test('d81', { skip: !(hasC1541() && existsSync(D81)) && 'c1541 or image missing' }, () => withTmp((td) => {
    const out = join(td, 'd.dmp');
    assert.equal(runCrawl(crawlmapCli, ['--d81', D81, out]).code, 0);
    const { m } = crawlmap.convert(readCrawl());
    assert.deepEqual(new Uint8Array(readFileSync(out)), dbemap.toDmp(m));
  }));
});

const SYNTH = {
  basic: [3, 2, [1, 0, 6, 8, 8, 42], [['6', 2], ['8', 3], ['8', 4], ['Z', 5], ['Q', 0]]],
  dup6: [2, 1, [0, 0], [['6', 0], ['6', 1]]],
  three8: [3, 1, [8, 8, 8], [['6', 0], ['8', 0], ['8', 1], ['8', 2]]],
  dupX: [2, 1, [0, 0], [['6', 0], ['X', 0], ['X', 1]]],
  nostart: [2, 1, [0, 0], [['8', 0]]],
  range: [2, 1, [0, 0], [['6', 2]]],
  gemname: [2, 1, [2, 0], [['6', 1]], { name: [0xff], gems: 5 }],
  legend80: [2, 1, [80, 6], [['6', 1]]],
  quote: [2, 1, [0, 0], [['6', 1], ["'", 0], ['\x01', 1]]],
};

describe('crawlmap parity (golden/crawl/crawl.json)', () => {
  test('conversions of crawl128.cd1', () => {
    for (const [k, opt] of [['default', {}], ['floor_ceiling', { floor: 3, ceiling: 4 }], ['items4', { items: [4] }]]) {
      const { m, warn } = crawlmap.convert(readCrawl(), opt);
      assert.deepEqual({ dmp: sha(dbemap.toDmp(m)), toml: sha(dbemap.toToml(m, crawlmap.legendFor(m))), warn }, GOLD[k], k);
    }
  });

  test('synthetic maps', () => {
    for (const [k, args] of Object.entries(SYNTH)) {
      let got;
      try {
        const { m, warn } = crawlmap.convert(synth(...args));
        got = { warn, dmp: sha(dbemap.toDmp(m)), events: evs(m), start: m.start, nt: m.tiles.length, name: m.name };
        try { got.toml = sha(dbemap.toToml(m, crawlmap.legendFor(m))); } catch (e) { got.legend_error = e.message; }
      } catch (e) {
        if (!(e instanceof MapError)) throw e;
        got = { error: e.message };
      }
      assert.deepEqual(got, GOLD.synth[k], k);
    }
  });

  test('CLI', () => withTmp((td) => {
    const norm = (s) => s.split(td).join('/T').split(ROOT).join('<ROOT>');
    const chk = (k, argv, out = null) => {
      const r = runCrawl(crawlmapCli, argv);
      const g = GOLD.cli[k];
      assert.deepEqual([r.code, norm(r.stdout), norm(r.stderr)], [g.code, g.stdout, g.stderr], k);
      if (g.dmp) assert.equal(sha(readFileSync(out)), g.dmp, k);
    };
    chk('toml', [CRAWL, join(td, 'a.dmp'), '--toml', join(td, 'a.toml')], join(td, 'a.dmp'));
    assert.equal(sha(readFileSync(join(td, 'a.toml'))), GOLD.cli.toml.toml);
    writeFileSync(join(td, 's.cd1'), synth(2, 1, [0, 0], [['6', 1], ['Q', 0]]));
    chk('warning', [join(td, 's.cd1'), join(td, 's.dmp')]);
    const variants = {
      load_dollar: ['--load', '$5000'], load_bad: ['--load', 'zz'], items_bad: ['--items', '2,x'], items_range: ['--items', '0'],
      floor_range: ['--floor', '300'], load_bank1: ['--load', '0x5F00'], items_floor: ['--items', '4', '--floor', '2', '--ceiling', '3'],
    };
    for (const [k, extra] of Object.entries(variants)) chk(k, [CRAWL, join(td, `${k}.dmp`), ...extra], join(td, `${k}.dmp`));
    chk('missing', [join(td, 'nothere.cd1'), join(td, 'x.dmp')]);
  }));

  test('usage errors', () => {
    assert.equal(runCrawl(crawlmapCli, []).code, 2);
    assert.equal(runCrawl(crawlmapCli, ['a.cd1']).code, 2);
    assert.equal(runCrawl(crawlmapCli, ['--d81', 'x.d81', 'a', 'b']).code, 2);
    assert.equal(runCrawl(crawlmapCli, ['a', 'b', '--floor', 'x']).code, 2);
  });
});
