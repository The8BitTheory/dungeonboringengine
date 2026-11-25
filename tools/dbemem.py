"""Bank-1-Speicherkarte der Engine 0.2 (docs/specs/P6-engine.md 2.4): Standard-Ladeadressen und Bereichspruefung.

Die Werkzeuge (dbemap, dbespr, dbetex, dbegeom) schreiben ihre Daten mit diesen Ladeadressen und brechen mit einer
Fehlermeldung ab, wenn die Daten ueber die Grenze ihres Bereichs reichen (statt still in den Nachbarbereich zu laufen).

Bank 1: $0400-$3FFF BASIC-Variablen (MEMSIZ $4000), $4000-$AFFF Assets, $B000-$E7FF Lib, LIBTAB und BSS,
$E800-$FBFF Assets, $FC00-$FEFF Blitz!-Runtime (gesperrt).
"""

# Art -> (Standard-Ladeadresse, Bereichsende exklusiv)
AREAS = {
    "dmp": (0x4000, 0x6000),       # Karte, 8 KB
    "s2": (0x6000, 0x8000),        # Sprite-Saetze, 8 KB
    "wall": (0x8000, 0xB000),      # DTS Wand, 12 KB
    "dvg": (0xE800, 0xEE00),       # Geometrie, 1,5 KB
    "floor": (0xEE00, 0xF600),     # DTS Boden, 2 KB
    "ceiling": (0xF600, 0xFB80),   # DTS Decke, 1,375 KB (1 Stil der Demo: 1295 Byte)
    "dbg": (0xFB80, 0xFC00),       # Tapete, 128 Byte (24 + VH <= 124)
}
# Zusammenhaengende freie Fenster; wer die Dateien dicht packt (eigene Ladeadressen), bleibt darin
WINDOWS = ((0x4000, 0xB000), (0xE800, 0xFC00))


def default_load(kind):
    return AREAS[kind][0]


def range_error(kind, load, length):
    """None, wenn load .. load + length - 1 im Bereich liegt, sonst der Text der Fehlermeldung.

    Liegt load im Standardbereich der Art, gilt dessen Ende; sonst (eigene Packung) das Ende des freien Fensters."""
    a, e = AREAS[kind]
    end = load + length
    if a <= load < e:
        if end > e:
            return (f"{kind}: ${load:04X}..${end - 1:04X} ({length} Byte) reicht ueber das Bereichsende ${e - 1:04X} "
                    f"(Bereich ${a:04X}..${e - 1:04X}, {e - a} Byte)")
        return None
    for wa, we in WINDOWS:
        if wa <= load < we:
            if end > we:
                return (f"{kind}: ${load:04X}..${end - 1:04X} ({length} Byte) reicht ueber das Ende des freien "
                        f"Speichers ${we - 1:04X}")
            return None
    return (f"{kind}: Ladeadresse ${load:04X} liegt nicht in Bank-1-Assetspeicher "
            f"($4000..$AFFF, $E800..$FBFF; Lib/BSS $B000..$E7FF, Runtime ab $FC00)")
