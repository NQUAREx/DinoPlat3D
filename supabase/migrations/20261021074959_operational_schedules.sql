-- Version synchronized with the applied Supabase MCP migration history.
-- Hosted Supabase background operations; no credential literals in schedules.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('dinorun-maintenance','17 3 * * *',
  'select public.game_maintenance()');

select cron.schedule('dinorun-telegram','*/5 * * * *', $job$
  select net.http_post(
    url := 'https://yusnxxdeumczuniwumvi.supabase.co/functions/v1/game-api',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='dinorun_worker_secret' limit 1)
    ),
    body := '{"action":"telegram-flush"}'::jsonb,
    timeout_milliseconds := 10000
  ) where exists(select 1 from public.game_telegram_outbox where sent_at is null and attempts<10 and available_at<=now())
    and exists(select 1 from vault.secrets where name='dinorun_worker_secret');
$job$);
