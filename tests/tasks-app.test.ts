/**
 * Task requests on a real FeltKit runtime: arbitrary tasks submitted and kept exactly as written,
 * listed without any quote or order, details and files (FeltKit's file service), honest assessment
 * by a person, tenant isolation, and the one supported service continuing in its existing
 * transaction only when the customer accepts it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { billSet } from "./_bills.js";
import { ANSWERS, newOrg, raw, rejectsWith, withApp } from "./_harness.js";

const WEBSITE = "  Build me a website for my bakery.\nThree pages; I have photos.  ";

test("any task can be submitted, is kept exactly as written, and is listed without a quote or an order", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const tasks = ["Research these five competitors.", WEBSITE, "Find someone who can repair my deck.", "Billing system migration"];
    const ids = [];
    for (const text of tasks) ids.push((await org.member.mutation(api.tasks.create, { text })).requestId);
    await rejectsWith(org.member.mutation(api.tasks.create, { text: "   " }), "INVALID_ARGUMENT");

    const listed = await org.owner.query(api.tasks.list, {});
    assert.deepEqual(listed.map((x) => x.text).sort(), [...tasks].sort());
    assert.ok(listed.every((x) => x.outcome === "ready_to_scope" && x.transaction === null && x.offer === null), "submitted, not offered, not quoted");
    assert.equal((await org.owner.query(api.tasks.get, { requestId: ids[1]! }))!.text, WEBSITE, "byte for byte, whitespace included");
    for (const name of ["quotes", "orders", "intakeSessions", "taskAssessments"]) assert.equal((await raw(t, name).find({})).length, 0, name);
    const [stored] = await raw(t, "taskRequests").find({ id: ids[1] } as never);
    assert.equal(stored!.text, WEBSITE);
    assert.equal(stored!.tenantId, org.id);
  }));

test("details and files: validated, append-only, files held by FeltKit's organization-scoped file service", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { requestId } = await org.member.mutation(api.tasks.create, { text: WEBSITE });
    await org.member.mutation(api.tasks.addDetail, { requestId, kind: "deadline", value: "2026-12-15" });
    await org.member.mutation(api.tasks.addDetail, { requestId, kind: "budget", value: { amountMinor: 150_000, currency: "USD" } });
    await org.owner.mutation(api.tasks.addDetail, { requestId, kind: "constraint", value: "Must work on phones." });
    await rejectsWith(org.member.mutation(api.tasks.addDetail, { requestId, kind: "deadline", value: "soon" }), "INVALID_ARGUMENT", "DETAIL_INVALID");
    await rejectsWith(org.member.mutation(api.tasks.addDetail, { requestId, kind: "answer", value: "5", questionId: "pages" }), "INVALID_ARGUMENT", "UNKNOWN_QUESTION");
    const photo = Buffer.from("not really a jpeg");
    await org.member.mutation(api.tasks.attach, { requestId, file: { name: "storefront.jpg", contentType: "image/jpeg", contentBase64: photo.toString("base64") } });
    await org.member.mutation(api.tasks.attach, { requestId, link: { name: "Current menu", url: "https://example.com/menu" } });
    await rejectsWith(org.member.mutation(api.tasks.attach, { requestId, link: { name: "x", url: "javascript:alert(1)" } }), "INVALID_ARGUMENT", "LINK_INVALID");
    await rejectsWith(org.member.mutation(api.tasks.attach, { requestId, file: { name: "empty.txt", contentBase64: "" } }), "INVALID_ARGUMENT", "FILE_EMPTY");

    const task = (await org.owner.query(api.tasks.get, { requestId }))!;
    assert.deepEqual(task.details.map((d) => [d.kind, d.value]), [["deadline", "2026-12-15"], ["budget", { amountMinor: 150_000, currency: "USD" }], ["constraint", "Must work on phones."]]);
    assert.deepEqual(task.resources.map((r) => [r.kind, r.name, r.size]), [["file", "storefront.jpg", photo.length], ["link", "Current menu", null]]);
    // The bytes are in FeltKit's file service, organization-scoped.
    const [resource] = await raw(t, "taskResources").find({ kind: "file" });
    const files = await raw(t, "files").find({});
    assert.ok(files.some((f) => f.id === resource!.fileId), "the file record is FeltKit's");
    assert.equal(task.text, WEBSITE, "the original description is unchanged by everything added");
  }));

test("a person assesses honestly; questions needed to quote stay open until answered; nothing becomes purchasable", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { requestId } = await org.member.mutation(api.tasks.create, { text: WEBSITE });
    const assess = (caller: typeof org.operator, args: Record<string, unknown>) => caller.mutation(api.tasks.assess, { requestId, reasons: ["Reviewed."], ...args } as never);

    // Only operators assess, and only people.
    await rejectsWith(assess(org.owner, { outcome: "requires_manual_review" }), "FORBIDDEN");
    await rejectsWith(assess(org.agent, { outcome: "requires_manual_review" }), "FORBIDDEN", "NOT_A_PERSON");
    // A fulfillment path must be a real service; more information must say what.
    await rejectsWith(assess(org.operator, { outcome: "fulfillment_path_identified", service: "website-builder@1" }), "INVALID_ARGUMENT", "UNKNOWN_SERVICE");
    await rejectsWith(assess(org.operator, { outcome: "more_information_required" }), "INVALID_ARGUMENT", "QUESTIONS_REQUIRED");

    await assess(org.operator, {
      outcome: "more_information_required",
      questions: [
        { id: "pages", text: "Which pages do you need?", purpose: "quote" },
        { id: "domain", text: "Do you own a domain?", purpose: "execute" },
        { id: "photos", text: "Upload the photos you want used.", purpose: "resource" },
      ],
      arrangements: ["Hosting, if you do not have it."],
    });
    let task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.deepEqual([task.state.outcome, task.state.openQuoteQuestions.map((q) => q.id)], ["more_information_required", ["pages"]]);
    assert.ok(!JSON.stringify(task).includes("otto"), "the assessment reaches the customer without who made it");
    await org.member.mutation(api.tasks.addDetail, { requestId, kind: "answer", questionId: "pages", value: "Home, menu, contact." });
    task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.equal(task.state.outcome, "requires_manual_review", "answered: back to a person, not ready to quote");

    await assess(org.operator, { outcome: "not_currently_fulfillable", reasons: ["We do not build websites yet."] });
    task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.deepEqual([task.state.outcome, task.assessment!.reasons, task.offer], ["not_currently_fulfillable", ["We do not build websites yet."], null]);
    // Nothing offered: it cannot enter a service, so it cannot be quoted or bought.
    await rejectsWith(org.owner.mutation(api.tasks.respondToService, { requestId, accept: true }), "FAILED_PRECONDITION", "NO_OFFER");
    for (const name of ["intakeSessions", "quotes", "orders"]) assert.equal((await raw(t, name).find({})).length, 0, name);
  }));

test("another organization cannot read, list, detail, attach to, assess or respond to a task", () =>
  withApp(async (t) => {
    const acme = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const globex = await newOrg(t, "Globex", { owner: "gus", member: "gia" });
    const { requestId } = await acme.member.mutation(api.tasks.create, { text: "Acme's confidential task." });
    assert.equal(await globex.owner.query(api.tasks.get, { requestId }), null);
    assert.deepEqual(await globex.owner.query(api.tasks.list, {}), []);
    await rejectsWith(globex.owner.mutation(api.tasks.addDetail, { requestId, kind: "note", value: "x" }), "NOT_FOUND");
    await rejectsWith(globex.owner.mutation(api.tasks.attach, { requestId, link: { name: "x", url: "https://example.com" } }), "NOT_FOUND");
    await rejectsWith(globex.operator.mutation(api.tasks.assess, { requestId, outcome: "requires_manual_review", reasons: ["x"] }), "NOT_FOUND");
    await rejectsWith(globex.owner.mutation(api.tasks.respondToService, { requestId, accept: true }), "NOT_FOUND");
    for (const name of ["taskDetails", "taskResources", "taskAssessments", "taskServiceChoices"]) assert.equal((await raw(t, name).find({})).length, 0, name);
  }));

test("a supported request continues in the existing bill-review transaction only when the customer accepts it", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    // A description naming the service's subject offers it; it does not choose it.
    const { requestId } = await org.member.mutation(api.tasks.create, { text: "Review our supplier bills before Friday's payment run." });
    let task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.deepEqual([task.state.outcome, task.offer], ["ready_to_scope", { title: "Bill review and payable preparation", basis: "suggestion" }]);
    assert.equal((await raw(t, "intakeSessions").find({})).length, 0, "nothing chosen yet");

    const accepted = await org.member.mutation(api.tasks.respondToService, { requestId, accept: true });
    const again = await org.member.mutation(api.tasks.respondToService, { requestId, accept: true });
    assert.deepEqual([accepted.status, again.status, again.sessionId], ["accepted", "existing", accepted.sessionId]);
    const [choice] = await raw(t, "taskServiceChoices").find({});
    assert.deepEqual([choice!.choice, choice!.basis, choice!.sessionId], ["accepted", "suggestion", accepted.sessionId]);
    task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.equal(task.state.outcome, "fulfillment_path_identified");

    // The existing intake, quote, acceptance, payment and fulfillment, unchanged.
    const sessionId = accepted.sessionId!;
    for (const [field, value] of Object.entries(ANSWERS)) await org.owner.mutation(api.intake.answer, { sessionId, field, value });
    await org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: billSet() });
    await org.owner.mutation(api.intake.complete, { sessionId });
    assert.equal((await org.member.query(api.tasks.get, { requestId }))!.state.outcome, "ready_to_quote");
    const q = await org.operator.mutation(api.quotes.create, { sessionId });
    const { orderId } = await org.owner.mutation(api.quotes.accept, { quoteId: q.quoteId, quoteDigest: q.quoteDigest });
    await org.operator.mutation(api.payments.record, { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "check", reference: "c-1", idempotencyKey: "k-1" });
    await org.operator.mutation(api.orders.acceptForFulfillment, { orderId });
    const listed = (await org.member.query(api.tasks.list, {}))[0]!;
    assert.deepEqual(listed.transaction, { sessionId, intakeComplete: true, quote: { priceMinor: 25_000, currency: "USD" }, orderStatus: "accepted_for_fulfillment" });
    // The intake started from the customer's words, exactly.
    const [request] = await raw(t, "outcomeRequests").find({});
    assert.equal(request!.text, "Review our supplier bills before Friday's payment run.");
    assert.deepEqual((await org.operator.query(api.integrity.check, {})).problems, []);
  }));

test("declining an offered service sends the task to a person, and only a new assessment offers it again", () =>
  withApp(async (t) => {
    const org = await newOrg(t, "Acme", { owner: "ada", member: "amy" });
    const { requestId } = await org.member.mutation(api.tasks.create, { text: "I need these invoices organized." });
    assert.equal((await org.member.query(api.tasks.get, { requestId }))!.offer?.basis, "suggestion");
    await org.member.mutation(api.tasks.respondToService, { requestId, accept: false });
    let task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.deepEqual([task.offer, task.state.outcome], [null, "ready_to_scope"]);
    await rejectsWith(org.member.mutation(api.tasks.respondToService, { requestId, accept: true }), "FAILED_PRECONDITION", "NO_OFFER");

    // "Billing system migration" is not offered the service at all: no whole-word match.
    const other = await org.member.mutation(api.tasks.create, { text: "Billing system migration" });
    assert.equal((await org.member.query(api.tasks.get, { requestId: other.requestId }))!.offer, null);

    // An operator identifies the path; the customer can now accept it.
    await org.operator.mutation(api.tasks.assess, { requestId, outcome: "fulfillment_path_identified", service: "svc_bill_review_payable_prep@1.0.0", reasons: ["These are supplier invoices awaiting approval."] });
    task = (await org.member.query(api.tasks.get, { requestId }))!;
    assert.deepEqual([task.offer?.basis, task.state.outcome, task.assessment?.service], ["assessment", "fulfillment_path_identified", "Bill review and payable preparation"]);
    assert.equal((await org.member.mutation(api.tasks.respondToService, { requestId, accept: true })).status, "accepted");
    assert.equal((await raw(t, "intakeSessions").find({})).length, 1);
  }));
