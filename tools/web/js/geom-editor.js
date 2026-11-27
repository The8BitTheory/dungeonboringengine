// Geometry editor (docs/specs/P8-js-tools.md 6.2): view.toml form, live preview of planes, elements, masks, bands,
// atlas template and budget; save (keeps comments), build (DVG, JSON, budget, Aseprite, PNG templates).
import * as G from '../../js/core/geom.js';
import { parseToml } from '../../js/core/io/toml.js';
import { setTomlValue } from '../../js/core/io/tomledit.js';
import { rangeError } from '../../js/core/mem.js';
import { el, imageCanvas, messages } from './ui.js';
import { dirname, join } from './fs.js';

const VP = [
  ['preset', 'select', ['westwood', 'custom']],
  ['width_px', 'int', 'multiple of 4, 16 … 160'],
  ['height', 'int', '8 … 100'],
  ['origin', 'int', 'byte offset in the attribute buffer'],
  ['stride', 'int', '≥ width_px / 2, ≤ 255'],
  ['depth', 'int', 'Westwood: 3'],
  ['byte_edges', 'bool', 'edges on whole bytes'],
];
const OUT = [
  ['name', 'str'], ['dir', 'str', 'relative to the TOML'], ['load', 'hex', 'bank 1'], ['pool_bytes', 'int'], ['zoom', 'int', 'PNG templates'],
];
const PL = [['ref_size', 'list'], ['center_x', 'num'], ['width', 'list'], ['top', 'list'], ['bottom', 'list']];

const hex = (v) => `0x${v.toString(16).toUpperCase()}`;

export class GeomEditor {
  constructor(root, status) {
    this.root = root;
    this.status = status;
    this.root.replaceChildren(el('p', { class: 'muted' }, 'Open a geometry file (dbegeom TOML, e.g. demo/view.toml).'));
  }

  setProject(project) { this.project = project; }

  async open(path) {
    this.path = path;
    this.text = await this.project.readText(path);
    this.dirty = false;
    this.render();
    this.status(`${path} opened`);
  }

  cfg() { return parseToml(this.text); }

  field(section, [key, type, hint]) {
    const cfg = this.cfg()[section] || {};
    const v = cfg[key];
    const set = (val) => {
      this.text = setTomlValue(this.text, section, key, val);
      this.dirty = true;
      this.update();
    };
    let inp;
    if (type === 'select') {
      inp = el('select', { onchange: (e) => { set(e.target.value); this.render(); } },
        hint.map((o) => el('option', { value: o, selected: (v ?? 'westwood') === o }, o)));
      hint = '';
    } else if (type === 'bool') {
      inp = el('input', { type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked || null) });
    } else if (type === 'list') {
      inp = el('input', { value: Array.isArray(v) ? v.join(', ') : '', size: 24, onchange: (e) => {
        const a = e.target.value.split(/[,\s]+/).filter(Boolean).map(Number);
        set(a.length ? a : null);
      } });
    } else {
      const shown = v === undefined ? '' : type === 'hex' ? hex(v) : String(v);
      inp = el('input', { value: shown, size: type === 'str' ? 16 : 8, onchange: (e) => {
        const t = e.target.value.trim();
        if (!t) return set(null);
        if (type === 'str') return set(t);
        const n = /^(0x|\$)/i.test(t) ? parseInt(t.replace('$', '0x'), 16) : Number(t);
        if (Number.isNaN(n)) { this.status(`${key}: not a number`, true); return undefined; }
        return set(n);
      } });
    }
    return el('tr', {}, el('td', {}, key), el('td', {}, inp), el('td', { class: 'muted' }, hint || ''));
  }

  render() {
    const custom = (this.cfg().viewport || {}).preset === 'custom';
    const form = el('div', { class: 'card' },
      el('h3', {}, 'Viewport'), el('table', { class: 'form' }, VP.map((f) => this.field('viewport', f))),
      custom ? [el('h3', {}, 'Planes (custom)'), el('table', { class: 'form' }, PL.map((f) => this.field('planes', f)))] : null,
      el('h3', {}, 'Output'), el('table', { class: 'form' }, OUT.map((f) => this.field('output', f))),
      el('div', { class: 'toolbar', style: 'margin-top:10px' },
        el('button', { onclick: () => this.save() }, 'Save TOML'),
        el('button', { class: 'btn primary', onclick: () => this.build() }, 'Build')));
    this.out = el('div', { class: 'row', style: 'flex-direction:column' });
    this.root.replaceChildren(el('div', { class: 'row' }, form, this.out));
    this.update();
  }

  update() {
    let conf, geo;
    try {
      conf = G.parseConfig(this.cfg());
      geo = new G.Geometry(conf);
      geo.atlasSize = G.layoutAtlas(geo);
    } catch (e) {
      this.out.replaceChildren(messages([['err', e.message]]));
      return;
    }
    const view = G.renderView(geo, 2);
    const atlas = G.renderAtlas(geo, geo.atlasSize);
    const bud = G.computeBudget(geo);
    const errs = [];
    try {
      const { content } = G.buildDvg(geo);
      const r = rangeError('dvg', conf.load, content.length);
      if (r) errs.push(['err', r]);
      errs.push(['info', `DVG ${content.length} bytes, ${geo.elements.length} elements, atlas ${geo.atlasSize.join(' × ')}`]);
    } catch (e) { errs.push(['err', e.message]); }
    this.out.replaceChildren(
      el('div', { class: 'card' }, el('h3', {}, 'View window'), imageCanvas(view, 1.5, 0.9, 'view geometry'), messages(errs),
        el('details', {}, el('summary', {}, `${geo.elements.length} elements (check lines)`),
          messages(G.checkLines(geo).map((l) => ['info', l])))),
      el('div', { class: 'card' }, el('h3', {}, 'Atlas template'), imageCanvas(atlas, 1, 1, 'atlas template')),
      el('div', { class: 'card' }, el('h3', {}, 'Budget'), el('pre', { class: 'msgs' }, G.budgetMarkdown(geo, bud))));
  }

  async save() {
    await this.project.write(this.path, this.text);
    this.dirty = false;
    this.status(`${this.path} saved`);
  }

  async build() {
    try {
      const conf = G.parseConfig(this.cfg());
      const { files } = G.generate(conf);
      const dir = join(dirname(this.path), conf.dir);
      for (const [n, data] of Object.entries(files)) await this.project.write(join(dir, n), data);
      this.status(`${Object.keys(files).length} files written to ${dir}`);
    } catch (e) { this.status(e.message, true); }
  }
}
