// The core builders read referenced files through a synchronous resolver (P8 2.1). In the browser the files are
// fetched first: run the build, collect the paths it missed, load them, run again until nothing new is found.
import { normPath } from './fs.js';

export async function withFiles(project, run, cache = new Map()) {
  for (let round = 0; round < 8; round++) {
    const missing = new Set();
    const resolve = (p) => {
      let k;
      try { k = normPath(p); } catch { return null; }
      if (cache.has(k)) return cache.get(k);
      missing.add(k);
      return null;
    };
    let result, error;
    try { result = run(resolve); } catch (e) { error = e; }
    let loaded = 0;
    for (const k of missing) {
      try { cache.set(k, await project.read(k)); loaded++; } catch { cache.set(k, null); }
    }
    if (!loaded) {
      if (error) throw error;
      return result;
    }
  }
  throw new Error('too many nested file references');
}
