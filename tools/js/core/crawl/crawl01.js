// Model of VIEW 0.1 (Crawl 128 1.0f) and offline full comparison with engine 0.2 (P7a, docs/specs/P7-crawl.md 6.2).
// Port of tools/crawl01.py.
//
// The model follows `engine/lib.s` of tag v0.1 (docs/formats.md, section "VIEW" under SPR v1): clear
// `VMF AP+400,0,7600`, WSM entries front to back with column coverage, object slots (first objects, then
// item), output backwards, walls `VMC`, sprites `VMS`/`VMC`. The cell computation is linear like in the lib
// (`pos + d * F + s * R` with 16 bits, without column wraparound; outside W * H counts as wall), MAXVIS = 22 and the
// VMS buffer of 512 bytes are reproduced.
//
// The comparison (compare) draws all free cells x 4 directions x {no ghost; ghost in every free cell (d, s),
// d = 0 ... 3, |s| <= 1, with each of the 4 directions} x {gems of the start map; all collected, exit 42} once with the
// 0.1 model and once with engine 0.2 (view.js view + runVcl, Crawl scene from crawlconv) into a VRAM with random
// content. The bytes of rows 5-99 and 100, columns 6-73 must be equal; outside the window 0.2 must not write
// anything; A = 0 for every view.
import * as V from '../view.js';
import * as T from '../tex.js';
import { Map as DbeMap, EVENT_TYPES } from '../map.js';
import { PyRandom } from '../pyrandom.js';
import * as crawlconv from './crawlconv.js';
import * as crawlmap from './crawlmap.js';
import { pyJson } from './util.js';

export const MAXVIS = 22, MAXOBJ = 8, NSETS = 4, NITEMS = 64, COLS = 128, SPRBUF_LEN = 512;
export const CLEAR_OFF = 400, CLEAR_LEN = 7600, CLEAR_VAL = 0, ROWLEN = 80;
export const F_COVER = 1, F_VMS = 1, F_OBJ = 0x80;
export const QG = Object.freeze([2, 0, 1, 3]);   // absolute sub-position q that yields drawing position p = 3 for direction v
export const ITEM_GEM = 2, ITEM_POWER = 4;
export const EXIT_OPEN = 42;                     // crawl.bas 5550: exit open
export const CMP_ROW0 = 5, CMP_ROW1 = 101;       // screen rows 5-99 and 100
export const CMP_COLS = Object.freeze([6, 74]);

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s8 = (v) => (v > 127 ? v - 256 : v);

/** Equality test of byte ranges [a0, a1) of x and y (same length, own buffers), 4 bytes at a time where aligned. */
function sameRange(x, y) {
  const x32 = x.byteOffset % 4 === 0 && y.byteOffset % 4 === 0 ? new Int32Array(x.buffer, x.byteOffset, x.length >> 2) : null;
  const y32 = x32 ? new Int32Array(y.buffer, y.byteOffset, y.length >> 2) : null;
  return (a0, a1) => {
    let i = a0;
    if (x32) {
      for (; i < a1 && i & 3; i++) if (x[i] !== y[i]) return false;
      for (; i + 4 <= a1; i += 4) if (x32[i >> 2] !== y32[i >> 2]) return false;
    }
    for (; i < a1; i++) if (x[i] !== y[i]) return false;
    return true;
  };
}

// ---------------------------------------------------------------- model VIEW 0.1

export class Model01 {
  constructor(files, ca, da, ga0) {
    const b = files['walls.wsm'].subarray(2);
    if (b[0] !== 0x57 || b[1] !== 0x53) throw new Error('walls.wsm: Magic');
    const n = b[3];
    this.clear = [u16(b, 4), u16(b, 6), b[8], b[9]];             // offset, length, value, row width
    this.ents = [];                                              // d s fl w h src dest col
    for (let i = 0; i < n; i++) {
      const o = 10 + 10 * i;
      this.ents.push([b[o], s8(b[o + 1]), b[o + 2], b[o + 3], b[o + 4], u16(b, o + 5), u16(b, o + 7), b[o + 9]]);
    }
    this.sets = [crawlconv.parseSpr(files['ghost.spr']), crawlconv.parseSpr(files['gem.spr'])];
    this.setvram = [ga0, ca];
    this.da = da;
    this.itemtab = new Array(NITEMS).fill(0);
    this.itemtab[ITEM_GEM] = 2;                                  // ITEMSET 2, 2: item 2 -> set 1
    this.vramSrc = { 0: files['ghosts.vdc'].slice(2), 1: files['font3o.vdc'].slice(2), walls: crawlconv.parseWalls(files['walls.vdc'])[1] };
  }

  /** -> [entries front -> back, error code]. objs: [[cell, set, direction]]. Entries: ['wall', [src, dest, w, h]] or
   *  ['spr', set, part]. */
  view(cells, w, h, pos, v, objs) {
    const fstep = [-w, 1, w, -1][v];
    const rstep = [1, w, -1, -w][v];
    const size = w * h;
    const cover = new Uint8Array(COLS);
    const vis = [];
    let err = 0;
    const nobj = Math.min(objs.length, MAXOBJ);
    const colFree = (c, n) => { for (let x = c; x < c + n; x++) if (!cover[x]) return true; return false; };
    const add = (item) => {
      if (vis.length >= MAXVIS) { err = 2; return true; }
      vis.push(item);
      return false;
    };
    const addParts = (oset, od, os, oang) => {
      if (oset >= NSETS || oset >= this.sets.length) return false;
      for (const p of this.sets[oset]) {
        if (p.d !== od || p.s !== os || (p.angle !== 0xFF && p.angle !== oang)) continue;
        if (colFree(p.col, p.w) && add(['spr', oset, p])) return true;
      }
      return false;
    };
    for (const [d, s, fl, ew, eh, src, dest, col] of this.ents) {
      const cell = (pos + d * fstep + s * rstep) & 0xFFFF;
      const cv = cell < size ? cells[cell] : 1;
      if (fl & F_OBJ) {
        if (cv & 1) continue;
        for (const o of objs.slice(0, nobj)) {
          if (o[0] === cell && addParts(o[1], d, s, (v + 2 - o[2]) & 3)) return [vis, err];
        }
        const g = cv & (NITEMS - 1);
        if (this.itemtab[g] && addParts(this.itemtab[g] - 1, d, s, 0xFF)) return [vis, err];
        continue;
      }
      if (!(cv & 1) || !colFree(col, ew)) continue;
      if (add(['wall', [src, dest, ew, eh]])) return [vis, err];
      if (fl & F_COVER) for (let x = col; x < col + ew; x++) cover[x] = 1;
    }
    return [vis, err];
  }

  /** Output like v_emit: clear, then from back to front. Returns the error code of the buffer (VMS space). */
  render(vram, vis, ap = 0) {
    let err = 0;
    const [o, n, val] = this.clear;
    for (let i = 0; i < n; i++) vram[(ap + o + i) & 0xFFFF] = val;
    let sbuf = 0;
    for (let k = vis.length - 1; k >= 0; k--) {
      const it = vis[k];
      if (it[0] === 'wall') {
        const [src, dest, w, h] = it[1];
        T.simVmc(vram, this.da + src, ap + dest, w, h, ROWLEN);
        continue;
      }
      const [, setn, p] = it;
      const src = this.setvram[setn] + p.src;
      if (!(p.flags & F_VMS)) { T.simVmc(vram, src, ap + p.dest, p.w, p.h, ROWLEN); continue; }
      if (sbuf + p.list.length > SPRBUF_LEN) { err = 2; continue; }
      sbuf += p.list.length;
      T.simVms(vram, src, ap + p.dest, p.list);
    }
    return err;
  }
}

// ---------------------------------------------------------------- environment for the comparison

/** Everything for the comparison: conversion, maps, 0.1 model, 0.2 scene, initial VRAM. */
export class Env {
  constructor(files, fontBytes = 1732, seed = 1) {
    this.conv = crawlconv.build(files, 0, fontBytes);
    const info = this.conv.info;
    this.m = crawlmap.convert(files['crawl128.cd1']).m;
    this.w = this.m.width; this.h = this.m.height;
    this.cells0 = this.m.cells.slice();
    // All collected: 1.0f SETCELL(pos, 0) per gem and then crawl.bas 5550 SETCELL(EX%, 42);
    // 1.1 SETITEM (content 0, tile 2 stays) and the same SETCELL(EX%, 42) on the tile plane.
    const exits = this.m.events.filter((e) => e.type === EVENT_TYPES.exit).map((e) => e.cell);
    this.cells1 = this.cells0.map((c) => (c === ITEM_GEM ? 0 : c));
    const tiles1 = this.m.cells.slice();
    for (const x of exits) { this.cells1[x] = EXIT_OPEN; tiles1[x] = EXIT_OPEN; }
    this.m1 = new DbeMap(this.m.name, this.w, this.h, this.m.tiles, tiles1, this.m.content.map((c) => (c === ITEM_GEM ? 0 : c)),
      this.m.events.slice(), this.m.start, this.m.direction, this.m.outside);
    this.model = new Model01(files, info.CA, info.DA, info.GA0);
    const c = this.conv;
    const sc = new V.Scene(c.dvg, this.m);
    sc.dts = [c.dts, null, null];
    sc.bgfill = 0;
    sc.s2 = [c.ghost, c.gem, null, null, null, null, null, null];
    sc.vramBases = { dts: [info.DA, 0, 0], dbg: 0, s2: [info.GA0, info.GA1, 0, 0, 0, 0, 0, 0] };
    sc.itemtab = new Array(64).fill(0);
    sc.itemtab[ITEM_GEM] = 2;                                    // ITEMSET 2, 2
    sc.itemph = 0; sc.ap = 0;
    sc.vmsBank1 = true;
    sc.dtsAddr = [crawlconv.LOAD.wall, 0, 0];
    sc.s2Addr = [crawlconv.LOAD.ghost, crawlconv.LOAD.gem, 0, 0, 0, 0, 0, 0];
    sc.checkLayout();
    this.sc = sc;
    const rnd = new PyRandom(seed);
    const base = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) base[i] = rnd.getrandbits(8);
    this.base1 = Uint8Array.from(base);
    const ca = info.CA, da = info.DA, g0 = info.GA0;
    this.base1.set(this.model.vramSrc[1], ca);
    this.base1.set(this.model.vramSrc.walls, da);               // 1.0f: RTV BE+D
    this.base1.set(this.model.vramSrc[0], g0);
    this.base2 = sc.makeVram(seed);
    this.base2.set(base.subarray(0, crawlconv.CA), 0);
    this.base1.set(base.subarray(0, crawlconv.CA), 0);
    this.free = [];
    this.cells0.forEach((v, i) => { if (!(v & 1)) this.free.push(i); });
  }

  /** Free cells [d, s, cell index] in the view grid d = 0 ... 3, |s| <= 1 (2D, inside the map). */
  visibleCells(pos, v) {
    const [fx, fy] = V.FORE[v], [rx, ry] = V.RIGHT[v];
    const px = pos % this.w, py = Math.floor(pos / this.w);
    const out = [];
    for (let d = 0; d < 4; d++) {
      for (const s of [-1, 0, 1]) {
        const x = px + d * fx + s * rx, y = py + d * fy + s * ry;
        if (x >= 0 && x < this.w && y >= 0 && y < this.h && !(this.cells0[y * this.w + x] & 1)) out.push([d, s, y * this.w + x]);
      }
    }
    return out;
  }

  /** List [row, column, value 0.1, value 0.2] of the deviating window bytes (rows 5-100, columns 6-73). */
  windowDiff(v1, v2) {
    const out = [];
    const same = sameRange(v1, v2);
    for (let r = CMP_ROW0; r < CMP_ROW1; r++) {
      if (same(r * 80 + CMP_COLS[0], r * 80 + CMP_COLS[1])) continue;
      for (let c = CMP_COLS[0]; c < CMP_COLS[1]; c++) {
        const a = v1[r * 80 + c], b = v2[r * 80 + c];
        if (a !== b) out.push([r, c, a, b]);
      }
    }
    return out;
  }

  /** Did 0.2 write outside the window (rows 0-95 of the window, columns 0-67)? */
  outsideChanged(v2) {
    const g = this.sc.dvg;
    const o = g.origin, st = g.stride, vw = g.vw, rows = g.vh;
    const b = this.base2;
    const end = o + (rows - 1) * st + vw;
    const same = sameRange(v2, b);
    if (v2.length !== b.length || !same(0, o) || !same(end, b.length)) return true;
    for (let r = 0; r < rows - 1; r++) if (!same(o + r * st + vw, o + (r + 1) * st)) return true;
    return false;
  }

  /** One view in both versions. ghost = null or [cell, direction]. -> {diff, a, outside, a01, nvis01, total, vcl, vms}. */
  one(pos, v, variant, ghost) {
    const cells = variant ? this.cells1 : this.cells0;
    const objs01 = ghost === null ? [] : [[ghost[0], 0, ghost[1]]];
    const [vis, err1] = this.model.view(cells, this.w, this.h, pos, v, objs01);
    const v1 = this.base1.slice();
    this.model.render(v1, vis);
    const sc = this.sc;
    sc.dmp = variant ? this.m1 : this.m;
    sc.pos = pos; sc.dir = v;
    sc.objects = ghost === null ? [] : [new V.Obj(ghost[0], 0, ghost[1], 0, QG[v])];
    const res = V.view(sc);
    const v2 = this.base2.slice();
    V.runVcl(res.bank0(), v2, res.p0, 80, res.bank1());
    const diff = this.windowDiff(v1, v2);
    return {
      diff, a: res.a, outside: this.outsideChanged(v2), a01: err1, nvis01: vis.length,
      total: res.vcllen + res.vmslen, vcl: res.vcllen, vms: res.vmslen,
    };
  }
}

/** Views of one job (position, direction): both variants, without ghost and with a ghost in every visible cell. */
export function job(e, pos, v, quick) {
  const out = { views: 0, bad: [], max_total: 0, max_vcl: 0, max_vms: 0, a_nonzero: 0, a01: 0, outside: 0, nvis01_max: 0, ghosts: 0 };
  const run = (variant, ghost) => {
    const r = e.one(pos, v, variant, ghost);
    out.views++;
    out.ghosts += ghost !== null ? 1 : 0;
    out.max_total = Math.max(out.max_total, r.total);
    out.max_vcl = Math.max(out.max_vcl, r.vcl);
    out.max_vms = Math.max(out.max_vms, r.vms);
    out.nvis01_max = Math.max(out.nvis01_max, r.nvis01);
    out.a_nonzero += r.a !== 0 ? 1 : 0;
    out.a01 += r.a01 !== 0 ? 1 : 0;
    out.outside += r.outside ? 1 : 0;
    if (r.diff.length || r.outside || r.a) {
      out.bad.push({ pos, dir: v, variant, ghost, ndiff: r.diff.length, first: r.diff.slice(0, 3), a: r.a, outside: r.outside });
    }
  };
  const cells = e.visibleCells(pos, v);
  for (const variant of [0, 1]) {
    run(variant, null);
    for (const [, , c] of cells) for (const gd of (quick ? [v, (v + 2) & 3] : [0, 1, 2, 3])) run(variant, [c, gd]);
  }
  return out;
}

/** All jobs [pos, v, quick] of the comparison. */
export const jobs = (env, quick) => env.free.flatMap((p) => [0, 1, 2, 3].map((v) => [p, v, quick]));

/** Sum of the job results (in job order) -> report. */
export function merge(env, results, quick) {
  const rep = {
    positions: env.free.length, directions: 4, views: 0, ghost_views: 0, bad: [], max_total: 0, max_vcl: 0,
    max_vms: 0, a_nonzero: 0, a01: 0, outside: 0, nvis01_max: 0, quick,
  };
  for (const r of results) {
    rep.views += r.views;
    rep.ghost_views += r.ghosts;
    rep.bad.push(...r.bad);
    for (const k of ['a_nonzero', 'a01', 'outside']) rep[k] += r[k];
    for (const k of ['max_total', 'max_vcl', 'max_vms', 'nvis01_max']) rep[k] = Math.max(rep[k], r[k]);
  }
  return rep;
}

/** Full comparison in this thread (the CLI splits the jobs over worker threads). -> report: views, bad
 *  (deviations), maxima of VCL + VMS, A != 0, etc. */
export function compare(files, { quick = false, fontBytes = 1732, env = null } = {}) {
  env = env || new Env(files, fontBytes);
  return merge(env, jobs(env, quick).map(([p, v, q]) => job(env, p, v, q)), quick);
}

/** Text lines of the Python main (summary and the first 20 deviations). */
export function summary(rep) {
  const L = [`${rep.views} views (${rep.positions} cells x 4 directions, of which ${rep.ghost_views} with ghost), `
    + `deviations: ${rep.bad.length}, A != 0: ${rep.a_nonzero}, writes outside: ${rep.outside}`,
  `VCL + VMS max ${rep.max_total} (VCL ${rep.max_vcl}, VMS ${rep.max_vms}) of 2304; `
    + `0.1: error code != 0 in ${rep.a01} views, entries max ${rep.nvis01_max}`];
  const pyb = (x) => (x ? 'True' : 'False');
  const tup = (a) => '(' + a.join(', ') + ')';
  for (const b of rep.bad.slice(0, 20)) {
    L.push(`  deviation: {'pos': ${b.pos}, 'dir': ${b.dir}, 'variant': ${b.variant}, 'ghost': ${b.ghost === null ? 'None' : tup(b.ghost)}, `
      + `'ndiff': ${b.ndiff}, 'first': [${b.first.map(tup).join(', ')}], 'a': ${b.a}, 'outside': ${pyb(b.outside)}}`);
  }
  return L;
}

/** Text of the --json report (json.dump indent=1, tuples as lists). */
export const reportJson = (rep) => pyJson(rep, 1);

/** Exit code of the Python main. */
export const exitCode = (rep) => (rep.bad.length || rep.a_nonzero || rep.outside ? 1 : 0);
