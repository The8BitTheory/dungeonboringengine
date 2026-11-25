#!/usr/bin/env python3
"""Sprite-Saetze v2 (S2): gemalte Bilder je (Phase, Blickwinkel, Tiefe) -> S2 + VRL, Beschneiden (P5b).

Eingabe: spr.toml (Spezifikation docs/specs/P5b-sprites.md), Quelle Aseprite-Export oder PNG mit Bildliste.
Ausgabe (Ordner [sprite].out):
  <name>.s2           Bank 1: Kopf, Indextabelle, Bildverzeichnis, Kerne, Tags, VMS-Listen
  <name>.vrl          Bank 0: alle Bilddaten (VRL v1), danach per RXV an die VRAM-Basis
  <name>.spr.json, <name>.spr.md   Bericht;  <name>_preview.png  Probebild (x4)

Aseprite-Export (Ebenen v<ai>_d<d>, Frames = Phasen, Tags = Animationen, Slices v<ai>_d<d> mit Pivot = Fusspunkt):
  aseprite -b ork.aseprite --split-layers --sheet ork.png --data ork.json --format json-array \\
           --filename-format '{layer}#{frame}' --list-layers --list-tags --list-slices

Aufruf:
  dbespr.py build  SPR.toml [--out DIR] [--strict] [--key RRGGBB] [--no-preview]
  dbespr.py dump   FILE.s2 [--vrl FILE.vrl] [--json]
  dbespr.py preview FILE.s2 --vrl FILE.vrl --geom G.json [--d D] [--phase F] [--angle A] [--out PNG]
  dbespr.py budget FILE... --pool N [...]      (wie dbetex.py budget, liest auch S2)
Exitcode 0 ok, 1 Format-/Validierungsfehler, 2 Aufruf.
Als Modul: clip_image (Referenz fuer VIEW, 6), render_image, from_s2, to_s2, lookup.
"""
import argparse
import binascii
import json
import os
import re
import struct
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbetex  # noqa: E402
import vrl  # noqa: E402
from dbetex import (PALETTE, TexError, Kern, to_indices, classify, choose_kerns, pack_image,  # noqa: E402
                    resolve_alpha_conflict, read_rgba, sim_vmc, sim_vms, fb_to_image, parse_key, load_geom)

SprError = TexError
HEAD = 40
NOIMG, FALLBACK = 0xFE, 0xFF
F_ITEM, F_RAND = 1, 8
MODES = {"forward": 0, "reverse": 1, "pingpong": 2}
MODE_NAMES = ["forward", "reverse", "pingpong"]
DEFAULT_MAP = {1: [0, 0, 0, 0], 2: [0, 0, 1, 0], 3: [0, 1, 2, 1], 4: [0, 1, 2, 3]}
VMS_BUFFER_SHARED = 2304
LAYER_RE = re.compile(r"^v(\d+)_d(\d+)$")


# ---------------------------------------------------------------- Datentypen

@dataclass
class Img:
    w: int
    h: int
    fx: int
    fy: int
    kerns: list = field(default_factory=list)
    rand_ofs: int = 0
    rand_len: int = 0
    rand: bytes = b""
    vms: bytes = b""
    pix: list = field(default_factory=list, compare=False)

    @property
    def flags(self):
        return F_RAND if self.rand_len else 0


@dataclass
class Tag:
    name: str
    first: int
    count: int
    mode: int
    dur: int


@dataclass
class SpriteSet:
    geometry_id: int
    depth: int
    stride: int
    na: int
    np: int
    angle_map: list
    flags: int
    index: list
    images: list
    tags: list
    vram: bytes = b""
    u: int = 0
    crc: int = 0
    total: int = 0
    nk: int = 0


@dataclass
class Clipped:
    kerns: list          # (src, x, y, w, h, srcstep): Quelle relativ zur VRAM-Basis, Ziel im Sichtfenster
    vms: object          # bytes oder None
    rand_src: int        # Leseposition der VMS-Liste (VRAM-Offset der Randbytes)
    ref: tuple           # Bezugspunkt (x, y) der VMS-Liste im Sichtfenster


# ---------------------------------------------------------------- Beschneiden (6)

def clip_image(img, x0, y0, cx0, cx1, cy0, cy1, stride):
    """Beschneidet Bildeintrag img (Img) mit linker oberer Ecke (x0, y0) auf [cx0, cx1) x [cy0, cy1) (Sichtfensterkoordinaten).

    stride = Zeilenabstand der VMS-Offsets (Stride der Geometrie; in der Spezifikation implizit)."""
    L, R, T, B = cx0 - x0, cx1 - x0, cy0 - y0, cy1 - y0
    full = (L, R, T, B) == (0, img.w, 0, img.h)
    kerns = []
    for k in img.kerns:
        st = k.srcstep or k.w
        a, b = max(k.dx, L), min(k.dx + k.w, R)
        c, e = max(k.dy, T), min(k.dy + k.h, B)
        if a >= b or c >= e:
            continue
        src = k.src + (c - k.dy) * st + (a - k.dx)
        ss = k.srcstep if (a == k.dx and b == k.dx + k.w) else st
        kerns.append((src, x0 + a, y0 + c, b - a, e - c, ss))
    if full:
        return Clipped(kerns, img.vms or None, img.rand_ofs, (x0, y0))
    out = bytearray()
    n = 0
    if img.vms:
        v = img.vms
        cnt = v[1] | v[2] << 8
        p, r, rs, k = 3, 0, 0, 0
        for _ in range(cnt):
            t = v[p]
            ofs = v[p + 1] | v[p + 2] << 8
            while ofs >= rs + stride:
                rs += stride
                r += 1
            if r >= B:
                break
            col = ofs - rs
            if t == 1:
                ln = v[p + 3]
                p += 4
                if T <= r < B and col < R and col + ln > L:
                    a, b = max(col, L), min(col + ln, R)
                    k += a - col
                    if k:
                        out += bytes((3, k & 255, k >> 8))
                        n += 1
                        k = 0
                    o = (r - T) * stride + (a - L)
                    out += bytes((1, o & 255, o >> 8, b - a))
                    n += 1
                    k += col + ln - b
                else:
                    k += ln
            elif t == 8:
                p += 3
                if T <= r < B and L <= col < R:
                    if k:
                        out += bytes((3, k & 255, k >> 8))
                        n += 1
                        k = 0
                    o = (r - T) * stride + (col - L)
                    out += bytes((8, o & 255, o >> 8))
                    n += 1
                else:
                    k += 1
            else:
                raise SprError(f"VMS-Liste: Typ {t} im Bild")
    has = any(True for _ in _commands(out))
    vms = bytes((img.vms[0], n & 255, n >> 8)) + bytes(out) if has else None
    return Clipped(kerns, vms, img.rand_ofs, (cx0, cy0))


def _commands(lst):
    p = 0
    while p < len(lst):
        t = lst[p]
        ln = {1: 4, 8: 3, 3: 3}.get(t)
        if ln is None:
            raise SprError(f"VMS-Liste: Typ {t}")
        if t != 3:
            yield t
        p += ln


def render_image(ss, img_index, vram, fb, x0, y0, vp, ap=0, vb=0, clip=None):
    """Zeichnet Bild img_index ueber clip_image + sim_*. vp = Viewport-Dict der Geometrie (stride, origin).
    clip = (cx0, cx1, cy0, cy1) in Fensterkoordinaten oder None (unbeschnitten); wird auf das Bildrechteck begrenzt.
    Liefert False, wenn nichts zu zeichnen ist."""
    img = ss.images[img_index]
    stride = vp["stride"]
    base = (ap + vp.get("origin", 0)) & 0xFFFF
    if clip is None:
        cx0, cx1, cy0, cy1 = x0, x0 + img.w, y0, y0 + img.h
    else:
        cx0, cx1 = max(clip[0], x0), min(clip[1], x0 + img.w)
        cy0, cy1 = max(clip[2], y0), min(clip[3], y0 + img.h)
        if cx0 >= cx1 or cy0 >= cy1:
            return False
    c = clip_image(img, x0, y0, cx0, cx1, cy0, cy1, stride)
    for src, x, y, w, h, st in c.kerns:
        sim_vmc(vram, vb + src, base + y * stride + x, w, h, stride, st, fb=fb)
    if c.vms:
        sim_vms(vram, vb + c.rand_src, base + c.ref[1] * stride + c.ref[0], c.vms, fb=fb)
    return True


# ---------------------------------------------------------------- Index (4.2)

def view_angle(v, o):
    """Blickwinkel a aus Spielerrichtung v und Objektrichtung o ($FF -> 0)."""
    return 0 if o == 0xFF else (2 + v - o) & 3


def lookup(ss, phase, a, d):
    """Bildindex fuer (Phase, Blickwinkel a, Tiefe d) oder None (nichts zeichnen)."""
    if not 1 <= d <= ss.depth:
        return None
    if phase >= ss.np:
        phase = 0
    ai = ss.angle_map[a & 3]
    v = ss.index[(phase * ss.na + ai) * ss.depth + d - 1]
    if v == FALLBACK:
        v = ss.index[ai * ss.depth + d - 1]
    return None if v >= NOIMG else v


# ---------------------------------------------------------------- Konfiguration (3.1)

SPRITE_KEYS = {"name", "geom", "dvg", "out", "load", "vrl_load", "angles", "angle_map", "phases", "max_kerns",
               "kern_min", "key", "alpha_threshold", "any_geometry", "mirror", "derive"}
SOURCE_KEYS = {"aseprite", "png"}
IMAGE_KEYS = {"box", "foot", "phase", "angle", "depth"}


def load_conf(path, out=None, strict=False, key=None):
    cfg = dbetex._toml(path)
    base = os.path.dirname(os.path.abspath(path))
    dbetex._check_keys(path, cfg, {"format", "version", "sprite", "source", "image"})
    if cfg.get("format") != "dbespr" or cfg.get("version") != 1:
        raise SprError(f'{path}: format = "dbespr" und version = 1 erwartet')
    sp = dict(cfg.get("sprite") or {})
    dbetex._check_keys(f"{path} [sprite]", sp, SPRITE_KEYS)
    for k in ("name", "geom"):
        if k not in sp:
            raise SprError(f"{path} [sprite]: {k} fehlt")
    I = dbetex._int
    na = I("angles", sp.get("angles", 1), 1, 4)
    amap = sp.get("angle_map", DEFAULT_MAP[na])
    if not isinstance(amap, list) or len(amap) != 4 or any(not isinstance(v, int) or not 0 <= v < na for v in amap):
        raise SprError(f"{path}: angle_map braucht 4 Werte < angles ({na})")
    mirror = {}
    for k, v in (sp.get("mirror") or {}).items():
        try:
            t = int(k)
        except ValueError:
            raise SprError(f"{path}: mirror: Schluessel {k!r} ist keine Zahl")
        if not (isinstance(v, int) and 0 <= t < na and 0 <= v < na and t != v):
            raise SprError(f"{path}: mirror {k} = {v}: nur zwischen verschiedenen vorhandenen Bildwinkeln < {na}")
        mirror[t] = v
    derive = sp.get("derive", "none")
    if derive not in ("none", "nearest"):
        raise SprError(f'{path}: derive = "none" oder "nearest" erwartet')
    c = {"name": str(sp["name"]), "geom": os.path.join(base, sp["geom"]),
         "dvg": os.path.join(base, sp["dvg"]) if sp.get("dvg") else None,
         "out": out or os.path.join(base, sp.get("out", ".")),
         "load": I("load", sp.get("load", 0x7000), 0, 0xFFFF), "vrl_load": I("vrl_load", sp.get("vrl_load", 0x4000), 0, 0xFFFF),
         "angles": na, "angle_map": list(amap), "mirror": mirror, "derive": derive,
         "phases": I("phases", sp["phases"], 1, 32) if "phases" in sp else None,
         "max_kerns": I("max_kerns", sp.get("max_kerns", 4), 0, 16), "kern_min": I("kern_min", sp.get("kern_min", 16), 1, 65535),
         "key": key if key is not None else sp.get("key"),
         "alpha_threshold": I("alpha_threshold", sp.get("alpha_threshold", 0), 0, 255),
         "any_geometry": bool(sp.get("any_geometry", False)), "strict": strict}
    src = dict(cfg.get("source") or {})
    dbetex._check_keys(f"{path} [source]", src, SOURCE_KEYS)
    if ("png" in src) == ("aseprite" in src):
        raise SprError(f"{path} [source]: genau eine Quelle (aseprite oder png) erwartet")
    images = cfg.get("image") or []
    if "aseprite" in src:
        if images:
            raise SprError(f"{path}: [[image]] nur zusammen mit png")
        c["aseprite"] = os.path.join(base, src["aseprite"])
    else:
        if not images:
            raise SprError(f"{path}: png braucht [[image]]-Eintraege")
        c["png"] = os.path.join(base, src["png"])
        c["images"] = []
        for i, im in enumerate(images):
            where = f"{path} [[image]] {i}"
            dbetex._check_keys(where, im, IMAGE_KEYS)
            for k in ("box", "phase", "angle", "depth"):
                if k not in im:
                    raise SprError(f"{where}: {k} fehlt")
            box = im["box"]
            if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, int) for v in box)):
                raise SprError(f"{where}: box = [x, y, w, h] erwartet")
            foot = im.get("foot")
            if foot is not None and not (isinstance(foot, list) and len(foot) == 2 and all(isinstance(v, int) for v in foot)):
                raise SprError(f"{where}: foot = [x, y] erwartet")
            c["images"].append({"box": tuple(box), "foot": tuple(foot) if foot else None,
                                "phase": I("phase", im["phase"], 0, 31), "angle": I("angle", im["angle"], 0, 3),
                                "depth": I("depth", im["depth"], 0, 255)})
    return c


# ---------------------------------------------------------------- Quellen

@dataclass
class Raw:
    pix: list
    footpx: int
    fy: int
    kind: str = "eigen"
    note: str = ""


def raster(rows, x, foot_x, foot_y):
    """Ausschnitt rows (Breite wpx, linke Kante auf Pixelspalte x) -> Byte-Raster (3.4)."""
    wpx = len(rows[0])
    lead = x & 1
    tw = lead + wpx
    tw += tw & 1
    pix = [[None] * lead + list(r) + [None] * (tw - lead - wpx) for r in rows]
    return Raw(pix, lead + foot_x, foot_y)


def _crop_rows(pix, x, y, w, h):
    return [row[x:x + w] for row in pix[y:y + h]]


def _bbox(pix):
    ys = [r for r, row in enumerate(pix) if any(v is not None for v in row)]
    if not ys:
        return None
    xs = [c for row in pix for c, v in enumerate(row) if v is not None]
    return min(xs), ys[0], max(xs) - min(xs) + 1, ys[-1] - ys[0] + 1


def _frame_list(js, path):
    fr = js.get("frames")
    if isinstance(fr, dict):
        fr = [dict(v, filename=v.get("filename", k)) for k, v in fr.items()]
    if not isinstance(fr, list) or not fr:
        raise SprError(f"{path}: keine Frames")
    return fr


def load_aseprite(conf, geom, warns, infos):
    """-> (cells {(f, ai, d): Raw}, tags (Name, von, bis, Richtung), Dauern {f: ms}, NP aus der Quelle)."""
    path = conf["aseprite"]
    try:
        with open(path, encoding="utf-8") as f:
            js = json.load(f)
    except (OSError, ValueError) as e:
        raise SprError(f"{path}: {e}")
    meta = js.get("meta") or {}
    if "image" not in meta:
        raise SprError(f"{path}: meta.image fehlt")
    sheet = read_rgba(os.path.join(os.path.dirname(path), meta["image"]))
    D, NA = geom["viewport"]["depth"], conf["angles"]
    key, thr = conf["key"], conf["alpha_threshold"]
    slices = {}
    for sl in meta.get("slices", []):
        if sl["name"] in slices:
            raise SprError(f"{path}: Slice {sl['name']!r} doppelt")
        slices[sl["name"]] = sorted(sl.get("keys", []), key=lambda k: k["frame"])
    cells, dur, ignored, maxf = {}, {}, set(), -1
    for e in _frame_list(js, path):
        fn = e.get("filename", "")
        if "#" not in fn:
            raise SprError(f"{path}: Dateiname {fn!r} ist nicht <Ebene>#<Frame> (--filename-format '{{layer}}#{{frame}}')")
        layer, fs = fn.rsplit("#", 1)
        try:
            f = int(fs)
        except ValueError:
            raise SprError(f"{path}: Dateiname {fn!r}: Frame-Nummer ungueltig")
        if e.get("rotated") or e.get("trimmed"):
            raise SprError(f"{path}: Frame {fn} ist rotated/trimmed - ohne --trim exportieren")
        dur.setdefault(f, e.get("duration", 100))
        m = LAYER_RE.match(layer)
        if not m:
            if layer not in ignored:
                ignored.add(layer)
                infos.append(f"Ebene {layer!r} entspricht nicht v<ai>_d<d>, ignoriert")
            continue
        ai, d = int(m.group(1)), int(m.group(2))
        if ai >= NA:
            raise SprError(f"{path}: Ebene {layer}: Bildwinkel {ai} >= angles {NA}")
        if not 1 <= d <= D:
            raise SprError(f"{path}: Ebene {layer}: Tiefe {d} ausserhalb 1 ... {D}")
        maxf = max(maxf, f)
        if (f, ai, d) in cells:
            raise SprError(f"{path}: {fn} doppelt")
        fr = e["frame"]
        pix, w = to_indices(sheet, (fr["x"], fr["y"], fr["w"], fr["h"]), key, thr, conf["strict"])
        warns += [f"{fn}: {x}" for x in w]
        keys = [k for k in slices.get(layer, []) if k["frame"] <= f]
        k = keys[-1] if keys else None
        if k is not None:
            b = k["bounds"]
            if b["x"] < 0 or b["y"] < 0 or b["x"] + b["w"] > fr["w"] or b["y"] + b["h"] > fr["h"]:
                raise SprError(f"{path}: Slice {layer}: Rahmen liegt ausserhalb der Leinwand")
            rows = _crop_rows(pix, b["x"], b["y"], b["w"], b["h"])
            tot = sum(v is not None for row in pix for v in row)
            inn = sum(v is not None for row in rows for v in row)
            if tot > inn:
                warns.append(f"{fn}: {tot - inn} Pixel außerhalb der Slice, verworfen")
            if inn == 0:
                continue
            if "pivot" in k:
                foot = (k["pivot"]["x"], k["pivot"]["y"])
            else:
                foot = (b["w"] // 2, b["h"] - 1)
            cells[(f, ai, d)] = raster(rows, b["x"], foot[0], foot[1])
        else:
            bb = _bbox(pix)
            if bb is None:
                continue
            rows = _crop_rows(pix, *bb)
            infos.append(f"{fn}: Fusspunkt automatisch")
            cells[(f, ai, d)] = raster(rows, bb[0], bb[2] // 2, bb[3] - 1)
        _foot_info(cells[(f, ai, d)], fn, infos)
    tags = []
    for t in meta.get("frameTags", []):
        tags.append((t["name"], t["from"], t["to"], t.get("direction", "forward")))
    return cells, tags, dur, maxf + 1


def _foot_info(raw, name, infos):
    if raw.footpx & 1:
        infos.append(f"{name}: Fusspunkt auf Bytegrenze gerundet")


def load_png(conf, geom, warns, infos):
    path = conf["png"]
    img = read_rgba(path)
    D, NA = geom["viewport"]["depth"], conf["angles"]
    cells, maxf = {}, -1
    for i, im in enumerate(conf["images"]):
        f, ai, d = im["phase"], im["angle"], im["depth"]
        name = f"image {i} (f{f}, ai{ai}, d{d})"
        if ai >= NA:
            raise SprError(f"{name}: Bildwinkel >= angles {NA}")
        if not 1 <= d <= D:
            raise SprError(f"{name}: Tiefe ausserhalb 1 ... {D}")
        if (f, ai, d) in cells:
            raise SprError(f"{name}: (Phase, Bildwinkel, Tiefe) doppelt")
        x, y, w, h = im["box"]
        pix, ws = to_indices(img, (x, y, w, h), conf["key"], conf["alpha_threshold"], conf["strict"])
        warns += [f"{name}: {m}" for m in ws]
        if all(v is None for row in pix for v in row):
            warns.append(f"{name}: leer, kein Bild")
            continue
        foot = im["foot"] or (w // 2, h - 1)
        if not im["foot"]:
            infos.append(f"{name}: Fusspunkt automatisch")
        cells[(f, ai, d)] = raster(pix, x, foot[0], foot[1])
        _foot_info(cells[(f, ai, d)], name, infos)
        maxf = max(maxf, f)
    return cells, [], {}, maxf + 1


# ---------------------------------------------------------------- Spiegeln, Ableiten (5.3, 5.4)

def mirror_raw(raw):
    tw = len(raw.pix[0])
    return Raw([row[::-1] for row in raw.pix], tw - 1 - raw.footpx, raw.fy, "gespiegelt")


def plane_w(geom, d):
    pl = geom["planes"]
    return 1.0 / (0.5 / pl[d]["W"] + 0.5 / pl[d + 1]["W"])


def derive_raw(raw, k):
    h, tw = len(raw.pix), len(raw.pix[0])
    rw, nh = max(1, int(tw * k + 0.5)), max(1, int(h * k + 0.5))
    nw = rw + (rw & 1)
    pix = [[raw.pix[min(h - 1, int((j + 0.5) / k))][min(tw - 1, int((i + 0.5) / k))] if i < rw else None
            for i in range(nw)] for j in range(nh)]
    return Raw(pix, min(rw - 1, int(raw.footpx * k + 0.5)), min(nh - 1, int(raw.fy * k + 0.5)), "abgeleitet")


# ---------------------------------------------------------------- Aufbau

def _tag_name(n, warns, used):
    s = re.sub(r"[^A-Z0-9_]", "_", n.upper())
    if len(s) > 8:
        warns.append(f"Tag {n!r}: auf 8 Zeichen gekuerzt ({s[:8]})")
        s = s[:8]
    if s in used:
        warns.append(f"Tag {n!r}: Name {s} doppelt")
    used.add(s)
    return s


def build_spriteset(conf):
    """-> (SpriteSet, Warnungen, Infos, Quellen {(f, ai, d): Text})."""
    geom = load_geom(conf["geom"], conf.get("dvg"))
    warns, infos = [], []
    vp = geom["viewport"]
    D, stride, VW, VH = vp["depth"], vp["stride"], vp["width_px"] // 2, vp["height"]
    NA = conf["angles"]
    if "aseprite" in conf:
        cells, tags, dur, np_src = load_aseprite(conf, geom, warns, infos)
    else:
        cells, tags, dur, np_src = load_png(conf, geom, warns, infos)
    if not cells:
        raise SprError("keine Bilder in der Quelle")
    NP = conf["phases"] or max(np_src, 1)
    if NP > 32:
        raise SprError(f"NP {NP} > 32")
    for (f, ai, d) in cells:
        if f >= NP:
            raise SprError(f"Bild in Phase {f} >= phases {NP}")
    # Spiegeln
    for tgt, src in sorted(conf["mirror"].items()):
        for (f, ai, d) in sorted(k for k in cells if k[1] == src):
            if (f, tgt, d) not in cells:
                m = mirror_raw(cells[(f, ai, d)])
                m.note = f"v{src}_d{d}"
                cells[(f, tgt, d)] = m
                if m.footpx & 1:
                    infos.append(f"v{tgt}_d{d}#{f}: Fusspunkt auf Bytegrenze gerundet")
    # Ableiten
    if conf["derive"] == "nearest":
        painted = dict(cells)
        for f in range(NP):
            for ai in range(NA):
                for d in range(1, D + 1):
                    if (f, ai, d) in cells or (f > 0 and (0, ai, d) in cells):
                        continue
                    srcs = [dd for dd in range(1, d) if (f, ai, dd) in painted]
                    if not srcs:
                        continue
                    ds = max(srcs)
                    k = plane_w(geom, d) / plane_w(geom, ds)
                    cells[(f, ai, d)] = derive_raw(painted[(f, ai, ds)], k)
                    cells[(f, ai, d)].note = f"v{ai}_d{ds}"
                    warns.append(f"v{ai}_d{d}#{f}: Tiefe {d} aus Tiefe {ds} abgeleitet")
    # Bilder
    images, keys, vram, sources, index = [], {}, bytearray(), {}, []
    slot0 = {s["d"]: s for s in geom["slots"] if s["s"] == 0}
    for f in range(NP):
        for ai in range(NA):
            for d in range(1, D + 1):
                raw = cells.get((f, ai, d))
                name = f"v{ai}_d{d}#{f}"
                if raw is None:
                    if f == 0:
                        index.append(NOIMG)
                        if conf["derive"] == "none":
                            warns.append(f"Phase 0 ohne Bild für v{ai}_d{d}")
                        sources[(f, ai, d)] = "$FE"
                    else:
                        index.append(FALLBACK)
                        sources[(f, ai, d)] = "$FF"
                    continue
                h, tw = len(raw.pix), len(raw.pix[0])
                w, fx, fy = tw // 2, raw.footpx // 2, raw.fy
                if not 1 <= w <= min(VW, 127) or not 1 <= h <= VH:
                    raise SprError(f"{name}: Bildgroesse {w} Byte x {h} Zeilen ausserhalb 1 ... {min(VW, 127)} x 1 ... {VH}")
                if not (0 <= fx < w and 0 <= fy < h):
                    raise SprError(f"{name}: Fusspunkt ({fx}, {fy}) ausserhalb des Bildes {w} x {h}")
                top = slot0[d]["anchors_px"][0][1] - fy
                if top < geom["planes"][d]["T"]:
                    warns.append(f"{name}: Bild ragt ueber die Wandoberkante (Oberkante {top} < T {geom['planes'][d]['T']})")
                key = (tuple(tuple(r) for r in raw.pix), w, h, fx, fy)
                if key in keys:
                    index.append(keys[key])
                    sources[(f, ai, d)] = f"geteilt mit Bild {keys[key]}"
                    continue
                pix = [list(r) for r in raw.pix]
                states = classify(pix)
                nres = resolve_alpha_conflict(pix, states)
                if nres:
                    warns.append(f"{name}: alle 16 Farben in halb-R-Bytes, {nres} Bytes voll gemacht")
                kerns = choose_kerns(states, conf["max_kerns"], conf["kern_min"])
                alpha, rand, vms = pack_image(pix, states, kerns, stride)
                im = Img(w, h, fx, fy, pix=pix)
                for kk in kerns:
                    im.kerns.append(Kern(len(vram), kk[0], kk[1], kk[2], kk[3], 0))
                    vram += dbetex.kern_bytes(pix, [kk])
                if rand:
                    im.rand_ofs, im.rand_len, im.rand, im.vms = len(vram), len(rand), rand, vms
                    vram += rand
                images.append(im)
                keys[key] = len(images) - 1
                index.append(len(images) - 1)
                sources[(f, ai, d)] = {"eigen": "eigen", "gespiegelt": f"gespiegelt von {raw.note}",
                                       "abgeleitet": f"abgeleitet von {raw.note}"}[raw.kind]
    if len(images) > 254:
        raise SprError(f"zu viele Bilder: {len(images)} > 254")
    if len(vram) > 65535:
        raise SprError(f"VRAM-Daten {len(vram)} > 65535 Byte")
    nk = sum(len(i.kerns) for i in images)
    if nk > 65535:
        raise SprError(f"zu viele Kerne: {nk}")
    # Tags
    tl, used = [], set()
    if len(tags) > 32:
        raise SprError(f"{len(tags)} Tags > 32")
    for (n, a, b, dr) in tags:
        if not 0 <= a <= b < NP:
            raise SprError(f"Tag {n!r}: Frames {a}-{b} ausserhalb 0 ... {NP - 1}")
        if dr not in MODES:
            warns.append(f"Tag {n!r}: Richtung {dr!r} unbekannt, forward")
            dr = "forward"
        ds = [dur.get(f, 100) for f in range(a, b + 1)]
        if len(set(ds)) > 1:
            warns.append(f"Tag {n!r}: ungleiche Dauern {ds}, Mittelwert")
        ms = sum(ds) / len(ds)
        j = min(255, max(1, int(ms * 60 / 1000 + 0.5)))
        tl.append(Tag(_tag_name(n, warns, used), a, b - a + 1, MODES[dr], j))
    ss = SpriteSet(0 if conf["any_geometry"] else geom["geometry_id"], D, stride, NA, NP, list(conf["angle_map"]),
                   F_ITEM if NA == 1 else 0, index, images, tl, bytes(vram))
    ss.u, ss.crc, ss.nk = len(vram), binascii.crc_hqx(bytes(vram), 0xFFFF), nk
    return ss, warns, infos, sources


# ---------------------------------------------------------------- S2 (4)

def to_s2(ss, load=0x7000):
    NP, NA, D, NI, NT = ss.np, ss.na, ss.depth, len(ss.images), len(ss.tags)
    nk = sum(len(i.kerns) for i in ss.images)
    if NI > 254 or NP > 32 or NA > 4 or NT > 32 or nk > 65535 or len(ss.vram) > 65535:
        raise SprError("Grenzen ueberschritten (NI <= 254, NP <= 32, NA <= 4, NT <= 32, NK <= 65535, U <= 65535)")
    o_idx = HEAD
    o_dir = o_idx + NP * NA * D
    o_kern = o_dir + 16 * NI
    o_tag = o_kern + 8 * nk
    o_data = o_tag + 12 * NT
    dirs, kerns, data = bytearray(), bytearray(), bytearray()
    kpos = o_kern
    for im in ss.images:
        kofs = 0
        if im.kerns:
            kofs = kpos
            for k in im.kerns:
                kerns += struct.pack("<HBBBBH", k.src, k.dx, k.dy, k.w, k.h, 0)
            kpos += 8 * len(im.kerns)
        vofs = vlen = 0
        if im.vms:
            vofs, vlen = o_data + len(data), len(im.vms)
            data += im.vms
        dirs += struct.pack("<BBBBBBHHHHH", im.flags, im.w, im.h, im.fx, im.fy, len(im.kerns), kofs,
                            im.rand_ofs, im.rand_len, vofs, vlen)
    tags = bytearray()
    for t in ss.tags:
        tags += t.name.encode("ascii").ljust(8, b"\0") + bytes((t.first, t.count, t.mode, t.dur))
    total = o_data + len(data)
    if total > 8192:
        raise SprError(f"S2-Inhalt {total} > 8192 Byte (passt nicht in den Sprite-Bereich der Speicherkarte)")
    head = bytearray(HEAD)
    head[0:3] = b"S2\x01"
    head[3] = ss.flags
    struct.pack_into("<H", head, 4, ss.geometry_id)
    head[6], head[7], head[8], head[9] = D, NA, NP, NI
    struct.pack_into("<H", head, 10, nk)
    head[12:16] = bytes(ss.angle_map)
    struct.pack_into("<HHHH", head, 16, o_idx, o_dir, o_kern, o_tag)
    head[24] = NT
    # 26-27 Datenbereich, 28-29 Laenge, 30-31 U, 32-33 CRC, 34-35 stride
    struct.pack_into("<HHHHH", head, 26, o_data, total, len(ss.vram), binascii.crc_hqx(ss.vram, 0xFFFF), ss.stride)
    out = bytes(head) + bytes(ss.index) + bytes(dirs) + bytes(kerns) + bytes(tags) + bytes(data)
    assert len(out) == total
    return struct.pack("<H", load) + out


def from_s2(data, vram=None):
    """S2-PRG -> SpriteSet (vram optional). TexError bei Formatfehlern."""
    if len(data) < 2 + HEAD:
        raise SprError("S2: Datei kuerzer als der Kopf")
    c = data[2:]
    if c[0:2] != b"S2":
        raise SprError("S2: falsches Magic (erwartet 'S2')")
    if c[2] != 1:
        raise SprError(f"S2: Version {c[2]} nicht unterstuetzt")
    flags = c[3]
    gid = struct.unpack_from("<H", c, 4)[0]
    D, NA, NP, NI = c[6], c[7], c[8], c[9]
    nk = struct.unpack_from("<H", c, 10)[0]
    amap = list(c[12:16])
    o_idx, o_dir, o_kern, o_tag = struct.unpack_from("<HHHH", c, 16)
    NT = c[24]
    o_data, total, u, crc, stride = struct.unpack_from("<HHHHH", c, 26)
    if not 1 <= NA <= 4 or not 1 <= NP <= 32 or NI > 254 or NT > 32 or D < 1:
        raise SprError("S2: NA/NP/NI/NT/D ausserhalb der Grenzen")
    if any(v >= NA for v in amap):
        raise SprError("S2: angle_map verweist auf Bildwinkel >= NA")
    exp = (HEAD, HEAD + NP * NA * D, HEAD + NP * NA * D + 16 * NI, HEAD + NP * NA * D + 16 * NI + 8 * nk,
           HEAD + NP * NA * D + 16 * NI + 8 * nk + 12 * NT)
    if (o_idx, o_dir, o_kern, o_tag, o_data) != exp:
        raise SprError("S2: Offsets im Kopf passen nicht zu den Anzahlen (Bereiche nicht lueckenlos)")
    if len(c) < total or total < o_data:
        raise SprError(f"S2: Datei zu kurz ({len(c)} < {total})")
    if vram is not None and (len(vram) != u or binascii.crc_hqx(bytes(vram), 0xFFFF) != crc):
        raise SprError(f"S2: VRL passt nicht (U {len(vram)} / {u}, CRC)")
    index = list(c[o_idx:o_idx + NP * NA * D])
    for i, v in enumerate(index):
        if v < NOIMG and v >= NI:
            raise SprError(f"S2: Indextabelle verweist auf Bild {v} >= NI {NI}")
        if v == FALLBACK and i < NA * D:
            raise SprError("S2: $FF in Phase 0")
    images, kp = [], 0
    for i in range(NI):
        fl, w, h, fx, fy, nkk, kofs, rofs, rlen, vofs, vlen = struct.unpack_from("<BBBBBBHHHHH", c, o_dir + 16 * i)
        if not (1 <= w <= 127 and h >= 1 and fx < w and fy < h):
            raise SprError(f"S2: Bild {i}: Groesse/Fusspunkt ungueltig")
        im = Img(w, h, fx, fy, rand_ofs=rofs, rand_len=rlen)
        if bool(fl & F_RAND) != bool(rlen):
            raise SprError(f"S2: Bild {i}: RAND-Flag passt nicht zur Randlaenge")
        for j in range(nkk):
            a, dx, dy, kw, kh, ss_ = struct.unpack_from("<HBBBBH", c, kofs + 8 * j)
            if dx + kw > w or dy + kh > h:
                raise SprError(f"S2: Bild {i}: Kern ausserhalb des Bildes")
            im.kerns.append(Kern(a, dx, dy, kw, kh, ss_))
        if vlen:
            if vofs < o_data or vofs + vlen > total:
                raise SprError(f"S2: Bild {i}: VMS-Liste ausserhalb des Datenbereichs")
            im.vms = bytes(c[vofs:vofs + vlen])
        if vram is not None and rlen:
            im.rand = bytes(vram[rofs:rofs + rlen])
        images.append(im)
    tags = []
    for i in range(NT):
        b = c[o_tag + 12 * i:o_tag + 12 * i + 12]
        tags.append(Tag(bytes(b[:8]).rstrip(b"\0").decode("ascii"), b[8], b[9], b[10], b[11]))
    ss = SpriteSet(gid, D, stride, NA, NP, amap, flags, index, images, tags, bytes(vram) if vram is not None else b"")
    ss.u, ss.crc, ss.total, ss.nk = u, crc, total, nk
    return ss


# ---------------------------------------------------------------- Bericht (7)

def vcl_bytes(im):
    return 11 * len(im.kerns) + (7 if im.rand_len else 0)


def build_report(ss, conf, warns, infos, sources, stream, s2len):
    st = vrl.stats(stream)
    rows = []
    for f in range(ss.np):
        for ai in range(ss.na):
            for d in range(1, ss.depth + 1):
                v = ss.index[(f * ss.na + ai) * ss.depth + d - 1]
                r = {"phase": f, "angle": ai, "depth": d, "value": v, "source": sources[(f, ai, d)]}
                if v < NOIMG:
                    im = ss.images[v]
                    r.update(entry=v, w=im.w, h=im.h, foot=[im.fx, im.fy], kerns=len(im.kerns),
                             kern_bytes=sum(k.w * k.h for k in im.kerns), rand=im.rand_len, vms=len(im.vms),
                             vcl=vcl_bytes(im))
                rows.append(r)
    mv = max((len(i.vms) for i in ss.images), default=0)
    mt = max((vcl_bytes(i) + len(i.vms) for i in ss.images), default=0)
    warns = list(warns)
    for i, im in enumerate(ss.images):
        if vcl_bytes(im) + len(im.vms) > VMS_BUFFER_SHARED // 3:
            warns.append(f"Bild {i}: VCL + VMS {vcl_bytes(im) + len(im.vms)} Byte > 1/3 des Puffers ({VMS_BUFFER_SHARED // 3})")
    if s2len >= 4096:
        warns.append(f"S2-Inhalt {s2len} Byte >= 4096 (mehr als die Haelfte des 8-KB-Sprite-Bereichs, P6 2.4)")
    tags = [{"name": t.name, "first": t.first, "count": t.count, "mode": MODE_NAMES[t.mode], "dur": t.dur} for t in ss.tags]
    basic = f"REM {conf['name'].upper()}: " + ", ".join(
        f"{t['name']} {t['first']}-{t['first'] + t['count'] - 1} {t['dur']}J" for t in tags)
    return {"name": conf["name"], "geometry_id": ss.geometry_id, "d": ss.depth, "na": ss.na, "np": ss.np,
            "ni": len(ss.images), "nk": ss.nk, "nt": len(ss.tags), "s2_bytes": s2len, "vram": ss.u,
            "vrl_bytes": st["stream_bytes"], "vrl_ratio": st["ratio"], "max_vms": mv, "max_vcl_vms": mt,
            "buffer": VMS_BUFFER_SHARED, "rows": rows, "tags": tags, "tag_basic": basic if tags else "",
            "warnings": warns, "infos": infos}


def report_md(rp):
    L = [f"# {rp['name']} (Sprite-Satz)", "",
         f"Geometrie-ID {rp['geometry_id']}, NA {rp['na']}, NP {rp['np']}, D {rp['d']}, NI {rp['ni']}, NK {rp['nk']}, NT {rp['nt']}", "",
         f"- S2-Inhalt (Bank 1): {rp['s2_bytes']} Byte", f"- VRAM U: {rp['vram']} Byte",
         (f"- VRL-Strom: {rp['vrl_bytes']} Byte, Verhaeltnis {rp['vrl_ratio']:.3f}" if rp["vrl_ratio"] is not None
          else f"- VRL-Strom: {rp['vrl_bytes']} Byte"),
         f"- Puffer: groesste VMS-Liste {rp['max_vms']}, groesste Summe VCL + VMS {rp['max_vcl_vms']} (gemeinsamer Puffer {rp['buffer']})", "",
         "## Bilder", "", "| Phase | Winkel | Tiefe | Wert | Bild | Quelle | w x h | Fuss | Kerne | Kernbyte | Rand | VMS | VCL |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rp["rows"]:
        if "entry" in r:
            L.append(f"| {r['phase']} | {r['angle']} | {r['depth']} | {r['value']} | {r['entry']} | {r['source']} | {r['w']} x {r['h']} | "
                     f"{r['foot'][0]},{r['foot'][1]} | {r['kerns']} | {r['kern_bytes']} | {r['rand']} | {r['vms']} | {r['vcl']} |")
        else:
            L.append(f"| {r['phase']} | {r['angle']} | {r['depth']} | ${r['value']:02X} |  | {r['source']} |  |  |  |  |  |  |  |")
    if rp["tags"]:
        L += ["", "## Tags", "", "| Name | Phase | Anzahl | Modus | Jiffies |", "|---|---|---|---|---|"]
        L += [f"| {t['name']} | {t['first']} | {t['count']} | {t['mode']} | {t['dur']} |" for t in rp["tags"]]
        L += ["", "```", rp["tag_basic"], "```"]
    if rp["warnings"]:
        L += ["", "## Warnungen", ""] + [f"- {w}" for w in rp["warnings"]]
    if rp["infos"]:
        L += ["", "## Infos", ""] + [f"- {w}" for w in rp["infos"]]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- Vorschau (8)

def preview(ss, geom, vram, d=1, phase=0, a=0, vb=0x4000):
    """Alle Unterpositionen der Zellen (d, s) einer Tiefe, am Fensterrand beschnitten, x4 (PIL-Bild)."""
    from PIL import ImageDraw
    vp = geom["viewport"]
    VW, VH, stride = vp["width_px"] // 2, vp["height"], vp["stride"]
    if vb + len(vram) > 65536:
        raise SprError("Vorschau: VRAM-Daten passen nicht hinter die Vorschau-Basis")
    mem = bytearray(65536)
    mem[vb:vb + len(vram)] = vram
    for r in range(VH):
        for bx in range(VW):
            mem[r * stride + bx] = 0x11 if ((bx // 5) + (r // 8)) & 1 else 0x00
    idx = lookup(ss, phase, a, d)
    marks = []
    for sl in sorted((s for s in geom["slots"] if s["d"] == d), key=lambda s: s["s"]):
        for p in (0, 1, 2, 3, 4):
            ax, ay = sl["anchors_px"][p]
            axb = ax // 2
            marks.append((axb, ay))
            if idx is None:
                continue
            im = ss.images[idx]
            render_image(ss, idx, mem, mem, axb - im.fx, ay - im.fy, vp, vb=vb, clip=(0, VW, 0, VH))
    im = fb_to_image(mem, VW, VH, stride, 0, 4)
    dr = ImageDraw.Draw(im)
    for ax, ay in marks:
        x, y = ax * 8 + 4, ay * 4 + 2
        if 0 <= x < im.width and 0 <= y < im.height:
            dr.line((x - 4, y, x + 4, y), fill=(255, 255, 0))
            dr.line((x, y - 4, x, y + 4), fill=(255, 255, 0))
    return im


# ---------------------------------------------------------------- CLI

def write(path, data):
    dbetex.write(path, data)


def cmd_build(a):
    conf = load_conf(a.toml, a.out, a.strict, a.key)
    ss, warns, infos, sources = build_spriteset(conf)
    s2 = to_s2(ss, conf["load"])
    stream = vrl.encode(list(ss.vram))
    out, name = conf["out"], conf["name"]
    write(os.path.join(out, name + ".s2"), s2)
    write(os.path.join(out, name + ".vrl"), vrl.pack_file(stream, conf["vrl_load"]))
    rp = build_report(ss, conf, warns, infos, sources, stream, len(s2) - 2)
    write(os.path.join(out, name + ".spr.json"), json.dumps(rp, indent=1, ensure_ascii=False) + "\n")
    write(os.path.join(out, name + ".spr.md"), report_md(rp))
    if not a.no_preview:
        geom = load_geom(conf["geom"])
        preview(ss, geom, ss.vram, 1).save(os.path.join(out, name + "_preview.png"))
    print(f"{name}: {ss.na} Winkel, {ss.np} Phasen, {len(ss.images)} Bilder, S2 {len(s2) - 2} Byte, VRAM {ss.u} Byte, "
          f"VRL {rp['vrl_bytes']} Byte, VMS max {rp['max_vms']}")
    for w in rp["warnings"]:
        print("Warnung: " + w, file=sys.stderr)
    return 0


def cmd_dump(a):
    data = dbetex.read_file(a.file)
    vram = None
    if a.vrl:
        _, _, u, stream = vrl.unpack_file(dbetex.read_file(a.vrl))
        vram = bytes(vrl.decode(stream))
    ss = from_s2(data, vram)
    d = {"geometry_id": ss.geometry_id, "d": ss.depth, "na": ss.na, "np": ss.np, "ni": len(ss.images), "nk": ss.nk,
         "nt": len(ss.tags), "flags": ss.flags, "angle_map": ss.angle_map, "u": ss.u, "crc": ss.crc, "stride": ss.stride,
         "length": ss.total, "index": ss.index,
         "images": [{"index": i, "w": im.w, "h": im.h, "foot": [im.fx, im.fy], "kerns": [vars(k) for k in im.kerns],
                     "rand_ofs": im.rand_ofs, "rand_len": im.rand_len, "vms_len": len(im.vms)}
                    for i, im in enumerate(ss.images)],
         "tags": [dict(vars(t), mode=MODE_NAMES[t.mode]) for t in ss.tags]}
    if a.json:
        print(json.dumps(d, indent=1))
        return 0
    print(f"S2 ID {d['geometry_id']} D {d['d']} NA {d['na']} NP {d['np']} NI {d['ni']} NK {d['nk']} NT {d['nt']} "
          f"U {d['u']} CRC {d['crc']:04X} stride {d['stride']} Laenge {d['length']} angle_map {d['angle_map']}")
    for f in range(ss.np):
        for ai in range(ss.na):
            row = ss.index[(f * ss.na + ai) * ss.depth:(f * ss.na + ai + 1) * ss.depth]
            print(f"Phase {f} Winkel {ai}: " + " ".join(f"{v:02X}" for v in row))
    for i in d["images"]:
        print(f"Bild {i['index']}: {i['w']}x{i['h']} fuss {i['foot']} kerne {len(i['kerns'])} rand {i['rand_len']} vms {i['vms_len']}")
    for t in d["tags"]:
        print(f"Tag {t['name']}: Phase {t['first']} x{t['count']} {t['mode']} {t['dur']} Jiffies")
    return 0


def cmd_preview(a):
    data = dbetex.read_file(a.file)
    _, _, u, stream = vrl.unpack_file(dbetex.read_file(a.vrl))
    vram = bytes(vrl.decode(stream))
    ss = from_s2(data, vram)
    geom = load_geom(a.geom)
    if geom["geometry_id"] != ss.geometry_id and ss.geometry_id != 0:
        raise SprError(f"Geometrie-ID {geom['geometry_id']} != {ss.geometry_id} im S2")
    out = a.out or os.path.splitext(a.file)[0] + "_preview.png"
    preview(ss, geom, vram, a.d, a.phase, a.angle).save(out)
    print(f"Vorschau: {out}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Sprite-Saetze (S2) und VRL-Daten erzeugen")
    sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build")
    b.add_argument("toml")
    b.add_argument("--out")
    b.add_argument("--strict", action="store_true")
    b.add_argument("--key")
    b.add_argument("--no-preview", action="store_true")
    d = sp.add_parser("dump")
    d.add_argument("file")
    d.add_argument("--vrl")
    d.add_argument("--json", action="store_true")
    p = sp.add_parser("preview")
    p.add_argument("file")
    p.add_argument("--vrl", required=True)
    p.add_argument("--geom", required=True)
    p.add_argument("--d", type=int, default=1)
    p.add_argument("--phase", type=int, default=0)
    p.add_argument("--angle", type=int, default=0)
    p.add_argument("--out")
    u = sp.add_parser("budget")
    u.add_argument("files", nargs="+")
    u.add_argument("--pool", type=int, required=True)
    u.add_argument("--pool-start", type=dbetex._addr)
    u.add_argument("--vms-buffer", type=int, default=dbetex.VMS_BUFFER)
    u.add_argument("--json", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        return {"build": cmd_build, "dump": cmd_dump, "preview": cmd_preview, "budget": dbetex.cmd_budget}[a.cmd](a)
    except (TexError, ValueError, KeyError, IndexError, struct.error) as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
