// Parity with the Python reference: goldens from test/golden/mkgolden.py (docs/specs/P8-js-tools.md, section 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vrl from '../core/vrl.js';
import { PyRandom } from '../core/pyrandom.js';
import { decodeImage } from '../core/io/image.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const golden = (n) => JSON.parse(readFileSync(join(HERE, 'golden', n + '.json'), 'utf8'));
const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));

test('pyrandom = random.Random', () => {
  for (const g of golden('pyrandom')) {
    const r = new PyRandom(BigInt(g.seed));
    assert.deepEqual(Array.from({ length: 5 }, () => r.random()), g.random, g.seed);
    assert.deepEqual([1, 7, 31, 32, 33, 53].map((k) => r.getrandbits(k)), g.getrandbits, g.seed);
    assert.deepEqual([...Array.from({ length: 5 }, () => r.randrange(1000)), r.randrange(3, 50, 4), r.randrange(50, 3, -7)],
      g.randrange, g.seed);
    assert.deepEqual(Array.from({ length: 8 }, () => r.randint(-3, 3)), g.randint, g.seed);
    assert.deepEqual(Array.from({ length: 8 }, () => r.choice('abcdefgh')), g.choice, g.seed);
    const range = (n) => Array.from({ length: n }, (_, i) => i);
    assert.deepEqual([r.sample(range(30), 5), r.sample(range(10), 10), r.sample(range(1000), 8)], g.sample, g.seed);
    assert.equal(r.random(), g.after, g.seed);
  }
});

test('vrl encode = tools/vrl.py', () => {
  const g = golden('vrl');
  for (const c of g.encode) assert.equal(hex(vrl.encode(c.in)), c.out);
  for (const c of g.rect) assert.equal(hex(vrl.encodeRect(c.data, c.w, c.h, c.stride, c.mask)), c.out);
  for (const c of g.stats) {
    const st = vrl.stats(unhex(c.stream), c.T);
    assert.deepEqual({ ...st, ratio: null }, { ...c.stats, ratio: null });
    if (c.stats.ratio !== null) assert.ok(Math.abs(st.ratio - c.stats.ratio) < 1e-12);
  }
  for (const c of g.threshold) assert.equal(vrl.threshold(c.p), c.T);
});

test('images = Pillow convert("RGBA")', () => {
  for (const g of golden('images')) {
    const img = decodeImage(new Uint8Array(readFileSync(join(ROOT, g.path))), g.path);
    assert.deepEqual([img.width, img.height], g.size, g.path);
    assert.equal(createHash('sha256').update(img.rgba).digest('hex'), g.rgba_sha256, g.path);
  }
});
