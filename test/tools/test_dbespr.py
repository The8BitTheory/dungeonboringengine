"""Tests fuer tools/dbespr.py und tools/dbesprdemo.py (docs/specs/P5b-sprites.md, Abschnitt 9)."""
import binascii
import copy
import json
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
import dbespr  # noqa: E402
import dbesprdemo  # noqa: E402
import dbetex  # noqa: E402
import vrl  # noqa: E402
from PIL import Image  # noqa: E402

DBESPR = os.path.join(ROOT, "tools", "dbespr.py")
PAL = dbetex.PALETTE
VB = 0x5000
X0, Y0 = 10, 20


def rd(p):
    with open(p, "rb") as f:
        return f.read()


class Env:
    _inst = None

    @classmethod
    def get(cls):
        if cls._inst is None:
            cls._inst = cls()
        return cls._inst

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "spr")
        dbesprdemo.generate(self.dir)
        self.geom_path = os.path.join(self.dir, "west140.geom.json")
        self.geom = dbetex.load_geom(self.geom_path, os.path.join(self.dir, "west140.dvg"))
        self.vp = self.geom["viewport"]
        self.stride = self.vp["stride"]
        self.sets = {}
        for n in ("blob", "blob_m", "gem"):
            conf = dbespr.load_conf(os.path.join(self.dir, n + ".toml"))
            self.sets[n] = (conf,) + dbespr.build_spriteset(conf)   # conf, ss, warns, infos, sources


def vms_cmds(lst):
    """Liste -> [(typ, ofs_oder_n, laenge)]"""
    out, p = [], 3
    n = lst[1] | lst[2] << 8
    for _ in range(n):
        t = lst[p]
        v = lst[p + 1] | lst[p + 2] << 8
        if t == 1:
            out.append((1, v, lst[p + 3]))
            p += 4
        else:
            out.append((t, v, 0))
            p += 3
    assert p == len(lst)
    return out


def expected_fb(bg, img, x0, y0, stride, clip=None):
    """Erwartungsbild: deckende Pixel aus img.pix (Palettenindex | None), nur innerhalb clip (cx0, cx1, cy0, cy1)."""
    fb = bytearray(bg)
    for r, row in enumerate(img.pix):
        for bx in range(img.w):
            if clip and not (clip[0] <= x0 + bx < clip[1] and clip[2] <= y0 + r < clip[3]):
                continue
            a, b = row[2 * bx], row[2 * bx + 1]
            ad = (y0 + r) * stride + x0 + bx
            if a is not None and b is not None:
                fb[ad] = a << 4 | b
            elif a is not None:
                fb[ad] = a << 4 | (fb[ad] & 15)
            elif b is not None:
                fb[ad] = (fb[ad] & 0xF0) | b
    return fb


def mem_for(ss, seed=1):
    rng = random.Random(seed)
    mem = bytearray(rng.randrange(256) for _ in range(65536))
    mem[VB:VB + len(ss.vram)] = vrl.decode(vrl.encode(list(ss.vram)))
    return mem


# ---------------------------------------------------------------- Hilfen fuer kleine Quellen

def mk_ase(tmp, name, cells, slices=None, tags=None, fmt="array", cw=16, ch=16, extra=None):
    """Aseprite-artiger Export. cells {(layer, frame): {(x, y): palidx}}; liefert Pfad der JSON."""
    keys = sorted(cells)
    sheet = Image.new("RGBA", (cw * len(keys), ch), (0, 0, 0, 0))
    frames = []
    for i, (ln, f) in enumerate(keys):
        for (x, y), c in cells[(ln, f)].items():
            sheet.putpixel((i * cw + x, y), PAL[c] + (255,))
        e = {"filename": f"{ln}#{f}", "frame": {"x": i * cw, "y": 0, "w": cw, "h": ch}, "rotated": False,
             "trimmed": False, "duration": 100}
        e.update((extra or {}).get(f"{ln}#{f}", {}))
        frames.append(e)
    sheet.save(os.path.join(tmp, name + ".png"))
    meta = {"image": name + ".png", "frameTags": tags or [],
            "slices": [{"name": n, "keys": k} for n, k in (slices or {}).items()]}
    fr = frames if fmt == "array" else {e["filename"]: {k: v for k, v in e.items() if k != "filename"} for e in frames}
    with open(os.path.join(tmp, name + ".json"), "w", encoding="utf-8") as fh:
        json.dump({"frames": fr, "meta": meta}, fh)
    return os.path.join(tmp, name + ".json")


def mk_toml(tmp, name, source, geom, extra="", **kw):
    sp = {"name": name, "geom": geom, "angles": 4}
    sp.update(kw)
    lines = ['format = "dbespr"', "version = 1", "", "[sprite]"]
    for k, v in sp.items():
        lines.append(f"{k} = {json.dumps(v) if not isinstance(v, dict) else '{ ' + ', '.join(f'{a} = {b}' for a, b in v.items()) + ' }'}")
    lines += ["", "[source]", source, extra]
    p = os.path.join(tmp, name + ".toml")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return p


def rect(x, y, w, h, c=5):
    return {(xx, yy): c for xx in range(x, x + w) for yy in range(y, y + h)}


class Tmp(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.tmp = self.t.name
        self.env = Env.get()

    def tearDown(self):
        self.t.cleanup()

    def build(self, cells, slices=None, tags=None, fmt="array", extra=None, **kw):
        js = mk_ase(self.tmp, "t", cells, slices, tags, fmt, extra=extra)
        toml = mk_toml(self.tmp, "t", 'aseprite = "t.json"', self.env.geom_path, **kw)
        return dbespr.build_spriteset(dbespr.load_conf(toml))


class TestAseprite(Tmp):
    def test_slice_pivot_and_default_foot(self):
        c = {("v0_d1", 0): rect(2, 3, 5, 4), ("v0_d2", 0): rect(2, 3, 5, 4)}
        sl = {"v0_d1": [{"frame": 0, "bounds": {"x": 2, "y": 3, "w": 5, "h": 4}, "pivot": {"x": 1, "y": 2}}],
              "v0_d2": [{"frame": 0, "bounds": {"x": 2, "y": 3, "w": 5, "h": 4}}]}
        ss, w, i, _ = self.build(c, sl)
        a, b = ss.images[ss.index[0]], ss.images[ss.index[1]]
        self.assertEqual((a.w, a.h, a.fx, a.fy), (3, 4, 0, 2))        # 5 Pixel -> 3 Byte, Pivot (1, 2) -> Byte 0
        # Slice ohne Pivot: Mitte der untersten Zeile (x = w_px // 2 = 2 -> Byte 1, y = h - 1)
        self.assertEqual((b.fx, b.fy), (1, 3))

    def test_key_selection_per_frame(self):
        c = {("v0_d1", f): rect(2, 2, 4 + f, 3) for f in range(3)}
        sl = {"v0_d1": [{"frame": 0, "bounds": {"x": 2, "y": 2, "w": 4, "h": 3}},
                        {"frame": 2, "bounds": {"x": 2, "y": 2, "w": 6, "h": 3}}]}
        ss, w, i, _ = self.build(c, sl)
        ws = [ss.images[ss.index[f * 4 * 3]].w for f in range(3)]
        self.assertEqual(ws, [2, 2, 3])       # Frame 1 -> Key 0 (4 Pixel), Frame 2 -> Key 2 (6 Pixel)
        self.assertTrue(any("außerhalb der Slice" in x for x in w))

    def test_bbox_without_slice_and_info(self):
        ss, w, infos, _ = self.build({("v0_d1", 0): rect(3, 5, 4, 6)})
        im = ss.images[0]
        self.assertEqual((im.w, im.h, im.fx, im.fy), (3, 6, 1, 5))     # x=3 ungerade -> Byte-Raster ab 2
        self.assertTrue(any("Fusspunkt automatisch" in x for x in infos))

    def test_empty_cel_unknown_layer_phase0_warning(self):
        c = {("v0_d1", 0): rect(1, 1, 4, 4), ("v0_d1", 1): {}, ("ref", 0): rect(0, 0, 2, 2), ("v1_d1", 1): rect(1, 1, 4, 4)}
        ss, w, infos, src = self.build(c, angles=2, phases=2)
        self.assertEqual(ss.index[(1 * 2 + 0) * 3], dbespr.FALLBACK)           # leere Cel -> $FF
        self.assertEqual(ss.index[(0 * 2 + 1) * 3], dbespr.NOIMG)              # Phase 0 ohne Bild -> $FE
        self.assertTrue(any("Phase 0 ohne Bild" in x for x in w))
        self.assertTrue(any("'ref'" in x for x in infos))

    def test_errors(self):
        cases = [({("v4_d1", 0): rect(0, 0, 2, 2)}, {}),                      # ai >= NA
                 ({("v0_d4", 0): rect(0, 0, 2, 2)}, {}),                       # d > D
                 ({("v0_d0", 0): rect(0, 0, 2, 2)}, {}),                       # d = 0
                 ({("v0_d1", 0): rect(0, 0, 2, 2)}, {"v0_d1#0": {"trimmed": True}}),
                 ({("v0_d1", 0): rect(0, 0, 2, 2)}, {"v0_d1#0": {"rotated": True}})]
        for cells, extra in cases:
            with self.assertRaises(dbetex.TexError, msg=str(list(cells))):
                self.build(cells, extra=extra)

    def test_json_hash_equals_array(self):
        c = {("v0_d1", 0): rect(2, 2, 5, 5), ("v0_d1", 1): rect(2, 2, 6, 5)}
        a, _, _, _ = self.build(c, fmt="array")
        b, _, _, _ = self.build(c, fmt="hash")
        self.assertEqual(dbespr.to_s2(a), dbespr.to_s2(b))

    def test_tags(self):
        c = {("v0_d1", f): rect(2, 2, 4, 4) for f in range(3)}
        tg = [{"name": "walk cycle_long", "from": 0, "to": 2, "direction": "pingpong"},
              {"name": "x", "from": 1, "to": 1}]
        ss, w, _, _ = self.build(c, tags=tg, extra={"v0_d1#2": {"duration": 200}})
        t = ss.tags
        self.assertEqual((t[0].name, t[0].first, t[0].count, t[0].mode), ("WALK_CYC", 0, 3, 2))
        self.assertEqual(t[0].dur, round((100 + 100 + 200) / 3 * 60 / 1000))
        self.assertEqual((t[1].mode, t[1].dur), (0, 6))
        self.assertTrue(any("gekuerzt" in x for x in w) and any("ungleiche Dauern" in x for x in w))


class TestPng(Tmp):
    def png(self, rects, size=(40, 40)):
        im = Image.new("RGBA", size, (0, 0, 0, 0))
        for (x, y, w, h) in rects:
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    im.putpixel((xx, yy), PAL[5] + (255,))
        im.save(os.path.join(self.tmp, "p.png"))

    def conf(self, images, **kw):
        extra = "".join(f"[[image]]\nbox = {b}\nphase = {p}\nangle = 0\ndepth = {d}\n{f}\n"
                        for (b, p, d, f) in images)
        return dbespr.load_conf(mk_toml(self.tmp, "p", 'png = "p.png"', self.env.geom_path, extra, angles=1, **kw))

    def test_byte_raster_odd_x(self):
        self.png([(3, 2, 3, 4)])
        ss, w, infos, _ = dbespr.build_spriteset(self.conf([([3, 2, 3, 4], 0, 1, "foot = [2, 3]")]))
        im = ss.images[0]
        self.assertEqual((im.w, im.h, im.fx, im.fy), (2, 4, 1, 3))     # x_e = 2, w = ceil((3+3-2)/2) = 2, fx = (3+2-2)//2
        self.assertEqual(im.pix[0], [None, 5, 5, 5])
        self.assertTrue(any("Bytegrenze" in x for x in infos))

    def test_errors(self):
        self.png([(3, 2, 3, 4)])
        with self.assertRaises(dbetex.TexError):          # doppelt
            dbespr.build_spriteset(self.conf([([3, 2, 3, 4], 0, 1, ""), ([3, 2, 3, 4], 0, 1, "")]))
        with self.assertRaises(dbetex.TexError):          # Tiefe > D
            dbespr.build_spriteset(self.conf([([3, 2, 3, 4], 0, 4, "")]))
        self.png([(0, 0, 8, 4)], (8, 4))
        with self.assertRaises(dbetex.TexError):          # Fusspunkt ausserhalb
            dbespr.build_spriteset(self.conf([([0, 0, 8, 4], 0, 1, "foot = [9, 1]")]))

    def test_height_warning(self):
        self.png([(0, 0, 8, 80)], (8, 80))
        ss, w, _, _ = dbespr.build_spriteset(self.conf([([0, 0, 8, 80], 0, 1, "")]))
        self.assertTrue(any("Wandoberkante" in x for x in w))

    def test_unknown_key_and_conflicts(self):
        p = mk_toml(self.tmp, "k", 'png = "p.png"', self.env.geom_path, bogus=1)
        with self.assertRaises(dbetex.TexError):
            dbespr.load_conf(p)
        for kw in ({"angle_map": [0, 1, 2, 4]}, {"angles": 2, "mirror": {"1": 1}}, {"derive": "x"}, {"phases": 33}):
            p = mk_toml(self.tmp, "k", 'aseprite = "t.json"', self.env.geom_path, **kw)
            with self.assertRaises(dbetex.TexError, msg=str(kw)):
                dbespr.load_conf(p)

    def test_default_angle_maps(self):
        for na, m in dbespr.DEFAULT_MAP.items():
            p = mk_toml(self.tmp, "k", 'aseprite = "t.json"', self.env.geom_path, angles=na)
            self.assertEqual(dbespr.load_conf(p)["angle_map"], m)

    def test_derive(self):
        self.png([(0, 0, 20, 16)])
        ss, w, _, _ = dbespr.build_spriteset(self.conf([([0, 0, 20, 16], 0, 1, "foot = [10, 15]")], derive="nearest"))
        pl = self.env.geom["planes"]
        Wf = lambda d: 1 / (0.5 / pl[d]["W"] + 0.5 / pl[d + 1]["W"])
        for d in (2, 3):
            k = Wf(d) / Wf(1)
            im = ss.images[ss.index[d - 1]]
            nw, nh = round(20 * k), round(16 * k)
            self.assertEqual((im.w, im.h), ((nw + 1) // 2, nh))
            self.assertEqual(len(im.pix[0]), 2 * im.w)
            self.assertTrue(all(v == 5 for row in im.pix for v in row[:nw]))
        self.assertTrue(any("aus Tiefe 1 abgeleitet" in x for x in w))
        self.assertFalse(any("Phase 0 ohne Bild" in x for x in w))


class TestBuild(unittest.TestCase):
    def setUp(self):
        self.env = Env.get()
        self.conf, self.ss, self.warns, self.infos, self.src = self.env.sets["blob"]

    def test_roundtrip_unclipped(self):
        ss, st = self.ss, self.env.stride
        mem = mem_for(ss)
        for i, im in enumerate(ss.images):
            fb = bytearray(mem)
            self.assertTrue(dbespr.render_image(ss, i, fb, fb, X0, Y0, self.env.vp, vb=VB))
            self.assertEqual(fb, expected_fb(mem, im, X0, Y0, st), f"Bild {i}")

    def test_clipping_exhaustive(self):
        ss, st = self.ss, self.env.stride
        mem = mem_for(ss, 2)
        n = 0
        for i, im in enumerate(ss.images):
            for L in sorted({0, 1, im.w // 2, im.w - 1, im.w}):
                for R in sorted({0, 1, im.w // 2, im.w - 1, im.w}):
                    for T in sorted({0, 1, im.h - 1, im.h}):
                        for B in sorted({0, 1, im.h - 1, im.h}):
                            if L >= R or T >= B:
                                continue
                            clip = (X0 + L, X0 + R, Y0 + T, Y0 + B)
                            n += 1
                            fb = bytearray(mem)
                            dbespr.render_image(ss, i, fb, fb, X0, Y0, self.env.vp, vb=VB, clip=clip)
                            self.assertEqual(fb, expected_fb(mem, im, X0, Y0, st, clip), f"Bild {i} {L, R, T, B}")
                            c = dbespr.clip_image(im, X0, Y0, *clip[:2], *clip[2:], st)
                            if c.vms:
                                cmds = vms_cmds(c.vms)
                                self.assertTrue(all(t in (1, 3, 8) for t, _, _ in cmds))
                                self.assertNotEqual(cmds[-1][0], 3)
                                self.assertTrue(all(not (a[0] == 3 and b[0] == 3) for a, b in zip(cmds, cmds[1:])))
                                used = sum(ln if t == 1 else n if t == 3 else 1 for t, n, ln in cmds)
                                self.assertLessEqual(used, im.rand_len)
                                self.assertTrue(any(t != 3 for t, _, _ in cmds))
        self.assertGreater(n, 1000)

    def test_unclipped_list_identical(self):
        for im in self.ss.images:
            c = dbespr.clip_image(im, X0, Y0, X0, X0 + im.w, Y0, Y0 + im.h, self.env.stride)
            self.assertEqual(c.vms, im.vms or None)
            self.assertEqual(c.ref, (X0, Y0))

    def test_kern_srcstep_rule(self):
        im = dbespr.Img(8, 6, 0, 0, [dbetex.Kern(100, 0, 0, 8, 6, 0), dbetex.Kern(500, 0, 0, 8, 6, 20)])
        c = dbespr.clip_image(im, 0, 0, 0, 8, 2, 6, 80)            # volle Breite, T > 0
        self.assertEqual(c.kerns, [(100 + 16, 0, 2, 8, 4, 0), (500 + 40, 0, 2, 8, 4, 20)])
        c = dbespr.clip_image(im, 0, 0, 1, 5, 0, 6, 80)            # schmaler: Typ 3 mit Schritt kw bzw. srcstep
        self.assertEqual(c.kerns, [(101, 1, 0, 4, 6, 8), (501, 1, 0, 4, 6, 20)])
        self.assertIsNone(c.vms)

    def test_vms_format_rules(self):
        for conf, ss, *_ in self.env.sets.values():
            for im in ss.images:
                if not im.vms:
                    continue
                cmds = vms_cmds(im.vms)
                prev = -1
                for t, ofs, ln in cmds:
                    self.assertIn(t, (1, 8))
                    self.assertGreater(ofs, prev)
                    prev = ofs
                    col = ofs % ss.stride
                    self.assertLess(ofs // ss.stride, im.h)
                    self.assertLessEqual(col + (ln or 1), im.w)

    def test_lookup(self):
        ss = self.ss
        for f in range(4):
            for a in range(4):
                for d in range(1, 4):
                    ai = ss.angle_map[a]
                    ff = f if f < ss.np else 0
                    v = ss.index[(ff * ss.na + ai) * ss.depth + d - 1]
                    if v == dbespr.FALLBACK:
                        v = ss.index[ai * ss.depth + d - 1]
                    self.assertEqual(dbespr.lookup(ss, f, a, d), None if v >= dbespr.NOIMG else v)
        self.assertEqual(dbespr.lookup(ss, 1, 0, 3), dbespr.lookup(ss, 0, 0, 3))      # $FF -> Phase 0
        self.assertEqual(dbespr.lookup(ss, 5, 1, 1), dbespr.lookup(ss, 0, 1, 1))      # f >= NP -> 0
        self.assertIsNone(dbespr.lookup(ss, 0, 0, 0))
        self.assertIsNone(dbespr.lookup(ss, 0, 0, 4))
        s2 = copy.copy(ss)
        s2.index = [dbespr.NOIMG] * len(ss.index)
        self.assertIsNone(dbespr.lookup(s2, 0, 0, 1))
        self.assertEqual([dbespr.view_angle(v, o) for v, o in ((0, 2), (0, 0), (1, 3), (3, 0), (2, 0xFF))], [0, 2, 0, 1, 0])

    def test_lookup_angle_map_per_na(self):
        ss = copy.copy(self.ss)
        for na, m in dbespr.DEFAULT_MAP.items():
            ss.na, ss.angle_map = na, m
            ss.index = list(range(ss.np * na * ss.depth))
            ss.index = [min(v, 0xFD) for v in ss.index]
            for a in range(4):
                self.assertEqual(dbespr.lookup(ss, 0, a, 2), ss.index[m[a] * ss.depth + 1])

    def test_mirror(self):
        conf, ss, w, i, src = self.env.sets["blob_m"]
        ss0 = self.ss
        for f in range(2):
            for d in range(1, 4):
                v3 = ss.index[(f * 4 + 3) * 3 + d - 1]
                v1 = ss.index[(f * 4 + 1) * 3 + d - 1]
                if v3 >= dbespr.NOIMG:
                    continue
                a, b = ss.images[v3], ss.images[v1]
                self.assertEqual(a.pix, [r[::-1] for r in b.pix])
                self.assertEqual((a.w, a.h, a.fy), (b.w, b.h, b.fy))
                self.assertEqual(a.fx, b.w - 1 - b.fx)
                self.assertIn("gespiegelt", src[(f, 3, d)])
        # Rundlauf der gespiegelten Bilder
        mem = mem_for(ss, 3)
        for i_, im in enumerate(ss.images):
            fb = bytearray(mem)
            dbespr.render_image(ss, i_, fb, fb, X0, Y0, self.env.vp, vb=VB)
            self.assertEqual(fb, expected_fb(mem, im, X0, Y0, self.env.stride))

    def test_blob_properties(self):
        ss = self.ss
        self.assertEqual((ss.na, ss.np, ss.depth, len(ss.tags)), (4, 2, 3, 2))
        self.assertEqual(ss.index[(1 * 4 + 0) * 3 + 2], dbespr.FALLBACK)     # v0_d3 Frame 1 leer
        self.assertEqual([t.name for t in ss.tags], ["IDLE", "WALK"])
        self.assertEqual(ss.tags[1].mode, 2)
        self.assertEqual(ss.tags[1].dur, round(150 * 60 / 1000))
        self.assertTrue(any("ref" in x for x in self.infos))
        # halbe Bytes am Rand und ein Loch: es gibt Typ-8-Befehle, im Koerper transparente Pixel
        self.assertTrue(any(t == 8 for im in ss.images if im.vms for t, _, _ in vms_cmds(im.vms)))
        front = ss.images[ss.index[0]]      # Vorderseite d = 1: Auge = transparentes Loch im Koerper
        self.assertTrue(any(row[c] is None and any(v is not None for v in row[:c]) and any(v is not None for v in row[c:])
                            for row in front.pix for c in range(len(row))))

    def test_format(self):
        ss = self.ss
        data = dbespr.to_s2(ss, 0x7000)
        self.assertEqual(data[:2], b"\x00\x70")
        c = data[2:]
        self.assertEqual(c[:3], b"S2\x01")
        NP, NA, D, NI = c[8], c[7], c[6], c[9]
        nk = struct.unpack_from("<H", c, 10)[0]
        o = struct.unpack_from("<HHHH", c, 16)
        self.assertEqual(o, (40, 40 + NP * NA * D, 40 + NP * NA * D + 16 * NI, 40 + NP * NA * D + 16 * NI + 8 * nk))
        o_data, total, u, crc, stride = struct.unpack_from("<HHHHH", c, 26)
        self.assertEqual(o_data, o[3] + 12 * c[24])
        self.assertEqual(total, len(c))
        self.assertEqual(u, len(ss.vram))
        self.assertEqual(crc, binascii.crc_hqx(ss.vram, 0xFFFF))
        self.assertEqual(stride, 80)
        self.assertEqual(struct.unpack_from("<H", c, 4)[0], self.env.geom["geometry_id"])
        self.assertEqual(list(c[12:16]), [0, 1, 2, 3])
        # VRL = VRAM
        env = self.env
        _, _, uu, stream = vrl.unpack_file(vrl.pack_file(vrl.encode(list(ss.vram)), 0x4000))
        self.assertEqual(uu, u)
        self.assertEqual(bytes(vrl.decode(stream)), ss.vram)
        # Rundlauf
        back = dbespr.from_s2(data, ss.vram)
        self.assertEqual(back.images, ss.images)
        self.assertEqual((back.index, back.tags, back.angle_map, back.np, back.na, back.depth, back.stride),
                         (ss.index, ss.tags, ss.angle_map, ss.np, ss.na, ss.depth, ss.stride))
        self.assertEqual(dbespr.to_s2(back, 0x7000), data)
        # Determinismus
        ss2 = dbespr.build_spriteset(dbespr.load_conf(os.path.join(env.dir, "blob.toml")))[0]
        self.assertEqual(dbespr.to_s2(ss2), data)
        self.assertEqual(ss2.vram, ss.vram)

    def test_from_s2_errors(self):
        data = dbespr.to_s2(self.ss)
        bad = [data[:20], data[:2] + b"XX" + data[4:], data[:4] + b"\x02" + data[5:], data[:-5]]
        for b in bad:
            with self.assertRaises(dbetex.TexError):
                dbespr.from_s2(b)
        off = bytearray(data)
        off[2 + 18] += 1
        with self.assertRaises(dbetex.TexError):
            dbespr.from_s2(bytes(off))
        with self.assertRaises(dbetex.TexError):
            dbespr.from_s2(data, self.ss.vram[:-1])

    def test_limits(self):
        ss = copy.copy(self.ss)
        ss.images = [self.ss.images[0]] * 255
        with self.assertRaises(dbetex.TexError):
            dbespr.to_s2(ss)
        big = dbespr.Img(4, 4, 0, 0, vms=b"\x00" * 9000, rand_len=1)
        ss = copy.copy(self.ss)
        ss.images, ss.index = [big], [0] * len(self.ss.index)
        with self.assertRaises(dbetex.TexError):
            dbespr.to_s2(ss)

    def test_gem_item(self):
        conf, ss, w, i, src = self.env.sets["gem"]
        self.assertEqual((ss.na, ss.np, ss.flags & 1), (1, 2, 1))
        self.assertEqual(ss.angle_map, [0, 0, 0, 0])
        mem = mem_for(ss, 4)
        for k, im in enumerate(ss.images):
            fb = bytearray(mem)
            dbespr.render_image(ss, k, fb, fb, X0, Y0, self.env.vp, vb=VB)
            self.assertEqual(fb, expected_fb(mem, im, X0, Y0, self.env.stride))

    def test_any_geometry(self):
        with tempfile.TemporaryDirectory() as d:
            p = mk_toml(d, "t", 'aseprite = "x.json"', self.env.geom_path, any_geometry=True)
            self.assertTrue(dbespr.load_conf(p)["any_geometry"])
        conf = dict(self.conf, any_geometry=True)
        self.assertEqual(struct.unpack_from("<H", dbespr.to_s2(dbespr.build_spriteset(conf)[0]), 6)[0], 0)

    def test_report_and_budget(self):
        conf, ss, w, i, src = self.env.sets["blob"]
        stream = vrl.encode(list(ss.vram))
        rp = dbespr.build_report(ss, conf, w, i, src, stream, len(dbespr.to_s2(ss)) - 2)
        self.assertEqual(len(rp["rows"]), 2 * 4 * 3)
        self.assertEqual(rp["max_vms"], max(len(x.vms) for x in ss.images))
        self.assertTrue(rp["tag_basic"].startswith("REM BLOB: IDLE 0-0"))
        self.assertIn("VCL", dbespr.report_md(rp))

    def test_sim_vms_type3(self):
        vram = bytearray(range(256)) * 2
        fb = bytearray([0xA0]) * 512
        lst = bytes((5, 3, 0, 3, 3, 0, 1, 0, 0, 2, 8, 9, 0))        # skip 3, copy 2, mix 1
        dbetex.sim_vms(vram, 10, 100, lst, fb)
        self.assertEqual(fb[100:102], bytes((13, 14)))               # Quelle 10 + 3
        self.assertEqual(fb[109], 0xAF)                              # Quelle 15, rechtes Pixel != Alpha
        self.assertEqual(fb[102], 0xA0)


class TestCli(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, DBESPR, *args], capture_output=True, text=True)

    def test_build_dump_preview_budget(self):
        env = Env.get()
        with tempfile.TemporaryDirectory() as out:
            r = self.run_cli("build", os.path.join(env.dir, "blob.toml"), "--out", out)
            self.assertEqual(r.returncode, 0, r.stderr)
            for f in ("blob.s2", "blob.vrl", "blob.spr.md", "blob.spr.json", "blob_preview.png"):
                self.assertTrue(os.path.exists(os.path.join(out, f)), f)
            r = self.run_cli("dump", os.path.join(out, "blob.s2"), "--vrl", os.path.join(out, "blob.vrl"), "--json")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["ni"], 20)
            r = self.run_cli("dump", os.path.join(out, "blob.s2"))
            self.assertEqual(r.returncode, 0)
            r = self.run_cli("preview", os.path.join(out, "blob.s2"), "--vrl", os.path.join(out, "blob.vrl"),
                             "--geom", env.geom_path, "--d", "2", "--out", os.path.join(out, "p.png"))
            self.assertEqual(r.returncode, 0, r.stderr)
            with Image.open(os.path.join(out, "p.png")) as pim:
                self.assertEqual(pim.size, (560, 384))
            r = self.run_cli("budget", os.path.join(out, "blob.s2"), "--pool", "10000")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("sprite", r.stdout)
            # P5-Werkzeug liest S2 im Budget ebenfalls
            r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "dbetex.py"), "budget",
                                os.path.join(out, "blob.s2"), "--pool", "10000"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_format_errors_exit1(self):
        with tempfile.TemporaryDirectory() as d:
            bad = os.path.join(d, "bad.s2")
            with open(bad, "wb") as f:
                f.write(b"\x00\x70S2\x01" + b"\0" * 10)
            r = self.run_cli("dump", bad)
            self.assertEqual(r.returncode, 1)
            self.assertNotIn("Traceback", r.stderr)
            r = self.run_cli("build", os.path.join(d, "missing.toml"))
            self.assertEqual(r.returncode, 1)
            self.assertNotIn("Traceback", r.stderr)
            r = self.run_cli()
            self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
