#!/usr/bin/env python3
"""VIEW im Simulator für alle freien Zellen und Richtungen einer Crawl-Karte ausführen.

Aufruf: run_viewsim.py <crawl128.cd1> <walls.wsm>
Baut viewsim.prg (cl65, Ziel sim6502) und misst mit sim65 -c:
  Zyklen VIEW = Zyklen(mode 1) - Zyklen(mode 0); dazu Anzahl Wandeinträge und Länge der VCL-Liste.
"""
import os, re, statistics, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(os.path.dirname(here))
cd1, wsm = (os.path.abspath(a) for a in sys.argv[1:3])
c = open(cd1, 'rb').read()[2:]
off, W, H = c[0], c[1], c[2]
out = os.path.join(root, 'build', 'sim')
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, 'simdata.inc'), 'w') as f:
    f.write(f'MAP_W = {W}\nMAP_H = {H}\nMAP_OFF = {2 + off}\n.define MAPFILE "{cd1}"\n.define WSMFILE "{wsm}"\n')
prg = os.path.join(out, 'viewsim.prg')
subprocess.run(['cl65', '-t', 'sim6502', '-C', os.path.join(here, 'sim.cfg'), '-O', '--asm-define', 'SIM',
                '--asm-include-dir', out, '--asm-include-dir', os.path.join(root, 'engine'),
                '-o', prg, os.path.join(here, 'viewsim.c'), os.path.join(here, 'glue.s'),
                os.path.join(root, 'engine', 'lib.s')], check=True, cwd=out)
for o in (os.path.join(here, 'viewsim.o'), os.path.join(here, 'glue.o'), os.path.join(root, 'engine', 'lib.o')):
    if os.path.exists(o):
        os.remove(o)   # cl65 legt die Objekte neben die Quellen


def run(pos, d, mode):
    r = subprocess.run(['sim65', '-c', prg, str(pos), str(d), str(mode)], capture_output=True, text=True)
    cyc = int(re.search(r'(\d+) cycles', r.stdout + r.stderr).group(1))
    return cyc, r.stdout.split('\n')[0]


rows = []
for pos in range(W * H):
    if c[off + pos] & 1:
        continue
    for d in range(4):
        c0, _ = run(pos, d, 0)
        c1, _ = run(pos, d, 1)
        _, o = run(pos, d, 2)
        err, nvis, ln = map(int, o.split())
        rows.append((pos, d, c1 - c0, nvis, ln, err))
cyc = [r[2] for r in rows]; nv = [r[3] for r in rows]; ln = [r[4] for r in rows]
print(f'{len(rows)} Ansichten ({len(rows)//4} Zellen x 4 Richtungen), Fehler: {sum(1 for r in rows if r[5])}')
print(f'Zyklen VIEW:     min {min(cyc)}  Mittel {statistics.mean(cyc):.0f}  max {max(cyc)}')
print(f'Wandeinträge:    min {min(nv)}  Mittel {statistics.mean(nv):.1f}  max {max(nv)}')
print(f'VCL-Länge Byte:  min {min(ln)}  Mittel {statistics.mean(ln):.0f}  max {max(ln)}')
