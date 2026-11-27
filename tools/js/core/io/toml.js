// TOML 1.0 (vendored smol-toml 1.9.1, BSD-3-Clause, tools/js/vendor/smol-toml/).
import { parse as tomlParse, TomlError } from '../../vendor/smol-toml/index.js';

export { TomlError };

/** bytes or string -> plain object (like Python's tomllib.loads). */
export function parseToml(src) {
  const text = typeof src === 'string' ? src : new TextDecoder('utf-8', { fatal: true }).decode(src);
  return tomlParse(text);
}
