#!/usr/bin/env python3
"""Perspektivisch korrekte Wand-, Boden- und Deckenbilder aus flachen Mustern (docs/specs/P5-textures.md, 10.3).

Die Engine projiziert nichts: Jedes DVG-Element (Front, Seite, Boden-/Deckenkachel, Band) ist ein fertig gemaltes Bild.
Malt man ein Muster im Bildschirmraum, laufen die Fugen auf Seitenwaenden waagerecht und senkrecht statt zum
Fluchtpunkt. Dieses Modul rechnet fuer jedes Pixel einer Elementmaske die Weltkoordinate aus und wertet das Muster dort aus.

Modell (aus der geom.json: viewport.width_px, planes[k].W/T/B):
  * Weltkoordinaten in Zellen: X seitlich (0 = Mitte), Z Tiefe, Y nach unten. Ebene k liegt bei Z_k = W_1 / W_k (Ebene 1 = 1).
  * Bildschirm: x = C + X * W(Z), W = W_1 / Z, C = width_px / 2. Also ist 1/Z = W / W_1 linear in x, und fuer Boden und Decke
    linear in y (Zeile = Horizont + Y * W; zwischen zwei Ebenen interpoliert linear in der Zeile von B_k nach B_{k+1}).
  * Front (Ebene d): u = X = (x - C) / W_d, v = (y - T_d) / W_d.
  * Seite bei seitlicher Kante e (x - C = e * W): W(x) = (x - C) / e, u = Z = W_1 / W(x), v = (y - top(x)) / W(x),
    top(x) linear in W zwischen T_d und T_{d+1} (die Oberkante des Trapezes). An der Kante Front/Seite ist v gleich.
  * Boden: W(y) linear zwischen W_d bei B_d und W_{d+1} bei B_{d+1}; u = X = (x - C) / W, v = Z = W_1 / W. Decke mit T_k.
Muster sind Funktionen pattern(u, v) -> Palettenindex | None in Zellen (Wand: u entlang der Wand, v nach unten;
Boden/Decke: u seitlich, v in der Tiefe). Je Pixel werden n x n Unterabtastungen gewaehlt; `bias` {Farbe: Gewicht}
laesst duenne Fugen auch dort sichtbar bleiben, wo sie unter ein Pixel schrumpfen.
"""
import math

import dbegeom

PAL = dbegeom.PALETTE


class Persp:
    """Weltabbildung fuer eine Geometrie (geom.json als dict)."""

    def __init__(self, geom):
        self.geom = geom
        self.C = geom["viewport"]["width_px"] / 2
        self.pl = geom["planes"]
        self.W1 = self.pl[1]["W"]

    # Pixel (x, y) -> (u, v) je Elementart; x, y in Bildschirmpixeln (Fliesskomma)
    def front_map(self, d):
        W, T = self.pl[d]["W"], self.pl[d]["T"]
        return lambda x, y: ((x - self.C) / W, (y - T) / W)

    def side_map(self, e):
        d = e["d"]
        a, b = self.pl[d], self.pl[d + 1]
        edge = (e["polygon"][0][0] - self.C) / a["W"]          # seitliche Lage u der Kante, zellbreit

        def fn(x, y):
            W = (x - self.C) / edge
            t = (a["W"] - W) / (a["W"] - b["W"])
            top = a["T"] + (b["T"] - a["T"]) * t
            return self.W1 / W, (y - top) / W
        return fn

    def flat_map(self, d, key):
        """Boden (key 'B') bzw. Decke (key 'T') zwischen den Ebenen d und d+1."""
        a, b = self.pl[d], self.pl[d + 1]

        def fn(x, y):
            W = a["W"] + (b["W"] - a["W"]) * (y - a[key]) / (b[key] - a[key])
            return (x - self.C) / W, self.W1 / W
        return fn

    def element_map(self, e):
        art = e["art"]
        if art == "front":
            return self.front_map(e["d"])
        if art == "side":
            return self.side_map(e)
        if art in ("floor", "floorband"):
            return self.flat_map(e["d"], "B")
        if art in ("ceil", "ceilband"):
            return self.flat_map(e["d"], "T")
        raise ValueError(f"keine Perspektive fuer {art}")


def shade(mapfn, pattern, x0, y0, n=4, bias=None):
    """Farbe des Pixels [x0, x0+1) x [y0, y0+1): gewichtete Mehrheit der n x n Unterabtastungen (None = transparent)."""
    cnt = {}
    for j in range(n):
        for i in range(n):
            u, v = mapfn(x0 + (i + .5) / n, y0 + (j + .5) / n)
            c = pattern(u, v)
            cnt[c] = cnt.get(c, 0) + 1
    best, bw = None, -1
    for c in sorted(cnt, key=lambda c: -1 if c is None else c):
        w = cnt[c] * (bias.get(c, 1) if bias else 1)
        if w > bw:
            best, bw = c, w
    return best


def element_fn(persp, e, pattern, n=4, bias=None):
    """fn(px, r) -> Farbe fuer dbetexdemo._paint (px, r relativ zur Rechteckecke, px in Pixeln)."""
    mp = persp.element_map(e)
    x0, y0 = 2 * e["rect"][0], e["rect"][1]
    return lambda px, r: shade(mp, pattern, x0 + px, y0 + r, n, bias)


def flat_pattern(img, ppc, ox=0.0, oy=0.0, alpha=128):
    """Muster aus einem flachen PNG: ppc = Bildpixel je Zelle (Welteinheit), kachelt in u und v.
    Farben werden auf die naechste Palettenfarbe abgebildet, Alpha < `alpha` ist transparent."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    cache = {}

    def pal(rgb):
        if rgb not in cache:
            cache[rgb] = min(range(16), key=lambda i: sum((a - b) ** 2 for a, b in zip(PAL[i], rgb)))
        return cache[rgb]

    def pattern(u, v):
        r, g, b, a = px[int(math.floor((u + ox) * ppc)) % w, int(math.floor((v + oy) * ppc)) % h]
        return None if a < alpha else pal((r, g, b))
    return pattern


def brick_pattern(bw=0.25, bh=0.0625, joint=0.008, c_joint=14, cols=(12, 8)):
    """Ziegel im Laeuferverband in Zellen (Standard: 4 Ziegel je Zelle, 16 Reihen je Zellhoehe)."""
    def pat(u, v):
        row = math.floor(v / bh)
        rr = v - row * bh
        uu = u + (bw / 2 if row % 2 else 0)
        col = math.floor(uu / bw)
        cc = uu - col * bw
        if rr < joint or cc < joint:
            return c_joint
        return cols[(col + row) % 2]
    return pat
