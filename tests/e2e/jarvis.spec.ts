import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end verification of JARVIS OS against the production build (FastAPI serving
 * the static export). The AI model is the deterministic scripted test provider; every
 * other layer — auth, realtime, orchestrator, policy, approvals, tools, DB, voice
 * pipeline, 3D core — is the real implementation.
 */

test.describe.configure({ mode: "serial" });

const USER = "tony";
const PASSWORD = "correct-horse-battery-staple";
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1600, height: 960 }, permissions: ["microphone"] });
  page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
});

test.afterAll(async () => {
  await context.close();
});

async function send(text: string) {
  await page.getByLabel("Message JARVIS").fill(text);
  await page.keyboard.press("Enter");
}

test("first-run setup is gated by the setup token, then the dashboard goes live", async () => {
  await page.goto("/command/");
  await page.waitForURL(/\/login/);
  await page.getByLabel("Setup token").fill("wrong-token-000");
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole("button", { name: /Create owner account/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: /invalid setup token/i })).toBeVisible();

  await page.getByLabel("Setup token").fill("e2e-setup-token-0001");
  await page.getByLabel("Your name").fill("Tony");
  await page.getByRole("button", { name: /Create owner account/ }).click();
  await page.waitForURL(/\/command/);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("core-state")).toHaveText("Idle");
});

test("session cookie is HttpOnly and no secret is exposed to the page", async () => {
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "jarvis_session");
  expect(session?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("jarvis_session");
  const html = await page.content();
  for (const needle of ["e2e-secret-key", "sk-ant", "e2e-setup-token"]) expect(html).not.toContain(needle);
});

test("the 3D core renders with WebGL and reports frame statistics", async () => {
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __JARVIS_CORE_STATS__?: { fps: number } }).__JARVIS_CORE_STATS__?.fps, null, { timeout: 20_000 });
  const stats = await page.evaluate(() => (window as unknown as { __JARVIS_CORE_STATS__: Record<string, unknown> }).__JARVIS_CORE_STATS__);
  console.log("core stats (software-rendered SwiftShader):", JSON.stringify(stats));
  expect(Number(stats.fps)).toBeGreaterThan(0);
  expect(Number(stats.calls)).toBeGreaterThan(0);
});

test("chat → tool call → verified result streams in and the core reflects success", async () => {
  await page.getByRole("button", { name: "New" }).click();
  await send("note: Launch checklist | verify approvals, test voice");
  await expect(page.getByTestId("chat-log")).toContainText("Done (verified): Saved note “Launch checklist”", { timeout: 20_000 });
  await expect(page.getByTestId("chat-log")).toContainText("notes_create");
  await expect(page.getByTestId("core-state")).toHaveText(/Complete|Idle/);
});

test("approval gate: nothing runs until approved, then the outcome is verified", async () => {
  await send("write file reports/status.md: All systems nominal.");
  const card = page.getByTestId("approval-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("core-state")).toHaveText("Awaiting approval");
  await expect(card).toContainText("Write workspace file");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("chat-log")).toContainText("Created reports/status.md", { timeout: 20_000 });
});

test("approval denied: the action is not executed and JARVIS reports the denial", async () => {
  await send("write file secret.txt: should never exist");
  const card = page.getByTestId("approval-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByTestId("chat-log")).toContainText(/denied/i, { timeout: 20_000 });
});

test("unavailable/unauthorised actions are denied without asking", async () => {
  await send("launch calculator");
  await expect(page.getByTestId("chat-log")).toContainText(/failed: Not permitted: Unavailable: no paired desktop/i, { timeout: 20_000 });
});

test("command bar runs a direct tool without the model", async () => {
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Ask JARVIS/).fill("/calc 6*7");
  await page.getByRole("option", { name: /Calculate 6\*7/ }).click();
  await page.goto("/mission/");
  await expect(page.getByRole("button", { name: /\/calculate/ }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /\/calculate/ }).first().click();
  await expect(page.getByText("6*7 = 42")).toBeVisible();
});

test("push-to-talk: real microphone capture is transcribed offline and sent", async () => {
  await page.goto("/command/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 15_000 });
  const before = await page.getByTestId("chat-log").locator(".justify-end").count();
  const button = page.getByTestId("voice-button");
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByText("Mic live")).toBeVisible();
  await expect(page.getByTestId("core-state")).toHaveText("Listening");
  await page.waitForTimeout(2500); // the fake device loops the WAV fixture
  await page.mouse.up();
  await expect(page.getByText("Mic live")).toBeHidden({ timeout: 10_000 });
  // A transcript (PocketSphinx, offline) becomes a user message.
  await expect.poll(() => page.getByTestId("chat-log").locator(".justify-end").count(), { timeout: 20_000 }).toBeGreaterThan(before);
});

test("memory: create, search (lexical hybrid retrieval), make private and delete", async () => {
  await page.goto("/memory/");
  await page.getByLabel("Content").fill("I prefer metric units and British spelling");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.getByTestId("memory-card").first()).toContainText("metric units");
  await page.getByLabel("Search memories").fill("units preference metric");
  await expect(page.getByTestId("memory-card").first()).toContainText("metric");
  await page.getByLabel("Search memories").fill("");
  await page.getByTestId("memory-card").first().getByRole("button", { name: "Make private" }).click();
  await expect(page.getByTestId("memory-card").first()).toContainText("private");
  await page.getByTestId("memory-card").first().getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("memory-card")).toHaveCount(0);
});

test("emergency stop blocks side-effecting tools until released", async () => {
  await page.goto("/security/");
  await expect(page.getByRole("heading", { level: 1, name: "Security Centre" })).toBeVisible();
  await page.getByTestId("emergency-stop").click();
  await expect(page.getByText(/^Stopped\. \d+ running task/)).toBeVisible();
  const csrf = (await context.cookies()).find((c) => c.name === "jarvis_csrf")!.value;
  const res = await page.request.post("/api/commands", {
    data: { tool: "notes_create", args: { title: "blocked" } },
    headers: { "X-CSRF-Token": csrf },
  });
  expect(res.ok()).toBe(true);
  const runId = (await res.json()).run.id;
  await expect
    .poll(async () => (await (await page.request.get(`/api/runs/${runId}`)).json()).run.error ?? "", { timeout: 10_000 })
    .toContain("Emergency stop");
  await expect(page.getByTestId("emergency-stop")).toHaveText("Release");
  await page.getByTestId("emergency-stop").click();
  await expect(page.getByText("Released.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("emergency-stop")).toHaveText("Engage stop");
});

test("every workspace loads and has its heading", async () => {
  const titles: Record<string, string> = {
    mission: "Mission Control",
    intelligence: "Intelligence",
    development: "Development",
    assistant: "Personal Assistant",
    memory: "Memory Centre",
    automation: "Automation Centre",
    integrations: "Integrations",
    security: "Security Centre",
    settings: "Settings",
  };
  for (const [path, title] of Object.entries(titles)) {
    await page.goto(`/${path}/`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  }
  // The daily briefing workflow writes a real note.
  await page.goto("/assistant/");
  await page.getByRole("button", { name: "Run daily briefing" }).click();
  await expect(page.getByText("Daily briefing").first()).toBeVisible({ timeout: 15_000 });
});

test("API rejects mutations without CSRF and unauthenticated access", async ({ request }) => {
  const anon = await request.get("/api/system/status");
  expect(anon.status()).toBe(401);
  const noCsrf = await page.request.post("/api/notes", { data: { title: "x" } });
  expect(noCsrf.status()).toBe(403);
});

test("mobile layout: bottom navigation, no horizontal overflow, core visible", async ({ browser }) => {
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState: await context.storageState(),
  });
  const p = await mobile.newPage();
  await p.goto("/command/");
  await expect(p.getByRole("navigation", { name: "Workspaces" }).last()).toBeVisible();
  await expect(p.getByTestId("core-state")).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await p.getByRole("link", { name: "Security" }).click();
  await expect(p.getByRole("heading", { level: 1, name: "Security Centre" })).toBeVisible();
  await mobile.close();
});

test("no unexpected console errors during the whole session", async () => {
  // 401/403s triggered deliberately by the security tests are logged as failed resources.
  const unexpected = consoleErrors.filter((e) => !/status of 40[13]/.test(e));
  expect(unexpected).toEqual([]);
});
