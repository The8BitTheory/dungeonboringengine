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
9. **Crawl-Port (P7): Edelsteine stehen doppelt in der Karte.** `crawlmap` legt einen Edelstein als Kachel 2 **und** als Gegenstand 2 ab. `crawl.bas` 5500 setzt beim Einsammeln den Zellwert auf 0, 5360 prüft `V%=2`. Der Port muss beim Einsammeln den Gegenstand löschen und die Kachel auf 0 setzen (Lib-Funktion zum Kachelwechsel) oder die Abfrage auf den Gegenstand umstellen, sonst wird derselbe Edelstein mehrfach gezählt. Ebenso braucht der Ausgang (5550: 40 → 42) den Kachelwechsel; Kachel 42 legt `crawlmap` deshalb immer an.

## E. Messung (P0)

1. **VICE-VDC-Timing ist ein grobes Modell** (vdc-mem.c 3.10): 43 Takte busy je Reg-31-/Reg-18/19-Zugriff im sichtbaren Bereich, 4 im Rand; Block fill 0,66 Takte je Byte, Copy 1,2; Reg 36 ohne Wirkung, kein Datenverlust. Die Planwerte „15 Zyklen je Byte“ und „etwa 200 Zyklen Fill-Fixkosten“ sind ihrer Herkunft nach unklar (echte Hardware oder VICE?) und sollten mit den P0-Ergebnissen ersetzt werden.
2. **Messung auf echter Hardware vorsehen:** Das Messprogramm läuft ohne Harness auf einem C128 und speichert `BENCHRES` per `BSAVE` (P0, Abschnitt 11). Erst diese Werte gelten für T und für den Reg-36-Befund.
3. **Ladepuffer und Speicher:** Plan 3 „Zu prüfen“ bleibt offen; das Messprogramm nutzt `$2000–$7FFF` in Bank 0 und läuft mit v2h bei `$1300`, kollidiert also nicht mit der v3-Verlegung.

## F. Texturen (P5)

Gefunden beim Schreiben von `P5-textures.md`.

1. **DTS braucht zwei Dateien.** `RXV` liest aus Bank 0, die Engine ihre Metadaten aus Bank 1. Der Plan („Die Bilddaten liegen in einem VRL-Strom“) lässt offen, ob der Strom in der DTS steckt. P5 legt fest: `<name>.dts` (Bank 1) + `<name>.vrl` (Bank 0, Ladepuffer, danach frei); ebenso DBG. Der Ladepuffer in Bank 0 muss die größte VRL fassen (Wandstil roh etwa 11 KB, gepackt weniger) – das verschärft den offenen Punkt „Ladepuffer des Spiels“ (Plan 3).
2. **Teilfronten mit Transparenz (zu C.2).** Das Kopieren per `VMC` mit Quellinkrement gilt nur für Kerne. `VMS` liest die gepackte Quelle streng fortlaufend und kann keine Bytes überspringen; der Rand einer nicht deckenden Front (Fenster, Gitter) braucht je Teilfront eigene gepackte Randbytes und eine eigene VMS-Liste. Das P3-Budget (Teilfronten 0 Byte) gilt nur für deckende Fronten.
3. **VMS Typ 8 vergleicht nur das rechte Nibble** mit dem Alpha-Wert. Ein halbes Byte mit transparentem linkem Pixel darf rechts nicht die Alpha-Farbe haben. P5 wählt Alpha je Liste (kleinste nicht benutzte Farbe); Crawl kam mit Alpha 0 aus, weil Schwarz dort Hintergrund war.
4. **Kerne kommen aus dem DTS, nicht aus der DVG.** Ein gemaltes Bild kann eigene Transparenz im DVG-Kern haben. P5 speichert je Bild bis zu 4 Kerne (VCL-Typ 2/3) plus Rand; P6 zeichnet nach dem DTS. Die VCL-Liste wächst dadurch (bis zu 4 × 11–13 Byte je Bild statt 11) – bei der Größe des VCL-Puffers (Plan 3: etwa 1 KB) in P6 nachrechnen.
5. **VRL-Ladeadresse `$2000` (P1, 3) liegt in VDC-BASIC v3** (`$1C00–$3FFF`, Plan 3). Unschädlich, solange mit `BLOAD …,P(BE)` geladen wird, aber als Standard irreführend. Vorschlag: Standard `$4000` oder ohne Bedeutung dokumentieren; P5 nutzt `vrl_load = $4000`.
6. **Memory map für Bank 1 fehlt.** DVG `$E400`, DMP `$8000`, SPR v1 `$E200`/`$EA00`, Lib ab `$C000`; DTS (bis drei je Zone, Wand-DTS mit mehreren Stilen 1–3 KB) und DBG brauchen feste Plätze. P5 nimmt vorläufig `$A000` (Wand) und `$A900` (DBG) als Vorgabe; P6 sollte die memory map festlegen.
7. **Geometrie-ID enthielt `origin`** (erledigt: `origin` fließt seit P3 5.5 nicht mehr in die ID ein; DVG-Kopf unverändert). DTS und DBG hängen von stride, Rechtecken und Masken ab, nicht von der Lage des Fensters im Puffer; die ID beschreibt jetzt die Form, nicht die Lage.
8. **Sprites können am Fensterrand nicht beschnitten werden** (betrifft P5b/P6, Plan 5 nennt nur zu breite Sprites als Fehlerquelle). SPR v1 hatte je (d, s) passende Teile; ein lagenunabhängiges Bild auf s = ±1 ragt aus dem Fenster und `VMS` schreibt dann in HUD bzw. die Nachbarzeile. Optionen in `P5-textures.md` 11.
9. **Budget für Sprites (zu C.2):** Nach einem Wandstil, Boden- und Deckenstil bleiben etwa 10 KB; ein Gegner mit 4 Blickwinkeln × 2 Phasen × 3 Tiefen braucht grob 6–9 KB. Zeilenfüllung für einfarbige Bänder (P5, 5.6) spart bis 5 KB, reicht aber nicht für mehrere Gegnertypen gleichzeitig – Asset-Planung je Zone nötig.

## G. Sprites und Engine (P5b, P6)

Gefunden beim Schreiben von `P5b-sprites.md` und `P6-engine.md`. Die Folgen sind dort eingearbeitet; Änderungen an P3/P4/P5 setzt P6h bzw. P5b um (P6 11).

1. **Bank-1-Speicherkarte (zu F.6):** Das Demo-Wand-DTS mit 4 Stilen hat 8 736 Byte (`docs/specs/examples/tex/demo_walls.tex.md`) und passt nicht in die Vorgabe `$A000–$A8FF` vor der DBG bei `$A900`. P6 2.4 legt die Speicherkarte F fest: DMP `$5000`, S2 `$7000`, DTS Wand `$9000`, Lib `$B000–$CFFF`, Lib-BSS `$E000`, DVG `$E800`, DTS Boden `$F000`, Decke `$F800`, DBG `$FE00`; BASIC-Variablen bis `$4FFF`. Die Standard-Ladeadressen der Werkzeuge ändern sich entsprechend.
2. **Gitter und VMS-Puffer (zu C.4, F.4):** Mit `max_kerns` = 4 hat die Gitter-Vollfront d = 1 eine VMS-Liste von 1 467 Byte (größer als der geplante VMS-Puffer), Summe aller Gitterbilder 5 145 Byte. Messung mit dem P5-Beispiel und höherem `max_kerns`: 8 → größte Liste 891, Summe 4 041; **16 → 371, Summe 3 214** (NK des DTS 154 ≤ 255); 32 bringt kaum mehr (Rest sind halbe Bytes an den Stabkanten, Typ 8). Vorschlag (P6 11): `max_kerns` 0 … 16 in DTS und S2; die Engine kennt keine feste Grenze außer dem Puffer. Kosten: je Kern 11–13 Byte VCL statt Randlisten.
3. **Ein Puffer für VCL und VMS:** Statt fester Teile (1 KB VCL + 1,3 KB VMS, zusammen mehr als `$1300–$1BFF` = 2 304 Byte) liegen die VMS-Listen direkt hinter der VCL-Liste; die Größenrechnung im Sichtdurchlauf ist exakt (P6 5.10). `dbetex` prüft künftig „VCL + VMS je Bild“ gegen 2 304 statt nur VMS gegen 1 300. Überlauf: Rand weglassen (A = 3) oder hinten kürzen (A = 2).
4. **Lib-Größe:** Geschätzt etwa 5 KB Code und 1,4 KB Variablen (P6 2.6); `$C000–$CFFF` reicht nicht. P6 legt die Lib nach `$B000–$CFFF` (Sprungtabelle `$B000`, der Stub springt dorthin) und die Variablen nach `$E000–$E7FF`.
5. **Fronten und Bänder derselben Tiefe:** Eine deckende Front (d, s) übermalt die Boden- und Deckenbänder ihrer Tiefe nur, wenn ihr Rechteck die Band-Zeilen enthält. In der Ebenen-Geometrie (P3) gilt das immer, in einer frei erzeugten DVG (Crawl, P7) nicht. Vorschlag: DVG-Flag **Bit 3 „Bandabdeckung“** (bisher reserviert 0; ändert die Geometrie-ID der Beispiele). `VIEW` führt dafür eine zweite Spaltenmaske für Bänder/Tapete (P6 5.1, 5.2).
6. **Crawl-Port ohne WALLSET:** Die Crawl-Wandbilder folgen keiner Ebenen-Geometrie; die Zellen (2, ±1) und (3, ±1) haben je zwei Frontbilder (Slots 8/9, 11/12, 15/16, 18/19 in `wallconv.py`). Vorschlag: P7-Konverter schreibt eine Crawl-DVG direkt (mehrere Elemente je Zelle, Anker so, dass die Geister an den Crawl-Spalten landen), ein DTS nur aus Kernen und S2-Sätze. Die 0.1-Funktionen `WALLSET`/Sprite-Sätze v1 entfallen in 0.2 (A = 255 bzw. E_FORMAT). Alternative wäre ein Kompatibilitätspfad in der Lib (etwa 1 KB Code).
7. **Formatregel für VMS-Listen:** Das Beschneiden in `VIEW` setzt voraus, dass die Befehle zeilenweise mit steigendem ofs stehen und ein Lauf seine Zeile nicht verlässt (ofs mod stride = Spalte, Bildbreite ≤ stride). `pack_image` erzeugt das, die Formate (P5 4.6, P5b 4.6) sollten es ausdrücklich verlangen.
8. **Sprites höher als die Wand:** `VIEW` beschneidet Sprites nur nach Spalten. Eine Abdeckung gilt für die Zeilen der Ebene P_{d+1}; was von einem Sprite über die Wandoberkante der davor liegenden Wand ragt, würde mit weggeschnitten. P5b warnt beim Import; die Pixelprüfung in P6 schließt solche Szenen aus.
9. **`sim_vms` kennt Typ 3 nicht** (P5 7.2): P5b ergänzt ihn; der Python-VCL-Interpreter in `dbeview` braucht ihn ebenfalls.
10. **Standard-Ladeadressen** in P3 (`$E400`), P4 (`$8000`), P5 (`$A000`, `$A900`) folgen der neuen Speicherkarte (G.1).
11. **Außerhalb der Karte in 0.1:** `VIEW` 0.1 prüfte nur den Zellindex gegen W·H; Zellen links/rechts über den Rand liefen in die Nachbarzeile. Für Crawl unschädlich (Randwände), für 0.2 rechnet `VIEW` mit x/y-Grenzen (P6 5.1). Crawl-Pixelgleichheit (P7) kann dadurch an Kartenrändern abweichen, falls Crawl dort selbst „umbricht“ – beim Port prüfen.
12. **Systempuffer:** `$0B00` (Kassette/Bootsektor), `$0C00–$0DFF` (RS-232) und `$0E00–$0FFF` (VIC-Sprites) nutzt die Engine seit 0.1; Spiele dürfen RS-232 und VIC-Sprites nicht verwenden. Dokumentieren (P8).
13. **Kürzung im Fehlerfall:** Bricht `VIEW` wegen vollem Puffer ab, fehlen die hinteren Teile; weil Bänder und Tapete einer Tiefe nach deren Zellen in der Sichtliste stehen, bleiben dann ganze Zeilen ungezeichnet. Bewusst als Fehlerzustand (A = 2) behandelt; `dbeview budget` misst Szenen vorab.
14. **Objekte in Zellen mit Flächen** (Tür, Gitter mit Gegenstand) werden nach Plan 5 nicht gezeichnet. Falls Gegenstände in Türzellen vorkommen sollen, bräuchte die Kachel ein Flag „Inhalt zeigen“.
15. **Blitz!-Variablen in Bank 1** (Lage, Obergrenze `$39/$3A`) sind für Speicherkarte F ungeprüft → P6a.
16. **Korrektur zu P2a 4:** „BASIC-Variablenanfang in Bank 1 auf ≥ `$2000` setzen“ ist nicht nötig. Das 8-KB-Common-RAM ist nur während eines Lib-Aufrufs eingeschaltet; die Einschränkung betrifft nur Engine-Daten in Bank 1 (nicht unter `$2000`).
