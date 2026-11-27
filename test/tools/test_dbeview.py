"""Tests for tools/dbeview.py (docs/specs/P6-engine.md, sections 5 and 9; P6b).

Pixel check: run_vcl(view(scene)) == paint_reference(scene) in the view window; no byte outside the window
modified (whole 64 KB field with random content). Full random set (200 maps x 20 views):
environment variable DBEVIEW_FULL=1.
"""
import copy
import os
import random
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import dbegeom  # noqa: E402
import dbemap  # noqa: E402
import dbetex  # noqa: E402
import dbeview  # noqa: E402
import vrl  # noqa: E402

try:
    import dbespr  # noqa: E402
except Exception:       # pragma: no cover
    dbespr = None

DEMO_MAP = os.path.join(ROOT, "docs", "specs", "examples", "demo.toml")
DBEVIEW = os.path.join(ROOT, "tools", "dbeview.py")
BIG = (0x0200, 0x1C00)          # large buffer: pixel tests without overflow
HUGE = (0x0200, 0x4200)         # for extreme scenes (tile pattern with holes in every byte)
FULL = bool(os.environ.get("DBEVIEW_FULL"))


class Env:
    _inst = None

    @classmethod
    def get(cls):
        if cls._inst is None:
            cls._inst = cls()
        return cls._inst

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.assets = dbeview.build_demo_assets(self.tmp.name)
        self.demo = dbemap.load_toml(DEMO_MAP)


def env():
    return Env.get()


def outside_unchanged(case, sc, before, after, msg=""):
    g = sc.dvg
    tmp = bytearray(before)
    for y in range(g.vh):
        a = (sc.ap + g.row(y)) & 0xFFFF
        if a + g.vw <= 65536:
            tmp[a:a + g.vw] = after[a:a + g.vw]
        else:
            for x in range(g.vw):
                tmp[(a + x) & 0xFFFF] = after[(a + x) & 0xFFFF]
    case.assertTrue(tmp == after, "Byte outside the view window modified " + msg)


def first_diff(sc, a, b):
    A, B = dbeview.window_bytes(sc, a), dbeview.window_bytes(sc, b)
    for y in range(len(A)):
        for x in range(len(A[0])):
            if A[y][x] != B[y][x]:
                return f"first difference at row {y}, column {x}: view {A[y][x]:02x} / reference {B[y][x]:02x}"
    return None


def check_pixels(case, sc, seed=0, msg="", expect_ok=True):
    """view -> run_vcl against paint_reference; returns Result."""
    res = dbeview.view(sc)
    if expect_ok:
        case.assertEqual(res.a, 0, msg)
    vram = sc.make_vram(seed)
    before = bytes(vram)
    dbeview.render_view(sc, vram, res)
    outside_unchanged(case, sc, before, vram, msg)
    ref = dbeview.paint_reference(sc, bytearray(before))
    outside_unchanged(case, sc, before, ref, "(paint_reference) " + msg)
    d = first_diff(sc, vram, ref)
    case.assertIsNone(d, f"{msg}: {d}")
    return res


def mk_map(rows, tiles, legend, outside=0, start=None, direction=0, content=None):
    m = dbemap.Map("t", len(rows[0]), len(rows), tiles, [legend[ch] for r in rows for ch in r],
                   content or [0] * (len(rows) * len(rows[0])), [], 0, direction, outside)
    m.start = start if start is not None else next(
        i for i, c in enumerate(m.cells) if not tiles[c].flags & dbeview.T_SOLID)
    dbemap.validate(m)
    return m


T = dbemap.Tile
SOLID, OCC, CNT = dbeview.T_SOLID, dbeview.T_OCCLUDING, dbeview.T_CONTENT


def open_room(w=13, h=13, floor=1, ceil=1):
    t = [T((0, 0, 0, 0), floor, ceil, 0, 0)]
    return mk_map(["." * w] * h, t, {".": 0}, start=(h // 2) * w + w // 2)


# ---------------------------------------------------------------- DVG, scene

class TestDvg(unittest.TestCase):
    def test_header_and_depth(self):
        g = env().assets.dvg
        self.assertEqual((g.vw, g.vh, g.D, g.stride, g.hy0, g.hy1), (70, 96, 3, 80, 22, 45))
        self.assertEqual(len(g.elems), 79)
        self.assertEqual([(d.cy0, d.cy1, d.fy0, d.fy1) for d in g.depth],
                         [(0, 6, 83, 96), (6, 13, 64, 83), (13, 19, 51, 64), (19, 22, 45, 51)])
        front = [e for e in g.elems if e.art == dbeview.ART_FRONT and (e.d, e.s) == (1, -1)][0]
        self.assertEqual((front.x, front.y, front.w, front.h, front.src_dx), (0, 6, 10, 77, 40))
        obj = [e for e in g.elems if e.art == dbeview.ART_OBJ and (e.d, e.s) == (1, 0)][0]
        self.assertEqual(obj.anchors, [(26, 67), (44, 67), (35, 71), (24, 76), (46, 76)])

    def test_bad_dvg(self):
        with self.assertRaises(dbeview.ViewError):
            dbeview.parse_dvg(b"\0\0XX" + bytes(30))

    def test_band_cover_flag_variant(self):
        g = dbeview.with_band_cover(env().assets.dvg)
        fr = [e for e in g.elems if e.art == dbeview.ART_FRONT]
        self.assertTrue(all(e.flags & 8 for e in fr))
        # dbegeom sets bit 3 since P6h on all fronts that contain the band rows (all fronts of the demo)
        self.assertTrue(all(e.flags & 8 for e in env().assets.dvg.elems if e.art == dbeview.ART_FRONT))
        self.assertFalse(any(e.flags & 8 for e in dbeview.without_band_cover(env().assets.dvg).elems))

    def test_cells_contiguous(self):
        sc = dbeview.make_scene(env().assets, env().demo)
        self.assertEqual([s for s, _ in dbeview._Ctx(sc).cells_of(1)][:3], [0, -1, 1])
        sc.dvg = copy.deepcopy(sc.dvg)
        dt = sc.dvg.depth[1]
        sc.dvg.elems[dt.first + dt.n - 1].s = 0          # last element of the depth to cell s = 0
        with self.assertRaises(dbeview.ViewError):
            dbeview._Ctx(sc).cells_of(1)

    def test_layout_checks(self):
        sc = dbeview.make_scene(env().assets, env().demo)
        self.assertGreaterEqual(min(b for n, b, d in sc.assets()), 7670)
        sc.vram_bases["dbg"] = 10
        with self.assertRaises(dbeview.ViewError):
            sc.check_layout()


# ---------------------------------------------------------------- VCL interpreter

class TestRunVcl(unittest.TestCase):
    def setUp(self):
        self.vram = bytearray(range(256)) * 256
        self.b0 = bytearray(65536)

    def run_(self, data, at=0x1300):
        self.b0[at:at + len(data)] = bytes(data)
        return dbeview.run_vcl(self.b0, self.vram, at)

    @staticmethod
    def w(*vals):
        return b"".join(struct.pack("<H", v & 0xFFFF) for v in vals)

    def test_type1_2_3(self):
        v0 = bytes(self.vram)
        self.run_(b"\x01" + self.w(100, 5000, 4) + b"\0")
        self.assertEqual(self.vram[5000:5004], v0[100:104])
        self.run_(b"\x02" + self.w(1000, 6000, 3, 2, 80) + b"\0")          # packed: source consecutive
        self.assertEqual(self.vram[6000:6003], v0[1000:1003])
        self.assertEqual(self.vram[6080:6083], v0[1003:1006])
        self.run_(b"\x03" + self.w(1000, 7000, 3, 2, 80, 40) + b"\0")      # source step 40
        self.assertEqual(self.vram[7080:7083], v0[1040:1043])
        self.run_(b"\x03" + self.w(1000, 8160, 2, 3, -80, 10) + b"\0")     # negative destination step
        self.assertEqual(self.vram[8000:8002], v0[1020:1022])
        self.assertEqual(self.vram[8160:8162], v0[1000:1002])

    def test_reps_zero_is_256_and_count_zero(self):
        self.vram[:] = bytes(65536)
        self.vram[0] = 7
        self.run_(b"\x02" + self.w(0, 9000, 1, 0, 1) + b"\0")             # reps 0 = 256 repetitions
        self.assertEqual(self.vram[9000:9256], bytes([7]) + bytes(255))
        v0 = bytes(self.vram)
        self.run_(b"\x01" + self.w(0, 9500, 0) + b"\0")                     # count 0 copies nothing
        self.assertEqual(bytes(self.vram), v0)

    def test_overlap_smears_forward(self):
        self.vram[:] = bytes(65536)
        self.vram[100] = 9
        self.run_(b"\x01" + self.w(100, 101, 5) + b"\0")
        self.assertEqual(self.vram[100:106], bytes([9] * 6))

    def test_fill_and_pokes(self):
        self.run_(b"\x04" + self.w(300, 0x1AB, 5) + b"\x05" + self.w(400, 0x11, 2, 3, 80) + b"\x06" + self.w(900, 0x2C)
                  + b"\x07" + self.w(1000, 0x5E, 4, 10) + b"\0")
        self.assertEqual(self.vram[300:305], bytes([0xAB] * 5))
        for r in range(3):
            self.assertEqual(self.vram[400 + 80 * r:402 + 80 * r], bytes([0x11, 0x11]))
        self.assertEqual(self.vram[900], 0x2C)
        self.assertEqual([self.vram[1000 + 10 * i] for i in range(4)], [0x5E] * 4)

    def test_syn_is_noop_and_returns_count(self):
        v0 = bytes(self.vram)
        n = self.run_(b"\x0d" + self.w(0) + b"\x0d" + self.w(2, 12, 64, 13, 0) + b"\0")
        self.assertEqual(n, 2)
        self.assertEqual(bytes(self.vram), v0)

    def test_vms_types(self):
        self.vram[:] = bytes(65536)
        self.vram[2000:2008] = bytes([0x51, 0x11, 0x15, 0x22, 0x22, 0x33, 0x44, 0x55])
        for i in range(0, 200):
            self.vram[5000 + i] = 0xA7
        # example from vms-format.md (alpha 5), Ziel 5000
        lst = bytes([5, 4, 0, 8, 0, 0, 1, 1, 0, 1, 8, 2, 0, 1, 80, 0, 2])
        self.b0[0x1400:0x1400 + len(lst)] = lst
        self.run_(b"\x0c" + self.w(2000, 5000, 0x1400) + b"\0")
        # Byte 0x51: right pixel 1 != alpha 5 -> right from the image, left (A) from the screen
        self.assertEqual(self.vram[5000], 0xA1)
        self.assertEqual(self.vram[5001], 0x11)
        self.assertEqual(self.vram[5002], 0x17)         # 0x15: right pixel = alpha -> left (1) from the image, right (7) from the screen
        self.assertEqual(self.vram[5080:5082], bytes([0x22, 0x22]))

    def test_vms_type3_skip(self):
        self.vram[:] = bytes(65536)
        self.vram[2000:2005] = bytes([0x51, 0x11, 0x15, 0x22, 0x22])
        lst = bytes([5, 2, 0, 3, 3, 0, 1, 0, 0, 2])               # example "first row cut off"
        self.b0[0x1400:0x1400 + len(lst)] = lst
        self.run_(b"\x0c" + self.w(2000, 5000, 0x1400) + b"\0")
        self.assertEqual(self.vram[5000:5003], bytes([0x22, 0x22, 0]))

    def test_vms_type2_and_bad(self):
        self.vram[:] = bytes(range(256)) * 256
        lst = bytes([0, 1, 0, 2, 3, 0, 2, 0])
        self.b0[0x1400:0x1400 + len(lst)] = lst
        self.run_(b"\x0c" + self.w(100, 5000, 0x1400) + b"\0")
        self.assertEqual(self.vram[5000:5003], self.vram[100:103])
        self.assertEqual(self.vram[5080:5083], self.vram[103:106])
        self.b0[0x1400:0x1404] = bytes([0, 1, 0, 9])
        with self.assertRaises(dbeview.ViewError):
            self.run_(b"\x0c" + self.w(100, 5000, 0x1400) + b"\0")

    def test_rxv_and_unknown(self):
        stream = vrl.encode([1, 2, 3, 3, 3, 3, vrl.SKIP, 9])
        self.b0[0x1500:0x1500 + len(stream)] = stream
        self.vram[:] = bytes(65536)
        self.vram[7] = 0xEE
        self.run_(b"\x08" + self.w(0x1500, 6) + b"\0")
        self.assertEqual(self.vram[6:13], bytes([1, 2, 3, 3, 3, 3, 0]))
        with self.assertRaises(dbeview.ViewError):
            self.run_(b"\x09\0")

    def test_decode_vcl_roundtrip(self):
        data = b"\x02" + self.w(1, 2, 3, 4, 5) + b"\x0c" + self.w(6, 7, 8) + b"\x04" + self.w(1, 2, 3) + b"\0"
        self.assertEqual(dbeview.decode_vcl(data), [(2, 1, 2, 3, 4, 5), (12, 6, 7, 8), (4, 1, 2, 3)])


# ---------------------------------------------------------------- Clipping

class FakeImg:
    def __init__(self, w, h, cores, vms):
        self.w, self.h, self.cores, self.vms = w, h, cores, vms


class TestClip(unittest.TestCase):
    def sprite(self):
        ss = env().assets.sprites[0]
        return ss, [i for i in ss.images if i.vms and i.cores][0]

    def test_clip_matches_p5b_text(self):
        """Clipped rendering = expected image in the section, rest unchanged; list only type 1/3/8."""
        ss, img = self.sprite()
        stride = 80
        rnd = random.Random(5)
        vram0 = bytearray(rnd.getrandbits(8) for _ in range(65536))
        vb = 0x4000
        vram0[vb:vb + len(ss.vram)] = ss.vram
        x0, y0 = 10, 20
        full = bytearray(vram0)
        dbetex.sim_vmc  # noqa: B018
        cores, vms, ref = dbeview.clip_image(img, stride, x0, y0, x0, x0 + img.w, y0, y0 + img.h)
        self.assertEqual(vms, bytes(img.vms))
        for src, x, y, w, reps, st in cores:
            dbeview.vmc(full, vb + src, y * stride + x, w, reps, stride, st)
        bank0 = bytearray(65536)
        bank0[0x1400:0x1400 + len(vms)] = vms
        dbeview.vms(bank0, full, vb + img.edge_ofs, ref[1] * stride + ref[0], 0x1400)
        for L, R in [(0, img.w), (1, img.w), (img.w // 2, img.w - 1), (0, 1), (img.w - 1, img.w)]:
            for Tt, B in [(0, img.h), (1, img.h), (0, img.h - 1), (img.h - 1, img.h), (3, 7)]:
                if L >= R or Tt >= B:
                    continue
                vr = bytearray(vram0)
                cores, vms, ref = dbeview.clip_image(img, stride, x0, y0, x0 + L, x0 + R, y0 + Tt, y0 + B)
                for src, x, y, w, reps, st in cores:
                    dbeview.vmc(vr, vb + src, y * stride + x, w, reps, stride, st)
                if vms:
                    cmds, p = [], 3
                    while p < len(vms):
                        t = vms[p]
                        cmds.append(t)
                        p += 4 if t == 1 else 3
                    self.assertNotEqual(cmds[-1], 3, "Type 3 am Ende")
                    self.assertFalse(any(a == b == 3 for a, b in zip(cmds, cmds[1:])))
                    self.assertTrue(set(cmds) <= {1, 3, 8})
                    bank0[0x1400:0x1400 + len(vms)] = vms
                    dbeview.vms(bank0, vr, vb + img.edge_ofs, ref[1] * stride + ref[0], 0x1400)
                # expectation: section of the unclipped image, otherwise background
                for r in range(img.h):
                    for c in range(img.w):
                        a = (y0 + r) * stride + x0 + c
                        want = full[a] if (L <= c < R and Tt <= r < B) else vram0[a]
                        self.assertEqual(vr[a], want, f"L{L} R{R} T{Tt} B{B} row {r} column {c}")

    @unittest.skipIf(dbespr is None or not hasattr(dbespr, "clip_image"), "dbespr.clip_image missing")
    def test_clip_equals_dbespr(self):
        for ss in env().assets.sprites[:4]:
            for img in ss.images:
                for L, R, Tt, B in [(0, img.w, 0, img.h), (1, img.w - 1, 2, img.h), (0, img.w // 2 + 1, 0, 3),
                                    (img.w // 2, img.w, 1, img.h - 1)]:
                    if L >= R or Tt >= B:
                        continue
                    cores, vms, ref = dbeview.clip_image(img, 80, 5, 7, 5 + L, 5 + R, 7 + Tt, 7 + B)
                    c = dbespr.clip_image(img, 5, 7, 5 + L, 5 + R, 7 + Tt, 7 + B, 80)
                    self.assertEqual(cores, [tuple(k) for k in c.cores])
                    self.assertEqual(vms, c.vms)
                    self.assertEqual(ref, tuple(c.ref))

    def test_srcstep_rule(self):
        k = dbetex.Core(src=100, dx=2, dy=1, w=6, h=4, srcstep=0)
        img = FakeImg(10, 8, [k], b"")
        full = dbeview.clip_image(img, 80, 0, 0, 0, 10, 0, 8)[0]
        self.assertEqual(full, [(100, 2, 1, 6, 4, 0)])
        rows = dbeview.clip_image(img, 80, 0, 0, 0, 10, 2, 8)[0]            # T > 0, full width: stays type 2
        self.assertEqual(rows, [(106, 2, 2, 6, 3, 0)])
        cut = dbeview.clip_image(img, 80, 0, 0, 3, 10, 0, 8)[0]             # width cut: srcstep = kw
        self.assertEqual(cut, [(101, 3, 1, 5, 4, 6)])
        k2 = dbetex.Core(src=100, dx=2, dy=1, w=6, h=4, srcstep=20)
        c2 = dbeview.clip_image(FakeImg(10, 8, [k2], b""), 80, 0, 0, 0, 10, 2, 8)[0]
        self.assertEqual(c2, [(120, 2, 2, 6, 3, 20)])


# ---------------------------------------------------------------- Structure of the list

class TestResult(unittest.TestCase):
    def test_demo_structure(self):
        """Single pass (P6d-opt): VMS lists upwards from B0, VCL list downwards to B1 (end byte at B1 - 1)."""
        sc = dbeview.make_scene(env().assets, env().demo)
        res = dbeview.view(sc)
        self.assertEqual((res.a, res.y, res.p0, res.b0), (0, 0, 0x1C00 - res.vcllen, 0x1300))
        self.assertEqual(res.vcllen, len(res.vcl))
        self.assertEqual(res.vmslen, len(res.vms))
        self.assertEqual(res.vcl[-1], 0)
        ents = dbeview.decode_vcl(res.buffer)
        self.assertEqual(res.x, len(ents))
        sizes = {2: 11, 3: 13, 4: 7, 5: 11, 12: 7}
        self.assertEqual(sum(sizes[e[0]] for e in ents) + 1, res.vcllen)
        # VMS pointers: in generation order (= backwards through the VCL list) consecutive from B0
        b0 = res.bank0()
        ptr = res.b0
        for e in reversed(ents):
            if e[0] == 12:
                self.assertEqual(e[3], ptr)
                lst = b0[ptr:]
                n = lst[1] | lst[2] << 8
                p = 3
                for _ in range(n):
                    p += {1: 4, 8: 3, 3: 3}[lst[p]]
                ptr += p
        self.assertEqual(ptr, res.b0 + res.vmslen)
        self.assertEqual(b0[0x1C00 - 1], 0)
        self.assertLessEqual(res.b0 + res.vmslen, res.p0)

    def test_deterministic_and_custom_buffer(self):
        sc = dbeview.make_scene(env().assets, env().demo)
        a, b = dbeview.view(sc), dbeview.view(sc)
        self.assertEqual((a.vcl, a.vms, a.objvis), (b.vcl, b.vms, b.objvis))
        sc.buf = (0x0800, 0x1A00)
        c = dbeview.view(sc)
        self.assertEqual((c.p0, c.b0), (0x1A00 - len(c.vcl), 0x0800))
        self.assertEqual(len(c.vcl), len(a.vcl))
        # VMS addresses shifted, otherwise equal
        da, dc = dbeview.decode_vcl(a.buffer), dbeview.decode_vcl(c.buffer)
        self.assertEqual([e[:3] for e in da], [e[:3] for e in dc])
        self.assertEqual(a.vms, c.vms)

    def test_vms_bank1(self):
        """Standard build (vms_bank1): unclipped lists (walls, bands, sprites) as VCL type 9 with
        bank 1 address, no buffer bytes; clipped lists remain in the buffer (type 12); image same as VMS_COPY."""
        e = env()
        n9, n9s = 0, 0
        rnd = random.Random(9)
        s2a, a = [], 0x4000                     # S2 packed from $4000 (the demo DTS extend beyond their ranges)
        for ss in e.assets.sprites:
            s2a.append(a if ss is not None else 0)
            a += len(dbeview._s2_content(ss)) if ss is not None else 0
        s2a += [0] * (8 - len(s2a))
        cases = [(9, 0, 0), (9, 1, 0), (16, 2, 0), (22, 3, 0), (9, 0, 5), (16, 2, 5), (22, 1, 5), (9, 3, 5)]
        for k, (i, v, nobj) in enumerate(cases):
            objs = dbeview.random_objects(rnd, e.demo, i, v, nobj)
            sc = dbeview.make_scene(e.assets, e.demo, i, v, objs, [0, 2, 3, 2] + [0] * 60)
            ref = dbeview.view(sc)
            sc1 = copy.copy(sc)
            sc1.vms_bank1, sc1.s2_addr = True, tuple(s2a)
            res = dbeview.view(sc1)
            ents = dbeview.decode_vcl(res.buffer)
            n9 += sum(1 for x in ents if x[0] == 9)
            n9s += sum(1 for x in ents if x[0] == 9 and 0x4000 <= x[3] < a)
            self.assertEqual(len(ents), len(dbeview.decode_vcl(ref.buffer)))
            self.assertLessEqual(res.vmslen, ref.vmslen)
            self.assertEqual(res.objvis, ref.objvis)
            for x in ents:
                if x[0] == 9:
                    self.assertIn(x[3], res.lists1)
            check_pixels(self, sc1, k, f"vms_bank1 {i}/{v}/{nobj}")
        self.assertGreater(n9, 0)
        self.assertGreater(n9s, 0)                  # unclipped sprites as type 9

    def test_back_to_front_order(self):
        """The last entry (front) is later in the list than the first (back): first entries = wallpaper."""
        sc = dbeview.make_scene(env().assets, env().demo)
        ents = dbeview.decode_vcl(dbeview.view(sc).buffer)
        self.assertIn(ents[0][0], (3, 4, 5))            # wallpaper/floor/ceiling first


# ---------------------------------------------------------------- Pixel check

class TestDemoPixels(unittest.TestCase):
    def free_views(self):
        m = env().demo
        return [(i, v) for i, c in enumerate(m.cells) if not m.tiles[c].flags & SOLID for v in range(4)]

    def test_all_free_cells_no_objects(self):
        for bc in (False, True):
            for i, v in self.free_views():
                sc = dbeview.make_scene(env().assets, env().demo, i, v, band_cover=bc)
                check_pixels(self, sc, i * 4 + v, f"Cell {i} direction {v} band_cover {bc}")

    def test_all_free_cells_with_objects(self):
        rnd = random.Random(2025)
        m = env().demo
        for n in (1, 5):
            for i, v in self.free_views():
                objs = dbeview.random_objects(rnd, m, i, v, n)
                sc = dbeview.make_scene(env().assets, m, i, v, objs, [0, 2, 3] + [0] * 61, i % 4,
                                        band_cover=bool((i + v) & 1), buf=BIG)
                check_pixels(self, sc, i * 4 + v, f"Cell {i} direction {v} Objects {n}")

    def test_no_dbg_uses_fill_byte(self):
        sc = dbeview.make_scene(env().assets, env().demo, dbg=False, bgfill=0x5A)
        res = check_pixels(self, sc)
        self.assertIn(0x5A, [e[2] for e in dbeview.decode_vcl(res.buffer) if e[0] in (4, 5)])

    def test_ap_nonzero(self):
        for ap in (0x0123, 0xE200, 0xF800):          # 0xF800: the window runs past 65535 (addresses mod 65536)
            sc = dbeview.make_scene(env().assets, env().demo, ap=ap)
            self.assertEqual(len(sc.window_ranges()), 2 if ap == 0xF800 else 1)
            check_pixels(self, sc, 3, f"ap {ap:#x}")
            sc = dbeview.make_scene(env().assets, env().demo, 9, 1, ap=ap, band_cover=True)
            check_pixels(self, sc, 4, f"ap {ap:#x}")

    def test_rotated_viewport_origin(self):
        """origin in the DVG shifts the window (row table), the pixels stay the same."""
        g = copy.deepcopy(env().assets.dvg)
        g.origin = 123
        sc = dbeview.make_scene(env().assets, env().demo)
        sc.dvg = g
        dbeview.layout_vram(sc)
        check_pixels(self, sc, 1, "origin 123")


def abyss_map():
    t = [T((0, 0, 0, 0), 1, 1, 0, 0),                      # 0 corridor
         T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0),             # 1 wall
         T((0, 0, 0, 0), 0, 1, 0, 0),                      # 2 abyss (no floor)
         T((0, 0, 0, 0), 2, 0, 0, 0),                      # 3 floor style 2, sky
         T((2, 0, 2, 0), 1, 1, SOLID, 0),                    # 4 grate
         T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0),             # 5 blocked cell with floor 0
         T((3, 3, 3, 3), 0, 0, SOLID | OCC, 0),             # 6 window wall
         T((0, 0, 0, 0), 3, 2, 0, 0)]                      # 7 floor 3 / ceiling 2
    rows = ["###########",
            "#....:....#",
            "#.##..##..#",
            "#.#:..:#..#",
            "#...++....#",
            "#.:....:..#",
            "#.#.##.#.m#",
            "#..:..:...#",
            "###########"]
    legend = {"#": 1, ".": 0, ":": 2, "+": 4, "m": 7, "b": 5, "w": 6, ",": 3}
    rows[6] = "#.#.##.#.m#"
    return mk_map(rows, t, legend, outside=1, start=5 * 11 + 5)


def distant_map():
    """Map for the far view (P6 5.7a): long corridor with ceiling and window to the outside, window in the middle of the corridor (wall
    behind), long corridor without ceiling, grate, tiles with flag DISTANT (with ceiling -> wallpaper, without ceiling -> fill),
    mixed row (ceiling and sky side by side)."""
    DISTANT = dbeview.T_DISTANT
    t = [T((0, 0, 0, 0), 1, 1, 0, 0),                      # 0 corridor
         T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0),             # 1 wall
         T((0, 0, 0, 0), 1, 0, 0, 0),                      # 2 courtyard (sky)
         T((3, 3, 3, 3), 1, 1, SOLID, 0),                    # 3 window (not opaque)
         T((2, 2, 2, 2), 1, 1, SOLID | CNT, 0),              # 4 grate
         T((0, 0, 0, 0), 1, 1, DISTANT, 0),                   # 5 ceiling, DISTANT: wallpaper
         T((0, 0, 0, 0), 1, 0, DISTANT, 0),                   # 6 sky, DISTANT: fill
         T((0, 0, 0, 0), 0, 0, 0, 0)]                      # 7 outside
    rows = ["################",
            "#......F.......F",
            "#.####.#.####.##",
            "#,,,,,,,,,,,,,,#",
            "#.####+#.####.##",
            "#.uuuu.#.oooo..#",
            "#.#F##.#.##F#..#",
            "#.....,,,,.....#",
            "################"]
    legend = {".": 0, "#": 1, ",": 2, "F": 3, "+": 4, "u": 5, "o": 6}
    return mk_map(rows, t, legend, outside=7, start=1 * 16 + 1)


class TestDistant(unittest.TestCase):
    """P6 5.7a: Fill of the far view (horizon band of depth D) by the tile of depth D."""

    def views(self, m):
        return [(i, v) for i, c in enumerate(m.cells) if not m.tiles[c].flags & SOLID for v in range(4)]

    def test_pixels_and_runs(self):
        e = env()
        stats = {"fill": 0, "split": 0, "same": 0}
        k = 0
        for m in (distant_map(), dbemap.load_toml(os.path.join(ROOT, "demo", "demo.toml")), e.demo):
            for i, v in self.views(m):
                k += 1
                bc, (ff, dbg) = bool(k & 1), ((0x00, True), (0x96, False))[(k >> 1) & 1]
                sc = dbeview.make_scene(e.assets, m, i, v, band_cover=bc, buf=BIG, farfill=ff, dbg=dbg, bgfill=0x5A)
                res = check_pixels(self, sc, k, f"{m.name} {i}/{v} bc {bc} ff {ff:#x}")
                ref = dbeview.view(dbeview.make_scene(e.assets, m, i, v, band_cover=bc, buf=BIG, dbg=dbg,
                                                      bgfill=0x5A))
                g = sc.dvg
                ents = dbeview.decode_vcl(res.buffer)
                fill = any(en[0] == 5 and en[2] == ff and en[4] == g.hy1 - g.hy0
                           and 0 <= en[1] - g.row(g.hy0) < g.vw for en in ents)
                stats["fill"] += fill
                stats["same"] += res.buffer == ref.buffer
                stats["split"] += fill and dbg and any(en[0] == 3 and 0 <= en[2] - g.row(g.hy0) < g.vw for en in ents)
        self.assertGreater(stats["fill"], 150, stats)
        self.assertGreater(stats["same"], 150, stats)
        self.assertGreater(stats["split"], 10, stats)

    def test_flag_and_columns(self):
        e = env()
        m = distant_map()
        sc = dbeview.make_scene(e.assets, m, 5 * 16 + 1, 1, farfill=0)       # (1, 5) facing east: row u (DISTANT, ceiling)
        ctx = dbeview._Ctx(sc)
        cols = ctx.far_cols()
        self.assertEqual(cols, sorted(cols))                                   # cell boundaries from left to right
        self.assertEqual(len(cols), sc.dvg.vw)
        self.assertIn(0, cols)
        dec = ctx.far_dec()
        self.assertFalse(dec[0])                                               # u: ceiling, DISTANT -> wallpaper
        sc2 = dbeview.make_scene(e.assets, m, 5 * 16 + 8, 1, farfill=0)       # (8, 5) facing east: row o
        self.assertTrue(dbeview._Ctx(sc2).far_dec()[0])                        # o: sky, DISTANT -> fill

    def test_off_unchanged(self):
        e = env()
        m = distant_map()
        for i, v in self.views(m)[::5]:
            a = dbeview.view(dbeview.make_scene(e.assets, m, i, v))
            b = dbeview.view(dbeview.make_scene(e.assets, m, i, v, farfill=None))
            self.assertEqual(a.buffer, b.buffer)

    def test_random(self):
        e = env()
        n = 0
        for k in range(120 if not FULL else 1000):
            sc = dbeview.far_variant(dbeview.random_scene(k, e.assets, buf=BIG), k)
            if dbeview.view(sc).a == 2:
                continue
            check_pixels(self, sc, k, f"random scene {k} far view")
            n += 1
        self.assertGreater(n, 100)


class TestAbyss(unittest.TestCase):
    def test_all_views(self):
        m = abyss_map()
        n = 0
        rnd = random.Random(7)
        for i, c in enumerate(m.cells):
            if m.tiles[c].flags & SOLID:
                continue
            for v in range(4):
                objs = dbeview.random_objects(rnd, m, i, v, rnd.choice([0, 2, 4]))
                sc = dbeview.make_scene(env().assets, m, i, v, objs, [0, 2, 3] + [0] * 61, v,
                                        band_cover=bool(i & 1), buf=BIG)
                check_pixels(self, sc, n, f"abyss Cell {i} direction {v}")
                n += 1
        self.assertGreater(n, 100)


class TestRandom(unittest.TestCase):
    def test_random_scenes(self):
        e = env()
        nmaps, nviews = (200, 20) if FULL else (25, 8)
        ok = ov = 0
        for k in range(nmaps * nviews):
            sc = dbeview.random_scene(k, e.assets, buf=BIG)
            res = dbeview.view(sc)
            if res.a == 2:          # visibility list full (MAXITEM): no pixel comparison, error state
                ov += 1
                continue
            check_pixels(self, sc, k, f"random scene {k}")
            ok += 1
        self.assertGreater(ok, nmaps * nviews * 0.9)
        self.assertGreater(dbeview.view(dbeview.random_scene(3, e.assets, buf=BIG)).items, 0)

    def test_random_scenes_have_objects_and_clipping(self):
        e = env()
        vis = clipped = 0
        for k in range(60):
            res = dbeview.view(dbeview.random_scene(k, e.assets, buf=BIG))
            vis += res.objvis != 0
            b0 = res.bank0()
            for ent in dbeview.decode_vcl(res.buffer):
                if ent[0] == 12:
                    lst = b0[ent[3]:]
                    p = 3
                    for _ in range(lst[1] | lst[2] << 8):
                        if lst[p] == 3:
                            clipped += 1
                            break
                        p += {1: 4, 8: 3, 3: 3}[lst[p]]
        self.assertGreater(vis, 20)
        self.assertGreater(clipped, 5)


class TestDoubleFronts(unittest.TestCase):
    """Synthetic DVG with two front faces per cell (9.3 random, 9.5 Crawl; P6b review): list and pixels."""

    @classmethod
    def setUpClass(cls):
        cls.a2 = dbeview.double_fronts(env().assets)

    def test_geometry(self):
        g, g0 = self.a2.dvg, env().assets.dvg
        self.assertEqual(dbeview.parse_dvg(self.a2.dvg_prg).elems, g.elems)
        for d in range(1, g.D + 1):
            for s, ce in dbeview._Ctx(dbeview.make_scene(self.a2, env().demo)).cells_of(d):
                n0 = sum(1 for e in g0.elems if e.d == d and e.s == s and e.art == dbeview.ART_FRONT)
                self.assertEqual(sum(1 for e in ce if e.art == dbeview.ART_FRONT), 2 * n0)
        # at least one cell with order F, S, F' (CONTENT orders differently)
        self.assertTrue(any([e.art for e in ce][:3] == [0, 1, 0] for d in range(1, g.D + 1)
                            for _, ce in dbeview._Ctx(dbeview.make_scene(self.a2, env().demo)).cells_of(d)))

    def test_demo_pixels(self):
        m = env().demo
        for bc in (False, True):
            for i, c in enumerate(m.cells):
                if m.tiles[c].flags & SOLID:
                    continue
                for v in range(4):
                    sc = dbeview.make_scene(self.a2, m, i, v, band_cover=bc, buf=BIG)
                    check_pixels(self, sc, i * 4 + v, f"zwei Fronten: Cell {i} direction {v} bc {bc}")

    def test_random_pixels(self):
        ok = 0
        for k in range(60 if FULL else 20):
            sc = dbeview.random_scene(1000 + k, self.a2, buf=BIG)
            if dbeview.view(sc).a == 2:
                continue
            check_pixels(self, sc, k, f"two fronts: random scene {k}")
            ok += 1
        self.assertGreater(ok, 10)


class TestEdge(unittest.TestCase):
    """Sprites placed deliberately at the window edges (s = +-1, +-2, d = 1 ... 3, all p) in an empty room."""

    def test_edges(self):
        m = open_room()
        e = env()
        n = 0
        for setn in (0, 2, 3):
            for d in (1, 2, 3):
                for s in (-2, -1, 0, 1, 2):
                    cx, cy = m.start % m.width, m.start // m.width
                    cell = (cy - d) * m.width + cx + s
                    for q in range(5):
                        o = dbeview.Obj(cell, setn, 2, 1, q)
                        sc = dbeview.make_scene(e.assets, m, objects=[o], buf=BIG, band_cover=bool(n & 1))
                        res = check_pixels(self, sc, n, f"Satz {setn} d {d} s {s} q {q}")
                        n += 1
        self.assertEqual(n, 225)

    def test_edges_with_walls_in_front(self):
        """Object partially behind an opaque wall: section by columns, pixels match."""
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0)]
        rows = ["#########",
                "#.......#",
                "#.#####.#",
                "#.#...#.#",
                "#.#...#.#",
                "#...#...#",
                "#########"]
        m = mk_map(rows, t, {"#": 1, ".": 0}, outside=1, start=5 * 9 + 2, direction=0)
        n = 0
        for i, c in enumerate(m.cells):
            if m.tiles[c].flags & SOLID:
                continue
            for v in range(4):
                for setn in (0, 2, 3):
                    objs = [dbeview.Obj(j, setn, 2, 0, q) for j in range(len(m.cells)) for q in (0, 4)
                            if not m.tiles[m.cells[j]].flags & SOLID and (j + q) % 3 == 0]
                    sc = dbeview.make_scene(env().assets, m, i, v, objs[:16], buf=BIG)
                    check_pixels(self, sc, n, f"Cell {i} v {v} Satz {setn}")
                    n += 1


class TestSpansAndMasks(unittest.TestCase):
    def view_obj(self):
        sc = dbeview.make_scene(env().assets, env().demo)
        return dbeview._View(sc)

    def test_spans(self):
        v = self.view_obj()
        m = [0] * 70
        self.assertEqual(v.spans(m), [(0, 70)])
        m = [1] * 70
        self.assertEqual(v.spans(m), [])
        m = [1] * 70
        for a, b in [(0, 5), (10, 12), (20, 30), (40, 41)]:
            m[a:b] = [0] * (b - a)
        self.assertEqual(v.spans(m), [(0, 5), (10, 12), (20, 30), (40, 41)])         # exactly 4 runs
        m[50:52] = [0, 0]
        self.assertEqual(v.spans(m), [(0, 52)])                                      # more than 4: one run

    def test_mark_counts_cover_only(self):
        v = self.view_obj()
        v.mark(v.cover, 3, 8)
        v.mark(v.cover, 5, 10)
        self.assertEqual(v.ncov, 7)
        v.mark(v.bcov, 0, 70)
        self.assertEqual(v.ncov, 7)
        self.assertTrue(v.allcov(v.cover, 3, 10))
        self.assertFalse(v.allcov(v.cover, 2, 10))


# ---------------------------------------------------------------- Band decision

class TestBands(unittest.TestCase):
    def plan(self, m, d, kind, pos=None, v=0):
        sc = dbeview.make_scene(env().assets, m, pos, v, buf=BIG)
        return dbeview._Ctx(sc).band_plan(d, kind), sc

    def test_uniform(self):
        p, _ = self.plan(open_room(floor=2), 2, dbeview.KIND_FLOOR)
        self.assertEqual(p["ground"][0:2], ("band", 1))
        self.assertEqual(p["tiles"], [])
        self.assertFalse(p["gap"])

    def test_mixed_tiles_for_other_styles(self):
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((0, 0, 0, 0), 2, 1, 0, 0)]
        rows = ["........."] * 3 + ["....,...."] + ["........."] * 3
        m = mk_map(rows, t, {".": 0, ",": 1}, start=6 * 9 + 4)
        p, sc = self.plan(m, 3, dbeview.KIND_FLOOR)
        # (3, 0) has style 2 (index 1) and comes first in the DVG: st0 = 1, tiles for all elements with a different style
        self.assertEqual(p["ground"][0:2], ("band", 1))
        self.assertEqual(sorted(e.s for e, n in p["tiles"]), [-3, -2, -1, 1, 2, 3])
        self.assertTrue(all(n == 1 for e, n in p["tiles"]))
        self.assertFalse(p["gap"])

    def test_gap_gives_wallpaper(self):
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((0, 0, 0, 0), 0, 1, 0, 0)]
        m = mk_map(["........."] * 3 + [".....,..."] + ["........."] * 3, t, {".": 0, ",": 1}, start=6 * 9 + 4)
        p, _ = self.plan(m, 3, dbeview.KIND_FLOOR)
        self.assertTrue(p["gap"])
        self.assertEqual(p["ground"], "wallpaper")
        self.assertTrue(all(n == 1 for e, n in p["tiles"]))
        self.assertNotIn(1, [e.s for e, n in p["tiles"]])       # the gap is the cell (3, +1)

    def test_blocked_cells_are_any(self):
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0)]
        m = mk_map(["#######", "#.....#", "#.....#", "#######"], t, {"#": 1, ".": 0}, outside=1, start=2 * 7 + 3)
        p, _ = self.plan(m, 1, dbeview.KIND_FLOOR)
        self.assertEqual(p["ground"][0:2], ("band", 0))      # cells (1, +-1): free; outer wall irrelevant
        p2, _ = self.plan(m, 2, dbeview.KIND_FLOOR)           # row y = 0: all wall -> all irrelevant
        self.assertIsNone(p2)

    def test_block_without_all_faces_is_gap(self):
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 0), 0, 0, SOLID | OCC, 0)]       # one face missing: not blocked
        m = mk_map(["#####", "#...#", "#####"], t, {"#": 1, ".": 0}, outside=1, start=7)
        sc = dbeview.make_scene(env().assets, m, 7, 0, buf=BIG)
        p = dbeview._Ctx(sc).band_plan(1, dbeview.KIND_FLOOR)        # row y = 0: tiles with 3 faces, floor 0
        self.assertTrue(p["gap"])

    def test_out_of_range_style_is_gap_and_no_dts(self):
        p, sc = self.plan(open_room(floor=9), 1, dbeview.KIND_FLOOR)       # style 9 > NST: gap
        self.assertTrue(p["gap"])
        sc.dts[dbeview.KIND_FLOOR] = None
        sc2 = dbeview.make_scene(env().assets, open_room(floor=1), buf=BIG)
        sc2.dts[dbeview.KIND_FLOOR] = None
        p2 = dbeview._Ctx(sc2).band_plan(1, dbeview.KIND_FLOOR)
        self.assertTrue(p2["gap"])
        check_pixels(self, sc2, 1, "without floor DTS")

    def test_ground_empty_when_band_missing(self):
        """Style without band image (puddle, $FE): ground empty, tiles for all."""
        m = open_room(floor=3)
        p, _ = self.plan(m, 2, dbeview.KIND_FLOOR)
        self.assertIsNone(p["ground"])
        self.assertEqual(len(p["tiles"]), 5)

    def test_decisions_pixel_equal(self):
        for floor in (1, 2, 3, 9):
            for ceil in (1, 2, 3, 0):
                m = open_room(floor=floor, ceil=ceil)
                for v in (0, 1):
                    sc = dbeview.make_scene(env().assets, m, direction=v, buf=HUGE, band_cover=bool(floor & 1))
                    check_pixels(self, sc, floor * 10 + ceil, f"floor {floor} ceil {ceil}")


# ---------------------------------------------------------------- Comparison with the dbetex preview

class TestPreviewCompare(unittest.TestCase):
    def window_zero(self, sc):
        vram = sc.make_vram(1)
        g = sc.dvg
        for y in range(g.vh):
            a = (sc.ap + g.row(y)) & 0xFFFF
            vram[a:a + g.vw] = bytes(g.vw)
        return vram

    def test_walls_corridor(self):
        """paint_reference == dbetex.preview (corridor: all cells s != 0 and cell (D, 0) wall)."""
        t = [T((0, 0, 0, 0), 0, 0, 0, 0), T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0)]
        rows = ["#########"] * 4 + ["####.####"] * 3
        m = mk_map(rows, t, {"#": 1, ".": 0}, outside=1, start=6 * 9 + 4, direction=0)
        e = env()
        sc = dbeview.make_scene(e.assets, m, dbg=False, bgfill=0)
        ref = dbeview.paint_reference(sc, self.window_zero(sc))
        pil = dbeview.window_image(sc, ref, 4)
        prev = dbetex.preview(e.assets.walls, e.assets.geom, 0, vb=0x4000)
        self.assertEqual(pil.size, prev.size)
        self.assertEqual(pil.tobytes(), prev.tobytes())
        # and view agrees with both
        sc2 = dbeview.make_scene(e.assets, m, dbg=False, bgfill=0)
        vram = self.window_zero(sc2)
        dbeview.render_view(sc2, vram)
        self.assertEqual(dbeview.window_image(sc2, vram, 4).tobytes(), prev.tobytes())

    def test_floor_ceiling_tiles(self):
        """Style without band images (puddle/hole, single colour): all tiles, order has no effect -> == preview."""
        e = env()
        for kind, art in ((dbeview.KIND_FLOOR, "floor"), (dbeview.KIND_CEIL, "ceil")):
            ts = (e.assets.floor, e.assets.ceil)[kind - 1]
            st = 2 if kind == dbeview.KIND_FLOOR else 1
            m = open_room(floor=3 if kind == dbeview.KIND_FLOOR else 0, ceil=2 if kind == dbeview.KIND_CEIL else 0)
            sc = dbeview.make_scene(e.assets, m, dbg=False, bgfill=0)
            ref = dbeview.paint_reference(sc, self.window_zero(sc))
            prev = dbetex.preview(ts, e.assets.geom, st, vb=0x4000)
            ia = dbeview.window_image(sc, ref, 4)
            self.assertEqual(ia.size, prev.size)
            # The other (sky) band of the scene is black (fill byte 0) as in the preview
            self.assertEqual(ia.tobytes(), prev.tobytes(), art)


# ---------------------------------------------------------------- Objects

class TestObjects(unittest.TestCase):
    def scene(self, objs, itemtab=None, itemph=0, content=None, v=0, m=None, **kw):
        m = m or open_room()
        if content:
            m = copy.deepcopy(m)
            for c, g in content.items():
                m.content[c] = g
        return dbeview.make_scene(env().assets, m, direction=v, objects=objs, itemtab=itemtab, itemph=itemph,
                                  buf=BIG, **kw), m

    def cell(self, m, d, s, v=0):
        cx, cy = m.start % m.width, m.start // m.width
        fx, fy = dbeview.FORE[v]
        rx, ry = dbeview.RIGHT[v]
        return (cy + d * fy + s * ry) * m.width + cx + d * fx + s * rx

    def src_sets(self, sc, res):
        """Set number per VMC/VMS entry of the list (from the source address), in output order."""
        out = []
        for e in dbeview.decode_vcl(res.buffer):
            if e[0] in (2, 3, 12):
                for i, b in enumerate(sc.vram_bases["s2"]):
                    ss = sc.s2[i]
                    if ss is not None and b <= e[1] < b + len(ss.vram):
                        out.append(i)
        return out

    def test_item_sets_and_objvis(self):
        sc, m = self.scene([], itemtab=[0, 2, 0] + [0] * 61, content={self.cell(open_room(), 2, 0): 1})
        res = dbeview.view(sc)
        self.assertEqual(res.objvis, 0)                     # items do not set an OBJVIS bit
        self.assertEqual(set(self.src_sets(sc, res)), {1})
        sc, m = self.scene([], itemtab=[0, 2] + [0] * 62)    # itemtab[1] = set 1 (+1 = 2), but no content
        self.assertEqual(self.src_sets(sc, dbeview.view(sc)), [])

    def test_hidden_and_invalid(self):
        m = open_room()
        c = self.cell(m, 2, 0)
        objs = [dbeview.Obj(c, 0, 0, 0, 4, hidden=True), dbeview.Obj(c, 6, 0, 0, 4), dbeview.Obj(c, 1, 0xFF, 0, 4)]
        sc, _ = self.scene(objs)
        res = dbeview.view(sc)
        self.assertEqual(res.objvis, 0b100)                 # only object 2 (set 1); 0: invisible, 1: set empty
        self.assertEqual(set(self.src_sets(sc, res)), {1})

    def test_order_by_subposition_item_first(self):
        m = open_room()
        c = self.cell(m, 2, 0)
        # view N: q 0 NW -> p 0, q 3 SO -> p 4, q 4 center -> p 2; item also p 2 (first)
        objs = [dbeview.Obj(c, 0, 2, 0, 3), dbeview.Obj(c, 2, 2, 0, 0), dbeview.Obj(c, 3, 2, 0, 4),
                dbeview.Obj(c, 2, 2, 0, 7)]                  # q 7 -> 4 (center p 2)
        sc, _ = self.scene(objs, itemtab=[0, 2] + [0] * 62, content={c: 1})
        res = dbeview.view(sc)
        sets = self.src_sets(sc, res)
        self.assertEqual(res.objvis, 0b1111)
        # Paint order: p0 (set 2), p2: item (set 1), set 3, set 2 (q 7), p4: set 0
        seq = []
        for s_ in sets:
            if not seq or seq[-1] != s_:
                seq.append(s_)
        self.assertEqual(seq, [2, 1, 3, 2, 0])

    def test_subposition_rotates_with_view(self):
        m = open_room()
        for v in range(4):
            c = self.cell(m, 2, 0, v)
            sc, _ = self.scene([dbeview.Obj(c, 0, 2, 0, 0), dbeview.Obj(c, 2, 2, 0, 3)], v=v)
            sets = self.src_sets(sc, dbeview.view(sc))
            first = sets[0]
            # q 0 (NW) and q 3 (SO) are opposite: order by SUBPOS_VIEW
            exp_first = 0 if dbemap.SUBPOS_VIEW[v][0] < dbemap.SUBPOS_VIEW[v][3] else 2
            self.assertEqual(first, exp_first, f"Blick {v}")

    def test_angle_and_phase_selection(self):
        """View angle a = (2 + v - o) & 3, phase >= NP -> 0; compare with direct lookup."""
        m = open_room()
        e = env()
        ss = e.assets.sprites[0]
        c = self.cell(m, 1, 0)
        seen = set()
        for o in range(4):
            for ph in (0, 1, 5):
                sc, _ = self.scene([dbeview.Obj(c, 0, o, ph, 2)], v=0)
                res = dbeview.view(sc)
                a = (2 + 0 - o) & 3
                idx = dbeview._lookup(ss, ph, a, 1)
                img = ss.images[idx]
                ents = [x for x in dbeview.decode_vcl(res.buffer) if x[0] in (2, 3, 12)]
                base = sc.vram_bases["s2"][0]
                if img.cores:
                    self.assertTrue(any(x[1] == base + img.cores[0].src for x in ents))
                seen.add(idx)
        self.assertGreater(len(seen), 4)

    def test_depth_zero_not_drawn(self):
        m = open_room()
        sc, _ = self.scene([dbeview.Obj(m.start, 0, 2, 0, 4)])
        self.assertEqual(dbeview.view(sc).objvis, 0)

    def test_hidden_behind_cover(self):
        """Object behind an opaque wall across the whole image: not output (no OBJVIS bit)."""
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0)]
        rows = ["#######"] * 2 + ["#.....#", "#.....#", "###.###", "#######"]
        rows = ["#######", "#.....#", "###.###", "###.###", "###.###", "#######"]
        m = mk_map(rows, t, {"#": 1, ".": 0}, outside=1, start=4 * 7 + 3)
        c = 1 * 7 + 3
        sc, _ = self.scene([dbeview.Obj(c, 0, 2, 0, 4)], m=m)
        # Cell (3, 0) is free, in front of it (1, 0), (2, 0) likewise; the wall lies behind -> object visible
        self.assertEqual(dbeview.view(sc).objvis, 1)
        # Wall at (2, 0): object (3, 0) behind it and the front face covers all columns of the front
        m2 = copy.deepcopy(m)
        m2.cells[2 * 7 + 3] = 1
        sc2, _ = self.scene([dbeview.Obj(c, 0, 2, 0, 4)], m=m2)
        res = check_pixels(self, sc2, 1)
        self.assertEqual(res.objvis, 0)

    def test_objn_over_16_reads_16(self):
        m = open_room()
        c = self.cell(m, 2, 0)
        objs = [dbeview.Obj(c, 0, 2, 0, 4)] * 20
        sc, _ = self.scene(objs)
        res = dbeview.view(sc)
        self.assertEqual(res.objvis, 0xFFFF)

    def test_item_phase(self):
        m = open_room()
        c = self.cell(m, 2, 0)
        a, b = [], []
        for ph, out in ((0, a), (1, b)):
            sc, _ = self.scene([], itemtab=[0, 2] + [0] * 62, itemph=ph, content={c: 1})
            out.append(dbeview.view(sc).buffer)
        self.assertNotEqual(a, b)


class TestContent(unittest.TestCase):
    """Tile flag CONTENT: wall cell with faces draws side, objects, front."""

    def build(self, content, occ=False, v=0, objs=None):
        t = [T((0, 0, 0, 0), 1, 1, 0, 0),
             T((2, 2, 2, 2), 1, 1, SOLID | (OCC if occ else 0) | (CNT if content else 0), 0),     # grate (not opaque)
             T((1, 1, 1, 1), 0, 0, SOLID | OCC, 0)]
        rows = ["#########"] * 2 + ["#...+...#", "#.......#", "#.......#", "#.......#", "#########"]
        m = mk_map(rows, t, {"#": 2, ".": 0, "+": 1}, outside=2, start=5 * 9 + 4, direction=0)
        return m

    def run_(self, content, setn=0, q=4, d=3, s=-1, occ=False):
        m = self.build(content, occ)
        cx, cy = m.start % 9, m.start // 9
        # Grate cell at (4, 2) = (d 3, s 0); cells (3, -1) and (3, +1) are wall (style 2 = grating, SOLID)
        cell = 2 * 9 + 4
        objs = [dbeview.Obj(cell, setn, 2, 0, q)]
        sc = dbeview.make_scene(env().assets, m, objects=objs, buf=BIG, band_cover=True)
        return sc, m, cell

    def test_objects_only_with_flag(self):
        sc, m, cell = self.run_(False)
        self.assertEqual(dbeview.view(sc).objvis, 0)
        sc, m, cell = self.run_(True)
        res = check_pixels(self, sc, 1, "CONTENT with object")
        self.assertEqual(res.objvis, 1)

    def test_order_side_objects_front(self):
        """Cell (d, s) with side and front: output side, object, front (plan 5, decision 4)."""
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((2, 2, 2, 2), 1, 1, SOLID | CNT, 0)]
        rows = ["#########", "#########", "#...#...#", "#.......#", "#.......#", "#.......#", "#########"]
        m = mk_map(rows, t, {"#": 1, ".": 0}, outside=1, start=5 * 9 + 4, direction=0)
        # Cell (3, -1) = (x 3, y 2) is free; we make (2, -1) = (3, 3) the CONTENT cell with object
        m.cells[3 * 9 + 3] = 1
        cell = 3 * 9 + 3
        for inh in (False, True):
            mm = copy.deepcopy(m)
            if not inh:
                mm.tiles[1].flags &= ~CNT
            sc = dbeview.make_scene(env().assets, mm, objects=[dbeview.Obj(cell, 0, 2, 0, 4)], buf=BIG)
            res = dbeview.view(sc)
            ents = dbeview.decode_vcl(res.buffer)
            base = sc.vram_bases["s2"][0]
            wallb = sc.vram_bases["dts"][0]
            pos_sprite = [i for i, e in enumerate(ents) if e[0] in (2, 3, 12) and base <= e[1] < base + len(sc.s2[0].vram)]
            wallp = [i for i, e in enumerate(ents) if e[0] in (2, 3, 12) and wallb <= e[1] < wallb + len(sc.dts[0].vram)]
            if not inh:
                self.assertEqual(pos_sprite, [])
                continue
            self.assertTrue(pos_sprite)
            # Side of cell (2, -1) = face in output order before the sprite, front after: There are
            # wall entries before and after (side of (2,-1) lies further out, the front of (2, 0) ...)
            self.assertTrue(any(p < pos_sprite[0] for p in wallp) and any(p > pos_sprite[-1] for p in wallp))
            check_pixels(self, sc, 2, "CONTENT Reihenfolge")

    def test_cell_group_order_in_visibility_list(self):
        """Visibility order: fronts, objects, sides; output backwards."""
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((2, 2, 2, 2), 1, 1, SOLID | CNT, 0)]
        rows = ["#####", "#...#", "#...#", "#...#", "#####"]
        m = mk_map(rows, t, {"#": 1, ".": 0}, outside=1, start=3 * 5 + 2, direction=0)
        m.cells[2 * 5 + 1] = 1                           # (d 1, s -1)
        sc = dbeview.make_scene(env().assets, m, objects=[dbeview.Obj(2 * 5 + 1, 0, 2, 0, 4)], buf=BIG)
        v = dbeview._View(sc)
        c = v.cell(1, -1)
        ce = dict(v.cells_of(1))[-1]
        order = [e.art for e in v.cell_order(ce, v.tile(c))]
        self.assertEqual(order[:3], [dbeview.ART_FRONT, dbeview.ART_OBJ, dbeview.ART_SIDE])
        plain = copy.deepcopy(m)
        plain.tiles[1].flags &= ~CNT
        v2 = dbeview._View(dbeview.make_scene(env().assets, plain, buf=BIG))
        order2 = [e.art for e in v2.cell_order(dict(v2.cells_of(1))[-1], v2.tile(v2.cell(1, -1)))]
        self.assertEqual(order2[:3], [dbeview.ART_FRONT, dbeview.ART_SIDE, dbeview.ART_FLOOR])

    def test_content_pixels_random(self):
        """Random scenes with CONTENT tiles in many positions and objects in the grate cells."""
        e = env()
        rnd = random.Random(99)
        n = 0
        for k in range(120):
            sc = dbeview.random_scene(1000 + k, e.assets, nobj=0, buf=BIG)
            m = sc.dmp
            inh = [i for i, c in enumerate(m.cells) if m.tiles[c].flags & CNT and any(m.tiles[c].walls)]
            if not inh:
                continue
            ctx = dbeview._Ctx(sc)
            objs = []
            for d in (1, 2, 3):
                for s in range(-3, 4):
                    c = ctx.cell(d, s)
                    if c is not None and c in inh:
                        objs.append(dbeview.Obj(c, rnd.choice([0, 2, 3]), rnd.randrange(4), rnd.randint(0, 1),
                                                rnd.randint(0, 4)))
            if not objs:
                continue
            sc.objects = objs[:16]
            res = dbeview.view(sc)
            if res.a:
                continue
            check_pixels(self, sc, k, f"CONTENT-Scene {k}")
            n += 1
        self.assertGreater(n, 5)


# ---------------------------------------------------------------- Overflow

class TestOverflow(unittest.TestCase):
    def scenes(self):
        e = env()
        out = [dbeview.make_scene(e.assets, e.demo, i, v) for i in (9, 16, 22) for v in range(4)]
        t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((2, 2, 2, 2), 1, 1, SOLID, 0)]
        m = mk_map(["#######"] * 3 + ["#.....#"] * 4, t, {"#": 1, ".": 0}, outside=1, start=6 * 7 + 3)
        out.append(dbeview.make_scene(e.assets, m, band_cover=True))        # grate scene
        out.append(dbeview.random_scene(5, e.assets, buf=BIG))
        return out

    def test_invariants_for_small_buffers(self):
        for k, sc in enumerate(self.scenes()):
            full_sc = copy.copy(sc)
            full_sc.buf = (0x1300, 0x1300 + 6000)
            full = dbeview.view(full_sc)
            for size in (64, 128, 256, 512, 1024, 2304):
                s = copy.copy(sc)
                s.buf = (0x1300, 0x1300 + size)
                res = dbeview.view(s)
                self.assertLessEqual(res.vcllen + res.vmslen, size, f"Scene {k} buffer {size}")
                self.assertEqual(res.vcl[-1], 0)
                self.assertIn(res.a, (0, 2, 3))
                if res.a == 0:
                    self.assertEqual(res.vcl, full.vcl if (res.vcllen, res.vmslen) == (full.vcllen, full.vmslen)
                                     else res.vcl)
                if size >= full.vcllen + full.vmslen:
                    self.assertEqual(res.a, 0)
                    self.assertEqual(res.vcllen, full.vcllen)
                    self.assertEqual(res.vmslen, full.vmslen)
                # executable, nothing outside the window
                vram = s.make_vram(k)
                before = bytes(vram)
                dbeview.run_vcl(res.bank0(), vram, res.p0)
                outside_unchanged(self, s, before, vram, f"Scene {k} buffer {size}")

    def test_exact_model(self):
        """Accept/omit/discard/abort per P6 5.10 against a model on the unbounded list."""
        for k, sc in enumerate(self.scenes()):
            big = copy.copy(sc)
            big.buf = BIG
            v = dbeview._View(big)
            full = v.run()
            offered = [(it.v, it.m) for it in v.items]
            if len(offered) >= dbeview.MAXITEM:
                continue
            for size in (64, 100, 128, 200, 256, 400, 512, 700, 1024, 1500, 2304):
                nv, nm, n, partial, stop = 1, 0, 0, False, False
                for iv, im in offered:
                    if n == dbeview.MAXITEM:
                        stop = True
                        break
                    if nv + iv + nm + im <= size:
                        nv, nm, n = nv + iv, nm + im, n + 1
                    elif im > 0 and iv > 7 and nv + iv - 7 + nm <= size:
                        nv, n, partial = nv + iv - 7, n + 1, True
                    elif im > 0 and iv == 7:
                        partial = True
                    else:
                        stop = True
                        break
                s = copy.copy(sc)
                s.buf = (0x1300, 0x1300 + size)
                res = dbeview.view(s)
                self.assertEqual((res.vcllen, res.vmslen), (nv, nm), f"Scene {k} buffer {size}")
                self.assertEqual(res.a, 2 if stop else (3 if partial else 0), f"Scene {k} buffer {size}")
                self.assertEqual(res.items, n)

    def test_partial_rule_happens(self):
        """At least one scene/buffer size with A = 3 (edge omitted), rest complete and correct."""
        found = 0
        for sc in self.scenes():
            for size in range(300, 1400, 7):
                s = copy.copy(sc)
                s.buf = (0x1300, 0x1300 + size)
                res = dbeview.view(s)
                if res.a == 3:
                    found += 1
                    ents = dbeview.decode_vcl(res.buffer)
                    self.assertTrue(res.vcllen + res.vmslen <= size)
                    break
        self.assertGreaterEqual(found, 1)

    def test_truncation_loses_back_parts(self):
        """With A = 2 the rear parts are missing: the list is a suffix of the full list (output back -> front)."""
        sc = dbeview.make_scene(env().assets, env().demo, 9, 1)
        big = copy.copy(sc)
        big.buf = BIG
        full = dbeview.decode_vcl(dbeview.view(big).buffer)
        s = copy.copy(sc)
        s.buf = (0x1300, 0x1300 + 400)
        r = dbeview.view(s)
        self.assertEqual(r.a, 2)
        part = dbeview.decode_vcl(r.buffer)
        self.assertLess(len(part), len(full))
        # the front entries (list end) match the full list (without VMS addresses)
        strip = lambda es: [e[:3] if e[0] == 12 else e for e in es]
        self.assertEqual(strip(part)[-3:], strip(full)[-3:])

    def test_maxitem(self):
        """Visibility list full (96 entries): A = 2."""
        e = env()
        t = [T((0, 0, 0, 0), 1, 1, 0, 0)]
        m = mk_map(["." * 13] * 13, t, {".": 0}, start=6 * 13 + 6)
        # many objects (16) and many tiles: mixed, with grate styles
        tiles = [T((0, 0, 0, 0), 2, 2, 0, 0), T((0, 0, 0, 0), 3, 1, 0, 0)]
        m2 = mk_map(["01" * 7] * 13, tiles, {"0": 0, "1": 1}, start=6 * 14 + 6)
        sc = dbeview.make_scene(e.assets, m2, buf=BIG)
        res = dbeview.view(sc)
        self.assertIn(res.a, (0, 2))
        sc.buf = (0x0200, 0x1C00)
        v = dbeview._View(sc)
        v.run()
        self.assertLessEqual(len(v.items), dbeview.MAXITEM)

    def test_maxitem_forced(self):
        sc = dbeview.make_scene(env().assets, env().demo, 9, 1, buf=BIG)
        orig = dbeview.MAXITEM
        try:
            dbeview.MAXITEM = 5
            res = dbeview.view(sc)
        finally:
            dbeview.MAXITEM = orig
        self.assertEqual((res.a, res.items), (2, 5))
        vram = sc.make_vram(0)
        dbeview.run_vcl(res.bank0(), vram, res.p0)

    def test_a2_has_priority(self):
        for sc in self.scenes():
            for size in range(64, 600, 5):
                s = copy.copy(sc)
                s.buf = (0x1300, 0x1300 + size)
                r = dbeview.view(s)
                if r.partial and r.a == 2:
                    return
        self.skipTest("no case with A = 2 and edge omitted found")


# ---------------------------------------------------------------- Budget, scene file, CLI

class TestBudgetAndCli(unittest.TestCase):
    def test_budget_report(self):
        e = env()
        sc = [dbeview.make_scene(e.assets, e.demo, 9, v) for v in range(4)]
        small = dbeview.make_scene(e.assets, e.demo, 9, 1, buf=(0x1300, 0x1300 + 300))
        rep = dbeview.budget(sc + [small])
        self.assertEqual(rep["scenes"], 5)
        self.assertEqual(len(rep["warnings"]), 1)
        self.assertIn("A = 2", rep["warnings"][0])
        self.assertGreater(rep["max_total"], 800)
        self.assertEqual(rep["codes"][0], 4)

    def test_load_scene_and_cli(self):
        e = env()
        with tempfile.TemporaryDirectory() as td:
            def run(*args):
                return subprocess.run([sys.executable, *args], capture_output=True, text=True, cwd=td)
            for n in ("walls", "floor", "ceil"):
                with open(os.path.join(e.tmp.name, n + ".toml")) as f:
                    pass
            for n in ("walls.toml", "floor.toml", "ceil.toml"):
                r = run(os.path.join(ROOT, "tools", "dbetex.py"), "build", os.path.join(e.tmp.name, n), "--out", td,
                        "--no-preview")
                self.assertEqual(r.returncode, 0, r.stderr)
            r = run(os.path.join(ROOT, "tools", "dbetex.py"), "bg", os.path.join(e.tmp.name, "bg.toml"), "--out", td)
            self.assertEqual(r.returncode, 0, r.stderr)
            import shutil
            shutil.copy(os.path.join(e.tmp.name, "west140.dvg"), td)
            shutil.copy(DEMO_MAP, td)
            with open(os.path.join(td, "scene.toml"), "w") as f:
                f.write('''format = "dbeview"
version = 1
[scene]
dvg = "west140.dvg"
map = "demo.toml"
dir = "E"
bgfill = 0
[walls]
dts = "demo_walls.dts"
vrl = "demo_walls.vrl"
[floor]
dts = "demo_floor.dts"
vrl = "demo_floor.vrl"
[ceil]
dts = "demo_ceil.dts"
vrl = "demo_ceil.vrl"
[background]
dbg = "demo_sky.dbg"
vrl = "demo_sky.vrl"
''')
            sc = dbeview.load_scene(os.path.join(td, "scene.toml"))
            self.assertEqual((sc.dir, sc.pos), (1, 9))
            res = check_pixels(self, sc, 0, "load_scene")
            r = run(DBEVIEW, "render", "scene.toml", "--out", "o.png", "--zoom", "2")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(os.path.getsize(os.path.join(td, "o.png")) > 100)
            self.assertIn(f"VCL {res.vcllen}", r.stdout)
            r = run(DBEVIEW, "dump", "scene.toml")
            self.assertEqual(r.returncode, 0)
            self.assertIn(f"VCLADR {0x1C00 - res.vcllen:#06x}", r.stdout)       # VCL list ends at B1
            r = run(DBEVIEW, "budget", "scene.toml")
            self.assertEqual(r.returncode, 0)
            self.assertIn("1 scenes", r.stdout)
            r = run(DBEVIEW, "render", "fehlt.toml")
            self.assertEqual(r.returncode, 1)
            self.assertNotIn("Traceback", r.stderr)


class TestFixedAddress(unittest.TestCase):
    """P6j: fixed list address (BUFSET X bit 0): jump (VCL type 10) at B0 to the list start, VMS lists from B0 + 3,
    3 bytes less space; the image is the same as without fixed mode."""

    def test_fixed(self):
        import copy
        for k in range(12):
            sc = dbeview.random_scene(700 + k, env().assets)
            sc2 = copy.copy(sc)
            sc2.buf_fix = True
            r1, r2 = dbeview.view(sc), dbeview.view(sc2)
            self.assertEqual((r2.p0, r2.vcllen, r2.vmslen, r2.x), (0x1300, len(r2.vcl), len(r2.vms), r1.x))
            b0 = r2.bank0()
            self.assertEqual(bytes(b0[0x1300:0x1303]), bytes((10, (0x1C00 - r2.vcllen) & 255, (0x1C00 - r2.vcllen) >> 8)))
            ents = dbeview.decode_vcl(r2.buffer)
            vptr = [e[3] for e in ents if e[0] == 12]
            if vptr:
                self.assertEqual(min(vptr), 0x1303)
            if r1.a == 0 and r2.a == 0:
                v1, v2 = bytearray(65536), bytearray(65536)
                dbeview.run_vcl(r1.bank0(), v1, r1.p0, bank1=r1.bank1())
                dbeview.run_vcl(r2.bank0(), v2, r2.p0, bank1=r2.bank1())
                self.assertEqual(v1, v2)

    def test_overflow_three_bytes(self):
        """Exactly fitting buffer: with the jump, 3 bytes are missing."""
        import copy
        sc = dbeview.make_scene(env().assets, env().demo)
        r = dbeview.view(sc)
        n = r.vcllen + r.vmslen
        sc.buf = (0x1300, 0x1300 + n)
        self.assertEqual(dbeview.view(sc).a, 0)
        sc2 = copy.copy(sc)
        sc2.buf_fix = True
        self.assertNotEqual(dbeview.view(sc2).a, 0)
        sc2.buf = (0x1300, 0x1300 + n + 3)
        self.assertEqual(dbeview.view(sc2).a, 0)


if __name__ == "__main__":
    unittest.main()
