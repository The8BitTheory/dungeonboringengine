# P6g VICE scenes (docs/specs/P6-engine.md 9.4); template for test/vice_view.py (@...@ are substituted).
# @FAST@ = "fast:" (2 MHz, VIC display off during VIEW and VCL; run with --fast) or empty, @SLOW@ = "slow" or "rem".
# Markers (RTS in bank 0): 3148 = $0C4C before VIEW, 3149 = $0C4D after ::VCL (scene done), 3150 = $0C4E end of table.
# Results for the harness: $0C40 A, $0C41 X from VIEW; $0C42 A, $0C43 X, $0C44 Y, $0C45/6 P0 from SETPOS/MOVE.
# Exit code: 0 = done, 61-63 = file missing, 10 = INIT, 20+n = setter call n failed, 199 = no VDC-BASIC v3, 200+ = BASIC error.
1 poke 57,0:poke 58,64:clr:trap 9000
2 if peek(dec("1c03"))<>dec("30") then r=199:goto 8995
10 bank 0:poke 3148,96:poke 3149,96:poke 3150,96
20 bload"dbe@VERSION@.stub",b0,u8:bload"dbe@VERSION@.lib",b1,u8:if ds<>0 then r=60:goto 8995
30 sys 3328:rreg a,x,y:if a<>0 or x<>3 then r=10:goto 8995
# Chunky mode as in Crawl (crawl.bas 10059-10135); 64 KB VRAM cleared completely beforehand
100 rgo 28,24
110 vmf 0,0,65535:vmw 65535,0
120 disp 46335:attr 0
130 rgw 0,127:rgw 4,159:rgw 6,120:rgw 7,133:rgw 9,1
140 rgo 25,128
150 rgw 36,0:rgw dec("1a"),dec("ff")
160 vmf 46335,15,16000:vmf 62335,0,3200
170 vmf 0,0,8000:vmf 8000,dec("1f"),1600
@LOADS@
@SETUP@
2000 tb=32768
2010 k=peek(tb):if k=2 then 2200
2020 p0=peek(tb+1)+256*peek(tb+2):x=peek(tb+3):n=peek(tb+5)
2030 if k=0 then poke 3080,peek(tb+4)
2040 if n<>255 then poke 3152,n:gosub 9600
2050 f=2:p1=0:y=0:if k=1 then f=3
2060 gosub 9500
2070 poke 3138,a:poke 3139,x:poke 3140,y:poke 3141,peek(3072):poke 3142,peek(3073)
2080 if n=255 then tb=tb+6:goto 2100
2090 tb=tb+6+6*n
2100 @FAST@sys 3148
2110 poke 3072,0:poke 3073,0:sys 3331,4,0,0:rreg a,x,y
2120 v=peek(3072)+256*peek(3073):poke 3136,a:poke 3137,x
2130 vcl v
2140 sys 3149
2145 @SLOW@
2150 goto 2010
2200 sys 3150
8990 r=0
8995 bank 15:poke dec("d7ff"),r:end
9000 r=200+er:goto 8995
9500 poke 3072,p0-256*int(p0/256):poke 3073,int(p0/256):poke 3074,p1-256*int(p1/256):poke 3075,int(p1/256)
9510 sys 3331,f,x,y:rreg a,x,y:return
9600 if n=0 then return
9610 for i=0 to 6*n-1:poke 3153+i,peek(tb+6+i):next:return
