// Parity of core/tex.js, core/demo/texdemo.js, cli/tex.js and the dbeview demo assets with the Python tools:
// goldens of test/golden/mkgolden_tex.py (tex.json, fixtures in golden/tex/). Regenerate:
//   python3 tools/js/test/golden/mkgolden_tex.py
// The projects are built through the CLI in a temporary directory that plays the role of /T in the goldens
// (paths in texts: repository root = <ROOT>, temporary directory = /T).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as texdemo from '../core/demo/texdemo.js';
import { runTex } from '../cli/tex.js';
import { decodeImage } from '../core/io/image.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIX = join(HERE, 'golden', 'tex');
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'tex.json'), 'utf8'));
const EX = join(ROOT, 'docs', 'specs', 'examples', 'tex');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rd = (p) => new Uint8Array(readFileSync(p));

let TMP = null;
const norm = (s) => s.split(TMP).join('/T').split(ROOT).join('<ROOT>');
const real = (s) => s.split('/T/').join(TMP + '/').split('<ROOT>').join(ROOT);

/** Decoded pixels of an image file as [w, h, sha256] (mode 'RGB' or 'RGBA', like Pillow convert + tobytes). */
function pix(bytes, mode) {
  const im = decodeImage(bytes);
  if (mode === 'RGBA') return [im.width, im.height, sha(im.rgba)];
  const rgb = new Uint8Array(im.width * im.height * 3);
  for (let i = 0; i < im.width * im.height; i++) rgb.set(im.rgba.subarray(i * 4, i * 4 + 3), i * 3);
  return [im.width, im.height, sha(rgb)];
}

function writeAll(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [n, v] of Object.entries(files)) writeFileSync(join(dir, n), v);
}

function genTexdemo(dir) {
  const r = texdemo.generate({ geomJson: rd(join(EX, 'west140.geom.json')), dvg: rd(join(EX, 'west140.dvg')) });
  writeAll(dir, r.files);
  return r;
}

let sprCli = null;
async function spr() {
  if (sprCli === null) {
    try { sprCli = await import('../cli/spr.js'); } catch { sprCli = false; }
  }
  return sprCli;
}

before(async () => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'dbetex-')));
  // /T/demo and /T/build/demo as the demo TOMLs expect them
  mkdirSync(join(TMP, 'demo'));
  cpSync(join(ROOT, 'demo', 'art'), join(TMP, 'demo', 'art'), { recursive: true });
  for (const n of ['walls', 'floor', 'ceil', 'bg', 'goblin', 'gem']) cpSync(join(ROOT, 'demo', n + '.toml'), join(TMP, 'demo', n + '.toml'));
  cpSync(join(FIX, 'build'), join(TMP, 'build'), { recursive: true });
  genTexdemo(join(TMP, 'tex'));
  for (const n of ['walls', 'floor', 'ceil']) runTex(['build', join(TMP, 'tex', n + '.toml'), '--out', join(TMP, 'tex_out'), '--no-preview']);
  runTex(['bg', join(TMP, 'tex', 'bg.toml'), '--out', join(TMP, 'tex_out')]);
  const s = await spr();
  if (s && s.runSpr) {
    const sd = await import('../core/demo/sprdemo.js');
    writeAll(join(TMP, 'spr'), sd.generate({ geomJson: rd(join(EX, 'west140.geom.json')), dvg: rd(join(EX, 'west140.dvg')) }).files);
    for (const n of ['blob', 'blob_m', 'gem']) s.runSpr(['build', join(TMP, 'spr', n + '.toml'), '--out', join(TMP, 'spr_out'), '--no-preview']);
  }
});

after(() => { if (TMP) rmSync(TMP, { recursive: true, force: true }); });

function checkOutputs(dir, p) {
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, [...Object.keys(p.files), ...Object.keys(p.previews)].sort(), p.toml);
  for (const [n, h] of Object.entries(p.files)) assert.equal(sha(rd(join(dir, n))), h, `${p.toml}: ${n}`);
  for (const [n, h] of Object.entries(p.previews)) assert.deepEqual(pix(rd(join(dir, n)), 'RGB'), h, `${p.toml}: ${n}`);
}

describe('tex projects', () => {
  for (const p of GOLD.projects.filter((x) => x.tool === 'tex')) {
    test(`${p.cmd} ${p.toml}`, () => {
      const out = mkdtempSync(join(TMP, 'o'));
      const r = runTex([p.cmd, real(p.toml), '--out', out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(norm(r.stdout), p.stdout);
      assert.equal(norm(r.stderr), p.stderr);
      checkOutputs(out, p);
    });
  }
});

describe('texdemo', () => {
  test('generator outputs (default geometry)', () => {
    const r = texdemo.generate({ geomJson: rd(join(EX, 'west140.geom.json')), dvg: rd(join(EX, 'west140.dvg')) });
    assert.deepEqual(Object.keys(r.files).sort(), Object.keys(GOLD.texdemo).sort());
    for (const [n, g] of Object.entries(GOLD.texdemo)) {
      const v = r.files[n];
      if (g.rgba) assert.deepEqual(pix(v, 'RGBA'), g.rgba, n);
      else assert.equal(sha(typeof v === 'string' ? Buffer.from(v) : v), g.sha, n);
    }
  });

  test('generator outputs (other geometry, --geom)', () => {
    const g = GOLD.texdemo136;
    const r = texdemo.generate({ geomJson: rd(join(FIX, 'w136.geom.json')), geomRef: g.geom_ref });
    assert.deepEqual(Object.keys(r.files).sort(), Object.keys(g.files).sort());
    for (const [n, x] of Object.entries(g.files)) {
      const v = r.files[n];
      if (x.rgba) assert.deepEqual(pix(v, 'RGBA'), x.rgba, n);
      else assert.equal(sha(typeof v === 'string' ? Buffer.from(v) : v), x.sha, n);
    }
  });
});

describe('error and warning cases', () => {
  for (const c of GOLD.errors.filter((x) => x.gen === 'tex')) {
    test(`${c.toml}: ${c.replace[1].replace(/\n/g, ' ').slice(0, 50)}`, () => {
      const dir = join(TMP, c.gen);
      const text = readFileSync(join(dir, c.toml), 'utf8');
      const bad = join(dir, 'case.toml');
      writeFileSync(bad, text.replace(c.replace[0], () => c.replace[1]));
      const out = mkdtempSync(join(TMP, 'e'));
      const r = runTex(c.cmd === 'build' ? [c.cmd, bad, '--out', out, '--no-preview'] : [c.cmd, bad, '--out', out]);
      rmSync(bad);
      assert.equal(r.code, c.code, r.stderr);
      assert.equal(norm(r.stdout), c.stdout);
      assert.equal(norm(r.stderr), c.stderr);
    });
  }
});

describe('CLI texts', () => {
  for (const c of GOLD.cli.filter((x) => x.tool === 'tex')) {
    test(c.args.join(' ').slice(0, 90), async (t) => {
      if (c.args.some((a) => a.includes('/T/spr_out')) && !((await spr()) && (await spr()).runSpr)) {
        t.skip('cli/spr.js not available');
        return;
      }
      const r = runTex(c.args.map(real));
      assert.equal(r.code, c.code, r.stderr);
      assert.equal(norm(r.stdout), c.stdout);
      assert.equal(norm(r.stderr), c.stderr);
    });
  }
});

describe('dbeview demo assets (build_demo_assets)', () => {
  test('hashes of the generated assets and files', async () => {
    const V = await import('../core/view.js');
    const T = await import('../core/tex.js');
    const g = GOLD.demo_assets;
    const a = V.buildDemoAssets({ geomJson: rd(join(EX, 'west140.geom.json')), dvg: rd(join(EX, 'west140.dvg')) });
    assert.equal(sha(a.dvgPrg), g.dvg);
    assert.equal(sha(a.dbgPrg), g.dbg);
    assert.equal(sha(a.dbgVram), g.dbg_vram);
    for (const n of ['walls', 'floor', 'ceil']) {
      assert.equal(sha(T.toDts(a[n])), g[n], n);
      assert.equal(sha(a[n].vram), g[n + '_vram'], n);
    }
    a.sprites.forEach((s, i) => {
      if (s === null) { assert.equal(g.sprites[i], null); return; }
      const prg = new Uint8Array(2 + s.s2Content.length);
      prg.set([0x00, 0x60]);
      prg.set(s.s2Content, 2);
      assert.deepEqual([sha(prg), sha(s.vram)], g.sprites[i], `sprite ${i}`);
    });
    for (const [n, x] of Object.entries(g.files)) {
      const v = a.files[n];
      if (x.rgba) assert.deepEqual(pix(v, 'RGBA'), x.rgba, n);
      else assert.equal(sha(Buffer.from(v)), x.sha, n);
    }
    // the same assets as the fixtures of test/golden/mkgolden_view.py (view.test.js)
    const VF = join(HERE, 'golden', 'view');
    assert.ok(Buffer.from(a.dvgPrg).equals(readFileSync(join(VF, 'west140.dvg'))));
    for (const n of ['walls', 'floor', 'ceil']) {
      assert.ok(Buffer.from(T.toDts(a[n])).equals(readFileSync(join(VF, n + '.dts'))), n);
      assert.ok(Buffer.from(a[n].vram).equals(readFileSync(join(VF, n + '.vram'))), n);
    }
    assert.ok(Buffer.from(a.dbgPrg).equals(readFileSync(join(VF, 'sky.dbg'))));
    for (let i = 0; i < 4; i++) assert.ok(Buffer.from(a.sprites[i].vram).equals(readFileSync(join(VF, `s2_${i}.vram`))), `s2_${i}`);
  });

  test('sprite_pixels', async () => {
    const V = await import('../core/view.js');
    const { pyDumps } = await import('../core/tex.js');
    for (const [k, h] of Object.entries(GOLD.demo_assets.sprite_pixels)) {
      const [kind, w, hh, ai, f] = k.split('_');
      assert.equal(sha(pyDumps(V.spritePixels(kind, +w, +hh, +ai, +f))), h, k);
    }
  });
});
