# Schnittstellen und Datenformate (Stand: Objekte in VIEW)

## Dateien

| Datei | Bank / Adresse | Inhalt |
|---|---|---|
| `DBE0.1.STUB` | Bank 0, `$0D00–$0D83` | Stub: Bankwechsel, Interruptweiche, Aufruf der Lib |
| `DBE0.1.LIB` | Bank 1, ab `$C000` | Lib (Sprungtabelle bei `$C000`) |
| `*.WSM` | Bank 1, beliebig (Crawl-Test: `$E000`) | Wandsatz-Metadaten |
| `*.SPR` | Bank 1, beliebig (Crawl-Test: `$E200` Geister, `$EA00` Edelstein) | Sprite-Metadaten mit VMS-Listen |
| gepackte Bilder (Crawl: `GHOSTS.VDC`) | VRAM, per `RTV` | nur die sichtbaren Bytes, in VMS-Reihenfolge |

Laden in BASIC:

```
BLOAD"DBE0.1.STUB",B0,U(DD):BLOAD"DBE0.1.LIB",B1,U(DD):SYS 3328
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

### Karte

Das Kartenformat ist ab Version 0.2 das Format **DMP v1** (Abschnitt „DMP v1“ unten). Das frühere Format (ein Byte je Zelle, Bit 0 = Wand) entspricht der Kachelebene der Konvertierung von `tools/crawlmap.py`, bei der Kachelindex = Crawl-Zellwert gilt.

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

### Teil (15 Byte)

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
| 11–12 | Länge der VMS-Liste in Byte (0 bei `VMC`) |
| 13–14 | Offset der VMS-Liste (relativ zum Anfang der Metadaten) |

Danach folgen die VMS-Listen im Format von VDC-BASIC: Alpha-Wert (Byte), Anzahl Befehle (Wort), dann Befehle (`1` Offset-Wort Länge = Lauf kopieren, `8` Offset-Wort = ein Byte mit einem transparenten Pixel überblenden). Bei `VMS` liegt die Quelle gepackt vor, also nur die Bytes, die die Liste schreibt. Listen dürfen länger als 256 Byte sein; `VIEW` kopiert sie je Bild in den 512-Byte-Puffer bei `$0E00`.

Ein Objekt in Zelle (d, s) mit Blickwinkel a zeichnet alle Teile seines Satzes mit gleichem d und s und Blickwinkel a oder `$FF`. Der Blickwinkel ist `(2 + Spieler-Richtung − Objekt-Richtung) AND 3` (entspricht `GV%()` in Crawl). Gegenstände in der Karte nutzen Blickwinkel `$FF`.

### VIEW

1. Aus der Blickrichtung ergeben sich Vorwärtsschritt F und Rechtsschritt R (N: −B/+1, O: +1/+B, S: +B/−1, W: −1/−B; B = Kartenbreite).
2. Für jeden Eintrag wird die Zelle `pos + d·F + s·R` geprüft. Ist sie eine Wand und noch mindestens eine ihrer Spalten frei, wird der Eintrag vorgemerkt. Hat er Flag Bit 0, markiert er seine Spalten als verdeckt.
3. Ein Objektplatz in einer freien Zelle merkt die passenden Sprite-Teile vor: erst die Objekte aus der Objektliste an dieser Position, dann den Gegenstand aus `ITEMSET` für den Zellwert. Sprite-Teile decken nichts ab, werden aber weggelassen, wenn alle ihre Spalten schon verdeckt sind.
4. Ausgabe nach `$0B00`: zuerst Typ 4 (`VMF AP+Clear-Offset, Wert, Länge`), dann alle vorgemerkten Einträge von hinten nach vorne: Wände als Typ 2 (`VMC Quelle, Ziel, Breite, Höhe, Zeilenbreite`), Sprite-Teile als Typ 12 (`VMS Quelle, Ziel, Liste`, die Liste kopiert `VIEW` nach `$0E00`) oder Typ 2; am Ende 0. Typ 12 braucht VDC-BASIC v2g mit dem VCL-Typ für `VMS`.
5. Mehr als 22 sichtbare Einträge oder mehr als 512 Byte VMS-Listen passen nicht in die Puffer. Dann bricht `VIEW` hinten ab und meldet A = 2.

`tools/wallconv.py` wandelt `WALLS.VDC` aus Crawl 128 in dieses Format um. Die Lage der 19 Crawl-Bilder im Sichtgitter (Tiefe, Seite, Fläche) steht dort in `SLOTS`. `tools/crawlsprites.py` erzeugt die Sprite-Sätze für Geister (`RED.VDC`, `RED1.VDC`, transparent) und Edelsteine (Font-Zeichen), mit den Positionen aus Crawl.

## VRL v1 (RLE-Strom für `RXV`)

Details: `docs/specs/P1-vrl.md`, Werkzeug `tools/vrl.py`. Wörter Low/High.

| Byte b | Folgebytes | Bedeutung |
|---|---|---|
| `$00` | – | Ende |
| `$01–$7F` | n = b Bytes | n Literale (1 … 127) |
| `$80–$FD` | v | Lauf: L = b − `$80` + 2 (2 … 127) mal v |
| `$FE` | lo, hi | Skip: Ziel um n = hi·256 + lo weiter (0 = 65536), nichts schreiben |
| `$FF` | lo, hi, v | langer Lauf: L = hi·256 + lo mal v (0 = 65536) |

Dateirahmen (PRG):

| Offset | Größe | Inhalt |
|---|---|---|
| 0 | 2 | Ladeadresse (Standard `$2000`) |
| 2 | 2 | `"V" "R"` |
| 4 | 1 | Version = 1 |
| 5 | 2 | entpackte Länge U (0 … 65535; Skip am Ende zählt nicht) |
| 7 | … | Strom bis einschließlich `$00` |

Rohe Ströme ohne Kopf (`--raw`) sind möglich, z. B. eingebettet in DTS.

## DVG v1 (Sichtfenster-Geometrie, von `tools/dbegeom.py`)

PRG-Datei (2 Byte Ladeadresse, `[output].load`, Standard `$E400`, Bank 1). Alle Offsets relativ zum Inhalt, Wörter Low/High. Quelle: `docs/specs/P3-geometry.md`.

### Kopf (24 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"D" "V"` |
| 2 | Version = 1 |
| 3 / 4 | VW: Breite in Byte (width_px / 2) / VH: Höhe in Zeilen |
| 5 / 6 | D (Tiefe) / S (größtes \|s\|) |
| 7 | NE: Anzahl Elemente (≤ 255) |
| 8–9 / 10–11 | stride / origin |
| 12–13 | Geometrie-ID: CRC-16/CCITT (`binascii.crc_hqx`, Start `$FFFF`) über den Inhalt mit Bytes 12–13 und 10–11 (origin) = 0; 0 wird 1. `origin` gehört nicht zur ID (Form, nicht Lage) |
| 14 / 15 | Horizontband y0 / y1 (exklusiv, beschnitten) |
| 16 / 17 | Elementlänge = 16 / Länge Tiefeneintrag = 8 |
| 18–19 / 20–21 | Offset Tiefentabelle (24) / Offset Elementtabelle (24 + 8·(D+1)) |
| 22–23 | Gesamtlänge des Inhalts |

### Tiefeneintrag (8 Byte, D + 1 Stück, d = 0 … D)

| Offset | Inhalt |
|---|---|
| 0–1 | Deckenband y0, y1 (exklusiv; gleich = leer) |
| 2–3 | Bodenband y0, y1 (exklusiv) |
| 4 / 5 | Index des ersten Elements / Anzahl Elemente der Tiefe |
| 6 / 7 | Breite der Vollfront in Byte (0 bei d = 0) / Byte-Spalte der Vollfront |

### Element (16 Byte)

Reihenfolge von vorne nach hinten: d aufsteigend; je Tiefe Zellen s = 0, −1, +1, −2, +2 …; je Zelle Front, Seite, Boden, Decke, Objektplatz.

Front (0), Seite (1), Boden (2), Decke (3):

| Offset | Inhalt |
|---|---|
| 0 / 1 / 2 | Art / d / s (vorzeichenbehaftet) |
| 3 | Flags: Bit 0 = Spaltenbereich gültig, Bit 1 = Teilfront (Bild = Vollfront der Tiefe ab `src_dx`), Bit 2 = beschnitten |
| 4–7 | x (Byte-Spalte), y (Zeile), w (Byte), h (Zeilen) des Rechtecks |
| 8–11 | Kern kx, ky, kw, kh (relativ zum Rechteck; kw = 0: kein Kern) |
| 12 / 13 | Spaltenbereich c0 / c1 (exklusiv, absolut) |
| 14 | src_dx (nur Teilfront) |
| 15 | 0 |

Objektplatz (Art 4): Byte 1 = d, 2 = s, 3 = 0, 4–13 = 5 Anker p = 0 … 4 (hinten links, hinten rechts, Mitte, vorne links, vorne rechts) je Byte-Spalte (vorzeichenbehaftet, gesättigt auf −128 … 127) und Zeile des Fußpunkts (gesättigt auf ≤ 255), 14–15 = 0.

Ziel im Puffer: `AP + origin + y · stride + x`.

## DMP v1 (Karte, von `tools/dbemap.py` und `tools/crawlmap.py`)

PRG-Datei: 2 Byte Ladeadresse (Standard `$8000`, Bank 1), dann der Inhalt. Offsets relativ zum Inhalt, Wörter Low/High. Quelle: `docs/specs/P4-map.md`. Zelle (x, y), Index i = y · W + x; Richtungen 0 N, 1 O, 2 S, 3 W (Norden = kleineres y). Stilnummer: 0 = nichts, n ≥ 1 = Stil n − 1 im zugehörigen DTS.

### Kopf (24 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"D" "M"` (`$44 $4D`) |
| 2 | Version = 1 |
| 3 | W (1 … 255) |
| 4 | H (1 … 255) |
| 5 | NT: Anzahl Kacheln (1 … 256; 256 als 0 gespeichert) |
| 6–7 | NE: Anzahl Ereignisse |
| 8–9 | Startzelle (Zellindex) |
| 10 | Startrichtung (0–3) |
| 11 | Kachel für Zellen außerhalb der Karte (Index < NT) |
| 12–13 | Offset Kachelebene (= 24) |
| 14–15 | Offset Inhaltsebene (= 24 + W·H) |
| 16–17 | Offset Kacheltabelle (= 24 + 2·W·H) |
| 18–19 | Offset Ereignisse (= Kacheltabelle + 8·NT) |
| 20–21 | Gesamtlänge des Inhalts (= Ereignisse + 4·NE) |
| 22–23 | reserviert 0 |

W · H ≤ 16384 (Warnung über 4096, weil die Lib die Karte in Bank 1 hält).

### Kachelebene (W·H Byte)

Zeilenweise, ein Byte je Zelle: Kachelindex < NT.

### Inhaltsebene (W·H Byte)

| Bit | Bedeutung |
|---|---|
| 0–5 | Gegenstand 0–63 (0 = keiner); Zuordnung zu einem Sprite-Satz über `ITEMSET`; liegt auf Unterposition Mitte |
| 6 | Automap: gesehen (Laufzeit; in der Datei normalerweise 0) |
| 7 | Automap: Marke |

### Kacheltabelle (NT × 8 Byte)

| Offset | Inhalt |
|---|---|
| 0 | Wandstil Nordfläche |
| 1 | Wandstil Ostfläche |
| 2 | Wandstil Südfläche |
| 3 | Wandstil Westfläche |
| 4 | Bodenstil (0 = kein Boden) |
| 5 | Deckenstil (0 = keine Decke) |
| 6 | Flags |
| 7 | Automap-Zeichen (0 = Standard nach Flag AUTOMAP) |

| Flag-Bit | Name | Bedeutung |
|---|---|---|
| 0 | WEG | versperrt den Weg (`MOVE`) |
| 1 | SICHT | versperrt die Sicht für die Spiellogik |
| 2 | DECKEND | `VIEW`: Flächen decken ihre Spaltenbereiche ab (nur, wenn auch das Bild im DTS deckend ist) |
| 3 | TÜR | Tür (Spiellogik) |
| 4 | AUTOMAP | auf der Automap als Wand zeichnen |
| 5–7 | – | 0 |

Eine Zelle hat Flächen, wenn mindestens ein Wandstil ≠ 0 ist. Gezeigte Kachelfläche je Lage (d, s) und Blickrichtung v: Front (v + 2) AND 3; Seite links (s < 0) (v + 1) AND 3; Seite rechts (s > 0) (v + 3) AND 3. Boden und Decke werden auch in Zellen mit Flächen gezeichnet; bei DECKEND und vier Wandstilen ≠ 0 sind sie unsichtbar und zählen bei der Lückenprüfung der Bänder nicht als Lücke. Zellen außerhalb der Karte verhalten sich wie die Kachel aus Kopf-Byte 11.

### Ereignisse (NE × 4 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | Zellindex |
| 2 | Typ |
| 3 | Parameter |

Sortiert nach (Zellindex, Typ, Parameter). Typen: 0 ungültig; 1 `gegner` (Parameter = Gegnernummer); 2 `teleport` (Gruppe; Ziel = andere Zelle mit gleicher Gruppe); 3 `ausgang` (0 geschlossen, 1 offen); 4 `text` (Textnummer); 5–127 reserviert für die Engine; 128–255 frei für das Spiel.

### Unterpositionen

Karte und Objektliste speichern Unterpositionen absolut: 0 NW, 1 NO, 2 SW, 3 SO, 4 Mitte. `VIEW` rechnet sie mit der Blickrichtung v in die Zeichenposition p der Geometrie um (0 hinten links, 1 hinten rechts, 2 Mitte, 3 vorne links, 4 vorne rechts):

| v | NW | NO | SW | SO | Mitte |
|---|---|---|---|---|---|
| 0 N | 0 | 1 | 3 | 4 | 2 |
| 1 O | 3 | 0 | 4 | 1 | 2 |
| 2 S | 4 | 3 | 1 | 0 | 2 |
| 3 W | 1 | 4 | 0 | 3 | 2 |

`tools/crawlmap.py` wandelt `CRAWL128.CD1` verlustfrei in DMP um (Kachelindex = Crawl-Zellwert, NT ≥ 43, weil Crawl den Ausgang zur Laufzeit auf Kachel 42 setzt); Beispiele: `docs/specs/examples/demo.toml`, `docs/specs/examples/crawl128.toml`.

## DTS v1 (Texturset, von `tools/dbetex.py`)

PRG-Datei: 2 Byte Ladeadresse (Standard `$A000`, Bank 1), dann der Inhalt; Offsets relativ zum Inhalt, Wörter Low/High. Quelle: `docs/specs/P5-textures.md`. Ein DTS enthält eine Art (Wand, Boden, Decke); die Bilddaten stehen getrennt in einer VRL-Datei (`RXV` an die VRAM-Basis, die `TEXSET` angibt); alle VRAM-Offsets sind relativ zu dieser Basis.

Kopf (32 Byte): `"DT"`, Version 1, Art (0 Wand, 1 Boden, 2 Decke), Geometrie-ID (Wort, aus der DVG), NE, D, NS (Slots), NST (Stile, ≤ 32), NI (Bilder, ≤ 254), NK (Kerne), je ein Wort Offset von Slotkarte, Stiltabelle, Bildverzeichnis, Kerntabelle, Datenbereich, Gesamtlänge, dann U (VRAM-Länge), CRC der VRAM-Daten (`crc_hqx`, Start `$FFFF`), stride, Reserve 0. Bereiche lückenlos in dieser Reihenfolge.

- **Slotkarte** (NE + 2·(D + 1) Byte): Index 0 … NE − 1 = DVG-Element, NE + d = Deckenband d, NE + (D + 1) + d = Bodenband d; Wert = Slot dieser Art oder `$FF`.
- **Stiltabelle** (NST × NS Byte): Bildindex, `$FE` = kein Bild, `$FF` = Rückgriff auf Stil 0. DMP-Stilnummer n ≥ 1 = Stil n − 1; 0 = nichts.
- **Bildverzeichnis** (NI × 16 Byte): Flags (Bit 0 DECKEND, 1 AUSSCHNITT, 2 ZEILEN, 3 RAND), Slot, nk, h, Offset des ersten Kerns (bei ZEILEN der h Füllbytes), VRAM-Offset der Randbytes, Anzahl Randbytes, Offset und Länge der VMS-Liste, Quellbild (bei AUSSCHNITT der Vollfront-Eintrag), 0.
- **Kerntabelle** (NK × 8 Byte): VRAM-Offset, dx, dy, w, h, srcstep (0 = gepackt, sonst Quellzeilenabstand).
- **Datenbereich**: VMS-Listen (Alpha, Anzahl Befehle, Befehle Typ 1 `01 ofs len`, Typ 8 `08 ofs`) und Zeilenfüllbytes.

## DBG v1 (Tapete, von `tools/dbetex.py bg`)

PRG-Datei (Standard `$A900`), Inhalt: `"DB"`, Version 1, VW, VH, Geometrie-ID (Wort), P (Panoramabreite in Byte, Wort), y0, h, Flags (Bit 0 WRAP), 4 Versatzwörter o_v (N, O, S, W), U = P · h (Wort), CRC der VRAM-Daten (Wort), dann VH Füllbytes (Farbe · 17 für Zeilen außerhalb [y0, y0 + h), sonst 0). Das Panorama liegt zeilenweise (P Byte je Zeile) in der zugehörigen VRL. Details und Zeichenregel: `docs/specs/P5-textures.md` 6.
