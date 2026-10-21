import { OnlineService, type LeaderboardMetric, type LeaderboardPeriod } from "./online";

function element<T extends HTMLElement = HTMLElement>(id: string) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing online UI: ${id}`);
  return value as T;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Не удалось загрузить данные."; }
const number = new Intl.NumberFormat("ru-RU");

/** Main owns menu selection and run transitions. This class owns only online DOM. */
export class OnlineUI {
  private readonly lifecycle = new AbortController();
  private readonly unsubscribe: () => void;
  private readonly accessObserver: MutationObserver;
  private metric: LeaderboardMetric = "score";
  private period: LeaderboardPeriod = "all";
  private boardRequest = 0;
  private nicknameBusy = false;
  private renameMode = false;
  private initialized = false;
  private disposed = false;
  constructor(readonly service: OnlineService) {
    this.unsubscribe = service.subscribe(() => this.renderProfile());
    this.bind("nickname-save", () => { void this.saveNickname(); });
    this.bind("nickname-cancel", () => this.closeNickname());
    this.bind("profile-rename", () => this.openNickname(true));
    this.bind("leaderboard-refresh", () => { void this.refreshSection("leaderboard"); });
    this.bind("admin-login", () => { void this.login(); });
    this.bind("admin-logout", () => { void this.logout(); });
    this.bind("admin-refresh", () => { void this.refreshSection("admin"); });
    for (const metric of ["score", "coins"] as const) this.bind(`leaderboard-${metric}`, () => {
      this.metric = metric; void this.refreshSection("leaderboard");
    });
    for (const period of ["day", "week", "all"] as const) this.bind(`leaderboard-${period}`, () => {
      this.period = period; void this.refreshSection("leaderboard");
    });
    element("nickname-input").addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); void this.saveNickname(); }
    }, { signal: this.lifecycle.signal });
    element("admin-password").addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); void this.login(); }
    }, { signal: this.lifecycle.signal });
    // The author gate controls discoverability only; server JWT controls access.
    this.accessObserver = new MutationObserver(() => this.syncAccess());
    this.accessObserver.observe(element("developer-toggle"), { attributes: true, attributeFilter: ["hidden"] });
    this.syncAccess(); this.renderProfile();
  }
  get canPlay() { return this.service.canPlay; }
  ensureProfile() { if (!this.canPlay) this.requireNickname(); return this.canPlay; }
  refresh(section: "leaderboard" | "admin") { return this.refreshSection(section); }
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.service.init();
    if (this.disposed) return;
    this.renderProfile();
    if (!this.canPlay) this.requireNickname();
  }
  requireNickname() { if (!this.canPlay) this.openNickname(false); }
  private bind(id: string, action: () => void) {
    const button = element<HTMLButtonElement>(id);
    let down: { id: number; x: number; y: number } | undefined;
    button.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }, { signal: this.lifecycle.signal });
    button.addEventListener("pointercancel", () => { down = undefined; }, { signal: this.lifecycle.signal });
    button.addEventListener("pointerup", event => {
      const start = down; down = undefined;
      if (!start || start.id !== event.pointerId || button.disabled || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
      event.preventDefault(); event.stopPropagation(); action();
    }, { signal: this.lifecycle.signal });
    // Explicit pointerup is the only activation path, including on mobile shells.
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); }, { signal: this.lifecycle.signal });
  }
  private syncAccess() {
    const unlocked = !element("developer-toggle").hidden;
    element("admin-toggle").hidden = !unlocked;
    if (!unlocked) {
      element("admin-panel").hidden = true;
      element("admin-summary").replaceChildren();
      if (this.service.isAdminSignedIn) void this.service.adminLogout();
    }
  }
  private renderProfile() {
    if (this.disposed) return;
    element("profile-nickname").textContent = this.service.profile?.nickname || "ВЫБЕРИТЕ НИК";
    element("online-status").textContent = this.service.online ? "В СЕТИ" :
      this.canPlay ? `ОФЛАЙН${this.service.pendingRuns ? ` · ОЖИДАЮТ: ${this.service.pendingRuns}` : ""}` : "НУЖНА РЕГИСТРАЦИЯ";
    element("profile-rename").hidden = !this.canPlay;
    if (this.canPlay && !this.renameMode) this.closeNickname();
    element("admin-login-form").hidden = this.service.isAdminSignedIn;
    element("admin-session").hidden = !this.service.isAdminSignedIn;
  }
  private openNickname(rename: boolean) {
    this.renameMode = rename;
    const gate = element("nickname-gate");
    element("nickname-title").textContent = rename ? "СМЕНИТЬ НИК" : "ВЫБЕРИТЕ НИК";
    element("nickname-cancel").hidden = !this.canPlay;
    element("nickname-message").textContent = "Уникальное имя · 3–20 букв, цифр, _ или -. Для подтверждения нужен интернет.";
    element<HTMLInputElement>("nickname-input").value = this.service.profile?.nickname || "";
    gate.hidden = false;
    // Block underlying menus even when opened programmatically by shell/help.
    element("overlay").inert = true;
    element<HTMLInputElement>("nickname-input").focus({ preventScroll: true });
  }
  private closeNickname() {
    if (!this.canPlay) return;
    const gate = element("nickname-gate");
    if (gate.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    gate.hidden = true; element("overlay").inert = false; this.renameMode = false;
  }
  private async saveNickname() {
    if (this.nicknameBusy) return;
    this.nicknameBusy = true;
    element<HTMLButtonElement>("nickname-save").disabled = true;
    element("nickname-message").textContent = "ПРОВЕРЯЕМ ИМЯ…";
    try {
      const nickname = element<HTMLInputElement>("nickname-input").value;
      if (this.canPlay) await this.service.rename(nickname); else await this.service.register(nickname);
      if (!this.disposed) { this.closeNickname(); this.renderProfile(); }
    } catch (error) { if (!this.disposed) element("nickname-message").textContent = message(error); }
    finally { this.nicknameBusy = false; element<HTMLButtonElement>("nickname-save").disabled = false; }
  }
  async refreshSection(section: "leaderboard" | "admin") {
    if (this.disposed) return;
    if (section === "admin") { await this.refreshAdmin(); return; }
    const request = ++this.boardRequest;
    for (const metric of ["score", "coins"]) element(`leaderboard-${metric}`).setAttribute("aria-pressed", String(metric === this.metric));
    for (const period of ["day", "week", "all"]) element(`leaderboard-${period}`).setAttribute("aria-pressed", String(period === this.period));
    element("leaderboard-status").textContent = "ЗАГРУЗКА…";
    element("leaderboard-rows").replaceChildren();
    element("leaderboard-personal").textContent = "ВАШ РЕКОРД: — · МЕСТО: —";
    try {
      const result = await this.service.leaderboard(this.metric, this.period);
      if (request !== this.boardRequest || this.disposed) return;
      element("leaderboard-status").textContent = result.entries.length ? "" : "В этом периоде ещё нет результатов.";
      const unit = this.metric === "score" ? " м" : "";
      element("leaderboard-personal").textContent = `ВАШ РЕКОРД: ${number.format(result.personal.record)}${unit} · МЕСТО: ${result.personal.rank ?? "—"}`;
      const rows = result.entries.map(entry => {
        const row = document.createElement("tr");
        if (entry.playerId === this.service.profile?.id || entry.nickname === this.service.profile?.nickname) row.className = "online-self";
        for (const text of [String(entry.rank), entry.nickname, `${number.format(entry.value)}${unit}`]) {
          const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
        }
        return row;
      });
      element("leaderboard-rows").replaceChildren(...rows);
    } catch (error) {
      if (request === this.boardRequest && !this.disposed) element("leaderboard-status").textContent = message(error);
    }
  }
  private async login() {
    const button = element<HTMLButtonElement>("admin-login");
    if (button.disabled || element("admin-toggle").hidden) return;
    button.disabled = true; element("admin-status").textContent = "ВХОД…";
    const password = element<HTMLInputElement>("admin-password");
    try {
      const summary = await this.service.adminLogin(element<HTMLInputElement>("admin-email").value, password.value);
      if (!this.disposed && !element("admin-toggle").hidden) { this.renderSummary(summary); element("admin-status").textContent = ""; }
    } catch (error) { if (!this.disposed) element("admin-status").textContent = message(error); }
    finally { password.value = ""; button.disabled = false; this.renderProfile(); }
  }
  private async logout() {
    element("admin-summary").replaceChildren(); element("admin-status").textContent = "";
    await this.service.adminLogout(); this.renderProfile();
  }
  private async refreshAdmin() {
    if (element("admin-toggle").hidden || !this.service.isAdminSignedIn) return;
    element("admin-status").textContent = "ЗАГРУЗКА…";
    element("admin-summary").replaceChildren();
    try {
      const summary = await this.service.adminSummary();
      if (this.disposed || element("admin-toggle").hidden || !this.service.isAdminSignedIn) return;
      this.renderSummary(summary); element("admin-status").textContent = "";
    } catch (error) { if (!this.disposed) element("admin-status").textContent = message(error); }
  }
  private renderSummary(summary: Record<string, number>) {
    const labels: Record<string, string> = { players: "Игроки", runs: "Забеги", retained_sessions: "Сессии за 90 дней", visits: "Посещения", active_seconds: "Активное время, с", completed_runs: "Завершённые забеги", earned_coins: "Собрано монет", active_today: "Активны сегодня", active_7_days: "Активны за 7 дней", active_30_days: "Активны за 30 дней", best_score: "Рекорд, м", average_run_seconds: "Средний забег, с", activePlayers: "Активные игроки", totalCoins: "Собрано монет", bestScore: "Рекорд, м", totalRuns: "Всего забегов", totalPlayers: "Всего игроков" };
    const nodes: HTMLElement[] = [];
    for (const [key, value] of Object.entries(summary)) {
      const label = document.createElement("dt"); label.textContent = labels[key] || key;
      const count = document.createElement("dd"); count.textContent = number.format(value);
      nodes.push(label, count);
    }
    element("admin-summary").replaceChildren(...nodes);
  }
  dispose() {
    this.disposed = true; this.boardRequest++; this.lifecycle.abort(); this.unsubscribe(); this.accessObserver.disconnect();
    element("overlay").inert = false; element("nickname-gate").hidden = true;
  }
}
