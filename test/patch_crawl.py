#!/usr/bin/env python3
"""crawl.prg (tokenisiert, VDC-BASIC v2g) auf DBE-VIEW umstellen.

Ersetzt die Sichtberechnung (Zeilen 4600-4669) durch SETPOS/VIEW/VCL und ergänzt
das Laden von Stub, Lib und Wandsatz-Metadaten sowie MAPINIT/WALLSET.
Aufruf: patch_crawl.py [--timing | --ref-timing] crawl.prg out.prg
  --timing      zusätzlich Zeitmessung der Renderphase (Jiffies, Summe nach $0C10/$0C11)
  --ref-timing  nur Zeitmessung ins Original einbauen (Vergleichswert), kein DBE
Braucht petcat (VICE) für die neuen Zeilen.
"""
import os, subprocess, sys, tempfile

NEW = {
    79:    'BANK0:POKE3072,0:POKE3073,128:POKE3074,W%:POKE3075,0:POKE3076,H%:POKE3077,0:SYS3331,1:BANK15',
    4600:  'BANK0:POKE3072,PP%(0) AND 255:POKE3073,PP%(0)/256:SYS3331,2,PF%(0)',
    4610:  'POKE3072,AP AND 255:POKE3073,AP/256:SYS3331,4:BANK15',
    4620:  '::VCL 2816',
    4630:  'T%(4)=FNM(4):T%(10)=FNM(10)',
    10052: 'BLOAD"DBE.STUB",B0,U(DD):BLOAD"DBE.LIB",B1,U(DD):BLOAD"WALLS.WSM",B1,U(DD):SYS3328',
    10225: 'POKE3072,0:POKE3073,176:POKE3074,DA AND 255:POKE3075,DA/256:SYS3331,8',   # Crawl steht hier auf BANK 0
}
DROP = range(4600, 4670)
VDC = {b'VCL': 0x3B}


def lines_of(d):
    i = 2; out = {}
    while True:
        if d[i] | d[i + 1] << 8 == 0:
            break
        end = d.index(0, i + 4)
        out[d[i + 2] | d[i + 3] << 8] = bytes(d[i + 4:end]); i = end + 1
    return d[0] | d[1] << 8, out


def tokenize(new):
    with tempfile.TemporaryDirectory() as t:
        src = os.path.join(t, 'n.txt'); prg = os.path.join(t, 'n.prg')
        open(src, 'w').write(''.join(f'{n} {s.lower()}\n' for n, s in sorted(new.items())))
        subprocess.run(['petcat', '-w70', '-o', prg, '--', src], check=True, capture_output=True)
        _, ls = lines_of(open(prg, 'rb').read())
    for n, b in ls.items():
        for k, v in VDC.items():
            b = b.replace(b'::' + k, b'::' + bytes((0xFE, v)))
        ls[n] = b
    return ls


TIMING = {   # Renderphase DBE: 4600 .. Ende 4630 (BANK 15)
    4600: 'S=TI:' + NEW[4600],
    4630: NEW[4630] + ':R9=R9+TI-S:POKE3088,R9 AND 255:POKE3089,R9/256',
}
REF_TIMING = {   # Renderphase Original: 4600 .. Beginn 4670 (Bank unbekannt -> BANK 15 setzen und zurück geht nicht; $0C10 in RAM 0 und 1 lesen)
    4600: 'S=TI:C1=AP+400',
    4670: 'R9=R9+TI-S:POKE3088,R9 AND 255:POKE3089,R9/256:C1%=CA+FC%(4):C3%=C1%+18',
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = [a for a in sys.argv[1:] if a.startswith('--')]
    load, ls = lines_of(open(args[0], 'rb').read())
    if '--ref-timing' in flags:
        ls.update(tokenize(REF_TIMING))
    else:
        for n in list(ls):
            if n in DROP:
                del ls[n]
        new = dict(NEW)
        if '--timing' in flags:
            new.update(TIMING)
        ls.update(tokenize(new))
    out = bytearray((load & 255, load >> 8)); addr = load
    for n in sorted(ls):
        rec = bytes((n & 255, n >> 8)) + ls[n] + b'\0'
        addr += 2 + len(rec)
        out += bytes((addr & 255, addr >> 8)) + rec
    out += b'\0\0'
    open(args[1], 'wb').write(out)
    print(f'{len(ls)} Zeilen -> {args[1]}')


if __name__ == '__main__':
    main()
