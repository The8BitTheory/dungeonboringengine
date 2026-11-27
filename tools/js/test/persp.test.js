// Port of test/tools/test_dbepersp.py (perspective patterns, docs/specs/P5-textures.md 10.4).
// Default geometry of dbetexdemo = docs/specs/examples/tex/west140.geom.json (dbegeom output).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as persp from '../core/persp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEOM = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'docs', 'specs', 'examples', 'tex', 'west140.geom.json'), 'utf8'));
const P = new persp.Persp(GEOM);
const EL = Object.fromEntries(GEOM.elements.map((e) => [e.name, e]));
const almost = (a, b) => assert.ok(Math.abs(a - b) < 5e-8, `${a} != ${b}`);       // assertAlmostEqual (7 places)

describe('TestPersp', () => {
  test('planes: at the planes, Z = W_1 / W_k and v of the side agree with the front', () => {
    const e = EL['side_d1_s+1'];
    const fn = P.sideMap(e);
    const pl = GEOM.planes;
    const [u, v] = fn(e.polygon[0][0], pl[1].T + pl[1].W * 0.25);
    almost(u, 1.0);
    almost(v, 0.25);
    almost(fn(e.polygon[1][0], pl[2].T)[0], pl[1].W / pl[2].W);
  });

  test('floor_depth', () => {
    const fn = P.elementMap(EL['floor_d1_s+0']);
    const pl = GEOM.planes;
    almost(fn(70, pl[1].B)[1], 1.0);
    almost(fn(70, pl[2].B)[1], pl[1].W / pl[2].W);
  });

  test('deterministic_and_fits', () => {
    const f = persp.elementFn(P, EL['side_d1_s-1'], persp.brickPattern(), 4, new Map([[14, 3]]));
    const run = () => { const a = []; for (let r = 0; r < 5; r++) for (let px = 0; px < 8; px++) a.push(f(px, r)); return a; };
    assert.deepEqual(run(), run());
  });
});
