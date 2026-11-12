// Immediate-mode widgets. Screens call these every frame; each widget paints
// itself and registers a hit region that the pointer handlers consult.

import { W, H, ctx, PAL, makeLayer, setTarget, rect, rrect, disc, ring, text, textW, icon, sparkle, clamp, mulberry } from './gfx.js';

export const ui = {
  regions: [],
  live: true, // false while a screen is animating in or out
  pressed: null,
  hover: null,
};

export function beginUI() {
  ui.regions.length = 0;
}

// fn fires on release; drag (optional) fires continuously while held.
export function region(id, x, y, w, h, fn, drag) {
  if (ui.live) ui.regions.push({ id, x, y, w, h, fn, drag });
}

export function hitTest(x, y) {
  for (let i = ui.regions.length - 1; i >= 0; i--) {
    const r = ui.regions[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return null;
}

const down = (id) => ui.pressed === id;
const hot = (id) => ui.hover === id && ui.live;

// Primary yellow pill.
export function pill(id, label, cx, y, w, h, fn, o = {}) {
  const x = Math.round(cx - w / 2);
  const d = down(id) ? 2 : 0;
  if (o.pulse != null) {
    // Idle pulse: a soft halo that swells and fades, in whole pixels.
    const p = 0.5 + 0.5 * Math.sin(o.pulse * 2.6);
    ctx.globalAlpha *= 0.1 + 0.2 * p;
    rrect(x - 5, y - 5, w + 10, h + 12, 11, PAL.yellow);
    if (p > 0.5) rrect(x - 3, y - 3, w + 6, h + 8, 9, PAL.yellowHi);
    ctx.globalAlpha = 1;
  }
  rrect(x - 1, y - 1, w + 2, h + 4, 7, PAL.ink);
  rrect(x, y + 2, w, h, 6, PAL.yellowLo);
  rrect(x, y + d, w, h, 6, hot(id) ? PAL.yellowHi : PAL.yellow);
  if (!d) rect(x + 5, y + 1, w - 10, 1, PAL.yellowHi);
  const sc = o.scale || 1;
  text(label, cx, y + d + Math.round((h - 7 * sc) / 2), PAL.ink, { align: 'center', scale: sc, sp: o.sp ?? 2 });
  region(id, x - 2, y - 2, w + 4, h + 6, fn);
}

// A big menu card (the landing screen): an icon on the left, a divider, a
// chunky title over a one-line subtitle, and an arrow. style 'gold' (the main
// way in) or 'dark'. o.art(x, y, w, h, t) draws the icon in its slot.
// The subtitle may hold one '•', drawn as a dot. Pressed, it sinks 2 pixels.
export function card(id, title, sub, x, y, w, h, fn, o = {}) {
  // Kept light on purpose: one outline, a 2-pixel lip, one highlight line,
  // no glow (o.pulse is accepted but no longer drawn).
  const gold = o.style !== 'dark';
  const d = down(id) ? 1 : 0;
  const on = hot(id) || down(id);
  const face = gold ? (on ? PAL.yellowHi : PAL.yellow) : on ? PAL.panelHi : '#0d1f16';
  const lip = gold ? PAL.yellowLo : '#06120c';
  rrect(x - 1, y - 1, w + 2, h + 4, 6, gold ? PAL.ink : on ? PAL.yellow : '#4f7a5c');
  rrect(x, y + 2, w, h, 5, lip);
  rrect(x, y + d, w, h, 5, face);
  const fy = y + d;
  rect(x + 6, fy + 1, w - 12, 1, gold ? '#fff8c8' : '#2f5a40');
  // Icon slot and divider.
  const slot = Math.round(Math.min(48, w * 0.24));
  if (o.art) o.art(x + 4, fy + 3, slot - 4, h - 6, o.t || 0);
  rect(x + slot + 3, fy + 6, 1, h - 12, gold ? PAL.ink : PAL.creamLo);
  // Title (as big as fits) and subtitle.
  const tx = x + slot + 10;
  const room = w - slot - 10 - 16;
  const ink = gold ? PAL.ink : PAL.cream;
  // Big, chunky title (drawn twice, a pixel apart) when it fits; the
  // subtitle only on cards tall enough for both.
  const ts = textW(title, 2, 0) + 1 <= room ? 2 : 1;
  const tsp = textW(title, ts, 1) + 1 <= room ? 1 : 0;
  const th = 7 * ts;
  const subOk = sub && h >= 32;
  const block = th + (subOk ? 9 : 0);
  const ty = fy + Math.round((h - block) / 2);
  text(title, tx, ty, ink, { scale: ts, sp: tsp, shadow: gold ? null : PAL.ink });
  if (subOk) {
    const [a, b] = sub.split('•').map((s) => s.trim());
    const sc = gold ? '#3b4a22' : '#a9bda8';
    const sp = textW(sub.replace('•', '  '), 1, 1) <= room ? 1 : 0;
    let sx = tx;
    sx += text(a, sx, ty + th + 2, sc, { sp });
    if (b != null) {
      rect(sx + 3, ty + th + 5, 2, 2, sc);
      text(b, sx + 8, ty + th + 2, sc, { sp });
    }
  }
  // The arrow, nudging forward now and then.
  const nudge = (o.t || 0) % 2.4 < 0.3 ? 1 : 0;
  const ax = x + w - 11 + nudge + (on ? 1 : 0);
  const ay = fy + Math.round(h / 2) - 4;
  for (let i = 0; i < 4; i++) rect(ax + i, ay + i, 1, 9 - i * 2, ink);
  region(id, x - 2, y - 2, w + 4, h + 5, fn);
}

// Card art: a little court with the ball bouncing over it, and sparkles.
function court(x, y, w, h, t) {
  const cx = x + Math.round(w / 2);
  const cy = y + h - 7;
  const cw = Math.min(w - 4, 30);
  // The court in perspective: a trapezoid of green rows, white lines.
  for (let r = 0; r < 7; r++) {
    const half = Math.round(cw / 2 - (6 - r) * 1.2);
    rect(cx - half - 1, cy - 3 + r, half * 2 + 2, 1, PAL.ink);
    rect(cx - half, cy - 3 + r, half * 2, 1, r % 2 ? '#3f9a4f' : '#4fae5c');
  }
  rect(cx - Math.round(cw / 2) - 1, cy + 4, cw + 2, 1, PAL.ink);
  rect(cx, cy - 3, 1, 7, '#f4f1de');
  rect(cx - Math.round(cw / 2) + 4, cy, cw - 8, 1, '#f4f1de');
  // The ball: up and down, squashing a little at the bottom.
  const hop = Math.abs(Math.sin(t * 3.2));
  const by = cy - 6 - Math.round(hop * Math.max(2, h - 18));
  const squash = hop < 0.12 ? 1 : 0;
  disc(cx, by, 4, PAL.ink);
  rect(cx - 3, by - 3 + squash, 7, 6 - squash, '#d8f04a');
  rect(cx - 2, by - 4 + squash, 5, 1, '#d8f04a');
  rect(cx - 2, by + 3, 5, 1, '#d8f04a');
  rect(cx - 1, by - 2 + squash, 1, 4 - squash, '#f4ffb0');
}

// Card art: two rackets crossed, one blue-strung, one red, and a sparkle.
function rackets(x, y, w, h, t) {
  const cx = x + Math.round(w / 2);
  const cy = y + Math.round(h / 2) - 2;
  const one = (hx, dir, strings) => {
    // Handle first (it runs under the other racket's head), then the head.
    for (let i = 0; i < 9; i++) rect(hx - dir * (3 + i), cy + 4 + i, 2, 2, i > 5 ? '#8a5a2b' : '#c98a4e');
    disc(hx, cy, 6, PAL.ink);
    disc(hx, cy, 5, PAL.cream);
    disc(hx, cy, 4, strings);
    ctx.fillStyle = '#f4f1de';
    for (let d = -3; d <= 3; d += 2) {
      ctx.fillRect(hx + d, cy - 3, 1, 7);
      ctx.fillRect(hx - 3, cy + d, 7, 1);
    }
  };
  one(cx - 6, -1, '#2d4f9a');
  one(cx + 6, 1, '#a8323a');
}

// Card art: the cup, catching the light now and then.
function cupArt(x, y, w, h, t) {
  const cx = x + Math.round(w / 2);
  icon('trophy', cx - 11, y + Math.round(h / 2) - 11, '#5a3410', 2);
  icon('trophy', cx - 12, y + Math.round(h / 2) - 12, '#f2b632', 2);
  if (t % 3 < 0.4) sparkle(cx + 8, y + Math.round(h / 2) - 9, 1, '#fff3c4');
}

// Card art: a scorecard with a pencil of a line moving down it.
function listArt(x, y, w, h, t) {
  const cx = x + Math.round(w / 2);
  const cy = y + Math.round(h / 2);
  rrect(cx - 10, cy - 11, 20, 23, 3, PAL.ink);
  rrect(cx - 9, cy - 10, 18, 21, 2, PAL.cream);
  for (let i = 0; i < 4; i++) {
    rect(cx - 6, cy - 6 + i * 5, 3, 2, i === Math.floor(t * 1.5) % 4 ? '#3f9a4f' : '#9fb7a2');
    rect(cx - 2, cy - 6 + i * 5, 8, 2, '#9fb7a2');
  }
}

// Card art: an envelope (the invite), bobbing, with a sparkle.
function inviteArt(x, y, w, h, t) {
  const cx = x + Math.round(w / 2);
  const cy = y + Math.round(h / 2) + (Math.floor(t * 2) % 2);
  rrect(cx - 12, cy - 8, 24, 17, 2, PAL.ink);
  rect(cx - 11, cy - 7, 22, 15, '#f4f1de');
  rect(cx - 11, cy + 6, 22, 1, '#cbbd92');
  // The flap: a V from the top corners to the middle.
  for (let i = 0; i < 11; i++) {
    rect(cx - 11 + i, cy - 7 + Math.floor(i * 0.7), 1, 1, PAL.ink);
    rect(cx + 10 - i, cy - 7 + Math.floor(i * 0.7), 1, 1, PAL.ink);
  }
  rect(cx - 2, cy - 1, 4, 3, '#c8352e'); // the seal
  sparkle(x + 4, y + 4, 1 + (Math.floor(t * 2) % 2), PAL.ink);
}

export const cardArt = { court, rackets, cup: cupArt, list: listArt, invite: inviteArt };

// Quiet secondary button.
export function ghost(id, label, cx, y, w, h, fn, o = {}) {
  const x = Math.round(cx - w / 2);
  const on = hot(id) || down(id);
  // A one-pixel shadow under it; pressed, the button sinks onto it.
  rrect(x - 1, y + 1, w + 2, h + 2, 5, '#06120c');
  y += down(id) ? 1 : 0;
  rrect(x - 1, y - 1, w + 2, h + 2, 5, on ? PAL.yellow : o.line || PAL.cream);
  rrect(x, y, w, h, 4, down(id) ? PAL.panelHi : o.fill || PAL.panel);
  const ink = on && !o.fill ? PAL.yellow : o.color || PAL.cream;
  if (o.icon) {
    // Icon on the left, label after it.
    icon(o.icon, x + 4, y + Math.round((h - 11) / 2), ink);
    text(label, x + 17 + Math.round((w - 20 - textW(label, 1, o.sp ?? 1)) / 2), y + Math.round((h - 7) / 2), ink, { sp: o.sp ?? 1 });
  } else {
    text(label, cx, y + Math.round((h - 7) / 2), ink, { align: 'center', sp: o.sp ?? 1 });
  }
  region(id, x - 2, y - 2, w + 4, h + 4, fn);
}

// Round icon button with a caption underneath.
export function roundBtn(id, name, label, cx, cy, fn, o = {}) {
  const r = o.r || 16;
  const d = down(id) ? 1 : 0;
  disc(cx, cy + 2, r + 1, o.shadow || PAL.creamLo);
  disc(cx, cy + d, r + 1, PAL.ink);
  disc(cx, cy + d, r, hot(id) ? PAL.panelHi : PAL.panel);
  ring(cx, cy + d, r - 2, o.ring || PAL.creamLo);
  icon(name, cx - 11, cy - 11 + d, PAL.yellow, 2);
  if (label) text(label, cx, cy + r + 6, o.color || PAL.ink, { align: 'center' });
  region(id, cx - r - 3, cy - r - 3, r * 2 + 6, r * 2 + 18, fn);
}

// Small square icon button (HUD).
export function iconBtn(id, name, x, y, fn) {
  rrect(x - 2, y - 2, 21, 22, 6, PAL.ink);
  rrect(x - 1, y - 1, 19, 19, 5, hot(id) || down(id) ? PAL.yellow : '#5f7a64');
  rrect(x, y, 17, 17, 4, hot(id) || down(id) ? PAL.panelHi : '#0d1f16');
  icon(name, x + 3, y + 3, PAL.yellow);
  region(id, x - 4, y - 4, 25, 25, fn);
}

export function slider(id, x, y, w, v, set) {
  rrect(x - 1, y - 1, w + 2, 8, 4, PAL.cream);
  rrect(x, y, w, 6, 3, '#07140d');
  const fill = Math.round((w - 2) * clamp(v, 0, 1));
  if (fill > 0) rrect(x + 1, y + 1, fill, 4, 2, PAL.yellow);
  const kx = x + 1 + fill;
  rrect(kx - 4, y - 4, 8, 14, 3, PAL.ink);
  rrect(kx - 3, y - 3, 6, 12, 2, down(id) ? PAL.yellowHi : PAL.cream);
  const drag = (px) => set(clamp((px - x - 1) / (w - 2), 0, 1));
  region(id, x - 8, y - 8, w + 16, 22, null, drag);
}

// ---------------------------------------------------------------- panels

let off = null;

function paintPanel(x, y, w, h, style) {
  if (style === 'cream') {
    rrect(x - 1, y - 1, w + 2, h + 5, 6, PAL.ink);
    rrect(x, y + 3, w, h, 5, PAL.creamLo);
    rrect(x, y, w, h, 5, PAL.cream);
    const rnd = mulberry(77);
    for (let i = 0; i < (w * h) / 60; i++) rect(x + 3 + rnd() * (w - 6), y + 3 + rnd() * (h - 6), 1, 1, PAL.creamSpeck);
    rect(x + 4, y + 3, w - 8, 1, PAL.creamLo);
    rect(x + 4, y + h - 4, w - 8, 1, PAL.creamLo);
    rect(x + 3, y + 4, 1, h - 8, PAL.creamLo);
    rect(x + w - 4, y + 4, 1, h - 8, PAL.creamLo);
  } else {
    rrect(x - 1, y - 1, w + 2, h + 5, 4, '#06120c');
    rrect(x, y, w, h + 3, 3, '#0a1a12');
    rrect(x, y, w, h, 3, PAL.panel);
    // Thin cream frame with notched corners.
    rect(x + 6, y + 3, w - 12, 1, PAL.cream);
    rect(x + 6, y + h - 4, w - 12, 1, PAL.cream);
    rect(x + 3, y + 6, 1, h - 12, PAL.cream);
    rect(x + w - 4, y + 6, 1, h - 12, PAL.cream);
    for (const [cx, cy] of [[x + 4, y + 4], [x + w - 6, y + 4], [x + 4, y + h - 6], [x + w - 6, y + h - 6]]) {
      rect(cx, cy, 2, 2, PAL.cream);
    }
  }
}

// A board that tilts up from the grass: k = 0 lying flat, k = 1 upright.
// Widgets inside only become interactive once it has fully risen.
export function panel(k, x, y, w, h, style, draw) {
  const full = k >= 0.999;
  const wasLive = ui.live;
  if (!full) {
    if (k <= 0.01) return;
    if (!off || off.canvas.height !== H || off.canvas.width !== W) off = makeLayer(W, H);
    off.clearRect(0, 0, W, H);
    setTarget(off);
    ui.live = false;
  }
  paintPanel(x, y, w, h, style);
  draw();
  ui.live = wasLive;
  if (full) return;
  setTarget(null);

  const sx = x - 3;
  const sw = w + 6;
  const sTop = y - 2;
  const sH = h + 8;
  const dH = Math.max(1, Math.round(sH * k));
  const dTop = sTop + sH - dH;
  const cx = x + w / 2;
  ctx.globalAlpha = Math.min(1, k * 1.8);
  for (let i = 0; i < dH; i++) {
    const t = i / dH;
    const ws = 1 - (1 - k) * 0.34 * (1 - t);
    const dw = Math.round(sw * ws);
    ctx.drawImage(off.canvas, sx, sTop + Math.floor((i * sH) / dH), sw, 1, Math.round(cx - dw / 2), dTop + i, dw, 1);
  }
  ctx.globalAlpha = 1;
}
