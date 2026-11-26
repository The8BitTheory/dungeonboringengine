# Demo der Dungeon Boring Engine 0.2

Ein eigenes BASIC-Programm (`demo.bas`, interpretiert oder als Blitz!-Kompilat) zeigt die Engine mit der
Westwood-Geometrie 140 × 96. Es ist kein zweites Crawl-Level: Fenster, Himmel und Abgrund brauchen Ebenen-Geometrie mit
Boden und Decke, die Crawl nicht hat (`docs/specs/P7-crawl.md` 8.1).

Tasten: **W** vor, **S** zurück, **A**/**D** seitwärts, **Q**/**E** drehen, **X** Ende. Unter dem Fenster zeigt ein
Kompass (4 Rechtecke, Zeilen 96–99) die Blickrichtung. Drei Goblins gehen feste Routen, je gültiger Taste ein Schritt.

## Was die Demo zeigt

| Element | Umsetzung |
|---|---|
| Westwood-Geometrie 140 × 96 | `view.toml` (Preset `westwood`, `origin = 5`, stride 80, pixelgenau) |
| 4 Wandstile | `ziegel`, `gitter`, `fenster`, `bogen` (`walls.toml`, Quellen `art/*_atlas.png`, `art/fenster.*` aus `docs/specs/examples/tex`; Muster perspektivisch von `tools/dbepersp.py` abgeleitet) |
| Boden und Decke | je ein Stil (`stein`, `holz`) |
| Himmel | Deckenstil 0 (Hof): die Tapete zeigt sich in der Deckenlücke |
| Abgrund | Bodenstil 0 mit Flag WEG (Kammer): Lücke im Boden, darunter Tapete mit `below = 0` |
| Fenster mit Landschaft | Wandstil `fenster` (nicht DECKEND) in der Außenwand, dahinter die Außenkachel `draussen` (nur Tapete) |
| Tapete „Landschaft“ | `mkbg.py`: Bäume und Wasser aus `art/tree*.bmp`, `art/water*.bmp`, Himmel = `above`; 280 × 36 Pixel, zyklisch, je Blickrichtung ein Viertel versetzt |
| Goblins | `goblin.toml`: 4 Phasen (Bilder 0, 2, 4, 6 von `goblin1.bmp`, 2fach vergrößert), Tiefen 2 und 3 per `derive = "nearest"`; 3 Goblins mit Routen in `demo.bas` |
| Gitter mit INHALT | Wandstil `gitter`, Flags WEG und INHALT, dahinter in der Zelle ein Edelstein |
| Tür mit INHALT | Wandstil `bogen`, Flag INHALT ohne WEG: durchgehbar, ein Goblin geht hindurch |
| Edelsteine | `gem.toml` (Beispiel `docs/specs/examples/spr/gem.png`), 4 Stück, `ITEMPH` lässt sie glitzern |
| Karte | `demo.toml`, 20 × 16, Start im Zimmer im Südwesten (Fenster nach Westen und Süden) |

Sichtlinien über 3 Zellen hinaus zeigen die Tapete (das Fenster reicht nur bis zur Tiefe 3): Der Hof ist darum
draußen gedacht, lange Gänge öffnen den Blick auf die Landschaft.

## Dateien

| Datei | Zweck |
|---|---|
| `build.py` | baut alles nach `build/demo/` (Dateien in `files/`, Disk `dbe-demo.d81` und `.d64`, Bericht `report.md`, Belegung `layout.json`); `--budget` prüft alle Ansichten mit Goblins (A = 0), `--blitz` baut zusätzlich das Kompilat |
| `view.toml`, `walls.toml`, `floor.toml`, `ceil.toml`, `bg.toml`, `goblin.toml`, `gem.toml`, `demo.toml` | Projektdateien für `dbegeom`, `dbetex`, `dbespr`, `dbemap` |
| `mkbg.py` | Panorama der Tapete |
| `demo.bas` | das Programm |
| `tour.py` | Tour für den Test (Suche in Position, Richtung und Goblin-Zuständen) |
| `art/` | Quellgrafiken (Kopien, siehe unten) |
| `media/` | Bilder der Tour: `tour_NN.png` Screenshots aus dem VICE-Lauf (`--shots`), `szenen.png` Montage aller Bilder aus dem Modell (`--png`, pixelgleich zum VICE-Lauf) |

Test: `test/vice_demo.py` (Tour mit 75 Tasten, ganzes VRAM an jedem Prompt gegen das Modell, interpretiert und
kompiliert, 1 MHz und 2 MHz); `test/vice_demo.py --check` ohne Emulator.

## Speicher

Bank 1 wie `docs/formats.md`: DMP `$4000` (Arbeitskopie `$5000`), S2 `$6000` (Goblin) und `$6500` (Edelstein), Wand-DTS
`$8000`, DVG `$E800`, Boden `$EE00`, Decke `$F600`, Tapete `$FB80`. VRAM-Pool 9600–46334 (36 735 Byte), belegt 36 291, in
der Reihenfolge Wand 23 303, Boden 3 640, Decke 3 114, Tapete 5 040, Goblin 1 069, Edelstein 125. Zahlen und Ladeadressen
stehen nach jedem Build in `build/demo/report.md`; die DATA-Zeilen 600–619 in `demo.bas` prüft `build.py` dagegen.
Die VRL-Dateien liegen beim Laden in Bank 0 ab `$9000` (über dem Programm, unter `$D000`).

Streichliste bei Überlauf des Pools (Reihenfolge): `bogen` (Tür dann mit `gitter` ohne WEG), Goblin-Phasen 4 → 2,
Panoramahöhe.

## Herkunft der Grafiken

`art/goblin1.bmp`, `art/tree1.bmp` bis `tree3.bmp`, `art/water1.bmp` bis `water4.bmp` stammen aus dem Spiel Crawl 128
(`dungeoncrawlerjam2025/art/`, gleiche Autoren, MIT-Lizenz). `art/*_atlas.png`, `art/fenster.*` und `art/gem.png` sind
Kopien der Beispiel-Assets in `docs/specs/examples/` (erzeugt von `tools/dbetexdemo.py` und `tools/dbesprdemo.py`).
