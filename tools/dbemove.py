#!/usr/bin/env python3
"""Python reference of the engine function MOVE (P6f): steps and turns with collision and events.

Specification: docs/specs/P6-engine.md 3.4 and "Result P6f". The 6502 version (engine/lib.s, f_move) must
reproduce move() byte for byte (A, X, Y, P0, P1, P2 and the state pos/direction).

The automap part (bit 6 of the content plane) belongs to VIEW and lives in tools/dbeview.py (Scene.automap); this
module only covers MOVE, because it needs no DVG, DTS or sprites.

API:
  move(m, pos, v, objects, action, objn=None) -> MoveResult
      m        dbemap.Map (cells, content, tiles, events, width, height, outside)
      pos, v   cell index and viewing direction (0 N, 1 E, 2 S, 3 W)
      objects  object list (dbeview.Obj: cell, hidden, noblock); objn = OBJN (default len(objects)), at most 16
               are read
      action   0 forward, 1 back, 2 strafe left, 3 right, 4 turn left, 5 turn right, 6 turn around
  MoveResult(a, x, y, p0, p1, p2, pos, dir)
      a   0; 5 for a missing map does not apply here; 6 (E_RANGE) for action >= 7 (state unchanged, x = y = 0)
      x   0 ok (step/turn), 1 map/tile blocked, 2 object blocked
      y   tile of the new position (x = 0), tile of the target (SOLID), outside tile (outside the map), object index
          (x = 2); for turns the tile of the position
      p0  position, p1 content byte of the position (with automap bits), p2 index of the first event of the position
          in m.events or 0xFFFF
Order of the checks for a step: outside the map, tile flag SOLID, object (not hidden, not noblock, smallest index).
Events: the list is sorted by (cell, type, parameter) (DMP 2.5); the first entry with the same cell is searched,
aborting at the first entry with a greater cell (like the 6502 version).
"""
from collections import namedtuple

FORE = [(0, -1), (1, 0), (0, 1), (-1, 0)]       # step per direction (N, E, S, W)
TURN = (0, 2, 3, 1, 3, 1, 2)                    # direction increment per action 0 ... 6: forward, back, left, right,
                                                # turn left, turn right, turn around
T_WEG = 1
E_OK, E_RANGE = 0, 6
MoveResult = namedtuple("MoveResult", "a x y p0 p1 p2 pos dir")


def first_event(m, pos):
    """Index of the first event of cell pos in m.events, or 0xFFFF."""
    for i, e in enumerate(m.events):
        if e.cell == pos:
            return i
        if e.cell > pos:            # sorted (DMP 2.5): no further event

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
