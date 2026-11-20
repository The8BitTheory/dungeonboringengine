# Dungeon-Crawler-Engine für den C128 – Entwurf

Stand: 2026-11-20, Entwurf zur Abstimmung. Ausgangspunkt ist `game/crawl.bas` (Crawl 128) mit VDC-BASIC v2g.

## 1. Ziele und Randbedingungen

- **Allgemein:** beliebige Wandsätze, einstellbare Sichttiefe und -breite, mehrere Karten, mehrere Sprite-Sätze (Gegner, Gegenstände).
- **Blitz!-kompatibel:** Das Spiel bleibt ein BASIC-7-Programm, das interpretiert läuft und mit Blitz! 128 kompiliert werden kann. Alle Aufrufe über `SYS`/`RREG`, `POKE`/`PEEK` und VDC-BASIC-Befehle (hinter `::`).
- **Aufteilung:** BASIC behält Spielregeln, Ablauf, HUD-Texte, Sound und Laden der Dateien. Alles, was pro Schritt viele Feldzugriffe oder viele VDC-Befehle braucht, wandert in Assembler.
- **Zeropage:** Die Lib nutzt nur `$FA–$FF`. `$3D/$3E` (Blitz!) und `$05–$08` (SYS-Register) bleiben unberührt.

## 2. Schichten

| Schicht | Inhalt | Wo |
|---|---|---|
| Spiel (BASIC) | Regeln, Menüs, HUD (`VMP`), Sound, `BLOAD` der Assets, Kampf, Highscores | `crawl.bas` |
| **DCL** – Dungeon-Crawler-Lib (neu, Assembler) | Karte, Sichtberechnung, Renderliste, Objekte/Gegner im Sichtfeld, Bewegung/Kollision, Gegner-KI, Automap | Bank 1, eigenes Repo-Verzeichnis `engine/` |
| VDC-BASIC v2g | allgemeine VDC-Operationen: `VMC`, `VMF`, `VMS`, `VMP`, `RTV`, `VCL` (Befehlslisten) | `$1300–$1BFF`, Bank 0 |

Regel für die Grenze: **Was nichts über Dungeons weiß, gehört in VDC-BASIC** (Kopieren, Füllen, transparente Sprites, Befehlslisten). **Was Karte, Blickrichtung oder Wandsätze kennt, gehört in die DCL.**

Die DCL zeichnet im ersten Ausbau nicht selbst, sondern erzeugt eine VCL-Liste. BASIC führt sie mit `::VCL` aus. So bleibt aller VDC-Code an einer Stelle, und die DCL lässt sich ohne VDC testen (Liste vergleichen). Ein direkter Zeichenpfad in der DCL kann später folgen, falls VCL zu langsam ist (Abschnitt 9).

## 3. Speicheraufteilung

| Bereich | Bank | Inhalt |
|---|---|---|
| `$0B00–$0BFF` | 0 | VCL-Puffer (256 Byte = Grenze von `VCL`) |
| `$0C00–$0C3F` | 0 | DCL-Parameterblock (Abschnitt 4) |
| `$0C40–$0DFF` | 0 | Reserve (RS-232-Puffer, ungenutzt) |
| `$1300–$1BFF` | 0 | VDC-BASIC v2g |
| `$8000–$BFFF` | 1 | Karte(n), Kachel- und Objekttabellen (wie bisher `VE`, reserviert durch `POKE 58,128`) |
| `$C000–$EFFF` | 1 | DCL-Code und Tabellen (12 KB, Sprungtabelle bei `$C000`) |

Bank 1 bietet den meisten Platz und ist schon durch `POKE 58,128` vor BASIC-Variablen geschützt. `$1C00–$3FFF` scheidet aus, weil dort interpretiert das BASIC-Programm liegt.

**Zugriff auf Bank 0 aus Bank 1:** Die DCL schaltet für ihre Laufzeit den gemeinsamen RAM-Bereich auf die unteren 4 KB (`$D506`). Damit sind `$0B00` (VCL-Puffer) und `$0C00` (Parameterblock) aus Bank 1 heraus sichtbar und liegen physisch in Bank 0, wo `VCL` sie erwartet. Beim Rücksprung stellt die DCL `$D506` und `$FF00` wieder her.

**Offener Punkt (in VICE prüfen):** Läuft die DCL mit `$FF00 = $7E` (RAM 1 + I/O, kein ROM), holt ein IRQ seinen Vektor aus RAM 1 bei `$FFFE`. Entweder liegt dort schon die Kernal-Weiche, oder die DCL arbeitet mit `SEI`. Die Sichtberechnung dauert nur wenige Millisekunden, `SEI` wäre also vertretbar.

## 4. Aufrufschnittstelle

```
BANK 1:SYS 49152,F,X,Y     : REM F = Funktionsnummer, X/Y = kleine Parameter
RREG A,X,Y,S               : REM Ergebnis (Status, Werte)
```

- Bei `$C000` liegt ein `JMP` auf den Dispatcher, der über den A-Wert verzweigt. So bleiben Einsprungadressen bei neuen Versionen gleich.
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

- Ein Byte pro Zelle, zeilenweise, Breite × Höhe ≤ 16 KB (Bank 1 `$8000–$BFFF`).
- Der Zellwert ist ein **Kachelindex (0–63)** in eine Kacheltabelle, die oberen zwei Bits bleiben für Laufzeitmarken frei (z. B. „besucht“ für die Automap).
- Kacheltabelle (4 Byte je Kachel): Flags (bit 0 versperrt Weg, bit 1 versperrt Sicht, bit 2 Ereignis), Wandstil (Index in den Wandsatz), Automap-Farbe, Ereignisnummer (für BASIC: Münze, Teleporter, Ausgang …).
- Heutige Werte (1 Wand, 2 Münze, 6 Start, 8 Teleporter, 42 Ausgang) werden zu Einträgen dieser Tabelle. Startpunkte, Teleporter und Gegner stehen wie bisher in der Objektliste der Datei `CRAWL128.CD1`.
- Mehrere Karten: Eine Kartendatei enthält Header (Breite, Höhe, Kacheltabelle, Objektliste, Name). `MAPINIT` lädt immer genau eine aktive Karte.

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
| V1 | VCL-Typ für `VMS` (transparente Sprites) | Gegner und Gegenstände in derselben Liste wie Wände |
| V2 | VCL mit 16-Bit-Offset oder Verkettung (Typ „weiter bei Adresse“) | mehr als 23 Einträge bei größerer Sichttiefe |
| V3 | Tokendatei, Doku zu `VCL`/`VMS`/`VMB` | Typen 8–12 im Kommentar sind nicht implementiert; Doku sollte den echten Stand zeigen |

Alles andere aus `crawl.bas` (HUD-Texte, Rahmen, Titelbild, Automap-Ausschnitt, Kampfeffekte) lässt sich mit den vorhandenen Befehlen abbilden und bleibt in BASIC.

## 8. Umsetzung in Schritten

| Schritt | Inhalt | Prüfung |
|---|---|---|
| 1 | DCL-Gerüst: Sprungtabelle, Bank-/`$D506`-Umschaltung, `INFO`, Parameterblock; Build mit ca65 | VICE: `SYS` aus BASIC interpretiert, IRQ-Frage aus Abschnitt 3 klären |
| 2 | `MAPINIT`, `SETPOS`, `CELL`, `MOVE` | Bewegung in `crawl.bas` umgestellt, Spieltest wie bisher (W/E/M) |
| 3 | Wandsatz-Konverter (Python) und `WALLSET`; `VIEW` nur Wände | VCL-Liste gegen die heutige `RQ%`-Reihenfolge vergleichen; Bildvergleich per Screenshot; Zeit pro Schritt messen (`TI`) |
| 4 | V1 in VDC-BASIC, `SPRITESET`, Objekte in `VIEW` | Geister und Münzen wie im Original |
| 5 | `ENEMYSTEP`, Automap über `SETCELL` | Spielverhalten gleich, Geschwindigkeit messen |
| 6 | Verallgemeinern: D = 4, zweiter Wandsatz, zweite Karte, V2 | Demo-Karte mit größerer Sicht |
| 7 | Blitz!-Kompilat | auf echter Hardware oder in VICE testen |

Ab Schritt 2 gibt es nach jedem Schritt eine lauffähige Fassung des Spiels.

## 9. Offene Entscheidungen

1. **Zeichnen:** VCL-Liste (Vorschlag für den Anfang) oder eigene VDC-Kopierroutine in der DCL. Diese spart den Umweg über BASIC und die 256-Byte-Grenze, verdoppelt aber VDC-Code.
2. **Ort der DCL:** Bank 1 `$C000` (Vorschlag) oder Bank 0. Bank 0 hätte nur gut 1 KB frei (`$0B00–$0FFF`).
3. **Kartenformat:** Kachelindex mit Tabelle (Vorschlag) oder feste Bitfelder im Zellbyte.
4. **Repo:** DCL in `dungeoncrawlerjam2025/engine/` oder eigenes Repo (empfohlen, sobald ein zweites Spiel sie nutzt).
