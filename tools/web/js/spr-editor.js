// Sprite editor (docs/specs/P8-js-tools.md 6.4): dbespr project, preview per depth/phase/angle with the anchors
// of the sub-positions, image list, report.
import * as S from '../../js/core/spr.js';
import { encodePng } from '../../js/core/io/png.js';
import { parseToml } from '../../js/core/io/toml.js';
import { setTomlValue } from '../../js/core/io/tomledit.js';
import { el, imageCanvas, messages } from './ui.js';
import { join } from './fs.js';
import { withFiles } from './resolve.js';
import { fieldRow } from './tex-editor.js';

const FIELDS = [
  ['name', 'str'], ['geom', 'str'], ['dvg', 'str'], ['out', 'str'], ['load', 'hex'], ['vrl_load', 'hex'],
  ['angles', 'int', '1, 2, 4 or 8'], ['phases', 'int'], ['max_cores', 'int'], ['core_min', 'int'],
  ['key', 'str', 'RRGGBB transparent'], ['derive', 'select', ['', 'nearest']],
];

export class SprEditor {
  constructor(root, status) {
    this.root = root;
    this.status = status;
    this.cache = new Map();
    this.sel = { d: 1, phase: 0, a: 0 };
    root.replaceChildren(el('p', { class: 'muted' }, 'Open a sprite project (dbespr TOML, e.g. demo/goblin.toml).'));
  }

  setProject(project) { this.project = project; }

  async open(path) {
    this.path = path;
    this.text = await this.project.readText(path);
    this.cache = new Map();
    this.sel = { d: 1, phase: 0, a: 0 };
    await this.rebuild();
  }

  async reload() { this.cache = new Map(); await this.rebuild(); this.status('reloaded from disk'); }

  async rebuild() {
    const t0 = performance.now();
    try {
      this.res = await withFiles(this.project, (resolve) => S.buildSpr(this.text, { path: this.path, resolve, preview: false }), this.cache);
      this.err = null;
      this.status(`${this.path}: built in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { this.res = null; this.err = e.message; this.status(e.message, true); }
    this.render();
  }

  render() {
    const cfg = parseToml(this.text);
    const sp = cfg.sprite || {};
    const form = el('div', { class: 'card' }, el('h3', {}, 'Sprite set'),
      el('table', { class: 'form' }, FIELDS.map((f) => fieldRow((k) => sp[k], (k, v) => {
        this.text = setTomlValue(this.text, 'sprite', k, v === '' || v === false ? null : v);
      }, f, () => this.rebuild()))),
      el('h3', {}, 'Images'),
      el('table', { class: 'form msgs' }, el('tr', {}, ['phase', 'angle', 'depth', 'box', 'foot'].map((h) => el('td', {}, h))),
        (cfg.image || []).map((im) => el('tr', {}, [im.phase, im.angle, im.depth, (im.box || []).join(','), (im.foot || []).join(',')]
          .map((v) => el('td', {}, String(v ?? '')))))),
      el('p', { class: 'muted' }, 'Images ([[image]]) are edited in the TOML; paint, then Reload.'),
      el('div', { class: 'toolbar' },
        el('button', { onclick: () => this.reload() }, 'Reload images'),
        el('button', { onclick: () => this.save() }, 'Save TOML'),
        el('button', { class: 'btn primary', onclick: () => this.build() }, 'Build')));
    const out = el('div', { class: 'row', style: 'flex-direction:column' });
    if (this.err) out.append(messages([['err', this.err]]));
    if (this.res) {
      const r = this.res, ss = r.ss, D = r.geom.viewport.depth;
      const pick = (k, n, label) => el('label', {}, ` ${label} `, el('select', { onchange: (e) => { this.sel[k] = +e.target.value; this.render(); } },
        Array.from({ length: n }, (_, i) => el('option', { value: i + (k === 'd' ? 1 : 0), selected: this.sel[k] === i + (k === 'd' ? 1 : 0) },
          String(i + (k === 'd' ? 1 : 0))))));
      let img = null, perr = null;
      try { img = S.preview(ss, r.geom, ss.vram, this.sel.d, this.sel.phase, this.sel.a); } catch (e) { perr = e.message; }
      out.append(el('div', { class: 'card' }, el('h3', {}, 'Preview (anchors = sub-positions)'),
        el('div', { class: 'toolbar' }, pick('d', D, 'depth'), pick('phase', r.conf.phases, 'phase'), pick('a', r.conf.angles, 'angle')),
        img ? imageCanvas(img, 1, 0.6, 'sprite preview') : messages([['err', perr]])));
      out.append(el('div', { class: 'card' }, el('h3', {}, 'Result'),
        el('div', {}, `${ss.images.length} images, VRAM ${ss.vram.length} bytes, VRL ${r.stream.length} bytes`),
        messages([...r.warnings.map((w) => ['warn', w]), ...(r.infos || []).map((w) => ['info', w])])));
    }
    this.root.replaceChildren(el('div', { class: 'row' }, form, out));
  }

  async save() { await this.project.write(this.path, this.text); this.status(`${this.path} saved`); }

  async build() {
    if (!this.res) { this.status('fix the errors first', true); return; }
    const dir = join('', this.res.conf.out);
    const files = { ...this.res.files };
    files[`${this.res.conf.name}_preview.png`] = encodePng(S.preview(this.res.ss, this.res.geom, this.res.ss.vram, 1));
    for (const [n, d] of Object.entries(files)) await this.project.write(join(dir, n), d);
    this.status(`${Object.keys(files).length} files written to ${dir}`);
  }
}
