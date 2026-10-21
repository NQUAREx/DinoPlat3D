# Game API contract

POST `${SUPABASE_URL}/functions/v1/game-api`, JSON, `Authorization: Bearer <deviceToken>`.
Generate deviceToken once with crypto.getRandomValues(new Uint8Array(32)), encode as **64 lowercase hex** and persist privately on device. Never send wallet balances or developer awards. No SDK needed. CORS allows configured `ALLOWED_ORIGINS` (comma-separated exact origins); absent config allows only `https://nquarex.github.io` and localhost/127.0.0.1 on ports 5173/4173. No wildcard. Server-to-server requests without Origin still require authentication.

All success responses: `{ok:true,data:...}`; errors `{ok:false,error:{code,message}}`. UUIDs are strings. Writes require fresh `request_id: crypto.randomUUID()`; reuse it with identical payload on retries. UTC day starts 00:00; UTC week starts Monday 00:00.

| action | additional fields | data |
|---|---|---|
| profile | nickname (required for first registration; 3–20 Unicode letters/numbers/underscore/hyphen, NFKC normalized, case-insensitive uniqueness) | `{id,nickname,best_score,earned_coins,created_at}` |
| profile-rename | nickname, request_id | profile as above |
| visit | request_id | `{session_id,started_at,active_seconds:0}` |
| heartbeat | request_id, session_id, active_seconds (integer cumulative foreground seconds since visit, never a delta) | `{session_id,active_seconds}` |
| run-start | request_id, session_id | `{run_id,started_at}` |
| run-finish | request_id, run_id, distance (metres, finite >=0), coins (integer earned THIS run), duration (active simulation seconds) | `{run_id,score,earned_coins,duration,finished_at}` |
| leaderboard | metric (`score` or `coins`), period (`day`,`week`,`all`), optional limit (1–100, default 50) | `{metric,period,starts_at,entries:[{rank,profile_id,nickname,value}],personal:{record,rank}}` (`rank:null` when record=0; rank calculated across all players) |
| admin-summary | use Supabase Auth access JWT instead of device token | `{summary}`; detailed history/retention stays in Dashboard SQL views |

`profile` accepts optional request_id but identity itself makes bootstrap idempotent. Existing tokens return existing profile regardless of proposed nickname. Nickname collision returns 409 `nickname_taken`. Missing profile 401 `unknown_device`. Session/run ownership enforced. Only one unfinished run per profile: new run-start abandons the previous run. A finished run returns the original result for identical finish values; conflicting retries return 409. Rate limit 120 calls/device/minute, bootstrap additionally 10 new registrations per trusted gateway IP hash/hour when available. Leaderboard requires an existing device. Score is floor(distance), score ranking is personal best in period, coins ranking is sum of accepted run earnings in period (not wallet holdings/spending). Period is determined by server finish timestamp.

Limits: 8KiB request, sessions 24h, runs 6h, max speed 26m/s + 5m tolerance, claimed duration <= server elapsed + 2s, run coins <= floor(distance*2)+10 AND <= floor(duration*20)+10. These are plausibility checks, not authoritative anti-cheat; no client-only game can prove pickups without replay validation. Accepted earnings are transactionally accumulated once. Send final cumulative heartbeat before finishing if desired; heartbeat does not govern run duration. Heartbeats credit only increases and require cumulative active time <= elapsed wall time + 2s; per-session cumulative time is retained, UTC activity rollups allocate newly reported seconds to the receipt day. Multi-tab session activity is session time, not deduplicated human time.

Operational actions `maintenance` and `telegram-flush` require `Authorization: Bearer <worker secret>` (not a player or admin JWT), matched against env `GAME_WORKER_SECRET` or Vault `dinorun_worker_secret`. Main can schedule via pg_cron + pg_net + Vault without configuring Edge env; see OPERATIONS.md. Fixed global guard 600 requests/minute precedes all per-token limiter rows. New identity creation additionally caps at 120/hour globally inside SQL, leaving existing-profile fetches unaffected. No remote deployment performed by backend agent.
