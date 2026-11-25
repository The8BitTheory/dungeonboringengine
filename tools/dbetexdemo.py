#!/usr/bin/env python3
"""Erzeugt deterministische Beispiel-Texturen fuer dbetex.py (docs/specs/P5-textures.md, Abschnitt 10.1).

Aus der Geometrie (Standard: dbegeom, Westwood 140 x 96, im Speicher) entstehen:
  ziegel_atlas.png    Wand, deckend (Ziegelmuster)           gitter_atlas.png   Wand, nicht deckend (Gitter)
  fenster.json/.png   Aseprite-artiger Export (Tags fenster, bogen; Slices nur fuer Vollfronten)
  stein_atlas.png     Boden (Baender mit Verlauf -> ZEILEN)  holz_atlas.png     Decke (Balkenbaender)
  himmel.png          Panorama fuer die Tapete
  walls.toml floor.toml ceil.toml bg.toml, <geom>.geom.json (+ .dvg bei Standardgeometrie)

Aufruf: dbetexdemo.py OUTDIR [--geom GEOM.json]
"""
import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbegeom  # noqa: E402
from PIL import Image  # noqa: E402

PAL = dbegeom.PALETTE


def default_geom(width=140, height=96):
    """(geom-dict wie geom.json, dvg-Bytes mit Ladeadresse) fuer Westwood width x height."""
    conf = dbegeom.parse_config({"viewport": {"preset": "westwood", "width_px": width, "height": height}})
    geo = dbegeom.Geometry(conf)
    geo.atlas_size = dbegeom.layout_atlas(geo)
    content, gid = dbegeom.build_dvg(geo)
    bud = dbegeom.compute_budget(geo)
    js = json.loads(json.dumps(dbegeom.build_json(geo, gid, bud)))
    return js, struct.pack("<H", conf["load"] & 0xFFFF) + content


def _boxes(geom, arts):
    """(name, d, rect, mask, atlas) der Bilder mit Atlasplatz."""
    res = []
    for e in geom["elements"]:
        if e["art"] in arts and e.get("atlas"):
            res.append((e["name"], e["d"], e["rect"], e["mask"], e["atlas"]))
    for b in geom["band_images"]:
        if b["art"] in arts:
            w, h = b["rect"][2], b["rect"][3]
            res.append((b["name"], b["d"], b["rect"], ["#" * w] * h, b["atlas"]))
    return res


def _paint(im, ox, oy, rect, mask, fn):
    """fn(px, r) -> Palettenindex | None fuer jedes Pixel der Maske; Rest bleibt transparent."""
    px_ = im.load()
    for r, line in enumerate(mask):
        for bx, ch in enumerate(line):
            for side in (0, 1):
                if ch == "#" or (ch == "L" and side == 0) or (ch == "R" and side == 1):
                    c = fn(2 * bx + side, r)
                    if c is not None:
                        px_[ox + 2 * bx + side, oy + r] = PAL[c] + (255,)


def _bh(geom, d):
    W = [p["W"] for p in geom["planes"]]
    return max(2, round(6 * W[d] / W[1]))


def brick(bh):
    def fn(px, r):
        row, rr = divmod(r, bh)
        bw = 4 * bh
        off = (row % 2) * (bw // 2)
        cc = (px + off) % bw
        if rr == 0 or cc == 0:
            return 14
        return 12 if ((px + off) // bw + row) % 2 == 0 else 8
    return fn


def make_ziegel(geom, path):
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    for name, d, rect, mask, (ax, ay) in _boxes(geom, ("front", "side")):
        _paint(im, ax, ay, rect, mask, brick(_bh(geom, d)))
    im.save(path)


def make_gitter(geom, path):
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    for name, d, rect, mask, (ax, ay) in _boxes(geom, ("front", "side")):
        if name.startswith("front"):
            h = rect[3]

            def fn(px, r, h=h):
                if h // 4 <= r < h // 4 + 2 or 3 * h // 4 <= r < 3 * h // 4 + 2:
                    return 15
                if (px // 2) % 8 == 3:
                    return 7
                return None
        else:
            fn = brick(_bh(geom, d))
        _paint(im, ax, ay, rect, mask, fn)
    im.save(path)


def _front_fenster(w2, h, bogen):
    def fn(px, r):
        base = brick(max(2, h // 12))(px, r)
        if bogen:
            cx, rad = w2 / 2, w2 * 0.18
            cy, bot = h * 0.4, h * 0.8
            x = px + 0.5 - cx
            hole = (abs(x) <= rad and cy <= r < bot) or (r < cy and x * x + ((r + 0.5 - cy) * 1.0) ** 2 <= rad * rad)
        else:
            p0, p1 = int(w2 * 0.35) | 1, int(w2 * 0.65) | 1
            hole = p0 <= px < p1 and h // 4 <= r < h * 6 // 10
        return None if hole else base
    return fn


def make_fenster(geom, jpath, ppath):
    fronts = [b for b in _boxes(geom, ("front",)) if b[0].endswith("_s+0")]
    pos = {}
    x = 4
    row2 = 4 + max(f[2][3] for f in fronts[:2]) + 4
    for i, f in enumerate(fronts):
        w2, h = f[2][2] * 2, f[2][3]
        if i < 2:
            pos[f[0]] = (x, 4)
            x += w2 + 4
        else:
            pos[f[0]] = (4, row2)         # verschobene Slice
    SW = max(x, 4 + fronts[2][2][2] * 2 + 4)
    SH = row2 + fronts[2][2][3] + 4
    sheet = Image.new("RGBA", (2 * SW, SH), (0, 0, 0, 0))
    for fi, bogen in enumerate((False, True)):
        for name, d, rect, mask, _ in fronts:
            ax, ay = pos[name]
            _paint(sheet, fi * SW + ax, ay, rect, mask, _front_fenster(rect[2] * 2, rect[3], bogen))
    sheet.save(ppath)
    js = {"frames": [{"filename": f"fenster {i}", "frame": {"x": i * SW, "y": 0, "w": SW, "h": SH},
                      "rotated": False, "trimmed": False,
                      "spriteSourceSize": {"x": 0, "y": 0, "w": SW, "h": SH}, "sourceSize": {"w": SW, "h": SH},
                      "duration": 100} for i in range(2)],
          "meta": {"app": "dbetexdemo", "version": "1", "image": os.path.basename(ppath), "format": "RGBA8888",
                   "size": {"w": 2 * SW, "h": SH}, "scale": "1",
                   "frameTags": [{"name": "fenster", "from": 0, "to": 0, "direction": "forward"},
                                 {"name": "bogen", "from": 1, "to": 1, "direction": "forward"}],
                   "slices": [{"name": n, "color": "#0000ffff",
                               "keys": [{"frame": 0, "bounds": {"x": pos[n][0], "y": pos[n][1],
                                                                "w": r[2] * 2, "h": r[3]}}]}
                              for n, d, r, m, a in fronts]}}
    with open(jpath, "w", encoding="utf-8") as f:
        json.dump(js, f, indent=1)


def make_stein(geom, path):
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    for name, d, rect, mask, (ax, ay) in _boxes(geom, ("floor", "floorband")):
        if name.startswith("floorband"):
            h = rect[3]
            fn = lambda px, r, h=h: 1 if 2 * r < h else 0     # Verlauf dunkelgrau -> schwarz, je Zeile einfarbig
        else:
            cb = max(2, round(8 * geom["planes"][d]["W"] / geom["planes"][1]["W"]))
            hb = max(1, cb // 2)

            def fn(px, r, cb=cb, hb=hb):
                if px % cb == 0 or r % hb == 0:
                    return 1
                return 14 if (px // cb + r // hb) % 2 == 0 else 7
        _paint(im, ax, ay, rect, mask, fn)
    im.save(path)


def make_holz(geom, path):
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    for name, d, rect, mask, (ax, ay) in _boxes(geom, ("ceil", "ceilband")):
        if name.startswith("ceilband"):
            fn = lambda px, r: 8 if (px // 8) % 2 == 0 else 12
        else:
            fn = lambda px, r: 6 if r % 3 == 0 else (8 if (px // 16 + r // 3) % 2 == 0 else 12)
        _paint(im, ax, ay, rect, mask, fn)
    im.save(path)


def make_himmel(geom, path):
    vw = geom["viewport"]["width_px"] // 2
    hy0, hy1 = geom["horizon"]
    P, h = 4 * vw, hy1 - hy0 + 6
    im = Image.new("RGBA", (2 * P, h), (0, 0, 0, 255))
    px = im.load()
    for x in range(2 * P):
        q = x // (P // 2)
        n = q + 1                                   # Anzahl Berge im Viertel
        local = (x % (P // 2)) / (P // 2)
        phase = (local * n) % 1.0
        peak = 1 - abs(2 * phase - 1)               # Zacke 0 ... 1
        top = int(h * 0.7 - peak * h * 0.45)
        for y in range(h):
            px[x, y] = PAL[1 if y >= top else 3] + (255,)
    for q in range(4):                              # Merkmal je Viertel: Sonne in wechselnder Farbe
        x0 = q * P // 2 * 1 + 8
        for yy in range(2, 5):
            for xx in range(x0, x0 + 6):
                px[xx, yy] = PAL[(10, 7, 9, 13)[q]] + (255,)
    im.save(path)


WALLS_TOML = '''format  = "dbetex"
version = 1

[texset]
name       = "demo_walls"
kind       = "wall"
geom       = "{geom}"
dvg        = "{dvg}"
out        = "build"
load       = 0xA000
vrl_load   = 0x4000
pool_bytes = 26624

[[style]]
name = "ziegel"
png  = "ziegel_atlas.png"

[[style]]
name = "gitter"
png  = "gitter_atlas.png"

[[style]]
name     = "fenster"
aseprite = "fenster.json"
tag      = "fenster"

[[style]]
name     = "bogen"
aseprite = "fenster.json"
tag      = "bogen"
'''

FLOOR_TOML = '''format  = "dbetex"
version = 1

[texset]
name = "demo_floor"
kind = "floor"
geom = "{geom}"
out  = "build"
load = 0xA400

[[style]]
name = "stein"
png  = "stein_atlas.png"
'''

CEIL_TOML = FLOOR_TOML.replace("demo_floor", "demo_ceil").replace('"floor"', '"ceiling"') \
    .replace("stein_atlas", "holz_atlas").replace('"stein"', '"holz"').replace("0xA400", "0xA600")

BG_TOML = '''format  = "dbebg"
version = 1

[background]
name    = "demo_sky"
geom    = "{geom}"
png     = "himmel.png"
y0      = "horizon"
offsets = "auto"
wrap    = true
above   = 3
below   = 1
out     = "build"
load    = 0xA900
'''


def generate(outdir, geom_path=None):
    """Schreibt alle Beispieldateien nach outdir; liefert Dict Name -> Pfad."""
    os.makedirs(outdir, exist_ok=True)
    P = lambda n: os.path.join(outdir, n)
    out = {}
    if geom_path:
        with open(geom_path, encoding="utf-8") as f:
            geom = json.load(f)
        gref = os.path.relpath(geom_path, outdir)
        dref = ""
    else:
        geom, dvg = default_geom()
        with open(P("west140.geom.json"), "w", encoding="utf-8") as f:
            json.dump(geom, f, separators=(",", ":"))
        with open(P("west140.dvg"), "wb") as f:
            f.write(dvg)
        gref, dref = "west140.geom.json", "west140.dvg"
    make_ziegel(geom, P("ziegel_atlas.png"))
    make_gitter(geom, P("gitter_atlas.png"))
    make_fenster(geom, P("fenster.json"), P("fenster.png"))
    make_stein(geom, P("stein_atlas.png"))
    make_holz(geom, P("holz_atlas.png"))
    make_himmel(geom, P("himmel.png"))
    wt = WALLS_TOML.format(geom=gref, dvg=dref)
    if not dref:
        wt = "\n".join(l for l in wt.split("\n") if not l.startswith("dvg"))
    for name, txt in (("walls.toml", wt), ("floor.toml", FLOOR_TOML.format(geom=gref)),
                      ("ceil.toml", CEIL_TOML.format(geom=gref)), ("bg.toml", BG_TOML.format(geom=gref))):
        with open(P(name), "w", encoding="utf-8") as f:
            f.write(txt)
        out[name] = P(name)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Beispiel-Texturen fuer dbetex erzeugen")
    ap.add_argument("outdir")
    ap.add_argument("--geom")
    a = ap.parse_args(argv)
    generate(a.outdir, a.geom)
    print(f"Beispiele in {a.outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
