// dbebake: visibility check, baking of animations and packing per zone (docs/specs/P8-js-tools.md, section 8;
// docs/vda-animation-notes.md, sections 5 and 8). New in JS, no Python original.
//
// Everything that is expensive at runtime but known to the tools is resolved here, with the level context:
//   visibility(scene)          every wall face the engine actually draws, from every walkable cell and facing
//                              (traced inside view.js, so it is exactly the engine's VIEW)
//   checkVisibility(...)       faces visible in a slot where their style has no image of its own
//   bakeAnim(scene, anim)      per viewpoint: render every frame (a wall style) of an animated face in the real scene
//                              (background, occluders, everything) and cut the byte rectangle that changes:
//                              opaque patches, the runtime only copies them (case R1)
//   pack(...)                  bank 1 layout, VRAM pool layout, RXV load list and load time of a zone
//   buildBake(src, opts)       the whole `build` command from a dbebake TOML
import * as V from './view.js';
import * as M from './map.js';
import * as tex from './tex.js';
import * as vrl from './vrl.js';
import * as mem from './mem.js';
import { parseToml } from './io/toml.js';

export class BakeError extends Error {
  constructor(msg) { super(msg); this.name = 'BakeError'; }
}

export const FORMAT_VERSION = 0;          // DAP v0: draft until the VDA runtime is specified
export const RXV_US_PER_BYTE = 27;        // RXV on a C128 (2 MHz, R36 = 0), gate content; vda notes section 6
const DIRS = 'NESW';
const ART = { 0: 'front', 1: 'side', 2: 'floor', 3: 'ceil', 4: 'obj' };
const sgn = (s) => (s < 0 ? `-${-s}` : `+${s}`);
export const slotName = (r) => `${ART[r.art]}_d${r.d}_s${sgn(r.s)}`;
const hex4 = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

function pdir(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function pjoin(dir, rel) { return rel.startsWith('/') || !dir ? rel : `${dir}/${rel}`; }
function dirOf(v) {
  if (typeof v === 'number' && v >= 0 && v <= 3) return v;
  const i = DIRS.indexOf(String(v).toUpperCase());
  if (i < 0) throw new BakeError(`direction ${JSON.stringify(v)}: N, E, S or W expected`);
  return i;
}

// ---------------------------------------------------------------- configuration

const TOP = new Set(['format', 'version', 'bake', 'pack', 'anim']);
const BAKE = new Set(['name', 'scene', 'map', 'out', 'load']);
const PACK = new Set(['pool', 'dap_load', 'rxv_us_per_byte', 'order']);
const ANIM = new Set(['name', 'at', 'face', 'frames', 'views', 'depths']);

function keys(where, obj, allowed) {
  for (const k of Object.keys(obj || {})) if (!allowed.has(k)) throw new BakeError(`${where}: unknown key '${k}'`);
}

/** dbebake TOML -> conf (paths relative to the TOML are joined with its folder). */
export function loadBakeConf(src, { path = 'bake.toml' } = {}) {
  let d;
  try { d = typeof src === 'string' || src instanceof Uint8Array ? parseToml(src) : src; } catch (e) {
    throw new BakeError(`${path}: TOML syntax error: ${e.message}`);
  }
  if (d.format !== 'dbebake' || d.version !== 1) throw new BakeError(`${path}: format = "dbebake" and version = 1 expected`);
  keys(path, d, TOP);
  const b = d.bake || {};
  keys(`${path} [bake]`, b, BAKE);
  if (!b.scene) throw new BakeError(`${path} [bake]: scene missing (dbeview scene with the assets)`);
  const dir = pdir(path);
  const p = d.pack || {};
  keys(`${path} [pack]`, p, PACK);
  const conf = {
    path, dir,
    name: b.name || 'bake',
    scene: pjoin(dir, b.scene),
    map: b.map ? pjoin(dir, b.map) : null,
    out: pjoin(dir, b.out || '.'),
    load: b.load ?? null,
    pool: p.pool || null,
    dapLoad: p.dap_load ?? null,
    rxvUsPerByte: p.rxv_us_per_byte ?? RXV_US_PER_BYTE,
    anims: [],
  };
  if (conf.pool && !(Array.isArray(conf.pool) && conf.pool.length === 2 && conf.pool[0] < conf.pool[1])) {
    throw new BakeError(`${path} [pack]: pool = [start, end] expected`);
  }
  (d.anim || []).forEach((a, i) => {
    const w = `${path} [[anim]] ${i + 1}`;
    keys(w, a, ANIM);
    if (!Array.isArray(a.at) || a.at.length !== 2) throw new BakeError(`${w}: at = [x, y] expected`);
    if (!Array.isArray(a.frames) || a.frames.length < 2) throw new BakeError(`${w}: frames = [style, style, ...] (at least 2) expected`);
    for (const f of a.frames) if (!Number.isInteger(f) || f < 0 || f > 255) throw new BakeError(`${w}: frame style ${f} outside 0 ... 255`);
    let views = a.views ?? 'auto';
    if (views !== 'auto') {
      if (!Array.isArray(views)) throw new BakeError(`${w}: views = "auto" or [[x, y, "N"], ...] expected`);
      views = views.map((v) => ({ x: v[0], y: v[1], dir: dirOf(v[2]) }));
    }
    conf.anims.push({ name: a.name || `anim${i}`, at: a.at, face: dirOf(a.face ?? 'S'), frames: a.frames, views,
      depths: a.depths ?? null });
  });
  return conf;
}

// ---------------------------------------------------------------- visibility

const BIG_BUF = [0x0200, 0xC000];           // no truncation: the tools want to see everything VIEW would draw

/** Player positions: cells whose tile is not SOLID, all four facings. */
export function viewpoints(m) {
  const out = [];
  for (let c = 0; c < m.cells.length; c++) {
    if (m.tiles[m.cells[c]].flags & M.FLAGS.solid) continue;
    for (let dir = 0; dir < 4; dir++) out.push({ pos: c, dir });
  }
  return out;
}

/** Wall faces drawn from each viewpoint: [{pos, dir, cell, face, style, slot, art, d, s, x, y, w, h, res, drawn}]. */
export function visibility(scene, vps = null) {
  const sc = scene.copy();
  sc.buf = BIG_BUF.slice();
  sc.automap = false;
  sc.objects = [];
  const out = [];
  for (const { pos, dir } of vps || viewpoints(sc.dmp)) {
    sc.pos = pos;
    sc.dir = dir;
    sc.trace = [];
    V.view(sc);
    for (const r of sc.trace) out.push({ pos, dir, ...r });
  }
  return out;
}

/** Problems: a style >= 2 visible where it has no image of its own (fallback to style 1 or nothing), grouped
 *  by (style, slot, cell, face); stats per style: slots with own image seen, fallback/none counts. */
export function checkVisibility(records) {
  const groups = new globalThis.Map();
  const styles = {};
  for (const r of records) {
    if (r.style === 0) continue;
    const st = styles[r.style] || (styles[r.style] = { own: new Set(), fallback: new Set(), none: new Set() });
    const name = slotName(r);
    st[r.res === 'own' ? 'own' : r.res === 'fallback' ? 'fallback' : 'none'].add(name);
    if (r.res === 'own' || r.style === 1) continue;
    const k = `${r.style}|${r.cell}|${r.face}`;
    if (!groups.has(k)) groups.set(k, { style: r.style, cell: r.cell, face: r.face, slots: new globalThis.Map() });
    const g = groups.get(k);
    if (!g.slots.has(name)) g.slots.set(name, { slot: name, res: r.res, from: [] });
    g.slots.get(name).from.push({ pos: r.pos, dir: r.dir });
  }
  const problems = [...groups.values()].map((g) => ({ ...g, slots: [...g.slots.values()].sort((a, b) => (a.slot < b.slot ? -1 : 1)) }))
    .sort((a, b) => a.style - b.style || a.cell - b.cell || a.face - b.face);
  const stats = {};
  for (const [s, v] of Object.entries(styles)) stats[s] = { own: [...v.own].sort(), fallback: [...v.fallback].sort(), none: [...v.none].sort() };
  return { problems, styles: stats };
}

// ---------------------------------------------------------------- baking

/** Map copy in which cell `cell` has its own tile whose face `face` shows wall style `style`. */
export function withFace(m, cell, face, style) {
  const m2 = m.clone();
  const t = m2.tiles[m2.cells[cell]].clone();
  t.walls[face] = style;
  t.name = `${t.name || 'tile'}~bake`;
  m2.tiles.push(t);
  if (m2.tiles.length > 255) throw new BakeError('bake: too many tiles (255)');
  m2.cells[cell] = m2.tiles.length - 1;
  return m2;
}

/** Window bytes of the scene (rows); throws if VIEW leaves bytes of the window unpainted. */
export function windowRows(sc) {
  const s = sc.copy();
  s.buf = BIG_BUF.slice();
  const [a] = V.renderView(s, null, null, 0);
  const [b] = V.renderView(s, null, null, 1);
  const ra = V.windowBytes(s, a), rb = V.windowBytes(s, b);
  for (let y = 0; y < ra.length; y++) {
    for (let x = 0; x < ra[y].length; x++) {
      if (ra[y][x] !== rb[y][x]) throw new BakeError(`view window not fully painted at (${x}, ${y})`);
    }
  }
  return ra;
}

/** Bake one animation: {name, cell, face, frames, views: [{pos, dir, d, slot, rect: {x, y, w, h}, frames: [Uint8Array]}],
 *  skipped: [{pos, dir, why}]}. Each frame patch is the opaque byte rectangle of the window (row by row). */
export function bakeAnim(scene, anim) {
  const m = scene.dmp;
  const [ax, ay] = anim.at;
  if (ax < 0 || ay < 0 || ax >= m.width || ay >= m.height) throw new BakeError(`${anim.name}: at = [${ax}, ${ay}] outside the map`);
  const cell = ay * m.width + ax;
  const maps = anim.frames.map((st) => withFace(m, cell, anim.face, st));
  let vps;
  const base = scene.copy();
  base.dmp = maps[0];
  if (anim.views === 'auto') {
    const seen = new globalThis.Map();
    for (let f = 0; f < maps.length; f++) {
      base.dmp = maps[f];
      for (const r of visibility(base)) {
        if (r.cell !== cell || r.face !== anim.face) continue;
        if (anim.depths && !anim.depths.includes(r.d)) continue;
        const k = r.pos * 4 + r.dir;
        if (!seen.has(k)) seen.set(k, { pos: r.pos, dir: r.dir, d: r.d, slot: slotName(r) });
      }
    }
    vps = [...seen.values()].sort((a, b) => a.pos - b.pos || a.dir - b.dir);
  } else {
    vps = anim.views.map((v) => ({ pos: v.y * m.width + v.x, dir: v.dir, d: null, slot: null }));
  }
  const views = [], skipped = [];
  for (const vp of vps) {
    const rows = maps.map((mm) => {
      const s = scene.copy();
      s.dmp = mm;
      s.pos = vp.pos;
      s.dir = vp.dir;
      s.objects = [];
      return windowRows(s);
    });
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let f = 1; f < rows.length; f++) {
      for (let y = 0; y < rows[0].length; y++) {
        for (let x = 0; x < rows[0][y].length; x++) {
          if (rows[f][y][x] !== rows[0][y][x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
      }
    }
    if (x1 < 0) { skipped.push({ pos: vp.pos, dir: vp.dir, why: 'frames look the same from here' }); continue; }
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const frames = rows.map((r) => {
      const p = new Uint8Array(rect.w * rect.h);
      for (let y = 0; y < rect.h; y++) p.set(r[rect.y + y].subarray(rect.x, rect.x + rect.w), y * rect.w);
      return p;
    });
    views.push({ pos: vp.pos, dir: vp.dir, d: vp.d, slot: vp.slot, rect, frames });
  }
  return { name: anim.name, cell, face: anim.face, frames: anim.frames.slice(), views, skipped };
}

/** DAP v0 (draft) + VRAM data. DAP: load (2), "DA", version, nanim; per anim: cell (2), face, nframes, nviews; per view:
 *  pos (2), dir, x, y, w, h, offset of frame 0 in the VRAM data (2); frames follow each other (w*h bytes each). */
export function toDap(baked, load = 0x5000) {
  const data = [];
  const out = [load & 255, load >> 8, 0x44, 0x41, FORMAT_VERSION, baked.length];
  for (const a of baked) {
    out.push(a.cell & 255, a.cell >> 8, a.face, a.frames.length, a.views.length);
    for (const v of a.views) {
      const ofs = data.length;
      if (ofs > 0xFFFF) throw new BakeError('bake: VRAM data of the animations exceeds 64 KB');
      out.push(v.pos & 255, v.pos >> 8, v.dir, v.rect.x, v.rect.y, v.rect.w, v.rect.h, ofs & 255, ofs >> 8);
      for (const f of v.frames) for (const b of f) data.push(b);
    }
  }
  return { dap: Uint8Array.from(out), vram: Uint8Array.from(data) };
}

// ---------------------------------------------------------------- packing

const KIND_OF = { dts: null, dbg: 'dbg', s2: 's2', dvg: 'dvg', dmp: 'dmp' };

/** Zone layout. bank1: [{name, kind, load, len}], vram: [{name, base, len, stream}] packed from pool[0].
 *  Returns {bank1, vram, poolEnd, loadUs, errors, warnings}. */
export function pack(bank1Files, vrlFiles, { pool = null, rxvUsPerByte = RXV_US_PER_BYTE } = {}) {
  const errors = [], warnings = [];
  const spans = bank1Files.map((f) => ({ ...f, end: f.load + f.len })).sort((a, b) => a.load - b.load);
  for (let i = 0; i + 1 < spans.length; i++) {
    if (spans[i + 1].load < spans[i].end) errors.push(`bank 1: ${spans[i].name} and ${spans[i + 1].name} overlap`);
  }
  for (const s of spans) {
    if (!s.kind) continue;
    const e = mem.rangeError(s.kind, s.load, s.len);
    if (e) errors.push(`${s.name}: ${e}`);
  }
  let base = pool ? pool[0] : 0;
  const vram = [];
  let loadUs = 0;
  for (const f of vrlFiles) {
    vram.push({ name: f.name, base, len: f.len, stream: f.stream, us: Math.round(f.len * rxvUsPerByte) });
    loadUs += f.len * rxvUsPerByte;
    base += f.len;
  }
  if (pool && base > pool[1]) errors.push(`VRAM pool: end ${base} > ${pool[1]} (${base - pool[1]} bytes too many)`);
  if (!pool) warnings.push('no [pack] pool: VRAM bases from 0, no pool check');
  return { bank1: spans, vram, poolEnd: base, loadUs: Math.round(loadUs), errors, warnings };
}

/** First free address of at least len bytes in the bank 1 windows, behind the used spans. */
export function freeBank1(spans, len) {
  for (const [wa, we] of mem.WINDOWS) {
    let a = wa;
    for (const s of [...spans].sort((x, y) => x.load - y.load)) {
      if (s.end <= a || s.load >= we) continue;
      if (s.load - a >= len) break;
      a = Math.max(a, s.end);
    }
    if (a + len <= we) return a;
  }
  return null;
}

// ---------------------------------------------------------------- build

function sceneRefs(cfg) {
  const out = [];
  for (const k of ['walls', 'floor', 'ceil']) if (cfg[k]) out.push({ name: k, kind: k === 'walls' ? 'wall' : k === 'ceil' ? 'ceiling' : 'floor', bin: cfg[k].dts, vrl: cfg[k].vrl });
  if (cfg.background) out.push({ name: 'background', kind: 'dbg', bin: cfg.background.dbg, vrl: cfg.background.vrl });
  for (const sp of cfg.sprites || []) out.push({ name: `sprites${sp.set}`, kind: 's2', bin: sp.s2, vrl: sp.vrl });
  return out;
}

/** The whole build: {files, report, warnings, errors, scene, records, check, baked, layout, conf}.
 *  resolve(path) -> Uint8Array | null with paths joined from the TOML folder (like tex.js). */
export function buildBake(src, { path = 'bake.toml', resolve } = {}) {
  const conf = loadBakeConf(src, { path });
  const rd = (p) => {
    const b = resolve(p);
    if (!b) throw new BakeError(`${p}: not found`);
    return b;
  };
  const sdir = pdir(conf.scene);
  const scfg = parseToml(rd(conf.scene));
  const scene = V.loadScene(scfg, (rel) => rd(pjoin(sdir, rel)), conf.scene);
  if (conf.map) scene.dmp = M.loadsToml(rd(conf.map), conf.map);
  const warnings = [], errors = [];
  if (!scene.dts[V.KIND_WALL]) warnings.push('scene without wall DTS: nothing to check');

  const records = visibility(scene);
  const check = checkVisibility(records);
  for (const p of check.problems) {
    const m = scene.dmp;
    const fb = p.slots.filter((x) => x.res === 'fallback').map((x) => x.slot);
    const no = p.slots.filter((x) => x.res !== 'fallback').map((x) => x.slot);
    warnings.push(`style ${p.style} at (${p.cell % m.width}, ${Math.floor(p.cell / m.width)}) face ${DIRS[p.face]}: visible without an image `
      + `of its own in ${[fb.length ? `${fb.join(' ')} (shows style 1)` : '', no.length ? `${no.join(' ')} (shows nothing)` : ''].filter(Boolean).join(', ')}`);
  }

  const baked = conf.anims.map((a) => bakeAnim(scene, a));
  const files = {};
  const name = conf.name;
  const bank1 = [], vrls = [];
  const asset = (n, kind, prg) => bank1.push({ name: n, kind, load: prg[0] | (prg[1] << 8), len: prg.length - 2 });
  asset('dvg', 'dvg', rd(pjoin(sdir, scfg.scene.dvg)));
  const dmp = M.toDmp(scene.dmp);
  asset('map', 'dmp', dmp);
  for (const r of sceneRefs(scfg)) {
    asset(r.name, r.kind, rd(pjoin(sdir, r.bin)));
    const v = vrl.unpackFile(rd(pjoin(sdir, r.vrl)));
    vrls.push({ name: r.name, len: v.u, stream: v.stream.length });
  }
  if (baked.length) {
    const { dap: dap0, vram } = toDap(baked, 0);
    let load = conf.dapLoad;
    if (load === null) {
      load = freeBank1(bank1.map((b) => ({ ...b, end: b.load + b.len })), dap0.length - 2);
      if (load === null) errors.push('no free bank 1 space for the animation table');
    }
    const { dap } = toDap(baked, load ?? 0);
    files[`${name}.dap`] = dap;
    bank1.push({ name: 'anims', kind: null, load: load ?? 0, len: dap.length - 2 });
    const stream = vrl.encode(Array.from(vram));
    files[`${name}.vrl`] = vrl.packFile(stream, conf.load ?? 0x9000);
    vrls.push({ name: 'anims', len: vram.length, stream: stream.length });
  }
  const layout = pack(bank1, vrls, { pool: conf.pool, rxvUsPerByte: conf.rxvUsPerByte });
  errors.push(...layout.errors);
  warnings.push(...layout.warnings);

  const report = {
    format: 'dbebake', version: 1, name, map: { name: scene.dmp.name, width: scene.dmp.width, height: scene.dmp.height },
    viewpoints: viewpoints(scene.dmp).length, faces_seen: records.length, problems: check.problems.length,
    styles: check.styles,
    anims: baked.map((a) => ({ name: a.name, cell: a.cell, face: DIRS[a.face], frames: a.frames,
      views: a.views.map((v) => ({ pos: v.pos, dir: DIRS[v.dir], d: v.d, slot: v.slot, rect: v.rect, bytes: v.rect.w * v.rect.h * a.frames.length })),
      skipped: a.skipped.length })),
    layout: { bank1: layout.bank1.map(({ name: n, load, len }) => ({ name: n, load, len })),
      vram: layout.vram.map(({ name: n, base, len, us }) => ({ name: n, base, len, us })), pool: conf.pool, pool_end: layout.poolEnd,
      load_ms: Math.round(layout.loadUs / 1000), rxv_us_per_byte: conf.rxvUsPerByte },
    warnings, errors,
  };
  files[`${name}.bake.json`] = JSON.stringify(report, null, 1) + '\n';
  files[`${name}.bake.md`] = reportMd(report, scene.dmp);
  return { files, report, warnings, errors, scene, records, check, baked, layout, conf };
}

export function reportMd(r, m) {
  const at = (c) => `(${c % m.width}, ${Math.floor(c / m.width)})`;
  const L = [`# Bake: ${r.name}`, '', `Map ${r.map.name} ${r.map.width} × ${r.map.height}: ${r.viewpoints} viewpoints, `
    + `${r.faces_seen} visible wall faces, ${r.problems} visibility problems.`, ''];
  L.push('## Wall styles: slots seen', '', '| style | own image | fallback to style 1 | nothing |', '|---|---|---|---|');
  for (const [s, v] of Object.entries(r.styles)) L.push(`| ${s} | ${v.own.length} | ${v.fallback.join(', ') || '–'} | ${v.none.join(', ') || '–'} |`);
  if (r.anims.length) {
    L.push('', '## Animations', '', '| anim | at | face | frames | viewpoint | slot | rect (x, y, w, h) | bytes |', '|---|---|---|---|---|---|---|---|');
    for (const a of r.anims) {
      for (const v of a.views) {
        L.push(`| ${a.name} | ${at(a.cell)} | ${a.face} | ${a.frames.join(' ')} | ${at(v.pos)} ${v.dir} | ${v.slot ?? ''} | `
          + `${v.rect.x}, ${v.rect.y}, ${v.rect.w}, ${v.rect.h} | ${v.bytes} |`);
      }
    }
  }
  L.push('', '## Layout', '', '| bank 1 | load | bytes |', '|---|---|---|');
  for (const b of r.layout.bank1) L.push(`| ${b.name} | ${hex4(b.load)} | ${b.len} |`);
  L.push('', '| VRAM | base | bytes | RXV (est.) |', '|---|---|---|---|');
  for (const v of r.layout.vram) L.push(`| ${v.name} | ${v.base} | ${v.len} | ${(v.us / 1000).toFixed(1)} ms |`);
  L.push('', `Pool end ${r.layout.pool_end}${r.layout.pool ? ` of ${r.layout.pool[1]}` : ''}; loading the zone with RXV takes about `
    + `${r.layout.load_ms} ms (${r.layout.rxv_us_per_byte} µs per byte, hardware measurement).`);
  if (r.errors.length || r.warnings.length) {
    L.push('', '## Messages', '');
    for (const e of r.errors) L.push(`- error: ${e}`);
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  return L.join('\n') + '\n';
}
