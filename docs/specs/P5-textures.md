# P5: Textures – `tools/dbetex.py`, DTS, DBG, VRL data, budget

As of: 2026-11-25. Detailed specification for step P5 of `docs/plan-0.2.md` (sections 5, 6). Implementation: Sonnet. Review: Opus. Dependencies: Python ≥ 3.11 (`tomllib`), Pillow, `tools/vrl.py` (P1), `tools/dbegeom.py` (P3, only as a module for helper functions and in tests). Aseprite is not installed and is not needed.

Sprite sets v2 (dynamic objects) are **not** part of P5 but a separate step, **P5b**; section 11 only sketches the interface.

## 1. Overview

`dbetex.py` reads painted textures (PNG atlas following the dbegeom template, or Aseprite export) and the geometry (`<geom>.geom.json` from P3) and writes:

| Output | Bank / target | Content |
|---|---|---|
| `<name>.dts` | Bank 1 (engine, `TEXSET`, P6) | Texture set: styles, image directory, cores, VMS lists, row fills |
| `<name>.vrl` | Bank 0 (the game's load buffer), then `RXV` to the VRAM base | all image data of the set (cores and packed edge bytes), VRL v1 with file frame (P1, 3) |
| `<name>.dbg` + `<name>.vrl` | as above | Wallpaper (section 6) |
| `<name>.tex.json`, `<name>.tex.md` | tools, human | Report: directory, sizes, warnings, budget (section 8) |
| `<name>_<style>_preview.png` | human | Preview image per style using the reference renderer (7.3) |

**Why two files:** `RXV` reads the VRL stream from bank 0 (plan 7.2); the engine reads its metadata from bank 1 (like DVG and DMP). The VMS lists live in the DTS and are copied by `VIEW` into the buffer at `$1300` anyway (shared RAM, visible to `VMS` in bank 0). The VRL stream is no longer needed after unpacking; its load buffer is free afterwards.

A DTS contains exactly **one kind**: wall, floor or ceiling. A game loads up to three DTS per zone (one VRAM base each in the pool) and one DBG.

Terms (as in P3): element = entry of the DVG element table; rectangle (x, y, w, h) in byte columns and rows; pixel (px, r) in the rectangle, px = 0 … 2w − 1; byte bx = ⌊px / 2⌋.

## 2. Pixels, palette, transparency, nibbles

### 2.1 Nibble packing

1 byte = 2 chunky pixels. **Left pixel (even px) = high nibble (bits 7–4), right pixel = low nibble (bits 3–0)** – like `crawlsprites.py` (`>> 4` for `c % 2 == 0`), VDC-BASIC (`docs/reference/vms-format.md`) and P3 (`L` = high nibble).

### 2.2 Palette

The 16 VDC colors are the VICE palette `vdc_deft.vpl` ("VDC (RGB with brown)"), identical to `dbegeom.PALETTE` (P3, 7.1). `dbetex` imports the table from `dbegeom` (no second copy).

Mapping of an opaque pixel (R, G, B):

1. Exactly equal to a palette entry → that index.
2. Otherwise nearest color by squared RGB distance (R² + G² + B² of the differences), the smaller index on a tie. One **warning** per image with the number of pixels, the largest distance and the first position (`side_d1_s-1: 37 Pixel nicht in der VDC-Palette, max. Abstand 41 bei (3, 12)`).
3. `--strict`: any deviation is an error (exit code 1).

Indexed PNGs (mode `P`) are converted to RGB(A) via their palette; the index in the PNG does not count (Aseprite palettes may be reordered). Grayscale and RGB PNGs are likewise converted to RGBA.

### 2.3 Transparency

| Pixel | Meaning |
|---|---|
| Alpha = 0 | transparent |
| Alpha = 255 | opaque, color per 2.2 |
| 0 < Alpha < 255 | **error** (count, first position), with the hint: "semi-transparency: mask layer of the template exported as well? Aseprite: `--layer Image`". With `--alpha-threshold N` instead: alpha < N transparent, otherwise opaque. |
| RGB = `key` (option `key = "FF00FF"` or `--key`) | transparent (for PNGs without an alpha channel) |

In addition, the **mask of the element** applies (P3, 4.4, `mask` in the JSON): pixels outside it are always transparent. Opaque pixels outside the mask are discarded, with a warning (count per image): "N pixels outside the mask, painted over, clipped". Transparent pixels inside the mask are intentional transparency (windows, grilles, arches).

### 2.4 Byte state per image

Per byte of the rectangle, from its two pixels (after 2.3):

| State | Pixels | Drawing |
|---|---|---|
| full | both opaque | core (`VMC`) or VMS type 1 |
| half-L | only left opaque | VMS type 8, low nibble = alpha of the list |
| half-R | only right opaque | VMS type 8, low nibble ≠ alpha of the list |
| empty | both transparent | nothing (no data) |

**Alpha per VMS list:** `VMS` type 8 compares only the **right** nibble with the alpha value (`vms-format.md`): equal → left from the image, right from the screen; otherwise → right from the image, left from the screen. From this:

- C = set of colors of right pixels in half-R bytes of the image.
- Alpha = smallest index in {0 … 15} \ C (usually 0).
- half-L byte: `(left << 4) | alpha`. half-R byte: `(0 << 4) | right` (the high nibble is not read; fixed to 0 so the output is deterministic).
- C = all 16 colors (practically never): alpha = the color with the fewest half-R bytes (tie: smaller index); these half-R bytes become full (left pixel = color of the right one), warning with count.

## 3. Inputs

### 3.1 Project file `tex.toml`

```toml
format  = "dbetex"
version = 1

[texset]
name       = "zone1_walls"
kind       = "wall"                        # wall | floor | ceiling
geom       = "../geom/west140.geom.json"   # required (P3)
dvg        = "../geom/west140.dvg"         # optional: cross-check geometry ID
out        = "build/tex"                   # relative to tex.toml
load       = 0xA000                        # load address of the DTS (bank 1), see review-notes F.6
vrl_load   = 0x4000                        # load address in the VRL file frame (default only; BLOAD ...,P() overrides)
pool_bytes = 26624                         # optional, for the warning in 8.2
max_cores  = 4                             # 0 … 4 (5.4)
core_min   = 16                            # minimum area of further cores in bytes
fill_rows  = true                          # bands with uniform rows as row fill (5.6)
key        = "FF00FF"                      # optional
alpha_threshold = 0                        # 0 = off (2.3)

[[style]]                                  # order = style 0, 1, … (DMP style number = index + 1)
name = "brick"
png  = "brick_atlas.png"                  # atlas following the dbegeom template (3.2)

[[style]]
name     = "grating"
aseprite = "grating.json"                   # Aseprite export (3.3)
tag      = "grating"                        # or frame = 0
empty    = ["side_d3_s-3", "side_d3_s+3"]  # explicitly without image ($FE, 4.4)
```

Rules: unknown keys are errors; exactly one source per style (`png` or `aseprite`); 1 … 32 styles; names unique. CLI options override the same-named values from `[texset]`.

### 3.2 PNG atlas

One PNG per style, layout exactly like `<geom>_atlas.png` (P3, 7.2): the image for `name` lies at `atlas` (x, y in pixels) from the `geom.json` (`elements[]` and `band_images[]`), size 2w × h. The PNG must be at least `atlas_size` large (otherwise error); larger is allowed.

Which images apply (depending on `kind`):

| kind | Images (slice names) |
|---|---|
| wall | `front_d<d>_s+0` (full fronts), `side_d<d>_s<±s>` |
| floor | `floorband_d<d>`, `floor_d<d>_s<±s>` |
| ceiling | `ceilband_d<d>`, `ceil_d<d>_s<±s>` |

An image counts as **not present** if it is entirely transparent after 2.3 **or** exactly equals the unpainted template (mask `AAAAAA`, core `555555`, as in `_atlas.png`) – message "nicht bemalt" (info, not a warning).

### 3.3 Aseprite export (JSON + sprite sheet)

No parser for `.aseprite` binary files: whoever paints has Aseprite and thus the CLI; the JSON export is documented, text-based and covers frames, tags and slices. Expected invocation (also in the docstring and in the report):

```
aseprite -b zone1.aseprite --layer Image --sheet zone1.png --data zone1.json \
         --format json-array --list-slices --list-tags
```

What is read:

- `meta.image` (sheet PNG, relative to the JSON), `meta.size`.
- `frames`: list (`json-array`) or object (`json-hash`, order of keys = frame number). Per frame `frame` {x, y, w, h}. `rotated` = true or `trimmed` = true → error ("export without `--trim`/`--sheet-pack` rotation").
- `meta.frameTags` (optional): style via `tag = "<name>"` → first frame of the tag; otherwise `frame = n` (default 0). Tag spanning several frames → warning, first frame applies.
- `meta.slices`: per slice `name` and `keys[]` with `frame`, `bounds` {x, y, w, h}. The key with the largest `frame` ≤ the chosen frame is valid (Aseprite semantics). `bounds` are coordinates **in the sprite** (not in the sheet): pixel in sheet = `frame.x + bounds.x`, `frame.y + bounds.y`.
- Slice size must be 2w × h of the element (error otherwise, with expected and actual); the position is free (slices may be moved). `center` (9-patch) and `data` (user data) are ignored.
- Missing slice → image not present. Slice with an unknown name → warning. Same name twice → error.

The Aseprite template from P3 has the same slice names; the "Maske" layer must not be exported along with it (otherwise error per 2.3).

### 3.4 Geometry

Read from `geom.json`: `geometry_id`, `viewport` (width_px, height, stride, depth), `planes` (T, B per plane, for 5.5), `bands`, `band_images`, `elements` (index, name, art, d, s, rect, kernel, cover, flags, src_dx, mask, atlas), `atlas_size`. With `dvg`, the DVG is additionally read: magic, version, ID recomputed (P3, 5.5; bytes 10–11 `origin` and 12–13 before the CRC 0) and compared with the JSON ID, NE equal (error otherwise).

## 4. DTS format (version 1)

PRG file: 2-byte load address (`load`, default `$A000`, bank 1), then the content. All offsets are relative to the content (the byte after the load address), words low/high; this also applies to the offsets in the image directory (cores: byte offset of the first core in the core table, ROWS fill bytes, VMS lists). **VRAM offsets** are relative to the VRAM base that the game specifies at `TEXSET` (that is also where `RXV` goes with the corresponding VRL).

### 4.1 Header (32 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"D" "T"` (`$44 $54`) |
| 2 | Version = 1 |
| 3 | Kind: 0 wall, 1 floor, 2 ceiling |
| 4–5 | Geometry ID (from the DVG; `TEXSET` rejects on mismatch). `origin` is not part of the ID (P3, 5.5): DTS and DBG are valid for any position of the window in the buffer |
| 6 | NE: number of DVG elements (check) |
| 7 | D (check) |
| 8 | NS: number of slots |
| 9 | NST: number of styles (1 … 32) |
| 10 | NI: number of image entries (≤ 254) |
| 11 | NK: number of core entries |
| 12–13 | Offset slot map |
| 14–15 | Offset style table |
| 16–17 | Offset image directory |
| 18–19 | Offset core table |
| 20–21 | Offset data area (VMS lists, row fills) |
| 22–23 | Total length of the content |
| 24–25 | VRAM length U (= unpacked length of the VRL) |
| 26–27 | CRC of the VRAM data: `binascii.crc_hqx(data, 0xFFFF)` (check for tools and tests) |
| 28–29 | stride (check; also contained in the geometry ID) |
| 30–31 | reserved 0 |

Order of the areas: header, slot map, style table, image directory, core table, data area (gapless).

### 4.2 Slot map (NE + 2·(D + 1) bytes)

Assigns each drawing position a slot of this set (`$FF` = does not belong to this kind):

| Index | Drawing position |
|---|---|
| 0 … NE − 1 | DVG element with this index |
| NE + d | Ceiling band of depth d |
| NE + (D + 1) + d | Floor band of depth d |

Slots are assigned in this index order: first the elements of the kind in DVG order, then the bands of the kind (d = 0 … D, only bands with height > 0).

| Kind | Elements with slot | Bands |
|---|---|---|
| Wall | front (including partial fronts), side | – |
| Floor | floor | floor bands |
| Ceiling | ceiling | ceiling bands |

Westwood 140 × 96: wall NS = 25 (11 fronts, 14 sides), floor NS = 22 (18 + 4), ceiling NS = 22.

### 4.3 Style table (NST × NS bytes)

Style st, slot k → byte at `st · NS + k`:

| Value | Meaning |
|---|---|
| 0 … `$FD` | Index into the image directory |
| `$FE` | no image: draw nothing, cover nothing |
| `$FF` | **Fallback to style 0** (entry `0 · NS + k`); not allowed in style 0 itself |

Interplay with the DMP (review-notes D.4): DMP style number 0 = nothing, n ≥ 1 = style n − 1 of this DTS. n − 1 ≥ NST is a map error (`dbetex check`, 9.5; `VIEW` treats it like `$FE`).

The importer writes `$FF` when an image is missing for a style ≥ 1 (3.2, 3.3), `$FE` for images from `empty` and for missing images in style 0 (warning "style 0 without image for …"). A **partial front** gets the value of its cutout entry (4.4), derived from the full front of the same style; if the full front is missing, the same value applies to the partial front (`$FF` or `$FE`).

### 4.4 Image directory (NI × 16 bytes)

Each entry belongs to exactly one slot (an image is bound to the rectangle, mask and stride of its drawing position). Identical entries of different styles in the same slot (identical pixels per 2.3) are merged: one entry, identical VRAM data.

| Offset | Content |
|---|---|
| 0 | Flags: bit 0 OCCLUDING (5.5); bit 1 CUTOUT (partial front, 5.3); bit 2 ROWS (row fill, 5.6); bit 3 EDGE (VMS list present); rest 0 |
| 1 | Slot |
| 2 | nk: number of cores (0 … 4; 0 for ROWS) |
| 3 | h: rows of the drawing position (check; for ROWS the number of fill bytes) |
| 4–5 | Offset of the first core in the core table (nk consecutive entries); for ROWS the offset of the h fill bytes in the data area; otherwise 0 |
| 6–7 | VRAM offset of the packed edge bytes (0 without edge) |
| 8–9 | Number of edge bytes |
| 10–11 | Offset of the VMS list (0 = none) |
| 12–13 | Length of the VMS list in bytes (header + commands) |
| 14 | Source image: for CUTOUT the index of the full-front entry, otherwise own index |
| 15 | reserved 0 |

**Drawing an entry** (P6; target T0 = `AP + origin + y · stride + x` of the drawing position from the DVG or band row y0, x = 0):

1. Per core: `VMC VB + src, T0 + dy · stride + dx, w, h, stride[, srcstep]` – VCL type 2, with srcstep ≠ 0 type 3.
2. With EDGE: `VMS VB + edge_ofs, T0, list` – VCL type 12, list copied into the VMS buffer.
3. With ROWS: per row i `VMF T0 + i · stride, byte_i, w` – consecutive identical bytes merged into VCL type 5 (reps, step = stride).

Cores and edge do not overlap; the order is free.

### 4.5 Core table (NK × 8 bytes)

| Offset | Content |
|---|---|
| 0–1 | VRAM offset of the first source byte |
| 2 | dx (byte column relative to the rectangle of the drawing position) |
| 3 | dy (row relative to the rectangle) |
| 4 | w (bytes, ≥ 1) |
| 5 | h (rows, ≥ 1) |
| 6–7 | srcstep: 0 = source packed (w bytes per row, `VMC` "continue after the last run"), otherwise distance between two source rows (cutout: width of the full-front core) |

### 4.6 Data area

VMS lists and fill bytes, in directory order. VMS list in the VDC-BASIC format (`vms-format.md`, like SPR v1):

| Offset | Content |
|---|---|
| 0 | Alpha (0 … 15, 2.4) |
| 1–2 | Number of commands n |
| 3 … | n commands: type 1 = `01 ofs_lo ofs_hi len` (len 1 … 255), type 8 = `08 ofs_lo ofs_hi` |

ofs = row · stride + byte column, relative to the top-left corner of the drawing position (stride from the DVG). Type 2 is not generated.

### 4.7 Limits

NI ≤ 254, NST ≤ 32, NK ≤ 255, content ≤ 65535, U ≤ 65535 (VRL). On overflow: error with cause (e.g. "too many images: 261 > 254 - split styles across two DTS files").

## 5. Conversion per image

### 5.1 Flow

1. Read pixels from the source (3.2/3.3), convert to index or transparent per 2.2/2.3, apply element mask.
2. Byte states (2.4); image without opaque pixels → not present.
3. Check row fill (5.6, bands only).
4. Choose cores (5.4), the rest = edge.
5. Choose alpha, pack edge bytes, build VMS list (5.2).
6. Determine OCCLUDING (5.5).
7. For full fronts: derive cutouts of the partial fronts of the same depth (5.3).

### 5.2 Edge and VMS list

Rows r = 0 … h − 1, bytes bx = 0 … w − 1 from left to right; core bytes and empty bytes are skipped:

- maximally long run of full bytes (not in a core) → type 1, split if more than 255 bytes;
- half byte → type 8.

The packed edge bytes appear in exactly the order in which the commands consume them. Without edge bytes: no list, bit EDGE = 0.

### 5.3 Partial fronts (cutout of the full front)

Partial-front element (d, s ≠ 0) with rectangle (x, y, w, h) and src_dx (P3, 4.4); full front of depth d with width Wf. For each existing full front of a style and each partial front of its depth, an entry with bit CUTOUT is created (source image = full-front entry):

- **Cores:** for each core (kx, ky, kw, kh, src) of the full front, the intersection with the columns [src_dx, src_dx + w): a = max(kx, src_dx), b = min(kx + kw, src_dx + w); empty → dropped; otherwise dx = a − src_dx, dy = ky, w' = b − a, h = kh, src' = src + (a − kx), **srcstep = kw** (always, even if the cutout contains the core entirely). No new VRAM data (VCL type 3, review-notes C.2).
- **Edge:** The edge bytes of the full front in the visible columns are **repacked** (own VRAM data, own VMS list with offsets relative to the partial-front rectangle, alpha recomputed per 2.4). Reason: `VMS` reads the source strictly sequentially and cannot skip bytes (review-notes F.2). For opaque fronts without edge, a cutout costs only directory and core entries.
- OCCLUDING: per 5.5 for the partial-front element.

### 5.4 Cores

Up to `max_cores` rectangles of full bytes, greedy:

1. Candidates = full bytes not yet in any core.
2. Largest rectangle of candidates per P3, 4.4 (maximum area; tie: larger width, smaller ky, smaller kx). `dbetex` takes the algorithm from `dbegeom` (factor the function out onto the byte grid if necessary; both use the same one).
3. The **first** core is taken if h ≥ 1 and area ≥ 1; every **further** one only if h ≥ 2 and area ≥ `core_min`. Otherwise stop.

Consequence: for a fully painted, opaque image, core 1 equals the DVG core; the sum of core + edge is always the number of non-empty bytes. Multiple cores relieve the VMS buffer (windows, grilles: frame bars as cores instead of one long VMS list). Data in VRAM per image: core 1, core 2, …, edge.

The engine draws with the cores of the DTS, not with the DVG core (which only serves the template and the budget, review-notes F.4).

### 5.5 OCCLUDING

Only for elements with the DVG flag "column range valid" (front, side); otherwise 0. Bit 0 = 1 if in the image all bytes in columns c0 … c1 − 1 (absolute, from the DVG) and rows max(T_{d+1}, 0) … min(B_{d+1}, VH) − 1 (absolute; `planes` of the JSON) are **full**. This is exactly the condition under which P3 computes the column range, applied to the actual pixels. For fronts this means: all bytes of the rectangle full.

`VIEW` (P6) covers if DVG flag bit 0, tile flag OCCLUDING (DMP) **and** DTS bit OCCLUDING are set (review-notes D.5). Not covering is always correct (just extra work).

### 5.6 Row fill (bands)

With `fill_rows = true`: if every row of a band image consists of a single repeated byte value (solid color or a two-pixel pattern) and the band is entirely full, it is stored as an entry with bit ROWS: h fill bytes in the data area, **no VRAM**. Gradients (plan 5.2, `VMF` per row) thus arise automatically from a painted gradient. Otherwise a normal image (one core over the whole band).

## 6. DBG format (wallpaper, version 1)

### 6.1 Project file `bg.toml`

```toml
format  = "dbebg"
version = 1

[background]
name      = "sky"
geom      = "../geom/west140.geom.json"
png       = "sky.png"       # panorama: width 2·P pixels, height h
y0        = "horizon"          # row in the viewport for the first panorama row; number or "horizon"
                               # ("horizon": panorama centered on the horizon band, P3 4.5)
offsets   = "auto"             # or [o_N, o_O, o_S, o_W] in bytes; auto: o_v = v · P / 4 (P divisible by 4)
wrap      = true               # cyclic: o_v + VW may extend beyond P
above     = 2                  # color (0 … 15) or list per row for rows above the panorama
below     = 0                  # likewise below the panorama
out       = "build/tex"
load      = 0xA900
vrl_load  = 0x4000
```

The panorama must not have transparent pixels (error). Palette per 2.2. P ≥ VW, P · h ≤ 65535, y0 + h ≤ VH (error otherwise; y0 < 0 → error).

### 6.2 File

PRG file, load address `load` (bank 1). Offsets relative to the content.

| Offset | Content |
|---|---|
| 0–1 | `"D" "B"` (`$44 $42`) |
| 2 | Version = 1 |
| 3 | VW (check) |
| 4 | VH (check) |
| 5–6 | Geometry ID |
| 7–8 | P: panorama width in bytes |
| 9 | y0: viewport row of panorama row 0 |
| 10 | h: panorama height in rows |
| 11 | Flags: bit 0 WRAP |
| 12–19 | Offset o_v per viewing direction v = 0 N, 1 E, 2 S, 3 W (word, 0 … P − 1): panorama column at the left window edge |
| 20–21 | VRAM length U = P · h |
| 22–23 | CRC of the VRAM data (as in 4.1) |
| 24 … 24 + VH − 1 | Fill byte per viewport row (color · 17) for rows outside [y0, y0 + h); 0 inside |

VRAM data (own VRL, one `RXV` to the base): the panorama row by row, P bytes per row.

**Drawing** a row span [r0, r1) (P6, plan 5.1): within the panorama `VMC VB + (r0 − y0) · P + o_v, T0, n, r1 − r0, stride, P` with n = VW; if WRAP is set and o_v + VW > P, two parts (n1 = P − o_v from o_v, n2 = VW − n1 from column 0, target + n1). Outside: `VMF` per row with the fill byte (identical consecutive rows as VCL type 5). Without WRAP the importer checks o_v + VW ≤ P for all v (error otherwise).

Direction of rotation: turning right (N → E) increases o_v; with `auto` each direction shows a quarter of a 360° panorama.

## 7. Python API and reference renderer

### 7.1 API (`tools/dbetex.py`)

```python
@dataclass
class Core: src: int; dx: int; dy: int; w: int; h: int; srcstep: int
@dataclass
class Entry:
    slot: int; flags: int; cores: list[Core]; edge: bytes; edge_ofs: int
    vms: bytes; fill: bytes; source: int; style_names: list[str]
@dataclass
class TexSet:
    kind: int; geometry_id: int; ne: int; depth: int; stride: int
    slot_map: list[int]; styles: list[list[int]]; entries: list[Entry]; vram: bytes

def load_geom(path, dvg=None) -> dict
def read_rgba(path) -> PIL.Image                         # to RGBA
def to_indices(img, box, key=None, alpha_threshold=0, strict=False) -> (list[list[int|None]], list[str])
def classify(pix, mask) -> list[list[str]]                # 'F', 'L', 'R', '.' per byte (2.4)
def choose_cores(states, max_cores, core_min) -> list[tuple]
def pack_image(pix, states, cores, stride) -> (alpha, edge: bytes, vms: bytes)
def build_texset(conf) -> (TexSet, warnings)
def to_dts(ts, load) -> bytes ; def from_dts(data) -> TexSet
def build_background(conf) -> (dbg: bytes, vram: bytes, warnings)
def from_dbg(data) -> dict
def budget(paths, pool, vms_buffer) -> dict
```

`pack_image` and `classify` are deliberately independent of DTS so that P5b (sprite sets) can reuse them.

### 7.2 Simulator

```python
def sim_vmc(vram, src, dst, count, reps=1, dststep=0, srcstep=0)    # semantics like VDC-BASIC VMC (srcstep 0 = sequential)
def sim_vmf(vram, dst, byte, count)
def sim_vms(vram, src, dst, vms_list)                               # types 1 and 8 exactly per vms-format.md
```

`vram` is a `bytearray(65536)`. The simulators are the reference for the tests here and for the list comparison in P6.

### 7.3 Reference renderer

`render(ts, style, slot, vram, fb, ap=0, origin=0, stride=None, vb=0, geom=None, t0=None)` (`vb` = VRAM base of the image data in `vram`, `fb` = target buffer, may be the same array) draws an entry (after resolving `$FF`) per 4.4 with the simulators into an image buffer. `_preview.png` per style: wall – "corridor" (all cells s ≠ 0 wall, cell (D, 0) wall), for each depth D … 0 first the sides (|s| = 1), then (only at d = D) the fronts from outside to inside – painter's algorithm: side d lies between planes d and d + 1, thus behind front d; floor/ceiling – all bands or all tiles. Background black, output with palette 2.2, enlarged ×4.

## 8. Report and budget

### 8.1 Report per build (`.tex.md`, `.tex.json`)

- Header data (kind, geometry ID, NS, NST, NI, NK), sizes: DTS content, VRAM U, VRL stream (bytes, ratio from `vrl.stats`).
- Table per style × slot: entry, source (own, shared with style n, `$FF`, `$FE`), cores (count, bytes), edge bytes, VMS length, alpha, OCCLUDING, ROWS.
- Totals per style: VRAM (shared entries counted at the first style), VMS total.
- **VMS bound**: Σ over the slots of the maximum of the VMS lengths of all styles (wall: fronts + sides; floor/ceiling: tiles only, bands separate) – upper bound for one frame if all positions are visible. Compared with `vms_buffer` (default 1300, plan 3), warning on overflow.
- Warnings (palette, clipped, style 0 without image, alpha conflict), infos (not painted, merged).
- The output on stdout is a summary of a few lines (`zone1_walls: 3 styles, 41 images, VRAM 19 732 bytes, VRL 8 120 bytes, VMS bound 1 184/1300`).

### 8.2 Pool check (`budget`)

`dbetex.py budget FILE… --pool N [--vms-buffer N]` reads any number of DTS/DBG, sums U and lists:

| Row | Content |
|---|---|
| per file | Kind, U, share of the pool |
| Total | Σ U against `pool`; exit code 1 on overflow (message "Pool exceeded by n bytes") |
| VMS | wall bound + tile bounds (floor, ceiling) against the VMS buffer (warning only) |
| Remainder | free bytes for sprites (P5b) |

The game determines the VRAM bases; the tool merely recommends a dense sequence (base_i = pool start + Σ U of the previous ones), with `--pool-start ADDR` for the addresses.

## 9. CLI

```
dbetex.py build  TEX.toml [--out DIR] [--strict] [--key RRGGBB] [--alpha-threshold N] [--no-preview]
dbetex.py bg     BG.toml  [--out DIR] [--strict]
dbetex.py dump   FILE.dts|FILE.dbg [--vrl FILE.vrl] [--json]
dbetex.py budget FILE... --pool N [--pool-start ADDR] [--vms-buffer N] [--json]
dbetex.py check  MAP.dmp|MAP.toml [--walls W.dts] [--floors F.dts] [--ceils C.dts] [--dvg G.dvg]
```

- `dump`: header, slot map with element names (with `--json` or next to a `geom.json` with the same ID), style table, directory; with `--vrl` check CRC and U against the header.
- `check` (9.5; for `.toml` instead of `.dmp` with the tile names from the map, otherwise `k<index>`): every style number n ≥ 1 used in the DMP has n − 1 < NST in the DTS of the kind; geometry IDs of all DTS equal (and equal to the DVG); error list with tile name/index, exit code 1.
- Load addresses as in P1 (`0xA000`, `$A000`, `40960`). Exit code 0 ok, 1 format/validation error (message on stderr without traceback), 2 usage.

## 10. Tests (`test/tools/test_dbetex.py`, unittest) and example assets

### 10.1 Example assets

`tools/dbetexdemo.py OUTDIR [--geom GEOM.json]` generates deterministically (without randomness or with a fixed seed) from the geometry (default: `dbegeom` for 140 × 96 in memory):

| File | Content |
|---|---|
| `brick_atlas.png` | Wall, occluding: brick pattern in **wall space** (10.4: fronts and sides in perspective, joints run to the vanishing point; joint light gray 14, bricks alternating brown 12/red 8; 4 bricks per cell, 16 rows per cell height), only inside the mask |
| `grating_atlas.png` | Wall, not occluding: full fronts as a grille (vertical bars, two crossbars, rest transparent), sides like brick (in perspective); bar width 1 byte, spacing 1/6 cell rounded to bytes |
| `window.json` + `window.png` | Aseprite-style export (2 frames, tags `window`, `arch`; slices only for full fronts, one slice moved): front with transparent window or round arch |
| `stone_atlas.png` | Floor: bands solid-color rows (gradient dark gray → black, becomes ROWS), tiles paving in floor space (squares 1/4 cell, transverse joints per depth, longitudinal joints to the vanishing point) |
| `wood_atlas.png` | Ceiling: bands and tiles planks in ceiling space (longitudinal boards 1/6 cell to the vanishing point, butt joints every 1/2 cell; no ROWS) |
| `sky.png` | Panorama P = 4 · VW bytes, h = horizon band height + 6: sky light blue, mountains dark gray with peaks, one feature per quarter (visible for the offset test) |
| `walls.toml`, `floor.toml`, `ceil.toml`, `bg.toml` | Project files (styles: brick, grating, window, arch) |

The generated files live in `docs/specs/examples/tex/` in the repo (small, for the docs); the tests regenerate them in `tempfile.TemporaryDirectory`.

### 10.4 Perspective derivation (`tools/dbepersp.py`)

The engine projects nothing; every element is a finished image. A pattern painted in screen space is therefore wrong on sides, floor and ceiling (joints horizontal/vertical instead of toward the vanishing point). `dbepersp` computes the world coordinate per mask pixel and evaluates a flat pattern there (world unit: cells, plane 1 at Z = 1, Z_k = W_1 / W_k):

- 1/Z = W / W_1 is linear in x (x = C + X · W), for floor and ceiling linear in the row (W linear between planes from B_d to B_{d+1} or T).
- Front (plane d): u = (x − C) / W_d, v = (y − T_d) / W_d.
- Side at edge e: W(x) = (x − C) / e, u = Z = W_1 / W(x), v = (y − top(x)) / W(x), top linear in W between T_d and T_{d+1}. On the front edge v equals that of the front: rows connect, row height equal.
- Floor/ceiling: u = X = (x − C) / W, v = Z = W_1 / W.

API: `Persp(geom)`, `element_fn(persp, element, pattern, n=4, bias=None)` (returns `fn(px, r)` for mask painting), patterns `pattern(u, v) -> index | None` in cells (`brick_pattern()`, `flat_pattern(img, pixels_per_cell)` tiles a flat PNG and maps it to the palette). Per pixel n × n subsamples, weighted majority; `bias={color: weight}` preserves thin joints. Custom flat textures: pass `flat_pattern(Image.open(...), ppc)` to `element_fn` and paint into the atlas with a `_paint`-style loop (model: `dbetexdemo.make_ziegel`).

### 10.2 Fixed values (140 × 96, Westwood)

- Brick occluding: U = **11 094** (= P3 budget `wall_style`; sum core + edge = non-empty bytes), all 25 wall entries except 8 cutouts with own VRAM; cutouts without edge and without VRAM, 1 core each with srcstep = full-front width (d = 1: 50, d = 2: 32, d = 3: 20); core 1 of every image = DVG core; OCCLUDING on all 25.
- Floor "stone": U = 3 640 (tiles only; bands ROWS, 0 VRAM), 4 entries with ROWS and h = 13, 19, 13, 6.
- Ceiling "wood": U = 1 540 + 1 574 = 3 114.
- NS: wall 25, floor 22, ceiling 22; slot map in the wall DTS: `side_d0_s-1` (DVG index 3) → slot 0, `side_d0_s+1` (7) → 1, `front_d1_s+0` (11) → 2, `front_d1_s-1` (15) → 3; floor, ceiling and object-position elements → `$FF`.
- Header: magic, version, offsets gapless, total length, U = `vrl.unpacked_length` of the stream, CRC.

### 10.3 Properties

- **Image round trip:** For every style and slot: unpack VRL (`vrl.decode`) into a VRAM image at base VB = `$5000`; the reference renderer (7.3) draws into a buffer with random background (fixed seed); result pixel-identical to the expected image: opaque pixels from the PNG (palette 2.2, mask), transparent pixels = background. Also applies to partial fronts (expectation: columns src_dx … of the full front) and to row fills.
- **Alpha:** synthetic images with half-R bytes in color 0 → alpha ≠ 0, round trip correct; all 16 colors → warning, round trip with the documented replacement.
- **VMS list:** type 1 only for full bytes, type 8 only for half bytes, no commands for empty or core bytes; length ≤ 255 per type 1 (image with a 300-byte-wide run via `sim_vms` from a test rectangle with stride 320); edge bytes = sum of the lengths.
- **Cores:** full bytes only, disjoint, ≤ `max_cores`, further cores with h ≥ 2 and area ≥ `core_min`; `max_cores = 0` → everything edge; grille front: ≥ 2 cores, VMS length smaller than with `max_cores = 1`.
- **OCCLUDING:** brick 1; grille full front 0, its partial fronts 0; side with one transparent pixel outside the column range (above T_{d+1}) stays 1, inside → 0.
- **Styles:** missing image in style 1 → `$FF`; in style 0 → `$FE` and warning; `empty` → `$FE`; identical images in two styles → same index, VRAM once; partial front follows the full front (`$FF`/`$FE`).
- **Inputs:** palette exact / deviation (warning, `--strict` error); alpha 128 → error with hint "mask layer"; `key`; indexed PNG with reordered palette yields the same indices; pixels outside the mask → warning, discarded; unpainted template (`_atlas.png` from dbegeom) → all images "nicht bemalt"; atlas too small → error.
- **Aseprite JSON:** `json-array` and `json-hash`; tag and frame; slice key selection by frame; wrong slice size → error; `trimmed` → error; moved slice is found; unknown slice → warning.
- **Geometry:** `dvg` with a different ID → error; DTS from 136 × 92 with the geometry 140 × 96 in `check` → error.
- **DBG:** header; round trip: for v = 0 … 3 horizon rows via `sim_vmc` (with WRAP split) = expected window from the panorama starting at o_v (cyclic); fill bytes above/below the panorama; P not divisible by 4 with `auto` → error; without WRAP and o_v + VW > P → error; transparent pixel → error.
- **Budget/check:** sum of three files against pool (under/over, exit code 0/1); `check` with the demo map (`demo.toml`, wall styles 1, 2; floor 1; ceiling 1) against a 1-style DTS: wall style 2 missing → error with tile name `grating`; with 2 styles ok.
- **Determinism:** built twice = same bytes (DTS, VRL, DBG).
- **CLI:** `build`, `bg`, `dump --json`, `budget`, `check` via `subprocess`; format errors → exit code 1 without traceback.

Runtime of the test file < 60 s.

## 11. Outlook P5b: sprite sets v2 (interface only)

A separate step, because two questions are open that co-determine P6 (clipping, depth levels) and because the VRAM budget shapes asset planning.

- **One image per (phase, viewing angle, depth d = 1 … D)**, hand-painted, no scaling at runtime; independent of s and sub-position. Viewing angles: 1 (object), 2 or 4. d = 0 is not drawn (plan 5).
- Per image a **foot point** (byte column, row in the image); `VIEW` places it at the DVG anchor (d, s, p): target = anchor − foot point.
- Image data like DTS entries (cores + edge + VMS list, `pack_image` from 7.1), directory entry 16 bytes plus foot point; data again as one VRL per set.
- **Clipping at the window edge is unsolved:** An image at s = ±1 sticks out sideways from the window; `VMS` would write outside (HUD, line wrap). Cores can be clipped via `VMC` with srcstep; VMS lists cannot, because the source is read sequentially. Options: (a) `VIEW` redirects commands outside to a scratch area in VRAM while copying the list (offset = scratch area − target, mod 65536; runs at the edge split), (b) precomputed lists per edge position, (c) VDC-BASIC gets a skip command in `VMS`. **Decided (plan 9): (c)**, new list command "advance source by n bytes" in VDC-BASIC v3; the engine trims the lists while copying into the buffer. Consequence for DTS v2 (not v1): partial fronts could then reuse the edge bytes of the full front instead of repacking them (5.3, review-notes F.2).
- **Budget:** An enemy with 4 viewing angles × 2 phases × 3 depths needs roughly 6–9 KB; after one wall style and bands, about 10 KB remain in the 26 KB pool (review-notes C.2). P5b must provide savings variants (fewer viewing angles, phases only for d = 1, shared images).
- Object list and viewing angles as in plan 5; set format "SPR v2" with magic `"S" "2"`.

## 12. Acceptance

- `tools/dbetex.py` (docstring in the style of `wallconv.py`, with the Aseprite invocation from 3.3), `tools/dbetexdemo.py`, `test/tools/test_dbetex.py` green.
- Examples in `docs/specs/examples/tex/` (10.1) with the reports built from them (`.tex.md`).
- `docs/formats.md` gets "DTS v1" (4.1–4.6) and "DBG v1" (6.2), brief, with a reference to here.
