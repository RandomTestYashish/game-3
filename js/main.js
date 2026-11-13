// Boot, screen flow, input and the frame loop.

import { W, H, ctx, PAL, initCanvas, setSize, setTarget, makeLayer, rect, rrect, disc, ellipse, line, text, textW, wrap, blockTitle, sparkle, racket, cup, METAL, trophy, laurel, rays, globe, serif, serifW, icon, clamp, lerp, easeOut, easeInOut, easeBack, checker } from './gfx.js';
import { P, setCam, buildLayers, drawScene, setTheme, currentTheme, drawThemePreview, proj, unprojX, drawBlock, drawBall, drawShadow } from './scene.js';
import { COUNTRIES, getCourtTheme } from './themes.js';
import { Game, TOOLS, START_LIVES, RUSH_AT, MATCH_WEIGHTS } from './game.js';
import { sections } from './rules.js';
import { LEVELS, matchLevel } from './levels.js';
import { drawGame, drawHUD, hudRows } from './render.js';
import { ui, beginUI, region, hitTest, pill, ghost, card, tile, cardArt, roundBtn, iconBtn, slider, panel } from './ui.js';
import { AudioSys, COURT_TRACKS, RUSH_TEMPO } from './audio.js';
import { haptics } from './haptics.js';
import { setupMultiplayer, openMultiplayer, bootMultiplayer, tickMultiplayer, drawOpponentHUD, onRunEnd, onCourtCleared, onPlayStarted, onPause, applyBroken, typing, typeChar, submitName, leaveMatch, openFriendsBoard, friendsOn, MP_SCREENS, MP_SCREEN_NAMES, mp } from './multiplayer.js';
import { Save, BOARD_SIZE, cleanName } from './save.js';
import { onlineEnabled } from './config.js';
import { fetchTopScores, submitScore, nameTaken } from './remote.js';
import { initAnalytics, track } from './analytics.js';
import { shareScore, ordinal } from './share.js';

const canvas = document.getElementById('court');
// Screen readers get the canvas label; the theme screen describes its choice there.
const ARIA = canvas.getAttribute('aria-label');
const say = (label) => canvas.getAttribute('aria-label') !== label && canvas.setAttribute('aria-label', label);
initCanvas(canvas);

const save = new Save();
haptics.on = save.data.settings.haptics;
const audio = new AudioSys(save.data.settings);
const debug = new URLSearchParams(location.search).has('debug');

const CAM = { loading: 0, title: 0, intro: 0.14, courts: 0.38, tools: 0.5, countdown: 1, play: 1, paused: 1, complete: 0.82, name: 0.82, scores: 0.55 };
for (const n of MP_SCREEN_NAMES) CAM[n] = 0.55; // multiplayer menus sit like the leaderboard
const GAME_SCREENS = new Set(['countdown', 'play', 'paused', 'complete', 'name']);
const PER_PAGE = 20;
const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ-';
const DIGITS = '1234567890';
const LEAVE = 0.2;
const BEAT = 0.75; // seconds per countdown number

const S = {
  screen: 'loading',
  t: 0,
  time: 0,
  leaving: null,
  next: null,
  cam: 0,
  camFrom: 0,
  camTo: 0,
  camT: 1,
  ready: false,
  level: 0,
  game: null,
  gameVis: 0,
  titleVis: 0,
  landing: 1, // 1 on the first screen (no net or canopy yet), easing to 0 after Play
  overlay: false, // false | 'sound' | 'rules' | 'theme'
  overlayKind: 'sound',
  rulesTab: 0,
  rulesFits: true,
  overlayT: 0,
  tool: 0,
  count: 0,
  beat: 0,
  result: null,
  ending: 0,
  introSeen: false,
  eraseArmed: 0,
  touch: false,
  left: false,
  right: false,
  primary: null,
  back: null,
  timeScale: 1,
  shift: 0,
  run: null, // { lives, score, saved } carried from court to court
  page: 0,
  name: '',
  nameTitle: 'RALLY OVER',
  board: { rank: -1, fromRun: false },
  boardTab: 'local', // 'local' | 'online' (online only when js/config.js is filled in)
  online: { state: 'idle', rows: [], error: '', at: -99 },
  look: 0, // this visit's turn of the automatic theme rotation (set at boot)
  tip: Math.floor(Math.random() * 5), // which loading tip to show
  nameCheck: { name: '', state: 'idle', at: 0 }, // is the typed name free on the online board?
  post: { state: 'idle', error: '', entry: null }, // sending the last saved run to the online board
  coach: null, // first-time guided rally: { step, t, moved, lastX, toolSeen }
};

// ---------------------------------------------------------------- flow

function go(name) {
  if (S.leaving || name === S.screen) return;
  S.leaving = { name: S.screen, t: 0 };
  S.next = name;
  aimCam(CAM[name]);
}

function aimCam(to) {
  if (to === S.camTo) return;
  S.camFrom = S.cam;
  S.camTo = to;
  S.camT = 0;
}

function enter(name) {
  S.screen = name;
  S.t = 0;
  if (name === 'countdown') {
    // A match counts down to the server's start time; solo is three beats.
    S.count = S.countFrom != null ? S.countFrom : BEAT * 3;
    S.countFrom = null;
    S.beat = 4;
  }
  if (S.mpGame && name === 'paused') onPause(true);
  if (S.mpGame && name === 'play') onPause(false);
  if (name === 'intro') S.introSeen = true;
  if (name === 'courts') S.page = Math.floor((Math.min(save.data.progress.unlocked, LEVELS.length) - 1) / PER_PAGE);
  if (name === 'name') {
    S.name = save.data.lastName;
    S.nameCheck = { name: '', state: 'idle', at: 0 };
    S.typedAt = -99;
  }
  if (name === 'scores') {
    // The shared board is the only one shown when it is set up; without a
    // configured project (a local copy of the game) the device board stands in.
    S.boardTab = onlineEnabled() ? 'online' : 'local';
    if (S.boardTab === 'online') loadOnline(S.board.fromRun);
    S.share = { seen: false, busy: false, note: '', noteT: 0 };
    S.list = { cur: null, to: null, max: 0, rowH: 16, scrolled: false, min: 0 }; // the table's scroll, in rows
    track('leaderboard_viewed', { source: S.board.fromRun ? 'run' : 'menu' });
  }
}

let lastLand = 0;
function onGameEvent(type, arg, info) {
  if (type === 'land') {
    if (S.time - lastLand < 0.06) return;
    lastLand = S.time;
  }
  audio.sfx(type, arg, info);
  buzz(type, arg, info);
  if (type === 'rush') S.rushAt = S.time;
  if (type === 'win') S.cheer = { at: S.time }; // the finish: slow motion, flash, fireworks
  if ((type === 'break' || type === 'hit') && info) crowdPop(info, type === 'break' ? 1 : 0.7);
  if (type === 'break' && arg === WAVE_COMBO) startWave();
  if (type === 'rush') startWave();
  if (type === 'break') {
    // Big moments get the crowd going: a combo milestone, or a burst of bricks at once.
    S.breaks = (S.breaks || []).filter((t) => S.time - t < BURST_WINDOW);
    S.breaks.push(S.time);
    if (arg >= 5 && arg % 5 === 0) crowdCheer(arg >= 10 ? 2 : 1);
    else if (S.breaks.length >= BURST_BREAKS) crowdCheer(S.breaks.length >= 5 ? 2 : 1);
    else if (arg === 3) crowdReact('clap'); // a nice little run
  }
  if (type === 'power' && arg === 'multiball') {
    // The stands erupt: the fans jump (a cheer's look) to the roar's sound.
    S.crowd = { at: S.time, big: 2, kind: 'cheer' };
    audio.sfx('roar', 1, lastPlace());
  } else if (type === 'power') crowdReact('clap'); // a tool caught
  if (type === 'paddle' && Math.abs(arg || 0) > 0.8) crowdReact('gasp'); // saved off the edge
  if (type === 'rush') audio.sfx('chant', 4);
  if (type === 'lost' || type === 'over') crowdReact('groan');
  if (type === 'rush') S.crowd = { at: S.time, big: 1, kind: 'cheer' }; // the fans up for the chant below
  if (type === 'win') crowdCheer(3);
  // Analytics only while the run is live: a quit run's ball may still roll out behind the name screen.
  const live = S.run && !S.run.over && !S.mpGame;
  if (live && (type === 'lost' || type === 'over')) track('life_lost', { court: S.level + 1, lives_left: S.game.lives, run_score: S.game.score });
  if (live && type === 'power') track('powerup_used', { powerup: arg, court: S.level + 1 });
  if (S.coach) coachEvent(type);
  if (type === 'win' || type === 'over') finish(type === 'win');
}

// The feel of each event in the hand (see js/haptics.js).
function buzz(type, arg, info) {
  if (type === 'land' || type === 'drop') return; // too many, too small
  if (type === 'break') return haptics.play('break' + ((info && info.type) || 'T'), 1 + Math.min(arg || 1, 10) * 0.05);
  if (type === 'paddle') return haptics.play(Math.abs(arg || 0) > 0.7 ? 'paddleEdge' : 'paddle');
  haptics.play(type);
}

// What a tap on each button sounds (and feels) like.
const CONFIRM_IDS = new Set(['play', 'begin', 'save', 'again', 'resume', 'next', 'replay', 'retry', 'done', 'themedone']);
const BACK_IDS = new Set(['close', 'home', 'back', 'skiptips']);
function tapSound(id) {
  if (id.startsWith('key')) {
    const ch = id.slice(3);
    audio.sfx(ch === 'del' ? 'back' : 'key', ch);
    return haptics.play('key');
  }
  if (id.startsWith('tab') || id === 'friends') {
    audio.sfx('tab');
    return haptics.play('tap');
  }
  if (id === 'mute' || id === 'vibrate') {
    audio.sfx('toggle', id === 'mute' ? save.data.settings.muted : !haptics.on);
    return haptics.play('tap');
  }
  if (CONFIRM_IDS.has(id)) audio.sfx('confirm');
  else if (BACK_IDS.has(id)) audio.sfx('back');
  else audio.sfx('click');
  haptics.play(BACK_IDS.has(id) ? 'back' : 'tap');
}

// The crowd reacts to every brick hit: the fans nearest it pop up, with a
// little "ooh" or "yeah" from that side. And now and then a Mexican wave
// goes round all three stands.
const POP_LEN = 0.7; // seconds a pop lasts
const WAVE_LEN = 3.6; // seconds for the wave to go all the way round
const WAVE_COMBO = 8; // a combo this long starts a wave
const WAVE_EVERY = 24; // a quiet stretch of play this long starts one too
let lastOoh = -1;
function crowdPop(info, k) {
  S.pops = (S.pops || []).filter((q) => S.time - q.at < POP_LEN);
  if (S.pops.length > 8) S.pops.shift();
  S.pops.push({ x: info.x, y: info.y ?? 60, at: S.time, k });
  if (S.time - lastOoh > 0.14) {
    lastOoh = S.time;
    audio.sfx('ooh', k, info);
  }
}
function startWave() {
  if (S.wave && S.time - S.wave.at < WAVE_LEN + 2) return;
  S.wave = { at: S.time };
  audio.sfx('wave', WAVE_LEN);
  haptics.play('wave');
}
// Where the crest is now (0..1 round the stands), or -1.
function wavePos() {
  if (!S.wave || !GAME_SCREENS.has(S.screen)) return -1;
  const k = (S.time - S.wave.at) / WAVE_LEN;
  return k > 1.1 ? -1 : k * 1.1 - 0.05;
}

// The crowd behind the court cheers (and roars) at big moments; strength 1-3.
const BURST_WINDOW = 0.45; // seconds
const BURST_BREAKS = 3; // bricks broken inside the window that count as a burst
const CROWD_GAP = 1.2; // seconds before the crowd can start another cheer
// Where the latest brick broke (court x), so the crowd answers from that side.
function lastPlace() {
  const q = S.pops && S.pops[S.pops.length - 1];
  return q && S.time - q.at < 1 ? { x: q.x } : null;
}
function crowdCheer(big) {
  if (S.crowd && S.crowd.kind === 'cheer' && S.time - S.crowd.at < CROWD_GAP && big <= S.crowd.big) return;
  S.crowd = { at: S.time, big, kind: 'cheer' };
  S.breaks = [];
  audio.sfx('cheer', big, lastPlace());
  haptics.play('cheer', big * 0.5 + 0.5);
}
// Smaller reactions: a round of applause ('clap') or a groan ('groan').
// They never cut a cheer short.
function crowdReact(kind) {
  if (S.crowd && S.time - S.crowd.at < CROWD_GAP && (S.crowd.kind === 'cheer' || S.crowd.kind === kind)) return;
  S.crowd = { at: S.time, big: 1, kind };
  audio.sfx(kind, 1, lastPlace());
}
const CROWD_LEN = 1.8; // seconds the fans keep jumping
function crowdMood(kind) {
  if (!S.crowd || S.crowd.kind !== kind || !GAME_SCREENS.has(S.screen)) return 0;
  const k = 1 - (S.time - S.crowd.at) / CROWD_LEN;
  return k <= 0 ? 0 : Math.min(1, k * 1.5);
}
function crowdHype() {
  if (!S.crowd || S.crowd.kind !== 'cheer' || !GAME_SCREENS.has(S.screen)) return 0;
  const k = 1 - (S.time - S.crowd.at) / (CROWD_LEN + S.crowd.big * 0.4);
  return k <= 0 ? 0 : Math.min(1, k * 1.5) * (0.6 + S.crowd.big * 0.2);
}

// A run starts on any court with START_LIVES lives and carries score and lives
// forward until the player loses, stops, or clears the last court. Lives are
// only ever reset by starting a new run, which also resets the score to 0.
function beginRun(i) {
  quitRun(); // Restart from Pause ends the run that was going
  if (S.coach) return firstRally(); // restarting mid-tutorial restarts the tutorial
  S.run = { lives: START_LIVES, score: 0, saved: false, cleared: 0 };
  S.place = null;
  startLevel(i);
  track('game_started', { court: S.level + 1, tutorial: false });
}

// Analytics: a run stopped before its end (Home from Pause, Esc on the countdown).
function quitRun() {
  if (S.run && S.game && !S.run.over) {
    S.run.over = true;
    track('game_over', { reason: 'quit', court: S.level + 1, run_score: S.game.score, courts_cleared: S.run.cleared || 0 });
  }
}

// ---- first-time journey ---------------------------------------------------
// A new player skips the court grid and tools briefing and goes straight into
// a gentler court 1 with a few hints. Everything else is the normal game.

function afterIntro() {
  if (save.data.onboarded) go('courts');
  else firstRally();
}

function firstRally() {
  quitRun();
  S.coach = { step: 'move', t: 0, moved: 0, lastX: null, toolSeen: false };
  S.run = { lives: START_LIVES, score: 0, saved: false, cleared: 0 };
  S.place = null;
  startLevel(0, { ...LEVELS[0], speed: Math.round(LEVELS[0].speed * 0.8) }, { firstTool: 'expand' });
  track('game_started', { court: 1, tutorial: true });
}

function endCoach() {
  S.coach = null;
  if (!save.data.onboarded) {
    save.data.onboarded = true;
    save.commit();
  }
}

function coachEvent(type) {
  const c = S.coach;
  const to = (step) => {
    c.step = step;
    c.t = 0;
  };
  if (type === 'serve') to(c.step === 'lost' ? 'idle' : c.step === 'move' || c.step === 'serve' ? 'break' : c.step);
  else if (type === 'drop' && !c.toolSeen) {
    c.toolSeen = true;
    to('tool');
  } else if (type === 'power' && c.step === 'tool') to('caught');
  else if (type === 'lost') to('lost');
}

function coachText() {
  const serve = S.touch ? 'TAP TO SERVE' : 'CLICK OR PRESS SPACE TO SERVE';
  return {
    move: S.touch ? 'DRAG ANYWHERE TO MOVE' : 'MOVE THE MOUSE OR USE ARROW KEYS',
    serve: 'NOW ' + serve,
    break: 'KEEP THE BALL UP. CLEAR EVERY BLOCK.',
    tool: 'A TOOL IS FALLING. CATCH IT!',
    caught: 'WIDER PADDLE FOR A WHILE',
    lost: 'BALL LOST. ' + serve,
  }[S.coach.step];
}

function startLevel(i, level, extra) {
  S.cleared = null;
  if (onlineEnabled() && !S.mpGame) loadOnline(); // fresh rows for the live place (reused for 30 s)
  S.level = clamp(i, 0, LEVELS.length - 1);
  const lv = level || (S.mpGame ? matchLevel(S.level) : LEVELS[S.level]);
  const odds = S.mpGame ? { weights: MATCH_WEIGHTS } : {};
  S.game = new Game(lv, onGameEvent, Math.random, { lives: S.run.lives, score: S.run.score, ...odds, ...extra });
  S.ending = 0;
  if (S.screen === 'countdown') enter('countdown');
  else go('countdown');
}

function nextLevel() {
  const cleared = S.cleared;
  S.run.lives = S.game.lives; // lives carry over as they are: nothing is refilled between courts
  startLevel(S.level + 1);
  S.cleared = cleared;
}

function finish(won) {
  const g = S.game;
  const score = g.score - g.startScore;
  // A multiplayer game never touches solo progress or bests.
  const res = S.mpGame
    ? { best: 0, newBest: false }
    : save.recordResult(S.level, LEVELS[S.level].id, LEVELS.length, {
        won,
        score,
        stars: g.stars,
        blocks: g.total - g.remaining,
      });
  S.run.score = g.score;
  if (S.coach) endCoach(); // the first rally is over, win or lose
  S.result = {
    won,
    score,
    run: g.score,
    lives: g.lives,
    bonus: g.bonus,
    stars: won ? g.stars : 0,
    cleared: g.total - g.remaining,
    total: g.total,
    best: res.best,
    newBest: res.newBest,
    hasNext: won && S.level + 1 < LEVELS.length,
  };
  S.ending = won ? 1.2 : 0.9;
  const court = S.level + 1;
  if (S.mpGame) {
    if (won) S.run.cleared = (S.run.cleared || 0) + 1;
    if (!S.result.hasNext) S.run.over = true;
    return;
  }
  if (won) {
    S.run.cleared = (S.run.cleared || 0) + 1;
    track('court_completed', { court, score, run_score: g.score, stars: g.stars, lives_left: g.lives, blocks: g.total, new_best: res.newBest });
  }
  if (!S.result.hasNext) {
    S.run.over = true;
    track('game_over', { reason: won ? 'all_courts_cleared' : 'out_of_lives', court, run_score: g.score, courts_cleared: S.run.cleared });
  }
}

// The player is done: offer the leaderboard if there is a score to post.
function endRun(title) {
  if (S.run && S.game) S.run.score = S.game.score; // a run stopped mid-court still counts
  if (S.run && S.run.score > 0 && !S.run.saved) {
    S.nameTitle = title;
    go('name');
  } else {
    go('title');
  }
  S.coach = null; // leaving mid-tutorial: it will be offered again next time
}

// ---- unique names: a name already on the online board belongs to someone
// else, unless this device has saved a score under it before. The board is
// only read for this; if it cannot be reached, the name is not blocked.

const typedName = () => cleanName(S.name) || 'PLAYER';

function checkName() {
  const name = typedName();
  const c = { name, state: 'checking', at: S.time, saveAfter: false };
  S.nameCheck = c;
  if (!onlineEnabled() || save.data.names.includes(name)) {
    c.state = 'own';
    return;
  }
  nameTaken(name).then((res) => {
    if (S.nameCheck !== c) return; // the name has changed since
    c.state = res.ok ? (res.taken ? 'taken' : 'free') : 'error';
    if (c.saveAfter && c.state !== 'taken' && S.screen === 'name' && !S.leaving) saveScore();
  });
}

function saveScore() {
  if (!S.run || S.run.saved) return;
  if (S.nameCheck.name !== typedName() || S.nameCheck.state === 'idle') checkName();
  const c = S.nameCheck;
  if (c.state === 'checking') {
    c.saveAfter = true; // saves as soon as the board answers
    return;
  }
  if (c.state === 'taken') {
    c.at = S.time; // shakes the message
    audio.sfx('back');
    haptics.play('lost');
    return;
  }
  S.run.saved = true;
  S.board = { rank: save.addScore(typedName(), S.run.score, S.level + 1), fromRun: true };
  S.post = { state: 'idle', error: '', entry: { name: save.data.lastName, score: S.run.score, court: S.level + 1 } };
  postScore();
  go('scores');
}

// Send the saved run to the online board. The device copy is already safe,
// so a failure only offers a retry. Each run is sent at most once.
async function postScore() {
  const p = S.post;
  if (!onlineEnabled() || !p.entry || p.state === 'sending' || p.state === 'sent') return;
  p.state = 'sending';
  const res = await submitScore(p.entry.name, p.entry.score, p.entry.court);
  if (S.post !== p) return; // a newer run has been saved since
  track(res.ok ? 'leaderboard_submit_success' : 'leaderboard_submit_failure', { score: p.entry.score, court: p.entry.court, ...(res.ok ? {} : { error: res.error }) });
  if (res.ok) {
    p.state = 'sent';
    S.online.at = -99;
    if (S.screen === 'scores' || S.next === 'scores') loadOnline(true); // fetch again so the new score shows
  } else {
    Object.assign(p, { state: 'error', error: res.error });
  }
}

// Scroll the leaderboard table by some rows (wheel, keys). Dragging sets the
// position directly; see the 'boardlist' region in SCREENS.scores.
let dragFresh = false;
function scrollBoard(rows) {
  const L = S.list;
  if (!L || S.screen !== 'scores' || S.leaving || L.max <= 0) return;
  if (L.to === null) L.to = L.cur;
  L.to = clamp(L.to + rows, 0, L.max);
  markScrolled();
}
function markScrolled() {
  if (S.list.scrolled) return;
  S.list.scrolled = true;
  track('leaderboard_scrolled', { rows: S.list.max });
}

// Share the run just played: a score card, through the share sheet where
// there is one, else downloaded with the link copied. One at a time.
async function shareRun() {
  const s = S.share;
  if (!s || s.busy || !S.run) return;
  s.busy = true;
  const board = onlineEnabled() ? S.online.rows : save.data.leaderboard;
  const sent = S.post && S.post.state === 'sent' && S.post.entry;
  const rank = onlineEnabled() ? (sent ? board.findIndex((e) => e.name === sent.name && e.score === sent.score) : -1) : S.board.rank;
  const run = { name: save.data.lastName, score: S.run.score, court: S.level + 1, rank, theme: courtTheme() };
  const base = { court: run.court, ranked: rank >= 0 };
  track('share_cta_clicked', base);
  const outcome = await shareScore(run, (event, props) => track(event, { ...base, ...props }));
  s.busy = false;
  s.note = { shared: 'SHARED!', saved: 'CARD SAVED, LINK COPIED', downloaded: 'CARD SAVED', cancelled: '', failed: 'COULD NOT SHARE. TRY AGAIN' }[outcome] || '';
  s.noteT = S.time;
}

// Read the shared leaderboard. Results are reused for 30 seconds.
// Rows already on screen stay there while a refresh is under way, and a
// refresh asked for mid-request runs straight after it instead of being lost.
async function loadOnline(force) {
  const o = S.online;
  if (o.state === 'loading') {
    if (force) o.again = true;
    return;
  }
  if (!force && o.state === 'ok' && S.time - o.at < 30) return;
  o.state = 'loading';
  o.again = false;
  const res = await fetchTopScores();
  o.at = S.time;
  if (res.ok) Object.assign(o, { state: 'ok', rows: res.rows, error: '' });
  else Object.assign(o, { state: 'error', rows: [], error: res.error });
  if (o.again) loadOnline(true);
}

function showBoard(tab) {
  S.boardTab = tab;
  if (tab === 'online') loadOnline();
}

function typeKey(ch) {
  if (ch === 'del') S.name = S.name.slice(0, -1);
  else if (S.name.length < 8) S.name += ch;
  S.typedAt = S.time;
}

function pause() {
  if (S.screen === 'play' && !S.leaving && !S.ending) go('paused');
}

function play() {
  if (!S.introSeen) go('intro');
  else afterIntro();
}

function openSound() {
  S.overlay = S.overlayKind = 'sound';
  S.eraseArmed = 0;
}

function openTheme() {
  S.overlay = S.overlayKind = 'theme';
}

function closeTheme() {
  S.overlay = false;
  save.commit();
}

// 'auto' or a country id. Visual only: the court, score and lives are untouched.
function chooseTheme(choice) {
  save.data.settings.theme = choice;
  save.commit();
}

// Menus play Stage Select; the courts take turns through five pump-up tracks
// so the music changes every court; every Black Court plays Boss Fight.
function musicFor(look) {
  const inGame = GAME_SCREENS.has(S.screen) && S.game;
  if (!inGame) return 'select';
  if (look.isBlackCourt) return 'boss';
  return COURT_TRACKS[S.level % COURT_TRACKS.length];
}

// How far a court's music has built: mellow at the serve, opening up as the
// bricks go, full power with heavy bass for the last stretch (and the menus).
function musicBuild() {
  const g = S.game;
  if (!GAME_SCREENS.has(S.screen) || !g || !g.total) return 1;
  if (g.state === 'won' || g.rush) return 1;
  const done = 1 - g.remaining / g.total;
  return 0.12 + 0.88 * Math.pow(done / (1 - RUSH_AT), 1.3);
}

// The theme for the court being played (or last played, in the menus).
const courtTheme = () => getCourtTheme(S.level + 1, save.data.settings.theme, S.look);

function openRules() {
  S.overlay = S.overlayKind = 'rules';
}

function closeRules() {
  S.overlay = false;
}

function turnRules(d) {
  S.rulesTab = (S.rulesTab + d + sections().length) % sections().length;
}

function closeSound() {
  S.overlay = false;
  save.commit();
}

function setSetting(key, v) {
  save.data.settings[key] = v;
  haptics.on = save.data.settings.haptics;
  audio.apply();
}

function toggleMute() {
  setSetting('muted', !save.data.settings.muted);
  save.commit();
}

// ---------------------------------------------------------------- update

function update(dt) {
  S.time += dt;
  S.t += dt;
  tickMultiplayer();

  if (S.leaving) {
    S.leaving.t += dt;
    if (S.leaving.t >= LEAVE) {
      const n = S.next;
      S.leaving = null;
      S.next = null;
      enter(n);
    }
  }

  if (S.camT < 1) {
    S.camT = Math.min(1, S.camT + dt / 0.9);
    S.cam = lerp(S.camFrom, S.camTo, easeInOut(S.camT));
  }
  const step = (v, on, rate) => clamp(v + (on ? dt : -dt) * rate, 0, 1);
  S.overlayT = step(S.overlayT, S.overlay, 4);
  S.gameVis = step(S.gameVis, GAME_SCREENS.has(S.screen), 4);
  S.landing = step(S.landing, (S.next || S.screen) === 'title' || S.screen === 'loading', 1.6);
  S.titleVis = step(S.titleVis, S.screen === 'title' && !S.leaving, S.screen === 'title' ? 1.5 : 3.5);
  if (S.eraseArmed > 0) S.eraseArmed -= dt;

  if (S.screen === 'loading' && S.ready && S.t > 1.5) go(S.bootTo || 'title');
  // Ask about the typed name once typing pauses.
  if (S.screen === 'name' && S.run && !S.run.saved && S.nameCheck.name !== typedName() && S.time - S.typedAt > 0.4) checkName();
  if (S.screen === 'intro' && S.t > 2.6 && !S.leaving) afterIntro();

  const g = S.game;
  if (g && !GAME_SCREENS.has(S.next || S.screen) && S.gameVis <= 0) S.game = null;

  // Camera truck: follows the paddle in play, idles gently in the menus.
  const inPlay = g && (S.screen === 'play' || S.screen === 'countdown');
  const want = inPlay ? (g.paddle.x - 100) * 0.22 : Math.sin(S.time * 0.25) * 7;
  S.shift += (want - S.shift) * Math.min(1, dt * 3);
  if (!g) return;

  const frozen = S.overlay || S.screen === 'paused' || S.next === 'paused';
  if (frozen) return;
  const steer = S.screen === 'play' || S.screen === 'countdown';
  // The last brick goes in slow motion for a moment.
  const slow = S.cheer && S.time - S.cheer.at < 0.35 ? 0.6 : 1; // a short, gentle slow-down at the finish
  g.update(dt * slow, steer ? (S.right ? 1 : 0) - (S.left ? 1 : 0) : 0);

  if (S.screen === 'countdown' && !S.leaving) {
    S.count -= dt;
    const n = Math.ceil(S.count / BEAT);
    if (n !== S.beat && n > 0) {
      S.beat = n;
      audio.sfx('count');
      haptics.play('count');
    }
    if (S.count <= 0 && g.ready) {
      S.screen = 'play';
      S.t = 0;
      audio.sfx('go');
      haptics.play('go');
      if (S.mpGame) onPlayStarted();
      // A first-timer serves by hand, once they have found the paddle.
      if (!(S.coach && S.coach.step === 'move')) g.launch();
    }
  }

  const c = S.coach;
  if (c && S.screen === 'play') {
    c.t += dt;
    if (c.lastX !== null) c.moved += Math.abs(g.paddle.x - c.lastX);
    c.lastX = g.paddle.x;
    if (c.step === 'move' && c.moved > 40) (c.step = 'serve'), (c.t = 0);
    if ((c.step === 'break' && c.t > 4) || (c.step === 'tool' && c.t > 7) || (c.step === 'caught' && c.t > 2.5)) c.step = 'idle';
  }

  trackPlace(dt);

  if (S.ending > 0 && S.screen === 'play') {
    S.ending -= dt;
    if (S.ending <= 0) {
      S.ending = 0;
      // A won court rolls straight on into the next one; the countdown
      // shows how it went. Only the last court stops on Rally Complete.
      if (S.result.won && S.result.hasNext) {
        S.cleared = { court: S.level + 1, stars: S.result.stars, score: S.result.score, newBest: S.result.newBest };
        if (S.mpGame) onCourtCleared(S.level + 1);
        nextLevel();
      } else if (S.mpGame) onRunEnd(S.result.won);
      else if (S.result.won) go('complete');
      else {
        S.nameTitle = 'RALLY OVER';
        go('name');
      }
    }
  }
}

// ---- live place on the leaderboard ------------------------------------------
// While a run is on, its score is placed against the same board the
// Leaderboard screen shows. Passing someone pops a short "you beat" note.

function boardRows() {
  if (!onlineEnabled()) return save.data.leaderboard;
  return S.online.state === 'ok' || S.online.rows.length ? S.online.rows : null; // not loaded: no place yet
}

function trackPlace(dt) {
  if (S.mpGame) return; // a match has its own opponent, not the solo board
  const g = S.game;
  const rows = boardRows();
  if (!g || !S.run || !rows) return;
  const ahead = rows.filter((r) => r.score > g.score).length; // rows are best first
  const p = S.place;
  // A new or refreshed board only sets the starting point, without a note.
  if (!p || p.rows !== rows) {
    S.place = { rows, ahead, beat: '', t: 0 };
    return;
  }
  if (ahead < p.ahead) {
    const e = rows[ahead]; // the best entry just passed
    const mine = e.name === save.data.lastName;
    p.beat = mine && !rows.slice(0, ahead).some((r) => r.name === e.name) ? 'NEW PERSONAL BEST!' : 'YOU BEAT ' + e.name + '!';
    p.t = 2;
    audio.sfx('beat');
    haptics.play('power');
  }
  p.ahead = ahead;
  if (p.t > 0) p.t = Math.max(0, p.t - dt);
}


function drawPlace() {
  const p = S.place;
  const g = S.game;
  if (!p || !g) return;
  const n = p.ahead + 1;
  const label = n <= BOARD_SIZE ? ordinal(n) + ' PLACE' : p.rows[BOARD_SIZE - 1].score - g.score + 1 + ' TO TOP ' + BOARD_SIZE;
  const w = textW(label) + 12;
  const x = W - w - 5;
  const rows = hudRows();
  rrect(x - 1, rows.tag - 1, w + 2, 15, 5, PAL.ink);
  rrect(x, rows.tag, w, 13, 4, PAL.panel);
  text(label, x + 6, rows.tag + 3, n <= 3 ? PAL.yellow : PAL.cream);
  if (p.t > 0) {
    const msg = p.beat;
    const mw = textW(msg, 1, 1) + 18;
    const pop = p.t > 1.85 ? 2 : 0;
    const y = rows.toast - pop;
    ctx.globalAlpha = Math.min(1, p.t / 0.35);
    rrect(W / 2 - mw / 2 - 1, y - 1, mw + 2, 19, 6, PAL.ink);
    rrect(W / 2 - mw / 2, y, mw, 17, 5, PAL.yellow);
    text(msg, W / 2, y + 5, PAL.ink, { align: 'center', sp: 1 });
    ctx.globalAlpha = 1;
  }
}

// ---- Power Rush and the finish ----------------------------------------------
// Power Rush (the last quarter of a court): a banner when it starts, and a
// gold edge pulsing round the screen while it lasts. The finish (last brick):
// a white flash, fireworks of confetti and COURT CLEAR! popping in.

function drawRush(g) {
  if (!g.rush || g.state !== 'play') return;
  const t = S.time - (S.rushAt || -99);
  if (t < 0 || t > RUSH_LABEL) return;
  // A small POWER RUSH label slides in under the HUD and fades: no flashing.
  const a0 = ctx.globalAlpha;
  const y = Math.round(hudRows().toast + 18 - (1 - easeOut(clamp(t / 0.3, 0, 1))) * 6);
  const msg = 'POWER RUSH';
  const w = textW(msg, 1, 2) + 16;
  ctx.globalAlpha = a0 * clamp(t * 5, 0, 1) * clamp((RUSH_LABEL - t) * 2, 0, 1);
  rrect(W / 2 - w / 2, y, w, 13, 5, PAL.ink);
  text(msg, W / 2, y + 3, PAL.yellow, { align: 'center', sp: 2 });
  ctx.globalAlpha = a0;
}
const RUSH_LABEL = 1.6; // seconds the POWER RUSH label shows

const CHEER_COLORS = ['#f5e663', '#ffffff', '#ffbb22'];
const CHEER_LEN = 1.8; // seconds the court-clear moment lasts
const CHEER_PIECES = 28; // confetti pieces
function drawCheer() {
  if (!S.cheer) return;
  const t = S.time - S.cheer.at;
  if (t > CHEER_LEN) return;
  const a0 = ctx.globalAlpha;
  // A light fall of confetti from the top, drifting as it comes down.
  for (let i = 0; i < CHEER_PIECES; i++) {
    const r = (i * 0.618) % 1;
    const x = W * (0.08 + 0.84 * r) + Math.sin(t * 3 + i) * 6;
    const y = -6 + (36 + (i % 5) * 9) * t + ((i * 13) % 20);
    ctx.globalAlpha = a0 * clamp((CHEER_LEN - t) * 1.5, 0, 1);
    rect(x, y, Math.sin(t * 8 + i) > 0 ? 2 : 1, 2, CHEER_COLORS[i % CHEER_COLORS.length]);
  }
  // COURT CLEAR! settles in and fades.
  if (t > 0.15) {
    ctx.globalAlpha = a0 * clamp((t - 0.15) * 4, 0, 1) * clamp((CHEER_LEN - t) * 2, 0, 1);
    const y = Math.round(H * 0.42 - (1 - easeOut(clamp((t - 0.15) / 0.4, 0, 1))) * 8);
    blockTitle('COURT CLEAR!', W / 2, y, 2);
  }
  ctx.globalAlpha = a0;
}

// ---------------------------------------------------------------- screens

const PYRAMID = [
  ['T', 'H', 'L', 'S'],
  ['H', 'H', 'L'],
  ['T', 'L'],
];

function drawPyramid(vis) {
  const base = P.wb + 46;
  drawShadow(W / 2, base + 1, 50, 4, 0.3 * vis);
  let i = 0;
  PYRAMID.forEach((row, r) => {
    const bw = 23;
    const x0 = Math.round(W / 2 - (row.length * bw) / 2);
    row.forEach((type, c) => {
      const k = clamp(vis * 2 - i * 0.09, 0, 1);
      i++;
      if (k <= 0) return;
      const lift = Math.round((1 - easeOut(k)) * 70);
      const h = type === 'S' ? 7 : 12;
      const yn = base - r * 13 - lift;
      const xl = x0 + c * bw;
      ctx.globalAlpha = Math.min(1, k * 2);
      drawBlock(xl, xl + bw - 1, yn, xl + 1, xl + bw - 2, yn - 5, h, h, type, 1000 + i * 7919);
      ctx.globalAlpha = 1;
    });
  });

  // A tennis ball resting on top, glinting now and then.
  const k = clamp(vis * 2 - 1, 0, 1);
  if (k <= 0) return;
  const cx = Math.round(W / 2) - 1;
  const cy = base - 49 - Math.round((1 - easeOut(k)) * 60);
  ctx.globalAlpha = Math.min(1, k * 2);
  drawBall(cx, cy, 7);
  for (const [dx, dy] of [[-4, -4], [-3, -2], [-3, 0], [-3, 2], [-4, 4], [4, -4], [3, -2], [3, 0], [3, 2], [4, 4]]) rect(cx + dx, cy + dy, 1, 1, '#f6ffa6');
  ctx.globalAlpha = 1;
  if (k >= 1) {
    [[-11, -6], [10, -8], [-8, -11], [12, -1], [0, -13], [-13, 1]].forEach(([dx, dy], n) => {
      const tw = Math.sin(S.time * 2.4 + n * 1.9);
      if (tw > 0.55) rect(cx + dx, cy + dy, 1, 1, tw > 0.9 ? '#ffffff' : PAL.cream);
    });
  }
}

// The ball rallying between two rackets under the title: an arc each way,
// a trail behind it, a hit sound and a spray of sparks on each racket.
function drawIntroRally(t, k, cy) {
  const reach = Math.min(70, W / 2 - 30);
  const lx = W / 2 - reach;
  const rx = W / 2 + reach;
  const leg = 0.55; // seconds from one racket to the other
  const i = Math.floor(t / leg);
  const u = (t % leg) / leg;
  const from = i % 2 ? rx : lx;
  const to = i % 2 ? lx : rx;
  const at = (v) => ({ x: lerp(from, to, v) + (to > from ? -8 : 8) * (1 - 2 * v), y: cy - 4 - Math.sin(v * Math.PI) * 26 });
  if (i !== S.introHit) {
    S.introHit = i;
    if (i > 0) audio.sfx('paddle');
  }
  ctx.globalAlpha = k;
  racket(lx - 6, cy, 1);
  racket(rx + 6, cy, -1);
  // The trail, then the ball and its shadow on the grass.
  for (let v = Math.max(0, u - 0.35); v < u; v += 0.05) {
    const p = at(v);
    ctx.globalAlpha = k * (0.2 + 0.7 * (1 - (u - v) / 0.35));
    rect(p.x, p.y, 2, 2, PAL.yellow);
  }
  ctx.globalAlpha = k;
  const p = at(u);
  drawShadow(p.x, cy + 10, 4, 1, 0.3);
  drawBall(p.x, p.y, 4);
  // Sparks just after each hit.
  if (u < 0.25 && i > 0) {
    const hx = from + (from < W / 2 ? 2 : -2);
    for (let s = 0; s < 6; s++) {
      const a = (s / 6) * Math.PI * 2;
      const r = 3 + u * 40;
      ctx.globalAlpha = k * (1 - u * 4);
      rect(hx + Math.cos(a) * r, cy - 4 + Math.sin(a) * r, 1, 1, s % 2 ? '#ffffff' : PAL.yellow);
    }
  }
  ctx.globalAlpha = 1;
}

// Leaderboard with nothing on it: a cup in a burst of light, laurels and rackets.
// The leaderboard's podium: the top three on numbered blocks (2, 1, 3 from
// the left), each under a cup on a plaque with the name and score. The
// winner's block is the tallest, its gold cup lit by rays and laurels.
function podium(x, y, w, board, mineAt, loading, compact) {
  const colW = Math.floor((w - 16) / 3);
  const metals = [METAL.gold, METAL.silver, METAL.bronze];
  const tw = Math.floor(S.time * 2) % 2;
  const base = y + (compact ? 42 : 106); // the floor all three blocks stand on
  [1, 0, 2].forEach((rank, col) => {
    const e = board[rank];
    if (!e && !loading) return;
    const m = metals[rank];
    const cx = Math.round(x + 8 + colW * col + colW / 2);
    const bw = colW - 4;
    const bh = compact ? (rank === 0 ? 12 : 8) : rank === 0 ? 28 : 21;
    const by = base - bh;
    const ph = compact ? 19 : 22;
    const py = by - ph - 1;
    if (!compact) {
      // Cups for all three, lit from behind for the winner, laurels around.
      const cupY = py - 36;
      const leaf = rank === 0 ? ['#c98a1c', '#f2b632'] : rank === 1 ? ['#5c7d9c', '#a8c4dc'] : ['#9c5a2e', '#d08a4e'];
      if (rank === 0) rays(cx, cupY + 12, 18, 28, S.time);
      laurel(cx - 1, cupY + 18, rank === 0 ? 27 : 23, -1, 5, leaf[0], leaf[1]);
      laurel(cx, cupY + 18, rank === 0 ? 27 : 23, 1, 5, leaf[0], leaf[1]);
      cup(cx, cupY, 2, m);
      sparkle(cx + (col === 0 ? -22 : 22), cupY - 2, 1 + tw, rank === 0 ? PAL.yellowHi : '#f4f8fa');
      if (rank === 0) sparkle(cx + 1, cupY - 9, 2 - tw, '#fff3c4');
    }
    // Plaque: name and score, outlined in gold if it is the player's.
    const mine = rank === mineAt;
    rrect(cx - bw / 2 - 1, py - 1, bw + 2, ph + 2, 3, mine ? PAL.yellow : m.o);
    rrect(cx - bw / 2, py, bw, ph, 2, m.l);
    text(e ? e.name : '...', cx, py + (compact ? 2 : 3), PAL.ink, { align: 'center', sp: e && e.name.length > 6 ? 0 : 1 });
    text(e ? String(e.score) : '', cx, py + (compact ? 11 : 13), PAL.ink, { align: 'center', sp: 1 });
    // Block with its number on a raised plate.
    rrect(cx - bw / 2 - 2, by - 1, bw + 4, bh + 2, 3, m.o);
    rrect(cx - bw / 2 - 1, by, bw + 2, bh, 2, m.d);
    rect(cx - bw / 2 + 1, by, bw - 2, 1, m.l);
    rect(cx - bw / 2 + 1, by + bh - 2, bw - 2, 1, m.o);
    const plate = !compact;
    const sc = plate ? 2 : 1;
    if (plate) {
      rrect(cx - 9, by + 3, 18, bh - 6, 4, m.o);
      rrect(cx - 8, by + 4, 16, bh - 8, 3, m.g);
    }
    text(String(rank + 1), cx + 1, by + Math.round((bh - 7 * sc) / 2), PAL.ink, { align: 'center', scale: sc });
  });
}

function emptyBoard(mid, online, sc) {
  const cx = Math.round(W / 2);
  const cy = mid - Math.round((17 * sc + 75) / 2);
  const tw = Math.floor(S.time * 2) % 2;
  rays(cx, cy + 6 * sc, 11 * sc, 18 * sc, S.time);
  laurel(cx - 1, cy + 9 * sc, 16 * sc, -1, sc + 4);
  laurel(cx, cy + 9 * sc, 16 * sc, 1, sc + 4);
  cup(cx, cy, sc);
  sparkle(cx - 18 * sc, cy - 2, 1 + tw, '#ff9a4a');
  sparkle(cx + 17 * sc, cy - 3, 2 - tw);
  sparkle(cx - 21 * sc, cy + 9 * sc, 2 - tw);
  sparkle(cx + 20 * sc, cy + 8 * sc, 1 + tw);
  sparkle(cx + 18 * sc, cy + 15 * sc, 1, '#ff6fa8');
  sparkle(cx - 17 * sc, cy + 16 * sc, 1, '#ff6fa8');
  // "NO SCORES YET", the last word in gold, between red dashes.
  const a = 'NO SCORES ';
  const ww = textW(a + 'YET', 2, 1);
  const tx = cx - Math.round(ww / 2);
  const ty = cy + 17 * sc + 10;
  text(a, tx, ty, PAL.cream, { scale: 2 });
  text('YET', tx + textW(a, 2, 1), ty, PAL.yellow, { scale: 2 });
  const red = '#e0505a';
  const lx = tx - 10;
  const rx = tx + ww + 4;
  line(lx, ty + 1, lx + 5, ty + 3, red);
  line(lx, ty + 12, lx + 5, ty + 10, red);
  rect(lx, ty + 6, 6, 1, red);
  line(rx, ty + 3, rx + 5, ty + 1, red);
  line(rx, ty + 10, rx + 5, ty + 12, red);
  rect(rx, ty + 6, 6, 1, red);
  text(online ? 'THE ONLINE BOARD IS EMPTY' : 'FINISH A RALLY TO ADD YOURS', cx, ty + 20, '#6f9a7a', { align: 'center' });
  // Crossed rackets and a ball, between purple dashes.
  const ry = ty + 46;
  racket(cx - 8, ry, -1);
  racket(cx + 8, ry, 1);
  disc(cx, ry - 10, 3, '#8fb83a');
  disc(cx, ry - 10, 2, '#c6e04a');
  rect(cx - 1, ry - 11, 1, 1, '#eef7b0');
  for (const d of [-1, 1]) {
    rect(cx + d * 22 - (d < 0 ? 22 : 0), ry + 7, 22, 1, '#7d5bd6');
    rect(cx + d * 26 - (d < 0 ? 10 : 0), ry + 11, 10, 1, '#5b4bb0');
    sparkle(cx + d * 36, ry - 3, 1, d < 0 ? PAL.yellow : '#ff6fa8');
  }
}

// The purple strip above the buttons: what this board is, or how sending went.
function infoBox(x, y, w, online, tabs, min = 0) {
  const post = S.board.fromRun && tabs ? S.post.state : 'idle';
  const [title, line2] = {
    sending: ['SENDING YOUR SCORE', 'TO THE ONLINE BOARD...'],
    sent: ['SAVED ONLINE TOO', 'YOUR SCORE IS ON THE BOARD'],
    error: ['NOT SENT ONLINE', 'TAP HERE TO RETRY'],
  }[post] || (online ? ['ONLINE LEADERBOARD', 'TOP PLAYERS WORLDWIDE'] : ['THIS DEVICE', 'YOUR BEST RUNS, KEPT HERE']);
  const hot = post === 'error' && (ui.hover === 'retrypost' || ui.pressed === 'retrypost');
  // min 0..1: full (two lines, globe) shrinking to one slim line once the list is scrolled.
  const h = Math.round(lerp(34, 16, min));
  rrect(x, y, w, h, 5, hot ? PAL.yellow : '#2f5a40');
  rrect(x + 1, y + 1, w - 2, h - 2, 4, '#0b1d14');
  const a0 = ctx.globalAlpha;
  if (min < 0.5) {
    ctx.globalAlpha = a0 * (1 - min * 2);
    if (online || post !== 'idle') globe(x + 8, y + 11);
    else trophy(x + 9, y + 12);
    text(title, x + 28, y + 8, PAL.yellow, { sp: 1 });
    text(line2, x + 28, y + 20, PAL.cream);
    const tw = Math.floor(S.time * 2) % 2;
    sparkle(x + w - 10, y + 9, 1 + tw);
    sparkle(x + w - 14, y + 24, 2 - tw);
  } else {
    ctx.globalAlpha = a0 * (min - 0.5) * 2;
    rect(x + 8, y + h / 2 - 1, 3, 3, online || post !== 'idle' ? '#2f6fd6' : PAL.yellow);
    text(title, x + 16, y + Math.round(h / 2) - 3, PAL.yellow, { sp: 1 });
  }
  ctx.globalAlpha = a0;
  if (post === 'error') region('retrypost', x, y, w, h, postScore);
}

// One of these shows under the loading bar, a different one each visit.
const LOADING_TIPS = [
  'TIP: WHERE THE BALL HITS THE PADDLE SETS ITS ANGLE.',
  'TIP: BREAK BLOCKS IN A ROW FOR A COMBO, UP TO X3.',
  'TIP: EVERY BALL LEFT WHEN A COURT IS CLEARED IS WORTH 100.',
  'TIP: SLATE TAKES THREE HITS. SMASH GOES STRAIGHT THROUGH IT.',
  'TIP: LIVES CARRY OVER BETWEEN COURTS.',
];

const SCREENS = {
  ...MP_SCREENS,
  loading(k) {
    // A pixel bar that fills while the game gets ready (it only reaches the
    // end once the save is read and the court is built), and a tip to read.
    const cy = Math.round(P.wb + (H - P.wb) * 0.36);
    ctx.globalAlpha = k;
    text('PREPARING THE COURT', W / 2 + 2, cy, PAL.white, { align: 'center', sp: 2, shadow: PAL.ink });
    const bw = Math.min(150, W - 60);
    const bx = Math.round(W / 2 - bw / 2);
    const p = S.ready ? clamp(S.t / 1.2, 0, 1) : clamp(S.t / 1.2, 0, 0.85);
    rrect(bx - 2, cy + 14, bw + 4, 11, 4, PAL.ink);
    rrect(bx - 1, cy + 15, bw + 2, 9, 3, '#5f7a64');
    rect(bx, cy + 16, bw, 7, '#0d1f16');
    const fill = Math.round(bw * p);
    rect(bx, cy + 16, fill, 7, PAL.yellow);
    rect(bx, cy + 16, fill, 1, PAL.yellowHi);
    for (let gx = bx + 4; gx < bx + fill; gx += 6) rect(gx, cy + 17, 2, 5, PAL.yellowLo); // segments
    const tip = LOADING_TIPS[S.tip % LOADING_TIPS.length];
    wrap(tip, Math.min(200, W - 24)).forEach((l, i) => text(l, W / 2, cy + 36 + i * 10, PAL.cream, { align: 'center', shadow: PAL.ink }));
    ctx.globalAlpha = 1;
  },

  title(k) {
    const wb = P.wb;
    const top = Math.max(Math.round(wb * 0.16), Math.min(Math.round(H * 0.24), wb - 176)) - Math.round((1 - k) * 10);
    ctx.globalAlpha = k;
    // Title idle loop, every 4.5s: a wave lifts the letters one after another,
    // then a glint sweeps across them and along the underline.
    const cyc = S.time % 4.5;
    const words = [
      { str: 'THE', x: W / 2 + 3, y: top, size: 15, sp: 5, lift: 1 },
      { str: 'COURT', x: W / 2 + 2, y: top + 20, size: 40, sp: 3, lift: 3 },
    ];
    const drawTitle = (color, shadow) => {
      let n = 0;
      for (const wd of words) {
        let x = Math.round(wd.x - serifW(wd.str, wd.size, wd.sp) / 2);
        for (const ch of wd.str) {
          const ph = (cyc - n * 0.11) / 0.45; // each letter starts a beat after the last
          const up = ph > 0 && ph < 1 ? Math.round(Math.sin(ph * Math.PI) * wd.lift) : 0;
          serif(ch, x, wd.y - up, wd.size, color, { shadow });
          x += serifW(ch, wd.size) + wd.sp;
          n++;
        }
      }
    };
    drawTitle(PAL.cream, '#7a2420'); // cream letters on a deep red shadow
    rect(W / 2 - 22, top + 58, 44, 1, PAL.cream);
    const sweep = (cyc - 1.5) / 1.2;
    if (sweep > 0 && sweep < 1) {
      const tw = serifW('COURT', 40, 3);
      const bx = W / 2 + 2 - tw / 2 - 20 + sweep * (tw + 40);
      ctx.save();
      ctx.beginPath();
      for (let r = 0; r < 60; r++) {
        const rx = Math.round(bx - r * 0.5);
        ctx.rect(rx, top - 6 + r, 6, 1);
        if (r & 1) ctx.rect(rx + 8, top - 6 + r, 2, 1);
      }
      ctx.clip();
      drawTitle('#ffffff', null);
      ctx.restore();
      rect(W / 2 - 22 + Math.round(sweep * 40), top + 58, 4, 1, '#ffffff');
    }
    // A four-point sparkle pops on the last letter as the glint leaves.
    const sp = (cyc - 2.6) / 0.5;
    if (sp > 0 && sp < 1) {
      const sx = Math.round(W / 2 + 2 + serifW('COURT', 40, 3) / 2) - 3;
      const sy = top + 22;
      const arm = sp < 0.5 ? 2 : 1;
      rect(sx - arm, sy, arm * 2 + 1, 1, '#ffffff');
      rect(sx, sy - arm, 1, arm * 2 + 1, '#ffffff');
    }
    // Two ways in, as cards: The Rally (solo, as always) and Multiplayer; under
    // them Courts, Scores and Sound. Wide screens set the cards side by side;
    // short ones bring everything up over the brick pyramid.
    const L = titleLayout();
    const lift = Math.round((1 - k) * 8);
    card('play', 'THE RALLY', null, L.a.x, L.a.y + lift, L.cw, L.ch, play, { t: S.time, art: cardArt.ball });
    card('multiplayer', 'MULTIPLAYER', null, L.b.x, L.b.y + lift, L.cw, L.ch, openMultiplayer, { style: 'dark', t: S.time + 1.2, art: cardArt.rackets });
    const bw = L.bw;
    const scores = () => {
      S.board = { rank: -1, fromRun: false };
      go('scores');
    };
    // Phones: square tiles (icon over label); wide screens: icon beside label.
    const row = [['courts', 'COURTS', 'bricks', () => go('courts')], ['scores', 'SCORES', 'trophy', scores], ['sound', 'SOUND', 'sound', openSound]];
    row.forEach(([id, label, ic, fn], i) => {
      const cx = L.row.x + bw * (i + 0.5) + i * 5;
      if (L.tiles) tile(id, label, ic, cx, L.row.y + lift, bw, L.rh, fn);
      else ghost(id, label, cx, L.row.y + lift, bw, 17, fn, { sp: 1, icon: ic });
    });
    drawSignature(k);
    ctx.globalAlpha = 1;
    S.primary = play;
  },

  intro(k) {
    // ELEVATED / RALLY: the letters drop in one by one with a little bounce,
    // then a line draws under them, while a ball rallies between two rackets.
    ctx.globalAlpha = k;
    const y = Math.round(P.wb * 0.42);
    let n = 0;
    for (const [word, wy] of [['ELEVATED', y], ['RALLY', y + 20]]) {
      const ww = serifW(word, 15, 3);
      let x = W / 2 - ww / 2;
      for (const ch of word) {
        const q = clamp((S.t - 0.1 - n * 0.06) / 0.3, 0, 1);
        n++;
        if (q > 0) {
          ctx.globalAlpha = k * Math.min(1, q * 2);
          serif(ch, x, wy - Math.round((1 - easeBack(q)) * 14), 15, PAL.cream, { sp: 3, shadow: PAL.ink });
        }
        x += serifW(ch, 15, 0) + 3;
      }
    }
    ctx.globalAlpha = k;
    const line = clamp((S.t - 0.9) / 0.4, 0, 1);
    rect(Math.round(W / 2 - 20 * line), y + 40, Math.round(40 * line), 1, PAL.yellow);
    ctx.globalAlpha = 1;
    drawIntroRally(S.t, k, y + 74);
    const skip = afterIntro;
    region('skip', 0, 0, W, H, skip);
    S.primary = skip;
    S.back = () => go('title');
  },

  courts(k) {
    const w = 228;
    const h = 292;
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2);
    const unlocked = save.data.progress.unlocked;
    const current = Math.min(unlocked, LEVELS.length) - 1; // the court to play next
    const pages = Math.ceil(LEVELS.length / PER_PAGE);
    const back = () => go('title');
    const turn = (d) => (S.page = clamp(S.page + d, 0, pages - 1));
    panel(k, x, y, w, h, 'dark', () => {
      // Heading with rackets and sparkles.
      blockTitle('COURTS', W / 2, y + 12, 3);
      racket(W / 2 - 74, y + 19, 1);
      racket(W / 2 + 74, y + 19, -1);
      const tw = Math.floor(S.time * 2) % 2;
      sparkle(W / 2 - 92, y + 14, 1 + tw);
      sparkle(W / 2 - 97, y + 26, 2 - tw);
      sparkle(W / 2 + 92, y + 14, 2 - tw);
      sparkle(W / 2 + 97, y + 26, 1 + tw);

      // Page row: arrows either side of the range.
      const first = S.page * PER_PAGE;
      const last = Math.min(LEVELS.length, first + PER_PAGE);
      const py = y + 40;
      text(first + 1 + ' - ' + last + ' OF ' + LEVELS.length, W / 2, py + 3, '#9fb7a2', { align: 'center', sp: 2 });
      const arrow = (id, name, cx, on, fn) => {
        const hot = on && (ui.hover === id || ui.pressed === id);
        rrect(cx - 15, py - 1, 30, 15, 5, on ? (id === 'nextpage' ? PAL.ink : PAL.cream) : '#2a4a38');
        rrect(cx - 14, py, 28, 13, 4, on && id === 'nextpage' ? (hot ? PAL.yellowHi : PAL.yellow) : hot ? PAL.panelHi : PAL.panel);
        icon(name, cx - 5, py + 1, on ? (id === 'nextpage' ? PAL.ink : PAL.cream) : '#2a4a38');
        if (on) region(id, cx - 18, py - 4, 36, 21, fn);
      };
      arrow('prev', 'back', W / 2 - 62, S.page > 0, () => turn(-1));
      arrow('nextpage', 'fwd', W / 2 + 62, S.page < pages - 1, () => turn(1));
      rect(x + 10, y + 59, w - 20, 1, '#1f4630');

      // 4 x 5 grid of court tiles.
      for (let i = first; i < last; i++) {
        const cx = x + 9 + ((i - first) % 4) * 53;
        const cy = y + 64 + Math.floor((i - first) / 4) * 38;
        const open = i < unlocked;
        const id = 'court' + i;
        const hot = open && (ui.hover === id || ui.pressed === id);
        const now = i === current;
        rrect(cx, cy, 51, 35, 4, now ? PAL.yellow : hot ? PAL.cream : open ? '#2f6b47' : '#1a3a2a');
        rrect(cx + 1, cy + 1, 49, 33, 3, open ? '#143424' : '#0f2318');
        if (now) {
          // The next court to play gets a dusk sky.
          rect(cx + 2, cy + 2, 47, 8, '#4a3560');
          rect(cx + 2, cy + 10, 47, 8, '#7d4668');
          rect(cx + 2, cy + 18, 47, 5, '#b85a5e');
        }
        if (open) {
          // A faint treeline along the bottom of each tile.
          const dark = now ? '#1a2a22' : '#0f2a1c';
          rect(cx + 2, cy + 23, 47, 10, dark);
          for (let t = 0; t < 6; t++) {
            const tx = cx + 5 + ((t * 9 + i * 7) % 43);
            const th = 3 + ((t * 5 + i * 3) % 5);
            rect(tx, cy + 23 - th, 3, th, dark);
            rect(tx + 1, cy + 22 - th, 1, 1, dark);
          }
        }
        serif(String(i + 1), cx + 26, cy + 5, 14, open ? PAL.cream : '#3f5545', { align: 'center', shadow: open ? PAL.ink : null });
        if (!open) {
          icon('lock', cx + 20, cy + 20, '#3f5545');
          continue;
        }
        const rec = save.data.progress.levels[LEVELS[i].id];
        for (let st = 0; st < 3; st++) icon('star', cx + 9 + st * 11, cy + 22, rec && st < rec.stars ? '#f2b632' : '#2c5a40');
        region(id, cx, cy, 51, 35, () => {
          S.level = i;
          go('tools');
        });
      }
      rect(x + 10, y + h - 37, w - 20, 1, '#1f4630');

      // Leaderboard, rules and sound live here so the landing screen can stay bare.
      const by = y + h - 30;
      ghost('scores', 'SCORES', x + 34, by, 53, 17, () => {
        S.board = { rank: -1, fromRun: false };
        go('scores');
      }, { sp: 0, icon: 'trophy' });
      ghost('rules', 'RULES', x + 89, by, 51, 17, openRules, { sp: 0, icon: 'list' });
      ghost('sound', 'SOUND', x + 142, by, 51, 17, openSound, { sp: 0, icon: 'sound' });
      ghost('back', 'BACK', x + 194, by, 49, 17, back, { sp: 0, icon: 'back' });
    });
    S.back = back;
    S.primary = () => {
      S.level = current;
      go('tools');
    };
  },

  tools(k) {
    const w = 204;
    const h = 214;
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2);
    const begin = () => beginRun(S.level);
    const back = () => go('courts');
    panel(k, x, y, w, h, 'dark', () => {
      serif('TOOLS', W / 2 + 3, y + 14, 16, PAL.cream, { align: 'center', sp: 5 });
      rect(W / 2 - 12, y + 32, 24, 1, PAL.cream);
      TOOLS.forEach((t, i) => {
        const cx = x + 38 + (i % 3) * 64;
        const cy = y + 58 + Math.floor(i / 3) * 52;
        const sel = S.tool === i;
        const id = 'tool' + i;
        disc(cx, cy, 17, sel || ui.hover === id ? PAL.yellow : PAL.cream);
        disc(cx, cy, 16, PAL.panel);
        if (sel) disc(cx, cy, 14, PAL.panelHi);
        icon(t.id, cx - 11, cy - 11, PAL.yellow, 2);
        text(t.name, cx, cy + 22, sel ? PAL.yellow : PAL.cream, { align: 'center', sp: t.name.length > 9 ? 0 : 1 });
        region(id, cx - 24, cy - 20, 48, 50, () => (S.tool = i));
      });
      const t = TOOLS[S.tool];
      text(t.desc[0], W / 2, y + 144, PAL.dim, { align: 'center' });
      text(t.desc[1], W / 2, y + 154, PAL.dim, { align: 'center' });
      pill('begin', 'BEGIN', W / 2 + 22, y + h - 40, 112, 21, begin, { scale: 2, sp: 3 });
      ghost('back', 'BACK', x + 36, y + h - 36, 44, 15, back);
    });
    S.primary = begin;
    S.back = back;
  },

  countdown(k) {
    const n = Math.min(3, Math.max(1, Math.ceil(S.count / BEAT)));
    const f = S.count > BEAT * 3 ? 0.5 : 1 - (S.count / BEAT - (n - 1)); // 0..1 within this beat
    const size = f < 0.12 ? 64 : 54;
    const cy = Math.round(proj(0, 186).y) - 8;
    ctx.globalAlpha = k * (f > 0.85 ? 0.5 : 1);
    serif(String(n), W / 2, cy - Math.round(size * 0.35), size, PAL.cream, { align: 'center', shadow: PAL.ink });
    ctx.globalAlpha = k;
    // Long court names close up their letters on a narrow screen.
    const nm = LEVELS[S.level].name;
    text(nm, W / 2, 34, PAL.white, { align: 'center', sp: textW(nm, 1, 3) > W - 24 ? 1 : 3, shadow: PAL.ink });
    const c = S.cleared;
    if (c) {
      // How the court just won went: no button, it fades with the countdown.
      const w = 150;
      const y = hudRows().note;
      rrect(W / 2 - w / 2 - 1, y - 1, w + 2, 47, 6, PAL.ink);
      rrect(W / 2 - w / 2, y, w, 45, 5, PAL.panel);
      text('COURT ' + c.court + ' COMPLETE', W / 2, y + 6, PAL.cream, { align: 'center', sp: 1 });
      for (let s = 0; s < 3; s++) {
        const lit = s < c.stars && S.t > 0.25 + s * 0.2;
        icon('star', W / 2 - 22 + s * 17, y + 17, lit ? '#d9a514' : '#4a5a4e', 1);
      }
      text((c.newBest ? 'NEW BEST ' : 'SCORE ') + c.score, W / 2, y + 33, c.newBest ? PAL.yellow : PAL.dim, { align: 'center' });
    }
    ctx.globalAlpha = 1;
    iconBtn('pause', 'pause', W - 23, 7, null);
    S.back = S.mpGame
      ? null
      : () => {
          quitRun();
          go('title');
        };
  },

  play() {
    iconBtn('pause', 'pause', W - 23, 7, pause);
    const g = S.game;
    if (g && S.coach) {
      // Guided first rally: one short hint at a time, above the paddle.
      const p = proj(g.paddle.x, g.paddle.y);
      const msg = !S.ending && coachText();
      if (msg) {
        const w = textW(msg) + 16;
        const y = Math.round(p.y) - 58;
        rrect(W / 2 - w / 2 - 1, y - 1, w + 2, 17, 5, PAL.ink);
        rrect(W / 2 - w / 2, y, w, 15, 4, PAL.panel);
        text(msg, W / 2, y + 4, PAL.cream, { align: 'center' });
      }
      if (S.coach.step === 'move') {
        const hw = (g.paddle.w / 2) * p.s;
        const bob = Math.floor(S.time * 3) % 2;
        text('<', p.x - hw - 10 - bob, p.y - 9, PAL.yellow, { align: 'center', shadow: PAL.ink });
        text('>', p.x + hw + 10 + bob, p.y - 9, PAL.yellow, { align: 'center', shadow: PAL.ink });
      }
      ghost('skiptips', 'SKIP TIPS', W - 36, 32, 60, 13, endCoach);
    } else if (g && g.state === 'serve' && Math.floor(S.time * 2.5) % 3 !== 0) {
      const p = proj(g.paddle.x, g.paddle.y);
      text(S.touch ? 'TAP TO SERVE' : 'CLICK OR SPACE TO SERVE', W / 2, p.y - 46, PAL.white, { align: 'center', shadow: PAL.ink });
    }
    S.primary = () => g && g.launch();
    S.back = pause;
  },

  paused(k) {
    const w = 150;
    const resume = () => go('play');
    if (S.mpGame) {
      // In a match only this player's game pauses; the opponent plays on.
      const h = 128;
      const x = Math.round((W - w) / 2);
      const y = Math.round((H - h) / 2);
      panel(k, x, y, w, h, 'dark', () => {
        serif('PAUSED', W / 2 + 2, y + 15, 16, PAL.cream, { align: 'center', sp: 4 });
        rect(W / 2 - 12, y + 33, 24, 1, PAL.cream);
        pill('resume', 'RESUME', W / 2, y + 46, 104, 19, resume);
        ghost('sound', 'SOUND', W / 2, y + 76, 104, 15, openSound);
        ghost('mpleave', 'LEAVE MATCH', W / 2, y + 97, 104, 15, leaveMatch);
      });
      S.primary = resume;
      S.back = resume;
      return;
    }
    const h = 192;
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2);
    panel(k, x, y, w, h, 'dark', () => {
      serif('PAUSED', W / 2 + 2, y + 15, 16, PAL.cream, { align: 'center', sp: 4 });
      rect(W / 2 - 12, y + 33, 24, 1, PAL.cream);
      pill('resume', 'RESUME', W / 2, y + 46, 104, 19, resume);
      ghost('restart', 'RESTART', W / 2, y + 76, 104, 15, () => beginRun(S.level));
      ghost('sound', 'SOUND', W / 2, y + 97, 104, 15, openSound);
      ghost('theme', 'THEME', W / 2, y + 118, 104, 15, openTheme);
      ghost('rules', 'HOW TO PLAY', W / 2, y + 139, 104, 15, openRules);
      ghost('home', 'HOME', W / 2, y + 160, 104, 15, () => {
        quitRun();
        endRun('RALLY ENDED');
      });
    });
    S.primary = resume;
    S.back = resume;
  },

  complete(k) {
    const r = S.result;
    if (!r) return;
    const w = 184;
    const h = 188;
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2) - 4;
    const replay = () => beginRun(S.level);
    const home = () => endRun('WELL PLAYED');
    panel(k, x, y, w, h, 'cream', () => {
      serif('RALLY', W / 2 + 1, y + 14, 22, PAL.ink, { align: 'center', sp: 2 });
      serif('COMPLETE', W / 2 + 1, y + 36, 22, PAL.ink, { align: 'center', sp: 1 });
      rect(W / 2 - 16, y + 59, 32, 1, PAL.ink);
      for (let s = 0; s < 3; s++) {
        const lit = s < r.stars && S.t > 0.45 + s * 0.22;
        icon('star', W / 2 - 34 + s * 24, y + 64, lit ? '#d9a514' : PAL.creamLo, 2);
      }
      text('SCORE ' + r.score, W / 2, y + 90, PAL.ink, { align: 'center', sp: 2 });
      text(r.newBest ? 'NEW BEST!' : 'BEST ' + r.best, W / 2, y + 101, r.newBest ? '#b3541e' : '#7d7354', { align: 'center' });
      text('RUN TOTAL ' + r.run + '   LIVES LEFT ' + r.lives, W / 2, y + 112, '#7d7354', { align: 'center' });
      const xs = r.hasNext ? [-54, 0, 54] : [-30, 30];
      roundBtn('replay', 'replay', 'REPLAY', W / 2 + xs[0], y + 144, replay);
      roundBtn('home', 'home', 'HOME', W / 2 + xs[1], y + 144, home);
      if (r.hasNext) roundBtn('next', 'next', 'NEXT', W / 2 + xs[2], y + 144, nextLevel);
    });
    S.primary = r.hasNext ? nextLevel : home;
    S.back = home;
  },

  // End of a run: enter a name for the leaderboard.
  name(k) {
    const run = S.run;
    if (!run) return;
    const scored = run.score > 0;
    const w = 206;
    const h = scored ? 219 : 150;
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2) - 2;
    const retry = () => beginRun(S.level);
    const skip = () => {
      S.board = { rank: -1, fromRun: true };
      go('scores');
    };
    panel(k, x, y, w, h, 'cream', () => {
      // The title moves left just enough to clear the close button.
      const tx = scored ? Math.min(W / 2 + 1, x + w - 30 - serifW(S.nameTitle, 20, 1) / 2) : W / 2 + 1;
      serif(S.nameTitle, tx, y + 13, 20, PAL.ink, { align: 'center', sp: 1 });
      text('SCORE ' + run.score + '   COURT ' + (S.level + 1), W / 2, y + 37, PAL.ink, { align: 'center', sp: 1 });
      if (!scored) {
        text('NO POINTS THIS TIME', W / 2, y + 52, '#7d7354', { align: 'center' });
        roundBtn('retry', 'replay', 'RETRY', W / 2 - 30, y + 96, retry);
        roundBtn('home', 'home', 'HOME', W / 2 + 30, y + 96, () => go('title'));
        return;
      }
      iconBtn('close', 'close', x + w - 23, y + 7, skip); // leave without saving
      // What the board says about the typed name.
      const nc = S.nameCheck.name === typedName() ? S.nameCheck.state : 'idle';
      const msg = { checking: 'CHECKING NAME...', free: 'NAME AVAILABLE', taken: 'NAME TAKEN - TRY ANOTHER' }[nc] || 'YOUR NAME FOR THE LEADERBOARD';
      const col = nc === 'taken' ? '#b3541e' : nc === 'free' ? '#3f7d38' : '#7d7354';
      const shake = nc === 'taken' && S.time - S.nameCheck.at < 0.3 ? Math.round(Math.sin(S.time * 60) * 2) : 0;
      text(msg, W / 2 + shake, y + 49, col, { align: 'center' });
      rect(W / 2 - 58, y + 60, 116, 21, PAL.ink);
      rect(W / 2 - 57, y + 61, 114, 19, PAL.panel);
      const shown = S.name + (S.name.length < 8 && Math.floor(S.time * 2.5) % 2 ? '_' : '');
      text(shown || ' ', W / 2 - 50, y + 64, PAL.yellow, { scale: 2, sp: 1 });
      const key = (ch, kx, ky, kw) => {
        const id = 'key' + ch;
        const on = ui.hover === id || ui.pressed === id;
        rect(kx, ky, kw, 18, PAL.creamLo);
        rect(kx, ky, kw, 17, on ? PAL.yellow : '#f8f2dd');
        text(ch === 'del' ? '<' : ch, kx + Math.ceil(kw / 2), ky + 5, PAL.ink, { align: 'center' });
        region(id, kx, ky, kw + 1, 19, () => typeKey(ch));
      };
      // A row of numbers across the top, then the letters seven to a row.
      [...DIGITS].forEach((ch, i) => key(ch, x + 12 + Math.round(i * 18.3), y + 88, 17));
      [...KEYS, 'del'].forEach((ch, i) => key(ch, x + 12 + (i % 7) * 26, y + 107 + Math.floor(i / 7) * 19, 25));
      pill('save', 'SAVE SCORE', W / 2, y + h - 31, 130, 18, saveScore);
    });
    S.primary = scored ? saveScore : retry;
    S.back = scored ? skip : () => go('title');
  },

  scores(k) {
    const online = onlineEnabled();
    const w = clamp(W - 16, 206, 236);
    const h = Math.min(H - 10, Math.max(300, H - 24)); // the board takes the height it can get
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2);
    const board = online ? S.online.rows : save.data.leaderboard;
    const sent = S.board.fromRun && S.post.state === 'sent' && S.post.entry;
    const mineAt = online ? (sent ? board.findIndex((e) => e.name === sent.name && e.score === sent.score) : -1) : S.board.rank;
    const again = () => beginRun(S.level);
    const home = () => go('title');
    const tw = Math.floor(S.time * 2) % 2;
    const s = S.share;
    panel(k, x, y, w, h, 'dark', () => {
      // Heading: arcade title between two trophies.
      const titleW = blockTitle('LEADERBOARD', W / 2, y + 11, 2);
      for (const d of [-1, 1]) {
        const tx = Math.round(W / 2 + d * (titleW / 2 + 13)) - 5;
        trophy(tx, y + 10);
        sparkle(tx + 5 + d * 10, y + 7, 1 + tw);
        sparkle(tx + 5 - d * 9, y + 23, 2 - tw, '#9fd0a8');
      }
      // Tabs: GLOBAL is this board (The Rally, everyone); FRIENDS is multiplayer's.
      const tabW = Math.floor((w - 30) / 2);
      const tabY = y + 33;
      rrect(W / 2 - 3 - tabW - 1, tabY - 1, tabW + 2, 17, 5, PAL.ink);
      rrect(W / 2 - 3 - tabW, tabY + 1, tabW, 15, 4, PAL.yellowLo);
      rrect(W / 2 - 3 - tabW, tabY, tabW, 14, 4, PAL.yellow);
      globe(W / 2 - 3 - tabW + 8, tabY + 1);
      text(online ? 'GLOBAL' : 'THIS DEVICE', W / 2 - 3 - tabW / 2 + 7, tabY + 4, PAL.ink, { align: 'center', sp: 1 });
      // FRIENDS: the multiplayer friends board (wins against friends), a
      // separate board from this one; until multiplayer is on, it says so.
      ghost('friends', 'FRIENDS', W / 2 + 3 + tabW / 2, tabY, tabW, 14, () => {
        track('friends_tab_clicked');
        if (friendsOn()) return openFriendsBoard('scores');
        s.note = 'FRIENDS BOARD COMING SOON';
        s.noteT = S.time;
      }, friendsOn() ? { sp: 1 } : { color: PAL.dim, line: '#4d6b55', sp: 1 });
      const refreshing = online && S.online.state === 'loading' && S.online.rows.length > 0;
      const loading = online && S.online.state === 'loading' && !refreshing;
      const failed = online && S.online.state === 'error';
      const ready = !loading && !failed && board.length > 0;
      const MEDAL = ['#f2b632', '#c9d3d6', '#d08a4e'];
      // Bottom up: the buttons, the info box, then the table fills the middle.
      const btnY = y + h - 30;
      const L = S.list;
      L.min += ((L.scrolled ? 1 : 0) - L.min) * 0.25; // the info box eases down to one line
      const infoH = Math.round(lerp(34, 16, L.min));
      const infoY = btnY - 6 - infoH;
      // The podium: the top three on numbered blocks, the winner in the middle.
      // Short screens (wide desktops) get a compact one, keeping room for rows.
      const compact = H < 400;
      const podH = ready || loading ? (compact ? 44 : 108) : 0;
      const podTop = tabY + 18;
      if (podH) podium(x, podTop, w, board, mineAt, loading, compact);
      // The table: a framed box with a header row, ranked rows and a scrollbar.
      const tTop = podTop + podH + 3;
      const tBot = infoY - 5;
      rrect(x + 7, tTop - 1, w - 14, tBot - tTop + 2, 4, '#2f5a40');
      rrect(x + 8, tTop, w - 16, tBot - tTop, 3, '#0b1d14');
      // '#' drawn in pixels (the font has none).
      for (const [hx, hy, hw2, hh2] of [[1, 0, 1, 5], [3, 0, 1, 5], [0, 1, 5, 1], [0, 3, 5, 1]]) rect(x + 15 + hx, tTop + 5 + hy, hw2, hh2, PAL.dim);
      text('PLAYER', x + 34, tTop + 4, PAL.dim);
      text('COURT', x + w - 92, tTop + 4, PAL.dim);
      text('SCORE', x + w - 18, tTop + 4, PAL.dim, { align: 'right' });
      const rowsTop = tTop + 15;
      const rowH = clamp(Math.floor((tBot - 3 - rowsTop) / 10), 15, 22);
      const n = Math.max(1, Math.floor((tBot - 3 - rowsTop) / rowH)); // as many rows as fit
      const mid = Math.round((rowsTop + tBot) / 2);
      if (loading) {
        // Placeholder rows with a light sweeping down them while the board loads.
        const sweep = (S.time * 1.4) % 1.6;
        for (let i = 0; i < n; i++) {
          const r0 = rowsTop + i * rowH;
          const lit = Math.abs(sweep - i / n) < 0.12;
          const c = lit ? '#2f5a40' : '#1d3a2a';
          rect(x + 11, r0, w - 26, rowH - 1, i % 2 ? '#0d2117' : '#132d20');
          rect(x + 15, r0 + rowH / 2 - 2, 8, 4, c);
          rect(x + 34, r0 + rowH / 2 - 2, 46 + ((i * 37) % 28), 4, c);
          rect(x + w - 46, r0 + rowH / 2 - 2, 26, 4, c);
        }
      } else if (failed) {
        text('COULD NOT LOAD ONLINE SCORES', W / 2, mid - 14, PAL.cream, { align: 'center' });
        text('TRY AGAIN IN A MOMENT', W / 2, mid - 2, PAL.dim, { align: 'center' });
        ghost('retryonline', 'TRY AGAIN', W / 2, mid + 14, 80, 15, () => loadOnline(true));
      } else if (!board.length) {
        emptyBoard(Math.round((tTop + tBot) / 2), online, tBot - tTop > 200 ? 3 : 2);
      }
      // The rows scroll: by drag, wheel or keys, all of the top 20. Until the
      // player scrolls, the window sits on their new score.
      L.max = ready ? Math.max(0, board.length - n) : 0;
      L.rowH = rowH;
      if (L.cur === null || L.to === null) L.cur = clamp(mineAt - (n - 1), 0, L.max);
      // Let go of a drag and the list settles on a whole row.
      if (L.to !== null && ui.pressed !== 'boardlist') L.to = Math.round(clamp(L.to, 0, L.max));
      if (L.to !== null) L.cur += (clamp(L.to, 0, L.max) - L.cur) * 0.35;
      if (L.to !== null && Math.abs(L.to - L.cur) < 0.01) L.cur = L.to;
      L.cur = clamp(L.cur, 0, L.max);
      const first = Math.floor(L.cur);
      const off = Math.round((L.cur - first) * rowH);
      const shown = ready ? board.slice(first, first + n + 1) : [];
      if (ready && L.max > 0) {
        region('boardlist', x + 8, rowsTop, w - 16, n * rowH, null, (px, py) => {
          if (dragFresh) {
            dragFresh = false;
            L.dragY = py;
            L.dragFrom = L.cur;
            return;
          }
          L.to = L.cur = clamp(L.dragFrom - (py - L.dragY) / rowH, 0, L.max);
          if (Math.abs(py - L.dragY) > 3) markScrolled();
        });
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 8, rowsTop - 1, w - 16, n * rowH + 1);
      ctx.clip();
      shown.forEach((e, i) => {
        const r0 = rowsTop + i * rowH - off;
        const ry = r0 + Math.floor((rowH - 8) / 2);
        const rank = first + i;
        const mine = rank === mineAt;
        if (mine) {
          // The player's own row: a rounded gold frame.
          rrect(x + 10, r0 - 1, w - 24, rowH + 1, 4, PAL.yellow);
          rrect(x + 11, r0, w - 26, rowH - 1, 3, '#24402c');
        } else {
          rect(x + 11, r0, w - 26, rowH - 1, i % 2 ? '#0d2117' : '#132d20');
        }
        const c = mine ? PAL.yellow : PAL.cream;
        if (rank < 3) {
          disc(x + 19, ry + 3, 5, '#06120c');
          disc(x + 19, ry + 3, 4, MEDAL[rank]);
          text(String(rank + 1), x + 20, ry, PAL.ink, { align: 'center' });
        } else {
          text(String(rank + 1), x + 15, ry, mine ? PAL.yellow : PAL.dim);
        }
        text(e.name, x + 34, ry, c, { sp: 1 });
        text('C' + e.court, x + w - 92, ry, mine ? PAL.yellow : PAL.dim);
        text(String(e.score), x + w - 18, ry, c, { align: 'right' });
      });
      ctx.restore();
      // Scrollbar: where this window sits in the whole board.
      if (ready && L.max > 0) {
        const tH = n * rowH - 2;
        const th = Math.max(8, Math.round((tH * n) / board.length));
        const ty = rowsTop + Math.round(((tH - th) * L.cur) / L.max);
        rect(x + w - 12, rowsTop, 2, tH, '#1d3a2a');
        rect(x + w - 12, ty, 2, th, PAL.yellow);
      }
      infoBox(x + 8, infoY, w - 16, online, online, L.min);
      // The buttons: HOME, SHARE (outlined in gold, a call to action), PLAY AGAIN.
      const canShare = S.board.fromRun && S.run && S.run.score > 0;
      if (S.board.fromRun) {
        const hw = 48;
        const sw = canShare ? 60 : 0;
        const gap = 5;
        const aw = w - 16 - hw - sw - gap * (canShare ? 2 : 1);
        const bx = x + 8;
        ghost('home', 'HOME', bx + hw / 2, btnY + 1, hw, 19, home, { sp: 1 });
        if (canShare) {
          if (!s.seen) {
            s.seen = true;
            track('share_cta_viewed', { court: S.level + 1 });
          }
          ghost('share', s.busy ? '...' : 'SHARE', bx + hw + gap + sw / 2, btnY + 1, sw, 19, shareRun, { line: PAL.yellow, color: PAL.yellow, icon: s.busy ? null : 'fwd', sp: 1 });
        }
        pill('again', 'PLAY AGAIN', x + w - 8 - aw / 2, btnY, aw, 20, again, { sp: aw < 90 ? 1 : 2 });
      } else {
        pill('back', 'BACK', W / 2, btnY, 120, 20, home);
      }
      // A short note (shared, saved, coming soon) over the buttons.
      if (s.note && S.time - s.noteT < 3) {
        const nw = textW(s.note) + 14;
        ctx.globalAlpha = Math.min(1, (3 - (S.time - s.noteT)) * 2);
        rrect(W / 2 - nw / 2 - 1, btnY - 21, nw + 2, 15, 5, PAL.ink);
        rrect(W / 2 - nw / 2, btnY - 20, nw, 13, 4, PAL.yellow);
        text(s.note, W / 2, btnY - 17, PAL.ink, { align: 'center' });
        ctx.globalAlpha = 1;
      }
    });
    S.primary = S.board.fromRun ? again : home;
    S.back = home;
  },
};

function drawSoundOverlay(k) {
  ctx.globalAlpha = 0.55 * k;
  rect(0, 0, W, H, '#06120c');
  ctx.globalAlpha = 1;
  checker(0, 0, W, H, 'rgba(6,18,12,' + (0.35 * k).toFixed(2) + ')');
  const s = save.data.settings;
  const w = 176;
  const h = 199;
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  panel(easeBack(k), x, y, w, h, 'dark', () => {
    serif('SOUND', W / 2 + 3, y + 14, 16, PAL.cream, { align: 'center', sp: 5 });
    rect(W / 2 - 12, y + 32, 24, 1, PAL.cream);
    text('MUSIC', x + 18, y + 44, PAL.cream, { sp: 2 });
    text(Math.round(s.music * 100) + '%', x + w - 18, y + 44, PAL.dim, { align: 'right' });
    slider('music', x + 20, y + 57, w - 40, s.music, (v) => setSetting('music', Math.round(v * 20) / 20));
    text('EFFECTS', x + 18, y + 76, PAL.cream, { sp: 2 });
    text(Math.round(s.sfx * 100) + '%', x + w - 18, y + 76, PAL.dim, { align: 'right' });
    slider('sfx', x + 20, y + 89, w - 40, s.sfx, (v) => {
      const q = Math.round(v * 20) / 20;
      if (q !== s.sfx) {
        setSetting('sfx', q);
        audio.sfx('click');
      }
    });
    ghost('mute', s.muted ? 'SOUND IS OFF' : 'SOUND IS ON', W / 2, y + 108, w - 40, 15, toggleMute, s.muted ? { color: PAL.dim, line: PAL.dim } : {});
    ghost('vibrate', s.haptics ? 'VIBRATION IS ON' : 'VIBRATION IS OFF', W / 2, y + 129, w - 40, 15, () => {
      setSetting('haptics', !s.haptics);
      save.commit();
      haptics.play('power');
    }, s.haptics ? {} : { color: PAL.dim, line: PAL.dim });
    const armed = S.eraseArmed > 0;
    ghost('erase', armed ? 'TAP AGAIN TO ERASE' : 'ERASE SAVE DATA', W / 2, y + 150, w - 40, 15, () => {
      if (armed) {
        S.eraseArmed = 0;
        save.erase();
      } else {
        S.eraseArmed = 3;
      }
    }, armed ? { color: '#ff9c7a', line: '#ff9c7a' } : { color: PAL.dim, line: '#3c5a48' });
    pill('done', 'DONE', W / 2, y + h - 27, 80, 17, closeSound);
  });
  S.primary = closeSound;
  S.back = closeSound;
}

// One theme card: a picture of the country's court, its name, and a small
// Black Court swatch. Shared by the theme screen and the pause-menu picker.
function themeCard(c, cx, cy, cw, ch, ph, picked, nowTag, pick) {
  const id = 'theme-' + c.id;
  const hot = ui.hover === id || ui.pressed === id;
  if (picked) rrect(cx - 3, cy - 3, cw + 6, ch + 6, 6, PAL.yellow);
  rrect(cx - 1, cy - 1, cw + 2, ch + 2, 4, picked ? PAL.cream : hot ? PAL.yellow : '#3c5a48');
  rrect(cx, cy, cw, ch, 3, picked ? PAL.panelHi : '#0d1f16');
  const t = getCourtTheme(1, c.id);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx + 3, cy + 3, cw - 6, ph);
  ctx.clip();
  drawThemePreview(t, cx + 3, cy + 3, cw - 6, ph);
  ctx.restore();
  const sx = cx + cw - 17;
  const sy = cy + ph - 8;
  rect(sx - 1, sy - 1, 13, 9, PAL.ink);
  rect(sx, sy, 11, 7, c.black.court);
  rect(sx, sy + 3, 11, 1, c.black.alt);
  rect(sx + 5, sy, 1, 7, c.black.lines);
  text(c.name, cx + 5, cy + ph + 6, picked ? PAL.yellow : PAL.cream, { sp: 1 });
  text(c.short, cx + 5, cy + ph + 15, PAL.dim);
  if (picked) {
    disc(cx + cw - 9, cy + 9, 6, PAL.ink);
    disc(cx + cw - 9, cy + 9, 5, PAL.cream);
    line(cx + cw - 12, cy + 9, cx + cw - 10, cy + 11, PAL.ink);
    line(cx + cw - 10, cy + 11, cx + cw - 6, cy + 6, PAL.ink);
  } else if (nowTag) {
    rrect(cx + cw - 25, cy + 5, 21, 9, 3, PAL.yellow);
    text('NOW', cx + cw - 14, cy + 6, PAL.ink, { align: 'center' });
  }
  region(id, cx, cy, cw, ch, pick);
}

// Theme picker: Automatic, or one of the four countries. Picking one shows
// it straight away behind the panel; the court itself carries on as it was.
function drawThemeOverlay(k) {
  ctx.globalAlpha = 0.55 * k;
  rect(0, 0, W, H, '#06120c');
  ctx.globalAlpha = 1;
  checker(0, 0, W, H, 'rgba(6,18,12,' + (0.35 * k).toFixed(2) + ')');
  const choice = save.data.settings.theme;
  const now = courtTheme();
  const w = Math.min(W - 16, 300);
  const cw = Math.floor((w - 30) / 2);
  const ph = Math.round(clamp(cw * 0.42, 38, 60));
  const ch = ph + 24;
  const h = 96 + ch * 2 + 8 + 34;
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  panel(easeBack(k), x, y, w, h, 'dark', () => {
    serif('THEME', W / 2 + 3, y + 14, 16, PAL.cream, { align: 'center', sp: 5 });
    rect(W / 2 - 12, y + 32, 24, 1, PAL.cream);
    const auto = choice === 'auto';
    ghost('themeauto', auto ? 'AUTOMATIC  ON' : 'AUTOMATIC', W / 2, y + 42, w - 28, 15, () => chooseTheme('auto'),
      auto ? { fill: PAL.yellow, color: PAL.ink, line: PAL.yellow } : {});
    text(auto ? 'A NEW COUNTRY EVERY 2 COURTS' : 'KEPT ON EVERY COURT', W / 2, y + 63, PAL.dim, { align: 'center' });
    text('THIS COURT: ' + now.countryName + (now.isBlackCourt ? ' - BLACK COURT' : ''), W / 2, y + 75, PAL.cream, { align: 'center' });
    COUNTRIES.forEach((c, i) => {
      const cx = x + 12 + (i % 2) * (cw + 6);
      const cy = y + 90 + Math.floor(i / 2) * (ch + 6);
      themeCard(c, cx, cy, cw, ch, ph, choice === c.id, auto && now.countryId === c.id, () => chooseTheme(c.id));
    });
    pill('themedone', 'DONE', W / 2, y + h - 27, 80, 17, closeTheme);
  });
  S.primary = closeTheme;
  S.back = closeTheme;
}

// How to Play: numbered cards per tab, laid out first so the panel can size
// itself and drop the tip on short screens instead of overflowing.
function ruleCardLayout(sec, card, CARD_W, LH) {
  const artW = card.art === 'crack' ? 66 : card.art === 'float' ? 40 : 0;
  const textW0 = CARD_W - 12 - (artW ? artW + 4 : 0);
  const paras = card.lines.map((p) => wrap(p, textW0));
  let body = paras.reduce((n, p) => n + p.length * LH + 3, 0);
  if (card.art) body = Math.max(body, 26);
  if (card.showRows) body += sec.rows[0].kind === 'brick' ? Math.ceil(sec.rows.length / 2) * 24 : sec.rows.length * 19;
  return { artW, paras, h: 17 + body + 2 };
}

function drawRuleArt(kind, x, y) {
  if (kind === 'crack') {
    drawBlock(x, x + 20, y + 20, x + 1, x + 19, y + 16, 9, 9, 'T', 4242);
    text('>', x + 23, y + 9, PAL.cream);
    drawBlock(x + 30, x + 50, y + 20, x + 31, x + 49, y + 16, 9, 9, 'T', 4242, { damage: 1 });
    text('>', x + 53, y + 9, PAL.cream);
    const bits = [[60, 8, 3], [64, 13, 2], [59, 16, 2], [65, 6, 2], [62, 19, 3], [58, 11, 1]];
    bits.forEach(([dx, dy, sz], n) => rect(x + dx, y + dy + (Math.floor(S.time * 3 + n) % 2), sz, sz, n % 2 ? '#cf6f4f' : '#a04d37'));
  } else if (kind === 'float') {
    const bob = Math.round((1 + Math.sin(S.time * 2.2)) * 2);
    drawShadow(x + 16, y + 24, 12 - bob, 2, 0.5);
    drawBlock(x + 4, x + 28, y + 18 - bob, x + 5, x + 27, y + 14 - bob, 9, 9, 'T', 99);
  }
}

function drawRulesOverlay(k) {
  ctx.globalAlpha = 0.55 * k;
  rect(0, 0, W, H, '#06120c');
  ctx.globalAlpha = 1;
  checker(0, 0, W, H, 'rgba(6,18,12,' + (0.35 * k).toFixed(2) + ')');
  const all = sections();
  const sec = all[S.rulesTab];
  // Wide screens get a wider panel (fewer wrapped lines); if a tab is still
  // too tall, the line spacing tightens by a pixel.
  const RW = clamp(W - 12, 228, 300);
  const CARD_W = RW - 16;
  const maxH = H - 12;
  const measure = (lh) => sec.cards.map((c) => ({ card: c, ...ruleCardLayout(sec, c, CARD_W, lh) }));
  let LH = 9;
  let cards = measure(LH);
  if (87 + cards.reduce((n, c) => n + c.h + 4, 0) > maxH) cards = measure((LH = 8));
  const tipLines = wrap(sec.tip, CARD_W - 34);
  const tipH = Math.max(22, tipLines.length * LH + 15);
  const fixed = 37 + 20 + 30; // heading, tabs, Done
  const need = fixed + cards.reduce((n, c) => n + c.h + 4, 0);
  const showTip = need + tipH + 4 <= maxH;
  const h = Math.min(maxH, need + (showTip ? tipH + 4 : 0));
  S.rulesFits = need <= maxH; // checked by the tests at every screen size
  const w = RW;
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  panel(easeBack(k), x, y, w, h, 'dark', () => {
    blockTitle('HOW TO PLAY', W / 2, y + 10, 2);
    const tw = Math.floor(S.time * 2) % 2;
    sparkle(W / 2 - 84, y + 15, 1 + tw);
    sparkle(W / 2 - 92, y + 22, 2 - tw);
    sparkle(W / 2 + 84, y + 15, 2 - tw);
    sparkle(W / 2 + 92, y + 22, 1 + tw);
    all.forEach((t, i) => {
      const on = i === S.rulesTab;
      const tw5 = Math.floor((w - 18) / 5);
      ghost('tab' + i, t.tab, x + 9 + Math.round(tw5 / 2) + i * tw5, y + 34, tw5 - 3, 14, () => (S.rulesTab = i), on ? { fill: PAL.yellow, color: PAL.ink, line: PAL.yellow, sp: 0 } : { sp: 0, line: '#2f6b47' });
    });

    let cy = y + 54;
    const cx = x + 8;
    cards.forEach(({ card, artW, paras, h: ch }, n) => {
      rrect(cx, cy, CARD_W, ch, 4, '#2a5a3c');
      rrect(cx + 1, cy + 1, CARD_W - 2, ch - 2, 3, '#0c2016');
      // Numbered badge and heading.
      rrect(cx + 5, cy + 4, 11, 11, 2, PAL.yellow);
      text(String(n + 1), cx + 11, cy + 6, PAL.ink, { align: 'center' });
      text(card.title, cx + 21, cy + 6, PAL.cream, { sp: 2 });
      let ty = cy + 18;
      if (card.showRows && sec.rows[0].kind === 'brick') {
        // Two by two: picture, name, hits, points pill.
        sec.rows.forEach((r, i) => {
          const half = Math.floor((CARD_W - 4) / 2);
          const bx = cx + 4 + (i % 2) * half;
          const by = ty + Math.floor(i / 2) * 24;
          const bh = r.type === 'S' ? 4 : 8;
          drawBlock(bx, bx + 16, by + 16, bx + 1, bx + 15, by + 13, bh, bh, r.type, 4242);
          text(r.name, bx + 19, by + 2, PAL.cream, { sp: 0 });
          text(r.left, bx + 19, by + 12, '#9fb7a2', { sp: 0 });
          const pw = textW(r.right, 1, 0) + 6;
          rrect(bx + half - 2 - pw, by + 1, pw, 9, 3, PAL.yellow);
          text(r.right, bx + half + 1 - pw, by + 2, PAL.ink, { sp: 0 });
        });
        ty += Math.ceil(sec.rows.length / 2) * 24;
      } else if (card.showRows) {
        sec.rows.forEach((r, i) => {
          const ry = ty + i * 19;
          disc(cx + 13, ry + 8, 8, '#2f6b47');
          disc(cx + 13, ry + 8, 7, PAL.panel);
          icon(r.id, cx + 8, ry + 3, PAL.yellow);
          text(r.name, cx + 26, ry + 1, PAL.cream, { sp: 1 });
          text(r.left, cx + 26, ry + 10, '#9fb7a2', { sp: 0 });
          const pw = textW(r.right, 1, 0) + 6;
          rrect(cx + CARD_W - 6 - pw, ry, pw, 9, 3, PAL.yellow);
          text(r.right, cx + CARD_W - 3 - pw, ry + 1, PAL.ink, { sp: 0 });
        });
        ty += sec.rows.length * 19;
      }
      if (card.art) drawRuleArt(card.art, cx + 6, cy + 16);
      const tx = cx + 6 + (artW ? artW + 4 : 0);
      for (const para of paras) {
        for (const ln of para) {
          text(ln, tx, ty, '#b9c9b4');
          ty += LH;
        }
        ty += 3;
      }
      cy += ch + 4;
    });

    if (showTip) {
      rrect(cx, cy, CARD_W, tipH, 4, '#6b6a2c');
      rrect(cx + 1, cy + 1, CARD_W - 2, tipH - 2, 3, '#18301c');
      rrect(cx + 5, cy + Math.round((tipH - 15) / 2), 15, 15, 3, '#0c2016');
      icon('bulb', cx + 7, cy + Math.round((tipH - 11) / 2), PAL.yellow);
      text('TIP', cx + 26, cy + 4, PAL.yellow, { sp: 2 });
      tipLines.forEach((ln, i) => text(ln, cx + 26, cy + 13 + i * LH, '#b9c9b4'));
    }
    pill('done', 'DONE', W / 2, y + h - 26, 96, 17, closeRules, { sp: 3 });
  });
  S.primary = closeRules;
  S.back = closeRules;
}

// ---------------------------------------------------------------- draw

let gameLayer = null;

// ---- the signature -----------------------------------------------------------
// "CRAFTED BY / YASHISH" in the game's own pixel font on the landing screen,
// fixed in place on its plate: a band of light runs across YASHISH pixel by
// pixel, sparkles twinkle round it, CRAFTED BY catches a glint now and then,
// and the plate's gold edge lights as the light passes. Bottom right on wide
// screens, centred on phones.

const SIG = { by: 'CRAFTED BY', name: 'YASHISH', zoom: 2 };
let sigMasks = null;

// The lit pixels of a line of pixel text, each with a fixed random order.
function sigMask(str, sp) {
  const w = textW(str, 1, sp) + 2;
  const h = 10;
  const layer = makeLayer(w, h);
  const was = ctx;
  setTarget(layer);
  text(str, 0, 0, '#ffffff', { sp });
  setTarget(was);
  const d = layer.getImageData(0, 0, w, h).data;
  const px = [];
  let mw = 0;
  let mh = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 128) continue;
      const r = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;
      px.push({ x, y, r });
      mw = Math.max(mw, x + 1);
      mh = Math.max(mh, y + 1);
    }
  }
  return { px, w: mw, h: mh };
}

// Where the signature plate sits: bottom right on wide screens, else bottom centre.
function sigBox() {
  if (!sigMasks) sigMasks = { by: sigMask(SIG.by, 2), name: sigMask(SIG.name, 1) };
  const { by, name } = sigMasks;
  const bw = Math.max(by.w, name.w * SIG.zoom) + 14;
  const bh = by.h + 4 + name.h * SIG.zoom + 10;
  return { x: W >= 400 ? W - 8 - bw : Math.round(W / 2 - bw / 2), y: H - 6 - bh, w: bw, h: bh };
}

// The landing screen's cards and button row, fitted between the horizon and
// the signature: stacked on narrow screens, side by side on wide ones.
function titleLayout() {
  const wide = W >= 400;
  const tall = H >= 440;
  const sig = sigBox();
  const ch = tall ? 32 : wide ? 32 : 28;
  const gap = tall ? 8 : 6;
  const rowGap = tall ? 8 : 7;
  if (wide) {
    const cw = Math.min(206, Math.floor((W - 48) / 2));
    const x = Math.round((W - cw * 2 - 8) / 2);
    const bw = Math.min(84, Math.floor((cw * 2 + 8 - 10) / 3));
    const rx = Math.round(W / 2 - (bw * 3 + 10) / 2);
    const clear = rx + bw * 3 + 10 < sig.x - 4; // the row passes left of the signature
    const limit = (clear ? H - 6 : sig.y - 4) - (ch + 4 + rowGap + 19);
    const top = Math.max(P.wb + 6, Math.min(P.wb + 40 + Math.round(H * 0.04), limit));
    return { cw, ch, bw, a: { x, y: top }, b: { x: x + cw + 8, y: top }, row: { x: rx, y: top + ch + 4 + rowGap } };
  }
  const cw = Math.min(208, W - 24);
  const x = Math.round((W - cw) / 2);
  const bw = Math.floor((cw - 10) / 3);
  const tiles = tall; // room for icon-over-label tiles
  const rh = tiles ? 28 : 17;
  const total = (ch + 4) * 2 + gap + rowGap + rh + 2;
  const limit = sig.y - (tall ? 10 : 4) - total;
  const top = Math.max(P.wb + 4, Math.min(P.wb + 46 + Math.round(H * 0.04), limit));
  return { cw, ch, bw, tiles, rh, a: { x, y: top }, b: { x, y: top + ch + 4 + gap }, row: { x, y: top + (ch + 4) * 2 + gap + rowGap } };
}

function drawSignature(k) {
  const { x: x0, y: y0, w: bw, h: bh } = sigBox(); // (also makes sigMasks)
  const { by, name } = sigMasks;
  const z = SIG.zoom;
  const t = S.time;
  const a0 = ctx.globalAlpha;
  const sweep = (t % 2.6) / 2.6; // the light's run across YASHISH, then a rest
  // The plate: a dark tile whose gold edge lights up as the light passes.
  ctx.globalAlpha = a0 * 0.6;
  rrect(x0, y0, bw, bh, 4, PAL.ink);
  ctx.globalAlpha = a0 * (0.35 + (sweep < 0.6 ? 0.5 * Math.sin((sweep / 0.6) * Math.PI) : 0));
  rect(x0 + 4, y0, bw - 8, 1, PAL.yellow);
  rect(x0 + 4, y0 + bh - 1, bw - 8, 1, PAL.yellow);
  rect(x0, y0 + 4, 1, bh - 8, PAL.yellow);
  rect(x0 + bw - 1, y0 + 4, 1, bh - 8, PAL.yellow);
  ctx.globalAlpha = a0;
  // CRAFTED BY in cream; a few of its pixels glint white in turn.
  const byX = Math.round(x0 + bw / 2 - by.w / 2);
  const byY = y0 + 5;
  const glint = (t * 0.7) % 1;
  for (const p of by.px) {
    rect(byX + p.x + 1, byY + p.y + 1, 1, 1, PAL.ink);
    rect(byX + p.x, byY + p.y, 1, 1, Math.abs(p.r - glint) < 0.03 ? '#ffffff' : PAL.cream);
  }
  // YASHISH in gold, a slanted band of light crossing it pixel by pixel.
  const nx = Math.round(x0 + bw / 2 - (name.w * z) / 2);
  const ny = y0 + 5 + by.h + 4;
  for (const p of name.px) {
    const band = sweep * (name.w + name.h + 8) - 4 - (p.x + (name.h - p.y));
    const c = Math.abs(band) < 1.4 ? '#ffffff' : Math.abs(band) < 3.2 ? PAL.yellowHi : PAL.yellow;
    rect(nx + p.x * z + 1, ny + p.y * z + 1, z, z, PAL.ink);
    rect(nx + p.x * z, ny + p.y * z, z, z, c);
  }
  // Sparkles that twinkle round the name.
  [[nx - 4, ny + 1], [nx + name.w * z + 3, ny + 2], [nx + name.w * z * 0.55, ny - 3]].forEach(([sx, sy], i) => {
    const tw = Math.sin(t * 3.3 + i * 2.1);
    if (tw < 0.35) return;
    const arm = tw > 0.85 ? 2 : 1;
    const col = tw > 0.85 ? '#ffffff' : PAL.yellowHi;
    rect(Math.round(sx) - arm, Math.round(sy), arm * 2 + 1, 1, col);
    rect(Math.round(sx), Math.round(sy) - arm, 1, arm * 2 + 1, col);
  });
}

function draw() {
  // The camera never sits quite still: a slow pitch drift, plus a lean toward the ball.
  const g0 = S.game;
  const ball = g0 && S.screen === 'play' && g0.balls[0];
  const pitch = Math.sin(S.time * 0.45) * 0.014 + (ball ? (ball.y - 120) / 240 * 0.02 : 0);
  S.pitch = (S.pitch || 0) + (pitch - (S.pitch || 0)) * 0.05;
  P.landing = easeInOut(S.landing);
  setCam(S.cam + S.pitch, S.shift);
  P.banner = GAME_SCREENS.has(S.screen); // the banner board shows on the courts, the stone wall elsewhere
  P.hype = crowdHype();
  // The crowd under play: a murmur that rises with the combo, the Power Rush
  // and every cheer; quiet off the court.
  const g1 = S.game;
  const live = g1 && S.screen === 'play' && (g1.state === 'play' || g1.state === 'serve');
  audio.crowdBed(live ? Math.min(1, 0.15 + (g1.combo || 0) / 12 + (g1.rush ? 0.35 : 0) + P.hype * 0.5) : 0);
  P.clap = crowdMood('clap');
  P.groan = crowdMood('groan');
  P.pops = GAME_SCREENS.has(S.screen) ? (S.pops || []).filter((q) => S.time - q.at < POP_LEN).map((q) => ({ x: q.x, y: q.y, k: q.k * (1 - (S.time - q.at) / POP_LEN) })) : [];
  P.wave = wavePos();
  // A quiet stretch of play: the crowd starts a wave of its own.
  if (S.screen === 'play' && S.game && S.game.state === 'play' && S.time - ((S.wave && S.wave.at) ?? S.playSince ?? S.time) > WAVE_EVERY) startWave();
  if (S.screen !== 'play') S.playSince = S.time;
  audio.setCrowd(GAME_SCREENS.has(S.screen) && !!S.game);
  say(ARIA);
  const look = courtTheme();
  setTheme(look);
  audio.setTrack(musicFor(look));
  audio.setRate(GAME_SCREENS.has(S.screen) && S.game && S.game.rush ? RUSH_TEMPO : 1);
  audio.setBuild(musicBuild());
  beginUI();
  S.primary = null;
  S.back = null;

  const g = S.game;
  const shake = g && g.shake > 0 ? Math.round(Math.sin(S.time * 90) * g.shake * 8) : 0;
  ctx.setTransform(1, 0, 0, 1, shake, 0);
  drawScene(S.time);

  if (S.titleVis > 0.01) drawPyramid(S.titleVis);

  if (g && S.gameVis > 0.01) {
    if (S.gameVis >= 1) {
      drawGame(g, S.time);
    } else {
      if (!gameLayer || gameLayer.canvas.height !== H || gameLayer.canvas.width !== W) gameLayer = makeLayer(W, H);
      gameLayer.clearRect(0, 0, W, H);
      setTarget(gameLayer);
      drawGame(g, S.time);
      setTarget(null);
      ctx.globalAlpha = S.gameVis;
      ctx.drawImage(gameLayer.canvas, 0, 0);
      ctx.globalAlpha = 1;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const hud = S.leaving ? S.leaving.name : S.screen;
  if (g && (hud === 'countdown' || hud === 'play' || hud === 'paused')) {
    drawHUD(g, 'COURT ' + (S.level + 1));
    if (S.mpGame) drawOpponentHUD();
    else drawPlace();
    drawRush(g);
  }
  drawCheer();

  if (S.leaving) {
    ui.live = false;
    SCREENS[S.leaving.name](1 - easeOut(S.leaving.t / LEAVE));
  } else {
    const k = easeOut(S.t / 0.4);
    ui.live = k > 0.9 && S.overlayT <= 0;
    // The pause menu folds away while a popup opened from it is up, so the
    // two panels never show one through the other.
    SCREENS[S.screen](S.screen === 'paused' ? k * (1 - easeOut(S.overlayT)) : k);
  }
  ui.live = true;

  if (S.overlayT > 0) {
    beginUI();
    ui.live = S.overlay && S.overlayT >= 1;
    if (S.overlayKind === 'rules') drawRulesOverlay(S.overlayT);
    else if (S.overlayKind === 'theme') drawThemeOverlay(S.overlayT);
    else drawSoundOverlay(S.overlayT);
    ui.live = true;
  }
}

// ---------------------------------------------------------------- input

let ptr = null;

function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
}

const steering = () => (S.screen === 'play' || S.screen === 'countdown') && S.game && !S.overlay && !S.leaving;

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.unlock();
  S.touch = e.pointerType !== 'mouse';
  const p = toLogical(e);
  const r = hitTest(p.x, p.y);
  ptr = { id: e.pointerId, x: p.x, moved: 0, t: S.time, region: r ? r.id : null };
  if (r) {
    ui.pressed = r.id;
    dragFresh = true;
    if (r.drag) r.drag(p.x, p.y);
  } else if (steering() && !S.touch) {
    S.game.movePaddleTo(unprojX(p.x, S.game.paddle.y));
  }
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic events have no active pointer to capture */
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    if (S.screen !== 'scores') return;
    e.preventDefault();
    scrollBoard(Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 60)));
  },
  { passive: false },
);

canvas.addEventListener('pointermove', (e) => {
  const p = toLogical(e);
  const r = hitTest(p.x, p.y);
  ui.hover = e.pointerType === 'mouse' && r ? r.id : null;
  canvas.style.cursor = ui.hover ? 'pointer' : '';
  canvas.style.cursor = ui.hover ? 'pointer' : 'default';
  if (ptr && ptr.region) {
    const held = ui.regions.find((q) => q.id === ptr.region);
    if (held && held.drag) held.drag(p.x, p.y);
    return;
  }
  if (!steering()) return;
  const g = S.game;
  if (e.pointerType === 'mouse') {
    g.movePaddleTo(unprojX(p.x, g.paddle.y));
  } else if (ptr) {
    // Touch steers relatively so a thumb never has to cover the paddle.
    const dx = p.x - ptr.x;
    ptr.moved += Math.abs(dx);
    ptr.x = p.x;
    g.movePaddleTo(g.paddle.x + (dx / proj(0, g.paddle.y).s) * 1.3);
  }
});

function release(e, cancelled) {
  // Phones only allow sound to start when a touch ENDS, not when it begins,
  // so the audio is unlocked here as well as on pointerdown.
  if (!cancelled) audio.unlock();
  if (!ptr) return;
  const p = toLogical(e);
  if (ptr.region) {
    const r = hitTest(p.x, p.y);
    if (!cancelled && r && r.id === ptr.region && r.fn) {
      tapSound(r.id);
      r.fn();
    } else if (r && r.drag) {
      save.commit();
    }
  } else if (!cancelled && S.screen === 'play' && !S.overlay && ptr.moved < 6 && S.time - ptr.t < 0.5 * S.timeScale) {
    S.game.launch();
  }
  ui.pressed = null;
  ptr = null;
}
canvas.addEventListener('pointerup', (e) => release(e, false));
canvas.addEventListener('pointercancel', (e) => release(e, true));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// Belt and braces for browsers that only count these as a user gesture.
for (const type of ['touchend', 'click']) window.addEventListener(type, () => audio.unlock(), { passive: true });

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  audio.unlock();
  if (S.overlay === 'rules' && (k === 'arrowleft' || k === 'arrowright')) {
    turnRules(k === 'arrowleft' ? -1 : 1);
    e.preventDefault();
    return;
  }
  if (typing() && !S.leaving && !S.overlay) {
    if (k === 'backspace') typeChar('del');
    else if (k === 'enter') submitName();
    else if (k === 'escape') S.back && S.back();
    else if (k.length === 1 && (KEYS + DIGITS).includes(k.toUpperCase())) typeChar(k.toUpperCase());
    else return;
    audio.sfx('key');
    e.preventDefault();
    return;
  }
  if (S.screen === 'name' && !S.leaving && !S.overlay && S.run && S.run.score > 0) {
    // Typing a name: letters are text here, not shortcuts.
    if (k === 'backspace') typeKey('del');
    else if (k === 'enter') S.primary && S.primary();
    else if (k === 'escape') S.back && S.back();
    else if (k.length === 1 && (KEYS + DIGITS).includes(k.toUpperCase())) {
      typeKey(k.toUpperCase());
      audio.sfx('key', k.toUpperCase());
    }
    else return;
    e.preventDefault();
    return;
  }
  if (S.screen === 'scores' && !S.overlay && ['arrowup', 'arrowdown', 'pageup', 'pagedown'].includes(k)) {
    scrollBoard({ arrowup: -1, arrowdown: 1, pageup: -5, pagedown: 5 }[k]);
    e.preventDefault();
    return;
  }
  if (S.screen === 'courts' && !S.leaving && !S.overlay && (k === 'arrowleft' || k === 'arrowright')) {
    S.page = clamp(S.page + (k === 'arrowleft' ? -1 : 1), 0, Math.ceil(LEVELS.length / PER_PAGE) - 1);
    e.preventDefault();
    return;
  }
  if (k === 'arrowleft' || k === 'a') S.left = true;
  else if (k === 'arrowright' || k === 'd') S.right = true;
  else if (k === ' ' || k === 'enter' || k === 'arrowup') {
    if (!e.repeat && S.primary && !S.leaving) S.primary();
  } else if (k === 'escape' || k === 'p') {
    if (!e.repeat && S.back && !S.leaving) S.back();
  } else if (k === 'm') {
    if (!e.repeat) toggleMute();
  } else return;
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') S.left = false;
  if (k === 'arrowright' || k === 'd') S.right = false;
});

window.addEventListener('blur', () => {
  S.left = S.right = false;
  pause();
});

document.addEventListener('visibilitychange', () => {
  audio.hold(document.hidden);
  if (document.hidden) pause();
});

// ---------------------------------------------------------------- layout

// The canvas fills the window. One game pixel is sized so that at least
// 240 x 320 of them fit; any spare room becomes more court and garden.
function resize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const unit = Math.min(vw / 240, vh / 320);
  const w = clamp(Math.floor(vw / unit), 240, 760);
  const h = clamp(Math.floor(vh / unit), 320, 520);
  if (w !== W || h !== H || !S.ready) {
    setSize(w, h);
    buildLayers();
  }
  const scale = Math.min(vw / w, vh / h);
  canvas.style.width = Math.round(w * scale) + 'px';
  canvas.style.height = Math.round(h * scale) + 'px';
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * S.timeScale;
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- multiplayer

// A match game: this player's own run, built from the server's verified
// numbers (court, lives, score, and which bricks of the court are already
// broken), counting down to the server's start time.
function startMatchGame(levelIndex, { lives, score }, broken, wait) {
  S.coach = null;
  S.place = null;
  S.mpGame = true;
  S.run = { lives, score, saved: true, cleared: 0, mp: true }; // saved: never offered to the solo board
  S.cleared = null;
  S.level = clamp(levelIndex, 0, LEVELS.length - 1);
  S.game = new Game(matchLevel(S.level), onGameEvent, Math.random, { lives, score, weights: MATCH_WEIGHTS });
  applyBroken(S.game, broken);
  // Rejoining on a court already cleared (its bonus already counted): play on from the next one.
  if (S.game.remaining === 0 && S.level + 1 < LEVELS.length) {
    S.level++;
    S.game = new Game(matchLevel(S.level), onGameEvent, Math.random, { lives, score, weights: MATCH_WEIGHTS });
  }
  S.ending = 0;
  S.countFrom = Math.max(BEAT, wait || 0);
  if (S.screen === 'countdown') enter('countdown');
  else go('countdown');
}

setupMultiplayer({ S, go, audio, haptics, track, save, courtTheme, startMatchGame, playSolo: () => play() });
if (debug) window.__mp = mp;

async function boot() {
  resize();
  requestAnimationFrame(frame);
  canvas.dataset.ready = '1';
  const fallback = document.getElementById('fallback');
  if (fallback) fallback.hidden = true;
  await save.init();
  initAnalytics();
  S.bootTo = bootMultiplayer(); // an invite link, or a match to rejoin after a refresh
  // Each visit opens on a different country than the last one (Automatic
  // theme only; a country picked in Pause stays picked).
  // Kept apart from the save, so a first visit does not create one.
  let prev = 0;
  try {
    prev = Math.floor(Number(localStorage.getItem('the-court.look'))) || 0;
  } catch {
    /* storage blocked: any start will do */
  }
  S.look = (prev + 1 + Math.floor(Math.random() * (COUNTRIES.length - 1))) % COUNTRIES.length;
  const pinned = debug && new URLSearchParams(location.search).get('look'); // tests fix the rotation
  if (pinned) S.look = Math.floor(Number(pinned)) % COUNTRIES.length || 0;
  try {
    localStorage.setItem('the-court.look', String(S.look));
  } catch {
    /* not kept: the next visit may repeat it */
  }
  audio.settings = save.data.settings;
  S.ready = true;
}

if (debug) window.__court = { S, P, save, audio, haptics, setSetting, ui, LEVELS, go, beginRun, proj, size: () => [W, H], onlineEnabled, getCourtTheme, currentTheme };

boot();
