// Level data: five hand-made courts, then generated ones up to COUNT. Each
// generated court is one geometric formation (diamond, circle, ring,
// triangle, cross, hexagon, X, frame, hourglass, twin diamonds, chevron),
// filling up gently from about 30 blocks to MAX_BLOCKS on court 120.
//   T terracotta (1 hit)   L limestone (1 hit)
//   H hedge (2 hits)       S slate slab (3 hits)
// Per level:
//   move   row indexes that slide side to side (their outer cells stay empty)
//   speed  ball speed, paddle  paddle width, drop  chance a block drops a tool
//   drift  how far the formation advances toward the player and back
//   wave   height of the floating motion
//   form   the formation's name (generated courts)

import { PADDLE_Y } from './game.js';

export const COUNT = 120;

const HAND = [
  { id: 'baseline', name: 'BASELINE', rows: ['.TTTTT.', 'LLLLLLL', 'THTLTHT', '.LLLLL.'] },
  { id: 'topiary', name: 'TOPIARY', rows: ['...H...', '..HLH..', '.HLTLH.', 'HLT.TLH', '.HLTLH.', '..HLH..'] },
  { id: 'terrace', name: 'TERRACE', rows: ['SS.T.SS', '.LLLLL.', 'TTHHHTT', '.......', '.TLHLT.', 'LL...LL'], move: [1, 4] },
  { id: 'colonnade', name: 'COLONNADE', rows: ['LSLSLSL', 'T.T.T.T', 'H.H.H.H', 'T.T.T.T', '.HLTLH.', 'S..L..S'], move: [4] },
  { id: 'grandslam', name: 'GRAND SLAM', rows: ['HSHSHSH', '.TLTLT.', 'LHTSTHL', '.LTLTL.', 'THLHLHT', '.S...S.'], move: [1, 3] },
];

const ADJ = ['EMERALD', 'GOLDEN', 'SILENT', 'ROYAL', 'MIDNIGHT', 'IVORY', 'WILD', 'AMBER', 'SECRET', 'GRAND', 'CRIMSON', 'VELVET'];
const NOUN = ['LAWN', 'GARDEN', 'TERRACE', 'ARCADE', 'PAVILION', 'ORCHARD', 'CLOISTER', 'PROMENADE', 'CONSERVATORY', 'FINAL'];

// Geometric formations, in u (across) and v (far to near), both -1..1.
const FORMS = [
  ['DIAMOND', (u, v) => Math.abs(u) + Math.abs(v) <= 1],
  ['CIRCLE', (u, v) => u * u + v * v <= 1],
  ['TRIANGLE', (u, v) => Math.abs(u) <= (v + 1) / 2 + 0.05],
  ['RING', (u, v) => u * u + v * v <= 1 && u * u + v * v >= 0.33],
  ['CROSS', (u, v) => Math.abs(u) <= 0.3 || Math.abs(v) <= 0.34],
  ['HEXAGON', (u, v) => Math.abs(v) <= 0.92 && Math.abs(u) + Math.abs(v) * 0.5 <= 1],
  ['X', (u, v) => Math.abs(Math.abs(u) - Math.abs(v)) <= 0.34],
  ['FRAME', (u, v) => Math.max(Math.abs(u), Math.abs(v)) >= 0.5],
  ['HOURGLASS', (u, v) => Math.abs(u) <= Math.abs(v) + 0.15],
  ['TWIN DIAMONDS', (u, v) => Math.abs(Math.abs(u) - 0.5) * 2 + Math.abs(v) <= 1.05],
  ['CHEVRON', (u, v) => Math.abs(v + 0.35 - (1 - Math.abs(u)) * 0.95) <= 0.38],
];
// How much of its grid each formation fills, to size the grid for a count.
const FILL = FORMS.map(([, f]) => {
  let k = 0;
  for (let i = 0; i < 41; i++) for (let j = 0; j < 41; j++) if (f(i / 20 - 1, j / 20 - 1)) k++;
  return k / (41 * 41);
});

export const MAX_BLOCKS = 320;
// The formation's depth. Everything stays in the first FIELD units past the
// far wall, plus any drift, so there is always room to see the ball coming:
// at least ROOM units between the deepest block and the paddle.
const FIELD = 118;
export const ROOM = 58;

// Deterministic hash -> [0, 1), so every device generates the same courts.
function hash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function generate(n) {
  const hard = n / (COUNT - 1);
  // How many blocks this court aims for: a gentle curve up to MAX_BLOCKS.
  const target = 30 + Math.round((MAX_BLOCKS - 30) * Math.pow(hard, 1.3));
  const fi = (n * 7) % FORMS.length; // a different formation from court to court
  const [form, inside] = FORMS[fi];
  // Grid size for that count: columns odd (a middle column), rows in
  // proportion to the field, blocks as big as fit.
  let C = Math.max(7, Math.round(Math.sqrt(target / (FILL[fi] * 0.84))));
  if (C % 2 === 0) C++;
  const cell = Math.min(28, 196 / C);
  const R = Math.max(5, Math.round(C * 0.84));
  const row = Math.min(20, cell * 0.72, (FIELD - 8) / R); // a little short of FIELD, leaving room to drift
  const mid = (C - 1) / 2;
  const slate = 0.03 + hard * 0.14;
  const rows = [];
  for (let r = 0; r < R; r++) {
    let line = '';
    for (let c = 0; c < C; c++) {
      const u = (c - mid) / mid;
      const v = (r - (R - 1) / 2) / ((R - 1) / 2);
      if (!inside(u, v)) {
        line += '.';
        continue;
      }
      const m = Math.min(c, C - 1 - c); // mirrored left and right
      const roll = hash(n, m + 70, r + 70);
      const ring = Math.round(Math.sqrt(u * u + v * v) * 3); // bands of colour out from the middle
      line += roll < slate ? 'S' : roll < slate + 0.16 + hard * 0.12 ? 'H' : ring % 2 ? 'L' : 'T';
    }
    rows.push(line);
  }
  return {
    id: 'court' + (n + 1),
    name: ADJ[n % ADJ.length] + ' ' + NOUN[Math.floor(n / ADJ.length)],
    form,
    rows,
    move: [],
    cell,
    row,
    cols: C,
    most: Math.floor(FIELD / row),
    drift: n >= 10 && hash(n, 7, 7) < 0.5 ? Math.round(3 + hard * 5) : 0,
  };
}

export const LEVELS = [];
for (let n = 0; n < COUNT; n++) {
  // The hand-made courts keep their drawn layouts at full block size.
  const lv = n < HAND.length ? { ...HAND[n], cell: 28, row: 20, cols: 7, most: Math.max(HAND[n].rows.length, Math.floor(FIELD / 20)) } : generate(n);
  lv.blocks = lv.rows.join('').replace(/\./g, '').length;
  // Gentle growth: court 120 serves at 213, with a racket that narrows a little.
  lv.speed = Math.round(165 + n * 0.4);
  lv.paddle = Math.max(43, Math.round(52 - n * 0.075));
  lv.drop = Math.max(0.09, 0.16 - n * 0.0006);
  lv.wave = 1.5 + hash(n, 8, 8) * 2;
  // The drift toward the player never eats into the ROOM in front of the paddle.
  const R = lv.rows.length;
  const bottom = 30 + Math.max(0, 6 - R) * 6 + R * lv.row;
  lv.drift = Math.max(0, Math.min(lv.drift || 0, Math.floor(PADDLE_Y - ROOM - bottom)));
  LEVELS.push(lv);
}

// Multiplayer plays the same courts a little livelier: courts 1-10 serve
// faster (30% on court 1, easing to 10% by court 10) and tools drop a
// little more often. The Rally is unchanged.
export function matchLevel(i) {
  const lv = LEVELS[i];
  const boost = i < 10 ? 1.3 - (0.2 * i) / 9 : 1;
  return { ...lv, speed: Math.round(lv.speed * boost), drop: Math.min(0.24, lv.drop * 1.25) };
}
