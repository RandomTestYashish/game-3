// Multiplayer: two friends, the same start, independent games, one verified
// result. The screens, the match lifecycle on this device, checkpoints,
// reconnecting, the opponent's HUD, the invite and result images, and the
// analytics events. The database decides everything that matters (see
// supabase/multiplayer/002_multiplayer.sql); this file only asks and shows.
//
// Flow:
//   MULTIPLAYER -> name -> invite (share the link; play The Rally while
//   waiting) ... friend opens the link -> their name -> both READY ->
//   the server's countdown -> each plays their own run (3 lives, courts in
//   order, own pace) -> when both are out (or a player is gone for 30 s) the
//   server declares the result -> rematch / share / friends board / history.

import { W, H, ctx, PAL, rect, rrect, disc, text, textW, serif, wrap, icon, sparkle, clamp } from './gfx.js';
import { ui, region, pill, ghost, card, cardArt, panel, iconBtn } from './ui.js';
import { mpEnabled, connect, call, watch, serverNow } from './mpnet.js';
import { drawInviteCard, drawResultStory, toBlob } from './mpcards.js';
import { hudRows } from './render.js';

const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ-';
const DIGITS = '1234567890';
const POLL_MS = 2000; // a state read (and heartbeat) this often while a match is open
const CHECKPOINT_MS = 2000; // the most often a running game reports its score
// After a checkpoint fails (refused, or the network), wait before trying again,
// doubling up to the most. Nothing is lost meanwhile: every checkpoint carries
// the whole state (score, court, lives, broken bricks), so the next one catches up.
const RETRY_MS = 1500;
const RETRY_MAX_MS = 6000;
const STORE = 'the-court.mp'; // which match this device is in (the match id only; the server holds the state)
const TERMINAL = new Set(['completed', 'cancelled', 'expired']);
const CLOCK_SHOW_MS = 5 * 60 * 1000; // the match clock shows in play once this little is left

let A = null; // what main.js lends us: S, go, audio, track...
const M = {
  matchId: null,
  role: null,
  state: null, // the last state read from the server
  inviteUrl: '',
  invite: null, // the invite image for this link: { key, canvas, file }
  token: '', // the host's invite token (only to share it; the server keeps a hash)
  name: '',
  nameFor: 'host', // which flow the name screen is for: 'host' | 'join'
  joinToken: '',
  joinInfo: null, // { status, host_name, expires_at }
  busy: false,
  note: '', // a short line under the buttons ("LINK COPIED")
  noteT: 0,
  error: null, // { reason, retry }
  seq: 0,
  sent: null, // the last checkpoint the server accepted: { score, court, lives, broken }
  sending: false,
  lastSentAt: 0,
  retryAt: 0, // no checkpoint before this time (after a failed one)
  retryMs: 0, // the current wait; 0 after a checkpoint is accepted
  ended: null, // { won } once this player's run is over (every checkpoint then says done)
  pollAt: 0,
  polling: false,
  unwatch: null,
  game: false, // a multiplayer game is running on this device
  stash: null, // the solo Rally put aside when a friend joined
  board: { state: 'idle', rows: [] },
  history: { state: 'idle', rows: [] },
  t: { opened: 0, created: 0, joined: 0, started: 0, activeMs: 0, activeFrom: 0, pausedAt: 0 },
  reconnects: 0,
  offline: false, // our last request failed
  seen: {}, // analytics fired once per match: { 'match_ready': true, ... }
  rematchAsked: false,
  boardFrom: null, // where the friends board was opened from ('scores' = the Rally leaderboard)
  shown: { clock: '', wait: '' }, // the clock lines last drawn (read by the tests)
};

const reasons = {
  invalid: 'THIS INVITE LINK IS NOT VALID.',
  expired: 'THIS INVITE HAS EXPIRED. INVITES LAST 1 HOUR.',
  used: 'SOMEONE HAS ALREADY JOINED THIS MATCH.',
  cancelled: 'THE HOST CALLED OFF THIS MATCH.',
  full: 'THIS MATCH IS ALREADY FULL.',
  unavailable: 'THIS MATCH HAS ALREADY STARTED OR ENDED.',
  rate_limited: 'TOO MANY TRIES. WAIT A FEW MINUTES AND TRY AGAIN.',
  network: 'NO CONNECTION. CHECK YOUR INTERNET AND TRY AGAIN.',
  timeout: 'THE SERVER IS SLOW TO ANSWER. TRY AGAIN.',
  server: 'SOMETHING WENT WRONG ON OUR SIDE. TRY AGAIN.',
  session: 'YOUR SESSION RAN OUT. TRY AGAIN.',
  sign_in: 'COULD NOT START A GUEST SESSION. TRY AGAIN.',
  not_configured: 'MULTIPLAYER IS NOT AVAILABLE ON THIS SITE YET.',
  bad_name: 'USE 1 TO 8 LETTERS OR NUMBERS.',
  not_member: 'THIS MATCH BELONGS TO OTHER PLAYERS.',
  ready_timeout: 'NOT EVERYONE WAS READY IN TIME (5 MINUTES).',
  abandoned: 'A PLAYER LEFT BEFORE THE START.',
  declined: 'YOUR FRIEND DOES NOT WANT A REMATCH.',
  lost_match: 'COULD NOT FIND YOUR MATCH. IT MAY HAVE ENDED.',
  image: 'COULD NOT MAKE THE IMAGE. THE LINK WAS COPIED INSTEAD.',
};
const say = (r) => reasons[r] || reasons.server;

// ---------------------------------------------------------------- setup

export function setupMultiplayer(api) {
  A = api;
}

const S = () => A.S;
const me = () => (M.state && M.state.me) || null;
const opp = () => (M.state && M.state.opponent) || null;
const match = () => (M.state && M.state.match) || null;
// Until the match ends at the latest (its full time, or the grace once one player is done), in ms; null if not set.
const timeLeft = () => (match() && match().ends_at ? match().ends_at - serverNow() : null);
const inGrace = () => !!(match() && match().ends_at && match().time_ends_at && match().ends_at < match().time_ends_at);
const device = () => (W >= 400 ? 'desktop' : 'mobile');

function track(event, props = {}) {
  A.track(event, { match_id: M.matchId || undefined, role: M.role || undefined, device: device(), ...props });
}
function once(key, event, props) {
  if (M.seen[key]) return;
  M.seen[key] = true;
  track(event, props);
}

function remember() {
  try {
    if (M.matchId) localStorage.setItem(STORE, JSON.stringify({ id: M.matchId, role: M.role, url: M.inviteUrl, token: M.token }));
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: no recovery after a refresh, everything else works */
  }
}
function recalled() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

// Realtime says a row changed. Every status read also marks its player as
// still here (a write), so reading again on each change would set the two
// devices bouncing reads off each other. Read again only when it matters:
// any change to the match, or a player change the game would show.
function worthReading(change) {
  const row = change && change.new;
  if (!row || change.table !== 'multiplayer_players') return true;
  const a = me();
  if (a && row.id === a.id) return false; // our own row: our own calls already bring it back
  const o = opp();
  if (!o) return true; // someone new: the friend has joined
  return (
    Number(row.score) !== o.score || row.court !== o.court || row.lives !== o.lives ||
    !!row.finished_at !== !!o.finished || !!row.ready_at !== !!o.ready || row.connection_status !== o.connection ||
    !!row.rematch_requested_at !== !!o.rematch || !!row.rematch_declined_at !== !!o.declined
  );
}

function setMatch(id, role) {
  if (M.matchId !== id) {
    if (M.unwatch) M.unwatch();
    M.unwatch = null;
    M.seen = {};
    M.seq = 0;
    M.sent = null;
    M.retryAt = 0;
    M.retryMs = 0;
    M.ended = null;
    M.reconnects = 0;
    M.rematchAsked = false;
  }
  M.matchId = id;
  M.role = role;
  if (id && !M.unwatch) M.unwatch = watch(id, (change) => worthReading(change) && (M.pollAt = 0));
  remember();
}

function fail(reason, retry) {
  M.error = { reason, retry };
  A.go('mperror');
}

function note(msg) {
  M.note = msg;
  M.noteT = S().time;
}

// ---------------------------------------------------------------- entry

// The Rally's leaderboard: its FRIENDS tab opens this board (when
// multiplayer is on); BACK returns to the leaderboard.
export const friendsOn = () => mpEnabled();
export function openFriendsBoard(from) {
  M.boardFrom = from;
  if (mpEnabled()) connect().then(loadBoard);
  A.go('mpboard');
}

export function openMultiplayer() {
  M.t.opened = Date.now();
  track('multiplayer_opened', { configured: mpEnabled() });
  A.go('mp');
  if (mpEnabled()) connect();
}

// At boot: an invite link (?join=TOKEN), or a match this device was in
// before a refresh. Returns the screen to open instead of the title, or null.
export function bootMultiplayer() {
  const params = new URLSearchParams(location.search);
  const token = params.get('join');
  if (token) {
    M.joinToken = token;
    try {
      sessionStorage.setItem(STORE + '.join', token);
    } catch {
      /* fine */
    }
    // Keep the token out of the address bar (and out of anything that logs URLs).
    params.delete('join');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    track('multiplayer_invite_opened');
    loadInvite();
    return 'mpjoin';
  }
  const r = recalled();
  if (r && r.id && mpEnabled()) {
    M.inviteUrl = r.url || '';
    M.token = r.token || '';
    setMatch(r.id, r.role);
    track('multiplayer_reconnect_started', { cause: 'reload' });
    resume(true);
    return 'mpresume';
  }
  return null;
}

// Back to a match after a refresh (or from the Multiplayer screen).
async function resume(afterReload) {
  const res = await call('mp_state', { p_match: M.matchId });
  if (!res.ok) {
    if (res.error === 'not_member') {
      setMatch(null, null);
      if (afterReload) A.go('title');
      return;
    }
    track('multiplayer_reconnect_failed', { error_category: res.error });
    return fail(res.error === 'network' || res.error === 'timeout' ? res.error : 'lost_match', () => resume(afterReload));
  }
  apply(res.data, true);
  const m = match();
  if (TERMINAL.has(m.status) && m.status !== 'completed') {
    setMatch(null, null);
    if (afterReload) A.go('title');
    return;
  }
  if (afterReload) track('multiplayer_reconnect_succeeded', { cause: 'reload', status: m.status });
  route(true);
}

// ---------------------------------------------------------------- server calls

async function createMatch() {
  if (M.busy) return; // a second tap while the first is on its way
  M.busy = true;
  M.request = M.request || crypto.randomUUID();
  const res = await call('mp_create_match', { p_name: M.name, p_request: M.request });
  M.busy = false;
  if (!res.ok) {
    track('multiplayer_invite_failed', { error_category: res.error, step: 'create' });
    return fail(res.error, createMatch);
  }
  M.request = null;
  M.token = res.data.token;
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('join', M.token);
  M.inviteUrl = u.toString();
  apply(res.data.state);
  setMatch(M.state.match.id, 'host');
  M.t.created = Date.now();
  A.save.data.lastName = M.name;
  A.save.commit();
  track('multiplayer_match_created');
  track('multiplayer_invite_generated');
  A.go('mpinvite');
}

async function loadInvite() {
  M.joinInfo = { status: 'loading' };
  const res = await call('mp_invite_info', { p_token: M.joinToken });
  if (!res.ok) {
    M.joinInfo = { status: 'error', error: res.error };
    track('multiplayer_invite_failed', { error_category: res.error, step: 'open' });
    return;
  }
  M.joinInfo = res.data;
  const st = res.data.status;
  if (st === 'expired') track('multiplayer_invite_expired');
  else if (st !== 'valid' && st !== 'joined' && st !== 'own') track('multiplayer_invite_failed', { invite_status: st, step: 'open' });
  if ((st === 'joined' || st === 'own') && res.data.match_id) {
    // This device is already in it (a refresh after joining, or the host's own link).
    setMatch(res.data.match_id, st === 'own' ? 'host' : 'guest');
    resume(false);
  }
  if (st === 'valid') M.name = M.name || A.save.data.lastName || '';
}

async function joinMatch() {
  if (M.busy) return;
  M.busy = true;
  const res = await call('mp_join', { p_token: M.joinToken, p_name: M.name });
  M.busy = false;
  if (!res.ok) {
    track('multiplayer_invite_failed', { error_category: res.error, step: 'join' });
    if (['invalid', 'expired', 'used', 'cancelled', 'full', 'unavailable'].includes(res.error)) {
      M.joinInfo = { status: res.error };
      return;
    }
    return fail(res.error, joinMatch);
  }
  apply(res.data);
  setMatch(M.state.match.id, 'guest');
  M.t.joined = Date.now();
  A.save.data.lastName = M.name;
  A.save.commit();
  try {
    sessionStorage.removeItem(STORE + '.join');
  } catch {
    /* fine */
  }
  track('multiplayer_invite_joined');
  A.go('mpready');
}

async function ready() {
  if (M.busy || (me() && me().ready)) return;
  M.busy = true;
  const res = await call('mp_ready', { p_match: M.matchId });
  M.busy = false;
  if (!res.ok) return fail(res.error, ready);
  track('multiplayer_player_ready');
  apply(res.data);
}

async function leave(where = 'title') {
  if (M.matchId) {
    const id = M.matchId;
    const res = await call('mp_leave', { p_match: id });
    if (res.ok) apply(res.data);
  }
  endLocal();
  A.go(where);
}

// Forget the match on this device (the server keeps the record).
function endLocal() {
  M.game = false;
  S().mpGame = false;
  setMatch(null, null);
  M.state = null;
  M.token = '';
  M.inviteUrl = '';
}

async function rematch() {
  if (M.busy || M.rematchAsked) return;
  M.busy = true;
  const res = await call('mp_rematch', { p_match: M.matchId });
  M.busy = false;
  if (!res.ok) {
    if (res.error === 'declined') return note(say('declined'));
    return fail(res.error, rematch);
  }
  M.rematchAsked = true;
  track('multiplayer_rematch_requested');
  apply(res.data);
}

// Any state from the server lands here; the screen follows it.
function apply(st, quiet) {
  if (!st || !st.match) return;
  const before = M.state;
  M.state = st;
  M.offline = false;
  const m = st.match;
  const was = before && before.match && before.match.id === m.id ? before.match.status : null;
  if (!quiet && was !== m.status) onStatus(was, m.status);
  if (before && before.opponent && st.opponent && before.match.id === m.id) {
    const a = before.opponent.connection;
    const b = st.opponent.connection;
    if (a === 'online' && b === 'reconnecting') note(st.opponent.name + ' LOST CONNECTION. WAITING 30 S...');
    if (a === 'reconnecting' && b === 'online') note(st.opponent.name + ' IS BACK');
    if (b === 'timeout' && a !== 'timeout') note(st.opponent.name + ' DID NOT COME BACK IN 30 S');
  }
  // A rematch both asked for: move to the new match.
  if (m.status === 'completed' && m.rematch_id && M.rematchAsked) {
    M.rematchAsked = false;
    setMatch(m.rematch_id, M.role);
    track('multiplayer_rematch_started');
    M.pollAt = 0;
    A.go('mpready');
  }
}

function onStatus(was, now) {
  const s = S();
  if (now === 'waiting_for_ready' && was === 'waiting' && M.role === 'host') {
    // The friend is in. If the host is playing The Rally, put it aside.
    A.audio.sfx('power');
    A.haptics.play('power');
    if (s.game && !s.mpGame && ['countdown', 'play', 'paused'].includes(s.screen)) stashSolo();
    A.go('mpready');
  }
  if (now === 'starting' || (now === 'active' && !M.game && me() && !me().finished)) startGame();
  if (now === 'completed') {
    M.game = false;
    s.mpGame = false;
    const r = match().result === 'draw' ? 'draw' : match().winner === 'me' ? 'won' : 'lost';
    const dur = M.t.started ? Math.round((Date.now() - M.t.started) / 1000) : null;
    const props = { result: r, final_score: me().final_score, opponent_score: opp() && opp().final_score, level_reached: me().court, match_duration_s: dur, active_gameplay_s: Math.round(activeMs() / 1000), reconnect_count: M.reconnects };
    once('completed', 'multiplayer_match_completed', props);
    once('result', r === 'won' ? 'multiplayer_match_won' : r === 'lost' ? 'multiplayer_match_lost' : 'multiplayer_match_draw', props);
    A.go('mpresult');
  }
  if (now === 'cancelled' || now === 'expired') {
    if (now === 'expired') track('multiplayer_invite_expired');
    const why = match().result === 'ready_timeout' ? 'ready_timeout' : now === 'expired' ? 'expired' : match().result === 'abandoned' ? 'abandoned' : 'cancelled';
    endLocal();
    if (s.mpGame || ['mpinvite', 'mpready', 'countdown', 'play', 'paused'].includes(s.screen)) fail(why, null);
  }
}

// ---------------------------------------------------------------- the game

function stashSolo() {
  const s = S();
  M.stash = { run: s.run, game: s.game, level: s.level, coach: s.coach };
  s.coach = null;
  track('multiplayer_match_paused', { what: 'solo_rally', reason: 'friend_joined' });
}

function restoreSolo() {
  const s = S();
  const st = M.stash;
  M.stash = null;
  if (!st) return A.go('title');
  s.run = st.run;
  s.level = st.level;
  s.coach = st.coach;
  s.game = st.game;
  s.mpGame = false;
  A.go('paused');
}

// Both ready: the server has set the start time. Build this player's game
// (from the server's verified numbers, so a rejoin restores them) and run
// the countdown to that moment.
function startGame() {
  if (M.game) return;
  const s = S();
  const p = me();
  if (!p) return;
  M.game = true;
  s.mpGame = true;
  M.seq = p.seq || 0;
  M.sent = { score: p.score, court: p.court, lives: p.lives, broken: p.broken || '' };
  M.lastSentAt = Date.now();
  M.retryAt = 0;
  M.retryMs = 0;
  M.ended = null;
  const startAt = match().start_at || serverNow();
  const wait = Math.max(0, (startAt - serverNow()) / 1000);
  if (!M.t.started) M.t.started = Date.now();
  A.startMatchGame(p.court - 1, { lives: p.lives, score: p.score }, p.broken || '', wait);
  once('countdown', 'multiplayer_countdown_started');
  once('mready', 'multiplayer_match_ready');
}

// main.js: the countdown ran out and the ball is in play.
export function onPlayStarted() {
  if (!M.game) return;
  M.t.activeFrom = Date.now();
  once('started', 'multiplayer_match_started', { waiting_s: M.t.created ? Math.round((Date.now() - M.t.created) / 1000) : null });
  once('gp' + me().court, 'multiplayer_gameplay_started', { level: me().court });
}

function activeMs() {
  return M.t.activeMs + (M.t.activeFrom ? Date.now() - M.t.activeFrom : 0);
}

export function onPause(paused) {
  if (!M.game) return;
  if (paused && M.t.activeFrom) {
    M.t.activeMs += Date.now() - M.t.activeFrom;
    M.t.activeFrom = 0;
    track('multiplayer_match_paused', { what: 'match' });
  } else if (!paused && !M.t.activeFrom) {
    M.t.activeFrom = Date.now();
    track('multiplayer_match_resumed');
  }
}

// Which bricks of this court are broken, as a bitmap (base64): sent with
// each checkpoint so a rejoin can rebuild the court without giving those
// points again.
function brokenMap(g) {
  const n = g.blocks.length;
  const bytes = new Uint8Array(Math.ceil(n / 8));
  g.blocks.forEach((b, i) => {
    if (!b.alive) bytes[i >> 3] |= 1 << (i & 7);
  });
  let s = '';
  for (const v of bytes) s += String.fromCharCode(v);
  return btoa(s);
}
export function applyBroken(g, map) {
  if (!map) return;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(map), (c) => c.charCodeAt(0));
  } catch {
    return;
  }
  g.blocks.forEach((b, i) => {
    if (b.alive && bytes[i >> 3] & (1 << (i & 7))) {
      b.alive = false;
      g.remaining--;
    }
  });
}

function snapshot(done) {
  const s = S();
  const g = s.game;
  if (!g || !M.game) return null;
  // A won court sends every brick broken: the server allows the clear bonus only for that.
  const over = M.ended && !M.ended.won;
  return { score: g.score, court: s.level + 1, lives: over ? 0 : g.lives, broken: brokenMap(g), done: !!done || !!M.ended };
}

async function checkpoint(snap) {
  if (!snap || M.sending) return;
  M.sending = true;
  const seq = M.seq + 1;
  const res = await call('mp_checkpoint', { p_match: M.matchId, p_seq: seq, p_score: snap.score, p_court: snap.court, p_lives: snap.lives, p_broken: snap.broken, p_done: snap.done });
  M.sending = false;
  M.lastSentAt = Date.now();
  if (!res.ok) {
    M.retryMs = M.retryMs ? Math.min(M.retryMs * 2, RETRY_MAX_MS) : RETRY_MS;
    M.retryAt = M.lastSentAt + M.retryMs;
    if (res.error === 'network' || res.error === 'timeout') return (M.offline = true);
    if (res.error === 'not_started') return;
    // The server refused the numbers: take its verified state back.
    track('multiplayer_invite_failed', { error_category: 'checkpoint_' + res.error, step: 'play' });
    M.pollAt = 0;
    return;
  }
  M.seq = seq;
  M.sent = snap;
  M.retryAt = 0;
  M.retryMs = 0;
  apply(res.data);
}

// main.js: this player's run ended (out of lives, or the last court cleared).
export function onRunEnd(won) {
  // Remembered, so every checkpoint from now on says so (a retry included).
  M.ended = { won };
  const snap = snapshot();
  // One checkpoint at a time: if one is on its way, the next tick sends this
  // (two at once would share a sequence number, and the second be ignored).
  if (snap && !M.sending) checkpoint(snap);
  if (M.t.activeFrom) {
    M.t.activeMs += Date.now() - M.t.activeFrom;
    M.t.activeFrom = 0;
  }
  track('multiplayer_player_finished', { final_score: snap && snap.score, level_reached: snap && snap.court, reason: won ? 'all_courts' : 'out_of_lives' });
  A.go('mpwait');
}

// main.js: a court was cleared and the next one starts.
export function onCourtCleared(court) {
  if (!M.game) return;
  track('multiplayer_level_completed', { level: court });
}

// ---------------------------------------------------------------- every frame

export function tickMultiplayer() {
  if (!M.matchId) return;
  const now = Date.now();
  const m = match();
  // Read the state (heartbeat) on a timer, or at once when Realtime says so.
  const live = !m || !TERMINAL.has(m.status) || S().screen === 'mpresult';
  if (live && !M.polling && now >= M.pollAt) {
    M.polling = true;
    M.pollAt = now + POLL_MS;
    call('mp_state', { p_match: M.matchId }).then((res) => {
      M.polling = false;
      if (res.ok) {
        if (M.offline) {
          M.reconnects++;
          track('multiplayer_reconnect_succeeded', { cause: 'network' });
        }
        apply(res.data);
        if (M.game && me() && me().finished && S().screen !== 'mpwait' && S().screen !== 'mpresult') {
          // Ended on the server: timed out, or the match's time ran out.
          if (me().finish_reason === 'time_up') note("TIME'S UP");
          A.go('mpwait');
        }
      } else if (res.error === 'not_member') {
        endLocal();
      } else if (!M.offline) {
        M.offline = true;
        track('multiplayer_connection_lost', { error_category: res.error });
        track('multiplayer_reconnect_started', { cause: 'network' });
      }
    });
  }
  // Checkpoints from a running game: every 2 s if anything changed, at once
  // when a life is lost, a court changes or the run has ended (until the
  // server says this player is finished).
  if (M.game && m && m.status === 'active' && me() && !me().finished) {
    const snap = snapshot(false);
    const sent = M.sent;
    if (snap && sent && !M.sending && now >= M.retryAt) {
      const urgent = snap.lives !== sent.lives || snap.court !== sent.court || (snap.done && !sent.done);
      const changed = urgent || snap.score !== sent.score || snap.broken !== sent.broken;
      if (urgent || (changed && now - M.lastSentAt >= CHECKPOINT_MS)) checkpoint(snap);
    }
  }
}

// ---------------------------------------------------------------- HUD

// The opponent, compact, top right under the HUD (where the solo place tag goes).
export function drawOpponentHUD() {
  const o = opp();
  if (!M.game || !o) return;
  const rows = hudRows();
  const conn = o.finished ? 'DONE' : o.connection === 'online' ? '' : o.connection === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  const line1 = 'VS ' + o.name;
  const line2 = 'C' + o.court + ' ' + o.score;
  // The clock: always once the opponent is done (the grace), else in the last minutes.
  const left = timeLeft();
  const clock = left != null && (inGrace() || left <= CLOCK_SHOW_MS) ? (inGrace() ? 'FINISH IN ' : 'TIME ') + mmss(left) : '';
  const w = Math.max(textW(line1), textW(line2) + 22, conn ? textW(conn) : 0, clock ? textW(clock) : 0) + 12;
  const h = 25 + (conn ? 8 : 0) + (clock ? 8 : 0);
  const x = W - w - 5;
  const y = rows.tag;
  rrect(x - 1, y - 1, w + 2, h + 2, 5, PAL.ink);
  rrect(x, y, w, h, 4, PAL.panel);
  const dot = o.finished ? '#8a948c' : o.connection === 'online' ? '#5fd35f' : o.connection === 'reconnecting' ? PAL.yellow : '#e0503a';
  rect(x + 5, y + 5, 3, 3, dot);
  text(line1, x + 11, y + 3, PAL.cream);
  text(line2, x + 6, y + 13, PAL.yellow);
  for (let i = 0; i < 3; i++) rect(x + w - 20 + i * 5, y + 15, 3, 3, i < o.lives ? PAL.yellow : '#3c5a48');
  if (conn) text(conn, x + 6, y + 23, o.connection === 'reconnecting' ? PAL.yellow : PAL.dim);
  if (clock) text(clock, x + 6, y + (conn ? 31 : 23), left <= 60000 ? '#ff8a6a' : PAL.yellow);
  M.shown.clock = clock;
  if (M.offline) {
    const msg = 'RECONNECTING...';
    const mw = textW(msg) + 12;
    rrect(W / 2 - mw / 2, rows.toast + 40, mw, 13, 4, PAL.ink);
    text(msg, W / 2, rows.toast + 43, PAL.yellow, { align: 'center' });
  }
  drawNote(rows.toast + 22);
}

function drawNote(y) {
  const s = S();
  if (!M.note || s.time - M.noteT > 3) return;
  const mw = textW(M.note) + 14;
  ctx.globalAlpha = clamp((3 - (s.time - M.noteT)) * 2, 0, 1);
  rrect(W / 2 - mw / 2 - 1, y - 1, mw + 2, 15, 5, PAL.ink);
  rrect(W / 2 - mw / 2, y, mw, 13, 4, PAL.panel);
  text(M.note, W / 2, y + 3, PAL.cream, { align: 'center' });
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- typing

export function typing() {
  const sc = S().screen;
  return sc === 'mpname' || (sc === 'mpjoin' && M.joinInfo && M.joinInfo.status === 'valid');
}
export function typeChar(ch) {
  if (ch === 'del') M.name = M.name.slice(0, -1);
  else if (M.name.length < 8 && (KEYS + DIGITS + ' ').includes(ch)) M.name += ch;
}
export function submitName() {
  if (!M.name.trim()) return note(say('bad_name'));
  if (S().screen === 'mpjoin') joinMatch();
  else createMatch();
}

function keyboard(x, y) {
  const key = (ch, kx, ky, kw) => {
    const id = 'key' + ch;
    const on = ui.hover === id || ui.pressed === id;
    rect(kx, ky, kw, 18, PAL.creamLo);
    rect(kx, ky, kw, 17, on ? PAL.yellow : '#f8f2dd');
    text(ch === 'del' ? '<' : ch, kx + Math.ceil(kw / 2), ky + 5, PAL.ink, { align: 'center' });
    region(id, kx, ky, kw + 1, 19, () => typeChar(ch));
  };
  [...DIGITS].forEach((ch, i) => key(ch, x + Math.round(i * 18.3), y, 17));
  [...KEYS, 'del'].forEach((ch, i) => key(ch, x + (i % 7) * 26, y + 19 + Math.floor(i / 7) * 19, 25));
}

function nameBox(y) {
  rect(W / 2 - 58, y, 116, 21, PAL.ink);
  rect(W / 2 - 57, y + 1, 114, 19, PAL.panel);
  const shown = M.name + (M.name.length < 8 && Math.floor(S().time * 2.5) % 2 ? '_' : '');
  text(shown || ' ', W / 2 - 50, y + 4, PAL.yellow, { scale: 2, sp: 1 });
}

// ---------------------------------------------------------------- sharing

function inviteMessage() {
  return `${(me() && me().name) || M.name} challenged you to The Court! Tap to play (link works for 1 hour): ${M.inviteUrl}`;
}

// The invite image ("<HOST> HAS CHALLENGED YOU!"), made once per invite link
// and kept ready as a file, so sharing happens inside the tap (browsers only
// allow the share sheet and new windows straight from a tap).
function inviteCard() {
  const host = (me() && me().name) || M.name;
  const key = M.inviteUrl + '|' + host;
  if (!M.invite || M.invite.key !== key) {
    const canvas = drawInviteCard({ host, theme: A.courtTheme(), url: M.inviteUrl });
    const bin = atob(canvas.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    M.invite = { key, canvas, file: new File([bytes], 'the-court-challenge.png', { type: 'image/png' }) };
  }
  return M.invite;
}

// WhatsApp and Share both send the image with the message and link. On a
// phone that is the share sheet (pick WhatsApp there). Where a browser cannot
// share files (most laptops), WhatsApp opens with the message and the image
// is saved to attach; Share copies the link and saves the image.
function shareInvite(kind) {
  track('multiplayer_invite_shared', { channel: kind });
  if (kind === 'copy') return copy(M.inviteUrl, 'LINK COPIED');
  let file = null;
  try {
    file = inviteCard().file;
  } catch {
    /* no image: the text and link still go */
  }
  const withFile = file && navigator.canShare && navigator.canShare({ files: [file] });
  if (withFile) {
    return navigator.share({ files: [file], title: 'The Court', text: inviteMessage() }).catch((e) => {
      if (e && e.name === 'AbortError') note('SHARE CANCELLED');
      else copy(M.inviteUrl, 'LINK COPIED');
    });
  }
  if (kind === 'whatsapp') {
    window.open('https://wa.me/?text=' + encodeURIComponent(inviteMessage()), '_blank', 'noopener');
    if (file) {
      download(file);
      note('IMAGE SAVED: ATTACH IT IN WHATSAPP');
    }
    return;
  }
  if (navigator.share) {
    return navigator.share({ title: 'The Court', text: inviteMessage(), url: M.inviteUrl }).catch((e) => {
      if (e && e.name === 'AbortError') note('SHARE CANCELLED');
    });
  }
  if (file) download(file);
  copy(M.inviteUrl, file ? 'IMAGE SAVED, LINK COPIED' : 'LINK COPIED');
}

async function copy(str, msg) {
  try {
    await navigator.clipboard.writeText(str);
    note(msg);
    return true;
  } catch {
    note('COPY NOT ALLOWED HERE');
    return false;
  }
}

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function gameUrl() {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('utm_source', 'mp_result');
  return u.toString();
}

async function shareResult() {
  track('multiplayer_result_share_clicked');
  const r = resultKind();
  const m1 = { name: me().name, score: me().final_score ?? me().score, court: me().court };
  const o1 = { name: opp().name, score: opp().final_score ?? opp().score, court: opp().court };
  let file;
  try {
    const card = drawResultStory({ me: m1, opp: o1, result: r, theme: A.courtTheme(), url: gameUrl() });
    file = new File([await toBlob(card)], 'the-court-result.png', { type: 'image/png' });
    track('multiplayer_result_image_generated');
  } catch {
    copy(gameUrl(), say('image'));
    return;
  }
  const msg = r === 'draw' ? `${m1.name} and ${o1.name} drew ${m1.score}-${o1.score} on The Court. Can you beat your friend?` : `${r === 'won' ? m1.name : o1.name} won ${Math.max(m1.score, o1.score)}-${Math.min(m1.score, o1.score)} on The Court. Can you beat your friend?`;
  track('multiplayer_result_share_attempted');
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'The Court', text: `${msg} ${gameUrl()}` });
      return note('SHARED');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return note('SHARE CANCELLED');
  }
  download(file);
  track('multiplayer_result_image_downloaded');
  if (await copy(`${msg} ${gameUrl()}`, 'IMAGE SAVED, LINK COPIED')) track('multiplayer_result_link_copied');
}

// ---------------------------------------------------------------- lists

async function loadBoard() {
  M.board = { state: 'loading', rows: [] };
  const res = await call('mp_leaderboard');
  M.board = res.ok ? { state: 'ok', rows: res.data || [] } : { state: 'error', rows: [], error: res.error };
}
async function loadHistory() {
  M.history = { state: 'loading', rows: [] };
  const res = await call('mp_history');
  M.history = res.ok ? { state: 'ok', rows: res.data || [] } : { state: 'error', rows: [], error: res.error };
}

// ---------------------------------------------------------------- screens

const resultKind = () => (match() && match().result === 'draw' ? 'draw' : match() && match().winner === 'me' ? 'won' : 'lost');

function route(fromResume) {
  const m = match();
  if (!m) return;
  if (m.status === 'waiting') A.go(M.role === 'host' ? 'mpinvite' : 'mpready');
  else if (m.status === 'waiting_for_ready') A.go('mpready');
  else if (m.status === 'starting' || m.status === 'active') {
    if (me() && me().finished) A.go('mpwait');
    else if (fromResume) startGame();
  } else if (m.status === 'completed') A.go('mpresult');
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function wrapped(str, x, y, c, max = W - 40) {
  wrap(str, max).forEach((l, i) => text(l, x, y + i * 10, c, { align: 'center' }));
  return wrap(str, max).length * 10;
}

function box(k, h, style, draw) {
  const w = Math.min(W - 16, 220);
  const x = Math.round((W - w) / 2);
  const y = Math.max(6, Math.round((H - h) / 2));
  panel(k, x, y, w, h, style, () => draw(x, y, w));
  return { x, y, w };
}

function boardBack() {
  const to = M.boardFrom || (M.matchId && match() && match().status === 'completed' ? 'mpresult' : 'mp');
  M.boardFrom = null;
  A.go(to);
}

// The two players' colours: your racket is strung blue, your friend's red.
const STRINGS = { me: '#2d4f9a', opp: '#a8323a' };

function racketHead(cx, cy, strings) {
  for (let i = 0; i < 5; i++) rect(cx + 4 + i, cy + 5 + i, 2, 2, i > 2 ? '#8a5a2b' : '#c98a4e');
  disc(cx, cy, 7, PAL.ink);
  disc(cx, cy, 6, PAL.cream);
  disc(cx, cy, 5, strings);
  ctx.fillStyle = '#f4f1de';
  for (let d = -4; d <= 4; d += 2) {
    ctx.fillRect(cx + d, cy - 4, 1, 9);
    ctx.fillRect(cx - 4, cy + d, 9, 1);
  }
}

// A small rounded badge with its label, right-aligned at rx.
function badge(label, rx, y, fill, ink) {
  const bw = textW(label) + 10;
  rrect(rx - bw, y, bw, 11, 4, PAL.ink);
  rrect(rx - bw + 1, y + 1, bw - 2, 9, 3, fill);
  text(label, rx - bw + 5, y + 2, ink);
  return bw;
}

// A player's tile: racket, who it is, their name, and a status badge.
function playerTile(x, y, w, p, label, strings, status, good) {
  rrect(x, y, w, 26, 5, good ? '#3f9a4f' : '#2f5a40');
  rrect(x + 1, y + 1, w - 2, 24, 4, '#0d1f16');
  racketHead(x + 13, y + 12, strings);
  text(label, x + 28, y + 5, PAL.dim);
  text(p ? p.name : '...', x + 28, y + 14, PAL.cream, { sp: 1 });
  badge(status, x + w - 6, y + 8, good ? '#5fd35f' : status === 'AWAY' ? '#e0503a' : PAL.yellow, PAL.ink);
}

// A bar that empties as time runs out (left / total, in ms).
function timeBar(x, y, w, left, total, label) {
  const f = clamp(left / total, 0, 1);
  rrect(x - 1, y - 1, w + 2, 7, 3, PAL.ink);
  rect(x, y, w, 5, '#0d1f16');
  rect(x, y, Math.round(w * f), 5, f < 0.2 ? '#ff8a6a' : PAL.yellow);
  rect(x, y, Math.round(w * f), 1, f < 0.2 ? '#ffc0a8' : PAL.yellowHi);
  text(label, x + w / 2, y + 9, PAL.dim, { align: 'center' });
}

export const MP_SCREENS = {
  mp(k) {
    const s = S();
    const on = mpEnabled();
    const open = M.matchId && match() && !TERMINAL.has(match().status);
    const cards = on ? (open ? 4 : 3) : 0;
    const h = on ? 74 + cards * 41 + 26 : 140;
    box(k, h, 'dark', (x, y, w) => {
      // Header: the crossed rackets over the title, as on the landing card.
      cardArt.rackets(W / 2 - 22, y + 4, 44, 26, s.time);
      serif('MULTIPLAYER', W / 2 + 2, y + 28, 14, PAL.cream, { align: 'center', sp: 2, shadow: PAL.ink });
      text('CHALLENGE YOUR FRIENDS', W / 2, y + 46, PAL.dim, { align: 'center', sp: 1 });
      if (!on) {
        wrapped(say('not_configured'), W / 2, y + 62, PAL.dim, w - 24);
        ghost('back', 'BACK', W / 2, y + h - 24, 104, 15, () => A.go('title'), { icon: 'back' });
        return;
      }
      // The rules at a glance.
      const chips = ['3 LIVES', '30 MIN', 'TOP SCORE WINS'];
      const cw = chips.map((c) => textW(c) + 10);
      let cx = Math.round(W / 2 - (cw.reduce((a, b) => a + b, 0) + 8) / 2);
      chips.forEach((c, i) => {
        rrect(cx, y + 57, cw[i], 12, 4, '#2f5a40');
        rrect(cx + 1, y + 58, cw[i] - 2, 10, 3, '#0d1f16');
        text(c, cx + 5, y + 60, i === 2 ? PAL.yellow : PAL.cream);
        cx += cw[i] + 4;
      });
      const cw2 = w - 20;
      let cy = y + 76;
      const next = () => (cy += 41) - 41;
      if (open) {
        card('mpreturn', 'YOUR MATCH', 'BACK TO IT • IT IS STILL ON', x + 10, next(), cw2, 32, () => route(true), { pulse: s.time, t: s.time, art: cardArt.court });
        card('mphost', 'NEW MATCH', 'HOST ANOTHER • NEW LINK', x + 10, next(), cw2, 32, hostNew, { style: 'dark', t: s.time, art: cardArt.invite });
      } else {
        card('mphost', 'NEW MATCH', 'SEND A LINK • VALID 1 HOUR', x + 10, next(), cw2, 32, hostNew, { pulse: s.time, t: s.time, art: cardArt.invite });
      }
      card('mpboard', 'FRIENDS', 'BOARD • WINS, THEN LOSSES', x + 10, next(), cw2, 32, () => {
        loadBoard();
        A.go('mpboard');
      }, { style: 'dark', t: s.time + 0.7, art: cardArt.cup });
      card('mphistory', 'HISTORY', 'YOUR LAST 20 MATCHES', x + 10, next(), cw2, 32, () => {
        loadHistory();
        A.go('mphistory');
      }, { style: 'dark', t: s.time + 1.4, art: cardArt.list });
      ghost('back', 'BACK', W / 2, y + h - 23, 104, 15, () => A.go('title'), { icon: 'back' });
    });
    s.primary = open ? () => route(true) : on ? hostNew : null;
    s.back = () => A.go('title');
  },

  mpname(k) {
    const s = S();
    const h = 214;
    box(k, h, 'cream', (x, y, w) => {
      serif('YOUR NAME', W / 2 + 1, y + 12, 18, PAL.ink, { align: 'center', sp: 1 });
      text('YOUR FRIEND WILL SEE IT ON THE INVITE', W / 2, y + 34, '#7d7354', { align: 'center' });
      nameBox(y + 46);
      keyboard(x + Math.round((w - 182) / 2), y + 74);
      pill('mpcreate', M.busy ? 'CREATING...' : 'CREATE MATCH', W / 2, y + h - 30, 140, 18, submitName);
      iconBtn('close', 'close', x + w - 23, y + 7, () => A.go('mp'));
      drawNote(y + h + 6);
    });
    s.primary = submitName;
    s.back = () => A.go('mp');
  },

  mpinvite(k) {
    const s = S();
    const m = match();
    const h = 244;
    box(k, h, 'dark', (x, y, w) => {
      serif('INVITE A FRIEND', W / 2 + 2, y + 13, 16, PAL.cream, { align: 'center', sp: 1, shadow: PAL.ink });
      rect(W / 2 - 12, y + 32, 24, 1, PAL.cream);
      // The challenge image, as it will be sent, beside the ways to send it.
      const pw = 72;
      const ph = 90;
      rrect(x + 9, y + 39, pw + 2, ph + 2, 3, PAL.cream);
      try {
        const smooth = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = true; // a small, readable preview of the big image
        ctx.drawImage(inviteCard().canvas, x + 10, y + 40, pw, ph);
        ctx.imageSmoothingEnabled = smooth;
      } catch {
        rect(x + 10, y + 40, pw, ph, '#0d1f16');
      }
      const rx = x + pw + 18;
      const rw = x + w - 10 - rx;
      text('YOUR CHALLENGE', rx + rw / 2, y + 41, PAL.yellow, { align: 'center', sp: 1 });
      text('IMAGE + LINK', rx + rw / 2, y + 51, PAL.dim, { align: 'center' });
      pill('mpshare', 'SHARE', rx + rw / 2, y + 63, rw, 18, () => shareInvite('native'), { sp: 2 });
      ghost('mpwhatsapp', 'WHATSAPP', rx + rw / 2, y + 89, rw, 15, () => shareInvite('whatsapp'), { sp: 1 });
      ghost('mpcopy', 'COPY LINK', rx + rw / 2, y + 110, rw, 15, () => shareInvite('copy'), { sp: 1 });
      const url = M.inviteUrl.replace(/^https?:\/\//, '').toUpperCase();
      const short = url.length > 34 ? url.slice(0, 31) + '...' : url;
      text(short, W / 2, y + 136, PAL.dim, { align: 'center' });
      const left = m ? m.expires_at - serverNow() : 0;
      const dots = '.'.repeat(1 + (Math.floor(s.time * 2) % 3));
      text('WAITING FOR YOUR FRIEND' + dots, W / 2, y + 150, PAL.yellow, { align: 'center' });
      text('INVITE ENDS IN ' + mmss(left), W / 2, y + 161, PAL.dim, { align: 'center' });
      pill('mprally', 'PLAY THE RALLY WHILE YOU WAIT', W / 2, y + 176, w - 24, 18, () => A.playSolo(), { sp: 1 });
      text("WE'LL PAUSE IT WHEN THEY JOIN", W / 2, y + 199, PAL.dim, { align: 'center' });
      ghost('mpcancel', 'CANCEL MATCH', W / 2 - 52, y + 216, 98, 15, () => leave('mp'), { sp: 0 });
      ghost('back', 'BACK', W / 2 + 52, y + 216, 98, 15, () => A.go('mp'), { icon: 'back' });
      drawNote(y + h + 6);
    });
    s.primary = () => shareInvite('native');
    s.back = () => A.go('mp');
  },

  mpjoin(k) {
    const s = S();
    const j = M.joinInfo || { status: 'loading' };
    if (j.status === 'valid') {
      const h = 222;
      box(k, h, 'cream', (x, y, w) => {
        const head = (j.host_name || 'A FRIEND') + ' CHALLENGED YOU!';
        text(head, W / 2, y + 10, '#b3541e', { align: 'center', sp: textW(head, 1, 1) <= w - 20 ? 1 : 0 });
        serif('THE COURT', W / 2 + 1, y + 22, 16, PAL.ink, { align: 'center', sp: 2 });
        text('YOUR NAME', W / 2, y + 44, '#7d7354', { align: 'center' });
        nameBox(y + 54);
        keyboard(x + Math.round((w - 182) / 2), y + 82);
        pill('mpjoinbtn', M.busy ? 'JOINING...' : 'JOIN MATCH', W / 2, y + h - 30, 140, 18, submitName);
        drawNote(y + h + 6);
      });
      s.primary = submitName;
      s.back = () => A.go('title');
      return;
    }
    box(k, 150, 'dark', (x, y, w) => {
      serif('THE COURT', W / 2 + 2, y + 14, 16, PAL.cream, { align: 'center', sp: 2 });
      if (j.status === 'loading') {
        text('OPENING YOUR INVITE' + '.'.repeat(1 + (Math.floor(s.time * 2) % 3)), W / 2, y + 56, PAL.yellow, { align: 'center' });
        return;
      }
      const why = j.status === 'error' ? j.error : j.status;
      wrapped(say(why), W / 2, y + 46, PAL.cream, w - 24);
      if (j.status === 'error') pill('retry', 'TRY AGAIN', W / 2, y + 86, 120, 18, loadInvite);
      else pill('rally', 'PLAY THE RALLY', W / 2, y + 86, 120, 18, () => A.go('title'));
      ghost('mp', 'MULTIPLAYER', W / 2, y + 116, 120, 15, openMultiplayer);
    });
    s.primary = j.status === 'error' ? loadInvite : () => A.go('title');
    s.back = () => A.go('title');
  },

  mpready(k) {
    const s = S();
    const m = match();
    const a = me();
    const b = opp();
    const h = 202;
    box(k, h, 'dark', (x, y, w) => {
      serif('GET READY', W / 2 + 2, y + 13, 16, PAL.cream, { align: 'center', sp: 2, shadow: PAL.ink });
      rect(W / 2 - 12, y + 32, 24, 1, PAL.cream);
      const st = (p) => (!p ? 'WAITING' : p.ready ? 'READY' : p.connection !== 'online' ? 'AWAY' : 'NOT READY');
      playerTile(x + 10, y + 40, w - 20, a, 'YOU', STRINGS.me, st(a), !!(a && a.ready));
      playerTile(x + 10, y + 78, w - 20, b, 'YOUR FRIEND', STRINGS.opp, st(b), !!(b && b.ready));
      // VS between the two tiles.
      rrect(W / 2 - 10, y + 66, 20, 13, 4, PAL.ink);
      text('VS', W / 2, y + 69, PAL.yellow, { align: 'center' });
      if (m && (m.status === 'starting' || m.status === 'active')) {
        text('STARTING...', W / 2, y + 122, PAL.yellow, { align: 'center', sp: 2 });
      } else if (a && !a.ready) {
        card('mpreadybtn', "I'M READY", 'BOTH READY • THE MATCH STARTS', x + 10, y + 112, w - 20, 32, ready, { pulse: s.time, t: s.time, art: cardArt.court });
      } else {
        text('WAITING FOR ' + ((b && b.name) || 'YOUR FRIEND') + '.'.repeat(1 + (Math.floor(s.time * 2) % 3)), W / 2, y + 124, PAL.yellow, { align: 'center' });
      }
      if (m && m.ready_deadline) {
        const left = m.ready_deadline - serverNow();
        timeBar(x + 20, y + 154, w - 40, left, 5 * 60 * 1000, 'READY WITHIN ' + mmss(left));
      }
      ghost('mpleave', 'LEAVE MATCH', W / 2, y + 177, 120, 15, () => leave('mp'), { icon: 'back' });
      drawNote(y + h + 6);
    });
    s.primary = ready;
    s.back = () => leave('mp');
  },

  // Starting from a refresh: the state is on its way.
  mpresume(k) {
    const s = S();
    box(k, 90, 'dark', (x, y) => {
      text('RECONNECTING TO YOUR MATCH' + '.'.repeat(1 + (Math.floor(s.time * 2) % 3)), W / 2, y + 30, PAL.yellow, { align: 'center' });
      ghost('back', 'HOME', W / 2, y + 56, 104, 15, () => A.go('title'));
    });
  },

  mpwait(k) {
    const s = S();
    const a = me();
    const b = opp();
    box(k, 170, 'dark', (x, y, w) => {
      serif("YOU'RE DONE", W / 2 + 2, y + 13, 16, PAL.cream, { align: 'center', sp: 1, shadow: PAL.ink });
      // The scoreboard: you and your friend side by side.
      const half = Math.floor((w - 26) / 2);
      const side = (p, sx, label, strings, live) => {
        rrect(sx, y + 34, half, 52, 5, live ? '#3f9a4f' : '#2f5a40');
        rrect(sx + 1, y + 35, half - 2, 50, 4, '#0d1f16');
        racketHead(sx + 12, y + 46, strings);
        text(label, sx + 24, y + 40, PAL.dim);
        text(p ? p.name : '...', sx + 24, y + 49, PAL.cream, { sp: 1 });
        const sc = String(p ? p.final_score ?? p.score : 0);
        const big = textW(sc, 2, 1) <= half - 10 ? 2 : 1;
        text(sc, sx + half / 2, y + 60, PAL.yellow, { align: 'center', scale: big, shadow: PAL.ink });
        if (p && p.court) text('COURT ' + p.court, sx + half / 2, y + 76, PAL.dim, { align: 'center' });
        if (live && Math.floor(s.time * 2) % 2) rect(sx + half - 7, y + 39, 3, 3, '#5fd35f'); // still playing
      };
      side(a, x + 10, 'YOU', STRINGS.me, false);
      side(b, x + 16 + half, 'FRIEND', STRINGS.opp, !!(b && !b.finished));
      text('VS', W / 2, y + 56, PAL.yellow, { align: 'center' });
      if (b) {
        if (b.connection === 'reconnecting') text('RECONNECTING... UP TO 30 S', W / 2, y + 94, PAL.yellow, { align: 'center' });
        else if (!b.finished && timeLeft() != null) text((M.shown.wait = b.name + ' HAS ' + mmss(timeLeft()) + ' TO FINISH'), W / 2, y + 94, PAL.yellow, { align: 'center' });
      }
      text('THE RESULT APPEARS WHEN BOTH ARE DONE' + '.'.repeat(1 + (Math.floor(s.time * 2) % 3)), W / 2, y + 108, PAL.dim, { align: 'center' });
      ghost('home', 'HOME (SEE IT IN HISTORY)', W / 2, y + 132, w - 30, 15, () => {
        endLocal();
        A.go('title');
      });
      drawNote(y + 176);
    });
    s.back = null;
  },

  mpresult(k) {
    const s = S();
    const a = me();
    const b = opp();
    const m = match();
    if (!a || !b || !m) return;
    const r = resultKind();
    const head = r === 'draw' ? "IT'S A DRAW!" : r === 'won' ? a.name + ' WINS!' : 'YOU LOST';
    const h = M.stash ? 236 : 214;
    box(k, h, 'cream', (x, y, w) => {
      const hs = textW(head, 2, 1) <= w - 20 ? 2 : 1;
      text(head, W / 2, y + 12, r === 'lost' ? '#b3541e' : PAL.ink, { align: 'center', scale: hs, sp: 1 });
      if (r === 'won') {
        sparkle(x + 16, y + 18, 2);
        sparkle(x + w - 18, y + 14, 1, '#ff6fa8');
      }
      const col = (p, cx, won) => {
        text(p.name, cx, y + 42, won ? '#b3541e' : PAL.ink, { align: 'center', sp: 1 });
        text(String(p.final_score ?? p.score), cx, y + 54, PAL.ink, { align: 'center', scale: 2, sp: 1 });
        text('COURT ' + p.court, cx, y + 72, '#7d7354', { align: 'center' });
      };
      col(a, W / 2 - w / 4, r === 'won');
      col(b, W / 2 + w / 4, r === 'lost');
      rect(W / 2, y + 40, 1, 40, PAL.creamLo);
      text('VERIFIED RESULT. MATCH COMPLETE.', W / 2, y + 88, '#3f7d38', { align: 'center' });
      const rm = b.declined ? 'DECLINED' : M.rematchAsked || a.rematch ? 'ASKED' : '';
      if (b.rematch && !a.rematch && !b.declined) text(b.name + ' WANTS A REMATCH!', W / 2, y + 100, '#b3541e', { align: 'center' });
      pill('mprematch', rm === 'ASKED' ? 'WAITING FOR ' + b.name : rm === 'DECLINED' ? 'NO REMATCH' : 'REMATCH', W / 2, y + 112, 150, 19, rematch, { sp: 1 });
      ghost('mpsharer', 'SHARE RESULT', W / 2, y + 142, 150, 15, shareResult);
      ghost('mpboard', 'FRIENDS BOARD', W / 2, y + 163, 150, 15, () => {
        loadBoard();
        A.go('mpboard');
      });
      const home = () => {
        call('mp_decline', { p_match: M.matchId });
        endLocal();
        A.go('title');
      };
      ghost('home', 'HOME', W / 2, y + 184, 150, 15, home);
      if (M.stash) {
        ghost('mpsolo', 'BACK TO YOUR RALLY', W / 2, y + 205, 150, 15, () => {
          call('mp_decline', { p_match: M.matchId });
          endLocal();
          restoreSolo();
        });
      }
      drawNote(y + h + 6);
    });
    s.primary = rematch;
    s.back = null;
  },

  mpboard(k) {
    const s = S();
    const B = M.board;
    const h = Math.min(H - 12, 260);
    box(k, h, 'dark', (x, y, w) => {
      serif('FRIENDS BOARD', W / 2 + 2, y + 12, 16, PAL.cream, { align: 'center', sp: 1 });
      text('RANKED BY WINS, THEN FEWER LOSSES', W / 2, y + 32, PAL.dim, { align: 'center' });
      const cols = [x + 10, x + 26, x + w - 70, x + w - 52, x + w - 34, x + w - 14];
      ['', 'PLAYER', 'W', 'L', 'D', 'M'].forEach((t, i) => text(t, cols[i], y + 44, PAL.dim, { align: i >= 2 ? 'right' : 'left' }));
      rect(x + 8, y + 53, w - 16, 1, '#2f6b47');
      if (B.state === 'loading') text('LOADING...', W / 2, y + 70, PAL.yellow, { align: 'center' });
      else if (B.state === 'error') {
        wrapped(say(B.error) , W / 2, y + 64, PAL.cream, w - 24);
        pill('retry', 'TRY AGAIN', W / 2, y + 96, 110, 17, loadBoard);
      } else if (!B.rows.length) wrapped('NO MATCHES YET. HOST ONE AND INVITE A FRIEND!', W / 2, y + 66, PAL.cream, w - 24);
      const max = Math.floor((h - 92) / 16);
      const MEDAL = ['#f2b632', '#c9d3d6', '#d08a4e']; // gold, silver, bronze
      B.rows.slice(0, max).forEach((r, i) => {
        const ry = y + 61 + i * 16;
        if (r.me) rrect(x + 7, ry - 3, w - 14, 13, 3, '#1d4a31');
        const c = r.me ? PAL.yellow : PAL.cream;
        if (r.rank <= 3) {
          // A medal for the top three, its number on it.
          disc(cols[0] + 4, ry + 3, 7, PAL.ink);
          disc(cols[0] + 4, ry + 3, 6, MEDAL[r.rank - 1]);
          text(String(r.rank), cols[0] + 5, ry, PAL.ink, { align: 'center' });
        } else text(String(r.rank), cols[0] + 5, ry, c, { align: 'center' });
        text(r.name, cols[1], ry, c);
        text(String(r.wins), cols[2], ry, c, { align: 'right' });
        text(String(r.losses), cols[3], ry, c, { align: 'right' });
        text(String(r.draws), cols[4], ry, c, { align: 'right' });
        text(String(r.matches), cols[5], ry, c, { align: 'right' });
      });
      ghost('back', 'BACK', W / 2, y + h - 24, 104, 15, boardBack, { icon: 'back' });
    });
    s.back = boardBack;
  },

  mphistory(k) {
    const s = S();
    const Hs = M.history;
    const h = Math.min(H - 12, 260);
    box(k, h, 'dark', (x, y, w) => {
      serif('MATCH HISTORY', W / 2 + 2, y + 12, 16, PAL.cream, { align: 'center', sp: 1 });
      if (Hs.state === 'loading') text('LOADING...', W / 2, y + 60, PAL.yellow, { align: 'center' });
      else if (Hs.state === 'error') {
        wrapped(say(Hs.error), W / 2, y + 50, PAL.cream, w - 24);
        pill('retry', 'TRY AGAIN', W / 2, y + 84, 110, 17, loadHistory);
      } else if (!Hs.rows.length) wrapped('NO MATCHES YET. YOUR GAMES WITH FRIENDS SHOW UP HERE.', W / 2, y + 52, PAL.cream, w - 24);
      const max = Math.floor((h - 70) / 22);
      Hs.rows.slice(0, max).forEach((r, i) => {
        const ry = y + 36 + i * 22;
        rrect(x + 8, ry, w - 16, 20, 4, '#0d1f16');
        const ms = r.me_score ?? r.me_live;
        const os = r.opp_score ?? r.opp_live;
        text(`${ms}`, x + 13, ry + 3, PAL.yellow);
        text(`- ${os} ${r.opp_name}`, x + 17 + textW(String(ms)), ry + 3, PAL.cream);
        const out = r.outcome === 'won' ? 'WON' : r.outcome === 'lost' ? 'LOST' : r.outcome === 'draw' ? 'DRAW' : r.status === 'active' || r.status === 'starting' ? 'PLAYING' : r.status.replace(/_/g, ' ').toUpperCase();
        const tone = r.outcome === 'won' ? ['#5fd35f', PAL.ink] : r.outcome === 'lost' ? ['#e0503a', '#fff3e8'] : ['#4a5a4e', PAL.cream];
        badge(out, x + w - 12, ry + 4, tone[0], tone[1]);
        const d = new Date(r.at);
        const when = d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase().replace(',', '');
        text(when, x + 13, ry + 12, PAL.dim);
      });
      ghost('back', 'BACK', W / 2, y + h - 24, 104, 15, () => A.go('mp'));
    });
    s.back = () => A.go('mp');
  },

  mperror(k) {
    const s = S();
    const e = M.error || { reason: 'server' };
    box(k, 140, 'dark', (x, y, w) => {
      serif('OOPS', W / 2 + 2, y + 13, 16, PAL.cream, { align: 'center', sp: 3 });
      wrapped(say(e.reason), W / 2, y + 42, PAL.cream, w - 24);
      if (e.retry) pill('retry', 'TRY AGAIN', W / 2, y + 80, 120, 18, () => {
        const f = e.retry;
        M.error = null;
        f();
      });
      ghost('mp', 'MULTIPLAYER', W / 2, y + (e.retry ? 108 : 84), 120, 15, () => A.go('mp'));
      if (M.stash) ghost('mpsolo', 'BACK TO YOUR RALLY', W / 2, y + (e.retry ? 128 : 104), 140, 15, restoreSolo);
    });
    s.back = () => A.go('mp');
  },
};

function hostNew() {
  M.nameFor = 'host';
  M.name = M.name || A.save.data.lastName || '';
  M.request = null;
  if (!mpEnabled()) return fail('not_configured');
  A.go('mpname');
}

// Pause menu: LEAVE MATCH. This player's game ends at their verified score; the friend plays on.
export function leaveMatch() {
  const snap = snapshot(false);
  M.game = false;
  S().mpGame = false;
  call('mp_leave', { p_match: M.matchId }).then((res) => res.ok && apply(res.data));
  track('multiplayer_player_finished', { final_score: snap && snap.score, level_reached: snap && snap.court, reason: 'left' });
  A.go('mpwait');
}

export const MP_SCREEN_NAMES = Object.keys(MP_SCREENS);
export const mp = M; // for the tests
export const _worthReading = worthReading; // for the tests
