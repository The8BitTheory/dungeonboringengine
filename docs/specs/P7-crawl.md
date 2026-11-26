# P7: Crawl 128 auf Engine 0.2 und VDC-BASIC v3, Demo-Karte, Zeitvergleich

Stand: 2026-11-26. Detailspezifikation zu Schritt P7 aus `docs/plan-0.2.md` (Abschnitt 8: „Crawl auf 0.2 (pixelgleich), Demo-Karte mit Fenstern, Himmel, Abgrund und Gegnern, Zeitvergleich“; Abschnitt 9). Umsetzung: Sonnet (Code, Konverter, Harness), Haiku (Builds, Messläufe). Review: Opus.

Grundlagen: `P6-engine.md` (Speicherkarte G in 2.4, Funktionen 3, `VIEW` 5, Ergebnisse P6a–P6h), `P3-geometry.md` (DVG), `P4-map.md` (DMP, `crawlmap.py`), `P5-textures.md` (DTS, DBG), `P5b-sprites.md` (S2), `review-notes.md` (D.9, G.5, G.6, G.11), VDC-BASIC v3 (`vdc-basic` Branch `v3`: `docs/v3/P2a-relocate.md`, `docs/reference/commands.md` `RXV`), Spiel `dungeoncrawlerjam2025` Branch `dbe-0.2` (`README.md`, `game/crawl.bas`, `art/dbe/README.md`).

Repos und Kurznamen in dieser Spec:

| Kurzname | Pfad | Branch |
|---|---|---|
| Engine | `~/git/dungeonboringengine` | `step2/textures-0.2` |
| VB3 | `~/git/vdc-basic` | `v3` |
| Spiel | `~/git/dungeoncrawlerjam2025` | `dbe-0.2` |
| Blitz | `~/git/blitz-compiler` | – (`blitz128/blitzc/js/cli.js`) |

Die Skripte finden die Nachbar-Repos über `DBE_DIR`, `VDCBASIC_DIR`, `BLITZC` (Standard: die Pfade oben).

## 1. Überblick und Ergebnis der Machbarkeitsprüfung

### 1.1 Ziele

1. **Crawl 128 Version 1.1:** dasselbe Spiel auf Engine 0.2 (`dbe0.2.stub`, `dbe0.2.lib`) und VDC-BASIC v3 (`$1C00–$3FFF`, Programm ab `$4001`). Die Spielbilder sind **pixelgleich zu 1.0f** (Abschnitt 6). WALLSET und Sprite-Sätze v1 entfallen, die Daten kommen per Konverter als DVG, DTS und S2.
2. **Demo-Programm** der Engine mit Westwood-Geometrie: Fenster mit Landschaftstapete, Himmel als Decke, Abgrund, Goblins als animierte Gegner, Gitter und Tür mit INHALT (Abschnitt 8).
3. **Zeitvergleich** 1.0f und 1.1 mit demselben Lauf aus 39 Tasten, kompiliert und interpretiert, bei 1 MHz und 2 MHz, in VICE und Z64K (Abschnitt 7).

### 1.2 Wie weit „pixelgleich“ geht (Prüfung)

Die 19 Wandbilder von 1.0f (`walls.vdc`, Lage aus `walls.wsm`, siehe `tools/wallconv.py -v`) bilden **keine Ebenen-Geometrie**:

- Alle Bilder sind **ganze Spaltenstreifen** mit 96 Zeilen. Decke und Boden sind als schwarze Pixel in den Bildern enthalten. Die Ausnahme ist Slot 9 mit 85 Zeilen, und dieses Bild deckt nicht ab.
- Die Zellen (2, ±1) und (3, ±1) haben je **zwei Frontbilder** (Slots 8/9, 11/12, 15/16, 18/19).
- Das Bild ist **asymmetrisch**: Slot 9 hat 85 Zeilen, Slot 12 hat 96. Die Geisterspalten liegen bei 9/36/59, das ergibt Abstände von 27 und 23. Die Edelsteinspalten liegen bei 12/40/62.
- Das Sichtfenster ist 68 Byte (136 Pixel) breit und 96 Zeilen hoch, links oben bei AP + 406 (Zeile 5, Spalte 6), Zeilenbreite 80.

Folgerungen:

| Weg | pixelgleich? | Begründung |
|---|---|---|
| Westwood-Preset (140 × 96 oder 136 × 92) | nein | andere Perspektive; die Wände müssten neu gemalt werden. Das ist neue Grafik, kein Port |
| `custom`-Preset (`[planes]`) | nein | Die Frontbreiten 100/60/40 Pixel ließen sich nachbilden. Die Seiten wären aber Trapeze mit Maske, die Crawl-Seiten sind volle Rechtecke mit schwarzen Ecken. Die geteilten Fronten (2, ±1)/(3, ±1), das 85-Zeilen-Bild und die schwarzen Decken-/Bodenteile in den Streifen passen in kein Ebenenmodell |
| **Freie Crawl-DVG** (review-notes G.6) | **ja** | Jedes 1.0f-Bild wird genau ein DVG-Element mit seinem Rechteck. Das DTS enthält nur Kerne (Bild = ein Kern = volles Rechteck, deckend wie 1.0f). Die Geister und Edelsteine kommen als S2-Bilder mit Ankern auf den 1.0f-Positionen. Die Tapete ist das Füllbyte 0 und ersetzt den Clear von 1.0f |

**Entscheidung:** freie Crawl-DVG, erzeugt vom neuen Konverter `tools/crawlconv.py` (Abschnitt 3). `dbegeom` wird für Crawl nicht benutzt.

Warum das Ergebnis gleich ist (Begründung für die Umsetzung, geprüft wird nach Abschnitt 6):

- Wände: 0.1 und 0.2 lassen eine Wand nur weg, wenn alle ihre Spalten verdeckt sind. Fronten decken in beiden Fassungen sofort ab. Seiten decken in 0.2 erst am Ende ihrer Tiefe ab (P6 5.2). Seiten überdecken sich in Crawl gegenseitig nicht, und in 0.1 standen sie innerhalb einer Tiefe ohnehin hinter den Fronten und Objektplätzen. 0.2 zeichnet deshalb dieselbe Wandmenge. Alle deckenden Bilder sind volle, deckende 96-Zeilen-Rechtecke. Darum bleibt die Malreihenfolge (in 0.2 Zellen von außen nach innen, in 0.1 Seiten, dann Objekte, dann Fronten) ohne sichtbare Wirkung. Überschneidungen zwischen Elementen derselben Tiefe gibt es nur zwischen (d, 0)-Front und (d, ±1)-Seite. Dort deckt die Front zuerst ab, und die Seite entfällt in beiden Fassungen.
- Sprites: 0.1 zeichnete sie ganz, und nähere Wände übermalten sie. 0.2 schnitt zunächst verdeckte Spalten weg (P6 5.8); seit P6i (Nutzerentscheidung 2026-11-26) wird gar nicht mehr gegen `cover` beschnitten, sondern wie in 0.1 vollständig gezeichnet und von den näheren Wänden übermalt (P6 5.8a). Das Ergebnis ist gleich (Pixelprüfung).
- Clear: 1.0f löscht in jedem Bild Zeilen 5–99 über die volle Breite (`VMF AP+400,0,7600`). 0.2 füllt im Fenster die freien Spalten der Zeilen 0–94 (= Bildschirmzeilen 5–99) mit Füllbyte 0 als Tapete. Abgedeckte Spalten übermalen ohnehin deckende Wände. Die Randspalten 0–5 und 74–79 schreibt im Spiel außer dem Vorhang beim Start niemand (geprüft: Automap, Pause-Menü, KO- und Gewinnrahmen, Texte über `7700` liegen alle in den Spalten 6–73). Siehe 4.3 Punkt 9.
- Zeile 100 (AP + 8000 …, erste Zeile des Textbereichs): Die Wandbilder schreiben dort ihre letzte Zeile (immer 0), der Clear von 1.0f nicht. Die DVG übernimmt genau das: VH = 96, Horizontband [0, 95) und keine Bänder. Die Tapete schreibt Zeile 95 des Fensters nie, die Wände schon. So bleibt auch dieses Verhalten von 1.0f erhalten.

## 2. Speicher (Crawl 1.1)

### 2.1 Bank 0

| Bereich | 1.0f | 1.1 |
|---|---|---|
| `$0B00–$0BFF` | VCL-Liste | Reserve der Engine (Abfall beim Zählen beschnittener Listen) |
| `$0C00–$0CFF` | Parameterblock, Objektliste `$0C10` | Parameterblock, Objektliste `$0C50` (P6 2.3), Testbereich `$0C40–$0C4F` |
| `$0D00–$0DFF` | Stub 0.1 | Stub 0.2 |
| `$0E00–$0FFF` | VMS-Puffer 0.1 | frei |
| `$1300–$1BFF` | VDC-BASIC v2h | Puffer der Engine (VCL + VMS, Standard von `BUFSET`) |
| `$1C00–$3FFF` | Programm (Blitz! Image 1 ab `$1C01`) | VDC-BASIC v3 |
| `$4001–` | Programm | Programm: interpretiert (etwa `$4001–$7D2x`) bzw. Blitz!-Kompilat Image 2 (Runtime `$4001–$6C36`, danach Bytecode) |
| `BE` … | Ladepuffer `walls.vdc` (`$94E8–$ECC0`) | Ladepuffer für `CRAWL128.CD1`, `FONT3O.VDC` und die VRL-Teile; **Grenze `$CFFF`**, weil `RXV` aus `$D000–$DFFF` nicht lesen kann (VB3 `commands.md`) |
| `$F2DE–$FBFF` | Titelpuffer (62174) | unverändert |
| `$FC00–$FEFF` | Blitz!-Runtime | unverändert |

`BE` = `PEEK(4624)+PEEK(4625)*256` (Textende). Der Wert für 1.1 wird in P7b gemessen, interpretiert und kompiliert (Haltepunkt am ersten GETIN, Monitor liest `$1210/$1211`). Die größte VRL-Datei muss in `[BE, $D000)` passen. Ist das für die Wand-VRL nicht so, teilt `crawlconv` sie in Teile (3.5). Das Programm prüft vor jedem `RXV`, dass `BE+FL <= 53248` gilt (sonst `STOP`, wie heute Zeile 10181), und vor dem Titel, dass `BE+FL <= 62174` gilt.

### 2.2 Bank 1 (Speicherkarte G, P6 2.4)

| Bereich | Inhalt | Datei | Größe etwa |
|---|---|---|---|
| `$0400–$3FFF` | Variablen; erste Anweisung `POKE 57,0:POKE 58,64:CLR` | – | 1.0f: 3,5 KB benutzt |
| `$4000` | DMP | `crawl.dmp` (`crawlmap`, Standard `$4000`) | 24 + 2·220 + 43·8 + 4·3 = 820 Byte |
| `$5000` | Arbeitskopie der Karte (MAPINIT P1) | – | 2·W·H = 440 Byte |
| `$6000` | S2 Geist | `ghost.s2` | < 4 KB (Konverter prüft) |
| `$7000` | S2 Edelstein | `gem.s2` | < 4 KB |
| `$8000` | DTS Wand | `walls.dts` | etwa 0,6 KB (19 Bilder, nur Kerne) |
| `$B000–$E7FF` | Lib, LIBTAB, BSS | `dbe0.2.lib` | – |
| `$E800` | DVG | `crawl.dvg` | 24 + 32 + 28·16 = 504 Byte |
| `$FC00–$FEFF` | gesperrt (Runtime) | – | – |

Boden-DTS, Decken-DTS und DBG gibt es in Crawl nicht.

`VE` (die Kartenvorlage für `M%` bei jedem Spielstart, Zeile 3720) zeigt jetzt auf die **Kachelebene der DMP**: `VE = 16408` (`$4000 + 24`). Die Kachelindizes sind die Crawl-Zellwerte (P4 5.2, verlustfrei). Die Kopie nach `$8000` (Zeile 66 `POKE VE+X,MV`) entfällt, denn dort liegt jetzt das Wand-DTS.

### 2.3 VRAM

Die Lage bleibt wie in 1.0f; nur die Größen kommen jetzt aus den Dateiköpfen:

| Name | Adresse | Inhalt |
|---|---|---|
| AP(0) | 0 | Attribut-Puffer (sichtbar), Zeilen 100–119 Textbereich |
| AP(1), TA | 9600 | Hintergrundpuffer beim Start, Titelbild |
| CA | 19200 | Zeichensatz (`font.vrl`, entpackt **1730 Byte**: `FONT3O.VDC` hat 1732 Byte mit Ladeadresse) |
| DA | CA + 1730 = 20930 | Wand-DTS-Daten, U aus DTS-Kopf (Offset 24–25) = 22 354 (die Bytes von `walls.vdc` in derselben Reihenfolge) |
| GA(0) | DA + U | Geist-S2-Daten, U aus S2-Kopf (Offset 30–31), etwa 1,9 KB |
| GA(1) | GA(0) + U | Edelstein-S2-Daten (2 Bilder × 36 Byte = 72) |
| GA(2) = MA | GA(1) + U | Automap (2·W·H = 440) |
| VR(0) | 46335 | Bildschirm-RAM (Bitmap) |

Grenze: MA + 440 ≤ 46335. Erwartet sind etwa 45 680, also rund 650 Byte Reserve. `crawlconv` gibt die Summe aus und bricht ab, wenn sie über der Grenze liegt (Parameter `--font-bytes`, Standard noch 1732, also 2 Byte zu viel; die Reserve ist tatsächlich 2 Byte größer). `POOLSET(DA, MA)` (F 11) wird gesetzt, damit TEXSET und SPRITESET Bereichsfehler melden.

## 3. Konverter `tools/crawlconv.py` (Engine)

### 3.1 Eingaben (1.0f-Dateien, unverändert von `crawl128-100f.d81` bzw. `Spiel/art/dbe/`)

| Datei | Verwendung |
|---|---|
| `walls.vdc` | Pixel der 19 Wandbilder (Kopf: Anzahl, je 7 Byte src/w/h/size/col; Daten ab 1 + 7·n) |
| `walls.wsm` | d, s, Fläche (über die Slot-Tabelle `SLOTS` aus `wallconv.py`), Flags (deckend = volle Höhe), Spalte |
| `ghost.spr` + `ghosts.vdc` | Geisterbilder als gepackte VMS-Daten, je (d, s, Winkel) ein Teil mit Ziel |
| `gem.spr` + `font3o.vdc` | Edelstein: zwei Font-Zeichen (3 × 6 Byte, `VMC`, deckend) je (d, s) |

Aufruf:

```
crawlconv.py --d81 crawl128-100f.d81 OUT_DIR [--max-part N] [--font-bytes 1732] [--json]
crawlconv.py --dir DIR_MIT_DEN_DATEIEN OUT_DIR [...]
```

`--d81` liest die Dateien per `c1541 -read` in ein temporäres Verzeichnis unterhalb von `OUT_DIR` (nicht `/tmp` direkt). Ausgabe: `crawl.dvg`, `walls.dts`, `walls.vrl` bzw. `walls1.vrl` … `wallsN.vrl`, `ghost.s2`, `ghost.vrl`, `gem.s2`, `gem.vrl`, `crawlconv.md` (Bericht: Elemente, Anker, Größen, VRAM-Summe, Ladeadressen), optional `crawlconv.json`.

Wiederverwendung: `dbeview.Dvg`/`Elem`/`DepthRow` und `dbeview.dvg_bytes` (danach ID neu nach P3 5.5 mit `dbetex.dvg_id`, weil `dvg_bytes` sie nur übernimmt), `dbetex.TexSet`/`Entry`/`Kern`/`to_dts`, `dbeview.make_s2` (oder `dbespr`-Bausteine), `vrl.encode`, `dbemem.range_error` für die Bereichsprüfung. Die 0.1-Werkzeuge `wallconv.py` und `crawlsprites.py` bleiben unverändert (sie dienen nur noch als Quelle der 0.1-Dateien und für das 0.1-Modell in 6.2).

### 3.2 DVG

| Feld | Wert |
|---|---|
| VW, VH | 68, 96 |
| D, S | 3, 1 |
| stride, origin | 80, 406 |
| Horizont hy0, hy1 | 0, **95** (Zeile 95 bleibt den Wänden, 1.2) |
| Bänder je Tiefe | alle leer (cy0 = cy1 = fy0 = fy1 = 0) |
| Tiefentabelle fw/fx | Breite und Spalte der Front (d, 0) für d ≥ 1, sonst 0 (nur Kontrolle, Teilfronten gibt es keine) |

Elemente (28): je Tiefe die Zellen in der Reihenfolge s = 0, −1, +1; je Zelle die Fronten in Slot-Reihenfolge, dann die Seiten, dann der Objektplatz. Tiefe 0 hat nur die Seiten (0, −1) und (0, +1), ohne Objektplätze.

| Tiefe | s = 0 | s = −1 | s = +1 |
|---|---|---|---|
| 0 | – | Seite Slot 1 | Seite Slot 2 |
| 1 | Front 4, Obj | Front 3, Seite 6, Obj | Front 5, Seite 7, Obj |
| 2 | Front 10, Obj | Front 8, Front 9, Seite 13, Obj | Front 11, Front 12, Seite 14, Obj |
| 3 | Front 17, Obj | Front 15, Front 16, Obj | Front 18, Front 19, Obj |

Wandelement aus WSM-Eintrag (w, h, col): x = col (relativ zum Fenster, `wallconv` gibt `col` schon relativ aus), y = 0, w, h, Kern kx = ky = 0, kw = w, kh = h. Bei h = 96 gilt: Flags Bit 0 (Spaltenbereich gültig), c0 = x, c1 = x + w, und bei Fronten zusätzlich Bit 3 (Bandabdeckung). Bei h ≠ 96 (Slot 9) sind die Flags 0 und c0 = c1 = 0. Kein Element ist beschnitten (Bit 2 = 0).

Objektplätze (d = 1 … 3, s = −1 … +1), Anker als Byte-Spalte und Zeile relativ zum Fenster:

- **p = 3 (vorne links) = Geist:** linke obere Ecke des 1.0f-Geistteils (d, s): Ziel aus `ghost.spr` → (Ziel mod 80 − 6, Ziel div 80 − 5). Das S2-Bild hat den Fußpunkt fx = fy = 0. Tiefe 3: Werte der Tiefe 2 (dort gibt es kein Bild).
- **p = 2 (Mitte) = Edelstein:** linke obere Ecke des ersten der beiden Font-Zeichen aus `gem.spr` (gleiche Rechnung). Der Konverter prüft, dass das zweite Zeichen genau 3 Byte rechts daneben in derselben Zeile liegt.
- p = 0, 1, 4: Werte von p = 2 (werden nicht benutzt).

Warum zwei Unterpositionen: Geist und Edelstein haben je Seite verschiedene Abstände (27/23 gegen 28/22) und je Tiefe verschiedene Zeilen. Ein gemeinsamer Anker geht deshalb nicht. Gegenstände der Inhaltsebene stehen immer auf p = 2 (P6 5.8). Der Geist steht auf p = 3 und wird damit **nach** dem Edelstein derselben Zelle gemalt, wie in 0.1. Dort wurden die vorgemerkten Teile rückwärts ausgegeben: Edelstein, dann Geist. Bei d = 1 überschneiden sich beide (Geist Zeilen 53–82, Edelstein ab 80).

Prüfungen: `dbeview.parse_dvg` ohne Fehler (das entspricht GEOMSET), Geometrie-ID ≠ 0, Datei ≤ `$EDFF`.

### 3.3 DTS (Wand, nur Kerne)

Art 0, NE = 28, D = 3, NS = 19 Slots (die Wandelemente in DVG-Reihenfolge), NST = 1, NI = 19, NK = 19. Je Bild: Flags DECKEND genau bei h = 96 (sonst 0), nk = 1, Kern (src, 0, 0, w, h, srcstep 0), kein Rand und keine VMS-Liste. **VRAM-Daten = die Bilddaten von `walls.vdc` in Dateireihenfolge**, src = Offset dort. Damit sind sie bytegleich zu 1.0f, und U = 22 354. Stiltabelle: Stil 0 → Bild des Slots. Kachel-Wandstil 1 in der DMP ist Stil 0 (D.4).

### 3.4 S2 Geist und Edelstein

- **Geist** (`ghost.s2`, Ladeadresse `$6000`): NA = 4, NP = 1, D = 3, `angle_map` 0, 1, 2, 3. Je (Winkel a, d ∈ {1, 2}) ein Bild, Tiefe 3 hat `$FE`. Die Pixel und die **Transparenzmaske kommen aus dem, was 1.0f zeichnet:** Der Teil (d, 0, a) aus `ghost.spr` wird mit `dbetex.sim_vms` zweimal auf zwei verschiedene Hintergrundmuster gerendert. Ein Pixel ist deckend genau dann, wenn es in beiden Läufen den Quellwert hat, sonst transparent. So bleibt auch die 0.1-Eigenheit erhalten: Ein Byte mit transparentem linkem Pixel und schwarzem rechtem Pixel wurde dort ganz geschrieben (`crawlsprites.vms_rows`), das linke Pixel ist dann deckend schwarz. Prüfung: Die Teile (d, ±1, a) haben dieselbe Liste und dieselben Daten wie (d, 0, a), sonst Abbruch. `max_kerns` 16 an `dbeview.make_s2` (`dbetex` erlaubt höchstens 4), `kern_min` wie Standard. Die VRL kommt aus den VRAM-Daten.
- **Edelstein** (`gem.s2`, Ladeadresse `$7000`): NA = 1, NP = 1. Ein Bild 6 × 6 Byte aus den Font-Zeichen 4 und 5 (`font3o.vdc` ab 4·18 bzw. 5·18, je 3 Byte × 6 Zeilen), **ganz deckend**. Es ist dasselbe Bild für d = 1 und d = 2, d = 3 hat `$FE`. Die Geometrie-ID ist die der Crawl-DVG.
- Beide Dateien prüft der Konverter auf Länge ≤ `$1000` (Bereich bis zur nächsten Ladeadresse).

### 3.5 VRL und Teile

`vrl.encode` je Satz. `--max-part N` (Standard 0 = ungeteilt): Ist eine VRL-Datei größer als N, zerlegt der Konverter die VRAM-Daten an Bildgrenzen in Teile. Teil k beginnt mit einem **Skip-Token** (`$FE lo hi`) auf seinen Offset. Darum laufen alle Teile mit demselben Ziel: `RXV BE+5,DA` je Teil. Dateinamen `walls1.vrl` … `wallsN.vrl`, N steht im Bericht. P7b setzt N fest, und die Lade-Schleife im Spiel benutzt diese Konstante. Erst wird gemessen (Wand-VRL-Größe, BE), dann `--max-part` gewählt: N = 1, wenn `walls.vrl` ≤ `$D000 − BE_max − 5` gilt.

### 3.6 Tests `test/tools/test_crawlconv.py` (unittest, ohne Emulator)

- DVG/DTS/S2 aus `test/tools/data/` (neu: die 1.0f-Dateien `walls.vdc`, `walls.wsm`, `ghost.spr`, `ghosts.vdc`, `gem.spr`, `font3o.vdc`, zusammen etwa 28 KB). Geprüft werden Kopffelder, Elementzahl 28, Anker gegen die Tabelle aus `crawlsprites.py` (GHOST_POS, GEM_POS), Geometrie-ID gleich in DVG/DTS/S2, die VRAM-Daten des DTS gleich den `walls.vdc`-Daten, VRL-Rundlauf (`vrl.decode` = VRAM-Daten, auch mit Teilen und Skip), Bereichsgrenzen.
- Geistmaske: Jedes Bild mit `dbespr.render_image` auf beide Hintergründe gerendert ergibt dasselbe wie `sim_vms` des 0.1-Teils.

## 4. Port `game/crawl.bas` (Spiel)

### 4.1 Zeilen, die sich ändern (Nummern aus `crawl.bas` 1.0f)

| Zeile | 1.0f | 1.1 |
|---|---|---|
| 1–3 | Blitz!-Erkennung `PEEK(DEC("1C25")+X)` | `PEEK(DEC("4025")+X)` (Image 2: Kennung „BLITZ!“ bei `$4026`, gemessen an `blitz128/perf/out/v/ri2/o/c.prg`) |
| neu 0 oder 1 | – | Prüfung auf VB3, vor allem anderen: `IF PEEK(7171)<>48 THEN PRINT"RUN"CHR$(34)"BOOT"CHR$(34)" FIRST":END` (`$1C03` = `$30`, wie `boot.bas` Zeile 40) |
| 20 | `BANK15:POKE 58,128:CLR` | `BANK15:POKE 57,0:POKE 58,64:CLR` (MEMSIZ `$4000`). Die Zeilen 1–5 vor dem CLR legen nur temporäre Strings an, Daten werden erst ab 10052 geladen. Das ist unkritisch, wird aber in P7c mit `vice_blitzvars`-Methodik nicht eigens geprüft, nur im Bericht vermerkt |
| 25 | `VE=128*256` | `VE=16408` (Kachelebene der DMP) |
| 30/31 | DIM | zusätzlich `QG%(3)`; Werte `QG%(0)=2:QG%(1)=0:QG%(2)=1:QG%(3)=3` (absolute Unterposition q, die bei Blickrichtung v die Zeichenposition p = 3 ergibt, Tabelle P4 2.6) |
| 66–68 | `BANK1:POKE VE+X,MV …` + `VMF` Automap | `POKE VE+X,MV` entfällt. Automap siehe 4.2 |
| 3500 | `TX$="1.0F"` | `TX$="1.1"` |
| 3700/3720 | M% aus VE | unverändert (VE jetzt DMP). Bei `AM%=1` (Nebel-Automap, optional) zusätzlich `::VMF MA,0,MP%(2)` |
| 3721 | MAPINIT 0.1 | `POKE3072,0:POKE3073,64:POKE3074,0:POKE3075,80:SYS3331,1,1:POKE3152,1:POKE3155,0:POKE3157,0` (DMP `$4000`, Arbeitskopie `$5000`, X = 1 Automap-Bit; danach OBJN = 1, Satz 0, Phase 0; MAPINIT setzt OBJN auf 0) |
| 3800 | `AP=9600` | `AP=9600:C1=AP+400:::VMF C1,0,7600` (einmaliger Clear des Hintergrundpuffers wie das erste Bild von 1.0f; sonst stünden Reste des Titels in den Randspalten, und der Vorhang kopierte sie, 1.2) |
| 4600 | SETPOS | unverändert `BANK0:POKE3072,PP%(0) AND 255:POKE3073,PP%(0)/256:SYS3331,2,PF%(0)`. Neue Zeile 4602 (hinter 4600, denn die Aufrufer springen mit `GOSUB 4600` an; eine Zeile davor würde nie ausgeführt): `IF AM% THEN BANK1:C9=WI+PP%(0):POKE C9,PEEK(C9)OR64:BANK0` (WI = 20480 + W%·H%, Inhaltsebene der Arbeitskopie: Zelle besucht) |
| 4605 | Objekt 0.1 bei `$0C10` | `POKE3153,PP%(1) AND 255:POKE3154,PP%(1)/256:POKE3156,PF%(1):POKE3158,QG%(PF%(0))` |
| 4610 | VIEW | `POKE3072,AP AND 255:POKE3073,AP/256:SYS3331,4:VA=PEEK(3072)+256*PEEK(3073):BANK15` (P0 = VCLADR nach VIEW, P6 3) |
| 4620 | `::VCL 2816` | `::VCL VA` |
| 5500 | `SETCELL(pos,0)` | `SYS3331,16,64` statt `SYS3331,6,0` (SETITEM: Gegenstand weg, Bit 6 „gesehen/besucht“ bleibt). Zur Doppelung D.9: Die Spiellogik prüft `M%()`, gezeichnet wird nur der Gegenstand. Die Kachel 2 der Engine bleibt stehen, sie hat keine Flächen und sieht aus wie 0 |
| 5550 | `SETCELL(EX%,42)` | unverändert (Kachel 42 legt `crawlmap` immer an) |
| 6600–6630 | Automap aus MA | 4.2 |
| 10050–10051 | VDC-BASIC v2h laden, `SYS $1300` | entfallen (BOOT hat v3 installiert) |
| 10052 | 0.1 laden | `BLOAD"DBE0.2.STUB",B0,U(DD):BLOAD"DBE0.2.LIB",B1,U(DD):SYS3328` |
| 10053 | WSM/SPR laden | `BLOAD"CRAWL.DMP",B1,U(DD):BLOAD"CRAWL.DVG",B1,U(DD):BLOAD"WALLS.DTS",B1,U(DD):BLOAD"GHOST.S2",B1,U(DD):BLOAD"GEM.S2",B1,U(DD)`, danach GEOMSET `POKE3072,0:POKE3073,232:POKE3074,255:POKE3075,255:SYS3331,12` (DVG `$E800`, origin aus der DVG) |
| 10170–10225 | `WALLS.VDC` laden, RTV, WALLSET | je Teil k = 1 … N: `BLOAD"WALLSk.VRL",B0,P(BE),U(DD)`, Prüfung `BE+FL<=53248`, `C1=BE+5:::RXV C1,DA`; dann `BANK1:FL=PEEK(32792)+256*PEEK(32793):BANK0:GA(0)=DA+FL`; TEXSET `POKE3072,0:POKE3073,128:POKE3074,DA-INT(DA/256)*256:POKE3075,DA/256:SYS3331,13,0`; BGSET `POKE3072,0:POKE3073,0:SYS3331,14,0` (keine DBG, Füllbyte 0) |
| 10320–10336 | Geister 0.1 | `GHOST.VRL` laden, `RXV` nach GA(0), U aus `$6000+30` (24606/24607) → GA(1); SPRITESET X = 0, P0 = `$6000`, P1 = GA(0). `GEM.VRL` nach GA(1), U aus `$7000+30` (28702/28703) → GA(2); SPRITESET X = 1, P0 = `$7000`, P1 = GA(1); `SYS3331,10,2,2` (ITEMSET Gegenstand 2 → Satz 1, wie 0.1); POOLSET `P0=DA, P1=GA(2)+2·W%·H%`, F 11 |
| 10390 | `MA=GA(2)` | unverändert |

Regeln:

- Low-Bytes über `X-INT(X/256)*256` rechnen, wo X > 32767 sein kann (wie 1.0f, `AND` geht nur bis 32767).
- Die Funktionen prüfen keine Rückgabewerte, wie 1.0f. Die Fehlerfreiheit weist P7a offline nach (A = 0 für alle Ansichten).
- Alle anderen Zeilen bleiben **unverändert**: Spiellogik, KI, HUD, Menüs, Sound, Highscores. Kein Umbau auf `MOVE` (die KI braucht `M%()` ohnehin, und Bewegung gehört nicht zum Port).
- Der Test-Hook (6.3) benutzt die in 1.0f freien Zeilen 4596/4597 und wird als `GOSUB4596:` an den Anfang von Zeile 4600 gesetzt.

### 4.2 Automap über die Engine

**Entscheidung des Nutzers (2026-11-26):** Die Automap zeigt wie 1.0f **immer den ganzen Dungeon** (`AM%=0`, Standard). Die Nebel-Variante (nur Erkundetes) bleibt als Option mit `AM%=1` im Quelltext, sie ist nicht Teil von 1.1 und nicht Teil der Abnahme. Die ursprüngliche Annahme (Nebel als Standard, Frage 2) ist damit verworfen.

- `AM%=0`: Die Karte wird beim Start wie in 1.0f vollständig nach MA gezeichnet (Zeilen 61 ff.). Zeile 4602 (`POKE` Bit 6) und die Unterroutine 6550 tun nichts (`IF AM% …`).
- `AM%=1`: Die folgenden Punkte gelten nur dann.
- Wände: `VIEW` setzt Bit 6 der Inhaltsebene in der Arbeitskopie für jede gezeichnete Wand (MAPINIT X = 1, P6f).
- Freie Zellen: Die Crawl-DVG hat keine Bodenelemente, darum markiert `VIEW` dort nichts. Das Spiel setzt Bit 6 der Zelle, auf der der Spieler steht, in Zeile 4602 (direkter `POKE` in die Arbeitskopie; die Lib läuft dabei nicht).
- Anzeige (M, Zeile 6600 ff.) mit der Unterroutine 6550: Für alle Zellen X gilt: Ist Bit 6 gesetzt und Bit 7 noch nicht, dann `VMF MA+2X` mit der Farbe von 1.0f (ungerader Wert → `FNCL(1)`, sonst 255) und Bit 7 setzen. Bit 7 bedeutet hier „in MA gezeichnet“. Die Automap-Marke aus P4 2.3 benutzt Crawl sonst nicht. Danach weiter wie 1.0f (`VMC MA,…`, Spielermarke).
- Kosten (nur `AM%=1`): Beim Öffnen der Karte werden alle 220 Zellen geprüft (kompiliert unter 0,1 s, interpretiert etwa 1 s). Je Bild kommt ein `POKE` dazu.
- Neustart (3700): MAPINIT löscht die Bits (frische Arbeitskopie), `VMF MA,0,…` löscht die Anzeige.

### 4.3 Bewusste Abweichungen von 1.0f

| # | Abweichung | Grund |
|---|---|---|
| 1 | Versionstext im Menü „1.1“ | Version |
| 2 | (entfallen) Automap zeigt wie 1.0f den ganzen Dungeon, `AM%=0` (4.2). Nebel nur optional mit `AM%=1` | Entscheidung des Nutzers 2026-11-26; keine Abweichung von 1.0f |
| 3 | Start nur über `BOOT` (Autoboot bzw. `RUN"BOOT"`), nicht mehr `RUN"CRAWL128"` von Hand | VB3 muss vor dem Programm bei `$1C00` liegen (P2a 3) |
| 4 | Ladetexte (z. B. „LOADING WALLS…“) dürfen sich ändern | nur während des Ladens sichtbar. Der Textbereich wird vor dem Spiel gelöscht (4000 GOSUB 8900) |
| 5 | (entfallen mit P6i) Sprites werden nicht mehr gegen verdeckte Spalten beschnitten, sondern wie in 1.0f vollständig gezeichnet und von den näheren Wänden übermalt | 1.2, P6 5.8a. Nur am Fensterrand wird beschnitten (in Crawl nie sichtbar) |
| 6 | Randspalten 0–5/74–79 nur einmal gelöscht (3800) statt in jedem Bild | unsichtbar, solange niemand dort schreibt. Prüfung 6 vergleicht den ganzen Bildschirm |
| 7 | Edelstein hat eigene VRAM-Daten (72 Byte) statt der Font-Zeichen | gleiche Bytes, nur andere Quelle |
| 8 | Kraft-Edelstein (Wert 4) steht als Gegenstand 4 in der Inhaltsebene, wird aber wie in 1.0f nicht gezeichnet (kein ITEMSET für 4) | unverändert |
| 9 | Interpretiert nicht mehr aus der IDE startbar (Ladeadresse `$4001`) | VB3. `bas2prg.py --start 0x4001` für die Diskettenfassung |
| 10 | Font und Titel liegen als VRL (`font.vrl` 1406 Byte statt 1732, `title.vrl` 1021 statt 2340 Byte, jeweils mit Ladeadresse). Der Titel bleibt gepackt im RAM ab 63493 und wird bei jeder Anzeige des Menüs per `RXV` entpackt (Zeile 3430) | Nutzerwunsch (Platz auf der Disk). Gleiche Bytes im VRAM |

Nicht als Abweichung zulässig: jeder andere Unterschied im VRAM des sichtbaren Bildschirms in den Prüfbildern von 6.3.

### 4.4 Werkzeuge und Disk (Spiel)

- `tools/bas2prg.py`: neue Option `--start ADDR` (wird an `bastok.py --start` weitergegeben, Standard `$1C01`). Der Compiler bekommt `$1C01`, die interpretierte Diskettenfassung `$4001`.
- Neu `tools/mkdisk.py [--interp] [--d64|--d81] OUT`: baut die Dateien neu und schreibt eine Disk. Ablauf: `bas2prg` → `blitzc … --runtime improved --fastmath off` (prüft Ladeadresse `$4001` von `c.prg`, sonst Abbruch „kein Image 2“) → `crawlconv` (nur wenn `--rebuild-assets`, sonst die eingecheckten Dateien aus `art/dbe02/`) → `boot.prg` aus VB3 `boot/boot.bas` mit `50 RUN"CRAWL128"` (tokenisiert mit `bastok`, Start `$1C01`) → `c1541`: `boot` als **erste** Datei, `vdcbasic3` (VB3 `vdcbasic3.bin` als PRG mit Ladeadresse `$1C00`; Format wie in VB3 `test/run.sh`), `crawl128`, `dbe0.2.stub`, `dbe0.2.lib`, `crawl.dmp`, `crawl.dvg`, `walls.dts`, `walls*.vrl`, `ghost.s2`, `ghost.vrl`, `gem.s2`, `gem.vrl`, `crawl128.cd1`, `title.vdc`, `font3o.vdc`, `greatestcrawl128` (die vier letzten von der 1.0f-Disk) → Bootsektor mit `VB3/tools/mkboot.py --name BOOT --message "CRAWL 128" --disk`.
- Arbeitsverzeichnis `build/` im Spiel-Repo (in `.gitignore` aufnehmen). Keine Dateien direkt in `/tmp`.
- Eingecheckt werden `libs/dbe0.2.stub.prg`, `libs/dbe0.2.lib.prg`, `libs/vdcbasic3.prg`, `libs/boot.prg` und die Assets in **`art/dbe02/`**. `.gitignore` enthält `/art/**`, daher die Ausnahmen `!/art/dbe02/` und `!/art/dbe02/**` eintragen und mit `git check-ignore` prüfen. Dazu `art/dbe02/README.md` (wie `art/dbe/README.md`: Datei, Diskname, Ladeort, erzeugt mit, Eingaben).
- Release-Images `crawl128-110.d81` und `crawl128-110.d64` (die d64 braucht Z64K, Abschnitt 7).

## 5. Ladefolge (1.1)

1. Autoboot (Bootsektor) oder `RUN"BOOT"`: BOOT Lauf 1 setzt `$2D/$2E = $4001` und lädt sich neu. Lauf 2 lädt `VDCBASIC3` nach `$1C00`, `SYS 7168`, prüft `$1C03`, dann `RUN"CRAWL128"`.
2. Crawl: Prüfung VB3 und Blitz!, `POKE57,0:POKE58,64:CLR`, Kartendaten `CRAWL128.CD1` nach BE (Spiellogik, Automap-Farben), Stub/Lib/INIT, DMP/DVG/DTS/S2 nach Bank 1, GEOMSET, Bildschirm (wie 1.0f), Titel, Font, Wand-VRL → `RXV`, TEXSET, BGSET, Geist/Edelstein → `RXV`, SPRITESET ×2, ITEMSET, POOLSET, Texte, Highscores.
3. Spielstart (3700): M% aus DMP, MAPINIT mit Arbeitskopie, Objektliste, Startbild nach AP = 9600, Vorhang.

## 6. Pixelgleichheit: Abnahmekriterium

### 6.1 Was verglichen wird

**VDC-RAM des sichtbaren Bildschirms**: Attribut-RAM `[0, 9600)` (Fenster, HUD, Textbereich-Attribute) und Bitmap `[46335, 65535)` (Textbereich, Muster). Dazu kommen die **VDC-Register 0–36**. Verglichen wird an **jedem Tastenprompt im Spiel**, also wenn das Bild fertig ist. Die Bytes werden über den Monitor gelesen (`bank vdc`, `save "<abs. Pfad>" 0 <von> <bis>` in das Arbeitsverzeichnis), danach `bank default`. Screenshots (`screenshot … 2`) werden nur für Menschen mitgeschrieben, nicht verglichen.

Die Referenz ist **1.0f kompiliert**, gebaut aus `git show main:game/crawl.bas` (das ist 1.0f) mit demselben Test-Hook (6.3), Blitz! Image 1, VDC-BASIC v2h und den 0.1-Dateien der 1.0f-Disk. Vorab wird geprüft, dass das ohne Hook neu gebaute `c.prg` gleich `crawl128` der 1.0f-Disk ist. Weicht es ab, kommt das in den Bericht, und als Referenz dient dann das Disk-Original ohne Hook plus die Hook-Fassung nur für die Szenen.

### 6.2 Offline-Vollvergleich (P7a, ohne Emulator)

Neues Modul `tools/crawl01.py` (Engine): **Modell von `VIEW` 0.1** nach `docs/formats.md` (Abschnitt „VIEW“ unter SPR v1): Clear `VMF AP+400,0,7600`, WSM-Einträge vorne → hinten mit Spaltenabdeckung, Objektplätze (erst Objekte, dann Gegenstand), Ausgabe rückwärts, Wände `VMC`, Sprites `VMS`/`VMC`. Eingaben sind die 0.1-Dateien und die Crawl-Karte.

Vergleich für **alle** freien Zellen × 4 Richtungen × {kein Geist; Geist in jeder sichtbaren freien Zelle (d, s), d ∈ {1, 2, 3}, mit jeder der 4 Geistrichtungen} × {Edelsteine wie in der Startkarte; alle eingesammelt}:

- Startzustand des VRAM: Zufallsinhalt außerhalb der Assets. Assets an ihren Adressen (2.3) für beide Fassungen.
- 0.2: `dbeview.view` + `run_vcl` mit der Crawl-Szene (DVG/DTS/S2/DMP aus `crawlconv`/`crawlmap`, BGSET-Füllbyte 0, ITEMSET 2 → Satz 1, Objekt mit q = `QG%(v)`, AP = 0).
- Gleich sein müssen: alle Bytes der Zeilen 5–99, Spalten 6–73, sowie Zeile 100 in Spalten 6–73. Außerhalb des Fensters darf 0.2 nichts schreiben. Die Randspalten 0–5/74–79 der Zeilen 5–99 zählen nicht (0.1 löscht sie, 0.2 lässt sie; im Spiel sind sie 0, 6.3 prüft das).
- Zusätzlich: A = 0 für alle Ansichten. `VCLLEN + VMSLEN` ≤ 2304 mit Bericht des Maximums (`dbeview budget`).
- Das Modell selbst wird in P7c gegen echte 1.0f-Bilder geprüft: Die Fenster-Bytes von `crawl01` müssen den VICE-Dumps von 1.0f an allen Prüfbildern gleichen.

sim65-Zyklen von `VIEW` (wie `run_sim.time_view`, Lauf mit F = 4 minus F = 7) für alle Ansichten ohne und mit Geist: Mittel und Maximum gegen das Ziel aus P6 8 (≤ 2 × 0.1, also ≤ 28 382). Das ist ein Befund, kein Abnahmehindernis.

### 6.3 Emulator (P7c)

`Spiel/test/vice_crawl.py` (neu), VICE `x128 -default -80col -VDC64KB -warp -sounddev dummy`, Disk per `-8`, Start per `-autostart` der Disk. Zwei Abläufe je Fassung:

1. **Rundgang:** die 39 Tasten `WWEWWEWWQWWQWWQWWWWWQAAAAAEAAWWWWWQWWWQ` (TD$ aus `crawl.bas` Zeile 115). Verglichen wird an 40 Prompts (Startbild + 39).
2. **Szenen** über den Test-Hook: Zeilen 4596/4597, aufgerufen am Anfang von 4600 (`GOSUB4596:`). Er übernimmt Spieler- und Geistposition aus `$0C44–$0C4A` wie `patch_crawl.py --hook`, wenn `$0C44` = 165, und setzt zusätzlich `PH%(0)=9` (gegen KO durch Treffer in den Szenen; gleich in beiden Fassungen). Szenenliste (vom Harness aus der Karte berechnet und im Bericht aufgeführt): Geist in jeder Zelle (d, s), d ∈ {1, 2}, s ∈ {−1, 0, +1}, mit jeder der 4 Richtungen (24 Szenen); Geist auf Edelsteinzelle bei (1, 0), (1, ±1), (2, ±1) (5); Geist bei (1, +1) mit Seitenwand (0, +1) davor und bei (1, −1) hinter Front (1, 0) (2); Geist bei d = 3 (unsichtbar in beiden). Die Szenen laufen nach dem Rundgang (Edelsteinzellen wählen, die der Rundgang nicht eingesammelt hat).
3. **Automap** (`AM%=0`, Standard, wie 1.0f): Die Karte in MA (Bereich im VRAM-Vergleich 6.1) ist bytegleich zu 1.0f, geprüft über den VRAM-Vergleich nach dem Druck auf `M`. Der Nebel-Modus `AM%=1` ist nicht Teil der Abnahme (4.2); sein Erwartungswert wäre Bit 6 der Zellen nach `dbeview` mit `Scene.automap` plus die besuchten Zellen. Die blinkende Spielermarke wird ausgenommen.

Fassungen: 1.0f kompiliert (Referenz), **1.1 interpretiert** und **1.1 kompiliert**, je mit Hook gebaut (Hook-Zeilen per Textpatch vor dem Tokenisieren: `Spiel/test/patchbas.py`, ändert keine Quelle im Repo).

**Abnahme P7c:** In beiden 1.1-Fassungen sind an allen Prompts von Rundgang und Szenen das VRAM nach 6.1 und die Register 0–36 bytegleich zu 1.0f. Die Automap-Prüfung ist grün. `crawl01` gleicht den 1.0f-Dumps im Fenster. Es gibt keinen BASIC-Fehler (Haltepunkt Fehlervektor). Die Gegenprobe `--control` (ein Byte des Referenzdumps verfälschen) meldet genau dieses Bild.

Ablaufregeln (wie `vice_drive.py`, mit den Korrekturen der Testregeln):

- **Ereignisgesteuert:** Haltepunkt auf GETIN `$FFE4`. Ist der Tastaturpuffer leer (`$D0` = 0), wartet das Programm. Dann erst zwei Interrupts abwarten (Haltepunkt auf den IRQ-Vektor `($0314)`, bis die Anzeige steht), dann vergleichen bzw. Taste einspeisen (`$034A`, `$D0` = 1). Haltepunkt auf den BASIC-Fehlervektor `($0300)` → Abbruch mit Zeilennummer. `-limitcycles` und ein Gesamt-Timeout nur als Wächter. **Kein `sleep`.**
- Erkennung des Spielprompts: über die BASIC-Zeile `$3B/$3C` (5 = Diskprompt → Leertaste, 3560–3630 Menü → RETURN, 4040 Spiel, 6710 Automap). P7c prüft einmal, ob das Blitz!-Kompilat `$3B/$3C` pflegt. Wenn nicht, gilt die Folge: Der erste Prompt mit leerem Puffer in der Menü-`GET`-Schleife bekommt RETURN; jeder weitere Prompt mit leerem Puffer nach dem RETURN ist der Spielprompt (die Menüschleife ruft nach dem RETURN kein GETIN mehr). Bei M ist es der Kartenprompt.
- **Monitorport:** `--port`, sonst `DBE_VICE_PORT`, sonst 6631, Bereich 6631–6649, bind-Test vor dem Start (belegt und nicht ausdrücklich angegeben: nächster freier mit Meldung; ausdrücklich angegeben: Abbruch). `-remotemonitor -remotemonitoraddress ip4://127.0.0.1:<port>`, kein `-binarymonitor`. Wiederverwenden: `VB3/test/vicemon.py` (`choose_port`) über `DBE_DIR/test/vice_smoke.py` oder direkt.
- **Prozesse:** Nur den eigenen `Popen` beenden (`terminate`, nach Frist `kill`). Kein `pkill`/`killall`. Warteschleifen auf Hintergrundläufe nie per `pgrep -f <Muster>`, das die eigene Kommandozeile enthält; besser `wait` auf die PID oder das Prozessende.
- Eine Monitorverbindung je Lauf offen halten (jede Trennung lässt die Emulation weiterlaufen). Vor jedem Befehl den Socket leeren.
- Dateien: `Spiel/build/test/<lauf>/` (gitignored) oder ein vom Aufrufer genannter Scratchpad. Nicht direkt nach `/tmp`.

## 7. Zeitvergleich (P7d)

### 7.1 Messgröße

Wie im README: **Summe der Zeit von jedem Tastendruck bis zum nächsten Tastenprompt** über die 39 Tasten des Rundgangs (ohne Startbild). Die Messung läuft **auf unveränderten Release-Builds** (ohne Hook), damit nichts misst, was nicht ausgeliefert wird.

### 7.2 VICE

`vice_crawl.py --timing`: Stoppuhr des Monitors (`r` bzw. `stopwatch`) beim Einspeisen und am nächsten Prompt (ereignisgesteuert wie 6.3; die zwei Interrupts zum Anzeigen gehören nicht zur Zeit, die Stoppuhr wird vorher gelesen). Je Lauf: 39 Einzelwerte, Summe, getrennt nach Schritt, Drehung und Wand-Stoß.

**Umrechnung in Sekunden:** Kalibrieren statt annehmen. In jedem Lauf wird einmal die Stoppuhrdifferenz zwischen zwei aufeinanderfolgenden IRQ-Haltepunkten gemessen (ein VIC-Bild, PAL 50,125 Hz). Damit gilt: Stoppuhr-Takte je Sekunde = Δ · 50,125. Das klärt auch, ob die Stoppuhr bei FAST 1-MHz- oder 2-MHz-Takte zählt (P6h sagt „1 MHz“; die README-Zahl 216 000 Takte je Schritt passt nur zu 2-MHz-Takten). Ausgegeben werden Takte und Sekunden.

**Läufe (8):** {1.0f, 1.1} × {kompiliert, interpretiert} × {2 MHz, 1 MHz}.

- 2 MHz = Standard des Spiels (Zeile 35 `FAST`).
- 1 MHz: Vor dem Rundgang wird die Taste `1` gedrückt (Zeile 4240 `SLOW`, zählt nicht mit).
- 1.0f interpretiert: Auf einer Kopie der 1.0f-Disk wird `crawl128` durch die tokenisierte 1.0f-Quelle (`$1C01`) ersetzt. 1.1 interpretiert: `mkdisk.py --interp`.
- Jeder Lauf wird zweimal ausgeführt. Gemeldet wird der Mittelwert, die Spanne kommt in den Bericht (VCL schwankt um bis zu 3 000 Takte, P6g).
- Die README-Werte von 1.0f (4,69 s / 22,96 s) dienen nur zur Plausibilitätsprüfung. In der neuen Tabelle stehen die neu gemessenen 1.0f-Werte desselben Harness.

### 7.3 Z64K (genauerer VDC)

Z64K hat keinen Monitor. Deshalb gibt es eine **Timedemo-Fassung** (Textpatch `patchbas.py --timedemo [--slow]` auf die Quelle von 1.0f bzw. 1.1):

- `5 REM` (kein Diskprompt), `3400 GOSUB 8900:GOTO 3700` (Menü überspringen), `115 TD$="…39 Tasten…"`.
- In 4040 statt `GETKEY I$`: `IF TX=1 THEN T0=TI`, `IF TX>39 THEN T9=TI-T0:GOTO 63100`, `I$=MID$(TD$,TX,1):TX=TX+1` (TX = 1 setzt Zeile 3870 schon).
- `63100 OPEN2,DD,2,"@0:TIMES,S,W":PRINT#2,T9:CLOSE2:BANK15:POKE DEC("D7FF"),0`.
- `--slow`: `3701 SLOW`.
- Weil zwischen zwei Tasten nichts anderes läuft, ist T9 die Summe nach 7.1 (Auflösung ±1 Jiffy über den ganzen Lauf).

Start: `VB3/test/z64k.py` als Modul (`run(prg, d64=…, save=…)`, eigener Xvfb per `-displayfd`, nur eigene PIDs, Ereignis = Prozessende über `-debugcart`, `-limitcycles`/Timeout nur Wächter). Die gesicherte Disk wird per `c1541 -read times` gelesen. Disk-Images als **d64** (1.0f: `crawl128-100f.d64` mit ersetztem Programm; 1.1: `mkdisk.py --d64`). Läufe: {1.0f, 1.1} kompiliert × {2 MHz, 1 MHz}. Interpretiert ist optional (Laufzeit).

**Jiffy-Takt:** Derselbe Timedemo-Build läuft einmal auch in VICE mit `-debugcart`. Dort wird T9 gegen die kalibrierte Stoppuhrsumme gestellt, das ergibt Jiffies je Sekunde (C128 PAL: IRQ je VIC-Bild). Ausgabe in Sekunden mit diesem Faktor.

### 7.4 Bericht und Erwartung

Die Tabelle (Sekunden, 2 Nachkommastellen) kommt in den Ergebnisabschnitt dieser Spec und ins Crawl-README (Abschnitt 9). Erwartung, nicht Abnahme: `VIEW` 0.2 kostet mehr CPU als 0.1 (0.1: 10,8–14,2 k Takte). Die VCL-Liste ist meist kürzer, weil es keinen Clear über 7 600 Byte mehr gibt. In Gängen deckt das Fenster vor Tiefe 3 ganz ab, dann gibt es gar keine Tapete. Ist 1.1 kompiliert bei 2 MHz um mehr als 10 % langsamer als 1.0f, gehört eine Zerlegung mit `DBE_DIR/test/vice_vclprof.py` (VIEW, VCL, BASIC) dazu. Es gibt **keine** Änderung an Lib oder VDC-BASIC in P7 (Lib-Reserve seit P6i 282 Byte; VDC-BASIC-Optimierung ist „später“ laut Entscheidung nach der VCL-Analyse).

## 8. Demo-Programm (P7e, Engine)

### 8.1 Entscheidung: eigenes Programm im Engine-Repo

`Engine/demo/`: eigenes BASIC-Programm `DEMO` mit eigener Disk `build/demo/dbe-demo.d81` (+ d64). **Kein zweites Crawl-Level.** Gründe:

- Crawl 1.1 bleibt ein treuer, pixelgleicher Port.
- Fenster, Himmel und Abgrund brauchen eine Ebenen-Geometrie mit Boden und Decke (Westwood). Crawl hat keine.
- Ein Levelwechsel in Crawl mit zweiter Geometrie, eigenem Asset-Pool und neuer Spiellogik wäre ein Spielumbau.
- Die Demo zeigt die Engine und gehört zu ihren Werkzeugen und Beispiel-Assets.

Die genutzten Crawl-Grafiken (`goblin1.bmp`, `tree1-3.bmp`, `water1-4.bmp`) kommen als Kopie nach `demo/art/`, mit Herkunft in `demo/README.md` (gleiche Autoren, MIT).

### 8.2 Geometrie und Bildschirm

- `demo/view.toml`: Westwood 140 × 96, `origin = 5` (Spalten 5–74, Zeile 0), stride 80, `byte_edges = false` (Annahme, Frage 4), DVG `$E800`.
- Bildschirm wie Crawl (Chunky 160 × 100, Register wie `test/vice/view.bas` Zeilen 100–170), Textbereich darunter ungenutzt. Kein Font: Die Demo hat kein HUD außer einem kleinen Kompass mit `VDB` (4 Rechtecke über dem Fenster, Zeile 96–99).

### 8.3 Karte `demo/demo.toml` (dbemap, `$4000`)

Grundlage ist die P6g-Karte (`test/vice_view.py build_map`, 15 × 11). Sie wird zu höchstens 20 × 16 erweitert und muss enthalten:

| Element | Kachel |
|---|---|
| Gang | Wand `ziegel`, Boden `stein`, Decke `holz` |
| Hof mit **Himmel** | Boden `stein`, Decke 0 |
| **Abgrund** | Boden 0, Decke `holz`, Flag WEG (nicht betretbar), Rand zum Gang |
| **Fenster** in der Außenwand | Wandstil `fenster` an der Fläche nach außen, nicht DECKEND |
| **Außenkachel** `draussen` | keine Wände, Boden 0, Decke 0: Hinter den Fenstern liegt nur Tapete (Landschaft) |
| **Gitter** mit INHALT | Wandstil `gitter`, Flags WEG, INHALT; dahinter (in der Zelle) ein Gegenstand |
| **Tür** mit INHALT | Wandstil `bogen` (Torbogen), INHALT, ohne WEG (durchgehbar), Goblin-Route führt hindurch |
| Gegenstände | Edelstein (Beispiel `spr/gem`), 3–5 Stück, `ITEMPH` glitzert |
| Gegner | 2–3 Goblins (Objektliste), Startpunkte als Ereignis `gegner` |

### 8.4 Assets und Budget (Lösung für „mehrere Boden-/Deckenstile passen nicht“)

**Lösung:** Je **ein** Boden- und **ein** Deckenstil. Abgrund und Himmel entstehen über Stil 0 (Lücke im Band → Tapete, P6 5.6/5.7) und kosten keinen zusätzlichen Stil. So passen Boden (≈ 1,9 KB in `$EE00–$F5FF`) und Decke (≈ 1,3 KB in `$F600–$FB7F`) in ihre Bereiche. Ein weiterer Bodenstil (z. B. Wasser aus `water*.bmp`) wäre nur mit dichter Packung möglich: Boden-DTS ins untere Fenster legen, etwa `$7800` hinter kleinen S2-Sätzen (die Adresse ist Parameter von TEXSET, `dbemem` prüft das Fensterende). Das ist nicht Teil von P7.

| Asset | Quelle | Werkzeug | Bank 1 | VRAM etwa |
|---|---|---|---|---|
| Wand: ziegel, gitter, fenster, bogen (4 Stile) | `docs/specs/examples/tex` | `dbetex build`, `max_kerns` höchstens 4 (Standard 4; mehr erlaubt `dbetex` nicht) | `$8000`, ≤ 12 KB (8,7 KB bei 4 Stilen) | aus Bericht |
| Boden stein, Decke holz (je 1 Stil) | Beispiele | `dbetex build` | `$EE00`, `$F600` | ≈ 3,2 KB |
| Tapete „Landschaft“ | neu aus `tree1-3.bmp`, `water1-4.bmp`, Himmel als `above`-Farbe, Abgrund `below` = 0 | Skript `demo/mkbg.py` → PNG 2·P Pixel × h, `dbetex bg`, P = 2·VW (wie P6g), `wrap`, `offsets = "auto"`, `y0 = "horizon"` | `$FB80` | P·h |
| Goblin | `goblin1.bmp` (10 Bilder 32 × 32, Hintergrund = `key`) | `dbespr build`, NA = 1, NP = 4 (Bilder 0, 2, 4, 6), **kein Tag** (die Phase wählt das Programm über die Objektliste), 2fach vergrößert (64 × 64 je Phase), `max_kerns` 4, `derive = "nearest"` für d = 2, 3, Fußpunkt Mitte unten | `$6000` | ≈ 3 KB |
| Edelstein | `docs/specs/examples/spr/gem` | `dbespr build` | dicht dahinter (16-Byte-Ausrichtung) | klein |

Pool: VRAM 9600 bis 46334 (36,7 KB; kein zweiter Puffer). Budgetprüfung mit `dbetex budget` und den `dbespr`-Berichten in `demo/build.py`. Bei Überlauf wird in dieser Reihenfolge gestrichen: `bogen` (Tür dann mit `gitter` ohne WEG), Goblin-Phasen 4 → 2, Panorama-Höhe. Alle Dateien müssen die `dbemem`-Prüfung bestehen. `dbeview budget` über alle Ansichten der Demo-Karte (mit 0–3 Goblins): A = 0 überall, sonst Karte oder Assets ändern.

### 8.5 Programm `demo/demo.bas`

- Erste Zeile: `POKE 57,0:POKE 58,64:CLR`, Prüfung auf VB3. Laden und Setzen wie `test/vice/view.bas` (INIT, Bildschirm, BLOAD, RXV, POOLSET, GEOMSET, TEXSET ×3, BGSET, SPRITESET ×2, ITEMSET, MAPINIT mit Arbeitskopie `$5000` und Automap-Bit).
- Schleife: `GETKEY` (W/S vor/zurück, A/D seitwärts, Q/E drehen, X Ende), **`MOVE`** (F 3, Aktionen nach P6 3.4; X = 1 Wand, X = 2 Goblin, beides einfach ignorieren).
- Goblin-Zug in BASIC: je Taste ein Schritt entlang einer festen Route je Goblin (Liste von Zellen im Programm). Ist die Zielzelle die Spielerzelle, wartet er.
- Objektliste: Zelle, Satz 0, Richtung `$FF`, Phase = (Bildzähler + i) AND 3, q = 4. `ITEMPH` = Bildzähler AND 1. Danach `VIEW`, `VCL PEEK(3072)+256*PEEK(3073)`.
- Testmarke: Am Prompt läuft `GETKEY` über GETIN, der Harness erkennt das an `$FFE4` (wie Crawl). Eine Hilfsvariable ist nicht nötig.
- Läuft interpretiert und als Blitz!-Kompilat (Image 2, `GRAPHIC 0` in einer nie ausgeführten letzten Zeile wie `blitzprep.py`).

### 8.6 Test `test/vice_demo.py`

- Aufbau wie `vice_view.py`: Disk aus `demo/build.py`, BOOT mit `50 RUN"DEMO"`.
- Feste Tour mit etwa 40 Tasten: Fenster von innen in alle 4 Richtungen, Hof mit Himmel, Blick in den Abgrund, Goblin vor dem Gitter und in der Tür, Edelstein hinter dem Gitter, Goblin an den Fensterrändern (beschnitten), Stöße gegen Wand und Goblin.
- An jedem Prompt (GETIN, leerer Puffer): ganzes 64-KB-VRAM gegen das fortgeschriebene Modell (`dbeview.run_vcl` je Schritt). Die Szene baut der Harness aus dem echten Zustand: Position und Richtung über `MOVE`-Ergebnisse aus `dbemove`, Objektliste aus `$0C50–$0CB0`, `ITEMPH` aus `$0C08`, Inhaltsebene aus Bank 1 `$5000+W·H`.
- Fenster gegen `paint_reference`; A, VCLLEN, VMSLEN gegen `dbeview.view`.
- Interpretiert und kompiliert, Zyklen je Bild bei 1 und 2 MHz wie P6h. Gleiche Port- und Prozessregeln wie 6.3, keine festen Wartezeiten.

**Abnahme P7e:** alle Tour-Bilder in beiden Fassungen gleich dem Modell; Budget und Bereiche ohne Fehler; Screenshots der Tour (PNG) für die Doku unter `demo/media/`.

## 9. Doku (P7f)

### 9.1 Crawl-README (Version 1.1)

- Download-Tabelle: `crawl128-110.d81/.d64`, Start über Autoboot bzw. `RUN"BOOT"`.
- „How it works“, Bibliotheken: VDC-BASIC **v3** (`vdcbasic3`, `$1C00–$3FFF`, geladen von `BOOT`), dungeonboringengine **0.2** (Stub `$0D00`, Lib Bank 1 `$B000–$DBFF`, Daten DVG/DTS/S2/DMP, VRL über `RXV`), Blitz! Image 2 (Programm ab `$4001`, Runtime `$FC00–$FEFF`).
- Memory map 1.1 (gemessen im laufenden Kompilat, Werte aus P7b/P7c): Tabelle wie 2.1/2.2/2.3.
- Performance: neue Tabelle aus 7 (1.0f und 1.1, kompiliert/interpretiert, 1/2 MHz, VICE und Z64K) mit dem Hinweis, dass 1.0f mit demselben Harness neu gemessen wurde.
- Versionshistorie: „1.1 – dungeonboringengine 0.2 und VDC-BASIC v3: Bilder pixelgleich, Automap unverändert (ganzer Dungeon), neue Speicheraufteilung“ (so im README umgesetzt).
- Building: `tools/mkdisk.py`, `bas2prg.py --start`, `crawlconv` (Engine).
- Repository layout: `art/dbe02/`, `test/`, `build/` (ignoriert).
- `art/dbe02/README.md` (4.4). `art/dbe/README.md` bekommt einen Satz: „0.1-Daten von 1.0f; 1.1 siehe `art/dbe02/`“.

### 9.2 Engine

- Diese Spec: Ergebnisabschnitte je Teilschritt.
- `README.md`: „Stand“ (P7: Crawl 1.1 pixelgleich, Demo), Werkzeugliste (`crawlconv.py`, `crawl01.py`), Tests (`test_crawlconv.py`, `vice_demo.py`).
- `plan-0.2.md` Abschnitt 9: neue Entscheidungen aus P7.
- `docs/formats.md` ändert sich nicht (keine Formatänderung).

## 10. Teilschritte

| Schritt | Inhalt | Dateien | Abnahme | Modell | Risiken |
|---|---|---|---|---|---|
| **P7a** Konverter und Offline-Beweis | `crawlconv.py` (3), `crawlmap` für `crawl.dmp` (Standard `$4000`, `--items 2,4`), `crawl01.py` (6.2), Vollvergleich, sim65-Zyklen, Budget | Engine: `tools/crawlconv.py`, `tools/crawl01.py`, `test/tools/test_crawlconv.py`, `test/tools/test_crawl01.py` (Vollvergleich als Test, ≤ 2 min), `test/tools/data/` (1.0f-Dateien) | Unittests grün; Vollvergleich ohne Abweichung; A = 0 für alle Ansichten; VRAM-Summe ≤ 46335; Bericht mit Größen, VRL-Größen, Zyklen | Sonnet | Geistmaske (0.1-Eigenheit, 3.4); Anker p = 2/p = 3; DVG-Prüfungen in GEOMSET (`parse_dvg` = Referenz); Tiefe 0 ohne s = 0 |
| **P7b** Port und Disk | `crawl.bas` nach 4.1/4.2, `bas2prg --start`, `mkdisk.py`, Libs und Assets einchecken, BE messen, `--max-part` festlegen | Spiel: `game/crawl.bas`, `tools/bas2prg.py`, `tools/mkdisk.py`, `libs/*`, `art/dbe02/*`, `.gitignore` | Disk bootet in VICE interpretiert und kompiliert bis zum Spielprompt; Rundgang (39 Tasten) ohne BASIC-Fehler (Rauchtest mit dem Harness aus P7c im Modus `--smoke`, oder minimal eigenständig); Speicher gemessen (BE, Programmende, Variablenende Bank 1) | Sonnet | BE im Kompilat höher als erwartet → VRL-Teile; Blitz!-Kennung `$4025`; `::RXV` im Kompilat (Ausdrücke als Variable übergeben); `AND 255` > 32767 |
| **P7c** Pixeltest | `vice_crawl.py` (6.3), `patchbas.py` (Hook), Referenzbau 1.0f, Szenenliste, Automap-Prüfung, `--control` | Spiel: `test/vice_crawl.py`, `test/patchbas.py`, `test/README.md` | 6.3 Abnahme in beiden 1.1-Fassungen | Sonnet (Skript), Haiku (Läufe) | `$3B/$3C` im Kompilat; Ghost-KI zwischen Szenen (Hook setzt Position nach der KI); 1.0f-Neubau nicht bytegleich zum Disk-Original |
| **P7d** Zeitvergleich | `--timing` mit Kalibrierung (7.2), Timedemo-Patch und Z64K-Läufe (7.3), Tabelle | Spiel: `test/vice_crawl.py`, `test/patchbas.py`, `test/z64k_crawl.py` | 8 VICE-Läufe ×2 und 4 Z64K-Läufe mit Ergebnis; Tabelle im Bericht; bei > 10 % langsamer eine Zerlegung | Haiku (Läufe), Sonnet nur für Skriptfehler | Takt der Stoppuhr bei FAST (Kalibrierung); Z64K braucht d64 und `-vdc64kb`; Z64K-RAM nicht genullt (keine Annahmen im Patch) |
| **P7e** Demo | Karte, Tapete, Goblin, Programm, Build, Test (8) | Engine: `demo/*` (`view.toml`, `demo.toml`, `mkbg.py`, `goblin.toml`, `build.py`, `demo.bas`, `art/`, `README.md`), `test/vice_demo.py` | 8.6 Abnahme; Budget und Bereiche ok | Sonnet (Skripte, Programm), Haiku (Läufe) | VRAM-Pool (Streichliste 8.4); Goblin aus Bitmap mit `key`; `derive` bei 32 × 32 → kleine Tiefen unschön (Warnung ist ok); Fenster-/Außenkachel-Logik in der Karte |
| **P7f** Doku | 9.1, 9.2, Ergebnisse in diese Spec | Spiel `README.md`, `art/dbe02/README.md`, `art/dbe/README.md`; Engine `README.md`, `plan-0.2.md`, diese Spec | Doku stimmt mit Messwerten überein; Review Opus | Sonnet | – |

Reihenfolge: P7a → P7b → P7c → P7d → P7f. **P7e** hängt nicht an P7a–P7d und kann parallel zu P7a beginnen (anderes Repo-Verzeichnis, eigener VICE-Port). Parallele VICE-Läufe brauchen je einen eigenen Port aus 6631–6649.

Commits: Erst nach dem Review und auf Anweisung des Nutzers (Spiel auf `dbe-0.2`, Engine auf `step2/textures-0.2`). Die Teilschritte committen nicht von selbst.

## 11. Fragen an den Nutzer (mit Annahme, nach der spezifiziert ist)

1. **Demo als eigenes Programm im Engine-Repo** statt als zweites Crawl-Level? *Annahme: ja* (8.1). Soll die Demo zusätzlich auf die Crawl-1.1-Disk?
2. **Automap mit Nebel** (nur Erkundetes, über die Automap-Bits der Engine) als Standard in 1.1? *Annahme war: ja.* **Entschieden (2026-11-26): nein.** Standard ist `AM%=0` wie 1.0f (ganzer Dungeon); Nebel nur optional mit `AM%=1` (4.2).
3. **Abweichung 3/9:** Crawl 1.1 startet nur noch über `BOOT`, interpretiert nicht mehr direkt aus der IDE. *Annahme: in Ordnung.*
4. **Demo mit `byte_edges`** (schneller, Kanten in 2-Pixel-Stufen)? *Annahme: nein, pixelgenau (Standard)*. Bei Zeitproblemen umstellen.
5. **Zweiter Bodenstil (Wasser)** in der Demo über dichte Packung? *Annahme: nein*, Abgrund und Himmel über Stil 0 reichen (8.4).
6. **Release-Dateiname** `crawl128-110.d81/.d64` und Versionstext „1.1“? *Annahme: ja.*

## 12. Ergebnis P7 (2026-11-26)

Nichts davon ist committet (Spiel `dbe-0.2`, Engine `step2/textures-0.2`).

### 12.1 P7a: Konverter und Offline-Beweis

- `tools/crawlconv.py` (Abschnitt 3), `tools/crawl01.py` (6.2), Tests `test/tools/test_crawlconv.py`, `test/tools/test_crawl01.py`, `test/sim/run_crawl.py`, Daten `test/tools/data/`.
- **Offline-Vollvergleich:** 19 136 Ansichten des Crawl-Levels bytegleich zu 1.0f (sim65 gegen `dbeview.view` gegen das 0.1-Modell), alle A = 0.
- VRAM: Der Edelstein belegt 36 statt 72 Byte (die zwei Font-Zeichen werden dedupliziert). Ende der Daten 45 644 (mit 1732 Byte Font), Reserve **691 Byte** bis 46335; mit dem tatsächlichen Font von 1730 Byte 693 Byte.
- DVG 68 × 96, 28 Elemente, 506 Byte; Wand-DTS 545 Byte, 19 Bilder; `walls.vrl` 6050 Byte (entpackt 22 354), nicht geteilt (N = 1).

### 12.2 P7b: Port und Disk (Spiel)

- `game/crawl.bas` portiert (4.1), `tools/bas2prg.py --start`, `tools/mkdisk.py`, `libs/` (`dbe0.2.stub.prg`, `dbe0.2.lib.prg`, `vdcbasic3.prg`, `boot.prg`), `art/dbe02/`.
- **Speicher gemessen (laufendes Spiel):** `BE` interpretiert `$8019` (32 793), kompiliert `$96B8` (38 584). Ladepuffer `[BE, $D000)`: 20 455 Byte bzw. 14 664 Byte; die größte VRL ist `walls.vrl` mit 6050 Byte. Variablen Bank 1 kompiliert `$0400–$0684`, Stringbereich bis `$1211` (interpretiert `$119B`).
- Disk d81 2952 Blöcke frei, d64 456 Blöcke frei; Bootsektor vorhanden (Autoboot, `BOOT` als erste Datei). Release-Images `crawl128-110.d81` und `.d64` im Spiel-Repo, aus `build/crawl128-110c.d81` bzw. `build/crawl128-110.d64` kopiert (frisch mit `mkdisk.py` gebaut).

### 12.3 P7c: Pixeltest (Spiel)

- `test/vice_crawl.py`, `test/patchbas.py`, `test/README.md`. 1.1 interpretiert und kompiliert an **74 Prompts VRAM-bytegleich** zu 1.0f; die Register 0–36 sind gleich bis auf R14/R15 und R33 (Zeiger, konstanter Unterschied, toleriert). `crawl01` gegen die echten 1.0f-Dumps: 73 Prompts gleich. `--control` meldet das verfälschte Bild.
- Behoben: die Reihenfolge der Zeilen bei MAPINIT. Beobachtung: Der Blitz!-Compiler ist nicht deterministisch (± wenige Byte im Kompilat); die 1.0f-Neubauten sind deshalb nicht bytegleich zum Original.

### 12.4 P7d: Zeitvergleich

Messgröße und Verfahren nach 7.1–7.3; die Stoppuhr des Monitors zählt auch bei FAST **1-MHz-Takte** (985 248 je Sekunde, PAL), ein Jiffy ist 1/60,15 s. Die README-Werte von 1.0f (4,69 s / 22,96 s) sind mit demselben Harness nicht reproduzierbar (3,44 s / 21,87 s); die Tabelle enthält nur die neu gemessenen Werte. Jede Konfiguration lief zweimal (Mittelwert).

| Konfiguration | CPU | 1.0f | 1.1 | Änderung |
|---|---|---|---|---|
| VICE, kompiliert | 2 MHz | 3,44 s | 3,46 s | +0,8 % |
| VICE, kompiliert | 1 MHz | 6,41 s | 6,53 s | +1,9 % |
| VICE, interpretiert | 2 MHz | 21,87 s | 22,43 s | +2,5 % |
| VICE, interpretiert | 1 MHz | 44,38 s | 45,60 s | +2,7 % |
| Z64K, kompiliert | 2 MHz | 4,32 s | 4,27 s | -1,2 % |
| Z64K, kompiliert | 1 MHz | 7,70 s | 7,75 s | +0,6 % |

Endwerte mit der P6i-Lib (`libs/dbe0.2.lib.prg` 10 984 Byte). VICE: Summe Taste bis Prompt über 39 Tasten in 1-MHz-Takten, 1.0f / 1.1: kompiliert 2 MHz 3 385 841 / 3 411 580, 1 MHz 6 318 623 / 6 438 389; interpretiert 2 MHz 21 550 022 / 22 098 503, 1 MHz 43 727 387 / 44 925 517 (Doppelläufe identisch). Z64K: T9 in Jiffies, 2 MHz 260 / 257, 1 MHz 463 / 466. Ein Z64K-Lauf brach einmal mit rc 125 ab, die Wiederholung war in Ordnung (bekannte Flakiness). **Bewertung:** 1.1 ist praktisch gleich schnell wie 1.0f (VICE +0,8 bis +2,7 %, Z64K −1,2 bis +0,6 %), nicht schneller; unter der Schwelle von 10 % aus 7.4, eine Zerlegung war nicht nötig.

Szene „Geist nah, schräg“ (Position 67, Richtung 3, Geist Zelle 86, kompiliert 2 MHz, Mittel aus 3, Takte), 1.0f / 1.1 alte Lib / 1.1 P6i: Geist-Richtung 0: 214 846 / 231 721 / 224 176; Richtung 1: 224 260 / 242 285 / 240 845; Richtung 2: 222 342 / 231 474 / 235 780; Richtung 3: 206 813 / 224 991 / 222 553; ohne Geist: 185 750 / 201 555 / 199 209. Der Geist selbst kostet jetzt so viel wie in 1.0f (etwa 31 k Takte). Der Rest des Mehraufwands der Szene (etwa +13 k, +7 %) kommt aus der Szene ohne Geist: höhere Kosten je sichtbarem Wandteil in `VIEW` 0.2 (etwa 1 500 statt 420 Zyklen), dafür niedrigere Grundkosten. Wiederholungen streuen bis ±15 % (Geist-KI).

Zum Vergleich die Messung mit der **alten Lib** (vor P6i, 11 057 Byte): VICE kompiliert 2 MHz 3,44 / 3,48 s (+1,2 %), 1 MHz 6,41 / 6,54 s (+2,0 %), interpretiert 2 MHz 21,87 / 22,43 s (+2,5 %), 1 MHz 44,38 / 45,61 s (+2,8 %); Z64K kompiliert 2 MHz 4,32 / 4,31 s, 1 MHz 7,70 / 7,76 s.

**Nachtrag P6j (2026-11-26):** feste Listenadresse (`BUFSET` X = 1, VDC-BASIC v3 mit VCL-Typ 10 aus P2e; `crawl.bas` 21 `VB=4864` als erste Variable, 10052 `BUFSET`, 4620 `::VCL VB` statt `VA=PEEK(3072)+256*PEEK(3073)`) und Stub mit Zeropage nur für VIEW/GEOMSET (P6 „Ergebnis P6j“). Pixeltest gegen 1.0f weiter **PASS**. Neue Endwerte (VICE, Takte, je zwei identische Läufe; alte P6i-Lib / Zwischenstand Kopie nach B0 / **Sprung** / 1.0f):

| Konfiguration | CPU | 1.1 P6i | Kopie (verworfen) | **1.1 P6j** | 1.0f | P6j gegen 1.0f |
|---|---|---|---|---|---|---|
| VICE, kompiliert | 2 MHz | 3 411 580 | 3 372 356 | **3 353 392** (3,40 s) | 3 385 841 (3,44 s) | −1,0 % |
| VICE, kompiliert | 1 MHz | 6 438 389 | 6 346 449 | **6 337 353** (6,43 s) | 6 318 623 (6,41 s) | +0,3 % |
| VICE, interpretiert | 2 MHz | 22 098 503 | 21 915 560 | **21 908 130** (22,24 s) | 21 550 022 (21,87 s) | +1,7 % |
| VICE, interpretiert | 1 MHz | 44 925 517 | 44 566 024 | **44 549 257** (45,22 s) | 43 727 387 (44,38 s) | +1,9 % |
| Z64K, kompiliert (Jiffies) | 2 MHz | 257 | – | **256** (4,26 s) | 260 (4,32 s) | −1,5 % |
| Z64K, kompiliert (Jiffies) | 1 MHz | 466 | – | **459** (7,63 s) | 463 (7,70 s) | −0,9 % |

Gegen P6i: VICE −1,7 / −1,6 / −0,9 / −0,8 %. Geist-Szene (kompiliert 2 MHz, Takte je Lauf, 3 Läufe) P6j: Richtung 0 223 654 / 221 080 / 221 607, 1: 217 207 / 250 665 / 251 056, 2: 251 181 / 220 673 / 222 463, 3: 218 445 / 219 807 / 221 615, ohne Geist 198 073 / 197 031 / 197 619 (Streuung durch die Geist-KI wie vorher). Release-Images `crawl128-110.d81`/`.d64` neu gebaut (`mkdisk.py`).

**Nachtrag P2f (2026-11-26):** VDC-BASIC v3 mit der Zeilenschleife von `VMC`/`VMF` ohne JSR (`vdc-basic/docs/v3/P2f-vmc-loop.md`: Register direkt, Ready-Bit vor jedem `$D601`-Zugriff, Quellschritt einmal je Aufruf geprüft; VMC-Zeile VICE 180 → 136, Z64K 207 → 144 Takte bei 1 MHz). Lib und Spiel unverändert, nur `libs/vdcbasic3.prg` ersetzt. Pixeltest gegen 1.0f weiter **PASS**. VICE, Takte, je zwei identische Läufe; Z64K T9 in Jiffies, je zwei gleiche Läufe:

| Konfiguration | CPU | 1.1 P6j | **1.1 P2f** | gegen P6j | 1.0f | P2f gegen 1.0f |
|---|---|---|---|---|---|---|
| VICE, kompiliert | 2 MHz | 3 353 392 | **3 104 710** (3,15 s) | −7,4 % | 3 385 841 | −8,3 % |
| VICE, kompiliert | 1 MHz | 6 337 353 | **5 870 128** (5,96 s) | −7,4 % | 6 318 623 | −7,1 % |
| VICE, interpretiert | 2 MHz | 21 908 130 | **21 652 569** (21,98 s) | −1,2 % | 21 550 022 | +0,5 % |
| VICE, interpretiert | 1 MHz | 44 549 257 | **44 078 865** (44,74 s) | −1,1 % | 43 727 387 | +0,8 % |
| Z64K, kompiliert (Jiffies) | 2 MHz | 256 | **230** (3,82 s) | −10,2 % | 260 | −11,5 % |
| Z64K, kompiliert (Jiffies) | 1 MHz | 459 | **429** (7,13 s) | −6,5 % | 463 | −7,3 % |

Kompiliert ist 1.1 damit 7–12 % schneller als 1.0f; interpretiert bleibt der Abstand klein, weil die Zeit dort im BASIC liegt. Release-Images `crawl128-110.d81`/`.d64` neu gebaut (`mkdisk.py`).

### 12.5 P7e: Demo (Engine)

`demo/` (Beschreibung in `demo/README.md`), `test/vice_demo.py`: Tour mit 75 Tasten, ganzes VRAM an jedem Prompt gleich dem Modell, interpretiert und kompiliert. VRAM-Pool 36 735 Byte, belegt 36 291. Abweichungen von der Planung in 8.4: `max_kerns` höchstens 4 (nicht 16), der Goblin hat keinen Tag `IDLE` (die Phase kommt aus der Objektliste) und ist 2fach vergrößert (64 × 64). Review-Auflagen (Hinweis zur Tapete als Fernsicht in `docs/formats.md`, diese Korrekturen) sind umgesetzt.

### 12.6 Weitere Entscheidungen und Änderungen in P7

| Thema | Ergebnis |
|---|---|
| Automap | Ganzer Dungeon wie 1.0f (`AM%=0`); Nebel nur optional (`AM%=1`). Abweichung 2 in 4.3 entfällt (Entscheidung des Nutzers) |
| Font und Titel als VRL | `tools/vrlpics.py`, `art/dbe02/font.vrl` (1406 Byte statt 1732), `title.vrl` (1021 statt 2340); der Titel bleibt gepackt im RAM ab 63493 (`$F805`) und wird bei jeder Anzeige per `RXV` entpackt. Font entpackt 1730 Byte (nicht 1732, die 2 Byte sind die Ladeadresse); `DA = CA + 1730` |
| P6i (Sprites und `cover`) | Sprites werden nicht gegen `cover` beschnitten, die Verdeckung ergibt sich aus der Malreihenfolge (P6 5.8a). Lib 10 984 Byte Datei (10 982 Code), Reserve **282 Byte**; Abweichung 5 in 4.3 entfällt |
| Release-Dateien | `crawl128-110.d81`, `crawl128-110.d64`; Start nur über `BOOT` |

### 12.7 P7f: Doku

Crawl `README.md` (Version 1.1), `art/dbe02/README.md`, `art/dbe/README.md` (ein Satz); Engine `README.md`, `docs/formats.md` (Tapete als Fernsicht, Sprites werden nicht gegen Wände beschnitten), `docs/plan-0.2.md` (P7 erledigt, Abschnitt 9), diese Spec. Veraltete Zahlen (alte Lib 11 057 Byte, Reserve 207, Nebel-Automap als Standard) sind nachgezogen; die alte Lib steht nur noch als Vergleichsmessung in 12.4.
