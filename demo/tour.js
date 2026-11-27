#!/usr/bin/env node
// Tour of the demo for test/vice_demo.js: key sequence that walks the demo map with the goblin routes of demo.bas.
// Port of demo/tour.py.
//
// Usage: node demo/tour.js   (prints the tour; requires demo/build.js (or build.py) to have run)
//
// The goblins take one step per valid key (demo.bas 3000-3030), so the tour is a search over the states
// (position, direction, route step of the three goblins): Dijkstra with costs W, Q, E = 1 and A, D, S = 2, blocked moves
// (MOVE X != 0) are forbidden. Each goal is a state (player cell, direction, cells of individual goblins); the waiting
// sequences (turning back and forth) follow from the goal. Bumps (wall, goblin, grate) are separate steps with an
// expected X.
//
// Each tour step: [keys, label, expected X of the last MOVE or null].
// If the map, routes or demo.bas change, the tour changes by itself; the goals remain valid (abort if one is missing).
// API: Planner, plan(dmp, basPath) -> segments, ACTION, COST.
import { realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { move } from '../tools/js/core/move.js';
import { Obj } from '../tools/js/core/view.js';
import { routes, loadWorld } from './build.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ACTION = Object.freeze({ W: 0, S: 1, A: 2, D: 3, Q: 4, E: 5 });
export const COST = Object.freeze([['W', 1], ['Q', 1], ['E', 1], ['A', 2], ['D', 2], ['S', 2]]);

/** SystemExit(message) of tour.py. */
export class TourError extends Error {
  constructor(msg) { super(msg); this.name = 'TourError'; }
}

/** Binary min-heap of [d, cnt, state, keys] ordered by (d, cnt) (cnt is unique, like the heapq tuples). */
class Heap {
  constructor() { this.a = []; }
  get length() { return this.a.length; }
  static less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const skey = ([pos, dr, gi]) => `${pos},${dr},${gi.join('.')}`;

export class Planner {
  constructor(dmp, bas) {
    this.m = dmp; this.w = dmp.width;
    this.routes = routes(bas).map((r) => r.map(([x, y]) => y * this.w + x));
    this.state = [dmp.start, dmp.direction, this.routes.map(() => 0)];
    this.keys = ''; this.segs = []; this.lastX = null;
  }

  cell(x, y) { return y * this.w + x; }

  _gstep(gi, pc) {
    return this.routes.map((r, g) => (r[(gi[g] + 1) % r.length] === pc ? gi[g] : (gi[g] + 1) % r.length));
  }

  _apply(state, k) {
    const [pos, dr, gi] = state;
    const objs = this.routes.map((r, g) => new Obj(r[gi[g]], 0, 0xFF, 0, 4));
    const mv = move(this.m, pos, dr, objs, ACTION[k]);
    return [[mv.pos, mv.dir, this._gstep(gi, mv.pos)], mv.x];
  }

  /** Goal: player at (x, y), direction d (optional), goblin n at (x, y) for {n: [x, y]} (optional). */
  at(x, y, d = null, g = null) {
    return ([pos, dr, gi]) => pos === this.cell(x, y) && (d === null || dr === d)
      && Object.entries(g || {}).every(([n, [gx, gy]]) => this.routes[n][gi[n]] === this.cell(gx, gy));
  }

  go(label, goal, limit = 400000) {
    const pq = new Heap();
    pq.push([0, 0, this.state, '']);
    const seen = new Map([[skey(this.state), 0]]);
    let cnt = 0;
    while (pq.length) {
      const [d, , s, k] = pq.pop();
      if ((seen.has(skey(s)) ? seen.get(skey(s)) : 1 << 30) < d) continue;
      if (goal(s)) {
        this.segs.push([k, label, null]);
        this.keys += k;
        this.state = s;
        return;
      }
      for (const [key, wgt] of COST) {
        const [s2, x] = this._apply(s, key);
        if (x) continue;
        const k2 = skey(s2);
        if (d + wgt < (seen.has(k2) ? seen.get(k2) : 1 << 30)) {
          seen.set(k2, d + wgt);
          cnt++;
          if (cnt > limit) throw new TourError(`Tour: search for "${label}" aborted`);
          pq.push([d + wgt, cnt, s2, k + key]);
        }
      }
    }
    throw new TourError(`Tour: no path to "${label}"`);
  }

  raw(label, keys, wantX = null) {
    let x = null;
    for (const k of keys) [this.state, x] = this._apply(this.state, k);
    if (wantX !== null && x !== wantX) throw new TourError(`Tour: "${label}": MOVE X = ${x}, expected ${wantX}`);
    this.segs.push([keys, label, wantX]);
    this.keys += keys;
  }
}

/** Tour for the map dmp and the routes in bas. Returns a list [keys, label, expected X]. */
export function plan(dmp, bas) {
  const p = new Planner(dmp, bas);
  const at = p.at.bind(p);
  p.raw('Window west d=1', 'W');
  p.go('Window south', at(2, 14, 2));
  p.go('Abyss from the west', at(13, 8, 1));
  p.raw('sideways right, back (abyss from another cell)', 'DS');
  p.go('Door with goblin in it', at(13, 7, 0, { 0: [13, 6] }));
  p.raw('Bump against goblin in the door', 'WW', 2);
  p.raw('back', 'S');
  p.go('through the door into the courtyard (sky)', at(13, 5, 0));
  p.go('Goblin clipped at the left edge', at(14, 5, 0, { 0: [13, 4] }));
  p.go('Window north d=3', at(14, 3, 0));
  p.go('Window north d=1', at(14, 1, 0));
  p.raw('Bump against the window wall', 'W', 1);
  p.go('Window east d=3', at(16, 2, 1));
  p.go('Window east d=1', at(18, 2, 1));
  p.go('Grate with gem, goblin in front', at(17, 4, 2, { 1: [17, 5] }));
  p.raw('Bump against goblin in front of the grate', 'W', 2);
  p.go('Grate d=1', at(17, 5, 2));
  p.raw('Bump against the grate', 'W', 1);
  p.go('Courtyard, looking west', at(17, 3, 3));
  return p.segs;
}

/** Text lines of the Python main. */
export function tourLines(segs) {
  const L = [];
  let n = 0;
  for (const [k, label, x] of segs) {
    L.push(`${String(n).padStart(3)} ${k.padEnd(22)} ${label}` + (x !== null ? `  (X = ${x})` : ''));
    n += k.length;
  }
  L.push(`${n} keys`);
  return L;
}

export function main(out = undefined) {
  try {
    const [sc] = loadWorld(out);
    for (const l of tourLines(plan(sc.dmp, join(HERE, 'demo.bas')))) console.log(l);
    return 0;
  } catch (e) {
    if (e instanceof TourError) { process.stderr.write(e.message + '\n'); return 1; }
    throw e;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
