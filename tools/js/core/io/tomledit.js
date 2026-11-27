// Edit single values of a TOML text in place, keeping comments and layout (editors, P8 6).
// Only for simple `key = value` lines inside a [section] (or before the first section with section = '').
// Values are TOML literals given as JS values: number, boolean, string, array of these.

export function tomlLiteral(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlLiteral).join(', ')}]`;
  throw new Error(`tomledit: unsupported value ${v}`);
}

const HEADER = /^\s*\[([^\]]+)\]\s*(#.*)?$/;

function sectionRange(lines, section) {
  if (!section) {
    const end = lines.findIndex((l) => HEADER.test(l));
    return [0, end < 0 ? lines.length : end];
  }
  const start = lines.findIndex((l) => { const m = l.match(HEADER); return m && m[1].trim() === section; });
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !HEADER.test(lines[end])) end++;
  return [start + 1, end];
}

/** Set section.key to value (undefined/null removes the line). Adds the section or key if missing. */
export function setTomlValue(text, section, key, value) {
  const lines = text.split('\n');
  let r = sectionRange(lines, section);
  const re = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)([^#]*?)(\\s*(#.*)?)$`);
  const remove = value === undefined || value === null;
  if (!r) {
    if (remove) return text;
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', `[${section}]`, `${key} = ${tomlLiteral(value)}`, '');
    return lines.join('\n');
  }
  for (let i = r[0]; i < r[1]; i++) {
    const m = lines[i].match(re);
    if (m) {
      if (remove) lines.splice(i, 1);
      else lines[i] = m[1] + tomlLiteral(value) + m[3];
      return lines.join('\n');
    }
  }
  if (remove) return text;
  let at = r[1];
  while (at > r[0] && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, `${key} = ${tomlLiteral(value)}`);
  return lines.join('\n');
}
