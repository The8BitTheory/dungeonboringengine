#!/usr/bin/env python3
"""VICE scenes P6g (docs/specs/P6-engine.md 9.4): engine 0.2 and VDC-BASIC v3 in the real x128, event-driven.

Usage: test/vice_view.py [--port N] [--timeout S] [--only i|c] [--check] [--png DIR] [--control] [--no-sim] [--no-fast]
                         [--byte-edges]
  --check   Python only: build scenes, check memory map, view/run_vcl against paint_reference (no VICE)
  --png DIR write images of the expected windows (montage)
  --control control run: model of scene 5 corrupted, the run must report exactly one deviation (exit code 0)
  --no-sim  without sim65 cross-measurement of the cycles (column sim65)
  --no-fast without the second run at 2 MHz (FAST, VIC display off during VIEW and VCL); otherwise two VICE runs per mode,
            cycles of both clocks in the table (columns "2M", stopwatch in clocks at 1 MHz, i.e. in µs)
  --byte-edges  demo geometry with the view.toml switch byte_edges (edges on whole bytes) instead of pixel-exact
  --fix     P6j: fixed list address (BUFSET X = 1, VCL type 10 at B0, needs VDC-BASIC v3 with P2e); the program
            calls ::VCL with the constant B0 instead of P0, the model computes with buf_fix

Flow (test/vice/view.bas, interpreted and as a Blitz! compilation with runtime image 2):
  BOOT (VDC-BASIC v3) -> POKE 57,0:POKE 58,64:CLR -> load stub and lib, INIT -> chunky mode as in Crawl (VDC registers per
  crawl.bas 10059-10135, 64 KB VRAM cleared beforehand) -> DVG, DMP, DTS (3), DBG, S2 (4 sets) at the addresses of the memory map
  (P6 2.4) in bank 1, VRL of the textures/wallpaper/sprites via RXV into the VRAM pool -> POOLSET, GEOMSET, TEXSET, BGSET,
  SPRITESET, ITEMSET, MAPINIT -> per step of the scene table (bank 0 $8000, SETPOS or MOVE, object list): VIEW, ::VCL.
Markers (RTS in bank 0): $0C4C (before VIEW), $0C4D (after ::VCL, scene done), $0C4E (end of table).
The harness stops at the markers, reads the whole VRAM there (`bank vdc`, bsave), the buffer and the results
and compares pixel-exactly with the VRAM model (run_vcl on the 64 KB model, plus paint_reference in the window).
Cycles: monitor stopwatch (stopwatch) from $0C4C; breakpoints at stub entry/exit (VIEW) and at start/end
of VCL in VDC-BASIC (`vcl` from vdcbasic3.sym, `.vcl_done` from the ACME report, vdc_labels).
Event-driven: breakpoints, debug cartridge ($D7FF); -limitcycles and the timeout are only guards.
Port rule (review-notes A): --port, else DBE_VICE_PORT, else 6631, range 6631-6649, bind test, only the own process.
Requirement: VDC-BASIC v3 (VDCBASIC_DIR, default ~/git/vdc-basic, branch v3; nothing is changed there);
Blitz! run additionally needs node and blitzc (otherwise message SKIP).
"""
import argparse, copy, json, os, re, shutil, struct, subprocess, sys, tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vice_smoke as vs                  # monitor/port choice via VDC-BASIC (read only), disk helpers
vm = vs.vm
ROOT = vs.ROOT
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, os.path.join(HERE, 'tools'))
import dbemap, dbetex, dbeview, dbespr, dbemove, vrl
import dbetexdemo as dd
dbeview.dbemap = dbemap
from PIL import Image

# ------------------------------------------------------------------ Memory map (P6 2.4) and VRAM
# Default P6 2.4 (MEMSIZ $4000, P6h): DMP $4000, S2 $6000, wall DTS $8000 (12 KB), lib $B000-$DBFF, DVG $E800, floor $EE00,
# ceiling $F600, DBG $FB80. The improved Blitz! runtime (image 2) makes the upper 1 KB ($FC00-$FFFF) shared and occupies
# $FC00-$FEFF; data there destroys it on BLOAD. The small test assets are packed densely here in $E800-$FBFF (5 KB).
HIGH = (0xE800, 0xFC00)
LOW = {'dmp': (0x4000, 0x6000), 'dts0': (0x8000, 0xB000)}           # range (from, to exclusive)
S2_START, S2_END = 0x6000, 0x8000
POOL = (9600, 46335)                     # VRAM pool: after the attribute RAM (AP 0, 2 x 9600) up to the screen RAM
SCN_ADDR = 0x8000                        # scene table, bank 0
VRL_ADDR = 0x9000                        # load buffer of the VRL files, bank 0 (RXV source from +5)
BUF = (0x1300, 0x1C00)
M_VIEW, M_DONE, M_END = 0x0C4C, 0x0C4D, 0x0C4E
VERSION = vs.VERSION
LIBNAME, STUBNAME = f'dbe{VERSION}.lib', f'dbe{VERSION}.stub'
OUT = os.path.join(ROOT, 'build', 'vice')

# ------------------------------------------------------------------ Small assets


class Small:
    pass


def make_sky(geom, path):
    """Panorama P = 2 * VW bytes (instead of 4 * VW in the demo): half as much VRAM."""
    vw = geom["viewport"]["width_px"] // 2
    hy0, hy1 = geom["horizon"]
    P, h = 2 * vw, hy1 - hy0 + 6
    im = Image.new("RGBA", (2 * P, h), (0, 0, 0, 255))
    px = im.load()
    PAL = dd.PAL
    for x in range(2 * P):
        q = x // (P // 2)
        n = q + 1
        local = (x % (P // 2)) / (P // 2)
        peak = 1 - abs(2 * ((local * n) % 1.0) - 1)
        top = int(h * 0.7 - peak * h * 0.45)
        for y in range(h):
            px[x, y] = PAL[1 if y >= top else 3] + (255,)
    for q in range(4):
        x0 = q * P // 2 + 8
        for yy in range(2, 5):
            for xx in range(x0, x0 + 6):
                px[xx, yy] = PAL[(10, 7, 9, 13)[q]] + (255,)
    im.save(path)


def build_assets(tmp):
    """Small sets that fit into the ranges of P6 2.4 and into the VRAM pool: wall 3 styles (brick, grating, window;
    demo: 4), floor 1 style, ceiling 1 style, wallpaper with half the panorama width, 4 sprite sets (blob, gem, guard, wide)."""
    A = dbeview.build_demo_assets(tmp)               # creates atlases, geometry and TOMLs in the directory
    P = lambda n: os.path.join(tmp, n)
    geom = json.load(open(P('west140.geom.json')))
    make_sky(geom, P('sky2.png'))
    wt = open(P('walls.toml')).read().replace('[[style]]\nname     = "arch"\naseprite = "window.json"\ntag      = "arch"\n', '')
    open(P('w3.toml'), 'w').write(wt)
    open(P('f1.toml'), 'w').write(dbeview.GEN_FLOOR_TOML.format(
        name="vice_floor", kind="floor", load="0xEE00", styles='[[style]]\nname = "stone"\npng = "stone_atlas.png"\n'))
    open(P('c1.toml'), 'w').write(dbeview.GEN_FLOOR_TOML.format(
        name="vice_ceil", kind="ceiling", load="0xF600", styles='[[style]]\nname = "wood"\npng = "wood_atlas.png"\n'))
    open(P('bg2.toml'), 'w').write(open(P('bg.toml')).read().replace('sky.png', 'sky2.png'))
    a = Small()
    a.dvg, a.dvg_prg, a.sprites = A.dvg, A.dvg_prg, A.sprites
    a.walls = dbetex.build_texset(dbetex.load_tex_conf(P('w3.toml')))[0]
    a.floor = dbetex.build_texset(dbetex.load_tex_conf(P('f1.toml')))[0]
    a.ceil = dbetex.build_texset(dbetex.load_tex_conf(P('c1.toml')))[0]
    dbg_prg, a.dbg_vram, _ = dbetex.build_background(dbetex.load_bg_conf(P('bg2.toml')))
    a.dbg_prg = dbg_prg
    a.dbg = dbetex.from_dbg(dbg_prg)
    a.dir = tmp
    return a


# ------------------------------------------------------------------ Map
T = dbemap.Tile
SOLID, OCC, CNT = dbeview.T_SOLID, dbeview.T_OCCLUDING, dbeview.T_CONTENT


def build_map():
    """Demo map 15 x 11: corridors, room with sky (wallpaper), grate, window wall, abyss, CONTENT door, item."""
    t = [T((0, 0, 0, 0), 1, 1, 0, 0, "corridor"),                      # 0
         T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0, "wall"),            # 1 brick
         T((0, 0, 0, 0), 0, 1, 0, 0, "abyss"),                  # 2 no floor
         T((0, 0, 0, 0), 1, 0, 0, 0, "sky"),                   # 3 no ceiling: wallpaper
         T((2, 0, 2, 0), 1, 1, SOLID, 0, "grating"),                 # 4 grate, not opaque
         T((3, 3, 3, 3), 0, 0, SOLID | OCC, 0, "window"),         # 5 window wall
         T((2, 2, 2, 2), 1, 1, SOLID | CNT, 0, "door"),             # 6 CONTENT cell (grate, objects inside)
         T((0, 0, 0, 0), 1, 1, 0, 0, "item")]               # 7 corridor with item
    rows = ["###############",
            "#.....#,,,,,,,#",
            "#.###.#,.....,#",
            "#.#:..#.......#",
            "#.#.#.+.#...#.#",
            "#...#...#.m.#.#",
            "#.#.###.#...#.#",
            "#.#...:.D.....#",
            "#.#.#.#.#...#.#",
            "#.....#.wwww..#",
            "###############"]
    leg = {'.': 0, '#': 1, ':': 2, ',': 3, '+': 4, 'w': 5, 'D': 6, 'm': 7}
    w, h = len(rows[0]), len(rows)
    cells = [leg[c] for r in rows for c in r]
    content = [0] * (w * h)
    content[5 * w + 10] = 2                                       # item 2 at 'm'
    m = dbemap.Map("vice", w, h, t, cells, content, [], 1 * w + 1, 2, 1)
    dbemap.validate(m)
    return m


W = 15


def cell(x, y):
    return y * W + x


# ------------------------------------------------------------------ Steps
class Step:
    def __init__(self, name, kind, cell=0, dir=0, action=0, objs=None, itemph=0, keep=False):
        self.name, self.kind, self.cell, self.dir, self.action = name, kind, cell, dir, action
        self.objs, self.itemph, self.keep = objs or [], itemph, keep


Obj = dbeview.Obj


def build_steps():
    """Camera cells must be walkable (no blocked(t)); build_steps checks this at the end."""
    S = []
    pos = lambda n, x, y, d, objs=None, ph=0: S.append(Step(n, 'pos', cell(x, y), d, objs=objs, itemph=ph))
    # Walls, floor, ceiling, wallpaper (without objects)
    pos('Corridor south', 1, 1, 2)
    pos('Corridor south, side corridor', 1, 4, 2)
    pos('Wall ahead (east)', 1, 1, 1)
    pos('Corridor west-east', 5, 5, 1)
    pos('Room with sky/wallpaper, east', 8, 2, 1)
    pos('Room with sky/wallpaper, south', 10, 1, 2)
    pos('Room west (wall, wallpaper)', 13, 2, 3)
    pos('Grate west', 7, 4, 3)
    pos('Grate east', 5, 4, 1)
    pos('Grate north', 6, 5, 0)
    pos('Window south d=1', 10, 8, 2)
    pos('Window south d=2', 9, 7, 2)
    pos('Window east', 7, 9, 1)                    # Review P6g: previously (8, 9) = inside the window wall
    # Abyss
    pos('Abyss east', 3, 7, 1)
    pos('Abyss north', 3, 4, 0)                   # Review P6g: previously (4, 5) = inside a wall
    pos('Abyss south', 3, 5, 2)
    pos('Abyss south 2', 5, 5, 2)
    # Item and objects (centered, clipped at the edge)
    pos('Item (content layer)', 9, 5, 1)
    pos('Blob centered d=1', 1, 1, 2, [Obj(cell(1, 2), 0, 2, 0, 4)])
    pos('Blob centered d=2 and 3', 1, 1, 2, [Obj(cell(1, 3), 0, 0, 1, 4), Obj(cell(1, 4), 0, 1, 1, 4)])
    pos('Blob subpositions', 1, 5, 2, [Obj(cell(1, 6), 0, 2, 0, q) for q in range(4)] + [Obj(cell(1, 7), 2, 0, 0, 4)])
    pos('Guard, gem, ITEMPH', 5, 1, 2, [Obj(cell(5, 3), 2, 2, 0, 4), Obj(cell(5, 2), 1, 0xFF, 1, 1)], 1)
    pos('wide, left edge d=1', 13, 2, 3, [Obj(cell(12, 3), 3, 2, 1, 4)])
    pos('wide, right edge d=1', 13, 2, 3, [Obj(cell(12, 1), 3, 2, 1, 4)])
    pos('wide, edge d=2, s=+-1', 13, 2, 3, [Obj(cell(11, 1), 3, 2, 1, 0), Obj(cell(11, 3), 3, 2, 1, 3)])
    pos('Objects in the open room', 13, 2, 3, [Obj(cell(12, 1), 0, 2, 0, 4), Obj(cell(12, 3), 0, 2, 0, 1),
                                                Obj(cell(11, 2), 2, 0, 0, 4), Obj(cell(10, 1), 3, 1, 1, 2),
                                                Obj(cell(10, 3), 0, 3, 0, 4)])
    # CONTENT cell (door with object inside)
    pos('CONTENT door empty', 11, 7, 3)
    pos('CONTENT door with blob d=3', 11, 7, 3, [Obj(cell(8, 7), 0, 1, 0, 4)])
    pos('CONTENT door with blob d=2', 10, 7, 3, [Obj(cell(8, 7), 0, 1, 0, 4)])
    pos('CONTENT door, blobs d=1', 9, 7, 3, [Obj(cell(8, 7), 0, 1, 0, 0), Obj(cell(8, 7), 0, 3, 1, 3)])
    # MOVE sequence: down the corridor, turn, against the wall, against the object
    S.append(Step('MOVE Start', 'pos', cell(1, 1), 2, objs=[Obj(cell(1, 5), 0, 2, 0, 4)]))
    for a, n in ((0, 'forward'), (0, 'forward'), (4, 'turn left'), (5, 'turn right'), (0, 'forward'), (2, 'sideways left'),
                 (0, 'forward (object blocks)'), (6, 'turn around'), (0, 'forward'), (3, 'sideways right'),
                 (1, 'back')):
        S.append(Step('MOVE ' + n, 'move', action=a, keep=True))
    m = build_map()
    for st in S:
        if st.kind == 'pos' and m.tiles[m.cells[st.cell]].flags & OCC:
            raise SystemExit(f'Scene {st.name!r}: camera in an opaque cell')
    return S


# ------------------------------------------------------------------ Scenes, expectation
def s2_layout(assets):
    """(address, content) of the sprite sets packed from $6000 (16-byte alignment); one file per set."""
    a, out = S2_START, []
    for ss in assets.sprites[:4]:
        data = dbespr.to_s2(ss)[2:]
        out.append((a, data))
        a = (a + len(data) + 15) & ~15
    if a > S2_END:
        raise SystemExit(f'S2 ({a - S2_START} bytes) does not fit in $6000-$7FFF')
    return out


class World:
    """Everything agreed between Python and VICE: files, bases, scene sequence, VRAM model."""

    def __init__(self, tmp):
        self.assets = A = build_assets(tmp)
        self.map = build_map()
        self.pack()
        self.steps = build_steps()
        self.itemtab = [0, 2, 3] + [0] * 61                        # item 1 -> set 1 (gem), 2 -> set 2 (guard)
        self.s2 = s2_layout(A)
        self.s2addr = tuple(a for a, _ in self.s2) + (0,) * 4
        self.sc0 = dbeview.make_scene(A, self.map, itemtab=self.itemtab, buf=BUF, band_cover=True, start=POOL[0])
        sc = self.sc0
        sc.vms_bank1, sc.dts_addr, sc.s2_addr = True, self.dts_addr, self.s2addr
        self.bases = copy.deepcopy(sc.vram_bases)
        end = max([b + len(d) for n, b, d in sc.assets()])
        if end > POOL[1]:
            raise SystemExit(f'VRAM pool: end {end} > {POOL[1]}')
        self.pool_end = end
        self.files = self.collect_files()
        self.vram0 = self.initial_vram()

    def pack(self):
        """File contents and their addresses in bank 1 (see HIGH)."""
        A = self.assets
        self.blob = {'dvg': dbeview.dvg_bytes(dbeview.with_band_cover(A.dvg))[2:],
                     'dts0': dbetex.to_dts(A.walls)[2:], 'dts1': dbetex.to_dts(A.floor)[2:],
                     'dts2': dbetex.to_dts(A.ceil)[2:], 'dbg': A.dbg_prg[2:], 'dmp': dbemap.to_dmp(self.map)[2:]}
        a = {'dmp': LOW['dmp'][0], 'dts0': LOW['dts0'][0]}
        p = HIGH[0]
        for n in ('dvg', 'dts2', 'dts1', 'dbg'):
            a[n] = p
            p = (p + len(self.blob[n]) + 15) & ~15
        if p - 16 + len(self.blob['dbg']) > HIGH[1] or p > HIGH[1] + 15:
            raise SystemExit(f'DVG, DTS and DBG ({p - HIGH[0]} bytes) do not fit in ${HIGH[0]:04X}-${HIGH[1] - 1:04X}')
        for n in ('dmp', 'dts0'):
            if a[n] + len(self.blob[n]) > LOW[n][1]:
                raise SystemExit(f'{n}: {len(self.blob[n])} bytes extend beyond ${LOW[n][1]:04X}')
        self.addr = a
        self.dts_addr = (a['dts0'], a['dts1'], a['dts2'])

    # --- Files (name, load address, content) for bank 1 and the VRL files
    def collect_files(self):
        A, sc = self.assets, self.sc0
        f = [(n, self.addr[n], self.blob[n], 0x10000) for n in ('dvg', 'dmp', 'dbg', 'dts0', 'dts1', 'dts2')]
        for k, (a_, d) in enumerate(self.s2):
            f.append((f's2{k}', a_, d, S2_END))
        for n, a_, d, lim in f:
            if a_ < 0x4000 or a_ + len(d) > 0xFC00 or (a_ < 0xD000 < a_ + len(d)) or (0xD000 <= a_ < 0xE000):
                raise SystemExit(f'{n}: ${a_:04X}+{len(d)} is not within $4000-$CFFF/$E000-$FBFF (type 9, Blitz! runtime)')
        # overlaps among each other
        spans = sorted((a, a + len(d), n) for n, a, d, lim in f)
        for (a0, a1, n0), (b0, b1, n1) in zip(spans, spans[1:]):
            if b0 < a1:
                raise SystemExit(f'Memory map: {n0} and {n1} overlap')
        self.bank1 = [(n, a, d) for n, a, d, lim in f]
        self.vrls = []
        for name, base, data in sc.assets():
            st = vrl.encode(list(data))
            self.vrls.append((name, base, vrl.pack_file(st, VRL_ADDR), len(st)))
        return f

    def initial_vram(self):
        """VRAM after the start of the test program (after the RXVs, before the first scene), 64 KB."""
        v = bytearray(65536)
        v[8000:9600] = bytes([0x1F]) * 1600
        v[46335:46335 + 16000] = bytes([15]) * 16000
        for name, base, data in self.sc0.assets():
            v[base:base + len(data)] = data
        return v

    # --- Scenes
    def expected(self):
        """Per step: dict(name, kind, view = dbeview.Result, scene, move = MoveResult | None, pos, dir)."""
        out, pos, v, objs, itemph = [], 0, 0, [], 0
        m = self.map
        for st in self.steps:
            mv = None
            if st.kind == 'pos':
                pos, v, objs, itemph = st.cell, st.dir, list(st.objs), st.itemph
            else:
                mv = dbemove.move(m, pos, v, objs, st.action)
                assert mv.a == 0
                pos, v = mv.pos, mv.dir
            sc = copy.copy(self.sc0)
            sc.pos, sc.dir, sc.objects, sc.itemph = pos, v, list(objs), itemph
            sc.dmp = copy.deepcopy(m)
            sc.vram_bases = copy.deepcopy(self.bases)
            res = dbeview.view(sc)
            out.append(dict(step=st, scene=sc, res=res, move=mv, pos=pos, dir=v))
        return out

    def scene_table(self):
        b = bytearray()
        for st in self.steps:
            if st.kind == 'pos':
                n = len(st.objs)
                b += bytes((0, st.cell & 255, st.cell >> 8, st.dir, st.itemph, n))
                for o in st.objs:
                    b += struct.pack('<HBBBB', o.cell, o.set, o.dir, o.phase, o.byte5())
            else:
                b += bytes((1, 0, 0, st.action, 0, 255))
        b += bytes((2, 0, 0, 0, 0, 0))
        return struct.pack('<H', SCN_ADDR) + bytes(b)


def model_run(world, exp):
    """VRAM model: run_vcl per step in sequence (state carries over). Returns: list (vram_after, paint_ref_window)."""
    vram = bytearray(world.vram0)
    out = []
    for e in exp:
        sc, res = e['scene'], e['res']
        before = bytes(vram)
        dbeview.run_vcl(res.bank0(), vram, res.p0, bank1=res.bank1())
        ref = dbeview.paint_reference(sc, bytearray(before)) if res.a == 0 else None
        out.append((bytes(vram), ref))
    return out


# ------------------------------------------------------------------ BASIC program
def basic_listing(world, fast=False):
    """test/vice/view.bas with the placeholders @LOADS@ (load files) and @SETUP@ (setter calls)."""
    sc = world.sc0
    fix = int(sc.buf_fix)
    B = world.bases
    loads = []
    for n, a, d in world.bank1:
        loads.append(f'bload"dbe.{n}",b1,u8:if ds<>0 then r=61:goto 8995')
    loads.append('bload"dbe.scn",b0,u8:if ds<>0 then r=62:goto 8995')
    for i, (name, base, f, n) in enumerate(world.vrls):
        loads.append(f'bload"dbe.v{i}",b0,u8:if ds<>0 then r=63:goto 8995')
        loads.append(f'rxv {VRL_ADDR + 5},{base}')
    calls = [(11, 0, 0, POOL[0], POOL[1]), (12, 0, 0, world.addr['dvg'], 65535)]
    for k in range(3):
        calls.append((13, k, 0, world.dts_addr[k], B['dts'][k]))
    calls.append((14, sc.bgfill, 0, world.addr['dbg'], B['dbg']))
    for k in range(4):
        calls.append((9, k, 0, world.s2addr[k], B['s2'][k]))
    for g in range(64):
        if world.itemtab[g]:
            calls.append((10, g, world.itemtab[g], 0, 0))
    calls.append((1, 0, 0, world.addr['dmp'], 0))
    calls.append((15, fix, 0, BUF[0], BUF[1]))
    setup = []
    for i, (f, x, y, p0, p1) in enumerate(calls):
        setup.append(f'p0={p0}:p1={p1}:f={f}:x={x}:y={y}:gosub 9500:if a<>0 then r={20 + i}:goto 8995')
    text = open(os.path.join(HERE, 'vice', 'view.bas')).read().replace('@VERSION@', VERSION)
    text = text.replace('@FAST@', 'fast:' if fast else '').replace('@SLOW@', 'slow' if fast else 'rem')
    if fix:                         # P6j: list always from B0, ::VCL with the constant
        text = text.replace('2120 v=peek(3072)+256*peek(3073):', f'2120 v={BUF[0]}:')
    out, n = [], 0
    for line in text.split('\n'):
        if line.strip() in ('@LOADS@', '@SETUP@'):
            body = loads if line.strip() == '@LOADS@' else setup
            for s in body:
                n += 1
                out.append(f'{300 + n}  {s}'.replace('  ', ' ', 1))
            continue
        out.append(line)
    assert 300 + n < 2000, 'too many lines for the block'
    return '\n'.join(out)


def sim_cycles(world, exp):
    """sim65 cycles per step (VIEW only, without stub): run with F = 4 minus run with F = 7 (as run_sim.time_view), with
    objects and items. Returns a list or None (without sim65)."""
    if not shutil.which('sim65'):
        return None
    sys.path.insert(0, os.path.join(HERE, 'sim'))
    import run_sim as rs
    rs.build()
    out = []
    for e in exp:
        sc = copy.copy(e['scene'])
        R = rs.ViewRunner(dbeview, dbetex)
        R.dbg_bytes = world.blob['dbg']
        sc.vms_bank1, sc.dts_addr = True, rs.P6D_ADDR['dts']
        R.setup(sc)
        base = bytes(R.scene.b)
        r = []
        for f in (4, 7):
            sn = rs.Scene()
            sn.b = bytearray(base)
            sn.call(f, p=(sc.ap, 0, 0, 0), quiet=True, **R.objargs(sc))
            r.append(rs.run(sn, R.prg).cycles)
        out.append(r[0] - r[1])
    return out


# ------------------------------------------------------------------ Disk and run
def stub_rts():
    """Address of the RTS at the end of the stub (exit of SYS 3331): label call_rts from build/stub.lbl."""
    for line in open(os.path.join(ROOT, 'build', 'stub.lbl')):
        m = re.match(r'al ([0-9A-Fa-f]+) \.call_rts$', line.strip())
        if m:
            a = int(m.group(1), 16)
            d = open(os.path.join(ROOT, 'build', STUBNAME), 'rb').read()
            assert d[2 + a - (d[0] | d[1] << 8)] == 0x60, 'RTS at call_rts not found'
            return a
    raise SystemExit('call_rts missing in build/stub.lbl')


def make_disk(world, d64, boot_prg, t_prg, workdir):
    files = [('boot', boot_prg), ('vdcbasic3', os.path.join(vs.VDC, 'vdcbasic3.bin')),
             (STUBNAME, os.path.join(ROOT, 'build', STUBNAME)), (LIBNAME, os.path.join(ROOT, 'build', LIBNAME)),
             ('t', t_prg)]
    for n, a, d in world.bank1:
        p = os.path.join(workdir, f'dbe.{n}')
        open(p, 'wb').write(struct.pack('<H', a) + d)
        files.append((f'dbe.{n}', p))
    p = os.path.join(workdir, 'dbe.scn')
    open(p, 'wb').write(world.scene_table())
    files.append(('dbe.scn', p))
    for i, (name, base, f, n) in enumerate(world.vrls):
        p = os.path.join(workdir, f'dbe.v{i}')
        open(p, 'wb').write(f)
        files.append((f'dbe.v{i}', p))
    cmd = ['c1541', '-format', 'dbe,01', 'd64', d64]
    for n, p in files:
        cmd += ['-write', p, n]
    vs.sh(cmd, stdout=subprocess.DEVNULL)


def flags(m):
    t = m.cmd('r')
    return int(re.findall(r'\.;[0-9a-f]{4}(?: [0-9a-f]{2}){6} ([01]{8})', t)[-1], 2)


def stopwatch(m):
    t = m.cmd('stopwatch')
    return int(re.search(r'Stopwatch:\s*(\d+)', t).group(1))


_LABELS = None


def vdc_labels():
    """Addresses of local labels of VDC-BASIC v3 (not in vdcbasic3.sym): ACME report of a copy in the temp directory,
    checked against vdcbasic3.bin. {'vcl', '.vcl_next_command', '.vcl_done', '.vms_arg_loop', '.vms_done'}."""
    global _LABELS
    if _LABELS:
        return _LABELS
    want = ('vcl', '.vcl_next_command', '.vcl_done', '.vms_arg_loop', '.vms_done')
    tmp = tempfile.mkdtemp()
    try:
        shutil.copytree(os.path.join(vs.VDC, 'src'), os.path.join(tmp, 'src'))
        env = dict(os.environ, ACME=os.environ.get('ACME', os.path.expanduser('~/.local/share/acme/ACME_Lib')))
        subprocess.run(['acme', '-r', 'r.txt', 'src/vdcbasic.asm'], cwd=tmp, env=env, check=True, stdout=subprocess.DEVNULL)
        if open(os.path.join(tmp, 'vdcbasic3.bin'), 'rb').read() != open(os.path.join(vs.VDC, 'vdcbasic3.bin'), 'rb').read():
            raise SystemExit('ACME build differs from vdcbasic3.bin (rebuild VDC-BASIC)')
        rep = open(os.path.join(tmp, 'r.txt'), encoding='latin-1').read().split('\n')
    finally:
        shutil.rmtree(tmp)
    out = {}
    for i, l in enumerate(rep):
        m = re.match(r'\s*\d+\s+(\S+)\s*(;.*)?$', l)
        if m and m.group(1) in want:
            for l2 in rep[i + 1:i + 6]:
                m2 = re.match(r'\s*\d+\s+([0-9a-f]{4})\s+[0-9a-f]{2}', l2)
                if m2:
                    out[m.group(1)] = int(m2.group(1), 16)
                    break
    if set(out) != set(want):
        raise SystemExit(f'Labels not found in the ACME report: {out}')
    _LABELS = out
    return out


def run_one(world, d64, boot_prg, port, tmo, exp, workdir):
    """One VICE run. Returns (rc, result list per scene, errors)."""
    syms = vm.symbols(os.path.join(vs.VDC, 'build', 'vdcbasic3.sym'))
    RTS = stub_rts()
    VD = 0x0D03
    res = {'scenes': [], 'errors': [], 'end': False}
    vramf = os.path.join(workdir, 'vram.bin')

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        m.bp(err_at)
        for a in (M_VIEW, M_DONE, M_END):
            m.bp(a)
        # End of VCL: .vcl_done (local label, from the ACME report). complex_instruction_shared_exit does not work: every
        # VMC/VMF and every VMS copy command ends there (the I flag would be free again from the first entry on).
        timing = {'vd': VD, 've': RTS, 'ce': syms['vcl'], 'cx': vdc_labels()['.vcl_done']}
        ids = {k: m.bp(a) for k, a in timing.items()}
        at = {a: k for k, a in timing.items()}
        for i in ids.values():
            m.cmd(f'disable {i}')
        t = {}
        while True:
            try:
                pc, _ = m.go()
            except vm.Exited:
                return
            if pc == err_at:
                lo, hi = m.mem(0x3B, 2)
                res['errors'].append((m.reg_x(), lo | hi << 8, len(res['scenes'])))
                m.s.sendall(b'quit\n')
                return
            elif pc == M_VIEW:
                t = {}
                m.cmd('stopwatch reset')
                for i in ids.values():
                    m.cmd(f'enable {i}')
            elif pc in at:
                k_ = at[pc]
                t[k_] = stopwatch(m)
                if k_ in ('vd', 'ce'):          # set I flag: cycles without Kernal IRQ (comparable to sim65)
                    fl = flags(m)
                    t['fl'] = fl
                    m.cmd(f'r fl = ${fl | 4:02x}')
                else:                           # exit: I flag as before (SYS/::VCL return to BASIC)
                    m.cmd(f'r fl = ${(flags(m) & ~4) | (t["fl"] & 4):02x}')
            elif pc == M_DONE:
                t['done'] = stopwatch(m)
                for i in ids.values():
                    m.cmd(f'disable {i}')
                m.cmd('bank ram00')
                pb = m.mem(0x0C00, 0x20)
                tb = m.mem(0x0C40, 8)
                buf = m.mem(BUF[0], BUF[1] - BUF[0])
                m.cmd('bank vdc')
                if os.path.exists(vramf):
                    os.remove(vramf)
                m.cmd(f'bsave "{vramf}" 0 0000 ffff')
                m.cmd('bank ram00')
                res['scenes'].append(dict(t=t, pb=pb, tb=tb, buf=buf, vram=open(vramf, 'rb').read()))
            elif pc == M_END:
                res['end'] = True

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '1500000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    return rc, res


def w16(b, i):
    return b[i] | b[i + 1] << 8


def compare(world, exp, model, got, sim=None):
    """Comparison per scene. Returns (lines, number of errors)."""
    lines, bad = [], 0
    sc0 = world.sc0
    if len(got['scenes']) != len(exp):
        lines.append(f'ERROR: {len(got["scenes"])} scenes reported, expected {len(exp)}')
        bad += 1
    for k, (e, (vram, ref), g) in enumerate(zip(exp, model, got['scenes'])):
        res, sc, st = e['res'], e['scene'], e['step']
        msg = []
        pb, tb = g['pb'], g['tb']
        if (tb[0], tb[1]) != (res.a, res.x):
            msg.append(f'A/X VICE {tb[0]}/{tb[1]} <> reference {res.a}/{res.x}')
        if w16(pb, 0x0A) != res.p0 or w16(pb, 0x0C) != res.vcllen or w16(pb, 0x0E) != res.vmslen or w16(pb, 0x10) != res.objvis:
            msg.append(f'VCLADR/VCLLEN/VMSLEN/OBJVIS VICE {[hex(w16(pb, i)) for i in (0x0A, 0x0C, 0x0E, 0x10)]} <> '
                       f'{[hex(res.p0), hex(res.vcllen), hex(res.vmslen), hex(res.objvis)]}')
        mv = e['move']
        if mv is not None and (tb[2], tb[3], tb[4], w16(tb, 5)) != (mv.a, mv.x, mv.y, mv.p0):
            msg.append(f'MOVE VICE A/X/Y/P0 {tb[2]}/{tb[3]}/{tb[4]}/{w16(tb, 5)} <> {mv.a}/{mv.x}/{mv.y}/{mv.p0}')
        # Buffer: VCL list [VCLADR, B1) and VMS lists [B0, B0 + VMSLEN) as in the reference
        buf, b0 = g['buf'], BUF[0]
        vcl = bytes(buf[res.l0 - b0:res.l0 - b0 + len(res.vcl)])
        vms = bytes(buf[res.m0 - b0:res.m0 - b0 + len(res.vms)])
        if res.fix and bytes(buf[0:3]) != res.jump():
            msg.append(f'Jump at B0 {bytes(buf[0:3]).hex()} <> {res.jump().hex()}')
        if vcl != res.vcl or vms != res.vms:
            msg.append('buffer (VCL/VMS) differs from the reference')
        # VRAM: whole (64 KB) against the model, window against paint_reference
        v = g['vram']
        if v != vram:
            idx = [i for i in range(65536) if v[i] != vram[i]]
            msg.append(f'VRAM {len(idx)} bytes wrong, first ${idx[0]:04X}: VICE {v[idx[0]]:02X} <> model {vram[idx[0]]:02X}')
        pix = ref is None or dbeview.window_bytes(sc, v) == dbeview.window_bytes(sc, ref)
        t = g['t']
        cyc = dict(view=t['ve'] - t['vd'], vcl=t['cx'] - t['ce'], total=t['done'])
        cyc['sum'] = cyc['view'] + cyc['vcl']
        cyc['sim'] = sim[k] if sim else 0
        g['cyc'] = cyc
        ok = not msg
        bad += not ok
        lines.append(dict(k=k, name=st.name, kind=st.kind, a=res.a, x=res.x, items=res.items, nv=res.vcllen, nm=res.vmslen,
                          pix=ok and v == vram, ref=('-' if ref is None else ('yes' if pix else 'NO')), cyc=cyc, msg=msg, ok=ok))
        if ref is not None and not pix:
            lines[-1]['msg'].append('window differs from paint_reference (VICE = run_vcl model: '
                                    + ('yes' if v == vram else 'no') + ')')
    return lines, bad


def report(name, lines, bad):
    """Cycles: monitor stopwatch (clocks at 1 MHz). Columns with 2M: run with FAST (2 MHz, VIC off), if present."""
    two = any(isinstance(L, dict) and 'cyc2' in L for L in lines)
    print(f'--- {name}')
    print(f'{"#":>2} {"Scene":<34} {"A":>1} {"X":>3} {"VCL":>4} {"VMS":>5} {"Model":>6} {"Ref":>4} {"VIEW":>7} {"VCL":>9} '
          f'{"VIEW+VCL":>9} {"with BASIC":>9} {"sim65":>7}' + (f' | {"VIEW 2M":>7} {"VCL 2M":>9} {"V+V 2M":>9}' if two else ''))
    for L in lines:
        if not isinstance(L, dict):
            print(L)
            continue
        c = L['cyc']
        print(f'{L["k"]:>2} {L["name"]:<34} {L["a"]:>1} {L["x"]:>3} {L["nv"]:>4} {L["nm"]:>5} '
              f'{"yes" if L["pix"] else "NO":>6} {L["ref"]:>4} {c["view"]:>7} {c["vcl"]:>9} {c["sum"]:>9} {c["total"]:>9} {c["sim"] or "-":>7}' +
              (f' | {L["cyc2"]["view"]:>7} {L["cyc2"]["vcl"]:>9} {L["cyc2"]["sum"]:>9}' if 'cyc2' in L else ''))
        for m_ in L['msg']:
            print('      ', m_)
    ds = [L for L in lines if isinstance(L, dict)]
    if ds:
        n = len(ds)
        for key, lab in (('view', 'VIEW'), ('vcl', 'VCL'), ('sum', 'VIEW+VCL'), ('total', 'with BASIC'), ('sim', 'sim65')):
            vals = [L['cyc'][key] for L in ds]
            if not any(vals):
                continue
            print(f'    {lab:<10} mean {sum(vals) // n:>9}  min {min(vals):>9}  max {max(vals):>9}')
        if two:
            for key, lab in (('view', 'VIEW'), ('vcl', 'VCL'), ('sum', 'VIEW+VCL')):
                v1 = [L['cyc'][key] for L in ds]
                v2 = [L['cyc2'][key] for L in ds]
                print(f'    {lab + " 2 MHz":<14} mean {sum(v2) // n:>9}  min {min(v2):>9}  max {max(v2):>9}'
                      f'  (ratio to 1 MHz {sum(v2) / sum(v1):.2f})')
    print(f'    {"all equal" if not bad else str(bad) + " errors"}', flush=True)


def check_only(world, exp, model, png=None):
    bad = 0
    for k, (e, (vram, ref)) in enumerate(zip(exp, model)):
        res = e['res']
        note = ''
        if res.a != 0:
            note = f' A={res.a}'
        if ref is not None and dbeview.window_bytes(e['scene'], vram) != dbeview.window_bytes(e['scene'], ref):
            note += ' paint_reference differs'
            bad += 1
        print(f'{k:>2} {e["step"].name:<34} pos {e["pos"]:>3} dir {e["dir"]} VCL {res.vcllen:>4} VMS {res.vmslen:>5} '
              f'entries {res.x:>3} objvis {res.objvis:#06x}{note}')
    if png:
        os.makedirs(png, exist_ok=True)
        ims = [dbeview.window_image(e['scene'], vram, 2) for e, (vram, ref) in zip(exp, model)]
        cols = 6
        w, h = ims[0].size
        sheet = Image.new('RGB', (cols * (w + 4), ((len(ims) + cols - 1) // cols) * (h + 4)), (40, 40, 40))
        for i, im in enumerate(ims):
            sheet.paste(im, ((i % cols) * (w + 4), (i // cols) * (h + 4)))
        sheet.save(os.path.join(png, 'scenes.png'))
    print('Memory map:', ', '.join(f'{n} ${a:04X}-${a + len(d) - 1:04X}' for n, a, d in sorted(world.bank1, key=lambda x: x[1])))
    print(f'VRAM pool: ${POOL[0]:04X}-${world.pool_end - 1:04X} of {POOL[0]}-{POOL[1] - 1}, '
          f'bases {world.bases}')
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--only', choices='ic')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--png')
    ap.add_argument('--control', action='store_true',
                    help='control run: corrupt one byte in the window of the model of scene 5; the run must report exactly this scene')
    ap.add_argument('--no-sim', action='store_true', help='no sim65 cross-measurement')
    ap.add_argument('--byte-edges', action='store_true', help='demo geometry with byte_edges = true (edges on whole bytes)')
    ap.add_argument('--no-fast', action='store_true', help='without the second run at 2 MHz (FAST)')
    ap.add_argument('--fix', action='store_true', help='P6j: fixed list address (BUFSET X = 1, ::VCL B0)')
    a = ap.parse_args()
    vs.sh(['sh', os.path.join(ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)
    if a.byte_edges:
        os.environ['DBE_BYTE_EDGES'] = '1'           # dbetexdemo.default_geom
    tmp = tempfile.TemporaryDirectory()
    world = World(tmp.name)
    world.sc0.buf_fix = a.fix
    exp = world.expected()
    model = model_run(world, exp)
    if a.check or a.png:
        sys.exit(1 if check_only(world, exp, model, a.png) else 0)
    if a.control:
        v = bytearray(model[5][0])
        v[3 * 80 + 10] ^= 0x11
        model[5] = (bytes(v), model[5][1])
    sim = None if a.no_sim else sim_cycles(world, exp)
    os.makedirs(OUT, exist_ok=True)
    port = vm.choose_port(a.port)
    boot_bas = os.path.join(OUT, 'boot.bas')
    with open(os.path.join(vs.VDC, 'boot', 'boot.bas')) as f:
        lines = [('50 RUN"T"\n' if l.startswith('50 ') else l) for l in f]
    open(boot_bas, 'w').write(''.join(lines))
    boot_prg = os.path.join(OUT, 'boot.prg')
    vs.tok(boot_bas, boot_prg)
    wd = os.path.join(OUT, 'view-files')
    shutil.rmtree(wd, ignore_errors=True)
    os.makedirs(wd)
    bad = 0
    node, blitzc = vm.find_node(), vm.find_blitzc()

    def build(compiled, fast):
        """Build the program (interpreted: tokenized from $4001; compiled: Blitz!). Returns PRG or None."""
        suf = ('c' if compiled else 'i') + ('f' if fast else '')
        src_bas = os.path.join(OUT, f'view{"-f" if fast else ""}.bas')
        open(src_bas, 'w').write(basic_listing(world, fast))
        if not compiled:
            prg = os.path.join(OUT, f'view-{suf}.prg')
            vs.tok(src_bas, prg, '0x4001')
            return prg
        prep = os.path.join(OUT, f'view-b{"f" if fast else ""}.bas')
        vs.sh(['python3', '-B', os.path.join(vs.VDC, 'test', 'blitzprep.py'), src_bas, prep])
        src = os.path.join(OUT, f'view-src{"f" if fast else ""}.prg')
        vs.tok(prep, src)
        cdir = os.path.join(OUT, f'view-blitz{"-f" if fast else ""}')
        shutil.rmtree(cdir, ignore_errors=True)
        c = subprocess.run([node, blitzc, src, cdir, '--name', 'T', '--runtime', os.environ.get('BLITZ_RUNTIME', 'improved')], capture_output=True, text=True)
        cprg = os.path.join(cdir, 'c.prg')
        if c.returncode or not os.path.exists(cprg) or open(cprg, 'rb').read(2) != b'\x01\x40':
            print(f'compiled: compiler rc {c.returncode}: {c.stdout.strip()}')
            scr = os.path.join(cdir, 'screen.txt')
            if os.path.exists(scr):
                print(open(scr).read())
            return None
        return cprg

    def one(compiled, fast):
        """One run. Returns (lines, number of errors, error bit) or None if the program could not be built."""
        prg = build(compiled, fast)
        if prg is None:
            return None
        d64 = os.path.join(OUT, f'view-{"c" if compiled else "i"}{"f" if fast else ""}.d64')
        make_disk(world, d64, boot_prg, prg, wd)
        rc, got = run_one(world, d64, boot_prg, port, a.timeout, exp, wd)
        what = 'compiled (Blitz!, image 2)' if compiled else 'interpreted'
        print(f'{what}{", 2 MHz (FAST)" if fast else ""}: exit {rc}, BASIC error {got["errors"]}, end reached {got["end"]}')
        lines_, b = compare(world, exp, model, got, sim)
        return lines_, b, (rc != 0) | (b != (1 if a.control else 0)) | bool(got['errors']) | (not got['end'])

    for compiled in (False, True):
        if (a.only == 'c' and not compiled) or (a.only == 'i' and compiled):
            continue
        if compiled and (not node or not blitzc):
            print('compiled: SKIP (blitzc not found)')
            bad |= 2
            continue
        r1 = one(compiled, False)
        if r1 is None:
            bad |= 1
            continue
        lines1, b1, e1 = r1
        bad |= e1
        name = 'compiled (Blitz!, image 2)' if compiled else 'interpreted'
        if not a.no_fast:
            # Second run with FAST (2 MHz, VIC display off during VIEW and VCL): same check, cycles as cyc2
            r2 = one(compiled, True)
            if r2 is None:
                bad |= 1
            else:
                lines2, b2, e2 = r2
                bad |= e2
                for L1, L2 in zip(lines1, lines2):
                    if isinstance(L1, dict) and isinstance(L2, dict):
                        L1['cyc2'] = L2['cyc']
                        L1['msg'] += [f'(2 MHz) {m_}' for m_ in L2['msg']]
        report(name, lines1, b1)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
