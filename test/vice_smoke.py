#!/usr/bin/env python3
"""VICE smoke test P6a (docs/specs/P6-engine.md 10): BOOT with VDC-BASIC v3, stub (8 KB shared RAM), lib.

Usage: test/vice_smoke.py [--port N] [--timeout S] [--only i|c]
Checks (test/vice/smoke.bas, interpreted and as a Blitz! compilation with runtime image 2):
  INIT via the stub; during the call $D506 = x6 and $FF00 = $7F; code under I/O ($DBF8, BLOAD over $D000); the lib sees bank 0 up to $1FFF (read and
  write); a long call (about 1 M cycles) lets the jiffy clock keep counting; BUFSET via the stub;
  checksum of bank 0 $1C00-$3FFF unchanged; afterwards VMW and RXV work.
Event-driven: breakpoint on the BASIC error vector ($0300), end via the debug cartridge ($D7FF);
-limitcycles and the timeout are only guards. Port rule (review-notes A): --port, else DBE_VICE_PORT, else 6631,
range 6631-6649, bind test, only the own VICE process is terminated.
Requirement: VDC-BASIC v3 (directory VDCBASIC_DIR, default ~/git/vdc-basic, branch v3) - nothing is changed there;
Blitz! run additionally needs node and blitzc (otherwise message SKIP for this run).
"""
import argparse, os, shutil, subprocess, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VDC = os.environ.get('VDCBASIC_DIR', os.path.expanduser('~/git/vdc-basic'))
if not os.path.exists(os.path.join(VDC, 'test', 'vicemon.py')):
    sys.exit(f'VDC-BASIC not found: {VDC}/test/vicemon.py (set VDCBASIC_DIR)')
sys.path.insert(0, os.path.join(VDC, 'test'))
import vicemon as vm            # monitor, port choice, run_vice (from VDC-BASIC, read only)

OUT = os.path.join(ROOT, 'build', 'vice')
VERSION = open(os.path.join(ROOT, 'VERSION')).read().strip()


def sh(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode:
        sys.exit(f'Error ({r.returncode}): {" ".join(cmd)}')
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
        print(f'interpreted: exit {rc}  BASIC error {err}', flush=True)
        bad |= rc != 0
    if a.only != 'i':
        node, blitzc = vm.find_node(), vm.find_blitzc()
        if not node or not blitzc:
            print('compiled: SKIP (blitzc not found)')
            bad |= 3 << 8
        else:
            prep = os.path.join(OUT, 'smoke-b.bas')
            sh(['python3', '-B', os.path.join(VDC, 'test', 'blitzprep.py'), smoke, prep])
            src = os.path.join(OUT, 'smoke-src.prg')
            tok(prep, src)
            cdir = os.path.join(OUT, 'smoke-blitz')
            shutil.rmtree(cdir, ignore_errors=True)
            c = subprocess.run([node, blitzc, src, cdir, '--name', 'T', '--runtime', os.environ.get('BLITZ_RUNTIME', 'improved')], capture_output=True, text=True)
            cprg = os.path.join(cdir, 'c.prg')
            if c.returncode or not os.path.exists(cprg):
                print(f'compiled: compiler rc {c.returncode}: {c.stdout.strip()}')
                scr = os.path.join(cdir, 'screen.txt')
                if os.path.exists(scr):
                    print(open(scr).read())
                bad |= 1
            else:
                if open(cprg, 'rb').read(2) != b'\x01\x40':
                    print('compiled: not image 2 ($4001)')
                    bad |= 1
                d64 = os.path.join(OUT, 'smoke-c.d64')
                make_disk(d64, boot_prg, cprg)
                rc, err = run_one('c', d64, boot_prg, port, a.timeout)
                print(f'compiled (Blitz!, image 2): exit {rc}  BASIC error {err}', flush=True)
                bad |= rc != 0
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
