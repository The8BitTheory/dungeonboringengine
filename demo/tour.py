#!/usr/bin/env python3
"""Tour der Demo für test/vice_demo.py: Tastenfolge, die die Demo-Karte mit den Goblin-Routen von demo.bas abfährt.

Aufruf: demo/tour.py   (gibt die Tour aus; Voraussetzung: demo/build.py ist gelaufen)

Die Goblins ziehen je gültiger Taste einen Schritt (demo.bas 3000-3030), die Tour ist also eine Suche in den Zuständen
(Position, Richtung, Routenschritt der drei Goblins): Dijkstra mit Kosten W, Q, E = 1 und A, D, S = 2, blockierte Züge
(MOVE X != 0) sind verboten. Jedes Ziel ist ein Zustand (Spielerzelle, Richtung, Zellen einzelner Goblins); die Wartefolgen
(Drehen hin und her) ergeben sich aus dem Ziel. Stöße (Wand, Goblin, Gitter) sind eigene Schritte mit erwartetem X.

Jeder Tourschritt: (Tasten, Bezeichnung, erwartetes X des letzten MOVE oder None).
Ändern sich Karte, Routen oder demo.bas, ändert sich die Tour von selbst; die Ziele gelten weiter (Abbruch, wenn eins fehlt).
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
        """Ziel: Spieler auf (x, y), Richtung d (optional), Goblin n auf (x, y) für {n: (x, y)} (optional)."""
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
                        raise SystemExit(f'Tour: Suche nach "{label}" abgebrochen')
                    heapq.heappush(pq, (d + wgt, cnt, s2, k + key))
        raise SystemExit(f'Tour: kein Weg zu "{label}"')

    def raw(self, label, keys, want_x=None):
        x = None
        for k in keys:
            self.state, x = self._apply(self.state, k)
        if want_x is not None and x != want_x:
            raise SystemExit(f'Tour: "{label}": MOVE X = {x}, erwartet {want_x}')
        self.segs.append((keys, label, want_x))
        self.keys += keys


def plan(dmp, bas):
    """Tour für die Karte dmp und die Routen in bas. Rückgabe Liste (Tasten, Bezeichnung, erwartetes X)."""
    p = Planner(dmp, bas)
    at = p.at
    p.raw('Fenster West d=1', 'W')
    p.go('Fenster Süd', at(2, 14, 2))
    p.go('Abgrund von Westen', at(13, 8, 1))
    p.raw('seitwärts rechts, zurück (Abgrund aus anderer Zelle)', 'DS')
    p.go('Tür mit Goblin darin', at(13, 7, 0, {0: (13, 6)}))
    p.raw('Stoß gegen Goblin in der Tür', 'WW', 2)
    p.raw('zurück', 'S')
    p.go('durch die Tür in den Hof (Himmel)', at(13, 5, 0))
    p.go('Goblin am linken Rand beschnitten', at(14, 5, 0, {0: (13, 4)}))
    p.go('Fenster Nord d=3', at(14, 3, 0))
    p.go('Fenster Nord d=1', at(14, 1, 0))
    p.raw('Stoß gegen die Fensterwand', 'W', 1)
    p.go('Fenster Ost d=3', at(16, 2, 1))
    p.go('Fenster Ost d=1', at(18, 2, 1))
    p.go('Gitter mit Edelstein, Goblin davor', at(17, 4, 2, {1: (17, 5)}))
    p.raw('Stoß gegen Goblin vor dem Gitter', 'W', 2)
    p.go('Gitter d=1', at(17, 5, 2))
    p.raw('Stoß gegen das Gitter', 'W', 1)
    p.go('Hof, Blick West', at(17, 3, 3))
    return p.segs


def main():
    sys.path.insert(0, os.path.join(ROOT, 'demo'))
    sc, L = demo_build.load_world()
    segs = plan(sc.dmp, os.path.join(HERE, 'demo.bas'))
    n = 0
    for k, label, x in segs:
        print(f'{n:3} {k:<22} {label}' + (f'  (X = {x})' if x is not None else ''))
        n += len(k)
    print(f'{n} Tasten')


if __name__ == '__main__':
    main()
