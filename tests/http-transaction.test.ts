/**
 * The customer transaction, end to end, through get-it's running FeltKit server over HTTP, with real
 * accounts and server-issued sessions. Nothing here calls a get-it function in-process.
 *
 * Identities:
 * - Acme: owner Ada and member Amy (customers); operator Otto (fulfils); operator Olga (reviews and
 *   approves Otto's work: a person other than the requester).
 * - Globex: owner Gus and operator Bea ("Operator B"), who has no membership in Acme.
 * - Nora: a signed-up, verified person who belongs to no organization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/canonical.js";
import { loadFrozenContract } from "../src/contract.js";
import { sha256Hex } from "../src/deliverables.js";
import { runPriceMinor } from "../src/pricing.js";
import { billSet } from "./_bills.js";
import { createOrganization, join, refused, signUp, stored, withServer, type Http, type Person } from "./_http.js";

const contract = loadFrozenContract();
const PACKET = "approval-packet.json";

interface World {
  http: Http;
  acme: string;
  globex: string;
  ada: Person; // Acme owner
  amy: Person; // Acme member
  otto: Person; // Acme operator A
  olga: Person; // Acme operator (reviewer)
  gus: Person; // Globex owner
  bea: Person; // Operator B: Globex only
  nora: Person; // no organization
}

async function world(http: Http): Promise<World> {
  const [ada, amy, otto, olga, gus, bea, nora] = await Promise.all(
    [
      ["ada@acme.test", "Ada"],
      ["amy@acme.test", "Amy"],
      ["otto@get-it.test", "Otto"],
      ["olga@get-it.test", "Olga"],
      ["gus@globex.test", "Gus"],
      ["bea@get-it.test", "Bea"],
      ["nora@elsewhere.test", "Nora"],
    ].map(([email, name]) => signUp(http, email!, name!)),
  );
  const acme = await createOrganization(ada!, "Acme");
  await join(ada!, amy!, "member");
  await join(ada!, otto!, "operator");
  await join(ada!, olga!, "operator");
  const globex = await createOrganization(gus!, "Globex");
  await join(gus!, bea!, "operator");
  return { http, acme, globex, ada: ada!, amy: amy!, otto: otto!, olga: olga!, gus: gus!, bea: bea!, nora: nora! };
}

/** Intake by the customer, over HTTP. */
async function intake(w: World) {
  const { sessionId } = await w.ada.mutation("intake:create", { request: "Review our pending supplier bills before Friday's payment run." });
  await w.amy.mutation("intake:answer", { sessionId, field: "homeCurrency", value: "USD" });
  await w.amy.mutation("intake:answer", { sessionId, field: "timeZone", value: "America/New_York" });
  await w.amy.mutation("intake:answer", { sessionId, field: "asOfDate", value: "2026-11-10" });
  await w.amy.mutation("intake:uploadBillSet", { sessionId, billSet: billSet() });
  await w.ada.mutation("intake:complete", { sessionId });
  return sessionId as string;
}

/** Everything a customer can read about their order, over HTTP. */
async function customerReads(w: World, who: Person, ids: { sessionId: string; quoteId: string; orderId: string; deliveryId: string }) {
  const files: Record<string, unknown> = {};
  const view = await who.query("delivery:view", { orderId: ids.orderId });
  for (const f of view.delivery.files) files[f.name] = await who.query("delivery:download", { deliveryId: ids.deliveryId, name: f.name });
  return {
    intake: await who.query("intake:get", { sessionId: ids.sessionId }),
    quote: await who.query("quotes:get", { id: ids.quoteId }),
    orders: await who.query("orders:list"),
    order: await who.query("orders:get", { id: ids.orderId }),
    clock: await who.query("orders:clock", { id: ids.orderId }),
    view,
    delivery: await who.query("delivery:get", { id: ids.deliveryId }),
    files,
  };
}

test("a customer buys the outcome and receives, corrects and accepts the deliverable, entirely over HTTP", () =>
  withServer(async (http) => {
    const w = await world(http);

    // 1–4. Outcome request, answers, bill set, completion: by the customer.
    const sessionId = await intake(w);
    const view0 = await w.ada.query("intake:get", { sessionId });
    assert.equal(view0.completeness.status, "complete");
    assert.equal(view0.completeness.report.contractDigest, contract.digest);

    // 5. Quote: created by the operator, discovered and read by the customer through their intake.
    const created = await w.otto.mutation("quotes:create", { sessionId });
    assert.equal(created.priceMinor, runPriceMinor(11, contract.pricing));
    const offered = (await w.ada.query("intake:get", { sessionId })).quote;
    assert.deepEqual([offered.id, offered.digest, offered.priceMinor, offered.currency], [created.quoteId, created.quoteDigest, 25_000, "USD"]);
    const quote = await w.amy.query("quotes:get", { id: offered.id });
    assert.deepEqual([quote.billCount, quote.priceMinor, quote.digest, quote.contractDigest], [11, 25_000, offered.digest, contract.digest]);

    // 6. The owner accepts the exact quote; accepting again changes nothing.
    await refused(w.amy.mutation("quotes:accept", { quoteId: quote.id, quoteDigest: quote.digest }), "FORBIDDEN");
    const accepted = await w.ada.mutation("quotes:accept", { quoteId: quote.id, quoteDigest: quote.digest });
    const again = await w.ada.mutation("quotes:accept", { quoteId: quote.id, quoteDigest: quote.digest });
    assert.deepEqual([again.status, again.orderId], ["existing", accepted.orderId]);
    const orderId = accepted.orderId as string;

    // Payment precedes fulfillment.
    await refused(w.otto.mutation("orders:acceptForFulfillment", { orderId }), "FAILED_PRECONDITION", "NOT_PAID");

    // 7. Operator-recorded payment, once.
    const pay = { quoteId: quote.id, amountMinor: quote.priceMinor, currency: "USD", method: "bank_transfer", reference: "wire-20261110-01", idempotencyKey: "acme-q1-pay" };
    const paid = await w.otto.mutation("payments:record", pay);
    assert.equal((await w.otto.mutation("payments:record", pay)).paymentId, paid.paymentId);
    await refused(w.olga.mutation("payments:record", { ...pay, idempotencyKey: "acme-q1-pay-2" }), "CONFLICT", "ALREADY_PAID");
    assert.equal((await w.ada.query("orders:get", { id: orderId })).status, "paid");
    assert.equal((await w.ada.query("orders:clock", { id: orderId })).paused, true, "payment does not start the clock");

    // 8. Acceptance for fulfillment: the bill set is recorded for the order and the clock starts, together.
    const fulfilment = await w.otto.mutation("orders:acceptForFulfillment", { orderId });
    assert.equal((await w.otto.mutation("orders:acceptForFulfillment", { orderId })).status, "existing");
    const order = await w.ada.query("orders:get", { id: orderId });
    const [snapshot, ...more] = await w.otto.query("imports:list", { orderId });
    assert.equal(more.length, 0);
    assert.deepEqual([order.status, order.clockStartedAt, snapshot.importedAt], ["accepted_for_fulfillment", fulfilment.acceptedAt, fulfilment.acceptedAt]);
    assert.equal((await w.ada.query("orders:clock", { id: orderId })).paused, false);

    // 9. Work and review: Otto reviews and requests approval; Olga, another operator and a person, approves.
    const run = await w.otto.mutation("runs:reviewSnapshot", { snapshotId: snapshot.id });
    const packet = await w.otto.mutation("review:request", { runId: run.runId });
    await refused(w.otto.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest }), "FORBIDDEN", "SELF_APPROVAL");
    await refused(w.olga.mutation("review:approve", { packetId: packet.packetId, digest: digest({ forged: true }) }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    await refused(w.otto.mutation("delivery:publish", { packetId: packet.packetId }), "FAILED_PRECONDITION", "NOT_APPROVED");
    await w.olga.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest });

    // 10. Publish.
    await refused(w.ada.mutation("delivery:publish", { packetId: packet.packetId }), "FORBIDDEN");
    const published = await w.otto.mutation("delivery:publish", { packetId: packet.packetId });
    assert.equal(published.onTime, true);

    // 11. The customer views and downloads exactly the packet's files.
    const view = await w.amy.query("delivery:view", { orderId });
    assert.equal(view.delivery.packetDigest, packet.digest);
    assert.ok(Object.values(view.delivery.acceptanceCriteria).every((c) => c === "passed"));
    const packetFile = await w.amy.query("delivery:download", { deliveryId: published.deliveryId, name: PACKET });
    assert.equal(digest(JSON.parse(packetFile.content)), packet.digest);
    const listed = JSON.parse(packetFile.content).files as Array<{ name: string; sha256: string }>;
    assert.deepEqual(view.delivery.files.map((f: { name: string }) => f.name), [PACKET, ...listed.map((f) => f.name)].sort());
    for (const f of listed) {
      const file = await w.amy.query("delivery:download", { deliveryId: published.deliveryId, name: f.name });
      assert.equal(sha256Hex(file.content), f.sha256, f.name);
    }

    // 12. Correction, bound to the exact delivered digest; the delivery itself never changes.
    await refused(w.amy.mutation("delivery:requestCorrection", { deliveryId: published.deliveryId, packetDigest: packet.digest, reason: "B3" }), "FORBIDDEN");
    await refused(w.ada.mutation("delivery:requestCorrection", { deliveryId: published.deliveryId, packetDigest: digest({ other: 1 }), reason: "B3" }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    const deliveryBefore = await w.ada.query("delivery:get", { id: published.deliveryId });
    await w.ada.mutation("delivery:requestCorrection", { deliveryId: published.deliveryId, packetDigest: packet.digest, reason: "B3's total was mistyped; the corrected bill is attached." });
    const corrected = await w.ada.query("delivery:get", { id: published.deliveryId });
    assert.deepEqual(corrected.delivery, deliveryBefore.delivery, "the delivery record is unchanged");
    assert.equal(corrected.correction.packetDigest, packet.digest, "the correction names the delivered digest");
    await refused(w.ada.mutation("delivery:accept", { deliveryId: published.deliveryId, packetDigest: packet.digest, scope: "full" }), "FAILED_PRECONDITION", "CORRECTION_REQUESTED");

    // The corrected package: re-import, re-review, a new approval, a new delivery.
    const set = billSet();
    const fixed = { ...set, bills: set.bills.map((b) => (b.id === "B3" ? { ...b, totalMinor: 7500 } : b)) };
    const reimport = await w.otto.mutation("imports:record", { orderId, billSet: fixed });
    const run2 = await w.otto.mutation("runs:reviewSnapshot", { snapshotId: reimport.snapshotId });
    const packet2 = await w.otto.mutation("review:request", { runId: run2.runId });
    assert.notEqual(packet2.digest, packet.digest);
    await w.olga.mutation("review:approve", { packetId: packet2.packetId, digest: packet2.digest });
    const published2 = await w.otto.mutation("delivery:publish", { packetId: packet2.packetId });

    // 13. Acceptance of the corrected delivery, by the owner, for its exact digest; once.
    await refused(w.amy.mutation("delivery:accept", { deliveryId: published2.deliveryId, packetDigest: packet2.digest, scope: "full" }), "FORBIDDEN");
    await refused(w.ada.mutation("delivery:accept", { deliveryId: published2.deliveryId, packetDigest: packet.digest, scope: "full" }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    const acceptance = await w.ada.mutation("delivery:accept", { deliveryId: published2.deliveryId, packetDigest: packet2.digest, scope: "full" });
    assert.deepEqual([acceptance.billsCounted, acceptance.chargeMinor], [11, 25_000]);
    await refused(w.ada.mutation("delivery:accept", { deliveryId: published2.deliveryId, packetDigest: packet2.digest, scope: "full" }), "CONFLICT", "ALREADY_ACCEPTED");
    const final = await w.ada.query("delivery:view", { orderId });
    assert.deepEqual([final.order.status, final.delivery.id, final.delivery.acceptance.scope], ["delivery_accepted", published2.deliveryId, "full"]);
    assert.equal((await w.ada.query("delivery:get", { id: published2.deliveryId })).acceptance.packetDigest, packet2.digest, "the acceptance names the delivered digest");

    // No duplicate economic effects anywhere.
    for (const [name, n] of [["quoteAcceptances", 1], ["orders", 1], ["payments", 1], ["fulfillmentAcceptances", 1], ["acceptances", 1], ["corrections", 1]] as const) {
      assert.equal((await stored(http, name)).length, n, name);
    }
    assert.deepEqual((await w.otto.query("integrity:check")).problems, []);
  }));

test("tenant boundaries and roles hold over HTTP: Operator B, the non-member and customers are refused", () =>
  withServer(async (http) => {
    const w = await world(http);
    const sessionId = await intake(w);
    const q = await w.otto.mutation("quotes:create", { sessionId });
    const { orderId } = await w.ada.mutation("quotes:accept", { quoteId: q.quoteId, quoteDigest: q.quoteDigest });

    // Operator B works for Globex only: Acme's work does not exist for her, and she cannot act on it.
    assert.equal(await w.bea.query("intake:get", { sessionId }), null);
    assert.equal(await w.bea.query("quotes:get", { id: q.quoteId }), null);
    assert.equal(await w.bea.query("orders:get", { id: orderId }), null);
    assert.deepEqual(await w.bea.query("orders:list"), []);
    await refused(w.bea.mutation("intake:answer", { sessionId, field: "asOfDate", value: "2026-11-11" }), "NOT_FOUND");
    await refused(w.bea.mutation("quotes:create", { sessionId }), "FAILED_PRECONDITION", "INTAKE_INCOMPLETE");
    await refused(w.bea.mutation("payments:record", { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "check", reference: "x", idempotencyKey: "bea-1" }), "NOT_FOUND");
    await refused(w.bea.mutation("orders:acceptForFulfillment", { orderId }), "NOT_FOUND");
    // Naming Acme in a request does not get her there: switching is checked against her memberships.
    const sw = await http.request("POST", "/api/tenants/switch", { tenantId: w.acme }, w.bea.token);
    assert.notEqual(sw.status, 200);

    // The non-member has no organization: every get-it function is refused.
    for (const [kind, name, args] of [
      ["query", "intake:get", { sessionId }],
      ["query", "quotes:get", { id: q.quoteId }],
      ["query", "orders:get", { id: orderId }],
      ["mutation", "intake:create", { request: "x" }],
      ["mutation", "quotes:accept", { quoteId: q.quoteId, quoteDigest: q.quoteDigest }],
    ] as const) {
      const r = await w.nora.raw(kind, name, args);
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, "FORBIDDEN");
    }
    // Without a session at all, nothing is readable either.
    const anonymous = await http.request("POST", "/api/query/orders:get", { args: { id: orderId } });
    assert.ok(anonymous.status === 401 || anonymous.status === 403, JSON.stringify(anonymous.body));

    // Customers never fulfil; operators never buy or accept for the customer.
    await w.otto.mutation("payments:record", { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "check", reference: "chk-77", idempotencyKey: "acme-1" });
    await refused(w.ada.mutation("orders:acceptForFulfillment", { orderId }), "FORBIDDEN");
    await refused(w.amy.mutation("payments:record", { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "check", reference: "x", idempotencyKey: "amy-1" }), "FORBIDDEN");
    await refused(w.otto.mutation("quotes:accept", { quoteId: q.quoteId, quoteDigest: q.quoteDigest }), "FORBIDDEN");
    // Globex's own work stays Globex's: Bea can fulfil there, and Acme's people see nothing of it.
    const { sessionId: gs } = await w.gus.mutation("intake:create", { request: "Globex bills." });
    assert.equal(await w.otto.query("intake:get", { sessionId: gs }), null);
    assert.equal(await w.ada.query("intake:get", { sessionId: gs }), null);
  }));

test("customer responses expose no operator or approval metadata, and internal reads are operator-only", () =>
  withServer(async (http) => {
    const w = await world(http);
    const sessionId = await intake(w);
    const q = await w.otto.mutation("quotes:create", { sessionId });
    const { orderId } = await w.ada.mutation("quotes:accept", { quoteId: q.quoteId, quoteDigest: q.quoteDigest });
    await w.otto.mutation("payments:record", { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "bank_transfer", reference: "w-1", idempotencyKey: "k-1" });
    await w.otto.mutation("orders:acceptForFulfillment", { orderId });
    const [snapshot] = await w.otto.query("imports:list", { orderId });
    const run = await w.otto.mutation("runs:reviewSnapshot", { snapshotId: snapshot.id });
    const packet = await w.otto.mutation("review:request", { runId: run.runId });
    await w.olga.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest });
    const { deliveryId } = await w.otto.mutation("delivery:publish", { packetId: packet.packetId });

    for (const who of [w.ada, w.amy]) {
      const reads = await customerReads(w, who, { sessionId, quoteId: q.quoteId, orderId, deliveryId });
      const text = JSON.stringify(reads);
      for (const internal of [w.otto.id, w.olga.id, w.bea.id, "approvedBy", "approverType", "requestedBy", "publishedBy", "approvalId", "recordedBy", "importedBy"]) {
        assert.ok(!text.includes(internal), `${who.email}'s responses expose ${internal}`);
      }
    }
    // The internal records are operator reads: customers are refused, operators are not.
    for (const [name, args] of [
      ["runs:get", { id: run.runId }],
      ["imports:list", { orderId }],
      ["review:listPackets", { runId: run.runId }],
      ["review:listApprovals", { packetId: packet.packetId }],
      ["integrity:check", {}],
    ] as const) {
      await refused(w.ada.query(name, args), "FORBIDDEN");
      await refused(w.amy.query(name, args), "FORBIDDEN");
      await w.otto.query(name, args);
    }
  }));

test("digests cannot be substituted: another quote's digest, another delivery's digest, and unlisted files are refused", () =>
  withServer(async (http) => {
    const w = await world(http);
    const s1 = await intake(w);
    const s2 = await intake(w);
    const q1 = await w.otto.mutation("quotes:create", { sessionId: s1 });
    const q2 = await w.otto.mutation("quotes:create", { sessionId: s2 });
    assert.equal(q1.quoteDigest === q2.quoteDigest, false);
    await refused(w.ada.mutation("quotes:accept", { quoteId: q1.quoteId, quoteDigest: q2.quoteDigest }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    await refused(w.otto.mutation("payments:record", { quoteId: q1.quoteId, amountMinor: q1.priceMinor - 1, currency: "USD", method: "check", reference: "x", idempotencyKey: "short" }), "FAILED_PRECONDITION", "QUOTE_NOT_ACCEPTED");

    const deliver = async (sessionId: string, q: { quoteId: string; quoteDigest: string; priceMinor: number }, key: string) => {
      const { orderId } = await w.ada.mutation("quotes:accept", { quoteId: q.quoteId, quoteDigest: q.quoteDigest });
      await refused(w.otto.mutation("payments:record", { quoteId: q.quoteId, amountMinor: q.priceMinor - 1, currency: "USD", method: "check", reference: "x", idempotencyKey: `${key}-short` }), "INVALID_ARGUMENT", "AMOUNT_MISMATCH");
      await w.otto.mutation("payments:record", { quoteId: q.quoteId, amountMinor: q.priceMinor, currency: "USD", method: "check", reference: key, idempotencyKey: key });
      await w.otto.mutation("orders:acceptForFulfillment", { orderId });
      const [snapshot] = await w.otto.query("imports:list", { orderId });
      const run = await w.otto.mutation("runs:reviewSnapshot", { snapshotId: snapshot.id });
      const packet = await w.otto.mutation("review:request", { runId: run.runId });
      await w.olga.mutation("review:approve", { packetId: packet.packetId, digest: packet.digest });
      const { deliveryId } = await w.otto.mutation("delivery:publish", { packetId: packet.packetId });
      return { orderId, deliveryId, packetDigest: packet.digest as string, sessionId };
    };
    const d1 = await deliver(s1, q1, "k1");
    // The second order's bill set differs, so its package digest differs.
    const d2 = await deliver(s2, q2, "k2");
    assert.equal(d1.packetDigest, d2.packetDigest, "the same bill set and answers give the same package");

    // A different package: re-review d2 with a changed bill, so the two deliveries differ.
    const set = billSet();
    const changed = await w.otto.mutation("imports:record", { orderId: d2.orderId, billSet: { ...set, bills: set.bills.slice(1) } });
    const run3 = await w.otto.mutation("runs:reviewSnapshot", { snapshotId: changed.snapshotId });
    const p3 = await w.otto.mutation("review:request", { runId: run3.runId });
    await w.olga.mutation("review:approve", { packetId: p3.packetId, digest: p3.digest });
    const d3 = await w.otto.mutation("delivery:publish", { packetId: p3.packetId });
    await refused(w.ada.mutation("delivery:accept", { deliveryId: d1.deliveryId, packetDigest: p3.digest, scope: "full" }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");
    await refused(w.ada.mutation("delivery:requestCorrection", { deliveryId: d3.deliveryId, packetDigest: d1.packetDigest, reason: "x" }), "FAILED_PRECONDITION", "DIGEST_MISMATCH");

    for (const name of ["notes.txt", "../feltkit/app.ts", "/etc/passwd", "output.json", "evidence.JSON", "", "approval-packet.json/../summary.csv"]) {
      await refused(w.amy.query("delivery:download", { deliveryId: d1.deliveryId, name }), "NOT_FOUND");
    }
    await refused(w.bea.query("delivery:download", { deliveryId: d1.deliveryId, name: PACKET }), "NOT_FOUND");
    await refused(w.nora.query("delivery:download", { deliveryId: d1.deliveryId, name: PACKET }), "FORBIDDEN");
  }));
