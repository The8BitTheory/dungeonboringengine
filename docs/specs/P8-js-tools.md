# P8: Tools in JavaScript – one library for browser editors, CLI and tests

As of: 2026-11-27. Agreed with the user: the tools `dbegeom`, `dbetex`, `dbespr`, `dbemap` and the new combined `dbebake`/`dbepack` (`docs/vda-animation-notes.md`, section 8) become **one JavaScript library** with an API. The browser editors, a Node command line and the tests all use this API, so in the end there is one implementation. The Crawl converters are ported as well. Python stays the reference until each module reaches parity, then it is removed.

## 1. Goals

- **Real editors with live preview** in the browser: map, geometry, textures, sprites, bake/pack (section 6).
- **One implementation**: the core has no DOM access and runs unchanged in the browser and in Node.
- **Byte parity** with the Python tools for every output format (DVG, DTS, DBG, VRL, S2, DMP, VCL/VMS lists of the reference renderer) before a Python module is removed.
- Runs locally from the repo, offline, without a build step and without a CDN.

## 2. Structure

```
tools/js/
  package.json          "type": "module", scripts: test; no runtime dependencies from the registry
  core/                 ES modules, no DOM, no fs: bytes in, bytes/objects out
    io/png.js           PNG decoder (all colour types, bit depths 1-8, tRNS, Adam7) and encoder (RGBA/RGB, filter 0)
    io/bmp.js           BMP decoder (1/4/8 bit indexed, 24/32 bit)
    io/inflate.js       zlib inflate/deflate adapter: Node zlib or browser (De)CompressionStream
    io/toml.js          TOML 1.0 parser (vendored, see 2.2)
    io/aseprite.js      Aseprite JSON export (frames, tags, slices)
    vrl.js              port of tools/vrl.py
    geom.js             dbegeom (DVG, JSON, templates, budget)
    tex.js, persp.js    dbetex (DTS, DBG, VRL), dbepersp
    spr.js              dbespr (S2)
    map.js              dbemap (DMP)
    view.js             dbeview (reference of VIEW: image, VCL/VMS lists)
    mem.js, move.js     dbemem, dbemove
    bake.js             new: visibility, checks, baking of animations (P8 phase 3)
    pack.js             new: packaging per zone (P8 phase 3)
    crawl/              ports of crawlconv, crawlmap, crawl01, crawlsprites, wallconv
  cli/dbe.js            node tools/js/cli/dbe.js <tool> <command> ...: same commands and options as the Python CLIs
  test/                 node --test; *.test.js per module, golden/ (section 4)
  vendor/               vendored third-party code with licence file
tools/web/              the editor app: index.html, app modules, styles; uses tools/js/core directly
```

### 2.1 API conventions

- Inputs are `Uint8Array` (files), plain objects (parsed TOML/JSON) and an optional **file resolver** `async (relPath) => Uint8Array` for files a project references (PNG atlases, Aseprite exports, geometry JSON). The core never touches the file system.
- Results are plain objects: `{files: {name: Uint8Array | string}, report, warnings, errors}`. The CLI writes `files` to the output directory; the browser writes them through the folder handle.
- Errors that Python raises as exceptions (e.g. `TexError`) are thrown as `Error` subclasses with the same message text, so tests can compare messages.
- Randomness only through an explicit seeded generator (as in Python).
- Numbers: integer arithmetic where Python uses `int`; `Fraction` in dbegeom becomes an exact rational helper (BigInt numerator/denominator), not floating point, so rounding stays identical.

### 2.2 Third-party code

Vendored, not loaded from a CDN: a TOML 1.0 parser (MIT/BSD licence, single ES module) in `tools/js/vendor/`, with its licence. Everything else is written here (PNG/BMP decoder, PNG encoder, inflate adapter): image decoding must be bit-exact, a canvas would apply colour management and premultiplication.

### 2.3 Runtime

Node LTS (installed in `~/.local`, v26.13.0 as of 2026-11-27). Browsers: Chrome/Edge with the File System Access API (read and write the project folder). Firefox: read via directory picker, outputs as ZIP download.

## 3. Python → JavaScript mapping

| Python | JS | Lines (Python) | Notes |
|---|---|---|---|
| `vrl.py` | `core/vrl.js` | 451 | phase 0 |
| `dbemap.py` | `core/map.js` | 552 | phase 1 |
| `dbeview.py` | `core/view.js` | 2053 | phase 1, largest risk |
| `dbemem.py`, `dbemove.py` | `core/mem.js`, `core/move.js` | 114 | phase 1 |
| `dbegeom.py` | `core/geom.js` | 965 | phase 2 |
| `dbetex.py`, `dbepersp.py` | `core/tex.js`, `core/persp.js` | 1623 | phase 2 |
| `dbespr.py` | `core/spr.js` | 951 | phase 2 |
| `crawl*.py`, `wallconv.py` | `core/crawl/*` | – | phase 4 |
| – | `core/bake.js`, `core/pack.js` | new | phase 3 |

The demo scripts (`dbetexdemo.py`, `dbesprdemo.py`, `demo/build.py`, `demo/mkbg.py`, `demo/tour.py`) move to JS in phase 4 together with the converters.

## 4. Parity and tests

1. `tools/js/test/golden/mkgolden.py` runs the **Python** tools on the example projects (`docs/specs/examples/`, `demo/`) and on the test data (`test/tools/data/`) and writes golden files with a manifest (input, command, sha256 of every output). Images (PNG previews, templates) are compared by decoded pixels, not by bytes (PNG encoders differ).
2. Every JS module must reproduce its goldens byte for byte (`*.parity.test.js`).
3. The Python unit tests of a module are ported to `node:test` (`*.test.js`), same cases and expected values.
4. When a module has parity and its tests are ported, the Python module is removed. Callers in the engine harnesses (`run_sim.py`, `vice_view.py`, `run_crawl.py` …) then call the JS CLI (`dbe view --json …`), see AGENTS.md test table.
5. The web app has no automated UI tests for now (no headless browser installed); its logic lives in the core and is tested there.

Commands: `cd tools/js && node --test` (all), `node --test test/vrl.test.js` (one module).

## 5. Phases

| Phase | Content | Acceptance |
|---|---|---|
| 0 | Node, structure, `io/*`, `vrl`, golden generation, test framework, CLI skeleton | VRL parity and ported `test_vrl.py`; PNG/BMP decoder equals Pillow on all repo images |
| 1 | read DVG/DTS/S2/DBG, `map` (DMP build), `view` (port of dbeview), `mem`, `move`; **map editor** | parity of DMP and of all VIEW references used by the tests; map editor (6.1). **Done 2026-11-27**: 150 tests (test_dbemap, test_dbeview, test_dbemove, test_dbemem ported; parity goldens `mkgolden_view.py`), `smoke.sh` ok. Known deviations: section 7 |
| 2 | `geom`, `tex` + `persp`, `spr`; **geometry, texture and sprite editors** | parity DVG/DTS/DBG/VRL/S2; editors (6.2–6.4). **Done 2026-11-27**: 526 tests (test_dbegeom, test_dbetex, test_dbepersp, test_dbespr ported; goldens `mkgolden_geom.py`, `mkgolden_tex.py`), demo generators and `buildDemoAssets` in JS, `smoke.sh` checks all four editors |
| 3 | `bake`/`pack` (new, JS only); **bake/pack view** | visibility check (vda notes 8.2, steps 1–2), then baking and packing (steps 3–4). **Done 2026-11-27** (section 8): 534 tests, `smoke.sh` checks the bake view |
| 4 | Crawl converters and demo scripts; remove the Python core; harnesses on the JS CLI | all goldens, all tests on JS; no Python tool module left. **Done 2026-11-27**: 592 tests; `run_sim.js` identical to run_sim.py (incl. cycles), `run_crawl.js` 19 136 views 0 mismatches, `vice_view.js`/`vice_demo.js`/`vice_zp.js`/`vice_vclprof.js` equal to the Python versions (cycles within VICE noise), `demo/build.js` byte-identical outputs. Python tools, their tests, harnesses and golden scripts removed (last commit with them: `e4a044f`) |

## 6. Editors (`tools/web/`)

Start: `python3 -m http.server` in the repository root (or any static server), open `http://localhost:8000/tools/web/`. A project is a folder (the one with the TOML files and the built assets, e.g. the repository root); the app opens it with the folder picker and remembers the handle (IndexedDB, per browser). `?http=/` loads the served folder itself read-only (no picker; saving downloads files), `&open=<path>` opens a file at once. `tools/web/smoke.sh` uses this for a headless check in Chrome (demo scene: map opened, live view rendered).

### 6.1 Map (phase 1, done 2026-11-27)

Live view: a dbeview scene TOML names the built assets (`demo/preview.toml`: the demo built by `demo/build.py`, map `demo.toml`). Opening a map uses the first scene that names it; the scene can be changed below the view. Saving writes the map with `map.js toTomlNamed` (keeps tile names and legend characters; events and marks as `[[events]]`/`[[marks]]`, comments of the source are not kept).

- Grid painting of tiles; tile table editor (four wall face styles, floor, ceiling, flags, automap character); items (content layer); events; player start.
- **Live VIEW** from any cell and direction (`core/view.js`, the same image the reference renderer produces), walking with the arrow keys; automap.
- Save as TOML (the `dbemap` text format) and build the DMP.

### 6.2 Geometry (phase 2, done)

Edit `view.toml`; preview of planes, elements, masks and the band layout; export of the atlas template and the budget.

### 6.3 Textures (phase 2, done)

The builders read files through a synchronous resolver; the app fetches what a build misses and runs it again (`tools/web/js/resolve.js`). Rebuild on every change (walls of the demo: about 60 ms in the browser). Form fields of `[texset]` / `[sprite]` are edited in place (`core/io/tomledit.js`, comments stay); `[[style]]` and `[[image]]` tables are edited in the TOML for now. "Reload images" picks up images repainted in Aseprite.

Styles of a `tex.toml`; import per style from PNG atlas or Aseprite; slot grid with the byte states (full/half/empty), cores and warnings; test scene rendered with `view.js`; VRAM budget.

### 6.4 Sprites (phase 2, done)

Sprite sets: phases, angles, foot point; preview per distance and sub-position in a test scene.

### 6.5 Bake/pack (phase 3, done)

Special and animated elements of a map; visibility as an overlay on the map (cell and facing from which an element is seen, with the slot); warnings for visible slots without an image; animation definitions (frames, timing, triggers); bake preview; zone package with VRAM pool layout, `RXV` load list and load time (27 µs per byte, hardware measurement in the vda notes, section 6).

## 7. Known deviations from Python (phase 1)

1. Map TOML: integral floats (`floor = 1.0`) are accepted as integers (smol-toml), tomllib rejects them.
2. Tile names that look like integers (`[tiles.1]`) without `index`: JS object key order puts them first, so the tile order can differ. Use names or `index`.
3. Text of TOML syntax errors comes from smol-toml.
4. Python `KeyError`/`IndexError`/`struct.error` paths: thrown as `ViewError` with the key name, or masked (out-of-range writes).
5. CLI errors print `dbe.js: <message>` (Python: `Error: <message>`).
6. Phase 2: error texts of JSON parsing (geom JSON, Aseprite), image decoding and OS errors other than a missing file come from JS; the tex/spr CLIs print absolute paths; Python crashes with `IndexError` in `build_dvg` for custom planes that leave a depth without elements, JS throws a `RangeError`.
7. The level-9 zlib of `dbegeom`'s .aseprite output is reproduced by a port of zlib 1.3.1 deflate (`core/io/asewrite.js`), checked against Python on inputs up to 800 KB.

## 8. dbebake (phase 3): visibility, baking, packing

`core/bake.js`, CLI `dbe.js bake build|check BAKE.toml [--out DIR]`, view in the editor (tab Bake/Pack). No Python original.

### 8.1 Project file

```toml
format  = "dbebake"
version = 1

[bake]
name  = "demo"
scene = "preview.toml"      # dbeview scene: assets (DVG, DTS, DBG, S2) and map
map   = "demo.toml"         # optional: other map than the scene's
out   = "../build/demo/bake"
load  = 0x9000              # optional: load address in the VRL file frame of the animation data

[pack]
pool = [9600, 46335]        # VRAM pool of the zone
dap_load = 0x4300           # optional: bank 1 address of the animation table (default: first free gap)
rxv_us_per_byte = 27        # optional: load time estimate (hardware, vda notes section 6)

[[anim]]
name   = "gate"
at     = [17, 6]            # cell
face   = "S"                # tile face N, E, S, W
frames = [2, 4]             # wall styles, one per frame (frame 0 = start, last = end state)
views  = "auto"             # or [[x, y, "N"], ...]: viewpoints to bake
depths = [1, 2]             # optional: only viewpoints that see the face at these depths
```

### 8.2 Visibility

`visibility(scene)` runs `view()` from every cell without SOLID in all four facings and records every wall face that is not fully covered (trace hook in `view.js`, active only with `scene.trace`; outputs unchanged): cell, face, style, slot, and how the image resolves (`own`, `fallback` to style 1, `none`). It is exactly what the engine's VIEW draws. `checkVisibility` reports, per style ≥ 2 and (cell, face), the slots in which the face is seen without an image of its own, with the viewpoints. Demo: the styles window and arch have no side images; seen at an angle they show brick.

### 8.3 Baking (case R1 of the vda notes)

Per viewpoint and frame the map gets a copy of the cell's tile whose face shows the frame style; `view()` + `run_vcl` render the real window (background, occluders, wallpaper). The byte rectangle in which any frame differs from frame 0 is the patch; each frame's patch is the opaque window content of that rectangle. Applying a frame's patch to the frame-0 window gives exactly that frame's window (tested). Views that look the same in all frames are skipped.

**DAP v0 (draft until the VDA runtime is specified):** load address (2), `"DA"`, version 0, number of animations; per animation: cell (2), face, number of frames, number of views; per view: viewpoint cell (2), direction, x, y, w, h (bytes/rows in the window), offset of frame 0 in the animation VRAM data (2); the frames of a view follow each other (w·h bytes each). The VRAM data is one VRL file (`<name>.vrl`). Runtime: target = AP + origin + y · stride + x, one block copy per row (VCL type 2 with stride).

### 8.4 Packing

From the scene: DVG, DMP (built from the map), DTS, DBG, S2 (load addresses from the PRG headers) and the DAP in bank 1, checked for overlaps and against `dbemem`; VRAM bases packed from `pool[0]` in the order walls, floor, ceiling, background, sprite sets, animations; pool overflow is an error; load time = unpacked bytes × `rxv_us_per_byte`. Outputs: `<name>.bake.json`, `<name>.bake.md`, and with animations `<name>.dap`, `<name>.vrl`.

## 9. After the Python removal (phase 4)

- **Goldens are frozen.** `tools/js/test/golden/*.json` and the fixtures were produced by the Python reference (scripts `mkgolden*.py`, last present in commit `e4a044f`). They are regression data now: a deliberate change of an output format updates the expected values with the change (review the diff), not by regenerating from Python.
- Specs P1–P7 name the Python tools (`dbegeom.py`, `dbeview.py` …); their JS equivalents are listed in section 3, the commands keep their names and options (`node tools/js/cli/dbe.js <tool> …`; Crawl: `crawlconv`, `crawlmap`, `crawl01`, `wallconv`, `crawlsprites`).
- Python stays only for scripts that do not use the tools: `test/vice_smoke.py`, `vice_blitzvars.py`, `vice_drive.py`, `patch_crawl.py`, and the VDC-BASIC helpers they call (`bastok.py`, `blitzprep.py`, `vicemon.py` in vdc-basic).
- `run_viewsim` (VIEW cycles over all free cells of the Crawl map with the 0.1 wall set WSM) was already broken in Python (command-line protocol of viewsim.prg from before the scene files) and is deleted: `run_crawl.js` measures VIEW in sim65 for all Crawl views on 0.2 assets (cycles JSON), `run_sim.js` covers the functions.
- Known: `demo/build.py --budget` was broken in Python (`dbeview.T_WEG`); `build.js --budget` works.

## 10. Open points (as of 2026-11-27, after the merge into main)

| Point | Where it stands |
|---|---|
| Demo finding of the bake check | wall styles window (3) and arch (4) have no side images; seen at an angle they show brick (11 faces). Decide: paint side images, or accept. |
| `[[style]]` / `[[image]]` tables in the editors | edited in the TOML for now (forms only for `[texset]` / `[sprite]`); map saving drops comments of the source |
| Wall set fallback | always to style 1 (index 0); proposal: one "base style" byte per style (DTS change), vda notes 8.1 |
| DAP format, `VDA` runtime | DAP v0 is a draft; the runtime and its spec do not exist yet (vda notes) |
| Game repo `test/vice_crawl.py` | gets the crawl01 model through `tools/js/cli/crawl01-model.js`; checked with saved runs (`--reuse`: 73 prompts, 0 differ), not yet with a fresh VICE run |
| Branches | `js-tools` (local and on GitHub) and `dbe-js-tools` (game repo, local) are merged but not deleted |
| Game repo remote | GitHub reports that dungeoncrawlerjam2025 moved to `https://github.com/The8BitTheory/dungeoncrawlerjam2025.git` (pushes still work) |
| GitHub Pages | `tools/web/publish.sh` publishes by hand after changes (https://the8bittheory.github.io/dungeonboringengine/) |
