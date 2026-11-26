#!/usr/bin/env python3
"""Tapete der Demo: Panorama "Landschaft" aus tree1-3.bmp und water1-4.bmp (Crawl-Grafiken, siehe demo/README.md).

Aufruf: mkbg.py OUT.png [--geom GEOM.json] [--rows N]
  Das Panorama ist 2 * P Pixel breit (P = 2 * VW Byte, wie test/vice_view.py) und N Zeilen hoch (Standard 36); es liegt
  mit y0 = 14 im Sichtfenster (bg.toml); der Horizont (Fensterzeile 34 = Mitte des Horizontbands 22 .. 44) ist die
  Panoramazeile 20.
  Himmel ueber dem Panorama kommt aus `above` (Farbe 3), unter dem Panorama aus `below` (0, Abgrund): bg.toml.
Das Panorama zeichnet zyklisch (wrap): Baeume und Wasser werden modulo Breite gemalt, der Rand ist unsichtbar.
Farben nur aus der VDC-Palette (dbegeom.PALETTE); Transparenz der Quellbilder (255, 85, 255) wird nicht uebernommen.
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'tools'))
import dbegeom
from PIL import Image

ART = os.path.join(HERE, 'art')
KEY = (255, 85, 255)
SKY, HILL, GRASS, DGRASS, WATER = 3, 1, 4, 5, 6
PAL = dbegeom.PALETTE


def sprite(name):
    im = Image.open(os.path.join(ART, name)).convert('RGB')
    return im, im.load()


def paint(px, W, H, x0, y0, name, only_below=None):
    """Quellbild an (x0, y0) malen (links oben), Transparenz = KEY; x zyklisch."""
    im, sp = sprite(name)
    for y in range(im.height):
        for x in range(im.width):
            c = sp[x, y]
            if c == KEY or not 0 <= y0 + y < H:
                continue
            if only_below is not None and y0 + y < only_below:
                continue
            px[(x0 + x) % W, y0 + y] = c


def build(rows=36, vw=70):
    P = 2 * vw
    W, H = 2 * P, rows
    HZ = 20                                       # Horizont: Panoramazeile
    im = Image.new('RGB', (W, H), PAL[SKY])
    px = im.load()
    # Huegel (dunkelgrau) hinter allem: Dreiecke mit Spitze (x, Zeile) und Flanken 3 : 4, Fuss auf Zeile HZ + 4
    peaks = [(30, 10), (90, 6), (150, 12), (215, 7), (262, 11)]
    for x in range(W):
        tops = [py + abs(x - q) * 3 // 4 for q, py in peaks]
        for y in range(min(tops + [HZ + 4]), HZ + 4):
            px[x, y] = PAL[HILL]
    # Boden: dunkelgruen ab Horizont + 4, Rasenpunkte
    for y in range(HZ + 4, H):
        for x in range(W):
            px[x, y] = PAL[GRASS if (x * 7 + y * 13) % 11 else DGRASS]
    # See: Sektor 150 .. 250, Wasser (cyan) mit Wasser-Kacheln als Wellenkante
    for y in range(HZ + 4, H):
        for x in range(150, 250):
            px[x, y] = PAL[6]
    for x0 in range(150, 250, 16):
        paint(px, W, H, x0, HZ + 4, 'water4.bmp')
    for x0, y0 in ((158, HZ + 11), (200, HZ + 9), (232, HZ + 12)):
        paint(px, W, H, x0, y0, 'water2.bmp')
    # Baeume (Fuss auf Zeile 31 bzw. 33)
    for x0, y0, n in ((6, -1, 'tree1.bmp'), (50, 1, 'tree2.bmp'), (92, -1, 'tree3.bmp'), (122, 2, 'tree1.bmp'),
                      (262 - 12, 0, 'tree2.bmp'), (268, 1, 'tree3.bmp')):
        paint(px, W, H, x0, y0, n)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--geom')
    ap.add_argument('--rows', type=int, default=36)
    a = ap.parse_args()
    vw = 70
    if a.geom:
        vw = json.load(open(a.geom))['viewport']['width_px'] // 2
    im = build(a.rows, vw)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    im.save(a.out)
    print(f'{a.out}: {im.width} x {im.height} Pixel, P = {im.width // 4 * 2} Byte')


if __name__ == '__main__':
    main()
