#!/usr/bin/env python3
"""Wandsatz von Crawl 128 (WALLS.VDC) in DBE-Wandsatz-Metadaten (WSM) umwandeln.

WALLS.VDC: PRG-Datei; Byte 0 = Anzahl Einträge, dann je 7 Byte
  Quelle (W, relativ zur VRAM-Basis), Breite, Höhe, Größe (W), Spalte (Ziel = Spalte + 406).
Die Einträge sind nach den Sichtfeld-Slots 1..19 von crawl.bas geordnet; ihre Lage im
Sichtgitter (Tiefe d, Seite s, Fläche) steht in SLOTS unten.

Ausgabe (docs/formats.md, Wandsatz-Metadaten v1), als PRG mit Ladeadresse:
  Kopf 10 Byte: "W","S",1, Anzahl, Clear-Offset (W), Clear-Länge (W), Clear-Wert, Zeilenbreite
  Eintrag 10 Byte: d, s, Flags, Breite, Höhe, Quelle (W), Ziel (W), Spalte
Reihenfolge: von vorne nach hinten (d aufsteigend, je Tiefe erst Fronten, dann Objektplätze, dann Seiten).
Objektplätze haben Flag $80 und sonst keine Daten.
"""
import argparse
import struct
import sys

FRONT, SLOT, SIDE = 0, 1, 2     # Reihenfolge je Tiefe: Fronten, Objektplätze, Seiten

# Slot (1..19) -> (d, s, Fläche); abgeleitet aus V%() in crawl.bas, Zeilen 90-95
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

ROW = 80            # Zeilenbreite des Bildpuffers in Byte (EI% in crawl.bas)
DEST_BASE = 406     # 5 * 80 + 6: linke obere Ecke des Sichtfensters
CLEAR_OFF = 400     # crawl.bas Zeile 4610: VMF AP+400, 0, 7600
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
        flags = 1 if h == full else 0       # nur volle Höhe deckt Spalten ab
        ents.append(((d, face, slot), d, s, flags, w, h, src, DEST_BASE + col, col))
    # Objektplätze: jede Zelle mit d >= 1 aus dem Sichtgitter; VIEW setzt dort Objekte und Gegenstände ein
    for d, s in sorted({(d, s) for d, s, _f in SLOTS.values() if d >= 1}):
        ents.append(((d, SLOT, 0), d, s, 0x80, 0, 0, 0, 0, 0))
    ents.sort(key=lambda e: e[0])
    if len(ents) > MAXENT:
        sys.exit(f"zu viele Einträge: {len(ents)} > {MAXENT}")
    out = bytearray(b"WS")
    out += struct.pack("<BBHHBB", 1, len(ents), CLEAR_OFF, CLEAR_LEN, CLEAR_VAL, ROW)
    for _k, d, s, flags, w, h, src, dest, col in ents:
        out += struct.pack("<BbBBBHHB", d, s, flags, w, h, src, dest, col)
    return out, ents


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("walls_vdc")
    ap.add_argument("out_wsm")
    ap.add_argument("--load", type=lambda x: int(x, 0), default=0xE000, help="Ladeadresse (Bank 1)")
    ap.add_argument("-v", action="store_true", help="Einträge ausgeben")
    a = ap.parse_args()
    data = open(a.walls_vdc, "rb").read()
    out, ents = convert(data)
    with open(a.out_wsm, "wb") as f:
        f.write(struct.pack("<H", a.load) + out)
    if a.v:
        for _k, d, s, flags, w, h, src, dest, col in ents:
            print(f"d={d} s={s:+d} flags={flags} w={w:2} h={h:2} src={src:5} dest={dest} col={col}")
    print(f"{len(ents)} Einträge, {len(out)} Byte -> {a.out_wsm}")


if __name__ == "__main__":
    main()
