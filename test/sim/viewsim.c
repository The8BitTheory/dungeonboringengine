/* sim65-Harness (docs/specs/P6-engine.md 9.2): executes the calls of a scene file against the lib.

   Aufruf: sim65 [-c] viewsim.prg <scene> <result>

   Scene file (all little endian):
     "DBS1"
     sequence of records, type byte first:
       0                              end
       1 addr(2) len(2) data         copy segment into memory (not below $0200, not into harness
                                      $2000-$2DFF and lib code $B000-$DBFF)
       2 f x y p0(2) p1(2) p2(2) p3(2) itemph nobj nbytes bytes
                                      call: parameter block $0C00-$0C07 = P0-P3, ITEMPH ($0C08) = itemph,
                                      OBJN ($0C50) = nobj, object list ($0C51) = the nbytes bytes (at most 96);
                                      then lib function f with X = x, Y = y
       3 addr(2) len(2)               read out memory (e.g. lib variables)
       4 like 2, but without result record (cycle measurement: run with F against run with F = 7)
   Result file:
     "DBR1"
     per call:    'C' f a x y p0..p3(8) pb(10: $0C08-$0C11) buflen(2) puffer
                 buflen = VCLLEN + VMSLEN for VIEW with A = 0, 2 or 3, otherwise 0; buffer = VCLLEN bytes from VCLADR,
                 then VMSLEN bytes from the buffer start (VMS lists upwards from B0, VCL list downwards to B1);
                 if VCLADR holds a jump (type 10, fixed list address P6j), from its target or from B0 + 3
     per read-out: 'D' addr(2) len(2) data
   Exit code: 0 ok, 2 file error, 3 segment not allowed, 4 unknown record type. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern unsigned char dbe_f, dbe_a, dbe_x, dbe_y;
extern unsigned dbe_b0;                 /* buffer start (lib variable buf_b0) */
void dbe_run(void);

#define PARM    ((unsigned char *)0x0C00)
#define OBJN    (*(unsigned char *)0x0C50)
#define OBJL    ((unsigned char *)0x0C51)
#define W(a)    (*(unsigned *)(a))

static FILE *in, *out;

static unsigned rd16(void)
{
    unsigned char b[2];
    if (fread(b, 1, 2, in) != 2) exit(2);
    return b[0] | (b[1] << 8);
}

int main(int argc, char **argv)
{
    unsigned char t, f, buf[4];
    unsigned a, n, bl;

    if (argc < 3) return 2;
    in = fopen(argv[1], "rb");
    out = fopen(argv[2], "wb");
    if (!in || !out) return 2;
    if (fread(buf, 1, 4, in) != 4 || memcmp(buf, "DBS1", 4)) return 2;
    fwrite("DBR1", 1, 4, out);
    while ((t = fgetc(in)) != 0) {
        switch (t) {
        case 1:
            a = rd16(); n = rd16();
            if (a < 0x0200 || (a < 0x2E00 && a + n > 0x2000) || (a < 0xDC00 && a + n > 0xB000)
                || (unsigned long)a + n > 0x10000UL) return 3;
            if (fread((void *)a, 1, n, in) != n) return 2;
            break;
        case 2:
        case 4:
            dbe_f = fgetc(in); dbe_x = fgetc(in); dbe_y = fgetc(in);
            if (fread(PARM, 1, 8, in) != 8) return 2;
            PARM[8] = fgetc(in);
            OBJN = fgetc(in);
            n = fgetc(in);
            if (n > 96 || fread(OBJL, 1, n, in) != n) return 2;
            f = dbe_f;
            dbe_run();
            if (t == 4) break;
            fputc('C', out);
            fputc(f, out); fputc(dbe_a, out); fputc(dbe_x, out); fputc(dbe_y, out);
            fwrite(PARM, 1, 8, out);
            fwrite(PARM + 8, 1, 10, out);
            bl = 0;
            if (f == 4 && (dbe_a == 0 || dbe_a == 2 || dbe_a == 3)) bl = W(0x0C0C) + W(0x0C0E);
            fwrite(&bl, 1, 2, out);
            if (bl) {                       /* VCL ab VCLADR, dann VMS ab Pufferanfang (Einpass, P6d-opt) */
                unsigned l0 = W(0x0C0A), m0 = dbe_b0;
                if (*(unsigned char *)l0 == 10) {   /* P6j: jump at B0 (fixed list address), VMS from B0 + 3 */
                    l0 = W(l0 + 1);
                    m0 += 3;
                }
                fwrite((void *)l0, 1, W(0x0C0C), out);
                fwrite((void *)m0, 1, W(0x0C0E), out);
            }
            break;
        case 3:
            a = rd16(); n = rd16();
            fputc('D', out);
            fwrite(&a, 1, 2, out); fwrite(&n, 1, 2, out);
            fwrite((void *)a, 1, n, out);
            break;
        default:
            return 4;
        }
    }
    fclose(in);
    fclose(out);
    return 0;
}
