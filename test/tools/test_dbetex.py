"""Tests fuer tools/dbetex.py und tools/dbetexdemo.py (docs/specs/P5-textures.md, Abschnitt 10)."""
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
import dbegeom  # noqa: E402
import dbemap  # noqa: E402
import dbetex  # noqa: E402
import dbetexdemo  # noqa: E402
import vrl  # noqa: E402
from PIL import Image  # noqa: E402

DBETEX = os.path.join(ROOT, "tools", "dbetex.py")
DEMO_MAP = os.path.join(ROOT, "docs", "specs", "examples", "demo.toml")
PAL = dbegeom.PALETTE
VB = 0x5000


def rd(p):
    with open(p, "rb") as f:
        return f.read()


class Env:
    """Beispiel-Assets und gebaute Sets, einmal je Testlauf."""
    _inst = None

    @classmethod
    def get(cls):
        if cls._inst is None:
            cls._inst = cls()
        return cls._inst

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "tex")
        dbetexdemo.generate(self.dir)
        self.geom = dbetex.load_geom(os.path.join(self.dir, "west140.geom.json"),
                                     os.path.join(self.dir, "west140.dvg"))
        self.wconf = dbetex.load_tex_conf(os.path.join(self.dir, "walls.toml"))
        self.fconf = dbetex.load_tex_conf(os.path.join(self.dir, "floor.toml"))
        self.cconf = dbetex.load_tex_conf(os.path.join(self.dir, "ceil.toml"))
        self.walls = dbetex.build_texset(self.wconf)
        self.floor = dbetex.build_texset(self.fconf)
        self.ceil = dbetex.build_texset(self.cconf)


def env():
    return Env.get()


def conf_with(base, styles=None, **kw):
    c = copy.deepcopy(base)
    if styles is not None:
        c["styles"] = styles
    c.update(kw)
    return c


def expected_pixels(conf, geom, style_idx, slots, si, cache):
    """Erwartete Pixel (Palettenindex | None) fuer Slot si des Stils, unabhaengig vom Entry-Aufbau."""
    key = (style_idx, si)
    if key in cache:
        return cache[key]
    st = conf["styles"][style_idx]
    slot = slots[si]
    if slot["name"] in st["empty"]:
        cache[key] = None
        return None
    if slot["partial"]:
        names = {s["name"]: i for i, s in enumerate(slots)}
        full = expected_pixels(conf, geom, style_idx, slots, names[f"front_d{slot['d']}_s+0"], cache)
        if full is None:
            cache[key] = None
            return None
        sdx, w, h = slot["src_dx"], slot["rect"][2], slot["rect"][3]
        pix = [row[2 * sdx:2 * (sdx + w)] for row in full[:h]]
        cache[key] = dbetex.apply_mask(pix, slot["mask"])[0]
        return cache[key]
    src = (dbetex.PngSource(st["png"], geom, None, 0) if "png" in st
           else dbetex.AseSource(st["aseprite"], geom, st["tag"], st["frame"], None, 0))
    box = src.box(slot, [])
    if box is None:
        cache[key] = None
        return None
    pix, _ = dbetex.to_indices(src.img, box)
    if all(v is None for r in pix for v in r):
        cache[key] = None
        return None
    cache[key] = dbetex.apply_mask(pix, slot["mask"])[0]
    return cache[key]


def run_roundtrip(case, ts, conf, geom, seed=1):
    """Rendert alle Stile/Slots nach VRL-Entpacken und vergleicht mit dem Erwartungsbild."""
    slots = ts.slots
    stream = vrl.encode(list(ts.vram))
    mem = bytearray(65536)
    mem[VB:VB + len(ts.vram)] = vrl.decode(stream)
    stride = ts.stride
    rnd = random.Random(seed)
    cache = {}
    for sti in range(len(ts.styles)):
        for si, slot in enumerate(slots):
            v = ts.styles[sti][si]
            use = sti
            if v == dbetex.FALLBACK:
                use = 0
            bg = bytearray(rnd.randrange(256) for _ in range(65536))
            fb = bytearray(bg)
            dbetex.render(ts, sti, si, mem, fb, stride=stride, vb=VB)
            exp = expected_pixels(conf, geom, use, slots, si, cache)
            x, y, w, h = slot["rect"]
            ref = bytearray(bg)
            if exp is not None:
                for r in range(h):
                    for px in range(2 * w):
                        c = exp[r][px]
                        if c is None:
                            continue
                        a = (y + r) * stride + x + px // 2
                        ref[a] = (c << 4 | ref[a] & 15) if px % 2 == 0 else (ref[a] & 0xF0 | c)
            case.assertEqual(fb, ref, f"Stil {sti} Slot {slot['name']}")


class TestFixed(unittest.TestCase):
    def test_ziegel(self):
        e = env()
        ts, warns, infos = dbetex.build_texset(conf_with(e.wconf, e.wconf["styles"][:1]))
        self.assertEqual(len(ts.vram), 11094)
        self.assertEqual(len(ts.entries), 25)
        parts = [x for x in ts.entries if x.flags & dbetex.F_AUSSCHNITT]
        self.assertEqual(len(parts), 8)
        full_w = {1: 50, 2: 32, 3: 20}
        for en in ts.entries:
            self.assertTrue(en.flags & dbetex.F_DECKEND)
            slot = ts.slots[en.slot]
            if en.flags & dbetex.F_AUSSCHNITT:
                self.assertEqual((en.rand_len, len(en.vms)), (0, 0))
                self.assertEqual(len(en.kerns), 1)
                self.assertEqual(en.kerns[0].srcstep, full_w[slot["d"]])
            else:
                k = en.kerns[0]
                self.assertEqual((k.dx, k.dy, k.w, k.h), slot["kernel"])
        own = sum(1 for x in ts.entries if not x.flags & dbetex.F_AUSSCHNITT)
        self.assertEqual(own, 17)
        self.assertEqual(warns, [])

    def test_floor_ceiling(self):
        e = env()
        ts = e.floor[0]
        self.assertEqual(len(ts.vram), 3640)
        z = [x for x in ts.entries if x.flags & dbetex.F_ZEILEN]
        self.assertEqual([x.h for x in z], [13, 19, 13, 6])
        self.assertTrue(all(not x.kerns and not x.vms for x in z))
        self.assertEqual(len(e.ceil[0].vram), 1540 + 1574)
        self.assertFalse(any(x.flags & dbetex.F_ZEILEN for x in e.ceil[0].entries))

    def test_ns_and_slotmap(self):
        e = env()
        self.assertEqual(e.walls[0].ns, 25)
        self.assertEqual(e.floor[0].ns, 22)
        self.assertEqual(e.ceil[0].ns, 22)
        sm = e.walls[0].slot_map
        names = {x["index"]: x["name"] for x in e.geom["elements"]}
        got = {names[i]: sm[i] for i in (3, 7, 11, 15)}
        self.assertEqual(got, {"side_d0_s-1": 0, "side_d0_s+1": 1, "front_d1_s+0": 2, "front_d1_s-1": 3})
        for el in e.geom["elements"]:
            if el["art"] in ("floor", "ceil", "obj"):
                self.assertEqual(sm[el["index"]], 0xFF)
        ne = len(e.geom["elements"])
        self.assertEqual(sm[ne:], [0xFF] * 8)
        fm = e.floor[0].slot_map
        D = e.geom["viewport"]["depth"]
        self.assertEqual(sorted(v for v in fm[ne + D + 1:]), [18, 19, 20, 21])
        self.assertTrue(all(v == 0xFF for v in fm[ne:ne + D + 1]))

    def test_header_and_roundtrip(self):
        e = env()
        ts = e.walls[0]
        dts = dbetex.to_dts(ts, 0xA000)
        c = dts[2:]
        self.assertEqual(struct.unpack_from("<H", dts, 0)[0], 0xA000)
        self.assertEqual(c[:3], b"DT\x01")
        self.assertEqual(struct.unpack_from("<H", c, 4)[0], e.geom["geometry_id"])
        self.assertEqual((c[6], c[7], c[8], c[9]), (len(e.geom["elements"]), 3, 25, 4))
        o = struct.unpack_from("<HHHHHH", c, 12)
        ns, nst, ni, nk = 25, 4, c[10], c[11]
        nsm = len(e.geom["elements"]) + 8
        self.assertEqual(o[:5], (32, 32 + nsm, 32 + nsm + nst * ns, 32 + nsm + nst * ns + 16 * ni,
                                 32 + nsm + nst * ns + 16 * ni + 8 * nk))
        self.assertEqual(o[5], len(c))
        stream = vrl.encode(list(ts.vram))
        u, crc, stride = struct.unpack_from("<HHH", c, 24)
        self.assertEqual(u, vrl.unpacked_length(stream))
        self.assertEqual(crc, binascii.crc_hqx(ts.vram, 0xFFFF))
        self.assertEqual(stride, 80)
        back = dbetex.from_dts(dts, ts.vram)
        self.assertEqual(back.styles, ts.styles)
        self.assertEqual(back.slot_map, ts.slot_map)
        self.assertEqual(len(back.entries), len(ts.entries))
        for a, b in zip(back.entries, ts.entries):
            self.assertEqual((a.flags, a.slot, a.kerns, a.rand_ofs, a.rand, a.vms, a.fill, a.source),
                             (b.flags, b.slot, b.kerns, b.rand_ofs, b.rand, b.vms, b.fill, b.source))

    def test_vrl_roundtrip_data(self):
        e = env()
        ts = e.walls[0]
        file = vrl.pack_file(vrl.encode(list(ts.vram)), 0x4000)
        _, _, u, stream = vrl.unpack_file(file)
        self.assertEqual(bytes(vrl.decode(stream)), ts.vram)


class TestRoundtrip(unittest.TestCase):
    def test_walls(self):
        e = env()
        run_roundtrip(self, e.walls[0], e.wconf, e.geom)

    def test_floor(self):
        e = env()
        run_roundtrip(self, e.floor[0], e.fconf, e.geom)

    def test_ceil(self):
        e = env()
        run_roundtrip(self, e.ceil[0], e.cconf, e.geom)


def px_rows(*rows):
    return [list(r) for r in rows]


def sim_pack(pix, stride, max_kerns=0, kern_min=16, bg=None):
    """Packt ein Bild, zeichnet es mit den Simulatoren und gibt (fb, erwartet, rand, vms, alpha) zurueck."""
    h, w2 = len(pix), len(pix[0])
    st = dbetex.classify(pix)
    kerns = dbetex.choose_kerns(st, max_kerns, kern_min)
    alpha, rand, vms = dbetex.pack_image(pix, st, kerns, stride)
    mem = bytearray(65536)
    kb = dbetex.kern_bytes(pix, kerns)
    mem[0x4000:0x4000 + len(kb)] = kb
    mem[0x4000 + len(kb):0x4000 + len(kb) + len(rand)] = rand
    rnd = random.Random(5)
    fb = bytearray(rnd.randrange(256) for _ in range(65536)) if bg is None else bytearray(bg)
    ref = bytearray(fb)
    src = 0x4000
    for kx, ky, kw, kh in kerns:
        dbetex.sim_vmc(mem, src, ky * stride + kx, kw, kh, stride, 0, fb=fb)
        src += kw * kh
    if vms:
        dbetex.sim_vms(mem, src, 0, vms, fb=fb)
    for r in range(h):
        for p in range(w2):
            c = pix[r][p]
            if c is None:
                continue
            a = r * stride + p // 2
            ref[a] = (c << 4 | ref[a] & 15) if p % 2 == 0 else (ref[a] & 0xF0 | c)
    return fb, ref, rand, vms, alpha, kerns


class TestPacking(unittest.TestCase):
    def test_alpha(self):
        # halb-R-Bytes in Farbe 0 -> Alpha != 0
        pix = px_rows([None, 0, None, 3, 5, 6, None, 0])
        fb, ref, rand, vms, alpha, _ = sim_pack(pix, 20)
        self.assertNotEqual(alpha, 0)
        self.assertEqual(vms[0], alpha)
        self.assertEqual(fb, ref)
        # halb-L-Byte: rechts steht Alpha
        pix = px_rows([4, None, 7, 7, 9, None])
        fb, ref, rand, vms, alpha, _ = sim_pack(pix, 20)
        self.assertEqual(alpha, 0)
        self.assertEqual(rand[0], 0x40)
        self.assertEqual(fb, ref)

    def test_alpha_all_16(self):
        pix = [[None, c] for c in range(16)]
        pix = [sum(([None, c] for c in range(16)), [])]
        st = dbetex.classify(pix)
        n = dbetex.resolve_alpha_conflict(pix, st)
        self.assertEqual(n, 1)
        self.assertTrue(all(s in "FR" for s in st[0]))
        fb, ref, rand, vms, alpha, _ = sim_pack(pix, 40)
        self.assertEqual(fb, ref)
        # Warnung ueber den Builder
        e = env()
        slots, smap = dbetex.slot_infos(e.geom, "wall")
        b = dbetex._Builder(e.wconf, e.geom, slots, smap)
        si = next(i for i, s in enumerate(slots) if s["name"] == "front_d1_s+0")
        w, h = slots[si]["rect"][2], slots[si]["rect"][3]
        full = [[1] * (2 * w) for _ in range(h)]
        for i in range(16):
            full[0][2 * i] = None
            full[0][2 * i + 1] = i
        b.image_entry(si, full, slots[si]["mask"], "t")
        self.assertTrue(any("16 Farben" in x for x in b.warns))

    def test_vms_list_structure(self):
        e = env()
        ts = e.walls[0]
        for en in ts.entries:
            if not en.vms:
                continue
            n = en.vms[1] | en.vms[2] << 8
            p, used = 3, 0
            for _ in range(n):
                t = en.vms[p]
                if t == 1:
                    ln = en.vms[p + 3]
                    self.assertTrue(1 <= ln <= 255)
                    used += ln
                    p += 4
                else:
                    self.assertEqual(t, 8)
                    used += 1
                    p += 3
            self.assertEqual(p, len(en.vms))
            self.assertEqual(used, en.rand_len)

    def test_vms_only_for_non_kern(self):
        # Typ 8 genau fuer halbe Bytes, Typ 1 fuer volle, nichts fuer leere und Kernbytes
        pix = px_rows([None, None, 1, 2, 3, None, None, 4, 5, 6, 7, 8],
                      [None, None, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1],
                      [None, None, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1])
        st = dbetex.classify(pix)
        kerns = dbetex.choose_kerns(st, 1, 1)
        alpha, rand, vms = dbetex.pack_image(pix, st, kerns, 6)
        cmds = []
        p = 3
        while p < len(vms):
            cmds.append((vms[p], vms[p + 1] | vms[p + 2] << 8))
            p += 4 if vms[p] == 1 else 3
        self.assertEqual(kerns, [(1, 1, 5, 2)])
        self.assertEqual(cmds, [(1, 1), (8, 2), (8, 3), (1, 4)])
        self.assertEqual(len(rand), 1 + 1 + 1 + 2)
        self.assertEqual(vms[-1], 2)       # letzter Befehl: Typ 1 mit Laenge 2

    def test_long_run(self):
        pix = [[7] * 600]
        fb, ref, rand, vms, alpha, _ = sim_pack(pix, 320)
        self.assertEqual(fb, ref)
        self.assertEqual(len(rand), 300)
        n = vms[1]
        lens = []
        p = 3
        for _ in range(n):
            lens.append(vms[p + 3])
            p += 4
        self.assertEqual(lens, [255, 45])
        self.assertEqual(sum(lens), len(rand))

    def test_kerns(self):
        e = env()
        ts = e.walls[0]
        for en in ts.entries:
            self.assertLessEqual(len(en.kerns), 4)
        # Gitter-Front
        slots, smap = ts.slots, ts.slot_map
        si = next(i for i, s in enumerate(slots) if s["name"] == "front_d1_s+0")
        g = ts.entries[ts.styles[1][si]]
        self.assertGreaterEqual(len(g.kerns), 2)
        # nur volle Bytes und disjunkt: Gitterbild neu lesen
        c1 = conf_with(e.wconf, e.wconf["styles"][1:2], max_kerns=1)
        ts1, _, _ = dbetex.build_texset(c1)
        g1 = ts1.entries[ts1.styles[0][si]]
        self.assertEqual(len(g1.kerns), 1)
        self.assertLess(len(g.vms), len(g1.vms))
        c0 = conf_with(e.wconf, e.wconf["styles"][1:2], max_kerns=0)
        ts0, _, _ = dbetex.build_texset(c0)
        g0 = ts0.entries[ts0.styles[0][si]]
        self.assertEqual(g0.kerns, [])
        self.assertEqual(g0.rand_len, g.rand_len + sum(k.w * k.h for k in g.kerns))
        # weitere Kerne: h >= 2 und Flaeche >= kern_min
        for en in ts.entries:
            for k in en.kerns[1:]:
                if not en.flags & dbetex.F_AUSSCHNITT:
                    self.assertGreaterEqual(k.h, 2)
                    self.assertGreaterEqual(k.w * k.h, 16)
        # direkt: disjunkt
        pix = [[3] * 20 for _ in range(10)]
        st = dbetex.classify(pix)
        ks = dbetex.choose_kerns(st, 4, 16)
        self.assertEqual(ks, [(0, 0, 10, 10)])
        pix = [[3] * 20 for _ in range(10)]
        for r in range(10):
            pix[r][10] = None
            pix[r][11] = None
        ks = dbetex.choose_kerns(dbetex.classify(pix), 4, 16)
        self.assertEqual(len(ks), 2)
        cells = set()
        for kx, ky, kw, kh in ks:
            for r in range(ky, ky + kh):
                for c in range(kx, kx + kw):
                    self.assertNotIn((r, c), cells)
                    cells.add((r, c))
        self.assertEqual(dbetex.choose_kerns(st, 0, 16), [])


class TestDeckend(unittest.TestCase):
    def test_flags(self):
        e = env()
        ts = e.walls[0]
        slots = ts.slots
        for si, s in enumerate(slots):
            self.assertTrue(ts.entries[ts.styles[0][si]].flags & dbetex.F_DECKEND, s["name"])
            if s["art"] == "front":
                self.assertFalse(ts.entries[ts.styles[1][si]].flags & dbetex.F_DECKEND, s["name"])

    def test_side_transparent_pixel(self):
        e = env()
        slots, smap = dbetex.slot_infos(e.geom, "wall")
        names = {s["name"]: i for i, s in enumerate(slots)}
        cache = {}
        si = names["side_d1_s-1"]
        pix = [list(r) for r in expected_pixels(e.wconf, e.geom, 0, slots, si, cache)]
        slot = slots[si]
        x, y, w, h = slot["rect"]
        c0, c1 = slot["cover"]
        pl = e.geom["planes"][slot["d"] + 1]
        st = dbetex.classify(pix)
        self.assertTrue(dbetex.is_deckend(slot, st, e.geom))
        # ueber T_{d+1}: bleibt deckend
        r_out = pl["T"] - 1 - y
        cols = [bx for bx in range(w) if st[r_out][bx] == "F"]
        self.assertTrue(cols)
        p2 = copy.deepcopy(pix)
        p2[r_out][2 * cols[0]] = None
        st2 = dbetex.classify(p2)
        self.assertTrue(dbetex.is_deckend(slot, st2, e.geom))
        # innerhalb des Spaltenbereichs: nicht deckend
        p3 = copy.deepcopy(pix)
        p3[pl["T"] + 1 - y][2 * (c0 - x)] = None
        self.assertFalse(dbetex.is_deckend(slot, dbetex.classify(p3), e.geom))


def copy_png_with(src, dst, edit):
    im = Image.open(src).convert("RGBA")
    edit(im)
    im.save(dst)


class TestStyles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.e = env()

    def blank_png(self, name, rect_name, out):
        el = next(x for x in self.e.geom["elements"] if x["name"] == rect_name)
        ax, ay = el["atlas"]

        def edit(im):
            for r in range(el["rect"][3]):
                for c in range(el["rect"][2] * 2):
                    im.putpixel((ax + c, ay + r), (0, 0, 0, 0))
        p = os.path.join(self.tmp.name, out)
        copy_png_with(os.path.join(self.e.dir, "ziegel_atlas.png"), p, edit)
        return p

    def test_missing_image(self):
        e = self.e
        p = self.blank_png("x", "front_d2_s+0", "luecke.png")
        st = [e.wconf["styles"][0], {"name": "luecke", "png": p, "empty": [], "tag": None, "frame": None}]
        ts, warns, infos = dbetex.build_texset(conf_with(e.wconf, st))
        names = {s["name"]: i for i, s in enumerate(ts.slots)}
        for n in ("front_d2_s+0", "front_d2_s-1", "front_d2_s+1"):
            self.assertEqual(ts.styles[1][names[n]], 0xFF, n)
            self.assertLess(ts.styles[0][names[n]], 0xFE)
        self.assertEqual(ts.styles[1][names["front_d1_s+0"]], ts.styles[0][names["front_d1_s+0"]])
        self.assertTrue(any("nicht bemalt" in i for i in infos))
        # identische Bilder: gleicher Index, VRAM einmal
        self.assertEqual(len(ts.vram), 11094)
        # Stil 0 ohne Bild
        st = [st[1], st[0]]
        ts, warns, infos = dbetex.build_texset(conf_with(e.wconf, st))
        names = {s["name"]: i for i, s in enumerate(ts.slots)}
        for n in ("front_d2_s+0", "front_d2_s-1", "front_d2_s+1"):
            self.assertEqual(ts.styles[0][names[n]], 0xFE)
        self.assertTrue(any("Stil 0 ohne Bild" in w and "front_d2_s+0" in w for w in warns))
        self.assertEqual(ts.styles[1][names["front_d2_s+0"]] < 0xFE, True)

    def test_empty_and_identical(self):
        e = self.e
        s0 = dict(e.wconf["styles"][0])
        s1 = dict(s0, name="kopie", empty=["side_d3_s-3", "side_d3_s+3"])
        ts, _, _ = dbetex.build_texset(conf_with(e.wconf, [s0, s1]))
        names = {s["name"]: i for i, s in enumerate(ts.slots)}
        self.assertEqual(ts.styles[1][names["side_d3_s-3"]], 0xFE)
        self.assertEqual(ts.styles[1][names["side_d3_s+3"]], 0xFE)
        same = [n for n in names if n not in ("side_d3_s-3", "side_d3_s+3")]
        for n in same:
            self.assertEqual(ts.styles[1][names[n]], ts.styles[0][names[n]], n)
        self.assertEqual(len(ts.vram), 11094)
        self.assertEqual(len(ts.entries), 25)
        with self.assertRaises(dbetex.TexError):
            dbetex.build_texset(conf_with(e.wconf, [dict(s0, empty=["gibtsnicht"])]))

    def test_partial_follows_empty_full(self):
        e = self.e
        s0 = dict(e.wconf["styles"][0])
        s1 = dict(s0, name="x", empty=["front_d1_s+0"])
        ts, _, _ = dbetex.build_texset(conf_with(e.wconf, [s0, s1]))
        names = {s["name"]: i for i, s in enumerate(ts.slots)}
        for n in ("front_d1_s+0", "front_d1_s-1", "front_d1_s+1"):
            self.assertEqual(ts.styles[1][names[n]], 0xFE)


class TestInputs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def img(self, px, size=(4, 2)):
        im = Image.new("RGBA", size, (0, 0, 0, 0))
        for k, v in px.items():
            im.putpixel(k, v)
        return im

    def test_palette(self):
        im = self.img({(0, 0): PAL[3] + (255,), (1, 0): (0x55, 0x55, 0xFE, 255), (2, 0): (0x56, 0x56, 0xFC, 255)})
        pix, w = dbetex.to_indices(im, (0, 0, 4, 2))
        self.assertEqual(pix[0][:3], [3, 3, 3])
        self.assertEqual(len(w), 1)
        self.assertIn("2 Pixel nicht in der VDC-Palette", w[0])
        self.assertIn("max. Abstand", w[0])
        with self.assertRaises(dbetex.TexError):
            dbetex.to_indices(im, (0, 0, 4, 2), strict=True)
        _, w = dbetex.to_indices(self.img({(0, 0): PAL[3] + (255,)}), (0, 0, 4, 2), strict=True)
        self.assertEqual(w, [])

    def test_alpha(self):
        im = self.img({(0, 0): (255, 0, 0, 128)})
        with self.assertRaises(dbetex.TexError) as cm:
            dbetex.to_indices(im, (0, 0, 4, 2))
        self.assertIn("Masken-Ebene", str(cm.exception))
        pix, _ = dbetex.to_indices(im, (0, 0, 4, 2), alpha_threshold=100)
        self.assertEqual(pix[0][0], 9 if False else dbetex.nearest((255, 0, 0))[0])
        pix, _ = dbetex.to_indices(im, (0, 0, 4, 2), alpha_threshold=200)
        self.assertIsNone(pix[0][0])

    def test_key(self):
        im = Image.new("RGB", (2, 1), (255, 0, 255)).convert("RGBA")
        im.putpixel((1, 0), PAL[5] + (255,))
        pix, _ = dbetex.to_indices(im, (0, 0, 2, 1), key="FF00FF")
        self.assertEqual(pix, [[None, 5]])

    def test_indexed_reordered(self):
        pal = [0] * 768
        pal[3 * 7:3 * 7 + 3] = list(PAL[12])      # Index 7 im PNG = Farbe 12
        pal[3 * 2:3 * 2 + 3] = list(PAL[4])
        im = Image.new("P", (2, 1))
        im.putpalette(pal)
        im.putpixel((0, 0), 7)
        im.putpixel((1, 0), 2)
        p = os.path.join(self.tmp.name, "i.png")
        im.save(p)
        pix, _ = dbetex.to_indices(dbetex.read_rgba(p), (0, 0, 2, 1))
        self.assertEqual(pix, [[12, 4]])

    def test_outside_mask(self):
        e = env()
        slots, smap = dbetex.slot_infos(e.geom, "wall")
        si = next(i for i, s in enumerate(slots) if s["name"] == "side_d1_s-1")
        slot = slots[si]
        w, h = slot["rect"][2], slot["rect"][3]
        b = dbetex._Builder(e.wconf, e.geom, slots, smap)
        pix = [[6] * (2 * w) for _ in range(h)]
        b.image_entry(si, pix, slot["mask"], "t")
        self.assertTrue(any("ausserhalb der Maske" in x and "abgeschnitten" in x for x in b.warns))

    def test_template_unpainted(self):
        e = env()
        geo = dbegeom.Geometry(dbegeom.parse_config({"viewport": {"preset": "westwood", "width_px": 140,
                                                                  "height": 96}}))
        geo.atlas_size = dbegeom.layout_atlas(geo)
        dbegeom.write_pngs(geo, self.tmp.name, "t", 1, geo.atlas_size)
        st = [{"name": "leer", "png": os.path.join(self.tmp.name, "t_atlas.png"), "empty": [], "tag": None,
               "frame": None}]
        ts, warns, infos = dbetex.build_texset(conf_with(e.wconf, st))
        self.assertEqual(len(ts.entries), 0)
        self.assertEqual(sum(1 for i in infos if "nicht bemalt" in i), 25 - 8)

    def test_atlas_too_small(self):
        e = env()
        p = os.path.join(self.tmp.name, "klein.png")
        Image.open(os.path.join(e.dir, "ziegel_atlas.png")).crop((0, 0, 100, 100)).save(p)
        st = [{"name": "k", "png": p, "empty": [], "tag": None, "frame": None}]
        with self.assertRaises(dbetex.TexError):
            dbetex.build_texset(conf_with(e.wconf, st))

    def test_unknown_keys(self):
        p = os.path.join(self.tmp.name, "t.toml")
        with open(p, "w") as f:
            f.write('format="dbetex"\nversion=1\n[texset]\nname="a"\nkind="wall"\ngeom="g.json"\nfoo=1\n'
                    '[[style]]\nname="s"\npng="a.png"\n')
        with self.assertRaises(dbetex.TexError):
            dbetex.load_tex_conf(p)


class TestAseprite(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.e = env()
        with open(os.path.join(self.e.dir, "fenster.json")) as f:
            self.js = json.load(f)
        with open(os.path.join(self.tmp.name, "fenster.png"), "wb") as f:
            f.write(rd(os.path.join(self.e.dir, "fenster.png")))

    def write(self, js):
        p = os.path.join(self.tmp.name, "f.json")
        with open(p, "w") as f:
            json.dump(js, f)
        return p

    def src(self, js, tag="fenster", frame=None):
        return dbetex.AseSource(self.write(js), self.e.geom, tag, frame, None, 0)

    def test_array_hash_tag_frame(self):
        a = self.src(self.js)
        h = copy.deepcopy(self.js)
        h["frames"] = {fr["filename"]: fr for fr in h["frames"]}
        b = self.src(h)
        self.assertEqual(a.slices, b.slices)
        self.assertEqual(a.warn, [])
        c = self.src(self.js, tag="bogen")
        d = self.src(self.js, tag=None, frame=1)
        self.assertEqual(c.slices, d.slices)
        fw = self.js["frames"][1]["frame"]["x"]
        self.assertEqual(c.slices["front_d1_s+0"][0] - a.slices["front_d1_s+0"][0], fw)

    def test_slice_key_by_frame(self):
        js = copy.deepcopy(self.js)
        sl = js["meta"]["slices"][0]
        b0 = sl["keys"][0]["bounds"]
        sl["keys"].append({"frame": 1, "bounds": dict(b0, x=b0["x"] + 7)})
        a = self.src(js, tag="fenster")
        c = self.src(js, tag="bogen")
        fw = js["frames"][1]["frame"]["x"]
        self.assertEqual(a.slices[sl["name"]][0], b0["x"])
        self.assertEqual(c.slices[sl["name"]][0], fw + b0["x"] + 7)

    def test_errors_and_warnings(self):
        js = copy.deepcopy(self.js)
        js["meta"]["slices"][0]["keys"][0]["bounds"]["w"] += 2
        with self.assertRaises(dbetex.TexError):
            dbetex.build_texset(self._conf(js))
        js = copy.deepcopy(self.js)
        js["frames"][0]["trimmed"] = True
        with self.assertRaises(dbetex.TexError):
            self.src(js)
        js = copy.deepcopy(self.js)
        js["meta"]["slices"].append({"name": "wasanderes", "keys": [{"frame": 0, "bounds": {"x": 0, "y": 0, "w": 1,
                                                                                            "h": 1}}]})
        self.assertTrue(any("wasanderes" in w for w in self.src(js).warn))
        js = copy.deepcopy(self.js)
        js["meta"]["slices"].append(copy.deepcopy(js["meta"]["slices"][0]))
        with self.assertRaises(dbetex.TexError):
            self.src(js)

    def _conf(self, js):
        p = self.write(js)
        st = [self.e.wconf["styles"][0], {"name": "f", "aseprite": p, "tag": "fenster", "frame": None, "empty": []}]
        return conf_with(self.e.wconf, st)

    def test_moved_slice_found(self):
        e = self.e
        slots = e.walls[0].slots
        names = {s["name"]: i for i, s in enumerate(slots)}
        v = e.walls[0].styles[2][names["front_d3_s+0"]]
        self.assertLess(v, 0xFE)
        # fenster-Stil hat keine Seiten -> Rueckgriff
        self.assertEqual(e.walls[0].styles[2][names["side_d1_s-1"]], 0xFF)


class TestGeometry(unittest.TestCase):
    def test_dvg_id_mismatch(self):
        e = env()
        with tempfile.TemporaryDirectory() as t:
            js, dvg = dbetexdemo.default_geom(136, 92)
            p = os.path.join(t, "o.dvg")
            with open(p, "wb") as f:
                f.write(dvg)
            with self.assertRaises(dbetex.TexError):
                dbetex.load_geom(os.path.join(e.dir, "west140.geom.json"), p)

    def test_check_other_geometry(self):
        e = env()
        with tempfile.TemporaryDirectory() as t:
            js, dvg = dbetexdemo.default_geom(136, 92)
            gp = os.path.join(t, "w136.geom.json")
            with open(gp, "w") as f:
                json.dump(js, f)
            dbetexdemo.generate(os.path.join(t, "d"), gp)
            c = dbetex.load_tex_conf(os.path.join(t, "d", "walls.toml"))
            c["styles"] = c["styles"][:1]
            ts, _, _ = dbetex.build_texset(c)
            p136 = os.path.join(t, "w136.dts")
            with open(p136, "wb") as f:
                f.write(dbetex.to_dts(ts))
            p140 = os.path.join(t, "w140.dts")
            with open(p140, "wb") as f:
                f.write(dbetex.to_dts(e.walls[0]))
            dvg140 = os.path.join(e.dir, "west140.dvg")
            self.assertEqual(dbetex.main(["check", DEMO_MAP, "--walls", p136, "--dvg", dvg140]), 1)
            self.assertEqual(dbetex.main(["check", DEMO_MAP, "--walls", p140, "--dvg", dvg140]), 0)


class TestBackground(unittest.TestCase):
    def setUp(self):
        self.e = env()
        self.conf = dbetex.load_bg_conf(os.path.join(self.e.dir, "bg.toml"))

    def test_header_and_roundtrip(self):
        dbg, vram, warns = dbetex.build_background(self.conf)
        bg = dbetex.from_dbg(dbg)
        g = self.e.geom
        self.assertEqual((bg["vw"], bg["vh"], bg["geometry_id"]), (70, 96, g["geometry_id"]))
        self.assertEqual(bg["P"], 280)
        hy0, hy1 = g["horizon"]
        self.assertEqual(bg["h"], hy1 - hy0 + 6)
        self.assertEqual(bg["y0"], hy0 - 3)
        self.assertEqual(bg["offsets"], [0, 70, 140, 210])
        self.assertTrue(bg["wrap"])
        self.assertEqual(bg["u"], len(vram))
        self.assertEqual(bg["crc"], binascii.crc_hqx(vram, 0xFFFF))
        for r in range(96):
            if r < bg["y0"]:
                self.assertEqual(bg["fill"][r], 0x33)
            elif r >= bg["y0"] + bg["h"]:
                self.assertEqual(bg["fill"][r], 0x11)
            else:
                self.assertEqual(bg["fill"][r], 0)
        stream = vrl.encode(list(vram))
        mem = bytearray(65536)
        mem[VB:VB + len(vram)] = vrl.decode(stream)
        pano = [vram[i * 280:(i + 1) * 280] for i in range(bg["h"])]
        for v in range(4):
            fb = bytearray(65536)
            dbetex.render_background(bg, mem, v, fb, vb=VB, stride=80)
            for r in range(96):
                row = fb[r * 80:r * 80 + 70]
                if bg["y0"] <= r < bg["y0"] + bg["h"]:
                    p = pano[r - bg["y0"]]
                    exp = bytes(p[(bg["offsets"][v] + i) % 280] for i in range(70))
                else:
                    exp = bytes([bg["fill"][r]]) * 70
                self.assertEqual(bytes(row), exp, (v, r))
        # Versatz so, dass gewrappt wird
        c2 = dict(self.conf, offsets=[0, 100, 230, 270])
        dbg2, vram2, _ = dbetex.build_background(c2)
        bg2 = dbetex.from_dbg(dbg2)
        fb = bytearray(65536)
        dbetex.render_background(bg2, mem, 3, fb, vb=VB, stride=80)
        r = bg2["y0"]
        self.assertEqual(bytes(fb[r * 80:r * 80 + 70]), bytes(pano[0][(270 + i) % 280] for i in range(70)))

    def test_errors(self):
        c = dict(self.conf)
        with tempfile.TemporaryDirectory() as t:
            im = Image.open(self.conf["png"]).convert("RGBA")
            wide = Image.new("RGBA", (2 * 278, im.height), PAL[3] + (255,))
            p = os.path.join(t, "w.png")
            wide.save(p)
            with self.assertRaises(dbetex.TexError):
                dbetex.build_background(dict(c, png=p))        # P=278 nicht durch 4 teilbar, auto
            ok = dict(c, png=p, offsets=[0, 70, 140, 209], wrap=False)
            with self.assertRaises(dbetex.TexError):
                dbetex.build_background(ok)                    # 209 + 70 > 278
            im2 = im.copy()
            im2.putpixel((3, 3), (0, 0, 0, 0))
            p2 = os.path.join(t, "t.png")
            im2.save(p2)
            with self.assertRaises(dbetex.TexError):
                dbetex.build_background(dict(c, png=p2))
            ok2 = dict(c, png=p, offsets=[0, 70, 140, 208], wrap=True)
            dbetex.build_background(ok2)                       # mit WRAP gueltig


class TestBudgetCheckCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.e = env()
        t = self.tmp.name
        self.paths = {}
        for k, (ts, _, _) in (("walls", self.e.walls), ("floor", self.e.floor), ("ceil", self.e.ceil)):
            self.paths[k] = os.path.join(t, k + ".dts")
            with open(self.paths[k], "wb") as f:
                f.write(dbetex.to_dts(ts))
        dbg, vram, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(self.e.dir, "bg.toml")))
        self.paths["bg"] = os.path.join(t, "bg.dbg")
        with open(self.paths["bg"], "wb") as f:
            f.write(dbg)

    def test_budget(self):
        e = self.e
        fs = [self.paths["walls"], self.paths["floor"], self.paths["ceil"]]
        total = len(e.walls[0].vram) + len(e.floor[0].vram) + len(e.ceil[0].vram)
        r = dbetex.budget(fs, total)
        self.assertEqual(r["sum"], total)
        self.assertEqual(r["over"], 0)
        r = dbetex.budget(fs, total - 1)
        self.assertEqual(r["over"], 1)
        r = dbetex.budget(fs + [self.paths["bg"]], 30000, pool_start=0x2000)
        self.assertEqual(r["files"][1]["base"], 0x2000 + len(e.walls[0].vram))
        self.assertEqual(dbetex.main(["budget", *fs, "--pool", str(total)]), 0)
        self.assertEqual(dbetex.main(["budget", *fs, "--pool", str(total - 1)]), 1)

    def test_check_demo_map(self):
        e = self.e
        t = self.tmp.name
        one = conf_with(e.wconf, e.wconf["styles"][:1])
        ts1, _, _ = dbetex.build_texset(one)
        p1 = os.path.join(t, "w1.dts")
        with open(p1, "wb") as f:
            f.write(dbetex.to_dts(ts1))
        dvg = os.path.join(e.dir, "west140.dvg")
        args = ["check", DEMO_MAP, "--floors", self.paths["floor"], "--ceils", self.paths["ceil"], "--dvg", dvg]
        r = subprocess.run([sys.executable, DBETEX, *args, "--walls", p1], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("gitter", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        r = subprocess.run([sys.executable, DBETEX, *args, "--walls", self.paths["walls"]], capture_output=True,
                           text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_cli(self):
        t = self.tmp.name
        out = os.path.join(t, "o")
        for toml in ("walls", "floor", "ceil"):
            r = subprocess.run([sys.executable, DBETEX, "build", os.path.join(self.e.dir, toml + ".toml"),
                                "--out", out, "--no-preview"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("Stile", r.stdout)
        r = subprocess.run([sys.executable, DBETEX, "bg", os.path.join(self.e.dir, "bg.toml"), "--out", out],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        for f in ("demo_walls.dts", "demo_walls.vrl", "demo_walls.tex.md", "demo_walls.tex.json", "demo_sky.dbg",
                  "demo_sky.vrl", "demo_floor.dts"):
            self.assertTrue(os.path.exists(os.path.join(out, f)), f)
        r = subprocess.run([sys.executable, DBETEX, "dump", os.path.join(out, "demo_walls.dts"), "--vrl",
                            os.path.join(out, "demo_walls.vrl"), "--json"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertEqual(d["ns"], 25)
        self.assertEqual(d["nst"], 4)
        r = subprocess.run([sys.executable, DBETEX, "dump", os.path.join(out, "demo_sky.dbg")], capture_output=True,
                           text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run([sys.executable, DBETEX, "budget", os.path.join(out, "demo_walls.dts"), "--pool", "100"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Pool ueberschritten", r.stderr)
        # Formatfehler
        bad = os.path.join(t, "bad.dts")
        with open(bad, "wb") as f:
            f.write(b"\0\0DX" + bytes(60))
        r = subprocess.run([sys.executable, DBETEX, "dump", bad], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        r = subprocess.run([sys.executable, DBETEX, "build", os.path.join(t, "gibts.toml")], capture_output=True,
                           text=True)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        r = subprocess.run([sys.executable, DBETEX, "nix"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_determinism(self):
        e = self.e
        ts2, _, _ = dbetex.build_texset(e.wconf)
        self.assertEqual(dbetex.to_dts(ts2), dbetex.to_dts(e.walls[0]))
        self.assertEqual(ts2.vram, e.walls[0].vram)
        self.assertEqual(vrl.encode(list(ts2.vram)), vrl.encode(list(e.walls[0].vram)))
        c = dbetex.load_bg_conf(os.path.join(e.dir, "bg.toml"))
        self.assertEqual(dbetex.build_background(c)[:2], dbetex.build_background(c)[:2])
        with tempfile.TemporaryDirectory() as t:
            dbetexdemo.generate(t)
            for n in ("ziegel_atlas.png", "fenster.json", "himmel.png"):
                self.assertEqual(rd(os.path.join(t, n)), rd(os.path.join(e.dir, n)))

    def test_vms_reference_example(self):
        """Unabhaengiger Anker: Beispiel aus vdc-basic docs/reference/vms-format.md (Alpha 5, 3 x 2 Byte)."""
        mem = bytearray(65536)
        mem[0x100:0x105] = bytes((0x51, 0x11, 0x15, 0x22, 0x22))
        fb = bytearray(65536)
        fb[1000:1003] = bytes((0xAB, 0xCD, 0xEF))
        fb[1080:1083] = bytes((0x99, 0x99, 0x99))
        lst = bytes((5, 4, 0, 8, 0, 0, 1, 1, 0, 1, 8, 2, 0, 1, 80, 0, 2))
        dbetex.sim_vms(mem, 0x100, 1000, lst, fb=fb)
        self.assertEqual(bytes(fb[1000:1003]), bytes((0xA1, 0x11, 0x1F)))
        self.assertEqual(bytes(fb[1080:1083]), bytes((0x22, 0x22, 0x99)))
        # pack_image erzeugt fuer dieselben Pixel genau diese Liste und Daten (Alpha hier 0 statt 5)
        pix = [[None, 1, 1, 1, 1, None], [2, 2, 2, 2, None, None]]
        alpha, rand, vms = dbetex.pack_image(pix, dbetex.classify(pix), [], 80)
        self.assertEqual((alpha, rand), (0, bytes((0x01, 0x11, 0x10, 0x22, 0x22))))
        self.assertEqual(vms, bytes((0, 4, 0, 8, 0, 0, 1, 1, 0, 1, 8, 2, 0, 1, 80, 0, 2)))

    def test_vmc_srcstep_sim(self):
        mem = bytearray(range(256)) * 256
        fb = bytearray(65536)
        dbetex.sim_vmc(mem, 10, 1000, 3, 2, 100, 50, fb=fb)
        self.assertEqual(bytes(fb[1000:1003]), bytes(mem[10:13]))
        self.assertEqual(bytes(fb[1100:1103]), bytes(mem[60:63]))
        dbetex.sim_vmc(mem, 10, 2000, 3, 2, 100, 0, fb=fb)
        self.assertEqual(bytes(fb[2100:2103]), bytes(mem[13:16]))


if __name__ == "__main__":
    unittest.main()
