/* VIEW im Simulator (sim65): Zyklen und Listenlänge je Position/Richtung.
   Aufruf: sim65 -c viewsim.prg <pos> <dir> <mode>
   mode 0 = nur Einrichtung, 1 = mit VIEW, 2 = mit VIEW und Ausgabe "nvis len" */
#include <stdio.h>
#include <stdlib.h>

extern unsigned char __fastcall__ dbe_call(unsigned char f, unsigned char x);
extern unsigned char dbe_x, dbe_y;
extern unsigned char mapdata[], wsmdata[];
extern const unsigned char map_w, map_h;

#define P(n) (*(unsigned*)(0x0C00 + 2 * (n)))

int main(int argc, char **argv)
{
    unsigned pos = atoi(argv[1]);
    unsigned char dir = atoi(argv[2]);
    unsigned char mode = atoi(argv[3]);
    unsigned char r;
    (void)argc;
    dbe_call(0, 0);
    P(0) = (unsigned)mapdata; P(1) = map_w; P(2) = map_h;
    dbe_call(1, 0);
    P(0) = (unsigned)wsmdata; P(1) = 0;
    if (dbe_call(8, 0)) return 2;
    P(0) = pos;
    dbe_call(2, dir);
    if (mode) {
        P(0) = 0;
        r = dbe_call(4, 0);
        if (mode == 2) printf("%u %u %u\n", r, dbe_x, dbe_y);
    }
    return 0;
}
