# P1: VRL – RLE stream for `RXV`, tool `tools/vrl.py`

As of 2026-11-25. Detailed specification for step P1 of `docs/plan-0.2.md` (section 6). Implementation: Sonnet. Review: Opus. Dependencies: Python standard library only (≥ 3.11).

## 1. Purpose

VRL describes what `RXV src,dst` (VDC-BASIC v3, P2b) writes into VRAM: literals, runs and gaps (skip). Uses:

- Unpack assets densely into the VRAM pool (no skips).
- Write rectangles with a stride directly into an image buffer (skip at the end of a line).
- Images with per-byte transparency (skip over transparent bytes).

VRL cannot do transparency per **pixel** (one nibble); that remains `VMS` type 8 (P5 decides per byte whether it is written in VRL, skipped or drawn via `VMS`).

## 2. Tokens

All words are low/high.

| Byte b | Following bytes | Meaning | Length in stream |
|---|---|---|---|
| `$00` | – | End | 1 |
| `$01–$7F` | n = b bytes | write n literals (1 … 127) to the destination | 1 + n |
| `$80–$FD` | v | Run: L = b − `$80` + 2 (2 … 127) times v | 2 |
| `$FE` | lo, hi | Skip: advance the destination by n = hi·256 + lo, write nothing; n = 0 means 65536 | 3 |
| `$FF` | lo, hi, v | long run: L = hi·256 + lo times v; L = 0 means 65536 | 4 |

- The destination is a byte pointer into VRAM that advances by 1 after every written or skipped byte (16 bits; overflow from `$FFFF` to `$0000` is an error of the producer; the encoder prevents it via the unpacked length, 4.4).
- **Decoder (`RXV`, information for P2b):** literals via CPU through reg 31; run with L < T via CPU, with L ≥ T via block fill (first byte via CPU, reg 30 = L − 1, in pieces of 256 if L > 256); skip sets reg 18/19 anew. After a block fill, reg 18/19 already points past the end, so no new address is needed. T comes from P0.
- The decoder must accept every valid token sequence, including ones the encoder never produces (e.g. `$FF` with L = 1, two runs in a row with the same value, skip directly before the end).

## 3. File frame

A VRL file is a PRG file:

| Offset | Size | Content |
|---|---|---|
| 0 | 2 | load address (default `$2000`, `--load`) |
| 2 | 2 | `"V" "R"` (`$56 $52`) |
| 4 | 1 | version = 1 |
| 5 | 2 | unpacked length U (word, 0 … 65535) |
| 7 | … | stream (tokens up to and including `$00`) |

- **U** = number of destination bytes from the start to just past the last written byte, i.e. the sum of all literal, run and skip lengths. A skip at the end is not encoded (4.3) and does not count. U > 65535 is an error.
- The header begins after the load address; the stream is at load address + 5. Call in BASIC: `BLOAD"IMAGE.VRL",B0,P(BE):RXV BE+5,DEST` (proposal; whether `RXV` checks the header itself instead is decided by P2b, see `review-notes.md`).
- Raw streams without a header (e.g. embedded in DTS, P5): `--raw`.

## 4. Encoder

### 4.1 Input

A sequence of destination positions; each is either a byte value 0–255 (write) or **`SKIP`** (`None`: do not write, destination content remains). For `encode_rect` the sequence is built from rectangle, stride and mask (4.5).

### 4.2 Size-optimal

Among all valid token sequences, the encoder searches for one with minimal stream length. Method: dynamic programming backwards over positions i = n … 0.

`best[i]` = (bytes, tokens) minimal for the rest from i; compared lexicographically (bytes first, then number of tokens). Transitions from position i:

| Transition | Condition | Cost (bytes) | continue at |
|---|---|---|---|
| Skip k | positions i … i+k−1 are `SKIP`; k = the whole skip span from i | 3 | i + k |
| Run L | positions i … i+L−1 equal, no `SKIP`; L ∈ {2 … min(127, R)}, plus L = R if R > 127 (R = length of the repetition from i) | 2 for L ≤ 127, otherwise 4 | i + L |
| Literal n | positions i … i+n−1 without `SKIP`; 1 ≤ n ≤ 127 | 1 + n | i + n |

- A `SKIP` span is always skipped entirely (there is no alternative); runs and literals end before the next `SKIP` at the latest.
- Runs of length 2 are allowed; the DP takes them only if they are actually shorter (e.g. a lone pair between skips). Runs of 3 or more are never longer than the same bytes as literals; whether they are chosen is likewise decided by the DP.
- **Tie** (same bytes and tokens): when building from the front (reconstruction from i = 0), among the optimal transitions the one that **covers the most positions** is chosen; with equal coverage, run before literal. This makes the output unambiguous.
- Long runs 128 … R − 1 need not be checked: the long run over the whole repetition costs the same 4 bytes and leaves no remainder. Short runs ≤ 127, however, do (example `[7]*128 + [1,2]` → `FD 07 03 07 01 02 00`, shorter than the long run).
- Running time: O(n × 127); compute all helper tables (repetition length, skip length, longest literal from i) in advance backwards in O(n) – a loop over the skip span per position makes the encoder quadratic. Goal: 64 KB in under 10 s (CPython).

### 4.3 Skips

- Leading skips are encoded (destination offset at the start).
- **Skips at the end are omitted**: the stream ends with `$00` after the last written byte.
- Because U ≤ 65535 (4.4), every encoded skip is ≤ 65534 and every run ≤ 65535; the encoder never produces the forms with length 0 (= 65536), the decoder accepts them.
- A sequence consisting only of `SKIP` yields the stream `$00` and U = 0.

### 4.4 Limits

- U ≤ 65535, otherwise `ValueError("VRL: unpacked length exceeds 65535")`.
- Values outside 0 … 255 → `ValueError`.

### 4.5 Rectangle with stride and mask

`encode_rect(data, width, height, stride, mask=None)`:

- `data`: `width × height` bytes, row by row.
- `mask`: `None` (write everything) or a sequence of the same length; true/≠ 0 = write, 0/false = `SKIP`.
- Destination sequence: row r begins at r × stride. Between the end of a row (r × stride + width) and the next row lie stride − width `SKIP` positions; they merge with masked bytes at the end and start of the rows into one skip.
- Conditions: width ≥ 1, height ≥ 1, stride ≥ width, otherwise `ValueError`. stride ≤ 65535.
- The result is the stream; the caller passes the start address (destination of the first byte, row 0, column 0) to `RXV`. If the first byte is masked, the stream begins with a skip.

## 5. Decoder

`decode(stream, base=None)`:

- Reads tokens up to `$00`. Returns a `bytearray`: copy of `base` (or empty), extended with 0 to U if needed; written positions overwritten, skipped ones unchanged.
- Errors (`ValueError` with byte offset in the stream): end without `$00` (“unerwartetes Ende bei Offset n”), literal/run beyond the end of the stream, destination beyond 65536.
- `decode_tokens(stream)` returns the tokens as a list `Token(kind, length, value, offset)`; `kind` ∈ `"lit"`, `"run"`, `"lrun"`, `"skip"`, `"end"`; `value` is the bytes for `lit`, the value for runs, otherwise `None`; `offset` = position in the stream.

## 6. Python API (`tools/vrl.py`)

```python
SKIP = None
VERSION = 1

def encode(data) -> bytes                       # sequence of int | None; stream incl. $00
def encode_rect(data, width, height, stride, mask=None) -> bytes
def decode(stream, base=None) -> bytearray
def decode_tokens(stream) -> list[Token]
def unpacked_length(stream) -> int              # U
def pack_file(stream, load=0x2000) -> bytes      # PRG with header (U taken from the stream)
def unpack_file(data) -> tuple[int, int, int, bytes]   # (load, version, U, stream); checks "VR", version, U;
                                                       # stream ends with the first end token, bytes after it are ignored
def threshold(params) -> int                     # T from the cost model (8.2)
def load_bench(path) -> dict                     # key "engine" from the P0 JSON
def stats(stream, T=None, params=None) -> dict
```

`encode(b"")` → `b"\x00"`. `bytes`, `bytearray` and lists are allowed as input.

## 7. CLI

```
vrl.py encode IN OUT [--load ADDR] [--raw] [--in-prg]
vrl.py rect   IN OUT --width W --height H --stride S [--mask MASK] [--load ADDR] [--raw] [--in-prg]
vrl.py decode IN OUT [--raw] [--base BASE] [--out-prg ADDR]
vrl.py stats  IN [--raw] [-T N] [--bench P0.json] [--json]
```

- `--in-prg`: the input file has a 2-byte load address, which is skipped.
- `--mask`: file with width × height bytes (≠ 0 = write).
- `decode` writes U bytes (or `len(base)` if larger); with `--out-prg` as a PRG.
- `stats` prints a table (8.1); with `--json` as JSON.
- Load addresses as a number with prefix (`0x2000`, `$2000` and `8192` are accepted).
- Exit code 0 = ok, 1 = format error (message on stderr, without traceback), 2 = wrong invocation (argparse).

## 8. Statistics and cycle estimate

### 8.1 `stats` returns

| Key | Content |
|---|---|
| `stream_bytes` | length of the stream |
| `unpacked` | U |
| `written` | written bytes (literals + runs) |
| `skipped` | skipped bytes |
| `ratio` | `stream_bytes / written` |
| `tokens` | count per kind (`lit`, `run`, `lrun`, `skip`) |
| `bytes_by_kind` | written bytes per kind (`lit`, `run_cpu`, `run_fill`) at threshold T |
| `run_hist` | runs by length in classes 2, 3–4, 5–8, 9–16, 17–32, 33–64, 65–128, 129–256, > 256 |
| `T` | threshold used |
| `cycles` | estimated cycles (8.2), rounded |

### 8.2 Cost model (CPU cycles at 2 MHz)

| Parameter | Meaning | Placeholder until P0 |
|---|---|---|
| `tok` | read token and branch | 30 |
| `cpu_lit_byte` | literal byte via CPU | 22 |
| `cpu_byte` | run byte via CPU | 15 |
| `cpu_run_fixed` | start of a run via CPU | 10 |
| `new_addr` | skip (reg 18/19 anew) | 80 |
| `fill_fixed` | block fill until done, fixed part | 200 |
| `fill_byte` | block fill per byte | 1 |
| `fill_chunk` | each further 256 piece of a long run | 30 |

```
cycles = Σ tokens except end: tok
       + literal n:           n · cpu_lit_byte
       + run L, L < T:        cpu_run_fixed + L · cpu_byte
       + run L, L ≥ T:        fill_fixed + L · fill_byte + (ceil(L/256) − 1) · fill_chunk
       + skip:                new_addr
```

`threshold(params)` = smallest L ≥ 2 with `fill(L') < cpu(L')` for all L' ∈ [L, 65536]; since both are linear, it suffices: smallest L ≥ 2 with `fill(L) < cpu(L)` and `fill_byte < cpu_byte`, otherwise 65537. With the placeholders: T = 14 (L = 14: fill 214 < CPU 220; L = 13: fill 213 > CPU 205).

`stats(stream, T=None, params=None)`: missing parameters come from the placeholders; T = `threshold(params)` if not given. `load_bench(path)` reads `engine` from the P0 JSON (`docs/v3/P0-bench.md`, section 10.4); keys missing there remain placeholders; `T` from the file is adopted if present (return value: parameter dict incl. optional `T`; unknown keys are ignored). `stats` takes `T` from `params` if the argument `T` is missing.

## 9. Tests (`test/tools/test_vrl.py`, unittest)

Invocation: `python3 -m unittest discover -s test/tools -v` in the repo root directory. The test adds `<repo>/tools` to `sys.path`. No pytest (not installed).

### 9.1 Fixed vectors (stream without file frame)

All vectors have been recomputed with a prototype according to 4.2.

| Input | Expected stream |
|---|---|
| `[]` | `00` |
| `[5]` | `01 05 00` |
| `[7,7]` | `80 07 00` |
| `[7]*3` | `81 07 00` |
| `[7]*127` | `FD 07 00` |
| `[7]*128` | `FF 80 00 07 00` |
| `[7]*65535` | `FF FF FF 07 00` |
| `[7]*65536` | error: U = 65536 > 65535 |
| `[7]*128 + [1,2]` | `FD 07 03 07 01 02 00` |
| `[1,2,3]` | `03 01 02 03 00` |
| `[1,1,1,2]` | `81 01 01 02 00` |
| `[1,1,2,2,3]` | `05 01 01 02 02 03 00` (same length as two runs + literal, fewer tokens) |
| `list(range(128))` | `7F 00 01 … 7E 01 7F 00` (131 bytes; 127 + 1, longest coverage first) |
| `[None, 5]` | `FE 01 00 01 05 00` |
| `[5, None]` | `01 05 00` |
| `[None]*3` | `00` |
| `[5, None, None, 5]` | `01 05 FE 02 00 01 05 00` |
| `[None]*65534 + [1]` | `FE FE FF 01 01 00` |
| `[None]*65535 + [1]` | error: U = 65536 > 65535 |
| `[None]*70000` | `00` (skip at the end is dropped) |
| `[9,9,None,9,9]` | `80 09 FE 01 00 80 09 00` |

`encode_rect`:

| Call | Expected stream |
|---|---|
| `encode_rect([1,2,3,4], 2, 2, 80)` | `02 01 02 FE 4E 00 02 03 04 00` |
| `encode_rect([5]*8, 4, 2, 4)` | `86 05 00` (stride = width: one run across both rows) |
| `encode_rect([5,5,5,5], 4, 1, 4, mask=[1,0,0,1])` | `01 05 FE 02 00 01 05 00` |
| `encode_rect([1,2,3,4], 2, 2, 10, mask=[1,0,0,1])` | `01 01 FE 0A 00 01 04 00` (skip = 1 + 8 + 1) |
| `encode_rect([1,2], 2, 1, 80, mask=[0,0])` | `00` |
| `encode_rect(..., stride=1, width=2)` | `ValueError` |

### 9.2 Properties

- **Round trip:** for 2000 random sequences (fixed seed, `random.Random(1)`; length 0 … 600; alphabet chosen randomly per sequence from {2 values, 5 values, 256 values}; `SKIP` share 0 %, 10 % or 50 %; long runs interspersed), `decode(encode(x), base)` == expected image (written positions = value, `SKIP` = `base`; `base` = random bytes of length U + 5).
- **Optimality:** for 300 short random sequences (length ≤ 12, alphabet {0,1,2}, `SKIP` allowed), `len(encode(x))` equals the minimum of an exhaustive search written independently in the test (recursion over all token partitions, without the DP helper functions of `vrl.py`).
- **Determinism:** encoded twice = same bytes.
- **Limits:** literal 127/128, run 127/128/129, 255/256/257, 65534/65535 (length and round trip), skip 65533/65534 followed by a byte (round trip), U = 65536 → error.
- **Decoder errors:** `b""`, `b"\x03\x01"` (literal truncated), `b"\x81"`, `b"\xFE\x01"`, `b"\xFF\x00\x00"`, `b"\x01\x05"` (no end) → `ValueError`.
- **Decoder accepts foreign streams:** `FF 01 00 07 00` → `[7]`; `80 07 80 07 00` → `[7]*4`; `FE 05 00 00` → U = 5, nothing written.
- **File:** `unpack_file(pack_file(s, 0x3000))` == `(0x3000, 1, U, s)`; wrong magic, version 2, U not matching the stream → `ValueError`.
- **stats:** for `[7]*300 + [1,2,3] + [None]*10 + [4]` (stream `FF 2C 01 07 03 01 02 03 FE 0A 00 01 04 00`): `tokens` = `{"lrun":1, "lit":2, "skip":1, "run":0}`, `written` = 304, `skipped` = 10, `unpacked` = 314; with T = 15 (or 14) and placeholders `cycles` = 4·30 + (200 + 300 + 30) + 3·22 + 80 + 1·22 = 818.
- **threshold:** placeholders → 14; `fill_byte ≥ cpu_byte` → 65537; `load_bench` with a JSON generated in the test overrides only existing keys.
- **CLI:** `encode`/`decode` via `subprocess` with temporary files (`tempfile.TemporaryDirectory`), round trip byte-identical; `stats --json` is valid JSON; format error → exit code 1 without traceback.

## 10. Edge cases (summary)

| Case | Behavior |
|---|---|
| empty input, only skips | stream `00`, U = 0 |
| skip at the start | encoded |
| skip at the end | omitted |
| skip ≥ 65535 before data, run ≥ 65536 | not possible (U ≤ 65535) |
| U > 65535 | error |
| value 0 as data | normal (token `$00` occurs only at a token position) |
| literal with one byte between two runs | DP decides (`[1,1,1,2,3,3,3]` → `81 01 01 02 81 03 00`) |
| stride = width | rows merge, no skip |
| mask entirely 0 | stream `00` |

## 11. Acceptance

- `tools/vrl.py` with a docstring in the style of `tools/wallconv.py` (format briefly described, usage).
- All tests in `test/tools/test_vrl.py` green, run time of the test file < 30 s.
- `docs/formats.md` gets the section “VRL v1” (token table 2, file frame 3) – short, with a reference to this specification.
