# Supabase operations

Project: `yusnxxdeumczuniwumvi`, API host `https://yusnxxdeumczuniwumvi.supabase.co`.
The static GitHub Pages game uses the Edge Function, not direct table writes.
The authoritative wire contract is [supabase/API.md](../supabase/API.md).
Deployment verified 2026-10-21: all four migrations were applied through the Supabase plugin, and Edge Function
`game-api` version 4 is active. The confirmed project Auth administrator
`nquare.x@gmail.com` exists and its UUID is in `public.game_admins`. Live admin
login and summary retrieval passed. The initial password is stored in Vault as
`dinorun_admin_initial_password`; Telegram credentials and `dinorun_worker_secret`
are also in Vault. The one-off provisioning function has been replaced with a
closed handler with `verify_jwt = true`; it is not an active provisioning API.

pg_cron maintenance is installed for 03:17 UTC daily. Telegram flush is scheduled
every five minutes, only when eligible pending messages exist. Actual Supabase
outbound Telegram delivery initially returned HTTP403 before the recipient started
the bot. A subsequent server-side delivery succeeded at12:00UTC: Telegram HTTP200,
one sent message and an acknowledged outbox row. No relay hosting is available; the optional
relay is not deployed. The browser mock suite does not independently establish
these live deployment facts.
The applied migrations are `20261021074943_game_backend.sql`,
`20261021074959_operational_schedules.sql`, `20261021075440_analytics_summary.sql`
and `20261021120646_private_vault_helpers.sql`.
Local filenames match the remote MCP migration history.
Privileged Vault helpers live in the non-exposed `game_private` schema; their
public RPC wrappers are security invokers executable only by the service role.

## Deploy backend and client

For subsequent deployments, use the Supabase Dashboard SQL editor to apply new migrations in
`supabase/migrations/` to the intended project, or use a project-linked Supabase
CLI migration workflow. Review existing migration history before applying; do not
rerun a create-table migration over an existing schema.

For a function update, deploy `supabase/functions/game-api/` as `game-api`. `supabase/config.toml` sets
`verify_jwt = false` because player device tokens are not Supabase JWTs. The
function must enforce device authorization and verify administrator JWTs itself.
With a current CLI, inspect `supabase functions deploy --help`, then deploy:

```sh
supabase functions deploy game-api --project-ref yusnxxdeumczuniwumvi
```

Set Edge Function secrets in Dashboard → Edge Functions → Secrets (or use
`supabase secrets set --help` for the installed CLI). Never put secret values in
repository files, command transcripts, browser bundles, screenshots or logs.

| Setting | Location and purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Hosted Edge runtime provides these; service role stays server-side. |
| `ALLOWED_ORIGINS` | Exact comma-separated browser origins; set production explicitly to `https://nquarex.github.io`. The handler's unset/empty default allows that origin plus HTTP localhost/127.0.0.1 on ports 5173 and 4173, with no wildcard fallback. Add explicit dev origins only when needed. Paths such as `/DinoPlat3d/` are not origins. Verify the deployed handler uses this restricted default. |
| `GAME_WORKER_SECRET` | Server-side random operational bearer, at least 32 characters; used only by trusted scheduled maintenance/Telegram calls. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Server-side Telegram credentials/destination; never `VITE_` variables. |
| `TRUSTED_IP_HEADER` | Leave unset unless a trusted gateway overwrites the chosen header and direct calls cannot spoof it. The optional relay does not provide trusted client IP forwarding. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public browser key for Supabase Auth. A legacy anon key is supported as `VITE_SUPABASE_ANON_KEY`. Neither is a service-role key. |
| `VITE_GAME_API_URL` | Optional complete game-api URL; build-time configuration, so rebuild/redeploy the static game after changing it. |
| `VITE_SUPABASE_URL` | Optional Supabase/Auth base URL; set to the relay origin alongside `VITE_GAME_API_URL` only when a relay is hosted. |

This deployment already stores Telegram credentials in Supabase Vault as
`dinorun_telegram_bot_token` and `dinorun_telegram_chat_id`. The function reads them
through the restricted `game_telegram_config` RPC. Edge environment values take precedence. Keep the
existing Vault setup; no need to copy those values into Edge secrets. Enter Vault
values through a trusted operator workflow; do not commit literal credential SQL.
The bot is already configured. The recipient must open its Telegram chat and
press **Start** (or send `/start`); a bot cannot initiate a private conversation.
After that, verify a real delivery from Supabase and check the outbox status.
The observed HTTP 403 must not be described as a successful delivery or assumed
resolved solely by starting the bot. Notifications contain nicknames and personal records;
choose an appropriately private destination and disclose that use to players.

## Administrator authorization

Use the already provisioned project Auth administrator. In Supabase Dashboard,
select project `yusnxxdeumczuniwumvi`, open **Vault** (use the Dashboard navigation
search if necessary), find `dinorun_admin_initial_password`, and use the GUI's
reveal/copy control privately. Paste it directly into the game's native Admin
password input after unlocking the author tab. Find the provisioned account's
email (`nquare.x@gmail.com`) in Authentication → Users. A Supabase Dashboard account is distinct from
this project Auth account. Do not run SQL to select/decrypt/print the password,
copy it into chat, or include it in terminal output, screenshots or logs. Clear
the clipboard after use. If the Vault GUI cannot reveal it with your operator
permissions, use the trusted Auth password-reset workflow rather than printing
Vault contents. Replace the initial password after first use through Auth; retire
or update the initial-password Vault entry so it cannot be mistaken for the
current password.

The main owner has completed email confirmation and UUID allowlist insertion,
and live login/summary verification passed. The function calls Auth `/auth/v1/user` with the access token and
requires a confirmed, non-anonymous user plus a server-side allowlist match in
`public.game_admins` (Auth user UUID) or `public.game_admin_emails` (lowercase email).
Migrations seed neither allowlist; the operator provisions access explicitly.
A user-editable metadata field must never confer administrator rights.

For an additional UUID entry, run as the database operator in SQL editor:

```sql
insert into public.game_admins(user_id)
values ('REPLACE_WITH_CONFIRMED_AUTH_USER_UUID'::uuid)
on conflict do nothing;
```

The author code/device cookie only reveals the Admin tab. Test that an ordinary
confirmed Auth user receives 403 even after unlocking that tab. Passwords and
administrator access/refresh tokens belong in memory only. Removing an allowlist
entry takes effect on the next server authorization check; local logout alone
does not revoke an already issued JWT. Rotate compromised credentials and revoke
sessions in Auth. Do not rely on a hidden tab as an access control.

## Rankings and operator analytics

Player rankings use accepted finished runs: personal best whole metres, or total
earned run coins, for UTC day, Monday-start week and all time. Purchases, wallet
holdings and DEV awards do not increase rankings. Server plausibility checks are
not authoritative anti-cheat for a client-simulated game.

Use Supabase Dashboard SQL editor for analytics; no custom in-game charts are
required. Operator queries:

```sql
select * from public.game_admin_summary;
select * from public.game_admin_daily order by day desc limit 90;
select * from public.game_admin_retention order by cohort_day desc limit 90;
```

`20261021075440_analytics_summary.sql` adds `active_today`, `active_7_days`,
`active_30_days`, `best_score` and `average_run_seconds` to the summary. The
activity windows are UTC today and rolling seven/thirty calendar days including
today, not calendar week/month. Average run seconds covers retained finished
runs. These fields are deployed and verified. Continue using the
Dashboard SQL views for analytics without adding in-game charts.

These security-invoker views and underlying tables have RLS and no raw
`anon`/`authenticated` grants; service-role access is restricted to the function.
Run SQL as a trusted operator, never grant browser roles access to make charts.
Retention columns count players active on exact cohort days 1/7/30. Session
foreground seconds are cumulative and multi-tab sessions are not deduplicated
human activity. Daily activity rollups allocate newly credited seconds to receipt
day; they are not a precise second-by-second UTC timeline.

The applied `20261021074959_operational_schedules.sql` migration installs
`dinorun-maintenance` at `17 3 * * *` (03:17 UTC daily) and `dinorun-telegram` at
`*/5 * * * *` (every five minutes). Maintenance invokes SQL directly. Telegram
uses pg_net only when the outbox has unsent, due messages below the retry cap and
the worker secret exists. Its target URL is the public constant
`https://yusnxxdeumczuniwumvi.supabase.co/functions/v1/game-api` in the schedule;
there is no `dinorun_api_url` Vault dependency. Authorization reads
`dinorun_worker_secret` inside the database without printing it. Do not expose the
worker secret via GitHub Pages or the relay. Protect access to pg_net request
history, which can contain authorization headers. Inspect cron job status and
outbox delivery outcomes separately: a successful scheduled HTTP request does
not establish successful Telegram delivery.

Write-triggered sends also occur for nickname-supplied profile calls and finished
runs. The outbox retries failed
deliveries; Telegram network timeouts can cause duplicate messages after retries.
Maintenance removes old raw runs/sessions after 90 days and idempotency receipts
after seven days; aggregate activity/profile counters have separate lifetimes.
Check the migration for the complete retention policy and plan deletion/privacy
requirements explicitly.

## Optional neutral-domain relay for Russia

`tools/supabase-relay/worker.mjs` is an optional Cloudflare Worker. It has no secret
bindings and no configurable upstream. It forwards only POST requests to:

- `https://yusnxxdeumczuniwumvi.supabase.co/functions/v1/game-api` (no query string).
- `https://yusnxxdeumczuniwumvi.supabase.co/auth/v1/token?grant_type=password` or
  `?grant_type=refresh_token` (no extra or duplicate query parameters).
- `https://yusnxxdeumczuniwumvi.supabase.co/auth/v1/logout` (no query string).

Every other path/method/host selection is rejected; upstream redirects are
refused. Requests need `application/json` and a matching Origin:
`https://nquarex.github.io` or HTTP localhost/127.0.0.1/[::1] with an optional port.
All origins including absent/`null` origins are otherwise rejected. Origins do
not contain repository paths, so all pages on the same GitHub Pages origin share
this origin boundary. CORS is a browser policy, not authentication: non-browser
clients can forge Origin. Backend authorization and rate limits remain necessary.

The relay preserves Authorization, apikey, content-type, x-client-info and exact
body bytes, including passwords/refresh tokens, without logging them. It forwards
no cookies or arbitrary headers, sets no credentialed CORS, strips Set-Cookie,
sets `Cache-Control: no-store`, caps request bodies at 8192 bytes and bounds body
reading/upstream response at ten seconds. It does not cache or store credentials.
Avoid enabling request body/header logging in Cloudflare, observability tools or
any additional reverse proxy. The host operator can technically observe traffic;
use an account/domain you control. Keep HTTPS enabled end to end.

No hosting is available at this handoff; keep direct endpoints configured. The
following is an optional future deployment procedure, not a completed deployment.
When hosting is available, deploy from the relay directory after inspecting the
installed Wrangler help:

```sh
cd tools/supabase-relay
wrangler deploy --help
wrangler deploy
```

`wrangler.toml` enables workers.dev as an initial address. A custom domain can be
attached through Cloudflare's Worker domain settings. No project-specific domain
is provisioned by these files. For another hosting provider, adapt the exported
Web Request/Response handler, preserving every restriction and running the relay
tests. Do not add a destination URL parameter.

Set `VITE_GAME_API_URL=https://YOUR_RELAY_HOST/functions/v1/game-api` and rebuild
the game with `VITE_SUPABASE_URL=https://YOUR_RELAY_HOST` so administrator
login/refresh also target the relay's `/auth/v1/token` paths. Configuring the game
endpoint alone leaves Auth on its default direct Supabase host. Verify both
endpoint settings before enabling admin
access through the relay. `/auth/v1/logout` is relayed to the same fixed upstream
without query parameters. Local logout must clear memory even if remote
revocation is unavailable. Use Supabase
Auth's trusted operator workflow for revocation when required.

Neither Cloudflare nor a neutral domain guarantees access from Russia. Deployment
and tests from this workspace are not Russian ISP tests. Before claiming regional
availability, test direct and relayed registration, rankings, login/refresh and
failure recovery from actual Russian mobile/fixed networks, recording ISP,
location, time, browser, endpoint and observed errors without credentials.

## Free tier and verification

Supabase and Cloudflare free plans have independent quotas, execution limits and
availability policies. Consult their current dashboards/pricing before rollout;
do not promise permanent free operation or uptime. Monitor database size, function
invocations/egress, Auth limits and Worker requests. Heartbeats, retry traffic and
scheduled flushes consume quotas when pending work triggers a request. Free
Supabase Edge workers currently have 256 MB memory, two seconds CPU per request
and a 150-second wall-clock limit; this relay uses its own shorter timeout.
Retention maintenance bounds some raw data, not every growing aggregate/table.

```sh
node --test tools/supabase-relay/worker.test.mjs
node tests/online-browser.mjs
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 node tests/online-browser.mjs --webkit
```

The browser suite uses actual OnlineService/OnlineUI, the MobileBrowser global
input guards and page markup with a strict
fetch mock for the documented backend contract. It covers mandatory nickname,
reload/offline cached identity, duplicate name/finish, both ranking metrics/all
periods, personal record/rank outside the returned list (rank 200), native input
focus/selection/text entry, safe text rendering and the separate admin authorization gate. It does
not validate live SQL, Auth, Telegram delivery, deployed CORS, full game lifecycle
integration or regional connectivity. Main integration verification must exercise
those separately. Check `npm test`, `npm run build` and relevant existing browser
checks after the other agents' source changes settle.
Chromium and WebKit automation do not prove physical iPhone/Android soft keyboard,
clipboard permission behavior or regional connectivity. Independently verify
deployed CORS: the production origin must pass, an unrelated origin must fail,
and unset/empty origin configuration must not emit wildcard CORS.

References: [Edge secrets](https://supabase.com/docs/guides/functions/secrets),
[Edge limits](https://supabase.com/docs/guides/functions/limits),
[Supabase pricing](https://supabase.com/pricing),
[Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
