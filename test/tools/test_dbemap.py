"""Tests fuer tools/dbemap.py (unittest)."""
import os
import random
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import dbemap  # noqa: E402
from dbemap import Event, Map, Tile  # noqa: E402

DEMO = os.path.join(ROOT, "docs", "specs", "examples", "demo.toml")
CRAWL = os.path.join(HERE, "data", "crawl128.cd1")

BASE = '''
[map]
start = [1, 1]
dir = "N"
outside = "w"
[tiles.w]
walls = 1
flags = ["weg"]
[tiles.g]
floor = 1
[legend]
"#" = "w"
"." = "g"
[layers]
tiles = """
###
#.#
###
"""
'''


def load(text):
    return dbemap.loads_toml(text, "t.toml")


class TestBuild(unittest.TestCase):
    def test_demo(self):
        m = dbemap.load_toml(DEMO)
        d = dbemap.to_dmp(m)
        self.assertEqual(d[:2], b"\x00\x80")
        b = d[2:]
        self.assertEqual((m.width, m.height, len(m.tiles), len(m.events)), (7, 5, 4, 3))
        self.assertEqual(b[:5], b"DM\x01\x07\x05")
        self.assertEqual(b[5], 4)
        self.assertEqual(int.from_bytes(b[6:8], "little"), 3)
        self.assertEqual(m.start, 9)
        self.assertEqual(m.direction, 1)
        self.assertEqual([int.from_bytes(b[i:i + 2], "little") for i in (12, 14, 16, 18, 20)],
                         [24, 59, 94, 126, 138])
        self.assertEqual(len(b), 138)
        self.assertEqual(m.cells[1 * 7 + 3], 1)
        self.assertEqual(m.content[1 * 7 + 3], 2)
        self.assertEqual(m.content[1 * 7 + 1], 0x80)
        self.assertEqual(b[94:102], bytes.fromhex("01 01 01 01 00 00 17 00"))
        self.assertEqual(b[118:126], bytes.fromhex("02 02 02 02 01 01 01 23"))
        # Ereignisse sortiert: Gegner (3,1)=10, Teleport (1,3)=22, Ausgang (5,3)=26
        self.assertEqual([(e.cell, e.type, e.param) for e in m.events], [(10, 1, 1), (22, 2, 1), (26, 3, 0)])

    def test_load_address(self):
        d = dbemap.to_dmp(dbemap.load_toml(DEMO), 0x4000)
        self.assertEqual(d[:2], b"\x00\x40")

    def test_roundtrip_binary(self):
        m = dbemap.load_toml(DEMO)
        self.assertEqual(dbemap.from_dmp(dbemap.to_dmp(m)), m)

    def test_roundtrip_toml_demo_and_crawl(self):
        import crawlmap
        with open(CRAWL, "rb") as f:
            cm, _ = crawlmap.convert(f.read())
        for m in (dbemap.load_toml(DEMO), cm):
            d = dbemap.to_dmp(m)
            m2 = dbemap.from_dmp(d)
            d2 = dbemap.to_dmp(dbemap.loads_toml(dbemap.to_toml(m2), "x"))
            self.assertEqual(d, d2)

    def test_roundtrip_random(self):
        rnd = random.Random(12345)
        for _ in range(50):
            w, h = rnd.randint(1, 40), rnd.randint(1, 40)
            nt = rnd.randint(1, 12)
            tiles = []
            for i in range(nt):
                fl = 0 if i == 0 else rnd.randint(0, 63)
                tiles.append(Tile(tuple(rnd.randint(0, 255) for _ in range(4)), rnd.randint(0, 255),
                                  rnd.randint(0, 255), fl, rnd.randint(0, 255)))
            cells = [rnd.randrange(nt) for _ in range(w * h)]
            cells[0] = 0
            content = [rnd.choice([0, 0, 1, 2, 3, 4, 5]) for _ in range(w * h)]
            for i in range(w * h):
                if rnd.random() < 0.1:
                    content[i] |= rnd.choice([0x80, 0x40, 0xC0])
            events = [Event(rnd.randrange(w * h), rnd.randint(1, 255), rnd.randint(0, 255))
                      for _ in range(rnd.randint(0, 20))]
            m = Map("r", w, h, tiles, cells, content, events, 0, rnd.randint(0, 3), rnd.randrange(nt))
            d = dbemap.to_dmp(m)
            m2 = dbemap.from_dmp(d)
            self.assertEqual(m2.events, sorted(events, key=lambda e: (e.cell, e.type, e.param)))
            self.assertEqual(dbemap.to_dmp(dbemap.loads_toml(dbemap.to_toml(m2), "x")), d)

    def test_too_many_legend_pairs(self):
        nt = 20
        tiles = [Tile((0,) * 4, 0, 0, 0, 0) for _ in range(nt)]
        cells = [i % nt for i in range(nt * 5)]
        content = [i // nt for i in range(nt * 5)]
        m = Map("", nt * 5, 1, tiles, cells, content, [], 0, 0, 0)
        with self.assertRaisesRegex(ValueError, "zu viele Kombinationen"):
            dbemap.to_toml(m)

    def test_toml_escape(self):
        m = dbemap.load_toml(DEMO)
        m.name = 'a"b\\c'
        self.assertEqual(dbemap.loads_toml(dbemap.to_toml(m), "x").name, 'a"b\\c')

    def test_index_gaps(self):
        t = BASE.replace("[tiles.w]", "[tiles.w]\nindex = 3").replace("[tiles.g]", "[tiles.g]\nindex = 1")
        m = load(t)
        self.assertEqual(len(m.tiles), 4)
        self.assertEqual(m.tiles[0], dbemap.null_tile())
        self.assertEqual(m.cells, [3, 3, 3, 3, 1, 3, 3, 3, 3])
        self.assertEqual(m.outside, 3)

    def test_file_and_cli(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "o.dmp")
            self.assertEqual(dbemap.main(["build", DEMO, out]), 0)
            with open(out, "rb") as f:
                self.assertEqual(f.read(), dbemap.to_dmp(dbemap.load_toml(DEMO)))
            tml = os.path.join(td, "o.toml")
            self.assertEqual(dbemap.main(["dump", out, "--toml", tml]), 0)
            out2 = os.path.join(td, "o2.dmp")
            self.assertEqual(dbemap.main(["build", tml, out2]), 0)
            with open(out, "rb") as a, open(out2, "rb") as b:
                self.assertEqual(a.read(), b.read())
            self.assertEqual(dbemap.main(["check", DEMO]), 0)
            self.assertEqual(dbemap.main(["dump", out]), 0)
            bad = os.path.join(td, "bad.toml")
            with open(bad, "w") as f:
                f.write(BASE.replace("#.#", "#q#"))
            self.assertEqual(dbemap.main(["check", bad]), 1)


class TestErrors(unittest.TestCase):
    def fails(self, text, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            load(text)

    def test_ok_base(self):
        self.assertEqual(load(BASE).width, 3)

    def test_unknown_char(self):
        self.fails(BASE.replace("#.#", "#q#"), r"t\.toml: Karte Zeile 2, Spalte 2: Zeichen 'q' nicht in der Legende")

    def test_row_length(self):
        self.fails(BASE.replace("#.#", "#.##"), "Zeile 2: Laenge 4 statt 3")

    def test_start_on_weg(self):
        self.fails(BASE.replace("[1, 1]", "[0, 0]"), "WEG")

    def test_item_64(self):
        self.fails(BASE.replace('"." = "g"', '"." = { tile = "g", item = 64 }'), "item")

    def test_style_256(self):
        self.fails(BASE.replace("floor = 1", "floor = 256"), "floor")

    def test_unknown_flag(self):
        self.fails(BASE.replace('["weg"]', '["weg", "foo"]'), "unbekanntes Flag 'foo'")

    def test_flag_inhalt(self):
        m = load(BASE.replace('["weg"]', '["weg", "inhalt"]'))
        self.assertEqual(m.tiles[0].flags, 1 | 32)
        self.assertEqual(dbemap.FLAGS["inhalt"], 32)
        self.assertEqual(dbemap.warnings_for(m), [])
        d = dbemap.to_dmp(m)
        m2 = dbemap.from_dmp(d)
        self.assertEqual(m2.tiles[0].flags, 33)
        self.assertEqual(dbemap.to_dmp(dbemap.loads_toml(dbemap.to_toml(m2), "x")), d)
        self.assertIn('"inhalt"', dbemap.to_toml(m2))
        self.assertIn("inhalt", dbemap.describe(m2))

    def test_flag_inhalt_without_faces_warns(self):
        m = load(BASE.replace("floor = 1", 'floor = 1\nflags = ["inhalt"]'))
        self.assertTrue(any("inhalt" in w for w in dbemap.warnings_for(m)))

    def test_reserved_flag_bits(self):
        m = load(BASE)
        m.tiles[0].flags = 64
        with self.assertRaisesRegex(ValueError, "Flags"):
            dbemap.validate(m)
        m.tiles[0].flags = 1
        d = bytearray(dbemap.to_dmp(m))
        d[2 + 24 + 2 * 9 + 6] = 0x40          # Flags der Kachel 0 (nach Kachel- und Inhaltsebene)
        with self.assertRaisesRegex(ValueError, "Flag-Bits"):
            dbemap.from_dmp(bytes(d))

    def test_unknown_event_type(self):
        self.fails(BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ type = "xyz" }] }'),
                   "unbekannter Ereignistyp 'xyz'")

    def test_width_256(self):
        row = "#" * 256
        self.fails(BASE.replace("###\n#.#\n###", row), "Breite/Hoehe")

    def test_too_large(self):
        rows = "\n".join(["#" * 200] * 100)
        self.fails(BASE.replace("###\n#.#\n###", rows), "16384")

    def test_trailing_space(self):
        self.fails(BASE.replace("#.#\n", "#.# \n"), "Zeile 2, Spalte 4: Leerzeichen am Zeilenende")

    def test_index_partial(self):
        self.fails(BASE.replace("[tiles.w]", "[tiles.w]\nindex = 0"), "index")

    def test_unknown_key(self):
        self.fails(BASE.replace("floor = 1", "flor = 1"), "flor")
        self.fails(BASE.replace('dir = "N"', 'dir = "N"\nstrat = [1, 1]'), "map: unbekannter Schluessel 'strat'")
        self.fails("titel = 1\n" + BASE, "unbekannter Schluessel 'titel'")
        self.fails(BASE + "walls = 1\n", "layers: unbekannter Schluessel 'walls'")


class TestFaceSubpos(unittest.TestCase):
    def test_face(self):
        # Blick N: Front S(2), links O(1), rechts W(3); Rest durch Drehung
        for v in range(4):
            self.assertEqual(dbemap.face(v, 0, True), (v + 2) % 4)
            self.assertEqual(dbemap.face(v, -1, False), (v + 1) % 4)
            self.assertEqual(dbemap.face(v, 1, False), (v + 3) % 4)
        self.assertEqual(dbemap.face(0, 0, True), 2)
        self.assertEqual(dbemap.face(0, -2, False), 1)
        self.assertEqual(dbemap.face(2, 3, False), 1)

    def test_subpos_permutation(self):
        for row in dbemap.SUBPOS_VIEW:
            self.assertEqual(sorted(row), [0, 1, 2, 3, 4])
            self.assertEqual(row[4], 2)

    def test_subpos_rotation(self):
        # Weltsicht: NW=(0,0), NO=(1,0), SW=(0,1), SO=(1,1); Kamera dreht um 90 Grad nach rechts.
        # Position p: 0 hinten links, 1 hinten rechts, 3 vorne links, 4 vorne rechts.
        # Blick v: Welt-Ecke -> (hinten?, links?) ueber Vektoren.
        corners = {0: (-1, -1), 1: (1, -1), 2: (-1, 1), 3: (1, 1)}   # x, y (y nach Sueden)
        fwd = [(0, -1), (1, 0), (0, 1), (-1, 0)]
        right = [(1, 0), (0, 1), (-1, 0), (0, -1)]
        for v in range(4):
            for q, (cx, cy) in corners.items():
                f = cx * fwd[v][0] + cy * fwd[v][1]
                r = cx * right[v][0] + cy * right[v][1]
                back = f > 0
                left = r < 0
                p = (0 if left else 1) if back else (3 if left else 4)
                self.assertEqual(dbemap.SUBPOS_VIEW[v][q], p, (v, q))


class TestFromDmp(unittest.TestCase):
    def setUp(self):
        self.d = bytearray(dbemap.to_dmp(dbemap.load_toml(DEMO)))

    def bad(self, d, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            dbemap.from_dmp(bytes(d))

    def test_magic(self):
        self.d[2] = ord("X")
        self.bad(self.d, "Magic")

    def test_version(self):
        self.d[4] = 2
        self.bad(self.d, "Version")

    def test_short(self):
        self.bad(self.d[:-1], "zu kurz")

    def test_tile_index(self):
        self.d[2 + 24] = 4
        self.bad(self.d, "Kachelindex")

    def test_start(self):
        self.d[2 + 8] = 35
        self.bad(self.d, "Startzelle")


if __name__ == "__main__":
    unittest.main()
