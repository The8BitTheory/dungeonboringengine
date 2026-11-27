// Live VIEW for the editors: a dbeview scene (built assets) with the map being edited (P8 6.1).
import * as V from '../../js/core/view.js';
import { parseToml } from '../../js/core/io/toml.js';
import { move } from '../../js/core/move.js';
import { dirname, join } from './fs.js';

const ZX = 4, ZY = 2.4;          // chunky pixel on a monitor: about 4 : 2.4 (160 x 100 on 4 : 3)
const DIRS = 'NESW';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => (k.startsWith('on') ? (e[k] = v) : e.setAttribute(k, v)));
  e.append(...kids);
  return e;
}

/** Paths a dbeview scene TOML refers to, relative to its folder. */
function sceneRefs(cfg) {
  const s = cfg.scene || {};
  const r = [s.dvg, s.map];
  for (const k of ['walls', 'floor', 'ceil']) if (cfg[k]) r.push(cfg[k].dts, cfg[k].vrl);
  if (cfg.background) r.push(cfg.background.dbg, cfg.background.vrl);
  for (const sp of cfg.sprites || []) r.push(sp.s2, sp.vrl);
  return r.filter(Boolean);
}

export class Preview {
  constructor(status) {
    this.status = status;
    this.scene = null;
    this.scenePath = null;
    this.canvas = el('canvas', { width: 280, height: 96, 'aria-label': 'live view' });
    this.info = el('div', { class: 'muted' }, 'no scene: choose a dbeview scene below');
    this.select = el('select', { onchange: () => this.loadScene(this.select.value).catch((e) => this.status(e.message, true)) });
    this.box = el('div', {}, this.canvas, this.info, el('label', { class: 'muted' }, 'assets from scene ', this.select));
  }

  element() { return this.box; }

  setProject(project, files) {
    this.project = project;
    this.scenes = files.filter((f) => f.kind === 'dbeview').map((f) => f.path);
    this.select.replaceChildren(el('option', { value: '' }, '—'), ...this.scenes.map((p) => el('option', { value: p }, p)));
  }

  async loadScene(path) {
    if (!path) return null;
    const text = await this.project.readText(path);
    const cfg = parseToml(text);
    const dir = dirname(path);
    const cache = new Map();
    for (const rel of sceneRefs(cfg)) {
      try { cache.set(rel, await this.project.read(join(dir, rel))); } catch (e) {
        throw new Error(`${path}: ${rel} not found (built assets missing? e.g. demo/build.py)`);
      }
    }
    const scene = V.loadScene(cfg, (rel) => {
      if (!cache.has(rel)) throw new Error(`${path}: ${rel} not read`);
      return cache.get(rel);
    }, path);
    this.scene = scene;
    this.scenePath = path;
    this.select.value = path;
    this.mapPath = join(dir, cfg.scene.map);
    this.render();
    return { scene, mapPath: this.mapPath };
  }

  /** Use the scene that names this map (if any) unless a scene is already chosen. */
  async attachMap(map, mapPath) {
    if (!this.scene && this.scenes) {
      for (const p of this.scenes) {
        try {
          const cfg = parseToml(await this.project.readText(p));
          if (cfg.scene && join(dirname(p), cfg.scene.map) === mapPath) { await this.loadScene(p); break; }
        } catch { /* skip broken scene files */ }
      }
    }
    this.update(map, map.start, map.direction);
  }

  update(map, pos, dir) {
    if (!this.scene) return;
    this.scene.dmp = map;
    this.scene.pos = pos;
    this.scene.dir = dir;
    this.render();
  }

  move(map, pos, dir, action) {
    const r = move(map, pos, dir, this.scene ? this.scene.objects : [], action);
    return { pos: r.pos, dir: r.dir, blocked: r.x };
  }

  render() {
    const sc = this.scene;
    if (!sc) return;
    let vram, res;
    try {
      [vram, res] = V.renderView(sc, null, null, 0);
    } catch (e) {
      this.info.textContent = `view: ${e.message}`;
      return;
    }
    const img = V.windowImage(sc, vram, 1);
    this.canvas.width = img.width;
    this.canvas.height = img.height;
    this.canvas.style.width = `${img.width * ZX / 2}px`;
    this.canvas.style.height = `${Math.round(img.height * ZY)}px`;
    const g = this.canvas.getContext('2d');
    const id = g.createImageData(img.width, img.height);
    for (let i = 0, j = 0; i < img.width * img.height; i++, j += 3) {
      id.data.set([img.rgb[j], img.rgb[j + 1], img.rgb[j + 2], 255], i * 4);
    }
    g.putImageData(id, 0, 0);
    const m = sc.dmp;
    this.info.textContent = `(${sc.pos % m.width}, ${Math.floor(sc.pos / m.width)}) ${DIRS[sc.dir]} · `
      + `VCL ${res.vcllen} + VMS ${res.vmslen} bytes of ${sc.buf[1] - sc.buf[0]}, ${res.x} entries`
      + (res.a ? ` · A = ${res.a}` : '');
  }
}
