#!/usr/bin/env python3
"""Daten von Crawl 128 (1.0f, Engine 0.1) in Engine-0.2-Dateien umwandeln (P7a, docs/specs/P7-crawl.md Abschnitt 3).

Eingaben (1.0f-Dateien, unveraendert): walls.vdc, walls.wsm, ghost.spr, ghosts.vdc, gem.spr, font3o.vdc
(optional crawl128.cd1 fuer crawl.dmp und die Groesse der Automap).
Freie Crawl-DVG statt Westwood-Preset (review-notes G.6): jedes der 19 Wandbilder ist ein DVG-Element mit seinem
Rechteck, das DTS enthaelt nur Kerne (Bild = ein Kern = volles Rechteck), Geister und Edelsteine sind S2-Bilder mit
Ankern auf den 1.0f-Positionen. Die Tapete ist das Fuellbyte 0 (BGSET ohne DBG).

Ausgabe in OUT_DIR:
  crawl.dvg          Geometrie (Bank 1 $E800)
  walls.dts          Wand-DTS, nur Kerne (Bank 1 $8000)
  walls.vrl | walls1.vrl ... wallsN.vrl   Bilddaten per RXV nach DA (mehrere Teile mit --max-part)
  ghost.s2 + ghost.vrl   Sprite-Satz Geist (Bank 1 $6000)
  gem.s2 + gem.vrl       Sprite-Satz Edelstein (Bank 1 $7000)
  crawl.dmp          Karte (nur mit crawl128.cd1; crawlmap, Bank 1 $4000)
  crawlconv.md       Bericht;  crawlconv.json mit --json

Aufruf:
  crawlconv.py --d81 crawl128-100f.d81 OUT_DIR [--max-part N] [--font-bytes 1732] [--json]
  crawlconv.py --dir DIR_MIT_DEN_DATEIEN OUT_DIR [...]
Als Modul: build(files, ...) -> Result, write(result, out_dir), read_dir(dir), read_d81(image, work_dir).
Exitcode 0 ok, 1 Fehler, 2 Aufruf.
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
HY0, HY1 = 0, 95                      # Zeile 95 des Fensters bleibt den Waenden (Bildschirmzeile 100, Spec 1.2)
FULL = 96                             # Hoehe der deckenden Bilder
VIEW_COL0, VIEW_ROW0 = 6, 5           # linke obere Ecke des Fensters im 1.0f-Bildpuffer (406 = 5 * 80 + 6)
ROW = 80
LOAD = {"dvg": 0xE800, "wall": 0x8000, "ghost": 0x6000, "gem": 0x7000, "dmp": 0x4000}
S2_MAX = 0x1000                       # Bereich je Sprite-Satz bis zur naechsten Ladeadresse
CA = 19200                            # Zeichensatz im VRAM (AP + VR(1) + VR(1))
VR0 = 46335                           # Bildschirm-RAM (Bitmap)
GEM_CHARS = (4, 5)                    # Font-Zeichen des Edelsteins (CHR$(36) CHR$(37))
GHOST_ANGLES = 4
MASK_BG = (0x00, 0xFF)                # zwei Hintergrundmuster fuer die Transparenzmaske (3.4)
P_GEM, P_GHOST = 2, 3                 # Objektplaetze: Mitte = Edelstein, vorne links = Geist


class ConvError(Exception):
    pass


# ---------------------------------------------------------------- Eingaben lesen

def read_dir(path):
    """Dateien aus einem Ordner (Namen kleingeschrieben) -> {name: bytes}."""
    out = {}
    for n in FILES + OPTIONAL:
        p = os.path.join(path, n)
        if os.path.exists(p):
            with open(p, "rb") as f:
                out[n] = f.read()
        elif n in FILES:
            raise ConvError(f"{n} fehlt in {path}")
    return out


def read_d81(image, work_dir):
    """Dateien per c1541 aus dem Image lesen (work_dir: Arbeitsordner unterhalb von OUT_DIR)."""
    os.makedirs(work_dir, exist_ok=True)
    for n in FILES + OPTIONAL:
        out = os.path.join(work_dir, n)
        if os.path.exists(out):
            os.remove(out)
        r = subprocess.run(["c1541", "-attach", image, "-read", n, out], capture_output=True, text=True)
        if not os.path.exists(out) and n in FILES:
            raise ConvError(f"c1541 konnte {n} nicht aus {image} lesen: {(r.stderr or r.stdout).strip()}")
    return read_dir(work_dir)


def parse_walls(data):
    """walls.vdc (PRG) -> (Eintraege [(slot, src, w, h, size, col)], Bilddaten ab 1 + 7 n)."""
    b = data[2:]
    n = b[0]
    hdr = 1 + 7 * n
    ents = []
    for i in range(n):
        src, w, h, size, col = struct.unpack_from("<HBBHB", b, 1 + 7 * i)
        if src + w * h > len(b) - hdr or size != w * h:
            raise ConvError(f"walls.vdc: Bild {i + 1} (src {src}, {w} x {h}, size {size}) passt nicht in die Datei")
        ents.append((i + 1, src, w, h, size, col))
    if n != len(wallconv.SLOTS):
        raise ConvError(f"walls.vdc: {n} Bilder, erwartet {len(wallconv.SLOTS)}")
    return ents, bytes(b[hdr:])


def parse_spr(data):
    """ghost.spr / gem.spr (PRG, Sprite-Metadaten v1) -> Liste von Teilen (dict)."""
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
    """Ziel (relativ zu AP) -> (Byte-Spalte, Zeile) relativ zum Fenster."""
    return dest % ROW - VIEW_COL0, dest // ROW - VIEW_ROW0


def wall_elements(walls):
    """Wandbilder nach Zelle (d, s) gruppiert, je Zelle erst Fronten, dann Seiten, je Art in Slotreihenfolge."""
    by_cell = {}
    for slot, src, w, h, _size, col in walls:
        d, s, face = wallconv.SLOTS[slot]
        by_cell.setdefault((d, s), []).append((face, slot, src, w, h, col))
    for lst in by_cell.values():
        lst.sort()
    return by_cell


def build_dvg(walls, ghost_anchor, gem_anchor):
    """-> (Dvg, wall_order); wall_order = [(slot_nr, src, w, h)] in Elementreihenfolge (= Slotreihenfolge im DTS)."""
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
    """Wand-DTS, nur Kerne: Bild k = Slot k = k-tes Wandelement; VRAM-Daten = die Bilddaten von walls.vdc."""
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
        entries.append(dbetex.Entry(k, dbetex.F_DECKEND if h == FULL else 0, [dbetex.Kern(src, 0, 0, w, h, 0)], h=h))
    ts = dbetex.TexSet(0, dvg.gid, len(dvg.elems), dvg.D, dvg.stride, smap, [list(range(len(order)))], entries,
                       bytes(vram))
    prg = dbetex.to_dts(ts, LOAD["wall"])
    ts2 = dbetex.from_dts(prg, vram)
    return prg, ts2


# ---------------------------------------------------------------- S2: Geist und Edelstein

def _ghost_mask(vram, part):
    """Pixelzeilen (Palettenindex oder None) des Geistteils: zweimal mit sim_vms auf verschiedene Hintergruende
    rendern, deckend ist ein Pixel, wenn beide Laeufe denselben Wert zeigen (3.4)."""
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
    """-> (S2-PRG, VRAM-Daten, SpriteSet, {(d, s, angle): rows}); Pruefung: Seiten gleich der Mitte."""
    mid = {}
    for p in gparts:
        if p["flags"] != 1 or p["w"] > 127:
            raise ConvError(f"ghost.spr: Teil {(p['d'], p['s'], p['angle'])} ist kein VMS-Teil")
        key = (p["d"], p["angle"])
        sig = (p["w"], p["h"], p["src"], p["list"])
        if p["s"] == 0:
            mid[key] = sig
    for p in gparts:
        if (p["w"], p["h"], p["src"], p["list"]) != mid.get((p["d"], p["angle"])):
            raise ConvError(f"ghost.spr: Teil {(p['d'], p['s'], p['angle'])} weicht von (d, 0, a) ab (Liste/Daten)")
    images, rows_by = {}, {}
    for p in gparts:
        if p["s"] != 0:
            continue
        rows = _ghost_mask(ghost_vram, p)
        rows_by[(p["d"], p["angle"])] = rows
        images[(0, p["angle"], p["d"])] = (rows, 0, 0)
    if sorted({d for d, _ in rows_by}) != [1, 2] or {a for _, a in rows_by} != set(range(GHOST_ANGLES)):
        raise ConvError("ghost.spr: erwartet Tiefen 1 und 2 und Blickwinkel 0-3")
    prg, vram = dbeview.make_s2(images, D, GHOST_ANGLES, 1, STRIDE, angle_map=[0, 1, 2, 3], gid=gid, max_kerns=16,
                                load=LOAD["ghost"])
    return prg, vram, dbeview.read_s2(prg, vram), rows_by


def build_gem(font, gid):
    """Ein Bild 6 x 6 Byte aus den Font-Zeichen 4 und 5 (je 3 Byte x 6 Zeilen), ganz deckend."""
    rows = []
    for r in range(6):
        line = []
        for ch in GEM_CHARS:
            for b in font[ch * 18 + 3 * r:ch * 18 + 3 * r + 3]:
                line += [b >> 4, b & 15]
        rows.append(line)
    images = {(0, 0, d): (rows, 0, 0) for d in (1, 2)}
    prg, vram = dbeview.make_s2(images, D, 1, 1, STRIDE, angle_map=[0, 0, 0, 0], gid=gid, flags=1, max_kerns=16,
                                load=LOAD["gem"])
    return prg, vram, dbeview.read_s2(prg, vram)


def anchors_from_parts(ghost_parts, gem_parts):
    """Anker je Tiefe (1, 2) und Seite: Geist = Ecke des Teils (d, s, 0), Edelstein = Ecke des ersten Zeichens."""
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
            raise ConvError(f"gem.spr: Zelle {(d, s)}: erwartet die Font-Zeichen {GEM_CHARS}")
        a, b = ps
        if (b["dest"] != a["dest"] + 3 or (a["w"], a["h"], b["w"], b["h"]) != (3, 6, 3, 6)
                or a["flags"] or b["flags"] or a["angle"] != 0xFF):
            raise ConvError(f"gem.spr: Zelle {(d, s)}: zweites Zeichen nicht 3 Byte rechts daneben")
        ma[d][s] = _anchor(a["dest"])
    for t in (ga, ma):
        for d in (1, 2):
            if sorted(t[d]) != [-1, 0, 1]:
                raise ConvError(f"Anker fuer Tiefe {d} unvollstaendig: {sorted(t[d])}")
    return ga, ma


# ---------------------------------------------------------------- VRL, Teile

def vrl_parts(vram, bounds, max_part):
    """VRL-Dateien (PRG-Rahmen). max_part 0 = eine Datei; sonst Teile an Bildgrenzen (bounds = Anfaenge der Bilder),
    jeder Teil beginnt (ausser bei Offset 0) mit einem Skip auf seinen Offset, damit alle Teile an dasselbe Ziel
    gehen (RXV BE+5,DA). Ein Bild, das allein schon groesser als max_part ist, bildet einen eigenen Teil."""
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


# ---------------------------------------------------------------- Gesamtumwandlung

@dataclass
class Result:
    files: dict = field(default_factory=dict)         # Dateiname -> bytes
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


def build(files, max_part=0, font_bytes=1732):
    """files: Eingabedateien (read_dir/read_d81). ConvError bei Fehlern."""
    walls, wvram = parse_walls(files["walls.vdc"])
    # Gegenprobe gegen walls.wsm (Lage, Flaechen, Spalten): die Datei der 1.0f-Disk muss zu walls.vdc passen
    wsm_ents = [(e[1], e[2], e[3], e[4], e[5], e[6], e[7]) for e in wsm_entries(files["walls.wsm"]) if not e[3] & 0x80]
    mine = sorted((SL(slot)[0], SL(slot)[1], 1 if h == FULL else 0, w, h, src, wallconv.DEST_BASE + col)
                  for slot, src, w, h, _s, col in walls)
    if sorted(wsm_ents) != mine:
        raise ConvError("walls.wsm passt nicht zu walls.vdc")
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
        raise ConvError("Geometrie-ID falsch")
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
            raise ConvError(f"{name}: {len(prg) - 2} Byte > ${S2_MAX:X}")
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
    # Karte
    mw = mh = None
    if "crawl128.cd1" in files:
        m, warn = crawlmap.convert(files["crawl128.cd1"])
        dmp = dbemap.to_dmp(m, LOAD["dmp"])
        dbemap.check_bank1(LOAD["dmp"], len(dmp) - 2)
        f["crawl.dmp"] = dmp
        mw, mh = m.width, m.height
    mw, mh = mw or 20, mh or 11
    # VRAM-Summe (2.3)
    da = CA + font_bytes
    g0 = da + len(wvram)
    g1 = g0 + len(gv)
    ma_ = g1 + len(ev)
    end = ma_ + 2 * mw * mh
    r.info = dict(font_bytes=font_bytes, CA=CA, DA=da, GA0=g0, GA1=g1, MA=ma_, vram_end=end, vram_limit=VR0,
                  vram_reserve=VR0 - end, map_wh=(mw, mh), u_walls=len(wvram), u_ghost=len(gv), u_gem=len(ev),
                  max_part=max_part, nparts=len(wparts))
    if end > VR0:
        raise ConvError(f"VRAM-Summe {end} > {VR0} (MA + 2*W*H)")
    return r


def SL(slot):
    d, s, _face = wallconv.SLOTS[slot]
    return d, s


def wsm_entries(data):
    """walls.wsm (PRG) -> [(index, d, s, flags, w, h, src, dest)] ohne Kopf."""
    b = data[2:]
    if b[:3] != b"WS\x01":
        raise ConvError("walls.wsm: Magic/Version")
    out = []
    for i in range(b[3]):
        d, s, fl, w, h, src, dest, _col = struct.unpack_from("<BbBBBHHB", b, 10 + 10 * i)
        out.append((i, d, s, fl, w, h, src, dest))
    return out


# ---------------------------------------------------------------- Bericht

def report_md(r, files_in=None):
    g, i = r.dvg, r.info
    L = ["# crawlconv: Crawl 128 auf Engine 0.2", "",
         f"DVG: {g.vw} x {g.vh}, D = {g.D}, S = {g.S}, stride {g.stride}, origin {g.origin}, Geometrie-ID "
         f"{g.gid:#06x}, Horizont [{g.hy0}, {g.hy1}), {len(g.elems)} Elemente", "",
         "## Elemente", "", "| # | Art | d | s | Flags | x | y | w | h | c0 | c1 |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for e in g.elems:
        art = ("Front", "Seite", "Boden", "Decke", "Obj")[e.art]
        if e.art == dbeview.ART_OBJ:
            L.append(f"| {e.index} | Obj | {e.d} | {e.s:+d} | - | " + ", ".join(f"p{p} ({a[0]},{a[1]})" for p, a in
                                                                       enumerate(e.anchors) if p in (P_GEM, P_GHOST))
                     + " | | | | | |")
        else:
            L.append(f"| {e.index} | {art} | {e.d} | {e.s:+d} | {e.flags} | {e.x} | {e.y} | {e.w} | {e.h} | {e.c0} | {e.c1} |")
    L += ["", "Anker: p = 2 (Mitte) Edelstein, p = 3 (vorne links) Geist, Byte-Spalte und Zeile relativ zum Fenster; "
          "Tiefe 3 = Werte der Tiefe 2.", "",
          "## Dateien", "", "| Datei | Bank / Ziel | Byte |", "|---|---|---|"]
    where = {"crawl.dvg": "Bank 1 $E800", "walls.dts": "Bank 1 $8000", "ghost.s2": "Bank 1 $6000",
             "gem.s2": "Bank 1 $7000", "crawl.dmp": "Bank 1 $4000"}
    for n, d in sorted(r.files.items()):
        L.append(f"| {n} | {where.get(n, 'Bank 0 bei BE, per RXV')} | {len(d)} |")
    L += ["", f"VRL-Teile der Wandbilder: N = {r.nparts} (--max-part {i['max_part']}).", "",
          "## VRAM (2.3)", "", "| Name | Adresse | Byte |", "|---|---|---|",
          f"| CA Zeichensatz | {i['CA']} | {i['font_bytes']} |", f"| DA Wand-DTS-Daten | {i['DA']} | {i['u_walls']} |",
          f"| GA(0) Geist | {i['GA0']} | {i['u_ghost']} |", f"| GA(1) Edelstein | {i['GA1']} | {i['u_gem']} |",
          f"| GA(2) = MA Automap | {i['MA']} | {2 * i['map_wh'][0] * i['map_wh'][1]} |", "",
          f"Ende {i['vram_end']}, Grenze {i['vram_limit']}, Reserve {i['vram_reserve']} Byte.", ""]
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
    ap.add_argument("--max-part", type=int, default=0, metavar="N", help="VRL-Teile hoechstens N Byte (0 = ungeteilt)")
    ap.add_argument("--font-bytes", type=int, default=1732)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        files = read_d81(a.d81, os.path.join(a.out_dir, "in")) if a.d81 else read_dir(a.dir)
        r = build(files, a.max_part, a.font_bytes)
        write(r, a.out_dir, a.json)
    except (ConvError, dbeview.ViewError, dbetex.TexError, OSError, ValueError) as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1
    i = r.info
    print(f"{a.out_dir}: {len(r.dvg.elems)} Elemente, gid {r.dvg.gid:#06x}; "
          + ", ".join(f"{n} {len(d)}" for n, d in sorted(r.files.items())))
    print(f"VRAM: DA {i['DA']}, GA(0) {i['GA0']}, GA(1) {i['GA1']}, MA {i['MA']}, Ende {i['vram_end']} "
          f"(Reserve {i['vram_reserve']}); Wand-VRL-Teile N = {r.nparts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
