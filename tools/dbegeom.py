#!/usr/bin/env python3
"""Sichtfenster-Geometrie (view.toml) in DVG, geom.json, Malvorlagen und Budgetbericht umwandeln.

Eingabe: view.toml (docs/specs/P3-geometry.md, Abschnitt 2) oder Kommandozeilenparameter.
Das Westwood-Preset (Eye of the Beholder / Lands of Lore, 176 x 120) wird proportional auf
width_px x height skaliert; alle Rundungen exakt (fractions.Fraction, rund(v) = floor(v + 1/2)).

Ausgabe (Ordner [output].dir, Basisname [output].name):
  <name>.dvg            PRG mit Ladeadresse: Kopf 24 Byte, Tiefentabelle, Elementtabelle (16 Byte je Element)
  <name>.geom.json      alles aus der DVG plus Masken, Atlas-Lage, Anker in Pixeln, Budget
  <name>_atlas.png      Malvorlage 1:1 (RGBA), <name>.aseprite  (indiziert, Slices je Bild)
  <name>_view.png       Uebersicht, tpl/<element>.png  Einzelvorlagen (vergroessert mit zoom)
  <name>.budget.md      VRAM und VMS-Listen je Stil

Aufruf:
  dbegeom.py view.toml [--out DIR] [--name NAME] [--check]
  dbegeom.py --preset westwood --width 140 --height 96 [--stride 80 --origin 0] [--out DIR]
Exitcode 0 ok, 1 Validierungsfehler, 2 Aufruf.
"""
import argparse
import binascii
import json
import os
import struct
import sys
import tomllib
import zlib
from fractions import Fraction

ART_FRONT, ART_SIDE, ART_FLOOR, ART_CEIL, ART_OBJ = 0, 1, 2, 3, 4
ART_NAMES = {ART_FRONT: "front", ART_SIDE: "side", ART_FLOOR: "floor", ART_CEIL: "ceil", ART_OBJ: "obj"}
FLAG_COVER, FLAG_PARTIAL, FLAG_CLIPPED = 1, 2, 4
VMS_BUFFER = 1300       # Plan Abschnitt 3: VMS-Puffer 1,3 KB

WESTWOOD = {
    "ref_size": (176, 120),
    "center_x": 88,
    "width": [208, 128, 80, 48, 32],
    "top": [-16, 8, 16, 24, 28],
    "bottom": [144, 104, 80, 64, 56],
}

# Anker je Zelle: (Name, seitlich a, Tiefe t)
SLOT_POS = [(Fraction(-1, 4), Fraction(3, 4)), (Fraction(1, 4), Fraction(3, 4)), (Fraction(0), Fraction(1, 2)),
            (Fraction(-1, 4), Fraction(1, 4)), (Fraction(1, 4), Fraction(1, 4))]

PALETTE = [(0x00, 0x00, 0x00), (0x55, 0x55, 0x55), (0x00, 0x00, 0xAA), (0x55, 0x55, 0xFF),
           (0x00, 0xAA, 0x00), (0x55, 0xFF, 0x55), (0x00, 0xAA, 0xAA), (0x55, 0xFF, 0xFF),
           (0xAA, 0x00, 0x00), (0xFF, 0x55, 0x55), (0xAA, 0x00, 0xAA), (0xFF, 0x55, 0xFF),
           (0xAA, 0x55, 0x00), (0xFF, 0xFF, 0x55), (0xAA, 0xAA, 0xAA), (0xFF, 0xFF, 0xFF)]


class GeomError(Exception):
    """Validierungsfehler (Exitcode 1)."""


def rnd(v):
    """rund(v) = floor(v + 1/2), exakt."""
    return int((Fraction(v) + Fraction(1, 2)) // 1)


# ---------------------------------------------------------------- Konfiguration

VIEWPORT_KEYS = {"preset", "width_px", "height", "origin", "stride", "depth"}
OUTPUT_KEYS = {"name", "dir", "load", "pool_bytes", "zoom"}
PLANE_KEYS = {"ref_size", "center_x", "width", "top", "bottom"}


def _check_keys(section, data, allowed):
    for k in data:
        if k not in allowed:
            raise GeomError(f"[{section}] unbekannter Schluessel '{k}'")


def _int(section, key, v):
    if isinstance(v, bool) or not isinstance(v, int):
        raise GeomError(f"[{section}] {key}: ganze Zahl erwartet")
    return v


def parse_config(cfg):
    """Rohdaten (dict aus TOML) pruefen; liefert dict mit viewport, output, planes."""
    if not isinstance(cfg, dict):
        raise GeomError("Konfiguration ungueltig")
    for k in cfg:
        if k not in ("viewport", "output", "planes"):
            raise GeomError(f"unbekannter Abschnitt '{k}'")
    vp = dict(cfg.get("viewport", {}))
    out = dict(cfg.get("output", {}))
    _check_keys("viewport", vp, VIEWPORT_KEYS)
    _check_keys("output", out, OUTPUT_KEYS)
    preset = vp.get("preset", "westwood")
    if preset not in ("westwood", "custom"):
        raise GeomError(f"[viewport] preset: unbekannt '{preset}'")
    if "width_px" not in vp:
        raise GeomError("[viewport] width_px fehlt")
    if "height" not in vp:
        raise GeomError("[viewport] height fehlt")
    width = _int("viewport", "width_px", vp["width_px"])
    height = _int("viewport", "height", vp["height"])
    origin = _int("viewport", "origin", vp.get("origin", 0))
    stride = _int("viewport", "stride", vp.get("stride", 80))
    if width % 4 != 0:
        raise GeomError("[viewport] width_px: muss ein Vielfaches von 4 sein")
    if not 16 <= width <= 160:
        raise GeomError("[viewport] width_px: Bereich 16 ... 160")
    if not 8 <= height <= 100:
        raise GeomError("[viewport] height: Bereich 8 ... 100")
    if origin < 0:
        raise GeomError("[viewport] origin: darf nicht negativ sein")
    if stride < width // 2:
        raise GeomError("[viewport] stride: kleiner als width_px/2")
    if stride > 255:
        raise GeomError("[viewport] stride: groesser als 255")
    if origin + (height - 1) * stride + width // 2 > 65535:
        raise GeomError("[viewport] origin/stride/height: Puffer ueberschreitet 65535")
    if preset == "westwood":
        if "planes" in cfg:
            raise GeomError("[planes] nur bei preset = \"custom\"")
        planes = dict(WESTWOOD)
    else:
        if "planes" not in cfg:
            raise GeomError("[planes] fehlt (preset = \"custom\")")
        planes = dict(cfg["planes"])
        _check_keys("planes", planes, PLANE_KEYS)
        for k in ("ref_size", "width", "top", "bottom"):
            if k not in planes:
                raise GeomError(f"[planes] {k} fehlt")
        for k in ("width", "top", "bottom", "ref_size"):
            v = planes[k]
            if not isinstance(v, list) or any(isinstance(x, bool) or not isinstance(x, int) for x in v):
                raise GeomError(f"[planes] {k}: Liste ganzer Zahlen erwartet")
        if len(planes["ref_size"]) != 2 or planes["ref_size"][0] <= 0 or planes["ref_size"][1] <= 0:
            raise GeomError("[planes] ref_size: zwei positive Werte erwartet")
        cx = planes.get("center_x", Fraction(planes["ref_size"][0], 2))
        if isinstance(cx, bool) or not isinstance(cx, (int, float, Fraction)) or \
                Fraction(cx) != Fraction(planes["ref_size"][0], 2):
            raise GeomError("[planes] center_x: muss ref_size[0] / 2 sein (Sichtfenster symmetrisch)")
    n = len(planes["width"])
    if n < 3:
        raise GeomError("[planes] width: mindestens 3 Werte")
    if len(planes["top"]) != n:
        raise GeomError("[planes] top: Laenge passt nicht zu width")
    if len(planes["bottom"]) != n:
        raise GeomError("[planes] bottom: Laenge passt nicht zu width")
    if len(planes["ref_size"]) != 2 or planes["ref_size"][0] <= 0 or planes["ref_size"][1] <= 0:
        raise GeomError("[planes] ref_size: zwei positive Werte erwartet")
    for a, b in zip(planes["width"], planes["width"][1:]):
        if not a > b:
            raise GeomError("[planes] width: nicht streng fallend")
    for a, b in zip(planes["top"], planes["top"][1:]):
        if not a < b:
            raise GeomError("[planes] top: nicht steigend")
    for a, b in zip(planes["bottom"], planes["bottom"][1:]):
        if not a > b:
            raise GeomError("[planes] bottom: nicht fallend")
    for k in range(n):
        if planes["top"][k] >= planes["bottom"][k]:
            raise GeomError(f"[planes] top[{k}] >= bottom[{k}]")
    depth = n - 2
    if "depth" in vp and _int("viewport", "depth", vp["depth"]) != depth:
        raise GeomError(f"[viewport] depth: {vp['depth']} passt nicht zu {n} Ebenen (erwartet {depth})")
    if preset == "westwood" and depth != 3:
        raise GeomError("[viewport] depth: Westwood hat genau 3")
    name = out.get("name", f"{preset}{width}")
    return {
        "preset": preset, "width": width, "height": height, "origin": origin, "stride": stride,
        "depth": depth, "planes": planes,
        "name": str(name), "dir": str(out.get("dir", "build/geom")),
        "load": _int("output", "load", out.get("load", 0xE400)),
        "pool_bytes": _int("output", "pool_bytes", out.get("pool_bytes", 26624)),
        "zoom": _int("output", "zoom", out.get("zoom", 4)),
    }


# ---------------------------------------------------------------- Geometrie

class Image:
    """Ein Element oder Band mit Rechteck, Maske, Kern usw."""

    def __init__(self, name, art, d, s):
        self.name, self.art, self.d, self.s = name, art, d, s
        self.polygon = []
        self.rect = (0, 0, 0, 0)        # x, y, w, h (Byte, Zeilen)
        self.mask = []                  # Strings '#', 'L', 'R', '.'
        self.kernel = (0, 0, 0, 0)
        self.cover = (0, 0)
        self.flags = 0
        self.src_dx = 0
        self.atlas = None               # (x, y) in Pixeln oder None
        self.is_band = False

    @property
    def slot_name(self):
        return self.name


def _sgn(s):
    return f"{s:+d}"


def elem_name(art, d, s):
    return f"{art}_d{d}_s{_sgn(s)}"


def anchor_byte(xp, yp):
    """Anker in DVG-Form: Byte-Spalte auf -128 ... 127, Zeile auf 0 ... 255 gesaettigt (Spec 4.3).
    Gesaettigte Anker liegen ganz ausserhalb des Fensters (VW <= 80, VH <= 100)."""
    return max(-128, min(127, xp // 2)), min(255, yp)


def best_rect(rows, w):
    """Groesstes Rechteck aus Einsen in den Zeilenbitmasken (Spec 4.4): maximale Flaeche, dann groessere
    Breite, kleineres ky, kleineres kx. Ergebnis (kx, ky, kw, kh) oder None. Auch von dbetex benutzt."""
    h = len(rows)
    best = None
    for ky in range(h):
        acc = (1 << w) - 1
        for ke in range(ky, h):
            acc &= rows[ke]
            if not acc:
                break
            ln, kx = Geometry.longest_run(acc, w)
            kh = ke - ky + 1
            key = (ln * kh, ln, -ky, -kx)
            if best is None or key > best[0]:
                best = (key, (kx, ky, ln, kh))
    return best[1] if best else None


class Geometry:
    def __init__(self, conf):
        self.conf = conf
        W, H = conf["width"], conf["height"]
        self.width, self.height, self.D = W, H, conf["depth"]
        self.VW = W // 2
        pl = conf["planes"]
        sx = Fraction(W, pl["ref_size"][0])
        sy = Fraction(H, pl["ref_size"][1])
        n = self.D + 2
        self.Wp = [4 * rnd(Fraction(pl["width"][k]) * sx / 4) for k in range(n)]
        self.C = W // 2
        self.T = [rnd(Fraction(pl["top"][k]) * sy) for k in range(n)]
        self.B = [rnd(Fraction(pl["bottom"][k]) * sy) for k in range(n)]
        for k in range(n - 1):
            if not self.Wp[k] > self.Wp[k + 1]:
                raise GeomError(f"Ebene {k}: skalierte Breite nicht streng fallend")
        if self.Wp[n - 1] <= 0:
            raise GeomError("skalierte Breite der letzten Ebene <= 0")
        for k in range(n):
            if not self.T[k] < self.B[k]:
                raise GeomError(f"Ebene {k}: T >= B nach Skalierung")
        for d in range(1, self.D + 1):
            if self.Wp[d] > W:
                raise GeomError("Vollfront breiter als das Fenster")
        self.S = self.D
        self.images = []        # Front, Seite, Boden, Decke in Elementreihenfolge je Zelle
        self.elements = []      # alles inkl. Objektplaetze (dicts oder Image)
        self.bands = []         # Image (is_band)
        self.horizon = (0, 0)
        self.band_rows = []     # je Tiefe (ceil (y0,y1), floor (y0,y1))
        self._build()

    # X(k, u)
    def X(self, k, u):
        return self.C + Fraction(u) * self.Wp[k]

    def _polygons(self, d, s):
        D = self.D
        h = Fraction(1, 2)
        X, T, B = self.X, self.T, self.B
        res = {}
        if d >= 1:
            res[ART_FRONT] = [(X(d, s - h), T[d]), (X(d, s + h), T[d]), (X(d, s + h), B[d]), (X(d, s - h), B[d])]
        if s != 0:
            u = s + h if s < 0 else s - h
            res[ART_SIDE] = [(X(d, u), T[d]), (X(d + 1, u), T[d + 1]), (X(d + 1, u), B[d + 1]), (X(d, u), B[d])]
        res[ART_FLOOR] = [(X(d + 1, s - h), B[d + 1]), (X(d + 1, s + h), B[d + 1]),
                          (X(d, s + h), B[d]), (X(d, s - h), B[d])]
        res[ART_CEIL] = [(X(d + 1, s - h), T[d + 1]), (X(d + 1, s + h), T[d + 1]),
                         (X(d, s + h), T[d]), (X(d, s - h), T[d])]
        return res

    def _mask_pixels(self, poly):
        """Menge (px, r) der Pixel, deren Mittelpunkt im konvexen Polygon liegt (exakt, ganzzahlig verdoppelt)."""
        W, H = self.width, self.height
        pts = [(int(x * 2), int(y * 2)) for x, y in poly]    # Eckpunkte sind ganzzahlig
        # Flaeche (doppelt) -> degeneriert = leer
        area = 0
        for i in range(len(pts)):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % len(pts)]
            area += x1 * y2 - x2 * y1
        if area == 0:
            return set()
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        px0 = max(0, min(xs) // 2 - 1)
        px1 = min(W - 1, max(xs) // 2 + 1)
        r0 = max(0, min(ys) // 2 - 1)
        r1 = min(H - 1, max(ys) // 2 + 1)
        res = set()
        edges = [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]
        for r in range(r0, r1 + 1):
            cy = 2 * r + 1
            for px in range(px0, px1 + 1):
                cx = 2 * px + 1
                pos = neg = False
                for (x1, y1), (x2, y2) in edges:
                    c = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1)
                    if c > 0:
                        pos = True
                    elif c < 0:
                        neg = True
                if not (pos and neg):
                    res.add((px, r))
        return res

    def _fill_image(self, im, pix, poly):
        """Rechteck, Maske, Kern, Beschnitt aus Pixelmenge."""
        im.polygon = [[int(x), int(y)] for x, y in poly]
        xs = [p[0] for p in im.polygon]
        ys = [p[1] for p in im.polygon]
        if min(xs) < 0 or max(xs) > self.width or min(ys) < 0 or max(ys) > self.height:
            im.flags |= FLAG_CLIPPED
        bx0 = min(p[0] for p in pix) // 2
        bx1 = max(p[0] for p in pix) // 2
        by0 = min(p[1] for p in pix)
        by1 = max(p[1] for p in pix)
        im.rect = (bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1)
        rows = []
        for r in range(by0, by1 + 1):
            line = []
            for bx in range(bx0, bx1 + 1):
                l = (2 * bx, r) in pix
                rr = (2 * bx + 1, r) in pix
                line.append("#" if l and rr else "L" if l else "R" if rr else ".")
            rows.append("".join(line))
        im.mask = rows

    @staticmethod
    def full_rows(mask):
        """Bitmasken je Zeile: Bit i = Byte-Spalte i voll."""
        res = []
        for line in mask:
            v = 0
            for i, ch in enumerate(line):
                if ch == "#":
                    v |= 1 << i
            res.append(v)
        return res

    @staticmethod
    def longest_run(v, w):
        """(Laenge, Start) des laengsten Einserlaufs in v (Breite w); bei Gleichstand der linkeste."""
        best = (0, 0)
        i = 0
        while i < w:
            if (v >> i) & 1:
                j = i
                while j < w and (v >> j) & 1:
                    j += 1
                if j - i > best[0]:
                    best = (j - i, i)
                i = j
            else:
                i += 1
        return best

    def _kernel(self, im):
        im.kernel = best_rect(self.full_rows(im.mask), im.rect[2]) or (0, 0, 0, 0)

    def _cover(self, im):
        d = im.d
        x, y, w, h = im.rect
        r0 = max(self.T[d + 1], 0)
        r1 = min(self.B[d + 1], self.height)
        if r1 <= r0:
            im.cover = (0, 0)
            return
        rows = self.full_rows(im.mask)
        acc = (1 << w) - 1
        for r in range(r0, r1):
            if r < y or r >= y + h:
                acc = 0
                break
            acc &= rows[r - y]
        ln, st = self.longest_run(acc, w)
        im.cover = (x + st, x + st + ln) if ln else (0, 0)
        if ln:
            im.flags |= FLAG_COVER

    def _anchors(self, d, s):
        Wp, B = self.Wp, self.B
        res = []
        for a, t in SLOT_POS:
            Wt = 1 / ((1 - t) / Fraction(Wp[d]) + t / Fraction(Wp[d + 1]))
            x = self.C + (s + a) * Wt
            y = B[d] + Fraction(B[d + 1] - B[d]) * (Wp[d] - Wt) / (Wp[d] - Wp[d + 1])
            xp, yp = rnd(x), rnd(y)
            if yp < 0:
                raise GeomError(f"Anker d={d} s={s}: Zeile {yp} oberhalb des Fensters")
            res.append((xp, yp))
        return res

    def _build(self):
        D, S = self.D, self.S
        elems = []
        for d in range(D + 1):
            cells = [0]
            for k in range(1, S + 1):
                cells += [-k, k]
            for s in cells:
                polys = self._polygons(d, s)
                has_floor = False
                for art in (ART_FRONT, ART_SIDE, ART_FLOOR, ART_CEIL):
                    if art not in polys:
                        continue
                    pix = self._mask_pixels(polys[art])
                    if not pix:
                        continue
                    im = Image(elem_name(ART_NAMES[art], d, s), art, d, s)
                    self._fill_image(im, pix, polys[art])
                    self._kernel(im)
                    if art in (ART_FRONT, ART_SIDE):
                        self._cover(im)
                    if art == ART_FRONT and s != 0:
                        im.flags |= FLAG_PARTIAL
                        im.src_dx = (im.rect[0] * 2 - int(self.X(d, s - Fraction(1, 2)))) // 2
                    if art == ART_FLOOR:
                        has_floor = True
                    elems.append(im)
                if has_floor:
                    elems.append({"art": ART_OBJ, "d": d, "s": s, "name": f"obj_d{d}_s{_sgn(s)}",
                                  "anchors": self._anchors(d, s)})
        if len(elems) > 255:
            raise GeomError(f"zu viele Elemente: {len(elems)} (max. 255)")
        self.elements = elems
        self.images = [e for e in elems if isinstance(e, Image)]
        if not any(i.art == ART_FRONT and i.s == 0 for i in self.images):
            raise GeomError("keine Front vorhanden")
        # Baender
        H = self.height

        def clip(a, b):
            a, b = max(0, min(a, H)), max(0, min(b, H))
            return (a, max(a, b))

        self.band_rows = []
        for d in range(D + 1):
            self.band_rows.append((clip(self.T[d], self.T[d + 1]), clip(self.B[d + 1], self.B[d])))
        self.horizon = clip(self.T[D + 1], self.B[D + 1])
        # Luecken pruefen
        cover = [0] * H
        for (c0, c1), (f0, f1) in self.band_rows:
            for r in list(range(c0, c1)) + list(range(f0, f1)):
                cover[r] += 1
        for r in range(*self.horizon):
            cover[r] += 1
        if any(c != 1 for c in cover):
            raise GeomError("Baender ueberdecken die Zeilen nicht luckenlos und ueberschneidungsfrei")
        for d in range(D + 1):
            for art, (y0, y1) in (("ceilband", self.band_rows[d][0]), ("floorband", self.band_rows[d][1])):
                if y1 > y0:
                    im = Image(f"{art}_d{d}", art, d, 0)
                    im.is_band = True
                    im.rect = (0, y0, self.VW, y1 - y0)
                    im.mask = ["#" * self.VW] * (y1 - y0)
                    im.kernel = (0, 0, self.VW, y1 - y0)
                    self.bands.append(im)

    # --- Zugriffe
    def by_name(self, name):
        for im in self.images + self.bands:
            if im.name == name:
                return im
        return None

    def atlas_images(self):
        """Bilder in Atlas-Reihenfolge, gruppiert nach Zeilen (Liste von Listen)."""
        D = self.D
        rows = []
        fronts = [i for i in self.images if i.art == ART_FRONT and i.s == 0]
        rows.append(fronts)
        for d in range(D + 1):
            rows.append([i for i in self.images if i.art == ART_SIDE and i.d == d])
        rows.append([b for b in self.bands if b.art == "floorband"])
        rows.append([b for b in self.bands if b.art == "ceilband"])
        for d in range(D + 1):
            rows.append([i for i in self.images if i.art == ART_FLOOR and i.d == d])
        for d in range(D + 1):
            rows.append([i for i in self.images if i.art == ART_CEIL and i.d == d])
        return [r for r in rows if r]


# ---------------------------------------------------------------- Atlas

def layout_atlas(geo):
    """Atlas-Lage berechnen; setzt im.atlas, liefert (breite, hoehe)."""
    rows = geo.atlas_images()
    widest = 0
    for r in rows:
        widest = max(widest, sum(i.rect[2] * 2 for i in r) + 4 * (len(r) - 1))
    aw = max(geo.width, widest) + 8
    y = 4
    for r in rows:
        x = 4
        rh = 0
        for im in r:
            im.atlas = (x, y)
            x += im.rect[2] * 2 + 4
            rh = max(rh, im.rect[3])
        y += rh + 4
    return aw, y


def image_pixels(im):
    """Liefert fuer jedes Pixel des Bildrechtecks 0 = leer, 1 = Maske, 2 = Kern (Liste von Zeilen)."""
    w = im.rect[2]
    kx, ky, kw, kh = im.kernel
    res = []
    for r, line in enumerate(im.mask):
        row = []
        for bx in range(w):
            ch = line[bx]
            inker = kw and kx <= bx < kx + kw and ky <= r < ky + kh
            for side in (0, 1):
                on = ch == "#" or (ch == "L" and side == 0) or (ch == "R" and side == 1)
                row.append(0 if not on else 2 if inker else 1)
        res.append(row)
    return res


def write_pngs(geo, outdir, name, zoom, atlas_size):
    from PIL import Image as PImage
    aw, ah = atlas_size
    atlas = PImage.new("RGBA", (aw, ah), (0, 0, 0, 0))
    ap = atlas.load()
    tpl_dir = os.path.join(outdir, "tpl")
    os.makedirs(tpl_dir, exist_ok=True)
    colors = {1: PALETTE[14] + (255,), 2: PALETTE[1] + (255,)}
    for im in geo.images + geo.bands:
        if im.atlas is None:
            continue
        pix = image_pixels(im)
        ax, ay = im.atlas
        t = PImage.new("RGBA", (im.rect[2] * 2, im.rect[3]), (0, 0, 0, 0))
        tp = t.load()
        for r, row in enumerate(pix):
            for c, v in enumerate(row):
                if v:
                    ap[ax + c, ay + r] = colors[v]
                    tp[c, r] = colors[v]
        if zoom > 1:
            t = t.resize((t.width * zoom, t.height * zoom), PImage.NEAREST)
        t.save(os.path.join(tpl_dir, im.name + ".png"))
    atlas.save(os.path.join(outdir, f"{name}_atlas.png"))
    # Uebersicht
    W, H = geo.width, geo.height
    from PIL import ImageDraw
    v = PImage.new("RGB", (W, H), (0, 0, 0))
    dr = ImageDraw.Draw(v)
    dcol = [PALETTE[9], PALETTE[13], PALETTE[5], PALETTE[3]]
    for im in geo.images:
        col = dcol[im.d % 4]
        pts = [tuple(p) for p in im.polygon]
        dr.line(pts + [pts[0]], fill=col, width=1)
    for d, ((c0, c1), (f0, f1)) in enumerate(geo.band_rows):
        if c1 > c0:
            dr.rectangle([0, c0, 3, c1 - 1], fill=PALETTE[7])
        if f1 > f0:
            dr.rectangle([0, f0, 3, f1 - 1], fill=PALETTE[12])
    if geo.horizon[1] > geo.horizon[0]:
        dr.rectangle([0, geo.horizon[0], 3, geo.horizon[1] - 1], fill=PALETTE[11])
    vp = v.load()
    for e in geo.elements:
        if isinstance(e, dict):
            for ax, ay in e["anchors"]:
                for dx, dy in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)):
                    if 0 <= ax + dx < W and 0 <= ay + dy < H:
                        vp[ax + dx, ay + dy] = (255, 255, 255)
    if zoom > 1:
        v = v.resize((W * zoom, H * zoom), PImage.NEAREST)
    v.save(os.path.join(outdir, f"{name}_view.png"))


# ---------------------------------------------------------------- Aseprite

def _str(s):
    b = s.encode("utf-8")
    return struct.pack("<H", len(b)) + b


def _chunk(ctype, data):
    return struct.pack("<IH", 6 + len(data), ctype) + data


def build_aseprite(geo, atlas_size):
    aw, ah = atlas_size
    chunks = []
    chunks.append(_chunk(0x2007, struct.pack("<HHi", 1, 0, 0) + bytes(8)))
    pal = struct.pack("<IIII", 17, 0, 16, 0) + bytes(8)
    for r, g, b in PALETTE:
        pal += struct.pack("<HBBBB", 0, r, g, b, 255)
    pal += struct.pack("<HBBBB", 0, 0, 0, 0, 0)
    chunks.append(_chunk(0x2019, pal))
    chunks.append(_chunk(0x2004, struct.pack("<HHHHHHB3x", 1, 0, 0, 0, 0, 0, 128) + _str("Maske")))
    chunks.append(_chunk(0x2004, struct.pack("<HHHHHHB3x", 1 | 2, 0, 0, 0, 0, 0, 255) + _str("Bild")))
    # Cel Ebene 0: Maske
    buf = bytearray([16]) * (aw * ah)
    for im in geo.images + geo.bands:
        if im.atlas is None:
            continue
        ax, ay = im.atlas
        for r, row in enumerate(image_pixels(im)):
            for c, v in enumerate(row):
                if v:
                    buf[(ay + r) * aw + ax + c] = 14 if v == 1 else 1
    cel0 = struct.pack("<HhhBH7x", 0, 0, 0, 255, 2) + struct.pack("<HH", aw, ah) + zlib.compress(bytes(buf), 9)
    chunks.append(_chunk(0x2005, cel0))
    cel1 = struct.pack("<HhhBH7x", 1, 0, 0, 255, 2) + struct.pack("<HH", aw, ah) + \
        zlib.compress(bytes([16]) * (aw * ah), 9)
    chunks.append(_chunk(0x2005, cel1))
    for r in geo.atlas_images():
        for im in r:
            ax, ay = im.atlas
            w, h = im.rect[2] * 2, im.rect[3]
            kx, ky, kw, kh = im.kernel
            nine = kw > 0
            data = struct.pack("<IIi", 1, 1 if nine else 0, 0) + _str(im.name)
            data += struct.pack("<IiiII", 0, ax, ay, w, h)
            if nine:
                data += struct.pack("<iiII", kx * 2, ky, kw * 2, kh)
            chunks.append(_chunk(0x2022, data))
            art = im.art if isinstance(im.art, str) else ART_NAMES[im.art]
            ud = json.dumps({"art": art, "d": im.d, "s": im.s, "src_dx": im.src_dx}, separators=(",", ":"))
            chunks.append(_chunk(0x2020, struct.pack("<I", 1) + _str(ud)))
    n = len(chunks)
    body = b"".join(chunks)
    frame = struct.pack("<IHHH2xI", 16 + len(body), 0xF1FA, 0xFFFF if n > 65534 else n, 100, n) + body
    head = struct.pack("<IHHHHHIHIIB3xHBBhhHH", 128 + len(frame), 0xA5E0, 1, aw, ah, 8, 1, 100, 0, 0,
                       16, 17, 1, 1, 0, 0, 16, 16) + bytes(84)
    assert len(head) == 128
    return head + frame


# ---------------------------------------------------------------- DVG

def build_dvg(geo):
    """Liefert (inhalt, elementdaten) ; Inhalt ohne Ladeadresse, Geometrie-ID bereits eingesetzt."""
    D = geo.D
    conf = geo.conf
    elems = geo.elements
    ne = len(elems)
    total = 24 + 8 * (D + 1) + 16 * ne
    smax = max(abs(e["s"] if isinstance(e, dict) else e.s) for e in elems)
    head = bytearray(24)
    head[0:2] = b"DV"
    head[2] = 1
    head[3] = geo.VW
    head[4] = geo.height
    head[5] = D
    head[6] = smax
    head[7] = ne
    struct.pack_into("<HH", head, 8, conf["stride"], conf["origin"])
    head[14], head[15] = geo.horizon
    head[16] = 16
    head[17] = 8
    struct.pack_into("<HHH", head, 18, 24, 24 + 8 * (D + 1), total)
    depth = bytearray()
    for d in range(D + 1):
        idx = [i for i, e in enumerate(elems) if (e["d"] if isinstance(e, dict) else e.d) == d]
        (c0, c1), (f0, f1) = geo.band_rows[d]
        if d == 0:
            fw = fc = 0
        else:
            fr = next(i for i in geo.images if i.art == ART_FRONT and i.d == d and i.s == 0)
            fw, fc = geo.Wp[d] // 2, fr.rect[0]
        depth += bytes([c0, c1, f0, f1, idx[0], len(idx), fw, fc])
    tab = bytearray()
    for e in elems:
        if isinstance(e, dict):
            row = bytearray(16)
            row[0], row[1], row[2] = ART_OBJ, e["d"], e["s"] & 255
            for p, (ax, ay) in enumerate(e["anchors"]):
                bc, by = anchor_byte(ax, ay)
                row[4 + 2 * p] = bc & 255
                row[5 + 2 * p] = by
        else:
            x, y, w, h = e.rect
            row = bytearray([e.art, e.d, e.s & 255, e.flags, x, y, w, h, *e.kernel, e.cover[0], e.cover[1],
                             e.src_dx, 0])
        tab += row
    content = bytearray(head) + depth + tab
    assert len(content) == total
    tmp = bytearray(content)
    tmp[10:12] = b"\0\0"            # origin (Lage, nicht Form) fliesst nicht in die ID ein
    gid = binascii.crc_hqx(bytes(tmp), 0xFFFF) or 1
    struct.pack_into("<H", content, 12, gid)
    return bytes(content), gid


# ---------------------------------------------------------------- Budget

def image_budget(im):
    """(kernbytes, randbytes, vms_laenge)."""
    kx, ky, kw, kh = im.kernel
    core = kw * kh
    edge = 0
    vms = 3
    for r, line in enumerate(im.mask):
        cmds = 0
        prev_full = False
        for bx, ch in enumerate(line):
            if kw and kx <= bx < kx + kw and ky <= r < ky + kh:
                prev_full = False
                continue
            if ch == ".":
                prev_full = False
                continue
            edge += 1
            if ch == "#":
                if not prev_full:
                    cmds += 4
                prev_full = True
            else:
                cmds += 3
                prev_full = False
        vms += cmds
    if edge == 0:
        vms = 0
    return core, edge, vms


def compute_budget(geo):
    pool = geo.conf["pool_bytes"]
    rows = []
    for im in geo.images + geo.bands:
        core, edge, vms = image_budget(im)
        partial = im.art == ART_FRONT and im.s != 0
        vram = 0 if partial else core + edge
        rows.append({"name": im.name, "art": im.art if isinstance(im.art, str) else ART_NAMES[im.art],
                     "rect": list(im.rect), "kernel": list(im.kernel), "core": 0 if partial else core,
                     "edge": 0 if partial else edge, "vram": vram, "vms": 0 if partial else vms})
    sums = {}
    for r in rows:
        sums[r["art"]] = sums.get(r["art"], 0) + r["vram"]
    wall = sums.get("front", 0) + sums.get("side", 0)
    floorb, ceilb = sums.get("floorband", 0), sums.get("ceilband", 0)
    tiles_f, tiles_c = sums.get("floor", 0), sums.get("ceil", 0)
    base = floorb + ceilb
    n_styles = max(0, (pool - base) // wall) if wall else 0
    vms_wall = sum(r["vms"] for r in rows if r["art"] in ("front", "side"))
    return {
        "rows": rows,
        "sum_front": sums.get("front", 0), "sum_side": sums.get("side", 0),
        "wall_style": wall, "floor_bands": floorb, "ceil_bands": ceilb,
        "floor_tiles": tiles_f, "ceil_tiles": tiles_c,
        "pool_bytes": pool, "wall_styles_in_pool": n_styles,
        "vms_wall_total": vms_wall, "vms_buffer": VMS_BUFFER, "vms_overflow": vms_wall > VMS_BUFFER,
    }


def budget_markdown(geo, bud):
    c = geo.conf
    L = [f"# Budget {c['name']} ({geo.width} x {geo.height})", "",
         "| Name | Rechteck | Kern | Rand | VRAM | VMS-Liste |", "|---|---|---|---|---|---|"]
    for r in bud["rows"]:
        L.append(f"| {r['name']} | {tuple(r['rect'])} | {r['core']} | {r['edge']} | {r['vram']} | {r['vms']} |")
    L += ["", "## Summen je Stil", "",
          f"- Vollfronten: {bud['sum_front']} Byte",
          f"- Seiten: {bud['sum_side']} Byte",
          f"- **Wandstil (Front + Seite): {bud['wall_style']} Byte**",
          f"- Bodenbaender: {bud['floor_bands']} Byte (Kacheln zusaetzlich: {bud['floor_tiles']} Byte)",
          f"- Deckenbaender: {bud['ceil_bands']} Byte (Kacheln zusaetzlich: {bud['ceil_tiles']} Byte)",
          "", "## Pool", "",
          f"- Pool: {bud['pool_bytes']} Byte; Boden- + Deckenstil (Baender): {bud['floor_bands'] + bud['ceil_bands']} Byte",
          f"- Wandstile, die zusammen mit je 1 Boden- und Deckenstil in den Pool passen: {bud['wall_styles_in_pool']}",
          "", "## VMS-Puffer", "",
          f"- Summe der VMS-Listen aller Wandelemente eines Stils (obere Schranke): {bud['vms_wall_total']} Byte"
          f" (Puffer {bud['vms_buffer']} Byte)"]
    if bud["vms_overflow"]:
        L.append("- WARNUNG: Summe ueberschreitet den VMS-Puffer.")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- JSON

def build_json(geo, gid, bud):
    c = geo.conf
    planes = []
    for k in range(geo.D + 2):
        planes.append({"k": k, "W": geo.Wp[k], "x_left": int(geo.X(k, Fraction(-1, 2))),
                       "x_right": int(geo.X(k, Fraction(1, 2))), "T": geo.T[k], "B": geo.B[k]})
    bands = []
    for d, ((c0, c1), (f0, f1)) in enumerate(geo.band_rows):
        bands.append({"d": d, "ceil": [c0, c1], "floor": [f0, f1]})
    band_imgs = [{"name": b.name, "art": b.art, "d": b.d, "rect": list(b.rect), "atlas": list(b.atlas)}
                 for b in geo.bands]
    elements, slots = [], []
    for i, e in enumerate(geo.elements):
        if isinstance(e, dict):
            slots.append({"index": i, "name": e["name"], "d": e["d"], "s": e["s"],
                          "anchors_px": [list(a) for a in e["anchors"]]})
            elements.append({"index": i, "name": e["name"], "art": "obj", "d": e["d"], "s": e["s"],
                             "anchors": [{"name": f"{e['name']}_p{p}", "px": list(a),
                                          "byte": list(anchor_byte(*a))} for p, a in enumerate(e["anchors"])]})
        else:
            fl = []
            if e.flags & FLAG_COVER:
                fl.append("cover")
            if e.flags & FLAG_PARTIAL:
                fl.append("partial")
            if e.flags & FLAG_CLIPPED:
                fl.append("clipped")
            elements.append({"index": i, "name": e.name, "art": ART_NAMES[e.art], "d": e.d, "s": e.s,
                             "rect": list(e.rect), "kernel": list(e.kernel), "cover": list(e.cover),
                             "flags": fl, "src_dx": e.src_dx, "polygon": e.polygon, "mask": e.mask,
                             "atlas": list(e.atlas) if e.atlas else None})
    return {
        "format": "dbegeom", "version": 1, "geometry_id": gid,
        "viewport": {"preset": c["preset"], "width_px": geo.width, "height": geo.height,
                     "origin": c["origin"], "stride": c["stride"], "depth": geo.D},
        "planes": planes, "bands": bands, "band_images": band_imgs, "horizon": list(geo.horizon),
        "atlas_size": list(geo.atlas_size),
        "elements": elements, "slots": slots, "budget": bud,
    }


# ---------------------------------------------------------------- Hauptprogramm

def check_lines(geo):
    out = []
    for e in geo.elements:
        if isinstance(e, dict):
            out.append(f"d={e['d']} s={e['s']} obj anchors=" + " ".join("({},{})".format(*anchor_byte(*a)) for a in e["anchors"]))
        else:
            x, y, w, h = e.rect
            out.append(f"d={e.d} s={e.s} {ART_NAMES[e.art]} x={x} y={y} w={w} h={h} kern={','.join(map(str, e.kernel))}"
                       f" cov={e.cover[0]}..{e.cover[1]} src_dx={e.src_dx}")
    return out


def generate(conf, outdir, name):
    geo = Geometry(conf)
    geo.atlas_size = layout_atlas(geo)
    content, gid = build_dvg(geo)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, f"{name}.dvg"), "wb") as f:
        f.write(struct.pack("<H", conf["load"] & 0xFFFF) + content)
    bud = compute_budget(geo)
    with open(os.path.join(outdir, f"{name}.geom.json"), "w", encoding="utf-8") as f:
        json.dump(build_json(geo, gid, bud), f, indent=1, ensure_ascii=False)
    with open(os.path.join(outdir, f"{name}.budget.md"), "w", encoding="utf-8") as f:
        f.write(budget_markdown(geo, bud))
    with open(os.path.join(outdir, f"{name}.aseprite"), "wb") as f:
        f.write(build_aseprite(geo, geo.atlas_size))
    write_pngs(geo, outdir, name, conf["zoom"], geo.atlas_size)
    return geo, bud


def main(argv=None):
    ap = argparse.ArgumentParser(description="Sichtfenster-Geometrie erzeugen (DVG, JSON, Vorlagen, Budget)")
    ap.add_argument("toml", nargs="?")
    ap.add_argument("--out")
    ap.add_argument("--name")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--preset")
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--stride", type=int)
    ap.add_argument("--origin", type=int)
    try:
        args = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        base = os.getcwd()
        if args.toml:
            with open(args.toml, "rb") as f:
                try:
                    cfg = tomllib.load(f)
                except tomllib.TOMLDecodeError as e:
                    raise GeomError(f"TOML: {e}")
            base = os.path.dirname(os.path.abspath(args.toml))
        elif args.preset and args.width and args.height:
            vp = {"preset": args.preset, "width_px": args.width, "height": args.height}
            if args.stride is not None:
                vp["stride"] = args.stride
            if args.origin is not None:
                vp["origin"] = args.origin
            cfg = {"viewport": vp}
        else:
            print("Aufruf: dbegeom.py view.toml | --preset P --width W --height H", file=sys.stderr)
            return 2
        conf = parse_config(cfg)
        name = args.name or conf["name"]
        outdir = args.out if args.out else os.path.join(base, conf["dir"])
        if args.check:
            geo = Geometry(conf)
            print("\n".join(check_lines(geo)))
            return 0
        geo, bud = generate(conf, outdir, name)
        print(f"{name}: {len(geo.elements)} Elemente, Wandstil {bud['wall_style']} Byte -> {outdir}")
        return 0
    except GeomError as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
