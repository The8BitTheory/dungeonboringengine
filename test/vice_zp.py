#!/usr/bin/env python3
"""Nachweis für den Zeropage-Block der Lib (docs/specs/P6-engine.md, Entscheidungen nach dem P6d-Review, Punkt 3).

Aufruf: test/vice_zp.py [--port N] [--timeout S] [--only i|c]
Der Stub rettet $63-$72 (ZPB, FAC/ARG des Interpreters) vor jedem Lib-Aufruf und schreibt den Block danach zurück;
die Lib benutzt ihn frei. test/vice/zp.bas (interpretiert und als Blitz!-Kompilat, Image 2) ruft 20-mal die
Testfunktion 253 auf (Block füllen, etwa 330 000 Zyklen warten, Muster prüfen), während Interrupts laufen
(Jiffy-Uhr/Tastatur, SOUND mit Sweep, MOVSPR), und prüft danach Fließkomma (SIN, STR$, VAL, Division) und dass
Uhr und Sprite weitergelaufen sind.
Zusätzlich setzt das Skript einen Watchpoint (Lesen und Schreiben) auf $63-$72, der nur zwischen JSR LIB und der
Rückkehr im Stub aktiv ist (Haltepunkte call_lib/call_ret aus build/stub.lbl). Jeder Treffer mit $FF00 <> $7F
(also nicht aus der Lib, z. B. aus einer Interruptroutine mit ROM) ist ein Fehler.
--control prüft das Verfahren: derselbe Lauf mit dem Watchpoint auf der Jiffy-Uhr $A0-$A2 muss fremde Zugriffe
(Kernal-IRQ während des Aufrufs) finden.
Ereignisgesteuert (Haltepunkte, Watchpoint, Debug-Cartridge), Timeout/-limitcycles nur als Wächter; Portregel wie
vice_smoke.py (DBE_VICE_PORT), nur der eigene VICE-Prozess wird beendet.
"""
import argparse, os, re, shutil, subprocess, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vice_smoke as vs
vm = vs.vm


def stub_labels():
    d = {}
    for line in open(os.path.join(vs.ROOT, 'build', 'stub.lbl')):
        m = re.match(r'al ([0-9A-Fa-f]+) \.(\S+)', line)
        if m:
            d[m.group(2)] = int(m.group(1), 16)
    return d


def run_one(d64, boot_prg, port, tmo, rng='63 72'):
    L = stub_labels()
    res = {'errors': [], 'viol': [], 'hits': 0, 'calls': 0}

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        m.bp(err_at)
        m.bp(L['call_lib'])
        m.bp(L['call_ret'])
        w = int(re.search(r'WATCH: (\d+)', m.cmd(f'watch {rng}')).group(1))
        m.cmd(f'disable {w}')
        while True:
            try:
                pc, out = m.go()
            except vm.Exited:
                return
            if re.search(r'Stop on\s+(load|store)', out):
                res['hits'] += 1
                cr = m.mem(0xFF00, 1)[0]
                if cr != 0x7F:
                    res['viol'].append((pc, cr, out.strip().splitlines()[-2:]))
            elif pc == L['call_lib']:
                res['calls'] += 1
                m.cmd(f'enable {w}')
            elif pc == L['call_ret']:
                m.cmd(f'disable {w}')
            elif pc == err_at:
                lo, hi = m.mem(0x3B, 2)
                res['errors'].append((m.reg_x(), lo | hi << 8))

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '600000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    return rc, res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=300)
    ap.add_argument('--only', choices='ic')
    ap.add_argument('--control', action='store_true',
                    help='Gegenprobe: Watchpoint auf die Jiffy-Uhr $A0-$A2 statt ZPB; erwartet fremde Zugriffe')
    a = ap.parse_args()
    vs.sh(['sh', os.path.join(vs.ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)
    os.makedirs(vs.OUT, exist_ok=True)
    port = vm.choose_port(a.port)
    boot_bas = os.path.join(vs.OUT, 'boot.bas')
    with open(os.path.join(vs.VDC, 'boot', 'boot.bas')) as f:
        lines = [('50 RUN"T"\n' if l.startswith('50 ') else l) for l in f]
    open(boot_bas, 'w').write(''.join(lines))
    boot_prg = os.path.join(vs.OUT, 'boot.prg')
    vs.tok(boot_bas, boot_prg)
    src_bas = os.path.join(HERE, 'vice', 'zp.bas')
    bad = 0

    rng = 'a0 a2' if a.control else '63 72'

    def report(name, rc, r):
        ok = rc == 0 and bool(r['viol']) == a.control and not r['errors'] and r['calls'] >= 21
        print(f'{name}: exit {rc}, Aufrufe {r["calls"]}, Watchpoint-Treffer {r["hits"]} (Lib), '
              f'fremde Zugriffe {len(r["viol"])}, BASIC-Fehler {r["errors"]} -> {"ok" if ok else "FEHLER"}', flush=True)
        for v in r['viol'][:3 if a.control else 10]:
            print('  fremd:', v)
        return 0 if ok else 1

    if a.only != 'c':
        prg = os.path.join(vs.OUT, 'zp-i.prg')
        vs.tok(src_bas, prg, '0x4001')
        d64 = os.path.join(vs.OUT, 'zp-i.d64')
        vs.make_disk(d64, boot_prg, prg)
        bad |= report('interpretiert', *run_one(d64, boot_prg, port, a.timeout, rng))
    if a.only != 'i':
        node, blitzc = vm.find_node(), vm.find_blitzc()
        if not node or not blitzc:
            print('kompiliert: SKIP (blitzc nicht gefunden)')
            bad |= 2
        else:
            prep = os.path.join(vs.OUT, 'zp-b.bas')
            vs.sh(['python3', '-B', os.path.join(vs.VDC, 'test', 'blitzprep.py'), src_bas, prep])
            src = os.path.join(vs.OUT, 'zp-src.prg')
            vs.tok(prep, src)
            cdir = os.path.join(vs.OUT, 'zp-blitz')
            shutil.rmtree(cdir, ignore_errors=True)
            c = subprocess.run([node, blitzc, src, cdir, '--name', 'T'], capture_output=True, text=True)
            cprg = os.path.join(cdir, 'c.prg')
            if c.returncode or not os.path.exists(cprg) or open(cprg, 'rb').read(2) != b'\x01\x40':
                print(f'kompiliert: Compiler rc {c.returncode}: {c.stdout.strip()}')
                bad |= 1
            else:
                d64 = os.path.join(vs.OUT, 'zp-c.d64')
                vs.make_disk(d64, boot_prg, cprg)
                bad |= report('kompiliert (Blitz!, Image 2)', *run_one(d64, boot_prg, port, a.timeout, rng))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
