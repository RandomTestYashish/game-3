// The garden court: camera projection, parallax background layers and the
// shared sprite painters (blocks, ball, paddle).

import { W, H, ctx, PAL, makeLayer, setTarget, rect, disc, ellipse, line, trap, rrect, text, textW, lerp, mulberry, bayer } from './gfx.js';
import { WW, WH, PADDLE_Y } from './game.js';
import { COUNTRIES } from './themes.js';

// ---------------------------------------------------------------- projection
// cam 0 = low view from behind the baseline (menus), cam 1 = raised play view.
// shift trucks the camera sideways: the paddle's depth stays put on screen and
// everything nearer or farther slides against it.

// landing 1 = the bare first screen (no net, no overhanging canopy).
// pops: brick hits the nearby fans react to ({x, y, k}: where, and 1..0 as it fades);
// wave: where a Mexican wave's crest is around the stands (0..1), or -1.
export const P = { cam: 0, wb: 0, hor: 0, G: 1, dFar: 1.45, kx: 1.16, cx: W / 2, shift: 0, sRef: 1, landing: 0, banner: false, hype: 0, clap: 0, groan: 0, pops: [], wave: -1 };
// hype 0..1: how hard the crowd behind the court is cheering right now.

export function setCam(cam, shift = 0) {
  P.cam = cam;
  P.cx = W / 2;
  P.shift = shift;
  P.wb = Math.round(lerp(0.58 * H, 0.3 * H, cam));
  const yTop = P.wb + lerp(3, 7, cam);
  const yBot = H - lerp(2, 6, cam);
  P.dFar = lerp(2.3, 1.45, cam);
  P.G = (yBot - yTop) / (1 - 1 / P.dFar);
  P.hor = yBot - P.G;
  P.sRef = P.kx / depth(PADDLE_Y);
}

const depth = (wy) => P.dFar + (1 - P.dFar) * (wy / WH);

export function proj(wx, wy, wz = 0) {
  const d = depth(wy);
  const s = P.kx / d;
  return { x: P.cx + (wx - WW / 2) * s - P.shift * (s - P.sRef), y: P.hor + P.G / d - wz * s, s };
}

export function unprojX(sx, wy) {
  const s = P.kx / depth(wy);
  return (sx - P.cx + P.shift * (s - P.sRef)) / s + WW / 2;
}

function unprojY(sy) {
  const d = P.G / (sy - P.hor);
  return (WH * (d - P.dFar)) / (1 - P.dFar);
}

// ---------------------------------------------------------------- layers
// Each court theme (js/themes.js) gets its own set of background layers,
// built the first time it is shown and kept until the window is resized.

const M = 26; // spare layer width each side, revealed as the camera trucks
const WALL_H = 14;
const LAYER_H = 64;
const HILL_H = 64;
const LAND_H = 90;
let lanterns = [];
let speckles = [];
let flies = [];
let petals = [];
let cache = {};
let theme = null; // the theme being drawn
let L = null; // its layers

export function buildLayers() {
  const rnd = mulberry(20261013);
  cache = {};
  lanterns = [M + W / 2 - 82, M + W / 2 + 81].map(Math.round);
  speckles = [];
  const reach = W / 2 / 0.5; // world half-width visible at the far edge of the low view
  for (let i = 0; i < Math.round(W * 1.3); i++) {
    speckles.push({ x: WW / 2 + (rnd() - 0.5) * 2 * reach, y: -40 + rnd() * (WH + 60), light: rnd() < 0.5, wide: rnd() < 0.3 });
  }
  flies = [];
  for (let i = 0; i < Math.round(W / 22); i++) flies.push({ x: rnd() * W, y: rnd(), p: rnd() * 6.28, f: 0.5 + rnd() });
  petals = [];
  for (let i = 0; i < Math.round(W / 14); i++) petals.push({ x: rnd() * W, y: rnd(), p: rnd() * 6.28, v: 5 + rnd() * 7, k: rnd() });
  // Build every country now, so none is built in the middle of a frame later.
  for (const c of COUNTRIES) layersFor({ countryId: c.id, backgroundPalette: c.bg });
  if (theme) L = layersFor(theme);
}

export function layersFor(t) {
  return cache[t.countryId] || (cache[t.countryId] = makeLayers(t.countryId, t.backgroundPalette));
}

// Switch theme. A change of country or surface cross-fades over ~350 ms.
// Both scenes are drawn live during the fade, from the same camera, so
// nothing slides or ghosts while the camera is moving.
const FADE = 0.35;
let prev = null;
let fadeLayer = null;
let fadeT = 1;
let lastT = null;
export function setTheme(t) {
  if (theme && t.key === theme.key) return;
  if (theme) {
    prev = theme;
    fadeT = 0;
  }
  theme = t;
  L = layersFor(t);
}
export const currentTheme = () => theme;

// A small picture of a theme for the theme picker: its sky, landmarks and
// trees, and a little court in its normal colours.
export function drawThemePreview(t, x, y, w, h) {
  const Lt = layersFor(t);
  const mid = M + Math.round(W / 2);
  const gy = Math.round(y + h * 0.6);
  const skyH = Lt.sky.height;
  ctx.drawImage(Lt.sky, 0, skyH * 0.25, W, skyH * 0.75, x, y, w, gy - y);
  const span = 230;
  const sc = w / span;
  const hh = Math.round(HILL_H * sc);
  ctx.drawImage(Lt.hills, mid - span / 2, 0, span, HILL_H, x, gy - hh + 3, w, hh);
  const lh = Math.round(LAND_H * sc);
  ctx.drawImage(Lt.land, mid - span / 2, 0, span, LAND_H, x, gy - lh + 2, w, lh);
  const th = Math.round(96 * sc);
  ctx.drawImage(Lt.trees, mid - span / 2, 0, span, 96, x, gy - th + 4, w, th);
  const cp = t.courtPalette;
  for (let yy = gy; yy < y + h; yy++) rect(x, yy, w, 1, Math.floor((yy - gy) / 3) % 2 ? cp.alt : cp.court);
  const cx = x + w / 2;
  const top = Math.round(w * 0.26);
  const bot = Math.round(w * 0.44);
  line(cx - top, gy + 1, cx - bot, y + h - 1, t.courtLineColor);
  line(cx + top, gy + 1, cx + bot, y + h - 1, t.courtLineColor);
  rect(cx - top, gy + 1, top * 2, 1, t.courtLineColor);
  rect(cx, gy + 1, 1, Math.round((y + h - gy) * 0.5), t.courtLineColor);
}

function makeLayers(id, T) {
  // Building draws into scratch layers; put back whatever was being drawn to
  // (a panel mid-animation, say), or the rest of that frame lands elsewhere.
  const was = ctx;
  const rnd = mulberry(20261013 + id.length * 977);
  const out = {};
  const LW = W + M * 2;
  const mid = M + Math.round(W / 2);

  // Sky: banded dusk gradient with dithered seams.
  const SKY = T.sky;
  const skyH = Math.round(0.58 * H) + 14;
  // Written straight into pixels: drawing it one rectangle per pixel froze
  // the game for a moment the first time a country appeared.
  const sky = makeLayer(W, skyH);
  const img = sky.createImageData(W, skyH);
  const px = new Uint32Array(img.data.buffer);
  const rgba = SKY.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16); // little-endian ABGR
  });
  for (let y = 0; y < skyH; y++) {
    const f = Math.pow(y / (skyH - 1), 1.25) * (SKY.length - 1);
    const i = Math.min(SKY.length - 2, Math.floor(f));
    const frac = Math.max(0, Math.min(1, (f - i - 0.3) / 0.4));
    for (let x = 0; x < W; x++) px[y * W + x] = bayer(x, y) < frac ? rgba[i + 1] : rgba[i];
  }
  sky.putImageData(img, 0, 0);
  out.sky = sky.canvas;
  out.stars = [];
  for (let i = 0; i < Math.round(W / 14); i++) out.stars.push({ x: rnd() * W, y: rnd() * skyH * 0.32, p: rnd() * 6.28, f: 0.6 + rnd() * 1.6 });

  // Clouds drift on their own wrapping strip.
  const cw = W + 90;
  const clouds = makeLayer(cw, skyH);
  setTarget(clouds);
  for (let i = 0; i < Math.round(cw / 34); i++) {
    const y = 6 + rnd() * skyH * 0.62;
    const len = 18 + rnd() * 46;
    const x = rnd() * (cw - len);
    const c = y / skyH > 0.4 ? T.clouds[1] : T.clouds[0];
    rect(x, y, len, 1, c);
    rect(x + 4, y + 1, len - 10, 1, c);
    if (rnd() < 0.5) rect(x + 10, y - 1, len - 22, 1, c);
  }
  out.clouds = clouds.canvas;

  // Distant hills, and whatever stands far off on them.
  const hills = makeLayer(LW, HILL_H);
  setTarget(hills);
  if (id === 'japan') fuji(mid + 34, HILL_H, T);
  for (let x = 0; x < LW; x++) {
    const a = 14 + Math.sin(x * 0.035 + 1) * 6 + Math.sin(x * 0.09) * 3;
    rect(x, HILL_H - a - 10, 1, a + 10, T.hills[0]);
    const b = 10 + Math.sin(x * 0.05 + 4) * 5 + Math.sin(x * 0.13 + 2) * 2;
    rect(x, HILL_H - b, 1, b, T.hills[1]);
  }
  if (id === 'india') hillFort(mid + 70, HILL_H - 26, T, rnd);
  out.hills = hills.canvas;

  // Landmarks, between the hills and the trees.
  const land = makeLayer(LW, LAND_H);
  setTarget(land);
  if (id === 'japan') {
    pagoda(mid - 58, LAND_H);
    torii(mid + 62, LAND_H);
  } else if (id === 'newyork') {
    skyline(LW, LAND_H, rnd, mid);
  } else if (id === 'london') {
    westminster(mid, LAND_H, rnd);
  } else if (id === 'india') {
    palace(mid, LAND_H, rnd);
  }
  out.land = land.canvas;

  // Trees: kept to the sides so the landmarks show between them.
  const trees = makeLayer(LW, 96);
  setTarget(trees);
  const tc = T.trees;
  const cypress = (x, h, w) => {
    for (let i = 0; i < h; i++) {
      const t = i / h;
      const half = Math.max(0, Math.round(w * Math.min(1, Math.pow(t * 1.9, 0.75)) * (t > 0.86 ? 1 - (t - 0.86) * 2 : 1)));
      rect(x - half, 96 - h + i, half * 2 + 1, 1, tc.dark);
      if (half > 1 && rnd() < 0.55) rect(x + half - 1, 96 - h + i, 1, 1, tc.hi);
      if (half > 2 && rnd() < 0.3) rect(x - half + 1 + rnd() * half, 96 - h + i, 1, 1, tc.shade);
    }
  };
  const bush = (x, y, r, c1 = tc.bush, c2 = tc.bushHi, sp = [tc.hi, tc.shade]) => {
    disc(x, y, r, c1);
    disc(x - r * 0.3, y - r * 0.3, r * 0.6, c2);
    for (let i = 0; i < r * 2; i++) {
      const a = rnd() * 6.28;
      const d = rnd() * r;
      rect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1, 1, sp[rnd() < 0.5 ? 0 : 1]);
    }
  };
  const side = (x) => Math.abs(x - mid) > Math.min(110, W * 0.3);
  for (let x = 10; x < LW; x += 34) bush(x + rnd() * 10, 86 - rnd() * 6, 10 + rnd() * 5);
  if (id === 'japan') {
    for (let x = 6; x < LW; x += 26 + rnd() * 16) if (side(x)) blossomTree(x, 96, 18 + rnd() * 8, T.blossom, rnd);
    for (let x = 8; x < LW; x += 40 + rnd() * 20) if (side(x) && rnd() < 0.5) cypress(x, 46 + rnd() * 20, 3 + rnd() * 2);
  } else if (id === 'india') {
    for (let x = 6; x < LW; x += 22 + rnd() * 18) if (side(x)) palm(x, 96, 40 + rnd() * 22, rnd() < 0.5 ? -1 : 1, tc);
    for (let x = 12; x < LW; x += 36) if (side(x)) bush(x + rnd() * 8, 82, 9 + rnd() * 4);
  } else if (id === 'london') {
    for (let x = 4; x < LW; x += 24 + rnd() * 12) if (side(x)) { bush(x, 60 + rnd() * 10, 14 + rnd() * 6); bush(x + 8, 50 + rnd() * 10, 10 + rnd() * 5); }
    for (let x = 8; x < LW; x += 30 + rnd() * 14) if (side(x) && rnd() < 0.6) cypress(x, 56 + rnd() * 24, 4 + rnd() * 2);
  } else {
    for (let x = 8, i = 0; x < LW; x += 18 + rnd() * 14, i++) if (side(x)) cypress(x, 48 + rnd() * 34 - (i % 3) * 6, 4 + rnd() * 3);
  }
  out.trees = trees.canvas;

  // Hedge, wall, lantern pillars and flowering planters.
  const wc = T.wall;
  const wy = LAYER_H - WALL_H;
  const paintWall = (rnd, pillars) => {
    const wall = makeLayer(LW, LAYER_H);
    setTarget(wall);
    for (let x = 0; x < LW; x++) {
      const top = wy - 24 + Math.round(Math.sin(x * 0.4) * 0.6 + rnd() * 1.4);
      rect(x, top, 1, wy - top + 2, '#1c4427');
    }
    for (let i = 0; i < LW * 1.75; i++) rect(rnd() * LW, wy - 23 + rnd() * 24, 1, 1, rnd() < 0.55 ? '#2a5f35' : '#133120');
    for (let x = 0; x < LW; x += 2) if (rnd() < 0.5) rect(x, wy - 24, 1, 1, '#34743f');
    rect(0, wy, LW, WALL_H, wc.base);
    rect(0, wy, LW, 2, wc.top);
    rect(0, wy + 2, LW, 1, wc.top2);
    for (let r = 0; r < 3; r++) {
      const y = wy + 5 + r * 4;
      rect(0, y, LW, 1, wc.line);
      for (let x = (r % 2) * 6; x < LW; x += 12) rect(x, y - 3, 1, 3, wc.line);
    }
    for (let i = 0; i < LW / 4; i++) rect(rnd() * LW, wy + 3 + rnd() * 10, 1, 1, wc.speck[rnd() < 0.5 ? 0 : 1]);
    rect(0, LAYER_H - 1, LW, 1, '#35322e');
    for (const lx of pillars) {
      rect(lx - 5, wy - 4, 11, WALL_H + 4, wc.pillar);
      rect(lx - 6, wy - 5, 13, 2, wc.pillarTop);
      rect(lx - 5, LAYER_H - 1, 11, 1, '#35322e');
      rect(lx + 4, wy - 3, 1, WALL_H + 2, wc.line);
      rect(lx - 3, wy - 15, 7, 10, '#231f1a');
      rect(lx - 2, wy - 13, 5, 7, T.lamp);
      rect(lx - 1, wy - 12, 3, 5, '#fff3b8');
      rect(lx - 4, wy - 16, 9, 1, '#231f1a');
      rect(lx - 1, wy - 18, 3, 2, '#231f1a');
    }
    const flowers = T.blossom ? [T.blossom[2], T.blossom[3]] : ['#f1eedd', '#c9d3b6'];
    const beds = [M + 12, M + W - 12];
    for (let x = W / 2 - 150; x > 40; x -= 70) beds.push(M + x, M + W - x);
    for (const bx of beds) {
      for (let i = 0; i < 6; i++) {
        const x = bx + (rnd() - 0.5) * 34;
        const y = wy - 2 + (rnd() - 0.5) * 12;
        const r = 6 + rnd() * 5;
        disc(x, y, r, '#214a2b');
        disc(x - 1, y - 2, r * 0.6, '#2c6238');
        for (let k = 0; k < 7; k++) {
          const a = rnd() * 6.28;
          const d = rnd() * r;
          rect(x + Math.cos(a) * d, y + Math.sin(a) * d, rnd() < 0.3 ? 2 : 1, 1, rnd() < 0.7 ? flowers[0] : flowers[1]);
        }
      }
    }
    return wall.canvas;
  };
  out.wall = paintWall(rnd, lanterns);

  // Foreground canopy framing the top corners (blossom in Japan).
  const fore = makeLayer(LW, 190);
  setTarget(fore);
  const leaf = T.blossom ? ['#7a2f57', '#b8507f', T.blossom[2], '#5c2242'] : ['#102b1b', '#17402a', '#245a34', '#0b2014'];
  const canopy = (cx, cy, n, spread) => {
    for (let i = 0; i < n; i++) {
      const x = cx + (rnd() - 0.5) * spread;
      const y = cy + (rnd() - 0.5) * spread * 0.9;
      const r = 7 + rnd() * 9;
      disc(x, y, r, leaf[0]);
      disc(x - 2, y - 2, r * 0.55, leaf[1]);
      for (let k = 0; k < r; k++) {
        const a = rnd() * 6.28;
        const d = rnd() * r;
        rect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1, 1, rnd() < 0.5 ? leaf[2] : leaf[3]);
      }
    }
  };
  canopy(M - 4, 20, 22, 74);
  canopy(LW - M + 4, 26, 24, 80);
  const low = 60 + Math.round(H * 0.12);
  canopy(M - 14, low, 12, 34);
  canopy(LW - M + 14, low + 6, 12, 34);
  out.fore = fore.canvas;

  // Bushes in the bottom corners, drawn over the grass during play.
  const bushes = makeLayer(80, 44);
  setTarget(bushes);
  for (let i = 0; i < 9; i++) {
    const x = 6 + rnd() * 44;
    const y = 18 + rnd() * 26 + x * 0.25;
    const r = 7 + rnd() * 8;
    disc(x, y, r, '#0f2a19');
    disc(x - 2, y - 2, r * 0.6, '#1b4428');
    for (let k = 0; k < r * 1.5; k++) {
      const a = rnd() * 6.28;
      const d = rnd() * r;
      rect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1, 1, T.blossom && rnd() < 0.3 ? T.blossom[1] : rnd() < 0.5 ? '#2f6b3d' : '#0a1f12');
    }
  }
  out.bushes = bushes.canvas;

  setTarget(was);
  return out;
}

// ---- landmark painters (all draw upward from a ground line y0) -------------

function fuji(cx, y0, T) {
  const h = 46;
  for (let i = 0; i < h; i++) {
    const half = 6 + Math.round(i * 2.1 + (i > h * 0.6 ? (i - h * 0.6) * 1.2 : 0));
    const y = y0 - h - 6 + i;
    rect(cx - half, y, half, 1, '#3d3a6a');
    rect(cx, y, half, 1, '#4a4578');
    if (i < 11 + ((cx + i) % 3)) {
      rect(cx - half, y, half * 2, 1, i < 3 ? '#ffffff' : '#e6e1f0');
    } else if (i < 15 && (i + Math.floor(half / 3)) % 2 === 0) {
      rect(cx - half + 2, y, 3, 1, '#d8d2e8');
      rect(cx + half - 5, y, 3, 1, '#d8d2e8');
    }
  }
  void T;
}

function pagoda(cx, y0) {
  let y = y0 - 4;
  for (let i = 0; i < 5; i++) {
    const bw = 22 - i * 3;
    const bh = i === 0 ? 9 : 6;
    rect(cx - bw / 2, y - bh, bw, bh, '#6b2a2a');
    rect(cx - bw / 2 + 2, y - bh + 2, bw - 4, 2, '#ffcf7a');
    for (let k = cx - bw / 2 + 4; k < cx + bw / 2 - 3; k += 4) rect(k, y - bh + 2, 1, 2, '#6b2a2a');
    y -= bh;
    const rw = bw + 12;
    rect(cx - rw / 2, y - 2, rw, 2, '#2b1a24');
    rect(cx - rw / 2 + 2, y - 4, rw - 4, 2, '#3a2230');
    rect(cx - rw / 2 - 1, y - 3, 2, 1, '#2b1a24');
    rect(cx + rw / 2 - 1, y - 3, 2, 1, '#2b1a24');
    y -= 4;
  }
  rect(cx - 1, y - 10, 2, 10, '#2b1a24');
  for (let k = 0; k < 4; k++) rect(cx - 2, y - 3 - k * 2, 4, 1, '#3a2230');
}

function torii(cx, y0) {
  const red = '#c8352e';
  const dark = '#7c1f1c';
  rect(cx - 15, y0 - 34, 3, 34, red);
  rect(cx + 12, y0 - 34, 3, 34, red);
  rect(cx - 15, y0 - 34, 1, 34, dark);
  rect(cx + 12, y0 - 34, 1, 34, dark);
  rect(cx - 19, y0 - 27, 38, 3, red);
  rect(cx - 22, y0 - 37, 44, 3, red);
  rect(cx - 24, y0 - 39, 48, 2, '#2b1a24');
  rect(cx - 25, y0 - 40, 3, 1, '#2b1a24');
  rect(cx + 22, y0 - 40, 3, 1, '#2b1a24');
  rect(cx - 1, y0 - 34, 2, 7, red);
}

function skyline(LW, y0, rnd, mid) {
  const body = '#141C2C';
  const lit = (x, y, w, h) => {
    for (let wy = y + 3; wy < y0 - 6; wy += 4) {
      for (let wx = x + 2; wx < x + w - 2; wx += 3) if (rnd() < 0.28) rect(wx, wy, 1, 2, rnd() < 0.75 ? '#FFC76A' : '#ff9b4a');
    }
  };
  // Bridge off to one side: two towers, cables, a deck.
  const bx = mid + 74;
  rect(bx - 40, y0 - 22, 80, 2, '#1d2638');
  for (const tx of [bx - 26, bx + 22]) {
    rect(tx, y0 - 48, 4, 48, '#1d2638');
    rect(tx - 1, y0 - 48, 6, 2, '#2a3550');
    rect(tx + 1, y0 - 42, 2, 6, '#0c1220');
  }
  for (let x = bx - 40; x <= bx + 40; x++) {
    const d = Math.min(Math.abs(x - (bx - 24)), Math.abs(x - (bx + 24)));
    const sag = x > bx - 24 && x < bx + 24 ? 26 - Math.round(((48 - Math.abs(x - bx) * 2) / 48) * 18) : 26 - Math.min(18, d);
    rect(x, y0 - 22 - sag, 1, 1, '#3a4664');
    if (x % 4 === 0) rect(x, y0 - 22 - sag, 1, sag, '#232d44');
  }
  // Towers across the rest of the view.
  for (let x = 0; x < LW; ) {
    const w = 8 + Math.round(rnd() * 12);
    if (x > bx - 44 && x < bx + 44) {
      x += w;
      continue;
    }
    const near = Math.abs(x - (mid - 30)) < 60;
    const h = 22 + Math.round(rnd() * (near ? 46 : 30));
    rect(x, y0 - h, w, h, body);
    rect(x, y0 - h, w, 1, '#222c42');
    lit(x, y0 - h, w, h);
    x += w + (rnd() < 0.3 ? 2 : 0);
  }
  // A stepped tower with a spire, and a statue on a plinth.
  const ex = mid - 26;
  rect(ex - 8, y0 - 62, 16, 62, body);
  rect(ex - 5, y0 - 70, 10, 8, body);
  rect(ex - 3, y0 - 76, 6, 6, body);
  rect(ex - 1, y0 - 86, 2, 10, '#222c42');
  lit(ex - 8, y0 - 62, 16, 62);
  const sx = mid - 92;
  rect(sx - 4, y0 - 14, 9, 14, '#24343a');
  rect(sx - 2, y0 - 26, 5, 12, '#3f6b62');
  rect(sx - 1, y0 - 30, 3, 4, '#3f6b62');
  rect(sx + 2, y0 - 36, 1, 10, '#3f6b62');
  rect(sx + 1, y0 - 38, 3, 2, '#ffc76a');
}

function westminster(mid, y0, rnd) {
  const stone = '#34353A';
  // Long hall with a row of small spires and lit windows.
  const x0 = mid - 70;
  const x1 = mid + 90;
  rect(x0, y0 - 26, x1 - x0, 26, stone);
  for (let x = x0; x < x1; x += 7) {
    rect(x, y0 - 30, 2, 4, stone);
    rect(x, y0 - 33, 1, 3, '#44454b');
  }
  for (let x = x0 + 3; x < x1 - 3; x += 5) if (rnd() < 0.55) rect(x, y0 - 20, 2, 3, '#ffc66b');
  rect(mid + 52, y0 - 44, 14, 44, stone);
  rect(mid + 54, y0 - 50, 10, 6, stone);
  rect(mid + 58, y0 - 58, 2, 8, '#44454b');
  // The clock tower.
  const tx = mid - 34;
  rect(tx - 7, y0 - 74, 14, 74, stone);
  rect(tx - 7, y0 - 74, 2, 74, '#44454b');
  rect(tx - 8, y0 - 76, 16, 3, '#44454b');
  disc(tx, y0 - 66, 5, '#e8e4c9');
  rect(tx, y0 - 69, 1, 3, '#2a2a2e');
  rect(tx, y0 - 66, 3, 1, '#2a2a2e');
  rect(tx - 5, y0 - 84, 10, 8, stone);
  rect(tx - 3, y0 - 90, 6, 6, stone);
  rect(tx - 1, y0 - 96 + 6, 2, 4, '#44454b');
  for (let y = y0 - 56; y < y0 - 4; y += 7) rect(tx - 3, y, 2, 3, '#ffc66b');
  // A bridge in front, low.
  rect(mid - 110, y0 - 10, 220, 3, '#2c2d31');
  for (let x = mid - 104; x < mid + 110; x += 22) rect(x, y0 - 7, 3, 7, '#2c2d31');
}

function palace(mid, y0, rnd) {
  const sand = '#B97750';
  const hi = '#E0AE78';
  const arch = '#5a2f22';
  const x0 = mid - 84;
  const x1 = mid + 84;
  rect(x0, y0 - 30, x1 - x0, 30, sand);
  rect(x0, y0 - 31, x1 - x0, 2, hi);
  for (let x = x0 + 2; x < x1; x += 4) rect(x, y0 - 33, 2, 2, hi);
  // Two storeys of arches.
  for (const [row, ay] of [[0, y0 - 26], [1, y0 - 14]]) {
    for (let x = x0 + 4; x < x1 - 6; x += 9) {
      rect(x, ay + 2, 5, 7, row && rnd() < 0.3 ? '#ffc96b' : arch);
      rect(x + 1, ay + 1, 3, 1, arch);
    }
  }
  // Central block and dome.
  rect(mid - 22, y0 - 46, 44, 16, sand);
  rect(mid - 22, y0 - 47, 44, 2, hi);
  for (let x = mid - 18; x < mid + 18; x += 9) rect(x, y0 - 42, 5, 9, arch);
  for (let i = 0; i < 16; i++) {
    const half = Math.round(Math.sin((i / 16) * Math.PI * 0.95 + 0.15) * 15);
    rect(mid - half, y0 - 47 - 16 + i, half * 2, 1, i < 4 ? hi : sand);
  }
  rect(mid - 1, y0 - 70, 2, 7, hi);
  rect(mid - 2, y0 - 68, 4, 2, hi);
  // Small domed pavilions on the corners.
  for (const cx of [x0 + 10, x1 - 10, mid - 46, mid + 46]) {
    rect(cx - 6, y0 - 40, 12, 9, sand);
    rect(cx - 4, y0 - 37, 3, 6, arch);
    rect(cx + 1, y0 - 37, 3, 6, arch);
    for (let i = 0; i < 6; i++) {
      const half = Math.round(Math.sin((i / 6) * Math.PI * 0.9 + 0.2) * 6);
      rect(cx - half, y0 - 46 + i, half * 2, 1, i < 2 ? hi : sand);
    }
    rect(cx, y0 - 49, 1, 3, hi);
  }
}

function hillFort(cx, y, T, rnd) {
  rect(cx - 30, y, 60, 6, T.hills[0]);
  for (let x = cx - 30; x < cx + 30; x += 4) rect(x, y - 2, 2, 2, T.hills[0]);
  for (const tx of [cx - 30, cx + 26, cx - 4]) rect(tx, y - 7, 5, 7, T.hills[0]);
  void rnd;
}

function blossomTree(x, y0, h, B, rnd) {
  rect(x - 1, y0 - h, 3, h, '#3a2228');
  rect(x + 1, y0 - h + 6, 4, 1, '#3a2228');
  for (let i = 0; i < 7; i++) {
    const bx = x + (rnd() - 0.5) * 22;
    const by = y0 - h - 4 + (rnd() - 0.5) * 14;
    const r = 5 + rnd() * 5;
    disc(bx, by, r, B[0]);
    disc(bx - 1, by - 1, r * 0.7, B[1]);
    for (let k = 0; k < r * 1.5; k++) {
      const a = rnd() * 6.28;
      const d = rnd() * r;
      rect(bx + Math.cos(a) * d, by + Math.sin(a) * d, 1, 1, rnd() < 0.5 ? B[2] : B[3]);
    }
  }
}

function palm(x, y0, h, lean, tc) {
  let px = x;
  for (let i = 0; i < h; i++) {
    const t = i / h;
    px = x + lean * Math.round(t * t * 8);
    rect(px - 1, y0 - i, 2, 1, i % 3 ? '#4a3524' : '#3a2a1c');
  }
  const top = y0 - h;
  for (let f = 0; f < 7; f++) {
    const a = Math.PI * (0.1 + (0.8 * f) / 6);
    for (let k = 1; k < 13; k++) {
      const fx = px + Math.round(-Math.cos(a) * k);
      const fy = top + Math.round(-Math.sin(a) * k * 0.5 + (k * k) / 26);
      rect(fx, fy, 2, 1, k > 9 ? tc.hi : tc.dark);
    }
  }
}

const COURT_LINES = [
  [6, -30, 6, WH + 40],
  [194, -30, 194, WH + 40],
  [30, -30, 30, WH + 40],
  [170, -30, 170, WH + 40],
  [100, -30, 100, 120],
  [30, 120, 170, 120],
  [6, WH - 26, 194, WH - 26],
];

const wrap = (v, n) => ((v % n) + n) % n;

// Sky, stars, drifting clouds and the occasional flock. ref is the horizon
// height the flock keeps clear of.
// The whole gradient is fitted between the top of the screen and the
// horizon, so each theme's sunset colours show in play as well as in menus.
function drawSky(time, skyY, ref, horizon) {
  const sh = L.sky.height;
  const dh = Math.max(40, Math.round(horizon - skyY));
  const k = dh / sh;
  ctx.drawImage(L.sky, 0, 0, W, sh, 0, skyY, W, dh);
  drawSun(horizon);
  for (const s of L.stars) {
    const tw = Math.sin(time * s.f + s.p);
    const sy = Math.round(s.y * k) + skyY;
    if (tw > -0.3) rect(s.x, sy, 1, 1, tw > 0.75 ? '#ffffff' : '#cdbfe0');
    if (tw > 0.93) rect(s.x - 1, sy, 3, 1, '#cdbfe0');
  }
  const cw = L.clouds.width;
  const cx0 = -wrap(time * 3.6 - P.shift * P.sRef, cw);
  ctx.drawImage(L.clouds, 0, 0, cw, sh, Math.round(cx0), skyY, cw, dh);
  ctx.drawImage(L.clouds, 0, 0, cw, sh, Math.round(cx0) + cw, skyY, cw, dh);
  const bt = wrap(time, 23);
  if (bt < 14) {
    const flap = Math.floor(time * 5) & 1;
    for (let i = 0; i < 4; i++) {
      const bx = -20 + (bt / 14) * (W + 60) - i * 9 - (i & 1) * 3;
      const by = ref * 0.22 + Math.sin(time * 0.9 + i) * 3 + i * 4 + skyY;
      rect(bx, by, 1, 1, '#2a1f33');
      rect(bx - 1, by - (flap ? 1 : -1), 1, 1, '#2a1f33');
      rect(bx + 1, by - (flap ? 1 : -1), 1, 1, '#2a1f33');
    }
  }
}

export function drawScene(time) {
  const dt = lastT == null ? 0 : Math.max(0, Math.min(0.1, time - lastT));
  lastT = time;
  if (fadeT < 1 && prev) {
    fadeT = Math.min(1, fadeT + dt / FADE);
    if (!fadeLayer || fadeLayer.canvas.width !== W || fadeLayer.canvas.height !== H) fadeLayer = makeLayer(W, H);
    const now = theme;
    const nowL = L;
    const was = ctx;
    theme = prev;
    L = layersFor(prev);
    setTarget(fadeLayer);
    fadeLayer.setTransform(1, 0, 0, 1, 0, 0);
    fadeLayer.clearRect(0, 0, W, H);
    drawSceneOnce(time);
    setTarget(was);
    theme = now;
    L = nowL;
    drawSceneOnce(time);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1 - fadeT;
    ctx.drawImage(fadeLayer.canvas, 0, 0);
    ctx.restore();
    if (fadeT >= 1) prev = null;
    return;
  }
  drawSceneOnce(time);
}

function drawSceneOnce(time) {
  const cam = P.cam;
  const wb = P.wb;
  const sFar = P.kx / P.dFar;
  // How far each depth slides as the camera trucks sideways.
  const wallS = Math.round(P.shift * (P.sRef - sFar));
  const treeS = Math.round(P.shift * (P.sRef - sFar * 0.6));
  const hillS = Math.round(P.shift * (P.sRef - sFar * 0.3));

  drawSky(time, Math.round(-cam * 12), wb, wb - WALL_H - 18);

  const wallTop = wb - WALL_H;
  ctx.drawImage(L.hills, -M + hillS, Math.round(wallTop - HILL_H - 30 + cam * 16));
  const landS = Math.round(P.shift * (P.sRef - sFar * 0.45));
  ctx.drawImage(L.land, -M + landS, Math.round(wallTop - LAND_H - 22 + cam * 4));
  ctx.drawImage(L.trees, -M + treeS, Math.round(wallTop - 96 - 12 + cam * 9));
  ctx.drawImage(L.wall, -M + wallS, wb - LAYER_H);
  if (P.banner) {
    drawStands(time);
    drawBanner(time);
  }

  // Grass with mowing stripes.
  const cp = theme.courtPalette;
  for (let y = wb; y < H; y++) {
    const wy = unprojY(y + 0.5);
    const stripe = Math.floor((wy + 2000) / 22) & 1;
    ctx.fillStyle = stripe ? cp.alt : cp.court;
    ctx.fillRect(0, y, W, 1);
  }
  rect(0, wb, W, 2, shade(cp.court, -0.25));
  const spLight = shade(cp.alt, 0.18);
  const spDark = shade(cp.court, -0.18);
  for (const s of speckles) {
    const p = proj(s.x, s.y);
    if (p.y < wb + 2 || p.y >= H) continue;
    rect(p.x, p.y, s.wide && p.s > 0.8 ? 2 : 1, 1, s.light ? spLight : spDark);
  }

  // Court markings.
  ctx.globalAlpha = 0.82;
  for (const [x0, y0, x1, y1] of COURT_LINES) {
    const a = proj(x0, y0);
    const b = proj(x1, y1);
    if (y0 === y1) rect(a.x, a.y, b.x - a.x, a.s > 0.95 ? 2 : 1, theme.courtLineColor);
    else line(a.x, Math.max(a.y, wb + 2), b.x, b.y, theme.courtLineColor, b.s > 0.95 ? 2 : 1);
  }
  ctx.globalAlpha = 1;

  // A thin hedge line marks the side walls once play is in view.
  if (cam > 0.45) {
    ctx.globalAlpha = Math.min(1, (cam - 0.45) / 0.3);
    for (const side of [-1, 1]) {
      const wx = side < 0 ? -3 : WW + 3;
      const a = proj(wx, -6);
      const b = proj(wx, WH + 40);
      line(a.x - 1, wb + 2, b.x - 2, b.y, '#1c4427', 2); // a single, quiet edge
    }
    ctx.globalAlpha = 1;
  }

  // Stands and lamps down both sides once play is in view.
  if (cam > 0.45 && P.landing < 1) {
    ctx.globalAlpha = Math.min(1, (cam - 0.45) / 0.3);
    drawSides(time);
    ctx.globalAlpha = 1;
  }

  // The net lowers out of the way as the camera rises.
  if (cam < 0.55) {
    const k = (1 - cam / 0.55) * (1 - P.landing);
    const nh = Math.round(13 * k);
    const y0 = wb + 7;
    const nx = Math.round(W / 2 - 98) + wallS;
    if (nh > 1) {
      ctx.globalAlpha = 0.3;
      rect(nx, y0, 196, 2, '#000');
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.6;
      rect(nx, y0 - nh, 196, nh, '#162019');
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0c130e';
      for (let y = y0 - nh + 2; y < y0; y += 2) {
        for (let x = nx + (y & 2 ? 1 : 0); x < nx + 196; x += 2) ctx.fillRect(x, y, 1, 1);
      }
      rect(nx, y0 - nh, 196, 2, '#ecefdc');
      rect(nx + 97, y0 - nh, 2, nh, '#d9dcc8');
    }
    if (nh > 1) {
      rect(nx - 2, y0 - nh - 2, 2, nh + 3, '#22241f');
      rect(nx + 196, y0 - nh - 2, 2, nh + 3, '#22241f');
    }
  }

  // Lantern glow (the menus only: the courts are kept clear).
  const flick = Math.sin(time * 7) > 0.6 ? 1 : 0;
  for (const l of P.banner ? [] : lanterns) {
    const lx = l - M + wallS;
    const ly = wb - WALL_H - 10;
    ctx.globalAlpha = 0.14;
    disc(lx, ly, 9 + flick, theme.backgroundPalette.lamp);
    ctx.globalAlpha = 0.22;
    disc(lx, ly, 5, '#ffe08a');
    ctx.globalAlpha = 0.1;
    ellipse(lx, wb + 5, 14, 3, '#ffe08a');
    ctx.globalAlpha = 1;
  }

  // Fireflies along the hedge (the menus only).
  for (const f of P.banner ? [] : flies) {
    const glow = Math.sin(time * f.f * 1.7 + f.p);
    if (glow < 0) continue;
    const x = wrap(f.x + Math.sin(time * 0.4 * f.f + f.p) * 16 + wallS, W);
    const y = wb - 34 + f.y * 30 + Math.cos(time * 0.6 * f.f + f.p) * 5;
    ctx.globalAlpha = 0.25 * glow;
    rect(x - 1, y - 1, 3, 3, '#fff3a0');
    ctx.globalAlpha = glow;
    rect(x, y, 1, 1, '#fffbd0');
    ctx.globalAlpha = 1;
  }

  // Petals drifting across the whole view.
  const amb = theme.ambientEffects;
  if (amb.petals && !P.banner) {
    for (const q of petals) {
      if (q.k * 2 > amb.petalRate) continue; // denser in Japan, sparse elsewhere
      const y = wrap(q.y * H + time * q.v, H + 10) - 5;
      const x = wrap(q.x + time * q.v * 0.7 + Math.sin(time * 1.3 + q.p) * 6, W + 10) - 5;
      rect(x, y, 1, 1, amb.petals);
      if (Math.sin(time * 3 + q.p) > 0) rect(x + 1, y, 1, 1, amb.petalsHi);
    }
  }

  if (cam > 0.45 && P.landing < 1 && !P.banner) {
    ctx.globalAlpha = Math.min(1, (cam - 0.45) / 0.3);
    const bh = L.bushes.height;
    ctx.drawImage(L.bushes, -12, H - bh + 6);
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(L.bushes, -W - 12, H - bh + 8);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  const sway = Math.round(Math.sin(time * 0.8) * 1.4);
  if (P.landing < 1) ctx.drawImage(L.fore, -M + sway - Math.round(P.shift * 0.5), Math.round(-cam * 34 - 4 - P.landing * 110));
}

// A low sun on the horizon (or a moon high up on a Black Court).
function drawSun(horizon) {
  const sun = theme.backgroundPalette.sun;
  if (theme.isBlackCourt) {
    const mx = Math.round(W * 0.78 + P.shift * 0.1);
    const my = Math.round(Math.max(14, horizon * 0.3));
    ctx.globalAlpha = 0.18;
    disc(mx, my, 9, '#f4f0d8');
    ctx.globalAlpha = 1;
    disc(mx, my, 5, '#f4f0d8');
    rect(mx + 1, my - 2, 2, 1, '#d8d2b4');
    rect(mx - 2, my + 1, 1, 1, '#d8d2b4');
    return;
  }
  if (!sun) return;
  const sx = Math.round(W / 2 + sun.x + P.shift * 0.05);
  const sy = Math.round(horizon - sun.lift);
  ctx.globalAlpha = 0.22;
  disc(sx, sy, sun.r + 5, sun.glow);
  ctx.globalAlpha = 1;
  disc(sx, sy, sun.r, sun.c);
  for (let i = 2; i < sun.r; i += 3) rect(sx - sun.r, sy + i, sun.r * 2 + 1, 1, sun.band);
}

// Lighten (k > 0) or darken (k < 0) a #rrggbb colour.
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k));
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('');
}

// Stands down both sides of the court: three plain stepped tiers of fans
// in front of a back wall. In front of them, by
// the court, each country's own street lamps (see LAMP_STYLES).
const SIDE_TIERS = [
  { x0: -12, x1: -21, z: 5 },
  { x0: -21, x1: -30, z: 11 },
  { x0: -30, x1: -39, z: 17 },
];
const SIDE_WALL = 27; // the back wall's height
const LAMPS = [8, 92, 176, 260];
function drawSides(time) {
  const a0 = ctx.globalAlpha;
  const night = theme.isBlackCourt;
  const far = -6;
  const near = WH + 40;
  const back = SIDE_TIERS[SIDE_TIERS.length - 1].x1;
  for (const side of [-1, 1]) {
    const X = (wx) => (side < 0 ? wx : WW - wx);
    // The back wall, plain.
    quad(proj(X(back), far, 0), proj(X(back), near, 0), proj(X(back), near, SIDE_WALL), proj(X(back), far, SIDE_WALL), crowdColours().stand.face);
    let zBelow = 0;
    for (const t of SIDE_TIERS) {
      // The riser (facing the court), then the tread the fans stand on.
      quad(proj(X(t.x0), far, zBelow), proj(X(t.x0), near, zBelow), proj(X(t.x0), near, t.z), proj(X(t.x0), far, t.z), crowdColours().stand.face);
      quad(proj(X(t.x0), far, t.z), proj(X(t.x0), near, t.z), proj(X(t.x1), near, t.z), proj(X(t.x1), far, t.z), crowdColours().stand.top);
      zBelow = t.z;
    }
  }
  // Fans, back tier first and far to near, so nearer ones overlap.
  for (let row = SIDE_TIERS.length - 1; row >= 0; row--) {
    const t = SIDE_TIERS[row];
    for (let i = 0, wy = far + 4; wy < near; wy += 7, i++) {
      for (const side of [-1, 1]) {
        const k = i * 2 + (side > 0 ? 1 : 0);
        if (hash(k, row + 11) > FAN_FILL) continue; // an empty seat
        const wx = (t.x0 + t.x1) / 2 + (hash(k, row + 13) - 0.5) * 3;
        const p = proj(side < 0 ? wx : WW - wx, wy, t.z);
        if (p.y < P.wb) continue;
        const along = (wy - far) / (near - far); // 0 far .. 1 near
        const u = side < 0 ? 0.3 * (1 - along) : 0.7 + 0.3 * along;
        drawFan(p.x, p.y + 1, p.s > 1.2 ? 2 : 1, k, row + 20, time, side < 0 ? wx : WW - wx, wy, u);
      }
    }
  }
  // Lamp posts by the court, far to near.
  const style = LAMP_STYLES[theme.countryId] || LAMP_STYLES.london;
  for (const ly of LAMPS) {
    for (const side of [-1, 1]) {
      const lx = side < 0 ? -8 : WW + 8;
      const b = proj(lx, ly);
      const t = proj(lx, ly, 36);
      if (b.y < P.wb) continue;
      const s = t.s;
      const u = (n) => Math.max(1, Math.round(n * s));
      const flick = 0.85 + 0.15 * Math.sin(time * 7 + ly * 1.3 + side * 2) * Math.sin(time * 2.3 + ly);
      // A warm pool of light on the grass; at night (a Black Court) brighter and wider.
      const glow = night ? 1.6 : 1;
      ctx.globalAlpha = a0 * Math.min(0.3, 0.1 * flick * glow);
      ellipse(b.x + side * u(3), b.y, u(14 * glow), u(4 * glow), style.glow);
      ctx.globalAlpha = a0;
      const light = style.draw(b, t, u, -side, a0);
      ctx.globalAlpha = a0 * Math.min(0.4, 0.14 * flick * glow);
      disc(light.x, light.y, u(13 * Math.sqrt(glow)), style.glow);
      ctx.globalAlpha = a0 * Math.min(0.5, 0.22 * flick * glow);
      disc(light.x, light.y, u(7), style.glow);
      ctx.globalAlpha = a0 * Math.min(0.7, 0.35 * flick * glow);
      disc(light.x, light.y, u(3), style.core);
      ctx.globalAlpha = a0;
    }
  }
}

function quad(a, b, c, d, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(Math.round(a.x), Math.round(a.y));
  ctx.lineTo(Math.round(b.x), Math.round(b.y));
  ctx.lineTo(Math.round(c.x), Math.round(c.y));
  ctx.lineTo(Math.round(d.x), Math.round(d.y));
  ctx.closePath();
  ctx.fill();
}

// Street lights by country. draw(base, top, u, inward, alpha) paints the post
// and lantern (u scales a size to the lamp's distance; inward is +1 toward
// the court) and returns the point the glow comes from.
const LAMP_STYLES = {
  // Japan: a red paper chochin lantern hanging from a wooden post.
  japan: {
    glow: '#ff6a3a',
    core: '#ffd0a0',
    draw(b, t, u, inward) {
      const pw = u(1.6);
      rect(b.x - pw / 2, t.y - u(2), pw, b.y - t.y + u(2), '#3b2618');
      rect(b.x - pw / 2, t.y - u(2), 1, b.y - t.y + u(2), '#6a4a30');
      // A little roof over the post top.
      trap(t.y - u(4), b.x - u(1.5), b.x + u(1.5), t.y - u(2), b.x - u(3.5), b.x + u(3.5), '#22140c');
      // Arm out toward the court, the lantern hanging from its end.
      const ax = b.x + inward * u(5);
      rect(Math.min(b.x, ax), t.y, Math.abs(ax - b.x) + 1, u(1), '#3b2618');
      rect(ax, t.y, 1, u(2), '#22140c');
      const cy = t.y + u(2) + u(4.5);
      const rx = u(3.2);
      const ry = u(4.2);
      ellipse(ax, cy, rx + 1, ry, '#5e100c');
      ellipse(ax, cy, rx, ry - 1, '#d8322a');
      ellipse(ax, cy, Math.max(1, rx - u(1.2)), Math.max(1, ry - u(1.5)), '#ff7a4a');
      for (let dy = -ry + u(1.5); dy < ry - 1; dy += Math.max(2, u(1.6))) rect(ax - rx + 1, cy + dy, rx * 2 - 1, 1, '#a8231c'); // ribs
      rect(ax - u(2), cy - ry - u(1), u(4) + 1, u(1), '#1a1210'); // black caps
      rect(ax - u(2), cy + ry, u(4) + 1, u(1), '#1a1210');
      rect(ax, cy + ry + u(1), 1, u(2), '#f2c230'); // tassel
      return { x: ax, y: cy };
    },
  },
  // New York: a cast-iron "bishop's crook" lamp with a sodium glow.
  newyork: {
    glow: '#ffa640',
    core: '#ffe2a8',
    draw(b, t, u, inward) {
      const pw = u(1.6);
      rect(b.x - u(1.5), b.y - u(4), u(3) + 1, u(4), '#18221d'); // base
      rect(b.x - pw / 2, t.y, pw, b.y - t.y, '#1d2a24');
      rect(b.x - pw / 2, t.y, 1, b.y - t.y, '#3d5248');
      for (const k of [0.35, 0.7]) rect(b.x - u(1.2), t.y + (b.y - t.y) * k, u(2.4) + 1, u(1), '#2c3d35'); // collars
      // The crook: up, over toward the court, and down.
      const ax = b.x + inward * u(5);
      rect(b.x - pw / 2, t.y - u(3), pw, u(3), '#1d2a24');
      rect(Math.min(b.x, ax), t.y - u(3), Math.abs(ax - b.x) + 1, u(1.2), '#1d2a24');
      rect(ax - (inward < 0 ? 0 : u(1)), t.y - u(3), u(1.2), u(2.5), '#1d2a24');
      // Acorn lantern.
      const cy = t.y + u(1.5);
      rect(ax - u(2.5), cy - u(2.2), u(5) + 1, u(1), '#18221d');
      ellipse(ax, cy + u(0.8), u(2.4), u(2.8), '#3a2a14');
      ellipse(ax, cy + u(0.8), u(1.8), u(2.2), '#ffcf7a');
      rect(ax, cy + u(3.4), 1, u(1), '#18221d');
      return { x: ax, y: cy + u(0.8) };
    },
  },
  // London: a black Victorian gas lamp with a ladder bar and a four-pane lantern.
  london: {
    glow: '#ffe1a0',
    core: '#fff6d8',
    draw(b, t, u) {
      const pw = u(1.6);
      rect(b.x - u(2), b.y - u(5), u(4) + 1, u(5), '#121212'); // fluted base
      rect(b.x - u(2) + 1, b.y - u(5), 1, u(5), '#3a3a3a');
      rect(b.x - u(2.5), b.y - u(5) - u(1), u(5) + 1, u(1), '#121212');
      rect(b.x - pw / 2, t.y, pw, b.y - t.y, '#151515');
      rect(b.x - pw / 2, t.y, 1, b.y - t.y, '#444');
      rect(b.x - u(3.5), t.y + u(2), u(7) + 1, u(1), '#151515'); // ladder bar
      // Lantern: tapered glass box, pointed roof, finial.
      const top = t.y - u(7);
      const gw = u(2.6);
      trap(top + u(1.5), b.x - gw - u(0.8), b.x + gw + u(0.8), t.y - u(0.5), b.x - gw + u(0.6), b.x + gw - u(0.6), '#111');
      trap(top + u(2.2), b.x - gw, b.x + gw, t.y - u(1.2), b.x - gw + u(1.2), b.x + gw - u(1.2), '#ffe6a0');
      rect(b.x, top + u(2.2), 1, t.y - top - u(3.4), '#2a2a2a'); // mullion
      trap(top - u(1.5), b.x, b.x + 1, top + u(1.5), b.x - gw - u(1.2), b.x + gw + u(1.2), '#111'); // roof
      rect(b.x, top - u(2.8), 1, u(1.4), '#111'); // finial
      return { x: b.x, y: top + u(3.8) };
    },
  },
  // India: an ornate brass Jaipur lantern, its pierced pattern glowing.
  india: {
    glow: '#ffa23a',
    core: '#ffe3a0',
    draw(b, t, u) {
      const pw = u(1.8);
      rect(b.x - pw / 2, t.y, pw, b.y - t.y, '#8a5a1e');
      rect(b.x - pw / 2, t.y, 1, b.y - t.y, '#e0b45a');
      for (const k of [0.25, 0.5, 0.75]) {
        const y = t.y + (b.y - t.y) * k;
        rect(b.x - u(1.4), y, u(2.8) + 1, u(1), '#c8923a'); // brass rings
      }
      rect(b.x - u(2.2), b.y - u(2), u(4.4) + 1, u(2), '#8a5a1e');
      // Lantern body with a pierced (jaali) pattern, under an onion dome.
      const bw = u(3);
      const top = t.y - u(7);
      rect(b.x - bw - 1, top + u(2), bw * 2 + 3, u(6), '#6a3a0e');
      rect(b.x - bw, top + u(2) + 1, bw * 2 + 1, u(6) - 2, '#c8923a');
      for (let y = top + u(2) + 2; y < top + u(8) - 2; y += 2) {
        for (let x = b.x - bw + 1 + ((y >> 1) & 1); x <= b.x + bw - 1; x += 2) rect(x, y, 1, 1, '#ffd27a');
      }
      ellipse(b.x, top + u(1), bw + 1, u(2), '#a8742a'); // dome
      ellipse(b.x, top + u(1), bw, u(1.4), '#e0b45a');
      rect(b.x, top - u(2), 1, u(2), '#e0b45a'); // finial
      rect(b.x - u(1), t.y, u(2) + 1, u(1), '#6a3a0e');
      return { x: b.x, y: top + u(5) };
    },
  },
};

// The banner's logos, THE COURT (a tennis ball) and COURT BITES (a burger and
// a drink), in 12-bit colour (4 bits per channel, written as 3-digit hex),
// which leaves room for shading: rounded logos and two-tone lettering.
const C12 = {
  o: '#012', // outline
  // tennis ball: shadow, base, light, highlight, seam
  a: '#8a1', y: '#ce3', Y: '#ef6', h: '#ffd', e: '#fff',
  // burger: bun light/mid/dark, sesame, lettuce light/dark, cheese, patty light/dark
  B: '#fd8', b: '#e93', D: '#b62', S: '#ffe', L: '#7e3', l: '#3a2', c: '#fd3', P: '#843', p: '#521',
  // drink: cup light/mid/dark, band light/dark, lid, straw
  R: '#f67', r: '#e23', d: '#a12', w: '#fff', W: '#bcd', i: '#dde', s: '#f45',
};
const LOGO_BALL = [
  '..ooooo..',
  '.ohYeyyo.',
  'oYYyeyyao',
  'oYyyyeyao',
  'oyyyyeyao',
  'oyyyeyyao',
  'oyyeyyaao',
  '.oaaaaao.',
  '..ooooo..',
];
const LOGO_BURGER = [
  '..ooooooo..',
  '.oBBSBBBbo.',
  'oBBbbbSbbbo',
  'obbSbbbbbDo',
  'oLlLlLlLlLo',
  'occcccccc.o',
  'oPPPPPPPPpo',
  'oDbbbbbbbDo',
  '.ooooooooo.',
];
const LOGO_DRINK = ['....wo', '...so.', 'oiiiio', 'oRrrdo', 'owwWWo', 'oRrrdo', 'oRrrdo', '.oddo.'];
function logo(rows, x, y) {
  rows.forEach((row, j) => [...row].forEach((ch, i) => ch !== '.' && C12[ch] && rect(x + i, y + j, 1, 1, C12[ch])));
}
// Two-tone lettering: the lower part in `lo`, the top three rows in `hi`.
const BANNER_SP = 2; // the banner's letter spacing, in pixels
function word(str, x, y, hi, lo) {
  text(str, x, y, lo, { shadow: C12.o, sp: BANNER_SP });
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 1, y, textW(str, 1, BANNER_SP) + 2, 3);
  ctx.clip();
  text(str, x, y, hi, { sp: BANNER_SP });
  ctx.restore();
}

// The crowd. Shirts are muted so the stands sit back behind the play.
const FAN_SKIN = ['#e3c2a2', '#cfa182', '#a37859', '#71503a'];
const FAN_HAIR = ['#2a1b12', '#5a3a1e', '#1c1c1c', '#b89a52', '#6f3220'];
// The stands match the banner: black, lifted just enough that the tiers
// read, with the banner's grey edge. The fans wear the banner's colours (the
// wordmark's white, blue-grey, yellow and gold, the bites' orange and red,
// the ball's green), toned a little so they don't outshine the play.
const BANNER_STAND = { top: '#1c1d21', face: '#111215', lip: '#333333' };
const BANNER_SHIRTS = ['#ffffff', '#bbccdd', '#ffff88', '#ffbb22', '#ffcc66', '#ff7722', '#ee2233', '#ccee33'];
let crowdLook = null;
function crowdColours() {
  if (!crowdLook) crowdLook = { stand: BANNER_STAND, shirts: BANNER_SHIRTS.map((c) => mix(c, BANNER_STAND.top, 0.22)) };
  return crowdLook;
}
// Blend two #rrggbb colours: k = 0 gives a, 1 gives b.
function mix(a, b, k) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  return '#' + [16, 8, 0].map((sh) => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k).toString(16).padStart(2, '0')).join('');
}
const FAN_FILL = 0.62; // the share of seats taken
const POP_R = 60; // how far from a brick hit the fans react (court units)
const WAVE_W = 0.06; // how wide the Mexican wave's crest is, around the stands
const hash = (i, k) => {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

// One fan, feet at (x, y), drawn n pixels to a pixel. (wx, wy) is where
// they sit in court units and u how far round the stands (0..1, for the
// wave). They react to everything: a brick hit nearby (P.pops), the
// Mexican wave passing (P.wave), a big moment (P.hype), applause (P.clap)
// and a lost ball (P.groan).
function drawFan(x, y, n, i, row, time, wx, wy, u) {
  const r = hash(i, row + 7);
  const hype = P.hype;
  // A brick hit nearby: the closest fans pop up.
  let pop = 0;
  for (const q of P.pops) {
    const d = Math.hypot(q.x - wx, (q.y - wy) * 0.8);
    if (d < POP_R * (0.5 + r)) pop = Math.max(pop, q.k * (1 - d / (POP_R * 1.5)));
  }
  // The wave: up as the crest goes by.
  const crest = P.wave >= 0 ? Math.max(0, 1 - Math.abs(u - P.wave) / WAVE_W) : 0;
  const cheer = (hype > 0 && r < 0.4 + hype * 0.6) || pop > 0.25 || crest > 0.3;
  let lift = 0;
  if (crest > 0.3) lift = Math.round(crest * 3);
  else if (hype > 0 && r < 0.4 + hype * 0.6) lift = Math.round(Math.abs(Math.sin(time * 11 + r * 20)) * 3 * hype);
  else if (pop > 0.25) lift = Math.round(pop * 2);
  const bob = !cheer && Math.sin(time * 1.3 + r * 40) > 0.96 ? 1 : 0; // the odd fidget
  x = Math.round(x - 1.5 * n);
  y = Math.round(y - (lift + bob) * n);
  const shirts = crowdColours().shirts;
  const shirt = shirts[Math.floor(hash(i, row + 3) * shirts.length)];
  const skin = FAN_SKIN[Math.floor(hash(i, row + 5) * FAN_SKIN.length)];
  const px = (dx, dy, w, h, c) => rect(x + dx * n, y + dy * n, w * n, h * n, c);
  px(0, -6, 3, 5, shirt);
  px(0, -9, 3, 3, skin);
  px(0, -9, 3, 1, FAN_HAIR[Math.floor(r * FAN_HAIR.length)]);
  if (crest > 0.3) {
    // In the wave: both arms straight up.
    px(-1, -11, 1, 5, skin);
    px(3, -11, 1, 5, skin);
  } else if (cheer) {
    const wave = Math.sin(time * 14 + r * 30) > 0 ? 1 : 0;
    px(-1, -10 - wave, 1, 4, skin);
    px(3, -11 + wave, 1, 4, skin);
  } else if (P.groan > 0 && r < 0.75) {
    // A groan: hands to heads.
    px(-1, -9, 1, 3, skin);
    px(3, -9, 1, 3, skin);
  } else if ((P.clap > 0 && r < 0.85) || Math.sin(time * 0.9 + r * 50) > 0.85) {
    // Now and then a fan claps, each on their own beat.
    const clap = Math.sin(time * 16 + r * 9) > 0 ? 1 : 0;
    px(-1 + clap, -5, 1, 2, skin);
    px(3 - clap, -5, 1, 2, skin);
  } else {
    px(-1, -6, 1, 3, shade(shirt, -0.3));
    px(3, -6, 1, 3, shade(shirt, -0.3));
  }
}

// Two low terraces behind the banner with a sparse crowd: a few small fans
// with empty seats between them.
function drawStands(time) {
  const a = proj(0, 0);
  const b = proj(WW, 0);
  const x0 = Math.round(a.x) - 10;
  const x1 = Math.round(b.x) + 10;
  const top = P.wb - WALL_H;
  const night = theme.isBlackCourt;
  const step = 8; // each tier's height
  rect(x0, top - step * 2 - 2, x1 - x0, step * 2 + 2, crowdColours().stand.top);
  rect(x0, top - step * 2 - 2, x1 - x0, 1, crowdColours().stand.lip);
  rect(x0, top - step, x1 - x0, 1, crowdColours().stand.lip);
  for (let row = 1; row >= 0; row--) {
    const fy = top - step * row + 1; // where this row's feet are
    for (let x = x0 + 4 + (row ? 3 : 0), i = 0; x < x1 - 4; x += 6, i++) {
      if (hash(i, row) > FAN_FILL) continue; // an empty seat
      const fx = x + 1.5 + Math.round((hash(i, row + 9) - 0.5) * 2);
      drawFan(fx, fy, 1, i, row, time, unprojX(fx, 0), -20, 0.3 + (0.4 * (fx - x0)) / (x1 - x0));
    }
  }
}

// On the courts the stone wall carries a black banner exactly as wide as the
// court's far end. Two logos take turns on it: THE COURT shows, slides up
// and away, COURT BITES rises from below, and round again.
const BANNER_CYCLE = 6; // seconds for both logos
function drawBanner(time) {
  const a = proj(0, 0);
  const b = proj(WW, 0);
  const x0 = Math.round(a.x);
  const x1 = Math.round(b.x);
  const y1 = P.wb;
  const y0 = y1 - WALL_H;
  const h = WALL_H;
  rect(x0 - 1, y0 - 1, x1 - x0 + 2, h + 1, '#333');
  rect(x0, y0, x1 - x0, h, '#000');
  const cx = Math.round((x0 + x1) / 2);
  // Where each logo sits: 0 in view, -h gone up, +h waiting below.
  const t = time % BANNER_CYCLE;
  const half = BANNER_CYCLE / 2;
  const turn = 0.45; // how long the swap takes
  const k = (from) => {
    const q = Math.min(1, Math.max(0, (t - from) / turn));
    return q < 0.5 ? 2 * q * q : 1 - 2 * (1 - q) * (1 - q);
  };
  let offA;
  let offB;
  if (t < half - turn) [offA, offB] = [0, h];
  else if (t < half) [offA, offB] = [-k(half - turn) * h, (1 - k(half - turn)) * h];
  else if (t < BANNER_CYCLE - turn) [offA, offB] = [h, 0];
  else [offA, offB] = [(1 - k(BANNER_CYCLE - turn)) * h, -k(BANNER_CYCLE - turn) * h];
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, h);
  ctx.clip();
  // THE COURT: the ball, then the wordmark.
  const tw = textW('THE ', 1, BANNER_SP) + BANNER_SP;
  const aw = 9 + 4 + tw + textW('COURT', 1, BANNER_SP);
  const ax = cx - Math.round(aw / 2);
  const ay = Math.round(y0 + offA);
  logo(LOGO_BALL, ax, ay + Math.round((h - 9) / 2));
  word('THE', ax + 13, ay + Math.round((h - 7) / 2) + 1, '#fff', '#bcd');
  word('COURT', ax + 13 + tw, ay + Math.round((h - 7) / 2) + 1, '#ff8', '#fb2');
  // COURT BITES: the wordmark, then the burger and the drink.
  const cw = textW('COURT ', 1, BANNER_SP) + BANNER_SP;
  const bw = cw + textW('BITES', 1, BANNER_SP) + 4 + 11 + 1 + 6;
  const bx = cx - Math.round(bw / 2);
  const by = Math.round(y0 + offB);
  word('COURT', bx, by + Math.round((h - 7) / 2) + 1, '#fff', '#bcd');
  word('BITES', bx + cw, by + Math.round((h - 7) / 2) + 1, '#fc6', '#f72');
  const ix = bx + cw + textW('BITES', 1, BANNER_SP) + 4;
  logo(LOGO_BURGER, ix, by + Math.round((h - 9) / 2));
  logo(LOGO_DRINK, ix + 12, by + Math.round((h - 8) / 2));
  ctx.restore();
}

// ---------------------------------------------------------------- sprites

const NIGHT_SLATE = { top: '#7a828f', hi: '#a3abb7', front: '#505764', lo: '#2c3038' };

export const MAT = {
  T: { top: '#cf6f4f', hi: '#e79069', front: '#a04d37', lo: '#733324', bits: ['#cf6f4f', '#a04d37', '#e79069'] },
  L: { top: '#ece3c8', hi: '#fbf6e2', front: '#c9bd9c', lo: '#9d906d', bits: ['#ece3c8', '#c9bd9c', '#fbf6e2'] },
  H: { top: '#3f7d38', hi: '#68ab52', front: '#2b5b29', lo: '#193a1b', bits: ['#3f7d38', '#2b5b29', '#68ab52'] },
  S: { top: '#454a54', hi: '#69707c', front: '#272b32', lo: '#14171b', bits: ['#454a54', '#272b32', '#69707c'] },
};

// A brick: a cuboid seen from the front and above (the landing screen keeps
// these).  (xl,xr,yn) is the near ground edge,
// (xlf,xrf,yf) the far ground edge; h/hf are the wall heights at each edge.
export function drawBlock(xl, xr, yn, xlf, xrf, yf, h, hf, type, seed, o = {}) {
  // On a Black Court the dark slate is lifted to a paler stone so it stands
  // out from the near-black surface; every brick also gets a pale rim.
  const night = !!(theme && theme.isBlackCourt);
  const m = night && type === 'S' ? NIGHT_SLATE : MAT[type];
  xl = Math.round(xl);
  xr = Math.round(xr);
  yn = Math.round(yn);
  h = Math.max(2, Math.round(h));
  const topN = yn - h;
  const topF = Math.min(topN - 2, Math.round(yf - hf));
  const w = xr - xl;
  if (w < 2) return;

  trap(topF, xlf, xrf, topN, xl, xr, m.top);
  rect(xl, topN, w, h, m.front);
  rect(xl, topN, w, 1, m.hi);
  rect(xl, yn - 1, w, 1, m.lo);
  rect(xr - 1, topN + 1, 1, h - 1, m.lo);
  trap(topF, xlf, xrf, topF + 1, xlf, xrf, m.hi);

  const rnd = mulberry(seed);
  const leafy = type === 'H';
  // Fewer speckles on small blocks: they would not show, and big courts draw a thousand.
  const n = Math.round((leafy ? 22 : type === 'S' ? 4 : 7) * Math.min(1, (w * h) / 200));
  const th = topN - topF;
  for (let i = 0; i < n; i++) {
    const u = rnd();
    const v = rnd();
    const dark = rnd() < 0.5;
    if (rnd() < 0.45) {
      const y = topF + 1 + Math.floor(v * (th - 1));
      const t = th > 1 ? (y - topF) / th : 1;
      const a = lerp(xlf, xl, t) + 1;
      const b = lerp(xrf, xr, t) - 2;
      rect(lerp(a, b, u), y, leafy || rnd() < 0.5 ? 1 : 2, 1, dark ? m.front : m.hi);
    } else {
      rect(xl + 1 + u * (w - 3), topN + 1 + v * (h - 3), leafy || rnd() < 0.5 ? 1 : 2, 1, dark ? m.lo : m.top);
    }
  }

  if (night) {
    ctx.globalAlpha = 0.55;
    rect(xl, topN, 1, h, '#a8b2bf'); // pale rim down both front edges
    rect(xr - 1, topN, 1, h, '#a8b2bf');
    trap(topF - 1, xlf, xrf, topF, xlf, xrf, '#c9d2dc'); // and along the back top edge
    ctx.globalAlpha = 1;
  }

  if (o.damage > 0) {
    // Cracks spreading across the front and over the top edge.
    const crack = mulberry(seed ^ 0x9e3779b9);
    const count = Math.round(o.damage * 3);
    for (let c = 0; c < count; c++) {
      let x = xl + 3 + crack() * (w - 6);
      for (let y = topN - 2; y < yn - 1; y++) {
        rect(x, y, 1, 1, m.lo);
        x += crack() < 0.5 ? -1 : crack() < 0.6 ? 1 : 0;
        x = Math.max(xl + 1, Math.min(xr - 2, x));
        if (crack() < 0.12) break;
      }
    }
  }

  if (o.frozen) {
    ctx.globalAlpha = 0.5;
    for (let y = topF; y < yn; y++) {
      const t = y < topN ? (y - topF) / Math.max(1, th) : 1;
      const a = Math.round(lerp(xlf, xl, t));
      const b = Math.round(lerp(xrf, xr, t));
      ctx.fillStyle = PAL.ice;
      for (let x = a + ((y + a) & 1); x < b; x += 2) ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
    rect(xl + 2, topN + 2, 2, 1, '#ffffff');
    rect(xl + 2, topN + 3, 1, 1, '#ffffff');
  }

  if (o.flash > 0) {
    ctx.globalAlpha = Math.min(0.8, o.flash * 6);
    trap(topF, xlf, xrf, topN, xl, xr, '#ffffff');
    rect(xl, topN, w, h, '#ffffff');
    ctx.globalAlpha = 1;
  }
}

export function drawShadow(x, y, rx, ry, a = 0.3) {
  ctx.globalAlpha = a;
  ellipse(x, y, rx, ry, '#0a1a0c');
  ctx.globalAlpha = 1;
}

export function drawBall(cx, cy, r, hot = false) {
  cx = Math.round(cx);
  cy = Math.round(cy);
  const base = hot ? '#ffb347' : '#d8f04a';
  const hi = hot ? '#fff2b0' : '#f6ffa6';
  const lo = hot ? '#d9662c' : '#9db52e';
  disc(cx, cy, r, lo);
  disc(cx - 0.6, cy - 0.6, r - 0.9, base);
  if (r >= 3) {
    rect(cx - Math.round(r * 0.5), cy - Math.round(r * 0.55), Math.max(1, Math.round(r * 0.45)), 1, hi);
    rect(cx - Math.round(r * 0.6), cy - Math.round(r * 0.3), 1, Math.max(1, Math.round(r * 0.4)), hi);
  }
}

export function drawPaddle(cx, y, hw, glow = false) {
  cx = Math.round(cx);
  y = Math.round(y);
  hw = Math.round(hw);
  ctx.globalAlpha = 0.32;
  rrect(cx - hw + 1, y - 2, hw * 2, 8, 4, '#07140a');
  ctx.globalAlpha = 1;
  // On a Black Court the dark paddle gets a pale rim so it stays easy to see.
  if (theme && theme.isBlackCourt) rrect(cx - hw - 1, y - 12, hw * 2 + 2, 16, 7, '#8d96a3');
  rrect(cx - hw, y - 11, hw * 2, 14, 6, '#0d0f12');
  rrect(cx - hw + 1, y - 11, hw * 2 - 2, 9, 5, '#22262d');
  rect(cx - hw + 5, y - 10, hw * 2 - 10, 1, '#4a505b');
  rect(cx - hw + 3, y - 3, hw * 2 - 6, 1, glow ? PAL.yellowHi : PAL.yellow);
  if (glow) rect(cx - hw + 3, y - 4, hw * 2 - 6, 1, PAL.yellowLo);
}
