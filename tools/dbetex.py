#!/usr/bin/env python3
"""Gemalte Texturen (PNG-Atlas / Aseprite-Export) in DTS, DBG und VRL-Daten umwandeln (P5).

Eingabe: tex.toml (Stile, Geometrie <name>.geom.json aus dbegeom.py) bzw. bg.toml (Tapete),
Spezifikation docs/specs/P5-textures.md.

Ausgabe (Ordner [texset].out):
  <name>.dts          Bank 1: Slotkarte, Stiltabelle, Bildverzeichnis, Kerne, VMS-Listen, Zeilenfuellungen
  <name>.vrl          Bank 0: alle Bilddaten (VRL v1 mit Dateirahmen), danach per RXV an die VRAM-Basis
  <name>.dbg + .vrl   Tapete (bg.toml)
  <name>.tex.json, <name>.tex.md   Bericht (Verzeichnis, Groessen, Warnungen, Budget)
  <name>_<stil>_preview.png  Probebild je Stil (Referenz-Renderer, x4)

Aseprite-Export (Slices = Elementnamen der Malvorlage, Ebene "Maske" nicht mitexportieren):
  aseprite -b zone1.aseprite --layer Bild --sheet zone1.png --data zone1.json \\
           --format json-array --list-slices --list-tags

Aufruf:
  dbetex.py build  TEX.toml [--out DIR] [--strict] [--key RRGGBB] [--alpha-threshold N] [--no-preview]
  dbetex.py bg     BG.toml  [--out DIR] [--strict]
  dbetex.py dump   FILE.dts|FILE.dbg [--vrl FILE.vrl] [--json]
  dbetex.py budget FILE... --pool N [--pool-start ADDR] [--vms-buffer N] [--json]
  dbetex.py check  MAP.dmp|MAP.toml [--walls W.dts] [--floors F.dts] [--ceils C.dts] [--dvg G.dvg]
Exitcode 0 ok, 1 Format-/Validierungsfehler, 2 Aufruf.
"""
import argparse
import binascii
import json
import os
import struct
import sys
import tomllib
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbegeom  # noqa: E402
import dbemem  # noqa: E402
import vrl  # noqa: E402

PALETTE = dbegeom.PALETTE
VMS_BUFFER = 1300
KINDS = {"wall": 0, "floor": 1, "ceiling": 2}
KIND_NAMES = {v: k for k, v in KINDS.items()}
KIND_ARTS = {"wall": ("front", "side"), "floor": ("floor",), "ceiling": ("ceil",)}
BAND_ART = {"wall": None, "floor": "floorband", "ceiling": "ceilband"}
F_DECKEND, F_AUSSCHNITT, F_ZEILEN, F_RAND = 1, 2, 4, 8
HEAD = 32
NOIMG, FALLBACK = 0xFE, 0xFF


class TexError(Exception):
    pass


# ---------------------------------------------------------------- Datentypen

@dataclass
class Kern:
    src: int
    dx: int
    dy: int
    w: int
    h: int
    srcstep: int = 0


@dataclass
class Entry:
    slot: int
    flags: int = 0
    kerns: list = field(default_factory=list)
    rand: bytes = b""
    rand_ofs: int = 0
    vms: bytes = b""
    fill: bytes = b""
    source: int = 0
    style_names: list = field(default_factory=list)
    h: int = 0
    rand_len: int = 0


@dataclass
class TexSet:
    kind: int
    geometry_id: int
    ne: int
    depth: int
    stride: int
    slot_map: list
    styles: list
    entries: list
    vram: bytes = b""


# ---------------------------------------------------------------- Geometrie

def dvg_id(content):
    tmp = bytearray(content)
    tmp[10:12] = b"\0\0"
    tmp[12:14] = b"\0\0"
    return binascii.crc_hqx(bytes(tmp), 0xFFFF) or 1


def load_geom(path, dvg=None):
    try:
        with open(path, encoding="utf-8") as f:
            g = json.load(f)
    except (OSError, ValueError) as e:
        raise TexError(f"{path}: {e}")
    if g.get("format") != "dbegeom" or g.get("version") != 1:
        raise TexError(f"{path}: keine dbegeom-JSON (format/version)")
    if dvg:
        try:
            with open(dvg, "rb") as f:
                data = f.read()
        except OSError as e:
            raise TexError(f"{dvg}: {e}")
        c = data[2:]
        if len(c) < 24 or c[:2] != b"DV" or c[2] != 1:
            raise TexError(f"{dvg}: keine DVG v1")
        stored = struct.unpack_from("<H", c, 12)[0]
        if stored != dvg_id(c):
            raise TexError(f"{dvg}: Geometrie-ID im Kopf passt nicht zum Inhalt")
        if stored != g["geometry_id"]:
            raise TexError(f"{dvg}: Geometrie-ID {stored} != {g['geometry_id']} in {path}")
        if c[7] != len(g["elements"]):
            raise TexError(f"{dvg}: NE {c[7]} != {len(g['elements'])} in {path}")
    return g


def slot_infos(geom, kind):
    """(slots, slot_map): Zeichenplaetze der Art in Slot-Reihenfolge (4.2)."""
    ne = len(geom["elements"])
    D = geom["viewport"]["depth"]
    smap = [FALLBACK] * (ne + 2 * (D + 1))
    slots = []
    arts = KIND_ARTS[kind]
    for e in geom["elements"]:
        if e["art"] in arts:
            smap[e["index"]] = len(slots)
            slots.append({"name": e["name"], "art": e["art"], "d": e["d"], "s": e["s"], "rect": tuple(e["rect"]),
                          "mask": e["mask"], "kernel": tuple(e["kernel"]), "cover": tuple(e["cover"]),
                          "flags": e["flags"], "src_dx": e["src_dx"], "atlas": e["atlas"], "band": False,
                          "partial": "partial" in e["flags"], "pos": e["index"]})
    ba = BAND_ART[kind]
    if ba:
        for b in sorted(geom["band_images"], key=lambda b: b["d"]):
            if b["art"] == ba:
                pos = ne + b["d"] if ba == "ceilband" else ne + (D + 1) + b["d"]
                smap[pos] = len(slots)
                w, h = b["rect"][2], b["rect"][3]
                slots.append({"name": b["name"], "art": ba, "d": b["d"], "s": 0, "rect": tuple(b["rect"]),
                              "mask": ["#" * w] * h, "kernel": (0, 0, w, h), "cover": (0, 0), "flags": [],
                              "src_dx": 0, "atlas": b["atlas"], "band": True, "partial": False, "pos": pos})
    return slots, smap


# ---------------------------------------------------------------- Pixel

def read_rgba(path):
    from PIL import Image
    try:
        im = Image.open(path)
        im.load()
        return im.convert("RGBA")
    except OSError as e:
        raise TexError(f"{path}: {e}")


def parse_key(k):
    if k is None or k == "":
        return None
    if isinstance(k, tuple):
        return k
    k = str(k).strip().lstrip("#")
    try:
        v = int(k, 16)
    except ValueError:
        raise TexError(f"key: ungueltige Farbe {k!r}")
    return (v >> 16 & 255, v >> 8 & 255, v & 255)


_pal_cache = {}


def nearest(rgb):
    r = _pal_cache.get(rgb)
    if r is None:
        best = None
        for i, p in enumerate(PALETTE):
            d = sum((a - b) ** 2 for a, b in zip(rgb, p))
            if best is None or d < best[0]:
                best = (d, i)
        r = _pal_cache[rgb] = (best[1], best[0])
    return r


def to_indices(img, box, key=None, alpha_threshold=0, strict=False):
    """Ausschnitt box = (x, y, breite_px, hoehe) -> (Zeilen aus int | None, Warnungen)."""
    x0, y0, bw, bh = box
    if x0 < 0 or y0 < 0 or x0 + bw > img.width or y0 + bh > img.height:
        raise TexError(f"Ausschnitt ({x0}, {y0}, {bw}x{bh}) liegt ausserhalb des Bildes {img.width}x{img.height}")
    key = parse_key(key)
    px = img.load()
    rows = []
    half = []
    off = []
    for r in range(bh):
        line = []
        for c in range(bw):
            R, G, B, A = px[x0 + c, y0 + r]
            if key is not None and (R, G, B) == key:
                line.append(None)
                continue
            if alpha_threshold:
                if A < alpha_threshold:
                    line.append(None)
                    continue
            elif A == 0:
                line.append(None)
                continue
            elif A != 255:
                half.append((c, r))
                line.append(None)
                continue
            idx, dist = nearest((R, G, B))
            if dist:
                off.append((dist, c, r))
            line.append(idx)
        rows.append(line)
    if half:
        raise TexError(f"{len(half)} Pixel mit Halbtransparenz, erste bei {half[0]} - Halbtransparenz: "
                       "Masken-Ebene der Vorlage mitexportiert? Aseprite: --layer Bild")
    warns = []
    if off:
        mx = max(off)
        first = min(off, key=lambda t: (t[2], t[1]))
        msg = (f"{len(off)} Pixel nicht in der VDC-Palette, max. Abstand {round(mx[0] ** 0.5)} bei "
               f"({mx[1]}, {mx[2]}), erstes bei ({first[1]}, {first[2]})")
        if strict:
            raise TexError(msg)
        warns.append(msg)
    return rows, warns


def mask_allows(ch, side):
    return ch == "#" or (ch == "L" and side == 0) or (ch == "R" and side == 1)


def apply_mask(pix, mask):
    """Pixel ausserhalb der Maske transparent; liefert (pix, anzahl verworfener deckender Pixel)."""
    out, n = [], 0
    for r, row in enumerate(pix):
        line = []
        for c, v in enumerate(row):
            if v is not None and not mask_allows(mask[r][c // 2], c & 1):
                n += 1
                v = None
            line.append(v)
        out.append(line)
    return out, n


def classify(pix, mask=None):
    """Byte-Zustaende 'F' voll, 'L' nur links, 'R' nur rechts, '.' leer (2.4)."""
    if mask is not None:
        pix, _ = apply_mask(pix, mask)
    states = []
    for row in pix:
        line = []
        for bx in range(len(row) // 2):
            a, b = row[2 * bx] is not None, row[2 * bx + 1] is not None
            line.append("F" if a and b else "L" if a else "R" if b else ".")
        states.append(line)
    return states


def resolve_alpha_conflict(pix, states):
    """Sind alle 16 Farben in halb-R-Bytes belegt: halb-R-Bytes der seltensten Farbe werden voll (2.4).
    Aendert pix/states in place; liefert Anzahl ersetzter Bytes."""
    cnt = {}
    for r, row in enumerate(states):
        for bx, st in enumerate(row):
            if st == "R":
                c = pix[r][2 * bx + 1]
                cnt[c] = cnt.get(c, 0) + 1
    if len(cnt) < 16:
        return 0
    col = min(cnt, key=lambda c: (cnt[c], c))
    n = 0
    for r, row in enumerate(states):
        for bx, st in enumerate(row):
            if st == "R" and pix[r][2 * bx + 1] == col:
                pix[r][2 * bx] = col
                row[bx] = "F"
                n += 1
    return n


def choose_kerns(states, max_kerns, kern_min):
    """Bis zu max_kerns disjunkte Rechtecke (kx, ky, kw, kh) aus vollen Bytes (5.4)."""
    h = len(states)
    w = len(states[0]) if h else 0
    free = [[st == "F" for st in row] for row in states]
    kerns = []
    while len(kerns) < max_kerns:
        rows = [sum(1 << i for i, v in enumerate(r) if v) for r in free]
        b = dbegeom.best_rect(rows, w)
        if not b:
            break
        kx, ky, kw, kh = b
        if kerns and not (kh >= 2 and kw * kh >= kern_min):
            break
        kerns.append(b)
        for r in range(ky, ky + kh):
            for c in range(kx, kx + kw):
                free[r][c] = False
    return kerns


def in_kern(kerns, bx, r):
    return any(kx <= bx < kx + kw and ky <= r < ky + kh for kx, ky, kw, kh in kerns)


def check_vms(vms, w, h, stride, what="VMS-Liste"):
    """Formatregeln der gespeicherten Listen (P5b 4.6; VIEW setzt sie beim Beschneiden voraus, P6e-opt): nur Typ 1/8,
    Laenge passt zur Anzahl, ofs = Zeile * stride + Spalte mit Zeile < h, Spalte + len <= w <= stride, Befehle in
    ofs-Reihenfolge ohne Ueberlappung (ofs >= Ende des vorigen). TexError bei Verstoss."""
    if w > stride:
        raise TexError(f"{what}: Breite {w} > stride {stride}")
    if len(vms) < 3:
        raise TexError(f"{what}: kuerzer als der Kopf")
    n, p, end = vms[1] | vms[2] << 8, 3, 0
    for _ in range(n):
        if p + 3 > len(vms) or vms[p] not in (1, 8) or (vms[p] == 1 and p + 4 > len(vms)):
            raise TexError(f"{what}: Befehl bei {p} ungueltig (nur Typ 1/8) oder Liste zu kurz")
        ofs = vms[p + 1] | vms[p + 2] << 8
        ln = vms[p + 3] if vms[p] == 1 else 1
        r, col = divmod(ofs, stride)
        if ofs < end or r >= h or ln == 0 or col + ln > w:
            raise TexError(f"{what}: Befehl bei {p} verletzt die Formatregeln (Reihenfolge, Zeile, Spalte + Laenge)")
        end = ofs + ln
        p += 4 if vms[p] == 1 else 3
    if p != len(vms):
        raise TexError(f"{what}: Laenge passt nicht zur Befehlsanzahl")


def pack_image(pix, states, kerns, stride):
    """(alpha, rand, vms): gepackte Randbytes und VMS-Liste (5.2); alpha nach 2.4."""
    h = len(states)
    w = len(states[0]) if h else 0
    used = set()
    for r in range(h):
        for bx in range(w):
            if states[r][bx] == "R" and not in_kern(kerns, bx, r):
                used.add(pix[r][2 * bx + 1])
    alpha = next(a for a in range(17) if a not in used)
    if alpha > 15:
        raise TexError("interner Fehler: alle 16 Farben in halb-R-Bytes (resolve_alpha_conflict vergessen)")
    rand = bytearray()
    cmds = bytearray()
    ncmd = 0
    for r in range(h):
        bx = 0
        while bx < w:
            st = states[r][bx]
            if st == "." or in_kern(kerns, bx, r):
                bx += 1
                continue
            ofs = r * stride + bx
            if st == "F":
                j = bx
                while j < w and states[r][j] == "F" and not in_kern(kerns, j, r) and j - bx < 255:
                    rand.append(pix[r][2 * j] << 4 | pix[r][2 * j + 1])
                    j += 1
                cmds += bytes((1, ofs & 255, ofs >> 8, j - bx))
                ncmd += 1
                bx = j
            else:
                if st == "L":
                    rand.append(pix[r][2 * bx] << 4 | alpha)
                else:
                    rand.append(pix[r][2 * bx + 1])
                cmds += bytes((8, ofs & 255, ofs >> 8))
                ncmd += 1
                bx += 1
    if not ncmd:
        return 0, b"", b""
    return alpha, bytes(rand), bytes((alpha, ncmd & 255, ncmd >> 8)) + bytes(cmds)


def kern_bytes(pix, kerns):
    out = bytearray()
    for kx, ky, kw, kh in kerns:
        for r in range(ky, ky + kh):
            for bx in range(kx, kx + kw):
                out.append(pix[r][2 * bx] << 4 | pix[r][2 * bx + 1])
    return bytes(out)


def is_deckend(slot, states, geom):
    c0, c1 = slot["cover"]
    if "cover" not in slot["flags"] or c1 <= c0:
        return False
    pl = geom["planes"][slot["d"] + 1]
    VH = geom["viewport"]["height"]
    r0, r1 = max(pl["T"], 0), min(pl["B"], VH)
    x, y, w, h = slot["rect"]
    for r in range(r0, r1):
        if not y <= r < y + h:
            return False
        for c in range(c0, c1):
            if states[r - y][c - x] != "F":
                return False
    return True


# ---------------------------------------------------------------- Quellen

class PngSource:
    def __init__(self, path, geom, key, alpha_threshold):
        self.path = path
        self.img = read_rgba(path)
        self.key, self.thr = key, alpha_threshold
        aw, ah = geom["atlas_size"]
        if self.img.width < aw or self.img.height < ah:
            raise TexError(f"{path}: Atlas {self.img.width}x{self.img.height} kleiner als {aw}x{ah}")

    def box(self, slot, warns):
        if not slot["atlas"]:
            return None
        x, y = slot["atlas"]
        return (x, y, slot["rect"][2] * 2, slot["rect"][3])


class AseSource:
    def __init__(self, path, geom, tag, frame, key, alpha_threshold):
        self.path = path
        self.key, self.thr = key, alpha_threshold
        try:
            with open(path, encoding="utf-8") as f:
                js = json.load(f)
        except (OSError, ValueError) as e:
            raise TexError(f"{path}: {e}")
        meta = js.get("meta") or {}
        if "image" not in meta:
            raise TexError(f"{path}: meta.image fehlt")
        self.img = read_rgba(os.path.join(os.path.dirname(path), meta["image"]))
        fr = js.get("frames")
        if isinstance(fr, dict):
            fr = list(fr.values())
        if not isinstance(fr, list) or not fr:
            raise TexError(f"{path}: keine Frames")
        for i, f in enumerate(fr):
            if f.get("rotated") or f.get("trimmed"):
                raise TexError(f"{path}: Frame {i} ist rotated/trimmed - ohne --trim/--sheet-pack-Rotation exportieren")
        self.warn = []
        if tag is not None:
            tg = [t for t in meta.get("frameTags", []) if t.get("name") == tag]
            if not tg:
                raise TexError(f"{path}: Tag {tag!r} nicht gefunden")
            if tg[0]["to"] != tg[0]["from"]:
                self.warn.append(f"{path}: Tag {tag!r} ueber mehrere Frames, der erste gilt")
            frame = tg[0]["from"]
        frame = frame or 0
        if not 0 <= frame < len(fr):
            raise TexError(f"{path}: Frame {frame} nicht vorhanden")
        fx, fy = fr[frame]["frame"]["x"], fr[frame]["frame"]["y"]
        self.slices = {}
        for sl in meta.get("slices", []):
            name = sl["name"]
            if name in self.slices:
                raise TexError(f"{path}: Slice {name!r} doppelt")
            best = None
            for k in sl.get("keys", []):
                if k["frame"] <= frame and (best is None or k["frame"] >= best["frame"]):
                    best = k
            if best is not None:
                b = best["bounds"]
                self.slices[name] = (fx + b["x"], fy + b["y"], b["w"], b["h"])
        known = {e["name"] for e in geom["elements"]} | {b["name"] for b in geom["band_images"]}
        for n in self.slices:
            if n not in known:
                self.warn.append(f"{path}: Slice {n!r} unbekannt")

    def box(self, slot, warns):
        b = self.slices.get(slot["name"])
        if b is None:
            return None
        w2, h = slot["rect"][2] * 2, slot["rect"][3]
        if (b[2], b[3]) != (w2, h):
            raise TexError(f"{self.path}: Slice {slot['name']}: Groesse {b[2]}x{b[3]}, erwartet {w2}x{h}")
        return (b[0], b[1], w2, h)


def is_template(img, box, slot):
    x0, y0, bw, bh = box
    kx, ky, kw, kh = slot["kernel"]
    px = img.load()
    for r in range(bh):
        for c in range(bw):
            R, G, B, A = px[x0 + c, y0 + r]
            if mask_allows(slot["mask"][r][c // 2], c & 1):
                p = PALETTE[1] if kx <= c // 2 < kx + kw and ky <= r < ky + kh else PALETTE[14]
                if (R, G, B, A) != (*p, 255):
                    return False
            elif A != 0:
                return False
    return True


# ---------------------------------------------------------------- Konfiguration

TEXSET_KEYS = {"name", "kind", "geom", "dvg", "out", "load", "vrl_load", "pool_bytes", "max_kerns", "kern_min",
               "fill_rows", "key", "alpha_threshold"}
STYLE_KEYS = {"name", "png", "aseprite", "tag", "frame", "empty"}


def _check_keys(where, d, allowed):
    for k in d:
        if k not in allowed:
            raise TexError(f"{where}: unbekannter Schluessel {k!r}")


def _toml(path):
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except OSError as e:
        raise TexError(f"{path}: {e}")
    except tomllib.TOMLDecodeError as e:
        raise TexError(f"{path}: TOML: {e}")


def _int(where, v, lo, hi):
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise TexError(f"{where}: Ganzzahl {lo} ... {hi} erwartet, gefunden {v!r}")
    return v


def load_tex_conf(path, out=None, strict=False, key=None, alpha_threshold=None):
    cfg = _toml(path)
    base = os.path.dirname(os.path.abspath(path))
    _check_keys(path, cfg, {"format", "version", "texset", "style"})
    if cfg.get("format") != "dbetex" or cfg.get("version") != 1:
        raise TexError(f'{path}: format = "dbetex" und version = 1 erwartet')
    ts = dict(cfg.get("texset") or {})
    _check_keys(f"{path} [texset]", ts, TEXSET_KEYS)
    for k in ("name", "kind", "geom"):
        if k not in ts:
            raise TexError(f"{path} [texset]: {k} fehlt")
    if ts["kind"] not in KINDS:
        raise TexError(f"{path} [texset] kind: wall, floor oder ceiling erwartet")
    c = {
        "name": str(ts["name"]), "kind": ts["kind"], "geom": os.path.join(base, ts["geom"]),
        "dvg": os.path.join(base, ts["dvg"]) if ts.get("dvg") else None,
        "out": out or os.path.join(base, ts.get("out", ".")),
        "load": _int("load", ts.get("load", dbemem.default_load(ts["kind"])), 0, 0xFFFF),
        "vrl_load": _int("vrl_load", ts.get("vrl_load", 0x4000), 0, 0xFFFF),
        "pool_bytes": _int("pool_bytes", ts.get("pool_bytes", 26624), 0, 1 << 24),
        "max_kerns": _int("max_kerns", ts.get("max_kerns", 4), 0, 4),
        "kern_min": _int("kern_min", ts.get("kern_min", 16), 1, 65535),
        "fill_rows": bool(ts.get("fill_rows", True)),
        "key": key if key is not None else ts.get("key"),
        "alpha_threshold": _int("alpha_threshold", alpha_threshold if alpha_threshold is not None
                                else ts.get("alpha_threshold", 0), 0, 255),
        "strict": strict,
    }
    styles = cfg.get("style") or []
    if not 1 <= len(styles) <= 32:
        raise TexError(f"{path}: 1 ... 32 Stile erwartet, gefunden {len(styles)}")
    names = set()
    c["styles"] = []
    for i, st in enumerate(styles):
        where = f"{path} [[style]] {i}"
        _check_keys(where, st, STYLE_KEYS)
        if "name" not in st:
            raise TexError(f"{where}: name fehlt")
        if st["name"] in names:
            raise TexError(f"{where}: Name {st['name']!r} doppelt")
        names.add(st["name"])
        if ("png" in st) == ("aseprite" in st):
            raise TexError(f"{where}: genau eine Quelle (png oder aseprite) erwartet")
        s = {"name": st["name"], "empty": list(st.get("empty", [])), "tag": st.get("tag"),
             "frame": st.get("frame")}
        if "png" in st:
            s["png"] = os.path.join(base, st["png"])
        else:
            s["aseprite"] = os.path.join(base, st["aseprite"])
        c["styles"].append(s)
    return c


# ---------------------------------------------------------------- Aufbau des Texturset

class _Builder:
    def __init__(self, conf, geom, slots, smap):
        self.conf, self.geom, self.slots, self.smap = conf, geom, slots, smap
        self.entries, self.keys = [], {}
        self.vram = bytearray()
        self.warns, self.infos = [], []
        self.stride = geom["viewport"]["stride"]
        self.prep = {}      # (stil, slot) -> (pix, states, entry index)

    def add_entry(self, key, e):
        if key in self.keys:
            return self.keys[key], True
        self.entries.append(e)
        self.keys[key] = len(self.entries) - 1
        return len(self.entries) - 1, False

    def image_entry(self, si, pix, mask, stylename):
        slot = self.slots[si]
        w, h = slot["rect"][2], slot["rect"][3]
        pix, disc = apply_mask(pix, mask)
        if disc:
            self.warns.append(f"{stylename}/{slot['name']}: {disc} Pixel ausserhalb der Maske, uebermalt, abgeschnitten")
        states = classify(pix)
        if all(st == "." for row in states for st in row):
            return None
        n = resolve_alpha_conflict(pix, states)
        if n:
            self.warns.append(f"{stylename}/{slot['name']}: alle 16 Farben in halb-R-Bytes, {n} Bytes voll gemacht")
        key = (si, tuple(tuple(r) for r in pix))
        if key in self.keys:
            idx = self.keys[key]
            self.entries[idx].style_names.append(stylename)
            self.prep[(stylename, si)] = (pix, states, idx)
            return idx
        e = Entry(slot=si, h=h, style_names=[stylename])
        deck = is_deckend(slot, states, self.geom)
        # Zeilenfuellung
        if slot["band"] and self.conf["fill_rows"]:
            fills = []
            ok = True
            for r, row in enumerate(states):
                if any(st != "F" for st in row):
                    ok = False
                    break
                bs = {pix[r][2 * bx] << 4 | pix[r][2 * bx + 1] for bx in range(w)}
                if len(bs) != 1:
                    ok = False
                    break
                fills.append(bs.pop())
            if ok:
                e.flags, e.fill = F_ZEILEN, bytes(fills)
                self.entries.append(e)
                self.keys[key] = idx = len(self.entries) - 1
                e.source = idx
                self.prep[(stylename, si)] = (pix, states, idx)
                return idx
        kerns = choose_kerns(states, self.conf["max_kerns"], self.conf["kern_min"])
        alpha, rand, vms = pack_image(pix, states, kerns, self.stride)
        ofs = len(self.vram)
        for (kx, ky, kw, kh) in kerns:
            e.kerns.append(Kern(len(self.vram), kx, ky, kw, kh, 0))
            self.vram += kern_bytes(pix, [(kx, ky, kw, kh)])
        e.rand_ofs, e.rand, e.rand_len, e.vms = len(self.vram), rand, len(rand), vms
        self.vram += rand
        if not rand:
            e.rand_ofs = 0
        else:
            e.flags |= F_RAND
        if deck:
            e.flags |= F_DECKEND
        self.entries.append(e)
        idx = self.keys[key] = len(self.entries) - 1
        e.source = idx
        self.prep[(stylename, si)] = (pix, states, idx)
        return idx

    def partial_entry(self, si, fsi, stylename):
        """Ausschnitt der Vollfront (fsi) fuer Teilfront si (5.3)."""
        slot, fslot = self.slots[si], self.slots[fsi]
        fpix, fstates, fidx = self.prep[(stylename, fsi)]
        fe = self.entries[fidx]
        key = (si, "part", fidx)
        if key in self.keys:
            idx = self.keys[key]
            self.entries[idx].style_names.append(stylename)
            return idx
        x, y, w, h = slot["rect"]
        fx, fy, fw, fh = fslot["rect"]
        sdx, ry = slot["src_dx"], y - fy
        if sdx < 0 or sdx + w > fw or ry < 0 or ry + h > fh:
            raise TexError(f"{slot['name']}: Teilfront liegt nicht im Bild der Vollfront")
        cpix = [row[2 * sdx:2 * (sdx + w)] for row in fpix[ry:ry + h]]
        cpix, _ = apply_mask(cpix, slot["mask"])
        cstates = classify(cpix)
        e = Entry(slot=si, flags=F_AUSSCHNITT, h=h, style_names=[stylename], source=fidx)
        lk = []
        for k in fe.kerns:
            a, b = max(k.dx, sdx), min(k.dx + k.w, sdx + w)
            r0, r1 = max(k.dy, ry), min(k.dy + k.h, ry + h)
            if a >= b or r0 >= r1:
                continue
            for r in range(r0 - ry, r1 - ry):
                for c in range(a - sdx, b - sdx):
                    if cstates[r][c] != "F":
                        raise TexError(f"{slot['name']}: Kern der Vollfront liegt nicht voll in der Teilfront")
            lk.append((a - sdx, r0 - ry, b - a, r1 - r0))
            e.kerns.append(Kern(k.src + (r0 - k.dy) * k.w + (a - k.dx), a - sdx, r0 - ry, b - a, r1 - r0, k.w))
        alpha, rand, vms = pack_image(cpix, cstates, lk, self.stride)
        if rand:
            e.rand_ofs, e.rand, e.rand_len, e.vms = len(self.vram), rand, len(rand), vms
            e.flags |= F_RAND
            self.vram += rand
        if is_deckend(slot, cstates, self.geom):
            e.flags |= F_DECKEND
        self.entries.append(e)
        idx = self.keys[key] = len(self.entries) - 1
        return idx


def build_texset(conf):
    """-> (TexSet, Warnungen, Infos); conf wie load_tex_conf."""
    geom = load_geom(conf["geom"], conf.get("dvg"))
    kind = conf["kind"]
    slots, smap = slot_infos(geom, kind)
    if not slots:
        raise TexError(f"Geometrie hat keine Zeichenplaetze der Art {kind}")
    b = _Builder(conf, geom, slots, smap)
    key = conf.get("key")
    thr = conf["alpha_threshold"]
    names = {s["name"]: i for i, s in enumerate(slots)}
    styles = []
    for st in conf["styles"]:
        sn = st["name"]
        for en in st["empty"]:
            if en not in names:
                raise TexError(f"Stil {sn}: empty: {en!r} ist kein Zeichenplatz der Art {kind}")
        if "png" in st:
            src = PngSource(st["png"], geom, key, thr)
        else:
            src = AseSource(st["aseprite"], geom, st["tag"], st["frame"], key, thr)
            b.warns += src.warn
        vals = [None] * len(slots)
        # nicht abgeleitete Bilder zuerst
        for si, slot in enumerate(slots):
            if slot["partial"]:
                continue
            if slot["name"] in st["empty"]:
                vals[si] = NOIMG
                continue
            box = src.box(slot, b.warns)
            if box is None:
                continue
            pix, w = to_indices(src.img, box, key, thr, conf["strict"])
            b.warns += [f"{sn}/{slot['name']}: {m}" for m in w]
            if "png" in st and is_template(src.img, box, slot):
                b.infos.append(f"{sn}/{slot['name']}: nicht bemalt")
                continue
            idx = b.image_entry(si, pix, slot["mask"], sn)
            if idx is None:
                b.infos.append(f"{sn}/{slot['name']}: nicht bemalt (leer)")
                continue
            vals[si] = idx
        for si, slot in enumerate(slots):
            if not slot["partial"]:
                continue
            fsi = names.get(f"front_d{slot['d']}_s+0")
            if slot["name"] in st["empty"]:
                vals[si] = NOIMG
            elif fsi is not None and vals[fsi] is not None and vals[fsi] < NOIMG:
                vals[si] = b.partial_entry(si, fsi, sn)
            elif fsi is not None and vals[fsi] == NOIMG:
                vals[si] = NOIMG
        styles.append(vals)
    # Stiltabelle: fehlend -> $FF (Stil >= 1) / $FE (Stil 0)
    for sti, vals in enumerate(styles):
        for si, v in enumerate(vals):
            if v is None:
                if sti == 0:
                    vals[si] = NOIMG
                    if not slots[si]["partial"]:
                        b.warns.append(f"Stil 0 ohne Bild fuer {slots[si]['name']}")
                else:
                    vals[si] = FALLBACK
    if len(b.entries) > 254:
        raise TexError(f"zu viele Bilder: {len(b.entries)} > 254 - Stile auf zwei DTS verteilen")
    if len(b.vram) > 65535:
        raise TexError(f"VRAM-Daten {len(b.vram)} > 65535 Byte")
    nk = sum(len(e.kerns) for e in b.entries)
    if nk > 255:
        raise TexError(f"zu viele Kerne: {nk} > 255")
    vp = geom["viewport"]
    ts = TexSet(KINDS[kind], geom["geometry_id"], len(geom["elements"]), vp["depth"], vp["stride"], smap,
                styles, b.entries, bytes(b.vram))
    ts.slots = slots
    ts.ns, ts.nk, ts.u = len(slots), nk, len(b.vram)
    ts.crc, ts.total = binascii.crc_hqx(bytes(b.vram), 0xFFFF), 0
    ts.style_names = [s["name"] for s in conf["styles"]]
    return ts, b.warns, b.infos


# ---------------------------------------------------------------- DTS

def to_dts(ts, load=None):
    if load is None:
        load = dbemem.default_load(KIND_NAMES[ts.kind])
    ne, D = ts.ne, ts.depth
    ns = sum(1 for v in ts.slot_map if v != FALLBACK)
    nst, ni = len(ts.styles), len(ts.entries)
    nk = sum(len(e.kerns) for e in ts.entries)
    o_slot = HEAD
    o_style = o_slot + len(ts.slot_map)
    o_dir = o_style + nst * ns
    o_kern = o_dir + 16 * ni
    o_data = o_kern + 8 * nk
    data = bytearray()
    dirs, kerns = bytearray(), bytearray()
    kpos = o_kern
    for i, e in enumerate(ts.entries):
        kofs = 0
        if e.kerns:
            kofs = kpos
            for k in e.kerns:
                kerns += struct.pack("<HBBBBH", k.src, k.dx, k.dy, k.w, k.h, k.srcstep)
            kpos += 8 * len(e.kerns)
        vofs = vlen = 0
        if e.fill:
            kofs = o_data + len(data)
            data += e.fill
        if e.vms:
            vofs, vlen = o_data + len(data), len(e.vms)
            data += e.vms
        dirs += struct.pack("<BBBBHHHHHBB", e.flags, e.slot, len(e.kerns), len(e.fill) if e.fill else e.h, kofs,
                            e.rand_ofs, e.rand_len, vofs, vlen, e.source if e.flags & F_AUSSCHNITT else i, 0)
    total = o_data + len(data)
    if total > 65535:
        raise TexError(f"DTS-Inhalt {total} > 65535 Byte")
    head = bytearray(HEAD)
    head[0:3] = b"DT\x01"
    head[3] = ts.kind
    struct.pack_into("<H", head, 4, ts.geometry_id)
    head[6], head[7], head[8], head[9], head[10], head[11] = ne, D, ns, nst, ni, nk
    struct.pack_into("<HHHHHH", head, 12, o_slot, o_style, o_dir, o_kern, o_data, total)
    struct.pack_into("<HHH", head, 24, len(ts.vram), binascii.crc_hqx(ts.vram, 0xFFFF), ts.stride)
    out = bytearray(head)
    out += bytes(ts.slot_map)
    for vals in ts.styles:
        out += bytes(vals)
    out += dirs + kerns + data
    assert len(out) == total
    return struct.pack("<H", load) + bytes(out)


def from_dts(data, vram=None):
    """DTS-PRG -> TexSet (vram optional; ohne bleiben die Randbytes leer). TexError bei Formatfehlern."""
    if len(data) < 2 + HEAD:
        raise TexError("DTS: Datei kuerzer als der Kopf")
    c = data[2:]
    if c[0:2] != b"DT":
        raise TexError("DTS: falsches Magic (erwartet 'DT')")
    if c[2] != 1:
        raise TexError(f"DTS: Version {c[2]} nicht unterstuetzt")
    kind, gid, ne, D, ns, nst, ni, nk = c[3], *struct.unpack_from("<H", c, 4), c[6], c[7], c[8], c[9], c[10], c[11]
    o_slot, o_style, o_dir, o_kern, o_data, total = struct.unpack_from("<HHHHHH", c, 12)
    u, crc, stride = struct.unpack_from("<HHH", c, 24)
    nsm = ne + 2 * (D + 1)
    if kind > 2:
        raise TexError(f"DTS: Art {kind} ungueltig")
    exp = (HEAD, HEAD + nsm, HEAD + nsm + nst * ns, HEAD + nsm + nst * ns + 16 * ni,
           HEAD + nsm + nst * ns + 16 * ni + 8 * nk)
    if (o_slot, o_style, o_dir, o_kern, o_data) != exp:
        raise TexError("DTS: Offsets im Kopf passen nicht zu den Anzahlen (Bereiche nicht lueckenlos)")
    if len(c) < total or total < o_data:
        raise TexError(f"DTS: Datei zu kurz ({len(c)} < {total})")
    smap = list(c[o_slot:o_slot + nsm])
    styles = [list(c[o_style + i * ns:o_style + (i + 1) * ns]) for i in range(nst)]
    for i, vals in enumerate(styles):
        for v in vals:
            if v < NOIMG and v >= ni:
                raise TexError(f"DTS: Stil {i} verweist auf Bild {v} >= NI {ni}")
        if i == 0 and FALLBACK in vals:
            raise TexError("DTS: $FF in Stil 0")
    entries, kp = [], 0
    for i in range(ni):
        fl, slot, nkk, h, kofs, rofs, rlen, vofs, vlen, src, _ = struct.unpack_from("<BBBBHHHHHBB", c, o_dir + 16 * i)
        e = Entry(slot=slot, flags=fl, h=h, rand_ofs=rofs, rand_len=rlen, source=src)
        if fl & F_ZEILEN:
            e.fill = bytes(c[kofs:kofs + h])
        else:
            for j in range(nkk):
                a, dx, dy, w, hh, ss = struct.unpack_from("<HBBBBH", c, kofs + 8 * j)
                e.kerns.append(Kern(a, dx, dy, w, hh, ss))
        if vlen:
            e.vms = bytes(c[vofs:vofs + vlen])
            check_vms(e.vms, stride, h, stride, f"DTS: Bild {i}")
        if vram is not None and rlen:
            e.rand = bytes(vram[rofs:rofs + rlen])
        entries.append(e)
    ts = TexSet(kind, gid, ne, D, stride, smap, styles, entries, bytes(vram) if vram is not None else b"")
    ts.u, ts.crc, ts.total, ts.ns, ts.nk = u, crc, total, ns, nk
    return ts


# ---------------------------------------------------------------- Simulatoren (VDC-BASIC VMC / VMF / VMS)

def sim_vmc(vram, src, dst, count, reps=1, dststep=0, srcstep=0, fb=None):
    """Kopiert reps Zeilen zu je count Byte; srcstep 0 = Quelle fortlaufend."""
    fb = vram if fb is None else fb
    for r in range(reps):
        s = (src + r * (srcstep or count)) & 0xFFFF
        d = (dst + r * dststep) & 0xFFFF
        for i in range(count):
            fb[(d + i) & 0xFFFF] = vram[(s + i) & 0xFFFF]


def sim_vmf(vram, dst, byte, count):
    for i in range(count):
        vram[(dst + i) & 0xFFFF] = byte


def sim_vms(vram, src, dst, vms_list, fb=None):
    """VMS-Liste nach vms-format.md (Typ 1, 8 und 3 = source skip)."""
    fb = vram if fb is None else fb
    if len(vms_list) < 3:
        raise TexError("VMS-Liste kuerzer als der Kopf")
    alpha = vms_list[0]
    n = vms_list[1] | vms_list[2] << 8
    p, rd = 3, src
    for _ in range(n):
        t = vms_list[p]
        ofs = vms_list[p + 1] | vms_list[p + 2] << 8
        if t == 1:
            ln = vms_list[p + 3]
            p += 4
            for i in range(ln):
                fb[(dst + ofs + i) & 0xFFFF] = vram[(rd + i) & 0xFFFF]
            rd += ln
        elif t == 3:
            p += 3
            rd = (rd + ofs) & 0xFFFF
        elif t == 8:
            p += 3
            b = vram[rd & 0xFFFF]
            rd += 1
            a = (dst + ofs) & 0xFFFF
            if (b & 15) == alpha:
                fb[a] = (b & 0xF0) | (fb[a] & 15)
            else:
                fb[a] = (fb[a] & 0xF0) | (b & 15)
        else:
            raise TexError(f"VMS: ungueltiger Befehl {t}")


# ---------------------------------------------------------------- Referenz-Renderer

def render(ts, style, slot, vram, fb, ap=0, origin=0, stride=None, vb=0, geom=None, t0=None):
    """Zeichnet Eintrag (style, slot) nach 4.4; $FF -> Stil 0, $FE -> nichts. vb = VRAM-Basis der Daten."""
    stride = stride or ts.stride
    v = ts.styles[style][slot]
    if v == FALLBACK:
        v = ts.styles[0][slot]
    if v >= NOIMG:
        return False
    e = ts.entries[v]
    slots = ts.slots if hasattr(ts, "slots") else slot_infos(geom, KIND_NAMES[ts.kind])[0]
    if t0 is None:
        x, y = slots[slot]["rect"][:2]
        t0 = ap + origin + y * stride + x
    if e.flags & F_ZEILEN:
        w = slots[slot]["rect"][2]
        for i, b in enumerate(e.fill):
            sim_vmf(fb, t0 + i * stride, b, w)
        return True
    for k in e.kerns:
        sim_vmc(vram, vb + k.src, t0 + k.dy * stride + k.dx, k.w, k.h, stride, k.srcstep, fb=fb)
    if e.flags & F_RAND:
        sim_vms(vram, vb + e.rand_ofs, t0, e.vms, fb=fb)
    return True


def fb_to_image(fb, vw, h, stride, base=0, zoom=1):
    from PIL import Image
    im = Image.new("RGB", (vw * 2, h), (0, 0, 0))
    px = im.load()
    for r in range(h):
        for bx in range(vw):
            b = fb[(base + r * stride + bx) & 0xFFFF]
            px[2 * bx, r] = PALETTE[b >> 4]
            px[2 * bx + 1, r] = PALETTE[b & 15]
    if zoom > 1:
        im = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
    return im


def preview(ts, geom, style, vb=0x4000):
    """Probebild eines Stils (7.3) als PIL-Bild."""
    vp = geom["viewport"]
    vw, h, stride = vp["width_px"] // 2, vp["height"], vp["stride"]
    mem = bytearray(65536)
    if vb + len(ts.vram) > 65536:
        raise TexError("Vorschau: VRAM-Daten passen nicht hinter die Vorschau-Basis")
    mem[vb:vb + len(ts.vram)] = ts.vram
    slots = ts.slots
    D = ts.depth
    order = []
    if ts.kind == 0:
        # Maleralgorithmus: Seite d liegt zwischen den Ebenen d und d + 1, also hinter der Front d
        for d in range(D, -1, -1):
            order += [i for i, s in enumerate(slots) if s["art"] == "side" and s["d"] == d and abs(s["s"]) == 1]
            if d == D:
                fr = [i for i, s in enumerate(slots) if s["art"] == "front" and s["d"] == d]
                order += sorted(fr, key=lambda i: -abs(slots[i]["s"]))
    else:
        order += [i for i, s in enumerate(slots) if s["band"]]
        order += [i for i, s in enumerate(slots) if not s["band"]]
    for si in order:
        render(ts, style, si, mem, mem, stride=stride, vb=vb)
    return fb_to_image(mem, vw, h, stride, 0, 4)


# ---------------------------------------------------------------- DBG (Tapete)

BG_KEYS = {"name", "geom", "png", "y0", "offsets", "wrap", "above", "below", "out", "load", "vrl_load", "key"}


def load_bg_conf(path, out=None, strict=False):
    cfg = _toml(path)
    base = os.path.dirname(os.path.abspath(path))
    _check_keys(path, cfg, {"format", "version", "background"})
    if cfg.get("format") != "dbebg" or cfg.get("version") != 1:
        raise TexError(f'{path}: format = "dbebg" und version = 1 erwartet')
    bg = dict(cfg.get("background") or {})
    _check_keys(f"{path} [background]", bg, BG_KEYS)
    for k in ("name", "geom", "png"):
        if k not in bg:
            raise TexError(f"{path} [background]: {k} fehlt")
    return {"name": str(bg["name"]), "geom": os.path.join(base, bg["geom"]), "png": os.path.join(base, bg["png"]),
            "y0": bg.get("y0", "horizon"), "offsets": bg.get("offsets", "auto"), "wrap": bool(bg.get("wrap", True)),
            "above": bg.get("above", 0), "below": bg.get("below", 0),
            "out": out or os.path.join(base, bg.get("out", ".")),
            "load": _int("load", bg.get("load", dbemem.default_load("dbg")), 0, 0xFFFF),
            "vrl_load": _int("vrl_load", bg.get("vrl_load", 0x4000), 0, 0xFFFF),
            "key": bg.get("key"), "strict": strict}


def _bg_fill(v, n, what):
    if isinstance(v, int):
        v = [v] * n
    if not isinstance(v, list) or len(v) != n or not all(isinstance(c, int) and 0 <= c <= 15 for c in v):
        raise TexError(f"{what}: Farbe 0 ... 15 oder Liste mit {n} Farben erwartet")
    return v


def build_background(conf):
    """-> (dbg PRG, vram, Warnungen)."""
    geom = load_geom(conf["geom"], conf.get("dvg"))
    vp = geom["viewport"]
    VW, VH = vp["width_px"] // 2, vp["height"]
    img = read_rgba(conf["png"])
    if img.width % 2:
        raise TexError(f"{conf['png']}: Breite {img.width} nicht gerade")
    P, h = img.width // 2, img.height
    pix, warns = to_indices(img, (0, 0, img.width, h), conf.get("key"), 0, conf.get("strict"))
    if any(v is None for row in pix for v in row):
        raise TexError(f"{conf['png']}: Panorama hat transparente Pixel")
    if P < VW:
        raise TexError(f"Panoramabreite {P} < Sichtfensterbreite {VW}")
    if P * h > 65535:
        raise TexError(f"Panorama {P} x {h} = {P * h} > 65535 Byte")
    y0 = conf["y0"]
    if y0 == "horizon":
        hy0, hy1 = geom["horizon"]
        y0 = hy0 + (hy1 - hy0 - h) // 2
    y0 = _int("y0", y0, -1000, 1000)
    if y0 < 0 or y0 + h > VH:
        raise TexError(f"y0 {y0} + h {h} liegt nicht im Sichtfenster (0 ... {VH})")
    off = conf["offsets"]
    if off == "auto":
        if P % 4:
            raise TexError(f"offsets = auto: Panoramabreite {P} nicht durch 4 teilbar")
        off = [v * P // 4 for v in range(4)]
    if not (isinstance(off, list) and len(off) == 4 and all(isinstance(o, int) and 0 <= o < P for o in off)):
        raise TexError(f"offsets: 4 Werte 0 ... {P - 1} erwartet")
    if not conf["wrap"] and any(o + VW > P for o in off):
        raise TexError("ohne wrap muss o_v + VW <= P fuer alle Richtungen gelten")
    above = _bg_fill(conf["above"], y0, "above")
    below = _bg_fill(conf["below"], VH - (y0 + h), "below")
    fill = [c * 17 for c in above] + [0] * h + [c * 17 for c in below]
    vram = bytearray()
    for row in pix:
        vram += bytes(row[2 * i] << 4 | row[2 * i + 1] for i in range(P))
    head = bytearray(24)
    head[0:3] = b"DB\x01"
    head[3], head[4] = VW, VH
    struct.pack_into("<HH", head, 5, geom["geometry_id"], P)
    head[9], head[10], head[11] = y0, h, 1 if conf["wrap"] else 0
    struct.pack_into("<4H", head, 12, *off)
    struct.pack_into("<HH", head, 20, len(vram), binascii.crc_hqx(bytes(vram), 0xFFFF))
    content = bytes(head) + bytes(fill)
    return struct.pack("<H", conf["load"]) + content, bytes(vram), warns


def from_dbg(data):
    if len(data) < 2 + 24:
        raise TexError("DBG: Datei kuerzer als der Kopf")
    c = data[2:]
    if c[0:2] != b"DB":
        raise TexError("DBG: falsches Magic (erwartet 'DB')")
    if c[2] != 1:
        raise TexError(f"DBG: Version {c[2]} nicht unterstuetzt")
    gid, P = struct.unpack_from("<HH", c, 5)
    u, crc = struct.unpack_from("<HH", c, 20)
    vw, vh = c[3], c[4]
    if len(c) != 24 + vh:
        raise TexError(f"DBG: Laenge {len(c)} != {24 + vh}")
    return {"vw": vw, "vh": vh, "geometry_id": gid, "P": P, "y0": c[9], "h": c[10], "wrap": bool(c[11] & 1),
            "offsets": list(struct.unpack_from("<4H", c, 12)), "u": u, "crc": crc, "fill": list(c[24:24 + vh])}


def render_background(bg, vram, v, fb, vb=0, ap=0, stride=80):
    """Horizontzeilen fuer Blickrichtung v mit sim_vmc/sim_vmf in fb (6.2)."""
    vw, P, o = bg["vw"], bg["P"], bg["offsets"][v]
    for r in range(bg["vh"]):
        t0 = ap + r * stride
        if bg["y0"] <= r < bg["y0"] + bg["h"]:
            src = vb + (r - bg["y0"]) * P
            n1 = min(vw, P - o)
            sim_vmc(vram, src + o, t0, n1, 1, 0, 0, fb=fb)
            if n1 < vw:
                if not bg["wrap"]:
                    raise TexError("DBG: Zugriff ueber P ohne WRAP")
                sim_vmc(vram, src, t0 + n1, vw - n1, 1, 0, 0, fb=fb)
        else:
            sim_vmf(fb, t0, bg["fill"][r], vw)


# ---------------------------------------------------------------- Bericht und Budget

def vms_bound(ts):
    """Obere Schranke fuer die VMS-Listen eines Bildes: je Slot das Maximum ueber die Stile (8.1).
    Rueckgabe (kacheln_oder_waende, baender)."""
    tot = [0, 0]
    smap = ts.slot_map
    band_slots = {v for i, v in enumerate(smap) if i >= ts.ne and v != FALLBACK}
    for k in range(sum(1 for v in smap if v != FALLBACK)):
        m = 0
        for vals in ts.styles:
            v = vals[k]
            if v == FALLBACK:
                v = ts.styles[0][k]
            if v < NOIMG:
                m = max(m, len(ts.entries[v].vms))
        tot[1 if k in band_slots else 0] += m
    return tot[0], tot[1]


def build_report(ts, conf, warns, infos, vrl_stream, dts_len):
    st = vrl.stats(vrl_stream)
    slots = ts.slots
    rows, seen = [], set()
    per_style = []
    for si, vals in enumerate(ts.styles):
        vram = vms = 0
        for k, v in enumerate(vals):
            row = {"style": ts.style_names[si], "slot": slots[k]["name"], "value": v}
            if v >= NOIMG:
                row["source"] = "$FF -> Stil 0" if v == FALLBACK else "$FE"
            else:
                e = ts.entries[v]
                own = e.style_names[0] if e.style_names else ""
                row["entry"] = v
                row["source"] = "eigen" if own == ts.style_names[si] else f"geteilt mit {own}"
                if e.flags & F_AUSSCHNITT:
                    row["source"] += f", Ausschnitt von {e.source}"
                row["kerns"] = len(e.kerns)
                row["kern_bytes"] = sum(kk.w * kk.h for kk in e.kerns) if not e.flags & F_AUSSCHNITT else 0
                row["rand"] = e.rand_len
                row["vms"] = len(e.vms)
                row["alpha"] = e.vms[0] if e.vms else None
                row["deckend"] = bool(e.flags & F_DECKEND)
                row["zeilen"] = bool(e.flags & F_ZEILEN)
                if v not in seen:
                    seen.add(v)
                    vram += row["kern_bytes"] + e.rand_len
                vms += len(e.vms)
            rows.append(row)
        per_style.append({"style": ts.style_names[si], "vram": vram, "vms": vms})
    b0, b1 = vms_bound(ts)
    warns = list(warns)
    if b0 > VMS_BUFFER:
        warns.append(f"VMS-Schranke {b0} > VMS-Puffer {VMS_BUFFER}")
    for i, e in enumerate(ts.entries):
        if len(e.vms) > VMS_BUFFER:
            warns.append(f"Bild {i} ({slots[e.slot]['name']}, {'/'.join(e.style_names)}): VMS-Liste {len(e.vms)} Byte "
                         f"> VMS-Puffer {VMS_BUFFER} - nicht zeichenbar, mehr Kerne oder breitere Laeufe malen")
    return {"name": conf["name"], "kind": KIND_NAMES[ts.kind], "geometry_id": ts.geometry_id, "ns": ts.ns,
            "nst": len(ts.styles), "ni": len(ts.entries), "nk": ts.nk, "dts_bytes": dts_len,
            "vram": len(ts.vram), "vrl_bytes": st["stream_bytes"], "vrl_ratio": st["ratio"],
            "vms_bound": b0, "vms_bound_bands": b1, "vms_buffer": VMS_BUFFER,
            "pool_bytes": conf["pool_bytes"], "styles": per_style, "rows": rows,
            "warnings": warns, "infos": infos}


def report_md(rp):
    L = [f"# {rp['name']} ({rp['kind']})", "",
         f"Geometrie-ID {rp['geometry_id']}, NS {rp['ns']}, NST {rp['nst']}, NI {rp['ni']}, NK {rp['nk']}", "",
         f"- DTS-Inhalt: {rp['dts_bytes']} Byte",
         f"- VRAM U: {rp['vram']} Byte (Pool {rp['pool_bytes']})",
         f"- VRL-Strom: {rp['vrl_bytes']} Byte, Verhaeltnis {rp['vrl_ratio']:.3f}" if rp["vrl_ratio"] is not None
         else f"- VRL-Strom: {rp['vrl_bytes']} Byte",
         f"- VMS-Schranke: {rp['vms_bound']} / {rp['vms_buffer']} (Baender getrennt: {rp['vms_bound_bands']})", "",
         "## Summen je Stil", "", "| Stil | VRAM | VMS |", "|---|---|---|"]
    for s in rp["styles"]:
        L.append(f"| {s['style']} | {s['vram']} | {s['vms']} |")
    L += ["", "## Bilder", "", "| Stil | Slot | Wert | Eintrag | Quelle | Kerne | Kernbyte | Rand | VMS | Alpha | DECKEND | ZEILEN |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rp["rows"]:
        if "entry" in r:
            L.append(f"| {r['style']} | {r['slot']} | {r['value']} | {r['entry']} | {r['source']} | {r['kerns']} | "
                     f"{r['kern_bytes']} | {r['rand']} | {r['vms']} | {r['alpha'] if r['alpha'] is not None else ''} | "
                     f"{int(r['deckend'])} | {int(r['zeilen'])} |")
        else:
            L.append(f"| {r['style']} | {r['slot']} | ${r['value']:02X} |  | {r['source']} |  |  |  |  |  |  |  |")
    if rp["warnings"]:
        L += ["", "## Warnungen", ""] + [f"- {w}" for w in rp["warnings"]]
    if rp["infos"]:
        L += ["", "## Infos", ""] + [f"- {w}" for w in rp["infos"]]
    return "\n".join(L) + "\n"


def read_file(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError as e:
        raise TexError(f"{path}: {e}")


def file_kind(data, path=""):
    if data[2:4] == b"DT":
        return "dts"
    if data[2:4] == b"DB":
        return "dbg"
    if data[2:4] == b"S2":
        return "s2"
    raise TexError(f"{path}: weder DTS, DBG noch S2")


def budget(paths, pool, vms_buffer=VMS_BUFFER, pool_start=None):
    files, total, vms_sum = [], 0, 0
    for p in paths:
        data = read_file(p)
        k = file_kind(data, p)
        if k == "dts":
            ts = from_dts(data)
            u = ts.u
            b0, b1 = vms_bound(ts)
            files.append({"file": p, "kind": KIND_NAMES[ts.kind], "u": u, "vms_bound": b0, "vms_bound_bands": b1})
            vms_sum += b0
        elif k == "s2":
            u = struct.unpack_from("<H", data, 2 + 30)[0]
            files.append({"file": p, "kind": "sprite", "u": u})
        else:
            bg = from_dbg(data)
            u = bg["u"]
            files.append({"file": p, "kind": "background", "u": u})
        total += u
    pos = pool_start
    for f in files:
        f["share"] = f["u"] / pool if pool else None
        if pos is not None:
            f["base"] = pos
            pos += f["u"]
    return {"files": files, "sum": total, "pool": pool, "over": max(0, total - pool), "free": max(0, pool - total),
            "vms_sum": vms_sum, "vms_buffer": vms_buffer, "vms_over": vms_sum > vms_buffer}


# ---------------------------------------------------------------- CLI

def _addr(s):
    s = str(s).strip()
    v = int(s[1:], 16) if s.startswith("$") else int(s, 0)
    if not 0 <= v <= 0xFFFF:
        raise argparse.ArgumentTypeError("Adresse ausserhalb 0 ... 65535: " + s)
    return v


def write(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb" if isinstance(data, bytes) else "w", **({} if isinstance(data, bytes) else {"encoding": "utf-8"})) as f:
        f.write(data)


def check_bank1(kind, load, length):
    """Abbruch, wenn die Datei ueber ihren Bereich der Bank-1-Speicherkarte (dbemem) hinausreicht."""
    err = dbemem.range_error(kind, load, length)
    if err:
        raise TexError(err)


def cmd_build(a):
    conf = load_tex_conf(a.toml, a.out, a.strict, a.key, a.alpha_threshold)
    ts, warns, infos = build_texset(conf)
    dts = to_dts(ts, conf["load"])
    check_bank1(KIND_NAMES[ts.kind], conf["load"], len(dts) - 2)
    stream = vrl.encode(list(ts.vram))
    vrlf = vrl.pack_file(stream, conf["vrl_load"])
    out, name = conf["out"], conf["name"]
    write(os.path.join(out, name + ".dts"), dts)
    write(os.path.join(out, name + ".vrl"), vrlf)
    rp = build_report(ts, conf, warns, infos, stream, len(dts) - 2)
    write(os.path.join(out, name + ".tex.json"), json.dumps(rp, indent=1, ensure_ascii=False) + "\n")
    write(os.path.join(out, name + ".tex.md"), report_md(rp))
    if not a.no_preview:
        geom = load_geom(conf["geom"])
        for i, sn in enumerate(ts.style_names):
            preview(ts, geom, i).save(os.path.join(out, f"{name}_{sn}_preview.png"))
    n = lambda v: f"{v:,}".replace(",", " ")
    print(f"{name}: {len(ts.styles)} Stile, {len(ts.entries)} Bilder, VRAM {n(rp['vram'])} Byte, "
          f"VRL {n(rp['vrl_bytes'])} Byte, VMS-Schranke {n(rp['vms_bound'])}/{VMS_BUFFER}")
    for w in warns:
        print("Warnung: " + w, file=sys.stderr)
    return 0


def cmd_bg(a):
    conf = load_bg_conf(a.toml, a.out, a.strict)
    dbg, vram, warns = build_background(conf)
    check_bank1("dbg", conf["load"], len(dbg) - 2)
    stream = vrl.encode(list(vram))
    write(os.path.join(conf["out"], conf["name"] + ".dbg"), dbg)
    write(os.path.join(conf["out"], conf["name"] + ".vrl"), vrl.pack_file(stream, conf["vrl_load"]))
    print(f"{conf['name']}: Tapete, VRAM {len(vram)} Byte, VRL {len(stream)} Byte")
    for w in warns:
        print("Warnung: " + w, file=sys.stderr)
    return 0


def cmd_dump(a):
    data = read_file(a.file)
    k = file_kind(data, a.file)
    vramdata = None
    vinfo = None
    if a.vrl:
        _, _, u, stream = vrl.unpack_file(read_file(a.vrl))
        vramdata = bytes(vrl.decode(stream))
        vinfo = {"u": u, "crc": binascii.crc_hqx(vramdata, 0xFFFF)}
    if k == "s2":
        raise TexError(f"{a.file}: Sprite-Satz - dbespr.py dump verwenden")
    if k == "dbg":
        bg = from_dbg(data)
        if vinfo:
            bg["vrl_check"] = {"u_ok": vinfo["u"] == bg["u"], "crc_ok": vinfo["crc"] == bg["crc"]}
            if not (bg["vrl_check"]["u_ok"] and bg["vrl_check"]["crc_ok"]):
                raise TexError("VRL passt nicht zum DBG (U/CRC)")
        print(json.dumps(bg, indent=1) if a.json else "\n".join(f"{k}: {v}" for k, v in bg.items()))
        return 0
    ts = from_dts(data, vramdata)
    if vinfo and (vinfo["u"] != ts.u or vinfo["crc"] != ts.crc):
        raise TexError(f"VRL passt nicht zum DTS: U {vinfo['u']} / {ts.u}, CRC {vinfo['crc']:04X} / {ts.crc:04X}")
    names = None
    gj = os.path.splitext(a.file)[0] + ".geom.json"
    for cand in (gj, ):
        if os.path.exists(cand):
            try:
                g = load_geom(cand)
                if g["geometry_id"] == ts.geometry_id:
                    names = slot_infos(g, KIND_NAMES[ts.kind])[0]
            except TexError:
                pass
    d = {"kind": KIND_NAMES[ts.kind], "geometry_id": ts.geometry_id, "ne": ts.ne, "depth": ts.depth, "ns": ts.ns,
         "nst": len(ts.styles), "ni": len(ts.entries), "nk": ts.nk, "u": ts.u, "crc": ts.crc, "stride": ts.stride,
         "length": ts.total, "slot_map": ts.slot_map, "styles": ts.styles,
         "entries": [{"index": i, "slot": e.slot, "name": names[e.slot]["name"] if names else None, "flags": e.flags,
                      "h": e.h, "source": e.source, "rand_ofs": e.rand_ofs, "rand_len": e.rand_len,
                      "vms_len": len(e.vms), "kerns": [vars(kk) for kk in e.kerns], "fill": list(e.fill)}
                     for i, e in enumerate(ts.entries)]}
    if a.json:
        print(json.dumps(d, indent=1))
    else:
        print(f"DTS {d['kind']} ID {d['geometry_id']} NE {d['ne']} D {d['depth']} NS {d['ns']} NST {d['nst']} "
              f"NI {d['ni']} NK {d['nk']} U {d['u']} CRC {d['crc']:04X} stride {d['stride']} Laenge {d['length']}")
        print("Slotkarte:", ts.slot_map)
        for i, s in enumerate(ts.styles):
            print(f"Stil {i}:", " ".join(f"{v:02X}" for v in s))
        for e in d["entries"]:
            print(f"Bild {e['index']}: slot {e['slot']} {e['name'] or ''} flags {e['flags']:X} h {e['h']} "
                  f"kerne {len(e['kerns'])} rand {e['rand_len']} vms {e['vms_len']}")
    return 0


def cmd_budget(a):
    r = budget(a.files, a.pool, a.vms_buffer, a.pool_start)
    if a.json:
        print(json.dumps(r, indent=1))
    else:
        for f in r["files"]:
            base = f"  Basis {f['base']:04X}" if "base" in f else ""
            print(f"{f['file']}: {f['kind']}, U {f['u']}, {100 * f['share']:.1f} % des Pools{base}")
        print(f"Summe {r['sum']} / Pool {r['pool']}, frei fuer Sprites: {r['free']}")
        print(f"VMS-Schranke {r['vms_sum']} / {r['vms_buffer']}" + (" - Warnung: Puffer zu klein" if r["vms_over"] else ""))
    if r["over"]:
        print(f"Pool ueberschritten um {r['over']} Byte", file=sys.stderr)
        return 1
    return 0


def cmd_check(a):
    import dbemap
    if a.map.endswith(".toml"):
        m = dbemap.load_toml(a.map)
    else:
        m = dbemap.from_dmp(read_file(a.map))
    gid = None
    if a.dvg:
        c = read_file(a.dvg)[2:]
        gid = struct.unpack_from("<H", c, 12)[0]
        if gid != dvg_id(c):
            raise TexError(f"{a.dvg}: Geometrie-ID passt nicht zum Inhalt")
    errs = []
    sets = {}
    for kind, path in ((0, a.walls), (1, a.floors), (2, a.ceils)):
        if not path:
            continue
        ts = from_dts(read_file(path))
        if ts.kind != kind:
            errs.append(f"{path}: Art {KIND_NAMES[ts.kind]}, erwartet {KIND_NAMES[kind]}")
            continue
        sets[kind] = (ts, path)
        if gid is None:
            gid = ts.geometry_id
        if ts.geometry_id != gid:
            errs.append(f"{path}: Geometrie-ID {ts.geometry_id} != {gid}")
    used = sorted({c for c in m.cells} | {m.outside})
    for ti in used:
        t = m.tiles[ti]
        nm = f"{t.name} (Kachel {ti})"
        for kind, vals, label in ((0, [(v, f"Wandstil {'NOSW'[i]}") for i, v in enumerate(t.walls)], "walls"),
                                  (1, [(t.floor, "Bodenstil")], "floors"), (2, [(t.ceiling, "Deckenstil")], "ceils")):
            if kind not in sets:
                continue
            nst = len(sets[kind][0].styles)
            for v, what in vals:
                if v >= 1 and v - 1 >= nst:
                    errs.append(f"Kachel {nm}: {what} {v} > NST {nst} in {sets[kind][1]}")
    if errs:
        for e in errs:
            print("Fehler: " + e, file=sys.stderr)
        return 1
    print(f"check: ok ({len(used)} Kacheln geprueft)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Texturen in DTS/DBG/VRL umwandeln")
    sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build")
    b.add_argument("toml")
    b.add_argument("--out")
    b.add_argument("--strict", action="store_true")
    b.add_argument("--key")
    b.add_argument("--alpha-threshold", type=int)
    b.add_argument("--no-preview", action="store_true")
    g = sp.add_parser("bg")
    g.add_argument("toml")
    g.add_argument("--out")
    g.add_argument("--strict", action="store_true")
    d = sp.add_parser("dump")
    d.add_argument("file")
    d.add_argument("--vrl")
    d.add_argument("--json", action="store_true")
    u = sp.add_parser("budget")
    u.add_argument("files", nargs="+")
    u.add_argument("--pool", type=int, required=True)
    u.add_argument("--pool-start", type=_addr)
    u.add_argument("--vms-buffer", type=int, default=VMS_BUFFER)
    u.add_argument("--json", action="store_true")
    c = sp.add_parser("check")
    c.add_argument("map")
    c.add_argument("--walls")
    c.add_argument("--floors")
    c.add_argument("--ceils")
    c.add_argument("--dvg")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        return {"build": cmd_build, "bg": cmd_bg, "dump": cmd_dump, "budget": cmd_budget, "check": cmd_check}[a.cmd](a)
    except (TexError, ValueError, KeyError) as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
