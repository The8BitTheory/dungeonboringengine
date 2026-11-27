// zlib (RFC 1950) / deflate (RFC 1951) in plain JS, synchronous, identical in browser and Node.
// inflate: full decoder (stored, fixed and dynamic Huffman blocks).
// deflate: stored blocks only (valid zlib streams; used for the PNG encoder, size does not matter there).

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class InflateError extends Error {}

function buildHuffman(lengths) {
  // canonical Huffman: counts per length and symbols sorted by code
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.bit = 0; this.cnt = 0; }
  need(n) {
    while (this.cnt < n) {
      if (this.pos >= this.buf.length) throw new InflateError('inflate: unexpected end of data');
      this.bit |= this.buf[this.pos++] << this.cnt;
      this.cnt += 8;
    }
  }
  bits(n) {
    if (n === 0) return 0;
    this.need(n);
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.cnt -= n;
    return v;
  }
  decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError('inflate: invalid Huffman code');
  }
  align() { this.bit = 0; this.cnt = 0; }
}

let FIXED = null;
function fixedTables() {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED = { lit: buildHuffman(l), dist: buildHuffman(new Uint8Array(30).fill(5)) };
  }
  return FIXED;
}

/** Raw deflate data -> Uint8Array. */
export function inflateRaw(data) {
  const br = new BitReader(data);
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let n = 0;
  const ensure = (k) => {
    if (n + k <= out.length) return;
    let sz = out.length * 2;
    while (sz < n + k) sz *= 2;
    const nb = new Uint8Array(sz);
    nb.set(out.subarray(0, n));
    out = nb;
  };
  let last;
  do {
    last = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      if (br.pos + 4 > data.length) throw new InflateError('inflate: unexpected end of data');
      const len = data[br.pos] | (data[br.pos + 1] << 8);
      const nlen = data[br.pos + 2] | (data[br.pos + 3] << 8);
      if ((len ^ 0xFFFF) !== nlen) throw new InflateError('inflate: stored block length mismatch');
      br.pos += 4;
      if (br.pos + len > data.length) throw new InflateError('inflate: unexpected end of data');
      ensure(len);
      out.set(data.subarray(br.pos, br.pos + len), n);
      n += len;
      br.pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) ({ lit, dist } = fixedTables());
    else if (type === 2) {
      const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = br.bits(3);
      const clh = buildHuffman(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = br.decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep, val = 0;
          if (sym === 16) {
            if (i === 0) throw new InflateError('inflate: repeat without previous length');
            val = lens[i - 1]; rep = 3 + br.bits(2);
          } else if (sym === 17) rep = 3 + br.bits(3);
          else rep = 11 + br.bits(7);
          if (i + rep > hlit + hdist) throw new InflateError('inflate: too many code lengths');
          lens.fill(val, i, i + rep);
          i += rep;
        }
      }
      lit = buildHuffman(lens.subarray(0, hlit));
      dist = buildHuffman(lens.subarray(hlit));
    } else throw new InflateError('inflate: invalid block type');
    for (;;) {
      const sym = br.decode(lit);
      if (sym < 256) { ensure(1); out[n++] = sym; }
      else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError('inflate: invalid length code');
        const len = LBASE[li] + br.bits(LEXT[li]);
        const di = br.decode(dist);
        if (di >= 30) throw new InflateError('inflate: invalid distance code');
        const d = DBASE[di] + br.bits(DEXT[di]);
        if (d > n) throw new InflateError('inflate: distance too far back');
        ensure(len);
        for (let k = 0; k < len; k++, n++) out[n] = out[n - d];
      }
    }
  } while (!last);
  return out.slice(0, n);
}

export function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream -> Uint8Array (header and Adler-32 checked). */
export function inflate(data) {
  if (data.length < 6) throw new InflateError('zlib: data too short');
  const cmf = data[0], flg = data[1];
  if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31) throw new InflateError('zlib: invalid header');
  if (flg & 32) throw new InflateError('zlib: preset dictionary not supported');
  const out = inflateRaw(data.subarray(2));
  return out;
}

/** Uint8Array -> zlib stream with stored blocks. */
export function deflate(data) {
  const nblk = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + 5 * nblk + 4);
  out[0] = 0x78; out[1] = 0x01;
  let p = 2;
  for (let b = 0; b < nblk; b++) {
    const s = b * 65535, len = Math.min(65535, data.length - s);
    out[p++] = b === nblk - 1 ? 1 : 0;
    out[p++] = len & 255; out[p++] = len >> 8;
    out[p++] = ~len & 255; out[p++] = (~len >> 8) & 255;
    out.set(data.subarray(s, s + len), p);
    p += len;
  }
  const ad = adler32(data);
  out[p++] = ad >>> 24; out[p++] = (ad >>> 16) & 255; out[p++] = (ad >>> 8) & 255; out[p++] = ad & 255;
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
