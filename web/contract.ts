/**
 * What the customer is shown about the service, taken from the frozen contract and nowhere else.
 *
 * The contract file is bundled so the page can explain inputs, deliverables, acceptance criteria and
 * exclusions. It is display text only: every decision is the server's, and a quote names the
 * contract digest it was made under. `contractMatches` compares that digest with the pin bundled here,
 * so a page built from another contract version says so instead of showing the wrong terms.
 */
import contract from "../contracts/svc_bill_review_payable_prep@1.0.0.json";
import frozen from "../contracts/frozen.json";

export { contract };
export const CONTRACT_KEY = `${contract.id}@${contract.version}`;
export const PINNED_DIGEST = (frozen.contracts as Record<string, { digest: string }>)[CONTRACT_KEY]!.digest;
export const contractMatches = (digest: string | undefined | null) => digest === PINNED_DIGEST;

type Input = { id: string; kind: string; required: boolean; source?: string; default?: number | string; min?: number; max?: number; note?: string };
export const INPUTS: Input[] = [
  ...contract.inputs.required.map((i) => ({ ...(i as Input), required: true })),
  ...contract.inputs.optional.map((i) => ({ ...(i as Input), required: false })),
];
export const inputOf = (id: string) => INPUTS.find((i) => i.id === id);

/** Plain names for the contract's input ids. */
export const LABEL: Record<string, string> = {
  bills: "Supplier bills awaiting approval",
  vendors: "Vendor records",
  accounts: "Chart of accounts (expense categories)",
  homeCurrency: "Your home currency",
  timeZone: "Your time zone",
  asOfDate: "Review date",
  priorBills: "Bills you have already processed",
  "policy.documentRequiredOverMinor": "Receipt or invoice required above",
  "policy.dueSoonBusinessDays": "“Due soon” window (business days)",
};

/** Why each input is needed, in the contract's own words. */
export const WHY: Record<string, string> = {
  bills: `Each bill is reviewed on its own fields. Only bills in “${contract.fields.bill.reviewableStatus}” status are awaiting approval.`,
  vendors: "A bill naming a vendor that is not in your vendor records cannot be reviewed; it is held until you provide the record.",
  accounts: "The accounts or expense categories your bill lines name. A line naming an unknown account holds that bill until you provide it.",
  // contract.currency: foreign bills are classified for review, reported in their own currency, never converted.
  homeCurrency: "Bills in any other currency are flagged for review and reported in their own currency. We never convert currencies, so totals are shown per currency.",
  timeZone: "Deadlines count business days (Monday to Friday, excluding US federal holidays) in your time zone.",
  // contract input note: "the review date: future-dated and overdue are judged against it"
  asOfDate: "The date we review against: bills dated after it are flagged as future-dated, and bills due before it as overdue.",
  priorBills: "Optional: bills you have already processed, so we can spot duplicates of them. Without them, duplicates are found within the bills you submit.",
  // contract input note: a bill whose total exceeds this (home-currency minor units) needs a document reference
  "policy.documentRequiredOverMinor": "Optional: bills above this amount, in your home currency, need a receipt or invoice reference. Foreign-currency bills always do.",
  // contract recommendations.priority: due_soon = due by the Nth business day after the review date
  "policy.dueSoonBusinessDays": "Optional: how many business days after the review date a bill counts as due soon in the payable recommendation.",
};

export const FILE_LABEL: Record<string, string> = {
  bill_review_results: "Bill review results",
  payable_recommendation: "Payable recommendation",
  exception_list: "Exception list",
  missing_information_requests: "Missing-information requests",
  source_document_references: "Source-document references",
  evidence: "Evidence",
  summary_export: "Summary export",
  approval_packet: "Approval packet",
};

export const STATUS_LABEL: Record<string, string> = {
  ready_for_payable_approval: "Ready for payable approval",
  needs_information: "Needs information",
  policy_exception: "Policy exception",
  arithmetic_exception: "Arithmetic exception",
  duplicate_suspected: "Duplicate suspected",
  foreign_currency_review: "Foreign currency review",
  rejected_malformed: "Rejected as malformed",
  blocked_pending_customer_input: "Blocked pending your input",
};

export const CRITERION_LABEL: Record<string, string> = {
  completeness: "Every bill you submitted has exactly one result",
  traceability: "Every result cites the exact input it came from",
  recomputation: "Re-running the review gives exactly the delivered results",
  classification: "Every status follows the contract's rules and checks",
  no_accounting_mutation: "Nothing in your books was changed; every recommendation is advice",
  package_integrity: "Every file matches the fingerprint in the approval packet",
  reviewed: "A person other than the preparer approved this exact package",
  on_time: "Delivered by the committed deadline",
};

/** A recorded assumption, in the customer's terms: the input, how it was left, and what applies instead. */
export function assumptionText(a: { input: string; how: string }): string {
  const spec = inputOf(a.input);
  const name = LABEL[a.input] ?? a.input;
  const how = a.how === "declined" ? "You chose the default" : a.how === "not_answered" ? "Not answered" : "Not supplied";
  if (spec?.default === undefined) return `${name}: ${how.toLowerCase()}. ${WHY[a.input]?.replace(/^Optional: /, "") ?? ""}`.trim();
  const value = a.input === "policy.documentRequiredOverMinor" ? `${(Number(spec.default) / 100).toFixed(2)} in your home currency` : String(spec.default);
  return `${name}: ${how.toLowerCase()}, so the contract default applies (${value}).`;
}
