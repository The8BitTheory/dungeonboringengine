# Dungeon-Crawler-Engine für den C128 – Entwurf

Stand: 2026-11-23, Entwurf zur Abstimmung. Ausgangspunkt ist `game/crawl.bas` aus [dungeoncrawlerjam2025](https://github.com/The8BitTheory/dungeoncrawlerjam2025) (Crawl 128) mit VDC-BASIC v2g. Die Engine entsteht in diesem Repo.

### Entscheidungen (2026-11-23)

| Thema | Entscheidung |
|---|---|
| Repo | `dungeonboringengine` ist das eigene Repo der Engine. Änderungen laufen über Branch und Pull Request. |
| Zeichnen | Die Engine baut auf VDC-BASIC auf und zeichnet über `VCL`. Fehlt etwas, wird `VCL` erweitert; eine eigene VDC-Routine in der Lib gibt es nicht. |
| Ort der Lib | Wird anhand gemessener Größen entschieden (Schritt 1, Abschnitt 3.2). |
| Interrupts in Bank 1 | Die Lib kopiert die Kernal-Interruptweiche nach Bank 1 `$FF05–$FFFF` (wie c128-vdc-gui). Interrupts bleiben an, kein `SEI`. |
| Kartenformat | Eigener Schritt, Abschnitt 5.1 ist nur Platzhalter. |
| c128-vdc-gui | Wird im Spiel nicht verwendet, dient nur als Informationsquelle. |

## 1. Ziele und Randbedingungen

- **Allgemein:** beliebige Wandsätze, einstellbare Sichttiefe und -breite, mehrere Karten, mehrere Sprite-Sätze (Gegner, Gegenstände).
- **Blitz!-kompatibel:** Das Spiel bleibt ein BASIC-7-Programm, das interpretiert läuft und mit Blitz! 128 kompiliert werden kann. Alle Aufrufe über `SYS`/`RREG`, `POKE`/`PEEK` und VDC-BASIC-Befehle (hinter `::`).
- **Aufteilung:** BASIC behält Spielregeln, Ablauf, HUD-Texte, Sound und Laden der Dateien. Alles, was pro Schritt viele Feldzugriffe oder viele VDC-Befehle braucht, wandert in Assembler.
- **Zeropage:** Die Lib nutzt `$FA–$FD` und während eines Aufrufs den Block `$63–$72`, den der Stub rettet und zurückschreibt (P6d-opt, `P6-engine.md` 2.1). `$3D/$3E` (Blitz!) und `$05–$08` (SYS-Register) bleiben unberührt.

## 2. Schichten

| Schicht | Inhalt | Wo |
|---|---|---|
| Spiel (BASIC) | Regeln, Menüs, HUD (`VMP`), Sound, `BLOAD` der Assets, Kampf, Highscores | `crawl.bas` |
| **DCL** – Dungeon-Crawler-Lib (neu, Assembler) | Karte, Sichtberechnung, Renderliste, Objekte/Gegner im Sichtfeld, Bewegung/Kollision, Gegner-KI, Automap | dieses Repo, `engine/`; Speicherort nach Messung (3.2) |
| VDC-BASIC v2g | allgemeine VDC-Operationen: `VMC`, `VMF`, `VMS`, `VMP`, `RTV`, `VCL` (Befehlslisten) | `$1300–$1BFF`, Bank 0 |

Regel für die Grenze: **Was nichts über Dungeons weiß, gehört in VDC-BASIC** (Kopieren, Füllen, transparente Sprites, Befehlslisten). **Was Karte, Blickrichtung oder Wandsätze kennt, gehört in die DCL.**

Die DCL zeichnet nicht selbst, sondern erzeugt eine VCL-Liste. BASIC führt sie mit `::VCL` aus. So bleibt aller VDC-Code in VDC-BASIC, und die DCL lässt sich ohne VDC testen (Liste vergleichen). Reicht `VCL` nicht aus (Länge, Typen, Tempo), wird VDC-BASIC erweitert (Abschnitt 7).

## 3. Speicheraufteilung

### 3.1 Feste Bereiche

| Bereich | Bank | Inhalt |
|---|---|---|
| `$0B00–$0BFF` | 0 | VCL-Puffer (256 Byte = heutige Grenze von `VCL`) |
| `$0C00–$0C3F` | 0 | DCL-Parameterblock (Abschnitt 4) |
| `$0C10–$0C30` | 0 | Objektliste (Anzahl, je 4 Byte Position, Satz, Richtung) |
| `$0C40–$0C4F` | 0 | nur Tests: Zeitmessung (`$0C40`), Szenen-Testhilfe (`$0C44`) |
| `$0C50–$0CFF` | 0 | Reserve |
| `$0D00–$0D83` | 0 | Stub (`SYS 3328` Init, `SYS 3331,F,X,Y` Aufruf), Rest bis `$0DFF` Reserve |
| `$0E00–$0FFF` | 0 | VMS-Listen, die `VIEW` je Bild schreibt (512 Byte) |
| `$1300–$1BFF` | 0 | VDC-BASIC v2g |
| `$FF05–$FFFF` | 1 | Kopie der Kernal-Interruptweiche (nur falls die Lib in Bank 1 liegt) |

Zeropage: `$FA–$FD`, dazu `$63–$72` während eines Aufrufs (vom Stub gerettet, P6d-opt). VDC-BASIC nutzt `$83–$8E`, Blitz! braucht `$3D/$3E`, `$05–$08` ist die SYS-Registerübergabe.

### 3.2 Ort der Lib – Kandidaten

| Kandidat | Größe | interpretiert | kompiliert | Aufwand |
|---|---|---|---|---|
| A: Bank 1 ab `$8000` (durch `POKE 58,128` geschützt), geteilt mit Karten und Tabellen | bis 32 KB | ja | ja | Bankwechsel je Aufruf (`$D506` gemeinsames RAM, `$FF00=$7E`), Interruptweiche in Bank 1 |
| B: Bank 0 `$0D40–$0FFF` | < 1 KB | ja | ja | keiner, aber nur für einen Stub oder sehr kleine Lib |
| C: Bank 0 `$1C00–$3FFF` | 9 KB | nein (BASIC-Text) | ja (Blitz! Image 2) | scheidet aus, solange interpretiert entwickelt wird |
| D: Bank 0 oben, Textende von BASIC abgesenkt (z. B. `$E000–$FEFF`) | bis 8 KB | ja | prüfen | kein Bankwechsel für den VCL-Puffer; läuft nur mit ausgeblendetem ROM; Verträglichkeit mit Blitz! offen |

Entschieden wird nach Schritt 1 anhand dieser Messwerte:

- Codegröße je Funktion (aus der ld65-Map)
- Tabellen: Sichtversätze (4 Richtungen × Gitterzellen × 2 Byte), Wandsatz (Einträge × 8 Byte), Sprite-Sätze, Kacheltabelle
- Kartengröße der vorgesehenen Karten
- Länge der VCL-Liste je Sichttiefe (D = 3, 4, 5)
- Laufzeit eines `VIEW`-Aufrufs und der anschließenden `VCL`-Ausführung (Rasterzeilen bzw. `TI`)

### 3.3 Bankwechsel (falls Bank 1)

Wie c128-vdc-gui: Für jeden Aufruf schaltet der Stub gemeinsames RAM ein (`$D506` unten; umgesetzt sind 4 KB, `$0000–$0FFF`) und `$FF00=$7E` (RAM 1, I/O). VCL-Puffer und Parameterblock liegen dann physisch in Bank 0, wo `VCL` sie erwartet, und sind aus Bank 1 sichtbar. Beim Rücksprung stellt die DCL `$D506` und `$FF00` wieder her. Interrupts laufen über die Weiche bei `$FF05` in Bank 1 weiter.

### 3.4 Messwerte aus Schritt 1

Gemessen mit `crawl.bas` (Karte 20 × 11, Wandsatz mit Sichttiefe 3, 19 Bilder). Die Bildschirmausgabe ist in allen 19 Testbildern pixelgleich mit dem Original.

| Größe | Wert | Quelle |
|---|---|---|
| Lib-Code (`INFO`, `MAPINIT`, `SETPOS`, `WALLSET`, `VIEW`) | 944 Byte | `build/lib.map` |
| Lib-Variablen | 220 Byte (Spaltenabdeckung 128, Sichtliste 44, Rest 48) | `build/lib.map` |
| Stub (Bank 0) | 132 Byte | `build/stub.map` |
| Wandsatz-Metadaten | 10 + 10 je Eintrag; Crawl: 200 Byte | `tools/wallconv.py` |
| Karte | Breite × Höhe; Crawl: 220 Byte | – |
| VCL-Liste je Bild | 19–96 Byte, Mittel 57 (1–8 Wandeinträge) | sim65, alle 400 Ansichten |
| `VIEW` | 7613–10864 Zyklen, Mittel 9557 | sim65, alle 400 Ansichten |
| Renderphase (Zeilen 4600 ff.), 18 Tasten, 13 neu gezeichnete Bilder plus Startbild | Original 981 Jiffies, DBE 149 Jiffies (etwa 6,6-mal schneller) | VICE, `TI` |
| Ganzer Schritt mit Bewegung oder Drehung | Original 2,18 Mio. Zyklen, DBE 1,32 Mio. (−39 %) | VICE, Stoppuhr |

Der Rest eines Schritts (1,3 Mio. Zyklen) ist BASIC: Gegner-KI, HUD, Münzen und Geister. Münzen und Geister zeichnet seit Schritt 1b die Lib; die KI folgt in Schritt 6.

**Nach Schritt 1b (Objekte in `VIEW`):**

| Größe | Wert |
|---|---|
| Lib-Code (zusätzlich `SPRITESET`, `ITEMSET`, `SETCELL`, Objekte, VMS-Listen) | 1834 Byte |
| Lib-Variablen | 342 Byte |
| Sprite-Metadaten Crawl | Geister 1854 Byte (24 Teile, 8 VMS-Listen mit 111–265 Byte), Edelstein 186 Byte |
| Geisterbilder im VRAM | 1882 Byte gepackt statt 2338 Byte `RED.VDC` + `RED1.VDC` |
| `VIEW` ohne Objekte im Bild | 10813–14191 Zyklen (Objektplätze kosten etwa 3500 Zyklen) |
| 10 Szenen mit Geist im Bild, ganzer Schritt | Original 2,14 Mio. Zyklen, DBE 1,07 Mio. (−50 %) |

**Hochrechnung für den Ausbau** (Schätzung, nicht gemessen):

| Teil | Code | Daten |
|---|---|---|
| heute (Schritt 1b) | 1,8 KB | 0,3 KB |
| `MOVE`, `CELL`, Automap | +0,4 KB | – |
| `ENEMYSTEP` | +0,3 KB | Gegnerliste |
| Kartenformat mit Kacheltabelle | +0,3 KB | 256 Byte Kacheltabelle |
| **Summe** | **etwa 2,8 KB** | **etwa 0,6 KB plus Assets** |

**Vorschlag:** `$C000–$CFFF` (4 KB) für Code und Variablen der Lib reservieren. Assets und Karten liegen in Bank 1 außerhalb dieses Bereichs: `$8000–$BFFF` für Karten, `$E000–$FEFF` (mit `$FF00=$7E` als RAM sichtbar) für Wandsatz- und Sprite-Metadaten.

## 4. Aufrufschnittstelle

```
BANK 1:SYS 49152,F,X,Y     : REM F = Funktionsnummer, X/Y = kleine Parameter (Adresse/Bank je nach Ort, 3.2)
RREG A,X,Y,S               : REM Ergebnis (Status, Werte)
```

- Am Anfang der Lib liegt ein `JMP` auf den Dispatcher, der über den A-Wert verzweigt. So bleiben Einsprungadressen bei neuen Versionen gleich.
- Größere Parameter (Wörter, Adressen) stehen im Parameterblock `$0C00` in Bank 0 und werden mit `BANK 0:POKE` geschrieben. Ergebnisse, die nicht in A/X/Y passen, liegen ebenfalls dort.
- Rückgabe in A: 0 = ok, sonst Fehlernummer.

### Funktionen (erste Fassung)

| F | Name | Eingang | Ausgang |
|---|---|---|---|
| 0 | `INFO` | – | A = Version, X/Y = Adresse Parameterblock |
| 1 | `MAPINIT` | Block: Adresse Rohkarte (Bank 0), Breite, Höhe, VRAM-Adresse Automap | Karte nach Bank 1 übernommen, Automap im VRAM gefüllt, Startpunkte/Teleporter/Ausgang im Block |
| 2 | `SETPOS` | X = Richtung, Block: Position | – |
| 3 | `MOVE` | X = Bewegung (vor, zurück, links, rechts seitwärts, drehen) | A = Ergebnis (bewegt, Wand, Gegner); Block: neue Position, Zellwert am Ziel |
| 4 | `VIEW` | Block: Puffer-Adresse (`AP`) | VCL-Liste ab `$0B00`; Block: Anzahl Einträge, sichtbare Objekte |
| 5 | `CELL` | Block: Position | A = Zellwert (für Spiellogik wie Münzen, Ausgang) |
| 6 | `SETCELL` | Block: Position, Wert | Karte und Automap-Zelle aktualisiert |
| 7 | `ENEMYSTEP` | X = Gegnernummer | Gegner einen Schritt Richtung Spieler bewegt (Manhattan, wie Zeilen 7800–8020) |
| 8 | `WALLSET` | Block: Adresse Header (Bank 0), VRAM-Basis | Wandsatz-Tabelle in Bank 1 angelegt |
| 9 | `SPRITESET` | Block: Nummer, Adresse Header, VRAM-Basis | Sprite-Satz registriert |

BASIC-Seite eines Schritts (Ziel):

```
BANK 1:SYS 49152,3,1:RREG R      : REM einen Schritt vor
IF R=2 THEN GOSUB 5500           : REM Münze -> HUD, Sound
BANK 0:POKE 3074,AP AND 255:POKE 3075,AP/256
BANK 1:SYS 49152,4:BANK 15
::VCL 2816
```

Das ersetzt die Zeilen 4600–5900 (Sichtprüfung, `FN M`, `RL%`, `RQ%`, Münzen- und Geisteranzeige) und 5300–5400 (Bewegung, Kollision).

## 5. Datenformate

### 5.1 Karte

Wird in einem eigenen Schritt festgelegt. Bis dahin nutzt die DCL das heutige Format aus `CRAWL128.CD1`: ein Byte pro Zelle, zeilenweise, Bit 0 = Wand. Anforderungen für den späteren Schritt: mehrere Karten, mehrere Wandstile je Karte, Zellen, die nur den Weg oder nur die Sicht versperren, Ereignisse für BASIC (Münze, Teleporter, Ausgang), Automap-Marken.

### 5.2 Wandsatz

Die Sicht ist ein Gitter aus **Tiefe d = 0…D** (0 = eigene Zelle) und **Seite s = −S…+S**. Jede Zelle des Gitters kann bis zu drei sichtbare Flächen haben: Front und, außerhalb der Mitte, eine Seitenfläche.

```
Header:  "WS", Version, D, S, Anzahl Wandstile, Eintragslänge (8)
Eintrag: Stil, d, s, Fläche (0 Front, 1 Seite)
         VRAM-Quelloffset (2), Breite in Byte (1), Höhe in Rasterzeilen (1),
         Zieloffset im Bild (2, relativ zu AP)
Danach:  Bilddaten (werden von BASIC mit RTV ins VRAM kopiert)
```

- Der heutige Satz (`WALLS.VDC`, 7-Byte-Einträge, Ziel = Byte + 406, D = 3, S = 1) lässt sich mit einem Konverter (Python) verlustfrei in dieses Format überführen.
- Fehlt einem Stil ein Eintrag, nimmt die DCL Stil 0. So kann ein Wandsatz klein anfangen.

### 5.3 Sprite-Satz (Gegner, Gegenstände)

```
Header:  "SP", Version, Anzahl Winkel (1 oder 4), Anzahl Tiefen
Eintrag: Winkel, d, VRAM-Quelloffset (2), Breite, Höhe, Ziel-Ankerversatz (2)
```

- Der Winkel ergibt sich aus Blickrichtung Spieler gegen Blickrichtung Gegner (heute `GV%()`).
- Ausgabe über `VMS` (transparent). Halbe Sprites am Rand (heute Zeilen 6400/6500) erledigt die DCL über Breite und Quellversatz.
- Münzen (heute `VMC` 3×6 an festen Stellen) werden ein Sprite-Satz mit einem Winkel.

## 6. Sichtberechnung (`VIEW`)

1. **Versätze:** Für jede Gitterzelle (d, s) gilt Kartenversatz = d·F + s·R. F und R hängen von der Blickrichtung ab (N: −B, +1; O: +1, +B; S: +B, −1; W: −1, −B; B = Kartenbreite). Die Tabelle wird bei `MAPINIT` je Richtung einmal berechnet; das ersetzt `V%(3,19)`.
2. **Vorne nach hinten:** Für d = 0…D wird eine Spaltenmaske (welche Bildspalten sind schon verdeckt) mitgeführt. Eine sichtversperrende Zelle trägt ihre Front- und Seitenflächen ein, sofern sie noch nicht verdeckt sind, und verdeckt danach ihre Spalten. Ist die Maske voll, endet die Suche. Das ersetzt die handgeschriebenen Fälle in 5100–5210 und `RL%()`.
3. **Objekte:** Gegner und Gegenstände in sichtbaren Zellen kommen in dieselbe Liste, mit der Tiefe als Sortierschlüssel.
4. **Ausgabe:** Die Liste wird hinten nach vorne als VCL geschrieben: Typ 2 (VMC mit Inkrement = Bildbreite) für Wände, VMS-Typ für Sprites, Ende-Byte 0. Das entspricht dem heutigen `RQ%`-Rückwärtszeichnen.

Mit 11 Byte je VMC-Eintrag passen 23 Einträge in 256 Byte. Für D = 3 genügt das. Für größere Tiefen braucht `VCL` eine Erweiterung (Abschnitt 7).

## 7. Erweiterungen in VDC-BASIC (v2g, 211 Byte frei)

| Nr | Änderung | Grund |
|---|---|---|
| V1 ✓ | VCL-Typ 12 für `VMS` (transparente Sprites); VMS-Listen mit 2 Byte Befehlszahl und mehr als 256 Byte Länge | Gegner und Gegenstände in derselben Liste wie Wände (Branch `v2g`, ab `ec049bd`; aktuell v2h, Branch `v2h`) |
| V2 | VCL mit 16-Bit-Offset oder Verkettung (Typ „weiter bei Adresse“) | mehr als 23 Einträge bei größerer Sichttiefe |
| V3 | Tokendatei, Doku zu `VCL`/`VMS`/`VMB` | Typen 8–12 im Kommentar sind nicht implementiert; Doku sollte den echten Stand zeigen |

Alles andere aus `crawl.bas` (HUD-Texte, Rahmen, Titelbild, Automap-Ausschnitt, Kampfeffekte) lässt sich mit den vorhandenen Befehlen abbilden und bleibt in BASIC.

## 8. Umsetzung in Schritten

| Schritt | Inhalt | Prüfung |
|---|---|---|
| 1 ✓ | Gerüst und Messung: Sprungtabelle, Bankwechsel und Interruptweiche, `INFO`, Parameterblock; Wandsatz-Konverter (Python, aus `WALLS.VDC`), `WALLSET`; `VIEW` nur Wände auf dem heutigen Kartenformat; Build mit ca65 | erledigt: `crawl.bas` interpretiert in VICE mit `VIEW` statt der BASIC-Sichtberechnung, 19 Testbilder pixelgleich mit dem Original (Bildvergleich statt Listenvergleich); Interrupts während der Lib nur indirekt geprüft (keine Abstürze bei rund 10 000 Zyklen je Aufruf und 60-Hz-IRQ); Messwerte in 3.4 |
| 1b ✓ | Objekte in `VIEW`: Geister (transparent per `VMS`) und Edelsteine an der richtigen Tiefe; VCL-Typ 12 (`VMS`) in VDC-BASIC; `SPRITESET`, `ITEMSET`, `SETCELL`, Arbeitskopie der Karte in `MAPINIT` | erledigt: Crawl-Testlauf pixelgleich bis auf die transparenten Geisterecken; 10 gestellte Szenen (Geist seitlich, mittig, teilweise verdeckt) |
| 2 | Entscheidung Ort der Lib anhand der Messwerte, Lib dorthin legen | Messwerte und Entscheidung in diesem Dokument |
| 3 | Kartenformat festlegen (eigener Entwurf) | Abstimmung |
| 4 | `MAPINIT`, `SETPOS`, `CELL`, `MOVE`; `crawl.bas` auf `VIEW` und `MOVE` umstellen | Spieltest wie bisher (W/E/M), Bildvergleich per Screenshot, Zeit pro Schritt (`TI`) |
| 6 | `ENEMYSTEP`, Automap über `SETCELL` | Spielverhalten gleich, Geschwindigkeit messen |
| 7 | Verallgemeinern: D = 4, zweiter Wandsatz, zweite Karte, V2 | Demo-Karte mit größerer Sicht |
| 8 | Blitz!-Kompilat | in VICE und auf echter Hardware |

Ab Schritt 4 gibt es nach jedem Schritt eine lauffähige Fassung des Spiels.

## 9. Offene Entscheidungen

1. **Ort der Lib:** nach den Messwerten aus Schritt 1 (Kandidaten in 3.2).
2. **Kartenformat:** eigener Schritt (Abschnitt 5.1).
