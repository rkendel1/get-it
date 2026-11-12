/**
 * Task requests: "I need this thing done", in the customer's own words, without choosing a service.
 *
 * What exists, honestly:
 * - Any task can be submitted, kept exactly as written, and seen in the organization's requests.
 * - Customers add details (answers, constraints, preferences, a deadline, a budget, notes) and
 *   resources (files through FeltKit's file service, or links) at any time.
 * - get-it's operators assess each task: more information needed (with the questions, each marked
 *   as needed to quote, to execute, optional, or a resource), needs an outside professional, under
 *   review, not currently fulfillable, or a fulfillment path identified.
 * - A path can only be one of get-it's real services: a frozen, active service contract. Today that
 *   is bill review and payable preparation. A task offered that service continues in its existing
 *   intake, quote and fulfillment, only when the customer accepts it.
 * - Without any assessment, a description that names the service's subject (whole words) lets the
 *   customer choose it. That suggestion is computed, never stored as an assessment, and never chosen
 *   for them.
 *
 * Submitting a task creates no quote and no order.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { DETAIL_KINDS, proposePath, taskState, validateDetail, validateQuestions, type Assessment, type Detail } from "../src/tasks.js";
import { app, audit, intakeCompleteness, intakeSessions, orders, quoteAcceptances, quotes, taskAssessments, taskDetails, taskRequests, taskResources, taskServiceChoices } from "./app.js";
import { CONTRACT, requirePerson, requireTenant } from "./_guards.js";
import { startIntake } from "./_intake.js";
import { PATHS } from "./_paths.js";


const MAX_FILE_BYTES = 3_000_000;

async function loadTask(ctx: QueryCtx | MutationCtx, requestId: string) {
  const task = await ctx.db.get(taskRequests, requestId);
  if (!task) fail("NOT_FOUND", "No such request.");
  return task;
}

/** Everything known about a task, and its state, derived from its records only. */
async function facts(ctx: QueryCtx | MutationCtx, task: { id: string; text: string }) {
  const assessments = (await ctx.db.find(taskAssessments, { requestId: task.id })).sort((a, b) => a.assessedAt - b.assessedAt || (a.id < b.id ? -1 : 1));
  const details = (await ctx.db.find(taskDetails, { requestId: task.id })).sort((a, b) => a.providedAt - b.providedAt || (a.id < b.id ? -1 : 1));
  const resources = (await ctx.db.find(taskResources, { requestId: task.id })).sort((a, b) => a.providedAt - b.providedAt || (a.id < b.id ? -1 : 1));
  const choices = (await ctx.db.find(taskServiceChoices, { requestId: task.id })).sort((a, b) => a.chosenAt - b.chosenAt || (a.id < b.id ? -1 : 1));
  const accepted = choices.find((c) => c.choice === "accepted") ?? null;
  const latest = assessments.at(-1) ?? null;
  const lastChoice = choices.at(-1) ?? null;

  // What the customer may accept now: the service an operator identified (unless declined since), or,
  // with no assessment at all, a service their description names (unless declined).
  let offer: { service: string; title: string; basis: "assessment" | "suggestion" } | null = null;
  if (!accepted) {
    const path = latest?.outcome === "fulfillment_path_identified" ? PATHS.find((p) => p.service === latest.service) : undefined;
    if (path && !(lastChoice && lastChoice.choice === "declined" && lastChoice.chosenAt >= latest!.assessedAt)) offer = { service: path.service, title: path.title, basis: "assessment" };
    if (!latest && !choices.some((c) => c.basis === "suggestion")) {
      const suggested = proposePath(task.text, PATHS);
      if (suggested) offer = { service: suggested.path.service, title: suggested.path.title, basis: "suggestion" };
    }
  }

  let link: { sessionId: string; intakeComplete: boolean } | null = null;
  if (accepted?.sessionId) {
    const [done] = await ctx.db.find(intakeCompleteness, { sessionId: accepted.sessionId });
    link = { sessionId: accepted.sessionId, intakeComplete: Boolean(done) };
  }
  const state = taskState({
    assessments: assessments.map((a): Assessment => ({ outcome: a.outcome, ...(a.service ? { service: a.service } : {}), reasons: a.reasons, questions: a.questions, arrangements: a.arrangements, at: a.assessedAt })),
    details: details.map((d): Detail => ({ kind: d.kind, ...(d.questionId ? { questionId: d.questionId } : {}), value: d.value, at: d.providedAt })),
    link,
    pathDeclined: Boolean(latest?.outcome === "fulfillment_path_identified" && lastChoice?.choice === "declined" && lastChoice.chosenAt >= latest.assessedAt),
  });
  return { assessments, latest, details, resources, accepted, offer, link, state };
}

/** Where the linked service's transaction stands: its quote and order, once they exist. */
async function transaction(ctx: QueryCtx | MutationCtx, sessionId: string) {
  const [done] = await ctx.db.find(intakeCompleteness, { sessionId });
  const [quote] = done ? await ctx.db.find(quotes, { completenessId: done.id }) : [];
  const [acceptance] = quote ? await ctx.db.find(quoteAcceptances, { quoteId: quote.id }) : [];
  const order = acceptance ? await ctx.db.get(orders, acceptance.orderId) : null;
  return { sessionId, intakeComplete: Boolean(done), quote: quote ? { priceMinor: quote.priceMinor, currency: quote.currency } : null, orderStatus: order?.status ?? null };
}

export const create = app.mutation({
  access: "tasks.write",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    if (!a.text.trim()) fail("INVALID_ARGUMENT", "Describe what you need done.");
    // Stored exactly as written: no trimming, no rewriting.
    const requestId = await ctx.db.insert(taskRequests, { tenantId, text: a.text, requestedBy: ctx.auth.requirePrincipal().id, requestedAt: Date.now() });
    await audit.record(ctx, { subject: "task", id: requestId, type: "task.submitted", data: { length: a.text.length } });
    return { requestId };
  },
});

/** The organization's task requests, newest first, with each one's state, whether or not it was ever quoted. */
export const list = app.query({
  access: "tasks.read",
  args: {},
  handler: async (ctx) => {
    requireTenant(ctx);
    const tasks = (await ctx.db.find(taskRequests, {})).sort((a, b) => b.requestedAt - a.requestedAt || (a.id < b.id ? 1 : -1));
    const out = [];
    for (const task of tasks) {
      const f = await facts(ctx, task);
      out.push({ id: task.id, text: task.text, requestedAt: task.requestedAt, outcome: f.state.outcome, offer: f.offer ? { title: f.offer.title } : null, transaction: f.link ? await transaction(ctx, f.link.sessionId) : null });
    }
    return out;
  },
});

/** One task, as its customer sees it: their words, what they added, what we concluded, and what happens next. */
export const get = app.query({
  access: "tasks.read",
  args: { requestId: s.string() },
  handler: async (ctx, a) => {
    requireTenant(ctx);
    const task = await ctx.db.get(taskRequests, a.requestId);
    if (!task) return null;
    const f = await facts(ctx, task);
    return {
      id: task.id,
      text: task.text,
      requestedAt: task.requestedAt,
      state: { outcome: f.state.outcome, openQuoteQuestions: f.state.openQuoteQuestions },
      // The latest assessment, without who made it.
      assessment: f.latest ? { outcome: f.latest.outcome, reasons: f.latest.reasons, questions: f.latest.questions, arrangements: f.latest.arrangements, assessedAt: f.latest.assessedAt, service: f.latest.service ? (PATHS.find((p) => p.service === f.latest!.service)?.title ?? null) : null } : null,
      details: f.details.map((d) => ({ id: d.id, kind: d.kind, questionId: d.questionId ?? null, value: d.value, providedAt: d.providedAt })),
      resources: f.resources.map((r) => ({ id: r.id, kind: r.kind, name: r.name, url: r.url ?? null, contentType: r.contentType ?? null, size: r.size ?? null, providedAt: r.providedAt })),
      offer: f.offer ? { title: f.offer.title, basis: f.offer.basis } : null,
      transaction: f.link ? await transaction(ctx, f.link.sessionId) : null,
    };
  },
});

export const addDetail = app.mutation({
  access: "tasks.write",
  args: { requestId: s.string(), kind: s.enum(DETAIL_KINDS), value: s.unknown(), questionId: s.optional(s.string()) },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const task = await loadTask(ctx, a.requestId);
    let value: unknown;
    try {
      value = validateDetail(a.kind, a.value);
    } catch (e) {
      fail("INVALID_ARGUMENT", (e as Error).message, { hint: "DETAIL_INVALID" });
    }
    if (a.kind === "answer") {
      const f = await facts(ctx, task);
      if (!a.questionId || !f.latest?.questions.some((q) => q.id === a.questionId)) fail("INVALID_ARGUMENT", "That is not one of the open questions about this request.", { hint: "UNKNOWN_QUESTION" });
    } else if (a.questionId) fail("INVALID_ARGUMENT", "Only an answer names a question.");
    const id = await ctx.db.insert(taskDetails, { tenantId, requestId: task.id, kind: a.kind, ...(a.questionId ? { questionId: a.questionId } : {}), value, providedBy: ctx.auth.requirePrincipal().id, providedAt: Date.now() });
    await audit.record(ctx, { subject: "task", id: task.id, type: "task.detail_added", data: { kind: a.kind } });
    return { detailId: id };
  },
});

/** Attach a file (stored by FeltKit's organization-scoped file service) or a link to a task. */
export const attach = app.mutation({
  access: "tasks.write",
  args: {
    requestId: s.string(),
    file: s.optional(s.object({ name: s.string({ minLength: 1, maxLength: 200 }), contentType: s.optional(s.string({ maxLength: 100 })), contentBase64: s.string({ maxLength: 4_000_000 }) })),
    link: s.optional(s.object({ name: s.string({ minLength: 1, maxLength: 200 }), url: s.string({ maxLength: 2000 }) })),
  },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const task = await loadTask(ctx, a.requestId);
    const by = ctx.auth.requirePrincipal().id;
    if (Boolean(a.file) === Boolean(a.link)) fail("INVALID_ARGUMENT", "Attach either a file or a link.");
    if (a.link) {
      let url: URL;
      try {
        url = new URL(a.link.url);
      } catch {
        fail("INVALID_ARGUMENT", "That is not a web address.", { hint: "LINK_INVALID" });
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") fail("INVALID_ARGUMENT", "Links must be http or https.", { hint: "LINK_INVALID" });
      const id = await ctx.db.insert(taskResources, { tenantId, requestId: task.id, kind: "link", name: a.link.name, url: url.toString(), providedBy: by, providedAt: Date.now() });
      await audit.record(ctx, { subject: "task", id: task.id, type: "task.link_added", data: { name: a.link.name } });
      return { resourceId: id };
    }
    const bytes = Buffer.from(a.file!.contentBase64, "base64");
    if (bytes.length === 0) fail("INVALID_ARGUMENT", "The file is empty.", { hint: "FILE_EMPTY" });
    if (bytes.length > MAX_FILE_BYTES) fail("INVALID_ARGUMENT", `Files are limited to ${MAX_FILE_BYTES / 1_000_000} MB.`, { hint: "FILE_TOO_LARGE" });
    const file = await ctx.services.files.upload({ name: a.file!.name, content: new Uint8Array(bytes), ...(a.file!.contentType ? { contentType: a.file!.contentType } : {}), metadata: { taskRequestId: task.id } });
    const id = await ctx.db.insert(taskResources, {
      tenantId,
      requestId: task.id,
      kind: "file",
      name: file.name,
      fileId: file.id,
      ...(file.contentType ? { contentType: file.contentType } : {}),
      size: file.size,
      ...(file.checksum ? { checksum: file.checksum } : {}),
      providedBy: by,
      providedAt: Date.now(),
    });
    await audit.record(ctx, { subject: "task", id: task.id, type: "task.file_attached", data: { name: file.name, size: file.size } });
    return { resourceId: id };
  },
});

/** An operator's recorded judgement of a task. A person makes it; a service can only be a real one. */
export const assess = app.mutation({
  access: "tasks.assess",
  args: {
    requestId: s.string(),
    outcome: s.enum(["more_information_required", "fulfillment_path_identified", "requires_external_provider", "requires_manual_review", "not_currently_fulfillable"] as const),
    service: s.optional(s.string()),
    reasons: s.array(s.string({ minLength: 1, maxLength: 1000 })),
    questions: s.optional(s.unknown()),
    arrangements: s.optional(s.array(s.string({ minLength: 1, maxLength: 1000 }))),
  },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const task = await loadTask(ctx, a.requestId);
    if (a.outcome === "fulfillment_path_identified") {
      if (!a.service || !PATHS.some((p) => p.service === a.service)) fail("INVALID_ARGUMENT", "A fulfillment path must be one of get-it's active services.", { hint: "UNKNOWN_SERVICE" });
    } else if (a.service) fail("INVALID_ARGUMENT", "Only an identified fulfillment path names a service.");
    let questions;
    try {
      questions = validateQuestions(a.questions ?? []);
    } catch (e) {
      fail("INVALID_ARGUMENT", (e as Error).message, { hint: "QUESTIONS_INVALID" });
    }
    if (a.outcome === "more_information_required" && !questions.length) fail("INVALID_ARGUMENT", "Say what information is needed.", { hint: "QUESTIONS_REQUIRED" });
    if (!a.reasons.length) fail("INVALID_ARGUMENT", "Give the reason for the assessment.", { hint: "REASON_REQUIRED" });
    const id = await ctx.db.insert(taskAssessments, { tenantId, requestId: task.id, outcome: a.outcome, ...(a.service ? { service: a.service } : {}), reasons: a.reasons, questions, arrangements: a.arrangements ?? [], assessedBy: person.id, assessedAt: Date.now() });
    await audit.record(ctx, { subject: "task", id: task.id, type: "task.assessed", data: { outcome: a.outcome, ...(a.service ? { service: a.service } : {}) } });
    return { assessmentId: id };
  },
});

/**
 * The customer's answer to the service offered for their task. Accepting starts that service's intake
 * and links it to the task, durably; accepting again returns the same intake. Declining is recorded,
 * and the task goes to a person.
 */
export const respondToService = app.mutation({
  access: "tasks.write",
  args: { requestId: s.string(), accept: s.boolean() },
  handler: async (ctx, a) => {
    const tenantId = requireTenant(ctx);
    const person = requirePerson(ctx);
    const task = await loadTask(ctx, a.requestId);
    const f = await facts(ctx, task);
    if (f.accepted) {
      if (a.accept) return { status: "existing" as const, sessionId: f.accepted.sessionId ?? null };
      fail("FAILED_PRECONDITION", "This request already continues in a service.", { hint: "ALREADY_CHOSEN" });
    }
    if (!f.offer) fail("FAILED_PRECONDITION", "No service is offered for this request yet. Our team will review it.", { hint: "NO_OFFER" });
    const now = Date.now();
    if (!a.accept) {
      await ctx.db.insert(taskServiceChoices, { tenantId, requestId: task.id, service: f.offer.service, basis: f.offer.basis, choice: "declined", chosenBy: person.id, chosenAt: now });
      await audit.record(ctx, { subject: "task", id: task.id, type: "task.service_declined", data: { service: f.offer.service } });
      return { status: "declined" as const, sessionId: null };
    }
    if (f.offer.service !== CONTRACT.key) fail("FAILED_PRECONDITION", "That service is not available in this deployment.");
    // The service's intake starts from the customer's words, exactly as written.
    const { sessionId } = await startIntake(ctx, tenantId, task.text);
    await ctx.db.insert(taskServiceChoices, { tenantId, requestId: task.id, service: f.offer.service, basis: f.offer.basis, choice: "accepted", sessionId, chosenBy: person.id, chosenAt: now });
    await audit.record(ctx, { subject: "task", id: task.id, type: "task.service_accepted", data: { service: f.offer.service, sessionId } });
    return { status: "accepted" as const, sessionId };
  },
});
