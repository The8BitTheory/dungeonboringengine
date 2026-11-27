// Small DOM helpers shared by the editors.
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e[k] = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  }
  e.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}

/** Canvas showing an RGB or RGBA pixel buffer; sx/sy = CSS scale (pixelated). */
export function imageCanvas(img, sx = 1, sy = sx, label = 'image') {
  const c = el('canvas', { width: img.width, height: img.height, 'aria-label': label });
  c.style.width = `${Math.round(img.width * sx)}px`;
  c.style.height = `${Math.round(img.height * sy)}px`;
  const g = c.getContext('2d');
  const id = g.createImageData(img.width, img.height);
  const n = img.width * img.height;
  if (img.rgba) id.data.set(img.rgba.subarray(0, n * 4));
  else for (let i = 0, j = 0; i < n; i++, j += 3) id.data.set([img.rgb[j], img.rgb[j + 1], img.rgb[j + 2], 255], i * 4);
  g.putImageData(id, 0, 0);
  return c;
}

/** Messages list: [['err'|'warn'|'info', text], ...] */
export function messages(list) {
  return el('div', { class: 'msgs' }, list.map(([k, t]) => el('div', { class: k }, t)));
}

export function download(name, data) {
  const a = el('a', { href: URL.createObjectURL(new Blob([data])), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
