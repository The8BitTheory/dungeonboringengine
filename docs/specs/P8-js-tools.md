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
| 1 | read DVG/DTS/S2/DBG, `map` (DMP build), `view` (port of dbeview), `mem`, `move`; **map editor** | parity of DMP and of all VIEW references used by the tests; map editor (6.1) |
| 2 | `geom`, `tex` + `persp`, `spr`; **geometry, texture and sprite editors** | parity DVG/DTS/DBG/VRL/S2; editors (6.2–6.4) |
| 3 | `bake`/`pack` (new, JS only); **bake/pack view** | visibility check (vda notes 8.2, steps 1–2), then baking and packing (steps 3–4) |
| 4 | Crawl converters and demo scripts; remove the Python core; harnesses on the JS CLI | all goldens, all tests on JS; no Python tool module left |

## 6. Editors (`tools/web/`)

Start: `python3 -m http.server -d tools` (or any static server), open `http://localhost:8000/web/`. A project is a folder (the one with the TOML files); the app opens it with the folder picker and remembers the handle (IndexedDB, per browser).

### 6.1 Map (phase 1)

- Grid painting of tiles; tile table editor (four wall face styles, floor, ceiling, flags, automap character); items (content layer); events; player start.
- **Live VIEW** from any cell and direction (`core/view.js`, the same image the reference renderer produces), walking with the arrow keys; automap.
- Save as TOML (the `dbemap` text format) and build the DMP.

### 6.2 Geometry (phase 2)

Edit `view.toml`; preview of planes, elements, masks and the band layout; export of the atlas template and the budget.

### 6.3 Textures (phase 2)

Styles of a `tex.toml`; import per style from PNG atlas or Aseprite; slot grid with the byte states (full/half/empty), cores and warnings; test scene rendered with `view.js`; VRAM budget.

### 6.4 Sprites (phase 2)

Sprite sets: phases, angles, foot point; preview per distance and sub-position in a test scene.

### 6.5 Bake/pack (phase 3)

Special and animated elements of a map; visibility as an overlay on the map (cell and facing from which an element is seen, with the slot); warnings for visible slots without an image; animation definitions (frames, timing, triggers); bake preview; zone package with VRAM pool layout, `RXV` load list and load time (27 µs per byte, hardware measurement in the vda notes, section 6).
