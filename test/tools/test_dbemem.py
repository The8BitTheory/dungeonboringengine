"""Tests for tools/dbemem.py (bank 1 memory map 0.2, P6 2.4) and the range checking of the tools (P6h)."""
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import dbemem  # noqa: E402
import dbemap  # noqa: E402
import dbetexdemo  # noqa: E402
import dbesprdemo  # noqa: E402

DEMO_MAP = os.path.join(ROOT, "docs", "specs", "examples", "demo.toml")


class TestAreas(unittest.TestCase):
    def test_defaults(self):
        want = {"dmp": 0x4000, "s2": 0x6000, "wall": 0x8000, "dvg": 0xE800, "floor": 0xEE00, "ceiling": 0xF600,
                "dbg": 0xFB80}
        for k, v in want.items():
            self.assertEqual(dbemem.default_load(k), v, k)

    def test_areas_valid(self):
        spans = sorted((a, e, k) for k, (a, e) in dbemem.AREAS.items())
        for (a0, e0, k0), (a1, e1, k1) in zip(spans, spans[1:]):
            self.assertLessEqual(e0, a1, f"{k0} and {k1} overlap")
        for k, (a, e) in dbemem.AREAS.items():
            self.assertTrue(any(wa <= a and e <= we for wa, we in dbemem.WINDOWS), k)
        self.assertGreaterEqual(spans[0][0], 0x4000)                 # VCL type 9: lists from $4000
        self.assertLessEqual(spans[-1][1], 0xFC00)                   # Blitz! runtime from $FC00
        for a, e, k in spans:
            self.assertFalse(a < 0xE800 and e > 0xB000 and a >= 0xB000, k)    # not in lib/LIBTAB/BSS

    def test_range_error(self):
        f = dbemem.range_error
        self.assertIsNone(f("dmp", 0x4000, 0x2000))
        self.assertIn("area end", f("dmp", 0x4000, 0x2001))
        self.assertIsNone(f("wall", 0x8000, 0x3000))
        self.assertIn("area end", f("wall", 0x8000, 0x3001))
        self.assertIsNone(f("dbg", 0xFB80, 0x80))
        self.assertIn("area end", f("dbg", 0xFB80, 0x81))
        self.assertIsNone(f("ceiling", 0xF600, 0x580))
        self.assertIn("area end", f("ceiling", 0xF600, 0x581))
        self.assertIsNone(f("floor", 0xEE00, 0x800))
        self.assertIn("area end", f("floor", 0xEE00, 0x801))
        # custom (dense) packing: the window counts
        self.assertIsNone(f("ceiling", 0xF000, 0xBFF))
        self.assertIn("free", f("ceiling", 0xF000, 0xC01))
        self.assertIsNone(f("floor", 0x4000, 0x6FFF))
        self.assertIn("free", f("floor", 0x4000, 0x7001))
        # load address in bank 0 view, lib/BSS or runtime
        for bad in (0x2000, 0x3FFF, 0xB000, 0xDC00, 0xE7FF, 0xFC00, 0xFF00):
            self.assertIn("load address", f("wall", bad, 16), hex(bad))


class TestTools(unittest.TestCase):
    def run_tool(self, *args):
        return subprocess.run([sys.executable, *args], capture_output=True, text=True)

    def test_dbemap(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "m.dmp")
            r = self.run_tool(os.path.join(ROOT, "tools", "dbemap.py"), "build", DEMO_MAP, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, "rb") as f:
                self.assertEqual(f.read(2), b"\x00\x40")
            r = self.run_tool(os.path.join(ROOT, "tools", "dbemap.py"), "build", DEMO_MAP, out, "--load", "0x5FF0")
            self.assertEqual(r.returncode, 1)
            self.assertIn("area end", r.stderr)
            r = self.run_tool(os.path.join(ROOT, "tools", "dbemap.py"), "build", DEMO_MAP, out, "--load", "0x2000")
            self.assertEqual(r.returncode, 1)
            self.assertIn("load address", r.stderr)

    def test_dbetex(self):
        with tempfile.TemporaryDirectory() as td:
            dbetexdemo.generate(td)
            toml = os.path.join(td, "walls.toml")
            out = os.path.join(td, "o")
            r = self.run_tool(os.path.join(ROOT, "tools", "dbetex.py"), "build", toml, "--out", out, "--no-preview")
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(os.path.join(out, "demo_walls.dts"), "rb") as f:
                self.assertEqual(f.read(2), b"\x00\x80")
            with open(toml, encoding="utf-8") as f:
                text = f.read()
            bad = os.path.join(td, "bad.toml")
            with open(bad, "w", encoding="utf-8") as f:
                f.write(re.sub(r"(?m)^load\s*=.*$", "load = 0xA000", text))      # 8736 bytes from $A000: beyond $AFFF
            r = self.run_tool(os.path.join(ROOT, "tools", "dbetex.py"), "build", bad, "--out", out, "--no-preview")
            self.assertEqual(r.returncode, 1)
            self.assertIn("area end", r.stderr)

    def test_dbespr(self):
        with tempfile.TemporaryDirectory() as td:
            dbesprdemo.generate(td)
            toml = os.path.join(td, "blob.toml")
            out = os.path.join(td, "o")
            r = self.run_tool(os.path.join(ROOT, "tools", "dbespr.py"), "build", toml, "--out", out)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(os.path.join(out, "blob.s2"), "rb") as f:
                self.assertEqual(f.read(2), b"\x00\x60")
            with open(toml, encoding="utf-8") as f:
                text = f.read()
            bad = os.path.join(td, "bad.toml")
            with open(bad, "w", encoding="utf-8") as f:
                f.write(re.sub(r"(?m)^load\s*=.*$", "load = 0x7800", text))      # S2 beyond $7FFF
            r = self.run_tool(os.path.join(ROOT, "tools", "dbespr.py"), "build", bad, "--out", out)
            self.assertEqual(r.returncode, 1)
            self.assertIn("area end", r.stderr)


if __name__ == "__main__":
    unittest.main()
