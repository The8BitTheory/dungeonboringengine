#!/usr/bin/env python3
"""Tour of the demo for test/vice_demo.py: key sequence that walks the demo map with the goblin routes of demo.bas.

Usage: demo/tour.py   (prints the tour; requires demo/build.py to have run)

The goblins take one step per valid key (demo.bas 3000-3030), so the tour is a search over the states
(position, direction, route step of the three goblins): Dijkstra with costs W, Q, E = 1 and A, D, S = 2, blocked moves
(MOVE X != 0) are forbidden. Each goal is a state (player cell, direction, cells of individual goblins); the waiting sequences
(turning back and forth) follow from the goal. Bumps (wall, goblin, grate) are separate steps with an expected X.

Each tour step: (keys, label, expected X of the last MOVE or None).
If the map, routes or demo.bas change, the tour changes by itself; the goals remain valid (abort if one is missing).
"""
import heapq, os, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, HERE)
import dbemap, dbemove, dbeview
dbeview.dbemap = dbemap
import build as demo_build

ACTION = {'W': 0, 'S': 1, 'A': 2, 'D': 3, 'Q': 4, 'E': 5}
COST = {'W': 1, 'Q': 1, 'E': 1, 'A': 2, 'D': 2, 'S': 2}


class Planner:
    def __init__(self, dmp, bas):
        self.m, self.w = dmp, dmp.width
        self.routes = [[y * self.w + x for x, y in r] for r in demo_build.routes(bas)]
        self.state = (dmp.start, dmp.direction, (0,) * len(self.routes))
        self.keys, self.segs, self.last_x = '', [], None

    def cell(self, x, y):
        return y * self.w + x

    def _gstep(self, gi, pc):
        return tuple(gi[g] if r[(gi[g] + 1) % len(r)] == pc else (gi[g] + 1) % len(r) for g, r in enumerate(self.routes))

    def _apply(self, state, k):
        pos, dr, gi = state
        objs = [dbeview.Obj(self.routes[g][gi[g]], 0, 0xFF, 0, 4) for g in range(len(self.routes))]
        mv = dbemove.move(self.m, pos, dr, objs, ACTION[k])
        return (mv.pos, mv.dir, self._gstep(gi, mv.pos)), mv.x

    def at(self, x, y, d=None, g=None):
        """Goal: player at (x, y), direction d (optional), goblin n at (x, y) for {n: (x, y)} (optional)."""
        def f(s):
            pos, dr, gi = s
            return (pos == self.cell(x, y) and (d is None or dr == d) and
                    all(self.routes[n][gi[n]] == self.cell(gx, gy) for n, (gx, gy) in (g or {}).items()))
        return f

    def go(self, label, goal, limit=400000):
        pq, seen, cnt = [(0, 0, self.state, '')], {self.state: 0}, 0
        while pq:
            d, _, s, k = heapq.heappop(pq)
            if seen.get(s, 1 << 30) < d:
                continue
            if goal(s):
                self.segs.append((k, label, None))
                self.keys += k
                self.state = s
                return
            for key, wgt in COST.items():
                s2, x = self._apply(s, key)
                if x:
                    continue
                if d + wgt < seen.get(s2, 1 << 30):
                    seen[s2] = d + wgt
                    cnt += 1
                    if cnt > limit:
                        raise SystemExit(f'Tour: search for "{label}" aborted')
                    heapq.heappush(pq, (d + wgt, cnt, s2, k + key))
        raise SystemExit(f'Tour: no path to "{label}"')

    def raw(self, label, keys, want_x=None):
        x = None
        for k in keys:
            self.state, x = self._apply(self.state, k)
        if want_x is not None and x != want_x:
            raise SystemExit(f'Tour: "{label}": MOVE X = {x}, expected {want_x}')
        self.segs.append((keys, label, want_x))
        self.keys += keys


def plan(dmp, bas):
    """Tour for the map dmp and the routes in bas. Returns a list (keys, label, expected X)."""
    p = Planner(dmp, bas)
    at = p.at
    p.raw('Window west d=1', 'W')
    p.go('Window south', at(2, 14, 2))
    p.go('Abyss from the west', at(13, 8, 1))
    p.raw('sideways right, back (abyss from another cell)', 'DS')
    p.go('Door with goblin in it', at(13, 7, 0, {0: (13, 6)}))
    p.raw('Bump against goblin in the door', 'WW', 2)
    p.raw('back', 'S')
    p.go('through the door into the courtyard (sky)', at(13, 5, 0))
    p.go('Goblin clipped at the left edge', at(14, 5, 0, {0: (13, 4)}))
    p.go('Window north d=3', at(14, 3, 0))
    p.go('Window north d=1', at(14, 1, 0))
    p.raw('Bump against the window wall', 'W', 1)
    p.go('Window east d=3', at(16, 2, 1))
    p.go('Window east d=1', at(18, 2, 1))
    p.go('Grate with gem, goblin in front', at(17, 4, 2, {1: (17, 5)}))
    p.raw('Bump against goblin in front of the grate', 'W', 2)
    p.go('Grate d=1', at(17, 5, 2))
    p.raw('Bump against the grate', 'W', 1)
    p.go('Courtyard, looking west', at(17, 3, 3))
    return p.segs


def main():
    sys.path.insert(0, os.path.join(ROOT, 'demo'))
    sc, L = demo_build.load_world()
    segs = plan(sc.dmp, os.path.join(HERE, 'demo.bas'))
    n = 0
    for k, label, x in segs:
        print(f'{n:3} {k:<22} {label}' + (f'  (X = {x})' if x is not None else ''))
        n += len(k)
    print(f'{n} keys')


if __name__ == '__main__':
    main()
