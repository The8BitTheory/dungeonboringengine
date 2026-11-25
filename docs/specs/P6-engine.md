# P6: Engine 0.2 in 6502 – Speicher, Funktionen, `VIEW`, Tests

Stand: 2026-11-25. Detailspezifikation zu Schritt P6 aus `docs/plan-0.2.md` (Abschnitte 3, 5, 8). Umsetzung in Teilschritten P6a–P6h (Abschnitt 10). Review: Opus. Grundlagen: `P3-geometry.md` (DVG), `P4-map.md` (DMP), `P5-textures.md` (DTS, DBG), `P5b-sprites.md` (S2, `clip_image`), VDC-BASIC v3 (`vcl-format.md`, `vms-format.md` mit Typ 3, `RXV`), `review-notes.md`.

## 1. Überblick

Die Lib bleibt eine Bank-1-Bibliothek hinter dem Stub (`SYS 3331,F,X,Y`). Sie liest DVG, DMP, DTS, DBG und S2 aus Bank 1 und schreibt die **VCL-Liste und die VMS-Listen** in einen Puffer im gemeinsamen RAM (Bank 0), den BASIC mit `::VCL` ausführt. Neu gegenüber 0.1:

- 8 KB gemeinsames RAM (`$0000–$1FFF`), Puffer `$1300–$1BFF` für VCL- und VMS-Listen zusammen, Objektliste 16 × 6 Byte bei `$0C50`.
- Geometrie, Texturen, Tapete und Sprites aus den P3/P5/P5b-Formaten; Karte DMP.
- `VIEW` nach Plan 5: Sichtbarkeit vorne → hinten mit Spaltenmaske, Ausgabe hinten → vorne; je Tiefe Tapete, Decke, Boden, Zellen außen → innen mit Wandflächen oder Objekten nach Unterposition; Beschneiden von Sprites am Sichtfenster und an verdeckten Spalten über VMS-Typ 3.
- `WALLSET` (WSM) und Sprite-Sätze v1 entfallen (0.1-Formate). Crawl wird in P7 über einen Konverter auf DVG/DTS/S2 gebracht (review-notes G.6).

Nicht in P6: `ENEMYSTEP` (Gegner-KI), Laufzeit-Animation, residente VMS-Listen in Bank 0 (Abschnitt 12), DTS v2.

## 2. Speicher

### 2.1 Gemeinsames RAM und Stub

- Der Stub schaltet während des Aufrufs `$D506` = (alt AND `$F0`) OR **`$06`** (8 KB unten gemeinsam; 0.1: `$05` = 4 KB) und `$FF00 = $7E`. Sonst unverändert (Interruptweiche `$FF05–$FFFF` in Bank 1, Zeropage nur `$FA–$FF`).
- Während des Aufrufs sieht die Lib unter `$2000` Bank 0. Folge: **keine Daten der Engine in Bank 1 unter `$2000`**. BASIC-Variablen in Bank 1 ab `$0400` sind davon nicht betroffen (sie werden nur außerhalb des Aufrufs benutzt; Korrektur zu P2a 4, review-notes G.16).
- Bank 0 `$1C00–$1FFF` ist VDC-BASIC v3; die Lib schreibt dort nie (BUFSET prüft, 3.3).

### 2.2 Bank 0

| Bereich | Inhalt |
|---|---|
| `$0B00–$0BFF` | frei (0.1: VCL-Puffer); Kassetten-/Bootsektorpuffer des Systems |
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
| `$0C0A–$0C0B` | VCLADR | `VIEW`: Adresse der VCL-Liste (= Pufferanfang) |
| `$0C0C–$0C0D` | VCLLEN | `VIEW`: Länge der VCL-Liste inklusive Ende-Byte |
| `$0C0E–$0C0F` | VMSLEN | `VIEW`: Bytes der VMS-Listen |
| `$0C10–$0C11` | OBJVIS | `VIEW`: Bit i = Objekt i wurde (ganz oder teilweise) ausgegeben |
| `$0C12–$0C3F` | – | Reserve |
| `$0C40–$0C4F` | – | nur Tests (Zeitmessung, Szenen-Hook wie 0.1) |
| **`$0C50`** | OBJN | Objektliste: Anzahl (0 … 16; größer wird als 16 gelesen) |
| `$0C51–$0CB0` | OBJL | 16 × 6 Byte (2.5) |
| `$0CB1–$0CFF` | – | Reserve |

### 2.4 Bank 1 (Speicherkarte F, Vorgabe)

Alle Adressen sind Parameter der Funktionen; die Tabelle ist die Vorgabe für Werkzeuge (Ladeadressen) und Spiele.

| Bereich | Größe | Inhalt | Standard-Ladeadresse (Werkzeug) |
|---|---|---|---|
| `$0000–$1FFF` | – | während des Aufrufs Bank 0 (gemeinsam): keine Engine-Daten | – |
| `$0400–$4FFF` | 19 KB | BASIC-Variablen; das Spiel begrenzt mit `POKE 57,0:POKE 58,80:CLR` als erster Anweisung auf `$5000` (interpretiert und Blitz!: in P6a gemessen, Abschnitt 12) | – |
| `$5000–$6FFF` | 8 KB | DMP (W·H ≤ etwa 4000), optional Arbeitskopie bei kleinen Karten | `dbemap` `$5000` (bisher `$8000`) |
| `$7000–$8FFF` | 8 KB | Sprite-Sätze S2 (mehrere hintereinander) | `dbespr` `$7000` |
| `$9000–$AFFF` | 8 KB | DTS Wand | `dbetex` `$9000` (bisher `$A000`) |
| `$B000–$CFFF` | 8 KB | **Lib**: Code und Tabellen, Sprungtabelle bei `$B000` | – |
| `$D000–$DFFF` | – | I/O (mit `$FF00 = $7E`); RAM darunter für die Lib nicht nutzbar | – |
| `$E000–$E7FF` | 2 KB | Lib-Variablen (BSS) | – |
| `$E800–$EFFF` | 2 KB | DVG | `dbegeom` `$E800` (bisher `$E400`) |
| `$F000–$F7FF` | 2 KB | DTS Boden | `dbetex` floor `$F000` |
| `$F800–$FDFF` | 1,5 KB | DTS Decke | `dbetex` ceiling `$F800` |
| `$FE00–$FEFF` | 256 B | DBG (24 + VH ≤ 124 Byte) | `dbetex bg` `$FE00` (bisher `$A900`) |
| `$FF00–$FF04` | – | MMU | – |
| `$FF05–$FFFF` | – | Kopie der Kernal-Interruptweiche | – |

Begründung: Das Demo-Wand-DTS mit 4 Stilen hat 8,7 KB (P5-Beispiel; mit `max_kerns` 16 weniger, review-notes G.1/G.2) und passt nicht in die bisherige Vorgabe `$A000–$A8FF`; die Lib wird größer als 4 KB (2.6).

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
| 1 | `MAPINIT` | P0 = DMP, P1 = Arbeitskopie (0 = keine; sonst 2·W·H Byte für Kachel- und Inhaltsebene), X Bit 0 = Automap-Bit „gesehen“ in `VIEW` setzen (nur mit P6f, sonst ignoriert) | prüft Magic, Version, Offsets, Länge; Startzelle und -richtung übernommen (wie `SETPOS`); OBJN = 0; X = W, Y = H; P0 = Startzelle, P1 = Startrichtung. A = 1 Format; A = 6, wenn die Arbeitskopie [P1, P1 + 2·W·H) nicht ganz in `$2000` … `$AFFF` liegt (unter der Lib; Lib, BSS, DVG, I/O und MMU bleiben unberührt; darunter gemeinsames RAM) |
| 2 | `SETPOS` | P0 = Zelle, X = Richtung | A = 0; 6, wenn Zelle ≥ W·H (Position unverändert) |
| 3 | `MOVE` | X = Aktion (3.4) | P6f |
| 4 | `VIEW` | P0 = Bildpuffer im VRAM (AP) | VCL-Liste im Puffer; A = 0, 2 (gekürzt) oder 3 (Ränder weggelassen); X = Einträge (höchstens 255), Y = 0; P0 = VCLADR; VCLLEN, VMSLEN, OBJVIS (2.3). A = 5 ohne GEOMSET/MAPINIT |
| 5 | `CELL` | P0 = Zelle | X = Kachelindex, Y = Inhaltsbyte, P1 = Kachel-Flags; außerhalb: A = 6, X = Außenkachel, Y = 0 |
| 6 | `SETCELL` | P0 = Zelle, X = Kachelindex | A = 0; 6 bei Zelle außerhalb oder X ≥ NT |
| 7 | – | – | A = 255 (`ENEMYSTEP` reserviert) |
| 8 | – | – | A = 255 (`WALLSET` entfällt) |
| 9 | `SPRITESET` | X = Satz 0 … 7, P0 = S2 (0 = Satz löschen), P1 = VRAM-Basis | prüft `"S2"`, Version, ID (0 oder = DVG-ID), D, Stride; A = 1 Format, 4 Geometrie, 5 ohne GEOMSET, 6 Satznummer/Pool |
| 10 | `ITEMSET` | X = Gegenstand 0 … 63, Y = Satz + 1 (0 = keiner) | A = 0; 6 bei X ≥ 64 oder Y > 8 |
| 11 | `POOLSET` | P0 = Poolanfang, P1 = Poolende (exklusiv, 0 = 65536); beide 0 = keine Prüfung | A = 0; TEXSET/BGSET/SPRITESET prüfen danach Basis … Basis + U ⊆ Pool |
| 12 | `GEOMSET` | P0 = DVG, P1 = origin (`$FFFF` = aus der DVG) | prüft Magic, Version, Elementlänge 16, Tiefeneintrag 8, VW ≤ 80, VH ≤ 100, D ≤ 7, NE ≥ 1; Zeilentabelle; TEXSET/BGSET/SPRITESET mit anderer ID werden gelöscht (Bit je Satz in Y: Bit 0–2 DTS, Bit 3 DBG; X = Bits der S2-Sätze); A = 1 Format |
| 13 | `TEXSET` | X = Art (0 Wand, 1 Boden, 2 Decke), P0 = DTS (0 = löschen), P1 = VRAM-Basis | prüft `"DT"`, Version 1, Art = X, ID, NE, D, Stride; A = 1, 4, 5, 6 |
| 14 | `BGSET` | P0 = DBG (0 = keine Tapete), P1 = VRAM-Basis, X = Füllbyte ohne DBG | prüft `"DB"`, Version, VW, VH, ID; A = 1, 4, 5, 6 |
| 15 | `BUFSET` | P0 = Pufferanfang, P1 = Pufferende (exklusiv) | A = 0; 6, wenn Anfang < `$0200`, Ende > `$1C00` oder Länge < 64 (alter Puffer bleibt) |
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

Der Puffer [B0, B1) liegt im gemeinsamen RAM (Bank 0, unter `$1C00`). `VIEW` schreibt die VCL-Liste ab B0 und die VMS-Listen unmittelbar dahinter (Grenze = Länge der VCL-Liste, aus der Größenrechnung bekannt, 5.10). Größe Standard 2304 Byte.

### 3.4 MOVE (P6f)

| X | Aktion |
|---|---|
| 0 / 1 | vor / zurück |
| 2 / 3 | seitwärts links / rechts |
| 4 / 5 / 6 | drehen links / rechts / umdrehen |

Drehen: Richtung ändern, X = 0. Schritt: Zielzelle nach Richtung; außerhalb der Karte → X = 1, Y = Außenkachel; Kachel-Flag WEG → X = 1, Y = Kachel; Objekt der Liste auf der Zielzelle ohne Bit 7 (blockiert nicht) und ohne Bit 6 → X = 2, Y = Objektindex; sonst Position = Ziel, X = 0, Y = Kachel. Immer: P0 = Position, P1 = Inhaltsbyte der Position, P2 = Index des ersten Ereignisses der Position in der DMP-Ereignisliste oder `$FFFF`. A = 0.

## 4. Zustand der Lib (BSS)

| Name | Inhalt |
|---|---|
| Karte | Adressen Kachelebene, Inhaltsebene (Arbeitskopie oder DMP), Kacheltabelle, Ereignisse; W, H, NT, NE_ev, Außenkachel |
| Position | pos (Zellindex), px, py (bei SETPOS/MOVE per fortgesetzter Subtraktion berechnet), v |
| DVG | Adresse, VW, VH, D, S, NE, stride, origin, ID, Horizont y0/y1, Adressen Tiefentabelle und Elementtabelle; Zeilentabelle `row[y] = origin + y · stride` (y < VH) |
| DTS[3] | gültig, VRAM-Basis, NS, NST, Adressen Slotkarte, Stiltabelle, Verzeichnis |
| DBG | gültig, VRAM-Basis, P, y0, h, Flags, o_v (für die aktuelle Richtung in VIEW gewählt), Adresse der Füllbytes; Füllbyte ohne DBG |
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
  - `cover`: verdeckt für alles hinter P_{d+1} und für Objekte und Seiten derselben Tiefe weiter außen.
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
    tapete(d)                                   # 5.7, STOP möglich
    for (c0, c1, ziel) in pend: mark(bcov, c0, c1); if ziel == beide: mark(cover, c0, c1)
    if ncov == VW: break                        # ncov zählt belegte Spalten in cover
```

- **5.2a Kachel-Flag INHALT (Nutzerentscheidung 4, DMP Bit 5):** Zellen mit Flächen und diesem Flag (Tür, Gitter, Bogen) zeigen auch ihre Objekte. Die Zelle trägt ihre Elemente in der Sichtliste in der Reihenfolge **Fronten, Objektplatz, Seiten** ein (statt DVG-Reihenfolge Front, Seite, Objektplatz), die Ausgabe rückwärts malt damit Seitenfläche, Objekte nach Unterposition, Front. Zellen = Gruppen gleichen s in der DVG (P3 5.3: zusammenhängend); alle anderen Zellen unverändert in DVG-Reihenfolge. Das Flag ändert die Abdeckung nicht.
- `mark` setzt Bytes auf 1 und erhöht ncov für neu belegte Spalten von `cover`.
- Elemente FLOOR/CEIL werden in der Schleife nicht ausgegeben (nur in `baender`).
- Die Sichtliste wird bei der Ausgabe **rückwärts** abgearbeitet (5.11). Daraus folgt die Malreihenfolge je Tiefe D … 0: Tapete, Decke (Grund, Kacheln), Boden (Grund, Kacheln), Zellen außen → innen, je Zelle Seite vor Front bzw. Objekte hinten → vorne. Das ist Plan 5 mit review-notes B.1–B.3: Seitenflächen einer Tiefe verdecken erst nach den Objekten und Bändern dieser Tiefe; Fronten verdecken sofort (Seiten und Objekte derselben Tiefe weiter außen liegen hinter ihnen).

### 5.3 Wände

`WALL(e, ent)`: Ziel T0 = AP + row[e.y] + e.x. Ausgabe nach P5 4.4: je Kern ein `VMC` (VCL-Typ 2 bei srcstep 0, sonst 3), dann bei RAND ein `VMS` (Typ 12) mit der kopierten Liste. Wände und Kacheln werden **nicht** beschnitten (das DVG-Rechteck liegt im Fenster).

### 5.4 Abdeckung – Annahmen

- Eine Abdeckung in `cover` aus Tiefe d gilt für alle Zeilen von P_{d+1} (P3 4.4). Objekte werden spaltenweise beschnitten; ein Sprite, das höher ist als die Wand an seiner Tiefe, verliert dabei Teile über der Wandoberkante (P5b 3.4 warnt).
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

Zeilenbereiche (oben nach unten): Deckenband d, falls `lueckeDECKE`; Horizont [hy0, hy1), falls d = D; Bodenband d, falls `lueckeBODEN`. Leere Bereiche entfallen, aneinandergrenzende werden verbunden. Folgen = `spans(bcov)`. Anhängen: Bereiche **von unten nach oben**, je Bereich die Folgen **von rechts nach links**, je Paar `add(BG(r0, r1, c0, c1))`.

`BG(r0, r1, c0, c1)` (P5 6.2):
- **Ohne DBG:** Füllbyte f aus `BGSET`: ein Eintrag Typ 4 (r1 − r0 = 1) bzw. Typ 5 (`AP + row[r0] + c0`, f, c1 − c0, reps r1 − r0, step stride).
- **Mit DBG** (Panoramazeilen [y0, y0 + h), Versatz o = o_v der Richtung v):
  1. Zeilen über dem Panorama [r0, min(r1, y0)) und darunter [max(r0, y0 + h), r1): Füllbytes je Zeile aus der DBG, gleiche aufeinanderfolgende gruppiert, Typ 4/5 wie bei ZEILEN.
  2. Panoramazeilen [a, b) = [max(r0, y0), min(r1, y0 + h)), falls nicht leer: Quellspalte q = (o + c0) mod P, n = c1 − c0. Wenn q + n ≤ P: ein Typ 3 (`VB + (a − y0) · P + q`, `AP + row[a] + c0`, n, reps b − a, step stride, srcstep P). Sonst (nur mit WRAP) zwei Typ 3: n1 = P − q ab q, dann n − n1 ab Quellspalte 0 an Zielspalte c0 + n1.
  3. Reihenfolge der Einträge: über, Panorama (Teil 1, Teil 2), unter.

Reihenfolge der Bereiche und Teile im Bild ist gleichgültig (sie überdecken sich nicht), für den Listenvergleich aber festgelegt.

### 5.8 Objekte: `objekte(d, e, c)`

1. Kandidaten der Zelle c: Objekte i der Liste (i < OBJN, Zellindex = c, Bit 6 von Byte 5 = 0) mit p = SUBPOS[v][q] (q = Byte 5 AND 7, q > 4 → 4; Tabelle P4 2.6); Gegenstand g = Inhalt(c) AND 63, falls g ≠ 0 und `itemtab[g]` ≠ 0, mit p = 2, Satz `itemtab[g]` − 1, Richtung `$FF`, Phase ITEMPH.
2. **Malreihenfolge:** p aufsteigend (0 hinten links, 1 hinten rechts, 2 Mitte, 3 vorne links, 4 vorne rechts; P3 3.3); bei gleichem p zuerst der Gegenstand, dann Objekte nach i aufsteigend. **Anhängen in umgekehrter Malreihenfolge.**
3. Je Kandidat: Satz ungültig → überspringen; a = 0 bei Richtung `$FF`, sonst (2 + v − o) AND 3; Bild = `lookup(Satz, f, a, d)` (P5b 6.3; f ≥ NP → 0; `$FF` → Phase 0; `$FE` → überspringen).
4. Anker (ax, ay) = e.anchor[p] (vorzeichenbehaftete Byte-Spalte, Zeile); x0 = ax − fx, y0 = ay − fy (16 Bit vorzeichenbehaftet).
5. Ausschnitt: cx0 = max(x0, 0), cx1 = min(x0 + w, VW), cy0 = max(y0, 0), cy1 = min(y0 + h, VH); leer → überspringen. Dann in `cover`: erste freie Spalte ≥ cx0 und letzte freie Spalte < cx1 suchen; keine → überspringen; cx0 = erste, cx1 = letzte + 1.
6. `add(SPRITE(Satz, Bild, x0, y0, cx0, cx1, cy0, cy1))`; Objekte decken nichts ab. Bei Annahme: OBJVIS Bit i setzen (nur Listenobjekte).

### 5.9 Beschneiden

Sprites und Bänder mit Rand werden mit `clip_image` (P5b 6) geschnitten. Ziel eines Kerns: `AP + row[Zeile] + Spalte`; Ziel einer beschnittenen VMS-Liste: `AP + row[cy0] + cx0`; unbeschnitten `AP + row[y0] + x0` (dann gilt y0 ≥ 0, x0 ≥ 0). VMS-Quelle immer `VB + rand_ofs` (die übersprungenen Bytes am Anfang erledigt Typ 3). Die 6502-Fassung rechnet ofs' mit einem laufenden Zeilenanfang (keine Multiplikation) und bricht ab, sobald r ≥ B.

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

- Abbruch verliert die **hinteren** Teile (der Durchlauf geht vorne → hinten). Bänder und Tapete einer Tiefe kommen nach deren Zellen; bricht es dort ab, bleiben Zeilen der Tiefe ungezeichnet (alter Bildinhalt). Das ist ein Fehlerzustand (A = 2), kein Normalfall; Spiele messen ihre Szenen (Bericht `dbeview budget`, 9.1).
- A = 2 hat Vorrang vor A = 3.

### 5.11 Ausgabe (hinten → vorne)

VCL ab B0, VMS-Zeiger ab B0 + nv. Die Sichtliste wird vom letzten zum ersten Eintrag ausgegeben; jeder Eintrag schreibt seine VCL-Einträge (5.5) und kopiert seine VMS-Liste (verbatim bzw. beschnitten, P5b 6.2) an den VMS-Zeiger. Am Ende ein Byte 0. VCLADR = B0, VCLLEN = nv, VMSLEN = nm, X = min(Anzahl VCL-Einträge, 255).

Die VCL-Liste liegt damit fest bei B0: `SYS3331,4:::VCL 4864` (= `$1300`) im Spiel; mit `BUFSET` an einer anderen Stelle entsprechend.

## 6. Ausgabe-VCL-Typen

Alle Parameter als Wort (Low/High), auch Bytewerte (VDC-BASIC `vcl-format.md`).

| Typ | Länge | Felder | Verwendung |
|---|---|---|---|
| 2 | 11 | src, dst, count, reps, step = stride | Kerne mit srcstep 0 |
| 3 | 13 | src, dst, count, reps, step = stride, srcstep | Kerne mit srcstep ≠ 0, beschnittene Kerne, Tapete (srcstep P) |
| 4 | 7 | vaddr, byte, count | Zeilenfüllung, eine Zeile |
| 5 | 11 | vaddr, byte, count, reps, step = stride | Zeilenfüllung, mehrere gleiche Zeilen |
| 12 | 7 | src, dst, list | Rand (VMS); Liste im Puffer, Befehle Typ 1, 3, 8 |
| 0 | 1 | – | Ende |

Nicht benutzt: 1, 6, 7, 8 (`RXV` lädt das Spiel), 13. Grenzen: reps ≤ 100 (VH), count ≤ 80, VMS-Typ-1-Länge ≤ 255.

## 7. Grenzen

| Größe | Grenze | bei Überschreitung |
|---|---|---|
| DVG | NE ≤ 255 (keine Kopie, die Lib liest die Tabelle direkt; 0.1-`MAXWS` entfällt, review-notes C.3), VW ≤ 80, VH ≤ 100, D ≤ 7, S ≤ 15 (P6d: höchstens 31 Zellen je Tiefe) | GEOMSET A = 1 |
| DTS | NST ≤ 32 (Stilzeilentabelle, P6d) | TEXSET A = 1 |
| DBG | P ≥ 1 | BGSET A = 1 |
| Wartebereich je Tiefe | 16 deckende Seiten bzw. Fronten ohne DVG-Bit 3 (P6d) | A = 2 (Tabellen voll) |
| Sichtliste | MAXITEM = 96 | A = 2 |
| Puffer | BL (Standard 2304) für VCL + VMS zusammen | A = 2 bzw. 3 (5.10) |
| Objektliste | 16 | mehr wird ignoriert |
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
class Scene: dvg, dmp, dts[3], dbg, bgfill, s2[8], vram_bases, itemtab, objects, itemph, pos, dir, ap, buf=(0x1300, 0x1C00)
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
| P4 (`dbemap`, `crawlmap`) | Standard-Ladeadresse `$5000` | Speicherkarte |
| P5 (`dbetex`) | `max_kerns` 0 … 16; `vms_buffer` → Prüfung „VCL + VMS je Bild gegen den gemeinsamen Puffer 2304“; Standard `load` Wand `$9000`, Boden `$F000`, Decke `$F800`, DBG `$FE00`; `sim_vms` Typ 3 (P5b) | review-notes G.1–G.3 |
| P5 4.4/4.6 | Formatregel VMS-Listen (Zeilenreihenfolge, steigender ofs, Lauf in einer Zeile) ausdrücklich | Beschneiden, G.7 |
| `engine-design.md` | Funktionstabelle, Speicher 3.1 → Verweis auf P6 (P8) | – |

## 12. Offene Punkte

1. **Blitz!-Variablen in Bank 1 – geprüft in P6a, Ergebnis: Karte F bleibt.** Messung mit `test/vice_blitzvars.py` (VICE, Haltepunkte an zwei `SYS`-Marken; Bank 1 `$5000–$FEFF` vorher mit `$A5` gefüllt, danach auf Änderungen geprüft; Zeiger `$2D–$3A` gelesen), Programme „passt“ (Felder 3 KB, 61 Strings, Müllsammlung) und „Stress“ (Strings bis `OUT OF MEMORY`), je interpretiert und als Blitz!-Kompilat (Image 2, über `BOOT`):
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
4. **DVG-Bit 3** setzt `dbegeom` erst mit P6h; die Referenz und ihre Tests behandeln beide Fälle (Bit fehlt: Fronten tragen `bcov` erst am Tiefenende ein, Pixel gleich).
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
3. `MAPINIT`: Arbeitskopie nur in `$2000 ≤ P1` und `P1 + 2·W·H ≤ $B000` (ohne 16-Bit-Überlauf), sonst A = 6 und keine gültige Karte (wie bei A = 1). Test: genau unter `$B000` ok; ein Byte darüber, ab `$B000`, BSS, DVG, I/O, unter `$2000`, `$0400`, Überlauf: A = 6 und danach `CELL` A = 5. Die untere Grenze `$2000` ist im sim65-Harness nicht positiv testbar (dort liegt das Programm).
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
