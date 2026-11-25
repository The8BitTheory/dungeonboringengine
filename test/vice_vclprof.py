#!/usr/bin/env python3
"""P6g-Analyse: VCL-Kosten je Eintrag und je VMS-Befehl in VICE (Szenen aus test/vice_view.py, nur interpretiert).

Aufruf: test/vice_vclprof.py [--port N] [--timeout S] [--static] [--json DATEI]
  --static  nur Python: Einträge nach Herkunft, geschriebene Bytes, Overdraw (kein VICE)

Haltepunkte (Monitor-Stoppuhr) im VCL-Interpreter von VDC-BASIC v3: Eintritt `vcl`, `.vcl_next_command` (vor jedem
Eintrag), `.vcl_done` (Ende), in VMS `.vms_arg_loop` (vor jedem Befehl) und `.vms_done`. Die lokalen Marken stehen
nicht in vdcbasic3.sym; sie werden aus dem ACME-Report (`acme -r`, Bau einer Kopie im Temp-Verzeichnis, geprüft
gegen vdcbasic3.bin) gelesen. Zwischen `vcl` und `.vcl_done` ist das I-Flag gesetzt (keine Kernal-IRQs).
Ereignisgesteuert: Haltepunkte, Debug-Cartridge; Timeout nur als Wächter. Port wie vice_view.py (DBE_VICE_PORT).
"""
import argparse, collections, json, os, re, shutil, subprocess, sys, tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vice_view as vv
dbeview, vs, vm = vv.dbeview, vv.vs, vv.vm
V = dbeview._View

# ------------------------------------------------------------------ Herkunft der Einträge (Referenz markieren)
_wall, _band, _bg, _obj, _add = V.wall_item, V.band_item, V.bg_item, V.objekte, V.add
KN = {dbeview.KIND_WALL: 'wand', dbeview.KIND_FLOOR: 'boden', dbeview.KIND_CEIL: 'decke'}


def _t_wall(self, kind, e, ent):
    it = _wall(self, kind, e, ent)
    it.tag = 'wand' if kind == dbeview.KIND_WALL else 'kachel'
    it.tagk = KN[kind]
    return it


def _t_band(self, kind, ent, y0, rows, c0, c1):
    it = _band(self, kind, ent, y0, rows, c0, c1)
    it.tag, it.tagk = 'band', KN[kind]
    return it


def _t_bg(self, *a):
    it = _bg(self, *a)
    it.tag, it.tagk = 'tapete', 'tapete'
    return it


def _t_obj(self, *a):
    self._in_obj = True
    try:
        return _obj(self, *a)
    finally:
        self._in_obj = False


def _t_add(self, item):
    if getattr(self, '_in_obj', False):
        item.tag, item.tagk = 'sprite', 'sprite'
    return _add(self, item)


V.wall_item, V.band_item, V.bg_item, V.objekte, V.add = _t_wall, _t_band, _t_bg, _t_obj, _t_add
_out = V.output


def _t_output(self):
    res = _out(self)
    tags = []
    for i, item in enumerate(self.items):
        for e in item.ents:
            tags.append((item.tag, item.tagk, e[0], i))
    res.tags = list(reversed(tags))              # Reihenfolge der VCL-Liste (hinten -> vorne)
    return res


V.output = _t_output


# ------------------------------------------------------------------ Einträge zerlegen, Bytes zählen
def entries(res):
    """Je VCL-Eintrag dict(typ, tag, kind, ops, rows, bytes, cmds{1,3,8}, writes=[(adr, n)])."""
    b0, b1 = res.bank0(), res.bank1()
    p, out = res.p0, []
    w = lambda i: b0[p + i] | b0[p + i + 1] << 8
    for tag, kind, et, item in res.tags:
        t = b0[p]
        E = dict(typ=t, tag=tag, kind=kind, et=et, item=item, rows=0, bytes=0, cmds=collections.Counter(), cbytes=0, writes=[])
        if t in (2, 3, 4, 5):
            cnt = w(5)
            reps = (w(7) & 255 or 256) if t in (2, 3, 5) else 1
            step = vv.dbeview._sw(w(9)) if t in (2, 3, 5) else 0
            dst = w(3) if t in (2, 3) else w(1)
            E.update(rows=reps, bytes=cnt * reps, cnt=cnt)
            E['writes'] = [((dst + r * step) & 0xFFFF, cnt) for r in range(reps)]
            p += {2: 11, 3: 13, 4: 7, 5: 11}[t]
        elif t in (9, 12):
            mem = b1 if t == 9 else b0
            dst, a = w(3), w(5)
            n = mem[a + 1] | mem[a + 2] << 8
            q = a + 3
            for _ in range(n):
                c = mem[q]
                E['cmds'][c] += 1
                E.setdefault('seq', []).append(c)
                if c == 1:
                    ofs, ln = mem[q + 1] | mem[q + 2] << 8, mem[q + 3]
                    E['writes'].append(((dst + ofs) & 0xFFFF, ln))
                    E['cbytes'] += ln
                    q += 4
                elif c == 8:
                    ofs = mem[q + 1] | mem[q + 2] << 8
                    E['writes'].append(((dst + ofs) & 0xFFFF, 1))
                    q += 3
                elif c == 3:
                    E['writes'].append((None, 0))
                    q += 3
                else:
                    raise SystemExit(f'VMS-Befehl {c}')
            E['bytes'] = E['cbytes'] + E['cmds'][8]
            E['ncmd'] = n
            p += 7
        else:
            raise SystemExit(f'VCL-Typ {t} unerwartet')
        out.append(E)
    assert b0[p] == 0, 'Ende der VCL-Liste nicht erreicht'
    return out


def cat(E):
    """Kategorie für die Tabelle."""
    tag, kind, t = E['tag'], E['kind'], E['typ']
    if tag == 'tapete':
        return 'Tapete VMF (Zeilen über/unter Panorama)' if t in (4, 5) else 'Tapete VMC (Panorama)'
    if tag == 'sprite':
        return 'Sprite VMC (Kerne)' if t in (2, 3) else f'Sprite VMS (Typ {t})'
    if tag == 'wand':
        return 'Wand VMC (Kerne)' if t in (2, 3) else ('Wand VMF (ZEILEN)' if t in (4, 5) else f'Wand VMS (Typ {t})')
    k = 'Kachel' if tag == 'kachel' else 'Band'
    if t in (4, 5):
        return f'{k} VMF (Farbverlauf/ZEILEN)'
    return f'{k} VMC (Kerne)' if t in (2, 3) else f'{k} VMS (Typ {t})'


def overdraw(sc, ents):
    """Schreibzähler je Fensterbyte: (geschrieben gesamt, Fenster, Fensterbytes >= 1 mal, verdeckt-geschrieben je Kat)."""
    g = sc.dvg
    win = {}
    for y in range(g.vh):
        for x in range(g.vw):
            win[(sc.ap + g.row(y) + x) & 0xFFFF] = 0
    last = {}
    wasted = collections.Counter()
    total = 0
    for E in ents:
        c = cat(E)
        for a, n in E['writes']:
            for i in range(n):
                ad = (a + i) & 0xFFFF
                total += 1
                if ad in last:
                    wasted[last[ad]] += 1
                last[ad] = c
                if ad in win:
                    win[ad] += 1
                else:
                    wasted['AUSSERHALB'] += 1
    return dict(total=total, window=len(win), covered=sum(1 for v in win.values() if v), wasted=wasted)


# ------------------------------------------------------------------ VICE-Lauf
def run_prof(world, d64, boot_prg, port, tmo, L):
    res = {'scenes': [], 'errors': [], 'end': False}

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        m.bp(err_at)
        for a in (vv.M_VIEW, vv.M_DONE, vv.M_END):
            m.bp(a)
        names = {'vcl': 'c', '.vcl_next_command': 'n', '.vcl_done': 'e', '.vms_arg_loop': 'v', '.vms_done': 'd'}
        at = {L[k]: v for k, v in names.items()}
        ids = [m.bp(a) for a in at]
        for i in ids:
            m.cmd(f'disable {i}')
        ev_, fl = [], 0
        while True:
            try:
                pc, _ = m.go()
            except vm.Exited:
                return
            if pc == err_at:
                res['errors'].append(len(res['scenes']))
                m.s.sendall(b'quit\n')
                return
            if pc == vv.M_VIEW:
                ev_ = []
                for i in ids:
                    m.cmd(f'enable {i}')
            elif pc in at:
                k = at[pc]
                if k == 'c':
                    m.cmd('stopwatch reset')
                    fl = vv.flags(m)
                    m.cmd(f'r fl = ${fl | 4:02x}')
                    ev_.append(('c', 0))
                else:
                    ev_.append((k, vv.stopwatch(m)))
                    if k == 'e':
                        m.cmd(f'r fl = ${(vv.flags(m) & ~4) | (fl & 4):02x}')
            elif pc == vv.M_DONE:
                for i in ids:
                    m.cmd(f'disable {i}')
                res['scenes'].append(ev_)
            elif pc == vv.M_END:
                res['end'] = True

    args = ['-default', '-warp', '-sounddev', 'dummy', '-debugcart', '-80col', '-VDC64KB',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '3000000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    return rc, res


def split(ev):
    """Ereignisse einer Szene -> (gesamt, [Eintrag: dict(t, vms=[Befehlszeiten], setup)])."""
    assert ev[0][0] == 'c' and ev[-1][0] == 'e', ev[:3]
    n_idx = [i for i, (k, _) in enumerate(ev) if k == 'n']
    out = []
    for j, i in enumerate(n_idx):
        t0 = ev[i][1]
        nxt = n_idx[j + 1] if j + 1 < len(n_idx) else len(ev) - 1
        t1 = ev[nxt][1]
        inner = ev[i + 1:nxt]
        vt = [t for k, t in inner if k == 'v']
        dt = [t for k, t in inner if k == 'd']
        cmds = []
        if vt:
            for a, b in zip(vt, vt[1:] + dt[:1]):
                cmds.append(b - a)
        out.append(dict(t=t1 - t0, vms=cmds, v0=(vt[0] - t0) if vt else None, vd=(t1 - dt[0]) if dt else None))
    # letzter 'n' liest das Ende-Byte: das ist kein Eintrag
    last = out.pop()
    return ev[-1][1], out, last['t'], n_idx and ev[n_idx[0]][1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=3600)
    ap.add_argument('--static', action='store_true')
    ap.add_argument('--json')
    a = ap.parse_args()
    vs.sh(['sh', os.path.join(vv.ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)
    tmp = tempfile.TemporaryDirectory()
    world = vv.World(tmp.name)
    exp = world.expected()
    stat = []
    for e in exp:
        ents = entries(e['res'])
        od = overdraw(e['scene'], ents)
        stat.append(dict(name=e['step'].name, ents=ents, od=od))
    out = dict(scenes=[])
    for s in stat:
        out['scenes'].append(dict(name=s['name'], od=dict(s['od'], wasted=dict(s['od']['wasted'])),
                                  ents=[{k: (dict(v) if isinstance(v, collections.Counter) else v)
                                         for k, v in E.items() if k != 'writes'} for E in s['ents']]))
    if not a.static:
        L = vv.vdc_labels()
        os.makedirs(vv.OUT, exist_ok=True)
        port = vm.choose_port(a.port)
        boot_bas = os.path.join(vv.OUT, 'boot.bas')
        with open(os.path.join(vs.VDC, 'boot', 'boot.bas')) as f:
            lines = [('50 RUN"T"\n' if l.startswith('50 ') else l) for l in f]
        open(boot_bas, 'w').write(''.join(lines))
        boot_prg = os.path.join(vv.OUT, 'boot.prg')
        vs.tok(boot_bas, boot_prg)
        src_bas = os.path.join(vv.OUT, 'view.bas')
        open(src_bas, 'w').write(vv.basic_listing(world))
        wd = os.path.join(vv.OUT, 'prof-files')
        shutil.rmtree(wd, ignore_errors=True)
        os.makedirs(wd)
        prg = os.path.join(vv.OUT, 'view-i.prg')
        vs.tok(src_bas, prg, '0x4001')
        d64 = os.path.join(vv.OUT, 'prof-i.d64')
        vv.make_disk(world, d64, boot_prg, prg, wd)
        rc, got = run_prof(world, d64, boot_prg, port, a.timeout, L)
        print(f'VICE: exit {rc}, Fehler {got["errors"]}, Ende {got["end"]}, Szenen {len(got["scenes"])}', flush=True)
        if len(got['scenes']) != len(exp) or got['errors']:
            sys.exit(1)
        for s, ev, o in zip(stat, got['scenes'], out['scenes']):
            total, per, tail, head = split(ev)
            if len(per) != len(s['ents']):
                sys.exit(f'{s["name"]}: {len(per)} Einträge gemessen, {len(s["ents"])} erwartet')
            o['total'], o['tail'], o['head'] = total, tail, head
            for E, P in zip(o['ents'], per):
                E['t'], E['vmsc'], E['v0'], E['vd'] = P['t'], P['vms'], P['v0'], P['vd']
                if E['typ'] in (9, 12) and len(P['vms']) != E['ncmd']:
                    sys.exit(f'{s["name"]}: VMS {len(P["vms"])} Befehle gemessen, {E["ncmd"]} erwartet')
    if a.json:
        json.dump(out, open(a.json, 'w'))
    # Kurzbericht
    agg = collections.defaultdict(lambda: collections.Counter())
    for o in out['scenes']:
        for E in o['ents']:
            c = agg[cat(E)]
            c['n'] += 1
            c['bytes'] += E['bytes']
            c['rows'] += E['rows']
            c['cmds'] += sum(E['cmds'].values())
            c['t'] += E.get('t', 0)
    n = len(out['scenes'])
    print(f'{"Kategorie":<42} {"Eintr.":>7} {"Zeilen":>7} {"VMS-Bef.":>8} {"Bytes":>8} {"Zyklen":>9}  (je Szene)')
    for k in sorted(agg, key=lambda k: -agg[k]['t'] or -agg[k]['bytes']):
        c = agg[k]
        print(f'{k:<42} {c["n"] / n:>7.1f} {c["rows"] / n:>7.1f} {c["cmds"] / n:>8.1f} {c["bytes"] / n:>8.0f} {c["t"] / n:>9.0f}')
    tb = sum(o['od']['total'] for o in out['scenes']) / n
    print(f'geschrieben je Szene {tb:.0f} Byte, Fenster {out["scenes"][0]["od"]["window"]} Byte')


if __name__ == '__main__':
    main()
