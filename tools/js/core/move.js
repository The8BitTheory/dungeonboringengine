// Reference of the engine function MOVE (P6f): steps and turns with collision and events. Port of tools/dbemove.py.
// Specification: docs/specs/P6-engine.md 3.4. The 6502 version must reproduce move() byte for byte.
//   move(m, pos, v, objects, action, objn) -> {a, x, y, p0, p1, p2, pos, dir}
//   m: map (cells, content, tiles[].flags, events[].cell, width, height, outside); objects: [{cell, hidden, noblock}]
//   action: 0 forward, 1 back, 2 strafe left, 3 right, 4 turn left, 5 turn right, 6 turn around

export const FORE = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);   // step per direction (N, E, S, W)
export const TURN = Object.freeze([0, 2, 3, 1, 3, 1, 2]);                // direction increment per action
export const T_WEG = 1;
export const E_OK = 0, E_RANGE = 6;

/** Index of the first event of cell pos in m.events (sorted by cell), or 0xFFFF. */
export function firstEvent(m, pos) {
  for (let i = 0; i < m.events.length; i++) {
    const c = m.events[i].cell;
    if (c === pos) return i;
    if (c > pos) break;
  }
  return 0xFFFF;
}

export function move(m, pos, v, objects, action, objn = null) {
  const res = (x, y, p, d) => ({ a: E_OK, x, y, p0: p, p1: m.content[p], p2: firstEvent(m, p), pos: p, dir: d });
  if (action >= 7) return { a: E_RANGE, x: 0, y: 0, p0: pos, p1: 0, p2: 0, pos, dir: v };
  const d = (v + TURN[action]) & 3;
  if (action >= 4) return res(0, m.cells[pos], pos, d);
  const x = (pos % m.width) + FORE[d][0], y = Math.floor(pos / m.width) + FORE[d][1];
  if (!(x >= 0 && x < m.width && y >= 0 && y < m.height)) return res(1, m.outside, pos, v);
  const t = y * m.width + x;
  if (m.tiles[m.cells[t]].flags & T_WEG) return res(1, m.cells[t], pos, v);
  const n = objn === null ? objects.length : objn;
  const lim = Math.min(n, 16);
  for (let i = 0; i < Math.min(lim, objects.length); i++) {
    const o = objects[i];
    if (o.cell === t && !(o.noblock || o.hidden)) return res(2, i, pos, v);
  }
  return res(0, m.cells[t], t, v);
}
