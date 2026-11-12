/**
 * General task requests: "I need this thing done", independent of any fulfillment contract.
 *
 * A task request is what the customer asked for, in their words, never rewritten. Around it:
 *   - details the customer adds (answers to scoping questions, constraints, preferences, a deadline,
 *     a budget, notes), append-only;
 *   - resources they provide (files, through FeltKit's file service; links);
 *   - assessments: Boundry's recorded judgement of whether and how the task can be fulfilled, with
 *     the questions it needs answered and what Boundry would arrange; append-only, latest wins;
 *   - at most one link to a service-specific intake, made only when a real fulfillment path exists
 *     (a frozen, active service contract) and the customer confirms it.
 *
 * Nothing here decides that Boundry can do a task because a description sounds plausible.
 *   - Assessments are recorded by people (get-it's operators).
 *   - The one automatic step is a *suggestion*: a deterministic word match against an existing
 *     service whose contract is frozen. It is never stored as an assessment and never selects a
 *     service; it offers the customer a choice. Only the customer's explicit acceptance (or an
 *     operator's assessment that the customer then accepts) links the task to that service.
 */

/** Boundry's internal assessment outcomes (domain states, not marketing claims). */
export const TASK_OUTCOMES = [
  "ready_to_scope",
  "more_information_required",
  "fulfillment_path_identified",
  "requires_external_provider",
  "requires_manual_review",
  "not_currently_fulfillable",
  "ready_to_quote",
] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

/** Why a scoping question is asked. */
export const QUESTION_PURPOSES = ["quote", "execute", "optional", "resource"] as const;
export type QuestionPurpose = (typeof QUESTION_PURPOSES)[number];

export const DETAIL_KINDS = ["answer", "constraint", "preference", "deadline", "budget", "note"] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export interface Question {
  readonly id: string;
  readonly text: string;
  readonly purpose: QuestionPurpose;
}

export interface Assessment {
  readonly outcome: TaskOutcome;
  /** The service contract key, only for `fulfillment_path_identified`. */
  readonly service?: string;
  readonly reasons: readonly string[];
  readonly questions: readonly Question[];
  /** What Boundry itself would arrange, in plain words. */
  readonly arrangements: readonly string[];
  readonly at: number;
}

export interface Detail {
  readonly kind: DetailKind;
  readonly questionId?: string;
  readonly value: unknown;
  readonly at: number;
}

/** A service Boundry can actually fulfil: a frozen, active contract, and how to recognise requests for it. */
export interface FulfillmentPath {
  readonly service: string;
  readonly title: string;
  /** Whole words or phrases that suggest the path. A suggestion only: the customer confirms. */
  readonly signals: readonly string[];
}

/**
 * Propose an existing fulfillment path for a description, deterministically, or none.
 * Matching is on whole words, case-insensitive. A match is a proposal for the customer to confirm,
 * never a claim that the task can be done.
 */
export function proposePath(text: string, paths: readonly FulfillmentPath[]): { path: FulfillmentPath; matched: string[] } | null {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const path of paths) {
    const matched = path.signals.filter((s) => lower.includes(` ${s.toLowerCase()} `));
    if (matched.length) return { path, matched };
  }
  return null;
}

export function validateQuestions(questions: unknown): Question[] {
  if (!Array.isArray(questions)) throw new TypeError("questions must be a list");
  if (questions.length > 30) throw new TypeError("at most 30 questions");
  const ids = new Set<string>();
  return questions.map((q, i) => {
    const r = q as Record<string, unknown>;
    if (typeof r?.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(r.id)) throw new TypeError(`questions[${i}].id must be a short lowercase id`);
    if (ids.has(r.id)) throw new TypeError(`questions[${i}].id ${r.id} is repeated`);
    ids.add(r.id);
    if (typeof r.text !== "string" || !r.text.trim() || r.text.length > 500) throw new TypeError(`questions[${i}].text is missing`);
    if (!(QUESTION_PURPOSES as readonly unknown[]).includes(r.purpose)) throw new TypeError(`questions[${i}].purpose must be one of ${QUESTION_PURPOSES.join(", ")}`);
    return { id: r.id, text: r.text.trim(), purpose: r.purpose as QuestionPurpose };
  });
}

/** Validate a detail's value by its kind. Returns the value to store, or throws. */
export function validateDetail(kind: DetailKind, value: unknown): unknown {
  switch (kind) {
    case "deadline":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new TypeError("a deadline is a date (YYYY-MM-DD)");
      return value;
    case "budget": {
      const b = value as { amountMinor?: unknown; currency?: unknown };
      if (!b || typeof b !== "object" || !Number.isSafeInteger(b.amountMinor) || (b.amountMinor as number) < 0 || typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)) throw new TypeError("a budget is { amountMinor, currency }");
      return { amountMinor: b.amountMinor, currency: b.currency };
    }
    default:
      if (typeof value !== "string" || !value.trim() || value.length > 4000) throw new TypeError(`a ${kind} is text`);
      return value.trim();
  }
}

export interface TaskState {
  /** The current outcome, from the latest assessment, the customer's answers, and any linked intake. */
  readonly outcome: TaskOutcome;
  /** Questions Boundry still needs answered to quote. */
  readonly openQuoteQuestions: readonly Question[];
  /** The proposed or identified service, if any. */
  readonly service: string | null;
  /** Whether the customer has confirmed the service (the link to an intake exists). */
  readonly confirmed: boolean;
  /** Whether the customer declined a proposed service. */
  readonly declined: boolean;
}

/**
 * The task's state, from its facts only:
 *   - linked to an intake: `fulfillment_path_identified` while it gathers inputs, `ready_to_quote`
 *     once complete (quote, order and delivery states are the transaction's own);
 *   - otherwise the latest assessment; `more_information_required` becomes
 *     `requires_manual_review` once every question needed to quote is answered (a person looks again);
 *   - a proposed service the customer declined becomes `requires_manual_review`;
 *   - with no assessment, `ready_to_scope`.
 */
export function taskState(input: { assessments: readonly Assessment[]; details: readonly Detail[]; link: { intakeComplete: boolean } | null; pathDeclined: boolean }): TaskState {
  const latest = [...input.assessments].sort((a, b) => a.at - b.at).at(-1);
  const answered = new Set(input.details.filter((d) => d.kind === "answer" && d.questionId).map((d) => d.questionId!));
  const open = (latest?.questions ?? []).filter((q) => q.purpose === "quote" && !answered.has(q.id));
  const service = latest?.outcome === "fulfillment_path_identified" ? latest.service ?? null : null;
  if (input.link) return { outcome: input.link.intakeComplete ? "ready_to_quote" : "fulfillment_path_identified", openQuoteQuestions: open, service, confirmed: true, declined: false };
  if (!latest) return { outcome: "ready_to_scope", openQuoteQuestions: [], service: null, confirmed: false, declined: false };
  if (latest.outcome === "fulfillment_path_identified" && input.pathDeclined) return { outcome: "requires_manual_review", openQuoteQuestions: open, service: null, confirmed: false, declined: true };
  if (latest.outcome === "more_information_required" && open.length === 0 && latest.questions.some((q) => q.purpose === "quote")) return { outcome: "requires_manual_review", openQuoteQuestions: [], service, confirmed: false, declined: false };
  return { outcome: latest.outcome, openQuoteQuestions: open, service, confirmed: false, declined: false };
}
