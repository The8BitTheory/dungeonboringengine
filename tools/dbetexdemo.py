#!/usr/bin/env python3
"""Generates deterministic example textures for dbetex.py (docs/specs/P5-textures.md, section 10.1).

From the geometry (default: dbegeom, Westwood 140 x 96, in memory) the following are produced:
  brick_atlas.png    wall, opaque (brick pattern)           grating_atlas.png   wall, non-opaque (grid)
  window.json/.png   Aseprite-style export (tags window, arch; slices only for full fronts)
  stone_atlas.png     floor (bands with gradient -> ROWS)    wood_atlas.png     ceiling (beam bands)
  sky.png          panorama for the wallpaper
  walls.toml floor.toml ceil.toml bg.toml, <geom>.geom.json (+ .dvg for the default geometry)

Usage: dbetexdemo.py OUTDIR [--geom GEOM.json]
"""
import argparse
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbegeom  # noqa: E402
import dbepersp  # noqa: E402
from PIL import Image  # noqa: E402

PAL = dbegeom.PALETTE


def default_geom(width=140, height=96):
    """(geom dict like geom.json, dvg bytes with load address) for Westwood width x height."""
    vp = {"preset": "westwood", "width_px": width, "height": height}
    if os.environ.get("DBE_BYTE_EDGES") == "1":         # measurement: demo with edges on whole bytes (test/vice_view.py --byte-edges)
        vp["byte_edges"] = True
    conf = dbegeom.parse_config({"viewport": vp})
    geo = dbegeom.Geometry(conf)
    geo.atlas_size = dbegeom.layout_atlas(geo)
    content, gid = dbegeom.build_dvg(geo)
    bud = dbegeom.compute_budget(geo)
    js = json.loads(json.dumps(dbegeom.build_json(geo, gid, bud)))
    return js, struct.pack("<H", conf["load"] & 0xFFFF) + content


def _boxes(geom, arts):
    """(name, d, rect, mask, atlas) of the images with an atlas slot."""
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
    """fn(px, r) -> palette index | None for each pixel of the mask; the rest stays transparent."""
    px_ = im.load()
    for r, line in enumerate(mask):
        for bx, ch in enumerate(line):
            for side in (0, 1):
                if ch == "#" or (ch == "L" and side == 0) or (ch == "R" and side == 1):
                    c = fn(2 * bx + side, r)
                    if c is not None:
                        px_[ox + 2 * bx + side, oy + r] = PAL[c] + (255,)


BRICK = dbepersp.brick_pattern()
JOINT = {14: 3}                                   # joints stay visible even below one pixel width


def _wall_fn(P, e, pattern=BRICK, bias=JOINT):
    return dbepersp.element_fn(P, e, pattern, bias=bias)


def _boxes_e(geom, arts):
    """Element or band dicts (with art, name, d, rect, mask, atlas) of the images with an atlas slot."""
    res = []
    for e in geom["elements"]:
        if e["art"] in arts and e.get("atlas"):
            res.append(e)
    for b in geom["band_images"]:
        if b["art"] in arts:
            w, h = b["rect"][2], b["rect"][3]
            res.append(dict(b, mask=["#" * w] * h))
    return res


def make_brick(geom, path):
    """Wall, opaque: bricks in wall space (fronts and sides, perspective, dbepersp)."""
    P = dbepersp.Persp(geom)
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    for e in _boxes_e(geom, ("front", "side")):
        ax, ay = e["atlas"]
        _paint(im, ax, ay, e["rect"], e["mask"], _wall_fn(P, e))
    im.save(path)


def make_grating(geom, path):
    """Wall, non-opaque: full fronts as grid, sides like bricks (perspective).
    Fronts lie frontally on one plane (no distortion): bars one byte wide at 1/6 cell spacing (rounded to bytes,
    keeps the VMS list short), crossbars ~ 2 rows at W_1 and scaled with W_d."""
    P = dbepersp.Persp(geom)
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    W1 = geom["planes"][1]["W"]
    for e in _boxes_e(geom, ("front", "side")):
        if e["art"] == "front":
            Wd, h = geom["planes"][e["d"]]["W"], e["rect"][3]
            per = max(2, round(Wd / 12))                       # bar spacing in bytes
            rail = max(1, round(2 * Wd / W1))

            def fn(px, r, h=h, per=per, rail=rail):
                if h // 4 <= r < h // 4 + rail or 3 * h // 4 <= r < 3 * h // 4 + rail:
                    return 15
                if (px // 2) % per == per // 2:
                    return 7
                return None
        else:
            fn = _wall_fn(P, e)
        _paint(im, e["atlas"][0], e["atlas"][1], e["rect"], e["mask"], fn)
    im.save(path)


def _front_window(w2, h, arch, base_fn):
    def fn(px, r):
        base = base_fn(px, r)
        if arch:
            cx, rad = w2 / 2, w2 * 0.18
            cy, bot = h * 0.4, h * 0.8
            x = px + 0.5 - cx
            hole = (abs(x) <= rad and cy <= r < bot) or (r < cy and x * x + ((r + 0.5 - cy) * 1.0) ** 2 <= rad * rad)
        else:
            p0, p1 = int(w2 * 0.35) | 1, int(w2 * 0.65) | 1
            hole = p0 <= px < p1 and h // 4 <= r < h * 6 // 10
        return None if hole else base
    return fn


def make_window(geom, jpath, ppath):
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
            pos[f[0]] = (4, row2)         # shifted slice
    SW = max(x, 4 + fronts[2][2][2] * 2 + 4)
    SH = row2 + fronts[2][2][3] + 4
    sheet = Image.new("RGBA", (2 * SW, SH), (0, 0, 0, 0))
    P = dbepersp.Persp(geom)
    emap = {e["name"]: e for e in geom["elements"]}
    for fi, arch in enumerate((False, True)):
        for name, d, rect, mask, _ in fronts:
            ax, ay = pos[name]
            base = _wall_fn(P, emap[name])
            _paint(sheet, fi * SW + ax, ay, rect, mask, _front_window(rect[2] * 2, rect[3], arch, base))
    sheet.save(ppath)
    js = {"frames": [{"filename": f"window {i}", "frame": {"x": i * SW, "y": 0, "w": SW, "h": SH},
                      "rotated": False, "trimmed": False,
                      "spriteSourceSize": {"x": 0, "y": 0, "w": SW, "h": SH}, "sourceSize": {"w": SW, "h": SH},
                      "duration": 100} for i in range(2)],
          "meta": {"app": "dbetexdemo", "version": "1", "image": os.path.basename(ppath), "format": "RGBA8888",
                   "size": {"w": 2 * SW, "h": SH}, "scale": "1",
                   "frameTags": [{"name": "window", "from": 0, "to": 0, "direction": "forward"},
                                 {"name": "arch", "from": 1, "to": 1, "direction": "forward"}],
                   "slices": [{"name": n, "color": "#0000ffff",
                               "keys": [{"frame": 0, "bounds": {"x": pos[n][0], "y": pos[n][1],
                                                                "w": r[2] * 2, "h": r[3]}}]}
                              for n, d, r, m, a in fronts]}}
    with open(jpath, "w", encoding="utf-8") as f:
        json.dump(js, f, indent=1)



def _stone(u, v, t=0.25, j=0.012):
    """Paving in floor space: squares of 1/4 cell, checkerboard 14/7, joint 1."""
    cu, cv = u / t, v / t
    fu, fv = cu - math.floor(cu), cv - math.floor(cv)
    if fu < j / t or fv < j / t:
        return 1
    return 14 if (math.floor(cu) + math.floor(cv)) % 2 == 0 else 7


def _wood(u, v, pw=1 / 6, pl=0.5, j=0.012):
    """Planks in ceiling space: lengthwise boards of 1/6 cell (colors 8/12 alternating), butt joint every 1/2 cell, offset per board."""
    cu = u / pw
    k = math.floor(cu)
    if cu - k < j / pw:
        return 6
    vv = v / pl + (0.5 if k % 2 else 0)
    if vv - math.floor(vv) < j / pl:
        return 6
    return 8 if (k + math.floor(vv)) % 2 == 0 else 12


def _flat_atlas(geom, path, arts, tile, bandfn):
    P = dbepersp.Persp(geom)
    im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
    for e in _boxes_e(geom, arts):
        if e["art"].endswith("band"):
            fn = bandfn(e, P)
        else:
            fn = dbepersp.element_fn(P, e, tile, bias={1: 3, 6: 3})
        _paint(im, e["atlas"][0], e["atlas"][1], e["rect"], e["mask"], fn)
    im.save(path)


def make_stone(geom, path):
    """Floor: tiles as paving in floor space; bands as single-color rows (gradient dark gray -> black, ROWS)."""
    def band(e, P):
        h = e["rect"][3]
        return lambda px, r: 1 if 2 * r < h else 0
    _flat_atlas(geom, path, ("floor", "floorband"), _stone, band)


def make_wood(geom, path):
    """Ceiling: tiles and bands as planks in ceiling space (bands without ROWS)."""
    def band(e, P):
        return dbepersp.element_fn(P, e, _wood, bias={6: 3})
    _flat_atlas(geom, path, ("ceil", "ceilband"), _wood, band)


def make_sky(geom, path):
    vw = geom["viewport"]["width_px"] // 2
    hy0, hy1 = geom["horizon"]
    P, h = 4 * vw, hy1 - hy0 + 6
    im = Image.new("RGBA", (2 * P, h), (0, 0, 0, 255))
    px = im.load()
    for x in range(2 * P):
        q = x // (P // 2)
        n = q + 1                                   # number of mountains in the quarter
        local = (x % (P // 2)) / (P // 2)
        phase = (local * n) % 1.0
        peak = 1 - abs(2 * phase - 1)               # peak 0 ... 1
        top = int(h * 0.7 - peak * h * 0.45)
        for y in range(h):
            px[x, y] = PAL[1 if y >= top else 3] + (255,)
    for q in range(4):                              # feature per quarter: sun in alternating color
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
load       = 0x8000
vrl_load   = 0x4000
pool_bytes = 26624

[[style]]
name = "brick"
png  = "brick_atlas.png"

[[style]]
name = "grating"
png  = "grating_atlas.png"

[[style]]
name     = "window"
aseprite = "window.json"
tag      = "window"

[[style]]
name     = "arch"
aseprite = "window.json"
tag      = "arch"
'''

FLOOR_TOML = '''format  = "dbetex"
version = 1

[texset]
name = "demo_floor"
kind = "floor"
geom = "{geom}"
out  = "build"
load = 0xEE00

[[style]]
name = "stone"
png  = "stone_atlas.png"
'''

CEIL_TOML = FLOOR_TOML.replace("demo_floor", "demo_ceil").replace('"floor"', '"ceiling"') \
    .replace("stone_atlas", "wood_atlas").replace('"stone"', '"wood"').replace("0xEE00", "0xF600")

BG_TOML = '''format  = "dbebg"
version = 1

[background]
name    = "demo_sky"
geom    = "{geom}"
png     = "sky.png"
y0      = "horizon"
offsets = "auto"
wrap    = true
above   = 3
below   = 1
out     = "build"
load    = 0xFB80
'''


def generate(outdir, geom_path=None):
    """Writes all example files to outdir; returns dict name -> path."""
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
    make_brick(geom, P("brick_atlas.png"))
    make_grating(geom, P("grating_atlas.png"))
    make_window(geom, P("window.json"), P("window.png"))
    make_stone(geom, P("stone_atlas.png"))
    make_wood(geom, P("wood_atlas.png"))
    make_sky(geom, P("sky.png"))
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
    ap = argparse.ArgumentParser(description="Generate example textures for dbetex")
    ap.add_argument("outdir")
    ap.add_argument("--geom")
    a = ap.parse_args(argv)
    generate(a.outdir, a.geom)
    print(f"Examples in {a.outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
