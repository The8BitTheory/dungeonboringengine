# Schnittstellen und Datenformate (Stand: Engine 0.2)

Dieses Dokument und die README genügen, um die Engine aus einem BASIC-7-Spiel (interpretiert oder Blitz!) zu benutzen. Begründungen und Einzelheiten: `docs/specs/P6-engine.md`. Alle Adressen in P0–P3 sind Bank-1-Adressen der Daten (Inhaltsanfang = `BLOAD`-Adresse), VRAM-Basen sind VDC-Adressen.

## Dateien

| Datei | Ziel | Inhalt |
|---|---|---|
| `dbe0.2.stub` | Bank 0, `$0D00` | Stub: Bankwechsel, Interruptweiche, Aufruf der Lib |
| `dbe0.2.lib` | Bank 1, `$B000–$DBFF` | Lib (Sprungtabelle bei `$B000`); `$DC00–$E7FF` Tabellen und Variablen, nicht in der Datei |
| `*.dmp` | Bank 1, Standard `$4000` | Karte (DMP) |
| `*.s2` | Bank 1, Standard `$6000` | Sprite-Sätze (S2) |
| `*.dts` | Bank 1, Wand `$8000`, Boden `$EE00`, Decke `$F600` | Texturset (DTS) |
| `*.dbg` | Bank 1, Standard `$FB80` | Tapete (DBG) |
| `*.dvg` | Bank 1, Standard `$E800` | Sichtfenster-Geometrie (DVG) |
| `*.vrl` | Bank 0, dann `RXV` ins VRAM | gepackte Bilder (VRL, Abschnitt „VRL v1“) |

Die Ladeadresse steht im PRG-Kopf der Dateien (`BLOAD"…",B1,U8`); die Werkzeuge nehmen die Standardadressen aus der Speicherkarte unten.

## Aufruf

| Aufruf | Wirkung |
|---|---|
| `SYS 3328` | Init: kopiert die Kernal-Interruptweiche `$FF05–$FFFF` nach Bank 1, ruft `INIT` (F 0) auf |
| `SYS 3331,F,X,Y` | Funktion F aufrufen (X, Y = Eingangsbytes); Ergebnis mit `RREG A,X,Y` |

Ladefolge (erste Anweisung des Spiels begrenzt die BASIC-Variablen auf `$0400–$3FFF`):

```
10 POKE 57,0:POKE 58,64:CLR
20 BANK 0:BLOAD"DBE0.2.STUB",B0,U8:BLOAD"DBE0.2.LIB",B1,U8
30 SYS 3328:RREG A,X,Y:REM A=0, X=3 (Version)
40 BLOAD"MAP.DMP",B1,U8:BLOAD"WALLS.DTS",B1,U8:BLOAD"VIEW.DVG",B1,U8:REM usw.
```

Danach `POOLSET` (optional), `GEOMSET` (zuerst, danach gelten DTS, DBG und S2 nur mit gleicher Geometrie-ID), `TEXSET` (Wand, Boden, Decke), `BGSET`, `SPRITESET`, `ITEMSET`, `MAPINIT`, `BUFSET` (optional). Bilddaten (VRL) kommen mit `RXV` ins VRAM, bevor `TEXSET`/`SPRITESET` ihre VRAM-Basis bekommen.

Während des Aufrufs:

- Der aktuelle `BANK` ist egal; der Stub schaltet selbst um und stellt danach `$FF00` und `$D506` wieder her. Interrupts bleiben an.
- `$FF00 = $7F` (Bank 1 ohne I/O) und **8 KB gemeinsames RAM** unten (`$D506` = `$06`): Bank 1 unter `$2000` ist Bank 0. Daten der Engine liegen nie dort.
- Zeropage: `$FA–$FD` (alle Funktionen außer `SETPOS`, `ITEMSET`, `POOLSET`, `BUFSET`) und `$63–$72` (FAC/ARG; nur `VIEW` und `GEOMSET`). Den Block `$63–$72` rettet der Stub vor diesen beiden Funktionen und stellt ihn danach wieder her; die übrigen Aufrufe berühren ihn nicht (Nachweis `test/vice_zp.py --funcs`).
- Bank 0 `$1C00–$3FFF` (VDC-BASIC v3) wird nie beschrieben.

### Parameterblock (Bank 0)

| Adresse | Name | Inhalt |
|---|---|---|
| `$0C00`, `$0C02`, `$0C04`, `$0C06` | P0–P3 | Wörter (Low/High), Ein- und Ausgabe |
| `$0C08` | ITEMPH | Phase für Gegenstände der Inhaltsebene (Glitzern; Spiel setzt) |
| `$0C0A` | VCLADR | `VIEW`: Adresse der VCL-Liste (auch in P0); mit fester Listenadresse (`BUFSET` X Bit 0) immer der Pufferanfang (dort ein Sprung, VCL-Typ 10, auf den Listenanfang) |
| `$0C0C` | VCLLEN | `VIEW`: Länge der VCL-Liste inklusive Ende-Byte |
| `$0C0E` | VMSLEN | `VIEW`: Bytes der VMS-Listen |
| `$0C10` | OBJVIS | `VIEW`: Bit i = Objekt i (ganz oder teilweise) ausgegeben |
| `$0C50` | OBJN | Objektliste: Anzahl 0 … 16 |
| `$0C51` | OBJL | 16 Objekte à 6 Byte (unten) |

Puffer der Engine (VCL- und VMS-Listen) im gemeinsamen RAM `$1300–$1BFF` (Standard 2304 Byte, `BUFSET` verkleinert). Die VCL-Liste liegt am Pufferende (Anfang = Ende − VCLLEN, ändert sich mit jedem Bild), die VMS-Listen ab dem Pufferanfang. Mit fester Listenadresse steht am Pufferanfang ein Sprung (3 Byte, VCL-Typ 10) auf den Listenanfang, die VMS-Listen beginnen 3 Byte später; VCLADR ist dann immer der Pufferanfang.

### Objektliste (je 6 Byte ab `$0C51 + 6·i`)

| Offset | Inhalt |
|---|---|
| 0–1 | Zellindex (Wort) |
| 2 | Sprite-Satz 0 … 7 |
| 3 | Objektrichtung 0–3 (N, O, S, W) oder `$FF` (Blickwinkel 0) |
| 4 | Phase (Animationsbild) |
| 5 | Bits 0–2: Unterposition (0 NW, 1 NO, 2 SW, 3 SO, 4 Mitte); Bit 6: unsichtbar (`VIEW` überspringt); Bit 7: blockiert nicht (`MOVE`); übrige Bits 0 |

Gegenstände der Inhaltsebene (Bits 0–5 des Inhaltsbytes, Abschnitt „DMP v1“) kommen zusätzlich dazu.

### Funktionen

Karte und Richtung: 0 N, 1 O, 2 S, 3 W; Zelle = Zeile · W + Spalte.

| F | Name | Eingang | Ausgang (A = Fehlercode, Tabelle unten) |
|---|---|---|---|
| 0 | `INIT` | – | alles zurückgesetzt; X = Version (0.2: 3); P0 = Codeende, P1 = Ende der Variablen |
| 1 | `MAPINIT` | P0 = DMP; P1 = Arbeitskopie (0 = keine, sonst 2·W·H Byte in `$4000 … $AFFF`); X Bit 0 = Automap (Bit 6 „gesehen“ in der Arbeitskopie setzen) | prüft Magic, Version, Offsets; Startzelle und -richtung übernommen; OBJN = 0; X = W, Y = H, P0 = Startzelle, P1 = Startrichtung. A = 1 Format, 6 Arbeitskopie außerhalb des Bereichs |
| 2 | `SETPOS` | P0 = Zelle, X = Richtung | A = 0; 6 bei Zelle ≥ W·H |
| 3 | `MOVE` | X = Aktion: 0 vor, 1 zurück, 2 links seitwärts, 3 rechts seitwärts, 4 links drehen, 5 rechts drehen, 6 umdrehen | X = 0 gegangen/gedreht; 1 blockiert (Rand der Karte oder Kachel mit Flag WEG); 2 Objekt im Weg (Y = Objektindex; Objekte mit Bit 6 oder 7 blockieren nicht); Y = Kachel; P0 = Position, P1 = Inhaltsbyte der Position, P2 = Index des ersten Ereignisses der Position (`$FFFF` = keines). A = 0 |
| 4 | `VIEW` | P0 = Bildpuffer im VRAM (Anfang des Bildes) | VCL-Liste und VMS-Listen im Puffer; X = Einträge (höchstens 255); P0 = VCLADR; VCLLEN, VMSLEN, OBJVIS (Parameterblock). A = 0; 2 Liste gekürzt (hintere Teile fehlen); 3 Ränder einzelner Bilder weggelassen; 5 ohne GEOMSET/MAPINIT |
| 5 | `CELL` | P0 = Zelle | X = Kachelindex, Y = Inhaltsbyte, P1 = Kachel-Flags. Außerhalb: A = 6, X = Außenkachel, Y = 0 |
| 6 | `SETCELL` | P0 = Zelle, X = Kachelindex | A = 0; 6 bei Zelle außerhalb oder X ≥ NT |
| 7, 8 | – | – | A = 255 (nicht vorhanden; 8 war `WALLSET` in 0.1) |
| 9 | `SPRITESET` | X = Satz 0 … 7, P0 = S2 (0 = Satz löschen), P1 = VRAM-Basis der Bilder | A = 1 Format, 4 Geometrie passt nicht, 5 ohne GEOMSET, 6 Satznummer, Pool oder S2 unter `$4000` |
| 10 | `ITEMSET` | X = Gegenstand 0 … 63, Y = Satz + 1 (0 = keiner) | A = 0; 6 bei X ≥ 64 oder Y > 8 |
| 11 | `POOLSET` | P0 = Poolanfang, P1 = Poolende (exklusiv, 0 = 65536); beide 0 = aus | A = 0; `TEXSET`, `BGSET`, `SPRITESET` prüfen danach, dass VRAM-Basis … Basis + Länge im Pool liegen (A = 6) |
| 12 | `GEOMSET` | P0 = DVG, P1 = origin (Offset des Fensters im Bildpuffer: Ziel = P0 von `VIEW` + origin + y · stride + x; `$FFFF` = Wert aus der DVG) | A = 1 Format (Magic, Version, Längen, VW ≤ 80, VH ≤ 100, D ≤ 7, Elementtabelle). Texturen, Tapete und Sprite-Sätze mit anderer Geometrie-ID werden gelöscht |
| 13 | `TEXSET` | X = Art (0 Wand, 1 Boden, 2 Decke), P0 = DTS (0 = löschen), P1 = VRAM-Basis | A = 1 Format, 4 Geometrie, 5 ohne GEOMSET, 6 Pool oder DTS unter `$4000` |
| 14 | `BGSET` | P0 = DBG (0 = keine Tapete), P1 = VRAM-Basis, X = Füllbyte ohne DBG, Y = **Fernsicht-Füllung** (0 aus, ≠ 0 an; Y immer angeben), P2 Low = Füllbyte der Fernsicht | A = 1, 4, 5, 6 wie `TEXSET`. Fernsicht: Abschnitt „DBG v1“ |
| 15 | `BUFSET` | P0 = Pufferanfang, P1 = Pufferende (exklusiv); X Bit 0 = **feste Listenadresse** | A = 0; 6 bei Anfang < `$1300`, Ende > `$1C00` oder Länge < 64 (alter Puffer und Modus bleiben). Feste Listenadresse: `VIEW` schreibt an den Pufferanfang einen VCL-Sprung (Typ 10, VDC-BASIC v3 ab P2e) auf den Listenanfang, VCLADR = P0 = Pufferanfang bei jedem Aufruf; VMS-Listen ab Anfang + 3 (3 Byte weniger Platz), sonst alles gleich. `INIT` schaltet den Modus aus |
| 16 | `SETITEM` | P0 = Zelle, X = Inhaltsbyte (Gegenstand und Automap-Bits) | A = 0; 6 außerhalb |
| ≥ 17 | – | – | A = 255 |

### Fehlercodes

| A | Name | Bedeutung |
|---|---|---|
| 0 | `E_OK` | ok |
| 1 | `E_FORMAT` | Magic, Version oder Längen falsch |
| 2 | `E_TOOMANY` | `VIEW`: Liste gekürzt |
| 3 | `E_PARTIAL` | `VIEW`: nur Kerne gezeichnet, Ränder einzelner Bilder fehlen |
| 4 | `E_GEOM` | Geometrie-ID, Elementzahl, Tiefe oder Stride passt nicht zur DVG |
| 5 | `E_STATE` | falsche Reihenfolge: `GEOMSET` bzw. `MAPINIT` fehlt |
| 6 | `E_RANGE` | Parameter außerhalb (Zelle, Satz, Kachelindex, Pool, Puffer, Adresse) |
| 255 | `E_NOTIMPL` | Funktion nicht vorhanden |

### Ein Bild zeichnen

```
POKE 3072,0:POKE 3073,0:SYS 3331,4,0,0:RREG A,X,Y   : REM VIEW, Bildpuffer = VRAM 0 (P0)
V=PEEK(3072)+256*PEEK(3073):VCL V                    : REM P0 = VCLADR, ::VCL führt die Liste aus
```

**Feste Listenadresse** (`BUFSET` mit X = 1, einmal nach `INIT`; braucht VDC-BASIC v3 mit VCL-Typ 10, P2e): `VCL` mit dem Pufferanfang führt über den Sprung zur Liste; das Spiel braucht P0 nicht zu lesen. Am schnellsten ist eine Variable, die einmal gesetzt und als **erste** Variable angelegt wird (der Interpreter sucht Variablen der Reihe nach; eine Zahl im Programmtext wird bei jedem Aufruf neu umgerechnet und ist langsamer als die Variable):

```
10 POKE 57,0:POKE 58,64:CLR:VB=4864                 : REM VB = $1300 (Pufferanfang), erste Variable
...
POKE 3072,0:POKE 3073,19:POKE 3074,0:POKE 3075,28:SYS 3331,15,1  : REM BUFSET $1300-$1BFF, feste Listenadresse
...
POKE 3072,0:POKE 3073,0:SYS 3331,4,0,0              : REM VIEW
VCL VB                                              : REM Blitz!: ::VCL VB
```

Messung (VICE, je Bild, ohne die Liste selbst): `::VCL VB` mit VB als erster Variable 3 400 (interpretiert) bzw. 2 900 Takte (Blitz!), `::VCL 4864` 7 000 / 6 400, `V=PEEK(3072)+256*PEEK(3073):::VCL V` 25 500 / 5 700 (V spät angelegt). Der Sprung kostet in `VCL` etwa 215 Takte, in `VIEW` etwa 100.

`VIEW` schreibt keine Pixel, sondern nur die Liste. Die Liste enthält VCL-Typ 12 (VMS im Puffer, beschnitten) und Typ 9 (VMS direkt aus Bank 1, unbeschnittene Bilder aus DTS und S2). Typ 9 liest VDC-BASIC aus Bank 1 `$4000–$CFFF` bzw. `$E000–$FBFF`; darum die Adressgrenze `$4000` bei `TEXSET`/`SPRITESET`. Vor jedem `VIEW` Objektliste und Position aktualisieren (`SETPOS`/`MOVE`, `OBJN`/`OBJL`).

### Karte

Das Kartenformat ist **DMP v1** (Abschnitt „DMP v1“ unten). Die Arbeitskopie (`MAPINIT` P1) nimmt `SETCELL`, `SETITEM` und die Automap-Bits auf; ohne Arbeitskopie schreiben sie in die DMP selbst.

## Wandsatz-Metadaten (WSM), Version 1

Nur 0.1 (`WALLSET` entfällt in 0.2; Ersatz: DVG und DTS). Dieser Abschnitt und „Sprite-Metadaten“ sind Historie.

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
3. Ein Objektplatz in einer freien Zelle merkt die passenden Sprite-Teile vor: erst die Objekte aus der Objektliste an dieser Position, dann den Gegenstand aus `ITEMSET` für den Zellwert. Sprite-Teile decken nichts ab, werden aber weggelassen, wenn alle ihre Spalten schon verdeckt sind. **Sprites werden nicht gegen Wände beschnitten (seit P6i):** Ein Sprite wird vollständig gezeichnet, nähere Wände übermalen es danach (Malreihenfolge). Beschnitten wird nur am Rand des Sichtfensters. Ein Sprite, das höher ist als die Wand seiner Tiefe, ragt oben über die Wand hinaus und wird dort von Decke bzw. Tapete der näheren Tiefen übermalt; passende Sprite-Höhen sind Sache des Autors (`dbespr` warnt).
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

## Speicherkarte Bank 1 (Engine 0.2, `MEMSIZ $4000`)

Quelle und Begründung: `docs/specs/P6-engine.md` 2.4. Die Werkzeuge nehmen diese Adressen als Standard (`tools/dbemem.py`) und brechen ab, wenn eine Datei über ihren Bereich reicht.

| Bereich | Inhalt | Werkzeug (Standard-Ladeadresse) |
|---|---|---|
| `$0400–$3FFF` | BASIC-Variablen (erste Anweisung `POKE 57,0:POKE 58,64:CLR`) | – |
| `$4000–$5FFF` | DMP (Karte) | `dbemap`, `crawlmap` `$4000` |
| `$6000–$7FFF` | S2 (Sprite-Sätze) | `dbespr` `$6000` |
| `$8000–$AFFF` | DTS Wand | `dbetex` `$8000` |
| `$B000–$DBFF` | Lib (`dbe0.2.lib`, Sprungtabelle bei `$B000`) | – |
| `$DC00–$E7FF` | Lib-Tabellen und -Variablen (nicht in der Datei) | – |
| `$E800–$EDFF` | DVG | `dbegeom` `$E800` |
| `$EE00–$F5FF` | DTS Boden | `dbetex` `$EE00` |
| `$F600–$FB7F` | DTS Decke | `dbetex` `$F600` |
| `$FB80–$FBFF` | DBG (Tapete) | `dbetex bg` `$FB80` |
| `$FC00–$FEFF` | **gesperrt** (Blitz!-Runtime) | – |

Listen für VCL-Typ 9 (Inhalt von DTS und S2) liegen ab `$4000`, nicht in `$D000–$DFFF`. Wer die Dateien dicht packt, wählt eigene Ladeadressen in den Fenstern `$4000–$AFFF` und `$E800–$FBFF`; die Werkzeuge prüfen dann das Fensterende.

## DVG v1 (Sichtfenster-Geometrie, von `tools/dbegeom.py`)

PRG-Datei (2 Byte Ladeadresse, `[output].load`, Standard `$E800`, Bank 1; Bereich bis `$EDFF`, Speicherkarte oben). Alle Offsets relativ zum Inhalt, Wörter Low/High. Quelle: `docs/specs/P3-geometry.md`.

**`view.toml` `[viewport] byte_edges`** (Standard `false`): `true` rundet die Masken auf ganze Bytes (2-Pixel-Stufen an den schrägen Kanten; ein Byte gehört zum Polygon, wenn sein Mittelpunkt innerhalb liegt). Damit entstehen keine halben Bytes und keine VMS-Typ-8-Befehle an den Kanten von Wänden und Kacheln; in der Demo spart das etwa 17 % VCL-Zeit (`P6-engine.md`, Ergebnis P6h). Die Geometrie-ID ändert sich, Texturen müssen neu importiert werden. Sprites (`dbespr`) sind nicht betroffen.

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
| 3 | Flags: Bit 0 = Spaltenbereich gültig, Bit 1 = Teilfront (Bild = Vollfront der Tiefe ab `src_dx`), Bit 2 = beschnitten, Bit 3 = Bandabdeckung (nur Fronten, deren Rechteck die Bandzeilen ihrer Tiefe enthält: e.y ≤ Deckenband y0 und e.y + e.h ≥ Bodenband y1 der Tiefe; `dbegeom` setzt es seit P6h für alle solchen Fronten, `VIEW` deckt damit Bänder, Kacheln und Tapete früher ab) |
| 4–7 | x (Byte-Spalte), y (Zeile), w (Byte), h (Zeilen) des Rechtecks |
| 8–11 | Kern kx, ky, kw, kh (relativ zum Rechteck; kw = 0: kein Kern) |
| 12 / 13 | Spaltenbereich c0 / c1 (exklusiv, absolut) |
| 14 | src_dx (nur Teilfront) |
| 15 | 0 |

Objektplatz (Art 4): Byte 1 = d, 2 = s, 3 = 0, 4–13 = 5 Anker p = 0 … 4 (hinten links, hinten rechts, Mitte, vorne links, vorne rechts) je Byte-Spalte (vorzeichenbehaftet, gesättigt auf −128 … 127) und Zeile des Fußpunkts (gesättigt auf ≤ 255), 14–15 = 0.

Ziel im Puffer: `AP + origin + y · stride + x`.

## DMP v1 (Karte, von `tools/dbemap.py` und `tools/crawlmap.py`)

PRG-Datei: 2 Byte Ladeadresse (Standard `$4000`, Bank 1, Bereich bis `$5FFF`), dann der Inhalt. Offsets relativ zum Inhalt, Wörter Low/High. Quelle: `docs/specs/P4-map.md`. Zelle (x, y), Index i = y · W + x; Richtungen 0 N, 1 O, 2 S, 3 W (Norden = kleineres y). Stilnummer: 0 = nichts, n ≥ 1 = Stil n − 1 im zugehörigen DTS.

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
| 5 | INHALT | „Inhalt zeichnen“: eine Zelle mit Flächen zeichnet zusätzlich ihre Objekte (Gegenstand der Inhaltsebene und Objektliste), Reihenfolge Seitenfläche, Objekte, Front (Tür, Gitter, Bogen); ohne Flächen ohne Wirkung |
| 6 | FERN | kehrt die Regel der Fernsicht-Füllung um (Abschnitt „DBG v1“): mit Decke Tapete, ohne Decke Füllung; ohne Fernsicht-Füllung ohne Wirkung |
| 7 | – | 0 |

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

PRG-Datei: 2 Byte Ladeadresse (Standard je Art: Wand `$8000` bis `$AFFF`, Boden `$EE00` bis `$F5FF`, Decke `$F600` bis `$FB7F`; Bank 1), dann der Inhalt; Offsets relativ zum Inhalt, Wörter Low/High. Quelle: `docs/specs/P5-textures.md`. Ein DTS enthält eine Art (Wand, Boden, Decke); die Bilddaten stehen getrennt in einer VRL-Datei (`RXV` an die VRAM-Basis, die `TEXSET` angibt); alle VRAM-Offsets sind relativ zu dieser Basis.

Kopf (32 Byte): `"DT"`, Version 1, Art (0 Wand, 1 Boden, 2 Decke), Geometrie-ID (Wort, aus der DVG), NE, D, NS (Slots), NST (Stile, ≤ 32), NI (Bilder, ≤ 254), NK (Kerne), je ein Wort Offset von Slotkarte, Stiltabelle, Bildverzeichnis, Kerntabelle, Datenbereich, Gesamtlänge, dann U (VRAM-Länge), CRC der VRAM-Daten (`crc_hqx`, Start `$FFFF`), stride, Reserve 0. Bereiche lückenlos in dieser Reihenfolge.

- **Slotkarte** (NE + 2·(D + 1) Byte): Index 0 … NE − 1 = DVG-Element, NE + d = Deckenband d, NE + (D + 1) + d = Bodenband d; Wert = Slot dieser Art oder `$FF`.
- **Stiltabelle** (NST × NS Byte): Bildindex, `$FE` = kein Bild, `$FF` = Rückgriff auf Stil 0. DMP-Stilnummer n ≥ 1 = Stil n − 1; 0 = nichts.
- **Bildverzeichnis** (NI × 16 Byte): Flags (Bit 0 DECKEND, 1 AUSSCHNITT, 2 ZEILEN, 3 RAND), Slot, nk, h, Offset des ersten Kerns (bei ZEILEN der h Füllbytes), VRAM-Offset der Randbytes, Anzahl Randbytes, Offset und Länge der VMS-Liste, Quellbild (bei AUSSCHNITT der Vollfront-Eintrag), 0.
- **Kerntabelle** (NK × 8 Byte): VRAM-Offset, dx, dy, w, h, srcstep (0 = gepackt, sonst Quellzeilenabstand).
- **Datenbereich**: VMS-Listen (Alpha, Anzahl Befehle, Befehle Typ 1 `01 ofs len`, Typ 8 `08 ofs`) und Zeilenfüllbytes.

## DBG v1 (Tapete, von `tools/dbetex.py bg`)

PRG-Datei (Standard `$FB80`, Bank 1, Bereich bis `$FBFF`), Inhalt: `"DB"`, Version 1, VW, VH, Geometrie-ID (Wort), P (Panoramabreite in Byte, Wort), y0, h, Flags (Bit 0 WRAP), 4 Versatzwörter o_v (N, O, S, W), U = P · h (Wort), CRC der VRAM-Daten (Wort), dann VH Füllbytes (Farbe · 17 für Zeilen außerhalb [y0, y0 + h), sonst 0). Das Panorama liegt zeilenweise (P Byte je Zeile) in der zugehörigen VRL. Details und Zeichenregel: `docs/specs/P5-textures.md` 6.

**Fernsicht und Füllung:** Sichtlinien, die länger als die Sichttiefe D sind, enden im Horizontband (DVG-Kopf 14/15) der Tiefe D. Ohne Fernsicht-Füllung steht dort die Tapete, auch in Innenräumen (durch ein Gitter in einer überdachten Kammer sieht man dann die Landschaft). Mit Fernsicht-Füllung (`BGSET` Y ≠ 0, Füllbyte in P2 Low; chunky: 2 Pixel je Byte, z. B. `$11` dunkelgrau) entscheidet je Spalte des Horizontbandes die Kachel der Tiefe D, durch die der Sichtstrahl in die Ferne geht:

- Kachel **mit Decke** (Deckenstil ≠ 0): **Füllbyte**; Kachel **ohne Decke** (Himmel, Deckenstil 0, auch die Außenkachel ohne Decke): **Tapete**. Das Kachel-Flag FERN (Bit 6) kehrt das um (überdachte Arkade mit Blick ins Freie → Tapete; Höhle ohne Deckentextur → Füllung).
- Gefüllt wird nur, wo hinter der letzten Tiefe noch etwas zu sehen ist: Spalten, die eine deckende Wand (Flag DECKEND und deckendes Bild) einer Tiefe 0 … D abdeckt, bleiben aus. Fenster, Gitter und Bögen decken nicht ab; Wände dahinter werden normal gezeichnet, die Füllung liegt ganz hinten.
- In den Spalten mit Füllung gibt `VIEW` keine Tapete aus (ein Füll-Eintrag VCL-Typ 5 statt der Panorama-Kopie); Decken- und Bodenlücken der Tiefe D zeigen weiter die Tapete.
- Die Spalten der Zellen ergeben sich aus den fernen Kanten der Seitenflächen der Tiefe D (`GEOMSET`, `docs/specs/P6-engine.md` 5.7a). Gibt es in der Tiefe D keine überdachte Zelle, ist die Liste gleich der ohne Füllung.

## S2 v1 (Sprite-Satz, von `tools/dbespr.py`)

PRG-Datei: 2 Byte Ladeadresse (Standard `$6000`, Bank 1, Bereich bis `$7FFF`), dann der Inhalt (≤ 8192 Byte); Offsets relativ zum Inhalt, Wörter Low/High, VRAM-Offsets relativ zur VRAM-Basis aus `SPRITESET`. Quelle: `docs/specs/P5b-sprites.md`. Die Bilddaten stehen in einer VRL-Datei (`RXV` an die VRAM-Basis). Bereiche lückenlos in der Reihenfolge Kopf, Indextabelle, Bildverzeichnis, Kerntabelle, Tagtabelle, Datenbereich.

Kopf (40 Byte): `"S2"`, Version 1, Flags (Bit 0 Gegenstand), Geometrie-ID (Wort; 0 = jede Geometrie mit gleichem Stride und D), D, NA (1 … 4), NP (1 … 32), NI (≤ 254), NK (Wort), `angle_map[0 … 3]`, je ein Wort Offset von Indextabelle, Bildverzeichnis, Kerntabelle, Tagtabelle, dann NT (≤ 32), 0, Offset Datenbereich, Gesamtlänge, U (VRAM-Länge), CRC der VRAM-Daten (`crc_hqx`, Start `$FFFF`), stride (je ein Wort), Reserve 0 (4 Byte).

- **Blickwinkel:** a = (2 + v − o) AND 3 (v Spieler, o Objekt, o = `$FF` → a = 0); 0 Vorderseite, 1 rechte Flanke, 2 Rücken, 3 linke Flanke; `angle_map[a]` = Bildwinkel ai < NA.
- **Indextabelle** (NP · NA · D Byte): Eintrag (f, ai, d) bei `(f · NA + ai) · D + d − 1`: Bildindex, `$FE` = nichts zeichnen, `$FF` = Phase 0 desselben (ai, d) (in Phase 0 nicht erlaubt); f ≥ NP → f = 0.
- **Bildverzeichnis** (NI × 16 Byte): Flags (Bit 3 RAND), w (Byte), h, Fußpunkt fx, fy (Byte-Spalte, Zeile im Bild; liegt auf dem DVG-Anker), nk, Offset des ersten Kerns, VRAM-Offset der Randbytes, Anzahl Randbytes, Offset und Länge der VMS-Liste (0 = keine).
- **Kerntabelle** (NK × 8 Byte): wie DTS, srcstep immer 0 (gepackt).
- **Tagtabelle** (NT × 12 Byte): Name (8 Byte ASCII, mit `$00` aufgefüllt), erste Phase, Anzahl Phasen, Modus (0 forward, 1 reverse, 2 pingpong), Dauer je Phase in Jiffies (1 … 255).
- **Datenbereich:** VMS-Listen, nur Typ 1 und 8, Befehle in Zeilenreihenfolge mit streng steigendem Offset (Zeile · stride + Spalte, links oben im Bild), Typ-1-Lauf innerhalb einer Zeile.
- **Beschneiden** (Referenz `dbespr.clip_image`, für `VIEW`): Kerne auf den Ausschnitt kürzen (volle Breite behält srcstep, sonst Quellzeilenabstand = ursprüngliche Breite), VMS-Liste neu schreiben mit Bezugspunkt links oben im Ausschnitt; nicht sichtbare Befehle werden durch VMS-Typ 3 (`03 n_lo n_hi`, source skip) ersetzt, nach dem letzten sichtbaren Befehl endet die Liste.
