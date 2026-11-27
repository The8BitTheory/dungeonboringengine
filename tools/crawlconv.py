#!/usr/bin/env python3
"""Convert Crawl 128 data (1.0f, engine 0.1) into engine 0.2 files (P7a, docs/specs/P7-crawl.md section 3).

Inputs (1.0f files, unchanged): walls.vdc, walls.wsm, ghost.spr, ghosts.vdc, gem.spr, font3o.vdc
(optionally crawl128.cd1 for crawl.dmp and the size of the automap).
Free Crawl DVG instead of the Westwood preset (review-notes G.6): each of the 19 wall images is a DVG element with its
rectangle, the DTS contains only cores (image = one core = full rectangle), ghosts and gems are S2 images with
anchors at the 1.0f positions. The wallpaper is the fill byte 0 (BGSET without DBG).

Output in OUT_DIR:
  crawl.dvg          geometry (bank 1 $E800)
  walls.dts          wall DTS, cores only (bank 1 $8000)
  walls.vrl | walls1.vrl ... wallsN.vrl   image data via RXV to DA (several parts with --max-part)
  ghost.s2 + ghost.vrl   sprite set ghost (bank 1 $6000)
  gem.s2 + gem.vrl       sprite set gem (bank 1 $7000)
  crawl.dmp          map (only with crawl128.cd1; crawlmap, bank 1 $4000)
  crawlconv.md       report;  crawlconv.json with --json

Usage:
  crawlconv.py --d81 crawl128-100f.d81 OUT_DIR [--max-part N] [--font-bytes N] [--json]
  crawlconv.py --dir DIR_WITH_THE_FILES OUT_DIR [...]
As a module: build(files, ...) -> Result, write(result, out_dir), read_dir(dir), read_d81(image, work_dir).
Exit code 0 ok, 1 error, 2 usage.
"""
import argparse
import dataclasses
import json
import os
import struct
import subprocess
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crawlmap  # noqa: E402
import dbemap  # noqa: E402
import dbemem  # noqa: E402
import dbespr  # noqa: E402
import dbetex  # noqa: E402
import dbeview  # noqa: E402
import vrl  # noqa: E402
import wallconv  # noqa: E402
from dbeview import DepthRow, Dvg, Elem  # noqa: E402

FILES = ("walls.vdc", "walls.wsm", "ghost.spr", "ghosts.vdc", "gem.spr", "font3o.vdc")
OPTIONAL = ("crawl128.cd1",)

VW, VH, D, S = 68, 96, 3, 1
STRIDE, ORIGIN = 80, 406
HY0, HY1 = 0, 95                      # row 95 of the window stays with the walls (screen row 100, spec 1.2)
FULL = 96                             # height of the covering images
VIEW_COL0, VIEW_ROW0 = 6, 5           # top left corner of the window in the 1.0f image buffer (406 = 5 * 80 + 6)
ROW = 80
LOAD = {"dvg": 0xE800, "wall": 0x8000, "ghost": 0x6000, "gem": 0x7000, "dmp": 0x4000}
S2_MAX = 0x1000                       # area per sprite set up to the next load address
CA = 19200                            # character set in VRAM (AP + VR(1) + VR(1))
VR0 = 46335                           # screen RAM (bitmap)
GEM_CHARS = (4, 5)                    # font characters of the gem (CHR$(36) CHR$(37))
GHOST_ANGLES = 4
MASK_BG = (0x00, 0xFF)                # two background patterns for the transparency mask (3.4)
P_GEM, P_GHOST = 2, 3                 # object slots: center = gem, front left = ghost


class ConvError(Exception):
    pass


# ---------------------------------------------------------------- read inputs

def read_dir(path):
    """Files from a folder (names in lower case) -> {name: bytes}."""
    out = {}
    for n in FILES + OPTIONAL:
        p = os.path.join(path, n)
        if os.path.exists(p):
            with open(p, "rb") as f:
                out[n] = f.read()
        elif n in FILES:
            raise ConvError(f"{n} missing in {path}")
    return out


def read_d81(image, work_dir):
    """Read files from the image via c1541 (work_dir: working folder below OUT_DIR)."""
    os.makedirs(work_dir, exist_ok=True)
    for n in FILES + OPTIONAL:
        out = os.path.join(work_dir, n)
        if os.path.exists(out):
            os.remove(out)
        r = subprocess.run(["c1541", "-attach", image, "-read", n, out], capture_output=True, text=True)
        if not os.path.exists(out) and n in FILES:
            raise ConvError(f"c1541 could not read {n} from {image}: {(r.stderr or r.stdout).strip()}")
    return read_dir(work_dir)


def parse_walls(data):
    """walls.vdc (PRG) -> (entries [(slot, src, w, h, size, col)], image data from 1 + 7 n)."""
    b = data[2:]
    n = b[0]
    hdr = 1 + 7 * n
    ents = []
    for i in range(n):
        src, w, h, size, col = struct.unpack_from("<HBBHB", b, 1 + 7 * i)
        if src + w * h > len(b) - hdr or size != w * h:
            raise ConvError(f"walls.vdc: image {i + 1} (src {src}, {w} x {h}, size {size}) does not fit in the file")
        ents.append((i + 1, src, w, h, size, col))
    if n != len(wallconv.SLOTS):
        raise ConvError(f"walls.vdc: {n} images, expected {len(wallconv.SLOTS)}")
    return ents, bytes(b[hdr:])


def parse_spr(data):
    """ghost.spr / gem.spr (PRG, sprite metadata v1) -> list of parts (dict)."""
    b = data[2:]
    if b[:2] != b"SP" or b[2] != 1:
        raise ConvError("SPR: Magic/Version")
    parts = []
    for i in range(b[3]):
        d, s, ang, fl, w, h, src, dest, col, ll, lo = struct.unpack_from("<BbBBBBHHBHH", b, 6 + 15 * i)
        parts.append(dict(d=d, s=s, angle=ang, flags=fl, w=w, h=h, src=src, dest=dest, col=col,
                          list=bytes(b[lo:lo + ll]) if ll else b""))
    return parts


# ---------------------------------------------------------------- DVG

def _anchor(dest):
    """Target (relative to AP) -> (byte column, row) relative to the window."""
    return dest % ROW - VIEW_COL0, dest // ROW - VIEW_ROW0


def wall_elements(walls):
    """Wall images grouped by cell (d, s), per cell first fronts, then sides, per kind in slot order."""
    by_cell = {}
    for slot, src, w, h, _size, col in walls:
        d, s, face = wallconv.SLOTS[slot]
        by_cell.setdefault((d, s), []).append((face, slot, src, w, h, col))
    for lst in by_cell.values():
        lst.sort()
    return by_cell


def build_dvg(walls, ghost_anchor, gem_anchor):
    """-> (Dvg, wall_order); wall_order = [(slot_nr, src, w, h)] in element order (= slot order in the DTS)."""
    by_cell = wall_elements(walls)
    elems, order, depth = [], [], []
    for d in range(D + 1):
        first = len(elems)
        fw = fx = 0
        for s in (0, -1, 1):
            lst = by_cell.get((d, s), [])
            for face, slot, src, w, h, col in lst:
                art = dbeview.ART_FRONT if face == wallconv.FRONT else dbeview.ART_SIDE
                full = h == FULL
                fl = (1 if full else 0) | (8 if full and art == dbeview.ART_FRONT else 0)
                e = Elem(len(elems), art, d, s, fl, x=col, y=0, w=w, h=h, kx=0, ky=0, kw=w, kh=h,
                         c0=col if full else 0, c1=col + w if full else 0)
                elems.append(e)
                order.append((slot, src, w, h))
                if art == dbeview.ART_FRONT and s == 0:
                    fw, fx = w, col
            if d >= 1:
                ga, ma = ghost_anchor[min(d, 2)][s], gem_anchor[min(d, 2)][s]
                anchors = [ma, ma, ma, ga, ma]
                assert anchors[P_GEM] == ma and anchors[P_GHOST] == ga
                elems.append(Elem(len(elems), dbeview.ART_OBJ, d, s, 0, anchors=anchors))
        depth.append(DepthRow(0, 0, 0, 0, first, len(elems) - first, fw, fx))
    dvg = Dvg(VW, VH, D, S, STRIDE, ORIGIN, 0, HY0, HY1, depth, elems)
    content = dbeview.dvg_bytes(dvg)[2:]
    dvg.gid = dbetex.dvg_id(content)
    return dvg, order


# ---------------------------------------------------------------- DTS

def build_dts(dvg, order, vram):
    """Wall DTS, cores only: image k = slot k = k-th wall element; VRAM data = the image data of walls.vdc."""
    smap, k = [], 0
    for e in dvg.elems:
        if e.art == dbeview.ART_OBJ:
            smap.append(dbetex.FALLBACK)
        else:
            smap.append(k)
            k += 1
    smap += [dbetex.FALLBACK] * (2 * (dvg.D + 1))
    entries = []
    for k, (slot, src, w, h) in enumerate(order):
        entries.append(dbetex.Entry(k, dbetex.F_OCCLUDING if h == FULL else 0, [dbetex.Core(src, 0, 0, w, h, 0)], h=h))
    ts = dbetex.TexSet(0, dvg.gid, len(dvg.elems), dvg.D, dvg.stride, smap, [list(range(len(order)))], entries,
                       bytes(vram))
    prg = dbetex.to_dts(ts, LOAD["wall"])
    ts2 = dbetex.from_dts(prg, vram)
    return prg, ts2


# ---------------------------------------------------------------- S2: ghost and gem

def _ghost_mask(vram, part):
    """Pixel rows (palette index or None) of the ghost part: render twice with sim_vms on different backgrounds,
    a pixel is opaque if both runs show the same value (3.4)."""
    w, h = part["w"], part["h"]
    runs = []
    for bg in MASK_BG:
        fb = bytearray([bg]) * (ROW * (h + 1))
        dbetex.sim_vms(vram, part["src"], 0, part["list"], fb=fb)
        runs.append(fb)
    rows = []
    for r in range(h):
        line = []
        for bx in range(w):
            a, b = runs[0][r * ROW + bx], runs[1][r * ROW + bx]
            line += [(a >> 4) if a >> 4 == b >> 4 else None, (a & 15) if a & 15 == b & 15 else None]
        rows.append(line)
    return rows


def build_ghost(gparts, ghost_vram, gid):
    """-> (S2 PRG, VRAM data, SpriteSet, {(d, s, angle): rows}); check: sides equal the center."""
    mid = {}
    for p in gparts:
        if p["flags"] != 1 or p["w"] > 127:
            raise ConvError(f"ghost.spr: part {(p['d'], p['s'], p['angle'])} is not a VMS part")
        key = (p["d"], p["angle"])
        sig = (p["w"], p["h"], p["src"], p["list"])
        if p["s"] == 0:
            mid[key] = sig
    for p in gparts:
        if (p["w"], p["h"], p["src"], p["list"]) != mid.get((p["d"], p["angle"])):
            raise ConvError(f"ghost.spr: part {(p['d'], p['s'], p['angle'])} differs from (d, 0, a) (list/data)")
    images, rows_by = {}, {}
    for p in gparts:
        if p["s"] != 0:
            continue
        rows = _ghost_mask(ghost_vram, p)
        rows_by[(p["d"], p["angle"])] = rows
        images[(0, p["angle"], p["d"])] = (rows, 0, 0)
    if sorted({d for d, _ in rows_by}) != [1, 2] or {a for _, a in rows_by} != set(range(GHOST_ANGLES)):
        raise ConvError("ghost.spr: expects depths 1 and 2 and view angles 0-3")
    prg, vram = dbeview.make_s2(images, D, GHOST_ANGLES, 1, STRIDE, angle_map=[0, 1, 2, 3], gid=gid, max_cores=16,
                                load=LOAD["ghost"])
    return prg, vram, dbeview.read_s2(prg, vram), rows_by


def build_gem(font, gid):
    """One image 6 x 6 bytes from the font characters 4 and 5 (3 bytes x 6 rows each), fully opaque."""
    rows = []
    for r in range(6):
        line = []
        for ch in GEM_CHARS:
            for b in font[ch * 18 + 3 * r:ch * 18 + 3 * r + 3]:
                line += [b >> 4, b & 15]
        rows.append(line)
    images = {(0, 0, d): (rows, 0, 0) for d in (1, 2)}
    prg, vram = dbeview.make_s2(images, D, 1, 1, STRIDE, angle_map=[0, 0, 0, 0], gid=gid, flags=1, max_cores=16,
                                load=LOAD["gem"])
    return prg, vram, dbeview.read_s2(prg, vram)


def anchors_from_parts(ghost_parts, gem_parts):
    """Anchors per depth (1, 2) and side: ghost = corner of the part (d, s, 0), gem = corner of the first character."""
    ga = {d: {} for d in (1, 2)}
    ma = {d: {} for d in (1, 2)}
    for p in ghost_parts:
        if p["angle"] == 0:
            ga[p["d"]][p["s"]] = _anchor(p["dest"])
    by = {}
    for p in gem_parts:
        by.setdefault((p["d"], p["s"]), []).append(p)
    for (d, s), ps in by.items():
        if len(ps) != 2 or [q["src"] for q in ps] != [c * 18 for c in GEM_CHARS]:
            raise ConvError(f"gem.spr: cell {(d, s)}: expects the font characters {GEM_CHARS}")
        a, b = ps
        if (b["dest"] != a["dest"] + 3 or (a["w"], a["h"], b["w"], b["h"]) != (3, 6, 3, 6)
                or a["flags"] or b["flags"] or a["angle"] != 0xFF):
            raise ConvError(f"gem.spr: cell {(d, s)}: second character not 3 bytes to the right")
        ma[d][s] = _anchor(a["dest"])
    for t in (ga, ma):
        for d in (1, 2):
            if sorted(t[d]) != [-1, 0, 1]:
                raise ConvError(f"anchors for depth {d} incomplete: {sorted(t[d])}")
    return ga, ma


# ---------------------------------------------------------------- VRL, parts

def vrl_parts(vram, bounds, max_part):
    """VRL files (PRG frame). max_part 0 = one file; otherwise parts at image boundaries (bounds = starts of the images),
    each part begins (except at offset 0) with a skip to its offset so that all parts go to the same
    target (RXV BE+5,DA). An image that alone is already larger than max_part forms a part of its own."""
    whole = vrl.pack_file(vrl.encode(list(vram)))
    if not max_part or len(whole) <= max_part:
        return [whole]
    cuts = sorted(set(bounds) | {0})
    cuts = [c for c in cuts if c < len(vram)] + [len(vram)]

    def pack(a, b):
        return vrl.pack_file(vrl.encode([None] * cuts[a] + list(vram[cuts[a]:cuts[b]])))
    parts, si = [], 0
    while si < len(cuts) - 1:
        ei, f = si + 1, pack(si, si + 1)
        while ei + 1 < len(cuts):
            g = pack(si, ei + 1)
            if len(g) > max_part:
                break
            ei, f = ei + 1, g
        parts.append(f)
        si = ei
    return parts


# ---------------------------------------------------------------- overall conversion

@dataclass
class Result:
    files: dict = field(default_factory=dict)         # file name -> bytes
    dvg: object = None
    dts: object = None
    ghost: object = None
    gem: object = None
    ghost_rows: dict = field(default_factory=dict)
    wall_vram: bytes = b""
    ghost_vram: bytes = b""
    gem_vram: bytes = b""
    info: dict = field(default_factory=dict)
    anchors: dict = field(default_factory=dict)
    nparts: int = 1


def build(files, max_part=0, font_bytes=None):
    """files: input files (read_dir/read_d81). ConvError on errors.
    font_bytes: length of the character set in VRAM; default = file length of font3o.vdc without the 2 bytes load address."""
    if font_bytes is None:
        font_bytes = len(files["font3o.vdc"]) - 2
    walls, wvram = parse_walls(files["walls.vdc"])
    # Cross-check against walls.wsm (position, faces, columns): the file of the 1.0f disk must match walls.vdc
    wsm_ents = [(e[1], e[2], e[3], e[4], e[5], e[6], e[7]) for e in wsm_entries(files["walls.wsm"]) if not e[3] & 0x80]
    mine = sorted((SL(slot)[0], SL(slot)[1], 1 if h == FULL else 0, w, h, src, wallconv.DEST_BASE + col)
                  for slot, src, w, h, _s, col in walls)
    if sorted(wsm_ents) != mine:
        raise ConvError("walls.wsm does not match walls.vdc")
    gparts = parse_spr(files["ghost.spr"])
    mparts = parse_spr(files["gem.spr"])
    ga, ma = anchors_from_parts(gparts, mparts)
    ga[3], ma[3] = ga[2], ma[2]
    ghost_vram = bytes(files["ghosts.vdc"][2:])
    font = bytes(files["font3o.vdc"][2:])
    dvg, order = build_dvg(walls, ga, ma)
    dvg_prg = dbeview.dvg_bytes(dvg, LOAD["dvg"])
    dvg2 = dbeview.parse_dvg(dvg_prg)
    if dvg2.gid == 0 or dbetex.dvg_id(dvg_prg[2:]) != dvg2.gid:
        raise ConvError("geometry ID wrong")
    err = dbemem.range_error("dvg", LOAD["dvg"], len(dvg_prg) - 2)
    if err:
        raise ConvError(err)
    dts_prg, ts = build_dts(dvg2, order, wvram)
    err = dbemem.range_error("wall", LOAD["wall"], len(dts_prg) - 2)
    if err:
        raise ConvError(err)
    gprg, gv, gss, rows_by = build_ghost(gparts, ghost_vram, dvg2.gid)
    eprg, ev, ess = build_gem(font, dvg2.gid)
    for name, prg in (("ghost.s2", gprg), ("gem.s2", eprg)):
        if len(prg) - 2 > S2_MAX:
            raise ConvError(f"{name}: {len(prg) - 2} bytes > ${S2_MAX:X}")
    r = Result(dvg=dvg2, dts=ts, ghost=gss, gem=ess, ghost_rows=rows_by, wall_vram=wvram, ghost_vram=gv, gem_vram=ev,
               anchors={"ghost": ga, "gem": ma})
    f = r.files
    f["crawl.dvg"], f["walls.dts"], f["ghost.s2"], f["gem.s2"] = dvg_prg, dts_prg, gprg, eprg
    bounds = sorted(src for _slot, src, _w, _h in order)
    wparts = vrl_parts(wvram, bounds, max_part)
    r.nparts = len(wparts)
    if len(wparts) == 1:
        f["walls.vrl"] = wparts[0]
    else:
        for i, p in enumerate(wparts):
            f[f"walls{i + 1}.vrl"] = p
    f["ghost.vrl"] = vrl.pack_file(vrl.encode(list(gv)))
    f["gem.vrl"] = vrl.pack_file(vrl.encode(list(ev)))
    # map
    mw = mh = None
    if "crawl128.cd1" in files:
        m, warn = crawlmap.convert(files["crawl128.cd1"])
        dmp = dbemap.to_dmp(m, LOAD["dmp"])
        dbemap.check_bank1(LOAD["dmp"], len(dmp) - 2)
        f["crawl.dmp"] = dmp
        mw, mh = m.width, m.height
    mw, mh = mw or 20, mh or 11
    # VRAM total (2.3)
    da = CA + font_bytes
    g0 = da + len(wvram)
    g1 = g0 + len(gv)
    ma_ = g1 + len(ev)
    end = ma_ + 2 * mw * mh
    r.info = dict(font_bytes=font_bytes, CA=CA, DA=da, GA0=g0, GA1=g1, MA=ma_, vram_end=end, vram_limit=VR0,
                  vram_reserve=VR0 - end, map_wh=(mw, mh), u_walls=len(wvram), u_ghost=len(gv), u_gem=len(ev),
                  max_part=max_part, nparts=len(wparts))
    if end > VR0:
        raise ConvError(f"VRAM total {end} > {VR0} (MA + 2*W*H)")
    return r


def SL(slot):
    d, s, _face = wallconv.SLOTS[slot]
    return d, s


def wsm_entries(data):
    """walls.wsm (PRG) -> [(index, d, s, flags, w, h, src, dest)] without header."""
    b = data[2:]
    if b[:3] != b"WS\x01":
        raise ConvError("walls.wsm: Magic/Version")
    out = []
    for i in range(b[3]):
        d, s, fl, w, h, src, dest, _col = struct.unpack_from("<BbBBBHHB", b, 10 + 10 * i)
        out.append((i, d, s, fl, w, h, src, dest))
    return out


# ---------------------------------------------------------------- report

def report_md(r, files_in=None):
    g, i = r.dvg, r.info
    L = ["# crawlconv: Crawl 128 to engine 0.2", "",
         f"DVG: {g.vw} x {g.vh}, D = {g.D}, S = {g.S}, stride {g.stride}, origin {g.origin}, geometry ID "
         f"{g.gid:#06x}, horizon [{g.hy0}, {g.hy1}), {len(g.elems)} elements", "",
         "## Elements", "", "| # | Kind | d | s | Flags | x | y | w | h | c0 | c1 |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for e in g.elems:
        art = ("front", "side", "floor", "ceiling", "Obj")[e.art]
        if e.art == dbeview.ART_OBJ:
            L.append(f"| {e.index} | Obj | {e.d} | {e.s:+d} | - | " + ", ".join(f"p{p} ({a[0]},{a[1]})" for p, a in
                                                                       enumerate(e.anchors) if p in (P_GEM, P_GHOST))
                     + " | | | | | |")
        else:
            L.append(f"| {e.index} | {art} | {e.d} | {e.s:+d} | {e.flags} | {e.x} | {e.y} | {e.w} | {e.h} | {e.c0} | {e.c1} |")
    L += ["", "Anchors: p = 2 (center) gem, p = 3 (front left) ghost, byte column and row relative to the window; "
          "depth 3 = values of depth 2.", "",
          "## Files", "", "| File | Bank / target | Bytes |", "|---|---|---|"]
    where = {"crawl.dvg": "bank 1 $E800", "walls.dts": "bank 1 $8000", "ghost.s2": "bank 1 $6000",
             "gem.s2": "bank 1 $7000", "crawl.dmp": "bank 1 $4000"}
    for n, d in sorted(r.files.items()):
        L.append(f"| {n} | {where.get(n, 'bank 0 at BE, via RXV')} | {len(d)} |")
    L += ["", f"VRL parts of the wall images: N = {r.nparts} (--max-part {i['max_part']}).", "",
          "## VRAM (2.3)", "", "| Name | Address | Bytes |", "|---|---|---|",
          f"| CA character set | {i['CA']} | {i['font_bytes']} |", f"| DA wall DTS data | {i['DA']} | {i['u_walls']} |",
          f"| GA(0) ghost | {i['GA0']} | {i['u_ghost']} |", f"| GA(1) gem | {i['GA1']} | {i['u_gem']} |",
          f"| GA(2) = MA Automap | {i['MA']} | {2 * i['map_wh'][0] * i['map_wh'][1]} |", "",
          f"End {i['vram_end']}, limit {i['vram_limit']}, reserve {i['vram_reserve']} bytes.", ""]
    return "\n".join(L)


def write(r, out_dir, as_json=False):
    os.makedirs(out_dir, exist_ok=True)
    for n, d in r.files.items():
        with open(os.path.join(out_dir, n), "wb") as f:
            f.write(d)
    with open(os.path.join(out_dir, "crawlconv.md"), "w", encoding="utf-8") as f:
        f.write(report_md(r))
    if as_json:
        js = dict(info=r.info, files={n: len(d) for n, d in r.files.items()}, gid=r.dvg.gid, nelems=len(r.dvg.elems),
                  anchors={k: {str(d): {str(s): list(a) for s, a in v.items()} for d, v in t.items()}
                           for k, t in r.anchors.items()})
        with open(os.path.join(out_dir, "crawlconv.json"), "w", encoding="utf-8") as f:
            json.dump(js, f, indent=1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out_dir", metavar="OUT_DIR")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--d81", metavar="IMAGE.d81")
    g.add_argument("--dir", metavar="DIR")
    ap.add_argument("--max-part", type=int, default=0, metavar="N", help="VRL parts at most N bytes (0 = unsplit)")
    ap.add_argument("--font-bytes", type=int, default=None, help="default: length of font3o.vdc without load address")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        files = read_d81(a.d81, os.path.join(a.out_dir, "in")) if a.d81 else read_dir(a.dir)
        r = build(files, a.max_part, a.font_bytes)
        write(r, a.out_dir, a.json)
    except (ConvError, dbeview.ViewError, dbetex.TexError, OSError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    i = r.info
    print(f"{a.out_dir}: {len(r.dvg.elems)} elements, gid {r.dvg.gid:#06x}; "
          + ", ".join(f"{n} {len(d)}" for n, d in sorted(r.files.items())))
    print(f"VRAM: DA {i['DA']}, GA(0) {i['GA0']}, GA(1) {i['GA1']}, MA {i['MA']}, end {i['vram_end']} "
          f"(reserve {i['vram_reserve']}); wall VRL parts N = {r.nparts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
