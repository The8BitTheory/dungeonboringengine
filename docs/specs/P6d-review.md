# P6d review: VIEW without objects – correctness, cycles, memory, next steps

As of: 2026-11-25. Review (Opus) of commit `793a273` (branch `step2/textures-0.2`): `engine/view.s`, `engine/lib.s`, `tools/dbeview.py`, `test/sim/run_sim.py`, specification `P6-engine.md` (sections 2, 5, 7, 8, "Result P6d"). Nothing changed, nothing committed. `python3 test/sim/run_sim.py` is green (1302 views byte-identical, cycles as in the result P6d).

Measurement basis: own profiler (`prof6502.py`, cycles per PC, grouping by labels and source lines), demo assets 140 × 96 (VW 70, D 3, S 3, NE 79), scenes like `test_p6d`. The values in parentheses are means per view.

## 1. Review: correctness risks outside the tests

### 1.1 Findings (by weight)

| # | Risk | Effect | Proposal |
|---|---|---|---|
| K1 | **`BUFSET` permits buffers from `$0200`.** Bank 0 `$0200–$0AFF` contains input buffers, Kernal vectors (`$0314` IRQ) and system variables, `$0C00–$0DFF` parameter block and stub, `$1000–$12FF` function keys, BASIC sprite and BASIC 7 work memory. A game with `BUFSET 512,…` overwrites the IRQ vector at the next `VIEW` → crash. | system hangs | `BUFSET` only in permitted windows: `$1300 ≤ B0` (default), optionally `$0B00–$0BFF` and `$0E00–$0FFF` as separate windows (if the user releases them, 3.4). Adjust specification 3/3.3. |
| K2 | **`GEOMSET` does not check the element table.** Only the header and the limits VW/VH/D/S/NE are checked. Not checked: `first + n ≤ NE` per depth, kind ≤ 4, `e.d` = depth, `|e.s| ≤ S`, `x + w ≤ VW`, `c0 ≤ c1 ≤ VW`, `y + h ≤ VH`, contiguous cells (P3 5.3), at most one floor/ceiling element per cell. Consequences of a wrong or swapped file: `mark_c`/`mark_b` with `c1 > VW` write ones beyond `cover`/`bcov` into `dcy0…`, `pd_*`, `gr_*` (BSS corruption). Non-contiguous cells yield more than 31 groups; `vband` then reads the values of `gr_*[31]` for all groups from 31 on (`@gx: ldx #MAXGRP-1`), i.e. wrong band decisions instead of `E_FORMAT` (the reference raises `ViewError`). | silent wrong images, BSS corruption | One-time check in `GEOMSET` (≈ 150 B code, one-time runtime). After that the fallback paths `bmulti`/`bit0`/`bitn` scan and `MAXGRP` checks in `VIEW` become unnecessary (≈ 150 B less code). |
| K3 | **Pending area of 16 entries per depth** is only a runtime limit (`A = 2`). The reference knows no limit → on overflow no more byte identity. Measured: at most 6 occupied slots in all 800 random scenes (both bit 3 variants, `double_fronts`). Upper bound per depth = number of sides with DVG bit 0 plus fronts with bit 0 without bit 3. Demo with `double_fronts` without bit 3: depth 3 = 6 sides + 10 fronts = **exactly 16**. A Crawl-like DVG with larger S exceeds that. | A = 2 without need, deviation from the reference | `GEOMSET` counts these elements per depth and gives `A = 1` at > 16 (limit in section 7, reference `parse_dvg` the same). After that `VIEW` can never overflow; the runtime branch is dropped. Test: DVG with 16 (ok) and 17 (A = 1). |
| K4 | **`MAXITEM = 96` is untested.** At most 41 entries in all random scenes (also with `double_fronts`). The STOP path from `itemadd` (A = 2 without buffer overflow) is only reached via the buffer. | untested path | Synthetic scene: large buffer (`BUFSET` up to `$1BFF`), many small entries (e.g. wallpaper in many spans, tiles with `max_cores` 16) or provisionally `MAXITEM` small via `--asm-define`. With single-pass generation (2.3, M2) only the counter remains. |
| K5 | **Asset addresses below `$2000` are not rejected.** `TEXSET`/`BGSET`/`SPRITESET`/`GEOMSET`/`MAPINIT` (except working copy) accept any address; below `$2000` the lib reads bank 0 (shared RAM). Likewise overlap with lib (`$B000–$CFFF`) and BSS (`$E000–$E7FF`). | silent wrong images | Common check "data in `$2000 … $FEFF`, not in lib/BSS" (A = 6), ≈ 30 B. Low priority. |
| K6 | `clipvms_e`: row counter `cr` is 8 bits (`inc cr; bne @rw`). With offsets ≥ 256 · stride (only with a broken list or stride < 64) it overflows and the clip becomes wrong. | broken data only | Check in P6e (sprites have smaller heights); if necessary test `cr ≥ B` before incrementing. |
| K7 | Comment in `velem` ("rejected changes nothing about the occlusion") is misleading: even a discarded entry (`@drop`, v = 7 with edge) marks `cover` afterwards. This corresponds to the reference (it ignores the return value of `add`). Can only occur with OCCLUDING images without cores (tool error). | none | Make the comment more precise; `dbetex` should forbid OCCLUDING without a core. |

### 1.2 Checked and fine

- **Zero page:** `VIEW` uses only `ZP0`/`ZP1` (`$FA–$FD`); `vstop` restores the stack pointer, `ZP0` is set anew in `vout`; in count mode `clipvms_e` does not change `ZP0`. Self-modifying code only in `vcopy` (bank 1 RAM), interrupt-safe.
- **Bank 1 accesses:** all data via `(ZP),y` in bank 1; writing only into the buffer (shared RAM) and into `$0C0A–$0C11`. Cells outside the map (fixed axis via `dout`, side axis via `a0 + as`, 16 bits sign-correct) fall back to the outer tile.
- **Limits:** `cover`/`bcov` with 81 bytes (sentinel at VW), `allcov` at w = 0 → "occupied" like `all([])`; `resolve` index `kind · 32 + st < 96`; `spans` with > 4 runs; `bgq` terminates for P ≥ 1; nv/nm 16 bits; `X` saturates at 255.
- **Count and write mode** run through the same code; the tests cover edge omitted (A = 3), discarding and STOP via the buffer.
- **IRQ during `VIEW`:** no Kernal calls, I/O not touched; the long call is already checked in the VICE smoke test (jiffy clock).

## 2. Root-cause analysis of the cycles

### 2.1 Measured values

| Set | Mean | max | Entries visibility list | VCL entries | VMS bytes |
|---|---|---|---|---|---|
| corridor (whole set, sim65) | 90 696 | 106 247 | 5–17 | 6–39 | 0–690 |
| corridor, cheapest view (wall at depth 1) | 29 998 | – | 5 | 6 | 0 |
| random (40 scenes) | 106 806 | 143 712 | 13–29 | 24–56 | 123–1 763 |

Even the cheapest corridor view costs 30 000 cycles for 6 VCL entries. One entry of the visibility list costs on average **about 6 000 cycles**. The bulk is caused by traversal and management, not by the output.

Profile corridor (16 views, 81 619 cycles): `vcells` 10 665, `gent0` 7 907, `vcell` 5 991, `vcopy` 5 355, `vband` 4 783, `velem` 3 997, `spans` 3 944, `itemadd` 3 583, `resolve` 3 245, `gwall` 3 040, `fillrows` 2 805, `mark_c` 2 170, `emit_vmc` 2 163, `allcov_c` 2 144, `clipcores` 1 982, `bitn` 1 900, `f_view` 1 635, `dstxy` 1 516, `vout` 1 349, `mark_b` 1 280, `bgoffs` 831.
Profile random: `vcopy` 17 143 (max. scene 29 862 = **21 %**), `vcells` 11 830, `gent0` 10 322, `vband` 9 441, `gwall` 6 405, `vcell` 6 167, `itemadd` 5 762, `bitn` 3 684.

### 2.2 Where too much happens algorithmically

1. **Every element of every depth is touched twice, most of them in vain.** `vcells` reads kind and s per element (group formation, remember floor/ceiling element), then the pass calls `velem` for every element. Of 79 elements only 25 are walls; floor, ceiling and object slots are read and discarded. The source lines show about 60 cycles per element in the scan and about 60 in the pass (16-bit pointer advance by 16, `ldy #0/lda (ZP0),y/cmp`, `inc ecur`, `dec ecnt`). The group structure is fixed for a DVG and could be computed once at `GEOMSET`.
2. **Cell computation about 330 cycles per cell:** cell index via a loop `as` times `± W` (for E/W up to 15 additions of 20 cycles each), tile pointer 8 · t, **copy of all 7 tile bytes** (~100 cycles), `faces`/`blocked`. A table `rtab[s] = s · R` per `VIEW` (or at `SETPOS`) turns this into a 16-bit addition.
3. **"Generator pre-run" = every entry is generated twice.** Once in count mode in `itemadd`, once in write mode in `vout`. Both times `gent0` copies 14 bytes of the directory entry (~300 cycles per call) and runs through the cores. In count mode, for unclipped walls, ROWS bands and wallpaper only constants or simple formulas are computed, and that with the full generator machinery. In addition there is the handover via the 7 fields `g_*` → `it_*` → `g_*`. In total about 9 000 (corridor) or 13 000 (random).
4. **Band decision as its own pass per kind:** `vband` runs per depth for floor and ceiling over all cells (`bit0`/`bitn`, classification don't-care/gap/style), although `vcell` has just read the same data. With uniform bands (corridor) the second pass is unnecessary.
5. **Column masks byte by byte with expensive loops:** `mark_c` 28 cycles per column (because of `inc ncov` for the abort condition), `mark_b` 17, `spans` ~13 (with `cpx dvg_vw` per column). An occluding front across 70 columns costs 2 000 cycles for `mark_c` alone. Corridor: about 4 recomputations of `spans` at 950 each.
6. **`bgoffs`:** a 16-bit division (o_v mod P) at every `VIEW`, 831 cycles, although it depends only on the DBG and v.
7. **Absolute addressing everywhere:** Only two pointers in zero page. That forces constant reloading (`gp → ZP0`, `fsrc → ZP1`, `vclsv`), every access costs 1 cycle and 1 byte more. This explains part of the code size (5.6 KB instead of the estimated 3 KB).
8. **`vcopy`** 17 cycles per VMS byte (`lda abs,y / sta abs,y / iny / dex / bne`). That is not wrong, but in random it is the largest single item. Without the copy (lists from bank 1 or resident) it disappears completely.

The 16-bit arithmetic that can be made 8-bit via a table: cell index (`rtab`), element/cell pointer (from the cell table instead of `elp` = 16 · i), `bgoffs` (table at `BGSET`). `dstxy` already uses the row table; `resolve` (16 · b) is cheap enough.

### 2.3 Measures (sorted by benefit/effort)

Savings per view, estimated from the profile (corridor 81 600 and random 107 000 as basis). The items overlap partly (ZP also makes the others cheaper), so the sum is therefore an upper bound.

| # | Measure | Corridor | random | Effort | Code / BSS |
|---|---|---|---|---|---|
| **M1** | **Cell table at `GEOMSET`** (together with K2): per depth the cells with s, pointer to the first element, number of wall elements (DVG order), object, floor, ceiling element, column hull [x0, x1) of the walls. `VIEW` runs only over cells and their walls; cell index via `rtab[s]` (16 bits, once per `VIEW`); tile bytes directly via `(ZP),y` instead of a copy; **`allcov` before `resolve`** and skip the cell if its hull is fully occupied in `cover` (still read tile data for the bands). | −13 000 … −15 000 | −13 000 | medium | Code ±0 (GEOMSET +200, VIEW −250, fallback paths gone); BSS +6–8 B per cell (limit e.g. 64 cells → ≤ 512 B; demo 18) |
| **M2** | **Single-pass generation** (recommended, requires an API decision, 5 F2): Every accepted entry is written immediately. VCL entries **downward from B1** (end byte first), VMS lists **upward from B0**; VCLADR = end of the downward writing (variable, P0 already supplies it). Within an entry the order of the VCL entries reverses. This is pixel-identical because cores and edge are disjoint (P5 4.4 "order is free"); the same applies to ROWS groups and wallpaper parts. Overflow check: fast path if the free space holds the upper bound of the entry (cores · 13 + 7 + vlen, clipped + 3 per command); otherwise slow path with the existing count mode and the rule from 5.10. Visibility list, `vout`, second `gent0` and `g_*/it_*` reloading are dropped. | −9 000 | −13 000 | medium to high (adapt reference and harness) | Code −150 … −300; **BSS −680** |
| M2′ | Alternative without API change: **sizes without generators.** Wall/tile: v from the directory entry (DTS byte 15, precomputed by `dbetex`: core bytes + 7 for EDGE; ≤ 16 · 13 + 7 = 215), m = vlen; ROWS band: v constant per image (group count, independent of c0/c1); wallpaper: formula. Count mode only for clipped band images (and sprites in P6e). | −6 000 | −9 000 | low to medium (DTS format, `dbetex`) | Code −100; BSS ±0 (visibility list remains, P6e then needs +300–500 B BSS for sprite fields) |
| **M3** | **Band decision in the cell pass:** `vcell` classifies floor and ceiling of the cell immediately (don't-care/gap/style) and keeps per depth live/gap/mix/st1 as well as st0 (first style with a resolvable band image; `resolve` only for a new style). `vband` then only does the tile pass (for mixed/gap) and the spans. | −5 000 | −6 000 | low to medium | Code −150 |
| **M4** | **Zero-page block during `VIEW`** (save and restore 16–24 bytes, ≈ 450 cycles): 4–6 pointers (element, cell, tile, source, VCL, VMS) and the hottest counters. Generators read the directory entry directly via `(ZP),y` (no 14-byte copy), `putb0`/`put_dst` inline. | −5 000 … −7 000 | −8 000 | medium (mechanical, broad) | **Code −0.6 … −1 KB** |
| **M5** | **Masks:** `mark_c` without `ncov` (abort test "cover fully occupied" once at depth end, terminates at the first free column), 13 cycles per column; `spans` with sentinel in `bcov[VW]` (two tight loops); `mark_b` with ZP limit. Optionally `spans` incremental (free runs as a list, `mark_b` cuts out). | −3 000 … −4 000 | −2 000 | low | ±0 |
| **M6** | **`bgoffs` at `BGSET`** for all 4 directions (8 B BSS) or `dbetex` guarantees o_v < P (then the division disappears entirely). | −830 | −830 | trivial | Code −60 |
| **M7** | **`vcopy` unrolled** (4 bytes per loop, ≈ 12.5 instead of 17 cycles per byte). | −1 300 | −4 000 (max −7 000) | trivial | +30 B |
| **M8** | **VMS lists without copy** (user decision, 5 F4): VDC-BASIC v3 executes unclipped VMS lists directly from bank 1 (new VCL type or bank bit in type 12; the VMS loop lies in `$1C00–$1FFF`, i.e. in shared RAM, and switches `$D506`/`$FF00` for the duration of a list like the stub). Alternatively resident lists in bank 0 (plan 12.2, needs several KB of bank 0). Only clipped lists are still written into the buffer. | −5 000 (max −12 000) | −17 000 (max −30 000) | medium, second repo | Engine code −100; **buffer relieved** (random: 10–15 % of the scenes today have A = 2 because of the buffer) |
| M9 | Precompute cell pointers per (d, s) at `SETPOS`/`MAPINIT` (2 B per cell). Worthwhile if the game repeats `VIEW` without movement (objects, P6e). | −1 000 | −1 000 | low | BSS +2 B per cell |

Order by benefit/effort: **M1, M3, M5, M6** (together about −22 000, without format change), then **M2** (or M2′), then **M4**, M7 (dropped with M8), M9.

### 2.4 Is the target achievable?

Bottom-up calculation for a typical corridor view (13 entries, 23 VCL entries, 250 VCL bytes, 156 VMS bytes) with a good implementation: output about 4 000, VMS copy 2 700 (with M7 2 000), 18 cells at 120 and 25 walls at 100 ≈ 4 700, bands 2 000, spans 1 600, rest 2 000, together **17 000–22 000**. Top-down (profile minus M1–M7) one lands at about 40 000–45 000, because the items overlap and remainders stay. Realistically after P6d-opt:

| Case | Target (section 8) | expected with M1–M7 | with M8 in addition |
|---|---|---|---|
| Corridor mean | ≤ 30 000 | 35 000–45 000 | 30 000–38 000 |
| Corridor max (690 VMS bytes) | ≤ 45 000 | 50 000–60 000 | 40 000–48 000 |
| random max (1 760 VMS bytes) | ≤ 80 000 | 90 000–105 000 | 65 000–80 000 |

**Assessment:** The targets from section 8 are reliably achievable only with M8 (VMS without copy); without M8 they narrowly fail (the copy alone costs 30 000 in the largest random scene). Proposal for the acceptance of P6d-opt **without M8**: corridor mean ≤ 40 000, max ≤ 55 000, random max ≤ 100 000. **With M8** the original targets 30 000 / 45 000 / 80 000 remain. The targets should additionally be measured against the VDC time of the list (P6g). A corridor view draws about 6 700 window bytes and needs roughly the same order of magnitude of cycles in the VDC; `VIEW` should not cost more than about half of that.

## 3. Memory plan for P6e and optimizations

### 3.1 Demand

| | today | after P6d-opt (M1–M6, M2) estimated | P6e additionally | P6f (MOVE, automap) |
|---|---|---|---|---|
| Code (8 192) | 7 960 | 6 600–7 000 | +700 … +1 000 (candidates, sorting, `lookup`, anchor, column clipping, OBJVIS; `clipcores`/`clipvms_e` are reused) | +300 … +500 |
| BSS (2 048) | 1 993 | 1 450–1 600 (−680 visibility list, +300–500 cell table, −160 `gr_*`) | +40–80 with M2; **+300–500 without M2** (sprite fields x0/y0 16 bits, cy0/cy1, set in the visibility list) | +10 |

Without a change to the memory map, even after the optimization it is only just enough, without reserve for P6f and P7.

### 3.2 Options

| Option | Content | Gain | Risk/cost | Decision |
|---|---|---|---|---|
| **A: Lib with `$FF00 = $7F`** | Stub switches bank 1 **without I/O** (`CR_LIB = $7F` instead of `$7E`). The lib uses no I/O (checked: only test function 250 reads `$D506`; it switches briefly for that). Then bank 1 RAM `$D000–$DFFF` is usable: **code `$B000–$DFFF` = 12 KB**, BSS stays `$E000`. `BLOAD` to bank 1 (BASIC `BANK 1` = `$7F`) writes into the RAM under I/O. IRQ/NMI run via the switch in bank 1, which itself sets `$FF00 = 0`. | +4 KB code, no asset area reduced | Stub 1 byte, `lib.cfg`, adapt smoke test (`$FF00` expectation, BLOAD across `$D000`, jiffy clock); games must not use bank 1 `$D000–$DFFF` otherwise (previously free) | **User** (memory map 2.4) |
| B: Single pass (M2) | Visibility list dropped | −680 B BSS, −150…300 B code | API: VCLADR variable | User (F2) |
| C: Zero-page block (M4) | save/restore 16–24 B, e.g. `$63–$72` (FAC/ARG of the interpreter) | −0.6…1 KB code, −5 % cycles | Conflict only with code that runs **during** the call = IRQ/NMI. Kernal IRQ uses `$A0–$A2`, keyboard `$D0–$D9`; VDC-BASIC (`$0A–$0E`, `$16`, `$26–$2A`, `$3F`, `$77`, `$83–$8E`) and Blitz! do not run during `SYS` and are protected by the restore. BASIC 7 IRQ (SOUND, PLAY, MOVSPR, collision) is to be checked. Proof in VICE: watchpoint `store` on the block during a `VIEW` loop with keyboard, SOUND/PLAY and MOVSPR (event-driven). | User (range), Opus (proof) |
| D: Bank 0 `$0B00–$0BFF`, `$0E00–$0FFF` | 768 B in shared RAM for data only during `VIEW` (masks, cell/band state, visibility list) | up to 768 B BSS | Cassette buffer/boot sector or VIC sprites; the game must then not use these areas (80-column game: VIC sprites are taboo anyway) | User |
| E: Shrink asset areas | e.g. DVG 2 KB → 1.5 KB in favor of BSS, DMP 8 → 6 KB | 0.5–2 KB | restricts games | User, **not recommended** |
| F: Tables in the buffer `$1300` | – | – | The buffer is the output; with M2 both ends grow toward each other, no fixed free part | rejected |
| G: Relocate zero page via MMU (`$D507/$D508`) | zero page into a bank 1 page | whole page ZP | Kernal IRQ would use the relocated page (jiffy, keyboard); safe only with its own IRQ shell (forge return frame) | rejected (too delicate) |

### 3.3 Recommendation

1. **Option A now** (before P6d-opt): It costs one byte in the stub and a few test adjustments and ends the space pressure for P6e, P6f and P7, without the game giving up asset area. The optimization can then be guided by cycles instead of bytes.
2. **M2 (single pass)**, if the user accepts VCLADR variable: This saves the most BSS and cycles, and P6e then needs no sprite fields in a visibility list. Otherwise M2′.
3. **Option C** only after the VICE proof. Without C the code only becomes smaller through the structure (M1–M3), which suffices with A.
4. D and E not necessary as long as A holds. D remains the reserve for BSS if the cell table or P6e need more than expected.

### 3.4 User decisions (memory)

- memory map 2.4: lib code up to `$DFFF`, stub with `$FF00 = $7F` (A)?
- May the engine use bank 0 `$0B00–$0BFF`/`$0E00–$0FFF` as work area (D) or as a buffer window for `BUFSET` (K1)?
- Zero-page block for `VIEW` (C): which range is taboo for the game and its own IRQ routines?

## 4. Proposal: split of the next work

**P6d-opt before P6e.** Reasons: (1) P6e depends on the structure (visibility list yes/no, ZP pointers, cell table with object element and cell index); after P6e one would have to rebuild the object logic as well. (2) Without space (A or optimization) P6e cannot be built. (3) Byte identity with the reference is the safety net for the rebuild; it only becomes more complicated with P6e.

| Step | Content | Acceptance | Model |
|---|---|---|---|
| **P6d-0** Decisions | User questions 5 F1–F5; update specification (sections 2.4, 3, 5.10/5.11, 7, 8) | Decisions in the spec | Opus (main agent) with user |
| **P6d-1** Framework | Option A (stub `$7F`, `lib.cfg` 12 KB, smoke test); K1 (`BUFSET` window), K2/K3 (GEOMSET checks incl. pending area ≤ 16, ≤ 1 floor/ceiling per cell, cells contiguous) in lib **and** `dbeview.parse_dvg`; tests for the new error cases | sim green, byte-identical; VICE smoke test green | Sonnet (clearly delineated), review Opus |
| **P6d-2** Reference | for M2: `dbeview.output` with VCL downward from B1 / VMS from B0, entry order reversed per entry; pixel check `run_vcl` = `paint_reference` remains green; harness reads [B0, B0 + nm) and [VCLADR, B1). For M2′: `dbetex` byte 15 | Python tests green | Sonnet |
| **P6d-opt** 6502 | M1, M3, M5, M6, M2 (or M2′), M4 (if C is released), M7; K4 test (MAXITEM) | **byte-identical** as P6d (all sets, also `DBEVIEW_FULL=1`); cycles per 2.4 (without/with M8); code and BSS report; profile per section in the result | **Opus** (time-critical 6502 rebuild with many interactions); measurement runs Haiku |
| P6e | Objects on the new structure | as specification 10 | Opus |
| P6f | MOVE, automap; remaining fine work (M9, `spans` incremental) | as specification 10 | Sonnet |
| M8 (parallel possible) | VDC-BASIC v3: VMS list from bank 1 (branch `v3`), then engine adaptation | VICE test VDC-BASIC; sim byte-identical | Opus (VDC-BASIC assembler), Sonnet (tests) |

Note on the procedure in P6d-opt: First M1 + M3 + M5 + M6 (no format change, immediately measurable, about −22 000), then M2 as its own commit, then M4. After each step byte-identical and with a cycle report, so that regressions can be assigned unambiguously.

## 5. Decision questions for the user

| # | Question | Recommendation |
|---|---|---|
| F1 | memory map: lib runs with `$FF00 = $7F` (bank 1 without I/O), code `$B000–$DFFF` (12 KB) | yes |
| F2 | VCL list no longer fixed at B0, but at VCLADR (= P0 after `VIEW`; game: `::VCL` with this value instead of `4864`) – enables single-pass generation (M2) | yes; otherwise M2′ with DTS byte 15 |
| F3 | Save and use a zero-page block (16–24 bytes, e.g. `$63–$72`) during `VIEW`, after VICE proof | yes, with proof |
| F4 | VMS lists without copy: VDC-BASIC v3 executes lists from bank 1 (or resident lists in bank 0) – bring forward instead of deciding after P6g | yes (VDC-BASIC variant); the only measure that reliably achieves the targets from section 8 and the buffer relief |
| F5 | Cycle targets: without F4 raise to corridor mean ≤ 40 000 / max ≤ 55 000, random max ≤ 100 000; with F4 they stay at 30 000 / 45 000 / 80 000 | as stated |
| F6 | Release bank 0 `$0B00–$0BFF` and `$0E00–$0FFF` for the engine (buffer window, work area) | optional, only as reserve |
| F7 | Restrict `BUFSET` to permitted windows (K1) and new `GEOMSET` limits (≤ 16 occluding sides/fronts without bit 3 per depth, ≤ 64 cells total, ≤ 1 floor/ceiling per cell) | yes |
