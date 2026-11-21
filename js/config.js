// Online leaderboard settings.
//
// Leave both values empty and the game runs exactly as before, with the
// leaderboard kept on this device only.
//
// To switch the online board on, paste your Supabase project's URL and its
// "anon public" key below (Supabase dashboard -> Project Settings -> API), or
// run scripts/write-config.sh to fill this file from environment variables.
//
// These two values are safe to publish: every visitor's browser receives them
// anyway. What protects the data is the table's Row Level Security policy.
// The key to use starts with "sb_publishable_" (or is the older "anon" key).
// NEVER put a secret key here: nothing starting "sb_secret_", and not "service_role".

const DEFAULTS = {
  // TEST BRANCH (code-5, game-3 link): the Rally board here is the multiplayer
  // project's spare copy of the table, never the live leaderboard. A release
  // to main puts main's own settings back.
  supabaseUrl: 'https://jntfnwoyfvkjunvribgh.supabase.co',
  supabaseAnonKey: 'sb_publishable_hoauA4wn-8YwaF732NYgSw_5z9EaG2p',
  table: 'thecourt',
  // Multiplayer's own Supabase project (the-court-multiplayer). Multiplayer uses
  // these and nothing else: it never falls back to the leaderboard settings
  // above and refuses the live leaderboard's project (js/mpnet.js). The key is
  // the project's publishable key, public by design like the one above.
  // Set multiplayer to false to switch multiplayer off.
  multiplayer: true,
  mpSupabaseUrl: 'https://jntfnwoyfvkjunvribgh.supabase.co',
  mpSupabaseAnonKey: 'sb_publishable_hoauA4wn-8YwaF732NYgSw_5z9EaG2p',
  // PostHog analytics (js/analytics.js). Leave the key empty for no analytics.
  // Use the *project* API key ("phc_..."), from PostHog -> Settings -> Project.
  // It is public by design. NEVER put a personal API key ("phx_...") here.
  posthogKey: 'phc_rm6zMezF2NFmnoS4xfFr7tKdbRAL7ziTfj4gfWG9Rhmb', // on for the test link too: its events carry deployment 'test3', filtered out of production
  posthogHost: 'https://us.i.posthog.com', // or https://eu.i.posthog.com for EU Cloud
};

// window.COURT_CONFIG, if a page sets it before the game loads, wins (used by the tests).
export const CONFIG = { ...DEFAULTS, ...(globalThis.COURT_CONFIG || {}) };

// A secret key pasted here by mistake keeps the online board off rather than shipping it to every visitor.
export const onlineEnabled = () => /^https?:\/\//.test(CONFIG.supabaseUrl) && CONFIG.supabaseAnonKey.length > 0 && !CONFIG.supabaseAnonKey.startsWith('sb_secret_');
