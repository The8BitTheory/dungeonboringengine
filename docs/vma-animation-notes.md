# Notes: animations and the VDC-BASIC command `VMA`

As of: 2026-11-27. Idea collection with measurements, **not yet planned or specified**. Next step: a spec, after the deferred VDC-BASIC optimisation. Keep in mind the render-order rule: sprites are drawn whole, nearer walls overdraw them; there is no clipping against cover, only against the viewport edge.

## 1. Starting point

1. **A separate sprite format for animations (engine).** Animated sprites often have to be cut, for example a gate that opens. A format optimised for that, uncompressed or pre-cut, avoids the expensive `clipvms_e` path of the VMS edge lists.
2. **New VDC-BASIC command `VMA`** (A = animation), based on sprites with transparency. Two first variants:
   - **Image that moves or is cut step by step**, for example a gate sinking into the floor. Each step shows a smaller part of the gate at a lower position.
   - **Static image with animated parts** (Bard's Tale / Wasteland style), for example a warrior portrait with animated eyes, hands and a sparkle on the sword. The base image is compressed. Small regions are overwritten and restored, and sequences may be random.

## 2. Categorisation by technical requirements

| # | Axis | Notes |
|---|---|---|
| 1 | Transparent vs opaque | An opaque replace has no visible intermediate state, so no flicker. An opaque gate can be handled in an optimised way. |
| 2 | Moving vs fixed position | Moving: remember the background and restore it. Fixed (portrait): store only the animated parts and draw them over a separate static image that does not need to be part of the animation. |
| 3 | Occluded by nearer scene objects vs free | Free (UI): writing its own pixels is enough. In the scene: after each step, re-run the VCL entries that come later in paint order and intersect the rectangle, clipped to it. This is often more expensive than the sprite itself. |
| 4 | Whole vs partially cut | Only the visible part of the image is cut off (gate sinks into the floor or slides into the wall). **Never scaling.** Dirty area = union of the old and the new visible rectangle. |
| 5 | Frame source | Own image per frame (eyes, hand) vs derived from one image by cut and offset (sinking gate: only a row table). |
| 6 | Horizontal movement | Vertical is cheap. Horizontal in **byte steps** is preferred; in chunky mode a byte step is only 2 pixels, so no shifting, no edge masks and no pre-shifted copies are needed. |
| 7 | Data in VRAM vs RAM | In spare VRAM the VDC copies by block copy (fast). From RAM every byte goes through the register port (slow, blocks the CPU). This makes VRAM space a budget question. |
| 8 | Distance in the dungeon view | Frames × distances (× side positions) is quickly the biggest storage factor. A portrait does not have this. |
| 9 | Trigger and lifetime | One-shot, event-triggered (gate): ends in an end state that belongs in the map state so that the next `VIEW` draws consistently; blocking or not. Ambient loop (portrait, torch, water), possibly random. Bound to the view (invalid when the player moves) vs persistent (UI area, survives `VIEW`). |
| 10 | Flicker sensitivity | "Restore, draw transparently, redraw occluders" has visible intermediate states. For large areas: off-screen compose plus one opaque copy. |
| 11 | Simultaneity and overlap | Several animations at once need a scheduler. Overlapping animations invalidate each other's snapshots. Simplest rule: forbid overlap. |

### Classes

- **A: fixed position, free, opaque.** Portraits, UI. Cheap and simple.
- **B: fixed position in the scene.** Torch, gate, grille. Needs snapshot, restore and redrawing of the occluders.
- **C: freely moving in the scene.** Projectiles, spells. A change of distance switches to that distance's own pre-made frames, no runtime scaling. Most expensive case, probably later.

### Examples

| | transparent | moving | occluded | cut | frames | distance | trigger |
|---|---|---|---|---|---|---|---|
| Gate (opaque), sinking | no | vertical | yes | yes | derived (rows) | yes | one-shot |
| Grille gate, sinking | yes | vertical | yes | yes | derived (rows) | yes | one-shot |
| Two-wing gate | no | horizontal | yes | yes | derived (columns) | yes | one-shot |
| Portrait | no* | no | no | no | own | no | loop, random |
| Torch on a wall | yes | no | yes | no | own | yes | loop |
| Projectile / spell | yes | yes | yes | no | own per distance | changes | one-shot |

\* The animated parts are stored as opaque rectangles including their background; transparency is resolved in the converter.

## 3. Example for horizontal movement: two-wing gate

The two wings open from the centre outwards, to the left and to the right, sliding into the wall. **No perspective** (no swinging frames).

- Each wing is the same image, cut by a **column offset**. This is the counterpart of the row offset of the sinking gate.
- The VMS edge lists are row-based, so a horizontal cut would hit `clipvms_e` on every row. In an uncompressed format the cut is only a different source start address: per row one copy with the wing width as stride, by VDC block copy if the image is in VRAM.
- Byte steps are enough (2 pixels in chunky mode).
- The gap in the centre reveals the background, which is restored from the snapshot (class B). Then the frame and nearer walls are redrawn.
- Store both wings. Mirroring at runtime would need a CPU bit-reverse table and rule out the VDC copy.

Consequence: an **uncompressed format that can be cut by rows and by columns** is the common base for the class-B gates.

## 4. Proposals so far (not decided)

- **Sinking gate:** engine object with a phase and a VMS row-offset table (truncate to the first n rows; also speeds up edge clipping).
- **Portrait:** opaque byte-aligned rectangles including the background cut per frame, no transparency. Restore = copy the base rectangle. The converter finds the regions by diffing the Aseprite frames.
- **`VMA`:** a jiffy-timed sequencer of tracks. Each step is a small VCL list plus a duration; the next step is fixed or weighted random (LFSR). Called from the game's wait loop, never from the IRQ (single VDC register port).
- **Redraw only the covered part** (user requirement: a gate animation must not redraw the whole dungeon view):
  1. Once, snapshot the gate rectangle without the gate (opaque VMC into spare VRAM).
  2. Per step, restore the snapshot and draw the gate rows (row table).
  3. Re-run only the VCL entries after the gate in paint order that intersect the rectangle, clipped to it (door front, nearer walls).
  4. Optional against flicker: off-screen compose plus one opaque copy.

  The snapshot becomes invalid when the player moves (full `VIEW` anyway) or when something behind the gate moves.

## 5. Editor and runtime: what can be pre-baked

The solution for this complexity is the combination of editor and runtime. Almost everything that is expensive at runtime depends on knowledge the editor already has: the viewport geometry (fixed during the game), the map with its static walls, the wall styles, the trigger positions. Unknown at runtime are only the **dynamic objects** (monsters, items, other animations) and the **player's position**, i.e. the slot the animation is seen from.

| # | Optimisation | What the editor does | Condition |
|---|---|---|---|
| 1 | Resolve transparency | Bake the covered background into every step: opaque patches | Static background: portrait always; in the scene per instance + slot from the map, or per wall style + slot (torch on its own wall texture) |
| 2 | Bake occluders | Include door frame and nearer walls in the steps, or trim the patches to the visible area, so no VCL entries have to be re-run | Nearer geometry static, i.e. known per instance + slot |
| 3 | No snapshot | The restore source is baked: no VRAM per instance, no invalidation | follows from 1 |
| 4 | Cut and offset | Every step as a ready rectangle, or one uncompressed image + offset table; at runtime only a copy with stride, no `clipvms_e` | – |
| 5 | Delta rectangles | Diff the frames, store only the changed byte-aligned rectangles per transition | Pays off for portrait and torch; with moving gates almost everything changes |
| 6 | Random sequences | Patches per allowed edge of the transition graph, or per frame relative to the base image; at runtime the LFSR only picks the edge | Small graph (portrait) |
| 7 | Variants | Mirrored versions, distances, side positions pre-made | already decided |
| 8 | Addresses | Absolute screen addresses and byte alignment per slot | Viewport fixed during the game |
| 9 | Placement and format | Per patch: uncompressed in VRAM (block copy) or VRL in RAM, check the VRAM budget | Cost model in the editor (section 6) |
| 10 | Budget per step | Estimate the cost of each step, split large steps | – |
| 11 | Trigger slots | Determine from the map from which slots the trigger moment is visible (gate with lever next to it: distance 1, centre) and bake only those; in all other slots the end state appears directly | Trigger position known in the map |

Item 11 is the big lever against the combinatorics frames × slots × instances.

### Runtime cases that remain

| Case | Runtime does | Transparency at runtime | Covers |
|---|---|---|---|
| **R1 patch playback** | Copy opaque rectangles, jiffy sequencer (fixed or random); optionally clip at one rectangle (viewport edge, a nearer wall the map has there): with opaque uncompressed data only a narrower copy | none | portrait, torch, all gates in the trigger slot without anything dynamic behind |
| **R2 layer compose** | In the rectangle: baked background layer, dynamic sprites behind, gate step, baked front layer (if possible opaque rectangles, only non-rectangular edges transparent) | sprites behind, grille gate, front layer edges | gate/grille with a monster behind ("gate opens, someone stands behind it") |
| **R3 full VIEW** | The animation is a dynamic object with phase/distance frame in the normal scene | normal | projectiles (few steps per flight), animations in slots without bake (gate triggered from afar) |

| Example | Normal case | Special case |
|---|---|---|
| Portrait | R1 | – |
| Torch | R1 | monster overlaps it: animation pauses until the next VIEW (cheaper than R2, visually acceptable) |
| Gate (opaque), sinking | R1 | dynamic object behind: R2; slot not baked: end state or R3 |
| Grille gate | R1 | as above, R2 with transparent gate layer |
| Two-wing gate | R1 | as above |
| Projectile | R3 | – |

Class A (opaque patches) becomes the normal case for almost everything. Transparency at runtime remains only in R2. Class C needs no path of its own (R3), because the engine draws dynamic objects at the correct depth anyway (plan-0.2). The only new runtime path besides the sequencer is R2.

Open decisions:
1. Bake per instance (exact, occluders included, more storage) or per style (less storage, needs the rectangle clip of R1). Measure on a sample map first.
2. R2 now or later. For a start: monster behind the gate → R3 or end state; R2 only once the moment really has to be visible.
3. Gate triggered from afar while the player turns: the phase runs on in the map state, every VIEW draws the current phase (R3).

## 6. Measurements on real hardware

Benchmark: `vdc-basic/test/bench/anim/` (branch `anim-bench`), result `results/c128-20261127.md` (C128, 64 KB VDC, chunky mode as Crawl, 2 MHz, R36 = 0, VIC blanked; mean over 12 positions in the frame; all 50 cases verified by checksum). Z64K is on average 13 % faster than the hardware (0–34 %), VICE further off; the picture is the same.

One frame (PAL) = 20 ms.

| Case | VRAM → VRAM (`VMC`/`VMS`) | CPU from RAM | `RXV` from RAM (T = 2) |
|---|---|---|---|
| Portrait, 3 parts (58 bytes) | 3.4 ms | 5.2 ms | 5.9 ms |
| Torch (48 bytes) | 2.6 ms | 4.5 ms | 5.3 ms |
| Gate distance 2 (20 × 42 = 840 bytes) | 9.1 ms | 34 ms | 32 ms |
| Gate distance 1 (30 × 64 = 1920 bytes) | **12 ms** | 78 ms | 69 ms |
| Two-wing gate as 3 columns of 10 bytes | 40 ms | 92 ms | – |
| Viewport 70 × 96 | 36 ms | – | 210 ms |
| Grille gate, transparency at runtime (688 bytes, ~520 runs) | 92 ms (`VMS`) | 83 ms | 83 ms |
| Goblin, transparent (534 bytes) | 11.5 ms (`VMS`) | 29 ms | 30 ms |
| R2: background + goblin + gate rows | 32 ms | – | – |
| R2 with grille gate | 83 ms | – | – |

Preload RAM → VRAM: `RXV` 27 µs/byte (gate content), 17 µs/byte (dark corridor), 28 µs/byte (brick wall, 9600 bytes in 0.27 s); `RTV` 48 µs/byte; own CPU loop 38 µs/byte. Fixed costs: VCL entry 111 µs, `VMC` with one byte 0.5 ms.

Consequences:
1. **Animation assets belong in VRAM.** A gate step from VRAM fits in one frame, from RAM it takes 3.5–4 frames. For portrait and torch the difference is small; RAM is acceptable there if VRAM is short.
2. **`RXV` is the loading tool**, not the step tool: about 1.75 × as fast as `RTV` and it saves RAM (gate frame 1214 instead of 1920 bytes). Eight baked gate steps (15 KB) load in about 0.42 s when entering a zone.
3. **Rows cost more than bytes** (about 150–200 µs per row of a block copy). Bake the two-wing gate as one full-width rectangle per step (12 ms), not as three columns (40 ms). Baked frames should be wide, not split into narrow strips.
4. **Transparency with many runs is not affordable at runtime** (grille: 83–92 ms by any method, baked 12 ms). Few runs (goblin) are acceptable with `VMS`. This confirms pre-baking (section 5, item 1).
5. `RXV` threshold T: with T = 2 `RXV` is equal or up to 10 % faster than with the old default 14; the default in VDC-BASIC v3 is now 2.

## 7. Name of the command

`VMA` is already taken in VDC-BASIC (AND on a VRAM byte, together with `VMO`). The animation command needs another name.
