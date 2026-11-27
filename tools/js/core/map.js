// DBE map (DMP v1): build from TOML, write as TOML, text overview. Port of tools/dbemap.py.
//
// DMP: PRG file, 2 bytes load address (default $4000), then a 24-byte header, tile plane (W*H),
// content plane (W*H), tile table (NT * 8), events (NE * 4). Format: docs/formats.md ("DMP v1"),
// text format: docs/specs/P4-map.md, section 3.
// Cell index i = y * W + x; directions 0 N, 1 E, 2 S, 3 W (north = smaller y).
import { parseToml } from './io/toml.js';
import { defaultLoad, rangeError } from './mem.js';

export const FLAGS = Object.freeze({ solid: 1, blocksight: 2, occluding: 4, door: 8, automap: 16, content: 32, distant: 64 });
export const EVENT_TYPES = Object.freeze({ enemy: 1, teleport: 2, exit: 3, text: 4 });
export const SUBPOS_VIEW = Object.freeze([[0, 1, 3, 4, 2], [3, 0, 4, 1, 2], [4, 3, 1, 0, 2], [1, 4, 0, 3, 2]]);  // [v][q] -> p (2.6)
export const DIRS = 'NESW';
export const HEADER = 24;
export const MAX_CELLS = 16384;
export const WARN_CELLS = 4096;
export const LEGEND_POOL = '#.0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!$%&*+-/:;<=>?@^_~|';

/** Python raises ValueError; same message texts. */
export class MapError extends Error {
  constructor(msg) { super(msg); this.name = 'MapError'; }
}

export class Tile {
  constructor(walls, floor, ceiling, flags, automapChar, name = '') {
    this.walls = Array.from(walls);
    this.floor = floor;
    this.ceiling = ceiling;
    this.flags = flags;
    this.automapChar = automapChar;
    this.name = name;
  }

  clone() { return new Tile(this.walls, this.floor, this.ceiling, this.flags, this.automapChar, this.name); }

  /** Dataclass equality (name is not compared). */
  equals(o) {
    return o instanceof Tile && this.walls.length === o.walls.length && this.walls.every((v, i) => v === o.walls[i])
      && this.floor === o.floor && this.ceiling === o.ceiling && this.flags === o.flags && this.automapChar === o.automapChar;
  }
}

export class Event {
  constructor(cell, type, param) { this.cell = cell; this.type = type; this.param = param; }
  clone() { return new Event(this.cell, this.type, this.param); }
  equals(o) { return this.cell === o.cell && this.type === o.type && this.param === o.param; }
}

export class Map {
  constructor(name, width, height, tiles, cells, content, events, start, direction, outside) {
    Object.assign(this, { name, width, height, tiles, cells, content, events, start, direction, outside });
  }

  /** Deep copy (copy.deepcopy). */
  clone() {
    return new Map(this.name, this.width, this.height, this.tiles.map((t) => t.clone()), this.cells.slice(),
      this.content.slice(), this.events.map((e) => e.clone()), this.start, this.direction, this.outside);
  }

  /** Dataclass equality (name is not compared). */
  equals(o) {
    const eqArr = (a, b, f) => a.length === b.length && a.every((x, i) => f(x, b[i]));
    return o instanceof Map && this.width === o.width && this.height === o.height
      && eqArr(this.tiles, o.tiles, (a, b) => a.equals(b)) && eqArr(this.cells, o.cells, (a, b) => a === b)
      && eqArr(this.content, o.content, (a, b) => a === b) && eqArr(this.events, o.events, (a, b) => a.equals(b))
      && this.start === o.start && this.direction === o.direction && this.outside === o.outside;
  }
}

export function nullTile() { return new Tile([0, 0, 0, 0], 0, 0, 0, 0); }

const evKey = (a, b) => a.cell - b.cell || a.type - b.type || a.param - b.param;
export const sortEvents = (evs) => evs.slice().sort(evKey);

/** Tile face (0 N, 1 E, 2 S, 3 W) that is visible in viewing direction viewDir (2.4). */
export function face(viewDir, s, front) {
  if (front) return (viewDir + 2) & 3;
  return s < 0 ? (viewDir + 1) & 3 : (viewDir + 3) & 3;
}

const inr = (v, lo, hi) => v >= lo && v <= hi;

/** Check a map; MapError with a message on error. */
export function validate(m) {
  if (!inr(m.width, 1, 255) || !inr(m.height, 1, 255)) throw new MapError(`width/height ${m.width} x ${m.height} outside 1 ... 255`);
  const n = m.width * m.height;
  if (n > MAX_CELLS) throw new MapError(`map too large: ${m.width} x ${m.height} = ${n} > ${MAX_CELLS} cells`);
  const nt = m.tiles.length;
  if (!inr(nt, 1, 256)) throw new MapError(`number of tiles ${nt} outside 1 ... 256`);
  if (m.cells.length !== n || m.content.length !== n) throw new MapError('planes do not have W*H entries');
  m.tiles.forEach((t, i) => {
    if (t.walls.length !== 4 || [...t.walls, t.floor, t.ceiling, t.automapChar].some((v) => !inr(v, 0, 255))) {
      throw new MapError(`tile ${i}: style or character outside 0 ... 255`);
    }
    if (!inr(t.flags, 0, 127)) throw new MapError(`tile ${i}: invalid flags ${t.flags} (bit 7 is reserved)`);
  });
  m.cells.forEach((c, i) => { if (!(c >= 0 && c < nt)) throw new MapError(`cell ${i}: tile index ${c} >= NT ${nt}`); });
  m.content.forEach((c, i) => { if (!inr(c, 0, 255)) throw new MapError(`cell ${i}: invalid content ${c}`); });
  if (m.events.length > 65535) throw new MapError('too many events');
  for (const e of m.events) {
    if (!(e.cell >= 0 && e.cell < n)) throw new MapError(`event: cell ${e.cell} outside the map`);
    if (!inr(e.type, 1, 255)) throw new MapError(`event in cell ${e.cell}: type ${e.type} invalid (1 ... 255)`);
    if (!inr(e.param, 0, 255)) throw new MapError(`event in cell ${e.cell}: parameter ${e.param} outside 0 ... 255`);
  }
  if (!(m.start >= 0 && m.start < n)) throw new MapError(`start cell ${m.start} outside the map`);
  if (!inr(m.direction, 0, 3)) throw new MapError(`start direction ${m.direction} outside 0 ... 3`);
  if (!(m.outside >= 0 && m.outside < nt)) throw new MapError(`outside tile ${m.outside} >= NT ${nt}`);
  if (m.tiles[m.cells[m.start]].flags & FLAGS.solid) throw new MapError(`start (cell ${m.start}) lies on a tile with SOLID`);
}

/** List of warnings (no abort). */
export function warningsFor(m) {
  const w = [];
  if (m.width * m.height > WARN_CELLS) w.push(`${m.width * m.height} cells > ${WARN_CELLS}: the lib keeps the map in bank 1`);
  m.tiles.forEach((t, i) => {
    if (t.flags & FLAGS.content && !t.walls.some((v) => v)) {
      w.push(`tile ${i} (${t.name || i}): flag content without wall faces has no effect`);
    }
  });
  return w;
}

/** Create the map as a DMP PRG (with load address). Returns Uint8Array. */
export function toDmp(m, load = null) {
  validate(m);
  if (load === null || load === undefined) load = defaultLoad('dmp');
  const n = m.width * m.height, nt = m.tiles.length;
  const events = sortEvents(m.events);
  const oCells = HEADER, oContent = oCells + n, oTiles = oContent + n, oEvents = oTiles + 8 * nt;
  const total = oEvents + 4 * events.length;
  const out = new Uint8Array(2 + total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, load, true);
  out.set([0x44, 0x4D, 1, m.width, m.height, nt & 255], 2);
  dv.setUint16(8, events.length, true);
  dv.setUint16(10, m.start, true);
  out[12] = m.direction; out[13] = m.outside;
  [oCells, oContent, oTiles, oEvents, total, 0].forEach((v, i) => dv.setUint16(14 + 2 * i, v, true));
  out.set(m.cells, 2 + oCells);
  out.set(m.content, 2 + oContent);
  m.tiles.forEach((t, i) => out.set([...t.walls, t.floor, t.ceiling, t.flags, t.automapChar], 2 + oTiles + 8 * i));
  events.forEach((e, i) => {
    dv.setUint16(2 + oEvents + 4 * i, e.cell, true);
    out[2 + oEvents + 4 * i + 2] = e.type; out[2 + oEvents + 4 * i + 3] = e.param;
  });
  return out;
}

/** Abort (MapError) if the map extends beyond its area of the bank 1 memory map. */
export function checkBank1(load, length) {
  const err = rangeError('dmp', load, length);
  if (err) throw new MapError(err);
}

const hex2 = (v) => '0x' + v.toString(16).padStart(2, '0');

/** Read a DMP PRG (with load address); MapError on format errors. */
export function fromDmp(data) {
  if (data.length < 2 + HEADER) throw new MapError('file shorter than the header');
  const b = data.subarray(2);
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  if (b[0] !== 0x44 || b[1] !== 0x4D) throw new MapError("wrong magic ('DM' expected)");
  if (b[2] !== 1) throw new MapError(`Version ${b[2]} not supported (1 expected)`);
  const w = b[3], h = b[4], nt = b[5] || 256;
  const ne = u16(6), start = u16(8), direction = b[10], outside = b[11];
  const [oCells, oContent, oTiles, oEvents, total, res] = [12, 14, 16, 18, 20, 22].map(u16);
  if (w < 1 || h < 1) throw new MapError('width/height 0');
  const n = w * h;
  if (n > MAX_CELLS) throw new MapError(`map too large: ${n} cells`);
  const exp = [HEADER, HEADER + n, HEADER + 2 * n, HEADER + 2 * n + 8 * nt, HEADER + 2 * n + 8 * nt + 4 * ne];
  if ([oCells, oContent, oTiles, oEvents, total].some((v, i) => v !== exp[i])) {
    throw new MapError('offsets in the header do not match W, H, NT, NE');
  }
  if (res) throw new MapError('reserved header bytes not 0');
  if (b.length < total) throw new MapError(`file too short: ${b.length} < ${total} bytes of content`);
  const cells = Array.from(b.subarray(oCells, oCells + n));
  const content = Array.from(b.subarray(oContent, oContent + n));
  const tiles = [];
  for (let i = 0; i < nt; i++) {
    const r = b.subarray(oTiles + 8 * i, oTiles + 8 * i + 8);
    if (r[6] & 0x80) throw new MapError(`tile ${i}: reserved flag bit 7 set (${hex2(r[6])})`);
    tiles.push(new Tile(Array.from(r.subarray(0, 4)), r[4], r[5], r[6], r[7], `k${i}`));
  }
  const events = [];
  for (let i = 0; i < ne; i++) {
    const o = oEvents + 4 * i;
    events.push(new Event(u16(o), b[o + 2], b[o + 3]));
  }
  const m = new Map('', w, h, tiles, cells, content, events, start, direction, outside);
  cells.forEach((c, i) => { if (c >= nt) throw new MapError(`cell ${i}: tile index ${c} >= NT ${nt}`); });
  if (start >= n) throw new MapError(`start cell ${start} >= W*H ${n}`);
  if (direction > 3) throw new MapError(`start direction ${direction} invalid`);
  if (outside >= nt) throw new MapError(`outside tile ${outside} >= NT ${nt}`);
  for (const e of events) {
    if (e.cell >= n || e.type === 0) throw new MapError(`invalid event in cell ${e.cell}, type ${e.type}`);
  }
  for (let i = 1; i < events.length; i++) {
    if (evKey(events[i - 1], events[i]) > 0) throw new MapError('events not sorted');
  }
  return m;
}

// ---------------------------------------------------------------- read TOML

/** Python repr() of the values that occur in TOML documents (for error messages). */
export function pyRepr(v) {
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = '';
    for (const c of v) {
      const o = c.codePointAt(0);
      if (c === '\\') s += '\\\\';
      else if (c === q) s += '\\' + q;
      else if (c === '\n') s += '\\n';
      else if (c === '\r') s += '\\r';
      else if (c === '\t') s += '\\t';
      else if (o < 32 || o === 127) s += '\\x' + o.toString(16).padStart(2, '0');
      else s += c;
    }
    return q + s + q;
  }
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloat(v);
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (v === null || v === undefined) return 'None';
  if (v instanceof Date) return String(v);
  if (typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ') + '}';
  return String(v);
}

function pyFloat(v) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  return String(v);
}

const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, dflt) => (has(o, k) ? o[k] : dflt);
const firstExtra = (d, allowed) => Object.keys(d).filter((k) => !allowed.includes(k)).sort()[0];
const cpLen = (s) => Array.from(s).length;

function err(src, msg) { return new MapError(`${src}: ${msg}`); }

// Note: smol-toml returns integers and integral floats both as Number, so "1.0" passes as an int here
// (tomllib would report it as outside the range).
function int(src, where, v, lo, hi) {
  if (typeof v !== 'number' || !Number.isInteger(v) || !(v >= lo && v <= hi)) {
    throw err(src, `${where}: ${pyRepr(v)} outside ${lo} ... ${hi}`);
  }
  return v;
}

function event(src, where, d) {
  if (!isDict(d)) throw err(src, `${where}: table expected`);
  const extra = firstExtra(d, ['type', 'param', 'at']);
  if (extra !== undefined) throw err(src, `${where}: unknown key ${pyRepr(extra)}`);
  if (!has(d, 'type')) throw err(src, `${where}: 'type' missing`);
  let t = d.type;
  if (typeof t === 'string') {
    if (!has(EVENT_TYPES, t)) throw err(src, `${where}: unknown event type ${pyRepr(t)}`);
    t = EVENT_TYPES[t];
  } else t = int(src, `${where} type`, t, 1, 255);
  return [t, int(src, `${where} param`, get(d, 'param', 0), 0, 255)];
}

/** Read a map from TOML text (string or bytes); error messages begin with src. */
export function loadsToml(text, src = '<string>') {
  let d;
  try {
    d = parseToml(text);
  } catch (e) {
    throw err(src, `TOML syntax error: ${e.message}`);
  }
  if (get(d, 'format', 'dbemap') !== 'dbemap') throw err(src, `format ${pyRepr(d.format)} is not 'dbemap'`);
  if (get(d, 'version', 1) !== 1) throw err(src, `version ${pyRepr(d.version)} not supported`);
  let extra = firstExtra(d, ['format', 'version', 'map', 'tiles', 'legend', 'layers', 'events', 'marks']);
  if (extra !== undefined) throw err(src, `unknown key ${pyRepr(extra)}`);
  const mp = get(d, 'map', {});
  if (!isDict(mp)) throw err(src, '[map] must be a table');
  extra = firstExtra(mp, ['name', 'start', 'dir', 'outside']);
  if (extra !== undefined) throw err(src, `map: unknown key ${pyRepr(extra)}`);
  // tiles
  const tdefs = d.tiles;
  if (!isDict(tdefs) || !Object.keys(tdefs).length) throw err(src, 'section [tiles.<name>] missing');
  const hasIndex = Object.values(tdefs).map((t) => has(t, 'index'));
  if (hasIndex.some((x) => x) && !hasIndex.every((x) => x)) throw err(src, "'index' must be present on all tiles or on none");
  let tiles, order;
  const names = {};
  if (hasIndex.every((x) => x)) {
    const used = new globalThis.Map();
    for (const [name, t] of Object.entries(tdefs)) {
      const idx = int(src, `tiles.${name}.index`, t.index, 0, 255);
      if (used.has(idx)) throw err(src, `tiles.${name}: index ${idx} duplicate (also ${used.get(idx)})`);
      used.set(idx, name);
    }
    tiles = Array.from({ length: Math.max(...used.keys()) + 1 }, nullTile);
    order = Object.entries(tdefs).map(([n, t]) => [t.index, n]);
  } else {
    order = Object.keys(tdefs).map((n, i) => [i, n]);
    tiles = new Array(order.length).fill(null);
  }
  if (tiles.length > 256) throw err(src, 'more than 256 tiles');
  for (const [idx, name] of order) {
    const t = tdefs[name];
    const where = `tiles.${name}`;
    extra = firstExtra(t, ['walls', 'floor', 'ceiling', 'flags', 'automap_char', 'index']);
    if (extra !== undefined) throw err(src, `${where}: unknown key ${pyRepr(extra)}`);
    let w = get(t, 'walls', 0);
    if (Array.isArray(w)) {
      if (w.length !== 4) throw err(src, `${where}.walls: exactly 4 numbers expected`);
      w = w.map((v) => int(src, `${where}.walls`, v, 0, 255));
    } else {
      const v = int(src, `${where}.walls`, w, 0, 255);
      w = [v, v, v, v];
    }
    let fl = 0;
    const fv = get(t, 'flags', []);
    if (!Array.isArray(fv)) throw err(src, `${where}.flags: list expected`);
    for (const f of fv) {
      if (typeof f !== 'string' || !has(FLAGS, f)) throw err(src, `${where}.flags: unknown flag ${pyRepr(f)}`);
      fl |= FLAGS[f];
    }
    tiles[idx] = new Tile(w, int(src, `${where}.floor`, get(t, 'floor', 0), 0, 255),
      int(src, `${where}.ceiling`, get(t, 'ceiling', 0), 0, 255), fl,
      int(src, `${where}.automap_char`, get(t, 'automap_char', 0), 0, 255), name);
    names[name] = idx;
  }
  // legend
  const legend = {};
  for (const [ch, v0] of Object.entries(get(d, 'legend', {}))) {
    let v = v0;
    if (cpLen(ch) !== 1 || /^\s$/u.test(ch)) throw err(src, `legend: key ${pyRepr(ch)} must be exactly one visible character`);
    if (typeof v === 'string') v = { tile: v };
    if (!isDict(v) || !has(v, 'tile')) throw err(src, `legend ${pyRepr(ch)}: tile name or table with 'tile' expected`);
    extra = firstExtra(v, ['tile', 'item', 'events']);
    if (extra !== undefined) throw err(src, `legend ${pyRepr(ch)}: unknown key ${pyRepr(extra)}`);
    if (typeof v.tile !== 'string' || !has(names, v.tile)) throw err(src, `legend ${pyRepr(ch)}: unknown tile ${pyRepr(v.tile)}`);
    const item = int(src, `legend ${pyRepr(ch)} item`, get(v, 'item', 0), 0, 63);
    const evs = get(v, 'events', []).map((e) => event(src, `legend ${pyRepr(ch)} events`, e));
    legend[ch] = [names[v.tile], item, evs];
  }
  // map
  const layers = get(d, 'layers', {});
  if (!isDict(layers)) throw err(src, '[layers] must be a table');
  extra = firstExtra(layers, ['tiles']);
  if (extra !== undefined) throw err(src, `layers: unknown key ${pyRepr(extra)}`);
  if (typeof layers.tiles !== 'string') throw err(src, 'layers.tiles missing');
  const rows = layers.tiles.split('\n');
  if (rows.length && rows[0] === '') rows.shift();
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  if (!rows.length) throw err(src, 'map is empty');
  const width = cpLen(rows[0]), height = rows.length;
  if (!inr(width, 1, 255) || !inr(height, 1, 255)) throw err(src, `map ${width} x ${height}: width/height outside 1 ... 255`);
  if (width * height > MAX_CELLS) throw err(src, `map ${width} x ${height} = ${width * height} > ${MAX_CELLS} cells`);
  const cells = [], content = [], events = [];
  rows.forEach((row, y) => {
    const stripped = row.replace(/[ \t]+$/, '');
    if (row !== stripped) throw err(src, `map row ${y + 1}, column ${cpLen(stripped) + 1}: trailing whitespace`);
    const chars = Array.from(row);
    if (chars.length !== width) throw err(src, `map row ${y + 1}: length ${chars.length} instead of ${width}`);
    chars.forEach((ch, x) => {
      if (!has(legend, ch)) throw err(src, `map row ${y + 1}, column ${x + 1}: character ${pyRepr(ch)} not in the legend`);
      const [t, item, evs] = legend[ch];
      cells.push(t);
      content.push(item);
      for (const [et, ep] of evs) events.push(new Event(y * width + x, et, ep));
    });
  });
  const at = (tbl, where) => {
    const a = tbl.at;
    if (!(Array.isArray(a) && a.length === 2)) throw err(src, `${where}: 'at' = [x, y] expected`);
    const x = int(src, `${where} at x`, a[0], 0, width - 1);
    const yy = int(src, `${where} at y`, a[1], 0, height - 1);
    return yy * width + x;
  };
  get(d, 'events', []).forEach((e, i) => {
    const where = `events[${i + 1}]`;
    const [et, ep] = event(src, where, e);
    events.push(new Event(at(e, where), et, ep));
  });
  get(d, 'marks', []).forEach((mk, i) => {
    const where = `marks[${i + 1}]`;
    extra = firstExtra(mk, ['at', 'seen', 'mark']);
    if (extra !== undefined) throw err(src, `${where}: unknown key ${pyRepr(extra)}`);
    for (const k of ['seen', 'mark']) {
      if (typeof get(mk, k, false) !== 'boolean') throw err(src, `${where}.${k}: true or false expected`);
    }
    const c = at(mk, where);
    content[c] |= (get(mk, 'mark', true) ? 0x80 : 0) | (get(mk, 'seen', false) ? 0x40 : 0);
  });
  // header
  for (const k of ['start', 'dir', 'outside']) if (!has(mp, k)) throw err(src, `map.${k} missing`);
  const st = mp.start;
  if (!(Array.isArray(st) && st.length === 2)) throw err(src, 'map.start = [x, y] expected');
  const sx = int(src, 'map.start x', st[0], 0, width - 1);
  const sy = int(src, 'map.start y', st[1], 0, height - 1);
  if (typeof mp.dir !== 'string' || mp.dir.length !== 1 || !DIRS.includes(mp.dir)) {
    throw err(src, `map.dir ${pyRepr(mp.dir)}: N, E, S or W expected`);
  }
  if (typeof mp.outside !== 'string' || !has(names, mp.outside)) throw err(src, `map.outside: unknown tile ${pyRepr(mp.outside)}`);
  const nm = has(mp, 'name') ? (typeof mp.name === 'string' ? mp.name : pyRepr(mp.name)) : '';
  const m = new Map(nm, width, height, tiles, cells, content, sortEvents(events),
    sy * width + sx, DIRS.indexOf(mp.dir), names[mp.outside]);
  try {
    validate(m);
  } catch (e) {
    if (e instanceof MapError) throw err(src, e.message);
    throw e;
  }
  return m;
}

// ---------------------------------------------------------------- write TOML

/** TOML basic string with escaping. */
export function q(s) {
  let out = '';
  for (const c of s) {
    const o = c.codePointAt(0);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (o < 32 || o === 127) out += `\\u${o.toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return '"' + out + '"';
}

const cmpPair = (a, b) => a[0] - b[0] || a[1] - b[1];

/** Map as TOML (tiles k<index> with index, legend automatic).
 *  legend: optional {character: [tile index, item]}; must cover all occurring pairs. */
export function toToml(m, legend = null) {
  validate(m);
  const pk = (t, it) => t * 256 + it;
  const pairSet = new Set(m.cells.map((c, i) => pk(c, m.content[i] & 0x3F)));
  const pairs = [...pairSet].sort((a, b) => a - b).map((k) => [k >> 8, k & 255]);
  if (legend === null || legend === undefined) {
    if (pairs.length > LEGEND_POOL.length) throw new MapError('too many combinations for an ASCII map');
    legend = {};
    pairs.forEach((p, i) => { legend[LEGEND_POOL[i]] = p; });
  }
  const ents = Object.entries(legend);
  const rev = new globalThis.Map(ents.map(([ch, p]) => [pk(p[0], p[1]), ch]));
  const L = ['format  = "dbemap"', 'version = 1', '', '[map]', `name    = ${q(m.name)}`,
    `start   = [${m.start % m.width}, ${Math.floor(m.start / m.width)}]`, `dir     = "${DIRS[m.direction]}"`,
    `outside = "k${m.outside}"`, ''];
  m.tiles.forEach((t, i) => {
    L.push(`[tiles.k${i}]`, `index   = ${i}`, `walls   = [${t.walls.join(', ')}]`, `floor   = ${t.floor}`,
      `ceiling = ${t.ceiling}`,
      'flags   = [' + Object.entries(FLAGS).filter(([, b]) => t.flags & b).map(([n]) => q(n)).join(', ') + ']',
      `automap_char = ${t.automapChar}`, '');
  });
  L.push('[legend]');
  const sorted = ents.map((e, i) => [e, i]).sort((a, b) => cmpPair(a[0][1], b[0][1]) || a[1] - b[1]).map((x) => x[0]);
  for (const [ch, [tile, item]] of sorted) {
    if (pairSet.has(pk(tile, item))) {
      const v = item ? `{ tile = "k${tile}", item = ${item} }` : `"k${tile}"`;
      L.push(`${q(ch)} = ${v}`);
    }
  }
  L.push('', '[layers]', 'tiles = """');
  for (let y = 0; y < m.height; y++) {
    let row = '';
    for (let x = 0; x < m.width; x++) {
      const i = y * m.width + x;
      row += rev.get(pk(m.cells[i], m.content[i] & 0x3F));
    }
    L.push(row.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
  }
  L.push('"""', '');
  const tname = Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [v, k]));
  for (const e of sortEvents(m.events)) {
    L.push('[[events]]', `at    = [${e.cell % m.width}, ${Math.floor(e.cell / m.width)}]`,
      `type  = ${has(tname, e.type) ? q(tname[e.type]) : e.type}`, `param = ${e.param}`, '');
  }
  m.content.forEach((c, i) => {
    if (c & 0xC0) {
      L.push('[[marks]]', `at = [${i % m.width}, ${Math.floor(i / m.width)}]`);
      if ((c & 0x80) === 0) L.push('mark = false');
      if (c & 0x40) L.push('seen = true');
      L.push('');
    }
  });
  return L.join('\n');
}

// ---------------------------------------------------------------- text overview

const p3 = (v) => String(v).padStart(3);

export function describe(m) {
  const tname = Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [v, k]));
  const W = m.width;
  const L = [`map ${m.width} x ${m.height}, ${m.tiles.length} tiles, ${m.events.length} events`,
    `start: cell ${m.start} (${m.start % W}, ${Math.floor(m.start / W)}), direction ${DIRS[m.direction]}`,
    `outside tile: ${m.outside}`, '', 'tiles (no.: N E S W floor ceiling flags automap):'];
  m.tiles.forEach((t, i) => {
    const fl = Object.entries(FLAGS).filter(([, b]) => t.flags & b).map(([n]) => n).join(',') || '-';
    L.push(`  ${p3(i)}: ${t.walls.map(p3).join(' ')}  ${p3(t.floor)} ${p3(t.ceiling)}  ${fl}  ${t.automapChar}`);
  });
  L.push('', 'tile plane:');
  for (let y = 0; y < m.height; y++) {
    L.push(m.cells.slice(y * W, (y + 1) * W).map((c) => c.toString(16).padStart(2, '0')).join(' '));
  }
  const items = m.content.map((c, i) => [i, c]).filter(([, c]) => c);
  L.push('', `content (${items.length} cells):`);
  for (const [i, c] of items) {
    L.push(`  (${i % W}, ${Math.floor(i / W)}): item ${c & 63}` + (c & 0x40 ? ' seen' : '') + (c & 0x80 ? ' mark' : ''));
  }
  L.push('', 'events:');
  for (const e of m.events) L.push(`  (${e.cell % W}, ${Math.floor(e.cell / W)}): ${has(tname, e.type) ? tname[e.type] : e.type} ${e.param}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- editor writer (P8 6.1)

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** (tile, item) -> legend character of the TOML the map came from (events of legend entries are not kept). */
export function legendFromToml(text, m) {
  const d = parseToml(text);
  const byName = new globalThis.Map(m.tiles.map((t, i) => [t.name, i]));
  const out = new globalThis.Map();
  for (const [ch, v] of Object.entries(d.legend || {})) {
    const name = typeof v === 'string' ? v : v.tile;
    const item = typeof v === 'string' ? 0 : (v.item ?? 0);
    const ti = byName.get(name);
    if (ti === undefined) continue;
    const key = ti * 256 + item;
    if (!out.has(key) && !(typeof v === 'object' && v.events && v.events.length)) out.set(key, ch);
  }
  for (const [ch, v] of Object.entries(d.legend || {})) {   // characters with events only as a fallback
    const name = typeof v === 'string' ? v : v.tile;
    const ti = byName.get(name);
    if (ti === undefined) continue;
    const key = ti * 256 + (typeof v === 'string' ? 0 : (v.item ?? 0));
    if (!out.has(key)) out.set(key, ch);
  }
  return out;
}

/** TOML for the editor: keeps tile names and the legend characters of the source (chars: Map from legendFromToml);
 *  new (tile, item) pairs get free characters of LEGEND_POOL. Builds the same DMP as the edited map. */
export function toTomlNamed(m, chars = new globalThis.Map()) {
  validate(m);
  const names = [];
  const used = new Set();
  m.tiles.forEach((t, i) => {
    let n = t.name && !used.has(t.name) ? t.name : `k${i}`;
    while (used.has(n)) n = `${n}_${i}`;
    used.add(n);
    names.push(n);
  });
  const key = (n) => (BARE_KEY.test(n) ? n : q(n));
  const pk = (t, it) => t * 256 + it;
  const pairs = [...new Set(m.cells.map((c, i) => pk(c, m.content[i] & 0x3F)))].sort((a, b) => a - b);
  const legend = new globalThis.Map();
  const taken = new Set();
  for (const p of pairs) if (chars.has(p) && !taken.has(chars.get(p))) { legend.set(p, chars.get(p)); taken.add(chars.get(p)); }
  const pool = [...LEGEND_POOL].filter((c) => !taken.has(c));
  for (const p of pairs) {
    if (legend.has(p)) continue;
    if (!pool.length) throw new MapError('too many combinations for an ASCII map');
    legend.set(p, pool.shift());
  }
  const L = ['format  = "dbemap"', 'version = 1', '', '[map]', `name    = ${q(m.name)}`,
    `start   = [${m.start % m.width}, ${Math.floor(m.start / m.width)}]`, `dir     = "${DIRS[m.direction]}"`,
    `outside = ${q(names[m.outside])}`, ''];
  m.tiles.forEach((t, i) => {
    L.push(`[tiles.${key(names[i])}]`, `index   = ${i}`,
      `walls   = ${t.walls.every((w) => w === t.walls[0]) ? t.walls[0] : `[${t.walls.join(', ')}]`}`,
      `floor   = ${t.floor}`, `ceiling = ${t.ceiling}`);
    const fl = Object.entries(FLAGS).filter(([, b]) => t.flags & b).map(([n]) => q(n));
    if (fl.length) L.push(`flags   = [${fl.join(', ')}]`);
    if (t.automapChar) L.push(`automap_char = ${t.automapChar}`);
    L.push('');
  });
  L.push('[legend]');
  for (const [p, ch] of legend) {
    const t = p >> 8, it = p & 255;
    L.push(`${q(ch)} = ${it ? `{ tile = ${q(names[t])}, item = ${it} }` : q(names[t])}`);
  }
  L.push('', '[layers]', 'tiles = """');
  for (let y = 0; y < m.height; y++) {
    let row = '';
    for (let x = 0; x < m.width; x++) {
      const i = y * m.width + x;
      row += legend.get(pk(m.cells[i], m.content[i] & 0x3F));
    }
    L.push(row.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
  }
  L.push('"""', '');
  const tname = Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [v, k]));
  for (const e of sortEvents(m.events)) {
    L.push('[[events]]', `at    = [${e.cell % m.width}, ${Math.floor(e.cell / m.width)}]`,
      `type  = ${tname[e.type] !== undefined ? q(tname[e.type]) : e.type}`, `param = ${e.param}`, '');
  }
  m.content.forEach((c, i) => {
    if (c & 0xC0) {
      L.push('[[marks]]', `at = [${i % m.width}, ${Math.floor(i / m.width)}]`);
      if ((c & 0x80) === 0) L.push('mark = false');
      if (c & 0x40) L.push('seen = true');
      L.push('');
    }
  });
  return L.join('\n');
}
