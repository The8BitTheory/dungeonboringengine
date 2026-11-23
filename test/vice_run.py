"""Crawl 128 in VICE (x128, 64 KB VRAM) starten, Tastenfolge spielen, nach jeder Taste Screenshot.

Aufruf: vice_run.py <ausgabeordner> <disk.d81> <kürzel> <monitorport> <tasten>

Ablauf: Zeile 5 von crawl.bas wartet auf eine Taste (Hilfe für Autostart aus der IDE ohne
gemountete Diskette); der Treiber drückt dann die Leertaste. Danach Menü, RETURN, Spiel.
Tasten werden über den Remote-Monitor in den Tastaturpuffer ($034A, $D0) geschrieben; der Treiber
wartet jeweils, bis das Programm wieder in Zeile 4040 (GETKEY) steht.
"""
import socket, subprocess, sys, time
S=sys.argv[1]; d81=sys.argv[2]; tag=sys.argv[3]; PORT=int(sys.argv[4]); seq=sys.argv[5]
p=subprocess.Popen(["x128","-default","-sounddev","dummy","-80col","-VDC64KB","-warp","-drive8type","1581","-8",d81,
   "-remotemonitor","-remotemonitoraddress",f"ip4://127.0.0.1:{PORT}","-autostart",d81],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def cmd(c,wait=0.5):
    s=socket.create_connection(("127.0.0.1",PORT)); s.settimeout(2); s.sendall((c+"\n").encode()); time.sleep(wait); out=b""
    try:
        while True:
            x=s.recv(65536)
            if not x: break
            out+=x
    except OSError: pass
    s.sendall(b"x\n"); time.sleep(0.1); s.close(); return out.decode(errors="replace")
def key(ch):
    cmd("bank ram",0.1); cmd(f"> 034a {ord(ch):02x}",0.1); cmd("> 00d0 01",0.1); time.sleep(0.5)
def line():
    t=cmd("m 003b 003c",0.4)
    for l in t.splitlines():
        i=l.find(">C:003b")
        if i>=0:
            b=l[i+7:].split(); return int(b[0],16)+256*int(b[1],16)
def waitline(targets,tmo=300):
    t0=time.time()
    while time.time()-t0<tmo:
        l=line()
        if l in targets: return l
        if l==5: key(" ")
        time.sleep(2)
    return ("timeout",l)
try:
    for _ in range(50):
        try: socket.create_connection(("127.0.0.1",PORT)).close(); break
        except OSError: time.sleep(0.3)
    print(tag,"boot",waitline({5}),flush=True)
    print(tag,"menu",waitline({3560,3570,3580,3590,3600,3610,3620,3630}),flush=True); time.sleep(3)
    key("\r"); time.sleep(2)
    print(tag,"game",waitline({4040}),flush=True); time.sleep(1); cmd(f'screenshot "{S}/{tag}_00.png" 2')
    for i,ch in enumerate(seq,1):
        key(ch); time.sleep(1); r=waitline({4040},120); time.sleep(1)
        cmd(f'screenshot "{S}/{tag}_{i:02d}.png" 2'); print(tag,i,ch,r,flush=True)
finally:
    p.kill()
