/**
 * General task requests in a real browser against the running server and its production build:
 * any task, in the customer's words, kept exactly; listed before any quote; details, files and
 * links; the actual scoping state set by a person; and no false promise of what can be bought.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { join, signIn, signUp, PASSWORD, type Person } from "./_http.js";
import { assertFitsWidth, createOrganizationInBrowser, signUpInBrowser, withBrowserApp, type BrowserApp } from "./_browser.js";

const WEBSITE = "Build me a website for my bakery.\nThree pages; I have photos of the shop.";

async function customerWithOperator(app: BrowserApp, page: Page, email: string, org: string) {
  await signUpInBrowser(app, page, "Bea Baker", email);
  await createOrganizationInBrowser(page, org);
  const owner = await signIn(app.http, email);
  const r = await app.http.request("GET", "/api/tenants", undefined, owner.token);
  await owner.switchTo(r.body.tenants[0].id);
  const otto = await signUp(app.http, `otto-${org.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@get-it.test`, "Otto");
  await join(owner, otto, "operator");
  return { owner, otto };
}

async function send(page: Page, text: string) {
  await page.getByLabel("Describe what you need done").fill(text);
  await page.getByRole("button", { name: "Send my request" }).click();
  await page.getByTestId("original-request").waitFor();
  return page.url().split("#/tasks/")[1]!;
}

/** Nothing on the page offers to buy or start a service. */
async function assertNothingPurchasable(page: Page) {
  for (const name of [/Accept quote/, /Yes, continue with this service/]) assert.equal(await page.getByRole("button", { name }).count(), 0, `no ${name} button`);
  assert.equal(await page.getByTestId("quote-total").count(), 0, "no quote shown");
  assert.equal(await page.getByRole("heading", { name: /Your quote/ }).count(), 0, "no quote shown");
}

test("an arbitrary task: submitted in the customer's words, listed unquoted, given details and files, and scoped honestly by a person", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person();

    // The landing page is task-first: the question, examples, no category, and an honest note on what can be completed today.
    await page.goto(app.url);
    await page.getByRole("heading", { name: "What do you need done?" }).waitFor();
    const examples = await page.getByRole("list", { name: "Examples" }).innerText();
    for (const e of ["Build me a website.", "Find someone to repair my deck.", "Clean up my customer database."]) assert.ok(examples.includes(e), e);
    assert.equal(await page.getByRole("combobox").count(), 0, "no category to choose");
    const lede = await page.locator(".hero .lede").innerText();
    assert.doesNotMatch(lede, /bill|invoice/i, "the business is not introduced as bill review");
    await app.shot(page, "40-task-landing");

    const { otto } = await customerWithOperator(app, page, "bea@bakery.test", "Bea's Bakery");
    const requestId = await send(page, WEBSITE);

    // Exactly as written, submitted, and nothing to buy.
    assert.equal(await page.getByTestId("original-request").innerText(), WEBSITE);
    assert.equal(await page.getByTestId("task-status").innerText(), "Submitted");
    await page.getByText("A person on our team reviews every request").waitFor();
    await assertNothingPurchasable(page);
    await app.shot(page, "41-task-submitted");

    // Refresh and navigation keep it; the list shows it without any quote or order.
    await page.reload();
    assert.equal(await page.getByTestId("original-request").innerText(), WEBSITE);
    await page.getByRole("link", { name: "Your requests" }).click();
    const row = page.getByRole("link", { name: /Build me a website for my bakery\./ });
    await row.waitFor();
    assert.match(await row.innerText(), /Submitted/);
    assert.doesNotMatch(await row.innerText(), /USD/);
    await row.click();

    // Details: a deadline, a budget, a requirement.
    await page.getByLabel("Kind of detail").selectOption("deadline");
    await page.getByLabel("Detail", { exact: true }).fill("2026-12-15");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Kind of detail").selectOption("budget");
    await page.getByLabel("Detail", { exact: true }).fill("1500");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Kind of detail").selectOption("constraint");
    await page.getByLabel("Detail", { exact: true }).fill("Must work well on phones.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const details = page.getByTestId("details");
    await details.getByText("Must work well on phones.").waitFor();
    assert.match(await details.innerText(), /Budget\s+1500\.00 USD/);
    assert.match(await details.innerText(), /Wanted by\s+Dec 15, 2026/);

    // A file, through FeltKit's file service, and a link.
    await page.getByLabel("Attach a file").setInputFiles({ name: "storefront.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpeg bytes, for the test") });
    await page.getByTestId("resources").getByText("storefront.jpg").waitFor();
    await page.getByLabel("Link name").fill("Our current menu");
    await page.getByLabel("Link address").fill("https://example.com/menu");
    await page.getByRole("button", { name: "Add link" }).click();
    await page.getByTestId("resources").getByRole("link", { name: "Our current menu" }).waitFor();
    assert.match(await page.getByTestId("resources").innerText(), /storefront\.jpg\s+24 bytes · received/);
    await app.shot(page, "42-task-details-and-files");

    // A person scopes it: what is needed to quote, to do the work, and what the customer can provide.
    await otto.mutation("tasks:assess", {
      requestId,
      outcome: "more_information_required",
      reasons: ["We need to know the pages and the domain before we can say whether we can do this."],
      questions: [
        { id: "pages", text: "Which pages do you need?", purpose: "quote" },
        { id: "domain", text: "Do you already own a domain name?", purpose: "execute" },
        { id: "photos", text: "The shop photos you want used.", purpose: "resource" },
      ],
    });
    await page.getByTestId("task-status").filter({ hasText: "More information needed" }).waitFor();
    for (const h of ["Needed to give you a price", "Needed to do the work", "Things you can provide"]) await page.getByRole("heading", { name: h }).waitFor();
    await app.shot(page, "43-task-questions");
    await page.getByLabel("Which pages do you need?").fill("Home, menu and contact.");
    await page.locator('[data-question="pages"]').getByRole("button", { name: "Save" }).click();
    await page.getByTestId("task-status").filter({ hasText: "Under review" }).waitFor();

    // The honest answer: not something we can do yet. Still nothing to buy.
    await otto.mutation("tasks:assess", { requestId, outcome: "not_currently_fulfillable", reasons: ["We don't build websites yet."] });
    await page.getByTestId("task-status").filter({ hasText: "Not something we can do right now" }).waitFor();
    await page.getByText("We don't build websites yet.").waitFor();
    await assertNothingPurchasable(page);
    assert.equal(await page.getByTestId("original-request").innerText(), WEBSITE, "still exactly as written");
    await app.shot(page, "44-task-not-fulfillable");

    // No internal identifiers on any of it.
    assert.doesNotMatch(await page.locator("body").innerText(), /svc_|taskRequests|tasks:|fulfillment_path|requires_manual_review|otto/);
  }));

test("a task that needs an outside professional says so, and promises nothing", () =>
  withBrowserApp(async (app) => {
    const { page } = await app.person({ mobile: true });
    const { otto } = await customerWithOperator(app, page, "dee@deck.test", "Dee's House");
    const requestId = await send(page, "Find someone who can repair my deck.");
    await assertNothingPurchasable(page);
    await otto.mutation("tasks:assess", { requestId, outcome: "requires_external_provider", reasons: ["Deck repair is onsite work by a licensed carpenter."], arrangements: ["A licensed carpenter, if we can find one in your area."] });
    await page.getByTestId("task-status").filter({ hasText: "Needs an outside professional" }).waitFor();
    await page.getByText("Nobody has been arranged yet").waitFor();
    await page.getByRole("heading", { name: "What we would arrange" }).waitFor();
    await assertNothingPurchasable(page);
    await assertFitsWidth(page, "task needing a professional (phone)");
    await app.shot(page, "45-task-external-provider-mobile");
  }));

test("a second organization can neither read nor change a task, and a signed-out visitor sees nothing", () =>
  withBrowserApp(async (app) => {
    const { page: acme } = await app.person();
    await customerWithOperator(app, acme, "ada@acme.test", "Acme");
    const requestId = await send(acme, "Clean up our confidential customer database.");

    const { page } = await app.person();
    await customerWithOperator(app, page, "gus@globex.test", "Globex");
    await page.goto(`${app.url}/#/tasks/${requestId}`);
    await page.getByRole("heading", { name: "Request not found" }).waitFor();
    // Forged writes from Globex's own browser session are refused by the server.
    for (const [name, args] of [
      ["tasks:addDetail", { requestId, kind: "note", value: "x" }],
      ["tasks:attach", { requestId, link: { name: "x", url: "https://example.com" } }],
      ["tasks:respondToService", { requestId, accept: true }],
    ] as const) {
      const r = await page.evaluate(async ([fn, a]) => {
        const s = await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json();
        const res = await fetch(`/api/mutation/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": s.csrf ?? "" }, body: JSON.stringify({ args: a }) });
        return { status: res.status, body: await res.json() };
      }, [name, args] as const);
      assert.equal(r.body.error?.code, "NOT_FOUND", `${name}: ${JSON.stringify(r.body)}`);
    }
    // A cross-site style request without the CSRF token is refused too.
    const noCsrf = await page.evaluate(async (id) => (await fetch("/api/mutation/tasks:addDetail", { method: "POST", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie" }, body: JSON.stringify({ args: { requestId: id, kind: "note", value: "x" } }) })).status, requestId);
    assert.equal(noCsrf, 403);

    // Signing out: the request is gone from view; signing back in: it is all still there, from the server.
    await acme.getByRole("button", { name: "Sign out" }).click();
    await acme.getByRole("heading", { name: "What do you need done?" }).waitFor();
    await acme.goto(`${app.url}/#/tasks/${requestId}`);
    assert.doesNotMatch(await acme.locator("body").innerText(), /confidential customer database/);
    await app.shot(acme, "46-signed-out");
    await acme.getByRole("tab", { name: "Sign in" }).or(acme.getByRole("button", { name: "Sign in" })).first().click();
    await acme.getByLabel("E-mail").fill("ada@acme.test");
    await acme.getByLabel("Password").fill(PASSWORD);
    await acme.locator("form").getByRole("button", { name: "Sign in" }).click();
    await acme.getByTestId("original-request").filter({ hasText: "Clean up our confidential customer database." }).waitFor();
  }));

export type { Person };
