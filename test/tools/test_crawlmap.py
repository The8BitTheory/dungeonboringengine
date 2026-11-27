"""Tests for tools/crawlmap.py (unittest)."""
import io
import os
import shutil
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import crawlmap  # noqa: E402
import dbemap  # noqa: E402

CRAWL = os.path.join(HERE, "data", "crawl128.cd1")
D81 = "/home/martin/git/dungeoncrawlerjam2025/game/crawl.d81"


def read_crawl():
    with open(CRAWL, "rb") as f:
        return f.read()


def synth(w, h, vals, records, name=b"TEST", gems=0):
    os_ = 5 + 3 * len(records)
    b = bytes([os_, w, h]) + struct.pack("<H", gems)
    for ch, cell in records:
        b += bytes([ord(ch)]) + struct.pack("<H", cell)
    return b"\x3c\x21" + b + bytes(vals) + name


class TestCrawl(unittest.TestCase):
    def test_convert(self):
        data = read_crawl()
        self.assertEqual(len(data), 244)
        m, warn = crawlmap.convert(data)
        self.assertEqual(warn, [])
        self.assertEqual((m.width, m.height, len(m.tiles), m.start, m.direction), (20, 11, 43, 198, 0))
        for v in (0, 2, 4, 6, 18, 40):
            t = m.tiles[v]
            self.assertEqual((t.walls, t.floor, t.ceiling, t.flags), ((0, 0, 0, 0), 0, 0, 0))
        self.assertEqual(m.tiles[1].flags, 0x17)
        self.assertEqual(m.tiles[1].walls, (1, 1, 1, 1))
        self.assertEqual(m.cells, list(data[2 + 14:2 + 14 + 220]))
        self.assertEqual(m.content.count(2), 92)
        self.assertEqual(m.content.count(4), 2)
        self.assertEqual(sum(1 for c in m.content if c), 94)
        self.assertEqual([(e.cell, e.type, e.param) for e in m.events], [(29, 3, 0), (68, 1, 1)])
        self.assertEqual(m.outside, 1)
        self.assertEqual((m.tiles[42].flags, m.tiles[41].flags), (0, 0x17))

    def test_floor_ceiling(self):
        m, _ = crawlmap.convert(read_crawl(), floor=3, ceiling=4)
        self.assertEqual((m.tiles[0].floor, m.tiles[0].ceiling), (3, 4))
        self.assertEqual((m.tiles[1].floor, m.tiles[1].ceiling), (0, 0))

    def test_items(self):
        m, _ = crawlmap.convert(read_crawl(), items=(4,))
        self.assertEqual(sum(1 for c in m.content if c), 2)

    def test_toml_build_identical(self):
        m, _ = crawlmap.convert(read_crawl())
        direct = dbemap.to_dmp(m)
        with tempfile.TemporaryDirectory() as td:
            dmp, tml, dmp2 = (os.path.join(td, n) for n in ("a.dmp", "a.toml", "b.dmp"))
            self.assertEqual(crawlmap.main([CRAWL, dmp, "--toml", tml]), 0)
            self.assertEqual(dbemap.main(["build", tml, dmp2]), 0)
            with open(dmp, "rb") as a, open(dmp2, "rb") as b:
                self.assertEqual(a.read(), direct)
                self.assertEqual(b.read(), direct)

    def test_synthetic(self):
        data = synth(3, 2, [1, 0, 6, 8, 8, 42], [("6", 2), ("8", 3), ("8", 4), ("Z", 5), ("Q", 0)])
        m, warn = crawlmap.convert(data)
        self.assertEqual([(e.cell, e.type, e.param) for e in m.events],
                         [(0, 255, 81), (3, 2, 1), (4, 2, 1), (5, 3, 1)])
        self.assertEqual(len(warn), 1)
        self.assertIn("'Q'", warn[0])
        self.assertEqual(m.start, 2)
        self.assertEqual(len(m.tiles), 43)

    def test_duplicate_records(self):
        with self.assertRaisesRegex(ValueError, "'6'.*repeated"):
            crawlmap.convert(synth(2, 1, [0, 0], [("6", 0), ("6", 1)]))
        with self.assertRaisesRegex(ValueError, "two"):
            crawlmap.convert(synth(3, 1, [8, 8, 8], [("6", 0), ("8", 0), ("8", 1), ("8", 2)]))
        _, warn = crawlmap.convert(synth(2, 1, [0, 0], [("6", 0), ("X", 0), ("X", 1)]))
        self.assertEqual(len(warn), 1)
        self.assertIn("'X' repeated", warn[0])

    def test_missing_start(self):
        with self.assertRaisesRegex(ValueError, "'6'"):
            crawlmap.convert(synth(2, 1, [0, 0], [("8", 0)]))

    def test_record_out_of_range(self):
        with self.assertRaisesRegex(ValueError, "cell 2"):
            crawlmap.convert(synth(2, 1, [0, 0], [("6", 2)]))

    def test_gem_warning_and_name(self):
        _, warn = crawlmap.convert(synth(2, 1, [2, 0], [("6", 1)], name=b"\xff", gems=5))
        self.assertEqual(len(warn), 2)

    def test_cli_warning(self):
        with tempfile.TemporaryDirectory() as td:
            src, out = os.path.join(td, "s.cd1"), os.path.join(td, "s.dmp")
            with open(src, "wb") as f:
                f.write(synth(2, 1, [0, 0], [("6", 1), ("Q", 0)]))
            err = io.StringIO()
            with redirect_stderr(err):
                self.assertEqual(crawlmap.main([src, out]), 0)
            self.assertIn("Warning", err.getvalue())

    def test_legend_limit(self):
        data = synth(2, 1, [80, 6], [("6", 1)])
        m, _ = crawlmap.convert(data)
        with self.assertRaisesRegex(ValueError, "78"):
            crawlmap.legend_for(m)

    @unittest.skipUnless(shutil.which("c1541") and os.path.exists(D81), "c1541 or image missing")
    def test_d81(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "d.dmp")
            self.assertEqual(crawlmap.main(["--d81", D81, out]), 0)
            m, _ = crawlmap.convert(read_crawl())
            with open(out, "rb") as f:
                self.assertEqual(f.read(), dbemap.to_dmp(m))


if __name__ == "__main__":
    unittest.main()
