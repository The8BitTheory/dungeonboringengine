# P3: Geometry – `tools/dbegeom.py`, Westwood preset, DVG, templates, budget

As of 2026-11-25. Detailed specification for step P3 of `docs/plan-0.2.md` (sections 4–6). Implementation: Sonnet. Review: Opus. Dependencies: Python ≥ 3.11 (`tomllib`), Pillow. No further packages.

## 1. Overview

`dbegeom.py` reads `view.toml`, computes the geometry of the viewport and writes:

| Output | For |
|---|---|
| `<name>.dvg` | engine (P6): rectangles, kernels, column ranges, bands, object anchors |
| `<name>.geom.json` | tools (P5): everything from DVG plus masks at pixel resolution, atlas position, anchors in pixels |
| `<name>_atlas.png`, `<name>.aseprite` | painting template: every element individually, with mask |
| `<name>_view.png` | overview: all elements in the viewport, anchors marked |
| `tpl/<element>.png` | single template per element |
| `<name>.budget.md` (+ section in JSON) | VRAM and VMS lists per style |

Coordinates: **x in pixels** (chunky, 2 pixels per byte) or **in byte columns**, **y in chunky rows**. Everything relative to the top left corner of the viewport.

## 2. `view.toml`

```toml
[viewport]
preset   = "westwood"   # "westwood" or "custom" (then [planes] is mandatory)
width_px = 140          # multiple of 4, 16 … 160
height   = 96           # 8 … 100
origin   = 0            # byte offset of the top left corner in the attribute buffer (relative to AP)
stride   = 80           # row width of the buffer in bytes, ≥ width_px/2, ≤ 255
depth    = 3            # D; Westwood: exactly 3

[output]
name       = "west140"      # base name
dir        = "build/geom"   # relative to the folder of view.toml
load       = 0xE400         # load address of the DVG file (bank 1)
pool_bytes = 26624          # VRAM pool for the budget report
zoom       = 4              # magnification of the PNG templates (only _view.png and tpl/, atlas always 1:1)

[planes]                    # only with preset = "custom"
ref_size = [176, 120]
center_x = 88                       # optional; must be ref_size[0]/2 (C = width_px/2, 4.2)
width    = [208, 128, 80, 48, 32]   # D + 2 values, strictly decreasing
top      = [-16, 8, 16, 24, 28]     # increasing
bottom   = [144, 104, 80, 64, 56]   # decreasing
```

Validation (error with key name, exit code 1): unknown keys, `width_px % 4 ≠ 0` (see 4.2), ranges above, `stride < width_px/2`, `origin + (height−1)·stride + width_px/2 > 65535`, planes not monotonic, `top[k] ≥ bottom[k]`, `center_x` ≠ `ref_size[0]`/2, unknown preset, `depth` ≠ number of planes − 2.

## 3. Westwood preset

### 3.1 Model

The viewport of Eye of the Beholder (DOS) is 176 × 120 pixels, made of 22 × 15 blocks of 8 × 8 pixels. 18 cells are visible: depth 3 with 7 cells (s = −3 … +3), depth 2 with 5, depth 1 with 3, depth 0 (own cell) with the sides ±1. Lands of Lore uses the same window size.

The geometry is defined by **planes** P_k (k = 0 … D + 1): P_k is the front boundary surface of cell depth k. Per plane: width W_k of a cell, top edge top_k and bottom edge bot_k of the wall. Cell (d, s) lies between P_d and P_{d+1}; laterally it extends from s − ½ to s + ½.

- Edge at lateral position u on plane k: x = 88 + u · W_k.
- **Front** of a wall block (d, s), d ≥ 1: rectangle on P_d, x from 88 + (s − ½)·W_d to 88 + (s + ½)·W_d, y from top_d to bot_d.
- **Side** of a wall block (d, s ≠ 0): quadrilateral between P_d and P_{d+1} at the edge facing the center, u = s + ½ (s < 0, east side when looking north) or u = s − ½ (s > 0): corners (x_d(u), top_d), (x_{d+1}(u), top_{d+1}), (x_{d+1}(u), bot_{d+1}), (x_d(u), bot_d).
- **Floor** of cell (d, s): trapezoid (x_{d+1}(s−½), bot_{d+1}), (x_{d+1}(s+½), bot_{d+1}), (x_d(s+½), bot_d), (x_d(s−½), bot_d). **Ceiling** correspondingly with top.
- Westwood does not use linear perspective: the widths 128 / 80 / 48 / 32 fall by roughly a factor of 1.6 per depth. The preset adopts the table, not a camera model.

### 3.2 Reference values (176 × 120)

| k | W_k | x left (u = −½) | x right (u = +½) | top_k | bot_k | Source |
|---|---|---|---|---|---|---|
| 0 | 208 | −16 | 192 | −16 | 144 | **model** (outside, only for sides d = 0 and floor d = 0) |
| 1 | 128 | 24 | 152 | 8 | 104 | W: own side walls 3 blocks wide (x 0–24); top/bot: **assumption** 12 blocks high (the linear model would give top 4) |
| 2 | 80 | 48 | 128 | 16 | 80 | W, top, bot from the wall data (side I-East: block offset 50 = row 2, column 6, 2 wide; front 8 blocks high) |
| 3 | 48 | 64 | 112 | 24 | 64 | wall data (fronts 6 × 5 blocks from row 3) |
| 4 | 32 | 72 | 104 | 28 | 56 | W from the sides of depth 3 (A-East 1, B-East 3, C-East 1 block wide); top/bot **model** (top = 36 − W/4, bot = 40 + W/2) |

**Source:** The values come from memory of the wall render data of EOB (table “wallRenderData” of the EOB viewers, or the VMP structure: 330 background blocks = 22 × 15, per wall position offset in the window, width and height in blocks) and have been recomputed for internal consistency: all block offsets of depth 3 (A-, B-, C-East at column 0, 2, 8; E-, F-, G-West at 13, 17, 21; fronts B–F at column 0, 2, 8, 14, 20) follow exactly from W_3 = 48 and W_4 = 32. They have **not** been checked against the original files. Where “model” is stated, the value is derived from the linear relations top = 36 − W/4 and bot = 40 + W/2, which P2 and P3 satisfy exactly.

Derived elements in 176 × 120 (after clipping to the window, x in pixels):

| Element | d | s | x0–x1 | y0–y1 | EOB |
|---|---|---|---|---|---|
| Front | 1 | −1 / 0 / +1 | 0–24 / 24–152 / 152–176 | 8–104 | M, N, O |
| Front | 2 | −1 / 0 / +1 | 0–48 / 48–128 / 128–176 | 16–80 | I, J, K |
| Front | 3 | −2 / −1 / 0 / +1 / +2 | 0–16 / 16–64 / 64–112 / 112–160 / 160–176 | 24–64 | B–F |
| Side | 0 | ∓1 | 0–24 / 152–176 | 0–120 (trapezoid −16…144 → 8…104) | P-East, Q-West |
| Side | 1 | ∓1 | 24–48 / 128–152 | 8…104 → 16…80 | M-East, O-West |
| Side | 2 | ∓1 / ∓2 | 48–64, 112–128 / 0–16, 160–176 | 16…80 → 24…64 | I-East, K-West / H-East, L-West |
| Side | 3 | ∓1 / ∓2 / ∓3 | 64–72, 104–112 / 16–40, 136–160 / 0–8, 168–176 | 24…64 → 28…56 | C/E, B/F, A/G |
| Ceiling band | 0 / 1 / 2 / 3 | – | full width | 0–8 / 8–16 / 16–24 / 24–28 | – |
| Floor band | 0 / 1 / 2 / 3 | – | full width | 104–120 / 80–104 / 64–80 / 56–64 | – |
| Horizon band | behind 3 | – | full width | 28–56 | – |

### 3.3 Object sub-positions

Per free cell 5 anchors (foot point on the floor); order = drawing order within the cell:

| p | Name | lateral a | Depth t (0 = P_d, 1 = P_{d+1}) |
|---|---|---|---|
| 0 | back left | −¼ | ¾ |
| 1 | back right | +¼ | ¾ |
| 2 | center | 0 | ½ |
| 3 | front left | −¼ | ¼ |
| 4 | front right | +¼ | ¼ |

Westwood places items on four spots (quarters of the cell) and enemies in the center or in pairs; p = 0, 1, 3, 4 are the quarter centers, p = 2 the cell center. Computation in **scaled** space (4.3).

## 4. Scaling and rounding

### 4.1 Factors

sx = width_px / 176, sy = height / 120 (compute exactly as a fraction: `fractions.Fraction`). round(v) = ⌊v + ½⌋.

### 4.2 Planes

- W'_k = 4 · round(W_k · sx / 4) (multiple of 4 pixels = 2 bytes).
- C = width_px / 2 (center; even, because width_px is a multiple of 4).
- Edge: X(k, u) = C + u · W'_k. For half-integer u this is always even, i.e. a byte boundary.
- T_k = round(top_k · sy), B_k = round(bot_k · sy).
- Consequence: all fronts of a depth have the same width (W'_d / 2 bytes). Partially visible fronts (s ≠ 0) are cutouts of the full front (d, 0) – they need no image of their own (budget, section 9; DTS, P5).
- Check: W'_k strictly decreasing, T_k < B_k, W'_d ≤ width_px for d ≥ 1 (otherwise error “full front wider than the window”).

### 4.3 Anchors

W(t) = 1 / ((1 − t)/W'_d + t/W'_{d+1}) (perspective-correct between the planes), x = C + (s + a) · W(t), y = B_d + (B_{d+1} − B_d) · (W'_d − W(t)) / (W'_d − W'_{d+1}). Stored: x_px = round(x) and y = round(y) in JSON; in DVG byte column ⌊x_px / 2⌋ (signed) and row. Anchors outside the window are kept (large sprites reach into it). In the DVG (and JSON `byte`), the byte column is **saturated** to −128 … 127 and the row to ≤ 255: such anchors lie so far outside (VW ≤ 80, VH ≤ 100) that no sprite reaches the window. In the Westwood preset this affects, from width_px = 144, the cells d = 0, s = ±1 (review). y < 0 is an error.

### 4.4 Masks, rectangle, kernel, column range

- **Polygon** per element from the rounded values X, T, B (section 3.1 with W', T, B instead of W, top, bot).
- **Mask:** pixel (px, r) belongs to it if the point (px + ½, r + ½) lies in the convex polygon or on its boundary (all cross products of the edges ≥ 0 or all ≤ 0, exactly with `Fraction`) **and** 0 ≤ px < width_px, 0 ≤ r < height. Elements with an empty mask are dropped.
- **Rectangle** (x, y, w, h): smallest byte rectangle around all mask pixels (x = ⌊px/2⌋).
- **Byte state:** full (both pixels), half (one pixel: L = left = high nibble, R = right = low nibble), empty.
- **Kernel** (kx, ky, kw, kh, relative to the rectangle): largest rectangle consisting only of full bytes (maximum area; on a tie larger width, then smaller ky, then smaller kx). Algorithm: maximal rectangle in the histogram per row (stack method). No full bytes → kw = kh = 0. For fronts the kernel is the whole rectangle.
- **Column range** c0 … c1 − 1 (absolute, byte columns), only for front and side: largest contiguous range of columns in the rectangle in which **all bytes of rows max(T_{d+1}, 0) … min(B_{d+1}, height) − 1 are full**. Meaning: in these columns the element covers everything lying behind P_{d+1}; a front additionally covers the side faces of the same depth that come after it in the table (order 5.3). Without such columns c0 = c1 = 0. For fronts this yields all columns of the rectangle.
- **Clipped:** polygon extends beyond the window.
- **Partial front:** front with s ≠ 0. src_dx = (X_clipped_left − X(d, s − ½)) / 2 = byte offset of the visible part within the full front (width W'_d / 2). Example 140 × 96, front (1, −1): full front 50 bytes, the right 10 bytes visible, src_dx = 40.

### 4.5 Element set

For d = 0 … D, s = −S … +S with S = D (Westwood: 3):

| Kind | generated for |
|---|---|
| Front (0) | d ≥ 1, mask not empty |
| Side (1) | s ≠ 0, mask not empty |
| Floor (2) | mask not empty |
| Ceiling (3) | mask not empty |
| Object spot (4) | every cell that has a floor element |

In addition, per depth a floor band and a ceiling band (full width): ceiling d = rows [T_d, T_{d+1}), floor d = [B_{d+1}, B_d), clipped to [0, height). Horizon band = [T_{D+1}, B_{D+1}).

## 5. DVG format (version 1)

PRG file: 2 bytes load address, then the content. All offsets relative to the content (byte after the load address). Words low/high.

### 5.1 Header (24 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"D" "V"` (`$44 $56`) |
| 2 | version = 1 |
| 3 | VW: width in bytes (width_px / 2) |
| 4 | VH: height in rows |
| 5 | D |
| 6 | S (largest \|s\| among the elements) |
| 7 | NE: number of elements (≤ 255) |
| 8–9 | stride |
| 10–11 | origin (position of the window in the buffer; **not** part of the geometry ID) |
| 12–13 | geometry ID (5.5) |
| 14 | horizon band y0 (T_{D+1}, clipped) |
| 15 | horizon band y1 (B_{D+1}, exclusive, clipped) |
| 16 | element length = 16 |
| 17 | length of depth entry = 8 |
| 18–19 | offset of depth table (= 24) |
| 20–21 | offset of element table (= 24 + 8 · (D + 1)) |
| 22–23 | total length of the content |

### 5.2 Depth table (D + 1 entries, d = 0 … D)

| Offset | Content |
|---|---|
| 0 | ceiling band y0 |
| 1 | ceiling band y1 (exclusive; y0 = y1: empty) |
| 2 | floor band y0 |
| 3 | floor band y1 (exclusive) |
| 4 | index of the first element of this depth |
| 5 | number of elements of this depth |
| 6 | width of the full front in bytes (W'_d / 2; 0 for d = 0) |
| 7 | byte column of the full front (= x of front (d, 0); 0 for d = 0) |

### 5.3 Element table (NE × 16 bytes)

Order **front to back**: d ascending; per depth cells from inside to outside (s = 0, −1, +1, −2, +2, …); per cell front, side, floor, ceiling, object spot. (For output from back to front, `VIEW` walks the depths D … 0 and per depth the cells backwards; see `review-notes.md` for the order of walls/objects.)

Front, side, floor, ceiling:

| Offset | Content |
|---|---|
| 0 | kind: 0 front, 1 side, 2 floor, 3 ceiling |
| 1 | d |
| 2 | s (signed) |
| 3 | flags: bit 0 = column range valid (covers, provided the image is occluding); bit 1 = partial front (image = full front of the depth from src_dx); bit 2 = clipped; rest 0 |
| 4 | x (byte column) |
| 5 | y (row) |
| 6 | w (bytes) |
| 7 | h (rows) |
| 8 | kx (relative to x) |
| 9 | ky (relative to y) |
| 10 | kw (0 = no kernel) |
| 11 | kh |
| 12 | c0 |
| 13 | c1 (exclusive) |
| 14 | src_dx (partial front only, otherwise 0) |
| 15 | reserved 0 |

Object spot:

| Offset | Content |
|---|---|
| 0 | kind = 4 |
| 1 | d |
| 2 | s |
| 3 | 0 |
| 4–13 | 5 anchors p = 0 … 4, 2 bytes each: byte column (signed), row of the foot point (both saturated, 4.3) |
| 14–15 | 0 |

Destination in the buffer: `AP + origin + y · stride + x` (the engine computes this via a row table).

### 5.4 Limits

NE ≤ 255 (Westwood: 79), VW ≤ 80, VH ≤ 100, all byte fields 0 … 255 except s and anchor column (−128 … 127).

### 5.5 Geometry ID

`binascii.crc_hqx(content_with_id_0, 0xFFFF)`: CRC-16/CCITT over the whole content, in which bytes 12–13 (ID) **and 10–11 (`origin`)** are 0 before the computation: the ID describes the shape (stride, rectangles, masks), not the position of the window in the buffer; textures (DTS, DBG) remain valid when `origin` is shifted. A result of 0 is replaced by 1. DTS (P5) carries the ID and is accepted only for a DVG with the same ID.

## 6. `<name>.geom.json`

```json
{
  "format": "dbegeom", "version": 1, "geometry_id": 12345,
  "viewport": {"preset": "westwood", "width_px": 140, "height": 96, "origin": 0, "stride": 80, "depth": 3},
  "planes": [{"k": 0, "W": 164, "x_left": -12, "x_right": 152, "T": -13, "B": 115}],
  "bands": [{"d": 0, "ceil": [0, 6], "floor": [83, 96]}],
  "band_images": [{"name": "ceilband_d0", "art": "ceilband", "d": 0, "rect": [0, 0, 70, 6], "atlas": [4, 378]}],
  "horizon": [22, 45], "atlas_size": [580, 494],
  "elements": [{
    "index": 0, "name": "floor_d0_s+0", "art": "floor", "d": 0, "s": 0,
    "rect": [3, 83, 64, 13], "kernel": [7, 0, 50, 13], "cover": [0, 0], "flags": ["clipped"],
    "src_dx": 0, "polygon": [[20, 83], [120, 83], [152, 115], [-12, 115]],
    "mask": ["..L#####…", "…"],
    "atlas": [0, 0]
  }],
  "slots": [{"d": 1, "s": 0, "anchors_px": [[52, 67], [88, 67], [70, 71], [48, 76], [92, 76]]}],
  "budget": {}
}
```

- `mask`: per row of the rectangle a string with w characters: `#` full, `L` left pixel only, `R` right only, `.` empty.
- `name`: `<art>_d<d>_s<±s>` with art ∈ `front`, `side`, `floor`, `ceil`; bands `floorband_d<d>`, `ceilband_d<d>`; object spots `obj_d<d>_s<±s>`, anchors `obj_d<d>_s<±s>_p<p>`. These names are the slice names in the Aseprite template and the key for the importer (P5).
- Values in `kernel` are relative to the rectangle, everything else absolute.
- Polygon point order as in 3.1.
- `elements` also contains the object spots (`art` = `obj`, `anchors`: per anchor `name`, `px`, `byte` = DVG value per 4.3); `slots` repeats them briefly.
- `band_images`: bands as atlas images (rectangle, atlas position); `atlas_size`: width, height of the atlas in pixels.
- `atlas` is `null` for elements without an image of their own (partial fronts).

## 7. Templates

### 7.1 Palette (VDC, RGBI)

| Index | Color | RGB |
|---|---|---|
| 0 | black | 000000 |
| 1 | dark gray | 555555 |
| 2 | dark blue | 0000AA |
| 3 | light blue | 5555FF |
| 4 | dark green | 00AA00 |
| 5 | light green | 55FF55 |
| 6 | dark cyan | 00AAAA |
| 7 | light cyan | 55FFFF |
| 8 | dark red | AA0000 |
| 9 | light red | FF5555 |
| 10 | dark violet | AA00AA |
| 11 | light violet | FF55FF |
| 12 | brown | AA5500 |
| 13 | yellow | FFFF55 |
| 14 | light gray | AAAAAA |
| 15 | white | FFFFFF |
| 16 | transparent (template only) | 000000, alpha 0 |

### 7.2 Atlas

All paintable images individually next to each other, 1:1 in chunky pixels:

| Row (group) | Content |
|---|---|
| 1 | `front_d1_s+0` … `front_dD_s+0`: per depth only the full front (rectangle W'_d × (B_d − T_d)); partial fronts have no atlas image |
| 2 … | `side_d<d>_s<±s>` one row per depth, order like the element table |
| then | `floorband_d0` … `floorband_dD`, then `ceilband_d0` … |
| then | `floor_…` one row per depth, then `ceil_…` |

Shelves: images in a row from left to right with 4 pixels spacing, rows with 4 pixels spacing, margin 4 pixels. Atlas width = max(width_px, widest row) + 8. The position (x, y in pixels) is stored in `atlas` in the JSON. Representation in `_atlas.png` (RGBA): transparent outside the mask, mask light gray (AAAAAA), kernel medium gray (555555); half bytes show exactly the occupied pixel.

### 7.3 Aseprite template (`<name>.aseprite`, own writer, only `struct` + `zlib`)

Format according to the official description (`aseprite/docs/ase-file-specs.md`); all numbers little endian.

- Header 128 bytes: file size (DWORD), magic `0xA5E0`, 1 frame, width/height = atlas, color depth 8 (indexed), flags 1, speed 100, 0, 0, transparent index **16**, 3 × 0, color count 17, pixel width 1, pixel height 1, grid 0, 0, 16, 16, rest 0.
- Frame: size (DWORD), magic `0xF1FA`, old chunk count (`0xFFFF` if > 65534, otherwise the count), duration 100, 2 × 0, new chunk count (DWORD).
- Chunks in this order:
  1. Color profile `0x2007`: type 1 (sRGB), flags 0, gamma 0, 8 × 0.
  2. Palette `0x2019`: 17 entries (7.1), index 16 with alpha 0.
  3. Layer `0x2004` “Maske”: flags 1 (visible, not editable), type 0, child level 0, default size 0, 0, blend mode 0, opacity 128, name “Maske”.
  4. Layer `0x2004` “Image”: flags 1 | 2 (visible, editable), opacity 255.
  5. Cel `0x2005` for layer 0: x = y = 0, opacity 255, type 2 (zlib), z 0; pixels: outside 16, mask 14, kernel 1.
  6. Cel for layer 1: entirely index 16 (empty, for painting).
  7. One slice `0x2022` per atlas image: 1 key, flags 1 (9-patch, center = kernel) or 0 without kernel, name as in 6; key: frame 0, x, y, w, h (pixels in the atlas), 9-patch: kernel relative (kx·2, ky, kw·2, kh). Directly after it a user-data chunk `0x2020` with flags 1 and text = JSON `{"art":…, "d":…, "s":…, "src_dx":…}`.
- Checked in the test with a small reader of its own (section 10); Aseprite itself is not installed.

### 7.4 `_view.png` and `tpl/`

- `_view.png`: viewport width_px × height on a black background; outlines of all elements as 1-pixel lines (color per depth: d0 red, d1 yellow, d2 green, d3 blue); the bands as 4-pixel-wide color stripes at the left edge (ceiling cyan, floor brown, horizon violet); anchors as a white 3 × 3 cross. Afterwards magnified with `zoom` (nearest).
- `tpl/<name>.png`: per element of the atlas an image of its rectangle (RGBA as 7.2), magnified with `zoom`.

## 8. CLI

```
dbegeom.py view.toml [--out DIR] [--name NAME] [--check]
dbegeom.py --preset westwood --width 140 --height 96 [--stride 80 --origin 0] [--out DIR]
```

- `--check`: only validate and print the element table as text (one line per element like `d=1 s=-1 front x=0 y=6 w=10 h=77 core=0,0,10,77 cov=0..10 src_dx=40`).
- Exit code 0 ok, 1 validation error, 2 invocation.

## 9. Budget report

Per style (one image set for all elements of a kind):

| Quantity | Computation |
|---|---|
| Kernel bytes | kw · kh |
| Edge bytes | bytes in the rectangle outside the kernel with at least one mask pixel (packed in VRAM, source for `VMS`) |
| VRAM per element | kernel + edge; partial fronts 0 (from the full front) |
| VMS list per element | 0 without edge, otherwise 3 + Σ per row of the edge: contiguous full bytes = 1 command type 1 (4 bytes), each half byte = type 8 (3 bytes) |

Report (`.budget.md` and `budget` in JSON):

1. Table per element: name, rectangle, kernel, edge, VRAM, VMS list.
2. Sums per kind: **wall style** (front + side), floor style (bands; additionally tiles), ceiling style (likewise).
3. Pool: how many wall styles + 1 floor + 1 ceiling style fit in `pool_bytes`.
4. Largest sum of the VMS lists of one image (upper bound: all wall elements of one style at the same time) against the VMS buffer of 1.3 KB (plan section 3); warning if exceeded.

Reference values from the specification author's prototype (tolerance ± 3 %, only for plausibility, not as a test value):

| Window | Full fronts | Sides | Wall style | Floor bands | Ceiling bands |
|---|---|---|---|---|---|
| 176 × 120 | 9 664 | 7 588 | 17 252 | 5 632 | 2 464 |
| 140 × 96 | 6 122 | 4 972 | **11 094** | 3 570 | 1 540 |
| 136 × 92 | 5 728 | 4 642 | 10 370 | 3 332 | 1 428 |

(Plan: “about 9–10 KB per wall style” – see `review-notes.md`.)

## 10. Tests (`test/tools/test_dbegeom.py`, unittest)

Invocation as P1. Outputs in `tempfile.TemporaryDirectory`.

### 10.1 Fixed values 140 × 96 (Westwood)

Planes:

| k | W' | X(−½) | X(+½) | T | B |
|---|---|---|---|---|---|
| 0 | 164 | −12 | 152 | −13 | 115 |
| 1 | 100 | 20 | 120 | 6 | 83 |
| 2 | 64 | 38 | 102 | 13 | 64 |
| 3 | 40 | 50 | 90 | 19 | 51 |
| 4 | 24 | 58 | 82 | 22 | 45 |

Bands (ceiling / floor): d0 0–6 / 83–96, d1 6–13 / 64–83, d2 13–19 / 51–64, d3 19–22 / 45–51; horizon 22–45.

Fronts (x, y, w, h in bytes/rows; src_dx; kernel = whole rectangle; column range = x … x + w):

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

Sides (x, y, w, h; column range c0–c1):

| d | s | Rectangle | c0–c1 |
|---|---|---|---|
| 0 | −1 / +1 | 0, 0, 10, 96 / 60, 0, 10, 96 | 0–10 / 60–70 |
| 1 | −1 / +1 | 10, 6, 9, 76 / 51, 6, 9, 76 | 10–19 / 51–60 |
| 2 | −1 / +1 | 19, 13, 6, 50 / 45, 13, 6, 50 | 19–25 / 45–51 |
| 2 | −2 / +2 | 0, 17, 5, 37 / 65, 17, 5, 37 | 0–5 / 65–70 |
| 3 | −1 / +1 | 25, 19, 4, 32 / 41, 19, 4, 32 | 25–29 / 41–45 |
| 3 | −2 / +2 | 5, 19, 12, 32 / 53, 19, 12, 32 | 5–17 / 53–65 |
| 3 | −3 / +3 | 0, 21, 5, 25 / 65, 21, 5, 25 | 0–5 / 65–70 |

Counts: 11 fronts, 14 sides, 18 floors, 18 ceilings, 18 object spots, NE = 79.

Anchors (byte column, row), p = 0 … 4:

| d, s | Anchors |
|---|---|
| 1, 0 | (26,67) (44,67) (35,71) (24,76) (46,76) |
| 2, 0 | (29,53) (40,53) (35,56) (28,59) (42,59) |
| 3, 0 | (31,46) (38,46) (35,47) (30,49) (39,49) |
| 2, −1 | (7,53) (18,53) (10,56) (0,59) (14,59) |
| 0, 0 | (21,88) (49,88) (35,95) (17,104) (52,104) |

136 × 92: planes W' = 160, 100, 60, 36, 24; T = −12, 6, 12, 18, 21; B = 110, 80, 61, 49, 43.

176 × 120: planes exactly as table 3.2.

### 10.2 Properties (for 140 × 96, 136 × 92, 176 × 120 and a custom geometry)

- Symmetry: element (d, −s) is the mirror image of (d, s): x' = VW − x − w, mask mirrored row by row (L ↔ R).
- Kernel consists only of full bytes; no larger full rectangle exists (brute force over all rectangles in the element).
- Column range: all bytes in the rows of P_{d+1} full; range contiguous and maximal.
- Fronts of one depth: same width except clipped ones; src_dx + w ≤ full front width.
- Every mask pixel lies in the rectangle and in the window; bands together with the horizon band cover the rows 0 … VH − 1 without gaps and without overlap.
- DVG: header fields, offsets, length, element and depth table match the JSON; elements in the order of 5.3; geometry ID recomputed per 5.5; generated twice = same bytes.
- Aseprite: own mini reader checks magic `0xA5E0`/`0xF1FA`, file size, chunk sizes sum to the frame size, 2 layers, 2 cels (zlib decompressible, size = atlas), number of slices = number of atlas images, names as in the JSON, 9-patch = kernel.
- PNG: sizes match (atlas 1:1, `tpl` with zoom), alpha 0 exactly outside the mask.
- Validation: `width_px = 138` → exit code 1; `stride = 60` at 140 → 1; custom with non-decreasing width → 1.

## 11. Acceptance

- `tools/dbegeom.py` (docstring in the style of `wallconv.py`), `test/tools/test_dbegeom.py` green, run time < 60 s.
- Example `docs/specs/examples/view-west140.toml` (default) and `view-west136.toml` (2 text lines).
- `docs/formats.md` gets “DVG v1” (tables 5.1–5.3, brief).
