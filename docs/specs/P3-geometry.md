# P3: Geometrie – `tools/dbegeom.py`, Westwood-Preset, DVG, Vorlagen, Budget

Stand: 2026-11-25. Detailspezifikation zu Schritt P3 aus `docs/plan-0.2.md` (Abschnitte 4–6). Umsetzung: Sonnet. Review: Opus. Abhängigkeiten: Python ≥ 3.11 (`tomllib`), Pillow. Keine weiteren Pakete.

## 1. Überblick

`dbegeom.py` liest `view.toml`, rechnet die Geometrie des Sichtfensters und schreibt:

| Ausgabe | Für |
|---|---|
| `<name>.dvg` | Engine (P6): Rechtecke, Kerne, Spaltenbereiche, Bänder, Objektanker |
| `<name>.geom.json` | Werkzeuge (P5): alles aus DVG plus Masken in Pixelauflösung, Atlas-Lage, Anker in Pixeln |
| `<name>_atlas.png`, `<name>.aseprite` | Malvorlage: jedes Element einzeln, mit Maske |
| `<name>_view.png` | Übersicht: alle Elemente im Sichtfenster, Anker markiert |
| `tpl/<element>.png` | Einzelvorlage je Element |
| `<name>.budget.md` (+ Abschnitt in JSON) | VRAM und VMS-Listen je Stil |

Koordinaten: **x in Pixeln** (chunky, 2 Pixel je Byte) bzw. **in Byte-Spalten**, **y in chunky-Zeilen**. Alles relativ zur linken oberen Ecke des Sichtfensters.

## 2. `view.toml`

```toml
[viewport]
preset   = "westwood"   # "westwood" oder "custom" (dann [planes] Pflicht)
width_px = 140          # Vielfaches von 4, 16 … 160
height   = 96           # 8 … 100
origin   = 0            # Byte-Offset der linken oberen Ecke im Attribut-Puffer (relativ zu AP)
stride   = 80           # Zeilenbreite des Puffers in Byte, ≥ width_px/2, ≤ 255
depth    = 3            # D; Westwood: genau 3

[output]
name       = "west140"      # Basisname
dir        = "build/geom"   # relativ zum Ordner der view.toml
load       = 0xE400         # Ladeadresse der DVG-Datei (Bank 1)
pool_bytes = 26624          # VRAM-Pool für den Budgetbericht
zoom       = 4              # Vergrößerung der PNG-Vorlagen (nur _view.png und tpl/, Atlas immer 1:1)

[planes]                    # nur bei preset = "custom"
ref_size = [176, 120]
center_x = 88
width    = [208, 128, 80, 48, 32]   # D + 2 Werte, streng fallend
top      = [-16, 8, 16, 24, 28]     # steigend
bottom   = [144, 104, 80, 64, 56]   # fallend
```

Validierung (Fehler mit Schlüsselname, Exitcode 1): unbekannte Schlüssel, `width_px % 4 ≠ 0` (siehe 4.2), Bereiche oben, `stride < width_px/2`, `origin + (height−1)·stride + width_px/2 > 65535`, Ebenen nicht monoton, `top[k] ≥ bottom[k]`, Preset unbekannt, `depth` ≠ Anzahl Ebenen − 2.

## 3. Westwood-Preset

### 3.1 Modell

Das Sichtfenster von Eye of the Beholder (DOS) ist 176 × 120 Pixel groß, aus 22 × 15 Blöcken zu 8 × 8 Pixeln. Sichtbar sind 18 Zellen: Tiefe 3 mit 7 Zellen (s = −3 … +3), Tiefe 2 mit 5, Tiefe 1 mit 3, Tiefe 0 (eigene Zelle) mit den Seiten ±1. Lands of Lore nutzt dasselbe Fenstermaß.

Die Geometrie ist durch **Ebenen** P_k (k = 0 … D + 1) festgelegt: P_k ist die vordere Grenzfläche der Zelltiefe k. Je Ebene: Breite W_k einer Zelle, Oberkante top_k und Unterkante bot_k der Wand. Zelle (d, s) liegt zwischen P_d und P_{d+1}; seitlich reicht sie von s − ½ bis s + ½.

- Kante bei seitlicher Lage u auf Ebene k: x = 88 + u · W_k.
- **Front** eines Wandblocks (d, s), d ≥ 1: Rechteck auf P_d, x von 88 + (s − ½)·W_d bis 88 + (s + ½)·W_d, y von top_d bis bot_d.
- **Seite** eines Wandblocks (d, s ≠ 0): Viereck zwischen P_d und P_{d+1} an der der Mitte zugewandten Kante u = s + ½ (s < 0, Ostseite beim Blick nach Norden) bzw. u = s − ½ (s > 0): Ecken (x_d(u), top_d), (x_{d+1}(u), top_{d+1}), (x_{d+1}(u), bot_{d+1}), (x_d(u), bot_d).
- **Boden** der Zelle (d, s): Trapez (x_{d+1}(s−½), bot_{d+1}), (x_{d+1}(s+½), bot_{d+1}), (x_d(s+½), bot_d), (x_d(s−½), bot_d). **Decke** entsprechend mit top.
- Westwood rechnet nicht mit linearer Perspektive: Die Breiten 128 / 80 / 48 / 32 fallen etwa mit Faktor 1,6 je Tiefe. Das Preset übernimmt die Tabelle, nicht ein Kameramodell.

### 3.2 Referenzwerte (176 × 120)

| k | W_k | x links (u = −½) | x rechts (u = +½) | top_k | bot_k | Beleg |
|---|---|---|---|---|---|---|
| 0 | 208 | −16 | 192 | −16 | 144 | **Modell** (außerhalb, nur für Seiten d = 0 und Boden d = 0) |
| 1 | 128 | 24 | 152 | 8 | 104 | W: eigene Seitenwände 3 Blöcke breit (x 0–24); top/bot: **Annahme** 12 Blöcke hoch (das lineare Modell gäbe top 4) |
| 2 | 80 | 48 | 128 | 16 | 80 | W, top, bot aus den Wanddaten (Seite I-Ost: Block-Offset 50 = Zeile 2, Spalte 6, 2 breit; Front 8 Blöcke hoch) |
| 3 | 48 | 64 | 112 | 24 | 64 | Wanddaten (Fronten 6 × 5 Blöcke ab Zeile 3) |
| 4 | 32 | 72 | 104 | 28 | 56 | W aus den Seiten der Tiefe 3 (A-Ost 1, B-Ost 3, C-Ost 1 Block breit); top/bot **Modell** (top = 36 − W/4, bot = 40 + W/2) |

**Beleg:** Die Werte stammen aus der Erinnerung an die Wand-Renderdaten von EOB (Tabelle „wallRenderData“ der EOB-Viewer bzw. die VMP-Struktur: 330 Hintergrundblöcke = 22 × 15, je Wandposition Offset im Fenster, Breite und Höhe in Blöcken) und sind in sich nachgerechnet: Alle Block-Offsets der Tiefe 3 (A-, B-, C-Ost bei Spalte 0, 2, 8; E-, F-, G-West bei 13, 17, 21; Fronten B–F bei Spalte 0, 2, 8, 14, 20) folgen exakt aus W_3 = 48 und W_4 = 32. Gegen die Originaldateien geprüft sind sie **nicht**. Wo „Modell“ steht, ist der Wert aus den linearen Beziehungen top = 36 − W/4 und bot = 40 + W/2 abgeleitet, die P2 und P3 exakt erfüllen.

Abgeleitete Elemente in 176 × 120 (nach Beschneiden auf das Fenster, x in Pixeln):

| Element | d | s | x0–x1 | y0–y1 | EOB |
|---|---|---|---|---|---|
| Front | 1 | −1 / 0 / +1 | 0–24 / 24–152 / 152–176 | 8–104 | M, N, O |
| Front | 2 | −1 / 0 / +1 | 0–48 / 48–128 / 128–176 | 16–80 | I, J, K |
| Front | 3 | −2 / −1 / 0 / +1 / +2 | 0–16 / 16–64 / 64–112 / 112–160 / 160–176 | 24–64 | B–F |
| Seite | 0 | ∓1 | 0–24 / 152–176 | 0–120 (Trapez −16…144 → 8…104) | P-Ost, Q-West |
| Seite | 1 | ∓1 | 24–48 / 128–152 | 8…104 → 16…80 | M-Ost, O-West |
| Seite | 2 | ∓1 / ∓2 | 48–64, 112–128 / 0–16, 160–176 | 16…80 → 24…64 | I-Ost, K-West / H-Ost, L-West |
| Seite | 3 | ∓1 / ∓2 / ∓3 | 64–72, 104–112 / 16–40, 136–160 / 0–8, 168–176 | 24…64 → 28…56 | C/E, B/F, A/G |
| Deckenband | 0 / 1 / 2 / 3 | – | volle Breite | 0–8 / 8–16 / 16–24 / 24–28 | – |
| Bodenband | 0 / 1 / 2 / 3 | – | volle Breite | 104–120 / 80–104 / 64–80 / 56–64 | – |
| Horizontband | hinter 3 | – | volle Breite | 28–56 | – |

### 3.3 Objekt-Unterpositionen

Je freie Zelle 5 Anker (Fußpunkt auf dem Boden), Reihenfolge = Zeichenreihenfolge innerhalb der Zelle:

| p | Name | seitlich a | Tiefe t (0 = P_d, 1 = P_{d+1}) |
|---|---|---|---|
| 0 | hinten links | −¼ | ¾ |
| 1 | hinten rechts | +¼ | ¾ |
| 2 | Mitte | 0 | ½ |
| 3 | vorne links | −¼ | ¼ |
| 4 | vorne rechts | +¼ | ¼ |

Westwood legt Gegenstände auf vier Plätze (Viertel der Zelle) und Gegner in die Mitte oder paarweise; p = 0, 1, 3, 4 sind die Viertelmitten, p = 2 die Zellmitte. Berechnung im **skalierten** Raum (4.3).

## 4. Skalierung und Rundung

### 4.1 Faktoren

sx = width_px / 176, sy = height / 120 (exakt als Bruch rechnen: `fractions.Fraction`). rund(v) = ⌊v + ½⌋.

### 4.2 Ebenen

- W'_k = 4 · rund(W_k · sx / 4) (Vielfaches von 4 Pixeln = 2 Byte).
- C = width_px / 2 (Mitte; gerade, weil width_px Vielfaches von 4).
- Kante: X(k, u) = C + u · W'_k. Für halbzahlige u ist das immer gerade, also eine Bytegrenze.
- T_k = rund(top_k · sy), B_k = rund(bot_k · sy).
- Folge: Alle Fronten einer Tiefe sind gleich breit (W'_d / 2 Byte). Teilweise sichtbare Fronten (s ≠ 0) sind Ausschnitte der Vollfront (d, 0) – sie brauchen kein eigenes Bild (Budget, Abschnitt 9; DTS, P5).
- Prüfung: W'_k streng fallend, T_k < B_k, W'_d ≤ width_px für d ≥ 1 (sonst Fehler „Vollfront breiter als das Fenster“).

### 4.3 Anker

W(t) = 1 / ((1 − t)/W'_d + t/W'_{d+1}) (perspektivisch richtig zwischen den Ebenen), x = C + (s + a) · W(t), y = B_d + (B_{d+1} − B_d) · (W'_d − W(t)) / (W'_d − W'_{d+1}). Gespeichert: x_px = rund(x) und y = rund(y) in JSON; in DVG Byte-Spalte ⌊x_px / 2⌋ (vorzeichenbehaftet) und Zeile. Anker außerhalb des Fensters bleiben erhalten (große Sprites ragen hinein); eine Byte-Spalte außerhalb −128 … 127 oder y > 255 ist ein Fehler.

### 4.4 Masken, Rechteck, Kern, Spaltenbereich

- **Polygon** je Element aus den gerundeten Werten X, T, B (Abschnitt 3.1 mit W', T, B statt W, top, bot).
- **Maske:** Pixel (px, r) gehört dazu, wenn der Punkt (px + ½, r + ½) im konvexen Polygon liegt oder auf seinem Rand (alle Kreuzprodukte der Kanten ≥ 0 bzw. alle ≤ 0, exakt mit `Fraction`) **und** 0 ≤ px < width_px, 0 ≤ r < height. Elemente mit leerer Maske entfallen.
- **Rechteck** (x, y, w, h): kleinstes Byte-Rechteck um alle Maskenpixel (x = ⌊px/2⌋).
- **Byte-Zustand:** voll (beide Pixel), halb (ein Pixel: L = linkes = High-Nibble, R = rechtes = Low-Nibble), leer.
- **Kern** (kx, ky, kw, kh, relativ zum Rechteck): größtes Rechteck nur aus vollen Bytes (Fläche maximal; bei Gleichstand größere Breite, dann kleineres ky, dann kleineres kx). Algorithmus: maximales Rechteck im Histogramm je Zeile (Stapelverfahren). Keine vollen Bytes → kw = kh = 0. Für Fronten ist der Kern das ganze Rechteck.
- **Spaltenbereich** c0 … c1 − 1 (absolut, Byte-Spalten), nur für Front und Seite: größter zusammenhängender Bereich von Spalten im Rechteck, in denen **alle Bytes der Zeilen max(T_{d+1}, 0) … min(B_{d+1}, height) − 1 voll** sind. Bedeutung: In diesen Spalten verdeckt das Element alles, was hinter P_{d+1} liegt; eine Front zusätzlich die Seitenflächen derselben Tiefe, die nach ihr in der Tabelle stehen (Reihenfolge 5.3). Ohne solche Spalten c0 = c1 = 0. Für Fronten ergibt das alle Spalten des Rechtecks.
- **Beschnitten:** Polygon ragt über das Fenster hinaus.
- **Teilfront:** Front mit s ≠ 0. src_dx = (X_beschnitten_links − X(d, s − ½)) / 2 = Byte-Versatz des sichtbaren Teils in der Vollfront (Breite W'_d / 2). Beispiel 140 × 96, Front (1, −1): Vollfront 50 Byte, sichtbar die rechten 10 Byte, src_dx = 40.

### 4.5 Elementmenge

Für d = 0 … D, s = −S … +S mit S = D (Westwood: 3):

| Art | erzeugt für |
|---|---|
| Front (0) | d ≥ 1, Maske nicht leer |
| Seite (1) | s ≠ 0, Maske nicht leer |
| Boden (2) | Maske nicht leer |
| Decke (3) | Maske nicht leer |
| Objektplatz (4) | jede Zelle, die ein Boden-Element hat |

Dazu je Tiefe ein Boden- und ein Deckenband (volle Breite): Decke d = Zeilen [T_d, T_{d+1}), Boden d = [B_{d+1}, B_d), beschnitten auf [0, height). Horizontband = [T_{D+1}, B_{D+1}).

## 5. DVG-Format (Version 1)

PRG-Datei: 2 Byte Ladeadresse, dann der Inhalt. Alle Offsets relativ zum Inhalt (Byte nach der Ladeadresse). Wörter Low/High.

### 5.1 Kopf (24 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"D" "V"` (`$44 $56`) |
| 2 | Version = 1 |
| 3 | VW: Breite in Byte (width_px / 2) |
| 4 | VH: Höhe in Zeilen |
| 5 | D |
| 6 | S (größtes \|s\| unter den Elementen) |
| 7 | NE: Anzahl Elemente (≤ 255) |
| 8–9 | stride |
| 10–11 | origin |
| 12–13 | Geometrie-ID (5.5) |
| 14 | Horizontband y0 (T_{D+1}, beschnitten) |
| 15 | Horizontband y1 (B_{D+1}, exklusiv, beschnitten) |
| 16 | Elementlänge = 16 |
| 17 | Länge Tiefeneintrag = 8 |
| 18–19 | Offset Tiefentabelle (= 24) |
| 20–21 | Offset Elementtabelle (= 24 + 8 · (D + 1)) |
| 22–23 | Gesamtlänge des Inhalts |

### 5.2 Tiefentabelle (D + 1 Einträge, d = 0 … D)

| Offset | Inhalt |
|---|---|
| 0 | Deckenband y0 |
| 1 | Deckenband y1 (exklusiv; y0 = y1: leer) |
| 2 | Bodenband y0 |
| 3 | Bodenband y1 (exklusiv) |
| 4 | Index des ersten Elements dieser Tiefe |
| 5 | Anzahl Elemente dieser Tiefe |
| 6 | Breite der Vollfront in Byte (W'_d / 2; 0 bei d = 0) |
| 7 | Byte-Spalte der Vollfront (= x der Front (d, 0); 0 bei d = 0) |

### 5.3 Elementtabelle (NE × 16 Byte)

Reihenfolge **von vorne nach hinten**: d aufsteigend; je Tiefe Zellen von innen nach außen (s = 0, −1, +1, −2, +2, …); je Zelle Front, Seite, Boden, Decke, Objektplatz. (Für die Ausgabe von hinten nach vorne geht `VIEW` die Tiefen D … 0 und je Tiefe die Zellen rückwärts durch; siehe `review-notes.md` zur Reihenfolge Wände/Objekte.)

Front, Seite, Boden, Decke:

| Offset | Inhalt |
|---|---|
| 0 | Art: 0 Front, 1 Seite, 2 Boden, 3 Decke |
| 1 | d |
| 2 | s (vorzeichenbehaftet) |
| 3 | Flags: Bit 0 = Spaltenbereich gültig (deckt ab, sofern das Bild deckend ist); Bit 1 = Teilfront (Bild = Vollfront der Tiefe ab src_dx); Bit 2 = beschnitten; Rest 0 |
| 4 | x (Byte-Spalte) |
| 5 | y (Zeile) |
| 6 | w (Byte) |
| 7 | h (Zeilen) |
| 8 | kx (relativ zu x) |
| 9 | ky (relativ zu y) |
| 10 | kw (0 = kein Kern) |
| 11 | kh |
| 12 | c0 |
| 13 | c1 (exklusiv) |
| 14 | src_dx (nur Teilfront, sonst 0) |
| 15 | reserviert 0 |

Objektplatz:

| Offset | Inhalt |
|---|---|
| 0 | Art = 4 |
| 1 | d |
| 2 | s |
| 3 | 0 |
| 4–13 | 5 Anker p = 0 … 4, je 2 Byte: Byte-Spalte (vorzeichenbehaftet), Zeile des Fußpunkts |
| 14–15 | 0 |

Ziel im Puffer: `AP + origin + y · stride + x` (die Engine rechnet das über eine Zeilentabelle).

### 5.4 Grenzen

NE ≤ 255 (Westwood: 79), VW ≤ 80, VH ≤ 100, alle Byte-Felder 0 … 255 außer s und Anker-Spalte (−128 … 127).

### 5.5 Geometrie-ID

`binascii.crc_hqx(inhalt_mit_id_0, 0xFFFF)`: CRC-16/CCITT über den ganzen Inhalt, in dem die Bytes 12–13 vor der Berechnung 0 sind. Ergebnis 0 wird durch 1 ersetzt. DTS (P5) trägt die ID und wird nur zu einer DVG mit gleicher ID angenommen.

## 6. `<name>.geom.json`

```json
{
  "format": "dbegeom", "version": 1, "geometry_id": 12345,
  "viewport": {"preset": "westwood", "width_px": 140, "height": 96, "origin": 0, "stride": 80, "depth": 3},
  "planes": [{"k": 0, "W": 164, "x_left": -12, "x_right": 152, "T": -13, "B": 115}],
  "bands": [{"d": 0, "ceil": [0, 6], "floor": [83, 96]}],
  "horizon": [22, 45],
  "elements": [{
    "index": 0, "name": "floor_d0_s+0", "art": "floor", "d": 0, "s": 0,
    "rect": [3, 83, 64, 13], "kernel": [7, 0, 50, 13], "cover": [0, 0], "flags": ["clipped"],
    "src_dx": 0, "polygon": [[-12, 115], [152, 115], [120, 83], [20, 83]],
    "mask": ["..L#####…", "…"],
    "atlas": [0, 0]
  }],
  "slots": [{"d": 1, "s": 0, "anchors_px": [[52, 67], [88, 67], [70, 71], [48, 77], [92, 77]]}],
  "budget": {}
}
```

- `mask`: je Zeile des Rechtecks ein String mit w Zeichen: `#` voll, `L` nur linkes Pixel, `R` nur rechtes, `.` leer.
- `name`: `<art>_d<d>_s<±s>` mit art ∈ `front`, `side`, `floor`, `ceil`; Bänder `floorband_d<d>`, `ceilband_d<d>`; Objektplätze `obj_d<d>_s<±s>`, Anker `obj_d<d>_s<±s>_p<p>`. Diese Namen sind die Slice-Namen in der Aseprite-Vorlage und der Schlüssel für den Importer (P5).
- Werte in `kernel` relativ zum Rechteck, alles andere absolut.

## 7. Vorlagen

### 7.1 Palette (VDC, RGBI)

| Index | Farbe | RGB |
|---|---|---|
| 0 | schwarz | 000000 |
| 1 | dunkelgrau | 555555 |
| 2 | dunkelblau | 0000AA |
| 3 | hellblau | 5555FF |
| 4 | dunkelgrün | 00AA00 |
| 5 | hellgrün | 55FF55 |
| 6 | dunkelcyan | 00AAAA |
| 7 | hellcyan | 55FFFF |
| 8 | dunkelrot | AA0000 |
| 9 | hellrot | FF5555 |
| 10 | dunkelviolett | AA00AA |
| 11 | hellviolett | FF55FF |
| 12 | braun | AA5500 |
| 13 | gelb | FFFF55 |
| 14 | hellgrau | AAAAAA |
| 15 | weiß | FFFFFF |
| 16 | transparent (nur Vorlage) | 000000, Alpha 0 |

### 7.2 Atlas

Alle malbaren Bilder einzeln nebeneinander, 1:1 in chunky-Pixeln:

| Zeile (Gruppe) | Inhalt |
|---|---|
| 1 | `front_d1` … `front_dD`: je Tiefe nur die Vollfront (Rechteck W'_d × (B_d − T_d)) |
| 2 … | `side_d<d>_s<±s>` je Tiefe eine Zeile, Reihenfolge wie die Elementtabelle |
| dann | `floorband_d0` … `floorband_dD`, dann `ceilband_d0` … |
| dann | `floor_…` je Tiefe eine Zeile, dann `ceil_…` |

Regale: Bilder in einer Zeile von links nach rechts mit 4 Pixel Abstand, Zeilen mit 4 Pixel Abstand, Rand 4 Pixel. Atlasbreite = max(width_px, breiteste Zeile) + 8. Die Lage (x, y in Pixeln) steht in `atlas` in der JSON. Darstellung in `_atlas.png` (RGBA): außerhalb der Maske transparent, Maske hellgrau (AAAAAA), Kern mittelgrau (555555); halbe Bytes zeigen genau das belegte Pixel.

### 7.3 Aseprite-Vorlage (`<name>.aseprite`, eigener Schreiber, nur `struct` + `zlib`)

Format nach der offiziellen Beschreibung (`aseprite/docs/ase-file-specs.md`); alle Zahlen Little Endian.

- Kopf 128 Byte: Dateigröße (DWORD), Magic `0xA5E0`, 1 Frame, Breite/Höhe = Atlas, Farbtiefe 8 (indiziert), Flags 1, Speed 100, 0, 0, transparenter Index **16**, 3 × 0, Farbanzahl 17, Pixelbreite 1, Pixelhöhe 1, Raster 0, 0, 16, 16, Rest 0.
- Frame: Größe (DWORD), Magic `0xF1FA`, alte Chunkzahl (`0xFFFF`, wenn > 65534, sonst Anzahl), Dauer 100, 2 × 0, neue Chunkzahl (DWORD).
- Chunks in dieser Reihenfolge:
  1. Farbprofil `0x2007`: Typ 1 (sRGB), Flags 0, Gamma 0, 8 × 0.
  2. Palette `0x2019`: 17 Einträge (7.1), Index 16 mit Alpha 0.
  3. Ebene `0x2004` „Maske“: Flags 1 (sichtbar, nicht editierbar), Typ 0, Kindebene 0, Standardgröße 0, 0, Mischmodus 0, Deckkraft 128, Name „Maske“.
  4. Ebene `0x2004` „Bild“: Flags 1 | 2 (sichtbar, editierbar), Deckkraft 255.
  5. Cel `0x2005` für Ebene 0: x = y = 0, Deckkraft 255, Typ 2 (zlib), z 0; Pixel: außerhalb 16, Maske 14, Kern 1.
  6. Cel für Ebene 1: ganz Index 16 (leer, zum Malen).
  7. Je Atlasbild ein Slice `0x2022`: 1 Key, Flags 1 (9-Patch, Mitte = Kern) bzw. 0 ohne Kern, Name wie 6; Key: Frame 0, x, y, w, h (Pixel im Atlas), 9-Patch: Kern relativ (kx·2, ky, kw·2, kh). Direkt danach ein User-Data-Chunk `0x2020` mit Flags 1 und Text = JSON `{"art":…, "d":…, "s":…, "src_dx":…}`.
- Prüfung im Test mit einem kleinen eigenen Leser (Abschnitt 10); Aseprite selbst ist nicht installiert.

### 7.4 `_view.png` und `tpl/`

- `_view.png`: Sichtfenster width_px × height auf schwarzem Grund; Umrisse aller Elemente als 1-Pixel-Linien (Farbe je Tiefe: d0 rot, d1 gelb, d2 grün, d3 blau); die Bänder als 4 Pixel breite Farbstreifen am linken Rand (Decke cyan, Boden braun, Horizont violett); Anker als weißes 3 × 3-Kreuz. Danach mit `zoom` vergrößert (Nearest).
- `tpl/<name>.png`: je Element des Atlas ein Bild seines Rechtecks (RGBA wie 7.2), vergrößert mit `zoom`.

## 8. CLI

```
dbegeom.py view.toml [--out DIR] [--name NAME] [--check]
dbegeom.py --preset westwood --width 140 --height 96 [--stride 80 --origin 0] [--out DIR]
```

- `--check`: nur validieren und die Elementtabelle als Text ausgeben (eine Zeile je Element wie `d=1 s=-1 front x=0 y=6 w=10 h=77 kern=0,0,10,77 cov=0..10 src_dx=40`).
- Exitcode 0 ok, 1 Validierungsfehler, 2 Aufruf.

## 9. Budgetbericht

Je Stil (ein Bildsatz für alle Elemente einer Art):

| Größe | Berechnung |
|---|---|
| Kernbytes | kw · kh |
| Randbytes | Bytes im Rechteck außerhalb des Kerns mit mindestens einem Maskenpixel (gepackt im VRAM, Quelle für `VMS`) |
| VRAM je Element | Kern + Rand; Teilfronten 0 (aus der Vollfront) |
| VMS-Liste je Element | 3 + Σ je Zeile des Randes: zusammenhängende volle Bytes = 1 Befehl Typ 1 (4 Byte), jedes halbe Byte = Typ 8 (3 Byte) |

Bericht (`.budget.md` und `budget` in JSON):

1. Tabelle je Element: Name, Rechteck, Kern, Rand, VRAM, VMS-Liste.
2. Summen je Art: **Wandstil** (Front + Seite), Bodenstil (Bänder; zusätzlich Kacheln), Deckenstil (ebenso).
3. Pool: wie viele Wandstile + 1 Boden- + 1 Deckenstil in `pool_bytes` passen.
4. Größte Summe der VMS-Listen eines Bildes (obere Schranke: alle Wandelemente eines Stils gleichzeitig) gegen den VMS-Puffer 1,3 KB (Plan Abschnitt 3); Warnung bei Überschreitung.

Richtwerte aus dem Prototyp des Spezifikationsautors (Toleranz ± 3 %, nur zur Plausibilität, nicht als Testwert):

| Fenster | Vollfronten | Seiten | Wandstil | Bodenbänder | Deckenbänder |
|---|---|---|---|---|---|
| 176 × 120 | 9 664 | 7 588 | 17 252 | 5 632 | 2 464 |
| 140 × 96 | 6 122 | 4 972 | **11 094** | 3 570 | 1 540 |
| 136 × 92 | 5 728 | 4 642 | 10 370 | 3 332 | 1 428 |

(Plan: „etwa 9–10 KB je Wandstil“ – siehe `review-notes.md`.)

## 10. Tests (`test/tools/test_dbegeom.py`, unittest)

Aufruf wie P1. Ausgaben in `tempfile.TemporaryDirectory`.

### 10.1 Feste Werte 140 × 96 (Westwood)

Ebenen:

| k | W' | X(−½) | X(+½) | T | B |
|---|---|---|---|---|---|
| 0 | 164 | −12 | 152 | −13 | 115 |
| 1 | 100 | 20 | 120 | 6 | 83 |
| 2 | 64 | 38 | 102 | 13 | 64 |
| 3 | 40 | 50 | 90 | 19 | 51 |
| 4 | 24 | 58 | 82 | 22 | 45 |

Bänder (Decke / Boden): d0 0–6 / 83–96, d1 6–13 / 64–83, d2 13–19 / 51–64, d3 19–22 / 45–51; Horizont 22–45.

Fronten (x, y, w, h in Byte/Zeilen; src_dx; Kern = ganzes Rechteck; Spaltenbereich = x … x + w):

| d | s | x | y | w | h | src_dx |
|---|---|---|---|---|---|---|
| 1 | −1 | 0 | 6 | 10 | 77 | 40 |
| 1 | 0 | 10 | 6 | 50 | 77 | 0 |
| 1 | +1 | 60 | 6 | 10 | 77 | 0 |
| 2 | −1 | 0 | 13 | 19 | 51 | 13 |
| 2 | 0 | 19 | 13 | 32 | 51 | 0 |
| 2 | +1 | 51 | 13 | 19 | 51 | 0 |
| 3 | −2 | 0 | 19 | 5 | 32 | 15 |
| 3 | −1 | 5 | 19 | 20 | 32 | 0 |
| 3 | 0 | 25 | 19 | 20 | 32 | 0 |
| 3 | +1 | 45 | 19 | 20 | 32 | 0 |
| 3 | +2 | 65 | 19 | 5 | 32 | 0 |

Seiten (x, y, w, h; Spaltenbereich c0–c1):

| d | s | Rechteck | c0–c1 |
|---|---|---|---|
| 0 | −1 / +1 | 0, 0, 10, 96 / 60, 0, 10, 96 | 0–10 / 60–70 |
| 1 | −1 / +1 | 10, 6, 9, 76 / 51, 6, 9, 76 | 10–19 / 51–60 |
| 2 | −1 / +1 | 19, 13, 6, 50 / 45, 13, 6, 50 | 19–25 / 45–51 |
| 2 | −2 / +2 | 0, 17, 5, 37 / 65, 17, 5, 37 | 0–5 / 65–70 |
| 3 | −1 / +1 | 25, 19, 4, 32 / 41, 19, 4, 32 | 25–29 / 41–45 |
| 3 | −2 / +2 | 5, 19, 12, 32 / 53, 19, 12, 32 | 5–17 / 53–65 |
| 3 | −3 / +3 | 0, 21, 5, 25 / 65, 21, 5, 25 | 0–5 / 65–70 |

Anzahlen: 11 Fronten, 14 Seiten, 18 Böden, 18 Decken, 18 Objektplätze, NE = 79.

Anker (Byte-Spalte, Zeile), p = 0 … 4:

| d, s | Anker |
|---|---|
| 1, 0 | (26,67) (44,67) (35,71) (24,76) (46,76) |
| 2, 0 | (29,53) (40,53) (35,56) (28,59) (42,59) |
| 3, 0 | (31,46) (38,46) (35,47) (30,49) (39,49) |
| 2, −1 | (7,53) (18,53) (10,56) (0,59) (14,59) |
| 0, 0 | (21,88) (49,88) (35,95) (17,104) (52,104) |

136 × 92: Ebenen W' = 160, 100, 60, 36, 24; T = −12, 6, 12, 18, 21; B = 110, 80, 61, 49, 43.

176 × 120: Ebenen genau wie Tabelle 3.2.

### 10.2 Eigenschaften (für 140 × 96, 136 × 92, 176 × 120 und eine Custom-Geometrie)

- Symmetrie: Element (d, −s) ist das Spiegelbild von (d, s): x' = VW − x − w, Maske zeilenweise gespiegelt (L ↔ R).
- Kern besteht nur aus vollen Bytes; kein größeres volles Rechteck existiert (Brute Force über alle Rechtecke im Element).
- Spaltenbereich: alle Bytes in den Zeilen von P_{d+1} voll; Bereich zusammenhängend und maximal.
- Fronten einer Tiefe: gleiche Breite außer beschnittenen; src_dx + w ≤ Vollfrontbreite.
- Jedes Maskenpixel liegt im Rechteck und im Fenster; Bänder überdecken die Zeilen 0 … VH − 1 zusammen mit dem Horizontband lückenlos und überschneidungsfrei.
- DVG: Kopf-Felder, Offsets, Länge, Element- und Tiefentabelle stimmen mit der JSON überein; Elemente in der Reihenfolge 5.3; Geometrie-ID nach 5.5 nachgerechnet; zweimal erzeugt = gleiche Bytes.
- Aseprite: eigener Mini-Leser prüft Magic `0xA5E0`/`0xF1FA`, Dateigröße, Chunkgrößen summieren sich zur Framegröße, 2 Ebenen, 2 Cels (zlib entpackbar, Größe = Atlas), Anzahl Slices = Anzahl Atlasbilder, Namen wie in der JSON, 9-Patch = Kern.
- PNG: Größen stimmen (Atlas 1:1, `tpl` mit zoom), Alpha 0 genau außerhalb der Maske.
- Validierung: `width_px = 138` → Exitcode 1; `stride = 60` bei 140 → 1; Custom mit nicht fallender Breite → 1.

## 11. Abnahme

- `tools/dbegeom.py` (Docstring im Stil von `wallconv.py`), `test/tools/test_dbegeom.py` grün, Laufzeit < 60 s.
- Beispiel `docs/specs/examples/view-west140.toml` (Standard) und `view-west136.toml` (2 Textzeilen).
- `docs/formats.md` erhält „DVG v1“ (Tabellen 5.1–5.3, kurz).
