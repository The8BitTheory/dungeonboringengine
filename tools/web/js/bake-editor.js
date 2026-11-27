// Bake/pack view (docs/specs/P8-js-tools.md 6.5): visibility problems on the map, baked animation patches,
// zone layout (bank 1, VRAM pool, RXV load time).
import * as B from '../../js/core/bake.js';
import * as M from '../../js/core/map.js';
import { fbToImage } from '../../js/core/tex.js';
import { el, imageCanvas, messages } from './ui.js';
import { join } from './fs.js';
import { withFiles } from './resolve.js';

const CELL = 18;
const DIRS = 'NESW';
const FD = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const COLORS = ['#4f7cc9', '#c9784f', '#5aa469', '#b65fb8', '#c9b24f', '#4fb6c9', '#999', '#c94f6d'];

export class BakeEditor {
  constructor(root, status) {
    this.root = root;
    this.status = status;
    this.cache = new Map();
    this.sel = null;
    root.replaceChildren(el('p', { class: 'muted' }, 'Open a bake project (dbebake TOML, e.g. demo/bake.toml or demo/bake-gate.toml).'));
  }

  setProject(project) { this.project = project; }

  async open(path) {
    this.path = path;
    this.text = await this.project.readText(path);
    this.cache = new Map();
    this.sel = null;
    await this.rebuild();
  }

  async rebuild() {
    this.status('baking…');
    await new Promise((r) => setTimeout(r, 0));             // let the status paint before the long run
    const t0 = performance.now();
    try {
      this.res = await withFiles(this.project, (resolve) => B.buildBake(this.text, { path: this.path, resolve }), this.cache);
      this.err = null;
      this.status(`${this.path}: baked in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { this.res = null; this.err = e.message; this.status(e.message, true); }
    this.render();
  }

  render() {
    if (!this.res) { this.root.replaceChildren(messages([['err', this.err]])); return; }
    const r = this.res, m = r.scene.dmp;
    this.grid = el('canvas', { width: m.width * CELL, height: m.height * CELL, 'aria-label': 'map with visibility problems' });
    const probs = r.check.problems;
    const list = el('div', { class: 'palette', style: 'max-height:32vh' }, probs.length ? probs.map((p, i) => el('button', {
      'aria-pressed': String(this.sel === i), onclick: () => { this.sel = this.sel === i ? null : i; this.render(); },
    }, `style ${p.style} (${p.cell % m.width}, ${Math.floor(p.cell / m.width)}) ${DIRS[p.face]}: ${p.slots.length} slot(s)`))
      : el('span', { class: 'muted' }, 'no problems: every visible face has an image of its own'));
    const detail = this.sel !== null && probs[this.sel] ? el('div', { class: 'msgs' }, probs[this.sel].slots.map((s) =>
      el('div', { class: 'warn' }, `${s.slot}: ${s.res === 'fallback' ? 'shows style 1' : 'shows nothing'}, from `
        + s.from.map((f) => `(${f.pos % m.width}, ${Math.floor(f.pos / m.width)}) ${DIRS[f.dir]}`).join(' ')))) : null;
    const left = el('div', {},
      el('div', { class: 'toolbar' }, el('button', { onclick: () => this.rebuild() }, 'Rebake'),
        el('button', { class: 'btn primary', onclick: () => this.build() }, 'Build')),
      el('div', { class: 'card' }, el('h3', {}, 'Visibility'),
        el('div', { class: 'muted' }, `${r.report.viewpoints} viewpoints, ${r.report.faces_seen} visible wall faces`),
        el('div', { class: 'grid-wrap' }, this.grid), el('h3', {}, `Problems (${probs.length})`), list, detail));
    const right = el('div', { class: 'row', style: 'flex-direction:column' },
      this.animsCard(r, m), this.layoutCard(r),
      r.errors.length ? el('div', { class: 'card' }, el('h3', {}, 'Errors'), messages(r.errors.map((e) => ['err', e]))) : null);
    this.root.replaceChildren(el('div', { class: 'row' }, left, right));
    this.drawGrid();
  }

  animsCard(r, m) {
    const card = el('div', { class: 'card' }, el('h3', {}, 'Animations (baked patches: opaque, with background and occluders)'));
    if (!r.baked.length) { card.append(el('p', { class: 'muted' }, 'none in this project')); return card; }
    const at = (c) => `(${c % m.width}, ${Math.floor(c / m.width)})`;
    for (const a of r.baked) {
      card.append(el('div', {}, el('strong', {}, a.name),
        ` at ${at(a.cell)} ${DIRS[a.face]}, frames ${a.frames.join(' → ')}, ${a.views.length} viewpoint(s)`));
      for (const v of a.views) {
        const figs = v.frames.map((f, i) => el('figure', { style: 'margin:0' },
          imageCanvas(fbToImage(f, v.rect.w, v.rect.h, v.rect.w, 0, 1), 2, 2.4, `frame ${i}`),
          el('figcaption', { class: 'muted' }, `frame ${i} (style ${a.frames[i]})`)));
        card.append(el('div', { style: 'margin:6px 0' },
          el('div', { class: 'muted' }, `from ${at(v.pos)} ${DIRS[v.dir]}${v.slot ? ` · ${v.slot}` : ''} · rect ${v.rect.x}, ${v.rect.y}, `
            + `${v.rect.w} × ${v.rect.h} bytes · ${v.rect.w * v.rect.h * a.frames.length} bytes VRAM`),
          el('div', { class: 'row' }, figs)));
      }
    }
    card.append(el('p', { class: 'muted' }, 'The runtime copies a patch with one block copy per row (case R1).'));
    return card;
  }

  layoutCard(r) {
    const L = r.report.layout;
    const pool = L.pool || [0, L.pool_end];
    const span = Math.max(pool[1], L.pool_end) - pool[0];
    const bar = el('div', { style: 'display:flex;height:22px;border:1px solid var(--line);border-radius:4px;overflow:hidden;width:520px;max-width:100%' },
      L.vram.map((v, i) => el('div', { title: `${v.name}: ${v.len} bytes at ${v.base}`,
        style: `width:${(100 * v.len) / span}%;background:${COLORS[i % COLORS.length]}` })));
    const over = L.pool && L.pool_end > L.pool[1];
    return el('div', { class: 'card' }, el('h3', {}, 'Zone layout'),
      bar, el('div', { class: over ? 'msgs' : 'muted' }, el('span', { class: over ? 'err' : '' },
        `VRAM ${L.pool_end - pool[0]} bytes used${L.pool ? ` of ${L.pool[1] - L.pool[0]}` : ''}`)),
      el('table', { class: 'form msgs' }, L.vram.map((v, i) => el('tr', {},
        el('td', {}, el('span', { class: 'swatch', style: `display:inline-block;background:${COLORS[i % COLORS.length]}` })),
        el('td', {}, v.name), el('td', {}, `base ${v.base}`), el('td', {}, `${v.len} bytes`), el('td', {}, `${(v.us / 1000).toFixed(1)} ms`)))),
      el('div', {}, `Loading the zone with RXV: about ${L.load_ms} ms (${L.rxv_us_per_byte} µs per byte).`),
      el('h3', {}, 'Bank 1'),
      el('table', { class: 'form msgs' }, L.bank1.map((b) => el('tr', {}, el('td', {}, b.name),
        el('td', {}, `$${b.load.toString(16).toUpperCase().padStart(4, '0')}`), el('td', {}, `${b.len} bytes`)))));
  }

  drawGrid() {
    const r = this.res, m = r.scene.dmp, g = this.grid.getContext('2d');
    for (let c = 0; c < m.cells.length; c++) {
      const t = m.tiles[m.cells[c]];
      g.fillStyle = t.flags & M.FLAGS.solid ? '#5a4a4a' : t.floor ? '#d8c99a' : '#b9d8a0';
      g.fillRect((c % m.width) * CELL, Math.floor(c / m.width) * CELL, CELL - 1, CELL - 1);
    }
    const edge = (c, face, color, w = 3) => {
      const x = (c % m.width) * CELL, y = Math.floor(c / m.width) * CELL;
      g.fillStyle = color;
      if (face === 0) g.fillRect(x, y, CELL - 1, w);
      else if (face === 2) g.fillRect(x, y + CELL - 1 - w, CELL - 1, w);
      else if (face === 1) g.fillRect(x + CELL - 1 - w, y, w, CELL - 1);
      else g.fillRect(x, y, w, CELL - 1);
    };
    r.check.problems.forEach((p, i) => edge(p.cell, p.face, i === this.sel ? '#ff2d2d' : '#e08a00', i === this.sel ? 4 : 3));
    for (const a of r.baked) edge(a.cell, a.face, '#2f6fd6', 4);
    if (this.sel !== null && r.check.problems[this.sel]) {
      g.strokeStyle = '#ff2d2d';
      g.lineWidth = 2;
      for (const s of r.check.problems[this.sel].slots) {
        for (const f of s.from) {
          const x = (f.pos % m.width) * CELL + CELL / 2, y = Math.floor(f.pos / m.width) * CELL + CELL / 2;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + FD[f.dir][0] * 7, y + FD[f.dir][1] * 7); g.stroke();
          g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.stroke();
        }
      }
    }
  }

  async build() {
    if (!this.res) return;
    const dir = join('', this.res.conf.out);
    for (const [n, d] of Object.entries(this.res.files)) await this.project.write(join(dir, n), d);
    this.status(`${Object.keys(this.res.files).length} files written to ${dir}`);
  }
}
