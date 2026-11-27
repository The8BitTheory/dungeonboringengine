#!/usr/bin/env python3
"""sim65 measurement and verification of the lib with the crawl scene (P7a, docs/specs/P7-crawl.md 6.2).

Usage:  run_crawl.py (--d81 IMAGE.d81 | --dir DIR) [--quick] [--workers N] [--no-verify] [--no-cycles] [--fix] [--json OUT]
  --fix:   fixed list address like crawl 1.1 from P6j (BUFSET X = 1: VCL list from B0, VIEW copies it there)
  verify:  all views (free cells x 4 directions x no ghost/ghost in every cell (d, s) x 4 directions) run in the
           simulator and compared byte for byte with dbeview.view (A, X, VCL, VMS, OBJVIS)
  cycles:  cycles of VIEW as in run_sim.time_view (run with F = 4 minus run with F = 7), mean and maximum
           without and with ghost, target from P6 8: <= 2 x 0.1 = 28 382 cycles (finding, not an acceptance blocker)
Builds the harness (run_sim.build) only if build/sim/viewsim.prg is missing.
"""
import argparse
import json
import os
import statistics
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, HERE)
import crawl01  # noqa: E402
import crawlconv  # noqa: E402
import dbeview  # noqa: E402
import dbetex  # noqa: E402
import run_sim  # noqa: E402

TARGET = 28382
ENV = None
FIX = False


def _init(files, fix=False):
    global ENV
    ENV = crawl01.Env(files)
    ENV.sc.buf_fix = fix


def configs(e, pos, v, quick=False, variants=(0, 1)):
    """All configurations of a view: (variant, ghost)."""
    cells = e.visible_cells(pos, v)
    for variant in variants:
        yield variant, None
        for _d, _s, c in cells:
            for gd in (range(4) if not quick else (v, (v + 2) & 3)):
                yield variant, (c, gd)


def _setscene(e, pos, v, variant, ghost):
    sc = e.sc
    sc.dmp = e.m1 if variant else e.m
    sc.pos, sc.dir = pos, v
    sc.objects = [] if ghost is None else [dbeview.Obj(ghost[0], 0, ghost[1], 0, crawl01.QG[v])]
    return sc


def _verify_job(args):
    pos, v, quick = args
    e = ENV
    R = run_sim.ViewRunner(dbeview, dbetex)
    n = 0
    for variant, ghost in configs(e, pos, v, quick):
        sc = _setscene(e, pos, v, variant, ghost)
        R.add(f"pos {pos} dir {v} var {variant} ghost {ghost}", sc, objs=True)
        n += 1
    nview, fails, codes, _cyc = R.run()
    return nview, fails, codes


def _cycle_job(args):
    pos, v, quick = args
    e = ENV
    R = run_sim.ViewRunner(dbeview, dbetex)
    R.reset()
    sc = _setscene(e, pos, v, 0, None)
    sc.vms_bank1, sc.dts_addr = R.bank1, run_sim.P6D_ADDR["dts"]
    R.setup(sc)
    sc.s2_addr = tuple(R.s2_addr(ss) if ss is not None else 0 for ss in sc.s2)
    base = bytes(R.scene.b)
    out = []
    for variant, ghost in configs(e, pos, v, quick, variants=(0,)):
        sc = _setscene(e, pos, v, variant, ghost)
        kw = R.objargs(sc)
        runs = []
        for f in (4, 7):
            s = run_sim.Scene()
            s.b = bytearray(base)
            s.call(2, v, p=(pos, 0, 0, 0), quiet=True)
            s.call(f, p=(sc.ap, 0, 0, 0), quiet=True, **kw)
            runs.append(run_sim.run(s, R.prg).cycles)
        out.append((ghost is not None, runs[0] - runs[1], pos, v, ghost))
    return out


def verify(files, quick=False, workers=1):
    e = crawl01.Env(files)
    jobs = [(p, v, quick) for p in e.free for v in range(4)]
    return _map(_verify_job, jobs, files, workers)


def cycles(files, quick=False, workers=1):
    e = crawl01.Env(files)
    jobs = [(p, v, quick) for p in e.free for v in range(4)]
    res = [x for r in _map(_cycle_job, jobs, files, workers) for x in r]
    rep = {}
    for name, sel in (("no ghost", [r for r in res if not r[0]]), ("with ghost", [r for r in res if r[0]]),
                      ("all", res)):
        c = [r[1] for r in sel]
        worst = max(sel, key=lambda r: r[1])
        rep[name] = dict(n=len(c), mean=round(statistics.mean(c)), max=max(c), min=min(c),
                         worst=dict(pos=worst[2], dir=worst[3], ghost=worst[4]),
                         over_target=sum(1 for x in c if x > TARGET))
    return rep


def _map(fn, jobs, files, workers):
    if workers > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(workers, _init, (files, FIX)) as pool:
            return list(pool.imap(fn, jobs, chunksize=2))
    _init(files, FIX)
    return [fn(j) for j in jobs]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--d81")
    g.add_argument("--dir")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--no-cycles", action="store_true")
    ap.add_argument("--fix", action="store_true", help="fixed list address (BUFSET X = 1, P6j)")
    ap.add_argument("--json")
    a = ap.parse_args(argv)
    global FIX
    FIX = a.fix
    if not os.path.exists(run_sim.PRG):
        run_sim.build()
    if a.d81:
        work = tempfile.mkdtemp(prefix="crawlsim-", dir=os.path.join(ROOT, "build"))
        files = crawlconv.read_d81(a.d81, work)
    else:
        files = crawlconv.read_dir(a.dir)
    out, rc = {}, 0
    if not a.no_verify:
        res = verify(files, a.quick, a.workers)
        nview = sum(r[0] for r in res)
        fails = [f for r in res for f in r[1]]
        codes = {}
        for r in res:
            for k, c in r[2].items():
                codes[k] = codes.get(k, 0) + c
        print(f"sim65 vs dbeview.view: {nview} views, mismatches {len(fails)}, error codes {codes}")
        for f in fails[:10]:
            print("  ", f)
        out["verify"] = dict(views=nview, fails=len(fails), codes={str(k): v for k, v in codes.items()})
        rc |= bool(fails) or set(codes) - {0} != set()
    if not a.no_cycles:
        rep = cycles(files, a.quick, a.workers)
        for k, v in rep.items():
            print(f"VIEW cycles {k}: {v['n']} views, mean {v['mean']}, min {v['min']}, max {v['max']} "
                  f"(target {TARGET}, above: {v['over_target']}); most expensive: {v['worst']}")
        out["cycles"] = rep
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, indent=1)
    return int(rc)


if __name__ == "__main__":
    sys.exit(main())
