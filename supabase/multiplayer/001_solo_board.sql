-- The Court (DEVELOPMENT project only): the solo leaderboard table, so the
-- game-3 preview has its own copy and never touches production data.
-- Same shape and the same checked submit_score as production
-- (supabase/submit_score.sql). Safe to run again.

create table if not exists public.thecourt (
  id bigint generated always as identity primary key,
  name text not null,
  score bigint not null,
  court bigint not null,
  at bigint,
  created_at timestamptz not null default now()
);
create index if not exists thecourt_score_desc on public.thecourt (score desc);

alter table public.thecourt enable row level security;
drop policy if exists "anyone can read the board" on public.thecourt;
create policy "anyone can read the board" on public.thecourt for select to anon, authenticated using (true);
-- Read only: every other right (including the REFERENCES and TRIGGER that
-- Supabase grants new tables by default) is taken away, then SELECT given back.
revoke all on public.thecourt from anon, authenticated;
grant select on public.thecourt to anon, authenticated;

create or replace function public.submit_score(p_name text, p_score bigint, p_court bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_name is null or p_name !~ '^[A-Z0-9 .-]{1,8}$' or btrim(p_name) = '' then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  if p_court is null or p_court < 1 or p_court > 120 then
    raise exception 'invalid court' using errcode = '22023';
  end if;
  if p_score is null or p_score < 1 or p_score > p_court * 150300 then
    raise exception 'invalid score' using errcode = '22023';
  end if;
  if (select count(*) from public.thecourt where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'too many scores, try again soon' using errcode = '54000';
  end if;
  insert into public.thecourt (name, score, court, at, created_at)
  values (p_name, p_score, p_court, (extract(epoch from now()) * 1000)::bigint, now());
end;
$fn$;
revoke all on function public.submit_score(text, bigint, bigint) from public;
grant execute on function public.submit_score(text, bigint, bigint) to anon, authenticated;
