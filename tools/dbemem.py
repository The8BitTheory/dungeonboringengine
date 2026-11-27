"""Bank 1 memory map of engine 0.2 (docs/specs/P6-engine.md 2.4): default load addresses and range checking.

The tools (dbemap, dbespr, dbetex, dbegeom) write their data with these load addresses and abort with an
error message if the data crosses the boundary of its area (instead of silently running into the neighbouring area).

Bank 1: $0400-$3FFF BASIC variables (MEMSIZ $4000), $4000-$AFFF assets, $B000-$E7FF lib, LIBTAB and BSS,
$E800-$FBFF assets, $FC00-$FEFF Blitz! runtime (locked).
"""

# kind -> (default load address, area end exclusive)
AREAS = {
    "dmp": (0x4000, 0x6000),       # map, 8 KB
    "s2": (0x6000, 0x8000),        # sprite sets, 8 KB
    "wall": (0x8000, 0xB000),      # DTS wall, 12 KB
    "dvg": (0xE800, 0xEE00),       # geometry, 1.5 KB
    "floor": (0xEE00, 0xF600),     # DTS floor, 2 KB
    "ceiling": (0xF600, 0xFB80),   # DTS ceiling, 1.375 KB (1 style of the demo: 1295 bytes)
    "dbg": (0xFB80, 0xFC00),       # wallpaper, 128 bytes (24 + VH <= 124)
}
# Contiguous free windows; files packed densely (custom load addresses) stay inside them
WINDOWS = ((0x4000, 0xB000), (0xE800, 0xFC00))


def default_load(kind):
    return AREAS[kind][0]


def range_error(kind, load, length):
    """None if load .. load + length - 1 lies within the area, otherwise the error message text.

    If load lies in the default area of the kind, its end applies; otherwise (custom packing) the end of the free window."""
    a, e = AREAS[kind]
    end = load + length
    if a <= load < e:
        if end > e:
            return (f"{kind}: ${load:04X}..${end - 1:04X} ({length} bytes) extends beyond the area end ${e - 1:04X} "
                    f"(area ${a:04X}..${e - 1:04X}, {e - a} bytes)")
        return None
    for wa, we in WINDOWS:
        if wa <= load < we:
            if end > we:
                return (f"{kind}: ${load:04X}..${end - 1:04X} ({length} bytes) extends beyond the end of free "
                        f"memory ${we - 1:04X}")
            return None
    return (f"{kind}: load address ${load:04X} is not in bank 1 asset memory "
            f"($4000..$AFFF, $E800..$FBFF; Lib/BSS $B000..$E7FF, runtime from $FC00)")
