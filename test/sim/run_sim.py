#!/usr/bin/env python3
"""sim65-Gerüst für die Lib (docs/specs/P6-engine.md 9.2).

Aufruf:  run_sim.py            baut den Harness und führt die Tests der Teilschritte aus (P6a, P6c, P6d, P6e; P6d und P6e
                               zweimal: Standardbuild (unbeschnittene VMS-Listen als Typ 9) und Build-Schalter VMS_COPY)
         Umgebung: DBEVIEW_FULL=1 voller Zufallssatz (200 x 20), DBE_NOCYCLES=1 ohne Zyklenmessung
         run_sim.py --build    nur bauen

Bausteine für die späteren Teilschritte:
  Scene            Szene aufbauen (Segmente, Aufrufe, Auslesen) und als Szenendatei schreiben
  build()          cl65: viewsim.c + glue.s + engine/lib.s (--asm-define SIM) -> build/sim/viewsim.prg + Labels
  run(scene)       sim65 ausführen, Ergebnisdatei lesen -> Run (calls, dumps, cycles)
  decode_vcl(buf)  VCL-Liste in Einträge zerlegen; first_diff(a, b) -> Text der ersten abweichenden Stelle
Format der Szenen- und Ergebnisdatei: Kopf von viewsim.c.
"""
import os, re, struct, subprocess, sys, tempfile
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'build', 'sim')
PRG = os.path.join(OUT, 'viewsim.prg')
LBL = os.path.join(OUT, 'viewsim.lbl')
PRGC = os.path.join(OUT, 'viewsimc.prg')         # Build-Schalter VMS_COPY (unbeschnittene VMS-Listen in den Puffer)
PRGM = os.path.join(OUT, 'viewsimm.prg')         # nur Test: MAXITEM = 8 (Abbruch über die Eintragszahl)

Call = namedtuple('Call', 'f a x y p pb buf')      # p: 4 Wörter, pb: 10 Byte $0C08-$0C11
# items in Reihenfolge der Szene: Call oder (addr, bytes) für Auslesen
Run = namedtuple('Run', 'items cycles')


class Scene:
    def __init__(self):
        self.b = bytearray(b'DBS1')

    def seg(self, addr, data):
        data = bytes(data)
        self.b += struct.pack('<BHH', 1, addr, len(data)) + data
        return self

    def call(self, f, x=0, y=0, p=(0, 0, 0, 0), itemph=0, objn=0, objl=b'', quiet=False):
        self.b += struct.pack('<BBBB4HBBB', 4 if quiet else 2, f, x, y, *p, itemph, objn, len(objl)) + bytes(objl)
        return self

    def dump(self, addr, n):
        self.b += struct.pack('<BHH', 3, addr, n)
        return self

    def encode(self):
        return bytes(self.b) + b'\0'


def build():
    os.makedirs(OUT, exist_ok=True)
    src = [os.path.join(HERE, 'viewsim.c'), os.path.join(HERE, 'glue.s'), os.path.join(ROOT, 'engine', 'lib.s')]
    for prg, lbl, defs in ((PRG, LBL, []), (PRGC, os.path.join(OUT, 'viewsimc.lbl'), ['--asm-define', 'VMS_COPY']),
                           (PRGM, os.path.join(OUT, 'viewsimm.lbl'), ['--asm-define', 'MAXITEM_T=8'])):
        subprocess.run(['cl65', '-t', 'sim6502', '-g', '-C', os.path.join(HERE, 'sim.cfg'), '-O', '--asm-define', 'SIM']
                       + defs + ['--asm-include-dir', os.path.join(ROOT, 'engine'), '-Ln', lbl,
                                 '-m', os.path.splitext(prg)[0] + '.map', '-o', prg] + src, check=True, cwd=OUT)
    for s in src:                       # ältere cl65-Versionen lassen Objekte neben den Quellen liegen
        o = os.path.splitext(s)[0] + '.o'
        if os.path.exists(o):
            os.remove(o)


def labels():
    """ld65 -Ln: 'al 00E000 .name' -> {name: adresse}"""
    d = {}
    for line in open(LBL):
        m = re.match(r'al ([0-9A-Fa-f]+) \.(\S+)', line)
        if m:
            d[m.group(2)] = int(m.group(1), 16)
    return d


def run(scene, prg=PRG):
    with tempfile.TemporaryDirectory() as td:
        sc, rs = os.path.join(td, 'scene'), os.path.join(td, 'result')
        open(sc, 'wb').write(scene.encode())
        r = subprocess.run(['sim65', '-c', prg, sc, rs], capture_output=True, text=True, timeout=300)   # Wächter gegen Hänger
        if r.returncode:
            raise RuntimeError(f'sim65 Exitcode {r.returncode}: {r.stdout}{r.stderr}')
        cyc = int(re.search(r'(\d+) cycles', r.stdout + r.stderr).group(1))
        d = open(rs, 'rb').read()
    assert d[:4] == b'DBR1'
    i, items = 4, []
    while i < len(d):
        t = d[i]
        if t == ord('C'):
            f, a, x, y = d[i + 1:i + 5]
            p = struct.unpack('<4H', d[i + 5:i + 13])
            pb = d[i + 13:i + 23]
            bl = struct.unpack('<H', d[i + 23:i + 25])[0]
            items.append(Call(f, a, x, y, p, pb, d[i + 25:i + 25 + bl]))
            i += 25 + bl
        elif t == ord('D'):
            addr, n = struct.unpack('<HH', d[i + 1:i + 5])
            items.append((addr, d[i + 5:i + 5 + n]))
            i += 5 + n
        else:
            raise RuntimeError(f'Ergebnisdatei: Satz {t} bei {i}')
    return Run(items, cyc)


VCL_LEN = {0: 1, 2: 11, 3: 13, 4: 7, 5: 11, 9: 7, 12: 7}      # P6 Abschnitt 6


def decode_vcl(buf):
    """-> Liste (Offset, Typ, Bytes); bricht bei unbekanntem Typ mit einem Eintrag ('?') ab."""
    out, i = [], 0
    while i < len(buf):
        t = buf[i]
        n = VCL_LEN.get(t)
        if n is None or i + n > len(buf):
            out.append((i, t, bytes(buf[i:])))
            break
        out.append((i, t, bytes(buf[i:i + n])))
        i += n
        if t == 0:
            break
    return out


def first_diff(a, b):
    ea, eb = decode_vcl(a), decode_vcl(b)
    for k in range(max(len(ea), len(eb))):
        x = ea[k] if k < len(ea) else None
        y = eb[k] if k < len(eb) else None
        if x != y:
            return f'Eintrag {k}: sim {x and (x[1], x[2].hex())} <> Referenz {y and (y[1], y[2].hex())}'
    return None if a == b else 'VCL gleich, VMS-Bytes unterscheiden sich'


# ------------------------------------------------------------------ P6a: INIT, BUFSET, POOLSET, Dispatcher
def test_p6a():
    L = labels()
    bss, bss_end, code_end = L['bss_start'], L['bss_end'], L['code_end']
    fails = []

    def check(name, cond, info=''):
        if not cond:
            fails.append(f'{name} {info}')

    def var(d, name, n=2):
        o = L[name] - bss
        return int.from_bytes(d[o:o + n], 'little')

    n = bss_end - bss
    s = Scene()
    s.seg(bss, bytes([0xAA]) * n).seg(0x0C08, bytes([0x55]) * 10)         # 0: schmutziger Zustand
    s.call(0, objn=5)                                                       # INIT
    s.dump(bss, n).dump(0x0C08, 10).dump(0x0C50, 1)
    s.call(17).call(18).call(255).call(7).call(8).call(4).call(3)           # nicht umgesetzt
    s.call(15, p=(0x1300, 0x1C00, 0, 0)).dump(bss, n)                       # BUFSET ok, Standard
    s.call(15, p=(0x1300, 0x1340, 0, 0)).dump(bss, n)                       # genau 64 Byte ok
    s.call(15, p=(0x1400, 0x143F, 0, 0)).dump(bss, n)                       # 63 Byte: 6, unverändert
    s.call(15, p=(0x12FF, 0x1800, 0, 0)).dump(bss, n)                       # Anfang < $1300 (Fenster)
    s.call(15, p=(0x1400, 0x1C01, 0, 0)).dump(bss, n)                       # Ende > $1C00
    s.call(15, p=(0x1600, 0x1400, 0, 0)).dump(bss, n)                       # Ende < Anfang
    s.call(15, p=(0x1400, 0x1400, 0, 0)).dump(bss, n)                       # Länge 0
    s.call(15, p=(0x0200, 0x0240, 0, 0)).dump(bss, n)                       # $0200: 6 (Kernal-Vektoren)
    s.call(15, p=(0x1B00, 0x1C00, 0, 0)).dump(bss, n)                       # ok, 256 Byte am Ende
    s.call(11, p=(0, 0, 0, 0)).dump(bss, n)                                 # POOLSET aus
    s.call(11, p=(0x7000, 0x9000, 0, 0)).dump(bss, n)
    s.call(11, p=(0x9000, 0x7000, 0, 0)).dump(bss, n)                       # 6, unverändert
    s.call(11, p=(0x7000, 0x7000, 0, 0)).dump(bss, n)                       # leer: 6
    s.call(11, p=(0x7000, 0, 0, 0)).dump(bss, n)                            # bis 65536
    s.call(11, p=(0, 0x100, 0, 0)).dump(bss, n)                             # ab 0
    s.call(11, p=(0, 0, 0, 0)).dump(bss, n)                                 # wieder aus
    s.call(0).dump(bss, n)                                                  # INIT setzt alles zurück
    r = run(s)
    it = iter(r.items)
    nxt = lambda: next(it)

    c = nxt(); d = nxt()[1]; pb = nxt()[1]; objn = nxt()[1]
    check('INIT A/X/Y', (c.a, c.x, c.y) == (0, 3, 0), str((c.a, c.x, c.y)))
    check('INIT P0 = Codeende', c.p[0] == code_end, f'{c.p[0]:04x} <> {code_end:04x}')
    check('INIT P1 = BSS-Ende', c.p[1] == bss_end, f'{c.p[1]:04x} <> {bss_end:04x}')
    check('INIT Puffer', (var(d, 'buf_b0'), var(d, 'buf_b1')) == (0x1300, 0x1C00))
    check('INIT Pool aus', var(d, 'pool_on', 1) == 0 and var(d, 'pool_a') == 0 and var(d, 'pool_b') == 0)
    o0 = L['buf_b0'] - bss
    check('INIT löscht alle Variablen außer dem Puffer', all(v == 0 for i, v in enumerate(d) if not o0 <= i < o0 + 4))
    check('INIT Parameterblock $0C08-$0C11', pb == bytes([0, 0, 0, 0x13]) + bytes(6), pb.hex())   # nur VCLADR = $1300
    check('INIT OBJN = 0', objn == b'\0')
    for f in (17, 18, 255, 7, 8, 4, 3):
        c = nxt()
        want = (5, 0, 0) if f in (3, 4) else (255, 0, 0)     # VIEW/MOVE ohne GEOMSET/MAPINIT: E_STATE (MOVE seit P6f)
        check(f'F={f} {"E_STATE" if f in (3, 4) else "E_NOTIMPL"}', (c.a, c.x, c.y) == want, str((c.a, c.x, c.y)))

    def bufcase(name, want_a, want_buf):
        c = nxt(); d = nxt()[1]
        check(f'BUFSET {name} A', c.a == want_a, f'{c.a} <> {want_a}')
        got = (var(d, 'buf_b0'), var(d, 'buf_b1'))
        check(f'BUFSET {name} Puffer', got == want_buf, f'{got[0]:04x},{got[1]:04x} <> ' + str(want_buf))
        return want_buf if want_a == 0 else None

    cur = (0x1300, 0x1C00)
    for name, a, newbuf in (('Standard', 0, (0x1300, 0x1C00)), ('64 Byte', 0, (0x1300, 0x1340)),
                            ('63 Byte', 6, None), ('Anfang < $1300', 6, None), ('Ende > $1C00', 6, None),
                            ('Ende < Anfang', 6, None), ('Länge 0', 6, None), ('$0200', 6, None),
                            ('256 Byte am Ende', 0, (0x1B00, 0x1C00))):
        want = newbuf or cur
        bufcase(name, a, want)
        cur = want

    def poolcase(name, want_a, want):
        c = nxt(); d = nxt()[1]
        got = (var(d, 'pool_on', 1), var(d, 'pool_a'), var(d, 'pool_b'))
        check(f'POOLSET {name} A', c.a == want_a, f'{c.a} <> {want_a}')
        check(f'POOLSET {name} Zustand', got == want, str(got) + ' <> ' + str(want))
        check(f'POOLSET {name} Puffer unverändert', (var(d, 'buf_b0'), var(d, 'buf_b1')) == cur)
        return want if want_a == 0 else None

    pool = (0, 0, 0)
    for name, a, want in (('aus', 0, (0, 0, 0)), ('$7000-$9000', 0, (1, 0x7000, 0x9000)),
                          ('Ende < Anfang', 6, None), ('leer', 6, None), ('bis 65536', 0, (1, 0x7000, 0)),
                          ('ab 0', 0, (1, 0, 0x100)), ('wieder aus', 0, None)):
        w = want or pool
        if name == 'wieder aus':
            w = (0, pool[1], pool[2])           # pool_on = 0, Grenzen bleiben stehen (ohne Bedeutung)
            c = nxt(); d = nxt()[1]
            check('POOLSET wieder aus', c.a == 0 and var(d, 'pool_on', 1) == 0)
            continue
        poolcase(name, a, w)
        pool = w
    c = nxt(); d = nxt()[1]
    check('INIT erneut A/X', (c.a, c.x) == (0, 3))
    check('INIT erneut: Variablen gelöscht und Standard', (var(d, 'buf_b0'), var(d, 'buf_b1'), var(d, 'pool_on', 1),
                                                           var(d, 'pool_a'), var(d, 'pool_b')) == (0x1300, 0x1C00, 0, 0, 0))
    for f in fails:
        print('FAIL', f)
    print(f'P6a sim: {"ok" if not fails else str(len(fails)) + " Fehler"}  (Zyklen gesamt {r.cycles})')
    return not fails


# ------------------------------------------------------------------ P6c: Karte und Assets
TOOLS = os.path.join(ROOT, 'tools')
DEMO_MAP = os.path.join(ROOT, 'docs', 'specs', 'examples', 'demo.toml')
HDR = 0x1400            # Platz für Kopf-Kopien mit gezielten Fehlern (gemeinsames RAM)
HDR2 = 0xA700           # Kopf-Kopien, die gültig sein müssen (S2 und DTS ab $4000 wegen VCL-Typ 9; frei in P6c)


class Bss:
    """BSS-Abzug der Lib, Zugriff über die Labels."""
    def __init__(self, d, L):
        self.d, self.L, self.o = d, L, L['bss_start']

    def at(self, name, off=0):
        return self.L[name] - self.o + off

    def b(self, name, off=0):
        return self.d[self.at(name, off)]

    def w(self, name, off=0):
        i = self.at(name, off)
        return self.d[i] | self.d[i + 1] << 8

    def raw(self, name, n, off=0):
        i = self.at(name, off)
        return bytes(self.d[i:i + n])


class Seq:
    """Folge von Aufrufen mit je einem BSS-Abzug; Prüfungen laufen nach dem sim65-Lauf."""
    def __init__(self, L):
        self.L = L
        self.n = L['bss_end'] - L['bss_start']
        self.scene = Scene()
        self.steps = []
        self.fails = []

    def seg(self, addr, data):
        self.scene.seg(addr, data)

    def stable(self, d):
        """BSS ohne argx/argy und Zwischenwerte (t0 ... val)"""
        d = bytearray(d)
        o = self.L['bss_start']
        x = self.L['argx'] - o
        d[x:x + 2] = b'\0\0'
        a, b = self.L['t0'] - o, self.L['val'] + 2 - o
        d[a:b] = bytes(b - a)
        return d

    def call(self, name, f, x=0, y=0, p=(0, 0, 0, 0), pre=(), a=0, rx=None, ry=None, rp=None, check=None,
             same=False, objn=0, dump=()):
        """a/rx/ry: erwartete Rückgabe (rx, ry None = nicht prüfen); rp: erwartete P0..P3 (None = nicht prüfen);
        same: BSS unverändert gegenüber dem vorigen Schritt; check(bss): weitere Prüfung (Liste von Fehlertexten)."""
        for addr, data in pre:
            self.scene.seg(addr, data)
        self.scene.call(f, x, y, p, objn=objn)
        self.scene.dump(self.L['bss_start'], self.n)
        for addr, n in dump:
            self.scene.dump(addr, n)
        self.steps.append((name, a, rx, ry, rp, check, same, len(dump)))

    def run(self):
        r = run(self.scene)
        it = iter(r.items)
        prev = None
        for name, a, rx, ry, rp, check, same, nd in self.steps:
            c = next(it)
            d = next(it)[1]
            extra = [next(it)[1] for _ in range(nd)]
            bss = Bss(d, self.L)
            bss.extra = extra
            bss.call = c
            if c.a != a:
                self.fails.append(f'{name}: A = {c.a}, erwartet {a}')
            if rx is not None and c.x != rx:
                self.fails.append(f'{name}: X = {c.x}, erwartet {rx}')
            if ry is not None and c.y != ry:
                self.fails.append(f'{name}: Y = {c.y}, erwartet {ry}')
            if rp is not None and tuple(c.p[:len(rp)]) != tuple(rp):
                self.fails.append(f'{name}: P = {[hex(v) for v in c.p]}, erwartet {[hex(v) for v in rp]}')
            if same and prev is not None and self.stable(d) != self.stable(prev):
                diff = [i for i in range(len(d)) if self.stable(d)[i] != self.stable(prev)[i]][:6]
                self.fails.append(f'{name}: BSS verändert (Offsets {diff})')
            if check:
                for msg in check(bss) or ():
                    self.fails.append(f'{name}: {msg}')
            prev = d
        return r.cycles


def patched(data, *edits, n=40):
    """Kopf-Kopie (n Byte) mit Änderungen (offset, wert[, länge]); wert > 255 -> Wort"""
    h = bytearray(data[:n])
    for e in edits:
        off, val = e[0], e[1]
        ln = e[2] if len(e) > 2 else (2 if val > 255 else 1)
        h[off:off + ln] = val.to_bytes(ln, 'little')
    return bytes(h)


def test_geomcheck():
    """GEOMSET prüft die Elementtabelle (P6d-opt, Abschnitt 7): Fehlerfälle A = 1 und keine gültige Geometrie
    (geom_ok = 0), Grenzfälle A = 0; dbeview.parse_dvg wirft in denselben Fällen ViewError."""
    sys.path.insert(0, TOOLS)
    import copy
    import dbeview
    L = labels()
    tmp = tempfile.TemporaryDirectory()
    A = dbeview.build_demo_assets(tmp.name)
    base = bytes(dbeview.dvg_bytes(A.dvg)[2:])
    A2 = dbeview.double_fronts(A)
    base2 = bytes(dbeview.dvg_bytes(dbeview.without_band_cover(A2.dvg))[2:])        # Tiefe 3: genau 16 deckende Seiten/Fronten ohne Bit 3

    def el(data, i, off, val):
        d = bytearray(data)
        o = 24 + 8 * (d[5] + 1) + 16 * i + off
        d[o] = val & 255
        return bytes(d)

    def depth3_ceil(data):                              # ein Deckenelement der Tiefe 3 als deckende Seite
        d = bytearray(data)
        o_e, ne = 24 + 8 * (d[5] + 1), d[7]
        f3, n3 = d[24 + 8 * 3 + 4], d[24 + 8 * 3 + 5]
        for i in range(f3, f3 + n3):
            if d[o_e + 16 * i] == 3:
                d[o_e + 16 * i] = 1
                d[o_e + 16 * i + 3] = 1
                d[o_e + 16 * i + 12] = d[o_e + 16 * i + 13] = 0
                return bytes(d)
        raise AssertionError
    # synthetische Geometrien über dbeview.Dvg (Zellen je Tiefe neu zusammensetzen, first/n neu berechnen)
    def rebuild(fn, S=None):
        g = copy.deepcopy(A.dvg)
        cells = [dbeview._Ctx.cells_of(type('C', (), {'g': g})(), d) for d in range(g.D + 1)]
        cells = [[(s_, list(es)) for s_, es in c] for c in cells]
        fn(g, cells)
        elems = []
        for d, c in enumerate(cells):
            g.depth[d].first, g.depth[d].n = len(elems), sum(len(es) for _, es in c)
            for s_, es in c:
                for e in es:
                    e2 = copy.copy(e)
                    e2.d, e2.s = d, s_
                    elems.append(e2)
        g.elems = elems
        if S is not None:
            g.S = S
        return bytes(dbeview.dvg_bytes(g)[2:])
    proto_obj = next(e for e in A.dvg.elems if e.art == 4)
    proto_side = copy.copy(next(e for e in A.dvg.elems if e.art == 1))
    proto_side.flags = 0                                # nicht deckend: kein Wartebereich
    proto_ceil = next(e for e in A.dvg.elems if e.art == 3)

    def pad_cell(n):                                    # Zelle (1, -1) mit Objektplätzen auf n Elemente auffüllen
        def fn(g, cells):
            es = next(es for s_, es in cells[1] if s_ == -1)
            es += [copy.copy(proto_obj) for _ in range(n - len(es))]
        return fn

    def more_cells(ncell, nwall):                       # neue Zellen (S = 15) mit Objektplatz und Wänden
        def fn(g, cells):
            have = sum(len(c) for c in cells)
            walls = sum(1 for c in cells for _, es in c for e in es if e.art < 2)
            free = [(d, s_) for d in (3, 2, 1) for s_ in list(range(4, 16)) + list(range(-15, -3))
                    if all(s_ != t for t, _ in cells[d])]
            for k in range(ncell - have):
                d, s_ = free[k]
                cells[d].append((s_, [copy.copy(proto_obj)]))
            k = 0
            while walls < nwall:
                d, s_ = free[k // 15]
                es = next(es for t, es in cells[d] if t == s_)
                es.append(copy.copy(proto_side))
                walls += 1
                k += 1
        return fn

    def two_ceils(g, cells):
        es = next(es for s_, es in cells[2] if any(e.art == 3 for e in es))
        es.append(copy.copy(proto_ceil))
    nd = base[5]
    cases = [
        ('16 Elemente in einer Zelle', rebuild(pad_cell(16)), 0),
        ('17 Elemente in einer Zelle', rebuild(pad_cell(17)), 1),
        ('48 Zellen', rebuild(more_cells(48, 0), S=15), 0),
        ('49 Zellen', rebuild(more_cells(49, 0), S=15), 1),
        ('96 Wände', rebuild(more_cells(30, 96), S=15), 0),
        ('97 Wände', rebuild(more_cells(30, 97), S=15), 1),
        ('zwei Deckenelemente', rebuild(two_ceils), 1),
        ('demo', base, 0), ('zwei Fronten (16 wartend)', base2, 0),
        ('17 wartende in Tiefe 3', depth3_ceil(base2), 1),
        ('Zelle nicht zusammenhängend', el(base, 12, 2, 1), 1),
        ('zwei Bodenelemente', el(base, 13, 0, 2), 1),
        ('x + w > VW', el(base, 11, 4, 30), 1),
        ('c1 > VW', el(base, 11, 13, 71), 1),
        ('c0 > c1', el(base, 11, 12, 61), 1),
        ('y + h > VH', el(base, 11, 5, 30), 1),
        ('|s| > S', el(base, 3, 2, -4), 1),
        ('Art 5', el(base, 2, 0, 5), 1),
        ('first + n > NE', bytes(base[:24 + 8 * nd + 5]) + bytes([base[24 + 8 * nd + 5] + 1])
         + base[24 + 8 * nd + 6:], 1),
    ]
    S = Seq(L)
    S.call('INIT', 0, a=0)
    S.call('GEOMSET demo', 12, p=(0xE800, 0xFFFF, 0, 0), pre=[(0xE800, base)], a=0)
    fails = []
    for name, data, a in cases:
        S.call(f'GEOMSET {name}', 12, p=(0xE800, 0xFFFF, 0, 0), pre=[(0xE800, data)], a=a,
               check=lambda b, a=a: [] if b.b('geom_ok') == (a == 0) else ['geom_ok'])
        try:
            dbeview.parse_dvg(data, prg=False)
            py = 0
        except dbeview.ViewError:
            py = 1
        if py != a:
            fails.append(f'parse_dvg {name}: ViewError {bool(py)}, erwartet {bool(a)}')
        if not a:
            S.call(f'GEOMSET {name} zurück', 12, p=(0xE800, 0xFFFF, 0, 0), pre=[(0xE800, base)], a=0)
    # VIEW nach fehlgeschlagenem GEOMSET: A = 5 (keine gültige Geometrie), nach gültigem wieder 0
    import dbemap
    dmp = dbemap.to_dmp(dbemap.load_toml(DEMO_MAP))[2:]
    S.call('GEOMSET demo', 12, p=(0xE800, 0xFFFF, 0, 0), pre=[(0xE800, base)], a=0)
    S.call('MAPINIT', 1, p=(0x5000, 0, 0, 0), pre=[(0x5000, dmp)], a=0)
    S.call('VIEW gültig', 4, p=(0, 0, 0, 0), a=0)
    S.call('GEOMSET 17 Elemente', 12, p=(0xE800, 0xFFFF, 0, 0), pre=[(0xE800, rebuild(pad_cell(17)))], a=1)
    S.call('VIEW nach fehlgeschlagenem GEOMSET', 4, p=(0, 0, 0, 0), a=5)
    S.call('GEOMSET demo erneut', 12, p=(0xE800, 0xFFFF, 0, 0), pre=[(0xE800, base)], a=0)
    S.call('VIEW wieder gültig', 4, p=(0, 0, 0, 0), a=0)
    S.run()
    fails += S.fails
    for f in fails:
        print('FAIL', f)
    print(f'GEOMSET-Prüfungen: {len(cases)} Fälle + VIEW nach Fehler, {len(fails)} Fehler')
    return not fails


def test_p6c():
    sys.path.insert(0, TOOLS)
    import struct as st
    import dbemap, dbetex, dbespr, dbeview
    L = labels()
    fails = []
    u16 = lambda d, o: d[o] | d[o + 1] << 8
    tmp = tempfile.TemporaryDirectory()
    A = dbeview.build_demo_assets(tmp.name)

    # ---- Daten an ihren Bank-1-Adressen (2.4)
    # sim65: Lib-Code an $B000 wie auf dem C128; die Demo-DTS sind größer als die Bereiche der Karte 2.4 (sim.cfg):
    # DVG $E800, Decke ab $EE00 (3,2 KB statt 1,25 KB, endet vor DBG), DBG $FB80 (Standard); alles unter $FC00 (Runtime)
    ADDR = {'dmp': 0x5000, 'dvg': 0xE800, 'wall': 0x6000, 'floor': 0x8300, 'ceil': 0xEE00, 'dbg': 0xFB80,
            'bigmap': 0x2E00}
    S2A = [0x4000, 0x5040, 0x5340, 0x5840]  # Typ 9: S2 ab $4000 (SPRITESET prüft); die DMP lädt nur Szene B ($5000)
    dvg = A.dvg_prg[2:]
    dts = [dbetex.to_dts(t)[2:] for t in (A.walls, A.floor, A.ceil)]
    dtsa = [ADDR['wall'], ADDR['floor'], ADDR['ceil']]
    dbg_prg, _, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(tmp.name, 'bg.toml')))
    dbg = dbg_prg[2:]
    s2 = [dbespr.to_s2(x)[2:] for x in A.sprites[:4]]
    gid_dvg = u16(dvg, 12)
    for k in (0, 2):                                        # Sätze 0 und 2 mit Geometrie-ID, 1 und 3 mit ID 0
        s2[k] = patched(s2[k], (4, gid_dvg), n=len(s2[k]))
    m = dbemap.load_toml(DEMO_MAP)
    dmp = dbemap.to_dmp(m)[2:]
    W, H, NT = m.width, m.height, len(m.tiles)
    assert (u16(dvg, 12) and dvg[5] == 3 and dbg[5:7] == dvg[12:14])

    def base(s):
        s.seg(ADDR['dvg'], dvg)
        for k in range(3):
            s.seg(dtsa[k], dts[k])
        s.seg(ADDR['dbg'], dbg)
        for k in range(4):
            s.seg(S2A[k], s2[k])

    # ================================================================ Szene A: Geometrie und Assets
    S = Seq(L)
    base(S.scene)
    GD, TD, DB = ADDR['dvg'], dtsa, ADDR['dbg']
    VR = [0x0000, 0x4000, 0x8000]       # VRAM-Basen
    S.call('INIT', 0, a=0, rx=3)
    # Reihenfolge: ohne Karte / ohne Geometrie
    for nm, f, x in (('CELL', 5, 0), ('SETPOS', 2, 0), ('SETCELL', 6, 0), ('SETITEM', 16, 0)):
        S.call(f'{nm} ohne MAPINIT', f, x, a=5, rx=0, ry=0, same=True)
    S.call('TEXSET ohne GEOMSET', 13, 0, p=(TD[0], VR[0], 0, 0), a=5, same=True)
    S.call('BGSET ohne GEOMSET', 14, 0x22, p=(DB, 0, 0, 0), a=5,
           check=lambda b: [] if b.b('bgfill') == 0x22 else ['bgfill'])
    S.call('SPRITESET ohne GEOMSET', 9, 0, p=(S2A[0], 0, 0, 0), a=5, same=True)
    S.call('TEXSET löschen ohne GEOMSET', 13, 2, p=(0, 0, 0, 0), a=0, same=True)
    S.call('BGSET keine Tapete', 14, 0x44, p=(0, 0, 0, 0), a=0,
           check=lambda b: [] if b.b('bgfill') == 0x44 and b.b('dbg_ok') == 0 else ['bgfill/dbg_ok'])
    S.call('SPRITESET löschen', 9, 7, p=(0, 0, 0, 0), a=0)
    S.call('SPRITESET Satz 8', 9, 8, p=(S2A[0], 0, 0, 0), a=6)
    S.call('TEXSET Art 3', 13, 3, p=(TD[0], 0, 0, 0), a=6)
    # GEOMSET: Formatfehler
    gerr = [('Magic', (0, ord('X'))), ('Version', (2, 2)), ('Elementlänge', (16, 15)), ('Tiefeneintrag', (17, 7)),
            ('VW 81', (3, 81)), ('VW 0', (3, 0)), ('VH 101', (4, 101)), ('VH 0', (4, 0)), ('D 8', (5, 8)),
            ('NE 0', (7, 0)), ('S 16', (6, 16))]
    for nm, e in gerr:
        S.call(f'GEOMSET {nm}', 12, p=(HDR, 0xFFFF, 0, 0), pre=[(HDR, patched(dvg, e))], a=1, same=True)
    S.call('TEXSET nach GEOMSET-Fehler', 13, 0, p=(TD[0], 0, 0, 0), a=5, same=True)

    def geom_check(src, origin, dvgaddr):
        def chk(b):
            out = []
            vw, vh, D, Sx, ne = src[3:8]
            stride, org, gid = st.unpack_from('<HHH', src, 8)
            if origin != 0xFFFF:
                org = origin
            got = (b.b('geom_ok'), b.raw('dvg_vw', 5), b.w('dvg_vw', 5), b.w('dvg_vw', 7), b.w('dvg_vw', 9),
                   b.raw('dvg_vw', 2, 11))
            want = (1, bytes([vw, vh, D, Sx, ne]), stride, org, gid, bytes(src[14:16]))
            if got != want:
                out.append(f'DVG-Zustand {got} <> {want}')
            if (b.w('ptrs', 8), b.w('ptrs', 10)) != (dvgaddr + u16(src, 18), dvgaddr + u16(src, 20)):
                out.append('Tiefen-/Elementtabelle')
            rows = b''.join(st.pack('<H', (org + y * stride) & 0xFFFF) for y in range(vh))
            if b.raw('rows', 200) != rows + bytes(200 - len(rows)):
                out.append('Zeilentabelle')
            return out
        return chk

    S.call('GEOMSET', 12, p=(GD, 0xFFFF, 0, 0), a=0, rx=0, ry=0, check=geom_check(dvg, 0xFFFF, GD))
    S.call('GEOMSET origin 0x1234', 12, p=(GD, 0x1234, 0, 0), a=0, rx=0, ry=0, check=geom_check(dvg, 0x1234, GD))
    S.call('GEOMSET origin aus DVG', 12, p=(GD, 0xFFFF, 0, 0), a=0, check=geom_check(dvg, 0xFFFF, GD))

    # ---- TEXSET
    def rec_check(k, src, base_addr, vram, kind):
        """kind 'dts' | 's2': Satz k der Satztabelle"""
        def chk(b):
            o = 16 * k
            r = b.raw('recs', 16, o)
            if kind == 'dts':
                want = bytes([1]) + st.pack('<H', vram) + bytes([src[8], src[9], 0, 0, 0]) + st.pack(
                    '<HHHH', base_addr, base_addr + u16(src, 12), base_addr + u16(src, 14), base_addr + u16(src, 16))
            else:
                want = bytes([1]) + st.pack('<H', vram) + bytes([src[7], src[8]]) + src[4:6] + b'\0' + st.pack(
                    '<HHH', base_addr, base_addr + u16(src, 16), base_addr + u16(src, 18)) + bytes([src[7] * dvg[5], 0])
            return [] if r == want else [f'Satz {k}: {r.hex()} <> {want.hex()}']
        return chk
    for k in range(3):
        S.call(f'TEXSET Art {k}', 13, k, p=(TD[k], VR[k], 0, 0), a=0, rx=0, ry=0,
               check=rec_check(k, dts[k], TD[k], VR[k], 'dts'))
    S.call('TEXSET Art falsch', 13, 1, p=(TD[0], 0, 0, 0), a=1, same=True)
    S.call('TEXSET unter $4000', 13, 0, p=(0x3FC0, VR[0], 0, 0), pre=[(0x3FC0, dts[0][:64])], a=6, same=True)
    terr = [('Magic', 1, (1, ord('X'))), ('Version', 1, (2, 2)), ('NST 0', 1, (9, 0)), ('NST 33', 1, (9, 33)),
            ('Art', 1, (3, 2))]
    for nm, ferr, e in terr:
        S.call(f'TEXSET {nm}', 13, 0, p=(HDR, 0, 0, 0), pre=[(HDR, patched(dts[0], e))], a=1, same=True)
    gid = u16(dts[0], 4)
    for nm, e in (('ID', (4, gid ^ 0x100)), ('NE', (6, dts[0][6] + 1)), ('D', (7, dts[0][7] + 1)),
                  ('Stride', (28, u16(dts[0], 28) + 1))):
        S.call(f'TEXSET {nm}', 13, 0, p=(HDR, 0, 0, 0), pre=[(HDR, patched(dts[0], e, n=32))], a=4, same=True)
    # Pool
    U = [u16(t, 24) for t in dts]
    S.call('POOLSET', 11, p=(0x1000, 0xA000, 0, 0), a=0)
    S.call('TEXSET Pool: Basis < Anfang', 13, 0, p=(TD[0], 0x0FFF, 0, 0), a=6, same=True)
    S.call('TEXSET Pool: Ende überschritten', 13, 0, p=(TD[0], 0xA000 - U[0] + 1, 0, 0), a=6, same=True)
    S.call('TEXSET Pool: genau am Ende', 13, 0, p=(TD[0], 0xA000 - U[0], 0, 0), a=0,
           check=rec_check(0, dts[0], TD[0], 0xA000 - U[0], 'dts'))
    S.call('TEXSET Pool: genau am Anfang', 13, 0, p=(TD[0], 0x1000, 0, 0), a=0,
           check=rec_check(0, dts[0], TD[0], 0x1000, 'dts'))
    S.call('POOLSET bis 65536', 11, p=(0x1000, 0, 0, 0), a=0)
    S.call('TEXSET Pool 65536: genau', 13, 0, p=(TD[0], (0x10000 - U[0]) & 0xFFFF, 0, 0), a=0,
           check=rec_check(0, dts[0], TD[0], 0x10000 - U[0], 'dts'))
    S.call('TEXSET Pool 65536: Überlauf', 13, 0, p=(TD[0], (0x10001 - U[0]) & 0xFFFF, 0, 0), a=6)
    S.call('POOLSET aus', 11, p=(0, 0, 0, 0), a=0)
    S.call('TEXSET Art 0 erneut', 13, 0, p=(TD[0], VR[0], 0, 0), a=0, check=rec_check(0, dts[0], TD[0], VR[0], 'dts'))
    S.call('TEXSET Decke löschen', 13, 2, p=(0, 0, 0, 0), a=0,
           check=lambda b: [] if b.b('recs', 32) == 0 else ['Satz nicht gelöscht'])
    S.call('TEXSET Decke', 13, 2, p=(TD[2], VR[2], 0, 0), a=0, check=rec_check(2, dts[2], TD[2], VR[2], 'dts'))

    # ---- BGSET
    def bg_check(vram, fill):
        def chk(b):
            want = (1, vram, DB, st.unpack_from('<H', dbg, 7)[0], dbg[9], dbg[10], dbg[11], fill)
            got = (b.b('dbg_ok'), b.w('dbg_vram'), b.w('dbg_base'), b.w('dbg_p'), b.b('dbg_p', 2), b.b('dbg_p', 3),
                   b.b('dbg_p', 4), b.b('bgfill'))
            return [] if got == want else [f'DBG {got} <> {want}']
        return chk
    S.call('BGSET', 14, 0x77, p=(DB, 0x6000, 0, 0), a=0, rx=0, ry=0, check=bg_check(0x6000, 0x77))
    for nm, e, a in (('Magic', (1, ord('X')), 1), ('Version', (2, 9), 1), ('P 0', (7, 0, 2), 1), ('VW', (3, dbg[3] + 1), 4),
                     ('VH', (4, dbg[4] - 1), 4), ('ID', (5, u16(dbg, 5) ^ 1), 4)):
        S.call(f'BGSET {nm}', 14, 0x11, p=(HDR, 0x7000, 0, 0), pre=[(HDR, patched(dbg, e, n=32))], a=a,
               check=lambda b: [] if b.b('bgfill') == 0x11 and b.w('dbg_vram') == 0x6000 else ['Zustand'])
    Ub = u16(dbg, 20)
    S.call('POOLSET für BGSET', 11, p=(0x4000, 0x8000, 0, 0), a=0)
    S.call('BGSET Pool', 14, 0x77, p=(DB, 0x8000 - Ub + 1, 0, 0), a=6)
    S.call('BGSET Pool ok', 14, 0x77, p=(DB, 0x8000 - Ub, 0, 0), a=0, check=bg_check(0x8000 - Ub, 0x77))
    S.call('POOLSET aus 2', 11, p=(0, 0, 0, 0), a=0)

    # ---- SPRITESET
    for k in range(4):
        S.call(f'SPRITESET {k}', 9, k, p=(S2A[k], 0x1000 * k, 0, 0), a=0, rx=0, ry=0,
               check=rec_check(3 + k, s2[k], S2A[k], 0x1000 * k, 's2'))
    for nm, e, a in (('Magic', (0, ord('X')), 1), ('Version', (2, 2), 1), ('NA 0', (7, 0), 1), ('NA 5', (7, 5), 1),
                     ('NP 0', (8, 0), 1), ('ID', (4, u16(s2[0], 4) ^ 1), 4), ('D', (6, s2[0][6] + 1), 4),
                     ('Stride', (34, u16(s2[0], 34) + 2), 4)):
        S.call(f'SPRITESET {nm}', 9, 5, p=(HDR, 0, 0, 0), pre=[(HDR, patched(s2[0], e))], a=a,
               check=lambda b: [] if b.b('recs', 16 * 8) == 0 else ['Satz 5 gesetzt'])
    S.call('POOLSET für SPRITESET', 11, p=(0x4000, 0x8000, 0, 0), a=0)
    Us = u16(s2[1], 30)
    S.call('SPRITESET Pool', 9, 1, p=(S2A[1], 0x8000 - Us + 1, 0, 0), a=6)
    S.call('SPRITESET Pool ok', 9, 1, p=(S2A[1], 0x8000 - Us, 0, 0), a=0,
           check=rec_check(4, s2[1], S2A[1], 0x8000 - Us, 's2'))
    S.call('POOLSET aus 3', 11, p=(0, 0, 0, 0), a=0)
    S.call('SPRITESET 1 erneut', 9, 1, p=(S2A[1], 0x1000, 0, 0), a=0)
    # Satz 4: ID 0, Satz 7: Kopie von Satz 2 (Header-Kopie, Tabellen nur als Adressen)
    S.call('SPRITESET unter $4000', 9, 4, p=(0x3FC0, 0x5000, 0, 0), pre=[(0x3FC0, patched(s2[3], (4, 0, 2)))], a=6,
           check=lambda b: [] if b.b('recs', 16 * 7) == 0 else ['Satz 4 gesetzt'])
    S.call('SPRITESET ID 0', 9, 4, p=(HDR2, 0x5000, 0, 0), pre=[(HDR2, patched(s2[3], (4, 0, 2)))], a=0,
           check=rec_check(7, patched(s2[3], (4, 0, 2)), HDR2, 0x5000, 's2'))
    S.call('SPRITESET 7', 9, 7, p=(S2A[2], 0x6000, 0, 0), a=0, check=rec_check(10, s2[2], S2A[2], 0x6000, 's2'))

    # ---- ITEMSET
    def item_check(vals):
        vals = list(vals)
        return lambda b: [] if b.raw('itemtab', 64) == bytes(vals) else ['itemtab']
    it = [0] * 64
    S.call('ITEMSET 0,0', 10, 0, 0, a=0, check=item_check(it))
    it[5], it[63] = 8, 3
    S.call('ITEMSET 5,8', 10, 5, 8, a=0, check=item_check([0] * 5 + [8] + [0] * 57 + [0]))
    S.call('ITEMSET 63,3', 10, 63, 3, a=0, check=item_check(it))
    S.call('ITEMSET 64', 10, 64, 1, a=6, same=True)
    S.call('ITEMSET Satz 9', 10, 5, 9, a=6, same=True)
    # ---- GEOMSET: gleiche ID (neuer origin), andere ID, anderes D / Stride
    S.call('GEOMSET gleiche ID, origin 7', 12, p=(GD, 7, 0, 0), a=0, rx=0, ry=0, check=geom_check(dvg, 7, GD))
    S.call('Satz 0 nach gleicher ID noch gültig', 15, p=(0x1300, 0x1C00, 0, 0), a=0,
           check=lambda b: [] if b.b('recs', 0) == 1 and b.b('dbg_ok') == 1 and b.b('recs', 48) == 1 else ['gelöscht'])
    dvg2 = patched(dvg, (12, gid ^ 0x55), n=len(dvg))
    S.call('GEOMSET andere ID', 12, p=(HDR + 0x400, 0xFFFF, 0, 0), pre=[(HDR + 0x400, dvg2)], a=0,
           rx=0x85, ry=0x0F, check=geom_check(dvg2, 0xFFFF, HDR + 0x400))        # S2 mit ID: Sätze 0, 2, 7
    S.call('Sätze mit ID 0 bleiben', 15, p=(0x1300, 0x1C00, 0, 0), a=0,
           check=lambda b: [] if [b.b('recs', 16 * (3 + k)) for k in range(8)] == [0, 1, 0, 1, 1, 0, 0, 0] and
           b.b('recs', 0) == 0 and b.b('dbg_ok') == 0 else ['Sätze 1, 3, 4'])
    S.call('TEXSET mit alter ID', 13, 0, p=(TD[0], 0, 0, 0), a=4, same=True)
    S.call('BGSET mit alter ID', 14, 0, p=(DB, 0, 0, 0), a=4)
    dvg3 = patched(dvg, (12, gid ^ 0x66), (5, 2), n=len(dvg))
    S.call('GEOMSET andere ID und D', 12, p=(HDR + 0x400, 0xFFFF, 0, 0), pre=[(HDR + 0x400, dvg3)], a=0,
           rx=0x1A, ry=0, check=geom_check(dvg3, 0xFFFF, HDR + 0x400))
    S.call('GEOMSET zurück', 12, p=(GD, 0xFFFF, 0, 0), a=0, rx=0, ry=0, check=geom_check(dvg, 0xFFFF, GD))
    S.call('SPRITESET ID 0 erneut', 9, 4, p=(HDR2, 0x5000, 0, 0), pre=[(HDR2, patched(s2[3], (4, 0, 2)))], a=0)
    dvg4 = patched(dvg, (12, gid ^ 0x77), (8, u16(dvg, 8) + 2), n=len(dvg))
    S.call('GEOMSET andere ID und Stride', 12, p=(HDR + 0x400, 0xFFFF, 0, 0), pre=[(HDR + 0x400, dvg4)], a=0,
           rx=0x10, ry=0)
    S.call('GEOMSET zurück 2', 12, p=(GD, 0xFFFF, 0, 0), a=0, rx=0, ry=0)
    S.call('SPRITESET ID 0 und gleiche ID', 9, 4, p=(HDR2, 0x5000, 0, 0), pre=[(HDR2, patched(s2[3], (4, 0, 2)))],
           a=0)
    S.call('GEOMSET gleiche ID: Satz 4 bleibt', 12, p=(GD, 0x10, 0, 0), a=0, rx=0, ry=0)
    S.call('INIT löscht alles', 0, a=0, rx=3,
           check=lambda b: [] if b.raw('recs', 176) == bytes(176) and b.b('geom_ok') == 0 else ['Zustand'])
    cyc = S.run()
    fails += S.fails
    print(f'P6c sim A (Geometrie, Assets): {len(S.steps)} Aufrufe, {len(S.fails)} Fehler, Zyklen {cyc}')

    # ================================================================ Szene B: Karte
    SB = Seq(L)
    SB.seg(ADDR['dmp'], dmp)
    SB.call('INIT', 0, a=0)
    mp = (ADDR['dmp'], 0, 0, 0)
    # Formatfehler (Kopfkopien)
    c = dmp
    wh = W * H
    bad = [('Magic', (0, ord('X'))), ('Version', (2, 2)), ('W 0', (3, 0)), ('H 0', (4, 0)),
           ('W*H > 16384', (3, 255), (4, 255)), ('W*H = 16512', (3, 129), (4, 128)),
           ('Start >= W*H', (8, wh)), ('Richtung 4', (10, 4)), ('Außenkachel >= NT', (11, NT)),
           ('Offset 12', (12, 25)), ('Offset 14', (14, 24 + wh + 1)), ('Offset 16', (16, 24 + 2 * wh + 8)),
           ('Offset 18', (18, u16(c, 18) + 1)), ('Länge', (20, u16(c, 20) + 1)), ('NT', (5, NT + 1)),
           ('NE', (6, u16(c, 6) + 1)), ('NE 16384 (4 NE = 65536)', (6, 0x4000), (20, u16(c, 18))),
           ('Länge über 65535', (6, 0x3FFF), (20, (u16(c, 18) + 4 * 0x3FFF) & 0xFFFF))]
    for nm, *e in bad:
        SB.call(f'MAPINIT {nm}', 1, p=(HDR, 0, 0, 0), pre=[(HDR, patched(c, *e, n=24))], a=1,
                check=lambda b: [] if b.b('map_ok') == 0 else ['map_ok'])
        SB.call(f'CELL nach fehlerhaftem MAPINIT ({nm})', 5, p=(0, 0, 0, 0), a=5)

    def map_check(m_, copyaddr, auto, dmpaddr=ADDR['dmp']):
        n = m_.width * m_.height
        def chk(b):
            out = []
            got = (b.b('map_ok'), b.b('map_w'), b.b('map_h'), b.w('map_wh'), b.w('map_nt'), b.w('map_ne'), b.w('pos'),
                   b.b('vdir'), b.b('map_out'), b.b('map_auto'), b.b('px'), b.b('py'))
            want = (1, m_.width, m_.height, n, len(m_.tiles), len(m_.events), m_.start, m_.direction, m_.outside, auto,
                    m_.start % m_.width, m_.start // m_.width)
            if got != want:
                out.append(f'Karte {got} <> {want}')
            cells = copyaddr or dmpaddr + 24
            if (b.w('ptrs', 0), b.w('ptrs', 2)) != (cells, cells + n):
                out.append('Ebenenzeiger')
            if (b.w('ptrs', 4), b.w('ptrs', 6)) != (dmpaddr + 24 + 2 * n, dmpaddr + 24 + 2 * n + 8 * len(m_.tiles)):
                out.append('Tabellenzeiger')
            return out
        return chk
    SB.call('MAPINIT', 1, p=mp, objn=5, a=0, rx=W, ry=H, rp=(m.start, m.direction), check=map_check(m, 0, 0),
            dump=[(0x0C50, 1)])
    SB.call('OBJN = 0', 15, p=(0x1300, 0x1C00, 0, 0), a=0)
    SB.call('MAPINIT mit Arbeitskopie und Automap', 1, x=1, p=(ADDR['dmp'], 0x6000, 0, 0), objn=3, a=0, rx=W, ry=H,
            rp=(m.start, m.direction), check=map_check(m, 0x6000, 1), dump=[(0x0C50, 1), (0x6000, 2 * W * H)])
    # CELL, SETPOS
    for i in range(W * H):
        t = m.cells[i]
        SB.call(f'CELL {i}', 5, p=(i, 0, 0, 0), a=0, rx=t, ry=m.content[i], rp=(i, m.tiles[t].flags))
    SB.call('CELL außerhalb', 5, p=(W * H, 0, 0, 0), a=6, rx=m.outside, ry=0, rp=(W * H, m.tiles[m.outside].flags))
    SB.call('CELL 0xFFFF', 5, p=(0xFFFF, 0, 0, 0), a=6, rx=m.outside, ry=0)
    prev = None
    for i in range(W * H):
        v = (i * 3) % 4
        SB.call(f'SETPOS {i}', 2, v, p=(i, 0, 0, 0), a=0, rx=0, ry=0,
                check=(lambda i, v: lambda b: [] if (b.w('pos'), b.b('vdir'), b.b('px'), b.b('py')) == (i, v, i % W, i // W)
                       else [f'pos/v/px/py {(b.w("pos"), b.b("vdir"), b.b("px"), b.b("py"))}'])(i, v))
    SB.call('SETPOS außerhalb', 2, 1, p=(W * H, 0, 0, 0), a=6, same=True)
    SB.call('SETPOS Richtung 4', 2, 4, p=(3, 0, 0, 0), a=6, same=True)
    # SETCELL / SETITEM (mit Arbeitskopie: DMP bleibt, Kopie ändert sich)
    SB.call('SETCELL 3 = Kachel 2', 6, 2, p=(3, 0, 0, 0), a=0)
    SB.call('CELL 3 nach SETCELL', 5, p=(3, 0, 0, 0), a=0, rx=2, ry=m.content[3], rp=(3, m.tiles[2].flags))
    SB.call('SETCELL Kachel = NT', 6, NT, p=(3, 0, 0, 0), a=6, same=True)
    SB.call('SETCELL Kachel 255', 6, 255, p=(3, 0, 0, 0), a=6, same=True)
    SB.call('SETCELL Zelle außerhalb', 6, 0, p=(W * H, 0, 0, 0), a=6, same=True)
    SB.call('SETITEM 10 = $45', 16, 0x45, p=(10, 0, 0, 0), a=0)
    SB.call('CELL 10 nach SETITEM', 5, p=(10, 0, 0, 0), a=0, rx=m.cells[10], ry=0x45)
    SB.call('SETITEM 34 = 255', 16, 255, p=(34, 0, 0, 0), a=0)
    SB.call('SETITEM außerhalb', 16, 1, p=(W * H, 0, 0, 0), a=6, same=True)
    SB.call('SETITEM $FFFF', 16, 1, p=(0xFFFF, 0, 0, 0), a=6, same=True)
    cells2 = bytes(m.cells[:3] + [2] + m.cells[4:])
    cont2 = bytearray(m.content)
    cont2[10], cont2[34] = 0x45, 255
    SB.call('Kopie und DMP prüfen', 15, p=(0x1300, 0x1C00, 0, 0), a=0, dump=[(0x6000, 2 * W * H), (0x5000 + 24, 2 * W * H)],
            check=lambda b: ([] if b.extra[0] == cells2 + bytes(cont2) else ['Arbeitskopie']) +
            ([] if b.extra[1] == bytes(m.cells) + bytes(m.content) else ['DMP verändert']))
    # ohne Arbeitskopie: SETCELL schreibt in die DMP
    SB.call('MAPINIT ohne Kopie', 1, p=mp, a=0, check=map_check(m, 0, 0))
    SB.call('SETCELL in DMP', 6, 1, p=(0, 0, 0, 0), a=0, dump=[(0x5000 + 24, 1)],
            check=lambda b: [] if b.extra[0] == b'\1' else ['DMP nicht geändert'])
    # Ziel der Arbeitskopie (P6d): [P1, P1 + 2 W H) muss in $2000 ... LIB ($B000) liegen, sonst E_RANGE
    n2 = 2 * W * H
    for nm, dst, a in (('genau unter LIB', 0xB000 - n2, 0), ('ein Byte über LIB', 0xB000 - n2 + 1, 6),
                       ('ab LIB', 0xB000, 6), ('BSS', 0xE000, 6), ('DVG', 0xE800, 6), ('unter $2000', 0x1FFF, 6),
                       ('$0400', 0x0400, 6), ('Überlauf 65536', 0x10000 - n2 + 2, 6), ('I/O', 0xD000 - 4, 6)):
        SB.call(f'MAPINIT Arbeitskopie {nm}', 1, p=(ADDR['dmp'], dst, 0, 0), a=a,
                check=(lambda a, dst: lambda b: ([] if b.b('map_ok') == (a == 0) else ['map_ok']) +
                       ([] if a or b.w('ptrs', 0) == dst else ['Kopie nicht benutzt']))(a, dst))
        SB.call(f'CELL nach MAPINIT {nm}', 5, p=(0, 0, 0, 0), a=0 if a == 0 else 5)
    cyc = SB.run()
    fails += SB.fails
    print(f'P6c sim B (Karte, {W}x{H}): {len(SB.steps)} Aufrufe, {len(SB.fails)} Fehler, Zyklen {cyc}')

    # ---- Zufallskarten und Grenzfälle der Größe (NT = 256, 128 x 128, 255 x 64, Zufallsgrößen)
    import random
    SC = Seq(L)
    SC.call('INIT', 0, a=0)
    rnd = random.Random(6)
    T = dbemap.Tile
    maps = []
    for (w, h, nt) in ((128, 128, 3), (255, 64, 5), (1, 255, 2), (255, 1, 256), (1, 1, 1), (17, 9, 256), (40, 40, 7)):
        tiles = [T((0, 0, 0, 0), 1, 1, 0, 0) for _ in range(nt)]
        cells = [rnd.randrange(nt) for _ in range(w * h)]
        content = [rnd.randrange(256) for _ in range(w * h)]
        start = rnd.randrange(w * h)
        mm = dbemap.Map('z', w, h, tiles, cells, content, [], start, rnd.randrange(4), rnd.randrange(nt))
        maps.append(mm)
    for mm in maps:
        w, h = mm.width, mm.height
        n = w * h
        data = dbemap.to_dmp(mm)[2:]
        nm = f'{w}x{h} NT {len(mm.tiles)}'
        use_copy = n <= 2048
        SC.call(f'MAPINIT {nm}', 1, p=(ADDR['bigmap'], 0x8000 if use_copy else 0, 0, 0),
                pre=[(ADDR['bigmap'], data)], a=0, rx=w & 255, ry=h & 255,
                rp=(mm.start, mm.direction), check=map_check(mm, 0x8000 if use_copy else 0, 0, ADDR['bigmap']))
        probe = sorted({0, n - 1, mm.start, n // 2, rnd.randrange(n), rnd.randrange(n)})
        for i in probe:
            SC.call(f'{nm} CELL {i}', 5, p=(i, 0, 0, 0), a=0, rx=mm.cells[i] & 255, ry=mm.content[i], rp=(i, 0))
            SC.call(f'{nm} SETPOS {i}', 2, 3, p=(i, 0, 0, 0), a=0,
                    check=(lambda i, w: lambda b: [] if (b.b('px'), b.b('py')) == (i % w, i // w) else
                           [f'px/py {(b.b("px"), b.b("py"))}'])(i, w))
        SC.call(f'{nm} SETCELL höchste Kachel', 6, len(mm.tiles) - 1 & 255, p=(n - 1, 0, 0, 0), a=0)
        SC.call(f'{nm} SETCELL NT', 6, len(mm.tiles) & 255, p=(n - 1, 0, 0, 0), a=0 if len(mm.tiles) == 256 else 6)
    cyc = SC.run()
    fails += SC.fails
    print(f'P6c sim C (Größen, Zufall): {len(SC.steps)} Aufrufe, {len(SC.fails)} Fehler, Zyklen {cyc}')
    for f in fails[:40]:
        print('FAIL', f)
    return not fails




# ------------------------------------------------------------------ P6d: VIEW ohne Objekte
# Demo-DTS größer als die Bereiche von 2.4: DVG $E800 (bis 1,8 KB), Decke $EF00-$FBAE (alles unter $FC00), DBG in der Lücke
# zwischen Wand und Boden (Platz dort für Wand-DTS mit doppelten Slots)
P6D_ADDR = {'dmp': 0x2E00, 'dvg': 0xE800, 'dts': (0x6000, 0x8300, 0xEF00), 'dbg': 0x8280}   # S2: ViewRunner.S2_AREAS
BIGBUF = (0x1300, 0x1C00)       # größter erlaubter Puffer (BUFSET-Fenster, P6d-opt)


class ViewRunner:
    """Baut aus dbeview-Szenen eine Szenendatei (nur nötige Setz-Aufrufe zwischen den Ansichten) und vergleicht
    jede VIEW-Antwort bytegenau mit dbeview.view."""

    mapx, mapp1 = 0, 0              # MAPINIT: X und Arbeitskopie (P6f: Automap)

    def __init__(self, dbeview, dbetex, vcopy=False):
        self.dv, self.dt = dbeview, dbetex
        self.bank1 = not vcopy
        self.prg = PRGC if vcopy else PRG
        self.reset()

    def reset(self):
        self.scene = Scene()
        self.scene.call(0)
        self.state = {}
        self.expect = []            # (Name, Result) je VIEW, None für Setz-Aufrufe

    def _call(self, f, x=0, y=0, p=(0, 0, 0, 0), want=None, **kw):
        self.scene.call(f, x, y, p, **kw)
        self.expect.append(want)

    def setup(self, sc):
        """Setz-Aufrufe für sc; Rückgabe: Liste der (Aufruf, erwartetes A)"""
        st, dv, dt = self.state, self.dv, self.dt
        dvg = dv.dvg_bytes(sc.dvg)[2:]
        if st.get('dvg') != dvg:
            self.scene.seg(P6D_ADDR['dvg'], dvg)
            self._call(12, p=(P6D_ADDR['dvg'], 0xFFFF, 0, 0), want=('setup', 0))
            st['dvg'] = dvg
            st.pop('dts', None)
            st.pop('bg', None)
            for k in range(8):
                st.pop(('s2', k), None)
        for k in range(3):
            ts = sc.dts[k]
            key = (id(ts), ts.ne if ts else 0, sc.vram_bases['dts'][k])
            if st.get(('dts', k)) != key or 'dts' not in st:
                if ts is None:
                    self._call(13, k, p=(0, 0, 0, 0), want=('setup', 0))
                else:
                    data = (getattr(ts, 'dts_prg', None) or dt.to_dts(ts))[2:]
                    if st.get(('dtsdata', k)) != data:
                        self.scene.seg(P6D_ADDR['dts'][k], data)
                        st[('dtsdata', k)] = data
                    self._call(13, k, p=(P6D_ADDR['dts'][k], sc.vram_bases['dts'][k], 0, 0), want=('setup', 0))
                st[('dts', k)] = key
        st['dts'] = True
        bg = (sc.dbg is not None, sc.bgfill, sc.vram_bases['dbg'])
        if st.get('bg') != bg:
            if sc.dbg is not None and not st.get('dbgdata'):
                self.scene.seg(P6D_ADDR['dbg'], self.dbg_bytes)
                st['dbgdata'] = True
            self._call(14, sc.bgfill, p=(P6D_ADDR['dbg'] if sc.dbg is not None else 0, sc.vram_bases['dbg'], 0, 0),
                       want=('setup', 0))
            st['bg'] = bg
        dmp = self.dv.dbemap.to_dmp(sc.dmp)[2:]
        if st.get('dmp') != dmp:
            self.scene.seg(P6D_ADDR['dmp'], dmp)
            self._call(1, self.mapx, p=(P6D_ADDR['dmp'], self.mapp1, 0, 0), want=('setup', 0))
            st['dmp'] = dmp
            st.pop('pos', None)
        if st.get('pos') != (sc.pos, sc.dir):
            self._call(2, sc.dir, p=(sc.pos, 0, 0, 0), want=('setup', 0))
            st['pos'] = (sc.pos, sc.dir)
        if st.get('buf') != sc.buf:
            self._call(15, p=(sc.buf[0], sc.buf[1], 0, 0), want=('setup', 0))
            st['buf'] = sc.buf
        # Sprite-Sätze (S2 an festen Adressen je Satzobjekt, P6e) und ITEMSET
        for k in range(8):
            ss = sc.s2[k]
            key = (id(ss), sc.vram_bases['s2'][k]) if ss is not None else None
            if st.get(('s2', k), 'neu') == key:
                continue
            if ss is None:
                self._call(9, k, p=(0, 0, 0, 0), want=('setup', 0))
            else:
                addr = self.s2_addr(ss)
                self._call(9, k, p=(addr, sc.vram_bases['s2'][k], 0, 0), want=('setup', 0))
            st[('s2', k)] = key
        it = st.setdefault('itemtab', [0] * 64)
        for g in range(64):
            if it[g] != sc.itemtab[g]:
                self._call(10, g, sc.itemtab[g], want=('setup', 0))
                it[g] = sc.itemtab[g]

    S2_AREAS = ((0x4000, 0x6000), (0xA700, 0xB000))      # freie Bereiche für S2 (sim.cfg; ab $4000 wegen Typ 9)

    def s2_addr(self, ss):
        """Bank-1-Adresse eines Sprite-Satzes; lädt ihn beim ersten Gebrauch (Bereiche S2_AREAS, dicht)."""
        tab = self.state.setdefault('s2addr', {})
        if id(ss) in tab:
            return tab[id(ss)][0]
        import dbespr
        data = dbespr.to_s2(ss)[2:]
        used = self.state.setdefault('s2used', [a for a, b in self.S2_AREAS])
        for i, (a, b) in enumerate(self.S2_AREAS):
            if used[i] + len(data) <= b:
                addr = used[i]
                used[i] += (len(data) + 15) & ~15
                break
        else:
            raise RuntimeError('kein Platz für den Sprite-Satz im sim65-Speicher')
        self.scene.seg(addr, data)
        tab[id(ss)] = (addr, ss)            # ss festhalten: id bleibt eindeutig
        return addr

    def add(self, name, sc, objs=False, objn=None):
        """objs: Objekte, Gegenstände (itemtab) und ITEMPH der Szene übernehmen (P6e), sonst ohne Objekte (P6d);
        objn: OBJN abweichend von der Länge der Liste (> 16 testen)."""
        if not objs:
            sc.objects = []
            sc.itemtab = [0] * 64
        sc.vms_bank1, sc.dts_addr = self.bank1, P6D_ADDR['dts']
        self.setup(sc)
        sc.s2_addr = tuple(self.s2_addr(ss) if ss is not None else 0 for ss in sc.s2)
        self._call(4, p=(sc.ap, 0, 0, 0), want=(name, self.dv.view(sc)), **self.objargs(sc, objn))

    @staticmethod
    def objargs(sc, objn=None):
        ol = b''.join(struct.pack('<HBBBB', o.cell, o.set, o.dir, o.phase, o.byte5()) for o in sc.objects[:16])
        return dict(itemph=sc.itemph, objn=len(sc.objects) if objn is None else objn, objl=ol)

    def run(self):
        r = run(self.scene, self.prg)
        self.last_items = r.items
        calls = [c for c in r.items if isinstance(c, Call)]
        assert len(calls) == len(self.expect) + 1
        fails, nview, codes = [], 0, {}
        for c, w in zip(calls[1:], self.expect):
            name, res = w
            if name == 'setup':
                if c.a != res:
                    fails.append(f'Setz-Aufruf F={c.f}: A = {c.a}')
                continue
            nview += 1
            codes[res.a] = codes.get(res.a, 0) + 1
            pb = struct.unpack('<HHHH', c.pb[2:10])            # VCLADR, VCLLEN, VMSLEN, OBJVIS
            got = (c.a, c.x, c.y, c.p[0], pb)
            want = (res.a, res.x, 0, res.p0, (res.p0, res.vcllen, res.vmslen, res.objvis))
            if got != want or c.buf != res.buffer:
                msg = f'{name}: A/X/Y/P0/PB sim {got} <> Referenz {want}'
                if c.buf != res.buffer:
                    msg += '; ' + (first_diff(c.buf, res.buffer) or 'Länge')
                fails.append(msg)
        return nview, fails, codes, r.cycles


def corridor_map(dbemap, n=24):
    """Gang mit deckenden Wänden und einheitlichem Boden/Decke (Zyklenziel 8, Zeile 2)."""
    T = dbemap.Tile
    t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, 1 | 4, 0)]
    w, h = n, 5
    cells = [1] * (w * h)
    for x in range(1, w - 1):
        cells[2 * w + x] = 0
    for y in (1, 3):                            # Seitengänge
        for x in range(4, w - 1, 6):
            cells[y * w + x] = 0
    m = dbemap.Map('gang', w, h, t, cells, [0] * (w * h), [], 2 * w + 1, 1, 1)
    dbemap.validate(m)
    return m


def time_view(runner, sc):
    """Zyklen eines VIEW: Lauf mit VIEW minus Lauf mit F = 7 an seiner Stelle (gleiche Szene)."""
    runner.reset()
    sc.objects, sc.itemtab = [], [0] * 64
    runner.setup(sc)
    base = bytes(runner.scene.b)
    a = Scene(); a.b = bytearray(base); a.call(4, p=(sc.ap, 0, 0, 0), quiet=True)
    b = Scene(); b.b = bytearray(base); b.call(7, p=(sc.ap, 0, 0, 0), quiet=True)
    return run(a, runner.prg).cycles - run(b, runner.prg).cycles


def test_p6d(vcopy=False):
    sys.path.insert(0, TOOLS)
    sys.path.insert(0, os.path.join(ROOT, 'test', 'tools'))
    import copy, random
    import dbemap, dbetex, dbeview
    dbeview.dbemap = dbemap
    from test_dbeview import abgrund_map
    full = bool(os.environ.get('DBEVIEW_FULL'))
    tmp = tempfile.TemporaryDirectory()
    A = dbeview.build_demo_assets(tmp.name)
    A2 = dbeview.double_fronts(A)
    dbg_prg, _, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(tmp.name, 'bg.toml')))
    demo = dbemap.load_toml(DEMO_MAP)
    ok = True
    total = 0
    allcodes = {}

    def free(m):
        return [i for i, c in enumerate(m.cells) if not m.tiles[c].flags & dbeview.T_WEG]

    tag = ' (VMS_COPY)' if vcopy else ''

    def go(label, scenes):
        nonlocal ok, total
        R = ViewRunner(dbeview, dbetex, vcopy)
        R.dbg_bytes = dbg_prg[2:]
        for name, sc in scenes:
            R.add(name, sc)
        n, fails, codes, cyc = R.run()
        total += n
        for k, v in codes.items():
            allcodes[k] = allcodes.get(k, 0) + v
        print(f'P6d sim{tag} {label}: {n} Ansichten, {len(fails)} Abweichungen, A-Codes {dict(sorted(codes.items()))}')
        for f in fails[:10]:
            print('FAIL', f)
        ok = ok and not fails

    # demo: alle freien Zellen x 4 Richtungen, Bit 3 aus/an, ohne DBG, ap != 0, origin
    sc_demo = []
    for bc in (False, True):
        for i in free(demo):
            for v in range(4):
                sc_demo.append((f'demo {i}/{v} bc{int(bc)}', dbeview.make_scene(A, demo, i, v, band_cover=bc)))
    for i in free(demo)[::3]:
        for v in range(4):
            sc_demo.append((f'demo ohne DBG {i}/{v}', dbeview.make_scene(A, demo, i, v, dbg=False, bgfill=0x5A)))
    for ap in (0x0123, 0xE200, 0xF800):
        for i in free(demo)[::4]:
            sc_demo.append((f'demo ap {ap:#x} {i}', dbeview.make_scene(A, demo, i, (i + ap) & 3, ap=ap,
                                                                        band_cover=bool(i & 1))))
    g = copy.deepcopy(A.dvg)
    g.origin = 123
    for i in free(demo)[::2]:
        sc = dbeview.make_scene(A, demo, i, i & 3)
        sc.dvg = g
        dbeview.layout_vram(sc)
        sc_demo.append((f'demo origin 123 {i}', sc))
    go('demo', sc_demo)
    # abgrund
    m = abgrund_map()
    go('abgrund', [(f'abgrund {i}/{v}', dbeview.make_scene(A, m, i, v, band_cover=bool(i & 1)))
                   for i in free(m) for v in range(4)])
    # Gang
    gm = corridor_map(dbemap)
    go('gang', [(f'gang {i}/{v}', dbeview.make_scene(A, gm, i, v, band_cover=bool(v & 1)))
                for i in free(gm) for v in range(4)])
    # zufall (ohne Objekte): Zufallskarten (INHALT, Lücken, blockierte Zellen), Bit 3 zufällig, DBG zufällig
    nmaps, nviews = (200, 20) if full else (60, 6)
    for part in range(0, nmaps, 20):
        scs = []
        for k in range(part, min(part + 20, nmaps)):
            base = dbeview.random_scene(k, A, nobj=0, buf=BIGBUF if k % 3 == 0 else dbeview.DEFAULT_BUF)
            rnd = random.Random(k)
            fr = free(base.dmp)
            for j in range(nviews):
                sc = copy.copy(base)
                sc.vram_bases = copy.deepcopy(base.vram_bases)
                sc.pos, sc.dir = rnd.choice(fr), rnd.randrange(4)
                if j == nviews - 1:
                    sc.ap = rnd.choice((0x0040, 0x0123))
                    dbeview.layout_vram(sc)
                scs.append((f'zufall {k}/{j}', sc))
        go(f'zufall {part}-{min(part + 20, nmaps) - 1}', scs)
    # Überlauf: kleine Puffer (A = 2/3, Kürzung, Ränder weggelassen)
    T = dbemap.Tile
    t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((2, 2, 2, 2), 1, 1, 1, 0)]
    rows = ['#######'] * 3 + ['#.....#'] * 4
    gm2 = dbemap.Map('gitter', 7, 7, t, [1 if ch == '#' else 0 for r in rows for ch in r], [0] * 49, [], 6 * 7 + 3, 0, 1)
    ov = [dbeview.make_scene(A, demo, i, v) for i in free(demo)[::2] for v in range(4)]
    ov += [dbeview.make_scene(A, gm2, 6 * 7 + x, v, band_cover=True) for x in range(1, 6) for v in (0, 1, 3)]
    ov += [dbeview.random_scene(k, A, nobj=0) for k in range(300, 312)]
    scs = []
    for n_, sc in enumerate(ov):
        for size in (64, 128, 256, 512, 1024):
            s2 = copy.copy(sc)
            s2.buf = (0x1300, 0x1300 + size)
            scs.append((f'überlauf {n_} {size}', s2))
    go('überlauf', scs)
    # Abbruch über die Eintragszahl (K4): Build mit MAXITEM = 8 gegen die Referenz mit MAXITEM = 8
    if not vcopy:
        orig = dbeview.MAXITEM
        try:
            dbeview.MAXITEM = 8
            R = ViewRunner(dbeview, dbetex)
            R.prg = PRGM
            R.dbg_bytes = dbg_prg[2:]
            for i in free(demo)[::3]:
                for v in range(4):
                    R.add(f'MAXITEM 8 demo {i}/{v}', dbeview.make_scene(A, demo, i, v))
            n, fails, codes, _ = R.run()
        finally:
            dbeview.MAXITEM = orig
        total += n
        print(f'P6d sim MAXITEM = 8: {n} Ansichten, {len(fails)} Abweichungen, A-Codes {dict(sorted(codes.items()))}')
        for f in fails[:10]:
            print('FAIL', f)
        ok = ok and not fails and codes.get(2, 0) > 0
    # zwei Fronten je Zelle (synthetische DVG)
    scs = [(f'2F demo {i}/{v} bc{int(bc)}', dbeview.make_scene(A2, demo, i, v, band_cover=bc))
           for bc in (False, True) for i in free(demo) for v in range(4)]
    scs += [(f'2F zufall {k}', dbeview.random_scene(1000 + k, A2, nobj=0)) for k in range(80)]
    go('zwei Fronten', scs)
    print(f'P6d sim{tag}: {total} Ansichten bytegleich verglichen, A-Codes gesamt {dict(sorted(allcodes.items()))}'
          f' -> {"ok" if ok else "FEHLER"}')

    # Zyklen je VIEW (Differenz zweier Läufe)
    if os.environ.get('DBE_NOCYCLES'):
        return ok
    R = ViewRunner(dbeview, dbetex, vcopy)
    R.dbg_bytes = dbg_prg[2:]
    rnd = random.Random(4)
    samples = {
        'Gang (deckend, einheitlich)': [dbeview.make_scene(A, gm, i, v) for i in free(gm) for v in (1, 3)],
        'demo': [dbeview.make_scene(A, demo, i, v) for i in free(demo) for v in range(4)],
        'zufall (offen, gemischt)': [dbeview.random_scene(k, A, nobj=0) for k in range(40)],
        'zwei Fronten': [dbeview.make_scene(A2, demo, i, v) for i in free(demo)[::2] for v in range(4)],
    }
    for label, scs in samples.items():
        cy = [time_view(R, sc) for sc in scs]
        print(f'P6d Zyklen{tag} {label}: n = {len(cy)}, min {min(cy)}, Mittel {sum(cy) // len(cy)}, max {max(cy)}')
    return ok


# ------------------------------------------------------------------ P6e: VIEW mit Objekten
def tall_sets(dbeview, dvg):
    """Zusätzliche Sprite-Sätze für den Rand-Test: 'hoch' (höher als das Fenster über dem Anker, ragt oben hinaus),
    'links' (Fußpunkt rechts außen: ragt links hinaus), 'rechts' (Fußpunkt links: ragt rechts hinaus; ohne Bild für
    d = 2, Index $FE)."""
    D, stride = dvg.D, dvg.stride
    out = []
    for name, wb, h, fxf in (('hoch', 4, 90, 0.5), ('links', 30, 20, 1.0), ('rechts', 30, 20, 0.0)):
        images = {}
        for d in range(1, D + 1):
            if name == 'rechts' and d == 2:     # kein Bild: Index $FE (P5b 6.3, Objekt entfällt)
                continue
            w = max(2, wb >> (d - 1))
            hh = max(3, h >> (d - 1)) if name != 'hoch' else h
            pix = dbeview.sprite_pixels('blob', 2 * w, hh, d & 3, 0)
            images[(0, 0, d)] = (pix, min(w - 1, int(w * fxf)), hh - 1)
        prg, vram = dbeview.make_s2(images, D, 1, 1, stride)
        out.append(dbeview.read_s2(prg, vram))
    # 'gitter': breit, je Zeile versetzt Lauf (3 Byte), halbes Byte (Typ 8) und Lücke, keine Kerne: lange Listen
    # (über 300 Byte) mit links/rechts beschnittenen Läufen an allen Stellen relativ zum Nachziehen von ZP1 (Y >= $FC)
    images = {}
    for d in range(1, D + 1):
        w, hh = max(5, 26 >> (d - 1)), max(3, 12 >> (d - 1))
        pix = [[None] * (2 * w) for _ in range(hh)]
        for r in range(hh):
            for x in range(w):
                m_ = (x + r) % 6
                if m_ not in (0, 4):
                    pix[r][2 * x] = 9 + (r & 3)
                    if m_ > 1:
                        pix[r][2 * x + 1] = 5
        images[(0, 0, d)] = (pix, w // 2, hh - 1)
    prg, vram = dbeview.make_s2(images, D, 1, 1, stride)
    out.append(dbeview.read_s2(prg, vram))
    return out


def test_p6e(vcopy=False):
    """VIEW mit Objekten und Gegenständen (5.8), Beschneiden mit VMS-Typ 3, OBJVIS: bytegleich mit dbeview.view."""
    sys.path.insert(0, TOOLS)
    sys.path.insert(0, os.path.join(ROOT, 'test', 'tools'))
    import copy, random
    import dbemap, dbetex, dbeview
    dbeview.dbemap = dbemap
    from test_dbeview import open_room, mk_map
    full = bool(os.environ.get('DBEVIEW_FULL'))
    tmp = tempfile.TemporaryDirectory()
    A = dbeview.build_demo_assets(tmp.name)
    dbg_prg, _, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(tmp.name, 'bg.toml')))
    demo = dbemap.load_toml(DEMO_MAP)
    extra = tall_sets(dbeview, A.dvg)
    T = dbemap.Tile
    WEG, DECK, INH = dbeview.T_WEG, dbeview.T_DECKEND, dbeview.T_INHALT
    tag = ' (VMS_COPY)' if vcopy else ''
    ok, total, allcodes = True, 0, {}
    stats = {'obj': 0, 'vis': 0}

    def free(m):
        return [i for i, c in enumerate(m.cells) if not m.tiles[c].flags & WEG]

    def go(label, scenes, prg=None, maxitem=None):
        nonlocal ok, total
        R = ViewRunner(dbeview, dbetex, vcopy)
        if prg:
            R.prg = prg
        R.dbg_bytes = dbg_prg[2:]
        orig = dbeview.MAXITEM
        try:
            if maxitem:
                dbeview.MAXITEM = maxitem
            for sc_ in scenes:
                name, sc = sc_[:2]
                R.add(name, sc, objs=True, objn=sc_[2] if len(sc_) > 2 else None)
                res = R.expect[-1][1]
                stats['obj'] += len(sc.objects)
                stats['vis'] += bin(res.objvis).count('1')
        finally:
            dbeview.MAXITEM = orig
        n, fails, codes, _ = R.run()
        total += n
        for k, v in codes.items():
            allcodes[k] = allcodes.get(k, 0) + v
        print(f'P6e sim{tag} {label}: {n} Ansichten, {len(fails)} Abweichungen, A-Codes {dict(sorted(codes.items()))}')
        for f in fails[:10]:
            print('FAIL', f)
        ok = ok and not fails

    def with_extra(sc):
        sc.s2 = [sc.s2[0], None] + list(sc.s2[2:4]) + extra     # Satz 1 frei (Platz); 4-7: hoch, links, rechts, gitter
        return dbeview.layout_vram(sc)

    items = [0, 2, 3, 2] + [0] * 60
    # demo: alle freien Zellen x 4 Richtungen mit 0, 1 und 5 Objekten (fester Seed), Gegenstände, ITEMPH
    rnd = random.Random(2025)
    scs = []
    for n in (0, 1, 5):
        for i in free(demo):
            for v in range(4):
                objs = dbeview.random_objects(rnd, demo, i, v, n)
                scs.append((f'demo {n} Obj {i}/{v}', dbeview.make_scene(A, demo, i, v, objs, items, (i + v) & 3,
                                                                        band_cover=bool((i + v) & 1))))
    go('demo 0/1/5 Objekte', scs)
    # rand: Sprites an den Fensterrändern (s = -2 ... 2, d = 1 ... 3, alle q), oben hinaus, links/rechts hinaus
    m = open_room()
    cx, cy = m.start % m.width, m.start // m.width
    scs = []
    for setn in (0, 2, 3, 4, 5, 6, 7):
        for d in (1, 2, 3):
            for s_ in (-2, -1, 0, 1, 2):
                for q in range(5):
                    o = dbeview.Obj((cy - d) * m.width + cx + s_, setn, 2, 1, q)
                    sc = with_extra(dbeview.make_scene(A, m, objects=[o], buf=BIGBUF, band_cover=bool(q & 1)))
                    scs.append((f'rand Satz {setn} d {d} s {s_} q {q}', sc))
    go('rand', scs)
    # rand hinter Wänden: Objekte teilweise verdeckt
    t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, WEG | DECK, 0)]
    rows = ["#########", "#.......#", "#.#####.#", "#.#...#.#", "#.#...#.#", "#...#...#", "#########"]
    mw = mk_map(rows, t, {"#": 1, ".": 0}, outside=1, start=5 * 9 + 2, direction=0)
    scs = []
    for i in free(mw):
        for v in range(4):
            for setn in (0, 3, 5):
                objs = [dbeview.Obj(j, setn, (j + v) & 3, j & 1, q) for j in range(len(mw.cells)) for q in (0, 4)
                        if not mw.tiles[mw.cells[j]].flags & WEG and (j + q) % 3 == 0]
                scs.append((f'verdeckt {i}/{v} Satz {setn}', with_extra(dbeview.make_scene(A, mw, i, v, objs[:16]))))
    go('rand verdeckt', scs)
    # INHALT: Türen/Gitter mit Flag INHALT (deckend und nicht), Objekte und Gegenstände darauf
    t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, WEG | DECK, 0), T((2, 0, 2, 0), 1, 1, INH, 0),
         T((3, 3, 3, 3), 1, 2, INH | DECK, 0), T((2, 2, 2, 2), 1, 1, WEG, 0)]
    rows = ["#########", "#.D.G...#", "#.#E#.#.#", "#.......#", "#.G.D.E.#", "#########"]
    content = [0] * (9 * 6)
    mi = mk_map(rows, t, {"#": 1, ".": 0, "D": 2, "E": 3, "G": 4}, outside=1, start=3 * 9 + 1, direction=1)
    for j, c in enumerate(mi.cells):
        if c in (2, 3):
            mi.content[j] = 1 + (j % 3)
    scs = []
    for i in free(mi):
        for v in range(4):
            objs = [dbeview.Obj(j, (j + v) % 4, v, j & 1, (j + v) % 6) for j, c in enumerate(mi.cells) if c in (2, 3, 4)]
            scs.append((f'INHALT {i}/{v}', dbeview.make_scene(A, mi, i, v, objs[:16], items, v,
                                                               band_cover=bool(i & 1))))
    go('INHALT', scs)
    # zwei Fronten und zwei Objektplätze je Zelle (k_ob < k_oe, synthetische DVG): demo und zufall mit Objekten
    A3 = dbeview.double_fronts(A, objs=True)
    rnd = random.Random(33)
    scs = [(f'2F2O demo {i}/{v}', dbeview.make_scene(A3, demo, i, v, dbeview.random_objects(rnd, demo, i, v, 6), items,
                                                     v, band_cover=bool(i & 1)))
           for i in free(demo)[::2] for v in range(4)]
    scs += [(f'2F2O zufall {k}', dbeview.random_scene(2000 + k, A3, nobj=12)) for k in range(40)]
    go('zwei Fronten, zwei Objektplätze', scs)
    # zufall mit Objekten (bis 16, Bit 6/7, Gegenstände, ITEMPH), OBJN > 16
    nmaps, nviews = (200, 20) if full else (60, 6)
    for part in range(0, nmaps, 20):
        scs = []
        for k in range(part, min(part + 20, nmaps)):
            base = dbeview.random_scene(k, A, buf=BIGBUF if k % 3 == 0 else dbeview.DEFAULT_BUF)
            rnd = random.Random(k)
            fr = free(base.dmp)
            for j in range(nviews):
                sc = copy.copy(base)
                sc.vram_bases = copy.deepcopy(base.vram_bases)
                sc.pos, sc.dir = rnd.choice(fr), rnd.randrange(4)
                sc.objects = dbeview.random_objects(rnd, sc.dmp, sc.pos, sc.dir, rnd.randint(0, 16))
                sc.itemph = rnd.randrange(4)
                if j == nviews - 1:
                    sc.ap = rnd.choice((0x0040, 0x0123))
                    dbeview.layout_vram(sc)
                if j == 1:                  # OBJN = 20: nur die ersten 16 zählen
                    sc.objects = dbeview.random_objects(rnd, sc.dmp, sc.pos, sc.dir, 20)
                    scs.append((f'zufall {k}/{j} OBJN 20', sc))
                else:
                    scs.append((f'zufall {k}/{j}', sc))
        go(f'zufall {part}-{min(part + 20, nmaps) - 1}', scs)
    # Überlauf mit Objekten: kleine Puffer (A = 2/3)
    rnd = random.Random(77)
    ov = []
    for i in free(demo)[::2]:
        for v in range(4):
            ov.append(dbeview.make_scene(A, demo, i, v, dbeview.random_objects(rnd, demo, i, v, 6), items, 1))
    ov += [dbeview.random_scene(k, A, nobj=12) for k in range(300, 312)]
    scs = []
    for n_, sc in enumerate(ov):
        for size in (64, 128, 256, 512, 1024):
            s2 = copy.copy(sc)
            s2.buf = (0x1300, 0x1300 + size)
            scs.append((f'überlauf {n_} {size}', s2))
    go('überlauf', scs)
    # MAXITEM = 8 mit Objekten (leere Sprite-Einträge zählen nicht)
    if not vcopy:
        scs = [(f'MAXITEM 8 {k}', dbeview.random_scene(500 + k, A, nobj=16, buf=BIGBUF)) for k in range(30)]
        go('MAXITEM = 8', scs, prg=PRGM, maxitem=8)
    print(f'P6e sim{tag}: {total} Ansichten bytegleich verglichen, A-Codes gesamt {dict(sorted(allcodes.items()))},'
          f' Objekte {stats["obj"]}, davon ausgegeben (OBJVIS) {stats["vis"]} -> {"ok" if ok else "FEHLER"}')
    if os.environ.get('DBE_NOCYCLES') or vcopy:
        return ok
    # Zyklen: je VIEW mit Objekten, und je Objekt (Differenz zur Ansicht ohne Objekte)
    R = ViewRunner(dbeview, dbetex, vcopy)
    R.dbg_bytes = dbg_prg[2:]

    def tv(sc):
        R.reset()
        R.setup(sc)
        base = bytes(R.scene.b)
        a = Scene(); a.b = bytearray(base); a.call(4, p=(sc.ap, 0, 0, 0), quiet=True, **R.objargs(sc))
        b = Scene(); b.b = bytearray(base); b.call(7, p=(sc.ap, 0, 0, 0), quiet=True, **R.objargs(sc))
        return run(a, R.prg).cycles - run(b, R.prg).cycles
    rnd = random.Random(5)
    for n in (1, 5):
        cy = []
        for i in free(demo):
            for v in range(4):
                sc = dbeview.make_scene(A, demo, i, v, dbeview.random_objects(rnd, demo, i, v, n), items, 0)
                cy.append(tv(sc))
        print(f'P6e Zyklen demo {n} Objekte: n = {len(cy)}, min {min(cy)}, Mittel {sum(cy) // len(cy)}, max {max(cy)}')
    cy = [tv(dbeview.random_scene(k, A)) for k in range(40)]
    print(f'P6e Zyklen zufall (0-16 Objekte): n = {len(cy)}, min {min(cy)}, Mittel {sum(cy) // len(cy)}, max {max(cy)}')
    # je Objekt: offener Raum, ein Objekt in (d, s) mit Satz; Differenz zur leeren Ansicht
    for label, setn, cases in (('unbeschnitten', 0, [(1, 0, 4), (2, 0, 2), (3, 0, 4), (2, 1, 1)]),
                               ('beschnitten (Rand)', 3, [(1, -1, 0), (1, 1, 4), (2, -2, 0), (2, 2, 1)]),
                               ('beschnitten (oben)', 4, [(1, 0, 4), (2, 0, 4), (3, 0, 4)])):
        per = []
        for d, s_, q in cases:
            o = dbeview.Obj((cy0 := m.start // m.width - d) * m.width + m.start % m.width + s_, setn, 2, 0, q)
            sc1 = with_extra(dbeview.make_scene(A, m, objects=[o], buf=BIGBUF))
            sc0 = with_extra(dbeview.make_scene(A, m, objects=[], buf=BIGBUF))
            res = dbeview.view(sc1)
            nbytes = len(res.vms)
            per.append((tv(sc1) - tv(sc0), nbytes, res.objvis))
        print(f'P6e Zyklen je Objekt {label}: ' + ', '.join(f'{c} ({b} VMS-Byte{"" if v else ", unsichtbar"})'
                                                           for c, b, v in per))
    return ok


# ------------------------------------------------------------------ P6f: MOVE, Automap, Zyklen
AUTO_ADDR = 0x3800                  # Arbeitskopie der Karte (2 W H Byte) in den Automap-Tests


def move_maps(dbemap, dbeview):
    """Karten für den MOVE-Test: (Name, Map). Mit Ereignissen (mehrere je Zelle, Indizes > 255), Türen, Objekten
    nur in der Liste; Randfälle W = 255 (px + 1 = $FF), W = 1, H = 1."""
    import random
    from test_dbeview import abgrund_map
    rnd = random.Random(61)
    T = dbemap.Tile
    out = [('demo', dbemap.load_toml(DEMO_MAP)), ('abgrund', abgrund_map())]
    for k in range(6):
        out.append((f'zufall {k}', dbeview.random_map(rnd, rnd.randint(3, 20), rnd.randint(3, 20))))
    t = [T((0, 0, 0, 0), 1, 1, 0, 0), T((1, 1, 1, 1), 0, 0, 1 | 4, 0), T((2, 2, 2, 2), 1, 1, 1 | 8, 0)]
    for name, w, h in (('breit 255', 255, 4), ('schmal 1', 1, 40), ('flach 40', 40, 1), ('hoch 4', 4, 255),
                       ('1x1', 1, 1)):
        cells = [rnd.choice((0, 0, 0, 1, 2)) for _ in range(w * h)]
        out.append((name, dbemap.Map(name, w, h, t, cells, [rnd.randrange(64) | rnd.choice((0, 0x40, 0x80)) for _ in cells],
                                     [], 0, 0, rnd.choice((0, 1)))))
    for name, m in out:
        n = m.width * m.height
        if name != 'demo':                                   # demo behält ihre drei Ereignisse
            nev = 600 if name == 'breit 255' else (rnd.choice((0, 3, 40, 300)) if n > 40 else 5)   # Index > 255
            evs = sorted({(rnd.randrange(n), rnd.choice((1, 2, 3, 4, 200)), rnd.randrange(256)) for _ in range(nev)})
            m.events = [dbemap.Event(*e) for e in evs]
        m.start = next((i for i, c in enumerate(m.cells) if not m.tiles[c].flags & 1), 0)
        if m.tiles[m.cells[m.start]].flags & 1:
            m.cells[m.start] = 0
        dbemap.validate(m)
    return out


def test_p6f_move():
    """MOVE (3.4): alle Zellen x Richtungen x Aktionen gegen tools/dbemove.py; Zufallsketten (Zustand pos/vdir/px/py
    zwischen den Aufrufen), Objekte mit Bit 6/7 auf den Nachbarzellen, Fehlerfälle."""
    sys.path.insert(0, TOOLS)
    sys.path.insert(0, os.path.join(ROOT, 'test', 'tools'))
    import random
    import dbemap, dbeview, dbemove
    dbeview.dbemap = dbemap
    L = labels()
    pos_a, nst = L['pos'], 7
    ok, total, fails, xs = True, 0, [], {0: 0, 1: 0, 2: 0}
    rnd = random.Random(6)

    def nobjs(m, cell, v):
        """Objekte um die Zelle: auf den Nachbarzellen (auch blockierend), mit Bit 6/7, dazu zufällige"""
        w = m.width
        near = [c for c in (cell - w, cell + w, cell - 1, cell + 1) if 0 <= c < w * m.height]
        n = rnd.choice((0, 0, 1, 2, 5, 16))
        objs = []
        for _ in range(n):
            c = rnd.choice(near) if near and rnd.random() < 0.7 else rnd.randrange(w * m.height)
            objs.append(dbeview.Obj(c, rnd.randrange(3), rnd.choice((0, 1, 2, 3, 0xFF)), rnd.randrange(4), rnd.randrange(8),
                                    rnd.random() < 0.25, rnd.random() < 0.3))
        return objs

    for name, m in move_maps(dbemap, dbeview):
        w, h = m.width, m.height
        n = w * h
        sc = Scene()
        sc.call(0)
        dmp = dbemap.to_dmp(m)[2:]
        sc.seg(P6D_ADDR['dmp'], dmp)
        sc.call(1, p=(P6D_ADDR['dmp'], 0, 0, 0))
        exp = []                                            # (Referenz, Aktion, Zelle, Richtung, Objekte)
        cells = range(n) if n <= 60 else sorted(rnd.sample(range(n), 60)) + [0, n - 1, w - 1, n - w]
        for cell in cells:
            for v in range(4):
                for act in range(7):
                    objs = nobjs(m, cell, v)
                    sc.call(2, v, p=(cell, 0, 0, 0))
                    nn = len(objs) if len(objs) < 16 or rnd.random() < 0.7 else 20      # OBJN > 16: nur 16 gelesen
                    sc.call(3, act, objn=nn, objl=b''.join(
                        struct.pack('<HBBBB', o.cell, o.set, o.dir, o.phase, o.byte5()) for o in objs))
                    sc.dump(pos_a, 7)
                    exp.append((dbemove.move(m, cell, v, objs, act, nn), cell, v, act))
        # Zufallskette: MOVE ohne SETPOS dazwischen, mit festen Objekten (Bit 6/7 gemischt)
        cell, v = m.start, m.direction
        sc.call(2, v, p=(cell, 0, 0, 0))
        objs = nobjs(m, cell, v) + nobjs(m, rnd.randrange(n), 0)
        objs = objs[:16]
        ob = b''.join(struct.pack('<HBBBB', o.cell, o.set, o.dir, o.phase, o.byte5()) for o in objs)
        for _ in range(300):
            act = rnd.choice((0, 0, 0, 1, 2, 3, 4, 5, 6))
            r = dbemove.move(m, cell, v, objs, act)
            sc.call(3, act, objn=len(objs), objl=ob)
            sc.dump(pos_a, 7)
            exp.append((r, cell, v, act))
            cell, v = r.pos, r.dir
        r = run(sc)
        # Auswertung: Aufrufreihenfolge = SETPOS, MOVE, Dump je Eintrag (Ketten: erst SETPOS)
        items = list(r.items)[2:]
        k = 0
        for ei, (ref, c0, v0, act) in enumerate(exp):
            if ei < len(exp) - 300:
                it_pos = items[k]; it_mv = items[k + 1]; dump = items[k + 2][1]; k += 3
            else:
                if ei == len(exp) - 300:
                    k += 1                                  # SETPOS der Kette
                it_mv = items[k]; dump = items[k + 1][1]; k += 2
            want = (ref.a, ref.x, ref.y, ref.p0, ref.p1, ref.p2)
            c = it_mv
            have = (c.a, c.x, c.y, c.p[0], c.p[1], c.p[2])
            pos_l = dump[0] | dump[1] << 8
            st = (pos_l, dump[2], dump[5], dump[6])
            wst = (ref.pos, ref.dir, ref.pos % w, ref.pos // w)
            total += 1
            xs[ref.x] = xs.get(ref.x, 0) + 1
            if have != want or st != wst:
                fails.append(f'{name} Zelle {c0} v {v0} Aktion {act}: sim {have} {st} <> Referenz {want} {wst}')
        print(f'P6f MOVE {name} ({w}x{h}, {len(m.events)} Ereignisse): {len(exp)} Aufrufe, {len(fails)} Abweichungen so weit')
    print(f'P6f MOVE: {total} Aufrufe verglichen (X = 0: {xs[0]}, 1: {xs[1]}, 2: {xs[2]})')
    # Fehlerfälle: X >= 7, MOVE ohne MAPINIT
    sc = Scene()
    sc.call(0)
    sc.call(3, 0)
    m = dbemap.load_toml(DEMO_MAP)
    sc.seg(P6D_ADDR['dmp'], dbemap.to_dmp(m)[2:])
    sc.call(1, p=(P6D_ADDR['dmp'], 0, 0, 0))
    sc.call(3, 7)
    sc.call(3, 255)
    sc.dump(pos_a, 7)
    r = run(sc)
    c = [i for i in r.items if isinstance(i, Call)]
    exp_ = [(5, 0, 0), (0, 7, 5), (6, 0, 0), (6, 0, 0)]       # MOVE ohne MAPINIT, MAPINIT (W, H), X = 7, X = 255
    for cc, (a, x, y) in zip(c[1:], exp_):
        if (cc.a, cc.x, cc.y) != (a, x, y):
            fails.append(f'Fehlerfall: A/X/Y {(cc.a, cc.x, cc.y)} <> {(a, x, y)}')
    d = r.items[-1][1]
    if (d[0] | d[1] << 8, d[2]) != (m.start, m.direction):
        fails.append('Fehlerfall: Zustand verändert')
    for f in fails[:10]:
        print('FAIL', f)
    ok = not fails
    print(f'P6f MOVE -> {"ok" if ok else "FEHLER"}')
    return ok


def test_p6f_auto():
    """Automap-Bit 6 in VIEW: Arbeitskopie der Inhaltsebene nach jeder Ansicht = dbeview (Scene.automap)."""
    sys.path.insert(0, TOOLS)
    sys.path.insert(0, os.path.join(ROOT, 'test', 'tools'))
    import copy, random
    import dbemap, dbetex, dbeview
    dbeview.dbemap = dbemap
    from test_dbeview import abgrund_map, open_room
    full = bool(os.environ.get('DBEVIEW_FULL'))
    tmp = tempfile.TemporaryDirectory()
    A = dbeview.build_demo_assets(tmp.name)
    A2 = dbeview.double_fronts(A)
    dbg_prg, _, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(tmp.name, 'bg.toml')))
    demo = dbemap.load_toml(DEMO_MAP)
    ok, total, marked = True, 0, [0, 0]

    def free(m):
        return [i for i, c in enumerate(m.cells) if not m.tiles[c].flags & dbeview.T_WEG]

    class AutoRunner(ViewRunner):
        mapx, mapp1 = 1, AUTO_ADDR

        def __init__(self, vcopy=False):
            super().__init__(dbeview, dbetex, vcopy)
            self.dbg_bytes = dbg_prg[2:]
            self.ref, self.refkey, self.dumps = None, None, []

        def add(self, name, sc):
            sc.objects, sc.itemtab = [], [0] * 64
            sc.vms_bank1, sc.dts_addr = self.bank1, P6D_ADDR['dts']
            self.setup(sc)
            key = dbeview.dbemap.to_dmp(sc.dmp)
            if self.refkey != key:                          # neue Karte: MAPINIT hat die Kopie frisch angelegt
                self.refkey, self.ref = key, copy.deepcopy(sc.dmp)
            sc.s2_addr = tuple(self.s2_addr(ss) if ss is not None else 0 for ss in sc.s2)
            sc2 = copy.copy(sc)
            sc2.dmp, sc2.automap = self.ref, True
            before = bytes(self.ref.content)
            self._call(4, p=(sc.ap, 0, 0, 0), want=(name, self.dv.view(sc2)))
            n = self.ref.width * self.ref.height
            self.scene.dump(AUTO_ADDR, 2 * n)
            self.dumps.append((name, bytes(self.ref.cells) + bytes(self.ref.content)))
            marked[0] += sum(1 for a, b in zip(before, self.ref.content) if a != b)
            marked[1] += 1

    def go(label, scenes, runs=1):
        nonlocal ok, total
        R = AutoRunner()
        for name, sc in scenes:
            R.add(name, sc)
        n, fails, codes, _ = R.run()
        dumps = [i for i in R.last_items if not isinstance(i, Call)]
        for (name, want), (addr, got) in zip(R.dumps, dumps):
            if got != want:
                bad = [i for i in range(len(got)) if got[i] != want[i]][:4]
                fails.append(f'{name}: Arbeitskopie weicht ab (Offsets {bad})')
        total += n
        print(f'P6f Automap {label}: {n} Ansichten, {len(fails)} Abweichungen, A-Codes {dict(sorted(codes.items()))}')
        for f in fails[:10]:
            print('FAIL', f)
        ok = ok and not fails

    # Ketten über dieselbe Karte (Marken sammeln sich an): demo, abgrund, open_room, Gang
    rnd = random.Random(8)
    gm = corridor_map(dbemap)
    for label, m in (('demo', demo), ('abgrund', abgrund_map()), ('raum', open_room()), ('gang', gm)):
        fr = free(m)
        scs = []
        for bc in (False, True):
            for i in rnd.sample(fr, len(fr)):
                for v in range(4):
                    scs.append((f'{label} {i}/{v} bc{int(bc)}', dbeview.make_scene(A, m, i, v, band_cover=bc)))
        go(label, scs)
    # zufall (INHALT, Lücken, blockierte Zellen), zwei Fronten, kleine Puffer (Abbruch: Marken bis dahin)
    nmaps, nv = (60, 8) if full else (24, 6)
    scs = []
    for k in range(nmaps):
        base = dbeview.random_scene(k, A, nobj=0)
        rr = random.Random(k)
        for j in range(nv):
            sc = copy.copy(base)
            sc.vram_bases = copy.deepcopy(base.vram_bases)
            sc.pos, sc.dir = rr.choice(free(base.dmp)), rr.randrange(4)
            if j == nv - 1:
                sc.buf = (0x1300, 0x1300 + rr.choice((64, 128, 256)))
            scs.append((f'zufall {k}/{j}', sc))
    go('zufall', scs)
    scs = [(f'2F demo {i}/{v}', dbeview.make_scene(A2, demo, i, v)) for i in free(demo) for v in range(4)]
    scs += [(f'2F zufall {k}', dbeview.random_scene(1000 + k, A2, nobj=0)) for k in range(20)]
    go('zwei Fronten', scs)
    # ohne Arbeitskopie (X = 1, P1 = 0) und mit X = 0: keine Marken, DMP unverändert
    for label, mx in (('X=1 ohne Kopie', 1), ('X=0 mit Kopie', 0)):
        R = ViewRunner(dbeview, dbetex)
        R.dbg_bytes = dbg_prg[2:]
        R.mapx, R.mapp1 = mx, (0 if mx else AUTO_ADDR)
        for i in free(demo):
            for v in range(4):
                R.add(f'{label} {i}/{v}', dbeview.make_scene(A, demo, i, v))
        R.scene.dump(P6D_ADDR['dmp'], len(dbemap.to_dmp(demo)) - 2)
        n, fails, codes, _ = R.run()
        got = [i for i in R.last_items if not isinstance(i, Call)][-1][1]
        if got != dbemap.to_dmp(demo)[2:]:
            fails.append('DMP verändert')
        print(f'P6f Automap {label}: {n} Ansichten, {len(fails)} Abweichungen')
        ok = ok and not fails
        for f in fails[:5]:
            print('FAIL', f)
    print(f'P6f Automap: {total} Ansichten, {marked[0]} Zellen markiert (über {marked[1]} Ansichten) -> '
          f'{"ok" if ok and marked[0] else "FEHLER"}')
    return ok and marked[0] > 0


def test_p6f_cycles():
    """Zyklen: MOVE je Fall (Lauf mit MOVE minus Lauf mit F = 7) und VIEW ohne/mit Automap."""
    sys.path.insert(0, TOOLS)
    sys.path.insert(0, os.path.join(ROOT, 'test', 'tools'))
    import random
    import dbemap, dbetex, dbeview, dbemove
    dbeview.dbemap = dbemap
    tmp = tempfile.TemporaryDirectory()
    A = dbeview.build_demo_assets(tmp.name)
    dbg_prg, _, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(tmp.name, 'bg.toml')))
    demo = dbemap.load_toml(DEMO_MAP)

    def mv_cycles(m, cell, v, act, objs=()):
        pre = Scene()
        pre.call(0)
        pre.seg(P6D_ADDR['dmp'], dbemap.to_dmp(m)[2:])
        pre.call(1, p=(P6D_ADDR['dmp'], 0, 0, 0))
        pre.call(2, v, p=(cell, 0, 0, 0))
        base = bytes(pre.b)
        ol = b''.join(struct.pack('<HBBBB', o.cell, o.set, o.dir, o.phase, o.byte5()) for o in objs)
        a = Scene(); a.b = bytearray(base); a.call(3, act, quiet=True, objn=len(objs), objl=ol)
        b = Scene(); b.b = bytearray(base); b.call(7, act, quiet=True, objn=len(objs), objl=ol)
        return run(a).cycles - run(b).cycles

    cases = {}
    for cell in range(demo.width * demo.height):
        for v in range(4):
            for act in range(7):
                r = dbemove.move(demo, cell, v, [], act)
                kind = 'drehen' if act >= 4 else ('Schritt ok' if r.x == 0 else
                                                  ('Schritt Karte/WEG' if r.x == 1 else 'Objekt'))
                cases.setdefault(kind, []).append((cell, v, act))
    rnd = random.Random(3)
    for kind, lst in sorted(cases.items()):
        cy = [mv_cycles(demo, *c) for c in rnd.sample(lst, min(len(lst), 12))]
        print(f'P6f Zyklen MOVE demo {kind}: n = {len(cy)}, min {min(cy)}, Mittel {sum(cy) // len(cy)}, max {max(cy)}')
    # Objekt auf der Zielzelle: 16 Objekte, das blockierende zuletzt (Worst Case der Schleife)
    cell = demo.start
    tgt = cell + 1
    objs = [dbeview.Obj(0, 0, 0, 0, 4, False, False)] * 15 + [dbeview.Obj(tgt, 0, 0, 0, 4)]
    print(f'P6f Zyklen MOVE Objekt, 16 Objekte (blockierend zuletzt): {mv_cycles(demo, cell, 1, 0, objs)}')
    # Ereignisse: Suche über die ganze Liste (keine Übereinstimmung), 600 Ereignisse
    T = dbemap.Tile
    t = [T((0, 0, 0, 0), 1, 1, 0, 0)]
    for ne in (0, 3, 100, 600):
        m = dbemap.Map('ev', 40, 30, t, [0] * 1200, [0] * 1200, [dbemap.Event(c, 4, 1) for c in range(100, 100 + ne)],
                       0, 0, 0)
        print(f'P6f Zyklen MOVE Drehen mit {ne} Ereignissen (keines an der Position): {mv_cycles(m, 5, 0, 4)}')
    m.events = [dbemap.Event(c, 4, 1) for c in range(1, 601)]
    print(f'P6f Zyklen MOVE Drehen, Ereignis an Position 600 (letzte): {mv_cycles(m, 600, 0, 4)}')
    # VIEW: Automap aus / an
    for label, mx in (('ohne Automap', 0), ('mit Automap', 1)):
        R = ViewRunner(dbeview, dbetex)
        R.dbg_bytes = dbg_prg[2:]
        R.mapx, R.mapp1 = mx, (AUTO_ADDR if mx else 0)
        gm = corridor_map(dbemap)
        for nm, m in (('Gang', gm), ('demo', demo)):
            fr = [i for i, c in enumerate(m.cells) if not m.tiles[c].flags & dbeview.T_WEG]
            scs = [dbeview.make_scene(A, m, i, v) for i in fr for v in ((1, 3) if m is gm else range(4))]
            cy = [time_view(R, sc) for sc in scs]
            print(f'P6f Zyklen VIEW {nm} {label}: n = {len(cy)}, min {min(cy)}, Mittel {sum(cy) // len(cy)}, max {max(cy)}')
        cy = [time_view(R, dbeview.random_scene(k, A, nobj=0)) for k in range(40)]
        print(f'P6f Zyklen VIEW zufall {label}: n = {len(cy)}, min {min(cy)}, Mittel {sum(cy) // len(cy)}, max {max(cy)}')
    return True


def main():
    build()
    if '--build' in sys.argv:
        return 0
    ok = test_p6a()
    ok = test_p6c() and ok
    ok = test_geomcheck() and ok
    ok = test_p6d() and ok
    ok = test_p6d(vcopy=True) and ok
    ok = test_p6e() and ok
    ok = test_p6e(vcopy=True) and ok
    ok = test_p6f_move() and ok
    ok = test_p6f_auto() and ok
    if not os.environ.get('DBE_NOCYCLES'):
        ok = test_p6f_cycles() and ok
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
