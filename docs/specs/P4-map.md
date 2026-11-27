# P4: Map – DMP, `tools/dbemap.py`, `tools/crawlmap.py`

As of 2026-11-25. Detailed specification for step P4 of `docs/plan-0.2.md` (section 6) and `engine-design.md` 5.1. Implementation: Sonnet. Review: Opus. Dependencies: Python ≥ 3.11 (`tomllib`), for `--d81` the VICE tool `c1541`.

## 1. Terms

- Cell (x, y), cell index i = y · W + x. Directions 0 = N, 1 = E (east), 2 = S, 3 = W; north = smaller y.
- **Tile**: entry of the tile table (appearance and properties). The tile layer says per cell which tile lies there.
- **Content**: item and automap bits per cell.
- **Style number** in DMP: 0 = nothing, n ≥ 1 = style n − 1 in the associated DTS (wall, floor or ceiling texture set, P5).

## 2. DMP format (version 1)

PRG file: 2 bytes load address (default `$8000`, bank 1), then the content. Offsets relative to the content. Words low/high.

### 2.1 Header (24 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"D" "M"` (`$44 $4D`) |
| 2 | version = 1 |
| 3 | W (1 … 255) |
| 4 | H (1 … 255) |
| 5 | NT: number of tiles (1 … 256; 256 is stored as 0) |
| 6–7 | NE: number of events |
| 8–9 | start cell (cell index) |
| 10 | start direction (0–3) |
| 11 | tile for cells outside the map (index < NT) |
| 12–13 | offset of tile layer (= 24) |
| 14–15 | offset of content layer (= 24 + W·H) |
| 16–17 | offset of tile table (= 24 + 2·W·H) |
| 18–19 | offset of events (= tile table + 8·NT) |
| 20–21 | total length of the content (= events + 4·NE) |
| 22–23 | reserved 0 |

W · H ≤ 16384 (error above that; warning above 4096, because the lib keeps the map in bank 1).

### 2.2 Tile layer (W·H bytes)

Row by row, one byte per cell: tile index < NT. Static (changes at runtime only via a lib function of its own, e.g. open door = different tile).

### 2.3 Content layer (W·H bytes)

| Bit | Meaning |
|---|---|
| 0–5 | item 0–63 (0 = none); mapping to a sprite set via `ITEMSET` as in 0.1 |
| 6 | automap: seen (runtime; normally 0 in the file) |
| 7 | automap: mark (runtime or pre-set by the map author) |

One item per cell; it lies at sub-position **center** (p = 2, see 2.6). Further items at other spots come via the object list (P6).

### 2.4 Tile table (NT × 8 bytes)

| Offset | Content |
|---|---|
| 0 | wall style north face |
| 1 | wall style east face |
| 2 | wall style south face |
| 3 | wall style west face |
| 4 | floor style (0 = no floor: wallpaper/abyss visible) |
| 5 | ceiling style (0 = no ceiling: sky/wallpaper) |
| 6 | flags |
| 7 | automap character (0 = default according to flag AUTOMAP) |

Flags:

| Bit | Name | Meaning |
|---|---|---|
| 0 | SOLID | blocks the way (`MOVE`) |
| 1 | BLOCKSIGHT | blocks the line of sight for the game logic (enemies cannot see through) |
| 2 | OCCLUDING | `VIEW`: faces of this tile cover their column ranges (only if the image in the DTS is also occluding); nothing is drawn behind them any more |
| 3 | DOOR | door (game logic; `VIEW` treats it like any tile with faces) |
| 4 | AUTOMAP | draw as wall on the automap (otherwise as floor) |
| 5 | CONTENT | “draw content” (user decision 4, plan 9): in a cell with faces, `VIEW` additionally draws its objects (item of the content layer and object list, P6 5.8); paint order side face, objects by sub-position, front. For door, grating, arch. Without faces (all wall styles 0) it has no effect (`dbemap` warns). The flag does not change whether the faces cover (OCCLUDING) |
| 6 | DISTANT | distant view (P6 5.7a, P6l): reverses the ceiling rule of the distant-view fill. Without the flag, the horizon band behind a tile of depth D with ceiling style ≠ 0 shows the fill byte, with ceiling style 0 the wallpaper; with the flag the other way round (covered arcade with a view outdoors, cave without ceiling texture). Without distant-view fill (`BGSET` Y = 0) it has no effect. `dbemap`: `flags = ["distant"]` |
| 7 | – | 0 (reserved; `dbemap` rejects a set bit) |

Rules for `VIEW` (P6):

- A cell has **faces** if at least one of the wall styles is ≠ 0. Which face is shown depends on position (d, s) and viewing direction v:

  | Face in the view grid | Tile face |
  |---|---|
  | Front (the player looks at it) | (v + 2) AND 3 |
  | Side, s < 0 (left) | (v + 1) AND 3 |
  | Side, s > 0 (right) | (v + 3) AND 3 |

  Example: looking north, block ahead → its south face; block on the left → east face.
- Floor and ceiling are also drawn in cells with faces (grating, door, window in a cell). For a tile with OCCLUDING and four wall styles ≠ 0, floor and ceiling are invisible; `VIEW` does not treat such cells as a gap in the gap check of the bands (content of the fields irrelevant, `dbemap` sets 0).
- A cell with faces shows **no** objects unless the tile has the flag CONTENT: then `VIEW` paints (plan 5, decision 4) in this order side face, objects of the cell by sub-position (2.6), front. With several elements per cell: first all fronts, then the objects, then all sides in view order (output backwards: sides, objects, fronts).
- Cells outside the map behave like the tile from header byte 11.

### 2.5 Events (NE × 4 bytes)

| Offset | Content |
|---|---|
| 0–1 | cell index |
| 2 | type |
| 3 | parameter |

Sorted by (cell index, type, parameter); several events per cell allowed.

| Type | Name | Parameter |
|---|---|---|
| 0 | – | invalid |
| 1 | `enemy` | enemy start point, parameter = enemy number |
| 2 | `teleport` | group; destination = the other cell with the same group |
| 3 | `exit` | 0 = closed, 1 = open |
| 4 | `text` | text number (game) |
| 5–127 | – | reserved for the engine |
| 128–255 | – | free for the game, parameter arbitrary |

The player's start point is in the header, not an event.

### 2.6 Sub-positions (convention for object list and items)

In the map and the object list, sub-positions are **absolute**: q = 0 NW, 1 NE, 2 SW, 3 SE, 4 center (E = east). `VIEW` converts them with the viewing direction v into the drawing position p of the geometry (P3, 3.3: 0 back left, 1 back right, 2 center, 3 front left, 4 front right):

| v | NW | NE | SW | SE | center |
|---|---|---|---|---|---|
| 0 N | 0 | 1 | 3 | 4 | 2 |
| 1 E | 3 | 0 | 4 | 1 | 2 |
| 2 S | 4 | 3 | 1 | 0 | 2 |
| 3 W | 1 | 4 | 0 | 3 | 2 |

(Check: looking east, “back” = east half, “left” = north → NE = back left = 0.)

## 3. Text format for `dbemap.py` (TOML)

```toml
format  = "dbemap"
version = 1

[map]
name    = "demo"
start   = [2, 1]        # x, y
dir     = "E"           # N, E (east), S, W
outside = "wall"        # tile name for cells outside

[tiles.wall]            # order of the tables = tile index (0, 1, …)
walls   = 1             # all four faces style 1; or [N, E, S, W]
floor   = 0
ceiling = 0
flags   = ["solid", "blocksight", "occluding", "automap"]

[tiles.corridor]
floor   = 1
ceiling = 1

[tiles.sky]
floor   = 1             # ceiling missing = 0: sky

[tiles.grating]
walls   = 2
floor   = 1
ceiling = 1
flags   = ["solid"]       # not occluding: visible behind it
automap_char = 35

[legend]
"#" = "wall"
"." = "corridor"
"," = "sky"
"+" = "grating"
"m" = { tile = "corridor", item = 2 }
"T" = { tile = "corridor", events = [{ type = "teleport", param = 1 }] }
"X" = { tile = "corridor", events = [{ type = "exit", param = 0 }] }

[layers]
tiles = """
#######
#..m..#
#.,,+.#
#T...X#
#######
"""

[[events]]              # additional events at coordinates
at    = [3, 1]
type  = "enemy"        # name from 2.5 or number
param = 1

[[marks]]               # optional: pre-set automap mark (bit 7)
at = [1, 1]
```

Rules:

- Tile keys: `walls` (number or list of 4 numbers, 0 … 255, default 0), `floor`, `ceiling` (0 … 255, default 0), `flags` (list of `solid`, `blocksight`, `occluding`, `door`, `automap`, `content`, `distant`), `automap_char` (0 … 255), `index` (optional: fixed number; then all tiles must have `index`, gaps are filled with zero tiles, NT = highest index + 1).
- Legend: key exactly one character (no space); value is a tile name or a table with `tile` (mandatory), `item` (0 … 63), `events` (list of tables with `type`, `param`).
- `layers.tiles`: rows of equal length = W, count = H. An empty first/last line (caused by `"""`) is ignored; spaces at the end of a line are an error (invisible, usually a slip).
- `[[marks]]`: `at` (mandatory), `mark` (default `true`: bit 7), `seen` (default `false`: bit 6).
- Unknown keys (top level, `[map]`, `[layers]`, tiles, legend, events, marks) are errors.
- `start` must lie on a tile without SOLID.
- Error messages name the file, row/column in the map or the key (e.g. `demo.toml: map row 3, column 5: character 'q' not in the legend`). Exit code 1.

## 4. `tools/dbemap.py`

### 4.1 CLI

```
dbemap.py build MAP.toml OUT.dmp [--load ADDR]
dbemap.py dump  IN.dmp [--toml OUT.toml]       # without --toml: text overview on stdout
dbemap.py check MAP.toml
```

`dump --toml` produces a TOML file that yields exactly the same DMP again, byte for byte, via `build`. Tile names `k<index>` (e.g. `k0`), tiles with `index = …`; legend: one character per occurring pair (tile, item) from the supply `#.0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!$%&*+-/:;<=>?@^_~|` in ascending order of (tile, item); more pairs than characters → error “too many combinations for an ASCII map”. Events as `[[events]]` with `at`, marks as `[[marks]]`. The writer is code of its own (no TOML writer library needed); escape strings with `"` and `\` correctly.

### 4.2 Python API

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

FLAGS = {"solid": 1, "blocksight": 2, "occluding": 4, "door": 8, "automap": 16, "content": 32}
EVENT_TYPES = {"enemy": 1, "teleport": 2, "exit": 3, "text": 4}
SUBPOS_VIEW = [[0,1,3,4,2], [3,0,4,1,2], [4,3,1,0,2], [1,4,0,3,2]]   # [v][q] -> p (2.6)

def load_toml(path) -> Map
def to_dmp(m: Map, load=0x8000) -> bytes
def from_dmp(data: bytes) -> Map            # checks magic, version, offsets, length, indices
def to_toml(m: Map) -> str
def validate(m: Map) -> None                # ValueError with message
def face(view_dir: int, s: int, front: bool) -> int   # tile face per 2.4
```

## 5. `tools/crawlmap.py` – converter from Crawl 128

### 5.1 Source `CRAWL128.CD1`

It is not a file in the repo dungeoncrawlerjam2025 but lives on its disk images: `game/crawl.d81` (development disk), likewise `crawl128-100f.d81` and `game/blitzcrawl.d81`; file name on the disk `crawl128.cd1`. Reading it out: `c1541 -attach game/crawl.d81 -read crawl128.cd1 crawl128.cd1`. Produced by `game/mapgen.bas`.

Layout (PRG, load address `$213C` = `BE` at save time, meaningless):

| Offset (after load address) | Content |
|---|---|
| 0 | OS: offset of the map data (Crawl: 14) |
| 1 | W (Crawl: 20) |
| 2 | H (Crawl: 11) |
| 3–4 | number of gems (Crawl: 92) |
| 5 … OS − 1 | records of 3 bytes: character (ASCII), cell index (word) |
| OS … OS + W·H − 1 | map, 1 byte per cell: value = ASCII − 48 of the character from the DATA lines |
| after that | map name as ASCII (`CRAWL128`) |

Cell values (`crawl.bas`, comment from line 11019, and actual values): odd = not walkable (bit 0 = wall; 1 wall, 3 wall enemy lair, 5 door enemy lair), 0 empty, 2 gem, 4 power gem, 6 start point, 8 teleport, 18 (`B`) start ghost 1, 40 (`X`) exit closed, 42 (`Z`) exit open. Records: `6` player start, `8` teleport, `B` ghost 1, `X` exit. The map in the repo contains the values 0, 1, 2, 4, 6, 18, 40 (counts: 3, 120, 92, 2, 1, 1, 1) and the records `X` → 29, `B` → 68, `6` → 198.

### 5.2 Mapping (lossless)

- **Tile index = Crawl cell value** (Crawl's game logic compares cell values; `CELL` thus returns the same numbers). NT = max(largest occurring value, 42) + 1, because `crawl.bas` 5550 sets the exit to 42 (open) at runtime; non-occurring indices = zero tile, odd as wall below, even empty.
- Tile for occurring values v:

  | v | walls | floor | ceiling | flags | automap_char |
  |---|---|---|---|---|---|
  | odd | 1 (all four) | 0 | 0 | solid, blocksight, occluding, automap | 0 |
  | even | 0 | 0 | 0 | – | 0 |

  Crawl has no floor and ceiling textures (black, as 0.1 with Clear). The option `--floor N --ceiling N` sets them for even values.
- Content: item = v for v ∈ `--items` (default `2,4`), otherwise 0. Automap bits 0.
- Start: cell from record `6`, direction 0 (N; `crawl.bas` 3870 `PF%(0)=0`). If `6` is missing → error (as `crawl.bas` 82).
- Events from the records: `8` → `teleport` group 1 (all teleporters of Crawl form one group), `B` → `enemy` 1, `D` → `enemy` 2, `F` → `enemy` 3, `H` → `enemy` 4, `X` → `exit` 0, `Z` → `exit` 1. Unknown character c → type 255, parameter = ASCII code, warning.
- Outside: tile 1 (wall; Crawl: cells outside count as wall).
- Duplicate records: `6` several times → error (start ambiguous); more than two `8` → error (`crawl.bas`: `DIM TL%(1)`); other characters several times → warning (Crawl takes the last one, the DMP contains all events).
- Checks with warning (no abort): number of cells with value 2 ≠ gem count in the header; record cell ≥ W·H (then error); map name ≠ ASCII.
- `--toml`: additionally text form; legend: character = `chr(48 + v)` (the characters from `mapgen.bas`, e.g. `B`, `X`), for cells with an item the same character (item = value). For v > 78 error.

### 5.3 CLI

```
crawlmap.py CRAWL128.CD1 OUT.dmp [--toml OUT.toml] [--load ADDR] [--items 2,4] [--floor N] [--ceiling N]
crawlmap.py --d81 IMAGE.d81 OUT.dmp [...]       # reads crawl128.cd1 via c1541 into a temporary directory
```

Output on stdout: size, number of tiles, items, events, start.

## 6. Tests (`test/tools/test_dbemap.py`, `test/tools/test_crawlmap.py`, unittest)

Test data: `test/tools/data/crawl128.cd1` (copy from `game/crawl.d81`, 244 bytes including load address; the repo dungeoncrawlerjam2025 is under the MIT license – note the origin in `test/tools/data/README.md`). No test accesses foreign repos or `c1541`, except `test_d81` (skipped if `c1541` or the image is missing: `unittest.skipUnless`).

### 6.1 dbemap

- Build the example from section 3: W = 7, H = 5, NT = 4, NE = 3 (teleport at (1,3), exit at (5,3), enemy at (3,1)), start = 1·7 + 2 = 9, direction 1; cell (3,1) has tile 1 and item 2; tile `wall` = `01 01 01 01 00 00 17 00`, `grating` = `02 02 02 02 01 01 01 23`. Header offsets 24 / 59 / 94 / 126, total length 138.
- Round trip: `from_dmp(to_dmp(m))` == m (except names); `to_dmp(load_toml(to_toml(from_dmp(d))))` == d for the example, the Crawl map and 50 random maps (fixed seed, W, H 1 … 40, up to 12 tiles, items, events).
- Events sorted by (cell, type, parameter).
- Flag `content` (bit 5): TOML round trip, `from_dmp`/`validate` reject set bits 6/7, warning for `content` without wall faces.
- Error cases (one small TOML each in the test): unknown character (message with row/column), unequal row lengths, start on SOLID tile, `item = 64`, style 256, unknown flag, unknown event type, W = 256, W·H > 16384, space at the end of a line, `index` on only some of the tiles.
- `face`: all 4 directions × (front, left, right) against table 2.4.
- `SUBPOS_VIEW`: every row is a permutation of 0 … 4; center always 2; rotation by 90° to the right (v + 1) shifts the corners NW → NO → SO → SW consistently in the world view (check from 2.6).
- `from_dmp`: wrong magic, version 2, length too short, tile index ≥ NT, start cell ≥ W·H → `ValueError`.

### 6.2 crawlmap

- `crawl128.cd1` → DMP: W = 20, H = 11, NT = 43 (tile 42 = exit open, empty), start = 198, direction 0; tiles 0, 2, 4, 6, 18, 40 without flags, tile 1 with `$17`; tile layer = Crawl values cell by cell; items: 92 cells with 2, 2 with 4; events exactly `(29, exit, 0)`, `(68, enemy, 1)`; outside = 1.
- `--toml` → `dbemap build` → byte-identical to the direct DMP.
- Synthetic CD1 generated in the test (3 × 2, records `6`, `8`, `8`, `Z`, unknown `Q`): teleport group 1 twice, `exit` 1, type 255 with parameter 81 and warning; missing `6` → error; `6` twice or three `8` → error, `X` twice → warning.
- `test_d81`: `--d81 /home/martin/git/dungeoncrawlerjam2025/game/crawl.d81` yields the same DMP as the test file.

## 7. Acceptance

- `tools/dbemap.py`, `tools/crawlmap.py` with docstrings in the style of `wallconv.py`; tests green, run time < 30 s.
- Example map `docs/specs/examples/demo.toml` (section 3) and `crawl128.toml` generated from it (from `crawlmap --toml`) in the repo.
- `docs/formats.md` gets “DMP v1” (tables 2.1–2.5, 2.6) and replaces the section “Map (provisional)” with a reference.
