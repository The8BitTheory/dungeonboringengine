#!/usr/bin/env python3
"""Golden files for the parity tests of tools/js/core/tex.js, spr.js, persp.js and the demo generators
(docs/specs/P8-js-tools.md, section 4; P8 phase 2).

Runs the Python reference (tools/dbetex.py, dbespr.py, dbetexdemo.py, dbesprdemo.py, dbeview.py) and writes:
  tex/              fixtures the JS side cannot make without dbegeom (P8 phase 2 ports it in parallel):
                    build/demo/geom/west140.geom.json + .dvg (demo/view.toml), build/demo/art/land.png + goblin.png
                    (demo/mkbg.py, demo/build.py make_goblin_png), w136.geom.json + .dvg (default_geom(136, 92)),
                    t_atlas.png (dbegeom.write_pngs paint template of the Westwood 140 x 96 geometry)
  tex.json          per project (example projects, demo/, dbetexdemo/dbesprdemo outputs): sha256 of every output file
                    of `build`/`bg` (DTS, VRL, DBG, S2, report JSON/markdown), decoded RGB pixels of the previews,
                    stdout/stderr; sha256 of the demo generator outputs (PNG by decoded RGBA pixels); hashes of
                    dbeview.build_demo_assets; CLI texts of dump/budget/check; error messages of TOML variants.

Paths in recorded texts: the repository root is written as <ROOT>, the temporary directory as /T (the JS tests use
these virtual paths).

usage: tools/js/test/golden/mkgolden_tex.py
"""
import contextlib, hashlib, importlib.util, io, json, os, shutil, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.dont_write_bytecode = True
import dbegeom  # noqa: E402
import dbetex  # noqa: E402
import dbespr  # noqa: E402
import dbetexdemo  # noqa: E402
import dbesprdemo  # noqa: E402
import dbeview  # noqa: E402
import vrl  # noqa: E402
from PIL import Image  # noqa: E402

FIX = os.path.join(HERE, 'tex')
T = None          # real temporary directory, written as /T


def sha(b):
    return hashlib.sha256(bytes(b)).hexdigest()


def norm(s):
    s = s.replace(T, '/T') if T else s
    return s.replace(ROOT, '<ROOT>')


def rd(p):
    with open(p, 'rb') as f:
        return f.read()


def put(rel, data):
    p = os.path.join(FIX, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(bytes(data))


def img_sha(path_or_im, mode):
    im = Image.open(path_or_im) if isinstance(path_or_im, str) else path_or_im
    im = im.convert(mode)
    return [im.width, im.height, sha(im.tobytes())]


def run(mod, args):
    """mod.main(args) in-process -> (code, stdout, stderr)."""
    o, e = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
        code = mod.main(args)
    return code, norm(o.getvalue()), norm(e.getvalue())


def outputs(d):
    """sha256 of all files of an output directory; PNG files as decoded RGB pixels."""
    files, previews = {}, {}
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if n.endswith('.png'):
            previews[n] = img_sha(p, 'RGB')
        else:
            files[n] = sha(rd(p))
    return files, previews


def project(cmd, toml, mod=dbetex):
    """Builds one project into a fresh output directory."""
    out = tempfile.mkdtemp(dir=T)
    code, so, se = run(mod, [cmd, toml, '--out', out])
    assert code == 0, (toml, se)
    files, previews = outputs(out)
    return {'cmd': cmd, 'tool': 'tex' if mod is dbetex else 'spr', 'toml': norm(toml), 'files': files,
            'previews': previews, 'stdout': so, 'stderr': se}


def gen_files(d):
    """Demo generator outputs: bytes sha256, PNG by decoded RGBA pixels."""
    res = {}
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        res[n] = {'rgba': img_sha(p, 'RGBA')} if n.endswith('.png') else {'sha': sha(rd(p))}
    return res


def fixtures():
    """Geometry/art the JS tests cannot produce without dbegeom (and the demo build steps)."""
    shutil.rmtree(FIX, ignore_errors=True)
    os.makedirs(FIX)
    g = os.path.join(FIX, 'build', 'demo', 'geom')
    subprocess.run([sys.executable, '-B', os.path.join(ROOT, 'tools', 'dbegeom.py'), os.path.join(ROOT, 'demo', 'view.toml'),
                    '--out', g], check=True, stdout=subprocess.DEVNULL)
    for n in os.listdir(g):                                     # keep only what the TOMLs reference
        if n not in ('west140.geom.json', 'west140.dvg'):
            p = os.path.join(g, n)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    art = os.path.join(FIX, 'build', 'demo', 'art')
    os.makedirs(art)
    subprocess.run([sys.executable, '-B', os.path.join(ROOT, 'demo', 'mkbg.py'), os.path.join(art, 'land.png'), '--geom',
                    os.path.join(g, 'west140.geom.json')], check=True, stdout=subprocess.DEVNULL)
    spec = importlib.util.spec_from_file_location('demo_build', os.path.join(ROOT, 'demo', 'build.py'))
    bmod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bmod)
    bmod.make_goblin_png(os.path.join(art, 'goblin.png'))
    js, dvg = dbetexdemo.default_geom(136, 92)
    put('w136.geom.json', json.dumps(js, separators=(',', ':')).encode())
    put('w136.dvg', dvg)
    geo = dbegeom.Geometry(dbegeom.parse_config({'viewport': {'preset': 'westwood', 'width_px': 140, 'height': 96}}))
    geo.atlas_size = dbegeom.layout_atlas(geo)
    tdir = tempfile.mkdtemp(dir=T)
    dbegeom.write_pngs(geo, tdir, 't', 1, geo.atlas_size)
    shutil.copy(os.path.join(tdir, 't_atlas.png'), os.path.join(FIX, 't_atlas.png'))
    # default geometry of the demo generators = docs/specs/examples/tex/west140.*
    g0, d0 = dbetexdemo.default_geom()
    ex = os.path.join(ROOT, 'docs', 'specs', 'examples', 'tex')
    assert json.dumps(g0, separators=(',', ':')).encode() == rd(os.path.join(ex, 'west140.geom.json'))
    assert d0 == rd(os.path.join(ex, 'west140.dvg'))


def demo_tree():
    """/T/demo (copy of demo/*.toml + art) and /T/build/demo (fixtures) as the demo TOMLs expect them."""
    d = os.path.join(T, 'demo')
    shutil.copytree(os.path.join(ROOT, 'demo', 'art'), os.path.join(d, 'art'))
    for n in ('walls', 'floor', 'ceil', 'bg', 'goblin', 'gem'):
        shutil.copy(os.path.join(ROOT, 'demo', n + '.toml'), d)
    shutil.copytree(os.path.join(FIX, 'build'), os.path.join(T, 'build'))
    return d


# ---------------------------------------------------------------- error and warning cases

# (generator dir, toml, command, [old, new]) - old is replaced once (first occurrence)
ERROR_CASES = [
    ('tex', 'walls.toml', 'build', ['kind       = "wall"', 'kind       = "door"']),
    ('tex', 'walls.toml', 'build', ['[texset]\n', '[texset]\nfoo = 1\n']),
    ('tex', 'walls.toml', 'build', ['png  = "brick_atlas.png"', 'png  = "brick_atlas.png"\naseprite = "window.json"']),
    ('tex', 'walls.toml', 'build', ['name = "grating"', 'name = "brick"']),
    ('tex', 'walls.toml', 'build', ['load       = 0x8000', 'load       = 0x10000']),
    ('tex', 'walls.toml', 'build', ['load       = 0x8000', 'load       = 0xA000']),
    ('tex', 'walls.toml', 'build', ['pool_bytes = 26624', 'pool_bytes = 26624\nmax_cores = 5']),
    ('tex', 'walls.toml', 'build', ['tag      = "arch"', 'tag      = "nope"']),
    ('tex', 'walls.toml', 'build', ['format  = "dbetex"', 'format  = "dbetx"']),
    ('tex', 'walls.toml', 'build', ['geom       = "west140.geom.json"', 'geom       = "missing.json"']),
    ('tex', 'walls.toml', 'build', ['png  = "brick_atlas.png"', 'png  = "missing.png"']),
    ('tex', 'walls.toml', 'build', ['png  = "brick_atlas.png"', 'png  = "brick_atlas.png"\nempty = ["nothing"]']),
    ('tex', 'walls.toml', 'build', ['png  = "brick_atlas.png"', 'png  = "sky.png"']),
    ('tex', 'walls.toml', 'build', ['name       = "demo_walls"\n', '']),
    ('tex', 'walls.toml', 'build', ['kind       = "wall"', 'kind       = "floor"']),
    ('tex', 'walls.toml', 'build', ['png  = "grating_atlas.png"', 'png  = "grating_atlas.png"\nfoo = 2']),
    ('tex', 'walls.toml', 'build', ['vrl_load   = 0x4000', 'vrl_load   = "x"']),
    ('tex', 'walls.toml', 'build', ['tag      = "arch"', 'frame    = 7']),
    ('tex', 'floor.toml', 'build', ['load = 0xEE00', 'load = 0xF500']),
    ('tex', 'floor.toml', 'build', ['load = 0xEE00', 'load = 0xEE00\nkey = "zz"']),
    ('tex', 'floor.toml', 'build', ['load = 0xEE00', 'load = 0xEE00\nalpha_threshold = 300']),
    ('tex', 'bg.toml', 'bg', ['offsets = "auto"', 'offsets = [0, 1, 2]']),
    ('tex', 'bg.toml', 'bg', ['y0      = "horizon"', 'y0      = 90']),
    ('tex', 'bg.toml', 'bg', ['y0      = "horizon"', 'y0      = "top"']),
    ('tex', 'bg.toml', 'bg', ['above   = 3', 'above   = 16']),
    ('tex', 'bg.toml', 'bg', ['wrap    = true', 'wrap    = false\n']),
    ('tex', 'bg.toml', 'bg', ['offsets = "auto"', 'offsets = [0, 70, 140, 270]\n']),
    ('tex', 'bg.toml', 'bg', ['wrap    = true', 'wrap    = false\nlevel = 1']),
    ('tex', 'bg.toml', 'bg', ['png     = "sky.png"', 'png     = "brick_atlas.png"']),
    ('tex', 'bg.toml', 'bg', ['png     = "sky.png"', 'png     = "window.png"']),
    ('tex', 'bg.toml', 'bg', ['load    = 0xFB80', 'load    = 0xFBF0']),
    ('spr', 'blob.toml', 'build', ['angles    = 4', 'angles    = 5']),
    ('spr', 'blob.toml', 'build', ['angles    = 4', 'angles    = 4\nangle_map = [0, 1, 2, 4]']),
    ('spr', 'blob.toml', 'build', ['angles    = 4', 'angles    = 4\nmirror = { 1 = 1 }']),
    ('spr', 'blob.toml', 'build', ['angles    = 4', 'angles    = 4\nmirror = { x = 1 }']),
    ('spr', 'blob.toml', 'build', ['angles    = 4', 'angles    = 4\nderive = "x"']),
    ('spr', 'blob.toml', 'build', ['phases    = 2', 'phases    = 33']),
    ('spr', 'blob.toml', 'build', ['phases    = 2', 'phases    = 1']),
    ('spr', 'blob.toml', 'build', ['phases    = 2', 'phases    = 2\nbogus = 1']),
    ('spr', 'blob.toml', 'build', ['aseprite = "blob.json"', 'aseprite = "blob.json"\npng = "gem.png"']),
    ('spr', 'blob.toml', 'build', ['aseprite = "blob.json"', 'aseprite = "missing.json"']),
    ('spr', 'blob.toml', 'build', ['angles    = 4', 'angles    = 2']),
    ('spr', 'blob.toml', 'build', ['load      = 0x6000', 'load      = 0x7800']),
    ('spr', 'blob.toml', 'build', ['format  = "dbespr"', 'format  = "dbetex"']),
    ('spr', 'gem.toml', 'build', ['box   = [1, 1, 12, 10]', 'box   = [1, 1, 12]']),
    ('spr', 'gem.toml', 'build', ['depth = 1', 'depth = 4']),
    ('spr', 'gem.toml', 'build', ['foot  = [6, 9]', 'foot  = [60, 9]']),
    ('spr', 'gem.toml', 'build', ['foot  = [6, 9]', 'foot  = [6]']),
    ('spr', 'gem.toml', 'build', ['phase = 1', 'phase = 0']),
    ('spr', 'gem.toml', 'build', ['angle = 0', 'angle = 1']),
    ('spr', 'gem.toml', 'build', ['angle = 0', 'angle = 9']),
    ('spr', 'gem.toml', 'build', ['box   = [1, 1, 12, 10]', 'box   = [60, 1, 12, 10]']),
    ('spr', 'gem.toml', 'build', ['box   = [1, 1, 12, 10]', 'box   = [1, 20, 12, 10]']),
    ('spr', 'gem.toml', 'build', ['[source]\npng = "gem.png"\n', '[source]\npng = "gem.png"\n[[image]]\nbox = [0, 0, 1, 1]\nphase = 0\nangle = 0\n']),
]


def errors(gdirs):
    res = []
    for gen, toml, cmd, (old, new) in ERROR_CASES:
        src = os.path.join(gdirs[gen], toml)
        with open(src, encoding='utf-8') as f:
            text = f.read()
        assert old in text, (toml, old)
        bad = os.path.join(gdirs[gen], 'case.toml')
        with open(bad, 'w', encoding='utf-8') as f:
            f.write(text.replace(old, new, 1))
        out = tempfile.mkdtemp(dir=T)
        mod = dbetex if gen == 'tex' else dbespr
        code, so, se = run(mod, [cmd, bad, '--out', out, '--no-preview'] if cmd == 'build' else [cmd, bad, '--out', out])
        res.append({'gen': gen, 'toml': toml, 'cmd': cmd, 'replace': [old, new], 'code': code, 'stdout': so, 'stderr': se})
        os.remove(bad)
    return res


# ---------------------------------------------------------------- CLI texts (dump, budget, check, preview)

def cli_texts(tex_out, spr_out, gdirs):
    w = os.path.join(tex_out, 'demo_walls')
    s = os.path.join(spr_out, 'blob')
    cases = [
        ('tex', ['dump', w + '.dts', '--vrl', w + '.vrl']),
        ('tex', ['dump', w + '.dts', '--vrl', w + '.vrl', '--json']),
        ('tex', ['dump', w + '.dts']),
        ('tex', ['dump', os.path.join(tex_out, 'demo_floor.dts'), '--json']),
        ('tex', ['dump', os.path.join(tex_out, 'demo_sky.dbg')]),
        ('tex', ['dump', os.path.join(tex_out, 'demo_sky.dbg'), '--vrl', os.path.join(tex_out, 'demo_sky.vrl'), '--json']),
        ('tex', ['dump', w + '.dts', '--vrl', os.path.join(tex_out, 'demo_floor.vrl')]),
        ('tex', ['dump', s + '.s2']),
        ('tex', ['budget', w + '.dts', os.path.join(tex_out, 'demo_floor.dts'), os.path.join(tex_out, 'demo_ceil.dts'),
                 os.path.join(tex_out, 'demo_sky.dbg'), s + '.s2', '--pool', '30000', '--pool-start', '$2000']),
        ('tex', ['budget', w + '.dts', os.path.join(tex_out, 'demo_floor.dts'), '--pool', '20000', '--json',
                 '--pool-start', '0x100', '--vms-buffer', '100']),
        ('tex', ['budget', w + '.dts', '--pool', '100']),
        ('tex', ['check', os.path.join(ROOT, 'docs', 'specs', 'examples', 'demo.toml'), '--walls', w + '.dts',
                 '--floors', os.path.join(tex_out, 'demo_floor.dts'), '--ceils', os.path.join(tex_out, 'demo_ceil.dts'),
                 '--dvg', os.path.join(gdirs['tex'], 'west140.dvg')]),
        ('tex', ['check', os.path.join(ROOT, 'docs', 'specs', 'examples', 'demo.toml'), '--walls',
                 os.path.join(tex_out, 'demo_floor.dts'), '--floors', os.path.join(tex_out, 'demo_floor.dts')]),
        ('spr', ['dump', s + '.s2', '--vrl', s + '.vrl']),
        ('spr', ['dump', s + '.s2', '--vrl', s + '.vrl', '--json']),
        ('spr', ['dump', os.path.join(spr_out, 'gem.s2')]),
        ('spr', ['budget', s + '.s2', os.path.join(spr_out, 'gem.s2'), '--pool', '10000']),
        ('spr', ['dump', s + '.s2', '--vrl', os.path.join(spr_out, 'gem.vrl')]),
        ('spr', ['dump', w + '.dts']),
    ]
    res = []
    for tool, args in cases:
        code, so, se = run(dbetex if tool == 'tex' else dbespr, args)
        res.append({'tool': tool, 'args': [norm(a) for a in args], 'code': code, 'stdout': so, 'stderr': se})
    # preview command: image pixels
    prev = []
    for d, ph, an in ((1, 0, 0), (2, 1, 1), (3, 0, 2), (1, 1, 3)):
        out = os.path.join(T, f'p{d}{ph}{an}.png')
        code, so, se = run(dbespr, ['preview', s + '.s2', '--vrl', s + '.vrl', '--geom', os.path.join(gdirs['spr'], 'west140.geom.json'),
                                    '--d', str(d), '--phase', str(ph), '--angle', str(an), '--out', out])
        prev.append({'args': [d, ph, an], 'code': code, 'stdout': so, 'image': img_sha(out, 'RGB')})
    return res, prev


def demo_assets():
    d = tempfile.mkdtemp(dir=T)
    a = dbeview.build_demo_assets(d)
    r = {'dvg': sha(a.dvg_prg), 'dbg': sha(dbetex.build_background(dbetex.load_bg_conf(os.path.join(d, 'bg.toml')))[0]),
         'dbg_vram': sha(a.dbg_vram)}
    for n in ('walls', 'floor', 'ceil'):
        ts = getattr(a, n)
        r[n] = sha(dbetex.to_dts(ts))
        r[n + '_vram'] = sha(ts.vram)
    r['sprites'] = [None if s is None else [sha(dbespr.to_s2(s)), sha(s.vram)] for s in a.sprites]
    r['files'] = gen_files_sel(d, ('grass_atlas.png', 'puddle_atlas.png', 'hole_atlas.png', 'floor3.toml', 'ceil3.toml'))
    # sprite_pixels samples
    r['sprite_pixels'] = {f'{k}_{w}_{h}_{ai}_{f}': sha(json.dumps(dbeview.sprite_pixels(k, w, h, ai, f)).encode())
                          for k in ('blob', 'gem') for (w, h) in ((8, 6), (14, 20), (40, 31)) for ai in range(4) for f in range(2)}
    return r


def gen_files_sel(d, names):
    return {n: ({'rgba': img_sha(os.path.join(d, n), 'RGBA')} if n.endswith('.png') else {'sha': sha(rd(os.path.join(d, n)))})
            for n in names}


def main():
    global T
    tmp = tempfile.TemporaryDirectory()
    T = os.path.realpath(tmp.name)
    fixtures()
    gold = {'projects': []}
    ex = os.path.join(ROOT, 'docs', 'specs', 'examples')
    for n in ('walls', 'floor', 'ceil'):
        gold['projects'].append(project('build', os.path.join(ex, 'tex', n + '.toml')))
    gold['projects'].append(project('bg', os.path.join(ex, 'tex', 'bg.toml')))
    for n in ('blob', 'blob_m', 'gem'):
        gold['projects'].append(project('build', os.path.join(ex, 'spr', n + '.toml'), dbespr))
    dd = demo_tree()
    for n in ('walls', 'floor', 'ceil'):
        gold['projects'].append(project('build', os.path.join(dd, n + '.toml')))
    gold['projects'].append(project('bg', os.path.join(dd, 'bg.toml')))
    for n in ('goblin', 'gem'):
        gold['projects'].append(project('build', os.path.join(dd, n + '.toml'), dbespr))
    # demo generators (default geometry) and their builds
    gdirs = {'tex': os.path.join(T, 'tex'), 'spr': os.path.join(T, 'spr')}
    dbetexdemo.generate(gdirs['tex'])
    dbesprdemo.generate(gdirs['spr'])
    gold['texdemo'] = gen_files(gdirs['tex'])
    gold['sprdemo'] = gen_files(gdirs['spr'])
    tex_out, spr_out = os.path.join(T, 'tex_out'), os.path.join(T, 'spr_out')
    for n in ('walls', 'floor', 'ceil'):
        p = project('build', os.path.join(gdirs['tex'], n + '.toml'))
        gold['projects'].append(p)
        run(dbetex, ['build', os.path.join(gdirs['tex'], n + '.toml'), '--out', tex_out, '--no-preview'])
    gold['projects'].append(project('bg', os.path.join(gdirs['tex'], 'bg.toml')))
    run(dbetex, ['bg', os.path.join(gdirs['tex'], 'bg.toml'), '--out', tex_out])
    for n in ('blob', 'blob_m', 'gem'):
        gold['projects'].append(project('build', os.path.join(gdirs['spr'], n + '.toml'), dbespr))
        run(dbespr, ['build', os.path.join(gdirs['spr'], n + '.toml'), '--out', spr_out, '--no-preview'])
    # other geometry (--geom): generator output without geometry files
    g136 = os.path.join(FIX, 'w136.geom.json')
    for gen, mod in (('texdemo136', dbetexdemo), ('sprdemo136', dbesprdemo)):
        d = os.path.join(T, gen)
        mod.generate(d, g136)
        gold[gen] = {'geom_ref': os.path.relpath(g136, d), 'files': gen_files(d)}
    gold['errors'] = errors(gdirs)
    gold['cli'], gold['spr_preview'] = cli_texts(tex_out, spr_out, gdirs)
    gold['demo_assets'] = demo_assets()
    with open(os.path.join(HERE, 'tex.json'), 'w', encoding='utf-8') as f:
        json.dump(gold, f, indent=1, ensure_ascii=False)
        f.write('\n')
    print(f"tex.json: {len(gold['projects'])} projects, {len(gold['errors'])} error cases, {len(gold['cli'])} CLI texts")


if __name__ == '__main__':
    main()
