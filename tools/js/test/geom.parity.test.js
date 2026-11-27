// Parity of core/geom.js with tools/dbegeom.py: goldens from test/golden/mkgolden_geom.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../core/geom.js';
import { parseToml } from '../core/io/toml.js';
import { decodePng } from '../core/io/png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const GOLD = JSON.parse(readFileSync(join(HERE, 'golden', 'geom.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).digest('hex');

/** RGBA bytes of a pixel buffer (RGB gets alpha 255, as Pillow's convert("RGBA")). */
function rgbaOf(img) {
  if (img.rgba) return img.rgba;
  const n = img.width * img.height, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { out.set(img.rgb.subarray(3 * i, 3 * i + 3), 4 * i); out[4 * i + 3] = 255; }
  return out;
}

function confOf(c) {
  const cfg = c.toml ? parseToml(readFileSync(join(ROOT, c.toml))) : structuredClone(c.cfg);
  const conf = G.parseConfig(cfg);
  Object.assign(conf, c.patch ?? {});
  return conf;
}

for (const c of GOLD.cases) {
  test(`geom parity: ${c.label}`, () => {
    let res, checkSha;
    try {
      const conf = confOf(c);
      checkSha = sha(G.checkLines(new G.Geometry(conf)).join('\n'));
      res = G.generate(conf, conf.name, { png: c.label.startsWith('example') });
    } catch (e) {
      if (c.error !== undefined) {
        assert.ok(e instanceof G.GeomError, `${c.label}: expected GeomError, got ${e}`);
        assert.equal(e.message, c.error, c.label);
        return;
      }
      if (c.exception !== undefined) {
        assert.ok(!(e instanceof G.GeomError), `${c.label}: Python raised ${c.exception}, JS a GeomError: ${e.message}`);
        return;
      }
      throw e;
    }
    assert.equal(c.error, undefined, `${c.label}: Python raised GeomError '${c.error}'`);
    assert.equal(c.exception, undefined, `${c.label}: Python raised ${c.exception}`);
    assert.equal(checkSha, c.check_sha, `${c.label}: --check lines`);
    assert.equal(res.geo.elements.length, c.elements, c.label);
    assert.equal(res.gid, c.gid, `${c.label}: geometry ID`);
    const files = Object.fromEntries(Object.entries(res.files).filter(([k]) => !k.endsWith('.png')).map(([k, v]) => [k, sha(v)]));
    assert.deepEqual(files, c.files, `${c.label}: files`);
    const pngs = {}, tpl = [];
    for (const [k, img] of Object.entries(res.images)) {
      const v = [img.width, img.height, sha(rgbaOf(img))];
      if (k.startsWith('tpl/')) tpl.push([k, v]); else pngs[k] = v;
    }
    assert.deepEqual(pngs, c.pngs, `${c.label}: PNG pixels`);
    tpl.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const tsha = sha(tpl.map(([k, [w, h, s]]) => `${k}\0${w}\0${h}\0${s}\n`).join(''));
    assert.deepEqual([tpl.length, tsha], c.tpl, `${c.label}: templates`);
    // encoded PNGs (examples only, to keep the test fast) decode to the same pixels
    for (const [k, b] of Object.entries(res.files)) {
      if (!k.endsWith('.png')) continue;
      const img = decodePng(b), exp = res.images[k];
      assert.equal(sha(rgbaOf(img)), sha(rgbaOf(exp)), `${c.label}: ${k} encoded`);
    }
  });
}
