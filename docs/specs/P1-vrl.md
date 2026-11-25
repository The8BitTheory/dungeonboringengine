# P1: VRL – RLE-Strom für `RXV`, Werkzeug `tools/vrl.py`

Stand: 2026-11-25. Detailspezifikation zu Schritt P1 aus `docs/plan-0.2.md` (Abschnitt 6). Umsetzung: Sonnet. Review: Opus. Abhängigkeiten: nur Python-Standardbibliothek (≥ 3.11).

## 1. Zweck

VRL beschreibt, was `RXV src,dst` (VDC-BASIC v3, P2b) ins VRAM schreibt: Literale, Läufe und Lücken (Skip). Einsatz:

- Assets dicht in den VRAM-Pool entpacken (keine Skips).
- Rechtecke mit Stride direkt in einen Bildpuffer schreiben (Skip am Zeilenende).
- Bilder mit Transparenz pro Byte (Skip über transparente Bytes).

Transparenz pro **Pixel** (ein Nibble) kann VRL nicht; das bleibt `VMS` Typ 8 (P5 entscheidet je Byte, ob es in VRL geschrieben, übersprungen oder per `VMS` gezeichnet wird).

## 2. Token

Alle Wörter Low/High.

| Byte b | Folgebytes | Bedeutung | Länge im Strom |
|---|---|---|---|
| `$00` | – | Ende | 1 |
| `$01–$7F` | n = b Bytes | n Literale (1 … 127) an das Ziel schreiben | 1 + n |
| `$80–$FD` | v | Lauf: L = b − `$80` + 2 (2 … 127) mal v | 2 |
| `$FE` | lo, hi | Skip: Ziel um n = hi·256 + lo weiter, nichts schreiben; n = 0 bedeutet 65536 | 3 |
| `$FF` | lo, hi, v | langer Lauf: L = hi·256 + lo mal v; L = 0 bedeutet 65536 | 4 |

- Das Ziel ist ein Byte-Zeiger in den VRAM, der nach jedem geschriebenen oder übersprungenen Byte um 1 weiterläuft (16 Bit, Überlauf von `$FFFF` nach `$0000` ist ein Fehler des Erzeugers; der Encoder verhindert ihn über die entpackte Länge, 4.4).
- **Decoder (`RXV`, Information für P2b):** Literale per CPU über Reg 31; Lauf mit L < T per CPU, mit L ≥ T per Block fill (erstes Byte per CPU, Reg 30 = L − 1, bei L > 256 in Stücken zu 256); Skip setzt Reg 18/19 neu. Nach einem Block fill steht Reg 18/19 bereits hinter dem Ende, es ist keine neue Adresse nötig. T kommt aus P0.
- Der Decoder muss jede gültige Tokenfolge annehmen, auch solche, die der Encoder nie erzeugt (z. B. `$FF` mit L = 1, zwei Läufe hintereinander mit gleichem Wert, Skip direkt vor dem Ende).

## 3. Dateirahmen

Eine VRL-Datei ist eine PRG-Datei:

| Offset | Größe | Inhalt |
|---|---|---|
| 0 | 2 | Ladeadresse (Standard `$2000`, `--load`) |
| 2 | 2 | `"V" "R"` (`$56 $52`) |
| 4 | 1 | Version = 1 |
| 5 | 2 | entpackte Länge U (Wort, 0 … 65535) |
| 7 | … | Strom (Token bis einschließlich `$00`) |

- **U** = Anzahl Zielbytes vom Start bis hinter das letzte geschriebene Byte, also Summe aller Literal-, Lauf- und Skip-Längen. Ein Skip am Ende wird nicht kodiert (4.3) und zählt nicht mit. U > 65535 ist ein Fehler.
- Nach der Ladeadresse beginnt der Kopf; der Strom liegt bei Ladeadresse + 5. Aufruf in BASIC: `BLOAD"BILD.VRL",B0,P(BE):RXV BE+5,ZIEL` (Vorschlag; ob `RXV` stattdessen den Kopf selbst prüft, entscheidet P2b, siehe `review-notes.md`).
- Rohe Ströme ohne Kopf (z. B. eingebettet in DTS, P5): `--raw`.

## 4. Encoder

### 4.1 Eingabe

Eine Folge von Zielpositionen; jede ist entweder ein Bytewert 0–255 (schreiben) oder **`SKIP`** (`None`: nicht schreiben, Zielinhalt bleibt). Für `encode_rect` wird die Folge aus Rechteck, Stride und Maske gebildet (4.5).

### 4.2 Größenoptimal

Der Encoder sucht unter allen gültigen Tokenfolgen eine mit minimaler Stromlänge. Verfahren: dynamische Programmierung rückwärts über die Positionen i = n … 0.

`best[i]` = (Bytes, Token) minimal für den Rest ab i; Vergleich lexikographisch (erst Bytes, dann Anzahl Token). Übergänge ab Position i:

| Übergang | Bedingung | Kosten (Bytes) | weiter bei |
|---|---|---|---|
| Skip k | Positionen i … i+k−1 sind `SKIP`; k = ganze Skip-Strecke ab i | 3 | i + k |
| Lauf L | Positionen i … i+L−1 gleich, kein `SKIP`; L ∈ {2 … min(127, R)}, dazu L = R, wenn R > 127 (R = Länge der Wiederholung ab i) | 2 für L ≤ 127, sonst 4 | i + L |
| Literal n | Positionen i … i+n−1 ohne `SKIP`; 1 ≤ n ≤ 127 | 1 + n | i + n |

- Eine `SKIP`-Strecke wird immer ganz übersprungen (es gibt keine Alternative), Läufe und Literale enden spätestens vor dem nächsten `SKIP`.
- Läufe der Länge 2 sind erlaubt; die DP nimmt sie nur, wenn sie wirklich kürzer sind (z. B. allein stehendes Paar zwischen Skips). Läufe ab 3 sind nie länger als die gleichen Bytes im Literal; ob sie gewählt werden, entscheidet ebenfalls die DP.
- **Gleichstand** (gleiche Bytes und Token): Beim Aufbau von vorne (Rekonstruktion ab i = 0) wird unter den optimalen Übergängen der gewählt, der **die meisten Positionen abdeckt**; bei gleicher Abdeckung Lauf vor Literal. Damit ist die Ausgabe eindeutig.
- Lange Läufe 128 … R − 1 müssen nicht geprüft werden: Der lange Lauf über die ganze Wiederholung kostet dieselben 4 Byte und lässt keinen Rest. Kurze Läufe ≤ 127 dagegen schon (Beispiel `[7]*128 + [1,2]` → `FD 07 03 07 01 02 00`, kürzer als der lange Lauf).
- Laufzeit: O(n × 127), alle Hilfstabellen (Wiederholungslänge, Skip-Länge, längstes Literal ab i) vorab rückwärts in O(n) berechnen – eine Schleife je Position über die Skip-Strecke macht den Encoder quadratisch. Ziel: 64 KB in unter 10 s (CPython).

### 4.3 Skips

- Führende Skips werden kodiert (Zielversatz am Anfang).
- **Skips am Ende werden weggelassen**: Der Strom endet nach dem letzten geschriebenen Byte mit `$00`.
- Wegen U ≤ 65535 (4.4) ist jeder kodierte Skip ≤ 65534 und jeder Lauf ≤ 65535; die Formen mit Länge 0 (= 65536) erzeugt der Encoder nie, der Decoder nimmt sie an.
- Eine Folge nur aus `SKIP` ergibt den Strom `$00` und U = 0.

### 4.4 Grenzen

- U ≤ 65535, sonst `ValueError("VRL: entpackte Länge über 65535")`.
- Werte außerhalb 0 … 255 → `ValueError`.

### 4.5 Rechteck mit Stride und Maske

`encode_rect(data, width, height, stride, mask=None)`:

- `data`: `width × height` Bytes, zeilenweise.
- `mask`: `None` (alles schreiben) oder Folge gleicher Länge; wahr/≠ 0 = schreiben, 0/falsch = `SKIP`.
- Zielfolge: Zeile r beginnt bei r × stride. Zwischen Zeilenende (r × stride + width) und nächster Zeile liegen stride − width `SKIP`-Positionen; sie verschmelzen mit maskierten Bytes am Zeilenende und -anfang zu einem Skip.
- Bedingungen: width ≥ 1, height ≥ 1, stride ≥ width, sonst `ValueError`. stride ≤ 65535.
- Das Ergebnis ist der Strom; die Startadresse (Ziel des ersten Bytes, Zeile 0, Spalte 0) übergibt der Aufrufer an `RXV`. Ist das erste Byte maskiert, beginnt der Strom mit einem Skip.

## 5. Decoder

`decode(stream, base=None)`:

- Liest Token bis `$00`. Liefert `bytearray`: Kopie von `base` (oder leer), bei Bedarf mit 0 auf U verlängert; geschriebene Positionen überschrieben, übersprungene unverändert.
- Fehler (`ValueError` mit Byte-Offset im Strom): Ende ohne `$00` („unerwartetes Ende bei Offset n“), Literal/Lauf über das Stromende hinaus, Ziel über 65536 hinaus.
- `decode_tokens(stream)` liefert die Token als Liste `Token(kind, length, value, offset)`; `kind` ∈ `"lit"`, `"run"`, `"lrun"`, `"skip"`, `"end"`; `value` bei `lit` die Bytes, bei Läufen der Wert, sonst `None`; `offset` = Position im Strom.

## 6. Python-API (`tools/vrl.py`)

```python
SKIP = None
VERSION = 1

def encode(data) -> bytes                       # Folge aus int | None; Strom inkl. $00
def encode_rect(data, width, height, stride, mask=None) -> bytes
def decode(stream, base=None) -> bytearray
def decode_tokens(stream) -> list[Token]
def unpacked_length(stream) -> int              # U
def pack_file(stream, load=0x2000) -> bytes      # PRG mit Kopf (U aus dem Strom)
def unpack_file(data) -> tuple[int, int, int, bytes]   # (load, version, U, stream); prüft "VR", Version, U;
                                                       # stream endet mit dem ersten Ende-Token, Bytes danach werden ignoriert
def threshold(params) -> int                     # T aus dem Kostenmodell (8.2)
def load_bench(path) -> dict                     # Schlüssel "engine" aus der P0-JSON
def stats(stream, T=None, params=None) -> dict
```

`encode(b"")` → `b"\x00"`. `bytes`, `bytearray` und Listen sind als Eingabe erlaubt.

## 7. CLI

```
vrl.py encode IN OUT [--load ADDR] [--raw] [--in-prg]
vrl.py rect   IN OUT --width W --height H --stride S [--mask MASK] [--load ADDR] [--raw] [--in-prg]
vrl.py decode IN OUT [--raw] [--base BASE] [--out-prg ADDR]
vrl.py stats  IN [--raw] [-T N] [--bench P0.json] [--json]
```

- `--in-prg`: Eingabedatei hat 2 Byte Ladeadresse, die übersprungen werden.
- `--mask`: Datei mit width × height Bytes (≠ 0 = schreiben).
- `decode` schreibt U Bytes (bzw. `len(base)`, falls größer); mit `--out-prg` als PRG.
- `stats` gibt eine Tabelle aus (8.1); mit `--json` als JSON.
- Ladeadressen als Zahl mit Präfix (`0x2000`, `$2000` und `8192` werden akzeptiert).
- Exitcode 0 = ok, 1 = Formatfehler (Meldung auf stderr, ohne Traceback), 2 = falscher Aufruf (argparse).

## 8. Statistik und Zyklenschätzung

### 8.1 `stats` liefert

| Schlüssel | Inhalt |
|---|---|
| `stream_bytes` | Länge des Stroms |
| `unpacked` | U |
| `written` | geschriebene Bytes (Literale + Läufe) |
| `skipped` | übersprungene Bytes |
| `ratio` | `stream_bytes / written` |
| `tokens` | Anzahl je Art (`lit`, `run`, `lrun`, `skip`) |
| `bytes_by_kind` | geschriebene Bytes je Art (`lit`, `run_cpu`, `run_fill`) bei Schwelle T |
| `run_hist` | Läufe nach Länge in Klassen 2, 3–4, 5–8, 9–16, 17–32, 33–64, 65–128, 129–256, > 256 |
| `T` | verwendete Schwelle |
| `cycles` | geschätzte Zyklen (8.2), gerundet |

### 8.2 Kostenmodell (CPU-Zyklen bei 2 MHz)

| Parameter | Bedeutung | Platzhalter bis P0 |
|---|---|---|
| `tok` | Token lesen und verzweigen | 30 |
| `cpu_lit_byte` | Literalbyte per CPU | 22 |
| `cpu_byte` | Laufbyte per CPU | 15 |
| `cpu_run_fixed` | Laufbeginn per CPU | 10 |
| `new_addr` | Skip (Reg 18/19 neu) | 80 |
| `fill_fixed` | Block fill bis fertig, fester Anteil | 200 |
| `fill_byte` | Block fill je Byte | 1 |
| `fill_chunk` | jedes weitere 256er-Stück eines langen Laufs | 30 |

```
cycles = Σ Token außer Ende: tok
       + Literal n:            n · cpu_lit_byte
       + Lauf L, L < T:        cpu_run_fixed + L · cpu_byte
       + Lauf L, L ≥ T:        fill_fixed + L · fill_byte + (ceil(L/256) − 1) · fill_chunk
       + Skip:                 new_addr
```

`threshold(params)` = kleinstes L ≥ 2 mit `fill(L') < cpu(L')` für alle L' ∈ [L, 65536]; da beide linear sind, genügt: kleinstes L ≥ 2 mit `fill(L) < cpu(L)` und `fill_byte < cpu_byte`, sonst 65537. Mit den Platzhaltern: T = 14 (L = 14: fill 214 < CPU 220; L = 13: fill 213 > CPU 205).

`stats(stream, T=None, params=None)`: fehlende Parameter aus den Platzhaltern; T = `threshold(params)`, wenn nicht angegeben. `load_bench(path)` liest `engine` aus der P0-JSON (`docs/v3/P0-bench.md`, Abschnitt 10.4); dort fehlende Schlüssel bleiben Platzhalter; `T` aus der Datei wird übernommen, wenn vorhanden (Rückgabe: Parameter-Dict inkl. optional `T`; unbekannte Schlüssel werden ignoriert). `stats` nimmt `T` aus `params`, wenn das Argument `T` fehlt.

## 9. Tests (`test/tools/test_vrl.py`, unittest)

Aufruf: `python3 -m unittest discover -s test/tools -v` im Repo-Wurzelverzeichnis. Der Test fügt `<repo>/tools` zu `sys.path` hinzu. Kein pytest (nicht installiert).

### 9.1 Feste Vektoren (Strom ohne Dateirahmen)

Alle Vektoren sind mit einem Prototyp nach 4.2 nachgerechnet.

| Eingabe | Erwarteter Strom |
|---|---|
| `[]` | `00` |
| `[5]` | `01 05 00` |
| `[7,7]` | `80 07 00` |
| `[7]*3` | `81 07 00` |
| `[7]*127` | `FD 07 00` |
| `[7]*128` | `FF 80 00 07 00` |
| `[7]*65535` | `FF FF FF 07 00` |
| `[7]*65536` | Fehler: U = 65536 > 65535 |
| `[7]*128 + [1,2]` | `FD 07 03 07 01 02 00` |
| `[1,2,3]` | `03 01 02 03 00` |
| `[1,1,1,2]` | `81 01 01 02 00` |
| `[1,1,2,2,3]` | `05 01 01 02 02 03 00` (gleich lang wie zwei Läufe + Literal, weniger Token) |
| `list(range(128))` | `7F 00 01 … 7E 01 7F 00` (131 Byte; 127 + 1, längste Abdeckung zuerst) |
| `[None, 5]` | `FE 01 00 01 05 00` |
| `[5, None]` | `01 05 00` |
| `[None]*3` | `00` |
| `[5, None, None, 5]` | `01 05 FE 02 00 01 05 00` |
| `[None]*65534 + [1]` | `FE FE FF 01 01 00` |
| `[None]*65535 + [1]` | Fehler: U = 65536 > 65535 |
| `[None]*70000` | `00` (Skip am Ende entfällt) |
| `[9,9,None,9,9]` | `80 09 FE 01 00 80 09 00` |

`encode_rect`:

| Aufruf | Erwarteter Strom |
|---|---|
| `encode_rect([1,2,3,4], 2, 2, 80)` | `02 01 02 FE 4E 00 02 03 04 00` |
| `encode_rect([5]*8, 4, 2, 4)` | `86 05 00` (Stride = Breite: ein Lauf über beide Zeilen) |
| `encode_rect([5,5,5,5], 4, 1, 4, mask=[1,0,0,1])` | `01 05 FE 02 00 01 05 00` |
| `encode_rect([1,2,3,4], 2, 2, 10, mask=[1,0,0,1])` | `01 01 FE 0A 00 01 04 00` (Skip = 1 + 8 + 1) |
| `encode_rect([1,2], 2, 1, 80, mask=[0,0])` | `00` |
| `encode_rect(..., stride=1, width=2)` | `ValueError` |

### 9.2 Eigenschaften

- **Rundlauf:** Für 2000 Zufallsfolgen (Seed fest, `random.Random(1)`; Länge 0 … 600; Alphabet je Folge zufällig aus {2 Werte, 5 Werte, 256 Werte}; `SKIP`-Anteil 0 %, 10 % oder 50 %; lange Läufe eingestreut) gilt `decode(encode(x), base)` == erwartetes Bild (geschriebene Positionen = Wert, `SKIP` = `base`; `base` = Zufallsbytes der Länge U + 5).
- **Optimalität:** Für 300 kurze Zufallsfolgen (Länge ≤ 12, Alphabet {0,1,2}, `SKIP` erlaubt) ist `len(encode(x))` gleich dem Minimum einer im Test unabhängig geschriebenen erschöpfenden Suche (Rekursion über alle Tokenaufteilungen, ohne die DP-Hilfsfunktionen von `vrl.py`).
- **Determinismus:** zweimal kodiert = gleiche Bytes.
- **Grenzen:** Literal 127/128, Lauf 127/128/129, 255/256/257, 65534/65535 (Länge und Rundlauf), Skip 65533/65534 mit nachfolgendem Byte (Rundlauf), U = 65536 → Fehler.
- **Decoder-Fehler:** `b""`, `b"\x03\x01"` (Literal abgeschnitten), `b"\x81"`, `b"\xFE\x01"`, `b"\xFF\x00\x00"`, `b"\x01\x05"` (kein Ende) → `ValueError`.
- **Decoder nimmt Fremdes an:** `FF 01 00 07 00` → `[7]`; `80 07 80 07 00` → `[7]*4`; `FE 05 00 00` → U = 5, nichts geschrieben.
- **Datei:** `unpack_file(pack_file(s, 0x3000))` == `(0x3000, 1, U, s)`; falsches Magic, Version 2, U ungleich Strom → `ValueError`.
- **stats:** für `[7]*300 + [1,2,3] + [None]*10 + [4]` (Strom `FF 2C 01 07 03 01 02 03 FE 0A 00 01 04 00`): `tokens` = `{"lrun":1, "lit":2, "skip":1, "run":0}`, `written` = 304, `skipped` = 10, `unpacked` = 314; mit T = 15 (oder 14) und Platzhaltern `cycles` = 4·30 + (200 + 300 + 30) + 3·22 + 80 + 1·22 = 818.
- **threshold:** Platzhalter → 14; `fill_byte ≥ cpu_byte` → 65537; `load_bench` mit einer im Test erzeugten JSON überschreibt nur vorhandene Schlüssel.
- **CLI:** `encode`/`decode` über `subprocess` mit temporären Dateien (`tempfile.TemporaryDirectory`), Rundlauf bytegleich; `stats --json` ist gültiges JSON; Formatfehler → Exitcode 1 ohne Traceback.

## 10. Grenzfälle (Zusammenfassung)

| Fall | Verhalten |
|---|---|
| leere Eingabe, nur Skips | Strom `00`, U = 0 |
| Skip am Anfang | kodiert |
| Skip am Ende | weggelassen |
| Skip ≥ 65535 vor Daten, Lauf ≥ 65536 | nicht möglich (U ≤ 65535) |
| U > 65535 | Fehler |
| Wert 0 als Daten | normal (Token `$00` steht nur an Tokenposition) |
| Literal mit einem Byte zwischen zwei Läufen | DP entscheidet (`[1,1,1,2,3,3,3]` → `81 01 01 02 81 03 00`) |
| stride = width | Zeilen verschmelzen, kein Skip |
| Maske komplett 0 | Strom `00` |

## 11. Abnahme

- `tools/vrl.py` mit Docstring im Stil von `tools/wallconv.py` (Format kurz beschrieben, Aufruf).
- Alle Tests in `test/tools/test_vrl.py` grün, Laufzeit der Testdatei < 30 s.
- `docs/formats.md` bekommt den Abschnitt „VRL v1“ (Tokentabelle 2, Dateirahmen 3) – kurz, mit Verweis auf diese Spezifikation.
