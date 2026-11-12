-- The Court: two-player multiplayer (DEVELOPMENT project only).
--
-- Applied automatically by scripts/mp_setup.py to the dev project
-- "the-court-multiplayer-dev". Never run this against production.
--
-- Shape of it:
--   * Players are anonymous Supabase Auth users (signInAnonymously): every
--     request carries a signed JWT, so auth.uid() is a server-checked
--     identity and nobody can act as somebody else.
--   * The tables are readable only by the two members of a match (RLS), and
--     writable by nobody: every change goes through the functions below,
--     which check who is asking, what state the match is in, and whether the
--     numbers are possible. Realtime only tells the other device to re-read.
--   * The server owns the clock: invite expiry (1 hour), the ready window,
--     the countdown's start time, the 30-second reconnect window and the
--     final result are all decided here, never in the browser.
--   * Scores are played in each browser (as in solo). The server cannot
--     replay the physics, so it checks every checkpoint against what the
--     game allows: lives only go down, courts only go up one at a time and
--     no faster than a court can be played, bricks never come back, and
--     the score can only rise by what the newly broken bricks of that court
--     (its real layout, in multiplayer_courts) are worth at the top x3
--     combo, plus the clear bonus once per court, with bricks falling no
--     faster than 40 a second.
--
-- Safe to run again (create or replace / if not exists).

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------------ tables

create table if not exists public.multiplayer_matches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'waiting'
    check (status in ('waiting', 'waiting_for_ready', 'starting', 'active', 'completed', 'cancelled', 'expired')),
  host_user_id uuid not null,
  host_player_id uuid,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  ready_deadline timestamptz,
  start_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  winner_player_id uuid,
  result_status text check (result_status in ('win', 'draw', 'cancelled', 'expired', 'ready_timeout', 'abandoned')),
  rematch_of uuid unique references public.multiplayer_matches (id) on delete set null,
  match_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (host_user_id, request_id)
);

create table if not exists public.multiplayer_players (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.multiplayer_matches (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('host', 'guest')),
  display_name text not null check (display_name ~ '^[A-Z0-9 .-]{1,8}$' and btrim(display_name) <> ''),
  joined_at timestamptz not null default now(),
  ready_at timestamptz,
  score bigint not null default 0 check (score >= 0),
  court int not null default 1 check (court between 1 and 120),
  lives int not null default 3 check (lives between 0 and 3),
  broken text not null default '' check (length(broken) <= 64),
  seq int not null default 0,
  court_started_at timestamptz,
  checkpoint_at timestamptz, -- when the last checkpoint was accepted (paces how fast bricks may fall)
  connection_status text not null default 'online' check (connection_status in ('online', 'reconnecting', 'timeout', 'left')),
  last_seen_at timestamptz not null default now(),
  reconnect_count int not null default 0,
  final_score bigint,
  finished_at timestamptz,
  finish_reason text check (finish_reason in ('out_of_lives', 'all_courts', 'timeout', 'left', 'time_up')),
  rematch_requested_at timestamptz,
  rematch_declined_at timestamptz,
  unique (match_id, user_id),
  unique (match_id, role)
);

do $$ begin
  alter table public.multiplayer_matches
    add constraint multiplayer_matches_host_fk foreign key (host_player_id) references public.multiplayer_players (id) deferrable initially deferred;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.multiplayer_matches
    add constraint multiplayer_matches_winner_fk foreign key (winner_player_id) references public.multiplayer_players (id) deferrable initially deferred;
exception when duplicate_object then null; end $$;

create table if not exists public.multiplayer_invites (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.multiplayer_matches (id) on delete cascade,
  token_hash text not null unique, -- sha-256 of the token; the token itself is never stored
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid,
  cancelled_at timestamptz,
  status text not null default 'active' check (status in ('active', 'consumed', 'cancelled', 'expired'))
);
create unique index if not exists multiplayer_invites_one_active on public.multiplayer_invites (match_id) where status = 'active';

-- Lifecycle events only (created, joined, ready, started, court cleared,
-- finished, completed...), never ball movement.
create table if not exists public.multiplayer_match_events (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.multiplayer_matches (id) on delete cascade,
  player_id uuid references public.multiplayer_players (id) on delete cascade,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Abuse protection: a row per sensitive action, counted per user per hour.
create table if not exists public.multiplayer_rate (
  user_id uuid not null,
  action text not null,
  at timestamptz not null default now()
);

-- Each court's bricks in the game's own order (T, L, H or S per brick), so a
-- checkpoint is checked brick by brick, and reach: the soonest (seconds after
-- the match starts) a run could have cleared it, timed by a bot beyond any
-- player. Filled by 003_courts.sql, which is generated from js/levels.js
-- (node scripts/mp_courts.mjs).
create table if not exists public.multiplayer_courts (
  court int primary key check (court between 1 and 120),
  bricks text not null check (bricks ~ '^[TLHS]+$' and length(bricks) <= 400), -- the biggest court has 339
  reach real not null default 0 check (reach >= 0)
);

-- For tables made before these columns.
alter table public.multiplayer_players add column if not exists checkpoint_at timestamptz;
alter table public.multiplayer_players drop constraint if exists multiplayer_players_finish_reason_check;
alter table public.multiplayer_players add constraint multiplayer_players_finish_reason_check
  check (finish_reason in ('out_of_lives', 'all_courts', 'timeout', 'left', 'time_up'));
alter table public.multiplayer_courts add column if not exists reach real not null default 0;

create index if not exists multiplayer_players_user on public.multiplayer_players (user_id);
create index if not exists multiplayer_players_match on public.multiplayer_players (match_id);
create index if not exists multiplayer_matches_status on public.multiplayer_matches (status, created_at);
create index if not exists multiplayer_matches_host on public.multiplayer_matches (host_user_id, status);
create index if not exists multiplayer_events_match on public.multiplayer_match_events (match_id, created_at);
create index if not exists multiplayer_rate_lookup on public.multiplayer_rate (user_id, action, at);

-- ------------------------------------------------------------------ security

alter table public.multiplayer_matches enable row level security;
alter table public.multiplayer_players enable row level security;
alter table public.multiplayer_invites enable row level security;
alter table public.multiplayer_match_events enable row level security;
alter table public.multiplayer_rate enable row level security;
alter table public.multiplayer_courts enable row level security;

revoke all on public.multiplayer_matches, public.multiplayer_players, public.multiplayer_invites,
  public.multiplayer_match_events, public.multiplayer_rate, public.multiplayer_courts from anon, authenticated;
-- Members may read their own match and its two players (for Realtime); nothing else.
grant select on public.multiplayer_matches, public.multiplayer_players to authenticated;

create or replace function public.mp_is_member(p_match uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (select 1 from public.multiplayer_players where match_id = p_match and user_id = auth.uid());
$$;
-- Signed-in players only (the read policies call it as them); never the anonymous role.
revoke all on function public.mp_is_member(uuid) from public, anon;
grant execute on function public.mp_is_member(uuid) to authenticated;

drop policy if exists "members read their match" on public.multiplayer_matches;
create policy "members read their match" on public.multiplayer_matches
  for select to authenticated using (public.mp_is_member(id));
drop policy if exists "members read their players" on public.multiplayer_players;
create policy "members read their players" on public.multiplayer_players
  for select to authenticated using (public.mp_is_member(match_id));
-- invites, events and rate rows: no policies at all, so no direct access.

-- Realtime: changes to a member's match and players reach both devices
-- (filtered by the RLS policies above).
do $$ begin
  alter publication supabase_realtime add table public.multiplayer_matches;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.multiplayer_players;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ------------------------------------------------------------------ helpers

-- Errors the game turns into friendly screens: every one is "mp:<reason>".
create or replace function public.mp_fail(p_reason text)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception 'mp:%', p_reason using errcode = 'P0001';
end $$;

create or replace function public.mp_uid()
returns uuid language plpgsql stable set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then perform public.mp_fail('not_signed_in'); end if;
  return u;
end $$;

create or replace function public.mp_name(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare n text := upper(btrim(coalesce(p, '')));
begin
  if n !~ '^[A-Z0-9 .-]{1,8}$' or n = '' then perform public.mp_fail('bad_name'); end if;
  return n;
end $$;

create or replace function public.mp_rate(p_user uuid, p_action text, p_limit int)
returns void language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.multiplayer_rate where user_id = p_user and action = p_action and at > now() - interval '1 hour') >= p_limit then
    perform public.mp_fail('rate_limited');
  end if;
  insert into public.multiplayer_rate (user_id, action) values (p_user, p_action);
  delete from public.multiplayer_rate where at < now() - interval '1 day';
end $$;

create or replace function public.mp_event(p_match uuid, p_player uuid, p_kind text, p_data jsonb default '{}'::jsonb)
returns void language sql set search_path = '' as $$
  insert into public.multiplayer_match_events (match_id, player_id, kind, data) values (p_match, p_player, p_kind, p_data);
$$;

-- A court's "broken" bitmap (base64, bit i = brick i, as js/multiplayer.js
-- writes it), checked against the court's real brick count and returned as
-- exactly ceil(n / 8) bytes. A bit past the last brick is refused.
create or replace function public.mp_map(p text, n int)
returns bytea language plpgsql immutable set search_path = '' as $$
declare b bytea := ''::bytea; size int := (n + 7) / 8; i int;
begin
  if p is not null and p <> '' then
    begin
      b := decode(p, 'base64');
    exception when others then
      perform public.mp_fail('bad_checkpoint');
    end;
  end if;
  if length(b) > size then perform public.mp_fail('bad_checkpoint'); end if;
  if length(b) < size then b := b || decode(repeat('00', size - length(b)), 'hex'); end if;
  for i in n .. size * 8 - 1 loop
    if get_bit(b, i) = 1 then perform public.mp_fail('bad_checkpoint'); end if;
  end loop;
  return b;
end $$;

create or replace function public.mp_full(b bytea, n int)
returns boolean language sql immutable set search_path = '' as $$
  select n > 0 and bit_count(b) = n;
$$;

-- The most one brick can score: its points at the top x3 combo, rounded to
-- 5 like brickPoints() in js/game.js (T 10, L 15, H 30, S 50 points).
create or replace function public.mp_brick_max(t text)
returns int language sql immutable set search_path = '' as $$
  select case t when 'T' then 30 when 'L' then 45 when 'H' then 90 when 'S' then 150 end;
$$;

create or replace function public.mp_token_hash(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.mp_new_token()
returns text language sql volatile set search_path = '' as $$
  select translate(rtrim(encode(extensions.gen_random_bytes(24), 'base64'), '='), '+/', '-_');
$$;

-- Finish one player's game at their last verified score.
create or replace function public.mp_finish_player(p_player uuid, p_reason text)
returns void language plpgsql set search_path = '' as $$
declare pl public.multiplayer_players;
begin
  update public.multiplayer_players
     set finished_at = now(), final_score = score, finish_reason = p_reason,
         lives = case when p_reason = 'all_courts' then lives else lives end
   where id = p_player and finished_at is null
   returning * into pl;
  if found then
    perform public.mp_event(pl.match_id, pl.id, 'player_finished', jsonb_build_object('reason', p_reason, 'score', pl.score, 'court', pl.court));
  end if;
end $$;

-- The one authoritative result: higher verified final score wins; equal is a draw.
create or replace function public.mp_complete(p_match uuid)
returns void language plpgsql set search_path = '' as $$
declare a public.multiplayer_players; b public.multiplayer_players; winner uuid; res text;
begin
  select * into a from public.multiplayer_players where match_id = p_match and role = 'host';
  select * into b from public.multiplayer_players where match_id = p_match and role = 'guest';
  if a.final_score > b.final_score then winner := a.id; res := 'win';
  elsif b.final_score > a.final_score then winner := b.id; res := 'win';
  else winner := null; res := 'draw';
  end if;
  update public.multiplayer_matches
     set status = 'completed', result_status = res, winner_player_id = winner, finished_at = now(), updated_at = now()
   where id = p_match and status = 'active';
  if found then
    perform public.mp_event(p_match, null, 'match_completed', jsonb_build_object('result', res, 'host', a.final_score, 'guest', b.final_score));
  end if;
end $$;

-- Lazy lifecycle: every read or write of a match moves it on if its time
-- has come (expiry, ready timeout, countdown over, a player gone too long,
-- both players finished).
-- The time limits (seconds): the longest a match can be played, and how
-- long the other player has to finish once one is done.
create or replace function public.mp_match_secs()
returns int language sql immutable set search_path = '' as $$ select 30 * 60 $$;
create or replace function public.mp_grace_secs()
returns int language sql immutable set search_path = '' as $$ select 3 * 60 $$;

-- When a match in play ends at the latest: its full time, or sooner once one
-- player is done (their finish + the grace). Null before it starts.
create or replace function public.mp_ends_at(p_match uuid)
returns timestamptz language sql stable set search_path = '' as $$
  select least(m.started_at + make_interval(secs => public.mp_match_secs()),
               (select min(p.finished_at) + make_interval(secs => public.mp_grace_secs())
                  from public.multiplayer_players p where p.match_id = m.id))
    from public.multiplayer_matches m where m.id = p_match;
$$;

-- Matches nobody has looked at since their time ran out (both players gone):
-- settled whenever anyone calls, a few at a time.
create or replace function public.mp_sweep()
returns void language plpgsql set search_path = '' as $$
declare r record;
begin
  for r in select id from public.multiplayer_matches
            where status in ('starting', 'active') and started_at < now() - make_interval(secs => public.mp_match_secs())
            order by started_at limit 10
              for update skip locked -- never wait on (or deadlock with) a match someone else is settling
  loop
    perform public.mp_refresh(r.id);
  end loop;
end $$;

create or replace function public.mp_refresh(p_match uuid)
returns void language plpgsql set search_path = '' as $$
declare m public.multiplayer_matches; pl record; left_count int;
begin
  select * into m from public.multiplayer_matches where id = p_match for update;
  if not found then return; end if;

  if m.status = 'waiting' and now() >= m.expires_at then
    update public.multiplayer_matches set status = 'expired', result_status = 'expired', finished_at = now(), updated_at = now() where id = m.id;
    update public.multiplayer_invites set status = 'expired' where match_id = m.id and status = 'active';
    perform public.mp_event(m.id, null, 'invite_expired');
    return;
  end if;

  if m.status = 'waiting_for_ready' then
    if now() >= m.ready_deadline then
      update public.multiplayer_matches set status = 'cancelled', result_status = 'ready_timeout', finished_at = now(), updated_at = now() where id = m.id;
      perform public.mp_event(m.id, null, 'ready_timeout');
      return;
    end if;
    -- Someone vanished before the countdown: the match is called off.
    if exists (select 1 from public.multiplayer_players where match_id = m.id and (connection_status = 'left' or last_seen_at < now() - interval '30 seconds')) then
      update public.multiplayer_matches set status = 'cancelled', result_status = 'abandoned', finished_at = now(), updated_at = now() where id = m.id;
      perform public.mp_event(m.id, null, 'abandoned_before_start');
      return;
    end if;
  end if;

  if m.status = 'starting' and now() >= m.start_at then
    update public.multiplayer_matches set status = 'active', updated_at = now() where id = m.id;
    update public.multiplayer_players set court_started_at = m.start_at where match_id = m.id;
    perform public.mp_event(m.id, null, 'match_started');
    m.status := 'active';
  end if;

  if m.status = 'active' then
    -- Connection: quiet for 8 s = reconnecting; for 30 s = timed out, and that
    -- player's game ends at their last verified score.
    for pl in select * from public.multiplayer_players where match_id = m.id and finished_at is null loop
      if pl.last_seen_at < now() - interval '30 seconds' then
        update public.multiplayer_players set connection_status = 'timeout' where id = pl.id;
        perform public.mp_finish_player(pl.id, 'timeout');
        perform public.mp_event(m.id, pl.id, 'disconnect_timeout');
      elsif pl.last_seen_at < now() - interval '8 seconds' and pl.connection_status = 'online' then
        update public.multiplayer_players set connection_status = 'reconnecting' where id = pl.id;
        perform public.mp_event(m.id, pl.id, 'connection_lost');
      end if;
    end loop;
    -- Time: a match lasts at most mp_match_secs() of play, and once one
    -- player is done the other has mp_grace_secs() to finish. Then their game
    -- ends at their last verified score, so nobody can keep a match open.
    if now() >= public.mp_ends_at(m.id) then
      for pl in select * from public.multiplayer_players where match_id = m.id and finished_at is null loop
        perform public.mp_finish_player(pl.id, 'time_up');
        perform public.mp_event(m.id, pl.id, 'time_up', jsonb_build_object('why', case when now() >= m.started_at + make_interval(secs => public.mp_match_secs()) then 'match' else 'grace' end));
      end loop;
    end if;
    select count(*) into left_count from public.multiplayer_players where match_id = m.id and finished_at is null;
    if left_count = 0 then perform public.mp_complete(m.id); end if;
  end if;
end $$;

-- What a member sees: the match, themselves and their opponent, and the
-- server's clock (the countdown is timed from it).
create or replace function public.mp_state_json(p_match uuid, p_user uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare m public.multiplayer_matches; me public.multiplayer_players; op public.multiplayer_players; rematch uuid;
  pj jsonb; oj jsonb;
begin
  select * into m from public.multiplayer_matches where id = p_match;
  select * into me from public.multiplayer_players where match_id = p_match and user_id = p_user;
  select * into op from public.multiplayer_players where match_id = p_match and user_id <> p_user;
  select id into rematch from public.multiplayer_matches where rematch_of = p_match;
  pj := jsonb_build_object('id', me.id, 'role', me.role, 'name', me.display_name, 'ready', me.ready_at is not null,
    'score', me.score, 'court', me.court, 'lives', me.lives, 'broken', me.broken, 'seq', me.seq,
    'connection', me.connection_status, 'finished', me.finished_at is not null, 'final_score', me.final_score,
    'finish_reason', me.finish_reason, 'reconnects', me.reconnect_count, 'rematch', me.rematch_requested_at is not null,
    'declined', me.rematch_declined_at is not null);
  if op.id is not null then
    oj := jsonb_build_object('id', op.id, 'role', op.role, 'name', op.display_name, 'ready', op.ready_at is not null,
      'score', op.score, 'court', op.court, 'lives', op.lives,
      'connection', op.connection_status, 'finished', op.finished_at is not null, 'final_score', op.final_score,
      'finish_reason', op.finish_reason, 'rematch', op.rematch_requested_at is not null, 'declined', op.rematch_declined_at is not null);
  end if;
  return jsonb_build_object(
    'server_now', floor(extract(epoch from clock_timestamp()) * 1000),
    'match', jsonb_build_object('id', m.id, 'status', m.status, 'result', m.result_status,
      'winner', case when m.winner_player_id is null then null when m.winner_player_id = me.id then 'me' else 'opponent' end,
      'created_at', floor(extract(epoch from m.created_at) * 1000), 'expires_at', floor(extract(epoch from m.expires_at) * 1000),
      'ready_deadline', floor(extract(epoch from m.ready_deadline) * 1000), 'start_at', floor(extract(epoch from m.start_at) * 1000),
      'finished_at', floor(extract(epoch from m.finished_at) * 1000), 'rematch_of', m.rematch_of, 'rematch_id', rematch,
      'ends_at', floor(extract(epoch from public.mp_ends_at(m.id)) * 1000),
      'time_ends_at', floor(extract(epoch from m.started_at + make_interval(secs => public.mp_match_secs())) * 1000)),
    'me', pj, 'opponent', oj);
end $$;

-- ------------------------------------------------------------------ the API

-- Host: create a match and its invite. p_request makes repeated taps (or a
-- retried request) land on the same match: it is re-issued a fresh token
-- and the old one is cancelled, so there is never a second match.
create or replace function public.mp_create_match(p_name text, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); n text := public.mp_name(p_name); m public.multiplayer_matches; pid uuid; tok text;
begin
  if p_request is null then perform public.mp_fail('bad_request'); end if;
  select * into m from public.multiplayer_matches where host_user_id = u and request_id = p_request;
  if found then
    if m.status <> 'waiting' then perform public.mp_fail('unavailable'); end if;
  else
    perform public.mp_rate(u, 'create', 20);
    -- One open match per host: older waiting ones are called off.
    update public.multiplayer_invites set status = 'cancelled', cancelled_at = now()
     where status = 'active' and match_id in (select id from public.multiplayer_matches where host_user_id = u and status = 'waiting');
    update public.multiplayer_matches set status = 'cancelled', result_status = 'cancelled', finished_at = now(), updated_at = now()
     where host_user_id = u and status = 'waiting';
    insert into public.multiplayer_matches (host_user_id, request_id) values (u, p_request) returning * into m;
    insert into public.multiplayer_players (match_id, user_id, role, display_name) values (m.id, u, 'host', n) returning id into pid;
    update public.multiplayer_matches set host_player_id = pid where id = m.id;
    perform public.mp_event(m.id, pid, 'match_created');
    perform public.mp_sweep();
    -- Retention: matches that never started are removed after 7 days.
    delete from public.multiplayer_matches where status in ('cancelled', 'expired') and created_at < now() - interval '7 days';
  end if;
  update public.multiplayer_invites set status = 'cancelled', cancelled_at = now() where match_id = m.id and status = 'active';
  tok := public.mp_new_token();
  insert into public.multiplayer_invites (match_id, token_hash, expires_at) values (m.id, public.mp_token_hash(tok), m.expires_at);
  perform public.mp_event(m.id, null, 'invite_generated');
  return jsonb_build_object('token', tok, 'state', public.mp_state_json(m.id, u));
end $$;

-- Invitee: what an invite link is, before joining. Never reveals the token
-- or anything about the match beyond the host's name.
create or replace function public.mp_invite_info(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); i public.multiplayer_invites; m public.multiplayer_matches; host text; st text;
begin
  perform public.mp_rate(u, 'invite_info', 120);
  select * into i from public.multiplayer_invites where token_hash = public.mp_token_hash(p_token);
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  perform public.mp_refresh(i.match_id);
  select * into i from public.multiplayer_invites where id = i.id;
  select * into m from public.multiplayer_matches where id = i.match_id;
  select display_name into host from public.multiplayer_players where match_id = m.id and role = 'host';
  st := case
    when i.status = 'consumed' and i.consumed_by = u then 'joined'
    when i.status = 'consumed' then 'used'
    when i.status = 'cancelled' then 'cancelled'
    when i.status = 'expired' or now() >= i.expires_at then 'expired'
    when m.host_user_id = u then 'own'
    when m.status <> 'waiting' then 'unavailable'
    else 'valid' end;
  return jsonb_build_object('status', st, 'host_name', host, 'expires_at', floor(extract(epoch from i.expires_at) * 1000),
    'match_id', case when st = 'joined' or st = 'own' then m.id else null end);
end $$;

-- Invitee: join. The invite row is locked, so of two joins at the same
-- moment exactly one wins; the other is told the invite is used.
create or replace function public.mp_join(p_token text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); n text := public.mp_name(p_name); i public.multiplayer_invites; m public.multiplayer_matches; pid uuid;
begin
  perform public.mp_rate(u, 'join', 30);
  select * into i from public.multiplayer_invites where token_hash = public.mp_token_hash(p_token) for update;
  if not found then perform public.mp_fail('invalid'); end if;
  select * into m from public.multiplayer_matches where id = i.match_id for update;
  if i.status = 'consumed' then
    if i.consumed_by = u then return public.mp_state_json(m.id, u); end if; -- the same player tapping twice
    perform public.mp_fail('used');
  end if;
  if i.status = 'cancelled' then perform public.mp_fail('cancelled'); end if;
  if i.status = 'expired' or now() >= i.expires_at then
    update public.multiplayer_invites set status = 'expired' where id = i.id;
    perform public.mp_fail('expired');
  end if;
  if m.host_user_id = u then perform public.mp_fail('own'); end if;
  if m.status <> 'waiting' then perform public.mp_fail('unavailable'); end if;
  begin
    insert into public.multiplayer_players (match_id, user_id, role, display_name) values (m.id, u, 'guest', n) returning id into pid;
  exception when unique_violation then
    perform public.mp_fail('full');
  end;
  update public.multiplayer_invites set status = 'consumed', consumed_at = now(), consumed_by = u where id = i.id;
  update public.multiplayer_matches set status = 'waiting_for_ready', ready_deadline = now() + interval '5 minutes', updated_at = now() where id = m.id;
  update public.multiplayer_players set last_seen_at = now() where match_id = m.id;
  perform public.mp_event(m.id, pid, 'invite_joined');
  return public.mp_state_json(m.id, u);
end $$;

-- Read a match (and say "I'm here": this is also the heartbeat).
create or replace function public.mp_state(p_match uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); me public.multiplayer_players;
begin
  select * into me from public.multiplayer_players where match_id = p_match and user_id = u;
  if not found then perform public.mp_fail('not_member'); end if;
  if me.finished_at is null and me.connection_status in ('online', 'reconnecting') then
    update public.multiplayer_players
       set last_seen_at = now(), connection_status = 'online',
           reconnect_count = reconnect_count + case when connection_status = 'reconnecting' then 1 else 0 end
     where id = me.id;
    if me.connection_status = 'reconnecting' then perform public.mp_event(p_match, me.id, 'reconnected'); end if;
  elsif me.finished_at is not null then
    update public.multiplayer_players set last_seen_at = now() where id = me.id;
  end if;
  perform public.mp_refresh(p_match);
  perform public.mp_sweep();
  return public.mp_state_json(p_match, u);
end $$;

-- Ready. When both are, the server sets the start: 4 seconds from now.
create or replace function public.mp_ready(p_match uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); m public.multiplayer_matches; me public.multiplayer_players;
begin
  perform public.mp_refresh(p_match);
  select * into m from public.multiplayer_matches where id = p_match for update;
  select * into me from public.multiplayer_players where match_id = p_match and user_id = u;
  if me.id is null then perform public.mp_fail('not_member'); end if;
  if m.status <> 'waiting_for_ready' then return public.mp_state_json(p_match, u); end if;
  update public.multiplayer_players set ready_at = coalesce(ready_at, now()), last_seen_at = now(), connection_status = 'online' where id = me.id;
  if me.ready_at is null then perform public.mp_event(p_match, me.id, 'player_ready'); end if;
  if (select count(*) from public.multiplayer_players where match_id = p_match and ready_at is not null) = 2 then
    update public.multiplayer_matches set status = 'starting', start_at = now() + interval '4 seconds', started_at = now() + interval '4 seconds', updated_at = now() where id = p_match;
    update public.multiplayer_players set score = 0, court = 1, lives = 3, broken = '', seq = 0, checkpoint_at = null, last_seen_at = now() where match_id = p_match;
    perform public.mp_event(p_match, null, 'countdown_started');
  end if;
  return public.mp_state_json(p_match, u);
end $$;

-- A checkpoint from a player's own game. Checked against what the game allows.
create or replace function public.mp_checkpoint(p_match uuid, p_seq int, p_score bigint, p_court int, p_lives int, p_broken text, p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); m public.multiplayer_matches; me public.multiplayer_players;
  cur text; nxt text; soonest real; old_b bytea; new_b bytea; most bigint := 0; fell int := 0; secs numeric; i int;
begin
  perform public.mp_refresh(p_match);
  select * into m from public.multiplayer_matches where id = p_match;
  select * into me from public.multiplayer_players where match_id = p_match and user_id = u for update;
  if me.id is null then perform public.mp_fail('not_member'); end if;
  if m.status <> 'active' then
    if m.status = 'starting' then perform public.mp_fail('not_started'); end if;
    return public.mp_state_json(p_match, u); -- over already: nothing more counts
  end if;
  if me.finished_at is not null then return public.mp_state_json(p_match, u); end if;
  if p_seq is null or p_seq <= me.seq then return public.mp_state_json(p_match, u); end if; -- a repeat: ignored, never counted twice
  if p_lives is null or p_lives < 0 or p_lives > me.lives then perform public.mp_fail('bad_lives'); end if;
  if p_court is null or p_court < me.court or p_court > me.court + 1 or p_court > 120 then perform public.mp_fail('bad_court'); end if;
  if p_score is null or p_score < me.score or p_score % 5 <> 0 then perform public.mp_fail('bad_score'); end if;
  -- The score may rise only by what the newly broken bricks can be worth
  -- (each at its top combo value) plus the clear bonus, once per court.
  select c.bricks, c.reach into cur, soonest from public.multiplayer_courts c where c.court = me.court;
  if cur is null then perform public.mp_fail('bad_court'); end if;
  old_b := public.mp_map(me.broken, length(cur));
  if p_court = me.court then
    new_b := public.mp_map(p_broken, length(cur));
    for i in 0 .. length(cur) - 1 loop
      if get_bit(old_b, i) = 1 and get_bit(new_b, i) = 0 then perform public.mp_fail('bad_checkpoint'); end if; -- a brick came back
      if get_bit(new_b, i) = 1 and get_bit(old_b, i) = 0 then
        most := most + public.mp_brick_max(substr(cur, i + 1, 1));
        fell := fell + 1;
      end if;
    end loop;
    if public.mp_full(new_b, length(cur)) and not public.mp_full(old_b, length(cur)) then most := most + me.lives * 100; end if;
  else
    -- A court cleared: no faster than a court can be played (the countdown alone takes over 2 s).
    if me.court_started_at is not null and now() < me.court_started_at + interval '5 seconds' then perform public.mp_fail('too_fast'); end if;
    if p_lives < 1 then perform public.mp_fail('bad_lives'); end if;
    if not public.mp_full(old_b, length(cur)) then
      for i in 0 .. length(cur) - 1 loop
        if get_bit(old_b, i) = 0 then
          most := most + public.mp_brick_max(substr(cur, i + 1, 1));
          fell := fell + 1;
        end if;
      end loop;
      most := most + me.lives * 100;
    end if;
    select bricks into nxt from public.multiplayer_courts where court = p_court;
    if nxt is null then perform public.mp_fail('bad_court'); end if;
    new_b := public.mp_map(p_broken, length(nxt));
    for i in 0 .. length(nxt) - 1 loop
      if get_bit(new_b, i) = 1 then
        most := most + public.mp_brick_max(substr(nxt, i + 1, 1));
        fell := fell + 1;
      end if;
    end loop;
  end if;
  if p_score - me.score > most then perform public.mp_fail('bad_score'); end if;
  -- No faster than bricks can fall since the last accepted checkpoint: 150,
  -- plus 110 a second. Measured in the game itself (scripts/mp_courts.mjs'
  -- bot), the most ever seen is 97 in a quarter second, 173 in one second and
  -- 328 in five; this allows about half as much again.
  secs := greatest(0, extract(epoch from now() - coalesce(me.checkpoint_at, m.started_at, now())));
  if fell > 150 + 110 * secs then perform public.mp_fail('too_fast'); end if;
  -- And over the whole match: a court finished (cleared, or left for the next)
  -- no sooner than 3/4 of the soonest that bot could have got there.
  if (p_court <> me.court or (public.mp_full(new_b, length(cur)) and not public.mp_full(old_b, length(cur))))
     and now() < coalesce(m.started_at, now()) + make_interval(secs => 0.75 * soonest) then
    perform public.mp_fail('too_fast');
  end if;
  -- Finishing every court means court 120 really is cleared.
  if p_done and p_lives > 0 and p_court = 120 and not public.mp_full(new_b, length(coalesce(nxt, cur))) then
    perform public.mp_fail('bad_checkpoint');
  end if;
  update public.multiplayer_players
     set seq = p_seq, score = p_score, court = p_court, lives = p_lives, broken = coalesce(p_broken, ''),
         last_seen_at = now(), connection_status = 'online', checkpoint_at = now(),
         court_started_at = case when p_court <> me.court then now() else court_started_at end
   where id = me.id;
  if p_court <> me.court then perform public.mp_event(p_match, me.id, 'court_cleared', jsonb_build_object('court', me.court, 'score', p_score)); end if;
  if p_lives = 0 then perform public.mp_finish_player(me.id, 'out_of_lives');
  -- Court 120 cleared is the end of the run, "done" or not: a lost or
  -- refused final checkpoint must not leave the player waiting for ever.
  elsif p_court = 120 and public.mp_full(new_b, length(coalesce(nxt, cur))) then perform public.mp_finish_player(me.id, 'all_courts');
  end if;
  perform public.mp_refresh(p_match);
  return public.mp_state_json(p_match, u);
end $$;

-- Leave. Before the start the match is called off; during it, this
-- player's game ends at their last verified score and the other plays on.
create or replace function public.mp_leave(p_match uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); m public.multiplayer_matches; me public.multiplayer_players;
begin
  select * into m from public.multiplayer_matches where id = p_match for update;
  select * into me from public.multiplayer_players where match_id = p_match and user_id = u;
  if me.id is null then perform public.mp_fail('not_member'); end if;
  if m.status in ('waiting', 'waiting_for_ready') then
    update public.multiplayer_matches set status = 'cancelled', result_status = 'cancelled', finished_at = now(), updated_at = now() where id = p_match;
    update public.multiplayer_invites set status = 'cancelled', cancelled_at = now() where match_id = p_match and status = 'active';
    update public.multiplayer_players set connection_status = 'left' where id = me.id;
    perform public.mp_event(p_match, me.id, 'left_before_start');
  elsif m.status in ('starting', 'active') then
    update public.multiplayer_players set connection_status = 'left' where id = me.id;
    if m.status = 'starting' then
      update public.multiplayer_matches set status = 'active' where id = p_match;
    end if;
    perform public.mp_finish_player(me.id, 'left');
    perform public.mp_refresh(p_match);
  end if;
  return public.mp_state_json(p_match, u);
end $$;

-- Rematch: both must ask. The second ask creates the new match (straight to
-- the ready screen, no invite); the old result stays as it was.
create or replace function public.mp_rematch(p_match uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid(); m public.multiplayer_matches; me public.multiplayer_players; op public.multiplayer_players; nm uuid; hp uuid;
begin
  select * into m from public.multiplayer_matches where id = p_match for update;
  select * into me from public.multiplayer_players where match_id = p_match and user_id = u;
  select * into op from public.multiplayer_players where match_id = p_match and user_id <> u;
  if me.id is null then perform public.mp_fail('not_member'); end if;
  if m.status <> 'completed' then perform public.mp_fail('unavailable'); end if;
  if op.rematch_declined_at is not null then perform public.mp_fail('declined'); end if;
  perform public.mp_rate(u, 'rematch', 30);
  update public.multiplayer_players set rematch_requested_at = coalesce(rematch_requested_at, now()), rematch_declined_at = null where id = me.id;
  if me.rematch_requested_at is null then perform public.mp_event(p_match, me.id, 'rematch_requested'); end if;
  if op.rematch_requested_at is not null and not exists (select 1 from public.multiplayer_matches where rematch_of = p_match) then
    insert into public.multiplayer_matches (host_user_id, request_id, status, rematch_of, ready_deadline)
      values (m.host_user_id, gen_random_uuid(), 'waiting_for_ready', p_match, now() + interval '5 minutes')
      on conflict do nothing returning id into nm;
    if nm is not null then
      insert into public.multiplayer_players (match_id, user_id, role, display_name)
        select nm, user_id, role, display_name from public.multiplayer_players where match_id = p_match;
      select id into hp from public.multiplayer_players where match_id = nm and role = 'host';
      update public.multiplayer_matches set host_player_id = hp where id = nm;
      perform public.mp_event(nm, null, 'rematch_started', jsonb_build_object('from', p_match));
    end if;
  end if;
  return public.mp_state_json(p_match, u);
end $$;

-- Say no to a rematch (leaving the result screen).
create or replace function public.mp_decline(p_match uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := public.mp_uid();
begin
  update public.multiplayer_players set rematch_declined_at = now(), rematch_requested_at = null
   where match_id = p_match and user_id = u and not exists (select 1 from public.multiplayer_matches where rematch_of = p_match);
  if not public.mp_is_member(p_match) then perform public.mp_fail('not_member'); end if;
  return public.mp_state_json(p_match, u);
end $$;

-- Friends leaderboard: you and everyone you have finished a match with,
-- ranked by wins, then fewer losses, then more draws, then name.
create or replace function public.mp_leaderboard()
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare u uuid := public.mp_uid();
begin
  return coalesce((
    with circle as (
      select u as user_id
      union
      select o.user_id from public.multiplayer_players me
        join public.multiplayer_matches m on m.id = me.match_id and m.status = 'completed'
        join public.multiplayer_players o on o.match_id = me.match_id and o.user_id <> me.user_id
       where me.user_id = u
    ),
    games as (
      select p.user_id, p.display_name, p.final_score, m.finished_at,
             case when m.result_status = 'draw' then 'draw' when m.winner_player_id = p.id then 'win' else 'loss' end as outcome
        from public.multiplayer_players p
        join public.multiplayer_matches m on m.id = p.match_id and m.status = 'completed'
       where p.user_id in (select user_id from circle)
    ),
    agg as (
      select user_id,
             (array_agg(display_name order by finished_at desc))[1] as name,
             count(*) filter (where outcome = 'win') as wins,
             count(*) filter (where outcome = 'loss') as losses,
             count(*) filter (where outcome = 'draw') as draws,
             count(*) as matches,
             coalesce(sum(final_score), 0) as points
        from games group by user_id
    )
    select jsonb_agg(jsonb_build_object('rank', rnk, 'name', name, 'wins', wins, 'losses', losses, 'draws', draws,
             'matches', matches, 'points', points, 'me', user_id = u) order by rnk)
      from (select *, row_number() over (order by wins desc, losses asc, draws desc, name asc) as rnk from agg) ranked
     where rnk <= 50
  ), '[]'::jsonb);
end $$;

-- Your match history: the last 20 matches that had an opponent.
create or replace function public.mp_history()
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare u uuid := public.mp_uid();
begin
  return coalesce((
    select jsonb_agg(row_to_json(h)::jsonb order by h.at desc) from (
      select m.id, m.status, m.result_status as result,
             floor(extract(epoch from coalesce(m.finished_at, m.created_at)) * 1000) as at,
             me.display_name as me_name, me.final_score as me_score, me.score as me_live,
             o.display_name as opp_name, o.final_score as opp_score, o.score as opp_live,
             case when m.result_status = 'draw' then 'draw' when m.winner_player_id = me.id then 'won'
                  when m.winner_player_id = o.id then 'lost' else null end as outcome
        from public.multiplayer_players me
        join public.multiplayer_matches m on m.id = me.match_id
        join public.multiplayer_players o on o.match_id = m.id and o.user_id <> me.user_id
       where me.user_id = u
       order by coalesce(m.finished_at, m.created_at) desc
       limit 20) h
  ), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------------ grants

do $$
declare f text;
begin
  foreach f in array array[
    'mp_fail(text)', 'mp_uid()', 'mp_name(text)', 'mp_rate(uuid,text,integer)', 'mp_event(uuid,uuid,text,jsonb)', 'mp_map(text,integer)',
    'mp_full(bytea,integer)', 'mp_brick_max(text)', 'mp_match_secs()', 'mp_grace_secs()', 'mp_ends_at(uuid)', 'mp_sweep()',
    'mp_token_hash(text)', 'mp_new_token()', 'mp_finish_player(uuid,text)', 'mp_complete(uuid)', 'mp_refresh(uuid)', 'mp_state_json(uuid,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'mp_create_match(text,uuid)', 'mp_invite_info(text)', 'mp_join(text,text)', 'mp_state(uuid)', 'mp_ready(uuid)',
    'mp_checkpoint(uuid,integer,bigint,integer,integer,text,boolean)', 'mp_leave(uuid)', 'mp_rematch(uuid)', 'mp_decline(uuid)',
    'mp_leaderboard()', 'mp_history()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
