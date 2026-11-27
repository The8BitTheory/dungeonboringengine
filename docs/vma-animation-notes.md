# Notes: animations and the VDC-BASIC command `VMA`

As of: 2026-11-27. Idea collection, **not yet planned or specified**. Next step: a spec, after the deferred VDC-BASIC optimisation. Keep in mind the render-order rule: sprites are drawn whole, nearer walls overdraw them; there is no clipping against cover, only against the viewport edge.

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
