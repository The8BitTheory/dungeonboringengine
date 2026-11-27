#!/usr/bin/env python3
"""Golden file for the parity test of tools/js/core/geom.js (docs/specs/P8-js-tools.md, section 4).

Runs tools/dbegeom.py on the example configurations (docs/specs/examples/view-west140.toml, view-west136.toml,
demo/view.toml) and on a set of variants (presets, widths, heights, origins, strides, byte_edges, custom planes,
random custom planes, error cases) and writes geom.json:
  cases[]   {label, toml (path) | cfg (object for parse_config), patch (conf overrides), name,
             error (GeomError text) | exception (other Python error) | gid, elements, check_sha, files {name: sha256}, pngs {name: [w, h, sha256 RGBA]},
             tpl [count, sha256 over 'name NUL w NUL h NUL sha LF' of the tpl/*.png, sorted]}
PNG files are compared by decoded RGBA pixels (Pillow), all other outputs by bytes.

usage: tools/js/test/golden/mkgolden_geom.py
"""
import copy, hashlib, json, os, random, sys, tempfile, tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import dbegeom  # noqa: E402
from PIL import Image  # noqa: E402

CUSTOM = {"viewport": {"preset": "custom", "width_px": 120, "height": 80, "depth": 2},
          "planes": {"ref_size": [176, 120], "center_x": 88, "width": [200, 110, 60, 30],
                     "top": [-10, 10, 25, 35], "bottom": [140, 100, 70, 55]}}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def ww(w, h, **kw):
    vp = {"preset": "westwood", "width_px": w, "height": h}
    out = {}
    for k, v in kw.items():
        (out if k in ("name", "load", "pool_bytes", "zoom", "dir") else vp)[k] = v
    cfg = {"viewport": vp}
    if out:
        cfg["output"] = out
    return cfg


def custom(**planes):
    c = copy.deepcopy(CUSTOM)
    c["planes"].update(planes)
    return c


def custom_vp(**vp):
    c = copy.deepcopy(CUSTOM)
    c["viewport"].update(vp)
    return c


def cases():
    yield {"label": "example west140", "toml": "docs/specs/examples/view-west140.toml"}
    yield {"label": "example west136", "toml": "docs/specs/examples/view-west136.toml"}
    yield {"label": "demo view", "toml": "demo/view.toml"}
    # presets, sizes, origins, strides, byte_edges
    for w, h in ((16, 8), (16, 100), (20, 12), (32, 20), (40, 30), (48, 40), (64, 48), (80, 50), (100, 64),
                 (120, 80), (128, 88), (136, 92), (140, 96), (144, 96), (148, 98), (152, 100), (156, 60),
                 (160, 100), (160, 8), (100, 100), (60, 99)):
        yield {"label": f"westwood {w}x{h}", "cfg": ww(w, h)}
        yield {"label": f"westwood {w}x{h} byte_edges", "cfg": ww(w, h, byte_edges=True)}
    yield {"label": "origin 321", "cfg": ww(140, 96, origin=321)}
    yield {"label": "origin 5 stride 80", "cfg": ww(140, 96, origin=5, stride=80)}
    yield {"label": "stride 70", "cfg": ww(140, 96, stride=70)}
    yield {"label": "stride 255", "cfg": ww(104, 60, stride=255, origin=1000)}
    yield {"label": "zoom 1", "cfg": ww(140, 96, zoom=1)}
    yield {"label": "zoom 2", "cfg": ww(136, 92, zoom=2, byte_edges=True)}
    yield {"label": "zoom 0", "cfg": ww(64, 40, zoom=0)}
    yield {"label": "pool small", "cfg": ww(140, 96, pool_bytes=1000)}
    yield {"label": "pool large", "cfg": ww(140, 96, pool_bytes=36735, name="poolname")}
    yield {"label": "load 0x4000", "cfg": ww(140, 96, load=0x4000)}
    yield {"label": "name non-ascii", "cfg": ww(140, 96, name="geomä")}
    yield {"label": "176x120 (patched conf)", "cfg": ww(160, 100), "patch": {"width": 176, "height": 120}}
    # custom planes
    yield {"label": "custom", "cfg": custom()}
    yield {"label": "custom byte_edges", "cfg": custom_vp(byte_edges=True)}
    yield {"label": "custom center_x float", "cfg": custom(center_x=88.0)}
    yield {"label": "custom no center_x", "cfg": (lambda c: (c["planes"].pop("center_x"), c)[1])(custom())}
    yield {"label": "custom 3 planes", "cfg": {"viewport": {"preset": "custom", "width_px": 96, "height": 64},
                                               "planes": {"ref_size": [96, 64], "width": [140, 64, 20],
                                                          "top": [-20, 12, 28], "bottom": [84, 52, 36]}}}
    yield {"label": "custom 6 planes", "cfg": {"viewport": {"preset": "custom", "width_px": 152, "height": 100, "depth": 4},
                                               "planes": {"ref_size": [176, 120], "width": [240, 150, 96, 64, 40, 24],
                                                          "top": [-30, 5, 15, 25, 32, 37],
                                                          "bottom": [160, 110, 88, 72, 62, 56]}}}
    yield {"label": "custom 7 planes byte_edges", "cfg": {
        "viewport": {"preset": "custom", "width_px": 160, "height": 100, "byte_edges": True},
        "planes": {"ref_size": [160, 100], "width": [300, 160, 100, 72, 52, 36, 24],
                   "top": [-40, 0, 12, 22, 30, 36, 40], "bottom": [150, 100, 84, 74, 66, 60, 56]}}}
    yield {"label": "custom ref 88x60", "cfg": {"viewport": {"preset": "custom", "width_px": 120, "height": 80},
                                                "planes": {"ref_size": [88, 60], "width": [100, 56, 30, 16],
                                                           "top": [-6, 6, 14, 20], "bottom": [70, 52, 38, 32]}}}
    # random custom planes (many end in validation or geometry errors, which are compared as well)
    rng = random.Random(4711)
    for i in range(40):
        n = rng.randint(3, 6)
        w = rng.choice(range(16, 164, 4))
        h = rng.randint(8, 100)
        widths = [rng.randint(176, 320)] + sorted(rng.sample(range(8, 176), n - 1), reverse=True)
        mid = rng.randint(30, 90)
        tops = sorted(rng.sample(range(-40, mid), n))
        bottoms = sorted(rng.sample(range(mid + 1, 170), n), reverse=True)
        vp = {"preset": "custom", "width_px": w, "height": h}
        if rng.random() < 0.3:
            vp["byte_edges"] = True
        cfg = {"viewport": vp, "planes": {"ref_size": [176, 120], "width": widths, "top": tops, "bottom": bottoms}}
        yield {"label": f"random custom {i}", "cfg": cfg}
    # error cases (test_dbegeom.py and further texts)
    errs = [ww(138, 96), ww(140, 96, stride=60), custom(width=[200, 110, 110, 30]),
            {"viewport": {"width_px": 140, "height": 96, "foo": 1}}, {"viewport": {"width_px": 140, "height": 96, "depth": 4}},
            {"viewport": {"width_px": 140, "height": 96, "preset": "xyz"}}, {"viewport": {"width_px": 140, "height": 200}},
            {"viewport": {"width_px": 200, "height": 96}}, {"viewport": {"width_px": 140, "height": 96, "origin": 65000}},
            custom(top=[-10, 10, 25, 25]), custom(top=[-10, 10, 25, 80]), custom(center_x=80), custom(center_x=88.5),
            custom(width=[200, "x", 60, 30]), {"viewport": {"width_px": 140, "height": 96, "byte_edges": 1}},
            ww(140, 96, load=0xEC00), ww(140, 96, load=0x2000), {"viewport": {"height": 96}}, {"viewport": {"width_px": 140}},
            {"viewport": {"width_px": 140, "height": 96}, "planes": {}}, {"viewport": {"preset": "custom", "width_px": 140, "height": 96}},
            {"viewport": {"width_px": 140, "height": 96}, "extra": {}}, {"viewport": {"width_px": 140, "height": 96}, "output": {"nme": 1}},
            {"viewport": {"width_px": "140", "height": 96}}, {"viewport": {"width_px": True, "height": 96}},
            {"viewport": {"width_px": 140, "height": 7}}, {"viewport": {"width_px": 12, "height": 96}},
            {"viewport": {"width_px": 140, "height": 96, "origin": -1}}, {"viewport": {"width_px": 140, "height": 96, "stride": 256}},
            custom(ref_size=[176]), custom(ref_size=[0, 120]), custom(width=[200, 110]), custom(top=[-10, 10, 25]),
            custom(bottom=[140, 100, 70]), custom(bottom=[140, 100, 100, 55]), custom(top=[-10, 10, 25, 60], bottom=[140, 100, 70, 55]),
            custom(foo=1), (lambda c: (c["planes"].pop("top"), c)[1])(custom()), custom_vp(depth=3), custom_vp(depth=True),
            custom(width=[200, 110, 60, 2]), custom(top=[-10, 10, 25, 70], bottom=[140, 100, 70, 71]),
            ww(140, 96, zoom="4"), ww(140, 96, pool_bytes=1.5), {"viewport": {"width_px": 140, "height": 96, "preset": 5}},
            custom(width=[200, 110, 60, 30], ref_size=[176, 120], top=[-500, 10, 25, 35])]
    for i, cfg in enumerate(errs):
        yield {"label": f"error {i}", "cfg": cfg}


def run(case, tmp):
    res = {k: v for k, v in case.items()}
    try:
        if "toml" in case:
            with open(os.path.join(ROOT, case["toml"]), "rb") as f:
                cfg = tomllib.load(f)
        else:
            cfg = copy.deepcopy(case["cfg"])
        conf = dbegeom.parse_config(cfg)
        conf.update(case.get("patch", {}))
        name = conf["name"]
        res["name"] = name
        geo = dbegeom.Geometry(conf)
        res["check_sha"] = sha("\n".join(dbegeom.check_lines(geo)).encode())
        out = os.path.join(tmp, str(len(os.listdir(tmp))))
        geo, bud = dbegeom.generate(conf, out, name)
    except dbegeom.GeomError as e:
        res["error"] = str(e)
        return res
    except (IndexError, ValueError, KeyError, TypeError) as e:     # Python-level failures: JS must throw as well
        res["exception"] = f"{type(e).__name__}: {e}"
        return res
    res["elements"] = len(geo.elements)
    files, pngs = {}, {}
    for dp, _, fns in os.walk(out):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, out).replace(os.sep, "/")
            if fn.endswith(".png"):
                with Image.open(p) as im:
                    pngs[rel] = [im.width, im.height, sha(im.convert("RGBA").tobytes())]
            else:
                with open(p, "rb") as f:
                    files[rel] = sha(f.read())
    with open(os.path.join(out, f"{name}.dvg"), "rb") as f:
        import struct
        res["gid"] = struct.unpack("<H", f.read()[14:16])[0]
    res["files"] = dict(sorted(files.items()))
    res["pngs"] = {k: v for k, v in sorted(pngs.items()) if not k.startswith("tpl/")}
    # templates combined: sha256 over (name NUL width height sha) per template, sorted by name
    tpl = sorted((k, v) for k, v in pngs.items() if k.startswith("tpl/"))
    res["tpl"] = [len(tpl), sha("".join(f"{k}\0{w}\0{h}\0{s}\n" for k, (w, h, s) in tpl).encode())]
    return res


def main():
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for c in cases():
            out.append(run(c, tmp))
    with open(os.path.join(HERE, "geom.json"), "w", encoding="utf-8") as f:
        json.dump({"generator": "mkgolden_geom.py", "cases": out}, f, indent=1, ensure_ascii=False)
        f.write("\n")
    ok = sum(1 for c in out if "error" not in c)
    print(f"geom.json: {len(out)} cases ({ok} generated, {len(out) - ok} errors)")


if __name__ == "__main__":
    main()
