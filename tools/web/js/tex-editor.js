// Texture editor (docs/specs/P8-js-tools.md 6.3): dbetex project, styles, previews, slot table, budget.
import * as T from '../../js/core/tex.js';
import { encodePng } from '../../js/core/io/png.js';
import { parseToml } from '../../js/core/io/toml.js';
import { setTomlValue } from '../../js/core/io/tomledit.js';
import { el, imageCanvas, messages } from './ui.js';
import { join } from './fs.js';
import { withFiles } from './resolve.js';

const FIELDS = [
  ['name', 'str'], ['kind', 'select', ['wall', 'floor', 'ceiling']], ['geom', 'str'], ['dvg', 'str'], ['out', 'str'],
  ['load', 'hex'], ['vrl_load', 'hex'], ['pool_bytes', 'int'], ['max_cores', 'int', '0 … 4'], ['core_min', 'int'],
  ['fill_rows', 'bool'], ['key', 'str', 'RRGGBB transparent'], ['alpha_threshold', 'int'],
];
const hex = (v) => `0x${v.toString(16).toUpperCase()}`;

export function fieldRow(get, set, [key, type, hint], onDone) {
  const v = get(key);
  let inp;
  const done = (val) => { set(key, val); onDone(); };
  if (type === 'select') {
    inp = el('select', { onchange: (e) => done(e.target.value) }, hint.map((o) => el('option', { value: o, selected: v === o }, o)));
    hint = '';
  } else if (type === 'bool') {
    inp = el('input', { type: 'checkbox', checked: !!v, onchange: (e) => done(e.target.checked) });
  } else {
    inp = el('input', { value: v === undefined ? '' : type === 'hex' ? hex(v) : String(v), size: type === 'str' ? 28 : 8,
      onchange: (e) => {
        const t = e.target.value.trim();
        if (!t) return done(null);
        if (type === 'str') return done(t);
        const n = /^(0x|\$)/i.test(t) ? parseInt(t.replace('$', '0x'), 16) : Number(t);
        return Number.isNaN(n) ? undefined : done(n);
      } });
  }
  return el('tr', {}, el('td', {}, key), el('td', {}, inp), el('td', { class: 'muted' }, hint || ''));
}

export class TexEditor {
  constructor(root, status) {
    this.root = root;
    this.status = status;
    this.cache = new Map();
    root.replaceChildren(el('p', { class: 'muted' }, 'Open a texture project (dbetex TOML, e.g. demo/walls.toml).'));
  }

  setProject(project) { this.project = project; }

  async open(path) {
    this.path = path;
    this.text = await this.project.readText(path);
    this.cache = new Map();
    await this.rebuild();
  }

  async reload() { this.cache = new Map(); await this.rebuild(); this.status('reloaded from disk'); }

  async rebuild() {
    const t0 = performance.now();
    try {
      this.res = await withFiles(this.project, (resolve) => T.buildTex(this.text, { path: this.path, resolve }), this.cache);
      this.err = null;
      this.status(`${this.path}: built in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { this.res = null; this.err = e.message; this.status(e.message, true); }
    this.render();
  }

  render() {
    const cfg = parseToml(this.text);
    const ts = cfg.texset || {};
    const form = el('div', { class: 'card' }, el('h3', {}, 'Texture set'),
      el('table', { class: 'form' }, FIELDS.map((f) => fieldRow((k) => ts[k], (k, v) => {
        this.text = setTomlValue(this.text, 'texset', k, v === false ? null : v);
      }, f, () => this.rebuild()))),
      el('h3', {}, 'Styles'),
      el('table', { class: 'form' }, (cfg.style || []).map((s, i) => el('tr', {}, el('td', {}, `${i + 1}`),
        el('td', {}, s.name), el('td', { class: 'muted' }, s.png || `${s.aseprite} ${s.tag ? `tag ${s.tag}` : `frame ${s.frame ?? 0}`}`)))),
      el('p', { class: 'muted' }, 'Styles ([[style]]) are edited in the TOML; paint in Aseprite, then Reload.'),
      el('div', { class: 'toolbar' },
        el('button', { onclick: () => this.reload() }, 'Reload images'),
        el('button', { onclick: () => this.save() }, 'Save TOML'),
        el('button', { class: 'btn primary', onclick: () => this.build() }, 'Build')));
    const out = el('div', { class: 'row', style: 'flex-direction:column' });
    if (this.err) out.append(messages([['err', this.err]]));
    if (this.res) {
      const r = this.res, t = r.ts, pool = r.conf.pool_bytes;
      const msgs = [...r.warnings.map((w) => ['warn', w]), ...(r.infos || []).map((w) => ['info', w])];
      out.append(el('div', { class: 'card' }, el('h3', {}, 'Result'),
        el('div', {}, `${t.styleNames.length} styles, ${t.entries.length} images, VRAM ${t.u} bytes`
          + (pool ? ` of pool ${pool} (${Math.round((100 * t.u) / pool)} %)` : '') + `, VRL ${r.stream.length} bytes`),
        messages(msgs)));
      out.append(el('div', { class: 'card' }, el('h3', {}, 'Previews'),
        el('div', { class: 'row' }, r.previews.map((p) => el('figure', { style: 'margin:0' },
          imageCanvas(p.image, 1, 1, p.name), el('figcaption', { class: 'muted' }, p.name))))));
      out.append(el('div', { class: 'card' }, el('h3', {}, 'Slots × styles'), this.slotTable(t)));
    }
    this.root.replaceChildren(el('div', { class: 'row' }, form, out));
  }

  slotTable(t) {
    const cell = (v) => (v === T.NOIMG ? '–' : v === T.FALLBACK ? '↩0' : String(v));
    return el('div', { style: 'overflow:auto;max-width:70vw' }, el('table', { class: 'form msgs' },
      el('tr', {}, el('td', {}, 'slot'), t.styleNames.map((n) => el('td', {}, n))),
      t.slots.map((s, k) => el('tr', {}, el('td', {}, s.name || String(k)),
        t.styleNames.map((_, st) => el('td', {}, cell(t.styles[st][k])))))),
    el('p', { class: 'muted' }, 'number = image entry, ↩0 = fallback to style 0, – = no image'));
  }

  async save() { await this.project.write(this.path, this.text); this.status(`${this.path} saved`); }

  async build() {
    if (!this.res) { this.status('fix the errors first', true); return; }
    const dir = join('', this.res.conf.out);
    const files = { ...this.res.files };
    for (const p of this.res.previews) files[p.name] = encodePng(p.image);
    for (const [n, d] of Object.entries(files)) await this.project.write(join(dir, n), d);
    this.status(`${Object.keys(files).length} files written to ${dir}`);
  }
}
