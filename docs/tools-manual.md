# DBE tools: manual

As of: 2026-11-27. The tools of the Dungeon Boring Engine turn painted pictures and maps into the files the engine loads (geometry, textures, sprites, map), show what the engine will draw, and check and pack a zone. They are one JavaScript library with three faces:

- **Editors in the browser** (`tools/web/`): map, geometry, textures, sprites, bake/pack, with live preview.
- **Command line** (`node tools/js/cli/dbe.js <tool> …`): the same functions for scripts and builds.
- **Tests** (`cd tools/js && node --test`): the same functions, checked against the former Python reference byte for byte.

Background and design: `docs/specs/P8-js-tools.md`. Formats: `docs/formats.md` and the specs P1–P5b named below.

## 1. Setup

| Needed for | What |
|---|---|
| everything | Node ≥ 24 (`node --version`). No packages to install. |
| editors | a browser; **Chrome or Edge** can save into the project folder, other browsers open it read-only and offer files as downloads |
| building disks and running the engine tests | cc65, VICE 3.10 (`x128`, `c1541`), VDC-BASIC v3 in `~/git/vdc-basic` (`VDCBASIC_DIR`), Python 3 for the VDC-BASIC helper scripts |

Note for this machine: every Node start takes about 2 s (a monitoring agent loads into each Node process). Long jobs are not affected.

## 2. Quick start

```sh
cd ~/git/dungeonboringengine
node demo/build.js                 # builds the demo assets into build/demo (needed for the live views)
python3 -m http.server             # any static web server in the repository root
```

Open `http://localhost:8000/tools/web/`, click **Open project folder**, choose the repository folder. The left column lists the project files by kind (`dbemap`, `dbeview`, `dbegeom`, `dbetex`, `dbespr`, `dbebake`); a click opens the matching editor. The browser remembers the folder; next time **Reopen …** asks once for permission.

Quick look without the folder picker (read-only, saving downloads files): `http://localhost:8000/tools/web/?http=/` and, to open a file at once, `&open=demo/view.toml`.

## 3. Workflow for a zone

```
geometry (view.toml) ──► textures (walls/floor/ceil.toml, bg.toml) ─┐
                    └──► sprites (goblin.toml, gem.toml) ───────────┼──► scene (preview.toml) ──► map editor: live view
map (demo.toml) ────────────────────────────────────────────────────┘                        └──► bake/pack (bake.toml)
```

1. **Geometry** fixes the view window (size, position, stride, depth) and writes the atlas template you paint on (PNG and `.aseprite`).
2. **Textures** read the painted atlases (one per style) and write wall, floor and ceiling sets (DTS + VRL) and the wallpaper (DBG + VRL).
3. **Sprites** read sprite sheets and write sprite sets (S2 + VRL).
4. **Map** places tiles (wall styles per face, floor, ceiling, flags), items and events.
5. A **scene** file (`format = "dbeview"`) names the built assets and the map; the map editor uses it for the live view.
6. **Bake/pack** checks what is visible where, bakes animations and lays out the zone in bank 1 and the VRAM pool.

The demo (`demo/`) is a complete example of every file; `node demo/build.js` runs steps 1–4 and builds the disks.

## 4. Editors

All editors rebuild on every change (the demo walls take about 60 ms) and show errors and warnings under the form. Form fields are written back into the TOML in place: comments and layout stay. **Save TOML** writes the file, **Build** writes the outputs into the output folder of the project file.

### 4.1 Map

Opens a map (`dbemap` TOML) or a scene (`dbeview` TOML).

- **Tools** (toolbar): *Tile* paints the selected tile, *Item* sets the item number of a cell (0 removes), *Event* adds an event (shift+click removes the events of the cell), *Start* sets the player start (click again: turn), *Viewpoint* sets the position of the live view, *Mark* toggles the automap mark.
- **Tiles** (right): the palette of the tile table, **+ new tile**, and the form of the selected tile: name, wall style per face N/E/S/W, floor, ceiling, automap character, flags (`solid`, `blocksight`, `occluding`, `door`, `automap`, `content`, `distant`; meaning in `docs/specs/P4-map.md` 2.4).
- **Live view**: the image the engine draws from the viewpoint (the reference of `VIEW`, identical to the 6502 version). **W/S** forward/back, **A/D** sideways, **Q/E** turn, arrow keys as well. Below: list sizes (VCL + VMS bytes of the buffer, entries). The assets come from a scene file that names this map (chosen automatically, changeable below the view).
- **Messages**: validation errors (red) and warnings (orange).
- **Save TOML** keeps the tile names and the legend characters of the file; events and marks are written as `[[events]]` / `[[marks]]` (comments of the source are not kept for maps). **Build DMP** writes `<map>.dmp` next to the TOML.

### 4.2 Geometry

Opens a `view.toml` (`[viewport]`, `[output]`, with preset `custom` also `[planes]`).

- **Viewport**: preset (`westwood` or `custom`), `width_px` (multiple of 4, 16–160), `height` (8–100), `origin` (byte offset in the attribute buffer), `stride` (≥ width/2, ≤ 255), `depth`, `byte_edges` (edges on whole bytes: faster, coarser).
- **Output**: name, folder, DVG load address (bank 1), VRAM pool for the budget, zoom of the PNG templates.
- **Preview**: the view window with planes, elements, masks and anchors; the element list (check lines); the atlas template; the budget (VRAM and VMS per element).
- **Build** writes `<name>.dvg`, `<name>.geom.json`, `<name>.budget.md`, `<name>.aseprite`, `<name>_atlas.png`, `<name>_view.png` and `tpl/*.png`. Paint the styles on copies of the atlas (or in the `.aseprite` file). Details: `docs/specs/P3-geometry.md`.

### 4.3 Textures

Opens a texture project (`format = "dbetex"`).

- **Texture set**: name, kind (`wall`, `floor`, `ceiling`), geometry JSON (+ DVG), output folder, load addresses, pool, `max_cores`, `core_min`, `fill_rows`, transparent key colour, alpha threshold.
- **Styles**: one per `[[style]]` (PNG atlas or Aseprite export with tag/frame). Styles are edited in the TOML for now; after repainting a picture press **Reload images**.
- **Result**: images, VRAM bytes against the pool, VRL size, warnings (pixels outside the mask, colours outside the palette …).
- **Previews**: every style in a test scene.
- **Slots × styles**: for every drawing position (slot) and style the image entry, `↩0` (no own image: style 1 is used) or `–` (nothing drawn). This is where you see which slots a special style (an altar, an exit) paints.
- **Build** writes `<name>.dts`, `<name>.vrl`, `<name>.tex.json`, `<name>.tex.md` and the preview PNGs. Details: `docs/specs/P5-textures.md`.

### 4.4 Sprites

Opens a sprite project (`format = "dbespr"`).

- **Sprite set**: name, geometry, output folder, load addresses, number of angles and phases, cores, key colour, `derive` (make the far depths from depth 1).
- **Images**: the `[[image]]` list (phase, angle, depth, box, foot point); edited in the TOML, **Reload images** after repainting.
- **Preview**: choose depth, phase and angle; the yellow crosses are the anchors of the sub-positions in the cell.
- **Build** writes `<name>.s2`, `<name>.vrl`, `<name>.spr.json`, `<name>.spr.md`, `<name>_preview.png`. Details: `docs/specs/P5b-sprites.md`.

### 4.5 Bake/pack

Opens a bake project (`format = "dbebake"`, section 6). Baking runs the engine's view from every walkable cell in all four directions (the demo: 504 viewpoints in well under a second).

- **Visibility**: the map with every face that is seen without an image of its own (orange; the selected one red). A click on a problem lists the slots and draws the viewpoints it is seen from.
- **Animations**: per viewpoint the baked patches of every frame (opaque, with background and occluders), the rectangle and the VRAM bytes.
- **Zone layout**: the VRAM pool as a bar (one colour per file), bases and sizes, the load time with `RXV`, the bank 1 table; overflow and overlaps as errors.
- **Build** writes the outputs (section 6.3).

## 5. Command line

`node tools/js/cli/dbe.js <tool> <command> [options]` (from the repository root; paths relative to the current folder). Exit codes: 0 ok, 1 format or validation error, 2 wrong usage. Addresses accept `0x1234`, `$1234` or decimal.

### 5.1 `geom` (view window)

```
dbe.js geom view.toml [--out DIR] [--name NAME] [--check]
dbe.js geom --preset westwood --width 140 --height 96 [--stride 80] [--origin 0] [--out DIR] [--name NAME]
```
`--check` prints the element table without writing files.

### 5.2 `tex` (textures, wallpaper)

```
dbe.js tex build TEX.toml [--out DIR] [--strict] [--key RRGGBB] [--alpha-threshold N] [--no-preview]
dbe.js tex bg BG.toml [--out DIR] [--strict]
dbe.js tex dump FILE.dts|FILE.dbg [--vrl FILE.vrl] [--json]
dbe.js tex budget FILES… --pool BYTES [--pool-start ADDR] [--vms-buffer BYTES] [--json]
dbe.js tex check MAP.toml|MAP.dmp [--walls DTS] [--floors DTS] [--ceils DTS] [--dvg DVG]
```
`--strict`: colours outside the palette are errors. `check`: every style number of the map exists in the sets, geometry IDs agree.

### 5.3 `spr` (sprite sets)

```
dbe.js spr build SPR.toml [--out DIR] [--strict] [--key RRGGBB] [--no-preview]
dbe.js spr dump FILE.s2 [--vrl FILE.vrl] [--json]
dbe.js spr preview FILE.s2 --vrl FILE.vrl --geom GEOM.json [--d N] [--phase N] [--angle N] [--out PNG]
dbe.js spr budget FILES… --pool BYTES [--pool-start ADDR] [--vms-buffer BYTES] [--json]
```

### 5.4 `map`

```
dbe.js map build MAP.toml OUT.dmp [--load ADDR]      # default $4000 (bank 1)
dbe.js map dump IN.dmp [--toml OUT.toml]             # without --toml: text overview
dbe.js map check MAP.toml
```
`dump --toml` writes a TOML that builds the same DMP again.

### 5.5 `view` (reference of VIEW)

```
dbe.js view render SCENE.toml [--out PNG] [--zoom N] [--clear]
dbe.js view dump SCENE.toml                          # the VCL list, decoded
dbe.js view budget SCENE.toml…                       # largest VCL + VMS, warning if A ≠ 0
```

### 5.6 `bake` (visibility, animations, zone layout)

```
dbe.js bake build BAKE.toml [--out DIR]
dbe.js bake check BAKE.toml                          # messages only; exit 1 on errors
```

### 5.7 `vrl` (RLE streams for RXV)

```
dbe.js vrl encode IN OUT [--load ADDR] [--raw] [--in-prg]
dbe.js vrl rect IN OUT --width W --height H --stride S [--mask MASK] [--load ADDR] [--raw] [--in-prg]
dbe.js vrl decode IN OUT [--raw] [--base BASE] [--out-prg ADDR]
dbe.js vrl stats IN [--raw] [-T N] [--bench P0.json] [--json]
```
Format: `docs/specs/P1-vrl.md`.

### 5.8 Crawl 128 converters

```
dbe.js crawlconv (--d81 IMAGE.d81 | --dir DIR) OUT_DIR [--max-part N] [--font-bytes N] [--json]
dbe.js crawlmap CRAWL128.CD1 OUT.dmp | --d81 IMAGE.d81 OUT.dmp [--toml OUT.toml] [--load ADDR] [--items 2,4] [--floor N] [--ceiling N]
dbe.js crawl01 compare (--d81 IMAGE.d81 | --dir DIR) [--quick] [--workers N] [--json FILE]
dbe.js wallconv WALLS.VDC OUT.wsm [--load ADDR] [-v]
dbe.js crawlsprites RED.VDC RED1.VDC OUT_DIR
```
`crawlconv` converts the 1.0f game data into DVG, DTS, S2, DMP and VRL for engine 0.2; `crawl01 compare` is the offline full comparison (19 136 views) against the 1.0f model. Details: `docs/specs/P7-crawl.md`.

## 6. Bake/pack in detail

### 6.1 Project file

```toml
format  = "dbebake"
version = 1

[bake]
name  = "demo"
scene = "preview.toml"          # assets and map (dbeview scene)
map   = "demo.toml"             # optional: another map
out   = "../build/demo/bake"

[pack]
pool = [9600, 46335]            # VRAM pool of the zone
# dap_load = 0x4300             # optional: bank 1 address of the animation table (default: first free gap)
# rxv_us_per_byte = 27          # optional: load time estimate (hardware measurement)

[[anim]]                        # optional, any number
name   = "gate"
at     = [17, 6]                # cell
face   = "S"                    # tile face N, E, S, W
frames = [2, 4]                 # wall styles, one per frame
views  = "auto"                 # or [[x, y, "N"], ...]
depths = [1, 2]                 # optional: only viewpoints that see the face at these depths
```

### 6.2 What the check reports

For every wall style from 2 on and every cell face: the slots in which the face is visible although the style has no image of its own there, with the viewpoints. The engine then draws style 1 (`fallback`) or nothing (`none`). If a special element is meant to be seen only from the front at two distances, the report must be empty for it; otherwise the level shows it from elsewhere too. Example from the demo: the styles window and arch have no side images, so seen at an angle they show brick.

### 6.3 Animations and outputs

Each frame of an animation is a wall style. For every viewpoint the tool renders all frames in the real level and cuts the byte rectangle that changes: the patches are opaque and already contain background and occluders, so the runtime only copies them (one block copy per row). Outputs: `<name>.bake.json` and `<name>.bake.md` (report), with animations also `<name>.dap` (animation table, format DAP v0, a draft until the `VDA` runtime exists) and `<name>.vrl` (the patch data for the VRAM pool). Rules of thumb from the hardware measurements (`docs/vda-animation-notes.md` section 6): patches belong in VRAM, wide rectangles are cheaper than tall narrow ones, and the pool fills fast (the demo example `demo/bake-gate.toml` deliberately exceeds it).

## 7. Building the demo

```
node demo/build.js [--out DIR] [--budget] [--blitz]
```
Builds geometry, textures, wallpaper, sprites and map of the demo into `build/demo/` (or `DIR`), checks the layout against the DATA lines of `demo.bas`, writes `report.md`, `layout.json` and the disks `dbe-demo.d81`/`.d64`. `--budget` checks all views with goblins (A = 0), `--blitz` also builds the compiled version.

## 8. Tests

| Command | Checks | Time |
|---|---|---|
| `cd tools/js && node --test` | all tools, parity with the former Python reference, Crawl full comparison | ≈ 1 min |
| `node --test test/<module>.test.js` (in `tools/js`) | one module | seconds |
| `tools/web/smoke.sh [MAP.png [GEOM.png]]` | the editors in headless Chrome | ≈ 2 s |
| `node test/sim/run_sim.js`, `node test/sim/run_crawl.js` | the 6502 engine in sim65 against the reference | ≈ 49 s, ≈ 5 s |
| `node test/vice_view.js`, `vice_demo.js`, `vice_zp.js`, `vice_vclprof.js` | the engine in VICE | 15–40 s |

Which tests a change needs: `AGENTS.md`. The goldens in `tools/js/test/golden/` are frozen results of the Python reference (last commit with it: `e4a044f`); an intended format change updates them together with the change.

## 9. Troubleshooting

| Symptom | Cause / remedy |
|---|---|
| live view: "not found (built assets missing?)" | the scene names files in `build/`: run `node demo/build.js` (or build the project's assets) |
| saving offers a download | read-only folder (Firefox, or `?http=` mode): use Chrome/Edge and **Open project folder** |
| "Reopen …" button after a reload | the browser asks again for folder permission: click it |
| a geometry `view.toml` is not listed | it needs `[viewport]` and `[output]`; other project files need `format = "…"` |
| style shows brick where it should not | bake check: the style has no image of its own in that slot (section 6.2) |
| tool runs feel slow to start | a Node start costs ≈ 2 s on this machine; the editors and in-process tests are not affected |
| `integer expected` accepted with `1.0` | known: the TOML parser accepts integral floats (P8 spec section 7) |
