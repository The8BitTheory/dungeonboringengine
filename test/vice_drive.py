#!/usr/bin/env python3
"""Crawl 128 in VICE ereignisgesteuert spielen: Screenshot und Zyklen je Taste.

Aufruf: vice_drive.py <ausgabeordner> <disk.d81> <kürzel> <monitorport> <tasten> [--timing] [--scenes=S]

--scenes="p,d,g,gd;..." (crawl.prg mit patch_crawl.py --hook/--ref-hook): nach den Tasten je Szene
Spieler auf Zelle p mit Richtung d und Geist 1 auf Zelle g mit Richtung gd setzen ($0C44-$0C4A),
dann Leertaste (warten) und Screenshot.

Ablauf ohne feste Wartezeiten: Haltepunkt am Kernal-GETIN ($FFE4). Hält das Programm dort an und
liegt keine Taste im Puffer ($D0 = 0), wartet es auf Eingabe. Dann wird die BASIC-Zeile ($3B/$3C)
gelesen:
  Zeile 5      Tastenabfrage für den Autostart aus der IDE -> Leertaste
  3560-3630    Menü -> RETURN
  4040         Spiel (GETKEY): zwei Interrupts abwarten (damit das Bild fertig dargestellt ist),
               Screenshot <kürzel>_NN.png, Stoppuhr lesen, nächste Taste in den Puffer
Ein Haltepunkt auf dem BASIC-Fehlervektor ($0300) beendet den Test bei einem BASIC-Fehler sofort.
Die Monitor-Verbindung bleibt offen; ein Timeout dient nur als Wächter gegen Hänger.
Mit --timing wird am Ende die Summe der Renderphase ($0C40/$0C41, siehe patch_crawl.py) ausgegeben.
"""
import json, re, socket, subprocess, sys, time

PROMPT = re.compile(rb'\(C:\$[0-9a-f]{4}\) ')
MENU = set(range(3560, 3640, 10))
GAME = 4040


class Monitor:
    def __init__(self, port, tmo=600):
        t0 = time.time()
        while True:
            try:
                self.s = socket.create_connection(('127.0.0.1', port))
                break
            except OSError:
                if time.time() - t0 > 30:
                    raise
                time.sleep(0.05)        # nur bis VICE den Port öffnet
        self.s.settimeout(tmo)
        self.buf = b''
        # Der erste Befehl bei laufender Emulation hält sie an: VICE schickt dann einen Prompt
        # für das Anhalten und einen für den Befehl.
        self.s.sendall(b'\n')
        self._prompt(2)

    def _prompt(self, n=1):
        """Bis einschließlich zum n-ten Prompt lesen."""
        while len(PROMPT.findall(self.buf)) < n:
            x = self.s.recv(65536)
            if not x:
                raise EOFError('VICE beendet')
            self.buf += x
        end = [mm.end() for mm in PROMPT.finditer(self.buf)][n - 1]
        out, self.buf = self.buf[:end].decode(errors='replace'), self.buf[end:]
        return out

    def cmd(self, c):
        self.s.sendall(c.encode() + b'\n')
        return self._prompt()

    def go(self):
        """Weiterlaufen bis zum nächsten Haltepunkt."""
        self.s.sendall(b'x\n')
        return self._prompt()

    def mem(self, a, n=1):
        t = self.cmd(f'm {a:04x} {a + n - 1:04x}')
        data = {}
        for mm in re.finditer(r'>C:([0-9a-f]{4})((?:\s+[0-9a-f]{2}){1,16})', t):
            for k, x in enumerate(mm.group(2).split()):
                data[int(mm.group(1), 16) + k] = int(x, 16)
        return [data[a + k] for k in range(n)]

    def stopwatch(self):
        t = self.cmd('r')
        return int(re.findall(r'(\d+)\s*$', t.strip().splitlines()[-2])[0])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out, d81, tag, port, seq = args[0], args[1], args[2], int(args[3]), args[4]
    vice = subprocess.Popen(['x128', '-default', '-sounddev', 'dummy', '-80col', '-VDC64KB', '-warp',
                             '-drive8type', '1581', '-8', d81, '-remotemonitor',
                             '-remotemonitoraddress', f'ip4://127.0.0.1:{port}', '-autostart', d81],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    res = []
    try:
        m = Monitor(port)
        bp_getin = re.search(r'BREAK: (\d+)', m.cmd('break ffe4')).group(1)
        ev = m.mem(0x300, 2)            # BASIC-Fehlervektor: Fehler beenden den Test sofort
        err_at = ev[0] | ev[1] << 8
        m.cmd(f'break {err_at:04x}')
        irq = None
        keys, shot, sw0, menu_done = list(seq), 0, None, False
        for a in sys.argv:
            if a.startswith('--scenes='):
                keys += [tuple(int(x) for x in sc.split(',')) for sc in a[9:].split(';') if sc]

        def press(ch):
            m.cmd(f'> 034a {ord(ch):02x}')
            m.cmd('> 00d0 01')

        m.go()
        while True:
            pc = int(re.findall(r'\(C:\$([0-9a-f]{4})\)', m.cmd('r'))[-1], 16)
            if pc == err_at:
                x = int(re.findall(r'\.;[0-9a-f]{4} [0-9a-f]{2} ([0-9a-f]{2})', m.cmd('r'))[-1], 16)
                lo, hi = m.mem(0x3B, 2)
                print(tag, f'BASIC-Fehler {x} in Zeile {lo | hi << 8}', flush=True)
                sys.exit(1)
            if m.mem(0xD0)[0]:          # Taste liegt noch im Puffer: GETIN holt sie gleich
                m.go()
                continue
            lo, hi = m.mem(0x3B, 2)
            line = lo | hi << 8
            if line == 5:
                press(' ')
            elif line in MENU and not menu_done:
                press('\r'); menu_done = True
            elif line in MENU:
                print(tag, 'Spiel beendet (zurück im Menü)', flush=True)
                break
            elif line == GAME:
                if irq is None:
                    v = m.mem(0x314, 2)
                    irq = re.search(r'BREAK: (\d+)', m.cmd(f'break {v[0] | v[1] << 8:04x}')).group(1)
                m.cmd(f'disable {bp_getin}'); m.cmd(f'enable {irq}')
                m.go(); m.go()          # zwei Interrupts: Bild ist dargestellt
                m.cmd(f'disable {irq}'); m.cmd(f'enable {bp_getin}')
                m.cmd(f'screenshot "{out}/{tag}_{shot:02d}.png" 2')
                sw = m.stopwatch()
                if sw0 is not None:
                    res[-1]['cycles'] = sw - sw0
                    print(tag, shot, res[-1], flush=True)
                shot += 1
                if not keys:
                    break
                ch = keys.pop(0)
                if isinstance(ch, tuple):   # Szene: Spieler/Geist setzen, dann warten
                    p, d, g, gd = ch
                    for k, b in enumerate((165, p & 255, p >> 8, d, g & 255, g >> 8, gd)):
                        m.cmd(f'> {0xC44 + k:04x} {b:02x}')
                    res.append({'scene': ch})
                    ch = ' '
                else:
                    res.append({'key': ch})
                press(ch)
                sw0 = m.stopwatch()
            else:
                print(tag, 'unerwartete Eingabe in Zeile', line, flush=True)
                press(' ')
            m.go()
        if '--timing' in sys.argv:
            r0 = m.cmd('bank ram'); a = m.mem(0xC40, 2); m.cmd('bank ram01'); b = m.mem(0xC40, 2)
            print(tag, 'Renderphase Jiffies: RAM0', a[0] | a[1] << 8, 'RAM1', b[0] | b[1] << 8, flush=True)
        json.dump(res, open(f'{out}/{tag}_steps.json', 'w'))
    finally:
        vice.kill()


if __name__ == '__main__':
    main()
