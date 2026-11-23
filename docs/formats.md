# Schnittstellen und Datenformate (Stand Schritt 1)

## Dateien

| Datei | Bank / Adresse | Inhalt |
|---|---|---|
| `DBE.STUB` | Bank 0, `$0D00–$0D83` | Stub: Bankwechsel, Interruptweiche, Aufruf der Lib |
| `DBE.LIB` | Bank 1, ab `$C000` | Lib (Sprungtabelle bei `$C000`) |
| `*.WSM` | Bank 1, beliebig (Crawl-Test: `$B000`) | Wandsatz-Metadaten |

Laden in BASIC:

```
BLOAD"DBE.STUB",B0,U(DD):BLOAD"DBE.LIB",B1,U(DD):SYS 3328
```

## Aufruf

| Aufruf | Wirkung |
|---|---|
| `SYS 3328` | Init: kopiert die Kernal-Interruptweiche `$FF05–$FFFF` nach Bank 1, ruft dann `INFO` auf |
| `SYS 3331,F,X,Y` | Funktion F aufrufen; Ergebnis mit `RREG A,X,Y` |

- Der aktuelle `BANK` ist egal: Der Stub schaltet selbst um und stellt `$FF00` und `$D506` danach wieder her.
- Während des Aufrufs gilt: `$FF00 = $7E` (Bank 1, nur RAM, I/O) und 4 KB gemeinsames RAM unten.
- Interrupts bleiben an.
- Zeropage: nur `$FA–$FD`.

### Parameterblock (Bank 0)

| Adresse | Name | Größe |
|---|---|---|
| `$0C00` (3072) | P0 | Wort |
| `$0C02` (3074) | P1 | Wort |
| `$0C04` (3076) | P2 | Wort |
| `$0C06` (3078) | P3 | Wort |

### Funktionen

| F | Name | Eingang | Ausgang |
|---|---|---|---|
| 0 | `INFO` | – | A = 0, X = Version; P0 = Codeende, P1 = Ende der Variablen |
| 1 | `MAPINIT` | P0 = Kartenadresse (Bank 1), P1 = Breite, P2 = Höhe (< 256) | A = 0 |
| 2 | `SETPOS` | P0 = Zellindex, X = Richtung (0 N, 1 O, 2 S, 3 W) | A = 0 |
| 4 | `VIEW` | P0 = Bildpuffer im VRAM (`AP`) | VCL-Liste ab `$0B00` (2816); A = 0 oder 2 (Liste voll), X = Wandeinträge, Y = Länge |
| 8 | `WALLSET` | P0 = Metadaten (Bank 1), P1 = VRAM-Adresse der Wandbilder | A = 0, 1 (Format) oder 2 (zu viele Einträge) |
| 3, 5–7 | – | – | A = 255 (nicht vorhanden) |

### Karte (vorläufig)

Ein Byte pro Zelle, zeilenweise. Bit 0 = Wand. Zellen außerhalb der Karte zählen als Wand. Das endgültige Format kommt in einem eigenen Schritt.

## Wandsatz-Metadaten (WSM), Version 1

Alle Wörter im Format Low/High.

### Kopf (10 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"W" "S"` (`$57 $53`) |
| 2 | Version = 1 |
| 3 | Anzahl Einträge (≤ 64) |
| 4–5 | Clear-Offset (relativ zu `AP`) |
| 6–7 | Clear-Länge (0 = nicht löschen) |
| 8 | Clear-Wert |
| 9 | Zeilenbreite des Bildpuffers in Byte (VMC-Inkrement) |

### Eintrag (10 Byte)

| Offset | Inhalt |
|---|---|
| 0 | Tiefe d (0 = eigene Zelle) |
| 1 | Seite s (vorzeichenbehaftet, negativ = links) |
| 2 | Flags: Bit 0 = deckt seine Spalten über die volle Höhe ab |
| 3 | Breite in Byte |
| 4 | Höhe in Rasterzeilen |
| 5–6 | Quelle (relativ zur VRAM-Adresse aus `WALLSET`) |
| 7–8 | Ziel (relativ zu `AP`) |
| 9 | erste Spalte (für die Abdeckung, < 128) |

Die Einträge stehen von vorne nach hinten: Tiefe aufsteigend, je Tiefe erst Frontflächen, dann Seitenflächen. Mehrere Einträge pro Zelle sind erlaubt.

### VIEW

1. Aus der Blickrichtung ergeben sich Vorwärtsschritt F und Rechtsschritt R (N: −B/+1, O: +1/+B, S: +B/−1, W: −1/−B; B = Kartenbreite).
2. Für jeden Eintrag wird die Zelle `pos + d·F + s·R` geprüft. Ist sie eine Wand und noch mindestens eine ihrer Spalten frei, wird der Eintrag vorgemerkt. Hat er Flag 0, markiert er seine Spalten als verdeckt.
3. Ausgabe nach `$0B00`: zuerst Typ 4 (`VMF AP+Clear-Offset, Wert, Länge`), dann die vorgemerkten Einträge von hinten nach vorne als Typ 2 (`VMC Quelle, Ziel, Breite, Höhe, Zeilenbreite`), am Ende 0.
4. Mehr als 22 sichtbare Einträge passen nicht in 256 Byte. Dann bricht `VIEW` hinten ab und meldet A = 2.

`tools/wallconv.py` wandelt `WALLS.VDC` aus Crawl 128 in dieses Format um. Die Lage der 19 Crawl-Bilder im Sichtgitter (Tiefe, Seite, Fläche) steht dort in `SLOTS`.
