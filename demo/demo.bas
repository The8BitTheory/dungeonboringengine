# Dungeon Boring Engine 0.2: Demo (docs/specs/P7-crawl.md 8). Braucht VDC-BASIC v3 (BOOT) und dbe0.2.stub/.lib.
# Tasten: W vor, S zurueck, A/D seitwaerts, Q/E drehen, X Ende. 3 Goblins gehen feste Routen, einer pro Tastendruck.
# Interpretiert (RUN) und als Blitz!-Kompilat (Runtime Image 2, blitzprep.py) lauffaehig; Test: test/vice_demo.py.
# Bank 1 (Speicherkarte P6 2.4): DMP $4000, Arbeitskopie $5000, S2 $6000/$6500, Wand-DTS $8000, DVG $E800, Boden $EE00,
# Decke $F600, Tapete $FB80. VRAM: Attribute 0-9599, Pool 9600-46334, Bitmap ab 46335.
# Die DATA-Zeilen 600-619 (Basen, Ladeadressen) prueft demo/build.py gegen die gebauten Dateien.
1 poke 57,0:poke 58,64:clr:vb=4864:trap 9000
2 if peek(dec("1c03"))<>dec("30") then print"needs vdc-basic v3 (run boot)":end
3 fs=1:rem 1 = 2 mhz (fast) waehrend view und vcl, 0 = 1 mhz
10 print"dungeon boring engine demo ...":bank 0
20 bload"dbe0.2.stub",b0,u8:bload"dbe0.2.lib",b1,u8:if ds<>0 then 9100
30 sys 3328:rreg a,x,y:if a<>0 or x<>3 then 9100
# Chunky-Modus 160 x 100 wie Crawl (crawl.bas 10059-10135), 64-KB-VRAM vorher ganz geloescht
100 rgo 28,24
110 vmf 0,0,65535:vmw 65535,0
120 disp 46335:attr 0
130 rgw 0,127:rgw 4,159:rgw 6,120:rgw 7,133:rgw 9,1
140 rgo 25,128
150 rgw 36,0:rgw dec("1a"),dec("ff")
160 vmf 46335,15,16000:vmf 62335,0,3200
170 vmf 0,0,8000:vmf 8000,dec("1f"),1600
# Dateien nach Bank 1, Bilddaten (VRL) per RXV in den Pool (Basen in der DATA-Zeile 600)
200 bload"demo.dmp",b1,u8:bload"demo.dvg",b1,u8:bload"walls.dts",b1,u8:bload"floor.dts",b1,u8:bload"ceil.dts",b1,u8
210 bload"land.dbg",b1,u8:bload"goblin.s2",b1,u8:bload"gem.s2",b1,u8:if ds<>0 then 9100
220 bload"walls.vrl",b0,u8:read bs:rxv 36869,bs
230 bload"floor.vrl",b0,u8:read bs:rxv 36869,bs
240 bload"ceil.vrl",b0,u8:read bs:rxv 36869,bs
250 bload"land.vrl",b0,u8:read bs:rxv 36869,bs
260 bload"goblin.vrl",b0,u8:read bs:rxv 36869,bs
270 bload"gem.vrl",b0,u8:read bs:rxv 36869,bs
280 if ds<>0 then 9100
# Puffer $1300-$1BFF mit fester Listenadresse (X = 1, P6j): VCL vb (= $1300, erste Variable) springt zur Liste
290 f=15:x=1:y=0:p0=4864:p1=7168:gosub 9500:if a<>0 then 9100
300 for i=1 to 10:read f,x,y,p0,p1:gosub 9500:if a<>0 then 9100
310 next
320 w=x:pc=peek(3072)+256*peek(3073):dr=peek(3074)
# Goblin-Routen (DATA 620-640): je Goblin Anzahl der Zellen, dann x,y der Zellen (geschlossener Weg)
400 ng=3:dim rl(2),rt(2,15),gi(2)
410 for g=0 to ng-1:read rl(g):for i=0 to rl(g)-1:read x,y:rt(g,i)=y*w+x:next:next
500 fc=0:gosub 3100:gosub 3200
# VRL-Basen im VRAM-Pool (Reihenfolge walls, floor, ceil, land, goblin, gem)
600 data 9600,32903,36543,39657,44697,45766
# Setz-Aufrufe F, X, Y, P0, P1
610 data 11,0,0,9600,46335
611 data 12,0,0,59392,65535
612 data 13,0,0,32768,9600
613 data 13,1,0,60928,32903
614 data 13,2,0,62976,36543
615 data 14,51,0,64384,39657
616 data 9,0,0,24576,44697
617 data 9,1,0,25856,45766
618 data 10,1,2,0,0
619 data 1,1,0,16384,20480
# Routen
620 data 10, 13,2, 13,3, 13,4, 13,5, 13,6, 13,7, 13,6, 13,5, 13,4, 13,3
630 data 6, 15,5, 16,5, 17,5, 18,5, 17,5, 16,5
640 data 10, 12,1, 13,1, 14,1, 15,1, 16,1, 17,1, 16,1, 15,1, 14,1, 13,1
# Hauptschleife: eine Taste = ein Zug (MOVE), dann ziehen die Goblins einen Schritt
2000 poke 208,0:getkey k$
2010 ac=-1
2020 if k$="W" then ac=0
2030 if k$="S" then ac=1
2040 if k$="A" then ac=2
2050 if k$="D" then ac=3
2060 if k$="Q" then ac=4
2070 if k$="E" then ac=5
2080 if k$="X" then 8990
2090 if ac<0 then 2000
2100 sys 3331,3,ac,0:rreg a,x,y
2110 pc=peek(3072)+256*peek(3073)
2120 if ac=4 then dr=dr+3
2130 if ac=5 then dr=dr+1
2140 dr=dr and 3
2150 gosub 3000:gosub 3100:gosub 3200:goto 2000
# Goblin-Zug: naechste Zelle der Route; steht dort der Spieler, wartet der Goblin
3000 fc=fc+1
3010 for g=0 to ng-1:n=gi(g)+1:if n>=rl(g) then n=0
3020 if rt(g,n)<>pc then gi(g)=n
3030 next:return
# Objektliste ($0C50: Anzahl, $0C51: je 6 Byte Zelle, Satz 0, Richtung $FF, Phase, Unterposition Mitte) und ITEMPH ($0C08)
3100 for g=0 to ng-1:b=3153+6*g:t=rt(g,gi(g)):h=int(t/256)
3110 poke b,t-256*h:poke b+1,h:poke b+2,0:poke b+3,255:poke b+4,(fc+g) and 3:poke b+5,4
3120 next:poke 3152,ng:poke 3080,fc and 1:return
# Bild: VIEW, VCL (mit FAST), Kompass unter dem Fenster (Zeilen 96-99, aktive Richtung hell)
3200 if fs then fast
3210 poke 3072,0:poke 3073,0:sys 3331,4,0,0:rreg a,x,y
3220 vcl vb
3230 if fs then slow
3240 vdm 1,0,80
3250 for d=0 to 3:c=1:if d=dr then c=15
3260 xx=60+10*d:vdb xx,97,8,3,c
3270 next:return
8990 slow:graphic 0:end
9000 trap:slow:print"?error";er;"in line";el:end
9100 trap:slow:print"load or setup error, ds=";ds;" a=";a:end
9500 poke 3072,p0-256*int(p0/256):poke 3073,int(p0/256):poke 3074,p1-256*int(p1/256):poke 3075,int(p1/256)
9510 sys 3331,f,x,y:rreg a,x,y:return
