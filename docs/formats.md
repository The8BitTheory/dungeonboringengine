# Interfaces and data formats (as of: engine 0.2)

This document and the README are enough to use the engine from a BASIC 7 game (interpreted or Blitz!). Rationale and details: `docs/specs/P6-engine.md`. All addresses in P0–P3 are bank 1 addresses of the data (content start = `BLOAD` address), VRAM bases are VDC addresses.

## Files

| File | Target | Content |
|---|---|---|
| `dbe0.2.stub` | Bank 0, `$0D00` | Stub: bank switching, interrupt switch, call of the lib |
| `dbe0.2.lib` | Bank 1, `$B000–$DBFF` | Lib (jump table at `$B000`); `$DC00–$E7FF` tables and variables, not in the file |
| `*.dmp` | Bank 1, default `$4000` | Map (DMP) |
| `*.s2` | Bank 1, default `$6000` | Sprite sets (S2) |
| `*.dts` | Bank 1, wall `$8000`, floor `$EE00`, ceiling `$F600` | Texture set (DTS) |
| `*.dbg` | Bank 1, default `$FB80` | Wallpaper (DBG) |
| `*.dvg` | Bank 1, default `$E800` | Viewport geometry (DVG) |
| `*.vrl` | Bank 0, then `RXV` into VRAM | packed images (VRL, section "VRL v1") |

The load address is in the PRG header of the files (`BLOAD"…",B1,U8`); the tools take the default addresses from the memory map below.

## Call

| Call | Effect |
|---|---|
| `SYS 3328` | Init: copies the Kernal interrupt switch `$FF05–$FFFF` to bank 1, calls `INIT` (F 0) |
| `SYS 3331,F,X,Y` | Call function F (X, Y = input bytes); result with `RREG A,X,Y` |

Load sequence (the game's first statement limits the BASIC variables to `$0400–$3FFF`):

```
10 POKE 57,0:POKE 58,64:CLR
20 BANK 0:BLOAD"DBE0.2.STUB",B0,U8:BLOAD"DBE0.2.LIB",B1,U8
30 SYS 3328:RREG A,X,Y:REM A=0, X=3 (version)
40 BLOAD"MAP.DMP",B1,U8:BLOAD"WALLS.DTS",B1,U8:BLOAD"VIEW.DVG",B1,U8:REM etc.
```

After that `POOLSET` (optional), `GEOMSET` (first; afterwards DTS, DBG and S2 are valid only with the same geometry ID), `TEXSET` (wall, floor, ceiling), `BGSET`, `SPRITESET`, `ITEMSET`, `MAPINIT`, `BUFSET` (optional). Image data (VRL) goes into VRAM with `RXV` before `TEXSET`/`SPRITESET` receive their VRAM base.

During the call:

- The current `BANK` does not matter; the stub switches by itself and afterwards restores `$FF00` and `$D506`. Interrupts stay enabled.
- `$FF00 = $7F` (bank 1 without I/O) and **8 KB shared RAM** at the bottom (`$D506` = `$06`): bank 1 below `$2000` is bank 0. Engine data never resides there.
- Zero page: `$FA–$FD` (all functions except `SETPOS`, `ITEMSET`, `POOLSET`, `BUFSET`) and `$63–$72` (FAC/ARG; only `VIEW` and `GEOMSET`). The stub saves the block `$63–$72` before these two functions and restores it afterwards; the other calls do not touch it (proof: `test/vice_zp.py --funcs`).
- Bank 0 `$1C00–$3FFF` (VDC-BASIC v3) is never written.

### Parameter block (bank 0)

| Address | Name | Content |
|---|---|---|
| `$0C00`, `$0C02`, `$0C04`, `$0C06` | P0–P3 | Words (low/high), input and output |
| `$0C08` | ITEMPH | Phase for items of the content layer (sparkle; the game sets it) |
| `$0C0A` | VCLADR | `VIEW`: address of the VCL list (also in P0); with a fixed list address (`BUFSET` X bit 0) always the buffer start (there a jump, VCL type 10, to the list start) |
| `$0C0C` | VCLLEN | `VIEW`: length of the VCL list including the end byte |
| `$0C0E` | VMSLEN | `VIEW`: bytes of the VMS lists |
| `$0C10` | OBJVIS | `VIEW`: bit i = object i output (completely or partially) |
| `$0C50` | OBJN | Object list: count 0 … 16 |
| `$0C51` | OBJL | 16 objects of 6 bytes each (below) |

Engine buffer (VCL and VMS lists) in shared RAM `$1300–$1BFF` (default 2304 bytes, `BUFSET` shrinks it). The VCL list resides at the buffer end (start = end − VCLLEN, changes with every frame), the VMS lists from the buffer start. With a fixed list address there is a jump (3 bytes, VCL type 10) to the list start at the buffer start, the VMS lists begin 3 bytes later; VCLADR is then always the buffer start.

### Object list (6 bytes each from `$0C51 + 6·i`)

| Offset | Content |
|---|---|
| 0–1 | Cell index (word) |
| 2 | Sprite set 0 … 7 |
| 3 | Object direction 0–3 (N, E, S, W) or `$FF` (viewing angle 0) |
| 4 | Phase (animation frame) |
| 5 | Bits 0–2: sub-position (0 NW, 1 NE, 2 SW, 3 SE, 4 center); bit 6: invisible (`VIEW` skips); bit 7: does not block (`MOVE`); remaining bits 0 |

Items of the content layer (bits 0–5 of the content byte, section "DMP v1") are added on top of these.

### Functions

Map and direction: 0 N, 1 E, 2 S, 3 W; cell = row · W + column.

| F | Name | Input | Output (A = error code, table below) |
|---|---|---|---|
| 0 | `INIT` | – | everything reset; X = version (0.2: 3); P0 = code end, P1 = end of variables |
| 1 | `MAPINIT` | P0 = DMP; P1 = working copy (0 = none, otherwise 2·W·H bytes in `$4000 … $AFFF`); X bit 0 = automap (set bit 6 "seen" in the working copy) | checks magic, version, offsets; start cell and direction taken over; OBJN = 0; X = W, Y = H, P0 = start cell, P1 = start direction. A = 1 format, 6 working copy outside the range |
| 2 | `SETPOS` | P0 = cell, X = direction | A = 0; 6 if cell ≥ W·H |
| 3 | `MOVE` | X = action: 0 forward, 1 backward, 2 strafe left, 3 strafe right, 4 turn left, 5 turn right, 6 turn around | X = 0 moved/turned; 1 blocked (map edge or tile with flag SOLID); 2 object in the way (Y = object index; objects with bit 6 or 7 do not block); Y = tile; P0 = position, P1 = content byte of the position, P2 = index of the first event of the position (`$FFFF` = none). A = 0 |
| 4 | `VIEW` | P0 = frame buffer in VRAM (start of the frame) | VCL list and VMS lists in the buffer; X = entries (at most 255); P0 = VCLADR; VCLLEN, VMSLEN, OBJVIS (parameter block). A = 0; 2 list truncated (rear parts missing); 3 edges of individual images omitted; 5 without GEOMSET/MAPINIT |
| 5 | `CELL` | P0 = cell | X = tile index, Y = content byte, P1 = tile flags. Outside: A = 6, X = outer tile, Y = 0 |
| 6 | `SETCELL` | P0 = cell, X = tile index | A = 0; 6 if cell outside or X ≥ NT |
| 7, 8 | – | – | A = 255 (not present; 8 was `WALLSET` in 0.1) |
| 9 | `SPRITESET` | X = set 0 … 7, P0 = S2 (0 = delete set), P1 = VRAM base of the images | A = 1 format, 4 geometry does not match, 5 without GEOMSET, 6 set number, pool or S2 below `$4000` |
| 10 | `ITEMSET` | X = item 0 … 63, Y = set + 1 (0 = none) | A = 0; 6 if X ≥ 64 or Y > 8 |
| 11 | `POOLSET` | P0 = pool start, P1 = pool end (exclusive, 0 = 65536); both 0 = off | A = 0; `TEXSET`, `BGSET`, `SPRITESET` then check that VRAM base … base + length lies in the pool (A = 6) |
| 12 | `GEOMSET` | P0 = DVG, P1 = origin (offset of the window in the frame buffer: destination = P0 of `VIEW` + origin + y · stride + x; `$FFFF` = value from the DVG) | A = 1 format (magic, version, lengths, VW ≤ 80, VH ≤ 100, D ≤ 7, element table). Textures, wallpaper and sprite sets with a different geometry ID are deleted |
| 13 | `TEXSET` | X = kind (0 wall, 1 floor, 2 ceiling), P0 = DTS (0 = delete), P1 = VRAM base | A = 1 format, 4 geometry, 5 without GEOMSET, 6 pool or DTS below `$4000` |
| 14 | `BGSET` | P0 = DBG (0 = no wallpaper), P1 = VRAM base, X = fill byte without DBG, Y = **far-view fill** (0 off, ≠ 0 on; always specify Y), P2 low = fill byte of the far view | A = 1, 4, 5, 6 as with `TEXSET`. Far view: section "DBG v1" |
| 15 | `BUFSET` | P0 = buffer start, P1 = buffer end (exclusive); X bit 0 = **fixed list address** | A = 0; 6 if start < `$1300`, end > `$1C00` or length < 64 (old buffer and mode remain). Fixed list address: `VIEW` writes a VCL jump (type 10, VDC-BASIC v3 from P2e) to the list start at the buffer start, VCLADR = P0 = buffer start on every call; VMS lists from start + 3 (3 bytes less space), otherwise everything the same. `INIT` switches the mode off |
| 16 | `SETITEM` | P0 = cell, X = content byte (item and automap bits) | A = 0; 6 outside |
| ≥ 17 | – | – | A = 255 |

### Error codes

| A | Name | Meaning |
|---|---|---|
| 0 | `E_OK` | ok |
| 1 | `E_FORMAT` | magic, version or lengths wrong |
| 2 | `E_TOOMANY` | `VIEW`: list truncated |
| 3 | `E_PARTIAL` | `VIEW`: only cores drawn, edges of individual images missing |
| 4 | `E_GEOM` | geometry ID, element count, depth or stride does not match the DVG |
| 5 | `E_STATE` | wrong order: `GEOMSET` or `MAPINIT` missing |
| 6 | `E_RANGE` | parameter out of range (cell, set, tile index, pool, buffer, address) |
| 255 | `E_NOTIMPL` | function not present |

### Drawing a frame

```
POKE 3072,0:POKE 3073,0:SYS 3331,4,0,0:RREG A,X,Y   : REM VIEW, frame buffer = VRAM 0 (P0)
V=PEEK(3072)+256*PEEK(3073):VCL V                    : REM P0 = VCLADR, ::VCL executes the list
```

**Fixed list address** (`BUFSET` with X = 1, once after `INIT`; needs VDC-BASIC v3 with VCL type 10, P2e): `VCL` with the buffer start goes through the jump to the list; the game does not need to read P0. Fastest is a variable that is set once and created as the **first** variable (the interpreter searches variables in order; a number in the program text is converted anew on every call and is slower than the variable):

```
10 POKE 57,0:POKE 58,64:CLR:VB=4864                 : REM VB = $1300 (buffer start), first variable
...
POKE 3072,0:POKE 3073,19:POKE 3074,0:POKE 3075,28:SYS 3331,15,1  : REM BUFSET $1300-$1BFF, fixed list address
...
POKE 3072,0:POKE 3073,0:SYS 3331,4,0,0              : REM VIEW
VCL VB                                              : REM Blitz!: ::VCL VB
```

Measurement (VICE, per frame, excluding the list itself): `::VCL VB` with VB as the first variable 3 400 (interpreted) or 2 900 cycles (Blitz!), `::VCL 4864` 7 000 / 6 400, `V=PEEK(3072)+256*PEEK(3073):::VCL V` 25 500 / 5 700 (V created late). The jump costs about 215 cycles in `VCL`, about 100 in `VIEW`.

`VIEW` writes no pixels, only the list. The list contains VCL type 12 (VMS in the buffer, clipped) and type 9 (VMS directly from bank 1, unclipped images from DTS and S2). VDC-BASIC reads type 9 from bank 1 `$4000–$CFFF` or `$E000–$FBFF`; hence the address limit `$4000` for `TEXSET`/`SPRITESET`. Before every `VIEW`, update the object list and position (`SETPOS`/`MOVE`, `OBJN`/`OBJL`).

### Map

The map format is **DMP v1** (section "DMP v1" below). The working copy (`MAPINIT` P1) takes `SETCELL`, `SETITEM` and the automap bits; without a working copy they write into the DMP itself.

## Wall set metadata (WSM), version 1

0.1 only (`WALLSET` is dropped in 0.2; replacement: DVG and DTS). This section and "Sprite metadata" are history.

All words in low/high format.

### Header (10 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"W" "S"` (`$57 $53`) |
| 2 | Version = 1 |
| 3 | Number of entries (≤ 64) |
| 4–5 | Clear offset (relative to `AP`) |
| 6–7 | Clear length (0 = do not clear) |
| 8 | Clear value |
| 9 | Row width of the frame buffer in bytes (VMC increment) |

### Entry (10 bytes)

| Offset | Content |
|---|---|
| 0 | Depth d (0 = own cell) |
| 1 | Side s (signed, negative = left) |
| 2 | Flags: bit 0 = occludes its columns over the full height; bit 7 = object slot (rest meaningless) |
| 3 | Width in bytes |
| 4 | Height in raster lines |
| 5–6 | Source (relative to the VRAM address from `WALLSET`) |
| 7–8 | Destination (relative to `AP`) |
| 9 | first column (for the coverage, < 128) |

The entries are ordered front to back: depth ascending, per depth first front faces, then object slots, then side faces. Several entries per cell are allowed. An object slot (d, s) tells `VIEW` where the objects and items of this cell are sorted in.

## Sprite metadata (SPR), version 1

### Header (6 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"S" "P"` (`$53 $50`) |
| 2 | Version = 1 |
| 3 | Number of parts |
| 4–5 | reserved (0) |

### Part (15 bytes)

| Offset | Content |
|---|---|
| 0 | Depth d |
| 1 | Side s (signed) |
| 2 | Viewing angle 0–3, `$FF` = any |
| 3 | Flags: bit 0 = draw transparently with `VMS` (otherwise `VMC`) |
| 4 | Width in bytes |
| 5 | Height in raster lines |
| 6–7 | Source (relative to the VRAM address from `SPRITESET`) |
| 8–9 | Destination (relative to `AP`) |
| 10 | first column in the viewport (for the coverage) |
| 11–12 | Length of the VMS list in bytes (0 for `VMC`) |
| 13–14 | Offset of the VMS list (relative to the start of the metadata) |

The VMS lists follow in VDC-BASIC format: alpha value (byte), number of commands (word), then commands (`1` offset word length = copy run, `8` offset word = blend one byte with a transparent pixel). With `VMS` the source is stored packed, i.e. only the bytes that the list writes. Lists may be longer than 256 bytes; `VIEW` copies them per frame into the 512-byte buffer at `$0E00`.

An object in cell (d, s) with viewing angle a draws all parts of its set with the same d and s and viewing angle a or `$FF`. The viewing angle is `(2 + player direction − object direction) AND 3` (corresponds to `GV%()` in Crawl). Items in the map use viewing angle `$FF`.

### VIEW

1. The viewing direction yields forward step F and right step R (N: −B/+1, E: +1/+B, S: +B/−1, W: −1/−B; B = map width).
2. For each entry the cell `pos + d·F + s·R` is checked. If it is a wall and at least one of its columns is still free, the entry is queued. If it has flag bit 0, it marks its columns as occluded.
3. An object slot in a free cell queues the matching sprite parts: first the objects from the object list at this position, then the item from `ITEMSET` for the cell value. Sprite parts occlude nothing but are omitted if all their columns are already occluded. **Sprites are not clipped against walls (since P6i):** A sprite is drawn completely, nearer walls then overdraw it (paint order). Clipping happens only at the edge of the viewport. A sprite that is taller than the wall at its depth protrudes above the wall at the top and is overdrawn there by the ceiling or wallpaper of the nearer depths; suitable sprite heights are up to the author (`dbespr` warns).
4. Output to `$0B00`: first type 4 (`VMF AP+clear offset, value, length`), then all queued entries from back to front: walls as type 2 (`VMC source, destination, width, height, row width`), sprite parts as type 12 (`VMS source, destination, list`, `VIEW` copies the list to `$0E00`) or type 2; at the end 0. Type 12 needs VDC-BASIC v2g with the VCL type for `VMS`.
5. More than 22 visible entries or more than 512 bytes of VMS lists do not fit in the buffers. `VIEW` then aborts at the back and reports A = 2.

`tools/wallconv.py` converts `WALLS.VDC` from Crawl 128 to this format. The position of the 19 Crawl images in the view grid (depth, side, face) is in `SLOTS` there. `tools/crawlsprites.py` creates the sprite sets for ghosts (`RED.VDC`, `RED1.VDC`, transparent) and gems (font characters), with the positions from Crawl.

## VRL v1 (RLE stream for `RXV`)

Details: `docs/specs/P1-vrl.md`, tool `tools/vrl.py`. Words low/high.

| Byte b | Following bytes | Meaning |
|---|---|---|
| `$00` | – | End |
| `$01–$7F` | n = b bytes | n literals (1 … 127) |
| `$80–$FD` | v | Run: L = b − `$80` + 2 (2 … 127) times v |
| `$FE` | lo, hi | Skip: advance destination by n = hi·256 + lo (0 = 65536), write nothing |
| `$FF` | lo, hi, v | long run: L = hi·256 + lo times v (0 = 65536) |

File frame (PRG):

| Offset | Size | Content |
|---|---|---|
| 0 | 2 | Load address (default `$2000`) |
| 2 | 2 | `"V" "R"` |
| 4 | 1 | Version = 1 |
| 5 | 2 | unpacked length U (0 … 65535; a skip at the end does not count) |
| 7 | … | Stream up to and including `$00` |

Raw streams without a header (`--raw`) are possible, e.g. embedded in DTS.

## Memory map bank 1 (engine 0.2, `MEMSIZ $4000`)

Source and rationale: `docs/specs/P6-engine.md` 2.4. The tools take these addresses as defaults (`tools/dbemem.py`) and abort if a file extends beyond its area.

| Area | Content | Tool (default load address) |
|---|---|---|
| `$0400–$3FFF` | BASIC variables (first statement `POKE 57,0:POKE 58,64:CLR`) | – |
| `$4000–$5FFF` | DMP (map) | `dbemap`, `crawlmap` `$4000` |
| `$6000–$7FFF` | S2 (sprite sets) | `dbespr` `$6000` |
| `$8000–$AFFF` | DTS wall | `dbetex` `$8000` |
| `$B000–$DBFF` | Lib (`dbe0.2.lib`, jump table at `$B000`) | – |
| `$DC00–$E7FF` | Lib tables and variables (not in the file) | – |
| `$E800–$EDFF` | DVG | `dbegeom` `$E800` |
| `$EE00–$F5FF` | DTS floor | `dbetex` `$EE00` |
| `$F600–$FB7F` | DTS ceiling | `dbetex` `$F600` |
| `$FB80–$FBFF` | DBG (wallpaper) | `dbetex bg` `$FB80` |
| `$FC00–$FEFF` | **reserved** (Blitz! runtime) | – |

Lists for VCL type 9 (content of DTS and S2) reside from `$4000`, not in `$D000–$DFFF`. Anyone packing the files densely chooses their own load addresses in the windows `$4000–$AFFF` and `$E800–$FBFF`; the tools then check the window end.

## DVG v1 (viewport geometry, from `tools/dbegeom.py`)

PRG file (2-byte load address, `[output].load`, default `$E800`, bank 1; area up to `$EDFF`, memory map above). All offsets relative to the content, words low/high. Source: `docs/specs/P3-geometry.md`.

**`view.toml` `[viewport] byte_edges`** (default `false`): `true` rounds the masks to whole bytes (2-pixel steps at the slanted edges; a byte belongs to the polygon if its midpoint lies inside). This avoids half bytes and VMS type 8 commands at the edges of walls and tiles; in the demo this saves about 17 % VCL time (`P6-engine.md`, result P6h). The geometry ID changes, textures must be re-imported. Sprites (`dbespr`) are not affected.

### Header (24 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"D" "V"` |
| 2 | Version = 1 |
| 3 / 4 | VW: width in bytes (width_px / 2) / VH: height in lines |
| 5 / 6 | D (depth) / S (largest \|s\|) |
| 7 | NE: number of elements (≤ 255) |
| 8–9 / 10–11 | stride / origin |
| 12–13 | Geometry ID: CRC-16/CCITT (`binascii.crc_hqx`, start `$FFFF`) over the content with bytes 12–13 and 10–11 (origin) = 0; 0 becomes 1. `origin` is not part of the ID (shape, not position) |
| 14 / 15 | Horizon band y0 / y1 (exclusive, clipped) |
| 16 / 17 | Element length = 16 / length of depth entry = 8 |
| 18–19 / 20–21 | Offset of depth table (24) / offset of element table (24 + 8·(D+1)) |
| 22–23 | Total length of the content |

### Depth entry (8 bytes, D + 1 of them, d = 0 … D)

| Offset | Content |
|---|---|
| 0–1 | Ceiling band y0, y1 (exclusive; equal = empty) |
| 2–3 | Floor band y0, y1 (exclusive) |
| 4 / 5 | Index of the first element / number of elements of the depth |
| 6 / 7 | Width of the full front in bytes (0 for d = 0) / byte column of the full front |

### Element (16 bytes)

Order front to back: d ascending; per depth cells s = 0, −1, +1, −2, +2 …; per cell front, side, floor, ceiling, object slot.

Front (0), side (1), floor (2), ceiling (3):

| Offset | Content |
|---|---|
| 0 / 1 / 2 | Kind / d / s (signed) |
| 3 | Flags: bit 0 = column range valid, bit 1 = partial front (image = full front of the depth from `src_dx`), bit 2 = clipped, bit 3 = band coverage (only fronts whose rectangle contains the band lines of their depth: e.y ≤ ceiling band y0 and e.y + e.h ≥ floor band y1 of the depth; `dbegeom` sets it since P6h for all such fronts, `VIEW` thereby occludes bands, tiles and wallpaper earlier) |
| 4–7 | x (byte column), y (line), w (bytes), h (lines) of the rectangle |
| 8–11 | Core kx, ky, kw, kh (relative to the rectangle; kw = 0: no core) |
| 12 / 13 | Column range c0 / c1 (exclusive, absolute) |
| 14 | src_dx (partial front only) |
| 15 | 0 |

Object slot (kind 4): byte 1 = d, 2 = s, 3 = 0, 4–13 = 5 anchors p = 0 … 4 (rear left, rear right, center, front left, front right), each byte column (signed, saturated to −128 … 127) and line of the footpoint (saturated to ≤ 255), 14–15 = 0.

Destination in the buffer: `AP + origin + y · stride + x`.

## DMP v1 (map, from `tools/dbemap.py` and `tools/crawlmap.py`)

PRG file: 2-byte load address (default `$4000`, bank 1, area up to `$5FFF`), then the content. Offsets relative to the content, words low/high. Source: `docs/specs/P4-map.md`. Cell (x, y), index i = y · W + x; directions 0 N, 1 E, 2 S, 3 W (north = smaller y). Style number: 0 = nothing, n ≥ 1 = style n − 1 in the associated DTS.

### Header (24 bytes)

| Offset | Content |
|---|---|
| 0–1 | `"D" "M"` (`$44 $4D`) |
| 2 | Version = 1 |
| 3 | W (1 … 255) |
| 4 | H (1 … 255) |
| 5 | NT: number of tiles (1 … 256; 256 stored as 0) |
| 6–7 | NE: number of events |
| 8–9 | Start cell (cell index) |
| 10 | Start direction (0–3) |
| 11 | Tile for cells outside the map (index < NT) |
| 12–13 | Offset of tile layer (= 24) |
| 14–15 | Offset of content layer (= 24 + W·H) |
| 16–17 | Offset of tile table (= 24 + 2·W·H) |
| 18–19 | Offset of events (= tile table + 8·NT) |
| 20–21 | Total length of the content (= events + 4·NE) |
| 22–23 | reserved 0 |

W · H ≤ 16384 (warning above 4096, because the lib keeps the map in bank 1).

### Tile layer (W·H bytes)

Row by row, one byte per cell: tile index < NT.

### Content layer (W·H bytes)

| Bit | Meaning |
|---|---|
| 0–5 | Item 0–63 (0 = none); assignment to a sprite set via `ITEMSET`; lies at sub-position center |
| 6 | Automap: seen (runtime; normally 0 in the file) |
| 7 | Automap: marker |

### Tile table (NT × 8 bytes)

| Offset | Content |
|---|---|
| 0 | Wall style north face |
| 1 | Wall style east face |
| 2 | Wall style south face |
| 3 | Wall style west face |
| 4 | Floor style (0 = no floor) |
| 5 | Ceiling style (0 = no ceiling) |
| 6 | Flags |
| 7 | Automap character (0 = default according to flag AUTOMAP) |

| Flag bit | Name | Meaning |
|---|---|---|
| 0 | SOLID | blocks the way (`MOVE`) |
| 1 | BLOCKSIGHT | blocks the sight for the game logic |
| 2 | OCCLUDING | `VIEW`: faces occlude their column ranges (only if the image in the DTS is also occluding) |
| 3 | DOOR | door (game logic) |
| 4 | AUTOMAP | draw as a wall on the automap |
| 5 | CONTENT | "draw content": a cell with faces additionally draws its objects (item of the content layer and object list), order side face, objects, front (door, grating, arch); without faces no effect |
| 6 | DISTANT | reverses the rule of the far-view fill (section "DBG v1"): with ceiling wallpaper, without ceiling fill; without far-view fill no effect |
| 7 | – | 0 |

A cell has faces if at least one wall style is ≠ 0. Tile face shown per position (d, s) and viewing direction v: front (v + 2) AND 3; side left (s < 0) (v + 1) AND 3; side right (s > 0) (v + 3) AND 3. Floor and ceiling are also drawn in cells with faces; with OCCLUDING and four wall styles ≠ 0 they are invisible and do not count as a gap in the gap check of the bands. Cells outside the map behave like the tile from header byte 11.

### Events (NE × 4 bytes)

| Offset | Content |
|---|---|
| 0–1 | Cell index |
| 2 | Type |
| 3 | Parameter |

Sorted by (cell index, type, parameter). Types: 0 invalid; 1 `enemy` (parameter = enemy number); 2 `teleport` (group; target = other cell with the same group); 3 `exit` (0 closed, 1 open); 4 `text` (text number); 5–127 reserved for the engine; 128–255 free for the game.

### Sub-positions

Map and object list store sub-positions absolutely: 0 NW, 1 NE, 2 SW, 3 SE, 4 center. `VIEW` converts them with the viewing direction v to the drawing position p of the geometry (0 rear left, 1 rear right, 2 center, 3 front left, 4 front right):

| v | NW | NE | SW | SE | Center |
|---|---|---|---|---|---|
| 0 N | 0 | 1 | 3 | 4 | 2 |
| 1 E | 3 | 0 | 4 | 1 | 2 |
| 2 S | 4 | 3 | 1 | 0 | 2 |
| 3 W | 1 | 4 | 0 | 3 | 2 |

`tools/crawlmap.py` converts `CRAWL128.CD1` losslessly to DMP (tile index = Crawl cell value, NT ≥ 43, because Crawl sets the exit to tile 42 at runtime); examples: `docs/specs/examples/demo.toml`, `docs/specs/examples/crawl128.toml`.

## DTS v1 (texture set, from `tools/dbetex.py`)

PRG file: 2-byte load address (default per kind: wall `$8000` to `$AFFF`, floor `$EE00` to `$F5FF`, ceiling `$F600` to `$FB7F`; bank 1), then the content; offsets relative to the content, words low/high. Source: `docs/specs/P5-textures.md`. A DTS contains one kind (wall, floor, ceiling); the image data is stored separately in a VRL file (`RXV` to the VRAM base that `TEXSET` specifies); all VRAM offsets are relative to this base.

Header (32 bytes): `"DT"`, version 1, kind (0 wall, 1 floor, 2 ceiling), geometry ID (word, from the DVG), NE, D, NS (slots), NST (styles, ≤ 32), NI (images, ≤ 254), NK (cores), one word each for the offset of slot map, style table, image directory, core table, data area, total length, then U (VRAM length), CRC of the VRAM data (`crc_hqx`, start `$FFFF`), stride, reserve 0. Areas contiguous in this order.

- **Slot map** (NE + 2·(D + 1) bytes): index 0 … NE − 1 = DVG element, NE + d = ceiling band d, NE + (D + 1) + d = floor band d; value = slot of this kind or `$FF`.
- **Style table** (NST × NS bytes): image index, `$FE` = no image, `$FF` = fall back to style 0. DMP style number n ≥ 1 = style n − 1; 0 = nothing.
- **Image directory** (NI × 16 bytes): flags (bit 0 OCCLUDING, 1 CUTOUT, 2 ROWS, 3 EDGE), slot, nk, h, offset of the first core (with ROWS the h fill bytes), VRAM offset of the edge bytes, number of edge bytes, offset and length of the VMS list, source image (with CUTOUT the full-front entry), 0.
- **Core table** (NK × 8 bytes): VRAM offset, dx, dy, w, h, srcstep (0 = packed, otherwise source line distance).
- **Data area**: VMS lists (alpha, number of commands, commands type 1 `01 ofs len`, type 8 `08 ofs`) and line fill bytes.

## DBG v1 (wallpaper, from `tools/dbetex.py bg`)

PRG file (default `$FB80`, bank 1, area up to `$FBFF`), content: `"DB"`, version 1, VW, VH, geometry ID (word), P (panorama width in bytes, word), y0, h, flags (bit 0 WRAP), 4 offset words o_v (N, E, S, W), U = P · h (word), CRC of the VRAM data (word), then VH fill bytes (color · 17 for lines outside [y0, y0 + h), otherwise 0). The panorama is stored line by line (P bytes per line) in the associated VRL. Details and drawing rule: `docs/specs/P5-textures.md` 6.

**Far view and fill:** Lines of sight longer than the view depth D end in the horizon band (DVG header 14/15) of depth D. Without far-view fill the wallpaper appears there, even indoors (through a grating in a roofed chamber you then see the landscape). With far-view fill (`BGSET` Y ≠ 0, fill byte in P2 low; chunky: 2 pixels per byte, e.g. `$11` dark gray) the tile of depth D through which the line of sight goes into the distance decides per column of the horizon band:

- Tile **with ceiling** (ceiling style ≠ 0): **fill byte**; tile **without ceiling** (sky, ceiling style 0, also the outer tile without ceiling): **wallpaper**. The tile flag DISTANT (bit 6) reverses this (roofed arcade with a view outdoors → wallpaper; cave without ceiling texture → fill).
- Fill is applied only where something can still be seen behind the last depth: columns that an occluding wall (flag OCCLUDING and occluding image) of a depth 0 … D covers stay off. Windows, gratings and arches do not occlude; walls behind them are drawn normally, the fill is at the very back.
- In the columns with fill `VIEW` outputs no wallpaper (one fill entry VCL type 5 instead of the panorama copy); ceiling and floor gaps of depth D continue to show the wallpaper.
- The columns of the cells result from the far edges of the side faces of depth D (`GEOMSET`, `docs/specs/P6-engine.md` 5.7a). If there is no roofed cell at depth D, the list is the same as without fill.

## S2 v1 (sprite set, from `tools/dbespr.py`)

PRG file: 2-byte load address (default `$6000`, bank 1, area up to `$7FFF`), then the content (≤ 8192 bytes); offsets relative to the content, words low/high, VRAM offsets relative to the VRAM base from `SPRITESET`. Source: `docs/specs/P5b-sprites.md`. The image data is stored in a VRL file (`RXV` to the VRAM base). Areas contiguous in the order header, index table, image directory, core table, tag table, data area.

Header (40 bytes): `"S2"`, version 1, flags (bit 0 item), geometry ID (word; 0 = any geometry with the same stride and D), D, NA (1 … 4), NP (1 … 32), NI (≤ 254), NK (word), `angle_map[0 … 3]`, one word each for the offset of index table, image directory, core table, tag table, then NT (≤ 32), 0, offset of data area, total length, U (VRAM length), CRC of the VRAM data (`crc_hqx`, start `$FFFF`), stride (one word each), reserve 0 (4 bytes).

- **Viewing angle:** a = (2 + v − o) AND 3 (v player, o object, o = `$FF` → a = 0); 0 front, 1 right flank, 2 back, 3 left flank; `angle_map[a]` = image angle ai < NA.
- **Index table** (NP · NA · D bytes): entry (f, ai, d) at `(f · NA + ai) · D + d − 1`: image index, `$FE` = draw nothing, `$FF` = phase 0 of the same (ai, d) (not allowed in phase 0); f ≥ NP → f = 0.
- **Image directory** (NI × 16 bytes): flags (bit 3 EDGE), w (bytes), h, footpoint fx, fy (byte column, line in the image; lies on the DVG anchor), nk, offset of the first core, VRAM offset of the edge bytes, number of edge bytes, offset and length of the VMS list (0 = none).
- **Core table** (NK × 8 bytes): like DTS, srcstep always 0 (packed).
- **Tag table** (NT × 12 bytes): name (8 bytes ASCII, padded with `$00`), first phase, number of phases, mode (0 forward, 1 reverse, 2 pingpong), duration per phase in jiffies (1 … 255).
- **Data area:** VMS lists, only types 1 and 8, commands in line order with strictly increasing offset (line · stride + column, top left in the image), type 1 run within a line.
- **Clipping** (reference `dbespr.clip_image`, for `VIEW`): shorten cores to the clip region (full width keeps srcstep, otherwise source line distance = original width), rewrite the VMS list with the reference point at the top left of the clip region; invisible commands are replaced by VMS type 3 (`03 n_lo n_hi`, source skip), after the last visible command the list ends.
