// Crawl 128 data (1.0f, engine 0.1) -> engine 0.2 files (P7a, docs/specs/P7-crawl.md section 3). Port of
// tools/crawlconv.py.
//
// Inputs (1.0f files, unchanged): walls.vdc, walls.wsm, ghost.spr, ghosts.vdc, gem.spr, font3o.vdc
// (optionally crawl128.cd1 for crawl.dmp and the size of the automap).
// Free Crawl DVG instead of the Westwood preset (review-notes G.6): each of the 19 wall images is a DVG element with its
// rectangle, the DTS contains only cores (image = one core = full rectangle), ghosts and gems are S2 images with
// anchors at the 1.0f positions. The wallpaper is the fill byte 0 (BGSET without DBG).
//
// Outputs (Result.files): crawl.dvg (bank 1 $E800), walls.dts (bank 1 $8000), walls.vrl | walls1.vrl ... wallsN.vrl,
// ghost.s2 + ghost.vrl (bank 1 $6000), gem.s2 + gem.vrl (bank 1 $7000), crawl.dmp (only with crawl128.cd1, $4000);
// outputs() adds crawlconv.md and with asJson crawlconv.json.
//
// API: readFiles(resolve, where) -> files, build(files, maxPart, fontBytes) -> Result, reportMd(r), outputs(r, asJson).
// ConvError (Python ConvError) with the same texts.
import * as V from '../view.js';
import * as T from '../tex.js';
import * as vrl from '../vrl.js';
import { rangeError } from '../mem.js';
import { toDmp, checkBank1 } from '../map.js';
import * as wallconv from './wallconv.js';
import * as crawlmap from './crawlmap.js';
import { pyJson, tupleRepr, listRepr } from './util.js';

export const FILES = Object.freeze(['walls.vdc', 'walls.wsm', 'ghost.spr', 'ghosts.vdc', 'gem.spr', 'font3o.vdc']);
export const OPTIONAL = Object.freeze(['crawl128.cd1']);

export const VW = 68, VH = 96, D = 3, S = 1;
export const STRIDE = 80, ORIGIN = 406;
export const HY0 = 0, HY1 = 95;                 // row 95 of the window stays with the walls (screen row 100, spec 1.2)
export const FULL = 96;                         // height of the covering images
export const VIEW_COL0 = 6, VIEW_ROW0 = 5;      // top left corner of the window in the 1.0f image buffer (406 = 5 * 80 + 6)
export const ROW = 80;
export const LOAD = Object.freeze({ dvg: 0xE800, wall: 0x8000, ghost: 0x6000, gem: 0x7000, dmp: 0x4000 });
export const S2_MAX = 0x1000;                   // area per sprite set up to the next load address
export const CA = 19200;                        // character set in VRAM (AP + VR(1) + VR(1))
export const VR0 = 46335;                       // screen RAM (bitmap)
export const GEM_CHARS = Object.freeze([4, 5]); // font characters of the gem (CHR$(36) CHR$(37))
export const GHOST_ANGLES = 4;
export const MASK_BG = Object.freeze([0x00, 0xFF]);   // two background patterns for the transparency mask (3.4)
export const P_GEM = 2, P_GHOST = 3;            // object slots: center = gem, front left = ghost

export class ConvError extends Error {
  constructor(msg) { super(msg); this.name = 'ConvError'; }
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s8 = (v) => (v > 127 ? v - 256 : v);
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cmpTuple = wallconv.cmpTuple;

// ---------------------------------------------------------------- read inputs

/** Input files through a resolver (name -> bytes or null) -> {name: bytes}; where: folder name for the message. */
export function readFiles(resolve, where) {
  const out = {};
  for (const n of [...FILES, ...OPTIONAL]) {
    const d = resolve(n);
    if (d !== null && d !== undefined) out[n] = d instanceof Uint8Array ? d : new Uint8Array(d);
    else if (FILES.includes(n)) throw new ConvError(`${n} missing in ${where}`);
  }
  return out;
}

/** walls.vdc (PRG) -> [entries [[slot, src, w, h, size, col]], image data from 1 + 7 n]. */
export function parseWalls(data) {
  const b = data.subarray(2);
  const n = b[0];
  const hdr = 1 + 7 * n;
  const ents = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + 7 * i;
    const src = u16(b, o), w = b[o + 2], h = b[o + 3], size = u16(b, o + 4), col = b[o + 6];
    if (src + w * h > b.length - hdr || size !== w * h) {
      throw new ConvError(`walls.vdc: image ${i + 1} (src ${src}, ${w} x ${h}, size ${size}) does not fit in the file`);
    }
    ents.push([i + 1, src, w, h, size, col]);
  }
  if (n !== wallconv.NSLOTS) throw new ConvError(`walls.vdc: ${n} images, expected ${wallconv.NSLOTS}`);
  return [ents, b.slice(hdr)];
}

/** ghost.spr / gem.spr (PRG, sprite metadata v1) -> list of parts. */
export function parseSpr(data) {
  const b = data.subarray(2);
  if (b[0] !== 0x53 || b[1] !== 0x50 || b[2] !== 1) throw new ConvError('SPR: Magic/Version');
  const parts = [];
  for (let i = 0; i < b[3]; i++) {
    const o = 6 + 15 * i;
    const ll = u16(b, o + 11), lo = u16(b, o + 13);
    parts.push({
      d: b[o], s: s8(b[o + 1]), angle: b[o + 2], flags: b[o + 3], w: b[o + 4], h: b[o + 5], src: u16(b, o + 6),
      dest: u16(b, o + 8), col: b[o + 10], list: ll ? b.slice(lo, lo + ll) : new Uint8Array(0),
    });
  }
  return parts;
}

/** walls.wsm (PRG) -> [[index, d, s, flags, w, h, src, dest]] without header. */
export function wsmEntries(data) {
  const b = data.subarray(2);
  if (b[0] !== 0x57 || b[1] !== 0x53 || b[2] !== 1) throw new ConvError('walls.wsm: Magic/Version');
  const out = [];
  for (let i = 0; i < b[3]; i++) {
    const o = 10 + 10 * i;
    out.push([i, b[o], s8(b[o + 1]), b[o + 2], b[o + 3], b[o + 4], u16(b, o + 5), u16(b, o + 7)]);
  }
  return out;
}

// ---------------------------------------------------------------- DVG

/** Target (relative to AP) -> [byte column, row] relative to the window. */
export function anchor(dest) { return [dest % ROW - VIEW_COL0, Math.floor(dest / ROW) - VIEW_ROW0]; }

/** Wall images grouped by cell "d,s" (Map), per cell sorted by (face, slot, ...). */
export function wallElements(walls) {
  const byCell = new Map();
  for (const [slot, src, w, h, , col] of walls) {
    const [d, s, face] = wallconv.SLOTS[slot];
    const k = `${d},${s}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push([face, slot, src, w, h, col]);
  }
  for (const lst of byCell.values()) lst.sort(cmpTuple);
  return byCell;
}

/** -> [Dvg, wallOrder]; wallOrder = [[slot, src, w, h]] in element order (= slot order in the DTS).
 *  ghostAnchor / gemAnchor: Map d -> Map s -> [x, y]. */
export function buildDvg(walls, ghostAnchor, gemAnchor) {
  const byCell = wallElements(walls);
  const elems = [], order = [], depth = [];
  for (let d = 0; d <= D; d++) {
    const first = elems.length;
    let fw = 0, fx = 0;
    for (const s of [0, -1, 1]) {
      for (const [face, slot, src, w, h, col] of byCell.get(`${d},${s}`) || []) {
        const art = face === wallconv.FRONT ? V.ART_FRONT : V.ART_SIDE;
        const full = h === FULL;
        const fl = (full ? 1 : 0) | (full && art === V.ART_FRONT ? 8 : 0);
        elems.push(new V.Elem(elems.length, art, d, s, fl, {
          x: col, y: 0, w, h, kx: 0, ky: 0, kw: w, kh: h, c0: full ? col : 0, c1: full ? col + w : 0,
        }));
        order.push([slot, src, w, h]);
        if (art === V.ART_FRONT && s === 0) { fw = w; fx = col; }
      }
      if (d >= 1) {
        const ga = ghostAnchor.get(Math.min(d, 2)).get(s), ma = gemAnchor.get(Math.min(d, 2)).get(s);
        const anchors = [ma, ma, ma, ga, ma];
        elems.push(new V.Elem(elems.length, V.ART_OBJ, d, s, 0, { anchors }));
      }
    }
    depth.push(new V.DepthRow(0, 0, 0, 0, first, elems.length - first, fw, fx));
  }
  const dvg = new V.Dvg(VW, VH, D, S, STRIDE, ORIGIN, 0, HY0, HY1, depth, elems);
  dvg.gid = T.dvgId(V.dvgBytes(dvg).subarray(2));
  return [dvg, order];
}

// ---------------------------------------------------------------- DTS

/** Wall DTS, cores only: image k = slot k = k-th wall element; VRAM data = the image data of walls.vdc. */
export function buildDts(dvg, order, vram) {
  const smap = [];
  let k = 0;
  for (const e of dvg.elems) {
    if (e.art === V.ART_OBJ) smap.push(T.FALLBACK);
    else smap.push(k++);
  }
  for (let i = 0; i < 2 * (dvg.D + 1); i++) smap.push(T.FALLBACK);
  const entries = order.map(([, src, w, h], i) => new T.Entry({
    slot: i, flags: h === FULL ? T.F_OCCLUDING : 0, cores: [new T.Core(src, 0, 0, w, h, 0)], h,
  }));
  const ts = new T.TexSet(0, dvg.gid, dvg.elems.length, dvg.D, dvg.stride, smap, [order.map((_, i) => i)], entries,
    Uint8Array.from(vram));
  const prg = T.toDts(ts, LOAD.wall);
  return [prg, T.fromDts(prg, vram)];
}

// ---------------------------------------------------------------- S2: ghost and gem

/** Pixel rows (palette index or null) of the ghost part: render twice with simVms on different backgrounds,
 *  a pixel is opaque if both runs show the same value (3.4). */
export function ghostMask(vram, part) {
  const { w, h } = part;
  const runs = MASK_BG.map((bg) => {
    const fb = new Uint8Array(ROW * (h + 1)).fill(bg);
    T.simVms(vram, part.src, 0, part.list, fb);
    return fb;
  });
  const rows = [];
  for (let r = 0; r < h; r++) {
    const line = [];
    for (let bx = 0; bx < w; bx++) {
      const a = runs[0][r * ROW + bx], b = runs[1][r * ROW + bx];
      line.push(a >> 4 === b >> 4 ? a >> 4 : null, (a & 15) === (b & 15) ? a & 15 : null);
    }
    rows.push(line);
  }
  return rows;
}

const partKey = (p) => tupleRepr([p.d, p.s, p.angle]);

/** -> [S2 PRG, VRAM data, SpriteSet, Map "d,angle" -> rows]; check: sides equal the center. */
export function buildGhost(gparts, ghostVram, gid) {
  const mid = new Map();
  for (const p of gparts) {
    if (p.flags !== 1 || p.w > 127) throw new ConvError(`ghost.spr: part ${partKey(p)} is not a VMS part`);
    if (p.s === 0) mid.set(`${p.d},${p.angle}`, p);
  }
  for (const p of gparts) {
    const m = mid.get(`${p.d},${p.angle}`);
    if (!m || p.w !== m.w || p.h !== m.h || p.src !== m.src || !eqBytes(p.list, m.list)) {
      throw new ConvError(`ghost.spr: part ${partKey(p)} differs from (d, 0, a) (list/data)`);
    }
  }
  const images = new Map(), rowsBy = new Map();
  for (const p of gparts) {
    if (p.s !== 0) continue;
    const rows = ghostMask(ghostVram, p);
    rowsBy.set(`${p.d},${p.angle}`, rows);
    images.set(`0,${p.angle},${p.d}`, [[0, p.angle, p.d], [rows, 0, 0]]);
  }
  const ds = [...new Set([...rowsBy.keys()].map((k) => +k.split(',')[0]))].sort((a, b) => a - b);
  const as = new Set([...rowsBy.keys()].map((k) => +k.split(',')[1]));
  if (ds.join() !== '1,2' || as.size !== GHOST_ANGLES || ![0, 1, 2, 3].every((a) => as.has(a))) {
    throw new ConvError('ghost.spr: expects depths 1 and 2 and view angles 0-3');
  }
  const [prg, vram] = V.makeS2([...images.values()], D, GHOST_ANGLES, 1, STRIDE,
    { angleMap: [0, 1, 2, 3], gid, maxCores: 16, load: LOAD.ghost });
  return [prg, vram, V.readS2(prg, vram), rowsBy];
}

/** One image 6 x 6 bytes from the font characters 4 and 5 (3 bytes x 6 rows each), fully opaque. */
export function buildGem(font, gid) {
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const line = [];
    for (const ch of GEM_CHARS) {
      for (const b of font.subarray(ch * 18 + 3 * r, ch * 18 + 3 * r + 3)) line.push(b >> 4, b & 15);
    }
    rows.push(line);
  }
  const images = [1, 2].map((d) => [[0, 0, d], [rows, 0, 0]]);
  const [prg, vram] = V.makeS2(images, D, 1, 1, STRIDE, { angleMap: [0, 0, 0, 0], gid, flags: 1, maxCores: 16, load: LOAD.gem });
  return [prg, vram, V.readS2(prg, vram)];
}

/** Anchors per depth (1, 2) and side: ghost = corner of the part (d, s, 0), gem = corner of the first character.
 *  -> [ga, ma] as Map d -> Map s -> [x, y]. */
export function anchorsFromParts(ghostParts, gemParts) {
  const ga = new Map([[1, new Map()], [2, new Map()]]);
  const ma = new Map([[1, new Map()], [2, new Map()]]);
  for (const p of ghostParts) if (p.angle === 0) ga.get(p.d).set(p.s, anchor(p.dest));
  const by = new Map();
  for (const p of gemParts) {
    const k = `${p.d},${p.s}`;
    if (!by.has(k)) by.set(k, [[p.d, p.s], []]);
    by.get(k)[1].push(p);
  }
  for (const [[d, s], ps] of by.values()) {
    if (ps.length !== 2 || ps[0].src !== GEM_CHARS[0] * 18 || ps[1].src !== GEM_CHARS[1] * 18) {
      throw new ConvError(`gem.spr: cell ${tupleRepr([d, s])}: expects the font characters ${tupleRepr(GEM_CHARS)}`);
    }
    const [a, b] = ps;
    if (b.dest !== a.dest + 3 || a.w !== 3 || a.h !== 6 || b.w !== 3 || b.h !== 6 || a.flags || b.flags || a.angle !== 0xFF) {
      throw new ConvError(`gem.spr: cell ${tupleRepr([d, s])}: second character not 3 bytes to the right`);
    }
    ma.get(d).set(s, anchor(a.dest));
  }
  for (const t of [ga, ma]) {
    for (const d of [1, 2]) {
      const ks = [...t.get(d).keys()].sort((x, y) => x - y);
      if (ks.join() !== '-1,0,1') throw new ConvError(`anchors for depth ${d} incomplete: ${listRepr(ks)}`);
    }
  }
  return [ga, ma];
}

// ---------------------------------------------------------------- VRL, parts

/** VRL files (PRG frame). maxPart 0 = one file; otherwise parts at image boundaries (bounds = starts of the images),
 *  each part begins (except at offset 0) with a skip to its offset so that all parts go to the same
 *  target (RXV BE+5,DA). An image that alone is already larger than maxPart forms a part of its own. */
export function vrlParts(vram, bounds, maxPart) {
  const whole = vrl.packFile(vrl.encode(Array.from(vram)));
  if (!maxPart || whole.length <= maxPart) return [whole];
  let cuts = [...new Set([...bounds, 0])].sort((a, b) => a - b);
  cuts = [...cuts.filter((c) => c < vram.length), vram.length];
  const pack = (a, b) => vrl.packFile(vrl.encode([...new Array(cuts[a]).fill(vrl.SKIP), ...vram.subarray(cuts[a], cuts[b])]));
  const parts = [];
  let si = 0;
  while (si < cuts.length - 1) {
    let ei = si + 1, f = pack(si, si + 1);
    while (ei + 1 < cuts.length) {
      const g = pack(si, ei + 1);
      if (g.length > maxPart) break;
      ei++; f = g;
    }
    parts.push(f);
    si = ei;
  }
  return parts;
}

// ---------------------------------------------------------------- overall conversion

export class Result {
  constructor(f = {}) {
    Object.assign(this, {
      files: {}, dvg: null, dts: null, ghost: null, gem: null, ghostRows: new Map(), wallVram: new Uint8Array(0),
      ghostVram: new Uint8Array(0), gemVram: new Uint8Array(0), info: {}, anchors: {}, nparts: 1,
    }, f);
  }
}

/** files: input files (readFiles). ConvError on errors.
 *  fontBytes: length of the character set in VRAM; default = file length of font3o.vdc without the load address. */
export function build(files, maxPart = 0, fontBytes = null) {
  if (fontBytes === null || fontBytes === undefined) fontBytes = files['font3o.vdc'].length - 2;
  const [walls, wvram] = parseWalls(files['walls.vdc']);
  // Cross-check against walls.wsm (position, faces, columns): the file of the 1.0f disk must match walls.vdc
  const wsm = wsmEntries(files['walls.wsm']).filter((e) => !(e[3] & 0x80)).map((e) => e.slice(1)).sort(cmpTuple);
  const mine = walls.map(([slot, src, w, h, , col]) => {
    const [d, s] = wallconv.SLOTS[slot];
    return [d, s, h === FULL ? 1 : 0, w, h, src, wallconv.DEST_BASE + col];
  }).sort(cmpTuple);
  if (wsm.length !== mine.length || wsm.some((e, i) => cmpTuple(e, mine[i]) !== 0)) throw new ConvError('walls.wsm does not match walls.vdc');
  const gparts = parseSpr(files['ghost.spr']);
  const mparts = parseSpr(files['gem.spr']);
  const [ga, ma] = anchorsFromParts(gparts, mparts);
  ga.set(3, ga.get(2)); ma.set(3, ma.get(2));
  const ghostVram = files['ghosts.vdc'].slice(2);
  const font = files['font3o.vdc'].slice(2);
  const [dvg, order] = buildDvg(walls, ga, ma);
  const dvgPrg = V.dvgBytes(dvg, LOAD.dvg);
  const dvg2 = V.parseDvg(dvgPrg);
  if (dvg2.gid === 0 || T.dvgId(dvgPrg.subarray(2)) !== dvg2.gid) throw new ConvError('geometry ID wrong');
  let err = rangeError('dvg', LOAD.dvg, dvgPrg.length - 2);
  if (err) throw new ConvError(err);
  const [dtsPrg, ts] = buildDts(dvg2, order, wvram);
  err = rangeError('wall', LOAD.wall, dtsPrg.length - 2);
  if (err) throw new ConvError(err);
  const [gprg, gv, gss, rowsBy] = buildGhost(gparts, ghostVram, dvg2.gid);
  const [eprg, ev, ess] = buildGem(font, dvg2.gid);
  for (const [name, prg] of [['ghost.s2', gprg], ['gem.s2', eprg]]) {
    if (prg.length - 2 > S2_MAX) throw new ConvError(`${name}: ${prg.length - 2} bytes > $${S2_MAX.toString(16).toUpperCase()}`);
  }
  const r = new Result({
    dvg: dvg2, dts: ts, ghost: gss, gem: ess, ghostRows: rowsBy, wallVram: wvram, ghostVram: gv, gemVram: ev,
    anchors: { ghost: ga, gem: ma },
  });
  const f = r.files;
  f['crawl.dvg'] = dvgPrg; f['walls.dts'] = dtsPrg; f['ghost.s2'] = gprg; f['gem.s2'] = eprg;
  const bounds = order.map((o) => o[1]).sort((a, b) => a - b);
  const wparts = vrlParts(wvram, bounds, maxPart);
  r.nparts = wparts.length;
  if (wparts.length === 1) f['walls.vrl'] = wparts[0];
  else wparts.forEach((p, i) => { f[`walls${i + 1}.vrl`] = p; });
  f['ghost.vrl'] = vrl.packFile(vrl.encode(Array.from(gv)));
  f['gem.vrl'] = vrl.packFile(vrl.encode(Array.from(ev)));
  // map
  let mw = null, mh = null;
  if ('crawl128.cd1' in files) {
    const { m } = crawlmap.convert(files['crawl128.cd1']);
    const dmp = toDmp(m, LOAD.dmp);
    checkBank1(LOAD.dmp, dmp.length - 2);
    f['crawl.dmp'] = dmp;
    mw = m.width; mh = m.height;
  }
  mw = mw || 20; mh = mh || 11;
  // VRAM total (2.3)
  const da = CA + fontBytes;
  const g0 = da + wvram.length;
  const g1 = g0 + gv.length;
  const ma_ = g1 + ev.length;
  const end = ma_ + 2 * mw * mh;
  r.info = {
    font_bytes: fontBytes, CA, DA: da, GA0: g0, GA1: g1, MA: ma_, vram_end: end, vram_limit: VR0,
    vram_reserve: VR0 - end, map_wh: [mw, mh], u_walls: wvram.length, u_ghost: gv.length, u_gem: ev.length,
    max_part: maxPart, nparts: wparts.length,
  };
  if (end > VR0) throw new ConvError(`VRAM total ${end} > ${VR0} (MA + 2*W*H)`);
  return r;
}

// ---------------------------------------------------------------- report

const hex4 = (v) => '0x' + v.toString(16).padStart(4, '0');
const sgn = (v) => (v < 0 ? String(v) : '+' + v);

export function reportMd(r) {
  const g = r.dvg, i = r.info;
  const L = ['# crawlconv: Crawl 128 to engine 0.2', '',
    `DVG: ${g.vw} x ${g.vh}, D = ${g.D}, S = ${g.S}, stride ${g.stride}, origin ${g.origin}, geometry ID `
    + `${hex4(g.gid)}, horizon [${g.hy0}, ${g.hy1}), ${g.elems.length} elements`, '',
    '## Elements', '', '| # | Kind | d | s | Flags | x | y | w | h | c0 | c1 |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const e of g.elems) {
    const art = ['front', 'side', 'floor', 'ceiling', 'Obj'][e.art];
    if (e.art === V.ART_OBJ) {
      L.push(`| ${e.index} | Obj | ${e.d} | ${sgn(e.s)} | - | `
        + e.anchors.map((a, p) => [p, a]).filter(([p]) => p === P_GEM || p === P_GHOST).map(([p, a]) => `p${p} (${a[0]},${a[1]})`).join(', ')
        + ' | | | | | |');
    } else {
      L.push(`| ${e.index} | ${art} | ${e.d} | ${sgn(e.s)} | ${e.flags} | ${e.x} | ${e.y} | ${e.w} | ${e.h} | ${e.c0} | ${e.c1} |`);
    }
  }
  L.push('', 'Anchors: p = 2 (center) gem, p = 3 (front left) ghost, byte column and row relative to the window; '
    + 'depth 3 = values of depth 2.', '',
  '## Files', '', '| File | Bank / target | Bytes |', '|---|---|---|');
  const where = {
    'crawl.dvg': 'bank 1 $E800', 'walls.dts': 'bank 1 $8000', 'ghost.s2': 'bank 1 $6000',
    'gem.s2': 'bank 1 $7000', 'crawl.dmp': 'bank 1 $4000',
  };
  for (const n of Object.keys(r.files).sort()) L.push(`| ${n} | ${where[n] || 'bank 0 at BE, via RXV'} | ${r.files[n].length} |`);
  L.push('', `VRL parts of the wall images: N = ${r.nparts} (--max-part ${i.max_part}).`, '',
    '## VRAM (2.3)', '', '| Name | Address | Bytes |', '|---|---|---|',
    `| CA character set | ${i.CA} | ${i.font_bytes} |`, `| DA wall DTS data | ${i.DA} | ${i.u_walls} |`,
    `| GA(0) ghost | ${i.GA0} | ${i.u_ghost} |`, `| GA(1) gem | ${i.GA1} | ${i.u_gem} |`,
    `| GA(2) = MA Automap | ${i.MA} | ${2 * i.map_wh[0] * i.map_wh[1]} |`, '',
    `End ${i.vram_end}, limit ${i.vram_limit}, reserve ${i.vram_reserve} bytes.`, '');
  return L.join('\n');
}

/** Text of crawlconv.json (json.dump indent=1). */
export function reportJson(r) {
  const files = {};
  for (const [n, d] of Object.entries(r.files)) files[n] = d.length;
  const anchors = {};
  for (const [k, t] of Object.entries(r.anchors)) {
    anchors[k] = new Map([...t.entries()].map(([d, v]) => [String(d), new Map([...v.entries()].map(([s, a]) => [String(s), [...a]]))]));
  }
  return pyJson({ info: r.info, files, gid: r.dvg.gid, nelems: r.dvg.elems.length, anchors }, 1);
}

/** All files the Python write() creates: the outputs, crawlconv.md and with asJson crawlconv.json. */
export function outputs(r, asJson = false) {
  const out = { ...r.files, 'crawlconv.md': reportMd(r) };
  if (asJson) out['crawlconv.json'] = reportJson(r);
  return out;
}
