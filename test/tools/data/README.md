# Testdaten für die Werkzeuge

- `crawl128.cd1` (244 Byte): Karte von Crawl 128, ausgelesen aus `game/crawl.d81` des Repos
  dungeoncrawlerjam2025 (`c1541 -attach game/crawl.d81 -read crawl128.cd1 crawl128.cd1`).
  Erzeugt von `game/mapgen.bas`. Das Repo dungeoncrawlerjam2025 steht unter der MIT-Lizenz.

- `walls.vdc`, `font3o.vdc` (1.0f, Bilder der Wände und Zeichensatz von Crawl 128), `walls.wsm`, `ghost.spr`,
  `ghosts.vdc`, `gem.spr` (0.1-Metadaten und Geisterbilder, = `art/dbe/` des Repos dungeoncrawlerjam2025, byte-identisch
  zur Ausgabe von `tools/wallconv.py` und `tools/crawlsprites.py`): Eingaben für `tools/crawlconv.py` und das
  0.1-Modell `tools/crawl01.py` (P7a). `walls.vdc` und `font3o.vdc` sind aus `crawl128-100f.d81` gelesen
  (`c1541 -attach crawl128-100f.d81 -read walls.vdc walls.vdc`). Quelle der Grafiken: Crawl 128 (MIT).
