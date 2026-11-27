// Sprite sets for Crawl 128: ghosts (RED.VDC, RED1.VDC) and gems (font characters). Port of tools/crawlsprites.py.
//
// Output (files): ghosts.vdc (packed ghost images, visible bytes only, in VMS order, copied into VRAM via RTV),
// ghost.spr (sprite set ghosts, VMS, transparent, load address $E200), gem.spr (VMC from the font, base = character
// set CA, load address $EA00). Format: docs/formats.md (sprite metadata v1). Positions as in crawl.bas (lines
// 4670-5000, 6300-6560): the half images at the sides are completed to full images; occlusion is handled by VIEW.
// Transparency: black pixels (0) connected to the image border. Black pixels inside the figure (eyes) stay opaque.

export const ROW = 80;            // row width of the image buffer (EI%)
export const VIEW_COL0 = 6;       // first column of the viewport (406 = 5 * 80 + 6)
export const ANY = 0xFF;

/** Ghosts: depth -> [file index, row, [[side, column], ...]]; columns absolute (relative to AP); dict order of Python. */
export const GHOST_POS = Object.freeze([
  [1, [0, 53, [[0, 36], [-1, 9], [1, 59]]]],
  [2, [1, 44, [[0, 31], [-1, 21], [1, 51]]]],
]);
/** Gems: [[d, s], [row, [[column, font index], ...]]]; characters 3 x 6 bytes, 18 bytes per character.
 *  Font index = PETSCII - 32 (as FN TX in crawl.bas): CR$ = CHR$(36)+CHR$(37) are characters 4 and 5. */
export const GEM_POS = Object.freeze([
  [[1, 0], [80, [[40, 4], [43, 5]]]],
  [[1, -1], [74, [[12, 4], [15, 5]]]],
  [[1, 1], [74, [[62, 4], [65, 5]]]],
  [[2, 0], [64, [[40, 4], [43, 5]]]],
  [[2, -1], [61, [[22, 4], [25, 5]]]],
  [[2, 1], [61, [[52, 4], [55, 5]]]],
]);
export const CHAR_W = 3, CHAR_H = 6;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);

/** Crawl image file (PRG): byte 0 count, 7 bytes header each, pixels after the header -> [[w, h, pixel bytes]]. */
export function readVdc(data) {
  const d = data.subarray(2);
  const n = d[0];
  const base = 1 + 7 * n;
  const imgs = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + 7 * i;
    const src = u16(d, o), w = d[o + 2], h = d[o + 3];
    imgs.push([w, h, d.slice(base + src, base + src + w * h)]);
  }
  return imgs;
}

/** Pixel grid 2w x h; true = transparent (black and connected to the border). */
export function transparentMask(w, h, px) {
  const W = 2 * w;
  const val = Array.from({ length: h }, (_, r) => Array.from({ length: W }, (_, c) => (px[r * w + (c >> 1)] >> (c % 2 === 0 ? 4 : 0)) & 15));
  const t = Array.from({ length: h }, () => new Array(W).fill(false));
  const stack = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < W; c++) if ((r === 0 || r === h - 1 || c === 0 || c === W - 1) && val[r][c] === 0) stack.push([r, c]);
  }
  while (stack.length) {
    const [r, c] = stack.pop();
    if (t[r][c] || val[r][c] !== 0) continue;
    t[r][c] = true;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < h && cc >= 0 && cc < W && !t[rr][cc] && val[rr][cc] === 0) stack.push([rr, cc]);
    }
  }
  return t;
}

/** Per row: [VMS commands [kind, column, count] relative to the row, packed bytes]. */
export function vmsRows(w, h, px) {
  const t = transparentMask(w, h, px);
  const rows = [];
  for (let r = 0; r < h; r++) {
    const cmds = [], packed = [];
    let c = 0;
    while (c < w) {
      let b = px[r * w + c];
      let lt = t[r][2 * c], rt = t[r][2 * c + 1];
      if (lt && rt) { c++; continue; }
      const half = (rt && !lt) || (lt && !rt && (b & 15) !== 0);
      if (half) { cmds.push([8, c, 0]); packed.push(b); c++; continue; }
      const start = c;
      while (c < w) {
        b = px[r * w + c];
        lt = t[r][2 * c]; rt = t[r][2 * c + 1];
        const opaque = !(lt || rt) || (lt && !rt && (b & 15) === 0);
        if (!opaque) break;
        c++;
      }
      cmds.push([1, start, c - start]);
      for (let i = start; i < c; i++) packed.push(px[r * w + i]);
    }
    rows.push([cmds, Uint8Array.from(packed)]);
  }
  return rows;
}

/** VMS list (alpha 0, count as word) and packed bytes for a whole image. */
export function vmsPack(w, h, px) {
  const cmds = [], packed = [];
  vmsRows(w, h, px).forEach(([rc, rp], r) => {
    for (const [k, c, n] of rc) cmds.push([k, r, c, n]);
    packed.push(...rp);
  });
  const lst = [0, cmds.length & 255, cmds.length >> 8];
  for (const [k, r, c, ln] of cmds) {
    const o = r * ROW + c;
    lst.push(k, o & 255, o >> 8);
    if (k === 1) lst.push(ln);
  }
  return [Uint8Array.from(lst), Uint8Array.from(packed)];
}

/** Sprite metadata v1 PRG. parts: [d, s, angle, flags, w, h, src, dest, col, list index or null]. */
export function sprBytes(load, parts, lists) {
  const head = [0x53, 0x50, 1, parts.length, 0, 0];
  let ofs = head.length + 15 * parts.length;
  const lofs = [];
  for (const l of lists) { lofs.push(ofs); ofs += l.length; }
  const out = [load & 255, (load >> 8) & 255, ...head];
  const w16 = (v) => out.push(v & 255, (v >> 8) & 255);
  for (const [d, s, ang, flags, w, h, src, dest, col, li] of parts) {
    const [ll, lo] = li !== null ? [lists[li].length, lofs[li]] : [0, 0];
    out.push(d, s & 255, ang, flags, w, h);
    w16(src); w16(dest);
    out.push(col & 255);
    w16(ll); w16(lo);
  }
  for (const l of lists) out.push(...l);
  return Uint8Array.from(out);
}

/** RED.VDC, RED1.VDC (bytes) -> {files: {'ghosts.vdc', 'ghost.spr', 'gem.spr'}, lines: output of the Python main}. */
export function build(red, red1) {
  const files = [readVdc(red), readVdc(red1)];
  const parts = [], lists = [], packed = [];
  for (const [d, [fi, row, cols]] of GHOST_POS) {
    files[fi].forEach(([w, h, px], ang) => {
      const [lst, data] = vmsPack(w, h, px);
      const src = packed.length;
      packed.push(...data);
      lists.push(lst);
      for (const [s, col] of cols) parts.push([d, s, ang, 1, w, h, src, row * ROW + col, col - VIEW_COL0, lists.length - 1]);
    });
  }
  const ghostsVdc = Uint8Array.from([0x00, 0x20, ...packed]);
  const ghostSpr = sprBytes(0xE200, parts, lists);
  const lens = lists.map((l) => l.length);
  const lines = [`ghost.spr: ${parts.length} parts, ${lists.length} lists (${Math.min(...lens)}-${Math.max(...lens)} bytes), `
    + `${ghostSpr.length - 2} bytes; ghosts.vdc ${packed.length} bytes`];
  const gparts = [];
  for (const [[d, s], [row, chars]] of GEM_POS) {
    for (const [col, ch] of chars) gparts.push([d, s, ANY, 0, CHAR_W, CHAR_H, ch * CHAR_W * CHAR_H, row * ROW + col, col - VIEW_COL0, null]);
  }
  const gemSpr = sprBytes(0xEA00, gparts, []);
  lines.push(`gem.spr: ${gparts.length} parts, ${gemSpr.length - 2} bytes`);
  return { files: { 'ghosts.vdc': ghostsVdc, 'ghost.spr': ghostSpr, 'gem.spr': gemSpr }, lines };
}
