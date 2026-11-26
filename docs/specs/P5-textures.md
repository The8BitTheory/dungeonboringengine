# P5: Texturen – `tools/dbetex.py`, DTS, DBG, VRL-Daten, Budget

Stand: 2026-11-25. Detailspezifikation zu Schritt P5 aus `docs/plan-0.2.md` (Abschnitte 5, 6). Umsetzung: Sonnet. Review: Opus. Abhängigkeiten: Python ≥ 3.11 (`tomllib`), Pillow, `tools/vrl.py` (P1), `tools/dbegeom.py` (P3, nur als Modul für Hilfsfunktionen und in Tests). Aseprite ist nicht installiert und wird nicht gebraucht.

Sprite-Sätze v2 (dynamische Objekte) sind **nicht** Teil von P5, sondern ein eigener Schritt **P5b**; Abschnitt 11 skizziert nur die Schnittstelle.

## 1. Überblick

`dbetex.py` liest gemalte Texturen (PNG-Atlas nach der dbegeom-Vorlage oder Aseprite-Export) und die Geometrie (`<geom>.geom.json` aus P3) und schreibt:

| Ausgabe | Bank / Ziel | Inhalt |
|---|---|---|
| `<name>.dts` | Bank 1 (Engine, `TEXSET`, P6) | Texturset: Stile, Bildverzeichnis, Kerne, VMS-Listen, Zeilenfüllungen |
| `<name>.vrl` | Bank 0 (Ladepuffer des Spiels), dann `RXV` an die VRAM-Basis | alle Bilddaten des Sets (Kerne und gepackte Randbytes), VRL v1 mit Dateirahmen (P1, 3) |
| `<name>.dbg` + `<name>.vrl` | wie oben | Tapete (Abschnitt 6) |
| `<name>.tex.json`, `<name>.tex.md` | Werkzeuge, Mensch | Bericht: Verzeichnis, Größen, Warnungen, Budget (Abschnitt 8) |
| `<name>_<stil>_preview.png` | Mensch | Probebild je Stil mit dem Referenz-Renderer (7.3) |

**Warum zwei Dateien:** `RXV` liest den VRL-Strom aus Bank 0 (Plan 7.2), die Engine liest ihre Metadaten aus Bank 1 (wie DVG und DMP). Die VMS-Listen stehen in der DTS und werden von `VIEW` ohnehin in den Puffer bei `$1300` kopiert (gemeinsames RAM, für `VMS` in Bank 0 sichtbar). Der VRL-Strom wird nach dem Entpacken nicht mehr gebraucht; sein Ladepuffer ist danach frei.

Ein DTS enthält genau **eine Art**: Wand, Boden oder Decke. Ein Spiel lädt je Zone bis zu drei DTS (je eine VRAM-Basis im Pool) und eine DBG.

Begriffe (wie P3): Element = Eintrag der DVG-Elementtabelle; Rechteck (x, y, w, h) in Byte-Spalten und Zeilen; Pixel (px, r) im Rechteck, px = 0 … 2w − 1; Byte bx = ⌊px / 2⌋.

## 2. Pixel, Palette, Transparenz, Nibbles

### 2.1 Nibble-Packung

1 Byte = 2 chunky-Pixel. **Linkes Pixel (gerades px) = High-Nibble (Bits 7–4), rechtes Pixel = Low-Nibble (Bits 3–0)** – wie `crawlsprites.py` (`>> 4` für `c % 2 == 0`), VDC-BASIC (`docs/reference/vms-format.md`) und P3 (`L` = High-Nibble).

### 2.2 Palette

Die 16 VDC-Farben sind die VICE-Palette `vdc_deft.vpl` („VDC (RGB with brown)“), identisch mit `dbegeom.PALETTE` (P3, 7.1). `dbetex` importiert die Tabelle aus `dbegeom` (keine zweite Kopie).

Zuordnung eines deckenden Pixels (R, G, B):

1. Exakt gleich einem Paletteneintrag → dieser Index.
2. Sonst nächste Farbe nach quadratischem RGB-Abstand (R² + G² + B² der Differenzen), bei Gleichstand der kleinere Index. Je Bild eine **Warnung** mit Anzahl der Pixel, größtem Abstand und erster Position (`side_d1_s-1: 37 Pixel nicht in der VDC-Palette, max. Abstand 41 bei (3, 12)`).
3. `--strict`: jede Abweichung ist ein Fehler (Exitcode 1).

Indizierte PNGs (Modus `P`) werden über ihre Palette in RGB(A) umgerechnet; der Index im PNG zählt nicht (Aseprite-Paletten können umsortiert sein). Graustufen- und RGB-PNGs werden ebenso nach RGBA gewandelt.

### 2.3 Transparenz

| Pixel | Bedeutung |
|---|---|
| Alpha = 0 | transparent |
| Alpha = 255 | deckend, Farbe nach 2.2 |
| 0 < Alpha < 255 | **Fehler** (Anzahl, erste Position), mit Hinweis: „Halbtransparenz – Masken-Ebene der Vorlage mitexportiert? Aseprite: `--layer Bild`“. Mit `--alpha-threshold N` stattdessen: Alpha < N transparent, sonst deckend. |
| RGB = `key` (Option `key = "FF00FF"` bzw. `--key`) | transparent (für PNGs ohne Alpha-Kanal) |

Zusätzlich gilt die **Maske des Elements** (P3, 4.4, `mask` in der JSON): Pixel außerhalb sind immer transparent. Deckende Pixel außerhalb der Maske werden verworfen, mit Warnung (Anzahl je Bild): „übermalt, abgeschnitten“. Transparente Pixel innerhalb der Maske sind gewollte Transparenz (Fenster, Gitter, Bögen).

### 2.4 Byte-Zustand je Bild

Je Byte des Rechtecks aus den beiden Pixeln (nach 2.3):

| Zustand | Pixel | Zeichnen |
|---|---|---|
| voll | beide deckend | Kern (`VMC`) oder VMS Typ 1 |
| halb-L | nur links deckend | VMS Typ 8, Low-Nibble = Alpha der Liste |
| halb-R | nur rechts deckend | VMS Typ 8, Low-Nibble ≠ Alpha der Liste |
| leer | beide transparent | nichts (keine Daten) |

**Alpha je VMS-Liste:** `VMS` Typ 8 vergleicht nur das **rechte** Nibble mit dem Alpha-Wert (`vms-format.md`): gleich → links aus dem Bild, rechts vom Schirm; sonst → rechts aus dem Bild, links vom Schirm. Daraus:

- C = Menge der Farben rechter Pixel in halb-R-Bytes des Bildes.
- Alpha = kleinster Index in {0 … 15} \ C (meist 0).
- halb-L-Byte: `(links << 4) | alpha`. halb-R-Byte: `(0 << 4) | rechts` (High-Nibble wird nicht gelesen; 0 fest, damit die Ausgabe eindeutig ist).
- C = alle 16 Farben (praktisch nie): Alpha = Farbe mit den wenigsten halb-R-Bytes (Gleichstand: kleinerer Index); diese halb-R-Bytes werden voll (linkes Pixel = Farbe des rechten), Warnung mit Anzahl.

## 3. Eingaben

### 3.1 Projektdatei `tex.toml`

```toml
format  = "dbetex"
version = 1

[texset]
name       = "zone1_walls"
kind       = "wall"                        # wall | floor | ceiling
geom       = "../geom/west140.geom.json"   # Pflicht (P3)
dvg        = "../geom/west140.dvg"         # optional: Geometrie-ID gegenprüfen
out        = "build/tex"                   # relativ zur tex.toml
load       = 0xA000                        # Ladeadresse der DTS (Bank 1), siehe review-notes F.6
vrl_load   = 0x4000                        # Ladeadresse im Dateirahmen der VRL (nur Vorgabe; BLOAD ...,P() überschreibt)
pool_bytes = 26624                         # optional, für die Warnung in 8.2
max_kerns  = 4                             # 0 … 4 (5.4)
kern_min   = 16                            # Mindestfläche weiterer Kerne in Byte
fill_rows  = true                          # Bänder mit einheitlichen Zeilen als Zeilenfüllung (5.6)
key        = "FF00FF"                      # optional
alpha_threshold = 0                        # 0 = aus (2.3)

[[style]]                                  # Reihenfolge = Stil 0, 1, … (DMP-Stilnummer = Index + 1)
name = "ziegel"
png  = "ziegel_atlas.png"                  # Atlas nach der dbegeom-Vorlage (3.2)

[[style]]
name     = "gitter"
aseprite = "gitter.json"                   # Aseprite-Export (3.3)
tag      = "gitter"                        # oder frame = 0
empty    = ["side_d3_s-3", "side_d3_s+3"]  # ausdrücklich ohne Bild ($FE, 4.4)
```

Regeln: unbekannte Schlüssel sind Fehler; je Stil genau eine Quelle (`png` oder `aseprite`); 1 … 32 Stile; Namen eindeutig. CLI-Optionen überschreiben die gleichnamigen Werte aus `[texset]`.

### 3.2 PNG-Atlas

Ein PNG je Stil, Layout exakt wie `<geom>_atlas.png` (P3, 7.2): das Bild für `name` liegt bei `atlas` (x, y in Pixeln) aus der `geom.json` (`elements[]` und `band_images[]`), Größe 2w × h. Das PNG muss mindestens `atlas_size` groß sein (sonst Fehler), größer ist erlaubt.

Welche Bilder gelten (je nach `kind`):

| kind | Bilder (Slice-Namen) |
|---|---|
| wall | `front_d<d>_s+0` (Vollfronten), `side_d<d>_s<±s>` |
| floor | `floorband_d<d>`, `floor_d<d>_s<±s>` |
| ceiling | `ceilband_d<d>`, `ceil_d<d>_s<±s>` |

Ein Bild gilt als **nicht vorhanden**, wenn es nach 2.3 ganz transparent ist **oder** genau der unbemalten Vorlage entspricht (Maske `AAAAAA`, Kern `555555`, wie `_atlas.png`) – Meldung „nicht bemalt“ (Info, keine Warnung).

### 3.3 Aseprite-Export (JSON + Sprite-Sheet)

Kein Parser für `.aseprite`-Binärdateien: Wer malt, hat Aseprite und damit die CLI; der JSON-Export ist dokumentiert, textbasiert und deckt Frames, Tags und Slices ab. Erwarteter Aufruf (steht auch im Docstring und im Bericht):

```
aseprite -b zone1.aseprite --layer Bild --sheet zone1.png --data zone1.json \
         --format json-array --list-slices --list-tags
```

Gelesen wird:

- `meta.image` (Sheet-PNG, relativ zur JSON), `meta.size`.
- `frames`: Liste (`json-array`) oder Objekt (`json-hash`, Reihenfolge der Schlüssel = Framenummer). Je Frame `frame` {x, y, w, h}. `rotated` = true oder `trimmed` = true → Fehler („ohne `--trim`/`--sheet-pack`-Rotation exportieren“).
- `meta.frameTags` (optional): Stil über `tag = "<name>"` → erster Frame des Tags; sonst `frame = n` (Standard 0). Tag über mehrere Frames → Warnung, erster Frame gilt.
- `meta.slices`: je Slice `name` und `keys[]` mit `frame`, `bounds` {x, y, w, h}. Gültig ist der Key mit dem größten `frame` ≤ gewähltem Frame (Aseprite-Semantik). `bounds` sind Koordinaten **im Sprite** (nicht im Sheet): Pixel im Sheet = `frame.x + bounds.x`, `frame.y + bounds.y`.
- Slice-Größe muss 2w × h des Elements sein (Fehler sonst, mit Soll und Ist); die Lage ist frei (Slices dürfen verschoben werden). `center` (9-Patch) und `data` (User Data) werden ignoriert.
- Fehlende Slice → Bild nicht vorhanden. Slice mit unbekanntem Namen → Warnung. Gleicher Name doppelt → Fehler.

Die Aseprite-Vorlage aus P3 hat dieselben Slice-Namen; Ebene „Maske“ darf nicht mitexportiert werden (sonst Fehler nach 2.3).

### 3.4 Geometrie

Aus `geom.json` werden gelesen: `geometry_id`, `viewport` (width_px, height, stride, depth), `planes` (T, B je Ebene, für 5.5), `bands`, `band_images`, `elements` (index, name, art, d, s, rect, kernel, cover, flags, src_dx, mask, atlas), `atlas_size`. Mit `dvg` wird zusätzlich die DVG gelesen: Magic, Version, ID nachgerechnet (P3, 5.5; Bytes 10–11 `origin` und 12–13 vor der CRC 0) und gleich der JSON-ID, NE gleich (Fehler sonst).

## 4. DTS-Format (Version 1)

PRG-Datei: 2 Byte Ladeadresse (`load`, Standard `$A000`, Bank 1), dann der Inhalt. Alle Offsets relativ zum Inhalt (Byte nach der Ladeadresse), Wörter Low/High; das gilt auch für die Offsets im Bildverzeichnis (Kerne: Byte-Offset des ersten Kerns in der Kerntabelle, ZEILEN-Füllbytes, VMS-Listen). **VRAM-Offsets** sind relativ zur VRAM-Basis, die das Spiel bei `TEXSET` angibt (dorthin geht auch `RXV` mit der zugehörigen VRL).

### 4.1 Kopf (32 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"D" "T"` (`$44 $54`) |
| 2 | Version = 1 |
| 3 | Art: 0 Wand, 1 Boden, 2 Decke |
| 4–5 | Geometrie-ID (aus der DVG; `TEXSET` lehnt bei Abweichung ab). `origin` gehört nicht zur ID (P3, 5.5): DTS und DBG gelten für jede Lage des Fensters im Puffer |
| 6 | NE: Anzahl DVG-Elemente (Kontrolle) |
| 7 | D (Kontrolle) |
| 8 | NS: Anzahl Slots |
| 9 | NST: Anzahl Stile (1 … 32) |
| 10 | NI: Anzahl Bildeinträge (≤ 254) |
| 11 | NK: Anzahl Kerneinträge |
| 12–13 | Offset Slotkarte |
| 14–15 | Offset Stiltabelle |
| 16–17 | Offset Bildverzeichnis |
| 18–19 | Offset Kerntabelle |
| 20–21 | Offset Datenbereich (VMS-Listen, Zeilenfüllungen) |
| 22–23 | Gesamtlänge des Inhalts |
| 24–25 | VRAM-Länge U (= entpackte Länge der VRL) |
| 26–27 | CRC der VRAM-Daten: `binascii.crc_hqx(daten, 0xFFFF)` (Kontrolle für Werkzeuge und Tests) |
| 28–29 | stride (Kontrolle; steckt auch in der Geometrie-ID) |
| 30–31 | reserviert 0 |

Reihenfolge der Bereiche: Kopf, Slotkarte, Stiltabelle, Bildverzeichnis, Kerntabelle, Datenbereich (lückenlos).

### 4.2 Slotkarte (NE + 2·(D + 1) Byte)

Ordnet jedem Zeichenplatz einen Slot dieses Sets zu (`$FF` = gehört nicht zu dieser Art):

| Index | Zeichenplatz |
|---|---|
| 0 … NE − 1 | DVG-Element mit diesem Index |
| NE + d | Deckenband der Tiefe d |
| NE + (D + 1) + d | Bodenband der Tiefe d |

Slots werden in dieser Index-Reihenfolge vergeben: erst die Elemente der Art in DVG-Reihenfolge, dann die Bänder der Art (d = 0 … D, nur Bänder mit Höhe > 0).

| Art | Elemente mit Slot | Bänder |
|---|---|---|
| Wand | Front (auch Teilfronten), Seite | – |
| Boden | Boden | Bodenbänder |
| Decke | Decke | Deckenbänder |

Westwood 140 × 96: Wand NS = 25 (11 Fronten, 14 Seiten), Boden NS = 22 (18 + 4), Decke NS = 22.

### 4.3 Stiltabelle (NST × NS Byte)

Stil st, Slot k → Byte bei `st · NS + k`:

| Wert | Bedeutung |
|---|---|
| 0 … `$FD` | Index ins Bildverzeichnis |
| `$FE` | kein Bild: nichts zeichnen, nichts abdecken |
| `$FF` | **Rückgriff auf Stil 0** (Eintrag `0 · NS + k`); in Stil 0 selbst nicht erlaubt |

Zusammenspiel mit der DMP (review-notes D.4): DMP-Stilnummer 0 = nichts, n ≥ 1 = Stil n − 1 dieses DTS. n − 1 ≥ NST ist ein Kartenfehler (`dbetex check`, 9.5; `VIEW` behandelt ihn wie `$FE`).

Der Importer schreibt `$FF`, wenn einem Stil ≥ 1 ein Bild fehlt (3.2, 3.3), `$FE` für Bilder aus `empty` und für fehlende Bilder in Stil 0 (Warnung „Stil 0 ohne Bild für …“). Eine **Teilfront** bekommt den Wert ihres Ausschnitt-Eintrags (4.4), abgeleitet aus der Vollfront desselben Stils; fehlt die Vollfront, gilt für die Teilfront derselbe Wert (`$FF` oder `$FE`).

### 4.4 Bildverzeichnis (NI × 16 Byte)

Jeder Eintrag gehört zu genau einem Slot (ein Bild ist an Rechteck, Maske und stride seines Zeichenplatzes gebunden). Gleiche Einträge verschiedener Stile im selben Slot (gleiche Pixel nach 2.3) werden zusammengelegt: ein Eintrag, gleiche VRAM-Daten.

| Offset | Inhalt |
|---|---|
| 0 | Flags: Bit 0 DECKEND (5.5); Bit 1 AUSSCHNITT (Teilfront, 5.3); Bit 2 ZEILEN (Zeilenfüllung, 5.6); Bit 3 RAND (VMS-Liste vorhanden); Rest 0 |
| 1 | Slot |
| 2 | nk: Anzahl Kerne (0 … 4; 0 bei ZEILEN) |
| 3 | h: Zeilen des Zeichenplatzes (Kontrolle; bei ZEILEN Anzahl Füllbytes) |
| 4–5 | Offset des ersten Kerns in der Kerntabelle (nk aufeinanderfolgende Einträge); bei ZEILEN Offset der h Füllbytes im Datenbereich; sonst 0 |
| 6–7 | VRAM-Offset der gepackten Randbytes (0 ohne Rand) |
| 8–9 | Anzahl Randbytes |
| 10–11 | Offset der VMS-Liste (0 = keine) |
| 12–13 | Länge der VMS-Liste in Byte (Kopf + Befehle) |
| 14 | Quellbild: bei AUSSCHNITT Index des Vollfront-Eintrags, sonst eigener Index |
| 15 | reserviert 0 |

**Zeichnen eines Eintrags** (P6; Ziel T0 = `AP + origin + y · stride + x` des Zeichenplatzes aus der DVG bzw. Band-Zeile y0, x = 0):

1. Je Kern: `VMC VB + src, T0 + dy · stride + dx, w, h, stride[, srcstep]` – VCL-Typ 2, bei srcstep ≠ 0 Typ 3.
2. Bei RAND: `VMS VB + rand_ofs, T0, Liste` – VCL-Typ 12, Liste in den VMS-Puffer kopiert.
3. Bei ZEILEN: je Zeile i `VMF T0 + i · stride, byte_i, w` – aufeinanderfolgende gleiche Bytes zusammengefasst zu VCL-Typ 5 (reps, step = stride).

Kerne und Rand überschneiden sich nicht; die Reihenfolge ist frei.

### 4.5 Kerntabelle (NK × 8 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | VRAM-Offset des ersten Quellbytes |
| 2 | dx (Byte-Spalte relativ zum Rechteck des Zeichenplatzes) |
| 3 | dy (Zeile relativ zum Rechteck) |
| 4 | w (Byte, ≥ 1) |
| 5 | h (Zeilen, ≥ 1) |
| 6–7 | srcstep: 0 = Quelle gepackt (w Byte je Zeile, `VMC` „weiter hinter dem letzten Lauf“), sonst Abstand zweier Quellzeilen (Ausschnitt: Breite des Vollfront-Kerns) |

### 4.6 Datenbereich

VMS-Listen und Füllbytes, in Verzeichnisreihenfolge. VMS-Liste im Format von VDC-BASIC (`vms-format.md`, wie SPR v1):

| Offset | Inhalt |
|---|---|
| 0 | Alpha (0 … 15, 2.4) |
| 1–2 | Anzahl Befehle n |
| 3 … | n Befehle: Typ 1 = `01 ofs_lo ofs_hi len` (len 1 … 255), Typ 8 = `08 ofs_lo ofs_hi` |

ofs = Zeile · stride + Byte-Spalte, relativ zur linken oberen Ecke des Zeichenplatzes (stride aus der DVG). Typ 2 wird nicht erzeugt.

### 4.7 Grenzen

NI ≤ 254, NST ≤ 32, NK ≤ 255, Inhalt ≤ 65535, U ≤ 65535 (VRL). Überschreitung: Fehler mit Ursache (z. B. „zu viele Bilder: 261 > 254 – Stile auf zwei DTS verteilen“).

## 5. Umwandlung je Bild

### 5.1 Ablauf

1. Pixel aus der Quelle lesen (3.2/3.3), nach 2.2/2.3 in Index oder transparent wandeln, Elementmaske anwenden.
2. Byte-Zustände (2.4); Bild ohne deckende Pixel → nicht vorhanden.
3. Zeilenfüllung prüfen (5.6, nur Bänder).
4. Kerne wählen (5.4), Rest = Rand.
5. Alpha wählen, Randbytes packen, VMS-Liste bauen (5.2).
6. DECKEND bestimmen (5.5).
7. Für Vollfronten: Ausschnitte der Teilfronten derselben Tiefe ableiten (5.3).

### 5.2 Rand und VMS-Liste

Zeilen r = 0 … h − 1, Bytes bx = 0 … w − 1 von links nach rechts; Kernbytes und leere Bytes werden übersprungen:

- maximal lange Folge voller Bytes (nicht im Kern) → Typ 1, bei mehr als 255 Byte geteilt;
- halbes Byte → Typ 8.

Die gepackten Randbytes stehen in genau der Reihenfolge, in der die Befehle sie verbrauchen. Ohne Randbytes: keine Liste, Bit RAND = 0.

### 5.3 Teilfronten (Ausschnitt der Vollfront)

Teilfront-Element (d, s ≠ 0) mit Rechteck (x, y, w, h) und src_dx (P3, 4.4); Vollfront der Tiefe d mit Breite Wf. Je vorhandener Vollfront eines Stils und je Teilfront ihrer Tiefe entsteht ein Eintrag mit Bit AUSSCHNITT (Quellbild = Vollfront-Eintrag):

- **Kerne:** je Kern (kx, ky, kw, kh, src) der Vollfront der Schnitt mit den Spalten [src_dx, src_dx + w): a = max(kx, src_dx), b = min(kx + kw, src_dx + w); leer → entfällt; sonst dx = a − src_dx, dy = ky, w' = b − a, h = kh, src' = src + (a − kx), **srcstep = kw** (immer, auch wenn der Ausschnitt den Kern ganz enthält). Keine neuen VRAM-Daten (VCL-Typ 3, review-notes C.2).
- **Rand:** Die Randbytes der Vollfront in den sichtbaren Spalten werden **neu gepackt** (eigene VRAM-Daten, eigene VMS-Liste mit Offsets relativ zum Teilfront-Rechteck, Alpha neu nach 2.4). Grund: `VMS` liest die Quelle streng fortlaufend und kann Bytes nicht überspringen (review-notes F.2). Bei deckenden Fronten ohne Rand kostet ein Ausschnitt nur Verzeichnis- und Kerneinträge.
- DECKEND: nach 5.5 für das Teilfront-Element.

### 5.4 Kerne

Bis zu `max_kerns` Rechtecke aus vollen Bytes, gierig:

1. Kandidaten = volle Bytes, die noch in keinem Kern liegen.
2. Größtes Rechteck aus Kandidaten nach P3, 4.4 (Fläche maximal; Gleichstand: größere Breite, kleineres ky, kleineres kx). Den Algorithmus übernimmt `dbetex` aus `dbegeom` (Funktion auf Byte-Raster auslagern, falls nötig; beide nutzen dieselbe).
3. Der **erste** Kern wird genommen, wenn h ≥ 1 und Fläche ≥ 1; jeder **weitere** nur bei h ≥ 2 und Fläche ≥ `kern_min`. Sonst Ende.

Folge: Für ein vollständig bemaltes, deckendes Bild ist Kern 1 gleich dem DVG-Kern; die Summe Kern + Rand ist immer die Zahl der nicht leeren Bytes. Mehrere Kerne entlasten den VMS-Puffer (Fenster, Gitter: Rahmenbalken als Kerne statt einer langen VMS-Liste). Daten im VRAM je Bild: Kern 1, Kern 2, …, Rand.

Die Engine zeichnet mit den Kernen des DTS, nicht mit dem DVG-Kern (der dient nur Vorlage und Budget, review-notes F.4).

### 5.5 DECKEND

Nur für Elemente mit DVG-Flag „Spaltenbereich gültig“ (Front, Seite); sonst 0. Bit 0 = 1, wenn im Bild alle Bytes in den Spalten c0 … c1 − 1 (absolut, aus der DVG) und den Zeilen max(T_{d+1}, 0) … min(B_{d+1}, VH) − 1 (absolut; `planes` der JSON) **voll** sind. Das ist genau die Bedingung, unter der P3 den Spaltenbereich berechnet, angewandt auf die tatsächlichen Pixel. Für Fronten ergibt das: alle Bytes des Rechtecks voll.

`VIEW` (P6) deckt ab, wenn DVG-Flag Bit 0, Kachel-Flag DECKEND (DMP) **und** DTS-Bit DECKEND gesetzt sind (review-notes D.5). Nicht abzudecken ist immer korrekt (nur Mehrarbeit).

### 5.6 Zeilenfüllung (Bänder)

Bei `fill_rows = true`: Besteht jede Zeile eines Bandbildes aus einem einzigen, wiederholten Bytewert (einfarbig oder ein Zwei-Pixel-Muster) und ist das Band ganz voll, wird es als Eintrag mit Bit ZEILEN gespeichert: h Füllbytes im Datenbereich, **kein VRAM**. Farbverläufe (Plan 5.2, `VMF` je Zeile) entstehen so automatisch aus einem gemalten Verlauf. Sonst normales Bild (ein Kern über das ganze Band).

## 6. DBG-Format (Tapete, Version 1)

### 6.1 Projektdatei `bg.toml`

```toml
format  = "dbebg"
version = 1

[background]
name      = "himmel"
geom      = "../geom/west140.geom.json"
png       = "himmel.png"       # Panorama: Breite 2·P Pixel, Höhe h
y0        = "horizon"          # Zeile im Sichtfenster für die erste Panoramazeile; Zahl oder "horizon"
                               # ("horizon": Panorama mittig auf dem Horizontband, P3 4.5)
offsets   = "auto"             # oder [o_N, o_O, o_S, o_W] in Byte; auto: o_v = v · P / 4 (P durch 4 teilbar)
wrap      = true               # zyklisch: o_v + VW darf über P hinausgehen
above     = 2                  # Farbe (0 … 15) oder Liste je Zeile für Zeilen über dem Panorama
below     = 0                  # ebenso unter dem Panorama
out       = "build/tex"
load      = 0xA900
vrl_load  = 0x4000
```

Das Panorama darf keine transparenten Pixel haben (Fehler). Palette nach 2.2. P ≥ VW, P · h ≤ 65535, y0 + h ≤ VH (Fehler sonst; y0 < 0 → Fehler).

### 6.2 Datei

PRG-Datei, Ladeadresse `load` (Bank 1). Offsets relativ zum Inhalt.

| Offset | Inhalt |
|---|---|
| 0–1 | `"D" "B"` (`$44 $42`) |
| 2 | Version = 1 |
| 3 | VW (Kontrolle) |
| 4 | VH (Kontrolle) |
| 5–6 | Geometrie-ID |
| 7–8 | P: Panoramabreite in Byte |
| 9 | y0: Sichtfensterzeile der Panoramazeile 0 |
| 10 | h: Panoramahöhe in Zeilen |
| 11 | Flags: Bit 0 WRAP |
| 12–19 | Versatz o_v je Blickrichtung v = 0 N, 1 O, 2 S, 3 W (Wort, 0 … P − 1): Panoramaspalte am linken Fensterrand |
| 20–21 | VRAM-Länge U = P · h |
| 22–23 | CRC der VRAM-Daten (wie 4.1) |
| 24 … 24 + VH − 1 | Füllbyte je Sichtfensterzeile (Farbe · 17) für Zeilen außerhalb [y0, y0 + h); innerhalb 0 |

VRAM-Daten (eigene VRL, ein `RXV` an die Basis): das Panorama zeilenweise, P Byte je Zeile.

**Zeichnen** einer Zeilenspanne [r0, r1) (P6, Plan 5.1): innerhalb des Panoramas `VMC VB + (r0 − y0) · P + o_v, T0, n, r1 − r0, stride, P` mit n = VW; ist WRAP gesetzt und o_v + VW > P, zwei Teile (n1 = P − o_v ab o_v, n2 = VW − n1 ab Spalte 0, Ziel + n1). Außerhalb: `VMF` je Zeile mit dem Füllbyte (gleiche Folgezeilen als VCL-Typ 5). Ohne WRAP prüft der Importer o_v + VW ≤ P für alle v (Fehler sonst).

Drehrichtung: Rechtsdrehung (N → O) vergrößert o_v; bei `auto` zeigt jede Richtung ein Viertel eines 360°-Panoramas.

## 7. Python-API und Referenz-Renderer

### 7.1 API (`tools/dbetex.py`)

```python
@dataclass
class Kern: src: int; dx: int; dy: int; w: int; h: int; srcstep: int
@dataclass
class Entry:
    slot: int; flags: int; kerns: list[Kern]; rand: bytes; rand_ofs: int
    vms: bytes; fill: bytes; source: int; style_names: list[str]
@dataclass
class TexSet:
    kind: int; geometry_id: int; ne: int; depth: int; stride: int
    slot_map: list[int]; styles: list[list[int]]; entries: list[Entry]; vram: bytes

def load_geom(path, dvg=None) -> dict
def read_rgba(path) -> PIL.Image                         # nach RGBA
def to_indices(img, box, key=None, alpha_threshold=0, strict=False) -> (list[list[int|None]], list[str])
def classify(pix, mask) -> list[list[str]]                # 'F', 'L', 'R', '.' je Byte (2.4)
def choose_kerns(states, max_kerns, kern_min) -> list[tuple]
def pack_image(pix, states, kerns, stride) -> (alpha, rand: bytes, vms: bytes)
def build_texset(conf) -> (TexSet, warnings)
def to_dts(ts, load) -> bytes ; def from_dts(data) -> TexSet
def build_background(conf) -> (dbg: bytes, vram: bytes, warnings)
def from_dbg(data) -> dict
def budget(paths, pool, vms_buffer) -> dict
```

`pack_image` und `classify` sind bewusst unabhängig von DTS, damit P5b (Sprite-Sätze) sie wiederverwendet.

### 7.2 Simulator

```python
def sim_vmc(vram, src, dst, count, reps=1, dststep=0, srcstep=0)    # Semantik wie VDC-BASIC VMC (srcstep 0 = fortlaufend)
def sim_vmf(vram, dst, byte, count)
def sim_vms(vram, src, dst, vms_list)                               # Typ 1 und 8 genau nach vms-format.md
```

`vram` ist ein `bytearray(65536)`. Die Simulatoren sind die Referenz für die Tests hier und für den Listenvergleich in P6.

### 7.3 Referenz-Renderer

`render(ts, style, slot, vram, fb, ap=0, origin=0, stride=None, vb=0, geom=None, t0=None)` (`vb` = VRAM-Basis der Bilddaten in `vram`, `fb` = Zielpuffer, darf dasselbe Array sein) zeichnet einen Eintrag (nach Auflösen von `$FF`) nach 4.4 mit den Simulatoren in einen Bildpuffer. `_preview.png` je Stil: Wand – „Gang“ (alle Zellen s ≠ 0 Wand, Zelle (D, 0) Wand), je Tiefe D … 0 erst die Seiten (|s| = 1), dann (nur bei d = D) die Fronten von außen nach innen – Maleralgorithmus: Seite d liegt zwischen den Ebenen d und d + 1, also hinter Front d; Boden/Decke – alle Bänder bzw. alle Kacheln. Grund schwarz, Ausgabe mit Palette 2.2, vergrößert ×4.

## 8. Bericht und Budget

### 8.1 Bericht je Build (`.tex.md`, `.tex.json`)

- Kopfdaten (Art, Geometrie-ID, NS, NST, NI, NK), Größen: DTS-Inhalt, VRAM U, VRL-Strom (Bytes, Verhältnis aus `vrl.stats`).
- Tabelle je Stil × Slot: Eintrag, Quelle (eigen, geteilt mit Stil n, `$FF`, `$FE`), Kerne (Anzahl, Bytes), Randbytes, VMS-Länge, Alpha, DECKEND, ZEILEN.
- Summen je Stil: VRAM (geteilte Einträge beim ersten Stil gezählt), VMS-Summe.
- **VMS-Schranke**: Σ über die Slots des Maximums der VMS-Längen aller Stile (Wand: Fronten + Seiten; Boden/Decke: nur Kacheln, Bänder getrennt) – obere Schranke für ein Bild, wenn alle Plätze sichtbar sind. Vergleich mit `vms_buffer` (Standard 1300, Plan 3), Warnung bei Überschreitung.
- Warnungen (Palette, abgeschnitten, Stil 0 ohne Bild, Alpha-Konflikt), Infos (nicht bemalt, zusammengelegt).
- Die Ausgabe auf stdout ist eine Zusammenfassung von wenigen Zeilen (`zone1_walls: 3 Stile, 41 Bilder, VRAM 19 732 Byte, VRL 8 120 Byte, VMS-Schranke 1 184/1300`).

### 8.2 Pool-Prüfung (`budget`)

`dbetex.py budget FILE… --pool N [--vms-buffer N]` liest beliebig viele DTS/DBG, summiert U und listet:

| Zeile | Inhalt |
|---|---|
| je Datei | Art, U, Anteil am Pool |
| Summe | Σ U gegen `pool`; Exitcode 1 bei Überschreitung (Meldung „Pool überschritten um n Byte“) |
| VMS | Wand-Schranke + Kachel-Schranken (Boden, Decke) gegen den VMS-Puffer (nur Warnung) |
| Rest | freie Bytes für Sprites (P5b) |

Die VRAM-Basen legt das Spiel fest; das Werkzeug empfiehlt nur eine dichte Folge (Basis_i = Pool-Anfang + Σ U der vorigen), mit `--pool-start ADDR` als Adressen.

## 9. CLI

```
dbetex.py build  TEX.toml [--out DIR] [--strict] [--key RRGGBB] [--alpha-threshold N] [--no-preview]
dbetex.py bg     BG.toml  [--out DIR] [--strict]
dbetex.py dump   FILE.dts|FILE.dbg [--vrl FILE.vrl] [--json]
dbetex.py budget FILE... --pool N [--pool-start ADDR] [--vms-buffer N] [--json]
dbetex.py check  MAP.dmp|MAP.toml [--walls W.dts] [--floors F.dts] [--ceils C.dts] [--dvg G.dvg]
```

- `dump`: Kopf, Slotkarte mit Elementnamen (bei `--json` oder neben einer `geom.json` mit gleicher ID), Stiltabelle, Verzeichnis; mit `--vrl` CRC und U gegen den Kopf prüfen.
- `check` (9.5; bei `.toml` statt `.dmp` mit den Kachelnamen aus der Karte, sonst `k<Index>`): jede in der DMP benutzte Stilnummer n ≥ 1 hat n − 1 < NST im DTS der Art; Geometrie-IDs aller DTS gleich (und gleich der DVG); Fehlerliste mit Kachelname/-index, Exitcode 1.
- Ladeadressen wie P1 (`0xA000`, `$A000`, `40960`). Exitcode 0 ok, 1 Format-/Validierungsfehler (Meldung auf stderr ohne Traceback), 2 Aufruf.

## 10. Tests (`test/tools/test_dbetex.py`, unittest) und Beispiel-Assets

### 10.1 Beispiel-Assets

`tools/dbetexdemo.py OUTDIR [--geom GEOM.json]` erzeugt deterministisch (ohne Zufall oder mit festem Seed) aus der Geometrie (Standard: `dbegeom` für 140 × 96 im Speicher):

| Datei | Inhalt |
|---|---|
| `ziegel_atlas.png` | Wand, deckend: Ziegelmuster im **Wandraum** (10.4: Fronten und Seiten perspektivisch, Fugen laufen zum Fluchtpunkt; Fuge hellgrau 14, Ziegel braun 12/rot 8 im Wechsel; 4 Ziegel je Zelle, 16 Reihen je Zellhöhe), nur innerhalb der Maske |
| `gitter_atlas.png` | Wand, nicht deckend: Vollfronten als Gitter (senkrechte Stäbe, zwei Querbalken, Rest transparent), Seiten wie Ziegel (perspektivisch); Stabbreite 1 Byte, Abstand 1/6 Zelle auf Bytes gerundet |
| `fenster.json` + `fenster.png` | Aseprite-artiger Export (2 Frames, Tags `fenster`, `bogen`; Slices nur für Vollfronten, eine Slice verschoben): Front mit transparentem Fenster bzw. Rundbogen |
| `stein_atlas.png` | Boden: Bänder einfarbige Zeilen (Verlauf dunkelgrau → schwarz, wird ZEILEN), Kacheln Pflaster im Bodenraum (Quadrate 1/4 Zelle, Querfugen je Tiefe, Längsfugen zum Fluchtpunkt) |
| `holz_atlas.png` | Decke: Bänder und Kacheln Dielen im Deckenraum (Längsbretter 1/6 Zelle zum Fluchtpunkt, Stöße alle 1/2 Zelle; kein ZEILEN) |
| `himmel.png` | Panorama P = 4 · VW Byte, h = Horizontbandhöhe + 6: Himmel hellblau, Berge dunkelgrau mit Zacken, je Viertel ein Merkmal (für den Versatz-Test sichtbar) |
| `walls.toml`, `floor.toml`, `ceil.toml`, `bg.toml` | Projektdateien (Stile: ziegel, gitter, fenster, bogen) |

Die erzeugten Dateien liegen in `docs/specs/examples/tex/` im Repo (klein, für die Doku); die Tests erzeugen sie neu in `tempfile.TemporaryDirectory`.

### 10.4 Perspektivische Ableitung (`tools/dbepersp.py`)

Die Engine projiziert nichts, jedes Element ist ein fertiges Bild. Ein im Bildschirmraum gemaltes Muster ist daher auf Seiten, Boden und Decke falsch (Fugen waagerecht/senkrecht statt zum Fluchtpunkt). `dbepersp` rechnet je Maskenpixel die Weltkoordinate und wertet ein flaches Muster dort aus (Weltmaß: Zellen, Ebene 1 bei Z = 1, Z_k = W_1 / W_k):

- 1/Z = W / W_1 ist in x linear (x = C + X · W), bei Boden und Decke linear in der Zeile (W zwischen den Ebenen linear von B_d nach B_{d+1} bzw. T).
- Front (Ebene d): u = (x − C) / W_d, v = (y − T_d) / W_d.
- Seite an der Kante e: W(x) = (x − C) / e, u = Z = W_1 / W(x), v = (y − top(x)) / W(x), top linear in W zwischen T_d und T_{d+1}. Auf der Frontkante ist v gleich der Front: Reihen schließen an, Reihenhöhe gleich.
- Boden/Decke: u = X = (x − C) / W, v = Z = W_1 / W.

API: `Persp(geom)`, `element_fn(persp, element, pattern, n=4, bias=None)` (liefert `fn(px, r)` für Maskenmalen), Muster `pattern(u, v) -> Index | None` in Zellen (`brick_pattern()`, `flat_pattern(img, pixel_je_zelle)` kachelt ein flaches PNG und bildet auf die Palette ab). Je Pixel n × n Unterabtastungen, gewichtete Mehrheit; `bias={Farbe: Gewicht}` erhält dünne Fugen. Eigene flache Texturen: `flat_pattern(Image.open(...), ppc)` an `element_fn` übergeben und mit `_paint`-artiger Schleife in den Atlas malen (Vorbild `dbetexdemo.make_ziegel`).

### 10.2 Feste Werte (140 × 96, Westwood)

- Ziegel deckend: U = **11 094** (= P3-Budget `wall_style`; Summe Kern + Rand = nicht leere Bytes), alle 25 Wandeinträge außer 8 Ausschnitten mit eigenem VRAM; Ausschnitte ohne Rand und ohne VRAM, je 1 Kern mit srcstep = Vollfrontbreite (d = 1: 50, d = 2: 32, d = 3: 20); Kern 1 jedes Bildes = DVG-Kern; DECKEND bei allen 25.
- Boden „stein“: U = 3 640 (nur Kacheln; Bänder ZEILEN, 0 VRAM), 4 Einträge mit ZEILEN und h = 13, 19, 13, 6.
- Decke „holz“: U = 1 540 + 1 574 = 3 114.
- NS: Wand 25, Boden 22, Decke 22; Slotkarte im Wand-DTS: `side_d0_s-1` (DVG-Index 3) → Slot 0, `side_d0_s+1` (7) → 1, `front_d1_s+0` (11) → 2, `front_d1_s-1` (15) → 3; Boden-, Decken- und Objektplatz-Elemente → `$FF`.
- Kopf: Magic, Version, Offsets lückenlos, Gesamtlänge, U = `vrl.unpacked_length` des Stroms, CRC.

### 10.3 Eigenschaften

- **Rundlauf Bild:** Für jeden Stil und Slot: VRL entpacken (`vrl.decode`) in ein VRAM-Abbild bei Basis VB = `$5000`; Referenz-Renderer (7.3) zeichnet in einen Puffer mit zufälligem Hintergrund (Seed fest); Ergebnis pixelgleich mit dem Erwartungsbild: deckende Pixel aus dem PNG (Palette 2.2, Maske), transparente Pixel = Hintergrund. Gilt auch für Teilfronten (Erwartung: Spalten src_dx … der Vollfront) und für Zeilenfüllungen.
- **Alpha:** synthetische Bilder mit halb-R-Bytes in Farbe 0 → Alpha ≠ 0, Rundlauf stimmt; alle 16 Farben → Warnung, Rundlauf mit der dokumentierten Ersetzung.
- **VMS-Liste:** Typ 1 nur für volle Bytes, Typ 8 nur für halbe, keine Befehle für leere oder Kernbytes; Länge ≤ 255 je Typ 1 (Bild mit 300 Byte breitem Lauf über `sim_vms` aus einem Testrechteck mit stride 320); Randbytes = Summe der Längen.
- **Kerne:** nur volle Bytes, disjunkt, ≤ `max_kerns`, weitere Kerne mit h ≥ 2 und Fläche ≥ `kern_min`; `max_kerns = 0` → alles Rand; Gitter-Front: ≥ 2 Kerne, VMS-Länge kleiner als mit `max_kerns = 1`.
- **DECKEND:** Ziegel 1; Gitter-Vollfront 0, deren Teilfronten 0; Seite mit einem transparenten Pixel außerhalb des Spaltenbereichs (über T_{d+1}) bleibt 1, innerhalb → 0.
- **Stile:** fehlendes Bild in Stil 1 → `$FF`; in Stil 0 → `$FE` und Warnung; `empty` → `$FE`; identische Bilder in zwei Stilen → gleicher Index, VRAM einmal; Teilfront folgt der Vollfront (`$FF`/`$FE`).
- **Eingaben:** Palette exakt / Abweichung (Warnung, `--strict` Fehler); Alpha 128 → Fehler mit Hinweis „Masken-Ebene“; `key`; indiziertes PNG mit umsortierter Palette ergibt dieselben Indizes; Pixel außerhalb der Maske → Warnung, verworfen; unbemalte Vorlage (`_atlas.png` aus dbegeom) → alle Bilder „nicht bemalt“; Atlas zu klein → Fehler.
- **Aseprite-JSON:** `json-array` und `json-hash`; Tag und Frame; Slice-Key-Auswahl nach Frame; falsche Slice-Größe → Fehler; `trimmed` → Fehler; verschobene Slice wird gefunden; unbekannte Slice → Warnung.
- **Geometrie:** `dvg` mit anderer ID → Fehler; DTS aus 136 × 92 mit der Geometrie 140 × 96 in `check` → Fehler.
- **DBG:** Kopf; Rundlauf: für v = 0 … 3 Horizontzeilen über `sim_vmc` (mit WRAP-Teilung) = erwartetes Fenster aus dem Panorama ab o_v (zyklisch); Füllbytes über/unter dem Panorama; P nicht durch 4 teilbar mit `auto` → Fehler; ohne WRAP und o_v + VW > P → Fehler; transparentes Pixel → Fehler.
- **Budget/Check:** Summe dreier Dateien gegen Pool (unter/über, Exitcode 0/1); `check` mit der Demo-Karte (`demo.toml`, Wandstile 1, 2; Boden 1; Decke 1) gegen 1-Stil-DTS: Wandstil 2 fehlt → Fehler mit Kachelname `gitter`; mit 2 Stilen ok.
- **Determinismus:** zweimal gebaut = gleiche Bytes (DTS, VRL, DBG).
- **CLI:** `build`, `bg`, `dump --json`, `budget`, `check` über `subprocess`; Formatfehler → Exitcode 1 ohne Traceback.

Laufzeit der Testdatei < 60 s.

## 11. Ausblick P5b: Sprite-Sätze v2 (nur Schnittstelle)

Eigener Schritt, weil zwei Fragen offen sind, die P6 mitbestimmen (Beschneiden, Tiefenstufen) und weil das VRAM-Budget die Asset-Planung prägt.

- **Bild je (Phase, Blickwinkel, Tiefe d = 1 … D)**, handgemalt, keine Skalierung zur Laufzeit; unabhängig von s und Unterposition. Blickwinkel: 1 (Gegenstand), 2 oder 4. d = 0 wird nicht gezeichnet (Plan 5).
- Je Bild ein **Fußpunkt** (Byte-Spalte, Zeile im Bild); `VIEW` setzt ihn auf den DVG-Anker (d, s, p): Ziel = Anker − Fußpunkt.
- Bilddaten wie DTS-Einträge (Kerne + Rand + VMS-Liste, `pack_image` aus 7.1), Verzeichnis-Eintrag 16 Byte zuzüglich Fußpunkt; Daten wieder als eine VRL je Satz.
- **Beschneiden am Fensterrand ist ungelöst:** Ein Bild auf s = ±1 ragt seitlich aus dem Fenster; `VMS` würde außerhalb schreiben (HUD, Zeilenumbruch). Kerne lassen sich per `VMC` mit srcstep beschneiden; VMS-Listen nicht, weil die Quelle fortlaufend gelesen wird. Optionen: (a) `VIEW` leitet Befehle außerhalb beim Kopieren der Liste auf einen Schmierbereich im VRAM um (Offset = Schmierbereich − Ziel, mod 65536; Läufe an der Kante geteilt), (b) vorberechnete Listen je Randlage, (c) VDC-BASIC bekommt einen Skip-Befehl in `VMS`. **Entschieden (Plan 9): (c)**, neuer Listenbefehl „Quelle n Byte weiter“ in VDC-BASIC v3; die Engine kürzt die Listen beim Kopieren in den Puffer. Folge für DTS v2 (nicht v1): Teilfronten könnten dann die Randbytes der Vollfront mitbenutzen statt sie neu zu packen (5.3, review-notes F.2).
- **Budget:** Ein Gegner mit 4 Blickwinkeln × 2 Phasen × 3 Tiefen braucht grob 6–9 KB; nach einem Wandstil und Bändern bleiben im 26-KB-Pool etwa 10 KB (review-notes C.2). P5b muss Sparformen vorsehen (weniger Blickwinkel, Phasen nur für d = 1, gemeinsame Bilder).
- Objektliste und Blickwinkel wie Plan 5; Satzformat „SPR v2“ mit Magic `"S" "2"`.

## 12. Abnahme

- `tools/dbetex.py` (Docstring im Stil von `wallconv.py`, mit dem Aseprite-Aufruf aus 3.3), `tools/dbetexdemo.py`, `test/tools/test_dbetex.py` grün.
- Beispiele in `docs/specs/examples/tex/` (10.1) mit den daraus gebauten Berichten (`.tex.md`).
- `docs/formats.md` erhält „DTS v1“ (4.1–4.6) und „DBG v1“ (6.2), kurz, mit Verweis hierher.
