/* sim65-Harness (docs/specs/P6-engine.md 9.2): führt die Aufrufe einer Szenendatei gegen die Lib aus.

   Aufruf: sim65 [-c] viewsim.prg <szene> <ergebnis>

   Szenendatei (alles Little Endian):
     "DBS1"
     Folge von Sätzen, Typ-Byte zuerst:
       0                              Ende
       1 addr(2) len(2) daten         Segment in den Speicher kopieren (nicht unter $0200, nicht in Harness
                                      $2000-$2DFF und Lib-Code $B000-$DBFF)
       2 f x y p0(2) p1(2) p2(2) p3(2) itemph nobj nbytes bytes
                                      Aufruf: Parameterblock $0C00-$0C07 = P0-P3, ITEMPH ($0C08) = itemph,
                                      OBJN ($0C50) = nobj, Objektliste ($0C51) = die nbytes Bytes (höchstens 96);
                                      dann Lib-Funktion f mit X = x, Y = y
       3 addr(2) len(2)               Speicher auslesen (z. B. Lib-Variablen)
       4 wie 2, aber ohne Ergebnissatz (Zyklenmessung: Lauf mit F gegen Lauf mit F = 7)
   Ergebnisdatei:
     "DBR1"
     je Aufruf:  'C' f a x y p0..p3(8) pb(10: $0C08-$0C11) buflen(2) puffer
                 buflen = VCLLEN + VMSLEN bei VIEW mit A = 0, 2 oder 3, sonst 0; puffer = VCLLEN Byte ab VCLADR,
                 dann VMSLEN Byte ab Pufferanfang (VMS-Listen aufwärts ab B0, VCL-Liste abwärts bis B1);
                 steht bei VCLADR ein Sprung (Typ 10, feste Listenadresse P6j), ab dessen Ziel bzw. ab B0 + 3
     je Auslesen: 'D' addr(2) len(2) daten
   Exitcode: 0 ok, 2 Dateifehler, 3 Segment unzulässig, 4 Satztyp unbekannt. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern unsigned char dbe_f, dbe_a, dbe_x, dbe_y;
extern unsigned dbe_b0;                 /* Pufferanfang (Lib-Variable buf_b0) */
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
                if (*(unsigned char *)l0 == 10) {   /* P6j: Sprung bei B0 (feste Listenadresse), VMS ab B0 + 3 */
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
