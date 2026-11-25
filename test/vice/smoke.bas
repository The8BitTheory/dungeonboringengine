# P6a Rauchtest (docs/specs/P6-engine.md 10): Stub mit 8 KB gemeinsamem RAM, Lib-Testbuild.
# Ergebnis als Exitcode der Debug-Cartridge: 0 = grün, 10.. = Nummer der fehlgeschlagenen Prüfung, 200+ = BASIC-Fehler.
1 poke 57,0:poke 58,64:clr:trap 9000
5 if peek(57)<>0 or peek(58)<>64 then r=30:goto 8995
10 bank 0:bload"dbe0.2.stub",b0,u8:bload"dbe0.2-test.lib",b1,u8
20 s=0:for i=7168 to 16383:s=s+peek(i):next
30 sys 3328:rreg a,x,y:if a<>0 or x<>3 then r=10:goto 8995
40 sys 3331,250,0,0:rreg a,x,y
50 if a<>6 then r=11:goto 8995
60 if x<>127 then r=12:goto 8995
70 poke 4864,123:poke 4865,0:sys 3331,250,0,0:rreg a,x,y
80 if y<>123 or peek(4865)<>165 then r=13:goto 8995
90 t0=peek(162):poke 3072,32:poke 3073,3:sys 3331,251,0,0:rreg a,x,y:t1=peek(162)
100 d=t1-t0:if d<0 then d=d+256
110 if a<>0 or d<30 or d>120 then r=14:goto 8995
120 poke 3072,0:poke 3073,19:poke 3074,64:poke 3075,19:sys 3331,15,0,0:rreg a,x,y:if a<>0 then r=15:goto 8995
130 poke 3074,1:poke 3075,28:sys 3331,15,0,0:rreg a,x,y:if a<>6 then r=16:goto 8995
140 sys 3331,200,0,0:rreg a,x,y:if a<>255 then r=17:goto 8995
150 s2=0:for i=7168 to 16383:s2=s2+peek(i):next:if s2<>s then r=18:goto 8995
160 sys 3331,252,0,0:rreg a,x,y:if a<>0 or x<>66 or y<>234 then r=19:goto 8995
200 a0=dec("a000"):bank 0
210 for i=0 to 15:read b:poke a0+i,b:next
220 data 3,17,34,51, 129,68, 254,2,0, 1,85, 255,44,1,102, 0
230 vmf 3000,99,320
240 rxv a0,3000
250 if vmd(3000)<>17 or vmd(3001)<>34 or vmd(3002)<>51 then r=20:goto 8995
260 if vmd(3003)<>68 or vmd(3005)<>68 or vmd(3006)<>99 then r=21:goto 8995
270 if vmd(3008)<>85 or vmd(3009)<>102 or vmd(3308)<>102 or vmd(3309)<>99 then r=22:goto 8995
280 vmw 2000,42:if vmd(2000)<>42 then r=23:goto 8995
290 sys 3331,250,0,0:rreg a,x,y:if a<>6 then r=24:goto 8995
8990 r=0
8995 bank 15:poke dec("d7ff"),r:end
9000 r=200+er:goto 8995
