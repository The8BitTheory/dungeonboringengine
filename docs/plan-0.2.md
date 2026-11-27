# Plan Engine 0.2 and VDC-BASIC v3: floor, ceiling, wallpaper, free viewport, RLE

As of: 2026-11-25. Agreed with the user. Basis: `engine-design.md`, `formats.md`, analysis of VDC-BASIC v2h and c128-vdc-gui.

## 1. Goals

- In addition to walls, **floor and ceiling textures**. Wall elements use **transparency** (trapezoid corners, windows, grilles, arches).
- **Background wallpaper** (landscape behind windows, sky, abyss).
- **Freely definable viewport**. The size of all elements is computed from it and output as a specification. The textures are **hand-painted, prefabricated tiles** (e.g. from Aseprite); the engine distorts nothing.
- **Dynamic objects** (enemies, items, animations) at the correct depth.
- Define **map and graphics formats**. Graphics are RLE-packed (format VRL) and are unpacked from RAM into VRAM with the new VDC-BASIC command **`RXV`**, with runs done by block fill.
- VDC-BASIC v3 additionally gets `VDL`/`VDR`/`VDB` (line, empty rectangle, filled rectangle) with a switch between bitmap (1 bpp) and chunky (4 bpp).

## 2. Constraints

- **Chunky mode:** The bitmap is fixed at `$0F`, the pixels are in attribute RAM: 1 byte = 2 pixels of 4 bits each, at most 160 × 100 pixels. Transparency per byte (skip) or per pixel (VMS command 8 or nibble RMW).
- **The engine owns only the 3D viewport** and an asset pool in VRAM that the game assigns to it. The game manages the rest of the screen.
- **VRAM:** Besides the bitmap and two attribute buffers, about 26 KB remain for font, HUD and assets. Wall styles, monsters and animations share the pool and are reloaded per map or zone.
- **VDC practice from c128-vdc-gui:**
  - Select reg 31 once, then `bit $D600/bpl/sta $D601` (15 cycles per byte). A new address costs about 80 cycles.
  - Block fill has about 200 cycles of fixed cost.
  - Change reg 24 only via read-modify-write, preserving bit 6.
  - After block operations, 18/19 points past the end.
  - Work horizontally.
  - Reg 36 = 0 is tricky for VRAM outside the display.

## 3. Memory

| Area (bank 0) | new |
|---|---|
| `$0B00–$0FFF` | Parameter block, stub (as before); the old VCL buffer `$0B00` becomes free |
| `$1300–$1BFF` | **Engine buffers:** VCL list (about 1 KB) and VMS lists (about 1.3 KB) |
| `$1C00–$3FFF` | **VDC-BASIC v3** (previously `$1300`, where only 10 bytes were still free) |
| from `$4001` | BASIC text: interpreted via a boot loader (`POKE 45/46`, `POKE 16384,0`, `NEW`), compiled with Blitz! Image 2 |

- VDC-BASIC must lie below `$4000` because it runs with the BASIC ROM banked in.
- The engine's shared RAM grows from 4 to 8 KB (`$0000–$1FFF`) so that the lib in bank 1 sees the buffers at `$1300`.
- The 256-byte limit for the VCL list and the VCL extension V2 are dropped.
- **To check:** the game's load buffer in bank 0 (Crawl `BE` from `$94E8`) above the end of the program; VDC-BASIC tests that place VMS lists at `$3000`.

## 4. Viewport and geometry

Project file `view.toml`, tool `tools/dbegeom.py`:

```toml
[viewport]
preset   = "westwood"   # Eye of the Beholder / Lands of Lore, proportionally scaled
width_px = 140          # even
height   = 96           # chunky rows (1 text row = 4 rows)
origin   = 0            # byte offset in the attribute buffer (relative to AP)
stride   = 80
```

- **Westwood preset:** Template 176 × 120, depth 3 plus own cell, lateral wall positions as there. Proportionally scaled to **140 × 96** (default, 1 text row free) or **136 × 92** (2 text rows). Width at most 160.
- **Output per element (d, s, kind):**
  - Rectangle (byte column, row, width, height)
  - Transparency mask
  - opaque core
  - Column range for the occlusion
- **Further outputs:** template PNGs, Aseprite template (one slice per element), `*.DVG`, **budget report** (VRAM per style). Guideline at 140 × 96: about 9–10 KB per wall style.

## 5. Render order (painter, per depth from back to front)

`VIEW` determines visibility from front to back (column mask, only occluding wall cores occlude) and then outputs the list from back to front. For each depth d = D … 0:

1. **Wallpaper** for the rows of this depth that no band fills. At d = D this is the horizon band behind it. In addition there are bands with gaps, i.e. cells without floor or ceiling. Output via `VMC` with source increment = panorama width (window from a wider image, shifted per viewing direction).
2. **Floor and ceiling** of depth d:
   - uniform style: one rectangle across the full width (`VMC`, opaque) or a gradient (`VMF` per row)
   - mixed styles: transparent trapezoid tiles per cell
3. **Cells of depth d from outside to inside** (order as in EOB). For each cell, either its wall surfaces or its contents:
   - **Wall cell:** first the side surface, then the front. Opaque core via `VMC`, transparent edge via `VMS`. Windows and grilles are not occluding; whatever is drawn behind them remains visible.
   - **Free cell:** its **dynamic objects** (enemies, items, projectiles, animations), sorted by **subposition**: back, middle, front. Items on the floor have 4 slots as in Westwood, enemies stand in the middle or in pairs. The subpositions are stored absolutely (NW, NE, SW, SE, middle) and are converted using the viewing direction.
   - Objects stand with their foot point on the floor of their cell. Therefore they do not overlap the floor and ceiling bands of nearer depths.
   - Inner neighbor fronts of the same depth are drawn after the objects of the outer cell and thereby occlude them correctly.
   - The occlusion by side surfaces of depth d does not clip away any objects of the same depth.
   - Parts whose columns are all hidden by nearer occluding walls are omitted.
   - Animation phase and viewing angle come from the object list.
   - Objects in the player's own cell (d = 0) are not drawn (as in EOB).

Errors occur only with sprites that are wider than their cell.

**Object list (parameter block, new):**
- 6 bytes per object: cell index (word), sprite set, viewing direction, animation phase, subposition (absolute)
- up to 16 objects; new location in P6 (no longer fits at `$0C10`, e.g. in the buffer at `$1300`)
- Items from the content layer of the map are added additionally via `ITEMSET`

## 6. Formats

All words low/high. The exact byte layouts follow in `formats.md` with the respective step.

**VRL (RLE stream for `RXV`)**

| Byte | Meaning |
|---|---|
| `$00` | End |
| `$01–$7F` | n literals follow |
| `$80–$FD` | Run, length (b − `$80`) + 2, then value |
| `$FE lo hi` | Skip: advance destination by n bytes, write nothing (for transparency and rectangles with stride) |
| `$FF lo hi v` | long run, 16-bit length (0 = 65536) |

- The encoder optimizes for size. The decoder decides per run: below threshold T via CPU, from T via block fill (T is measured).
- File: load address, `"VR"`, version, unpacked length, stream.

**Further formats**

- **DVG (geometry):** Header with VW, VH, stride, D, S, horizon, origin, geometry ID. Band table per depth, then elements: kind, d, s, rectangle, core, column range, subposition anchor for objects.
- **DTS (texture set):** Header with geometry ID, kind, styles. Per style one image index per element (`$FF` = style 0). Image directory: VRAM offsets for core and edge, VMS list. The image data lies in a VRL stream. Importer for PNG and Aseprite export.
- **DBG (wallpaper):** Panorama width, height, position, offset per viewing direction, data as VRL.
- **DMP (map):**
  - Header, tile layer (W×H, static), content layer (W×H, items 0–63, automap bits)
  - Tile table of 8 bytes: wall style N/E/S/W, floor, ceiling (0 = sky/empty), flags (solid, blocksight, occluding, door, automap), automap character
  - Events of 4 bytes: cell, type, parameter
  - Converter from `CRAWL128.CD1`
- **Sprite sets:** like SPR v1, extended by animation phase and subposition.

## 7. VDC-BASIC v3 (branch `v3`, on `v2h`)

1. Relocate to `$1C00–$3FFF`, boot loader, tests interpreted and as a Blitz! Image 2 compilation.
2. **`RXV src,dst`:** VRL from bank 0 into VRAM. Optionally VCL type 8 = `RXV`.
3. **`VDM mode,base,stride`:** 0 = bitmap 1 bpp, 1 = chunky 4 bpp.
4. **`VDL x1,y1,x2,y2,c`, `VDR x,y,w,h,c`, `VDB x,y,w,h,c`** (tokens `$FE3E–$FE40` as originally intended for `vdl/vdr/vdb`):
   - horizontal span: aligned middle part via block fill, edges via nibble or bit-mask RMW
   - vertical line with increment = stride
   - Box = span with repetitions
   - diagonal lines: Bresenham with run slicing (horizontal or vertical runs via the fast paths)
5. **Tests:** byte comparison against a Python reference model, VRAM dump via the monitor, cycles per path.

## 8. Steps

| # | Content | Agent |
|---|---|---|
| P0 | Measure: threshold CPU vs. block fill, `VMC` vs. `VMS` per byte, reg 36 | Sonnet (test program), Haiku (VICE runs) |
| P1 | `tools/vrl.py` with tests, specification | Sonnet |
| P2a | VDC-BASIC to `$1C00`, boot loader, Blitz! test | Opus |
| P2b | `RXV` (+ VCL type 8) | Opus |
| P2c | `VDM`/`VDL`/`VDR`/`VDB` with Python reference model | Opus (assembler), Sonnet (reference model, tests) |
| P3 | `dbegeom.py`, Westwood preset, templates, budget | Sonnet |
| P4 | DMP, `dbemap.py`, `crawlmap.py` | Sonnet |
| P5 | DTS/DBG importers (PNG, Aseprite) | Sonnet |
| P6 | Engine 0.2: 8 KB shared RAM, buffers at `$1300`, `POOLSET`/`GEOMSET`/`TEXSET`/`BGSET`, DMP, new object list, new `VIEW`; sim65 with list comparison | Opus |
| P7 | Crawl on 0.2 (pixel-identical), demo map with windows, sky, abyss and enemies, timing comparison | Sonnet, Haiku | **done** (2026-11-26, results `docs/specs/P7-crawl.md` section 12) |
| P8 | Update documentation | Sonnet |

- **Order:** P0, P1, P3 and P4 in parallel; P2a, then P2b/P2c; P5 after P3; P6 after P1–P5.
- **Procedure per step:** Opus writes the detailed specification and checks the result (review).
- **Tests:** event-driven (breakpoints, no fixed wait times).

## 9. Decisions during implementation (2026-11-25)

| Topic | Decision |
|---|---|
| Sprite clipping at the viewport edge | New VMS list command "source n bytes further" (source skip) in VDC-BASIC v3; the engine shortens the lists when copying them into the buffer (P2c/P5b/P6) |
| VIC graphics | With v3, `GRAPHIC 1–4` are taboo (VDC-BASIC sits at `$1C00–$3FFF`) |
| VDC-BASIC guide | is converted to v3 only in P8 |
| `vrl.py` | canonical version in vdc-basic `tools/vrl.py`; the engine refers to it or keeps a copy |
| `origin` | does not belong to the geometry ID (move viewport without re-importing the textures) |
| Threshold T | patchable byte in VDC-BASIC (`$1C04`), default 14 (placeholder from the cost formula); VICE measures 2, not transferable; final after measurement in Z64K or on real hardware (`test/bench` in vdc-basic) |
| BASIC variables bank 1 | `$0400–$4FFF` (approx. 19 KB incl. strings, upper limit will be lowered); assets and lib from `$5000` (memory map in P6-engine.md); **since P6h `MEMSIZ $4000`**: variables `$0400–$3FFF` (15 KB), assets from `$4000` (memory map G, `P6-engine.md` 2.4) |
| WALLSET/SPRITESET v1 | dropped; Crawl is converted in P7 via converter to DVG/DTS/sprite sets v2 |
| MOVE, CELL, automap bit | remain in P6 (P6f) |
| Objects in wall cells | new tile flag "draw content" (door, grille, arch): side surface, then objects, then front |
| VMS lists fixed in bank 0 | decide after the measurements in P6 |
| Threshold T (Z64K) | 3–4 in the display (VICE 2); `vrl.py` uses the table `fill_done(L)` |
| Objects and `cover` (P6i, 2026-11-26) | Objects are not clipped against `cover`; occlusion via render order (painter: sprite whole, nearer walls overdraw). `cover` only discards fully hidden sprites, clipping happens only at the viewport edge (`P6-engine.md` 5.8/5.8a) |
| Automap in Crawl 1.1 (P7, 2026-11-26) | like 1.0f always shows the whole dungeon (`AM%=0`, default); the fog variant (only explored areas, `AM%=1`) remains optional in the source. The deviation "automap only explored areas" from P7 4.3 is dropped |
| Font and title as VRL (P7, 2026-11-26) | `font.vrl` (1406 bytes instead of 1732) and `title.vrl` (1021 instead of 2340 bytes) via `tools/vrlpics.py`; the title stays packed in RAM from 63493 and is unpacked via `RXV` on every display |
| Crawl 1.1 (P7, 2026-11-26) | pixel-identical to 1.0f (offline 19 136 views, emulator 74 prompts), start only via `BOOT`, release `crawl128-110.d81/.d64`, lib reserve 282 bytes |
| Demo (P7e, 2026-11-26) | separate program in the engine repo (`demo/`), not as a Crawl level; `max_cores` at most 4, goblin without tag, enlarged 2x |
