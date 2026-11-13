// Server-side tests for the multiplayer database (supabase/multiplayer/*.sql),
// run against a throwaway in-memory Postgres (PGlite), never a real project.
//
//     npm install --prefix /some/scratch/dir @electric-sql/pglite@0.3
//     PGLITE=/some/scratch/dir node tests/mp_server_test.mjs
//
// It stands in the few Supabase pieces the SQL relies on (auth.uid(), the
// anon and authenticated roles, the Realtime publication), applies the real
// files, then plays honest and dishonest clients against mp_checkpoint and
// the other functions, as the browser would call them.

import { readFileSync, readdirSync } from 'node:fs';
import { brickPoints, BLOCKS, Game, MAX_BALLS, MATCH_WEIGHTS } from '../js/game.js';
import { LEVELS, matchLevel } from '../js/levels.js';
import { courtBricks, courtsSql } from '../scripts/mp_courts.mjs';

const dir = process.env.PGLITE;
if (!dir) {
  console.error('Set PGLITE to the folder where @electric-sql/pglite is installed.');
  process.exit(2);
}
const { PGlite } = await import(`${dir}/node_modules/@electric-sql/pglite/dist/index.js`);
const { pgcrypto } = await import(`${dir}/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js`);

const root = new URL('../supabase/multiplayer/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto } });

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
}

// ---------------------------------------------------------------- setup

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create schema extensions;
  grant usage on schema extensions to anon, authenticated;
  create publication supabase_realtime;
  grant usage on schema public to anon, authenticated;
  -- As on Supabase: new tables and functions in public start out granted to both roles.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`);
const files = readdirSync(root).filter((f) => /^00[123]_.*\.sql$/.test(f)).sort();
for (const f of files) {
  try {
    await db.exec(readFileSync(new URL(f, root), 'utf8'));
  } catch (e) {
    console.log(`FAIL  ${f} does not apply  -> ${e.message}`);
    process.exit(1);
  }
}
check('the SQL files apply cleanly: ' + files.join(', '), true);

// ---------------------------------------------------------------- permissions, as installed

{
  const q = async (sql) => (await db.query(sql)).rows;
  const anonFns = (await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).map((r) => r.proname);
  check('the anonymous role can call only submit_score (not mp_is_member or any match function)', anonFns.join() === 'submit_score', anonFns.join());
  const member = (await q(`select has_function_privilege('authenticated', 'public.mp_is_member(uuid)', 'execute') ok`))[0].ok;
  check('signed-in players can still call mp_is_member (the read policies need it)', member === true);
  const solo = (await q(`select grantee, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'thecourt' and grantee in ('anon', 'authenticated') group by 1 order by 1`)).map((r) => r.grantee + ':' + r.p);
  check('the solo board (dev copy) is SELECT only for both roles (no REFERENCES or TRIGGER left)', solo.join() === 'anon:SELECT,authenticated:SELECT', solo.join());
  const mpt = (await q(`select table_name || '/' || grantee || ':' || string_agg(privilege_type, ',' order by privilege_type) r from information_schema.role_table_grants
      where table_schema = 'public' and table_name like 'multiplayer%' and grantee in ('anon', 'authenticated') group by table_name, grantee order by 1`)).map((r) => r.r);
  check('multiplayer tables: signed-in players may only read matches and players; nothing else for anyone',
    mpt.join() === 'multiplayer_matches/authenticated:SELECT,multiplayer_players/authenticated:SELECT', mpt.join());
}

// ---------------------------------------------------------------- helpers

const BRICKS = courtBricks();
const MAX = { T: 30, L: 45, H: 90, S: 150 };
const uuid = () => crypto.randomUUID();

// Run one call as a signed-in player (or anon / nobody), like PostgREST does.
async function as(user, sql, params = [], role = 'authenticated') {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user || '']);
  await db.exec(`set role ${role}`);
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    const m = /mp:([a-z_]+)/.exec(e.message);
    return { ok: false, error: m ? m[1] : e.message };
  } finally {
    await db.exec('reset role');
  }
}
const rpc = (user, fn, args) => {
  const keys = Object.keys(args);
  return as(user, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k])).then((res) =>
    res.ok ? { ok: true, data: res.rows[0].r } : res);
};

// The bitmap the browser sends: bit i set = brick i broken.
function map(court, idx) {
  const n = BRICKS[court - 1].length;
  const bytes = new Uint8Array(Math.ceil(n / 8));
  for (const i of idx) bytes[i >> 3] |= 1 << (i & 7);
  return Buffer.from(bytes).toString('base64');
}
const all = (court) => [...BRICKS[court - 1]].map((_, i) => i);
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const worth = (court, idx) => idx.reduce((s, i) => s + MAX[BRICKS[court - 1][i]], 0);
const least = (court, idx) => idx.reduce((s, i) => s + brickPoints(BRICKS[court - 1][i], 1), 0);
const player = async (match, user) => (await db.query('select * from public.multiplayer_players where match_id = $1 and user_id = $2', [match, user])).rows[0];
// Let time pass for a player: every clock the server judges them by moves back by secs.
async function later(match, user, secs) {
  await db.query(
    `update public.multiplayer_players set checkpoint_at = checkpoint_at - make_interval(secs => $3), court_started_at = court_started_at - make_interval(secs => $3)
      where match_id = $1 and user_id = $2`,
    [match, user, secs],
  );
  await db.query(`update public.multiplayer_matches set started_at = started_at - make_interval(secs => $2) where id = $1`, [match, secs]);
}

// A match with both players in and the ball in play.
async function activeMatch() {
  const host = uuid();
  const guest = uuid();
  const made = await rpc(host, 'mp_create_match', { p_name: 'HOST', p_request: uuid() });
  const match = made.data.state.match.id;
  await rpc(guest, 'mp_join', { p_token: made.data.token, p_name: 'GUEST' });
  await rpc(host, 'mp_ready', { p_match: match });
  await rpc(guest, 'mp_ready', { p_match: match });
  await db.query(`update public.multiplayer_matches set start_at = now() - interval '1 second', started_at = now() - interval '1 second' where id = $1`, [match]);
  await rpc(host, 'mp_state', { p_match: match });
  return { host, guest, match, token: made.data.token };
}
let seq = 1000;
const cp = (user, match, { score, court = 1, lives = 3, broken = '', done = false, s = ++seq }) =>
  rpc(user, 'mp_checkpoint', { p_match: match, p_seq: s, p_score: score, p_court: court, p_lives: lives, p_broken: broken, p_done: done });

// ---------------------------------------------------------------- the data itself

const dbCourts = (await db.query('select court, bricks from public.multiplayer_courts order by court')).rows;
check('003_courts.sql matches js/levels.js (120 courts, every brick in order)',
  dbCourts.length === 120 && dbCourts.every((r, i) => r.bricks === BRICKS[i]) && readFileSync(new URL('003_courts.sql', root), 'utf8') === courtsSql());
check('the server\'s top brick values match the game (brickPoints at the x3 combo)',
  Object.keys(BLOCKS).every((t) => brickPoints(t, 99) === MAX[t]) &&
  (await db.query(`select public.mp_brick_max('T') t, public.mp_brick_max('L') l, public.mp_brick_max('H') h, public.mp_brick_max('S') s`)).rows[0].s === 150);

// ---------------------------------------------------------------- honest play is accepted

{
  const { host, match } = await activeMatch();
  const st = await player(match, host);
  check('a match starts: score 0, court 1, three lives', st.score === 0 && st.court === 1 && st.lives === 3);
  await later(match, host, 2);
  let r = await cp(host, match, { score: least(1, range(0, 5)), broken: map(1, range(0, 5)) });
  check('honest: five bricks at their plain value', r.ok, r.error);
  await later(match, host, 2);
  r = await cp(host, match, { score: least(1, range(0, 5)) + worth(1, range(5, 10)), broken: map(1, range(0, 10)) });
  check('honest: five more at the top combo (exactly the most allowed)', r.ok, r.error);
  await later(match, host, 2);
  const lives2 = least(1, range(0, 5)) + worth(1, range(5, 10));
  r = await cp(host, match, { score: lives2, lives: 2, broken: map(1, range(0, 10)) });
  check('honest: a life lost, score unchanged', r.ok, r.error);
  await later(match, host, 6);
  const cleared = lives2 + worth(1, range(10, BRICKS[0].length)) + 2 * 100;
  r = await cp(host, match, { score: cleared, lives: 2, broken: map(1, all(1)) });
  check('honest: court cleared (every brick) with the clear bonus for 2 lives', r.ok, r.error);
  await later(match, host, 2);
  r = await cp(host, match, { score: cleared, court: 2, lives: 2, broken: map(2, []) });
  check('honest: on to court 2 (no second bonus asked)', r.ok, r.error);
  await later(match, host, 8);
  const c2 = cleared + worth(2, all(2)) + 2 * 100;
  r = await cp(host, match, { score: c2 + least(3, [0]), court: 3, lives: 2, broken: map(3, [0]) });
  check('honest: court 2 cleared and court 3 begun in one checkpoint (no checkpoint in between)', r.ok, r.error);
  const p = await player(match, host);
  check('the server keeps exactly the accepted numbers', Number(p.score) === c2 + least(3, [0]) && p.court === 3 && p.lives === 2, JSON.stringify({ score: p.score, court: p.court }));
}

// ---------------------------------------------------------------- fake, negative, extreme and duplicate scores

{
  const { host, guest, match } = await activeMatch();
  await later(match, host, 2);
  let r = await cp(host, match, { score: 500, broken: '' });
  check('fake: points with no brick broken are refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: worth(1, range(0, 3)) + 5, broken: map(1, range(0, 3)) });
  check('fake: 5 points more than three bricks can be worth is refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: -100, broken: '' });
  check('negative score is refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: 1e12, broken: map(1, all(1)) });
  check('extremely high score (1,000,000,000,000) is refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: 32, broken: map(1, [0, 1]) });
  check('a score no brick can make (not a multiple of 5) is refused', !r.ok && r.error === 'bad_score', r.error);
  const big = Buffer.alloc(40, 0xff).toString('base64');
  r = await cp(host, match, { score: 48000, broken: big });
  check('fake: 320 bricks claimed on a 24-brick court is refused', !r.ok && r.error === 'bad_checkpoint', r.error);
  r = await cp(host, match, { score: 30, broken: 'not base64!!' });
  check('a malformed bricks map is refused', !r.ok && r.error === 'bad_checkpoint', r.error);
  const p0 = await player(match, host);
  check('after all those refusals the server still holds score 0', Number(p0.score) === 0 && p0.seq === 0);

  const s = ++seq;
  r = await cp(host, match, { score: 30, broken: map(1, [0]), s });
  check('honest checkpoint accepted', r.ok, r.error);
  r = await cp(host, match, { score: 60, broken: map(1, [0, 1]), s });
  check('duplicate: the same sequence number again is ignored, never counted', r.ok && Number((await player(match, host)).score) === 30);
  r = await cp(host, match, { score: 60, broken: map(1, [0, 1]), s: s - 5 });
  check('duplicate: an older sequence number is ignored too', r.ok && Number((await player(match, host)).score) === 30);
  r = await cp(host, match, { score: 20, broken: map(1, [0]) });
  check('a score that goes down is refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: 30, broken: map(1, [1]) });
  check('a brick that comes back is refused', !r.ok && r.error === 'bad_checkpoint', r.error);
  r = await cp(host, match, { score: 30, lives: 4, broken: map(1, [0]) });
  check('more lives than before is refused', !r.ok && r.error === 'bad_lives', r.error);

  await later(match, host, 6);
  const clear = 30 + worth(1, range(1, BRICKS[0].length)) + 300;
  r = await cp(host, match, { score: clear, broken: map(1, all(1)) });
  check('honest clear accepted', r.ok, r.error);
  r = await cp(host, match, { score: clear + 300, broken: map(1, all(1)) });
  check('fake: the clear bonus claimed a second time is refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: clear + 300, court: 2, broken: map(2, []) });
  check('fake: a bonus on moving to the next court after it was already paid is refused', !r.ok && r.error === 'bad_score', r.error);
  r = await cp(host, match, { score: clear, court: 3, broken: map(3, []) });
  check('skipping a court is refused', !r.ok && r.error === 'bad_court', r.error);
  r = await cp(host, match, { score: clear, court: 2, broken: map(2, []) });
  check('court 2 begun', r.ok, r.error);
  r = await cp(host, match, { score: clear + worth(2, all(2)) + 300, court: 3, broken: map(3, []) });
  check('fake: clearing a court within 5 seconds is refused', !r.ok && r.error === 'too_fast', r.error);

  // Bricks falling impossibly fast (per checkpoint: 150 + 110 a second). Court 1
  // has only 24 bricks, so the guest jumps to court 110 (300+) to test it.
  await db.query(`update public.multiplayer_players set court = 110, broken = '', checkpoint_at = now(), court_started_at = now() - interval '1 minute' where match_id = $1 and user_id = $2`, [match, guest]);
  r = await cp(guest, match, { score: worth(110, range(0, 200)), court: 110, broken: map(110, range(0, 200)) });
  check('fake: 200 bricks within a moment of the last checkpoint is refused', !r.ok && r.error === 'too_fast', r.error);
  r = await cp(guest, match, { score: worth(110, range(0, 150)), court: 110, broken: map(110, range(0, 150)) });
  check('M1: 150 bricks at once (above the 97 ever measured in 1/4 s) is accepted', r.ok, r.error);
  await db.query(`update public.multiplayer_players set checkpoint_at = now() - interval '1 second' where match_id = $1 and user_id = $2`, [match, guest]);
  const most = BRICKS[109].length - 1; // all but one, so the court is not cleared
  r = await cp(guest, match, { score: worth(110, range(0, most)), court: 110, broken: map(110, range(0, most)) });
  check(`M1: ${most - 150} more bricks one second later (Multiball + Smash measured 173 a second) is accepted`, r.ok, r.error);
}

// ---------------------------------------------------------------- finishing

{
  const { host, guest, match } = await activeMatch();
  await db.query(`update public.multiplayer_players set court = 120, broken = '', score = 1000, checkpoint_at = now() - interval '1 minute', court_started_at = now() - interval '1 minute' where match_id = $1`, [match]);
  await db.query(`update public.multiplayer_matches set started_at = now() - interval '25 minutes' where id = $1`, [match]); // a run that really reached court 120 (inside the 30-minute match)
  let r = await cp(host, match, { score: 1000 + 30, court: 120, broken: map(120, [0]), done: true });
  check('fake: "finished every court" with court 120 not cleared is refused', !r.ok && r.error === 'bad_checkpoint', r.error);
  r = await cp(host, match, { score: 1000 + worth(120, all(120)) + 300, court: 120, broken: map(120, all(120)), done: true });
  check('honest: court 120 cleared finishes the run', r.ok && (await player(match, host)).finish_reason === 'all_courts', r.error);
  r = await cp(guest, match, { score: 1000 + 30, court: 120, lives: 0, broken: map(120, [0]), done: true });
  check('honest: out of lives on court 120 finishes the run', r.ok && (await player(match, guest)).finish_reason === 'out_of_lives', r.error);
  r = await cp(host, match, { score: 9999990, court: 120, broken: map(120, all(120)), done: true });
  const p = await player(match, host);
  check('after the finish nothing more counts', Number(p.score) === 1000 + worth(120, all(120)) + 300, String(p.score));
}

// ---------------------------------------------------------------- M2: court 120, done or not, and the race

{
  // Both players on court 120, 25 minutes into the match.
  const at120 = async (match) => {
    await db.query(`update public.multiplayer_players set court = 120, broken = '', score = 1000, checkpoint_at = now() - interval '1 minute', court_started_at = now() - interval '1 minute' where match_id = $1`, [match]);
    await db.query(`update public.multiplayer_matches set started_at = now() - interval '25 minutes' where id = $1`, [match]);
  };
  const full = 1000 + worth(120, all(120)) + 300;

  let { host, guest, match } = await activeMatch();
  await at120(match);
  let r = await cp(host, match, { score: full, court: 120, broken: map(120, all(120)), done: false });
  let p = await player(match, host);
  check('M2: court 120 cleared WITHOUT the done flag still finishes the run (all courts)', r.ok && p.finish_reason === 'all_courts' && Number(p.final_score) === full, r.error || p.finish_reason);
  r = await cp(guest, match, { score: 1000 + worth(120, [0]), court: 120, lives: 0, broken: map(120, [0]), done: false });
  const m = (await db.query('select status from public.multiplayer_matches where id = $1', [match])).rows[0];
  check('M2: …and the match completes once the other player is out', r.ok && m.status === 'completed', m.status);

  ({ host, guest, match } = await activeMatch());
  await at120(match);
  r = await cp(host, match, { score: 1000 + worth(120, range(0, 10)), court: 120, broken: map(120, range(0, 10)) });
  check('M2: court 120 partly broken does not finish the run', r.ok && !(await player(match, host)).finished_at);

  // The race: a regular checkpoint and the final one go out with the same number.
  const n = ++seq;
  r = await cp(host, match, { score: 1000 + worth(120, range(0, 20)), court: 120, broken: map(120, range(0, 20)), s: n });
  const r2 = await cp(host, match, { score: full, court: 120, broken: map(120, all(120)), done: true, s: n });
  p = await player(match, host);
  check('M2 race: the final checkpoint arriving second with the same number is ignored (never counted twice)',
    r.ok && r2.ok && !p.finished_at && Number(p.score) === 1000 + worth(120, range(0, 20)));
  await later(match, host, 2); // the next checkpoint goes out a tick (and at least the retry wait) later
  r = await cp(host, match, { score: full, court: 120, broken: map(120, all(120)), done: true });
  p = await player(match, host);
  check('M2 race: the retry with the next number finishes the run, with the full score', r.ok && p.finish_reason === 'all_courts' && Number(p.final_score) === full, r.error);

  ({ host, guest, match } = await activeMatch());
  await at120(match);
  const k = ++seq;
  r = await cp(host, match, { score: full, court: 120, broken: map(120, all(120)), done: true, s: k });
  const r3 = await cp(host, match, { score: 1000 + worth(120, range(0, 20)), court: 120, broken: map(120, range(0, 20)), s: k });
  p = await player(match, host);
  check('M2 race: the final arriving first finishes the run; the older one after it changes nothing',
    r.ok && r3.ok && p.finish_reason === 'all_courts' && Number(p.final_score) === full && Number(p.score) === full);

  ({ host, guest, match } = await activeMatch());
  await at120(match);
  await db.query(`update public.multiplayer_matches set started_at = now() - interval '5 seconds' where id = $1`, [match]);
  r = await cp(host, match, { score: full, court: 120, broken: map(120, all(120)), done: true });
  p = await player(match, host);
  check('M2: a refused final checkpoint finishes nothing…', !r.ok && r.error === 'too_fast' && !p.finished_at, r.error);
  await later(match, host, 1500);
  r = await cp(host, match, { score: full, court: 120, broken: map(120, all(120)), done: true });
  p = await player(match, host);
  check('M2: …and its retry, once allowed, finishes the run with nothing lost', r.ok && p.finish_reason === 'all_courts' && Number(p.final_score) === full, r.error);
}

// ---------------------------------------------------------------- M-a: time limits (30-minute match, 3-minute grace)

{
  const MATCH = 30 * 60;
  const GRACE = 3 * 60;
  const lim = (await db.query('select public.mp_match_secs() m, public.mp_grace_secs() g')).rows[0];
  check('M-a: the limits are a 30-minute match and a 3-minute grace', lim.m === MATCH && lim.g === GRACE, JSON.stringify(lim));
  const status = async (match) => (await db.query('select status, result_status from public.multiplayer_matches where id = $1', [match])).rows[0];
  // Time passes for the whole match: the start, finishes and checkpoints all move back; both players stay connected.
  const age = (match, secs) =>
    db.query(
      `with a as (update public.multiplayer_matches set started_at = started_at - make_interval(secs => $2) where id = $1)
       update public.multiplayer_players set finished_at = finished_at - make_interval(secs => $2), checkpoint_at = checkpoint_at - make_interval(secs => $2),
              court_started_at = court_started_at - make_interval(secs => $2), last_seen_at = now() where match_id = $1`,
      [match, secs],
    );

  // The full time runs out with both still playing.
  let { host, guest, match } = await activeMatch();
  await age(match, 60);
  let r = await cp(host, match, { score: 30, broken: map(1, [0]) });
  r = await cp(guest, match, { score: 45, broken: map(1, [5]) }); // brick 6 is limestone: 45 at the top combo
  let st = await rpc(host, 'mp_state', { p_match: match });
  const ends = st.data.match.ends_at - st.data.match.time_ends_at;
  check('M-a: the state carries when the match ends (ends_at = the full time while both play)', st.ok && ends === 0 && st.data.match.time_ends_at > Date.now(), JSON.stringify(st.data && st.data.match));
  await age(match, MATCH - 60 - 10);
  r = await cp(host, match, { score: 60, broken: map(1, [0, 2]) });
  check('M-a: 10 s before the end, play still counts', r.ok && Number((await player(match, host)).score) === 60, r.error);
  await age(match, 11);
  r = await cp(host, match, { score: 90, broken: map(1, [0, 2, 3]) });
  let hp = await player(match, host);
  let gp = await player(match, guest);
  st = await status(match);
  check("M-a: after 30 minutes both games end at their last verified scores (time's up)",
    hp.finish_reason === 'time_up' && gp.finish_reason === 'time_up' && Number(hp.final_score) === 60 && Number(gp.final_score) === 45, JSON.stringify([hp.finish_reason, hp.final_score, gp.final_score]));
  check('M-a: …a checkpoint after the end is not counted, and the match is decided (higher score wins)', st.status === 'completed' && st.result_status === 'win' && (await rpc(host, 'mp_state', { p_match: match })).data.match.winner === 'me');

  // One player done: the other has the grace, then their game ends.
  ({ host, guest, match } = await activeMatch());
  await age(match, 120);
  r = await cp(host, match, { score: 30, lives: 0, broken: map(1, [0]), done: true });
  check('M-a: one player out of lives finishes', r.ok && (await player(match, host)).finish_reason === 'out_of_lives', r.error);
  st = await rpc(guest, 'mp_state', { p_match: match });
  const grace = Math.round((st.data.match.ends_at - Date.now()) / 1000);
  check(`M-a: the other now has the 3-minute grace (ends_at ${grace} s away), sooner than the full time`, st.ok && Math.abs(grace - GRACE) <= 2 && st.data.match.ends_at < st.data.match.time_ends_at, grace);
  await age(match, GRACE - 30);
  r = await cp(guest, match, { score: 45, broken: map(1, [5]) }); // brick 6 is limestone: 45 at the top combo
  check('M-a: within the grace, play counts', r.ok && Number((await player(match, guest)).score) === 45, r.error);
  await age(match, 31);
  st = await rpc(guest, 'mp_state', { p_match: match }); // a heartbeat alone cannot keep it open
  gp = await player(match, guest);
  check('M-a: after the grace, even a player who keeps checking in is ended (no infinite match)',
    gp.finish_reason === 'time_up' && Number(gp.final_score) === 45 && (await status(match)).status === 'completed', gp.finish_reason);
  check('M-a: …and the result stands on verified scores (45 beats 30)', st.ok && st.data.match.winner === 'me' && st.data.match.status === 'completed');

  // Both finish normally inside the grace: an ordinary result.
  ({ host, guest, match } = await activeMatch());
  await age(match, 60);
  await cp(host, match, { score: 30, lives: 0, broken: map(1, [0]) });
  await age(match, 60);
  r = await cp(guest, match, { score: 0, lives: 0, broken: '' });
  check('M-a: the other finishing within the grace is an ordinary result (out of lives, not time up)',
    r.ok && (await player(match, guest)).finish_reason === 'out_of_lives' && (await status(match)).status === 'completed');

  // A player who stops sending checkpoints while the other is done (keeps the match open on purpose).
  ({ host, guest, match } = await activeMatch());
  await age(match, 30);
  await cp(host, match, { score: 30, lives: 0, broken: map(1, [0]) });
  await age(match, GRACE + 1);
  st = await rpc(host, 'mp_state', { p_match: match }); // the waiting player's own check settles it
  check("M-a: the waiting player's own check ends a stalling opponent's game after the grace", st.ok && st.data.match.status === 'completed' && st.data.opponent.finish_reason === 'time_up');

  // Reconnect inside the time still works: quiet 20 s, back, plays on.
  ({ host, guest, match } = await activeMatch());
  await age(match, 60);
  await db.query(`update public.multiplayer_players set last_seen_at = now() - interval '20 seconds' where match_id = $1 and user_id = $2`, [match, guest]);
  await rpc(host, 'mp_state', { p_match: match });
  check('M-a reconnect: a player quiet for 20 s shows as reconnecting', (await player(match, guest)).connection_status === 'reconnecting');
  st = await rpc(guest, 'mp_state', { p_match: match });
  r = await cp(guest, match, { score: 30, broken: map(1, [0]) });
  gp = await player(match, guest);
  check('M-a reconnect: back within 30 s, online again and play counts', st.ok && gp.connection_status === 'online' && r.ok && Number(gp.score) === 30 && !gp.finished_at, r.error);
  // Refresh: the same signed-in player reads the match again (a reload) and gets their verified state back.
  st = await rpc(guest, 'mp_state', { p_match: match });
  check('M-a refresh: after a reload the player gets their verified score, court, lives and bricks back',
    st.ok && st.data.me.score === 30 && st.data.me.court === 1 && st.data.me.lives === 3 && st.data.me.broken === map(1, [0]) && st.data.match.status === 'active');
  // Quiet for 31 s: timed out as before, and that starts the grace for the other.
  await db.query(`update public.multiplayer_players set last_seen_at = now() - interval '31 seconds' where match_id = $1 and user_id = $2`, [match, guest]);
  st = await rpc(host, 'mp_state', { p_match: match });
  check('M-a reconnect: gone for over 30 s still ends that game (timeout), and the other gets the grace',
    st.ok && st.data.opponent.finish_reason === 'timeout' && st.data.match.ends_at < st.data.match.time_ends_at);

  // Nobody comes back at all: the match is settled when anyone else calls.
  ({ host, guest, match } = await activeMatch());
  await db.query(`update public.multiplayer_matches set started_at = now() - interval '40 minutes' where id = $1`, [match]);
  await db.query(`update public.multiplayer_players set last_seen_at = now() - interval '35 minutes' where match_id = $1`, [match]);
  check('an abandoned match is still open before anyone calls', (await status(match)).status === 'active');
  await rpc(uuid(), 'mp_create_match', { p_name: 'OTHER', p_request: uuid() });
  check('M-a: an abandoned match past its time is settled by anyone else calling (no match stays open for ever)', (await status(match)).status === 'completed');
  const other = await activeMatch();
  await db.query(`update public.multiplayer_matches set started_at = now() - interval '40 minutes' where id = $1`, [match]);
  ({ host, guest, match } = await activeMatch());
  await db.query(`update public.multiplayer_matches set started_at = now() - interval '40 minutes' where id = $1`, [match]);
  await db.query(`update public.multiplayer_players set last_seen_at = now() - interval '35 minutes' where match_id = $1`, [match]);
  await rpc(other.host, 'mp_state', { p_match: other.match });
  check('M-a: …or by a status check from any other match', (await status(match)).status === 'completed');
  check('M-a: and a match in good time is left alone by those checks', (await status(other.match)).status === 'active');
}

// ---------------------------------------------------------------- H1: the whole-match pace

const REACH = (await db.query('select reach from public.multiplayer_courts order by court')).rows.map((r) => Number(r.reach));
const GAP = 1.2 + 2.25;
check('every court has a reach, rising court by court', REACH.length === 120 && REACH[0] > 0 && REACH.every((x, i) => !i || x > REACH[i - 1]));

// Put a player on court k, as if the match had been running `elapsed` seconds.
async function onCourt(match, user, k, elapsed, score = 0) {
  await db.query(
    `update public.multiplayer_players set court = $3, score = $4, lives = 3, broken = '', checkpoint_at = now(), court_started_at = now() - interval '1 minute'
      where match_id = $1 and user_id = $2`,
    [match, user, k, score],
  );
  await db.query(`update public.multiplayer_matches set started_at = now() - make_interval(secs => $2) where id = $1`, [match, elapsed]);
}

{
  const { host, match } = await activeMatch();
  const full1 = worth(1, all(1)) + 300;
  await onCourt(match, host, 1, 1);
  let r = await cp(host, match, { score: full1, broken: map(1, all(1)) });
  check(`H1: court 1 "cleared" 1 s into the match is refused (soonest possible: ${REACH[0]} s)`, !r.ok && r.error === 'too_fast', r.error);
  check('…and the refusal changed nothing on the server', Number((await player(match, host)).score) === 0);
  await later(match, host, 2);
  r = await cp(host, match, { score: full1, broken: map(1, all(1)) });
  check('…the same full state sent again 2 s later is accepted: nothing lost', r.ok && Number((await player(match, host)).score) === full1, r.error);

  const k = 10;
  const at = 0.75 * REACH[k - 1];
  await onCourt(match, host, k, at - 5, 5000);
  r = await cp(host, match, { score: 5000 + worth(k, all(k)) + 300, court: k, broken: map(k, all(k)) });
  check(`H1: court ${k} cleared at ${Math.round(at - 5)} s (before 3/4 of the soonest, ${Math.round(at)} s) is refused`, !r.ok && r.error === 'too_fast', r.error);
  await onCourt(match, host, k, at + 1, 5000);
  r = await cp(host, match, { score: 5000 + worth(k, all(k)) + 300, court: k, broken: map(k, all(k)) });
  check(`H1: court ${k} cleared at ${Math.round(at + 1)} s is accepted`, r.ok, r.error);
  await onCourt(match, host, 40, 60, 5000);
  r = await cp(host, match, { score: 5000, court: 41, broken: map(41, []) });
  check('H1: moving on from court 40 one minute in is refused', !r.ok && r.error === 'too_fast', r.error);
  r = await cp(host, match, { score: 5000 + worth(40, [0]), court: 40, broken: map(40, [0]) });
  check('…while ordinary bricks on that court still count', r.ok, r.error);
}

// The most a cheater can now reach in a 10-minute match (every brick at the top combo, every court at the limit).
{
  let k = 0;
  let pts = 0;
  while (k < 120 && 0.75 * REACH[k] <= 600) {
    pts += worth(k + 1, all(k + 1)) + 300;
    k++;
  }
  const before = 120 * 48300; // the old rule: up to 48,000 + 300 per court, any court every 5 s
  check(`H1: the 10-minute ceiling is now ${k} courts / ${pts.toLocaleString('en')} points (was up to ${before.toLocaleString('en')})`, pts < before / 10);
}

// ---------------------------------------------------------------- genuine play, replayed from the game itself

// Play court k in the real game engine, as the browser would, and record the
// checkpoints it would send (every `every` seconds of play, and at the win).
function simulate(k, mode, seed, every, score) {
  let t = 0;
  let next = every;
  let topCombo = 0;
  const snaps = [];
  const g = new Game(matchLevel(k - 1), () => {}, (() => {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  })(), { score, weights: MATCH_WEIGHTS });
  const bits = () => {
    const bytes = new Uint8Array(Math.ceil(g.blocks.length / 8));
    g.blocks.forEach((b, i) => !b.alive && (bytes[i >> 3] |= 1 << (i & 7)));
    return Buffer.from(bytes).toString('base64');
  };
  while (t < 240 && g.state !== 'won') {
    if (g.state === 'serve' && g.ready) g.launch();
    if (g.state === 'play') {
      g.shield = true; // a player who never misses
      if (mode === 'combo') {
        g.fx.smash = 7; // and more: Smash and nine balls the whole time, for the longest combos
        if (g.balls.length < MAX_BALLS) g.applyTool('multiball');
      }
    }
    const low = g.balls.filter((q) => q.vy > 0).sort((p, q) => q.y - p.y)[0];
    if (low) g.movePaddleTo(low.x);
    g.update(1 / 120);
    t += 1 / 120;
    topCombo = Math.max(topCombo, g.combo);
    if (t >= next || g.state === 'won') {
      snaps.push({ t, score: g.score, lives: g.lives, broken: bits() });
      next = t + every;
    }
  }
  return { snaps, won: g.state === 'won', t, topCombo };
}

async function replay(k, mode, seed, every) {
  const { host, match } = await activeMatch();
  const arrive = k > 1 ? REACH[k - 2] + GAP : 0; // as early as the game allows
  const score0 = (k - 1) * 1000;
  await onCourt(match, host, k, arrive, score0);
  await db.query(`update public.multiplayer_players set court_started_at = now() where match_id = $1 and user_id = $2`, [match, host]);
  const run = simulate(k, mode, seed, every, score0);
  let prev = 0;
  let refused = null;
  for (const s of run.snaps) {
    await later(match, host, s.t - prev);
    prev = s.t;
    const r = await cp(host, match, { score: s.score, court: k, lives: s.lives, broken: s.broken });
    if (!r.ok && !refused) refused = `${r.error} at ${s.t.toFixed(1)} s`;
  }
  if (run.won && k < 120) {
    await later(match, host, GAP);
    const last = run.snaps[run.snaps.length - 1];
    const r = await cp(host, match, { score: last.score, court: k + 1, lives: last.lives, broken: map(k + 1, []) });
    if (!r.ok && !refused) refused = `${r.error} moving on`;
  }
  const p = await player(match, host);
  const last = run.snaps[run.snaps.length - 1];
  const kept = Number(p.score) === last.score;
  check(`genuine ${mode} play, court ${k}${every < 2 ? ` (checkpoints every ${every} s)` : ''}: ${run.snaps.length} checkpoints, ${run.won ? 'cleared in ' + run.t.toFixed(1) + ' s' : 'not cleared'}, top combo ${run.topCombo}, all accepted`,
    !refused && kept, refused || `server ${p.score} vs game ${last.score}`);
}

for (const k of [1, 2, 3, 5, 60, 110]) await replay(k, 'normal', 11 * k, 2);
for (const k of [1, 3, 40, 80, 110, 118, 120]) await replay(k, 'combo', 7 * k, 2);
for (const k of [60, 112]) await replay(k, 'combo', 5 * k, 0.5);

// ---------------------------------------------------------------- identity and access

{
  const { host, guest, match, token } = await activeMatch();
  const stranger = uuid();
  let r = await cp(stranger, match, { score: 30, broken: map(1, [0]) });
  check('a player outside the match cannot send its scores', !r.ok && r.error === 'not_member', r.error);
  r = await rpc(stranger, 'mp_state', { p_match: match });
  check('a player outside the match cannot read it', !r.ok && r.error === 'not_member', r.error);
  r = await rpc(stranger, 'mp_join', { p_token: token, p_name: 'THIRD' });
  check('a third player cannot join', !r.ok && (r.error === 'used' || r.error === 'full'), r.error);
  r = await cp(null, match, { score: 30, broken: map(1, [0]) });
  check('without a signed-in session nothing is accepted', !r.ok && r.error === 'not_signed_in', r.error);
  r = await as(host, `select public.mp_checkpoint($1, 5000, 30, 1, 3, '', false)`, [match], 'anon');
  check('the anon role cannot call mp_checkpoint at all', !r.ok && /permission denied/.test(r.error), r.error);
  r = await as(host, `update public.multiplayer_players set score = 999999 where match_id = $1 and user_id = $2`, [match, guest]);
  check("a player cannot change the opponent's score directly", !r.ok && /permission denied/.test(r.error), r.error);
  r = await as(host, `update public.multiplayer_players set score = 999999 where match_id = $1 and user_id = $2`, [match, host]);
  check('a player cannot change their own score directly either', !r.ok && /permission denied/.test(r.error), r.error);
  r = await as(host, `insert into public.multiplayer_players (match_id, user_id, role, display_name) values ($1, $2, 'guest', 'X')`, [match, stranger]);
  check('nobody can add a player row directly', !r.ok && /permission denied/.test(r.error), r.error);
  r = await as(host, `update public.multiplayer_courts set bricks = 'T' where court = 1`);
  check('nobody can rewrite the courts table', !r.ok && /permission denied/.test(r.error), r.error);
  r = await as(host, `select * from public.multiplayer_courts`);
  check('the courts table is not readable by players', !r.ok && /permission denied/.test(r.error), r.error);
  r = await as(stranger, `select * from public.multiplayer_players where match_id = $1`, [match]);
  check('a stranger reads no rows of the match (RLS)', r.ok && r.rows.length === 0, JSON.stringify(r));
  r = await cp(guest, match, { score: 30, broken: map(1, [0]) });
  const hp = await player(match, host);
  check("a guest's checkpoint changes only the guest's row", r.ok && Number(hp.score) === 0 && Number((await player(match, guest)).score) === 30);
}

{
  const host = uuid();
  const made = await rpc(host, 'mp_create_match', { p_name: 'HOST', p_request: uuid() });
  await db.query(`update public.multiplayer_invites set expires_at = now() - interval '1 second'`);
  const r = await rpc(uuid(), 'mp_join', { p_token: made.data.token, p_name: 'LATE' });
  check('an expired invite cannot be used', !r.ok && r.error === 'expired', r.error);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
