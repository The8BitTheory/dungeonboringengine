#!/usr/bin/env python3
"""DBE-Karte (DMP v1) aus TOML bauen, als TOML ausgeben oder als Text zeigen.

DMP: PRG-Datei, 2 Byte Ladeadresse (Standard $8000), dann ein 24-Byte-Kopf,
Kachelebene (W*H), Inhaltsebene (W*H), Kacheltabelle (NT * 8), Ereignisse (NE * 4).
Das Format steht in docs/formats.md ("DMP v1"), das Textformat in docs/specs/P4-map.md, Abschnitt 3.

Aufruf:
  dbemap.py build MAP.toml OUT.dmp [--load ADDR]
  dbemap.py dump  IN.dmp [--toml OUT.toml]     (ohne --toml: Textuebersicht)
  dbemap.py check MAP.toml

Zellindex i = y * W + x; Richtungen 0 N, 1 O, 2 S, 3 W (Norden = kleineres y).
"""
import argparse
import struct
import sys
import tomllib
from dataclasses import dataclass, field

FLAGS = {"weg": 1, "sicht": 2, "deckend": 4, "tuer": 8, "automap": 16}
EVENT_TYPES = {"gegner": 1, "teleport": 2, "ausgang": 3, "text": 4}
SUBPOS_VIEW = [[0, 1, 3, 4, 2], [3, 0, 4, 1, 2], [4, 3, 1, 0, 2], [1, 4, 0, 3, 2]]  # [v][q] -> p (2.6)
DIRS = "NOSW"
HEADER = 24
MAX_CELLS = 16384
WARN_CELLS = 4096
LEGEND_POOL = "#.0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!$%&*+-/:;<=>?@^_~|"


@dataclass
class Tile:
    walls: tuple
    floor: int
    ceiling: int
    flags: int
    automap_char: int
    name: str = field(default="", compare=False)


@dataclass
class Event:
    cell: int
    type: int
    param: int


@dataclass
class Map:
    name: str = field(compare=False)
    width: int
    height: int
    tiles: list
    cells: list
    content: list
    events: list
    start: int
    direction: int
    outside: int


def null_tile():
    return Tile((0, 0, 0, 0), 0, 0, 0, 0)


def face(view_dir, s, front):
    """Kachelflaeche (0 N, 1 O, 2 S, 3 W), die in Blickrichtung view_dir sichtbar ist (2.4)."""
    if front:
        return (view_dir + 2) & 3
    return (view_dir + 1) & 3 if s < 0 else (view_dir + 3) & 3


def validate(m):
    """Prueft eine Karte; ValueError mit Meldung bei Fehler."""
    if not 1 <= m.width <= 255 or not 1 <= m.height <= 255:
        raise ValueError(f"Breite/Hoehe {m.width} x {m.height} ausserhalb 1 ... 255")
    n = m.width * m.height
    if n > MAX_CELLS:
        raise ValueError(f"Karte zu gross: {m.width} x {m.height} = {n} > {MAX_CELLS} Zellen")
    nt = len(m.tiles)
    if not 1 <= nt <= 256:
        raise ValueError(f"Anzahl Kacheln {nt} ausserhalb 1 ... 256")
    if len(m.cells) != n or len(m.content) != n:
        raise ValueError("Ebenen haben nicht W*H Eintraege")
    for i, t in enumerate(m.tiles):
        if len(t.walls) != 4 or any(not 0 <= v <= 255 for v in tuple(t.walls) + (t.floor, t.ceiling, t.automap_char)):
            raise ValueError(f"Kachel {i}: Stil oder Zeichen ausserhalb 0 ... 255")
        if not 0 <= t.flags <= 31:
            raise ValueError(f"Kachel {i}: ungueltige Flags {t.flags}")
    for i, c in enumerate(m.cells):
        if not 0 <= c < nt:
            raise ValueError(f"Zelle {i}: Kachelindex {c} >= NT {nt}")
    for i, c in enumerate(m.content):
        if not 0 <= c <= 255:
            raise ValueError(f"Zelle {i}: ungueltiger Inhalt {c}")
    if len(m.events) > 65535:
        raise ValueError("zu viele Ereignisse")
    for e in m.events:
        if not 0 <= e.cell < n:
            raise ValueError(f"Ereignis: Zelle {e.cell} ausserhalb der Karte")
        if not 1 <= e.type <= 255:
            raise ValueError(f"Ereignis in Zelle {e.cell}: Typ {e.type} ungueltig (1 ... 255)")
        if not 0 <= e.param <= 255:
            raise ValueError(f"Ereignis in Zelle {e.cell}: Parameter {e.param} ausserhalb 0 ... 255")
    if not 0 <= m.start < n:
        raise ValueError(f"Startzelle {m.start} ausserhalb der Karte")
    if not 0 <= m.direction <= 3:
        raise ValueError(f"Startrichtung {m.direction} ausserhalb 0 ... 3")
    if not 0 <= m.outside < nt:
        raise ValueError(f"Kachel ausserhalb {m.outside} >= NT {nt}")
    if m.tiles[m.cells[m.start]].flags & FLAGS["weg"]:
        raise ValueError(f"Start (Zelle {m.start}) liegt auf einer Kachel mit WEG")


def warnings_for(m):
    """Liste von Warnungen (kein Abbruch)."""
    w = []
    if m.width * m.height > WARN_CELLS:
        w.append(f"{m.width * m.height} Zellen > {WARN_CELLS}: die Lib haelt die Karte in Bank 1")
    return w


def to_dmp(m, load=0x8000):
    """Karte als DMP-PRG (mit Ladeadresse) erzeugen."""
    validate(m)
    n = m.width * m.height
    nt = len(m.tiles)
    events = sorted(m.events, key=lambda e: (e.cell, e.type, e.param))
    o_cells = HEADER
    o_content = o_cells + n
    o_tiles = o_content + n
    o_events = o_tiles + 8 * nt
    total = o_events + 4 * len(events)
    out = bytearray(struct.pack("<H", load))
    out += b"DM" + bytes([1, m.width, m.height, nt & 255])
    out += struct.pack("<HHBB", len(events), m.start, m.direction, m.outside)
    out += struct.pack("<HHHHHH", o_cells, o_content, o_tiles, o_events, total, 0)
    out += bytes(m.cells) + bytes(m.content)
    for t in m.tiles:
        out += bytes(t.walls) + bytes([t.floor, t.ceiling, t.flags, t.automap_char])
    for e in events:
        out += struct.pack("<HBB", e.cell, e.type, e.param)
    assert len(out) == 2 + total
    return bytes(out)


def from_dmp(data):
    """DMP-PRG (mit Ladeadresse) einlesen; ValueError bei Formatfehlern."""
    if len(data) < 2 + HEADER:
        raise ValueError("Datei kuerzer als der Kopf")
    b = data[2:]
    if b[0:2] != b"DM":
        raise ValueError("falsches Magic (erwartet 'DM')")
    if b[2] != 1:
        raise ValueError(f"Version {b[2]} nicht unterstuetzt (erwartet 1)")
    w, h, nt = b[3], b[4], b[5] or 256
    ne, start, direction, outside = struct.unpack_from("<HHBB", b, 6)
    o_cells, o_content, o_tiles, o_events, total, res = struct.unpack_from("<HHHHHH", b, 12)
    if w < 1 or h < 1:
        raise ValueError("Breite/Hoehe 0")
    n = w * h
    if n > MAX_CELLS:
        raise ValueError(f"Karte zu gross: {n} Zellen")
    if (o_cells, o_content, o_tiles, o_events, total) != (
            HEADER, HEADER + n, HEADER + 2 * n, HEADER + 2 * n + 8 * nt, HEADER + 2 * n + 8 * nt + 4 * ne):
        raise ValueError("Offsets im Kopf passen nicht zu W, H, NT, NE")
    if res:
        raise ValueError("reservierte Kopfbytes ungleich 0")
    if len(b) < total:
        raise ValueError(f"Datei zu kurz: {len(b)} < {total} Byte Inhalt")
    cells = list(b[o_cells:o_cells + n])
    content = list(b[o_content:o_content + n])
    tiles = []
    for i in range(nt):
        r = b[o_tiles + 8 * i:o_tiles + 8 * i + 8]
        tiles.append(Tile(tuple(r[0:4]), r[4], r[5], r[6], r[7], f"k{i}"))
    events = []
    for i in range(ne):
        c, t, p = struct.unpack_from("<HBB", b, o_events + 4 * i)
        events.append(Event(c, t, p))
    m = Map("", w, h, tiles, cells, content, events, start, direction, outside)
    for i, c in enumerate(cells):
        if c >= nt:
            raise ValueError(f"Zelle {i}: Kachelindex {c} >= NT {nt}")
    if start >= n:
        raise ValueError(f"Startzelle {start} >= W*H {n}")
    if direction > 3:
        raise ValueError(f"Startrichtung {direction} ungueltig")
    if outside >= nt:
        raise ValueError(f"Kachel ausserhalb {outside} >= NT {nt}")
    for e in events:
        if e.cell >= n or e.type == 0:
            raise ValueError(f"ungueltiges Ereignis in Zelle {e.cell}, Typ {e.type}")
    keys = [(e.cell, e.type, e.param) for e in events]
    if keys != sorted(keys):
        raise ValueError("Ereignisse nicht sortiert")
    return m


# ---------------------------------------------------------------- TOML lesen

def _err(src, msg):
    return ValueError(f"{src}: {msg}")


def _int(src, where, v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise _err(src, f"{where}: {v!r} ausserhalb {lo} ... {hi}")
    return v


def _event(src, where, d):
    if not isinstance(d, dict):
        raise _err(src, f"{where}: Tabelle erwartet")
    extra = set(d) - {"type", "param", "at"}
    if extra:
        raise _err(src, f"{where}: unbekannter Schluessel {sorted(extra)[0]!r}")
    if "type" not in d:
        raise _err(src, f"{where}: 'type' fehlt")
    t = d["type"]
    if isinstance(t, str):
        if t not in EVENT_TYPES:
            raise _err(src, f"{where}: unbekannter Ereignistyp {t!r}")
        t = EVENT_TYPES[t]
    else:
        t = _int(src, f"{where} type", t, 1, 255)
    return t, _int(src, f"{where} param", d.get("param", 0), 0, 255)


def loads_toml(text, src="<string>"):
    """Karte aus TOML-Text lesen; Fehlermeldungen beginnen mit src."""
    try:
        d = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise _err(src, f"TOML-Syntaxfehler: {e}")
    if d.get("format", "dbemap") != "dbemap":
        raise _err(src, f"format {d['format']!r} ist nicht 'dbemap'")
    if d.get("version", 1) != 1:
        raise _err(src, f"version {d['version']!r} nicht unterstuetzt")
    extra = set(d) - {"format", "version", "map", "tiles", "legend", "layers", "events", "marks"}
    if extra:
        raise _err(src, f"unbekannter Schluessel {sorted(extra)[0]!r}")
    mp = d.get("map", {})
    if not isinstance(mp, dict):
        raise _err(src, "[map] muss eine Tabelle sein")
    extra = set(mp) - {"name", "start", "dir", "outside"}
    if extra:
        raise _err(src, f"map: unbekannter Schluessel {sorted(extra)[0]!r}")
    # Kacheln
    tdefs = d.get("tiles")
    if not isinstance(tdefs, dict) or not tdefs:
        raise _err(src, "Abschnitt [tiles.<name>] fehlt")
    has_index = ["index" in t for t in tdefs.values()]
    if any(has_index) and not all(has_index):
        raise _err(src, "'index' muss bei allen Kacheln oder bei keiner stehen")
    tiles, names = [], {}
    if all(has_index):
        used = {}
        for name, t in tdefs.items():
            idx = _int(src, f"tiles.{name}.index", t["index"], 0, 255)
            if idx in used:
                raise _err(src, f"tiles.{name}: index {idx} doppelt (auch {used[idx]})")
            used[idx] = name
        tiles = [null_tile() for _ in range(max(used) + 1)]
        order = [(t["index"], n) for n, t in tdefs.items()]
    else:
        order = list(enumerate(tdefs))
        tiles = [None] * len(order)
    if len(tiles) > 256:
        raise _err(src, "mehr als 256 Kacheln")
    for idx, name in order:
        t = tdefs[name]
        where = f"tiles.{name}"
        extra = set(t) - {"walls", "floor", "ceiling", "flags", "automap_char", "index"}
        if extra:
            raise _err(src, f"{where}: unbekannter Schluessel {sorted(extra)[0]!r}")
        w = t.get("walls", 0)
        if isinstance(w, list):
            if len(w) != 4:
                raise _err(src, f"{where}.walls: genau 4 Zahlen erwartet")
            w = tuple(_int(src, f"{where}.walls", v, 0, 255) for v in w)
        else:
            w = (_int(src, f"{where}.walls", w, 0, 255),) * 4
        fl = 0
        fv = t.get("flags", [])
        if not isinstance(fv, list):
            raise _err(src, f"{where}.flags: Liste erwartet")
        for f in fv:
            if f not in FLAGS:
                raise _err(src, f"{where}.flags: unbekanntes Flag {f!r}")
            fl |= FLAGS[f]
        tiles[idx] = Tile(w, _int(src, f"{where}.floor", t.get("floor", 0), 0, 255),
                          _int(src, f"{where}.ceiling", t.get("ceiling", 0), 0, 255), fl,
                          _int(src, f"{where}.automap_char", t.get("automap_char", 0), 0, 255), name)
        names[name] = idx
    # Legende
    legend = {}
    for ch, v in d.get("legend", {}).items():
        if len(ch) != 1 or ch.isspace():
            raise _err(src, f"legend: Schluessel {ch!r} muss genau ein sichtbares Zeichen sein")
        if isinstance(v, str):
            v = {"tile": v}
        if not isinstance(v, dict) or "tile" not in v:
            raise _err(src, f"legend {ch!r}: Kachelname oder Tabelle mit 'tile' erwartet")
        extra = set(v) - {"tile", "item", "events"}
        if extra:
            raise _err(src, f"legend {ch!r}: unbekannter Schluessel {sorted(extra)[0]!r}")
        if v["tile"] not in names:
            raise _err(src, f"legend {ch!r}: unbekannte Kachel {v['tile']!r}")
        item = _int(src, f"legend {ch!r} item", v.get("item", 0), 0, 63)
        evs = [_event(src, f"legend {ch!r} events", e) for e in v.get("events", [])]
        legend[ch] = (names[v["tile"]], item, evs)
    # Karte
    layers = d.get("layers", {})
    if not isinstance(layers, dict):
        raise _err(src, "[layers] muss eine Tabelle sein")
    extra = set(layers) - {"tiles"}
    if extra:
        raise _err(src, f"layers: unbekannter Schluessel {sorted(extra)[0]!r}")
    if not isinstance(layers.get("tiles"), str):
        raise _err(src, "layers.tiles fehlt")
    rows = layers["tiles"].split("\n")
    if rows and rows[0] == "":
        rows.pop(0)
    if rows and rows[-1] == "":
        rows.pop()
    if not rows:
        raise _err(src, "Karte ist leer")
    width, height = len(rows[0]), len(rows)
    if not 1 <= width <= 255 or not 1 <= height <= 255:
        raise _err(src, f"Karte {width} x {height}: Breite/Hoehe ausserhalb 1 ... 255")
    if width * height > MAX_CELLS:
        raise _err(src, f"Karte {width} x {height} = {width * height} > {MAX_CELLS} Zellen")
    cells, content, events = [], [], []
    for y, row in enumerate(rows):
        if row != row.rstrip(" \t"):
            col = len(row.rstrip(" \t")) + 1
            raise _err(src, f"Karte Zeile {y + 1}, Spalte {col}: Leerzeichen am Zeilenende")
        if len(row) != width:
            raise _err(src, f"Karte Zeile {y + 1}: Laenge {len(row)} statt {width}")
        for x, ch in enumerate(row):
            if ch not in legend:
                raise _err(src, f"Karte Zeile {y + 1}, Spalte {x + 1}: Zeichen {ch!r} nicht in der Legende")
            t, item, evs = legend[ch]
            cells.append(t)
            content.append(item)
            events += [Event(y * width + x, et, ep) for et, ep in evs]

    def at(tbl, where):
        a = tbl.get("at")
        if not (isinstance(a, list) and len(a) == 2):
            raise _err(src, f"{where}: 'at' = [x, y] erwartet")
        x = _int(src, f"{where} at x", a[0], 0, width - 1)
        y = _int(src, f"{where} at y", a[1], 0, height - 1)
        return y * width + x

    for i, e in enumerate(d.get("events", [])):
        where = f"events[{i + 1}]"
        et, ep = _event(src, where, e)
        events.append(Event(at(e, where), et, ep))
    for i, mk in enumerate(d.get("marks", [])):
        where = f"marks[{i + 1}]"
        extra = set(mk) - {"at", "seen", "mark"}
        if extra:
            raise _err(src, f"{where}: unbekannter Schluessel {sorted(extra)[0]!r}")
        for k in ("seen", "mark"):
            if not isinstance(mk.get(k, False), bool):
                raise _err(src, f"{where}.{k}: true oder false erwartet")
        c = at(mk, where)
        content[c] |= (0x80 if mk.get("mark", True) else 0) | (0x40 if mk.get("seen") else 0)
    # Kopf
    for k in ("start", "dir", "outside"):
        if k not in mp:
            raise _err(src, f"map.{k} fehlt")
    st = mp["start"]
    if not (isinstance(st, list) and len(st) == 2):
        raise _err(src, "map.start = [x, y] erwartet")
    sx = _int(src, "map.start x", st[0], 0, width - 1)
    sy = _int(src, "map.start y", st[1], 0, height - 1)
    if mp["dir"] not in tuple(DIRS):
        raise _err(src, f"map.dir {mp['dir']!r}: N, O, S oder W erwartet")
    if mp["outside"] not in names:
        raise _err(src, f"map.outside: unbekannte Kachel {mp['outside']!r}")
    m = Map(str(mp.get("name", "")), width, height, tiles, cells, content, events,
            sy * width + sx, DIRS.index(mp["dir"]), names[mp["outside"]])
    m.events.sort(key=lambda e: (e.cell, e.type, e.param))
    try:
        validate(m)
    except ValueError as e:
        raise _err(src, str(e))
    return m


def load_toml(path):
    with open(path, encoding="utf-8") as f:
        return loads_toml(f.read(), str(path))


# ---------------------------------------------------------------- TOML schreiben

def q(s):
    """TOML-Basisstring mit Maskierung."""
    out = []
    for c in s:
        if c == '"':
            out.append('\\"')
        elif c == "\\":
            out.append("\\\\")
        elif ord(c) < 32 or ord(c) == 127:
            out.append(f"\\u{ord(c):04x}")
        else:
            out.append(c)
    return '"' + "".join(out) + '"'


def to_toml(m, legend=None):
    """Karte als TOML (Kacheln k<index> mit index, Legende automatisch).

    legend: optional {Zeichen: (Kachelindex, Gegenstand)}; muss alle vorkommenden Paare abdecken.
    """
    validate(m)
    pairs = sorted({(c, it & 0x3F) for c, it in zip(m.cells, m.content)})
    if legend is None:
        if len(pairs) > len(LEGEND_POOL):
            raise ValueError("zu viele Kombinationen fuer eine ASCII-Karte")
        legend = {ch: p for ch, p in zip(LEGEND_POOL, pairs)}
    rev = {p: ch for ch, p in legend.items()}
    L = ['format  = "dbemap"', "version = 1", "", "[map]", f"name    = {q(m.name)}",
         f"start   = [{m.start % m.width}, {m.start // m.width}]", f'dir     = "{DIRS[m.direction]}"',
         f'outside = "k{m.outside}"', ""]
    for i, t in enumerate(m.tiles):
        L.append(f"[tiles.k{i}]")
        L.append(f"index   = {i}")
        L.append(f"walls   = [{', '.join(map(str, t.walls))}]")
        L.append(f"floor   = {t.floor}")
        L.append(f"ceiling = {t.ceiling}")
        L.append("flags   = [" + ", ".join(q(n) for n, b in FLAGS.items() if t.flags & b) + "]")
        L.append(f"automap_char = {t.automap_char}")
        L.append("")
    L.append("[legend]")
    for ch, (tile, item) in sorted(legend.items(), key=lambda kv: kv[1]):
        if (tile, item) in set(pairs):
            v = f'{{ tile = "k{tile}", item = {item} }}' if item else f'"k{tile}"'
            L.append(f"{q(ch)} = {v}")
    L += ["", "[layers]", 'tiles = """']
    for y in range(m.height):
        row = "".join(rev[(m.cells[y * m.width + x], m.content[y * m.width + x] & 0x3F)]
                      for x in range(m.width))
        L.append(row.replace("\\", "\\\\").replace('"', '\\"'))
    L += ['"""', ""]
    tname = {v: k for k, v in EVENT_TYPES.items()}
    for e in sorted(m.events, key=lambda e: (e.cell, e.type, e.param)):
        L += ["[[events]]", f"at    = [{e.cell % m.width}, {e.cell // m.width}]",
              f"type  = {q(tname[e.type]) if e.type in tname else e.type}", f"param = {e.param}", ""]
    for i, c in enumerate(m.content):
        if c & 0xC0:
            L += ["[[marks]]", f"at = [{i % m.width}, {i // m.width}]"]
            if c & 0x80 == 0:
                L.append("mark = false")
            if c & 0x40:
                L.append("seen = true")
            L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------- Textuebersicht

def describe(m):
    tname = {v: k for k, v in EVENT_TYPES.items()}
    L = [f"Karte {m.width} x {m.height}, {len(m.tiles)} Kacheln, {len(m.events)} Ereignisse",
         f"Start: Zelle {m.start} ({m.start % m.width}, {m.start // m.width}), Richtung {DIRS[m.direction]}",
         f"Kachel ausserhalb: {m.outside}", "", "Kacheln (Nr: N O S W Boden Decke Flags Automap):"]
    for i, t in enumerate(m.tiles):
        fl = ",".join(n for n, b in FLAGS.items() if t.flags & b) or "-"
        L.append(f"  {i:3}: {' '.join(f'{v:3}' for v in t.walls)}  {t.floor:3} {t.ceiling:3}  {fl}  {t.automap_char}")
    L += ["", "Kachelebene:"]
    for y in range(m.height):
        L.append(" ".join(f"{c:02x}" for c in m.cells[y * m.width:(y + 1) * m.width]))
    items = [(i, c) for i, c in enumerate(m.content) if c]
    L += ["", f"Inhalt ({len(items)} Zellen):"]
    for i, c in items:
        L.append(f"  ({i % m.width}, {i // m.width}): Gegenstand {c & 63}"
                 + (" gesehen" if c & 0x40 else "") + (" Marke" if c & 0x80 else ""))
    L += ["", "Ereignisse:"]
    for e in m.events:
        L.append(f"  ({e.cell % m.width}, {e.cell // m.width}): {tname.get(e.type, e.type)} {e.param}")
    return "\n".join(L)


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("map")
    b.add_argument("out")
    b.add_argument("--load", default="0x8000", help="Ladeadresse (Standard $8000)")
    d = sub.add_parser("dump")
    d.add_argument("input")
    d.add_argument("--toml")
    c = sub.add_parser("check")
    c.add_argument("map")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "dump":
            with open(a.input, "rb") as f:
                m = from_dmp(f.read())
            if a.toml:
                with open(a.toml, "w", encoding="utf-8") as f:
                    f.write(to_toml(m))
            else:
                print(describe(m))
            return 0
        m = load_toml(a.map)
        for w in warnings_for(m):
            print(f"Warnung: {w}", file=sys.stderr)
        if a.cmd == "build":
            data = to_dmp(m, int(a.load.replace("$", "0x"), 0))
            with open(a.out, "wb") as f:
                f.write(data)
            print(f"{a.out}: {len(data)} Byte, {m.width} x {m.height}, {len(m.tiles)} Kacheln, {len(m.events)} Ereignisse")
        else:
            print(f"{a.map}: in Ordnung ({m.width} x {m.height}, {len(m.tiles)} Kacheln)")
        return 0
    except (ValueError, OSError) as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
