# P5b: Sprite sets v2 – `tools/dbespr.py`, format S2, clipping

As of 2026-11-25. Detailed specification for step P5b (plan 5, 6; `P5-textures.md` 11). Implementation: Sonnet. Review: Opus. Dependencies: Python ≥ 3.11, Pillow, `tools/vrl.py`, `tools/dbetex.py` (P5, as a module), `tools/dbegeom.py` (tests only). Prerequisite in VDC-BASIC v3: VMS list command type 3 (source skip, present since `c57ba31`).

## 1. Goal and scope

- **Dynamic objects** (enemies, items, projectiles, effects) as hand-painted images per **(phase, view angle, depth d = 1 … D)**. No scaling or mirroring at runtime; d = 0 is not drawn (plan 5).
- An image is **independent of s and sub-position**. `VIEW` (P6) places it with its **foot point** on the DVG anchor (d, s, p) and **clips** it at the viewport and at occluded columns.
- Image data like DTS entries: cores (`VMC`) and edge (`VMS` type 1/8, packed). One set = one metadata file (bank 1) + one VRL (bank 0 → `RXV` to the VRAM base), like DTS (P5 1).
- The animation is controlled by the game (phase number in the object list). The set contains the Aseprite tags only as a table (name, first phase, count, mode, duration) for the game and the report. `VIEW` does not animate.
- **Own tool** `tools/dbespr.py` instead of extending `dbetex.py` (1447 lines there); it imports `to_indices`, `classify`, `choose_cores`, `pack_image`, `sim_*`, `read_rgba`, `PALETTE` from `dbetex`.
- The **clipping function** `clip_image` (section 6) is the reference for `VIEW` (P6, 5.9) and for the list comparison.

Not in P5b: adapting the Crawl sprites (`crawlsprites.py` → S2, belongs to P7), runtime animation, mirroring.

## 2. Terms

| Term | Meaning |
|---|---|
| Phase f | 0 … NP − 1; frame number in Aseprite |
| View angle a | 0 … 3, from player and object direction: a = (2 + v − o) AND 3 (v player, o object, as SPR v1). **0 = front** (object faces the player), **1 = right flank of the figure**, **2 = back**, **3 = left flank**. Object direction `$FF` → a = 0 |
| Image angle ai | 0 … NA − 1; index of the painted view. `angle_map[a]` maps a to ai |
| Depth d | 1 … D (D from the DVG) |
| Image rectangle | w bytes × h rows; byte bx = 2 pixels (left = high nibble, P5 2.1) |
| Foot point (fx, fy) | byte column and row **in the image** that comes to lie on the DVG anchor (ax, ay): image top left = (ax − fx, ay − fy) |

Default for `angle_map` (can be overridden):

| NA | angle_map (a = 0, 1, 2, 3) | Meaning |
|---|---|---|
| 1 | 0, 0, 0, 0 | one view (items) |
| 2 | 0, 0, 1, 0 | front, back; flanks show front |
| 3 | 0, 1, 2, 1 | front, flank, back |
| 4 | 0, 1, 2, 3 | all |

## 3. Inputs

### 3.1 Project file `spr.toml`

```toml
format  = "dbespr"
version = 1

[sprite]
name       = "ork"
geom       = "../geom/west140.geom.json"   # mandatory (stride, D, planes, anchors)
dvg        = "../geom/west140.dvg"         # optional: cross-check ID
out        = "build/spr"
load       = 0x7000                        # load address S2 (bank 1, P6 memory map)
vrl_load   = 0x4000
angles     = 4                             # NA, 1 … 4
angle_map  = [0, 1, 2, 3]                  # optional, default per table 2
phases     = 2                             # NP, 1 … 32; missing: from the source (highest phase + 1)
max_cores  = 4                             # 0 … 16 (as P5 5.4, upper limit see review-notes G.2)
core_min   = 16
key        = "FF00FF"                      # optional (P5 2.3)
alpha_threshold = 0
any_geometry = false                       # true: write geometry ID 0 (only stride and D bind, 4.1)
mirror     = { 3 = 1 }                     # optional: image angle 3 = mirrored image angle 1 (tool, not runtime mirroring)
derive     = "none"                        # "none" | "nearest": shrink missing depths from the next larger painted image (5.4)

[source]
aseprite = "ork.json"                      # Aseprite export (3.2)
# or: png = "ork.png" with [[image]] entries (3.3)
```

Rules: unknown keys are errors (as P5 3.1); exactly one source; `angle_map` has 4 values < NA; `mirror` only between existing image angles; CLI options override `[sprite]`.

### 3.2 Aseprite export

Convention in the `.aseprite` file:

| Aseprite | Meaning |
|---|---|
| **Layer** `v<ai>_d<d>` (e.g. `v0_d1`) | view ai at depth d; each depth is painted at its own size |
| **Frame** f | phase f |
| **Tag** (name, frames from–to, direction) | animation: phases from–to; direction `forward`, `reverse`, `pingpong` |
| **Slice** `v<ai>_d<d>` with pivot | image rectangle and foot point (pivot = foot point, relative to the slice); keys per frame allowed (valid: largest key frame ≤ f, P5 3.3) |
| other layers (e.g. `ref`, `Hilfslinien`) | ignored if their name does not match the pattern (info) |

Invocation (in the docstring and in the report):

```
aseprite -b ork.aseprite --split-layers --sheet ork.png --data ork.json --format json-array \
         --filename-format '{layer}#{frame}' --list-layers --list-tags --list-slices
```

What is read:

- `frames`: per entry `filename` = `<layer>#<frame>`, `frame` {x, y, w, h} in the sheet, `duration` (ms). `trimmed`/`rotated` = true → error (as P5 3.3). Without trim, every sheet frame is as large as the canvas.
- `meta.frameTags`: name, `from`, `to`, `direction` (missing: `forward`).
- `meta.slices`: name, `keys[]` with `frame`, `bounds` {x, y, w, h} (canvas coordinates), optional `pivot` {x, y} (relative to `bounds`).
- Per (layer `v<ai>_d<d>`, frame f): pixels per P5 2.2/2.3 (palette, alpha, `key`).
  - **Slice present:** image = pixels within `bounds`; opaque pixels of the layer outside → warning “N pixels outside the slice, discarded”. Foot point = `pivot`; without pivot: middle of the bottom row (x = ⌊w_px / 2⌋, y = h − 1).
  - **No slice:** image = smallest rectangle around all opaque pixels; foot point = middle of the bottom row. Info “foot point automatic”.
  - **Empty cel** (no opaque pixels): no image for (f, ai, d).
- Layer with unknown ai ≥ NA or d > D or d = 0 → error.

### 3.3 PNG with image list

```toml
[source]
png = "gem.png"

[[image]]                 # one entry per image
box   = [0, 0, 12, 10]    # x, y, w, h in pixels
foot  = [6, 9]            # relative to box, in pixels; missing: middle of the bottom row
phase = 0
angle = 0                 # ai
depth = 1
```

Same (phase, angle, depth) twice → error. For items and tests; animations without tags.

### 3.4 Byte grid and foot point

- The image begins at the **even** pixel column x_e = box.x − (box.x mod 2); w = ⌈(box.x + box.w − x_e) / 2⌉ bytes. Additional edge pixels are transparent.
- fx = ⌊(box.x + foot_x − x_e) / 2⌋, fy = foot_y. If the foot point lies on the right pixel of a byte, info “foot point rounded to byte boundary” (anchors are byte-exact, P3 4.3).
- Checks: 1 ≤ w ≤ min(VW, 127), 1 ≤ h ≤ VH, 0 ≤ fx < w, 0 ≤ fy < h (otherwise error).
- **Height check (warning):** image taller than the wall at its depth, i.e. top edge ay − fy < T_d with ay = row of anchor p = 0 (back left) of cell (d, 0) and T_d = wall top edge of plane d (`planes`). Reason: whatever protrudes above the wall top edge protrudes into the ceiling; `VIEW` draws the sprite completely and lets nearer walls and the ceiling bands of nearer depths paint over it (since P6i no more clipping by columns, P6 5.4/5.8a, review-notes G.8).

## 4. Format S2 (version 1)

PRG file: 2 bytes load address (`load`, default `$7000`, bank 1), then the content. Offsets relative to the content, words low/high. VRAM offsets relative to the VRAM base from `SPRITESET` (P6). Areas contiguous in the order header, index table, image directory, core table, tag table, data area.

### 4.1 Header (40 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"S" "2"` (`$53 $32`) |
| 2 | version = 1 |
| 3 | flags: bit 0 = item (only a hint for tools; `dbespr` sets it for NA = 1); rest 0 |
| 4–5 | geometry ID of the DVG; **0 = any geometry** with the same stride and D (`any_geometry`) |
| 6 | D (check; depths 1 … D in the index table) |
| 7 | NA (1 … 4) |
| 8 | NP (1 … 32) |
| 9 | NI: number of images (≤ 254) |
| 10–11 | NK: number of cores (word) |
| 12–15 | `angle_map[0 … 3]` |
| 16–17 | offset of index table |
| 18–19 | offset of image directory |
| 20–21 | offset of core table |
| 22–23 | offset of tag table |
| 24 | NT: number of tags (≤ 32) |
| 25 | reserved 0 |
| 26–27 | offset of data area (VMS lists) |
| 28–29 | total length of the content |
| 30–31 | VRAM length U (= unpacked length of the VRL) |
| 32–33 | CRC of the VRAM data (`binascii.crc_hqx(data, 0xFFFF)`) |
| 34–35 | stride (check) |
| 36–39 | reserved 0 |

Note: the offsets of the four tables are in 16–23 one after another; NT follows as a byte at 24 (25 = 0), the offset of the data area is only in 26–27.

### 4.2 Index table (NP · NA · D bytes)

Entry for (f, ai, d) at `(f · NA + ai) · D + (d − 1)`:

| Value | Meaning |
|---|---|
| 0 … `$FD` | image index |
| `$FE` | no image: draw nothing |
| `$FF` | fall back to **phase 0** of the same (ai, d); not allowed in phase 0 |

The importer writes `$FF` for missing images in phase ≥ 1, `$FE` for missing images in phase 0 (warning “phase 0 without image for v<ai>_d<d>”, except with `derive`). `VIEW`: f ≥ NP → f = 0.

### 4.3 Image directory (NI × 16 bytes)

| Offset | Content |
|---|---|
| 0 | flags: bit 3 EDGE (VMS list present); rest 0 |
| 1 | w (bytes) |
| 2 | h (rows) |
| 3 | fx |
| 4 | fy |
| 5 | nk: number of cores (0 … 16) |
| 6–7 | offset of the first core in the core table (relative to the content; 0 for nk = 0) |
| 8–9 | VRAM offset of the packed edge bytes |
| 10–11 | number of edge bytes |
| 12–13 | offset of the VMS list (0 = none) |
| 14–15 | length of the VMS list (header + commands) |

Identical images (same pixels, w, h, fx, fy) are merged (one entry, VRAM once).

### 4.4 Core table (NK × 8 bytes)

As DTS (P5 4.5): VRAM offset (word), dx, dy (relative to the image rectangle), w, h, srcstep (word, 0 = packed). In S2, srcstep is always 0.

### 4.5 Tag table (NT × 12 bytes)

| Offset | Content |
|---|---|
| 0–7 | name, ASCII (PETSCII-compatible: uppercase letters, digits, `_`), padded with `$00`, truncated to 8 characters (warning on truncation or duplication) |
| 8 | first phase |
| 9 | number of phases |
| 10 | mode: 0 forward, 1 reverse, 2 pingpong |
| 11 | duration per phase in jiffies (1/60 s): round(ms · 60 / 1000), at least 1, at most 255; unequal durations within a tag → average, warning |

### 4.6 Data area

VMS lists in VDC-BASIC format (P5 4.6), type 1 and 8 only. Additional **format rules** (for clipping, P6 5.9, review-notes G.7): commands in row order with strictly increasing ofs, without overlap (ofs ≥ ofs + len of the previous command, type 8: len = 1); ofs = row · stride + byte column relative to the top left image corner, row < h; a type 1 run stays within its row (column + len ≤ w ≤ stride). `pack_image` (P5 5.2) satisfies this; `from_s2` and `from_dts` check it (`dbetex.check_vms`, P6e-opt review), `VIEW` relies on it when clipping.

### 4.7 Limits

NI ≤ 254, NP ≤ 32, NA ≤ 4, NT ≤ 32, nk ≤ 16, NK ≤ 65535, content ≤ 8192 (one set fits in the sprite area of the bank 1 memory map, P6 2.4; warning from 4096, because such a set occupies more than half of the area), U ≤ 65535. Exceeding: error with cause.

## 5. Conversion

### 5.1 Per image

1. Pixels per 3.2/3.3 and P5 2.2/2.3, byte grid per 3.4.
2. `classify(pix, None)` (no element mask), `choose_cores(states, max_cores, core_min)`, `pack_image(pix, states, cores, stride)` with the stride of the geometry.
3. VRAM data per image: core 1, core 2, …, edge (as P5 5.4).

### 5.2 Order and merging

Images in the order (f, ai, d) ascending; an image that equals an earlier one gets its index. VRAM data in directory order, contiguous.

### 5.3 Mirroring (`mirror`)

`mirror = { target = source }`: for every (f, d) without an image of its own in the target image angle, the image is produced from the source by mirroring the pixel rows; foot point fx' = w − 1 − fx (re-rounded per 3.4 for an odd foot point pixel). Occupies VRAM like a painted image.

### 5.4 Derived depths (`derive = "nearest"`)

If a depth d is missing for an (f, ai) (and no `$FF` fall back to an image in phase 0 applies) but there is a **painted** image at a depth d' < d, the image from the largest such depth d' (next larger image; derived images are not a source) is shrunk with nearest neighbour: factor k = W(½, d) / W(½, d') with W(t) per P3 4.3 (cell width at half cell depth, from `planes` of the geom.json); new pixel size round(w_px · k) × round(h · k), at least 1; foot point scaled. Warning “Tiefe d aus Tiefe d' abgeleitet”. Only as an aid for prototypes; the engine still distorts nothing.

## 6. Clipping: `clip_image` (reference for P6)

```python
def clip_image(img, x0, y0, cx0, cx1, cy0, cy1, stride) -> Clipped
```

`img` = image entry (w, h, cores, edge VRAM offset, VMS list), (x0, y0) = top left image corner in the viewport (byte column, row; signed), [cx0, cx1) × [cy0, cy1) = visible cutout in the viewport (P6 determines it from the window, since P6i no longer from the coverage; always ⊆ image rectangle and not empty), stride = stride of the geometry (S2 header 34). In the image: L = cx0 − x0, R = cx1 − x0, T = cy0 − y0, B = cy1 − y0. **Unclipped** means L = 0, R = w, T = 0, B = h.

Result: list of core copies, optionally a new VMS list, reference point.

### 6.1 Cores

Per core (kx, ky, kw, kh, src, srcstep), step width st = srcstep if ≠ 0, otherwise kw:

- Columns a = max(kx, L), b = min(kx + kw, R); rows c = max(ky, T), e = min(ky + kh, B). Empty → core dropped.
- src' = src + (c − ky) · st + (a − kx); destination = row y0 + c, column x0 + a; width b − a, rows e − c.
- srcstep' = srcstep if a = kx and b = kx + kw (full width), otherwise st. (Full width with srcstep 0 stays packed: VCL type 2; otherwise type 3.)

### 6.2 VMS list

Unclipped: list unchanged, reference point (x0, y0).

Clipped: **reference point (cx0, cy0)**; the list is rewritten. Pass over the commands with row counter r and row start rs (r = 0, rs = 0 at the beginning; before each command `while ofs ≥ rs + stride: rs += stride; r += 1`), column col = ofs − rs, read counter “pending jump” k = 0:

| Command | visible if | Output |
|---|---|---|
| Type 1 (ofs, len) | T ≤ r < B and [col, col + len) ∩ [L, R) ≠ ∅ | a = max(col, L), b = min(col + len, R): k += a − col; if k > 0: type 3 (k), k = 0; type 1 (ofs' = (r − T) · stride + (a − L), b − a); k += col + len − b |
| Type 1, invisible | otherwise | k += len |
| Type 8 (ofs) | T ≤ r < B and L ≤ col < R | if k > 0: type 3 (k), k = 0; type 8 (ofs' as above with a = col) |
| Type 8, invisible | otherwise | k += 1 |

- As soon as r ≥ B, the pass ends (rest dropped, no trailing type 3).
- A pending k at the end is not output.
- Header of the new list: alpha unchanged, count = number of commands output (including type 3). Type 3 has the format `03 n_lo n_hi` (VDC-BASIC `vms-format.md`); k ≤ 65535 (edge bytes ≤ U).
- If no type 1 or type 8 command remains, the list is dropped entirely (result without VMS).
- Length: the new list is at most 3 · (B − T) bytes longer than the stored one (at most one type 3 per visible row; a type 1 run is never split). Dimension the buffer reserve in P6 accordingly.
- ofs' is always < 65536, because the cutout lies in the viewport (P6 computes the destination as `AP + row address(cy0) + cx0`).

### 6.3 Further functions

```python
def render_image(s2, img_index, vram, fb, x0, y0, vp, ap=0, vb=0, clip=None)   # draws via clip_image + sim_*
def from_s2(data) -> SpriteSet ; def to_s2(ss, load) -> bytes
def lookup(ss, phase, a, d) -> int | None      # 4.2 incl. angle_map, $FF, f >= NP
```

`dbetex.sim_vms` gets type 3 (read counter += n, write nothing); type 2 stays unused.

## 7. Report, budget

### 7.1 Report (`<name>.spr.md`, `<name>.spr.json`, one line on stdout)

- Header (NA, NP, D, NI, NK, NT), S2 content (bank 1), VRAM U, VRL stream.
- Table per (f, ai, d): index, source (own, shared, mirrored, derived, `$FF`, `$FE`), w × h, foot point, cores/core bytes, edge bytes, VMS length, **VCL bytes** (11 or 13 per core + 7 for edge).
- **Buffer:** largest VMS list and largest sum VCL + VMS of one image; warning if an image needs more than 1/3 of the shared buffer (P6: 2304 bytes).
- Warnings (palette, outside the slice, height check 3.4, tag truncated, phase 0 without image), infos.
- Tags as a table and as BASIC aid: `REM ORK: IDLE 0-1 30J, WALK 2-5 8J`.

### 7.2 Budget (reference values, 140 × 96)

Per P3/P5: 1 wall style + floor and ceiling bands ≈ 16 KB in the 26 KB pool, about 10 KB remain for wallpaper and sprites (review-notes C.2, F.9). Estimate for a figure with 40 % of the cell width and 70 % of the wall height, 65 % coverage:

| Depth | Image approx. | VRAM approx. |
|---|---|---|
| d = 1 | 20 × 54 bytes | 700 |
| d = 2 | 13 × 35 | 300 |
| d = 3 | 8 × 22 | 115 |

| Economy variant | VRAM per enemy type |
|---|---|
| 4 view angles × 2 phases × 3 depths | ≈ 8.9 KB |
| 4 view angles, 2 phases only in d = 1 (`$FF` otherwise) | ≈ 7.3 KB |
| 2 view angles (front/back), 2 phases only in d = 1 | ≈ 3.6 KB |
| 1 view angle, 2 phases in d = 1 | ≈ 1.8 KB |
| Item, 1 image per depth | 0.1–0.4 KB |

`dbespr.py budget` = `dbetex.py budget` with S2 files (the P5 function additionally reads S2: kind “Sprite”, U).

## 8. CLI

```
dbespr.py build SPR.toml [--out DIR] [--strict] [--key RRGGBB] [--no-preview]
dbespr.py dump  FILE.s2 [--vrl FILE.vrl] [--json]
dbespr.py preview FILE.s2 --vrl FILE.vrl --geom G.json [--d D] [--phase F] [--angle A] [--out PNG]
```

`preview`: all images of one depth on all sub-positions of cells (d, s) over a grid, clipped per 6 (shows the clipping at the edge), ×4. `build` writes `<name>.s2`, `<name>.vrl`, report and `<name>_preview.png`. Exit codes as P5.

## 9. Tests (`test/tools/test_dbespr.py`, unittest)

### 9.1 Example assets

`tools/dbesprdemo.py OUTDIR [--geom G.json]` generates deterministically:

| File | Content |
|---|---|
| `blob.json` + `blob.png` | Aseprite-style export, `--split-layers` names: layers `v0_d1 … v3_d3`, 2 frames, tags `idle` (0–0), `walk` (0–1, pingpong, 150 ms), slices with pivot for d = 1, without slice for d = 2 (automatic), `v0_d3` empty in frame 1 (→ `$FF`); figure with half bytes at the edge, odd width and a hole (eye transparent) |
| `gem.png` + `gem.toml` | PNG with image list, NA = 1, NP = 2 (sparkle), depths 1–3 |
| `blob.toml` | project file (NA 4, `mirror = {3 = 1}` as second variant `blob_m.toml`) |

Copies in `docs/specs/examples/spr/` (small); tests regenerate in the temp directory.

### 9.2 Properties

- **Round trip:** unpack the VRL to VB = `$5000`; per image `render_image` unclipped at (x0, y0) = (10, 20) on a random background = expected image (opaque pixels from the source, rest background).
- **Clipping:** per image all cutouts with L, R ∈ {0, 1, w/2, w − 1, w} and T, B ∈ {0, 1, h − 1, h} (not empty): result = expected image only within the cutout, background everywhere else (in particular **no byte outside** the cutout changed, checked over the whole 64 KB field); new list only with type 1/3/8, type 3 never at the end, never two type 3 in a row; sum of all consumed bytes ≤ edge bytes.
- **Unclipped** = list byte-identical to the stored one.
- **Cores:** srcstep rule 6.1 (type 2 stays type 2 at full width, also with T > 0).
- **Index:** `lookup` for all (f, a, d) incl. f ≥ NP, `$FF` → phase 0, `$FE`, angle_map defaults per NA, object direction `$FF` → a = 0.
- **Aseprite:** slice with/without pivot, key selection per frame, without slice (bbox), empty cel, unknown layer (info), ai ≥ NA → error, `trimmed` → error, `json-hash` and `json-array`.
- **Byte grid:** box.x odd → x_e, foot point rounding with info.
- **Mirroring, deriving:** mirrored image = horizontally mirrored pixels; derived size per 5.4.
- **Format:** header, offsets contiguous, length, CRC, U = VRL; `from_s2(to_s2(x))` = x; determinism (built twice = same bytes); limits 4.7.
- **VMS format rules 4.6** for all generated lists.
- **CLI** via `subprocess`; format error → exit code 1 without traceback.

Run time < 60 s.

## 10. Acceptance

- `tools/dbespr.py`, `tools/dbesprdemo.py`, `test/tools/test_dbespr.py` green; `dbetex.sim_vms` with type 3 (existing P5 tests green).
- Examples in `docs/specs/examples/spr/` with report.
- `docs/formats.md` gets “S2 v1” (4.1–4.6, brief).
