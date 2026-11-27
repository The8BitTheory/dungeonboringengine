#!/usr/bin/env python3
"""Generate sprite sets for Crawl 128: ghosts (RED.VDC, RED1.VDC) and gems (font characters).

Usage: crawlsprites.py RED.VDC RED1.VDC <output directory>
Output:
  ghosts.vdc  packed ghost images (visible bytes only, in VMS order), copied into VRAM via RTV
  ghost.spr   sprite set ghosts (VMS, transparent), load address $E200
  gem.spr     sprite set gem (VMC from the font, base = character set CA), load address $EA00

Format: docs/formats.md (sprite metadata v1). Positions as in crawl.bas (lines 4670-5000, 6300-6560):
the half images at the sides are completed to full images; occlusion is handled by VIEW.

Transparency: black pixels (0) connected to the image border. Black pixels inside
the figure (eyes) stay opaque.
"""
import os
import struct
import sys

ROW = 80            # row width of the image buffer (EI%)
VIEW_COL0 = 6       # first column of the viewport (406 = 5 * 80 + 6)
ANY = 0xFF

# Ghosts: depth -> (file index, row, {side: column}); columns absolute (relative to AP)
GHOST_POS = {
    1: (0, 53, {0: 36, -1: 9, 1: 59}),
    2: (1, 44, {0: 31, -1: 21, 1: 51}),
}
# Gems: (d, s) -> (row, [(column, font index), ...]); characters 3 x 6 bytes, 18 bytes per character.
# Font index = PETSCII - 32 (as FN TX in crawl.bas): CR$ = CHR$(36)+CHR$(37) are characters 4 and 5.
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
    """Crawl image file: byte 0 count, 7 bytes header each, pixels from offset 29 (with 4 entries)."""
    d = open(path, 'rb').read()[2:]
    n = d[0]
    data = 1 + 7 * n
    imgs = []
    for i in range(n):
        src, w, h, _size, _col = struct.unpack_from('<HBBHB', d, 1 + 7 * i)
        imgs.append((w, h, d[data + src:data + src + w * h]))
    return imgs


def transparent_mask(w, h, px):
    """Pixel grid 2w x h; True = transparent (black and connected to the border)."""
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
    """Per row: (VMS commands with offsets relative to the row, packed bytes)."""
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
    """VMS list (alpha 0, count as word) and packed bytes for a whole image."""
    cmds, packed = [], bytearray()
    for r, (rc, rp) in enumerate(vms_rows(w, h, px)):
        cmds += [(k, r, c, n) for k, c, n in rc]
        packed += rp
    lst = bytearray((0,)) + struct.pack('<H', len(cmds))
    for k, r, c, ln in cmds:
        lst += struct.pack('<BH', k, r * ROW + c) + (bytes((ln,)) if k == 1 else b'')
    return bytes(lst), bytes(packed)


def write_spr(path, load, parts, lists):
    """parts: (d, s, angle, flags, w, h, src, dest, col, list_index or None)"""
    head = b'SP' + bytes((1, len(parts), 0, 0))
    ofs = len(head) + 15 * len(parts)
    lofs = []
    for l in lists:
        lofs.append(ofs)
        ofs += len(l)
    out = bytearray(head)
    for d, s, ang, flags, w, h, src, dest, col, li in parts:
        ll, lo = (len(lists[li]), lofs[li]) if li is not None else (0, 0)
        out += struct.pack('<BbBBBBHHBHH', d, s, ang, flags, w, h, src, dest, col, ll, lo)
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
            lst, data = vms_pack(w, h, px)
            src = len(packed)
            packed += data
            lists.append(lst)
            for s, col in cols.items():
                parts.append((d, s, ang, 1, w, h, src, row * ROW + col, col - VIEW_COL0, len(lists) - 1))
    with open(os.path.join(outdir, 'ghosts.vdc'), 'wb') as f:
        f.write(struct.pack('<H', 0x2000) + packed)
    n = write_spr(os.path.join(outdir, 'ghost.spr'), 0xE200, parts, lists)
    print(f'ghost.spr: {len(parts)} parts, {len(lists)} lists ({min(map(len, lists))}-{max(map(len, lists))} bytes), {n} bytes; ghosts.vdc {len(packed)} bytes')
    gparts = []
    for (d, s), (row, chars) in GEM_POS.items():
        for col, ch in chars:
            gparts.append((d, s, ANY, 0, CHAR_W, CHAR_H, ch * CHAR_W * CHAR_H, row * ROW + col, col - VIEW_COL0, None))
    n = write_spr(os.path.join(outdir, 'gem.spr'), 0xEA00, gparts, [])
    print(f'gem.spr: {len(gparts)} parts, {n} bytes')


if __name__ == '__main__':
    main()
