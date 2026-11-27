# P6k – Where does `VIEW` in engine 0.2 cost so much per wall part? (analysis, nothing changed)

As of: 2026-11-26, branch `step2/textures-0.2`, HEAD `c78434e` (P6i/P6j). Checked against: `engine/lib.s` sha256 `feb96458…`, `engine/view.s` `e637a55c…`, `engine/dbe.inc` `fe1bd419…`, `build/sim/viewsim.prg` `4f81f699…` (build of 2026-11-26 09:21, newer than all sources). Nothing was changed in the code, in `tools/crawlconv.py` or in tests; measurement data and scripts are in `build/p6k/` (not versioned).

## 1. Method

- **Profiler:** the mini 6502 `prof6502.py` (NMOS, documented opcodes, cycles per PC) runs the real `viewsim.prg` (lib as in the sim65 harness, `test/sim/viewsim.c` replicated: scene file from `run_sim.ViewRunner.setup`, the same setter calls, then `VIEW`). Cycles per PC are assigned to the labels from `build/sim/viewsim.lbl` (nearest preceding global label = "exclusive"; calls via JSR/RTS tracking = "inclusive", plus callers of `allcov_*`/`mark_*`). In addition there are counting points at `itemadd` (entry type 0 wall, 2 wallpaper, 3 sprite) and after `allcov` in `vwall`.
- **Cross-check:** profile sum 26 092 (pos 67, direction 3) against `run_crawl._cycle_job` 26 041; the difference is the approx. 50 cycles for dispatcher/entry (measurement in sim65 is "run with F = 4 minus run with F = 7").
- **Scope:** all 400 Crawl views without a ghost (free cells × 4 directions, `--fix` mode, automap off), mean 16 939 cycles, maximum 26 092. From this a regression (least squares, own routine, no numpy) per routine on the features of the view. In addition 56 views of the demo map (`docs/specs/examples/demo.toml`, `dbeview.build_demo_assets`, walls, grilles, floor/ceiling bands, DBG; without objects); this is **not** the Westwood 140 scene (see section 6).
- Old versions were not re-measured; 0.1 values come from `cmp01.json` of the task, the 0.1 behavior from `git show v0.1:engine/lib.s` (reading the code).

## 2. What "per wall part" in Crawl really contains

The 13 entries of the long views are **not** only walls:

| View | Entries (itemadd) | Depths (`vdepth`) | `vwall` calls | Cycles 0.2 |
|---|---|---|---|---|
| pos 21 direction 0 (wall ahead) | 3 walls | 2 | 6 | 7 441 |
| pos 67 direction 3 | 7 walls, 4 item sprites (gems, type 2 cores 6×6), 1 wallpaper (type 5) | 4 | 10 | 26 092 |
| pos 74 direction 3 | like 67 | 4 | 12 | 25 423 |

The difference "many − few" (18 651) therefore contains 4 additional walls, 4 sprites, 1 wallpaper and 2 additional depths. From the regression over all 400 views (rmse 174 cycles):

`cycles ≈ −594 + 1 337·wall + 2 017·sprite + 549·wallpaper + 125·(discarded wall) + 591·(discarded sprite candidate) + 1 782·depth`

Mean per view: 4.42 accepted walls, 1.77 sprites, 0.72 wallpapers, 4.73 walls discarded by `allcov` (**52 % of all `vwall` calls: 1 894 of 3 660 are discarded by cover, 0 by resolve**), 3.5 depths. The "≈ 1 500 per wall part" are thus ≈ 1 340 per wall, ≈ 2 000 per item and ≈ 1 800 per depth, mixed.

### 2.1 Profile of the three scenes (exclusive, cycles)

| Routine | wall | v67 | v74 | v67 − wall |
|---|---|---|---|---|
| vspr | 0 | 2 542 | 2 236 | 2 542 |
| vobjc | 0 | 2 508 | 1 827 | 2 508 |
| vwall | 1 118 | 2 315 | 2 435 | 1 197 |
| gwall (write cores) | 921 | 2 160 | 2 160 | 1 239 |
| vcells | 979 | 2 074 | 2 132 | 1 095 |
| vdepth | 805 | 1 760 | 1 760 | 955 |
| clipcores | 0 | 1 188 | 1 188 | 1 188 |
| gsetx (+gsetup) | 294 | 1 094 | 1 094 | 800 |
| itemadd | 246 | 1 016 | 1 016 | 770 |
| resolve | 399 | 931 | 931 | 532 |
| allcov_c | 284 | 805 | 945 | 521 |
| mark_b | 297 | 786 | 786 | 489 |
| f_view | 616 | 756 | 756 | 140 |
| cellptr | 340 | 748 | 748 | 408 |
| mark_c | 279 | 748 | 748 | 469 |
| ckwrite | 0 | 520 | 520 | 520 |
| grl | 0 | 448 | 448 | 448 |
| emit_vmc | 0 | 368 | 368 | 368 |
| vneed | 90 | 360 | 360 | 270 |
| vt5 | 0 | 360 | 360 | 360 |
| dstxy | 0 | 293 | 293 | 293 |
| vtap | 88 | 283 | 283 | 195 |
| rtab | 234 | 255 | 255 | 21 |
| gspr | 0 | 240 | 240 | 240 |
| gen | 33 | 183 | 183 | 150 |
| vband | 76 | 152 | 152 | 76 |
| rest | 342 | 1 199 | 1 199 | 857 |
| **Sum** | 7 441 | 26 092 | 25 423 | 18 651 |

(`vspr`, `vobjc`, `clipcores`, `ckwrite`, `grl`, `emit_vmc`, `vt5`, `dstxy`, `gspr` belong to the item sprites and the wallpaper.)

### 2.2 Cost per wall, per routine (regression, all 400 views)

| Routine | Cycles per accepted wall | Remark |
|---|---|---|
| vwall (prologue, field reading, deck, call `allcov`/`mark`) | 320 | of which ≈ 100 allcov test, ≈ 85–95 marks remainder (tail) |
| gwall (write core directly as type 2) | 307 | 11 bytes, 16-bit additions src/dst, `rows` access, `nent` |
| resolve | 133 | slot map → style row → directory; always recomputed |
| gsetx + gsetup | 98 + 14 | VRAM base, start of content, read core count |
| mark_c | 115 | interval list cover |
| mark_b | 121 | interval list bcov |
| itemadd | 82 | save state (svp/smp/snent/isp), `gen` jump |
| allcov_c | 58 | (+ 61 per discarded wall) |
| vneed | 30 | |
| vcells (proportional) | 32 | |
| vdepth (proportional) | 86 | |
| mark_seen | 13 (without automap) | with automap ≈ 57 |
| gen, others | ≈ 25 | |
| **Sum** | ≈ 1 337 | |

0.1 for the same entry ≈ 420: there the wall is a finished 8-byte entry (src, dst, w, h from the table), visibility `col_free` = search for the first free column in the byte array `cover` (usually terminates at the first column, ≈ 30 cycles), mark `cover` = loop over the columns, output = two 16-bit additions (src + `da`, dst + `ap`) and `emit_vmc`. No resolution of style, no core reading, no size calculation (list has the fixed size `MAXVIS`).

### 2.3 Partial profile cover/bcov (the user's question), cycles per view

| Item | Crawl (400 views) | Demo (56 views) |
|---|---|---|
| `vwall`: read rectangle and `allcov` setup (rows up to `jsr allcov_c`) | 313 | 361 |
| `allcov_c` from `vwall` (incl. call; 9.15 or 10.6 calls, each ≈ 55–60) | ≈ 500 | ≈ 640 |
| `mark_c` (fronts immediately + sides via pending area), 117 per call | 451 | 412 |
| `mark_b` (bcov), 123 per call | 477 | 438 |
| pending-area loop in `vdepth` (calls, `pd_*`) | 229 | 304 |
| `vwall` tail (`wocc`, read c0/c1, bit 3, write `pd_*`) | 376 | 458 |
| `allcov_c` from `vspr` (sprites fully hidden) | 154 | – |
| `spans` | 97 | 265 |
| **Sum cover/bcov management** | ≈ 2 360 (14 % of 16 939) | ≈ 2 700 (11 % of 25 081) |

Per accepted wall that is ≈ 535 (Crawl) of ≈ 1 337 cycles, i.e. 40 %. In Crawl the floor and ceiling bands are empty (`fy0 = fy1 = 0`); bcov is needed there only for the horizon wallpaper of depth D (0.72 per view), but is carried along completely.

## 3. Further findings (not wall part, but large)

- **Automap** (MAPINIT X = 1 with working copy, 240 views): +572 cycles per view (+3.3 %), +130 per wall. Of this, `vauto` ≈ 425 per view: the loop over all cells also runs when the depth has no floor rows at all (`gr_fc` remains `$FF` everywhere, in Crawl always), and `mark_seen` ≈ 57 per wall.
- **Item sprites:** 2 017 per accepted sprite plus 591 per discarded candidate, 75 % of the Crawl views have at least one. Breakdown per sprite: vspr 538, vobjc 314, clipcores 297, ckwrite 130, grl 112, gsetx 102, emit_vmc 92, itemadd 90, allcov 60, gspr 60, dstxy 59, vt5 72, vneed 30.
- **Depth:** 1 782 per depth (3.5 depths), including `vcells` 467, `vdepth` 292, vobjc/vspr candidates ≈ 437, `cellptr` 202 (per cell ≈ 74 including call, 9.5 calls per view).
- **Fixed costs:** `f_view` + `rtab` + `vfin` + `vjump` + `dispatch` ≈ 1 000 per view.

## 4. Computable in advance? Static analysis of the geometry

Crawl DVG: D = 3, S = 1, VW = 68, 28 elements (13 fronts, 6 sides, 9 object slots), 11 cells. Demo DVG: D = 3, S = 3, VW = 70, 79 elements, 25 walls.

Minimal sets of occluding elements whose union fully hides the rectangle of an element (order of the visibility pass, fronts immediately, sides only at depth end):

| | Crawl | Demo |
|---|---|---|
| Walls with DVG bit 0 (can occlude) | 18 of 19 | 25 of 25 |
| Elements that can be hidden at all | 16 of 19 | 22 of 25 |
| minimal sets per element | 1–3, **all of size 1** | 1–9, size 1, 2 and 3 |
| Sum of all sets | 30 | 79 |

Column boundaries (all c0/c1 of occluding elements plus 0 and VW; the rectangle edges `x`, `x + w` are all already boundaries):

| | Segments | Bytes as bit mask |
|---|---|---|
| Crawl | 7 | 1 |
| Demo | 13 | 2 |

## 5. Measures

All numbers are estimates from counted code against the measured cycles above (nothing was prototyped); every measure requires the reference check before check-in (section 5.4).

### 5.1 M1 – cover and bcov as segment bit masks (recommendation, replaces the interval lists)

Idea: GEOMSET determines from all c0/c1 of the elements with DVG bit 0 the sorted column boundaries b₀ = 0 < b₁ < … < b_n = VW (n ≤ 16 segments, otherwise GEOMSET error or fallback to the old list). Each segment is a column sequence that is occupied fully or not at all by **every** mark. It follows that cover and bcov are each 1–2 bytes (bit i = segment i occupied), and everything remains exact:

- Mark `[c0, c1)`: `cov |= cm[e]` (per element at GEOMSET time the bit mask of the segments from c0 to c1; 1 byte: `ldy ecur / lda cov / ora cm,y / sta cov` ≈ 15 cycles, 2 bytes ≈ 30).
- `allcov(x, x + w)`: `(cov & rm[e]) == rm[e]` with `rm[e]` = segments that the rectangle intersects (a clipped segment counts fully; an unoccupied segment has no occupied column, an occupied one is fully occupied, so the test is exact). ≈ 15 cycles (1 byte). `ecur` (element index) is computed later in `vwall` anyway and only moved forward.
- Sprites (rectangle [cx0, cx1) arbitrary): table column → segment (VW ≤ 80 bytes) and two small bit-range tables; ≈ 50–60 instead of ≈ 68 cycles.
- cover fully occupied (`vdepth` abort, `ncov == VW`): `cov == full`, 1 comparison instead of the interval check.
- `spans(bcov)`: runs of free bits of the mask, boundaries from the table; same rule (> 4 runs → one run), 1–2 bytes instead of a list run: Crawl ≈ −55, Demo ≈ −150 per view. `vband`/`vtap`/`vauto`/`addrng` read bcov only via the same two routines.
- The pending area (`pd_c0/pd_c1/pd_both`, MAXPEND 16, 48 bytes) becomes a list of element indices (per entry 2 bits for both/only bcov, in the index or separate) that costs two `ora` at depth end.

The marks and their conditions remain **runtime decisions exactly as today**: only what was accepted and satisfies `occ(e, t, ent)` is marked (DVG bit 0 and tile OCCLUDING and `EF_OCCL` of the style from `resolve`). Thus grilles, windows, arches and all styles without OCCLUDING occlude nothing, CONTENT tiles (passes fronts, objects, sides) do not change the order, and the bit 3/`pend` semantics (front with bit 3: bcov immediately, otherwise at depth end; sides: pending area both) remain literally preserved. **The list remains byte-identical** (same entries, same order, same overflow and abort decisions), automap "seen" (`mark_seen` depends on the same discarding) and the discarding of fully hidden sprites remain unchanged because the sets are the same; `dbeview.py` remains the reference without change.

Expected savings (cycles per view):

| Item | Crawl | Demo |
|---|---|---|
| `allcov` test walls (≈ 100 → ≈ 40 per `vwall` call) | −445 | −445 |
| Marking cover + bcov, pending area, `vwall` tail (1 533 → ≈ 280; Demo 1 612 → ≈ 380) | −1 250 | −1 230 |
| Sprite `allcov` | −45 | – |
| `spans`, `allcov_b` in bands | −55 | −175 |
| **Sum** | **≈ −1 800 (−10.6 %, 16 939 → ≈ 15 100)** | **≈ −1 850 (−7.4 %, 25 081 → ≈ 23 200)** |
| per accepted wall | ≈ −410 (1 337 → ≈ 930) | ≈ −300 |

Space: freed are the interval macros (`allcov_c` 41, `allcov_b` 41, `mark_c` 156, `mark_b` 161, `spans` 85 bytes ≈ 480 bytes of code) and BSS (`cv_s/cv_e/bc_s/bc_e` 4 × 41 = 164, `pd_*` 48, `sp_c0/c1` 10 ≈ 220 bytes). New: ≈ 40 bytes per mask in `view.s` plus GEOMSET pass (sort/uniquify boundaries, `cm`/`rm` per element, column → segment, ≈ 150–250 bytes of code) and tables `cm`/`rm` per wall (Crawl 19 × 2 bytes, Demo 25 × 4 bytes; in general NE ≤ 255, but only wall elements ≤ 96 needed) and column → segment (VW ≤ 80 bytes), all in the freed BSS (reserve before 125 bytes, after > 300). The code reserve (today 199 bytes) grows net by ≈ 200–300 bytes; **M1 thus creates the space for M3**. Alternative: compute boundaries and masks in the tool (`dbegeom`) and store them in the DVG (format change of the DVG, saves the GEOMSET code).

Effort: medium (GEOMSET pass, `vwall`, `vdepth`, `spans`, `vtap`, `vband`, `vspr`, `vauto`; dbeview remains, test sets remain).

### 5.2 Assessment of the proposal "decision tree per element with cell bit masks"

Equivalent to M1 in Crawl, worse in the demo, and it does not solve bcov:

- Per element a list of minimal occluding sets (element bits, not "cell is wall": only **occluding surfaces** may occlude, so one bit per front/side of the DVG element, set at runtime after `occ(e, t, ent)` with the style from `resolve`, CONTENT cells as today after the pass in which they mark). Test: `(mask & S) == S` per alternative.
- Crawl: all sets of size 1 (section 4), 19 bits = 3 bytes; test = `mask & C[e] ≠ 0` ≈ 30–35 cycles, marking = set one bit ≈ 20 cycles. That would be roughly M1 (≈ −1 700), but presupposes the up-front enumeration of the sets.
- Demo: up to 9 alternatives of size 2–3 per element; ≈ 9 × 35 = 300 cycles in the worst case, hence **more expensive** than today's test (≈ 100) for the inner fronts; likewise the number of sets grows with S and D (combinations).
- bcov (bands, wallpaper, automap floor) still needs column unions: the tree does not provide them, the columns for `spans` would first have to be reassembled from the element bits (Demo: floor/ceiling bands in 3.2 depths per view). In Crawl bcov would be "lazy" (only for the wallpaper at depth D, 0.72 per view) and there saves the 477 + ≈ 130 cycles almost completely – but that works just as cheaply with M1 (one `ora` per mark instead of 123 cycles).
- The tree remains exact only if the sets map exactly the union logic (c0/c1 of the elements); M1 gets that for free without set enumeration, because segments already represent the union.

Recommendation: M1 (segment masks) instead of decision tree.

### 5.3 Further measures

| No. | Measure | Savings per wall | per Crawl frame | per demo frame | Space | Effort |
|---|---|---|---|---|---|---|
| M1 | Segment masks cover/bcov (5.1) | ≈ 410 | ≈ −1 800 (−10.6 %) | ≈ −1 850 (−7.4 %) | Code −200…−300 B (gain), BSS −220 + ≈ 150 B | M |
| M2 | `vauto`: return immediately if the depth has no floor rows (`bact+1 = 0`); `mark_seen` per cell instead of per wall (cell already marked in this view → skip) | 20–25 | ≈ −425 (only with automap), `mark_seen` ≈ −60 | ≈ −100 | ≈ +10 B | S |
| M3a | GEOMSET precomputes per element `rowofs = row[y] + x` (16 bit) and `Slot = k_ei + slot`; `gwall` adds only the `rowofs + row[dy]` part + AP | ≈ 60 | ≈ −260 | ≈ −350 | tables 2–3 B per wall element (BSS), code ≈ +40 B | S–M |
| M3b | per (element, style) a finished core table at TEXSET/GEOMSET: `resolve` and core writing (resolve 133, gsetx/gsetup 112, gwall 307, grl) become one table access and one 11-byte copy per core with AP addition. Cycles per wall ≈ 1 337 → ≈ 960 (after M1 ≈ 550) | ≈ 380 | ≈ −1 650 (−9.7 %) | ≈ −1 500 (walls without ROWS/edge) | table Crawl 19 elements × 4 styles × (1 + 11) B ≈ 0.9 KB; demo walls up to ≈ 4 KB (bank 1, table address as new parameter in GEOMSET/TEXSET, no room in LIBTAB/BSS); code ≈ +250 B (only after M1) | L |
| M4 | skip `vobjc` per cell without surface/item (bit field over the content layer like `obm`, items) | – | ≈ −300…−600 (estimated, **not** measured: vobjc ≈ 100 per cell) | – | ≈ +40 B | M |

Overall effect on Crawl (mean 16 939), without automap: M1 ≈ −1 800, M3a (included in M3b) ≈ −260, M3b additionally ≈ −1 400 → ≈ 13 500 (−20 %); per accepted wall 1 337 → ≈ 550 (0.1: 420), the difference being `vwall` prologue, `itemadd` and `vneed`. The item sprites (2 017 each) and the depth costs (1 782 per depth) remain the largest block and are not touched by M1/M3 (M4 addresses only part). The 0.2 mean would be at ≈ 13.5 k instead of 16.9 k (0.1 mean over the same 400 views according to cmp01: 16 369, 0.2 old: 16 863; 0.2 today 16 939; 0.2 has the flatter curve in the base load and the steeper one per entry).

Westwood demo: not measured (section 6). Demo map of the specification (56 views, 25 081 mean): M1 ≈ −1 850, M3b for walls without ROWS ≈ −1 500 with tables up to ≈ 4 KB; there, in addition, `fillrows` (2 025 per view, ROWS styles), `vcells` + `bclass` (2 648 + 1 257: floor/ceiling classification per cell) and the bands (`vband` 1 418) dominate, which M1–M3 do not touch.

### 5.4 Verification, lib space

- Byte identity: `test/sim/run_crawl.py --dir test/tools/data --fix` (19 136 views against `dbeview.view`), `run_sim.py` (P6d/P6e/P6f sets incl. automap and overflow, `VMS_COPY`), `test_geomcheck` (new GEOMSET boundaries: more than 16 segments, edge cases c0 = c1, elements with bit 0 without span). Cycle measurement with the same harness (run F = 4 minus F = 7).
- Reserve today: code 199 bytes (`$B000–$DB38`, test build 54 bytes), BSS 125 bytes, LIBTAB 79 bytes (`__LIBTAB_SIZE__` `$3B1` of `$400`). M1 brings code reserve ≈ +200…+300, BSS reserve ≈ +70…+170; M3b needs the code reserve from M1 and bank 1 space in the game (not part of memory map G, the default DTS wall area `$8000–$AFFF` has room in Crawl, not in general).

## 6. Limits of the statement

- Mini 6502 instead of sim65: the cycle count agrees to 0.2 % with sim65 (26 092 / 26 041, difference = entry), counting per label is exact, assignment of the cycles to labels for fall-through (e.g. `gsetup` → `gsetx`) goes to the nearest label.
- Regression coefficients apply to the Crawl map (400 views, same styles, one wall element per cell/surface with one core); the demo numbers have only 56 views and no objects.
- The Westwood 140 scene (`demo/view.toml`, `docs/specs/examples/view-west140.toml`) was not profiled: the task named Crawl as the focus; the demo map of the specification is a stand-in for the order of magnitude.
- All savings are estimates from instruction counting, not a prototype.

## Addendum 2026-11-26: M1 and M2 implemented, measured and rejected

M1 (cover/bcov as segment bit masks) and M2 (skip automap marking without floor rows) were fully implemented (byte-identical, all tests green) and **rejected** on the user's decision – do not try again without clarifying the reasons:

| | Forecast above | measured |
|---|---|---|
| per wall | −410 cycles | −183 |
| Crawl `VIEW` per frame | −10.6 % | −3.5 % (without ghost) / −2.7 % (with ghost) |
| Demo map | −7.4 % | ≈ 0; with automap +329, tile-rich random scenes +830 |
| Lib reserve | +200 … +300 bytes | 14 → 12 bytes, BSS full |
| Crawl total (VICE comp 2/1 MHz) | – | −0.1 % / −0.5 % |

Cause of the wrong forecast: the estimate assumed ≤ 16 segments (2-byte masks); the test geometry `double_fronts` has 24 segments, hence 3-byte masks (every mask operation ⅓ more expensive), plus GEOMSET code (127 bytes) and tables. The removed interval code (484 bytes, 220 bytes BSS) was almost completely consumed by the new code. Lesson: before an implementation, first measure a small prototype in sim65 (`AGENTS.md`).
