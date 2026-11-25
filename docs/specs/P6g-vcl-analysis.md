# P6g-Analyse: Kosten der VCL-Ausführung

Stand: 2026-11-25. Review und Analyse zu P6g (`P6-engine.md`, „Ergebnis P6g“ und „Nachtrag Review P6g“). Grundlage: 42 VICE-Szenen aus `test/vice_view.py`, Engine 0.2 (Standardbuild, VCL-Typ 9), VDC-BASIC v3 (Branch v3, `3fa2bad`), Kennwerte `vdc-basic/test/bench/results/{vice3.10,z64k}-20261125.md` (Messprogramm mit VDC-BASIC v2h).

Werkzeug: `test/vice_vclprof.py` (neu). Es markiert in der Referenz `dbeview` die Herkunft jedes VCL-Eintrags (Wand, Kachel, Band, Tapete, Sprite), zerlegt die Liste in Operationen (eine VMC-/VMF-Zeile bzw. einen VMS-Befehl) und zählt die geschriebenen Bytes je Fensterbyte. In VICE hält es an `vcl`, `.vcl_next_command`, `.vcl_done`, `.vms_arg_loop` und `.vms_done`. Die lokalen Marken stehen nicht in `vdcbasic3.sym`; sie kommen aus dem ACME-Report einer Kopie, die gegen `vdcbasic3.bin` geprüft wird (`vice_view.vdc_labels`). Gemessen wird mit der Monitor-Stoppuhr bei gesetztem I-Flag (ohne IRQ), Port 6634, ereignisgesteuert. `--static` liefert den Teil ohne VICE.

## 1. Kurzfassung

- VCL kostet in VICE **201 600 Zyklen je Bild** (Mittel; min 68 000, max 389 000 bei 1 MHz) und damit 82 % von VIEW + VCL.
- Die Kosten hängen an der **Zahl der Operationen**, kaum an den Bytes. VICE rechnet je Byte fast nichts. Eine VMC-Zeile kostet 187 Zyklen (mit srcstep 281), ein VMS-Befehl Typ 1 308 und ein **VMS-Befehl Typ 8 (halbes Byte) 706**. Dazu kommen 650–690 Zyklen fester Aufwand je VCL-Eintrag.
- **Wände sind 66 %** der Zeit (Kerne 37 %, Ränder 30 %). Die Ränder kosten so viel wegen der Typ-8-Befehle an den schrägen Kanten: 44 je Bild, zusammen 31 000 Zyklen.
- **Overdraw ist klein:** 7 978 geschriebene Bytes je Bild bei 6 720 Fensterbytes (Faktor 1,19). Operationen, deren Bytes später alle überschrieben werden, kosten 13 600 Zyklen (6,7 %). Bänder und Tapete tragen dazu nur ≈ 1 700 bei; das Vermeiden über `bcov` wirkt schon.
- **Hochrechnung auf Z64K:** bei 1 MHz ≈ 270 000 Zyklen (+34 %), bei 2 MHz (Engine-Konfiguration A) ≈ 0,20 s je Bild. 2 MHz bringt also kaum etwas, weil die Wartezeiten des VDC je Registerzugriff und je Byte bleiben.
- Den größten Hebel hat **VDC-BASIC**: schnellere Wege für VMS-Typ 8, VMS-Typ 1 und VMC-Zeilen sparen geschätzt ≈ 50 % (≈ 100 000 Zyklen). Auf Engine- bzw. Asset-Seite folgt **„Kanten auf ganze Bytes“** bei Wänden und Kacheln (kein Typ 8): −37 000 heute, −13 000 nach der VDC-BASIC-Optimierung. Das ist eine Entscheidung über das Aussehen.

## 2. Review P6g (Kurzurteil)

**Abnahmefähig nach den Korrekturen.** Die Testregeln sind eingehalten: eigener Port mit bind-Test, nur der eigene Prozess (Popen, terminate/kill), Haltepunkte und Debug-Cartridge statt Wartezeiten. Der Vergleich ist aussagekräftig: das ganze 64-KB-VRAM gegen ein fortgeschriebenes Modell, das Fenster gegen den unabhängigen Maler `paint_reference`, die Puffer gegen `dbeview`, MOVE gegen `dbemove`. `--control` verfälscht ein Byte im Fenster (`$00FA`) von Szene 5; der Nachlauf meldete genau diese Szene.

Korrigiert (Details in `P6-engine.md`, Nachtrag Review P6g):

1. **Ende der VCL-Messung.** `complex_instruction_shared_exit` ist das gemeinsame Ende jedes VMC/VMF und jedes VMS-Kopierbefehls. Gezählt wurde der letzte Treffer; das I-Flag war ab dem ersten Eintrag wieder frei, so dass IRQs mitgezählt wurden. Jetzt endet die Messung an `.vcl_done`. VCL sank von 211 200 auf 200 500 (dieselben Szenen).
2. **Zwei Szenen hatten die Kamera in einer deckenden Zelle** („Fenster Ost“, „Abgrund Nord“). Bei „Fenster Ost“ blieben 1 050 Fensterbytes ungeschrieben. Die Kamera steht jetzt in begehbaren Zellen; `build_steps` prüft das.
3. Neue Tabelle in `P6-engine.md` (Lauf nach beiden Korrekturen, beide Läufe pixelgleich): VIEW 43 150, VCL 201 700, VIEW + VCL 244 900 (Mittel).

Hinweis zu sim65 und VICE: VIEW in VICE liegt 7 % über sim65. Gründe sind der Stub und die VIC-II-Badlines bei 1 MHz. Bei 2 MHz fallen die Badlines weg, deshalb gelten die Ziele aus Abschnitt 8 als sim65-Werte. Von Lauf zu Lauf schwankt VCL um bis zu ±3 000.

## 3. Speicherkarte (Korrektur in `P6-engine.md` 2.4)

Die Blitz!-Runtime (Image 2) belegt das gemeinsame obere KB `$FC00–$FEFF` (`$D506` = `$0C`). Darum liegen jetzt **alle Bank-1-Daten unter `$FC00`**:

- DVG `$E800–$EDFF` (1,5 KB), DTS Boden `$EE00–$F5FF` (2 KB), DTS Decke `$F600–$FAFF` (1,25 KB), DBG `$FB00–$FBFF`. Zusammen sind das 5 KB statt 6 KB; dicht packen ist erlaubt.
- VCL-Typ-9-Listen liegen in `$4000–$CFFF` oder `$E000–$FBFF`.
- `MEMSIZ` bleibt `$5000`. Optional senkt `$4000` den Platz für Variablen von 19 auf 15 KB und gibt dafür 4 KB `$4000–$4FFF` für Assets frei (auch für Typ 9 geeignet).
- Werkzeuge: neue Vorgaben in `dbetex` (Boden `$EE00`, Decke `$F600`, DBG `$FB00`). `DEFAULT_DTS_ADDR`/`build_demo_assets` in `dbeview.py` und `run_sim.py` anpassen. Alle Werkzeuge brechen ab, wenn Daten über das Bereichsende (höchstens `$FC00`) reichen.

## 4. Zerlegung der VCL-Zeit

### 4.1 Nach Herkunft und Eintragstyp (VICE, 1 MHz, Mittel je Bild über 42 Szenen)

| Kategorie | Einträge | Zeilen | VMS-Befehle (Typ 1 / 8) | Bytes | Zyklen | Anteil |
|---|---|---|---|---|---|---|
| Wand VMC (Kerne; 68 Zeilen Typ 3) | 12,0 | 317 | – | 3 290 | 73 700 | 36,6 % |
| Wand VMS (Typ 9, Rand) | 4,6 | – | 80 / 44 | 202 | 59 700 | 29,6 % |
| Band VMF (Farbverlauf, ZEILEN) | 7,0 | 45 | – | 2 467 | 15 200 | 7,6 % |
| Sprite VMS (Typ 9, unbeschnitten) | 0,6 | – | 13 / 13 | 33 | 13 900 | 6,9 % |
| Kachel VMS (Typ 9) | 1,8 | – | 12 / 9 | 43 | 11 600 | 5,7 % |
| Tapete VMC (Panorama, Typ 3) | 1,1 | 26 | – | 568 | 8 100 | 4,0 % |
| Band VMC (Kerne) | 3,0 | 17 | – | 855 | 6 100 | 3,0 % |
| Kachel VMC (Kerne) | 2,5 | 12 | – | 165 | 4 000 | 2,0 % |
| Sprite VMC (Kerne) | 1,3 | 12 | – | 55 | 3 200 | 1,6 % |
| Sprite VMS (Typ 12, beschnitten) | 0,1 | – | 2 / 2 (+ Typ 3) | 7 | 2 300 | 1,1 % |
| Tapete VMF (Zeilen über/unter dem Panorama) | 0,7 | 6 | – | 292 | 1 700 | 0,9 % |
| Kopf (`vcl`, Ausdruck auswerten) und Ende | | | | | 2 000 | 1,0 % |
| **Summe** | **34,6** | **435** | **107 / 68** | **7 978** | **201 600** | |

Beispiele (Zyklen in tausend; WK/WR = Wand-Kerne/-Rand, KR = Kachel-Rand, BF = Band-VMF, SR = Sprite-VMS):

| Szene | VCL | größte Posten |
|---|---|---|
| Gang Süd | 235,5 | WK 97, WR 83, KR 15, BF 13 |
| Raum mit Himmel Süd | 71,8 | WK 32, BF 18, Tapete 8,5 |
| Fenster Ost (Fenster-Wand d = 1, 11 527 Byte) | 302,9 | WR 145, WK 132 |
| Blob Unterpositionen (5 Blobs) | 387,7 | SR 149, WK 95, WR 85 |
| INHALT Tür, Blobs d = 1 | 389,4 | WR 158, WK 119, SR 60 |
| Drehen links (Wand direkt vorn) | 68,0 | WK 59 |

### 4.2 Elementarkosten (VICE; aus den Einzelzeiten bestimmt)

| Operation | Zyklen je Stück | Anzahl je Bild | Zyklen je Bild | Anteil |
|---|---|---|---|---|
| VMC-Zeile Typ 2 | 187 (Bytes ≈ 0) | 279 | 52 100 | 25,9 % |
| VMS-Befehl 8 (halbes Byte, lesen-ändern-schreiben) | 706 (537–814) | 68,4 | 48 200 | 23,9 % |
| VMS-Befehl 1 (Ø 2,0 Byte) | 308 (260–352) | 107 | 33 100 | 16,4 % |
| VMC-Zeile Typ 3 (srcstep ≠ 0: Quelle je Zeile neu setzen) | 281 | 106 | 29 700 | 14,8 % |
| VCL-Eintrag, fester Teil (Parameter kopieren, Register 24, Quelle) | 646–694 | 34,6 | 18 500 | 9,2 % |
| VMF-Zeile (Typ 5) | 237 | 52,8 | 12 500 | 6,2 % |
| VMS-Eintrag, fester Teil (Typ 9/12) | 839 | 7,1 | 6 000 | 3,0 % |
| VMS-Befehl 3 (Quelle überspringen) | 172 | 1,4 | 240 | 0,1 % |

Die Summe ergibt 98,9 % (der Rest ist Kopf und Ende). Gegen die Bench (v2h, C): `vmc_row` 191, `vms1_cmd` 318, `vms8` 661. Typ 8 liegt in v3 höher, weil die Engine-Ränder zwei VRAM-Lesezugriffe und einen Schreibzugriff mit wechselnden Adressen brauchen.

### 4.3 Overdraw

- Geschrieben werden im Mittel 7 978 Bytes je Bild (min 6 720, max 11 527 bei der Fenster-Wand) bei 6 720 Fensterbytes (70 × 96): **Faktor 1,19**. Jedes Fensterbyte wird mindestens einmal geschrieben (nach der Szenenkorrektur), kein Byte außerhalb.
- Überschriebene Bytes: 1 258 je Bild, davon Wand-Kerne 380, Band-VMF 342, Tapete 390, Band-Kerne 124.
- **Tote Operationen** (alle Bytes später überschrieben): 36 je Bild, 13 600 Zyklen (6,7 %). Davon entfallen auf Wand-Kerne 3 600, Wand-Rand 3 600, Kachel-Rand 3 200, Sprite-Rand 1 100 und auf Tapete und Bänder zusammen nur 1 700.
- Typ-1-Befehle, die lückenlos an den vorigen anschließen: **0**. Der Konverter fasst bereits zusammen; die Maßnahme „Typ-1-Befehle zusammenfassen“ bringt nichts.
- Wände: Die Wandeinträge berühren 354 Bildzeilen, dafür werden 442 Operationen ausgegeben (Kernzeilen und Randbefehle). Eine Darstellung „eine Operation je Zeile“ spart höchstens 20 % der Wandoperationen.

### 4.4 Wie realistisch ist VICE? Hochrechnung auf Z64K

VICE rechnet für den VDC ein grobes Busy-Modell: Kopieren 1,2, Füllen 0,66 Zyklen je Byte, also praktisch kostenlos neben 190–700 Zyklen CPU je Operation. Z64K (genauer, aber noch kein Hardwarewert) liefert bei 1 MHz (Konfiguration C) `vmc_byte` 5,4, `vms1_byte` 7,0, `vmc_row` 230 (VICE 191), `vms8` 751 (661) und `fill_fixed` 295 (76) bei 3,8 je Byte. Bei 2 MHz (A) sind es in µs: VMC-Zeile 208 + 2,6/Byte, VMS1 209 + 5,2/Byte, VMS8 448, Füllen ≈ 450 + 2,9/Byte.

Verfahren: die gemessene VICE-Zeit je Eintrag plus die Bench-Differenz Z64K − VICE je Aufruf, Zeile, Befehl und Byte. Für 2 MHz geht der CPU-Teil mit dem VICE-Verhältnis A/C je Operationsart ein (0,5 bei Aufrufen, 0,65–0,74 bei Zeilen und Befehlen). Hinzu kommt die Differenz Z64K-A − VICE-A.

| | Mittel | min | max |
|---|---|---|---|
| VICE, 1 MHz (gemessen, Zyklen) | 201 600 | 68 000 | 389 400 |
| Z64K, 1 MHz (hochgerechnet, Zyklen) | 270 300 | 114 600 | 477 700 |
| Z64K, 2 MHz (hochgerechnet, µs) | 201 500 | 83 800 | 344 900 |

Folgerungen:

- Auf echter Hardware tragen die Bytes. Allein die 8 000 Bytes je Bild kosten bei Z64K ≈ 43 000 µs (1 MHz) bzw. ≈ 21 000 µs (2 MHz). Überschriebene Bytes kosten dort, in VICE nicht.
- 2 MHz bringt nur ≈ 25 %: Jeder VDC-Registerzugriff wartet auf das Statusbit, und die VMS-Befehle bestehen fast nur aus Registerzugriffen. Ein Bild mit VCL braucht realistisch **0,2–0,35 s** (3–5 Bilder/s ohne BASIC).
- Unsicherheit: Die Z64K-Kennwerte stammen aus dem Bitmap-Modus des Messprogramms, nicht aus dem Chunky-Modus der Engine (R9 = 1, Attribute an, R36 = 0). Dort holt der VDC mehr Daten für die Anzeige und hat weniger freie Speicherzyklen. Der Füll-Kennwert ist in Z64K nicht linear (Bench Tabelle 2). Die Hochrechnung ist eher **untere Grenze**.

## 5. Maßnahmen (sortiert nach Nutzen/Aufwand)

Ersparnis in VICE-Zyklen je Bild (Mittel 201 600, 1 MHz). Die Zielwerte je Operation sind Schätzungen aus der Zahl der nötigen Registerzugriffe (≈ 15–20 Zyklen je Zugriff mit Statusabfrage) plus Schleifenaufwand. Spalte Z64K: Ersparnis bleibt ganz (CPU-gebunden) oder nur teilweise (VDC-gebunden).

| # | Maßnahme | Seite | Aufwand | Ersparnis VICE | Z64K/HW | Bemerkung |
|---|---|---|---|---|---|---|
| V1 | **VMS-Typ 8 schneller** (706 → ≈ 250): ohne JSR-Kette und Stapel, Adressregister nur wo nötig, Quellposition über R32/33 statt über eigene Lesezugriffe | VDC-BASIC | mittel | **−31 000 (15 %)** | voll | Variante V1b: neuer VMS-Befehl mit **Byte in der Liste** (kein VRAM-Lesen der Quelle) und getrennt für linke/rechte Hälfte (≈ 150; Format- und Konverteränderung) |
| V3 | **VMC-Zeile schneller** (187 → ≈ 110, Typ 3: 281 → ≈ 150): enge Zeilenschleife, nur R18/R19/R30 je Zeile, Quelle nur bei srcstep ≠ Länge | VDC-BASIC | gering–mittel | **−35 000 (17 %)** | ¾ (bei langen Zeilen wartet der VDC) | betrifft auch `VMC` in BASIC |
| V2 | **VMS-Typ 1 schneller** (308 → ≈ 130): je Befehl R18/R19 + R30; Quelle läuft im VDC von selbst weiter | VDC-BASIC | gering–mittel | **−19 000 (9 %)** | voll | |
| E2 | **Kanten auf ganze Bytes** bei Wand- und Kachelbildern (Konverter-Option; kein Typ 8): 53 Typ-8-Befehle je Bild entfallen | Asset/dbetex | gering | −37 000 (18 %); nach V1 −13 000 | voll | **Aussehen:** schräge Kanten stufen in 2-Pixel-Schritten. Für Sprites zusätzlich ≈ −11 000 (Szenen mit Objekten deutlich mehr) |
| V4 | **VCL-Eintrag fest** 650–690 → ≈ 350 (Parameter mit `lda (zp),y` statt Byteschleife mit `inc offset`, Argumente nur so weit löschen wie nötig) | VDC-BASIC | gering | −9 000 (4,5 %) | voll | |
| V5 | VMF-Zeile 237 → ≈ 130 (Schleife ohne JSR, nur Adresse, Byte, R30) | VDC-BASIC | gering | −5 600 (3 %) | wenig (Füllen ist im Z64K VDC-gebunden) | |
| V6 | VMS-Eintrag fest 839 → ≈ 450 | VDC-BASIC | gering | −2 800 | voll | |
| E1 | Typ 3 mit srcstep = Länge als Typ 2 ausgeben (16 Zeilen je Bild) | Engine (Lib, Referenz) oder dbetex (srcstep 0 schreiben) | sehr gering | −1 500 | voll | 2 Byte VCL je Eintrag weniger; besser im Konverter, dann bleibt die Lib unverändert |
| E4 | Kerne im Konverter neu abwägen (`kern_min`, `max_kerns`): mehr Fläche in Kernzeilen, weniger Randbefehle (Kernzeile 187 gegen Typ 1 308) | Asset/dbetex | mittel (Versuche mit `vice_vclprof --static`) | geschätzt −5 000 … −15 000 | voll | nach V2/V3 neu bewerten: dann kosten beide fast gleich |
| E3 | Tote Operationen vermeiden: Kacheln, Wandteile und Sprites, die von näheren **Seitenwänden derselben Tiefe** ganz verdeckt sind (zeilengenaue Abdeckung) | Engine | hoch (Lib-Reserve nur 248 Byte) | höchstens −13 600 (6,7 %) | mehr (Bytes zählen) | „Bänder/Tapete nur wo nicht verdeckt“ ist schon umgesetzt (`bcov`), Rest ≈ 1 700: **nicht lohnend** |
| A1 | Fensterbreite = Zeilenabstand (VW 80 bzw. R1 = 70): volle Zeilen hängen im VRAM zusammen, Band- und Tapetengruppen werden eine Blockoperation | Geometrie/Spiel | hoch (Layout, HUD) | ≈ −15 000 … −20 000 | mehr | nur, wenn sich das Spiellayout ohnehin ändert |
| E6 | Typ-1-Befehle zusammenfassen | Konverter | – | 0 | – | schon umgesetzt (0 Kandidaten) |
| E7 | Zeilenspannen-Format (eine Kopie je Bildzeile über Kern und Rand) | VDC-BASIC + Engine + Konverter | hoch | ≤ 20 % der Wandoperationen | | erst nach V1–V3 bewerten |

Mit V1–V6 zusammen geschätzt: **VICE ≈ 100 000 Zyklen je Bild** (−50 %). Auf Z64K 1 MHz sind es ≈ 165 000, weil die VDC-Zeit je Byte bleibt. Mit zusätzlich E2 kommt man auf ≈ 87 000 (VICE).

## 6. Assets

- Die Demo-Assets passen weder in die Bank-1-Bereiche noch in den VRAM-Pool (Wand 8,7 KB, Boden 9,1 KB, Decke 3,2 KB; VRAM 54 KB gegen einen Pool von 36,7 KB). Für P7 einen **Asset-Etat** festlegen: Wand ≤ 8 KB (Bereich `$9000–$AFFF`), Boden ≤ 2 KB, Decke ≤ 1,25 KB, VRAM ≤ Pool. Werkzeuge melden Überschreitungen (Abschnitt 3).
- Typ-8-Anteile sind eine Asset-Eigenschaft: Sprites mit vielen halbtransparenten Randbytes (Blob: Ø 1,5 Byte je Typ-1-Lauf, 13 Typ-8 je Sprite) kosten am meisten. Ein Bericht in `dbespr`/`dbetex` mit „Typ-8-Befehle je Bild und Tiefe“ hilft Grafikern.
- Fenster-Wände (Transparenz) erzeugen die höchsten Kosten je Szene: Rand 145 000 bei „Fenster Ost“. Hier lohnt E2 am meisten.

## 7. Empfehlung: nächste Schritte

1. **VDC-BASIC v3 „P2e: VCL/VMS-Durchsatz“ (V3, V2, V4, V5, V6, dann V1)**. Gemessen wird mit `test/vice_vclprof.py` (gleiche Szenen) und dem Bench (C und A, VICE und Z64K). Modell: **Opus** für Entwurf und Umsetzung (zyklenkritischer 6502-Code im gemeinsamen RAM, Platz in `$1C00–$3FFF` prüfen), Tests und Bench-Läufe an **Haiku**.
2. **E1 im Konverter** (srcstep 0 bei srcstep = Breite): **Haiku/Sonnet**, mit sim65 und VICE erneut bytegleich prüfen.
3. **Bench im Chunky-Modus der Engine** (R9 = 1, Attribute, R36 = 0) in Z64K und, sobald möglich, auf echter Hardware. Ohne diese Messung bleibt die Hochrechnung unsicher. Modell: **Sonnet**.
4. Nach der Entscheidung des Nutzers: **E2 als Konverter-Option** (`dbetex`/`dbespr`, Vorgabe aus), Vorher-/Nachher-Bilder für den Nutzer: **Sonnet**.
5. Werkzeug-Ladeadressen und Bereichsprüfungen nach 2.4 (Abschnitt 3): **Haiku**.

## 8. Entscheidungsfragen an den Nutzer

1. **Kanten auf ganze Bytes (E2):** Dürfen schräge Wand-/Kachelkanten (und optional Sprite-Ränder) in 2-Pixel-Schritten erscheinen? Das spart 18 % (heute) bzw. ≈ 13 % nach V1.
2. **VDC-BASIC-Änderungen:** Freigabe für P2e (V1–V6)? Darf V1b das VMS-Format um einen Befehl mit eingebettetem Byte erweitern (Konverter und Engine ziehen nach)?
3. **Zieltakt:** Läuft das Spiel im FAST-Modus (2 MHz)? Dann gilt VICE-A/Z64K-A als Maßstab. Die VDC-Zeit ändert sich kaum, die Badlines entfallen.
4. **Speicher:** Reicht die Vorgabe 5 KB für DVG/Boden/Decke/DBG, oder soll `MEMSIZ` auf `$4000` sinken (4 KB mehr für Assets, 4 KB weniger für Variablen)?
5. **Layout (A1):** Kommt ein Fenster in voller Zeilenbreite (VW 80) in Frage, oder bleibt Westwood 140 × 96?
