#!/usr/bin/env python3
"""VICE-Rauchtest P6a (docs/specs/P6-engine.md 10): BOOT mit VDC-BASIC v3, Stub (8 KB gemeinsames RAM), Lib.

Aufruf: test/vice_smoke.py [--port N] [--timeout S] [--only i|c]
Prüft (test/vice/smoke.bas, interpretiert und als Blitz!-Kompilat mit Runtime-Image 2):
  INIT über den Stub; während des Aufrufs $D506 = x6 und $FF00 = $7F; Code unter I/O ($DB80, BLOAD über $D000); die Lib sieht Bank 0 bis $1FFF (lesen und
  schreiben); ein langer Aufruf (etwa 1 Mio. Zyklen) lässt die Jiffy-Uhr weiterzählen; BUFSET über den Stub;
  Prüfsumme Bank 0 $1C00-$3FFF unverändert; danach funktionieren VMW und RXV.
Ereignisgesteuert: Haltepunkt auf dem BASIC-Fehlervektor ($0300), Ende über die Debug-Cartridge ($D7FF);
-limitcycles und das Timeout sind nur Wächter. Portregel (review-notes A): --port, sonst DBE_VICE_PORT, sonst 6631,
Bereich 6631-6649, bind-Test, nur der eigene VICE-Prozess wird beendet.
Voraussetzung: VDC-BASIC v3 (Verzeichnis VDCBASIC_DIR, Vorgabe ~/git/vdc-basic, Branch v3) – dort wird nichts verändert;
Blitz!-Lauf zusätzlich node und blitzc (sonst Meldung SKIP für diesen Lauf).
"""
import argparse, os, shutil, subprocess, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VDC = os.environ.get('VDCBASIC_DIR', os.path.expanduser('~/git/vdc-basic'))
if not os.path.exists(os.path.join(VDC, 'test', 'vicemon.py')):
    sys.exit(f'VDC-BASIC nicht gefunden: {VDC}/test/vicemon.py (VDCBASIC_DIR setzen)')
sys.path.insert(0, os.path.join(VDC, 'test'))
import vicemon as vm            # Monitor, Portwahl, run_vice (aus VDC-BASIC, nur gelesen)

OUT = os.path.join(ROOT, 'build', 'vice')
VERSION = open(os.path.join(ROOT, 'VERSION')).read().strip()


def sh(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode:
        sys.exit(f'Fehler ({r.returncode}): {" ".join(cmd)}')
    return r


def tok(bas, prg, start=None):
    sh(['python3', '-B', os.path.join(VDC, 'test', 'bastok.py')] + (['--start', start] if start else []) + [bas, prg])


def make_disk(d64, boot_prg, t_prg):
    sh(['c1541', '-format', 'dbe,01', 'd64', d64,
        '-write', boot_prg, 'boot',
        '-write', os.path.join(VDC, 'vdcbasic3.bin'), 'vdcbasic3',
        '-write', os.path.join(ROOT, 'build', f'dbe{VERSION}.stub'), f'dbe{VERSION}.stub',
        '-write', os.path.join(ROOT, 'build', f'dbe{VERSION}-test.lib'), f'dbe{VERSION}-test.lib',
        '-write', t_prg, 't'], stdout=subprocess.DEVNULL)


def run_one(name, d64, boot_prg, port, tmo):
    errors = []

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        m.bp(err_at)
        while True:
            try:
                pc, _ = m.go()
            except vm.Exited:
                return
            if pc == err_at:
                x = m.reg_x()
                lo, hi = m.mem(0x3B, 2)
                errors.append((x, lo | hi << 8))

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '400000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    return rc, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=180)
    ap.add_argument('--only', choices='ic')
    a = ap.parse_args()
    sh(['sh', os.path.join(ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)
    os.makedirs(OUT, exist_ok=True)
    port = vm.choose_port(a.port)
    boot_bas = os.path.join(OUT, 'boot.bas')
    with open(os.path.join(VDC, 'boot', 'boot.bas')) as f:
        lines = [('50 RUN"T"\n' if l.startswith('50 ') else l) for l in f]
    open(boot_bas, 'w').write(''.join(lines))
    boot_prg = os.path.join(OUT, 'boot.prg')
    tok(boot_bas, boot_prg)
    smoke = os.path.join(HERE, 'vice', 'smoke.bas')
    bad = 0
    if a.only != 'c':
        prg = os.path.join(OUT, 'smoke-i.prg')
        tok(smoke, prg, '0x4001')
        d64 = os.path.join(OUT, 'smoke-i.d64')
        make_disk(d64, boot_prg, prg)
        rc, err = run_one('i', d64, boot_prg, port, a.timeout)
        print(f'interpretiert: exit {rc}  BASIC-Fehler {err}', flush=True)
        bad |= rc != 0
    if a.only != 'i':
        node, blitzc = vm.find_node(), vm.find_blitzc()
        if not node or not blitzc:
            print('kompiliert: SKIP (blitzc nicht gefunden)')
            bad |= 3 << 8
        else:
            prep = os.path.join(OUT, 'smoke-b.bas')
            sh(['python3', '-B', os.path.join(VDC, 'test', 'blitzprep.py'), smoke, prep])
            src = os.path.join(OUT, 'smoke-src.prg')
            tok(prep, src)
            cdir = os.path.join(OUT, 'smoke-blitz')
            shutil.rmtree(cdir, ignore_errors=True)
            c = subprocess.run([node, blitzc, src, cdir, '--name', 'T'], capture_output=True, text=True)
            cprg = os.path.join(cdir, 'c.prg')
            if c.returncode or not os.path.exists(cprg):
                print(f'kompiliert: Compiler rc {c.returncode}: {c.stdout.strip()}')
                scr = os.path.join(cdir, 'screen.txt')
                if os.path.exists(scr):
                    print(open(scr).read())
                bad |= 1
            else:
                if open(cprg, 'rb').read(2) != b'\x01\x40':
                    print('kompiliert: kein Image 2 ($4001)')
                    bad |= 1
                d64 = os.path.join(OUT, 'smoke-c.d64')
                make_disk(d64, boot_prg, cprg)
                rc, err = run_one('c', d64, boot_prg, port, a.timeout)
                print(f'kompiliert (Blitz!, Image 2): exit {rc}  BASIC-Fehler {err}', flush=True)
                bad |= rc != 0
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
