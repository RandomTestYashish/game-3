// Product analytics through PostHog (https://posthog.com/docs/libraries/js).
//
// Off unless js/config.js holds a PostHog *project* key (it starts "phc_" and,
// like the Supabase publishable key, is meant to be public). A personal API
// key ("phx_") is refused, so one pasted by mistake is never shipped.
//
// Only the game's own events are sent (see track() calls in main.js), with
// numbers such as court and score: no player names, no autocaptured clicks,
// no session recordings. Nothing is sent from localhost unless the config
// asks for it. Every call is wrapped so a blocked or failing analytics script
// can never break the game.

import { CONFIG } from './config.js';

const key = String(CONFIG.posthogKey || '');
const host = String(CONFIG.posthogHost || 'https://us.i.posthog.com').replace(/\/+$/, '');
const local = /^(localhost|127\.|\[::1\]$)/.test(location.hostname);

export const analyticsEnabled = () =>
  key.startsWith('phc_') && /^https:\/\/[a-z0-9.-]+$/i.test(host) && (!local || CONFIG.posthogLocal === true);

let started = false;

function start() {
  if (started) return;
  started = true;
  /* eslint-disable */
  // The official PostHog HTML snippet, unchanged: it queues calls until the
  // library (array.js, fetched from the PostHog host) has loaded.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  /* eslint-enable */
  window.posthog.init(key, {
    api_host: host,
    defaults: '2026-05-30',
    // Every player gets an anonymous profile (no name, no email: just PostHog's
    // random id), so returning players, retention and funnels count properly.
    person_profiles: 'always',
    autocapture: false, // the game is one canvas: page clicks say nothing
    capture_dead_clicks: false,
    capture_heatmaps: false,
    disable_session_recording: true,
    disable_surveys: true,
  });
  // Every event says which site sent it, so test and preview activity can be
  // filtered out of production numbers in PostHog (property "deployment").
  if (window.posthog.register) window.posthog.register({ deployment: deployment() });
  beginSession();
}

// ---- sessions and visits ----------------------------------------------------
// Kept on this device: how many visits, when the last one was, the best court
// ever reached, attempts per court, and how the last run ended. Each session
// says which visit it is (first_visit / visit_number ride on every event),
// and when the page is hidden or closed, how long it lasted and what happened.
const STORE = 'the-court.analytics';
const SESSION_GAP_MS = 30 * 60 * 1000; // hidden this long, then back = a new session
let mem = null;
let sess = null;
function memory() {
  if (mem) return mem;
  try {
    mem = JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    mem = {};
  }
  mem.visits = mem.visits || 0;
  mem.best = mem.best || 0;
  mem.attempts = mem.attempts || {};
  return mem;
}
function remember() {
  try {
    localStorage.setItem(STORE, JSON.stringify(mem));
  } catch {
    /* private mode: fine */
  }
}
function beginSession() {
  const m = memory();
  const now = Date.now();
  const days = m.last ? Math.floor((now - m.last) / 86400000) : null;
  m.visits++;
  const prev = { previous_last_court: m.lastCourt || null, previous_loss_cause: m.lastCause || null, previous_session_s: m.lastSessionS || null };
  m.last = now;
  remember();
  sess = { start: now, hiddenAt: null, runs: 0, maxCourt: 0, courts: 0, screens: 0, ended: false };
  window.posthog.register({ visit_number: m.visits, first_visit: m.visits === 1, best_court_ever: m.best });
  window.posthog.capture('session_started', { visit_number: m.visits, first_visit: m.visits === 1, days_since_last: days, ...prev });
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') endSession('hidden');
      else if (sess && sess.ended && Date.now() - sess.hiddenAt > SESSION_GAP_MS) beginSession();
      else if (sess && sess.ended) sess.ended = false; // a short look away: the same session
    });
    window.addEventListener('pagehide', () => endSession('closed'));
  }
}
let listening = false;
function endSession(how) {
  if (!sess || sess.ended) return;
  sess.ended = true;
  sess.hiddenAt = Date.now();
  const m = memory();
  const duration = Math.round((Date.now() - sess.start) / 1000);
  m.lastSessionS = duration;
  remember();
  try {
    window.posthog.capture(
      'session_ended',
      { duration_s: duration, how, runs: sess.runs, courts_played: sess.courts, max_court: sess.maxCourt, screens_viewed: sess.screens, last_court: m.lastCourt || null, last_loss_cause: m.lastCause || null },
      { transport: 'sendBeacon' },
    );
  } catch {
    /* page going away */
  }
}
// Fold what each event says into the session and the device's memory, and
// add the numbers that only this device knows (attempts, best court).
function enrich(event, props) {
  const m = memory();
  if (sess) {
    if (event === 'game_started') sess.runs++;
    if (event === 'screen_viewed') sess.screens++;
  }
  if (event === 'court_started') {
    const c = props.court;
    m.attempts[c] = (m.attempts[c] || 0) + 1;
    props.attempt_number = m.attempts[c];
    props.best_court_ever = Math.max(m.best, c);
    if (sess) {
      sess.courts++;
      sess.maxCourt = Math.max(sess.maxCourt, c);
    }
    if (c > m.best) {
      m.best = c;
      if (window.posthog && window.posthog.register) window.posthog.register({ best_court_ever: c });
    }
    remember();
  }
  if (event === 'life_lost' || event === 'game_over') {
    if (props.court) m.lastCourt = props.court;
    if (props.cause) m.lastCause = props.cause;
    if (event === 'game_over') props.best_court_ever = m.best;
    remember();
  }
  return props;
}

// production = the main GitHub Pages game; preview / test / test3 = the
// branch previews; vercel = the Vercel project; local = this computer.
export function deployment() {
  const h = location.hostname;
  const p = location.pathname;
  if (local) return 'local';
  if (h.endsWith('.vercel.app')) return 'vercel';
  if (p.startsWith('/game-code-2/')) return 'test';
  if (p.startsWith('/game-3/')) return 'test3';
  if (p.startsWith('/game-preview/')) return 'preview';
  if (p.startsWith('/game/')) return 'production';
  if (h === 'www.thecourt.games' || h === 'thecourt.games') return 'production'; // the live domain (Vercel)
  return 'other';
}

// Load PostHog (and send the page view) once, at boot.
export function initAnalytics() {
  if (!analyticsEnabled()) return;
  try {
    start();
  } catch {
    /* analytics unavailable: the game carries on */
  }
}

// Send one event. Never throws.
export function track(event, props = {}) {
  if (!analyticsEnabled()) return;
  try {
    start();
    window.posthog.capture(event, enrich(event, { ...props }));
  } catch {
    /* analytics unavailable: the game carries on */
  }
}
