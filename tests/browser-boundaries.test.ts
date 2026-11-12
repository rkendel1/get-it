/**
 * Browser boundaries against the running server and its production build: anonymous visitors,
 * members, expired sessions, cross-tenant access, what the browser actually receives, tampered
 * digests, refresh and navigation, duplicate submissions, mobile layout, and the empty, loading,
 * error and incomplete states.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Response } from "playwright";
import { billSet } from "./_bills.js";
import { join, signIn, signUp, stored, type Person } from "./_http.js";
import { assertFitsWidth, createOrganizationInBrowser, openMailedLink, signUpInBrowser, withBrowserApp, type BrowserApp } from "./_browser.js";

const BILLS = Buffer.from(JSON.stringify(billSet()));

async function ownerWithOrg(app: BrowserApp, page: Page, name: string, email: string, org: string) {
  await signUpInBrowser(app, page, name, email);
  await createOrganizationInBrowser(page, org);
  const owner = await signIn(app.http, email);
  const r = await app.http.request("GET", "/api/tenants", undefined, owner.token);
  const tenantId = r.body.tenants[0].id as string;
  await owner.switchTo(tenantId);
  return { owner, tenantId };
}

async function startRequest(page: Page, text: string) {
  await page.getByLabel("Describe what you need done").fill(text);
  await page.getByRole("button", { name: "Start my request" }).click();
  await page.getByTestId("request-status").waitFor();
  return page.url().split("#/requests/")[1]!;
}

async function answerAll(page: Page, skip: string[] = []) {
  for (const [label, input, value] of [
    ["Your home currency", "homeCurrency", "USD"],
    ["Review date", "asOfDate", "2026-11-10"],
  ] as const) {
    if (skip.includes(input)) continue;
    await page.getByLabel(label).fill(value);
    await page.locator(`[data-input="${input}"]`).getByRole("button", { name: "Save" }).click();
    await page.getByTestId(`value-${input}`).waitFor();
  }
  await page.getByLabel("Your time zone").selectOption("America/New_York");
  await page.locator('[data-input="timeZone"]').getByRole("button", { name: "Save" }).click();
  await page.getByTestId("value-timeZone").waitFor();
  await page.getByLabel("Bill set file").setInputFiles({ name: "bills.json", mimeType: "application/json", buffer: BILLS });
  await page.getByText("bills.json: 11 bills received.").waitFor();
}

/**
 * Every API body the browser received. FeltKit's live-update stream (/api/events) never ends by
 * design, so it is skipped, and every read is bounded so no response can hang the test.
 */
async function apiBodies(responses: Response[]) {
  const out: string[] = [];
  for (const r of responses) {
    if (!r.url().includes("/api/") || r.url().includes("/api/events") || (r.headers()["content-type"] ?? "").includes("text/event-stream")) continue;
    const body = await Promise.race([r.text().catch(() => ""), new Promise<string>((done) => setTimeout(() => done(""), 2000))]);
    out.push(body);
  }
  return out.join("\n");
}

test("anonymous visitors see the service and FeltKit's sign-in, and no tenant data, even at a request's URL", () =>
  withBrowserApp(async (app) => {
    const { page: owner } = await app.person();
    await ownerWithOrg(app, owner, "Ada", "ada@acme.test", "Acme");
    const sessionId = await startRequest(owner, "Review our bills.");

    const { page, responses } = await app.person();
    await page.goto(`${app.url}/#/requests/${sessionId}`);
    await page.getByRole("heading", { name: "What do you need done?" }).waitFor();
    await page.getByRole("heading", { name: "Create your account" }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("Review our bills."));
    assert.ok(!(await apiBodies(responses)).includes("Review our bills."));
    // Calling a function without a session is refused by the server.
    const r = await page.evaluate(async () => (await fetch("/api/query/intake:list", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"args":{}}' })).status);
    assert.ok(r === 401 || r === 403, `status ${r}`);
  }));

test("a member joins by invitation in the browser, provides information, and cannot accept the quote", () =>
  withBrowserApp(async (app) => {
    const { page: ownerPage } = await app.person();
    const { owner } = await ownerWithOrg(app, ownerPage, "Ada", "ada@acme.test", "Acme");
    const otto = await signUp(app.http, "otto@get-it.test", "Otto");
    await join(owner, otto, "operator");
    const sessionId = await startRequest(ownerPage, "Review our bills.");

    // The owner invites Amy; Amy creates her account, verifies, and accepts in the browser.
    const invite = await app.http.request("POST", "/api/tenants/current/invitations", { email: "amy@acme.test", role: "member" }, owner.token);
    assert.equal(invite.status, 201);
    const { page } = await app.person();
    await signUpInBrowser(app, page, "Amy Member", "amy@acme.test");
    await openMailedLink(app, page, "amy@acme.test", "invitation");
    await page.getByRole("button", { name: /^Join/ }).click();
    await page.getByTestId("organization").filter({ hasText: "Acme" }).waitFor();
    await app.shot(page, "20-member-home");

    // The member sees the organization's request and provides the information.
    await page.getByRole("link", { name: /Review our bills\./ }).click();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting your information" }).waitFor();
    await answerAll(page);
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    await otto.mutation("quotes:create", { sessionId });
    await page.getByTestId("quote-total").waitFor();
    // Only the owner can accept: the member sees why, and no accept button.
    await page.getByText("Only your organization's owner can accept this quote.").waitFor();
    assert.equal(await page.getByRole("button", { name: /Accept quote/ }).count(), 0);
    await app.shot(page, "21-member-quote");
    // Even a forged call from the member's own session is refused by the server.
    const forged = await page.evaluate(async (args) => {
      const s = await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json();
      const r = await fetch("/api/mutation/quotes:accept", { method: "POST", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": s.csrf ?? "" }, body: JSON.stringify({ args }) });
      return { status: r.status, body: await r.json() };
    }, { quoteId: "x", quoteDigest: "y" });
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    assert.equal((await stored(app.http, "quoteAcceptances")).length, 0);
  }));

test("an expired session returns the visitor to sign-in, and the server refuses its cookie", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person();
    await ownerWithOrg(app, page, "Ada", "ada@acme.test", "Acme");
    const sessionId = await startRequest(page, "Review our bills.");
    // Expire every session of the account, as time would.
    const sessions = app.t.runtime.instance.handle("test.expire").collection<Record<string, any>>("_feltkit_sessions");
    for (const s of await sessions.find({})) await sessions.update(s.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await page.reload();
    await page.getByRole("heading", { name: "Create your account" }).or(page.getByRole("heading", { name: "Welcome back." })).first().waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("Review our bills."));
    const r = await page.evaluate(async (id) => (await fetch("/api/query/intake:get", { method: "POST", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie" }, body: JSON.stringify({ args: { sessionId: id } }) })).status, sessionId);
    assert.ok(r === 401 || r === 403, `status ${r}`);
    await app.shot(page, "22-session-expired");
  }));

test("tenant isolation in the browser: another organization's request is not found, and its records never arrive", () =>
  withBrowserApp(async (app) => {
    const { page: acme } = await app.person();
    await ownerWithOrg(app, acme, "Ada", "ada@acme.test", "Acme");
    const sessionId = await startRequest(acme, "Acme's confidential bills.");

    const { page, responses } = await app.person();
    await ownerWithOrg(app, page, "Gus", "gus@globex.test", "Globex");
    await page.goto(`${app.url}/#/requests/${sessionId}`);
    await page.getByRole("heading", { name: "Request not found" }).waitFor();
    await page.goto(`${app.url}/#/`);
    await page.getByText("No requests yet.").waitFor();
    assert.ok(!(await apiBodies(responses)).includes("confidential"));
    await app.shot(page, "23-cross-tenant-not-found");

    // A signed-in person with no organization is asked to create one; Acme's request is not reachable.
    const { page: nora } = await app.person();
    await signUpInBrowser(app, nora, "Nora", "nora@elsewhere.test");
    await nora.goto(`${app.url}/#/requests/${sessionId}`);
    await nora.getByRole("heading", { name: "Name your organization" }).waitFor();
    assert.ok(!(await nora.locator("body").innerText()).includes("confidential"));
  }));

test("customer-safe: across the whole journey the browser receives no operator identity or internal metadata", () =>
  withBrowserApp(async (app) => {
    const { page, responses } = await app.person();
    const { owner } = await ownerWithOrg(app, page, "Ada", "ada@acme.test", "Acme");
    const otto = await signUp(app.http, "otto@get-it.test", "Otto");
    const olga = await signUp(app.http, "olga@get-it.test", "Olga");
    await join(owner, otto, "operator");
    await join(owner, olga, "operator");
    const sessionId = await startRequest(page, "Review our bills.");
    await answerAll(page);
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    const quote = await otto.mutation("quotes:create", { sessionId });
    await page.getByRole("button", { name: /Accept quote/ }).click();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting payment" }).waitFor();
    const orderId = (await owner.query("orders:list"))[0].id;
    await otto.mutation("payments:record", { quoteId: quote.quoteId, amountMinor: quote.priceMinor, currency: "USD", method: "bank_transfer", reference: "SECRET-WIRE-REF-77", idempotencyKey: "k" });
    await otto.mutation("orders:acceptForFulfillment", { orderId });
    const [snapshot] = await otto.query("imports:list", { orderId });
    const run = await otto.mutation("runs:reviewSnapshot", { snapshotId: snapshot.id });
    const packet = await otto.mutation("review:request", { runId: run.runId });
    await olga.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest });
    await otto.mutation("delivery:publish", { packetId: packet.packetId });
    await page.getByTestId("request-status").filter({ hasText: "Delivered" }).waitFor();
    await page.getByRole("button", { name: "Download evidence.json" }).click();
    await page.waitForTimeout(300);

    const received = await apiBodies(responses);
    const rendered = await page.locator("body").innerText();
    for (const internal of [otto.id, olga.id, "otto@get-it.test", "olga@get-it.test", "approvedBy", "approverType", "requestedBy", "publishedBy", "recordedBy", "importedBy", "approvalId", "SECRET-WIRE-REF-77", "idempotencyKey"]) {
      assert.ok(!received.includes(internal), `the browser received ${internal}`);
      assert.ok(!rendered.includes(internal), `the page shows ${internal}`);
    }
  }));

test("tampered digests sent from the browser are refused by the server and shown as errors", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person();
    const { owner } = await ownerWithOrg(app, page, "Ada", "ada@acme.test", "Acme");
    const otto = await signUp(app.http, "otto@get-it.test", "Otto");
    await join(owner, otto, "operator");
    const sessionId = await startRequest(page, "Review our bills.");
    await answerAll(page);
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    await otto.mutation("quotes:create", { sessionId });
    await page.getByTestId("quote-total").waitFor();
    // Rewrite the quote digest in flight, as a compromised page would.
    await page.route("**/api/mutation/quotes*accept", async (route) => {
      const body = route.request().postDataJSON();
      body.args.quoteDigest = `sha256:${"0".repeat(64)}`;
      await route.continue({ postData: JSON.stringify(body) });
    });
    await page.getByRole("button", { name: /Accept quote/ }).click();
    await page.getByRole("alert").filter({ hasText: "That is not this quote: its digest differs." }).waitFor();
    assert.equal((await stored(app.http, "quoteAcceptances")).length, 0);
    await page.getByTestId("request-status").filter({ hasText: "Awaiting quote acceptance" }).waitFor();
    await app.shot(page, "24-tampered-digest-refused");
  }));

test("refresh and navigation keep the request, from the server; duplicate submissions create one record", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person();
    const { owner } = await ownerWithOrg(app, page, "Ada", "ada@acme.test", "Acme");
    const otto = await signUp(app.http, "otto@get-it.test", "Otto");
    await join(owner, otto, "operator");

    // A double click on "Start my request" starts one request.
    await page.getByLabel("Describe what you need done").fill("Review our bills.");
    await page.getByRole("button", { name: "Start my request" }).dblclick();
    await page.getByTestId("request-status").waitFor();
    const sessionId = page.url().split("#/requests/")[1]!;
    assert.equal((await stored(app.http, "intakeSessions")).length, 1);

    await page.getByLabel("Your home currency").fill("EUR");
    await page.locator('[data-input="homeCurrency"]').getByRole("button", { name: "Save" }).click();
    await page.getByTestId("value-homeCurrency").filter({ hasText: "EUR" }).waitFor();
    await page.reload();
    await page.getByTestId("value-homeCurrency").filter({ hasText: "EUR" }).waitFor();
    // Away and back through the request list.
    await page.getByRole("link", { name: "Your requests" }).click();
    await page.getByRole("link", { name: /Review our bills\./ }).click();
    await page.getByTestId("value-homeCurrency").filter({ hasText: "EUR" }).waitFor();
    assert.equal(page.url().split("#/requests/")[1], sessionId);

    await page.locator('[data-input="homeCurrency"]').getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Your home currency").fill("USD");
    await page.locator('[data-input="homeCurrency"]').getByRole("button", { name: "Save" }).click();
    await page.getByTestId("value-homeCurrency").filter({ hasText: "USD" }).waitFor();
    await answerAll(page, ["homeCurrency"]);
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    await otto.mutation("quotes:create", { sessionId });
    // A double click on accept creates one acceptance and one order.
    await page.getByRole("button", { name: /Accept quote/ }).dblclick();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting payment" }).waitFor();
    await page.reload();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting payment" }).waitFor();
    assert.equal((await stored(app.http, "quoteAcceptances")).length, 1);
    assert.equal((await stored(app.http, "orders")).length, 1);
    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []], "no business state in browser storage");
  }));

test("empty, loading, error and incomplete states are shown, and the layout fits a phone", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person({ mobile: true });
    await page.goto(app.url);
    await assertFitsWidth(page, "landing (phone)");
    await app.shot(page, "30-mobile-landing");
    await ownerWithOrg(app, page, "Ada", "ada@acme.test", "Acme");

    // Empty.
    await page.getByText("No requests yet.").waitFor();
    await assertFitsWidth(page, "home (phone)");
    await app.shot(page, "31-mobile-empty");

    // Loading: hold the intake read so the loading state is visible.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/query/intake*get", async (route) => {
      await held;
      await route.continue();
    });
    await page.getByLabel("Describe what you need done").fill("Review our bills.");
    await page.getByRole("button", { name: "Start my request" }).click();
    await page.getByRole("status").filter({ hasText: "Loading your request" }).waitFor();
    await app.shot(page, "32-mobile-loading");
    // Once released the interception passes every request straight through. (Removing it while requests
    // are held lets Playwright continue them itself, racing this handler.)
    release();
    await page.getByTestId("request-status").waitFor();

    // Incomplete: finishing early is refused by the server, which names what is missing.
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    await page.getByRole("alert").filter({ hasText: "Required inputs are missing: homeCurrency, timeZone, asOfDate, bills, vendors, accounts." }).waitFor();
    // Errors from the server's contract validation, and from a file that is not JSON.
    await page.getByLabel("Receipt or invoice required above").fill("2000000");
    await page.locator('[data-input="policy.documentRequiredOverMinor"]').getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").filter({ hasText: "between 0 and 100000000" }).waitFor();
    await page.getByLabel("Bill set file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not json") });
    await page.getByRole("alert").filter({ hasText: "notes.txt is not a JSON file" }).waitFor();
    await page.getByLabel("Bill set file").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...billSet(), vendors: [{ id: "V1" }] })) });
    await page.getByRole("alert").filter({ hasText: "vendors[0].name is missing" }).waitFor();
    await assertFitsWidth(page, "intake with errors (phone)");
    await app.shot(page, "33-mobile-errors");

    await answerAll(page);
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    await page.getByRole("heading", { name: "Your quote is being prepared" }).waitFor();
    await assertFitsWidth(page, "proposed service (phone)");
    await app.shot(page, "34-mobile-proposal");
  }));
