#!/usr/bin/env python3
"""P6a, open item 1 (docs/specs/P6-engine.md 12): where does a program put its variables, arrays and strings in
bank 1, interpreted and as a Blitz! compilation (image 2), and does `POKE 57,0:POKE 58,64:CLR` lower the upper limit?

Usage: test/vice_blitzvars.py [--port N] [--timeout S]
Per program (fit: fits in $0400-$3FFF; stress: allocates strings until OUT OF MEMORY) and per mode (interpreted, Blitz!),
with and without limit: the program calls `SYS 3600` at two markers (RTS at $0E10, set by the script). Breakpoint
on the marker:
  Marker 1 (after CLR):  fill bank 1 $4000-$FEFF with $A5, save $0400-$3FFF, read pointers $2D-$3A
  Marker 2 (at the end): read pointers; count changed bytes in $4000-$FEFF (min/max); determine used range in
                         $0400-$3FFF (compared to marker 1)
Event-driven (breakpoints, no sleep); timeout and -limitcycles only as guards. Port rule as in vice_smoke.py.
"""
import argparse, os, shutil, subprocess, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vice_smoke as vs
vm = vs.vm

MARK = 0x0E10
HEAD = '5 bank 0:poke 3600,96:poke 3601,96:bank 15\n10 {lim}\n20 sys 3600\n'
FIT = '''30 trap 100
40 dim a%(1500):dim f(200)
50 a$="0123456789abcdef"
60 for i=1 to 3:a$=a$+a$:next
70 dim s$(60):for i=0 to 60:s$(i)=a$+left$(a$,100)+str$(i):next
80 for i=1 to 30:b$=left$(a$,100)+str$(i):next
90 e=0:goto 110
100 e=er
110 poke 3700,e:sys 3601
120 bank 15:poke dec("d7ff"),e:end
'''
STRESS = '''30 trap 100
40 dim s$(250):a$="0123456789abcdef"
50 for i=1 to 3:a$=a$+a$:next
60 for i=0 to 250:s$(i)=a$+left$(a$,100)+str$(i):next
70 e=0:goto 110
100 e=er
110 poke 3700,e:sys 3601
120 bank 15:poke dec("d7ff"),e:end
'''
LIM = 'poke 57,0:poke 58,64:clr'
NOLIM = 'clr'


def ptrs(m):
    m.cmd('bank ram')
    z = m.mem(0x2D, 14)
    names = ('TXTTAB', 'VARTAB', 'ARYTAB', 'STREND', 'FRETOP', 'FRESPC', 'MEMSIZ')
    return {n: z[2 * i] | z[2 * i + 1] << 8 for i, n in enumerate(names)}


def dump1(m, a, b):
    """Read bank 1 $a..$b-1."""
    m.cmd('bank ram01')
    out = []
    for p in range(a, b, 4096):
        out += m.mem(p, min(4096, b - p))
    m.cmd('bank ram')
    return out


def experiment(label, text, compiled, port, tmo):
    d = os.path.join(vs.OUT, 'bv')
    os.makedirs(d, exist_ok=True)
    bas = os.path.join(d, 'p.bas')
    open(bas, 'w').write(text)
    if compiled:
        prep = os.path.join(d, 'pb.bas')
        vs.sh(['python3', '-B', os.path.join(vs.VDC, 'test', 'blitzprep.py'), bas, prep])
        src = os.path.join(d, 'src.prg')
        vs.tok(prep, src)
        cdir = os.path.join(d, 'blitz')
        shutil.rmtree(cdir, ignore_errors=True)
        subprocess.run([vm.find_node(), vm.find_blitzc(), src, cdir, '--name', 'T', '--runtime', os.environ.get('BLITZ_RUNTIME', 'improved')], capture_output=True, text=True)
        prg = os.path.join(cdir, 'c.prg')
    else:
        prg = os.path.join(d, 'p.prg')
        vs.tok(bas, prg, '0x4001')
    boot_prg = os.path.join(vs.OUT, 'boot.prg')
    d64 = os.path.join(d, 'bv.d64')
    vs.make_disk(d64, boot_prg, prg)
    res = {}

    def script(m):
        err_at = m.mem(0x300, 2)
        err_at = err_at[0] | err_at[1] << 8
        m.bp(MARK)
        m.bp(MARK + 1)
        m.bp(err_at)
        while True:
            try:
                pc, _ = m.go()
            except vm.Exited:
                return
            if pc == err_at:
                res.setdefault('errors', []).append((m.reg_x(), m.mem(0x3B, 2)))
                continue
            if pc == MARK:
                res['p1'] = ptrs(m)
                m.cmd('bank ram01')
                m.cmd('f 4000 feff a5')
                m.cmd('bank ram')
                res['snap'] = dump1(m, 0x0400, 0x4000)
            else:
                res['p2'] = ptrs(m)
                res['e'] = m.mem(3700)[0]
                hi = dump1(m, 0x4000, 0xFF00)
                ch = [0x4000 + i for i, v in enumerate(hi) if v != 0xA5]
                res['above'] = (len(ch), ch[0] if ch else None, ch[-1] if ch else None)
                lo = dump1(m, 0x0400, 0x4000)
                ch = [0x0400 + i for i, (u, v) in enumerate(zip(res['snap'], lo)) if u != v]
                res['below'] = (len(ch), ch[0] if ch else None, ch[-1] if ch else None)
                m.s.sendall(b'quit\n')
                return

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB', '+drive8truedrive',
            '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg, '-limitcycles', '400000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    res['rc'] = rc
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=240)
    a = ap.parse_args()
    subprocess.run(['sh', os.path.join(vs.ROOT, 'engine', 'build.sh')], check=True, stdout=subprocess.DEVNULL)
    os.makedirs(vs.OUT, exist_ok=True)
    port = vm.choose_port(a.port)
    boot_bas = os.path.join(vs.OUT, 'boot.bas')
    open(boot_bas, 'w').write(''.join('50 RUN"T"\n' if l.startswith('50 ') else l
                                      for l in open(os.path.join(vs.VDC, 'boot', 'boot.bas'))))
    vs.tok(boot_bas, os.path.join(vs.OUT, 'boot.prg'))
    h = lambda v: '-' if v is None else f'${v:04X}'
    for prog, body in (('fit', FIT), ('stress', STRESS)):
        for compiled in (False, True):
            for lim, lname in ((NOLIM, 'without limit'), (LIM, 'with POKE 57,0:POKE 58,64:CLR')):
                text = HEAD.format(lim=lim) + body
                r = experiment(prog, text, compiled, port, a.timeout)
                mode = 'Blitz!' if compiled else 'interpreted'
                print(f'--- {prog}, {mode}, {lname}: BASIC error number at the end {r.get("e")} (ER)')
                if 'p2' in r:
                    print('    after CLR: ' + ' '.join(f'{k}=${v:04X}' for k, v in r['p1'].items()))
                    print('    at the end: ' + ' '.join(f'{k}=${v:04X}' for k, v in r['p2'].items()))
                    n, lo_, hi_ = r['above']
                    print(f'    Bank 1 $4000-$FEFF changed: {n} bytes, {h(lo_)} .. {h(hi_)}')
                    n, lo_, hi_ = r['below']
                    print(f'    Bank 1 $0400-$3FFF changed since marker 1: {n} bytes, {h(lo_)} .. {h(hi_)}')


if __name__ == '__main__':
    main()
