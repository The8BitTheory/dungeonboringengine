# Review-Notizen zu `plan-0.2.md` (P0, P1, P3, P4)

Stand: 2026-11-25. Gefunden beim Schreiben der Detailspezifikationen. Der Plan selbst ist unverändert; diese Punkte sind zur Abstimmung.

## A. Allgemeine Testregel: VICE-Monitor-Port (Vorgabe des Nutzers)

Gilt für alle VICE-Tests dieses Projekts (P0 und folgende) und für das vorhandene `test/vice_drive.py`, das die Regel übernehmen soll (heute: Port als Pflichtargument, kein Freitest):

- Port aus `--port`, sonst Umgebungsvariable `DBE_VICE_PORT`, sonst **6631** (nicht 6510 = VICE-Standard). Parallel laufende Tests dieses Projekts nutzen 6631–6649, jeder Test/Agent einen eigenen Port.
- Vor dem Start prüfen, ob der Port frei ist (bind-Test). Belegt: nächsten freien im Bereich nehmen (mit Meldung) oder, bei ausdrücklich angegebenem Port, mit klarer Meldung abbrechen.
- VICE ausdrücklich mit `-remotemonitor -remotemonitoraddress ip4://127.0.0.1:<port>` starten; kein `-binarymonitor` (falls doch nötig: ebenfalls eigener Port).
- Nur den selbst gestarteten Prozess (PID / `Popen`) beenden; kein `pkill`/`killall x128`/`x64sc`.
- Weiterhin: ereignisgesteuert (Haltepunkte), keine festen Wartezeiten, Timeout nur als Wächter.

Umgesetzt in `vdc-basic/docs/v3/P0-bench.md` Abschnitt 8.

## B. Render-Reihenfolge (Plan Abschnitt 5)

1. **Wände vor Objekten je Tiefe ist an inneren Fronten falsch.** Ein Objekt in Zelle (d, ±1) liegt hinter der Ebene P_d, die Front eines Blocks in (d, 0) davor; sie muss das Objekt dort verdecken, wo sie sich überschneiden. Mit „erst alle Wände der Tiefe d, dann alle Objekte der Tiefe d“ malt das Objekt über die Front. Im Westwood-Preset bei 176 × 120: Gegner auf „hinten“ in (3, +1) überdeckt die Front (3, 0) um etwa 3 Pixel, bei breiteren Sprites mehr.
   **Vorschlag:** je Tiefe Zellen von außen nach innen, je Zelle entweder ihre Flächen (Seite, dann Front) oder ihren Inhalt (Objekte nach Unterposition). Das ist die Reihenfolge von EOB (Blöcke A, G, B, F, C, E, D …) und für Objekte innerhalb ihrer Zelle exakt richtig. Die DVG-Elementtabelle (P3, 5.3) ist zellweise geordnet und erlaubt beide Varianten. Boden/Decke/Tapete bleiben vorab je Tiefe.
2. **Die genannte „bekannte Vereinfachung“ trifft so nicht zu:** Ein Objekt innerhalb seiner Zelle liegt nie hinter einer Seitenfläche derselben Tiefe (die Seitenfläche liegt seitlich weiter außen). Fehler entstehen nur bei Objekten, die breiter als ihre Zelle sind, und bei Punkt 1.
3. **Spaltenmaske und Objekte derselben Tiefe:** Die Spaltenbereiche der Seitenflächen von Tiefe d dürfen Objekte derselben Tiefe nicht wegschneiden (Objekte stehen davor). `VIEW` sollte die Abdeckung einer Tiefe erst nach deren Objektplätzen eintragen, außer Front → Seite derselben Tiefe (P3, 4.4).

## C. Geometrie (P3)

1. **Breite Vielfaches von 4, nicht nur gerade:** Damit die Mitte und alle Zellkanten auf Bytegrenzen liegen und alle Fronten einer Tiefe gleich breit sind (gemeinsames Bild), muss width_px durch 4 teilbar sein. 140 und 136 erfüllen das.
2. **Budget:** Bei 140 × 96 kostet ein Wandstil etwa **11,1 KB** (Vollfronten 6,1 KB, Seiten 5,0 KB) statt „etwa 9–10 KB“. Voraussetzung ist schon, dass Teilfronten (s ≠ 0) aus der Vollfront derselben Tiefe kopiert werden (VMC mit Quellinkrement = Vollfrontbreite, VCL-Typ 3). Ohne das 16,3 KB. Bei 26 KB Pool: 1 Wandstil + Boden- und Deckenbänder = 16,2 KB, rund 10 KB bleiben für Sprites und Tapete; 2 Wandstile + Bänder = 27,3 KB passen nicht. Möglichkeiten: Seiten d = 3, s = ±3 weglassen (je 120 Byte), 136 × 92 (10,4 KB), oder Wandstile je Zone nachladen (wie geplant).
3. **Anzahl Elemente:** Westwood ergibt 79 DVG-Elemente (11 Fronten, 14 Seiten, 18 Böden, 18 Decken, 18 Objektplätze). Die Tabellen der Lib (0.1: `MAXWS` = 64) müssen wachsen.
4. **VMS-Puffer:** Die Ränder der Seitenflächen brauchen je Zeile 1–2 Befehle; eine Seite d = 1 hat etwa 76 Zeilen. Sind viele Seiten und gemischte Boden-/Deckenkacheln gleichzeitig sichtbar, kann die Summe der VMS-Listen 1,3 KB überschreiten. Der Budgetbericht (P3, 9) gibt die obere Schranke aus; P6 sollte bei Überlauf auf deckende Kerne ohne Rand zurückfallen oder melden.
5. **Westwood-Werte sind nicht gegen Originaldaten geprüft.** P1/P2/P3-Ebenen sind aus der Erinnerung an die EOB-Renderdaten rekonstruiert und in sich konsistent; P1-Oberkante (8 statt Modell 4) und P4-Höhen sind Annahmen. Bei Zugriff auf EOB-Dateien (`*.VMP`) nachprüfen; die Werte stehen nur in einer Tabelle des Presets.
6. **Pixelseitenverhältnis:** EOB rechnet mit DOS-Pixeln (5:6), chunky-Pixel des VDC sind ebenfalls nicht quadratisch. Proportionales Skalieren übernimmt das Verhältnis; das passt nur ungefähr. Kein Handlungsbedarf, aber für die Abnahme der Optik merken.
7. **Objekte in Tiefe 0:** Nur „hinten“ (p = 0, 1) und „Mitte“ haben Fußpunkte im Bild; vorne liegt hinter der Kamera. Sprite-Sätze brauchen für d = 0 große Bilder; vermutlich reicht es, Gegner in der eigenen Zelle nicht zu zeichnen (wie EOB).

## D. Formate und Schnittstellen

1. **Unterpositionen absolut speichern** (Karte, Objektliste: NW, NO, SW, SO, Mitte) und in `VIEW` mit der Blickrichtung umrechnen (Tabelle P4, 2.6). Der Plan sagt nur „Unterposition“.
2. **Ein Gegenstand je Zelle** in der Inhaltsebene (6 Bit) – die vier Westwood-Plätze brauchen mehr. Vorschlag: Inhaltsebene = Gegenstand auf „Mitte“, weitere über die Objektliste. Falls vier Plätze aus der Karte kommen sollen, wäre eine eigene Gegenstandsliste (Zelle, Platz, Gegenstand) besser als ein breiteres Feld.
3. **Objektliste 16 × 6 Byte** + Anzahl = 97 Byte passt nicht an die heutige Stelle `$0C10` (würde den Testbereich `$0C40–$0C4F` überschreiben). In P6 neu legen, z. B. `$0C50–$0CB0` (Reserve) oder in den Puffer bei `$1300`.
4. **Stilnummern:** DMP nutzt 0 = nichts, n = DTS-Stil n − 1; DTS (P5) nutzt `$FF` = Stil 0 als Ersatz für fehlende Bilder. Beides passt zusammen, muss aber in P5 genau so übernommen werden.
5. **DECKEND doppelt:** Abdeckung nur, wenn Kachel-Flag DECKEND **und** das Bild im DTS deckend ist (Fenster, Gitter). Der DVG-Kern ist der geometrisch größte; DTS-Bilder mit eigener Transparenz brauchen einen eigenen Kern bzw. das Flag „nicht deckend“ (P5).
6. **Bänder mit Lücken:** Zellen mit deckendem Block (vier Wandstile, DECKEND) sind keine Lücke im Boden-/Deckenband, auch wenn ihr Boden 0 ist (P4, 2.4); sonst würde unnötig Tapete gezeichnet.
7. **`RXV`-Schnittstelle (P2b):** Vorschlag: `RXV src,dst` mit src = Stromanfang (Dateikopf von BASIC übersprungen, `BE+5`), damit eingebettete Ströme (DTS) ohne Kopf gehen. Alternativ zwei Formen; in P2b festlegen.
8. **Schwelle T patchbar:** T aus VICE ist nicht übertragbar (P0, Abschnitt 2). `RXV` sollte T aus einem dokumentierten Byte lesen (z. B. per `POKE` oder Fake-Register über `RGW`), Standard aus der Messung auf echter Hardware.

## E. Messung (P0)

1. **VICE-VDC-Timing ist ein grobes Modell** (vdc-mem.c 3.10): 43 Takte busy je Reg-31-/Reg-18/19-Zugriff im sichtbaren Bereich, 4 im Rand; Block fill 0,66 Takte je Byte, Copy 1,2; Reg 36 ohne Wirkung, kein Datenverlust. Die Planwerte „15 Zyklen je Byte“ und „etwa 200 Zyklen Fill-Fixkosten“ sind ihrer Herkunft nach unklar (echte Hardware oder VICE?) und sollten mit den P0-Ergebnissen ersetzt werden.
2. **Messung auf echter Hardware vorsehen:** Das Messprogramm läuft ohne Harness auf einem C128 und speichert `BENCHRES` per `BSAVE` (P0, Abschnitt 11). Erst diese Werte gelten für T und für den Reg-36-Befund.
3. **Ladepuffer und Speicher:** Plan 3 „Zu prüfen“ bleibt offen; das Messprogramm nutzt `$2000–$7FFF` in Bank 0 und läuft mit v2h bei `$1300`, kollidiert also nicht mit der v3-Verlegung.
