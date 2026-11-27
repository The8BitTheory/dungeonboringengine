// Wall set of Crawl 128 (WALLS.VDC) -> DBE wall set metadata (WSM v1). Port of tools/wallconv.py.
//
// WALLS.VDC: PRG file; byte 0 = number of entries, then 7 bytes each
//   source (W, relative to the VRAM base), width, height, size (W), column (target = column + 406).
// The entries are ordered by the view slots 1..19 of crawl.bas; their position in the view grid (depth d, side s,
// face) is given in SLOTS below.
// Output (docs/formats.md, wall set metadata v1), without load address:
//   header 10 bytes: "W","S",1, count, clear offset (W), clear length (W), clear value, row width
//   entry 10 bytes: d, s, flags, width, height, source (W), target (W), column
// Order: front to back (d ascending, per depth first fronts, then object slots, then sides).
// Object slots have flag $80 and no other data.

export const FRONT = 0, SLOT = 1, SIDE = 2;     // order per depth: fronts, object slots, sides

/** slot (1..19) -> [d, s, face]; derived from V%() in crawl.bas, lines 90-95. */
export const SLOTS = Object.freeze({
  1: [0, -1, SIDE], 2: [0, 1, SIDE],
  3: [1, -1, FRONT], 4: [1, 0, FRONT], 5: [1, 1, FRONT],
  6: [1, -1, SIDE], 7: [1, 1, SIDE],
  8: [2, -1, FRONT], 9: [2, -1, FRONT], 10: [2, 0, FRONT],
  11: [2, 1, FRONT], 12: [2, 1, FRONT],
  13: [2, -1, SIDE], 14: [2, 1, SIDE],
  15: [3, -1, FRONT], 16: [3, -1, FRONT], 17: [3, 0, FRONT],
  18: [3, 1, FRONT], 19: [3, 1, FRONT],
});
export const NSLOTS = 19;

export const ROW = 80;            // row width of the image buffer in bytes (EI% in crawl.bas)
export const DEST_BASE = 406;     // 5 * 80 + 6: top left corner of the viewport
export const CLEAR_OFF = 400;     // crawl.bas line 4610: VMF AP+400, 0, 7600
export const CLEAR_LEN = 7600;
export const CLEAR_VAL = 0;
export const MAXENT = 64;         // MAXWS in engine/lib.s

export class WallconvError extends Error {
  constructor(msg) { super(msg); this.name = 'WallconvError'; }
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);

/** Lexicographic comparison of number arrays (Python tuple order). */
export function cmpTuple(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

/** walls.vdc (PRG) -> {out: WSM without load address, ents: [[key], d, s, flags, w, h, src, dest, col]}. */
export function convert(data) {
  const body = data.subarray(2);
  const n = body[0];
  const raw = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + 7 * i;
    raw.push([i + 1, u16(body, o), body[o + 2], body[o + 3], body[o + 6]]);
  }
  const full = Math.max(...raw.map((r) => r[3]));
  const ents = [];
  for (const [slot, src, w, h, col] of raw) {
    const [d, s, face] = SLOTS[slot];
    const flags = h === full ? 1 : 0;       // only full height covers columns
    ents.push([[d, face, slot], d, s, flags, w, h, src, DEST_BASE + col, col]);
  }
  // object slots: every cell with d >= 1 of the view grid; VIEW places objects and items there
  const cells = new Map();
  for (const [d, s] of Object.values(SLOTS)) if (d >= 1) cells.set(`${d},${s}`, [d, s]);
  for (const [d, s] of [...cells.values()].sort(cmpTuple)) ents.push([[d, SLOT, 0], d, s, 0x80, 0, 0, 0, 0, 0]);
  ents.sort((a, b) => cmpTuple(a[0], b[0]));
  if (ents.length > MAXENT) throw new WallconvError(`too many entries: ${ents.length} > ${MAXENT}`);
  const out = new Uint8Array(10 + 10 * ents.length);
  out.set([0x57, 0x53, 1, ents.length, CLEAR_OFF & 255, CLEAR_OFF >> 8, CLEAR_LEN & 255, CLEAR_LEN >> 8, CLEAR_VAL, ROW]);
  ents.forEach(([, d, s, flags, w, h, src, dest, col], i) => {
    out.set([d, s & 255, flags, w, h, src & 255, src >> 8, dest & 255, dest >> 8, col], 10 + 10 * i);
  });
  return { out, ents };
}

/** WSM PRG (load address + convert().out). */
export function toWsm(data, load = 0xE000) {
  const { out, ents } = convert(data);
  const prg = new Uint8Array(2 + out.length);
  prg.set([load & 255, (load >> 8) & 255]);
  prg.set(out, 2);
  return { prg, out, ents };
}
