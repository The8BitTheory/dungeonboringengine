// Python's random.Random (Mersenne Twister MT19937) bit for bit, for parity with the Python tools
// (dbeview random scenes, crawl01, tests). Integer seeds only (as used in the repo).
// Methods: random, getrandbits, randrange, randint, choice, sample.

const N = 624, M = 397;

export class PyRandom {
  constructor(seed = 0) {
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    this.seed(seed);
  }

  _initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
    }
    this.mti = N;
  }

  _initByArray(key) {
    const mt = this.mt;
    this._initGenrand(19650218);
    let i = 1, j = 0;
    const kl = key.length;
    for (let k = Math.max(N, kl); k; k--) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= kl) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  seed(seed) {
    let s = BigInt(seed);
    if (s < 0n) s = -s;
    const key = [];
    if (s === 0n) key.push(0);
    while (s > 0n) { key.push(Number(s & 0xFFFFFFFFn)); s >>= 32n; }
    this._initByArray(key);
  }

  _genrand() {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0, y;
      for (; kk < N - M; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random() {
    const a = this._genrand() >>> 5, b = this._genrand() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  // k <= 53 returns a Number, larger k a BigInt (as Python's int would be)
  getrandbits(k) {
    if (k < 0) throw new RangeError('number of bits must be non-negative');
    if (k === 0) return 0;
    if (k <= 32) return this._genrand() >>> (32 - k);
    let r = 0n, shift = 0n, left = k;
    while (left > 0) {
      let w = this._genrand();
      if (left < 32) w >>>= (32 - left);
      r |= BigInt(w) << shift;
      shift += 32n;
      left -= 32;
    }
    return k <= 53 ? Number(r) : r;
  }

  _randbelow(n) {
    if (n <= 0) throw new RangeError('empty range');
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(start, stop, step = 1) {
    if (stop === undefined) {
      if (start > 0) return this._randbelow(start);
      throw new RangeError('empty range for randrange()');
    }
    const width = stop - start;
    if (step === 1) {
      if (width > 0) return start + this._randbelow(width);
      throw new RangeError(`empty range in randrange(${start}, ${stop})`);
    }
    let n;
    if (step > 0) n = Math.floor((width + step - 1) / step);
    else if (step < 0) n = Math.floor((width + step + 1) / step);
    else throw new RangeError('zero step for randrange()');
    if (n <= 0) throw new RangeError('empty range for randrange()');
    return start + step * this._randbelow(n);
  }

  randint(a, b) { return this.randrange(a, b + 1); }

  choice(seq) {
    if (!seq.length) throw new RangeError('Cannot choose from an empty sequence');
    return seq[this._randbelow(seq.length)];
  }

  sample(population, k) {
    const pop = Array.from(population);
    const n = pop.length;
    if (k < 0 || k > n) throw new RangeError('Sample larger than population or is negative');
    const result = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = pop.slice();
      for (let i = 0; i < k; i++) {
        const j = this._randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set();
      for (let i = 0; i < k; i++) {
        let j = this._randbelow(n);
        while (selected.has(j)) j = this._randbelow(n);
        selected.add(j);
        result[i] = pop[j];
      }
    }
    return result;
  }
}

function bitLength(n) {
  let k = 0;
  while (n > 0) { k++; n = Math.floor(n / 2); }
  return k;
}
