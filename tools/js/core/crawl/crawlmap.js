// Crawl 128 map (CRAWL128.CD1) -> DBE map (DMP v1). Port of tools/crawlmap.py.
//
// CRAWL128.CD1: PRG (load address meaningless), followed by
//   OS (offset of the map data), W, H, number of gems (word),
//   records of 3 bytes (ASCII character, cell index as word) up to OS - 1,
//   map (W*H bytes, cell values), map name (ASCII).
// Mapping (lossless, docs/specs/P4-map.md, section 5): tile index = Crawl cell value,
// odd values = wall (style 1 on all faces, SOLID, BLOCKSIGHT, OCCLUDING, AUTOMAP),
// even values = empty; item = cell value for values from items (default 2,4).
// NT = max(largest value, 42) + 1: tile 1 (wall) serves for cells outside the map,
// tile 42 (exit open) is set by Crawl at runtime.
// Errors (Python ValueError) are thrown as MapError with the same texts.
import { Event, Map as DbeMap, Tile, FLAGS, EVENT_TYPES, MapError, pyRepr } from '../map.js';

export const RECORD_EVENTS = Object.freeze({
  8: ['teleport', 1], B: ['enemy', 1], D: ['enemy', 2], F: ['enemy', 3], H: ['enemy', 4], X: ['exit', 0], Z: ['exit', 1],
});
export const WALL_FLAGS = FLAGS.solid | FLAGS.blocksight | FLAGS.occluding | FLAGS.automap;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** bytes.decode('ascii', 'replace'): every byte >= 128 becomes U+FFFD. */
function asciiDecode(b) {
  let s = '', ok = true;
  for (const c of b) {
    if (c < 128) s += String.fromCharCode(c);
    else { s += '�'; ok = false; }
  }
  return [s, ok];
}

/** CD1 bytes -> {m: Map, warn: [text]}. MapError on errors. */
export function convert(data, { items = [2, 4], floor = 0, ceiling = 0 } = {}) {
  if (data.length < 7) throw new MapError('file too short');
  const b = data.subarray(2);
  const os_ = b[0], w = b[1], h = b[2], gems = b[3] | (b[4] << 8);
  const n = w * h;
  if (w < 1 || h < 1 || os_ < 5 || (os_ - 5) % 3 || b.length < os_ + n) {
    throw new MapError(`invalid header (OS=${os_}, W=${w}, H=${h}, length ${b.length})`);
  }
  const warn = [];
  const cellvals = Array.from(b.subarray(os_, os_ + n));
  const [name, ok] = asciiDecode(b.subarray(os_ + n));
  if (!ok) warn.push('map name is not ASCII');
  const events = [], seen = {};
  let start = null;
  for (let i = 5; i < os_; i += 3) {
    const ch = String.fromCharCode(b[i]);
    const cell = b[i + 1] | (b[i + 2] << 8);
    if (cell >= n) throw new MapError(`record ${pyRepr(ch)}: cell ${cell} >= W*H ${n}`);
    seen[ch] = (seen[ch] || 0) + 1;
    // Duplicate records: '6' (start ambiguous) and more than two '8' (crawl.bas: DIM TL%(1))
    // are errors; otherwise a warning, because crawl.bas takes the last one, the DMP keeps all.
    if (ch === '6' && seen[ch] > 1) throw new MapError("record '6' (player start) repeated");
    if (ch === '8' && seen[ch] > 2) throw new MapError("more than two records '8' (Crawl knows exactly two teleporters)");
    if (ch !== '6' && ch !== '8' && seen[ch] === 2) warn.push(`record ${pyRepr(ch)} repeated: Crawl takes the last one, the DMP contains all`);
    if (ch === '6') start = cell;
    else if (has(RECORD_EVENTS, ch)) {
      const [t, p] = RECORD_EVENTS[ch];
      events.push(new Event(cell, EVENT_TYPES[t], p));
    } else {
      warn.push(`unknown record ${pyRepr(ch)} (cell ${cell}): type 255, parameter ${b[i]}`);
      events.push(new Event(cell, 255, b[i]));
    }
  }
  if (start === null) throw new MapError("no record '6' (player start)");
  // tile 1 for outside; tile 42 (exit open) is set by crawl.bas 5550 at runtime.
  const nt = Math.max(Math.max(...cellvals), 42) + 1;
  const tiles = [];
  for (let v = 0; v < nt; v++) {
    if (v & 1) tiles.push(new Tile([1, 1, 1, 1], 0, 0, WALL_FLAGS, 0, `k${v}`));
    else tiles.push(new Tile([0, 0, 0, 0], floor, ceiling, 0, 0, `k${v}`));
  }
  const n2 = cellvals.filter((v) => v === 2).length;
  if (n2 !== gems) warn.push(`${n2} cells with value 2, header says ${gems} gems`);
  const content = cellvals.map((v) => (items.includes(v) ? v : 0));
  events.sort((x, y) => x.cell - y.cell || x.type - y.type || x.param - y.param);
  const m = new DbeMap(name, w, h, tiles, cellvals, content, events, start, 0, 1);
  return { m, warn };
}

/** Legend for --toml: character chr(48 + v), item = value -> {character: [v, item]}. */
export function legendFor(m) {
  const pairs = new Map();
  m.cells.forEach((c, i) => pairs.set(c * 256 + m.content[i], [c, m.content[i]]));
  const leg = {};
  for (const [v, it] of [...pairs.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (v > 78) throw new MapError(`cell value ${v} > 78: no ASCII character for the legend`);
    leg[String.fromCharCode(48 + v)] = [v, it];
  }
  return leg;
}
