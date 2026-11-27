#!/usr/bin/env python3
"""Convert the wall set of Crawl 128 (WALLS.VDC) into DBE wall set metadata (WSM).

WALLS.VDC: PRG file; byte 0 = number of entries, then 7 bytes each
  source (W, relative to the VRAM base), width, height, size (W), column (target = column + 406).
The entries are ordered by the view slots 1..19 of crawl.bas; their position in the
view grid (depth d, side s, face) is given in SLOTS below.

Output (docs/formats.md, wall set metadata v1), as PRG with load address:
  header 10 bytes: "W","S",1, count, clear offset (W), clear length (W), clear value, row width
  entry 10 bytes: d, s, flags, width, height, source (W), target (W), column
Order: front to back (d ascending, per depth first fronts, then object slots, then sides).
Object slots have flag $80 and no other data.
"""
import argparse
import struct
import sys

FRONT, SLOT, SIDE = 0, 1, 2     # order per depth: fronts, object slots, sides

# slot (1..19) -> (d, s, face); derived from V%() in crawl.bas, lines 90-95
SLOTS = {
    1: (0, -1, SIDE), 2: (0, 1, SIDE),
    3: (1, -1, FRONT), 4: (1, 0, FRONT), 5: (1, 1, FRONT),
    6: (1, -1, SIDE), 7: (1, 1, SIDE),
    8: (2, -1, FRONT), 9: (2, -1, FRONT), 10: (2, 0, FRONT),
    11: (2, 1, FRONT), 12: (2, 1, FRONT),
    13: (2, -1, SIDE), 14: (2, 1, SIDE),
    15: (3, -1, FRONT), 16: (3, -1, FRONT), 17: (3, 0, FRONT),
    18: (3, 1, FRONT), 19: (3, 1, FRONT),
}

ROW = 80            # row width of the image buffer in bytes (EI% in crawl.bas)
DEST_BASE = 406     # 5 * 80 + 6: top left corner of the viewport
CLEAR_OFF = 400     # crawl.bas line 4610: VMF AP+400, 0, 7600
CLEAR_LEN = 7600
CLEAR_VAL = 0
MAXENT = 64     # MAXWS in engine/lib.s


def convert(data):
    body = data[2:]
    n = body[0]
    raw = []
    for i in range(n):
        src, w, h, _size, col = struct.unpack_from("<HBBHB", body, 1 + 7 * i)
        raw.append((i + 1, src, w, h, col))
    full = max(r[3] for r in raw)
    ents = []
    for slot, src, w, h, col in raw:
        d, s, face = SLOTS[slot]
        flags = 1 if h == full else 0       # only full height covers columns
        ents.append(((d, face, slot), d, s, flags, w, h, src, DEST_BASE + col, col))
    # object slots: every cell with d >= 1 of the view grid; VIEW places objects and items there
    for d, s in sorted({(d, s) for d, s, _f in SLOTS.values() if d >= 1}):
        ents.append(((d, SLOT, 0), d, s, 0x80, 0, 0, 0, 0, 0))
    ents.sort(key=lambda e: e[0])
    if len(ents) > MAXENT:
        sys.exit(f"too many entries: {len(ents)} > {MAXENT}")
    out = bytearray(b"WS")
    out += struct.pack("<BBHHBB", 1, len(ents), CLEAR_OFF, CLEAR_LEN, CLEAR_VAL, ROW)
    for _k, d, s, flags, w, h, src, dest, col in ents:
        out += struct.pack("<BbBBBHHB", d, s, flags, w, h, src, dest, col)
    return out, ents


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("walls_vdc")
    ap.add_argument("out_wsm")
    ap.add_argument("--load", type=lambda x: int(x, 0), default=0xE000, help="load address (bank 1)")
    ap.add_argument("-v", action="store_true", help="print entries")
    a = ap.parse_args()
    data = open(a.walls_vdc, "rb").read()
    out, ents = convert(data)
    with open(a.out_wsm, "wb") as f:
        f.write(struct.pack("<H", a.load) + out)
    if a.v:
        for _k, d, s, flags, w, h, src, dest, col in ents:
            print(f"d={d} s={s:+d} flags={flags} w={w:2} h={h:2} src={src:5} dest={dest} col={col}")
    print(f"{len(ents)} entries, {len(out)} bytes -> {a.out_wsm}")


if __name__ == "__main__":
    main()
