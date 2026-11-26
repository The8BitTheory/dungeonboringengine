"""Tests fuer tools/dbepersp.py (perspektivische Muster, docs/specs/P5-textures.md 10.4)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
import dbepersp  # noqa: E402
import dbetexdemo  # noqa: E402


class TestPersp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.geom, _ = dbetexdemo.default_geom()
        cls.P = dbepersp.Persp(cls.geom)
        cls.el = {e["name"]: e for e in cls.geom["elements"]}

    def test_planes(self):
        """An den Ebenen stimmen Z = W_1 / W_k und v der Seite mit der Front ueberein."""
        e = self.el["side_d1_s+1"]
        fn = self.P.side_map(e)
        pl = self.geom["planes"]
        u, v = fn(e["polygon"][0][0], pl[1]["T"] + pl[1]["W"] * 0.25)
        self.assertAlmostEqual(u, 1.0)
        self.assertAlmostEqual(v, 0.25)
        u2, _ = fn(e["polygon"][1][0], pl[2]["T"])
        self.assertAlmostEqual(u2, pl[1]["W"] / pl[2]["W"])

    def test_floor_depth(self):
        e = self.el["floor_d1_s+0"]
        fn = self.P.element_map(e)
        pl = self.geom["planes"]
        self.assertAlmostEqual(fn(70, pl[1]["B"])[1], 1.0)
        self.assertAlmostEqual(fn(70, pl[2]["B"])[1], pl[1]["W"] / pl[2]["W"])

    def test_deterministic_and_fits(self):
        e = self.el["side_d1_s-1"]
        f = dbepersp.element_fn(self.P, e, dbepersp.brick_pattern(), bias={14: 3})
        a = [f(px, r) for r in range(5) for px in range(8)]
        self.assertEqual(a, [f(px, r) for r in range(5) for px in range(8)])


if __name__ == "__main__":
    unittest.main()
