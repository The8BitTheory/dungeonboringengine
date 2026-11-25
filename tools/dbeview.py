#!/usr/bin/env python3
"""Python-Referenz der Engine-Funktion VIEW (P6b): VCL-Liste, VCL-Interpreter, unabhaengiger Maler.

Spezifikation: docs/specs/P6-engine.md (Abschnitte 5 und 9.1); Geometrie P3 (DVG), Karte P4 (DMP), Texturen P5
(DTS, DBG), Sprites P5b (S2). Die 6502-Fassung muss die Liste von view() bytegleich erzeugen.

API (Module-Ebene):
  Scene, Obj, Result                 Eingabe und Ergebnis
  view(scene) -> Result              VCL- und VMS-Bytes nach P6 Abschnitt 5 (a, x, vcl, vms, vcllen, vmslen, objvis)
  run_vcl(bank0, vram, addr)         VCL-Interpreter (Typen 1-8, 12, 13; VMS 1, 2, 3, 8; RXV ueber vrl)
  paint_reference(scene, vram)       Maler ohne Abdeckung und Spannen (Plan-Reihenfolge, alles was existiert)
  render_view(scene, vram=None)      view + run_vcl in ein VRAM-Abbild
  decode_vcl(buf, off=0)             VCL-Liste als Tupel (fuer Fehlermeldungen beim Listenvergleich)
  load_scene(toml) / random_scene(seed, assets, ...) / budget(scenes)
  build_demo_assets(dir)             DVG, Wand-/Boden-/Decken-DTS, DBG und Sprite-Saetze fuer Tests

Aufruf:
  dbeview.py render SCENE.toml [--out PNG] [--zoom N]     Szene zeichnen (Bild des Sichtfensters)
  dbeview.py dump   SCENE.toml                            VCL-Liste dekodiert
  dbeview.py budget SCENE.toml...                         groesste VCL + VMS, Warnung bei A != 0
Exitcode 0 ok, 1 Fehler, 2 Aufruf.
"""
import argparse
import copy
import os
import random
import struct
import sys
import tomllib
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbegeom  # noqa: E402
import dbemap  # noqa: E402
import dbetex  # noqa: E402
import vrl  # noqa: E402

ART_FRONT, ART_SIDE, ART_FLOOR, ART_CEIL, ART_OBJ = 0, 1, 2, 3, 4
KIND_WALL, KIND_FLOOR, KIND_CEIL = 0, 1, 2
F_DECKEND, F_AUSSCHNITT, F_ZEILEN, F_RAND = dbetex.F_DECKEND, dbetex.F_AUSSCHNITT, dbetex.F_ZEILEN, dbetex.F_RAND
DVG_COVER, DVG_BANDCOVER = 1, 8
T_WEG, T_DECKEND, T_INHALT = dbemap.FLAGS["weg"], dbemap.FLAGS["deckend"], dbemap.FLAGS["inhalt"]
MAXITEM = 96
MAX_SPANS = 4
DEFAULT_BUF = (0x1300, 0x1C00)
MAXCELL, MAXWALL, MAXPEND, MAXCELLELEM = 48, 96, 16, 16     # GEOMSET-Grenzen der Elementtabelle (P6 7)
DEFAULT_DTS_ADDR = (0x9000, 0xF000, 0xF800)                  # Bank-1-Adressen der DTS (P6 2.4), fuer vms_bank1
DEFAULT_S2_ADDR = 0x7000                                     # Bank-1-Adresse des ersten S2 (P6 2.4), fuer vms_bank1
E_OK, E_TOOMANY, E_PARTIAL = 0, 2, 3
FORE = [(0, -1), (1, 0), (0, 1), (-1, 0)]       # F je Richtung v (N, O, S, W)
RIGHT = [(1, 0), (0, 1), (-1, 0), (0, -1)]      # R je Richtung v


class ViewError(Exception):
    pass


# ---------------------------------------------------------------- DVG

@dataclass
class Elem:
    index: int
    art: int
    d: int
    s: int
    flags: int
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0
    kx: int = 0
    ky: int = 0
    kw: int = 0
    kh: int = 0
    c0: int = 0
    c1: int = 0
    src_dx: int = 0
    anchors: list = field(default_factory=list)


@dataclass
class DepthRow:
    cy0: int
    cy1: int
    fy0: int
    fy1: int
    first: int
    n: int
    fw: int
    fx: int


@dataclass
class Dvg:
    vw: int
    vh: int
    D: int
    S: int
    stride: int
    origin: int
    gid: int
    hy0: int
    hy1: int
    depth: list
    elems: list

    def row(self, y):
        return (self.origin + y * self.stride) & 0xFFFF


def _s8(b):
    return b - 256 if b > 127 else b


def parse_dvg(data, prg=True):
    """DVG (PRG mit Ladeadresse) -> Dvg; ViewError bei Formatfehlern."""
    c = bytes(data[2:] if prg else data)
    if len(c) < 24 or c[0:2] != b"DV" or c[2] != 1:
        raise ViewError("DVG: Magic/Version")
    vw, vh, D, S, ne = c[3], c[4], c[5], c[6], c[7]
    stride, origin, gid = struct.unpack_from("<HHH", c, 8)
    hy0, hy1, elen, dlen = c[14], c[15], c[16], c[17]
    o_d, o_e, total = struct.unpack_from("<HHH", c, 18)
    if elen != 16 or dlen != 8 or len(c) < total or o_d != 24 or o_e != 24 + 8 * (D + 1) or total != o_e + 16 * ne:
        raise ViewError("DVG: Laengen/Offsets")
    if vw > 80 or vh > 100 or D > 7 or ne < 1:
        raise ViewError("DVG: VW/VH/D/NE ausserhalb der Grenzen")
    depth = [DepthRow(*c[o_d + 8 * d:o_d + 8 * d + 8]) for d in range(D + 1)]
    elems = []
    for i in range(ne):
        r = c[o_e + 16 * i:o_e + 16 * i + 16]
        e = Elem(i, r[0], r[1], _s8(r[2]), r[3])
        if e.art == ART_OBJ:
            e.anchors = [(_s8(r[4 + 2 * p]), r[5 + 2 * p]) for p in range(5)]
        else:
            e.x, e.y, e.w, e.h, e.kx, e.ky, e.kw, e.kh, e.c0, e.c1, e.src_dx = r[4], r[5], r[6], r[7], r[8], r[9], \
                r[10], r[11], r[12], r[13], r[14]
        elems.append(e)
    check_elems(vw, vh, D, S, depth, elems)
    return Dvg(vw, vh, D, S, stride, origin, gid, hy0, hy1, depth, elems)


def check_elems(vw, vh, D, S, depth, elems):
    """Pruefungen der Elementtabelle wie GEOMSET (P6 7); ViewError bei Verstoss."""
    ncell = nwall = 0
    for d, dt in enumerate(depth):
        if dt.first + dt.n > len(elems):
            raise ViewError(f"DVG: Tiefe {d}: first + n > NE")
        seen, cur, pend = set(), None, 0
        for e in elems[dt.first:dt.first + dt.n]:
            if e.art > ART_OBJ or abs(e.s) > S:
                raise ViewError(f"DVG: Element {e.index}: Art oder s ausserhalb")
            if e.s != cur:
                if e.s in seen:
                    raise ViewError(f"DVG: Elemente der Zelle ({d}, {e.s}) nicht zusammenhaengend (P3 5.3)")
                seen.add(e.s)
                cur, nel, nfl, nce = e.s, 0, 0, 0
                ncell += 1
            nel += 1
            if nel > MAXCELLELEM:
                raise ViewError(f"DVG: Zelle ({d}, {e.s}) mit mehr als {MAXCELLELEM} Elementen")
            if e.art == ART_OBJ:
                continue
            if e.x + e.w > vw or e.y + e.h > vh:
                raise ViewError(f"DVG: Element {e.index} ausserhalb des Fensters")
            if e.art in (ART_FRONT, ART_SIDE):
                if not e.c0 <= e.c1 <= vw:
                    raise ViewError(f"DVG: Element {e.index}: Spalten c0/c1")
                nwall += 1
                if e.flags & DVG_COVER and (e.art == ART_SIDE or not e.flags & DVG_BANDCOVER):
                    pend += 1
            elif e.art == ART_FLOOR:
                nfl += 1
            else:
                nce += 1
            if nfl > 1 or nce > 1:
                raise ViewError(f"DVG: Zelle ({d}, {e.s}) mit mehr als einem Boden- bzw. Deckenelement")
        if pend > MAXPEND:
            raise ViewError(f"DVG: Tiefe {d}: mehr als {MAXPEND} deckende Seiten/Fronten ohne Bit 3")
    if ncell > MAXCELL or nwall > MAXWALL:
        raise ViewError(f"DVG: mehr als {MAXCELL} Zellen bzw. {MAXWALL} Waende")


# ---------------------------------------------------------------- Szene

@dataclass
class Obj:
    cell: int
    set: int
    dir: int = 0xFF
    phase: int = 0
    q: int = 4
    hidden: bool = False
    noblock: bool = False

    def byte5(self):
        return self.q & 7 | (0x40 if self.hidden else 0) | (0x80 if self.noblock else 0)


@dataclass
class Scene:
    dvg: Dvg
    dmp: object                                   # dbemap.Map
    dts: list = field(default_factory=lambda: [None, None, None])     # TexSet je Art (mit .vram)
    dbg: dict = None                              # dbetex.from_dbg
    dbg_vram: bytes = b""
    bgfill: int = 0                               # Fuellbyte ohne DBG (BGSET)
    s2: list = field(default_factory=lambda: [None] * 8)              # SpriteSet (dbespr) je Satz
    vram_bases: dict = field(default_factory=lambda: {"dts": [0, 0, 0], "dbg": 0, "s2": [0] * 8})
    itemtab: list = field(default_factory=lambda: [0] * 64)           # Satz + 1
    objects: list = field(default_factory=list)
    itemph: int = 0
    pos: int = 0
    dir: int = 0
    ap: int = 0
    buf: tuple = DEFAULT_BUF
    vms_bank1: bool = False                       # unbeschnittene VMS-Listen aus Bank 1 (VCL-Typ 9, Standardbuild);
                                                  # False = Build VMS_COPY (Kopie in den Puffer, Typ 12)
    dts_addr: tuple = DEFAULT_DTS_ADDR            # Bank-1-Adressen der DTS (Inhaltsanfang), nur fuer vms_bank1
    s2_addr: tuple = None                         # Bank-1-Adressen der S2 je Satz; None: dicht ab $7000 (P6 2.4)

    def s2_bank1(self, k):
        """Bank-1-Adresse (Inhaltsanfang) des Sprite-Satzes k."""
        if self.s2_addr is not None:
            return self.s2_addr[k]
        a, seen = DEFAULT_S2_ADDR, {}
        for j, ss in enumerate(self.s2):
            if ss is None:
                continue
            if id(ss) not in seen:
                seen[id(ss)] = a
                a += len(_s2_content(ss))
            if j == k:
                return seen[id(ss)]
        return 0

    def window(self):
        """Adressen aller Fensterbytes (Menge)."""
        g = self.dvg
        return {(self.ap + g.row(y) + x) & 0xFFFF for y in range(g.vh) for x in range(g.vw)}

    def assets(self):
        """(Name, Basis, Bytes) aller Assets im VRAM."""
        out = []
        for k, ts in enumerate(self.dts):
            if ts is not None and ts.vram:
                out.append((f"dts{k}", self.vram_bases["dts"][k], bytes(ts.vram)))
        if self.dbg is not None and self.dbg_vram:
            out.append(("dbg", self.vram_bases["dbg"], bytes(self.dbg_vram)))
        for i, ss in enumerate(self.s2):
            if ss is not None and ss.vram:
                out.append((f"s2_{i}", self.vram_bases["s2"][i], bytes(ss.vram)))
        return out

    def make_vram(self, seed=0):
        """64-KB-VRAM mit Zufallsinhalt und den Assets an ihren Basen."""
        rnd = random.Random(seed)
        vram = bytearray(rnd.getrandbits(8) for _ in range(65536))
        for name, base, data in self.assets():
            if base + len(data) > 65536:
                raise ViewError(f"{name}: Basis {base:#06x} + {len(data)} Byte ueber das VRAM hinaus")
            vram[base:base + len(data)] = data
        return vram

    def window_ranges(self):
        """Adressbereiche [von, bis) des Sichtfensters (ein Bereich, bei Ueberlauf ueber 65535 zwei)."""
        g = self.dvg
        w0 = (self.ap + g.origin) & 0xFFFF
        w1 = w0 + (g.vh - 1) * g.stride + g.vw
        return [(w0, w1)] if w1 <= 65536 else [(w0, 65536), (0, w1 - 65536)]

    def check_layout(self):
        """Ueberlappen Assets untereinander oder mit dem Fenster?"""
        spans = sorted((b, b + len(d), n) for n, b, d in self.assets())
        for (a0, a1, n0), (b0, b1, n1) in zip(spans, spans[1:]):
            if b0 < a1:
                raise ViewError(f"VRAM: {n0} und {n1} ueberlappen")
        for a0, a1, n in spans:
            for w0, w1 in self.window_ranges():
                if a0 < w1 and a1 > w0:
                    raise ViewError(f"VRAM: {n} ueberlappt das Sichtfenster")


def layout_vram(scene, start=None, align=1):
    """Setzt die Basen der Assets dicht hintereinander: ab Ende des Sichtfensters (liegt es in der unteren Haelfte
    des VRAM) oder ab 0."""
    wr = scene.window_ranges()
    if start is None:
        start = wr[-1][1] if len(wr) == 2 else (wr[0][1] if wr[0][1] <= 0x8000 else 0)
    p = start

    def take(n):
        nonlocal p
        a = p
        p = (p + n + align - 1) // align * align
        return a
    for k, ts in enumerate(scene.dts):
        scene.vram_bases["dts"][k] = take(len(ts.vram)) if ts is not None else 0
    if scene.dbg is not None:
        scene.vram_bases["dbg"] = take(len(scene.dbg_vram))
    for i, ss in enumerate(scene.s2):
        scene.vram_bases["s2"][i] = take(len(ss.vram)) if ss is not None else 0
    if p > 65536:
        raise ViewError(f"VRAM-Pool zu gross: Ende {p:#x}")
    scene.check_layout()
    return scene


@dataclass
class Result:
    a: int = 0
    x: int = 0
    y: int = 0
    p0: int = 0                 # VCLADR (VCL-Liste [p0, B1), VMS-Listen [b0, b0 + vmslen))
    b0: int = 0                 # Pufferanfang
    vcl: bytes = b""
    vms: bytes = b""
    vcllen: int = 0
    vmslen: int = 0
    objvis: int = 0
    partial: bool = False
    items: int = 0
    lists1: dict = field(default_factory=dict)    # VCL-Typ 9: Bank-1-Adresse -> VMS-Liste

    @property
    def buffer(self):
        """VCL-Liste, dann VMS-Listen (so liefert sie der sim65-Harness)."""
        return self.vcl + self.vms

    def bank0(self):
        b = bytearray(65536)
        b[self.b0:self.b0 + len(self.vms)] = self.vms
        b[self.p0:self.p0 + len(self.vcl)] = self.vcl
        return b

    def bank1(self):
        b = bytearray(65536)
        for a, lst in self.lists1.items():
            b[a:a + len(lst)] = lst
        return b


# ---------------------------------------------------------------- S2-Zugriff (nur ueber die API aus P5b 6.3)

def _lookup(ss, phase, a, d):
    """Bildindex (P5b 4.2/6.3) oder None; unabhaengig von dbespr.lookup, gleiche Regeln."""
    if not 1 <= d <= ss.depth:
        return None
    if phase >= ss.np:
        phase = 0
    ai = ss.angle_map[a & 3]
    v = ss.index[(phase * ss.na + ai) * ss.depth + d - 1]
    if v == 0xFF:
        v = ss.index[ai * ss.depth + d - 1]
    return None if v >= 0xFE else v


def clip_image(img, stride, x0, y0, cx0, cx1, cy0, cy1):
    """Beschneiden nach P5b 6 (eigene Fassung, Referenz fuer VIEW).

    img: w, h, kerns (src, dx, dy, w, h, srcstep), vms (Bytes oder leer).
    Rueckgabe (kerns, vms, ref): kerns = [(src_rel, x, y, w, reps, srcstep)] im Sichtfenster,
    vms = Bytes oder None, ref = Bezugspunkt (x, y) der VMS-Liste."""
    L, R, T, B = cx0 - x0, cx1 - x0, cy0 - y0, cy1 - y0
    kerns = []
    for k in img.kerns:
        st = k.srcstep or k.w
        a, b = max(k.dx, L), min(k.dx + k.w, R)
        c, e = max(k.dy, T), min(k.dy + k.h, B)
        if a >= b or c >= e:
            continue
        kerns.append((k.src + (c - k.dy) * st + (a - k.dx), x0 + a, y0 + c, b - a, e - c,
                      k.srcstep if (a == k.dx and b == k.dx + k.w) else st))
    vms = img.vms or None
    if not vms:
        return kerns, None, (x0, y0)
    if (L, R, T, B) == (0, img.w, 0, img.h):
        return kerns, bytes(vms), (x0, y0)
    cnt = vms[1] | vms[2] << 8
    out, n = bytearray(), 0
    p = 3
    r = rs = k = 0
    for _ in range(cnt):
        t = vms[p]
        ofs = vms[p + 1] | vms[p + 2] << 8
        while ofs >= rs + stride:
            rs += stride
            r += 1
        if r >= B:
            break
        col = ofs - rs
        if t == 1:
            ln = vms[p + 3]
            p += 4
            if T <= r < B and col < R and col + ln > L:
                a, b = max(col, L), min(col + ln, R)
                k += a - col
                if k > 0:
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
                if k > 0:
                    out += bytes((3, k & 255, k >> 8))
                    n += 1
                    k = 0
                o = (r - T) * stride + (col - L)
                out += bytes((8, o & 255, o >> 8))
                n += 1
            else:
                k += 1
        else:
            raise ViewError(f"VMS-Liste: Typ {t} im Bild")
    if not out:                          # Typ 3 steht nur vor einem sichtbaren Befehl
        return kerns, None, (cx0, cy0)
    return kerns, bytes((vms[0], n & 255, n >> 8)) + bytes(out), (cx0, cy0)


# ---------------------------------------------------------------- gemeinsame Hilfen (view und Maler)

class _Ctx:
    def __init__(self, sc):
        self.sc = sc
        self.g = sc.dvg
        self.m = sc.dmp
        self.VW, self.VH, self.D = self.g.vw, self.g.vh, self.g.D
        self.stride = self.g.stride
        self.ne = len(self.g.elems)
        self.v = sc.dir & 3
        self.px, self.py = sc.pos % self.m.width, sc.pos // self.m.width

    def row(self, y):
        return self.g.row(y)

    def cell(self, d, s):
        fx, fy = FORE[self.v]
        rx, ry = RIGHT[self.v]
        x, y = self.px + d * fx + s * rx, self.py + d * fy + s * ry
        if 0 <= x < self.m.width and 0 <= y < self.m.height:
            return y * self.m.width + x
        return None

    def tile(self, c):
        return self.m.tiles[self.m.outside if c is None else self.m.cells[c]]

    def content(self, c):
        return 0 if c is None else self.m.content[c]

    @staticmethod
    def faces(t):
        return any(t.walls)

    @staticmethod
    def blocked(t):
        return bool(t.flags & T_DECKEND) and all(t.walls)

    def face_of(self, e):
        if e.art == ART_FRONT:
            return (self.v + 2) & 3
        return (self.v + 1) & 3 if e.s < 0 else (self.v + 3) & 3

    def resolve_idx(self, kind, slotindex, n):
        """(Stil, Slot) des Bildes oder None (P6 5.1 resolve)."""
        ts = self.sc.dts[kind]
        if n == 0 or ts is None:
            return None
        st = n - 1
        if st >= len(ts.styles):
            return None
        k = ts.slot_map[slotindex]
        if k == dbetex.FALLBACK:
            return None
        b = ts.styles[st][k]
        if b == dbetex.FALLBACK:
            b = ts.styles[0][k]
        if b >= dbetex.NOIMG:
            return None
        return st, k

    def resolve(self, kind, slotindex, n):
        r = self.resolve_idx(kind, slotindex, n)
        if r is None:
            return None
        ts = self.sc.dts[kind]
        st, k = r
        b = ts.styles[st][k]
        if b == dbetex.FALLBACK:
            b = ts.styles[0][k]
        return ts.entries[b]

    def band_slot(self, kind, d):
        return self.ne + d if kind == KIND_CEIL else self.ne + self.D + 1 + d

    def deck(self, e, t, ent):
        return bool(e.flags & DVG_COVER) and bool(t.flags & T_DECKEND) and bool(ent.flags & F_DECKEND)

    def cells_of(self, d):
        """Zellen der Tiefe d: Liste (s, [Elemente]) als zusammenhaengende Gruppen gleichen s (P3 5.3)."""
        dt = self.g.depth[d]
        out = []
        for e in self.g.elems[dt.first:dt.first + dt.n]:
            if not out or out[-1][0] != e.s:
                if any(s == e.s for s, _ in out):
                    raise ViewError(f"DVG: Elemente der Zelle ({d}, {e.s}) nicht zusammenhaengend (P3 5.3)")
                out.append((e.s, []))
            out[-1][1].append(e)
        return out

    def cell_order(self, ce, t):
        """Reihenfolge der Elemente einer Zelle beim Sichtdurchlauf: DVG-Reihenfolge; bei INHALT-Flag und Flaechen
        erst Fronten, dann Objektplatz, dann Seiten (Ausgabe rueckwaerts: Seiten, Objekte, Fronten)."""
        if self.faces(t) and t.flags & T_INHALT:
            return ([e for e in ce if e.art == ART_FRONT] + [e for e in ce if e.art == ART_OBJ]
                    + [e for e in ce if e.art == ART_SIDE] + [e for e in ce if e.art in (ART_FLOOR, ART_CEIL)])
        return ce

    def band_plan(self, d, kind):
        """Entscheidung fuer Boden- bzw. Deckenband und -kacheln der Tiefe d (P6 5.6, Schritte 1-4).

        None (nichts zu zeichnen) oder dict: rows (y0, y1), luecke, ground ('band', st, ent) | 'tapete' | None,
        tiles [(Element, n)] in DVG-Reihenfolge."""
        dt = self.g.depth[d]
        y0, y1 = (dt.fy0, dt.fy1) if kind == KIND_FLOOR else (dt.cy0, dt.cy1)
        if y1 <= y0:
            return None
        art = ART_FLOOR if kind == KIND_FLOOR else ART_CEIL
        ts = self.sc.dts[kind]
        info = []                      # (Element, n, Stil | 'egal' | 'luecke')
        for e in self.g.elems[dt.first:dt.first + dt.n]:
            if e.art != art:
                continue
            t = self.tile(self.cell(d, e.s))
            if self.blocked(t):
                info.append((e, 0, "egal"))
                continue
            n = t.floor if kind == KIND_FLOOR else t.ceiling
            if n == 0 or ts is None or n - 1 >= len(ts.styles):
                info.append((e, n, "luecke"))
            else:
                info.append((e, n, n - 1))
        live = [i for i in info if i[2] != "egal"]
        if not live:
            return None
        has_gap = any(i[2] == "luecke" for i in live)
        styles = {i[2] for i in live if i[2] != "luecke"}
        bslot = self.band_slot(kind, d)
        plan = {"rows": (y0, y1), "luecke": False, "ground": None, "tiles": [], "kind": kind, "bslot": bslot}
        if not has_gap and len(styles) == 1:
            st = next(iter(styles))
            ent = self.resolve(kind, bslot, st + 1)
            if ent is not None:
                plan["ground"] = ("band", st, ent)
                return plan
        if has_gap:
            plan["luecke"] = True
            plan["ground"] = "tapete"
            plan["tiles"] = [(e, n) for e, n, s in live if s != "luecke"]
        else:
            st0 = None
            for e, n, s in live:
                if self.resolve(kind, bslot, s + 1) is not None:
                    st0 = s
                    break
            if st0 is not None:
                plan["ground"] = ("band", st0, self.resolve(kind, bslot, st0 + 1))
                plan["tiles"] = [(e, n) for e, n, s in live if s != st0]
            else:
                plan["tiles"] = [(e, n) for e, n, s in live]
        return plan

    def candidates(self, c):
        """Objekte einer Zelle in Malreihenfolge: (p, Satz, Richtung, Phase, Objektindex | None)."""
        if c is None:
            return []
        out = []
        for i, o in enumerate(self.sc.objects[:16]):
            if o.cell == c and not o.hidden:
                q = o.q & 7
                out.append((dbemap.SUBPOS_VIEW[self.v][min(q, 4)], 1 + i, o.set, o.dir, o.phase, i))
        g = self.content(c) & 63
        if g and self.sc.itemtab[g]:
            out.append((2, 0, self.sc.itemtab[g] - 1, 0xFF, self.sc.itemph, None))
        out.sort(key=lambda t: (t[0], t[1]))
        return [(p, s, dr, ph, oi) for p, _, s, dr, ph, oi in out]

    def sprite_image(self, cand, d):
        """(SpriteSet, Bild) fuer den Kandidaten in Tiefe d oder None (P6 5.8 Schritt 3)."""
        p, setn, dr, ph, oi = cand
        if not 0 <= setn < 8 or self.sc.s2[setn] is None:
            return None
        ss = self.sc.s2[setn]
        a = 0 if dr == 0xFF else (2 + self.v - dr) & 3
        idx = _lookup(ss, ph, a, d)
        if idx is None:
            return None
        return ss, ss.images[idx], setn


# ---------------------------------------------------------------- VIEW

class _Stop(Exception):
    pass


class _Item:
    """Sichtlisteneintrag: Liste von VCL-Eintraegen.

    ('vmc', src, dst, count, reps, step, srcstep) | ('vmf', vaddr, byte, count, reps, step) | ('vms', src, dst, bytes)
    | ('vms1', src, dst, bank1-adresse, bytes): unbeschnittene Liste aus Bank 1 (VCL-Typ 9, keine Pufferbytes)"""

    def __init__(self, ents, obj=None):
        self.ents = ents
        self.obj = obj

    @property
    def v(self):
        n = 0
        for e in self.ents:
            if e[0] == "vmc":
                n += 11 if e[6] == 0 else 13
            elif e[0] == "vmf":
                n += 7 if e[4] == 1 else 11
            else:
                n += 7
        return n

    @property
    def m(self):
        return sum(len(e[3]) for e in self.ents if e[0] == "vms")

    def strip_rand(self):
        self.ents = [e for e in self.ents if e[0] not in ("vms", "vms1")]


def _fill_groups(fills):
    """Aufeinanderfolgende gleiche Fuellbytes gruppieren: [(erste Zeile, Anzahl, Byte)]."""
    out = []
    for i, b in enumerate(fills):
        if out and out[-1][2] == b:
            out[-1][1] += 1
        else:
            out.append([i, 1, b])
    return [tuple(g) for g in out]


class _View(_Ctx):
    def __init__(self, sc):
        super().__init__(sc)
        self.cover = [0] * self.VW
        self.bcov = [0] * self.VW
        self.ncov = 0
        self.items = []
        self.nv, self.nm = 1, 0
        self.err = 0
        self.partial = False
        self.objvis = 0
        self.BL = sc.buf[1] - sc.buf[0]
        self.pend = []
        self.lue = {KIND_FLOOR: False, KIND_CEIL: False}

    # ---- Masken
    def mark(self, m, c0, c1):
        for c in range(c0, c1):
            if not m[c]:
                m[c] = 1
                if m is self.cover:
                    self.ncov += 1

    @staticmethod
    def allcov(m, c0, c1):
        return all(m[c0:c1])

    def spans(self, m):
        out, c = [], 0
        while c < self.VW:
            if m[c]:
                c += 1
                continue
            s = c
            while c < self.VW and not m[c]:
                c += 1
            out.append((s, c))
        if len(out) > MAX_SPANS:
            return [(out[0][0], out[-1][1])]
        return out

    # ---- Sichtliste
    def add(self, item):
        if len(self.items) == MAXITEM:
            self.err = E_TOOMANY
            raise _Stop
        v, m = item.v, item.m
        if self.nv + v + self.nm + m <= self.BL:
            pass
        elif m > 0 and v > 7 and self.nv + v - 7 + self.nm <= self.BL:
            item.strip_rand()
            v, m = v - 7, 0
            self.partial = True
        elif m > 0 and v == 7:
            self.partial = True
            return False
        else:
            self.err = E_TOOMANY
            raise _Stop
        self.items.append(item)
        self.nv += v
        self.nm += m
        if item.obj is not None:
            self.objvis |= 1 << item.obj
        return True

    # ---- Eintraege
    def wall_item(self, kind, e, ent):
        sc = self.sc
        vb = sc.vram_bases["dts"][kind]
        t0 = (sc.ap + self.row(e.y) + e.x) & 0xFFFF
        if ent.flags & F_ZEILEN:
            return _Item([("vmf", (sc.ap + self.row(e.y + r) + e.x) & 0xFFFF, b, e.w, n, self.stride)
                          for r, n, b in _fill_groups(ent.fill)])
        ents = [("vmc", (vb + k.src) & 0xFFFF, (t0 + k.dy * self.stride + k.dx) & 0xFFFF, k.w, k.h, self.stride,
                 k.srcstep) for k in ent.kerns]
        if ent.flags & F_RAND:
            ents.append(self._vms_ent(kind, ent, (vb + ent.rand_ofs) & 0xFFFF, t0))
        return _Item(ents)

    def _vms_ent(self, kind, ent, src, dst):
        """Unbeschnittene VMS-Liste: in den Puffer bzw. mit vms_bank1 als Verweis nach Bank 1 (Typ 9)."""
        if not self.sc.vms_bank1:
            return ("vms", src, dst, bytes(ent.vms))
        return ("vms1", src, dst, (self.sc.dts_addr[kind] + _vms_offsets(self.sc.dts[kind])[id(ent)]) & 0xFFFF,
                bytes(ent.vms))

    def band_item(self, kind, ent, y0, rows, c0, c1):
        """BAND(ent, y0, c0, c1): Bandbild (Breite VW, Hoehe rows) im Ausschnitt [c0, c1) (P6 5.6)."""
        sc = self.sc
        vb = sc.vram_bases["dts"][kind]
        if ent.flags & F_ZEILEN:
            return _Item([("vmf", (sc.ap + self.row(y0 + r) + c0) & 0xFFFF, b, c1 - c0, n, self.stride)
                          for r, n, b in _fill_groups(ent.fill)])
        img = _Pseudo(self.VW, rows, ent.kerns, bytes(ent.vms) if ent.flags & F_RAND else b"")
        kerns, vms, ref = clip_image(img, self.stride, 0, y0, c0, c1, y0, y0 + rows)
        if vms and self.sc.vms_bank1 and (c0, c1) == (0, self.VW):          # volle Breite: unbeschnitten
            item = self._clipped_item(vb, kerns, None, ref, ent.rand_ofs)
            item.ents.append(self._vms_ent(kind, ent, (vb + ent.rand_ofs) & 0xFFFF,
                                           (sc.ap + self.row(ref[1]) + ref[0]) & 0xFFFF))
            return item
        return self._clipped_item(vb, kerns, vms, ref, ent.rand_ofs)

    def _clipped_item(self, vb, kerns, vms, ref, rand_ofs, obj=None):
        sc = self.sc
        ents = [("vmc", (vb + src) & 0xFFFF, (sc.ap + self.row(y) + x) & 0xFFFF, w, reps, self.stride, ss)
                for src, x, y, w, reps, ss in kerns]
        if vms:
            ents.append(("vms", (vb + rand_ofs) & 0xFFFF, (sc.ap + self.row(ref[1]) + ref[0]) & 0xFFFF, bytes(vms)))
        return _Item(ents, obj)

    def bg_item(self, r0, r1, c0, c1):
        sc, stride = self.sc, self.stride
        ents = []
        if sc.dbg is None:
            n = r1 - r0
            ents.append(("vmf", (sc.ap + self.row(r0) + c0) & 0xFFFF, sc.bgfill, c1 - c0, n, stride))
            return _Item(ents)
        bg = sc.dbg
        y0, h, P = bg["y0"], bg["h"], bg["P"]
        o = bg["offsets"][self.v]
        vb = sc.vram_bases["dbg"]

        def fill_rows(a, b):
            if b <= a:
                return
            for r, n, byte in _fill_groups([bg["fill"][i] for i in range(a, b)]):
                ents.append(("vmf", (sc.ap + self.row(a + r) + c0) & 0xFFFF, byte, c1 - c0, n, stride))
        fill_rows(r0, min(r1, y0))
        a, b = max(r0, y0), min(r1, y0 + h)
        if b > a:
            q = (o + c0) % P
            n = c1 - c0
            src = vb + (a - y0) * P
            dst = sc.ap + self.row(a) + c0
            if q + n <= P:
                ents.append(("vmc", (src + q) & 0xFFFF, dst & 0xFFFF, n, b - a, stride, P))
            else:
                n1 = P - q
                ents.append(("vmc", (src + q) & 0xFFFF, dst & 0xFFFF, n1, b - a, stride, P))
                ents.append(("vmc", src & 0xFFFF, (dst + n1) & 0xFFFF, n - n1, b - a, stride, P))
        fill_rows(max(r0, y0 + h), r1)
        return _Item(ents)

    # ---- Durchlauf
    def run(self):
        try:
            for d in range(self.D + 1):
                self.pend = []
                self.lue = {KIND_FLOOR: False, KIND_CEIL: False}
                self.depth_cells(d)
                self.baender(d, KIND_FLOOR)
                self.baender(d, KIND_CEIL)
                self.tapete(d)
                for c0, c1, ziel in self.pend:
                    self.mark(self.bcov, c0, c1)
                    if ziel == "both":
                        self.mark(self.cover, c0, c1)
                if self.ncov == self.VW:
                    break
        except _Stop:
            pass
        return self.output()

    def depth_cells(self, d):
        for s, ce in self.cells_of(d):
            c = self.cell(d, s)
            t = self.tile(c)
            faces = self.faces(t)
            for e in self.cell_order(ce, t):
                if e.art in (ART_FRONT, ART_SIDE):
                    if not faces:
                        continue
                    ent = self.resolve(KIND_WALL, e.index, t.walls[self.face_of(e)])
                    if ent is None or self.allcov(self.cover, e.x, e.x + e.w):
                        continue
                    self.add(self.wall_item(KIND_WALL, e, ent))
                    if self.deck(e, t, ent):
                        if e.art == ART_FRONT:
                            self.mark(self.cover, e.c0, e.c1)
                            if e.flags & DVG_BANDCOVER:
                                self.mark(self.bcov, e.c0, e.c1)
                            else:
                                self.pend.append((e.c0, e.c1, "bcov"))
                        else:
                            self.pend.append((e.c0, e.c1, "both"))
                elif e.art == ART_OBJ and d >= 1 and (not faces or t.flags & T_INHALT):
                    self.objekte(d, e, c)

    def objekte(self, d, e, c):
        for cand in reversed(self.candidates(c)):
            r = self.sprite_image(cand, d)
            if r is None:
                continue
            ss, img, setn = r
            p, oi = cand[0], cand[4]
            ax, ay = e.anchors[p]
            x0, y0 = ax - img.fx, ay - img.fy
            cx0, cx1 = max(x0, 0), min(x0 + img.w, self.VW)
            cy0, cy1 = max(y0, 0), min(y0 + img.h, self.sc.dvg.vh)
            if cx0 >= cx1 or cy0 >= cy1:
                continue
            free = [x for x in range(cx0, cx1) if not self.cover[x]]
            if not free:
                continue
            cx0, cx1 = free[0], free[-1] + 1
            kerns, vms, ref = clip_image(img, self.stride, x0, y0, cx0, cx1, cy0, cy1)
            vb = self.sc.vram_bases["s2"][setn]
            if vms and self.sc.vms_bank1 and (cx0, cx1, cy0, cy1) == (x0, x0 + img.w, y0, y0 + img.h):
                item = self._clipped_item(vb, kerns, None, ref, img.rand_ofs, oi)     # unbeschnitten: Typ 9
                item.ents.append(("vms1", (vb + img.rand_ofs) & 0xFFFF, (self.sc.ap + self.row(y0) + x0) & 0xFFFF,
                                  (self.sc.s2_bank1(setn) + _s2_vofs(ss)[id(img)]) & 0xFFFF, bytes(img.vms)))
            else:
                item = self._clipped_item(vb, kerns, vms, ref, img.rand_ofs, oi)
            if item.v == 0:
                continue
            self.add(item)

    def baender(self, d, kind):
        plan = self.band_plan(d, kind)
        if plan is None:
            return
        self.lue[kind] = plan["luecke"]
        y0, y1 = plan["rows"]
        for e, n in plan["tiles"]:
            ent = self.resolve(kind, e.index, n)
            if ent is None or self.allcov(self.bcov, e.x, e.x + e.w):
                continue
            self.add(self.wall_item(kind, e, ent))
        g = plan["ground"]
        if isinstance(g, tuple):
            for c0, c1 in reversed(self.spans(self.bcov)):
                self.add(self.band_item(kind, g[2], y0, y1 - y0, c0, c1))

    def tapete(self, d):
        g = self.g.depth[d]
        rows = []
        if self.lue[KIND_CEIL]:
            rows.append((g.cy0, g.cy1))
        if d == self.D:
            rows.append((self.g.hy0, self.g.hy1))
        if self.lue[KIND_FLOOR]:
            rows.append((g.fy0, g.fy1))
        merged = []
        for r0, r1 in rows:
            if r1 <= r0:
                continue
            if merged and merged[-1][1] == r0:
                merged[-1] = (merged[-1][0], r1)
            else:
                merged.append((r0, r1))
        sp = self.spans(self.bcov)
        for r0, r1 in reversed(merged):
            for c0, c1 in reversed(sp):
                self.add(self.bg_item(r0, r1, c0, c1))

    # ---- Ausgabe (Einpass, P6d-opt)
    def output(self):
        """Eintraege in Erzeugungsreihenfolge (vorne -> hinten); jeder wird sofort geschrieben: VMS-Listen aufwaerts
        ab B0, VCL-Eintraege abwaerts ab B1 (Ende-Byte bei B1 - 1). Die VCL-Liste ab VCLADR ist damit die umgekehrte
        Erzeugungsreihenfolge (hinten -> vorne, innerhalb eines Sichtlisteneintrags ebenfalls umgekehrt)."""
        b0, b1 = self.sc.buf
        parts, vms, lists1 = [], bytearray(), {}
        for item in self.items:
            for e in item.ents:
                if e[0] == "vmc":
                    _, src, dst, cnt, reps, step, ss = e
                    if ss == 0:
                        parts.append(bytes((2,)) + struct.pack("<HHHHH", src, dst, cnt, reps, step))
                    else:
                        parts.append(bytes((3,)) + struct.pack("<HHHHHH", src, dst, cnt, reps, step, ss))
                elif e[0] == "vmf":
                    _, va, byte, cnt, reps, step = e
                    if reps == 1:
                        parts.append(bytes((4,)) + struct.pack("<HHH", va, byte, cnt))
                    else:
                        parts.append(bytes((5,)) + struct.pack("<HHHHH", va, byte, cnt, reps, step))
                elif e[0] == "vms":
                    _, src, dst, lst = e
                    parts.append(bytes((12,)) + struct.pack("<HHH", src, dst, (b0 + len(vms)) & 0xFFFF))
                    vms += lst
                else:
                    _, src, dst, addr, lst = e
                    parts.append(bytes((9,)) + struct.pack("<HHH", src, dst, addr))
                    lists1[addr] = lst
        vcl = b"".join(reversed(parts)) + b"\0"
        if len(vcl) != self.nv or len(vms) != self.nm:
            raise ViewError("interner Fehler: Groessenrechnung %d/%d != %d/%d" % (self.nv, self.nm, len(vcl), len(vms)))
        a = E_TOOMANY if self.err else (E_PARTIAL if self.partial else E_OK)
        return Result(a=a, x=min(len(parts), 255), y=0, p0=b1 - len(vcl), b0=b0, vcl=vcl, vms=bytes(vms),
                      vcllen=len(vcl), vmslen=len(vms), objvis=self.objvis, partial=self.partial,
                      items=len(self.items), lists1=lists1)


def _vms_offsets(ts):
    """id(Verzeichniseintrag) -> vofs (inhaltsrelativer Offset der VMS-Liste in der DTS-Datei, P5)."""
    cache = getattr(ts, "_vofs", None)
    if cache is None:
        c = (getattr(ts, "dts_prg", None) or dbetex.to_dts(ts))[2:]
        o_dir = c[16] | c[17] << 8
        cache = {id(e): c[o_dir + 16 * b + 10] | c[o_dir + 16 * b + 11] << 8 for b, e in enumerate(ts.entries)}
        ts._vofs = cache
    return cache


def _s2_content(ss):
    """Inhalt der S2-Datei (ohne Ladeadresse), zwischengespeichert."""
    c = getattr(ss, "_s2c", None)
    if c is None:
        import dbespr
        c = ss._s2c = dbespr.to_s2(ss)[2:]
    return c


def _s2_vofs(ss):
    """id(Bild) -> vofs (inhaltsrelativer Offset der VMS-Liste in der S2-Datei, P5b)."""
    cache = getattr(ss, "_s2vofs", None)
    if cache is None:
        c = _s2_content(ss)
        o_dir = c[18] | c[19] << 8
        cache = {id(im): c[o_dir + 16 * b + 12] | c[o_dir + 16 * b + 13] << 8 for b, im in enumerate(ss.images)}
        ss._s2vofs = cache
    return cache


@dataclass
class _Pseudo:
    """Bildbeschreibung eines Bandes fuer clip_image."""
    w: int
    h: int
    kerns: list
    vms: bytes


def view(scene):
    """VIEW nach P6 Abschnitt 5: VMS-Listen ab scene.buf[0], VCL-Liste ab Result.p0 bis scene.buf[1] (Einpass)."""
    if scene.dvg is None or scene.dmp is None:
        raise ViewError("E_STATE: DVG/Karte fehlt")
    return _View(scene).run()


# ---------------------------------------------------------------- VCL-Interpreter

def _copy(vram, s, d, n):
    if n <= 0:
        return
    if s + n <= 65536 and d + n <= 65536 and (d <= s or d >= s + n):
        vram[d:d + n] = vram[s:s + n]
        return
    for i in range(n):
        vram[(d + i) & 0xFFFF] = vram[(s + i) & 0xFFFF]


def _sw(v):
    return v - 65536 if v > 32767 else v


def vmc(vram, src, dst, count, reps=1, step=0, srcstep=0):
    """VDC-BASIC VMC: srcstep 0 = Quelle hinter dem vorigen Lauf."""
    for r in range(reps):
        s = (src + r * (srcstep if srcstep else count)) & 0xFFFF
        _copy(vram, s, (dst + r * step) & 0xFFFF, count)


def vmf(vram, dst, byte, count, reps=1, step=0):
    n = count or 65536
    for r in range(reps):
        d = (dst + r * step) & 0xFFFF
        for i in range(n):
            vram[(d + i) & 0xFFFF] = byte & 255


def vms(bank0, vram, src, dst, addr, rowstep=80):
    """VDC-BASIC VMS nach vms-format.md: Typ 1, 8, 3 (v3), 2."""
    alpha = bank0[addr]
    n = bank0[addr + 1] | bank0[addr + 2] << 8
    p, rd = addr + 3, src
    for _ in range(n):
        t = bank0[p]
        if t == 1:
            ofs = bank0[p + 1] | bank0[p + 2] << 8
            ln = bank0[p + 3]
            p += 4
            _copy(vram, rd & 0xFFFF, (dst + ofs) & 0xFFFF, ln)
            rd += ln
        elif t == 8:
            ofs = bank0[p + 1] | bank0[p + 2] << 8
            p += 3
            b = vram[rd & 0xFFFF]
            rd += 1
            a = (dst + ofs) & 0xFFFF
            if (b & 15) == alpha:
                vram[a] = (b & 0xF0) | (vram[a] & 15)
            else:
                vram[a] = (vram[a] & 0xF0) | (b & 15)
        elif t == 3:
            rd += bank0[p + 1] | bank0[p + 2] << 8
            p += 3
        elif t == 2:
            cnt = bank0[p + 1] | bank0[p + 2] << 8
            reps = bank0[p + 3] | bank0[p + 4] << 8
            p += 5
            vmc(vram, rd & 0xFFFF, dst, cnt, reps, rowstep)
        else:
            raise ViewError(f"INVALID VMS COMMAND {t}")


def rxv(bank0, vram, src, dst):
    pos = dst
    for t in vrl.decode_tokens(bytes(bank0[src:])):
        if t.kind == "end":
            break
        if t.kind == "lit":
            for i, b in enumerate(t.value):
                vram[(pos + i) & 0xFFFF] = b
        elif t.kind in ("run", "lrun"):
            for i in range(t.length):
                vram[(pos + i) & 0xFFFF] = t.value
        pos += t.length


def run_vcl(bank0, vram, addr, rowstep=80, bank1=None):
    """Fuehrt die VCL-Liste bei addr in bank0 aus (vcl-format.md); veraendert vram. Rueckgabe: Anzahl Eintraege.
    Typ 13 (SYN) tut nichts. Typ 2 in VMS nutzt rowstep statt VDC-Register 1. Typ 9 (Vorschlag P6d-opt, VDC-BASIC):
    wie 12, die Liste liegt in bank1."""
    p = addr
    count = 0

    def w(i):
        return bank0[p + i] | bank0[p + i + 1] << 8
    while True:
        t = bank0[p]
        if t == 0:
            return count
        count += 1
        if t == 1:
            vmc(vram, w(1), w(3), w(5))
            p += 7
        elif t == 2:
            vmc(vram, w(1), w(3), w(5), (w(7) & 255) or 256, _sw(w(9)))
            p += 11
        elif t == 3:
            vmc(vram, w(1), w(3), w(5), (w(7) & 255) or 256, _sw(w(9)), _sw(w(11)))
            p += 13
        elif t == 4:
            vmf(vram, w(1), w(3) & 255, w(5))
            p += 7
        elif t == 5:
            vmf(vram, w(1), w(3) & 255, w(5), (w(7) & 255) or 256, _sw(w(9)))
            p += 11
        elif t == 6:
            vram[w(1)] = w(3) & 255
            p += 5
        elif t == 7:
            reps = (w(5) & 255) or 1
            for r in range(reps):
                vram[(w(1) + r * _sw(w(7))) & 0xFFFF] = w(3) & 255
            p += 9
        elif t == 8:
            rxv(bank0, vram, w(1), w(3))
            p += 5
        elif t == 12:
            vms(bank0, vram, w(1), w(3), w(5), rowstep)
            p += 7
        elif t == 9 and bank1 is not None:
            vms(bank1, vram, w(1), w(3), w(5), rowstep)
            p += 7
        elif t == 13:
            p += 3 + 4 * (w(1) & 255)
        else:
            raise ViewError(f"INVALID VCL type {t} bei {p:#06x}")


def decode_vcl(buf, off=0):
    """VCL-Liste ab buf[off] als Liste von Tupeln (Typ, Parameter...) bis zum Ende-Byte (ohne dieses)."""
    out, p = [], off
    lens = {1: 3, 2: 5, 3: 6, 4: 3, 5: 5, 6: 2, 7: 4, 8: 2, 9: 3, 12: 3}
    while buf[p]:
        t = buf[p]
        if t == 13:
            n = (buf[p + 1] | buf[p + 2] << 8) & 255
            out.append((13, n))
            p += 3 + 4 * n
            continue
        n = lens[t]
        out.append((t,) + struct.unpack_from("<" + "H" * n, bytes(buf), p + 1))
        p += 1 + 2 * n
    return out


def render_view(scene, vram=None, res=None, seed=0):
    """view() und run_vcl() in ein VRAM-Abbild (Zufallsinhalt, falls nicht gegeben). Rueckgabe (vram, Result)."""
    res = res or view(scene)
    if vram is None:
        vram = scene.make_vram(seed)
    run_vcl(res.bank0(), vram, res.p0, bank1=res.bank1())
    return vram, res


# ---------------------------------------------------------------- unabhaengiger Maler

class _Painter(_Ctx):
    def __init__(self, sc, vram):
        super().__init__(sc)
        self.vram = vram
        self.ts = []
        for ts in sc.dts:
            w = None
            if ts is not None:
                w = copy.copy(ts)
                w.slots = self.synth_slots(ts)
            self.ts.append(w)

    def synth_slots(self, ts):
        slots = [None] * sum(1 for v in ts.slot_map if v != dbetex.FALLBACK)
        for pos, k in enumerate(ts.slot_map):
            if k == dbetex.FALLBACK:
                continue
            if pos < self.ne:
                e = self.g.elems[pos]
                slots[k] = {"rect": (e.x, e.y, e.w, e.h)}
            else:
                i = pos - self.ne
                d = i if i <= self.D else i - self.D - 1
                dt = self.g.depth[d]
                y0, y1 = (dt.cy0, dt.cy1) if i <= self.D else (dt.fy0, dt.fy1)
                slots[k] = {"rect": (0, y0, self.VW, y1 - y0)}
        return slots

    def put_entry(self, kind, st, k, x, y):
        sc = self.sc
        t0 = (sc.ap + self.row(y) + x) & 0xFFFF
        dbetex.render(self.ts[kind], st, k, self.vram, self.vram, stride=self.stride,
                      vb=sc.vram_bases["dts"][kind], t0=t0)

    def row_fill(self, r0, r1):
        """Tapete fuer die Zeilen [r0, r1), volle Breite, byteweise (unabhaengig von Spannen und VMC)."""
        sc = self.sc
        for r in range(r0, r1):
            base = sc.ap + self.row(r)
            if sc.dbg is None:
                for x in range(self.VW):
                    self.vram[(base + x) & 0xFFFF] = sc.bgfill
                continue
            bg = sc.dbg
            y0, h, P = bg["y0"], bg["h"], bg["P"]
            if y0 <= r < y0 + h:
                o = bg["offsets"][self.v]
                for x in range(self.VW):
                    self.vram[(base + x) & 0xFFFF] = self.vram[(sc.vram_bases["dbg"] + (r - y0) * P + (o + x) % P) & 0xFFFF]
            else:
                for x in range(self.VW):
                    self.vram[(base + x) & 0xFFFF] = bg["fill"][r]

    def sprite(self, ss, img, setn, x0, y0):
        """Zeichnet das Bild am Fenster beschnitten: Bild unbeschnitten in zwei Schmierpuffer (0x00 / 0xFF),
        Nibbles, die in beiden gleich sind, hat das Bild geschrieben; nur diese kommen ins Fenster."""
        sc, stride = self.sc, self.stride
        vb = sc.vram_bases["s2"][setn]
        size = img.h * stride + 130
        bufs = []
        for fill in (0x00, 0xFF):
            fb = bytearray([fill]) * size
            for k in img.kerns:
                dbetex.sim_vmc(self.vram, vb + k.src, k.dy * stride + k.dx, k.w, k.h, stride, k.srcstep, fb=fb)
            if img.vms:
                dbetex.sim_vms(self.vram, vb + img.rand_ofs, 0, img.vms, fb=fb)
            bufs.append(fb)
        a, b = bufs
        for r in range(img.h):
            wy = y0 + r
            if not 0 <= wy < self.VH:
                continue
            for bx in range(img.w):
                wx = x0 + bx
                if not 0 <= wx < self.VW:
                    continue
                va, vb_ = a[r * stride + bx], b[r * stride + bx]
                addr = (sc.ap + self.row(wy) + wx) & 0xFFFF
                cur = self.vram[addr]
                if va >> 4 == vb_ >> 4:
                    cur = (cur & 0x0F) | (va & 0xF0)
                if va & 15 == vb_ & 15:
                    cur = (cur & 0xF0) | (va & 15)
                self.vram[addr] = cur

    def objects(self, d, e, c):
        for cand in self.candidates(c):
            r = self.sprite_image(cand, d)
            if r is None:
                continue
            ss, img, setn = r
            ax, ay = e.anchors[cand[0]]
            self.sprite(ss, img, setn, ax - img.fx, ay - img.fy)

    def band(self, d, kind):
        plan = self.band_plan(d, kind)
        if plan is None:
            return
        y0, y1 = plan["rows"]
        g = plan["ground"]
        if isinstance(g, tuple):
            r = self.resolve_idx(kind, plan["bslot"], g[1] + 1)
            self.put_entry(kind, r[0], r[1], 0, y0)
        for e, n in reversed(plan["tiles"]):        # aussen -> innen (Randpixel benachbarter Kacheln ueberlappen)
            r = self.resolve_idx(kind, e.index, n)
            if r is not None:
                self.put_entry(kind, r[0], r[1], e.x, e.y)

    def run(self):
        for d in range(self.D, -1, -1):
            pf, pc = self.band_plan(d, KIND_FLOOR), self.band_plan(d, KIND_CEIL)
            dt = self.g.depth[d]
            rows = []
            if pc and pc["luecke"]:
                rows.append((dt.cy0, dt.cy1))
            if d == self.D:
                rows.append((self.g.hy0, self.g.hy1))
            if pf and pf["luecke"]:
                rows.append((dt.fy0, dt.fy1))
            for r0, r1 in rows:
                self.row_fill(r0, r1)
            self.band(d, KIND_CEIL)
            self.band(d, KIND_FLOOR)
            for s, ce in reversed(self.cells_of(d)):
                c = self.cell(d, s)
                t = self.tile(c)
                faces = self.faces(t)
                order = list(reversed(self.cell_order(ce, t)))     # Malreihenfolge = Umkehrung der Sichtreihenfolge
                for e in order:
                    if e.art in (ART_FRONT, ART_SIDE) and faces:
                        r = self.resolve_idx(KIND_WALL, e.index, t.walls[self.face_of(e)])
                        if r is not None:
                            self.put_entry(KIND_WALL, r[0], r[1], e.x, e.y)
                    elif e.art == ART_OBJ and d >= 1 and (not faces or t.flags & T_INHALT):
                        self.objects(d, e, c)


def paint_reference(scene, vram):
    """Malt alles, was nach Karte und Stilen existiert, in Plan-Reihenfolge (Plan 5): ohne Abdeckung und Spannen,
    Baender und Tapete volle Breite, Sprites nur am Fenster beschnitten. Veraendert nur das Sichtfenster."""
    _Painter(scene, vram).run()
    return vram


# ---------------------------------------------------------------- Bild des Sichtfensters

def window_image(scene, vram, zoom=1):
    g = scene.dvg
    base = (scene.ap + g.origin) & 0xFFFF
    return dbetex.fb_to_image(vram, g.vw, g.vh, g.stride, base, zoom)


def window_bytes(scene, vram):
    g = scene.dvg
    return [bytes(vram[(scene.ap + g.row(y) + x) & 0xFFFF] for x in range(g.vw)) for y in range(g.vh)]


# ---------------------------------------------------------------- Sprite-Saetze (minimaler S2-Schreiber fuer Tests)

def make_s2(images, D, NA, NP, stride, angle_map=None, gid=0, flags=0, max_kerns=4, kern_min=16, load=0x7000):
    """Minimaler S2-Schreiber nach P5b 4 (Dateischnittstelle; dbespr.py ist der eigentliche Importer).

    images: {(phase, ai, d): (rows, fx, fy)}; rows = Pixelzeilen (Palettenindex 0-15 oder None, gerade Breite).
    Fehlende Bilder: Phase 0 -> $FE, Phase >= 1 -> $FF. Gleiche Bilder werden zusammengelegt.
    Rueckgabe (S2-PRG, VRAM-Daten)."""
    amap = angle_map or dbespr_default_map(NA)
    order = sorted(images)
    ents, keys, vram = [], {}, bytearray()
    index = [0xFE] * (NP * NA * D)
    for (f, ai, d) in order:
        rows, fx, fy = images[(f, ai, d)]
        key = (tuple(tuple(r) for r in rows), fx, fy)
        if key not in keys:
            pix = [list(r) for r in rows]
            states = dbetex.classify(pix)
            dbetex.resolve_alpha_conflict(pix, states)
            kerns = dbetex.choose_kerns(states, max_kerns, kern_min)
            alpha, rand, vms = dbetex.pack_image(pix, states, kerns, stride)
            e = {"w": len(rows[0]) // 2, "h": len(rows), "fx": fx, "fy": fy, "kerns": [], "vms": vms,
                 "rand_ofs": 0, "rand_len": len(rand)}
            for kx, ky, kw, kh in kerns:
                e["kerns"].append((len(vram), kx, ky, kw, kh))
                vram += dbetex.kern_bytes(pix, [(kx, ky, kw, kh)])
            e["rand_ofs"] = len(vram) if rand else 0
            vram += rand
            keys[key] = len(ents)
            ents.append(e)
        index[(f * NA + ai) * D + d - 1] = keys[key]
    for f in range(1, NP):
        for ai in range(NA):
            for d in range(1, D + 1):
                i = (f * NA + ai) * D + d - 1
                if index[i] == 0xFE:
                    index[i] = 0xFF
    ni = len(ents)
    nk = sum(len(e["kerns"]) for e in ents)
    o_idx = 40
    o_dir = o_idx + len(index)
    o_kern = o_dir + 16 * ni
    o_tag = o_kern + 8 * nk
    o_data = o_tag
    dirs, kerns, data = bytearray(), bytearray(), bytearray()
    kpos = o_kern
    for e in ents:
        kofs = 0
        if e["kerns"]:
            kofs = kpos
            for src, kx, ky, kw, kh in e["kerns"]:
                kerns += struct.pack("<HBBBBH", src, kx, ky, kw, kh, 0)
            kpos += 8 * len(e["kerns"])
        vofs = vlen = 0
        if e["vms"]:
            vofs, vlen = o_data + len(data), len(e["vms"])
            data += e["vms"]
        dirs += struct.pack("<BBBBBBHHHHH", 8 if e["rand_len"] else 0, e["w"], e["h"], e["fx"], e["fy"],
                            len(e["kerns"]), kofs, e["rand_ofs"], e["rand_len"], vofs, vlen)
    total = o_data + len(data)
    import binascii
    head = bytearray(40)
    head[0:3] = b"S2\x01"
    head[3] = flags
    struct.pack_into("<H", head, 4, gid)
    head[6], head[7], head[8], head[9] = D, NA, NP, ni
    struct.pack_into("<H", head, 10, nk)
    head[12:16] = bytes(amap)
    struct.pack_into("<HHHH", head, 16, o_idx, o_dir, o_kern, o_tag)
    struct.pack_into("<HHHHH", head, 26, o_data, total, len(vram), binascii.crc_hqx(bytes(vram), 0xFFFF), 0)
    struct.pack_into("<H", head, 34, stride)
    out = bytes(head) + bytes(index) + bytes(dirs) + bytes(kerns) + bytes(data)
    assert len(out) == total
    return struct.pack("<H", load) + out, bytes(vram)


def dbespr_default_map(na):
    return {1: [0, 0, 0, 0], 2: [0, 0, 1, 0], 3: [0, 1, 2, 1], 4: [0, 1, 2, 3]}[na]


def read_s2(prg, vram):
    """S2-PRG + VRAM-Daten -> SpriteSet ueber dbespr.from_s2 (P5b 6.3)."""
    import dbespr
    return dbespr.from_s2(prg, vram)


# ---------------------------------------------------------------- Demo-Assets

def sprite_pixels(kind, w_px, h, ai, f):
    """Pixelbild (Zeilen mit Palettenindex oder None) fuer Testsprites; Bildwinkel ai und Phase f aendern das Muster."""
    pix = [[None] * w_px for _ in range(h)]
    for r in range(h):
        # Umriss: Ellipse (Gegner) bzw. Raute (Gegenstand)
        t = (r + 0.5) / h
        if kind == "gem":
            half = (0.5 - abs(t - 0.5)) * w_px * (1.1 + 0.15 * (f & 1))
        else:
            half = w_px / 2 * (1 - (2 * t - 1) ** 2) ** 0.5 if 0 < t < 1 else 0
        for x in range(w_px):
            if abs(x + 0.5 - w_px / 2) <= half:
                pix[r][x] = (9, 13, 5, 3)[ai & 3] if kind != "gem" else (11, 7)[f & 1]
    if kind != "gem":
        # Augen (Loch) und Streifen je nach Bildwinkel
        ey = max(1, h // 4)
        ex = w_px // 2 + (-1, 0, 1, 0)[ai & 3] * max(1, w_px // 5)
        for dx in (-1, 0):
            for dy in range(max(1, h // 8)):
                x, y = ex + dx - (1 if ai & 1 else 0), ey + dy
                if 0 <= y < h and 0 <= x < w_px and pix[y][x] is not None and (ai != 2):
                    pix[y][x] = None if f == 0 else 15
        sy = h * 2 // 3
        for x in range(w_px):
            if pix[sy][x] is not None and (x + f) % 4 < 2:
                pix[sy][x] = 0
        for x in range(0, w_px, 5):                   # einzelne Pixel am Rand: halbe Bytes
            if pix[h // 2][x] is not None:
                pix[h // 2][x] = None
    return pix


def make_sprite_set(dvg, name="blob", NA=4, NP=2, phases_depths=None, wide=1.0, height=0.8, kind="blob", odd=0):
    """Bilder je (Phase, Winkel, Tiefe), skaliert nach der Zellbreite; Hoehe hoechstens Wandhoehe der Tiefe (5.4).
    Rueckgabe (SpriteSet, VRAM-Daten, PRG)."""
    D, stride = dvg.D, dvg.stride
    images = {}
    for d in range(1, D + 1):
        fw = dvg.depth[d].fw
        dt = dvg.depth[d]
        hmax = dt.fy0 - dt.cy0 + 1
        w_b = max(2, int(fw * 0.4 * wide))
        w_px = 2 * w_b
        h = max(3, min(hmax, int((dt.fy1 - dt.cy0) * height)))
        for f in range(NP):
            for ai in range(NA):
                if phases_depths is not None and (f, d) not in phases_depths and f > 0:
                    continue
                pix = sprite_pixels(kind, w_px, h, ai, f)
                if odd:                                    # Bild beginnt auf ungerader Pixelspalte: linkes Pixel leer
                    pix = [[None] + r[:-1] for r in pix]
                images[(f, ai, d)] = (pix, w_b // 2, h - 1)
    prg, vram = make_s2(images, D, NA, NP, stride, flags=1 if kind == "gem" else 0)
    return read_s2(prg, vram), vram, prg


GEN_FLOOR_TOML = '''format  = "dbetex"
version = 1

[texset]
name = "{name}"
kind = "{kind}"
geom = "west140.geom.json"
out  = "build"
load = {load}
max_kerns = 4

{styles}'''


def _atlas_styles(geom, outdir):
    """Zusaetzliche Boden- und Deckenstile: textureller Bandverlauf (kein ZEILEN), Pfuetze mit Loechern, ohne Baender."""
    import dbetexdemo as dd
    from PIL import Image

    def make(path, arts, fn_band, fn_tile):
        im = Image.new("RGBA", tuple(geom["atlas_size"]), (0, 0, 0, 0))
        for name, d, rect, mask, (ax, ay) in dd._boxes(geom, arts):
            dd._paint(im, ax, ay, rect, mask, fn_band if "band" in name else fn_tile(d))
        im.save(path)
    P = lambda n: os.path.join(outdir, n)
    make(P("gras_atlas.png"), ("floor", "floorband"), lambda px, r: 4 if (px // 3 + r) % 5 else 5,
         lambda d: (lambda px, r: 4 if (px + r) % 4 else 5))
    make(P("pfuetze_atlas.png"), ("floor", "floorband"), lambda px, r: 3,
         lambda d: (lambda px, r: None if (px // 2 + r // 2) % 3 == 0 else 3))
    make(P("loch_atlas.png"), ("ceil", "ceilband"), lambda px, r: 10,
         lambda d: (lambda px, r: None if (px // 4 + r // 3) % 2 == 0 else 10))


@dataclass
class Assets:
    dvg: Dvg
    geom: dict
    walls: object
    floor: object
    ceil: object
    dbg: dict
    dbg_vram: bytes
    sprites: list
    dir: str = ""
    dvg_prg: bytes = b""


def build_demo_assets(outdir):
    """Erzeugt (deterministisch) DVG 140 x 96, Wand-DTS (4 Stile), Boden-DTS (3 Stile), Decken-DTS (3 Stile), DBG und
    Sprite-Saetze in outdir und liefert sie als Assets."""
    import dbetexdemo
    os.makedirs(outdir, exist_ok=True)
    dbetexdemo.generate(outdir)
    geom = dbetex.load_geom(os.path.join(outdir, "west140.geom.json"), os.path.join(outdir, "west140.dvg"))
    with open(os.path.join(outdir, "west140.dvg"), "rb") as f:
        dvg_prg = f.read()
    dvg = parse_dvg(dvg_prg)
    _atlas_styles(geom, outdir)
    empty_f = ", ".join(f'"floorband_d{d}"' for d in range(dvg.D + 1))
    empty_c = ", ".join(f'"ceilband_d{d}"' for d in range(dvg.D + 1))
    ftoml = GEN_FLOOR_TOML.format(name="demo_floor3", kind="floor", load="0xF000", styles=(
        '[[style]]\nname = "stein"\npng = "stein_atlas.png"\n\n[[style]]\nname = "gras"\npng = "gras_atlas.png"\n\n'
        f'[[style]]\nname = "pfuetze"\npng = "pfuetze_atlas.png"\nempty = [{empty_f}]\n'))
    ctoml = GEN_FLOOR_TOML.format(name="demo_ceil3", kind="ceiling", load="0xF800", styles=(
        '[[style]]\nname = "holz"\npng = "holz_atlas.png"\n\n'
        f'[[style]]\nname = "loch"\npng = "loch_atlas.png"\nempty = [{empty_c}]\n'))
    for n, t in (("floor3.toml", ftoml), ("ceil3.toml", ctoml)):
        with open(os.path.join(outdir, n), "w", encoding="utf-8") as f:
            f.write(t)
    walls = dbetex.build_texset(dbetex.load_tex_conf(os.path.join(outdir, "walls.toml")))[0]
    floor = dbetex.build_texset(dbetex.load_tex_conf(os.path.join(outdir, "floor3.toml")))[0]
    ceil = dbetex.build_texset(dbetex.load_tex_conf(os.path.join(outdir, "ceil3.toml")))[0]
    dbg_prg, dbg_vram, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(outdir, "bg.toml")))
    dbg = dbetex.from_dbg(dbg_prg)
    spr = [None] * 8
    spr[0] = make_sprite_set(dvg, "blob", NA=4, NP=2, wide=0.4, height=0.4)[0]
    spr[1] = make_sprite_set(dvg, "gem", NA=1, NP=2, kind="gem", wide=0.5, height=0.3)[0]
    spr[2] = make_sprite_set(dvg, "wache", NA=2, NP=1, wide=0.35, height=0.6, odd=1)[0]
    spr[3] = make_sprite_set(dvg, "breit", NA=2, NP=2, wide=1.8, height=0.2, phases_depths={(1, 1)})[0]
    return Assets(dvg, geom, walls, floor, ceil, dbg, dbg_vram, spr, outdir, dvg_prg)


def with_band_cover(dvg):
    """Kopie der Dvg mit gesetztem DVG-Flag Bit 3 (Bandabdeckung) an allen Fronten, die die Bandzeilen enthalten."""
    d2 = copy.deepcopy(dvg)
    for e in d2.elems:
        if e.art == ART_FRONT:
            dt = d2.depth[e.d]
            if e.y <= dt.cy0 and e.y + e.h >= dt.fy1:
                e.flags |= DVG_BANDCOVER
    return d2


def dvg_bytes(dvg, load=0xE800):
    """Dvg -> DVG-PRG (P3 5; fuer Tests mit veraenderten Geometrien, z. B. with_band_cover, double_fronts).
    Die Geometrie-ID wird uebernommen (nicht neu berechnet), damit die DTS/S2 der Vorlage gueltig bleiben."""
    D, ne = dvg.D, len(dvg.elems)
    o_d, o_e = 24, 24 + 8 * (D + 1)
    total = o_e + 16 * ne
    out = bytearray(b"DV\x01") + bytes((dvg.vw, dvg.vh, D, dvg.S, ne))
    out += struct.pack("<HHH", dvg.stride, dvg.origin, dvg.gid) + bytes((dvg.hy0, dvg.hy1, 16, 8))
    out += struct.pack("<HHH", o_d, o_e, total)
    for dt in dvg.depth:
        out += bytes((dt.cy0, dt.cy1, dt.fy0, dt.fy1, dt.first, dt.n, dt.fw, dt.fx))
    for e in dvg.elems:
        if e.art == ART_OBJ:
            r = bytes((e.art, e.d, e.s & 255, 0)) + b"".join(bytes((ax & 255, ay)) for ax, ay in e.anchors) + b"\0\0"
        else:
            r = bytes((e.art, e.d, e.s & 255, e.flags, e.x, e.y, e.w, e.h, e.kx, e.ky, e.kw, e.kh, e.c0, e.c1,
                       e.src_dx, 0))
        out += r
    assert len(out) == total
    return struct.pack("<H", load) + bytes(out)


def double_fronts(assets, objs=False):
    """Synthetische Geometrie mit zwei Frontflaechen je Zelle (P6 9.3 zufall / 9.5 Crawl): jede Front der Tiefen
    d >= 1 bekommt eine Kopie (gleiches Bild ueber denselben Slot, Rechteck und Spaltenbereich um -1, +1 oder 0
    Spalten verschoben). Die Kopie steht abwechselnd direkt hinter der Front oder hinter der Seite der Zelle
    (DVG-Reihenfolge F, S, F': die INHALT-Reihenfolge 5.2a weicht davon ab). objs: zusaetzlich ein zweiter
    Objektplatz je Zelle (Anker um 3 Spalten und 1 Zeile verschoben, direkt hinter dem ersten). Rueckgabe: Assets mit
    neuer Dvg und angepassten Slotkarten der drei DTS (dvg_prg neu erzeugt)."""
    g = assets.dvg
    elems, src, depth = [], [], []
    k = 0
    for d, dt in enumerate(g.depth):
        first = len(elems)
        cells = []
        for e in g.elems[dt.first:dt.first + dt.n]:
            if not cells or cells[-1][0] != e.s:
                cells.append((e.s, []))
            cells[-1][1].append(e)
        for s, ce in cells:
            out = []
            for e in ce:
                out.append(e)
                if e.art == ART_FRONT and d >= 1:
                    sh = (-1, 1, 0)[k % 3]
                    if e.x + sh < 0 or e.x + e.w + sh > g.vw:
                        sh = 0
                    dup = copy.deepcopy(e)
                    dup.x += sh
                    if dup.flags & DVG_COVER:
                        dup.c0, dup.c1 = e.c0 + sh, e.c1 + sh
                    if k & 1:                       # hinter die Seite der Zelle
                        sides = [i for i, x in enumerate(ce) if x.art == ART_SIDE]
                        dup._after = ce[sides[0]] if sides else e
                    else:
                        dup._after = e
                    k += 1
                    out.append(dup)
                elif objs and e.art == ART_OBJ and d >= 1:
                    dup = copy.deepcopy(e)
                    dup.anchors = [(max(-128, min(127, ax + (3 if k & 1 else -3))), min(255, ay + 1))
                                   for ax, ay in e.anchors]
                    dup._after = e
                    k += 1
                    out.append(dup)
            # Kopien hinter ihr Bezugselement umsortieren
            ordered = [x for x in out if not hasattr(x, "_after")]
            for x in [x for x in out if hasattr(x, "_after")]:
                i = next(j for j, y in enumerate(ordered) if y is x._after)
                while i + 1 < len(ordered) and hasattr(ordered[i + 1], "_after"):
                    i += 1
                ordered.insert(i + 1, x)
            for x in ordered:
                src.append(x.index)
                y = copy.deepcopy(x)
                if hasattr(y, "_after"):
                    del y._after
                y.index = len(elems)
                elems.append(y)
        depth.append(DepthRow(dt.cy0, dt.cy1, dt.fy0, dt.fy1, first, len(elems) - first, dt.fw, dt.fx))
    if len(elems) > 255:
        raise ViewError("double_fronts: mehr als 255 Elemente")
    g2 = Dvg(g.vw, g.vh, g.D, g.S, g.stride, g.origin, g.gid, g.hy0, g.hy1, depth, elems)

    def ts2(ts):
        t = copy.copy(ts)
        t.__dict__.pop("_vofs", None)               # Cache der Vorlage (_vms_offsets) gilt fuer die neue Datei nicht
        t.slot_map = [ts.slot_map[i] for i in src] + list(ts.slot_map[len(g.elems):])
        t.ne = len(elems)
        # DTS-Bytes: dbetex.to_dts zaehlt NS aus der Slotkarte (doppelte Slots wuerden mitgezaehlt), daher die
        # Datei der Vorlage mit laengerer Slotkarte und verschobenen Offsets
        c = bytearray(dbetex.to_dts(ts)[2:])
        delta = len(t.slot_map) - len(ts.slot_map)
        o_slot, o_style, o_dir, o_kern, o_data, total = struct.unpack_from("<HHHHHH", c, 12)
        ni = c[10]
        for i in range(ni):
            for off in (4, 10):
                v = struct.unpack_from("<H", c, o_dir + 16 * i + off)[0]
                if v:
                    struct.pack_into("<H", c, o_dir + 16 * i + off, v + delta)
        c[6] = t.ne
        struct.pack_into("<HHHHHH", c, 12, o_slot, o_style + delta, o_dir + delta, o_kern + delta, o_data + delta,
                         total + delta)
        t.dts_prg = struct.pack("<H", 0x9000) + bytes(c[:o_slot]) + bytes(t.slot_map) + bytes(c[o_style:])
        t2 = dbetex.from_dts(t.dts_prg, ts.vram)
        assert t2.slot_map == t.slot_map and [e.kerns for e in t2.entries] == [e.kerns for e in ts.entries]
        return t
    a2 = copy.copy(assets)
    a2.dvg, a2.walls, a2.floor, a2.ceil = g2, ts2(assets.walls), ts2(assets.floor), ts2(assets.ceil)
    a2.dvg_prg = dvg_bytes(g2)
    return a2


def make_scene(assets, dmp, pos=None, direction=None, objects=(), itemtab=None, itemph=0, ap=0, dbg=True,
               bgfill=0x33, band_cover=False, buf=DEFAULT_BUF, sprites=True, start=None):
    sc = Scene(with_band_cover(assets.dvg) if band_cover else assets.dvg, dmp)
    sc.dts = [assets.walls, assets.floor, assets.ceil]
    if dbg:
        sc.dbg, sc.dbg_vram = assets.dbg, assets.dbg_vram
    sc.bgfill = bgfill
    if sprites:
        sc.s2 = list(assets.sprites)
    sc.itemtab = list(itemtab) if itemtab else [0] * 64
    sc.objects = list(objects)
    sc.itemph = itemph
    sc.pos = dmp.start if pos is None else pos
    sc.dir = dmp.direction if direction is None else direction
    sc.ap = ap
    sc.buf = buf
    return layout_vram(sc, start)


# ---------------------------------------------------------------- Zufallsszenen

def random_map(rnd, w, h, nt_styles=(4, 3, 3), name="zufall"):
    """Zufallskarte mit Wand-, Gitter-, Tuer-, Abgrund- und Bodenkacheln (P6 9.3 zufall)."""
    nw, nf, nc = nt_styles
    T = dbemap.Tile
    tiles = [T((0, 0, 0, 0), 1, 1, 0, 0, "gang")]
    for i in range(rnd.randint(8, 14)):
        kind = rnd.choice(["wand", "wand", "gitter", "tuer", "frei", "frei", "frei", "abgrund", "block"])
        if i < 2:
            kind = ("wand", "gitter")[i]               # mindestens eine Wand- und eine Gitterkachel
        floor = rnd.choice([0, 1, 1, 2, 3, nf + 1]) if kind not in ("wand", "block") else rnd.choice([0, 1])
        ceil = rnd.choice([0, 1, 1, 2, 3, nc + 1])
        if kind == "wand":
            st = rnd.randint(1, nw)
            tiles.append(T((st,) * 4 if rnd.random() < 0.7 else tuple(rnd.randint(1, nw) for _ in range(4)),
                           0, 0, T_WEG | T_DECKEND, 0))
        elif kind == "block":              # deckend, aber nicht alle Flaechen -> Boden/Decke zaehlen
            tiles.append(T((rnd.randint(1, nw), 0, rnd.randint(1, nw), rnd.randint(0, nw)), floor, ceil,
                           T_WEG | T_DECKEND, 0))
        elif kind in ("gitter", "tuer"):
            st = rnd.randint(1, nw)
            fl = (T_WEG if rnd.random() < 0.5 else 0) | (T_DECKEND if rnd.random() < 0.3 else 0)
            fl |= T_INHALT if rnd.random() < 0.5 else 0
            tiles.append(T((st, rnd.randint(0, nw), st, rnd.randint(0, nw)), floor, ceil, fl, 0))
        elif kind == "abgrund":
            tiles.append(T((0, 0, 0, 0), 0, rnd.choice([0, 1]), 0, 0))
        else:
            tiles.append(T((0, 0, 0, 0), floor, ceil, 0, 0))
    nt = len(tiles)
    # Raumstruktur: zusammenhaengende Zufallsflaechen
    walls = [i for i, t in enumerate(tiles) if any(t.walls)]
    opens = [i for i, t in enumerate(tiles) if not any(t.walls)]
    cells = [rnd.choice(walls) if rnd.random() < 0.35 else rnd.choice(opens) for _ in range(w * h)]
    for _ in range(w * h // 3):                       # Gaenge
        x, y = rnd.randrange(w), rnd.randrange(h)
        dx, dy = rnd.choice([(1, 0), (0, 1)])
        t = rnd.choice(opens[:3] + opens)
        for k in range(rnd.randint(3, 8)):
            if 0 <= x < w and 0 <= y < h:
                cells[y * w + x] = t
            x, y = x + dx, y + dy
    content = [rnd.choice([0, 0, 0, 0, 0, 0, 0, 1, 2, 3]) for _ in range(w * h)]
    start = next((i for i, c in enumerate(cells) if not tiles[c].flags & T_WEG), 0)
    if tiles[cells[start]].flags & T_WEG:
        cells[start] = 0
    m = dbemap.Map(name, w, h, tiles, cells, content, [], start, rnd.randrange(4), rnd.randrange(nt))
    dbemap.validate(m)
    return m


def random_objects(rnd, m, pos, v, n):
    """n Objekte in Zellen vor der Kamera (und einige beliebige)."""
    objs = []
    fx, fy = FORE[v]
    rx, ry = RIGHT[v]
    px, py = pos % m.width, pos // m.width
    for _ in range(n):
        d, s = rnd.randint(1, 3), rnd.randint(-3, 3)
        x, y = px + d * fx + s * rx, py + d * fy + s * ry
        if not (0 <= x < m.width and 0 <= y < m.height) or rnd.random() < 0.1:
            c = rnd.randrange(m.width * m.height)
        else:
            c = y * m.width + x
        objs.append(Obj(c, rnd.choice([0, 0, 1, 2, 3, 5]), rnd.choice([0, 1, 2, 3, 0xFF]), rnd.randint(0, 3),
                        rnd.randint(0, 7), rnd.random() < 0.1, rnd.random() < 0.2))
    return objs


def random_scene(seed, assets, w=None, h=None, nobj=None, band_cover=None, dbg=None, ap=0, buf=DEFAULT_BUF,
                 start=None):
    """Zufallsszene (Karte, Position, Richtung, Objekte, Gegenstaende, ITEMPH) aus den Demo-Assets."""
    rnd = random.Random(seed)
    w = w or rnd.randint(8, 24)
    h = h or rnd.randint(8, 24)
    nst = (len(assets.walls.styles), len(assets.floor.styles), len(assets.ceil.styles))
    m = random_map(rnd, w, h, nst)
    free = [i for i, c in enumerate(m.cells) if not m.tiles[c].flags & T_WEG]
    pos = rnd.choice(free)
    v = rnd.randrange(4)
    nobj = rnd.randint(0, 16) if nobj is None else nobj
    objs = random_objects(rnd, m, pos, v, nobj)
    itemtab = [0] * 64
    for g in (1, 2, 3):
        itemtab[g] = rnd.choice([0, 2, 3, 2])
    return make_scene(assets, m, pos, v, objs, itemtab, rnd.randint(0, 3), ap,
                      dbg=rnd.random() < 0.7 if dbg is None else dbg, bgfill=rnd.choice([0x00, 0x33, 0x55]),
                      band_cover=rnd.random() < 0.5 if band_cover is None else band_cover, buf=buf, start=start)


# ---------------------------------------------------------------- Szenendatei

def _dir(v):
    if isinstance(v, int):
        return v
    return {"N": 0, "O": 1, "S": 2, "W": 3, "-": 0xFF}[v.upper()]


def load_scene(path):
    """Szene aus TOML: [scene] dvg, map, pos, dir, ap, buf, itemph, bgfill; [walls]/[floor]/[ceil] dts, vrl (+ base);
    [background] dbg, vrl; [[sprites]] set, s2, vrl; [items] "<Nr>" = Satz; [[object]] at/cell, set, dir, phase, sub,
    hidden, noblock. Pfade relativ zur Datei; fehlende Basen werden dicht nach dem Sichtfenster vergeben."""
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    base = os.path.dirname(os.path.abspath(path))
    P = lambda n: os.path.join(base, n)
    if cfg.get("format") != "dbeview" or cfg.get("version") != 1:
        raise ViewError(f'{path}: format = "dbeview" und version = 1 erwartet')
    s = cfg["scene"]

    def rd(n):
        with open(P(n), "rb") as f:
            return f.read()
    dvg = parse_dvg(rd(s["dvg"]))
    mp = s["map"]
    m = dbemap.load_toml(P(mp)) if mp.endswith(".toml") else dbemap.from_dmp(rd(mp))
    sc = Scene(dvg, m)
    for k, key in enumerate(("walls", "floor", "ceil")):
        if key in cfg:
            vr = vrl.decode(vrl.unpack_file(rd(cfg[key]["vrl"]))[3])
            sc.dts[k] = dbetex.from_dts(rd(cfg[key]["dts"]), vr)
            if "base" in cfg[key]:
                sc.vram_bases["dts"][k] = cfg[key]["base"]
    if "background" in cfg:
        b = cfg["background"]
        sc.dbg = dbetex.from_dbg(rd(b["dbg"]))
        sc.dbg_vram = bytes(vrl.decode(vrl.unpack_file(rd(b["vrl"]))[3]))
        sc.vram_bases["dbg"] = b.get("base", 0)
    for sp in cfg.get("sprites", []):
        vr = bytes(vrl.decode(vrl.unpack_file(rd(sp["vrl"]))[3]))
        sc.s2[sp["set"]] = read_s2(rd(sp["s2"]), vr)
        sc.vram_bases["s2"][sp["set"]] = sp.get("base", 0)
    for k, v in cfg.get("items", {}).items():
        sc.itemtab[int(k)] = v + 1
    for o in cfg.get("object", []):
        cell = o["cell"] if "cell" in o else o["at"][1] * m.width + o["at"][0]
        sc.objects.append(Obj(cell, o["set"], _dir(o.get("dir", "-")), o.get("phase", 0), o.get("sub", 4),
                              o.get("hidden", False), o.get("noblock", False)))
    sc.itemph = s.get("itemph", 0)
    sc.bgfill = s.get("bgfill", 0)
    sc.ap = s.get("ap", 0)
    sc.buf = tuple(s.get("buf", DEFAULT_BUF))
    if "pos" in s:
        sc.pos = s["pos"][1] * m.width + s["pos"][0]
    else:
        sc.pos = m.start
    sc.dir = _dir(s["dir"]) if "dir" in s else m.direction
    explicit = any(k in cfg and "base" in cfg[k] for k in ("walls", "floor", "ceil", "background"))
    if not explicit:
        layout_vram(sc)
    return sc


# ---------------------------------------------------------------- Budget

def budget(scenes):
    """Bericht ueber eine Liste von Szenen: groesste VCL + VMS, Eintraege, Szenen mit A != 0."""
    rep = {"scenes": 0, "max_total": 0, "max_vcl": 0, "max_vms": 0, "max_entries": 0, "max_items": 0,
           "warnings": [], "codes": {}}
    for i, sc in enumerate(scenes):
        r = view(sc)
        rep["scenes"] += 1
        rep["max_total"] = max(rep["max_total"], r.vcllen + r.vmslen)
        rep["max_vcl"] = max(rep["max_vcl"], r.vcllen)
        rep["max_vms"] = max(rep["max_vms"], r.vmslen)
        rep["max_entries"] = max(rep["max_entries"], r.x)
        rep["max_items"] = max(rep["max_items"], r.items)
        rep["codes"][r.a] = rep["codes"].get(r.a, 0) + 1
        if r.a:
            rep["warnings"].append(f"Szene {i}: A = {r.a} ({'gekuerzt' if r.a == 2 else 'Raender weggelassen'}), "
                                   f"VCL {r.vcllen} + VMS {r.vmslen} von {sc.buf[1] - sc.buf[0]}")
    return rep


# ---------------------------------------------------------------- CLI

def _cmd_render(a):
    sc = load_scene(a.scene)
    vram, res = render_view(sc, bytearray(65536) if a.clear else None)
    out = a.out or os.path.splitext(a.scene)[0] + ".png"
    window_image(sc, vram, a.zoom).save(out)
    print(f"{out}: A = {res.a}, VCL {res.vcllen} + VMS {res.vmslen} Byte, {res.x} Eintraege, OBJVIS {res.objvis:#06x}")
    return 0


def _cmd_dump(a):
    sc = load_scene(a.scene)
    res = view(sc)
    print(f"A = {res.a}, X = {res.x}, VCLADR {res.p0:#06x}, VCLLEN {res.vcllen}, VMSLEN {res.vmslen}, "
          f"OBJVIS {res.objvis:#06x}")
    for e in decode_vcl(res.buffer):
        print(" ", e)
    return 0


def _cmd_budget(a):
    rep = budget([load_scene(p) for p in a.scene])
    print(f"{rep['scenes']} Szenen: VCL max {rep['max_vcl']}, VMS max {rep['max_vms']}, zusammen max "
          f"{rep['max_total']}, Eintraege max {rep['max_entries']}, Sichtliste max {rep['max_items']}")
    for w in rep["warnings"]:
        print("Warnung:", w)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="VIEW-Referenz (P6b)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("scene")
    r.add_argument("--out")
    r.add_argument("--zoom", type=int, default=4)
    r.add_argument("--clear", action="store_true", help="VRAM mit 0 statt Zufall")
    r.set_defaults(fn=_cmd_render)
    d = sub.add_parser("dump")
    d.add_argument("scene")
    d.set_defaults(fn=_cmd_dump)
    b = sub.add_parser("budget")
    b.add_argument("scene", nargs="+")
    b.set_defaults(fn=_cmd_budget)
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        return a.fn(a)
    except (ViewError, dbetex.TexError, ValueError, OSError, KeyError) as e:
        print(f"Fehler: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
