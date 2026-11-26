# P6: Engine 0.2 in 6502 – Speicher, Funktionen, `VIEW`, Tests

Stand: 2026-11-25. Detailspezifikation zu Schritt P6 aus `docs/plan-0.2.md` (Abschnitte 3, 5, 8). Umsetzung in Teilschritten P6a–P6h (Abschnitt 10). Review: Opus. Grundlagen: `P3-geometry.md` (DVG), `P4-map.md` (DMP), `P5-textures.md` (DTS, DBG), `P5b-sprites.md` (S2, `clip_image`), VDC-BASIC v3 (`vcl-format.md`, `vms-format.md` mit Typ 3, `RXV`), `review-notes.md`.

## 1. Überblick

Die Lib bleibt eine Bank-1-Bibliothek hinter dem Stub (`SYS 3331,F,X,Y`). Sie liest DVG, DMP, DTS, DBG und S2 aus Bank 1 und schreibt die **VCL-Liste und die VMS-Listen** in einen Puffer im gemeinsamen RAM (Bank 0), den BASIC mit `::VCL` ausführt. Neu gegenüber 0.1:

- 8 KB gemeinsames RAM (`$0000–$1FFF`), Puffer `$1300–$1BFF` für VCL- und VMS-Listen zusammen, Objektliste 16 × 6 Byte bei `$0C50`.
- Geometrie, Texturen, Tapete und Sprites aus den P3/P5/P5b-Formaten; Karte DMP.
- `VIEW` nach Plan 5: Sichtbarkeit vorne → hinten mit Spaltenmaske, Ausgabe hinten → vorne; je Tiefe Tapete, Decke, Boden, Zellen außen → innen mit Wandflächen oder Objekten nach Unterposition; Beschneiden von Sprites am Sichtfenster über VMS-Typ 3 (seit P6i nicht mehr an verdeckten Spalten: Verdeckung von Sprites nur über die Malreihenfolge).
- `WALLSET` (WSM) und Sprite-Sätze v1 entfallen (0.1-Formate). Crawl wird in P7 über einen Konverter auf DVG/DTS/S2 gebracht (review-notes G.6).

Nicht in P6: `ENEMYSTEP` (Gegner-KI), Laufzeit-Animation, residente VMS-Listen in Bank 0 (Abschnitt 12), DTS v2.

## 2. Speicher

### 2.1 Gemeinsames RAM und Stub

- Der Stub schaltet während des Aufrufs `$D506` = (alt AND `$F0`) OR **`$06`** (8 KB unten gemeinsam; 0.1: `$05` = 4 KB) und `$FF00 = $7F` (Bank 1 ohne I/O, P6d-opt; vorher `$7E`). Interruptweiche `$FF05–$FFFF` in Bank 1. Zeropage: `$FA–$FD` und der Block **`$63–$72`** (FAC/ARG), den der Stub vor den Aufrufen rettet, die ihn benutzen (`VIEW`, `GEOMSET`, Testfunktion 253; `dbe.inc` `ZPB_F*`), und danach zurückschreibt (Nachweis `test/vice_zp.py`, Ergebnis P6d-opt; Nutzung je Funktion `--funcs`, Ergebnis P6j).
- Während des Aufrufs sieht die Lib unter `$2000` Bank 0. Folge: **keine Daten der Engine in Bank 1 unter `$2000`**. BASIC-Variablen in Bank 1 ab `$0400` sind davon nicht betroffen (sie werden nur außerhalb des Aufrufs benutzt; Korrektur zu P2a 4, review-notes G.16).
- Bank 0 `$1C00–$1FFF` ist VDC-BASIC v3; die Lib schreibt dort nie (BUFSET prüft, 3.3).

### 2.2 Bank 0

| Bereich | Inhalt |
|---|---|
| `$0B00–$0BFF` | Reserve der Engine (P6e-opt: `VIEW` schreibt hier während der Zählprobe beschnittener VMS-Listen Abfall); Kassetten-/Bootsektorpuffer des Systems |
| `$0C00–$0CFF` | Parameterblock (2.3), Objektliste; RS-232-Eingabepuffer des Systems (seit 0.1 so genutzt) |
| `$0D00–$0DFF` | Stub (`$0D00` init, `$0D03` call), Rest Reserve |
| `$0E00–$0FFF` | frei (0.1: VMS-Puffer); VIC-Sprite-Daten des Systems |
| **`$1300–$1BFF`** | **Puffer der Engine** (Standard, `BUFSET`): VCL-Liste ab Anfang, VMS-Listen direkt dahinter |
| `$1C00–$3FFF` | VDC-BASIC v3 |
| `$4001–` | BASIC-Programm bzw. Blitz!-Kompilat (Image 2); darüber Ladepuffer des Spiels für VRL-Dateien (P7 legt die Lage fest) |

### 2.3 Parameterblock (`$0C00`, Bank 0)

| Adresse | Name | Inhalt |
|---|---|---|
| `$0C00–$0C07` | P0–P3 | Wörter, Ein- und Ausgabe der Funktionen |
| `$0C08` | ITEMPH | Phase für Gegenstände aus der Inhaltsebene (Glitzern; Spiel setzt) |
| `$0C09` | – | reserviert 0 |
| `$0C0A–$0C0B` | VCLADR | `VIEW`: Adresse der VCL-Liste (= B1 − VCLLEN; P6d-opt, vorher Pufferanfang; mit fester Listenadresse = B0, dort ein Sprung auf B1 − VCLLEN, P6j) |
| `$0C0C–$0C0D` | VCLLEN | `VIEW`: Länge der VCL-Liste inklusive Ende-Byte |
| `$0C0E–$0C0F` | VMSLEN | `VIEW`: Bytes der VMS-Listen |
| `$0C10–$0C11` | OBJVIS | `VIEW`: Bit i = Objekt i wurde (ganz oder teilweise) ausgegeben |
| `$0C12–$0C3F` | – | Reserve |
| `$0C40–$0C4F` | – | nur Tests (Zeitmessung, Szenen-Hook wie 0.1) |
| **`$0C50`** | OBJN | Objektliste: Anzahl (0 … 16; größer wird als 16 gelesen) |
| `$0C51–$0CB0` | OBJL | 16 × 6 Byte (2.5) |
| `$0CB1–$0CFF` | – | Reserve |

### 2.4 Bank 1 (Speicherkarte G, Vorgabe; P6h: `MEMSIZ $4000`)

Alle Adressen sind Parameter der Funktionen; die Tabelle ist die Vorgabe für Werkzeuge (Ladeadressen, `tools/dbemem.py`) und Spiele. Gegenüber Karte F (P6a, `MEMSIZ $5000`) sind die BASIC-Variablen auf `$0400–$3FFF` begrenzt; die 4 KB `$4000–$4FFF` gehen an die Assets (Wand-DTS 8 → 12 KB), alle Bereiche darüber rutschen um 4 KB nach unten.

| Bereich | Größe | Inhalt | Standard-Ladeadresse (Werkzeug) |
|---|---|---|---|
| `$0000–$1FFF` | – | während des Aufrufs Bank 0 (gemeinsam): keine Engine-Daten | – |
| `$0400–$3FFF` | 15 KB | BASIC-Variablen, Felder, Strings; das Spiel begrenzt mit `POKE 57,0:POKE 58,64:CLR` als erster Anweisung auf `$4000` (interpretiert und Blitz!) | – |
| `$4000–$5FFF` | 8 KB | DMP (W·H ≤ etwa 4000), optional Arbeitskopie bei kleinen Karten | `dbemap`, `crawlmap` `$4000` |
| `$6000–$7FFF` | 8 KB | Sprite-Sätze S2 (mehrere hintereinander) | `dbespr` `$6000` |
| `$8000–$AFFF` | 12 KB | DTS Wand | `dbetex` wall `$8000` |
| `$B000–$DBFF` | 11 KB | **Lib**: Code, Sprungtabelle bei `$B000` (RAM unter I/O, `$FF00 = $7F`); Reserve nach P6l 14 Byte (Testbuild 3) | – |
| `$DC00–$DFFF` | 1 KB | Lib-Tabellen (LIBTAB: Zellentabelle von GEOMSET, Kachelzusammenfassung), nicht in der Datei | – |
| `$E000–$E7FF` | 2 KB | Lib-Variablen (BSS) | – |
| `$E800–$EDFF` | 1,5 KB | DVG | `dbegeom` `$E800` |
| `$EE00–$F5FF` | 2 KB | DTS Boden | `dbetex` floor `$EE00` |
| `$F600–$FB7F` | 1,375 KB | DTS Decke (1 Stil der Demo: 1 295 Byte) | `dbetex` ceiling `$F600` |
| `$FB80–$FBFF` | 128 B | DBG (24 + VH ≤ 124 Byte) | `dbetex bg` `$FB80` |
| `$FC00–$FEFF` | 768 B | **gesperrt:** Blitz!-Runtime (Image 2) – auch im interpretierten Spiel frei lassen | – |
| `$FF00–$FF04` | – | MMU | – |
| `$FF05–$FFFF` | – | Kopie der Kernal-Interruptweiche | – |

Bank-1-Fenster für Assets: `$4000–$AFFF` (28 KB) und `$E800–$FBFF` (5 KB). **Alle Engine-Daten liegen darin**; der Rest ist Lib (`$B000–$E7FF`), Runtime oder Bank-0-Sicht. Listen für VCL-Typ 9 (Inhalt von DTS und S2) müssen ab `$4000` liegen (nicht in `$D000–$DFFF`; die Engine prüft die Adresse in `TEXSET`/`SPRITESET`, Abschnitt 6a); die Karte erfüllt das für alle Bereiche.

Begründung: Das Demo-Wand-DTS mit 4 Stilen hat 8,7 KB (P5-Beispiel; `dbetex` erlaubt höchstens `max_kerns` 4, review-notes G.1/G.2) und passt jetzt in den Wandbereich. Boden und Decke der Demo (9,1 und 3,2 KB mit mehreren Stilen) passen weiterhin nicht in ihre Bereiche (Asset-Befund, `P6g-vcl-analysis.md` Abschnitt 6); wer mehr braucht, packt die Dateien dicht in die Fenster oben (die Adressen sind Parameter von `GEOMSET`/`TEXSET`/`BGSET`).

**Blitz!-Runtime (Image 2, P6g):** Der verbesserte Runtime kopiert gemeinsamen Code nach `$FC00`, schaltet `$D506` auf `$0C` (unten **und oben** 1 KB gemeinsam) und senkt die String-Obergrenze auf `$FC00` (`blitz128/runtime2026/README.md`). Solange das Kompilat läuft, landet jeder Zugriff auf Bank 1 `$FC00–$FEFF` im gemeinsamen RAM, also im Runtime: ein `BLOAD …,B1` dorthin zerstört ihn (Kompilat hängt; interpretiert fällt es nicht auf, weil dort `$D506` = `$04` gilt). Darum gilt für **alle** Engine-Daten in Bank 1 die Obergrenze **`$FBFF`** (interpretiert und kompiliert gleich, damit ein Spiel in beiden Formen dieselben Dateien lädt):

- Die hohen Bereiche DVG, DTS Boden, DTS Decke und DBG teilen sich `$E800–$FBFF` (5 KB). Ein Spiel darf die vier Dateien in diesem Fenster auch dicht packen (Beispiel `test/vice_view.py`: DVG `$E800`, Decke `$ED30`, Boden `$F240`, DBG `$F9C0`).
- VCL-Typ 9: Listen in Bank 1 nur in `$4000–$CFFF` oder `$E000–$FBFF` (VDC-BASIC erlaubt bis `$FEFF`; der Rest gehört dem Runtime).
- `MEMSIZ` (`$39/$3A`): Das Spiel setzt ihn mit der ersten Anweisung auf `$4000` (`POKE 57,0:POKE 58,64:CLR`, Messung P6a mit `$5000`, Abschnitt 12; `test/vice_blitzvars.py` prüft jetzt `$4000`); der Runtime senkt ihn beim Start ohnehin nur auf `$FC00`. Die Reihenfolge ist damit unkritisch. Variablen und Strings haben 15 KB (`$0400–$3FFF`); die 4 KB mehr für Assets sind die Folge der Entscheidung 4 nach der VCL-Analyse.
- Der Stub schaltet während des Lib-Aufrufs `$D506` = (alt AND `$F0`) OR `$06` (oben nicht gemeinsam) und stellt den alten Wert wieder her; VCL-Typ 9 ebenso mit `$07`. Das verträgt sich mit dem Runtime (P6g: alle 42 Szenen als Kompilat gleich); Interrupts in diesen Fenstern laufen über die Kernal-Weiche in Bank 1 und berühren `$FC00–$FEFF` nicht.
- **Werkzeuge (P6h umgesetzt):** `tools/dbemem.py` hält die Ladeadressen und die Bereichsgrenzen (Tabelle oben). `dbemap`/`crawlmap build`, `dbespr build`, `dbetex build`/`bg` und `dbegeom` brechen mit Fehlercode 1 und einer Meldung ab, wenn Ladeadresse + Länge das Ende des Bereichs der Datei überschreiten (liegt die Ladeadresse im Standardbereich der Art) bzw. das Ende des freien Fensters (eigene, dichte Packung) oder wenn die Ladeadresse in keinem der beiden Fenster liegt. Die Lib prüft die Obergrenze nicht (Länge der Daten unbekannt); eine Prüfung „Daten in `$2000 … $FBFF`, nicht in Lib/BSS“ wäre P6d-Review K5 mit neuer Grenze.
- Die Demo-Assets (Wand 8,7 KB, Boden 9,1 KB mit 3 Stilen, Decke 3,2 KB) werden von `build_texset` und den Tests ohne Bereichsprüfung benutzt (nur die Schreibwege prüfen); im sim65-Harness (`run_sim.py`) liegen sie wie bisher in eigenen Adressen, alles unter `$FC00`.

### 2.5 Objektliste (`$0C51`, je 6 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | Zellindex |
| 2 | Sprite-Satz 0 … 7 |
| 3 | Objektrichtung o: 0–3 (N, O, S, W) oder `$FF` (Blickwinkel 0) |
| 4 | Phase f |
| 5 | Bits 0–2: Unterposition q absolut (0 NW, 1 NO, 2 SW, 3 SO, 4 Mitte; 5–7 wie 4); Bit 6: unsichtbar (`VIEW` überspringt); Bit 7: blockiert nicht (`MOVE`); Bits 3–5: 0 |

Gegenstände der Inhaltsebene kommen zusätzlich dazu (5.8).

### 2.6 Lib: Größe und Ort

Schätzung (0.1 nach Schritt 1b: 1834 Byte Code, 342 Byte Variablen):

| Teil | Code etwa |
|---|---|
| Dispatcher, INIT, POOLSET, BUFSET, Prüfhilfen | 0,4 KB |
| MAPINIT, SETPOS, CELL, SETCELL, SETITEM, MOVE | 0,6 KB |
| GEOMSET, TEXSET, BGSET, SPRITESET, ITEMSET | 0,6 KB |
| VIEW: Zellen, Stile, Abdeckung | 0,9 KB |
| VIEW: Bänder, Kacheln, Tapete, Spannen | 0,9 KB |
| VIEW: Objekte, Anker, Ausschnitt | 0,6 KB |
| Ausgabe: Kerne, VMS kopieren und beschneiden, VMF-Gruppen, Größenrechnung | 1,1 KB |
| **Summe** | **≈ 5,1 KB** (Ziel ≤ 7 KB) |

Variablen (BSS) etwa 1,4 KB: Abdeckung 2 × 80, Sichtliste MAXITEM × 10 = 960, Zeilentabelle 2 × 100, Zustand und Zeiger ≈ 150, `itemtab` 64. Daraus: **Code `$B000–$CFFF` (8 KB), BSS `$E000–$E7FF` (2 KB)**. `lib.cfg`: MEMORY `CODE` `$B000` Größe `$2000` (Datei), `BSS` `$E000` Größe `$800` (nicht in der Datei, INIT löscht). Der Stub springt `LIB = $B000`. P6a misst; überschreitet der Code 8 KB, ist das ein Befund für den Nutzer, kein stilles Verschieben.

## 3. Funktionen

Aufruf `SYS 3331,F,X,Y`, Ergebnis `RREG A,X,Y`. A = Fehlercode (3.1). Alle Adressen in P0–P3 sind Bank-1-Adressen der Daten (Inhaltsanfang = `BLOAD`-Adresse), VRAM-Basen sind VDC-Adressen.

| F | Name | Eingang | Ausgang |
|---|---|---|---|
| 0 | `INIT` | – | Zustand gelöscht (BSS, OBJN = 0, Puffer = Standard); X = `DBE_VERSION` (0.2: 3); P0 = Codeende, P1 = BSS-Ende |
| 1 | `MAPINIT` | P0 = DMP, P1 = Arbeitskopie (0 = keine; sonst 2·W·H Byte für Kachel- und Inhaltsebene), X Bit 0 = Automap-Bit „gesehen“ in `VIEW` setzen (nur mit P6f, sonst ignoriert) | prüft Magic, Version, Offsets, Länge; Startzelle und -richtung übernommen (wie `SETPOS`); OBJN = 0; X = W, Y = H; P0 = Startzelle, P1 = Startrichtung. A = 1 Format; A = 6, wenn die Arbeitskopie [P1, P1 + 2·W·H) nicht ganz in `$4000` … `$AFFF` liegt (unter der Lib; Lib, BSS, DVG, I/O und MMU bleiben unberührt; darunter BASIC-Variablen und gemeinsames RAM) |
| 2 | `SETPOS` | P0 = Zelle, X = Richtung | A = 0; 6, wenn Zelle ≥ W·H (Position unverändert) |
| 3 | `MOVE` | X = Aktion (3.4) | P6f |
| 4 | `VIEW` | P0 = Bildpuffer im VRAM (AP) | VCL-Liste [B1 − VCLLEN, B1), VMS-Listen [B0, B0 + VMSLEN) (feste Listenadresse: Sprung bei B0, VMS-Listen [B0 + 3, B0 + 3 + VMSLEN)); A = 0, 2 (gekürzt) oder 3 (Ränder weggelassen); X = Einträge (höchstens 255), Y = 0; **P0 = VCLADR** (Spiel: `::VCL` mit diesem Wert); VCLLEN, VMSLEN, OBJVIS (2.3). A = 5 ohne GEOMSET/MAPINIT |
| 5 | `CELL` | P0 = Zelle | X = Kachelindex, Y = Inhaltsbyte, P1 = Kachel-Flags; außerhalb: A = 6, X = Außenkachel, Y = 0 |
| 6 | `SETCELL` | P0 = Zelle, X = Kachelindex | A = 0; 6 bei Zelle außerhalb oder X ≥ NT |
| 7 | – | – | A = 255 (`ENEMYSTEP` reserviert) |
| 8 | – | – | A = 255 (`WALLSET` entfällt) |
| 9 | `SPRITESET` | X = Satz 0 … 7, P0 = S2 (0 = Satz löschen), P1 = VRAM-Basis | prüft `"S2"`, Version, ID (0 oder = DVG-ID), D, Stride; A = 1 Format, 4 Geometrie, 5 ohne GEOMSET, 6 Satznummer/Pool bzw. S2 unter `$4000` (VCL-Typ 9, 6a) |
| 10 | `ITEMSET` | X = Gegenstand 0 … 63, Y = Satz + 1 (0 = keiner) | A = 0; 6 bei X ≥ 64 oder Y > 8 |
| 11 | `POOLSET` | P0 = Poolanfang, P1 = Poolende (exklusiv, 0 = 65536); beide 0 = keine Prüfung | A = 0; TEXSET/BGSET/SPRITESET prüfen danach Basis … Basis + U ⊆ Pool |
| 12 | `GEOMSET` | P0 = DVG, P1 = origin (`$FFFF` = aus der DVG) | prüft Magic, Version, Elementlänge 16, Tiefeneintrag 8, VW ≤ 80, VH ≤ 100, D ≤ 7, NE ≥ 1, dazu die Elementtabelle (7, P6d-opt; Fehler dort: A = 1 und keine gültige Geometrie); Zeilentabelle, Zellentabelle; TEXSET/BGSET/SPRITESET mit anderer ID werden gelöscht (Bit je Satz in Y: Bit 0–2 DTS, Bit 3 DBG; X = Bits der S2-Sätze); A = 1 Format |
| 13 | `TEXSET` | X = Art (0 Wand, 1 Boden, 2 Decke), P0 = DTS (0 = löschen), P1 = VRAM-Basis | prüft `"DT"`, Version 1, Art = X, ID, NE, D, Stride; A = 1, 4, 5, 6 (auch DTS unter `$4000`, VCL-Typ 9, 6a) |
| 14 | `BGSET` | P0 = DBG (0 = keine Tapete), P1 = VRAM-Basis, X = Füllbyte ohne DBG; **Y ≠ 0: Fernsicht-Füllung an, P2 Low = Füllbyte** (5.7a, P6l; Y = 0 aus) | prüft `"DB"`, Version, VW, VH, ID; A = 1, 4, 5, 6. Y und P2 werden immer übernommen (auch bei Fehler nach der Übernahme von X, wie X) |
| 15 | `BUFSET` | P0 = Pufferanfang, P1 = Pufferende (exklusiv); X Bit 0 = feste Listenadresse (P6j) | A = 0; 6, wenn Anfang < `$1300`, Ende > `$1C00` oder Länge < 64 (alter Puffer und Modus bleiben; Fenster `$1300–$1BFF`, P6d-opt). Feste Listenadresse: 3.3, 5.11; `INIT` schaltet sie aus |
| 16 | `SETITEM` | P0 = Zelle, X = Inhaltsbyte (Gegenstand und Automap-Bits) | A = 0; 6 außerhalb |
| ≥ 17 | – | – | A = 255 |

### 3.1 Fehlercodes

| A | Name | Bedeutung |
|---|---|---|
| 0 | `E_OK` | ok |
| 1 | `E_FORMAT` | Magic, Version oder Längen falsch |
| 2 | `E_TOOMANY` | `VIEW`: Liste gekürzt (hintere Teile fehlen) bzw. Tabellen voll |
| 3 | `E_PARTIAL` | `VIEW`: Ränder einzelner Bilder weggelassen (nur Kerne gezeichnet), Liste sonst vollständig |
| 4 | `E_GEOM` | Geometrie-ID, NE, D oder Stride passt nicht zur DVG |
| 5 | `E_STATE` | Reihenfolge: GEOMSET fehlt (für TEXSET, BGSET, SPRITESET, VIEW) bzw. MAPINIT fehlt (VIEW, CELL …) |
| 6 | `E_RANGE` | Parameter außerhalb (Zelle, Satznummer, Kachelindex, Pool, Puffer) |
| 255 | `E_NOTIMPL` | Funktion nicht vorhanden |

### 3.2 Prüfungen beim Setzen (Pflicht)

- DTS: Art-Byte = X; Geometrie-ID = DVG-ID; NE, D, Stride gleich; NST ≥ 1. DBG: VW, VH, ID gleich. S2: ID = DVG-ID oder 0, D = DVG-D, Stride gleich.
- Pool (falls gesetzt): Basis ≥ Poolanfang und Basis + U ≤ Poolende (16 Bit ohne Überlauf).
- Die Lib rechnet beim Setzen die absoluten Bank-1-Adressen der Teiltabellen aus (Slotkarte, Stiltabelle, Verzeichnis, Kerne, Datenbereich, Indextabelle) und speichert sie; `VIEW` liest nie Kopf-Offsets.

### 3.3 Puffer

Der Puffer [B0, B1) liegt im gemeinsamen RAM (Bank 0, Fenster `$1300–$1BFF`). `VIEW` schreibt jeden angenommenen Eintrag sofort (Einpass, P6d-opt): VMS-Listen aufwärts ab B0, VCL-Einträge abwärts von B1 (Ende-Byte bei B1 − 1). VCLADR = Anfang der VCL-Liste. Größe Standard 2304 Byte.

**Feste Listenadresse (P6j, `BUFSET` X Bit 0):** `VIEW` schreibt bei B0 einen VCL-Sprung (Typ 10, VDC-BASIC v3 P2e: `10, Adresse`) auf den Listenanfang B1 − nv; die VMS-Listen beginnen bei B0 + 3, BL ist 3 Byte kleiner. VCLADR = P0 = B0 bei jedem Aufruf, VCLLEN und VMSLEN ohne den Sprung. Ein Spiel ruft dann `::VCL` mit der Konstanten B0 (am schnellsten über eine einmal gesetzte, als erste angelegte Variable, Ergebnis P6j). Kosten: etwa 100 Zyklen in `VIEW`, etwa 215 in `VCL`.

### 3.4 MOVE (P6f)

| X | Aktion |
|---|---|
| 0 / 1 | vor / zurück |
| 2 / 3 | seitwärts links / rechts |
| 4 / 5 / 6 | drehen links / rechts / umdrehen |

Drehen: Richtung ändern, X = 0, Y = Kachel der Position (P6f). Schritt: Zielzelle nach Richtung; außerhalb der Karte → X = 1, Y = Außenkachel; Kachel-Flag WEG → X = 1, Y = Kachel; Objekt der Liste auf der Zielzelle ohne Bit 7 (blockiert nicht) und ohne Bit 6 → X = 2, Y = Objektindex; sonst Position = Ziel, X = 0, Y = Kachel. Immer: P0 = Position, P1 = Inhaltsbyte der Position, P2 = Index des ersten Ereignisses der Position in der DMP-Ereignisliste oder `$FFFF`. A = 0.

## 4. Zustand der Lib (BSS)

| Name | Inhalt |
|---|---|
| Karte | Adressen Kachelebene, Inhaltsebene (Arbeitskopie oder DMP), Kacheltabelle, Ereignisse; W, H, NT, NE_ev, Außenkachel |
| Position | pos (Zellindex), px, py (bei SETPOS/MOVE per fortgesetzter Subtraktion berechnet), v |
| DVG | Adresse, VW, VH, D, S, NE, stride, origin, ID, Horizont y0/y1, Adressen Tiefentabelle und Elementtabelle; Zeilentabelle `row[y] = origin + y · stride` (y < VH) |
| DTS[3] | gültig, VRAM-Basis, NS, NST, Adressen Slotkarte, Stiltabelle, Verzeichnis |
| DBG | gültig, VRAM-Basis, P, y0, h, Flags, o_v (für die aktuelle Richtung in VIEW gewählt), Adresse der Füllbytes; Füllbyte ohne DBG; Fernsicht an (`ffon`) und Fernsicht-Füllbyte (`ffill`), P6l |
| Fernsicht | `hs[VW]`: s + 15 der Zelle der Tiefe D je Spalte des Horizontbandes (GEOMSET, 5.7a) |
| S2[8] | gültig, VRAM-Basis, NA, NP, D, Adressen Indextabelle, Verzeichnis, Kerntabelle; angle_map |
| `itemtab[64]` | Satz + 1 |
| Pool, Puffer | Grenzen |
| VIEW | `cover[80]`, `bcov[80]`, Zähler, Sichtliste (MAXITEM = 96 Einträge, je etwa 10 Byte), Wartebereiche (pending, ≤ 16), Summen |

## 5. `VIEW`

Die Python-Referenz (`tools/dbeview.py`, 9.1) setzt genau diesen Abschnitt um; die 6502-Ausgabe muss **bytegleich** sein. Bei Unklarheiten gilt nach Abstimmung die Referenz und dieser Abschnitt wird nachgezogen.

### 5.1 Begriffe

- Elemente der DVG (P3 5.3), Art FRONT 0, SIDE 1, FLOOR 2, CEIL 3, OBJ 4; Felder e.x, e.y, e.w, e.h, e.flags, e.c0, e.c1, e.s, e.index, Anker e.anchor[p].
- Tiefentabelle je d: Deckenband [cy0, cy1), Bodenband [fy0, fy1), erstes Element, Anzahl. Horizont [hy0, hy1).
- `cell(d, s)`: Zelle im Gitter. Schritte: F = (fx, fy), R = (rx, ry) je Richtung v (N: F = (0, −1), R = (1, 0); O: F = (1, 0), R = (0, 1); S: F = (0, 1), R = (−1, 0); W: F = (−1, 0), R = (0, −1)). x' = px + d·fx + s·rx, y' = py + d·fy + s·ry; außerhalb von 0 ≤ x' < W, 0 ≤ y' < H → **Außenkachel**, Inhalt 0 (keine Zeilenumbrüche wie in 0.1, review-notes G.11); sonst Index y'·W + x' (= pos + d·F + s·R).
- Kachel t: walls[4], floor, ceil, flags. `faces(t)` = mindestens ein walls ≠ 0. `blocked(t)` = Flag DECKEND und alle vier walls ≠ 0.
- Fläche je Element: FRONT → (v + 2) AND 3; SIDE mit s < 0 → (v + 1) AND 3; s > 0 → (v + 3) AND 3 (P4 2.4).
- `resolve(kind, slotindex, n)`: n = 0 → nichts; DTS der Art fehlt → nichts; st = n − 1 ≥ NST → nichts; k = Slotkarte[slotindex] (`$FF` → nichts); b = Stiltabelle[st · NS + k]; b = `$FF` → b = Stiltabelle[k]; b ≥ `$FE` → nichts; sonst Verzeichniseintrag b. slotindex = e.index für Elemente, NE + d für Deckenband d, NE + D + 1 + d für Bodenband d.
- `deck(e, t, ent)` = (e.flags Bit 0) und (t.flags DECKEND) und (ent.flags Bit 0) (review-notes D.5).
- **Spaltenmasken** (je VW Byte, 0 = frei):
  - `cover`: verdeckt für alles hinter P_{d+1} und für Objekte und Seiten derselben Tiefe weiter außen. Für Objekte dient es nur dem Verwerfen ganz verdeckter Sprites (5.8); beschnitten wird gegen `cover` nichts.
  - `bcov`: verdeckt für Bänder, Kacheln und Tapete der aktuellen Tiefe.
- `allcov(m, c0, c1)`: alle Spalten c0 … c1 − 1 in m belegt.
- `spans(m)`: maximale Folgen freier Spalten in [0, VW), links nach rechts; mehr als **4** Folgen → eine Folge [erste freie, letzte freie + 1); keine → leer.
- DVG-Flag **Bit 3 „Bandabdeckung“** (neu, review-notes G.5): Fronten, deren Rechteck die Band-Zeilen ihrer Tiefe enthält (e.y ≤ cy0 und e.y + e.h ≥ fy1 der Tiefe e.d). `dbegeom` setzt es für alle Fronten.

### 5.2 Ablauf (Sichtdurchlauf, vorne → hinten)

`add(item)` hängt einen Eintrag an die Sichtliste an und prüft die Größe (5.10); „STOP“ beendet den ganzen Durchlauf.

```
cover = bcov = 0;  ncov = 0
for d in 0 .. D:
    pend = []                                   # (c0, c1, ziel) – ziel: beide Masken oder nur bcov
    for e in Elemente der Tiefe d (DVG-Reihenfolge; Kachel-Flag INHALT: 5.2a):
        c = cell(d, e.s); t = Kachel(c)
        if e.art in (FRONT, SIDE):
            if not faces(t): continue
            ent = resolve(Wand, e.index, t.walls[Fläche(e)])
            if ent is None or allcov(cover, e.x, e.x + e.w): continue
            add(WALL(e, ent))                   # STOP möglich
            if deck(e, t, ent):
                if e.art == FRONT:
                    mark(cover, e.c0, e.c1)
                    if e.flags Bit 3: mark(bcov, e.c0, e.c1) else pend += (e.c0, e.c1, nur bcov)
                else: pend += (e.c0, e.c1, beide)
        elif e.art == OBJ and d >= 1 and (not faces(t) or t.flags INHALT):
            objekte(d, e, c)                    # 5.8, STOP möglich
    baender(d, BODEN); baender(d, DECKE)        # 5.6, STOP möglich
    tapete(d)                                   # 5.7, STOP möglich (Horizont bei Fernsicht-Füllung erst unten)
    for (c0, c1, ziel) in pend: mark(bcov, c0, c1); if ziel == beide: mark(cover, c0, c1)
    if fern: fernsicht()                        # 5.7a, nur d = D mit Fernsicht-Füllung, STOP möglich
    if ncov == VW: break                        # ncov zählt belegte Spalten in cover
```

- **5.2a Kachel-Flag INHALT (Nutzerentscheidung 4, DMP Bit 5):** Zellen mit Flächen und diesem Flag (Tür, Gitter, Bogen) zeigen auch ihre Objekte. Die Zelle trägt ihre Elemente in der Sichtliste in der Reihenfolge **Fronten, Objektplatz, Seiten** ein (statt DVG-Reihenfolge Front, Seite, Objektplatz), die Ausgabe rückwärts malt damit Seitenfläche, Objekte nach Unterposition, Front. Zellen = Gruppen gleichen s in der DVG (P3 5.3: zusammenhängend); alle anderen Zellen unverändert in DVG-Reihenfolge. Das Flag ändert die Abdeckung nicht.
- `mark` setzt Bytes auf 1 und erhöht ncov für neu belegte Spalten von `cover`.
- Elemente FLOOR/CEIL werden in der Schleife nicht ausgegeben (nur in `baender`).
- Die Sichtliste wird bei der Ausgabe **rückwärts** abgearbeitet (5.11). Daraus folgt die Malreihenfolge je Tiefe D … 0: Tapete, Decke (Grund, Kacheln), Boden (Grund, Kacheln), Zellen außen → innen, je Zelle Seite vor Front bzw. Objekte hinten → vorne. Das ist Plan 5 mit review-notes B.1–B.3: Seitenflächen einer Tiefe verdecken erst nach den Objekten und Bändern dieser Tiefe; Fronten verdecken sofort (Seiten und Objekte derselben Tiefe weiter außen liegen hinter ihnen).

### 5.3 Wände

`WALL(e, ent)`: Ziel T0 = AP + row[e.y] + e.x. Ausgabe nach P5 4.4: je Kern ein `VMC` (VCL-Typ 2 bei srcstep 0, sonst 3), dann bei RAND ein `VMS` (Typ 12) mit der kopierten Liste. Wände und Kacheln werden **nicht** beschnitten (das DVG-Rechteck liegt im Fenster).

### 5.4 Abdeckung – Annahmen

- Eine Abdeckung in `cover` aus Tiefe d gilt für alle Zeilen von P_{d+1} (P3 4.4). Objekte werden **nicht** gegen `cover` beschnitten (P6i, Nutzerentscheidung): ein Sprite wird vollständig gezeichnet und von den näheren Wänden, die in der Malreihenfolge später kommen, übermalt (Painter, Begründung 5.8a). Ein Sprite, das höher ist als die Wand an seiner Tiefe, wird über der Wandoberkante von den Deckenbändern bzw. der Tapete der näheren Tiefen übermalt (P5b 3.4 warnt weiterhin, weil es dann über dem Boden „schwebt“ bzw. in die Decke ragt).
- Nicht abzudecken ist immer korrekt (nur Mehrarbeit).
- Zellen mit Flächen zeigen keine Objekte (Plan 5: entweder Flächen oder Inhalt), auch wenn die Flächen nicht decken – **außer** die Kachel hat das Flag INHALT (5.2a, review-notes G.14).

### 5.5 Gruppen der Malreihenfolge innerhalb eines Eintrags

Ein Sichtlisteneintrag erzeugt in dieser Reihenfolge: alle Kerne (in Tabellenreihenfolge), dann die VMS-Liste. Mehrere Folgen (Spannen) eines Bandes erzeugen getrennte Einträge.

### 5.6 Bänder und Kacheln: `baender(d, K)`

Band-Zeilen [y0, y1) = Bodenband bzw. Deckenband der Tiefe d; leer → zurück. Kachel-Elemente E_K(d) = Elemente der Tiefe d mit Art FLOOR bzw. CEIL (DVG-Reihenfolge).

1. Je Element e in E_K(d), Kachel t = Kachel(cell(d, e.s)): blocked(t) → **egal**; sonst n = t.floor bzw. t.ceil, st = n − 1; n = 0, kein DTS der Art oder st ≥ NST → **Lücke**; sonst Stil st.
2. Alle egal → zurück (nichts zu zeichnen).
3. **Einheitlich**, wenn es keine Lücke gibt und alle nicht egalen Elemente denselben Stil st haben und `resolve` für das Band (slotindex des Bandes, n = st + 1) ein Bild liefert: Grund = Band(st), keine Kacheln.
4. Sonst **gemischt**: gibt es eine Lücke, ist der Grund die Tapete (`lueckeK = wahr`, 5.7) und Kacheln kommen für alle nicht egalen Nicht-Lücken; ohne Lücke ist der Grund Band(st0) mit st0 = Stil des ersten nicht egalen Elements in DVG-Reihenfolge, dessen Bandbild sich auflösen lässt (keins → Grund leer), und Kacheln kommen für alle nicht egalen Elemente mit Stil ≠ st0 (bzw. alle, wenn der Grund leer ist).
5. **Anhängen** (rückwärts zur Malreihenfolge): zuerst die Kacheln in DVG-Reihenfolge – je Kachel `ent = resolve(Art, e.index, n)`; nichts → überspringen; `allcov(bcov, e.x, e.x + e.w)` → überspringen; sonst `add(WALL(e, ent))` –, danach der Grund (falls Band): je Folge aus `spans(bcov)` **von rechts nach links** `add(BAND(ent, y0, c0, c1))`.

`BAND(ent, y0, c0, c1)`: Bandbild in Zeilen [y0, y0 + h), Spalten [c0, c1):
- ZEILEN (P5 5.6): je Zeile i das Füllbyte b_i, aufeinanderfolgende gleiche Bytes zu Gruppen; Gruppe mit 1 Zeile → VCL-Typ 4 (`AP + row[y0 + i] + c0`, b, c1 − c0), mit r > 1 Zeilen → Typ 5 (dto., reps r, step stride).
- sonst: Kerne und Rand wie ein Sprite-Bild mit `clip_image` (P5b 6) im Bandrechteck (x0 = 0, y0) und Ausschnitt [c0, c1) × [y0, y0 + h); volle Breite = unbeschnitten.

### 5.7 Tapete: `tapete(d)`

Zeilenbereiche (oben nach unten): Deckenband d, falls `lueckeDECKE`; Horizont [hy0, hy1), falls d = D und nicht `fern` (5.7a); Bodenband d, falls `lueckeBODEN`. Leere Bereiche entfallen, aneinandergrenzende werden verbunden. Folgen = `spans(bcov)`. Anhängen: Bereiche **von unten nach oben**, je Bereich die Folgen **von rechts nach links**, je Paar `add(BG(r0, r1, c0, c1))`.

`BG(r0, r1, c0, c1)` (P5 6.2):
- **Ohne DBG:** Füllbyte f aus `BGSET`: ein Eintrag Typ 4 (r1 − r0 = 1) bzw. Typ 5 (`AP + row[r0] + c0`, f, c1 − c0, reps r1 − r0, step stride).
- **Mit DBG** (Panoramazeilen [y0, y0 + h), Versatz o = o_v der Richtung v):
  1. Zeilen über dem Panorama [r0, min(r1, y0)) und darunter [max(r0, y0 + h), r1): Füllbytes je Zeile aus der DBG, gleiche aufeinanderfolgende gruppiert, Typ 4/5 wie bei ZEILEN.
  2. Panoramazeilen [a, b) = [max(r0, y0), min(r1, y0 + h)), falls nicht leer: Quellspalte q = (o + c0) mod P, n = c1 − c0. Wenn q + n ≤ P: ein Typ 3 (`VB + (a − y0) · P + q`, `AP + row[a] + c0`, n, reps b − a, step stride, srcstep P). Sonst (nur mit WRAP) zwei Typ 3: n1 = P − q ab q, dann n − n1 ab Quellspalte 0 an Zielspalte c0 + n1.
  3. Reihenfolge der Einträge: über, Panorama (Teil 1, Teil 2), unter.

Reihenfolge der Bereiche und Teile im Bild ist gleichgültig (sie überdecken sich nicht), für den Listenvergleich aber festgelegt.

### 5.7a Fernsicht: `fernsicht()` (P6l, Nutzerentscheidung 2026-11-26)

Ohne Füllung ist die Tapete auch die Fernsicht: Sichtlinien länger als D enden im Horizontband [hy0, hy1) der Tiefe D in der Tapete. In Innenräumen mit Landschafts-Tapete sieht man dann z. B. durch ein Gitter in einer überdachten Kammer Berge. Mit **Fernsicht-Füllung** (`BGSET` Y ≠ 0, Füllbyte f = P2 Low) entscheidet je Spalte die Kachel, durch die man in die Ferne blickt, ob dort Tapete oder das Füllbyte erscheint. Ohne Füllung (Y = 0, Standard nach `INIT`) ist alles wie bisher.

- **Zelle je Spalte:** Das Horizontband ist das Bild der Ebene P_{D+1}, der fernen Kante der Zellen der Tiefe D. Spalte c gehört zur Zelle (D, s(c)), aus der ihr Sichtstrahl über P_{D+1} hinaus austritt. Die Grenzen sind die fernen Kanten der **Seitenflächen** der Tiefe D (Rechteck in der DVG, P3 4.4): eine Seite mit s < 0 endet rechts bei x + w, eine mit s > 0 beginnt links bei x. Daraus `s(c) = − #{Seiten s < 0 mit c < x + w} + #{Seiten s > 0 mit c ≥ x}` (alle Seiten der Tiefe D, unabhängig von Bild und Flags). `GEOMSET` legt die Tabelle `hs[c] = s(c) + 15` an. Voraussetzung (von `dbegeom` erfüllt): höchstens eine Seite je Zelle und für jedes vorkommende s(c) eine Zelle (D, s(c)) mit Elementen; sonst ist die Entscheidung dieser Spalten unbestimmt (die Referenz meldet einen Fehler).
- **Entscheidung je Zelle** (Kachel t der Zelle (D, s), auch die Außenkachel; blockierte Zellen wie alle anderen): **Füllung**, wenn Deckenstil t.ceil ≠ 0, **Tapete**, wenn t.ceil = 0 (Himmel). Kachel-Flag **FERN** (DMP Bit 6, P4 2.4) kehrt die Regel um: überdachte Kachel mit Blick ins Freie (Arkade, Veranda) → Tapete; Kachel ohne Decke, hinter der es dunkel sein soll (Höhle ohne Deckentextur) → Füllung.
- **`fern`** = Füllung an und d = D und mindestens eine Zelle der Tiefe D (Zellentabelle) mit Entscheidung Füllung. Sonst bleibt der Horizont in `tapete(D)` wie bisher (Bilder ins Freie sind damit auch in der Liste unverändert).
- **Ablauf mit `fern`:** `tapete(D)` lässt den Horizont weg (Decken- und Bodenband mit Lücke bleiben Tapete über `spans(bcov)`). Nach dem Wartebereich der Tiefe D (dann deckt `bcov` alle Spalten ab, in denen eine deckende Front oder Seite der Tiefen 0 … D die Zeilen von P_{D+1} = Horizont ganz verdeckt; nur in den übrigen Spalten kann hinter der letzten Tiefe noch etwas sichtbar sein) für jede Folge aus `spans(bcov)` **von rechts nach links** die Läufe [a, b) gleicher Entscheidung **von rechts nach links**: Füllung → `add` eines Eintrags Typ 4/5 (`AP + row[hy0] + a`, f, b − a, reps hy1 − hy0, step stride) wie BG ohne DBG; Tapete → `add(BG(hy0, hy1, a, b))` (5.7, mit oder ohne DBG). Leerer Horizont (hy0 ≥ hy1): nichts.
- **Malreihenfolge:** Die Einträge sind die letzten der Sichtliste, werden also zuerst gemalt (ganz hinten, vor allem anderen, auch vor Decken-/Bodenband D und den Wänden der Tiefe D). In den Spalten mit Füllung wird keine Tapete ausgegeben (nur das Füllbyte, ein Typ 4/5 statt Typ 3 je Lauf). Fenster, Gitter und Bögen decken nicht ab (5.4): dahinterliegende Wände werden normal gezeichnet; die Füllung liegt nur in den danach freien Spalten und unter allem, was davor gemalt wird.
- **Größe und Überlauf:** wie jeder BG-Eintrag (5.10); `STOP` in `fernsicht()` verliert nur Horizont-Einträge.
- `paint_reference` malt den Horizont voll breit wie bisher und überschreibt danach die Spalten mit Entscheidung Füllung mit f (unabhängig von `fern`, Abdeckung und Spannen).

### 5.8 Objekte: `objekte(d, e, c)`

1. Kandidaten der Zelle c: Objekte i der Liste (i < OBJN, Zellindex = c, Bit 6 von Byte 5 = 0) mit p = SUBPOS[v][q] (q = Byte 5 AND 7, q > 4 → 4; Tabelle P4 2.6); Gegenstand g = Inhalt(c) AND 63, falls g ≠ 0 und `itemtab[g]` ≠ 0, mit p = 2, Satz `itemtab[g]` − 1, Richtung `$FF`, Phase ITEMPH.
2. **Malreihenfolge:** p aufsteigend (0 hinten links, 1 hinten rechts, 2 Mitte, 3 vorne links, 4 vorne rechts; P3 3.3); bei gleichem p zuerst der Gegenstand, dann Objekte nach i aufsteigend. **Anhängen in umgekehrter Malreihenfolge.**
3. Je Kandidat: Satz ungültig → überspringen; a = 0 bei Richtung `$FF`, sonst (2 + v − o) AND 3; Bild = `lookup(Satz, f, a, d)` (P5b 6.3; f ≥ NP → 0; `$FF` → Phase 0; `$FE` → überspringen).
4. Anker (ax, ay) = e.anchor[p] (vorzeichenbehaftete Byte-Spalte, Zeile); x0 = ax − fx, y0 = ay − fy (16 Bit vorzeichenbehaftet).
5. Ausschnitt nur am Fenster: cx0 = max(x0, 0), cx1 = min(x0 + w, VW), cy0 = max(y0, 0), cy1 = min(y0 + h, VH); leer → überspringen. `allcov(cover, cx0, cx1)` → überspringen (alle Spalten des Ausschnitts verdeckt). Sonst bleibt der Ausschnitt, wie er ist: kein Zuschneiden gegen `cover` (P6i). Liegt das Sprite ganz im Fenster, ist es unbeschnitten (Kerne + Rand als Typ 9 bzw. im Build `VMS_COPY` als Kopie, 5.9).
6. `add(SPRITE(Satz, Bild, x0, y0, cx0, cx1, cy0, cy1))`; Objekte decken nichts ab. Bei Annahme: OBJVIS Bit i setzen (nur Listenobjekte).

### 5.8a Verdeckung von Sprites über die Malreihenfolge (P6i)

Ein Sprite in Tiefe d (Zelle s) wird vollständig gezeichnet. Ein Zuschneiden gegen `cover` ist unnötig, wenn jede Wand, die eine Spalte von `cover` zum Zeitpunkt des Sprites belegt, in der ausgeführten VCL **nach** dem Sprite kommt und selbst ungeschnitten ist. `cover` enthält dann genau:

1. **Fronten und Seiten der Tiefen < d** (deckend): Die Ausgabe läuft Tiefe D … 0, die Tiefe d' < d kommt ganz nach d. Wände werden nie beschnitten (5.3); eine Wand, die wegen `allcov(cover)` entfällt, liegt in Spalten, die eine noch nähere, ebenfalls spätere Wand deckt. Eine deckende Front bzw. Seite der Tiefe d' deckt in ihren Spalten [c0, c1) alle Zeilen von P_{d'+1} (5.4, Seiten: das Trapez ist an jeder Spalte mindestens so hoch wie P_{d'+1}), ein Sprite in der Zelle d ≥ d' + 1 liegt darin, solange es nicht höher ist als die Wand seiner Tiefe.
2. **Fronten der Tiefe d in Zellen weiter innen** (sie belegen `cover` sofort): Die Zellen einer Tiefe werden innen → außen durchlaufen und außen → innen gemalt, die innere Front kommt also nach dem Sprite der äußeren Zelle.
3. **Front der eigenen INHALT-Zelle** (5.2a): Erzeugung Fronten, Objekte, Seiten, gemalt Seite, Objekte, **Front**; die Front kommt nach den Objekten.

Seiten der Tiefe d (auch weiter innen) belegen `cover` erst am Ende der Tiefe (`pend`) und kommen ebenfalls nach dem Sprite. Fronten und Seiten derselben Tiefe weiter außen kommen vor dem Sprite, belegen aber beim Sprite `cover` noch nicht; das ist unverändert gegenüber P6 (dort wurde gegen sie ebenfalls nicht geschnitten).

**Bänder, Kacheln, Tapete:** Bodenbänder, Deckenbänder, Kacheln und Tapete einer Tiefe d'' < d werden nach dem Sprite gemalt und übermalen Teile, die in ihre Zeilen ragen (zu hohe Sprites; Objekte stehen mit dem Fußpunkt auf dem Boden ihrer Zelle, Plan 5). Sie werden nur gegen `bcov` geschnitten; in einer Spalte, die eine deckende Wand der Tiefe d' belegt, fehlen sie genau ab der Tiefe d', also in den Zeilen, die diese Wand selbst deckt (Bit 3) bzw. die sie nach den eigenen Bändern übermalt (ohne Bit 3: `pend`, Bänder der Tiefe d' kommen vor ihren Wänden). Über und unter der Wand bleiben die Bänder der Tiefen < d' und übermalen das Sprite dort. Die Zusammenlegung von mehr als 4 Spannen (5.1 `spans`) malt Bänder über verdeckte Spalten; die Wände darüber kommen danach, das Ergebnis bleibt gleich. Alle Fälle betreffen Zeilen, die das Sprite schon in P6 ungeschnitten erreichte (geschnitten wurde nur nach Spalten); **zusätzliche Änderungen der Reihenfolge sind nicht nötig**.

**Grenzfälle** (wie bisher, kein neuer Fehler): (a) Überlauf: ein Wandeintrag „ohne Rand“ oder „verworfen“ (5.10) belegt `cover` trotzdem; das Sprite dahinter ist dann teilweise sichtbar (A = 3). Bisher fehlte dort das Sprite und der alte Bildinhalt blieb stehen; beides ist ein Fehlerzustand. (b) Bänder ohne auflösbares Bild (gemischt, Grund leer, Kachel ohne Bild) malen nichts; dort steht dann ein zu hohes Sprite statt des alten Bildinhalts. (c) Sprites, die höher sind als die Wand ihrer Tiefe (P5b 3.4): Was über der Oberkante der verdeckenden Wand liegt, übermalen die Deckenbänder näherer Tiefen; vorher war es abgeschnitten. Das entspricht 0.1 (Crawl 1.0f übermalte ebenfalls).

### 5.9 Beschneiden

Sprites (nur am Fenster, 5.8) und Bänder mit Rand werden mit `clip_image` (P5b 6) geschnitten. Ziel eines Kerns: `AP + row[Zeile] + Spalte`; Ziel einer beschnittenen VMS-Liste: `AP + row[cy0] + cx0`; unbeschnitten `AP + row[y0] + x0` (dann gilt y0 ≥ 0, x0 ≥ 0). VMS-Quelle immer `VB + rand_ofs` (die übersprungenen Bytes am Anfang erledigt Typ 3). Die 6502-Fassung rechnet ofs' mit einem laufenden Zeilenanfang (keine Multiplikation) und bricht ab, sobald r ≥ B.

### 5.10 Größenrechnung und Überlauf

Der Sichtdurchlauf führt `nv` (VCL-Bytes, Start 1 für das Ende-Byte) und `nm` (VMS-Bytes); Puffergröße BL = B1 − B0. Je Eintrag sind seine Größen **exakt** bekannt: Kerne 11 Byte (Typ 2) bzw. 13 (Typ 3) nach dem Beschneiden, Typ 4 = 7, Typ 5 = 11, VMS-Eintrag 7 + Listenlänge (bei beschnittenen Listen durch einen Probelauf von `clip_image` ohne Schreiben ermittelt).

```
add(item):
    if Anzahl == MAXITEM:                      → A = 2, STOP
    if nv + item.v + nm + item.m <= BL:        annehmen
    elif item.m > 0 and item.v > 7 and nv + item.v - 7 + nm <= BL:
                                               annehmen ohne Rand, partial = 1
    elif item.m > 0 and item.v == 7:           verwerfen, partial = 1 (weiter)
    else:                                      → A = 2, STOP
```

Feste Listenadresse (P6j): BL = B1 − B0 − 3 (Sprung bei B0), sonst unverändert.

- Abbruch verliert die **hinteren** Teile (der Durchlauf geht vorne → hinten). Bänder und Tapete einer Tiefe kommen nach deren Zellen; bricht es dort ab, bleiben Zeilen der Tiefe ungezeichnet (alter Bildinhalt). Das ist ein Fehlerzustand (A = 2), kein Normalfall; Spiele messen ihre Szenen (Bericht `dbeview budget`, 9.1).
- A = 2 hat Vorrang vor A = 3.

### 5.11 Ausgabe (hinten → vorne)

**Einpass (P6d-opt):** Es gibt keine Sichtliste mehr. Jeder angenommene Eintrag wird beim Sichtdurchlauf sofort geschrieben: seine VMS-Liste aufwärts ab dem VMS-Zeiger (Start B0), seine VCL-Einträge in Erzeugungsreihenfolge **abwärts** vom VCL-Zeiger (Start B1 − 1 mit dem Ende-Byte 0). Die Liste ab VCLADR ist damit die umgekehrte Erzeugungsreihenfolge: hinten → vorne, und innerhalb eines Eintrags ebenfalls umgekehrt (erst die VMS-Liste, dann die Kerne rückwärts; pixelgleich, weil Kerne und Rand bzw. ZEILEN-Gruppen und Tapetenteile disjunkt sind, P5 4.4). VCLADR = B1 − nv, VCLLEN = nv, VMSLEN = nm, X = min(Anzahl VCL-Einträge, 255).

Überlauf: Reicht beim Schreiben der freie Raum (VCL-Zeiger − VMS-Zeiger) nicht, wird der Eintrag zurückgenommen, im Zählmodus genau gemessen und nach 5.10 entschieden (annehmen, ohne Rand, verwerfen, STOP); die Regel und damit die Ergebnisse sind unverändert.

Feste Listenadresse (P6j): VMS-Zeiger ab B0 + 3; bei B0 steht schon vor dem Durchlauf das Typ-Byte 10, am Ende kommt die Adresse B1 − nv dazu. VCLADR = P0 = B0.

Im Spiel: `SYS3331,4,...:RREG A:::VCL PEEK(3072)+256*PEEK(3073)` (P0 = VCLADR); mit fester Listenadresse `::VCL VB` mit VB = B0 (Ergebnis P6j).

## 6. Ausgabe-VCL-Typen

Alle Parameter als Wort (Low/High), auch Bytewerte (VDC-BASIC `vcl-format.md`).

| Typ | Länge | Felder | Verwendung |
|---|---|---|---|
| 2 | 11 | src, dst, count, reps, step = stride | Kerne mit srcstep 0 **oder srcstep = count** (P6h; Quelle läuft ohnehin hinter dem vorigen Lauf weiter) |
| 3 | 13 | src, dst, count, reps, step = stride, srcstep | Kerne mit srcstep ∉ {0, count}, beschnittene Kerne (Teilbreite), Tapete (srcstep P, immer Typ 3) |
| 4 | 7 | vaddr, byte, count | Zeilenfüllung, eine Zeile |
| 5 | 11 | vaddr, byte, count, reps, step = stride | Zeilenfüllung, mehrere gleiche Zeilen |
| 12 | 7 | src, dst, list | Rand (VMS) beschnitten; Liste im Puffer, Befehle Typ 1, 3, 8 (Build `VMS_COPY`: auch unbeschnittene) |
| 9 | 7 | src, dst, list (Bank 1) | Rand (VMS) unbeschnitten (Wände, Kacheln, Bänder voller Breite, Sprites): Liste direkt aus Bank 1 (6a) |
| 0 | 1 | – | Ende |

Nicht benutzt: 1, 6, 7, 8 (`RXV` lädt das Spiel), 13. Grenzen: reps ≤ 100 (VH), count ≤ 80, VMS-Typ-1-Länge ≤ 255.

## 6a. Vorschlag VDC-BASIC: VCL-Typ 9 „VMS aus Bank 1“ (P6d-opt, Entscheidung 2)

**Vorläufig:** Die Lesemethode ist offen (VDC-BASIC P2d). Liest VDC-BASIC nicht direkt mit `$FF00 = $7E` (sein Code ab `$2000` liegt nicht im gemeinsamen RAM), sondern z. B. per FETCH oder über einen Zwischenpuffer im gemeinsamen RAM, bleibt die Engine-Seite gleich (Eintrag mit Bank-1-Adresse, Build-Schalter `VMS_BANK1`); Typnummer und Bereichsregel werden dann an P2d angepasst. Die Zyklen mit `VMS_BANK1` messen nur die Engine; die Kosten verschieben sich in die VCL-Ausführung und sind erst mit P6g (VIEW + VCL) vergleichbar.

| Byte | Inhalt |
|---|---|
| 0 | 9 |
| 1–2 | source: VRAM-Adresse der Randbytes (= VB + rand_ofs) |
| 3–4 | target: VRAM-Bezugsadresse (wie Typ 12) |
| 5–6 | list: Adresse der VMS-Liste in **CPU-RAM Bank 1** |

- Listenformat unverändert wie Typ 12 (`vms-format.md`: Alpha, Anzahl, Befehle; die Engine erzeugt 1, 3, 8).
- Die Liste liegt ganz in Bank 1 `$4000–$CFFF` oder `$E000–$FEFF` (Engine-Vorgabe seit P6g: `$E000–$FBFF`, Blitz!-Runtime, 2.4; nie in `$D000–$DFFF`, nie unter `$4000`: VDC-BASIC schaltet für Typ 9 das gemeinsame RAM kurz auf 16 KB unten, P2d). Die Engine prüft das in `TEXSET` und `SPRITESET` (Adresse < `$4000` → A = 6; nicht im Build `VMS_COPY`); Typ 9 belegt keine Pufferbytes. VDC-BASIC liest sie mit `$FF00 = $7E` (Bank 1 mit I/O, VDC-Register erreichbar; Schleife im gemeinsamen RAM `$1C00–$1FFF`) und stellt danach seine Konfiguration wieder her. Interrupts dürfen laufen (Kernal-Weiche in Bank 1 `$FF05–$FFFF`, wie beim Stub).
- Die Engine schreibt Typ 9 nur für **unbeschnittene** Listen (Wand-/Kachelbilder, Bänder in voller Breite, unbeschnittene Sprites): list = Inhaltsanfang des DTS bzw. S2 + vofs. Beschnittene Listen bleiben Typ 12 im Puffer. Typ 9 belegt keine Pufferbytes (m = 0 in 5.10; „ohne Rand“ und „verwerfen“ gelten nur für Listen im Puffer).
- Engine: **Standard** seit dem P6e-Review (VDC-BASIC P2d abgenommen); der alte Weg (Kopie, Typ 12) bleibt als Build-Schalter `VMS_COPY` (`ca65 -DVMS_COPY`, kostet im Standardbuild nichts, sim testet beide). Referenz: `Scene.vms_bank1` (Vorgabe noch `False` = `VMS_COPY`, weil die Demo-Assets nicht in die Bereiche von 2.4 passen und sich Bank-1-Adressen sonst überlappen), `Scene.dts_addr`, `Scene.s2_addr` (`None`: dicht ab `$7000`); `run_vcl(..., bank1=...)` führt Typ 9 aus.

## 7. Grenzen

| Größe | Grenze | bei Überschreitung |
|---|---|---|
| DVG | NE ≤ 255 (keine Kopie, die Lib liest die Tabelle direkt; 0.1-`MAXWS` entfällt, review-notes C.3), VW ≤ 80, VH ≤ 100, D ≤ 7, S ≤ 15 (P6d: höchstens 31 Zellen je Tiefe) | GEOMSET A = 1 |
| DTS | NST ≤ 32 (Stilzeilentabelle, P6d) | TEXSET A = 1 |
| DBG | P ≥ 1 | BGSET A = 1 |
| Wartebereich je Tiefe | 16 deckende Seiten bzw. Fronten ohne DVG-Bit 3 | GEOMSET A = 1 (P6d-opt; vorher VIEW A = 2) |
| Elementtabelle (GEOMSET, P6d-opt) | first + n ≤ NE, Art ≤ 4, \|s\| ≤ S, Zellen zusammenhängend (P3 5.3), ≤ 16 Elemente und ≤ 1 Boden- bzw. Deckenelement je Zelle, Art 0–3: x + w ≤ VW, y + h ≤ VH, Wände: c0 ≤ c1 ≤ VW; ≤ 48 Zellen und ≤ 96 Wände gesamt | GEOMSET A = 1, keine gültige Geometrie; `dbeview.parse_dvg` ViewError |
| Einträge je VIEW | MAXITEM = 96 | A = 2 |
| Puffer | BL (Standard 2304) für VCL + VMS zusammen | A = 2 bzw. 3 (5.10) |
| Objektliste | 16 | mehr wird ignoriert |
| Objektplätze je Zelle (Art 4) | beliebig viele (innerhalb der 16 Elemente); Zellentabelle: erster und letzter | – |
| Sprite-Sätze | 8 | A = 6 |
| Kerne je Bild | 16 (DTS und S2) | Lib verarbeitet nk, wie angegeben; Werkzeuge begrenzen |
| Karte | W, H ≤ 255, W·H ≤ 16384 | MAPINIT A = 1 |

## 8. Zyklenziele (sim65, Westwood 140 × 96, D = 3)

| Fall | Ziel |
|---|---|
| Crawl auf 0.2 (P7-Daten), alle Ansichten | ≤ 2 × 0.1 (0.1: 10 813–14 191) |
| Gang mit deckenden Wänden, einheitliche Bänder, keine Objekte | Mittel ≤ 30 000, max ≤ 45 000 |
| offene Szene: gemischte Kacheln, Lücken, Tapete mit WRAP, Gitter | max ≤ 80 000 |
| je sichtbares Objekt (unbeschnitten / beschnitten) | ≤ 2 500 / ≤ 4 000 + 12 je kopiertem bzw. geprüftem Listenbyte |
| `MAPINIT`, `GEOMSET`, `TEXSET` | ≤ 20 000 (einmalig; MAPINIT ohne Arbeitskopie) |

Verfehlte Ziele sind ein Befund mit Messwerten, kein Abnahmehindernis für P6d/P6e; P6f optimiert die teuersten Teile (Profil über sim65-Zähler je Abschnitt). Die VDC-Zeit der Liste misst P6g in VICE.

## 9. Testkonzept

### 9.1 Python-Referenz `tools/dbeview.py`

Unabhängig von der 6502-Fassung geschrieben (P6b, vor P6d), aus dieser Spezifikation:

```python
class Scene: dvg, dmp, dts[3], dbg, bgfill, farfill (P6l), s2[8], vram_bases, itemtab, objects, itemph, pos, dir, ap, buf=(0x1300, 0x1C00)
def view(scene) -> Result            # a, x, vcl (bytes ab B0), vms (bytes), vcllen, vmslen, objvis – bytegenau nach Abschnitt 5
def run_vcl(bank0, vram, addr)        # VCL-Interpreter: Typen 1–8, 12, 13 (13 = nichts), VMS 1, 2, 3, 8; RXV über vrl.decode
def paint_reference(scene, vram)      # unabhängiger Maler ohne Abdeckung und Spannen
def load_scene(toml) ; def random_scene(seed, ...) ; def budget(scene_list)
```

- **`paint_reference`** malt in Plan-Reihenfolge (5.2 letzter Absatz) **alles**, was nach Karte und Stilen existiert, ohne `cover`/`bcov`, ohne Spannen (Bänder volle Breite, Tapete volle Breite), Sprites nur am Fenster beschnitten. Bausteine: `dbetex.render` (Einträge), `dbetex.render_background` (Tapete), `dbespr.render_image` (Sprites). Die Bänder-Entscheidung (einheitlich, gemischt, Lücke) ist dieselbe wie in 5.6.
- **Pixelprüfung:** `run_vcl(view(scene))` = `paint_reference(scene)` im Sichtfenster, für alle Szenen, in denen jedes Sprite höchstens so hoch ist wie die Wand seiner Tiefe (5.4). Damit ist bewiesen, dass Abdeckung, Spannen und Beschneiden unsichtbar sind. Außerhalb des Fensters wird kein VRAM-Byte verändert (Prüfung über das ganze 64-KB-Feld mit Zufallsinhalt).
- **Antwort auf die Frage „dbetex-Renderer als Referenz?“:** `dbetex.render`/`preview` zeichnet nur Einträge, keine Szene; er ist Baustein von `paint_reference`, nicht die Referenz selbst. Die Bytes der Liste prüft `view`, die Pixel prüft `run_vcl` gegen `paint_reference`.
- `budget(scenes)`: größte nv + nm, Einträge, Warnung bei A ≠ 0 – für Spielszenen (Werkzeug für Leveldesigner).

### 9.2 sim65: Listenvergleich 6502 ↔ Python

- `test/sim/sim.cfg` neu: Programm `$2000–$4FFF`; Daten an ihren Bank-1-Adressen nach 2.4 (sim65 hat einen flachen 64-KB-Speicher; `$D000–$DFFF` bleibt frei wie in der echten Karte). Parameterblock und Puffer wie auf dem C128.
- Harness `test/sim/viewsim.c` neu: liest eine **Szenendatei** (Segmente Adresse/Länge/Daten, dann Aufrufe: F, X, Y, P0–P3, Objektliste, ITEMPH) über die sim65-Dateifunktionen, führt die Aufrufe aus und schreibt je Aufruf A, X, Y, P0–P3, Parameterblock `$0C08–$0C11` und bei `VIEW` den Puffer (B0 … B0 + nv + nm) in eine Ergebnisdatei. Viele Ansichten je sim65-Lauf.
- `test/sim/run_sim.py`: erzeugt Szenendateien aus Python-Szenen, baut (cl65, `--asm-define SIM`), startet sim65, vergleicht mit `dbeview.view` **bytegenau**; bei Abweichung: erste abweichende Stelle als dekodierter VCL-Eintrag beider Seiten.
- Zyklen: sim65 liefert nur die Summe eines Laufs. Messung wie 0.1 als Differenz zweier Läufe (mit/ohne VIEW) für eine Stichprobe von Ansichten; Profil je Abschnitt über `SIM`-Zählpunkte (P6f).

### 9.3 Szenen und Karten

| Satz | Inhalt |
|---|---|
| demo | `docs/specs/examples/demo.toml` mit den P5-Beispieltexturen (ziegel, gitter, fenster, bogen; stein, holz; himmel mit WRAP) und P5b-Demo-Sprites; alle freien Zellen × 4 Richtungen; je Ansicht 0, 1 und 5 Objekte (fester Seed) |
| abgrund | demo-Variante mit Zellen ohne Boden/Decke (Lücken, review-notes D.6) und blockierten Zellen mit Boden 0 |
| zufall | 200 Zufallskarten 8 × 8 … 24 × 24 (Kacheln mit zufälligen Stilen, Flags, Lücken; Außenkachel zufällig), je 20 Ansichten, bis 16 Objekte inkl. Bit 6/7, Gegenstände, ITEMPH |
| rand | Sprites gezielt an Fensterrändern (s = ±1, ±2, d = 1 … 3, alle p), teilweise verdeckt, über dem oberen Rand |
| überlauf | `BUFSET` mit 64, 128, 256, 512, 1024 Byte auf demo- und Gitter-Szenen: A, Kürzung hinten, Ränder weggelassen, Liste immer korrekt abgeschlossen und ausführbar |
| fehler | Formatfehler, falsche ID/Art/Stride, Reihenfolge (E_STATE), Bereiche (E_RANGE), unbekannte F |

### 9.4 VICE-Szenen

`test/vice_view.py` (Portregel review-notes A: `--port`, `DBE_VICE_PORT`, Standard 6631, Bereich 6631–6649, bind-Test, nur eigener Prozess, `-remotemonitor -remotemonitoraddress ip4://127.0.0.1:<port>`):

- Disk: `BOOT` (VDC-BASIC v3, Zeile 50 `RUN"T"`), `VDCBASIC3`, Stub, Lib, DVG, DMP, DTS/DBG/S2 mit VRL, Testprogramm `T` (BASIC) und Szenentabelle (PRG in Bank 0 über dem Programm).
- `T`: lädt alles (`BLOAD`, `RXV` der VRL in den Pool), GEOMSET/TEXSET/BGSET/SPRITESET/ITEMSET, dann je Szene: SETPOS, Objektliste, `VIEW`, `::VCL 4864`, `::VTR` der Fensterzeilen in einen Bank-0-Puffer, dann `SYS` auf eine Marke (RTS bei `$0C4E`).
- Ereignisgesteuert: Haltepunkt auf der Marke → Monitor liest Puffer und VCL-Liste (`bank ram`), Haltepunkt auf dem BASIC-Fehlervektor `($0300)` → Abbruch mit Zeilennummer; Timeout nur als Wächter. Keine festen Wartezeiten.
- Vergleich: Fenster-Bytes = `dbeview.run_vcl` derselben Szene; VCL-Liste = sim65-Ergebnis. Zeit: Stoppuhr an Marken vor und nach `VIEW` und `VCL` (Zyklen), Bericht je Szene.
- Interpretiert und als Blitz!-Kompilat (Image 2, `test/blitzprep.py` aus vdc-basic).

### 9.5 Crawl (P7)

Pixelgleichheit von Crawl auf 0.2 mit den 19 Testbildern und den 10 Geisterszenen aus Schritt 1/1b (Screenshot-Vergleich wie `vice_drive.py`, das dafür die Portregel übernimmt). Voraussetzung ist der Konverter aus P7 (Crawl-DVG mit zwei Fronten je Zelle (2, ±1)/(3, ±1), Crawl-DTS nur mit Kernen, S2 für Geister und Edelstein, Tapete = Füllbyte 0). Die Lib verarbeitet beliebig viele Elemente je Zelle in DVG-Reihenfolge; P6 testet das mit einer synthetischen DVG (9.3 zufall: doppelte Fronten).

## 10. Teilschritte

| Schritt | Inhalt | Abnahme | Modell |
|---|---|---|---|
| **P6a** Gerüst | Stub mit 8 KB gemeinsam (`$06`), `LIB = $B000`, `lib.cfg` (Code `$B000`, BSS `$E000`), `dbe.inc` (Adressen 2.2/2.3, Fehlercodes 3.1), Dispatcher mit Tabelle 3 (Rest `E_NOTIMPL`), INIT, POOLSET, BUFSET; neue `sim.cfg`, Harness mit Szenen-/Ergebnisdatei, `run_sim.py`-Gerüst; VICE-Rauchtest mit `BOOT` v3: INIT über den Stub, danach `VMW`/`RXV` funktionieren, Interrupts laufen (Jiffy-Uhr zählt während eines langen Aufrufs weiter), Bank 0 `$1C00–$3FFF` unverändert (Prüfsumme); Blitz!-Variablenlage in Bank 1 ermitteln (Abschnitt 12) | Build fehlerfrei, Größen aus der Map; sim: INIT/BUFSET/POOLSET-Ergebnisse; VICE-Rauchtest grün (interpretiert und Blitz!), Portregel | Sonnet |
| **P6b** Python-Referenz | `tools/dbeview.py` (9.1): erst Wände, Bänder, Kacheln, Tapete, Überlauf; Sprites, sobald P5b fertig ist; `test/tools/test_dbeview.py` | Pixelprüfung grün für alle demo-, abgrund- und zufall-Szenen; kein Byte außerhalb des Fensters; Überlaufregeln; Unklarheiten der Spezifikation als Liste an Opus | Sonnet (Review Opus) |
| **P6c** Karte und Assets | MAPINIT, SETPOS, CELL, SETCELL, SETITEM, GEOMSET (Zeilentabelle, origin, Löschen bei ID-Wechsel), TEXSET, BGSET, SPRITESET, ITEMSET mit allen Prüfungen 3.2 | sim: Rückgaben und gespeicherte Werte (über einen SIM-Dump der BSS) gegen das Python-Modell; Fehlerfälle 9.3 | Sonnet |
| **P6d** VIEW ohne Objekte | Abschnitte 5.1–5.7, 5.9 (Bänder mit Rand), 5.10, 5.11 | sim65 bytegleich mit `dbeview` für demo, abgrund, zufall (ohne Objekte), überlauf; Zyklen als Befund | Opus |
| **P6e** Objekte | 5.8, `clip_image` in 6502 (Kerne, VMS mit Typ 3, Probelauf), OBJVIS, Gegenstände, ITEMPH | sim65 bytegleich für alle Szenen 9.3 inkl. rand; Zyklen je Objekt | Opus |
| **P6f** MOVE, Automap, Zyklen | MOVE (3.4), Automap-Bit 6 (Zellen mit angenommenem Wand- oder Kachel-Eintrag bzw. nicht ganz verdecktem Boden-Element, nur mit MAPINIT X Bit 0 und Arbeitskopie), Profil, Optimierung der teuersten Abschnitte | sim: MOVE-Tabelle aller Fälle; Zyklen gegen Abschnitt 8 (Bericht); Lib-Größe | Sonnet; Messläufe Haiku |
| **P6g** VICE-Szenen | `test/vice_view.py` (9.4), 30 Szenen aus demo/abgrund/rand, interpretiert und kompiliert | VRAM-Fenster = Python, VCL = sim65, Zeiten im Bericht; keine festen Wartezeiten | Sonnet (Skript), Haiku (Läufe) |
| **P6h** Doku | `docs/formats.md`: Funktionstabelle, Parameterblock, Speicherkarte, S2-Verweis; Standard-Ladeadressen der Werkzeuge (2.4) mit Tests nachziehen; DVG-Flag Bit 3 in `dbegeom` | Tests der Werkzeuge grün, Beispiele neu erzeugt | Sonnet |

Reihenfolge: P5b ∥ P6a ∥ P6b (Wände); P6c nach P6a; P6d nach P6b (Wände) und P6c; P6e nach P5b und P6d; P6f, P6g nach P6e; P6h jederzeit nach P6c (die Werkzeugänderungen DVG-Bit 3 und Ladeadressen vor P6d, weil sie Testdaten ändern). P7 nach P6g.

## 11. Änderungen an anderen Spezifikationen (umsetzen in P6h bzw. P5b)

| Wo | Änderung | Grund |
|---|---|---|
| P3 (`dbegeom`) | DVG-Flag Bit 3 „Bandabdeckung“ für Fronten (5.1); Standard `load` `$E800` | 5.2, Speicherkarte |
| P4 (`dbemap`, `crawlmap`) | Standard-Ladeadresse `$4000` (P6h; Karte F: `$5000`) | Speicherkarte |
| P5 (`dbetex`) | `max_kerns` 0 … 4 (`dbespr` bis 16); `vms_buffer` → Prüfung „VCL + VMS je Bild gegen den gemeinsamen Puffer 2304“; Standard `load` Wand `$8000`, Boden `$EE00`, Decke `$F600`, DBG `$FB00` (P6h; Karte F: `$9000`, `$F000`, `$F800`, `$FE00`, nach P6g `$EE00`, `$F600`, `$FB00`); `sim_vms` Typ 3 (P5b) | review-notes G.1–G.3 |
| P5 4.4/4.6 | Formatregel VMS-Listen (Zeilenreihenfolge, steigender ofs, Lauf in einer Zeile) ausdrücklich | Beschneiden, G.7 |
| `engine-design.md` | Funktionstabelle, Speicher 3.1 → Verweis auf P6 (P8) | – |

## 12. Offene Punkte

1. **Blitz!-Variablen in Bank 1 – geprüft in P6a, Ergebnis: Karte F bleibt** (P6h: `MEMSIZ` jetzt `$4000`, `POKE 58,64`, 15 KB für Variablen; das Ergebnis gilt gleich, `test/vice_blitzvars.py` und die Rauchtests nutzen `$4000`). Messung mit `test/vice_blitzvars.py` (VICE, Haltepunkte an zwei `SYS`-Marken; Bank 1 `$5000–$FEFF` vorher mit `$A5` gefüllt, danach auf Änderungen geprüft; Zeiger `$2D–$3A` gelesen), Programme „passt“ (Felder 3 KB, 61 Strings, Müllsammlung) und „Stress“ (Strings bis `OUT OF MEMORY`), je interpretiert und als Blitz!-Kompilat (Image 2, über `BOOT`):
   - Variablen, Felder und Strings liegen **nur in Bank 1** (BASIC 7: Variablenbereich ab `VARTAB` = `$0400`, Felder dahinter, Strings von `MEMSIZ` (`$39/$3A`) nach unten). Das Kompilat verhält sich gleich; die ersten geänderten Bytes liegen bei `$0402` (Skalare der Runtime, 7-Byte-Plätze laut Blitz!-Analyse), Felder dahinter.
   - **Vorgabe ohne Begrenzung:** `MEMSIZ` = `$FF00` (interpretiert) bzw. **`$FC00` (Blitz!)**; die Strings wachsen von dort nach unten (im Test bis `$5A84`, im Stresstest bis ins Variablengebiet). Ohne Begrenzung belegen Strings also Bank 1 `$5000–$FBFF`, genau dort, wo Karte F die Spieldaten ablegt.
   - **Die Blitz!-Runtime respektiert `$39/$3A`:** `POKE 57,0:POKE 58,80:CLR` als **erste Anweisung** (vor jeder Variablenbenutzung; `CLR` löscht alle Variablen) setzt `MEMSIZ` und `FRETOP` auf `$5000`. Mit Begrenzung blieb Bank 1 `$5000–$FEFF` in allen Läufen **unverändert (0 Byte)**, auch im Stresstest, der mit `?OUT OF MEMORY` (Fehler 16) endete, wenn Felder und Strings die 19 KB `$0400–$4FFF` füllten (interpretiert und kompiliert gleich). Obergrenze der Strings = `$4FFF`.
   - Folge: Das Spiel beginnt mit `POKE 57,0:POKE 58,80:CLR` (in `crawl.bas` und jedem Testprogramm, ebenso im kompilierten Programm; Zeile 10 der Tests), dann liegen alle Variablen in `$0400–$4FFF`. Mit dem Stub (8 KB gemeinsam) sind `$0400–$1FFF` von Bank 1 während des Aufrufs nicht sichtbar, die Lib berührt sie nicht (nicht eigens getestet; die Lib schreibt nur in den Bereich `$0C00–$1BFF`, den Bank 0 und die Sicht der Lib teilen, und der Rauchtest prüft Bank 0 `$1C00–$3FFF`).
   - Ein Watchpoint auf Bank-1-Adressen war nicht nötig: Das Füllmuster zeigt jede Änderung, unabhängig vom Befehl, der sie schreibt.
2. **Residente VMS-Listen** (TEXSET/SPRITESET kopieren die Listen einmal in einen Bank-0-Bereich über dem Programm; `VIEW` verweist nur noch darauf, außer bei beschnittenen Listen): spart je Bild das Kopieren und entschärft den Puffer bei Gittern. Nicht in P6; Entscheidung nach den Messungen aus P6f/P6g.
3. **Ladepuffer des Spiels** in Bank 0 für VRL (Plan 3 „Zu prüfen“): P7.

## 12a. Festlegungen der Referenz `dbeview.py` (P6b)

Beim Schreiben der Referenz entschieden; die 6502-Fassung folgt der Referenz:

1. **X** (Ergebnis von `VIEW`) = Zahl der VCL-Einträge **ohne** das Ende-Byte (höchstens 255).
2. **Leere Sprite-Einträge:** Bleibt nach dem Beschneiden weder Kern noch Rand übrig (z. B. nur transparente Bytes im Ausschnitt), wird nichts angehängt und OBJVIS nicht gesetzt.
3. **Boden-/Deckenkacheln:** Die Maske schließt die Randpixel ein, benachbarte Trapeze überlappen sich an ihrer Kante. Bei verschiedenen Bildern entscheidet die Malreihenfolge: außen → innen (= umgekehrte DVG-Reihenfolge, so malt die Ausgabe von 5.6 Schritt 5).
4. **DVG-Bit 3** setzt `dbegeom` seit P6h (vorher: nie); die Referenz und ihre Tests behandeln beide Fälle (Bit fehlt: Fronten tragen `bcov` erst am Tiefenende ein, Pixel gleich).
5. **VMS Typ 2** (nicht von der Engine erzeugt) nimmt den Zeilenschritt aus VDC-Register 1; `run_vcl` hat dafür den Parameter `rowstep` (80).
6. **`clip_image`:** Der Zeilenabstand der VMS-Offsets (Stride) ist ein zusätzlicher Parameter (P5b 6 nennt ihn nicht; `dbespr.clip_image(…, stride)` und `dbeview.clip_image(img, stride, …)` liefern dieselben Werte, im Test geprüft).
7. **Puffer:** Szenen mit Kachelbildern, deren Bytes fast alle Rand sind (Muster mit Löchern in jedem Byte, z. B. 18 Kacheln Boden + 18 Decke), brauchen über 6 KB VMS; die 2 304 Byte reichen dort nicht (A = 2). Das ist ein Budgetfall für Spiele (`dbeview budget`), kein Fehler der Referenz.
8. **Pixelgleichheit gilt nur für A = 0** und Sprites, die nicht höher sind als ihre Wand und mit der Fußzeile am unteren Bildrand stehen (5.4).

## Entscheidungen des Nutzers (2026-11-25)

1. BASIC-Variablen in Bank 1 auf `$0400–$4FFF` begrenzen (ca. 19 KB reichen). P6a prüft, wo ein Blitz!-Kompilat seine Variablen ablegt, und setzt die String-Obergrenze.
2. WALLSET/SPRITESET v1 entfallen ohne Kompatibilitätspfad; Crawl kommt in P7 per Konverter.
3. MOVE, CELL und Automap-Bit bleiben in P6 (P6f).
4. Neues Kachel-Flag „Inhalt zeichnen“ in DMP (P4 erweitern): Wandzellen mit diesem Flag (Tür, Gitter, Bogen) zeichnen Seitenfläche, dann ihre Objekte nach Unterposition, dann die Front. Betrifft P4 (Flag-Bit festlegen, dbemap), P6d/P6e (VIEW) und dbeview.
5. VMS-Listen fest in Bank 0 statt Kopie je Bild: nach den Messungen entscheiden.

## Ergebnis P6a (2026-11-25)

Umgesetzt: Stub mit `RCR_LIB = $06`, `LIB = $B000`, `lib.cfg` (Code `$B000` 8 KB, `LIBBSS` `$E000` 2 KB), `dbe.inc` (2.2/2.3, 3.1), Dispatcher mit Tabelle 3 (F ≥ 17 und alle noch nicht umgesetzten F: `E_NOTIMPL`), `INIT`, `POOLSET`, `BUFSET`; sim65-Harness (`test/sim/viewsim.c`, `sim.cfg`, `run_sim.py`); VICE-Rauchtest (`test/vice_smoke.py`, `test/vice/smoke.bas`); Blitz!-Messung (`test/vice_blitzvars.py`). `VERSION` = 0.2 (Dateien `dbe0.2.stub`, `dbe0.2.lib`).

Größen (`build/*.map`): Lib-Code 322 Byte (`$B000–$B141`), Lib-Variablen 11 Byte, Stub 132 Byte. Die Schätzung 2.6 (≈ 5,1 KB Code) bleibt unberührt, die 8 KB sind reichlich.

Festlegungen, die die Spezifikation offen ließ:
- `INIT` löscht zusätzlich `ITEMPH`…`OBJVIS` (`$0C08–$0C11`) und setzt `VCLADR` = `$1300`.
- `POOLSET`: Poolanfang ≥ Poolende (Ende ≠ 0) gibt `E_RANGE` (6) und lässt den alten Pool stehen (3 nennt nur A = 0).
- Die Lib hat im Normalbuild keine Testfunktionen; `build.sh` baut zusätzlich `dbe0.2-test.lib` mit `-DDBE_TEST`: F = 250 (liefert `$D506 AND $0F`, `$FF00`, ein Byte aus `$1300`, schreibt `$A5` nach `$1301`) und F = 251 (Warteschleife, P0 × etwa 1300 Zyklen). Nur für den Rauchtest.
- Der Rauchtest prüft: `$D506` = x6 und `$FF00 = $7E` im Aufruf, Lesen und Schreiben von Bank 0 bis `$1FFF` aus der Lib, Jiffy-Uhr zählt in einem Aufruf von etwa 1 Mio. Zyklen weiter (30–120 Jiffies), Prüfsumme Bank 0 `$1C00–$3FFF` unverändert, `BUFSET` über den Stub, danach `VMW`, `VMD`, `RXV` (interpretiert und Blitz! Image 2).

## Ergebnis P6c (2026-11-25)

Umgesetzt in `engine/lib.s`: `MAPINIT`, `SETPOS`, `CELL`, `SETCELL`, `SETITEM`, `ITEMSET`, `GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET` mit den Prüfungen aus 3.2. Lib-Code gesamt 2174 Byte (P6a: 322), BSS 512 Byte (`$E000–$E1FF`). Code je Funktion (Byte, einschließlich eigener Verzweigungen): `MAPINIT` 419, `SETPOS` 49, `CELL` 75, `SETCELL`/`SETITEM` 59, `ITEMSET` 29, `GEOMSET` 356, `TEXSET` 121, `BGSET` 107, `SPRITESET` 178; gemeinsame Hilfen (Kopfprüfung, Pool, Satz füllen, Zellzeiger, Kachel-Flags, px/py) etwa 500; Prüftabellen 68. Zyklen (reine Funktion, ohne Harness-Aufwand geschätzt): `MAPINIT` etwa 1 000 (7 × 5; Kopie je Byte etwa 16), `GEOMSET` etwa 5 500, `TEXSET` etwa 300; Ziel 8 (≤ 20 000) erfüllt.

Festlegungen, die die Spezifikation offen ließ:
- Fehlerreihenfolge: `E_STATE` (Karte bzw. Geometrie fehlt), `E_RANGE` (Satz-/Artnummer, Zelle), `E_FORMAT` (Magic, Version, feste Längen, Art ≠ X, NST = 0, NA ∉ 1…4, NP = 0), `E_GEOM` (ID, NE, D, Stride, VW, VH), `E_RANGE` (Pool). **Art-Byte ≠ X ist `E_FORMAT`** (3.1 ordnet es nicht zu).
- `MAPINIT` setzt `map_ok` zuerst auf 0: nach einem Fehler (A = 1) liefern `CELL`/`SETPOS`/… `E_STATE`. Zusätzlich zu 3 geprüft: Startzelle < W·H, Richtung ≤ 3, Außenkachel < NT, Offsets lückenlos (24, +W·H, +W·H, +8·NT, +4·NE) und Gesamtlänge ohne 16-Bit-Überlauf. Rückgabe: X = W, Y = H, P0 = Startzelle, P1 = Startrichtung; X Bit 0 wird als `map_auto` gespeichert.
- Arbeitskopie: P1 ≠ 0 kopiert beide Ebenen (2·W·H Byte). Ohne Kopie schreiben `SETCELL`/`SETITEM` **in die DMP selbst**.
- `SETPOS`: Richtung > 3 gibt `E_RANGE` (Position unverändert). `CELL` außerhalb: A = 6, X = Außenkachel, Y = 0, **P1 = Flags der Außenkachel**.
- `GEOMSET`: zusätzlich VW ≥ 1 und VH ≥ 1 (sonst `E_FORMAT`; VH = 0 würde die Zeilentabelle zerstören). Löschen bei anderer ID: alle DTS und die DBG; S2-Sätze mit ID ≠ 0 bei anderer ID, S2-Sätze mit ID 0 nur bei anderem D oder Stride. Rückgabe X = Bits der gelöschten S2-Sätze, Y = Bits 0–2 DTS, Bit 3 DBG. Bei A = 1 bleibt der Zustand unverändert.
- Gespeichert (3.2): je DTS/S2-Satz 16 Byte (`recs`): gültig, VRAM-Basis, NS/NA, NST/NP, ID (S2), Inhaltsanfang, drei absolute Tabellenadressen (DTS: Slotkarte, Stiltabelle, Verzeichnis; S2: Indextabelle, Verzeichnis, Kerntabelle). Kerne und VMS-Listen braucht `VIEW` nicht als Tabellenadresse: die Verzeichniseinträge enthalten inhaltsrelative Offsets (Inhaltsanfang + Offset); `angle_map` (S2-Kopf 12–15) liest `VIEW` über Inhaltsanfang + festen Kopfversatz. Abweichung von 3.2 („liest nie Kopf-Offsets“): nur feste Kopffelder, keine Offsetwörter. DBG: Basis, VRAM-Basis, P, y0, h, Flags; `o_v` und Füllbytes über die Basis. Karte: absolute Adressen von Kachelebene, Inhaltsebene, Kacheltabelle, Ereignissen; DVG: Tiefen- und Elementtabelle, Zeilentabelle (200 Byte).
- `BGSET` speichert X immer als Füllbyte (auch mit DBG); `P0 = 0` und `TEXSET`/`SPRITESET` mit `P0 = 0` löschen auch ohne `GEOMSET` (A = 0).
- Test: `test/sim/run_sim.py` (P6c sim A: Geometrie und Assets mit den Demo-Daten, Fehler- und Pool-Fälle, ID-Wechsel; B: Karte `demo.toml` mit/ohne Arbeitskopie; C: Karten 128 × 128, 255 × 64, 1 × 255, 255 × 1 mit NT = 256 usw.). Vergleich der BSS-Werte gegen aus den Dateien berechnete Erwartungen.

## Ergebnis P6d (2026-11-25)

Umgesetzt: `VIEW` ohne Objekte in `engine/view.s` (eingebunden von `lib.s`): Abschnitte 5.1–5.7, 5.9 (Bänder mit Rand über `clip_image`: Kerne und VMS-Liste mit Typ 3, Probelauf für die Größe), 5.10, 5.11. Objektplätze rufen `objekte` auf (P6e, noch leer); `clip_image` ist allgemein (Bildlage x0/y0, Ausschnitt L/R/T/B, T·stride) und für Sprites wiederverwendbar.

Aufbau: Sichtdurchlauf vorne → hinten; jeder Eintrag kommt mit seinen Parametern in die Sichtliste (8 Felder × 96, je ein Array). Seine Größe liefert derselbe Erzeuger wie die Ausgabe im Zählmodus (keine getrennte Größenrechnung, damit nv/nm immer zur Ausgabe passen). STOP setzt den Stapelzeiger zurück und springt in die Ausgabe. Zellen werden je Tiefe einmal berechnet (feste Achse je Tiefe, Seitenachse je Zelle); Boden/Decke/blocked je Zelle und das Boden-/Deckenelement je Zelle merkt sich der Zellendurchlauf, `baender` läuft über Zellen (Fallback: alle Elemente, wenn eine Zelle zwei Boden- oder Deckenelemente hat). `spans(bcov)` wird zwischengespeichert, bis `bcov` sich ändert. Blockkopie der VMS-Listen mit selbstmodifizierendem Code (`vcopy`).

Umsetzung der Entscheidungen aus dem P6c-Review:
1. `TEXSET` legt je Stil die Adresse der Stilzeile ab (`sty_lo/hi[Art · 32 + st]`); `resolve` rechnet kein st · NS. Dafür neu geprüft: NST ≤ 32 (sonst A = 1).
2. S2-Satz: `recs+14` = NA · D (für den Index (f · NA + ai) · D + d − 1 in P6e), `recs+15` = 0; die Kerntabellenadresse entfällt.
3. `MAPINIT`: Arbeitskopie nur in `$4000 ≤ P1` und `P1 + 2·W·H ≤ $B000` (ohne 16-Bit-Überlauf), sonst A = 6 und keine gültige Karte (wie bei A = 1). Test: genau unter `$B000` ok; ein Byte darüber, ab `$B000`, BSS, DVG, I/O, unter `$4000`, `$2000`, `$0400`, Überlauf: A = 6 und danach `CELL` A = 5. Die untere Grenze `$4000` ist im sim65-Harness nicht positiv testbar (dort liegt das Programm).
4. Synthetische DVG mit zwei Fronten je Zelle: `dbeview.double_fronts(assets)` (jede Front der Tiefen ≥ 1 doppelt, um −1/+1/0 Spalten verschoben, abwechselnd direkt dahinter oder hinter der Seite: F, S, F′ prüft die INHALT-Reihenfolge) und `dbeview.dvg_bytes(dvg)`; `test_dbeview.TestDoubleFronts` (Pixel demo × 4 Richtungen × Bit 3, Zufall) und sim-Vergleich (Abschnitt „zwei Fronten“).

Weitere Festlegungen:
- `GEOMSET` prüft zusätzlich S ≤ 15 (Zellentabelle je Tiefe, 31 Einträge), `BGSET` P ≥ 1 (sonst Endlosschleife bei q mod P); beide A = 1.
- Wartebereich (pend) 16 Einträge je Tiefe; mehr gibt A = 2 („Tabellen voll“). Die Referenz kennt keine Grenze; in allen Testszenen nicht erreicht.
- Die Lib-BSS beginnt mit `bss_start` vor allen Variablen (auch denen von `view.s`); `argx` ist exportiert (Tests).

Test (`test/sim/run_sim.py`, `test_p6d`): je Ansicht A, X, Y, P0, VCLADR/VCLLEN/VMSLEN/OBJVIS und der Puffer (VCL + VMS) bytegleich mit `dbeview.view`. Sätze: demo (alle freien Zellen × 4 Richtungen × Bit 3 aus/an, ohne DBG mit Füllbyte, ap `$0123`/`$E200`/`$F800` (Fenster über 65535), origin 123), abgrund, Gang, zufall (Standard 60 Karten × 6 Ansichten, `DBEVIEW_FULL=1` 200 × 20; INHALT, Lücken, blockierte Zellen, Außenkachel, Bit 3 und DBG zufällig, ap ≠ 0, Puffer 2304 bzw. 3840 Byte), überlauf (BUFSET 64 … 1024 Byte: A = 2 und A = 3), zwei Fronten. Ergebnis: 1302 Ansichten (voll: 4942) bytegleich, davon A = 2: 270 (873), A = 3: 20 (69). P6a/P6c weiter grün. Zyklen: Differenz zweier Läufe (VIEW gegen F = 7, neuer stiller Aufrufsatz 4 im Harness).

Größen: Lib-Code 7 960 Byte (`$B000–$CF17`, davon VIEW etwa 5,6 KB), BSS 1 993 Byte (`$E000–$E7C8`). **Befund:** Es bleiben 232 Byte Code und 55 Byte BSS – zu wenig für P6e (Objekte, Sprite-Einträge mit x0/y0/Ausschnitt). Die Schätzung 2.6 (VIEW ≈ 3 KB) ist überschritten, vor allem weil alle Variablen absolut adressiert werden (Zeropage nur `$FA–$FD`).

Zyklen je VIEW (sim65, Demo-Assets 140 × 96, D = 3):

| Satz | n | min | Mittel | max | Ziel 8 |
|---|---|---|---|---|---|
| Gang, deckend, einheitliche Bänder | 60 | 29 959 | 90 696 | 106 247 | Mittel ≤ 30 000, max ≤ 45 000 |
| demo | 56 | 29 927 | 68 655 | 111 364 | – |
| zufall (offen, gemischt, Tapete) | 40 | 70 645 | 106 719 | 143 610 | max ≤ 80 000 |
| zwei Fronten | 28 | 34 950 | 75 829 | 127 974 | – |

**Befund:** Ziele verfehlt (Faktor etwa 3 bzw. 1,8). Profil (Gang): Zellendurchlauf und Zellen etwa 16 000, Erzeuger-Vorlauf (Verzeichniseintrag lesen, zweimal je Eintrag) 7 900, VMS-Kopie 5 300, `baender` 4 800, `spans` 3 900, `add` 3 600, `resolve` 3 200. Die Kosten verteilen sich breit (Schleifen über alle Elemente der Tiefe, absolute Adressierung, 16-Bit-Zeigerarithmetik), kein einzelner Engpass. Vorschläge für P6f: mehr Zeropage während `VIEW` (retten/zurückschreiben), vorberechnete Element-/Zellentabellen je Tiefe bei `GEOMSET`, Erzeugerwerte je Eintrag aus dem Zähllauf aufheben, Spannen inkrementell.


## Entscheidungen nach dem P6d-Review (2026-11-25)

Nutzer:
1. Lib-Code bis `$DFFF`: der Stub schaltet während des Aufrufs `$FF00 = $7F` (Bank 1 ohne I/O); die Lib greift nicht auf I/O zu.
2. VMS-Listen werden nicht mehr je Bild nach Bank 0 kopiert: VDC-BASIC v3 bekommt eine Bank-1-Quelle für VMS-Listen (VCL-Typ 12 / VMS). Zyklenziele bleiben 30k/45k/80k.
3. Zeropage-Block (z. B. `$63–$72`) während `VIEW`, im Stub gerettet und zurückgeschrieben – erst nach Nachweis in VICE (interpretiert und Blitz!, mit IRQ).

Hauptagent (technisch):
4. VCL-Liste nicht mehr fest bei B0, sondern an einer Adresse, die `VIEW` in P0 zurückgibt (`::VCL` mit diesem Wert).
5. `$0B00`/`$0E00` als Reserve der Engine.
6. `BUFSET` auf erlaubte Fenster beschränken (nicht unter `$1300`, nicht über `$1BFF`), `GEOMSET` prüft die Elementtabelle (Zellen zusammenhängend, Grenzen für Wartebereich und Masken) → `E_FORMAT`.

## Ergebnis P6d-opt (2026-11-25)

Umgesetzt nach `P6d-review.md` und den Entscheidungen oben. Bytegleich mit `dbeview.view` in allen Sätzen (`run_sim.py`: 1322 Ansichten Standard, 1302 mit `VMS_BANK1`; `DBEVIEW_FULL=1`: 4962 bzw. 4942), `test_dbeview.py` grün (auch voll), VICE-Rauchtest und `test/vice_zp.py` grün (interpretiert und Blitz! Image 2).

### Maßnahmen und Zyklen (sim65, Mittel/max je Ansicht; ohne Stub, der Stub kostet zusätzlich etwa 450 Zyklen)

| Schritt | Gang Mittel | Gang max | zufall max | mit `VMS_BANK1` (vorläufig, 6a): Gang Mittel / max / zufall max |
|---|---|---|---|---|
| P6d (Ausgang) | 90 696 | 106 247 | 143 610 | – |
| 1 Stub `$FF00 = $7F`, Code bis `$DBFF`, LIBTAB | 90 696 | 106 247 | 143 610 | – |
| 2 Zellentabelle (GEOMSET), nur Wände, allcov vor resolve, `rtab` | 76 163 | 89 833 | 128 326 | – |
| 3 Einpass (VCL abwärts, VMS aufwärts, Rücknahme bei Überlauf) | 58 654 | 69 791 | 101 343 | 50 242 / 56 403 / 76 100 |
| 4 Band-Entscheidung im Zellendurchlauf | 52 857 | 64 415 | 95 989 | 44 452 / 51 039 / 68 795 |
| 5 Zeropage-Block, Intervall-Masken, Kacheltabellen (MAPINIT), direkte Kern-/Zeilenausgabe, `bgoffs` bei BGSET | **41 446** | **52 087** | **83 671** | **33 017 / 38 679 / 54 874** |
| Ziel (Abschnitt 8) | 30 000 | 45 000 | 80 000 | |

Bewertung (Werte mit `VMS_BANK1` vorläufig, nur Engine-Zyklen, 6a): Mit `VMS_BANK1` (VDC-BASIC-Typ 9) sind Gang max und zufall max erfüllt, Gang Mittel liegt 10 % darüber. Ohne Bank-1-Listen kostet allein die Kopie im Gang etwa 8 400 Zyklen (432 VMS-Bytes je Ansicht im Mittel). Der VICE-Nachweis für den Zeropage-Block wurde vor Schritt 2 geführt; die Schritte 2–4 benutzen deshalb schon die Zeiger im Block, Schritt 5 die Einzelwerte.

### Festlegungen

- **Stub/Speicher:** `$FF00 = $7F`; Lib-Code `$B000–$DBFF` (11 KB), LIBTAB `$DC00–$DFFF` (Zellentabelle, Kachelzusammenfassung; INIT löscht sie nicht), BSS `$E000–$E7FF`. Testbuild `lib-test.cfg` (bis `$DBFF` aufgefüllt, Funktion 252 bei `$DB80` prüft Code unter I/O). Funktion 250 schaltet für `$D506` kurz `$7E`.
- **Zeropage-Block `$63–$72`:** Der Stub rettet ihn bei jedem Aufruf (alle Funktionen) und schreibt ihn zurück. Nachweis `test/vice_zp.py`: 20 lange Aufrufe (Funktion 253 füllt den Block, wartet etwa 330 000 Zyklen, prüft ihn) unter Jiffy/Tastatur, SOUND mit Sweep und MOVSPR; Watchpoint (Lesen/Schreiben) auf `$63–$72` nur zwischen `JSR LIB` und Rückkehr: 640 Treffer, alle aus der Lib (`$FF00 = $7F`), **0 fremde**; danach SIN, STR$, VAL, Division richtig; Gegenprobe `--control` (Watchpoint auf `$A0–$A2`) findet die Kernal-IRQ-Zugriffe. NMI wurde nicht geprüft.
- **GEOMSET** prüft die Elementtabelle (7) in einem Durchlauf und legt dabei die Zellentabelle an (je Zelle s, erstes Element, Slot, Wandliste, Boden-/Deckenplatz). Fehler in der Elementtabelle: A = 1 und **keine gültige Geometrie** (`geom_ok = 0`; Kopf-Fehler lassen den Zustand wie bisher unverändert). Objektplätze stehen nicht in der Tabelle (P6e ergänzt sie). `dbeview.parse_dvg` prüft dasselbe (`check_elems`).
- **BUFSET:** Fenster `$1300–$1BFF`; `BIGBUF` der Tests ist damit der Standardpuffer.
- **Einpass/VCLADR:** P0 = VCLADR = B1 − VCLLEN; VMS ab B0. Harness `viewsim.c` liefert VCL ab VCLADR, dann VMS ab B0 (`dbe_b0`). Referenz: `Result.b0`, `bank0()`, `bank1()`, `lists1`.
- **MAXITEM** bleibt als Zähler; Test mit `-D MAXITEM_T=8` (eigener sim-Build) gegen die Referenz mit `MAXITEM = 8`.
- **Masken** als sortierte Intervalllisten (höchstens 41 je Maske), kein Löschen je VIEW. `spans` aus den Lücken der bcov-Liste.
- **Kacheln:** MAPINIT legt `tpl/tph` (Adresse) und `tsm` (Flächen, blocked, Flags) je Kachel an (768 Byte; MAPINIT demo 2 100 Zyklen, bei NT = 256 etwa 20 000).
- **sim65-Harness:** Stack `$200` (Programm sonst zu groß); Reserve nur noch 81 Byte (MAIN endet bei `$4DAE`, Grenze `$4E00`) → vor P6e Lib-Code im Harness an `$B000` legen.

### Größen

Lib-Code 8 935 Byte (`$B000–$D2E6`, P6d: 7 960), LIBTAB 764 Byte, BSS 1 799 Byte (P6d: 1 993; Sichtliste −672, Kachelzeiger +512), Stub 168 Byte. Reserve: Code 2,3 KB, BSS 249 Byte, LIBTAB 260 Byte.

### Offene Punkte

1. Gang Mittel mit `VMS_BANK1` 33 000 statt 30 000. Kandidaten: ZEILEN-Gruppen bei TEXSET vorberechnen (~1 000), `resolve` für Wände cachen (~800), `gsetup`/`itemadd` schlanker (~800).
2. GEOMSET 24 400 Zyklen (demo, Ziel 20 000; einmalig).
3. VDC-BASIC Typ 9 (6a) umsetzen, danach `VMS_BANK1` zum Standard machen und in VICE (P6g) messen.
4. P6e: Objektplätze in die Zellentabelle, Objekte im Zellendurchlauf (Intervallmaske für „erste/letzte freie Spalte“).

## Ergebnis P6e (2026-11-25)

Umgesetzt: Objekte und Gegenstände in `VIEW` (5.8) in `engine/view.s`, bytegleich mit `dbeview.view` (keine Änderung an `tools/dbeview.py` nötig).

### Umsetzung

- **sim-Harness:** Lib-Code im Harness an `$B000` (Segment `LIBCODE`, `.define LIBSEG` in `lib.s` unter `SIM`); `sim.cfg`: Harness `$2000–$2BFF`, Stack bis `$2DFF`, Daten `$2E00–$AFFF`, die Datei ist zusammenhängend bis `$DBFF`. Ladeadressen der Tests: DTS Wand `$6000`, Boden `$8300`, Decke `$F000`, S2 ab `$3000` (zusätzliche Sätze ab `$A700`), große Karten (P6c C) `$2E00`. `viewsim.c` weist Segmente in Harness und Lib-Code ab. sim65 läuft mit Wächter-Timeout (300 s).
- **Zellentabelle (GEOMSET):** `k_ob`/`k_oe` = 16 · Platz des ersten/letzten Objektplatzes der Zelle (`$FF` keiner). Mehrere Objektplätze je Zelle sind erlaubt (wie die Referenz).
- **Zellendurchlauf:** Zellen ohne Flächen → Objekte; Flächen mit INHALT → Fronten, Objekte, Seiten (5.2a); sonst nur Wände. `objd` (d ≥ 1 und Objekte bzw. Gegenstände möglich) schaltet den Objektteil je Tiefe ab, ohne Objekte kostet er nichts.
- **Kandidaten:** Am Anfang von `VIEW` die Liste der sichtbaren Objekte (Bit 6 = 0, min(OBJN, 16)) mit Zellindex, i, 6 i und ein 256-Bit-Feld `obm` der Low-Bytes der Zellindizes (Vorfilter je Zelle; nur die Bits des vorigen `VIEW` werden gelöscht). Gegenstand aus der Inhaltsebene nur, wenn `itemn` > 0 (Anzahl der `itemtab`-Einträge ≠ 0, von `ITEMSET` geführt). Malreihenfolge ohne Sortieren: p = 4 … 0, je p die Kandidaten rückwärts (Objekte i absteigend, zuletzt der Gegenstand).
- **Bild:** `lookup` nach P5b 6.3 (f ≥ NP → 0, `angle_map`, `$FF` → Phase 0, `$FE` → nichts), Anker x0/y0 16 Bit vorzeichenrichtig, Fenster- und `cover`-Ausschnitt (erste/letzte freie Spalte aus der Intervallliste, `ffree`; seit P6i entfallen: nur Fenster, `allcov_c` verwirft ganz verdeckte Sprites).
- **Erzeuger `gspr`:** Kerne mit `clipkerns`; Rand unbeschnitten als Kopie in den Puffer (Typ 12, **auch mit `VMS_BANK1`**, wie die Referenz), nur Zeilen beschnitten (L = 0, R = w) über einen schnellen Weg ohne Spaltenrechnung (sichtbar genau T · stride ≤ ofs < B · stride), sonst `clipvms_e`. `clipvms_e` liest Länge und Quelle aus `g_vlen`/`g_rsrc` (DTS und S2 haben verschiedene Verzeichnisse).
- **Leere Sprite-Einträge** (weder Kern noch Randbefehl im Ausschnitt) sind keine Einträge: sie zählen nicht für MAXITEM (auch nicht bei voller Eintragszahl: dann Zählprobe) und setzen kein OBJVIS-Bit (12a.2). OBJVIS-Bit i bei Annahme, auch „ohne Rand“; nicht bei „verworfen“.
- **K6:** Zeilenzähler in `clipvms_e` endet bei r = B (läuft nicht über). VMS-Kopie vierfach entrollt (14 statt 17 Zyklen je Byte, wirkt auch für Wände).
- **VMS_BANK1** bleibt Build-Schalter; `TEXSET` weist dort DTS unter `$4000` ab (P2d, 6a). *(Überholt durch den Review-Nachtrag unten.)*

### Test (`test/sim/run_sim.py`, `test_p6e`; GEOMSET-Grenzfälle in `test_geomcheck`)

Bytegleich (A, X, Y, P0, VCLADR/VCLLEN/VMSLEN/**OBJVIS**, Puffer) in allen Sätzen: demo mit 0/1/5 Objekten (alle freien Zellen × 4 Richtungen, Gegenstände, ITEMPH), rand (Sätze blob, wache, breit und drei Zusatzsätze „hoch“ (oben hinaus), „links“, „rechts“; s = −2 … 2, d = 1 … 3, alle q), rand hinter deckenden Wänden, INHALT (Türen/Gitter deckend und nicht, Objekte und Gegenstände darauf), zufall mit 0–16 Objekten (Bit 6/7, unbekannte Sätze, OBJN = 20), überlauf (64 … 1024 Byte, A = 2 und 3), MAXITEM = 8. Standard: 1 600 Ansichten (mit `VMS_BANK1` 1 570), `DBEVIEW_FULL=1`: 5 240 (5 210), davon A = 2: 1 577, A = 3: 60; P6d voll 4 962 (4 942). P6a, P6c, P6d unverändert grün.

GEOMSET (neu): 16 Elemente in einer Zelle ok / 17 A = 1, 48 Zellen ok / 49 A = 1, 96 Wände ok / 97 A = 1, zwei Deckenelemente A = 1, `VIEW` nach fehlgeschlagenem GEOMSET A = 5 (danach mit gültigem GEOMSET wieder 0); `parse_dvg` gleich.

### Zyklen (sim65, Demo-Assets, ohne Stub)

| Satz | Mittel | max |
|---|---|---|
| Gang ohne Objekte (P6d-Satz) | 40 439 (P6d-opt 41 446) | 50 280 |
| Gang ohne Objekte, `VMS_BANK1` | 33 380 (33 017) | 39 066 |
| demo mit 1 / 5 Objekten | 33 782 / 37 595 | 68 125 / 95 147 |
| zufall mit 0–16 Objekten | 82 224 | 136 168 |

Je Objekt (offener Raum, Differenz zur Ansicht ohne Objekte, enthält den Objektteil aller Zellen ≈ 2 700):

| Fall | Zyklen | Ziel 8 |
|---|---|---|
| unbeschnitten (blob d = 1/2/3, 227/145/87 VMS-Byte) | 8 443 / 7 365 / 5 732 | 2 500 + 12 je Byte ≈ 5 200 / 4 240 / 3 540 |
| Rand links/rechts (breit d = 1, 242 Listenbyte) | 25 400 – 27 200 | 4 000 + 12 · 242 ≈ 6 900 |
| oben hinaus (hoch d = 1/2/3, nur Zeilen) | 25 255 / 15 774 / 18 303 | ≈ 7 500 / 6 100 / 7 000 |
| unsichtbar (ausgeschnitten) | 2 724 | – |

**Befund:** Ziele für Objekte verfehlt, unbeschnitten um etwa 1,5×, beschnitten um 3–4×. Ursache beschnitten: `clipvms_e` kostet je Befehl etwa 130 (unsichtbar) bzw. 250–280 Zyklen (sichtbar: Zeilenverfolgung, 16-Bit-Spalte, `cflush`/`cput3` je Befehl, Zähler). Ursache unbeschnitten: Kandidatensuche und Bildsuche (≈ 2 700 Grundlast je `VIEW` mit Objekten, je Zelle ≈ 100) und die Kopie (14 je Byte).

### Größen

Lib-Code 10 747 Byte (`$B000–$D9FA`, P6d-opt 8 935), LIBTAB 945 Byte, BSS 1 926 Byte (P6d-opt 1 799). Reserve: Code 517 Byte bis `$DBFF` (Testbuild bis `$DB80`: 261 Byte), BSS 122, LIBTAB 79.

### Offene Punkte (P6f/P6g)

1. `clipvms_e` beschleunigen: sichtbare Befehle blockweise (Folge sichtbarer Befehle einer Zeile mit einem Versatz kopieren), `cput3`/Zähler inline, Spalte 8-bittig bei stride < 256; Ziel ≈ 40–60 Zyklen je Befehl. Ebenso der Zeilenweg (sichtbare Folge in einem Lauf).
2. Grundlast Objekte: Objekt-(d, s) einmal je `VIEW` statt Vergleich je Zelle (M9: Zellzeiger bei `SETPOS`), `lookup` je Kandidat cachen.
3. Unbeschnittene Sprite-Listen mit `VMS_BANK1` als Typ 9 (spart die Kopie; Referenz und Spec 6a anpassen, sobald P2d entschieden ist).
4. Code-Reserve nur 0,5 KB: P6f (MOVE, Automap) braucht Platz → Kandidaten für Einsparungen: `vpass`/Wandschleife zusammenlegen, `clipkerns`/`ckwrite` mit `mul8` vereinfachen; notfalls LIBTAB verkleinern oder Code bis `$DBFF` dicht.
5. VICE-Lauf (P6g) mit Objekten; NMI weiterhin ungeprüft (P6d-opt).

### Nachtrag Review P6e (2026-11-25)

- **Typ 9 ist Standard** (6a): unbeschnittene Listen von Wänden, Kacheln, Bändern und jetzt auch Sprites gehen als VCL-Typ 9 nach Bank 1; Build-Schalter `VMS_COPY` = alter Weg (Typ 12 überall). `vmscopy` steht nur noch im `VMS_COPY`-Build. `SPRITESET` prüft wie `TEXSET` S2 ≥ `$4000` (A = 6); beide Prüfungen sind jetzt in P6c getestet (vorher lief P6c nur mit dem Build ohne Prüfung).
- Referenz: unbeschnittene Sprites mit `vms_bank1` als `vms1` (Adresse `Scene.s2_bank1(k)` + vofs). `double_fronts(assets, objs=True)`: zweiter Objektplatz je Zelle; dabei Fehler gefunden: `copy.copy` übernahm den vofs-Cache der Vorlage (falsche Typ-9-Adressen bei Wänden der synthetischen DVG, fiel nur durch die Testreihenfolge nicht auf).
- sim: Standard-PRG = Typ 9, `viewsimc.prg` = `VMS_COPY`; Lage in `ViewRunner`: DMP `$2E00`, S2 `$4000–$5FFF` und `$A700–$AFFF`; P6c: S2 ab `$4000`, gültige Kopf-Kopien bei `$A700`. Neuer Satz „zwei Fronten, zwei Objektplätze“ (k_ob < k_oe, 68 Ansichten). Satz „rechts“ ohne Bild für d = 2 (Index `$FE`, vorher ungetestet).
- Bytegleich: Standard 1 668 / `VMS_COPY` 1 638 (P6e), voll 5 308 / 5 278; P6d voll 4 962 / 4 942; test_dbeview grün (`test_vms_bank1` mit Objekten).
- Zyklen (Standard): Gang ohne Objekte 33 416 (max 39 111), demo 1/5 Objekte 26 311 / 29 988, zufall 0–16 Objekte 64 296; je Objekt unbeschnitten 4 318–5 001 (Ziel erreicht), beschnitten unverändert 15 800–27 200.
- Größe (Standard): Code 10 596 Byte (`$B000–$D963`), Reserve 668 (Testbuild 412); `VMS_COPY` 10 747.

## Ergebnis P6e-opt (2026-11-25)

Umgesetzt in `engine/view.s` nach dem Plan aus dem Review-Nachtrag P6e, in drei Schritten, nach jedem Schritt bytegleich mit `dbeview.view` (keine Änderung an `tools/dbeview.py` und an den Tests).

### Umsetzung

1. **Code-Einsparung (−205 Byte, ohne Zyklenverlust):** `grand`/`grl` (g_rsrc = VB + rand_ofs, ZP1 = Inhalt + Liste, g_vlen aus einem Verzeichniseintrag; DTS und S2 liegen um 2 versetzt) für `gspr`, `gband` und `vmsverb` (nur `VMS_COPY`; der Hauptpfad Wand bleibt ohne Unterprogramm). `emit_vms` nimmt die Quelle aus `g_rsrc` (Kopien nach `e_src` entfallen, `clen` und `e_t` entfallen). Gemeinsames VCL-Endstück `vt5` (count, 0, reps, 0, step) für `emit_vmc` und `emit_vmf` (dadurch auch schneller). Wandschleife von `vcells` und `vpass` zusammengelegt (ein Durchlauf, INHALT mit pass 1/2). `gspr` benutzt `gsetx` (Einstieg in `gsetup` mit X = Satz). Zählprobe `gcnt` gemeinsam für `itemadd` (MAXITEM) und `iovf`. Außenkachel-Zweig aus der Zellschleife verlegt.
2. **`clipvms_e` neu:** Zeilen-Zustandsautomat im ofs-Raum. Zeile r ist sichtbar in [tL, tR) = [r·stride + L, r·stride + R); sichtbare Befehle bekommen ofs′ = ofs − cfix mit cfix = T·stride + L (die Multiplikationen T·stride bzw. (B − T)·stride stehen jetzt in `clipvms_e`, `cl_rt`/`cl_rb` entfallen in `vspr`/`gband`). Je Zeile: Befehle mit ofs < tL überspringen (16-Bit-Vergleich, k += Länge), Rückblick auf den zuletzt übersprungenen Typ 1 (links beschnittener Lauf, nur bei L > 0; auch am Listenende), dann die sichtbaren Befehle als Block direkt kopieren: `op` ist so versetzt, dass `(op),y` die Ausgabestelle zum Eingabeindex y ist (ein Y für Ein- und Ausgabe, ofs′ per Addition von −cfix); davor bleiben 3 Byte für den Typ 3 frei, der erst beim Abschluss des Blocks (nicht leer) geschrieben wird. Ein Befehl mit ofs′ ≥ lim′ (= tR − cfix) beendet den Block; ein rechts beschnittener Lauf (nur bei R < w, `cl_w`) wird mit gekürzter Länge in den Block übernommen. Nur Zeilen beschnitten (`ofull` = 2): ein Block über alle Zeilen, lim′ = (B − T)·stride. Y läuft über die Liste (ab Y ≥ `$FC` wird ZP1 nachgezogen, Y = 4, damit der Rückblick erreichbar bleibt), X/`ccnth` zählen die Befehle, `cn` je Block aus der X-Differenz. Spalte 8-bittig: nur noch R − L und die Differenz lim′ − ofs′ beim rechten Rand.
3. **Grundlast Objekte:** Zellmarke im Zellendurchlauf statt `jsr vobjc` je Zelle: Low-Byte des Zellindex (idxd + r_lo[s]) gegen das Bitfeld `obm`, nur bei Treffer `vobjc` (prüft wie bisher vollständig, auch Zellen außerhalb der Karte). `objon`/`objd` Bit 7 = Gegenstände möglich (`itemn` > 0): dann weiter jede Zelle über `vobjc` (Inhaltsebene). Phase f · NA · D per Addition statt `mul8`. `mul8` mit Registern statt BSS-Zähler (etwa 30 Zyklen je Aufruf schneller).

### Festlegungen

- **Formatvoraussetzung** für das Beschneiden (P5b 4.6, vom Konverter erfüllt): ofs = Zeile · stride + Spalte mit Spalte + len ≤ w ≤ stride; ein Lauf bleibt in seiner Zeile; Befehle steigend ohne Überlappung (Review: ergänzt, `dbetex.check_vms` in `from_s2`/`from_dts`). Damit ist die Zeile eines Befehls ofs div stride, und ein Lauf der Zeile r − 1 reicht nie über tL der Zeile r. Für Listen, die das verletzen, ist die Ausgabe nicht mehr zwingend gleich der Referenz.
- **Zählmodus** (`iovf`, MAXITEM-Probe): der Block schreibt nach Bank 0 `$0B00–$0BFF` (Reserve der Engine, 2.2 angepasst), die Einzelbefehle schreiben nichts; die Größe ergibt sich aus der Ausgabestelle. Platzprüfung beim direkten Schreiben: 2 · vlen + 4 (der zur Probe kopierte Befehl hinter dem Block).
- **Zeropage:** `clipvms_e` benutzt `kwi`/`kwn` (zt+4/5) als `cyl`/`cq` und `dp` als k; `dp` wird gerettet und vor `emit_vms` zurückgeschrieben (`iovf` erzeugt den Eintrag neu und liest `dp`).

### Test

`run_sim.py` unverändert: P6e Standard 1 668 / `VMS_COPY` 1 638 Ansichten bytegleich, `DBEVIEW_FULL=1` 5 308 / 5 278; P6d 1 322 / 1 302, voll 4 962 / 4 942; P6a, P6c, GEOMSET-Grenzfälle grün. Beschnittene Listen über 252 Byte (Nachziehen von ZP1 im Überspringen und im Block), links beschnittene Läufe am Listenende, rechts beschnittene Läufe und Zählmodus (überlauf, MAXITEM = 8) sind in den Sätzen enthalten.

### Zyklen (sim65, Demo-Assets, ohne Stub; Standardbuild Typ 9)

| Fall | P6e | Schritt 1 | Schritt 2 | Schritt 3 (P6e-opt) | Ziel |
|---|---|---|---|---|---|
| Gang ohne Objekte, Mittel / max | 33 416 / 39 111 | 33 365 / 39 049 | 33 373 / 39 064 | **33 364 / 39 048** | 30 000 / 45 000 |
| Gang ohne Objekte, `VMS_COPY` | 40 439 / 50 280 | 40 390 / 50 210 | 40 409 / 50 237 | 40 422 / 50 254 | – |
| zufall ohne Objekte, Mittel / max | 41 314 / 55 653 | 41 154 / 55 462 | 41 178 / 55 489 | 41 159 / 55 457 | – / 80 000 |
| je Objekt unbeschnitten d = 1 / 2 / 3 | 4 999 / 5 001 / 4 318 | 5 091 / 5 093 / 4 425 | 5 073 / 5 075 / 4 406 | **3 884 / 3 886 / 3 217** | 5 200 / 4 240 / 3 540 |
| je Objekt beschnitten links (d = 1, 242 Listenbyte) | 25 424 | 25 496 | 17 245 | **16 045** | 6 900 |
| je Objekt beschnitten rechts (d = 1) | 27 213 | 27 267 | 17 307 | **16 112** | 6 900 |
| je Objekt oben hinaus d = 1 / 2 / 3 | 25 375 / 15 820 / 18 353 | 25 302 / 15 851 / 18 380 | 14 703 / 10 381 / 11 570 | **13 432 / 9 105 / 10 290** | 7 500 / 6 100 / 7 000 |
| je Objekt unsichtbar (ausgeschnitten) | 2 709 | 2 725 | 2 725 | 1 535 | – |
| demo 1 / 5 Objekte (mit Gegenständen), Mittel | 26 311 / 29 988 | 26 306 / 30 003 | 26 308 / 29 056 | 26 315 / 29 048 | – |
| zufall 0–16 Objekte, Mittel / max | 64 296 / 116 471 | 64 524 / 117 387 | 62 344 / 106 763 | **62 192 / 106 554** | – |

**Befund:** Unbeschnittene Objekte liegen unter dem Ziel, die Grundlast ist um etwa 1 200 je `VIEW` gesunken (ohne Gegenstände). Beschnittene Objekte sind 1,6–1,9× schneller, das Ziel ≈ 6 900 ist aber **verfehlt** (16 000 bzw. 13 400). Aufteilung Rand d = 1 (68 Befehle, 22 bzw. 34 sichtbar, 15 Zeilen): Liste ≈ 11 200 (Überspringen ≈ 3 100 bei 57 Durchläufen à ≈ 55, Block ≈ 3 800 bei 45 Durchläufen à ≈ 80, je Zeile Fund, Blockanfang, Typ 3, Abschluss und Zeilenwechsel ≈ 200), 4 Kerne ≈ 2 000, Rest ≈ 2 800. Oben d = 1: Liste ≈ 7 200 (89 Befehle), 4 oben beschnittene Kerne ≈ 3 300 (je ein `mul8`). Die Liste muss Befehl für Befehl gelesen werden (Länge und Quellbytes je Befehl); mit etwa 50 Zyklen je übersprungenem und 70 je kopiertem Befehl liegt die Untergrenze für den Randfall bei etwa 9 000–10 000 je Objekt.

### Größen

Lib-Code 10 457 Byte (`$B000–$D8D8`, P6e 10 596; Schritt 1 10 391, Schritt 2 10 445, Schritt 3 10 457), Reserve bis `$DBFF` **807 Byte** (`VMS_COPY` 10 550 Byte, Reserve 714; Testbuild 10 585 Byte, Reserve bis `$DB80` 551). BSS 1 920 Byte (P6e 1 926), LIBTAB 945 Byte (unverändert).

### Offene Punkte

1. Ziel für beschnittene Objekte: nur mit Formatergänzung erreichbar, z. B. ein Zeilenindex je Bild im S2 (je Bildzeile Index des ersten Befehls und Quellposition: Zeilen vor T und Befehle links von L ohne Lesen überspringen, k aus der Differenz der Quellpositionen). Entscheidung Nutzer (P5b/P6f). Ohne Formatänderung bleiben etwa −500 (Blockabschluss inline, Typ 3 beim Blockanfang) und bei Kernen etwa −100 je Kern.
2. Mit Gegenständen (`itemn` > 0) prüft der Zellendurchlauf weiter jede Zelle über `vobjc` (demo-Werte unverändert).
3. Gang Mittel 33 364 (Ziel 30 000) unverändert offen (P6d-opt).

### Nachtrag Review P6e-opt (2026-11-25)

- **Fehler `clipvms_e`:** nach einem rechts beschnittenen Lauf ab Y ≥ `$F8` ging es mit Y = `$FC…$FF` ohne Nachziehen von ZP1 in die nächste Zeile; der nächste Befehl lief über Y = `$FF` hinaus (Y = 0, falsche Liste), sofern die Zeile nicht die letzte war. Behoben (`@pn`: Prüfung Y ≥ `$FC`, +5 Byte, nur auf diesem Weg). Neuer Testsatz „gitter“ (`tall_sets`, Satz 7; Satz 1 im Rand-Test frei wegen des S2-Platzes im sim): breite Bilder ohne Kerne, je Zeile Läufe, halbe Bytes und Lücken, lange Listen; trifft den Fall (vorher 1 Abweichung).
- **Zählprobe/`iovf`:** im Modus „Größe bekannt“ (ohne Platzprüfung) schrieb der Block auch bei leerer Ergebnisliste bis zu 9 Byte Abfall hinter mp; bei genau passendem Platz stehen dort schon die VCL-Einträge der Kerne. Jetzt: `im` = 0 → sofort zurück. Mit Liste bleibt der Abfall höchstens 6 Byte hinter ihrem Ende, wo der 7-Byte-Eintrag Typ 12 noch frei ist. Zählmodus: Abfall nur `$0B00–$0BFF` (Block < 256 Byte, Typ 3 bei `$0B00–$0B02`); keine Kollision (BUFSET-Fenster `$1300–$1BFF`, `$0B00` seit P6d-opt Reserve).
- **Formatregel:** `dbespr`/`dbetex` erfüllen sie beim Erzeugen (`pack_image`), geprüft wurde beim Lesen nichts, und „ohne Überlappung“ stand nicht in P5b 4.6 (VIEW setzt es voraus: Rückblick nur auf den unmittelbar vorigen Befehl, Zeile fertig nach dem rechts beschnittenen Lauf). Ergänzt: `dbetex.check_vms` (Typ 1/8, Anzahl/Länge, Zeile < h, Spalte + len ≤ w ≤ stride, steigend ohne Überlappung) in `from_s2` und `from_dts`; Test `test_check_vms`, `test_vms_format_rules` prüft Überlappung.
- Bytegleich: P6e Standard 1 743 / `VMS_COPY` 1 713 Ansichten (Rand 525), voll 5 383 / 5 353; P6d, P6a, P6c, GEOMSET grün. Zyklen unverändert (±40). Code 10 473 Byte (`$B000–$D8E8`), Reserve 791 (Testbuild bis `$DB80`: 535).
- **Zeilenindex je Bild (offener Punkt 1):** 4 Byte je Bildzeile kosten in den Demo-Sätzen +20 … 60 % S2 (Satz „hoch“ +123 %), dazu Format-/Werkzeugänderung und ≈ 80–120 Byte Code. Nutzen: Zeilen vor T entfallen (oben hinaus ≈ −3 000), bei Rand links/rechts nur die Befehle rechts von R (≈ −1 500 … −2 500 je Objekt); links von L muss weiter gelesen werden. Das Ziel ≈ 6 900 bliebe verfehlt (Kerne und Grundlast ≈ 5 000). Empfehlung: nicht umsetzen; falls oben hinaus wichtig wird, grober Index (alle 8 Zeilen, ≈ 3–8 % S2).


## Ergebnis P6f (2026-11-25)

Umgesetzt: `MOVE` (3.4) und Automap-Bit 6 in `VIEW`; `CELL` war seit P6c fertig (Test `map_check`, unverändert). Referenz: neues Modul **`tools/dbemove.py`** (nur `MOVE`, braucht weder DVG noch DTS; `move(m, pos, v, objects, action, objn)`), der Automap-Teil in **`tools/dbeview.py`** (`Scene.automap`, `_View.seen`/`seen_floor`), weil er die Interna der Sichtberechnung (`cover`, `bcov`, Zelle je Eintrag) braucht. `view()` verändert bei `automap = True` das `dmp.content` der Szene (Tests arbeiten auf einer Kopie).

### Festlegungen (Lücken der Spezifikation)

- **MOVE:** `A = 5` ohne `MAPINIT`, `A = 6` bei X ≥ 7 (Zustand und P0–P2 unverändert). Drehen: **Y = Kachel der Position** (3.4 sagte nur X = 0). Schritt: Reihenfolge der Prüfungen Karte → WEG → Objekt; Objektliste: höchstens 16 Einträge (`OBJN` > 16 wird als 16 gelesen), kleinster Index gewinnt, Bit 6 (unsichtbar) und Bit 7 (blockiert nicht) blockieren nicht. P3 bleibt unverändert; `MOVE` setzt kein Automap-Bit. `px`, `py` werden beim Schritt direkt fortgeschrieben (kein `calcxy`; Randprüfung 8 Bit: `$FF` ≥ W, auch für W = 255). P2 = Index des ersten Ereignisses mit gleicher Zelle (lineare Suche, Abbruch beim ersten Eintrag mit größerer Zelle, weil die Liste nach Zelle sortiert ist, P4 2.5; Referenz und 6502 gleich).
- **Automap:** `MAPINIT` X Bit 0 wirkt nur mit Arbeitskopie (P1 ≠ 0), sonst `map_auto` = 0 (das DMP in Bank 1 bleibt unverändert). Markiert wird Bit 6 der Inhaltsebene (a) bei jeder Wand (Front oder Seite) einer Zelle in der Karte, die nicht ganz von `cover` verdeckt ist und ein Bild hat („angenommen“ = vor MAXITEM-/Pufferprüfung von `itemadd`; ein danach verworfener Eintrag markiert trotzdem), (b) bei jeder Zelle in der Karte mit Bodenelement, die nicht blockiert ist (DECKEND + vier Wände), deren Tiefe sichtbare Bodenzeilen hat und deren Bodenelement (x … x + w) nicht ganz von `bcov` verdeckt ist (Stand nach `vcells`, vor `vband`; auch bei Lücke und Abgrund). Deckenkacheln markieren nicht; Zellen außerhalb nie. Bei Abbruch (`E_TOOMANY`) bleiben die bis dahin gesetzten Marken.
- **Testbuild:** `TESTHI` (Funktion 252) von `$DB80` nach `$DBC0` verschoben (`lib-test.cfg`, `lib.s`, Kommentar in `vice_smoke.py`), weil der Testbuild mit den P6f-Funktionen sonst nicht mehr unter `$DB80` passt; die Probe liest jetzt `$DBBF` (Füllbyte `$EA`).
- **Tests:** `run_sim.py`: P6a erwartet `F = 3` ohne `MAPINIT` als `E_STATE`; neu `test_p6f_move`, `test_p6f_auto`, `test_p6f_cycles`; `ViewRunner.mapx/mapp1` (MAPINIT mit Arbeitskopie bei `AUTO_ADDR` = `$3800`), `last_items`. `test/tools/test_dbemove.py` (Referenz).

### Test (sim65, bytegleich mit den Referenzen)

- **MOVE:** 22 884 Aufrufe (X = 0: 15 524, 1: 5 269, 2: 2 091): demo, abgrund, 6 Zufallskarten (mit Gittern/Türen/WEG, 0–300 Ereignisse), 255 × 4 (600 Ereignisse, Index > 255, Zeiger über Seiten, px + 1 = `$FF`), 1 × 40, 40 × 1, 4 × 255, 1 × 1; je Karte alle Zellen (bei > 60 Zellen 60 zufällige und die Ecken) × 4 Richtungen × 7 Aktionen mit Zufallsobjekten (Nachbarzellen, Bit 6/7, 16 Objekte, `OBJN` = 20) und 300 Aufrufe lange Zufallsketten ohne `SETPOS` dazwischen; verglichen A, X, Y, P0, P1, P2 und der BSS-Zustand (`pos`, `vdir`, `px`, `py`). Fehlerfälle X = 7/255 und `MOVE` ohne `MAPINIT`.
- **Automap:** 2 332 Ansichten (demo, abgrund, offener Raum, Gang, 24 Zufallskarten mit 6 Ansichten, zwei Fronten, darunter Abbruch durch kleine Puffer), Ketten über dieselbe Karte (Marken sammeln sich an); nach jeder Ansicht ist die Arbeitskopie (2 W H Byte) gleich der Referenz; dazu `X = 1` ohne Kopie und `X = 0` mit Kopie (keine Marken, DMP unverändert). Alle früheren Sätze (P6a, P6c, GEOMSET, P6d, P6e, je Standard und `VMS_COPY`) und die Python-Tests (106) unverändert grün.

### Größen

Lib-Code **11 016 Byte** (`$B000–$DB07`, P6e-opt 10 473: +543), **Reserve 248 Byte** bis `$DBFF` (Testbuild bis `$DBBF`: 56). BSS 1 922 Byte (+2, `cellp`), Reserve 126; LIBTAB unverändert (945). Je Funktion: `f_move` 387 Byte (davon 14 Byte Tabellen `mvtab`/`mvdel`), `cellptr` 54, `mark_seen` 36, `vauto` 81, dazu je 3 Byte in `vwall` und `vdepth`; aus `vcells` entfielen 28 Byte (nach `cellptr` ausgelagert).

### Zyklen (sim65, ohne Stub, Lauf mit Funktion minus Lauf mit F = 7)

| Fall | Zyklen |
|---|---|
| MOVE drehen (Mittel / max) | 340 / 431 (ohne Ereignisse 224 + Kartenzugriffe) |
| MOVE Schritt ok | 629 / 697 |
| MOVE Schritt gegen Karte/WEG | 512 / 626 |
| MOVE, 16 Objekte, blockierendes zuletzt | 941 |
| Ereignissuche je Eintrag | ≈ 56 je Eintrag vor der Position (Abbruch beim ersten größeren; Ereignis an Position 600 von 600: 33 987; 3 … 600 Ereignisse alle hinter der Position: 254) |
| VIEW Gang, Mittel / max, ohne Automap | 33 962 / 39 701 (P6e-opt 33 364 / 39 048: +600 durch `cellptr`) |
| VIEW Gang mit Automap | 36 035 / 41 681 (+2 070) |
| VIEW demo ohne / mit Automap (Mittel) | 24 916 / 27 035 |
| VIEW zufall (0 Objekte) ohne / mit (Mittel, max) | 41 739 / 56 094 · 45 719 / 59 526 |

### Offene Punkte

1. Ereignissuche linear: im Review auf Abbruch beim ersten größeren Eintrag umgestellt (+4 Byte; Zellen ohne Ereignis kosten nur noch die Einträge davor, ≈ 56 Zyklen je Eintrag). Binäre Suche (≈ +50 Byte) erst bei Karten mit mehreren hundert Ereignissen nötig; Entscheidung Nutzer.
2. Zyklenziel Gang (Mittel ≤ 30 000) bleibt offen (33 962; P6d-opt/P6e-opt unverändert). Automap kostet +6 %; Marken nur bei Bedarf einschalten (`MAPINIT` X Bit 0).
3. Reserve nach P6f nur 248 Byte (Testbuild 56): P6g/P7 sollten keine größeren Funktionen mehr in die Lib legen, oder `VMS_COPY`-freie Einsparungen (`vauto` 81 Byte durch Marken in `vcells` ersetzen, ≈ −35 Byte, geänderte Semantik: `bcov` noch unvollständig) prüfen.


## Ergebnis P6g (2026-11-25)

Umgesetzt: `test/vice_view.py` (Harness, Szenen, Assets, Vergleich) und `test/vice/view.bas` (BASIC-Vorlage; der Harness setzt Dateinamen, Adressen und Setz-Aufrufe ein und erzeugt `build/vice/view.bas`). Aufruf `test/vice_view.py [--only i|c] [--check] [--png DIR] [--control] [--no-sim]`; Port `--port`/`DBE_VICE_PORT` (Läufe mit 6632, Review-Nachlauf 6634), bind-Test, nur der eigene Prozess, keine festen Wartezeiten. Weder `lib.s`/`view.s` noch VDC-BASIC wurden geändert.

### Ablauf

`BOOT` (VDC-BASIC v3) → `POKE 57,0:POKE 58,80:CLR` → Stub, Lib (Standardbuild `dbe0.2.lib`), `INIT` → Chunky-Modus wie Crawl (`crawl.bas` 10059–10135: R0 127, R4 159, R6 120, R7 133, R9 1, R25 Bit 7, R28 24, R36 0, R26 `$FF`, `DISP 46335`, `ATTR 0`, Bildschirm-RAM und Attribut-RAM gefüllt; vorher das ganze 64-KB-VRAM gelöscht, damit das Modell exakt gilt) → DVG, DMP, DTS ×3, DBG, S2 ×4 per `BLOAD` nach Bank 1; VRL der Texturen, Tapete und Sprites (`vrl.encode` der `vram`-Bytes) per `BLOAD` nach Bank 0 `$9000` und `RXV` in den Pool → `POOLSET` (9600 … 46335), `GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET`, `ITEMSET`, `MAPINIT`, `BUFSET`. Die Szenentabelle (Bank 0 `$8000`: SETPOS oder MOVE, Objektliste, ITEMPH) liest das BASIC mit `PEEK`; je Schritt: Setz-Aufruf, Marke `SYS 3148` (`$0C4C`, RTS), `VIEW`, `::VCL`, Marke `SYS 3149`. Am Fehlervektor `($0300)` und an den Marken hält der Harness (Haltepunkte); an `$0C4D` liest er das ganze VRAM (`bank vdc`, `bsave`), den Puffer `$1300–$1BFF`, Parameterblock und Testbytes (`$0C40–$0C46`: A/X von `VIEW`, A/X/Y/P0 von `MOVE`).

Vergleich je Szene: (1) das **ganze VRAM** (64 KB) bytegleich mit einem Modell (`run_vcl` über die Referenz-Liste, Zustand wandert von Szene zu Szene mit); damit ist auch „kein Byte außerhalb des Fensters“ geprüft; (2) das Fenster gegen `paint_reference` (nur bei A = 0); (3) A, X, VCLADR, VCLLEN, VMSLEN, OBJVIS und die Pufferbytes (VCL-Liste und VMS-Listen) gegen `dbeview.view` (= sim65); (4) `MOVE`-Ergebnis A/X/Y/P0 gegen `dbemove.move`. Gegenprobe `--control` (ein Byte im Modell verfälscht): genau diese Szene wird gemeldet. Zyklen: Stoppuhr des Monitors; VIEW von `$0D03` (Stub-Eintritt) bis zum RTS des Stubs, VCL vom Eintritt `vcl` bis `.vcl_done` (`vcl` aus `vdcbasic3.sym`, die lokale Marke aus dem ACME-Report, `vdc_labels`; Review: vorher `complex_instruction_shared_exit`, siehe Nachtrag); in beiden Fenstern ist das I-Flag gesetzt (kein Kernal-IRQ, vergleichbar mit sim65), danach wie vorher. „mit BASIC“ = alles zwischen den Marken (Zuweisungen, `POKE`, `SYS`-Auswertung, `::VCL`-Parsing, IRQ an). Spalte sim65 = dieselbe Ansicht im sim65-Harness (Differenz zweier Läufe, ohne Stub).

### Szenen (42; je interpretiert und als Blitz!-Kompilat, Image 2)

Demo-Karte 15 × 11: Gänge, Raum mit Himmel (Tapete), Gitter, Fenster-Wand, Abgrund, INHALT-Tür, Gegenstand. 18 Ansichten Wände/Boden/Decke/Tapete/Gitter/Fenster/Abgrund/Gegenstand, 8 mit Objekten (mittig d = 1/2/3, alle Unterpositionen, Wache + Gem + ITEMPH, `breit` am linken/rechten Rand und bei d = 2, 5 Objekte im offenen Raum; `VMS` Typ 12 beschnitten in 4 Szenen), 4 INHALT-Szenen (leer, Blob d = 3/2, zwei Blobs d = 1), 12 MOVE-Schritte (Start, vor, drehen, seitwärts, gegen Wand X = 1, gegen Objekt X = 2, umdrehen, zurück).

### Ergebnis

**Alle 42 Szenen in beiden Läufen pixelgleich** (ganzes VRAM = Modell, Fenster = `paint_reference`, Puffer = Referenz, MOVE-Ergebnisse gleich, A = 0 überall, keine BASIC-Fehler). Die Prüfung gilt nur für die gestellten Szenen, nicht für alle Ansichten (das leistet sim65 bytegleich).

Zyklen (VICE, 1 MHz, Mittel / min / max über 42 Szenen; Kompilat in Klammern, wo abweichend):

| Teil | Mittel | min | max |
|---|---|---|---|
| VIEW (mit Stub) | 43 150 | 12 170 | 76 460 |
| VCL | 201 700 (201 800) | 68 000 (67 850) | 391 400 (391 200) |
| VIEW + VCL | 244 900 | 80 200 | 445 700 (446 000) |
| mit BASIC, interpretiert / kompiliert | 317 300 / 253 700 | 153 100 / 89 200 | 517 400 / 456 200 |
| sim65 (VIEW ohne Stub) | 40 141 | 11 114 | 71 513 |

Beispiele (VIEW / VCL, interpretiert): Gang Süd 44 700 / 235 800; Raum mit Himmel Süd 33 900 / 72 300; Fenster Süd d = 1 23 100 / 184 500; Fenster Ost 41 700 / 301 400; Blob mittig d = 1 48 100 / 271 500; `breit` Rand links 61 800 / 156 700; 5 Objekte offen 76 500 / 220 100; INHALT Blobs d = 1 49 500 / 391 400; Drehen 12 200 / 68 000. Zwischen Läufen schwanken die VCL-Werte um bis zu 3 000 (VIC-II-Badlines, Phasenlage).

### Befunde

1. **Speicherkarte 2.4 kollidiert mit dem verbesserten Blitz!-Runtime.** Der Runtime (Image 2) macht das obere 1 KB gemeinsam (`RCR` = `$0C`) und belegt `$FC00–$FEFF`; ein `BLOAD` der Decken-DTS (`$F800 …`) oder des DBG (`$FE00`) nach Bank 1 landet im gemeinsamen RAM und zerstört den Runtime (Kompilat hängt, interpretiert unbemerkt). Im Test liegen DVG, Decke, Boden und DBG dicht gepackt in `$E800–$FBFF` (5 KB; DVG `$E800`, Decke `$ED30`, Boden `$F240`, DBG `$F9C0`), Wand-DTS `$9000`, DMP `$5000`, S2 `$7000` wie in 2.4. **Spec 2.4 angepasst (Review P6g):** Obergrenze `$FBFF` für alle Bank-1-Daten, neue Werkzeug-Vorgaben Boden `$EE00`, Decke `$F600`, DBG `$FB00`. Der Bereich steht auch in `blitz128/blitzc/README.md` (Blitz!-Compiler).
2. **Demo-Assets passen nicht in 2.4** (Wand 8,7 KB, Boden 9,1 KB mit 3 Stilen, Decke 3,2 KB; VRAM 54 KB gegen Pool 36,7 KB). Kleine Sätze im Test: Wand 3 Stile (ziegel, gitter, fenster; 7 520 Byte DTS), Boden 1 Stil (1 918), Decke 1 Stil (1 295), Tapete mit Panorama 2 · VW (122 Byte DBG), 4 Sprite-Sätze (S2 zusammen 3 900 Byte in `$7000–$8F1D`); VRAM 9 600 … 44 751 im Pool 9 600 … 46 334 (hinter dem Attribut-RAM, vor dem Bildschirm-RAM wie in Crawl). Die Boden- und Decken-Stile mit Lücken und der Wandstil „bogen“ fehlen deshalb in den VICE-Szenen (in sim65 und `test_dbeview` getestet).
3. VICE-VIEW ist im Mittel 7 % (≈ 3 000) über sim65: Stub (≈ 450) und die VIC-II-Badlines, die die Stoppuhr mitzählt (x128, 1 MHz); die Werte schwanken zwischen Läufen um etwa 300. Ziele aus Abschnitt 8 bleiben als sim65-Zahlen gültig.
4. **VCL ist 82 % der Zeit** (Mittel 201 700 gegen 43 150): ein Bild kostet interpretiert wie kompiliert etwa 0,25 s bei 1 MHz (Blobs d = 1/INHALT 0,45 s). Zerlegung und Maßnahmen: `docs/specs/P6g-vcl-analysis.md`. Die VDC-Zeit modelliert VICE nur grob; maßgeblich wäre Z64K oder Hardware. Der BASIC-Aufwand zwischen den Marken beträgt interpretiert etwa 71 000, kompiliert etwa 8 000 Zyklen je Szene.
5. `BLOAD … :IF DS<>0` und `GOSUB`/`POKE`-Schleifen laufen im Blitz!-Kompilat unverändert; `FOR` mit 0 Durchläufen im Interpreter läuft einmal (Vorlage prüft `n = 0`).

### Offene Punkte

- Z64K-Lauf (Pixel per CRC wie `vdc-basic/test/zvt.py`) nicht umgesetzt: bräuchte die Szenentabelle als Datei, ein 6502-Hilfsprogramm für die CRC und mehrere Starts (je 8 s + 1,7 MHz); VICE-Szenen decken Funktion und Zeit ab.
- Szenen mit A ≠ 0 (Puffer zu klein), Automap, Arbeitskopie (`SETCELL`) und `OBJN` > 16 sind nicht in VICE gestellt (sim65 prüft sie bytegleich).
- NMI weiterhin ungeprüft (P6d-opt).
- Zeitmessung mit I-Flag gesetzt: der Zustand wird an Ein- und Ausgang vom Harness gesetzt und zurückgeschrieben; ein CLI in Stub/Lib würde nicht auffallen (es gibt keins).

### Nachtrag Review P6g (2026-11-25)

- Testregeln eingehalten: eigener Port (`vicemon.choose_port`, bind-Test, Bereich 6631–6649), ereignisgesteuert (Haltepunkte an Marken und Fehlervektor, Debug-Cartridge; `-limitcycles` und Timeout nur Wächter), nur der eigene Prozess (`terminate`/`kill` per Popen). Der Vergleich ist stark: ganzes 64-KB-VRAM gegen das fortgeschriebene Modell, zusätzlich Fenster gegen den unabhängigen `paint_reference`, Puffer gegen `dbeview.view`. `--control` verfälscht das Byte `$00FA` (Zeile 3, Spalte 10, im Fenster) von Szene 5; Nachlauf: genau diese Szene gemeldet, Exitcode 0.
- **Korrigiert: Ende der VCL-Messung.** `complex_instruction_shared_exit` ist das gemeinsame Ende **jedes** VMC/VMF und jedes VMS-Kopierbefehls, nicht von VCL. Der Haltepunkt traf hunderte Male je Szene; gezählt wurde der letzte Treffer, und schon beim ersten Treffer wurde das I-Flag zurückgesetzt, so dass ab dem zweiten Eintrag Kernal-IRQs mitgezählt wurden (≈ 5 %). Jetzt endet die Messung an `.vcl_done` (Adresse aus dem ACME-Report einer Kopie, gegen `vdcbasic3.bin` geprüft). Neue Werte oben (VCL im Mittel ≈ 5 % niedriger als vorher gemeldet: 211 200 → 200 500 bei gleichen Szenen), beide Läufe weiterhin pixelgleich.
- **Korrigiert: zwei Szenen mit der Kamera in einer deckenden Zelle** („Fenster Ost“ in der Fenster-Wand (8, 9), „Abgrund Nord“ in einer Wand (4, 5)). Dort blieben Fensterbytes ungeschrieben (Fenster Ost: 1 050 Byte, Boden- und Deckenband d = 0 der blockierten Zelle). Jetzt (7, 9) Ost bzw. (3, 4) Nord; `build_steps` weist Kamerazellen mit DECKEND ab. Die Tabelle oben stammt aus dem Lauf danach (42 Szenen, beide Läufe pixelgleich).
- Neues Werkzeug `test/vice_vclprof.py` (VCL-Zeit je Eintrag und je VMS-Befehl, Herkunft der Einträge, Overdraw; `--static` ohne VICE) für die Analyse `P6g-vcl-analysis.md`.
- Aussagekraft der Zyklen: VICE modelliert die VDC-Wartezeiten nur grob (Bytes sind fast kostenlos); Hochrechnung auf Z64K in der Analyse (Abschnitt 4).


## Entscheidungen nach der VCL-Analyse (2026-11-25)

1. VDC-BASIC-Optimierung (VMC-Zeile, VMS Typ 1/8, VCL-Eintrag) kommt später, nicht vor P7.
2. Kanten auf ganze Bytes (2-Pixel-Stufen) als Option je Projekt: `view.toml` Schalter `byte_edges` (Standard `false` = pixelgenau); dbegeom rundet Masken dann auf Bytegrenzen.
3. Gerendert wird mit 2 MHz (FAST, VIC aus während VIEW und VCL). Zyklenziele und Messungen werden auf 2 MHz bezogen.
4. `MEMSIZ $4000`: BASIC-Variablen in Bank 1 `$0400–$3FFF`; erste Anweisung `POKE 57,0:POKE 58,64:CLR`. Asset-Bereiche ab `$4000` neu aufteilen (Speicherkarte 2.4 in P6h nachziehen).

## Ergebnis P6h (2026-11-25)

Umgesetzt: Speicherkarte G mit `MEMSIZ $4000` (2.4), Werkzeug-Ladeadressen und Bereichsprüfung (`tools/dbemem.py`), DVG-Bit 3 in `dbegeom`, `view.toml`-Schalter `byte_edges`, VCL-Typ 2 statt 3 bei srcstep = Länge (Engine und Referenz), Tests und Harness auf die neue Karte, Messung mit 2 MHz.

### Speicherkarte

Bank 1: Variablen `$0400–$3FFF` (15 KB), DMP `$4000–$5FFF`, S2 `$6000–$7FFF`, Wand-DTS `$8000–$AFFF` (12 KB), Lib `$B000–$DBFF`, LIBTAB `$DC00`, BSS `$E000–$E7FF`, DVG `$E800`, Boden `$EE00`, Decke `$F600–$FB7F`, DBG `$FB80–$FBFF`, `$FC00–$FEFF` Blitz!-Runtime (gesperrt). Gegenüber Karte F rutschen DMP, S2 und Wand um 4 KB nach unten, die Wand bekommt 4 KB mehr (das Demo-Wand-DTS mit 4 Stilen, 8 736 Byte, passt jetzt); der hohe Teil `$E800–$FBFF` bleibt (5 KB), nur die Grenze Decke/DBG wandert von `$FB00` auf `$FB80` (1 Stil der Demo-Decke hat 1 295 Byte, der alte Bereich hatte 1 280; DBG braucht höchstens 124 Byte). Alle Bereiche liegen ≥ `$4000` (VCL-Typ-9-Listen) und unter `$FC00`.

### Werkzeuge

- `tools/dbemem.py` (neu): Standard-Ladeadressen und `range_error(art, load, länge)`. `dbemap build`/`crawlmap` `$4000` (vorher `$8000`), `dbespr` `$6000` (`$7000`), `dbetex` Wand `$8000` (`$A000`), Boden `$EE00`, Decke `$F600`, DBG `$FB80` (`$A900`), `dbegeom` `$E800` (`$E400`). Die Schreibwege (`dbemap build`, `crawlmap`, `dbespr build`, `dbetex build`/`bg`, `dbegeom`) brechen mit Exitcode 1 und Meldung ab, wenn die Datei über das Bereichsende reicht oder ihre Ladeadresse in keinem Asset-Fenster liegt; liegt die Ladeadresse außerhalb des Standardbereichs der Art (dichte Packung), zählt das Ende des Fensters (`$AFFF` bzw. `$FBFF`). Die Rechenfunktionen (`to_dts`, `to_s2`, `to_dmp`, `build_texset`) prüfen nicht, damit Referenz und Tests die übergroßen Demo-Assets weiter benutzen können.
- `dbegeom`: DVG-Flag **Bit 3** (Bandabdeckung) an allen Fronten, die die Bandzeilen ihrer Tiefe enthalten (JSON-Flag `bandcover`); die Geometrie-ID ändert sich dadurch. `dbeview.without_band_cover` erzeugt die Variante „Bit fehlt“ für die Tests (`make_scene(band_cover=False)` benutzt sie).
- **`byte_edges`** (`[viewport]`, Standard `false`): Halbe Bytes (nur ein Pixel im Polygon) werden auf ganze Bytes gerundet: das Byte gehört zum Polygon, wenn sein Mittelpunkt innerhalb liegt; liegt er auf einer Kante, bekommt es das Polygon, das das linke Pixel besitzt (Nachbarflächen bleiben lückenlos und überlappungsfrei). Masken enthalten dann kein `L`/`R`, der Konverter erzeugt keine VMS-Typ-8-Befehle an den Kanten von Wänden und Kacheln (Sprites bleiben unberührt: `dbespr`).
- VCL-Typ 3 mit srcstep = Länge wird als Typ 2 ausgegeben (Kerne; die Tapete bleibt Typ 3). Engine: neuer Einstieg `emit_vmcn` in `view.s` (Zählen und Schreiben, auch für beschnittene Kerne), Referenz `dbeview._kern_vmc`; bytegleich (sim65). In den Demo-Assets 29 von 256 Wandkernen; je Eintrag 2 VCL-Byte und der Typ-3-Mehraufwand weniger. Lib-Code **+41 Byte** (11 016 → 11 057 von 11 264), Reserve 207 Byte.

### Tests

- `test/tools` (255 Tests): neu `test_dbemem.py` (Bereiche, Fehlermeldungen, CLI von `dbemap`, `dbetex`, `dbespr`), in `test_dbegeom.py` Bit 3, `byte_edges` (Option, ganze Bytes, Rundung höchstens ein Pixel, keine Überlappung gleicher Art und Tiefe, andere ID, Bereichsprüfung des DVG).
- `run_sim.py` (normal und `DBEVIEW_FULL=1`) bytegleich; Demo-DTS liegen im sim65 in eigenen Adressen (Decke `$EE00`/`$EF00`, DBG `$FB80`/`$8280`, alles unter `$FC00`).
- `vice_smoke.py` (zusätzlich Prüfung `PEEK(58) = 64`), `vice_zp.py`, `vice_view.py` (interpretiert und Blitz!, je zwei Läufe) grün; alle 42 Szenen pixelgleich, `--control` meldet die verfälschte Szene. `.bas`-Vorlagen mit `POKE 58,64`; `vice_blitzvars.py` auf `$4000` angepasst.
- `vice_view.py` misst jetzt zusätzlich mit **2 MHz**: zweiter Lauf mit `FAST:` vor `SYS 3148` (VIC-Anzeige aus) und `SLOW` nach `SYS 3149`, also genau während VIEW und VCL; gleiche Pixelprüfung. Die Stoppuhr zählt Takte zu 1 MHz (µs-Äquivalent). `--no-fast` überspringt ihn, `--byte-edges` baut die Demo-Geometrie mit `byte_edges`.

### Zyklen (VICE, Mittel über 42 Szenen; interpretiert, Blitz! gleich ±100)

| | 1 MHz | 2 MHz (FAST, VIC aus) | Verhältnis |
|---|---|---|---|
| VIEW (mit Stub) | 43 287 | 21 308 | 0,49 |
| VCL | 200 279 | 122 369 | 0,61 |
| VIEW + VCL | 243 566 | 143 678 | 0,59 |
| VIEW + VCL, `byte_edges` | 210 350 | 123 062 | 0,59 |
| VCL, `byte_edges` | 167 154 | 101 812 | 0,61 |

VIEW halbiert sich (reiner CPU-Code, Badlines entfallen); VCL sinkt nur auf 61 %, weil die Wartezeiten des VDC bleiben. Das Verhältnis 0,61 liegt unter der Hochrechnung der Analyse (0,74); in VICE sind die VDC-Wartezeiten ein grobes Modell, Z64K bzw. Hardware bleiben maßgeblich.

### `byte_edges` an der Demo (VICE-Szenen, `--byte-edges`)

VCL −16,5 % bei 1 MHz (200 279 → 167 154) und −16,8 % bei 2 MHz (122 369 → 101 812); die Analyse hatte −37 000 (−18 %) geschätzt. Größen: Wand-DTS 7 520 → 7 254 Byte, Boden 1 916 → 1 504, Decke 1 295 → 1 086; VRAM-Pool belegt 44 751 → 44 591 Byte (−160). Alle 42 Szenen weiterhin pixelgleich zum jeweiligen Modell (andere Bilder als pixelgenau: schräge Kanten stufen in 2-Pixel-Schritten).

### Offene Punkte

- Sprites (`dbespr`) kennen `byte_edges` nicht; ein Schalter für halbtransparente Randbytes bleibt eine Entscheidung für P7.
- Boden-/Decken-Demo (9,1 / 3,2 KB) passen weiter nicht in ihre Bereiche (Asset-Etat in P7).
- Die Lib-Prüfung „Daten außerhalb von Lib/BSS“ (K5) fehlt weiterhin.

## Ergebnis P6i (2026-11-26): Verdeckung von Sprites über die Malreihenfolge

Nutzerentscheidung (von Anfang an vorgegeben, in P6 falsch umgesetzt): Sprites werden **nicht** gegen `cover` beschnitten. Ein Sprite wird vollständig gezeichnet und von den näheren Wänden übermalt; `cover` verwirft ein Sprite nur, wenn alle Spalten seines Fensterausschnitts belegt sind. Beschnitten wird nur am Rand des Sichtfensters (der Rest des Bildschirms gehört dem Spiel). Ein Sprite ganz im Fenster nimmt den schnellen unbeschnittenen Weg (Kerne + Rand als Typ 9, im Build `VMS_COPY` als Kopie).

### Umsetzung

- Spec 5.4, 5.8 Schritt 5, 5.9; neue Begründung **5.8a** (Analyse der Reihenfolge: alles, was ein Sprite in Tiefe d verdecken kann, kommt in der VCL danach und ist ungeschnitten; keine zusätzlichen Änderungen der Reihenfolge nötig; Grenzfälle Überlauf, Bänder ohne Bild, zu hohe Sprites). P5b 3.4 (Höhenprüfung) und 6 (Ausschnitt) nachgezogen.
- Referenz `dbeview._View.objekte`: Spaltensuche durch `allcov(cover, cx0, cx1)` ersetzt. `paint_reference` war schon so (Sprites nur am Fenster beschnitten).
- Lib `view.s` (`vspr`): `ffree` (erste/letzte freie Spalte) entfällt, stattdessen `allcov_c` (gibt es für die Wände ohnehin). Lib-Code **11 057 → 10 982 Byte (−75)**, Reserve bis `$DBFF` **207 → 282 Byte**. BSS unverändert.

### Test

- `python3 -m unittest discover -s test/tools`: 283 Tests grün, darunter der Offline-Vollvergleich `test_crawl01` (19 136 Ansichten pixelgleich zum 0.1-Modell; 0.1 hat ebenfalls einfach übermalt).
- `run_sim.py` grün (P6a/P6c/GEOMSET, P6d 1 322 / `VMS_COPY` 1 302, P6e 1 743 / 1 713, P6f MOVE und Automap, alle bytegleich).
- `run_crawl.py --dir test/tools/data`: 19 136 Ansichten bytegleich (sim65 gegen `dbeview.view`), alle A = 0.
- `vice_view.py` (interpretiert und Blitz!, je 1 und 2 MHz): 42 Szenen pixelgleich. `vice_demo.py --only i`: 75 Prompts gleich dem Modell.
- Crawl-Pixeltest im Spiel-Repo (`test/vice_crawl.py --ports 6633,6634`, neue Lib nach `libs/dbe0.2.lib.prg`, Stub unverändert): **PASS**, 1.1 interpretiert und kompiliert je 74 Prompts gleich 1.0f (Rundgang, Automap, 32 Geist-Szenen), `crawl01` gegen das echte 1.0f-Fenster 73 Prompts gleich. Die P7d-Zeitmessung für 1.1 ist mit dieser Lib zu wiederholen.

### Zyklen VIEW (sim65, Crawl-Szenen wie `run_crawl.py`, ohne Stub; Mittel / max)

| | vorher (P6h) | nachher | 0.1 |
|---|---|---|---|
| ohne Geist (400) | 16 863 / 26 104 | 16 747 / 25 877 | 16 369 / 19 215 |
| mit Geist (9 168) | 20 755 / 45 666 | **18 833 / 30 364** | 18 745 / 25 746 |
| Geist d = 1 seitlich (896) | 36 256 / 45 666 | **22 411 / 30 364** | 22 883 / 25 746 |
| Geist d = 2 seitlich (1 312) | 21 301 / 38 285 | 18 053 / 28 805 | 18 932 / 23 735 |
| Geist mittig (s = 0, d ≥ 1, 2 704) | 22 599 / 30 638 | 22 435 / 30 364 | 20 835 / 25 644 |
| pos 67 Richtung 3, Geist Zelle 86 (d = 1, s = −1), Blick 0 / 1 | 45 666 / 43 348 | 28 951 / 30 324 | 25 521 / 25 049 |

Das Beschneiden am Rand von `cover` (Zählprobe und Kopie der VMS-Liste, `clipvms_e`) kostete beim seitlichen Geist in Tiefe 1 etwa 14 000 Zyklen; das entfällt jetzt ganz. Ziel ≤ 28 382 (2 × 0.1): vorher 1 630 Ansichten darüber, jetzt 382 (davon 164 Geist d = 1 seitlich, 210 mittig; Maximum 30 364 = 1,07 × Ziel; größter Quotient zu 0.1 je Ansicht 1,82 → 1,37). Die VMS-Pufferbelegung im Crawl sinkt auf 0 (alle Geister und Edelsteine im Fenster gehen als Typ 9).

### VCL-Mehrkosten durch übermalte Bytes (Crawl-Szenen, `dbeview.view`)

| | VCL-Byte Mittel | VRAM-Schreibbytes Mittel (Δ, max Δ) | Δ Operationen (Mittel) | Schätzung Δ VCL (VICE-Modell P6g) |
|---|---|---|---|---|
| ohne Geist (Edelsteine) | 79 → 77 | 6 677 → 6 692 (+15, +54) | 5 VMC-Zeilen Typ 3 → Typ 2 | −480 Zyklen |
| mit Geist | 92 → 90 | 6 743 → 6 781 (+38, +247) | +1 VMC-Zeile, +0,7 VMS1, +2,0 VMS8 | +900 Zyklen |
| Geist d = 1 seitlich | 123 → 121 | 7 045 → 7 237 (+192, +247) | +10 VMC-Zeilen, +5,6 VMS1, +15,5 VMS8 | +11 600 Zyklen (max +21 800) |

Schätzung mit den P6g-Werten (Eintrag 670, VMC-Zeile 187 bzw. 281 mit srcstep, VMS-Typ 1 308, Typ 8 706 Zyklen); auf Z64K/Hardware kommen etwa 5–7 Zyklen je zusätzlichem Byte dazu (+192 Byte ≈ +1 200). Beim seitlichen Geist in Tiefe 1 übertrifft die Ersparnis in VIEW (≈ −13 800) die VCL-Mehrkosten (≈ +11 600): VIEW + VCL ≈ −2 200 im Mittel; über alle Ansichten mit Geist ≈ −1 000, ohne Geist ≈ −600 (Schätzung, VICE-Modell). Die Mehrkosten kommen fast ganz von den halben Randbytes (VMS-Typ 8) des Geistes, die jetzt hinter der Wand gemalt und übermalt werden.

## Ergebnis P6j (2026-11-26): feste Listenadresse und Zeropage nur, wo nötig

Anlass: Messung im Crawl-Rundgang (comp 2 MHz, 1.1 +34 800 Takte gegen 1.0f): etwa 15 600 Takte BASIC zwischen `VIEW` und `VCL` (Listenanfang aus P0 als Float-`PEEK`-Rechnung, `::VCL VA`) und etwa 11 200 im Stub (16 Byte Zeropage bei jedem Aufruf retten und zurückschreiben).

### 1. Feste Listenadresse (`BUFSET` X Bit 0)

**Warum die Adresse wandert:** `VIEW` läuft von vorne nach hinten durch die Sicht und schreibt jeden Eintrag sofort (Einpass); `VCL` muss von hinten nach vorne malen (seit P6i hängt auch die Verdeckung der Sprites davon ab). Die Liste wächst deshalb abwärts von B1, ihr Anfang B1 − nv ändert sich mit jedem Bild. Vorwärts ab B0 ginge nur mit zwei Durchläufen (0.1) oder mit Umkehren am Ende (30–60 Zyklen je Byte).

**Lösung:** neuer VCL-Eintrag **Typ 10 „weiter bei Adresse“** in VDC-BASIC v3 (`10, Adresse`, 3 Byte; vdc-basic `docs/v3/P2e-vcl-jump.md`). Mit `BUFSET` X Bit 0 schreibt `VIEW` vor dem Durchlauf das Typ-Byte 10 nach B0 und am Ende die Adresse B1 − nv dahinter; die VMS-Listen beginnen bei B0 + 3 (BL 3 Byte kleiner, 5.10), sonst ist alles gleich (keine Einschränkung, beschnittene Ränder bleiben im Puffer). VCLADR = P0 = B0 bei jedem Aufruf, VCLLEN und VMSLEN ohne den Sprung. `INIT` schaltet den Modus aus; der Standard (X Bit 0 = 0) ist unverändert.

Verworfen: (A, Zwischenstand) Liste nach B0 kopieren und VMS-Listen im festen Modus weglassen (Funktionsverlust am Fensterrand, Kopie 14–18 Zyklen je Byte, Crawl ≈ 1 150–1 330 je `VIEW`, 132 Byte Code); (B) Liste nach B0 kopieren, VMS-Listen verschieben oder drehen und die Typ-12-Adressen nachtragen (≈ 200–250 Byte Code, mit vielen VMS-Bytes 20 000–100 000 Zyklen); (C) VMS-Listen abwärts ab B1 mit verschiebbarem Listenstapel (Eingriff in Erzeugung und Rücknahme).

**Kosten:** `VIEW` sim65 (Crawl, 9 568 Ansichten) mit festem Modus Mittel 16 888 / 18 978 (ohne / mit Geist), ohne 16 792 / 18 883: **≈ +100 Zyklen**. `VCL` +≈ 215 Zyklen für den Sprung (VDC-BASIC, VICE). Dagegen BASIC (VICE-Mikromessung je Aufruf, ohne die Liste; interpretiert / Blitz!): `V=PEEK(3072)+256*PEEK(3073):::VCL V` mit spät angelegtem V 25 500 / 5 700, `::VCL 4864` (Zahl, wird jedes Mal umgerechnet) 7 000 / 6 400, **`::VCL VB` mit VB = B0 als erster Variable 3 400 / 2 900**. Empfehlung für Spiele: `VB` als erste Variable nach `CLR` setzen.

**Lib:** 10 982 → 11 065 Byte Code (`$B000–$DB38`), Reserve **282 → 199 Byte**; BSS +1 (`buf_fix`). Testbuild: `TESTHI` (Funktion 252) von `$DBC0` nach `$DBF0` verschoben (`lib-test.cfg`, Probe liest `$DBEF`), Reserve im Testbuild bis `$DBEF` 54 Byte.

### 2. Zeropage nur, wo nötig (Stub)

Nutzung je Funktion, gemessen mit `test/vice_zp.py --funcs` (Programm von `vice_view.py` plus CELL, SETCELL, SETITEM, BUFSET X = 1/0, F = 7, 8, 17; je Lib-Aufruf Watchpoints Lesen/Schreiben auf `$63–$72` und `$FA–$FD`, erster Treffer je Aufruf mit `$FF00`):

| F | Funktion | ZPB `$63–$72` | `$FA–$FD` |
|---|---|---|---|
| 0 | INIT | – | ja |
| 1 | MAPINIT | – | ja |
| 2 | SETPOS | – | – |
| 3 | MOVE | – | ja |
| 4 | VIEW | **ja** | ja |
| 5, 6 | CELL, SETCELL | – | ja |
| 7, 8, ≥ 17 | (nicht umgesetzt) | – | – |
| 9 | SPRITESET | – | ja |
| 10, 11 | ITEMSET, POOLSET | – | – |
| 12 | GEOMSET | **ja** | ja |
| 13, 14 | TEXSET, BGSET | – | ja |
| 15 | BUFSET | – | – |
| 16 | SETITEM | – | ja |

0 fremde Zugriffe (alle Treffer mit `$FF00 = $7F`); statisch dasselbe (ZPB-Symbole nur in `f_geomset`/`gcells`, `view.s` und `t_zp`; aus `view.s` ruft nur BGSET `bgoffs`, ohne ZPB).

Der Stub rettet den Block nur noch für F = `ZPB_F1` (4), `ZPB_F2` (12) und `ZPB_FT` (253, Testbuild) (`dbe.inc`; eine neue Funktion mit ZPB muss dort eingetragen werden); Flag `sv_f` (Bit 7) für das Zurückschreiben. Retten und Zurückschreiben vierfach entrollt (9 statt 14 Zyklen je Byte). Ersparnis je Aufruf ohne ZPB ≈ 420 Zyklen (Vergleiche +≈ 20), je VIEW/GEOMSET ≈ 150. Stub 168 → 221 Byte (`$0D00–$0DDC`). Neue Marke `call_rts` (RTS am Stubende) in `build/stub.lbl`; `vice_view.stub_rts()` liest sie dort statt das Ende abzuzählen.

### 3. Tests

- `python3 -m unittest discover -s test/tools`: 285 Tests grün (neu `TestFixedAddress`: Sprung, VMS ab B0 + 3, gleiches Bild wie ohne festen Modus, 3 Byte weniger Platz).
- `run_sim.py` grün: P6a mit BUFSET X = 1/3/2 (Modus, Fehler lässt ihn stehen); neue Sätze „feste Listenadresse“ in P6d (232 Ansichten, je Standard und `VMS_COPY`) und P6e (150), alle bytegleich (Harness `viewsim.c` folgt dem Sprung).
- `run_crawl.py --dir test/tools/data` und `--fix`: je 19 136 Ansichten bytegleich, A = 0.
- VICE: `vice_smoke`, `vice_zp` (interpretiert und Blitz!), `vice_zp --funcs`, `vice_view` (42 Szenen, interpretiert und Blitz!, 1 und 2 MHz), neu `vice_view --fix` (dasselbe mit BUFSET X = 1 und `VCL` mit der Konstanten B0), `vice_blitzvars`, `vice_demo --only i` (Demo jetzt im festen Modus: `demo.bas` 290, `vcl vb`; 75 Prompts gleich dem Modell).
- Crawl (Spiel-Repo, VDC-BASIC v3 mit P2e, `BUFSET` X = 1, `::VCL VB`): Pixeltest gegen 1.0f **PASS**; Zeitmessung P7 12.4.

## Ergebnis P6l (2026-11-26): Fernsicht-Füllung

Nutzerentscheidung: Die Tapete darf nicht mehr ungewollt die Fernsicht sein (Demo: durch das Gitter in der überdachten Kammer sah man Berge). Regeln und Ablauf: 5.7a; Aufruf: `BGSET` Y ≠ 0 = an, P2 Low = Füllbyte (Y = 0 aus, Standard nach `INIT`; Crawl ruft `SYS3331,14,0` ohne Y auf, Y kommt dann aus dem vorigen `SYS` (`TEXSET` endet mit Y = 0); ohne Decken wäre die Füllung dort ohnehin wirkungslos). Kachel-Flag FERN (DMP Bit 6, `dbemap` `"fern"`) kehrt die Deckenregel um. Ohne Füllung ist die Liste unverändert, ebenso mit Füllung, solange keine Zelle der Tiefe D überdacht ist.

### Umsetzung

- **Spalte → Zelle:** `GEOMSET` legt `hs[c] = s(c) + 15` an (80 Byte BSS): Startwert 15, jede Seite der Tiefe D verschiebt die Grenze an ihrer fernen Kante (s < 0: `hs − 1` für c < x + w; s > 0: `hs + 1` für c ≥ x). Damit fallen die Grenzen Füllung/Tapete genau unter die fernen Ecken der Decken der Tiefe D (Ebene P_{D+1}), nicht auf die nahen Kanten der Fronten (P_D, bis zu 4 Spalten daneben).
- **Entscheidung je Zelle:** `vcells` schreibt in der Tiefe D (nur mit Füllung) je Zelle `fdec[s + 15]` = ((Deckenstil ≠ 0) XOR Flag FERN) als `$40`/0 (31 Byte LIBTAB) und sammelt `fany`.
- **Ausgabe:** `vtap` lässt mit `fany` den Horizont weg; nach dem Wartebereich der Tiefe D (dann sind auch deckende Seiten und Fronten ohne Bit 3 der Tiefe D in `bcov`, deren Spaltenbereich die Horizontzeilen nach P3 4.4 ganz deckt) läuft `vfar` über `spans(bcov)` und die Läufe gleicher Entscheidung (rechts → links): Füllung als BG-Eintrag mit `bgsel` (`gbg` nimmt dann das Füllbyte wie ohne DBG, Typ 4/5), Tapete als normaler BG-Eintrag. Die Einträge sind die letzten der Liste und werden zuerst gemalt.
- **GEOMSET:** Die Zellentabelle wurde immer mit A = 1 angelegt (Prüfen und Anlegen in einem Durchlauf); die toten Abfragen `gbld` (A = 0 „nur prüfen“) sind entfernt (−43 Byte), damit die Fernsicht in die Lib passt.
- **Referenz:** `dbeview` `Scene.farfill`, `_Ctx.far_cols`/`far_dec`, `_View.fern`, Maler (Horizont je Spalte), `far_variant` (Zufallsszenen mit Füllung und FERN), TOML-Schlüssel `farfill`. Fehlt für eine Spalte die Zelle (D, s(c)) in der DVG (nur bei fremden DVGs möglich), meldet die Referenz einen Fehler; die Lib liest dann einen alten Wert.

### Größen

- Lib-Code **11 065 → 11 250 Byte** (`$B000–$DBF1`), Reserve **199 → 14 Byte** (Fernsicht ≈ +228, tote `gbld`-Abfragen −43). BSS 1 923 → 2 009 Byte (`hs` 80, `ffon`, `ffill`, `fon`, `fany`, `bgsel`, `fc0`), LIBTAB 945 → 976 (`fdec`).
- **Testbuild:** Die Testfunktionen 250–253 und ihr Verteiler liegen jetzt in `TESTLO` vor der Lib (`$AF00–$AF7E`, Datei ab `$AF00`), in der Lib bleibt ein Sprung (`cmp #NFUNC` → `t_disp`). `TESTHI` (Funktion 252) von `$DBF0` nach `$DBF8`; die Probe liest das eigene erste Byte (`$A9`, `smoke.bas` 160 prüft Y = 169). Reserve im Testbuild bis `$DBF7`: 3 Byte.
- **`VMS_COPY` passt nicht mehr in die 11 KB** (11 343 Byte); der Schalter bleibt für sim65 (`test/sim/simc.cfg`: Lib-Code bis `$DCFF`, LIBTAB bei `$FC00`). Auf dem C128 ist nur der Standardbuild (Typ 9) möglich.

### Zyklen

- `VIEW` (sim65, Demo-Karte `demo/demo.toml` mit den Demo-Assets der Tests, 504 Ansichten ohne Objekte): ohne Füllung Mittel 30 085 / max 55 839, **mit Füllung 30 780 / 59 609** (+695 im Mittel: Entscheidung je Zelle der Tiefe D, Lauf je Spalte ≈ 23 Zyklen, Horizont als eigene Einträge).
- Grundlast ohne Füllung (Abfrage je Zelle, 3 Byte mehr löschen): Crawl `run_crawl.py --fix` Mittel **17 024 / 19 117** (ohne / mit Geist) gegen 16 888 / 18 978 (P6j): +≈ 135 (0,8 %).
- `VCL` (VICE-Kostenmodell P6g: Eintrag 670, Zeile Typ 2/3/5 187/281/237; Demo-Welt, 504 Ansichten ohne Goblins): 228 Ansichten ändern sich, Δ Mittel **−1 650 Zyklen**, Median −1 010, min −14 270, max +7 460, VCL-Liste +9 Byte im Mittel. Ersparnis: Füllen statt Panorama-Kopie (Typ 5 statt Typ 3 je Zeile) und keine Tapete in den Spalten deckender Seiten der Tiefe D; Mehrkosten: eigene Einträge für den Horizont, wo er vorher mit Decken- oder Bodenlücken der Tiefe D in einem Eintrag lag, und mehrere Läufe bei gemischten Reihen. Gitter d = 1 (17, 5, S): +330 (2 Einträge mehr, Abgrund in der Tiefe D); Gang Ost (4, 14): −5 790.
- VICE (`vice_demo.py --only i`, Tour 74 Tasten, neue Fassung, Lib `2757b277`): interpretiert 1 MHz VIEW Mittel 48 255, VCL 161 765; 2 MHz VIEW 22 975, VCL 98 761. Gitter d = 1 (Bild 70, 1 MHz): VIEW 54 060, VCL 292 778.

### Tests

- `python3 -m unittest discover -s test/tools`: neu `TestFernsicht` (Pixel gegen `paint_reference` für `fern_map` – langer Gang mit Decke und Fenster nach draußen, Fenster mitten im Gang mit Wand dahinter, langer Gang ohne Decke, Gitter, FERN-Kacheln, gemischte Reihe –, `demo/demo.toml` und die Beispielkarte, mit/ohne DBG; Spaltenzuordnung; aus = unverändert; 120 Zufallsszenen mit Füllung und FERN), `test_dbemap` (Flag `fern`, Bit 7 reserviert).
- `run_sim.py`: P6c prüft `hs` nach jedem `GEOMSET` und `ffon`/`ffill` nach `BGSET`; neuer Satz **P6l** 2 488 Ansichten bytegleich (fern_map, `demo/demo.toml`, Beispielkarte, je Standard und `VMS_COPY`, zufällig mit Objekten, zwei Fronten, Überlauf 64 … 1 024 Byte mit und ohne feste Listenadresse); alle älteren Sätze unverändert bytegleich.
- `run_crawl.py --no-cycles`: 19 136 Ansichten bytegleich (Crawl ohne Füllung unverändert).
- VICE: `vice_demo.py --only i` (Demo mit Füllung `$11`, 75 Prompts gleich dem Modell, 1 und 2 MHz); `vice_smoke` und `vice_zp` (Testbuild verschoben), interpretiert und Blitz!.
- Befund Demo: In der Kammer mit Abgrund zeigt die Bodenlücke der Tiefe D unter der Füllung einen Streifen Landschaft (Panoramazeilen unter dem Horizont, `bg.toml`); das ist die Tapete im Abgrund, nicht die Fernsicht, und bleibt nach Regel 4 so.

