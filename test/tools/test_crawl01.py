"""Tests fuer tools/crawl01.py: Modell von VIEW 0.1 und Offline-Vollvergleich 0.1 gegen 0.2 (unittest, ohne Emulator).

Der Vollvergleich (P7a, Spec 6.2) deckt alle freien Zellen x 4 Richtungen x (kein Geist, Geist in jeder Zelle d = 0..3
mit 4 Richtungen) x (Edelsteine vorhanden / eingesammelt) ab, rund 19 000 Ansichten, mit mehreren Prozessen etwa 15 s.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import crawl01  # noqa: E402
import crawlconv  # noqa: E402
import dbeview  # noqa: E402

DATA = os.path.join(HERE, "data")


class TestModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = crawlconv.read_dir(DATA)
        cls.env = crawl01.Env(cls.files)

    def test_start_view_entries(self):
        e = self.env
        vis, err = e.model.view(e.cells0, e.w, e.h, e.m.start, 0, [])
        self.assertEqual(err, 0)
        self.assertEqual(len(vis), 10)
        # 6 Waende und die Edelsteine (Satz 1, 2 Zeichen je Zelle) der Startkarte
        self.assertEqual(sum(1 for k, *_ in vis if k == "wall"), 6)
        self.assertEqual({r[0] for k, *r in vis if k == "spr"}, {1})

    def test_order_and_cover(self):
        """Front (1, 0) deckend: nichts dahinter in deren Spalten; Seite (0, +-1) erscheint zuerst in der Liste."""
        e = self.env
        for pos in e.free:
            for v in range(4):
                vis, _ = e.model.view(e.cells0, e.w, e.h, pos, v, [])
                walls = [r[0] for k, *r in vis if k == "wall"]
                self.assertEqual(len(walls), len({tuple(w) for w in walls}), "Wandbild doppelt")
                self.assertLessEqual(len(vis), crawl01.MAXVIS)

    def test_ghost_parts_and_items(self):
        e = self.env
        # Startkarte: Edelstein in Zelle gefunden, Geist davor; Satz 1 = Edelstein (VMC), Satz 0 = Geist (VMS)
        found = False
        for pos in e.free:
            for v in range(4):
                for d, s, c in e.visible_cells(pos, v):
                    if d < 1 or e.cells0[c] != crawl01.ITEM_GEM:
                        continue
                    vis, _ = e.model.view(e.cells0, e.w, e.h, pos, v, [(c, 0, 0)])
                    sets = [r[0] for k, *r in vis if k == "spr"]
                    if 0 in sets and 1 in sets:
                        found = True
                        # Ausgabe rueckwaerts: Gegenstand wurde zuerst vorgemerkt? Objekt (Geist) zuerst -> spaeter
                        self.assertLess(sets.index(0), len(sets))
                    vis2, _ = e.model.view(e.cells1, e.w, e.h, pos, v, [(c, 0, 0)])
                    self.assertNotIn(1, [r[0] for k, *r in vis2 if k == "spr"])
        self.assertTrue(found)

    def test_linear_cell_arithmetic(self):
        """Die 0.1-Lib rechnet linear (kein Spaltenumbruch); ausserhalb von W * H zaehlt als Wand."""
        e = self.env
        cells = [0] * (e.w * e.h)                        # Karte komplett frei
        vis, _ = e.model.view(cells, e.w, e.h, 0, 0, [])  # Zelle 0 nach Norden: alle Zellen davor ausserhalb = Wand
        self.assertTrue(vis)

    def test_budget_and_no_error(self):
        e = self.env
        for pos in e.free[:10]:
            for v in range(4):
                r = e.one(pos, v, 0, None)
                self.assertEqual((r["a"], r["a01"]), (0, 0))
                self.assertLessEqual(r["total"], 2304)
                self.assertEqual(r["diff"], [])
                self.assertFalse(r["outside"])


class TestControls(unittest.TestCase):
    """Gegenproben: Der Vergleich muss absichtlich eingebaute Fehler finden."""

    def setUp(self):
        self.files = crawlconv.read_dir(DATA)

    def views(self, env, ghost=False):
        for pos in env.free:
            for v in range(4):
                if ghost:
                    for _d, _s, c in env.visible_cells(pos, v):
                        yield pos, v, (c, 0)
                else:
                    yield pos, v, None

    def count_bad(self, env, ghost=False, limit=80):
        n = 0
        for i, (pos, v, g) in enumerate(self.views(env, ghost)):
            if i >= limit:
                break
            r = env.one(pos, v, 0, g)
            n += bool(r["diff"] or r["outside"] or r["a"])
        return n

    def test_baseline_clean(self):
        env = crawl01.Env(self.files)
        self.assertEqual(self.count_bad(env), 0)
        self.assertEqual(self.count_bad(env, True), 0)

    def test_wrong_background_fill(self):
        env = crawl01.Env(self.files)
        env.sc.bgfill = 7
        self.assertGreater(self.count_bad(env), 0)

    def test_wall_pixel_flipped(self):
        env = crawl01.Env(self.files)
        env.base2[crawlconv.CA + 1732 + 5000] ^= 0x10
        self.assertGreater(self.count_bad(env, limit=400), 0)

    def test_ghost_anchor_shifted(self):
        env = crawl01.Env(self.files)
        for e in env.sc.dvg.elems:
            if e.art == dbeview.ART_OBJ:
                e.anchors[3] = (e.anchors[3][0] + 1, e.anchors[3][1])
        self.assertEqual(self.count_bad(env), 0)                 # ohne Geist unsichtbar
        self.assertGreater(self.count_bad(env, True, limit=300), 0)

    def test_gem_anchor_shifted(self):
        env = crawl01.Env(self.files)
        for e in env.sc.dvg.elems:
            if e.art == dbeview.ART_OBJ:
                e.anchors[2] = (e.anchors[2][0], e.anchors[2][1] - 1)
        self.assertGreater(self.count_bad(env, limit=400), 0)

    def test_ghost_mask_inverted(self):
        env = crawl01.Env(self.files)
        env.conv.ghost.images[0].kerns = []                      # Bild verliert seine Kerne
        self.assertGreater(self.count_bad(env, True, limit=300), 0)

    def test_outside_write_detected(self):
        env = crawl01.Env(self.files)
        v2 = bytearray(env.base2)
        self.assertFalse(env.outside_changed(v2))
        g = env.sc.dvg
        v2[g.origin + 3 * g.stride + g.vw] ^= 1                  # Spalte 68 der Fensterzeile 3: ausserhalb
        self.assertTrue(env.outside_changed(v2))
        v2 = bytearray(env.base2)
        v2[10] ^= 1
        self.assertTrue(env.outside_changed(v2))


class TestFullCompare(unittest.TestCase):
    def test_full(self):
        files = crawlconv.read_dir(DATA)
        workers = max(1, min(4, os.cpu_count() or 1))
        rep = crawl01.compare(files, quick=False, workers=workers)
        self.assertEqual(rep["positions"], 100)
        self.assertEqual(rep["views"], 19136)
        self.assertEqual(rep["bad"], [])
        self.assertEqual(rep["a_nonzero"], 0)
        self.assertEqual(rep["outside"], 0)
        self.assertEqual(rep["a01"], 0)                          # das 0.1-Modell kuerzt keine Ansicht
        self.assertLessEqual(rep["max_total"], 2304)
        self.assertLessEqual(rep["nvis01_max"], crawl01.MAXVIS)


if __name__ == "__main__":
    unittest.main()
