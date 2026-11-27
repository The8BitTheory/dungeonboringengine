#!/usr/bin/env python3
"""Perspective-correct wall, floor and ceiling images from flat patterns (docs/specs/P5-textures.md, 10.3).

The engine projects nothing: every DVG element (front, side, floor/ceiling tile, band) is a finished painted image.
If a pattern is painted in screen space, the joints on side walls run horizontally and vertically instead of
toward the vanishing point. This module computes the world coordinate for every pixel of an element mask and
evaluates the pattern there.

Model (from geom.json: viewport.width_px, planes[k].W/T/B):
  * World coordinates in cells: X sideways (0 = center), Z depth, Y downward. Plane k lies at Z_k = W_1 / W_k (plane 1 = 1).
  * Screen: x = C + X * W(Z), W = W_1 / Z, C = width_px / 2. So 1/Z = W / W_1 is linear in x, and for floor and ceiling
    linear in y (row = horizon + Y * W; between two planes it interpolates linearly in the row from B_k to B_{k+1}).
  * Front (plane d): u = X = (x - C) / W_d, v = (y - T_d) / W_d.
  * Side at lateral edge e (x - C = e * W): W(x) = (x - C) / e, u = Z = W_1 / W(x), v = (y - top(x)) / W(x),
    top(x) linear in W between T_d and T_{d+1} (the upper edge of the trapezoid). At the front/side edge v is equal.
  * Floor: W(y) linear between W_d at B_d and W_{d+1} at B_{d+1}; u = X = (x - C) / W, v = Z = W_1 / W. Ceiling with T_k.
Patterns are functions pattern(u, v) -> palette index | None in cells (wall: u along the wall, v downward;
floor/ceiling: u sideways, v in depth). For each pixel n x n subsamples are taken; `bias` {color: weight}
keeps thin joints visible even where they shrink below one pixel.
"""
import math

import dbegeom

PAL = dbegeom.PALETTE


class Persp:
    """World mapping for one geometry (geom.json as dict)."""


    def __init__(self, geom):
        self.geom = geom
        self.C = geom["viewport"]["width_px"] / 2
        self.pl = geom["planes"]
        self.W1 = self.pl[1]["W"]

    # pixel (x, y) -> (u, v) per element kind; x, y in screen pixels (floating point)
    def front_map(self, d):
        W, T = self.pl[d]["W"], self.pl[d]["T"]
        return lambda x, y: ((x - self.C) / W, (y - T) / W)

    def side_map(self, e):
        d = e["d"]
        a, b = self.pl[d], self.pl[d + 1]
        edge = (e["polygon"][0][0] - self.C) / a["W"]          # lateral position u of the edge, in cell widths

        def fn(x, y):
            W = (x - self.C) / edge
            t = (a["W"] - W) / (a["W"] - b["W"])
            top = a["T"] + (b["T"] - a["T"]) * t
            return self.W1 / W, (y - top) / W
        return fn

    def flat_map(self, d, key):
        """Floor (key 'B') or ceiling (key 'T') between planes d and d+1."""
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
        raise ValueError(f"no perspective for {art}")


def shade(mapfn, pattern, x0, y0, n=4, bias=None):
    """Color of the pixel [x0, x0+1) x [y0, y0+1): weighted majority of the n x n subsamples (None = transparent)."""
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
    """fn(px, r) -> color for dbetexdemo._paint (px, r relative to the rectangle corner, px in pixels)."""
    mp = persp.element_map(e)
    x0, y0 = 2 * e["rect"][0], e["rect"][1]
    return lambda px, r: shade(mp, pattern, x0 + px, y0 + r, n, bias)


def flat_pattern(img, ppc, ox=0.0, oy=0.0, alpha=128):
    """Pattern from a flat PNG: ppc = image pixels per cell (world unit), tiles in u and v.
    Colors are mapped to the nearest palette color, alpha < `alpha` is transparent."""
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
    """Bricks in stretcher bond in cells (default: 4 bricks per cell, 16 rows per cell height)."""
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
