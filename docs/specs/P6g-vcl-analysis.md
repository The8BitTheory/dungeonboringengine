# P6g analysis: cost of VCL execution

As of: 2026-11-25. Review and analysis for P6g (`P6-engine.md`, "Result P6g" and "Addendum review P6g"). Basis: 42 VICE scenes from `test/vice_view.py`, engine 0.2 (standard build, VCL type 9), VDC-BASIC v3 (branch v3, `3fa2bad`), characteristic values `vdc-basic/test/bench/results/{vice3.10,z64k}-20261125.md` (measurement program with VDC-BASIC v2h).

Tool: `test/vice_vclprof.py` (new). In the reference `dbeview` it marks the origin of each VCL entry (wall, tile, band, wallpaper, sprite), splits the list into operations (one VMC/VMF row or one VMS command) and counts the bytes written per window byte. In VICE it stops at `vcl`, `.vcl_next_command`, `.vcl_done`, `.vms_arg_loop` and `.vms_done`. The local labels are not in `vdcbasic3.sym`; they come from the ACME report of a copy that is checked against `vdcbasic3.bin` (`vice_view.vdc_labels`). Measurement uses the monitor stopwatch with the I flag set (without IRQ), port 6634, event-driven. `--static` provides the part without VICE.

## 1. Summary

- VCL costs in VICE **201 600 cycles per frame** (mean; min 68 000, max 389 000 at 1 MHz) and thus 82 % of VIEW + VCL.
- The costs depend on the **number of operations**, hardly on the bytes. VICE charges almost nothing per byte. A VMC row costs 187 cycles (with srcstep 281), a VMS type 1 command 308 and a **VMS type 8 command (half byte) 706**. In addition there are 650–690 cycles of fixed overhead per VCL entry.
- **Walls are 66 %** of the time (cores 37 %, edges 30 %). The edges cost so much because of the type 8 commands on the diagonal edges: 44 per frame, together 31 000 cycles.
- **Overdraw is small:** 7 978 bytes written per frame for 6 720 window bytes (factor 1.19). Operations whose bytes are all overwritten later cost 13 600 cycles (6.7 %). Bands and wallpaper contribute only ≈ 1 700 of that; avoiding it via `bcov` already works.
- **Extrapolation to Z64K:** at 1 MHz ≈ 270 000 cycles (+34 %), at 2 MHz (engine configuration A) ≈ 0.20 s per frame. So 2 MHz brings hardly anything, because the VDC wait times per register access and per byte remain.
- The biggest lever is in **VDC-BASIC**: faster paths for VMS type 8, VMS type 1 and VMC rows save an estimated ≈ 50 % (≈ 100 000 cycles). On the engine and asset side, **"edges on whole bytes"** for walls and tiles follows (no type 8): −37 000 today, −13 000 after the VDC-BASIC optimization. This is a decision about appearance.

## 2. Review P6g (short verdict)

**Acceptable after the corrections.** The test rules are observed: own port with bind test, only the own process (Popen, terminate/kill), breakpoints and debug cartridge instead of wait times. The comparison is meaningful: the entire 64 KB VRAM against a continuously updated model, the window against the independent painter `paint_reference`, the buffers against `dbeview`, MOVE against `dbemove`. `--control` corrupts one byte in the window (`$00FA`) of scene 5; the follow-up run reported exactly this scene.

Corrected (details in `P6-engine.md`, addendum review P6g):

1. **End of the VCL measurement.** `complex_instruction_shared_exit` is the common end of every VMC/VMF and every VMS copy command. The last hit was counted; the I flag was free again from the first entry on, so IRQs were counted as well. Now the measurement ends at `.vcl_done`. VCL dropped from 211 200 to 200 500 (same scenes).
2. **Two scenes had the camera in an occluding cell** ("Window East", "Abyss North"). In "Window East", 1 050 window bytes remained unwritten. The camera now stands in walkable cells; `build_steps` checks this.
3. New table in `P6-engine.md` (run after both corrections, both runs pixel-identical): VIEW 43 150, VCL 201 700, VIEW + VCL 244 900 (mean).

Note on sim65 and VICE: VIEW in VICE is 7 % above sim65. The reasons are the stub and the VIC-II badlines at 1 MHz. At 2 MHz the badlines disappear, therefore the targets from section 8 count as sim65 values. From run to run VCL fluctuates by up to ±3 000.

## 3. Memory map (correction in `P6-engine.md` 2.4)

*Addendum P6h: with `MEMSIZ $4000`, map G applies (`P6-engine.md` 2.4): DMP `$4000`, S2 `$6000`, wall `$8000–$AFFF`; the statements on `$FC00` and the high window remain.*

The Blitz! runtime (Image 2) occupies the shared upper KB `$FC00–$FEFF` (`$D506` = `$0C`). Therefore **all bank 1 data now lie below `$FC00`**:

- DVG `$E800–$EDFF` (1.5 KB), DTS floor `$EE00–$F5FF` (2 KB), DTS ceiling `$F600–$FAFF` (1.25 KB), DBG `$FB00–$FBFF`. Together that is 5 KB instead of 6 KB; dense packing is allowed.
- VCL type 9 lists lie in `$4000–$CFFF` or `$E000–$FBFF`.
- `MEMSIZ` remains `$5000`. Optionally `$4000` lowers the space for variables from 19 to 15 KB and in return frees 4 KB `$4000–$4FFF` for assets (also suitable for type 9).
- Tools: new defaults in `dbetex` (floor `$EE00`, ceiling `$F600`, DBG `$FB00`). Adjust `DEFAULT_DTS_ADDR`/`build_demo_assets` in `dbeview.py` and `run_sim.py`. All tools abort if data extends past the end of the area (at most `$FC00`).

## 4. Breakdown of VCL time

### 4.1 By origin and entry type (VICE, 1 MHz, mean per frame over 42 scenes)

| Category | Entries | Rows | VMS commands (type 1 / 8) | Bytes | Cycles | Share |
|---|---|---|---|---|---|---|
| Wall VMC (cores; 68 rows type 3) | 12.0 | 317 | – | 3 290 | 73 700 | 36.6 % |
| Wall VMS (type 9, edge) | 4.6 | – | 80 / 44 | 202 | 59 700 | 29.6 % |
| Band VMF (gradient, ROWS) | 7.0 | 45 | – | 2 467 | 15 200 | 7.6 % |
| Sprite VMS (type 9, unclipped) | 0.6 | – | 13 / 13 | 33 | 13 900 | 6.9 % |
| Tile VMS (type 9) | 1.8 | – | 12 / 9 | 43 | 11 600 | 5.7 % |
| Wallpaper VMC (panorama, type 3) | 1.1 | 26 | – | 568 | 8 100 | 4.0 % |
| Band VMC (cores) | 3.0 | 17 | – | 855 | 6 100 | 3.0 % |
| Tile VMC (cores) | 2.5 | 12 | – | 165 | 4 000 | 2.0 % |
| Sprite VMC (cores) | 1.3 | 12 | – | 55 | 3 200 | 1.6 % |
| Sprite VMS (type 12, clipped) | 0.1 | – | 2 / 2 (+ type 3) | 7 | 2 300 | 1.1 % |
| Wallpaper VMF (rows above/below the panorama) | 0.7 | 6 | – | 292 | 1 700 | 0.9 % |
| Header (`vcl`, evaluate expression) and end | | | | | 2 000 | 1.0 % |
| **Sum** | **34.6** | **435** | **107 / 68** | **7 978** | **201 600** | |

Examples (cycles in thousands; WK/WR = wall cores/edge, KR = tile edge, BF = band VMF, SR = sprite VMS):

| Scene | VCL | largest items |
|---|---|---|
| Corridor South | 235.5 | WK 97, WR 83, KR 15, BF 13 |
| Room with sky South | 71.8 | WK 32, BF 18, wallpaper 8.5 |
| Window East (window wall d = 1, 11 527 bytes) | 302.9 | WR 145, WK 132 |
| Blob subpositions (5 blobs) | 387.7 | SR 149, WK 95, WR 85 |
| CONTENT door, blobs d = 1 | 389.4 | WR 158, WK 119, SR 60 |
| Turn left (wall directly ahead) | 68.0 | WK 59 |

### 4.2 Elementary costs (VICE; determined from the individual timings)

| Operation | Cycles each | Count per frame | Cycles per frame | Share |
|---|---|---|---|---|
| VMC row type 2 | 187 (bytes ≈ 0) | 279 | 52 100 | 25.9 % |
| VMS command 8 (half byte, read-modify-write) | 706 (537–814) | 68.4 | 48 200 | 23.9 % |
| VMS command 1 (avg. 2.0 bytes) | 308 (260–352) | 107 | 33 100 | 16.4 % |
| VMC row type 3 (srcstep ≠ 0: reset source per row) | 281 | 106 | 29 700 | 14.8 % |
| VCL entry, fixed part (copy parameters, register 24, source) | 646–694 | 34.6 | 18 500 | 9.2 % |
| VMF row (type 5) | 237 | 52.8 | 12 500 | 6.2 % |
| VMS entry, fixed part (type 9/12) | 839 | 7.1 | 6 000 | 3.0 % |
| VMS command 3 (skip source) | 172 | 1.4 | 240 | 0.1 % |

The sum gives 98.9 % (the rest is header and end). Compared with the bench (v2h, C): `vmc_row` 191, `vms1_cmd` 318, `vms8` 661. Type 8 is higher in v3 because the engine edges need two VRAM read accesses and one write access with changing addresses.

### 4.3 Overdraw

- On average 7 978 bytes per frame are written (min 6 720, max 11 527 for the window wall) for 6 720 window bytes (70 × 96): **factor 1.19**. Every window byte is written at least once (after the scene correction), no byte outside.
- Overwritten bytes: 1 258 per frame, of which wall cores 380, band VMF 342, wallpaper 390, band cores 124.
- **Dead operations** (all bytes overwritten later): 36 per frame, 13 600 cycles (6.7 %). Of this, wall cores account for 3 600, wall edge 3 600, tile edge 3 200, sprite edge 1 100, and wallpaper and bands together only 1 700.
- Type 1 commands that adjoin the previous one without a gap: **0**. The converter already merges them; the measure "merge type 1 commands" brings nothing.
- Walls: The wall entries touch 354 image rows, for which 442 operations are output (core rows and edge commands). A representation "one operation per row" saves at most 20 % of the wall operations.

### 4.4 How realistic is VICE? Extrapolation to Z64K

VICE uses a rough busy model for the VDC: copy 1.2, fill 0.66 cycles per byte, so practically free next to 190–700 cycles of CPU per operation. Z64K (more accurate, but not yet a hardware value) yields at 1 MHz (configuration C) `vmc_byte` 5.4, `vms1_byte` 7.0, `vmc_row` 230 (VICE 191), `vms8` 751 (661) and `fill_fixed` 295 (76) at 3.8 per byte. At 2 MHz (A) in µs: VMC row 208 + 2.6/byte, VMS1 209 + 5.2/byte, VMS8 448, fill ≈ 450 + 2.9/byte.

Method: the measured VICE time per entry plus the bench difference Z64K − VICE per call, row, command and byte. For 2 MHz the CPU part enters with the VICE ratio A/C per operation kind (0.5 for calls, 0.65–0.74 for rows and commands). In addition comes the difference Z64K-A − VICE-A.

| | Mean | min | max |
|---|---|---|---|
| VICE, 1 MHz (measured, cycles) | 201 600 | 68 000 | 389 400 |
| Z64K, 1 MHz (extrapolated, cycles) | 270 300 | 114 600 | 477 700 |
| Z64K, 2 MHz (extrapolated, µs) | 201 500 | 83 800 | 344 900 |

Conclusions:

- On real hardware the bytes count. The 8 000 bytes per frame alone cost ≈ 43 000 µs (1 MHz) or ≈ 21 000 µs (2 MHz) in Z64K. Overwritten bytes cost there, not in VICE.
- 2 MHz brings only ≈ 25 %: Every VDC register access waits for the status bit, and the VMS commands consist almost only of register accesses. A frame with VCL realistically needs **0.2–0.35 s** (3–5 frames/s without BASIC).
- Uncertainty: The Z64K characteristic values come from the bitmap mode of the measurement program, not from the chunky mode of the engine (R9 = 1, attributes on, R36 = 0). There the VDC fetches more data for the display and has fewer free memory cycles. The fill characteristic value is not linear in Z64K (bench table 2). The extrapolation is rather a **lower bound**.

## 5. Measures (sorted by benefit/effort)

Savings in VICE cycles per frame (mean 201 600, 1 MHz). The target values per operation are estimates from the number of necessary register accesses (≈ 15–20 cycles per access with status check) plus loop overhead. Z64K column: savings remain fully (CPU-bound) or only partly (VDC-bound).

| # | Measure | Side | Effort | Savings VICE | Z64K/HW | Remark |
|---|---|---|---|---|---|---|
| V1 | **Faster VMS type 8** (706 → ≈ 250): without JSR chain and stack, address register only where necessary, source position via R32/33 instead of separate read accesses | VDC-BASIC | medium | **−31 000 (15 %)** | full | Variant V1b: new VMS command with **byte in the list** (no VRAM read of the source) and separate for left/right half (≈ 150; format and converter change) |
| V3 | **Faster VMC row** (187 → ≈ 110, type 3: 281 → ≈ 150): tight row loop, only R18/R19/R30 per row, source only if srcstep ≠ length | VDC-BASIC | low–medium | **−35 000 (17 %)** | ¾ (with long rows the VDC waits) | also affects `VMC` in BASIC |
| V2 | **Faster VMS type 1** (308 → ≈ 130): per command R18/R19 + R30; source advances in the VDC by itself | VDC-BASIC | low–medium | **−19 000 (9 %)** | full | |
| E2 | **Edges on whole bytes** for wall and tile images (converter option; no type 8): 53 type 8 commands per frame disappear | asset/dbetex | low | −37 000 (18 %); after V1 −13 000 | full | **Appearance:** diagonal edges step in 2-pixel increments. For sprites additionally ≈ −11 000 (scenes with objects considerably more) |
| V4 | **VCL entry fixed part** 650–690 → ≈ 350 (parameters with `lda (zp),y` instead of byte loop with `inc offset`, clear arguments only as far as necessary) | VDC-BASIC | low | −9 000 (4.5 %) | full | |
| V5 | VMF row 237 → ≈ 130 (loop without JSR, only address, byte, R30) | VDC-BASIC | low | −5 600 (3 %) | little (fill is VDC-bound in Z64K) | |
| V6 | VMS entry fixed part 839 → ≈ 450 | VDC-BASIC | low | −2 800 | full | |
| E1 | Output type 3 with srcstep = length as type 2 (16 rows per frame) | engine (lib, reference) or dbetex (write srcstep 0) | very low | −1 500 | full | 2 bytes of VCL less per entry; better in the converter, then the lib remains unchanged |
| E4 | Re-weigh cores in the converter (`core_min`, `max_cores`): more area in core rows, fewer edge commands (core row 187 versus type 1 308) | asset/dbetex | medium (experiments with `vice_vclprof --static`) | estimated −5 000 … −15 000 | full | re-evaluate after V2/V3: then both cost almost the same |
| E3 | Avoid dead operations: tiles, wall parts and sprites that are fully hidden by nearer **side walls of the same depth** (row-accurate occlusion) | engine | high (lib reserve only 248 bytes) | at most −13 600 (6.7 %) | more (bytes count) | "bands/wallpaper only where not hidden" is already implemented (`bcov`), remainder ≈ 1 700: **not worthwhile** |
| A1 | Window width = row pitch (VW 80 or R1 = 70): full rows are contiguous in VRAM, band and wallpaper groups become one block operation | geometry/game | high (layout, HUD) | ≈ −15 000 … −20 000 | more | only if the game layout changes anyway |
| E6 | Merge type 1 commands | converter | – | 0 | – | already implemented (0 candidates) |
| E7 | Row-span format (one copy per image row across core and edge) | VDC-BASIC + engine + converter | high | ≤ 20 % of the wall operations | | evaluate only after V1–V3 |

With V1–V6 together estimated: **VICE ≈ 100 000 cycles per frame** (−50 %). On Z64K 1 MHz that is ≈ 165 000, because the VDC time per byte remains. With E2 in addition one arrives at ≈ 87 000 (VICE).

## 6. Assets

- The demo assets fit neither in the bank 1 areas nor in the VRAM pool (wall 8.7 KB, floor 9.1 KB, ceiling 3.2 KB; VRAM 54 KB against a pool of 36.7 KB). For P7, set an **asset budget**: wall ≤ 8 KB (area `$9000–$AFFF`), floor ≤ 2 KB, ceiling ≤ 1.25 KB, VRAM ≤ pool. Tools report overruns (section 3).
- Type 8 shares are an asset property: Sprites with many semi-transparent edge bytes (blob: avg. 1.5 bytes per type 1 run, 13 type 8 per sprite) cost the most. A report in `dbespr`/`dbetex` with "type 8 commands per image and depth" helps artists.
- Window walls (transparency) generate the highest costs per scene: edge 145 000 in "Window East". E2 pays off most here.

## 7. Recommendation: next steps

1. **VDC-BASIC v3 "P2e: VCL/VMS throughput" (V3, V2, V4, V5, V6, then V1)**. Measure with `test/vice_vclprof.py` (same scenes) and the bench (C and A, VICE and Z64K). Model: **Opus** for design and implementation (cycle-critical 6502 code in shared RAM, check space in `$1C00–$3FFF`), tests and bench runs to **Haiku**.
2. **E1 in the converter** (srcstep 0 when srcstep = width): **Haiku/Sonnet**, check again byte-identical with sim65 and VICE.
3. **Bench in the chunky mode of the engine** (R9 = 1, attributes, R36 = 0) in Z64K and, as soon as possible, on real hardware. Without this measurement the extrapolation remains uncertain. Model: **Sonnet**.
4. After the user's decision: **E2 as converter option** (`dbetex`/`dbespr`, default off), before/after images for the user: **Sonnet**.
5. Tool load addresses and range checks according to 2.4 (section 3): **Haiku**.

## 8. Decision questions for the user

1. **Edges on whole bytes (E2):** May diagonal wall/tile edges (and optionally sprite borders) appear in 2-pixel steps? This saves 18 % (today) or ≈ 13 % after V1.
2. **VDC-BASIC changes:** Approval for P2e (V1–V6)? May V1b extend the VMS format by a command with an embedded byte (converter and engine follow)?
3. **Target clock:** Does the game run in FAST mode (2 MHz)? Then VICE-A/Z64K-A is the yardstick. The VDC time hardly changes, the badlines disappear.
4. **Memory:** Is the default of 5 KB for DVG/floor/ceiling/DBG enough, or should `MEMSIZ` drop to `$4000` (4 KB more for assets, 4 KB less for variables)?
5. **Layout (A1):** Is a window in full row width (VW 80) an option, or does Westwood 140 × 96 remain?
