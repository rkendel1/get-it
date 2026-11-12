/**
 * The customer journey in a real browser (Chromium via Playwright) against get-it's running FeltKit
 * server and its production build. Customers use only the browser, with FeltKit's cookie sessions
 * and CSRF. get-it's operators, who have no customer UI, act over HTTP with their own sessions.
 * Screenshots of every stage are written to test-results/browser/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Download, Page } from "playwright";
import { digest } from "../src/canonical.js";
import { billSet } from "./_bills.js";
import { join, signIn, signUp, stored, type Person } from "./_http.js";
import { assertFitsWidth, createOrganizationInBrowser, sha256, signUpInBrowser, withBrowserApp, type BrowserApp } from "./_browser.js";

const BILLS = Buffer.from(JSON.stringify(billSet()));

/** The bill-review intake a task continues in (storage read only to find its id). */
async function sessionOf(app: BrowserApp, requestId: string) {
  const choice = (await stored(app.http, "taskServiceChoices")).find((c) => c.requestId === requestId && c.choice === "accepted");
  assert.ok(choice?.sessionId, "the task continues in an intake");
  return choice.sessionId as string;
}

/** The bytes the browser saved for a download. */
async function downloaded(d: Download): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await d.createReadStream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** The organization's id, through the owner's own HTTP session (to invite get-it's operators). */
async function tenantOf(app: BrowserApp, email: string): Promise<{ owner: Person; tenantId: string }> {
  const owner = await signIn(app.http, email);
  const r = await app.http.request("GET", "/api/tenants", undefined, owner.token);
  const tenantId = r.body.tenants[0].id as string;
  await owner.switchTo(tenantId);
  return { owner, tenantId };
}

/** get-it's operators for an organization: Otto fulfils, Olga approves his work. */
async function operators(app: BrowserApp, owner: Person, suffix: string) {
  const otto = await signUp(app.http, `otto-${suffix}@get-it.test`, "Otto");
  const olga = await signUp(app.http, `olga-${suffix}@get-it.test`, "Olga");
  await join(owner, otto, "operator");
  await join(owner, olga, "operator");
  return { otto, olga };
}

/** Answer the intake and upload the bill set, as the customer does. */
async function provideInformation(page: Page) {
  await page.getByLabel("Your home currency").fill("USD");
  await page.locator('[data-input="homeCurrency"]').getByRole("button", { name: "Save" }).click();
  await page.getByTestId("value-homeCurrency").waitFor();
  await page.getByLabel("Your time zone").selectOption("America/New_York");
  await page.locator('[data-input="timeZone"]').getByRole("button", { name: "Save" }).click();
  await page.getByTestId("value-timeZone").waitFor();
  await page.getByLabel("Review date").fill("2026-11-10");
  await page.locator('[data-input="asOfDate"]').getByRole("button", { name: "Save" }).click();
  await page.getByTestId("value-asOfDate").waitFor();
  await page.getByLabel("Bill set file").setInputFiles({ name: "bills.json", mimeType: "application/json", buffer: BILLS });
  await page.getByText("bills.json: 11 bills received.").waitFor();
}

/** Operator steps over HTTP: fulfil, review, approve, publish. Returns the published package digest. */
async function fulfil(otto: Person, olga: Person, orderId: string) {
  await otto.mutation("orders:acceptForFulfillment", { orderId });
  const [snapshot] = await otto.query("imports:list", { orderId });
  return deliver(otto, olga, snapshot.id);
}
async function deliver(otto: Person, olga: Person, snapshotId: string) {
  const run = await otto.mutation("runs:reviewSnapshot", { snapshotId });
  const packet = await otto.mutation("review:request", { runId: run.runId });
  await olga.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest });
  await otto.mutation("delivery:publish", { packetId: packet.packetId });
  return packet.digest as string;
}

test("a customer describes the outcome, provides the inputs, accepts the quote, and receives and accepts the delivery in the browser", () =>
  withBrowserApp(async (app) => {
    const { page, responses } = await app.person();

    // 1–2. Visit, describe the outcome, register and verify (FeltKit's forms), name the organization.
    await page.goto(app.url);
    await page.getByRole("heading", { name: "What do you need done?" }).waitFor();
    await page.getByLabel("Describe what you need done").fill("Review our pending supplier bills before Friday's payment run.");
    await app.shot(page, "01-landing");
    await signUpInBrowser(app, page, "Ada Owner", "ada@acme.test", { goto: false });
    await createOrganizationInBrowser(page, "Acme");
    const { owner, tenantId } = await tenantOf(app, "ada@acme.test");
    const { otto, olga } = await operators(app, owner, "acme");

    // 3. The description typed before signing in is still there; the request is created on the server.
    await page.getByRole("heading", { name: "What do you need done?" }).waitFor();
    assert.equal(await page.getByLabel("Describe what you need done").inputValue(), "Review our pending supplier bills before Friday's payment run.");
    await app.shot(page, "02-home");
    await page.getByRole("button", { name: "Send my request" }).click();
    // The request, in the customer's words; our bill-review service is offered, not chosen for them.
    await page.getByTestId("original-request").filter({ hasText: "Review our pending supplier bills before Friday's payment run." }).waitFor();
    await page.getByRole("heading", { name: "Our service: Bill review and payable preparation" }).waitFor();
    await app.shot(page, "02b-service-offered");
    await page.getByRole("button", { name: "Yes, continue with this service" }).click();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting your information" }).waitFor();
    const sessionId = await sessionOf(app, page.url().split("#/tasks/")[1]!);

    // 4–5. Information: required and optional items, why each is needed, and the bill set.
    const missing = page.getByTestId("missing");
    assert.match(await missing.innerText(), /Still needed: Your home currency, Your time zone, Review date, Supplier bills awaiting approval, Vendor records, Chart of accounts \(expense categories\)\./);
    await app.shot(page, "03-intake-empty");
    await provideInformation(page);
    assert.match(await missing.innerText(), /Everything required has been received/);
    await app.shot(page, "04-intake-provided");

    // 6. Complete intake.
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    await page.getByTestId("request-status").filter({ hasText: "Preparing your quote" }).waitFor();

    // 7. The proposed service, in four parts, before any price.
    for (const h of ["1. What you provide", "2. What Boundry will do", "3. What you receive", "4. How completion and acceptance are determined", "Timing", "Assumptions", "Not included"]) {
      await page.getByRole("heading", { name: h }).waitFor();
    }
    assert.match(await page.getByTestId("assumptions").innerText(), /Receipt or invoice required above: not answered, so the contract default applies \(75\.00 in your home currency\)\./);
    assert.doesNotMatch(await page.locator("main").innerText(), /policy\.|foreign_currency_review|minor units|get-it\.bill-set/, "no contract identifiers shown to the customer");
    await app.shot(page, "05-proposed-service");

    // 8. The operator quotes; the page shows it live; the customer accepts the exact quote.
    const quote = await otto.mutation("quotes:create", { sessionId });
    await page.getByTestId("quote-total").filter({ hasText: "250.00 USD" }).waitFor();
    assert.equal(await page.getByTestId("quote-reference").innerText(), `${quote.quoteDigest.slice(7, 19)}…`);
    await page.getByTestId("request-status").filter({ hasText: "Awaiting quote acceptance" }).waitFor();
    await app.shot(page, "06-quote");
    await page.getByRole("button", { name: "Accept quote for 250.00 USD" }).click();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting payment" }).waitFor();
    assert.match(await page.getByTestId("payment-state").innerText(), /Awaiting payment of 250\.00 USD/);
    await page.getByText("Development build: no card is charged").waitFor();
    await app.shot(page, "07-awaiting-payment");
    const orderId = (await owner.query("orders:list"))[0].id as string;

    // 9. Development payment, recorded by the operator; the page shows it as recorded, not provider-processed.
    await otto.mutation("payments:record", { quoteId: quote.quoteId, amountMinor: quote.priceMinor, currency: "USD", method: "bank_transfer", reference: "wire-1", idempotencyKey: "acme-1" });
    await page.getByTestId("request-status").filter({ hasText: "Payment recorded" }).waitFor();
    assert.match(await page.getByTestId("payment-state").innerText(), /not a payment-provider transaction/);

    // 10. Fulfillment status, driven by persisted facts only.
    await otto.mutation("orders:acceptForFulfillment", { orderId });
    await page.getByTestId("request-status").filter({ hasText: "Awaiting fulfillment" }).waitFor();
    await page.getByTestId("due").filter({ hasNotText: "—" }).waitFor();
    // The deadline is the end of a business day in the customer's time zone, shown in that zone.
    assert.match(await page.getByTestId("due").innerText(), /11:59\sPM EST$/);
    await app.shot(page, "08-awaiting-fulfillment");
    const [snapshot] = await otto.query("imports:list", { orderId });
    const run = await otto.mutation("runs:reviewSnapshot", { snapshotId: snapshot.id });
    await page.getByTestId("request-status").filter({ hasText: "In progress" }).waitFor();
    const packet = await otto.mutation("review:request", { runId: run.runId });
    await page.getByTestId("request-status").filter({ hasText: "Awaiting review" }).waitFor();
    await olga.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest });
    await otto.mutation("delivery:publish", { packetId: packet.packetId });

    // 11. The published delivery.
    await page.getByTestId("request-status").filter({ hasText: "Delivered" }).waitFor();
    await page.getByRole("heading", { name: "Your delivery" }).waitFor();
    assert.equal(await page.getByTestId("package-reference").innerText(), `${packet.digest.slice(7, 19)}…`);
    assert.match(await page.getByTestId("result-summary").innerText(), /Bills reviewed\s+11/);
    await app.shot(page, "09-delivered");

    // 12. Download a permitted deliverable; it is byte-for-byte the file the approval packet lists.
    const packetDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download approval-packet.json" }).click();
    const packetText = (await downloaded(await packetDownload)).toString("utf8");
    assert.equal(digest(JSON.parse(packetText)), packet.digest);
    const listed = new Map((JSON.parse(packetText).files as Array<{ name: string; sha256: string }>).map((f) => [f.name, f.sha256]));
    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download payable-recommendation.csv" }).click();
    const file = await csv;
    assert.equal(file.suggestedFilename(), "payable-recommendation.csv");
    assert.equal(sha256(await downloaded(file)), listed.get("payable-recommendation.csv"));

    // 13. Accept the exact delivered digest.
    const accepting = page.waitForRequest((r) => decodeURIComponent(r.url()).endsWith("/api/mutation/delivery:accept"));
    await page.getByRole("button", { name: "Accept this delivery" }).click();
    assert.equal((await accepting).postDataJSON().args.packetDigest, packet.digest, "the browser sends the delivered digest");
    await page.getByTestId("accepted").waitFor();
    await page.getByTestId("request-status").filter({ hasText: "Accepted" }).waitFor();
    await app.shot(page, "10-accepted");

    // The browser used FeltKit's cookie session and CSRF tokens; no bearer token and no business state in storage.
    const calls = responses.filter((r) => r.url().includes("/api/mutation/"));
    assert.ok(calls.length >= 8);
    for (const r of calls) {
      const h = r.request().headers();
      assert.equal(h.authorization, undefined, `${r.url()} carried a bearer token`);
      assert.equal(h["x-feltkit-session"], "cookie");
      assert.ok(h["x-feltkit-csrf"], `${r.url()} carried no CSRF token`);
    }
    const cookies = await page.context().cookies();
    assert.ok(cookies.some((c) => c.httpOnly), "an HttpOnly session cookie");
    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
    assert.equal((await stored(app.http, "acceptances")).length, 1);
    assert.equal(tenantId.length > 0, true);
  }));

test("a customer requests a correction in the browser, then accepts the corrected delivery", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person();
    await signUpInBrowser(app, page, "Cora Owner", "cora@initech.test");
    await createOrganizationInBrowser(page, "Initech");
    const { owner } = await tenantOf(app, "cora@initech.test");
    const { otto, olga } = await operators(app, owner, "initech");
    await page.getByLabel("Describe what you need done").fill("Check this week's bills.");
    await page.getByRole("button", { name: "Send my request" }).click();
    await page.getByRole("button", { name: "Yes, continue with this service" }).click();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting your information" }).waitFor();
    const sessionId = await sessionOf(app, page.url().split("#/tasks/")[1]!);
    await provideInformation(page);
    await page.getByRole("button", { name: "Finish and request a quote" }).click();
    const quote = await otto.mutation("quotes:create", { sessionId });
    await page.getByRole("button", { name: "Accept quote for 250.00 USD" }).click();
    await page.getByTestId("request-status").filter({ hasText: "Awaiting payment" }).waitFor();
    const orderId = (await owner.query("orders:list"))[0].id as string;
    await otto.mutation("payments:record", { quoteId: quote.quoteId, amountMinor: quote.priceMinor, currency: "USD", method: "check", reference: "chk-9", idempotencyKey: "initech-1" });
    const first = await fulfil(otto, olga, orderId);
    await page.getByTestId("request-status").filter({ hasText: "Delivered" }).waitFor();

    // The correction names the exact delivered package; the delivery itself is unchanged.
    await page.getByLabel("What should be corrected?").fill("Bill B3's total was mistyped; the corrected bill set follows.");
    const correcting = page.waitForRequest((r) => decodeURIComponent(r.url()).endsWith("/api/mutation/delivery:requestCorrection"));
    await page.getByRole("button", { name: "Request a correction" }).click();
    assert.equal((await correcting).postDataJSON().args.packetDigest, first);
    await page.getByTestId("correction-requested").waitFor();
    await page.getByTestId("request-status").filter({ hasText: "Correction requested" }).waitFor();
    await app.shot(page, "11-correction-requested");
    const [correction] = await stored(app.http, "corrections");
    assert.equal(correction!.packetDigest, first);

    // The corrected package: re-imported, re-reviewed, approved by another person, published.
    const set = billSet();
    const reimport = await otto.mutation("imports:record", { orderId, billSet: { ...set, bills: set.bills.map((b) => (b.id === "B3" ? { ...b, totalMinor: 7500 } : b)) } });
    const second = await deliver(otto, olga, reimport.snapshotId);
    assert.notEqual(second, first);
    await page.getByTestId("package-reference").filter({ hasText: second.slice(7, 19) }).waitFor();
    await page.getByTestId("request-status").filter({ hasText: "Delivered" }).waitFor();
    await app.shot(page, "12-corrected-delivery");
    const accepting = page.waitForRequest((r) => decodeURIComponent(r.url()).endsWith("/api/mutation/delivery:accept"));
    await page.getByRole("button", { name: "Accept this delivery" }).click();
    assert.equal((await accepting).postDataJSON().args.packetDigest, second, "the corrected digest, not the first");
    await page.getByTestId("accepted").waitFor();
    await page.getByTestId("request-status").filter({ hasText: "Accepted" }).waitFor();
    assert.equal((await stored(app.http, "acceptances")).length, 1);
  }));
