-- Version synchronized with the applied Supabase MCP migration history.
create or replace view public.game_admin_summary with(security_invoker=true) as
 select (select count(*) from public.game_profiles) as players,
 (select count(*) from public.game_sessions) as retained_sessions,
 coalesce(sum(visits),0) as visits, coalesce(sum(active_seconds),0) as active_seconds,
 coalesce(sum(runs),0) as completed_runs, coalesce(sum(earned_coins),0) as earned_coins,
 count(distinct profile_id) filter(where day=(now() at time zone 'UTC')::date) as active_today,
 count(distinct profile_id) filter(where day>=(now() at time zone 'UTC')::date-6) as active_7_days,
 count(distinct profile_id) filter(where day>=(now() at time zone 'UTC')::date-29) as active_30_days,
 (select coalesce(max(best_score),0) from public.game_profiles) as best_score,
 (select coalesce(round(avg(duration)::numeric,1),0) from public.game_runs where status='finished') as average_run_seconds
 from public.game_daily_activity;
revoke all on public.game_admin_summary from public,anon,authenticated;
grant select on public.game_admin_summary to service_role;
