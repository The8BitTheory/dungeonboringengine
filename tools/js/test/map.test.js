// Port of test/tools/test_dbemap.py.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dbemap from '../core/map.js';
import { Event, Map, Tile } from '../core/map.js';
import { PyRandom } from '../core/pyrandom.js';
import { mapCli } from '../cli/map.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DEMO = join(ROOT, 'docs', 'specs', 'examples', 'demo.toml');
const CRAWL_DMP = join(HERE, 'golden', 'view', 'maps', 'crawl_cd1.dmp');   // crawlmap.convert(crawl128.cd1), fixture

const BASE = `
[map]
start = [1, 1]
dir = "N"
outside = "w"
[tiles.w]
walls = 1
flags = ["solid"]
[tiles.g]
floor = 1
[legend]
"#" = "w"
"." = "g"
[layers]
tiles = """
###
#.#
###
"""
`;

const load = (text) => dbemap.loadsToml(text, 't.toml');
const loadToml = (p) => dbemap.loadsToml(readFileSync(p), p);
const hx = (s) => Uint8Array.from(s.split(' '), (b) => parseInt(b, 16));
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const throwsRe = (fn, re) => assert.throws(fn, (e) => e instanceof dbemap.MapError && re.test(e.message));

function cli(argv) {
  try {
    mapCli(argv, { out: () => {}, err: () => {} });
    return 0;
  } catch (e) {
    if (e.usage) return 2;
    if (e instanceof dbemap.MapError || e.code === 'ENOENT') return 1;
    throw e;
  }
}

describe('TestBuild', () => {
  test('test_demo', () => {
    const m = loadToml(DEMO);
    const d = dbemap.toDmp(m);
    assert.deepEqual(Array.from(d.subarray(0, 2)), [0x00, 0x40]);
    const b = d.subarray(2);
    assert.deepEqual([m.width, m.height, m.tiles.length, m.events.length], [7, 5, 4, 3]);
    assert.deepEqual(b.subarray(0, 5), Uint8Array.from([0x44, 0x4D, 1, 7, 5]));
    assert.equal(b[5], 4);
    assert.equal(u16(b, 6), 3);
    assert.equal(m.start, 9);
    assert.equal(m.direction, 1);
    assert.deepEqual([12, 14, 16, 18, 20].map((i) => u16(b, i)), [24, 59, 94, 126, 138]);
    assert.equal(b.length, 138);
    assert.equal(m.cells[1 * 7 + 3], 1);
    assert.equal(m.content[1 * 7 + 3], 2);
    assert.equal(m.content[1 * 7 + 1], 0x80);
    assert.deepEqual(b.subarray(94, 102), hx('01 01 01 01 00 00 17 00'));
    assert.deepEqual(b.subarray(118, 126), hx('02 02 02 02 01 01 01 23'));
    assert.deepEqual(m.events.map((e) => [e.cell, e.type, e.param]), [[10, 1, 1], [22, 2, 1], [26, 3, 0]]);
  });

  test('test_load_address', () => {
    const d = dbemap.toDmp(loadToml(DEMO), 0x4000);
    assert.deepEqual(Array.from(d.subarray(0, 2)), [0x00, 0x40]);
  });

  test('test_roundtrip_binary', () => {
    const m = loadToml(DEMO);
    assert.ok(dbemap.fromDmp(dbemap.toDmp(m)).equals(m));
  });

  test('test_roundtrip_toml_demo_and_crawl', () => {
    const cm = dbemap.fromDmp(new Uint8Array(readFileSync(CRAWL_DMP)));
    for (const m of [loadToml(DEMO), cm]) {
      const d = dbemap.toDmp(m);
      const m2 = dbemap.fromDmp(d);
      const d2 = dbemap.toDmp(dbemap.loadsToml(dbemap.toToml(m2), 'x'));
      assert.deepEqual(d, d2);
    }
  });

  test('test_roundtrip_random', () => {
    const rnd = new PyRandom(12345);
    for (let it = 0; it < 50; it++) {
      const w = rnd.randint(1, 40), h = rnd.randint(1, 40);
      const nt = rnd.randint(1, 12);
      const tiles = [];
      for (let i = 0; i < nt; i++) {
        const fl = i === 0 ? 0 : rnd.randint(0, 63);
        const walls = [0, 1, 2, 3].map(() => rnd.randint(0, 255));
        const f = rnd.randint(0, 255), c = rnd.randint(0, 255);
        tiles.push(new Tile(walls, f, c, fl, rnd.randint(0, 255)));
      }
      const cells = Array.from({ length: w * h }, () => rnd.randrange(nt));
      cells[0] = 0;
      const content = Array.from({ length: w * h }, () => rnd.choice([0, 0, 1, 2, 3, 4, 5]));
      for (let i = 0; i < w * h; i++) if (rnd.random() < 0.1) content[i] |= rnd.choice([0x80, 0x40, 0xC0]);
      const ne = rnd.randint(0, 20);
      const events = Array.from({ length: ne }, () => {
        const cell = rnd.randrange(w * h), t = rnd.randint(1, 255);
        return new Event(cell, t, rnd.randint(0, 255));
      });
      const dir = rnd.randint(0, 3);
      const m = new Map('r', w, h, tiles, cells, content, events, 0, dir, rnd.randrange(nt));
      const d = dbemap.toDmp(m);
      const m2 = dbemap.fromDmp(d);
      assert.deepEqual(m2.events.map((e) => [e.cell, e.type, e.param]),
        dbemap.sortEvents(events).map((e) => [e.cell, e.type, e.param]));
      assert.deepEqual(dbemap.toDmp(dbemap.loadsToml(dbemap.toToml(m2), 'x')), d);
    }
  });

  test('test_too_many_legend_pairs', () => {
    const nt = 20;
    const tiles = Array.from({ length: nt }, () => new Tile([0, 0, 0, 0], 0, 0, 0, 0));
    const cells = Array.from({ length: nt * 5 }, (_, i) => i % nt);
    const content = Array.from({ length: nt * 5 }, (_, i) => Math.floor(i / nt));
    const m = new Map('', nt * 5, 1, tiles, cells, content, [], 0, 0, 0);
    throwsRe(() => dbemap.toToml(m), /too many combinations/);
  });

  test('test_toml_escape', () => {
    const m = loadToml(DEMO);
    m.name = 'a"b\\c';
    assert.equal(dbemap.loadsToml(dbemap.toToml(m), 'x').name, 'a"b\\c');
  });

  test('test_index_gaps', () => {
    const t = BASE.replace('[tiles.w]', '[tiles.w]\nindex = 3').replace('[tiles.g]', '[tiles.g]\nindex = 1');
    const m = load(t);
    assert.equal(m.tiles.length, 4);
    assert.ok(m.tiles[0].equals(dbemap.nullTile()));
    assert.deepEqual(m.cells, [3, 3, 3, 3, 1, 3, 3, 3, 3]);
    assert.equal(m.outside, 3);
  });

  test('test_file_and_cli', () => {
    const td = mkdtempSync(join(tmpdir(), 'dbemap-'));
    try {
      const out = join(td, 'o.dmp');
      assert.equal(cli(['build', DEMO, out]), 0);
      assert.deepEqual(new Uint8Array(readFileSync(out)), dbemap.toDmp(loadToml(DEMO)));
      const tml = join(td, 'o.toml');
      assert.equal(cli(['dump', out, '--toml', tml]), 0);
      const out2 = join(td, 'o2.dmp');
      assert.equal(cli(['build', tml, out2]), 0);
      assert.deepEqual(readFileSync(out), readFileSync(out2));
      assert.equal(cli(['check', DEMO]), 0);
      assert.equal(cli(['dump', out]), 0);
      const bad = join(td, 'bad.toml');
      writeFileSync(bad, BASE.replace('#.#', '#q#'));
      assert.equal(cli(['check', bad]), 1);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('TestErrors', () => {
  const fails = (text, re) => throwsRe(() => load(text), re);

  test('test_ok_base', () => { assert.equal(load(BASE).width, 3); });
  test('test_unknown_char', () => {
    fails(BASE.replace('#.#', '#q#'), /t\.toml: map row 2, column 2: character 'q' not in the legend/);
  });
  test('test_row_length', () => { fails(BASE.replace('#.#', '#.##'), /row 2: length 4 instead of 3/); });
  test('test_start_on_weg', () => { fails(BASE.replace('[1, 1]', '[0, 0]'), /SOLID/); });
  test('test_item_64', () => { fails(BASE.replace('"." = "g"', '"." = { tile = "g", item = 64 }'), /item/); });
  test('test_style_256', () => { fails(BASE.replace('floor = 1', 'floor = 256'), /floor/); });
  test('test_unknown_flag', () => { fails(BASE.replace('["solid"]', '["solid", "foo"]'), /unknown flag 'foo'/); });

  test('test_flag_inhalt', () => {
    const m = load(BASE.replace('["solid"]', '["solid", "content"]'));
    assert.equal(m.tiles[0].flags, 1 | 32);
    assert.equal(dbemap.FLAGS.content, 32);
    assert.deepEqual(dbemap.warningsFor(m), []);
    const d = dbemap.toDmp(m);
    const m2 = dbemap.fromDmp(d);
    assert.equal(m2.tiles[0].flags, 33);
    assert.deepEqual(dbemap.toDmp(dbemap.loadsToml(dbemap.toToml(m2), 'x')), d);
    assert.ok(dbemap.toToml(m2).includes('"content"'));
    assert.ok(dbemap.describe(m2).includes('content'));
  });

  test('test_flag_inhalt_without_faces_warns', () => {
    const m = load(BASE.replace('floor = 1', 'floor = 1\nflags = ["content"]'));
    assert.ok(dbemap.warningsFor(m).some((w) => w.includes('content')));
  });

  test('test_reserved_flag_bits', () => {
    const m = load(BASE);
    m.tiles[0].flags = 128;
    throwsRe(() => dbemap.validate(m), /flags/);
    m.tiles[0].flags = 1;
    const d = dbemap.toDmp(m);
    d[2 + 24 + 2 * 9 + 6] = 0x80;          // flags of tile 0 (after tile and content plane)
    throwsRe(() => dbemap.fromDmp(d), /flag bit 7/);
  });

  test('test_flag_fern', () => {            // bit 6 (P6 5.7a): TOML round trip and DMP
    const m = load(BASE.replace('floor = 1', 'floor = 1\nflags = ["distant"]'));
    assert.deepEqual(m.tiles.filter((t) => t.name === 'g').map((t) => t.flags), [0x40]);
    dbemap.validate(m);
    const m2 = dbemap.fromDmp(dbemap.toDmp(m));
    assert.deepEqual(m2.tiles.map((t) => t.flags), m.tiles.map((t) => t.flags));
    assert.ok(dbemap.toToml(m).includes('"distant"'));
  });

  test('test_unknown_event_type', () => {
    fails(BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ type = "xyz" }] }'), /unknown event type 'xyz'/);
  });
  test('test_width_256', () => { fails(BASE.replace('###\n#.#\n###', '#'.repeat(256)), /width\/height/); });
  test('test_too_large', () => {
    fails(BASE.replace('###\n#.#\n###', new Array(100).fill('#'.repeat(200)).join('\n')), /16384/);
  });
  test('test_trailing_space', () => { fails(BASE.replace('#.#\n', '#.# \n'), /row 2, column 4: trailing whitespace/); });
  test('test_index_partial', () => { fails(BASE.replace('[tiles.w]', '[tiles.w]\nindex = 0'), /index/); });
  test('test_unknown_key', () => {
    fails(BASE.replace('floor = 1', 'flor = 1'), /flor/);
    fails(BASE.replace('dir = "N"', 'dir = "N"\nstrat = [1, 1]'), /map: unknown key 'strat'/);
    fails('titel = 1\n' + BASE, /unknown key 'titel'/);
    fails(BASE + 'walls = 1\n', /layers: unknown key 'walls'/);
  });
});

describe('TestFaceSubpos', () => {
  test('test_face', () => {
    for (let v = 0; v < 4; v++) {
      assert.equal(dbemap.face(v, 0, true), (v + 2) % 4);
      assert.equal(dbemap.face(v, -1, false), (v + 1) % 4);
      assert.equal(dbemap.face(v, 1, false), (v + 3) % 4);
    }
    assert.equal(dbemap.face(0, 0, true), 2);
    assert.equal(dbemap.face(0, -2, false), 1);
    assert.equal(dbemap.face(2, 3, false), 1);
  });

  test('test_subpos_permutation', () => {
    for (const row of dbemap.SUBPOS_VIEW) {
      assert.deepEqual(row.slice().sort(), [0, 1, 2, 3, 4]);
      assert.equal(row[4], 2);
    }
  });

  test('test_subpos_rotation', () => {
    const corners = { 0: [-1, -1], 1: [1, -1], 2: [-1, 1], 3: [1, 1] };
    const fwd = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const right = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let v = 0; v < 4; v++) {
      for (const [q, [cx, cy]] of Object.entries(corners)) {
        const f = cx * fwd[v][0] + cy * fwd[v][1];
        const r = cx * right[v][0] + cy * right[v][1];
        const back = f > 0, left = r < 0;
        const p = back ? (left ? 0 : 1) : (left ? 3 : 4);
        assert.equal(dbemap.SUBPOS_VIEW[v][q], p, `${v} ${q}`);
      }
    }
  });
});

describe('TestFromDmp', () => {
  const mk = () => dbemap.toDmp(loadToml(DEMO));
  const bad = (d, re) => throwsRe(() => dbemap.fromDmp(d), re);
  test('test_magic', () => { const d = mk(); d[2] = 'X'.charCodeAt(0); bad(d, /magic/); });
  test('test_version', () => { const d = mk(); d[4] = 2; bad(d, /Version/); });
  test('test_short', () => { bad(mk().slice(0, -1), /too short/); });
  test('test_tile_index', () => { const d = mk(); d[2 + 24] = 4; bad(d, /tile index/); });
  test('test_start', () => { const d = mk(); d[2 + 8] = 35; bad(d, /start cell/); });
});
