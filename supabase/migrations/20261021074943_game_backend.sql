-- Version synchronized with the applied Supabase MCP migration history.
-- Only the Edge service role can access this API. No raw client grants/policies.
create schema if not exists game_private;
revoke all on schema game_private from public, anon, authenticated;
grant usage on schema game_private to service_role;

create table public.game_profiles (
 id uuid primary key default gen_random_uuid(),
 nickname text not null,
 nickname_normalized text not null unique,
 best_score bigint not null default 0 check(best_score>=0),
 earned_coins bigint not null default 0 check(earned_coins>=0),
 created_at timestamptz not null default now()
);
create table game_private.device_tokens (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 profile_id uuid not null unique references public.game_profiles(id) on delete cascade
);
create index game_profiles_score_rank on public.game_profiles(best_score desc,id);
create index game_profiles_coins_rank on public.game_profiles(earned_coins desc,id);
create table public.game_admins (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table public.game_admin_emails (
 email text primary key check(email=lower(email)),
 created_at timestamptz not null default now()
);
create table public.game_sessions (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references public.game_profiles(id),
 request_id uuid not null,
 started_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 active_seconds integer not null default 0 check(active_seconds between 0 and 86400),
 unique(profile_id,request_id)
);
create index game_sessions_profile_time on public.game_sessions(profile_id,started_at desc);
create table public.game_runs (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references public.game_profiles(id),
 session_id uuid not null references public.game_sessions(id),
 request_id uuid not null,
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 status text not null default 'started' check(status in ('started','finished','abandoned')),
 distance double precision,
 duration double precision,
 score bigint,
 earned_coins integer,
 unique(profile_id,request_id)
);
create unique index game_one_live_run on public.game_runs(profile_id) where status='started';
create index game_runs_session on public.game_runs(session_id);
create index game_runs_finished on public.game_runs(finished_at,profile_id) where status='finished';
create table public.game_daily_activity (
 day date not null,
 profile_id uuid not null references public.game_profiles(id),
 visits integer not null default 0,
 active_seconds bigint not null default 0,
 runs integer not null default 0,
 best_score bigint not null default 0,
 earned_coins bigint not null default 0,
 primary key(day,profile_id)
);
create index game_daily_profile on public.game_daily_activity(profile_id,day);
create table game_private.requests (
 profile_id uuid not null references public.game_profiles(id),
 request_id uuid not null,
 action text not null,
 payload jsonb not null,
 response jsonb not null,
 created_at timestamptz not null default now(),
 primary key(profile_id,request_id)
);
create table game_private.rate_limits (
 key text primary key,
 window_at timestamptz not null,
 hits integer not null
);
create table public.game_telegram_outbox (
 id uuid primary key default gen_random_uuid(),
 event_key text not null unique,
 message text not null,
 created_at timestamptz not null default now(),
 attempts integer not null default 0,
 available_at timestamptz not null default now(),
 lease_id uuid,
 sent_at timestamptz,
 last_error text
);
create index game_outbox_due on public.game_telegram_outbox(available_at) where sent_at is null;

create view public.game_admin_summary with(security_invoker=true) as
 select (select count(*) from public.game_profiles) as players,
 (select count(*) from public.game_sessions) as retained_sessions,
 coalesce(sum(visits),0) as visits, coalesce(sum(active_seconds),0) as active_seconds,
 coalesce(sum(runs),0) as completed_runs, coalesce(sum(earned_coins),0) as earned_coins
 from public.game_daily_activity;
create view public.game_admin_daily with(security_invoker=true) as
 select day,count(*) as dau,sum(visits) as visits,sum(active_seconds) as active_seconds,
 sum(runs) as runs,sum(earned_coins) as earned_coins,max(best_score) as best_score
 from public.game_daily_activity group by day order by day desc;
create view public.game_admin_retention with(security_invoker=true) as
 select (p.created_at at time zone 'UTC')::date as cohort_day,
 count(*) as cohort_size,
 count(*) filter(where exists(select 1 from public.game_daily_activity a where a.profile_id=p.id and a.day=(p.created_at at time zone 'UTC')::date+1)) as day_1,
 count(*) filter(where exists(select 1 from public.game_daily_activity a where a.profile_id=p.id and a.day=(p.created_at at time zone 'UTC')::date+7)) as day_7,
 count(*) filter(where exists(select 1 from public.game_daily_activity a where a.profile_id=p.id and a.day=(p.created_at at time zone 'UTC')::date+30)) as day_30
 from public.game_profiles p group by 1 order by 1 desc;
create view public.game_admin_players with(security_invoker=true) as
 select p.id as profile_id,p.nickname,p.created_at,p.best_score,p.earned_coins,
 coalesce(a.visits,0) as visits,coalesce(a.active_seconds,0) as active_seconds,
 coalesce(a.runs,0) as runs,a.first_active_day,a.last_active_day
 from public.game_profiles p left join (
  select profile_id,sum(visits) as visits,sum(active_seconds) as active_seconds,sum(runs) as runs,min(day) as first_active_day,max(day) as last_active_day
  from public.game_daily_activity group by profile_id
 ) a on a.profile_id=p.id;
create view public.game_admin_run_history with(security_invoker=true) as
 select r.id as run_id,r.profile_id,p.nickname,r.session_id,r.started_at,r.finished_at,r.status,r.distance,r.duration,r.score,r.earned_coins
 from public.game_runs r join public.game_profiles p on p.id=r.profile_id;

create function public.game_rate_limit(p_key text,p_limit integer,p_seconds integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into game_private.rate_limits as r(key,window_at,hits)
 values(p_key,now(),1)
 on conflict(key) do update set
 hits=case when r.window_at<=now()-make_interval(secs=>p_seconds) then 1 else r.hits+1 end,
 window_at=case when r.window_at<=now()-make_interval(secs=>p_seconds) then now() else r.window_at end
 returning hits into n;
 return n<=p_limit;
end $$;

create function public.game_action(p_hash text,p_action text,p_input jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 p public.game_profiles; s public.game_sessions; r public.game_runs;
 old game_private.requests; result jsonb; req uuid; sid uuid;
 nick text; norm text; d double precision; dur double precision; c integer;
 seconds integer; delta integer; today date:=(now() at time zone 'UTC')::date;
 since_at timestamptz; metric text; period text; lim integer; personal jsonb;
begin
 -- Serialize all mutations for an identity, including its first registration.
 perform pg_advisory_xact_lock(hashtextextended(p_hash,0));
 select gp.* into p from public.game_profiles gp join game_private.device_tokens t on t.profile_id=gp.id where t.token_hash=p_hash;
 if p_action='profile' and p.id is null then
  if not(p_input ? 'nickname') then raise exception 'unknown_device'; end if;
  if not public.game_rate_limit('global:registrations',120,3600) then raise exception 'registration_rate_limited'; end if;
  nick:=normalize(trim(p_input->>'nickname'),NFKC); norm:=lower(nick);
  if nick is null or char_length(nick) not between 3 and 20 or nick !~ '^[[:alnum:]_-]+$' then raise exception 'invalid_nickname'; end if;
  begin
   insert into public.game_profiles(nickname,nickname_normalized) values(nick,norm) returning * into p;
  exception when unique_violation then raise exception 'nickname_taken'; end;
  insert into game_private.device_tokens values(p_hash,p.id);
  insert into public.game_telegram_outbox(event_key,message) values('profile:'||p.id,'New Dino Run player: '||p.nickname);
 end if;
 if p.id is null then raise exception 'unknown_device'; end if;
 if p_action='profile' then return to_jsonb(p)-'nickname_normalized'; end if;
 if p_action='leaderboard' then
  metric:=p_input->>'metric'; period:=p_input->>'period'; lim:=coalesce((p_input->>'limit')::integer,50);
  if metric not in ('score','coins') or period not in ('day','week','all') or metric is null or period is null or lim not between 1 and 100 then raise exception 'invalid_input'; end if;
  since_at:=case period when 'day' then date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' when 'week' then date_trunc('week',now() at time zone 'UTC') at time zone 'UTC' else null end;
  if period='all' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
    select row_number() over(order by case metric when 'score' then best_score else earned_coins end desc,id) as rank,id as profile_id,nickname,case metric when 'score' then best_score else earned_coins end as value
    from public.game_profiles where case metric when 'score' then best_score else earned_coins end>0 order by value desc,id limit lim
   ) x;
  else
   select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
    select row_number() over(order by v.value desc,gp.id) as rank,gp.id as profile_id,gp.nickname,v.value
    from (select profile_id,case metric when 'score' then max(best_score) else sum(earned_coins) end as value from public.game_daily_activity where day>=(since_at at time zone 'UTC')::date group by profile_id) v
    join public.game_profiles gp on gp.id=v.profile_id where v.value>0 order by v.value desc,gp.id limit lim
   ) x;
  end if;
  if period='all' then
   select jsonb_build_object('record',case metric when 'score' then p.best_score else p.earned_coins end,'rank',
    case when (case metric when 'score' then p.best_score else p.earned_coins end)>0 then 1+(select count(*) from public.game_profiles gp where
     (case metric when 'score' then gp.best_score else gp.earned_coins end)>(case metric when 'score' then p.best_score else p.earned_coins end)
     or ((case metric when 'score' then gp.best_score else gp.earned_coins end)=(case metric when 'score' then p.best_score else p.earned_coins end) and gp.id<p.id)) else null end) into personal;
  else
   with values_by_player as (
    select profile_id,case metric when 'score' then max(best_score) else sum(earned_coins) end as value
    from public.game_daily_activity where day>=(since_at at time zone 'UTC')::date group by profile_id
   ), mine as (select coalesce((select value from values_by_player where profile_id=p.id),0) as value)
   select jsonb_build_object('record',mine.value,'rank',case when mine.value>0 then 1+(select count(*) from values_by_player v where v.value>mine.value or (v.value=mine.value and v.profile_id<p.id)) else null end) into personal from mine;
  end if;
  return jsonb_build_object('metric',metric,'period',period,'starts_at',since_at,'entries',result,'personal',personal);
 end if;
 req:=(p_input->>'request_id')::uuid;
 if req is null then raise exception 'invalid_request_id'; end if;
 select * into old from game_private.requests where profile_id=p.id and request_id=req;
 if found then
  if old.action<>p_action or old.payload<>p_input then raise exception 'idempotency_conflict'; end if;
  return old.response;
 end if;
 if p_action='profile-rename' then
  nick:=normalize(trim(p_input->>'nickname'),NFKC); norm:=lower(nick);
  if nick is null or char_length(nick) not between 3 and 20 or nick !~ '^[[:alnum:]_-]+$' then raise exception 'invalid_nickname'; end if;
  begin
   update public.game_profiles set nickname=nick,nickname_normalized=norm where id=p.id returning * into p;
  exception when unique_violation then raise exception 'nickname_taken'; end;
  result:=to_jsonb(p)-'nickname_normalized';
 elsif p_action='visit' then
  select * into s from public.game_sessions where profile_id=p.id and request_id=req;
  if s.id is null then
   insert into public.game_sessions(profile_id,request_id) values(p.id,req) returning * into s;
   insert into public.game_daily_activity(day,profile_id,visits) values(today,p.id,1) on conflict(day,profile_id) do update set visits=game_daily_activity.visits+1;
  end if;
  result:=jsonb_build_object('session_id',s.id,'started_at',s.started_at,'active_seconds',0);
 elsif p_action in ('heartbeat','run-start') then
  sid:=(p_input->>'session_id')::uuid;
  select * into s from public.game_sessions where id=sid and profile_id=p.id for update;
  if s.id is null or now()-s.started_at>interval '24 hours' then raise exception 'invalid_session'; end if;
  if p_action='heartbeat' then
   seconds:=(p_input->>'active_seconds')::integer;
   if seconds is null or seconds<0 or seconds>86400 or seconds>extract(epoch from now()-s.started_at)+2 then raise exception 'invalid_active_seconds'; end if;
   delta:=greatest(0,seconds-s.active_seconds);
   update public.game_sessions set active_seconds=greatest(active_seconds,seconds),last_seen_at=now() where id=s.id returning * into s;
   insert into public.game_daily_activity(day,profile_id,active_seconds) values(today,p.id,delta) on conflict(day,profile_id) do update set active_seconds=game_daily_activity.active_seconds+delta;
   result:=jsonb_build_object('session_id',s.id,'active_seconds',s.active_seconds);
  else
   select * into r from public.game_runs where profile_id=p.id and request_id=req;
   if r.id is null then
    update public.game_runs set status='abandoned' where profile_id=p.id and status='started';
    insert into public.game_runs(profile_id,session_id,request_id) values(p.id,s.id,req) returning * into r;
   elsif r.session_id<>s.id then raise exception 'idempotency_conflict';
   end if;
   result:=jsonb_build_object('run_id',r.id,'started_at',r.started_at);
  end if;
 elsif p_action='run-finish' then
  select * into r from public.game_runs where id=(p_input->>'run_id')::uuid and profile_id=p.id for update;
  if r.id is null then raise exception 'invalid_run'; end if;
  d:=(p_input->>'distance')::double precision; dur:=(p_input->>'duration')::double precision; c:=(p_input->>'coins')::integer;
  if r.status='finished' then
   if r.distance is distinct from d or r.duration is distinct from dur or r.earned_coins is distinct from c then raise exception 'idempotency_conflict'; end if;
  else
   if r.status<>'started' or now()-r.started_at>interval '6 hours' then raise exception 'invalid_run'; end if;
   if d is null or dur is null or c is null or not(d>=0 and d<=561600) or not(dur>=0 and dur<=21600) or c<0 or dur>extract(epoch from now()-r.started_at)+2 or d>dur*26+5 or c>floor(d*2)+10 or c>floor(dur*20)+10 then raise exception 'implausible_run'; end if;
   update public.game_runs set status='finished',finished_at=now(),distance=d,duration=dur,score=floor(d),earned_coins=c where id=r.id returning * into r;
   update public.game_profiles set best_score=greatest(best_score,r.score),earned_coins=earned_coins+c where id=p.id;
   insert into public.game_daily_activity(day,profile_id,runs,best_score,earned_coins) values(today,p.id,1,r.score,c) on conflict(day,profile_id) do update set runs=game_daily_activity.runs+1,best_score=greatest(game_daily_activity.best_score,r.score),earned_coins=game_daily_activity.earned_coins+c;
   if r.score>p.best_score then insert into public.game_telegram_outbox(event_key,message) values('record:'||r.id,p.nickname||' set a personal record: '||r.score||' m'); end if;
  end if;
  result:=jsonb_build_object('run_id',r.id,'score',r.score,'earned_coins',r.earned_coins,'duration',r.duration,'finished_at',r.finished_at);
 else raise exception 'invalid_action';
 end if;
 insert into game_private.requests(profile_id,request_id,action,payload,response) values(p.id,req,p_action,p_input,result);
 return result;
end $$;

create function public.game_maintenance() returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 update public.game_runs set status='abandoned' where status='started' and started_at<now()-interval '6 hours';
 delete from game_private.requests where created_at<now()-interval '7 days';
 delete from public.game_runs where started_at<now()-interval '90 days';
 delete from public.game_sessions s where started_at<now()-interval '90 days' and not exists(select 1 from public.game_runs r where r.session_id=s.id);
 delete from game_private.rate_limits where window_at<now()-interval '2 days';
 delete from public.game_telegram_outbox where (sent_at is not null and sent_at<now()-interval '30 days') or (attempts>=10 and created_at<now()-interval '30 days');
 return jsonb_build_object('ok',true);
end $$;

create function public.game_claim_outbox() returns setof public.game_telegram_outbox language sql security invoker set search_path='' as $$
 update public.game_telegram_outbox set lease_id=gen_random_uuid(),attempts=attempts+1,available_at=now()+interval '2 minutes'
 where id in(select id from public.game_telegram_outbox where sent_at is null and attempts<10 and available_at<=now() order by created_at limit 10 for update skip locked) returning *;
$$;
create function public.game_ack_outbox(p_id uuid,p_lease uuid,p_ok boolean) returns void language sql security invoker set search_path='' as $$
 update public.game_telegram_outbox set sent_at=case when p_ok then now() else null end,
 available_at=now()+make_interval(secs=>least(3600,30*(2^least(attempts,7))::integer)),
 last_error=case when p_ok then null else 'telegram_delivery_failed' end,lease_id=null
 where id=p_id and lease_id=p_lease and sent_at is null;
$$;

-- Explicit grants are independent of project default privileges.
do $$ declare t text; begin
 foreach t in array array['public.game_profiles','public.game_admins','public.game_admin_emails','public.game_sessions','public.game_runs','public.game_daily_activity','public.game_telegram_outbox','game_private.device_tokens','game_private.requests','game_private.rate_limits'] loop
  execute 'alter table '||t||' enable row level security';
  execute 'alter table '||t||' force row level security';
  execute 'revoke all on '||t||' from public,anon,authenticated';
  execute 'grant all on '||t||' to service_role';
 end loop;
end $$;
revoke all on public.game_admin_summary,public.game_admin_daily,public.game_admin_retention,public.game_admin_players,public.game_admin_run_history from public,anon,authenticated;
grant select on public.game_admin_summary,public.game_admin_daily,public.game_admin_retention,public.game_admin_players,public.game_admin_run_history to service_role;
revoke all on function public.game_action(text,text,jsonb),public.game_rate_limit(text,integer,integer),public.game_maintenance(),public.game_claim_outbox(),public.game_ack_outbox(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.game_action(text,text,jsonb),public.game_rate_limit(text,integer,integer),public.game_maintenance(),public.game_claim_outbox(),public.game_ack_outbox(uuid,uuid,boolean) to service_role;

-- Vault may be installed after this migration. Dynamic SQL keeps migration portable.
-- Only service_role can execute; no secret ever returns to the game API caller.
create function public.game_telegram_config() returns jsonb
language plpgsql security definer set search_path='' as $$
declare config jsonb;
begin
 if to_regclass('vault.decrypted_secrets') is null then return '{}'::jsonb; end if;
 execute 'select jsonb_build_object(''bot_token'',max(decrypted_secret) filter(where name=''dinorun_telegram_bot_token''),''chat_id'',max(decrypted_secret) filter(where name=''dinorun_telegram_chat_id'')) from vault.decrypted_secrets where name in (''dinorun_telegram_bot_token'',''dinorun_telegram_chat_id'')' into config;
 return config;
end $$;
revoke all on function public.game_telegram_config() from public,anon,authenticated;
grant execute on function public.game_telegram_config() to service_role;

create function public.game_worker_authorized(p_hash text) returns boolean
language plpgsql security definer set search_path='' as $$
declare allowed boolean;
begin
 if to_regclass('vault.decrypted_secrets') is null then return false; end if;
 execute 'select exists(select 1 from vault.decrypted_secrets where name=''dinorun_worker_secret'' and length(decrypted_secret)>=32 and encode(sha256(convert_to(decrypted_secret,''UTF8'')),''hex'')=$1)' into allowed using p_hash;
 return allowed;
end $$;
revoke all on function public.game_worker_authorized(text) from public,anon,authenticated;
grant execute on function public.game_worker_authorized(text) to service_role;

-- Hosted Supabase supports pg_cron. If preinstalled, schedule maintenance directly;
-- otherwise the operator enables it and runs the SQL documented in OPERATIONS.md.
do $$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('dinorun-maintenance','17 3 * * *','select public.game_maintenance()');
 end if;
end $$;
