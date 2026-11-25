#!/usr/bin/env python3
"""VICE-Szenen P6g (docs/specs/P6-engine.md 9.4): Engine 0.2 und VDC-BASIC v3 im echten x128, ereignisgesteuert.

Aufruf: test/vice_view.py [--port N] [--timeout S] [--only i|c] [--check] [--png DIR] [--control] [--no-sim] [--no-fast]
                         [--byte-edges]
  --check   nur Python: Szenen bauen, Speicherkarte prüfen, view/run_vcl gegen paint_reference (kein VICE)
  --png DIR Bilder der erwarteten Fenster (Montage) schreiben
  --control Gegenprobe: Modell von Szene 5 verfälscht, der Lauf muss genau eine Abweichung melden (Exitcode 0)
  --no-sim  ohne sim65-Gegenmessung der Zyklen (Spalte sim65)
  --no-fast ohne den zweiten Lauf mit 2 MHz (FAST, VIC-Anzeige aus während VIEW und VCL); sonst je Lauf zwei VICE-Läufe,
            Zyklen beider Takte in der Tabelle (Spalten "2M", Stoppuhr in Takten zu 1 MHz, also in µs)
  --byte-edges  Demo-Geometrie mit view.toml-Schalter byte_edges (Kanten auf ganze Bytes) statt pixelgenau

Ablauf (test/vice/view.bas, interpretiert und als Blitz!-Kompilat mit Runtime-Image 2):
  BOOT (VDC-BASIC v3) -> POKE 57,0:POKE 58,64:CLR -> Stub und Lib laden, INIT -> Chunky-Modus wie Crawl (VDC-Register laut
  crawl.bas 10059-10135, 64-KB-VRAM vorher gelöscht) -> DVG, DMP, DTS (3), DBG, S2 (4 Sätze) an die Adressen der Speicherkarte
  (P6 2.4) in Bank 1, VRL der Texturen/Tapete/Sprites per RXV in den VRAM-Pool -> POOLSET, GEOMSET, TEXSET, BGSET,
  SPRITESET, ITEMSET, MAPINIT -> je Schritt der Szenentabelle (Bank 0 $8000, SETPOS oder MOVE, Objektliste): VIEW, ::VCL.
Markierungen (RTS in Bank 0): $0C4C (vor VIEW), $0C4D (nach ::VCL, Szene fertig), $0C4E (Tabellenende).
Der Harness hält an den Markierungen, liest dort das ganze VRAM (`bank vdc`, bsave), den Puffer und die Ergebnisse
und vergleicht pixelgleich mit dem VRAM-Modell (run_vcl auf dem 64-KB-Modell, dazu paint_reference im Fenster).
Zyklen: Monitor-Stoppuhr (stopwatch) von $0C4C aus; Haltepunkte am Stub-Eintritt/-Ausgang (VIEW) und am Anfang/Ende
von VCL in VDC-BASIC (`vcl` aus vdcbasic3.sym, `.vcl_done` aus dem ACME-Report, vdc_labels).
Ereignisgesteuert: Haltepunkte, Debug-Cartridge ($D7FF); -limitcycles und das Timeout sind nur Wächter.
Portregel (review-notes A): --port, sonst DBE_VICE_PORT, sonst 6631, Bereich 6631-6649, bind-Test, nur der eigene Prozess.
Voraussetzung: VDC-BASIC v3 (VDCBASIC_DIR, Vorgabe ~/git/vdc-basic, Branch v3; dort wird nichts verändert);
Blitz!-Lauf zusätzlich node und blitzc (sonst Meldung SKIP).
"""
import argparse, copy, json, os, re, shutil, struct, subprocess, sys, tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vice_smoke as vs                  # Monitor/Portwahl über VDC-BASIC (nur gelesen), Disk-Hilfen
vm = vs.vm
ROOT = vs.ROOT
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, os.path.join(HERE, 'tools'))
import dbemap, dbetex, dbeview, dbespr, dbemove, vrl
import dbetexdemo as dd
dbeview.dbemap = dbemap
from PIL import Image

# ------------------------------------------------------------------ Speicherkarte (P6 2.4) und VRAM
# Vorgabe P6 2.4 (MEMSIZ $4000, P6h): DMP $4000, S2 $6000, Wand-DTS $8000 (12 KB), Lib $B000-$DBFF, DVG $E800, Boden $EE00,
# Decke $F600, DBG $FB80. Der verbesserte Blitz!-Runtime (Image 2) macht das obere 1 KB ($FC00-$FFFF) gemeinsam und belegt
# $FC00-$FEFF; Daten dort zerstören ihn beim BLOAD. Die kleinen Test-Assets liegen hier dicht gepackt in $E800-$FBFF (5 KB).
HIGH = (0xE800, 0xFC00)
LOW = {'dmp': (0x4000, 0x6000), 'dts0': (0x8000, 0xB000)}           # Bereich (von, bis exklusiv)
S2_START, S2_END = 0x6000, 0x8000
POOL = (9600, 46335)                     # VRAM-Pool: hinter dem Attribut-RAM (AP 0, 2 x 9600) bis zum Bildschirm-RAM
SCN_ADDR = 0x8000                        # Szenentabelle, Bank 0
VRL_ADDR = 0x9000                        # Ladepuffer der VRL-Dateien, Bank 0 (RXV-Quelle ab +5)
BUF = (0x1300, 0x1C00)
M_VIEW, M_DONE, M_END = 0x0C4C, 0x0C4D, 0x0C4E
VERSION = vs.VERSION
LIBNAME, STUBNAME = f'dbe{VERSION}.lib', f'dbe{VERSION}.stub'
OUT = os.path.join(ROOT, 'build', 'vice')

# ------------------------------------------------------------------ kleine Assets


class Small:
    pass


def make_himmel(geom, path):
    """Panorama P = 2 * VW Byte (statt 4 * VW im Demo): halb so viel VRAM."""
    vw = geom["viewport"]["width_px"] // 2
    hy0, hy1 = geom["horizon"]
    P, h = 2 * vw, hy1 - hy0 + 6
    im = Image.new("RGBA", (2 * P, h), (0, 0, 0, 255))
    px = im.load()
    PAL = dd.PAL
    for x in range(2 * P):
        q = x // (P // 2)
        n = q + 1
        local = (x % (P // 2)) / (P // 2)
        peak = 1 - abs(2 * ((local * n) % 1.0) - 1)
        top = int(h * 0.7 - peak * h * 0.45)
        for y in range(h):
            px[x, y] = PAL[1 if y >= top else 3] + (255,)
    for q in range(4):
        x0 = q * P // 2 + 8
        for yy in range(2, 5):
            for xx in range(x0, x0 + 6):
                px[xx, yy] = PAL[(10, 7, 9, 13)[q]] + (255,)
    im.save(path)


def build_assets(tmp):
    """Kleine Sätze, die in die Bereiche von P6 2.4 und in den VRAM-Pool passen: Wand 3 Stile (ziegel, gitter, fenster;
    Demo: 4), Boden 1 Stil, Decke 1 Stil, Tapete mit halber Panoramabreite, 4 Sprite-Sätze (blob, gem, wache, breit)."""
    A = dbeview.build_demo_assets(tmp)               # erzeugt Atlanten, Geometrie und TOMLs im Verzeichnis
    P = lambda n: os.path.join(tmp, n)
    geom = json.load(open(P('west140.geom.json')))
    make_himmel(geom, P('himmel2.png'))
    wt = open(P('walls.toml')).read().replace('[[style]]\nname     = "bogen"\naseprite = "fenster.json"\ntag      = "bogen"\n', '')
    open(P('w3.toml'), 'w').write(wt)
    open(P('f1.toml'), 'w').write(dbeview.GEN_FLOOR_TOML.format(
        name="vice_floor", kind="floor", load="0xEE00", styles='[[style]]\nname = "stein"\npng = "stein_atlas.png"\n'))
    open(P('c1.toml'), 'w').write(dbeview.GEN_FLOOR_TOML.format(
        name="vice_ceil", kind="ceiling", load="0xF600", styles='[[style]]\nname = "holz"\npng = "holz_atlas.png"\n'))
    open(P('bg2.toml'), 'w').write(open(P('bg.toml')).read().replace('himmel.png', 'himmel2.png'))
    a = Small()
    a.dvg, a.dvg_prg, a.sprites = A.dvg, A.dvg_prg, A.sprites
    a.walls = dbetex.build_texset(dbetex.load_tex_conf(P('w3.toml')))[0]
    a.floor = dbetex.build_texset(dbetex.load_tex_conf(P('f1.toml')))[0]
    a.ceil = dbetex.build_texset(dbetex.load_tex_conf(P('c1.toml')))[0]
    dbg_prg, a.dbg_vram, _ = dbetex.build_background(dbetex.load_bg_conf(P('bg2.toml')))
    a.dbg_prg = dbg_prg
    a.dbg = dbetex.from_dbg(dbg_prg)
    a.dir = tmp
    return a


# ------------------------------------------------------------------ Karte
T = dbemap.Tile
WEG, DECK, INH = dbeview.T_WEG, dbeview.T_DECKEND, dbeview.T_INHALT


def build_map():
    """Demo-Karte 15 x 11: Gänge, Raum mit Himmel (Tapete), Gitter, Fenster-Wand, Abgrund, INHALT-Tür, Gegenstand."""
    t = [T((0, 0, 0, 0), 1, 1, 0, 0, "gang"),                      # 0
         T((1, 1, 1, 1), 0, 0, WEG | DECK, 0, "wand"),            # 1 Ziegel
         T((0, 0, 0, 0), 0, 1, 0, 0, "abgrund"),                  # 2 kein Boden
         T((0, 0, 0, 0), 1, 0, 0, 0, "himmel"),                   # 3 keine Decke: Tapete
         T((2, 0, 2, 0), 1, 1, WEG, 0, "gitter"),                 # 4 Gitter, nicht deckend
         T((3, 3, 3, 3), 0, 0, WEG | DECK, 0, "fenster"),         # 5 Fenster-Wand
         T((2, 2, 2, 2), 1, 1, WEG | INH, 0, "tuer"),             # 6 INHALT-Zelle (Gitter, Objekte darin)
         T((0, 0, 0, 0), 1, 1, 0, 0, "gegenstand")]               # 7 Gang mit Gegenstand
    rows = ["###############",
            "#.....#,,,,,,,#",
            "#.###.#,.....,#",
            "#.#:..#.......#",
            "#.#.#.+.#...#.#",
            "#...#...#.m.#.#",
            "#.#.###.#...#.#",
            "#.#...:.D.....#",
            "#.#.#.#.#...#.#",
            "#.....#.wwww..#",
            "###############"]
    leg = {'.': 0, '#': 1, ':': 2, ',': 3, '+': 4, 'w': 5, 'D': 6, 'm': 7}
    w, h = len(rows[0]), len(rows)
    cells = [leg[c] for r in rows for c in r]
    content = [0] * (w * h)
    content[5 * w + 10] = 2                                       # Gegenstand 2 bei 'm'
    m = dbemap.Map("vice", w, h, t, cells, content, [], 1 * w + 1, 2, 1)
    dbemap.validate(m)
    return m


W = 15


def cell(x, y):
    return y * W + x


# ------------------------------------------------------------------ Schritte
class Step:
    def __init__(self, name, kind, cell=0, dir=0, action=0, objs=None, itemph=0, keep=False):
        self.name, self.kind, self.cell, self.dir, self.action = name, kind, cell, dir, action
        self.objs, self.itemph, self.keep = objs or [], itemph, keep


Obj = dbeview.Obj


def build_steps():
    """Kamerazellen müssen begehbar sein (kein blocked(t)); build_steps prüft das am Ende."""
    S = []
    pos = lambda n, x, y, d, objs=None, ph=0: S.append(Step(n, 'pos', cell(x, y), d, objs=objs, itemph=ph))
    # Wände, Boden, Decke, Tapete (ohne Objekte)
    pos('Gang Süd', 1, 1, 2)
    pos('Gang Süd, Seitengang', 1, 4, 2)
    pos('Wand vorn (Ost)', 1, 1, 1)
    pos('Gang West-Ost', 5, 5, 1)
    pos('Raum mit Himmel/Tapete, Ost', 8, 2, 1)
    pos('Raum mit Himmel/Tapete, Süd', 10, 1, 2)
    pos('Raum West (Wand, Tapete)', 13, 2, 3)
    pos('Gitter West', 7, 4, 3)
    pos('Gitter Ost', 5, 4, 1)
    pos('Gitter Nord', 6, 5, 0)
    pos('Fenster Süd d=1', 10, 8, 2)
    pos('Fenster Süd d=2', 9, 7, 2)
    pos('Fenster Ost', 7, 9, 1)                    # Review P6g: vorher (8, 9) = in der Fenster-Wand
    # Abgrund
    pos('Abgrund Ost', 3, 7, 1)
    pos('Abgrund Nord', 3, 4, 0)                   # Review P6g: vorher (4, 5) = in einer Wand
    pos('Abgrund Süd', 3, 5, 2)
    pos('Abgrund Süd 2', 5, 5, 2)
    # Gegenstand und Objekte (mittig, am Rand beschnitten)
    pos('Gegenstand (Inhaltsebene)', 9, 5, 1)
    pos('Blob mittig d=1', 1, 1, 2, [Obj(cell(1, 2), 0, 2, 0, 4)])
    pos('Blob mittig d=2 und 3', 1, 1, 2, [Obj(cell(1, 3), 0, 0, 1, 4), Obj(cell(1, 4), 0, 1, 1, 4)])
    pos('Blob Unterpositionen', 1, 5, 2, [Obj(cell(1, 6), 0, 2, 0, q) for q in range(4)] + [Obj(cell(1, 7), 2, 0, 0, 4)])
    pos('Wache, Gem, ITEMPH', 5, 1, 2, [Obj(cell(5, 3), 2, 2, 0, 4), Obj(cell(5, 2), 1, 0xFF, 1, 1)], 1)
    pos('breit, Rand links d=1', 13, 2, 3, [Obj(cell(12, 3), 3, 2, 1, 4)])
    pos('breit, Rand rechts d=1', 13, 2, 3, [Obj(cell(12, 1), 3, 2, 1, 4)])
    pos('breit, Rand d=2, s=+-1', 13, 2, 3, [Obj(cell(11, 1), 3, 2, 1, 0), Obj(cell(11, 3), 3, 2, 1, 3)])
    pos('Objekte im offenen Raum', 13, 2, 3, [Obj(cell(12, 1), 0, 2, 0, 4), Obj(cell(12, 3), 0, 2, 0, 1),
                                                Obj(cell(11, 2), 2, 0, 0, 4), Obj(cell(10, 1), 3, 1, 1, 2),
                                                Obj(cell(10, 3), 0, 3, 0, 4)])
    # INHALT-Zelle (Tür mit Objekt darin)
    pos('INHALT Tür leer', 11, 7, 3)
    pos('INHALT Tür mit Blob d=3', 11, 7, 3, [Obj(cell(8, 7), 0, 1, 0, 4)])
    pos('INHALT Tür mit Blob d=2', 10, 7, 3, [Obj(cell(8, 7), 0, 1, 0, 4)])
    pos('INHALT Tür, Blobs d=1', 9, 7, 3, [Obj(cell(8, 7), 0, 1, 0, 0), Obj(cell(8, 7), 0, 3, 1, 3)])
    # MOVE-Sequenz: Gang abwärts, drehen, gegen die Wand, gegen das Objekt
    S.append(Step('MOVE Start', 'pos', cell(1, 1), 2, objs=[Obj(cell(1, 5), 0, 2, 0, 4)]))
    for a, n in ((0, 'vor'), (0, 'vor'), (4, 'drehen links'), (5, 'drehen rechts'), (0, 'vor'), (2, 'seitwärts links'),
                 (0, 'vor (Objekt blockiert)'), (6, 'umdrehen'), (0, 'vor'), (3, 'seitwärts rechts'),
                 (1, 'zurück')):
        S.append(Step('MOVE ' + n, 'move', action=a, keep=True))
    m = build_map()
    for st in S:
        if st.kind == 'pos' and m.tiles[m.cells[st.cell]].flags & DECK:
            raise SystemExit(f'Szene {st.name!r}: Kamera in einer deckenden Zelle')
    return S


# ------------------------------------------------------------------ Szenen, Erwartung
def s2_layout(assets):
    """(Adresse, Inhalt) der Sprite-Sätze dicht ab $6000 (16-Byte-Ausrichtung); je Satz eine Datei."""
    a, out = S2_START, []
    for ss in assets.sprites[:4]:
        data = dbespr.to_s2(ss)[2:]
        out.append((a, data))
        a = (a + len(data) + 15) & ~15
    if a > S2_END:
        raise SystemExit(f'S2 ({a - S2_START} Byte) passt nicht in $6000-$7FFF')
    return out


class World:
    """Alles, was zwischen Python und VICE abgestimmt ist: Dateien, Basen, Szenenfolge, VRAM-Modell."""

    def __init__(self, tmp):
        self.assets = A = build_assets(tmp)
        self.map = build_map()
        self.pack()
        self.steps = build_steps()
        self.itemtab = [0, 2, 3] + [0] * 61                        # Gegenstand 1 -> Satz 1 (Gem), 2 -> Satz 2 (Wache)
        self.s2 = s2_layout(A)
        self.s2addr = tuple(a for a, _ in self.s2) + (0,) * 4
        self.sc0 = dbeview.make_scene(A, self.map, itemtab=self.itemtab, buf=BUF, band_cover=True, start=POOL[0])
        sc = self.sc0
        sc.vms_bank1, sc.dts_addr, sc.s2_addr = True, self.dts_addr, self.s2addr
        self.bases = copy.deepcopy(sc.vram_bases)
        end = max([b + len(d) for n, b, d in sc.assets()])
        if end > POOL[1]:
            raise SystemExit(f'VRAM-Pool: Ende {end} > {POOL[1]}')
        self.pool_end = end
        self.files = self.collect_files()
        self.vram0 = self.initial_vram()

    def pack(self):
        """Dateiinhalte und ihre Adressen in Bank 1 (siehe HIGH)."""
        A = self.assets
        self.blob = {'dvg': dbeview.dvg_bytes(dbeview.with_band_cover(A.dvg))[2:],
                     'dts0': dbetex.to_dts(A.walls)[2:], 'dts1': dbetex.to_dts(A.floor)[2:],
                     'dts2': dbetex.to_dts(A.ceil)[2:], 'dbg': A.dbg_prg[2:], 'dmp': dbemap.to_dmp(self.map)[2:]}
        a = {'dmp': LOW['dmp'][0], 'dts0': LOW['dts0'][0]}
        p = HIGH[0]
        for n in ('dvg', 'dts2', 'dts1', 'dbg'):
            a[n] = p
            p = (p + len(self.blob[n]) + 15) & ~15
        if p - 16 + len(self.blob['dbg']) > HIGH[1] or p > HIGH[1] + 15:
            raise SystemExit(f'DVG, DTS und DBG ({p - HIGH[0]} Byte) passen nicht in ${HIGH[0]:04X}-${HIGH[1] - 1:04X}')
        for n in ('dmp', 'dts0'):
            if a[n] + len(self.blob[n]) > LOW[n][1]:
                raise SystemExit(f'{n}: {len(self.blob[n])} Byte reichen über ${LOW[n][1]:04X} hinaus')
        self.addr = a
        self.dts_addr = (a['dts0'], a['dts1'], a['dts2'])

    # --- Dateien (Name, Ladeadresse, Inhalt) für Bank 1 und die VRL-Dateien
    def collect_files(self):
        A, sc = self.assets, self.sc0
        f = [(n, self.addr[n], self.blob[n], 0x10000) for n in ('dvg', 'dmp', 'dbg', 'dts0', 'dts1', 'dts2')]
        for k, (a_, d) in enumerate(self.s2):
            f.append((f's2{k}', a_, d, S2_END))
        for n, a_, d, lim in f:
            if a_ < 0x4000 or a_ + len(d) > 0xFC00 or (a_ < 0xD000 < a_ + len(d)) or (0xD000 <= a_ < 0xE000):
                raise SystemExit(f'{n}: ${a_:04X}+{len(d)} liegt nicht in $4000-$CFFF/$E000-$FBFF (Typ 9, Blitz!-Runtime)')
        # Überlappungen untereinander
        spans = sorted((a, a + len(d), n) for n, a, d, lim in f)
        for (a0, a1, n0), (b0, b1, n1) in zip(spans, spans[1:]):
            if b0 < a1:
                raise SystemExit(f'Speicherkarte: {n0} und {n1} überlappen')
        self.bank1 = [(n, a, d) for n, a, d, lim in f]
        self.vrls = []
        for name, base, data in sc.assets():
            st = vrl.encode(list(data))
            self.vrls.append((name, base, vrl.pack_file(st, VRL_ADDR), len(st)))
        return f

    def initial_vram(self):
        """VRAM nach dem Start des Testprogramms (nach den RXV, vor der ersten Szene), 64 KB."""
        v = bytearray(65536)
        v[8000:9600] = bytes([0x1F]) * 1600
        v[46335:46335 + 16000] = bytes([15]) * 16000
        for name, base, data in self.sc0.assets():
            v[base:base + len(data)] = data
        return v

    # --- Szenen
    def expected(self):
        """Je Schritt: dict(name, kind, view = dbeview.Result, scene, move = MoveResult | None, pos, dir)."""
        out, pos, v, objs, itemph = [], 0, 0, [], 0
        m = self.map
        for st in self.steps:
            mv = None
            if st.kind == 'pos':
                pos, v, objs, itemph = st.cell, st.dir, list(st.objs), st.itemph
            else:
                mv = dbemove.move(m, pos, v, objs, st.action)
                assert mv.a == 0
                pos, v = mv.pos, mv.dir
            sc = copy.copy(self.sc0)
            sc.pos, sc.dir, sc.objects, sc.itemph = pos, v, list(objs), itemph
            sc.dmp = copy.deepcopy(m)
            sc.vram_bases = copy.deepcopy(self.bases)
            res = dbeview.view(sc)
            out.append(dict(step=st, scene=sc, res=res, move=mv, pos=pos, dir=v))
        return out

    def scene_table(self):
        b = bytearray()
        for st in self.steps:
            if st.kind == 'pos':
                n = len(st.objs)
                b += bytes((0, st.cell & 255, st.cell >> 8, st.dir, st.itemph, n))
                for o in st.objs:
                    b += struct.pack('<HBBBB', o.cell, o.set, o.dir, o.phase, o.byte5())
            else:
                b += bytes((1, 0, 0, st.action, 0, 255))
        b += bytes((2, 0, 0, 0, 0, 0))
        return struct.pack('<H', SCN_ADDR) + bytes(b)


def model_run(world, exp):
    """VRAM-Modell: run_vcl je Schritt nacheinander (Zustand wandert mit). Rückgabe: Liste (vram_nach, paint_ref_fenster)."""
    vram = bytearray(world.vram0)
    out = []
    for e in exp:
        sc, res = e['scene'], e['res']
        before = bytes(vram)
        dbeview.run_vcl(res.bank0(), vram, res.p0, bank1=res.bank1())
        ref = dbeview.paint_reference(sc, bytearray(before)) if res.a == 0 else None
        out.append((bytes(vram), ref))
    return out


# ------------------------------------------------------------------ BASIC-Programm
def basic_listing(world, fast=False):
    """test/vice/view.bas mit den Platzhaltern @LOADS@ (Dateien laden) und @SETUP@ (Setz-Aufrufe)."""
    sc = world.sc0
    B = world.bases
    loads = []
    for n, a, d in world.bank1:
        loads.append(f'bload"dbe.{n}",b1,u8:if ds<>0 then r=61:goto 8995')
    loads.append('bload"dbe.scn",b0,u8:if ds<>0 then r=62:goto 8995')
    for i, (name, base, f, n) in enumerate(world.vrls):
        loads.append(f'bload"dbe.v{i}",b0,u8:if ds<>0 then r=63:goto 8995')
        loads.append(f'rxv {VRL_ADDR + 5},{base}')
    calls = [(11, 0, 0, POOL[0], POOL[1]), (12, 0, 0, world.addr['dvg'], 65535)]
    for k in range(3):
        calls.append((13, k, 0, world.dts_addr[k], B['dts'][k]))
    calls.append((14, sc.bgfill, 0, world.addr['dbg'], B['dbg']))
    for k in range(4):
        calls.append((9, k, 0, world.s2addr[k], B['s2'][k]))
    for g in range(64):
        if world.itemtab[g]:
            calls.append((10, g, world.itemtab[g], 0, 0))
    calls.append((1, 0, 0, world.addr['dmp'], 0))
    calls.append((15, 0, 0, BUF[0], BUF[1]))
    setup = []
    for i, (f, x, y, p0, p1) in enumerate(calls):
        setup.append(f'p0={p0}:p1={p1}:f={f}:x={x}:y={y}:gosub 9500:if a<>0 then r={20 + i}:goto 8995')
    text = open(os.path.join(HERE, 'vice', 'view.bas')).read().replace('@VERSION@', VERSION)
    text = text.replace('@FAST@', 'fast:' if fast else '').replace('@SLOW@', 'slow' if fast else 'rem')
    out, n = [], 0
    for line in text.split('\n'):
        if line.strip() in ('@LOADS@', '@SETUP@'):
            body = loads if line.strip() == '@LOADS@' else setup
            for s in body:
                n += 1
                out.append(f'{300 + n}  {s}'.replace('  ', ' ', 1))
            continue
        out.append(line)
    assert 300 + n < 2000, 'zu viele Zeilen für den Block'
    return '\n'.join(out)


def sim_cycles(world, exp):
    """sim65-Zyklen je Schritt (nur VIEW, ohne Stub): Lauf mit F = 4 minus Lauf mit F = 7 (wie run_sim.time_view), mit
    Objekten und Gegenständen. Rückgabe Liste oder None (ohne sim65)."""
    if not shutil.which('sim65'):
        return None
    sys.path.insert(0, os.path.join(HERE, 'sim'))
    import run_sim as rs
    rs.build()
    out = []
    for e in exp:
        sc = copy.copy(e['scene'])
        R = rs.ViewRunner(dbeview, dbetex)
        R.dbg_bytes = world.blob['dbg']
        sc.vms_bank1, sc.dts_addr = True, rs.P6D_ADDR['dts']
        R.setup(sc)
        base = bytes(R.scene.b)
        r = []
        for f in (4, 7):
            sn = rs.Scene()
            sn.b = bytearray(base)
            sn.call(f, p=(sc.ap, 0, 0, 0), quiet=True, **R.objargs(sc))
            r.append(rs.run(sn, R.prg).cycles)
        out.append(r[0] - r[1])
    return out


# ------------------------------------------------------------------ Disk und Lauf
def stub_rts():
    """Adresse des RTS am Ende des Stubs (Ausgang von SYS 3331): vor sv_a..sv_zp (5 + ZPBLEN Byte)."""
    d = open(os.path.join(ROOT, 'build', STUBNAME), 'rb').read()
    base, code = d[0] | d[1] << 8, d[2:]
    i = len(code) - (5 + 16) - 1
    assert code[i] == 0x60, 'RTS am Stubende nicht gefunden'
    return base + i


def make_disk(world, d64, boot_prg, t_prg, workdir):
    files = [('boot', boot_prg), ('vdcbasic3', os.path.join(vs.VDC, 'vdcbasic3.bin')),
             (STUBNAME, os.path.join(ROOT, 'build', STUBNAME)), (LIBNAME, os.path.join(ROOT, 'build', LIBNAME)),
             ('t', t_prg)]
    for n, a, d in world.bank1:
        p = os.path.join(workdir, f'dbe.{n}')
        open(p, 'wb').write(struct.pack('<H', a) + d)
        files.append((f'dbe.{n}', p))
    p = os.path.join(workdir, 'dbe.scn')
    open(p, 'wb').write(world.scene_table())
    files.append(('dbe.scn', p))
    for i, (name, base, f, n) in enumerate(world.vrls):
        p = os.path.join(workdir, f'dbe.v{i}')
        open(p, 'wb').write(f)
        files.append((f'dbe.v{i}', p))
    cmd = ['c1541', '-format', 'dbe,01', 'd64', d64]
    for n, p in files:
        cmd += ['-write', p, n]
    vs.sh(cmd, stdout=subprocess.DEVNULL)


def flags(m):
    t = m.cmd('r')
    return int(re.findall(r'\.;[0-9a-f]{4}(?: [0-9a-f]{2}){6} ([01]{8})', t)[-1], 2)


def stopwatch(m):
    t = m.cmd('stopwatch')
    return int(re.search(r'Stopwatch:\s*(\d+)', t).group(1))


_LABELS = None


def vdc_labels():
    """Adressen lokaler Marken von VDC-BASIC v3 (nicht in vdcbasic3.sym): ACME-Report einer Kopie im Temp-Verzeichnis,
    gegen vdcbasic3.bin geprüft. {'vcl', '.vcl_next_command', '.vcl_done', '.vms_arg_loop', '.vms_done'}."""
    global _LABELS
    if _LABELS:
        return _LABELS
    want = ('vcl', '.vcl_next_command', '.vcl_done', '.vms_arg_loop', '.vms_done')
    tmp = tempfile.mkdtemp()
    try:
        shutil.copytree(os.path.join(vs.VDC, 'src'), os.path.join(tmp, 'src'))
        env = dict(os.environ, ACME=os.environ.get('ACME', os.path.expanduser('~/.local/share/acme/ACME_Lib')))
        subprocess.run(['acme', '-r', 'r.txt', 'src/vdcbasic.asm'], cwd=tmp, env=env, check=True, stdout=subprocess.DEVNULL)
        if open(os.path.join(tmp, 'vdcbasic3.bin'), 'rb').read() != open(os.path.join(vs.VDC, 'vdcbasic3.bin'), 'rb').read():
            raise SystemExit('ACME-Bau weicht von vdcbasic3.bin ab (VDC-BASIC neu bauen)')
        rep = open(os.path.join(tmp, 'r.txt'), encoding='latin-1').read().split('\n')
    finally:
        shutil.rmtree(tmp)
    out = {}
    for i, l in enumerate(rep):
        m = re.match(r'\s*\d+\s+(\S+)\s*(;.*)?$', l)
        if m and m.group(1) in want:
            for l2 in rep[i + 1:i + 6]:
                m2 = re.match(r'\s*\d+\s+([0-9a-f]{4})\s+[0-9a-f]{2}', l2)
                if m2:
                    out[m.group(1)] = int(m2.group(1), 16)
                    break
    if set(out) != set(want):
        raise SystemExit(f'Marken im ACME-Report nicht gefunden: {out}')
    _LABELS = out
    return out


def run_one(world, d64, boot_prg, port, tmo, exp, workdir):
    """Ein VICE-Lauf. Rückgabe (rc, Ergebnisliste je Szene, Fehler)."""
    syms = vm.symbols(os.path.join(vs.VDC, 'build', 'vdcbasic3.sym'))
    RTS = stub_rts()
    VD = 0x0D03
    res = {'scenes': [], 'errors': [], 'end': False}
    vramf = os.path.join(workdir, 'vram.bin')

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        m.bp(err_at)
        for a in (M_VIEW, M_DONE, M_END):
            m.bp(a)
        # Ende von VCL: .vcl_done (lokale Marke, aus dem ACME-Report). complex_instruction_shared_exit taugt nicht: jedes
        # VMC/VMF und jeder VMS-Kopierbefehl endet dort (das I-Flag wäre ab dem ersten Eintrag wieder frei).
        timing = {'vd': VD, 've': RTS, 'ce': syms['vcl'], 'cx': vdc_labels()['.vcl_done']}
        ids = {k: m.bp(a) for k, a in timing.items()}
        at = {a: k for k, a in timing.items()}
        for i in ids.values():
            m.cmd(f'disable {i}')
        t = {}
        while True:
            try:
                pc, _ = m.go()
            except vm.Exited:
                return
            if pc == err_at:
                lo, hi = m.mem(0x3B, 2)
                res['errors'].append((m.reg_x(), lo | hi << 8, len(res['scenes'])))
                m.s.sendall(b'quit\n')
                return
            elif pc == M_VIEW:
                t = {}
                m.cmd('stopwatch reset')
                for i in ids.values():
                    m.cmd(f'enable {i}')
            elif pc in at:
                k_ = at[pc]
                t[k_] = stopwatch(m)
                if k_ in ('vd', 'ce'):          # I-Flag setzen: Zyklen ohne Kernal-IRQ (vergleichbar mit sim65)
                    fl = flags(m)
                    t['fl'] = fl
                    m.cmd(f'r fl = ${fl | 4:02x}')
                else:                           # Ausgang: I-Flag wie vorher (SYS/::VCL kehren nach BASIC zurück)
                    m.cmd(f'r fl = ${(flags(m) & ~4) | (t["fl"] & 4):02x}')
            elif pc == M_DONE:
                t['done'] = stopwatch(m)
                for i in ids.values():
                    m.cmd(f'disable {i}')
                m.cmd('bank ram00')
                pb = m.mem(0x0C00, 0x20)
                tb = m.mem(0x0C40, 8)
                buf = m.mem(BUF[0], BUF[1] - BUF[0])
                m.cmd('bank vdc')
                if os.path.exists(vramf):
                    os.remove(vramf)
                m.cmd(f'bsave "{vramf}" 0 0000 ffff')
                m.cmd('bank ram00')
                res['scenes'].append(dict(t=t, pb=pb, tb=tb, buf=buf, vram=open(vramf, 'rb').read()))
            elif pc == M_END:
                res['end'] = True

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '1500000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    return rc, res


def w16(b, i):
    return b[i] | b[i + 1] << 8


def compare(world, exp, model, got, sim=None):
    """Vergleich je Szene. Rückgabe (Zeilen, Fehlerzahl)."""
    lines, bad = [], 0
    sc0 = world.sc0
    if len(got['scenes']) != len(exp):
        lines.append(f'FEHLER: {len(got["scenes"])} Szenen gemeldet, erwartet {len(exp)}')
        bad += 1
    for k, (e, (vram, ref), g) in enumerate(zip(exp, model, got['scenes'])):
        res, sc, st = e['res'], e['scene'], e['step']
        msg = []
        pb, tb = g['pb'], g['tb']
        if (tb[0], tb[1]) != (res.a, res.x):
            msg.append(f'A/X VICE {tb[0]}/{tb[1]} <> Referenz {res.a}/{res.x}')
        if w16(pb, 0x0A) != res.p0 or w16(pb, 0x0C) != res.vcllen or w16(pb, 0x0E) != res.vmslen or w16(pb, 0x10) != res.objvis:
            msg.append(f'VCLADR/VCLLEN/VMSLEN/OBJVIS VICE {[hex(w16(pb, i)) for i in (0x0A, 0x0C, 0x0E, 0x10)]} <> '
                       f'{[hex(res.p0), hex(res.vcllen), hex(res.vmslen), hex(res.objvis)]}')
        mv = e['move']
        if mv is not None and (tb[2], tb[3], tb[4], w16(tb, 5)) != (mv.a, mv.x, mv.y, mv.p0):
            msg.append(f'MOVE VICE A/X/Y/P0 {tb[2]}/{tb[3]}/{tb[4]}/{w16(tb, 5)} <> {mv.a}/{mv.x}/{mv.y}/{mv.p0}')
        # Puffer: VCL-Liste [VCLADR, B1) und VMS-Listen [B0, B0 + VMSLEN) wie die Referenz
        buf, b0 = g['buf'], BUF[0]
        vcl = bytes(buf[res.p0 - b0:res.p0 - b0 + len(res.vcl)])
        vms = bytes(buf[0:len(res.vms)])
        if vcl != res.vcl or vms != res.vms:
            msg.append('Puffer (VCL/VMS) weicht von der Referenz ab')
        # VRAM: ganz (64 KB) gegen das Modell, Fenster gegen paint_reference
        v = g['vram']
        if v != vram:
            idx = [i for i in range(65536) if v[i] != vram[i]]
            msg.append(f'VRAM {len(idx)} Byte falsch, erstes ${idx[0]:04X}: VICE {v[idx[0]]:02X} <> Modell {vram[idx[0]]:02X}')
        pix = ref is None or dbeview.window_bytes(sc, v) == dbeview.window_bytes(sc, ref)
        t = g['t']
        cyc = dict(view=t['ve'] - t['vd'], vcl=t['cx'] - t['ce'], total=t['done'])
        cyc['sum'] = cyc['view'] + cyc['vcl']
        cyc['sim'] = sim[k] if sim else 0
        g['cyc'] = cyc
        ok = not msg
        bad += not ok
        lines.append(dict(k=k, name=st.name, kind=st.kind, a=res.a, x=res.x, items=res.items, nv=res.vcllen, nm=res.vmslen,
                          pix=ok and v == vram, ref=('-' if ref is None else ('ja' if pix else 'NEIN')), cyc=cyc, msg=msg, ok=ok))
        if ref is not None and not pix:
            lines[-1]['msg'].append('Fenster weicht von paint_reference ab (VICE = run_vcl-Modell: '
                                    + ('ja' if v == vram else 'nein') + ')')
    return lines, bad


def report(name, lines, bad):
    """Zyklen: Monitor-Stoppuhr (Takte zu 1 MHz). Spalten mit 2M: Lauf mit FAST (2 MHz, VIC aus), falls vorhanden."""
    two = any(isinstance(L, dict) and 'cyc2' in L for L in lines)
    print(f'--- {name}')
    print(f'{"#":>2} {"Szene":<34} {"A":>1} {"X":>3} {"VCL":>4} {"VMS":>5} {"Modell":>6} {"Ref":>4} {"VIEW":>7} {"VCL":>9} '
          f'{"VIEW+VCL":>9} {"mit BASIC":>9} {"sim65":>7}' + (f' | {"VIEW 2M":>7} {"VCL 2M":>9} {"V+V 2M":>9}' if two else ''))
    for L in lines:
        if not isinstance(L, dict):
            print(L)
            continue
        c = L['cyc']
        print(f'{L["k"]:>2} {L["name"]:<34} {L["a"]:>1} {L["x"]:>3} {L["nv"]:>4} {L["nm"]:>5} '
              f'{"ja" if L["pix"] else "NEIN":>6} {L["ref"]:>4} {c["view"]:>7} {c["vcl"]:>9} {c["sum"]:>9} {c["total"]:>9} {c["sim"] or "-":>7}' +
              (f' | {L["cyc2"]["view"]:>7} {L["cyc2"]["vcl"]:>9} {L["cyc2"]["sum"]:>9}' if 'cyc2' in L else ''))
        for m_ in L['msg']:
            print('      ', m_)
    ds = [L for L in lines if isinstance(L, dict)]
    if ds:
        n = len(ds)
        for key, lab in (('view', 'VIEW'), ('vcl', 'VCL'), ('sum', 'VIEW+VCL'), ('total', 'mit BASIC'), ('sim', 'sim65')):
            vals = [L['cyc'][key] for L in ds]
            if not any(vals):
                continue
            print(f'    {lab:<10} Mittel {sum(vals) // n:>9}  min {min(vals):>9}  max {max(vals):>9}')
        if two:
            for key, lab in (('view', 'VIEW'), ('vcl', 'VCL'), ('sum', 'VIEW+VCL')):
                v1 = [L['cyc'][key] for L in ds]
                v2 = [L['cyc2'][key] for L in ds]
                print(f'    {lab + " 2 MHz":<14} Mittel {sum(v2) // n:>9}  min {min(v2):>9}  max {max(v2):>9}'
                      f'  (Verhaeltnis zu 1 MHz {sum(v2) / sum(v1):.2f})')
    print(f'    {"alle gleich" if not bad else str(bad) + " Fehler"}', flush=True)


def check_only(world, exp, model, png=None):
    bad = 0
    for k, (e, (vram, ref)) in enumerate(zip(exp, model)):
        res = e['res']
        note = ''
        if res.a != 0:
            note = f' A={res.a}'
        if ref is not None and dbeview.window_bytes(e['scene'], vram) != dbeview.window_bytes(e['scene'], ref):
            note += ' paint_reference weicht ab'
            bad += 1
        print(f'{k:>2} {e["step"].name:<34} pos {e["pos"]:>3} dir {e["dir"]} VCL {res.vcllen:>4} VMS {res.vmslen:>5} '
              f'Eintraege {res.x:>3} objvis {res.objvis:#06x}{note}')
    if png:
        os.makedirs(png, exist_ok=True)
        ims = [dbeview.window_image(e['scene'], vram, 2) for e, (vram, ref) in zip(exp, model)]
        cols = 6
        w, h = ims[0].size
        sheet = Image.new('RGB', (cols * (w + 4), ((len(ims) + cols - 1) // cols) * (h + 4)), (40, 40, 40))
        for i, im in enumerate(ims):
            sheet.paste(im, ((i % cols) * (w + 4), (i // cols) * (h + 4)))
        sheet.save(os.path.join(png, 'szenen.png'))
    print('Speicherkarte:', ', '.join(f'{n} ${a:04X}-${a + len(d) - 1:04X}' for n, a, d in sorted(world.bank1, key=lambda x: x[1])))
    print(f'VRAM-Pool: ${POOL[0]:04X}-${world.pool_end - 1:04X} von {POOL[0]}-{POOL[1] - 1}, '
          f'Basen {world.bases}')
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--only', choices='ic')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--png')
    ap.add_argument('--control', action='store_true',
                    help='Gegenprobe: ein Byte im Fenster des Modells von Szene 5 verfälschen; der Lauf muss genau diese Szene melden')
    ap.add_argument('--no-sim', action='store_true', help='keine sim65-Gegenmessung')
    ap.add_argument('--byte-edges', action='store_true', help='Demo-Geometrie mit byte_edges = true (Kanten auf ganze Bytes)')
    ap.add_argument('--no-fast', action='store_true', help='ohne den zweiten Lauf mit 2 MHz (FAST)')
    a = ap.parse_args()
    vs.sh(['sh', os.path.join(ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)
    if a.byte_edges:
        os.environ['DBE_BYTE_EDGES'] = '1'           # dbetexdemo.default_geom
    tmp = tempfile.TemporaryDirectory()
    world = World(tmp.name)
    exp = world.expected()
    model = model_run(world, exp)
    if a.check or a.png:
        sys.exit(1 if check_only(world, exp, model, a.png) else 0)
    if a.control:
        v = bytearray(model[5][0])
        v[3 * 80 + 10] ^= 0x11
        model[5] = (bytes(v), model[5][1])
    sim = None if a.no_sim else sim_cycles(world, exp)
    os.makedirs(OUT, exist_ok=True)
    port = vm.choose_port(a.port)
    boot_bas = os.path.join(OUT, 'boot.bas')
    with open(os.path.join(vs.VDC, 'boot', 'boot.bas')) as f:
        lines = [('50 RUN"T"\n' if l.startswith('50 ') else l) for l in f]
    open(boot_bas, 'w').write(''.join(lines))
    boot_prg = os.path.join(OUT, 'boot.prg')
    vs.tok(boot_bas, boot_prg)
    wd = os.path.join(OUT, 'view-files')
    shutil.rmtree(wd, ignore_errors=True)
    os.makedirs(wd)
    bad = 0
    node, blitzc = vm.find_node(), vm.find_blitzc()

    def build(compiled, fast):
        """Programm bauen (interpretiert: getokenisiert ab $4001; kompiliert: Blitz!). Rückgabe PRG oder None."""
        suf = ('c' if compiled else 'i') + ('f' if fast else '')
        src_bas = os.path.join(OUT, f'view{"-f" if fast else ""}.bas')
        open(src_bas, 'w').write(basic_listing(world, fast))
        if not compiled:
            prg = os.path.join(OUT, f'view-{suf}.prg')
            vs.tok(src_bas, prg, '0x4001')
            return prg
        prep = os.path.join(OUT, f'view-b{"f" if fast else ""}.bas')
        vs.sh(['python3', '-B', os.path.join(vs.VDC, 'test', 'blitzprep.py'), src_bas, prep])
        src = os.path.join(OUT, f'view-src{"f" if fast else ""}.prg')
        vs.tok(prep, src)
        cdir = os.path.join(OUT, f'view-blitz{"-f" if fast else ""}')
        shutil.rmtree(cdir, ignore_errors=True)
        c = subprocess.run([node, blitzc, src, cdir, '--name', 'T'], capture_output=True, text=True)
        cprg = os.path.join(cdir, 'c.prg')
        if c.returncode or not os.path.exists(cprg) or open(cprg, 'rb').read(2) != b'\x01\x40':
            print(f'kompiliert: Compiler rc {c.returncode}: {c.stdout.strip()}')
            scr = os.path.join(cdir, 'screen.txt')
            if os.path.exists(scr):
                print(open(scr).read())
            return None
        return cprg

    def one(compiled, fast):
        """Ein Lauf. Rückgabe (Zeilen, Fehlerzahl, Fehlerbit) oder None, wenn das Programm nicht gebaut werden konnte."""
        prg = build(compiled, fast)
        if prg is None:
            return None
        d64 = os.path.join(OUT, f'view-{"c" if compiled else "i"}{"f" if fast else ""}.d64')
        make_disk(world, d64, boot_prg, prg, wd)
        rc, got = run_one(world, d64, boot_prg, port, a.timeout, exp, wd)
        what = 'kompiliert (Blitz!, Image 2)' if compiled else 'interpretiert'
        print(f'{what}{", 2 MHz (FAST)" if fast else ""}: exit {rc}, BASIC-Fehler {got["errors"]}, Ende erreicht {got["end"]}')
        lines_, b = compare(world, exp, model, got, sim)
        return lines_, b, (rc != 0) | (b != (1 if a.control else 0)) | bool(got['errors']) | (not got['end'])

    for compiled in (False, True):
        if (a.only == 'c' and not compiled) or (a.only == 'i' and compiled):
            continue
        if compiled and (not node or not blitzc):
            print('kompiliert: SKIP (blitzc nicht gefunden)')
            bad |= 2
            continue
        r1 = one(compiled, False)
        if r1 is None:
            bad |= 1
            continue
        lines1, b1, e1 = r1
        bad |= e1
        name = 'kompiliert (Blitz!, Image 2)' if compiled else 'interpretiert'
        if not a.no_fast:
            # Zweiter Lauf mit FAST (2 MHz, VIC-Anzeige aus waehrend VIEW und VCL): gleiche Pruefung, Zyklen als cyc2
            r2 = one(compiled, True)
            if r2 is None:
                bad |= 1
            else:
                lines2, b2, e2 = r2
                bad |= e2
                for L1, L2 in zip(lines1, lines2):
                    if isinstance(L1, dict) and isinstance(L2, dict):
                        L1['cyc2'] = L2['cyc']
                        L1['msg'] += [f'(2 MHz) {m_}' for m_ in L2['msg']]
        report(name, lines1, b1)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
