"""End-to-end test for The Court. Drives the real game in headless Chrome.

    pip install playwright
    python tests/e2e.py            # uses the installed Google Chrome

It serves the repo on a free local port, then checks every screen, the
controls (mouse, keyboard, touch), the rules, sound settings, the save
system, and that each level can be played through to "Rally Complete".
"""

import functools
import http.server
import json
import pathlib
import re
import sys
import threading
import time
import urllib.parse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
results = []
MAX_PER_COURT = int(re.search(r"p_court \* (\d+)", (ROOT / "supabase/submit_score.sql").read_text()).group(1))
SUPABASE_CALLS = []  # any request a test page makes to a real *.supabase.co host
MOCK = {
    "mode": "ok",
    "key": "test-anon-key",
    "requests": [],
    "posted": [],  # rows accepted by the stand-in submit_score
    # What a database might hand back, including things the game must not trust.
    "rows": [{"name": "AANYA", "score": 9100, "court": 14, "created_at": "2026-10-01T10:00:00Z"},
             {"name": "<script>x", "score": 7200, "court": 9, "created_at": "2026-10-02T10:00:00Z"},
             {"name": "", "score": 6100, "court": 7, "created_at": "2026-10-03T10:00:00Z"},
             {"name": "averyveryverylongname", "score": 5000, "court": "5", "created_at": "2026-10-04T10:00:00Z"},
             {"name": "BAD", "score": "abc", "court": 2}, None, {"name": "NEG", "score": -5, "court": 1}]
    + [{"name": f"P{i}", "score": 4000 - i * 100, "court": 3} for i in range(30)],
}


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  ok   " if ok else "  FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        # A stand-in for the Supabase REST endpoint, so the online leaderboard
        # can be tested without a real project. MOCK["mode"] picks the reply.
        def do_GET(self):
            if not self.path.startswith("/rest/v1/"):
                return super().do_GET()
            MOCK["requests"].append({"method": "GET", "path": self.path, "apikey": self.headers.get("apikey"), "auth": self.headers.get("Authorization")})
            if MOCK["mode"] == "slow":
                time.sleep(1.2)
            if MOCK["mode"] == "fail":
                return self.reply(500, {"message": "boom"})
            if self.headers.get("apikey") != MOCK["key"]:
                return self.reply(401, {"message": "Invalid API key"})
            rows = [] if MOCK["mode"] == "empty" else MOCK["posted"] + MOCK["rows"]
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "name" in q:  # the unique-name check: ?select=name&name=eq.X&limit=1
                want = q["name"][0].removeprefix("eq.")
                rows = [{"name": r["name"]} for r in rows if r and r.get("name") == want][:1]
            self.reply(200, rows)

        # Mirrors supabase/submit_score.sql: the function is the only way in,
        # and it refuses anything outside the limits written there.
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            req = {"method": "POST", "path": self.path, "apikey": self.headers.get("apikey"), "prefer": self.headers.get("Prefer"), "body": body.decode()}
            MOCK["requests"].append(req)
            if self.path != "/rest/v1/rpc/submit_score":
                return self.reply(401, {"message": "permission denied for table"})
            if MOCK["mode"] == "postfail":
                return self.reply(500, {"message": "boom"})
            if self.headers.get("apikey") != MOCK["key"]:
                return self.reply(401, {"message": "Invalid API key"})
            try:
                b = json.loads(body)
                name, score, court = b["p_name"], b["p_score"], b["p_court"]
                ok = re.fullmatch(r"[A-Z0-9 .-]{1,8}", name) and name.strip() and 1 <= court <= 120 and 1 <= score <= court * MAX_PER_COURT
            except Exception:
                ok = False
            if not ok:
                return self.reply(400, {"code": "22023", "message": "invalid"})
            MOCK["posted"].append({"name": name, "score": score, "court": court})
            self.send_response(204)
            self.end_headers()

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    handler = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# In-page helper: steers with synthetic pointer events on the canvas, so the
# game's own input handlers do the work. mode 'win' tracks the ball, 'lose'
# keeps the paddle away from it.
BOT = """
window.__bot = { mode: 'win', on: false };
(function loop() {
  const c = window.__court, cv = document.getElementById('court'), bot = window.__bot;
  const g = c.S.game;
  if (bot.on && g && c.S.screen === 'play' && !c.S.leaving) {
    const r = cv.getBoundingClientRect();
    const fire = (type, x) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: r.left + x * r.width / cv.width, clientY: r.top + r.height * 0.8,
      pointerType: 'mouse', pointerId: 1, bubbles: true, cancelable: true }));
    let target = g.paddle.x;
    const live = g.balls.filter(b => !b.stuck);
    if (live.length) {
      const b = live.reduce((a, q) => (q.vy > 0 ? q.y : -q.y - 999) > (a.vy > 0 ? a.y : -a.y - 999) ? q : a);
      let x = b.x;
      if (b.vy > 0) {
        x = b.x + b.vx * (g.paddle.y - b.y) / b.vy;
        for (let i = 0; i < 6 && (x < 4 || x > 196); i++) x = x < 4 ? 8 - x : 392 - x;
      }
      target = bot.mode === 'win' ? x + Math.sin(c.S.time * 1.7) * g.paddle.w * 0.3 : (x < 100 ? 180 : 20);
    }
    const sx = c.proj(Math.max(0, Math.min(200, target)), g.paddle.y).x;
    fire('pointermove', sx);
    if (g.state === 'serve') { fire('pointerdown', sx); fire('pointerup', sx); }
  }
  requestAnimationFrame(loop);
})();
"""

# Pure rules checks, run in the page against a fresh Game with a seeded RNG.
RULES = """
async () => {
  const { Game, WW, WH, TOOL_TIME, BLOCKS, PADDLE_Y, SPEED_CAP } = await import('/js/game.js');
  const { LEVELS } = await import('/js/levels.js');
  const out = {};
  const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const fresh = (i = 0) => { const g = new Game(LEVELS[i], () => {}, rng(7 + i)); for (let k = 0; k < 200; k++) g.update(1 / 60); return g; };
  const run = (g, secs) => { for (let k = 0; k < secs * 120; k++) g.update(1 / 120); };

  let g = fresh();
  out.blocksLand = g.ready && g.state === 'serve' && g.balls[0].stuck;
  out.launch = g.launch() && g.state === 'play' && !g.balls[0].stuck;

  // Paddle bounce
  g = fresh(); g.launch(); let b = g.balls[0];
  Object.assign(b, { x: g.paddle.x + 10, y: g.paddle.y - 14, vx: 0, vy: 1 }); run(g, 0.2);
  out.paddleBounce = b.vy < 0 && b.vx > 0;

  // Walls keep the ball in court
  g = fresh(); g.launch(); b = g.balls[0];
  Object.assign(b, { x: 20, y: 200, vx: -0.9, vy: -0.436 }); run(g, 0.4);
  out.wallBounce = b.vx > 0 && b.x >= b.r;

  // Block collision: damage, score and reflection (on the first court with both limestone and hedge)
  const hl = LEVELS.findIndex(l => l.rows.join('').includes('H') && l.rows.join('').includes('L'));
  g = fresh(hl); g.launch(); b = g.balls[0];
  let blk = g.blocks.filter(q => q.type === 'L').sort((p, q) => q.y - p.y)[0];
  Object.assign(b, { x: blk.x + blk.w / 2, y: blk.y + blk.d + 12, vx: 0, vy: -1 }); run(g, 0.2);
  out.blockBreak = !blk.alive && g.score === 15 && b.vy > 0 && g.remaining === g.total - 1;
  blk = g.blocks.find(q => q.type === 'H' && q.alive);
  for (const q of g.blocks) if (q !== blk && q.r >= blk.r) q.alive = false;
  Object.assign(b, { x: blk.x + blk.w / 2, y: blk.y + blk.d + 12, vx: 0, vy: -1 }); run(g, 0.2);
  out.hedgeTakesTwo = blk.alive && blk.hp === 1;

  // Lives and game over
  g = fresh(); const ev = []; g.emit = (t) => ev.push(t);
  for (let i = 0; i < 3; i++) { g.launch(); Object.assign(g.balls[0], { x: 5, y: WH, vx: 0, vy: 1 }); g.movePaddleTo(190); run(g, 0.5); }
  out.livesAndGameOver = g.lives === 0 && g.state === 'over' && ev.filter(t => t === 'lost').length === 2 && ev.includes('over');

  // Win
  g = fresh(); g.launch(); g.emit = (t) => ev.push(t);
  g.blocks.slice(1).forEach(q => (q.alive = false)); g.remaining = 1; blk = g.blocks[0]; b = g.balls[0];
  Object.assign(b, { x: blk.x + blk.w / 2, y: blk.y + blk.d + 10, vx: 0, vy: -1 }); run(g, 0.2);
  out.win = g.state === 'won' && g.bonus === 300 && g.stars === 3 && ev.includes('win');

  // A run carries score and lives into the next court
  g = new Game(LEVELS[1], () => {}, rng(3), { lives: 1, score: 900 });
  out.runCarries = g.lives === 1 && g.score === 900 && g.startScore === 900;
  // ...and one more lost ball on the next court ends the run.
  g.launch(); g.balls = []; g.loseLife();
  out.lastLifeEndsRun = g.lives === 0 && g.state === 'over';

  // 3D motion: blocks float on every court, and drifting formations advance
  g = fresh(0); run(g, 0.4);
  out.blocksFloat = g.blocks.some(q => q.bob > 0.3);
  const di = LEVELS.findIndex(l => l.drift > 0); g = fresh(di); const y0 = g.blocks[0].y; run(g, 3);
  out.formationDrifts = g.blocks[0].y > y0 + 1;

  // Level set
  const ids = new Set(LEVELS.map(l => l.id)), names = new Set(LEVELS.map(l => l.name));
  out.levelCount = LEVELS.length >= 100 && ids.size === LEVELS.length && names.size === LEVELS.length;
  out.levelsWellFormed = LEVELS.every(l => l.rows.length >= 4 && l.rows.length <= l.most && l.rows.every(r => r.length === l.cols && /^[.TLHS]+$/.test(r))
    && l.rows.join('').replace(/\./g, '').length >= 14 && (l.move || []).every(r => l.rows[r][0] === '.' && l.rows[r][l.cols - 1] === '.'));
  // Every court: more blocks than the last (24 up to 1000), and smaller ones once they no longer fit at full size.
  const count = (i) => new Game(LEVELS[i]).blocks.length;
  // Courts fill up gently: 24 on court 1, every 20 courts fuller on average, at most about 350.
  const band = (a) => { let t = 0; for (let i = a; i < a + 20; i++) t += count(i); return t / 20; };
  out.blocksShrink = LEVELS[0].cols === 7 && LEVELS[119].cell < LEVELS[0].cell;
  out.moreBlocks = count(0) === 24 && [0, 20, 40, 60, 80, 100].every((a, i, xs) => i === 0 || band(a) > band(xs[i - 1])) && Math.max(...LEVELS.map((l, i) => count(i))) <= 360;
  // Each generated court is one geometric formation, mirrored left and right, and the shapes vary.
  out.geometricCourts = LEVELS.slice(5).every(l => l.form && l.rows.every(r => [...r].every((ch, i) => (ch === '.') === (r[r.length - 1 - i] === '.')))) && new Set(LEVELS.map(l => l.form).filter(Boolean)).size >= 10;
  out.blocksOnCourt = LEVELS.every(l => new Game(l).blocks.every(b => b.x - (b.amp || 0) >= 0 && b.x + b.w + (b.amp || 0) <= WW && b.y + b.d < PADDLE_Y - 30));
  out.getsHarder = LEVELS[119].speed > LEVELS[0].speed * 1.25 && LEVELS[119].paddle < LEVELS[0].paddle - 8 && LEVELS[0].speed >= 160;
  // ...but stays playable: the fastest a ball can ever go is well under the old court-1 top speed x 1.8.
  out.staysPlayable = LEVELS.every(l => l.speed * SPEED_CAP <= 300) && LEVELS[119].paddle >= 42;

  // Tools
  g = fresh(); g.launch(); g.applyTool('shield'); b = g.balls[0];
  Object.assign(b, { x: 10, y: WH - 12, vx: 0, vy: 1 }); g.movePaddleTo(190); run(g, 0.3);
  out.shield = !g.shield && b.vy < 0 && g.balls.length === 1 && g.lives === 3;

  g = fresh(); g.launch(); g.applyTool('multiball');
  out.multiball = g.balls.length === 3 && g.balls.every(q => Math.abs(Math.hypot(q.vx, q.vy) - 1) < 1e-6);

  // Smash: a hedge with blocks behind it and none in front, on the first court that has one.
  const sameCol = (o, q) => o !== q && Math.abs(o.x + o.w / 2 - (q.x + q.w / 2)) < 1;
  const frontHedge = (gg) => gg.blocks.find(q => q.type === 'H' && gg.blocks.some(o => sameCol(o, q) && o.y < q.y) && !gg.blocks.some(o => sameCol(o, q) && o.y > q.y));
  const sm = LEVELS.findIndex(l => frontHedge(new Game(l)));
  g = fresh(sm); g.launch(); g.applyTool('smash'); b = g.balls[0];
  blk = frontHedge(g);
  const before = g.remaining;
  Object.assign(b, { x: blk.x + blk.w / 2, y: blk.y + blk.d + 10, vx: 0, vy: -1 }); run(g, 0.35);
  out.smash = !blk.alive && g.remaining <= before - 2 && b.y < blk.y;
  run(g, TOOL_TIME.smash); out.smashExpires = g.fx.smash === 0;

  g = fresh(2); g.launch(); const mover = g.blocks.find(q => q.amp); const x0 = mover.x;
  run(g, 0.3); const moved = mover.x !== x0;
  g.applyTool('freeze'); const x1 = mover.x; b = g.balls[0];
  blk = g.blocks.find(q => q.type === 'S');
  for (const q of g.blocks) if (q !== blk && q !== mover) q.alive = false;
  Object.assign(b, { x: blk.x + blk.w / 2, y: blk.y + blk.d + 10, vx: 0, vy: -1 }); run(g, 0.2);
  out.freeze = moved && mover.x === x1 && !blk.alive;

  g = fresh(); g.launch(); g.balls[0].y = 60; g.applyTool('expand'); run(g, 1);
  const wide = g.paddle.w; run(g, TOOL_TIME.expand + 1);
  out.expand = wide === LEVELS[0].paddle + 26 && g.paddle.w === LEVELS[0].paddle;

  const fall = (tool) => { const q = fresh(); q.blocks.forEach(k => (k.alive = false)); q.launch(); if (tool) q.applyTool(tool);
    Object.assign(q.balls[0], { x: 100, y: 20, vx: 0, vy: 1 }); q.movePaddleTo(27); run(q, 0.4); return q.balls[0].y - 20; };
  out.lowgrav = Math.abs(fall('lowgrav') / fall(null) - 0.6) < 0.02;

  // Tool pickup
  g = fresh(); g.launch(); g.balls[0].y = 40; const tok = { type: 'expand', x: g.paddle.x, y: g.paddle.y - 20, t: 0 }; g.drops.push(tok); run(g, 0.4);
  out.pickup = g.fx.expand > 0 && !g.drops.includes(tok);

  // ---- "How to play" numbers checked against what the game actually does
  const { facts, sections } = await import('/js/rules.js');
  const { textW } = await import('/js/gfx.js');
  const f = facts(); out.facts = f;
  const txt = sections().map(s => s.rows.map(r => [r.name, r.left, r.right].join(' ')).concat(s.lines).join(' ')).join(' ');
  const shoot = (q, blk) => { const s0 = q.score; Object.assign(q.balls[0], { x: blk.x + blk.w / 2, y: blk.y + blk.d + 10, vx: 0, vy: -1 }); run(q, 0.1); return q.score - s0; };
  const lowest = (q, types) => q.blocks.filter(k => k.alive && types.includes(k.type)).sort((a, b) => b.y - a.y)[0];

  // Brick durability and base value: hit one brick of each type until it breaks.
  out.measured = { bricks: {}, combo: [], toolTime: {} };
  for (const type of ['T', 'L', 'H', 'S']) {
    const li = LEVELS.findIndex(l => l.rows.join('').includes(type));
    g = fresh(li); g.launch(); blk = g.blocks.find(k => k.type === type); blk.amp = 0; blk.drift = 0;
    for (const k of g.blocks) if (k !== blk) k.alive = false;
    g.remaining = 2; // keep the court from being "won" by this one brick
    let hits = 0, pts = 0;
    while (blk.alive && hits < 9) { g.combo = 0; pts = shoot(g, blk); hits++; }
    out.measured.bricks[type] = { hits, pts };
  }
  out.rulesBricks = ['T', 'L', 'H', 'S'].every(t => out.measured.bricks[t].hits === f.bricks[t].hits && out.measured.bricks[t].pts === f.bricks[t].pts
    && txt.includes(f.bricks[t].name) && txt.includes(f.bricks[t].pts + ' PTS'));

  // Combo: break ten one-hit bricks in a row without touching the paddle.
  g = fresh(0); g.launch(); g.dropRate = 0; g.sinceDrop = -99;
  const seq = [];
  for (let n = 1; n <= 10; n++) { blk = lowest(g, ['T', 'L']); const got = shoot(g, blk); seq.push([n, blk.type, got]); out.measured.combo.push(got / BLOCKS[blk.type].pts); }
  const round5 = (v) => Math.round(v / 5) * 5;
  const mult = (n) => 1 + Math.min(n - 1, f.comboMaxAt - 1) * f.comboStep;
  out.rulesCombo = seq.every(([n, t, got]) => got === round5(BLOCKS[t].pts * mult(n))) && mult(f.comboMaxAt) === f.comboMax && mult(20) === f.comboMax;
  const hedge5 = round5(BLOCKS.H.pts * mult(5));
  out.rulesComboExample = txt.includes(`${BLOCKS.H.pts} X ${mult(5)} = ${hedge5}`) && txt.includes('UP TO X' + f.comboMax);
  // ...and the paddle resets it.
  Object.assign(g.balls[0], { x: g.paddle.x, y: g.paddle.y - 14, vx: 0, vy: 1 }); run(g, 0.15);
  blk = lowest(g, ['T', 'L']); const after = shoot(g, blk);
  out.rulesComboResets = after === BLOCKS[blk.type].pts;
  // Shield bounce does not reset it (the rules only name the paddle).
  g = fresh(0); g.launch(); g.dropRate = 0; g.sinceDrop = -99; shoot(g, lowest(g, ['T', 'L'])); shoot(g, lowest(g, ['T', 'L']));
  g.applyTool('shield'); g.movePaddleTo(190); Object.assign(g.balls[0], { x: 10, y: WH - 12, vx: 0, vy: 1 }); run(g, 0.2);
  out.shieldKeepsCombo = g.combo === 2;

  // Life bonus and stars.
  const winWith = (lives, lost) => { const q = fresh(0); q.launch(); q.lives = lives; q.lost = lost; const b0 = q.blocks[0];
    q.blocks.slice(1).forEach(k => (k.alive = false)); q.remaining = 1; const s0 = q.score; q.combo = 0; shoot(q, b0); return [q.score - s0 - BLOCKS[b0.type].pts, q.stars, q.state]; };
  out.rulesLifeBonus = [1, 2, 3].every(l => winWith(l, 0)[0] === l * f.lifeBonus) && txt.includes('+' + f.lifeBonus);
  out.rulesStars = winWith(3, 0)[1] === 3 && winWith(2, 1)[1] === 2 && winWith(1, 2)[1] === 1 && winWith(3, 4)[1] === 1;

  // Tool durations, measured.
  for (const id of Object.keys(f.toolTime)) { g = fresh(0); g.blocks.forEach(k => (k.alive = false)); g.applyTool(id); let t = 0; while (g.fx[id] > 0 && t < 60) { g.update(1 / 120); t += 1 / 120; } out.measured.toolTime[id] = Math.round(t * 10) / 10; }
  out.rulesToolTimes = Object.keys(f.toolTime).every(id => Math.abs(out.measured.toolTime[id] - f.toolTime[id]) < 0.05 && txt.includes(f.toolTime[id] + ' SEC'));
  // Multiball cap, life loss clearing tools, drop cap.
  g = fresh(0); g.launch(); for (let i = 0; i < 6; i++) g.applyTool('multiball');
  out.rulesMultiballCap = g.balls.length === f.maxBalls;
  g = fresh(0); g.launch(); ['smash', 'freeze', 'expand', 'lowgrav', 'shield'].forEach(id => g.applyTool(id)); g.balls = []; g.loseLife();
  out.rulesLifeLossClearsTools = Object.values(g.fx).every(v => v === 0) && !g.shield && g.drops.length === 0;
  // Smash and freeze kills still score normally.
  g = fresh(hl); g.launch(); g.dropRate = 0; g.sinceDrop = -99; g.applyTool('freeze'); blk = g.blocks.find(k => k.type === 'H');
  for (const k of g.blocks) if (k !== blk && k.r >= blk.r) k.alive = false;
  out.freezeScoresFull = shoot(g, blk) === BLOCKS.H.pts && !blk.alive;

  // Speed: +3% per paddle hit up to the cap.
  g = fresh(0); g.blocks.forEach(k => (k.alive = false)); g.launch(); b = g.balls[0]; const v0 = b.speed; const speeds = [];
  for (let i = 0; i < 30; i++) { Object.assign(b, { x: g.paddle.x, y: g.paddle.y - 14, vx: 0, vy: 1 }); run(g, 0.05); speeds.push(b.speed); }
  out.measured.speedFirst = speeds[0] / v0; out.measured.speedMax = Math.max(...speeds) / LEVELS[0].speed;
  out.rulesSpeed = Math.abs(speeds[0] / v0 - (1 + f.speedUpPct / 100)) < 1e-9 && Math.abs(out.measured.speedMax - f.speedCap) < 1e-9;
  out.rulesProgressionNumbers = f.courts === LEVELS.length && f.startLives === new Game(LEVELS[0]).lives && txt.includes('THERE ARE ' + LEVELS.length) && txt.includes('A LOST LIFE NEVER COMES BACK');

  // Every wrapped line fits the panel.
  const { wrap } = await import('/js/gfx.js');
  out.rulesTextFits = sections().every(s => s.lines.every(p => wrap(p, 188).every(l => textW(l) <= 188)) && s.rows.every(r => r.kind === 'brick' ? 43 + textW(r.left) + textW(r.right) + 13 < 216 : 34 + textW(r.left, 1, 0) + 13 < 216 && 34 + textW(r.name) + textW(r.right) + 13 < 216));

  // Long soak on every level: a simple bot must be able to clear it, the ball
  // must stay finite and in bounds, and tools must actually drop.
  out.levels = [];
  for (let i = 0; i < LEVELS.length; i++) {
    g = new Game(LEVELS[i], () => {}, rng(100 + i));
    let bad = false, drops = 0, t = 0;
    g.emit = (e) => { if (e === 'drop') drops++; };
    while (t < 900 && g.state !== 'won' && g.state !== 'over') {
      if (g.state === 'serve' && g.ready) g.launch();
      const low = g.balls.filter(q => q.vy > 0).sort((p, q) => q.y - p.y)[0];
      if (low) g.movePaddleTo(low.x + Math.sin(t * 1.7) * g.paddle.w * 0.3);
      g.update(1 / 60); t += 1 / 60;
      for (const q of g.balls) if (!isFinite(q.x + q.y) || q.x < 0 || q.x > WW || q.y < 0) bad = true;
      if (g.drops.length > f.maxDrops || g.balls.length > f.maxBalls) bad = true;
    }
    out.levels.push({ n: i + 1, state: g.state, secs: Math.round(t), drops, bad });
  }
  return out;
}
"""


# The main suites run as a returning player, so they see the normal menus.
# The tests never touch a real database: every page starts with the online board
# switched off, and the online suite points it at the stand-in endpoint instead.
OFFLINE = "window.COURT_CONFIG={supabaseUrl:'',supabaseAnonKey:''}"
RETURNING = OFFLINE + "; if(!localStorage.getItem('the-court.save')) localStorage.setItem('the-court.save', JSON.stringify({version:3,onboarded:true}))"


class Driver:
    def __init__(self, page):
        self.pg = page
        self.errors = []
        page.on("console", lambda m: self.errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: self.errors.append("PAGEERROR " + str(e)))
        page.on("request", lambda r: SUPABASE_CALLS.append(r.url.split("?")[0]) if ".supabase.co" in r.url else None)

    def ev(self, js):
        return self.pg.evaluate(js)

    def wait(self, js, timeout=15000):
        self.pg.wait_for_function(js, timeout=timeout)

    def screen(self, name, settle=0.5, timeout=15000):
        self.wait(f"__court.S.screen==='{name}' && !__court.S.leaving && __court.S.t>{settle}", timeout)

    def point(self, rid):
        self.wait(f"__court.ui.regions.some(r=>r.id==='{rid}')")
        return self.ev(
            "(()=>{const r=__court.ui.regions.find(r=>r.id==='%s');const c=document.getElementById('court').getBoundingClientRect();"
            "const k=c.width/document.getElementById('court').width;return [c.left+(r.x+r.w/2)*k,c.top+(r.y+r.h/2)*k]})()" % rid
        )

    def click(self, rid):
        x, y = self.point(rid)
        self.pg.mouse.click(x, y)

    def tap(self, rid):
        x, y = self.point(rid)
        self.pg.touchscreen.tap(x, y)

    def shot(self, name):
        if SHOTS:
            self.pg.screenshot(path=str(SHOTS / f"{name}.png"))

    def saved(self):
        return json.loads(self.ev("localStorage.getItem('the-court.save')") or "null")


def desktop(browser, url):
    print("desktop 1280x800 - mouse and keyboard")
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    pg = d.pg
    pg.goto(url)
    d.wait("window.__court && __court.S.screen==='loading'")
    d.shot("01-preparing")
    check("loading screen shows first", True)
    d.screen("title", 1.4)
    d.shot("02-title")
    ids = d.ev("__court.ui.regions.map(r=>r.id).join()")
    check("landing screen: the two cards (The Rally, Multiplayer), then Courts, Scores and Sound", ids == "play,multiplayer,courts,scores,sound", ids)
    # The row under the cards opens what it says.
    d.click("scores")
    d.screen("scores", 0.6)
    check("landing: SCORES opens the leaderboard", d.ev("__court.S.screen") == "scores")
    d.ev("__court.go('title')")
    d.screen("title", 0.8)
    d.click("courts")
    d.screen("courts", 0.6)
    check("landing: COURTS opens the courts", d.ev("__court.S.screen") == "courts")
    d.ev("__court.go('title')")
    d.screen("title", 0.8)
    d.click("sound")
    d.wait("__court.S.overlayT>=1")
    check("landing: SOUND opens the sound settings", d.ev("__court.S.overlayKind") == "sound")
    d.ev("__court.S.overlay = null")
    d.wait("__court.S.overlayT<=0")

    # --- sound controls (reached from the courts screen)
    d.click("play")
    d.screen("courts", 0.6)
    d.click("sound")
    d.wait("__court.S.overlayT>=1")
    x, y = d.point("music")
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.move(x - 400, y, steps=5)
    pg.mouse.up()
    check("music slider drags to 0", d.ev("__court.save.data.settings.music") == 0)
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.move(x + 20, y, steps=3)
    pg.mouse.up()
    music = d.ev("__court.save.data.settings.music")
    check("music slider sets a mid value", 0.4 < music < 0.9, music)
    x, y = d.point("sfx")
    pg.mouse.click(x - 30, y)
    sfx = d.ev("__court.save.data.settings.sfx")
    check("effects slider responds to a click", 0.05 < sfx < 0.5, sfx)
    time.sleep(0.3)
    gains = d.ev("[__court.audio.ac.state, __court.audio.musicG.gain.value, __court.audio.sfxG.gain.value, __court.audio.master.gain.value]")
    check("audio graph follows the sliders", gains[0] == "running" and abs(gains[1] - music * 0.5) < 0.02 and abs(gains[2] - sfx * 0.6) < 0.02 and gains[3] > 0.95, gains)
    d.click("mute")
    time.sleep(0.3)
    check("mute button silences master", d.ev("__court.save.data.settings.muted") and d.ev("__court.audio.master.gain.value") < 0.02)
    d.shot("03-sound")
    pg.keyboard.press("m")
    time.sleep(0.3)
    check("M key unmutes", not d.ev("__court.save.data.settings.muted") and d.ev("__court.audio.master.gain.value") > 0.95)
    d.click("done")
    d.wait("__court.S.overlayT<=0")
    s = d.saved()
    check("sound settings are saved", s and s["settings"]["music"] == music and s["settings"]["sfx"] == sfx and s["settings"]["muted"] is False, s and s["settings"])
    d.wait("__court.audio.current==='select'", 20000)
    check("menu music (Stage Select) is loaded from assets/music and playing", d.ev("__court.audio.playing && __court.audio.current==='select' && __court.audio.voice.src.loop"))

    # --- How to Play, from the courts screen
    rules_menu(d, "courts")
    d.click("rules")
    d.wait("__court.S.overlayT>=1")
    pg.keyboard.press("ArrowRight")
    pg.keyboard.press("ArrowRight")
    t1 = d.ev("__court.S.rulesTab")
    pg.keyboard.press("ArrowLeft")
    page = d.ev("__court.S.page")
    check("rules: arrow keys change section, not the court page behind", t1 == 1 and d.ev("__court.S.rulesTab") == 0 and page == 0, t1)
    pg.keyboard.press("ArrowLeft")
    check("rules: sections wrap around", d.ev("__court.S.rulesTab") == 4)
    pg.keyboard.press("Escape")
    d.wait("__court.S.overlayT<=0")
    check("rules: Esc closes it and stays on courts", d.ev("__court.S.screen") == "courts")
    pg.keyboard.press("Escape")
    d.screen("title")
    d.ev("__court.S.introSeen=false")

    # --- menu flow
    d.click("play")
    d.screen("intro", 0.9)
    d.shot("04-elevated-rally")
    check("intro screen (Elevated Rally)", True)
    d.screen("courts", 0.6)
    d.shot("05-courts")
    locked = d.ev("__court.ui.regions.filter(r=>/^court\\d+$/.test(r.id)).map(r=>r.id).join()")
    check("courts screen: only court 1 unlocked on a fresh save", locked == "court0", locked)
    d.click("nextpage")
    time.sleep(0.2)
    check("courts screen pages through 120 courts", d.ev("__court.S.page") == 1 and d.ev("__court.LEVELS.length") == 120)
    pg.keyboard.press("ArrowLeft")
    time.sleep(0.2)
    d.click("court0")
    d.screen("tools", 0.6)
    d.click("tool2")
    check("tools screen: selecting a tool", d.ev("__court.S.tool") == 2)
    d.shot("06-tools")
    d.click("back")
    d.screen("courts")
    pg.keyboard.press("Escape")
    d.screen("title")
    check("back navigation (button and Escape)", True)
    d.click("play")
    d.screen("courts", 0.6)
    d.click("court0")
    d.screen("tools", 0.6)
    d.click("begin")
    d.screen("countdown", 0.4)
    d.shot("07-countdown")
    check("countdown screen", d.ev("__court.S.game.balls[0].stuck"))
    d.screen("play", 0.2)
    check("ball auto-serves after the countdown", d.ev("__court.S.game.state==='play'"))

    # --- real mouse steering
    box = d.ev("(()=>{const r=document.getElementById('court').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
    pg.mouse.move(box[0] + box[2] * 0.3, box[1] + box[3] * 0.8)
    time.sleep(0.8)
    left = d.ev("[__court.S.game.paddle.x, __court.proj(100,0).x, __court.S.shift]")
    pg.mouse.move(box[0] + box[2] * 0.7, box[1] + box[3] * 0.8)
    time.sleep(0.8)
    right = d.ev("[__court.S.game.paddle.x, __court.proj(100,0).x, __court.S.shift]")
    check("mouse moves the paddle", left[0] < 60 and right[0] > 140, (round(left[0]), round(right[0])))
    check("3D camera trucks with the paddle (far court slides against near)", right[1] - left[1] > 4 and left[2] < -5 and right[2] > 5, (left[1], right[1]))

    # --- pause / resume
    pg.keyboard.press("p")
    d.screen("paused", 0.5)
    a = d.ev("[__court.S.game.balls[0].x, __court.S.game.balls[0].y]")
    time.sleep(0.4)
    b = d.ev("[__court.S.game.balls[0].x, __court.S.game.balls[0].y]")
    check("P pauses and the ball holds still", a == b)
    d.shot("08-paused")
    d.click("resume")
    d.screen("play", 0.1)
    time.sleep(0.2)
    c = d.ev("[__court.S.game.balls.length ? __court.S.game.balls[0].y : -1, __court.S.game.t]")
    check("resume continues play", d.ev("__court.S.screen") == "play" and c != b)
    d.click("pause")
    d.screen("paused", 0.5)
    check("pause button works", True)
    a = d.ev("[__court.S.game.balls[0].x, __court.S.game.balls[0].y, __court.S.game.score]")
    rules_menu(d, "pause")
    check("rules from pause: game untouched and still paused", d.ev("[__court.S.game.balls[0].x, __court.S.game.balls[0].y, __court.S.game.score]") == a and d.ev("__court.S.screen") == "paused")
    d.click("restart")
    d.screen("countdown", 0.05)
    check("restart from pause gives a fresh rally", d.ev("__court.S.game.score===0 && __court.S.game.lives===3 && __court.S.game.remaining===__court.S.game.total"))
    d.screen("play", 0.1)

    # --- keyboard steering and serving
    d.ev("(()=>{const g=__court.S.game; g.balls=[]; g.loseLife();})()")
    check("losing a ball costs a life", d.ev("__court.S.game.lives") == 2 and d.ev("__court.S.game.state") == "serve")
    pg.mouse.move(box[0] + box[2] * 0.5, box[1] + box[3] * 0.8)
    x0 = d.ev("__court.S.game.paddle.x")
    pg.keyboard.down("ArrowLeft")
    time.sleep(0.25)
    pg.keyboard.up("ArrowLeft")
    x1 = d.ev("__court.S.game.paddle.x")
    pg.keyboard.down("d")
    time.sleep(0.4)
    pg.keyboard.up("d")
    x2 = d.ev("__court.S.game.paddle.x")
    check("arrow keys and A/D move the paddle", x1 < x0 - 30 and x2 > x1 + 50, (round(x0), round(x1), round(x2)))
    d.shot("09-serve")
    pg.keyboard.press("Space")
    check("Space serves", d.ev("__court.S.game.state") == "play")

    # --- play court 1 to the end with the bot, through the real frame loop
    pg.evaluate(BOT)
    d.ev("__court.S.timeScale=3; __bot.on=true")
    d.wait("__court.S.game.score>100", 60000)
    d.shot("10-play")
    check("blocks break and score climbs", True)
    d.wait("__court.S.ending>0 && __court.S.result && __court.S.result.won", 240000)
    lives = d.ev("__court.S.game.lives")
    d.wait("__court.S.level===1 && __court.S.screen==='countdown' && !__court.S.leaving && __court.S.t>0.9", 20000)
    d.shot("11-court-cleared")
    r = d.ev("__court.S.result")
    c = d.ev("__court.S.cleared")
    check("court 1 won -> straight into court 2, no Rally Complete popup and no Next button",
          r["won"] and r["score"] > 300 and r["newBest"] and not d.ev("__court.ui.regions.some(r=>r.id==='next'||r.id==='replay')"), r)
    check("the countdown tells the player how court 1 went (stars and score)", c and c["court"] == 1 and c["stars"] == r["stars"] and c["score"] == r["score"] and c["newBest"], c)
    s = d.saved()
    check("win is saved (best score, stars, next court unlocked)", s["progress"]["unlocked"] == 2 and s["progress"]["levels"]["baseline"]["best"] == r["score"] and s["progress"]["levels"]["baseline"]["stars"] == r["stars"], s["progress"])

    # --- the next court carries the run; then lose on purpose
    d.screen("play", 0.1, 20000)
    check("the note goes once the court starts", not d.ev("__court.ui.regions.some(r=>r.id==='next')"))
    g = d.ev("[__court.S.level, __court.S.game.score, __court.S.game.lives]")
    check("moving on carries score; a lost life is not given back", g[0] == 1 and g[1] >= r["run"] and g[2] == lives and lives < 3, {"lives before": lives, "after Next": g[2]})
    d.ev("__bot.mode='lose'")
    d.screen("name", 1.0, 240000)
    run = d.ev("__court.S.run.score")
    check("losing every ball ends the run on the name screen", d.ev("__court.S.game.lives") == 0 and run >= r["run"], run)

    # --- leaderboard: type a name, save, see it listed
    pg.keyboard.type("pando")
    pg.keyboard.press("Backspace")
    d.click("keyA")
    check("name entry by keyboard and on-screen keys", d.ev("__court.S.name") == "PANDA", d.ev("__court.S.name"))
    d.shot("12-name-entry")
    check("name screen: no Skip button; a close (X) sits in the panel's top-right corner",
          d.ev("(()=>{const r=__court.ui.regions, c=r.find(q=>q.id==='close'), sv=r.find(q=>q.id==='save'); return !r.some(q=>q.id==='skip') && c && sv && c.x > sv.x + sv.w - 10 && c.y < sv.y - 100})()"))
    d.click("save")
    d.screen("scores", 0.8)
    d.shot("13-leaderboard")
    s2 = d.saved()
    top = s2["leaderboard"][0]
    check("score is added to the leaderboard and saved", len(s2["leaderboard"]) == 1 and top["name"] == "PANDA" and top["score"] == run and top["court"] == 2 and d.ev("__court.S.board.rank") == 0, top)
    check("a loss keeps progress and counts the play", s2["progress"] == s["progress"] and s2["stats"]["plays"] == 2 and s2["stats"]["wins"] == 1, s2["stats"])
    d.click("again")
    d.screen("play", 0.1, 20000)
    check("Play Again starts a fresh run with 3 balls", d.ev("__court.S.game.lives===3 && __court.S.game.score===0 && __court.S.level===1"))

    # --- stopping mid-run from the pause menu also offers the leaderboard
    d.ev("__bot.mode='win'")
    d.wait("__court.S.game.score>60", 60000)
    pg.keyboard.press("Escape")
    d.screen("paused", 0.5)
    d.click("home")
    d.screen("name", 0.8)
    check("Home mid-run asks for a name", d.ev("__court.S.nameTitle") == "RALLY ENDED" and d.ev("__court.S.name") == "PANDA")
    pg.keyboard.press("Enter")
    d.screen("scores", 0.8)
    check("second score is ranked", len(d.saved()["leaderboard"]) == 2 and d.saved()["leaderboard"][0]["score"] >= d.saved()["leaderboard"][1]["score"])
    d.click("home")
    d.screen("title", 0.6)
    check("Home returns to the title", True)

    # --- a run with no points skips name entry
    d.ev("__bot.mode='lose'; __court.beginRun(0)")
    d.screen("name", 0.8, 240000)
    if d.ev("__court.S.run.score") == 0:
        check("a scoreless run offers Retry instead of name entry", d.ev("__court.ui.regions.some(r=>r.id==='retry') && !__court.ui.regions.some(r=>r.id==='save')"))
        d.click("home")
    else:
        d.click("close")
        d.screen("scores", 0.6)
        check("Skip leaves the leaderboard unchanged", len(d.saved()["leaderboard"]) == 2)
        d.click("home")
    d.screen("title", 0.6)

    # --- persistence across a reload
    pg.reload()
    d.screen("title", 1.4)
    check("save survives a reload", d.ev("__court.save.data.progress.unlocked") == 2 and d.ev("__court.save.data.settings.music") == music and d.ev("__court.save.data.leaderboard.length") == 2)
    d.click("play")
    d.screen("courts", 0.6)
    d.click("scores")
    d.screen("scores", 0.6)
    check("leaderboard opens from the courts screen", d.ev("__court.ui.regions.some(r=>r.id==='back')"))
    pg.keyboard.press("Escape")
    d.screen("title", 0.6)
    d.click("play")
    d.screen("courts", 0.6)
    check("court 2 is now selectable", d.ev("__court.ui.regions.some(r=>r.id==='court1') && !__court.ui.regions.some(r=>r.id==='court2')"))

    # --- animated background
    pg.keyboard.press("Escape")
    d.screen("title", 0.6)
    grab = "(()=>{const c=document.getElementById('court');return Array.from(c.getContext('2d').getImageData(0,0,c.width,Math.floor(c.height*0.3)).data).reduce((a,v,i)=>(a+v*(i%251+1))%1000003,0)})()"
    a1 = d.ev(grab)
    time.sleep(1.2)
    check("background is in motion (sky changes between frames)", d.ev(grab) != a1)

    # --- a spread of later courts, each played through in the browser
    pg.evaluate(BOT)
    for i in (2, 39, 79, 119):
        won = False
        for attempt in range(5):
            d.ev(f"__court.S.timeScale=2; __bot.mode='win'; __bot.on=true; __court.save.data.progress.unlocked=120; __court.beginRun({i})")
            d.wait(f"__court.S.level==={i} && __court.S.screen==='play'", 30000)
            d.wait(f"(__court.S.screen==='complete'||__court.S.screen==='name'||__court.S.level!=={i}) && !__court.S.leaving && __court.S.t>1", 400000)
            if d.ev("__court.S.screen") == "complete" or d.ev(f"__court.S.level==={i + 1}"):
                won = True
                break
        d.shot(f"14-court-{i + 1}")
        r = d.ev("__court.S.result")
        check(f"court {i + 1} plays through and is won", won, {"score": r["score"], "stars": r["stars"], "attempts": attempt + 1})
    check("the last court (120) still ends on Rally Complete, with no Next button", d.ev("__court.S.screen==='complete' && !__court.ui.regions.some(r=>r.id==='next') && __court.ui.regions.some(r=>r.id==='replay')"))
    d.ev("__bot.on=false; __court.S.timeScale=1")
    d.click("home")
    d.screen("name", 0.6)
    pg.keyboard.press("Escape")
    d.screen("scores", 0.6)
    d.click("home")
    d.screen("title", 0.6)

    # --- erase save
    d.click("play")
    d.screen("courts", 0.6)
    d.click("sound")
    d.wait("__court.S.overlayT>=1")
    d.click("erase")
    time.sleep(0.15)
    check("erase needs a second tap", d.ev("__court.save.data.progress.unlocked") == 120)
    d.click("erase")
    time.sleep(0.3)
    s = d.saved()
    check("erase clears progress and leaderboard but keeps sound settings", s["progress"]["unlocked"] == 1 and s["progress"]["levels"] == {} and s["leaderboard"] == [] and s["settings"]["music"] == music and s["onboarded"] is False, s)
    pg.keyboard.press("Escape")
    d.wait("__court.S.overlayT<=0")

    # --- rules, in isolation
    out = pg.evaluate(RULES)
    for k, v in out.items():
        if k not in ("levels", "facts", "measured"):
            check("rules: " + k, v)
    print("  measured:", json.dumps(out["measured"]))
    print("  shown:   ", json.dumps(out["facts"]))
    bad = [lv for lv in out["levels"] if lv["state"] != "won" or lv["bad"] or lv["drops"] == 0]
    secs = [lv["secs"] for lv in out["levels"]]
    check(f"rules: all {len(out['levels'])} courts clearable, ball stays in court, tools drop", not bad, bad[:3] or f"{min(secs)}-{max(secs)}s of play each")

    fit = d.ev("(()=>{const r=document.getElementById('court').getBoundingClientRect();return [r.width,r.height,innerWidth,innerHeight].concat(__court.size())})()")
    check("desktop: canvas fills the whole window and the court view widens", fit[0] >= fit[2] * 0.98 and fit[1] >= fit[3] * 0.98 and fit[4] > 400, fit)
    check("no console errors (desktop)", not d.errors, d.errors[:3])
    ctx.close()


def touch_device(browser, url, name, w, h):
    print(f"{name} {w}x{h} - touch")
    ctx = browser.new_context(viewport={"width": w, "height": h}, has_touch=True, is_mobile=True, device_scale_factor=2)
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    pg = d.pg
    pg.goto(url)
    d.screen("title", 1.4)
    fit = d.ev("(()=>{const r=document.getElementById('court').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight,document.documentElement.scrollWidth,document.documentElement.scrollHeight]})()")
    inside = fit[0] >= 0 and fit[1] >= 0 and fit[2] <= fit[4] + 0.5 and fit[3] <= fit[5] + 0.5 and fit[6] <= fit[4] and fit[7] <= fit[5]
    fills = (fit[2] - fit[0]) >= fit[4] * 0.98 and (fit[3] - fit[1]) >= fit[5] * 0.98
    check(f"{name}: canvas fits the viewport with no scrolling", inside and fills, [round(v) for v in fit])
    d.shot(f"{name}-title")
    d.tap("play")
    d.screen("intro", 0.3)
    pg.touchscreen.tap(w / 2, h / 2)
    d.screen("courts", 0.6)
    check(f"{name}: tapping skips the intro", True)
    d.tap("court0")
    d.screen("tools", 0.6)
    d.shot(f"{name}-tools")
    d.tap("begin")
    d.screen("play", 0.3)
    d.shot(f"{name}-play")
    check(f"{name}: touch reaches gameplay", d.ev("__court.S.touch") is True)

    # Relative drag steering through raw touch events.
    cdp = ctx.new_cdp_session(pg)
    d.ev("(()=>{const g=__court.S.game; g.balls=[]; g.loseLife(); g.movePaddleTo(100)})()")

    def touch(kind, x, y):
        pts = [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 1}]
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": pts})

    y = h * 0.6
    touch("touchStart", w * 0.3, y)
    for i in range(1, 9):
        touch("touchMove", w * 0.3 + w * 0.25 * i / 8, y)
        time.sleep(0.016)
    touch("touchEnd", 0, 0)
    time.sleep(0.1)
    px = d.ev("__court.S.game.paddle.x")
    check(f"{name}: dragging steers the paddle", px > 130 and d.ev("__court.S.game.state") == "serve", round(px))
    pg.touchscreen.tap(w * 0.5, h * 0.5)
    time.sleep(0.1)
    check(f"{name}: tap serves", d.ev("__court.S.game.state") == "play")
    d.tap("pause")
    d.screen("paused", 0.5)
    d.shot(f"{name}-paused")
    check(f"{name}: pause button", True)
    d.tap("sound")
    d.wait("__court.S.overlayT>=1")
    d.tap("mute")
    check(f"{name}: sound toggle by touch", d.ev("__court.save.data.settings.muted") is True)
    d.tap("done")
    d.wait("__court.S.overlayT<=0")
    rules_menu(d, name, tap=True)
    d.ev("__court.S.game.score=420; __court.S.run.score=420")
    d.tap("home")
    d.screen("name", 0.8)
    for key in ("keyT", "key2", "keyP", "keyP", "keydel"):
        d.tap(key)
        time.sleep(0.05)
    d.shot(f"{name}-name")
    d.tap("save")
    d.screen("scores", 0.8)
    d.shot(f"{name}-leaderboard")
    top = d.saved()["leaderboard"][0]
    check(f"{name}: name typed on the on-screen keys (letters and numbers) reaches the leaderboard", top["name"] == "T2P" and top["score"] == 420, top)
    d.tap("home")
    d.screen("title", 0.6)

    # Rotate / resize while running.
    pg.set_viewport_size({"width": h, "height": w})
    time.sleep(0.5)
    fit = d.ev("(()=>{const r=document.getElementById('court').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight]})()")
    check(f"{name}: refills the screen after rotating to landscape", fit[0] >= 0 and fit[2] <= fit[4] + 0.5 and fit[3] <= fit[5] + 0.5 and (fit[3] - fit[1]) >= fit[5] * 0.98 and (fit[2] - fit[0]) >= fit[4] * 0.98, [round(v) for v in fit])
    d.shot(f"{name}-landscape")
    d.tap("play")
    d.wait("__court.S.screen==='courts' || __court.S.screen==='intro'")
    check(f"{name}: still interactive in landscape", True)
    check(f"no console errors ({name})", not d.errors, d.errors[:3])
    ctx.close()


def rules_menu(d, where, tap=False):
    """Open How to Play from the current screen, visit every section, close it."""
    press = d.tap if tap else d.click
    press("rules")
    d.wait("__court.S.overlay==='rules' && __court.S.overlayT>=1")
    ids = d.ev("__court.ui.regions.map(r=>r.id).join()")
    check(f"{where}: How to Play opens and blocks the screen behind it", ids == "tab0,tab1,tab2,tab3,tab4,done", ids)
    fits = []
    for i in range(5):
        press(f"tab{i}")
        time.sleep(0.15)
        fits.append(d.ev(f"__court.S.rulesTab==={i} && __court.S.rulesFits"))
        d.shot(f"rules-{where}-{i}")
    box = d.ev("(()=>{const r=__court.ui.regions; const s=__court.size(); return r.every(q=>q.x>=0&&q.y>=0&&q.x+q.w<=s[0]&&q.y+q.h<=s[1])})()")
    check(f"{where}: all five sections open, fit the panel and stay on screen", all(fits) and box, fits)
    press("done")
    d.wait("__court.S.overlayT<=0")
    check(f"{where}: Done closes it", d.ev("__court.S.overlay") is False)


def online_board(browser, url):
    """Online leaderboard (read, and post a saved run), against the stand-in endpoint above."""
    print("online leaderboard - read and post")
    origin = url.split("/?")[0]
    seed = RETURNING + "; if(!localStorage.getItem('seeded')){localStorage.setItem('seeded','1'); const d=JSON.parse(localStorage.getItem('the-court.save')); d.leaderboard=[{name:'LOCAL',score:321,court:2,at:1}]; localStorage.setItem('the-court.save', JSON.stringify(d));}"

    # 1. Not configured: nothing changes and nothing is requested.
    MOCK["requests"].clear()
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(seed)
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.4)
    d.click("play")
    d.screen("courts", 0.6)
    d.click("scores")
    d.screen("scores", 0.8)
    ids = d.ev("__court.ui.regions.map(r=>r.id).join()")
    check("online off (empty config): leaderboard is the device board, no device/online switch, no network calls",
          "back" in ids and "tablocal" not in ids and "tabonline" not in ids and d.ev("__court.onlineEnabled()") is False and not MOCK["requests"], ids)
    ctx.close()

    def open_board(vp, touch=False, mode="ok", key=None):
        MOCK["mode"] = mode
        MOCK["requests"].clear()
        c = browser.new_context(viewport=vp, has_touch=touch, is_mobile=touch)
        c.add_init_script(seed + f"; window.COURT_CONFIG={{supabaseUrl:'{origin}', supabaseAnonKey:'{key or MOCK['key']}'}}")
        dd = Driver(c.new_page())
        dd.pg.goto(url)
        dd.screen("title", 1.4)
        (dd.tap if touch else dd.click)("play")
        dd.screen("courts", 0.6, 20000)
        (dd.tap if touch else dd.click)("scores")
        dd.screen("scores", 0.8)
        return c, dd

    # 2. Configured: reads and shows the online rows.
    ctx, d = open_board({"width": 1280, "height": 800})
    d.wait("__court.S.online.state==='ok'")
    rows = d.ev("__court.S.online.rows")
    req = MOCK["requests"][0]
    check("online on: the board is the online one and sends the anon key", d.ev("__court.S.boardTab") == "online" and req["apikey"] == MOCK["key"] and req["auth"] == "Bearer " + MOCK["key"], req)
    ids = d.ev("__court.ui.regions.map(r=>r.id).join()")
    check("online only: no This Device / Online switch on the board", "tablocal" not in ids and "tabonline" not in ids and "back" in ids, ids)
    check("request asks for the top 20, best first", "order=score.desc" in req["path"] and "limit=20" in req["path"] and "select=name,score,court" in req["path"], req["path"])
    names = [r["name"] for r in rows[:4]]
    check("rows shown in score order with unsafe names cleaned", names == ["AANYA", "SCRIPTX", "PLAYER", "AVERYVER"] and rows[3]["court"] == 5 and [r["score"] for r in rows] == sorted([r["score"] for r in rows], reverse=True), names)
    check("malformed rows dropped and the list capped at 20", len(rows) == 20 and all(isinstance(r["score"], int) and r["score"] >= 0 for r in rows) and "BAD" not in [r["name"] for r in rows])
    d.shot("online-1-board")
    check("the device copy of scores is kept, just not shown", d.ev("__court.save.data.leaderboard[0].name") == "LOCAL")
    d.pg.keyboard.press("Escape")
    d.screen("title", 0.6)
    n = len(MOCK["requests"])
    d.ev("__court.go('scores')")
    d.screen("scores", 0.6)
    check("opening the board again within 30 s reuses the result instead of re-fetching", len(MOCK["requests"]) == n and d.ev("__court.S.online.state") == "ok")
    d.pg.keyboard.press("Escape")
    d.screen("title", 0.6)

    # Finishing a run posts it once, through submit_score only.
    def finish_run(dd, name):
        dd.pg.evaluate(BOT)
        dd.ev("__court.S.timeScale=3; __bot.mode='win'; __bot.on=true; __court.beginRun(0)")
        dd.wait("__court.S.screen==='play' && __court.S.game.score>60", 60000)
        dd.ev("__bot.mode='lose'")
        dd.screen("name", 0.8, 240000)
        if name is None:
            dd.click("close")
        else:
            dd.pg.keyboard.type(name)
            dd.pg.keyboard.press("Enter")
        dd.screen("scores", 0.8)

    MOCK["posted"].clear()
    finish_run(d, "me")
    d.wait("__court.S.post.state==='sent'")
    posts = [r for r in MOCK["requests"] if r["method"] == "POST"]
    mine = next((e for e in d.saved()["leaderboard"] if e["name"] == "ME"), None)
    check("a saved run is sent online once, with the same name, score and court as the device copy",
          len(posts) == 1 and mine and MOCK["posted"] == [{"name": "ME", "score": mine["score"], "court": mine["court"]}], (posts, mine))
    check("it goes through the submit_score function with the public key, never straight into the table",
          posts[0]["path"] == "/rest/v1/rpc/submit_score" and posts[0]["apikey"] == MOCK["key"] and posts[0]["prefer"] == "return=minimal", posts[0])
    gets = [r for r in MOCK["requests"] if r["method"] == "GET"]
    d.wait("__court.S.online.state==='ok'")
    time.sleep(0.4)
    d.wait("__court.S.online.rows.some(r=>r.name==='ME')")
    check("after the run the online board is shown, fetched again so the new score is on it",
          d.ev("__court.S.boardTab") == "online" and len(gets) >= 1)
    check("the player's own score is highlighted on the online board", d.ev("__court.S.online.rows.findIndex(r=>r.name==='ME' && r.score===__court.S.post.entry.score)") >= 0)
    d.shot("online-4-sent")
    d.pg.keyboard.press("Escape")
    d.screen("title", 0.6)
    finish_run(d, None)
    time.sleep(0.5)
    check("Skip sends nothing", len(MOCK["posted"]) == 1 and len([r for r in MOCK["requests"] if r["method"] == "POST"]) == 1)
    check("no console errors (online, desktop)", not d.errors, d.errors[:3])
    ctx.close()

    # Sending fails: the device copy stays, a retry is offered, and it works once the server answers.
    ctx, d = open_board({"width": 1280, "height": 800})
    d.wait("__court.S.online.state==='ok'")
    d.pg.keyboard.press("Escape")
    d.screen("title", 0.6)
    MOCK["mode"] = "postfail"
    MOCK["posted"].clear()
    finish_run(d, "late")
    d.wait("__court.S.post.state==='error'")
    check("send failure: score kept on the device, 'tap to retry' offered",
          d.ev("__court.S.post.error") == "http-500" and any(e["name"] == "LATE" for e in d.saved()["leaderboard"]) and d.ev("__court.ui.regions.some(r=>r.id==='retrypost')"))
    d.shot("online-5-notsent")
    MOCK["mode"] = "ok"
    d.click("retrypost")
    d.wait("__court.S.post.state==='sent'")
    time.sleep(0.3)
    check("retry sends it, exactly once, and the retry link goes away", len(MOCK["posted"]) == 1 and MOCK["posted"][0]["name"] == "LATE" and not d.ev("__court.ui.regions.some(r=>r.id==='retrypost')"))
    ctx.close()

    # The server limit in submit_score.sql must fit the best score any court can give.
    c = browser.new_context()
    c.add_init_script(OFFLINE)
    pg = c.new_page()
    pg.goto(url)
    pg.wait_for_function("window.__court")
    best = pg.evaluate("""async () => {
        const g = await import('./js/game.js');
        const top = Math.max(...Object.values(g.BLOCKS).map(b => b.pts)) * g.comboMult(99);
        return Math.max(...__court.LEVELS.map(l => l.rows.join('').replace(/[.]/g, '').length * top + g.START_LIVES * g.LIFE_BONUS));
    }""")
    check(f"server score limit ({MAX_PER_COURT} per court) is at least the most a court can give ({best})", best <= MAX_PER_COURT, best)
    c.close()

    # 3. Failures are shown, not thrown.
    ctx, d = open_board({"width": 1280, "height": 800}, mode="fail")
    d.wait("__court.S.online.state==='error'")
    check("server error: friendly message with Try Again", d.ev("__court.S.online.error") == "http-500" and d.ev("__court.ui.regions.some(r=>r.id==='retryonline')"))
    d.shot("online-3-error")
    MOCK["mode"] = "ok"
    d.click("retryonline")
    d.wait("__court.S.online.state==='ok'")
    check("Try Again recovers once the server answers", d.ev("__court.S.online.rows.length") == 20)
    ctx.close()
    ctx, d = open_board({"width": 1280, "height": 800}, key="wrong-key")
    d.wait("__court.S.online.state==='error'")
    check("wrong key: handled as an error (401), game keeps working", d.ev("__court.S.online.error") == "http-401")
    d.pg.keyboard.press("Escape")
    d.screen("title", 0.6)
    ctx.close()
    ctx, d = open_board({"width": 1280, "height": 800}, mode="empty")
    d.wait("__court.S.online.state==='ok'")
    check("empty online board: says so", d.ev("__court.S.online.rows.length") == 0)
    ctx.close()
    c = browser.new_context(viewport={"width": 1280, "height": 800})
    c.add_init_script(seed + "; window.COURT_CONFIG={supabaseUrl:'http://127.0.0.1:9', supabaseAnonKey:'k'}")
    d = Driver(c.new_page())
    d.pg.goto(url)
    d.screen("title", 1.4)
    d.click("play")
    d.screen("courts", 0.6, 20000)
    d.click("scores")
    d.wait("__court.S.online.state==='error'", 20000)
    check("unreachable server: network error state, no crash", d.ev("__court.S.online.error") in ("network", "timeout"), d.ev("__court.S.online.error"))
    c.close()

    # 4. Loading state, touch and small screens.
    for name, vp in (("tablet", {"width": 820, "height": 1180}), ("mobile", {"width": 390, "height": 844})):
        ctx, d = open_board(vp, touch=True, mode="slow")
        seen = d.ev("__court.S.online.state")
        d.wait("__court.S.online.state==='ok'")
        box = d.ev("(()=>{const r=__court.ui.regions; const s=__court.size(); return r.every(q=>q.x>=0&&q.y>=0&&q.x+q.w<=s[0]&&q.y+q.h<=s[1])})()")
        d.shot(f"online-{name}")
        d.tap("back")
        d.screen("title", 0.3)
        check(f"{name}: shows Loading, then rows; fits the screen; Back works by touch", seen == "loading" and box, seen)
        check(f"no console errors (online, {name})", not d.errors, d.errors[:3])
        ctx.close()
    MOCK["mode"] = "ok"
    real = [r for r in SUPABASE_CALLS]
    check("the whole test run sent nothing to a real Supabase project", not real, real[:3])


def first_time(browser, url):
    print("first-time journey - new and returning players")
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(OFFLINE)
    d = Driver(ctx.new_page())
    pg = d.pg
    pg.goto(url)
    d.screen("title", 1.4)
    check("new user: no save yet, not onboarded", d.saved() is None and d.ev("__court.save.data.onboarded") is False)
    d.click("play")
    d.screen("intro", 0.3)
    d.wait("__court.S.screen==='countdown' || __court.S.screen==='courts' || __court.S.screen==='tools'", 15000)
    check("new user: Play goes intro -> court 1, skipping courts and tools", d.ev("__court.S.screen") == "countdown" and d.ev("__court.S.level") == 0)
    d.screen("play", 0.4)
    g = d.ev("[__court.S.game.state, __court.S.coach.step, __court.S.game.level.speed, __court.LEVELS[0].speed, __court.ui.regions.some(r=>r.id==='skiptips')]")
    check("new user: ball waits on the paddle with a 'move' hint and a slower ball", g[0] == "serve" and g[1] == "move" and g[2] < g[3] and g[4], g)
    d.shot("ftue-1-move")
    time.sleep(1.0)
    check("new user: nothing happens until they act", d.ev("__court.S.game.state") == "serve")
    box = d.ev("(()=>{const r=document.getElementById('court').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
    pg.mouse.move(box[0] + box[2] * 0.4, box[1] + box[3] * 0.8)
    pg.mouse.move(box[0] + box[2] * 0.6, box[1] + box[3] * 0.8, steps=8)
    time.sleep(0.2)
    check("new user: moving the paddle advances to the 'serve' hint", d.ev("__court.S.coach.step") == "serve")
    d.shot("ftue-2-serve")
    pg.keyboard.press("Space")
    time.sleep(0.2)
    check("new user: serving advances to the 'break' hint", d.ev("__court.S.game.state") == "play" and d.ev("__court.S.coach.step") == "break")
    pg.evaluate(BOT)
    d.ev("__court.S.timeScale=2; __bot.on=true")
    d.wait("__court.S.coach && __court.S.coach.step==='tool'", 60000)
    check("new user: the first tool is Expand, with a hint", d.ev("__court.S.game.drops[0].type") == "expand")
    d.shot("ftue-3-tool")
    check("new user: still not marked onboarded mid-rally", d.ev("__court.save.data.onboarded") is False)
    d.wait("(__court.S.level===1||__court.S.screen==='name') && !__court.S.leaving && __court.S.t>1", 300000)
    s = d.saved()
    check("new user: finishing the first rally marks them onboarded and saves it", s["onboarded"] is True and d.ev("__court.S.coach") is None, s["onboarded"])
    if d.ev("__court.S.level") == 1:
        d.screen("play", 0.3, 20000)
        check("after the tutorial, court 2 is the normal game (auto-serve, full speed, no hints)", d.ev("__court.S.game.state==='play' && __court.S.game.level.speed===__court.LEVELS[1].speed && !__court.ui.regions.some(r=>r.id==='skiptips')"))
    d.ev("__bot.on=false; __court.S.timeScale=1")

    # Returning: same browser after a reload.
    pg.reload()
    d.screen("title", 1.4)
    d.click("play")
    d.screen("courts", 0.5, 20000)
    check("returning user: Play goes to the court grid, as before", d.ev("__court.S.coach") is None)
    ctx.close()

    # Skipping the tips.
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.add_init_script(OFFLINE)
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.4)
    d.tap("play")
    d.screen("intro", 0.3)
    d.pg.touchscreen.tap(195, 400)
    d.screen("play", 0.4, 20000)
    check("new user on touch: hint uses touch wording", d.ev("__court.S.coach.step") == "move" and d.ev("__court.S.touch") is True)
    d.shot("ftue-4-mobile")
    d.tap("skiptips")
    time.sleep(0.3)
    check("Skip Tips ends the tutorial, saves it, and leaves the rally running", d.ev("__court.S.coach") is None and d.saved()["onboarded"] is True and d.ev("__court.S.game.state") == "serve")
    d.pg.touchscreen.tap(195, 400)
    time.sleep(0.2)
    check("after skipping, tap still serves", d.ev("__court.S.game.state") == "play")
    check("no console errors (first-time, touch)", not d.errors, d.errors[:3])
    ctx.close()

    # Returning player whose save predates the tutorial.
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(OFFLINE + "; if(!localStorage.getItem('the-court.save')) localStorage.setItem('the-court.save', JSON.stringify({version:2,settings:{music:0.3,sfx:0.8,muted:false},progress:{unlocked:3,levels:{baseline:{best:500,stars:2}}},stats:{plays:4,wins:2,blocks:60},leaderboard:[{name:'OLD',score:900,court:2,at:1}]}))")
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.4)
    old = d.ev("[__court.save.data.onboarded, __court.save.data.progress.unlocked, __court.save.data.settings.music, __court.save.data.leaderboard[0].name]")
    check("older save: treated as returning, progress and leaderboard intact", old == [True, 3, 0.3, "OLD"], old)
    d.click("play")
    d.screen("courts", 0.5, 20000)
    check("older save: Play goes to the court grid", d.ev("__court.ui.regions.some(r=>r.id==='court2')"))
    check("no console errors (first-time, desktop)", not d.errors, d.errors[:3])
    ctx.close()


def themes(browser, url):
    """Court themes: rotation rules, all eight looks, the picker, persistence."""
    print("court themes")
    COUNTRY = ["japan", "newyork", "london", "india"]
    url += "&look=0"  # every visit turns the rotation; these checks pin it at Japan-first
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(OFFLINE + "; if(!localStorage.getItem('the-court.save')) localStorage.setItem('the-court.save', JSON.stringify({version:3,onboarded:true,progress:{unlocked:20}}))")
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.0)

    # 0. PLAY goes straight into the game: no theme screen on launch.
    d.click("play")
    time.sleep(0.1)
    check("PLAY skips the theme screen and goes straight on", d.ev("__court.S.screen") != "themes" and d.ev("__court.S.next") != "themes"
          and not d.ev("__court.ui.regions.some(r=>r.id==='continue'||r.id==='themesback')"))
    d.screen("courts", 0.5)
    d.pg.keyboard.press("Escape")
    d.screen("title", 0.5)

    # 1. The two rules, checked on their own and for all 120 courts.
    got = d.ev("Array.from({length:120},(_,i)=>{const t=__court.getCourtTheme(i+1);return [t.countryId,t.isBlackCourt]})")
    want = [[COUNTRY[((n - 1) // 2) % 4], n % 3 == 0] for n in range(1, 121)]
    check("country = floor((court-1)/2) % 4 for courts 1-120", [g[0] for g in got] == [w[0] for w in want])
    check("Black Court = every third court, for courts 1-120", [g[1] for g in got] == [w[1] for w in want])
    table = {1: ("japan", False), 2: ("japan", False), 3: ("newyork", True), 4: ("newyork", False), 5: ("london", False), 6: ("london", True),
             7: ("india", False), 8: ("india", False), 9: ("japan", True), 10: ("japan", False), 12: ("newyork", True), 30: ("london", True),
             60: ("newyork", True), 90: ("japan", True), 120: ("india", True)}
    bad = {n: v for n, v in table.items() if tuple(got[n - 1]) != v}
    check("checkpoint courts 1,2,3,4,5,6,7,8,9,10,12,30,60,90,120", not bad, bad)
    manual = d.ev("[1,3,8,9].map(n=>{const t=__court.getCourtTheme(n,'india');return [t.countryId,t.isBlackCourt]})")
    check("manual choice fixes the country but keeps every third court black", manual == [["india", False], ["india", True], ["india", False], ["india", True]], manual)
    keys = d.ev("Object.keys(__court.getCourtTheme(5)).sort().join()")
    check("getCourtTheme returns the documented fields", all(k in keys for k in ["countryId", "countryName", "isBlackCourt", "courtPalette", "backgroundPalette", "courtLineColor", "accentColor", "ambientEffects"]), keys)

    # 2. Every country, normal and black, actually drawn: the ground at the
    #    bottom of the screen is that theme's court colour.
    d.pg.evaluate(BOT)
    px = "(()=>{const c=document.getElementById('court');const g=c.getContext('2d');const s=__court.size();const d=g.getImageData(Math.round(s[0]/2)+18,s[1]-2,1,1).data;return '#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('')})()"
    for court in (1, 4, 5, 7, 9, 3, 6, 15):
        d.ev(f"__bot.mode='win'; __bot.on=true; __court.S.timeScale=1; __court.beginRun({court - 1})")
        d.wait("__court.S.screen==='play' && __court.S.game.score>=20", 60000)
        d.ev("__court.S.timeScale=0.0001")
        time.sleep(0.6)
        t = d.ev("__court.currentTheme()")
        colour = d.ev(px)
        pal = t["courtPalette"]
        name = f"{t['countryId']}{' black' if t['isBlackCourt'] else ''}"
        check(f"court {court}: {name} is drawn (ground is {colour}, a court colour)", colour.lower() in (pal["court"].lower(), pal["alt"].lower()) and [t["countryId"], t["isBlackCourt"]] == got[court - 1], (colour, pal))
        d.shot(f"theme-c{court}-{name.replace(' ', '-')}")
        want_track = "boss" if t["isBlackCourt"] else ["action1", "stage1", "action2", "stage2", "action3"][(court - 1) % 5]
        check(f"court {court}: music is {want_track}", d.ev("__court.audio.want") == want_track)
    check("ball, paddle and HUD still drawn on a Black Court", d.ev("__court.S.game.balls.length>0") and d.ev("__court.S.screen") == "play")

    # 3. Picker from the pause menu: changes the look, never the game.
    d.ev("__court.S.timeScale=1; __bot.on=false")
    d.ev("__court.beginRun(3)")  # court 4: New York, normal
    d.screen("play", 0.3, 20000)
    d.ev("__bot.mode='win'; __bot.on=true")
    d.wait("__court.S.game.score>=20", 60000)
    d.ev("__bot.on=false")
    d.pg.keyboard.press("p")
    d.screen("paused", 0.5)
    snap = "JSON.stringify([__court.S.level,__court.S.game.score,__court.S.game.lives,__court.S.game.blocks.filter(b=>b.alive).length,__court.S.game.paddle.w,__court.S.game.balls.map(b=>[b.x,b.y,b.vx,b.vy])])"
    before = d.ev(snap)
    d.click("theme")
    d.wait("__court.S.overlayT>=1")
    ids = d.ev("__court.ui.regions.map(r=>r.id).join()")
    check("pause menu has Theme: Automatic plus four country cards and Done", all(i in ids for i in ["themeauto", "theme-japan", "theme-newyork", "theme-london", "theme-india", "themedone"]), ids)
    d.shot("theme-picker-desktop")
    d.click("theme-london")
    time.sleep(0.6)
    t = d.ev("__court.currentTheme()")
    check("picking London applies it at once", t["countryId"] == "london" and t["mode"] == "manual" and d.ev("__court.save.data.settings.theme") == "london" )
    time.sleep(0.5)
    check("changing theme leaves court, score, lives, bricks, paddle and ball exactly as they were", d.ev(snap) == before)
    d.click("themedone")
    d.wait("__court.S.overlayT<=0")
    d.click("resume")
    d.screen("play", 0.3)
    check("Done and Resume return to the same court", d.ev("__court.S.level") == 3)
    # Manual stays on the next courts; black still every third.
    d.ev("__court.beginRun(5)")  # court 6
    d.screen("countdown", 0.1, 20000)
    t = d.ev("__court.currentTheme()")
    check("manual London is kept on court 6, which is still a Black Court", t["countryId"] == "london" and t["isBlackCourt"])
    d.ev("__court.beginRun(6)")  # court 7: automatic would be India
    d.screen("countdown", 0.1, 20000)
    check("manual London is not replaced when rotation reaches India", d.ev("__court.currentTheme().countryId") == "london")

    # 4. Persistence: the choice survives a reload.
    d.pg.reload()
    d.screen("title", 1.0)
    check("theme choice is saved and comes back after a refresh", d.ev("__court.save.data.settings.theme") == "london" and d.ev("__court.currentTheme().countryId") == "london")
    # Back to Automatic.
    d.ev("__court.beginRun(6)")
    d.screen("play", 0.3, 20000)
    d.pg.keyboard.press("p")
    d.screen("paused", 0.5)
    d.click("theme")
    d.wait("__court.S.overlayT>=1")
    d.click("themeauto")
    time.sleep(0.5)
    check("Automatic restores the rotation (court 7 is India)", d.ev("__court.save.data.settings.theme") == "auto" and d.ev("__court.currentTheme().countryId") == "india")
    d.pg.keyboard.press("Escape")
    d.wait("__court.S.overlayT<=0")
    check("Esc closes the picker back to the pause menu", d.ev("__court.S.screen") == "paused")
    check("no console errors (themes, desktop)", not d.errors, d.errors[:3])
    ctx.close()

    # 5. Phone: the theme screen and the picker fit and work by touch.
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.0)
    d.ev("__court.go('title')")
    d.screen("title", 0.5)
    d.ev("__court.beginRun(0)")
    d.screen("play", 0.3, 20000)
    d.tap("pause")
    d.screen("paused", 0.5)
    d.tap("theme")
    d.wait("__court.S.overlayT>=1")
    fits = d.ev("(()=>{const r=__court.ui.regions; const s=__court.size(); return r.every(q=>q.x>=0&&q.y>=0&&q.x+q.w<=s[0]&&q.y+q.h<=s[1])})()")
    d.tap("theme-india")
    time.sleep(0.5)
    check("phone: picker fits the screen and a tap picks India", fits and d.ev("__court.currentTheme().countryId") == "india")
    d.shot("theme-picker-mobile")
    check("no console errors (themes, phone)", not d.errors, d.errors[:3])
    ctx.close()


def slow_first_visit(browser, url):
    """A fresh visitor on a slow connection must not see the "could not start" message."""
    print("slow first visit")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.add_init_script(OFFLINE)

    # Hold the game script back for 3 s, like a cold cache on a slow phone.
    held = []
    ctx.route("**/js/main.js", lambda route: held.append(route))
    d = Driver(ctx.new_page())
    d.pg.goto(url, wait_until="commit")
    end = time.time() + 2.5
    while time.time() < end:
        d.pg.wait_for_timeout(100)
    check("still loading after 2.5 s, and no start-up error is shown",
          bool(held) and d.ev("!document.getElementById('court').dataset.ready && document.getElementById('fallback').hidden"))
    for r in held:
        r.continue_()
    d.pg.wait_for_function("window.__court", timeout=30000)
    d.screen("title", 0.5, 30000)
    check("the game then starts and the message stays hidden", d.ev("document.getElementById('fallback').hidden"))
    ctx.close()

    # A script that really fails to load still explains itself.
    ctx = browser.new_context()
    ctx.route("**/js/main.js", lambda route: route.abort())
    pg = ctx.new_page()
    pg.goto(url)
    pg.wait_for_function("!document.getElementById('fallback').hidden", timeout=5000)
    check("a script that fails to load still shows the help message", True)
    ctx.close()


def live_place(browser, url):
    """While playing: the run's place on the leaderboard, and a note for each name passed."""
    print("live leaderboard place")
    board = "[{name:'AANYA',score:2000,court:4,at:1},{name:'RAVI',score:400,court:2,at:2},{name:'PANDA',score:250,court:1,at:3},{name:'MIA',score:120,court:1,at:4},{name:'JO',score:60,court:1,at:5}]"
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(OFFLINE + "; localStorage.setItem('the-court.save', JSON.stringify({version:3,onboarded:true,lastName:'PANDA',leaderboard:" + board + "}))")
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.0)
    d.pg.evaluate(BOT)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.screen("countdown", 0.3)
    check("a new run starts in 6th place on a 5-name board, with no note", d.ev("__court.S.place.ahead") == 5 and d.ev("__court.S.place.t") == 0)
    d.ev("window.__msgs=[]; setInterval(()=>{const p=__court.S.place; if(p&&p.t>0&&!__msgs.includes(p.beat)) __msgs.push(p.beat)},10); __court.S.timeScale=1.5; __bot.on=true")
    d.wait("__court.S.game.score>420 || (__court.S.screen!=='play' && __court.S.screen!=='countdown')", 240000)
    d.ev("__court.S.timeScale=0.0001")
    time.sleep(0.2)
    msgs = d.ev("__msgs")
    score = d.ev("__court.S.game.score")
    check("passing names pops 'you beat' notes in order; passing your own best says so",
          score > 420 and msgs[:2] == ["YOU BEAT JO!", "YOU BEAT MIA!"] and "NEW PERSONAL BEST!" in msgs and msgs.index("NEW PERSONAL BEST!") == 2, (score, msgs))
    check("the place follows the score (2nd, behind AANYA)", d.ev("__court.S.place.ahead") == 1)
    check("no console errors (live place)", not d.errors, d.errors[:3])
    ctx.close()

    # Online: the place is taken against the shared board.
    origin = url.split("/?")[0]
    MOCK["mode"] = "ok"
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(RETURNING + f"; window.COURT_CONFIG={{supabaseUrl:'{origin}', supabaseAnonKey:'{MOCK['key']}'}}")
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.0)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.online.state==='ok' && __court.S.place")
    want = d.ev("__court.S.online.rows.filter(r=>r.score>__court.S.game.score).length")
    check("online: the place is counted against the online board", d.ev("__court.S.place.rows===__court.S.online.rows") and d.ev("__court.S.place.ahead") == want, want)
    ctx.close()


def visits_and_names(browser, url):
    """Each visit opens on another country; a name already on the online board is refused."""
    print("new theme every visit, unique names")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    looks = []
    for _ in range(6):
        d.pg.goto(url)
        d.screen("title", 0.3)
        looks.append(d.ev("[__court.S.look, __court.currentTheme().countryId]"))
    check("every reload opens on a different country than the one before", all(looks[i][1] != looks[i - 1][1] for i in range(1, len(looks))), looks)
    check("no console errors (visits)", not d.errors, d.errors[:3])
    ctx.close()

    origin = url.split("/?")[0]
    MOCK["mode"] = "ok"
    MOCK["posted"].clear()
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(RETURNING + f"; window.COURT_CONFIG={{supabaseUrl:'{origin}', supabaseAnonKey:'{MOCK['key']}'}}")
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.0)

    def to_name_screen():
        d.ev("__court.S.run={lives:0,score:420,saved:false}; __court.S.nameTitle='RALLY OVER'; __court.go('name')")
        d.screen("name", 0.5)

    to_name_screen()
    d.pg.keyboard.type("aanya")
    d.wait("__court.S.nameCheck.name==='AANYA' && __court.S.nameCheck.state!=='checking'", 5000)
    check("a name someone else has on the board is reported as taken", d.ev("__court.S.nameCheck.state") == "taken")
    d.pg.keyboard.press("Enter")
    time.sleep(0.3)
    check("...and Save refuses it: still on the name screen, nothing posted",
          d.ev("__court.S.screen") == "name" and not d.ev("__court.S.run.saved") and not MOCK["posted"])
    for _ in range(5):
        d.pg.keyboard.press("Backspace")
    d.pg.keyboard.type("zeddy")
    d.wait("__court.S.nameCheck.name==='ZEDDY' && __court.S.nameCheck.state==='free'", 5000)
    check("a new name is reported as available", True)
    d.pg.keyboard.press("Enter")
    d.screen("scores", 0.5)
    d.wait("__court.S.post.state==='sent'", 5000)
    check("...and saves and posts", [r["name"] for r in MOCK["posted"]] == ["ZEDDY"] and "ZEDDY" in d.ev("__court.save.data.names"))
    # Now ZEDDY is on the board, but it is this device's own name.
    d.ev("__court.go('title')")
    d.screen("title", 0.5)
    to_name_screen()
    check("the name screen offers the last name again", d.ev("__court.S.name") == "ZEDDY")
    d.pg.keyboard.press("Enter")
    d.screen("scores", 0.5)
    d.wait("__court.S.post.state==='sent'", 5000)
    check("this device can keep saving under its own name", [r["name"] for r in MOCK["posted"]] == ["ZEDDY", "ZEDDY"])
    # Typing straight into Save waits for the answer instead of skipping the check.
    d.ev("__court.go('title')")
    d.screen("title", 0.5)
    to_name_screen()
    for _ in range(8):
        d.pg.keyboard.press("Backspace")
    d.pg.keyboard.type("AANYA")
    d.pg.keyboard.press("Enter")
    time.sleep(0.6)
    check("pressing Save at once still checks first: AANYA (taken) is refused", d.ev("__court.S.screen") == "name" and d.ev("__court.S.nameCheck.state") == "taken")
    d.shot("name-taken")
    check("no console errors (names)", not d.errors, d.errors[:3])
    MOCK["posted"].clear()
    ctx.close()


def analytics(browser, url):
    """PostHog: off by default, the official snippet when a project key is set, and the game's events."""
    print("analytics (PostHog)")
    origin = url.split("/?")[0]
    seen = []

    def page(cfg, stub=True, block=False):
        c = browser.new_context(viewport={"width": 1280, "height": 800})
        init = RETURNING + f"; window.COURT_CONFIG=Object.assign(window.COURT_CONFIG||{{}}, {cfg})"
        if stub:  # stands in for the loaded library: records what the game sends
            init += "; window.__ph=[]; window.posthog={__SV:1, init(k,o){window.__phInit=[k,o]}, capture(e,p){window.__ph.push([e,p])}}"
        c.add_init_script(init)
        c.route("**/*posthog.com/**", lambda r: (seen.append(r.request.url), r.abort() if block else r.fulfill(status=200, content_type="text/javascript", body="")))
        dd = Driver(c.new_page())
        dd.pg.goto(url)
        dd.screen("title", 1.0)
        return c, dd

    # 1. No key (as shipped): nothing loads, nothing is sent.
    seen.clear()
    c, d = page("{posthogKey:''}", stub=False)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    time.sleep(0.5)
    check("no PostHog key: no PostHog script and no requests", d.ev("typeof window.posthog") == "undefined" and not seen, seen[:2])
    c.close()

    # 2. A personal API key is refused outright.
    seen.clear()
    c, d = page("{posthogKey:'phx_personal', posthogLocal:true}", stub=False)
    check("a personal API key (phx_) is refused: nothing loads", d.ev("typeof window.posthog") == "undefined" and not seen, seen[:2])
    c.close()

    # 3. A project key loads the official snippet from the chosen host, with the quiet settings.
    for region in ("us", "eu"):
        seen.clear()
        c, d = page(f"{{posthogKey:'phc_test', posthogHost:'https://{region}.i.posthog.com', posthogLocal:true}}", stub=False)
        d.wait("window.posthog && window.posthog._i && window.posthog._i.length > 0")
        key, opts = d.ev("[window.posthog._i[0][0], window.posthog._i[0][1]]")
        check(f"project key ({region.upper()}): official snippet loads array.js from {region}-assets.i.posthog.com",
              any(u == f"https://{region}-assets.i.posthog.com/static/array.js" for u in seen) and key == "phc_test" and opts["api_host"] == f"https://{region}.i.posthog.com", seen[:2])
        check(f"({region.upper()}) no autocapture, no session recording, no surveys, anonymous players",
              opts["autocapture"] is False and opts["disable_session_recording"] is True and opts["disable_surveys"] is True and opts["person_profiles"] == "identified_only" and opts["defaults"] == "2026-05-30", opts)
        c.close()

    # 4. Not on localhost unless asked: a real deploy's key does not count test runs.
    seen.clear()
    c, d = page("{posthogKey:'phc_test'}", stub=False)
    check("localhost sends nothing even with a key", d.ev("typeof window.posthog") == "undefined" and not seen)
    c.close()

    # 5. The events, through real play.
    MOCK["mode"] = "ok"
    MOCK["posted"].clear()
    c, d = page(f"{{posthogKey:'phc_test', posthogLocal:true, supabaseUrl:'{origin}', supabaseAnonKey:'{MOCK['key']}'}}")
    pg = d.pg
    pg.evaluate(BOT)
    d.ev("__court.S.introSeen=true; __court.S.timeScale=3; __bot.mode='win'; __bot.on=true; __court.beginRun(0)")
    d.wait("__court.S.level===1", 240000)
    d.ev("__court.S.game.applyTool('expand')")
    d.ev("__bot.mode='lose'")
    d.screen("name", 0.5, 240000)
    d.ev("__bot.on=false; __court.S.timeScale=1")
    pg.keyboard.type("tester")
    d.wait("__court.S.nameCheck.name==='TESTER' && __court.S.nameCheck.state==='free'", 5000)
    pg.keyboard.press("Enter")
    d.wait("__court.S.post.state==='sent'", 5000)
    time.sleep(0.2)
    ev = d.ev("__ph")
    names = [e[0] for e in ev]
    by = {}
    for n_, p_ in ev:
        by.setdefault(n_, []).append(p_)
    check("game_started once, at court 1", names.count("game_started") == 1 and by["game_started"][0]["court"] == 1, names[:3])
    check("court_completed for court 1 with stars and score", by.get("court_completed", [{}])[0].get("court") == 1 and by["court_completed"][0]["stars"] >= 1 and by["court_completed"][0]["score"] > 0)
    check("powerup_used names the tool", any(p_["powerup"] == "expand" for p_ in by.get("powerup_used", [])), by.get("powerup_used"))
    check("life_lost for every ball lost (3 in a run that ran out)", len(by.get("life_lost", [])) == 3 and by["life_lost"][-1]["lives_left"] == 0, by.get("life_lost"))
    check("game_over once, reason out_of_lives, on court 2", names.count("game_over") == 1 and by["game_over"][0]["reason"] == "out_of_lives" and by["game_over"][0]["court"] == 2, by.get("game_over"))
    check("leaderboard_submit_success after the real post", names.count("leaderboard_submit_success") == 1 and by["leaderboard_submit_success"][0]["score"] == MOCK["posted"][-1]["score"], names)
    check("events carry no player names", "TESTER" not in json.dumps(ev) and not any("name" in p_ for p_ in by.get("leaderboard_submit_success", [])))
    order = [n_ for n_ in names if n_ in ("game_started", "court_completed", "game_over", "leaderboard_submit_success")]
    check("in order: started, completed, over, submitted", order == ["game_started", "court_completed", "game_over", "leaderboard_submit_success"], order)

    # Quit from Pause, then a failed submission.
    d.ev("__ph.length=0; __court.go('title')")
    d.screen("title", 0.5)
    d.ev("__court.beginRun(4)")
    d.screen("play", 0.3, 20000)
    d.ev("__court.S.game.score=55")
    d.click("pause")
    d.screen("paused", 0.5)
    d.click("home")
    d.screen("name", 0.5)
    MOCK["mode"] = "postfail"
    pg.keyboard.press("Enter")
    d.wait("__court.S.post.state==='error'", 5000)
    names = d.ev("__ph.map(e=>e[0])")
    gq = d.ev("__ph.find(e=>e[0]==='game_over')")
    check("Home from Pause: game_over with reason quit", gq and gq[1]["reason"] == "quit" and gq[1]["court"] == 5, gq)
    check("a refused post: leaderboard_submit_failure with the error", "leaderboard_submit_failure" in names and d.ev("__ph.find(e=>e[0]==='leaderboard_submit_failure')[1].error") == "http-500", names)
    MOCK["mode"] = "ok"
    errs = [e for e in d.errors if "status of 500" not in e]  # the refused post above, on purpose
    check("no console errors (analytics on)", not errs, errs[:3])
    check("nothing is tracked for a run after it ended", d.ev("__ph.findIndex(e=>e[0]==='game_over')") > d.ev("__ph.map(e=>e[0]).lastIndexOf('life_lost')"), names)
    c.close()

    # 6. PostHog blocked (ad blocker, offline): the game plays on.
    seen.clear()
    c, d = page("{posthogKey:'phc_test', posthogLocal:true}", stub=False, block=True)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.screen("play", 0.3, 20000)
    d.ev("__court.S.game.applyTool('expand')")
    time.sleep(0.3)
    errs = [e for e in d.errors if "ERR_FAILED" not in e]  # the blocked PostHog script itself
    check("PostHog blocked: the game still starts and plays, no errors", d.ev("__court.S.screen") == "play" and not errs, errs[:3])
    c.close()
    MOCK["posted"].clear()


def bricks_in_groups(browser, url):
    """Classic bricks in groups (empty lanes between them), the black paddle, no characters."""
    print("bricks in groups")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    d.pg.goto(url + "&look=0")
    d.screen("title", 2.5)
    pix = """(()=>{const c=document.getElementById('court'), x=c.getContext('2d'), d=x.getImageData(0,0,c.width,c.height).data, s=new Set();
      for(let i=0;i<d.length;i+=4) s.add('#'+[d[i],d[i+1],d[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('')); return [...s]})()"""
    hexes = d.ev(pix)
    check("landing: the brick pyramid, and no characters", "#cf6f4f" in hexes and "#f2c39a" not in hexes and "#e0403a" not in hexes)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready && __court.S.t>0.3", 20000)
    d.ev("__court.S.timeScale=0.0001")
    time.sleep(0.2)
    hexes = d.ev(pix)
    check("court 1: bricks, the black paddle (as on main), no characters, no racket",
          "#cf6f4f" in hexes and "#22262d" in hexes and "#f2c39a" not in hexes and "#e3b341" not in hexes)
    d.ev("__court.S.timeScale=1")
    forms = d.ev("[...new Set(__court.LEVELS.map(l=>l.form).filter(Boolean))]")
    check("courts 6-120 are geometric formations (diamond, circle, ring, triangle...), at least 10 kinds", len(forms) >= 10, forms)
    # The stadium banner (dark board, #111a28) is on the courts only; the landing keeps its stone wall.
    # The banner's logos: the ball's #ccee33 or the burger bun's #ee9933 (whichever is showing).
    has_board = "(()=>{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for(let i=0;i<d.length;i+=4){ if((d[i]===0xcc&&d[i+1]===0xee&&d[i+2]===0x33)||(d[i]===0xee&&d[i+1]===0x99&&d[i+2]===0x33)) n++; } return n})()"
    d.ev("__court.S.timeScale=0.0001")
    time.sleep(0.15)
    on_court = d.ev(has_board)
    d.ev("__court.S.timeScale=1; __court.go('title')")
    d.screen("title", 1.0)
    on_landing = d.ev(has_board)
    check("the black banner with its logos shows on the courts; the landing keeps the plain stone wall", on_court > 10 and on_landing == 0 and not d.ev("__court.S.screen==='play'"), (on_court, on_landing))
    # The banner takes turns: THE COURT (ball) and COURT BITES (burger), one sliding out as the other comes in.
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 20000)
    d.ev("__court.S.timeScale=0.0001")
    shows = []
    for t in (600.5, 604.0):
        d.ev(f"__court.S.time={t}")
        time.sleep(0.15)
        shows.append(d.ev("""(()=>{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let ball=0, bun=0; for(let i=0;i<d.length;i+=4){ if(d[i]===0xcc&&d[i+1]===0xee&&d[i+2]===0x33) ball++; if(d[i]===0xee&&d[i+1]===0x99&&d[i+2]===0x33) bun++; } return [ball, bun]})()"""))
    d.ev("__court.S.timeScale=1")
    check("the banner alternates: THE COURT, then COURT BITES", shows[0][0] > 0 and shows[0][1] == 0 and shows[1][1] > 0 and shows[1][0] == 0, shows)
    check("no console errors (bricks)", not d.errors, d.errors[:3])
    ctx.close()


def polish(browser, url):
    """Difficulty room, power-up colours, small-phone spacing, signature, night contrast."""
    print("formation, colours, spacing, signature, night")
    # Difficulty: room in front of the racket on every court, and a gentler toughness curve.
    ctx = browser.new_context(viewport={"width": 320, "height": 568}, has_touch=True, is_mobile=True)
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    d.pg.goto(url + "&look=0")
    d.screen("title", 1.0)
    r = d.ev("""(async()=>{const {Game,PADDLE_Y}=await import('/js/game.js'); const {ROOM}=await import('/js/levels.js'); const L=__court.LEVELS;
      const room = L.map(l=>{const g=new Game(l); return PADDLE_Y - Math.max(...g.blocks.map(b=>b.y+b.d)) - (l.drift||0)});
      const hits = new Game(L[119]).blocks.reduce((s,b)=>s+b.hp,0);
      return {min: Math.min(...room), ROOM, hits}})()""")
    check("every court leaves room in front of the racket (at least ROOM units, even at full drift)", r["min"] >= r["ROOM"], r)
    check("court 120 needs fewer hits (tough blocks grow more slowly)", r["hits"] < 1700, r["hits"])
    # Power-ups are all drawn in the game's yellow.
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 20000)
    yellow = d.ev("(async()=>{const m=await import('/js/gfx.js'); return m.PAL.yellow})()")
    seen = {}
    for tool in ["smash", "freeze", "shield", "multiball", "expand", "lowgrav"]:
        d.ev(f"const g=__court.S.game; g.drops=[{{type:'{tool}', x:100, y:150, t:0}}]; __court.S.timeScale=0.00001")
        time.sleep(0.12)
        seen[tool] = d.ev(f"(()=>{{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; for(let i=0;i<d.length;i+=4) if('#'+[d[i],d[i+1],d[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('')==='{yellow}') return true; return false}})()")
        d.ev("__court.S.game.drops=[]; __court.S.timeScale=1")
    check("every power-up token is drawn in yellow", all(seen.values()), seen)
    # Small phone (canvas 240 wide): the top row and the place tag do not collide.
    lay = d.ev("""(async()=>{const {textW}=await import('/js/gfx.js'); const {hudRows}=await import('/js/render.js'); const [W]=__court.size();
      const label='COURT 120', lw=textW(label,1,2)+12, x=Math.round(Math.max(W/2-54, 5+lw+6)); return {W, gapLeft: x-(5+lw), gapRight: (W-23)-(x+108), tag: hudRows().tag}})()""")
    check("small phone: the court label, LIVES/score box and pause button keep apart", lay["W"] == 240 and lay["gapLeft"] >= 4 and lay["gapRight"] >= 4, lay)
    check("small phone: the place tag sits below the court-name row", lay["tag"] >= 44, lay)
    # Signature.
    check("the page names its author", d.ev("document.querySelector('meta[name=author]').content") == "Yashish")
    check("no console errors (polish)", not d.errors, d.errors[:3])
    ctx.close()
    # Night: slate bricks are lifted on a Black Court.
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    d.pg.goto(url + "&look=0")
    d.screen("title", 1.0)
    i = d.ev("""(()=>{for(let i=2;i<120;i+=3){const l=__court.LEVELS[i]; if(l.rows.length>=5 && l.rows.join('').includes('S')) return i} return 5})()""")
    d.ev(f"__court.beginRun({i})")
    d.wait(f"__court.S.level==={i} && __court.S.screen==='play' && __court.S.game.ready", 30000)
    d.ev("__court.S.timeScale=0.00001")
    time.sleep(0.12)
    found = d.ev("(()=>{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; for(let i=0;i<d.length;i+=4) if('#'+[d[i],d[i+1],d[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('')==='#7a828f') return true; return false})()")
    d.ev("__court.S.timeScale=1")
    check("Black Court: slate bricks are drawn in the paler night stone", d.ev("__court.currentTheme().isBlackCourt") and found, i + 1)
    check("no console errors (night)", not d.errors, d.errors[:3])
    ctx.close()


def signature(browser, url):
    """'CRAFTED BY / YASHISH' in pixel art: builds, slides up, YASHISH rises, shimmers; landing screen only."""
    print("signature")
    lit = """((x0,y0,x1,y1,col)=>{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0, mx=1e9, Mx=-1;
      for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){const i=(y*c.width+x)*4; if('#'+[d[i],d[i+1],d[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('')===col){n++; mx=Math.min(mx,x); Mx=Math.max(Mx,x);}} return {n,mx,Mx}})"""
    for name, vp in [("desktop", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844})]:
        ctx = browser.new_context(viewport=vp)
        ctx.add_init_script(RETURNING)
        d = Driver(ctx.new_page())
        looks = []
        for _ in range(4):
            d.pg.goto(url)
            d.screen("title", 0.3)
            looks.append(d.ev("__court.currentTheme().countryId"))
        check(f"{name}: every load opens on a different theme than the last", all(looks[i] != looks[i - 1] for i in range(1, 4)), looks)
        W, H = d.ev("__court.size()")
        area = f"{int(W * 0.68) if name == 'desktop' else 0},{H - 60},{W},{H}"  # on desktop, clear of the PLAY button
        # Two looks a second apart, at normal speed: the signature must not change.
        snap = lambda: {"cream": d.ev(f"{lit}({area},'#efe6c8')")["n"], "gold": d.ev(f"{lit}({area},'#f5e663')"), "white": d.ev(f"{lit}({area},'#ffffff')")["n"]}
        d.wait("__court.S.t > 1")  # the landing screen (signature included) has faded in
        first = snap()
        time.sleep(1.0)
        second = snap()
        steps = {3.4: second}
        check(f"{name}: CRAFTED BY and YASHISH are both there, in cream and gold", first["cream"] > 100 and first["gold"]["n"] > 100, first)
        whites = [first["white"], second["white"]]
        for _ in range(8):
            time.sleep(0.2)
            whites.append(snap()["white"])
        # CRAFTED BY (cream; a glint may whiten an edge pixel) stays where it is while the light runs.
        spans = []
        for _ in range(5):
            q = d.ev(f"{lit}({area},'#efe6c8')")
            spans.append((q["mx"], q["Mx"]))
            time.sleep(0.3)
        steady = max(x[0] for x in spans) - min(x[0] for x in spans) <= 2 and max(x[1] for x in spans) - min(x[1] for x in spans) <= 2
        check(f"{name}: the signature animates in place: the light and glints flash white, the letters never move", max(whites) > 0 and steady, (whites, spans))
        g = steps[3.4]["gold"]
        if name == "desktop":
            check("desktop: the signature sits bottom right", g["mx"] > W * 0.6 and g["Mx"] < W - 4, g)
        else:
            check("phone: the signature is centred at the bottom", abs((g["mx"] + g["Mx"]) / 2 - W / 2) < 8, g)
        d.ev("__court.S.timeScale=1; __court.S.introSeen=true; __court.beginRun(0)")
        d.screen("countdown", 0.4)
        d.ev("__court.S.timeScale=0.00001")
        time.sleep(0.1)
        check(f"{name}: the signature is only on the landing screen", d.ev(f"{lit}({area},'#f5e663')")["n"] < 60)
        check(f"no console errors (signature, {name})", not d.errors, d.errors[:3])
        ctx.close()


def board_and_share(browser, url):
    """Leaderboard UX (loading rows, CTA row) and score sharing: card, share sheet, fallback, events."""
    print("leaderboard UX and score sharing")
    origin = url.split("/?")[0]
    stub = ("; window.__ph=[]; window.posthog={__SV:1, init(){}, register(o){window.__phReg=o}, capture(e,p){window.__ph.push([e,p])}}"
            f"; window.COURT_CONFIG={{supabaseUrl:'{origin}', supabaseAnonKey:'{MOCK['key']}', posthogKey:'phc_test', posthogLocal:true}}")
    after_run = ("__court.S.run={lives:0,score:6100,saved:true}; __court.S.level=4; __court.S.board={rank:-1,fromRun:true};"
                 "__court.S.post={state:'sent',error:'',entry:{name:'ME',score:6100,court:5}}; __court.S.online.at=-99; __court.go('scores')")
    names = lambda d: d.ev("__ph.map(e=>e[0])")

    def open_board(native=None):
        c = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        init = RETURNING + stub
        if native == "ok":
            init += "; window.__shared=[]; navigator.canShare=()=>true; navigator.share=(d)=>{window.__shared.push(d); return new Promise(r=>setTimeout(r,300))}"
        elif native == "cancel":
            init += "; navigator.canShare=()=>true; navigator.share=()=>Promise.reject(new DOMException('cancelled','AbortError'))"
        else:
            init += "; navigator.canShare=undefined; navigator.share=undefined; window.__copied=null; Object.defineProperty(navigator,'clipboard',{value:{writeText:(t)=>{window.__copied=t; return Promise.resolve()}}})"
        c.add_init_script(init)
        d = Driver(c.new_page())
        d.pg.goto(url)
        d.screen("title", 0.5)
        return c, d

    # Loading rows while the board loads, then the board with HOME / SHARE / PLAY AGAIN.
    MOCK["posted"][:] = [{"name": "ME", "score": 6100, "court": 5}]  # the run is on the board, so it has a rank
    MOCK["mode"] = "slow"
    c, d = open_board()
    check("every event says which site sent it (deployment)", d.ev("window.__phReg && window.__phReg.deployment") == "local")
    d.ev(after_run)
    d.wait("__court.S.screen==='scores' && !__court.S.leaving && __court.S.online.state==='loading'", 10000)
    time.sleep(0.2)
    d.ev("__court.S.timeScale=0.00001")
    loading = d.ev("""(()=>{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for(let i=0;i<d.length;i+=4) if(d[i]===0x1d&&d[i+1]===0x3a&&d[i+2]===0x2a) n++; return n})()""")
    check("while the board loads it shows placeholder rows", loading > 200, loading)
    d.ev("__court.S.timeScale=1")
    MOCK["mode"] = "ok"
    d.wait("__court.S.online.state==='ok'", 10000)
    time.sleep(0.4)
    ids = d.ev("__court.ui.regions.map(r=>r.id)")
    check("after a run: HOME, SHARE and PLAY AGAIN", all(i in ids for i in ["home", "share", "again"]), ids)
    d.ev("__court.S.timeScale=0.00001")
    time.sleep(0.1)
    pix = d.ev("""(()=>{const c=document.getElementById('court'), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data, s=new Set();
      for(let i=0;i<d.length;i+=4) s.add('#'+[d[i],d[i+1],d[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('')); return s.has('#f2b632')+','+s.has('#c9d3d6')+','+s.has('#d08a4e')})()""")
    check("the podium shows gold, silver and bronze for the top three", pix == "true,true,true", pix)
    d.ev("__court.S.timeScale=1")
    d.click("friends")
    time.sleep(0.2)
    check("FRIENDS says it is coming soon and stays on the global board", d.ev("__court.S.share.note") == "FRIENDS BOARD COMING SOON" and d.ev("__court.S.screen") == "scores" and "friends_tab_clicked" in names(d))
    # Scrolling: all of the top 20 can be reached; the info box shrinks once scrolled.
    rows = d.ev("__court.S.online.rows.length")
    check("before scrolling the info box is full size", d.ev("__court.S.list.min") < 0.05 and not d.ev("__court.S.list.scrolled"))
    bx, by = d.point("boardlist")
    d.pg.mouse.move(bx, by)
    d.pg.mouse.wheel(0, 120)
    time.sleep(0.4)
    after_wheel = d.ev("__court.S.list.cur")
    for _ in range(6):
        d.pg.keyboard.press("PageDown")
    time.sleep(0.8)
    L = d.ev("(()=>{const L=__court.S.list; return {cur:L.cur, max:L.max, min:L.min, rowH:L.rowH}})()")
    check("the wheel scrolls the list", after_wheel > 0.5, after_wheel)
    check("Page Down reaches the bottom: the 20th score is in view", rows == 20 and abs(L["cur"] - L["max"]) < 0.05 and L["max"] > 0, L)
    check("once scrolled, the info box shrinks to one line", L["min"] > 0.95 and names(d).count("leaderboard_scrolled") == 1, L)
    for _ in range(6):
        d.pg.keyboard.press("PageUp")
    time.sleep(0.8)
    check("Page Up returns to the top", d.ev("__court.S.list.cur") < 0.05)
    d.ev("__court.S.timeScale=1")
    check("leaderboard_viewed and share_cta_viewed fire once each, however many frames are drawn",
          names(d).count("leaderboard_viewed") == 1 and names(d).count("share_cta_viewed") == 1 and d.ev("__ph.find(e=>e[0]==='leaderboard_viewed')[1].source") == "run", names(d))
    x, y = d.point("share")
    d.pg.mouse.move(x, y)
    time.sleep(0.1)
    check("desktop: the pointer turns into a hand over a button", d.ev("document.getElementById('court').style.cursor") == "pointer")
    # No share sheet (desktop): the card downloads and the link is copied.
    with d.pg.expect_download() as dl:
        d.click("share")
    f = dl.value
    path = f.path()
    head = open(path, "rb").read(24)
    w_, h_ = int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
    check("SHARE without a share sheet downloads a 1080x1350 PNG score card", f.suggested_filename == "the-court-6100.png" and head[:8] == b"\x89PNG\r\n\x1a\n" and (w_, h_) == (1080, 1350), (f.suggested_filename, w_, h_))
    d.wait("window.__copied", 5000)
    copied = d.ev("window.__copied")
    check("...and copies a message with the score, court, its rank and a tagged link to this site",
          "6100" in copied and "Court 5" in copied and "on the leaderboard" in copied and origin in copied and "utm_source=score_share" in copied, copied)
    ev = d.ev("__ph")
    by = {e[0]: e[1] for e in ev}
    check("events: share_cta_clicked, then share_card_saved (link copied); no share_completed",
          "share_cta_clicked" in by and by.get("share_card_saved", {}).get("link_copied") is True and "share_completed" not in by and by["share_cta_clicked"]["ranked"] is True, [e[0] for e in ev])
    check("no player names in the share events", "ME" not in json.dumps([e for e in ev if e[0].startswith("share")]))
    check("a note says what happened", d.ev("__court.S.share.note") == "CARD SAVED, LINK COPIED")
    check("no console errors (share fallback)", not d.errors, d.errors[:3])
    c.close()

    # A share sheet that completes: one click, opened then completed, with the image.
    c, d = open_board("ok")
    d.ev(after_run)
    d.wait("__court.S.screen==='scores' && !__court.S.leaving && __court.S.online.state==='ok'", 10000)
    time.sleep(0.4)
    d.click("share")
    d.click("share")  # a second tap while the first is still sharing
    d.wait("__court.S.share.note==='SHARED!'", 5000)
    n = names(d)
    shared = d.ev("window.__shared.map(x=>[x.files[0].type, x.files[0].name, x.text])")
    check("share sheet: opened with the card image, then completed", n.index("share_sheet_opened") < n.index("share_completed") and shared[0][0] == "image/png", n)
    check("a second tap while sharing does not share twice", n.count("share_cta_clicked") == 1 and len(shared) == 1, n)
    c.close()

    # A share sheet the player closes: cancelled, not completed, nothing downloaded.
    c, d = open_board("cancel")
    d.ev(after_run)
    d.wait("__court.S.screen==='scores' && !__court.S.leaving && __court.S.online.state==='ok'", 10000)
    time.sleep(0.4)
    d.click("share")
    d.wait("!__court.S.share.busy", 5000)
    n = names(d)
    check("closing the share sheet counts as cancelled, not as a share", "share_cancelled" in n and "share_completed" not in n and "share_card_saved" not in n, n)
    c.close()
    MOCK["posted"].clear()


def finale(browser, url):
    """Power Rush in the last quarter of a court, and the finish: slow motion, flash, fireworks, COURT CLEAR!"""
    print("power rush and the finish")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(RETURNING)
    d = Driver(ctx.new_page())
    d.pg.goto(url + "&look=0")
    d.screen("title", 1.0)
    r = d.ev("""(async()=>{const {Game, RUSH_AT, MAX_DROPS}=await import('/js/game.js'); const L=__court.LEVELS;
      const g=new Game(L[10], ()=>{}, ()=>0.5); const ev=[]; g.emit=(e)=>ev.push(e);
      g.state='play'; let broke=0, drops=0;
      for (const b of g.blocks) { if (g.remaining<=1) break; b.hp=1; g.hit ? 0 : 0; g.breakBlock ? g.breakBlock(b) : null; }
      return {RUSH_AT, MAX_DROPS, hasBreak: typeof g.breakBlock}})()""")
    check("game rules export RUSH_AT (25%)", r["RUSH_AT"] == 0.25, r)
    d.ev("__court.S.introSeen=true; __court.beginRun(10)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 30000)
    time.sleep(0.2)
    check("a court's music starts mellow", d.ev("__court.audio.build") < 0.3, d.ev("__court.audio.build"))
    d.ev("""(()=>{const g=__court.S.game; const keep=Math.floor(g.total*0.25)+1; let n=g.remaining; for(const b of g.blocks){ if(n<=keep) break; b.alive=false; n--; } g.remaining=n; g.state='play';
       const b=g.blocks.find(q=>q.alive); g.balls[0].stuck=false; Object.assign(g.balls[0],{x:b.x+b.w/2,y:b.y+b.d+8,vx:0,vy:-1});})()""")
    d.wait("__court.S.game.rush", 10000)
    time.sleep(0.2)
    check("by the Power Rush the court's music is at full power (heavy bass)", d.ev("__court.audio.build") == 1, d.ev("__court.audio.build"))
    check("with a quarter of the court left, Power Rush starts and its banner shows", d.ev("__court.S.game.rush && __court.S.time-__court.S.rushAt < 2"))
    # In the rush most breaks drop a tool: count drops over many breaks on a fresh court in rush.
    rate = d.ev("""(async()=>{const {Game}=await import('/js/game.js'); let made=0, tries=0; for (let k=0;k<40;k++){ const g=new Game(__court.LEVELS[30], ()=>{}, Math.random); g.rush=true; g.drops=[]; g.sinceDrop=0; const b=g.blocks[0]; g.maybeDrop(b); if (g.drops.length) made++; tries++; } return made/tries})()""")
    check("in a Power Rush most breaks drop a tool (about 65%)", rate > 0.45, rate)
    rain = d.ev("""(async()=>{const {Game}=await import('/js/game.js'); const g=new Game(__court.LEVELS[30], ()=>{}, Math.random); g.state='play'; g.rush=true; let made=0; for (let i=0;i<600;i++){ const n=g.drops.length; g.updateDrops(1/60); if (g.drops.length>n) made++; } return made})()""")
    check("in a Power Rush tools also fall from the far end on their own (about every 2 s)", 3 <= rain <= 9, rain)
    d.ev("(()=>{const g=__court.S.game; const live=g.blocks.filter(q=>q.alive); live.slice(1).forEach(q=>q.alive=false); g.remaining=1; const b=live[0]; g.balls=[g.balls[0]]; g.drops=[]; Object.assign(g.balls[0],{stuck:false,x:b.x+b.w/2,y:b.y+b.d+6,vx:0,vy:-1}); b.hp=1;})()")
    d.wait("__court.S.cheer && __court.S.time-__court.S.cheer.at>0.5", 10000)
    check("the last brick sets off the finish (fireworks and COURT CLEAR!)", d.ev("__court.S.game.state==='won'"))
    check("the crowd behind the court cheers at the finish", d.ev("__court.S.crowd && __court.S.crowd.big===3"))
    # Big moments in play: a combo of five, or three bricks inside half a second.
    d.ev("__court.S.introSeen=true; __court.beginRun(12)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 30000)
    d.ev("__court.S.crowd=null; __court.S.game.emit('break', 5)")
    check("a five-brick combo makes the crowd cheer", d.ev("__court.S.crowd && __court.S.crowd.big===1"))
    time.sleep(0.1)
    check("the cheering crowd shows on the court (hype > 0)", d.ev("__court.P.hype") > 0, d.ev("__court.P.hype"))
    d.ev("__court.S.crowd=null; __court.S.breaks=[]; ['break','break','break'].forEach(e=>__court.S.game.emit(e, 1))")
    check("three bricks at once make the crowd cheer", d.ev("!!__court.S.crowd"))
    d.ev("__court.S.crowd=null; __court.S.breaks=[]; __court.S.game.emit('break', 2)")
    check("an ordinary break leaves the crowd calm", d.ev("__court.S.crowd===null"))
    d.ev("__court.S.crowd=null; __court.S.breaks=[]; __court.S.game.emit('break', 3)")
    check("a three-brick run gets a round of applause", d.ev("__court.S.crowd && __court.S.crowd.kind==='clap'"))
    time.sleep(0.1)
    check("the fans clap", d.ev("__court.P.clap") > 0)
    d.ev("__court.S.crowd=null; __court.S.game.emit('lost')")
    check("losing a ball makes the crowd groan", d.ev("__court.S.crowd && __court.S.crowd.kind==='groan'"))
    d.ev("__court.S.crowd={at:__court.S.time,big:2,kind:'cheer'}; __court.S.game.emit('lost')")
    check("a groan never cuts a cheer short", d.ev("__court.S.crowd.kind==='cheer'"))
    check("the crowd is listening during play", d.ev("__court.audio.crowdOn") is True)
    d.ev("__court.S.pops=[]; __court.S.game.emit('hit', 'S', {x: 20, y: 40, hp: 2})")
    time.sleep(0.05)
    check("every brick hit gets a reaction from the fans nearby", len(d.ev("__court.P.pops")) == 1 and d.ev("__court.P.pops[0].x") == 20)
    d.ev("__court.S.wave=null; __court.S.game.emit('break', 8, {type: 'T', x: 100, y: 60})")
    check("a combo of eight starts a Mexican wave", d.ev("!!__court.S.wave"))
    time.sleep(1.2)
    w = d.ev("__court.P.wave")
    check("the wave travels round the stands", 0 < w < 1, w)
    d.ev("__court.S.wave={at: __court.S.time - 40}; __court.S.playSince = __court.S.time - 40; __court.S.game.state='play'")
    time.sleep(0.2)
    check("a quiet stretch of play starts a wave of its own", d.ev("__court.S.time - __court.S.wave.at") < 1)
    tracks = d.ev("(async()=>{const {TRACKS}=await import('/js/audio.js'); const out={}; for (const k in TRACKS) out[k]=(await fetch(TRACKS[k])).status; return out})()")
    check("all seven music tracks are there", len(tracks) == 7 and all(v == 200 for v in tracks.values()), tracks)
    check("no console errors (finale)", not d.errors, d.errors[:3])
    ctx.close()


def sounds_and_haptics(browser, url):
    """Every element has its own sound (all play without errors) and its own vibration."""
    print("sounds and haptics")
    b = browser.browser_type.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.add_init_script(RETURNING + "; window.__vib=[]; navigator.vibrate=(p)=>{window.__vib.push(p);return true}")
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 1.0)
    d.ev("__court.audio.unlock()")
    d.wait("__court.audio.ac.state==='running'", 5000)
    calls = [["click"], ["confirm"], ["back"], ["key", "A"], ["tab"], ["toggle", True], ["beat"], ["paddle", -0.9, {"x": 10, "speed": 1.3}],
             ["wall", "side", {"x": 0}], ["wall", "back", {"x": 100}], ["hit", "S", {"x": 50}], ["hit", "H", {"x": 150}],
             ["break", 1, {"type": "T"}], ["break", 4, {"type": "L"}], ["break", 7, {"type": "H"}], ["break", 12, {"type": "S", "x": 190}],
             ["land", "S"], ["drop", "freeze", {"x": 30}], ["shield"], ["serve"], ["rush"], ["lost"], ["count"], ["go"], ["win"],
             ["cheer", 2], ["clap"], ["groan"], ["ooh", 1, {"x": 20}], ["wave", 3.6], ["over"]] + [["power", t] for t in ["shield", "multiball", "smash", "freeze", "expand", "lowgrav"]]
    bad = d.pg.evaluate("(calls)=>{const bad=[]; for (const c of calls){ try{ __court.audio.sfx(...c) }catch(e){ bad.push(c[0]+': '+e.message) } } return bad}", calls)
    check("every element's sound plays without an error (%d sounds, the arcade crowd included)" % len(calls), not bad, bad)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 30000)
    got = {}
    for ev in [["paddle", 0.9, {"x": 100}], ["break", 1, {"type": "S"}], ["break", 1, {"type": "T"}], ["power", "smash"], ["lost"]]:
        time.sleep(0.08)
        d.pg.evaluate("(e)=>{window.__vib=[]; __court.S.game.emit(...e)}", ev)
        extra = ev[2].get("type", "") if len(ev) > 2 else ""
        got[ev[0] + str(ev[1] if len(ev) > 1 else "") + extra] = d.ev("window.__vib.at(-1)")
    check("each event buzzes in its own pattern", len({json.dumps(v) for v in got.values()}) == len(got) and all(got.values()), got)
    d.ev("__court.setSetting('haptics', false)")
    d.pg.evaluate("()=>{window.__vib=[]; __court.S.game.emit('lost')}")
    check("vibration can be switched off", d.ev("window.__vib.length") == 0, d.ev("window.__vib"))
    check("no console errors (sounds and haptics)", not d.errors, d.errors[:3])
    ctx.close()
    b.close()


# A multiplayer match against a stand-in Supabase client in the page: nothing
# goes over the network. window.__answers holds what the next mp_checkpoint
# calls get ('ok', 'network' or a refusal such as 'too_fast'); __delay holds
# how long the next one takes (ms); __rpc records every mp_checkpoint call.
STAND_IN = """;
  window.COURT_CONFIG = {...window.COURT_CONFIG, supabaseUrl: 'https://stand-in.invalid', supabaseAnonKey: 'stand-in', multiplayer: true};
  window.__rpc = []; window.__answers = []; window.__delay = []; window.__finished = false; window.__state = null; window.__stateFail = 0;
  const state = (a) => ({ server_now: Date.now(), match: { id: 't', status: 'active' }, me: { finished: window.__finished, score: a.p_score, court: a.p_court, lives: a.p_lives, seq: a.p_seq }, opponent: null });
  window.supabase = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: {} } }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    rpc: async (fn, a) => {
      if (fn === 'mp_leaderboard' || fn === 'mp_history') return { data: [] }; // empty boards
      if (fn !== 'mp_checkpoint') {
        // A status read: window.__state() may shape it; __stateFail fails that many (no network).
        if (window.__stateFail > 0) { window.__stateFail--; throw new Error('offline'); }
        const base = { server_now: Date.now(), match: { id: 't', status: 'active' }, me: { finished: window.__finished }, opponent: null };
        return { data: window.__state ? window.__state(base) : base };
      }
      window.__rpc.push({ t: performance.now(), seq: a.p_seq, score: a.p_score, lives: a.p_lives, broken: a.p_broken, done: a.p_done, court: a.p_court });
      const say = window.__answers.shift() || 'ok';
      const wait = window.__delay.shift() || 0;
      if (wait) await new Promise((ok) => setTimeout(ok, wait));
      if (say === 'network') throw new Error('offline');
      if (say !== 'ok') return { error: { message: 'mp:' + say } };
      if (a.p_done) window.__finished = true; // the stand-in server: a done checkpoint finishes the run
      return { data: window.__state ? window.__state(state(a)) : state(a) };
    } }) };
"""


def stand_in_match(browser, url):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(RETURNING + STAND_IN)
    # The solo board reads the same (stand-in) address: answer it here, empty.
    ctx.route("https://stand-in.invalid/**", lambda r: r.fulfill(status=200, body="[]", content_type="application/json"))
    d = Driver(ctx.new_page())
    d.pg.goto(url)
    d.screen("title", 2.5)
    return ctx, d


def checkpoint_retry(browser, url):
    """Multiplayer checkpoints after a refusal: a wait (1.5 s, then 3 s...), no spam, nothing lost.
    A stand-in Supabase client in the page answers; nothing goes over the network."""
    print("multiplayer checkpoint retry")
    ctx, d = stand_in_match(browser, url)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 20000)
    d.ev("__court.S.timeScale=0.0001")  # the court holds still; the network side runs on the real clock
    # A match in play: the last accepted checkpoint had 3 lives, the game now has 2 (urgent: sent at once).
    d.ev("""(async()=>{ const {mp:M} = await import('/js/multiplayer.js');
      window.__answers = ['too_fast', 'network', 'too_fast'];
      __court.S.game.lives = 2;
      Object.assign(M, { matchId: 't', game: true, seq: 5, sending: false, retryAt: 0, retryMs: 0, lastSentAt: 0,
        sent: { score: 0, court: 1, lives: 3, broken: '' },
        state: { match: { id: 't', status: 'active' }, me: { finished: false }, opponent: null } }); })()""")
    time.sleep(2.0)
    d.ev("__court.S.game.score += 50")  # progress made while waiting to retry
    time.sleep(10.0)
    calls = d.ev("window.__rpc")
    m = d.ev("(async()=>{ const {mp:M} = await import('/js/multiplayer.js'); return { seq: M.seq, sent: M.sent, retryMs: M.retryMs, game: __court.S.game.score }; })()")
    gaps = [round((b["t"] - a["t"]) / 1000, 2) for a, b in zip(calls, calls[1:4])]
    check("retry: after a refusal it waits 1.5 s, then 3 s, then 6 s (an urgent update would otherwise go every frame)",
          len(gaps) == 3 and 1.4 <= gaps[0] <= 2.0 and 2.9 <= gaps[1] <= 3.5 and 5.9 <= gaps[2] <= 6.6, gaps)
    check("retry: no spam, 4 tries in 12 s (3 refused or failed, then accepted)", len(calls) == 4, len(calls))
    check("retry: a refused update is not counted as sent (same sequence number until accepted)",
          [c["seq"] for c in calls] == [6, 6, 6, 6] and m["seq"] == 6, [c["seq"] for c in calls])
    check("retry: nothing lost, the accepted update carries everything since (the lost life and the 50 points)",
          calls[-1]["lives"] == 2 and calls[-1]["score"] == calls[0]["score"] + 50 and m["sent"]["score"] == calls[-1]["score"], (calls[0]["score"], calls[-1]["score"], m["sent"]))
    check("retry: once accepted, the wait resets", m["retryMs"] == 0)
    check("no console errors (checkpoint retry)", not d.errors, d.errors[:3])
    ctx.close()


def final_update(browser, url):
    """M2: the run's last checkpoint (done) is retried with done after a refusal,
    and never sent over one already on its way (the two would share a number)."""
    print("multiplayer final update")
    count_bits = "((b)=>[...atob(b)].reduce((n,c)=>{let v=c.charCodeAt(0);while(v){n+=v&1;v>>=1}return n},0))"
    setup = """(async()=>{ const {mp:M} = await import('/js/multiplayer.js');
      Object.assign(M, { matchId: 't', game: true, seq: 5, sending: false, retryAt: 0, retryMs: 0, lastSentAt: 0, ended: null,
        sent: { score: -1, court: 1, lives: 3, broken: '' },
        state: { match: { id: 't', status: 'active' }, me: { finished: false }, opponent: null } }); })()"""
    # The court cleared: every brick down and the game won, as Game.win() leaves it.
    clear = "(()=>{ const g=__court.S.game; g.blocks.forEach(b=>b.alive=false); g.remaining=0; g.state='won'; return g.blocks.length })()"
    end = "(async()=>{ const m = await import('/js/multiplayer.js'); m.onRunEnd(true); })()"

    # 1. The final checkpoint is refused: the retry still says done, with every brick.
    ctx, d = stand_in_match(browser, url)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 20000)
    d.ev("__court.S.timeScale=0.0001")
    d.ev(setup)
    d.wait("window.__rpc.length >= 1", 5000)  # a regular checkpoint, accepted
    time.sleep(0.3)
    n = d.ev(clear)
    d.ev("window.__rpc = []; window.__answers = ['too_fast']")
    d.ev(end)
    time.sleep(4.0)
    calls = d.ev("window.__rpc")
    bits = [d.ev(f"{count_bits}({json.dumps(c['broken'])})") for c in calls]
    check("M2: the final checkpoint goes out at once, marked done, with every brick broken",
          len(calls) >= 1 and calls[0]["done"] is True and bits[0] == n, (len(calls), calls[:1], bits[:1], n))
    check("M2: refused, it is retried after the wait, still marked done (it used to go out without done)",
          len(calls) == 2 and calls[1]["done"] is True and bits[1] == n and 1.4 <= (calls[1]["t"] - calls[0]["t"]) / 1000 <= 2.0,
          [(c["done"], round(c["t"])) for c in calls])
    check("M2: once accepted the player is finished and nothing more is sent",
          d.ev("(async()=>{ const {mp:M} = await import('/js/multiplayer.js'); return M.state.me.finished === true && M.retryMs === 0; })()") and len(calls) == 2)
    check("M2: the same number until accepted (a refusal is not counted)", [c["seq"] for c in calls] == [calls[0]["seq"]] * 2, [c["seq"] for c in calls])
    check("no console errors (final update, refused)", not d.errors, d.errors[:3])
    ctx.close()

    # 2. The run ends while a regular checkpoint is still on its way.
    ctx, d = stand_in_match(browser, url)
    d.ev("__court.S.introSeen=true; __court.beginRun(0)")
    d.wait("__court.S.screen==='play' && __court.S.game.ready", 20000)
    d.ev("__court.S.timeScale=0.0001")
    d.ev("window.__delay = [1200]")  # the first (regular) checkpoint takes 1.2 s
    d.ev(setup)
    d.wait("window.__rpc.length === 1", 5000)
    n = d.ev(clear)
    d.ev(end)
    sent_at_once = d.ev("window.__rpc.length")
    time.sleep(3.0)
    calls = d.ev("window.__rpc")
    check("M2 race: the final checkpoint waits for the one on its way (not sent over it)", sent_at_once == 1, sent_at_once)
    check("M2 race: then it goes out with the next number, marked done, every brick broken",
          len(calls) == 2 and calls[1]["seq"] == calls[0]["seq"] + 1 and calls[1]["done"] is True and d.ev(f"{count_bits}({json.dumps(calls[1]['broken'])})") == n,
          [(c["seq"], c["done"]) for c in calls])
    check("M2 race: the player ends finished", d.ev("(async()=>{ const {mp:M} = await import('/js/multiplayer.js'); return M.state.me.finished === true; })()"))
    check("no console errors (final update, race)", not d.errors, d.errors[:3])
    ctx.close()


def match_time(browser, url):
    """M-a: the match clock and the grace on screen, time's up mid-game, a reload, a reconnect."""
    print("multiplayer match time")
    M = "window.__mp"  # the multiplayer state, exposed by ?debug

    def waited(d, expr, ms):
        # True once expr holds (a plain expression: a promise would count as true at once).
        try:
            d.wait(expr, ms)
            return True
        except Exception:
            return False
    setup = """(async()=>{ const {mp:M} = await import('/js/multiplayer.js');
      Object.assign(M, { matchId: 't', role: 'host', game: true, seq: 5, sending: false, retryAt: 0, retryMs: 0, lastSentAt: 0, ended: null, pollAt: 0,
        sent: { score: 0, court: 1, lives: 3, broken: '' },
        state: { match: { id: 't', status: 'active' }, me: { finished: false }, opponent: null } }); })()"""

    def in_play(d):
        d.ev("__court.S.introSeen=true; __court.beginRun(0)")
        d.wait("__court.S.screen==='play' && __court.S.game.ready", 20000)
        d.ev("__court.S.timeScale=0.0001; __court.S.mpGame = true")  # a match game: the opponent box is drawn
        d.ev(setup)

    # 1. The grace: the opponent is done, this player has 2:50 left: the clock shows in play.
    ctx, d = stand_in_match(browser, url)
    in_play(d)
    d.ev("""void (window.__state = (b) => ({ ...b, match: { ...b.match, ends_at: Date.now() + 170000, time_ends_at: Date.now() + 20 * 60000 },
             me: { finished: false }, opponent: { name: 'ANA', finished: true, connection: 'online', court: 3, score: 900, lives: 0 } }))""")
    ok = waited(d, f"/^FINISH IN 2:[45]\\d$/.test({M}.shown.clock)", 6000)
    check("M-a: once the opponent is done the grace clock shows in play (FINISH IN 2:5x)", ok, d.ev(f"{M}.shown.clock"))
    # 2. No grace, 4 minutes of match left: the match clock shows; with 20 minutes left it does not.
    d.ev("""void (window.__state = (b) => ({ ...b, match: { ...b.match, ends_at: Date.now() + 240000, time_ends_at: Date.now() + 240000 },
             me: { finished: false }, opponent: { name: 'ANA', finished: false, connection: 'online', court: 3, score: 900, lives: 2 } }))""")
    ok = waited(d, f"/^TIME [34]:\\d\\d$/.test({M}.shown.clock)", 6000)
    check("M-a: in the last 5 minutes of the match the clock shows (TIME 4:00)", ok, d.ev(f"{M}.shown.clock"))
    d.ev("""void (window.__state = (b) => ({ ...b, match: { ...b.match, ends_at: Date.now() + 20 * 60000, time_ends_at: Date.now() + 20 * 60000 },
             me: { finished: false }, opponent: { name: 'ANA', finished: false, connection: 'online', court: 3, score: 900, lives: 2 } }))""")
    ok = waited(d, f"{M}.shown.clock === ''", 6000)
    check("M-a: with plenty of time left there is no clock", ok, d.ev(f"{M}.shown.clock"))
    # 3. Time's up mid-game: the server ends this player's game; the game stops sending.
    d.ev("__court.S.timeScale=1")  # screens change on game time
    d.ev("""void (window.__state = (b) => ({ ...b, match: { ...b.match, ends_at: Date.now() - 1000, time_ends_at: Date.now() - 1000 },
             me: { finished: true, finish_reason: 'time_up', final_score: 0, score: 0 }, opponent: { name: 'ANA', finished: true, connection: 'online', court: 3, score: 900, lives: 2 } }))""")
    d.wait("__court.S.screen === 'mpwait'", 6000)
    note = d.ev(f"(async()=>{M}.note)()")
    n0 = d.ev("window.__rpc.length")
    d.ev("__court.S.game.lives = 1")  # would be urgent if the game still reported
    time.sleep(2.5)
    check("M-a: time's up mid-game: on to the waiting screen with TIME'S UP", note == "TIME'S UP", note)
    check("M-a: …and nothing more is sent for that game", d.ev("window.__rpc.length") == n0, (n0, d.ev("window.__rpc.length")))
    # 4. The waiting screen shows how long the opponent has.
    d.ev("""void (window.__state = (b) => ({ ...b, match: { ...b.match, ends_at: Date.now() + 150000, time_ends_at: Date.now() + 20 * 60000 },
             me: { finished: true, finish_reason: 'out_of_lives', final_score: 300, score: 300 }, opponent: { name: 'ANA', finished: false, connection: 'online', court: 3, score: 900, lives: 2 } }))""")
    ok = waited(d, f"/^ANA HAS 2:[23]\\d TO FINISH$/.test({M}.shown.wait)", 6000)
    check("M-a: the waiting screen says how long the opponent has (ANA HAS 2:30 TO FINISH)", ok, d.ev(f"{M}.shown.wait"))
    check("no console errors (match time)", not d.errors, d.errors[:3])
    ctx.close()

    # 5. Reconnect: the network drops for a few seconds mid-game, then comes back; nothing is lost.
    ctx, d = stand_in_match(browser, url)
    in_play(d)
    d.ev("window.__stateFail = 2; window.__answers = ['network']; __court.S.game.lives = 2")
    ok = waited(d, f"{M}.offline === true", 6000)
    check("M-a reconnect: a dropped connection shows (RECONNECTING...)", ok)
    d.ev("__court.S.game.score += 50")
    waited(d, f"{M}.offline === false && {M}.sent && {M}.sent.lives === 2 && {M}.sent.score === 50", 15000)
    got = d.ev(f"(async()=>{{ const m = {M}; return [__court.S.screen, m.offline, m.sent.lives, m.sent.score, m.reconnects]; }})()")
    check("M-a reconnect: back online, the game carries on and its checkpoint (lost life, +50) is accepted",
          got[0] == "play" and got[1] is False and got[2] == 2 and got[3] == 50, got)
    check("no console errors (reconnect)", not d.errors, d.errors[:3])
    ctx.close()

    # 6. Refresh mid-match: the page reloads and the game comes back from the server's verified state.
    for finished in (False, True):
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        me = ("{ finished: true, finish_reason: 'time_up', final_score: 120, score: 120, court: 2, lives: 2, broken: '', seq: 4 }" if finished
              else "{ finished: false, score: 120, court: 2, lives: 2, broken: '', seq: 4 }")
        ctx.add_init_script(RETURNING + STAND_IN + f"""
          localStorage.setItem('the-court.mp', JSON.stringify({{ id: 't', role: 'guest' }}));
          window.__state = (b) => ({{ ...b, match: {{ ...b.match, start_at: Date.now() - 60000, ends_at: Date.now() + 25 * 60000, time_ends_at: Date.now() + 25 * 60000 }},
            me: {me}, opponent: {{ name: 'ANA', finished: false, connection: 'online', court: 3, score: 900, lives: 2 }} }});""")
        ctx.route("https://stand-in.invalid/**", lambda r: r.fulfill(status=200, body="[]", content_type="application/json"))
        d = Driver(ctx.new_page())
        d.pg.goto(url)
        if finished:
            d.wait("__court.S.screen === 'mpwait'", 10000)
            check("M-a refresh: reloading after time's up lands on the waiting screen, not a new game", d.ev("__court.S.screen") == "mpwait")
        else:
            d.wait("__court.S.mpGame && ['countdown','play'].includes(__court.S.screen)", 10000)
            got = d.ev(f"(async()=>({{ court: __court.S.level + 1, score: __court.S.game.score, lives: __court.S.game.lives, seq: {M}.seq }}))()")
            check("M-a refresh: reloading mid-match resumes the verified game (court 2, 120 points, 2 lives)",
                  got == {"court": 2, "score": 120, "lives": 2, "seq": 4}, got)
        check("no console errors (refresh)", not d.errors, d.errors[:3])
        ctx.close()


def invite_and_boards(browser, url):
    """The challenge image is made and sent by Share and WhatsApp; The Rally's
    FRIENDS tab is the multiplayer board; realtime only re-reads on real changes."""
    print("multiplayer invite image and boards")
    M = "window.__mp"
    ctx, d = stand_in_match(browser, url)
    # The Rally's leaderboard: GLOBAL is its own board; FRIENDS opens multiplayer's, and BACK returns.
    d.ev("__court.S.board = { rank: -1, fromRun: false }; __court.go('scores')")
    d.screen("scores", 0.6)
    d.click("friends")
    d.screen("mpboard", 0.4)
    check("leaderboard: the FRIENDS tab opens the multiplayer friends board", d.ev("__court.S.screen") == "mpboard")
    d.click("back")
    d.screen("scores", 0.4)
    check("…and BACK returns to The Rally's leaderboard", d.ev("__court.S.screen") == "scores")
    # The invite screen with a match link: the image is made and shown.
    d.ev(f"""Object.assign({M}, {{ matchId: 't', role: 'host', name: 'YASH', inviteUrl: 'https://example.test/game-3/?join=abc123', token: 'abc', polling: true, pollAt: Date.now() + 1e9,
        state: {{ match: {{ id: 't', status: 'waiting', expires_at: Date.now() + 3500000 }}, me: {{ name: 'YASH', role: 'host', finished: false }}, opponent: null }} }}); __court.go('mpinvite')""")
    d.screen("mpinvite", 0.6)
    card = d.ev(f"(()=>{{ const c = {M}.invite && {M}.invite.canvas; return c ? [c.width, c.height, {M}.invite.file.name, {M}.invite.file.size] : null; }})()")
    check("invite: the challenge image is made (1080 x 1350 PNG) and previewed", card and card[0] == 1080 and card[1] == 1350 and card[2] == "the-court-challenge.png" and card[3] > 5000, card)
    # A phone (can share files): WhatsApp and Share both send the image with the message and link.
    d.ev("""window.__shared = []; navigator.canShare = (o) => !!(o && o.files); navigator.share = (o) => { window.__shared.push({ files: (o.files || []).map(f => f.name), text: o.text || '', url: o.url || '' }); return Promise.resolve(); }; 0""")
    d.click("mpwhatsapp")
    d.click("mpshare")
    shared = d.ev("window.__shared")
    check("invite (phone): WHATSAPP and SHARE send the image with the message and link",
          len(shared) == 2 and all(s["files"] == ["the-court-challenge.png"] and "YASH" in s["text"] and "join=abc123" in s["text"] for s in shared), shared)
    # A laptop (cannot share files): WhatsApp opens with the message and the image is saved to attach.
    d.ev("""navigator.canShare = () => false; window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; 0""")
    with d.pg.expect_download() as dl:
        d.click("mpwhatsapp")
    opened = d.ev("window.__opened")
    check("invite (laptop): WHATSAPP opens WhatsApp with the message and link, and saves the image",
          len(opened) == 1 and opened[0].startswith("https://wa.me/?text=") and "join%3Dabc123" in opened[0] and dl.value.suggested_filename == "the-court-challenge.png", (opened, dl.value.suggested_filename))
    # Realtime: a player's own heartbeat or an unchanged opponent does not trigger another read.
    w = d.ev("""(async()=>{ const m = await import('/js/multiplayer.js'); const M = m.mp;
        M.state = { match: { id: 't', status: 'active' }, me: { id: 'p1', finished: false }, opponent: { id: 'p2', score: 30, court: 1, lives: 3, finished: false, ready: true, connection: 'online', rematch: false, declined: false } };
        const row = (o) => ({ table: 'multiplayer_players', new: { id: 'p2', score: 30, court: 1, lives: 3, finished_at: null, ready_at: 'x', connection_status: 'online', rematch_requested_at: null, rematch_declined_at: null, ...o } });
        return [m._worthReading({ table: 'multiplayer_players', new: { id: 'p1', score: 0 } }), m._worthReading(row({})), m._worthReading(row({ score: 60 })),
                m._worthReading(row({ lives: 2 })), m._worthReading({ table: 'multiplayer_matches', new: { id: 't' } })]; })()""")
    check("realtime: our own row and an opponent's bare heartbeat do not trigger a read; a score, a life or the match does",
          w == [False, False, True, True, True], w)
    check("no console errors (invite image and boards)", not d.errors, d.errors[:3])
    ctx.close()


def main():
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/?debug=1"
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            sounds_and_haptics(browser, url)
            slow_first_visit(browser, url)
            first_time(browser, url)
            desktop(browser, url)
            touch_device(browser, url, "tablet", 820, 1180)
            touch_device(browser, url, "mobile", 390, 844)
            online_board(browser, url)
            themes(browser, url)
            live_place(browser, url)
            visits_and_names(browser, url)
            analytics(browser, url)
            bricks_in_groups(browser, url)
            polish(browser, url)
            signature(browser, url)
            finale(browser, url)
            board_and_share(browser, url)
            checkpoint_retry(browser, url)
            final_update(browser, url)
            match_time(browser, url)
            invite_and_boards(browser, url)
        finally:
            browser.close()
            srv.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
