#!/usr/bin/env python3
"""VICE-Test der Demo (docs/specs/P7-crawl.md 8.6): Tour mit Tasten, ganzes VRAM pro Bild gegen das Modell.

Aufruf: test/vice_demo.py [--port N] [--timeout S] [--only i|c] [--check] [--png DIR] [--shots DIR] [--control]
                         [--no-fast] [--no-build] [--budget [N]]
  --check    nur Python: Disk bauen (demo/build.py), Tour mit dem Goblin-Modell durchspielen, Modell je Bild rechnen
             (dbeview.view/run_vcl, Fenster gegen paint_reference), Abdeckung der Tour prüfen; kein VICE
  --png DIR  Bilder der Tour aus dem Modell (Montage szenen.png und je Bild bild_NN.png)
  --shots DIR  im VICE-Lauf von jedem Bild einen Screenshot des VDC machen (DIR/<fassung>_NN.png)
  --control  Gegenprobe: ein Byte im Fenster des Modells von Bild 5 verfälschen; der Lauf muss genau dieses Bild melden
  --no-fast  ohne den zweiten Lauf mit 2 MHz (FAST während VIEW und VCL, demo.bas Zeile 3: fs = 1)
  --budget [N]  zusätzlich dbeview-Budget über alle Ansichten mit Goblins (demo/build.py --budget, N Zustände)

Ablauf (demo/build.py baut Dateien, Programm und Disk; BOOT mit `50 RUN"DEMO"`): VICE startet das PRG BOOT von der Disk
(interpretiert und als Blitz!-Kompilat mit Runtime-Image 2). Der Harness hält an GETIN ($FFE4); liegt keine Taste im
Puffer ($D0 = 0) und ist die Objektzahl $0C50 = 3, wartet das Programm auf eine Taste: Prompt. An jedem Prompt:
  * ganzes 64-KB-VRAM (`bank vdc`, bsave) gegen das Modell: run_vcl der VIEW-Referenz auf dem fortgeschriebenen
    VRAM (plus Kompass: VDB unter dem Fenster); das Fenster zusätzlich gegen dbeview.paint_reference
  * Parameterblock VCLADR/VCLLEN/VMSLEN/OBJVIS ($0C0A-$0C11), VCL-Liste im Puffer, ITEMPH ($0C08)
  * Objektliste $0C50-$0CB0 gegen das Goblin-Modell (Python-Fassung der Routen aus demo.bas), Inhaltsebene der
    Arbeitskopie (Bank 1 $5000 + W*H, mit Automap-Bits) gegen das Modell
Das Modell bekommt Position und Richtung aus den Tasten (dbemove.move mit der echten Objektliste) und die Szene aus der
echten Objektliste; kein sleep, keine festen Wartezeiten: Haltepunkte (GETIN, BASIC-Fehlervektor $0300, Stub, VCL),
Debug-Cartridge gibt es nicht (Ende nach der letzten Taste X über Haltepunkt auf CHRIN $FFCF = Direktmodus).
Zyklen je Taste (Stoppuhr, Takte zu 1 MHz): gesamt (Taste bis nächster Prompt), VIEW (Stub), MOVE (Stub), VCL.
Portregel (review-notes A): --port, sonst DBE_VICE_PORT, sonst 6631, Bereich 6631-6649, Bind-Test, nur der eigene Prozess.
Voraussetzung: VDC-BASIC v3 (VDCBASIC_DIR, nur gelesen), c1541, ACME (Marken von VDC-BASIC), Pillow; Blitz!-Lauf zusätzlich
node und blitzc (sonst SKIP).
"""
import argparse, copy, importlib, os, re, struct, subprocess, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vice_smoke as vs                  # Monitor/Portwahl über VDC-BASIC (nur gelesen), Disk-Hilfen
vm = vs.vm
ROOT = vs.ROOT
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, os.path.join(HERE, 'tools'))
sys.path.insert(0, os.path.join(ROOT, 'demo'))
import dbemap, dbeview, dbemove
dbeview.dbemap = dbemap
import build as demo_build               # demo/build.py
from PIL import Image

OUT = demo_build.OUT
GETIN, CHRIN = 0xFFE4, 0xFFCF
BUF = (0x1300, 0x1C00)
NOBJ = 3                                 # Goblins in demo.bas (OBJN)

# ------------------------------------------------------------------ Tour (demo/tour.py: Suche in Position, Richtung, Goblin-Zuständen)
import tour as demo_tour


def tour_keys(sc0):
    """Tour (Liste Tasten, Bezeichnung, erwartetes X) und die Tastenfolge einschließlich der letzten Taste X (Ende)."""
    segs = demo_tour.plan(sc0.dmp, os.path.join(ROOT, 'demo', 'demo.bas'))
    keys = ''.join(k for k, _, _ in segs)
    return segs, keys


class GoblinSim:
    """Python-Fassung von demo.bas 3000-3120: Routen aus den DATA-Zeilen, ein Schritt je gültiger Taste; wartet, wenn
    die nächste Zelle die Spielerzelle ist. Der Test prüft die echte Objektliste gegen dieses Modell."""

    def __init__(self, bas, w):
        self.routes = [[y * w + x for x, y in r] for r in demo_build.routes(bas)]
        self.gi = [0] * len(self.routes)
        self.fc = 0

    def step(self, pc):
        self.fc += 1
        for g, r in enumerate(self.routes):
            n = (self.gi[g] + 1) % len(r)
            if r[n] != pc:
                self.gi[g] = n

    def objects(self):
        """Objektliste als 6-Byte-Einträge (wie sie demo.bas nach $0C51 schreibt)."""
        out = []
        for g, r in enumerate(self.routes):
            t = r[self.gi[g]]
            out.append(bytes((t & 255, t >> 8, 0, 255, (self.fc + g) & 3, 4)))
        return out

    def itemph(self):
        return self.fc & 1


def objs_from_bytes(lst):
    return [dbeview.Obj(e[0] | e[1] << 8, e[2], e[3], e[4], e[5] & 7, bool(e[5] & 0x40), bool(e[5] & 0x80)) for e in lst]


ACTION = {'W': 0, 'S': 1, 'A': 2, 'D': 3, 'Q': 4, 'E': 5}


class Run:
    """Zustand der Tour im Modell: Position, Richtung, VRAM, Karte (Automap-Bits wandern mit)."""

    def __init__(self, sc0, L, bas):
        self.sc0 = sc0
        self.L = L
        self.map = copy.deepcopy(sc0.dmp)
        self.pos, self.dir = self.map.start, self.map.direction
        self.vram = self.initial_vram()
        self.bas = bas

    def initial_vram(self):
        v = bytearray(65536)
        v[8000:9600] = bytes([0x1F]) * 1600
        v[46335:46335 + 16000] = bytes([15]) * 16000
        for name, base, data in self.sc0.assets():
            v[base:base + len(data)] = data
        return v

    def scene(self, objs, itemph):
        sc = copy.copy(self.sc0)
        sc.dmp = self.map                      # Automap: view() setzt die Bits in dieser Karte
        sc.vram_bases = copy.deepcopy(self.sc0.vram_bases)
        sc.pos, sc.dir, sc.objects, sc.itemph = self.pos, self.dir, list(objs), itemph
        return sc

    def compass(self):
        """demo.bas 3240-3270: VDM 1,0,80; VDB 60 + 10 d, 97, 8, 3, c (15 aktiv, sonst 1), chunky: 2 Pixel je Byte."""
        for d in range(4):
            c = 15 if d == self.dir else 1
            for y in range(97, 100):
                for x in range(60 + 10 * d, 68 + 10 * d):
                    a = y * 80 + x // 2
                    self.vram[a] = (self.vram[a] & 0x0F | c << 4) if x % 2 == 0 else (self.vram[a] & 0xF0 | c)

    def frame(self, objs, itemph):
        """VIEW + VCL + Kompass auf dem fortgeschriebenen VRAM. Rückgabe dict(sc, res, vram, ref, content)."""
        sc = self.scene(objs, itemph)
        before = bytes(self.vram)
        res = dbeview.view(sc)
        dbeview.run_vcl(res.bank0(), self.vram, res.p0, bank1=res.bank1())
        ref = dbeview.paint_reference(sc, bytearray(before)) if res.a == 0 else None
        self.compass()
        return dict(sc=sc, res=res, vram=bytes(self.vram), ref=ref, content=bytes(self.map.content), pos=self.pos,
                    dir=self.dir)

    def key(self, k, objs):
        """Taste k: MOVE mit der Objektliste vor dem Zug (wie im Programm), Rückgabe MoveResult oder None (kein Zug)."""
        if k not in ACTION:
            return None
        mv = dbemove.move(self.map, self.pos, self.dir, objs, ACTION[k])
        assert mv.a == 0
        self.pos, self.dir = mv.pos, mv.dir
        return mv


def play(sc0, L, bas, keys, real_objs=None):
    """Tour im Modell. real_objs (VICE): Liste der echten Objektlisten je Prompt (Bytes); sonst das Goblin-Modell.
    Rückgabe (Run, Liste der Bilder); Bild i gehört zum Prompt i (0 = vor der ersten Taste)."""
    r = Run(sc0, L, bas)
    gs = GoblinSim(bas, sc0.dmp.width)
    frames = []
    objs_b = gs.objects()
    fr = r.frame(objs_from_bytes(objs_b), gs.itemph())
    fr.update(key='', mv=None, objs=objs_b, gs=copy.copy(gs))
    frames.append(fr)
    for i, k in enumerate(keys):
        mv = r.key(k, objs_from_bytes(frames[-1]['objs']))
        gs.step(r.pos)
        objs_b = gs.objects()
        fr = r.frame(objs_from_bytes(objs_b), gs.itemph())
        fr.update(key=k, mv=mv, objs=objs_b, gs=copy.copy(gs))
        frames.append(fr)
    return r, frames




# ------------------------------------------------------------------ Prüfung im Modell (ohne VICE)
def check_tour(sc0, segs, frames):
    """Erwartungen der Tour: MOVE-X der Stoß-Schritte, A = 0 überall, Goblins in vielen Bildern sichtbar, Fenster gegen
    paint_reference. Rückgabe Liste Fehlertexte."""
    err, i = [], 0
    for keys, label, want_x in segs:
        i += len(keys)
        mv = frames[i]['mv']
        if want_x is not None and (mv is None or mv.x != want_x):
            err.append(f'Bild {i} ({label}): MOVE X = {mv.x if mv else None}, erwartet {want_x}')
    for k, f in enumerate(frames):
        res = f['res']
        if res.a:
            err.append(f'Bild {k}: VIEW A = {res.a}')
        elif f['ref'] is not None and dbeview.window_bytes(f['sc'], f['vram']) != dbeview.window_bytes(f['sc'], f['ref']):
            err.append(f'Bild {k}: Fenster weicht von paint_reference ab')
    vis = sum(1 for f in frames if f['res'].objvis)
    if vis < 10:
        err.append(f'nur {vis} Bilder mit sichtbarem Goblin')
    return err


def write_pngs(frames, png):
    os.makedirs(png, exist_ok=True)
    ims = []
    for k, f in enumerate(frames):
        im = dbeview.window_image(f['sc'], f['vram'], 2).convert('RGB')
        im.save(os.path.join(png, f'bild_{k:02d}.png'))
        ims.append(im)
    cols = 6
    w, h = ims[0].size
    sheet = Image.new('RGB', (cols * (w + 4), ((len(ims) + cols - 1) // cols) * (h + 4)), (40, 40, 40))
    for i, im in enumerate(ims):
        sheet.paste(im, ((i % cols) * (w + 4), (i // cols) * (h + 4)))
    sheet.save(os.path.join(png, 'szenen.png'))


def check_only(sc0, L, segs, keys, png=None):
    r, frames = play(sc0, L, os.path.join(ROOT, 'demo', 'demo.bas'), keys)
    w = sc0.dmp.width
    n = 0
    for keys_, label, x in segs:
        print(f'{n:3} {keys_:<22} {label}' + (f'  (X = {x})' if x is not None else ''))
        n += len(keys_)
    for k, f in enumerate(frames):
        res = f['res']
        print(f'{k:>2} {f["key"] or "-":1} pos {f["pos"] % w:>2},{f["pos"] // w:>2} dir {f["dir"]} VCL {res.vcllen:>3} VMS {res.vmslen:>4} '
              f'Eintraege {res.x:>2} objvis {res.objvis:03b} A {res.a}' + (f' MOVE X {f["mv"].x}' if f['mv'] else ''))
    err = check_tour(sc0, segs, frames)
    for e in err:
        print('FEHLER:', e)
    if png:
        write_pngs(frames, png)
    print(f'{len(keys)} Tasten, {len(frames)} Bilder, {"alle gleich dem Modell (paint_reference)" if not err else str(len(err)) + " Fehler"}')
    return not err


# ------------------------------------------------------------------ VICE
def w16(b, i):
    return b[i] | b[i + 1] << 8


class Result:
    def __init__(self):
        self.prompts, self.errors, self.ended, self.msgs = [], [], False, []


def run_one(world, d64, boot_prg, port, tmo, segs, keys, shots=None, tag='', control=False):
    """Ein VICE-Lauf. Rückgabe (rc, Result). Je Prompt (GETIN, leerer Puffer, OBJN = 3): Vergleich mit dem Modell."""
    sc0, L = world
    w, h = sc0.dmp.width, sc0.dmp.height
    syms = vm.symbols(os.path.join(vs.VDC, 'build', 'vdcbasic3.sym'))
    import vice_view as vv
    labels = vv.vdc_labels()
    RTS = vv.stub_rts()
    res = Result()
    run = Run(sc0, L, os.path.join(ROOT, 'demo', 'demo.bas'))
    gs = GoblinSim(os.path.join(ROOT, 'demo', 'demo.bas'), w)
    vramf = os.path.join(os.path.dirname(d64), f'vram-{tag}.bin')
    send = list(keys) + ['X']
    work_at = L['map']['work']

    def script(m):
        ev = m.mem(0x300, 2)
        err_at = ev[0] | ev[1] << 8
        bp_err = m.bp(err_at)
        bp_getin = m.bp(GETIN)
        bp_chrin = m.bp(CHRIN)
        m.cmd(f'disable {bp_chrin}')
        timing = {'vd': 0x0D03, 've': RTS, 'ce': syms['vcl'], 'cx': labels['.vcl_done']}
        tids = {k: m.bp(a) for k, a in timing.items()}
        at = {a: k for k, a in timing.items()}
        for i in tids.values():
            m.cmd(f'disable {i}')
        irq = None
        state = dict(i=-1, objs_prev=None, final=False, t={'vd': [], 've': [], 'ce': 0, 'cx': 0})
        while True:
            try:
                pc, _ = m.go()
            except vm.Exited:
                return
            if pc == err_at:
                lo, hi = m.mem(0x3B, 2)
                res.errors.append((m.reg_x(), lo | hi << 8, state['i']))
                m.s.sendall(b'quit\n')
                return
            if pc == CHRIN and state['final']:
                res.ended = True
                m.s.sendall(b'quit\n')
                return
            if pc in at:
                k_ = at[pc]
                if k_ in ('vd', 've'):
                    state['t'][k_].append(vv.stopwatch(m))
                else:
                    state['t'][k_] = vv.stopwatch(m)
                continue
            if pc != GETIN:
                continue
            m.cmd('bank ram00')
            if m.mem(0xD0)[0]:                       # Taste im Puffer: GETIN holt sie gleich
                continue
            if m.mem(0x0C50)[0] != NOBJ:             # nicht das Hauptprogramm
                continue
            i = state['i'] + 1
            # --- Zyklen dieser Taste
            total = vv.stopwatch(m) if i > 0 else 0
            t = state['t']
            cyc = dict(total=total, vcl=(t['cx'] - t['ce']) if t['cx'] and t['ce'] else 0,
                       view=(t['ve'][-1] - t['vd'][-1]) if t['vd'] and t['ve'] else 0,
                       move=(t['ve'][0] - t['vd'][0]) if len(t['vd']) > 1 and len(t['ve']) > 1 else 0)
            # --- Zustand lesen
            pb = m.mem(0x0C00, 0x20)
            ob = m.mem(0x0C50, 1 + 6 * 16)
            buf = m.mem(BUF[0], BUF[1] - BUF[0])
            m.cmd('bank ram01')
            content = bytes(m.mem(work_at + w * h, w * h))
            m.cmd('bank vdc')
            if os.path.exists(vramf):
                os.remove(vramf)
            m.cmd(f'bsave "{vramf}" 0 0000 ffff')
            m.cmd('bank ram00')
            vram = open(vramf, 'rb').read()
            # --- Modell aus dem echten Zustand: Objektliste, ITEMPH; Position und Richtung aus den Tasten (dbemove)
            real = [bytes(ob[1 + 6 * j:7 + 6 * j]) for j in range(ob[0])]
            mv = None
            if i > 0:
                mv = run.key(send[i - 1], objs_from_bytes(state['objs_prev']))
                gs.step(run.pos)
            fr = run.frame(objs_from_bytes(real), pb[8])
            msg = []
            if i > 0 and mv is not None:
                want = segs_x.get(i)
                if want is not None and mv.x != want:
                    msg.append(f'Tour: MOVE X {mv.x}, erwartet {want}')
            rs = fr['res']
            if (rs.a, ) != (0, ):
                msg.append(f'Modell: VIEW A = {rs.a}')
            if real != gs.objects() or pb[8] != gs.itemph():
                msg.append('Objektliste/ITEMPH weichen vom Goblin-Modell ab')
            if (w16(pb, 0x0A), w16(pb, 0x0C), w16(pb, 0x0E), w16(pb, 0x10)) != (rs.p0, rs.vcllen, rs.vmslen, rs.objvis):
                msg.append(f'VCLADR/VCLLEN/VMSLEN/OBJVIS VICE {[hex(w16(pb, j)) for j in (0x0A, 0x0C, 0x0E, 0x10)]} <> '
                           f'{[hex(rs.p0), hex(rs.vcllen), hex(rs.vmslen), hex(rs.objvis)]}')
            b0 = BUF[0]
            if bytes(buf[rs.p0 - b0:rs.p0 - b0 + len(rs.vcl)]) != rs.vcl or bytes(buf[0:len(rs.vms)]) != rs.vms:
                msg.append('Puffer (VCL/VMS) weicht von der Referenz ab')
            model = fr['vram']
            if control and i == 5:
                mm = bytearray(model)
                mm[3 * 80 + 10] ^= 0x11
                model = bytes(mm)
            if vram != model:
                idx = [j for j in range(65536) if vram[j] != model[j]]
                msg.append(f'VRAM {len(idx)} Byte falsch, erstes ${idx[0]:04X}: VICE {vram[idx[0]]:02X} <> Modell {model[idx[0]]:02X}')
            ref_ok = fr['ref'] is None or dbeview.window_bytes(fr['sc'], vram) == dbeview.window_bytes(fr['sc'], fr['ref'])
            if not ref_ok:
                msg.append('Fenster weicht von paint_reference ab')
            if content != fr['content']:
                msg.append('Inhaltsebene der Arbeitskopie (Automap) weicht vom Modell ab')
            res.prompts.append(dict(i=i, key=send[i - 1] if i else '', pos=fr['pos'], dir=fr['dir'], a=rs.a, nv=rs.vcllen,
                                    nm=rs.vmslen, vis=rs.objvis, mv=mv, cyc=cyc, msg=msg, ok=not msg,
                                    ref='ja' if ref_ok else 'NEIN'))
            if shots:
                if irq is None:
                    v = m.mem(0x314, 2)
                    irq = m.bp(v[0] | v[1] << 8)
                    m.cmd(f'disable {irq}')
                m.cmd(f'disable {bp_getin}')
                m.cmd(f'enable {irq}')
                m.go()
                m.go()                               # zwei Interrupts: das Bild ist dargestellt
                m.cmd(f'disable {irq}')
                m.cmd(f'enable {bp_getin}')
                os.makedirs(shots, exist_ok=True)
                m.cmd(f'screenshot "{os.path.join(shots, f"{tag}_{i:02d}.png")}" 2')
            # --- nächste Taste
            state['objs_prev'] = real
            state['i'] = i
            if i == 1 or i == 0:
                for j in tids.values():
                    m.cmd(f'enable {j}')
            if i >= len(send):
                return
            k = send[i]
            if k == 'X':
                state['final'] = True
                m.cmd(f'enable {bp_chrin}')
            state['t'] = {'vd': [], 've': [], 'ce': 0, 'cx': 0}
            m.cmd(f'> 034a {ord(k):02x}')
            m.cmd('> 00d0 01')
            m.cmd('stopwatch reset')

    segs_x = {}
    n = 0
    for keys_, label, want in segs:
        n += len(keys_)
        if want is not None:
            segs_x[n] = want
    args = ['-default', '-warp', '-sounddev', 'dummy', '-80col', '-VDC64KB', '-drive8type', '1581' if d64.endswith('.d81') else '1541',
            '+drive8truedrive', '-trapdevice8', '-8', d64, '-autostartprgmode', '1', '-autostart', boot_prg,
            '-limitcycles', '3000000000']
    _, rc = vm.run_vice(args, port, tmo, script)
    return rc, res


def report(name, res, segs, w=20):
    labels, n = {}, 0
    for keys_, label, _ in segs:
        n += len(keys_)
        labels[n] = label
    print(f'--- {name}')
    print(f'{"#":>2} {"Taste":<5} {"Position":<9} {"Blick":>5} {"X":>1} {"VCL":>4} {"VMS":>5} {"Gob":>3} {"Ref":>4} {"gesamt":>9} {"VIEW":>8} '
          f'{"MOVE":>7} {"VCL":>8}  Schritt')
    for p in res.prompts:
        c = p['cyc']
        print(f'{p["i"]:>2} {p["key"] or "-":<5} {str(p["pos"] % w) + "," + str(p["pos"] // w):>9} {"NOSW"[p["dir"]]:>5} {p["mv"].x if p["mv"] else "-":>1} {p["nv"]:>4} '
              f'{p["nm"]:>5} {bin(p["vis"]).count("1"):>3} {p["ref"]:>4} {c["total"]:>9} {c["view"]:>8} {c["move"]:>7} {c["vcl"]:>8}  '
              f'{labels.get(p["i"], "")}' + ('' if p['ok'] else '  <<< FEHLER'))
        for m_ in p['msg']:
            print('      ', m_)
    ps = [p for p in res.prompts if p['i'] > 0]
    if ps:
        for key, lab in (('total', 'gesamt (Taste bis Prompt)'), ('view', 'VIEW'), ('move', 'MOVE'), ('vcl', 'VCL')):
            v = [p['cyc'][key] for p in ps if p['cyc'][key]]
            if v:
                print(f'    {lab:<26} Mittel {sum(v) // len(v):>9}  min {min(v):>9}  max {max(v):>9}  ({len(v)} Bilder)')
    bad = sum(not p['ok'] for p in res.prompts)
    print(f'    {len(res.prompts)} Prompts, {"alle gleich dem Modell" if not bad else str(bad) + " Fehler"}, BASIC-Fehler {res.errors}, '
          f'Ende (Direktmodus nach X) {"ja" if res.ended else "NEIN"}', flush=True)
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int)
    ap.add_argument('--timeout', type=int, default=900)
    ap.add_argument('--only', choices='ic')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--png')
    ap.add_argument('--shots')
    ap.add_argument('--control', action='store_true')
    ap.add_argument('--no-fast', action='store_true')
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--d81', action='store_true', help='Disk dbe-demo.d81 statt d64 (Laufwerk 1581)')
    ap.add_argument('--budget', nargs='?', const=30, type=int)
    a = ap.parse_args()
    if not a.no_build:
        demo_build.build(OUT, disk=False, budget_step=a.budget, quiet=True)
    world = demo_build.load_world(OUT)
    sc0, L = world
    segs, keys = tour_keys(sc0)
    if a.check or a.png:
        sys.exit(0 if check_only(sc0, L, segs, keys, a.png) else 1)
    # Modell-Vorabprüfung der Tour (schnell), dann VICE
    r_, frames = play(sc0, L, os.path.join(ROOT, 'demo', 'demo.bas'), keys)
    err = check_tour(sc0, segs, frames)
    if err:
        print('\n'.join('FEHLER: ' + e for e in err))
        sys.exit(1)
    files = {n: os.path.join(OUT, 'files', n) for n in os.listdir(os.path.join(OUT, 'files'))}
    boot = demo_build.boot_prg(OUT)
    port = vm.choose_port(a.port)
    bad = 0
    node, blitzc = vm.find_node(), vm.find_blitzc()
    for compiled in (False, True):
        if (a.only == 'c' and not compiled) or (a.only == 'i' and compiled):
            continue
        if compiled and (not node or not blitzc):
            print('kompiliert: SKIP (blitzc nicht gefunden)')
            bad |= 2
            continue
        for fs in ((0,) if a.no_fast else (0, 1)):
            tag = ('c' if compiled else 'i') + ('2' if fs else '1')
            prog = demo_build.program(OUT, compiled=compiled, fs=fs, tag=f'-{tag}')
            disk = os.path.join(OUT, f'run-{tag}.d81' if a.d81 else f'run-{tag}.d64')
            demo_build.make_disk(disk, files, prog, boot)
            rc, res = run_one(world, disk, boot, port, a.timeout, segs, keys, a.shots, tag, a.control)
            name = ('kompiliert (Blitz!, Image 2)' if compiled else 'interpretiert') + (', 2 MHz (FAST)' if fs else ', 1 MHz')
            nb = report(name, res, segs, sc0.dmp.width)
            bad |= (nb != (1 if a.control else 0)) | bool(res.errors) | (not res.ended) | (len(res.prompts) != len(keys) + 1)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
