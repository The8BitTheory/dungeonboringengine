# dungeonboringengine

Version 0.2 (Dateien `dbe0.2.stub` und `dbe0.2.lib`, Versionsnummer in `VERSION`).

Eine Dungeon-Crawler-Engine für den C128 (VDC, 64 KB VRAM), die auf [VDC-BASIC](https://github.com/The8BitTheory/vdc-basic) v3 aufbaut. Das Spiel bleibt ein BASIC-7-Programm (interpretiert oder mit Blitz! kompiliert); die Engine-Lib erledigt Sichtberechnung und Renderliste und gibt VDC-Befehlslisten für `VCL` aus.

- Plan und Entscheidungen 0.2: [docs/plan-0.2.md](docs/plan-0.2.md)
- Detailspezifikation der Engine (Speicherkarte, Funktionen, `VIEW`, Tests): [docs/specs/P6-engine.md](docs/specs/P6-engine.md)
- Aufruf, Parameterblock, Datenformate, Speicherkarte: [docs/formats.md](docs/formats.md)
- Entwurf 0.1 (Hintergrund): [docs/engine-design.md](docs/engine-design.md)

## Stand (0.2)

Teilschritte P6a–P6i abgeschlossen (Ergebnisse in `docs/specs/P6-engine.md`): Gerüst (Stub in Bank 0 mit 8 KB gemeinsamem RAM, Lib in Bank 1 ab `$B000`, Interruptweiche), Karte (`MAPINIT`, `SETPOS`, `SETCELL`, `MOVE`, Automap), Assets (`GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET`, `ITEMSET`), `VIEW` mit Wänden, Kacheln, Boden, Decke, Tapete und Objekten in der richtigen Tiefe (VCL-Typ 9: VMS-Listen direkt aus Bank 1). 42 VICE-Szenen sind pixelgleich (interpretiert und als Blitz!-Kompilat mit Runtime-Image 2). Braucht VDC-BASIC v3 (Branch `v3`).

Werkzeuge (Python 3 mit Pillow): `tools/vrl.py` (RLE für `RXV`), `dbegeom.py` (Sichtfenster, DVG; `view.toml`, Schalter `byte_edges` für Kanten auf ganze Bytes), `dbetex.py` (Wand-, Boden-, Decken-DTS, Tapete DBG), `dbespr.py` (Sprite-Sätze S2), `dbemap.py` und `crawlmap.py` (Karte DMP), `dbeview.py` (Referenz von `VIEW`), `dbemove.py`, `dbemem.py` (Speicherkarte). Für Crawl 128: `crawlconv.py` (wandelt die 1.0f-Daten von `crawl128-100f.d81` in DVG, DTS, S2, DMP und VRL von 0.2 um), `crawl01.py` (Referenz: das Bild von Crawl 1.0f aus dem 0.1-Modell, für den Pixelvergleich). Das Beispielprojekt steht in `docs/specs/examples/`.

**P7 abgeschlossen** (Spec und Ergebnisse: [docs/specs/P7-crawl.md](docs/specs/P7-crawl.md)): Crawl 128 Version 1.1 (Spiel-Repo `dungeoncrawlerjam2025`, Branch `dbe-0.2`) läuft auf Engine 0.2 und VDC-BASIC v3 mit **pixelgleichen** Bildern zu 1.0f (offline 19 136 Ansichten, im Emulator 74 Prompts interpretiert und kompiliert). Dazu die [Demo](demo/README.md) mit Westwood-Geometrie, Fenstern, Himmel, Abgrund und animierten Goblins. P6i: Sprites werden nicht gegen Wände beschnitten, die Verdeckung ergibt sich aus der Malreihenfolge.

Die Fassung 0.1 (Crawl 128 mit `WALLSET`, `SPRITESET` v1) liegt nur noch als Test-Diskette `crawl128-dbe.d81` vor.

**Demo:** `python3 demo/build.py` baut `build/demo/` mit Disk `dbe-demo.d81` und `.d64`; Beschreibung, Tasten und Speicher in [demo/README.md](demo/README.md), Test `test/vice_demo.py`.

## Speicherkarte Bank 1 (`MEMSIZ $4000`)

Das Spiel beginnt mit `POKE 57,0:POKE 58,64:CLR` (Variablen `$0400–$3FFF`). Daten der Engine liegen nur in `$4000–$AFFF` und `$E800–$FBFF`:

| Bereich | Inhalt |
|---|---|
| `$4000–$5FFF` | DMP (Karte) |
| `$6000–$7FFF` | S2 (Sprite-Sätze) |
| `$8000–$AFFF` | DTS Wand |
| `$B000–$E7FF` | Lib, Tabellen, Variablen (nicht belegen) |
| `$E800` / `$EE00` / `$F600` / `$FB80` | DVG / DTS Boden / DTS Decke / DBG (zusammen bis `$FBFF`) |
| `$FC00–$FEFF` | gesperrt (Blitz!-Runtime) |

Die Werkzeuge nehmen diese Ladeadressen als Standard und brechen mit einer Fehlermeldung ab, wenn eine Datei über ihren Bereich reicht.

## Bauen

Voraussetzungen: cc65 (`ca65`, `ld65`, `cl65`, `sim65`), Python 3, Pillow. Zum Testen außerdem VICE 3.10 (`x128`, `c1541`), ACME und, für den Blitz!-Lauf, `node` mit dem Blitz!-Compiler; VDC-BASIC v3 unter `~/git/vdc-basic` (`VDCBASIC_DIR`).

```
engine/build.sh     # build/dbe0.2.stub, build/dbe0.2.lib (Version aus `VERSION`), dbe0.2-test.lib (mit Testfunktionen)
python3 tools/dbegeom.py docs/specs/examples/view-west140.toml          # Geometrie: DVG, Vorlagen, Budget
python3 tools/dbetex.py build walls.toml                                # Textur-DTS und VRL (siehe docs/specs/P5-textures.md)
python3 tools/dbemap.py build docs/specs/examples/demo.toml demo.dmp    # Karte
```

Die Lib belegt 10 982 von 11 264 Byte (`$B000–$DBFF`); die Reserve von 282 Byte nicht aufbrauchen.

## Testen

| Test | Zweck |
|---|---|
| `python3 -m unittest discover -s test/tools` | Werkzeuge und Referenz (`dbeview`, `dbemove`, `dbemem` …), ohne Emulator |
| `test/sim/run_sim.py` (`DBEVIEW_FULL=1` für den vollen Zufallssatz) | Lib in sim65: alle Funktionen, `VIEW` und `MOVE` bytegleich mit den Referenzen; Zyklen |
| `test/vice_smoke.py` | Stub, Lib, Interrupts, Bank 0 `$1C00–$3FFF` unverändert, `RXV` (interpretiert und Blitz!) |
| `test/vice_zp.py` | Zeropage-Block `$63–$72` unter Interrupts, danach rechnet BASIC richtig |
| `test/vice_view.py` | 42 Szenen im echten x128, ganzes VRAM pixelgleich; Zyklen bei 1 MHz und 2 MHz (`--no-fast`, `--byte-edges`, `--check`, `--control`) |
| `test/vice_vclprof.py` | Zerlegung der VCL-Zeit (`--static` ohne VICE) |
| `test/vice_blitzvars.py` | Wo legt ein Blitz!-Programm Variablen ab; wirkt `MEMSIZ $4000` |
| `test/tools/test_crawlconv.py`, `test_crawl01.py` | Konverter und Offline-Vollvergleich: 19 136 Ansichten von Crawl 1.0f bytegleich (in `unittest discover`) |
| `test/sim/run_crawl.py` | dieselben Ansichten mit der Lib in sim65 gegen `dbeview.view` |
| `test/vice_demo.py` | Demo-Tour (75 Tasten) im echten x128, ganzes VRAM an jedem Prompt gegen das Modell; `--check` ohne Emulator |
| Spiel-Repo `test/vice_crawl.py` | Crawl 1.1 (interpretiert, kompiliert) gegen 1.0f an jedem Prompt (VRAM und Register); auch die Zeitmessung (`--timing`) |

VICE-Tests laufen ereignisgesteuert (Haltepunkte, Debug-Cartridge, keine festen Wartezeiten); der Port kommt aus `--port` oder `DBE_VICE_PORT` (Bereich 6631–6649).

## Laden im Spiel

```
10 POKE 57,0:POKE 58,64:CLR
20 BANK 0:BLOAD"DBE0.2.STUB",B0,U8:BLOAD"DBE0.2.LIB",B1,U8
30 SYS 3328:RREG A,X,Y
40 BLOAD"MAP.DMP",B1,U8:BLOAD"WALLS.DTS",B1,U8:BLOAD"VIEW.DVG",B1,U8:REM Ladeadressen stehen in den PRG-Köpfen
```

Texturen, Tapete und Sprites kommen als VRL-Dateien (`BLOAD` nach Bank 0, `RXV` ins VRAM); danach `POOLSET`, `GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET`, `MAPINIT`, `BUFSET` (Reihenfolge und Parameter: `docs/specs/P6-engine.md` Abschnitt 3; Beispiel `test/vice/view.bas`). Aufruf einer Funktion: `SYS 3331,F,X,Y` mit dem Parameterblock bei `$0C00`.
