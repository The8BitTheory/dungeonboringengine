// Demo assets for the engine harnesses: the JS port of dbeview.build_demo_assets (default geometry built with
// core/geom.js exactly as dbetexdemo.default_geom, including the DBE_BYTE_EDGES switch).
//   ROOT, CORE                 repository root and tools/js/core
//   defaultGeom(w, h)          {geomJson (bytes), dvg (PRG bytes)} of the Westwood default geometry
//   demoAssets()               V.buildDemoAssets(defaultGeom()), cached per process
//   loadMap(path)              dbemap.load_toml
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../../tools/js/core/geom.js';
import * as V from '../../tools/js/core/view.js';
import * as M from '../../tools/js/core/map.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORE = join(ROOT, 'tools', 'js', 'core');

/** dbetexdemo.default_geom: geom.json bytes and DVG PRG of Westwood width x height. */
export function defaultGeom(width = 140, height = 96) {
  const vp = { preset: 'westwood', width_px: width, height };
  if (process.env.DBE_BYTE_EDGES === '1') vp.byte_edges = true;   // measurement switch of test/vice_view --byte-edges
  const conf = G.parseConfig({ viewport: vp });
  const geo = new G.Geometry(conf);
  geo.atlasSize = G.layoutAtlas(geo);
  const { content, gid } = G.buildDvg(geo);
  const bud = G.computeBudget(geo);
  const json = G.buildJson(geo, gid, bud);
  const dvg = new Uint8Array(content.length + 2);
  dvg[0] = conf.load & 255; dvg[1] = (conf.load >> 8) & 255;
  dvg.set(content, 2);
  return { geomJson: new TextEncoder().encode(G.geomJsonText(json)), dvg };
}

let cached = null;

/** dbeview.build_demo_assets (cached; the harnesses do not modify the assets). */
export function demoAssets() {
  if (cached === null) cached = V.buildDemoAssets(defaultGeom());
  return cached;
}

/** dbemap.load_toml(path) */
export function loadMap(path) { return M.loadsToml(readFileSync(path), path); }
