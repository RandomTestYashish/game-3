// Game rules and physics. No DOM access: the simulation runs in flat court
// coordinates (x across, y from the far wall toward the player) and the
// renderer projects it into the 2.5D view.

export const WW = 200;
export const WH = 240;

export const BLOCKS = {
  T: { hp: 1, pts: 10, hz: 10 },
  L: { hp: 1, pts: 15, hz: 10 },
  H: { hp: 2, pts: 30, hz: 10 },
  S: { hp: 3, pts: 50, hz: 6 },
};

export const TOOLS = [
  { id: 'shield', name: 'SHIELD', desc: ['A BARRIER BEHIND THE PADDLE', 'SAVES ONE BALL.'] },
  { id: 'multiball', name: 'MULTIBALL', desc: ['EVERY BALL IN PLAY', 'SPLITS INTO THREE.'] },
  { id: 'smash', name: 'SMASH', desc: ['THE BALL TEARS STRAIGHT', 'THROUGH EVERY BLOCK.'] },
  { id: 'freeze', name: 'FREEZE', desc: ['BLOCKS STOP MOVING AND', 'SHATTER IN ONE HIT.'] },
  { id: 'expand', name: 'EXPAND', desc: ['A WIDER PADDLE', 'FOR A WHILE.'] },
  { id: 'lowgrav', name: 'LOW GRAVITY', desc: ['BALLS AND TOOLS DRIFT', 'DOWN SLOWLY.'] },
];

export const PADDLE_Y = WH - 34; // just in front of the baseline
export const START_LIVES = 3; // a run's lives; a lost life never comes back
export const MAX_BALLS = 9;
export const MAX_DROPS = 2; // tools falling at once
// Power Rush: a tool falls from the far end every this many seconds (min, max).
export const RAIN_EVERY = [1.4, 2.4];
// Power Rush: once only this share of a court's blocks is left, tools drop on
// most breaks (still no more than MAX_DROPS falling at once).
export const RUSH_AT = 0.25;
export const RUSH_RATE = 0.65;
export const LIFE_BONUS = 100; // per life left when a court is cleared
export const COMBO_STEP = 0.25;
export const COMBO_CAP = 8; // steps, so the multiplier tops out at 1 + 8 * 0.25 = x3
export const SPEED_UP = 1.03; // per paddle hit
export const SPEED_CAP = 1.35; // times the court's base speed

// Score multiplier for the nth brick broken since a ball last touched the paddle.
export const comboMult = (n) => 1 + Math.min(Math.max(n, 1) - 1, COMBO_CAP) * COMBO_STEP;
export const brickPoints = (type, n) => Math.round((BLOCKS[type].pts * comboMult(n)) / 5) * 5;

export const TOOL_TIME = { smash: 7, freeze: 8, expand: 14, lowgrav: 10 };

const WEIGHTS = { shield: 1, multiball: 1.2, smash: 0.9, freeze: 0.9, expand: 1.2, lowgrav: 0.9 };

export class Game {
  // opts carry a run across courts: { lives, score }
  constructor(level, emit = () => {}, rng = Math.random, opts = {}) {
    this.level = level;
    this.emit = emit;
    this.rng = rng;
    this.t = 0;
    this.moveT = 0;
    this.state = 'serve'; // serve | play | won | over
    this.lives = opts.lives ?? START_LIVES;
    this.score = opts.score ?? 0;
    this.startScore = this.score;
    this.lost = 0;
    this.padW = level.paddle ?? 54;
    this.dropRate = level.drop ?? 0.16;
    this.firstTool = opts.firstTool || null; // guided first rally: a known tool, early
    this.combo = 0;
    this.bonus = 0;
    this.shield = false;
    this.fx = { smash: 0, freeze: 0, expand: 0, lowgrav: 0 };
    this.sinceDrop = 0;
    this.rush = false; // the Power Rush at the end of the court
    this.shake = 0;
    this.paddle = { x: WW / 2, y: PADDLE_Y, w: this.padW, d: 8 };
    this.balls = [];
    this.drops = [];
    this.parts = [];
    this.floaters = [];
    this.blocks = [];
    this.buildBlocks();
    this.remaining = this.blocks.length;
    this.total = this.blocks.length;
    this.spawnServe();
  }

  buildBlocks() {
    const { rows, move = [], cell = 28, row: ROW = 20 } = this.level;
    const cols = rows[0].length;
    const left = (WW - cols * cell) / 2 + 1; // centred across the court
    const top = 30 + Math.max(0, 6 - rows.length) * 6;
    const tall = 0.35 + (0.65 * cell) / 28; // smaller blocks stand lower
    const gap = Math.min(2, Math.max(1, cell * 0.12)); // between blocks across
    const deep = Math.max(ROW - 6, ROW * 0.7); // block depth; the rest is the gap
    // Blocks drop in row by row; a big grid drops in as fast as a small one.
    const dr = 0.07 * Math.min(1, 7 / rows.length);
    const dc = 0.025 * Math.min(1, 7 / cols);
    const drift = this.level.drift || 0;
    const wave = this.level.wave ?? 2;
    rows.forEach((row, r) => {
      const moving = move.includes(r);
      for (let c = 0; c < cols; c++) {
        const type = row[c];
        if (!BLOCKS[type]) continue;
        const x = left + c * cell;
        this.blocks.push({
          type,
          c,
          r,
          bx: x,
          x,
          by: top + r * ROW,
          y: top + r * ROW,
          bob: 0,
          drift,
          wave,
          w: cell - gap,
          d: deep,
          hz: Math.round(BLOCKS[type].hz * tall),
          hp: BLOCKS[type].hp,
          max: BLOCKS[type].hp,
          seed: (r * 31 + c * 17 + 7) * 2654435761,
          alive: true,
          landed: false,
          bounced: false,
          delay: 0.25 + r * dr + c * dc,
          z: 170,
          vz: 0,
          flash: 0,
          amp: moving ? cell - gap : 0,
          freq: 0.9 + (r % 3) * 0.25,
          phase: r * 1.7,
        });
      }
    });
  }

  spawnServe() {
    this.balls.push({
      x: this.paddle.x,
      y: this.paddle.y - this.paddle.d / 2 - 4,
      vx: 0,
      vy: -1,
      r: 4,
      speed: this.level.speed,
      stuck: true,
      z: 5,
      vz: 0,
      trail: [],
      trailT: 0,
    });
    this.state = 'serve';
  }

  // All blocks have finished dropping onto the court.
  get ready() {
    return this.blocks.every((b) => b.landed);
  }

  launch() {
    if (this.state !== 'serve') return false;
    for (const b of this.balls) {
      if (!b.stuck) continue;
      const a = (this.rng() - 0.5) * 0.7;
      b.vx = Math.sin(a);
      b.vy = -Math.cos(a);
      b.stuck = false;
      b.vz = 70;
    }
    this.state = 'play';
    this.emit('serve');
    return true;
  }

  movePaddleTo(x) {
    const hw = this.paddle.w / 2;
    this.paddle.x = Math.max(hw, Math.min(WW - hw, x));
  }

  update(dt, axis = 0) {
    this.t += dt;
    this.shake = Math.max(0, this.shake - dt);
    const p = this.paddle;

    if (this.state === 'serve' || this.state === 'play') {
      for (const k in this.fx) this.fx[k] = Math.max(0, this.fx[k] - dt);
      const target = this.padW + (this.fx.expand > 0 ? 26 : 0);
      p.w += (target - p.w) * Math.min(1, dt * 10);
      if (Math.abs(target - p.w) < 0.2) p.w = target;
      this.movePaddleTo(p.x + axis * 290 * dt);
    }

    if (this.fx.freeze <= 0) this.moveT += dt;
    for (const b of this.blocks) {
      if (!b.alive) continue;
      b.flash = Math.max(0, b.flash - dt);
      if (b.amp) b.x = b.bx + Math.sin(this.moveT * b.freq + b.phase) * b.amp;
      if (b.landed) {
        // The whole formation breathes toward the player; each block also
        // floats a little (the float is visual only).
        if (b.drift) b.y = b.by + (1 - Math.cos(this.moveT * 0.55)) * 0.5 * b.drift;
        b.bob = (1 + Math.sin(this.t * 2.2 + b.c * 0.9 + b.r * 0.7)) * 0.5 * b.wave;
        continue;
      }
      b.delay -= dt;
      if (b.delay > 0) continue;
      b.vz -= 900 * dt;
      b.z += b.vz * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.bounced) {
          b.landed = true;
        } else {
          b.bounced = true;
          b.vz = 95;
          this.dust(b);
          this.emit('land', b.type);
        }
      }
    }

    if (this.state === 'serve' || this.state === 'play') {
      this.updateBalls(dt);
      this.updateDrops(dt);
    }
    this.updateParts(dt);
  }

  updateBalls(dt) {
    const p = this.paddle;
    for (const ball of this.balls) {
      if (ball.stuck) {
        ball.x = p.x;
        ball.y = p.y - p.d / 2 - ball.r;
        ball.trail.length = 0;
        continue;
      }
      const slow = this.fx.lowgrav > 0 && ball.vy > 0 ? 0.6 : 1;
      const dist = ball.speed * slow * dt;
      const n = Math.max(1, Math.ceil(dist / 2));
      const st = dist / n;
      for (let i = 0; i < n && !ball.dead; i++) {
        ball.x += ball.vx * st;
        ball.y += ball.vy * st;
        this.collide(ball);
      }
      // Cosmetic hop height above the grass.
      const rest = this.fx.lowgrav > 0 ? 11 : 5;
      ball.vz -= 260 * dt;
      ball.z += ball.vz * dt;
      if (ball.z < rest) {
        ball.z += (rest - ball.z) * Math.min(1, dt * 8);
        if (ball.vz < 0) ball.vz = 0;
      }
      ball.trailT += dt;
      if (ball.trailT > 0.022) {
        ball.trailT = 0;
        ball.trail.push({ x: ball.x, y: ball.y, z: ball.z });
        if (ball.trail.length > 14) ball.trail.shift();
      }
    }
    this.balls = this.balls.filter((b) => !b.dead);
    if (this.state === 'play' && this.balls.length === 0) this.loseLife();
  }

  collide(ball) {
    const p = this.paddle;
    let bounced = false;

    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx);
      bounced = true;
      this.emit('wall', 'side', { x: ball.x });
    } else if (ball.x > WW - ball.r) {
      ball.x = WW - ball.r;
      ball.vx = -Math.abs(ball.vx);
      bounced = true;
      this.emit('wall', 'side', { x: ball.x });
    }
    if (ball.y < ball.r) {
      ball.y = ball.r;
      ball.vy = Math.abs(ball.vy);
      bounced = true;
      this.emit('wall', 'back', { x: ball.x });
    }

    // Paddle
    if (
      ball.vy > 0 &&
      ball.y + ball.r >= p.y - p.d / 2 &&
      ball.y - ball.r <= p.y + p.d / 2 &&
      Math.abs(ball.x - p.x) <= p.w / 2 + ball.r
    ) {
      const off = Math.max(-1, Math.min(1, (ball.x - p.x) / (p.w / 2)));
      const a = off * 1.05;
      ball.vx = Math.sin(a);
      ball.vy = -Math.cos(a);
      ball.y = p.y - p.d / 2 - ball.r;
      ball.speed = Math.min(ball.speed * SPEED_UP, this.level.speed * SPEED_CAP);
      ball.vz = 70;
      this.combo = 0;
      this.emit('paddle', off, { x: ball.x, speed: ball.speed / this.level.speed });
      return;
    }

    // Shield barrier along the baseline
    if (this.shield && ball.vy > 0 && ball.y + ball.r >= WH - 3) {
      ball.vy = -Math.abs(ball.vy);
      ball.y = WH - 3 - ball.r;
      ball.vz = 60;
      this.shield = false;
      this.emit('shield');
      return;
    }

    if (ball.y - ball.r > WH + 8) {
      ball.dead = true;
      return;
    }

    // Blocks
    const smash = this.fx.smash > 0;
    for (const b of this.blocks) {
      if (!b.alive) continue;
      const nx = Math.max(b.x, Math.min(b.x + b.w, ball.x));
      const ny = Math.max(b.y, Math.min(b.y + b.d, ball.y));
      const dx = ball.x - nx;
      const dy = ball.y - ny;
      if (dx * dx + dy * dy >= ball.r * ball.r) continue;
      if (smash) {
        this.hitBlock(b, true);
        continue;
      }
      if (dx === 0 && dy === 0) {
        // Centre is inside the block: back out the way it came.
        ball.vy = -ball.vy;
        ball.y = ball.vy > 0 ? b.y + b.d + ball.r : b.y - ball.r;
      } else if (Math.abs(dx) > Math.abs(dy)) {
        ball.vx = Math.sign(dx) * Math.abs(ball.vx);
        ball.x = nx + Math.sign(dx) * ball.r;
      } else {
        ball.vy = Math.sign(dy) * Math.abs(ball.vy);
        ball.y = ny + Math.sign(dy) * ball.r;
      }
      bounced = true;
      this.hitBlock(b, false);
      break;
    }

    // Never let a ball settle into a flat, endless side-to-side rally.
    if (bounced && Math.abs(ball.vy) < 0.25) {
      ball.vy = (ball.vy < 0 ? -1 : 1) * 0.25;
      const m = Math.hypot(ball.vx, ball.vy);
      ball.vx /= m;
      ball.vy /= m;
    }
  }

  hitBlock(b, kill) {
    b.hp = kill || this.fx.freeze > 0 ? 0 : b.hp - 1;
    if (b.hp > 0) {
      b.flash = 0.12;
      this.debris(b, 3);
      this.emit('hit', b.type, { x: b.x + b.w / 2, y: b.y + b.d / 2, hp: b.hp });
      return;
    }
    b.alive = false;
    this.combo++;
    this.remaining--;
    const pts = brickPoints(b.type, this.combo);
    this.score += pts;
    this.floaters.push({ x: b.x + b.w / 2, y: b.y + b.d / 2, z: b.hz + 4, text: '+' + pts, life: 0.9 });
    this.debris(b, 10);
    this.emit('break', this.combo, { type: b.type, x: b.x + b.w / 2, y: b.y + b.d / 2 });
    if (this.remaining === 0) this.win();
    else {
      if (!this.rush && this.total >= 12 && this.remaining <= this.total * RUSH_AT) {
        this.rush = true;
        this.emit('rush');
      }
      this.maybeDrop(b);
    }
  }

  maybeDrop(b) {
    this.sinceDrop++;
    if (this.firstTool) {
      // Guided first rally: no random tools until the known one has dropped,
      // so the hint that names it is always right.
      if (this.total - this.remaining < 3) return;
      this.drops.push({ type: this.firstTool, x: b.x + b.w / 2, y: b.y + b.d / 2, t: 0 });
      this.emit('drop', this.firstTool, { x: b.x + b.w / 2 });
      this.firstTool = null;
      this.sinceDrop = 0;
      return;
    }
    if (this.drops.length >= MAX_DROPS) return;
    if (this.sinceDrop < 7 && this.rng() >= (this.rush ? RUSH_RATE : this.dropRate)) return;
    const type = this.pickTool();
    this.sinceDrop = 0;
    this.drops.push({ type, x: b.x + b.w / 2, y: b.y + b.d / 2, t: 0 });
    this.emit('drop', type, { x: b.x + b.w / 2 });
  }

  weight(id) {
    if (id === 'shield' && this.shield) return 0;
    if (id === 'multiball' && this.balls.length >= MAX_BALLS) return 0;
    return WEIGHTS[id];
  }

  // A tool at random, weighted (see weight()).
  pickTool() {
    let total = 0;
    for (const t of TOOLS) total += this.weight(t.id);
    let pick = this.rng() * total;
    for (const t of TOOLS) {
      pick -= this.weight(t.id);
      if (pick <= 0) return t.id;
    }
    return TOOLS[0].id;
  }

  // In a Power Rush few bricks are left to break, so tools also fall from
  // the far end at random places every couple of seconds.
  rushRain(dt) {
    if (!this.rush || this.state !== 'play') return;
    this.rainIn = (this.rainIn ?? RAIN_EVERY[0]) - dt;
    if (this.rainIn > 0) return;
    this.rainIn = RAIN_EVERY[0] + this.rng() * (RAIN_EVERY[1] - RAIN_EVERY[0]);
    if (this.drops.length >= MAX_DROPS) return;
    const type = this.pickTool();
    const x = 16 + this.rng() * (WW - 32);
    this.drops.push({ type, x, y: 8, t: 0 });
    this.emit('drop', type, { x });
  }

  updateDrops(dt) {
    this.rushRain(dt);
    const p = this.paddle;
    const fall = 62 * (this.fx.lowgrav > 0 ? 0.5 : 1);
    for (const d of this.drops) {
      d.t += dt;
      d.y += fall * dt;
      if (Math.abs(d.x - p.x) <= p.w / 2 + 6 && Math.abs(d.y - p.y) <= 7) {
        d.dead = true;
        this.applyTool(d.type);
      } else if (d.y > WH + 14) {
        d.dead = true;
      }
    }
    this.drops = this.drops.filter((d) => !d.dead);
  }

  applyTool(type) {
    const tool = TOOLS.find((t) => t.id === type);
    if (!tool) return;
    if (type === 'shield') {
      this.shield = true;
    } else if (type === 'multiball') {
      const extra = [];
      for (const b of this.balls) {
        for (const turn of [-0.5, 0.5]) {
          if (this.balls.length + extra.length >= MAX_BALLS) break;
          let vx = b.stuck ? Math.sin(turn) : b.vx * Math.cos(turn) - b.vy * Math.sin(turn);
          let vy = b.stuck ? -Math.cos(turn) : b.vx * Math.sin(turn) + b.vy * Math.cos(turn);
          if (Math.abs(vy) < 0.25) {
            vy = vy < 0 ? -0.25 : 0.25;
            const m = Math.hypot(vx, vy);
            vx /= m;
            vy /= m;
          }
          extra.push({ ...b, vx, vy, stuck: false, vz: 60, trail: [], trailT: 0 });
        }
      }
      this.balls.push(...extra);
      if (extra.length && this.state === 'serve') this.launch();
    } else {
      this.fx[type] = TOOL_TIME[type];
    }
    this.floaters.push({ x: this.paddle.x, y: this.paddle.y - 10, z: 10, text: tool.name, life: 1.1 });
    this.emit('power', type);
  }

  loseLife() {
    this.lives--;
    this.lost++;
    this.combo = 0;
    this.shake = 0.3;
    this.shield = false;
    this.drops = [];
    for (const k in this.fx) this.fx[k] = 0;
    if (this.lives <= 0) {
      this.state = 'over';
      this.emit('over');
    } else {
      this.emit('lost');
      this.spawnServe();
    }
  }

  win() {
    this.state = 'won';
    this.bonus = this.lives * LIFE_BONUS;
    this.score += this.bonus;
    this.drops = [];
    for (const ball of this.balls) {
      for (let i = 0; i < 6; i++) this.spark(ball.x, ball.y, ball.z);
    }
    this.balls = [];
    this.emit('win');
  }

  get stars() {
    return Math.max(1, 3 - this.lost);
  }

  // ------------------------------------------------------------- particles

  debris(b, n) {
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2;
      const sp = 20 + this.rng() * 60;
      this.parts.push({
        x: b.x + this.rng() * b.w,
        y: b.y + this.rng() * b.d,
        z: this.rng() * b.hz,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.7,
        vz: 40 + this.rng() * 90,
        life: 0.8 + this.rng() * 0.9,
        size: this.rng() < 0.35 ? 3 : 2,
        type: b.type,
        shade: (this.rng() * 3) | 0,
      });
    }
    if (this.parts.length > 260) this.parts.splice(0, this.parts.length - 260);
  }

  // A puff where a block lands. Big courts land hundreds at once, so the
  // puffs share the same particle budget as the debris.
  dust(b) {
    if (this.parts.length > 200) return;
    for (let i = 0; i < 3; i++) {
      this.parts.push({
        x: b.x + this.rng() * b.w,
        y: b.y + b.d,
        z: 0,
        vx: (this.rng() - 0.5) * 50,
        vy: 10 + this.rng() * 14,
        vz: 18 + this.rng() * 22,
        life: 0.3 + this.rng() * 0.25,
        size: 1,
        type: 'dust',
        shade: 0,
      });
    }
  }

  spark(x, y, z) {
    const a = this.rng() * Math.PI * 2;
    this.parts.push({
      x,
      y,
      z,
      vx: Math.cos(a) * 70,
      vy: Math.sin(a) * 50,
      vz: 60 + this.rng() * 80,
      life: 0.6 + this.rng() * 0.5,
      size: 2,
      type: 'spark',
      shade: 0,
    });
  }

  updateParts(dt) {
    for (const q of this.parts) {
      q.life -= dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vz -= 420 * dt;
      q.z += q.vz * dt;
      if (q.z < 0) {
        q.z = 0;
        q.vz = -q.vz * 0.35;
        q.vx *= 0.55;
        q.vy *= 0.55;
      }
    }
    this.parts = this.parts.filter((q) => q.life > 0);
    for (const f of this.floaters) {
      f.life -= dt;
      f.z += 22 * dt;
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);
  }
}
