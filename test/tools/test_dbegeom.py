"""Tests fuer tools/dbegeom.py (docs/specs/P3-geometry.md, Abschnitt 10).

Aufruf: python3 -m unittest discover -s test/tools -v   (im Repo-Wurzelverzeichnis)
"""
import binascii
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import dbegeom  # noqa: E402
from PIL import Image  # noqa: E402

CUSTOM = {"viewport": {"preset": "custom", "width_px": 120, "height": 80, "depth": 2},
          "planes": {"ref_size": [176, 120], "center_x": 88, "width": [200, 110, 60, 30],
                     "top": [-10, 10, 25, 35], "bottom": [140, 100, 70, 55]}}


def conf_for(w, h, preset="westwood"):
    return dbegeom.parse_config({"viewport": {"preset": preset, "width_px": w, "height": h}})


_cache = {}


def geo_for(w, h):
    if (w, h) not in _cache:
        _cache[(w, h)] = dbegeom.Geometry(conf_for(w, h))
    return _cache[(w, h)]


def custom_geo():
    if "custom" not in _cache:
        _cache["custom"] = dbegeom.Geometry(dbegeom.parse_config(CUSTOM))
    return _cache["custom"]


def all_geos():
    return [geo_for(140, 96), geo_for(136, 92), geo_176(), custom_geo()]


def geo_176():
    # width_px ist auf 160 begrenzt; 176 x 120 nur ueber die Geometrie direkt (ohne Validierung der Breite)
    if "176" not in _cache:
        conf = conf_for(160, 100)
        conf.update(width=176, height=120)
        _cache["176"] = dbegeom.Geometry(conf)
    return _cache["176"]


def elem(geo, art, d, s):
    for i in geo.images:
        if i.art == art and i.d == d and i.s == s:
            return i
    return None


class FixedValues(unittest.TestCase):
    def test_planes_140(self):
        g = geo_for(140, 96)
        self.assertEqual(g.Wp, [164, 100, 64, 40, 24])
        self.assertEqual(g.T, [-13, 6, 13, 19, 22])
        self.assertEqual(g.B, [115, 83, 64, 51, 45])
        self.assertEqual([int(g.X(k, -0.5)) for k in range(5)], [-12, 20, 38, 50, 58])
        self.assertEqual([int(g.X(k, 0.5)) for k in range(5)], [152, 120, 102, 90, 82])

    def test_planes_136(self):
        g = geo_for(136, 92)
        self.assertEqual(g.Wp, [160, 100, 60, 36, 24])
        self.assertEqual(g.T, [-12, 6, 12, 18, 21])
        self.assertEqual(g.B, [110, 80, 61, 49, 43])

    def test_planes_176(self):
        g = geo_176()
        self.assertEqual(g.Wp, [208, 128, 80, 48, 32])
        self.assertEqual(g.T, [-16, 8, 16, 24, 28])
        self.assertEqual(g.B, [144, 104, 80, 64, 56])

    def test_bands_140(self):
        g = geo_for(140, 96)
        self.assertEqual(g.band_rows, [((0, 6), (83, 96)), ((6, 13), (64, 83)),
                                       ((13, 19), (51, 64)), ((19, 22), (45, 51))])
        self.assertEqual(g.horizon, (22, 45))

    def test_fronts_140(self):
        g = geo_for(140, 96)
        table = [(1, -1, 0, 6, 10, 77, 40), (1, 0, 10, 6, 50, 77, 0), (1, 1, 60, 6, 10, 77, 0),
                 (2, -1, 0, 13, 19, 51, 13), (2, 0, 19, 13, 32, 51, 0), (2, 1, 51, 13, 19, 51, 0),
                 (3, -2, 0, 19, 5, 32, 15), (3, -1, 5, 19, 20, 32, 0), (3, 0, 25, 19, 20, 32, 0),
                 (3, 1, 45, 19, 20, 32, 0), (3, 2, 65, 19, 5, 32, 0)]
        fronts = [i for i in g.images if i.art == dbegeom.ART_FRONT]
        self.assertEqual(len(fronts), 11)
        for d, s, x, y, w, h, sd in table:
            im = elem(g, dbegeom.ART_FRONT, d, s)
            self.assertEqual(im.rect, (x, y, w, h), (d, s))
            self.assertEqual(im.src_dx, sd, (d, s))
            self.assertEqual(im.kernel, (0, 0, w, h), (d, s))
            self.assertEqual(im.cover, (x, x + w), (d, s))

    def test_sides_140(self):
        g = geo_for(140, 96)
        table = [(0, -1, (0, 0, 10, 96), (0, 10)), (0, 1, (60, 0, 10, 96), (60, 70)),
                 (1, -1, (10, 6, 9, 76), (10, 19)), (1, 1, (51, 6, 9, 76), (51, 60)),
                 (2, -1, (19, 13, 6, 50), (19, 25)), (2, 1, (45, 13, 6, 50), (45, 51)),
                 (2, -2, (0, 17, 5, 37), (0, 5)), (2, 2, (65, 17, 5, 37), (65, 70)),
                 (3, -1, (25, 19, 4, 32), (25, 29)), (3, 1, (41, 19, 4, 32), (41, 45)),
                 (3, -2, (5, 19, 12, 32), (5, 17)), (3, 2, (53, 19, 12, 32), (53, 65)),
                 (3, -3, (0, 21, 5, 25), (0, 5)), (3, 3, (65, 21, 5, 25), (65, 70))]
        self.assertEqual(len([i for i in g.images if i.art == dbegeom.ART_SIDE]), 14)
        for d, s, rect, cov in table:
            im = elem(g, dbegeom.ART_SIDE, d, s)
            self.assertEqual(im.rect, rect, (d, s))
            self.assertEqual(im.cover, cov, (d, s))

    def test_counts(self):
        g = geo_for(140, 96)
        n = lambda art: len([i for i in g.images if i.art == art])
        self.assertEqual((n(dbegeom.ART_FRONT), n(dbegeom.ART_SIDE), n(dbegeom.ART_FLOOR), n(dbegeom.ART_CEIL)),
                         (11, 14, 18, 18))
        self.assertEqual(len([e for e in g.elements if isinstance(e, dict)]), 18)
        self.assertEqual(len(g.elements), 79)

    def test_anchors_140(self):
        g = geo_for(140, 96)
        table = {(1, 0): [(26, 67), (44, 67), (35, 71), (24, 76), (46, 76)],
                 (2, 0): [(29, 53), (40, 53), (35, 56), (28, 59), (42, 59)],
                 (3, 0): [(31, 46), (38, 46), (35, 47), (30, 49), (39, 49)],
                 (2, -1): [(7, 53), (18, 53), (10, 56), (0, 59), (14, 59)],
                 (0, 0): [(21, 88), (49, 88), (35, 95), (17, 104), (52, 104)]}
        slots = {(e["d"], e["s"]): e for e in g.elements if isinstance(e, dict)}
        for key, exp in table.items():
            got = [(ax // 2, ay) for ax, ay in slots[key]["anchors"]]
            self.assertEqual(got, exp, key)

    def test_budget_140_136(self):
        b = dbegeom.compute_budget(geo_for(140, 96))
        self.assertEqual(b["sum_front"], 6122)
        self.assertEqual(b["wall_style"], 11094)
        self.assertEqual(b["floor_bands"], 3570)
        self.assertEqual(b["ceil_bands"], 1540)
        b = dbegeom.compute_budget(geo_for(136, 92))
        self.assertEqual(b["sum_front"], 5728)
        self.assertEqual(b["floor_bands"], 3332)
        self.assertEqual(b["ceil_bands"], 1428)
        self.assertAlmostEqual(b["wall_style"] / 10370, 1, delta=0.03)

    def test_budget_176_plausible(self):
        b = dbegeom.compute_budget(geo_176())
        self.assertEqual(b["sum_front"], 9664)
        self.assertAlmostEqual(b["wall_style"] / 17252, 1, delta=0.03)


class Properties(unittest.TestCase):
    def test_symmetry(self):
        for g in all_geos():
            VW = g.VW
            for im in g.images:
                if im.s <= 0:
                    continue
                m = elem(g, im.art, im.d, -im.s)
                self.assertIsNotNone(m, im.name)
                self.assertEqual(m.rect[0], VW - im.rect[0] - im.rect[2], im.name)
                self.assertEqual(m.rect[1:4:2], im.rect[1:4:2])
                self.assertEqual(m.rect[2], im.rect[2])
                flip = {"L": "R", "R": "L", "#": "#", ".": "."}
                self.assertEqual(m.mask, ["".join(flip[c] for c in reversed(line)) for line in im.mask], im.name)

    def test_kernel_maximal(self):
        for g in all_geos():
            for im in g.images:
                w = im.rect[2]
                full = [[c == "#" for c in line] for line in im.mask]
                kx, ky, kw, kh = im.kernel
                for r in range(ky, ky + kh):
                    for c in range(kx, kx + kw):
                        self.assertTrue(full[r][c], im.name)
                # unabhaengig: maximales Rechteck per Histogramm je Zeile (Stapelverfahren)
                best, hist = 0, [0] * w
                for row in full:
                    hist = [hh + 1 if f else 0 for hh, f in zip(hist, row)]
                    stack = []
                    for i, hh in enumerate(hist + [0]):
                        start = i
                        while stack and stack[-1][1] >= hh:
                            st, sh = stack.pop()
                            best = max(best, sh * (i - st))
                            start = st
                        stack.append((start, hh))
                self.assertEqual(kw * kh, best, im.name)

    def test_cover(self):
        for g in all_geos():
            for im in g.images:
                if im.art not in (dbegeom.ART_FRONT, dbegeom.ART_SIDE):
                    continue
                d = im.d
                r0, r1 = max(g.T[d + 1], 0), min(g.B[d + 1], g.height)
                x, y, w, h = im.rect

                def col_ok(c):
                    if r1 <= r0:
                        return False
                    return all(y <= r < y + h and im.mask[r - y][c - x] == "#" for r in range(r0, r1))
                good = [col_ok(c) for c in range(x, x + w)]
                runs, i = [], 0
                while i < w:
                    if good[i]:
                        j = i
                        while j < w and good[j]:
                            j += 1
                        runs.append((j - i, i))
                        i = j
                    else:
                        i += 1
                c0, c1 = im.cover
                if not runs:
                    self.assertEqual((c0, c1), (0, 0), im.name)
                else:
                    self.assertEqual(c1 - c0, max(r[0] for r in runs), im.name)
                    self.assertTrue(all(good[c - x] for c in range(c0, c1)), im.name)
                if im.art == dbegeom.ART_FRONT:
                    self.assertEqual((c0, c1), (x, x + w))

    def test_fronts_width(self):
        for g in all_geos():
            for d in range(1, g.D + 1):
                fw = g.Wp[d] // 2
                for im in [i for i in g.images if i.art == dbegeom.ART_FRONT and i.d == d]:
                    if not im.flags & dbegeom.FLAG_CLIPPED:
                        self.assertEqual(im.rect[2], fw, im.name)
                    self.assertLessEqual(im.src_dx + im.rect[2], fw, im.name)

    def test_mask_in_rect_and_window(self):
        for g in all_geos():
            for im in g.images:
                x, y, w, h = im.rect
                self.assertEqual(len(im.mask), h)
                self.assertTrue(all(len(l) == w for l in im.mask))
                self.assertGreaterEqual(x, 0)
                self.assertGreaterEqual(y, 0)
                self.assertLessEqual(x + w, g.VW)
                self.assertLessEqual(y + h, g.height)
                self.assertTrue(any(c != "." for l in im.mask for c in l))
                # Rechteck eng: erste/letzte Zeile und Spalte belegt
                self.assertTrue(any(c != "." for c in im.mask[0]) and any(c != "." for c in im.mask[-1]))
                self.assertTrue(any(l[0] != "." for l in im.mask) and any(l[-1] != "." for l in im.mask))

    def test_bands_gapless(self):
        for g in all_geos():
            rows = []
            for (c0, c1), (f0, f1) in g.band_rows:
                rows += list(range(c0, c1)) + list(range(f0, f1))
            rows += list(range(*g.horizon))
            self.assertEqual(sorted(rows), list(range(g.height)))


class Dvg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = cls.tmp.name
        conf = conf_for(140, 96)
        cls.geo, cls.bud = dbegeom.generate(conf, cls.out, "west140")
        with open(os.path.join(cls.out, "west140.geom.json"), encoding="utf-8") as f:
            cls.js = json.load(f)
        with open(os.path.join(cls.out, "west140.dvg"), "rb") as f:
            cls.raw = f.read()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_header(self):
        raw = self.raw
        self.assertEqual(struct.unpack("<H", raw[:2])[0], 0xE800)
        c = raw[2:]
        self.assertEqual(c[0:3], b"DV\x01")
        self.assertEqual((c[3], c[4], c[5], c[6], c[7]), (70, 96, 3, 3, 79))
        self.assertEqual(struct.unpack("<HH", c[8:12]), (80, 0))
        self.assertEqual((c[14], c[15], c[16], c[17]), (22, 45, 16, 8))
        off_d, off_e, total = struct.unpack("<HHH", c[18:24])
        self.assertEqual((off_d, off_e, total), (24, 24 + 8 * 4, 24 + 32 + 16 * 79))
        self.assertEqual(len(c), total)

    def test_geometry_id(self):
        c = bytearray(self.raw[2:])
        gid = struct.unpack("<H", c[12:14])[0]
        c[12:14] = b"\0\0"
        c[10:12] = b"\0\0"       # origin zaehlt nicht zur ID
        exp = binascii.crc_hqx(bytes(c), 0xFFFF) or 1
        self.assertEqual(gid, exp)
        self.assertEqual(self.js["geometry_id"], gid)

    def test_geometry_id_ignores_origin(self):
        a = dbegeom.Geometry(conf_for(140, 96))
        b = dbegeom.Geometry(dbegeom.parse_config({"viewport": {"preset": "westwood", "width_px": 140, "height": 96, "origin": 321}}))
        for g in (a, b):
            g.atlas_size = dbegeom.layout_atlas(g)
        ca, ga = dbegeom.build_dvg(a)
        cb, gb = dbegeom.build_dvg(b)
        self.assertNotEqual(ca, cb)
        self.assertEqual(ga, gb)

    def test_deterministic(self):
        with tempfile.TemporaryDirectory() as t:
            dbegeom.generate(conf_for(140, 96), t, "west140")
            for fn in ("west140.dvg", "west140.geom.json", "west140.aseprite", "west140_atlas.png"):
                with open(os.path.join(t, fn), "rb") as a, open(os.path.join(self.out, fn), "rb") as b:
                    self.assertEqual(a.read(), b.read(), fn)

    def test_tables_match_json(self):
        c = self.raw[2:]
        js = self.js
        # Tiefentabelle
        for d in range(4):
            e = c[24 + 8 * d: 32 + 8 * d]
            (c0, c1), (f0, f1) = js["bands"][d]["ceil"], js["bands"][d]["floor"]
            self.assertEqual(list(e[:4]), [c0, c1, f0, f1])
            idx = [i for i, el in enumerate(js["elements"]) if el["d"] == d]
            self.assertEqual((e[4], e[5]), (idx[0], len(idx)))
            self.assertEqual(idx, list(range(idx[0], idx[0] + len(idx))))
            if d:
                fr = next(el for el in js["elements"] if el["name"] == f"front_d{d}_s+0")
                self.assertEqual((e[6], e[7]), (js["planes"][d]["W"] // 2, fr["rect"][0]))
            else:
                self.assertEqual((e[6], e[7]), (0, 0))
        # Elementtabelle
        base = 24 + 32
        arts = {"front": 0, "side": 1, "floor": 2, "ceil": 3, "obj": 4}
        for i, el in enumerate(js["elements"]):
            row = c[base + 16 * i: base + 16 * i + 16]
            self.assertEqual((row[0], row[1]), (arts[el["art"]], el["d"]))
            self.assertEqual(struct.unpack("b", bytes([row[2]]))[0], el["s"])
            if el["art"] == "obj":
                for p, a in enumerate(el["anchors"]):
                    self.assertEqual(struct.unpack("b", bytes([row[4 + 2 * p]]))[0],
                                     max(-128, min(127, a["px"][0] // 2)))
                    self.assertEqual(row[5 + 2 * p], min(255, a["px"][1]))
                    self.assertEqual(a["byte"], [row[4 + 2 * p] - 256 * (row[4 + 2 * p] > 127), row[5 + 2 * p]])
                self.assertEqual(list(row[14:16]), [0, 0])
                continue
            self.assertEqual(list(row[4:8]), el["rect"])
            self.assertEqual(list(row[8:12]), el["kernel"])
            self.assertEqual(list(row[12:14]), el["cover"])
            self.assertEqual(row[14], el["src_dx"])
            self.assertEqual(row[15], 0)
            fl = 0
            for name, bit in (("cover", 1), ("partial", 2), ("clipped", 4), ("bandcover", 8)):
                if name in el["flags"]:
                    fl |= bit
            self.assertEqual(row[3], fl)

    def test_order(self):
        els = self.js["elements"]
        keys = []
        for e in els:
            s = e["s"]
            cellkey = (0 if s == 0 else 2 * abs(s) - (1 if s < 0 else 0) + 0)
            keys.append((e["d"], cellkey, ["front", "side", "floor", "ceil", "obj"].index(e["art"])))
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(els), 79)

    def test_json_names_and_masks(self):
        names = [e["name"] for e in self.js["elements"]]
        self.assertEqual(len(set(names)), len(names))
        self.assertIn("front_d1_s-1", names)
        self.assertIn("obj_d1_s+0", names)
        el = next(e for e in self.js["elements"] if e["name"] == "floor_d0_s+0")
        self.assertEqual(el["rect"], [3, 83, 64, 13])
        self.assertEqual(el["kernel"], [7, 0, 50, 13])
        self.assertIn("clipped", el["flags"])
        self.assertEqual(el["polygon"], [[20, 83], [120, 83], [152, 115], [-12, 115]])  # Reihenfolge nach Spec 3.1

    def test_budget_in_json(self):
        self.assertEqual(self.js["budget"]["wall_style"], 11094)
        self.assertTrue(os.path.exists(os.path.join(self.out, "west140.budget.md")))

    # ---- Aseprite
    def test_aseprite(self):
        with open(os.path.join(self.out, "west140.aseprite"), "rb") as f:
            a = f.read()
        size, magic, frames, aw, ah, depth = struct.unpack("<IHHHHH", a[:14])
        self.assertEqual((size, magic, frames, depth), (len(a), 0xA5E0, 1, 8))
        self.assertEqual(a[28], 16)
        self.assertEqual(struct.unpack("<H", a[32:34])[0], 17)
        fsize, fmagic, old, dur, _, new = struct.unpack("<IHHHHI", a[128:144])
        self.assertEqual((fmagic, fsize), (0xF1FA, len(a) - 128))
        self.assertEqual(old, new)
        pos, chunks = 144, []
        while pos < len(a):
            sz, ct = struct.unpack("<IH", a[pos:pos + 6])
            chunks.append((ct, a[pos + 6:pos + sz]))
            pos += sz
        self.assertEqual(pos, len(a))
        self.assertEqual(sum(6 + len(d) for _, d in chunks), fsize - 16)
        self.assertEqual(len(chunks), new)
        layers = [d for t, d in chunks if t == 0x2004]
        self.assertEqual(len(layers), 2)
        cels = [d for t, d in chunks if t == 0x2005]
        self.assertEqual(len(cels), 2)
        for cel in cels:
            w, h = struct.unpack("<HH", cel[16:20])
            self.assertEqual((w, h), (aw, ah))
            self.assertEqual(struct.unpack("<H", cel[7:9])[0], 2)
            self.assertEqual(len(zlib.decompress(cel[20:])), aw * ah)
        pix0 = zlib.decompress(cels[0][20:])
        pix1 = zlib.decompress(cels[1][20:])
        self.assertEqual(set(pix1), {16})
        self.assertEqual(set(pix0), {16, 14, 1})
        slices = {}
        for i, (t, d) in enumerate(chunks):
            if t != 0x2022:
                continue
            nkeys, flags, _ = struct.unpack("<IIi", d[:12])
            nl = struct.unpack("<H", d[12:14])[0]
            name = d[14:14 + nl].decode()
            k = d[14 + nl:]
            frame, x, y, w, h = struct.unpack("<IiiII", k[:20])
            nine = struct.unpack("<iiII", k[20:36]) if flags & 1 else None
            self.assertEqual((nkeys, frame), (1, 0))
            self.assertEqual(chunks[i + 1][0], 0x2020)
            slices[name] = (x, y, w, h, nine, chunks[i + 1][1])
        expect = {e["name"]: e for e in self.js["elements"] if e.get("atlas")}
        expect.update({b["name"]: b for b in self.js["band_images"]})
        self.assertEqual(set(slices), set(expect))
        for name, (x, y, w, h, nine, ud) in slices.items():
            e = expect[name]
            self.assertEqual([x, y], e["atlas"])
            self.assertEqual((w, h), (e["rect"][2] * 2, e["rect"][3]))
            if "kernel" in e and e["kernel"][2]:
                kx, ky, kw, kh = e["kernel"]
                self.assertEqual(nine, (kx * 2, ky, kw * 2, kh))
            elif "kernel" in e:
                self.assertIsNone(nine)
            info = json.loads(ud[4 + 2:].decode())
            self.assertEqual(info["d"], e["d"])
        # Mannigfaltigkeit: Anzahl Atlasbilder = alle ausser Teilfronten, Objektplaetzen
        n_imgs = sum(1 for e in self.js["elements"] if e.get("atlas")) + len(self.js["band_images"])
        self.assertEqual(len(slices), n_imgs)
        self.assertEqual(sum(1 for e in self.js["elements"] if e["art"] == "front" and e.get("atlas")), 3)

    # ---- PNG
    def test_png(self):
        atlas = Image.open(os.path.join(self.out, "west140_atlas.png"))
        atlas.load()
        self.assertEqual(atlas.mode, "RGBA")
        self.assertEqual(list(atlas.size), self.js["atlas_size"])
        self.assertGreaterEqual(atlas.width, 148)
        ap = atlas.load()
        # Alpha 0 genau ausserhalb der Maske
        inside = set()
        for e in self.js["elements"] + self.js["band_images"]:
            if not e.get("atlas"):
                continue
            ax, ay = e["atlas"]
            if "mask" in e:
                mask = e["mask"]
            else:
                mask = ["#" * e["rect"][2]] * e["rect"][3]
            for r, line in enumerate(mask):
                for c, ch in enumerate(line):
                    for side, on in ((0, ch in "#L"), (1, ch in "#R")):
                        if on:
                            inside.add((ax + 2 * c + side, ay + r))
        for y in range(atlas.height):
            for x in range(atlas.width):
                self.assertEqual(ap[x, y][3] != 0, (x, y) in inside, (x, y))
        with Image.open(os.path.join(self.out, "west140_view.png")) as v:
            self.assertEqual(v.size, (140 * 4, 96 * 4))
        with Image.open(os.path.join(self.out, "tpl", "side_d1_s-1.png")) as t:
            self.assertEqual(t.size, (9 * 2 * 4, 76 * 4))
        with Image.open(os.path.join(self.out, "tpl", "front_d1_s+0.png")) as t:
            self.assertEqual(t.size, (100 * 4, 77 * 4))
        self.assertFalse(os.path.exists(os.path.join(self.out, "tpl", "front_d1_s-1.png")))


class Validation(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(ROOT, "tools", "dbegeom.py"), *args],
                              capture_output=True, text=True)

    def test_width_138(self):
        with tempfile.TemporaryDirectory() as t:
            r = self.run_cli("--preset", "westwood", "--width", "138", "--height", "96", "--out", t)
            self.assertEqual(r.returncode, 1)
            self.assertIn("width_px", r.stderr)

    def test_stride_60(self):
        with tempfile.TemporaryDirectory() as t:
            r = self.run_cli("--preset", "westwood", "--width", "140", "--height", "96", "--stride", "60", "--out", t)
            self.assertEqual(r.returncode, 1)
            self.assertIn("stride", r.stderr)

    def test_custom_not_falling(self):
        bad = {"viewport": dict(CUSTOM["viewport"]),
               "planes": dict(CUSTOM["planes"], width=[200, 110, 110, 30])}
        with self.assertRaises(dbegeom.GeomError):
            dbegeom.parse_config(bad)
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "view.toml")
            with open(p, "w") as f:
                f.write('[viewport]\npreset="custom"\nwidth_px=120\nheight=80\n[planes]\nref_size=[176,120]\n'
                        'width=[200,110,110,30]\ntop=[-10,10,25,35]\nbottom=[140,100,70,55]\n')
            self.assertEqual(self.run_cli(p, "--check").returncode, 1)

    def test_other_errors(self):
        for vp in ({"width_px": 140, "height": 96, "foo": 1}, {"width_px": 140, "height": 96, "depth": 4},
                   {"width_px": 140, "height": 96, "preset": "xyz"}, {"width_px": 140, "height": 200},
                   {"width_px": 200, "height": 96}, {"width_px": 140, "height": 96, "origin": 65000}):
            with self.assertRaises(dbegeom.GeomError, msg=vp):
                dbegeom.parse_config({"viewport": vp})
        bad = {"viewport": dict(CUSTOM["viewport"]), "planes": dict(CUSTOM["planes"], top=[-10, 10, 25, 25])}
        with self.assertRaises(dbegeom.GeomError):
            dbegeom.parse_config(bad)
        bad = {"viewport": dict(CUSTOM["viewport"]), "planes": dict(CUSTOM["planes"], top=[-10, 10, 25, 80])}
        with self.assertRaises(dbegeom.GeomError):
            dbegeom.parse_config(bad)

    def test_check_output_and_examples(self):
        r = self.run_cli(os.path.join(ROOT, "docs/specs/examples/view-west140.toml"), "--check")
        self.assertEqual(r.returncode, 0)
        lines = r.stdout.splitlines()
        self.assertEqual(len(lines), 79)
        self.assertIn("d=1 s=-1 front x=0 y=6 w=10 h=77 kern=0,0,10,77 cov=0..10 src_dx=40", lines)
        r = self.run_cli(os.path.join(ROOT, "docs/specs/examples/view-west136.toml"), "--check")
        self.assertEqual(r.returncode, 0)

    def test_wide_160(self):
        # Spec 4.3: Anker-Spalten d = 0, s = +-1 liegen bei width_px >= 144 ausserhalb -128 ... 127 -> Saettigung
        with tempfile.TemporaryDirectory() as t:
            g, _ = dbegeom.generate(conf_for(160, 100), t, "w160")
            with open(os.path.join(t, "w160.dvg"), "rb") as f:
                c = f.read()[2:]
        slot = next(e for e in g.elements if isinstance(e, dict) and (e["d"], e["s"]) == (0, 1))
        self.assertGreater(slot["anchors"][4][0] // 2, 127)
        i = g.elements.index(slot)
        row = c[24 + 32 + 16 * i: 24 + 32 + 16 * i + 16]
        self.assertEqual(row[4 + 2 * 4], 127)

    def test_center_x(self):
        bad = {"viewport": dict(CUSTOM["viewport"]), "planes": dict(CUSTOM["planes"], center_x=80)}
        with self.assertRaises(dbegeom.GeomError):
            dbegeom.parse_config(bad)
        bad = {"viewport": dict(CUSTOM["viewport"]), "planes": dict(CUSTOM["planes"], width=[200, "x", 60, 30])}
        with self.assertRaises(dbegeom.GeomError):
            dbegeom.parse_config(bad)

    def test_usage(self):
        self.assertEqual(self.run_cli().returncode, 2)


if __name__ == "__main__":
    unittest.main()


class BandCoverAndByteEdges(unittest.TestCase):
    """P6h: DVG-Flag Bit 3 (Bandabdeckung) und view.toml-Schalter byte_edges."""

    @staticmethod
    def pixels(im):
        x, y, w, h = im.rect
        out = set()
        for r, line in enumerate(im.mask):
            for bx, ch in enumerate(line):
                if ch in "#L":
                    out.add((2 * (x + bx), y + r))
                if ch in "#R":
                    out.add((2 * (x + bx) + 1, y + r))
        return out

    def test_bit3_on_fronts_containing_the_bands(self):
        for g in all_geos():
            for im in g.images:
                if im.art != dbegeom.ART_FRONT:
                    continue
                (c0, _), (_, f1) = g.band_rows[im.d]
                want = im.rect[1] <= c0 and im.rect[1] + im.rect[3] >= f1
                self.assertEqual(bool(im.flags & dbegeom.FLAG_BANDCOVER), want, im.name)
            self.assertTrue(any(i.flags & dbegeom.FLAG_BANDCOVER for i in g.images))

    def test_bit3_in_dvg_bytes(self):
        g = geo_for(140, 96)
        content, _ = dbegeom.build_dvg(g)
        base = 24 + 8 * (g.D + 1)
        n = 0
        for i, e in enumerate(g.elements):
            if isinstance(e, dict):
                continue
            fl = content[base + 16 * i + 3]
            self.assertEqual(bool(fl & 8), bool(e.flags & dbegeom.FLAG_BANDCOVER))
            n += bool(fl & 8)
        self.assertGreater(n, 0)

    def test_byte_edges_default_off(self):
        self.assertFalse(conf_for(140, 96)["byte_edges"])
        self.assertTrue(any(c in "LR" for im in geo_for(140, 96).images for line in im.mask for c in line))

    def test_byte_edges_option_checked(self):
        with self.assertRaises(dbegeom.GeomError):
            dbegeom.parse_config({"viewport": {"width_px": 140, "height": 96, "byte_edges": 1}})
        c = dbegeom.parse_config({"viewport": {"width_px": 140, "height": 96, "byte_edges": True}})
        self.assertTrue(c["byte_edges"])

    def test_byte_edges_whole_bytes(self):
        for w, h in ((140, 96), (136, 92)):
            conf = dbegeom.parse_config({"viewport": {"width_px": w, "height": h, "byte_edges": True}})
            g = dbegeom.Geometry(conf)
            exact = geo_for(w, h)
            self.assertEqual(len(g.images), len(exact.images))
            for im in g.images:
                self.assertFalse(any(c in "LR" for line in im.mask for c in line), im.name)
            # Rundung: ganze Bytes und leere Bytes bleiben, ein halbes Byte wird ganz oder leer (hoechstens 1 Pixel Unterschied)
            for im in g.images:
                ex = next(e for e in exact.images if e.name == im.name)
                a, b = self.pixels(ex), self.pixels(im)
                for p in a - b:
                    self.assertNotIn((p[0] ^ 1, p[1]), a, im.name)    # entfaellt nur, wenn es ein halbes Byte war
                for p in b - a:
                    self.assertIn((p[0] ^ 1, p[1]), a, im.name)       # kommt nur dazu: das Partnerpixel war das halbe Byte

    def test_byte_edges_tiling(self):
        """Gleiche Art und Tiefe, verschiedene Zellen s: keine Ueberlappung (Nachbarflaechen teilen sich die Kante)."""
        conf = dbegeom.parse_config({"viewport": {"width_px": 140, "height": 96, "byte_edges": True}})
        g = dbegeom.Geometry(conf)
        for d in range(g.D + 1):
            for art in (dbegeom.ART_FRONT, dbegeom.ART_SIDE, dbegeom.ART_FLOOR, dbegeom.ART_CEIL):
                seen = {}
                for im in g.images:
                    if im.d == d and im.art == art:
                        for p in self.pixels(im):
                            self.assertNotIn(p, seen, f"{im.name} und {seen.get(p)} ueberlappen")
                            seen[p] = im.name

    def test_byte_edges_fewer_half_bytes_and_new_id(self):
        conf = dbegeom.parse_config({"viewport": {"width_px": 140, "height": 96, "byte_edges": True}})
        _, gid_on = dbegeom.build_dvg(dbegeom.Geometry(conf))
        _, gid_off = dbegeom.build_dvg(geo_for(140, 96))
        self.assertNotEqual(gid_on, gid_off)

    def test_load_default_and_range(self):
        self.assertEqual(conf_for(140, 96)["load"], 0xE800)
        with tempfile.TemporaryDirectory() as td:
            conf = conf_for(140, 96)
            conf["load"] = 0xEC00                    # DVG (1,5 KB) reicht ueber $EDFF hinaus
            with self.assertRaises(dbegeom.GeomError) as cm:
                dbegeom.generate(conf, td, "x")
            self.assertIn("Bereichsende", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(td, "x.dvg")))
