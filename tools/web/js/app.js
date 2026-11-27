// DBE Tools: shell of the editors (docs/specs/P8-js-tools.md 6). Project folder, file list, tabs.
import { Project, HttpProject } from './fs.js';
import { parseToml } from '../../js/core/io/toml.js';
import { MapEditor } from './map-editor.js';

const $ = (id) => document.getElementById(id);
const state = { project: null, files: [], active: null };
const editors = { map: null };
// editors of the other tabs are loaded on first use (module, class)
const LAZY = { geom: ['./geom-editor.js', 'GeomEditor'], tex: ['./tex-editor.js', 'TexEditor'], spr: ['./spr-editor.js', 'SprEditor'] };

async function editor(tab) {
  if (!editors[tab] && LAZY[tab]) {
    const [mod, cls] = LAZY[tab];
    const E = (await import(mod))[cls];
    editors[tab] = new E($(`view-${tab}`), status);
    if (state.project) editors[tab].setProject(state.project, state.files);
  }
  return editors[tab];
}

function showTab(tab) {
  for (const b of document.querySelectorAll('#tabs [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const sec of document.querySelectorAll('main > section.panel')) sec.hidden = sec.id !== `view-${tab}`;
  state.tab = tab;
}

export function status(msg, err = false) {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('err', err);
}

// TOML project files by their "format" key -> editor tab
const FORMAT_TAB = { dbemap: 'map', dbeview: 'map', dbegeom: 'geom', dbetex: 'tex', dbespr: 'spr' };

async function classify(path) {
  try {
    const head = (await state.project.readText(path)).slice(0, 2000);
    const m = head.match(/^\s*format\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
    const cfg = parseToml(await state.project.readText(path));
    if (cfg.format) return cfg.format;
    if (cfg.viewport && cfg.output) return 'dbegeom';      // view.toml has no format key (P3)
    return null;
  } catch { return null; }
}

async function loadProject(p) {
  state.project = p;
  $('project').textContent = `${p.name}${p.writable ? '' : ' (read only: saving downloads files)'}`;
  $('reopen').hidden = true;
  status('reading the folder…');
  const tomls = await p.list((f) => f.endsWith('.toml') && !f.startsWith('build/'));
  const files = [];
  for (const f of tomls) {
    const kind = await classify(f);
    if (kind && FORMAT_TAB[kind]) files.push({ path: f, kind });
  }
  state.files = files;
  renderFiles();
  status(`${files.length} project files`);
  for (const e of Object.values(editors)) if (e) e.setProject(p, files);
}

function renderFiles() {
  const ul = $('filelist');
  ul.replaceChildren();
  $('nofiles').hidden = state.files.length > 0;
  for (const f of state.files) {
    const li = document.createElement('li');
    li.textContent = f.path;
    const k = document.createElement('span');
    k.className = 'kind';
    k.textContent = f.kind;
    li.append(k);
    li.classList.toggle('active', state.active === f.path);
    li.onclick = () => openFile(f);
    ul.append(li);
  }
}

async function openFile(f) {
  const tab = FORMAT_TAB[f.kind];
  state.active = f.path;
  renderFiles();
  showTab(tab);
  try {
    if (f.kind === 'dbemap') await editors.map.openMap(f.path);
    else if (f.kind === 'dbeview') await editors.map.openScene(f.path);
    else await (await editor(tab)).open(f.path);
  } catch (e) {
    status(e.message, true);
    console.error(e);
  }
}

async function init() {
  editors.map = new MapEditor($('view-map'), status);
  for (const b of document.querySelectorAll('#tabs [role=tab]')) {
    b.onclick = async () => {
      showTab(b.dataset.tab);
      try { await editor(b.dataset.tab); } catch (e) { status(e.message, true); console.error(e); }
    };
  }
  $('open').onclick = async () => {
    try { await loadProject(await Project.pick()); } catch (e) { if (e.name !== 'AbortError') status(e.message, true); }
  };
  const q = new URLSearchParams(location.search);
  if (q.has('http')) {                         // read-only project over HTTP (smoke tests, quick look)
    await loadProject(new HttpProject(q.get('http') || '/'));
    const f = state.files.find((x) => x.path === q.get('open'));
    if (f) await openFile(f);
    document.body.dataset.ready = '1';
    return;
  }
  const r = await Project.restore(false);
  if (r && r.pending) {
    const b = $('reopen');
    b.hidden = false;
    b.textContent = `Reopen ${r.pending}`;
    b.onclick = async () => { const p = await Project.restore(true); if (p && !p.pending) await loadProject(p); };
  } else if (r) await loadProject(r);
  if (!Project.supported()) status('this browser cannot write folders: saving offers downloads');
}

init().catch((e) => status(e.message, true));
