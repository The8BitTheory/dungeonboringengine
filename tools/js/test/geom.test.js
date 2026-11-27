// Port of test/tools/test_dbegeom.py (docs/specs/P3-geometry.md, section 10).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../core/geom.js';
import { decodePng } from '../core/io/png.js';
import { inflate } from '../core/io/inflate.js';
import { geomCli } from '../cli/geom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const { ART_FRONT, ART_SIDE, ART_FLOOR, ART_CEIL } = G;

const CUSTOM = {
  viewport: { preset: 'custom', width_px: 120, height: 80, depth: 2 },
  planes: { ref_size: [176, 120], center_x: 88, width: [200, 110, 60, 30], top: [-10, 10, 25, 35], bottom: [140, 100, 70, 55] },
};
const withPlanes = (p) => ({ viewport: { ...CUSTOM.viewport }, planes: { ...CUSTOM.planes, ...p } });

const confFor = (w, h, preset = 'westwood') => G.parseConfig({ viewport: { preset, width_px: w, height: h } });

const cache = new Map();
function cached(k, f) { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); }
const geoFor = (w, h) => cached(`${w}x${h}`, () => new G.Geometry(confFor(w, h)));
const customGeo = () => cached('custom', () => new G.Geometry(G.parseConfig(CUSTOM)));
// width_px is limited to 160; 176 x 120 only directly via the geometry (without width validation)
const geo176 = () => cached('176', () => new G.Geometry({ ...confFor(160, 100), width: 176, height: 120 }));
const allGeos = () => [geoFor(140, 96), geoFor(136, 92), geo176(), customGeo()];

const elem = (geo, art, d, s) => geo.images.find((i) => i.art === art && i.d === d && i.s === s) ?? null;
const isGeomError = (re) => (e) => e instanceof G.GeomError && (!re || re.test(e.message));

/** In-process CLI with the exit codes of dbegeom.py: 0 ok, 1 validation error, 2 usage. */
function runCli(...args) {
  const out = [], err = [];
  let code = 0;
  try {
    geomCli(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  } catch (e) {
    if (e.usage) code = 2;
    else if (e instanceof G.GeomError || e.code === 'ENOENT') code = 1;
    else throw e;
    err.push(`Error: ${e.message}`);
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const s8 = (v) => (v > 127 ? v - 256 : v);

// independent table-driven CRC-CCITT (binascii.crc_hqx)
const HQX = Array.from({ length: 256 }, (_, n) => {
  let c = n << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  return c;
});
function crcHqx(data, crc) {
  for (const b of data) crc = ((crc << 8) & 0xFF00) ^ HQX[((crc >> 8) ^ b) & 0xFF];
  return crc;
}

describe('FixedValues', () => {
  test('planes 140', () => {
    const g = geoFor(140, 96);
    assert.deepEqual(g.Wp, [164, 100, 64, 40, 24]);
    assert.deepEqual(g.T, [-13, 6, 13, 19, 22]);
    assert.deepEqual(g.B, [115, 83, 64, 51, 45]);
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => g.X(k, -0.5).trunc()), [-12, 20, 38, 50, 58]);
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => g.X(k, 0.5).trunc()), [152, 120, 102, 90, 82]);
  });

  test('planes 136', () => {
    const g = geoFor(136, 92);
    assert.deepEqual(g.Wp, [160, 100, 60, 36, 24]);
    assert.deepEqual(g.T, [-12, 6, 12, 18, 21]);
    assert.deepEqual(g.B, [110, 80, 61, 49, 43]);
  });

  test('planes 176', () => {
    const g = geo176();
    assert.deepEqual(g.Wp, [208, 128, 80, 48, 32]);
    assert.deepEqual(g.T, [-16, 8, 16, 24, 28]);
    assert.deepEqual(g.B, [144, 104, 80, 64, 56]);
  });

  test('bands 140', () => {
    const g = geoFor(140, 96);
    assert.deepEqual(g.bandRows, [[[0, 6], [83, 96]], [[6, 13], [64, 83]], [[13, 19], [51, 64]], [[19, 22], [45, 51]]]);
    assert.deepEqual(g.horizon, [22, 45]);
  });

  test('fronts 140', () => {
    const g = geoFor(140, 96);
    const table = [[1, -1, 0, 6, 10, 77, 40], [1, 0, 10, 6, 50, 77, 0], [1, 1, 60, 6, 10, 77, 0],
      [2, -1, 0, 13, 19, 51, 13], [2, 0, 19, 13, 32, 51, 0], [2, 1, 51, 13, 19, 51, 0],
      [3, -2, 0, 19, 5, 32, 15], [3, -1, 5, 19, 20, 32, 0], [3, 0, 25, 19, 20, 32, 0],
      [3, 1, 45, 19, 20, 32, 0], [3, 2, 65, 19, 5, 32, 0]];
    assert.equal(g.images.filter((i) => i.art === ART_FRONT).length, 11);
    for (const [d, s, x, y, w, h, sd] of table) {
      const im = elem(g, ART_FRONT, d, s);
      assert.deepEqual(im.rect, [x, y, w, h], `${d} ${s}`);
      assert.equal(im.srcDx, sd, `${d} ${s}`);
      assert.deepEqual(im.kernel, [0, 0, w, h], `${d} ${s}`);
      assert.deepEqual(im.cover, [x, x + w], `${d} ${s}`);
    }
  });

  test('sides 140', () => {
    const g = geoFor(140, 96);
    const table = [[0, -1, [0, 0, 10, 96], [0, 10]], [0, 1, [60, 0, 10, 96], [60, 70]],
      [1, -1, [10, 6, 9, 76], [10, 19]], [1, 1, [51, 6, 9, 76], [51, 60]],
      [2, -1, [19, 13, 6, 50], [19, 25]], [2, 1, [45, 13, 6, 50], [45, 51]],
      [2, -2, [0, 17, 5, 37], [0, 5]], [2, 2, [65, 17, 5, 37], [65, 70]],
      [3, -1, [25, 19, 4, 32], [25, 29]], [3, 1, [41, 19, 4, 32], [41, 45]],
      [3, -2, [5, 19, 12, 32], [5, 17]], [3, 2, [53, 19, 12, 32], [53, 65]],
      [3, -3, [0, 21, 5, 25], [0, 5]], [3, 3, [65, 21, 5, 25], [65, 70]]];
    assert.equal(g.images.filter((i) => i.art === ART_SIDE).length, 14);
    for (const [d, s, rect, cov] of table) {
      const im = elem(g, ART_SIDE, d, s);
      assert.deepEqual(im.rect, rect, `${d} ${s}`);
      assert.deepEqual(im.cover, cov, `${d} ${s}`);
    }
  });

  test('counts', () => {
    const g = geoFor(140, 96);
    const n = (art) => g.images.filter((i) => i.art === art).length;
    assert.deepEqual([n(ART_FRONT), n(ART_SIDE), n(ART_FLOOR), n(ART_CEIL)], [11, 14, 18, 18]);
    assert.equal(g.elements.filter(G.isSlot).length, 18);
    assert.equal(g.elements.length, 79);
  });

  test('anchors 140', () => {
    const g = geoFor(140, 96);
    const table = {
      '1,0': [[26, 67], [44, 67], [35, 71], [24, 76], [46, 76]],
      '2,0': [[29, 53], [40, 53], [35, 56], [28, 59], [42, 59]],
      '3,0': [[31, 46], [38, 46], [35, 47], [30, 49], [39, 49]],
      '2,-1': [[7, 53], [18, 53], [10, 56], [0, 59], [14, 59]],
      '0,0': [[21, 88], [49, 88], [35, 95], [17, 104], [52, 104]],
    };
    const slots = Object.fromEntries(g.elements.filter(G.isSlot).map((e) => [`${e.d},${e.s}`, e]));
    for (const [k, exp] of Object.entries(table)) {
      assert.deepEqual(slots[k].anchors.map(([ax, ay]) => [Math.floor(ax / 2), ay]), exp, k);
    }
  });

  test('budget 140 136', () => {
    let b = G.computeBudget(geoFor(140, 96));
    assert.equal(b.sum_front, 6122);
    assert.equal(b.wall_style, 11094);
    assert.equal(b.floor_bands, 3570);
    assert.equal(b.ceil_bands, 1540);
    b = G.computeBudget(geoFor(136, 92));
    assert.equal(b.sum_front, 5728);
    assert.equal(b.floor_bands, 3332);
    assert.equal(b.ceil_bands, 1428);
    assert.ok(Math.abs(b.wall_style / 10370 - 1) <= 0.03);
  });

  test('budget 176 plausible', () => {
    const b = G.computeBudget(geo176());
    assert.equal(b.sum_front, 9664);
    assert.ok(Math.abs(b.wall_style / 17252 - 1) <= 0.03);
  });
});

describe('Properties', () => {
  test('symmetry', () => {
    const flip = { L: 'R', R: 'L', '#': '#', '.': '.' };
    for (const g of allGeos()) {
      for (const im of g.images) {
        if (im.s <= 0) continue;
        const m = elem(g, im.art, im.d, -im.s);
        assert.ok(m, im.name);
        assert.equal(m.rect[0], g.VW - im.rect[0] - im.rect[2], im.name);
        assert.deepEqual([m.rect[1], m.rect[3]], [im.rect[1], im.rect[3]]);
        assert.equal(m.rect[2], im.rect[2]);
        assert.deepEqual(m.mask, im.mask.map((line) => [...line].reverse().map((c) => flip[c]).join('')), im.name);
      }
    }
  });

  test('kernel maximal', () => {
    for (const g of allGeos()) {
      for (const im of g.images) {
        const w = im.rect[2];
        const full = im.mask.map((line) => [...line].map((c) => c === '#'));
        const [kx, ky, kw, kh] = im.kernel;
        for (let r = ky; r < ky + kh; r++) for (let c = kx; c < kx + kw; c++) assert.ok(full[r][c], im.name);
        // independent: maximum rectangle via histogram per row (stack method)
        let best = 0, hist = new Array(w).fill(0);
        for (const row of full) {
          hist = hist.map((hh, i) => (row[i] ? hh + 1 : 0));
          const stack = [];
          hist.concat([0]).forEach((hh, i) => {
            let start = i;
            while (stack.length && stack[stack.length - 1][1] >= hh) {
              const [st, sh] = stack.pop();
              best = Math.max(best, sh * (i - st));
              start = st;
            }
            stack.push([start, hh]);
          });
        }
        assert.equal(kw * kh, best, im.name);
      }
    }
  });

  test('cover', () => {
    for (const g of allGeos()) {
      for (const im of g.images) {
        if (im.art !== ART_FRONT && im.art !== ART_SIDE) continue;
        const d = im.d;
        const r0 = Math.max(g.T[d + 1], 0), r1 = Math.min(g.B[d + 1], g.height);
        const [x, y, w, h] = im.rect;
        const colOk = (c) => {
          if (r1 <= r0) return false;
          for (let r = r0; r < r1; r++) if (!(y <= r && r < y + h && im.mask[r - y][c - x] === '#')) return false;
          return true;
        };
        const good = Array.from({ length: w }, (_, i) => colOk(x + i));
        const runs = [];
        for (let i = 0; i < w;) {
          if (good[i]) { let j = i; while (j < w && good[j]) j++; runs.push([j - i, i]); i = j; } else i++;
        }
        const [c0, c1] = im.cover;
        if (!runs.length) assert.deepEqual([c0, c1], [0, 0], im.name);
        else {
          assert.equal(c1 - c0, Math.max(...runs.map((r) => r[0])), im.name);
          for (let c = c0; c < c1; c++) assert.ok(good[c - x], im.name);
        }
        if (im.art === ART_FRONT) assert.deepEqual([c0, c1], [x, x + w]);
      }
    }
  });

  test('fronts width', () => {
    for (const g of allGeos()) {
      for (let d = 1; d <= g.D; d++) {
        const fw = Math.floor(g.Wp[d] / 2);
        for (const im of g.images.filter((i) => i.art === ART_FRONT && i.d === d)) {
          if (!(im.flags & G.FLAG_CLIPPED)) assert.equal(im.rect[2], fw, im.name);
          assert.ok(im.srcDx + im.rect[2] <= fw, im.name);
        }
      }
    }
  });

  test('mask in rect and window', () => {
    for (const g of allGeos()) {
      for (const im of g.images) {
        const [x, y, w, h] = im.rect;
        assert.equal(im.mask.length, h);
        assert.ok(im.mask.every((l) => l.length === w));
        assert.ok(x >= 0 && y >= 0 && x + w <= g.VW && y + h <= g.height, im.name);
        assert.ok(im.mask.some((l) => /[^.]/.test(l)));
        // rectangle tight: first/last row and column occupied
        assert.ok(/[^.]/.test(im.mask[0]) && /[^.]/.test(im.mask[im.mask.length - 1]));
        assert.ok(im.mask.some((l) => l[0] !== '.') && im.mask.some((l) => l[l.length - 1] !== '.'));
      }
    }
  });

  test('bands gapless', () => {
    for (const g of allGeos()) {
      const rows = [];
      for (const [[c0, c1], [f0, f1]] of g.bandRows) {
        for (let r = c0; r < c1; r++) rows.push(r);
        for (let r = f0; r < f1; r++) rows.push(r);
      }
      for (let r = g.horizon[0]; r < g.horizon[1]; r++) rows.push(r);
      assert.deepEqual(rows.sort((a, b) => a - b), Array.from({ length: g.height }, (_, i) => i));
    }
  });
});

describe('Dvg', () => {
  let res, js, raw;
  before(() => {
    res = G.generate(confFor(140, 96), 'west140');
    js = JSON.parse(res.files['west140.geom.json']);
    raw = res.files['west140.dvg'];
  });

  test('header', () => {
    assert.equal(u16(raw, 0), 0xE800);
    const c = raw.subarray(2);
    assert.deepEqual([...c.subarray(0, 3)], [0x44, 0x56, 1]);
    assert.deepEqual([c[3], c[4], c[5], c[6], c[7]], [70, 96, 3, 3, 79]);
    assert.deepEqual([u16(c, 8), u16(c, 10)], [80, 0]);
    assert.deepEqual([c[14], c[15], c[16], c[17]], [22, 45, 16, 8]);
    assert.deepEqual([u16(c, 18), u16(c, 20), u16(c, 22)], [24, 24 + 8 * 4, 24 + 32 + 16 * 79]);
    assert.equal(c.length, u16(c, 22));
  });

  test('geometry id', () => {
    const c = Uint8Array.from(raw.subarray(2));
    const gid = u16(c, 12);
    c[12] = c[13] = 0;
    c[10] = c[11] = 0;      // origin does not count toward the ID
    assert.equal(gid, crcHqx(c, 0xFFFF) || 1);
    assert.equal(js.geometry_id, gid);
  });

  test('geometry id ignores origin', () => {
    const a = new G.Geometry(confFor(140, 96));
    const b = new G.Geometry(G.parseConfig({ viewport: { preset: 'westwood', width_px: 140, height: 96, origin: 321 } }));
    for (const g of [a, b]) g.atlasSize = G.layoutAtlas(g);
    const ra = G.buildDvg(a), rb = G.buildDvg(b);
    assert.notDeepEqual(ra.content, rb.content);
    assert.equal(ra.gid, rb.gid);
  });

  test('deterministic', () => {
    const again = G.generate(confFor(140, 96), 'west140');
    for (const fn of ['west140.dvg', 'west140.geom.json', 'west140.aseprite', 'west140_atlas.png']) {
      assert.deepEqual(again.files[fn], res.files[fn], fn);
    }
  });

  test('tables match json', () => {
    const c = raw.subarray(2);
    for (let d = 0; d < 4; d++) {
      const e = c.subarray(24 + 8 * d, 32 + 8 * d);
      const [c0, c1] = js.bands[d].ceil, [f0, f1] = js.bands[d].floor;
      assert.deepEqual([...e.subarray(0, 4)], [c0, c1, f0, f1]);
      const idx = js.elements.map((el, i) => [el, i]).filter(([el]) => el.d === d).map(([, i]) => i);
      assert.deepEqual([e[4], e[5]], [idx[0], idx.length]);
      assert.deepEqual(idx, Array.from({ length: idx.length }, (_, i) => idx[0] + i));
      if (d) {
        const fr = js.elements.find((el) => el.name === `front_d${d}_s+0`);
        assert.deepEqual([e[6], e[7]], [Math.floor(js.planes[d].W / 2), fr.rect[0]]);
      } else assert.deepEqual([e[6], e[7]], [0, 0]);
    }
    const base = 24 + 32;
    const arts = { front: 0, side: 1, floor: 2, ceil: 3, obj: 4 };
    js.elements.forEach((el, i) => {
      const row = c.subarray(base + 16 * i, base + 16 * i + 16);
      assert.deepEqual([row[0], row[1]], [arts[el.art], el.d]);
      assert.equal(s8(row[2]), el.s);
      if (el.art === 'obj') {
        el.anchors.forEach((a, p) => {
          assert.equal(s8(row[4 + 2 * p]), Math.max(-128, Math.min(127, Math.floor(a.px[0] / 2))));
          assert.equal(row[5 + 2 * p], Math.min(255, a.px[1]));
          assert.deepEqual(a.byte, [row[4 + 2 * p] - 256 * (row[4 + 2 * p] > 127), row[5 + 2 * p]]);
        });
        assert.deepEqual([...row.subarray(14, 16)], [0, 0]);
        return;
      }
      assert.deepEqual([...row.subarray(4, 8)], el.rect);
      assert.deepEqual([...row.subarray(8, 12)], el.kernel);
      assert.deepEqual([...row.subarray(12, 14)], el.cover);
      assert.equal(row[14], el.src_dx);
      assert.equal(row[15], 0);
      let fl = 0;
      for (const [name, bit] of [['cover', 1], ['partial', 2], ['clipped', 4], ['bandcover', 8]]) if (el.flags.includes(name)) fl |= bit;
      assert.equal(row[3], fl);
    });
  });

  test('order', () => {
    const keys = js.elements.map((e) => {
      const s = e.s;
      const cellkey = s === 0 ? 0 : 2 * Math.abs(s) - (s < 0 ? 1 : 0);
      return [e.d, cellkey, ['front', 'side', 'floor', 'ceil', 'obj'].indexOf(e.art)];
    });
    const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
    assert.deepEqual(keys, keys.slice().sort(cmp));
    assert.equal(js.elements.length, 79);
  });

  test('json names and masks', () => {
    const names = js.elements.map((e) => e.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('front_d1_s-1'));
    assert.ok(names.includes('obj_d1_s+0'));
    const el = js.elements.find((e) => e.name === 'floor_d0_s+0');
    assert.deepEqual(el.rect, [3, 83, 64, 13]);
    assert.deepEqual(el.kernel, [7, 0, 50, 13]);
    assert.ok(el.flags.includes('clipped'));
    assert.deepEqual(el.polygon, [[20, 83], [120, 83], [152, 115], [-12, 115]]);   // order per spec 3.1
  });

  test('budget in json', () => {
    assert.equal(js.budget.wall_style, 11094);
    assert.ok('west140.budget.md' in res.files);
  });

  test('aseprite', () => {
    const a = res.files['west140.aseprite'];
    const [size, magic, frames, aw, ah, depth] = [u32(a, 0), u16(a, 4), u16(a, 6), u16(a, 8), u16(a, 10), u16(a, 12)];
    assert.deepEqual([size, magic, frames, depth], [a.length, 0xA5E0, 1, 8]);
    assert.equal(a[28], 16);
    assert.equal(u16(a, 32), 17);
    const [fsize, fmagic, old, nw] = [u32(a, 128), u16(a, 132), u16(a, 134), u32(a, 140)];
    assert.deepEqual([fmagic, fsize], [0xF1FA, a.length - 128]);
    assert.equal(old, nw);
    let pos = 144;
    const chunks = [];
    while (pos < a.length) {
      const sz = u32(a, pos), ct = u16(a, pos + 4);
      chunks.push([ct, a.subarray(pos + 6, pos + sz)]);
      pos += sz;
    }
    assert.equal(pos, a.length);
    assert.equal(chunks.reduce((s, [, d]) => s + 6 + d.length, 0), fsize - 16);
    assert.equal(chunks.length, nw);
    assert.equal(chunks.filter(([t]) => t === 0x2004).length, 2);
    const cels = chunks.filter(([t]) => t === 0x2005).map(([, d]) => d);
    assert.equal(cels.length, 2);
    for (const cel of cels) {
      assert.deepEqual([u16(cel, 16), u16(cel, 18)], [aw, ah]);
      assert.equal(u16(cel, 7), 2);
      assert.equal(inflate(cel.subarray(20)).length, aw * ah);
    }
    const pix0 = inflate(cels[0].subarray(20)), pix1 = inflate(cels[1].subarray(20));
    assert.deepEqual([...new Set(pix1)], [16]);
    assert.deepEqual([...new Set(pix0)].sort((x, y) => x - y), [1, 14, 16]);
    const slices = {};
    chunks.forEach(([t, d], i) => {
      if (t !== 0x2022) return;
      const nkeys = u32(d, 0), flags = u32(d, 4);
      const nl = u16(d, 12);
      const name = new TextDecoder().decode(d.subarray(14, 14 + nl));
      const k = d.subarray(14 + nl);
      const [frame, x, y, w, h] = [u32(k, 0), i32(k, 4), i32(k, 8), u32(k, 12), u32(k, 16)];
      const nine = flags & 1 ? [i32(k, 20), i32(k, 24), u32(k, 28), u32(k, 32)] : null;
      assert.deepEqual([nkeys, frame], [1, 0]);
      assert.equal(chunks[i + 1][0], 0x2020);
      slices[name] = [x, y, w, h, nine, chunks[i + 1][1]];
    });
    const expect = Object.fromEntries(js.elements.filter((e) => e.atlas).map((e) => [e.name, e]));
    for (const b of js.band_images) expect[b.name] = b;
    assert.deepEqual(Object.keys(slices).sort(), Object.keys(expect).sort());
    for (const [name, [x, y, w, h, nine, ud]] of Object.entries(slices)) {
      const e = expect[name];
      assert.deepEqual([x, y], e.atlas);
      assert.deepEqual([w, h], [e.rect[2] * 2, e.rect[3]]);
      if (e.kernel && e.kernel[2]) {
        const [kx, ky, kw, kh] = e.kernel;
        assert.deepEqual(nine, [kx * 2, ky, kw * 2, kh]);
      } else if (e.kernel) assert.equal(nine, null);
      const info = JSON.parse(new TextDecoder().decode(ud.subarray(6)));
      assert.equal(info.d, e.d);
    }
    // consistency: number of atlas images = all except partial fronts, object slots
    const nImgs = js.elements.filter((e) => e.atlas).length + js.band_images.length;
    assert.equal(Object.keys(slices).length, nImgs);
    assert.equal(js.elements.filter((e) => e.art === 'front' && e.atlas).length, 3);
  });

  test('png', () => {
    const atlas = decodePng(res.files['west140_atlas.png']);
    assert.equal(atlas.mode, 'RGBA');
    assert.deepEqual([atlas.width, atlas.height], js.atlas_size);
    assert.ok(atlas.width >= 148);
    // alpha 0 exactly outside the mask
    const inside = new Set();
    for (const e of js.elements.concat(js.band_images)) {
      if (!e.atlas) continue;
      const [ax, ay] = e.atlas;
      const mask = e.mask ?? new Array(e.rect[3]).fill('#'.repeat(e.rect[2]));
      mask.forEach((line, r) => [...line].forEach((ch, c) => {
        if ('#L'.includes(ch)) inside.add(`${ax + 2 * c},${ay + r}`);
        if ('#R'.includes(ch)) inside.add(`${ax + 2 * c + 1},${ay + r}`);
      }));
    }
    for (let y = 0; y < atlas.height; y++) {
      for (let x = 0; x < atlas.width; x++) {
        const alpha = atlas.rgba[(y * atlas.width + x) * 4 + 3];
        if ((alpha !== 0) !== inside.has(`${x},${y}`)) assert.fail(`${x},${y}`);
      }
    }
    const size = (n) => { const p = decodePng(res.files[n]); return [p.width, p.height]; };
    assert.deepEqual(size('west140_view.png'), [140 * 4, 96 * 4]);
    assert.deepEqual(size('tpl/side_d1_s-1.png'), [9 * 2 * 4, 76 * 4]);
    assert.deepEqual(size('tpl/front_d1_s+0.png'), [100 * 4, 77 * 4]);
    assert.ok(!('tpl/front_d1_s-1.png' in res.files));
  });
});

describe('Validation', () => {
  let tmp;
  before(() => { tmp = mkdtempSync(join(tmpdir(), 'geom-')); });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('width 138', () => {
    const r = runCli('--preset', 'westwood', '--width', '138', '--height', '96', '--out', tmp);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /width_px/);
  });

  test('stride 60', () => {
    const r = runCli('--preset', 'westwood', '--width', '140', '--height', '96', '--stride', '60', '--out', tmp);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /stride/);
  });

  test('custom not falling', () => {
    assert.throws(() => G.parseConfig(withPlanes({ width: [200, 110, 110, 30] })), isGeomError());
    const p = join(tmp, 'view.toml');
    writeFileSync(p, '[viewport]\npreset="custom"\nwidth_px=120\nheight=80\n[planes]\nref_size=[176,120]\n'
      + 'width=[200,110,110,30]\ntop=[-10,10,25,35]\nbottom=[140,100,70,55]\n');
    assert.equal(runCli(p, '--check').code, 1);
  });

  test('other errors', () => {
    for (const vp of [{ width_px: 140, height: 96, foo: 1 }, { width_px: 140, height: 96, depth: 4 },
      { width_px: 140, height: 96, preset: 'xyz' }, { width_px: 140, height: 200 },
      { width_px: 200, height: 96 }, { width_px: 140, height: 96, origin: 65000 }]) {
      assert.throws(() => G.parseConfig({ viewport: vp }), isGeomError(), JSON.stringify(vp));
    }
    assert.throws(() => G.parseConfig(withPlanes({ top: [-10, 10, 25, 25] })), isGeomError());
    assert.throws(() => G.parseConfig(withPlanes({ top: [-10, 10, 25, 80] })), isGeomError());
  });

  test('check output and examples', () => {
    let r = runCli(join(ROOT, 'docs/specs/examples/view-west140.toml'), '--check');
    assert.equal(r.code, 0);
    const lines = r.stdout.split('\n');
    assert.equal(lines.length, 79);
    assert.ok(lines.includes('d=1 s=-1 front x=0 y=6 w=10 h=77 core=0,0,10,77 cov=0..10 src_dx=40'));
    r = runCli(join(ROOT, 'docs/specs/examples/view-west136.toml'), '--check');
    assert.equal(r.code, 0);
  });

  test('wide 160', () => {
    // spec 4.3: anchor columns d = 0, s = +-1 lie outside -128 ... 127 at width_px >= 144 -> saturation
    const { geo: g, files } = G.generate(confFor(160, 100), 'w160', { png: false });
    const c = files['w160.dvg'].subarray(2);
    const slot = g.elements.find((e) => G.isSlot(e) && e.d === 0 && e.s === 1);
    assert.ok(Math.floor(slot.anchors[4][0] / 2) > 127);
    const i = g.elements.indexOf(slot);
    const row = c.subarray(24 + 32 + 16 * i, 24 + 32 + 16 * i + 16);
    assert.equal(row[4 + 2 * 4], 127);
  });

  test('center x', () => {
    assert.throws(() => G.parseConfig(withPlanes({ center_x: 80 })), isGeomError());
    assert.throws(() => G.parseConfig(withPlanes({ width: [200, 'x', 60, 30] })), isGeomError());
  });

  test('usage', () => {
    assert.equal(runCli().code, 2);
  });

  test('cli writes all files (in-process)', () => {
    const out = join(tmp, 'gen');
    const r = runCli(join(ROOT, 'docs/specs/examples/view-west140.toml'), '--out', out, '--name', 'w');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `w: 79 elements, wall style 11094 bytes -> ${out}`);
    for (const f of ['w.dvg', 'w.geom.json', 'w.budget.md', 'w.aseprite', 'w_atlas.png', 'w_view.png', 'tpl/front_d1_s+0.png']) {
      assert.ok(existsSync(join(out, f)), f);
    }
    assert.equal(JSON.parse(readFileSync(join(out, 'w.geom.json'), 'utf8')).elements.length, 79);
  });
});

describe('BandCoverAndByteEdges', () => {
  const pixels = (im) => {
    const [x, y] = im.rect, out = new Set();
    im.mask.forEach((line, r) => [...line].forEach((ch, bx) => {
      if ('#L'.includes(ch)) out.add(`${2 * (x + bx)},${y + r}`);
      if ('#R'.includes(ch)) out.add(`${2 * (x + bx) + 1},${y + r}`);
    }));
    return out;
  };
  const partner = (p) => { const [px, r] = p.split(',').map(Number); return `${px ^ 1},${r}`; };

  test('bit3 on fronts containing the bands', () => {
    for (const g of allGeos()) {
      for (const im of g.images) {
        if (im.art !== ART_FRONT) continue;
        const [[c0], [, f1]] = g.bandRows[im.d];
        const want = im.rect[1] <= c0 && im.rect[1] + im.rect[3] >= f1;
        assert.equal(Boolean(im.flags & G.FLAG_BANDCOVER), want, im.name);
      }
      assert.ok(g.images.some((i) => i.flags & G.FLAG_BANDCOVER));
    }
  });

  test('bit3 in dvg bytes', () => {
    const g = geoFor(140, 96);
    const { content } = G.buildDvg(g);
    const base = 24 + 8 * (g.D + 1);
    let n = 0;
    g.elements.forEach((e, i) => {
      if (G.isSlot(e)) return;
      const fl = content[base + 16 * i + 3];
      assert.equal(Boolean(fl & 8), Boolean(e.flags & G.FLAG_BANDCOVER));
      n += fl & 8 ? 1 : 0;
    });
    assert.ok(n > 0);
  });

  test('byte edges default off', () => {
    assert.equal(confFor(140, 96).byte_edges, false);
    assert.ok(geoFor(140, 96).images.some((im) => im.mask.some((l) => /[LR]/.test(l))));
  });

  test('byte edges option checked', () => {
    assert.throws(() => G.parseConfig({ viewport: { width_px: 140, height: 96, byte_edges: 1 } }), isGeomError());
    assert.equal(G.parseConfig({ viewport: { width_px: 140, height: 96, byte_edges: true } }).byte_edges, true);
  });

  test('byte edges whole bytes', () => {
    for (const [w, h] of [[140, 96], [136, 92]]) {
      const g = new G.Geometry(G.parseConfig({ viewport: { width_px: w, height: h, byte_edges: true } }));
      const exact = geoFor(w, h);
      assert.equal(g.images.length, exact.images.length);
      for (const im of g.images) assert.ok(!im.mask.some((l) => /[LR]/.test(l)), im.name);
      // rounding: whole bytes and empty bytes stay, a half byte becomes full or empty (at most 1 pixel difference)
      for (const im of g.images) {
        const ex = exact.images.find((e) => e.name === im.name);
        const a = pixels(ex), b = pixels(im);
        for (const p of a) if (!b.has(p)) assert.ok(!a.has(partner(p)), im.name);   // dropped only if it was a half byte
        for (const p of b) if (!a.has(p)) assert.ok(a.has(partner(p)), im.name);    // only added: the partner was the half byte
      }
    }
  });

  test('byte edges tiling', () => {
    // same kind and depth, different cells s: no overlap (neighbouring faces share the edge)
    const g = new G.Geometry(G.parseConfig({ viewport: { width_px: 140, height: 96, byte_edges: true } }));
    for (let d = 0; d <= g.D; d++) {
      for (const art of [ART_FRONT, ART_SIDE, ART_FLOOR, ART_CEIL]) {
        const seen = new Map();
        for (const im of g.images) {
          if (im.d !== d || im.art !== art) continue;
          for (const p of pixels(im)) {
            assert.ok(!seen.has(p), `${im.name} and ${seen.get(p)} overlap`);
            seen.set(p, im.name);
          }
        }
      }
    }
  });

  test('byte edges fewer half bytes and new id', () => {
    const on = G.buildDvg(new G.Geometry(G.parseConfig({ viewport: { width_px: 140, height: 96, byte_edges: true } }))).gid;
    const off = G.buildDvg(geoFor(140, 96)).gid;
    assert.notEqual(on, off);
  });

  test('load default and range', () => {
    assert.equal(confFor(140, 96).load, 0xE800);
    const conf = confFor(140, 96);
    conf.load = 0xEC00;                     // DVG (1.5 KB) extends beyond $EDFF
    assert.throws(() => G.generate(conf, 'x'), (e) => e instanceof G.GeomError && e.message.includes('area end'));
    // nothing is returned, so nothing can be written (Python: x.dvg does not exist)
  });
});
