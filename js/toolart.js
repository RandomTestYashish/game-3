// The six tools' painted art (assets/tools), shared by the Tools screen, the
// tokens that fall in play, the HUD and the rules. Until an image has loaded
// (or if it fails) the plain vector icon stands in, so play never waits on it.

import { ctx, PAL, disc, icon } from './gfx.js';

// How far each picture is scaled to sit inside a round badge: wide art (the
// comet, the arrows) comes down so its ends are not cut off by the circle.
const FIT = { shield: 1.08, multiball: 0.92, smash: 0.8, freeze: 1.04, expand: 0.74, lowgrav: 0.96 };
const BADGE = 96; // the cached badge's size in pixels

export const TOOL_ART = {};
for (const id in FIT) {
  TOOL_ART[id] = new Image();
  TOOL_ART[id].src = `assets/tools/${id}.png`;
}

export const toolArtReady = (id) => {
  const img = TOOL_ART[id];
  return !!img && img.complete && img.naturalWidth > 0;
};

// Each badge is painted once, so a court full of falling tools stays cheap.
const badges = {};
function badge(id) {
  if (badges[id]) return badges[id];
  if (!toolArtReady(id)) return null;
  const img = TOOL_ART[id];
  const c = document.createElement('canvas');
  c.width = c.height = BADGE;
  const b = c.getContext('2d');
  b.imageSmoothingEnabled = true;
  b.imageSmoothingQuality = 'high';
  b.fillStyle = '#07150e';
  b.beginPath();
  b.arc(BADGE / 2, BADGE / 2, BADGE / 2, 0, Math.PI * 2);
  b.fill();
  b.clip();
  const s = (BADGE / img.naturalHeight) * FIT[id];
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  b.drawImage(img, (BADGE - w) / 2, (BADGE - h) / 2, w, h);
  badges[id] = c;
  return c;
}

// A round tool badge with a gold rim, centred on (cx, cy).
export function toolBadge(id, cx, cy, r) {
  disc(cx, cy, r + 1, PAL.ink);
  const art = badge(id);
  if (art) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(art, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  } else {
    disc(cx, cy, r, PAL.panel);
    icon(id, Math.round(cx - 5), Math.round(cy - 5), PAL.yellow);
  }
  ctx.strokeStyle = PAL.yellow;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}
