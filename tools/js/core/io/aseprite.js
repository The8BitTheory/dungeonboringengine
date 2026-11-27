// Aseprite JSON export (sprite sheet + data file) as dbetex.py / dbespr.py read it:
//   aseprite -b x.aseprite --sheet x.png --data x.json --format json-array|json-hash --list-slices --list-tags
// Only the JSON is handled here; the sheet image (meta.image, relative to the JSON) is read by the caller.

/** JSON bytes -> {js, meta}; Err is the error class of the caller (messages "<path>: ..."). */
export function readAseprite(bytes, path = 'aseprite.json', Err = Error) {
  let js;
  try {
    js = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder('utf-8').decode(bytes));
  } catch (e) {
    throw new Err(`${path}: ${e.message}`);
  }
  if (js === null || typeof js !== 'object' || Array.isArray(js)) throw new Err(`${path}: no frames`);
  const meta = js.meta && typeof js.meta === 'object' ? js.meta : {};
  if (!Object.prototype.hasOwnProperty.call(meta, 'image')) throw new Err(`${path}: meta.image missing`);
  return { js, meta };
}

/** Frames as a list: json-array as is, json-hash in key order. withNames: hash entries get filename = key
 *  (unless they have one; dbespr), otherwise the values are taken unchanged (dbetex). */
export function frameList(js, path = 'aseprite.json', Err = Error, withNames = true) {
  let fr = js.frames;
  if (fr !== null && typeof fr === 'object' && !Array.isArray(fr)) {
    fr = Object.entries(fr).map(([k, v]) => (withNames ? { ...v, filename: v && 'filename' in v ? v.filename : k } : v));
  }
  if (!Array.isArray(fr) || !fr.length) throw new Err(`${path}: no frames`);
  return fr;
}
