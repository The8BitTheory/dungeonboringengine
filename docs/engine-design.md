# Dungeon crawler engine for the C128 – Design

**Note (as of 0.2):** This design describes engine 0.1. For engine 0.2 (floor, ceiling, wallpaper, free viewport, RLE, 8 KB shared RAM, new memory map) see `docs/plan-0.2.md` and `docs/specs/P6-engine.md` (memory map 2.4 with `MEMSIZ $4000`, functions, `VIEW`); the data formats are in `docs/formats.md`. The sections on memory (3.1) and the function table are superseded there.

As of: 2026-11-23, draft for discussion. The starting point is `game/crawl.bas` from [dungeoncrawlerjam2025](https://github.com/The8BitTheory/dungeoncrawlerjam2025) (Crawl 128) with VDC-BASIC v2g. The engine is developed in this repo.

### Decisions (2026-11-23)

| Topic | Decision |
|---|---|
| Repo | `dungeonboringengine` is the engine's own repo. Changes go through a branch and pull request. |
| Drawing | The engine builds on VDC-BASIC and draws via `VCL`. If something is missing, `VCL` is extended; there is no separate VDC routine in the lib. |
| Location of the lib | Decided based on measured sizes (step 1, section 3.2). |
| Interrupts in bank 1 | The lib copies the Kernal interrupt switch to bank 1 `$FF05–$FFFF` (like c128-vdc-gui). Interrupts stay enabled, no `SEI`. |
| Map format | Separate step, section 5.1 is only a placeholder. |
| c128-vdc-gui | Not used in the game, serves only as a source of information. |

## 1. Goals and constraints

- **General:** arbitrary wall sets, adjustable view depth and width, multiple maps, multiple sprite sets (enemies, items).
- **Blitz! compatible:** The game remains a BASIC 7 program that runs interpreted and can be compiled with Blitz! 128. All calls via `SYS`/`RREG`, `POKE`/`PEEK` and VDC-BASIC commands (after `::`).
- **Division of work:** BASIC keeps game rules, flow, HUD texts, sound and file loading. Everything that needs many field accesses or many VDC commands per step moves to assembler.
- **Zero page:** The lib uses `$FA–$FD` and, during a call, the block `$63–$72`, which the stub saves and restores (P6d-opt, `P6-engine.md` 2.1). `$3D/$3E` (Blitz!) and `$05–$08` (SYS registers) are left untouched.

## 2. Layers

| Layer | Content | Where |
|---|---|---|
| Game (BASIC) | Rules, menus, HUD (`VMP`), sound, `BLOAD` of the assets, combat, high scores | `crawl.bas` |
| **DCL** – dungeon crawler lib (new, assembler) | Map, view calculation, render list, objects/enemies in the field of view, movement/collision, enemy AI, automap | this repo, `engine/`; location after measurement (3.2) |
| VDC-BASIC v2g | general VDC operations: `VMC`, `VMF`, `VMS`, `VMP`, `RTV`, `VCL` (command lists) | `$1300–$1BFF`, bank 0 |

Rule for the boundary: **Whatever knows nothing about dungeons belongs in VDC-BASIC** (copying, filling, transparent sprites, command lists). **Whatever knows the map, viewing direction or wall sets belongs in the DCL.**

The DCL does not draw by itself but produces a VCL list. BASIC executes it with `::VCL`. This keeps all VDC code in VDC-BASIC, and the DCL can be tested without a VDC (compare the list). If `VCL` is not sufficient (length, types, speed), VDC-BASIC is extended (section 7).

## 3. Memory layout

### 3.1 Fixed areas

| Area | Bank | Content |
|---|---|---|
| `$0B00–$0BFF` | 0 | VCL buffer (256 bytes = current limit of `VCL`) |
| `$0C00–$0C3F` | 0 | DCL parameter block (section 4) |
| `$0C10–$0C30` | 0 | Object list (count, 4 bytes each: position, set, direction) |
| `$0C40–$0C4F` | 0 | tests only: timing (`$0C40`), scene test helper (`$0C44`) |
| `$0C50–$0CFF` | 0 | Reserve |
| `$0D00–$0D83` | 0 | Stub (`SYS 3328` init, `SYS 3331,F,X,Y` call), rest up to `$0DFF` reserve |
| `$0E00–$0FFF` | 0 | VMS lists that `VIEW` writes per frame (512 bytes) |
| `$1300–$1BFF` | 0 | VDC-BASIC v2g |
| `$FF05–$FFFF` | 1 | Copy of the Kernal interrupt switch (only if the lib resides in bank 1) |

Zero page: `$FA–$FD`, plus `$63–$72` during a call (saved by the stub, P6d-opt). VDC-BASIC uses `$83–$8E`, Blitz! needs `$3D/$3E`, `$05–$08` is the SYS register transfer.

### 3.2 Location of the lib – candidates

| Candidate | Size | interpreted | compiled | Effort |
|---|---|---|---|---|
| A: Bank 1 from `$8000` (protected by `POKE 58,128`), shared with maps and tables | up to 32 KB | yes | yes | Bank switch per call (`$D506` shared RAM, `$FF00=$7E`), interrupt switch in bank 1 |
| B: Bank 0 `$0D40–$0FFF` | < 1 KB | yes | yes | none, but only for a stub or a very small lib |
| C: Bank 0 `$1C00–$3FFF` | 9 KB | no (BASIC text) | yes (Blitz! image 2) | ruled out as long as development is interpreted |
| D: Bank 0 top, BASIC text end lowered (e.g. `$E000–$FEFF`) | up to 8 KB | yes | to be checked | no bank switch for the VCL buffer; runs only with ROM banked out; compatibility with Blitz! open |

The decision is made after step 1 based on these measurements:

- Code size per function (from the ld65 map)
- Tables: view offsets (4 directions × grid cells × 2 bytes), wall set (entries × 8 bytes), sprite sets, tile table
- Map size of the planned maps
- Length of the VCL list per view depth (D = 3, 4, 5)
- Run time of a `VIEW` call and the subsequent `VCL` execution (raster lines or `TI`)

### 3.3 Bank switching (if bank 1)

Like c128-vdc-gui: For every call the stub enables shared RAM (`$D506` bottom; 4 KB are implemented, `$0000–$0FFF`) and `$FF00=$7E` (RAM 1, I/O). The VCL buffer and parameter block then physically reside in bank 0, where `VCL` expects them, and are visible from bank 1. On return the DCL restores `$D506` and `$FF00`. Interrupts continue to run via the switch at `$FF05` in bank 1.

### 3.4 Measurements from step 1

Measured with `crawl.bas` (map 20 × 11, wall set with view depth 3, 19 frames). The screen output is pixel-identical to the original in all 19 test frames.

| Quantity | Value | Source |
|---|---|---|
| Lib code (`INFO`, `MAPINIT`, `SETPOS`, `WALLSET`, `VIEW`) | 944 bytes | `build/lib.map` |
| Lib variables | 220 bytes (column coverage 128, view list 44, rest 48) | `build/lib.map` |
| Stub (bank 0) | 132 bytes | `build/stub.map` |
| Wall set metadata | 10 + 10 per entry; Crawl: 200 bytes | `tools/wallconv.py` |
| Map | width × height; Crawl: 220 bytes | – |
| VCL list per frame | 19–96 bytes, mean 57 (1–8 wall entries) | sim65, all 400 views |
| `VIEW` | 7613–10864 cycles, mean 9557 | sim65, all 400 views |
| Render phase (lines 4600 ff.), 18 keys, 13 redrawn frames plus start frame | Original 981 jiffies, DBE 149 jiffies (about 6.6 times faster) | VICE, `TI` |
| Whole step with movement or turn | Original 2.18 M cycles, DBE 1.32 M (−39 %) | VICE, stopwatch |

The rest of a step (1.3 M cycles) is BASIC: enemy AI, HUD, coins and ghosts. Since step 1b the lib draws coins and ghosts; the AI follows in step 6.

**After step 1b (objects in `VIEW`):**

| Quantity | Value |
|---|---|
| Lib code (additionally `SPRITESET`, `ITEMSET`, `SETCELL`, objects, VMS lists) | 1834 bytes |
| Lib variables | 342 bytes |
| Sprite metadata Crawl | Ghosts 1854 bytes (24 parts, 8 VMS lists with 111–265 bytes), gem 186 bytes |
| Ghost images in VRAM | 1882 bytes packed instead of 2338 bytes `RED.VDC` + `RED1.VDC` |
| `VIEW` without objects in the frame | 10813–14191 cycles (object slots cost about 3500 cycles) |
| 10 scenes with ghost in the frame, whole step | Original 2.14 M cycles, DBE 1.07 M (−50 %) |

**Projection for the build-out** (estimate, not measured):

| Part | Code | Data |
|---|---|---|
| today (step 1b) | 1.8 KB | 0.3 KB |
| `MOVE`, `CELL`, automap | +0.4 KB | – |
| `ENEMYSTEP` | +0.3 KB | enemy list |
| Map format with tile table | +0.3 KB | 256-byte tile table |
| **Total** | **about 2.8 KB** | **about 0.6 KB plus assets** |

**Proposal:** Reserve `$C000–$CFFF` (4 KB) for the lib's code and variables. Assets and maps reside in bank 1 outside this area: `$8000–$BFFF` for maps, `$E000–$FEFF` (visible as RAM with `$FF00=$7E`) for wall set and sprite metadata.

## 4. Call interface

```
BANK 1:SYS 49152,F,X,Y     : REM F = function number, X/Y = small parameters (address/bank depending on location, 3.2)
RREG A,X,Y,S               : REM result (status, values)
```

- At the start of the lib there is a `JMP` to the dispatcher, which branches on the A value. This keeps entry addresses the same across new versions.
- Larger parameters (words, addresses) are in the parameter block `$0C00` in bank 0 and are written with `BANK 0:POKE`. Results that do not fit in A/X/Y are also placed there.
- Return in A: 0 = ok, otherwise error number.

### Functions (first version)

| F | Name | Input | Output |
|---|---|---|---|
| 0 | `INFO` | – | A = version, X/Y = address of parameter block |
| 1 | `MAPINIT` | Block: address of raw map (bank 0), width, height, VRAM address of automap | Map transferred to bank 1, automap filled in VRAM, start points/teleporters/exit in the block |
| 2 | `SETPOS` | X = direction, Block: position | – |
| 3 | `MOVE` | X = movement (forward, backward, strafe left, strafe right, turn) | A = result (moved, wall, enemy); Block: new position, cell value at target |
| 4 | `VIEW` | Block: buffer address (`AP`) | VCL list from `$0B00`; Block: number of entries, visible objects |
| 5 | `CELL` | Block: position | A = cell value (for game logic such as coins, exit) |
| 6 | `SETCELL` | Block: position, value | Map and automap cell updated |
| 7 | `ENEMYSTEP` | X = enemy number | Enemy moved one step toward the player (Manhattan, as in lines 7800–8020) |
| 8 | `WALLSET` | Block: header address (bank 0), VRAM base | Wall set table created in bank 1 |
| 9 | `SPRITESET` | Block: number, header address, VRAM base | Sprite set registered |

BASIC side of a step (target):

```
BANK 1:SYS 49152,3,1:RREG R      : REM one step forward
IF R=2 THEN GOSUB 5500           : REM coin -> HUD, sound
BANK 0:POKE 3074,AP AND 255:POKE 3075,AP/256
BANK 1:SYS 49152,4:BANK 15
::VCL 2816
```

This replaces lines 4600–5900 (visibility check, `FN M`, `RL%`, `RQ%`, coin and ghost display) and 5300–5400 (movement, collision).

## 5. Data formats

### 5.1 Map

To be defined in a separate step. Until then the DCL uses the current format from `CRAWL128.CD1`: one byte per cell, row by row, bit 0 = wall. Requirements for the later step: multiple maps, multiple wall styles per map, cells that block only movement or only sight, events for BASIC (coin, teleporter, exit), automap markers.

### 5.2 Wall set

The view is a grid of **depth d = 0…D** (0 = own cell) and **side s = −S…+S**. Each cell of the grid can have up to three visible faces: front and, off-center, a side face.

```
Header:  "WS", version, D, S, number of wall styles, entry length (8)
Entry:   style, d, s, face (0 front, 1 side)
         VRAM source offset (2), width in bytes (1), height in raster lines (1),
         destination offset in the frame (2, relative to AP)
Then:    image data (copied to VRAM by BASIC with RTV)
```

- The current set (`WALLS.VDC`, 7-byte entries, target = byte + 406, D = 3, S = 1) can be converted losslessly to this format with a converter (Python).
- If a style lacks an entry, the DCL uses style 0. This allows a wall set to start small.

### 5.3 Sprite set (enemies, items)

```
Header:  "SP", version, number of angles (1 or 4), number of depths
Entry:   angle, d, VRAM source offset (2), width, height, destination anchor offset (2)
```

- The angle results from the player's viewing direction versus the enemy's viewing direction (currently `GV%()`).
- Output via `VMS` (transparent). Half sprites at the edge (currently lines 6400/6500) are handled by the DCL via width and source offset.
- Coins (currently `VMC` 3×6 at fixed positions) become a sprite set with one angle.

## 6. View calculation (`VIEW`)

1. **Offsets:** For each grid cell (d, s), map offset = d·F + s·R. F and R depend on the viewing direction (N: −B, +1; E: +1, +B; S: +B, −1; W: −1, −B; B = map width). The table is computed once per direction at `MAPINIT`; this replaces `V%(3,19)`.
2. **Front to back:** For d = 0…D a column mask (which frame columns are already occluded) is carried along. A sight-blocking cell enters its front and side faces, provided they are not yet occluded, and then occludes its columns. If the mask is full, the search ends. This replaces the hand-written cases in 5100–5210 and `RL%()`.
3. **Objects:** Enemies and items in visible cells go into the same list, with depth as the sort key.
4. **Output:** The list is written back to front as VCL: type 2 (VMC with increment = frame width) for walls, VMS type for sprites, end byte 0. This corresponds to the current `RQ%` back-to-front drawing.

With 11 bytes per VMC entry, 23 entries fit in 256 bytes. For D = 3 this is sufficient. For greater depths `VCL` needs an extension (section 7).

## 7. Extensions in VDC-BASIC (v2g, 211 bytes free)

| No | Change | Reason |
|---|---|---|
| V1 ✓ | VCL type 12 for `VMS` (transparent sprites); VMS lists with 2-byte command count and more than 256 bytes length | Enemies and items in the same list as walls (branch `v2g`, from `ec049bd`; currently v2h, branch `v2h`) |
| V2 | VCL with 16-bit offset or chaining (type "continue at address") | more than 23 entries at greater view depth |
| V3 | Token file, docs for `VCL`/`VMS`/`VMB` | Types 8–12 in the comment are not implemented; docs should show the actual state |

Everything else from `crawl.bas` (HUD texts, frames, title screen, automap section, combat effects) can be implemented with the existing commands and stays in BASIC.

## 8. Implementation in steps

| Step | Content | Check |
|---|---|---|
| 1 ✓ | Skeleton and measurement: jump table, bank switching and interrupt switch, `INFO`, parameter block; wall set converter (Python, from `WALLS.VDC`), `WALLSET`; `VIEW` walls only on the current map format; build with ca65 | done: `crawl.bas` interpreted in VICE with `VIEW` instead of the BASIC view calculation, 19 test frames pixel-identical to the original (image comparison instead of list comparison); interrupts during the lib checked only indirectly (no crashes at about 10 000 cycles per call and 60 Hz IRQ); measurements in 3.4 |
| 1b ✓ | Objects in `VIEW`: ghosts (transparent via `VMS`) and gems at the correct depth; VCL type 12 (`VMS`) in VDC-BASIC; `SPRITESET`, `ITEMSET`, `SETCELL`, working copy of the map in `MAPINIT` | done: Crawl test run pixel-identical except for the transparent ghost corners; 10 staged scenes (ghost at the side, centered, partly occluded) |
| 2 | Decision on location of the lib based on the measurements, place the lib there | Measurements and decision in this document |
| 3 | Define map format (separate design) | Agreement |
| 4 | `MAPINIT`, `SETPOS`, `CELL`, `MOVE`; switch `crawl.bas` to `VIEW` and `MOVE` | Playtest as before (W/E/M), image comparison via screenshot, time per step (`TI`) |
| 6 | `ENEMYSTEP`, automap via `SETCELL` | Game behavior the same, measure speed |
| 7 | Generalize: D = 4, second wall set, second map, V2 | Demo map with greater view |
| 8 | Blitz! compilation | in VICE and on real hardware |

From step 4 on there is a runnable version of the game after every step.

## 9. Open decisions

1. **Location of the lib:** after the measurements from step 1 (candidates in 3.2).
2. **Map format:** separate step (section 5.1).
