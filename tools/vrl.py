#!/usr/bin/env python3
"""VRL: RLE stream for `RXV` (VDC-BASIC v3) - encoder, decoder, statistics.

Stream (tokens; words low/high):
  $00            end
  $01-$7F  n bytes   n literals (1..127)
  $80-$FD  v         run: L = b-$80+2 (2..127) times v
  $FE      lo hi     skip: advance the target by n (0 = 65536), write nothing
  $FF      lo hi v   long run: L = hi*256+lo (0 = 65536) times v
File frame (PRG): load address (2), "VR", version 1, unpacked length U (word), stream.
Skips at the end of the stream are not encoded; U <= 65535. Details: docs/specs/P1-vrl.md,
docs/formats.md (VRL v1).

Usage:
  vrl.py encode IN OUT [--load ADDR] [--raw] [--in-prg]
  vrl.py rect   IN OUT --width W --height H --stride S [--mask MASK] [--load ADDR] [--raw] [--in-prg]
  vrl.py decode IN OUT [--raw] [--base BASE] [--out-prg ADDR]
  vrl.py stats  IN [--raw] [-T N] [--bench P0.json] [--json]
Exit code: 0 ok, 1 format error, 2 wrong usage.
"""
import argparse
import collections
import json
import struct
import sys

SKIP = None
VERSION = 1
MAX_U = 65535

Token = collections.namedtuple("Token", "kind length value offset")

PLACEHOLDER = {
    "tok": 30, "cpu_lit_byte": 22, "cpu_byte": 15, "cpu_run_fixed": 10,
    "new_addr": 80, "fill_fixed": 200, "fill_byte": 1, "fill_chunk": 30,
}


def _check_len(n):
    if n > MAX_U:
        raise ValueError("VRL: unpacked length exceeds 65535")


def encode(data):
    """Sequence of int | None -> stream (incl. $00), size-optimal (spec 4.2)."""
    seq = list(data)
    for v in seq:
        if v is not None and not (isinstance(v, int) and 0 <= v <= 255):
            raise ValueError("VRL: value outside 0..255: %r" % (v,))
    while seq and seq[-1] is None:      # skips at the end are dropped
        seq.pop()
    n = len(seq)
    _check_len(n)

    # helper tables backwards in O(n)
    skip = [0] * (n + 1)    # length of the skip stretch from i
    rep = [0] * (n + 1)     # length of the repetition of equal values from i (no SKIP)
    lit = [0] * (n + 1)     # longest stretch without SKIP from i
    for i in range(n - 1, -1, -1):
        v = seq[i]
        if v is None:
            skip[i] = skip[i + 1] + 1
        else:
            lit[i] = lit[i + 1] + 1
            rep[i] = rep[i + 1] + 1 if (i + 1 < n and seq[i + 1] == v) else 1

    # best[i] = bytes << 20 | tokens (bytes first, then token count).
    # Candidate key per target position j (best << 16 | 65535 - j): smaller = better, on a
    # tie greater j = more coverage. Runs (fixed cost 2) and literals (cost
    # 1 + m = 1 + j - i, hence best[j] + j*UNIT) are kept in separate arrays so that the
    # minimum search over a slice runs in C (O(n * 127) without a Python loop per candidate).
    UNIT = 1 << 20
    INF = 1 << 60
    best = [INF] * (n + 1)
    key_run = [INF << 16] * (n + 1)
    key_lit = [INF << 16] * (n + 1)
    choice = [None] * (n + 1)   # (kind, length)

    def publish(j, val):
        best[j] = val
        key_run[j] = (val << 16) | (65535 - j)
        key_lit[j] = ((val + j * UNIT) << 16) | (65535 - j)

    publish(n, 0)
    MASK = 0xFFFF
    for i in range(n - 1, -1, -1):
        if skip[i]:
            k = skip[i]
            publish(i, best[i + k] + 3 * UNIT + 1)
            choice[i] = ("skip", k)
            continue
        R = rep[i]
        cands = []      # (bytes+tokens, -coverage, kind 0 = run / 1 = literal, kind, length)
        if R >= 2:
            kk = min(key_run[i + 2:i + min(127, R) + 1])
            L = 65535 - (kk & MASK) - i
            cands.append((best[i + L] + 2 * UNIT + 1, -L, 0, "run", L))
        if R > 127:
            cands.append((best[i + R] + 4 * UNIT + 1, -R, 0, "run", R))
        kk = min(key_lit[i + 1:i + min(127, lit[i]) + 1])
        m = 65535 - (kk & MASK) - i
        cands.append((best[i + m] + (1 + m) * UNIT + 1, -m, 1, "lit", m))
        c = min(cands)
        publish(i, c[0])
        choice[i] = (c[3], c[4])

    out = bytearray()
    i = 0
    while i < n:
        kind, L = choice[i]
        if kind == "skip":
            out += bytes((0xFE, L & 255, L >> 8))
        elif kind == "run":
            if L <= 127:
                out += bytes((0x80 + L - 2, seq[i]))
            else:
                out += bytes((0xFF, L & 255, L >> 8, seq[i]))
        else:
            out.append(L)
            out += bytes(seq[i:i + L])
        i += L
    out.append(0)
    return bytes(out)


def encode_rect(data, width, height, stride, mask=None):
    """Encode a rectangle width x height with stride (and optional mask) (spec 4.5)."""
    if width < 1 or height < 1 or stride < width:
        raise ValueError("VRL: invalid rectangle geometry")
    if stride > 65535:
        raise ValueError("VRL: stride exceeds 65535")
    data = list(data)
    if len(data) != width * height:
        raise ValueError("VRL: data length does not match width x height")
    if mask is not None:
        mask = list(mask)
        if len(mask) != len(data):
            raise ValueError("VRL: mask length does not match width x height")
    # target sequence only up to past the last written byte (skips at the end are dropped anyway),
    # so that it stays small with a large stride and an almost empty mask.
    last = len(data) - 1 if mask is None else max((k for k, m in enumerate(mask) if m), default=-1)
    total = 0 if last < 0 else (last // width) * stride + last % width + 1
    _check_len(total)
    seq = [SKIP] * total
    for k in range(last + 1):
        if mask is None or mask[k]:
            seq[(k // width) * stride + k % width] = data[k]
    return encode(seq)


def decode_tokens(stream):
    """Tokens up to and including the end as a list of Token(kind, length, value, offset)."""
    s = bytes(stream)
    toks = []
    p = 0
    n = len(s)
    while True:
        if p >= n:
            raise ValueError("VRL: unexpected end at offset %d" % p)
        b = s[p]
        if b == 0:
            toks.append(Token("end", 0, None, p))
            return toks
        if b <= 0x7F:
            if p + 1 + b > n:
                raise ValueError("VRL: literal beyond the end of the stream at offset %d" % p)
            toks.append(Token("lit", b, s[p + 1:p + 1 + b], p))
            p += 1 + b
        elif b <= 0xFD:
            if p + 2 > n:
                raise ValueError("VRL: run beyond the end of the stream at offset %d" % p)
            toks.append(Token("run", b - 0x80 + 2, s[p + 1], p))
            p += 2
        elif b == 0xFE:
            if p + 3 > n:
                raise ValueError("VRL: skip beyond the end of the stream at offset %d" % p)
            toks.append(Token("skip", (s[p + 1] | s[p + 2] << 8) or 65536, None, p))
            p += 3
        else:
            if p + 4 > n:
                raise ValueError("VRL: long run beyond the end of the stream at offset %d" % p)
            toks.append(Token("lrun", (s[p + 1] | s[p + 2] << 8) or 65536, s[p + 3], p))
            p += 4


def decode(stream, base=None):
    """Execute the stream; copy of base (extended with 0 if needed), skips leave base unchanged."""
    out = bytearray(base) if base is not None else bytearray()
    pos = 0
    for t in decode_tokens(stream):
        if t.kind == "end":
            break
        if pos + t.length > 65536:
            raise ValueError("VRL: target beyond 65536 at offset %d" % t.offset)
        if len(out) < pos + t.length:
            out.extend(bytes(pos + t.length - len(out)))
        if t.kind == "lit":
            out[pos:pos + t.length] = t.value
        elif t.kind in ("run", "lrun"):
            out[pos:pos + t.length] = bytes((t.value,)) * t.length
        pos += t.length
    return out


def unpacked_length(stream):
    """U: sum of all literal, run and skip lengths."""
    return sum(t.length for t in decode_tokens(stream))


def pack_file(stream, load=0x2000):
    """PRG with header (spec 3); U from the stream."""
    u = unpacked_length(stream)
    _check_len(u)
    return struct.pack("<H", load) + b"VR" + bytes((VERSION,)) + struct.pack("<H", u) + bytes(stream)


def unpack_file(data):
    """-> (load, version, U, stream); checks magic, version and U."""
    data = bytes(data)
    if len(data) < 8:
        raise ValueError("VRL: file too short")
    load, = struct.unpack_from("<H", data, 0)
    if data[2:4] != b"VR":
        raise ValueError("VRL: wrong magic")
    version = data[4]
    if version != VERSION:
        raise ValueError("VRL: unknown version %d" % version)
    u, = struct.unpack_from("<H", data, 5)
    stream = data[7:]
    toks = decode_tokens(stream)
    stream = stream[:toks[-1].offset + 1]
    if sum(t.length for t in toks) != u:
        raise ValueError("VRL: unpacked length in the header does not match the stream")
    return load, version, u, stream


def _params(params):
    p = dict(PLACEHOLDER)
    if params:
        p.update({k: v for k, v in params.items() if k in PLACEHOLDER})
    return p


def _cpu_cost(L, p):
    return p["cpu_run_fixed"] + L * p["cpu_byte"]


def _fill_cost(L, p):
    return p["fill_fixed"] + L * p["fill_byte"] + (-(-L // 256) - 1) * p["fill_chunk"]


def threshold(params=None):
    """Smallest L >= 2 from which block fill wins (spec 8.2); otherwise 65537."""
    p = _params(params)
    if not p["fill_byte"] < p["cpu_byte"]:
        return 65537
    for L in range(2, 65537):
        if _fill_cost(L, p) < _cpu_cost(L, p):
            return L
    return 65537


def load_bench(path):
    """Read `engine` from the P0 JSON; missing keys remain placeholders, T is taken over."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or not isinstance(doc.get("engine"), dict):
        raise ValueError("VRL: key \"engine\" missing in %s" % path)
    eng = doc["engine"]
    res = dict(PLACEHOLDER)
    for k, v in eng.items():
        if k in PLACEHOLDER or k == "T":
            res[k] = v
    return res


HIST_CLASSES = [(2, 2), (3, 4), (5, 8), (9, 16), (17, 32), (33, 64), (65, 128), (129, 256)]


def _hist_label(i):
    return "> 256" if i == len(HIST_CLASSES) else (
        str(HIST_CLASSES[i][0]) if HIST_CLASSES[i][0] == HIST_CLASSES[i][1]
        else "%d-%d" % HIST_CLASSES[i])


def stats(stream, T=None, params=None):
    """Statistics and cycle estimate (spec 8)."""
    params = params or {}
    p = _params(params)
    if T is None:
        T = params.get("T") if params.get("T") is not None else threshold(p)
    toks = decode_tokens(stream)
    tokens = {"lit": 0, "run": 0, "lrun": 0, "skip": 0}
    bk = {"lit": 0, "run_cpu": 0, "run_fill": 0}
    hist = [0] * (len(HIST_CLASSES) + 1)
    written = skipped = 0
    cycles = 0
    for t in toks:
        if t.kind == "end":
            continue
        cycles += p["tok"]
        tokens[t.kind] += 1
        if t.kind == "lit":
            written += t.length
            bk["lit"] += t.length
            cycles += t.length * p["cpu_lit_byte"]
        elif t.kind == "skip":
            skipped += t.length
            cycles += p["new_addr"]
        else:
            L = t.length
            written += L
            for i, (lo, hi) in enumerate(HIST_CLASSES):
                if lo <= L <= hi:
                    hist[i] += 1
                    break
            else:
                hist[-1] += 1
            if L < T:
                bk["run_cpu"] += L
                cycles += _cpu_cost(L, p)
            else:
                bk["run_fill"] += L
                cycles += _fill_cost(L, p)
    return {
        "stream_bytes": len(stream),
        "unpacked": written + skipped,
        "written": written,
        "skipped": skipped,
        "ratio": len(stream) / written if written else None,
        "tokens": tokens,
        "bytes_by_kind": bk,
        "run_hist": {_hist_label(i): c for i, c in enumerate(hist)},
        "T": T,
        "cycles": int(round(cycles)),
    }


# ---------------------------------------------------------------- CLI

def _addr(s):
    s = s.strip()
    v = int(s[1:], 16) if s.startswith("$") else int(s, 0)
    if not 0 <= v <= 0xFFFF:
        raise argparse.ArgumentTypeError("Address outside 0..65535: " + s)
    return v


def _read(path, skip_prg=False):
    with open(path, "rb") as f:
        d = f.read()
    if skip_prg:
        if len(d) < 2:
            raise ValueError("VRL: PRG input without load address")
        d = d[2:]
    return d


def _write(path, data):
    with open(path, "wb") as f:
        f.write(data)


def _stream_in(args):
    d = _read(args.IN)
    return d if args.raw else unpack_file(d)[3]


def _emit(args, stream):
    _write(args.OUT, stream if args.raw else pack_file(stream, args.load))


def _cmd_encode(a):
    _emit(a, encode(_read(a.IN, a.in_prg)))


def _cmd_rect(a):
    mask = _read(a.mask) if a.mask else None
    _emit(a, encode_rect(_read(a.IN, a.in_prg), a.width, a.height, a.stride, mask))


def _cmd_decode(a):
    base = _read(a.base) if a.base else None
    out = decode(_stream_in(a), base)
    if a.out_prg is not None:
        out = struct.pack("<H", a.out_prg) + bytes(out)
    _write(a.OUT, bytes(out))


def _cmd_stats(a):
    params = load_bench(a.bench) if a.bench else None
    st = stats(_stream_in(a), a.T, params)
    if a.json:
        print(json.dumps(st, indent=2))
        return
    for k in ("stream_bytes", "unpacked", "written", "skipped"):
        print("%-14s %d" % (k, st[k]))
    print("%-14s %s" % ("ratio", "-" if st["ratio"] is None else "%.3f" % st["ratio"]))
    print("%-14s %s" % ("tokens", "  ".join("%s=%d" % kv for kv in st["tokens"].items())))
    print("%-14s %s" % ("bytes_by_kind", "  ".join("%s=%d" % kv for kv in st["bytes_by_kind"].items())))
    print("run_hist")
    for k, v in st["run_hist"].items():
        print("  %-8s %d" % (k, v))
    print("%-14s %d" % ("T", st["T"]))
    print("%-14s %d" % ("cycles", st["cycles"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description="VRL tool (RLE stream for RXV)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, out=True):
        p.add_argument("IN")
        if out:
            p.add_argument("OUT")

    def enc_opts(p):
        p.add_argument("--load", type=_addr, default=0x2000)
        p.add_argument("--raw", action="store_true")
        p.add_argument("--in-prg", action="store_true")

    p = sub.add_parser("encode"); common(p); enc_opts(p); p.set_defaults(fn=_cmd_encode)
    p = sub.add_parser("rect"); common(p); enc_opts(p)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--stride", type=int, required=True)
    p.add_argument("--mask")
    p.set_defaults(fn=_cmd_rect)
    p = sub.add_parser("decode"); common(p)
    p.add_argument("--raw", action="store_true")
    p.add_argument("--base")
    p.add_argument("--out-prg", type=_addr, default=None)
    p.set_defaults(fn=_cmd_decode)
    p = sub.add_parser("stats"); common(p, out=False)
    p.add_argument("--raw", action="store_true")
    p.add_argument("-T", type=int, default=None)
    p.add_argument("--bench")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=_cmd_stats)

    args = ap.parse_args(argv)
    try:
        args.fn(args)
    except (ValueError, OSError) as e:
        print("vrl.py: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
