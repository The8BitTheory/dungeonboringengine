# P6d-Review: VIEW ohne Objekte – Korrektheit, Zyklen, Speicher, nächste Schritte

Stand: 2026-11-25. Review (Opus) von Commit `793a273` (Branch `step2/textures-0.2`): `engine/view.s`, `engine/lib.s`, `tools/dbeview.py`, `test/sim/run_sim.py`, Spezifikation `P6-engine.md` (Abschnitte 2, 5, 7, 8, „Ergebnis P6d“). Nichts geändert, nichts committet. `python3 test/sim/run_sim.py` ist grün (1302 Ansichten bytegleich, Zyklen wie im Ergebnis P6d).

Messgrundlage: eigener Profiler (`prof6502.py`, Zyklen je PC, Gruppierung nach Labels und Quellzeilen), Demo-Assets 140 × 96 (VW 70, D 3, S 3, NE 79), Szenen wie `test_p6d`. Die Werte in Klammern sind Mittel je Ansicht.

## 1. Review: Korrektheitsrisiken außerhalb der Tests

### 1.1 Befunde (nach Gewicht)

| # | Risiko | Wirkung | Vorschlag |
|---|---|---|---|
| K1 | **`BUFSET` erlaubt Puffer ab `$0200`.** Bank 0 `$0200–$0AFF` enthält Eingabepuffer, Kernal-Vektoren (`$0314` IRQ) und Systemvariablen, `$0C00–$0DFF` Parameterblock und Stub, `$1000–$12FF` Funktionstasten, BASIC-Sprite- und BASIC-7-Arbeitsspeicher. Ein Spiel mit `BUFSET 512,…` überschreibt beim nächsten `VIEW` den IRQ-Vektor → Absturz. | System hängt | `BUFSET` nur in erlaubten Fenstern: `$1300 ≤ B0` (Standard), optional `$0B00–$0BFF` und `$0E00–$0FFF` als eigene Fenster (falls der Nutzer sie freigibt, 3.4). Spezifikation 3/3.3 anpassen. |
| K2 | **`GEOMSET` prüft die Elementtabelle nicht.** Geprüft werden nur Kopf und Grenzen VW/VH/D/S/NE. Nicht geprüft: `first + n ≤ NE` je Tiefe, Art ≤ 4, `e.d` = Tiefe, `|e.s| ≤ S`, `x + w ≤ VW`, `c0 ≤ c1 ≤ VW`, `y + h ≤ VH`, zusammenhängende Zellen (P3 5.3), höchstens ein Boden-/Deckenelement je Zelle. Folgen einer falschen oder vertauschten Datei: `mark_c`/`mark_b` mit `c1 > VW` schreiben Einsen über `cover`/`bcov` hinaus in `dcy0…`, `pd_*`, `gr_*` (BSS-Zerstörung). Nicht zusammenhängende Zellen ergeben mehr als 31 Gruppen; `vband` liest dann für alle Gruppen ab 31 die Werte von `gr_*[31]` (`@gx: ldx #MAXGRP-1`), also falsche Band-Entscheidungen statt `E_FORMAT` (die Referenz wirft `ViewError`). | stille Fehlbilder, BSS-Zerstörung | Einmalige Prüfung in `GEOMSET` (≈ 150 B Code, Laufzeit einmalig). Danach entfallen in `VIEW` die Rückfallpfade `bmulti`/`bit0`/`bitn`-Scan und `MAXGRP`-Abfragen (≈ 150 B Code weniger). |
| K3 | **Wartebereich 16 Einträge je Tiefe** ist nur eine Laufzeitgrenze (`A = 2`). Die Referenz kennt keine Grenze → bei Überschreitung keine Byte-Gleichheit mehr. Gemessen: höchstens 6 belegte Plätze in allen 800 Zufallsszenen (beide Bit-3-Varianten, `double_fronts`). Obergrenze je Tiefe = Zahl der Seiten mit DVG-Bit 0 plus Fronten mit Bit 0 ohne Bit 3. Demo mit `double_fronts` ohne Bit 3: Tiefe 3 = 6 Seiten + 10 Fronten = **genau 16**. Eine Crawl-ähnliche DVG mit größerem S überschreitet das. | A = 2 ohne Not, Abweichung von der Referenz | `GEOMSET` zählt diese Elemente je Tiefe und gibt bei > 16 `A = 1` (Grenze in Abschnitt 7, Referenz `parse_dvg` gleich). Danach kann `VIEW` nie überlaufen; der Laufzeitzweig entfällt. Test: DVG mit 16 (ok) und 17 (A = 1). |
| K4 | **`MAXITEM = 96` ist ungetestet.** Höchstens 41 Einträge in allen Zufallsszenen (auch mit `double_fronts`). Der STOP-Pfad aus `itemadd` (A = 2 ohne Pufferüberlauf) wird nur über den Puffer erreicht. | ungetesteter Pfad | Synthetische Szene: großer Puffer (`BUFSET` bis `$1BFF`), viele kleine Einträge (z. B. Tapete in vielen Spannen, Kacheln mit `max_kerns` 16) oder vorläufig `MAXITEM` per `--asm-define` klein. Mit der Einpass-Erzeugung (2.3, M2) bleibt nur der Zähler. |
| K5 | **Asset-Adressen unter `$2000` werden nicht abgewiesen.** `TEXSET`/`BGSET`/`SPRITESET`/`GEOMSET`/`MAPINIT` (außer Arbeitskopie) akzeptieren jede Adresse; unter `$2000` liest die Lib Bank 0 (gemeinsames RAM). Ebenso Überlappung mit Lib (`$B000–$CFFF`) und BSS (`$E000–$E7FF`). | stille Fehlbilder | Gemeinsame Prüfung „Daten in `$2000 … $FEFF`, nicht in Lib/BSS“ (A = 6), ≈ 30 B. Niedrige Priorität. |
| K6 | `clipvms_e`: Zeilenzähler `cr` ist 8 Bit (`inc cr; bne @rw`). Bei Offsets ≥ 256 · stride (nur mit kaputter Liste oder stride < 64) läuft er über und der Ausschnitt wird falsch. | nur kaputte Daten | P6e prüfen (Sprites haben kleinere Höhen); ggf. `cr ≥ B` vor dem Erhöhen abfragen. |
| K7 | Kommentar in `velem` („abgelehnt ändert nichts an der Abdeckung“) ist missverständlich: Auch ein verworfener Eintrag (`@drop`, v = 7 mit Rand) markiert danach `cover`. Das entspricht der Referenz (sie ignoriert den Rückgabewert von `add`). Kann nur bei DECKEND-Bildern ohne Kerne auftreten (Werkzeugfehler). | keine | Kommentar präzisieren; `dbetex` sollte DECKEND ohne Kern verbieten. |

### 1.2 Geprüft und in Ordnung

- **Zeropage:** `VIEW` benutzt nur `ZP0`/`ZP1` (`$FA–$FD`); `vstop` stellt den Stapelzeiger wieder her, `ZP0` wird in `vout` neu gesetzt; im Zählmodus verändert `clipvms_e` `ZP0` nicht. Selbstmodifizierender Code nur in `vcopy` (Bank-1-RAM), interruptfest.
- **Bank-1-Zugriffe:** alle Daten über `(ZP),y` in Bank 1; Schreiben nur in den Puffer (gemeinsames RAM) und in `$0C0A–$0C11`. Zellen außerhalb der Karte (feste Achse über `dout`, Seitenachse über `a0 + as`, 16 Bit vorzeichenrichtig) fallen auf die Außenkachel.
- **Grenzen:** `cover`/`bcov` mit 81 Byte (Sentinel bei VW), `allcov` bei w = 0 → „belegt“ wie `all([])`; `resolve`-Index `Art · 32 + st < 96`; `spans` mit > 4 Folgen; `bgq` terminiert für P ≥ 1; nv/nm 16 Bit; `X` sättigt bei 255.
- **Zähl- und Schreibmodus** laufen durch denselben Code; die Tests decken Rand weggelassen (A = 3), Verwerfen und STOP über den Puffer ab.
- **IRQ während `VIEW`:** keine Kernal-Aufrufe, I/O nicht berührt; der lange Aufruf wird bereits im VICE-Rauchtest (Jiffy-Uhr) geprüft.

## 2. Ursachenanalyse der Zyklen

### 2.1 Messwerte

| Satz | Mittel | max | Einträge Sichtliste | VCL-Einträge | VMS-Bytes |
|---|---|---|---|---|---|
| Gang (ganzer Satz, sim65) | 90 696 | 106 247 | 5–17 | 6–39 | 0–690 |
| Gang, billigste Ansicht (Wand in Tiefe 1) | 29 998 | – | 5 | 6 | 0 |
| zufall (40 Szenen) | 106 806 | 143 712 | 13–29 | 24–56 | 123–1 763 |

Selbst die billigste Gang-Ansicht kostet 30 000 Zyklen für 6 VCL-Einträge. Ein Eintrag der Sichtliste kostet im Mittel **etwa 6 000 Zyklen**. Den Großteil verursachen Durchlauf und Verwaltung, nicht die Ausgabe.

Profil Gang (16 Ansichten, 81 619 Zyklen): `vcells` 10 665, `gent0` 7 907, `vcell` 5 991, `vcopy` 5 355, `vband` 4 783, `velem` 3 997, `spans` 3 944, `itemadd` 3 583, `resolve` 3 245, `gwall` 3 040, `fillrows` 2 805, `mark_c` 2 170, `emit_vmc` 2 163, `allcov_c` 2 144, `clipkerns` 1 982, `bitn` 1 900, `f_view` 1 635, `dstxy` 1 516, `vout` 1 349, `mark_b` 1 280, `bgoffs` 831.
Profil zufall: `vcopy` 17 143 (max. Szene 29 862 = **21 %**), `vcells` 11 830, `gent0` 10 322, `vband` 9 441, `gwall` 6 405, `vcell` 6 167, `itemadd` 5 762, `bitn` 3 684.

### 2.2 Wo algorithmisch zu viel passiert

1. **Jedes Element jeder Tiefe wird zweimal angefasst, die meisten umsonst.** `vcells` liest je Element Art und s (Gruppenbildung, Boden-/Deckenelement merken), dann ruft der Durchlauf `velem` für jedes Element auf. Von 79 Elementen sind nur 25 Wände; Boden, Decke und Objektplätze werden gelesen und verworfen. Die Quellzeilen zeigen etwa 60 Zyklen je Element im Scan und etwa 60 im Durchlauf (16-Bit-Zeigerfortschaltung um 16, `ldy #0/lda (ZP0),y/cmp`, `inc ecur`, `dec ecnt`). Die Gruppenstruktur ist für eine DVG fest und könnte einmal bei `GEOMSET` berechnet werden.
2. **Zellberechnung je Zelle etwa 330 Zyklen:** Zellindex über eine Schleife `as`-mal `± W` (bei O/W bis 15 Additionen à 20 Zyklen), Kachelzeiger 8 · t, **Kopie aller 7 Kachelbytes** (~100 Zyklen), `faces`/`blocked`. Eine Tabelle `rtab[s] = s · R` je `VIEW` (oder bei `SETPOS`) macht daraus eine 16-Bit-Addition.
3. **„Vorlauf der Erzeuger“ = jeder Eintrag wird zweimal erzeugt.** Einmal im Zählmodus in `itemadd`, einmal im Schreibmodus in `vout`. Beide Male kopiert `gent0` 14 Byte des Verzeichniseintrags (~300 Zyklen je Aufruf) und läuft die Kerne durch. Im Zählmodus werden für unbeschnittene Wände, ZEILEN-Bänder und Tapete nur Konstanten oder einfache Formeln berechnet, und das mit voller Erzeuger-Maschinerie. Dazu kommt die Übergabe über die 7 Felder `g_*` → `it_*` → `g_*`. Gesamt etwa 9 000 (Gang) bzw. 13 000 (zufall).
4. **Band-Entscheidung als eigener Durchlauf je Art:** `vband` läuft je Tiefe für Boden und Decke über alle Zellen (`bit0`/`bitn`, Einordnung egal/Lücke/Stil), obwohl `vcell` dieselben Daten gerade gelesen hat. Bei einheitlichen Bändern (Gang) ist der zweite Durchlauf unnötig.
5. **Spaltenmasken byteweise mit teuren Schleifen:** `mark_c` 28 Zyklen je Spalte (wegen `inc ncov` für die Abbruchbedingung), `mark_b` 17, `spans` ~13 (mit `cpx dvg_vw` je Spalte). Eine deckende Front über 70 Spalten kostet allein 2 000 Zyklen für `mark_c`. Gang: etwa 4 Neuberechnungen von `spans` à 950.
6. **`bgoffs`:** eine 16-Bit-Division (o_v mod P) bei jedem `VIEW`, 831 Zyklen, obwohl sie nur von der DBG und v abhängt.
7. **Absolute Adressierung überall:** Nur zwei Zeiger in der Zeropage. Das zwingt zu ständigem Umladen (`gp → ZP0`, `fsrc → ZP1`, `vclsv`), jeder Zugriff kostet 1 Zyklus und 1 Byte mehr. Das erklärt einen Teil der Codegröße (5,6 KB statt geschätzter 3 KB).
8. **`vcopy`** 17 Zyklen je VMS-Byte (`lda abs,y / sta abs,y / iny / dex / bne`). Das ist nicht falsch, aber in zufall der größte Einzelposten. Ohne Kopie (Listen aus Bank 1 oder resident) entfällt er ganz.

Die 16-Bit-Arithmetik, die sich per Tabelle 8-bittig machen lässt: Zellindex (`rtab`), Element-/Zellzeiger (aus der Zellentabelle statt `elp` = 16 · i), `bgoffs` (Tabelle bei `BGSET`). `dstxy` nutzt die Zeilentabelle schon; `resolve` (16 · b) ist billig genug.

### 2.3 Maßnahmen (sortiert nach Nutzen/Aufwand)

Ersparnis je Ansicht, geschätzt aus dem Profil (Gang 81 600 bzw. zufall 107 000 als Basis). Die Posten überlappen sich teilweise (ZP verbilligt auch die anderen), die Summe ist deshalb eine Obergrenze.

| # | Maßnahme | Gang | zufall | Aufwand | Code / BSS |
|---|---|---|---|---|---|
| **M1** | **Zellentabelle bei `GEOMSET`** (zusammen mit K2): je Tiefe die Zellen mit s, Zeiger auf das erste Element, Anzahl Wandelemente (DVG-Reihenfolge), Objekt-, Boden-, Deckenelement, Spaltenhülle [x0, x1) der Wände. `VIEW` läuft nur über Zellen und deren Wände; Zellindex über `rtab[s]` (16 Bit, einmal je `VIEW`); Kachelbytes direkt per `(ZP),y` statt Kopie; **`allcov` vor `resolve`** und Zelle überspringen, wenn ihre Hülle in `cover` ganz belegt ist (Kacheldaten für die Bänder trotzdem lesen). | −13 000 … −15 000 | −13 000 | mittel | Code ±0 (GEOMSET +200, VIEW −250, Rückfallpfade weg); BSS +6–8 B je Zelle (Grenze z. B. 64 Zellen → ≤ 512 B; Demo 18) |
| **M2** | **Einpass-Erzeugung** (empfohlen, verlangt eine API-Entscheidung, 5 F2): Jeder angenommene Eintrag wird sofort geschrieben. VCL-Einträge **abwärts ab B1** (Ende-Byte zuerst), VMS-Listen **aufwärts ab B0**; VCLADR = Ende des Abwärtsschreibens (variabel, P0 liefert es schon). Innerhalb eines Eintrags kehrt sich die Reihenfolge der VCL-Einträge um. Das ist pixelgleich, weil Kerne und Rand disjunkt sind (P5 4.4 „Reihenfolge ist frei“); Gleiches gilt für ZEILEN-Gruppen und Tapetenteile. Überlaufprüfung: fast path, wenn der freie Platz die Obergrenze des Eintrags fasst (Kerne · 13 + 7 + vlen, beschnitten + 3 je Befehl); sonst slow path mit dem vorhandenen Zählmodus und der Regel aus 5.10. Sichtliste, `vout`, zweiter `gent0` und `g_*/it_*`-Umladen entfallen. | −9 000 | −13 000 | mittel bis hoch (Referenz und Harness anpassen) | Code −150 … −300; **BSS −680** |
| M2′ | Alternative ohne API-Änderung: **Größen ohne Erzeuger.** Wand/Kachel: v aus dem Verzeichniseintrag (DTS-Byte 15, von `dbetex` vorberechnet: Kernbytes + 7 bei RAND; ≤ 16 · 13 + 7 = 215), m = vlen; ZEILEN-Band: v je Bild konstant (Gruppenzahl, unabhängig von c0/c1); Tapete: Formel. Zählmodus nur noch für beschnittene Bandbilder (und Sprites in P6e). | −6 000 | −9 000 | niedrig bis mittel (DTS-Format, `dbetex`) | Code −100; BSS ±0 (Sichtliste bleibt, P6e braucht dann +300–500 B BSS für Sprite-Felder) |
| **M3** | **Band-Entscheidung im Zellendurchlauf:** `vcell` ordnet Boden und Decke der Zelle sofort ein (egal/Lücke/Stil) und führt je Tiefe live/gap/mix/st1 sowie st0 (erster Stil mit auflösbarem Bandbild; `resolve` nur bei neuem Stil). `vband` macht nur noch den Kacheldurchlauf (bei gemischt/Lücke) und die Spannen. | −5 000 | −6 000 | niedrig bis mittel | Code −150 |
| **M4** | **Zeropage-Block während `VIEW`** (16–24 Byte retten und zurückschreiben, ≈ 450 Zyklen): 4–6 Zeiger (Element, Zelle, Kachel, Quelle, VCL, VMS) und die heißesten Zähler. Erzeuger lesen den Verzeichniseintrag direkt per `(ZP),y` (kein 14-Byte-Kopieren), `putb0`/`put_dst` inline. | −5 000 … −7 000 | −8 000 | mittel (mechanisch, breit) | **Code −0,6 … −1 KB** |
| **M5** | **Masken:** `mark_c` ohne `ncov` (Abbruchtest „cover ganz belegt“ einmal am Tiefenende, bricht an der ersten freien Spalte ab), 13 Zyklen je Spalte; `spans` mit Sentinel in `bcov[VW]` (zwei enge Schleifen); `mark_b` mit ZP-Grenze. Optional `spans` inkrementell (freie Folgen als Liste, `mark_b` schneidet aus). | −3 000 … −4 000 | −2 000 | niedrig | ±0 |
| **M6** | **`bgoffs` bei `BGSET`** für alle 4 Richtungen (8 B BSS) oder `dbetex` garantiert o_v < P (dann entfällt die Division ganz). | −830 | −830 | trivial | Code −60 |
| **M7** | **`vcopy` entrollt** (4 Bytes je Schleife, ≈ 12,5 statt 17 Zyklen je Byte). | −1 300 | −4 000 (max −7 000) | trivial | +30 B |
| **M8** | **VMS-Listen ohne Kopie** (Nutzerentscheidung, 5 F4): VDC-BASIC v3 führt unbeschnittene VMS-Listen direkt aus Bank 1 aus (neuer VCL-Typ oder Bank-Bit in Typ 12; die VMS-Schleife liegt in `$1C00–$1FFF`, also im gemeinsamen RAM, und schaltet für die Dauer einer Liste wie der Stub `$D506`/`$FF00`). Alternativ residente Listen in Bank 0 (Plan 12.2, braucht mehrere KB Bank 0). Nur beschnittene Listen werden noch in den Puffer geschrieben. | −5 000 (max −12 000) | −17 000 (max −30 000) | mittel, zweites Repo | Engine-Code −100; **Puffer entlastet** (zufall: 10–15 % der Szenen haben heute A = 2 wegen des Puffers) |
| M9 | Zellzeiger je (d, s) bei `SETPOS`/`MAPINIT` vorberechnen (2 B je Zelle). Lohnt sich, wenn das Spiel `VIEW` ohne Bewegung wiederholt (Objekte, P6e). | −1 000 | −1 000 | niedrig | BSS +2 B je Zelle |

Reihenfolge nach Nutzen/Aufwand: **M1, M3, M5, M6** (zusammen etwa −22 000, ohne Formatänderung), dann **M2** (bzw. M2′), dann **M4**, M7 (entfällt mit M8), M9.

### 2.4 Ist das Ziel erreichbar?

Rechnung von unten für eine typische Gang-Ansicht (13 Einträge, 23 VCL-Einträge, 250 VCL-Bytes, 156 VMS-Bytes) bei guter Umsetzung: Ausgabe etwa 4 000, VMS-Kopie 2 700 (mit M7 2 000), 18 Zellen à 120 und 25 Wände à 100 ≈ 4 700, Bänder 2 000, Spannen 1 600, Rest 2 000, zusammen **17 000–22 000**. Von oben (Profil minus M1–M7) landet man bei etwa 40 000–45 000, weil sich die Posten überlappen und Reste bleiben. Realistisch nach P6d-opt:

| Fall | Ziel (Abschnitt 8) | erwartet mit M1–M7 | mit zusätzlich M8 |
|---|---|---|---|
| Gang Mittel | ≤ 30 000 | 35 000–45 000 | 30 000–38 000 |
| Gang max (690 VMS-Bytes) | ≤ 45 000 | 50 000–60 000 | 40 000–48 000 |
| zufall max (1 760 VMS-Bytes) | ≤ 80 000 | 90 000–105 000 | 65 000–80 000 |

**Bewertung:** Die Ziele aus Abschnitt 8 sind nur mit M8 (VMS ohne Kopie) sicher erreichbar; ohne M8 reicht es knapp nicht (allein die Kopie kostet in der größten Zufallsszene 30 000). Vorschlag für die Abnahme von P6d-opt **ohne M8**: Gang Mittel ≤ 40 000, max ≤ 55 000, zufall max ≤ 100 000. **Mit M8** bleiben die ursprünglichen Ziele 30 000 / 45 000 / 80 000. Die Ziele sollten zusätzlich an der VDC-Zeit der Liste gemessen werden (P6g). Eine Gang-Ansicht zeichnet etwa 6 700 Fensterbytes und braucht im VDC grob die gleiche Größenordnung an Zyklen; `VIEW` sollte nicht mehr als etwa die Hälfte davon kosten.

## 3. Speicherplan für P6e und Optimierungen

### 3.1 Bedarf

| | heute | nach P6d-opt (M1–M6, M2) geschätzt | P6e zusätzlich | P6f (MOVE, Automap) |
|---|---|---|---|---|
| Code (8 192) | 7 960 | 6 600–7 000 | +700 … +1 000 (Kandidaten, Sortierung, `lookup`, Anker, Spaltenbeschnitt, OBJVIS; `clipkerns`/`clipvms_e` werden wiederverwendet) | +300 … +500 |
| BSS (2 048) | 1 993 | 1 450–1 600 (−680 Sichtliste, +300–500 Zellentabelle, −160 `gr_*`) | +40–80 mit M2; **+300–500 ohne M2** (Sprite-Felder x0/y0 16 Bit, cy0/cy1, Satz in der Sichtliste) | +10 |

Ohne Änderung der memory map reicht es also auch nach der Optimierung nur knapp, ohne Reserve für P6f und P7.

### 3.2 Optionen

| Option | Inhalt | Gewinn | Risiko/Kosten | Entscheidung |
|---|---|---|---|---|
| **A: Lib mit `$FF00 = $7F`** | Stub schaltet Bank 1 **ohne I/O** (`CR_LIB = $7F` statt `$7E`). Die Lib benutzt kein I/O (geprüft: nur die Testfunktion 250 liest `$D506`; sie schaltet dafür kurz um). Dann ist Bank-1-RAM `$D000–$DFFF` nutzbar: **Code `$B000–$DFFF` = 12 KB**, BSS bleibt `$E000`. `BLOAD` nach Bank 1 (BASIC `BANK 1` = `$7F`) schreibt ins RAM unter I/O. IRQ/NMI laufen über die Weiche in Bank 1, die selbst `$FF00 = 0` setzt. | +4 KB Code, keine Asset-Fläche verkleinert | Stub 1 Byte, `lib.cfg`, Rauchtest (`$FF00`-Erwartung, BLOAD über `$D000`, Jiffy-Uhr) nachziehen; Spiele dürfen Bank 1 `$D000–$DFFF` nicht anders nutzen (bisher frei) | **Nutzer** (memory map 2.4) |
| B: Einpass (M2) | Sichtliste entfällt | −680 B BSS, −150…300 B Code | API: VCLADR variabel | Nutzer (F2) |
| C: Zeropage-Block (M4) | 16–24 B retten/zurückschreiben, z. B. `$63–$72` (FAC/ARG des Interpreters) | −0,6…1 KB Code, −5 % Zyklen | Konflikt nur mit Code, der **während** des Aufrufs läuft = IRQ/NMI. Kernal-IRQ nutzt `$A0–$A2`, Tastatur `$D0–$D9`; VDC-BASIC (`$0A–$0E`, `$16`, `$26–$2A`, `$3F`, `$77`, `$83–$8E`) und Blitz! laufen nicht während `SYS` und sind durch das Zurückschreiben geschützt. BASIC-7-IRQ (SOUND, PLAY, MOVSPR, Kollision) ist zu prüfen. Nachweis in VICE: Watchpoint `store` auf den Block während einer `VIEW`-Schleife mit Tastatur, SOUND/PLAY und MOVSPR (ereignisgesteuert). | Nutzer (Bereich), Opus (Nachweis) |
| D: Bank 0 `$0B00–$0BFF`, `$0E00–$0FFF` | 768 B im gemeinsamen RAM für Daten nur während `VIEW` (Masken, Zellen-/Bandzustand, Sichtliste) | bis 768 B BSS | Kassettenpuffer/Bootsektor bzw. VIC-Sprites; das Spiel darf diese Bereiche dann nicht nutzen (80-Zeichen-Spiel: VIC-Sprites ohnehin tabu) | Nutzer |
| E: Asset-Flächen verkleinern | z. B. DVG 2 KB → 1,5 KB zugunsten BSS, DMP 8 → 6 KB | 0,5–2 KB | schränkt Spiele ein | Nutzer, **nicht empfohlen** |
| F: Tabellen im Puffer `$1300` | – | – | Der Puffer ist die Ausgabe; mit M2 wachsen beide Enden aufeinander zu, kein fester freier Teil | verworfen |
| G: Zeropage per MMU (`$D507/$D508`) verlegen | Zeropage in eine Bank-1-Seite | ganze Seite ZP | Kernal-IRQ würde die verlegte Seite benutzen (Jiffy, Tastatur); nur mit eigener IRQ-Hülle (Rücksprungrahmen fälschen) sicher | verworfen (zu heikel) |

### 3.3 Empfehlung

1. **Option A jetzt** (vor P6d-opt): Sie kostet ein Byte im Stub und ein paar Testanpassungen und beendet den Platzdruck für P6e, P6f und P7, ohne dass das Spiel Asset-Fläche abgibt. Die Optimierung kann sich dann nach Zyklen richten statt nach Bytes.
2. **M2 (Einpass)**, wenn der Nutzer VCLADR variabel akzeptiert: Das spart am meisten BSS und Zyklen, und P6e braucht dann keine Sprite-Felder in einer Sichtliste. Sonst M2′.
3. **Option C** erst nach dem VICE-Nachweis. Ohne C wird der Code nur durch die Struktur kleiner (M1–M3), das reicht mit A.
4. D und E nicht nötig, solange A gilt. D bleibt die Reserve für BSS, falls die Zellentabelle oder P6e mehr brauchen als gedacht.

### 3.4 Entscheidungen des Nutzers (Speicher)

- memory map 2.4: Lib-Code bis `$DFFF`, Stub mit `$FF00 = $7F` (A)?
- Darf die Engine Bank 0 `$0B00–$0BFF`/`$0E00–$0FFF` als Arbeitsbereich (D) bzw. als Pufferfenster für `BUFSET` (K1) nutzen?
- Zeropage-Block für `VIEW` (C): welcher Bereich ist für das Spiel und eigene IRQ-Routinen tabu?

## 4. Vorschlag: Aufteilung der nächsten Arbeit

**P6d-opt vor P6e.** Gründe: (1) P6e hängt am Aufbau (Sichtliste ja/nein, ZP-Zeiger, Zellentabelle mit Objektelement und Zellindex); nach P6e müsste man die Objektlogik mit umbauen. (2) Ohne Platz (A oder Optimierung) lässt sich P6e nicht bauen. (3) Die Byte-Gleichheit mit der Referenz ist das Netz für den Umbau; sie wird mit P6e nur komplizierter.

| Schritt | Inhalt | Abnahme | Modell |
|---|---|---|---|
| **P6d-0** Entscheidungen | Nutzerfragen 5 F1–F5; Spezifikation nachziehen (Abschnitte 2.4, 3, 5.10/5.11, 7, 8) | Entscheidungen im Spec | Opus (Hauptagent) mit Nutzer |
| **P6d-1** Rahmen | Option A (Stub `$7F`, `lib.cfg` 12 KB, Rauchtest); K1 (`BUFSET`-Fenster), K2/K3 (GEOMSET-Prüfungen inkl. Wartebereich ≤ 16, ≤ 1 Boden/Decke je Zelle, Zellen zusammenhängend) in Lib **und** `dbeview.parse_dvg`; Tests für die neuen Fehlerfälle | sim grün, bytegleich; VICE-Rauchtest grün | Sonnet (klar umrissen), Review Opus |
| **P6d-2** Referenz | bei M2: `dbeview.output` mit VCL abwärts ab B1 / VMS ab B0, Eintragsreihenfolge je Eintrag umgekehrt; Pixelprüfung `run_vcl` = `paint_reference` bleibt grün; Harness liest [B0, B0 + nm) und [VCLADR, B1). Bei M2′: `dbetex` Byte 15 | Python-Tests grün | Sonnet |
| **P6d-opt** 6502 | M1, M3, M5, M6, M2 (bzw. M2′), M4 (falls C freigegeben), M7; K4-Test (MAXITEM) | **bytegleich** wie P6d (alle Sätze, auch `DBEVIEW_FULL=1`); Zyklen nach 2.4 (ohne/mit M8); Code- und BSS-Bericht; Profil je Abschnitt im Ergebnis | **Opus** (zeitkritischer 6502-Umbau mit vielen Wechselwirkungen); Messläufe Haiku |
| P6e | Objekte auf der neuen Struktur | wie Spezifikation 10 | Opus |
| P6f | MOVE, Automap; restliche Feinarbeit (M9, `spans` inkrementell) | wie Spezifikation 10 | Sonnet |
| M8 (parallel möglich) | VDC-BASIC v3: VMS-Liste aus Bank 1 (Branch `v3`), danach Engine-Anpassung | VICE-Test VDC-BASIC; sim bytegleich | Opus (VDC-BASIC-Assembler), Sonnet (Tests) |

Hinweis zum Vorgehen in P6d-opt: Erst M1 + M3 + M5 + M6 (keine Formatänderung, sofort messbar, etwa −22 000), dann M2 als eigener Commit, dann M4. Nach jedem Schritt bytegleich und mit Zyklenbericht, damit Regressionen eindeutig zuzuordnen sind.

## 5. Entscheidungsfragen an den Nutzer

| # | Frage | Empfehlung |
|---|---|---|
| F1 | memory map: Lib läuft mit `$FF00 = $7F` (Bank 1 ohne I/O), Code `$B000–$DFFF` (12 KB) | ja |
| F2 | VCL-Liste nicht mehr fest bei B0, sondern bei VCLADR (= P0 nach `VIEW`; Spiel: `::VCL` mit diesem Wert statt `4864`) – ermöglicht die Einpass-Erzeugung (M2) | ja; sonst M2′ mit DTS-Byte 15 |
| F3 | Zeropage-Block (16–24 Byte, z. B. `$63–$72`) während `VIEW` retten und benutzen, nach VICE-Nachweis | ja, mit Nachweis |
| F4 | VMS-Listen ohne Kopie: VDC-BASIC v3 führt Listen aus Bank 1 aus (bzw. residente Listen in Bank 0) – vorziehen statt nach P6g entscheiden | ja (VDC-BASIC-Variante); einzige Maßnahme, mit der die Ziele aus Abschnitt 8 und die Pufferentlastung sicher erreicht werden |
| F5 | Zyklenziele: ohne F4 auf Gang Mittel ≤ 40 000 / max ≤ 55 000, zufall max ≤ 100 000 anheben; mit F4 bei 30 000 / 45 000 / 80 000 bleiben | wie angegeben |
| F6 | Bank 0 `$0B00–$0BFF` und `$0E00–$0FFF` für die Engine (Pufferfenster, Arbeitsbereich) freigeben | optional, nur als Reserve |
| F7 | `BUFSET` auf erlaubte Fenster beschränken (K1) und neue `GEOMSET`-Grenzen (≤ 16 deckende Seiten/Fronten ohne Bit 3 je Tiefe, ≤ 64 Zellen gesamt, ≤ 1 Boden/Decke je Zelle) | ja |
