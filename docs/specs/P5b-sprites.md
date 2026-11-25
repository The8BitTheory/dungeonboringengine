# P5b: Sprite-Sätze v2 – `tools/dbespr.py`, Format S2, Beschneiden

Stand: 2026-11-25. Detailspezifikation zu Schritt P5b (Plan 5, 6; `P5-textures.md` 11). Umsetzung: Sonnet. Review: Opus. Abhängigkeiten: Python ≥ 3.11, Pillow, `tools/vrl.py`, `tools/dbetex.py` (P5, als Modul), `tools/dbegeom.py` (nur Tests). Voraussetzung in VDC-BASIC v3: VMS-Listenbefehl Typ 3 (source skip, vorhanden seit `c57ba31`).

## 1. Ziel und Abgrenzung

- **Dynamische Objekte** (Gegner, Gegenstände, Projektile, Effekte) als handgemalte Bilder je **(Phase, Blickwinkel, Tiefe d = 1 … D)**. Keine Skalierung oder Spiegelung zur Laufzeit; d = 0 wird nicht gezeichnet (Plan 5).
- Ein Bild ist **unabhängig von s und Unterposition**. `VIEW` (P6) setzt es mit seinem **Fußpunkt** auf den DVG-Anker (d, s, p) und **beschneidet** es am Sichtfenster und an verdeckten Spalten.
- Bilddaten wie DTS-Einträge: Kerne (`VMC`) und Rand (`VMS` Typ 1/8, gepackt). Ein Satz = eine Metadatei (Bank 1) + eine VRL (Bank 0 → `RXV` an die VRAM-Basis), wie DTS (P5 1).
- Die Animation steuert das Spiel (Phasennummer in der Objektliste). Der Satz enthält die Aseprite-Tags nur als Tabelle (Name, erste Phase, Anzahl, Modus, Dauer) für das Spiel und den Bericht. `VIEW` animiert nicht.
- **Eigenes Werkzeug** `tools/dbespr.py` statt Erweiterung von `dbetex.py` (dort 1447 Zeilen); es importiert `to_indices`, `classify`, `choose_kerns`, `pack_image`, `sim_*`, `read_rgba`, `PALETTE` aus `dbetex`.
- Die **Beschneide-Funktion** `clip_image` (Abschnitt 6) ist die Referenz für `VIEW` (P6, 5.9) und für den Listenvergleich.

Nicht in P5b: Anpassung der Crawl-Sprites (`crawlsprites.py` → S2, gehört zu P7), Laufzeit-Animation, Spiegeln.

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| Phase f | 0 … NP − 1; Frame-Nummer in Aseprite |
| Blickwinkel a | 0 … 3, aus Spieler- und Objektrichtung: a = (2 + v − o) AND 3 (v Spieler, o Objekt, wie SPR v1). **0 = Vorderseite** (Objekt schaut den Spieler an), **1 = rechte Flanke der Figur**, **2 = Rücken**, **3 = linke Flanke**. Objektrichtung `$FF` → a = 0 |
| Bildwinkel ai | 0 … NA − 1; Index der gemalten Ansicht. `angle_map[a]` bildet a auf ai ab |
| Tiefe d | 1 … D (D aus der DVG) |
| Bildrechteck | w Byte × h Zeilen; Byte bx = 2 Pixel (links = High-Nibble, P5 2.1) |
| Fußpunkt (fx, fy) | Byte-Spalte und Zeile **im Bild**, die auf dem DVG-Anker (ax, ay) zu liegen kommt: Bild links oben = (ax − fx, ay − fy) |

Standard für `angle_map` (überschreibbar):

| NA | angle_map (a = 0, 1, 2, 3) | Bedeutung |
|---|---|---|
| 1 | 0, 0, 0, 0 | eine Ansicht (Gegenstände) |
| 2 | 0, 0, 1, 0 | vorne, hinten; Flanken zeigen vorne |
| 3 | 0, 1, 2, 1 | vorne, Flanke, hinten |
| 4 | 0, 1, 2, 3 | alle |

## 3. Eingaben

### 3.1 Projektdatei `spr.toml`

```toml
format  = "dbespr"
version = 1

[sprite]
name       = "ork"
geom       = "../geom/west140.geom.json"   # Pflicht (Stride, D, Ebenen, Anker)
dvg        = "../geom/west140.dvg"         # optional: ID gegenprüfen
out        = "build/spr"
load       = 0x7000                        # Ladeadresse S2 (Bank 1, P6 Speicherkarte)
vrl_load   = 0x4000
angles     = 4                             # NA, 1 … 4
angle_map  = [0, 1, 2, 3]                  # optional, Standard nach Tabelle 2
phases     = 2                             # NP, 1 … 32; fehlt: aus der Quelle (höchste Phase + 1)
max_kerns  = 4                             # 0 … 16 (wie P5 5.4, Obergrenze siehe review-notes G.2)
kern_min   = 16
key        = "FF00FF"                      # optional (P5 2.3)
alpha_threshold = 0
any_geometry = false                       # true: Geometrie-ID 0 schreiben (nur Stride und D binden, 4.1)
mirror     = { 3 = 1 }                     # optional: Bildwinkel 3 = gespiegelter Bildwinkel 1 (Werkzeug, kein Laufzeit-Spiegeln)
derive     = "none"                        # "none" | "nearest": fehlende Tiefen aus der nächstgrößeren verkleinern (5.4)

[source]
aseprite = "ork.json"                      # Aseprite-Export (3.2)
# oder: png = "ork.png" mit [[image]]-Einträgen (3.3)
```

Regeln: unbekannte Schlüssel sind Fehler (wie P5 3.1); genau eine Quelle; `angle_map` hat 4 Werte < NA; `mirror` nur zwischen vorhandenen Bildwinkeln; CLI-Optionen überschreiben `[sprite]`.

### 3.2 Aseprite-Export

Konvention in der `.aseprite`-Datei:

| Aseprite | Bedeutung |
|---|---|
| **Ebene** `v<ai>_d<d>` (z. B. `v0_d1`) | Ansicht ai in Tiefe d; jede Tiefe wird in ihrer Größe gemalt |
| **Frame** f | Phase f |
| **Tag** (Name, Frames von–bis, Richtung) | Animation: Phasen von–bis; Richtung `forward`, `reverse`, `pingpong` |
| **Slice** `v<ai>_d<d>` mit Pivot | Bildrechteck und Fußpunkt (Pivot = Fußpunkt, relativ zur Slice); Keys je Frame erlaubt (gültig: größter Key-Frame ≤ f, P5 3.3) |
| andere Ebenen (z. B. `ref`, `Hilfslinien`) | werden ignoriert, wenn ihr Name nicht dem Muster entspricht (Info) |

Aufruf (steht im Docstring und im Bericht):

```
aseprite -b ork.aseprite --split-layers --sheet ork.png --data ork.json --format json-array \
         --filename-format '{layer}#{frame}' --list-layers --list-tags --list-slices
```

Gelesen wird:

- `frames`: je Eintrag `filename` = `<layer>#<frame>`, `frame` {x, y, w, h} im Sheet, `duration` (ms). `trimmed`/`rotated` = true → Fehler (wie P5 3.3). Ohne Trim ist jeder Sheet-Frame so groß wie die Leinwand.
- `meta.frameTags`: Name, `from`, `to`, `direction` (fehlt: `forward`).
- `meta.slices`: Name, `keys[]` mit `frame`, `bounds` {x, y, w, h} (Leinwandkoordinaten), optional `pivot` {x, y} (relativ zu `bounds`).
- Je (Ebene `v<ai>_d<d>`, Frame f): Pixel nach P5 2.2/2.3 (Palette, Alpha, `key`).
  - **Slice vorhanden:** Bild = Pixel innerhalb `bounds`; deckende Pixel der Ebene außerhalb → Warnung „außerhalb der Slice, verworfen“. Fußpunkt = `pivot`; ohne Pivot: Mitte der untersten Zeile (x = ⌊w_px / 2⌋, y = h − 1).
  - **Keine Slice:** Bild = kleinstes Rechteck um alle deckenden Pixel; Fußpunkt = Mitte der untersten Zeile. Info „Fußpunkt automatisch“.
  - **Leere Cel** (keine deckenden Pixel): kein Bild für (f, ai, d).
- Ebene mit unbekanntem ai ≥ NA oder d > D oder d = 0 → Fehler.

### 3.3 PNG mit Bildliste

```toml
[source]
png = "gem.png"

[[image]]                 # je Bild ein Eintrag
box   = [0, 0, 12, 10]    # x, y, w, h in Pixeln
foot  = [6, 9]            # relativ zu box, in Pixeln; fehlt: Mitte der untersten Zeile
phase = 0
angle = 0                 # ai
depth = 1
```

Gleiche (phase, angle, depth) doppelt → Fehler. Für Gegenstände und Tests; Animationen ohne Tags.

### 3.4 Byte-Raster und Fußpunkt

- Das Bild beginnt auf der **geraden** Pixelspalte x_e = box.x − (box.x mod 2); w = ⌈(box.x + box.w − x_e) / 2⌉ Byte. Zusätzliche Randpixel sind transparent.
- fx = ⌊(box.x + foot_x − x_e) / 2⌋, fy = foot_y. Liegt der Fußpunkt auf dem rechten Pixel eines Bytes, Info „Fußpunkt auf Bytegrenze gerundet“ (Anker sind Byte-genau, P3 4.3).
- Prüfungen: 1 ≤ w ≤ min(VW, 127), 1 ≤ h ≤ VH, 0 ≤ fx < w, 0 ≤ fy < h (Fehler sonst).
- **Höhenprüfung (Warnung):** Bild höher als die Wand an seiner Tiefe, also Oberkante ay − fy < T_d mit ay = Zeile des Ankers p = 0 (hinten links) der Zelle (d, 0) und T_d = Wandoberkante der Ebene d (`planes`). Grund: `VIEW` beschneidet nach Spalten; was über die Wandoberkante der davor liegenden Wand hinausragt, würde mit abgeschnitten (P6 5.4, review-notes G.8).

## 4. Format S2 (Version 1)

PRG-Datei: 2 Byte Ladeadresse (`load`, Standard `$7000`, Bank 1), dann der Inhalt. Offsets relativ zum Inhalt, Wörter Low/High. VRAM-Offsets relativ zur VRAM-Basis aus `SPRITESET` (P6). Bereiche lückenlos in der Reihenfolge Kopf, Indextabelle, Bildverzeichnis, Kerntabelle, Tagtabelle, Datenbereich.

### 4.1 Kopf (40 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"S" "2"` (`$53 $32`) |
| 2 | Version = 1 |
| 3 | Flags: Bit 0 = Gegenstand (nur Hinweis für Werkzeuge); Rest 0 |
| 4–5 | Geometrie-ID der DVG; **0 = jede Geometrie** mit gleichem Stride und D (`any_geometry`) |
| 6 | D (Kontrolle; Tiefen 1 … D in der Indextabelle) |
| 7 | NA (1 … 4) |
| 8 | NP (1 … 32) |
| 9 | NI: Anzahl Bilder (≤ 254) |
| 10–11 | NK: Anzahl Kerne (Wort) |
| 12–15 | `angle_map[0 … 3]` |
| 16–17 | Offset Indextabelle |
| 18–19 | Offset Bildverzeichnis |
| 20–21 | Offset Kerntabelle |
| 22–23 | Offset Tagtabelle |
| 24 | NT: Anzahl Tags (≤ 32) |
| 25 | reserviert 0 |
| 26–27 | Offset Datenbereich (VMS-Listen) |
| 28–29 | Gesamtlänge des Inhalts |
| 30–31 | VRAM-Länge U (= entpackte Länge der VRL) |
| 32–33 | CRC der VRAM-Daten (`binascii.crc_hqx(daten, 0xFFFF)`) |
| 34–35 | stride (Kontrolle) |
| 36–39 | reserviert 0 |

### 4.2 Indextabelle (NP · NA · D Byte)

Eintrag für (f, ai, d) bei `(f · NA + ai) · D + (d − 1)`:

| Wert | Bedeutung |
|---|---|
| 0 … `$FD` | Bildindex |
| `$FE` | kein Bild: nichts zeichnen |
| `$FF` | Rückgriff auf **Phase 0** desselben (ai, d); in Phase 0 nicht erlaubt |

Der Importer schreibt `$FF` für fehlende Bilder in Phase ≥ 1, `$FE` für fehlende Bilder in Phase 0 (Warnung „Phase 0 ohne Bild für v<ai>_d<d>“, außer bei `derive`). `VIEW`: f ≥ NP → f = 0.

### 4.3 Bildverzeichnis (NI × 16 Byte)

| Offset | Inhalt |
|---|---|
| 0 | Flags: Bit 3 RAND (VMS-Liste vorhanden); Rest 0 |
| 1 | w (Byte) |
| 2 | h (Zeilen) |
| 3 | fx |
| 4 | fy |
| 5 | nk: Anzahl Kerne (0 … 16) |
| 6–7 | Offset des ersten Kerns in der Kerntabelle (relativ zum Inhalt; 0 bei nk = 0) |
| 8–9 | VRAM-Offset der gepackten Randbytes |
| 10–11 | Anzahl Randbytes |
| 12–13 | Offset der VMS-Liste (0 = keine) |
| 14–15 | Länge der VMS-Liste (Kopf + Befehle) |

Gleiche Bilder (gleiche Pixel, w, h, fx, fy) werden zusammengelegt (ein Eintrag, VRAM einmal).

### 4.4 Kerntabelle (NK × 8 Byte)

Wie DTS (P5 4.5): VRAM-Offset (Wort), dx, dy (relativ zum Bildrechteck), w, h, srcstep (Wort, 0 = gepackt). In S2 ist srcstep immer 0.

### 4.5 Tagtabelle (NT × 12 Byte)

| Offset | Inhalt |
|---|---|
| 0–7 | Name, ASCII (PETSCII-tauglich: Großbuchstaben, Ziffern, `_`), mit `$00` aufgefüllt, auf 8 Zeichen gekürzt (Warnung bei Kürzung oder Doppelung) |
| 8 | erste Phase |
| 9 | Anzahl Phasen |
| 10 | Modus: 0 forward, 1 reverse, 2 pingpong |
| 11 | Dauer je Phase in Jiffies (1/60 s): rund(ms · 60 / 1000), mindestens 1, höchstens 255; ungleiche Dauern im Tag → Mittelwert, Warnung |

### 4.6 Datenbereich

VMS-Listen im VDC-BASIC-Format (P5 4.6), nur Typ 1 und 8. Zusätzliche **Formatregeln** (für das Beschneiden, P6 5.9, review-notes G.7): Befehle in Zeilenreihenfolge mit streng steigendem ofs; ofs = Zeile · stride + Byte-Spalte relativ zur linken oberen Bildecke; ein Typ-1-Lauf bleibt in seiner Zeile (Spalte + len ≤ w). `pack_image` (P5 5.2) erfüllt das.

### 4.7 Grenzen

NI ≤ 254, NP ≤ 32, NA ≤ 4, NT ≤ 32, nk ≤ 16, NK ≤ 65535, Inhalt ≤ 8192 (ein Satz passt in den Sprite-Bereich der Bank-1-Speicherkarte, P6 2.4; Warnung ab 4096), U ≤ 65535. Überschreitung: Fehler mit Ursache.

## 5. Umwandlung

### 5.1 Je Bild

1. Pixel nach 3.2/3.3 und P5 2.2/2.3, Byte-Raster nach 3.4.
2. `classify(pix, None)` (keine Elementmaske), `choose_kerns(states, max_kerns, kern_min)`, `pack_image(pix, states, kerns, stride)` mit dem Stride der Geometrie.
3. VRAM-Daten je Bild: Kern 1, Kern 2, …, Rand (wie P5 5.4).

### 5.2 Reihenfolge und Zusammenlegen

Bilder in der Reihenfolge (f, ai, d) aufsteigend; ein Bild, das einem früheren gleicht, bekommt dessen Index. VRAM-Daten in Verzeichnisreihenfolge, lückenlos.

### 5.3 Spiegeln (`mirror`)

`mirror = { Ziel = Quelle }`: Für jedes (f, d) ohne eigenes Bild im Ziel-Bildwinkel entsteht das Bild aus der Quelle durch Spiegeln der Pixelzeilen; Fußpunkt fx' = w − 1 − fx (bei ungeradem Fußpunktpixel nach 3.4 neu gerundet). Belegt VRAM wie ein gemaltes Bild.

### 5.4 Abgeleitete Tiefen (`derive = "nearest"`)

Fehlt einem (f, ai) die Tiefe d, gibt es aber d − 1 (bzw. die nächstkleinere vorhandene Tiefe), wird das Bild mit Nearest-Neighbour verkleinert: Faktor k = W(½, d) / W(½, d_quelle) mit W(t) nach P3 4.3 (Zellbreite auf halber Zelltiefe, aus `planes` der geom.json); neue Pixelgröße rund(w_px · k) × rund(h · k), mindestens 1; Fußpunkt skaliert. Warnung „Tiefe d aus Tiefe d' abgeleitet“. Nur als Hilfe für Prototypen; die Engine verzerrt weiterhin nichts.

## 6. Beschneiden: `clip_image` (Referenz für P6)

```python
def clip_image(img, x0, y0, cx0, cx1, cy0, cy1) -> Clipped
```

`img` = Bildeintrag (w, h, Kerne, Rand-VRAM-Offset, VMS-Liste), (x0, y0) = linke obere Bildecke im Sichtfenster (Byte-Spalte, Zeile; vorzeichenbehaftet), [cx0, cx1) × [cy0, cy1) = sichtbarer Ausschnitt im Sichtfenster (P6 bestimmt ihn aus Fenster und Abdeckung; immer ⊆ Bildrechteck und nicht leer). Im Bild: L = cx0 − x0, R = cx1 − x0, T = cy0 − y0, B = cy1 − y0. **Unbeschnitten** heißt L = 0, R = w, T = 0, B = h.

Ergebnis: Liste der Kern-Kopien, optional eine neue VMS-Liste, Bezugspunkt.

### 6.1 Kerne

Je Kern (kx, ky, kw, kh, src, srcstep), Schrittweite st = srcstep, falls ≠ 0, sonst kw:

- Spalten a = max(kx, L), b = min(kx + kw, R); Zeilen c = max(ky, T), e = min(ky + kh, B). Leer → Kern entfällt.
- src' = src + (c − ky) · st + (a − kx); Ziel = Zeile y0 + c, Spalte x0 + a; Breite b − a, Zeilen e − c.
- srcstep' = srcstep, wenn a = kx und b = kx + kw (volle Breite), sonst st. (Volle Breite bei srcstep 0 bleibt gepackt: VCL-Typ 2; sonst Typ 3.)

### 6.2 VMS-Liste

Unbeschnitten: Liste unverändert, Bezugspunkt (x0, y0).

Beschnitten: **Bezugspunkt (cx0, cy0)**; die Liste wird neu geschrieben. Durchlauf über die Befehle mit Zeilenzähler r und Zeilenanfang rs (r = 0, rs = 0 am Anfang; vor jedem Befehl `while ofs ≥ rs + stride: rs += stride; r += 1`), Spalte col = ofs − rs, Lesezähler „ausstehender Sprung“ k = 0:

| Befehl | sichtbar, wenn | Ausgabe |
|---|---|---|
| Typ 1 (ofs, len) | T ≤ r < B und [col, col + len) ∩ [L, R) ≠ ∅ | a = max(col, L), b = min(col + len, R): k += a − col; falls k > 0: Typ 3 (k), k = 0; Typ 1 (ofs' = (r − T) · stride + (a − L), b − a); k += col + len − b |
| Typ 1, unsichtbar | sonst | k += len |
| Typ 8 (ofs) | T ≤ r < B und L ≤ col < R | falls k > 0: Typ 3 (k), k = 0; Typ 8 (ofs' wie oben mit a = col) |
| Typ 8, unsichtbar | sonst | k += 1 |

- Sobald r ≥ B, endet der Durchlauf (Rest entfällt, kein abschließender Typ 3).
- Ein ausstehendes k am Ende wird nicht ausgegeben.
- Kopf der neuen Liste: Alpha unverändert, Anzahl = ausgegebene Befehle (inklusive Typ 3). Typ 3 hat das Format `03 n_lo n_hi` (VDC-BASIC `vms-format.md`); k ≤ 65535 (Randbytes ≤ U).
- Bleibt kein Typ-1- oder Typ-8-Befehl übrig, entfällt die Liste ganz (Ergebnis ohne VMS).
- ofs' ist immer < 65536, weil der Ausschnitt im Sichtfenster liegt (P6 rechnet das Ziel als `AP + Zeilenadresse(cy0) + cx0`).

### 6.3 Weitere Funktionen

```python
def render_image(s2, img_index, vram, fb, x0, y0, vp, ap=0, vb=0, clip=None)   # zeichnet über clip_image + sim_*
def from_s2(data) -> SpriteSet ; def to_s2(ss, load) -> bytes
def lookup(ss, phase, a, d) -> int | None      # 4.2 inkl. angle_map, $FF, f >= NP
```

`dbetex.sim_vms` bekommt Typ 3 (Lesezähler += n, nichts schreiben); Typ 2 bleibt ungenutzt.

## 7. Bericht, Budget

### 7.1 Bericht (`<name>.spr.md`, `<name>.spr.json`, stdout eine Zeile)

- Kopf (NA, NP, D, NI, NK, NT), S2-Inhalt (Bank 1), VRAM U, VRL-Strom.
- Tabelle je (f, ai, d): Index, Quelle (eigen, geteilt, gespiegelt, abgeleitet, `$FF`, `$FE`), w × h, Fußpunkt, Kerne/Kernbytes, Randbytes, VMS-Länge, **VCL-Bytes** (11 bzw. 13 je Kern + 7 bei Rand).
- **Puffer:** größte VMS-Liste und größte Summe VCL + VMS eines Bildes; Warnung, wenn ein Bild mehr als 1/3 des gemeinsamen Puffers (P6: 2304 Byte) braucht.
- Warnungen (Palette, außerhalb der Slice, Höhenprüfung 3.4, Tag gekürzt, Phase 0 ohne Bild), Infos.
- Tags als Tabelle und als BASIC-Hilfe: `REM ORK: IDLE 0-1 30J, WALK 2-5 8J`.

### 7.2 Budget (Richtwerte, 140 × 96)

Nach P3/P5: 1 Wandstil + Boden- und Deckenbänder ≈ 16 KB im 26-KB-Pool, rund 10 KB bleiben für Tapete und Sprites (review-notes C.2, F.9). Schätzung für eine Figur mit 40 % der Zellbreite und 70 % der Wandhöhe, 65 % Deckung:

| Tiefe | Bild etwa | VRAM etwa |
|---|---|---|
| d = 1 | 20 × 54 Byte | 700 |
| d = 2 | 13 × 35 | 300 |
| d = 3 | 8 × 22 | 115 |

| Sparform | VRAM je Gegnertyp |
|---|---|
| 4 Blickwinkel × 2 Phasen × 3 Tiefen | ≈ 8,9 KB |
| 4 Blickwinkel, 2 Phasen nur in d = 1 (`$FF` sonst) | ≈ 7,3 KB |
| 2 Blickwinkel (vorne/hinten), 2 Phasen nur in d = 1 | ≈ 3,6 KB |
| 1 Blickwinkel, 2 Phasen in d = 1 | ≈ 1,8 KB |
| Gegenstand, 1 Bild je Tiefe | 0,1–0,4 KB |

`dbespr.py budget` = `dbetex.py budget` mit S2-Dateien (die P5-Funktion liest S2 zusätzlich: Art „Sprite“, U).

## 8. CLI

```
dbespr.py build SPR.toml [--out DIR] [--strict] [--key RRGGBB] [--no-preview]
dbespr.py dump  FILE.s2 [--vrl FILE.vrl] [--json]
dbespr.py preview FILE.s2 --vrl FILE.vrl --geom G.json [--d D] [--phase F] [--angle A] [--out PNG]
```

`preview`: alle Bilder einer Tiefe auf allen Unterpositionen der Zellen (d, s) über einem Gitter, beschnitten nach 6 (zeigt das Beschneiden am Rand), ×4. `build` schreibt `<name>.s2`, `<name>.vrl`, Bericht und `<name>_preview.png`. Exitcodes wie P5.

## 9. Tests (`test/tools/test_dbespr.py`, unittest)

### 9.1 Beispiel-Assets

`tools/dbesprdemo.py OUTDIR [--geom G.json]` erzeugt deterministisch:

| Datei | Inhalt |
|---|---|
| `blob.json` + `blob.png` | Aseprite-artiger Export, `--split-layers`-Namen: Ebenen `v0_d1 … v3_d3`, 2 Frames, Tags `idle` (0–0), `walk` (0–1, pingpong, 150 ms), Slices mit Pivot für d = 1, ohne Slice für d = 2 (automatisch), `v0_d3` in Frame 1 leer (→ `$FF`); Figur mit halben Bytes am Rand, ungerader Breite und einem Loch (Auge transparent) |
| `gem.png` + `gem.toml` | PNG mit Bildliste, NA = 1, NP = 2 (Glitzern), Tiefen 1–3 |
| `blob.toml` | Projektdatei (NA 4, `mirror = {3 = 1}` als zweite Variante `blob_m.toml`) |

Kopien in `docs/specs/examples/spr/` (klein); Tests erzeugen neu im Temp-Verzeichnis.

### 9.2 Eigenschaften

- **Rundlauf:** VRL entpacken nach VB = `$5000`; je Bild `render_image` unbeschnitten an (x0, y0) = (10, 20) auf Zufallshintergrund = Erwartungsbild (deckende Pixel aus der Quelle, Rest Hintergrund).
- **Beschneiden:** je Bild alle Ausschnitte mit L, R ∈ {0, 1, w/2, w − 1, w} und T, B ∈ {0, 1, h − 1, h} (nicht leer): Ergebnis = Erwartungsbild nur im Ausschnitt, Hintergrund überall sonst (insbesondere **kein Byte außerhalb** des Ausschnitts verändert, Prüfung über das ganze 64-KB-Feld); neue Liste nur mit Typ 1/3/8, Typ 3 nie am Ende, nie zwei Typ 3 hintereinander; Summe aller verbrauchten Bytes ≤ Randbytes.
- **Unbeschnitten** = Liste bytegleich mit der gespeicherten.
- **Kerne:** srcstep-Regel 6.1 (Typ 2 bleibt Typ 2 bei voller Breite, auch mit T > 0).
- **Index:** `lookup` für alle (f, a, d) inkl. f ≥ NP, `$FF` → Phase 0, `$FE`, angle_map-Standards je NA, `$FF`-Objektrichtung → a = 0.
- **Aseprite:** Slice mit/ohne Pivot, Key-Auswahl je Frame, ohne Slice (bbox), leere Cel, unbekannte Ebene (Info), ai ≥ NA → Fehler, `trimmed` → Fehler, `json-hash` und `json-array`.
- **Byte-Raster:** box.x ungerade → x_e, Fußpunkt-Rundung mit Info.
- **Spiegeln, Ableiten:** gespiegeltes Bild = horizontal gespiegelte Pixel; abgeleitete Größe nach 5.4.
- **Format:** Kopf, Offsets lückenlos, Länge, CRC, U = VRL; `from_s2(to_s2(x))` = x; Determinismus (zweimal gebaut = gleiche Bytes); Grenzen 4.7.
- **VMS-Formatregeln 4.6** für alle erzeugten Listen.
- **CLI** über `subprocess`; Formatfehler → Exitcode 1 ohne Traceback.

Laufzeit < 60 s.

## 10. Abnahme

- `tools/dbespr.py`, `tools/dbesprdemo.py`, `test/tools/test_dbespr.py` grün; `dbetex.sim_vms` mit Typ 3 (bestehende P5-Tests grün).
- Beispiele in `docs/specs/examples/spr/` mit Bericht.
- `docs/formats.md` erhält „S2 v1“ (4.1–4.6, kurz).
