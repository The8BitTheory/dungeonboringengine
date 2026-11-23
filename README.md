# dungeonboringengine

Eine Dungeon-Crawler-Engine für den C128 (VDC, 64 KB VRAM), die auf [VDC-BASIC](https://github.com/The8BitTheory/vdc-basic) v2g aufbaut. Das Spiel bleibt ein BASIC-7-Programm (interpretiert oder mit Blitz! kompiliert); die Engine-Lib erledigt Sichtberechnung und Renderliste und gibt VDC-Befehlslisten für `VCL` aus.

- Entwurf und Entscheidungen: [docs/engine-design.md](docs/engine-design.md)
- Aufruf, Parameterblock, Datenformate: [docs/formats.md](docs/formats.md)

## Stand

Schritt 1: Gerüst (Stub in Bank 0, Lib in Bank 1, Interruptweiche), `INFO`, `MAPINIT`, `SETPOS`, `WALLSET`, `VIEW` (nur Wände). Getestet mit Crawl 128 aus [dungeoncrawlerjam2025](https://github.com/The8BitTheory/dungeoncrawlerjam2025).

## Bauen

Voraussetzungen: cc65 (`ca65`, `ld65`, `cl65`, `sim65`), Python 3. Zum Testen außerdem VICE (`x128`, `c1541`, `petcat`) und Pillow.

```
engine/build.sh                                   # build/dbe.stub, build/dbe.lib
python3 tools/wallconv.py WALLS.VDC build/walls.wsm   # Wandsatz aus Crawl 128
```

## Testen

| Werkzeug | Zweck |
|---|---|
| `test/sim/run_viewsim.py CRAWL128.CD1 build/walls.wsm` | `VIEW` in sim65 für alle Zellen und Richtungen: Zyklen, Einträge, Listenlänge |
| `test/vice_run.py` | Crawl in VICE spielen, Screenshot nach jeder Taste (für den Bildvergleich mit dem Original) |
| `test/vice_timing.py` | Zyklen je Schritt und Summe der Renderphase in VICE messen |
| `test/patch_crawl.py crawl.prg out.prg` | `crawl.prg` (v2g) auf die Lib umstellen; `--timing` bzw. `--ref-timing` bauen eine Zeitmessung der Renderphase ein |

Für den Test in VICE kommen `out.prg` (als `crawl128`), `dbe.stub`, `dbe.lib` und `walls.wsm` auf eine Kopie der Crawl-Diskette.

Zeile 5 von `crawl.bas` wartet auf eine Taste (Hilfe für den Autostart aus der IDE ohne gemountete Diskette). Die VICE-Treiber drücken dort die Leertaste.
