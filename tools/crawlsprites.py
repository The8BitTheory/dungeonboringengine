#!/usr/bin/env python3
"""Sprite-Sätze für Crawl 128 erzeugen: Geister (RED.VDC, RED1.VDC) und Edelsteine (Font-Zeichen).

Aufruf: crawlsprites.py RED.VDC RED1.VDC <ausgabeordner>
Ausgabe:
  ghosts.vdc  gepackte Geisterbilder (nur sichtbare Bytes, in VMS-Reihenfolge), per RTV ins VRAM
  ghost.spr   Sprite-Satz Geister (VMS, transparent), Ladeadresse $E200
  gem.spr     Sprite-Satz Edelstein (VMC aus dem Font, Basis = Zeichensatz CA), Ladeadresse $EA00

Format: docs/formats.md (Sprite-Metadaten v1). Positionen wie in crawl.bas (Zeilen 4670-5000, 6300-6560):
die Halbbilder an den Seiten werden zu ganzen Bildern ergänzt; Verdecken übernimmt VIEW.

Transparenz: schwarze Pixel (0), die mit dem Bildrand verbunden sind. Schwarze Pixel innerhalb
der Figur (Augen) bleiben deckend.
"""
import os
import struct
import sys

ROW = 80            # Zeilenbreite des Bildpuffers (EI%)
VIEW_COL0 = 6       # erste Spalte des Sichtfensters (406 = 5 * 80 + 6)
ANY = 0xFF

# Geister: Tiefe -> (Datei-Index, Zeile, {Seite: Spalte}); Spalten absolut (relativ zu AP)
GHOST_POS = {
    1: (0, 53, {0: 36, -1: 9, 1: 59}),
    2: (1, 44, {0: 31, -1: 21, 1: 51}),
}
# Edelsteine: (d, s) -> (Zeile, [(Spalte, Font-Index), ...]); Zeichen 3 x 6 Byte, 18 Byte je Zeichen.
# Font-Index = PETSCII - 32 (wie FN TX in crawl.bas): CR$ = CHR$(36)+CHR$(37) sind die Zeichen 4 und 5.
GEM_POS = {
    (1, 0): (80, [(40, 4), (43, 5)]),
    (1, -1): (74, [(12, 4), (15, 5)]),
    (1, 1): (74, [(62, 4), (65, 5)]),
    (2, 0): (64, [(40, 4), (43, 5)]),
    (2, -1): (61, [(22, 4), (25, 5)]),
    (2, 1): (61, [(52, 4), (55, 5)]),
}
CHAR_W, CHAR_H = 3, 6


def read_vdc(path):
    """Crawl-Bilddatei: Byte 0 Anzahl, je 7 Byte Kopf, Pixel ab Offset 29 (bei 4 Einträgen)."""
    d = open(path, 'rb').read()[2:]
    n = d[0]
    data = 1 + 7 * n
    imgs = []
    for i in range(n):
        src, w, h, _size, _col = struct.unpack_from('<HBBHB', d, 1 + 7 * i)
        imgs.append((w, h, d[data + src:data + src + w * h]))
    return imgs


def transparent_mask(w, h, px):
    """Pixelraster 2w x h; True = transparent (schwarz und mit dem Rand verbunden)."""
    W = 2 * w
    val = [[(px[r * w + c // 2] >> (4 if c % 2 == 0 else 0)) & 15 for c in range(W)] for r in range(h)]
    t = [[False] * W for _ in range(h)]
    stack = [(r, c) for r in range(h) for c in range(W) if (r in (0, h - 1) or c in (0, W - 1)) and val[r][c] == 0]
    while stack:
        r, c = stack.pop()
        if t[r][c] or val[r][c] != 0:
            continue
        t[r][c] = True
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < W and not t[rr][cc] and val[rr][cc] == 0:
                stack.append((rr, cc))
    return t


def vms_rows(w, h, px):
    """Je Zeile: (VMS-Befehle mit Offsets relativ zur Zeile, gepackte Bytes)."""
    t = transparent_mask(w, h, px)
    rows = []
    for r in range(h):
        cmds, packed = [], bytearray()
        c = 0
        while c < w:
            b = px[r * w + c]
            lt, rt = t[r][2 * c], t[r][2 * c + 1]
            if lt and rt:
                c += 1
                continue
            half = (rt and not lt) or (lt and not rt and (b & 15) != 0)
            if half:
                cmds.append((8, c, 0))
                packed.append(b)
                c += 1
                continue
            start = c
            while c < w:
                b = px[r * w + c]
                lt, rt = t[r][2 * c], t[r][2 * c + 1]
                opaque = not (lt or rt) or (lt and not rt and (b & 15) == 0)
                if not opaque:
                    break
                c += 1
            cmds.append((1, start, c - start))
            packed += px[r * w + start:r * w + c]
        rows.append((cmds, bytes(packed)))
    return rows


def vms_pack(w, h, px):
    """Bild in Zeilenblöcke teilen, deren VMS-Liste (Alpha 0) höchstens 256 Byte lang ist.
    Ergebnis: [(erste Zeile, Zeilenzahl, Liste, gepackte Bytes), ...]"""
    blocks, r0, cmds, packed, length = [], 0, [], bytearray(), 2
    for r, (rc, rp) in enumerate(vms_rows(w, h, px)):
        rl = sum(4 if k == 1 else 3 for k, _c, _n in rc)
        if length + rl > 256 or len(cmds) + len(rc) > 255:
            blocks.append((r0, r - r0, cmds, bytes(packed)))
            r0, cmds, packed, length = r, [], bytearray(), 2
        cmds += [(k, r - r0, c, n) for k, c, n in rc]
        packed += rp
        length += rl
    blocks.append((r0, h - r0, cmds, bytes(packed)))
    out = []
    for r0, n, cmds, data in blocks:
        lst = bytearray((0, len(cmds)))
        for k, r, c, ln in cmds:
            lst += struct.pack('<BH', k, r * ROW + c) + (bytes((ln,)) if k == 1 else b'')
        out.append((r0, n, bytes(lst), data))
    return out


def write_spr(path, load, parts, lists):
    """parts: (d, s, angle, flags, w, h, src, dest, col, list_index or None)"""
    head = b'SP' + bytes((1, len(parts), 0, 0))
    ofs = len(head) + 14 * len(parts)
    lofs = []
    for l in lists:
        lofs.append(ofs)
        ofs += len(l)
    out = bytearray(head)
    for d, s, ang, flags, w, h, src, dest, col, li in parts:
        ll, lo = (len(lists[li]), lofs[li]) if li is not None else (0, 0)
        out += struct.pack('<BbBBBBHHBBH', d, s, ang, flags, w, h, src, dest, col, ll, lo)
    out += b''.join(lists)
    with open(path, 'wb') as f:
        f.write(struct.pack('<H', load) + out)
    return len(out)


def main():
    red, red1, outdir = sys.argv[1:4]
    files = [read_vdc(red), read_vdc(red1)]
    parts, lists, packed = [], [], bytearray()
    for d, (fi, row, cols) in GHOST_POS.items():
        for ang, (w, h, px) in enumerate(files[fi]):
            for r0, n, lst, data in vms_pack(w, h, px):
                src = len(packed)
                packed += data
                lists.append(lst)
                for s, col in cols.items():
                    parts.append((d, s, ang, 1, w, n, src, (row + r0) * ROW + col, col - VIEW_COL0, len(lists) - 1))
    with open(os.path.join(outdir, 'ghosts.vdc'), 'wb') as f:
        f.write(struct.pack('<H', 0x2000) + packed)
    n = write_spr(os.path.join(outdir, 'ghost.spr'), 0xE200, parts, lists)
    print(f'ghost.spr: {len(parts)} Teile, {len(lists)} Listen ({min(map(len, lists))}-{max(map(len, lists))} Byte), {n} Byte; ghosts.vdc {len(packed)} Byte')
    gparts = []
    for (d, s), (row, chars) in GEM_POS.items():
        for col, ch in chars:
            gparts.append((d, s, ANY, 0, CHAR_W, CHAR_H, ch * CHAR_W * CHAR_H, row * ROW + col, col - VIEW_COL0, None))
    n = write_spr(os.path.join(outdir, 'gem.spr'), 0xEA00, gparts, [])
    print(f'gem.spr: {len(gparts)} Teile, {n} Byte')


if __name__ == '__main__':
    main()
