#!/usr/bin/env python3
"""Golden files for the parity tests of tools/js (docs/specs/P8-js-tools.md, section 4).

Runs the Python reference (tools/*.py, Pillow) and writes JSON files next to this script:
  images.json   every PNG/BMP of the repos + synthetic PNGs (img/): size and sha256 of Pillow convert("RGBA")
  vrl.json      encode/encode_rect/stats/threshold of tools/vrl.py on seeded random inputs
  pyrandom.json reference sequences of random.Random (seeds, methods)

usage: tools/js/test/golden/mkgolden.py [--only images,vrl,pyrandom]
"""
import argparse, glob, hashlib, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import vrl  # noqa: E402

IMG_DIRS = ['demo', 'docs', 'test', 'tools']   # this repo, without build/


def rel(p):
    return os.path.relpath(p, ROOT).replace(os.sep, '/')


def synthetic():
    """PNG variants Pillow can write: bit depths, colour types, tRNS, interlace."""
    from PIL import Image
    d = os.path.join(HERE, 'img')
    os.makedirs(d, exist_ok=True)
    rnd = random.Random(42)
    w, h = 13, 7
    out = []

    def save(im, name, **kw):
        p = os.path.join(d, name)
        im.save(p, **kw)
        out.append(p)

    for mode in ('1', 'L', 'LA', 'RGB', 'RGBA', 'P', 'I;16'):
        im = Image.new(mode, (w, h))
        px = []
        for _ in range(w * h):
            if mode in ('1', 'L', 'P'):
                px.append(rnd.randrange(256) if mode != '1' else rnd.choice((0, 255)))
            elif mode == 'I;16':
                px.append(rnd.randrange(65536))
            else:
                px.append(tuple(rnd.randrange(256) for _ in mode))
        im.putdata(px)
        if mode == 'P':
            im.putpalette([rnd.randrange(256) for _ in range(768)])
        tag = mode.replace(';', '')
        save(im, 'syn_%s.png' % tag)
        save(im, 'syn_%s_i.png' % tag, interlace=1) if mode != 'I;16' else None
    p = Image.new('P', (w, h))
    p.putdata([rnd.randrange(16) for _ in range(w * h)])
    p.putpalette([rnd.randrange(256) for _ in range(48)])
    save(p, 'syn_P16_trns.png', transparency=bytes(rnd.randrange(256) for _ in range(16)), bits=4)
    for bits in (1, 2, 4):
        q = Image.new('P', (w, h))
        q.putdata([rnd.randrange(1 << bits) for _ in range(w * h)])
        q.putpalette([rnd.randrange(256) for _ in range(3 << bits)])
        save(q, 'syn_P%d.png' % bits, bits=bits)
    rgb = Image.new('RGB', (w, h))
    rgb.putdata([rnd.choice(((255, 0, 255), (1, 2, 3), (9, 9, 9))) for _ in range(w * h)])
    save(rgb, 'syn_RGB_trns.png', transparency=(255, 0, 255))
    g = Image.new('L', (w, h))
    g.putdata([rnd.choice((0, 7, 200)) for _ in range(w * h)])
    save(g, 'syn_L_trns.png', transparency=7)
    return out


def images():
    from PIL import Image
    paths = []
    for d in IMG_DIRS:
        for ext in ('png', 'bmp'):
            paths += glob.glob(os.path.join(ROOT, d, '**', '*.' + ext), recursive=True)
    paths = sorted(set(p for p in paths if '/build/' not in p and '/tools/js/test/golden/img/' not in p))
    paths += synthetic()
    res = []
    for p in paths:
        im = Image.open(p)
        rgba = im.convert('RGBA')
        res.append({'path': rel(p), 'mode': im.mode, 'size': list(im.size),
                    'rgba_sha256': hashlib.sha256(rgba.tobytes()).hexdigest()})
    return res


def rand_seq(rng, n, skipfrac, alpha):
    x = []
    while len(x) < n:
        if rng.random() < 0.03:
            v = None if rng.random() < skipfrac else rng.randrange(alpha)
            x += [v] * rng.randint(2, 300)
        else:
            x.append(None if rng.random() < skipfrac else rng.randrange(alpha))
    return x[:n]


def vrl_cases():
    rng = random.Random(7)
    enc, rect, st = [], [], []
    for i in range(300):
        n = rng.choice([0, 1, 5, 40, 300, 2000]) if i % 30 else rng.randint(5000, 9000)
        x = rand_seq(rng, n, rng.choice([0, 0.1, 0.5]), rng.choice([2, 5, 256]))
        s = vrl.encode(x)
        enc.append({'in': x, 'out': s.hex()})
        st.append({'stream': s.hex(), 'T': rng.choice([None, 2, 14]), 'stats': vrl.stats(s, rng.choice([None, 2, 14]))})
    for _ in range(100):
        w, h = rng.randint(1, 40), rng.randint(1, 30)
        stride = w + rng.choice([0, 1, 10, 80])
        data = [rng.choice([0, 1, 2, rng.randrange(256)]) for _ in range(w * h)]
        mask = None if rng.random() < 0.3 else [rng.random() < 0.7 for _ in range(w * h)]
        rect.append({'data': data, 'w': w, 'h': h, 'stride': stride, 'mask': mask,
                     'out': vrl.encode_rect(data, w, h, stride, mask).hex()})
    for s in st:   # stats again with the T actually passed
        s['stats'] = vrl.stats(bytes.fromhex(s['stream']), s['T'])
    thr = [{'p': p, 'T': vrl.threshold(p)} for p in ({}, {'fill_byte': 15}, {'fill_fixed': 1112, 'fill_byte': 4.9,
                                                                         'cpu_byte': 57.8, 'cpu_run_fixed': 331})]
    return {'encode': enc, 'rect': rect, 'stats': st, 'threshold': thr}


def pyrandom():
    out = []
    for seed in (0, 1, 7, 42, 1979, 12345678901234567890, -5):
        r = random.Random(seed)
        out.append({'seed': str(seed),
                    'random': [r.random() for _ in range(5)],
                    'getrandbits': [r.getrandbits(k) for k in (1, 7, 31, 32, 33, 53)],
                    'randrange': [r.randrange(1000) for _ in range(5)] + [r.randrange(3, 50, 4), r.randrange(50, 3, -7)],
                    'randint': [r.randint(-3, 3) for _ in range(8)],
                    'choice': [r.choice('abcdefgh') for _ in range(8)],
                    'sample': [r.sample(range(30), 5), r.sample(range(10), 10), r.sample(range(1000), 8)],
                    'after': r.random()})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='images,vrl,pyrandom')
    a = ap.parse_args()
    for name in a.only.split(','):
        data = {'images': images, 'vrl': vrl_cases, 'pyrandom': pyrandom}[name]()
        with open(os.path.join(HERE, name + '.json'), 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        print(name, 'ok')


main()
