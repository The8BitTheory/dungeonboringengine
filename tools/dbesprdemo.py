#!/usr/bin/env python3
"""Example assets for dbespr (P5b, section 9.1): deterministic, no randomness.

Generates in OUTDIR:
  blob.json + blob.png   Aseprite-like export (--split-layers names): layers v0_d1 ... v3_d3, 2 frames,
                         tags idle (0-0) and walk (0-1, pingpong, 150 ms); slices with pivot for d = 1,
                         without pivot for d = 3, no slice for d = 2; v0_d3 empty in frame 1; layer ref is ignored
  blob_m.json            like blob.json without view angle 3 (for blob_m.toml: mirror = {3 = 1})
  gem.png + gem.toml     PNG with image list, NA = 1, NP = 2 (sparkle), depths 1-3
  blob.toml, blob_m.toml project files;  <geom>.geom.json (+ .dvg for the default geometry)
Usage: dbesprdemo.py OUTDIR [--geom GEOM.json]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbetexdemo  # noqa: E402
from PIL import Image  # noqa: E402

PAL = dbetexdemo.PAL
CW, CH = 48, 64             # canvas in pixels (Aseprite)
SIZES = {1: (31, 54), 2: (19, 34), 3: (11, 21)}     # figure per depth (pixels)
BODY = {0: PAL[5], 1: PAL[13], 2: PAL[10], 3: PAL[13]}
OUTLINE = PAL[0]
DURATION = 150


def _inside(x, y, w, h, bob):
    """Body (ellipse) plus head (smaller ellipse) of a figure of size w x h."""
    y -= bob
    if y < 0:
        return False
    cx = (w - 1) / 2
    body = ((x - cx) / (w / 2)) ** 2 + ((y - 0.64 * h) / (0.36 * h)) ** 2 <= 1
    head = ((x - cx) / (0.28 * w)) ** 2 + ((y - 0.2 * h) / (0.2 * h)) ** 2 <= 1
    return body or head


def figure(ai, d, frame):
    """RGBA canvas CW x CH of view ai at depth d, phase frame; None = empty cell."""
    if (ai, d, frame) == (0, 3, 1):
        return Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    w, h = SIZES[d]
    bob = 0 if frame == 0 else -1
    im = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    px = im.load()
    ox = (CW - w) // 2 + (1 if d == 1 else 0)
    oy = CH - 2 - h + (bob if frame else 0)
    ins = {(x, y) for y in range(h + 1) for x in range(w) if _inside(x, y, w, h, 0) and y < h}
    for (x, y) in ins:
        edge = any((x + dx, y + dy) not in ins for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
        col = OUTLINE if edge else BODY[ai]
        if not edge and ai == 2 and (y // 3) % 2:
            col = PAL[11]
        px[ox + x, oy + y] = col + (255,)
    ey = int(0.2 * h)
    if True:
        holes = []
        if ai == 0:
            holes = [(w // 2 - max(2, w // 6), ey), (w // 2 + max(1, w // 6), ey)]
        elif ai == 1:
            holes = [(w // 2 + max(2, w // 6), ey)]
        elif ai == 3:
            holes = [(w // 2 - max(2, w // 6), ey)]
        for (hx, hy) in holes:
            for dy in range(1 if frame else 2):
                for dx in range(2 if d == 1 else 1):
                    if (hx + dx, hy + dy) in ins:
                        px[ox + hx + dx, oy + hy + dy] = (0, 0, 0, 0)
    return im


def _bbox(im):
    return im.getchannel("A").point(lambda v: 255 if v else 0).getbbox()


def make_blob(outdir):
    layers = [f"v{ai}_d{d}" for ai in range(4) for d in (1, 2, 3)] + ["ref"]
    cols = 6
    cells = []
    slices = {}
    for ln in layers:
        for f in range(2):
            if ln == "ref":
                im = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
                for i in range(0, CW, 8):
                    im.putpixel((i, CH - 1), PAL[1] + (255,))
            else:
                ai, d = int(ln[1]), int(ln[4])
                im = figure(ai, d, f)
                bb = _bbox(im)
                if bb and d != 2:
                    x0, y0, x1, y1 = bb
                    w, h = x1 - x0, y1 - y0
                    key = {"frame": f, "bounds": {"x": x0, "y": y0, "w": w, "h": h}}
                    if d == 1:
                        key["pivot"] = {"x": w // 2 - 1, "y": h - 2}
                    slices.setdefault(ln, []).append(key)
            cells.append((ln, f, im))
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * CW, rows * CH), (0, 0, 0, 0))
    frames = []
    for i, (ln, f, im) in enumerate(cells):
        x, y = (i % cols) * CW, (i // cols) * CH
        sheet.paste(im, (x, y))
        frames.append({"filename": f"{ln}#{f}", "frame": {"x": x, "y": y, "w": CW, "h": CH}, "rotated": False,
                       "trimmed": False, "spriteSourceSize": {"x": 0, "y": 0, "w": CW, "h": CH},
                       "sourceSize": {"w": CW, "h": CH}, "duration": DURATION})
    sheet.save(os.path.join(outdir, "blob.png"))
    meta = {"app": "dbesprdemo", "version": "1", "image": "blob.png", "format": "RGBA8888",
            "size": {"w": sheet.width, "h": sheet.height}, "scale": "1",
            "frameTags": [{"name": "idle", "from": 0, "to": 0, "direction": "forward"},
                          {"name": "walk", "from": 0, "to": 1, "direction": "pingpong"}],
            "layers": [{"name": n} for n in layers],
            "slices": [{"name": n, "color": "#0000ffff", "keys": k} for n, k in slices.items()]}
    js = {"frames": frames, "meta": meta}
    with open(os.path.join(outdir, "blob.json"), "w", encoding="utf-8") as fh:
        json.dump(js, fh, indent=1)
    # variant without view angle 3
    fm = [e for e in frames if not e["filename"].startswith("v3_")]
    mm = dict(meta, slices=[s for s in meta["slices"] if not s["name"].startswith("v3_")],
              layers=[l for l in meta["layers"] if not l["name"].startswith("v3_")])
    with open(os.path.join(outdir, "blob_m.json"), "w", encoding="utf-8") as fh:
        json.dump({"frames": fm, "meta": mm}, fh, indent=1)


GEM_BOXES = []      # (phase, depth, box, foot)


def make_gem(outdir):
    im = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    px = im.load()
    spec = {1: (12, 10), 2: (8, 7), 3: (5, 5)}
    x = 1
    entries = []
    for phase in range(2):
        x = 1 + phase * 30
        for d in (1, 2, 3):
            w, h = spec[d]
            for yy in range(h):
                for xx in range(w):
                    cx, cy = (w - 1) / 2, (h - 1) / 2
                    if abs(xx - cx) / (w / 2) + abs(yy - cy) / (h / 2) <= 1:
                        edge = abs(xx - cx) / (w / 2) + abs(yy - cy) / (h / 2) > 0.7
                        px[x + xx, 1 + yy] = (PAL[3] if edge else PAL[14]) + (255,)
            if phase == 1:
                px[x + 1, 1 + 1] = PAL[15] + (255,)
                px[x + w // 2, 1 + h // 2] = PAL[15] + (255,)
            entries.append((phase, d, [x, 1, w, h]))
            x += w + 2
    im.save(os.path.join(outdir, "gem.png"))
    return entries


BLOB_TOML = '''format  = "dbespr"
version = 1

[sprite]
name      = "{name}"
geom      = "{geom}"
{dvg}out       = "build"
load      = 0x6000
vrl_load  = 0x4000
angles    = 4
phases    = 2
max_cores = 4
core_min  = 16
{extra}
[source]
aseprite = "{src}"
'''

GEM_TOML = '''format  = "dbespr"
version = 1

[sprite]
name      = "gem"
geom      = "{geom}"
{dvg}out       = "build"
angles    = 1
phases    = 2
max_cores = 2
core_min  = 8

[source]
png = "gem.png"
'''


def generate(outdir, geom_path=None):
    os.makedirs(outdir, exist_ok=True)
    P = lambda n: os.path.join(outdir, n)
    if geom_path:
        gref, dvg = os.path.relpath(geom_path, outdir), ""
    else:
        geom, dv = dbetexdemo.default_geom()
        with open(P("west140.geom.json"), "w", encoding="utf-8") as f:
            json.dump(geom, f, separators=(",", ":"))
        with open(P("west140.dvg"), "wb") as f:
            f.write(dv)
        gref, dvg = "west140.geom.json", 'dvg       = "west140.dvg"\n'
    make_blob(outdir)
    entries = make_gem(outdir)
    gem = GEM_TOML.format(geom=gref, dvg=dvg)
    for i, (phase, d, box) in enumerate(entries):
        foot = "foot  = [%d, %d]\n" % (box[2] // 2, box[3] - 1) if d != 2 else ""
        gem += f"\n[[image]]\nbox   = {box}\n{foot}phase = {phase}\nangle = 0\ndepth = {d}\n"
    out = {}
    for name, txt in (("gem.toml", gem),
                      ("blob.toml", BLOB_TOML.format(name="blob", geom=gref, dvg=dvg, extra="", src="blob.json")),
                      ("blob_m.toml", BLOB_TOML.format(name="blob_m", geom=gref, dvg=dvg, extra="mirror    = { 3 = 1 }\n",
                                                       src="blob_m.json"))):
        with open(P(name), "w", encoding="utf-8") as f:
            f.write(txt)
        out[name] = P(name)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate example assets for dbespr")
    ap.add_argument("outdir")
    ap.add_argument("--geom")
    a = ap.parse_args(argv)
    generate(a.outdir, a.geom)
    print(f"Examples in {a.outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
