// Project folder access for the editors (docs/specs/P8-js-tools.md 2.3).
// Chrome/Edge: File System Access API, read and write, the handle is remembered in IndexedDB.
// Other browsers: read-only via <input webkitdirectory>, writes become downloads.

const DB = 'dbe-tools', STORE = 'handles';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const tx = rq.result.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** Normalise "a/b/../c" relative to the project root; leaving the root is an error. */
export function normPath(p) {
  const out = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) throw new Error(`${p}: outside the project folder`);
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

export function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
export function join(dir, rel) { return normPath(dir ? `${dir}/${rel}` : rel); }

export class Project {
  constructor(name, writable) { this.name = name; this.writable = writable; }
  static supported() { return typeof window.showDirectoryPicker === 'function'; }

  /** Ask the user for a folder (Chrome/Edge) or fall back to the directory input. */
  static async pick() {
    if (Project.supported()) {
      const h = await window.showDirectoryPicker({ id: 'dbe-project', mode: 'readwrite' });
      try { await idb('readwrite', (s) => s.put(h, 'last')); } catch { /* private window: not remembered */ }
      return new HandleProject(h);
    }
    return FileListProject.pick();
  }

  /** The folder of the last session, if the browser still grants access (may need a click). */
  static async restore(interactive = false) {
    if (!Project.supported()) return null;
    let h;
    try { h = await idb('readonly', (s) => s.get('last')); } catch { return null; }
    if (!h) return null;
    const opts = { mode: 'readwrite' };
    let perm = await h.queryPermission(opts);
    if (perm !== 'granted' && interactive) perm = await h.requestPermission(opts);
    return perm === 'granted' ? new HandleProject(h) : { pending: h.name };
  }
}

class HandleProject extends Project {
  constructor(h) { super(h.name, true); this.root = h; }

  async _dir(path, create = false) {
    let d = this.root;
    for (const part of path ? path.split('/') : []) d = await d.getDirectoryHandle(part, { create });
    return d;
  }

  async read(path) {
    path = normPath(path);
    const d = await this._dir(dirname(path));
    const f = await (await d.getFileHandle(path.split('/').pop())).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  async readText(path) { return new TextDecoder().decode(await this.read(path)); }

  async exists(path) { try { await this.read(path); return true; } catch { return false; } }

  async write(path, data) {
    path = normPath(path);
    const d = await this._dir(dirname(path), true);
    const w = await (await d.getFileHandle(path.split('/').pop(), { create: true })).createWritable();
    await w.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    await w.close();
  }

  /** All files below the root (without build/, .git/, node_modules/), paths relative to the root. */
  async list(filter = () => true, dir = this.root, prefix = '', out = []) {
    for await (const [name, h] of dir.entries()) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') {
        if (['.git', 'node_modules', '__pycache__'].includes(name)) continue;
        await this.list(filter, h, p, out);
      } else if (filter(p)) out.push(p);
    }
    return out.sort();
  }
}

class FileListProject extends Project {
  constructor(name, files) { super(name, false); this.files = files; }

  static pick() {
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.webkitdirectory = true;
      inp.onchange = () => {
        const files = new Map();
        let name = 'project';
        for (const f of inp.files) {
          const parts = f.webkitRelativePath.split('/');
          name = parts.shift();
          files.set(parts.join('/'), f);
        }
        resolve(new FileListProject(name, files));
      };
      inp.oncancel = () => reject(new DOMException('cancelled', 'AbortError'));
      inp.click();
    });
  }

  async read(path) {
    const f = this.files.get(normPath(path));
    if (!f) throw new Error(`${path}: not found`);
    return new Uint8Array(await f.arrayBuffer());
  }

  async readText(path) { return new TextDecoder().decode(await this.read(path)); }
  async exists(path) { return this.files.has(normPath(path)); }

  async write(path, data) {   // read-only folder: offer the file as a download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = path.split('/').pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async list(filter = () => true) { return [...this.files.keys()].filter(filter).sort(); }
}

/** Read-only project served over HTTP (e.g. python3 -m http.server from the repo root): ?http=/ in the app URL.
 *  Listing parses the server's directory pages; writes become downloads. Used for headless smoke tests too. */
export class HttpProject extends Project {
  constructor(base) { super(`${location.host}${base}`, false); this.base = base.endsWith('/') ? base : `${base}/`; }

  async read(path) {
    const r = await fetch(this.base + normPath(path));
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async readText(path) { return new TextDecoder().decode(await this.read(path)); }
  async exists(path) { return (await fetch(this.base + normPath(path), { method: 'HEAD' })).ok; }
  write(path, data) { return FileListProject.prototype.write.call(this, path, data); }

  async list(filter = () => true, dir = '', out = [], depth = 0) {
    if (depth === 0) {                         // static hosting (GitHub Pages) has no directory pages: files.json
      try {
        const r = await fetch(`${this.base}files.json`);
        if (r.ok) return (await r.json()).filter(filter).sort();
      } catch { /* no manifest: parse directory pages */ }
    }
    if (depth > 6) return out;
    const r = await fetch(this.base + dir);
    if (!r.ok) return out;
    const html = await r.text();
    for (const m of html.matchAll(/href="([^"?#]+)"/g)) {
      const name = decodeURIComponent(m[1]);
      if (name.startsWith('/') || name.startsWith('..') || /^(\.git|build|node_modules|__pycache__)\/$/.test(name)) continue;
      const p = dir + name;
      if (name.endsWith('/')) await this.list(filter, p, out, depth + 1);
      else if (filter(p)) out.push(p);
    }
    return out.sort();
  }
}
