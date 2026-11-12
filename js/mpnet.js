// Multiplayer networking: anonymous sign-in, the match functions in the
// database (supabase/multiplayer/002_multiplayer.sql), and Realtime.
//
// Every player is an anonymous Supabase Auth user, so each request carries a
// signed token and the database knows who is asking (auth.uid()). The
// session is kept in localStorage, so a refresh is the same player.
//
// Realtime only says "something changed": the authoritative state is always
// re-read through mp_state, which also counts as the player's heartbeat.

import { CONFIG } from './config.js';

const LIB = 'js/vendor/supabase.js'; // @supabase/supabase-js 2.49.4, UMD build (MIT)
const TIMEOUT_MS = 8000;

let client = null;
let starting = null;
let offset = 0; // server clock minus this device's clock, in ms

// Multiplayer's own database: mpSupabaseUrl / mpSupabaseAnonKey when given
// (a separate project from the Rally's leaderboard), else the same project.
const mpUrl = () => CONFIG.mpSupabaseUrl || CONFIG.supabaseUrl || '';
const mpKey = () => (CONFIG.mpSupabaseUrl ? CONFIG.mpSupabaseAnonKey : CONFIG.supabaseAnonKey) || '';

// Multiplayer needs its online project (the development project on game-3).
export const mpEnabled = () => /^https:\/\//.test(mpUrl()) && mpKey().length > 0 && !mpKey().startsWith('sb_secret_') && CONFIG.multiplayer === true;

export const serverNow = () => Date.now() + offset;

function loadLib() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve();
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = LIB;
    s.onload = () => ok();
    s.onerror = () => fail(new Error('lib'));
    document.head.appendChild(s);
  });
}

// Sign in (anonymously, once per device) and get the client ready.
// Returns { ok: true } or { ok: false, error }.
export function connect() {
  if (client) return Promise.resolve({ ok: true });
  if (!mpEnabled()) return Promise.resolve({ ok: false, error: 'not_configured' });
  if (!starting) {
    starting = (async () => {
      try {
        await loadLib();
        const c = window.supabase.createClient(mpUrl(), mpKey(), {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'the-court.mp-auth', detectSessionInUrl: false },
          realtime: { params: { eventsPerSecond: 5 } },
        });
        const { data } = await c.auth.getSession();
        if (!data || !data.session) {
          const { error } = await c.auth.signInAnonymously();
          if (error) return { ok: false, error: 'sign_in' };
        }
        client = c;
        return { ok: true };
      } catch {
        return { ok: false, error: 'network' };
      } finally {
        starting = null;
      }
    })();
  }
  return starting;
}

// Call a match function. Returns { ok: true, data } or { ok: false, error }
// where error is a short reason ("expired", "used", "full", "network"...).
export async function call(fn, args = {}) {
  const c = await connect();
  if (!c.ok) return c;
  const t0 = Date.now();
  try {
    const res = await Promise.race([
      client.rpc(fn, args),
      new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), TIMEOUT_MS)),
    ]);
    if (res.error) {
      const m = /mp:([a-z_]+)/.exec(res.error.message || '');
      return { ok: false, error: m ? m[1] : res.error.code === 'PGRST301' || res.status === 401 ? 'session' : 'server' };
    }
    const data = res.data;
    // Keep the clocks in step: the server's time, minus half the round trip.
    const st = data && (data.server_now || (data.state && data.state.server_now));
    if (st) {
      const t1 = Date.now();
      const est = st - (t0 + t1) / 2;
      offset = Math.abs(est - offset) > 2000 || !offset ? est : offset * 0.7 + est * 0.3;
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e && e.message === 'timeout' ? 'timeout' : 'network' };
  }
}

// Be told when the match or its players change (the change itself is passed
// on, so the caller can skip ones that matter to nobody). Returns an unsubscribe.
export function watch(matchId, onChange) {
  if (!client) return () => {};
  const ch = client
    .channel('match-' + matchId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'multiplayer_players', filter: 'match_id=eq.' + matchId }, (p) => onChange(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'multiplayer_matches', filter: 'id=eq.' + matchId }, (p) => onChange(p))
    .subscribe();
  return () => {
    try {
      client.removeChannel(ch);
    } catch {
      /* already gone */
    }
  };
}
