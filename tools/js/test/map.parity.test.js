// Parity of core/map.js with tools/dbemap.py: goldens from test/golden/mkgolden_view.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dbemap from '../core/map.js';
import { PyRandom } from '../core/pyrandom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const G = JSON.parse(readFileSync(join(HERE, 'golden', 'map.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).digest('hex');
const fixture = (n) => new Uint8Array(readFileSync(join(HERE, 'golden', 'view', n)));
const errOf = (fn) => { try { fn(); } catch (e) { if (e instanceof dbemap.MapError) return e.message; throw e; } return null; };

test('example maps: DMP, TOML, describe, warnings', () => {
  for (const [name, g] of Object.entries(G.maps)) {
    if (!g.path) continue;
    const m = dbemap.loadsToml(readFileSync(join(ROOT, g.path)), g.path);
    const d = dbemap.toDmp(m);
    assert.equal(sha(d), g.dmp_sha, name);
    assert.equal(sha(dbemap.toToml(dbemap.fromDmp(d))), g.toml_sha, name);
    assert.equal(sha(dbemap.describe(m)), g.describe_sha, name);
    assert.deepEqual(dbemap.warningsFor(m), g.warnings, name);
    assert.equal(m.name, g.name);
  }
});

test('Crawl 128 map (crawlmap.convert) round trip', () => {
  const d = fixture('maps/crawl_cd1.dmp');
  assert.equal(sha(d), G.maps.crawl_cd1.dmp_sha);
  const t = dbemap.toToml(dbemap.fromDmp(d));
  assert.equal(sha(t), G.maps.crawl_cd1.toml_sha);
  assert.deepEqual(dbemap.toDmp(dbemap.loadsToml(t, 'x')), d);
});

test('TOML error messages', () => {
  for (const c of G.toml_errors) assert.equal(errOf(() => dbemap.loadsToml(c.toml, 't.toml')), c.error, c.toml);
});

test('DMP error messages', () => {
  for (const c of G.dmp_errors) {
    assert.equal(errOf(() => dbemap.fromDmp(Uint8Array.from(Buffer.from(c.dmp, 'hex')))), c.error);
  }
});

test('random round trips (generator of test_roundtrip_random)', () => {
  const rnd = new PyRandom(12345);
  for (const g of G.random) {
    const w = rnd.randint(1, 40), h = rnd.randint(1, 40);
    const nt = rnd.randint(1, 12);
    const tiles = [];
    for (let i = 0; i < nt; i++) {
      const fl = i === 0 ? 0 : rnd.randint(0, 63);
      const walls = [0, 1, 2, 3].map(() => rnd.randint(0, 255));
      const f = rnd.randint(0, 255), c = rnd.randint(0, 255);
      tiles.push(new dbemap.Tile(walls, f, c, fl, rnd.randint(0, 255)));
    }
    const cells = Array.from({ length: w * h }, () => rnd.randrange(nt));
    cells[0] = 0;
    const content = Array.from({ length: w * h }, () => rnd.choice([0, 0, 1, 2, 3, 4, 5]));
    for (let i = 0; i < w * h; i++) if (rnd.random() < 0.1) content[i] |= rnd.choice([0x80, 0x40, 0xC0]);
    const ne = rnd.randint(0, 20);
    const events = Array.from({ length: ne }, () => {
      const cell = rnd.randrange(w * h), t = rnd.randint(1, 255);
      return new dbemap.Event(cell, t, rnd.randint(0, 255));
    });
    const dir = rnd.randint(0, 3);
    const m = new dbemap.Map('r', w, h, tiles, cells, content, events, 0, dir, rnd.randrange(nt));
    const d = dbemap.toDmp(m);
    assert.equal(sha(d), g.dmp_sha);
    assert.equal(sha(dbemap.toToml(dbemap.fromDmp(d))), g.toml_sha);
  }
});
