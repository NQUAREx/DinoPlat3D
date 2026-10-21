/** Public game endpoint: device identity is explicit, never an author code. */
export const GAME_API = "https://yusnxxdeumczuniwumvi.supabase.co/functions/v1/game-api";
export const SUPABASE_URL = "https://yusnxxdeumczuniwumvi.supabase.co";
export const SUPABASE_PUBLIC_KEY = "sb_publishable_IDUc2JmAE4IgXMVETQzJwQ_4pVRU1qn";
export type LeaderboardMetric = "score" | "coins";
export type LeaderboardPeriod = "day" | "week" | "all";
export interface OnlineProfile { id: string; nickname: string }
export interface LeaderboardEntry { rank: number; nickname: string; value: number; playerId?: string }
export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  personal: { record: number; rank: number | null };
}
export interface RunResult {
  /** Whole metres travelled, and coins collected in this run (never wallet balance). */
  score: number;
  coins: number;
  durationMs: number;
}
interface QueuedRun extends RunResult { runId: string; requestId: string }
export class OnlineError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500; }
}
const KEY = "dinorun-online-v1";
const TOKEN_KEY = `${KEY}-token`;
const PROFILE_KEY = `${KEY}-profile`;
const QUEUE_KEY = `${KEY}-queue`;
const MAX_QUEUE = 20;
function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Session still works without storage. */ }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function integer(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
function profileOf(value: unknown): OnlineProfile | null {
  const p = object(value);
  return typeof p.id === "string" && typeof p.nickname === "string" && p.nickname.trim()
    ? { id: p.id, nickname: p.nickname } : null;
}
export function validateNickname(value: string): string {
  const nickname = value.normalize("NFKC").trim();
  if (!/^[\p{L}\p{N}_ -]{3,20}$/u.test(nickname))
    throw new OnlineError("Ник: 3–20 букв, цифр, пробелов, _ или -.", 400);
  return nickname;
}
export interface OnlineOptions { endpoint?: string; publishableKey?: string; timeoutMs?: number; supabaseUrl?: string }

/** Call lifecycle methods at run transitions, not from RAF. Heartbeats use one timer. */
export class OnlineService {
  readonly token: string;
  /** One visit per page load, including registered players who never start a run. */
  sessionId: string | null = null;
  private readonly visitRequestId = crypto.randomUUID();
  private visitPending?: Promise<void>;
  profile: OnlineProfile | null = null;
  online = false;
  private readonly endpoint: string;
  private readonly publicKey: string;
  private readonly authUrl: string;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Set<AbortController>();
  private readonly lifecycle = new AbortController();
  private queue: QueuedRun[] = [];
  private flushing?: Promise<void>;
  private finishing: Promise<void> = Promise.resolve();
  private activeRun?: { localId: string; start: Promise<string | null>; started: number };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatPending = false;
  private heartbeatForcePending = false;
  private running = false;
  private activeMs = 0;
  private activeSince = 0;
  private adminSession?: { access_token: string; refresh_token: string; expires_at: number };
  private disposed = false;
  constructor(options: OnlineOptions = {}) {
    this.endpoint = options.endpoint || import.meta.env?.VITE_GAME_API_URL || GAME_API;
    this.publicKey = options.publishableKey || import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env?.VITE_SUPABASE_ANON_KEY || SUPABASE_PUBLIC_KEY;
    this.authUrl = `${(options.supabaseUrl || import.meta.env?.VITE_SUPABASE_URL || SUPABASE_URL).replace(/\/$/, "")}/auth/v1`;
    const timeout = options.timeoutMs ?? 10000;
    this.timeoutMs = Number.isFinite(timeout) ? Math.max(50, Math.min(30000, timeout)) : 10000;
    const stored = read(TOKEN_KEY);
    this.token = typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored) ? stored :
      Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    save(TOKEN_KEY, this.token);
    const cached = object(read(PROFILE_KEY));
    if (cached.token === this.token) this.profile = profileOf(cached.profile);
    const cachedQueue = object(read(QUEUE_KEY));
    const queue = cachedQueue.token === this.token ? cachedQueue.runs : [];
    if (Array.isArray(queue)) this.queue = queue.filter((item): item is QueuedRun => {
      const q = object(item);
      return typeof q.runId === "string" && q.runId.length <= 80 && typeof q.requestId === "string" &&
        [q.score, q.coins, q.durationMs].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
    }).slice(-MAX_QUEUE);
    window.addEventListener("online", () => { void this.init(); }, { signal: this.lifecycle.signal });
    window.addEventListener("pagehide", () => {
      this.setRunning(false);
      this.pagehideHeartbeat();
    }, { signal: this.lifecycle.signal });
  }
  get canPlay() { return this.profile !== null; }
  get isAdminSignedIn() { return !!this.adminSession; }
  get pendingRuns() { return this.queue.length; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
  private setProfile(profile: OnlineProfile | null) {
    if (this.disposed) return;
    this.profile = profile;
    save(PROFILE_KEY, { token: this.token, profile });
    this.emit();
  }
  private async fetchJSON(url: string, body: unknown, headers: Record<string, string> = {}) {
    if (this.disposed) throw new OnlineError("Сервис закрыт.");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store" });
      const data = object(await response.json().catch(() => ({})));
      if (!response.ok || data.error || data.ok === false) {
        const detail = object(data.error);
        throw new OnlineError(String(detail.message || data.message || data.error_description || data.msg || data.error || `Ошибка ${response.status}`), response.status);
      }
      return object(data.data || data);
    } catch (error) {
      if (error instanceof OnlineError) throw error;
      throw new OnlineError(controller.signal.aborted ? "Время ожидания истекло. Повторите попытку." : "Нет связи с сервером.");
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async request(action: string, args: Record<string, unknown> = {}, jwt?: string) {
    try {
      const data = await this.fetchJSON(this.endpoint, { ...args, action }, { Authorization: `Bearer ${jwt || this.token}` });
      this.online = true; this.emit(); return data;
    } catch (error) {
      if (error instanceof OnlineError && error.retryable) { this.online = false; this.emit(); }
      throw error;
    }
  }
  async init(): Promise<OnlineProfile | null> {
    try {
      const data = await this.request("profile");
      this.setProfile(profileOf(data.profile || data));
      if (this.profile) { await this.ensureVisit(); await this.flushQueue(); }
    } catch (error) {
      if (error instanceof OnlineError && [401, 404].includes(error.status)) this.setProfile(null);
      // Only an already server-confirmed cached identity may play offline.
    }
    return this.profile;
  }
  async register(nickname: string) {
    const data = await this.request("profile", { nickname: validateNickname(nickname) });
    const profile = profileOf(data.profile || data);
    if (!profile) throw new OnlineError("Сервер не подтвердил регистрацию.");
    this.setProfile(profile); await this.ensureVisit().catch(() => {}); return profile;
  }
  async rename(nickname: string) {
    const data = await this.request("profile-rename", { nickname: validateNickname(nickname), request_id: crypto.randomUUID() });
    const profile = profileOf(data.profile || data);
    if (!profile) throw new OnlineError("Сервер не подтвердил новое имя.");
    this.setProfile(profile); return profile;
  }
  startRun(): string {
    if (!this.canPlay) throw new OnlineError("Сначала выберите уникальный ник.", 403);
    this.setRunning(false);
    const localId = crypto.randomUUID();
    // Catch immediately so offline starts never create an unhandled rejection.
    const start = (async () => {
      // Finish the previous run before the server abandons it for this start.
      await this.finishing;
      await this.ensureVisit();
      await this.flushQueue();
      const result = await this.request("run-start", { request_id: localId, session_id: this.sessionId });
      return typeof result.run_id === "string" ? result.run_id : null;
    })().catch(() => null);
    this.activeRun = { localId, started: this.activeSeconds * 1000, start };
    this.setRunning(true);
    return localId;
  }
  private async ensureVisit() {
    if (this.sessionId) return;
    if (this.visitPending) return this.visitPending;
    this.visitPending = (async () => {
      const visit = await this.request("visit", { request_id: this.visitRequestId });
      if (this.disposed) return;
      if (typeof visit.session_id !== "string") throw new OnlineError("Сервер не подтвердил посещение.");
      this.sessionId = visit.session_id;
      if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, 30000);
    })().finally(() => { this.visitPending = undefined; });
    return this.visitPending;
  }
  async heartbeat(force = false) {
    if (this.disposed || !this.sessionId || (!force && (!this.running || document.hidden))) return;
    if (this.heartbeatPending) { this.heartbeatForcePending ||= force; return; }
    this.heartbeatPending = true;
    try { await this.request("heartbeat", { request_id: crypto.randomUUID(), session_id: this.sessionId, active_seconds: Math.floor(this.activeSeconds) }); }
    catch { /* Retry at next bounded interval. */ }
    finally {
      this.heartbeatPending = false;
      if (this.heartbeatForcePending) { this.heartbeatForcePending = false; void this.heartbeat(true); }
    }
  }
  /** Small best-effort unload request survives dispose; no token in the payload.
   * The OS may kill the browser without pagehide, losing up to one 30s interval.
   */
  private pagehideHeartbeat() {
    if (!this.sessionId || this.disposed) return;
    void fetch(this.endpoint, {
      method: "POST", keepalive: true, credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ action: "heartbeat", request_id: crypto.randomUUID(),
        session_id: this.sessionId, active_seconds: Math.floor(this.activeSeconds) }),
    }).catch(() => { /* Unload cannot wait for retries; no state retained by this request. */ });
  }
  finishRun(result: Omit<RunResult, "durationMs"> & { durationMs?: number }): Promise<void> {
    const run = this.activeRun;
    this.setRunning(false);
    this.activeRun = undefined;
    if (!run) return Promise.resolve();
    const durationMs = integer(result.durationMs ?? this.activeSeconds * 1000 - run.started);
    const work = this.completeRun(run, result, durationMs);
    this.finishing = work.catch(() => {});
    return work;
  }
  private async completeRun(run: NonNullable<OnlineService["activeRun"]>, result: Pick<RunResult, "score" | "coins">, durationMs: number) {
    const runId = await run.start;
    // A run without a server start cannot pass the backend elapsed-time check.
    if (!runId) return;
    this.queue.push({ runId, requestId: crypto.randomUUID(), score: integer(result.score), coins: integer(result.coins), durationMs });
    this.queue = this.queue.slice(-MAX_QUEUE); this.persistQueue();
    await this.heartbeat(true);
    await this.flushQueue();
  }
  /** Main calls on pause/resume and lifecycle transitions; never from RAF. */
  setRunning(running: boolean) {
    const next = running && !!this.activeRun;
    if (this.running === next) return;
    const now = performance.now();
    if (this.running) this.activeMs += Math.max(0, now - this.activeSince);
    this.running = next;
    if (next) this.activeSince = now;
    else if (!this.disposed) void this.heartbeat(true);
  }
  get activeSeconds() { return (this.activeMs + (this.running ? Math.max(0, performance.now() - this.activeSince) : 0)) / 1000; }
  private persistQueue() { save(QUEUE_KEY, { token: this.token, runs: this.queue }); this.emit(); }
  async flushQueue() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length && this.canPlay && !this.disposed) {
        const run = this.queue[0];
        try { await this.request("run-finish", { request_id: run.requestId, run_id: run.runId, distance: run.score, coins: run.coins, duration: run.durationMs / 1000 }); }
        catch (error) { if (!(error instanceof OnlineError) || error.retryable) break; }
        this.queue = this.queue.filter(item => item.requestId !== run.requestId); this.persistQueue();
      }
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  async leaderboard(metric: LeaderboardMetric, period: LeaderboardPeriod): Promise<LeaderboardResult> {
    const data = await this.request("leaderboard", { metric, period });
    const personal = object(data.personal);
    const entries = Array.isArray(data.entries) ? data.entries.slice(0, 100).map((value, index) => {
      const row = object(value);
      return { rank: integer(row.rank) || index + 1, nickname: String(row.nickname || "—"), value: integer(row.value),
        playerId: typeof row.profile_id === "string" ? row.profile_id : typeof row.playerId === "string" ? row.playerId : undefined };
    }) : [];
    return { entries, personal: { record: integer(personal.record), rank: integer(personal.rank) || null } };
  }
  async adminLogin(email: string, password: string) {
    if (!this.publicKey) throw new OnlineError("Для входа нужен публичный ключ Supabase (VITE_SUPABASE_PUBLISHABLE_KEY).");
    const data = await this.fetchJSON(`${this.authUrl}/token?grant_type=password`, { email: email.trim(), password }, { apikey: this.publicKey });
    this.acceptSession(data);
    try { return await this.adminSummary(); } catch (error) { await this.adminLogout(); throw error; }
  }
  private acceptSession(data: Record<string, unknown>) {
    if (this.disposed) throw new OnlineError("Сервис закрыт.");
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") throw new OnlineError("Не удалось войти.", 401);
    // Admin credentials and tokens stay in memory, never in localStorage.
    this.adminSession = { access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: Date.now() + integer(data.expires_in) * 1000 };
    this.emit();
  }
  async adminSummary(): Promise<Record<string, number>> {
    if (!this.adminSession) throw new OnlineError("Войдите по email и паролю.", 401);
    if (this.adminSession.expires_at < Date.now() + 30000) {
      try {
        this.acceptSession(await this.fetchJSON(`${this.authUrl}/token?grant_type=refresh_token`,
          { refresh_token: this.adminSession.refresh_token }, { apikey: this.publicKey }));
      } catch (error) { this.adminSession = undefined; this.emit(); throw error; }
    }
    let data: Record<string, unknown>;
    try { data = await this.request("admin-summary", {}, this.adminSession.access_token); }
    catch (error) {
      if (error instanceof OnlineError && [401, 403].includes(error.status)) await this.adminLogout();
      throw error;
    }
    const source = object(data.summary || data);
    return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  }
  async adminLogout() {
    const session = this.adminSession; this.adminSession = undefined; this.emit();
    if (session) try { await this.fetchJSON(`${this.authUrl}/logout`, {}, { apikey: this.publicKey, Authorization: `Bearer ${session.access_token}` }); } catch { /* Local session already cleared. */ }
  }
  private stopHeartbeat() { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  dispose() {
    this.setRunning(false); this.disposed = true; this.stopHeartbeat(); this.lifecycle.abort();
    for (const controller of this.controllers) controller.abort();
    this.adminSession = undefined; this.listeners.clear();
  }
}
