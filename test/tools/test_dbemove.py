"""Tests fuer tools/dbemove.py (MOVE-Referenz, P6f) und das Automap-Bit in dbeview (Scene.automap)."""
import copy
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, HERE)
import dbemap  # noqa: E402
import dbemove  # noqa: E402
import dbeview  # noqa: E402

T = dbemap.Tile


def small_map():
    t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, 1 | 4, 0)]
    rows = ["####", "#..#", "#..#", "####"]
    m = dbemap.Map("t", 4, 4, t, [1 if c == "#" else 0 for r in rows for c in r], [0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0,
                   0, 0, 0, 0], [dbemap.Event(5, 4, 1), dbemap.Event(5, 4, 2), dbemap.Event(10, 3, 0)], 5, 1, 1)
    dbemap.validate(m)
    return m


class TestMove(unittest.TestCase):
    def test_steps_and_turns(self):
        m = small_map()
        r = dbemove.move(m, 5, 1, [], 0)                    # nach Osten: Zelle 6 frei
        self.assertEqual((r.a, r.x, r.y, r.pos, r.dir, r.p1, r.p2), (0, 0, 0, 6, 1, 0, 0xFFFF))
        r = dbemove.move(m, 5, 1, [], 1)                    # zurueck: Zelle 4 = Wand (Kachel 1, WEG)
        self.assertEqual((r.x, r.y, r.pos, r.p1, r.p2), (1, 1, 5, 5, 0))
        r = dbemove.move(m, 5, 0, [], 0)                    # Norden: Zeile 0 ist Wand
        self.assertEqual((r.x, r.y), (1, 1))
        r = dbemove.move(m, 5, 2, [], 3)                    # Blick S, rechts = W: Zelle 4, Wand
        self.assertEqual((r.x, r.pos), (1, 5))
        r = dbemove.move(m, 6, 1, [], 0)                    # Osten: Zelle 7 Wand; Kachel am Rand
        self.assertEqual((r.x, r.y), (1, 1))
        r = dbemove.move(m, 10, 0, [], 6)                   # Umdrehen
        self.assertEqual((r.x, r.y, r.dir, r.pos, r.p2), (0, 0, 2, 10, 2))
        self.assertEqual([dbemove.move(m, 5, v, [], 4).dir for v in range(4)], [3, 0, 1, 2])
        self.assertEqual([dbemove.move(m, 5, v, [], 5).dir for v in range(4)], [1, 2, 3, 0])

    def test_outside(self):
        m = small_map()
        m.cells[0] = 0                                      # Zelle 0 frei: Kartenrand
        r = dbemove.move(m, 0, 0, [], 0)
        self.assertEqual((r.x, r.y, r.pos), (1, m.outside, 0))

    def test_objects_and_events(self):
        m = small_map()
        o = dbeview.Obj(6, 0)
        r = dbemove.move(m, 5, 1, [o], 0)
        self.assertEqual((r.x, r.y, r.pos), (2, 0, 5))
        for kw in ({"noblock": True}, {"hidden": True}):
            r = dbemove.move(m, 5, 1, [dbeview.Obj(6, 0, **kw)], 0)
            self.assertEqual((r.x, r.pos), (0, 6))
        objs = [dbeview.Obj(0, 0)] * 16 + [dbeview.Obj(6, 0)]    # nur 16 gelesen
        self.assertEqual(dbemove.move(m, 5, 1, objs, 0).x, 0)
        self.assertEqual(dbemove.move(m, 5, 1, objs, 0, objn=1).x, 0)
        self.assertEqual(dbemove.move(m, 5, 1, [dbeview.Obj(6, 0)], 0, objn=0).x, 0)
        self.assertEqual(dbemove.move(m, 5, 1, [], 7).a, 6)

    def test_automap_reference(self):
        """Marken nur mit Scene.automap; gesetzte Zellen sind begehbar oder Wand mit sichtbarer Flaeche."""
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        A = dbeview.build_demo_assets(tmp.name)
        demo = dbemap.load_toml(os.path.join(ROOT, "docs", "specs", "examples", "demo.toml"))
        sc = dbeview.make_scene(A, demo, demo.start, demo.direction)
        c0 = list(demo.content)
        dbeview.view(sc)
        self.assertEqual(demo.content, c0)                  # ohne automap unveraendert
        sc.automap = True
        dbeview.view(sc)
        marked = [i for i, (a, b) in enumerate(zip(c0, demo.content)) if a != b]
        self.assertTrue(marked)
        self.assertTrue(all(demo.content[i] == c0[i] | 0x40 for i in marked))
        self.assertIn(demo.start, marked)                   # Boden der eigenen Zelle (d = 0) ist sichtbar


if __name__ == "__main__":
    unittest.main()
