// Map editor (docs/specs/P8-js-tools.md 6.1): paint tiles, items, events, start; tile table; live VIEW.
import * as M from '../../js/core/map.js';
import { Preview } from './preview.js';
import { el } from './ui.js';

const CELL = 18;
const DIRS = ['N', 'E', 'S', 'W'];
const EVENT_NAMES = Object.fromEntries(Object.entries(M.EVENT_TYPES).map(([k, v]) => [v, k]));
const FLAG_NAMES = Object.keys(M.FLAGS);

// stable colour per tile index (only for the editor grid)
function tileColor(t, i) {
  if (t.flags & M.FLAGS.solid) return `hsl(${(i * 47) % 360} 25% 38%)`;
  if (!t.floor) return `hsl(${(i * 47) % 360} 60% 80%)`;
  return `hsl(${(i * 47) % 360} 45% 68%)`;
}

export class MapEditor {
  constructor(root, status) {
    this.root = root;
    this.status = status;
    this.map = null;
    this.path = null;
    this.legend = null;
    this.tool = 'tile';
    this.tile = 0;
    this.item = 1;
    this.event = { type: 1, param: 0 };
    this.pos = 0;
    this.dir = 0;
    this.dirty = false;
    this.preview = new Preview(status);
    this.renderEmpty();
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  setProject(project, files) {
    this.project = project;
    this.files = files;
    this.preview.setProject(project, files);
    if (!this.map) this.renderEmpty();
  }

  renderEmpty() {
    this.root.replaceChildren(el('p', { class: 'muted' },
      'Open a map (dbemap TOML) or a scene (dbeview TOML) from the file list. The live view needs built assets: ',
      'a scene file names them (DVG, DTS, DBG, S2).'));
  }

  async openMap(path) {
    const text = await this.project.readText(path);
    this.map = M.loadsToml(text, path);
    this.path = path;
    this.legend = M.legendFromToml(text, this.map);
    this.pos = this.map.start;
    this.dir = this.map.direction;
    this.dirty = false;
    await this.preview.attachMap(this.map, path);
    this.render();
    this.status(`${path}: ${this.map.width} × ${this.map.height}, ${this.map.tiles.length} tiles`);
  }

  async openScene(path) {
    const sc = await this.preview.loadScene(path);
    const mp = sc.mapPath;
    if (mp && mp.endsWith('.toml')) {
      await this.openMap(mp);
      this.pos = sc.scene.pos;
      this.dir = sc.scene.dir;
      this.preview.update(this.map, this.pos, this.dir);
      this.render();
    } else {
      this.map = sc.scene.map;
      this.path = null;
      this.pos = sc.scene.pos;
      this.dir = sc.scene.dir;
      this.render();
    }
  }

  // ------------------------------------------------------------ UI
  render() {
    const m = this.map;
    this.gridCanvas = el('canvas', { width: m.width * CELL, height: m.height * CELL, tabindex: 0,
      'aria-label': 'map grid' });
    this.gridCanvas.onpointerdown = (e) => { this.painting = true; this.paintAt(e); };
    this.gridCanvas.onpointermove = (e) => { if (this.painting) this.paintAt(e); this.hover(e); };
    window.onpointerup = () => { this.painting = false; };
    const tools = [['tile', 'Tile'], ['item', 'Item'], ['event', 'Event'], ['start', 'Start'], ['view', 'Viewpoint'],
      ['mark', 'Mark']];
    this.toolbar = el('div', { class: 'toolbar' },
      tools.map(([k, label]) => el('button', { 'aria-pressed': String(this.tool === k), onclick: () => { this.tool = k; this.render(); } }, label)),
      el('span', { class: 'sep' }),
      el('button', { onclick: () => this.save(), disabled: !this.path }, 'Save TOML'),
      el('button', { onclick: () => this.buildDmp(), disabled: !this.path }, 'Build DMP'),
      el('span', { class: 'sep' }),
      el('span', { class: 'muted' }, 'View: ', el('span', { class: 'kbd' }, 'W A S D'), ' move, ',
        el('span', { class: 'kbd' }, 'Q E'), ' turn'));
    this.info = el('div', { class: 'muted' });
    this.msgs = el('div', { class: 'msgs' });
    const left = el('div', {}, this.toolbar, el('div', { class: 'grid-wrap' }, this.gridCanvas), this.info, this.msgs);
    const right = el('div', { class: 'row', style: 'flex-direction:column' },
      el('div', { class: 'card' }, el('h3', {}, 'Live view'), this.preview.element()),
      el('div', { class: 'card' }, this.renderToolPanel()));
    this.root.replaceChildren(el('div', { class: 'row' }, left, right));
    this.drawGrid();
    this.check();
  }

  renderToolPanel() {
    const m = this.map;
    if (this.tool === 'tile') {
      const pal = el('div', { class: 'palette' }, m.tiles.map((t, i) => el('button', {
        'aria-pressed': String(i === this.tile), onclick: () => { this.tile = i; this.render(); },
      }, el('span', { class: 'swatch', style: `background:${tileColor(t, i)}` }), `${i} ${t.name || ''}`)),
      el('button', { onclick: () => this.addTile() }, '+ new tile'));
      return el('div', {}, el('h3', {}, 'Tiles'), pal, this.renderTileForm(m.tiles[this.tile], this.tile));
    }
    if (this.tool === 'item') {
      return el('div', {}, el('h3', {}, 'Item'), el('label', {}, 'number (0 removes) ',
        el('input', { type: 'number', min: 0, max: 63, value: this.item, oninput: (e) => { this.item = +e.target.value; } })));
    }
    if (this.tool === 'event') {
      const sel = el('select', { onchange: (e) => { this.event.type = +e.target.value; } },
        Object.entries(M.EVENT_TYPES).map(([k, v]) => el('option', { value: v, selected: v === this.event.type }, k)));
      return el('div', {}, el('h3', {}, 'Event'), sel, ' param ',
        el('input', { type: 'number', min: 0, max: 255, value: this.event.param, oninput: (e) => { this.event.param = +e.target.value; } }),
        el('p', { class: 'muted' }, 'Click adds, shift+click removes the events of the cell.'));
    }
    if (this.tool === 'mark') return el('p', { class: 'muted' }, 'Click toggles the automap mark (bit 7).');
    if (this.tool === 'start') return el('p', { class: 'muted' }, 'Click sets the start; click again turns it.');
    return el('p', { class: 'muted' }, 'Click sets the viewpoint of the live view; click again turns it.');
  }

  renderTileForm(t, idx) {
    if (!t) return null;
    const num = (val, max, set) => el('input', { type: 'number', min: 0, max, value: val,
      oninput: (e) => { set(Math.max(0, Math.min(max, +e.target.value || 0))); this.changed(); } });
    const rows = [
      ['name', el('input', { value: t.name || '', oninput: (e) => { t.name = e.target.value; this.changed(false); } })],
      ...DIRS.map((d, k) => [`wall ${d}`, num(t.walls[k], 255, (v) => { t.walls[k] = v; })]),
      ['floor', num(t.floor, 255, (v) => { t.floor = v; })],
      ['ceiling', num(t.ceiling, 255, (v) => { t.ceiling = v; })],
      ['automap char', num(t.automapChar, 255, (v) => { t.automapChar = v; })],
    ];
    const flags = el('div', {}, FLAG_NAMES.map((f) => el('label', { style: 'display:block' },
      el('input', { type: 'checkbox', checked: !!(t.flags & M.FLAGS[f]), onchange: (e) => {
        t.flags = e.target.checked ? t.flags | M.FLAGS[f] : t.flags & ~M.FLAGS[f];
        this.changed();
      } }), ` ${f}`)));
    return el('div', {}, el('h3', {}, `Tile ${idx}`),
      el('table', { class: 'form' }, rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v)))), flags);
  }

  addTile() {
    const t = M.nullTile();
    t.name = `tile${this.map.tiles.length}`;
    this.map.tiles.push(t);
    this.tile = this.map.tiles.length - 1;
    this.changed();
    this.render();
  }

  cellAt(e) {
    const r = this.gridCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / CELL), y = Math.floor((e.clientY - r.top) / CELL);
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return -1;
    return y * this.map.width + x;
  }

  hover(e) {
    const c = this.cellAt(e);
    if (c < 0) return;
    const m = this.map, t = m.tiles[m.cells[c]];
    const ev = m.events.filter((v) => v.cell === c).map((v) => `${EVENT_NAMES[v.type] || v.type}(${v.param})`);
    const item = m.content[c] & 63;
    this.info.textContent = `(${c % m.width}, ${Math.floor(c / m.width)}) tile ${m.cells[c]} ${t.name || ''}`
      + (item ? `, item ${item}` : '') + (ev.length ? `, events ${ev.join(' ')}` : '');
  }

  paintAt(e) {
    const c = this.cellAt(e);
    if (c < 0) return;
    const m = this.map;
    const first = e.type === 'pointerdown';
    switch (this.tool) {
      case 'tile': if (m.cells[c] === this.tile) return; m.cells[c] = this.tile; break;
      case 'item': m.content[c] = (m.content[c] & 0xC0) | (this.item & 63); break;
      case 'mark': if (!first) return; m.content[c] ^= 0x80; break;
      case 'event':
        if (!first) return;
        if (e.shiftKey) m.events = m.events.filter((v) => v.cell !== c);
        else m.events.push(new M.Event(c, this.event.type, this.event.param));
        m.events = M.sortEvents(m.events);
        break;
      case 'start':
        if (!first) return;
        if (m.start === c) m.direction = (m.direction + 1) & 3; else m.start = c;
        break;
      case 'view':
        if (!first) return;
        if (this.pos === c) this.dir = (this.dir + 1) & 3; else this.pos = c;
        this.preview.update(m, this.pos, this.dir);
        this.drawGrid();
        return;
      default: return;
    }
    this.changed();
  }

  changed(redraw = true) {
    this.dirty = true;
    if (redraw) {
      this.drawGrid();
      this.preview.update(this.map, this.pos, this.dir);
      this.check();
    }
  }

  onKey(e) {
    if (!this.map || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const act = { w: 0, s: 1, a: 2, d: 3, q: 4, e: 5, ArrowUp: 0, ArrowDown: 1, ArrowLeft: 4, ArrowRight: 5 }[e.key];
    if (act === undefined) return;
    e.preventDefault();
    const r = this.preview.move(this.map, this.pos, this.dir, act);
    this.pos = r.pos;
    this.dir = r.dir;
    this.preview.update(this.map, this.pos, this.dir);
    this.drawGrid();
  }

  drawGrid() {
    const m = this.map, g = this.gridCanvas.getContext('2d');
    g.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let c = 0; c < m.cells.length; c++) {
      const x = (c % m.width) * CELL, y = Math.floor(c / m.width) * CELL, t = m.tiles[m.cells[c]];
      g.fillStyle = t ? tileColor(t, m.cells[c]) : '#f0f';
      g.fillRect(x, y, CELL - 1, CELL - 1);
      const item = m.content[c] & 63;
      if (item) { g.fillStyle = '#000'; g.fillText(String(item), x + CELL / 2, y + CELL / 2); }
      if (m.content[c] & 0x80) { g.strokeStyle = '#fff'; g.strokeRect(x + 2.5, y + 2.5, CELL - 6, CELL - 6); }
    }
    g.fillStyle = '#c00';
    for (const v of m.events) {
      const x = (v.cell % m.width) * CELL, y = Math.floor(v.cell / m.width) * CELL;
      g.fillRect(x + CELL - 6, y + 1, 4, 4);
    }
    const arrow = (c, d, color) => {
      const x = (c % m.width) * CELL + CELL / 2, y = Math.floor(c / m.width) * CELL + CELL / 2;
      const [fx, fy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][d];
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x - fx * 6, y - fy * 6); g.lineTo(x + fx * 6, y + fy * 6); g.stroke();
      g.beginPath(); g.arc(x + fx * 6, y + fy * 6, 2.5, 0, 7); g.fill();
      g.lineWidth = 1;
    };
    arrow(m.start, m.direction, '#0a0');
    arrow(this.pos, this.dir, '#ffd54a');
  }

  check() {
    const out = [];
    try { M.validate(this.map); } catch (e) { out.push(['err', e.message]); }
    try { for (const w of M.warningsFor(this.map)) out.push(['warn', w]); } catch { /* optional */ }
    this.msgs.replaceChildren(...out.map(([k, t]) => el('div', { class: k }, t)));
    return !out.some(([k]) => k === 'err');
  }

  async save() {
    if (!this.check()) { this.status('the map has errors, not saved', true); return; }
    await this.project.write(this.path, M.toTomlNamed(this.map, this.legend));
    this.dirty = false;
    this.status(`${this.path} saved`);
  }

  async buildDmp() {
    if (!this.check()) { this.status('the map has errors', true); return; }
    const out = this.path.replace(/\.toml$/, '.dmp');
    await this.project.write(out, M.toDmp(this.map));
    this.status(`${out} written`);
  }
}

