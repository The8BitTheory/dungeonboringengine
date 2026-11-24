# dungeonboringengine

Eine Dungeon-Crawler-Engine für den C128 (VDC, 64 KB VRAM), die auf [VDC-BASIC](https://github.com/The8BitTheory/vdc-basic) v2g aufbaut. Das Spiel bleibt ein BASIC-7-Programm (interpretiert oder mit Blitz! kompiliert); die Engine-Lib erledigt Sichtberechnung und Renderliste und gibt VDC-Befehlslisten für `VCL` aus.

- Entwurf und Entscheidungen: [docs/engine-design.md](docs/engine-design.md)
- Aufruf, Parameterblock, Datenformate: [docs/formats.md](docs/formats.md)

## Stand

Schritt 1b: Gerüst (Stub in Bank 0, Lib in Bank 1, Interruptweiche), `INIT`, `MAPINIT`, `SETPOS`, `SETCELL`, `WALLSET`, `SPRITESET`, `ITEMSET`, `VIEW` mit Wänden, Objekten (transparent per `VMS`) und Gegenständen. Braucht VDC-BASIC v2g mit VCL-Typ 12 und VMS-Listen mit 2 Byte Befehlszahl (Branch `v2g`, ab `ec049bd`). Getestet mit Crawl 128 aus [dungeoncrawlerjam2025](https://github.com/The8BitTheory/dungeoncrawlerjam2025).

## Test-Diskette

`crawl128-dbe.d81`: Crawl 128 (Stand v2g, dungeoncrawlerjam2025 `af97452`) auf die Lib umgestellt, mit `vdcbasic2g.1300` aus vdc-basic `18dcab4` (VCL-Typ 12, VMS-Listen mit 2 Byte Befehlszahl). Start mit `RUN"CRAWL128"` bzw. Autostart in VICE (`x128 -80col -VDC64KB -drive8type 1581`).

## Bauen

Voraussetzungen: cc65 (`ca65`, `ld65`, `cl65`, `sim65`), Python 3. Zum Testen außerdem VICE (`x128`, `c1541`, `petcat`) und Pillow.

```
engine/build.sh                                   # build/dbe.stub, build/dbe.lib
python3 tools/wallconv.py WALLS.VDC build/walls.wsm   # Wandsatz aus Crawl 128
python3 tools/crawlsprites.py RED.VDC RED1.VDC build  # Geister und Edelstein aus Crawl 128
```

## Testen

| Werkzeug | Zweck |
|---|---|
| `test/sim/run_viewsim.py CRAWL128.CD1 build/walls.wsm` | `VIEW` in sim65 für alle Zellen und Richtungen: Zyklen, Einträge, Listenlänge |
| `test/vice_drive.py` | Crawl in VICE spielen, ereignisgesteuert (Haltepunkte, keine Wartezeiten): Screenshot und Zyklen je Taste, gestellte Szenen (`--scenes`), Summe der Renderphase (`--timing`) |
| `test/patch_crawl.py crawl.prg out.prg` | `crawl.prg` (v2g) auf die Lib umstellen; `--timing`/`--ref-timing` bauen eine Zeitmessung ein, `--hook`/`--ref-hook` die Szenen-Testhilfe |

Für den Test in VICE kommen `out.prg` (als `crawl128`), `vdcbasic2g.1300` (mit VCL-Typ 12), `dbe.stub`, `dbe.lib`, `walls.wsm`, `ghost.spr`, `gem.spr` und `ghosts.vdc` auf eine Kopie der Crawl-Diskette.

Zeile 5 von `crawl.bas` wartet auf eine Taste (Hilfe für den Autostart aus der IDE ohne gemountete Diskette). Der VICE-Treiber drückt dort die Leertaste.
