#!/usr/bin/env python3
"""Karte von Crawl 128 (CRAWL128.CD1) in eine DBE-Karte (DMP v1) umwandeln.

CRAWL128.CD1: PRG (Ladeadresse ohne Bedeutung), danach
  OS (Offset der Kartendaten), W, H, Anzahl Edelsteine (Wort),
  Datensaetze zu 3 Byte (ASCII-Zeichen, Zellindex als Wort) bis OS - 1,
  Karte (W*H Byte, Zellwerte), Kartenname (ASCII).
Abbildung (verlustfrei, docs/specs/P4-map.md, Abschnitt 5): Kachelindex = Crawl-Zellwert,
ungerade Werte = Wand (Stil 1 auf allen Flaechen, WEG, SICHT, DECKEND, AUTOMAP),
gerade Werte = leer; Gegenstand = Zellwert fuer Werte aus --items (Standard 2,4).
NT = max(groesster Wert, 42) + 1: Kachel 1 (Wand) dient fuer Zellen ausserhalb der Karte,
Kachel 42 (Ausgang offen) setzt Crawl zur Laufzeit.

Aufruf:
  crawlmap.py CRAWL128.CD1 OUT.dmp [--toml OUT.toml] [--load ADDR] [--items 2,4] [--floor N] [--ceiling N]
  crawlmap.py --d81 IMAGE.d81 OUT.dmp [...]     (liest crawl128.cd1 per c1541)
"""
import argparse
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbemap  # noqa: E402
from dbemap import Event, Map, Tile, FLAGS  # noqa: E402

RECORD_EVENTS = {"8": ("teleport", 1), "B": ("gegner", 1), "D": ("gegner", 2), "F": ("gegner", 3),
                 "H": ("gegner", 4), "X": ("ausgang", 0), "Z": ("ausgang", 1)}
WALL_FLAGS = FLAGS["weg"] | FLAGS["sicht"] | FLAGS["deckend"] | FLAGS["automap"]


def convert(data, items=(2, 4), floor=0, ceiling=0):
    """CD1-Bytes -> (Map, Warnungen). ValueError bei Fehlern."""
    if len(data) < 7:
        raise ValueError("Datei zu kurz")
    b = data[2:]
    os_, w, h, gems = b[0], b[1], b[2], b[3] | (b[4] << 8)
    n = w * h
    if w < 1 or h < 1 or os_ < 5 or (os_ - 5) % 3 or len(b) < os_ + n:
        raise ValueError(f"ungueltiger Kopf (OS={os_}, W={w}, H={h}, Laenge {len(b)})")
    warn = []
    cellvals = list(b[os_:os_ + n])
    try:
        name = b[os_ + n:].decode("ascii")
    except UnicodeDecodeError:
        name = b[os_ + n:].decode("ascii", "replace")
        warn.append("Kartenname ist kein ASCII")
    events, start, seen = [], None, {}
    for i in range(5, os_, 3):
        ch = chr(b[i])
        cell = b[i + 1] | (b[i + 2] << 8)
        if cell >= n:
            raise ValueError(f"Datensatz {ch!r}: Zelle {cell} >= W*H {n}")
        seen[ch] = seen.get(ch, 0) + 1
        # Doppelte Datensaetze: '6' (Start mehrdeutig) und mehr als zwei '8' (crawl.bas: DIM TL%(1))
        # sind Fehler; sonst Warnung, denn crawl.bas nimmt den letzten, die DMP behaelt alle.
        if ch == "6" and seen[ch] > 1:
            raise ValueError("Datensatz '6' (Spielerstart) mehrfach")
        if ch == "8" and seen[ch] > 2:
            raise ValueError("mehr als zwei Datensaetze '8' (Crawl kennt genau zwei Teleporter)")
        if ch not in "68" and seen[ch] == 2:
            warn.append(f"Datensatz {ch!r} mehrfach: Crawl nimmt den letzten, die DMP enthaelt alle")
        if ch == "6":
            start = cell
        elif ch in RECORD_EVENTS:
            t, p = RECORD_EVENTS[ch]
            events.append(Event(cell, dbemap.EVENT_TYPES[t], p))
        else:
            warn.append(f"unbekannter Datensatz {ch!r} (Zelle {cell}): Typ 255, Parameter {b[i]}")
            events.append(Event(cell, 255, b[i]))
    if start is None:
        raise ValueError("kein Datensatz '6' (Spielerstart)")
    # Kachel 1 fuer ausserhalb; Kachel 42 (Ausgang offen) setzt crawl.bas 5550 zur Laufzeit.
    nt = max(max(cellvals), 42) + 1
    tiles = []
    for v in range(nt):
        if v & 1:
            tiles.append(Tile((1, 1, 1, 1), 0, 0, WALL_FLAGS, 0, f"k{v}"))
        else:
            tiles.append(Tile((0, 0, 0, 0), floor, ceiling, 0, 0, f"k{v}"))
    if cellvals.count(2) != gems:
        warn.append(f"{cellvals.count(2)} Zellen mit Wert 2, Kopf nennt {gems} Edelsteine")
    content = [v if v in items else 0 for v in cellvals]
    events.sort(key=lambda e: (e.cell, e.type, e.param))
    m = Map(name, w, h, tiles, cellvals, content, events, start, 0, 1)
    return m, warn


def legend_for(m):
    """Legende fuer --toml: Zeichen chr(48 + v), Gegenstand = Wert."""
    leg = {}
    for v, it in sorted({(c, i) for c, i in zip(m.cells, m.content)}):
        if v > 78:
            raise ValueError(f"Zellwert {v} > 78: kein ASCII-Zeichen fuer die Legende")
        leg[chr(48 + v)] = (v, it)
    return leg


def read_d81(image):
    """crawl128.cd1 aus einem D81-Image per c1541 lesen."""
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "crawl128.cd1")
        r = subprocess.run(["c1541", "-attach", image, "-read", "crawl128.cd1", out],
                           capture_output=True, text=True)
        if not os.path.exists(out):
            raise ValueError(f"c1541 konnte crawl128.cd1 nicht aus {image} lesen: {r.stderr.strip() or r.stdout.strip()}")
        with open(out, "rb") as f:
            return f.read()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("paths", nargs="+", metavar="PATH", help="CRAWL128.CD1 OUT.dmp (mit --d81 nur OUT.dmp)")
    ap.add_argument("--d81", metavar="IMAGE.d81")
    ap.add_argument("--toml")
    ap.add_argument("--load", default="0x4000")
    ap.add_argument("--items", default="2,4")
    ap.add_argument("--floor", type=int, default=0)
    ap.add_argument("--ceiling", type=int, default=0)
    a = ap.parse_args(argv)
    try:
        if len(a.paths) != (1 if a.d81 else 2):
            ap.error("Aufruf: CRAWL128.CD1 OUT.dmp  oder  --d81 IMAGE.d81 OUT.dmp")
        out = a.paths[-1]
        if a.d81:
            data = read_d81(a.d81)
        else:
            with open(a.paths[0], "rb") as f:
                data = f.read()
        items = tuple(int(x) for x in a.items.split(",") if x.strip())
        if any(not 1 <= i <= 63 for i in items):
            raise ValueError("--items: Werte 1 ... 63 erwartet")
        for v in (a.floor, a.ceiling):
            if not 0 <= v <= 255:
                raise ValueError("--floor/--ceiling: 0 ... 255 erwartet")
        m, warn = convert(data, items, a.floor, a.ceiling)
        for w in warn:
            print(f"Warnung: {w}", file=sys.stderr)
        load = int(a.load.replace("$", "0x"), 0)
        dmp = dbemap.to_dmp(m, load)
        dbemap.check_bank1(load, len(dmp) - 2)
        with open(out, "wb") as f:
            f.write(dmp)
        if a.toml:
            with open(a.toml, "w", encoding="utf-8") as f:
                f.write(dbemap.to_toml(m, legend_for(m)))
        print(f"{out}: {len(dmp)} Byte, {m.width} x {m.height}, {len(m.tiles)} Kacheln, "
              f"{sum(1 for c in m.content if c)} Gegenstaende, {len(m.events)} Ereignisse, "
              f"Start ({m.start % m.width}, {m.start // m.width}) Richtung {dbemap.DIRS[m.direction]}")
        return 0
    except (ValueError, OSError) as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
