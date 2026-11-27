// Bank 1 memory map of engine 0.2 (docs/specs/P6-engine.md 2.4): default load addresses and range checking.
// Port of tools/dbemem.py. The tools write their data with these load addresses and abort with an error message
// if the data crosses the boundary of its area.

const h4 = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

// kind -> [default load address, area end exclusive]
export const AREAS = Object.freeze({
  dmp: [0x4000, 0x6000],       // map, 8 KB
  s2: [0x6000, 0x8000],        // sprite sets, 8 KB
  wall: [0x8000, 0xB000],      // DTS wall, 12 KB
  dvg: [0xE800, 0xEE00],       // geometry, 1.5 KB
  floor: [0xEE00, 0xF600],     // DTS floor, 2 KB
  ceiling: [0xF600, 0xFB80],   // DTS ceiling
  dbg: [0xFB80, 0xFC00],       // wallpaper, 128 bytes
});
// contiguous free windows; files packed densely (custom load addresses) stay inside them
export const WINDOWS = Object.freeze([[0x4000, 0xB000], [0xE800, 0xFC00]]);

export function defaultLoad(kind) { return AREAS[kind][0]; }

/** null if load .. load + length - 1 lies within the area, otherwise the error message text. */
export function rangeError(kind, load, length) {
  const [a, e] = AREAS[kind];
  const end = load + length;
  if (a <= load && load < e) {
    if (end > e) {
      return `${kind}: ${h4(load)}..${h4(end - 1)} (${length} bytes) extends beyond the area end ${h4(e - 1)} `
        + `(area ${h4(a)}..${h4(e - 1)}, ${e - a} bytes)`;
    }
    return null;
  }
  for (const [wa, we] of WINDOWS) {
    if (wa <= load && load < we) {
      if (end > we) return `${kind}: ${h4(load)}..${h4(end - 1)} (${length} bytes) extends beyond the end of free memory ${h4(we - 1)}`;
      return null;
    }
  }
  return `${kind}: load address ${h4(load)} is not in bank 1 asset memory `
    + '($4000..$AFFF, $E800..$FBFF; Lib/BSS $B000..$E7FF, runtime from $FC00)';
}
