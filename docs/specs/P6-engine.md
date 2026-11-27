# P6: Engine 0.2 in 6502 – Memory, Functions, `VIEW`, Tests

Status: 2026-11-25. Detailed specification for step P6 from `docs/plan-0.2.md` (sections 3, 5, 8). Implemented in sub-steps P6a–P6h (section 10). Review: Opus. Foundations: `P3-geometry.md` (DVG), `P4-map.md` (DMP), `P5-textures.md` (DTS, DBG), `P5b-sprites.md` (S2, `clip_image`), VDC-BASIC v3 (`vcl-format.md`, `vms-format.md` with type 3, `RXV`), `review-notes.md`.

## 1. Overview

The lib remains a bank 1 library behind the stub (`SYS 3331,F,X,Y`). It reads DVG, DMP, DTS, DBG and S2 from bank 1 and writes the **VCL list and the VMS lists** into a buffer in the shared RAM (bank 0), which BASIC executes with `::VCL`. New compared to 0.1:

- 8 KB shared RAM (`$0000–$1FFF`), buffer `$1300–$1BFF` for VCL and VMS lists together, object list 16 × 6 bytes at `$0C50`.
- Geometry, textures, wallpaper and sprites from the P3/P5/P5b formats; DMP map.
- `VIEW` according to plan 5: visibility front → back with column mask, output back → front; per depth wallpaper, ceiling, floor, cells outside → inside with wall faces or objects by sub-position; clipping of sprites at the viewport via VMS type 3 (since P6i no longer at occluded columns: occlusion of sprites only via the paint order).
- `WALLSET` (WSM) and sprite sets v1 are dropped (0.1 formats). Crawl is brought onto DVG/DTS/S2 in P7 via a converter (review-notes G.6).

Not in P6: `ENEMYSTEP` (enemy AI), runtime animation, resident VMS lists in bank 0 (section 12), DTS v2.

## 2. Memory

### 2.1 Shared RAM and stub

- During the call the stub sets `$D506` = (old AND `$F0`) OR **`$06`** (8 KB shared at the bottom; 0.1: `$05` = 4 KB) and `$FF00 = $7F` (bank 1 without I/O, P6d-opt; previously `$7E`). Interrupt switch `$FF05–$FFFF` in bank 1. Zero page: `$FA–$FD` and the block **`$63–$72`** (FAC/ARG), which the stub saves before the calls that use it (`VIEW`, `GEOMSET`, test function 253; `dbe.inc` `ZPB_F*`), and writes back afterwards (proof `test/vice_zp.py`, result P6d-opt; usage per function `--funcs`, result P6j).
- During the call the lib sees bank 0 at `$2000`. Consequence: **no engine data in bank 1 below `$2000`**. BASIC variables in bank 1 from `$0400` are not affected (they are only used outside the call; correction to P2a 4, review-notes G.16).
- Bank 0 `$1C00–$1FFF` is VDC-BASIC v3; the lib never writes there (BUFSET checks, 3.3).

### 2.2 Bank 0

| Area | Contents |
|---|---|
| `$0B00–$0BFF` | Engine reserve (P6e-opt: `VIEW` writes garbage here during the counting dry run of clipped VMS lists); cassette/boot sector buffer of the system |
| `$0C00–$0CFF` | Parameter block (2.3), object list; RS-232 input buffer of the system (used this way since 0.1) |
| `$0D00–$0DFF` | Stub (`$0D00` init, `$0D03` call), rest reserve |
| `$0E00–$0FFF` | free (0.1: VMS buffer); VIC sprite data of the system |
| **`$1300–$1BFF`** | **Engine buffer** (default, `BUFSET`): VCL list at the start, VMS lists directly behind it |
| `$1C00–$3FFF` | VDC-BASIC v3 |
| `$4001–` | BASIC program or Blitz! compilation (image 2); above it the game's load buffer for VRL files (P7 determines the location) |

### 2.3 Parameter block (`$0C00`, bank 0)

| Address | Name | Contents |
|---|---|---|
| `$0C00–$0C07` | P0–P3 | Words, input and output of the functions |
| `$0C08` | ITEMPH | Phase for items from the content layer (glitter; game sets) |
| `$0C09` | – | reserved 0 |
| `$0C0A–$0C0B` | VCLADR | `VIEW`: address of the VCL list (= B1 − VCLLEN; P6d-opt, previously buffer start; with fixed list address = B0, with a jump to B1 − VCLLEN there, P6j) |
| `$0C0C–$0C0D` | VCLLEN | `VIEW`: length of the VCL list including end byte |
| `$0C0E–$0C0F` | VMSLEN | `VIEW`: bytes of the VMS lists |
| `$0C10–$0C11` | OBJVIS | `VIEW`: bit i = object i was output (wholly or partially) |
| `$0C12–$0C3F` | – | Reserve |
| `$0C40–$0C4F` | – | tests only (timing, scene hook as in 0.1) |
| **`$0C50`** | OBJN | Object list: count (0 … 16; larger is read as 16) |
| `$0C51–$0CB0` | OBJL | 16 × 6 bytes (2.5) |
| `$0CB1–$0CFF` | – | Reserve |

### 2.4 Bank 1 (memory map G, default; P6h: `MEMSIZ $4000`)

All addresses are parameters of the functions; the table is the default for tools (load addresses, `tools/dbemem.py`) and games. Compared to map F (P6a, `MEMSIZ $5000`), the BASIC variables are limited to `$0400–$3FFF`; the 4 KB `$4000–$4FFF` go to the assets (wall DTS 8 → 12 KB), and all areas above shift down by 4 KB.

| Area | Size | Contents | Default load address (tool) |
|---|---|---|---|
| `$0000–$1FFF` | – | during the call bank 0 (shared): no engine data | – |
| `$0400–$3FFF` | 15 KB | BASIC variables, arrays, strings; the game limits to `$4000` with `POKE 57,0:POKE 58,64:CLR` as its first statement (interpreted and Blitz!) | – |
| `$4000–$5FFF` | 8 KB | DMP (W·H ≤ about 4000), optionally working copy for small maps | `dbemap`, `crawlmap` `$4000` |
| `$6000–$7FFF` | 8 KB | Sprite sets S2 (several one after another) | `dbespr` `$6000` |
| `$8000–$AFFF` | 12 KB | DTS wall | `dbetex` wall `$8000` |
| `$B000–$DBFF` | 11 KB | **Lib**: code, jump table at `$B000` (RAM under I/O, `$FF00 = $7F`); reserve after P6l 14 bytes (test build 3) | – |
| `$DC00–$DFFF` | 1 KB | Lib tables (LIBTAB: cell table from GEOMSET, tile summary), not in the file | – |
| `$E000–$E7FF` | 2 KB | Lib variables (BSS) | – |
| `$E800–$EDFF` | 1.5 KB | DVG | `dbegeom` `$E800` |
| `$EE00–$F5FF` | 2 KB | DTS floor | `dbetex` floor `$EE00` |
| `$F600–$FB7F` | 1.375 KB | DTS ceiling (1 style of the demo: 1 295 bytes) | `dbetex` ceiling `$F600` |
| `$FB80–$FBFF` | 128 B | DBG (24 + VH ≤ 124 bytes) | `dbetex bg` `$FB80` |
| `$FC00–$FEFF` | 768 B | **locked:** Blitz! runtime (image 2) – leave free even in the interpreted game | – |
| `$FF00–$FF04` | – | MMU | – |
| `$FF05–$FFFF` | – | Copy of the Kernal interrupt switch | – |

Bank 1 windows for assets: `$4000–$AFFF` (28 KB) and `$E800–$FBFF` (5 KB). **All engine data lies within these**; the rest is lib (`$B000–$E7FF`), runtime or bank 0 view. Lists for VCL type 9 (contents of DTS and S2) must lie at `$4000` or above (not in `$D000–$DFFF`; the engine checks the address in `TEXSET`/`SPRITESET`, section 6a); the map satisfies this for all areas.

Rationale: The demo wall DTS with 4 styles has 8.7 KB (P5 example; `dbetex` allows at most `max_cores` 4, review-notes G.1/G.2) and now fits into the wall area. Floor and ceiling of the demo (9.1 and 3.2 KB with several styles) still do not fit into their areas (asset finding, `P6g-vcl-analysis.md` section 6); whoever needs more packs the files tightly into the upper windows (the addresses are parameters of `GEOMSET`/`TEXSET`/`BGSET`).

**Blitz! runtime (image 2, P6g):** The improved runtime copies shared code to `$FC00`, sets `$D506` to `$0C` (bottom **and top** 1 KB shared) and lowers the string upper limit to `$FC00` (`blitz128/runtime2026/README.md`). As long as the compilation runs, every access to bank 1 `$FC00–$FEFF` lands in the shared RAM, i.e. in the runtime: a `BLOAD …,B1` there destroys it (compilation hangs; interpreted it goes unnoticed because `$D506` = `$04` applies there). Therefore the upper limit **`$FBFF`** applies to **all** engine data in bank 1 (the same for interpreted and compiled, so that a game loads the same files in both forms):

- The high areas DVG, DTS floor, DTS ceiling and DBG share `$E800–$FBFF` (5 KB). A game may also pack the four files tightly in this window (example `test/vice_view.py`: DVG `$E800`, ceiling `$ED30`, floor `$F240`, DBG `$F9C0`).
- VCL type 9: lists in bank 1 only in `$4000–$CFFF` or `$E000–$FBFF` (VDC-BASIC permits up to `$FEFF`; the rest belongs to the runtime).
- `MEMSIZ` (`$39/$3A`): The game sets it with the first statement to `$4000` (`POKE 57,0:POKE 58,64:CLR`, measurement P6a with `$5000`, section 12; `test/vice_blitzvars.py` now checks `$4000`); the runtime lowers it at startup only to `$FC00` anyway. The order is thus uncritical. Variables and strings have 15 KB (`$0400–$3FFF`); the 4 KB more for assets are the consequence of decision 4 after the VCL analysis.
- During the lib call the stub sets `$D506` = (old AND `$F0`) OR `$06` (top not shared) and restores the old value; VCL type 9 likewise with `$07`. This is compatible with the runtime (P6g: all 42 scenes identical as compilation); interrupts in these windows run via the Kernal switch in bank 1 and do not touch `$FC00–$FEFF`.
- **Tools (P6h implemented):** `tools/dbemem.py` holds the load addresses and the area limits (table above). `dbemap`/`crawlmap build`, `dbespr build`, `dbetex build`/`bg` and `dbegeom` abort with error code 1 and a message if load address + length exceeds the end of the file's area (if the load address lies in the standard area of the kind) or the end of the free window (own, tight packing), or if the load address lies in neither of the two windows. The lib does not check the upper limit (length of the data unknown); a check "data in `$2000 … $FBFF`, not in lib/BSS" would be P6d review K5 with the new limit.
- The demo assets (wall 8.7 KB, floor 9.1 KB with 3 styles, ceiling 3.2 KB) are used by `build_texset` and the tests without area check (only the write paths check); in the sim65 harness (`run_sim.py`) they lie at their own addresses as before, everything below `$FC00`.

### 2.5 Object list (`$0C51`, 6 bytes each)

| Offset | Contents |
|---|---|
| 0–1 | Cell index |
| 2 | Sprite set 0 … 7 |
| 3 | Object direction o: 0–3 (N, E, S, W) or `$FF` (viewing angle 0) |
| 4 | Phase f |
| 5 | Bits 0–2: sub-position q absolute (0 NW, 1 NE, 2 SW, 3 SE, 4 center; 5–7 as 4); bit 6: invisible (`VIEW` skips); bit 7: does not block (`MOVE`); bits 3–5: 0 |

Items of the content layer are added in addition (5.8).

### 2.6 Lib: size and location

Estimate (0.1 after step 1b: 1834 bytes code, 342 bytes variables):

| Part | Code approx. |
|---|---|
| Dispatcher, INIT, POOLSET, BUFSET, check helpers | 0.4 KB |
| MAPINIT, SETPOS, CELL, SETCELL, SETITEM, MOVE | 0.6 KB |
| GEOMSET, TEXSET, BGSET, SPRITESET, ITEMSET | 0.6 KB |
| VIEW: cells, styles, coverage | 0.9 KB |
| VIEW: bands, tiles, wallpaper, spans | 0.9 KB |
| VIEW: objects, anchors, clip rectangle | 0.6 KB |
| Output: cores, copy and clip VMS, VMF groups, size calculation | 1.1 KB |
| **Total** | **≈ 5.1 KB** (target ≤ 7 KB) |

Variables (BSS) about 1.4 KB: coverage 2 × 80, visibility list MAXITEM × 10 = 960, row table 2 × 100, state and pointers ≈ 150, `itemtab` 64. From this: **code `$B000–$CFFF` (8 KB), BSS `$E000–$E7FF` (2 KB)**. `lib.cfg`: MEMORY `CODE` `$B000` size `$2000` (file), `BSS` `$E000` size `$800` (not in the file, INIT clears). The stub jumps to `LIB = $B000`. P6a measures; if the code exceeds 8 KB, that is a finding for the user, not a silent relocation.

## 3. Functions

Call `SYS 3331,F,X,Y`, result `RREG A,X,Y`. A = error code (3.1). All addresses in P0–P3 are bank 1 addresses of the data (content start = `BLOAD` address), VRAM bases are VDC addresses.

| F | Name | Input | Output |
|---|---|---|---|
| 0 | `INIT` | – | State cleared (BSS, OBJN = 0, buffer = default); X = `DBE_VERSION` (0.2: 3); P0 = code end, P1 = BSS end |
| 1 | `MAPINIT` | P0 = DMP, P1 = working copy (0 = none; otherwise 2·W·H bytes for tile and content layer), X bit 0 = set automap bit "seen" in `VIEW` (only with P6f, otherwise ignored) | checks magic, version, offsets, length; start cell and direction adopted (as `SETPOS`); OBJN = 0; X = W, Y = H; P0 = start cell, P1 = start direction. A = 1 format; A = 6 if the working copy [P1, P1 + 2·W·H) does not lie entirely within `$4000` … `$AFFF` (below the lib; lib, BSS, DVG, I/O and MMU remain untouched; below that BASIC variables and shared RAM) |
| 2 | `SETPOS` | P0 = cell, X = direction | A = 0; 6 if cell ≥ W·H (position unchanged) |
| 3 | `MOVE` | X = action (3.4) | P6f |
| 4 | `VIEW` | P0 = frame buffer in VRAM (AP) | VCL list [B1 − VCLLEN, B1), VMS lists [B0, B0 + VMSLEN) (fixed list address: jump at B0, VMS lists [B0 + 3, B0 + 3 + VMSLEN)); A = 0, 2 (shortened) or 3 (edges omitted); X = entries (at most 255), Y = 0; **P0 = VCLADR** (game: `::VCL` with this value); VCLLEN, VMSLEN, OBJVIS (2.3). A = 5 without GEOMSET/MAPINIT |
| 5 | `CELL` | P0 = cell | X = tile index, Y = content byte, P1 = tile flags; outside: A = 6, X = outer tile, Y = 0 |
| 6 | `SETCELL` | P0 = cell, X = tile index | A = 0; 6 for cell outside or X ≥ NT |
| 7 | – | – | A = 255 (`ENEMYSTEP` reserved) |
| 8 | – | – | A = 255 (`WALLSET` dropped) |
| 9 | `SPRITESET` | X = set 0 … 7, P0 = S2 (0 = clear set), P1 = VRAM base | checks `"S2"`, version, ID (0 or = DVG ID), D, stride; A = 1 format, 4 geometry, 5 without GEOMSET, 6 set number/pool or S2 below `$4000` (VCL type 9, 6a) |
| 10 | `ITEMSET` | X = item 0 … 63, Y = set + 1 (0 = none) | A = 0; 6 for X ≥ 64 or Y > 8 |
| 11 | `POOLSET` | P0 = pool start, P1 = pool end (exclusive, 0 = 65536); both 0 = no check | A = 0; TEXSET/BGSET/SPRITESET then check base … base + U ⊆ pool |
| 12 | `GEOMSET` | P0 = DVG, P1 = origin (`$FFFF` = from the DVG) | checks magic, version, element length 16, depth entry 8, VW ≤ 80, VH ≤ 100, D ≤ 7, NE ≥ 1, plus the element table (7, P6d-opt; error there: A = 1 and no valid geometry); row table, cell table; TEXSET/BGSET/SPRITESET with a different ID are cleared (bit per set in Y: bit 0–2 DTS, bit 3 DBG; X = bits of the S2 sets); A = 1 format |
| 13 | `TEXSET` | X = kind (0 wall, 1 floor, 2 ceiling), P0 = DTS (0 = clear), P1 = VRAM base | checks `"DT"`, version 1, kind = X, ID, NE, D, stride; A = 1, 4, 5, 6 (also DTS below `$4000`, VCL type 9, 6a) |
| 14 | `BGSET` | P0 = DBG (0 = no wallpaper), P1 = VRAM base, X = fill byte without DBG; **Y ≠ 0: distance fill on, P2 low = fill byte** (5.7a, P6l; Y = 0 off) | checks `"DB"`, version, VW, VH, ID; A = 1, 4, 5, 6. Y and P2 are always adopted (also on error after adopting X, like X) |
| 15 | `BUFSET` | P0 = buffer start, P1 = buffer end (exclusive); X bit 0 = fixed list address (P6j) | A = 0; 6 if start < `$1300`, end > `$1C00` or length < 64 (old buffer and mode remain; window `$1300–$1BFF`, P6d-opt). Fixed list address: 3.3, 5.11; `INIT` switches it off |
| 16 | `SETITEM` | P0 = cell, X = content byte (item and automap bits) | A = 0; 6 outside |
| ≥ 17 | – | – | A = 255 |

### 3.1 Error codes

| A | Name | Meaning |
|---|---|---|
| 0 | `E_OK` | ok |
| 1 | `E_FORMAT` | Magic, version or lengths wrong |
| 2 | `E_TOOMANY` | `VIEW`: list shortened (rear parts missing) or tables full |
| 3 | `E_PARTIAL` | `VIEW`: edges of individual images omitted (only cores drawn), list otherwise complete |
| 4 | `E_GEOM` | Geometry ID, NE, D or stride does not match the DVG |
| 5 | `E_STATE` | Order: GEOMSET missing (for TEXSET, BGSET, SPRITESET, VIEW) or MAPINIT missing (VIEW, CELL …) |
| 6 | `E_RANGE` | Parameter out of range (cell, set number, tile index, pool, buffer) |
| 255 | `E_NOTIMPL` | Function does not exist |

### 3.2 Checks on setting (mandatory)

- DTS: kind byte = X; geometry ID = DVG ID; NE, D, stride equal; NST ≥ 1. DBG: VW, VH, ID equal. S2: ID = DVG ID or 0, D = DVG D, stride equal.
- Pool (if set): base ≥ pool start and base + U ≤ pool end (16 bit without overflow).
- On setting, the lib computes the absolute bank 1 addresses of the sub-tables (slot map, style table, directory, cores, data area, index table) and stores them; `VIEW` never reads header offsets.

### 3.3 Buffer

The buffer [B0, B1) lies in the shared RAM (bank 0, window `$1300–$1BFF`). `VIEW` writes each accepted entry immediately (single pass, P6d-opt): VMS lists upward from B0, VCL entries downward from B1 (end byte at B1 − 1). VCLADR = start of the VCL list. Default size 2304 bytes.

**Fixed list address (P6j, `BUFSET` X bit 0):** `VIEW` writes a VCL jump (type 10, VDC-BASIC v3 P2e: `10, address`) at B0 to the list start B1 − nv; the VMS lists begin at B0 + 3, BL is 3 bytes smaller. VCLADR = P0 = B0 on every call, VCLLEN and VMSLEN without the jump. A game then calls `::VCL` with the constant B0 (fastest via a variable set once, created first, result P6j). Cost: about 100 cycles in `VIEW`, about 215 in `VCL`.

### 3.4 MOVE (P6f)

| X | Action |
|---|---|
| 0 / 1 | forward / back |
| 2 / 3 | sideways left / right |
| 4 / 5 / 6 | turn left / right / turn around |

Turning: change direction, X = 0, Y = tile of the position (P6f). Step: target cell by direction; outside the map → X = 1, Y = outer tile; tile flag SOLID → X = 1, Y = tile; object of the list on the target cell without bit 7 (does not block) and without bit 6 → X = 2, Y = object index; otherwise position = target, X = 0, Y = tile. Always: P0 = position, P1 = content byte of the position, P2 = index of the first event of the position in the DMP event list or `$FFFF`. A = 0.

## 4. State of the lib (BSS)

| Name | Contents |
|---|---|
| Map | Addresses of tile layer, content layer (working copy or DMP), tile table, events; W, H, NT, NE_ev, outer tile |
| Position | pos (cell index), px, py (computed in SETPOS/MOVE by repeated subtraction), v |
| DVG | Address, VW, VH, D, S, NE, stride, origin, ID, horizon y0/y1, addresses of depth table and element table; row table `row[y] = origin + y · stride` (y < VH) |
| DTS[3] | valid, VRAM base, NS, NST, addresses of slot map, style table, directory |
| DBG | valid, VRAM base, P, y0, h, flags, o_v (chosen in VIEW for the current direction), address of the fill bytes; fill byte without DBG; distance view on (`ffon`) and distance-view fill byte (`ffill`), P6l |
| Distance view | `hs[VW]`: s + 15 of the cell at depth D per column of the horizon band (GEOMSET, 5.7a) |
| S2[8] | valid, VRAM base, NA, NP, D, addresses of index table, directory, core table; angle_map |
| `itemtab[64]` | set + 1 |
| Pool, buffer | Limits |
| VIEW | `cover[80]`, `bcov[80]`, counters, visibility list (MAXITEM = 96 entries, about 10 bytes each), pending areas (pending, ≤ 16), sums |

## 5. `VIEW`

The Python reference (`tools/dbeview.py`, 9.1) implements exactly this section; the 6502 output must be **byte-identical**. In case of ambiguity the reference applies after agreement, and this section is updated accordingly.

### 5.1 Terms

- Elements of the DVG (P3 5.3), kind FRONT 0, SIDE 1, FLOOR 2, CEIL 3, OBJ 4; fields e.x, e.y, e.w, e.h, e.flags, e.c0, e.c1, e.s, e.index, anchor e.anchor[p].
- Depth table per d: ceiling band [cy0, cy1), floor band [fy0, fy1), first element, count. Horizon [hy0, hy1).
- `cell(d, s)`: cell in the grid. Steps: F = (fx, fy), R = (rx, ry) per direction v (N: F = (0, −1), R = (1, 0); E: F = (1, 0), R = (0, 1); S: F = (0, 1), R = (−1, 0); W: F = (−1, 0), R = (0, −1)). x' = px + d·fx + s·rx, y' = py + d·fy + s·ry; outside 0 ≤ x' < W, 0 ≤ y' < H → **outer tile**, content 0 (no line wraparound as in 0.1, review-notes G.11); otherwise index y'·W + x' (= pos + d·F + s·R).
- Tile t: walls[4], floor, ceil, flags. `faces(t)` = at least one walls ≠ 0. `blocked(t)` = flag OCCLUDING and all four walls ≠ 0.
- Face per element: FRONT → (v + 2) AND 3; SIDE with s < 0 → (v + 1) AND 3; s > 0 → (v + 3) AND 3 (P4 2.4).
- `resolve(kind, slotindex, n)`: n = 0 → nothing; DTS of the kind missing → nothing; st = n − 1 ≥ NST → nothing; k = slot map[slotindex] (`$FF` → nothing); b = style table[st · NS + k]; b = `$FF` → b = style table[k]; b ≥ `$FE` → nothing; otherwise directory entry b. slotindex = e.index for elements, NE + d for ceiling band d, NE + D + 1 + d for floor band d.
- `occ(e, t, ent)` = (e.flags bit 0) and (t.flags OCCLUDING) and (ent.flags bit 0) (review-notes D.5).
- **Column masks** (VW bytes each, 0 = free):
  - `cover`: occluded for everything behind P_{d+1} and for objects and sides of the same depth further out. For objects it only serves to discard fully occluded sprites (5.8); nothing is clipped against `cover`.
  - `bcov`: occluded for bands, tiles and wallpaper of the current depth.
- `allcov(m, c0, c1)`: all columns c0 … c1 − 1 in m are occupied.
- `spans(m)`: maximal runs of free columns in [0, VW), left to right; more than **4** runs → one run [first free, last free + 1); none → empty.
- DVG flag **bit 3 "band coverage"** (new, review-notes G.5): fronts whose rectangle contains the band rows of their depth (e.y ≤ cy0 and e.y + e.h ≥ fy1 of depth e.d). `dbegeom` sets it for all fronts.

### 5.2 Procedure (visibility pass, front → back)

`add(item)` appends an entry to the visibility list and checks the size (5.10); "STOP" ends the entire pass.

```
cover = bcov = 0;  ncov = 0
for d in 0 .. D:
    pend = []                                   # (c0, c1, target) – target: both masks or bcov only
    for e in elements of depth d (DVG order; tile flag CONTENT: 5.2a):
        c = cell(d, e.s); t = tile(c)
        if e.kind in (FRONT, SIDE):
            if not faces(t): continue
            ent = resolve(wall, e.index, t.walls[face(e)])
            if ent is None or allcov(cover, e.x, e.x + e.w): continue
            add(WALL(e, ent))                   # STOP possible
            if occ(e, t, ent):
                if e.kind == FRONT:
                    mark(cover, e.c0, e.c1)
                    if e.flags bit 3: mark(bcov, e.c0, e.c1) else pend += (e.c0, e.c1, bcov only)
                else: pend += (e.c0, e.c1, both)
        elif e.kind == OBJ and d >= 1 and (not faces(t) or t.flags CONTENT):
            objects(d, e, c)                    # 5.8, STOP possible
    bands(d, BODEN); bands(d, DECKE)        # 5.6, STOP possible
    wallpaper(d)                                   # 5.7, STOP possible (horizon only below with distance fill)
    for (c0, c1, target) in pend: mark(bcov, c0, c1); if target == both: mark(cover, c0, c1)
    if distant: distant_view()                        # 5.7a, only d = D with distance fill, STOP possible
    if ncov == VW: break                        # ncov counts occupied columns in cover
```

- **5.2a Tile flag CONTENT (user decision 4, DMP bit 5):** Cells with faces and this flag (door, grating, arch) also show their objects. The cell enters its elements into the visibility list in the order **fronts, object slot, sides** (instead of DVG order front, side, object slot); the backward output thus paints side face, objects by sub-position, front. Cells = groups of equal s in the DVG (P3 5.3: contiguous); all other cells unchanged in DVG order. The flag does not change the coverage.
- `mark` sets bytes to 1 and increments ncov for newly occupied columns of `cover`.
- FLOOR/CEIL elements are not output in the loop (only in `bands`).
- The visibility list is processed **backwards** during output (5.11). The paint order per depth D … 0 follows: wallpaper, ceiling (base, tiles), floor (base, tiles), cells outside → inside, per cell side before front or objects back → front. This is plan 5 with review-notes B.1–B.3: side faces of a depth occlude only after the objects and bands of this depth; fronts occlude immediately (sides and objects of the same depth further out lie behind them).

### 5.3 Walls

`WALL(e, ent)`: target T0 = AP + row[e.y] + e.x. Output according to P5 4.4: one `VMC` per core (VCL type 2 for srcstep 0, otherwise 3), then for EDGE a `VMS` (type 12) with the copied list. Walls and tiles are **not** clipped (the DVG rectangle lies within the window).

### 5.4 Coverage – assumptions

- A coverage in `cover` from depth d applies to all rows of P_{d+1} (P3 4.4). Objects are **not** clipped against `cover` (P6i, user decision): a sprite is drawn completely and overpainted by the nearer walls that come later in the paint order (painter's algorithm, rationale 5.8a). A sprite that is taller than the wall at its depth is overpainted above the wall's top edge by the ceiling bands or the wallpaper of the nearer depths (P5b 3.4 still warns, because it then "floats" above the floor or protrudes into the ceiling).
- Not covering is always correct (only extra work).
- Cells with faces show no objects (plan 5: either faces or content), even if the faces do not cover – **unless** the tile has the flag CONTENT (5.2a, review-notes G.14).

### 5.5 Paint order groups within an entry

A visibility list entry produces in this order: all cores (in table order), then the VMS list. Several runs (spans) of a band produce separate entries.

### 5.6 Bands and tiles: `bands(d, K)`

Band rows [y0, y1) = floor band or ceiling band of depth d; empty → return. Tile elements E_K(d) = elements of depth d with kind FLOOR or CEIL (DVG order).

1. For each element e in E_K(d), tile t = tile(cell(d, e.s)): blocked(t) → **don't care**; otherwise n = t.floor or t.ceil, st = n − 1; n = 0, no DTS of the kind or st ≥ NST → **gap**; otherwise style st.
2. All don't care → return (nothing to draw).
3. **Uniform** if there is no gap and all non-don't-care elements have the same style st and `resolve` for the band (slotindex of the band, n = st + 1) yields an image: base = band(st), no tiles.
4. Otherwise **mixed**: if there is a gap, the base is the wallpaper (`gapK = true`, 5.7) and tiles come for all non-don't-care non-gaps; without a gap the base is band(st0) with st0 = style of the first non-don't-care element in DVG order whose band image can be resolved (none → base empty), and tiles come for all non-don't-care elements with style ≠ st0 (or all, if the base is empty).
5. **Appending** (backwards to the paint order): first the tiles in DVG order – per tile `ent = resolve(kind, e.index, n)`; nothing → skip; `allcov(bcov, e.x, e.x + e.w)` → skip; otherwise `add(WALL(e, ent))` –, then the base (if band): per run from `spans(bcov)` **from right to left** `add(BAND(ent, y0, c0, c1))`.

`BAND(ent, y0, c0, c1)`: band image in rows [y0, y0 + h), columns [c0, c1):
- ROWS (P5 5.6): per row i the fill byte b_i, consecutive equal bytes grouped; a group with 1 row → VCL type 4 (`AP + row[y0 + i] + c0`, b, c1 − c0), with r > 1 rows → type 5 (ditto, reps r, step stride).
- otherwise: cores and edge like a sprite image with `clip_image` (P5b 6) in the band rectangle (x0 = 0, y0) and clip rectangle [c0, c1) × [y0, y0 + h); full width = unclipped.

### 5.7 Wallpaper: `wallpaper(d)`

Row ranges (top to bottom): ceiling band d, if `gapDECKE`; horizon [hy0, hy1), if d = D and not `distant` (5.7a); floor band d, if `gapBODEN`. Empty ranges are omitted, adjacent ones are merged. Runs = `spans(bcov)`. Appending: ranges **from bottom to top**, per range the runs **from right to left**, per pair `add(BG(r0, r1, c0, c1))`.

`BG(r0, r1, c0, c1)` (P5 6.2):
- **Without DBG:** fill byte f from `BGSET`: one entry of type 4 (r1 − r0 = 1) or type 5 (`AP + row[r0] + c0`, f, c1 − c0, reps r1 − r0, step stride).
- **With DBG** (panorama rows [y0, y0 + h), offset o = o_v of direction v):
  1. Rows above the panorama [r0, min(r1, y0)) and below [max(r0, y0 + h), r1): fill bytes per row from the DBG, consecutive equal ones grouped, type 4/5 as for ROWS.
  2. Panorama rows [a, b) = [max(r0, y0), min(r1, y0 + h)), if not empty: source column q = (o + c0) mod P, n = c1 − c0. If q + n ≤ P: one type 3 (`VB + (a − y0) · P + q`, `AP + row[a] + c0`, n, reps b − a, step stride, srcstep P). Otherwise (only with WRAP) two type 3: n1 = P − q from q, then n − n1 from source column 0 at target column c0 + n1.
  3. Order of the entries: above, panorama (part 1, part 2), below.

The order of the ranges and parts in the image is irrelevant (they do not overlap), but it is fixed for the list comparison.

### 5.7a Distance view: `distant_view()` (P6l, user decision 2026-11-26)

Without fill, the wallpaper is also the distance view: lines of sight longer than D end in the horizon band [hy0, hy1) of depth D in the wallpaper. In interior rooms with landscape wallpaper one then sees mountains, e.g. through a grating in a roofed chamber. With **distance fill** (`BGSET` Y ≠ 0, fill byte f = P2 low) the tile through which one looks into the distance decides per column whether wallpaper or the fill byte appears there. Without fill (Y = 0, default after `INIT`) everything is as before.

- **Cell per column:** The horizon band is the image of plane P_{D+1}, the far edge of the cells of depth D. Column c belongs to the cell (D, s(c)) from which its line of sight exits beyond P_{D+1}. The boundaries are the far edges of the **side faces** of depth D (rectangle in the DVG, P3 4.4): a side with s < 0 ends on the right at x + w, one with s > 0 begins on the left at x. From this `s(c) = − #{sides s < 0 with c < x + w} + #{sides s > 0 with c ≥ x}` (all sides of depth D, independent of image and flags). `GEOMSET` creates the table `hs[c] = s(c) + 15`. Prerequisite (met by `dbegeom`): at most one side per cell and, for every occurring s(c), a cell (D, s(c)) with elements; otherwise the decision for these columns is undetermined (the reference reports an error).
- **Decision per cell** (tile t of the cell (D, s), including the outer tile; blocked cells like all others): **fill** if ceiling style t.ceil ≠ 0, **wallpaper** if t.ceil = 0 (sky). Tile flag **DISTANT** (DMP bit 6, P4 2.4) reverses the rule: roofed tile with a view to the outside (arcade, veranda) → wallpaper; tile without ceiling behind which it should be dark (cave without ceiling texture) → fill.
- **`distant`** = fill on and d = D and at least one cell of depth D (cell table) with decision fill. Otherwise the horizon stays in `wallpaper(D)` as before (images to the outside are thus also unchanged in the list).
- **Procedure with `distant`:** `wallpaper(D)` omits the horizon (ceiling and floor bands with a gap remain wallpaper via `spans(bcov)`). After the pending area of depth D (then `bcov` covers all columns in which an occluding front or side of depths 0 … D fully occludes the rows of P_{D+1} = horizon; only in the remaining columns can something still be visible behind the last depth) for each run from `spans(bcov)` **from right to left** the stretches [a, b) of equal decision **from right to left**: fill → `add` of an entry of type 4/5 (`AP + row[hy0] + a`, f, b − a, reps hy1 − hy0, step stride) like BG without DBG; wallpaper → `add(BG(hy0, hy1, a, b))` (5.7, with or without DBG). Empty horizon (hy0 ≥ hy1): nothing.
- **Paint order:** The entries are the last in the visibility list, so they are painted first (at the very back, before everything else, also before ceiling/floor band D and the walls of depth D). In the columns with fill no wallpaper is output (only the fill byte, one type 4/5 instead of type 3 per stretch). Windows, gratings and arches do not cover (5.4): walls behind them are drawn normally; the fill lies only in the columns left free afterwards and beneath everything painted in front of it.
- **Size and overflow:** like any BG entry (5.10); `STOP` in `distant_view()` loses only horizon entries.
- `paint_reference` paints the horizon at full width as before and then overwrites the columns with decision fill with f (independent of `distant`, coverage and spans).

### 5.8 Objects: `objects(d, e, c)`

1. Candidates of cell c: objects i of the list (i < OBJN, cell index = c, bit 6 of byte 5 = 0) with p = SUBPOS[v][q] (q = byte 5 AND 7, q > 4 → 4; table P4 2.6); item g = content(c) AND 63, if g ≠ 0 and `itemtab[g]` ≠ 0, with p = 2, set `itemtab[g]` − 1, direction `$FF`, phase ITEMPH.
2. **Paint order:** p ascending (0 back left, 1 back right, 2 center, 3 front left, 4 front right; P3 3.3); for equal p first the item, then objects by i ascending. **Appending in reverse paint order.**
3. Per candidate: set invalid → skip; a = 0 for direction `$FF`, otherwise (2 + v − o) AND 3; image = `lookup(set, f, a, d)` (P5b 6.3; f ≥ NP → 0; `$FF` → phase 0; `$FE` → skip).
4. Anchor (ax, ay) = e.anchor[p] (signed byte column, row); x0 = ax − fx, y0 = ay − fy (16 bit signed).
5. Clip rectangle only at the window: cx0 = max(x0, 0), cx1 = min(x0 + w, VW), cy0 = max(y0, 0), cy1 = min(y0 + h, VH); empty → skip. `allcov(cover, cx0, cx1)` → skip (all columns of the clip rectangle occluded). Otherwise the clip rectangle stays as it is: no cropping against `cover` (P6i). If the sprite lies entirely within the window, it is unclipped (cores + edge as type 9 or, in the build `VMS_COPY`, as a copy, 5.9).
6. `add(SPRITE(set, image, x0, y0, cx0, cx1, cy0, cy1))`; objects cover nothing. On acceptance: set OBJVIS bit i (list objects only).

### 5.8a Occlusion of sprites via the paint order (P6i)

A sprite at depth d (cell s) is drawn completely. Clipping against `cover` is unnecessary if every wall that occupies a column of `cover` at the time of the sprite comes **after** the sprite in the executed VCL and is itself unclipped. `cover` then contains exactly:

1. **Fronts and sides of depths < d** (occluding): The output runs depth D … 0, depth d' < d comes entirely after d. Walls are never clipped (5.3); a wall that is dropped because of `allcov(cover)` lies in columns that an even nearer, likewise later wall occludes. An occluding front or side of depth d' occludes in its columns [c0, c1) all rows of P_{d'+1} (5.4, sides: the trapezoid is at every column at least as tall as P_{d'+1}); a sprite in cell d ≥ d' + 1 lies within it, as long as it is not taller than the wall of its depth.
2. **Fronts of depth d in cells further inside** (they occupy `cover` immediately): The cells of a depth are traversed inside → outside and painted outside → inside, so the inner front comes after the sprite of the outer cell.
3. **Front of the own CONTENT cell** (5.2a): generation fronts, objects, sides, painted side, objects, **front**; the front comes after the objects.

Sides of depth d (also further inside) occupy `cover` only at the end of the depth (`pend`) and likewise come after the sprite. Fronts and sides of the same depth further outside come before the sprite, but do not yet occupy `cover` at the sprite; this is unchanged compared to P6 (there, clipping against them was likewise not done).

**Bands, tiles, wallpaper:** Floor bands, ceiling bands, tiles and wallpaper of a depth d'' < d are painted after the sprite and overpaint parts that protrude into their rows (sprites that are too tall; objects stand with their foot point on the floor of their cell, plan 5). They are clipped only against `bcov`; in a column occupied by an occluding wall of depth d', they are missing exactly from depth d' on, i.e. in the rows that this wall itself covers (bit 3) or that it overpaints after its own bands (without bit 3: `pend`, bands of depth d' come before their walls). Above and below the wall the bands of depths < d' remain and overpaint the sprite there. The merging of more than 4 spans (5.1 `spans`) paints bands over occluded columns; the walls above come afterwards, the result stays the same. All cases concern rows that the sprite already reached unclipped in P6 (clipping was done only by columns); **additional changes of the order are not necessary**.

**Edge cases** (as before, no new error): (a) Overflow: a wall entry "without edge" or "discarded" (5.10) occupies `cover` anyway; the sprite behind it is then partially visible (A = 3). Previously the sprite was missing there and the old image content remained; both are an error state. (b) Bands without a resolvable image (mixed, base empty, tile without image) paint nothing; a too-tall sprite then stands there instead of the old image content. (c) Sprites that are taller than the wall of their depth (P5b 3.4): what lies above the top edge of the occluding wall is overpainted by the ceiling bands of nearer depths; previously it was cut off. This corresponds to 0.1 (Crawl 1.0f also overpainted).

### 5.9 Clipping

Sprites (only at the window, 5.8) and bands with an edge are cut with `clip_image` (P5b 6). Target of a core: `AP + row[line] + column`; target of a clipped VMS list: `AP + row[cy0] + cx0`; unclipped `AP + row[y0] + x0` (then y0 ≥ 0, x0 ≥ 0 applies). VMS source always `VB + edge_ofs` (the skipped bytes at the start are handled by type 3). The 6502 version computes ofs' with a running line start (no multiplication) and aborts as soon as r ≥ B.

### 5.10 Size calculation and overflow

The visibility pass keeps `nv` (VCL bytes, start 1 for the end byte) and `nm` (VMS bytes); buffer size BL = B1 − B0. For each entry its sizes are known **exactly**: cores 11 bytes (type 2) or 13 (type 3) after clipping, type 4 = 7, type 5 = 11, VMS entry 7 + list length (for clipped lists determined by a trial run of `clip_image` without writing).

```
add(item):
    if count == MAXITEM:                       → A = 2, STOP
    if nv + item.v + nm + item.m <= BL:        accept
    elif item.m > 0 and item.v > 7 and nv + item.v - 7 + nm <= BL:
                                               accept without edge, partial = 1
    elif item.m > 0 and item.v == 7:           discard, partial = 1 (continue)
    else:                                      → A = 2, STOP
```

Fixed list address (P6j): BL = B1 − B0 − 3 (jump at B0), otherwise unchanged.

- Aborting loses the **rear** parts (the pass goes front → back). Bands and wallpaper of a depth come after its cells; if it aborts there, rows of that depth remain undrawn (old image content). This is an error state (A = 2), not a normal case; games measure their scenes (report `dbeview budget`, 9.1).
- A = 2 takes precedence over A = 3.

### 5.11 Output (back → front)

**Single pass (P6d-opt):** There is no visibility list any more. Each accepted entry is written immediately during the visibility pass: its VMS list upward from the VMS pointer (start B0), its VCL entries in generation order **downward** from the VCL pointer (start B1 − 1 with the end byte 0). The list from VCLADR is thus the reverse generation order: back → front, and within an entry likewise reversed (first the VMS list, then the cores backwards; pixel-identical, because cores and edge or ROWS groups and wallpaper parts are disjoint, P5 4.4). VCLADR = B1 − nv, VCLLEN = nv, VMSLEN = nm, X = min(number of VCL entries, 255).

Overflow: If the free space (VCL pointer − VMS pointer) is not sufficient while writing, the entry is withdrawn, measured exactly in counting mode and decided according to 5.10 (accept, without edge, discard, STOP); the rule and thus the results are unchanged.

Fixed list address (P6j): VMS pointer from B0 + 3; at B0 the type byte 10 is already in place before the pass, and at the end the address B1 − nv is added. VCLADR = P0 = B0.

In the game: `SYS3331,4,...:RREG A:::VCL PEEK(3072)+256*PEEK(3073)` (P0 = VCLADR); with fixed list address `::VCL VB` with VB = B0 (result P6j).

## 6. Output VCL types

All parameters as a word (low/high), including byte values (VDC-BASIC `vcl-format.md`).

| Type | Length | Fields | Use |
|---|---|---|---|
| 2 | 11 | src, dst, count, reps, step = stride | Cores with srcstep 0 **or srcstep = count** (P6h; the source continues behind the previous run anyway) |
| 3 | 13 | src, dst, count, reps, step = stride, srcstep | Cores with srcstep ∉ {0, count}, clipped cores (partial width), wallpaper (srcstep P, always type 3) |
| 4 | 7 | vaddr, byte, count | Row fill, one row |
| 5 | 11 | vaddr, byte, count, reps, step = stride | Row fill, several equal rows |
| 12 | 7 | src, dst, list | Edge (VMS) clipped; list in the buffer, commands type 1, 3, 8 (build `VMS_COPY`: also unclipped) |
| 9 | 7 | src, dst, list (bank 1) | Edge (VMS) unclipped (walls, tiles, full-width bands, sprites): list directly from bank 1 (6a) |
| 0 | 1 | – | End |

Not used: 1, 6, 7, 8 (`RXV` is loaded by the game), 13. Limits: reps ≤ 100 (VH), count ≤ 80, VMS type 1 length ≤ 255.

## 6a. Proposal VDC-BASIC: VCL type 9 "VMS from bank 1" (P6d-opt, decision 2)

**Provisional:** The read method is open (VDC-BASIC P2d). If VDC-BASIC does not read directly with `$FF00 = $7E` (its code from `$2000` does not lie in the shared RAM), but e.g. via FETCH or an intermediate buffer in the shared RAM, the engine side stays the same (entry with bank 1 address, build switch `VMS_BANK1`); type number and range rule are then adapted to P2d. The cycles with `VMS_BANK1` measure only the engine; the costs shift into the VCL execution and are comparable only with P6g (VIEW + VCL).

| Byte | Contents |
|---|---|
| 0 | 9 |
| 1–2 | source: VRAM address of the edge bytes (= VB + edge_ofs) |
| 3–4 | target: VRAM reference address (like type 12) |
| 5–6 | list: address of the VMS list in **CPU RAM bank 1** |

- List format unchanged as for type 12 (`vms-format.md`: alpha, count, commands; the engine generates 1, 3, 8).
- The list lies entirely in bank 1 `$4000–$CFFF` or `$E000–$FEFF` (engine default since P6g: `$E000–$FBFF`, Blitz! runtime, 2.4; never in `$D000–$DFFF`, never below `$4000`: for type 9 VDC-BASIC briefly switches the shared RAM to 16 KB at the bottom, P2d). The engine checks this in `TEXSET` and `SPRITESET` (address < `$4000` → A = 6; not in build `VMS_COPY`); type 9 occupies no buffer bytes. VDC-BASIC reads them with `$FF00 = $7E` (bank 1 with I/O, VDC registers reachable; loop in the shared RAM `$1C00–$1FFF`) and then restores its configuration. Interrupts may run (Kernal switch in bank 1 `$FF05–$FFFF`, as with the stub).
- The engine writes type 9 only for **unclipped** lists (wall/tile images, full-width bands, unclipped sprites): list = content start of the DTS or S2 + vofs. Clipped lists remain type 12 in the buffer. Type 9 occupies no buffer bytes (m = 0 in 5.10; "without edge" and "discard" apply only to lists in the buffer).
- Engine: **default** since the P6e review (VDC-BASIC P2d accepted); the old way (copy, type 12) remains as build switch `VMS_COPY` (`ca65 -DVMS_COPY`, costs nothing in the default build, sim tests both). Reference: `Scene.vms_bank1` (default still `False` = `VMS_COPY`, because the demo assets do not fit into the areas of 2.4 and bank 1 addresses would otherwise overlap), `Scene.dts_addr`, `Scene.s2_addr` (`None`: tightly from `$7000`); `run_vcl(..., bank1=...)` executes type 9.

## 7. Limits

| Quantity | Limit | on exceeding |
|---|---|---|
| DVG | NE ≤ 255 (no copy, the lib reads the table directly; 0.1 `MAXWS` is dropped, review-notes C.3), VW ≤ 80, VH ≤ 100, D ≤ 7, S ≤ 15 (P6d: at most 31 cells per depth) | GEOMSET A = 1 |
| DTS | NST ≤ 32 (style row table, P6d) | TEXSET A = 1 |
| DBG | P ≥ 1 | BGSET A = 1 |
| Pending area per depth | 16 occluding sides or fronts without DVG bit 3 | GEOMSET A = 1 (P6d-opt; previously VIEW A = 2) |
| Element table (GEOMSET, P6d-opt) | first + n ≤ NE, kind ≤ 4, \|s\| ≤ S, cells contiguous (P3 5.3), ≤ 16 elements and ≤ 1 floor or ceiling element per cell, kind 0–3: x + w ≤ VW, y + h ≤ VH, walls: c0 ≤ c1 ≤ VW; ≤ 48 cells and ≤ 96 walls in total | GEOMSET A = 1, no valid geometry; `dbeview.parse_dvg` ViewError |
| Entries per VIEW | MAXITEM = 96 | A = 2 |
| Buffer | BL (default 2304) for VCL + VMS together | A = 2 or 3 (5.10) |
| Object list | 16 | more is ignored |
| Object slots per cell (kind 4) | any number (within the 16 elements); cell table: first and last | – |
| Sprite sets | 8 | A = 6 |
| Cores per image | 16 (DTS and S2) | Lib processes nk as given; tools limit |
| Map | W, H ≤ 255, W·H ≤ 16384 | MAPINIT A = 1 |

## 8. Cycle targets (sim65, Westwood 140 × 96, D = 3)

| Case | Target |
|---|---|
| Crawl on 0.2 (P7 data), all views | ≤ 2 × 0.1 (0.1: 10 813–14 191) |
| Corridor with occluding walls, uniform bands, no objects | mean ≤ 30 000, max ≤ 45 000 |
| open scene: mixed tiles, gaps, wallpaper with WRAP, grating | max ≤ 80 000 |
| per visible object (unclipped / clipped) | ≤ 2 500 / ≤ 4 000 + 12 per copied or checked list byte |
| `MAPINIT`, `GEOMSET`, `TEXSET` | ≤ 20 000 (once; MAPINIT without working copy) |

Missed targets are a finding with measured values, not an acceptance obstacle for P6d/P6e; P6f optimizes the most expensive parts (profile via sim65 counters per section). The VDC time of the list is measured by P6g in VICE.

## 9. Test concept

### 9.1 Python reference `tools/dbeview.py`

Written independently of the 6502 version (P6b, before P6d), from this specification:

```python
class Scene: dvg, dmp, dts[3], dbg, bgfill, farfill (P6l), s2[8], vram_bases, itemtab, objects, itemph, pos, dir, ap, buf=(0x1300, 0x1C00)
def view(scene) -> Result            # a, x, vcl (bytes from B0), vms (bytes), vcllen, vmslen, objvis – byte-exact according to section 5
def run_vcl(bank0, vram, addr)        # VCL interpreter: types 1–8, 12, 13 (13 = nothing), VMS 1, 2, 3, 8; RXV via vrl.decode
def paint_reference(scene, vram)      # independent painter without coverage and spans
def load_scene(toml) ; def random_scene(seed, ...) ; def budget(scene_list)
```

- **`paint_reference`** paints in plan order (5.2 last paragraph) **everything** that exists according to map and styles, without `cover`/`bcov`, without spans (bands full width, wallpaper full width), sprites clipped only at the window. Building blocks: `dbetex.render` (entries), `dbetex.render_background` (wallpaper), `dbespr.render_image` (sprites). The band decision (uniform, mixed, gap) is the same as in 5.6.
- **Pixel check:** `run_vcl(view(scene))` = `paint_reference(scene)` in the viewport, for all scenes in which every sprite is at most as tall as the wall of its depth (5.4). This proves that coverage, spans and clipping are invisible. Outside the window no VRAM byte is changed (check over the entire 64 KB field with random contents).
- **Answer to the question "dbetex renderer as reference?":** `dbetex.render`/`preview` draws only entries, not a scene; it is a building block of `paint_reference`, not the reference itself. `view` checks the bytes of the list, `run_vcl` checks the pixels against `paint_reference`.
- `budget(scenes)`: largest nv + nm, entries, warning for A ≠ 0 – for game scenes (tool for level designers).

### 9.2 sim65: list comparison 6502 ↔ Python

- `test/sim/sim.cfg` new: program `$2000–$4FFF`; data at their bank 1 addresses according to 2.4 (sim65 has a flat 64 KB memory; `$D000–$DFFF` remains free as in the real map). Parameter block and buffer as on the C128.
- Harness `test/sim/viewsim.c` new: reads a **scene file** (segments address/length/data, then calls: F, X, Y, P0–P3, object list, ITEMPH) via the sim65 file functions, executes the calls and writes per call A, X, Y, P0–P3, parameter block `$0C08–$0C11` and, for `VIEW`, the buffer (B0 … B0 + nv + nm) into a result file. Many views per sim65 run.
- `test/sim/run_sim.py`: generates scene files from Python scenes, builds (cl65, `--asm-define SIM`), starts sim65, compares with `dbeview.view` **byte-exactly**; on deviation: first deviating position as a decoded VCL entry of both sides.
- Cycles: sim65 delivers only the sum of a run. Measurement as in 0.1 as the difference of two runs (with/without VIEW) for a sample of views; profile per section via `SIM` count points (P6f).

### 9.3 Scenes and maps

| Set | Contents |
|---|---|
| demo | `docs/specs/examples/demo.toml` with the P5 example textures (brick, grating, window, arch; stone, wood; sky with WRAP) and P5b demo sprites; all free cells × 4 directions; per view 0, 1 and 5 objects (fixed seed) |
| abyss | demo variant with cells without floor/ceiling (gaps, review-notes D.6) and blocked cells with floor 0 |
| random | 200 random maps 8 × 8 … 24 × 24 (tiles with random styles, flags, gaps; outer tile random), 20 views each, up to 16 objects incl. bit 6/7, items, ITEMPH |
| edge | Sprites deliberately at window edges (s = ±1, ±2, d = 1 … 3, all p), partially occluded, above the top edge |
| overflow | `BUFSET` with 64, 128, 256, 512, 1024 bytes on demo and grating scenes: A, truncation at the rear, edges omitted, list always correctly terminated and executable |
| error | Format errors, wrong ID/kind/stride, order (E_STATE), ranges (E_RANGE), unknown F |

### 9.4 VICE scenes

`test/vice_view.py` (port rule review-notes A: `--port`, `DBE_VICE_PORT`, default 6631, range 6631–6649, bind test, own process only, `-remotemonitor -remotemonitoraddress ip4://127.0.0.1:<port>`):

- Disk: `BOOT` (VDC-BASIC v3, line 50 `RUN"T"`), `VDCBASIC3`, stub, lib, DVG, DMP, DTS/DBG/S2 with VRL, test program `T` (BASIC) and scene table (PRG in bank 0 above the program).
- `T`: loads everything (`BLOAD`, `RXV` of the VRL into the pool), GEOMSET/TEXSET/BGSET/SPRITESET/ITEMSET, then per scene: SETPOS, object list, `VIEW`, `::VCL 4864`, `::VTR` of the window rows into a bank 0 buffer, then `SYS` to a marker (RTS at `$0C4E`).
- Event-driven: breakpoint on the marker → monitor reads buffer and VCL list (`bank ram`), breakpoint on the BASIC error vector `($0300)` → abort with line number; timeout only as a guard. No fixed wait times.
- Comparison: window bytes = `dbeview.run_vcl` of the same scene; VCL list = sim65 result. Time: stopwatch at markers before and after `VIEW` and `VCL` (cycles), report per scene.
- Interpreted and as Blitz! compilation (image 2, `test/blitzprep.py` from vdc-basic).

### 9.5 Crawl (P7)

Pixel equality of Crawl on 0.2 with the 19 test images and the 10 ghost scenes from step 1/1b (screenshot comparison as `vice_drive.py`, which adopts the port rule for this). Prerequisite is the converter from P7 (Crawl DVG with two fronts per cell (2, ±1)/(3, ±1), Crawl DTS with cores only, S2 for ghosts and gem, wallpaper = fill byte 0). The lib processes any number of elements per cell in DVG order; P6 tests this with a synthetic DVG (9.3 random: double fronts).

## 10. Sub-steps

| Step | Contents | Acceptance | Model |
|---|---|---|---|
| **P6a** Skeleton | Stub with 8 KB shared (`$06`), `LIB = $B000`, `lib.cfg` (code `$B000`, BSS `$E000`), `dbe.inc` (addresses 2.2/2.3, error codes 3.1), dispatcher with table 3 (rest `E_NOTIMPL`), INIT, POOLSET, BUFSET; new `sim.cfg`, harness with scene/result file, `run_sim.py` skeleton; VICE smoke test with `BOOT` v3: INIT via the stub, afterwards `VMW`/`RXV` work, interrupts run (jiffy clock keeps counting during a long call), bank 0 `$1C00–$3FFF` unchanged (checksum); determine the Blitz! variable layout in bank 1 (section 12) | Build error-free, sizes from the map; sim: INIT/BUFSET/POOLSET results; VICE smoke test green (interpreted and Blitz!), port rule | Sonnet |
| **P6b** Python reference | `tools/dbeview.py` (9.1): first walls, bands, tiles, wallpaper, overflow; sprites as soon as P5b is done; `test/tools/test_dbeview.py` | Pixel check green for all demo, abyss and random scenes; no byte outside the window; overflow rules; ambiguities of the specification as a list to Opus | Sonnet (review Opus) |
| **P6c** Map and assets | MAPINIT, SETPOS, CELL, SETCELL, SETITEM, GEOMSET (row table, origin, clearing on ID change), TEXSET, BGSET, SPRITESET, ITEMSET with all checks 3.2 | sim: return values and stored values (via a SIM dump of the BSS) against the Python model; error cases 9.3 | Sonnet |
| **P6d** VIEW without objects | Sections 5.1–5.7, 5.9 (bands with edge), 5.10, 5.11 | sim65 byte-identical with `dbeview` for demo, abyss, random (without objects), overflow; cycles as a finding | Opus |
| **P6e** Objects | 5.8, `clip_image` in 6502 (cores, VMS with type 3, trial run), OBJVIS, items, ITEMPH | sim65 byte-identical for all scenes 9.3 incl. edge; cycles per object | Opus |
| **P6f** MOVE, automap, cycles | MOVE (3.4), automap bit 6 (cells with an accepted wall or tile entry or a not completely occluded floor element, only with MAPINIT X bit 0 and working copy), profile, optimization of the most expensive sections | sim: MOVE table of all cases; cycles against section 8 (report); lib size | Sonnet; measurement runs Haiku |
| **P6g** VICE scenes | `test/vice_view.py` (9.4), 30 scenes from demo/abyss/edge, interpreted and compiled | VRAM window = Python, VCL = sim65, times in the report; no fixed wait times | Sonnet (script), Haiku (runs) |
| **P6h** Docs | `docs/formats.md`: function table, parameter block, memory map, S2 reference; update standard load addresses of the tools (2.4) with tests; DVG flag bit 3 in `dbegeom` | Tool tests green, examples regenerated | Sonnet |

Order: P5b ∥ P6a ∥ P6b (walls); P6c after P6a; P6d after P6b (walls) and P6c; P6e after P5b and P6d; P6f, P6g after P6e; P6h any time after P6c (the tool changes DVG bit 3 and load addresses before P6d, because they change test data). P7 after P6g.

## 11. Changes to other specifications (implement in P6h or P5b)

| Where | Change | Reason |
|---|---|---|
| P3 (`dbegeom`) | DVG flag bit 3 "band coverage" for fronts (5.1); default `load` `$E800` | 5.2, memory map |
| P4 (`dbemap`, `crawlmap`) | Default load address `$4000` (P6h; map F: `$5000`) | memory map |
| P5 (`dbetex`) | `max_cores` 0 … 4 (`dbespr` up to 16); `vms_buffer` → check "VCL + VMS per image against the shared buffer 2304"; default `load` wall `$8000`, floor `$EE00`, ceiling `$F600`, DBG `$FB00` (P6h; map F: `$9000`, `$F000`, `$F800`, `$FE00`, after P6g `$EE00`, `$F600`, `$FB00`); `sim_vms` type 3 (P5b) | review-notes G.1–G.3 |
| P5 4.4/4.6 | Format rule for VMS lists (row order, increasing ofs, run within one row) explicitly | Clipping, G.7 |
| `engine-design.md` | Function table, memory 3.1 → reference to P6 (P8) | – |

## 12. Open points

1. **Blitz! variables in bank 1 – checked in P6a, result: map F stays** (P6h: `MEMSIZ` now `$4000`, `POKE 58,64`, 15 KB for variables; the result applies equally, `test/vice_blitzvars.py` and the smoke tests use `$4000`). Measurement with `test/vice_blitzvars.py` (VICE, breakpoints at two `SYS` markers; bank 1 `$5000–$FEFF` filled with `$A5` beforehand, afterwards checked for changes; pointers `$2D–$3A` read), programs "fits" (arrays 3 KB, 61 strings, garbage collection) and "stress" (strings up to `OUT OF MEMORY`), each interpreted and as Blitz! compilation (image 2, via `BOOT`):
   - Variables, arrays and strings lie **only in bank 1** (BASIC 7: variable area from `VARTAB` = `$0400`, arrays behind it, strings from `MEMSIZ` (`$39/$3A`) downward). The compilation behaves the same; the first changed bytes are at `$0402` (scalars of the runtime, 7-byte slots according to the Blitz! analysis), arrays behind them.
   - **Default without limit:** `MEMSIZ` = `$FF00` (interpreted) or **`$FC00` (Blitz!)**; the strings grow from there downward (in the test down to `$5A84`, in the stress test into the variable area). Without a limit strings thus occupy bank 1 `$5000–$FBFF`, exactly where map F stores the game data.
   - **The Blitz! runtime respects `$39/$3A`:** `POKE 57,0:POKE 58,80:CLR` as the **first statement** (before any variable use; `CLR` clears all variables) sets `MEMSIZ` and `FRETOP` to `$5000`. With a limit, bank 1 `$5000–$FEFF` stayed **unchanged (0 bytes)** in all runs, also in the stress test, which ended with `?OUT OF MEMORY` (error 16) when arrays and strings filled the 19 KB `$0400–$4FFF` (interpreted and compiled the same). Upper limit of the strings = `$4FFF`.
   - Consequence: The game begins with `POKE 57,0:POKE 58,80:CLR` (in `crawl.bas` and every test program, likewise in the compiled program; line 10 of the tests), then all variables lie in `$0400–$4FFF`. With the stub (8 KB shared), `$0400–$1FFF` of bank 1 is not visible during the call, the lib does not touch it (not specifically tested; the lib writes only to the area `$0C00–$1BFF`, which bank 0 and the lib's view share, and the smoke test checks bank 0 `$1C00–$3FFF`).
   - A watchpoint on bank 1 addresses was not necessary: the fill pattern shows every change, regardless of the instruction that writes it.
2. **Resident VMS lists** (TEXSET/SPRITESET copy the lists once into a bank 0 area above the program; `VIEW` only refers to them, except for clipped lists): saves the copying per image and defuses the buffer for gratings. Not in P6; decision after the measurements from P6f/P6g.
3. **Load buffer of the game** in bank 0 for VRL (plan 3 "To be checked"): P7.

## 12a. Determinations of the reference `dbeview.py` (P6b)

Decided while writing the reference; the 6502 version follows the reference:

1. **X** (result of `VIEW`) = number of VCL entries **without** the end byte (at most 255).
2. **Empty sprite entries:** If neither core nor edge remains after clipping (e.g. only transparent bytes in the clip rectangle), nothing is appended and OBJVIS is not set.
3. **Floor/ceiling tiles:** The mask includes the edge pixels, adjacent trapezoids overlap at their edge. With different images the paint order decides: outside → inside (= reverse DVG order, which is how the output of 5.6 step 5 paints).
4. **DVG bit 3** is set by `dbegeom` since P6h (before: never); the reference and its tests handle both cases (bit missing: fronts enter `bcov` only at the end of the depth, pixels identical).
5. **VMS type 2** (not generated by the engine) takes the row step from VDC register 1; `run_vcl` has the parameter `rowstep` (80) for this.
6. **`clip_image`:** The row distance of the VMS offsets (stride) is an additional parameter (P5b 6 does not mention it; `dbespr.clip_image(…, stride)` and `dbeview.clip_image(img, stride, …)` return the same values, checked in the test).
7. **Buffer:** Scenes with tile images whose bytes are almost all edge (patterns with holes in every byte, e.g. 18 floor tiles + 18 ceiling), need over 6 KB VMS; the 2 304 bytes are not sufficient there (A = 2). This is a budget case for games (`dbeview budget`), not an error of the reference.
8. **Pixel equality applies only for A = 0** and sprites that are not taller than their wall and stand with the foot row at the bottom edge of the image (5.4).

## Decisions of the user (2026-11-25)

1. Limit BASIC variables in bank 1 to `$0400–$4FFF` (about 19 KB suffice). P6a checks where a Blitz! compilation stores its variables and sets the string upper limit.
2. WALLSET/SPRITESET v1 are dropped without a compatibility path; Crawl comes in P7 via a converter.
3. MOVE, CELL and automap bit remain in P6 (P6f).
4. New tile flag "draw content" in DMP (extend P4): wall cells with this flag (door, grating, arch) draw side face, then their objects by sub-position, then the front. Affects P4 (define flag bit, dbemap), P6d/P6e (VIEW) and dbeview.
5. VMS lists permanently in bank 0 instead of a copy per image: decide after the measurements.

## Result P6a (2026-11-25)

Implemented: stub with `RCR_LIB = $06`, `LIB = $B000`, `lib.cfg` (code `$B000` 8 KB, `LIBBSS` `$E000` 2 KB), `dbe.inc` (2.2/2.3, 3.1), dispatcher with table 3 (F ≥ 17 and all F not yet implemented: `E_NOTIMPL`), `INIT`, `POOLSET`, `BUFSET`; sim65 harness (`test/sim/viewsim.c`, `sim.cfg`, `run_sim.py`); VICE smoke test (`test/vice_smoke.py`, `test/vice/smoke.bas`); Blitz! measurement (`test/vice_blitzvars.py`). `VERSION` = 0.2 (files `dbe0.2.stub`, `dbe0.2.lib`).

Sizes (`build/*.map`): lib code 322 bytes (`$B000–$B141`), lib variables 11 bytes, stub 132 bytes. The estimate 2.6 (≈ 5.1 KB code) remains untouched, the 8 KB are ample.

Determinations that the specification left open:
- `INIT` additionally clears `ITEMPH`…`OBJVIS` (`$0C08–$0C11`) and sets `VCLADR` = `$1300`.
- `POOLSET`: pool start ≥ pool end (end ≠ 0) gives `E_RANGE` (6) and leaves the old pool in place (3 mentions only A = 0).
- In the normal build the lib has no test functions; `build.sh` additionally builds `dbe0.2-test.lib` with `-DDBE_TEST`: F = 250 (returns `$D506 AND $0F`, `$FF00`, one byte from `$1300`, writes `$A5` to `$1301`) and F = 251 (wait loop, P0 × about 1300 cycles). Only for the smoke test.
- The smoke test checks: `$D506` = x6 and `$FF00 = $7E` in the call, reading and writing bank 0 up to `$1FFF` from the lib, jiffy clock keeps counting in a call of about 1 million cycles (30–120 jiffies), checksum bank 0 `$1C00–$3FFF` unchanged, `BUFSET` via the stub, then `VMW`, `VMD`, `RXV` (interpreted and Blitz! image 2).

## Result P6c (2026-11-25)

Implemented in `engine/lib.s`: `MAPINIT`, `SETPOS`, `CELL`, `SETCELL`, `SETITEM`, `ITEMSET`, `GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET` with the checks from 3.2. Lib code total 2174 bytes (P6a: 322), BSS 512 bytes (`$E000–$E1FF`). Code per function (bytes, including own branches): `MAPINIT` 419, `SETPOS` 49, `CELL` 75, `SETCELL`/`SETITEM` 59, `ITEMSET` 29, `GEOMSET` 356, `TEXSET` 121, `BGSET` 107, `SPRITESET` 178; common helpers (header check, pool, fill set, cell pointer, tile flags, px/py) about 500; check tables 68. Cycles (pure function, estimated without harness overhead): `MAPINIT` about 1 000 (7 × 5; copy per byte about 16), `GEOMSET` about 5 500, `TEXSET` about 300; target 8 (≤ 20 000) met.

Determinations that the specification left open:
- Error order: `E_STATE` (map or geometry missing), `E_RANGE` (set/kind number, cell), `E_FORMAT` (magic, version, fixed lengths, kind ≠ X, NST = 0, NA ∉ 1…4, NP = 0), `E_GEOM` (ID, NE, D, stride, VW, VH), `E_RANGE` (pool). **Kind byte ≠ X is `E_FORMAT`** (3.1 does not assign it).
- `MAPINIT` sets `map_ok` to 0 first: after an error (A = 1) `CELL`/`SETPOS`/… return `E_STATE`. Additionally checked beyond 3: start cell < W·H, direction ≤ 3, outer tile < NT, offsets gapless (24, +W·H, +W·H, +8·NT, +4·NE) and total length without 16-bit overflow. Return: X = W, Y = H, P0 = start cell, P1 = start direction; X bit 0 is stored as `map_auto`.
- Working copy: P1 ≠ 0 copies both layers (2·W·H bytes). Without a copy `SETCELL`/`SETITEM` write **into the DMP itself**.
- `SETPOS`: direction > 3 gives `E_RANGE` (position unchanged). `CELL` outside: A = 6, X = outer tile, Y = 0, **P1 = flags of the outer tile**.
- `GEOMSET`: additionally VW ≥ 1 and VH ≥ 1 (otherwise `E_FORMAT`; VH = 0 would destroy the row table). Clearing on a different ID: all DTS and the DBG; S2 sets with ID ≠ 0 on a different ID, S2 sets with ID 0 only on a different D or stride. Return X = bits of the cleared S2 sets, Y = bits 0–2 DTS, bit 3 DBG. With A = 1 the state remains unchanged.
- Stored (3.2): per DTS/S2 set 16 bytes (`recs`): valid, VRAM base, NS/NA, NST/NP, ID (S2), content start, three absolute table addresses (DTS: slot map, style table, directory; S2: index table, directory, core table). `VIEW` does not need cores and VMS lists as a table address: the directory entries contain content-relative offsets (content start + offset); `angle_map` (S2 header 12–15) is read by `VIEW` via content start + fixed header offset. Deviation from 3.2 ("never reads header offsets"): only fixed header fields, no offset words. DBG: base, VRAM base, P, y0, h, flags; `o_v` and fill bytes via the base. Map: absolute addresses of tile layer, content layer, tile table, events; DVG: depth and element table, row table (200 bytes).
- `BGSET` always stores X as fill byte (also with DBG); `P0 = 0` and `TEXSET`/`SPRITESET` with `P0 = 0` also clear without `GEOMSET` (A = 0).
- Test: `test/sim/run_sim.py` (P6c sim A: geometry and assets with the demo data, error and pool cases, ID change; B: map `demo.toml` with/without working copy; C: maps 128 × 128, 255 × 64, 1 × 255, 255 × 1 with NT = 256 etc.). Comparison of the BSS values against expectations computed from the files.

## Result P6d (2026-11-25)

Implemented: `VIEW` without objects in `engine/view.s` (included by `lib.s`): sections 5.1–5.7, 5.9 (bands with edge via `clip_image`: cores and VMS list with type 3, trial run for the size), 5.10, 5.11. Object slots call `objects` (P6e, still empty); `clip_image` is general (image position x0/y0, clip rectangle L/R/T/B, T·stride) and reusable for sprites.

Structure: visibility pass front → back; each entry enters the visibility list with its parameters (8 fields × 96, one array each). Its size is delivered by the same generator as the output in counting mode (no separate size calculation, so that nv/nm always match the output). STOP resets the stack pointer and jumps into the output. Cells are computed once per depth (fixed axis per depth, side axis per cell); floor/ceiling/blocked per cell and the floor/ceiling element per cell are remembered by the cell pass, `bands` runs over cells (fallback: all elements if a cell has two floor or ceiling elements). `spans(bcov)` is cached until `bcov` changes. Block copy of the VMS lists with self-modifying code (`vcopy`).

Implementation of the decisions from the P6c review:
1. `TEXSET` stores the address of the style row per style (`sty_lo/hi[kind · 32 + st]`); `resolve` does not compute st · NS. For this newly checked: NST ≤ 32 (otherwise A = 1).
2. S2 set: `recs+14` = NA · D (for the index (f · NA + ai) · D + d − 1 in P6e), `recs+15` = 0; the core table address is dropped.
3. `MAPINIT`: working copy only in `$4000 ≤ P1` and `P1 + 2·W·H ≤ $B000` (without 16-bit overflow), otherwise A = 6 and no valid map (as with A = 1). Test: exactly below `$B000` ok; one byte above, from `$B000`, BSS, DVG, I/O, below `$4000`, `$2000`, `$0400`, overflow: A = 6 and afterwards `CELL` A = 5. The lower limit `$4000` cannot be tested positively in the sim65 harness (the program lies there).
4. Synthetic DVG with two fronts per cell: `dbeview.double_fronts(assets)` (every front of depths ≥ 1 doubled, shifted by −1/+1/0 columns, alternately directly behind or behind the side: F, S, F′ checks the CONTENT order) and `dbeview.dvg_bytes(dvg)`; `test_dbeview.TestDoubleFronts` (pixels demo × 4 directions × bit 3, random) and sim comparison (section "two fronts").

Further determinations:
- `GEOMSET` additionally checks S ≤ 15 (cell table per depth, 31 entries), `BGSET` P ≥ 1 (otherwise endless loop at q mod P); both A = 1.
- Pending area (pend) 16 entries per depth; more gives A = 2 ("tables full"). The reference knows no limit; not reached in any test scene.
- The lib BSS begins with `bss_start` before all variables (also those of `view.s`); `argx` is exported (tests).

Test (`test/sim/run_sim.py`, `test_p6d`): per view A, X, Y, P0, VCLADR/VCLLEN/VMSLEN/OBJVIS and the buffer (VCL + VMS) byte-identical with `dbeview.view`. Sets: demo (all free cells × 4 directions × bit 3 off/on, without DBG with fill byte, ap `$0123`/`$E200`/`$F800` (window across 65535), origin 123), abyss, corridor, random (default 60 maps × 6 views, `DBEVIEW_FULL=1` 200 × 20; CONTENT, gaps, blocked cells, outer tile, bit 3 and DBG random, ap ≠ 0, buffer 2304 or 3840 bytes), overflow (BUFSET 64 … 1024 bytes: A = 2 and A = 3), two fronts. Result: 1302 views (full: 4942) byte-identical, of which A = 2: 270 (873), A = 3: 20 (69). P6a/P6c still green. Cycles: difference of two runs (VIEW against F = 7, new silent call set 4 in the harness).

Sizes: lib code 7 960 bytes (`$B000–$CF17`, of which VIEW about 5.6 KB), BSS 1 993 bytes (`$E000–$E7C8`). **Finding:** 232 bytes of code and 55 bytes of BSS remain – too little for P6e (objects, sprite entries with x0/y0/clip rectangle). The estimate 2.6 (VIEW ≈ 3 KB) is exceeded, mainly because all variables are addressed absolutely (zero page only `$FA–$FD`).

Cycles per VIEW (sim65, demo assets 140 × 96, D = 3):

| Set | n | min | mean | max | Target 8 |
|---|---|---|---|---|---|
| Corridor, occluding, uniform bands | 60 | 29 959 | 90 696 | 106 247 | mean ≤ 30 000, max ≤ 45 000 |
| demo | 56 | 29 927 | 68 655 | 111 364 | – |
| random (open, mixed, wallpaper) | 40 | 70 645 | 106 719 | 143 610 | max ≤ 80 000 |
| two fronts | 28 | 34 950 | 75 829 | 127 974 | – |

**Finding:** Targets missed (factor about 3 and 1.8). Profile (corridor): cell pass and cells about 16 000, generator prelude (reading directory entry, twice per entry) 7 900, VMS copy 5 300, `bands` 4 800, `spans` 3 900, `add` 3 600, `resolve` 3 200. The costs are spread widely (loops over all elements of the depth, absolute addressing, 16-bit pointer arithmetic), no single bottleneck. Proposals for P6f: more zero page during `VIEW` (save/restore), precomputed element/cell tables per depth at `GEOMSET`, keep generator values per entry from the counting run, spans incrementally.


## Decisions after the P6d review (2026-11-25)

User:
1. Lib code up to `$DFFF`: the stub sets `$FF00 = $7F` during the call (bank 1 without I/O); the lib does not access I/O.
2. VMS lists are no longer copied to bank 0 per image: VDC-BASIC v3 gets a bank 1 source for VMS lists (VCL type 12 / VMS). Cycle targets remain 30k/45k/80k.
3. Zero-page block (e.g. `$63–$72`) during `VIEW`, saved and written back in the stub – only after proof in VICE (interpreted and Blitz!, with IRQ).

Main agent (technical):
4. VCL list no longer fixed at B0, but at an address that `VIEW` returns in P0 (`::VCL` with this value).
5. `$0B00`/`$0E00` as engine reserve.
6. Restrict `BUFSET` to allowed windows (not below `$1300`, not above `$1BFF`), `GEOMSET` checks the element table (cells contiguous, limits for pending area and masks) → `E_FORMAT`.

## Result P6d-opt (2026-11-25)

Implemented according to `P6d-review.md` and the decisions above. Byte-identical with `dbeview.view` in all sets (`run_sim.py`: 1322 views standard, 1302 with `VMS_BANK1`; `DBEVIEW_FULL=1`: 4962 and 4942), `test_dbeview.py` green (also full), VICE smoke test and `test/vice_zp.py` green (interpreted and Blitz! image 2).

### Measures and cycles (sim65, mean/max per view; without stub, the stub costs about 450 cycles additionally)

| Step | Corridor mean | Corridor max | random max | with `VMS_BANK1` (provisional, 6a): corridor mean / max / random max |
|---|---|---|---|---|
| P6d (baseline) | 90 696 | 106 247 | 143 610 | – |
| 1 Stub `$FF00 = $7F`, code up to `$DBFF`, LIBTAB | 90 696 | 106 247 | 143 610 | – |
| 2 Cell table (GEOMSET), walls only, allcov before resolve, `rtab` | 76 163 | 89 833 | 128 326 | – |
| 3 Single pass (VCL downward, VMS upward, withdrawal on overflow) | 58 654 | 69 791 | 101 343 | 50 242 / 56 403 / 76 100 |
| 4 Band decision in the cell pass | 52 857 | 64 415 | 95 989 | 44 452 / 51 039 / 68 795 |
| 5 Zero-page block, interval masks, tile tables (MAPINIT), direct core/row output, `bgoffs` at BGSET | **41 446** | **52 087** | **83 671** | **33 017 / 38 679 / 54 874** |
| Target (section 8) | 30 000 | 45 000 | 80 000 | |

Assessment (values with `VMS_BANK1` provisional, engine cycles only, 6a): With `VMS_BANK1` (VDC-BASIC type 9) corridor max and random max are met, corridor mean is 10 % above. Without bank 1 lists the copy alone costs about 8 400 cycles in the corridor (432 VMS bytes per view on average). The VICE proof for the zero-page block was done before step 2; steps 2–4 therefore already use the pointers in the block, step 5 the individual values.

### Determinations

- **Stub/memory:** `$FF00 = $7F`; lib code `$B000–$DBFF` (11 KB), LIBTAB `$DC00–$DFFF` (cell table, tile summary; INIT does not clear it), BSS `$E000–$E7FF`. Test build `lib-test.cfg` (padded to `$DBFF`, function 252 at `$DB80` checks code under I/O). Function 250 briefly sets `$D506` to `$7E`.
- **Zero-page block `$63–$72`:** The stub saves it on every call (all functions) and writes it back. Proof `test/vice_zp.py`: 20 long calls (function 253 fills the block, waits about 330 000 cycles, checks it) under jiffy/keyboard, SOUND with sweep and MOVSPR; watchpoint (read/write) on `$63–$72` only between `JSR LIB` and return: 640 hits, all from the lib (`$FF00 = $7F`), **0 foreign**; afterwards SIN, STR$, VAL, division correct; control test `--control` (watchpoint on `$A0–$A2`) finds the Kernal IRQ accesses. NMI was not checked.
- **GEOMSET** checks the element table (7) in one pass and creates the cell table in the process (per cell s, first element, slot, wall list, floor/ceiling slot). Error in the element table: A = 1 and **no valid geometry** (`geom_ok = 0`; header errors leave the state unchanged as before). Object slots are not in the table (P6e adds them). `dbeview.parse_dvg` checks the same (`check_elems`).
- **BUFSET:** window `$1300–$1BFF`; `BIGBUF` of the tests is thus the default buffer.
- **Single pass/VCLADR:** P0 = VCLADR = B1 − VCLLEN; VMS from B0. Harness `viewsim.c` delivers VCL from VCLADR, then VMS from B0 (`dbe_b0`). Reference: `Result.b0`, `bank0()`, `bank1()`, `lists1`.
- **MAXITEM** remains as a counter; test with `-D MAXITEM_T=8` (own sim build) against the reference with `MAXITEM = 8`.
- **Masks** as sorted interval lists (at most 41 per mask), no clearing per VIEW. `spans` from the gaps of the bcov list.
- **Tiles:** MAPINIT creates `tpl/tph` (address) and `tsm` (faces, blocked, flags) per tile (768 bytes; MAPINIT demo 2 100 cycles, at NT = 256 about 20 000).
- **sim65 harness:** stack `$200` (program otherwise too large); reserve only 81 bytes left (MAIN ends at `$4DAE`, limit `$4E00`) → before P6e place lib code in the harness at `$B000`.

### Sizes

Lib code 8 935 bytes (`$B000–$D2E6`, P6d: 7 960), LIBTAB 764 bytes, BSS 1 799 bytes (P6d: 1 993; visibility list −672, tile pointer +512), stub 168 bytes. Reserve: code 2.3 KB, BSS 249 bytes, LIBTAB 260 bytes.

### Open points

1. Corridor mean with `VMS_BANK1` 33 000 instead of 30 000. Candidates: precompute ROWS groups at TEXSET (~1 000), cache `resolve` for walls (~800), slimmer `gsetup`/`itemadd` (~800).
2. GEOMSET 24 400 cycles (demo, target 20 000; once).
3. Implement VDC-BASIC type 9 (6a), then make `VMS_BANK1` the default and measure in VICE (P6g).
4. P6e: object slots into the cell table, objects in the cell pass (interval mask for "first/last free column").

## Result P6e (2026-11-25)

Implemented: objects and items in `VIEW` (5.8) in `engine/view.s`, byte-identical with `dbeview.view` (no change to `tools/dbeview.py` necessary).

### Implementation

- **sim harness:** Lib code in the harness at `$B000` (segment `LIBCODE`, `.define LIBSEG` in `lib.s` under `SIM`); `sim.cfg`: harness `$2000–$2BFF`, stack up to `$2DFF`, data `$2E00–$AFFF`, the file is contiguous up to `$DBFF`. Load addresses of the tests: DTS wall `$6000`, floor `$8300`, ceiling `$F000`, S2 from `$3000` (additional sets from `$A700`), large maps (P6c C) `$2E00`. `viewsim.c` rejects segments in the harness and lib code. sim65 runs with a guard timeout (300 s).
- **Cell table (GEOMSET):** `k_ob`/`k_oe` = 16 · slot of the first/last object slot of the cell (`$FF` none). Several object slots per cell are allowed (like the reference).
- **Cell pass:** cells without faces → objects; faces with CONTENT → fronts, objects, sides (5.2a); otherwise walls only. `objd` (d ≥ 1 and objects or items possible) switches the object part off per depth, without objects it costs nothing.
- **Candidates:** At the start of `VIEW` the list of visible objects (bit 6 = 0, min(OBJN, 16)) with cell index, i, 6 i and a 256-bit field `obm` of the low bytes of the cell indices (pre-filter per cell; only the bits of the previous `VIEW` are cleared). Item from the content layer only if `itemn` > 0 (number of `itemtab` entries ≠ 0, maintained by `ITEMSET`). Paint order without sorting: p = 4 … 0, per p the candidates backwards (objects i descending, the item last).
- **Image:** `lookup` according to P5b 6.3 (f ≥ NP → 0, `angle_map`, `$FF` → phase 0, `$FE` → nothing), anchor x0/y0 16 bit sign-correct, window and `cover` clip rectangle (first/last free column from the interval list, `ffree`; dropped since P6i: window only, `allcov_c` discards fully occluded sprites).
- **Generator `gspr`:** Cores with `clipcores`; edge unclipped as a copy into the buffer (type 12, **also with `VMS_BANK1`**, like the reference), clipped by rows only (L = 0, R = w) via a fast path without column computation (visible exactly T · stride ≤ ofs < B · stride), otherwise `clipvms_e`. `clipvms_e` reads length and source from `g_vlen`/`g_rsrc` (DTS and S2 have different directories).
- **Empty sprite entries** (neither core nor edge command in the clip rectangle) are not entries: they do not count for MAXITEM (not even when the entry count is full: then counting dry run) and set no OBJVIS bit (12a.2). OBJVIS bit i on acceptance, also "without edge"; not on "discarded".
- **K6:** Row counter in `clipvms_e` ends at r = B (does not overrun). VMS copy unrolled fourfold (14 instead of 17 cycles per byte, also effective for walls).
- **VMS_BANK1** remains a build switch; `TEXSET` rejects DTS below `$4000` there (P2d, 6a). *(Superseded by the review addendum below.)*

### Test (`test/sim/run_sim.py`, `test_p6e`; GEOMSET edge cases in `test_geomcheck`)

Byte-identical (A, X, Y, P0, VCLADR/VCLLEN/VMSLEN/**OBJVIS**, buffer) in all sets: demo with 0/1/5 objects (all free cells × 4 directions, items, ITEMPH), edge (sets blob, guard, wide and three additional sets "up" (out the top), "links", "rechts"; s = −2 … 2, d = 1 … 3, all q), edge behind occluding walls, CONTENT (doors/gratings occluding and not, objects and items on them), random with 0–16 objects (bit 6/7, unknown sets, OBJN = 20), overflow (64 … 1024 bytes, A = 2 and 3), MAXITEM = 8. Standard: 1 600 views (with `VMS_BANK1` 1 570), `DBEVIEW_FULL=1`: 5 240 (5 210), of which A = 2: 1 577, A = 3: 60; P6d full 4 962 (4 942). P6a, P6c, P6d unchanged green.

GEOMSET (new): 16 elements in one cell ok / 17 A = 1, 48 cells ok / 49 A = 1, 96 walls ok / 97 A = 1, two ceiling elements A = 1, `VIEW` after a failed GEOMSET A = 5 (afterwards with a valid GEOMSET 0 again); `parse_dvg` the same.

### Cycles (sim65, demo assets, without stub)

| Set | Mean | max |
|---|---|---|
| Corridor without objects (P6d set) | 40 439 (P6d-opt 41 446) | 50 280 |
| Corridor without objects, `VMS_BANK1` | 33 380 (33 017) | 39 066 |
| demo with 1 / 5 objects | 33 782 / 37 595 | 68 125 / 95 147 |
| random with 0–16 objects | 82 224 | 136 168 |

Per object (open room, difference to the view without objects, contains the object part of all cells ≈ 2 700):

| Case | Cycles | Target 8 |
|---|---|---|
| unclipped (blob d = 1/2/3, 227/145/87 VMS bytes) | 8 443 / 7 365 / 5 732 | 2 500 + 12 per byte ≈ 5 200 / 4 240 / 3 540 |
| Edge left/right (wide d = 1, 242 list bytes) | 25 400 – 27 200 | 4 000 + 12 · 242 ≈ 6 900 |
| out the top (up d = 1/2/3, rows only) | 25 255 / 15 774 / 18 303 | ≈ 7 500 / 6 100 / 7 000 |
| invisible (clipped out) | 2 724 | – |

**Finding:** Targets for objects missed, unclipped by about 1.5×, clipped by 3–4×. Cause clipped: `clipvms_e` costs about 130 (invisible) or 250–280 cycles (visible: row tracking, 16-bit column, `cflush`/`cput3` per command, counters) per command. Cause unclipped: candidate search and image search (≈ 2 700 base load per `VIEW` with objects, ≈ 100 per cell) and the copy (14 per byte).

### Sizes

Lib code 10 747 bytes (`$B000–$D9FA`, P6d-opt 8 935), LIBTAB 945 bytes, BSS 1 926 bytes (P6d-opt 1 799). Reserve: code 517 bytes up to `$DBFF` (test build up to `$DB80`: 261 bytes), BSS 122, LIBTAB 79.

### Open points (P6f/P6g)

1. Speed up `clipvms_e`: visible commands blockwise (copy a run of visible commands of a row with one offset), `cput3`/counter inline, column 8-bit for stride < 256; target ≈ 40–60 cycles per command. Likewise the row path (visible run in one go).
2. Base load objects: object (d, s) once per `VIEW` instead of a comparison per cell (M9: cell pointer at `SETPOS`), cache `lookup` per candidate.
3. Unclipped sprite lists with `VMS_BANK1` as type 9 (saves the copy; adapt reference and spec 6a as soon as P2d is decided).
4. Code reserve only 0.5 KB: P6f (MOVE, automap) needs space → candidates for savings: merge `vpass`/wall loop, simplify `clipcores`/`ckwrite` with `mul8`; if necessary shrink LIBTAB or pack code tightly up to `$DBFF`.
5. VICE run (P6g) with objects; NMI still unchecked (P6d-opt).

### Addendum review P6e (2026-11-25)

- **Type 9 is the default** (6a): unclipped lists of walls, tiles, bands and now also sprites go as VCL type 9 to bank 1; build switch `VMS_COPY` = old way (type 12 everywhere). `vmscopy` is now only in the `VMS_COPY` build. `SPRITESET` checks like `TEXSET` S2 ≥ `$4000` (A = 6); both checks are now tested in P6c (before, P6c ran only with the build without check).
- Reference: unclipped sprites with `vms_bank1` as `vms1` (address `Scene.s2_bank1(k)` + vofs). `double_fronts(assets, objs=True)`: second object slot per cell; an error was found in the process: `copy.copy` adopted the vofs cache of the template (wrong type 9 addresses for walls of the synthetic DVG, went unnoticed only because of the test order).
- sim: default PRG = type 9, `viewsimc.prg` = `VMS_COPY`; layout in `ViewRunner`: DMP `$2E00`, S2 `$4000–$5FFF` and `$A700–$AFFF`; P6c: S2 from `$4000`, valid header copies at `$A700`. New set "two fronts, two object slots" (k_ob < k_oe, 68 views). Set "rechts" without image for d = 2 (index `$FE`, previously untested).
- Byte-identical: standard 1 668 / `VMS_COPY` 1 638 (P6e), full 5 308 / 5 278; P6d full 4 962 / 4 942; test_dbeview green (`test_vms_bank1` with objects).
- Cycles (standard): corridor without objects 33 416 (max 39 111), demo 1/5 objects 26 311 / 29 988, random 0–16 objects 64 296; per object unclipped 4 318–5 001 (target met), clipped unchanged 15 800–27 200.
- Size (standard): code 10 596 bytes (`$B000–$D963`), reserve 668 (test build 412); `VMS_COPY` 10 747.

## Result P6e-opt (2026-11-25)

Implemented in `engine/view.s` according to the plan from the review addendum P6e, in three steps, byte-identical with `dbeview.view` after each step (no change to `tools/dbeview.py` and to the tests).

### Implementation

1. **Code saving (−205 bytes, without cycle loss):** `grand`/`grl` (g_rsrc = VB + edge_ofs, ZP1 = content + list, g_vlen from a directory entry; DTS and S2 are offset by 2) for `gspr`, `gband` and `vmsverb` (`VMS_COPY` only; the main wall path remains without a subroutine). `emit_vms` takes the source from `g_rsrc` (copies to `e_src` dropped, `clen` and `e_t` dropped). Common VCL tail `vt5` (count, 0, reps, 0, step) for `emit_vmc` and `emit_vmf` (thereby also faster). Wall loop of `vcells` and `vpass` merged (one pass, CONTENT with pass 1/2). `gspr` uses `gsetx` (entry into `gsetup` with X = set). Counting dry run `gcnt` shared by `itemadd` (MAXITEM) and `iovf`. Outer tile branch moved out of the cell loop.
2. **`clipvms_e` new:** Row state machine in ofs space. Row r is visible in [tL, tR) = [r·stride + L, r·stride + R); visible commands get ofs′ = ofs − cfix with cfix = T·stride + L (the multiplications T·stride and (B − T)·stride are now in `clipvms_e`, `cl_rt`/`cl_rb` dropped in `vspr`/`gband`). Per row: skip commands with ofs < tL (16-bit comparison, k += length), look back at the last skipped type 1 (run clipped on the left, only for L > 0; also at the list end), then copy the visible commands directly as a block: `op` is offset such that `(op),y` is the output position for the input index y (one Y for input and output, ofs′ by addition of −cfix); before it 3 bytes remain free for the type 3, which is written only when the block is completed (not empty). A command with ofs′ ≥ lim′ (= tR − cfix) ends the block; a run clipped on the right (only for R < w, `cl_w`) is taken into the block with shortened length. Clipped by rows only (`ofull` = 2): one block over all rows, lim′ = (B − T)·stride. Y runs over the list (from Y ≥ `$FC` ZP1 is advanced, Y = 4, so that the look-back stays reachable), X/`ccnth` count the commands, `cn` per block from the X difference. Column 8-bit: only R − L and the difference lim′ − ofs′ at the right edge.
3. **Base load objects:** Cell marker in the cell pass instead of `jsr vobjc` per cell: low byte of the cell index (idxd + r_lo[s]) against the bit field `obm`, `vobjc` only on a hit (checks completely as before, also cells outside the map). `objon`/`objd` bit 7 = items possible (`itemn` > 0): then continue every cell via `vobjc` (content layer). Phase f · NA · D by addition instead of `mul8`. `mul8` with registers instead of BSS counter (about 30 cycles faster per call).

### Determinations

- **Format prerequisite** for clipping (P5b 4.6, met by the converter): ofs = row · stride + column with column + len ≤ w ≤ stride; a run stays in its row; commands ascending without overlap (review: added, `dbetex.check_vms` in `from_s2`/`from_dts`). Thus the row of a command is ofs div stride, and a run of row r − 1 never extends beyond tL of row r. For lists that violate this, the output is no longer necessarily equal to the reference.
- **Counting mode** (`iovf`, MAXITEM trial): the block writes to bank 0 `$0B00–$0BFF` (engine reserve, 2.2 adapted), the individual commands write nothing; the size results from the output position. Space check during direct writing: 2 · vlen + 4 (the command copied for the trial behind the block).
- **Zero page:** `clipvms_e` uses `kwi`/`kwn` (zt+4/5) as `cyl`/`cq` and `dp` as k; `dp` is saved and written back before `emit_vms` (`iovf` regenerates the entry and reads `dp`).

### Test

`run_sim.py` unchanged: P6e standard 1 668 / `VMS_COPY` 1 638 views byte-identical, `DBEVIEW_FULL=1` 5 308 / 5 278; P6d 1 322 / 1 302, full 4 962 / 4 942; P6a, P6c, GEOMSET edge cases green. Clipped lists over 252 bytes (advancing ZP1 in skipping and in the block), runs clipped on the left at the list end, runs clipped on the right and counting mode (overflow, MAXITEM = 8) are contained in the sets.

### Cycles (sim65, demo assets, without stub; standard build type 9)

| Case | P6e | Step 1 | Step 2 | Step 3 (P6e-opt) | Target |
|---|---|---|---|---|---|
| Corridor without objects, mean / max | 33 416 / 39 111 | 33 365 / 39 049 | 33 373 / 39 064 | **33 364 / 39 048** | 30 000 / 45 000 |
| Corridor without objects, `VMS_COPY` | 40 439 / 50 280 | 40 390 / 50 210 | 40 409 / 50 237 | 40 422 / 50 254 | – |
| random without objects, mean / max | 41 314 / 55 653 | 41 154 / 55 462 | 41 178 / 55 489 | 41 159 / 55 457 | – / 80 000 |
| per object unclipped d = 1 / 2 / 3 | 4 999 / 5 001 / 4 318 | 5 091 / 5 093 / 4 425 | 5 073 / 5 075 / 4 406 | **3 884 / 3 886 / 3 217** | 5 200 / 4 240 / 3 540 |
| per object clipped left (d = 1, 242 list bytes) | 25 424 | 25 496 | 17 245 | **16 045** | 6 900 |
| per object clipped right (d = 1) | 27 213 | 27 267 | 17 307 | **16 112** | 6 900 |
| per object out the top d = 1 / 2 / 3 | 25 375 / 15 820 / 18 353 | 25 302 / 15 851 / 18 380 | 14 703 / 10 381 / 11 570 | **13 432 / 9 105 / 10 290** | 7 500 / 6 100 / 7 000 |
| per object invisible (clipped out) | 2 709 | 2 725 | 2 725 | 1 535 | – |
| demo 1 / 5 objects (with items), mean | 26 311 / 29 988 | 26 306 / 30 003 | 26 308 / 29 056 | 26 315 / 29 048 | – |
| random 0–16 objects, mean / max | 64 296 / 116 471 | 64 524 / 117 387 | 62 344 / 106 763 | **62 192 / 106 554** | – |

**Finding:** Unclipped objects are below the target, the base load has dropped by about 1 200 per `VIEW` (without items). Clipped objects are 1.6–1.9× faster, but the target ≈ 6 900 is **missed** (16 000 and 13 400). Breakdown edge d = 1 (68 commands, 22 or 34 visible, 15 rows): list ≈ 11 200 (skipping ≈ 3 100 with 57 passes at ≈ 55, block ≈ 3 800 with 45 passes at ≈ 80, per row find, block start, type 3, completion and row change ≈ 200), 4 cores ≈ 2 000, rest ≈ 2 800. Top d = 1: list ≈ 7 200 (89 commands), 4 cores clipped at the top ≈ 3 300 (one `mul8` each). The list has to be read command by command (length and source bytes per command); with about 50 cycles per skipped and 70 per copied command the lower bound for the edge case is about 9 000–10 000 per object.

### Sizes

Lib code 10 457 bytes (`$B000–$D8D8`, P6e 10 596; step 1 10 391, step 2 10 445, step 3 10 457), reserve up to `$DBFF` **807 bytes** (`VMS_COPY` 10 550 bytes, reserve 714; test build 10 585 bytes, reserve up to `$DB80` 551). BSS 1 920 bytes (P6e 1 926), LIBTAB 945 bytes (unchanged).

### Open points

1. Target for clipped objects: reachable only with a format addition, e.g. a row index per image in the S2 (per image row index of the first command and source position: skip rows before T and commands left of L without reading, k from the difference of the source positions). Decision user (P5b/P6f). Without a format change about −500 (block completion inline, type 3 at block start) and for cores about −100 per core remain.
2. With items (`itemn` > 0) the cell pass continues to check every cell via `vobjc` (demo values unchanged).
3. Corridor mean 33 364 (target 30 000) still open (P6d-opt).

### Addendum review P6e-opt (2026-11-25)

- **Bug `clipvms_e`:** after a run clipped on the right, from Y ≥ `$F8` it went into the next row with Y = `$FC…$FF` without advancing ZP1; the next command ran past Y = `$FF` (Y = 0, wrong list), unless the row was the last. Fixed (`@pn`: check Y ≥ `$FC`, +5 bytes, only on this path). New test set "grating" (`tall_sets`, set 7; set 1 in the edge test free because of the S2 space in the sim): wide images without cores, runs per row, half bytes and gaps, long lists; hits the case (before: 1 deviation).
- **Counting dry run/`iovf`:** in the "size known" mode (without space check) the block wrote up to 9 bytes of garbage behind mp even with an empty result list; with exactly fitting space the VCL entries of the cores are already there. Now: `im` = 0 → return immediately. With a list the garbage stays at most 6 bytes behind its end, where the 7-byte type 12 entry is still free. Counting mode: garbage only `$0B00–$0BFF` (block < 256 bytes, type 3 at `$0B00–$0B02`); no collision (BUFSET window `$1300–$1BFF`, `$0B00` reserve since P6d-opt).
- **Format rule:** `dbespr`/`dbetex` satisfy it on creation (`pack_image`), nothing was checked on reading, and "without overlap" was not in P5b 4.6 (VIEW presupposes it: look-back only at the immediately preceding command, row finished after the run clipped on the right). Added: `dbetex.check_vms` (type 1/8, count/length, row < h, column + len ≤ w ≤ stride, ascending without overlap) in `from_s2` and `from_dts`; test `test_check_vms`, `test_vms_format_rules` checks overlap.
- Byte-identical: P6e standard 1 743 / `VMS_COPY` 1 713 views (edge 525), full 5 383 / 5 353; P6d, P6a, P6c, GEOMSET green. Cycles unchanged (±40). Code 10 473 bytes (`$B000–$D8E8`), reserve 791 (test build up to `$DB80`: 535).
- **Row index per image (open point 1):** 4 bytes per image row cost +20 … 60 % S2 in the demo sets (set "up" +123 %), plus format/tool change and ≈ 80–120 bytes of code. Benefit: rows before T are dropped (out the top ≈ −3 000), for edge left/right only the commands right of R (≈ −1 500 … −2 500 per object); left of L still has to be read. The target ≈ 6 900 would remain missed (cores and base load ≈ 5 000). Recommendation: do not implement; if out the top becomes important, a coarse index (every 8 rows, ≈ 3–8 % S2).


## Result P6f (2026-11-25)

Implemented: `MOVE` (3.4) and automap bit 6 in `VIEW`; `CELL` has been finished since P6c (test `map_check`, unchanged). Reference: new module **`tools/dbemove.py`** (`MOVE` only, needs neither DVG nor DTS; `move(m, pos, v, objects, action, objn)`), the automap part in **`tools/dbeview.py`** (`Scene.automap`, `_View.seen`/`seen_floor`), because it needs the internals of the visibility computation (`cover`, `bcov`, cell per entry). With `automap = True`, `view()` changes the `dmp.content` of the scene (tests work on a copy).

### Determinations (gaps in the specification)

- **MOVE:** `A = 5` without `MAPINIT`, `A = 6` for X ≥ 7 (state and P0–P2 unchanged). Turning: **Y = tile of the position** (3.4 said only X = 0). Step: order of checks map → SOLID → object; object list: at most 16 entries (`OBJN` > 16 is read as 16), smallest index wins, bit 6 (invisible) and bit 7 (does not block) do not block. P3 remains unchanged; `MOVE` sets no automap bit. `px`, `py` are advanced directly on the step (no `calcxy`; edge check 8 bit: `$FF` ≥ W, also for W = 255). P2 = index of the first event with the same cell (linear search, abort at the first entry with a greater cell, because the list is sorted by cell, P4 2.5; reference and 6502 the same).
- **Automap:** `MAPINIT` X bit 0 works only with a working copy (P1 ≠ 0), otherwise `map_auto` = 0 (the DMP in bank 1 remains unchanged). Bit 6 of the content layer is marked (a) at every wall (front or side) of a cell in the map that is not completely occluded by `cover` and has an image ("accepted" = before the MAXITEM/buffer check of `itemadd`; an entry discarded afterwards marks anyway), (b) at every cell in the map with a floor element that is not blocked (OCCLUDING + four walls), whose depth has visible floor rows and whose floor element (x … x + w) is not completely occluded by `bcov` (state after `vcells`, before `vband`; also with gap and abyss). Ceiling tiles do not mark; cells outside never. On abort (`E_TOOMANY`) the marks set up to then remain.
- **Test build:** `TESTHI` (function 252) moved from `$DB80` to `$DBC0` (`lib-test.cfg`, `lib.s`, comment in `vice_smoke.py`), because the test build with the P6f functions otherwise no longer fits below `$DB80`; the probe now reads `$DBBF` (fill byte `$EA`).
- **Tests:** `run_sim.py`: P6a expects `F = 3` without `MAPINIT` as `E_STATE`; new `test_p6f_move`, `test_p6f_auto`, `test_p6f_cycles`; `ViewRunner.mapx/mapp1` (MAPINIT with working copy at `AUTO_ADDR` = `$3800`), `last_items`. `test/tools/test_dbemove.py` (reference).

### Test (sim65, byte-identical with the references)

- **MOVE:** 22 884 calls (X = 0: 15 524, 1: 5 269, 2: 2 091): demo, abyss, 6 random maps (with gratings/doors/SOLID, 0–300 events), 255 × 4 (600 events, index > 255, pointer across pages, px + 1 = `$FF`), 1 × 40, 40 × 1, 4 × 255, 1 × 1; per map all cells (for > 60 cells 60 random ones and the corners) × 4 directions × 7 actions with random objects (neighboring cells, bit 6/7, 16 objects, `OBJN` = 20) and 300 calls of long random chains without `SETPOS` in between; compared A, X, Y, P0, P1, P2 and the BSS state (`pos`, `vdir`, `px`, `py`). Error cases X = 7/255 and `MOVE` without `MAPINIT`.
- **Automap:** 2 332 views (demo, abyss, open room, corridor, 24 random maps with 6 views, two fronts, including abort through small buffers), chains over the same map (marks accumulate); after every view the working copy (2 W H bytes) equals the reference; additionally `X = 1` without copy and `X = 0` with copy (no marks, DMP unchanged). All earlier sets (P6a, P6c, GEOMSET, P6d, P6e, each standard and `VMS_COPY`) and the Python tests (106) unchanged green.

### Sizes

Lib code **11 016 bytes** (`$B000–$DB07`, P6e-opt 10 473: +543), **reserve 248 bytes** up to `$DBFF` (test build up to `$DBBF`: 56). BSS 1 922 bytes (+2, `cellp`), reserve 126; LIBTAB unchanged (945). Per function: `f_move` 387 bytes (of which 14 bytes tables `mvtab`/`mvdel`), `cellptr` 54, `mark_seen` 36, `vauto` 81, plus 3 bytes each in `vwall` and `vdepth`; 28 bytes were dropped from `vcells` (moved out to `cellptr`).

### Cycles (sim65, without stub, run with function minus run with F = 7)

| Case | Cycles |
|---|---|
| MOVE turn (mean / max) | 340 / 431 (without events 224 + map accesses) |
| MOVE step ok | 629 / 697 |
| MOVE step against map/SOLID | 512 / 626 |
| MOVE, 16 objects, blocking one last | 941 |
| Event search per entry | ≈ 56 per entry before the position (abort at the first greater one; event at position 600 of 600: 33 987; 3 … 600 events all behind the position: 254) |
| VIEW corridor, mean / max, without automap | 33 962 / 39 701 (P6e-opt 33 364 / 39 048: +600 through `cellptr`) |
| VIEW corridor with automap | 36 035 / 41 681 (+2 070) |
| VIEW demo without / with automap (mean) | 24 916 / 27 035 |
| VIEW random (0 objects) without / with (mean, max) | 41 739 / 56 094 · 45 719 / 59 526 |

### Open points

1. Event search linear: changed in the review to abort at the first greater entry (+4 bytes; cells without an event now cost only the entries before them, ≈ 56 cycles per entry). Binary search (≈ +50 bytes) is needed only for maps with several hundred events; decision user.
2. Cycle target corridor (mean ≤ 30 000) remains open (33 962; P6d-opt/P6e-opt unchanged). Automap costs +6 %; switch marks on only when needed (`MAPINIT` X bit 0).
3. Reserve after P6f only 248 bytes (test build 56): P6g/P7 should not put any larger functions into the lib any more, or check `VMS_COPY`-free savings (replace `vauto` 81 bytes by marks in `vcells`, ≈ −35 bytes, changed semantics: `bcov` still incomplete).


## Result P6g (2026-11-25)

Implemented: `test/vice_view.py` (harness, scenes, assets, comparison) and `test/vice/view.bas` (BASIC template; the harness inserts file names, addresses and set calls and generates `build/vice/view.bas`). Call `test/vice_view.py [--only i|c] [--check] [--png DIR] [--control] [--no-sim]`; port `--port`/`DBE_VICE_PORT` (runs with 6632, review follow-up run 6634), bind test, own process only, no fixed wait times. Neither `lib.s`/`view.s` nor VDC-BASIC were changed.

### Procedure

`BOOT` (VDC-BASIC v3) → `POKE 57,0:POKE 58,80:CLR` → stub, lib (standard build `dbe0.2.lib`), `INIT` → chunky mode as Crawl (`crawl.bas` 10059–10135: R0 127, R4 159, R6 120, R7 133, R9 1, R25 bit 7, R28 24, R36 0, R26 `$FF`, `DISP 46335`, `ATTR 0`, screen RAM and attribute RAM filled; beforehand the entire 64 KB VRAM cleared so that the model applies exactly) → DVG, DMP, DTS ×3, DBG, S2 ×4 via `BLOAD` to bank 1; VRL of the textures, wallpaper and sprites (`vrl.encode` of the `vram` bytes) via `BLOAD` to bank 0 `$9000` and `RXV` into the pool → `POOLSET` (9600 … 46335), `GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET`, `ITEMSET`, `MAPINIT`, `BUFSET`. The scene table (bank 0 `$8000`: SETPOS or MOVE, object list, ITEMPH) is read by BASIC with `PEEK`; per step: set call, marker `SYS 3148` (`$0C4C`, RTS), `VIEW`, `::VCL`, marker `SYS 3149`. The harness halts (breakpoints) at the error vector `($0300)` and at the markers; at `$0C4D` it reads the entire VRAM (`bank vdc`, `bsave`), the buffer `$1300–$1BFF`, parameter block and test bytes (`$0C40–$0C46`: A/X of `VIEW`, A/X/Y/P0 of `MOVE`).

Comparison per scene: (1) the **entire VRAM** (64 KB) byte-identical with a model (`run_vcl` over the reference list, state carries over from scene to scene); this also checks "no byte outside the window"; (2) the window against `paint_reference` (only for A = 0); (3) A, X, VCLADR, VCLLEN, VMSLEN, OBJVIS and the buffer bytes (VCL list and VMS lists) against `dbeview.view` (= sim65); (4) `MOVE` result A/X/Y/P0 against `dbemove.move`. Control test `--control` (one byte in the model falsified): exactly this scene is reported. Cycles: stopwatch of the monitor; VIEW from `$0D03` (stub entry) to the RTS of the stub, VCL from the entry `vcl` to `.vcl_done` (`vcl` from `vdcbasic3.sym`, the local marker from the ACME report, `vdc_labels`; review: previously `complex_instruction_shared_exit`, see addendum); in both windows the I flag is set (no Kernal IRQ, comparable with sim65), afterwards as before. "with BASIC" = everything between the markers (assignments, `POKE`, `SYS` evaluation, `::VCL` parsing, IRQ on). Column sim65 = the same view in the sim65 harness (difference of two runs, without stub).

### Scenes (42; each interpreted and as Blitz! compilation, image 2)

Demo map 15 × 11: corridors, room with sky (wallpaper), grating, window wall, abyss, CONTENT door, item. 18 views walls/floor/ceiling/wallpaper/grating/window/abyss/item, 8 with objects (centered d = 1/2/3, all sub-positions, guard + gem + ITEMPH, `wide` at the left/right edge and at d = 2, 5 objects in the open room; `VMS` type 12 clipped in 4 scenes), 4 CONTENT scenes (empty, blob d = 3/2, two blobs d = 1), 12 MOVE steps (start, forward, turn, sideways, against wall X = 1, against object X = 2, turn around, back).

### Result

**All 42 scenes in both runs pixel-identical** (entire VRAM = model, window = `paint_reference`, buffer = reference, MOVE results equal, A = 0 everywhere, no BASIC errors). The check applies only to the scenes provided, not to all views (sim65 does that byte-identically).

Cycles (VICE, 1 MHz, mean / min / max over 42 scenes; compilation in parentheses where different):

| Part | Mean | min | max |
|---|---|---|---|
| VIEW (with stub) | 43 150 | 12 170 | 76 460 |
| VCL | 201 700 (201 800) | 68 000 (67 850) | 391 400 (391 200) |
| VIEW + VCL | 244 900 | 80 200 | 445 700 (446 000) |
| with BASIC, interpreted / compiled | 317 300 / 253 700 | 153 100 / 89 200 | 517 400 / 456 200 |
| sim65 (VIEW without stub) | 40 141 | 11 114 | 71 513 |

Examples (VIEW / VCL, interpreted): corridor south 44 700 / 235 800; room with sky south 33 900 / 72 300; window south d = 1 23 100 / 184 500; window east 41 700 / 301 400; blob centered d = 1 48 100 / 271 500; `wide` edge left 61 800 / 156 700; 5 objects open 76 500 / 220 100; CONTENT blobs d = 1 49 500 / 391 400; turning 12 200 / 68 000. Between runs the VCL values fluctuate by up to 3 000 (VIC-II badlines, phase position).

### Findings

1. **Memory map 2.4 collides with the improved Blitz! runtime.** The runtime (image 2) makes the upper 1 KB shared (`RCR` = `$0C`) and occupies `$FC00–$FEFF`; a `BLOAD` of the ceiling DTS (`$F800 …`) or of the DBG (`$FE00`) to bank 1 lands in the shared RAM and destroys the runtime (compilation hangs, interpreted unnoticed). In the test DVG, ceiling, floor and DBG are packed tightly in `$E800–$FBFF` (5 KB; DVG `$E800`, ceiling `$ED30`, floor `$F240`, DBG `$F9C0`), wall DTS `$9000`, DMP `$5000`, S2 `$7000` as in 2.4. **Spec 2.4 adapted (review P6g):** upper limit `$FBFF` for all bank 1 data, new tool defaults floor `$EE00`, ceiling `$F600`, DBG `$FB00`. The range is also in `blitz128/blitzc/README.md` (Blitz! compiler).
2. **Demo assets do not fit into 2.4** (wall 8.7 KB, floor 9.1 KB with 3 styles, ceiling 3.2 KB; VRAM 54 KB against pool 36.7 KB). Small sets in the test: wall 3 styles (brick, grating, window; 7 520 bytes DTS), floor 1 style (1 918), ceiling 1 style (1 295), wallpaper with panorama 2 · VW (122 bytes DBG), 4 sprite sets (S2 together 3 900 bytes in `$7000–$8F1D`); VRAM 9 600 … 44 751 in the pool 9 600 … 46 334 (behind the attribute RAM, before the screen RAM as in Crawl). The floor and ceiling styles with gaps and the wall style "arch" are therefore missing in the VICE scenes (tested in sim65 and `test_dbeview`).
3. VICE VIEW is on average 7 % (≈ 3 000) above sim65: stub (≈ 450) and the VIC-II badlines that the stopwatch counts along (x128, 1 MHz); the values fluctuate between runs by about 300. Targets from section 8 remain valid as sim65 figures.
4. **VCL is 82 % of the time** (mean 201 700 against 43 150): one image costs, interpreted as well as compiled, about 0.25 s at 1 MHz (blobs d = 1/CONTENT 0.45 s). Breakdown and measures: `docs/specs/P6g-vcl-analysis.md`. VICE models the VDC time only roughly; Z64K or hardware would be authoritative. The BASIC overhead between the markers is about 71 000 cycles per scene interpreted, about 8 000 compiled.
5. `BLOAD … :IF DS<>0` and `GOSUB`/`POKE` loops run unchanged in the Blitz! compilation; `FOR` with 0 iterations in the interpreter runs once (template checks `n = 0`).

### Open points

- Z64K run (pixels by CRC like `vdc-basic/test/zvt.py`) not implemented: would need the scene table as a file, a 6502 helper program for the CRC and several starts (each 8 s + 1.7 MHz); VICE scenes cover function and time.
- Scenes with A ≠ 0 (buffer too small), automap, working copy (`SETCELL`) and `OBJN` > 16 are not provided in VICE (sim65 checks them byte-identically).
- NMI still unchecked (P6d-opt).
- Time measurement with I flag set: the state is set and written back by the harness at entry and exit; a CLI in stub/lib would go unnoticed (there is none).

### Addendum review P6g (2026-11-25)

- Test rules observed: own port (`vicemon.choose_port`, bind test, range 6631–6649), event-driven (breakpoints at markers and error vector, debug cartridge; `-limitcycles` and timeout only guards), only the own process (`terminate`/`kill` via Popen). The comparison is strong: entire 64 KB VRAM against the carried-forward model, additionally window against the independent `paint_reference`, buffer against `dbeview.view`. `--control` falsifies the byte `$00FA` (row 3, column 10, in the window) of scene 5; follow-up run: exactly this scene reported, exit code 0.
- **Corrected: end of the VCL measurement.** `complex_instruction_shared_exit` is the common end of **every** VMC/VMF and every VMS copy command, not of VCL. The breakpoint hit hundreds of times per scene; the last hit was counted, and already at the first hit the I flag was reset, so that from the second entry Kernal IRQs were counted along (≈ 5 %). Now the measurement ends at `.vcl_done` (address from the ACME report of a copy, checked against `vdcbasic3.bin`). New values above (VCL on average ≈ 5 % lower than previously reported: 211 200 → 200 500 for the same scenes), both runs still pixel-identical.
- **Corrected: two scenes with the camera in an occluding cell** ("window east" in the window wall (8, 9), "abyss north" in a wall (4, 5)). There window bytes remained unwritten (window east: 1 050 bytes, floor and ceiling band d = 0 of the blocked cell). Now (7, 9) east and (3, 4) north respectively; `build_steps` rejects camera cells with OCCLUDING. The table above comes from the run afterwards (42 scenes, both runs pixel-identical).
- New tool `test/vice_vclprof.py` (VCL time per entry and per VMS command, origin of the entries, overdraw; `--static` without VICE) for the analysis `P6g-vcl-analysis.md`.
- Significance of the cycles: VICE models the VDC wait times only roughly (bytes are almost free); extrapolation to Z64K in the analysis (section 4).


## Decisions after the VCL analysis (2026-11-25)

1. VDC-BASIC optimization (VMC row, VMS type 1/8, VCL entry) comes later, not before P7.
2. Edges on whole bytes (2-pixel steps) as an option per project: `view.toml` switch `byte_edges` (default `false` = pixel-exact); dbegeom then rounds masks to byte boundaries.
3. Rendering at 2 MHz (FAST, VIC off during VIEW and VCL). Cycle targets and measurements refer to 2 MHz.
4. `MEMSIZ $4000`: BASIC variables in bank 1 `$0400–$3FFF`; first statement `POKE 57,0:POKE 58,64:CLR`. Re-divide asset areas from `$4000` (update memory map 2.4 in P6h).

## Result P6h (2026-11-25)

Implemented: memory map G with `MEMSIZ $4000` (2.4), tool load addresses and range check (`tools/dbemem.py`), DVG bit 3 in `dbegeom`, `view.toml` switch `byte_edges`, VCL type 2 instead of 3 for srcstep = length (engine and reference), tests and harness on the new map, measurement at 2 MHz.

### Memory map

Bank 1: variables `$0400–$3FFF` (15 KB), DMP `$4000–$5FFF`, S2 `$6000–$7FFF`, wall DTS `$8000–$AFFF` (12 KB), lib `$B000–$DBFF`, LIBTAB `$DC00`, BSS `$E000–$E7FF`, DVG `$E800`, floor `$EE00`, ceiling `$F600–$FB7F`, DBG `$FB80–$FBFF`, `$FC00–$FEFF` Blitz! runtime (locked). Compared to map F, DMP, S2 and wall shift down by 4 KB, the wall gets 4 KB more (the demo wall DTS with 4 styles, 8 736 bytes, now fits); the high part `$E800–$FBFF` remains (5 KB), only the ceiling/DBG boundary moves from `$FB00` to `$FB80` (1 style of the demo ceiling has 1 295 bytes, the old area had 1 280; DBG needs at most 124 bytes). All areas are ≥ `$4000` (VCL type 9 lists) and below `$FC00`.

### Tools

- `tools/dbemem.py` (new): default load addresses and `range_error(kind, load, length)`. `dbemap build`/`crawlmap` `$4000` (before `$8000`), `dbespr` `$6000` (`$7000`), `dbetex` wall `$8000` (`$A000`), floor `$EE00`, ceiling `$F600`, DBG `$FB80` (`$A900`), `dbegeom` `$E800` (`$E400`). The write paths (`dbemap build`, `crawlmap`, `dbespr build`, `dbetex build`/`bg`, `dbegeom`) abort with exit code 1 and message if the file extends beyond the end of the area or its load address lies in no asset window; if the load address lies outside the standard area of the kind (tight packing), the end of the window counts (`$AFFF` or `$FBFF`). The calculation functions (`to_dts`, `to_s2`, `to_dmp`, `build_texset`) do not check, so that reference and tests can keep using the oversized demo assets.
- `dbegeom`: DVG flag **bit 3** (band coverage) on all fronts that contain the band rows of their depth (JSON flag `bandcover`); the geometry ID changes as a result. `dbeview.without_band_cover` produces the variant "bit missing" for the tests (`make_scene(band_cover=False)` uses it).
- **`byte_edges`** (`[viewport]`, default `false`): Half bytes (only one pixel in the polygon) are rounded to whole bytes: the byte belongs to the polygon if its center lies inside; if it lies on an edge, it gets the polygon that owns the left pixel (neighboring faces remain gapless and overlap-free). Masks then contain no `L`/`R`, the converter produces no VMS type 8 commands at the edges of walls and tiles (sprites remain untouched: `dbespr`).
- VCL type 3 with srcstep = length is output as type 2 (cores; the wallpaper remains type 3). Engine: new entry `emit_vmcn` in `view.s` (counting and writing, also for clipped cores), reference `dbeview._core_vmc`; byte-identical (sim65). In the demo assets 29 of 256 wall cores; per entry 2 VCL bytes and the type 3 overhead less. Lib code **+41 bytes** (11 016 → 11 057 of 11 264), reserve 207 bytes.

### Tests

- `test/tools` (255 tests): new `test_dbemem.py` (areas, error messages, CLI of `dbemap`, `dbetex`, `dbespr`), in `test_dbegeom.py` bit 3, `byte_edges` (option, whole bytes, rounding at most one pixel, no overlap of equal kind and depth, different ID, range check of the DVG).
- `run_sim.py` (normal and `DBEVIEW_FULL=1`) byte-identical; demo DTS lie in sim65 at their own addresses (ceiling `$EE00`/`$EF00`, DBG `$FB80`/`$8280`, everything below `$FC00`).
- `vice_smoke.py` (additionally check `PEEK(58) = 64`), `vice_zp.py`, `vice_view.py` (interpreted and Blitz!, two runs each) green; all 42 scenes pixel-identical, `--control` reports the falsified scene. `.bas` templates with `POKE 58,64`; `vice_blitzvars.py` adapted to `$4000`.
- `vice_view.py` now additionally measures at **2 MHz**: second run with `FAST:` before `SYS 3148` (VIC display off) and `SLOW` after `SYS 3149`, i.e. exactly during VIEW and VCL; same pixel check. The stopwatch counts clocks at 1 MHz (µs equivalent). `--no-fast` skips it, `--byte-edges` builds the demo geometry with `byte_edges`.

### Cycles (VICE, mean over 42 scenes; interpreted, Blitz! equal ±100)

| | 1 MHz | 2 MHz (FAST, VIC off) | Ratio |
|---|---|---|---|
| VIEW (with stub) | 43 287 | 21 308 | 0.49 |
| VCL | 200 279 | 122 369 | 0.61 |
| VIEW + VCL | 243 566 | 143 678 | 0.59 |
| VIEW + VCL, `byte_edges` | 210 350 | 123 062 | 0.59 |
| VCL, `byte_edges` | 167 154 | 101 812 | 0.61 |

VIEW halves (pure CPU code, badlines no longer apply); VCL drops only to 61 % because the wait times of the VDC remain. The ratio 0.61 is below the extrapolation of the analysis (0.74); in VICE the VDC wait times are a rough model, Z64K or hardware remain authoritative.

### `byte_edges` on the demo (VICE scenes, `--byte-edges`)

VCL −16.5 % at 1 MHz (200 279 → 167 154) and −16.8 % at 2 MHz (122 369 → 101 812); the analysis had estimated −37 000 (−18 %). Sizes: wall DTS 7 520 → 7 254 bytes, floor 1 916 → 1 504, ceiling 1 295 → 1 086; VRAM pool occupied 44 751 → 44 591 bytes (−160). All 42 scenes still pixel-identical to the respective model (different images than pixel-exact: slanted edges step in 2-pixel increments).

### Open points

- Sprites (`dbespr`) do not know `byte_edges`; a switch for semi-transparent edge bytes remains a decision for P7.
- Floor/ceiling demo (9.1 / 3.2 KB) still do not fit into their areas (asset budget in P7).
- The lib check "data outside lib/BSS" (K5) is still missing.

## Result P6i (2026-11-26): Occlusion of sprites via the paint order

User decision (specified from the start, implemented wrongly in P6): Sprites are **not** clipped against `cover`. A sprite is drawn completely and overpainted by the nearer walls; `cover` discards a sprite only if all columns of its window clip rectangle are occupied. Clipping happens only at the edge of the viewport (the rest of the screen belongs to the game). A sprite entirely within the window takes the fast unclipped path (cores + edge as type 9, in the build `VMS_COPY` as a copy).

### Implementation

- Spec 5.4, 5.8 step 5, 5.9; new rationale **5.8a** (analysis of the order: everything that can occlude a sprite at depth d comes after it in the VCL and is unclipped; no additional changes of the order needed; edge cases overflow, bands without image, too-tall sprites). P5b 3.4 (height check) and 6 (clip rectangle) updated.
- Reference `dbeview._View.objects`: column search replaced by `allcov(cover, cx0, cx1)`. `paint_reference` was already like this (sprites clipped only at the window).
- Lib `view.s` (`vspr`): `ffree` (first/last free column) dropped, instead `allcov_c` (which exists for walls anyway). Lib code **11 057 → 10 982 bytes (−75)**, reserve up to `$DBFF` **207 → 282 bytes**. BSS unchanged.

### Test

- `python3 -m unittest discover -s test/tools`: 283 tests green, including the offline full comparison `test_crawl01` (19 136 views pixel-identical to the 0.1 model; 0.1 likewise simply overpainted).
- `run_sim.py` green (P6a/P6c/GEOMSET, P6d 1 322 / `VMS_COPY` 1 302, P6e 1 743 / 1 713, P6f MOVE and automap, all byte-identical).
- `run_crawl.py --dir test/tools/data`: 19 136 views byte-identical (sim65 against `dbeview.view`), all A = 0.
- `vice_view.py` (interpreted and Blitz!, each 1 and 2 MHz): 42 scenes pixel-identical. `vice_demo.py --only i`: 75 prompts equal to the model.
- Crawl pixel test in the game repo (`test/vice_crawl.py --ports 6633,6634`, new lib to `libs/dbe0.2.lib.prg`, stub unchanged): **PASS**, 1.1 interpreted and compiled each 74 prompts equal to 1.0f (tour, automap, 32 ghost scenes), `crawl01` against the real 1.0f window 73 prompts equal. The P7d time measurement for 1.1 is to be repeated with this lib.

### Cycles VIEW (sim65, Crawl scenes like `run_crawl.py`, without stub; mean / max)

| | before (P6h) | after | 0.1 |
|---|---|---|---|
| without ghost (400) | 16 863 / 26 104 | 16 747 / 25 877 | 16 369 / 19 215 |
| with ghost (9 168) | 20 755 / 45 666 | **18 833 / 30 364** | 18 745 / 25 746 |
| ghost d = 1 sideways (896) | 36 256 / 45 666 | **22 411 / 30 364** | 22 883 / 25 746 |
| ghost d = 2 sideways (1 312) | 21 301 / 38 285 | 18 053 / 28 805 | 18 932 / 23 735 |
| ghost centered (s = 0, d ≥ 1, 2 704) | 22 599 / 30 638 | 22 435 / 30 364 | 20 835 / 25 644 |
| pos 67 direction 3, ghost cell 86 (d = 1, s = −1), view 0 / 1 | 45 666 / 43 348 | 28 951 / 30 324 | 25 521 / 25 049 |

Clipping at the edge of `cover` (counting dry run and copy of the VMS list, `clipvms_e`) cost about 14 000 cycles for the sideways ghost at depth 1; this now disappears entirely. Target ≤ 28 382 (2 × 0.1): before, 1 630 views above it, now 382 (of which 164 ghost d = 1 sideways, 210 centered; maximum 30 364 = 1.07 × target; largest quotient to 0.1 per view 1.82 → 1.37). The VMS buffer occupancy in Crawl drops to 0 (all ghosts and gems in the window go as type 9).

### Extra VCL cost due to overpainted bytes (Crawl scenes, `dbeview.view`)

| | VCL bytes mean | VRAM write bytes mean (Δ, max Δ) | Δ operations (mean) | Estimate Δ VCL (VICE model P6g) |
|---|---|---|---|---|
| without ghost (gems) | 79 → 77 | 6 677 → 6 692 (+15, +54) | 5 VMC rows type 3 → type 2 | −480 cycles |
| with ghost | 92 → 90 | 6 743 → 6 781 (+38, +247) | +1 VMC row, +0.7 VMS1, +2.0 VMS8 | +900 cycles |
| ghost d = 1 sideways | 123 → 121 | 7 045 → 7 237 (+192, +247) | +10 VMC rows, +5.6 VMS1, +15.5 VMS8 | +11 600 cycles (max +21 800) |

Estimate with the P6g values (entry 670, VMC row 187 or 281 with srcstep, VMS type 1 308, type 8 706 cycles); on Z64K/hardware about 5–7 cycles per additional byte are added (+192 bytes ≈ +1 200). For the sideways ghost at depth 1 the saving in VIEW (≈ −13 800) exceeds the extra VCL cost (≈ +11 600): VIEW + VCL ≈ −2 200 on average; over all views with ghost ≈ −1 000, without ghost ≈ −600 (estimate, VICE model). The extra cost comes almost entirely from the half edge bytes (VMS type 8) of the ghost, which are now painted behind the wall and overpainted.

## Result P6j (2026-11-26): fixed list address and zero page only where necessary

Occasion: measurement in the Crawl tour (comp 2 MHz, 1.1 +34 800 clocks compared to 1.0f): about 15 600 clocks of BASIC between `VIEW` and `VCL` (list start from P0 as a float `PEEK` computation, `::VCL VA`) and about 11 200 in the stub (saving and writing back 16 bytes of zero page on every call).

### 1. Fixed list address (`BUFSET` X bit 0)

**Why the address moves:** `VIEW` runs through the view from front to back and writes each entry immediately (single pass); `VCL` must paint from back to front (since P6i the occlusion of sprites also depends on this). The list therefore grows downward from B1, its start B1 − nv changes with every image. Forward from B0 would only be possible with two passes (0.1) or with reversal at the end (30–60 cycles per byte).

**Solution:** new VCL entry **type 10 "continue at address"** in VDC-BASIC v3 (`10, address`, 3 bytes; vdc-basic `docs/v3/P2e-vcl-jump.md`). With `BUFSET` X bit 0, `VIEW` writes the type byte 10 to B0 before the pass and the address B1 − nv behind it at the end; the VMS lists begin at B0 + 3 (BL 3 bytes smaller, 5.10), otherwise everything is the same (no restriction, clipped edges remain in the buffer). VCLADR = P0 = B0 on every call, VCLLEN and VMSLEN without the jump. `INIT` switches the mode off; the default (X bit 0 = 0) is unchanged.

Rejected: (A, interim state) copy the list to B0 and omit VMS lists in fixed mode (loss of function at the window edge, copy 14–18 cycles per byte, Crawl ≈ 1 150–1 330 per `VIEW`, 132 bytes of code); (B) copy the list to B0, move or reverse VMS lists and patch the type 12 addresses (≈ 200–250 bytes of code, with many VMS bytes 20 000–100 000 cycles); (C) VMS lists downward from B1 with a movable list stack (intervention in generation and withdrawal).

**Cost:** `VIEW` sim65 (Crawl, 9 568 views) with fixed mode mean 16 888 / 18 978 (without / with ghost), without 16 792 / 18 883: **≈ +100 cycles**. `VCL` +≈ 215 cycles for the jump (VDC-BASIC, VICE). Against that BASIC (VICE micro-measurement per call, without the list; interpreted / Blitz!): `V=PEEK(3072)+256*PEEK(3073):::VCL V` with late-created V 25 500 / 5 700, `::VCL 4864` (number, converted every time) 7 000 / 6 400, **`::VCL VB` with VB = B0 as the first variable 3 400 / 2 900**. Recommendation for games: set `VB` as the first variable after `CLR`.

**Lib:** 10 982 → 11 065 bytes of code (`$B000–$DB38`), reserve **282 → 199 bytes**; BSS +1 (`buf_fix`). Test build: `TESTHI` (function 252) moved from `$DBC0` to `$DBF0` (`lib-test.cfg`, probe reads `$DBEF`), reserve in the test build up to `$DBEF` 54 bytes.

### 2. Zero page only where necessary (stub)

Usage per function, measured with `test/vice_zp.py --funcs` (program of `vice_view.py` plus CELL, SETCELL, SETITEM, BUFSET X = 1/0, F = 7, 8, 17; per lib call watchpoints read/write on `$63–$72` and `$FA–$FD`, first hit per call with `$FF00`):

| F | Function | ZPB `$63–$72` | `$FA–$FD` |
|---|---|---|---|
| 0 | INIT | – | yes |
| 1 | MAPINIT | – | yes |
| 2 | SETPOS | – | – |
| 3 | MOVE | – | yes |
| 4 | VIEW | **yes** | yes |
| 5, 6 | CELL, SETCELL | – | yes |
| 7, 8, ≥ 17 | (not implemented) | – | – |
| 9 | SPRITESET | – | yes |
| 10, 11 | ITEMSET, POOLSET | – | – |
| 12 | GEOMSET | **yes** | yes |
| 13, 14 | TEXSET, BGSET | – | yes |
| 15 | BUFSET | – | – |
| 16 | SETITEM | – | yes |

0 foreign accesses (all hits with `$FF00 = $7F`); statically the same (ZPB symbols only in `f_geomset`/`gcells`, `view.s` and `t_zp`; from `view.s` only BGSET calls `bgoffs`, without ZPB).

The stub saves the block only for F = `ZPB_F1` (4), `ZPB_F2` (12) and `ZPB_FT` (253, test build) (`dbe.inc`; a new function with ZPB must be entered there); flag `sv_f` (bit 7) for the write-back. Saving and writing back unrolled fourfold (9 instead of 14 cycles per byte). Saving per call without ZPB ≈ 420 cycles (comparisons +≈ 20), per VIEW/GEOMSET ≈ 150. Stub 168 → 221 bytes (`$0D00–$0DDC`). New marker `call_rts` (RTS at the stub end) in `build/stub.lbl`; `vice_view.stub_rts()` reads it there instead of counting off the end.

### 3. Tests

- `python3 -m unittest discover -s test/tools`: 285 tests green (new `TestFixedAddress`: jump, VMS from B0 + 3, same image as without fixed mode, 3 bytes less space).
- `run_sim.py` green: P6a with BUFSET X = 1/3/2 (mode, error leaves it in place); new sets "fixed list address" in P6d (232 views, each standard and `VMS_COPY`) and P6e (150), all byte-identical (harness `viewsim.c` follows the jump).
- `run_crawl.py --dir test/tools/data` and `--fix`: each 19 136 views byte-identical, A = 0.
- VICE: `vice_smoke`, `vice_zp` (interpreted and Blitz!), `vice_zp --funcs`, `vice_view` (42 scenes, interpreted and Blitz!, 1 and 2 MHz), new `vice_view --fix` (the same with BUFSET X = 1 and `VCL` with the constant B0), `vice_blitzvars`, `vice_demo --only i` (demo now in fixed mode: `demo.bas` 290, `vcl vb`; 75 prompts equal to the model).
- Crawl (game repo, VDC-BASIC v3 with P2e, `BUFSET` X = 1, `::VCL VB`): pixel test against 1.0f **PASS**; time measurement P7 12.4.

## Result P6l (2026-11-26): Distance-view fill

User decision: The wallpaper must no longer be the distance view unintentionally (demo: through the grating in the roofed chamber one saw mountains). Rules and procedure: 5.7a; call: `BGSET` Y ≠ 0 = on, P2 low = fill byte (Y = 0 off, default after `INIT`; Crawl calls `SYS3331,14,0` without Y, Y then comes from the previous `SYS` (`TEXSET` ends with Y = 0); without ceilings the fill would be ineffective there anyway). Tile flag DISTANT (DMP bit 6, `dbemap` `"distant"`) reverses the ceiling rule. Without fill the list is unchanged, likewise with fill as long as no cell of depth D is roofed.

### Implementation

- **Column → cell:** `GEOMSET` creates `hs[c] = s(c) + 15` (80 bytes BSS): start value 15, each side of depth D shifts the boundary at its far edge (s < 0: `hs − 1` for c < x + w; s > 0: `hs + 1` for c ≥ x). The fill/wallpaper boundaries thus fall exactly below the far corners of the ceilings of depth D (plane P_{D+1}), not on the near edges of the fronts (P_D, up to 4 columns off).
- **Decision per cell:** `vcells` writes in depth D (only with fill) per cell `fdec[s + 15]` = ((ceiling style ≠ 0) XOR flag DISTANT) as `$40`/0 (31 bytes LIBTAB) and collects `fany`.
- **Output:** `vtap` omits the horizon with `fany`; after the pending area of depth D (then occluding sides and fronts without bit 3 of depth D are also in `bcov`, whose column range fully covers the horizon rows according to P3 4.4) `vfar` runs over `spans(bcov)` and the stretches of equal decision (right → left): fill as a BG entry with `bgsel` (`gbg` then takes the fill byte as without DBG, type 4/5), wallpaper as a normal BG entry. The entries are the last in the list and are painted first.
- **GEOMSET:** The cell table was always created with A = 1 (checking and creating in one pass); the dead queries `gbld` (A = 0 "check only") are removed (−43 bytes) so that the distance view fits into the lib.
- **Reference:** `dbeview` `Scene.farfill`, `_Ctx.far_cols`/`far_dec`, `_View.distant`, painter (horizon per column), `far_variant` (random scenes with fill and DISTANT), TOML key `farfill`. If the cell (D, s(c)) is missing in the DVG for a column (possible only with foreign DVGs), the reference reports an error; the lib then reads an old value.

### Sizes

- Lib code **11 065 → 11 250 bytes** (`$B000–$DBF1`), reserve **199 → 14 bytes** (distance view ≈ +228, dead `gbld` queries −43). BSS 1 923 → 2 009 bytes (`hs` 80, `ffon`, `ffill`, `fon`, `fany`, `bgsel`, `fc0`), LIBTAB 945 → 976 (`fdec`).
- **Test build:** The test functions 250–253 and their dispatcher now lie in `TESTLO` before the lib (`$AF00–$AF7E`, file from `$AF00`), a jump remains in the lib (`cmp #NFUNC` → `t_disp`). `TESTHI` (function 252) from `$DBF0` to `$DBF8`; the probe reads its own first byte (`$A9`, `smoke.bas` 160 checks Y = 169). Reserve in the test build up to `$DBF7`: 3 bytes.
- **`VMS_COPY` no longer fits into the 11 KB** (11 343 bytes); the switch remains for sim65 (`test/sim/simc.cfg`: lib code up to `$DCFF`, LIBTAB at `$FC00`). On the C128 only the standard build (type 9) is possible.

### Cycles

- `VIEW` (sim65, demo map `demo/demo.toml` with the demo assets of the tests, 504 views without objects): without fill mean 30 085 / max 55 839, **with fill 30 780 / 59 609** (+695 on average: decision per cell of depth D, run per column ≈ 23 cycles, horizon as separate entries).
- Base load without fill (query per cell, 3 bytes more clearing): Crawl `run_crawl.py --fix` mean **17 024 / 19 117** (without / with ghost) against 16 888 / 18 978 (P6j): +≈ 135 (0.8 %).
- `VCL` (VICE cost model P6g: entry 670, row type 2/3/5 187/281/237; demo world, 504 views without goblins): 228 views change, Δ mean **−1 650 cycles**, median −1 010, min −14 270, max +7 460, VCL list +9 bytes on average. Savings: filling instead of panorama copy (type 5 instead of type 3 per row) and no wallpaper in the columns of occluding sides of depth D; extra costs: separate entries for the horizon where it previously lay in one entry with ceiling or floor gaps of depth D, and several stretches for mixed rows. Grating d = 1 (17, 5, S): +330 (2 entries more, abyss at depth D); corridor east (4, 14): −5 790.
- VICE (`vice_demo.py --only i`, tour 74 keys, new version, lib `2757b277`): interpreted 1 MHz VIEW mean 48 255, VCL 161 765; 2 MHz VIEW 22 975, VCL 98 761. Grating d = 1 (image 70, 1 MHz): VIEW 54 060, VCL 292 778.

### Tests

- `python3 -m unittest discover -s test/tools`: new `TestDistantView` (pixels against `paint_reference` for `distant_map` – long corridor with ceiling and window to the outside, window in the middle of the corridor with wall behind it, long corridor without ceiling, grating, DISTANT tiles, mixed row –, `demo/demo.toml` and the example map, with/without DBG; column assignment; off = unchanged; 120 random scenes with fill and DISTANT), `test_dbemap` (flag `distant`, bit 7 reserved).
- `run_sim.py`: P6c checks `hs` after every `GEOMSET` and `ffon`/`ffill` after `BGSET`; new set **P6l** 2 488 views byte-identical (distant_map, `demo/demo.toml`, example map, each standard and `VMS_COPY`, random with objects, two fronts, overflow 64 … 1 024 bytes with and without fixed list address); all older sets unchanged byte-identical.
- `run_crawl.py --no-cycles`: 19 136 views byte-identical (Crawl without fill unchanged).
- VICE: `vice_demo.py --only i` (demo with fill `$11`, 75 prompts equal to the model, 1 and 2 MHz); `vice_smoke` and `vice_zp` (test build moved), interpreted and Blitz!.
- Demo finding: In the chamber with the abyss, the floor gap of depth D shows a strip of landscape below the fill (panorama rows below the horizon, `bg.toml`); this is the wallpaper in the abyss, not the distance view, and stays so according to rule 4.

