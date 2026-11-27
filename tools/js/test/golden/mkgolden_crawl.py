#!/usr/bin/env python3
"""Golden files for the parity tests of tools/js/core/crawl/* (docs/specs/P8-js-tools.md, section 4; P8 phase 4).

Runs the Python Crawl converters (tools/crawlconv.py, crawlmap.py, crawl01.py, wallconv.py, crawlsprites.py) on the
test data test/tools/data/ (and, if present, on the Crawl 1.0f disk crawl128-100f.d81 via c1541) and writes
crawl/crawl.json: sha256 of every output file, CLI texts, warnings and error messages, the full 0.1/0.2 comparison report
and the counts of the control checks. Fixtures in crawl/: red.vdc, red1.vdc (inputs of crawlsprites.py, from the repo
dungeoncrawlerjam2025, art/ghost-opaque/, MIT licence), copied if that repo is there.

Paths in recorded texts: the repository root is written as <ROOT>, the temporary directory as /T.

usage: tools/js/test/golden/mkgolden_crawl.py
"""
import contextlib, hashlib, io, json, os, shutil, struct, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.dont_write_bytecode = True
import crawl01  # noqa: E402
import crawlconv  # noqa: E402
import crawlmap  # noqa: E402
import crawlsprites  # noqa: E402
import dbemap  # noqa: E402
import dbeview  # noqa: E402
import wallconv  # noqa: E402

DATA = os.path.join(ROOT, 'test', 'tools', 'data')
FIX = os.path.join(HERE, 'crawl')
D81 = '/home/martin/git/dungeoncrawlerjam2025/crawl128-100f.d81'
RED = '/home/martin/git/dungeoncrawlerjam2025/art/ghost-opaque'
T = None


def sha(b):
    return hashlib.sha256(bytes(b)).hexdigest()


def norm(s):
    s = s.replace(T, '/T') if T else s
    return s.replace(ROOT, '<ROOT>')


def run(fn, args):
    o, e = io.StringIO(), io.StringIO()
    code = None
    with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
        try:
            code = fn(args)
        except SystemExit as x:
            code = x.code
    return {'code': code, 'stdout': norm(o.getvalue()), 'stderr': norm(e.getvalue())}


def dir_sha(d):
    out = {}
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if os.path.isfile(p):
            with open(p, 'rb') as f:
                out[n] = sha(f.read())
    return out


def err_of(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        return f'{type(e).__name__}: {e}'
    return None


def synth(w, h, vals, records, name=b"TEST", gems=0):
    os_ = 5 + 3 * len(records)
    b = bytes([os_, w, h]) + struct.pack("<H", gems)
    for ch, cell in records:
        b += bytes([ord(ch)]) + struct.pack("<H", cell)
    return b"\x3c\x21" + b + bytes(vals) + name


SYNTH = [
    ('basic', (3, 2, [1, 0, 6, 8, 8, 42], [("6", 2), ("8", 3), ("8", 4), ("Z", 5), ("Q", 0)]), {}),
    ('dup6', (2, 1, [0, 0], [("6", 0), ("6", 1)]), {}),
    ('three8', (3, 1, [8, 8, 8], [("6", 0), ("8", 0), ("8", 1), ("8", 2)]), {}),
    ('dupX', (2, 1, [0, 0], [("6", 0), ("X", 0), ("X", 1)]), {}),
    ('nostart', (2, 1, [0, 0], [("8", 0)]), {}),
    ('range', (2, 1, [0, 0], [("6", 2)]), {}),
    ('gemname', (2, 1, [2, 0], [("6", 1)]), {'name': b'\xff', 'gems': 5}),
    ('legend80', (2, 1, [80, 6], [("6", 1)]), {}),
    ('quote', (2, 1, [0, 0], [("6", 1), ("'", 0), ("\x01", 1)]), {}),
]


def crawlmap_goldens():
    with open(os.path.join(DATA, 'crawl128.cd1'), 'rb') as f:
        data = f.read()
    g = {}
    for key, kw in (('default', {}), ('floor_ceiling', {'floor': 3, 'ceiling': 4}), ('items4', {'items': (4,)})):
        m, warn = crawlmap.convert(data, **kw)
        g[key] = {'dmp': sha(dbemap.to_dmp(m)), 'toml': sha(dbemap.to_toml(m, crawlmap.legend_for(m)).encode()), 'warn': warn}
    syn = {}
    for key, args, kw in SYNTH:
        d = synth(*args, **kw)
        try:
            m, warn = crawlmap.convert(d)
        except ValueError as e:
            syn[key] = {'error': str(e)}
            continue
        ent = {'warn': warn, 'dmp': sha(dbemap.to_dmp(m)), 'events': [[e.cell, e.type, e.param] for e in m.events],
               'start': m.start, 'nt': len(m.tiles), 'name': m.name}
        try:
            ent['toml'] = sha(dbemap.to_toml(m, crawlmap.legend_for(m)).encode())
        except ValueError as e:
            ent['legend_error'] = str(e)
        syn[key] = ent
    g['synth'] = syn
    # CLI
    cli = {}
    dmp, tml = os.path.join(T, 'a.dmp'), os.path.join(T, 'a.toml')
    cli['toml'] = run(crawlmap.main, [os.path.join(DATA, 'crawl128.cd1'), dmp, '--toml', tml])
    with open(dmp, 'rb') as f:
        cli['toml']['dmp'] = sha(f.read())
    with open(tml, 'rb') as f:
        cli['toml']['toml'] = sha(f.read())
    src = os.path.join(T, 's.cd1')
    with open(src, 'wb') as f:
        f.write(synth(2, 1, [0, 0], [("6", 1), ("Q", 0)]))
    cli['warning'] = run(crawlmap.main, [src, os.path.join(T, 's.dmp')])
    variants = {'load_dollar': ['--load', '$5000'], 'load_bad': ['--load', 'zz'], 'items_bad': ['--items', '2,x'],
                'items_range': ['--items', '0'], 'floor_range': ['--floor', '300'], 'load_bank1': ['--load', '0x5F00'],
                'items_floor': ['--items', '4', '--floor', '2', '--ceiling', '3']}
    for k, extra in variants.items():
        out = os.path.join(T, f'{k}.dmp')
        r = run(crawlmap.main, [os.path.join(DATA, 'crawl128.cd1'), out] + extra)
        if os.path.exists(out):
            with open(out, 'rb') as f:
                r['dmp'] = sha(f.read())
        cli[k] = r
    cli['missing'] = run(crawlmap.main, [os.path.join(T, 'nothere.cd1'), os.path.join(T, 'x.dmp')])
    g['cli'] = cli
    return g


def crawlconv_goldens(files):
    g = {}
    r = crawlconv.build(files)
    out = os.path.join(T, 'conv')
    crawlconv.write(r, out, as_json=True)
    g['default'] = {'files': dir_sha(out), 'info': r.info, 'nparts': r.nparts}
    parts = {}
    for mp in (1500, 3000, 5000, 100000):
        rr = crawlconv.build(files, max_part=mp)
        parts[str(mp)] = {'nparts': rr.nparts, 'files': {n: sha(d) for n, d in rr.files.items()},
                          'md': sha(crawlconv.report_md(rr).encode())}
    g['parts'] = parts
    g['font3000'] = err_of(lambda: crawlconv.build(files, font_bytes=3000))
    g['font1732'] = {n: sha(d) for n, d in crawlconv.build(files, font_bytes=1732).files.items()}
    nomap = {k: v for k, v in files.items() if k != 'crawl128.cd1'}
    rr = crawlconv.build(nomap)
    g['nomap'] = {'files': {n: sha(d) for n, d in rr.files.items()}, 'md': sha(crawlconv.report_md(rr).encode()), 'info': rr.info}
    # error variants (test_errors and more)
    errs = {}
    f = dict(files)
    bad = bytearray(f['walls.wsm'])
    bad[2 + 10 + 5] ^= 1
    f['walls.wsm'] = bytes(bad)
    errs['wsm_width'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    spr = bytearray(f['ghost.spr'])
    struct.pack_into('<H', spr, 2 + 6 + 15 * 1 + 6, 355)
    f['ghost.spr'] = bytes(spr)
    errs['ghost_side'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    spr = bytearray(f['gem.spr'])
    struct.pack_into('<H', spr, 2 + 6 + 15 * 1 + 8, 5000)
    f['gem.spr'] = bytes(spr)
    errs['gem_dest'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    spr = bytearray(f['gem.spr'])
    struct.pack_into('<H', spr, 2 + 6 + 15 * 0 + 6, 0)
    f['gem.spr'] = bytes(spr)
    errs['gem_char'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    spr = bytearray(f['ghost.spr'])
    spr[2 + 6 + 3] = 0
    f['ghost.spr'] = bytes(spr)
    errs['ghost_flags'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    w = bytearray(f['walls.vdc'])
    struct.pack_into('<H', w, 2 + 1 + 4, 1)
    f['walls.vdc'] = bytes(w)
    errs['walls_size'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    f['walls.wsm'] = b'\x00\xe0XX\x01'
    errs['wsm_magic'] = err_of(lambda: crawlconv.build(f))
    f = dict(files)
    f['gem.spr'] = b'\x00\xeaSP\x02\x00'
    errs['spr_magic'] = err_of(lambda: crawlconv.build(f))
    g['errors'] = errs
    # CLI
    cli = {}
    out = os.path.join(T, 'cli')
    cli['json'] = run(crawlconv.main, ['--dir', DATA, out, '--json'])
    cli['json']['files'] = dir_sha(out)
    cli['missing'] = run(crawlconv.main, ['--dir', os.path.join(T, 'x'), out])
    out2 = os.path.join(T, 'cli2')
    cli['parts'] = run(crawlconv.main, ['--dir', DATA, out2, '--max-part', '3000'])
    cli['parts']['files'] = dir_sha(out2)
    cli['font'] = run(crawlconv.main, ['--dir', DATA, os.path.join(T, 'cli3'), '--font-bytes', '3000'])
    g['cli'] = cli
    return g


def crawl01_goldens(files):
    g = {}
    env = crawl01.Env(files)
    vis, err = env.model.view(env.cells0, env.w, env.h, env.m.start, 0, [])
    g['start_view'] = {'err': err, 'entries': [[k, list(r[0]) if k == 'wall' else [r[0], r[1]['d'], r[1]['s'], r[1]['src']]]
                                               for k, *r in vis]}
    samples = {}
    for pos in env.free[:12]:
        for v in range(4):
            cells = env.visible_cells(pos, v)
            for variant in (0, 1):
                for ghost in [None] + [(c, (v + 1) & 3) for _d, _s, c in cells[:2]]:
                    r = env.one(pos, v, variant, ghost)
                    samples[f'{pos},{v},{variant},{ghost}'] = {k: r[k] for k in ('a', 'outside', 'a01', 'nvis01', 'total', 'vcl', 'vms')}
                    samples[f'{pos},{v},{variant},{ghost}']['ndiff'] = len(r['diff'])
    g['samples'] = samples
    g['visible'] = {f'{p},{v}': [list(x) for x in env.visible_cells(p, v)] for p in env.free[::7] for v in range(4)}
    g['base1'] = sha(env.base1)
    g['base2'] = sha(env.base2)

    # control checks (TestControls): counts of bad views
    def views(e, ghost=False):
        for pos in e.free:
            for v in range(4):
                if ghost:
                    for _d, _s, c in e.visible_cells(pos, v):
                        yield pos, v, (c, 0)
                else:
                    yield pos, v, None

    def count_bad(e, ghost=False, limit=80):
        n = 0
        for i, (pos, v, gh) in enumerate(views(e, ghost)):
            if i >= limit:
                break
            r = e.one(pos, v, 0, gh)
            n += bool(r['diff'] or r['outside'] or r['a'])
        return n
    ctl = {}
    e = crawl01.Env(files)
    ctl['baseline'] = [count_bad(e), count_bad(e, True)]
    e = crawl01.Env(files)
    e.sc.bgfill = 7
    ctl['bgfill'] = count_bad(e)
    e = crawl01.Env(files)
    e.base2[crawlconv.CA + 1732 + 5000] ^= 0x10
    ctl['wall_pixel'] = count_bad(e, limit=400)
    e = crawl01.Env(files)
    for el in e.sc.dvg.elems:
        if el.art == dbeview.ART_OBJ:
            el.anchors[3] = (el.anchors[3][0] + 1, el.anchors[3][1])
    ctl['ghost_anchor'] = [count_bad(e), count_bad(e, True, limit=300)]
    e = crawl01.Env(files)
    for el in e.sc.dvg.elems:
        if el.art == dbeview.ART_OBJ:
            el.anchors[2] = (el.anchors[2][0], el.anchors[2][1] - 1)
    ctl['gem_anchor'] = count_bad(e, limit=400)
    e = crawl01.Env(files)
    e.conv.ghost.images[0].cores = []
    ctl['ghost_cores'] = count_bad(e, True, limit=300)
    g['controls'] = ctl
    # deviating views: text of the report lines (first 20) with the wrong background fill
    e = crawl01.Env(files)
    e.sc.bgfill = 7
    bad = []
    for pos in e.free[:3]:
        r = e.one(pos, 0, 0, None)
        bad.append({'ndiff': len(r['diff']), 'first': [list(x) for x in r['diff'][:3]]})
    g['bgfill_first'] = bad
    # full comparison (quick and full) with the JSON report and the printed lines
    for key, quick in (('quick', True), ('full', False)):
        rep = crawl01.compare(files, quick=quick, workers=max(1, min(4, os.cpu_count() or 1)))
        g[key] = {'json': sha(json.dumps(rep, indent=1, default=list).encode()),
                  'summary': {k: v for k, v in rep.items() if k != 'bad'}, 'nbad': len(rep['bad'])}
    return g


def main():
    global T
    T = tempfile.mkdtemp(prefix='mkgolden-crawl-')
    try:
        files = crawlconv.read_dir(DATA)
        out = {'data': {n: sha(d) for n, d in files.items()}}
        out['crawlmap'] = crawlmap_goldens()
        out['crawlconv'] = crawlconv_goldens(files)
        # wallconv
        wout, ents = wallconv.convert(files['walls.vdc'])
        out['wallconv'] = {'wsm': sha(struct.pack('<H', 0xE000) + bytes(wout)), 'n': len(ents),
                           'equals_data': struct.pack('<H', 0xE000) + bytes(wout) == files['walls.wsm']}
        sys.argv = ['wallconv.py', os.path.join(DATA, 'walls.vdc'), os.path.join(T, 'w.wsm'), '-v', '--load', '0xE100']
        r = run(lambda _a: wallconv.main(), None)
        with open(os.path.join(T, 'w.wsm'), 'rb') as f:
            r['wsm'] = sha(f.read())
        out['wallconv']['cli'] = r
        # crawlsprites (fixtures red.vdc, red1.vdc)
        os.makedirs(FIX, exist_ok=True)
        for n in ('red.vdc', 'red1.vdc'):
            if os.path.exists(os.path.join(RED, n)):
                shutil.copy(os.path.join(RED, n), os.path.join(FIX, n))
        if all(os.path.exists(os.path.join(FIX, n)) for n in ('red.vdc', 'red1.vdc')):
            sd = os.path.join(T, 'spr')
            os.makedirs(sd)
            sys.argv = ['crawlsprites.py', os.path.join(FIX, 'red.vdc'), os.path.join(FIX, 'red1.vdc'), sd]
            r = run(lambda _a: crawlsprites.main(), None)
            r['files'] = dir_sha(sd)
            r['equals_data'] = {n: r['files'][n] == sha(files[n]) for n in ('ghosts.vdc', 'ghost.spr', 'gem.spr')}
            out['crawlsprites'] = r
        out['crawl01'] = crawl01_goldens(files)
        # Crawl 1.0f disk (optional)
        if os.path.exists(D81) and shutil.which('c1541'):
            f81 = crawlconv.read_d81(D81, os.path.join(T, 'd81'))
            rr = crawlconv.build(f81)
            out['d81'] = {'data': {n: sha(d) for n, d in f81.items()}, 'files': {n: sha(d) for n, d in rr.files.items()}}
        with open(os.path.join(FIX, 'crawl.json'), 'w') as f:
            json.dump(out, f, indent=1)
            f.write('\n')
    finally:
        shutil.rmtree(T, ignore_errors=True)
    print(f'{os.path.join(FIX, "crawl.json")} written')


if __name__ == '__main__':
    main()
