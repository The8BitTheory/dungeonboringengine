#!/usr/bin/env python3
"""Convert a Crawl 128 map (CRAWL128.CD1) into a DBE map (DMP v1).

CRAWL128.CD1: PRG (load address meaningless), followed by
  OS (offset of the map data), W, H, number of gems (word),
  records of 3 bytes (ASCII character, cell index as word) up to OS - 1,
  map (W*H bytes, cell values), map name (ASCII).
Mapping (lossless, docs/specs/P4-map.md, section 5): tile index = Crawl cell value,
odd values = wall (style 1 on all faces, SOLID, BLOCKSIGHT, OCCLUDING, AUTOMAP),
even values = empty; item = cell value for values from --items (default 2,4).
NT = max(largest value, 42) + 1: tile 1 (wall) serves for cells outside the map,
tile 42 (exit open) is set by Crawl at runtime.

Usage:
  crawlmap.py CRAWL128.CD1 OUT.dmp [--toml OUT.toml] [--load ADDR] [--items 2,4] [--floor N] [--ceiling N]
  crawlmap.py --d81 IMAGE.d81 OUT.dmp [...]     (reads crawl128.cd1 via c1541)
"""
import argparse
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbemap  # noqa: E402
from dbemap import Event, Map, Tile, FLAGS  # noqa: E402

RECORD_EVENTS = {"8": ("teleport", 1), "B": ("enemy", 1), "D": ("enemy", 2), "F": ("enemy", 3),
                 "H": ("enemy", 4), "X": ("exit", 0), "Z": ("exit", 1)}
WALL_FLAGS = FLAGS["solid"] | FLAGS["blocksight"] | FLAGS["occluding"] | FLAGS["automap"]


def convert(data, items=(2, 4), floor=0, ceiling=0):
    """CD1 bytes -> (Map, warnings). ValueError on errors."""
    if len(data) < 7:
        raise ValueError("file too short")
    b = data[2:]
    os_, w, h, gems = b[0], b[1], b[2], b[3] | (b[4] << 8)
    n = w * h
    if w < 1 or h < 1 or os_ < 5 or (os_ - 5) % 3 or len(b) < os_ + n:
        raise ValueError(f"invalid header (OS={os_}, W={w}, H={h}, length {len(b)})")
    warn = []
    cellvals = list(b[os_:os_ + n])
    try:
        name = b[os_ + n:].decode("ascii")
    except UnicodeDecodeError:
        name = b[os_ + n:].decode("ascii", "replace")
        warn.append("map name is not ASCII")
    events, start, seen = [], None, {}
    for i in range(5, os_, 3):
        ch = chr(b[i])
        cell = b[i + 1] | (b[i + 2] << 8)
        if cell >= n:
            raise ValueError(f"record {ch!r}: cell {cell} >= W*H {n}")
        seen[ch] = seen.get(ch, 0) + 1
        # Duplicate records: '6' (start ambiguous) and more than two '8' (crawl.bas: DIM TL%(1))
        # are errors; otherwise a warning, because crawl.bas takes the last one, the DMP keeps all.
        if ch == "6" and seen[ch] > 1:
            raise ValueError("record '6' (player start) repeated")
        if ch == "8" and seen[ch] > 2:
            raise ValueError("more than two records '8' (Crawl knows exactly two teleporters)")
        if ch not in "68" and seen[ch] == 2:
            warn.append(f"record {ch!r} repeated: Crawl takes the last one, the DMP contains all")
        if ch == "6":
            start = cell
        elif ch in RECORD_EVENTS:
            t, p = RECORD_EVENTS[ch]
            events.append(Event(cell, dbemap.EVENT_TYPES[t], p))
        else:
            warn.append(f"unknown record {ch!r} (cell {cell}): type 255, parameter {b[i]}")
            events.append(Event(cell, 255, b[i]))
    if start is None:
        raise ValueError("no record '6' (player start)")
    # tile 1 for outside; tile 42 (exit open) is set by crawl.bas 5550 at runtime.
    nt = max(max(cellvals), 42) + 1
    tiles = []
    for v in range(nt):
        if v & 1:
            tiles.append(Tile((1, 1, 1, 1), 0, 0, WALL_FLAGS, 0, f"k{v}"))
        else:
            tiles.append(Tile((0, 0, 0, 0), floor, ceiling, 0, 0, f"k{v}"))
    if cellvals.count(2) != gems:
        warn.append(f"{cellvals.count(2)} cells with value 2, header says {gems} gems")
    content = [v if v in items else 0 for v in cellvals]
    events.sort(key=lambda e: (e.cell, e.type, e.param))
    m = Map(name, w, h, tiles, cellvals, content, events, start, 0, 1)
    return m, warn


def legend_for(m):
    """Legend for --toml: character chr(48 + v), item = value."""
    leg = {}
    for v, it in sorted({(c, i) for c, i in zip(m.cells, m.content)}):
        if v > 78:
            raise ValueError(f"cell value {v} > 78: no ASCII character for the legend")
        leg[chr(48 + v)] = (v, it)
    return leg


def read_d81(image):
    """Read crawl128.cd1 from a D81 image via c1541."""
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "crawl128.cd1")
        r = subprocess.run(["c1541", "-attach", image, "-read", "crawl128.cd1", out],
                           capture_output=True, text=True)
        if not os.path.exists(out):
            raise ValueError(f"c1541 could not read crawl128.cd1 from {image}: {r.stderr.strip() or r.stdout.strip()}")
        with open(out, "rb") as f:
            return f.read()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("paths", nargs="+", metavar="PATH", help="CRAWL128.CD1 OUT.dmp (with --d81 only OUT.dmp)")
    ap.add_argument("--d81", metavar="IMAGE.d81")
    ap.add_argument("--toml")
    ap.add_argument("--load", default="0x4000")
    ap.add_argument("--items", default="2,4")
    ap.add_argument("--floor", type=int, default=0)
    ap.add_argument("--ceiling", type=int, default=0)
    a = ap.parse_args(argv)
    try:
        if len(a.paths) != (1 if a.d81 else 2):
            ap.error("Usage: CRAWL128.CD1 OUT.dmp  or  --d81 IMAGE.d81 OUT.dmp")
        out = a.paths[-1]
        if a.d81:
            data = read_d81(a.d81)
        else:
            with open(a.paths[0], "rb") as f:
                data = f.read()
        items = tuple(int(x) for x in a.items.split(",") if x.strip())
        if any(not 1 <= i <= 63 for i in items):
            raise ValueError("--items: values 1 ... 63 expected")
        for v in (a.floor, a.ceiling):
            if not 0 <= v <= 255:
                raise ValueError("--floor/--ceiling: 0 ... 255 expected")
        m, warn = convert(data, items, a.floor, a.ceiling)
        for w in warn:
            print(f"Warning: {w}", file=sys.stderr)
        load = int(a.load.replace("$", "0x"), 0)
        dmp = dbemap.to_dmp(m, load)
        dbemap.check_bank1(load, len(dmp) - 2)
        with open(out, "wb") as f:
            f.write(dmp)
        if a.toml:
            with open(a.toml, "w", encoding="utf-8") as f:
                f.write(dbemap.to_toml(m, legend_for(m)))
        print(f"{out}: {len(dmp)} bytes, {m.width} x {m.height}, {len(m.tiles)} tiles, "
              f"{sum(1 for c in m.content if c)} items, {len(m.events)} events, "
              f"start ({m.start % m.width}, {m.start // m.width}) direction {dbemap.DIRS[m.direction]}")
        return 0
    except (ValueError, OSError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
