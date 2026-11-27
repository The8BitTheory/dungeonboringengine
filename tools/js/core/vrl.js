// VRL: RLE stream for RXV (VDC-BASIC v3) - encoder, decoder, statistics. Port of tools/vrl.py.
//
// Stream (tokens; words low/high):
//   $00            end
//   $01-$7F  n bytes   n literals (1..127)
//   $80-$FD  v         run: L = b-$80+2 (2..127) times v
//   $FE      lo hi     skip: advance the target by n (0 = 65536), write nothing
//   $FF      lo hi v   long run: L = hi*256+lo (0 = 65536) times v
// File frame (PRG): load address (2), "VR", version 1, unpacked length U (word), stream.
// Details: docs/specs/P1-vrl.md, docs/formats.md (VRL v1).

export const SKIP = null;
export const VERSION = 1;
export const MAX_U = 65535;

export const PLACEHOLDER = Object.freeze({
  tok: 30, cpu_lit_byte: 22, cpu_byte: 15, cpu_run_fixed: 10,
  new_addr: 80, fill_fixed: 200, fill_byte: 1, fill_chunk: 30,
});

export class VrlError extends Error {}

function checkLen(n) {
  if (n > MAX_U) throw new VrlError('VRL: unpacked length exceeds 65535');
}

/** Sequence of int | null -> stream (incl. $00), size-optimal (spec 4.2). Returns Uint8Array. */
export function encode(data) {
  const seq = Array.from(data, (v) => (v === undefined ? null : v));
  for (const v of seq) {
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 255)) {
      throw new VrlError(`VRL: value outside 0..255: ${v}`);
    }
  }
  while (seq.length && seq[seq.length - 1] === null) seq.pop();
  const n = seq.length;
  checkLen(n);

  const skip = new Int32Array(n + 1), rep = new Int32Array(n + 1), lit = new Int32Array(n + 1);
  for (let i = n - 1; i >= 0; i--) {
    const v = seq[i];
    if (v === null) skip[i] = skip[i + 1] + 1;
    else {
      lit[i] = lit[i + 1] + 1;
      rep[i] = i + 1 < n && seq[i + 1] === v ? rep[i + 1] + 1 : 1;
    }
  }

  // best[i] = bytes * UNIT + tokens (bytes first, then token count); exact in a double (< 2^53).
  // Candidate per target j: smaller value better, on a tie greater j (more coverage), as in Python.
  const UNIT = 1 << 20;
  const best = new Float64Array(n + 1).fill(Infinity);
  const kind = new Uint8Array(n + 1);   // 1 skip, 2 run, 3 literal
  const len = new Int32Array(n + 1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (skip[i]) {
      const k = skip[i];
      best[i] = best[i + k] + 3 * UNIT + 1;
      kind[i] = 1; len[i] = k;
      continue;
    }
    const R = rep[i];
    let cCost = Infinity, cL = 0, cKind = 0;
    const consider = (cost, L, kd) => {    // tuple order (cost, -L, run before literal)
      if (cost < cCost || (cost === cCost && (L > cL || (L === cL && kd < cKind)))) {
        cCost = cost; cL = L; cKind = kd;
      }
    };
    if (R >= 2) {
      let bv = Infinity, bj = -1;
      const hi = i + Math.min(127, R);
      for (let j = i + 2; j <= hi; j++) {
        const v = best[j];
        if (v < bv || (v === bv && j > bj)) { bv = v; bj = j; }
      }
      const L = bj - i;
      consider(best[i + L] + 2 * UNIT + 1, L, 2);
    }
    if (R > 127) consider(best[i + R] + 4 * UNIT + 1, R, 2);
    {
      let bv = Infinity, bj = -1;
      const hi = i + Math.min(127, lit[i]);
      for (let j = i + 1; j <= hi; j++) {
        const v = best[j] + j * UNIT;
        if (v < bv || (v === bv && j > bj)) { bv = v; bj = j; }
      }
      const m = bj - i;
      consider(best[i + m] + (1 + m) * UNIT + 1, m, 3);
    }
    best[i] = cCost; kind[i] = cKind; len[i] = cL;
  }

  const out = [];
  let i = 0;
  while (i < n) {
    const L = len[i];
    if (kind[i] === 1) out.push(0xFE, L & 255, L >> 8);
    else if (kind[i] === 2) {
      if (L <= 127) out.push(0x80 + L - 2, seq[i]);
      else out.push(0xFF, L & 255, L >> 8, seq[i]);
    } else {
      out.push(L);
      for (let k = 0; k < L; k++) out.push(seq[i + k]);
    }
    i += L;
  }
  out.push(0);
  return Uint8Array.from(out);
}

/** Encode a rectangle width x height with stride (and optional mask) (spec 4.5). */
export function encodeRect(data, width, height, stride, mask = null) {
  if (width < 1 || height < 1 || stride < width) throw new VrlError('VRL: invalid rectangle geometry');
  if (stride > 65535) throw new VrlError('VRL: stride exceeds 65535');
  const d = Array.from(data);
  if (d.length !== width * height) throw new VrlError('VRL: data length does not match width x height');
  let m = null;
  if (mask !== null && mask !== undefined) {
    m = Array.from(mask, (x) => !!x);
    if (m.length !== d.length) throw new VrlError('VRL: mask length does not match width x height');
  }
  let last = d.length - 1;
  if (m) { last = -1; for (let k = 0; k < m.length; k++) if (m[k]) last = k; }
  const total = last < 0 ? 0 : Math.floor(last / width) * stride + (last % width) + 1;
  checkLen(total);
  const seq = new Array(total).fill(null);
  for (let k = 0; k <= last; k++) {
    if (!m || m[k]) seq[Math.floor(k / width) * stride + (k % width)] = d[k];
  }
  return encode(seq);
}

/** Tokens up to and including the end: {kind, length, value, offset}. */
export function decodeTokens(stream) {
  const s = stream instanceof Uint8Array ? stream : Uint8Array.from(stream);
  const toks = [];
  const n = s.length;
  let p = 0;
  for (;;) {
    if (p >= n) throw new VrlError(`VRL: unexpected end at offset ${p}`);
    const b = s[p];
    if (b === 0) { toks.push({ kind: 'end', length: 0, value: null, offset: p }); return toks; }
    if (b <= 0x7F) {
      if (p + 1 + b > n) throw new VrlError(`VRL: literal beyond the end of the stream at offset ${p}`);
      toks.push({ kind: 'lit', length: b, value: s.slice(p + 1, p + 1 + b), offset: p });
      p += 1 + b;
    } else if (b <= 0xFD) {
      if (p + 2 > n) throw new VrlError(`VRL: run beyond the end of the stream at offset ${p}`);
      toks.push({ kind: 'run', length: b - 0x80 + 2, value: s[p + 1], offset: p });
      p += 2;
    } else if (b === 0xFE) {
      if (p + 3 > n) throw new VrlError(`VRL: skip beyond the end of the stream at offset ${p}`);
      toks.push({ kind: 'skip', length: (s[p + 1] | (s[p + 2] << 8)) || 65536, value: null, offset: p });
      p += 3;
    } else {
      if (p + 4 > n) throw new VrlError(`VRL: long run beyond the end of the stream at offset ${p}`);
      toks.push({ kind: 'lrun', length: (s[p + 1] | (s[p + 2] << 8)) || 65536, value: s[p + 3], offset: p });
      p += 4;
    }
  }
}

/** Execute the stream; copy of base (extended with 0 if needed), skips leave base unchanged. */
export function decode(stream, base = null) {
  let out = base ? Uint8Array.from(base) : new Uint8Array(0);
  let size = out.length;
  const grow = (need) => {
    if (need <= out.length) return;
    const nb = new Uint8Array(Math.max(need, out.length * 2));
    nb.set(out.subarray(0, size));
    out = nb;
  };
  let pos = 0;
  for (const t of decodeTokens(stream)) {
    if (t.kind === 'end') break;
    if (pos + t.length > 65536) throw new VrlError(`VRL: target beyond 65536 at offset ${t.offset}`);
    if (size < pos + t.length) { grow(pos + t.length); out.fill(0, size, pos + t.length); size = pos + t.length; }
    if (t.kind === 'lit') out.set(t.value, pos);
    else if (t.kind === 'run' || t.kind === 'lrun') out.fill(t.value, pos, pos + t.length);
    pos += t.length;
  }
  return out.slice(0, size);
}

/** U: sum of all literal, run and skip lengths. */
export function unpackedLength(stream) {
  let u = 0;
  for (const t of decodeTokens(stream)) u += t.length;
  return u;
}

/** PRG with header (spec 3); U from the stream. */
export function packFile(stream, load = 0x2000) {
  const u = unpackedLength(stream);
  checkLen(u);
  const out = new Uint8Array(7 + stream.length);
  out.set([load & 255, load >> 8, 0x56, 0x52, VERSION, u & 255, u >> 8]);
  out.set(stream, 7);
  return out;
}

/** -> {load, version, u, stream}; checks magic, version and U. */
export function unpackFile(data) {
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (d.length < 8) throw new VrlError('VRL: file too short');
  const load = d[0] | (d[1] << 8);
  if (d[2] !== 0x56 || d[3] !== 0x52) throw new VrlError('VRL: wrong magic');
  const version = d[4];
  if (version !== VERSION) throw new VrlError(`VRL: unknown version ${version}`);
  const u = d[5] | (d[6] << 8);
  let stream = d.slice(7);
  const toks = decodeTokens(stream);
  stream = stream.slice(0, toks[toks.length - 1].offset + 1);
  if (toks.reduce((a, t) => a + t.length, 0) !== u) {
    throw new VrlError('VRL: unpacked length in the header does not match the stream');
  }
  return { load, version, u, stream };
}

function params(p) {
  const r = { ...PLACEHOLDER };
  if (p) for (const k of Object.keys(p)) if (k in PLACEHOLDER) r[k] = p[k];
  return r;
}
const cpuCost = (L, p) => p.cpu_run_fixed + L * p.cpu_byte;
const fillCost = (L, p) => p.fill_fixed + L * p.fill_byte + (Math.ceil(L / 256) - 1) * p.fill_chunk;

/** Smallest L >= 2 from which block fill wins (spec 8.2); otherwise 65537. */
export function threshold(p0 = null) {
  const p = params(p0);
  if (!(p.fill_byte < p.cpu_byte)) return 65537;
  for (let L = 2; L < 65537; L++) if (fillCost(L, p) < cpuCost(L, p)) return L;
  return 65537;
}

/** `engine` object of the P0 JSON (already parsed): missing keys remain placeholders, T is taken over. */
export function benchParams(doc, name = 'bench') {
  if (!doc || typeof doc !== 'object' || typeof doc.engine !== 'object' || doc.engine === null) {
    throw new VrlError(`VRL: key "engine" missing in ${name}`);
  }
  const res = { ...PLACEHOLDER };
  for (const [k, v] of Object.entries(doc.engine)) if (k in PLACEHOLDER || k === 'T') res[k] = v;
  return res;
}

export const HIST_CLASSES = [[2, 2], [3, 4], [5, 8], [9, 16], [17, 32], [33, 64], [65, 128], [129, 256]];
const histLabel = (i) => (i === HIST_CLASSES.length ? '> 256'
  : HIST_CLASSES[i][0] === HIST_CLASSES[i][1] ? String(HIST_CLASSES[i][0]) : `${HIST_CLASSES[i][0]}-${HIST_CLASSES[i][1]}`);

/** Statistics and cycle estimate (spec 8). */
export function stats(stream, T = null, prm = null) {
  prm = prm || {};
  const p = params(prm);
  if (T === null || T === undefined) T = prm.T !== undefined && prm.T !== null ? prm.T : threshold(p);
  const tokens = { lit: 0, run: 0, lrun: 0, skip: 0 };
  const bk = { lit: 0, run_cpu: 0, run_fill: 0 };
  const hist = new Array(HIST_CLASSES.length + 1).fill(0);
  let written = 0, skipped = 0, cycles = 0;
  for (const t of decodeTokens(stream)) {
    if (t.kind === 'end') continue;
    cycles += p.tok;
    tokens[t.kind]++;
    if (t.kind === 'lit') { written += t.length; bk.lit += t.length; cycles += t.length * p.cpu_lit_byte; }
    else if (t.kind === 'skip') { skipped += t.length; cycles += p.new_addr; }
    else {
      const L = t.length;
      written += L;
      const hi = HIST_CLASSES.findIndex(([lo, h]) => lo <= L && L <= h);
      hist[hi < 0 ? hist.length - 1 : hi]++;
      if (L < T) { bk.run_cpu += L; cycles += cpuCost(L, p); }
      else { bk.run_fill += L; cycles += fillCost(L, p); }
    }
  }
  const runHist = {};
  hist.forEach((c, i) => { runHist[histLabel(i)] = c; });
  return {
    stream_bytes: stream.length,
    unpacked: written + skipped,
    written,
    skipped,
    ratio: written ? stream.length / written : null,
    tokens,
    bytes_by_kind: bk,
    run_hist: runHist,
    T,
    cycles: pyRound(cycles),
  };
}

// Python round(): half to even
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
