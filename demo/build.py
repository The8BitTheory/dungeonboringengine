#!/usr/bin/env python3
"""Demo bauen (docs/specs/P7-crawl.md 8.4): Geometrie, Texturen, Tapete, Sprites, Karte, Programm, Disk.

Aufruf: demo/build.py [--out DIR] [--no-disk] [--budget [N]] [--blitz] [-q]
  Ohne Optionen: alle Dateien nach build/demo/files/, Disk build/demo/dbe-demo.d81 (+ .d64, interpretiert), Bericht
  build/demo/report.md, Belegung build/demo/layout.json.
  --budget [N]  dbeview-Budget über alle Ansichten der Karte (4 Richtungen je begehbarer Zelle) mit 0 bis 3 Goblins;
                N = Zahl zufälliger Goblin-Zustände (Standard 30); A muss überall 0 sein.
  --blitz       zusätzlich die Blitz!-Fassung (Disk build/demo/dbe-demo-blitz.d81; braucht node und blitzc)
  --no-disk     nur die Dateien

Bauschritte (Werkzeuge aus tools/, Quellen in demo/):
  dbegeom view.toml -> DVG, dbetex build (walls/floor/ceil), mkbg.py + dbetex bg (Tapete), Goblin-Blatt + dbespr build
  (goblin, gem), dbemap build -> demo.dmp. Danach: Bank-1-Bereiche (dbemem, schon von den Werkzeugen geprüft),
  VRAM-Pool (Basen dicht ab 9600, Ende <= 46335), DATA-Zeilen von demo.bas gegen die Belegung, Programmgröße (< $9000).
Ausserhalb von demo/ und build/ wird nichts geschrieben; Voraussetzung: Python 3 mit Pillow, c1541 (VICE), VDC-BASIC v3
(VDCBASIC_DIR, nur gelesen: boot/boot.bas, vdcbasic3.bin, test/bastok.py, test/blitzprep.py).
"""
import argparse, json, os, re, shutil, subprocess, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import dbemap, dbetex, dbeview, dbespr, dbemem, vrl
dbeview.dbemap = dbemap

VERSION = open(os.path.join(ROOT, 'VERSION')).read().strip()
VDC = os.environ.get('VDCBASIC_DIR', os.path.expanduser('~/git/vdc-basic'))
OUT = os.path.join(ROOT, 'build', 'demo')
FARFILL = 0x11                  # Fernsicht-Füllbyte (BGSET Y = 1, P2; P6 5.7a): dunkelgrau, 2 Pixel Farbe 1
POOL = (9600, 46335)            # VRAM-Pool: hinter dem Attribut-RAM (Puffer 0 und Textzeilen) bis vor das Bildschirm-RAM
VRL_BUF = 0x9000                # Ladepuffer der VRL-Dateien in Bank 0 (vrl_load in den TOMLs), RXV-Quelle ab +5
BAS_LIMIT = VRL_BUF             # das Programm (interpretiert oder Kompilat) muss darunter enden

# Bank-1-Ladeadressen (Speicherkarte P6 2.4); DMP und S2 stehen in den TOMLs bzw. hier
ADDR = {'dmp': 0x4000, 'work': 0x5000, 'goblin.s2': 0x6000, 'gem.s2': 0x6500, 'walls.dts': 0x8000,
        'demo.dvg': 0xE800, 'floor.dts': 0xEE00, 'ceil.dts': 0xF600, 'land.dbg': 0xFB80}
# Reihenfolge der VRL-Dateien = Reihenfolge der VRAM-Basen = DATA 600
VRL_NAMES = ('walls', 'floor', 'ceil', 'land', 'goblin', 'gem')


def sh(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode:
        sys.exit(f'Fehler ({r.returncode}): {" ".join(cmd)}')
    return r


def tool(name, *args):
    return sh(['python3', '-B', os.path.join(ROOT, 'tools', name)] + list(args), stdout=subprocess.PIPE, text=True).stdout


def rd(path):
    with open(path, 'rb') as f:
        return f.read()


# ------------------------------------------------------------------ Bauen
def make_goblin_png(out):
    """Blatt aus goblin1.bmp: Bilder 0, 2, 4, 6 (4 Phasen), 2fach vergrößert (64 x 64 je Phase), Schwarz (1, 1, 1) -> (0, 0, 0)
    (VDC-Palette), Hintergrund bleibt der Schlüssel 5555FF (goblin.toml)."""
    from PIL import Image
    src = Image.open(os.path.join(HERE, 'art', 'goblin1.bmp')).convert('RGB')
    sheet = Image.new('RGB', (64 * 4, 64), (0x55, 0x55, 0xFF))
    for i, f in enumerate((0, 2, 4, 6)):
        fr = src.crop((f * 32, 0, f * 32 + 32, 32)).resize((64, 64), Image.NEAREST)
        px = fr.load()
        for y in range(64):
            for x in range(64):
                if px[x, y] == (1, 1, 1):
                    px[x, y] = (0, 0, 0)
        sheet.paste(fr, (64 * i, 0))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.save(out)


def build_files(out, log):
    """Alle Dateien der Disk (außer Programm und VDC-BASIC) nach out/files. Rückgabe: Dict Name -> Pfad."""
    F = os.path.join(out, 'files')
    shutil.rmtree(F, ignore_errors=True)
    for d in (F, os.path.join(out, 'tex'), os.path.join(out, 'spr'), os.path.join(out, 'art'), os.path.join(out, 'geom')):
        os.makedirs(d, exist_ok=True)
    D = lambda n: os.path.join(HERE, n)
    log(tool('dbegeom.py', D('view.toml')).strip())
    sh(['python3', '-B', D('mkbg.py'), os.path.join(out, 'art', 'land.png'), '--geom',
        os.path.join(out, 'geom', 'west140.geom.json')], stdout=subprocess.DEVNULL)
    make_goblin_png(os.path.join(out, 'art', 'goblin.png'))
    for t in ('walls', 'floor', 'ceil'):
        log(tool('dbetex.py', 'build', D(t + '.toml')).strip())
    log(tool('dbetex.py', 'bg', D('bg.toml')).strip())
    for s in ('goblin', 'gem'):
        log(tool('dbespr.py', 'build', D(s + '.toml')).strip())
    sh(['python3', '-B', os.path.join(ROOT, 'tools', 'dbemap.py'), 'build', D('demo.toml'),
        os.path.join(F, 'demo.dmp'), '--load', hex(ADDR['dmp'])], stdout=subprocess.DEVNULL)
    src = {'demo.dvg': 'geom/west140.dvg', 'walls.dts': 'tex/walls.dts', 'floor.dts': 'tex/floor.dts',
           'ceil.dts': 'tex/ceil.dts', 'land.dbg': 'tex/land.dbg', 'goblin.s2': 'spr/goblin.s2', 'gem.s2': 'spr/gem.s2',
           'walls.vrl': 'tex/walls.vrl', 'floor.vrl': 'tex/floor.vrl', 'ceil.vrl': 'tex/ceil.vrl',
           'land.vrl': 'tex/land.vrl', 'goblin.vrl': 'spr/goblin.vrl', 'gem.vrl': 'spr/gem.vrl'}
    files = {'demo.dmp': os.path.join(F, 'demo.dmp')}
    for n, s in src.items():
        shutil.copy(os.path.join(out, s), os.path.join(F, n))
        files[n] = os.path.join(F, n)
    return files


def layout(files):
    """Belegung aus den gebauten Dateien: Bank-1-Adressen (Ladeadresse im PRG-Kopf), VRAM-Basen (dicht ab POOL[0])."""
    L = {'bank1': {}, 'vram': {}, 'vrl_buf': VRL_BUF}
    for n, p in files.items():
        if n.endswith('.vrl'):
            continue
        d = rd(p)
        load = d[0] | d[1] << 8
        L['bank1'][n] = [load, len(d) - 2]
    for n, a in ADDR.items():
        if n in L['bank1'] and L['bank1'][n][0] != a:
            sys.exit(f'{n}: Ladeadresse ${L["bank1"][n][0]:04X} im PRG-Kopf, erwartet ${a:04X}')
    base = POOL[0]
    for n in VRL_NAMES:
        load, ver, u, stream = vrl.unpack_file(rd(files[n + '.vrl']))
        if load != VRL_BUF:
            sys.exit(f'{n}.vrl: Ladeadresse ${load:04X}, erwartet ${VRL_BUF:04X} (vrl_load in der TOML)')
        L['vram'][n] = [base, u]
        base += u
    L['pool_end'] = base
    if base > POOL[1]:
        sys.exit(f'VRAM-Pool: Ende {base} > {POOL[1]} (Streichliste P7 8.4: bogen, Goblin-Phasen, Panoramahöhe)')
    # Bank-1-Bereiche und Überlappungen (die Werkzeuge prüfen nur ihren eigenen Bereich)
    spans = sorted((a, a + n, name) for name, (a, n) in L['bank1'].items())
    for (a0, a1, n0), (b0, b1, n1) in zip(spans, spans[1:]):
        if b0 < a1:
            sys.exit(f'Bank 1: {n0} und {n1} überlappen')
    for a0, a1, name in spans:
        err = dbemem.range_error({'demo.dmp': 'dmp', 'goblin.s2': 's2', 'gem.s2': 's2', 'walls.dts': 'wall',
                                  'demo.dvg': 'dvg', 'floor.dts': 'floor', 'ceil.dts': 'ceiling', 'land.dbg': 'dbg'}[name],
                                 a0, a1 - a0)
        if err:
            sys.exit(err)
    m = dbemap.from_dmp(rd(files['demo.dmp']))
    L['map'] = {'w': m.width, 'h': m.height, 'work': ADDR['work'], 'work_end': ADDR['work'] + 2 * m.width * m.height}
    if L['map']['work_end'] > 0x6000:
        sys.exit('Arbeitskopie der Karte reicht über $5FFF')
    if ADDR['work'] < L['bank1']['demo.dmp'][0] + L['bank1']['demo.dmp'][1]:
        sys.exit('Arbeitskopie überlappt die DMP')
    return L


def expected_data(L):
    """DATA-Zeilen von demo.bas: Zeilennummer -> Text (Basen und Setz-Aufrufe)."""
    v = L['vram']
    b1 = L['bank1']
    ex = {600: ','.join(str(v[n][0]) for n in VRL_NAMES)}
    calls = [(11, 0, 0, POOL[0], POOL[1], 0), (12, 0, 0, b1['demo.dvg'][0], 65535, 0),
             (13, 0, 0, b1['walls.dts'][0], v['walls'][0], 0), (13, 1, 0, b1['floor.dts'][0], v['floor'][0], 0),
             (13, 2, 0, b1['ceil.dts'][0], v['ceil'][0], 0),
             (14, 0x33, 1, b1['land.dbg'][0], v['land'][0], FARFILL),       # Y = 1, P2 = Fernsicht-Füllbyte
             (9, 0, 0, b1['goblin.s2'][0], v['goblin'][0], 0), (9, 1, 0, b1['gem.s2'][0], v['gem'][0], 0),
             (10, 1, 2, 0, 0, 0), (1, 1, 0, b1['demo.dmp'][0], ADDR['work'], 0)]
    for i, c in enumerate(calls):
        ex[610 + i] = ','.join(map(str, c))
    return ex


def check_bas(L, bas_path):
    ex = expected_data(L)
    got = {}
    for line in open(bas_path):
        m = re.match(r'(\d+)\s+data\s+(.*)$', line.strip())
        if m:
            got[int(m.group(1))] = m.group(2).replace(' ', '')
    bad = [n for n in ex if got.get(n) != ex[n]]
    if bad:
        msg = '\n'.join(f'{n} data {ex[n]}   (steht in demo.bas: {got.get(n)})' for n in bad)
        sys.exit(f'demo.bas passt nicht zur gebauten Belegung, DATA-Zeilen ändern:\n{msg}')


# ------------------------------------------------------------------ Welt (Modell) für Tests
def load_world(out=OUT):
    """dbeview.Scene aus den gebauten Dateien (genau die Bytes, die auf der Disk liegen), mit Bank-1-Adressen, Basen und
    ITEMSET wie demo.bas. Rückgabe (Scene, Layout)."""
    F = os.path.join(out, 'files')
    L = json.load(open(os.path.join(out, 'layout.json')))
    dvg = dbeview.parse_dvg(rd(os.path.join(F, 'demo.dvg')))
    m = dbemap.from_dmp(rd(os.path.join(F, 'demo.dmp')))
    sc = dbeview.Scene(dvg, m)

    def vram(n):
        return bytes(vrl.decode(vrl.unpack_file(rd(os.path.join(F, n + '.vrl')))[3]))
    for k, n in enumerate(('walls', 'floor', 'ceil')):
        sc.dts[k] = dbetex.from_dts(rd(os.path.join(F, n + '.dts')), vram(n))
        sc.vram_bases['dts'][k] = L['vram'][n][0]
    sc.dbg = dbetex.from_dbg(rd(os.path.join(F, 'land.dbg')))
    sc.dbg_vram = vram('land')
    sc.vram_bases['dbg'] = L['vram']['land'][0]
    for i, n in enumerate(('goblin', 'gem')):
        sc.s2[i] = dbeview.read_s2(rd(os.path.join(F, n + '.s2')), vram(n))
        sc.vram_bases['s2'][i] = L['vram'][n][0]
    sc.itemtab[1] = 2                       # Gegenstand 1 -> Satz 1 (gem)
    sc.bgfill = 0x33
    sc.farfill = FARFILL                    # BGSET Y = 1, P2 = $11 (P6 5.7a): Fernsicht unter Decken dunkelgrau
    sc.ap = 0
    sc.buf = (0x1300, 0x1C00)
    sc.buf_fix = True                       # BUFSET X = 1 (demo.bas 315, P6j): Sprung bei $1300
    sc.vms_bank1 = True
    sc.dts_addr = tuple(L['bank1'][n + '.dts'][0] for n in ('walls', 'floor', 'ceil'))
    sc.s2_addr = (L['bank1']['goblin.s2'][0], L['bank1']['gem.s2'][0]) + (0,) * 6
    sc.automap = True                       # MAPINIT mit Automap-Bit (X = 1)
    sc.check_layout()
    return sc, L


def routes(bas_path):
    """Goblin-Routen aus den DATA-Zeilen 620 ff. von demo.bas: Liste von Listen (x, y)."""
    nums = []
    for line in open(bas_path):
        m = re.match(r'(\d+)\s+data\s+(.*)$', line.strip())
        if m and int(m.group(1)) >= 620:
            nums += [int(x) for x in m.group(2).replace(' ', '').split(',')]
    out, i = [], 0
    while i < len(nums):
        n = nums[i]
        out.append([(nums[i + 1 + 2 * k], nums[i + 2 + 2 * k]) for k in range(n)])
        i += 1 + 2 * n
    return out


def budget(out, step, log):
    """dbeview-Budget: alle begehbaren Zellen x 4 Richtungen, mit 0 Goblins und mit 1 bis 3 Goblins in `step` zufälligen
    Zuständen der Routen (feste Saat), alle Gegenstände. A muss überall 0 sein."""
    import copy
    sc0, L = load_world(out)
    m = sc0.dmp
    R = routes(os.path.join(HERE, 'demo.bas'))
    walk = [c for c in range(m.width * m.height) if not m.tiles[m.cells[c]].flags & dbeview.T_WEG]
    import random
    rnd = random.Random(1)
    states = [()]
    for k in range(step):                   # zufällige Zustände der drei Routen, auch mit nur 1 oder 2 Goblins
        st = tuple(rnd.randrange(len(r)) for r in R)
        states += [st[:1], st[:2], st]
    rep = {'views': 0, 'max_total': 0, 'max_vcl': 0, 'max_vms': 0, 'max_entries': 0, 'bad': []}
    for st in states:
        objs = [dbeview.Obj(R[g][i][1] * m.width + R[g][i][0], 0, 0xFF, (g + 1) & 3, 4) for g, i in enumerate(st)]
        for pos in walk:
            if any(o.cell == pos for o in objs):
                continue
            for d in range(4):
                sc = copy.copy(sc0)
                sc.dmp = copy.deepcopy(m)
                sc.vram_bases = copy.deepcopy(sc0.vram_bases)
                sc.pos, sc.dir, sc.objects = pos, d, list(objs)
                r = dbeview.view(sc)
                rep['views'] += 1
                rep['max_total'] = max(rep['max_total'], r.vcllen + r.vmslen)
                rep['max_vcl'] = max(rep['max_vcl'], r.vcllen)
                rep['max_vms'] = max(rep['max_vms'], r.vmslen)
                rep['max_entries'] = max(rep['max_entries'], r.x)
                if r.a:
                    rep['bad'].append((pos, d, st, r.a))
    log(f'Budget: {rep["views"]} Ansichten, VCL max {rep["max_vcl"]}, VMS max {rep["max_vms"]}, zusammen max '
        f'{rep["max_total"]} von {sc0.buf[1] - sc0.buf[0]}, Einträge max {rep["max_entries"]}, A != 0: {len(rep["bad"])}')
    return rep


# ------------------------------------------------------------------ Programm und Disk
def tok(bas, prg, start=None):
    sh(['python3', '-B', os.path.join(VDC, 'test', 'bastok.py')] + (['--start', start] if start else []) + [bas, prg])


def program(out, compiled=False, fs=None, tag=''):
    """Programm-PRG: interpretiert (getokenisiert ab $4001) oder Blitz!-Kompilat (Image 2). fs: Wert der Zeile 3 (1 =
    2 MHz während VIEW/VCL, 0 = 1 MHz), sonst wie in demo.bas. Rückgabe Pfad oder None (ohne Blitz)."""
    text = open(os.path.join(HERE, 'demo.bas')).read()
    if fs is not None:
        text = text.replace('3 fs=1:', f'3 fs={fs}:', 1)
        assert f'3 fs={fs}:' in text
    bas = os.path.join(out, f'demo{tag}.bas')
    open(bas, 'w').write(text)
    if not compiled:
        prg = os.path.join(out, f'demo{tag}.prg')
        tok(bas, prg, '0x4001')
        size = os.path.getsize(prg) - 2
        if 0x4001 + size > BAS_LIMIT:
            sys.exit(f'Programm endet bei ${0x4001 + size:04X}, Ladepuffer der VRL ab ${BAS_LIMIT:04X}')
        return prg
    sys.path.insert(0, os.path.join(VDC, 'test'))
    import vicemon as vm
    node, blitzc = vm.find_node(), vm.find_blitzc()
    if not node or not blitzc:
        return None
    prep = os.path.join(out, f'demo{tag}-b.bas')
    sh(['python3', '-B', os.path.join(VDC, 'test', 'blitzprep.py'), bas, prep])
    src = os.path.join(out, f'demo{tag}-src.prg')
    tok(prep, src)
    cdir = os.path.join(out, f'blitz{tag}')
    shutil.rmtree(cdir, ignore_errors=True)
    c = subprocess.run([node, blitzc, src, cdir, '--name', 'DEMO'], capture_output=True, text=True)
    cprg = os.path.join(cdir, 'c.prg')
    if c.returncode or not os.path.exists(cprg) or rd(cprg)[:2] != b'\x01\x40':
        sys.exit(f'Blitz!-Compiler rc {c.returncode}: {c.stdout.strip()}')
    size = os.path.getsize(cprg) - 2
    if 0x4001 + size > BAS_LIMIT:
        sys.exit(f'Kompilat endet bei ${0x4001 + size:04X}, Ladepuffer der VRL ab ${BAS_LIMIT:04X}')
    return cprg


def boot_prg(out, run='DEMO'):
    """Boot-Lader von VDC-BASIC v3 (boot/boot.bas) mit `50 RUN"DEMO"` statt `50 NEW`."""
    bas = os.path.join(out, 'boot.bas')
    lines = [(f'50 RUN"{run}"\n' if l.startswith('50 ') else l) for l in open(os.path.join(VDC, 'boot', 'boot.bas'))]
    open(bas, 'w').write(''.join(lines))
    prg = os.path.join(out, 'boot.prg')
    tok(bas, prg)
    return prg


def make_disk(path, files, prog, boot, name='dbe demo'):
    """Disk (d81 oder d64 nach Endung): boot, vdcbasic3, Stub, Lib, demo (Programm), Daten."""
    if os.path.exists(path):
        os.remove(path)
    kind = path.rsplit('.', 1)[1]
    cmd = ['c1541', '-format', f'{name},01', kind, path,
           '-write', boot, 'boot', '-write', os.path.join(VDC, 'vdcbasic3.bin'), 'vdcbasic3',
           '-write', os.path.join(ROOT, 'build', f'dbe{VERSION}.stub'), f'dbe{VERSION}.stub',
           '-write', os.path.join(ROOT, 'build', f'dbe{VERSION}.lib'), f'dbe{VERSION}.lib',
           '-write', prog, 'demo']
    for n, p in files.items():
        cmd += ['-write', p, n]
    sh(cmd, stdout=subprocess.DEVNULL)


def engine_build():
    """Stub und Lib bauen, falls sie fehlen oder älter als die Quellen sind."""
    stub, lib = (os.path.join(ROOT, 'build', f'dbe{VERSION}.{e}') for e in ('stub', 'lib'))
    srcs = [os.path.join(ROOT, 'engine', n) for n in os.listdir(os.path.join(ROOT, 'engine'))]
    if all(os.path.exists(p) for p in (stub, lib)) and \
            min(os.path.getmtime(stub), os.path.getmtime(lib)) >= max(os.path.getmtime(p) for p in srcs):
        return
    sh(['sh', os.path.join(ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)


def report(out, L, files, rep, extra):
    lines = ['# Demo: Belegung und Budget', '', f'Stand der Dateien: {len(files)} Dateien in `build/demo/files/`.', '',
             '## Bank 1', '', '| Datei | Ladeadresse | Länge | Ende |', '|---|---|---|---|']
    for n, (a, ln) in sorted(L['bank1'].items(), key=lambda x: x[1][0]):
        lines.append(f'| {n} | ${a:04X} | {ln} | ${a + ln - 1:04X} |')
    lines += [f'| Arbeitskopie Karte | ${L["map"]["work"]:04X} | {2 * L["map"]["w"] * L["map"]["h"]} | '
              f'${L["map"]["work_end"] - 1:04X} |', '', '## VRAM-Pool', '', '| Name | Basis | Länge |', '|---|---|---|']
    for n in VRL_NAMES:
        b, u = L['vram'][n]
        lines.append(f'| {n} | {b} | {u} |')
    lines += [f'', f'Pool {POOL[0]} .. {POOL[1] - 1} ({POOL[1] - POOL[0]} Byte): belegt {L["pool_end"] - POOL[0]}, '
                   f'frei {POOL[1] - L["pool_end"]} Byte.', '']
    lines += extra
    if rep:
        lines += ['## Budget (dbeview)', '', f'{rep["views"]} Ansichten mit 0 bis 3 Goblins: VCL max {rep["max_vcl"]}, VMS max '
                  f'{rep["max_vms"]}, zusammen max {rep["max_total"]}, Einträge max {rep["max_entries"]}, '
                  f'A != 0 in {len(rep["bad"])} Ansichten.', '']
    open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines))


def build(out=OUT, disk=True, blitz=False, budget_step=None, quiet=False):
    log = (lambda s: None) if quiet else print
    os.makedirs(out, exist_ok=True)
    engine_build()
    files = build_files(out, log)
    L = layout(files)
    check_bas(L, os.path.join(HERE, 'demo.bas'))
    json.dump(L, open(os.path.join(out, 'layout.json'), 'w'), indent=1)
    log(f'VRAM-Pool: {L["pool_end"] - POOL[0]} von {POOL[1] - POOL[0]} Byte belegt, frei {POOL[1] - L["pool_end"]}')
    rep = budget(out, budget_step, log) if budget_step else None
    if rep and rep['bad']:
        sys.exit(f'Budget: {len(rep["bad"])} Ansichten mit A != 0, erste: {rep["bad"][0]}')
    report(out, L, files, rep, [])
    if disk:
        boot = boot_prg(out)
        prog = program(out)
        make_disk(os.path.join(out, 'dbe-demo.d81'), files, prog, boot)
        make_disk(os.path.join(out, 'dbe-demo.d64'), files, prog, boot)
        log(f'{out}/dbe-demo.d81, .d64 ({os.path.getsize(prog) - 2} Byte Programm)')
        if blitz:
            cp = program(out, compiled=True, tag='-c')
            if cp is None:
                log('Blitz!-Fassung: SKIP (node oder blitzc nicht gefunden)')
            else:
                make_disk(os.path.join(out, 'dbe-demo-blitz.d81'), files, cp, boot)
                log(f'{out}/dbe-demo-blitz.d81 ({os.path.getsize(cp) - 2} Byte Programm)')
    return files, L


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--no-disk', action='store_true')
    ap.add_argument('--blitz', action='store_true')
    ap.add_argument('--budget', nargs='?', const=30, type=int)
    ap.add_argument('-q', '--quiet', action='store_true')
    a = ap.parse_args()
    build(a.out, not a.no_disk, a.blitz, a.budget, a.quiet)


if __name__ == '__main__':
    main()
