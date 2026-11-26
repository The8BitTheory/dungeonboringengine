# P6k – Wo kostet `VIEW` in Engine 0.2 pro Wandteil so viel? (Analyse, nichts geändert)

Stand: 2026-11-26, Branch `step2/textures-0.2`, HEAD `c78434e` (P6i/P6j). Geprüft gegen: `engine/lib.s` sha256 `feb96458…`, `engine/view.s` `e637a55c…`, `engine/dbe.inc` `fe1bd419…`, `build/sim/viewsim.prg` `4f81f699…` (Build vom 2026-11-26 09:21, jünger als alle Quellen). Es wurde nichts am Code, an `tools/crawlconv.py` oder an Tests geändert; Messdaten und Skripte liegen in `build/p6k/` (nicht versioniert).

## 1. Methode

- **Profiler:** der Mini-6502 `prof6502.py` (NMOS, dokumentierte Opcodes, Zyklen je PC) führt das echte `viewsim.prg` aus (Lib wie im sim65-Harness, `test/sim/viewsim.c` nachgebildet: Szenendatei von `run_sim.ViewRunner.setup`, dieselben Setz-Aufrufe, danach `VIEW`). Zyklen je PC werden den Labels aus `build/sim/viewsim.lbl` zugeordnet (nächstes davorliegendes globales Label = „exklusiv“; Aufrufe über JSR/RTS-Verfolgung = „inklusiv“, dazu Aufrufer von `allcov_*`/`mark_*`). Zusätzlich Zählpunkte bei `itemadd` (Eintragstyp 0 Wand, 2 Tapete, 3 Sprite) und nach `allcov` in `vwall`.
- **Gegenprobe:** Profil-Summe 26 092 (pos 67, Richtung 3) gegen `run_crawl._cycle_job` 26 041; die Differenz sind die ca. 50 Zyklen für Dispatcher/Eintritt (Messung im sim65 ist „Lauf mit F = 4 minus Lauf mit F = 7“).
- **Umfang:** alle 400 Crawl-Ansichten ohne Geist (freie Zellen × 4 Richtungen, `--fix`-Modus, Automap aus), Mittel 16 939 Zyklen, Maximum 26 092. Daraus Regression (kleinste Quadrate, eigene Routine, kein numpy) je Routine auf die Merkmale der Ansicht. Dazu 56 Ansichten der Demo-Karte (`docs/specs/examples/demo.toml`, `dbeview.build_demo_assets`, Wände, Gitter, Boden-/Deckenbänder, DBG; ohne Objekte), das ist **nicht** die Westwood-140-Szene (s. Abschnitt 6).
- Alte Fassungen wurden nicht neu gemessen; 0.1-Werte stammen aus `cmp01.json` des Auftrags, das 0.1-Verhalten aus `git show v0.1:engine/lib.s` (Lesen des Codes).

## 2. Was „pro Wandteil“ in Crawl wirklich enthält

Die 13 Einträge der langen Ansichten sind **nicht** nur Wände:

| Ansicht | Einträge (itemadd) | Tiefen (`vdepth`) | `vwall`-Aufrufe | Zyklen 0.2 |
|---|---|---|---|---|
| pos 21 Richtung 0 (Wand voraus) | 3 Wände | 2 | 6 | 7 441 |
| pos 67 Richtung 3 | 7 Wände, 4 Gegenstands-Sprites (Gems, Typ 2-Kerne 6×6), 1 Tapete (Typ 5) | 4 | 10 | 26 092 |
| pos 74 Richtung 3 | wie 67 | 4 | 12 | 25 423 |

Die Differenz „viel − wenig“ (18 651) enthält daher 4 zusätzliche Wände, 4 Sprites, 1 Tapete und 2 zusätzliche Tiefen. Aus der Regression über alle 400 Ansichten (rmse 174 Zyklen):

`Zyklen ≈ −594 + 1 337·Wand + 2 017·Sprite + 549·Tapete + 125·(verworfene Wand) + 591·(verworfener Sprite-Kandidat) + 1 782·Tiefe`

Mittel je Ansicht: 4,42 angenommene Wände, 1,77 Sprites, 0,72 Tapeten, 4,73 durch `allcov` verworfene Wände (**52 % aller `vwall`-Aufrufe: 1 894 von 3 660 werden von cover verworfen, 0 durch resolve**), 3,5 Tiefen. Die „≈ 1 500 je Wandteil“ sind also ≈ 1 340 je Wand, ≈ 2 000 je Gegenstand und ≈ 1 800 je Tiefe, gemischt.

### 2.1 Profil der drei Szenen (exklusiv, Zyklen)

| Routine | wand | v67 | v74 | v67 − wand |
|---|---|---|---|---|
| vspr | 0 | 2 542 | 2 236 | 2 542 |
| vobjc | 0 | 2 508 | 1 827 | 2 508 |
| vwall | 1 118 | 2 315 | 2 435 | 1 197 |
| gwall (Kerne schreiben) | 921 | 2 160 | 2 160 | 1 239 |
| vcells | 979 | 2 074 | 2 132 | 1 095 |
| vdepth | 805 | 1 760 | 1 760 | 955 |
| clipkerns | 0 | 1 188 | 1 188 | 1 188 |
| gsetx (+gsetup) | 294 | 1 094 | 1 094 | 800 |
| itemadd | 246 | 1 016 | 1 016 | 770 |
| resolve | 399 | 931 | 931 | 532 |
| allcov_c | 284 | 805 | 945 | 521 |
| mark_b | 297 | 786 | 786 | 489 |
| f_view | 616 | 756 | 756 | 140 |
| cellptr | 340 | 748 | 748 | 408 |
| mark_c | 279 | 748 | 748 | 469 |
| ckwrite | 0 | 520 | 520 | 520 |
| grl | 0 | 448 | 448 | 448 |
| emit_vmc | 0 | 368 | 368 | 368 |
| vneed | 90 | 360 | 360 | 270 |
| vt5 | 0 | 360 | 360 | 360 |
| dstxy | 0 | 293 | 293 | 293 |
| vtap | 88 | 283 | 283 | 195 |
| rtab | 234 | 255 | 255 | 21 |
| gspr | 0 | 240 | 240 | 240 |
| gen | 33 | 183 | 183 | 150 |
| vband | 76 | 152 | 152 | 76 |
| Rest | 342 | 1 199 | 1 199 | 857 |
| **Summe** | 7 441 | 26 092 | 25 423 | 18 651 |

(`vspr`, `vobjc`, `clipkerns`, `ckwrite`, `grl`, `emit_vmc`, `vt5`, `dstxy`, `gspr` gehören den Gegenstands-Sprites und der Tapete.)

### 2.2 Kosten je Wand, je Routine (Regression, alle 400 Ansichten)

| Routine | Zyklen je angenommener Wand | Bemerkung |
|---|---|---|
| vwall (Prolog, Feldlesen, deck, Aufruf `allcov`/`mark`) | 320 | davon ≈ 100 allcov-Test, ≈ 85–95 Marken-Rest (Tail) |
| gwall (Kern als Typ 2 direkt schreiben) | 307 | 11 Byte, 16-Bit-Additionen src/dst, `rows`-Zugriff, `nent` |
| resolve | 133 | Slotkarte → Stilzeile → Verzeichnis; immer neu berechnet |
| gsetx + gsetup | 98 + 14 | VRAM-Basis, Inhaltsanfang, Kernzahl lesen |
| mark_c | 115 | Intervallliste cover |
| mark_b | 121 | Intervallliste bcov |
| itemadd | 82 | Zustand sichern (svp/smp/snent/isp), `gen`-Sprung |
| allcov_c | 58 | (+ 61 je verworfene Wand) |
| vneed | 30 | |
| vcells (anteilig) | 32 | |
| vdepth (anteilig) | 86 | |
| mark_seen | 13 (ohne Automap) | mit Automap ≈ 57 |
| gen, übrige | ≈ 25 | |
| **Summe** | ≈ 1 337 | |

0.1 für denselben Eintrag ≈ 420: dort ist die Wand ein fertiger 8-Byte-Eintrag (src, dst, w, h aus der Tabelle), Sichtbarkeit `col_free` = Suche der ersten freien Spalte im Byte-Array `cover` (bricht meist bei der ersten Spalte ab, ≈ 30 Zyklen), `cover` markieren = Schleife über die Spalten, Ausgabe = zwei 16-Bit-Additionen (src + `da`, dst + `ap`) und `emit_vmc`. Keine Auflösung von Stil, kein Kern-Lesen, keine Größenrechnung (Liste hat feste Größe `MAXVIS`).

### 2.3 Teilprofil cover/bcov (die Frage des Nutzers), Zyklen je Ansicht

| Posten | Crawl (400 Ansichten) | Demo (56 Ansichten) |
|---|---|---|
| `vwall`: Rechteck lesen und `allcov`-Setup (Zeilen bis `jsr allcov_c`) | 313 | 361 |
| `allcov_c` aus `vwall` (inkl. Aufruf; 9,15 bzw. 10,6 Aufrufe, je ≈ 55–60) | ≈ 500 | ≈ 640 |
| `mark_c` (Fronten sofort + Seiten über Wartebereich), 117 je Aufruf | 451 | 412 |
| `mark_b` (bcov), 123 je Aufruf | 477 | 438 |
| Wartebereich-Schleife in `vdepth` (Aufrufe, `pd_*`) | 229 | 304 |
| `vwall`-Tail (`wdeck`, c0/c1 lesen, Bit 3, `pd_*` schreiben) | 376 | 458 |
| `allcov_c` aus `vspr` (Sprites ganz verdeckt) | 154 | – |
| `spans` | 97 | 265 |
| **Summe cover/bcov-Verwaltung** | ≈ 2 360 (14 % von 16 939) | ≈ 2 700 (11 % von 25 081) |

Je angenommener Wand sind das ≈ 535 (Crawl) von ≈ 1 337 Zyklen, also 40 %. In Crawl sind Boden- und Deckenband leer (`fy0 = fy1 = 0`); bcov wird dort nur für die Horizont-Tapete der Tiefe D (0,72 je Ansicht) gebraucht, aber vollständig mitgeführt.

## 3. Weitere Befunde (nicht Wandteil, aber groß)

- **Automap** (MAPINIT X = 1 mit Arbeitskopie, 240 Ansichten): +572 Zyklen je Ansicht (+3,3 %), +130 je Wand. Davon `vauto` ≈ 425 je Ansicht: die Schleife über alle Zellen läuft auch, wenn die Tiefe gar keine Bodenzeilen hat (`gr_fc` bleibt überall `$FF`, in Crawl immer), und `mark_seen` ≈ 57 je Wand.
- **Gegenstands-Sprites:** 2 017 je angenommenem Sprite plus 591 je verworfenem Kandidaten, 75 % der Crawl-Ansichten haben mindestens einen. Aufteilung je Sprite: vspr 538, vobjc 314, clipkerns 297, ckwrite 130, grl 112, gsetx 102, emit_vmc 92, itemadd 90, allcov 60, gspr 60, dstxy 59, vt5 72, vneed 30.
- **Tiefe:** 1 782 je Tiefe (3,5 Tiefen), darin `vcells` 467, `vdepth` 292, vobjc/vspr-Kandidaten ≈ 437, `cellptr` 202 (je Zelle ≈ 74 inklusive Aufruf, 9,5 Aufrufe je Ansicht).
- **Feste Kosten:** `f_view` + `rtab` + `vfin` + `vjump` + `dispatch` ≈ 1 000 je Ansicht.

## 4. Vorab berechenbar? Statische Analyse der Geometrie

Crawl-DVG: D = 3, S = 1, VW = 68, 28 Elemente (13 Fronten, 6 Seiten, 9 Objektplätze), 11 Zellen. Demo-DVG: D = 3, S = 3, VW = 70, 79 Elemente, 25 Wände.

Minimale Mengen deckender Elemente, deren Vereinigung das Rechteck eines Elements ganz verdeckt (Reihenfolge des Sichtdurchlaufs, Fronten sofort, Seiten erst am Tiefenende):

| | Crawl | Demo |
|---|---|---|
| Wände mit DVG-Bit 0 (deckfähig) | 18 von 19 | 25 von 25 |
| Elemente, die überhaupt verdeckt werden können | 16 von 19 | 22 von 25 |
| minimale Mengen je Element | 1–3, **alle von Größe 1** | 1–9, Größe 1, 2 und 3 |
| Summe aller Mengen | 30 | 79 |

Spaltengrenzen (alle c0/c1 deckfähiger Elemente plus 0 und VW; die Rechteckränder `x`, `x + w` sind alle schon Grenzen):

| | Segmente | Bytes als Bitmaske |
|---|---|---|
| Crawl | 7 | 1 |
| Demo | 13 | 2 |

## 5. Maßnahmen

Alle Zahlen sind Schätzungen aus gezähltem Code gegen die gemessenen Zyklen oben (es wurde nichts prototypisiert); jede Maßnahme verlangt vor dem Einchecken die Referenzprüfung (Abschnitt 5.4).

### 5.1 M1 – cover und bcov als Segment-Bitmasken (Empfehlung, ersetzt die Intervalllisten)

Idee: GEOMSET bestimmt aus allen c0/c1 der Elemente mit DVG-Bit 0 die sortierten Spaltengrenzen b₀ = 0 < b₁ < … < b_n = VW (n ≤ 16 Segmente, sonst GEOMSET-Fehler oder Rückfall auf die alte Liste). Jedes Segment ist eine Spaltenfolge, die von **jeder** Markierung ganz oder gar nicht belegt wird. Daraus folgt: cover und bcov sind jeweils 1–2 Byte (Bit i = Segment i belegt), und alles bleibt exakt:

- Markieren `[c0, c1)`: `cov |= cm[e]` (je Element beim GEOMSET die Bitmaske der Segmente von c0 bis c1; 1 Byte: `ldy ecur / lda cov / ora cm,y / sta cov` ≈ 15 Zyklen, 2 Byte ≈ 30).
- `allcov(x, x + w)`: `(cov & rm[e]) == rm[e]` mit `rm[e]` = Segmente, die das Rechteck schneiden (angeschnittenes Segment zählt voll; ein nicht belegtes Segment hat keine belegte Spalte, ein belegtes ist ganz belegt, damit ist der Test exakt). ≈ 15 Zyklen (1 Byte). `ecur` (Elementindex) wird in `vwall` ohnehin später berechnet und nur nach vorne gezogen.
- Sprites (Rechteck [cx0, cx1) beliebig): Tabelle Spalte → Segment (VW ≤ 80 Byte) und zwei kleine Bit-Bereichstabellen; ≈ 50–60 statt ≈ 68 Zyklen.
- cover ganz belegt (`vdepth`-Abbruch, `ncov == VW`): `cov == voll`, 1 Vergleich statt der Intervallprüfung.
- `spans(bcov)`: Läufe freier Bits der Maske, Grenzen aus der Tabelle; gleiche Regel (> 4 Folgen → eine Folge), 1–2 Byte statt Listenlauf: Crawl ≈ −55, Demo ≈ −150 je Ansicht. `vband`/`vtap`/`vauto`/`addrng` lesen bcov nur noch über dieselben zwei Routinen.
- Der Wartebereich (`pd_c0/pd_c1/pd_both`, MAXPEND 16, 48 Byte) wird zu einer Liste von Elementindizes (je Eintrag 2 Bits für beide/nur bcov, im Index oder getrennt), die am Tiefenende zwei `ora` kostet.

Die Marken und ihre Bedingungen bleiben **Laufzeitentscheidungen exakt wie heute**: markiert wird nur, was angenommen wurde und `deck(e, t, ent)` erfüllt (DVG-Bit 0 und Kachel-DECKEND und `EF_DECK` des Stils aus `resolve`). Damit decken Gitter, Fenster, Bögen und alle Stile ohne DECKEND nichts ab, INHALT-Kacheln (Durchläufe Fronten, Objekte, Seiten) verändern die Reihenfolge nicht, und die Bit-3-/`pend`-Semantik (Front mit Bit 3: bcov sofort, sonst am Tiefenende; Seiten: Wartebereich beide) bleibt wörtlich erhalten. **Die Liste bleibt bytegleich** (gleiche Einträge, gleiche Reihenfolge, gleiche Überlauf- und Abbruchentscheidungen), Automap „gesehen“ (`mark_seen` hängt am gleichen Verwerfen) und das Verwerfen ganz verdeckter Sprites bleiben unverändert, weil die Mengen dieselben sind; `dbeview.py` bleibt die Referenz ohne Änderung.

Erwartete Ersparnis (Zyklen je Ansicht):

| Posten | Crawl | Demo |
|---|---|---|
| `allcov`-Test Wände (≈ 100 → ≈ 40 je `vwall`-Aufruf) | −445 | −445 |
| Markieren cover + bcov, Wartebereich, `vwall`-Tail (1 533 → ≈ 280; Demo 1 612 → ≈ 380) | −1 250 | −1 230 |
| Sprite-`allcov` | −45 | – |
| `spans`, `allcov_b` in Bändern | −55 | −175 |
| **Summe** | **≈ −1 800 (−10,6 %, 16 939 → ≈ 15 100)** | **≈ −1 850 (−7,4 %, 25 081 → ≈ 23 200)** |
| je angenommener Wand | ≈ −410 (1 337 → ≈ 930) | ≈ −300 |

Platz: freigegeben werden die Intervall-Makros (`allcov_c` 41, `allcov_b` 41, `mark_c` 156, `mark_b` 161, `spans` 85 Byte ≈ 480 Byte Code) und BSS (`cv_s/cv_e/bc_s/bc_e` 4 × 41 = 164, `pd_*` 48, `sp_c0/c1` 10 ≈ 220 Byte). Neu: ≈ 40 Byte je Maske in `view.s` plus GEOMSET-Pass (Grenzen sortieren/eindeutig, `cm`/`rm` je Element, Spalte → Segment, ≈ 150–250 Byte Code) und Tabellen `cm`/`rm` je Wand (Crawl 19 × 2 Byte, Demo 25 × 4 Byte; allgemein NE ≤ 255, aber nur Wand-Elemente ≤ 96 nötig) und Spalte → Segment (VW ≤ 80 Byte), alles in dem freigewordenen BSS (Reserve vorher 125 Byte, nachher > 300). Code-Reserve (heute 199 Byte) wächst netto um ≈ 200–300 Byte; **M1 schafft damit den Platz für M3**. Alternative: Grenzen und Masken im Werkzeug (`dbegeom`) berechnen und im DVG ablegen (Formatänderung der DVG, spart den GEOMSET-Code).

Aufwand: mittel (GEOMSET-Pass, `vwall`, `vdepth`, `spans`, `vtap`, `vband`, `vspr`, `vauto`; dbeview bleibt, Testsätze bleiben).

### 5.2 Bewertung des Vorschlags „Entscheidungsbaum je Element mit Zell-Bitmasken“

Gleichwertig zu M1 in Crawl, in der Demo schlechter, und er löst bcov nicht:

- Je Element eine Liste minimaler deckender Mengen (Elementbits, nicht „Zelle ist Wand“: nur **deckende Flächen** dürfen verdecken, also ein Bit je Front/Seite des DVG-Elements, gesetzt zur Laufzeit nach `deck(e, t, ent)` mit dem Stil aus `resolve`, INHALT-Zellen wie heute nach dem Durchlauf, in dem sie markieren). Test: `(mask & S) == S` je Alternative.
- Crawl: alle Mengen von Größe 1 (Abschnitt 4), 19 Bits = 3 Byte; Test = `mask & C[e] ≠ 0` ≈ 30–35 Zyklen, Markieren = ein Bit setzen ≈ 20 Zyklen. Das wäre ungefähr M1 (≈ −1 700), setzt aber die Vorab-Enumeration der Mengen voraus.
- Demo: bis zu 9 Alternativen der Größe 2–3 je Element; ≈ 9 × 35 = 300 Zyklen im schlechtesten Fall, also **teurer** als der heutige Test (≈ 100) bei den inneren Fronten; ebenso wächst die Zahl der Mengen mit S und D (Kombinationen).
- bcov (Bänder, Tapete, Automap Boden) braucht weiter Spaltenvereinigungen: Der Baum liefert sie nicht, die Spalten für `spans` muss man aus den Elementbits erst wieder zusammenfügen (Demo: Boden-/Deckenbänder in 3,2 Tiefen je Ansicht). In Crawl wäre bcov „faul“ (nur für die Tapete in Tiefe D, 0,72 je Ansicht) und spart dort die 477 + ≈ 130 Zyklen fast ganz – das geht aber mit M1 ebenso billig (ein `ora` je Marke statt 123 Zyklen).
- Exakt bleibt der Baum nur, wenn die Mengen genau die Vereinigungslogik (c0/c1 der Elemente) abbilden; M1 bekommt das ohne Mengenaufzählung gratis, weil Segmente die Vereinigung schon repräsentieren.

Empfehlung: M1 (Segmentmasken) statt Entscheidungsbaum.

### 5.3 Weitere Maßnahmen

| Nr. | Maßnahme | Ersparnis je Wand | je Crawl-Bild | je Demo-Bild | Platz | Aufwand |
|---|---|---|---|---|---|---|
| M1 | Segmentmasken cover/bcov (5.1) | ≈ 410 | ≈ −1 800 (−10,6 %) | ≈ −1 850 (−7,4 %) | Code −200…−300 B (Gewinn), BSS −220 + ≈ 150 B | M |
| M2 | `vauto`: sofort zurück, wenn die Tiefe keine Bodenzeilen hat (`bact+1 = 0`); `mark_seen` je Zelle statt je Wand (Zelle schon in dieser Ansicht markiert → überspringen) | 20–25 | ≈ −425 (nur mit Automap), `mark_seen` ≈ −60 | ≈ −100 | ≈ +10 B | S |
| M3a | GEOMSET rechnet je Element `rowofs = row[y] + x` (16 Bit) und `Slot = k_ei + Platz` vor; `gwall` addiert nur noch `rowofs + row[dy]`-Anteil + AP | ≈ 60 | ≈ −260 | ≈ −350 | Tabellen 2–3 B je Wand-Element (BSS), Code ≈ +40 B | S–M |
| M3b | je (Element, Stil) fertige Kerntabelle bei TEXSET/GEOMSET: `resolve` und Kernschreiben (resolve 133, gsetx/gsetup 112, gwall 307, grl) werden zu einem Tabellenzugriff und einer 11-Byte-Kopie je Kern mit AP-Addition. Zyklen je Wand ≈ 1 337 → ≈ 960 (nach M1 ≈ 550) | ≈ 380 | ≈ −1 650 (−9,7 %) | ≈ −1 500 (Wände ohne ZEILEN/Rand) | Tabelle Crawl 19 Elemente × 4 Stile × (1 + 11) B ≈ 0,9 KB; Demo-Wände bis ≈ 4 KB (Bank 1, Tabellenadresse als neuer Parameter in GEOMSET/TEXSET, kein Platz in LIBTAB/BSS); Code ≈ +250 B (nur nach M1) | L |
| M4 | je Zelle ohne Fläche/Gegenstand `vobjc` überspringen (Bitfeld über die Inhaltsebene wie `obm`, Gegenstände) | – | ≈ −300…−600 (geschätzt, **nicht** gemessen: vobjc ≈ 100 je Zelle) | – | ≈ +40 B | M |

Gesamtwirkung auf Crawl (Mittel 16 939), ohne Automap: M1 ≈ −1 800, M3a (in M3b enthalten) ≈ −260, M3b zusätzlich ≈ −1 400 → ≈ 13 500 (−20 %); je angenommener Wand 1 337 → ≈ 550 (0.1: 420), die Differenz sind `vwall`-Prolog, `itemadd` und `vneed`. Die Gegenstands-Sprites (2 017 je Stück) und die Tiefenkosten (1 782 je Tiefe) bleiben der größte Block und werden von M1/M3 nicht berührt (M4 greift nur einen Teil). Das 0.2-Mittel läge bei ≈ 13,5 k statt 16,9 k (Mittel 0.1 über dieselben 400 Ansichten laut cmp01: 16 369, 0.2 alt: 16 863; 0.2 heute 16 939; 0.2 hat die flachere Kurve in der Grundlast und die steilere je Eintrag).

Westwood-Demo: nicht gemessen (Abschnitt 6). Demo-Karte der Spezifikation (56 Ansichten, 25 081 Mittel): M1 ≈ −1 850, M3b für Wände ohne ZEILEN ≈ −1 500 bei Tabellen bis ≈ 4 KB; dort dominieren außerdem `fillrows` (2 025 je Ansicht, ZEILEN-Stile), `vcells` + `bclass` (2 648 + 1 257: Boden-/Deckeneinordnung je Zelle) und die Bänder (`vband` 1 418), die M1–M3 nicht berühren.

### 5.4 Prüfung, Lib-Platz

- Bytegleichheit: `test/sim/run_crawl.py --dir test/tools/data --fix` (19 136 Ansichten gegen `dbeview.view`), `run_sim.py` (P6d/P6e/P6f-Sätze inkl. Automap und Überlauf, `VMS_COPY`), `test_geomcheck` (neue GEOMSET-Grenzen: mehr als 16 Segmente, Randfälle c0 = c1, Elemente mit Bit 0 ohne Spanne). Zyklenmessung mit demselben Harness (Lauf F = 4 minus F = 7).
- Reserve heute: Code 199 Byte (`$B000–$DB38`, Testbuild 54 Byte), BSS 125 Byte, LIBTAB 79 Byte (`__LIBTAB_SIZE__` `$3B1` von `$400`). M1 bringt Code-Reserve ≈ +200…+300, BSS-Reserve ≈ +70…+170; M3b braucht die Code-Reserve aus M1 und Bank-1-Platz im Spiel (kein Teil der Memory map G, Standard-DTS-Wandbereich `$8000–$AFFF` hat bei Crawl Luft, nicht allgemein).

## 6. Grenzen der Aussage

- Mini-6502 statt sim65: Zyklenzahl stimmt auf 0,2 % mit sim65 (26 092 / 26 041, Differenz = Eintritt), Zählung je Label ist exakt, Zuordnung der Zyklen zu Labels bei Fall-through (z. B. `gsetup` → `gsetx`) nach nächstem Label.
- Regressionskoeffizienten gelten für die Crawl-Karte (400 Ansichten, gleiche Stile, ein Wandelement je Zelle/Fläche mit einem Kern); die Demo-Zahlen haben nur 56 Ansichten und keine Objekte.
- Westwood-140-Szene (`demo/view.toml`, `docs/specs/examples/view-west140.toml`) wurde nicht profiliert: Der Auftrag nannte Crawl als Schwerpunkt; die Demo-Karte der Spezifikation ist ein Ersatz für die Größenordnung.
- Alle Ersparnisse sind Schätzungen aus Befehlszählung, kein Prototyp.

## Nachtrag 2026-11-26: M1 und M2 umgesetzt, gemessen und verworfen

M1 (cover/bcov als Segment-Bitmasken) und M2 (Automap-Markierung ohne Bodenzeilen überspringen) wurden vollständig umgesetzt (bytegleich, alle Tests grün) und auf Nutzerentscheidung **verworfen** – nicht erneut versuchen, ohne die Gründe zu klären:

| | Prognose oben | gemessen |
|---|---|---|
| je Wand | −410 Zyklen | −183 |
| Crawl `VIEW` je Bild | −10,6 % | −3,5 % (ohne Geist) / −2,7 % (mit Geist) |
| Demo-Karte | −7,4 % | ≈ 0; mit Automap +329, kachelreiche Zufallsszenen +830 |
| Lib-Reserve | +200 … +300 Byte | 14 → 12 Byte, BSS voll |
| Crawl gesamt (VICE comp 2/1 MHz) | – | −0,1 % / −0,5 % |

Ursache der Fehlprognose: Die Schätzung nahm ≤ 16 Segmente (2-Byte-Masken) an; die Testgeometrie `double_fronts` hat 24 Segmente, also 3-Byte-Masken (jede Maskenoperation ⅓ teurer), dazu GEOMSET-Code (127 Byte) und Tabellen. Der entfernte Intervall-Code (484 Byte, 220 Byte BSS) wurde vom neuen Code fast vollständig aufgezehrt. Lehre: vor einer Umsetzung erst einen kleinen Prototyp in sim65 messen (`AGENTS.md`).
