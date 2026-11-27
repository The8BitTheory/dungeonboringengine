# dungeonboringengine

Version 0.2 (files `dbe0.2.stub` and `dbe0.2.lib`, version number in `VERSION`).

A dungeon crawler engine for the C128 (VDC, 64 KB VRAM), built on [VDC-BASIC](https://github.com/The8BitTheory/vdc-basic) v3. The game remains a BASIC 7 program (interpreted or compiled with Blitz!); the engine lib handles the visibility calculation and the render list and outputs VDC command lists for `VCL`.

- Plan and decisions 0.2: [docs/plan-0.2.md](docs/plan-0.2.md)
- Detailed engine specification (memory map, functions, `VIEW`, tests): [docs/specs/P6-engine.md](docs/specs/P6-engine.md)
- Call, parameter block, data formats, memory map: [docs/formats.md](docs/formats.md)
- Draft 0.1 (background): [docs/engine-design.md](docs/engine-design.md)

## Status (0.2)

Sub-steps P6a–P6j completed (results in `docs/specs/P6-engine.md`): skeleton (stub in bank 0 with 8 KB of shared RAM, lib in bank 1 from `$B000`, interrupt dispatcher), map (`MAPINIT`, `SETPOS`, `SETCELL`, `MOVE`, automap), assets (`GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET`, `ITEMSET`), `VIEW` with walls, tiles, floor, ceiling, wallpaper and objects at the correct depth (VCL type 9: VMS lists directly from bank 1). 42 VICE scenes are pixel-identical (interpreted and as a Blitz! compiled build with runtime image 2). Requires VDC-BASIC v3 (branch `v3`).

Tools (Python 3 with Pillow): `tools/vrl.py` (RLE for `RXV`), `dbegeom.py` (view window, DVG; `view.toml`, switch `byte_edges` for edges on whole bytes), `dbetex.py` (wall, floor and ceiling DTS, wallpaper DBG), `dbepersp.py` (derives side, floor and ceiling images in perspective from flat patterns or textures; module for asset scripts; `dbetexdemo.py` uses it), `dbespr.py` (sprite sets S2), `dbemap.py` and `crawlmap.py` (map DMP), `dbeview.py` (reference of `VIEW`), `dbemove.py`, `dbemem.py` (memory map). For Crawl 128: `crawlconv.py` (converts the 1.0f data of `crawl128-100f.d81` into DVG, DTS, S2, DMP and VRL for 0.2), `crawl01.py` (reference: the image of Crawl 1.0f from the 0.1 model, for the pixel comparison). The example project is in `docs/specs/examples/`. JS port of the tools with browser editors (map editor with live view so far): `tools/js/`, `tools/web/`, `docs/specs/P8-js-tools.md`. Planned extension of the toolchain (visibility check of special wall elements, pre-baking of animations with the level context, packaging per zone: `dbebake`, `dbepack`): `docs/vda-animation-notes.md`, section 8.

**P7 completed** (spec and results: [docs/specs/P7-crawl.md](docs/specs/P7-crawl.md)): Crawl 128 version 1.1 (game repo `dungeoncrawlerjam2025`, branch `dbe-0.2`) runs on engine 0.2 and VDC-BASIC v3 with **pixel-identical** images to 1.0f (offline 19 136 views, in the emulator 74 prompts interpreted and compiled). Plus the [demo](demo/README.md) with Westwood geometry, windows, sky, abyss and animated goblins. P6i: sprites are not clipped against walls; occlusion results from the drawing order.

The 0.1 version (Crawl 128 with `WALLSET`, `SPRITESET` v1) now exists only as the test disk `crawl128-dbe.d81`.

**Demo:** `python3 demo/build.py` builds `build/demo/` with the disk `dbe-demo.d81` and `.d64`; description, keys and memory in [demo/README.md](demo/README.md), test `test/vice_demo.py`.

## Memory map bank 1 (`MEMSIZ $4000`)

The game starts with `POKE 57,0:POKE 58,64:CLR` (variables `$0400–$3FFF`). Engine data lies only in `$4000–$AFFF` and `$E800–$FBFF`:

| Range | Content |
|---|---|
| `$4000–$5FFF` | DMP (map) |
| `$6000–$7FFF` | S2 (sprite sets) |
| `$8000–$AFFF` | DTS wall |
| `$B000–$E7FF` | Lib, tables, variables (do not use) |
| `$E800` / `$EE00` / `$F600` / `$FB80` | DVG / DTS floor / DTS ceiling / DBG (together up to `$FBFF`) |
| `$FC00–$FEFF` | reserved (Blitz! runtime) |

The tools use these load addresses as defaults and abort with an error message if a file extends beyond its range.

## Building

Requirements: cc65 (`ca65`, `ld65`, `cl65`, `sim65`), Python 3, Pillow. For testing also VICE 3.10 (`x128`, `c1541`), ACME and, for the Blitz! run, `node` with the Blitz! compiler; VDC-BASIC v3 under `~/git/vdc-basic` (`VDCBASIC_DIR`).

```
engine/build.sh     # build/dbe0.2.stub, build/dbe0.2.lib (version from `VERSION`), dbe0.2-test.lib (with test functions)
python3 tools/dbegeom.py docs/specs/examples/view-west140.toml          # geometry: DVG, templates, budget
python3 tools/dbetex.py build walls.toml                                # texture DTS and VRL (see docs/specs/P5-textures.md)
python3 tools/dbemap.py build docs/specs/examples/demo.toml demo.dmp    # map
```

The lib uses 10 982 of 11 264 bytes (`$B000–$DBFF`); do not use up the reserve of 282 bytes.

## Testing

| Test | Purpose |
|---|---|
| `python3 -m unittest discover -s test/tools` | Tools and reference (`dbeview`, `dbemove`, `dbemem` …), without emulator |
| `test/sim/run_sim.py` (`DBEVIEW_FULL=1` for the full random set) | Lib in sim65: all functions, `VIEW` and `MOVE` byte-identical with the references; cycles |
| `test/vice_smoke.py` | Stub, lib, interrupts, bank 0 `$1C00–$3FFF` unchanged, `RXV` (interpreted and Blitz!) |
| `test/vice_zp.py` | Zero page block `$63–$72` under interrupts, afterwards BASIC computes correctly; `--funcs`: zero page usage per function (the stub saves the block only for `VIEW`/`GEOMSET`) |
| `test/vice_view.py` | 42 scenes in the real x128, whole VRAM pixel-identical; cycles at 1 MHz and 2 MHz (`--no-fast`, `--byte-edges`, `--check`, `--control`, `--fix`: fixed list address) |
| `test/vice_vclprof.py` | Breakdown of the VCL time (`--static` without VICE) |
| `test/vice_blitzvars.py` | Where a Blitz! program places variables; whether `MEMSIZ $4000` takes effect |
| `test/tools/test_crawlconv.py`, `test_crawl01.py` | Converter and offline full comparison: 19 136 views of Crawl 1.0f byte-identical (in `unittest discover`) |
| `test/sim/run_crawl.py` | the same views with the lib in sim65 against `dbeview.view` |
| `test/vice_demo.py` | Demo tour (75 keys) in the real x128, whole VRAM at every prompt against the model; `--check` without emulator |
| Game repo `test/vice_crawl.py` | Crawl 1.1 (interpreted, compiled) against 1.0f at every prompt (VRAM and registers); also the timing measurement (`--timing`) |

VICE tests run event-driven (breakpoints, debug cartridge, no fixed waiting times); the port comes from `--port` or `DBE_VICE_PORT` (range 6631–6649).

## Loading in the game

```
10 POKE 57,0:POKE 58,64:CLR
20 BANK 0:BLOAD"DBE0.2.STUB",B0,U8:BLOAD"DBE0.2.LIB",B1,U8
30 SYS 3328:RREG A,X,Y
40 BLOAD"MAP.DMP",B1,U8:BLOAD"WALLS.DTS",B1,U8:BLOAD"VIEW.DVG",B1,U8:REM load addresses are in the PRG headers
```

Textures, wallpaper and sprites come as VRL files (`BLOAD` to bank 0, `RXV` into VRAM); afterwards `POOLSET`, `GEOMSET`, `TEXSET`, `BGSET`, `SPRITESET`, `MAPINIT`, `BUFSET` (order and parameters: `docs/specs/P6-engine.md` section 3; example `test/vice/view.bas`). Calling a function: `SYS 3331,F,X,Y` with the parameter block at `$0C00`. With `BUFSET` X = 1 (fixed list address, P6j) the list for `VCL` is always at the start of the buffer (`VCL 4864`, fastest via a variable that is created first); this requires VDC-BASIC v3 with VCL type 10 (P2e).
