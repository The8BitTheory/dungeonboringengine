// Aseprite file writer (binary .aseprite, one frame) as used by dbegeom (build_aseprite), byte-identical with the
// Python writer: struct-style little-endian packing and zlib.compress(data, 9).
//
// zlibCompress is a straight port of zlib 1.3.1 deflate (deflate.c: fill_window, longest_match, deflate_slow;
// trees.c: build_tree, gen_bitlen, gen_codes, scan_tree, send_tree, compress_block, _tr_flush_block) for the
// configuration of compress2(level, windowBits 15, memLevel 8, default strategy). Levels 4 ... 9 (lazy matching)
// are supported; the output equals Python's zlib.compress byte for byte (Python links the classic zlib).
// No DOM, no Node APIs: runs unchanged in the browser.
import { adler32 } from './inflate.js';

// ---------------------------------------------------------------- deflate (zlib 1.3.1 port)

const MIN_MATCH = 3, MAX_MATCH = 258, MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const LENGTH_CODES = 29, LITERALS = 256, L_CODES = LITERALS + 1 + LENGTH_CODES, D_CODES = 30, BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1, MAX_BITS = 15, MAX_BL_BITS = 7, END_BLOCK = 256;
const REP_3_6 = 16, REPZ_3_10 = 17, REPZ_11_138 = 18, TOO_FAR = 4096, WIN_INIT = MAX_MATCH;
const EXTRA_LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const EXTRA_DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const EXTRA_BLBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const BL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// configuration_table: [good_length, max_lazy, nice_length, max_chain] for the deflate_slow levels
const CONFIG = { 4: [4, 4, 16, 16], 5: [8, 16, 32, 32], 6: [8, 16, 128, 128], 7: [8, 32, 128, 256],
  8: [32, 128, 258, 1024], 9: [32, 258, 258, 4096] };

function biReverse(code, len) {
  let res = 0;
  do { res |= code & 1; code >>>= 1; res <<= 1; } while (--len > 0);
  return res >>> 1;
}

function genCodes(fc, dl, maxCode, blCount) {
  const next = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) { code = (code + blCount[bits - 1]) << 1; next[bits] = code; }
  for (let n = 0; n <= maxCode; n++) {
    const len = dl[n];
    if (len === 0) continue;
    fc[n] = biReverse(next[len]++, len);
  }
}

const T = (() => {
  const lengthCode = new Uint8Array(256), distCode = new Uint8Array(512);
  const baseLength = new Int32Array(LENGTH_CODES), baseDist = new Int32Array(D_CODES);
  let length = 0, code;
  for (code = 0; code < LENGTH_CODES - 1; code++) {
    baseLength[code] = length;
    for (let n = 0; n < (1 << EXTRA_LBITS[code]); n++) lengthCode[length++] = code;
  }
  lengthCode[length - 1] = code;
  let dist = 0;
  for (code = 0; code < 16; code++) {
    baseDist[code] = dist;
    for (let n = 0; n < (1 << EXTRA_DBITS[code]); n++) distCode[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    baseDist[code] = dist << 7;
    for (let n = 0; n < (1 << (EXTRA_DBITS[code] - 7)); n++) distCode[256 + dist++] = code;
  }
  const sl = { fc: new Uint16Array(L_CODES + 2), dl: new Uint16Array(L_CODES + 2) };
  const blCount = new Uint16Array(MAX_BITS + 1);
  let n = 0;
  while (n <= 143) { sl.dl[n++] = 8; blCount[8]++; }
  while (n <= 255) { sl.dl[n++] = 9; blCount[9]++; }
  while (n <= 279) { sl.dl[n++] = 7; blCount[7]++; }
  while (n <= 287) { sl.dl[n++] = 8; blCount[8]++; }
  genCodes(sl.fc, sl.dl, L_CODES + 1, blCount);
  const sd = { fc: new Uint16Array(D_CODES), dl: new Uint16Array(D_CODES) };
  for (n = 0; n < D_CODES; n++) { sd.dl[n] = 5; sd.fc[n] = biReverse(n, 5); }
  return { lengthCode, distCode, baseLength, baseDist, sl, sd };
})();

const dCode = (dist) => (dist < 256 ? T.distCode[dist] : T.distCode[256 + (dist >>> 7)]);

class Tree {
  constructor(size, stat, extra, base, elems, maxLength) {
    this.fc = new Uint16Array(size);   // Freq / Code (union in C)
    this.dl = new Uint16Array(size);   // Dad / Len (union in C)
    Object.assign(this, { stat, extra, base, elems, maxLength, maxCode: 0 });
  }
}

class Deflater {
  constructor(input, level) {
    const [good, lazy, nice, chain] = CONFIG[level];
    Object.assign(this, { goodMatch: good, maxLazy: lazy, niceMatch: nice, maxChain: chain });
    this.input = input; this.inPos = 0;
    this.wBits = 15; this.wSize = 1 << 15; this.wMask = this.wSize - 1;
    this.hashBits = 15; this.hashSize = 1 << 15; this.hashMask = this.hashSize - 1;
    this.hashShift = Math.floor((this.hashBits + MIN_MATCH - 1) / MIN_MATCH);
    this.windowSize = 2 * this.wSize;
    this.window = new Uint8Array(this.windowSize + 2 * MAX_MATCH);   // margin: reads past the end stay in range
    this.prev = new Uint16Array(this.wSize);
    this.head = new Uint16Array(this.hashSize);
    this.litBufsize = 1 << (8 + 6);
    this.symEnd = (this.litBufsize - 1) * 3;
    this.symBuf = new Uint8Array(this.litBufsize * 4);
    this.symNext = 0;
    this.highWater = 0;
    this.out = []; this.outBuf = new Uint8Array(65536); this.outLen = 0;
    this.biBuf = 0; this.biValid = 0;
    this.ltree = new Tree(HEAP_SIZE, T.sl, EXTRA_LBITS, LITERALS + 1, L_CODES, MAX_BITS);
    this.dtree = new Tree(2 * D_CODES + 1, T.sd, EXTRA_DBITS, 0, D_CODES, MAX_BITS);
    this.bltree = new Tree(2 * BL_CODES + 1, null, EXTRA_BLBITS, 0, BL_CODES, MAX_BL_BITS);
    this.blCount = new Uint16Array(MAX_BITS + 1);
    this.heap = new Int32Array(2 * L_CODES + 1);
    this.depth = new Uint8Array(2 * L_CODES + 1);
    this.heapLen = 0; this.heapMax = 0;
    this.optLen = 0; this.staticLen = 0;
    this.initBlock();
    // lm_init
    this.strstart = 0; this.blockStart = 0; this.lookahead = 0; this.insert = 0;
    this.matchLength = this.prevLength = MIN_MATCH - 1; this.matchAvailable = 0; this.matchStart = 0;
    this.prevMatch = 0; this.insH = 0;
  }

  // --- output
  putByte(b) {
    if (this.outLen === this.outBuf.length) { this.out.push(this.outBuf); this.outBuf = new Uint8Array(65536); this.outLen = 0; }
    this.outBuf[this.outLen++] = b;
  }

  sendBits(value, length) {
    this.biBuf |= (value << this.biValid);
    this.biValid += length;
    while (this.biValid >= 8) { this.putByte(this.biBuf & 255); this.biBuf >>>= 8; this.biValid -= 8; }
  }

  biWindup() {
    if (this.biValid > 0) this.putByte(this.biBuf & 255);
    this.biBuf = 0; this.biValid = 0;
  }

  result() {
    this.out.push(this.outBuf.subarray(0, this.outLen));
    const n = this.out.reduce((a, b) => a + b.length, 0);
    const r = new Uint8Array(n);
    let o = 0;
    for (const b of this.out) { r.set(b, o); o += b.length; }
    return r;
  }

  // --- trees.c
  initBlock() {
    this.ltree.fc.fill(0, 0, L_CODES);
    this.dtree.fc.fill(0, 0, D_CODES);
    this.bltree.fc.fill(0, 0, BL_CODES);
    this.ltree.fc[END_BLOCK] = 1;
    this.optLen = this.staticLen = 0;
    this.symNext = 0;
  }

  smaller(fc, n, m) {
    return fc[n] < fc[m] || (fc[n] === fc[m] && this.depth[n] <= this.depth[m]);
  }

  pqdownheap(fc, k) {
    const heap = this.heap, v = heap[k];
    let j = k << 1;
    while (j <= this.heapLen) {
      if (j < this.heapLen && this.smaller(fc, heap[j + 1], heap[j])) j++;
      if (this.smaller(fc, v, heap[j])) break;
      heap[k] = heap[j]; k = j;
      j <<= 1;
    }
    heap[k] = v;
  }

  genBitlen(t) {
    const { fc, dl, maxCode, extra, base, maxLength } = t;
    const stree = t.stat, heap = this.heap, blCount = this.blCount;
    let overflow = 0, h, n, bits;
    blCount.fill(0);
    dl[heap[this.heapMax]] = 0;
    for (h = this.heapMax + 1; h < HEAP_SIZE; h++) {
      n = heap[h];
      bits = dl[dl[n]] + 1;
      if (bits > maxLength) { bits = maxLength; overflow++; }
      dl[n] = bits;
      if (n > maxCode) continue;
      blCount[bits]++;
      let xbits = 0;
      if (n >= base) xbits = extra[n - base];
      const f = fc[n];
      this.optLen += f * (bits + xbits);
      if (stree) this.staticLen += f * (stree.dl[n] + xbits);
    }
    if (overflow === 0) return;
    do {
      bits = maxLength - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxLength]--;
      overflow -= 2;
    } while (overflow > 0);
    for (bits = maxLength; bits !== 0; bits--) {
      n = blCount[bits];
      while (n !== 0) {
        const m = heap[--h];
        if (m > maxCode) continue;
        if (dl[m] !== bits) { this.optLen += (bits - dl[m]) * fc[m]; dl[m] = bits; }
        n--;
      }
    }
  }

  buildTree(t) {
    const { fc, dl, elems } = t;
    const stree = t.stat, heap = this.heap, depth = this.depth;
    let maxCode = -1, n, m, node;
    this.heapLen = 0; this.heapMax = HEAP_SIZE;
    for (n = 0; n < elems; n++) {
      if (fc[n] !== 0) { heap[++this.heapLen] = maxCode = n; depth[n] = 0; } else dl[n] = 0;
    }
    while (this.heapLen < 2) {
      node = heap[++this.heapLen] = (maxCode < 2 ? ++maxCode : 0);
      fc[node] = 1;
      depth[node] = 0;
      this.optLen--;
      if (stree) this.staticLen -= stree.dl[node];
    }
    t.maxCode = maxCode;
    for (n = this.heapLen >> 1; n >= 1; n--) this.pqdownheap(fc, n);
    node = elems;
    do {
      n = heap[1];
      heap[1] = heap[this.heapLen--];
      this.pqdownheap(fc, 1);
      m = heap[1];
      heap[--this.heapMax] = n;
      heap[--this.heapMax] = m;
      fc[node] = fc[n] + fc[m];
      depth[node] = (depth[n] >= depth[m] ? depth[n] : depth[m]) + 1;
      dl[n] = dl[m] = node;
      heap[1] = node++;
      this.pqdownheap(fc, 1);
    } while (this.heapLen >= 2);
    heap[--this.heapMax] = heap[1];
    this.genBitlen(t);
    genCodes(fc, dl, maxCode, this.blCount);
  }

  scanTree(t, maxCode) {
    const dl = t.dl, bl = this.bltree.fc;
    let prevlen = -1, curlen, nextlen = dl[0], count = 0, maxCount = 7, minCount = 4;
    if (nextlen === 0) { maxCount = 138; minCount = 3; }
    dl[maxCode + 1] = 0xFFFF;
    for (let n = 0; n <= maxCode; n++) {
      curlen = nextlen; nextlen = dl[n + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      else if (count < minCount) bl[curlen] += count;
      else if (curlen !== 0) { if (curlen !== prevlen) bl[curlen]++; bl[REP_3_6]++; }
      else if (count <= 10) bl[REPZ_3_10]++;
      else bl[REPZ_11_138]++;
      count = 0; prevlen = curlen;
      if (nextlen === 0) { maxCount = 138; minCount = 3; }
      else if (curlen === nextlen) { maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  }

  sendCode(c, t) { this.sendBits(t.fc[c], t.dl[c]); }

  sendTree(t, maxCode) {
    const dl = t.dl, bt = this.bltree;
    let prevlen = -1, curlen, nextlen = dl[0], count = 0, maxCount = 7, minCount = 4;
    if (nextlen === 0) { maxCount = 138; minCount = 3; }
    for (let n = 0; n <= maxCode; n++) {
      curlen = nextlen; nextlen = dl[n + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      else if (count < minCount) { do { this.sendCode(curlen, bt); } while (--count !== 0); }
      else if (curlen !== 0) {
        if (curlen !== prevlen) { this.sendCode(curlen, bt); count--; }
        this.sendCode(REP_3_6, bt); this.sendBits(count - 3, 2);
      } else if (count <= 10) { this.sendCode(REPZ_3_10, bt); this.sendBits(count - 3, 3); }
      else { this.sendCode(REPZ_11_138, bt); this.sendBits(count - 11, 7); }
      count = 0; prevlen = curlen;
      if (nextlen === 0) { maxCount = 138; minCount = 3; }
      else if (curlen === nextlen) { maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  }

  buildBlTree() {
    this.scanTree(this.ltree, this.ltree.maxCode);
    this.scanTree(this.dtree, this.dtree.maxCode);
    this.buildTree(this.bltree);
    let maxBlindex;
    for (maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) {
      if (this.bltree.dl[BL_ORDER[maxBlindex]] !== 0) break;
    }
    this.optLen += 3 * (maxBlindex + 1) + 5 + 5 + 4;
    return maxBlindex;
  }

  sendAllTrees(lcodes, dcodes, blcodes) {
    this.sendBits(lcodes - 257, 5);
    this.sendBits(dcodes - 1, 5);
    this.sendBits(blcodes - 4, 4);
    for (let rank = 0; rank < blcodes; rank++) this.sendBits(this.bltree.dl[BL_ORDER[rank]], 3);
    this.sendTree(this.ltree, lcodes - 1);
    this.sendTree(this.dtree, dcodes - 1);
  }

  compressBlock(lt, dt) {
    const sb = this.symBuf;
    let sx = 0;
    if (this.symNext !== 0) {
      do {
        let dist = sb[sx++];
        dist += sb[sx++] << 8;
        let lc = sb[sx++];
        if (dist === 0) this.sendBits(lt.fc[lc], lt.dl[lc]);
        else {
          let code = T.lengthCode[lc];
          this.sendBits(lt.fc[code + LITERALS + 1], lt.dl[code + LITERALS + 1]);
          let extra = EXTRA_LBITS[code];
          if (extra !== 0) { lc -= T.baseLength[code]; this.sendBits(lc, extra); }
          dist--;
          code = dCode(dist);
          this.sendBits(dt.fc[code], dt.dl[code]);
          extra = EXTRA_DBITS[code];
          if (extra !== 0) { dist -= T.baseDist[code]; this.sendBits(dist, extra); }
        }
      } while (sx < this.symNext);
    }
    this.sendBits(lt.fc[END_BLOCK], lt.dl[END_BLOCK]);
  }

  storedBlock(start, storedLen, last) {
    this.sendBits((0 << 1) + last, 3);
    this.biWindup();
    this.putByte(storedLen & 255); this.putByte((storedLen >> 8) & 255);
    this.putByte(~storedLen & 255); this.putByte((~storedLen >> 8) & 255);
    for (let i = 0; i < storedLen; i++) this.putByte(this.window[start + i]);
  }

  flushBlock(last) {
    const buf = this.blockStart >= 0 ? this.blockStart : -1;
    const storedLen = this.strstart - this.blockStart;
    this.buildTree(this.ltree);
    this.buildTree(this.dtree);
    const maxBlindex = this.buildBlTree();
    let optLenb = (this.optLen + 3 + 7) >>> 3;
    const staticLenb = (this.staticLen + 3 + 7) >>> 3;
    if (staticLenb <= optLenb) optLenb = staticLenb;
    if (storedLen + 4 <= optLenb && buf !== -1) this.storedBlock(buf, storedLen, last);
    else if (staticLenb === optLenb) {
      this.sendBits((1 << 1) + last, 3);
      this.compressBlock(T.sl, T.sd);
    } else {
      this.sendBits((2 << 1) + last, 3);
      this.sendAllTrees(this.ltree.maxCode + 1, this.dtree.maxCode + 1, maxBlindex + 1);
      this.compressBlock(this.ltree, this.dtree);
    }
    this.initBlock();
    if (last) this.biWindup();
    this.blockStart = this.strstart;
  }

  tallyLit(c) {
    const sb = this.symBuf;
    sb[this.symNext++] = 0; sb[this.symNext++] = 0; sb[this.symNext++] = c;
    this.ltree.fc[c]++;
    return this.symNext === this.symEnd;
  }

  tallyDist(dist, len) {
    const sb = this.symBuf;
    sb[this.symNext++] = dist & 255; sb[this.symNext++] = (dist >>> 8) & 255; sb[this.symNext++] = len;
    dist--;
    this.ltree.fc[T.lengthCode[len] + LITERALS + 1]++;
    this.dtree.fc[dCode(dist)]++;
    return this.symNext === this.symEnd;
  }

  // --- deflate.c
  updateHash(h, c) { return ((h << this.hashShift) ^ c) & this.hashMask; }

  insertString(str) {
    this.insH = this.updateHash(this.insH, this.window[str + MIN_MATCH - 1]);
    const mh = this.prev[str & this.wMask] = this.head[this.insH];
    this.head[this.insH] = str;
    return mh;
  }

  slideHash() {
    const w = this.wSize;
    for (let i = 0; i < this.hashSize; i++) { const m = this.head[i]; this.head[i] = m >= w ? m - w : 0; }
    for (let i = 0; i < w; i++) { const m = this.prev[i]; this.prev[i] = m >= w ? m - w : 0; }
  }

  fillWindow() {
    const wsize = this.wSize, win = this.window;
    do {
      let more = this.windowSize - this.lookahead - this.strstart;
      if (this.strstart >= wsize + (wsize - MIN_LOOKAHEAD)) {
        win.copyWithin(0, wsize, wsize + wsize - more);
        this.matchStart -= wsize;
        this.strstart -= wsize;
        this.blockStart -= wsize;
        if (this.insert > this.strstart) this.insert = this.strstart;
        this.slideHash();
        more += wsize;
      }
      const avail = this.input.length - this.inPos;
      if (avail === 0) break;
      const n = Math.min(avail, more);
      win.set(this.input.subarray(this.inPos, this.inPos + n), this.strstart + this.lookahead);
      this.inPos += n;
      this.lookahead += n;
      if (this.lookahead + this.insert >= MIN_MATCH) {
        let str = this.strstart - this.insert;
        this.insH = win[str];
        this.insH = this.updateHash(this.insH, win[str + 1]);
        while (this.insert) {
          this.insH = this.updateHash(this.insH, win[str + MIN_MATCH - 1]);
          this.prev[str & this.wMask] = this.head[this.insH];
          this.head[this.insH] = str;
          str++;
          this.insert--;
          if (this.lookahead + this.insert < MIN_MATCH) break;
        }
      }
    } while (this.lookahead < MIN_LOOKAHEAD && this.inPos < this.input.length);
    if (this.highWater < this.windowSize) {
      const curr = this.strstart + this.lookahead;
      let init;
      if (this.highWater < curr) {
        init = Math.min(this.windowSize - curr, WIN_INIT);
        win.fill(0, curr, curr + init);
        this.highWater = curr + init;
      } else if (this.highWater < curr + WIN_INIT) {
        init = Math.min(curr + WIN_INIT - this.highWater, this.windowSize - this.highWater);
        win.fill(0, this.highWater, this.highWater + init);
        this.highWater += init;
      }
    }
  }

  longestMatch(curMatch) {
    const win = this.window, prev = this.prev, wmask = this.wMask;
    let chainLength = this.maxChain;
    const scan = this.strstart;
    let bestLen = this.prevLength;
    let niceMatch = this.niceMatch;
    const maxDist = this.wSize - MIN_LOOKAHEAD;
    const limit = this.strstart > maxDist ? this.strstart - maxDist : 0;
    let scanEnd1 = win[scan + bestLen - 1], scanEnd = win[scan + bestLen];
    if (this.prevLength >= this.goodMatch) chainLength >>>= 2;
    if (niceMatch > this.lookahead) niceMatch = this.lookahead;
    do {
      const match = curMatch;
      if (win[match + bestLen] !== scanEnd || win[match + bestLen - 1] !== scanEnd1
        || win[match] !== win[scan] || win[match + 1] !== win[scan + 1]) continue;
      // scan[2] and match[2] are not compared (equal by the hash), as in zlib
      let p = 3;
      while (p < MAX_MATCH && win[scan + p] === win[match + p]) p++;
      const len = p;
      if (len > bestLen) {
        this.matchStart = curMatch;
        bestLen = len;
        if (len >= niceMatch) break;
        scanEnd1 = win[scan + bestLen - 1];
        scanEnd = win[scan + bestLen];
      }
    } while ((curMatch = prev[curMatch & wmask]) > limit && --chainLength !== 0);
    return bestLen <= this.lookahead ? bestLen : this.lookahead;
  }

  deflateSlow() {
    const maxDist = this.wSize - MIN_LOOKAHEAD;
    for (;;) {
      if (this.lookahead < MIN_LOOKAHEAD) {
        this.fillWindow();
        if (this.lookahead === 0) break;
      }
      let hashHead = 0;
      if (this.lookahead >= MIN_MATCH) hashHead = this.insertString(this.strstart);
      this.prevLength = this.matchLength; this.prevMatch = this.matchStart;
      this.matchLength = MIN_MATCH - 1;
      if (hashHead !== 0 && this.prevLength < this.maxLazy && this.strstart - hashHead <= maxDist) {
        this.matchLength = this.longestMatch(hashHead);
        if (this.matchLength <= 5 && this.matchLength === MIN_MATCH && this.strstart - this.matchStart > TOO_FAR) {
          this.matchLength = MIN_MATCH - 1;
        }
      }
      if (this.prevLength >= MIN_MATCH && this.matchLength <= this.prevLength) {
        const maxInsert = this.strstart + this.lookahead - MIN_MATCH;
        const bflush = this.tallyDist(this.strstart - 1 - this.prevMatch, this.prevLength - MIN_MATCH);
        this.lookahead -= this.prevLength - 1;
        this.prevLength -= 2;
        do {
          if (++this.strstart <= maxInsert) this.insertString(this.strstart);
        } while (--this.prevLength !== 0);
        this.matchAvailable = 0;
        this.matchLength = MIN_MATCH - 1;
        this.strstart++;
        if (bflush) this.flushBlock(0);
      } else if (this.matchAvailable) {
        if (this.tallyLit(this.window[this.strstart - 1])) this.flushBlock(0);
        this.strstart++;
        this.lookahead--;
      } else {
        this.matchAvailable = 1;
        this.strstart++;
        this.lookahead--;
      }
    }
    if (this.matchAvailable) {
      this.tallyLit(this.window[this.strstart - 1]);
      this.matchAvailable = 0;
    }
    this.insert = this.strstart < MIN_MATCH - 1 ? this.strstart : MIN_MATCH - 1;
    this.flushBlock(1);
  }
}

/** Uint8Array -> zlib stream, identical with zlib's compress2(data, level) (levels 4 ... 9). */
export function zlibCompress(data, level = 9) {
  if (!CONFIG[level]) throw new RangeError(`zlibCompress: level ${level} not supported (4 ... 9)`);
  const s = new Deflater(data, level);
  const levelFlags = level === 6 ? 2 : level > 6 ? 3 : 1;
  let header = (8 + ((s.wBits - 8) << 4)) << 8;
  header |= levelFlags << 6;
  header += 31 - (header % 31);
  s.putByte(header >> 8); s.putByte(header & 255);
  s.deflateSlow();
  const ad = adler32(data);
  s.putByte(ad >>> 24); s.putByte((ad >>> 16) & 255); s.putByte((ad >>> 8) & 255); s.putByte(ad & 255);
  return s.result();
}

// ---------------------------------------------------------------- struct-style packing

/** Little-endian byte builder (struct.pack with '<'). Values out of range throw like struct.error. */
export class ByteWriter {
  constructor() { this.parts = []; this.length = 0; }

  push(b) { this.parts.push(b); this.length += b.length; return this; }

  int(v, size, signed) {
    const bits = BigInt(size * 8);
    const lo = signed ? -(1n << (bits - 1n)) : 0n, hi = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    let x = BigInt(v);
    if (x < lo || x > hi) {
      throw new RangeError(signed ? `argument out of range (${size}-byte signed)` : `argument out of range (${size}-byte unsigned)`);
    }
    if (x < 0n) x += 1n << bits;
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) { b[i] = Number(x & 255n); x >>= 8n; }
    return this.push(b);
  }

  u8(v) { return this.int(v, 1, false); }
  u16(v) { return this.int(v, 2, false); }
  i16(v) { return this.int(v, 2, true); }
  u32(v) { return this.int(v, 4, false); }
  i32(v) { return this.int(v, 4, true); }
  zeros(n) { return this.push(new Uint8Array(n)); }
  bytes(b) { return this.push(b instanceof Uint8Array ? b : Uint8Array.from(b)); }

  /** Aseprite STRING: WORD length + UTF-8 bytes. */
  str(s) { const b = new TextEncoder().encode(s); this.u16(b.length); return this.push(b); }

  toBytes() {
    const r = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { r.set(p, o); o += p.length; }
    return r;
  }
}

const bw = () => new ByteWriter();

// ---------------------------------------------------------------- Aseprite chunks

/** Chunk: DWORD size (6 + data), WORD type, data. */
export function chunk(ctype, data) { return bw().u32(6 + data.length).u16(ctype).bytes(data).toBytes(); }

/** 0x2007 color profile: type 1 (sRGB), flags 0, gamma 0, 8 reserved bytes. */
export function colorProfileChunk() { return chunk(0x2007, bw().u16(1).u16(0).i32(0).zeros(8).toBytes()); }

/** 0x2019 palette: entries [r, g, b, a] (no names). */
export function paletteChunk(entries) {
  const w = bw().u32(entries.length).u32(0).u32(entries.length - 1).u32(0).zeros(8);
  for (const [r, g, b, a] of entries) w.u16(0).u8(r).u8(g).u8(b).u8(a);
  return chunk(0x2019, w.toBytes());
}

/** 0x2004 layer: flags, type 0, child level 0, default size 0 x 0, blend 0, opacity, name. */
export function layerChunk(flags, opacity, name) {
  return chunk(0x2004, bw().u16(flags).u16(0).u16(0).u16(0).u16(0).u16(0).u8(opacity).zeros(3).str(name).toBytes());
}

/** 0x2005 cel, type 2 (compressed image): layer, x, y, opacity 255, w, h, indexed pixels (zlib level 9). */
export function compressedCelChunk(layer, x, y, w, h, pixels) {
  return chunk(0x2005, bw().u16(layer).i16(x).i16(y).u8(255).u16(2).zeros(7).u16(w).u16(h)
    .bytes(zlibCompress(pixels, 9)).toBytes());
}

/** 0x2022 slice with one key (frame 0); nine = [cx, cy, cw, ch] or null. */
export function sliceChunk(name, x, y, w, h, nine = null) {
  const s = bw().u32(1).u32(nine ? 1 : 0).i32(0).str(name).u32(0).i32(x).i32(y).u32(w).u32(h);
  if (nine) s.i32(nine[0]).i32(nine[1]).u32(nine[2]).u32(nine[3]);
  return chunk(0x2022, s.toBytes());
}

/** 0x2020 user data with text. */
export function userDataChunk(text) { return chunk(0x2020, bw().u32(1).str(text).toBytes()); }

/** Whole file: header 128 bytes, one frame (duration 100 ms) with the chunks. */
export function aseFile(width, height, chunks, { depth = 8, transparent = 16, ncolors = 17, gridW = 16, gridH = 16 } = {}) {
  const n = chunks.length;
  const body = bw();
  for (const c of chunks) body.bytes(c);
  const frame = bw().u32(16 + body.length).u16(0xF1FA).u16(n > 65534 ? 0xFFFF : n).u16(100).zeros(2).u32(n)
    .bytes(body.toBytes()).toBytes();
  const head = bw().u32(128 + frame.length).u16(0xA5E0).u16(1).u16(width).u16(height).u16(depth).u32(1).u16(100)
    .u32(0).u32(0).u8(transparent).zeros(3).u16(ncolors).u8(1).u8(1).i16(0).i16(0).u16(gridW).u16(gridH).zeros(84);
  if (head.length !== 128) throw new Error('aseprite header: wrong size');
  return bw().bytes(head.toBytes()).bytes(frame).toBytes();
}
