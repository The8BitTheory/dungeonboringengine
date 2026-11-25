# P4: Karte – DMP, `tools/dbemap.py`, `tools/crawlmap.py`

Stand: 2026-11-25. Detailspezifikation zu Schritt P4 aus `docs/plan-0.2.md` (Abschnitt 6) und `engine-design.md` 5.1. Umsetzung: Sonnet. Review: Opus. Abhängigkeiten: Python ≥ 3.11 (`tomllib`), für `--d81` das VICE-Werkzeug `c1541`.

## 1. Begriffe

- Zelle (x, y), Zellindex i = y · W + x. Richtungen 0 = N, 1 = O, 2 = S, 3 = W; Norden = kleineres y.
- **Kachel**: Eintrag der Kacheltabelle (Aussehen und Eigenschaften). Die Kachelebene sagt je Zelle, welche Kachel dort liegt.
- **Inhalt**: Gegenstand und Automap-Bits je Zelle.
- **Stilnummer** in DMP: 0 = nichts, n ≥ 1 = Stil n − 1 im zugehörigen DTS (Wand-, Boden- bzw. Decken-Texturset, P5).

## 2. DMP-Format (Version 1)

PRG-Datei: 2 Byte Ladeadresse (Standard `$8000`, Bank 1), dann der Inhalt. Offsets relativ zum Inhalt. Wörter Low/High.

### 2.1 Kopf (24 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | `"D" "M"` (`$44 $4D`) |
| 2 | Version = 1 |
| 3 | W (1 … 255) |
| 4 | H (1 … 255) |
| 5 | NT: Anzahl Kacheln (1 … 256; 256 wird als 0 gespeichert) |
| 6–7 | NE: Anzahl Ereignisse |
| 8–9 | Startzelle (Zellindex) |
| 10 | Startrichtung (0–3) |
| 11 | Kachel für Zellen außerhalb der Karte (Index < NT) |
| 12–13 | Offset Kachelebene (= 24) |
| 14–15 | Offset Inhaltsebene (= 24 + W·H) |
| 16–17 | Offset Kacheltabelle (= 24 + 2·W·H) |
| 18–19 | Offset Ereignisse (= Kacheltabelle + 8·NT) |
| 20–21 | Gesamtlänge des Inhalts (= Ereignisse + 4·NE) |
| 22–23 | reserviert 0 |

W · H ≤ 16384 (Fehler darüber; Warnung über 4096, weil die Lib die Karte in Bank 1 hält).

### 2.2 Kachelebene (W·H Byte)

Zeilenweise, ein Byte je Zelle: Kachelindex < NT. Statisch (ändert sich zur Laufzeit nur über eine eigene Lib-Funktion, z. B. Tür öffnen = andere Kachel).

### 2.3 Inhaltsebene (W·H Byte)

| Bit | Bedeutung |
|---|---|
| 0–5 | Gegenstand 0–63 (0 = keiner); Zuordnung zu einem Sprite-Satz über `ITEMSET` wie in 0.1 |
| 6 | Automap: gesehen (Laufzeit; in der Datei normalerweise 0) |
| 7 | Automap: Marke (Laufzeit oder vom Kartenautor vorbelegt) |

Ein Gegenstand je Zelle; er liegt auf Unterposition **Mitte** (p = 2, siehe 2.6). Weitere Gegenstände an anderen Plätzen kommen über die Objektliste (P6).

### 2.4 Kacheltabelle (NT × 8 Byte)

| Offset | Inhalt |
|---|---|
| 0 | Wandstil Nordfläche |
| 1 | Wandstil Ostfläche |
| 2 | Wandstil Südfläche |
| 3 | Wandstil Westfläche |
| 4 | Bodenstil (0 = kein Boden: Tapete/Abgrund sichtbar) |
| 5 | Deckenstil (0 = keine Decke: Himmel/Tapete) |
| 6 | Flags |
| 7 | Automap-Zeichen (0 = Standard nach Flag AUTOMAP) |

Flags:

| Bit | Name | Bedeutung |
|---|---|---|
| 0 | WEG | versperrt den Weg (`MOVE`) |
| 1 | SICHT | versperrt die Sicht für die Spiellogik (Gegner sehen nicht hindurch) |
| 2 | DECKEND | `VIEW`: Flächen dieser Kachel decken ihre Spaltenbereiche ab (nur, wenn auch das Bild im DTS deckend ist); dahinter wird dann nicht mehr gezeichnet |
| 3 | TÜR | Tür (Spiellogik; `VIEW` behandelt sie wie jede Kachel mit Flächen) |
| 4 | AUTOMAP | auf der Automap als Wand zeichnen (sonst als Boden) |
| 5–7 | – | 0 |

Regeln für `VIEW` (P6):

- Eine Zelle hat **Flächen**, wenn mindestens einer der Wandstile ≠ 0 ist. Gezeigt wird je nach Lage (d, s) und Blickrichtung v:

  | Fläche im Sichtgitter | Kachelfläche |
  |---|---|
  | Front (der Spieler sieht auf sie) | (v + 2) AND 3 |
  | Seite, s < 0 (links) | (v + 1) AND 3 |
  | Seite, s > 0 (rechts) | (v + 3) AND 3 |

  Beispiel: Blick nach Norden, Block vorne → seine Südfläche; Block links → Ostfläche.
- Boden und Decke werden auch in Zellen mit Flächen gezeichnet (Gitter, Tür, Fenster in einer Zelle). Bei einer Kachel mit DECKEND und vier Wandstilen ≠ 0 sind Boden und Decke unsichtbar; `VIEW` behandelt solche Zellen bei der Lückenprüfung der Bänder nicht als Lücke (Inhalt der Felder egal, `dbemap` setzt 0).
- Zellen außerhalb der Karte verhalten sich wie die Kachel aus Kopf-Byte 11.

### 2.5 Ereignisse (NE × 4 Byte)

| Offset | Inhalt |
|---|---|
| 0–1 | Zellindex |
| 2 | Typ |
| 3 | Parameter |

Sortiert nach (Zellindex, Typ, Parameter); mehrere Ereignisse je Zelle erlaubt.

| Typ | Name | Parameter |
|---|---|---|
| 0 | – | ungültig |
| 1 | `gegner` | Startpunkt Gegner, Parameter = Gegnernummer |
| 2 | `teleport` | Gruppe; Ziel = die andere Zelle mit gleicher Gruppe |
| 3 | `ausgang` | 0 = geschlossen, 1 = offen |
| 4 | `text` | Textnummer (Spiel) |
| 5–127 | – | reserviert für die Engine |
| 128–255 | – | frei für das Spiel, Parameter beliebig |

Der Startpunkt des Spielers steht im Kopf, nicht als Ereignis.

### 2.6 Unterpositionen (Konvention für Objektliste und Gegenstände)

In der Karte und der Objektliste stehen Unterpositionen **absolut**: q = 0 NW, 1 NO, 2 SW, 3 SO, 4 Mitte. `VIEW` rechnet sie mit der Blickrichtung v in die Zeichenposition p der Geometrie (P3, 3.3: 0 hinten links, 1 hinten rechts, 2 Mitte, 3 vorne links, 4 vorne rechts) um:

| v | NW | NO | SW | SO | Mitte |
|---|---|---|---|---|---|
| 0 N | 0 | 1 | 3 | 4 | 2 |
| 1 O | 3 | 0 | 4 | 1 | 2 |
| 2 S | 4 | 3 | 1 | 0 | 2 |
| 3 W | 1 | 4 | 0 | 3 | 2 |

(Probe: Blick nach Osten, „hinten“ = Osthälfte, „links“ = Norden → NO = hinten links = 0.)

## 3. Textformat für `dbemap.py` (TOML)

```toml
format  = "dbemap"
version = 1

[map]
name    = "demo"
start   = [2, 1]        # x, y
dir     = "O"           # N, O, S, W
outside = "wand"        # Kachelname für Zellen außerhalb

[tiles.wand]            # Reihenfolge der Tabellen = Kachelindex (0, 1, …)
walls   = 1             # alle vier Flächen Stil 1; oder [N, O, S, W]
floor   = 0
ceiling = 0
flags   = ["weg", "sicht", "deckend", "automap"]

[tiles.gang]
floor   = 1
ceiling = 1

[tiles.himmel]
floor   = 1             # ceiling fehlt = 0: Himmel

[tiles.gitter]
walls   = 2
floor   = 1
ceiling = 1
flags   = ["weg"]       # nicht deckend: dahinter sichtbar
automap_char = 35

[legend]
"#" = "wand"
"." = "gang"
"," = "himmel"
"+" = "gitter"
"m" = { tile = "gang", item = 2 }
"T" = { tile = "gang", events = [{ type = "teleport", param = 1 }] }
"X" = { tile = "gang", events = [{ type = "ausgang", param = 0 }] }

[layers]
tiles = """
#######
#..m..#
#.,,+.#
#T...X#
#######
"""

[[events]]              # zusätzliche Ereignisse an Koordinaten
at    = [3, 1]
type  = "gegner"        # Name aus 2.5 oder Zahl
param = 1

[[marks]]               # optional: Automap-Marke (Bit 7) vorbelegen
at = [1, 1]
```

Regeln:

- Kachelschlüssel: `walls` (Zahl oder Liste mit 4 Zahlen, 0 … 255, Standard 0), `floor`, `ceiling` (0 … 255, Standard 0), `flags` (Liste aus `weg`, `sicht`, `deckend`, `tuer`, `automap`), `automap_char` (0 … 255), `index` (optional: feste Nummer; dann müssen alle Kacheln `index` haben, Lücken werden mit Nullkacheln gefüllt, NT = höchster Index + 1).
- Legende: Schlüssel genau ein Zeichen (kein Leerzeichen); Wert ist ein Kachelname oder eine Tabelle mit `tile` (Pflicht), `item` (0 … 63), `events` (Liste aus Tabellen mit `type`, `param`).
- `layers.tiles`: Zeilen gleicher Länge = W, Anzahl = H. Eine leere erste/letzte Zeile (durch `"""`) wird ignoriert; Leerzeichen am Zeilenende sind ein Fehler (unsichtbar, meist Versehen).
- `start` muss auf einer Kachel ohne WEG liegen.
- Fehlermeldungen nennen Datei, Zeile/Spalte in der Karte bzw. den Schlüssel (z. B. `demo.toml: Karte Zeile 3, Spalte 5: Zeichen 'q' nicht in der Legende`). Exitcode 1.

## 4. `tools/dbemap.py`

### 4.1 CLI

```
dbemap.py build MAP.toml OUT.dmp [--load ADDR]
dbemap.py dump  IN.dmp [--toml OUT.toml]       # ohne --toml: Textübersicht auf stdout
dbemap.py check MAP.toml
```

`dump --toml` erzeugt eine TOML-Datei, die mit `build` wieder bytegleich dieselbe DMP ergibt. Kachelnamen `k<index>` (z. B. `k0`), Kacheln mit `index = …`; Legende: je vorkommendes Paar (Kachel, Gegenstand) ein Zeichen aus dem Vorrat `#.0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!$%&*+-/:;<=>?@^_~|` in der Reihenfolge (Kachel, Gegenstand) aufsteigend; mehr Paare als Zeichen → Fehler „zu viele Kombinationen für eine ASCII-Karte“. Ereignisse als `[[events]]` mit `at`, Marken als `[[marks]]`. Der Schreiber ist eigener Code (keine TOML-Schreibbibliothek nötig); Strings mit `"` und `\` korrekt maskieren.

### 4.2 Python-API

```python
@dataclass
class Tile: walls: tuple[int,int,int,int]; floor: int; ceiling: int; flags: int; automap_char: int; name: str = ""
@dataclass
class Event: cell: int; type: int; param: int
@dataclass
class Map:
    name: str; width: int; height: int
    tiles: list[Tile]; cells: list[int]; content: list[int]; events: list[Event]
    start: int; direction: int; outside: int

FLAGS = {"weg": 1, "sicht": 2, "deckend": 4, "tuer": 8, "automap": 16}
EVENT_TYPES = {"gegner": 1, "teleport": 2, "ausgang": 3, "text": 4}
SUBPOS_VIEW = [[0,1,3,4,2], [3,0,4,1,2], [4,3,1,0,2], [1,4,0,3,2]]   # [v][q] -> p (2.6)

def load_toml(path) -> Map
def to_dmp(m: Map, load=0x8000) -> bytes
def from_dmp(data: bytes) -> Map            # prüft Magic, Version, Offsets, Länge, Indizes
def to_toml(m: Map) -> str
def validate(m: Map) -> None                # ValueError mit Meldung
def face(view_dir: int, s: int, front: bool) -> int   # Kachelfläche nach 2.4
```

## 5. `tools/crawlmap.py` – Konverter aus Crawl 128

### 5.1 Quelle `CRAWL128.CD1`

Liegt nicht als Datei im Repo dungeoncrawlerjam2025, sondern auf dessen Disk-Images: `game/crawl.d81` (Entwicklungsdisk), ebenso `crawl128-100f.d81` und `game/blitzcrawl.d81`; Dateiname auf der Disk `crawl128.cd1`. Auslesen: `c1541 -attach game/crawl.d81 -read crawl128.cd1 crawl128.cd1`. Erzeugt von `game/mapgen.bas`.

Aufbau (PRG, Ladeadresse `$213C` = `BE` beim Speichern, ohne Bedeutung):

| Offset (nach Ladeadresse) | Inhalt |
|---|---|
| 0 | OS: Offset der Kartendaten (Crawl: 14) |
| 1 | W (Crawl: 20) |
| 2 | H (Crawl: 11) |
| 3–4 | Anzahl Edelsteine (Crawl: 92) |
| 5 … OS − 1 | Datensätze zu 3 Byte: Zeichen (ASCII), Zellindex (Wort) |
| OS … OS + W·H − 1 | Karte, 1 Byte je Zelle: Wert = ASCII − 48 des Zeichens aus den DATA-Zeilen |
| danach | Kartenname als ASCII (`CRAWL128`) |

Zellwerte (`crawl.bas`, Kommentar ab Zeile 11019, und tatsächliche Werte): ungerade = nicht begehbar (Bit 0 = Wand; 1 Wand, 3 Wand Gegnerhöhle, 5 Tür Gegnerhöhle), 0 leer, 2 Edelstein, 4 Kraft-Edelstein, 6 Startpunkt, 8 Teleport, 18 (`B`) Start Geist 1, 40 (`X`) Ausgang geschlossen, 42 (`Z`) Ausgang offen. Datensätze: `6` Spielerstart, `8` Teleport, `B` Geist 1, `X` Ausgang. Die Karte im Repo enthält die Werte 0, 1, 2, 4, 6, 18, 40 (Zähler: 3, 120, 92, 2, 1, 1, 1) und die Datensätze `X` → 29, `B` → 68, `6` → 198.

### 5.2 Abbildung (verlustfrei)

- **Kachelindex = Crawl-Zellwert** (die Spiellogik von Crawl vergleicht Zellwerte; `CELL` liefert so dieselben Zahlen). NT = größter vorkommender Wert + 1; nicht vorkommende Indizes = Nullkachel.
- Kachel für vorkommende Werte v:

  | v | walls | floor | ceiling | flags | automap_char |
  |---|---|---|---|---|---|
  | ungerade | 1 (alle vier) | 0 | 0 | weg, sicht, deckend, automap | 0 |
  | gerade | 0 | 0 | 0 | – | 0 |

  Crawl hat keine Boden- und Deckentexturen (schwarz, wie 0.1 mit Clear). Option `--floor N --ceiling N` setzt sie für gerade Werte.
- Inhalt: Gegenstand = v für v ∈ `--items` (Standard `2,4`), sonst 0. Automap-Bits 0.
- Start: Zelle aus Datensatz `6`, Richtung 0 (N; `crawl.bas` 3870 `PF%(0)=0`). Fehlt `6` → Fehler (wie `crawl.bas` 82).
- Ereignisse aus den Datensätzen: `8` → `teleport` Gruppe 1 (alle Teleporter von Crawl bilden eine Gruppe), `B` → `gegner` 1, `D` → `gegner` 2, `F` → `gegner` 3, `H` → `gegner` 4, `X` → `ausgang` 0, `Z` → `ausgang` 1. Unbekanntes Zeichen c → Typ 255, Parameter = ASCII-Code, Warnung.
- Außerhalb: Kachel 1 (Wand; Crawl: Zellen außerhalb zählen als Wand).
- Prüfungen mit Warnung (kein Abbruch): Anzahl Zellen mit Wert 2 ≠ Kopf-Edelsteinzahl; Datensatz-Zelle ≥ W·H (dann Fehler); Kartenname ≠ ASCII.
- `--toml`: zusätzlich Textform; Legende: Zeichen = `chr(48 + v)` (die Zeichen aus `mapgen.bas`, z. B. `B`, `X`), für Zellen mit Gegenstand dasselbe Zeichen (Gegenstand = Wert). Für v > 78 Fehler.

### 5.3 CLI

```
crawlmap.py CRAWL128.CD1 OUT.dmp [--toml OUT.toml] [--load ADDR] [--items 2,4] [--floor N] [--ceiling N]
crawlmap.py --d81 IMAGE.d81 OUT.dmp [...]       # liest crawl128.cd1 per c1541 in ein temporäres Verzeichnis
```

Ausgabe auf stdout: Größe, Anzahl Kacheln, Gegenstände, Ereignisse, Start.

## 6. Tests (`test/tools/test_dbemap.py`, `test/tools/test_crawlmap.py`, unittest)

Testdaten: `test/tools/data/crawl128.cd1` (Kopie aus `game/crawl.d81`, 244 Byte inklusive Ladeadresse; das Repo dungeoncrawlerjam2025 steht unter MIT-Lizenz – Herkunft in `test/tools/data/README.md` vermerken). Kein Test greift auf fremde Repos oder `c1541` zu, außer `test_d81` (wird übersprungen, wenn `c1541` oder das Image fehlt: `unittest.skipUnless`).

### 6.1 dbemap

- Beispiel aus Abschnitt 3 bauen: W = 7, H = 5, NT = 4, NE = 3 (Teleport bei (1,3), Ausgang bei (5,3), Gegner bei (3,1)), Start = 1·7 + 2 = 9, Richtung 1; Zelle (3,1) hat Kachel 1 und Gegenstand 2; Kachel `wand` = `01 01 01 01 00 00 17 00`, `gitter` = `02 02 02 02 01 01 01 23`. Kopf-Offsets 24 / 59 / 94 / 126, Gesamtlänge 138.
- Rundlauf: `from_dmp(to_dmp(m))` == m (bis auf Namen); `to_dmp(load_toml(to_toml(from_dmp(d))))` == d für das Beispiel, die Crawl-Karte und 50 Zufallskarten (Seed fest, W, H 1 … 40, bis 12 Kacheln, Gegenstände, Ereignisse).
- Ereignisse sortiert nach (Zelle, Typ, Parameter).
- Fehlerfälle (je eine kleine TOML im Test): unbekanntes Zeichen (Meldung mit Zeile/Spalte), ungleiche Zeilenlängen, Start auf WEG-Kachel, `item = 64`, Stil 256, unbekanntes Flag, unbekannter Ereignistyp, W = 256, W·H > 16384, Leerzeichen am Zeilenende, `index` nur bei einem Teil der Kacheln.
- `face`: alle 4 Richtungen × (Front, links, rechts) gegen Tabelle 2.4.
- `SUBPOS_VIEW`: jede Zeile ist eine Permutation von 0 … 4; Mitte immer 2; Drehung um 90° nach rechts (v + 1) verschiebt die Ecken NW → NO → SO → SW in der Weltsicht konsistent (Probe aus 2.6).
- `from_dmp`: falsches Magic, Version 2, Länge zu kurz, Kachelindex ≥ NT, Startzelle ≥ W·H → `ValueError`.

### 6.2 crawlmap

- `crawl128.cd1` → DMP: W = 20, H = 11, NT = 41, Start = 198, Richtung 0; Kacheln 0, 2, 4, 6, 18, 40 ohne Flags, Kachel 1 mit `$17`; Kachelebene = Crawl-Werte zellweise; Gegenstände: 92 Zellen mit 2, 2 mit 4; Ereignisse genau `(29, ausgang, 0)`, `(68, gegner, 1)`; außerhalb = 1.
- `--toml` → `dbemap build` → bytegleich mit der direkten DMP.
- Synthetische CD1 im Test erzeugt (3 × 2, Datensätze `6`, `8`, `8`, `Z`, unbekanntes `Q`): Teleport-Gruppe 1 zweimal, `ausgang` 1, Typ 255 mit Parameter 81 und Warnung; fehlendes `6` → Fehler.
- `test_d81`: `--d81 /home/martin/git/dungeoncrawlerjam2025/game/crawl.d81` ergibt dieselbe DMP wie die Testdatei.

## 7. Abnahme

- `tools/dbemap.py`, `tools/crawlmap.py` mit Docstrings im Stil von `wallconv.py`; Tests grün, Laufzeit < 30 s.
- Beispielkarte `docs/specs/examples/demo.toml` (Abschnitt 3) und daraus erzeugte `crawl128.toml` (aus `crawlmap --toml`) im Repo.
- `docs/formats.md` erhält „DMP v1“ (Tabellen 2.1–2.5, 2.6) und ersetzt den Abschnitt „Karte (vorläufig)“ durch einen Verweis.
