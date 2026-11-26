"""Tests fuer tools/crawlconv.py (unittest, ohne Emulator)."""
import io
import os
import shutil
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import crawlconv  # noqa: E402
import crawlmap  # noqa: E402
import crawlsprites  # noqa: E402
import dbemap  # noqa: E402
import dbespr  # noqa: E402
import dbetex  # noqa: E402
import dbeview  # noqa: E402
import vrl  # noqa: E402
import wallconv  # noqa: E402

DATA = os.path.join(HERE, "data")
D81 = "/home/martin/git/dungeoncrawlerjam2025/crawl128-100f.d81"


def files():
    return crawlconv.read_dir(DATA)


class TestConv(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = files()
        cls.r = crawlconv.build(cls.files)

    def test_dvg(self):
        r = self.r
        g = dbeview.parse_dvg(r.files["crawl.dvg"])
        self.assertEqual(len(g.elems), 28)
        self.assertEqual((g.vw, g.vh, g.D, g.S, g.stride, g.origin, g.hy0, g.hy1), (68, 96, 3, 1, 80, 406, 0, 95))
        self.assertNotEqual(g.gid, 0)
        self.assertEqual(g.gid, dbetex.dvg_id(r.files["crawl.dvg"][2:]))
        self.assertEqual(struct.unpack_from("<H", r.files["crawl.dvg"], 0)[0], 0xE800)
        self.assertLessEqual(len(r.files["crawl.dvg"]) + 0xE800 - 2, 0xEE00)
        for dt in g.depth:
            self.assertEqual((dt.cy0, dt.cy1, dt.fy0, dt.fy1), (0, 0, 0, 0))
        # Reihenfolge: je Tiefe s = 0, -1, +1; je Zelle Fronten, Seiten, Objektplatz (nicht in Tiefe 0)
        got = [(e.d, e.s, e.art) for e in g.elems]
        want = [(0, -1, 1), (0, 1, 1),
                (1, 0, 0), (1, 0, 4), (1, -1, 0), (1, -1, 1), (1, -1, 4), (1, 1, 0), (1, 1, 1), (1, 1, 4),
                (2, 0, 0), (2, 0, 4), (2, -1, 0), (2, -1, 0), (2, -1, 1), (2, -1, 4), (2, 1, 0), (2, 1, 0), (2, 1, 1),
                (2, 1, 4), (3, 0, 0), (3, 0, 4), (3, -1, 0), (3, -1, 0), (3, -1, 4), (3, 1, 0), (3, 1, 0), (3, 1, 4)]
        self.assertEqual(got, want)
        self.assertEqual([dt.n for dt in g.depth], [2, 8, 10, 8])
        self.assertEqual(sum(dt.n for dt in g.depth), 28)
        # Fronten (d, 0): Breite und Spalte in der Tiefentabelle
        for d in (1, 2, 3):
            f = [e for e in g.elems if (e.d, e.s, e.art) == (d, 0, 0)][0]
            self.assertEqual((g.depth[d].fw, g.depth[d].fx), (f.w, f.x))
        self.assertEqual((g.depth[0].fw, g.depth[0].fx), (0, 0))

    def test_wall_elements(self):
        g = self.r.dvg
        walls, vram = crawlconv.parse_walls(self.files["walls.vdc"])
        by = {(e.d, e.s, e.art, e.index): e for e in g.elems}
        n = 0
        for e in g.elems:
            if e.art == 4:
                continue
            n += 1
            self.assertEqual((e.x, e.y, e.kx, e.ky, e.kw, e.kh), (e.x, 0, 0, 0, e.w, e.h))
            self.assertEqual(e.flags & 4, 0)                      # nicht beschnitten
            if e.h == 96:
                self.assertEqual(e.flags & 1, 1)
                self.assertEqual((e.c0, e.c1), (e.x, e.x + e.w))
                self.assertEqual(e.flags & 8, 8 if e.art == 0 else 0)
            else:
                self.assertEqual((e.flags, e.c0, e.c1), (0, 0, 0))
        self.assertEqual(n, 19)
        # genau ein Bild ist nicht deckend: Slot 9 (85 Zeilen)
        self.assertEqual([e.h for e in g.elems if e.art != 4 and e.h != 96], [85])
        self.assertEqual(len(by), 28)

    def test_anchors(self):
        g = self.r.dvg
        ghost = {(d, s): (col - 6, row - 5) for d, (_f, row, cols) in crawlsprites.GHOST_POS.items()
                 for s, col in cols.items()}
        gem = {k: (v[1][0][0] - 6, v[0] - 5) for k, v in crawlsprites.GEM_POS.items()}
        for e in g.elems:
            if e.art != 4:
                continue
            dd = min(e.d, 2)
            self.assertEqual(e.anchors[3], ghost[(dd, e.s)], (e.d, e.s))
            self.assertEqual(e.anchors[2], gem[(dd, e.s)], (e.d, e.s))
            self.assertEqual(e.anchors[0], e.anchors[2])
            self.assertEqual(e.anchors[1], e.anchors[2])
            self.assertEqual(e.anchors[4], e.anchors[2])
        # Beispielwerte aus crawlsprites: Geist (1, 0) Zeile 53 Spalte 36
        a = [e for e in g.elems if (e.d, e.s, e.art) == (1, 0, 4)][0].anchors
        self.assertEqual(a[3], (30, 48))
        self.assertEqual(a[2], (34, 75))

    def test_gid_identical(self):
        r = self.r
        gid = r.dvg.gid
        self.assertEqual(r.dts.geometry_id, gid)
        self.assertEqual(r.ghost.geometry_id, gid)
        self.assertEqual(r.gem.geometry_id, gid)
        self.assertEqual(struct.unpack_from("<H", r.files["walls.dts"], 2 + 4)[0], gid)
        self.assertEqual(struct.unpack_from("<H", r.files["ghost.s2"], 2 + 4)[0], gid)
        self.assertEqual(struct.unpack_from("<H", r.files["gem.s2"], 2 + 4)[0], gid)

    def test_dts(self):
        r = self.r
        ts = dbetex.from_dts(r.files["walls.dts"], r.wall_vram)
        self.assertEqual((ts.kind, ts.ne, ts.depth, ts.ns, len(ts.styles), len(ts.entries), ts.nk, ts.stride),
                         (0, 28, 3, 19, 1, 19, 19, 80))
        walls, vram = crawlconv.parse_walls(self.files["walls.vdc"])
        self.assertEqual(r.wall_vram, vram)
        self.assertEqual(ts.u, 22354)
        self.assertEqual(len(r.wall_vram), 22354)
        deck = 0
        for e in ts.entries:
            self.assertEqual(len(e.kerns), 1)
            self.assertEqual(e.rand_len, 0)
            self.assertEqual(e.vms, b"")
            self.assertEqual(e.flags & ~dbetex.F_DECKEND, 0)
            k = e.kerns[0]
            self.assertEqual((k.dx, k.dy), (0, 0))
            deck += bool(e.flags & dbetex.F_DECKEND)
            self.assertEqual(bool(e.flags & dbetex.F_DECKEND), k.h == 96)
        self.assertEqual(deck, 18)
        # Kern = Bild aus walls.vdc (Quelle, Breite, Hoehe)
        src = sorted((s, w, h) for _sl, s, w, h, _sz, _c in walls)
        self.assertEqual(sorted((e.kerns[0].src, e.kerns[0].w, e.kerns[0].h) for e in ts.entries), src)
        # Slotkarte: Wandelemente -> Slots in Elementreihenfolge, Rest $FF; Stil 0 -> Bild des Slots
        wall_idx = [i for i, e in enumerate(r.dvg.elems) if e.art != 4]
        self.assertEqual([ts.slot_map[i] for i in wall_idx], list(range(19)))
        self.assertEqual(ts.styles[0], list(range(19)))
        self.assertEqual(len(r.files["walls.dts"]) - 2 + 0x8000 < 0xB000, True)

    def test_ghost_mask(self):
        """Bild auf zwei Hintergruende gerendert = sim_vms des 0.1-Teils (3.4)."""
        r = self.r
        ss = r.ghost
        parts = crawlconv.parse_spr(self.files["ghost.spr"])
        gv = self.files["ghosts.vdc"][2:]
        self.assertEqual(ss.depth, 3)
        self.assertEqual((ss.na, ss.np, ss.angle_map), (4, 1, [0, 1, 2, 3]))
        vp = {"stride": 80, "origin": 0}
        n = 0
        for p in parts:
            if p["s"] != 0:
                continue
            idx = dbespr.lookup(ss, 0, p["angle"], p["d"])
            self.assertIsNotNone(idx)
            for bg in (0x00, 0xFF, 0x5A):
                f2 = bytearray([bg]) * (80 * (p["h"] + 1))
                f1 = bytearray(f2)
                dbetex.sim_vms(gv, p["src"], 0, p["list"], fb=f1)
                dbespr.render_image(ss, idx, ss.vram, f2, 0, 0, vp)
                self.assertEqual(f1, f2, (p["d"], p["angle"], bg))
            n += 1
        self.assertEqual(n, 8)
        self.assertIsNone(dbespr.lookup(ss, 0, 0, 3))                      # Tiefe 3: $FE
        for a in range(4):
            self.assertIsNone(dbespr.lookup(ss, 0, a, 3))
        self.assertLessEqual(len(r.files["ghost.s2"]) - 2, 0x1000)
        self.assertEqual(ss.u, len(r.ghost_vram))

    def test_ghost_black_eyes_opaque(self):
        """Schwarze Pixel in der Figur (Augen) bleiben deckend; die Maske ist nicht leer und nicht voll."""
        rows = self.r.ghost_rows[(1, 0)]
        flat = [v for row in rows for v in row]
        self.assertIn(None, flat)
        self.assertIn(0, flat)
        self.assertGreater(sum(1 for v in flat if v is not None), len(flat) // 4)

    def test_gem(self):
        r = self.r
        ss = r.gem
        font = self.files["font3o.vdc"][2:]
        self.assertEqual((ss.na, ss.np, ss.depth, ss.flags), (1, 1, 3, 1))
        self.assertEqual(len(ss.images), 1)
        im = ss.images[0]
        self.assertEqual((im.w, im.h, im.fx, im.fy), (6, 6, 0, 0))
        want = b"".join(font[4 * 18 + 3 * k:4 * 18 + 3 * k + 3] + font[5 * 18 + 3 * k:5 * 18 + 3 * k + 3]
                        for k in range(6))
        fb = bytearray(80 * 7)
        dbespr.render_image(ss, 0, ss.vram, fb, 0, 0, {"stride": 80, "origin": 0})
        self.assertEqual(b"".join(bytes(fb[80 * k:80 * k + 6]) for k in range(6)), want)
        self.assertIsNone(dbespr.lookup(ss, 0, 0, 3))
        for d in (1, 2):
            self.assertEqual(dbespr.lookup(ss, 0, 0, d), 0)
        self.assertLessEqual(len(r.files["gem.s2"]) - 2, 0x1000)

    def test_vrl_roundtrip(self):
        r = self.r
        for name, data in (("walls.vrl", r.wall_vram), ("ghost.vrl", r.ghost_vram), ("gem.vrl", r.gem_vram)):
            _l, _v, u, stream = vrl.unpack_file(r.files[name])
            self.assertEqual(u, len(data))
            self.assertEqual(bytes(vrl.decode(stream)), data)

    def test_vrl_parts(self):
        for mp in (1500, 3000, 5000):
            r = crawlconv.build(self.files, max_part=mp)
            names = sorted(n for n in r.files if n.startswith("walls") and n.endswith(".vrl"))
            self.assertGreater(len(names), 1, mp)
            self.assertNotIn("walls.vrl", names)
            self.assertEqual(names, [f"walls{i + 1}.vrl" for i in range(r.nparts)])
            out = bytearray()
            for n in names:
                f = r.files[n]
                self.assertLessEqual(len(f), mp, n)
                _l, _v, u, stream = vrl.unpack_file(f)
                toks = vrl.decode_tokens(stream)
                if n != "walls1.vrl":
                    self.assertEqual(toks[0].kind, "skip", n)
                out = vrl.decode(stream, base=out)           # RXV schreibt an dasselbe Ziel, Skips lassen es stehen
            self.assertEqual(bytes(out), r.wall_vram)
        # ohne Teilung bzw. wenn alles passt: eine Datei
        r = crawlconv.build(self.files, max_part=100000)
        self.assertIn("walls.vrl", r.files)
        self.assertEqual(r.nparts, 1)

    def test_ranges_and_vram_sum(self):
        i = self.r.info
        self.assertEqual((i["DA"], i["u_walls"]), (19200 + 1730, 22354))
        self.assertEqual(i["MA"] + 2 * 20 * 11, i["vram_end"])
        self.assertLessEqual(i["vram_end"], 46335)
        self.assertEqual(i["GA0"], i["DA"] + 22354)
        self.assertEqual(i["GA1"], i["GA0"] + len(self.r.ghost_vram))
        self.assertEqual(i["MA"], i["GA1"] + len(self.r.gem_vram))
        with self.assertRaises(crawlconv.ConvError):
            crawlconv.build(self.files, font_bytes=3000)           # Summe ueber der Grenze
        for n, load in (("crawl.dvg", 0xE800), ("walls.dts", 0x8000), ("ghost.s2", 0x6000), ("gem.s2", 0x7000),
                        ("crawl.dmp", 0x4000)):
            self.assertEqual(struct.unpack_from("<H", self.r.files[n], 0)[0], load, n)

    def test_dmp(self):
        m, _ = crawlmap.convert(self.files["crawl128.cd1"])
        self.assertEqual(self.r.files["crawl.dmp"], dbemap.to_dmp(m, 0x4000))
        self.assertEqual(len(self.r.files["crawl.dmp"]) - 2, 24 + 2 * 220 + 43 * 8 + 4 * len(m.events))

    def test_errors(self):
        f = dict(self.files)
        bad = bytearray(f["walls.wsm"])
        bad[2 + 10 + 5] ^= 1                                       # Breite des ersten Eintrags
        f["walls.wsm"] = bytes(bad)
        with self.assertRaises(crawlconv.ConvError):
            crawlconv.build(f)
        # Geistteil der Seite weicht von der Mitte ab
        f = dict(self.files)
        spr = bytearray(f["ghost.spr"])
        # Teil 1 = (1, -1, 0): Quelle auf die des naechsten Winkels setzen
        struct.pack_into("<H", spr, 2 + 6 + 15 * 1 + 6, 355)
        f["ghost.spr"] = bytes(spr)
        with self.assertRaises(crawlconv.ConvError):
            crawlconv.build(f)
        # Edelstein: zweites Zeichen nicht 3 Byte rechts
        f = dict(self.files)
        spr = bytearray(f["gem.spr"])
        struct.pack_into("<H", spr, 2 + 6 + 15 * 1 + 8, 5000)
        f["gem.spr"] = bytes(spr)
        with self.assertRaises(crawlconv.ConvError):
            crawlconv.build(f)
        with self.assertRaises(crawlconv.ConvError):
            crawlconv.read_dir(os.path.join(HERE, "nicht-da"))

    def test_cli(self):
        with tempfile.TemporaryDirectory(dir=os.path.join(ROOT, "build") if os.path.isdir(os.path.join(ROOT, "build"))
                                         else None) as td:
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(crawlconv.main(["--dir", DATA, td, "--json"]), 0)
            for n in ("crawl.dvg", "walls.dts", "walls.vrl", "ghost.s2", "ghost.vrl", "gem.s2", "gem.vrl",
                      "crawl.dmp", "crawlconv.md", "crawlconv.json"):
                self.assertTrue(os.path.exists(os.path.join(td, n)), n)
            with open(os.path.join(td, "crawlconv.md"), encoding="utf-8") as f:
                md = f.read()
            self.assertIn("Reserve", md)
            self.assertIn("Geometrie-ID", md)
            with open(os.path.join(td, "crawl.dvg"), "rb") as f:
                self.assertEqual(f.read(), self.r.files["crawl.dvg"])
            err = io.StringIO()
            with redirect_stderr(err):
                self.assertEqual(crawlconv.main(["--dir", os.path.join(td, "x"), td]), 1)
            self.assertIn("Fehler", err.getvalue())

    @unittest.skipUnless(os.path.exists(D81) and shutil.which("c1541"), "kein c1541 oder d81")
    def test_d81_equals_dir(self):
        with tempfile.TemporaryDirectory(dir=os.path.join(ROOT, "build") if os.path.isdir(os.path.join(ROOT, "build"))
                                         else None) as td:
            f = crawlconv.read_d81(D81, td)
        self.assertEqual({k: f[k] for k in crawlconv.FILES}, {k: self.files[k] for k in crawlconv.FILES})


if __name__ == "__main__":
    unittest.main()
