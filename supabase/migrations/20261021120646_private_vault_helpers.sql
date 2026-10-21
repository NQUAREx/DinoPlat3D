-- Version synchronized with the applied Supabase MCP migration history.
-- Privileged Vault access lives only in a non-exposed schema.
-- PostgREST wrappers are invokers with explicit service-only execution grants.
alter function public.game_telegram_config() set schema game_private;
alter function public.game_worker_authorized(text) set schema game_private;

create function public.game_telegram_config() returns jsonb
language sql security invoker set search_path='' as $$
 select game_private.game_telegram_config();
$$;
create function public.game_worker_authorized(p_hash text) returns boolean
language sql security invoker set search_path='' as $$
 select game_private.game_worker_authorized(p_hash);
$$;

revoke all on function public.game_telegram_config(),public.game_worker_authorized(text),
 game_private.game_telegram_config(),game_private.game_worker_authorized(text)
 from public,anon,authenticated;
grant execute on function public.game_telegram_config(),public.game_worker_authorized(text),
 game_private.game_telegram_config(),game_private.game_worker_authorized(text)
 to service_role;
