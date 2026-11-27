#!/usr/bin/env python3
"""Proof for the zero page block of the lib (docs/specs/P6-engine.md, decisions after the P6d review, item 3).

Usage: test/vice_zp.py [--port N] [--timeout S] [--only i|c] [--control | --funcs]
The stub saves $63-$72 (ZPB, FAC/ARG of the interpreter) before the lib calls that use it (VIEW, GEOMSET,
test function 253; since P6j only these), and writes the block back afterwards; the lib uses it freely there. test/vice/zp.bas (interpreted and as a Blitz! compilation, image 2) calls test function 253
20 times (fill block, wait about 330,000 cycles, check pattern) while interrupts are running
(jiffy clock/keyboard, SOUND with sweep, MOVSPR), and afterwards checks floating point (SIN, STR$, VAL, division) and that
clock and sprite kept running.
In addition the script sets a watchpoint (read and write) on $63-$72 that is only active between JSR LIB and the
return in the stub (breakpoints call_lib/call_ret from build/stub.lbl). Every hit with $FF00 <> $7F
(i.e. not from the lib, e.g. from an interrupt routine with ROM) is an error.
--control checks the method: the same run with the watchpoint on the jiffy clock $A0-$A2 must find foreign accesses
(Kernal IRQ during the call).
--funcs (P6j): zero page usage per function. Program and files of test/vice_view.py (all setter calls, scenes with
SETPOS/MOVE and VIEW), plus CELL, SETCELL, SETITEM, BUFSET with X = 1 and X = 0 and unimplemented functions (7, 8, 17).
Per lib call (breakpoints call_lib/call_ret, F = A on entry) two watchpoints (read and write) are active:
ZPB ($63-$72) and ZP0/ZP1 ($FA-$FD); the first hit per range and call is recorded with $FF00 and the watchpoint
is disabled until the end of the call. Expected: ZPB only for F in {4, 12} (ZPB_F1/ZPB_F2 from engine/dbe.inc, the
functions for which the stub saves the block), no hits with $FF00 <> $7F, every function 0-16 except 7/8 called at least
once; output: table F -> calls, ZPB, ZP0/ZP1.
Event-driven (breakpoints, watchpoint, debug cartridge), timeout/-limitcycles only as guards; port rule as in
vice_smoke.py (DBE_VICE_PORT), only the own VICE process is terminated.
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


def zpb_funcs():
    d = {}
    for line in open(os.path.join(vs.ROOT, 'engine', 'dbe.inc')):
        m = re.match(r'(ZPB_F\w+)\s*=\s*(\d+)', line)
        if m:
            d[m.group(1)] = int(m.group(2))
    return {v for k, v in d.items() if k != 'ZPB_FT'}


NAMES = ['INIT', 'MAPINIT', 'SETPOS', 'MOVE', 'VIEW', 'CELL', 'SETCELL', '(7)', '(8)', 'SPRITESET', 'ITEMSET',
         'POOLSET', 'GEOMSET', 'TEXSET', 'BGSET', 'BUFSET', 'SETITEM']


def funcs_main(a, port):
    """--funcs: zero page usage per function (program of vice_view.py, extended)."""
    import tempfile
    import vice_view as vv
    tmp = tempfile.TemporaryDirectory()
    world = vv.World(tmp.name)
    extra = ['1900 p0=0:p1=0:f=5:x=0:y=0:gosub 9500:if a<>0 then r=90:goto 8995',            # CELL 0
             '1901 t=x:i=y:p0=0:f=6:x=t:y=0:gosub 9500:if a<>0 then r=91:goto 8995',           # SETCELL 0 (unchanged)
             '1902 p0=0:f=16:x=i:gosub 9500:if a<>0 then r=92:goto 8995',                      # SETITEM 0 (unchanged)
             f'1903 p0={vv.BUF[0]}:p1={vv.BUF[1]}:f=15:x=1:gosub 9500:if a<>0 then r=93:goto 8995',   # BUFSET X = 1
             f'1904 p0={vv.BUF[0]}:p1={vv.BUF[1]}:f=15:x=0:gosub 9500:if a<>0 then r=94:goto 8995',   # BUFSET X = 0
             '1905 for f=7 to 8:p0=0:x=0:gosub 9500:if a<>255 then r=95:goto 8995',
             '1906 next:f=17:gosub 9500:if a<>255 then r=96:goto 8995']
    text = vv.basic_listing(world).split('\n')
    i = next(k for k, l in enumerate(text) if l.startswith('2000 '))
    text[i:i] = extra
    os.makedirs(vs.OUT, exist_ok=True)
    src = os.path.join(vs.OUT, 'zpf.bas')
    open(src, 'w').write('\n'.join(text))
    prg = os.path.join(vs.OUT, 'zpf.prg')
    vs.tok(src, prg, '0x4001')
    boot_prg = os.path.join(vs.OUT, 'boot.prg')
    wd = os.path.join(vs.OUT, 'zpf-files')
    shutil.rmtree(wd, ignore_errors=True)
    os.makedirs(wd)
    d64 = os.path.join(vs.OUT, 'zpf.d64')
    vv.make_disk(world, d64, boot_prg, prg, wd)
    L = stub_labels()
    calls, zpb, zp01, foreign, errors = {}, {}, {}, [], []

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        m.bp(err_at)
        m.bp(L['call_lib'])
        m.bp(L['call_ret'])
        wb = int(re.search(r'WATCH: (\d+)', m.cmd('watch 63 72')).group(1))
        wz = int(re.search(r'WATCH: (\d+)', m.cmd('watch fa fd')).group(1))
        m.cmd(f'disable {wb}')
        m.cmd(f'disable {wz}')
        f = None
        while True:
            try:
                pc, out = m.go()
            except vm.Exited:
                return
            hit = re.search(r'#(\d+) \(Stop on\s+(load|store)', out) or re.search(r'Stop on\s+(load|store)', out)
            if hit:
                cr = m.mem(0xFF00, 1)[0]
                wn = re.search(r'#(\d+)', out)
                w = int(wn.group(1)) if wn else None
                if w is None:           # watchpoint number not recognized: disable both, record as ZPB
                    w = wb
                rng = zpb if w == wb else zp01
                if cr != 0x7F:
                    foreign.append((f, pc, cr, out.strip().splitlines()[-2:]))
                rng.setdefault(f, set()).add(cr)
                m.cmd(f'disable {w}')
            elif pc == L['call_lib']:
                f = int(re.findall(r'\.;[0-9a-f]{4} ([0-9a-f]{2})', m.cmd('r'))[-1], 16)
                calls[f] = calls.get(f, 0) + 1
                m.cmd(f'enable {wb}')
                m.cmd(f'enable {wz}')
            elif pc == L['call_ret']:
                m.cmd(f'disable {wb}')
                m.cmd(f'disable {wz}')
                f = None
            elif pc == err_at:
                lo, hi = m.mem(0x3B, 2)
                errors.append((m.reg_x(), lo | hi << 8))

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '1500000000']
    _, rc = vm.run_vice(args, port, a.timeout, script)
    want = zpb_funcs()
    print(f'--funcs (interpreted, program of vice_view.py): exit {rc}, BASIC error {errors}')
    print('  F  Function    Calls    ZPB $63-$72  ZP0/ZP1 $FA-$FD')
    for f in sorted(calls):
        n = NAMES[f] if f < len(NAMES) else f'({f})'
        print(f'  {f:<3}{n:<12}{calls[f]:>7}  {"yes" if f in zpb else "no":<11}  {"yes" if f in zp01 else "no"}')
    used = set(zpb)
    missing = [f for f in range(17) if f not in (7, 8) and f not in calls]
    ok = rc == 0 and not errors and not foreign and used == want and not missing
    print(f'  ZPB used by {sorted(used)}, stub saves for {sorted(want)}; foreign accesses {len(foreign)}; '
          f'not called {missing} -> {"ok" if ok else "ERROR"}')
    for v in foreign[:10]:
        print('  foreign:', v)
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=300)
    ap.add_argument('--only', choices='ic')
    ap.add_argument('--control', action='store_true',
                    help='control run: watchpoint on the jiffy clock $A0-$A2 instead of ZPB; expects foreign accesses')
    ap.add_argument('--funcs', action='store_true', help='P6j: zero page usage per function (program of vice_view.py)')
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
    if a.funcs:
        sys.exit(funcs_main(a, port))
    src_bas = os.path.join(HERE, 'vice', 'zp.bas')
    bad = 0

    rng = 'a0 a2' if a.control else '63 72'

    def report(name, rc, r):
        ok = rc == 0 and bool(r['viol']) == a.control and not r['errors'] and r['calls'] >= 21
        print(f'{name}: exit {rc}, calls {r["calls"]}, watchpoint hits {r["hits"]} (lib), '
              f'foreign accesses {len(r["viol"])}, BASIC error {r["errors"]} -> {"ok" if ok else "ERROR"}', flush=True)
        for v in r['viol'][:3 if a.control else 10]:
            print('  foreign:', v)
        return 0 if ok else 1

    if a.only != 'c':
        prg = os.path.join(vs.OUT, 'zp-i.prg')
        vs.tok(src_bas, prg, '0x4001')
        d64 = os.path.join(vs.OUT, 'zp-i.d64')
        vs.make_disk(d64, boot_prg, prg)
        bad |= report('interpreted', *run_one(d64, boot_prg, port, a.timeout, rng))
    if a.only != 'i':
        node, blitzc = vm.find_node(), vm.find_blitzc()
        if not node or not blitzc:
            print('compiled: SKIP (blitzc not found)')
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
                print(f'compiled: compiler rc {c.returncode}: {c.stdout.strip()}')
                bad |= 1
            else:
                d64 = os.path.join(vs.OUT, 'zp-c.d64')
                vs.make_disk(d64, boot_prg, cprg)
                bad |= report('compiled (Blitz!, image 2)', *run_one(d64, boot_prg, port, a.timeout, rng))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
