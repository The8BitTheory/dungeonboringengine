#!/usr/bin/env node
// VICE test of the demo (docs/specs/P7-crawl.md 8.6): tour with keys, whole VRAM per frame against the model.
// Port of test/vice_demo.py onto tools/js/core, demo/build.js, demo/tour.js and test/lib/vice.js.
//
// Usage: node test/vice_demo.js [--port N] [--timeout S] [--only i|c] [--check] [--png DIR] [--shots DIR] [--control]
//                               [--no-fast] [--no-build] [--d81] [--budget [N]]
//   --check    model only: build files (demo/build.js), play the tour with the goblin model, compute the model per frame
//              (view.js view/runVcl, window against paintReference), check coverage of the tour; no VICE
//   --png DIR  frames of the tour from the model (montage scenes.png and frame_NN.png per frame)
//   --shots DIR  in the VICE run, take a VDC screenshot of every frame (DIR/<version>_NN.png)
//   --control  control run: corrupt one byte in the window of the model of frame 5; the run must report exactly this frame
//   --no-fast  without the second run at 2 MHz (FAST during VIEW and VCL, demo.bas line 3: fs = 1)
//   --budget [N]  additionally the view.js budget over all views with goblins (demo/build.js --budget, N states)
//
// Flow (demo/build.js builds files, program and disk; BOOT with `50 RUN"DEMO"`): VICE starts the PRG BOOT from the disk
// (interpreted and as a Blitz! compilation with runtime image 2). The harness stops at GETIN ($FFE4); if no key is in the
// buffer ($D0 = 0) and the object count $0C50 = 3, the program is waiting for a key: prompt. At each prompt:
//   * whole 64 KB VRAM (`bank vdc`, bsave) against the model: runVcl of the VIEW reference on the carried-forward
//     VRAM (plus compass: VDB below the window); the window additionally against view.js paintReference
//   * parameter block VCLADR/VCLLEN/VMSLEN/OBJVIS ($0C0A-$0C11), VCL list in the buffer, ITEMPH ($0C08)
//   * object list $0C50-$0CB0 against the goblin model (routes from demo.bas), content layer of the
//     working copy (bank 1 $5000 + W*H, with automap bits) against the model
// The model gets position and direction from the keys (move.js with the real object list) and the scene from the
// real object list; no sleep, no fixed delays: breakpoints (GETIN, BASIC error vector $0300, stub, VCL),
// there is no debug cartridge (end after the last key X via breakpoint on CHRIN $FFCF = direct mode).
// Cycles per key (stopwatch, clocks at 1 MHz): total (key to next prompt), VIEW (stub), MOVE (stub), VCL.
// Port rule (review-notes A): --port, else DBE_VICE_PORT, else 6631, range 6631-6649, bind test, only the own process.
// Requirements: VDC-BASIC v3 (VDCBASIC_DIR, read only), c1541, ACME (labels of VDC-BASIC); the Blitz! run additionally
// needs node and blitzc (otherwise SKIP).
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../tools/js/core/view.js';
import { move } from '../tools/js/core/move.js';
import { encodePng } from '../tools/js/core/io/png.js';
import * as demoBuild from '../demo/build.js';
import * as demoTour from '../demo/tour.js';
import * as vs from './lib/vice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const BAS = join(ROOT, 'demo', 'demo.bas');

export const OUT = demoBuild.OUT;
export const GETIN = 0xFFE4, CHRIN = 0xFFCF;
export const BUF = Object.freeze([0x1300, 0x1C00]);
export const NOBJ = 3;                   // goblins in demo.bas (OBJN)
export const ACTION = Object.freeze({ W: 0, S: 1, A: 2, D: 3, Q: 4, E: 5 });

const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const winEq = (sc, a, b) => {
  const x = V.windowBytes(sc, a), y = V.windowBytes(sc, b);
  return x.every((r, i) => eqBytes(r, y[i]));
};
const hex = (v) => '0x' + v.toString(16);
const pad = (v, n) => String(v).padStart(n);
const padR = (v, n) => String(v).padEnd(n);

// ------------------------------------------------------------------ Tour (demo/tour.js)

/** Tour (list of [keys, label, expected X]) and the key sequence (without the final X). */
export function tourKeys(sc0) {
  const segs = demoTour.plan(sc0.dmp, BAS);
  return [segs, segs.map((s) => s[0]).join('')];
}

/** demo.bas 3000-3120: routes from the DATA lines, one step per valid key; waits if the next cell is the player cell.
 *  The test checks the real object list against this model. */
export class GoblinSim {
  constructor(bas, w) {
    this.routes = demoBuild.routes(bas).map((r) => r.map(([x, y]) => y * w + x));
    this.gi = this.routes.map(() => 0);
    this.fc = 0;
  }

  step(pc) {
    this.fc++;
    this.routes.forEach((r, g) => {
      const n = (this.gi[g] + 1) % r.length;
      if (r[n] !== pc) this.gi[g] = n;
    });
  }

  /** Object list as 6-byte entries (as demo.bas writes them to $0C51). */
  objects() {
    return this.routes.map((r, g) => {
      const t = r[this.gi[g]];
      return [t & 255, t >> 8, 0, 255, (this.fc + g) & 3, 4];
    });
  }

  itemph() { return this.fc & 1; }

  clone() { const c = Object.create(GoblinSim.prototype); c.routes = this.routes; c.gi = this.gi.slice(); c.fc = this.fc; return c; }
}

export const objsFromBytes = (lst) => lst.map((e) => new V.Obj(e[0] | (e[1] << 8), e[2], e[3], e[4], e[5] & 7, !!(e[5] & 0x40), !!(e[5] & 0x80)));

/** State of the tour in the model: position, direction, VRAM, map (automap bits travel along). */
export class Run {
  constructor(sc0, L) {
    this.sc0 = sc0;
    this.L = L;
    this.map = sc0.dmp.clone();
    this.pos = this.map.start; this.dir = this.map.direction;
    this.vram = this.initialVram();
  }

  initialVram() {
    const v = new Uint8Array(65536);
    v.fill(0x1F, 8000, 9600);
    v.fill(15, 46335, 46335 + 16000);
    for (const [, base, data] of this.sc0.assets()) v.set(data, base);
    return v;
  }

  scene(objs, itemph) {
    const sc = this.sc0.copy();
    sc.dmp = this.map;                      // automap: view() sets the bits in this map
    const vb = this.sc0.vramBases;
    sc.vramBases = { dts: vb.dts.slice(), dbg: vb.dbg, s2: vb.s2.slice() };
    sc.pos = this.pos; sc.dir = this.dir; sc.objects = objs.slice(); sc.itemph = itemph;
    return sc;
  }

  /** demo.bas 3240-3270: VDM 1,0,80; VDB 60 + 10 d, 97, 8, 3, c (15 active, otherwise 1), chunky: 2 pixels per byte. */
  compass() {
    for (let d = 0; d < 4; d++) {
      const c = d === this.dir ? 15 : 1;
      for (let y = 97; y < 100; y++) {
        for (let x = 60 + 10 * d; x < 68 + 10 * d; x++) {
          const a = y * 80 + (x >> 1);
          this.vram[a] = x % 2 === 0 ? (this.vram[a] & 0x0F) | (c << 4) : (this.vram[a] & 0xF0) | c;
        }
      }
    }
  }

  /** VIEW + VCL + compass on the carried-forward VRAM. Returns {sc, res, vram, ref, content, pos, dir}. */
  frame(objs, itemph) {
    const sc = this.scene(objs, itemph);
    const before = this.vram.slice();
    const res = V.view(sc);
    V.runVcl(res.bank0(), this.vram, res.p0, 80, res.bank1());
    const ref = res.a === 0 ? V.paintReference(sc, before.slice()) : null;
    this.compass();
    return { sc, res, vram: this.vram.slice(), ref, content: Uint8Array.from(this.map.content), pos: this.pos, dir: this.dir };
  }

  /** Key k: MOVE with the object list before the move (as in the program), returns the move result or null. */
  key(k, objs) {
    if (!(k in ACTION)) return null;
    const mv = move(this.map, this.pos, this.dir, objs, ACTION[k]);
    if (mv.a !== 0) throw new Error(`AssertionError: MOVE A = ${mv.a}`);
    this.pos = mv.pos; this.dir = mv.dir;
    return mv;
  }
}

/** Tour in the model with the goblin model. Returns [Run, frames]; frame i belongs to prompt i (0 = before the first key). */
export function play(sc0, L, bas, keys) {
  const r = new Run(sc0, L);
  const gs = new GoblinSim(bas, sc0.dmp.width);
  const frames = [];
  let objsB = gs.objects();
  let fr = r.frame(objsFromBytes(objsB), gs.itemph());
  Object.assign(fr, { key: '', mv: null, objs: objsB, gs: gs.clone() });
  frames.push(fr);
  for (const k of keys) {
    const mv = r.key(k, objsFromBytes(frames[frames.length - 1].objs));
    gs.step(r.pos);
    objsB = gs.objects();
    fr = r.frame(objsFromBytes(objsB), gs.itemph());
    Object.assign(fr, { key: k, mv, objs: objsB, gs: gs.clone() });
    frames.push(fr);
  }
  return [r, frames];
}

// ------------------------------------------------------------------ Check in the model (without VICE)

/** Expectations of the tour: MOVE X of the bump steps, A = 0 everywhere, goblins visible in many frames, window against
 *  paintReference. Returns a list of error texts. */
export function checkTour(sc0, segs, frames) {
  const err = [];
  let i = 0;
  for (const [keys, label, wantX] of segs) {
    i += keys.length;
    const mv = frames[i].mv;
    if (wantX !== null && (mv === null || mv.x !== wantX)) err.push(`Frame ${i} (${label}): MOVE X = ${mv ? mv.x : 'None'}, expected ${wantX}`);
  }
  frames.forEach((f, k) => {
    if (f.res.a) err.push(`Frame ${k}: VIEW A = ${f.res.a}`);
    else if (f.ref !== null && !winEq(f.sc, f.vram, f.ref)) err.push(`Frame ${k}: window differs from paint_reference`);
  });
  const vis = frames.filter((f) => f.res.objvis).length;
  if (vis < 10) err.push(`only ${vis} frames with a visible goblin`);
  return err;
}

export function writePngs(frames, png) {
  mkdirSync(png, { recursive: true });
  const ims = frames.map((f, k) => {
    const im = V.windowImage(f.sc, f.vram, 2);
    writeFileSync(join(png, `frame_${String(k).padStart(2, '0')}.png`), encodePng(im));
    return im;
  });
  const cols = 6, w = ims[0].width, h = ims[0].height;
  const W = cols * (w + 4), H = Math.ceil(ims.length / cols) * (h + 4);
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set([40, 40, 40], i * 3);
  ims.forEach((im, i) => {
    const x0 = (i % cols) * (w + 4), y0 = Math.floor(i / cols) * (h + 4);
    for (let y = 0; y < h; y++) rgb.set(im.rgb.subarray(y * w * 3, (y + 1) * w * 3), ((y0 + y) * W + x0) * 3);
  });
  writeFileSync(join(png, 'scenes.png'), encodePng({ width: W, height: H, rgb }));
}

export function checkOnly(sc0, L, segs, keys, png = null) {
  const [, frames] = play(sc0, L, BAS, keys);
  const w = sc0.dmp.width;
  for (const l of demoTour.tourLines(segs).slice(0, -1)) console.log(l);
  frames.forEach((f, k) => {
    const res = f.res;
    console.log(`${pad(k, 2)} ${f.key || '-'} pos ${pad(f.pos % w, 2)},${pad(Math.floor(f.pos / w), 2)} dir ${f.dir} VCL ${pad(res.vcllen, 3)} `
      + `VMS ${pad(res.vmslen, 4)} entries ${pad(res.x, 2)} objvis ${res.objvis.toString(2).padStart(3, '0')} A ${res.a}`
      + (f.mv ? ` MOVE X ${f.mv.x}` : ''));
  });
  const err = checkTour(sc0, segs, frames);
  for (const e of err) console.log('ERROR:', e);
  if (png) writePngs(frames, png);
  console.log(`${keys.length} keys, ${frames.length} frames, ${!err.length ? 'all equal to the model (paint_reference)' : err.length + ' errors'}`);
  return !err.length;
}

// ------------------------------------------------------------------ VICE

const w16 = (b, i) => b[i] | (b[i + 1] << 8);

/** One VICE run. Returns [rc, result]. At each prompt (GETIN, empty buffer, OBJN = 3): comparison with the model. */
export async function runOne(world, disk, bootPrg, port, tmo, segs, keys, { shots = null, tag = '', control = false } = {}) {
  const [sc0, L] = world;
  const w = sc0.dmp.width, h = sc0.dmp.height;
  const syms = vs.symbols(join(vs.VDC, 'build', 'vdcbasic3.sym'));
  const labels = vs.vdcLabels();
  const RTS = vs.stubRts();
  const res = { prompts: [], errors: [], ended: false };
  const run = new Run(sc0, L);
  const gs = new GoblinSim(BAS, w);
  const vramf = join(dirname(disk), `vram-${tag}.bin`);
  const send = [...keys, 'X'];
  const workAt = L.map.work;
  const segsX = new Map();
  let n = 0;
  for (const [k, , want] of segs) {
    n += k.length;
    if (want !== null) segsX.set(n, want);
  }

  async function script(m) {
    const ev = await m.mem(0x300, 2);
    const errAt = ev[0] | (ev[1] << 8);
    await m.bp(errAt);
    const bpGetin = await m.bp(GETIN);
    const bpChrin = await m.bp(CHRIN);
    await m.cmd(`disable ${bpChrin}`);
    const timing = { vd: 0x0D03, ve: RTS, ce: syms.vcl, cx: labels['.vcl_done'] };
    const tids = {};
    for (const [k, a] of Object.entries(timing)) tids[k] = await m.bp(a);
    const at = new Map(Object.entries(timing).map(([k, a]) => [a, k]));
    for (const id of Object.values(tids)) await m.cmd(`disable ${id}`);
    let irq = null;
    const state = { i: -1, objsPrev: null, final: false, t: { vd: [], ve: [], ce: 0, cx: 0 } };
    for (;;) {
      let pc;
      try {
        [pc] = await m.go();
      } catch (e) {
        if (e instanceof vs.Exited) return;
        throw e;
      }
      if (pc === errAt) {
        const [lo, hi] = await m.mem(0x3B, 2);
        res.errors.push([await m.regX(), lo | (hi << 8), state.i]);
        m.send('quit\n');
        return;
      }
      if (pc === CHRIN && state.final) {
        res.ended = true;
        m.send('quit\n');
        return;
      }
      if (at.has(pc)) {
        const k = at.get(pc);
        if (k === 'vd' || k === 've') state.t[k].push(await vs.stopwatch(m));
        else state.t[k] = await vs.stopwatch(m);
        continue;
      }
      if (pc !== GETIN) continue;
      await m.cmd('bank ram00');
      if ((await m.mem(0xD0))[0]) continue;              // key in the buffer: GETIN will fetch it right away
      if ((await m.mem(0x0C50))[0] !== NOBJ) continue;   // not the main program
      const i = state.i + 1;
      // --- cycles of this key
      const total = i > 0 ? await vs.stopwatch(m) : 0;
      const t = state.t;
      const cyc = {
        total, vcl: t.cx && t.ce ? t.cx - t.ce : 0,
        view: t.vd.length && t.ve.length ? t.ve[t.ve.length - 1] - t.vd[t.vd.length - 1] : 0,
        move: t.vd.length > 1 && t.ve.length > 1 ? t.ve[0] - t.vd[0] : 0,
      };
      // --- read state
      const pb = await m.mem(0x0C00, 0x20);
      const ob = await m.mem(0x0C50, 1 + 6 * 16);
      const buf = await m.mem(BUF[0], BUF[1] - BUF[0]);
      await m.cmd('bank ram01');
      const content = await m.mem(workAt + w * h, w * h);
      await m.cmd('bank vdc');
      if (existsSync(vramf)) rmSync(vramf);
      await m.cmd(`bsave "${vramf}" 0 0000 ffff`);
      await m.cmd('bank ram00');
      const vram = new Uint8Array(readFileSync(vramf));
      // --- model from the real state: object list, ITEMPH; position and direction from the keys (move.js)
      const real = Array.from({ length: ob[0] }, (_, j) => ob.slice(1 + 6 * j, 7 + 6 * j));
      let mv = null;
      if (i > 0) {
        mv = run.key(send[i - 1], objsFromBytes(state.objsPrev));
        gs.step(run.pos);
      }
      const fr = run.frame(objsFromBytes(real), pb[8]);
      const msg = [];
      if (i > 0 && mv !== null) {
        const want = segsX.get(i);
        if (want !== undefined && mv.x !== want) msg.push(`Tour: MOVE X ${mv.x}, expected ${want}`);
      }
      const rs = fr.res;
      if (rs.a !== 0) msg.push(`Modell: VIEW A = ${rs.a}`);
      if (JSON.stringify(real) !== JSON.stringify(gs.objects()) || pb[8] !== gs.itemph()) msg.push('object list/ITEMPH differ from the goblin model');
      const got = [0x0A, 0x0C, 0x0E, 0x10].map((j) => w16(pb, j));
      const wantPb = [rs.p0, rs.vcllen, rs.vmslen, rs.objvis];
      if (!eqBytes(got, wantPb)) {
        msg.push(`VCLADR/VCLLEN/VMSLEN/OBJVIS VICE [${got.map((x) => `'${hex(x)}'`).join(', ')}] <> [${wantPb.map((x) => `'${hex(x)}'`).join(', ')}]`);
      }
      const b0 = BUF[0];
      const jump = rs.jump();
      if (!eqBytes(buf.slice(rs.l0 - b0, rs.l0 - b0 + rs.vcl.length), rs.vcl) || !eqBytes(buf.slice(rs.m0 - b0, rs.m0 - b0 + rs.vms.length), rs.vms)
        || !eqBytes(buf.slice(0, jump.length), jump)) msg.push('buffer (VCL/VMS) differs from the reference');
      let model = fr.vram;
      if (control && i === 5) {
        model = model.slice();
        model[3 * 80 + 10] ^= 0x11;
      }
      if (!eqBytes(vram, model)) {
        let nb = 0, first = -1;
        for (let j = 0; j < 65536; j++) if (vram[j] !== model[j]) { nb++; if (first < 0) first = j; }
        const h2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
        msg.push(`VRAM ${nb} bytes wrong, first $${first.toString(16).toUpperCase().padStart(4, '0')}: VICE ${h2(vram[first])} <> model ${h2(model[first])}`);
      }
      const refOk = fr.ref === null || winEq(fr.sc, vram, fr.ref);
      if (!refOk) msg.push('window differs from paint_reference');
      if (!eqBytes(content, fr.content)) msg.push('content layer of the working copy (automap) differs from the model');
      res.prompts.push({
        i, key: i ? send[i - 1] : '', pos: fr.pos, dir: fr.dir, a: rs.a, nv: rs.vcllen, nm: rs.vmslen, vis: rs.objvis, mv,
        cyc, msg, ok: !msg.length, ref: refOk ? 'yes' : 'NO',
      });
      if (shots) {
        if (irq === null) {
          const v = await m.mem(0x314, 2);
          irq = await m.bp(v[0] | (v[1] << 8));
          await m.cmd(`disable ${irq}`);
        }
        await m.cmd(`disable ${bpGetin}`);
        await m.cmd(`enable ${irq}`);
        await m.go();
        await m.go();                                     // two interrupts: the frame is drawn
        await m.cmd(`disable ${irq}`);
        await m.cmd(`enable ${bpGetin}`);
        mkdirSync(shots, { recursive: true });
        await m.cmd(`screenshot "${join(shots, `${tag}_${String(i).padStart(2, '0')}.png`)}" 2`);
      }
      // --- next key
      state.objsPrev = real;
      state.i = i;
      if (i === 1 || i === 0) for (const id of Object.values(tids)) await m.cmd(`enable ${id}`);
      if (i >= send.length) return;
      const k = send[i];
      if (k === 'X') {
        state.final = true;
        await m.cmd(`enable ${bpChrin}`);
      }
      state.t = { vd: [], ve: [], ce: 0, cx: 0 };
      await m.cmd(`> 034a ${k.charCodeAt(0).toString(16).padStart(2, '0')}`);
      await m.cmd('> 00d0 01');
      await m.cmd('stopwatch reset');
    }
  }

  const args = ['-default', '-warp', '-sounddev', 'dummy', '-80col', '-VDC64KB', '-drive8type', disk.endsWith('.d81') ? '1581' : '1541',
    '+drive8truedrive', '-trapdevice8', '-8', disk, '-autostartprgmode', '1', '-autostart', bootPrg, '-limitcycles', '3000000000'];
  const [, rc] = await vs.runVice(args, port, tmo, script);
  return [rc, res];
}

export function report(name, res, segs, w = 20) {
  const labels = new Map();
  let n = 0;
  for (const [k, label] of segs) { n += k.length; labels.set(n, label); }
  console.log(`--- ${name}`);
  console.log(`${pad('#', 2)} ${padR('Key', 5)} ${padR('Position', 9)} ${pad('Dir', 5)} X ${pad('VCL', 4)} ${pad('VMS', 5)} ${pad('Gob', 3)} `
    + `${pad('Ref', 4)} ${pad('total', 9)} ${pad('VIEW', 8)} ${pad('MOVE', 7)} ${pad('VCL', 8)}  Step`);
  for (const p of res.prompts) {
    const c = p.cyc;
    console.log(`${pad(p.i, 2)} ${padR(p.key || '-', 5)} ${pad(`${p.pos % w},${Math.floor(p.pos / w)}`, 9)} ${pad('NESW'[p.dir], 5)} `
      + `${p.mv ? p.mv.x : '-'} ${pad(p.nv, 4)} ${pad(p.nm, 5)} ${pad(p.vis.toString(2).split('1').length - 1, 3)} ${pad(p.ref, 4)} `
      + `${pad(c.total, 9)} ${pad(c.view, 8)} ${pad(c.move, 7)} ${pad(c.vcl, 8)}  ${labels.get(p.i) || ''}` + (p.ok ? '' : '  <<< ERROR'));
    for (const m of p.msg) console.log('       ' + m);
  }
  const ps = res.prompts.filter((p) => p.i > 0);
  if (ps.length) {
    for (const [key, lab] of [['total', 'total (key to prompt)'], ['view', 'VIEW'], ['move', 'MOVE'], ['vcl', 'VCL']]) {
      const v = ps.map((p) => p.cyc[key]).filter((x) => x);
      if (v.length) {
        console.log(`    ${padR(lab, 26)} mean ${pad(Math.floor(v.reduce((a, b) => a + b, 0) / v.length), 9)}  min ${pad(Math.min(...v), 9)}  `
          + `max ${pad(Math.max(...v), 9)}  (${v.length} frames)`);
      }
    }
  }
  const bad = res.prompts.filter((p) => !p.ok).length;
  const errs = '[' + res.errors.map((e) => `(${e.join(', ')})`).join(', ') + ']';
  console.log(`    ${res.prompts.length} Prompts, ${!bad ? 'all equal to the model' : bad + ' errors'}, BASIC error ${errs}, `
    + `end (direct mode after X) ${res.ended ? 'yes' : 'NO'}`);
  return bad;
}

function parseArgs(argv) {
  const a = { port: null, timeout: 900, only: null, check: false, png: null, shots: null, control: false, fast: true, build: true, d81: false, budget: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`argument ${x}: expected one argument`); return argv[++i]; };
    if (x === '--port') a.port = parseInt(val(), 10);
    else if (x === '--timeout') a.timeout = parseInt(val(), 10);
    else if (x === '--only') {
      a.only = val();
      if (!['i', 'c'].includes(a.only)) throw new Error(`argument --only: invalid choice: '${a.only}' (choose from 'i', 'c')`);
    } else if (x === '--check') a.check = true;
    else if (x === '--png') a.png = val();
    else if (x === '--shots') a.shots = val();
    else if (x === '--control') a.control = true;
    else if (x === '--no-fast') a.fast = false;
    else if (x === '--no-build') a.build = false;
    else if (x === '--d81') a.d81 = true;
    else if (x === '--budget') a.budget = i + 1 < argv.length && /^\d+$/.test(argv[i + 1]) ? parseInt(argv[++i], 10) : 30;
    else throw new Error(`unrecognized arguments: ${x}`);
  }
  return a;
}

export async function main(argv) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(`vice_demo.js: error: ${e.message}`);
    return 2;
  }
  try {
    if (a.build) demoBuild.build({ out: OUT, disk: false, budgetStep: a.budget, quiet: true });
  } catch (e) {
    if (e instanceof demoBuild.BuildError) { console.error(e.message); return 1; }
    throw e;
  }
  const world = demoBuild.loadWorld(OUT);
  const [sc0, L] = world;
  const [segs, keys] = tourKeys(sc0);
  if (a.check || a.png) return checkOnly(sc0, L, segs, keys, a.png) ? 0 : 1;
  // model pre-check of the tour (fast), then VICE
  const [, frames] = play(sc0, L, BAS, keys);
  const err = checkTour(sc0, segs, frames);
  if (err.length) {
    console.log(err.map((e) => 'ERROR: ' + e).join('\n'));
    return 1;
  }
  const files = {};
  for (const nm of readdirSync(join(OUT, 'files'))) files[nm] = join(OUT, 'files', nm);
  const boot = demoBuild.bootPrg(OUT);
  const port = await vs.choosePort(a.port);
  let bad = 0;
  const node = vs.findNode(), blitzc = vs.findBlitzc();
  for (const compiled of [false, true]) {
    if ((a.only === 'c' && !compiled) || (a.only === 'i' && compiled)) continue;
    if (compiled && (!node || !blitzc)) {
      console.log('compiled: SKIP (blitzc not found)');
      bad |= 2;
      continue;
    }
    for (const fs of (a.fast ? [0, 1] : [0])) {
      const tag = (compiled ? 'c' : 'i') + (fs ? '2' : '1');
      const prog = demoBuild.program(OUT, { compiled, fs, tag: `-${tag}` });
      const disk = join(OUT, a.d81 ? `run-${tag}.d81` : `run-${tag}.d64`);
      demoBuild.makeDisk(disk, files, prog, boot);
      const [, res] = await runOne(world, disk, boot, port, a.timeout, segs, keys, { shots: a.shots, tag, control: a.control });
      const name = (compiled ? 'compiled (Blitz!, image 2)' : 'interpreted') + (fs ? ', 2 MHz (FAST)' : ', 1 MHz');
      const nb = report(name, res, segs, sc0.dmp.width);
      if (nb !== (a.control ? 1 : 0) || res.errors.length || !res.ended || res.prompts.length !== keys.length + 1) bad |= 1;
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; });
}
