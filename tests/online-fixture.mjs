/** Deterministic registered identity for renderer/gesture tests; never hits production. */
export async function installOnlineFixture(page) {
  await page.addInitScript(() => {
    const token = "a".repeat(64);
    localStorage.setItem("dinorun-online-v1-token", JSON.stringify(token));
    localStorage.setItem("dinorun-online-v1-profile", JSON.stringify({ token, profile: { id: "11111111-1111-4111-8111-111111111111", nickname: "BrowserTest" } }));
  });
  await page.route("**/functions/v1/game-api", async route => {
    const body = route.request().postDataJSON() || {};
    const data = body.action === "profile" || body.action === "register" || body.action === "rename"
      ? { profile: { id: "11111111-1111-4111-8111-111111111111", nickname: body.nickname || "BrowserTest" } }
      : body.action === "leaderboard" ? { entries: [], personal: { record: 0, rank: null } } : {};
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });
}
