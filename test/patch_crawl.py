#!/usr/bin/env python3
"""Convert crawl.prg (tokenized, VDC-BASIC v2g) to DBE VIEW.

Replaces the view computation and the drawing of gems and ghosts (lines 4600-5009)
with SETPOS, object list, VIEW and VCL. Adds loading of stub, lib, wall set and
sprite metadata and of the packed ghost images (instead of RED.VDC/RED1.VDC) as well as MAPINIT, WALLSET,
SPRITESET, ITEMSET.
Usage: patch_crawl.py [--timing | --ref-timing] crawl.prg out.prg
  --timing      additionally time measurement of the render phase (jiffies, sum to $0C40/$0C41)
  --ref-timing  only build the time measurement into the original (reference value), no DBE
  --hook        test aid: before each drawing take player/ghost 1 from $0C44-$0C4A if
                $0C44 = 165 (position player W, direction, position ghost W, direction); for vice_drive.py --scenes
  --ref-hook    only build the test aid into the original
Needs petcat (VICE) for the new lines.
"""
import os, subprocess, sys, tempfile

NEW = {
    # Game start: map (template VE = $8000) as a working copy to $A000 so that SETCELL does not change the template
    3721:  'POKE3072,0:POKE3073,128:POKE3074,W%:POKE3075,0:POKE3076,H%:POKE3077,0:POKE3078,0:POKE3079,160:SYS3331,1',
    # Gem collected / exit open: also in the map of the lib (SETCELL)
    5500:  'M%(PP%(0))=0:GS%(1)=GS%(1)-1:POKE3072,PP%(0)-INT(PP%(0)/256)*256:POKE3073,PP%(0)/256:SYS3331,6,0',
    5550:  'IF GS%(1)<=0 THEN M%(EX%)=42:POKE3072,EX%-INT(EX%/256)*256:POKE3073,EX%/256:SYS3331,6,42:TX$="FIND THE EXIT!":GOSUB6200',
    # View: position, object list (ghost 1: position, set 0, viewing direction), VIEW, VCL
    4600:  'BANK0:POKE3072,PP%(0) AND 255:POKE3073,PP%(0)/256:SYS3331,2,PF%(0)',
    4605:  'POKE3088,1:POKE3089,PP%(1) AND 255:POKE3090,PP%(1)/256:POKE3091,0:POKE3092,PF%(1)',
    4610:  'POKE3072,AP AND 255:POKE3073,AP/256:SYS3331,4:BANK15',
    4620:  '::VCL 2816',
    # Loading: stub, lib, metadata (bank 1, own load addresses $E000/$E200/$EA00)
    10052: 'BLOAD"DBE0.1.STUB",B0,U(DD):BLOAD"DBE0.1.LIB",B1,U(DD):SYS3328',
    10053: 'BLOAD"WALLS.WSM",B1,U(DD):BLOAD"GHOST.SPR",B1,U(DD):BLOAD"GEM.SPR",B1,U(DD)',
    10225: 'POKE3072,0:POKE3073,224:POKE3074,DA-INT(DA/256)*256:POKE3075,DA/256:SYS3331,8',   # Crawl is on BANK 0 here
    # Packed ghosts instead of RED/RED1 into VRAM (GA(0)), register sprite sets, cell value 2 = gem.
    # Low byte by calculation: AND only handles values up to 32767.
    10386: 'BLOAD"GHOSTS.VDC",B0,P(BE),U(DD):GL=FNPW(174)-BE:GA(2)=GA(0)+GL',
    10387: '::RTV BE,GA(0),GL',
    10388: 'POKE3072,0:POKE3073,226:POKE3074,GA(0)-INT(GA(0)/256)*256:POKE3075,GA(0)/256:SYS3331,9,0',
    10389: 'POKE3072,0:POKE3073,234:POKE3074,CA-INT(CA/256)*256:POKE3075,CA/256:SYS3331,9,1:SYS3331,10,2,2',
}
# View computation and drawing of gems and ghosts; loading of RED/RED1 (replaced by GHOSTS.VDC)
DROP = set(range(4600, 5010)) | set(range(10320, 10385))
VDC = {b'VCL': 0x3B, b'RTV': 0x2F}


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


TIMING = {   # DBE render phase: 4600 .. to VCL (BANK 15); sum in $0C40/$0C41
    4600: 'S=TI:' + NEW[4600],
    4625: 'R9=R9+TI-S:POKE3136,R9 AND 255:POKE3137,R9/256',
}
REF_TIMING = {   # Original render phase: 4600 .. 5010 (incl. gems and ghosts); bank unknown -> read $0C40 in RAM 0 and 1
    4600: 'S=TI:C1=AP+400',
    5010: 'R9=R9+TI-S:POKE3136,R9 AND 255:POKE3137,R9/256:FORX=0TO19:T%(X)=0:NEXT',
}


HOOK = {
    4598: 'IF PEEK(3140)=165 THEN PP%(0)=PEEK(3141)+256*PEEK(3142):PF%(0)=PEEK(3143):PP%(1)=PEEK(3144)+256*PEEK(3145):PF%(1)=PEEK(3146):POKE3140,0',
    4599: 'RETURN',
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = [a for a in sys.argv[1:] if a.startswith('--')]
    load, ls = lines_of(open(args[0], 'rb').read())
    if '--ref-timing' in flags:
        ls.update(tokenize(REF_TIMING))
    elif '--ref-hook' in flags:
        ls.update(tokenize({**HOOK, 4600: 'GOSUB4598:C1=AP+400'}))
    else:
        for n in list(ls):
            if n in DROP:
                del ls[n]
        new = dict(NEW)
        if '--timing' in flags:
            new.update(TIMING)
        if '--hook' in flags:
            new.update(HOOK)
            new[4600] = 'GOSUB4598:' + new[4600]
        ls.update(tokenize(new))
    out = bytearray((load & 255, load >> 8)); addr = load
    for n in sorted(ls):
        rec = bytes((n & 255, n >> 8)) + ls[n] + b'\0'
        addr += 2 + len(rec)
        out += bytes((addr & 255, addr >> 8)) + rec
    out += b'\0\0'
    open(args[1], 'wb').write(out)
    print(f'{len(ls)} lines -> {args[1]}')


if __name__ == '__main__':
    main()
