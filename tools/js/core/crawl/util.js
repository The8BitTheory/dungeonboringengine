// Small Python-compatibility helpers of the Crawl converters (json.dump layout, tuple repr, int parsing).

/** json.dumps(v, indent=indent) of Python (ensure_ascii); Map keeps its insertion order (Python dict with int keys),
 *  keys are converted with String(). Only ints, strings, booleans, null, arrays, Maps and plain objects. */
export function pyJson(v, indent = 1) {
  const str = (s) => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const enc = (x, lvl) => {
    if (x === null || x === undefined) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (typeof x === 'number') {
      if (Number.isInteger(x)) return String(x);
      throw new TypeError('pyJson: floats are not supported');
    }
    if (typeof x === 'string') return str(x);
    const pad = '\n' + ' '.repeat(indent * (lvl + 1)), end = '\n' + ' '.repeat(indent * lvl);
    if (x instanceof Uint8Array) x = Array.from(x);
    if (Array.isArray(x)) return x.length ? '[' + x.map((y) => pad + enc(y, lvl + 1)).join(',') + end + ']' : '[]';
    const ent = x instanceof Map ? [...x.entries()] : Object.entries(x);
    return ent.length ? '{' + ent.map(([k, y]) => pad + str(String(k)) + ': ' + enc(y, lvl + 1)).join(',') + end + '}' : '{}';
  };
  return enc(v, 0);
}

/** Python repr of a tuple of ints / strings ("(1, -1, 0)"). */
export function tupleRepr(a) {
  const r = (x) => (typeof x === 'string' ? `'${x}'` : String(x));
  return '(' + a.map(r).join(', ') + (a.length === 1 ? ',' : '') + ')';
}

/** Python repr of a list of ints ("[-1, 0, 1]"). */
export const listRepr = (a) => '[' + a.join(', ') + ']';

/** Python int(s) (base 10; whitespace and single underscores between digits allowed) or null. */
export function pyInt10(s) {
  const t = String(s).trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) return null;
  return parseInt(t.replace(/_/g, ''), 10);
}

/** Python int(s, 0) or null. */
export function pyInt0(s) {
  const t = String(s).trim();
  let m;
  if ((m = /^([+-]?)0[xX]((?:_?[0-9a-fA-F])+)$/.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2].replace(/_/g, ''), 16);
  if ((m = /^([+-]?)0[oO]((?:_?[0-7])+)$/.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2].replace(/_/g, ''), 8);
  if ((m = /^([+-]?)0[bB]((?:_?[01])+)$/.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2].replace(/_/g, ''), 2);
  if (/^[+-]?([1-9](_?\d)*|0(_?0)*)$/.test(t)) return parseInt(t.replace(/_/g, ''), 10);
  return null;
}

/** Python repr of a str (simple: single quotes unless the text contains one and no double quote). */
export function strRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q) + q;
}
