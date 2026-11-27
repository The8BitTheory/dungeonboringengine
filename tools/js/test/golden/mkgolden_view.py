#!/usr/bin/env python3
"""Golden files for the parity tests of tools/js/core/map.js and view.js (docs/specs/P8-js-tools.md, section 4).

Runs the Python reference (tools/dbemap.py, tools/dbeview.py, tools/dbetex.py, tools/dbespr.py) and writes:
  view/            fixtures: demo assets of dbeview.build_demo_assets (DVG, DTS + VRAM, DBG + VRAM, S2 + VRAM),
                   example maps as DMP, the Crawl 128 map (crawlmap.convert) as DMP, a scene directory for
                   load_scene/CLI tests (files built by the dbetex CLI)
  map.json         dbemap: DMP sha256/hex, to_toml/describe sha256 of the example maps, error messages,
                   random round trips (test_roundtrip_random generator)
  view.json        dbeview: per scene VCL/VMS sha256 (hex for some), a, x, objvis, lengths, items and
                   sha256 of the window after run_vcl and after paint_reference

The JS side reads the assets through from_dts/from_s2 (it has no texture builder yet), so the goldens are
computed with the same round-tripped assets; the script checks that they give the same lists as the built ones.

usage: tools/js/test/golden/mkgolden_view.py [--only map,view]
"""
import argparse, copy, hashlib, json, os, random, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import dbemap  # noqa: E402
import dbetex  # noqa: E402
import dbespr  # noqa: E402
import dbeview  # noqa: E402
from dbemap import Event, Map, Tile  # noqa: E402

FIX = os.path.join(HERE, 'view')
BIG = (0x0200, 0x1C00)
MAPS = {'demo': 'docs/specs/examples/demo.toml', 'crawl128': 'docs/specs/examples/crawl128.toml',
        'demo_demo': 'demo/demo.toml'}


def sha(b):
    return hashlib.sha256(bytes(b)).hexdigest()


def wsha(sc, vram):
    return sha(b''.join(dbeview.window_bytes(sc, vram)))


def put(name, data):
    p = os.path.join(FIX, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(bytes(data))


# ---------------------------------------------------------------- dbemap

BASE = '''
[map]
start = [1, 1]
dir = "N"
outside = "w"
[tiles.w]
walls = 1
flags = ["solid"]
[tiles.g]
floor = 1
[legend]
"#" = "w"
"." = "g"
[layers]
tiles = """
###
#.#
###
"""
'''

TOML_ERRORS = [
    BASE.replace("#.#", "#q#"), BASE.replace("#.#", "#.##"), BASE.replace("[1, 1]", "[0, 0]"),
    BASE.replace('"." = "g"', '"." = { tile = "g", item = 64 }'), BASE.replace("floor = 1", "floor = 256"),
    BASE.replace('["solid"]', '["solid", "foo"]'),
    BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ type = "xyz" }] }'),
    BASE.replace("###\n#.#\n###", "#" * 256), BASE.replace("###\n#.#\n###", "\n".join(["#" * 200] * 100)),
    BASE.replace("#.#\n", "#.# \n"), BASE.replace("[tiles.w]", "[tiles.w]\nindex = 0"),
    BASE.replace("floor = 1", "flor = 1"), BASE.replace('dir = "N"', 'dir = "N"\nstrat = [1, 1]'),
    "titel = 1\n" + BASE, BASE + "walls = 1\n",
    # further error paths of loads_toml
    'format = "x"\n' + BASE, 'version = 2\n' + BASE, BASE.replace('outside = "w"', 'outside = "zz"'),
    BASE.replace('dir = "N"', 'dir = "Q"'), BASE.replace('start = [1, 1]', 'start = [1]'),
    BASE.replace('start = [1, 1]', 'start = [5, 1]'), BASE.replace('flags = ["solid"]', 'flags = "solid"'),
    BASE.replace('walls = 1', 'walls = [1, 2]'), BASE.replace('"#" = "w"', '"##" = "w"'),
    BASE.replace('"#" = "w"', '"#" = { tile = "w", foo = 1 }'), BASE.replace('"#" = "w"', '"#" = "nope"'),
    BASE + '[[events]]\ntype = "enemy"\nat = [9, 0]\n', BASE + '[[events]]\ntype = "enemy"\n',
    BASE + '[[marks]]\nat = [0, 0]\nseen = 1\n', BASE + '[[marks]]\nat = [0, 0]\nfoo = 1\n',
    BASE.replace('[layers]\ntiles = """\n###\n#.#\n###\n"""', '[layers]\ntiles = ""'),
    BASE.replace('[tiles.w]', '[tiles.w]\nindex = 1').replace('[tiles.g]', '[tiles.g]\nindex = 1'),
    BASE.replace('[map]', '[map]\nname = "x"\nfoo = 2'), BASE.replace('walls = 1', 'walls = true'),
    BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ type = 0 }] }'),
    BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ type = 3, param = 300 }] }'),
    BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ type = 3, x = 1 }] }'),
    BASE.replace('"." = "g"', '"." = { tile = "g", events = [{ param = 1 }] }'),
    BASE.replace('dir = "N"', ''), BASE.replace('[tiles.g]\nfloor = 1', ''),
]


def map_err(fn):
    try:
        fn()
    except ValueError as e:
        return str(e)
    return None


def map_cases():
    out = {'maps': {}, 'toml_errors': [], 'dmp_errors': [], 'random': []}
    for name, rel in MAPS.items():
        m = dbemap.load_toml(os.path.join(ROOT, rel))
        d = dbemap.to_dmp(m)
        put(f'maps/{name}.dmp', d)
        t = dbemap.to_toml(dbemap.from_dmp(d))
        out['maps'][name] = {'path': rel, 'dmp_sha': sha(d), 'dmp_len': len(d), 'toml_sha': sha(t.encode()),
                             'describe_sha': sha(dbemap.describe(m).encode()), 'warnings': dbemap.warnings_for(m),
                             'name': m.name}
    import crawlmap
    with open(os.path.join(ROOT, 'test', 'tools', 'data', 'crawl128.cd1'), 'rb') as f:
        cm, _ = crawlmap.convert(f.read())
    d = dbemap.to_dmp(cm)
    put('maps/crawl_cd1.dmp', d)
    out['maps']['crawl_cd1'] = {'dmp_sha': sha(d), 'toml_sha': sha(dbemap.to_toml(dbemap.from_dmp(d)).encode())}
    for t in TOML_ERRORS:
        out['toml_errors'].append({'toml': t, 'error': map_err(lambda: dbemap.loads_toml(t, 't.toml'))})
    demo = bytearray(dbemap.to_dmp(dbemap.load_toml(os.path.join(ROOT, MAPS['demo']))))
    for pos, val in [(2, ord('X')), (4, 2), (2 + 24, 4), (2 + 8, 35), (2 + 11, 9), (2 + 10, 4), (2 + 22, 1),
                     (2 + 14, 0), (2 + 24 + 70 + 6, 0x80), (2 + 3, 0), (-1, None)]:
        d = bytearray(demo)
        if val is None:
            d = d[:-1]
        else:
            d[pos] = val
        out['dmp_errors'].append({'dmp': d.hex(), 'error': map_err(lambda: dbemap.from_dmp(bytes(d)))})
    # generator of test_roundtrip_random
    rnd = random.Random(12345)
    for _ in range(50):
        w, h = rnd.randint(1, 40), rnd.randint(1, 40)
        nt = rnd.randint(1, 12)
        tiles = []
        for i in range(nt):
            fl = 0 if i == 0 else rnd.randint(0, 63)
            tiles.append(Tile(tuple(rnd.randint(0, 255) for _ in range(4)), rnd.randint(0, 255),
                              rnd.randint(0, 255), fl, rnd.randint(0, 255)))
        cells = [rnd.randrange(nt) for _ in range(w * h)]
        cells[0] = 0
        content = [rnd.choice([0, 0, 1, 2, 3, 4, 5]) for _ in range(w * h)]
        for i in range(w * h):
            if rnd.random() < 0.1:
                content[i] |= rnd.choice([0x80, 0x40, 0xC0])
        events = [Event(rnd.randrange(w * h), rnd.randint(1, 255), rnd.randint(0, 255))
                  for _ in range(rnd.randint(0, 20))]
        m = Map("r", w, h, tiles, cells, content, events, 0, rnd.randint(0, 3), rnd.randrange(nt))
        d = dbemap.to_dmp(m)
        out['random'].append({'dmp_sha': sha(d), 'toml_sha': sha(dbemap.to_toml(dbemap.from_dmp(d)).encode())})
    return out


# ---------------------------------------------------------------- dbeview

def roundtrip_assets(a):
    """Assets as the JS side sees them: DTS/S2 through to_dts/from_dts and to_s2/from_s2."""
    b = copy.copy(a)

    def ts(t):
        prg = dbetex.to_dts(t)
        t2 = dbetex.from_dts(prg, t.vram)
        t2.dts_prg = prg
        assert dbetex.to_dts(t2) == prg
        return t2
    b.walls, b.floor, b.ceil = ts(a.walls), ts(a.floor), ts(a.ceil)
    b.sprites = [None if s is None else dbespr.from_s2(dbespr.to_s2(s), s.vram) for s in a.sprites]
    for s, s0 in zip(b.sprites, a.sprites):
        if s is not None:
            assert dbespr.to_s2(s) == dbespr.to_s2(s0)
    b.dbg = dbetex.from_dbg(dbetex.build_background(dbetex.load_bg_conf(os.path.join(a.dir, 'bg.toml')))[0])
    assert b.dbg == a.dbg
    return b


def write_assets(a, built):
    put('west140.dvg', a.dvg_prg)
    for n in ('walls', 'floor', 'ceil'):
        ts = getattr(a, n)
        put(f'{n}.dts', dbetex.to_dts(ts))
        put(f'{n}.vram', ts.vram)
    dbg_prg, dbg_vram, _ = dbetex.build_background(dbetex.load_bg_conf(os.path.join(a.dir, 'bg.toml')))
    put('sky.dbg', dbg_prg)
    put('sky.vram', dbg_vram)
    for i, ss in enumerate(a.sprites):
        if ss is not None:
            put(f's2_{i}.s2', dbespr.to_s2(ss))
            put(f's2_{i}.vram', ss.vram)


def scene_dir(a):
    """Files of test_load_scene_and_cli: DTS/VRL/DBG built by the dbetex CLI, DVG, demo map, scene.toml."""
    d = os.path.join(FIX, 'scene')
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    tex = os.path.join(ROOT, 'tools', 'dbetex.py')
    for n in ('walls.toml', 'floor.toml', 'ceil.toml'):
        subprocess.run([sys.executable, tex, 'build', os.path.join(a.dir, n), '--out', d, '--no-preview'], check=True,
                       capture_output=True)
    subprocess.run([sys.executable, tex, 'bg', os.path.join(a.dir, 'bg.toml'), '--out', d], check=True,
                   capture_output=True)
    for f in os.listdir(d):
        if not f.endswith(('.dts', '.vrl', '.dbg')):
            os.remove(os.path.join(d, f))
    shutil.copy(os.path.join(a.dir, 'west140.dvg'), d)
    shutil.copy(os.path.join(ROOT, MAPS['demo']), d)
    with open(os.path.join(d, 'scene.toml'), 'w') as f:
        f.write('''format = "dbeview"
version = 1
[scene]
dvg = "west140.dvg"
map = "demo.toml"
dir = "E"
bgfill = 0
[walls]
dts = "demo_walls.dts"
vrl = "demo_walls.vrl"
[floor]
dts = "demo_floor.dts"
vrl = "demo_floor.vrl"
[ceil]
dts = "demo_ceil.dts"
vrl = "demo_ceil.vrl"
[background]
dbg = "demo_sky.dbg"
vrl = "demo_sky.vrl"
''')
    with open(os.path.join(d, 'scene_obj.toml'), 'w') as f:
        f.write('''format = "dbeview"
version = 1
[scene]
dvg = "west140.dvg"
map = "demo.dmp"
pos = [1, 1]
dir = 1
bgfill = 0x33
itemph = 1
farfill = 0x11
buf_fix = true
[walls]
dts = "demo_walls.dts"
vrl = "demo_walls.vrl"
[floor]
dts = "demo_floor.dts"
vrl = "demo_floor.vrl"
[ceil]
dts = "demo_ceil.dts"
vrl = "demo_ceil.vrl"
[background]
dbg = "demo_sky.dbg"
vrl = "demo_sky.vrl"
''')
    shutil.copy(os.path.join(FIX, 'maps', 'demo.dmp'), os.path.join(d, 'demo.dmp'))
    return [os.path.join(d, 'scene.toml'), os.path.join(d, 'scene_obj.toml')]


def result(sc, seed, full=False, pixels=True):
    res = dbeview.view(sc)
    r = {'a': res.a, 'x': res.x, 'p0': res.p0, 'objvis': res.objvis, 'vcllen': res.vcllen, 'vmslen': res.vmslen,
         'items': res.items, 'partial': res.partial, 'vcl_sha': sha(res.vcl), 'vms_sha': sha(res.vms),
         'lists1': len(res.lists1)}
    if full:
        r['vcl'] = res.vcl.hex()
        r['vms'] = res.vms.hex()
    if pixels:
        vram = sc.make_vram(seed)
        before = bytes(vram)
        dbeview.render_view(sc, vram, res)
        r['win_sha'] = wsha(sc, vram)
        r['ref_sha'] = wsha(sc, dbeview.paint_reference(sc, bytearray(before)))
    return r


def view_cases():
    tmp = tempfile.TemporaryDirectory()
    built = dbeview.build_demo_assets(tmp.name)
    write_assets(built, True)
    a = roundtrip_assets(built)
    demo = dbemap.load_toml(os.path.join(ROOT, MAPS['demo']))
    demo2 = dbemap.load_toml(os.path.join(ROOT, MAPS['demo_demo']))
    out = {'random': [], 'far': [], 'fixed': [], 'demo': [], 'double': [], 'bank1': [], 'scenes': [], 'preview': {}}

    # built assets and round-tripped assets give the same lists
    for k in range(30):
        r1 = dbeview.view(dbeview.random_scene(k, built, buf=BIG))
        r2 = dbeview.view(dbeview.random_scene(k, a, buf=BIG))
        assert (r1.vcl, r1.vms, r1.objvis) == (r2.vcl, r2.vms, r2.objvis), k

    for k in range(220):
        sc = dbeview.random_scene(k, a, buf=BIG)
        r = result(sc, k, full=k < 3)
        r['seed'] = k
        r['dmp_sha'] = sha(dbemap.to_dmp(sc.dmp))
        r['objects'] = [[o.cell, o.set, o.dir, o.phase, o.q, o.hidden, o.noblock] for o in sc.objects]
        r['pos'], r['dir'], r['bases'] = sc.pos, sc.dir, sc.vram_bases
        out['random'].append(r)
    for k in range(60):
        sc = dbeview.far_variant(dbeview.random_scene(k, a, buf=BIG), k)
        r = result(sc, k)
        r['seed'] = k
        r['farfill'] = sc.farfill
        out['far'].append(r)
    for k in range(12):
        sc = dbeview.random_scene(700 + k, a)
        for fix in (False, True):
            s = copy.copy(sc)
            s.buf_fix = fix
            r = result(s, k, pixels=False)
            r.update(seed=700 + k, fix=fix)
            out['fixed'].append(r)
    m = demo
    for bc in (False, True):
        for i, c in enumerate(m.cells):
            if m.tiles[c].flags & dbeview.T_SOLID:
                continue
            for v in range(4):
                sc = dbeview.make_scene(a, m, i, v, band_cover=bc)
                r = result(sc, i * 4 + v)
                r.update(pos=i, dir=v, bc=bc)
                out['demo'].append(r)
    # far view on the demo maps
    for mm, mname in ((demo, 'demo'), (demo2, 'demo_demo')):
        for i, c in enumerate(mm.cells):
            if mm.tiles[c].flags & dbeview.T_SOLID:
                continue
            for v in range(4):
                k = i * 4 + v
                bc, (ff, dbg) = bool(k & 1), ((0x00, True), (0x96, False))[(k >> 1) & 1]
                sc = dbeview.make_scene(a, mm, i, v, band_cover=bc, buf=BIG, farfill=ff, dbg=dbg, bgfill=0x5A)
                r = result(sc, k)
                r.update(map=mname, pos=i, dir=v, bc=bc, farfill=ff, dbg=dbg)
                out['far'].append(r)
    a2 = dbeview.double_fronts(a)
    put('double_fronts.dvg', a2.dvg_prg)
    out['double_dts_sha'] = [sha(t.dts_prg) for t in (a2.walls, a2.floor, a2.ceil)]
    for bc in (False, True):
        for i, c in enumerate(m.cells):
            if m.tiles[c].flags & dbeview.T_SOLID or i % 3:
                continue
            for v in range(4):
                sc = dbeview.make_scene(a2, m, i, v, band_cover=bc, buf=BIG)
                r = result(sc, i * 4 + v)
                r.update(pos=i, dir=v, bc=bc)
                out['double'].append(r)
    for k in range(20):
        sc = dbeview.random_scene(1000 + k, a2, buf=BIG)
        r = result(sc, k)
        r.update(seed=1000 + k)
        out['double'].append(r)
    # vms_bank1 (test_vms_bank1)
    rnd = random.Random(9)
    s2a, adr = [], 0x4000
    for ss in a.sprites:
        s2a.append(adr if ss is not None else 0)
        adr += len(dbeview._s2_content(ss)) if ss is not None else 0
    s2a += [0] * (8 - len(s2a))
    for k, (i, v, nobj) in enumerate([(9, 0, 0), (9, 1, 0), (16, 2, 0), (22, 3, 0), (9, 0, 5), (16, 2, 5), (22, 1, 5),
                                       (9, 3, 5)]):
        objs = dbeview.random_objects(rnd, demo, i, v, nobj)
        sc = dbeview.make_scene(a, demo, i, v, objs, [0, 2, 3, 2] + [0] * 60)
        sc1 = copy.copy(sc)
        sc1.vms_bank1, sc1.s2_addr = True, tuple(s2a)
        r = result(sc1, k)
        res = dbeview.view(sc1)
        r['lists1_sha'] = sha(res.bank1())
        r['default_s2'] = [sc.s2_bank1(j) for j in range(8)]
        r.update(pos=i, dir=v, nobj=nobj)
        out['bank1'].append(r)
    # scene files
    for p in scene_dir(built):
        sc = dbeview.load_scene(p)
        r = result(sc, 0, full=True)
        r['file'] = os.path.relpath(p, FIX)
        r['dump'] = [list(e) for e in dbeview.decode_vcl(res_buffer(sc))]
        r['image_sha'] = sha(dbeview.window_image(sc, dbeview.render_view(sc, bytearray(65536))[0], 2).tobytes())
        r['bases'] = sc.vram_bases
        out['scenes'].append(r)
    # dbetex.preview (TestPreviewCompare), RGB bytes
    for name, ts, st in (('walls', built.walls, 0), ('floor', built.floor, 2), ('ceil', built.ceil, 1)):
        im = dbetex.preview(ts, built.geom, st, vb=0x4000)
        out['preview'][name] = {'size': list(im.size), 'rgb_sha': sha(im.tobytes())}
    tmp.cleanup()
    return out


def res_buffer(sc):
    return dbeview.view(sc).buffer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='map,view')
    a = ap.parse_args()
    os.makedirs(FIX, exist_ok=True)
    for name in a.only.split(','):
        data = {'map': map_cases, 'view': view_cases}[name]()
        with open(os.path.join(HERE, name + '.json'), 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        print(name, 'ok')


main()
