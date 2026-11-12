// Draws a Game into the projected court, plus the in-play HUD.

import { W, ctx, PAL, rect, disc, ring, rrect, text, textW, serif, serifW, icon } from './gfx.js';
import { proj, drawBlock, drawBall, drawPaddle, drawShadow, MAT } from './scene.js';
import { WW, WH, TOOL_TIME, START_LIVES, comboMult } from './game.js';

export function drawGame(g, time) {
  const frozen = g.fx.freeze > 0;
  const items = [];

  // Ground shadows first so nothing sorts underneath them.
  for (const b of g.blocks) {
    if (!b.alive || b.delay > 0) continue;
    const a = proj(b.x, b.y + b.d);
    const a2 = proj(b.x + b.w, b.y + b.d);
    ctx.globalAlpha = 0.3 * Math.max(0.25, 1 - b.z / 170);
    rect(a.x + 1, a.y, a2.x - a.x, 2 + Math.round(b.bob * 0.6), '#0a1a0c');
    ctx.globalAlpha = 1;
    items.push({ k: b.y + b.d, b });
  }

  if (g.shield) {
    const l = proj(0, WH - 3);
    const r = proj(WW, WH - 3);
    ctx.globalAlpha = 0.35;
    rect(l.x, l.y - 2, r.x - l.x, 5, '#9fe8ff');
    ctx.globalAlpha = 1;
    const off = Math.floor(time * 20) % 6;
    for (let x = l.x - off; x < r.x; x += 6) rect(Math.max(l.x, x), l.y, 4, 1, '#eafaff');
  }

  for (const d of g.drops) items.push({ k: d.y, d });
  for (const q of g.parts) items.push({ k: q.y, q });
  for (const ball of g.balls) items.push({ k: ball.y, ball });
  items.push({ k: g.paddle.y, paddle: g.paddle });
  items.sort((a, b) => a.k - b.k);

  const hot = g.fx.smash > 0;
  for (const it of items) {
    if (it.b) {
      const b = it.b;
      const a = proj(b.x, b.y + b.d);
      const a2 = proj(b.x + b.w, b.y + b.d);
      const f = proj(b.x, b.y);
      const f2 = proj(b.x + b.w, b.y);
      const lift = (b.z + b.bob) * a.s;
      drawBlock(a.x, a2.x, a.y - lift, f.x, f2.x, f.y - lift, b.hz * a.s, b.hz * f.s, b.type, b.seed, {
        damage: 1 - b.hp / b.max,
        frozen,
        flash: b.flash,
      });
    } else if (it.q) {
      const q = it.q;
      const p = proj(q.x, q.y, q.z);
      const c = q.type === 'dust' ? '#cfd8b0' : q.type === 'spark' ? PAL.yellow : MAT[q.type].bits[q.shade];
      ctx.globalAlpha = Math.min(1, q.life / 0.25);
      rect(p.x, p.y - q.size, q.size, q.size, c);
      ctx.globalAlpha = 1;
    } else if (it.d) {
      const d = it.d;
      const g0 = proj(d.x, d.y);
      const p = proj(d.x, d.y, 7 + Math.sin(d.t * 6) * 2);
      drawShadow(g0.x, g0.y, 6, 2, 0.3);
      disc(p.x, p.y - 7, 8, PAL.ink);
      disc(p.x, p.y - 7, 7, PAL.panel);
      ring(p.x, p.y - 7, 7, PAL.yellow);
      icon(d.type, p.x - 5, p.y - 12, PAL.yellow);
    } else if (it.ball) {
      const ball = it.ball;
      const n = ball.trail.length;
      for (let i = n % 2; i < n; i += 2) {
        const t = ball.trail[i];
        const p = proj(t.x, t.y, t.z + 4);
        ctx.globalAlpha = 0.25 + 0.6 * (i / n);
        rect(p.x, p.y, i > n - 5 ? 2 : 1, i > n - 5 ? 2 : 1, hot ? '#ffb347' : '#eef58a');
      }
      ctx.globalAlpha = 1;
      const g0 = proj(ball.x, ball.y);
      const r = Math.max(2.4, ball.r * g0.s * 1.05);
      drawShadow(g0.x, g0.y, r, Math.max(1, r * 0.4), 0.35);
      if (ball.stuck) {
        const off = (time * 14) % 7;
        for (let i = 0; i < 6; i++) {
          const p = proj(ball.x, ball.y - 10 - i * 7 - off, ball.z + 4);
          ctx.globalAlpha = 1 - i / 6;
          rect(p.x, p.y, 1, 2, PAL.yellow);
        }
        ctx.globalAlpha = 1;
      }
      drawBall(g0.x, g0.y - ball.z * g0.s - r, r, hot);
    } else if (it.paddle) {
      const p = proj(it.paddle.x, it.paddle.y + it.paddle.d / 2);
      drawPaddle(p.x, p.y, (it.paddle.w / 2) * p.s, g.fx.expand > 0);
    }
  }

  for (const f of g.floaters) {
    const p = proj(f.x, f.y, f.z);
    ctx.globalAlpha = Math.min(1, f.life / 0.3);
    text(f.text, p.x, p.y - 7, PAL.yellowHi, { align: 'center', shadow: PAL.ink });
    ctx.globalAlpha = 1;
  }
}

// A dark HUD box with a pale rim, as in the scoreboard.
function frame(x, y, w, h) {
  rrect(x - 2, y - 2, w + 4, h + 5, 6, PAL.ink);
  rrect(x - 1, y - 1, w + 2, h + 2, 5, '#5f7a64');
  rrect(x, y, w, h, 4, '#0d1f16');
  rect(x + 4, y + 1, w - 8, 1, '#1d3a2a');
}

// Spacing for the narrow phone canvas (240 wide): the place tag, the
// court-cleared note and the "you beat" note sit a row lower so they clear
// the court name and the combo line.
export const hudRows = () => (W < 300 ? { tag: 46, note: 64, toast: 66 } : { tag: 38, note: 56, toast: 58 });

export function drawHUD(g, levelLabel) {
  // Centred, unless the court label on the left would touch it.
  const x = Math.round(Math.max(W / 2 - 54, 5 + textW(levelLabel, 1, 2) + 12 + 6));
  frame(x, 5, 108, 24);
  text('LIVES', x + 9, 8, PAL.white, { sp: 2 });
  for (let i = 0; i < START_LIVES; i++) {
    const cx = x + 11 + i * 8;
    if (i < g.lives) {
      disc(cx, 22, 3, PAL.yellow);
      rect(cx - 1, 20, 1, 1, PAL.yellowHi);
    } else {
      ring(cx, 22, 3, PAL.yellowLo);
    }
  }
  rect(x + 52, 9, 1, 16, PAL.dim);
  const sc = String(g.score);
  serif(sc, x + 80 - serifW(sc, 16) / 2, 11, 16, PAL.white);

  const lw = textW(levelLabel, 1, 2) + 12;
  frame(5, 6, lw, 15);
  text(levelLabel, 11, 10, PAL.white, { sp: 2 });
  if (g.combo >= 2 && g.state === 'play') {
    text('COMBO X' + comboMult(g.combo), W / 2, 34, PAL.yellowHi, { align: 'center', shadow: PAL.ink });
  }

  // Active tools with their remaining time.
  let ty = 27;
  const badge = (id, frac) => {
    disc(13, ty + 7, 8, PAL.ink);
    disc(13, ty + 7, 7, PAL.panel);
    icon(id, 8, ty + 2, PAL.yellow);
    if (frac != null) {
      rect(5, ty + 17, 17, 3, PAL.ink);
      rect(6, ty + 18, Math.ceil(15 * frac), 1, PAL.yellow);
    }
    ty += 23;
  };
  if (g.shield) badge('shield', null);
  for (const id in g.fx) if (g.fx[id] > 0) badge(id, g.fx[id] / TOOL_TIME[id]);
}
