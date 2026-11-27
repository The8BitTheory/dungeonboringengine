// Parity of core/spr.js, core/demo/sprdemo.js and cli/spr.js with tools/dbespr.py / dbesprdemo.py:
// goldens of test/golden/mkgolden_tex.py (tex.json, fixtures under golden/tex/). The Python run used a temporary
// directory written as /T; here a real temporary directory TT plays /T (same layout: /T/demo, /T/build/demo,
// /T/spr, /T/spr_out, /T/tex_out).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSpr } from '../cli/spr.js';
import * as sprdemo from '../core/demo/sprdemo.js';
import * as texdemo from '../core/demo/texdemo.js';
import * as tex from '../core/tex.js';
import { decodeImage } from '../core/io/image.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const GFIX = join(HERE, 'golden', 'tex');
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'tex.json'), 'utf8'));
const EX = join(ROOT, 'docs', 'specs', 'examples', 'tex');
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b) : b).digest('hex');
const rgbSha = (png) => {
  const im = decodeImage(png);
  const rgb = new Uint8Array(im.width * im.height * 3);
  for (let i = 0; i < im.width * im.height; i++) rgb.set(im.rgba.subarray(i * 4, i * 4 + 3), i * 3);
  return [im.width, im.height, sha(rgb)];
};
const rgbaSha = (png) => { const im = decodeImage(png); return [im.width, im.height, sha(im.rgba)]; };

let TT;
const norm = (s) => s.split(TT).join('/T').split(ROOT).join('<ROOT>');
const real = (s) => s.split('/T/').join(TT + '/').split('<ROOT>').join(ROOT);
const writeFiles = (dir, files) => {
  mkdirSync(dir, { recursive: true });
  for (const [n, v] of Object.entries(files)) writeFileSync(join(dir, n), v);
};
const defaultGeom = () => ({ geomJson: new Uint8Array(readFileSync(join(EX, 'west140.geom.json'))), dvg: new Uint8Array(readFileSync(join(EX, 'west140.dvg'))) });

function outputs(d) {
  const files = {}, previews = {};
  for (const n of readdirSync(d).sort()) {
    const b = readFileSync(join(d, n));
    if (n.endsWith('.png')) previews[n] = rgbSha(b); else files[n] = sha(b);
  }
  return { files, previews };
}

let outN = 0;
const freshOut = () => { const d = join(TT, `out${outN++}`); mkdirSync(d); return d; };

before(() => {
  TT = realpathSync(mkdtempSync(join(tmpdir(), 'sprpar-')));
  mkdirSync(join(TT, 'demo'));
  cpSync(join(ROOT, 'demo', 'art'), join(TT, 'demo', 'art'), { recursive: true });
  for (const n of ['goblin', 'gem']) cpSync(join(ROOT, 'demo', n + '.toml'), join(TT, 'demo', n + '.toml'));
  cpSync(join(GFIX, 'build'), join(TT, 'build'), { recursive: true });
  writeFiles(join(TT, 'spr'), sprdemo.generate(defaultGeom()).files);
  for (const n of ['blob', 'blob_m', 'gem']) {
    const r = runSpr(['build', join(TT, 'spr', n + '.toml'), '--out', join(TT, 'spr_out'), '--no-preview']);
    assert.equal(r.code, 0, r.stderr);
  }
  // dbetex output of the texdemo walls (only its magic matters for the spr dump case)
  const td = texdemo.generate(defaultGeom()).files;
  const files = new Map(Object.entries(td).map(([n, v]) => [`/V/${n}`, typeof v === 'string' ? new TextEncoder().encode(v) : v]));
  const w = tex.buildTex(td['walls.toml'], { path: '/V/walls.toml', resolve: (p) => files.get(p) ?? null, preview: false });
  writeFiles(join(TT, 'tex_out'), { 'demo_walls.dts': w.files['demo_walls.dts'] });
});

after(() => { if (TT) rmSync(TT, { recursive: true, force: true }); });

describe('spr projects', () => {
  for (const p of GOLD.projects.filter((x) => x.tool === 'spr')) {
    test(p.toml, () => {
      const out = freshOut();
      const r = runSpr(['build', real(p.toml), '--out', out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(norm(r.stdout), p.stdout);
      assert.equal(norm(r.stderr), p.stderr);
      const o = outputs(out);
      assert.deepEqual(o.files, p.files);
      assert.deepEqual(o.previews, p.previews);
    });
  }
});

function cmpGen(files, gold) {
  assert.deepEqual(Object.keys(files).sort(), Object.keys(gold).sort());
  for (const [n, v] of Object.entries(files)) {
    if (n.endsWith('.png')) assert.deepEqual(rgbaSha(v), gold[n].rgba, n);
    else assert.equal(sha(v), gold[n].sha, n);
  }
}

test('sprdemo outputs (default geometry)', () => cmpGen(sprdemo.generate(defaultGeom()).files, GOLD.sprdemo));

test('sprdemo outputs (other geometry, geomRef)', () => {
  const g = GOLD.sprdemo136;
  cmpGen(sprdemo.generate({ geomJson: new Uint8Array(readFileSync(join(GFIX, 'w136.geom.json'))), geomRef: g.geom_ref }).files, g.files);
});

describe('spr error and warning cases', () => {
  for (const e of GOLD.errors.filter((x) => x.gen === 'spr')) {
    test(`${e.toml}: ${JSON.stringify(e.replace)}`, () => {
      const text = readFileSync(join(TT, 'spr', e.toml), 'utf8');
      assert.ok(text.includes(e.replace[0]));
      const bad = join(TT, 'spr', 'case.toml');
      writeFileSync(bad, text.replace(e.replace[0], () => e.replace[1]));
      const r = runSpr(['build', bad, '--out', freshOut(), '--no-preview']);
      assert.equal(r.code, e.code);
      assert.equal(norm(r.stdout), e.stdout);
      assert.equal(norm(r.stderr), e.stderr);
    });
  }
});

describe('spr CLI texts', () => {
  for (const c of GOLD.cli.filter((x) => x.tool === 'spr')) {
    test(c.args.join(' '), () => {
      const r = runSpr(c.args.map(real));
      assert.equal(r.code, c.code, r.stderr);
      assert.equal(norm(r.stdout), c.stdout);
      assert.equal(norm(r.stderr), c.stderr);
    });
  }
  for (const p of GOLD.spr_preview) {
    test(`preview ${p.args.join(' ')}`, () => {
      const [d, ph, an] = p.args;
      const out = join(TT, `p${d}${ph}${an}.png`);
      const s = join(TT, 'spr_out', 'blob');
      const r = runSpr(['preview', s + '.s2', '--vrl', s + '.vrl', '--geom', join(TT, 'spr', 'west140.geom.json'),
        '--d', String(d), '--phase', String(ph), '--angle', String(an), '--out', out]);
      assert.equal(r.code, p.code);
      assert.equal(norm(r.stdout), p.stdout);
      assert.deepEqual(rgbSha(readFileSync(out)), p.image);
    });
  }
});
