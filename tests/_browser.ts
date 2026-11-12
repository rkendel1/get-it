/**
 * Browser harness: the production build of the customer app, served by get-it's own FeltKit server
 * (FeltKit's `startServer` with the built assets: the same origin for pages and functions, as cookie
 * sessions require), driven by a real Chromium through Playwright.
 *
 * - Customers act only in the browser, with FeltKit's cookie sessions and CSRF tokens.
 * - get-it's operators, who have no customer UI, act over HTTP with their own sessions, exactly as
 *   the HTTP transaction tests do.
 *
 * Every test records screenshots to test-results/browser/ as evidence of what was rendered.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { startServer } from "@feltdb/feltkit/server";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { build } from "vite";
import { httpFor, PASSWORD, type Http } from "./_http.js";

export const SHOTS = "test-results/browser";
let built: Promise<unknown> | null = null;

/** Build the customer app once per test file, exactly as `feltkit build` does (vite.config.ts). */
export function buildClient() {
  built ??= build({ configFile: "vite.config.ts", logLevel: "warn" });
  return built;
}

export interface BrowserApp {
  url: string;
  t: TestApp;
  http: Http;
  browser: Browser;
  /** A fresh browser profile (its own cookies): one per person. */
  person(options?: { mobile?: boolean }): Promise<{ context: BrowserContext; page: Page; responses: Response[] }>;
  shot(page: Page, name: string): Promise<void>;
}

export async function withBrowserApp(fn: (app: BrowserApp) => Promise<void>) {
  await buildClient();
  mkdirSync(SHOTS, { recursive: true });
  const t = await createTestApp();
  const server = await startServer({ runtime: t.runtime, projectDir: process.cwd(), host: "127.0.0.1", port: 0, frontend: { staticDir: "dist/client" }, dashboard: { enabled: false, adminToken: "", dir: null } });
  const browser = await chromium.launch();
  const contexts: BrowserContext[] = [];
  /** Uncaught errors in any page: a crashed screen fails the test even if no assertion looked at it. */
  const pageErrors: string[] = [];
  const app: BrowserApp = {
    url: server.url,
    t,
    http: httpFor(server.url, t),
    browser,
    async person(options = {}) {
      const context = await browser.newContext(options.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: { width: 1280, height: 900 } });
      contexts.push(context);
      const page = await context.newPage();
      const responses: Response[] = [];
      page.on("response", (r) => responses.push(r));
      page.on("pageerror", (e) => pageErrors.push(e.message));
      return { context, page, responses };
    },
    async shot(page, name) {
      await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
    },
  };
  try {
    await fn(app);
    assert.deepEqual(pageErrors, [], "uncaught errors in the browser");
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close();
    await server.close();
    await t.close();
  }
}

/** Open the e-mailed link FeltKit sent to an address (verification or invitation) in this page. */
export async function openMailedLink(app: BrowserApp, page: Page, email: string, purpose: "verify" | "invitation") {
  const mail = [...(app.t.runtime.mail?.inbox ?? [])].reverse().find((m) => m.to === email && m.text.includes(`#feltkit-${purpose}=`));
  assert.ok(mail, `a ${purpose} e-mail to ${email}`);
  const token = new RegExp(`#feltkit-${purpose}=([A-Za-z0-9_-]+)`).exec(mail.text)![1]!;
  // A link opened from an e-mail is a fresh page load. Going to it from a page of the same app would
  // only change the hash, and FeltKit reads these links once per page load.
  await page.goto("about:blank");
  await page.goto(`${app.url}/#feltkit-${purpose}=${token}`);
}

/** Create an account in the browser with FeltKit's sign-up form, then verify the address through the e-mailed link. */
export async function signUpInBrowser(app: BrowserApp, page: Page, name: string, email: string, options: { goto?: boolean } = {}) {
  if (options.goto !== false) await page.goto(app.url);
  await page.getByRole("button", { name: "Create account" }).first().click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.locator("form").getByRole("button", { name: "Create account" }).click();
  await page.getByText(email).first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
  const r = await app.http.request("POST", "/api/auth/verify/request", { email });
  assert.equal(r.status, 202);
  // The verification link opens in a new tab, as a link clicked in an e-mail does; this tab keeps its state.
  const tab = await page.context().newPage();
  await openMailedLink(app, tab, email, "verify");
  // Wait for the fact, not for the network: the app holds a live-update stream open, so the network is
  // never idle. The server must record the address as verified, and the app must render a signed-in screen.
  const deadline = Date.now() + 15_000;
  while (!(await app.t.runtime.accounts!.findByEmail(email))?.emailVerified) {
    if (Date.now() > deadline) throw new Error(`${email} was not verified through the e-mailed link`);
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.getByRole("heading", { name: "Name your organization" }).or(page.getByTestId("organization")).first().waitFor();
  await tab.close();
}

/** Name the organization with FeltKit's create-organization form. */
export async function createOrganizationInBrowser(page: Page, name: string) {
  await page.getByRole("heading", { name: "Name your organization" }).waitFor();
  await page.locator("form input").first().fill(name);
  await page.locator("form").getByRole("button").first().click();
  await page.getByTestId("organization").filter({ hasText: name }).waitFor();
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** No horizontal scrolling at the current viewport. */
export async function assertFitsWidth(page: Page, where: string) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width, `${where}: the page is ${scroll}px wide in a ${width}px viewport`);
}
