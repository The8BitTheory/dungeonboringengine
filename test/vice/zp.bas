# Nachweis Zeropage-Block (test/vice_zp.py): Lib-Aufrufe mit belegtem ZPB ($63-$72) unter Interrupts
# (Tastatur/Jiffy, SOUND mit Sweep, MOVSPR); danach rechnet BASIC (Fliesskomma, STR$) weiter richtig.
# Exitcode der Debug-Cartridge: 0 = gruen, 10.. = Nummer der Pruefung, 200+ = BASIC-Fehler.
1 poke 57,0:poke 58,80:clr:trap 9000
10 bank 0:bload"dbe0.2.stub",b0,u8:bload"dbe0.2-test.lib",b1,u8
20 sys 3328:rreg a,x,y:if a<>0 then r=10:goto 8995
30 sprite 1,1,2:movspr 1,100,100:movspr 1,45#7
40 sound 1,2000,30000,2,500,100,1
50 t0=ti:x0=rsppos(1,0)
60 for i=1 to 20
70 a=sin(i)*1.7+i/3:c$=str$(a):f=a*a
80 poke 3072,0:poke 3073,1:sys 3331,253,0,0:rreg r,x,y
90 b=sin(i)*1.7+i/3:if r<>0 then r=11:goto 8995
100 if a<>b or c$<>str$(b) or f<>b*b then r=12:goto 8995
110 next
120 t1=ti:if t1-t0<200 then r=13:goto 8995
130 if rsppos(1,0)=x0 then r=14:goto 8995
140 g=1/3:h=g*3:if abs(h-1)>1e-8 then r=15:goto 8995
150 if val("3.25")*4<>13 then r=16:goto 8995
8990 r=0
8995 sound 1,0,0:bank 15:poke dec("d7ff"),r:end
9000 r=200+er:goto 8995
