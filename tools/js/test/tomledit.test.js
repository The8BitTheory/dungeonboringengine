import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTomlValue } from '../core/io/tomledit.js';
import { parseToml } from '../core/io/toml.js';

const SRC = `# head
[viewport]
preset   = "westwood"
width_px = 140   # comment stays
height   = 96

[output]
name = "west140"
`;

test('setTomlValue keeps comments, adds and removes', () => {
  let t = setTomlValue(SRC, 'viewport', 'width_px', 128);
  assert.match(t, /width_px = 128   # comment stays/);
  t = setTomlValue(t, 'viewport', 'byte_edges', true);
  t = setTomlValue(t, 'output', 'zoom', 2);
  t = setTomlValue(t, 'planes', 'width', [208, 128, 80]);
  t = setTomlValue(t, 'viewport', 'height', null);
  const d = parseToml(t);
  assert.deepEqual({ ...d.viewport }, { preset: 'westwood', width_px: 128, byte_edges: true });
  assert.deepEqual({ ...d.output }, { name: 'west140', zoom: 2 });
  assert.deepEqual(d.planes.width, [208, 128, 80]);
  assert.match(t, /^# head/);
});
