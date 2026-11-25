#!/usr/bin/env python3
"""sim65-Gerüst für die Lib (docs/specs/P6-engine.md 9.2).

Aufruf:  run_sim.py            baut den Harness und führt die Tests der Teilschritte aus (P6a)
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
    s.call(17).call(18).call(255).call(7).call(8).call(4).call(12)          # nicht umgesetzt
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
    for f in (17, 18, 255, 7, 8, 4, 12):
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


def main():
    build()
    if '--build' in sys.argv:
        return 0
    ok = test_p6a()
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
