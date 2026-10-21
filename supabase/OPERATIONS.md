# Backend operations

Backend deployed through the Supabase plugin on 2026-10-21. The three migration filenames match remote history; `game-api` is active with `verify_jwt=false` and explicit device/admin authorization. Runtime uses Supabase-injected `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. No npm runtime dependencies. See docs/SUPABASE.md for verified provisioning and schedules.

Set `ALLOWED_ORIGINS` to exact production/development origins. Set `TRUSTED_IP_HEADER` only to an IP header your gateway overwrites; without a trusted IP source there is no effective cross-device signup throttle (device throttling remains). Provision infrastructure ingress limits to mitigate token rotation abuse. Never expose service keys, Telegram credentials, worker secrets, token hashes or Vault responses to the client.

The backend also enforces a fixed-key global 600 authenticated-shape requests/minute guard before allocating token limiter rows, and a SQL 120 **new profiles**/hour guard. Existing profile reads do not consume registration quota. These hard caps protect storage/notifications but can deny legitimate traffic during abuse; operator ingress controls are still useful.

Telegram prefers `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env secrets. Missing env values fall back to service-only RPC `game_telegram_config()` reading Vault names `dinorun_telegram_bot_token`, `dinorun_telegram_chat_id`. Main stores them outside source control. Successful nickname-supplied `profile` calls and `run-finish` trigger `EdgeRuntime.waitUntil` delivery, max 10 leased messages, each timeout 5s; failed sends retry on later relevant actions or scheduled flush after exponential backoff, max 10 attempts. Restoring a profile, heartbeats, visits, renames and run starts do not invoke Telegram. Delivery is at-least-once: Telegram has no idempotency API, so a crash after send/before acknowledgement can duplicate a notification. Dashboard outbox shows terminal failures. No automatic invitation/login action exists.

Admin: main provisions the project Auth user and stores its generated password in Vault outside this backend. A Supabase organization/dashboard login is not a project Auth user. Main inserts the confirmed user's UUID into `game_admins` using operator SQL. Alternatively main inserts the exact lowercase confirmed email into `game_admin_emails`; migrations intentionally seed neither allowlist. Sign in through project Auth; send its access JWT to `admin-summary`. Edge fetches `/auth/v1/user`, requires `email_confirmed_at` and nonanonymous user, then checks either database allowlist. Only operators/service role can edit these tables. Client author gate is UI only, not backend authorization. Remove allowlist row to revoke access immediately. No DEV password/claims confer access.

Dashboard Table Editor/SQL Editor: `game_admin_summary` lifetime totals, `game_admin_daily` UTC DAU/session activity, `game_admin_retention` exact D1/D7/D30 cohort returns. Cohort sizes include all registered profiles; future/unmatured cohorts must be excluded when calculating retention percentages. DAU means a visit, heartbeat or accepted finish that day. Active seconds are session totals (multiple tabs can overlap), assigned to heartbeat receipt date. Retention/activity aggregates persist; raw sessions/runs are kept 90 days, idempotency cache 7 days. Run/session UUID start requests remain retryable for the raw 90-day window; heartbeat/rename UUID replay cache is 7 days. After that window clients must not retry old mutations.

Enable pg_cron in Supabase dashboard if not already present; migration schedules daily maintenance only when installed. Then run in SQL Editor:

```sql
select cron.schedule('dinorun-maintenance','17 3 * * *', 'select public.game_maintenance()');
```

Alternatively invoke maintenance from SQL Editor. Optional external scheduler actions `maintenance` / `telegram-flush` require env `GAME_WORKER_SECRET` of at least 32 characters; they stay disabled unless provisioned. No worker secret or HTTP scheduler is needed for pg_cron or write-triggered Telegram.

For reliable Telegram retries during idle periods, main stores a random 256-bit secret in Vault as `dinorun_worker_secret` and the full game-api URL as `dinorun_api_url`, enables `pg_net` and `pg_cron`, then runs:

```sql
select cron.schedule('dinorun-telegram','* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='dinorun_api_url' limit 1),
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name='dinorun_worker_secret' limit 1)),
    body := '{"action":"telegram-flush"}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
```

`game_worker_authorized` is service-only, hashes the Vault secret inside SQL, and returns only a boolean; raw credentials never leave Vault via this RPC. The Edge handler still sends only when that proof succeeds. Protect dashboard access to pg_net request history as it may contain Authorization headers. This optional scheduled worker does not require a service key in SQL or an Edge env secret. Leave it unconfigured to use action-triggered retry only.

Test locally: `npx tsx --test tests/backend*.test.ts`. SQL integration audit: install `@electric-sql/pglite` in a temporary directory, then set `BACKEND_PGLITE_MODULE=/absolute/path/to/node_modules/@electric-sql/pglite/dist/index.js` and rerun tests. PGlite is a PostgreSQL engine used only by the audit, never a production dependency.

## Dashboard filters and player history

`game_admin_players` exposes lifetime profile/activity totals and first/last active UTC dates. `game_admin_run_history` exposes the retained 90-day runs with nickname and owner UUID. Both are security-invoker views with no client grants. Operator SQL examples (replace the profile UUID):

```sql
select * from public.game_admin_daily where day >= (now() at time zone 'UTC')::date - 30 order by day desc;
select * from public.game_admin_players order by last_active_day desc nulls last limit 100;
select * from public.game_admin_run_history
where profile_id = '00000000-0000-4000-8000-000000000000'::uuid
order by started_at desc limit 100;
select * from public.game_daily_activity
where profile_id = '00000000-0000-4000-8000-000000000000'::uuid order by day desc;
select cohort_day,cohort_size,day_7,round(100.0*day_7/nullif(cohort_size,0),2) as d7_percent
from public.game_admin_retention
where cohort_day <= (now() at time zone 'UTC')::date - 7 order by cohort_day desc;
```
