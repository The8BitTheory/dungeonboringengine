# Plan Engine 0.2 und VDC-BASIC v3: Boden, Decke, Tapete, freier Viewport, RLE

Stand: 2026-11-25. Abgestimmt mit dem Nutzer. Grundlage: `engine-design.md`, `formats.md`, Analyse von VDC-BASIC v2h und c128-vdc-gui.

## 1. Ziele

- Neben Wänden auch **Boden- und Deckentexturen**. Wandelemente nutzen **Transparenz** (Trapezecken, Fenster, Gitter, Bögen).
- **Hintergrundtapete** (Landschaft hinter Fenstern, Himmel, Abgrund).
- **Frei definierbarer Viewport**. Die Größe aller Elemente errechnet sich daraus und wird als Vorgabe ausgegeben. Die Texturen sind **handgemalte, vorgefertigte Tiles** (z. B. aus Aseprite); die Engine verzerrt nichts.
- **Dynamische Objekte** (Gegner, Gegenstände, Animationen) in der richtigen Tiefe.
- **Karten- und Grafikformate** festlegen. Grafiken sind RLE-gepackt (Format VRL) und werden mit dem neuen VDC-BASIC-Befehl **`RXV`** aus dem RAM ins VRAM entpackt, Läufe per Block fill.
- VDC-BASIC v3 bekommt außerdem `VDL`/`VDR`/`VDB` (Linie, leeres Rechteck, gefülltes Rechteck) mit Umschalter zwischen Bitmap (1 bpp) und chunky (4 bpp).

## 2. Randbedingungen

- **Chunky-Modus:** Die Bitmap ist fest `$0F`, die Pixel stehen im Attribut-RAM: 1 Byte = 2 Pixel zu 4 Bit, maximal 160 × 100 Pixel. Transparenz pro Byte (überspringen) oder pro Pixel (VMS-Befehl 8 bzw. Nibble-RMW).
- **Die Engine besitzt nur den 3D-Viewport** und einen Asset-Pool im VRAM, den das Spiel ihr zuweist. Den Rest des Bildschirms verwaltet das Spiel.
- **VRAM:** Neben Bitmap und zwei Attribut-Puffern bleiben etwa 26 KB für Font, HUD und Assets. Wandstile, Monster und Animationen teilen sich den Pool und werden je Karte oder Zone nachgeladen.
- **VDC-Praxis aus c128-vdc-gui:**
  - Reg 31 einmal anwählen, danach `bit $D600/bpl/sta $D601` (15 Zyklen pro Byte). Eine neue Adresse kostet etwa 80 Zyklen.
  - Block fill hat etwa 200 Zyklen Fixkosten.
  - Reg 24 nur per Read-Modify-Write ändern, Bit 6 erhalten.
  - Nach Block-Operationen steht 18/19 hinter dem Ende.
  - Horizontal arbeiten.
  - Reg 36 = 0 ist heikel für VRAM außerhalb der Anzeige.

## 3. Speicher

| Bereich (Bank 0) | neu |
|---|---|
| `$0B00–$0FFF` | Parameterblock, Stub (wie bisher); der alte VCL-Puffer `$0B00` wird frei |
| `$1300–$1BFF` | **Puffer der Engine:** VCL-Liste (etwa 1 KB) und VMS-Listen (etwa 1,3 KB) |
| `$1C00–$3FFF` | **VDC-BASIC v3** (vorher `$1300`, dort waren nur noch 10 Byte frei) |
| ab `$4001` | BASIC-Text: interpretiert über einen Boot-Lader (`POKE 45/46`, `POKE 16384,0`, `NEW`), kompiliert mit Blitz! Image 2 |

- VDC-BASIC muss unter `$4000` liegen, weil es bei eingeblendetem BASIC-ROM läuft.
- Das gemeinsame RAM der Engine wächst von 4 auf 8 KB (`$0000–$1FFF`), damit die Lib in Bank 1 die Puffer bei `$1300` sieht.
- Die Grenze von 256 Byte für die VCL-Liste und die VCL-Erweiterung V2 entfallen.
- **Zu prüfen:** Ladepuffer des Spiels in Bank 0 (Crawl `BE` ab `$94E8`) über dem Programmende; VDC-BASIC-Tests, die VMS-Listen bei `$3000` ablegen.

## 4. Viewport und Geometrie

Projektdatei `view.toml`, Werkzeug `tools/dbegeom.py`:

```toml
[viewport]
preset   = "westwood"   # Eye of the Beholder / Lands of Lore, proportional skaliert
width_px = 140          # gerade
height   = 96           # chunky-Zeilen (1 Textzeile = 4 Zeilen)
origin   = 0            # Byte-Offset im Attribut-Puffer (relativ zu AP)
stride   = 80
```

- **Westwood-Preset:** Vorlage 176 × 120, Tiefe 3 plus eigene Zelle, seitliche Wandpositionen wie dort. Proportional skaliert auf **140 × 96** (Standard, 1 Textzeile frei) oder **136 × 92** (2 Textzeilen). Breite höchstens 160.
- **Ausgabe je Element (d, s, Art):**
  - Rechteck (Byte-Spalte, Zeile, Breite, Höhe)
  - Transparenzmaske
  - deckender Kern
  - Spaltenbereich für die Abdeckung
- **Weitere Ausgaben:** Vorlagen-PNGs, Aseprite-Vorlage (ein Slice je Element), `*.DVG`, **Budgetbericht** (VRAM je Stil). Richtwert bei 140 × 96: etwa 9–10 KB je Wandstil.

## 5. Render-Reihenfolge (Painter, je Tiefe von hinten nach vorne)

`VIEW` bestimmt die Sichtbarkeit von vorne nach hinten (Spaltenmaske, nur deckende Wandkerne decken ab) und gibt danach die Liste von hinten nach vorne aus. Für jede Tiefe d = D … 0:

1. **Tapete** für die Zeilen dieser Tiefe, die kein Band füllt. Bei d = D ist das das Horizontband dahinter. Dazu kommen Bänder mit Lücken, also Zellen ohne Boden oder Decke. Ausgabe per `VMC` mit Quellinkrement = Panoramabreite (Fenster aus einem breiteren Bild, verschoben je Blickrichtung).
2. **Boden und Decke** der Tiefe d:
   - einheitlicher Stil: ein Rechteck über die volle Breite (`VMC`, deckend) oder ein Farbverlauf (`VMF` je Zeile)
   - gemischte Stile: transparente Trapezkacheln je Zelle
3. **Zellen der Tiefe d von außen nach innen** (Reihenfolge wie bei EOB). Je Zelle entweder ihre Wandflächen oder ihr Inhalt:
   - **Wandzelle:** erst die Seitenfläche, dann die Front. Deckender Kern per `VMC`, transparenter Rand per `VMS`. Fenster und Gitter sind nicht deckend, dahinter Gezeichnetes bleibt sichtbar.
   - **Freie Zelle:** ihre **dynamischen Objekte** (Gegner, Gegenstände, Projektile, Animationen), sortiert nach **Unterposition**: hinten, Mitte, vorne. Gegenstände am Boden haben wie bei Westwood 4 Plätze, Gegner stehen in der Mitte oder paarweise. Die Unterpositionen sind absolut gespeichert (NW, NO, SW, SO, Mitte) und werden mit der Blickrichtung umgerechnet.
   - Objekte stehen mit dem Fußpunkt auf dem Boden ihrer Zelle. Deshalb überschneiden sie sich nicht mit den Boden- und Deckenbändern näherer Tiefen.
   - Innere Nachbarfronten derselben Tiefe werden nach den Objekten der äußeren Zelle gezeichnet und verdecken sie dadurch richtig.
   - Die Abdeckung durch Seitenflächen der Tiefe d schneidet keine Objekte derselben Tiefe weg.
   - Teile, deren Spalten alle durch nähere deckende Wände verdeckt sind, entfallen.
   - Animationsphase und Blickwinkel kommen aus der Objektliste.
   - Objekte in der eigenen Zelle (d = 0) werden nicht gezeichnet (wie bei EOB).

Fehler entstehen nur bei Sprites, die breiter als ihre Zelle sind.

**Objektliste (Parameterblock, neu):**
- je Objekt 6 Byte: Zellindex (Wort), Sprite-Satz, Blickrichtung, Animationsphase, Unterposition (absolut)
- bis zu 16 Objekte; neue Lage in P6 (passt nicht mehr an `$0C10`, z. B. in den Puffer bei `$1300`)
- Gegenstände aus der Inhaltsebene der Karte kommen zusätzlich über `ITEMSET` dazu

## 6. Formate

Alle Wörter Low/High. Genaue Byte-Layouts folgen in `formats.md` mit dem jeweiligen Schritt.

**VRL (RLE-Strom für `RXV`)**

| Byte | Bedeutung |
|---|---|
| `$00` | Ende |
| `$01–$7F` | n Literale folgen |
| `$80–$FD` | Lauf, Länge (b − `$80`) + 2, dann Wert |
| `$FE lo hi` | Skip: Ziel um n Byte weiter, nichts schreiben (für Transparenz und Rechtecke mit Stride) |
| `$FF lo hi v` | langer Lauf, 16-Bit-Länge (0 = 65536) |

- Der Encoder optimiert auf Größe. Der Decoder entscheidet je Lauf: unter der Schwelle T per CPU, ab T per Block fill (T wird gemessen).
- Datei: Ladeadresse, `"VR"`, Version, entpackte Länge, Strom.

**Weitere Formate**

- **DVG (Geometrie):** Kopf mit VW, VH, stride, D, S, horizon, origin, Geometrie-ID. Bandtabelle je Tiefe, dann Elemente: Art, d, s, Rechteck, Kern, Spaltenbereich, Unterpositionsanker für Objekte.
- **DTS (Texturset):** Kopf mit Geometrie-ID, Art, Stile. Je Stil ein Bildindex pro Element (`$FF` = Stil 0). Bildverzeichnis: VRAM-Offsets für Kern und Rand, VMS-Liste. Die Bilddaten liegen in einem VRL-Strom. Importer für PNG und Aseprite-Export.
- **DBG (Tapete):** Panoramabreite, Höhe, Lage, Versatz je Blickrichtung, Daten als VRL.
- **DMP (Karte):**
  - Kopf, Kachelebene (W×H, statisch), Inhaltsebene (W×H, Gegenstände 0–63, Automap-Bits)
  - Kacheltabelle zu 8 Byte: Wandstil N/O/S/W, Boden, Decke (0 = Himmel/Leere), Flags (Weg, Sicht, deckend, Tür, Automap), Automap-Zeichen
  - Ereignisse zu 4 Byte: Zelle, Typ, Parameter
  - Konverter aus `CRAWL128.CD1`
- **Sprite-Sätze:** wie SPR v1, erweitert um Animationsphase und Unterposition.

## 7. VDC-BASIC v3 (Branch `v3`, auf `v2h`)

1. Nach `$1C00–$3FFF` verlegen, Boot-Lader, Tests interpretiert und als Blitz!-Image-2-Kompilat.
2. **`RXV src,dst`:** VRL aus Bank 0 ins VRAM. Optional VCL-Typ 8 = `RXV`.
3. **`VDM modus,basis,stride`:** 0 = Bitmap 1 bpp, 1 = chunky 4 bpp.
4. **`VDL x1,y1,x2,y2,c`, `VDR x,y,w,h,c`, `VDB x,y,w,h,c`** (Tokens `$FE3E–$FE40` wie ursprünglich für `vdl/vdr/vdb` vorgesehen):
   - waagerechte Spanne: ausgerichteter Mittelteil per Block fill, Ränder per Nibble- oder Bitmasken-RMW
   - senkrechte Linie mit Inkrement = stride
   - Box = Spanne mit Wiederholungen
   - schräge Linien: Bresenham mit Run-Slicing (waagerechte bzw. senkrechte Läufe über die schnellen Pfade)
5. **Tests:** Bytevergleich gegen ein Python-Referenzmodell, VRAM-Dump über den Monitor, Zyklen je Pfad.

## 8. Schritte

| # | Inhalt | Agent |
|---|---|---|
| P0 | Messen: Schwelle CPU gegen Block fill, `VMC` gegen `VMS` je Byte, Reg 36 | Sonnet (Testprogramm), Haiku (VICE-Läufe) |
| P1 | `tools/vrl.py` mit Tests, Spezifikation | Sonnet |
| P2a | VDC-BASIC nach `$1C00`, Boot-Lader, Blitz!-Test | Opus |
| P2b | `RXV` (+ VCL-Typ 8) | Opus |
| P2c | `VDM`/`VDL`/`VDR`/`VDB` mit Python-Referenzmodell | Opus (Assembler), Sonnet (Referenzmodell, Tests) |
| P3 | `dbegeom.py`, Westwood-Preset, Vorlagen, Budget | Sonnet |
| P4 | DMP, `dbemap.py`, `crawlmap.py` | Sonnet |
| P5 | DTS-/DBG-Importer (PNG, Aseprite) | Sonnet |
| P6 | Engine 0.2: 8 KB gemeinsames RAM, Puffer bei `$1300`, `POOLSET`/`GEOMSET`/`TEXSET`/`BGSET`, DMP, Objektliste neu, neues `VIEW`; sim65 mit Listenvergleich | Opus |
| P7 | Crawl auf 0.2 (pixelgleich), Demo-Karte mit Fenstern, Himmel, Abgrund und Gegnern, Zeitvergleich | Sonnet, Haiku |
| P8 | Doku nachziehen | Sonnet |

- **Reihenfolge:** P0, P1, P3 und P4 parallel; P2a, dann P2b/P2c; P5 nach P3; P6 nach P1–P5.
- **Ablauf je Schritt:** Opus schreibt die Detailspezifikation und prüft das Ergebnis (Review).
- **Tests:** ereignisgesteuert (Haltepunkte, keine festen Wartezeiten).

## 9. Entscheidungen während der Umsetzung (2026-11-25)

| Thema | Entscheidung |
|---|---|
| Sprite-Clipping am Viewport-Rand | Neuer VMS-Listenbefehl „Quelle n Byte weiter“ (source skip) in VDC-BASIC v3; die Engine kürzt die Listen beim Kopieren in den Puffer (P2c/P5b/P6) |
| VIC-Grafik | Mit v3 sind `GRAPHIC 1–4` tabu (VDC-BASIC liegt bei `$1C00–$3FFF`) |
| Guide von VDC-BASIC | wird erst in P8 auf v3 umgestellt |
| `vrl.py` | kanonische Fassung in vdc-basic `tools/vrl.py`; die Engine verweist darauf bzw. hält eine Kopie |
| `origin` | gehört nicht zur Geometrie-ID (Viewport verschieben ohne Neuimport der Texturen) |
| Schwelle T | patchbares Byte in VDC-BASIC (`$1C04`), Standard 14 (Platzhalter aus der Kostenformel); VICE misst 2, nicht übertragbar; endgültig nach Messung in Z64K bzw. auf echter Hardware (`test/bench` in vdc-basic) |
| BASIC-Variablen Bank 1 | `$0400–$4FFF` (ca. 19 KB inkl. Strings, Obergrenze wird abgesenkt); Assets und Lib ab `$5000` (Speicherkarte in P6-engine.md); **seit P6h `MEMSIZ $4000`**: Variablen `$0400–$3FFF` (15 KB), Assets ab `$4000` (Speicherkarte G, `P6-engine.md` 2.4) |
| WALLSET/SPRITESET v1 | entfallen; Crawl wird in P7 per Konverter auf DVG/DTS/Sprite-Sätze v2 umgestellt |
| MOVE, CELL, Automap-Bit | bleiben in P6 (P6f) |
| Objekte in Wandzellen | neues Kachel-Flag „Inhalt zeichnen“ (Tür, Gitter, Bogen): Seitenfläche, dann Objekte, dann Front |
| VMS-Listen fest in Bank 0 | nach den Messungen in P6 entscheiden |
| Schwelle T (Z64K) | 3–4 in der Anzeige (VICE 2); `vrl.py` nutzt die Tabelle `fill_done(L)` |
