# Review notes on `plan-0.2.md` (P0, P1, P3, P4)

As of: 2026-11-25. Found while writing the detailed specifications. The plan itself is unchanged; these points are for discussion.

## A. General test rule: VICE monitor port (user requirement)

Applies to all VICE tests of this project (P0 and following) and to the existing `test/vice_drive.py`, which is to adopt the rule (today: port as a mandatory argument, no free choice):

- Port from `--port`, otherwise environment variable `DBE_VICE_PORT`, otherwise **6631** (not 6510 = VICE default). Tests of this project running in parallel use 6631–6649, each test/agent its own port.
- Before starting, check whether the port is free (bind test). If occupied: take the next free one in the range (with a message) or, if the port was explicitly given, abort with a clear message.
- Start VICE explicitly with `-remotemonitor -remotemonitoraddress ip4://127.0.0.1:<port>`; no `-binarymonitor` (if it is needed after all: also its own port).
- Terminate only the process started by the test itself (PID / `Popen`); no `pkill`/`killall x128`/`x64sc`.
- Furthermore: event-driven (breakpoints), no fixed wait times, timeout only as a guard.

Implemented in `vdc-basic/docs/v3/P0-bench.md` section 8.

## B. Render order (plan section 5)

1. **Walls before objects per depth is wrong at inner fronts.** An object in cell (d, ±1) lies behind plane P_d, the front of a block in (d, 0) in front of it; it must occlude the object where they overlap. With "first all walls of depth d, then all objects of depth d", the object paints over the front. In the Westwood preset at 176 × 120: an enemy at "back" in (3, +1) overlaps the front (3, 0) by about 3 pixels, more with wider sprites.
   **Proposal:** per depth, cells from outside to inside, per cell either its surfaces (side, then front) or its contents (objects by subposition). This is the order of EOB (blocks A, G, B, F, C, E, D …) and is exactly right for objects within their cell. The DVG element table (P3, 5.3) is ordered cell by cell and allows both variants. Floor/ceiling/wallpaper remain up front per depth.
2. **The stated "known simplification" does not apply as written:** An object within its cell never lies behind a side surface of the same depth (the side surface lies further out laterally). Errors occur only with objects wider than their cell, and with point 1.
3. **Column mask and objects of the same depth:** The column ranges of the side surfaces of depth d must not clip away objects of the same depth (objects stand in front of them). `VIEW` should enter the occlusion of a depth only after its object slots, except front → side of the same depth (P3, 4.4).

## C. Geometry (P3)

1. **Width a multiple of 4, not just even:** So that the center and all cell edges lie on byte boundaries and all fronts of a depth are equally wide (shared image), width_px must be divisible by 4. 140 and 136 satisfy this.
2. **Budget:** At 140 × 96 a wall style costs about **11.1 KB** (full fronts 6.1 KB, sides 5.0 KB) instead of "about 9–10 KB". This already presupposes that partial fronts (s ≠ 0) are copied from the full front of the same depth (VMC with source increment = full front width, VCL type 3). Without that, 16.3 KB. With a 26 KB pool: 1 wall style + floor and ceiling bands = 16.2 KB, about 10 KB remain for sprites and wallpaper; 2 wall styles + bands = 27.3 KB do not fit. Options: omit sides d = 3, s = ±3 (120 bytes each), 136 × 92 (10.4 KB), or reload wall styles per zone (as planned).
3. **Number of elements:** Westwood yields 79 DVG elements (11 fronts, 14 sides, 18 floors, 18 ceilings, 18 object slots). The tables of the lib (0.1: `MAXWS` = 64) must grow.
4. **VMS buffer:** The edges of the side surfaces need 1–2 commands per row; a side at d = 1 has about 76 rows. If many sides and mixed floor/ceiling tiles are visible at the same time, the sum of the VMS lists can exceed 1.3 KB. The budget report (P3, 9) outputs the upper bound; on overflow P6 should fall back to opaque cores without edge or report an error.
5. **Westwood values are not checked against original data.** P1/P2/P3 planes are reconstructed from memory of the EOB render data and are internally consistent; the P1 top edge (8 instead of model 4) and P4 heights are assumptions. Verify when EOB files (`*.VMP`) become available; the values live only in one table of the preset.
6. **Pixel aspect ratio:** EOB works with DOS pixels (5:6); chunky pixels of the VDC are likewise not square. Proportional scaling carries the ratio over; this fits only roughly. No action needed, but note it for visual acceptance.
7. **Objects at depth 0:** Only "back" (p = 0, 1) and "middle" have foot points in the image; front lies behind the camera. Sprite sets need large images for d = 0; probably it suffices not to draw enemies in the player's own cell (like EOB).

## D. Formats and interfaces

1. **Store subpositions absolutely** (map, object list: NW, NE, SW, SE, middle) and convert them in `VIEW` using the viewing direction (table P4, 2.6). The plan only says "subposition".
2. **One item per cell** in the content layer (6 bits) – the four Westwood slots need more. Proposal: content layer = item at "middle", further ones via the object list. If four slots are to come from the map, a dedicated item list (cell, slot, item) would be better than a wider field.
3. **Object list 16 × 6 bytes** + count = 97 bytes does not fit at the current location `$0C10` (it would overwrite the test area `$0C40–$0C4F`). Relocate in P6, e.g. `$0C50–$0CB0` (reserve) or into the buffer at `$1300`.
4. **Style numbers:** DMP uses 0 = nothing, n = DTS style n − 1; DTS (P5) uses `$FF` = style 0 as a substitute for missing images. Both fit together, but must be adopted exactly like this in P5.
5. **OCCLUDING twice:** Occlusion only if tile flag OCCLUDING **and** the image in the DTS is occluding (window, grille). The DVG core is the geometrically largest; DTS images with their own transparency need their own core or the flag "not occluding" (P5).
6. **Bands with gaps:** Cells with an occluding block (four wall styles, OCCLUDING) are not a gap in the floor/ceiling band, even if their floor is 0 (P4, 2.4); otherwise wallpaper would be drawn unnecessarily.
7. **`RXV` interface (P2b):** Proposal: `RXV src,dst` with src = start of stream (file header skipped by BASIC, `BE+5`), so that embedded streams (DTS) work without a header. Alternatively two forms; decide in P2b.
8. **Threshold T patchable:** T from VICE is not transferable (P0, section 2). `RXV` should read T from a documented byte (e.g. via `POKE` or fake register via `RGW`), default from the measurement on real hardware.
9. **Crawl port (P7): gems appear twice in the map.** `crawlmap` stores a gem as tile 2 **and** as item 2. `crawl.bas` 5500 sets the cell value to 0 on collecting, 5360 checks `V%=2`. When collecting, the port must delete the item and set the tile to 0 (lib function for tile change) or switch the check to the item, otherwise the same gem is counted multiple times. Likewise the exit (5550: 40 → 42) needs the tile change; `crawlmap` therefore always creates tile 42.

## E. Measurement (P0)

1. **VICE VDC timing is a rough model** (vdc-mem.c 3.10): 43 clocks busy per reg 31/reg 18/19 access in the visible area, 4 in the border; block fill 0.66 clocks per byte, copy 1.2; reg 36 without effect, no data loss. The plan values "15 cycles per byte" and "about 200 cycles fill fixed cost" are unclear in origin (real hardware or VICE?) and should be replaced with the P0 results.
2. **Provide for measurement on real hardware:** The measurement program runs without a harness on a C128 and saves `BENCHRES` via `BSAVE` (P0, section 11). Only these values count for T and for the reg 36 finding.
3. **Load buffer and memory:** Plan 3 "To check" remains open; the measurement program uses `$2000–$7FFF` in bank 0 and runs with v2h at `$1300`, so it does not collide with the v3 relocation.

## F. Textures (P5)

Found while writing `P5-textures.md`.

1. **DTS needs two files.** `RXV` reads from bank 0, the engine reads its metadata from bank 1. The plan ("The image data lies in a VRL stream") leaves open whether the stream is inside the DTS. P5 decides: `<name>.dts` (bank 1) + `<name>.vrl` (bank 0, load buffer, free afterwards); likewise DBG. The load buffer in bank 0 must hold the largest VRL (wall style raw about 11 KB, packed less) – this aggravates the open point "game's load buffer" (plan 3).
2. **Partial fronts with transparency (re C.2).** Copying via `VMC` with source increment applies only to cores. `VMS` reads the packed source strictly sequentially and cannot skip bytes; the edge of a non-occluding front (window, grille) needs its own packed edge bytes and its own VMS list per partial front. The P3 budget (partial fronts 0 bytes) applies only to opaque fronts.
3. **VMS type 8 compares only the right nibble** with the alpha value. A half byte with a transparent left pixel must not have the alpha color on the right. P5 chooses alpha per list (smallest unused color); Crawl managed with alpha 0 because black was background there.
4. **Cores come from the DTS, not from the DVG.** A painted image can have its own transparency in the DVG core. P5 stores up to 4 cores per image (VCL type 2/3) plus edge; P6 draws according to the DTS. The VCL list grows as a result (up to 4 × 11–13 bytes per image instead of 11) – recalculate in P6 given the size of the VCL buffer (plan 3: about 1 KB).
5. **VRL load address `$2000` (P1, 3) lies inside VDC-BASIC v3** (`$1C00–$3FFF`, plan 3). Harmless as long as loading is done with `BLOAD …,P(BE)`, but misleading as a default. Proposal: default `$4000` or document as meaningless; P5 uses `vrl_load = $4000`.
6. **Memory map for bank 1 is missing.** DVG `$E400`, DMP `$8000`, SPR v1 `$E200`/`$EA00`, lib from `$C000`; DTS (up to three per zone, wall DTS with several styles 1–3 KB) and DBG need fixed places. P5 provisionally takes `$A000` (wall) and `$A900` (DBG) as a default; P6 should define the memory map.
7. **Geometry ID contained `origin`** (done: since P3 5.5 `origin` no longer flows into the ID; DVG header unchanged). DTS and DBG depend on stride, rectangles and masks, not on the position of the window in the buffer; the ID now describes the shape, not the position.
8. **Sprites cannot be clipped at the window edge** (affects P5b/P6, plan 5 names only too-wide sprites as an error source). SPR v1 had matching parts per (d, s); a position-independent image at s = ±1 sticks out of the window and `VMS` then writes into the HUD or the neighboring row. Options in `P5-textures.md` 11.
9. **Budget for sprites (re C.2):** After a wall style, floor and ceiling style, about 10 KB remain; an enemy with 4 viewing angles × 2 phases × 3 depths needs roughly 6–9 KB. Row fill for single-color bands (P5, 5.6) saves up to 5 KB, but is not enough for several enemy types at the same time – asset planning per zone is necessary.

## G. Sprites and engine (P5b, P6)

Found while writing `P5b-sprites.md` and `P6-engine.md`. The consequences are incorporated there; changes to P3/P4/P5 are implemented by P6h and P5b respectively (P6 11).

1. **Bank 1 memory map (re F.6):** The demo wall DTS with 4 styles has 8 736 bytes (`docs/specs/examples/tex/demo_walls.tex.md`) and does not fit in the default `$A000–$A8FF` in front of the DBG at `$A900`. P6 2.4 defines memory map F: DMP `$5000`, S2 `$7000`, DTS wall `$9000`, lib `$B000–$CFFF`, lib BSS `$E000`, DVG `$E800`, DTS floor `$F000`, ceiling `$F800`, DBG `$FE00`; BASIC variables up to `$4FFF`. The default load addresses of the tools change accordingly.
2. **Grille and VMS buffer (re C.4, F.4):** With `max_cores` = 4 the grille full front d = 1 has a VMS list of 1 467 bytes (larger than the planned VMS buffer), sum of all grille images 5 145 bytes. Measurement with the P5 example and higher `max_cores`: 8 → largest list 891, sum 4 041; **16 → 371, sum 3 214** (NK of the DTS 154 ≤ 255); 32 brings hardly any more (the rest are half bytes at the bar edges, type 8). Proposal (P6 11): `max_cores` 0 … 16 in DTS and S2; the engine knows no fixed limit except the buffer. Cost: 11–13 bytes of VCL per core instead of edge lists.
3. **One buffer for VCL and VMS:** Instead of fixed parts (1 KB VCL + 1.3 KB VMS, together more than `$1300–$1BFF` = 2 304 bytes), the VMS lists lie directly behind the VCL list; the size calculation in the visibility pass is exact (P6 5.10). `dbetex` will in future check "VCL + VMS per image" against 2 304 instead of only VMS against 1 300. Overflow: omit edge (A = 3) or truncate at the end (A = 2).
4. **Lib size:** Estimated about 5 KB code and 1.4 KB variables (P6 2.6); `$C000–$CFFF` is not enough. P6 places the lib at `$B000–$CFFF` (jump table `$B000`, the stub jumps there) and the variables at `$E000–$E7FF`.
5. **Fronts and bands of the same depth:** An occluding front (d, s) overpaints the floor and ceiling bands of its depth only if its rectangle contains the band rows. In the plane geometry (P3) this always holds, in a freely generated DVG (Crawl, P7) it does not. Proposal: DVG flag **bit 3 "band coverage"** (previously reserved 0; changes the geometry ID of the examples). For this `VIEW` keeps a second column mask for bands/wallpaper (P6 5.1, 5.2).
6. **Crawl port without WALLSET:** The Crawl wall images do not follow a plane geometry; the cells (2, ±1) and (3, ±1) each have two front images (slots 8/9, 11/12, 15/16, 18/19 in `wallconv.py`). Proposal: P7 converter writes a Crawl DVG directly (several elements per cell, anchors such that the ghosts land at the Crawl columns), a DTS from cores only, and S2 sets. The 0.1 functions `WALLSET`/sprite sets v1 are dropped in 0.2 (A = 255 or E_FORMAT). An alternative would be a compatibility path in the lib (about 1 KB of code).
7. **Format rule for VMS lists:** Clipping in `VIEW` presupposes that the commands appear row by row with increasing ofs and that a run does not leave its row (ofs mod stride = column, image width ≤ stride). `pack_image` produces this; the formats (P5 4.6, P5b 4.6) should explicitly require it.
8. **Sprites taller than the wall:** `VIEW` clips sprites only by columns. An occlusion applies to the rows of plane P_{d+1}; whatever of a sprite protrudes above the top edge of the wall in front of it would be clipped away as well. P5b warns on import; the pixel check in P6 rules out such scenes.
9. **`sim_vms` does not know type 3** (P5 7.2): P5b adds it; the Python VCL interpreter in `dbeview` needs it as well.
10. **Default load addresses** in P3 (`$E400`), P4 (`$8000`), P5 (`$A000`, `$A900`) follow the new memory map (G.1).
11. **Outside the map in 0.1:** `VIEW` 0.1 checked only the cell index against W·H; cells beyond the left/right edge ran into the neighboring row. Harmless for Crawl (border walls), for 0.2 `VIEW` computes with x/y bounds (P6 5.1). Crawl pixel identity (P7) may therefore deviate at map edges if Crawl itself "wraps around" there – check during the port.
12. **System buffers:** `$0B00` (cassette/boot sector), `$0C00–$0DFF` (RS-232) and `$0E00–$0FFF` (VIC sprites) have been used by the engine since 0.1; games must not use RS-232 and VIC sprites. Document (P8).
13. **Truncation in the error case:** If `VIEW` aborts because of a full buffer, the rear parts are missing; because bands and wallpaper of a depth come after its cells in the visibility list, whole rows then remain undrawn. Deliberately treated as an error state (A = 2); `dbeview budget` measures scenes beforehand.
14. **Objects in cells with surfaces** (door, grille with item) are not drawn according to plan 5. If items are to appear in door cells, the tile would need a flag "show content".
15. **Blitz! variables in bank 1** (location, upper limit `$39/$3A`) are unchecked for memory map F → P6a.
16. **Correction to P2a 4:** "Set the BASIC variable start in bank 1 to ≥ `$2000`" is not necessary. The 8 KB common RAM is switched on only during a lib call; the restriction affects only engine data in bank 1 (not below `$2000`).
