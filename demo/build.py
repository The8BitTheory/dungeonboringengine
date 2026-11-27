#!/usr/bin/env python3
"""Build the demo (docs/specs/P7-crawl.md 8.4): geometry, textures, wallpaper, sprites, map, program, disk.

Usage: demo/build.py [--out DIR] [--no-disk] [--budget [N]] [--blitz] [-q]
  Without options: all files to build/demo/files/, disk build/demo/dbe-demo.d81 (+ .d64, interpreted), report
  build/demo/report.md, layout build/demo/layout.json.
  --budget [N]  dbeview budget over all views of the map (4 directions per walkable cell) with 0 to 3 goblins;
                N = number of random goblin states (default 30); A must be 0 everywhere.
  --blitz       additionally the Blitz! version (disk build/demo/dbe-demo-blitz.d81; needs node and blitzc)
  --no-disk     files only

Build steps (tools from tools/, sources in demo/):
  dbegeom view.toml -> DVG, dbetex build (walls/floor/ceil), mkbg.py + dbetex bg (wallpaper), goblin sheet + dbespr build
  (goblin, gem), dbemap build -> demo.dmp. Then: bank 1 ranges (dbemem, already checked by the tools),
  VRAM pool (bases packed from 9600, end <= 46335), DATA lines of demo.bas against the layout, program size (< $9000).
Nothing is written outside demo/ and build/; requirements: Python 3 with Pillow, c1541 (VICE), VDC-BASIC v3
(VDCBASIC_DIR, read only: boot/boot.bas, vdcbasic3.bin, test/bastok.py, test/blitzprep.py).
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
FARFILL = 0x11                  # far-view fill byte (BGSET Y = 1, P2; P6 5.7a): dark gray, 2 pixels of color 1
POOL = (9600, 46335)            # VRAM pool: after the attribute RAM (buffer 0 and text lines) up to the screen RAM
VRL_BUF = 0x9000                # load buffer of the VRL files in bank 0 (vrl_load in the TOMLs), RXV source from +5
BAS_LIMIT = VRL_BUF             # the program (interpreted or compiled) must end below it

# Bank 1 load addresses (memory map P6 2.4); DMP and S2 are in the TOMLs or here
ADDR = {'dmp': 0x4000, 'work': 0x5000, 'goblin.s2': 0x6000, 'gem.s2': 0x6500, 'walls.dts': 0x8000,
        'demo.dvg': 0xE800, 'floor.dts': 0xEE00, 'ceil.dts': 0xF600, 'land.dbg': 0xFB80}
# order of the VRL files = order of the VRAM bases = DATA 600
VRL_NAMES = ('walls', 'floor', 'ceil', 'land', 'goblin', 'gem')


def sh(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode:
        sys.exit(f'Error ({r.returncode}): {" ".join(cmd)}')
    return r


def tool(name, *args):
    return sh(['python3', '-B', os.path.join(ROOT, 'tools', name)] + list(args), stdout=subprocess.PIPE, text=True).stdout


def rd(path):
    with open(path, 'rb') as f:
        return f.read()


# ------------------------------------------------------------------ Build
def make_goblin_png(out):
    """Sheet from goblin1.bmp: images 0, 2, 4, 6 (4 phases), scaled 2x (64 x 64 per phase), black (1, 1, 1) -> (0, 0, 0)
    (VDC palette), background stays the key 5555FF (goblin.toml)."""
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
    """All files of the disk (except program and VDC-BASIC) to out/files. Returns: dict name -> path."""
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
    """Layout from the built files: bank 1 addresses (load address in the PRG header), VRAM bases (packed from POOL[0])."""
    L = {'bank1': {}, 'vram': {}, 'vrl_buf': VRL_BUF}
    for n, p in files.items():
        if n.endswith('.vrl'):
            continue
        d = rd(p)
        load = d[0] | d[1] << 8
        L['bank1'][n] = [load, len(d) - 2]
    for n, a in ADDR.items():
        if n in L['bank1'] and L['bank1'][n][0] != a:
            sys.exit(f'{n}: load address ${L["bank1"][n][0]:04X} in the PRG header, expected ${a:04X}')
    base = POOL[0]
    for n in VRL_NAMES:
        load, ver, u, stream = vrl.unpack_file(rd(files[n + '.vrl']))
        if load != VRL_BUF:
            sys.exit(f'{n}.vrl: load address ${load:04X}, expected ${VRL_BUF:04X} (vrl_load in the TOML)')
        L['vram'][n] = [base, u]
        base += u
    L['pool_end'] = base
    if base > POOL[1]:
        sys.exit(f'VRAM pool: end {base} > {POOL[1]} (cut list P7 8.4: arch, goblin phases, panorama height)')
    # bank 1 ranges and overlaps (the tools only check their own range)
    spans = sorted((a, a + n, name) for name, (a, n) in L['bank1'].items())
    for (a0, a1, n0), (b0, b1, n1) in zip(spans, spans[1:]):
        if b0 < a1:
            sys.exit(f'Bank 1: {n0} and {n1} overlap')
    for a0, a1, name in spans:
        err = dbemem.range_error({'demo.dmp': 'dmp', 'goblin.s2': 's2', 'gem.s2': 's2', 'walls.dts': 'wall',
                                  'demo.dvg': 'dvg', 'floor.dts': 'floor', 'ceil.dts': 'ceiling', 'land.dbg': 'dbg'}[name],
                                 a0, a1 - a0)
        if err:
            sys.exit(err)
    m = dbemap.from_dmp(rd(files['demo.dmp']))
    L['map'] = {'w': m.width, 'h': m.height, 'work': ADDR['work'], 'work_end': ADDR['work'] + 2 * m.width * m.height}
    if L['map']['work_end'] > 0x6000:
        sys.exit('working copy of the map extends beyond $5FFF')
    if ADDR['work'] < L['bank1']['demo.dmp'][0] + L['bank1']['demo.dmp'][1]:
        sys.exit('working copy overlaps the DMP')
    return L


def expected_data(L):
    """DATA lines of demo.bas: line number -> text (bases and setter calls)."""
    v = L['vram']
    b1 = L['bank1']
    ex = {600: ','.join(str(v[n][0]) for n in VRL_NAMES)}
    calls = [(11, 0, 0, POOL[0], POOL[1], 0), (12, 0, 0, b1['demo.dvg'][0], 65535, 0),
             (13, 0, 0, b1['walls.dts'][0], v['walls'][0], 0), (13, 1, 0, b1['floor.dts'][0], v['floor'][0], 0),
             (13, 2, 0, b1['ceil.dts'][0], v['ceil'][0], 0),
             (14, 0x33, 1, b1['land.dbg'][0], v['land'][0], FARFILL),       # Y = 1, P2 = far-view fill byte
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
        msg = '\n'.join(f'{n} data {ex[n]}   (in demo.bas: {got.get(n)})' for n in bad)
        sys.exit(f'demo.bas does not match the built layout, change the DATA lines:\n{msg}')


# ------------------------------------------------------------------ World (model) for tests
def load_world(out=OUT):
    """dbeview.Scene from the built files (exactly the bytes on the disk), with bank 1 addresses, bases and
    ITEMSET as in demo.bas. Returns (scene, layout)."""
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
    sc.itemtab[1] = 2                       # item 1 -> set 1 (gem)
    sc.bgfill = 0x33
    sc.farfill = FARFILL                    # BGSET Y = 1, P2 = $11 (P6 5.7a): far view under ceilings dark gray
    sc.ap = 0
    sc.buf = (0x1300, 0x1C00)
    sc.buf_fix = True                       # BUFSET X = 1 (demo.bas 315, P6j): jump at $1300
    sc.vms_bank1 = True
    sc.dts_addr = tuple(L['bank1'][n + '.dts'][0] for n in ('walls', 'floor', 'ceil'))
    sc.s2_addr = (L['bank1']['goblin.s2'][0], L['bank1']['gem.s2'][0]) + (0,) * 6
    sc.automap = True                       # MAPINIT with automap bit (X = 1)
    sc.check_layout()
    return sc, L


def routes(bas_path):
    """Goblin routes from the DATA lines 620 ff. of demo.bas: list of lists (x, y)."""
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
    """dbeview budget: all walkable cells x 4 directions, with 0 goblins and with 1 to 3 goblins in `step` random
    states of the routes (fixed seed), all items. A must be 0 everywhere."""
    import copy
    sc0, L = load_world(out)
    m = sc0.dmp
    R = routes(os.path.join(HERE, 'demo.bas'))
    walk = [c for c in range(m.width * m.height) if not m.tiles[m.cells[c]].flags & dbeview.T_WEG]
    import random
    rnd = random.Random(1)
    states = [()]
    for k in range(step):                   # random states of the three routes, also with only 1 or 2 goblins
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
    log(f'Budget: {rep["views"]} views, VCL max {rep["max_vcl"]}, VMS max {rep["max_vms"]}, total max '
        f'{rep["max_total"]} of {sc0.buf[1] - sc0.buf[0]}, entries max {rep["max_entries"]}, A != 0: {len(rep["bad"])}')
    return rep


# ------------------------------------------------------------------ Program and disk
def tok(bas, prg, start=None):
    sh(['python3', '-B', os.path.join(VDC, 'test', 'bastok.py')] + (['--start', start] if start else []) + [bas, prg])


def program(out, compiled=False, fs=None, tag=''):
    """Program PRG: interpreted (tokenized from $4001) or Blitz! compilation (image 2). fs: value of line 3 (1 =
    2 MHz during VIEW/VCL, 0 = 1 MHz), otherwise as in demo.bas. Returns path or None (without Blitz)."""
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
            sys.exit(f'Program ends at ${0x4001 + size:04X}, VRL load buffer from ${BAS_LIMIT:04X}')
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
    c = subprocess.run([node, blitzc, src, cdir, '--name', 'DEMO', '--runtime', os.environ.get('BLITZ_RUNTIME', 'improved')], capture_output=True, text=True)
    cprg = os.path.join(cdir, 'c.prg')
    if c.returncode or not os.path.exists(cprg) or rd(cprg)[:2] != b'\x01\x40':
        sys.exit(f'Blitz! compiler rc {c.returncode}: {c.stdout.strip()}')
    size = os.path.getsize(cprg) - 2
    if 0x4001 + size > BAS_LIMIT:
        sys.exit(f'Compilation ends at ${0x4001 + size:04X}, VRL load buffer from ${BAS_LIMIT:04X}')
    return cprg


def boot_prg(out, run='DEMO'):
    """Boot loader of VDC-BASIC v3 (boot/boot.bas) with `50 RUN"DEMO"` instead of `50 NEW`."""
    bas = os.path.join(out, 'boot.bas')
    lines = [(f'50 RUN"{run}"\n' if l.startswith('50 ') else l) for l in open(os.path.join(VDC, 'boot', 'boot.bas'))]
    open(bas, 'w').write(''.join(lines))
    prg = os.path.join(out, 'boot.prg')
    tok(bas, prg)
    return prg


def make_disk(path, files, prog, boot, name='dbe demo'):
    """Disk (d81 or d64 by extension): boot, vdcbasic3, stub, lib, demo (program), data."""
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
    """Build stub and lib if they are missing or older than the sources."""
    stub, lib = (os.path.join(ROOT, 'build', f'dbe{VERSION}.{e}') for e in ('stub', 'lib'))
    srcs = [os.path.join(ROOT, 'engine', n) for n in os.listdir(os.path.join(ROOT, 'engine'))]
    if all(os.path.exists(p) for p in (stub, lib)) and \
            min(os.path.getmtime(stub), os.path.getmtime(lib)) >= max(os.path.getmtime(p) for p in srcs):
        return
    sh(['sh', os.path.join(ROOT, 'engine', 'build.sh')], stdout=subprocess.DEVNULL)


def report(out, L, files, rep, extra):
    lines = ['# Demo: layout and budget', '', f'Files: {len(files)} files in `build/demo/files/`.', '',
             '## Bank 1', '', '| File | Load address | Length | End |', '|---|---|---|---|']
    for n, (a, ln) in sorted(L['bank1'].items(), key=lambda x: x[1][0]):
        lines.append(f'| {n} | ${a:04X} | {ln} | ${a + ln - 1:04X} |')
    lines += [f'| Working copy of map | ${L["map"]["work"]:04X} | {2 * L["map"]["w"] * L["map"]["h"]} | '
              f'${L["map"]["work_end"] - 1:04X} |', '', '## VRAM pool', '', '| Name | Base | Length |', '|---|---|---|']
    for n in VRL_NAMES:
        b, u = L['vram'][n]
        lines.append(f'| {n} | {b} | {u} |')
    lines += [f'', f'Pool {POOL[0]} .. {POOL[1] - 1} ({POOL[1] - POOL[0]} bytes): used {L["pool_end"] - POOL[0]}, '
                   f'free {POOL[1] - L["pool_end"]} bytes.', '']
    lines += extra
    if rep:
        lines += ['## Budget (dbeview)', '', f'{rep["views"]} views with 0 to 3 goblins: VCL max {rep["max_vcl"]}, VMS max '
                  f'{rep["max_vms"]}, total max {rep["max_total"]}, entries max {rep["max_entries"]}, '
                  f'A != 0 in {len(rep["bad"])} views.', '']
    open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines))


def build(out=OUT, disk=True, blitz=False, budget_step=None, quiet=False):
    log = (lambda s: None) if quiet else print
    os.makedirs(out, exist_ok=True)
    engine_build()
    files = build_files(out, log)
    L = layout(files)
    check_bas(L, os.path.join(HERE, 'demo.bas'))
    json.dump(L, open(os.path.join(out, 'layout.json'), 'w'), indent=1)
    log(f'VRAM pool: {L["pool_end"] - POOL[0]} of {POOL[1] - POOL[0]} bytes used, free {POOL[1] - L["pool_end"]}')
    rep = budget(out, budget_step, log) if budget_step else None
    if rep and rep['bad']:
        sys.exit(f'Budget: {len(rep["bad"])} views with A != 0, first: {rep["bad"][0]}')
    report(out, L, files, rep, [])
    if disk:
        boot = boot_prg(out)
        prog = program(out)
        make_disk(os.path.join(out, 'dbe-demo.d81'), files, prog, boot)
        make_disk(os.path.join(out, 'dbe-demo.d64'), files, prog, boot)
        log(f'{out}/dbe-demo.d81, .d64 ({os.path.getsize(prog) - 2} bytes program)')
        if blitz:
            cp = program(out, compiled=True, tag='-c')
            if cp is None:
                log('Blitz! version: SKIP (node or blitzc not found)')
            else:
                make_disk(os.path.join(out, 'dbe-demo-blitz.d81'), files, cp, boot)
                log(f'{out}/dbe-demo-blitz.d81 ({os.path.getsize(cp) - 2} bytes program)')
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
