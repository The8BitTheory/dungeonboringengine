// Port of test/tools/test_crawlconv.py, plus parity with the Python converters (golden/crawl/crawl.json of
// test/golden/mkgolden_crawl.py: crawlconv, wallconv, crawlsprites). Regenerate: python3 tools/js/test/golden/mkgolden_crawl.py
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as crawlconv from '../core/crawl/crawlconv.js';
import * as crawlmap from '../core/crawl/crawlmap.js';
import * as crawlsprites from '../core/crawl/crawlsprites.js';
import * as wallconv from '../core/crawl/wallconv.js';
import * as dbemap from '../core/map.js';
import * as spr from '../core/spr.js';
import * as T from '../core/tex.js';
import * as V from '../core/view.js';
import * as vrl from '../core/vrl.js';
import { readDir, readD81, crawlconvCli, wallconvCli, crawlspritesCli, runCrawl } from '../cli/crawl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DATA = join(ROOT, 'test', 'tools', 'data');
const FIX = join(HERE, 'golden', 'crawl');
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'crawl', 'crawl.json'), 'utf8'));
const D81 = '/home/martin/git/dungeoncrawlerjam2025/crawl128-100f.d81';
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b) : b).digest('hex');
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const hasC1541 = () => spawnSync('c1541', ['-version'], { encoding: 'utf8' }).error === undefined;

const FILES = readDir(DATA);
const R = crawlconv.build(FILES);

function withTmp(fn) {
  const td = realpathSync(mkdtempSync(join(tmpdir(), 'crawlconv-')));
  try { return fn(td); } finally { rmSync(td, { recursive: true, force: true }); }
}
const norm = (s, td) => s.split(td).join('/T').split(ROOT).join('<ROOT>');
const dirSha = (d) => Object.fromEntries(readdirSync(d).sort().map((n) => [n, sha(readFileSync(join(d, n)))]));

describe('crawlconv (test_crawlconv.py)', () => {
  test('dvg', () => {
    const g = V.parseDvg(R.files['crawl.dvg']);
    assert.equal(g.elems.length, 28);
    assert.deepEqual([g.vw, g.vh, g.D, g.S, g.stride, g.origin, g.hy0, g.hy1], [68, 96, 3, 1, 80, 406, 0, 95]);
    assert.notEqual(g.gid, 0);
    assert.equal(g.gid, T.dvgId(R.files['crawl.dvg'].subarray(2)));
    assert.equal(u16(R.files['crawl.dvg'], 0), 0xE800);
    assert.ok(R.files['crawl.dvg'].length + 0xE800 - 2 <= 0xEE00);
    for (const dt of g.depth) assert.deepEqual([dt.cy0, dt.cy1, dt.fy0, dt.fy1], [0, 0, 0, 0]);
    // order: per depth s = 0, -1, +1; per cell fronts, sides, object slot (not at depth 0)
    const got = g.elems.map((e) => [e.d, e.s, e.art]);
    const want = [[0, -1, 1], [0, 1, 1],
      [1, 0, 0], [1, 0, 4], [1, -1, 0], [1, -1, 1], [1, -1, 4], [1, 1, 0], [1, 1, 1], [1, 1, 4],
      [2, 0, 0], [2, 0, 4], [2, -1, 0], [2, -1, 0], [2, -1, 1], [2, -1, 4], [2, 1, 0], [2, 1, 0], [2, 1, 1],
      [2, 1, 4], [3, 0, 0], [3, 0, 4], [3, -1, 0], [3, -1, 0], [3, -1, 4], [3, 1, 0], [3, 1, 0], [3, 1, 4]];
    assert.deepEqual(got, want);
    assert.deepEqual(g.depth.map((dt) => dt.n), [2, 8, 10, 8]);
    for (const d of [1, 2, 3]) {
      const f = g.elems.find((e) => e.d === d && e.s === 0 && e.art === 0);
      assert.deepEqual([g.depth[d].fw, g.depth[d].fx], [f.w, f.x]);
    }
    assert.deepEqual([g.depth[0].fw, g.depth[0].fx], [0, 0]);
  });

  test('wall elements', () => {
    const g = R.dvg;
    let n = 0;
    for (const e of g.elems) {
      if (e.art === 4) continue;
      n++;
      assert.deepEqual([e.y, e.kx, e.ky, e.kw, e.kh], [0, 0, 0, e.w, e.h]);
      assert.equal(e.flags & 4, 0);                       // not clipped
      if (e.h === 96) {
        assert.equal(e.flags & 1, 1);
        assert.deepEqual([e.c0, e.c1], [e.x, e.x + e.w]);
        assert.equal(e.flags & 8, e.art === 0 ? 8 : 0);
      } else assert.deepEqual([e.flags, e.c0, e.c1], [0, 0, 0]);
    }
    assert.equal(n, 19);
    // exactly one image is not covering: slot 9 (85 rows)
    assert.deepEqual(g.elems.filter((e) => e.art !== 4 && e.h !== 96).map((e) => e.h), [85]);
  });

  test('anchors', () => {
    const g = R.dvg;
    const ghost = new Map(), gem = new Map();
    for (const [d, [, row, cols]] of crawlsprites.GHOST_POS) for (const [s, col] of cols) ghost.set(`${d},${s}`, [col - 6, row - 5]);
    for (const [[d, s], [row, chars]] of crawlsprites.GEM_POS) gem.set(`${d},${s}`, [chars[0][0] - 6, row - 5]);
    for (const e of g.elems) {
      if (e.art !== 4) continue;
      const dd = Math.min(e.d, 2);
      assert.deepEqual(e.anchors[3], ghost.get(`${dd},${e.s}`), `${e.d},${e.s}`);
      assert.deepEqual(e.anchors[2], gem.get(`${dd},${e.s}`), `${e.d},${e.s}`);
      for (const p of [0, 1, 4]) assert.deepEqual(e.anchors[p], e.anchors[2]);
    }
    const a = g.elems.find((e) => e.d === 1 && e.s === 0 && e.art === 4).anchors;
    assert.deepEqual(a[3], [30, 48]);
    assert.deepEqual(a[2], [34, 75]);
  });

  test('gid identical', () => {
    const gid = R.dvg.gid;
    assert.equal(R.dts.geometryId, gid);
    assert.equal(R.ghost.geometryId, gid);
    assert.equal(R.gem.geometryId, gid);
    for (const n of ['walls.dts', 'ghost.s2', 'gem.s2']) assert.equal(u16(R.files[n], 2 + 4), gid, n);
  });

  test('dts', () => {
    const ts = T.fromDts(R.files['walls.dts'], R.wallVram);
    assert.deepEqual([ts.kind, ts.ne, ts.depth, ts.ns, ts.styles.length, ts.entries.length, ts.nk, ts.stride], [0, 28, 3, 19, 1, 19, 19, 80]);
    const [walls, vram] = crawlconv.parseWalls(FILES['walls.vdc']);
    assert.deepEqual(R.wallVram, vram);
    assert.equal(ts.u, 22354);
    assert.equal(R.wallVram.length, 22354);
    let occl = 0;
    for (const e of ts.entries) {
      assert.equal(e.cores.length, 1);
      assert.equal(e.edgeLen, 0);
      assert.equal(e.vms.length, 0);
      assert.equal(e.flags & ~T.F_OCCLUDING, 0);
      const k = e.cores[0];
      assert.deepEqual([k.dx, k.dy], [0, 0]);
      occl += e.flags & T.F_OCCLUDING ? 1 : 0;
      assert.equal(!!(e.flags & T.F_OCCLUDING), k.h === 96);
    }
    assert.equal(occl, 18);
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.deepEqual(ts.entries.map((e) => [e.cores[0].src, e.cores[0].w, e.cores[0].h]).sort(cmp),
      walls.map(([, s, w, h]) => [s, w, h]).sort(cmp));
    const wallIdx = R.dvg.elems.map((e, i) => [e, i]).filter(([e]) => e.art !== 4).map(([, i]) => i);
    assert.deepEqual(wallIdx.map((i) => ts.slotMap[i]), [...Array(19).keys()]);
    assert.deepEqual(ts.styles[0], [...Array(19).keys()]);
    assert.ok(R.files['walls.dts'].length - 2 + 0x8000 < 0xB000);
  });

  test('ghost mask', () => {
    const ss = R.ghost;
    const parts = crawlconv.parseSpr(FILES['ghost.spr']);
    const gv = FILES['ghosts.vdc'].subarray(2);
    assert.equal(ss.depth, 3);
    assert.deepEqual([ss.na, ss.np, ss.angleMap], [4, 1, [0, 1, 2, 3]]);
    const vp = { stride: 80, origin: 0 };
    let n = 0;
    for (const p of parts) {
      if (p.s !== 0) continue;
      const idx = spr.lookup(ss, 0, p.angle, p.d);
      assert.notEqual(idx, null);
      for (const bg of [0x00, 0xFF, 0x5A]) {
        const f2 = new Uint8Array(80 * (p.h + 1)).fill(bg);
        const f1 = f2.slice();
        T.simVms(gv, p.src, 0, p.list, f1);
        spr.renderImage(ss, idx, ss.vram, f2, 0, 0, vp);
        assert.deepEqual(f1, f2, `${p.d},${p.angle},${bg}`);
      }
      n++;
    }
    assert.equal(n, 8);
    for (let a = 0; a < 4; a++) assert.equal(spr.lookup(ss, 0, a, 3), null);       // depth 3: $FE
    assert.ok(R.files['ghost.s2'].length - 2 <= 0x1000);
    assert.equal(ss.u, R.ghostVram.length);
  });

  test('ghost black eyes opaque', () => {
    const flat = R.ghostRows.get('1,0').flat();
    assert.ok(flat.includes(null));
    assert.ok(flat.includes(0));
    assert.ok(flat.filter((v) => v !== null).length > Math.floor(flat.length / 4));
  });

  test('gem', () => {
    const ss = R.gem;
    const font = FILES['font3o.vdc'].subarray(2);
    assert.deepEqual([ss.na, ss.np, ss.depth, ss.flags], [1, 1, 3, 1]);
    assert.equal(ss.images.length, 1);
    const im = ss.images[0];
    assert.deepEqual([im.w, im.h, im.fx, im.fy], [6, 6, 0, 0]);
    const want = [];
    for (let k = 0; k < 6; k++) want.push(...font.subarray(4 * 18 + 3 * k, 4 * 18 + 3 * k + 3), ...font.subarray(5 * 18 + 3 * k, 5 * 18 + 3 * k + 3));
    const fb = new Uint8Array(80 * 7);
    spr.renderImage(ss, 0, ss.vram, fb, 0, 0, { stride: 80, origin: 0 });
    const got = [];
    for (let k = 0; k < 6; k++) got.push(...fb.subarray(80 * k, 80 * k + 6));
    assert.deepEqual(got, want);
    assert.equal(spr.lookup(ss, 0, 0, 3), null);
    for (const d of [1, 2]) assert.equal(spr.lookup(ss, 0, 0, d), 0);
    assert.ok(R.files['gem.s2'].length - 2 <= 0x1000);
  });

  test('vrl roundtrip', () => {
    for (const [name, data] of [['walls.vrl', R.wallVram], ['ghost.vrl', R.ghostVram], ['gem.vrl', R.gemVram]]) {
      const { u, stream } = vrl.unpackFile(R.files[name]);
      assert.equal(u, data.length);
      assert.deepEqual(vrl.decode(stream), Uint8Array.from(data));
    }
  });

  test('vrl parts', () => {
    for (const mp of [1500, 3000, 5000]) {
      const r = crawlconv.build(FILES, mp);
      const names = Object.keys(r.files).filter((n) => n.startsWith('walls') && n.endsWith('.vrl')).sort();
      assert.ok(names.length > 1, String(mp));
      assert.ok(!names.includes('walls.vrl'));
      assert.deepEqual(names, Array.from({ length: r.nparts }, (_, i) => `walls${i + 1}.vrl`).sort());
      let out = new Uint8Array(0);
      for (const n of names.sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))) {
        const f = r.files[n];
        assert.ok(f.length <= mp, n);
        const { stream } = vrl.unpackFile(f);
        const toks = vrl.decodeTokens(stream);
        if (n !== 'walls1.vrl') assert.equal(toks[0].kind, 'skip', n);
        out = vrl.decode(stream, out);       // RXV writes to the same target, skips leave it in place
      }
      assert.deepEqual(out, Uint8Array.from(r.wallVram));
    }
    const r = crawlconv.build(FILES, 100000);
    assert.ok('walls.vrl' in r.files);
    assert.equal(r.nparts, 1);
  });

  test('ranges and vram sum', () => {
    const i = R.info;
    assert.deepEqual([i.DA, i.u_walls], [19200 + 1730, 22354]);
    assert.equal(i.MA + 2 * 20 * 11, i.vram_end);
    assert.ok(i.vram_end <= 46335);
    assert.equal(i.GA0, i.DA + 22354);
    assert.equal(i.GA1, i.GA0 + R.ghostVram.length);
    assert.equal(i.MA, i.GA1 + R.gemVram.length);
    assert.throws(() => crawlconv.build(FILES, 0, 3000), crawlconv.ConvError);
    for (const [n, load] of [['crawl.dvg', 0xE800], ['walls.dts', 0x8000], ['ghost.s2', 0x6000], ['gem.s2', 0x7000], ['crawl.dmp', 0x4000]]) {
      assert.equal(u16(R.files[n], 0), load, n);
    }
  });

  test('dmp', () => {
    const { m } = crawlmap.convert(FILES['crawl128.cd1']);
    assert.deepEqual(R.files['crawl.dmp'], dbemap.toDmp(m, 0x4000));
    assert.equal(R.files['crawl.dmp'].length - 2, 24 + 2 * 220 + 43 * 8 + 4 * m.events.length);
  });

  test('errors', () => {
    let f = { ...FILES };
    const bad = f['walls.wsm'].slice();
    bad[2 + 10 + 5] ^= 1;                                // width of the first entry
    f['walls.wsm'] = bad;
    assert.throws(() => crawlconv.build(f), crawlconv.ConvError);
    // ghost part of the side differs from the center: part 1 = (1, -1, 0), source of the next angle
    f = { ...FILES };
    let s = f['ghost.spr'].slice();
    s.set([355 & 255, 355 >> 8], 2 + 6 + 15 * 1 + 6);
    f['ghost.spr'] = s;
    assert.throws(() => crawlconv.build(f), crawlconv.ConvError);
    // gem: second character not 3 bytes to the right
    f = { ...FILES };
    s = f['gem.spr'].slice();
    s.set([5000 & 255, 5000 >> 8], 2 + 6 + 15 * 1 + 8);
    f['gem.spr'] = s;
    assert.throws(() => crawlconv.build(f), crawlconv.ConvError);
    assert.throws(() => readDir(join(HERE, 'not-there')), crawlconv.ConvError);
  });

  test('cli', () => withTmp((td) => {
    const r = runCrawl(crawlconvCli, ['--dir', DATA, td, '--json']);
    assert.equal(r.code, 0, r.stderr);
    for (const n of ['crawl.dvg', 'walls.dts', 'walls.vrl', 'ghost.s2', 'ghost.vrl', 'gem.s2', 'gem.vrl', 'crawl.dmp', 'crawlconv.md', 'crawlconv.json']) {
      assert.ok(existsSync(join(td, n)), n);
    }
    const md = readFileSync(join(td, 'crawlconv.md'), 'utf8');
    assert.ok(md.includes('reserve'));
    assert.ok(md.includes('geometry ID'));
    assert.deepEqual(new Uint8Array(readFileSync(join(td, 'crawl.dvg'))), R.files['crawl.dvg']);
    const e = runCrawl(crawlconvCli, ['--dir', join(td, 'x'), td]);
    assert.equal(e.code, 1);
    assert.ok(e.stderr.includes('Error'));
  }));

  test('d81 equals dir', { skip: !(existsSync(D81) && hasC1541()) && 'no c1541 or d81' }, () => withTmp((td) => {
    const f = readD81(D81, td);
    for (const k of crawlconv.FILES) assert.deepEqual(f[k], FILES[k], k);
  }));
});

describe('crawlconv parity (golden/crawl/crawl.json)', () => {
  const G = GOLD.crawlconv;
  test('input data', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(FILES).map(([n, d]) => [n, sha(d)])), GOLD.data);
  });

  test('default outputs, md and json', () => {
    const out = crawlconv.outputs(R, true);
    assert.deepEqual(Object.fromEntries(Object.keys(out).sort().map((n) => [n, sha(out[n])])), G.default.files);
    assert.deepEqual(R.info, G.default.info);
  });

  test('VRL parts', () => {
    for (const [mp, g] of Object.entries(G.parts)) {
      const r = crawlconv.build(FILES, +mp);
      assert.equal(r.nparts, g.nparts, mp);
      assert.deepEqual(Object.fromEntries(Object.entries(r.files).map(([n, d]) => [n, sha(d)])), g.files, mp);
      assert.deepEqual(Object.keys(r.files), Object.keys(g.files), mp);
      assert.equal(sha(crawlconv.reportMd(r)), g.md, mp);
    }
  });

  test('font bytes and without map', () => {
    assert.throws(() => crawlconv.build(FILES, 0, 3000), (e) => `ConvError: ${e.message}` === G.font3000);
    assert.deepEqual(Object.fromEntries(Object.entries(crawlconv.build(FILES, 0, 1732).files).map(([n, d]) => [n, sha(d)])), G.font1732);
    const nomap = { ...FILES };
    delete nomap['crawl128.cd1'];
    const r = crawlconv.build(nomap);
    assert.deepEqual(Object.fromEntries(Object.entries(r.files).map(([n, d]) => [n, sha(d)])), G.nomap.files);
    assert.equal(sha(crawlconv.reportMd(r)), G.nomap.md);
    assert.deepEqual(r.info, G.nomap.info);
  });

  test('error messages', () => {
    const mut = (name, fn) => { const f = { ...FILES }; const b = f[name].slice(); fn(b); f[name] = b; return f; };
    const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >> 8; };
    const cases = {
      wsm_width: mut('walls.wsm', (b) => { b[2 + 10 + 5] ^= 1; }),
      ghost_side: mut('ghost.spr', (b) => put16(b, 2 + 6 + 15 + 6, 355)),
      gem_dest: mut('gem.spr', (b) => put16(b, 2 + 6 + 15 + 8, 5000)),
      gem_char: mut('gem.spr', (b) => put16(b, 2 + 6 + 6, 0)),
      ghost_flags: mut('ghost.spr', (b) => { b[2 + 6 + 3] = 0; }),
      walls_size: mut('walls.vdc', (b) => put16(b, 2 + 1 + 4, 1)),
      wsm_magic: { ...FILES, 'walls.wsm': Uint8Array.from([0, 0xE0, 0x58, 0x58, 1]) },
      spr_magic: { ...FILES, 'gem.spr': Uint8Array.from([0, 0xEA, 0x53, 0x50, 2, 0]) },
    };
    for (const [k, f] of Object.entries(cases)) {
      let msg = null;
      try { crawlconv.build(f); } catch (e) { msg = `${e.name}: ${e.message}`; }
      assert.equal(msg, G.errors[k], k);
    }
  });

  test('CLI texts and files', () => withTmp((td) => {
    const chk = (k, argv, dir = null) => {
      const r = runCrawl(crawlconvCli, argv);
      const g = G.cli[k];
      assert.deepEqual([r.code, norm(r.stdout, td), norm(r.stderr, td)], [g.code, g.stdout, g.stderr], k);
      if (dir) assert.deepEqual(dirSha(dir), g.files, k);
    };
    chk('json', ['--dir', DATA, join(td, 'cli'), '--json'], join(td, 'cli'));
    chk('missing', ['--dir', join(td, 'x'), join(td, 'cli')]);
    chk('parts', ['--dir', DATA, join(td, 'cli2'), '--max-part', '3000'], join(td, 'cli2'));
    chk('font', ['--dir', DATA, join(td, 'cli3'), '--font-bytes', '3000']);
  }));

  test('usage errors', () => {
    assert.equal(runCrawl(crawlconvCli, ['out']).code, 2);
    assert.equal(runCrawl(crawlconvCli, ['out', '--dir', 'a', '--d81', 'b']).code, 2);
    assert.equal(runCrawl(crawlconvCli, ['--dir', 'a']).code, 2);
  });

  test('Crawl 1.0f disk', { skip: !(GOLD.d81 && existsSync(D81) && hasC1541()) && 'no c1541 or d81' }, () => withTmp((td) => {
    const f = readD81(D81, td);
    assert.deepEqual(Object.fromEntries(Object.entries(f).map(([n, d]) => [n, sha(d)])), GOLD.d81.data);
    assert.deepEqual(Object.fromEntries(Object.entries(crawlconv.build(f).files).map(([n, d]) => [n, sha(d)])), GOLD.d81.files);
  }));
});

describe('wallconv and crawlsprites parity', () => {
  test('wallconv', () => withTmp((td) => {
    const { prg, ents } = wallconv.toWsm(FILES['walls.vdc']);
    assert.equal(sha(prg), GOLD.wallconv.wsm);
    assert.equal(ents.length, GOLD.wallconv.n);
    assert.deepEqual(prg, FILES['walls.wsm']);
    const r = runCrawl(wallconvCli, [join(DATA, 'walls.vdc'), join(td, 'w.wsm'), '-v', '--load', '0xE100']);
    const g = GOLD.wallconv.cli;
    assert.deepEqual([r.code, norm(r.stdout, td), r.stderr], [g.code ?? 0, g.stdout, g.stderr]);
    assert.equal(sha(readFileSync(join(td, 'w.wsm'))), g.wsm);
  }));

  test('crawlsprites', { skip: !GOLD.crawlsprites && 'no red.vdc fixtures' }, () => withTmp((td) => {
    const r = runCrawl(crawlspritesCli, [join(FIX, 'red.vdc'), join(FIX, 'red1.vdc'), td]);
    const g = GOLD.crawlsprites;
    assert.deepEqual([r.code, r.stdout, r.stderr], [g.code ?? 0, g.stdout, g.stderr]);
    assert.deepEqual(dirSha(td), g.files);
    for (const n of ['ghosts.vdc', 'ghost.spr', 'gem.spr']) assert.equal(sha(readFileSync(join(td, n))), sha(FILES[n]), n);
  }));
});
