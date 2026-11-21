// Low-resolution pixel canvas, drawing primitives, bitmap font and icon sprites.
//
// HD rendering: everything is laid out in logical pixels (W x H, about 240 x
// 520), but the screen canvas has K device pixels per logical pixel (K = 1..3,
// matched to the display). Shapes (discs, ellipses, lines, trapezoids, rounded
// boxes) and the serif type are drawn at full device resolution, so they come
// out smooth; the bitmap font, icons and the painted background layers keep
// their pixel-art blocks. Off-screen layers carry their own scale (ctx.__k).

export let W = 240;
export let H = 270;
export let K = 1; // device pixels per logical pixel on the screen canvas
export let ctx = null;

let main = null;
let canvasEl = null;

export function initCanvas(canvas) {
  canvasEl = canvas;
  canvas.width = W;
  canvas.height = H;
  main = canvas.getContext('2d', { alpha: false });
  main.imageSmoothingEnabled = false;
  main.__k = 1;
  ctx = main;
  loadTextFont();
}

// Older browsers without roundRect get plain rectangles (only the HD fans use it).
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
    this.rect(x, y, w, h);
  };
}

// HD text: Barlow Condensed (assets/fonts, SIL OFL), drawn into the bitmap
// font's own cells so every layout stays as it was. Until it has loaded (and
// on 1x canvases) the bitmap font is used.
const TEXT_FONT = 'CourtSans';
let textFontReady = false;
function loadTextFont() {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const f = new FontFace(TEXT_FONT, 'url(assets/fonts/BarlowCondensed-SemiBold.woff2)', { weight: '600' });
  f.load()
    .then((ff) => {
      document.fonts.add(ff);
      textFontReady = true;
    })
    .catch(() => {});
}

export function setSize(w, h, k = K) {
  W = w;
  H = h;
  K = k;
  canvasEl.width = w * k;
  canvasEl.height = h * k;
  main.imageSmoothingEnabled = false;
  main.__k = k;
  main.setTransform(k, 0, 0, k, 0, 0);
}

// Put the screen canvas back to logical units (plus a sideways nudge, for shake).
export function resetTransform(dx = 0) {
  ctx.setTransform(K, 0, 0, K, dx * K, 0);
}

// A screen-sized off-screen layer at the screen's resolution.
export function makeScreenLayer() {
  const x = makeLayer(W * K, H * K);
  x.setTransform(K, 0, 0, K, 0, 0);
  x.__k = K;
  return x;
}

export function setTarget(c) {
  ctx = c || main;
}

export function makeLayer(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.__k = 1;
  return x;
}

export const PAL = {
  frame: '#0c1f16',
  panel: '#10261b',
  panelHi: '#1a3a28',
  cream: '#efe6c8',
  creamLo: '#cbbd92',
  creamSpeck: '#e2d7b2',
  ink: '#16241a',
  yellow: '#f5e663',
  yellowHi: '#fbf3a0',
  yellowLo: '#b9a93a',
  white: '#f4f1de',
  dim: '#8fa48c',
  ice: '#bfe8ff',
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOut = (t) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
export const easeBack = (t) => {
  t = clamp(t, 0, 1);
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

// ---------------------------------------------------------------- primitives

// The current target's device pixels per logical pixel, and snapping to them.
const kNow = () => ctx.__k || 1;
const snap = (v, k) => Math.round(v * k) / k;

export function rect(x, y, w, h, c) {
  ctx.fillStyle = c;
  const k = kNow();
  if (k === 1) {
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    return;
  }
  // Same size as ever (whole logical pixels), placed to the device pixel.
  ctx.fillRect(snap(x, k), snap(y, k), Math.round(w), Math.round(h));
}

// Smooth fill of an ellipse centred on the middle of logical pixel (cx, cy),
// one device row at a time.
function smoothEllipse(cx, cy, rx, ry, k) {
  const ox = snap(cx, k) + 0.5;
  const oy = snap(cy, k) + 0.5;
  rx += 0.45;
  ry += 0.45;
  const n = Math.ceil(ry * k);
  for (let j = -n; j < n; j++) {
    const dy = (j + 0.5) / k;
    const q = 1 - (dy * dy) / (ry * ry);
    if (q <= 0) continue;
    const hw = Math.round(Math.sqrt(q) * rx * k) / k;
    ctx.fillRect(ox - hw, oy + j / k, hw * 2, 1 / k);
  }
}

export function disc(cx, cy, r, c) {
  const k = kNow();
  if (k > 1) {
    ctx.fillStyle = c;
    smoothEllipse(cx, cy, r, r, k);
    return;
  }
  cx = Math.round(cx);
  cy = Math.round(cy);
  ctx.fillStyle = c;
  const rr = (r + 0.4) * (r + 0.4);
  const n = Math.ceil(r);
  for (let dy = -n; dy <= n; dy++) {
    const q = rr - dy * dy;
    if (q < 0) continue;
    const hw = Math.floor(Math.sqrt(q));
    ctx.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1);
  }
}

export function ring(cx, cy, r, c) {
  cx = Math.round(cx);
  cy = Math.round(cy);
  ctx.fillStyle = c;
  const steps = Math.ceil(r * 9);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ctx.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
  }
}

export function ellipse(cx, cy, rx, ry, c) {
  const k = kNow();
  if (k > 1) {
    ctx.fillStyle = c;
    smoothEllipse(cx, cy, rx, ry, k);
    return;
  }
  cx = Math.round(cx);
  cy = Math.round(cy);
  ctx.fillStyle = c;
  const n = Math.ceil(ry);
  for (let dy = -n; dy <= n; dy++) {
    const q = 1 - (dy * dy) / ((ry + 0.4) * (ry + 0.4));
    if (q < 0) continue;
    const hw = Math.floor(Math.sqrt(q) * rx);
    ctx.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1);
  }
}

export function line(x0, y0, x1, y1, c, thick = 1) {
  const k = kNow();
  if (k > 1) {
    // The same pen (thick x 1 logical pixels), stepped one device pixel at a time.
    ctx.fillStyle = c;
    let ax = Math.round(x0 * k);
    let ay = Math.round(y0 * k);
    const bx = Math.round(x1 * k);
    const by = Math.round(y1 * k);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 8000; guard++) {
      ctx.fillRect(ax / k, ay / k, thick, 1);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
    return;
  }
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  ctx.fillStyle = c;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 2000; guard++) {
    ctx.fillRect(x0, y0, thick, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// Scanline trapezoid between two horizontal edges.
export function trap(yT, xlT, xrT, yB, xlB, xrB, c) {
  const k = kNow();
  if (k > 1) {
    const top = Math.round(yT * k);
    const n = Math.round(yB * k) - top;
    if (n <= 0) return;
    ctx.fillStyle = c;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 1 : i / (n - 1);
      const xl = snap(lerp(xlT, xlB, t), k);
      const xr = snap(lerp(xrT, xrB, t), k);
      ctx.fillRect(xl, (top + i) / k, xr - xl, 1 / k);
    }
    return;
  }
  yT = Math.round(yT);
  yB = Math.round(yB);
  ctx.fillStyle = c;
  const n = yB - yT;
  if (n <= 0) return;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const xl = Math.round(lerp(xlT, xlB, t));
    const xr = Math.round(lerp(xrT, xrB, t));
    ctx.fillRect(xl, yT + i, xr - xl, 1);
  }
}

export function rrect(x, y, w, h, r, c) {
  x = Math.round(x);
  y = Math.round(y);
  w = Math.round(w);
  h = Math.round(h);
  r = Math.min(r, Math.floor(h / 2), Math.floor(w / 2));
  ctx.fillStyle = c;
  const k = kNow();
  if (k > 1) {
    // Smooth corners: one device row at a time.
    for (let j = 0; j < h * k; j++) {
      const yy = (j + 0.5) / k;
      const d = yy < r ? r - yy : yy > h - r ? yy - (h - r) : 0;
      const inset = d ? snap(r - Math.sqrt(Math.max(0, r * r - d * d)), k) : 0;
      ctx.fillRect(x + inset, y + j / k, w - inset * 2, 1 / k);
    }
    return;
  }
  for (let i = 0; i < h; i++) {
    const k = i < r ? r - i - 0.5 : i >= h - r ? i - (h - r) + 0.5 : 0;
    const inset = k ? Math.round(r - Math.sqrt(Math.max(0, r * r - k * k))) : 0;
    ctx.fillRect(x + inset, y + i, w - inset * 2, 1);
  }
}

export function checker(x, y, w, h, c, phase = 0) {
  if (kNow() > 1) {
    // HD: the dither's half coverage as an even shade.
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * 0.5;
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = a0;
    return;
  }
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillStyle = c;
  for (let j = 0; j < h; j++) {
    for (let i = (j + phase + x + y) & 1; i < w; i += 2) ctx.fillRect(x + i, y + j, 1, 1);
  }
}

// ---------------------------------------------------------------- bitmap font

const FONT = {
  A: '.XXX./X...X/X...X/XXXXX/X...X/X...X/X...X',
  B: 'XXXX./X...X/X...X/XXXX./X...X/X...X/XXXX.',
  C: '.XXX./X...X/X..../X..../X..../X...X/.XXX.',
  D: 'XXXX./X...X/X...X/X...X/X...X/X...X/XXXX.',
  E: 'XXXXX/X..../X..../XXXX./X..../X..../XXXXX',
  F: 'XXXXX/X..../X..../XXXX./X..../X..../X....',
  G: '.XXX./X...X/X..../X.XXX/X...X/X...X/.XXXX',
  H: 'X...X/X...X/X...X/XXXXX/X...X/X...X/X...X',
  I: 'XXX/.X./.X./.X./.X./.X./XXX',
  J: '..XXX/...X./...X./...X./...X./X..X./.XX..',
  K: 'X...X/X..X./X.X../XX.../X.X../X..X./X...X',
  L: 'X..../X..../X..../X..../X..../X..../XXXXX',
  M: 'X...X/XX.XX/X.X.X/X.X.X/X...X/X...X/X...X',
  N: 'X...X/XX..X/X.X.X/X..XX/X...X/X...X/X...X',
  O: '.XXX./X...X/X...X/X...X/X...X/X...X/.XXX.',
  P: 'XXXX./X...X/X...X/XXXX./X..../X..../X....',
  Q: '.XXX./X...X/X...X/X...X/X.X.X/X..X./.XX.X',
  R: 'XXXX./X...X/X...X/XXXX./X.X../X..X./X...X',
  S: '.XXXX/X..../X..../.XXX./....X/....X/XXXX.',
  T: 'XXXXX/..X../..X../..X../..X../..X../..X..',
  U: 'X...X/X...X/X...X/X...X/X...X/X...X/.XXX.',
  V: 'X...X/X...X/X...X/X...X/X...X/.X.X./..X..',
  W: 'X...X/X...X/X...X/X.X.X/X.X.X/XX.XX/X...X',
  X: 'X...X/X...X/.X.X./..X../.X.X./X...X/X...X',
  Y: 'X...X/X...X/.X.X./..X../..X../..X../..X..',
  Z: 'XXXXX/....X/...X./..X../.X.../X..../XXXXX',
  0: '.XXX./X...X/X..XX/X.X.X/XX..X/X...X/.XXX.',
  1: '.X./XX./.X./.X./.X./.X./XXX',
  2: '.XXX./X...X/....X/...X./..X../.X.../XXXXX',
  3: 'XXXX./....X/....X/.XXX./....X/....X/XXXX.',
  4: '...X./..XX./.X.X./X..X./XXXXX/...X./...X.',
  5: 'XXXXX/X..../XXXX./....X/....X/X...X/.XXX.',
  6: '.XXX./X..../X..../XXXX./X...X/X...X/.XXX.',
  7: 'XXXXX/....X/...X./..X../.X.../.X.../.X...',
  8: '.XXX./X...X/X...X/.XXX./X...X/X...X/.XXX.',
  9: '.XXX./X...X/X...X/.XXXX/....X/....X/.XXX.',
  ' ': '.../.../.../.../.../.../...',
  '.': './././././X/X',
  ',': '../../../../../.X/X.',
  ':': './X/X/././X/X',
  '!': 'X/X/X/X/X/./X',
  '?': '.XXX./X...X/....X/...X./..X../...../..X..',
  '-': '..../..../..../XXXX/..../..../....',
  '+': '...../..X../..X../XXXXX/..X../..X../.....',
  '=': '..../..../XXXX/..../XXXX/..../....',
  '/': '....X/....X/...X./..X../.X.../X..../X....',
  "'": 'X/X/././././.',
  '%': 'XX..X/XX..X/...X./..X../.X.../X..XX/X..XX',
  '<': '...X/..X./.X../X.../.X../..X./...X',
  '>': 'X.../.X../..X./...X/..X./.X../X...',
  '*': '...../..X../X.X.X/.XXX./X.X.X/..X../.....',
};
for (const k in FONT) FONT[k] = FONT[k].split('/');

export function textW(str, scale = 1, sp = 1) {
  str = String(str).toUpperCase();
  let w = 0;
  for (const ch of str) w += ((FONT[ch] || FONT['?'])[0].length + sp) * scale;
  return Math.max(0, w - sp * scale);
}

// HD text is set in the font's own spacing inside the box the bitmap text
// would take (w wide from x), keeping its alignment there; it is squeezed
// only if it would not fit the box.
const hdText = () => textFontReady && kNow() > 1;
export const hdTextOn = hdText;
// The width text really takes: the HD font's own width in HD, else the
// bitmap width. For laying things out after a word.
export function textWidth(str, scale = 1, sp = 1) {
  str = String(str).toUpperCase();
  if (!hdText()) return textW(str, scale, sp);
  ctx.save();
  ctx.font = '600 ' + 10 * scale + 'px ' + TEXT_FONT;
  const m = ctx.measureText(str).width;
  ctx.restore();
  return Math.min(m, textW(str, scale, sp) + scale);
}
function hdString(str, x, y, c, sc, w, align = 'left') {
  ctx.save();
  ctx.fillStyle = c;
  ctx.font = '600 ' + 10 * sc + 'px ' + TEXT_FONT;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(str).width;
  const fit = m > w + sc ? (w + sc) / m : 1;
  const ax = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
  ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
  ctx.translate(ax, y + 7 * sc);
  if (fit < 1) ctx.scale(fit, 1);
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

function glyphs(str, x, y, c, sc, sp, align = 'left') {
  ctx.fillStyle = c;
  if (hdText()) {
    hdString(str, x, y, c, sc, textW(str, sc, sp), align);
    return;
  }
  for (const ch of str) {
    const g = FONT[ch] || FONT['?'];
    for (let r = 0; r < 7; r++) {
      const row = g[r];
      for (let i = 0; i < row.length; i++) {
        if (row[i] === 'X') ctx.fillRect(x + i * sc, y + r * sc, sc, sc);
      }
    }
    x += (g[0].length + sp) * sc;
  }
}

// Break a string into lines no wider than maxW (bitmap font, scale 1).
export function wrap(str, maxW) {
  const lines = [];
  let cur = '';
  for (const word of String(str).split(' ')) {
    const next = cur ? cur + ' ' + word : word;
    if (cur && textW(next) > maxW) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// opts: scale, sp (letter spacing), align ('left' | 'center' | 'right'), shadow
export function text(str, x, y, c, o = {}) {
  const sc = o.scale || 1;
  const sp = o.sp ?? 1;
  str = String(str).toUpperCase();
  const w = textW(str, sc, sp);
  if (o.align === 'center') x -= w / 2;
  else if (o.align === 'right') x -= w;
  x = Math.round(x);
  y = Math.round(y);
  if (o.shadow) glyphs(str, x, y + sc, o.shadow, sc, sp, o.align);
  glyphs(str, x, y, c, sc, sp, o.align);
  return w;
}

// ---------------------------------------------------------------- pixel serif
// Display type: a system serif rasterised small and thresholded into hard pixels.

const serifCache = new Map();
const SERIF = "bold %px Georgia, 'Times New Roman', Times, serif";
// Georgia's numerals are old-style (they dip below the baseline); use lining figures.
const SERIF_DIGITS = "bold %px 'Times New Roman', Times, serif";

function serifGlyph(ch, size, color, k = 1) {
  const key = ch + '|' + size + '|' + color + '|' + k;
  let g = serifCache.get(key);
  if (g) return g;
  const font = (ch >= '0' && ch <= '9' ? SERIF_DIGITS : SERIF).replace('%', size);
  const probe = makeLayer(4, 4);
  probe.font = font;
  const adv = Math.max(1, Math.round(probe.measureText(ch).width));
  const pad = 2;
  const lay = makeLayer((adv + pad * 2 + 2) * k, Math.ceil(size * 1.45) * k);
  lay.font = font.replace(String(size) + 'px', size * k + 'px');
  lay.textBaseline = 'alphabetic';
  lay.fillStyle = '#fff';
  lay.fillText(ch, pad * k, size * k);
  const img = lay.getImageData(0, 0, lay.canvas.width, lay.canvas.height);
  const d = img.data;
  const r = parseInt(color.slice(1, 3), 16);
  const gg = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < d.length; i += 4) {
    const on = d[i + 3] > 105;
    d[i] = r;
    d[i + 1] = gg;
    d[i + 2] = b;
    d[i + 3] = on ? 255 : 0;
  }
  lay.putImageData(img, 0, 0);
  g = { canvas: lay.canvas, adv, pad, k };
  serifCache.set(key, g);
  return g;
}

export function serifW(str, size, sp = 0) {
  let w = 0;
  for (const ch of String(str)) w += serifGlyph(ch, size, '#ffffff').adv + sp;
  return w - sp;
}

// y is the top of the capital letters. opts: align, sp, shadow
export function serif(str, x, y, size, color, o = {}) {
  str = String(str);
  const sp = o.sp || 0;
  const w = serifW(str, size, sp);
  if (o.align === 'center') x -= w / 2;
  else if (o.align === 'right') x -= w;
  x = Math.round(x);
  const top = Math.round(y + Math.round(size * 0.7) - size);
  const k = kNow();
  const put = (g, gx, gy) => ctx.drawImage(g.canvas, gx, gy, g.canvas.width / k, g.canvas.height / k);
  for (const ch of str) {
    if (o.shadow) {
      const s = serifGlyph(ch, size, o.shadow, k);
      put(s, x - s.pad, top + Math.max(1, Math.round(size / 14)));
    }
    const g = serifGlyph(ch, size, color, k);
    put(g, x - g.pad, top);
    x += g.adv + sp;
  }
  return w;
}

// Chunky two-tone arcade heading in the bitmap font: pale top, gold bottom,
// dark drop edge.
export function blockTitle(str, cx, y, scale = 3) {
  const w = textW(str, scale, 1);
  const x = Math.round(cx - w / 2);
  glyphs(str, x, y + scale, '#5a3410', scale, 1, 'center');
  glyphs(str, x + 1, y + scale, '#5a3410', scale, 1, 'center');
  glyphs(str, x, y, '#f2b632', scale, 1, 'center');
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 1, y, w + 2, scale * 3);
  ctx.clip();
  glyphs(str, x, y, '#fff3c4', scale, 1, 'center');
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 1, y + scale * 3, w + 2, scale);
  ctx.clip();
  glyphs(str, x, y, PAL.yellow, scale, 1, 'center');
  ctx.restore();
  return w;
}

// A four-point sparkle; arm 1 or 2.
export function sparkle(x, y, arm = 2, c = PAL.yellow) {
  if (kNow() > 1) {
    // HD: a fine four-point star.
    const t = 0.45;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 0.5 - arm - 0.5);
    ctx.lineTo(x + 0.5 + t, y + 0.5 - t);
    ctx.lineTo(x + 0.5 + arm + 0.5, y + 0.5);
    ctx.lineTo(x + 0.5 + t, y + 0.5 + t);
    ctx.lineTo(x + 0.5, y + 0.5 + arm + 0.5);
    ctx.lineTo(x + 0.5 - t, y + 0.5 + t);
    ctx.lineTo(x + 0.5 - arm - 0.5, y + 0.5);
    ctx.lineTo(x + 0.5 - t, y + 0.5 - t);
    ctx.fill();
    return;
  }
  rect(x - arm, y, arm * 2 + 1, 1, c);
  rect(x, y - arm, 1, arm * 2 + 1, c);
}

// A small tennis racket, leaning left (dir -1) or right (dir 1).
export function racket(cx, cy, dir = 1) {
  disc(cx, cy, 6, PAL.cream);
  disc(cx, cy, 5, PAL.panel);
  ctx.fillStyle = '#9fb7a2';
  if (kNow() > 1) {
    // HD: fine strings across the head.
    for (let d = -4; d <= 4; d += 2) {
      const half = Math.sqrt(Math.max(0, 25 - d * d));
      ctx.fillRect(cx + 0.5 - half, cy + 0.35 + d, half * 2, 0.35);
      ctx.fillRect(cx + 0.35 + d, cy + 0.5 - half, 0.35, half * 2);
    }
  } else {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dy * dy <= 18 && (dx & 1) === 0 && (dy & 1) === 0) ctx.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
  }
  line(cx - dir * 4, cy + 5, cx - dir * 9, cy + 11, PAL.cream, 2);
  rect(cx - dir * 9 - (dir > 0 ? 1 : 0), cy + 10, 3, 2, PAL.yellow);
}

const GOLD = { o: '#5a3410', d: '#c98a1c', g: '#f2b632', l: '#fff3c4' };
// Cup metals for the podium: outline, dark, base, light.
export const METAL = {
  gold: GOLD,
  silver: { o: '#2f363e', d: '#8c98a4', g: '#c9d3d6', l: '#f4f8fa' },
  bronze: { o: '#4a2410', d: '#9c5a2e', g: '#d08a4e', l: '#f6c9a0' },
};

// A cup with a star (gold unless another METAL is given), centred on cx with
// its rim at y, in pixels of size s. About 24 x 17 units: handles reach 12
// units either side.
export function cup(cx, y, s = 1, m = GOLD) {
  const bx = 13 * s + 2;
  const by = 2 * s + 2;
  smoothDraw('cup|' + s + '|' + m.g, Math.round(cx) - bx, Math.round(y) - by, bx * 2, 20 * s + 4, (ox, oy) => cupPixels(ox + bx, oy + by, s, m));
}
function cupPixels(cx, y, s, m) {
  const parts = [];
  const bowl = [8, 8, 8, 7, 7, 6, 5, 4, 3];
  bowl.forEach((hw, r) => parts.push([-hw, r, hw * 2, 1, r === 0 ? m.l : m.g]));
  for (const d of [-1, 1]) {
    const ox = d < 0 ? -11 : 8;
    parts.push([ox, 1, 3, 1, m.g], [d < 0 ? -11 : 10, 1, 1, 5, m.g], [d < 0 ? -11 : 6, 5, 5, 1, m.d]);
  }
  parts.push([-1, 9, 2, 3, m.d], [-2, 12, 4, 1, m.g], [-1, 13, 2, 1, m.d], [-4, 14, 8, 1, m.g], [-6, 15, 12, 2, m.d]);
  const R = (x, yy, w, h, c) => rect(cx + x * s, y + yy * s, w * s, h * s, c);
  for (const [x, yy, w, h] of parts) R(x - 1, yy - 1, w + 2, h + 2, m.o);
  for (const [x, yy, w, h, c] of parts) R(x, yy, w, h, c);
  bowl.forEach((hw, r) => {
    if (r === 0) return;
    R(-hw + 1, r, 1, 1, m.l);
    R(hw - 2, r, 1, 1, m.d);
  });
  R(-4, 15, 8, 1, m.g);
  // The star on the bowl.
  ['..#..', '#####', '.###.', '.#.#.'].forEach((row, r) => {
    for (let i = 0; i < 5; i++) if (row[i] === '#') R(i - 3, r + 2, 1, 1, m.d);
  });
}

// A small trophy icon with a dark drop shadow.
export function trophy(x, y) {
  icon('trophy', x + 1, y + 1, GOLD.o);
  icon('trophy', x, y, GOLD.g);
  rect(x + 2, y + 1, 1, 3, GOLD.l);
}

// A laurel branch curving around (cx, cy) on one side (-1 left, 1 right):
// a stem with leaves in pairs, smaller towards the tip.
export function laurel(cx, cy, r, side, n = 6, c = '#2f8f6e', hi = '#5cc597') {
  const b = Math.ceil(r) + 6;
  smoothDraw(['laurel', r, side, n, c, hi].join('|'), Math.round(cx) - b, Math.round(cy) - b, b * 2, b * 2, (ox, oy) => laurelPixels(ox + b, oy + b, r, side, n, c, hi));
}
function laurelPixels(cx, cy, r, side, n, c, hi) {
  const at = (t) => {
    const a = Math.PI * (0.3 + 0.62 * t);
    return [cx + side * r * Math.sin(a), cy - r * Math.cos(a), a];
  };
  for (let i = 0; i <= 24; i++) {
    const [x, y] = at(i / 24);
    rect(Math.round(x), Math.round(y), 1, 1, '#1f5e47');
  }
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const [x, y, a] = at(t);
    const size = t < 0.25 ? 2 : 3;
    // Normal to the stem: one leaf outside the curve, one inside.
    for (const k of [1, -1]) {
      const lx = Math.round(x + k * side * Math.sin(a) * 2.5);
      const ly = Math.round(y - k * Math.cos(a) * 2.5 - 1);
      rect(lx - 1, ly, size, 2, c);
      rect(lx - 1 + (side < 0 ? size - 1 : 0), ly - 1, 1, 1, c);
      rect(lx - (side < 0 ? 0 : 1) + (side < 0 ? 0 : 0), ly, 1, 1, hi);
    }
  }
}

// Soft light rays fanning out behind something at (cx, cy).
export function rays(cx, cy, r0, r1, t, c = PAL.yellow) {
  const a0 = ctx.globalAlpha;
  for (let k = 0; k < 14; k++) {
    const a = Math.PI * (1.05 + (0.9 * k) / 13) + Math.sin(t * 1.3 + k) * 0.03;
    ctx.globalAlpha = a0 * (k % 2 ? 0.25 : 0.45);
    line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, c);
  }
  ctx.globalAlpha = a0;
}

// A little globe, 13 x 13.
export function globe(x, y) {
  smoothDraw('globe', x, y, 14, 14, globePixels);
}
function globePixels(x, y) {
  disc(x + 6, y + 6, 6, '#0d1430');
  disc(x + 6, y + 6, 5, '#2f6fd6');
  rect(x + 3, y + 3, 3, 2, '#4caf50');
  rect(x + 2, y + 5, 3, 3, '#4caf50');
  rect(x + 7, y + 2, 2, 2, '#4caf50');
  rect(x + 7, y + 6, 3, 2, '#4caf50');
  rect(x + 8, y + 8, 2, 2, '#4caf50');
  rect(x + 3, y + 2, 1, 1, '#9fd0ff');
}

// ---------------------------------------------------------------- icons

const ICONS = {
  theme: '.........../........##./.......####/........##./...#......./..###....../.#####..#../#######.###/###########/###########/...........', // a sun over two peaks: the court themes
  shield: '.#########./.#########./.####.####./.###...###./.####.####./.#########./..#######../..#######../...#####.../....###..../.....#.....',
  multiball: '....###..../...#####.../...#####.../....###..../.........../.###...###./#####.#####/#####.#####/#####.#####/.###...###./...........',
  smash: '.....#...../.....#...../..#.###.#../...#####.../..#######../###########/..#######../...#####.../..#.###.#../.....#...../.....#.....',
  freeze: '.....#...../...#.#.#.../....###..../.#...#...#./#.#..#..#.#/.#########./#.#..#..#.#/.#...#...#./....###..../...#.#.#.../.....#.....',
  expand: '.........../.........../..#.....#../.##.....##./###########/###########/.##.....##./..#.....#../.........../.........../...........',
  lowgrav: '.........../....###..../...#####..#/..#######.#/..######.#./..####.###./.#.#.#####./#.#######../#..#####.../....###..../...........',
  replay: '...#####.#./..##...###./.##...####./.#........./.#.......#./.#.......#./.##.....##./..##...##../...#####.../.........../...........',
  home: '.....#...../....###..../...#####.../..#######../.#########./###########/..#######../..###.###../..###.###../..###.###../...........',
  next: '.........../..##......./..####...../..######.../..########./..#########/..########./..######.../..####...../..##......./...........',
  back: '.........../....#....../...##....../..###....../.##########/###########/.##########/..###....../...##....../....#....../...........',
  pause: '.........../..###.###../..###.###../..###.###../..###.###../..###.###../..###.###../..###.###../..###.###../.........../...........',
  sound: '.....#...../....##..#../...###...#./######.#.#./######.#.#./######.#.#./######.#.#./...###...#./....##..#../.....#...../...........',
  lock: '...#####.../..##...##../..#.....#../..#.....#../.#########./.#########./.####.####./.####.####./.#########./.#########./...........',
  trophy: '..#######../###########/#.#######.#/#.#######.#/.#.#####.#./...#####.../....###..../.....#...../.....#...../...#####.../..#######..',
  list: '.........../.#########./.#.......#./.#.#####.#./.#.......#./.#.#####.#./.#.......#./.#.#####.#./.#.......#./.#########./...........',
  fwd: '.........../......#..../......##.../......###../##########./###########/##########./......###../......##.../......#..../...........',
  bulb: '...#####.../..#######../.#########./.#########./.#########./..#######../...#####.../...#####.../....###..../...#####.../....###....',
  close: '.........../.##.....##./.###...###./..###.###../...#####.../....###..../...#####.../..###.###../.###...###./.##.....##./...........',
  star: '.....#...../.....#...../....###..../.#########./..#######../...#####.../...#####.../..###.###../..#.....#../.........../...........',
  bricks: '.........../.........../...#####.../...#####.../...#####.../.........../#####.#####/#####.#####/#####.#####/.........../...........',
  heart: '.........../.###...###./#####.#####/###########/###########/.#########./..#######../...#####.../....###..../.....#...../...........',
  clock: '....###..../.....#...../...#####.../..#.....#../.#...#...#./.#...#...#./.#...###.#./.#.......#./..#.....#../...#####.../...........',
  crown: '.........../#....#....#/##..###..##/###.###.###/###########/###########/###########/.#########./.........../.........../...........',
  share: '.....#...../....###..../...#####.../.....#...../.....#...../.##..#..##./.#.......#./.#.......#./.#.......#./.#########./...........',
  chat: '...#####.../..#.....#../.#..#....#./.#..##...#./.#...##..#./.#....##.#./.#.....#.#./..#.....#../.#.#####.../#........../...........',
  link: '.........../..###....../.#...#...../.#...#...../.#..###..../..#.#.#..../....###..#./.....#...#./.....#...#./......###../...........',
  hourglass: '.#########./..#.....#../..##...##../...##.##.../....###..../....#.#..../...#...#.../..#..#..#../..#.###.#../.#########./...........',
  check: '...#####.../..#.....#../.#.......#./#.......#.#/#......#..#/#.#...#...#/#..#.#....#/.#..#....#./..#.....#../...#####.../...........',
  refresh: '...#####.#./..#.....##./.#.....###./.#........./.#........./.#.......#./.#.......#./..#.....#../...#####.../.........../...........',
  people: '.........../..##...##../.####.####./.####.####./..##...##../.........../.####.####./#####.#####/#####.#####/.........../...........',
};
for (const k in ICONS) ICONS[k] = ICONS[k].split('/');

// Pixel art made smooth for HD: Scale2x / Scale3x (the EPX family) round off
// the stair-steps of a 1-bit pattern at 2x or 3x, keeping its shape.
export function scaleNx(src, w, h, n) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
  const out = new src.constructor(w * n * h * n); // 1-bit masks or 32-bit colours alike
  const W2 = w * n;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const A = at(x - 1, y - 1), B = at(x, y - 1), C = at(x + 1, y - 1);
      const D = at(x - 1, y), E = at(x, y), F = at(x + 1, y);
      const G = at(x - 1, y + 1), H = at(x, y + 1), I = at(x + 1, y + 1);
      let e;
      if (n === 2) {
        e = [D === B && D !== H && B !== F ? B : E, B === F && B !== D && F !== H ? F : E, D === H && D !== B && H !== F ? D : E, H === F && D !== H && B !== F ? F : E];
      } else {
        e = [
          D === B && B !== F && D !== H ? D : E,
          (D === B && B !== F && D !== H && E !== C) || (B === F && B !== D && F !== H && E !== A) ? B : E,
          B === F && B !== D && F !== H ? F : E,
          (D === B && B !== F && D !== H && E !== G) || (D === H && D !== B && H !== F && E !== A) ? D : E,
          E,
          (B === F && B !== D && F !== H && E !== I) || (H === F && D !== H && B !== F && E !== C) ? F : E,
          D === H && D !== B && H !== F ? D : E,
          (D === H && D !== B && H !== F && E !== I) || (H === F && D !== H && B !== F && E !== G) ? H : E,
          H === F && D !== H && B !== F ? F : E,
        ];
      }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[(y * n + j) * W2 + x * n + i] = e[j * n + i];
    }
  }
  return out;
}

// A 1-bit pattern (rows of '#'/'X') as a smooth sprite at k device pixels per
// cell, in one colour; cached.
const smoothCache = new Map();
export function smoothSprite(rows, on, c, k) {
  const key = rows.join('/') + '|' + c + '|' + k;
  let cv = smoothCache.get(key);
  if (cv) return cv;
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  let m = new Uint8Array(w * h);
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) m[y * w + x] = r[x] === on ? 1 : 0;
  });
  let mw = w;
  let mh = h;
  for (const n of k >= 4 ? [2, 2] : k === 3 ? [3] : [2]) {
    m = scaleNx(m, mw, mh, n);
    mw *= n;
    mh *= n;
  }
  const lay = makeLayer(mw, mh);
  const img = lay.createImageData(mw, mh);
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  lay.putImageData(img, 0, 0);
  cv = { canvas: lay.canvas, w, h };
  smoothCache.set(key, cv);
  return cv;
}

// A small pixel drawing made smooth for HD: fn(ox, oy) paints it with its box
// at (ox, oy) on a 1x layer, which is then upscaled with Scale2x/3x (colour
// version) and cached under key; at 1x it simply paints in place.
const drawnCache = new Map();
export function smoothDraw(key, x, y, w, h, fn) {
  const k = kNow();
  x = Math.round(x);
  y = Math.round(y);
  if (k === 1) {
    fn(x, y);
    return;
  }
  const n = Math.min(4, k);
  const ck = key + '|' + n;
  let cv = drawnCache.get(ck);
  if (!cv) {
    const lay = makeLayer(w, h);
    const was = ctx;
    ctx = lay;
    fn(0, 0);
    ctx = was;
    let px = new Uint32Array(lay.getImageData(0, 0, w, h).data.buffer);
    let mw = w;
    let mh = h;
    for (const f of n >= 4 ? [2, 2] : n === 3 ? [3] : [2]) {
      px = scaleNx(px, mw, mh, f);
      mw *= f;
      mh *= f;
    }
    const big = makeLayer(mw, mh);
    const img = big.createImageData(mw, mh);
    new Uint32Array(img.data.buffer).set(px);
    big.putImageData(img, 0, 0);
    cv = big.canvas;
    if (drawnCache.size > 400) drawnCache.clear();
    drawnCache.set(ck, cv);
  }
  ctx.drawImage(cv, x, y, w, h);
}

export function icon(name, x, y, c, scale = 1) {
  const g = ICONS[name];
  if (!g) return;
  const k = kNow();
  if (k > 1 && /^#[0-9a-fA-F]{6}$/.test(c)) {
    const sp = smoothSprite(g, '#', c, Math.min(4, k * scale));
    ctx.drawImage(sp.canvas, Math.round(x), Math.round(y), sp.w * scale, sp.h * scale);
    return;
  }
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillStyle = c;
  for (let r = 0; r < g.length; r++) {
    const row = g[r];
    for (let i = 0; i < row.length; i++) {
      if (row[i] === '#') ctx.fillRect(x + i * scale, y + r * scale, scale, scale);
    }
  }
}
