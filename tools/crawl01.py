#!/usr/bin/env python3
"""Modell von VIEW 0.1 (Crawl 128 1.0f) und Offline-Vollvergleich mit Engine 0.2 (P7a, docs/specs/P7-crawl.md 6.2).

Das Modell folgt `engine/lib.s` von Tag v0.1 (docs/formats.md, Abschnitt "VIEW" unter SPR v1): Clear
`VMF AP+400,0,7600`, WSM-Eintraege von vorne nach hinten mit Spaltenabdeckung, Objektplaetze (erst Objekte, dann
Gegenstand), Ausgabe rueckwaerts, Waende `VMC`, Sprites `VMS`/`VMC`. Die Zellenrechnung ist wie in der Lib linear
(`pos + d * F + s * R` mit 16 Bit, ohne Spaltenumbruch; ausserhalb von W * H zaehlt als Wand), MAXVIS = 22 und der
VMS-Puffer von 512 Byte sind nachgebildet.

Der Vergleich (compare) zeichnet alle freien Zellen x 4 Richtungen x {kein Geist; Geist in jeder freien Zelle (d, s),
d = 0 ... 3, |s| <= 1, mit jeder der 4 Richtungen} x {Edelsteine der Startkarte; alle eingesammelt, Ausgang 42} einmal mit dem
0.1-Modell und einmal mit Engine 0.2 (dbeview.view + run_vcl, Crawl-Szene aus crawlconv) in ein VRAM mit Zufallsinhalt.
Gleich sein muessen die Bytes der Zeilen 5-99 sowie 100, Spalten 6-73; ausserhalb des Fensters darf 0.2 nichts
schreiben; A = 0 fuer jede Ansicht.

Aufruf:
  crawl01.py compare (--d81 IMAGE.d81 | --dir DIR) [--quick] [--workers N] [--json OUT.json]
Exitcode 0 ohne Abweichung, 1 sonst.
"""
import argparse
import json
import os
import random
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crawlconv  # noqa: E402
import crawlmap  # noqa: E402
import dbemap  # noqa: E402
import dbetex  # noqa: E402
import dbeview  # noqa: E402

MAXVIS, MAXOBJ, NSETS, NITEMS, COLS, SPRBUF_LEN = 22, 8, 4, 64, 128, 512
CLEAR_OFF, CLEAR_LEN, CLEAR_VAL, ROWLEN = 400, 7600, 0, 80
F_COVER, F_VMS, F_OBJ = 1, 1, 0x80
QG = (2, 0, 1, 3)                  # absolute Unterposition q, die bei Blickrichtung v die Zeichenposition p = 3 ergibt
ITEM_GEM, ITEM_POWER = 2, 4
EXIT_OPEN = 42                     # crawl.bas 5550: Ausgang offen
CMP_ROWS = range(5, 101)           # Bildschirmzeilen 5-99 und 100
CMP_COLS = (6, 74)


# ---------------------------------------------------------------- Modell VIEW 0.1

class Model01:
    def __init__(self, files, ca, da, ga0):
        b = files["walls.wsm"][2:]
        if b[:2] != b"WS":
            raise ValueError("walls.wsm: Magic")
        n = b[3]
        self.clear = struct.unpack_from("<HHBB", b, 4)           # Offset, Laenge, Wert, Zeilenbreite
        self.ents = [struct.unpack_from("<BbBBBHHB", b, 10 + 10 * i) for i in range(n)]  # d s fl w h src dest col
        self.sets = [crawlconv.parse_spr(files["ghost.spr"]), crawlconv.parse_spr(files["gem.spr"])]
        self.setvram = [ga0, ca]
        self.da = da
        self.itemtab = [0] * NITEMS
        self.itemtab[ITEM_GEM] = 2                                # ITEMSET 2, 2: Gegenstand 2 -> Satz 1
        self.vram_src = {0: files["ghosts.vdc"][2:], 1: files["font3o.vdc"][2:], "walls": crawlconv.parse_walls(files["walls.vdc"])[1]}

    def view(self, cells, w, h, pos, v, objs):
        """-> (Eintraege vorne -> hinten, Fehlercode). objs: [(Zelle, Satz, Richtung)]."""
        fstep = (-w, 1, w, -1)[v]
        rstep = (1, w, -1, -w)[v]
        size = w * h
        cover = [0] * COLS
        vis, err = [], 0
        nobj = min(len(objs), MAXOBJ)

        def col_free(c, n):
            return any(not cover[x] for x in range(c, c + n))

        def add(item):
            nonlocal err
            if len(vis) >= MAXVIS:
                err = 2
                return True
            vis.append(item)
            return False

        def add_parts(oset, od, os_, oang):
            if oset >= NSETS or oset >= len(self.sets):
                return False
            for p in self.sets[oset]:
                if p["d"] != od or p["s"] != os_ or (p["angle"] != 0xFF and p["angle"] != oang):
                    continue
                if col_free(p["col"], p["w"]) and add(("spr", oset, p)):
                    return True
            return False

        for (d, s, fl, ew, eh, src, dest, col) in self.ents:
            cell = (pos + d * fstep + s * rstep) & 0xFFFF
            cv = cells[cell] if cell < size else 1
            if fl & F_OBJ:
                if cv & 1:
                    continue
                for o in objs[:nobj]:
                    if o[0] == cell and add_parts(o[1], d, s, (v + 2 - o[2]) & 3):
                        return vis, err
                g = cv & (NITEMS - 1)
                if self.itemtab[g] and add_parts(self.itemtab[g] - 1, d, s, 0xFF):
                    return vis, err
                continue
            if not cv & 1 or not col_free(col, ew):
                continue
            if add(("wall", (src, dest, ew, eh))):
                return vis, err
            if fl & F_COVER:
                for x in range(col, col + ew):
                    cover[x] = 1
        return vis, err

    def render(self, vram, vis, ap=0):
        """Ausgabe wie v_emit: Clear, dann von hinten nach vorne. Rueckgabe Fehlercode des Puffers (VMS-Platz)."""
        err = 0
        o, n, val, _rl = self.clear
        for i in range(n):
            vram[(ap + o + i) & 0xFFFF] = val
        sbuf = 0
        for kind, *rest in reversed(vis):
            if kind == "wall":
                src, dest, w, h = rest[0]
                dbetex.sim_vmc(vram, self.da + src, ap + dest, w, h, ROWLEN)
                continue
            setn, p = rest
            src = self.setvram[setn] + p["src"]
            if not p["flags"] & F_VMS:
                dbetex.sim_vmc(vram, src, ap + p["dest"], p["w"], p["h"], ROWLEN)
                continue
            if sbuf + len(p["list"]) > SPRBUF_LEN:
                err = 2
                continue
            sbuf += len(p["list"])
            dbetex.sim_vms(vram, src, ap + p["dest"], p["list"])
        return err


# ---------------------------------------------------------------- Umgebung fuer den Vergleich

class Env:
    """Alles fuer den Vergleich: Umwandlung, Karten, 0.1-Modell, 0.2-Szene, Ausgangs-VRAM."""

    def __init__(self, files, font_bytes=1732, seed=1):
        self.conv = crawlconv.build(files, font_bytes=font_bytes)
        info = self.conv.info
        self.m, _ = crawlmap.convert(files["crawl128.cd1"])
        self.w, self.h = self.m.width, self.m.height
        self.cells0 = list(self.m.cells)
        # Alle eingesammelt: 1.0f SETCELL(pos, 0) je Edelstein und danach crawl.bas 5550 SETCELL(EX%, 42);
        # 1.1 SETITEM (Inhalt 0, Kachel 2 bleibt) und dieselbe SETCELL(EX%, 42) auf die Kachelebene.
        exits = [e.cell for e in self.m.events if e.type == dbemap.EVENT_TYPES["ausgang"]]
        self.cells1 = [0 if c == ITEM_GEM else c for c in self.cells0]
        tiles1 = list(self.m.cells)
        for x in exits:
            self.cells1[x] = tiles1[x] = EXIT_OPEN
        self.m1 = dbemap.Map(self.m.name, self.w, self.h, self.m.tiles, tiles1,
                             [0 if c == ITEM_GEM else c for c in self.m.content], list(self.m.events), self.m.start,
                             self.m.direction, self.m.outside)
        self.model = Model01(files, info["CA"], info["DA"], info["GA0"])
        c = self.conv
        sc = dbeview.Scene(c.dvg, self.m)
        sc.dts = [c.dts, None, None]
        sc.bgfill = 0
        sc.s2 = [c.ghost, c.gem] + [None] * 6
        sc.vram_bases = {"dts": [info["DA"], 0, 0], "dbg": 0, "s2": [info["GA0"], info["GA1"]] + [0] * 6}
        sc.itemtab = [0] * 64
        sc.itemtab[ITEM_GEM] = 2                                   # ITEMSET 2, 2
        sc.itemph, sc.ap = 0, 0
        sc.vms_bank1 = True
        sc.dts_addr = (crawlconv.LOAD["wall"], 0, 0)
        sc.s2_addr = (crawlconv.LOAD["ghost"], crawlconv.LOAD["gem"]) + (0,) * 6
        sc.check_layout()
        self.sc = sc
        rnd = random.Random(seed)
        base = bytearray(rnd.getrandbits(8) for _ in range(65536))
        self.base1 = bytearray(base)
        ca, da, g0 = info["CA"], info["DA"], info["GA0"]
        self.base1[ca:ca + len(self.model.vram_src[1])] = self.model.vram_src[1]
        self.base1[da:da + len(self.model.vram_src["walls"])] = self.model.vram_src["walls"]   # 1.0f: RTV BE+D
        self.base1[g0:g0 + len(self.model.vram_src[0])] = self.model.vram_src[0]
        self.base2 = sc.make_vram(seed)
        self.base2[:crawlconv.CA] = base[:crawlconv.CA]
        self.base1[:crawlconv.CA] = base[:crawlconv.CA]
        self.free = [i for i, v in enumerate(self.cells0) if not v & 1]

    def visible_cells(self, pos, v):
        """Freie Zellen (d, s -> Zellindex) im Sichtgitter d = 0 ... 3, |s| <= 1 (2D, innerhalb der Karte)."""
        fx, fy = dbeview.FORE[v]
        rx, ry = dbeview.RIGHT[v]
        px, py = pos % self.w, pos // self.w
        out = []
        for d in range(4):
            for s in (-1, 0, 1):
                x, y = px + d * fx + s * rx, py + d * fy + s * ry
                if 0 <= x < self.w and 0 <= y < self.h and not self.cells0[y * self.w + x] & 1:
                    out.append((d, s, y * self.w + x))
        return out

    def window_diff(self, v1, v2):
        """Liste (Zeile, Spalte, Wert 0.1, Wert 0.2) der abweichenden Fensterbytes (Zeilen 5-100, Spalten 6-73)."""
        out = []
        for r in CMP_ROWS:
            a = bytes(v1[r * 80 + CMP_COLS[0]:r * 80 + CMP_COLS[1]])
            b = bytes(v2[r * 80 + CMP_COLS[0]:r * 80 + CMP_COLS[1]])
            if a != b:
                out += [(r, CMP_COLS[0] + i, x, y) for i, (x, y) in enumerate(zip(a, b)) if x != y]
        return out

    def outside_changed(self, v2):
        """Hat 0.2 ausserhalb des Fensters (Zeilen 0-95 des Fensters, Spalten 0-67) geschrieben?"""
        g = self.sc.dvg
        o, st, vw, rows = g.origin, g.stride, g.vw, g.vh
        b = self.base2
        end = o + (rows - 1) * st + vw
        if v2[:o] != b[:o] or v2[end:] != b[end:]:
            return True
        return any(v2[o + r * st + vw:o + (r + 1) * st] != b[o + r * st + vw:o + (r + 1) * st] for r in range(rows - 1))

    def one(self, pos, v, variant, ghost):
        """Eine Ansicht in beiden Fassungen. ghost = None oder (Zelle, Richtung). -> dict (diff, err, vcl...)."""
        cells = self.cells1 if variant else self.cells0
        objs01 = [] if ghost is None else [(ghost[0], 0, ghost[1])]
        vis, err1 = self.model.view(cells, self.w, self.h, pos, v, objs01)
        v1 = bytearray(self.base1)
        self.model.render(v1, vis)
        sc = self.sc
        sc.dmp = self.m1 if variant else self.m
        sc.pos, sc.dir = pos, v
        sc.objects = [] if ghost is None else [dbeview.Obj(ghost[0], 0, ghost[1], 0, QG[v])]
        res = dbeview.view(sc)
        v2 = bytearray(self.base2)
        dbeview.run_vcl(res.bank0(), v2, res.p0, bank1=res.bank1())
        diff = self.window_diff(v1, v2)
        return dict(diff=diff, a=res.a, outside=self.outside_changed(v2), a01=err1, nvis01=len(vis),
                    total=res.vcllen + res.vmslen, vcl=res.vcllen, vms=res.vmslen)


ENV = None


def _init(files, font_bytes):
    global ENV
    ENV = Env(files, font_bytes)


def _job(args):
    pos, v, quick = args
    e = ENV
    out = dict(views=0, bad=[], max_total=0, max_vcl=0, max_vms=0, a_nonzero=0, a01=0, outside=0, nvis01_max=0,
               ghosts=0)

    def run(variant, ghost):
        r = e.one(pos, v, variant, ghost)
        out["views"] += 1
        out["ghosts"] += ghost is not None
        out["max_total"] = max(out["max_total"], r["total"])
        out["max_vcl"] = max(out["max_vcl"], r["vcl"])
        out["max_vms"] = max(out["max_vms"], r["vms"])
        out["nvis01_max"] = max(out["nvis01_max"], r["nvis01"])
        out["a_nonzero"] += r["a"] != 0
        out["a01"] += r["a01"] != 0
        out["outside"] += r["outside"]
        if r["diff"] or r["outside"] or r["a"]:
            out["bad"].append(dict(pos=pos, dir=v, variant=variant, ghost=ghost, ndiff=len(r["diff"]),
                                   first=r["diff"][:3], a=r["a"], outside=r["outside"]))
    cells = e.visible_cells(pos, v)
    for variant in (0, 1):
        run(variant, None)
        for _d, _s, c in cells:
            for gd in (range(4) if not quick else (v, (v + 2) & 3)):
                run(variant, (c, gd))
    return out


def compare(files, quick=False, workers=1, font_bytes=1732, progress=None):
    """Vollvergleich. -> Bericht (dict): views, bad (Abweichungen), Maxima von VCL + VMS, A != 0 usw."""
    env = Env(files, font_bytes)
    jobs = [(p, v, quick) for p in env.free for v in range(4)]
    if workers > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(workers, _init, (files, font_bytes)) as pool:
            results = []
            for i, r in enumerate(pool.imap(_job, jobs, chunksize=4)):
                results.append(r)
                if progress and i % 50 == 0:
                    progress(i, len(jobs))
    else:
        _init(files, font_bytes)
        results = [_job(j) for j in jobs]
    rep = dict(positions=len(env.free), directions=4, views=0, ghost_views=0, bad=[], max_total=0, max_vcl=0,
               max_vms=0, a_nonzero=0, a01=0, outside=0, nvis01_max=0, quick=quick)
    for r in results:
        rep["views"] += r["views"]
        rep["ghost_views"] += r["ghosts"]
        rep["bad"] += r["bad"]
        for k in ("a_nonzero", "a01", "outside"):
            rep[k] += r[k]
        for k in ("max_total", "max_vcl", "max_vms", "nvis01_max"):
            rep[k] = max(rep[k], r[k])
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["compare"])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--d81")
    g.add_argument("--dir")
    ap.add_argument("--quick", action="store_true", help="Geist nur in Blick- und Gegenrichtung")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--json")
    a = ap.parse_args(argv)
    if a.d81:
        work = tempfile.mkdtemp(prefix="crawl01-", dir=os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "build") if os.path.isdir(os.path.join(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))), "build")) else None)
        files = crawlconv.read_d81(a.d81, work)
    else:
        files = crawlconv.read_dir(a.dir)
    rep = compare(files, a.quick, a.workers, progress=lambda i, n: print(f"  {i}/{n}", file=sys.stderr))
    print(f"{rep['views']} Ansichten ({rep['positions']} Zellen x 4 Richtungen, davon {rep['ghost_views']} mit Geist), "
          f"Abweichungen: {len(rep['bad'])}, A != 0: {rep['a_nonzero']}, Schreibzugriffe ausserhalb: {rep['outside']}")
    print(f"VCL + VMS max {rep['max_total']} (VCL {rep['max_vcl']}, VMS {rep['max_vms']}) von 2304; "
          f"0.1: Fehlercode != 0 in {rep['a01']} Ansichten, Eintraege max {rep['nvis01_max']}")
    for b in rep["bad"][:20]:
        print("  Abweichung:", b)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(rep, f, indent=1, default=list)
    return 1 if rep["bad"] or rep["a_nonzero"] or rep["outside"] else 0


if __name__ == "__main__":
    sys.exit(main())
