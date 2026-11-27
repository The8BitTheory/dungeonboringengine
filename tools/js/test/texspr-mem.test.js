// Port of the two remaining tool tests of test/tools/test_dbemem.py (test_dbetex, test_dbespr): the builders keep
// their bank 1 memory map range (dbemem) and abort with a range error ("area end") through the CLIs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as texdemo from '../core/demo/texdemo.js';
import { runTex } from '../cli/tex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, '..', '..', '..', 'docs', 'specs', 'examples', 'tex');
const GEOM = () => ({ geomJson: new Uint8Array(readFileSync(join(EX, 'west140.geom.json'))), dvg: new Uint8Array(readFileSync(join(EX, 'west140.dvg'))) });
const TMPS = [];
after(() => { for (const d of TMPS) rmSync(d, { recursive: true, force: true }); });

function genDir(files) {
  const td = mkdtempSync(join(tmpdir(), 'dbemem-'));
  TMPS.push(td);
  mkdirSync(td, { recursive: true });
  for (const [n, v] of Object.entries(files)) writeFileSync(join(td, n), v);
  return td;
}

describe('TestTools', () => {
  test('dbetex', () => {
    const td = genDir(texdemo.generate(GEOM()).files);
    const toml = join(td, 'walls.toml'), out = join(td, 'o');
    let r = runTex(['build', toml, '--out', out, '--no-preview']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Array.from(readFileSync(join(out, 'demo_walls.dts')).subarray(0, 2)), [0x00, 0x80]);
    const bad = join(td, 'bad.toml');
    writeFileSync(bad, readFileSync(toml, 'utf8').replace(/^load\s*=.*$/gm, 'load = 0xA000'));   // 8736 bytes from $A000: beyond $AFFF
    r = runTex(['build', bad, '--out', out, '--no-preview']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('area end'), r.stderr);
  });

  test('dbespr', async () => {
    const sprdemo = await import('../core/demo/sprdemo.js');
    const { runSpr } = await import('../cli/spr.js');
    const td = genDir(sprdemo.generate(GEOM()).files);
    const toml = join(td, 'blob.toml'), out = join(td, 'o');
    let r = runSpr(['build', toml, '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Array.from(readFileSync(join(out, 'blob.s2')).subarray(0, 2)), [0x00, 0x60]);
    const bad = join(td, 'bad.toml');
    writeFileSync(bad, readFileSync(toml, 'utf8').replace(/^load\s*=.*$/gm, 'load = 0x7800'));    // S2 beyond $7FFF
    r = runSpr(['build', bad, '--out', out]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('area end'), r.stderr);
  });
});
