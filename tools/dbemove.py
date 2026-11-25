#!/usr/bin/env python3
"""Python-Referenz der Engine-Funktion MOVE (P6f): Schritte und Drehungen mit Kollision und Ereignissen.

Spezifikation: docs/specs/P6-engine.md 3.4 und "Ergebnis P6f". Die 6502-Fassung (engine/lib.s, f_move) muss
move() bytegleich nachbilden (A, X, Y, P0, P1, P2 und Zustand pos/Richtung).

Der Automap-Teil (Bit 6 der Inhaltsebene) gehoert zu VIEW und steht in tools/dbeview.py (Scene.automap); dieses
Modul behandelt nur MOVE, weil es keine DVG, DTS oder Sprites braucht.

API:
  move(m, pos, v, objects, action, objn=None) -> MoveResult
      m        dbemap.Map (cells, content, tiles, events, width, height, outside)
      pos, v   Zellindex und Blickrichtung (0 N, 1 O, 2 S, 3 W)
      objects  Objektliste (dbeview.Obj: cell, hidden, noblock); objn = OBJN (Standard len(objects)), gelesen
               werden hoechstens 16
      action   0 vor, 1 zurueck, 2 seitwaerts links, 3 rechts, 4 drehen links, 5 drehen rechts, 6 umdrehen
  MoveResult(a, x, y, p0, p1, p2, pos, dir)
      a   0, 5 bei fehlender Karte entfaellt hier; 6 (E_RANGE) bei action >= 7 (Zustand unveraendert, x = y = 0)
      x   0 ok (Schritt/Drehung), 1 Karte/Kachel versperrt, 2 Objekt versperrt
      y   Kachel der neuen Position (x = 0), Kachel des Ziels (WEG), Aussenkachel (ausserhalb), Objektindex (x = 2);
          bei Drehungen die Kachel der Position
      p0  Position, p1 Inhaltsbyte der Position (mit Automap-Bits), p2 Index des ersten Ereignisses der Position
          in m.events oder 0xFFFF
Reihenfolge der Pruefungen beim Schritt: ausserhalb der Karte, Kachel-Flag WEG, Objekt (nicht hidden, nicht
noblock, kleinster Index). Ereignisse: die Liste ist nach (Zelle, Typ, Parameter) sortiert (DMP 2.5); gesucht
wird der erste Eintrag mit gleicher Zelle, Abbruch beim ersten Eintrag mit groesserer Zelle (wie die 6502-Fassung).
"""
from collections import namedtuple

FORE = [(0, -1), (1, 0), (0, 1), (-1, 0)]       # Schritt je Richtung (N, O, S, W)
TURN = (0, 2, 3, 1, 3, 1, 2)                    # Richtungszuwachs je Aktion 0 ... 6: vor, zurueck, links, rechts,
                                                # drehen links, drehen rechts, umdrehen
T_WEG = 1
E_OK, E_RANGE = 0, 6
MoveResult = namedtuple("MoveResult", "a x y p0 p1 p2 pos dir")


def first_event(m, pos):
    """Index des ersten Ereignisses der Zelle pos in m.events oder 0xFFFF."""
    for i, e in enumerate(m.events):
        if e.cell == pos:
            return i
        if e.cell > pos:            # sortiert (DMP 2.5): kein weiteres Ereignis
            break
    return 0xFFFF


def move(m, pos, v, objects, action, objn=None):
    def res(x, y, p, d):
        return MoveResult(E_OK, x, y, p, m.content[p], first_event(m, p), p, d)

    if action >= 7:
        return MoveResult(E_RANGE, 0, 0, pos, 0, 0, pos, v)
    d = (v + TURN[action]) & 3
    if action >= 4:
        return res(0, m.cells[pos], pos, d)
    x, y = pos % m.width + FORE[d][0], pos // m.width + FORE[d][1]
    if not (0 <= x < m.width and 0 <= y < m.height):
        return res(1, m.outside, pos, v)
    t = y * m.width + x
    if m.tiles[m.cells[t]].flags & T_WEG:
        return res(1, m.cells[t], pos, v)
    n = len(objects) if objn is None else objn
    for i, o in enumerate(objects[:min(n, 16)]):
        if o.cell == t and not (o.noblock or o.hidden):
            return res(2, i, pos, v)
    return res(0, m.cells[t], t, v)
