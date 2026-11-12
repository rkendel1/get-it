/**
 * App test harness: a real FeltKit runtime on a fresh FeltDB, organizations (FeltKit tenants) with
 * customer and operator members, and the full commercial path to a fulfilled order:
 * intake → quote → accept → payment → acceptance for fulfillment.
 */
import assert from "node:assert/strict";
import { createTestApp, type Caller, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { billSet } from "./_bills.js";

const person = (id: string) => ({ id, type: "user" as const, roles: ["person"] });

export interface Org {
  id: string;
  owner: Caller; // customer, with authority
  member: Caller; // customer, without commercial authority
  operator: Caller; // get-it staff "otto"
  reviewer: Caller; // get-it staff "olga"
  agent: Caller; // an agent holding the operator role
  stranger: Caller; // a signed-in person who is not a member
}

export async function newOrg(t: TestApp, name: string, ids: { owner: string; member: string }): Promise<Org> {
  const tenancy = t.tenancy!;
  const org = await t.provisionTenant(name, { ...person(ids.owner), email: `${ids.owner}@example.com` });
  const actor = { ...(await tenancy.context(org.id, ids.owner))!, principalId: ids.owner };
  const join = async (who: string, role: string) => {
    const { token } = await tenancy.invite(actor, { email: `${who}@example.com`, role });
    await tenancy.accept(token, { ...person(who), email: `${who}@example.com`, emailVerified: true });
  };
  await join(ids.member, "member");
  await join("otto", "operator");
  await join("olga", "operator");
  const agentId = `agent-${org.id.slice(-6)}`;
  await tenancy.addPrincipal(actor, { id: agentId, type: "agent", displayName: "Assistant" }, "operator");
  const as = (id: string, type: "user" | "agent" = "user") => t.as({ id, type, roles: type === "user" ? ["person"] : [] }, { tenant: org.id });
  return { id: org.id, owner: as(ids.owner), member: as(ids.member), operator: as("otto"), reviewer: as("olga"), agent: as(agentId, "agent"), stranger: as(`stranger-${org.id.slice(-6)}`) };
}

export async function withApp(fn: (t: TestApp) => Promise<void>) {
  const t = await createTestApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

export async function rejectsWith(p: Promise<unknown>, code: string, hint?: string) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.code, code, e.message);
    if (hint) assert.equal(e.hint ?? e.details?.hint, hint, e.message);
    return true;
  });
}

/** A collection read directly from storage, beneath FeltKit's tenant scope. */
export const raw = (t: TestApp, name: string) => t.runtime.instance.handle("test.raw").collection<Record<string, any>>(name);

export const ANSWERS = { homeCurrency: "USD", timeZone: "America/New_York", asOfDate: "2026-11-10" } as const;

/** A complete intake: answers, the bill set, completion. */
export async function intake(org: Org, set: unknown = billSet()) {
  const { sessionId } = await org.owner.mutation(api.intake.create, { request: "Review our pending supplier bills before the payment run." });
  for (const [field, value] of Object.entries(ANSWERS)) await org.owner.mutation(api.intake.answer, { sessionId, field, value });
  await org.owner.mutation(api.intake.uploadBillSet, { sessionId, billSet: set });
  const completed = await org.owner.mutation(api.intake.complete, { sessionId });
  return { sessionId, ...completed };
}

/** Intake → quote → acceptance → payment → acceptance for fulfillment. */
export async function ordered(org: Org, set: unknown = billSet()) {
  const { sessionId } = await intake(org, set);
  const quote = await org.operator.mutation(api.quotes.create, { sessionId });
  const accepted = await org.owner.mutation(api.quotes.accept, { quoteId: quote.quoteId, quoteDigest: quote.quoteDigest });
  await org.operator.mutation(api.payments.record, { quoteId: quote.quoteId, amountMinor: quote.priceMinor, currency: quote.currency, method: "bank_transfer", reference: `wire-${quote.quoteId.slice(-6)}`, idempotencyKey: `pay-${quote.quoteId}` });
  await org.operator.mutation(api.orders.acceptForFulfillment, { orderId: accepted.orderId });
  const [snapshot] = await org.operator.query(api.imports.list, { orderId: accepted.orderId });
  return { sessionId, quote, orderId: accepted.orderId, snapshotId: snapshot!.id };
}

export async function reviewed(org: Org, set: unknown = billSet()) {
  const o = await ordered(org, set);
  const run = await org.operator.mutation(api.runs.reviewSnapshot, { snapshotId: o.snapshotId });
  return { ...o, ...run };
}

export async function delivered(org: Org) {
  const r = await reviewed(org);
  const { packetId, digest } = await org.operator.mutation(api.review.request, { runId: r.runId });
  await org.reviewer.mutation(api.review.approve, { packetId, digest });
  const published = await org.operator.mutation(api.delivery.publish, { packetId });
  return { ...r, packetId, packetDigest: digest, ...published };
}
