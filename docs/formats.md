# Schnittstellen und Datenformate (Stand: Objekte in VIEW)

## Dateien

| Datei | Bank / Adresse | Inhalt |
|---|---|---|
| `DBE.STUB` | Bank 0, `$0D00–$0D83` | Stub: Bankwechsel, Interruptweiche, Aufruf der Lib |
| `DBE.LIB` | Bank 1, ab `$C000` | Lib (Sprungtabelle bei `$C000`) |
| `*.WSM` | Bank 1, beliebig (Crawl-Test: `$E000`) | Wandsatz-Metadaten |
| `*.SPR` | Bank 1, beliebig (Crawl-Test: `$E200` Geister, `$EA00` Edelstein) | Sprite-Metadaten mit VMS-Listen |
| gepackte Bilder (Crawl: `GHOSTS.VDC`) | VRAM, per `RTV` | nur die sichtbaren Bytes, in VMS-Reihenfolge |

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
| `$0C10` (3088) | Objektliste: Anzahl (max. 8) | Byte |
| `$0C11` (3089) | je Objekt 4 Byte: Position (Wort), Sprite-Satz, Blickrichtung | |

### Funktionen

| F | Name | Eingang | Ausgang |
|---|---|---|---|
| 0 | `INIT` | – | setzt alle Variablen zurück; A = 0, X = Version; P0 = Codeende, P1 = Ende der Variablen |
| 1 | `MAPINIT` | P0 = Kartenadresse (Bank 1), P1 = Breite, P2 = Höhe (< 256), P3 = Arbeitskopie (Bank 1, 0 = keine) | A = 0; mit P3 wird die Karte dorthin kopiert und die Kopie benutzt; Objektliste geleert |
| 2 | `SETPOS` | P0 = Zellindex, X = Richtung (0 N, 1 O, 2 S, 3 W) | A = 0 |
| 6 | `SETCELL` | P0 = Zellindex, X = neuer Zellwert | A = 0 oder 1 (außerhalb der Karte) |
| 4 | `VIEW` | P0 = Bildpuffer im VRAM (`AP`) | VCL-Liste ab `$0B00` (2816), VMS-Listen ab `$0E00`; A = 0 oder 2 (Puffer voll), X = Einträge, Y = Länge |
| 8 | `WALLSET` | P0 = Metadaten (Bank 1), P1 = VRAM-Adresse der Wandbilder | A = 0, 1 (Format) oder 2 (zu viele Einträge) |
| 9 | `SPRITESET` | X = Satz 0–3, P0 = Metadaten (Bank 1; 0 = löschen), P1 = VRAM-Adresse der Bilddaten | A = 0 oder 1 (Format) |
| 10 | `ITEMSET` | X = Zellwert 0–63, Y = Satz + 1 (0 = kein Gegenstand) | A = 0 |
| 3, 5, 7 | – | – | A = 255 (nicht vorhanden) |

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
| 2 | Flags: Bit 0 = deckt seine Spalten über die volle Höhe ab; Bit 7 = Objektplatz (Rest ohne Bedeutung) |
| 3 | Breite in Byte |
| 4 | Höhe in Rasterzeilen |
| 5–6 | Quelle (relativ zur VRAM-Adresse aus `WALLSET`) |
| 7–8 | Ziel (relativ zu `AP`) |
| 9 | erste Spalte (für die Abdeckung, < 128) |

Die Einträge stehen von vorne nach hinten: Tiefe aufsteigend, je Tiefe erst Frontflächen, dann Objektplätze, dann Seitenflächen. Mehrere Einträge pro Zelle sind erlaubt. Ein Objektplatz (d, s) sagt `VIEW`, an welcher Stelle Objekte und Gegenstände dieser Zelle einsortiert werden.

## Sprite-Metadaten (SPR), Version 1

### Kopf (6 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"S" "P"` (`$53 $50`) |
| 2 | Version = 1 |
| 3 | Anzahl Teile |
| 4–5 | reserviert (0) |

### Teil (14 Byte)

| Offset | Inhalt |
|---|---|
| 0 | Tiefe d |
| 1 | Seite s (vorzeichenbehaftet) |
| 2 | Blickwinkel 0–3, `$FF` = jeder |
| 3 | Flags: Bit 0 = mit `VMS` transparent zeichnen (sonst `VMC`) |
| 4 | Breite in Byte |
| 5 | Höhe in Rasterzeilen |
| 6–7 | Quelle (relativ zur VRAM-Adresse aus `SPRITESET`) |
| 8–9 | Ziel (relativ zu `AP`) |
| 10 | erste Spalte im Sichtfenster (für die Abdeckung) |
| 11 | Länge der VMS-Liste (0 bei `VMC`) |
| 12–13 | Offset der VMS-Liste (relativ zum Anfang der Metadaten) |

Danach folgen die VMS-Listen im Format von VDC-BASIC: Alpha-Wert, Anzahl Befehle, dann Befehle (`1` Offset-Wort Länge = Lauf kopieren, `8` Offset-Wort = ein Byte mit einem transparenten Pixel überblenden). Bei `VMS` liegt die Quelle gepackt vor, also nur die Bytes, die die Liste schreibt. Eine Liste ist höchstens 256 Byte lang; größere Bilder bestehen aus mehreren Teilen (Zeilenblöcken).

Ein Objekt in Zelle (d, s) mit Blickwinkel a zeichnet alle Teile seines Satzes mit gleichem d und s und Blickwinkel a oder `$FF`. Der Blickwinkel ist `(2 + Spieler-Richtung − Objekt-Richtung) AND 3` (entspricht `GV%()` in Crawl). Gegenstände in der Karte nutzen Blickwinkel `$FF`.

### VIEW

1. Aus der Blickrichtung ergeben sich Vorwärtsschritt F und Rechtsschritt R (N: −B/+1, O: +1/+B, S: +B/−1, W: −1/−B; B = Kartenbreite).
2. Für jeden Eintrag wird die Zelle `pos + d·F + s·R` geprüft. Ist sie eine Wand und noch mindestens eine ihrer Spalten frei, wird der Eintrag vorgemerkt. Hat er Flag Bit 0, markiert er seine Spalten als verdeckt.
3. Ein Objektplatz in einer freien Zelle merkt die passenden Sprite-Teile vor: erst die Objekte aus der Objektliste an dieser Position, dann den Gegenstand aus `ITEMSET` für den Zellwert. Sprite-Teile decken nichts ab, werden aber weggelassen, wenn alle ihre Spalten schon verdeckt sind.
4. Ausgabe nach `$0B00`: zuerst Typ 4 (`VMF AP+Clear-Offset, Wert, Länge`), dann alle vorgemerkten Einträge von hinten nach vorne: Wände als Typ 2 (`VMC Quelle, Ziel, Breite, Höhe, Zeilenbreite`), Sprite-Teile als Typ 12 (`VMS Quelle, Ziel, Liste`, die Liste kopiert `VIEW` nach `$0E00`) oder Typ 2; am Ende 0. Typ 12 braucht VDC-BASIC v2g mit dem VCL-Typ für `VMS`.
5. Mehr als 22 sichtbare Einträge oder mehr als 512 Byte VMS-Listen passen nicht in die Puffer. Dann bricht `VIEW` hinten ab und meldet A = 2.

`tools/wallconv.py` wandelt `WALLS.VDC` aus Crawl 128 in dieses Format um. Die Lage der 19 Crawl-Bilder im Sichtgitter (Tiefe, Seite, Fläche) steht dort in `SLOTS`. `tools/crawlsprites.py` erzeugt die Sprite-Sätze für Geister (`RED.VDC`, `RED1.VDC`, transparent) und Edelsteine (Font-Zeichen), mit den Positionen aus Crawl.
