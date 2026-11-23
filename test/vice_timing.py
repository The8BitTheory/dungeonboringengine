"""Zeitmessung in VICE: Zyklen je Schritt (Stoppuhr von Tastendruck bis zum nächsten GETIN-Aufruf).

Aufruf: vice_timing.py <ausgabeordner> <disk.d81> <kürzel> <monitorport> <tasten>
Mit einer per patch_crawl.py --timing/--ref-timing erzeugten crawl.prg steht die Summe der
Renderphase in Jiffies am Ende in $0C10/$0C11 (wird ausgegeben). Zeile 5 siehe vice_run.py.
"""
import socket, subprocess, sys, time, re, json
S=sys.argv[1]; d81=sys.argv[2]; tag=sys.argv[3]; PORT=int(sys.argv[4]); seq=sys.argv[5]
p=subprocess.Popen(["x128","-default","-sounddev","dummy","-80col","-VDC64KB","-warp","-drive8type","1581","-8",d81,
   "-remotemonitor","-remotemonitoraddress",f"ip4://127.0.0.1:{PORT}","-autostart",d81],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def cmds(cs,wait=0.4):
    s=socket.create_connection(("127.0.0.1",PORT)); s.settimeout(1.5)
    for c in cs: s.sendall((c+"\n").encode()); time.sleep(0.05)
    time.sleep(wait); out=b""
    try:
        while True:
            x=s.recv(65536)
            if not x: break
            out+=x
    except OSError: pass
    s.sendall(b"x\n"); time.sleep(0.05); s.close(); return out.decode(errors="replace")
def regs(t):
    m=re.findall(r"\.;([0-9a-f]{4}) ([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2}) .* (\d+)\s*$",t,re.M)
    if not m: return None
    a=m[-1]; return int(a[0],16),int(a[1],16),int(a[4])
def line():
    t=cmds(["m 003b 003c"],0.3)
    for l in t.splitlines():
        i=l.find(">C:003b")
        if i>=0:
            b=l[i+7:].split(); return int(b[0],16)+256*int(b[1],16)
def key(ch): cmds(["bank ram",f"> 034a {ord(ch):02x}","> 00d0 01"],0.2)
def waitline(targets,tmo=300):
    t0=time.time()
    while time.time()-t0<tmo:
        l=line()
        if l in targets: return l
        if l==5: key(" ")
        time.sleep(2)
BP=[]
res=[]
try:
    for _ in range(50):
        try: socket.create_connection(("127.0.0.1",PORT)).close(); break
        except OSError: time.sleep(0.3)
    waitline({5}); waitline({3560,3570,3580,3590,3600,3610,3620,3630}); time.sleep(3)
    key("\r"); time.sleep(2); waitline({4040}); time.sleep(1)
    for ch in seq:
        t=cmds(["bank ram",f"> 034a {ord(ch):02x}","> 00d0 01","break ffe4"]+[f"break {b:04x}" for b in BP]+["r"],0.4)
        nums=re.findall(r"BREAK: (\d+)\s+C:\$ffe4",t)
        st=regs(t); 
        if nums: cmds([f"ignore {nums[0]} 1"],0.2)
        ev=[]; t0=time.time()
        while time.time()-t0<120:
            r=regs(cmds(["r"],0.15))
            if not r: continue
            pc,a,sw=r
            if pc==0xffe4: ev.append(("end",a,sw)); break
            if pc in BP and (not ev or ev[-1][2]!=sw): ev.append((hex(pc),a,sw))
        cmds(["delete"],0.2)
        step=ev[-1][2]-st[2] if ev and ev[-1][0]=="end" else None
        view=[ev[i+1][2]-ev[i][2] for i in range(len(ev)-1) if ev[i][0]=="0xd58" and ev[i][1]==4 and ev[i+1][0]=="0xd5b"]
        vcl=[ev[i+1][2]-ev[i][2] for i in range(len(ev)-1) if ev[i][0]=="0x1a64" and ev[i+1][0]=="0x1b0a"]
        res.append(dict(key=ch,step=step,view=view,vcl=vcl)); print(tag,res[-1],flush=True)
    t=cmds(["bank ram","m 0c10 0c11","bank ram01","m 0c10 0c11"],0.5); print(tag,"R9",t[-400:],flush=True)
    json.dump(res,open(f"{S}/{tag}_tim.json","w"))
finally:
    p.kill()
