# The Court

A fast 2.5D pixel-art block-breaker set on a garden tennis court at dusk. 120 courts, six tools, a leaderboard, local saves, synthesised sound. Plain HTML, CSS and JavaScript modules: no build step, no dependencies, no image files; the only audio files are the seven music tracks in `assets/music`.

## Setup

Browsers will not load JavaScript modules from a page opened as a file, so serve the folder:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works (GitHub Pages, Netlify, an S3 bucket): upload the folder as it is.

## Controls

| | Mouse | Touch | Keyboard |
|---|---|---|---|
| Move paddle | Move the pointer | Drag anywhere | `←` `→` or `A` `D` |
| Serve | Click | Tap | `Space` / `Enter` |
| Pause | Pause button | Pause button | `P` / `Esc` |
| Mute | Sound panel | Sound panel | `M` |
| Menus | Click | Tap | `Enter` confirms, `Esc` goes back, `←` `→` turn court pages |
| Name entry | On-screen keys | On-screen keys | Type, `Backspace`, `Enter` saves |

The game pauses itself when the tab or window loses focus.

## How it plays

- Clear every block to finish a court. Stars are three minus the balls you lost on it.
- A run starts on any unlocked court with three lives. Next carries your score and your remaining lives forward: a lost life never comes back, and nothing is refilled between courts. The run ends when you lose your last life or go Home, and its total goes on the leaderboard under the name you enter. Replay, Retry and Restart begin a new run: three lives again, score back to 0.
- There are 120 courts: five hand-made, the rest generated from a fixed recipe so they are the same on every device. Each one is faster than the last, the paddle shrinks, tools get rarer, and slate gets more common.
- Terracotta and limestone break in one hit, hedge in two, slate in three. Some rows slide sideways, and on many courts the whole formation advances toward you and back.
- The ball speeds up 3% on every paddle hit, up to 1.55 times the court's speed.
- Breaking several blocks between paddle touches builds a combo, up to x3. Each ball left at the end is worth 100.
- Broken blocks sometimes drop a tool. Catch it with the paddle:

| Tool | Effect |
|---|---|
| Shield | A barrier behind the paddle saves one ball |
| Multiball | Every ball in play splits into three |
| Smash | The ball goes straight through blocks (7 s) |
| Freeze | Blocks stop sliding and break in one hit (8 s) |
| Expand | Wider paddle (14 s) |
| Low Gravity | Balls and tools come down slowly (10 s) |

## How to Play screen

"Rules" on the courts screen and "How to play" in the pause menu open a five-tab reference: Bricks, Score, Tools, Runs and Keys. Its numbers are not typed in: `js/rules.js` reads them from the constants `js/game.js` plays by (`BLOCKS`, `comboMult`, `TOOL_TIME`, `LIFE_BONUS` and so on), and the test measures each one in a simulated rally and compares it with what the screen shows.

## First-time journey

A player with no save is not sent through the court grid and tools briefing. Play goes from the intro straight into court 1 with a ball 20% slower, and the ball waits on the paddle instead of serving itself. Short hints appear one at a time: move, serve, clear the blocks, catch the tool (the first tool is always Expand), and what to do after losing a ball. "Skip tips" ends it at once.

The tutorial is marked done (`onboarded` in the save) when that first rally ends or is skipped; from then on the game is exactly the normal one. Saves from before this feature count as returning if they show any play. "Erase save data" brings the tutorial back.

## Court themes

Every court is dressed as one of four countries, and every third court has a Black Court surface. Only the look changes: bricks, ball, paddle, scoring and rules are the same everywhere.

| Theme | Background |
|---|---|
| Japan, Sakura Court | Mount Fuji, a pagoda, a torii gate, cherry blossom, falling petals |
| New York, City Lights | Skyscrapers with lit windows, a suspension bridge, a statue |
| London, Classic Garden | A clock tower, a long Gothic hall, a low bridge, garden trees |
| India, Jaipur Royal Court | A sandstone palace with domes and arches, a hill fort, palms |

`js/themes.js` holds the colours and one function, `getCourtTheme(court, choice)`:

- country = `Math.floor((court - 1) / 2) % 4`, in the order Japan, New York, London, India
- Black Court = `court % 3 === 0`, worked out separately, so it also applies when a country is chosen by hand

On a Black Court the surface turns near-black, the lines take the country's accent colour, and the paddle gets a pale rim so it stays visible. The background stays the country's.

**Music changes every court.** The background music is by Juhani Junkala (CC0): "Chiptune Adventures" ([opengameart.org](https://opengameart.org/content/4-chiptunes-adventure)) and "5 Chiptunes (Action)" ([opengameart.org](https://opengameart.org/content/5-chiptunes-action)), seven looping tracks in `assets/music` (see `CREDITS.txt` there):

| When | Track |
|---|---|
| Landing, leaderboard and other menus | Stage Select |
| Courts, in turn (court 1, 2, 3...) | Action 1, Stage 1, Action 2, Stage 2, Action 3, round again |
| Every Black Court | Boss Fight |

Each court's music builds with the court: it starts mellow (the high end muffled, the bass light) and opens up as bricks go, reaching full power with heavy bass for the Power Rush and the finish. During a Power Rush it also plays about 8% faster. `js/audio.js` fetches the tracks after the first tap (browsers allow sound only after one), loops each one, and cross-fades over about 0.9 s when the track changes. Sound effects are still synthesised: the original set (one click for every button, a thwock off the racket, a crack and a falling note for each break, rising with the combo, a jingle for each tool caught), plus the crowd's reactions.

**Haptics.** `js/haptics.js` gives each event its own vibration pattern (a light tick for a button, a firmer one off the racket's edge, heavier for slate than terracotta, a long double buzz for a lost ball, a drum roll for the finish). Android browsers use `navigator.vibrate`; iPhones, which don't have it, get a light tick per pulse from Safari's switch control. Vibration can be turned off in Sound (`settings.haptics`).

**The crowd.** The crowd reacts all through a court, not just at the end: every brick hit makes the fans nearest it pop up, with a quick "ooh" (a crack) or "yeah" (a break) from that side. A Mexican wave goes round all three stands (left, back, right) after a combo of eight, at the Power Rush, and by itself after a quiet stretch of play, its "whooo" travelling left to right with the crest. The stands match the banner: black (lifted just enough for the tiers to read) with the banner's grey edge, and the fans wear the banner's colours (the wordmark's white, blue-grey, yellow and gold, the bites' orange and red, the ball's green), toned a little so they don't outshine the play. The crowd's voice is arcade-style and minimal, all synthesised: a brick break chirps a little "yay" and a crack dips an "ooh" (notes from a pentatonic scale, so a string of them sounds like a tune), applause is 8-bit noise claps on a beat, a big moment is a rising arpeggio, a trill and a "HEY!" chord stab, a lost ball is the arcade "wah wah wahhh", and the wave is a run of notes that rises and falls with the crest as it pans left to right. Nothing plays under the game between reactions. On the courts a two-tier stand runs behind the banner and plain three-tier stands run down both sides, with no lines on them. They are about two-thirds full of brightly dressed fans who now and then clap, each on their own beat. Each country's street lamps stand by the court in front of them. The crowd leads the sound: the music sits low in the background and the crowd reacts out loud, the music dipping under it. A run of three bricks or a caught tool gets a round of applause (the fans clap); a lost ball gets a groan (hands to heads); a big moment (every fifth brick in a combo, three or more bricks inside about half a second, the Power Rush, and the finish) gets a roar, with the fans jumping, arms up. To keep the courts clear, the fireflies, drifting petals, corner bushes and wall-lantern glow show only on the menus.

**Choosing a theme.** PLAY goes straight into the game on Automatic. Every visit turns the rotation to start on a different country than the last visit did (kept in `localStorage` under `the-court.look`, apart from the save). The theme can be changed from Pause, then Theme: Automatic or one of the four countries. Automatic follows the rotation. Picking a country keeps that country on every court until Automatic is picked again. The choice is saved with the sound settings (`settings.theme`: `auto`, `japan`, `newyork`, `london` or `india`). A change of theme cross-fades over about 0.35 s.

## Architecture

```
index.html        one <canvas>, loads js/main.js
css/style.css     page chrome and pixel-perfect scaling
js/main.js        boot, screen flow, input, frame loop
js/game.js        rules and physics (no DOM)
js/levels.js      hand-made courts and the generator for the rest
js/scene.js       camera projection, background layers, block/ball/paddle sprites
js/render.js      draws a Game into the court, plus the HUD
js/ui.js          buttons, sliders, tilting panels
js/gfx.js         low-res canvas, drawing primitives, fonts, icons
js/audio.js       Web Audio effects, and playback of the music tracks
assets/music/     background music (CC0, see CREDITS.txt)
js/rules.js       How to Play text, built from the game's constants
js/themes.js      court themes: colours and getCourtTheme()
js/config.js      online leaderboard settings (empty = off)
js/remote.js      online scores: read the top 20, post a saved run
js/save.js        save data, migration, storage adapter
tests/e2e.py      browser test
supabase/         SQL to run once in Supabase (submit_score)
```

- **Rendering and layout.** Everything is drawn in code onto one low-resolution canvas that fills the window and is scaled up with nearest-neighbour sampling. A game pixel is sized so that at least 240 x 320 of them fit; spare room becomes more court and garden (up to 760 wide or 520 tall), so phones, tablets and wide desktops all get a full-bleed view. Screens centre their panels on the canvas width.
- **2.5D.** The simulation is flat: `game.js` works in court coordinates (200 x 240). `scene.js` projects those through a perspective camera with one parameter, `cam`, from 0 (low menu view) to 1 (raised play view). Screen changes tween `cam`, so the court, net and parallax layers move together; panels tilt up from the grass; blocks drop in from above. During play the camera also trucks sideways with the paddle (`shift`), keeping the paddle's depth fixed while nearer and farther layers slide against it, and blocks float above their shadows.
- **Background motion.** Clouds drift, stars twinkle, a flock crosses the sky, fireflies and petals move, lanterns flicker and the canopy sways. All of it is drawn per frame in `drawScene`.
- **Screens.** `main.js` holds a small state machine: `loading → title → intro → courts → tools → countdown → play ⇄ paused → name → scores`. A won court goes straight to the next court's countdown, which shows that court's stars and score; only the last court stops on `complete`. Every court has more blocks than the one before, about 8 more each time: 24 on court 1, 1000 on court 120. The blocks shrink to make room (28 units wide on court 1, about 5 on court 120) and the grid grows from 7 columns to 38 and up to 34 rows. See `grid()` and `fit()` in `js/levels.js`. During a run, a tag under the pause button shows the run's place on the leaderboard (the online board when it is set up), and passing a name pops a short "YOU BEAT …!" note ("NEW PERSONAL BEST!" for the player's own best). Each screen is one function that draws itself and registers its hit regions every frame.
- **Game and view are separate.** `Game` knows nothing about drawing, sound or storage. It reports what happened through an `emit(event)` callback, and takes its random source as an argument, which is what makes it testable.
- **Adding levels.** Raise `COUNT` in `js/levels.js` for more generated courts, or add to `HAND` for hand-made ones. The courts screen, unlocking and saving pick them up.

## Save data

One JSON document in `localStorage` under `the-court.save`:

```json
{
  "version": 3,
  "updatedAt": 1791901112459,
  "onboarded": true,
  "settings": { "music": 0.6, "sfx": 0.8, "muted": false, "theme": "auto" },
  "progress": { "unlocked": 2, "levels": { "baseline": { "best": 610, "stars": 2 } } },
  "stats": { "plays": 3, "wins": 1, "blocks": 51 },
  "leaderboard": [{ "name": "PANDA", "score": 1730, "court": 2, "at": 1791901112459 }],
  "lastName": "PANDA"
}
```

It is written when a rally ends, when a score is posted and when sound settings change. The leaderboard keeps the best 20 runs **on that device only**: each browser has its own list. `migrate()` validates whatever it loads, so a damaged or older save falls back to defaults field by field. If `localStorage` is blocked, the game keeps the save in memory for the session. "Erase save data" in the Sound panel clears progress and the leaderboard and keeps sound settings.

## Online leaderboard (optional)

With a Supabase project URL and its publishable key in `js/config.js`, the Scores screen shows the **online** board only (top 20): there is no device/online switch. Every score the player saves at the end of a run is sent online, the board is fetched again, and the player's row is highlighted. Scores are still kept on the device in the save, just not shown. If loading fails the board says so and offers Try Again. With `js/config.js` empty (a local copy), the game makes no network calls and shows the device board instead. Closing the name screen with its X (or Esc) sends nothing. **Unique names:** while a name is typed, the game asks the board whether it is already there (a read: `?select=name&name=eq.NAME&limit=1`). A name someone else has is shown as NAME TAKEN and cannot be saved; names this device has saved under before (`names` in the save) stay its own. This is a check in the browser, not a database rule: if the board cannot be reached, the name is not blocked. If sending fails, the score is still on the device and the board offers "tap to retry".

**How writing is protected.** The publishable key ships to every visitor, so it must not be able to write freely. `supabase/submit_score.sql` takes insert, update and delete on the table away from that key and adds one database function, `submit_score(name, score, court)`, that checks the values and inserts a single row:

- name: 1-8 characters, A-Z, 0-9, space, dot, dash
- court: 1-120; score: 1 to court x 150300 (the most a court can give; the test checks this against the game's numbers)
- at most 30 new scores a minute across the board

No secret key and no server of your own are involved: the function runs inside the database. A score is still worked out in the player's browser, so a determined player could post a fake one within those limits. Stopping that would need the server to replay the rally.

**1. Table.** The game uses an existing table (here `thecourt`) with columns `name text`, `score bigint`, `court bigint`, `at bigint`, `created_at timestamptz`, Row Level Security on, and a SELECT policy for `anon`.

**2. Allow posting.** Supabase: SQL Editor, paste `supabase/submit_score.sql`, Run. To switch posting off again:

```sql
drop function public.submit_score(text, bigint, bigint);
```

**3. Config.** Project Settings, API Keys: copy the **Project URL** and the **publishable** key (`sb_publishable_...`). Never a secret key (`sb_secret_...`) or `service_role`.

```sh
SUPABASE_URL=https://YOUR-PROJECT.supabase.co SUPABASE_ANON_KEY=sb_publishable_... SUPABASE_TABLE=thecourt sh scripts/write-config.sh
```

**4. Hosting (GitHub Pages).** A static site has no environment variables at run time, so commit `js/config.js` and push. Both values are public by design; the SQL above is what protects the table.

`js/remote.js` is the only file that talks to the database: one GET for the top 20 and one POST to `rpc/submit_score` per saved run, each giving up after 6 seconds. Rows that come back are cleaned (name rules, whole-number scores) before they are shown.

## Analytics (optional, PostHog)

The PostHog setup wizard (`npx @posthog/wizard`) does not support plain HTML/JS projects, so `js/analytics.js` uses the official PostHog HTML snippet instead. It is off until `js/config.js` has a PostHog **project** API key (`posthogKey: 'phc_...'`, public by design) and the matching `posthogHost` (`https://us.i.posthog.com` or `https://eu.i.posthog.com`). A personal API key (`phx_...`) is refused. Nothing is sent from localhost.

To check the deployed sites for real (page errors, the leaderboard read, and every event PostHog receives, with its `deployment` tag), run `python tests/live_check.py`. It never saves a score and never sends production events; the end-to-end suite uses a stand-in PostHog, so this is the check that real delivery works. PostHog ignores automated browsers (`navigator.webdriver`), which the script hides.

It sends a page view plus these events, with numbers only (no player names). Autocapture, heatmaps, session recording and surveys are off:

| Event | When | Properties |
|---|---|---|
| `game_started` | a run starts | `court`, `tutorial` |
| `court_completed` | a court is won | `court`, `score`, `run_score`, `stars`, `lives_left`, `blocks`, `new_best` |
| `life_lost` | a ball is lost | `court`, `lives_left`, `run_score` |
| `powerup_used` | a tool is caught | `powerup`, `court` |
| `game_over` | a run ends | `reason` (`out_of_lives`, `quit`, `all_courts_cleared`), `court`, `run_score`, `courts_cleared` |
| `leaderboard_submit_success` / `leaderboard_submit_failure` | after posting to Supabase | `score`, `court` (+ `error` on failure) |

If PostHog is blocked or down, the game is unaffected: every call is wrapped.

Every event carries a `deployment` property (`production` for the main GitHub Pages game, `preview`, `test` for the game-code-2 test link, `test3` for the game-3 test link, `vercel`, `local`), so preview and test activity can be filtered out of production numbers.

Leaderboard and sharing events:

| Event | When | Properties |
|---|---|---|
| `leaderboard_viewed` | the leaderboard opens (once per visit) | `source` (`run` or `menu`) |
| `leaderboard_scrolled` | the player first scrolls the table on a visit | `rows` (how far it can scroll) |
| `friends_tab_clicked` | FRIENDS pressed (it says the friends board is coming soon) | |
| `share_cta_viewed` | the SHARE button is first shown on a visit | `court` |
| `share_cta_clicked` | SHARE is pressed | `court`, `ranked` |
| `share_sheet_opened` | the device share sheet is opened | `kind` (`image` or `link`), `court`, `ranked` |
| `share_completed` | the share sheet reports the share was sent on (not just opened) | `kind`, `court`, `ranked` |
| `share_cancelled` | the player closed the share sheet | `kind`, `court`, `ranked` |
| `share_failed` | the share sheet failed (the card is then saved instead) | `kind`, `reason`, `court`, `ranked` |
| `share_card_saved` | no share sheet: the card was downloaded | `link_copied`, `court`, `ranked` |
| `share_card_failed` | the card image could not be made | `reason`, `court`, `ranked` |

No player names are sent.

**Tidy-up (2026-10-23).** `supabase/2026-10-23-tidy-up.sql` removes the one test score left from checking the game, adds an index for the top-20 query, and ends with read-only checks (the 150300 limit is in place; the public key can call `submit_score` but cannot insert directly). Run it once in the SQL Editor; running it again does nothing harmful.

**The racket (game-3).** On this branch (`code-4`, published to the game-3 test link) the black bar is a tennis racket lying on the court: the strung head is the bar's full width (what the ball bounces off, so play is unchanged), the throat and taped grip stick out to the right, and a hit makes the strings dent and light up where the ball struck while the racket springs (`RACKET_RING` in `js/game.js`).

**Power Rush and the finish.** With a quarter of a court's blocks left (`RUSH_AT` in `js/game.js`), a small POWER RUSH label shows under the HUD for a moment, most breaks drop a tool (`RUSH_RATE`), and tools also fall from the far end at random places every 1.4 to 2.4 s (`RAIN_EVERY`), since few bricks are left to break; still at most `MAX_DROPS` falling at once. The last brick brings a short, gentle slow-down, a light fall of confetti and COURT CLEAR!

## Score sharing

After a run, the leaderboard shows HOME, SHARE and PLAY AGAIN. SHARE makes a 1080x1350 score card in the browser (`js/share.js`): the current court theme's scenery, THE COURT, the player's name and score, the court, the leaderboard place, CAN YOU BEAT ME?, the game's address and the signature, drawn small in the game's pixel art and scaled up. Phones get the system share sheet with the image; where there is no share sheet (most desktops) the card downloads and the message and link are copied. The link is the site the card was made on, tagged `utm_source=score_share&utm_medium=social&utm_campaign=score_card` so PostHog can count new players who arrive from shares. No server or database change is needed.

## Database upgrade path

The game never touches `localStorage` directly. `Save` talks to a store with three async methods, and `LocalStore` is the only implementation today:

```js
class LocalStore {
  async load()      // -> save document or null
  async save(data)  // persist the whole document
  async clear()
}
```

To move saves to a server:

1. **Add an API** with `GET /save`, `PUT /save` and `DELETE /save` for the signed-in player. This needs accounts or at least an anonymous device token; the game has neither yet.
2. **Write `RemoteStore`** with the same three methods using `fetch`, and pass it in `main.js`: `new Save(new RemoteStore())`. Nothing else in the game changes, because every call site already awaits the store.
3. **Keep local as a cache.** Wrap both in a store that reads local first, then fetches remote and merges: take the higher `best` and `stars` per level, the higher `unlocked`, and the settings from whichever document has the later `updatedAt`. Write to local immediately and to remote in the background, so play continues offline.
4. **Store it** as one JSON column to start, or normalised if you want leaderboards:

```sql
players  (id PK, created_at)
settings (player_id PK/FK, music REAL, sfx REAL, muted BOOL, updated_at)
progress (player_id FK, level_id TEXT, best INT, stars INT, updated_at, PRIMARY KEY (player_id, level_id))
scores   (id PK, player_id FK, name TEXT, score INT, court INT, created_at)   -- shared leaderboard: top N by score
stats    (player_id PK/FK, plays INT, wins INT, blocks INT)
```

A shared leaderboard is the smallest useful first step: it needs only the `scores` table, an insert when `Save.addScore` runs and a "top 20" read on the scores screen. A hosted database with a browser client (Supabase, Firebase) can do that with no server of your own.

5. **Do not trust client scores** if they become public. Today the score is computed in the browser; a leaderboard would need the server to validate or replay a rally.

Bump `SAVE_VERSION` and extend `migrate()` whenever the document shape changes.

## Tests

```sh
pip install playwright
python tests/e2e.py
```

Runs the game in headless Chrome (it uses your installed Google Chrome) at desktop, tablet and phone sizes. It clicks through every screen, checks mouse, keyboard and touch control, the rules and each tool, sound settings, name entry and the leaderboard, and saving across a reload. It plays five courts through in the browser (1, 3, 40, 80 and 120) and simulates all 120 to confirm each can be cleared. Pass a folder path as an argument to keep screenshots.

Adding `?debug` to the URL exposes the game state as `window.__court`, which is what the test drives.

The multiplayer database functions have their own test, run against a throwaway in-memory Postgres (PGlite), never a real project:

```sh
npm install --prefix /some/scratch/dir @electric-sql/pglite@0.3
PGLITE=/some/scratch/dir node tests/mp_server_test.mjs
```

It plays honest and dishonest clients against `mp_checkpoint` (fake, negative, extreme and repeated scores, bricks that come back, a bonus claimed twice, courts skipped or cleared too fast) and checks who may read or change what. Multiplayer scores are checked brick by brick against each court's real layout, and paced against how soon a run could possibly have cleared each court (timed in the game engine by a bot with nine balls and Smash on all the time, far beyond any player). Both live in `supabase/multiplayer/003_courts.sql`; after changing `js/levels.js` or `js/game.js`, run `node scripts/mp_courts.mjs` to regenerate it (the test fails if they disagree). The test also replays real play from the engine (normal play, long Multiball and Smash combos, late courts, checkpoints every half second) and checks the server accepts every checkpoint.

A match lasts at most 30 minutes of play, and once one player is done the other has 3 minutes to finish (`mp_match_secs()` and `mp_grace_secs()` in `002_multiplayer.sql`); then that game ends at its last verified score, so nobody can hold a match open. The game shows the clock in the last 5 minutes and through the grace.
