#!/usr/bin/env python3
"""sim65-Gerüst für die Lib (docs/specs/P6-engine.md 9.2).

Aufruf:  run_sim.py            baut den Harness und führt die Tests der Teilschritte aus (P6a, P6c)
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

    def call(self, f, x=0, y=0, p=(0, 0, 0, 0), itemph=0, objn=0, objl=b''):
        self.b += struct.pack('<BBBB4HBBB', 2, f, x, y, *p, itemph, objn, len(objl)) + bytes(objl)
        return self

    def dump(self, addr, n):
        self.b += struct.pack('<BHH', 3, addr, n)
        return self

    def encode(self):
        return bytes(self.b) + b'\0'


def build():
    os.makedirs(OUT, exist_ok=True)
    src = [os.path.join(HERE, 'viewsim.c'), os.path.join(HERE, 'glue.s'), os.path.join(ROOT, 'engine', 'lib.s')]
    subprocess.run(['cl65', '-t', 'sim6502', '-C', os.path.join(HERE, 'sim.cfg'), '-O', '--asm-define', 'SIM',
                    '--asm-include-dir', os.path.join(ROOT, 'engine'), '-Ln', LBL,
                    '-m', os.path.join(OUT, 'viewsim.map'), '-o', PRG] + src, check=True, cwd=OUT)
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


def run(scene):
    with tempfile.TemporaryDirectory() as td:
        sc, rs = os.path.join(td, 'scene'), os.path.join(td, 'result')
        open(sc, 'wb').write(scene.encode())
        r = subprocess.run(['sim65', '-c', PRG, sc, rs], capture_output=True, text=True)
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


VCL_LEN = {0: 1, 2: 11, 3: 13, 4: 7, 5: 11, 12: 7}      # P6 Abschnitt 6


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
    s.call(15, p=(0x0200, 0x0240, 0, 0)).dump(bss, n)                       # genau 64 Byte ok
    s.call(15, p=(0x1000, 0x103F, 0, 0)).dump(bss, n)                       # 63 Byte: 6, unverändert
    s.call(15, p=(0x01FF, 0x1000, 0, 0)).dump(bss, n)                       # Anfang < $0200
    s.call(15, p=(0x1000, 0x1C01, 0, 0)).dump(bss, n)                       # Ende > $1C00
    s.call(15, p=(0x1400, 0x1000, 0, 0)).dump(bss, n)                       # Ende < Anfang
    s.call(15, p=(0x1000, 0x1000, 0, 0)).dump(bss, n)                       # Länge 0
    s.call(15, p=(0x1200, 0x1C00, 0, 0)).dump(bss, n)                       # ok, 3584 Byte
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
        check(f'F={f} E_NOTIMPL', (c.a, c.x, c.y) == (255, 0, 0), str((c.a, c.x, c.y)))

    def bufcase(name, want_a, want_buf):
        c = nxt(); d = nxt()[1]
        check(f'BUFSET {name} A', c.a == want_a, f'{c.a} <> {want_a}')
        got = (var(d, 'buf_b0'), var(d, 'buf_b1'))
        check(f'BUFSET {name} Puffer', got == want_buf, f'{got[0]:04x},{got[1]:04x} <> ' + str(want_buf))
        return want_buf if want_a == 0 else None

    cur = (0x1300, 0x1C00)
    for name, a, newbuf in (('Standard', 0, (0x1300, 0x1C00)), ('64 Byte', 0, (0x0200, 0x0240)),
                            ('63 Byte', 6, None), ('Anfang < $0200', 6, None), ('Ende > $1C00', 6, None),
                            ('Ende < Anfang', 6, None), ('Länge 0', 6, None), ('3584 Byte', 0, (0x1200, 0x1C00))):
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
        d[0:2] = b'\0\0'
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
    ADDR = {'dmp': 0x5000, 'dvg': 0xE800, 'wall': 0x9000, 'floor': 0xB400, 'ceil': 0xF000, 'dbg': 0xFE00}
    S2A = [0x7000, 0x8100, 0x8300, 0x8800]
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
        s.seg(ADDR['dmp'], dmp)

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
            ('NE 0', (7, 0))]
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
                    '<HHHH', base_addr, base_addr + u16(src, 16), base_addr + u16(src, 18), base_addr + u16(src, 20))
            return [] if r == want else [f'Satz {k}: {r.hex()} <> {want.hex()}']
        return chk
    for k in range(3):
        S.call(f'TEXSET Art {k}', 13, k, p=(TD[k], VR[k], 0, 0), a=0, rx=0, ry=0,
               check=rec_check(k, dts[k], TD[k], VR[k], 'dts'))
    S.call('TEXSET Art falsch', 13, 1, p=(TD[0], 0, 0, 0), a=1, same=True)
    terr = [('Magic', 1, (1, ord('X'))), ('Version', 1, (2, 2)), ('NST 0', 1, (9, 0)),
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
    for nm, e, a in (('Magic', (1, ord('X')), 1), ('Version', (2, 9), 1), ('VW', (3, dbg[3] + 1), 4),
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
    S.call('SPRITESET ID 0', 9, 4, p=(HDR, 0x5000, 0, 0), pre=[(HDR, patched(s2[3], (4, 0, 2)))], a=0,
           check=rec_check(7, patched(s2[3], (4, 0, 2)), HDR, 0x5000, 's2'))
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
    dvg2 = patched(dvg, (12, gid ^ 0x55), n=24)
    S.call('GEOMSET andere ID', 12, p=(HDR + 0x400, 0xFFFF, 0, 0), pre=[(HDR + 0x400, dvg2)], a=0,
           rx=0x85, ry=0x0F, check=geom_check(dvg2, 0xFFFF, HDR + 0x400))        # S2 mit ID: Sätze 0, 2, 7
    S.call('Sätze mit ID 0 bleiben', 15, p=(0x1300, 0x1C00, 0, 0), a=0,
           check=lambda b: [] if [b.b('recs', 16 * (3 + k)) for k in range(8)] == [0, 1, 0, 1, 1, 0, 0, 0] and
           b.b('recs', 0) == 0 and b.b('dbg_ok') == 0 else ['Sätze 1, 3, 4'])
    S.call('TEXSET mit alter ID', 13, 0, p=(TD[0], 0, 0, 0), a=4, same=True)
    S.call('BGSET mit alter ID', 14, 0, p=(DB, 0, 0, 0), a=4)
    dvg3 = patched(dvg, (12, gid ^ 0x66), (5, 2), n=24)
    S.call('GEOMSET andere ID und D', 12, p=(HDR + 0x800, 0xFFFF, 0, 0), pre=[(HDR + 0x800, dvg3)], a=0,
           rx=0x1A, ry=0, check=geom_check(dvg3, 0xFFFF, HDR + 0x800))
    S.call('GEOMSET zurück', 12, p=(GD, 0xFFFF, 0, 0), a=0, rx=0, ry=0, check=geom_check(dvg, 0xFFFF, GD))
    S.call('SPRITESET ID 0 erneut', 9, 4, p=(HDR, 0x5000, 0, 0), pre=[(HDR, patched(s2[3], (4, 0, 2)))], a=0)
    dvg4 = patched(dvg, (12, gid ^ 0x77), (8, u16(dvg, 8) + 2), n=24)
    S.call('GEOMSET andere ID und Stride', 12, p=(HDR + 0x800, 0xFFFF, 0, 0), pre=[(HDR + 0x800, dvg4)], a=0,
           rx=0x10, ry=0)
    S.call('GEOMSET zurück 2', 12, p=(GD, 0xFFFF, 0, 0), a=0, rx=0, ry=0)
    S.call('SPRITESET ID 0 und gleiche ID', 9, 4, p=(HDR, 0x5000, 0, 0), pre=[(HDR, patched(s2[3], (4, 0, 2)))], a=0)
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
        SC.call(f'MAPINIT {nm}', 1, p=(ADDR['dmp'], 0xC000 if use_copy else 0, 0, 0),
                pre=[(ADDR['dmp'], data)], a=0, rx=w & 255, ry=h & 255,
                rp=(mm.start, mm.direction), check=map_check(mm, 0xC000 if use_copy else 0, 0))
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




def main():
    build()
    if '--build' in sys.argv:
        return 0
    ok = test_p6a()
    ok = test_p6c() and ok
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
