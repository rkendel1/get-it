/**
 * The bill set: `get-it.bill-set/1`, Ledger-compatible inputs.
 *
 * Field names and integer minor-unit amounts follow Ledger's own records:
 * - a vendor is a Ledger contact of kind vendor (`id`, `name`, `active`, `paymentTermsDays`,
 *   `defaultAccountId`);
 * - an account is a Ledger account (`id`, `name`, `active`, `number`, `type`);
 * - a bill is a Ledger bill (`id`, `vendorId`, `billNumber`, `billDate`, `dueDate`, `status`,
 *   `lines[{description, accountId, amountMinor}]`, `totalMinor`, `memo`).
 *
 * The contract adds `currency`, `taxMinor` (per line and per bill), `subtotalMinor`,
 * `documents[{ref, kind, sha256}]` and `submittedBy`. A Ledger export maps directly. Ledger has a
 * single base currency, so `currency` is the organization's base currency. Members this format does
 * not name (Ledger's `journalEntryId`, `approvedBy`, `createdAt`, …) are ignored.
 *
 * Reference data (vendors, accounts, prior bills) must be valid, or the import is refused. Bills
 * are validated one by one: an invalid bill is kept and reviewed as `rejected_malformed`, so the
 * customer learns what to fix.
 */
import { digest } from "./canonical.js";
import { isMinor } from "./money.js";

export const BILL_STATUSES = ["draft", "approved", "posted", "void"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];
export const DOCUMENT_KINDS = ["receipt", "invoice", "other"] as const;

export interface Vendor {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly paymentTermsDays?: number;
  readonly defaultAccountId?: string;
}

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly number?: string;
  readonly type?: string;
}

export interface BillLine {
  readonly description: string;
  readonly accountId: string;
  readonly amountMinor: number;
  readonly taxMinor: number;
}

export interface DocumentRef {
  readonly ref: string;
  readonly kind: (typeof DOCUMENT_KINDS)[number];
  readonly sha256?: string;
}

export interface Bill {
  readonly id: string;
  readonly vendorId: string;
  readonly billNumber: string;
  readonly billDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly status: BillStatus;
  readonly lines: readonly BillLine[];
  readonly subtotalMinor?: number;
  readonly taxMinor?: number;
  readonly totalMinor: number;
  readonly documents: readonly DocumentRef[];
  readonly memo?: string;
  readonly submittedBy?: string;
}

export interface PriorBill {
  readonly vendorId: string;
  readonly billNumber: string;
  readonly billDate?: string;
  readonly totalMinor?: number;
}

export interface RawBillSet {
  readonly vendors: readonly unknown[];
  readonly accounts: readonly unknown[];
  readonly bills: readonly unknown[];
  readonly priorBills?: readonly unknown[];
}

export class BillSetError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`bill set refused: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ""}`);
    this.name = "BillSetError";
    this.issues = issues;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A real calendar date, not just the YYYY-MM-DD shape. */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** The key a bill is known by: its id, or (when it has no usable id) a digest of its content. */
export function billKey(raw: unknown): string {
  return isObject(raw) && typeof raw.id === "string" && ID.test(raw.id) ? raw.id : `malformed:${digest(raw).slice(7, 23)}`;
}

export type BillValidation = { ok: true; bill: Bill } | { ok: false; issues: string[] };

export function validateBill(raw: unknown, maxLines: number): BillValidation {
  const issues: string[] = [];
  if (!isObject(raw)) return { ok: false, issues: ["a bill must be an object"] };
  if (!(typeof raw.id === "string" && ID.test(raw.id))) issues.push("id is missing or invalid");
  if (!(typeof raw.vendorId === "string" && ID.test(raw.vendorId))) issues.push("vendorId is missing or invalid");
  if (!text(raw.billNumber, 80)) issues.push("billNumber is missing");
  if (!isCalendarDate(raw.billDate)) issues.push("billDate is not a calendar date (YYYY-MM-DD)");
  if (!isCalendarDate(raw.dueDate)) issues.push("dueDate is not a calendar date (YYYY-MM-DD)");
  if (isCalendarDate(raw.billDate) && isCalendarDate(raw.dueDate) && raw.dueDate < raw.billDate) issues.push("dueDate is before billDate");
  if (!(typeof raw.currency === "string" && CURRENCY.test(raw.currency))) issues.push("currency is not an ISO 4217 code");
  if (!(BILL_STATUSES as readonly unknown[]).includes(raw.status)) issues.push(`status must be one of ${BILL_STATUSES.join(", ")}`);
  if (!isMinor(raw.totalMinor)) issues.push("totalMinor is not a non-negative integer of minor units");
  if (raw.subtotalMinor !== undefined && !isMinor(raw.subtotalMinor)) issues.push("subtotalMinor is not a non-negative integer of minor units");
  if (raw.taxMinor !== undefined && !isMinor(raw.taxMinor)) issues.push("taxMinor is not a non-negative integer of minor units");
  if (raw.memo !== undefined && typeof raw.memo !== "string") issues.push("memo is not text");
  if (raw.submittedBy !== undefined && typeof raw.submittedBy !== "string") issues.push("submittedBy is not text");

  const lines: BillLine[] = [];
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) issues.push("lines must be a non-empty list");
  else if (raw.lines.length > maxLines) issues.push(`more than ${maxLines} lines`);
  else
    raw.lines.forEach((l, i) => {
      const at = `lines[${i}]`;
      if (!isObject(l)) return void issues.push(`${at} is not an object`);
      const before = issues.length;
      if (!text(l.description, 500)) issues.push(`${at}.description is missing`);
      if (!(typeof l.accountId === "string" && ID.test(l.accountId))) issues.push(`${at}.accountId is missing or invalid`);
      if (!isMinor(l.amountMinor, 1)) issues.push(`${at}.amountMinor is not a positive integer of minor units`);
      if (l.taxMinor !== undefined && !isMinor(l.taxMinor)) issues.push(`${at}.taxMinor is not a non-negative integer of minor units`);
      if (issues.length === before) lines.push({ description: (l.description as string).trim(), accountId: l.accountId as string, amountMinor: l.amountMinor as number, taxMinor: (l.taxMinor as number | undefined) ?? 0 });
    });

  const documents: DocumentRef[] = [];
  if (raw.documents !== undefined) {
    if (!Array.isArray(raw.documents)) issues.push("documents must be a list");
    else
      raw.documents.forEach((d, i) => {
        if (!isObject(d) || !text(d.ref, 500)) return void issues.push(`documents[${i}].ref is missing`);
        if (d.kind !== undefined && !(DOCUMENT_KINDS as readonly unknown[]).includes(d.kind)) return void issues.push(`documents[${i}].kind must be one of ${DOCUMENT_KINDS.join(", ")}`);
        if (d.sha256 !== undefined && !(typeof d.sha256 === "string" && /^[0-9a-f]{64}$/.test(d.sha256))) return void issues.push(`documents[${i}].sha256 is not a hex sha256`);
        documents.push({ ref: (d.ref as string).trim(), kind: (d.kind as DocumentRef["kind"] | undefined) ?? "other", ...(d.sha256 ? { sha256: d.sha256 as string } : {}) });
      });
  }

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    bill: {
      id: raw.id as string,
      vendorId: raw.vendorId as string,
      billNumber: (raw.billNumber as string).trim(),
      billDate: raw.billDate as string,
      dueDate: raw.dueDate as string,
      currency: raw.currency as string,
      status: raw.status as BillStatus,
      lines,
      ...(raw.subtotalMinor !== undefined ? { subtotalMinor: raw.subtotalMinor as number } : {}),
      ...(raw.taxMinor !== undefined ? { taxMinor: raw.taxMinor as number } : {}),
      totalMinor: raw.totalMinor as number,
      documents,
      ...(raw.memo ? { memo: raw.memo as string } : {}),
      ...(raw.submittedBy ? { submittedBy: raw.submittedBy as string } : {}),
    },
  };
}

function vendorOf(raw: unknown, at: string, issues: string[]): Vendor | null {
  if (!isObject(raw)) return void issues.push(`${at} is not an object`), null;
  const before = issues.length;
  if (!(typeof raw.id === "string" && ID.test(raw.id))) issues.push(`${at}.id is missing or invalid`);
  if (!text(raw.name, 200)) issues.push(`${at}.name is missing`);
  if (typeof raw.active !== "boolean") issues.push(`${at}.active must be true or false`);
  if (raw.paymentTermsDays !== undefined && !(Number.isInteger(raw.paymentTermsDays) && (raw.paymentTermsDays as number) >= 0 && (raw.paymentTermsDays as number) <= 365)) issues.push(`${at}.paymentTermsDays must be an integer 0–365`);
  if (raw.defaultAccountId !== undefined && !(typeof raw.defaultAccountId === "string" && ID.test(raw.defaultAccountId))) issues.push(`${at}.defaultAccountId is invalid`);
  if (issues.length > before) return null;
  return { id: raw.id as string, name: (raw.name as string).trim(), active: raw.active as boolean, ...(raw.paymentTermsDays !== undefined ? { paymentTermsDays: raw.paymentTermsDays as number } : {}), ...(raw.defaultAccountId ? { defaultAccountId: raw.defaultAccountId as string } : {}) };
}

function accountOf(raw: unknown, at: string, issues: string[]): Account | null {
  if (!isObject(raw)) return void issues.push(`${at} is not an object`), null;
  const before = issues.length;
  if (!(typeof raw.id === "string" && ID.test(raw.id))) issues.push(`${at}.id is missing or invalid`);
  if (!text(raw.name, 200)) issues.push(`${at}.name is missing`);
  if (typeof raw.active !== "boolean") issues.push(`${at}.active must be true or false`);
  if (raw.number !== undefined && typeof raw.number !== "string") issues.push(`${at}.number is not text`);
  if (raw.type !== undefined && typeof raw.type !== "string") issues.push(`${at}.type is not text`);
  if (issues.length > before) return null;
  return { id: raw.id as string, name: (raw.name as string).trim(), active: raw.active as boolean, ...(raw.number ? { number: raw.number as string } : {}), ...(raw.type ? { type: raw.type as string } : {}) };
}

function priorOf(raw: unknown, at: string, issues: string[]): PriorBill | null {
  if (!isObject(raw)) return void issues.push(`${at} is not an object`), null;
  const before = issues.length;
  if (!(typeof raw.vendorId === "string" && ID.test(raw.vendorId))) issues.push(`${at}.vendorId is missing or invalid`);
  if (!text(raw.billNumber, 80)) issues.push(`${at}.billNumber is missing`);
  if (raw.billDate !== undefined && !isCalendarDate(raw.billDate)) issues.push(`${at}.billDate is not a calendar date`);
  if (raw.totalMinor !== undefined && !isMinor(raw.totalMinor)) issues.push(`${at}.totalMinor is not an integer of minor units`);
  if (issues.length > before) return null;
  return { vendorId: raw.vendorId as string, billNumber: (raw.billNumber as string).trim(), ...(raw.billDate ? { billDate: raw.billDate as string } : {}), ...(raw.totalMinor !== undefined ? { totalMinor: raw.totalMinor as number } : {}) };
}

export interface ReferenceData {
  readonly vendors: ReadonlyMap<string, Vendor>;
  readonly accounts: ReadonlyMap<string, Account>;
  readonly priorBills: readonly PriorBill[];
}

export interface ValidatedBillSet extends ReferenceData {
  /** Bills as submitted: each is validated on its own during review. */
  readonly bills: readonly unknown[];
}

/** Validate the set's shape and reference data. Throws BillSetError listing every problem. */
export function validateBillSet(raw: unknown, limits: { maxBills: number; maxVendors: number; maxAccounts: number; maxPriorBills: number }): ValidatedBillSet {
  const issues: string[] = [];
  if (!isObject(raw)) throw new BillSetError(["the bill set must be an object with vendors, accounts and bills"]);
  const list = (name: string, max: number, required: boolean): unknown[] => {
    const v = raw[name];
    if (v === undefined && !required) return [];
    if (!Array.isArray(v)) return void issues.push(`${name} must be a list`), [];
    if (v.length > max) issues.push(`${name}: more than ${max}`);
    return v;
  };
  const bills = list("bills", limits.maxBills, true);
  if (Array.isArray(raw.bills) && bills.length === 0) issues.push("bills: at least one bill is required");
  const vendorsRaw = list("vendors", limits.maxVendors, true);
  const accountsRaw = list("accounts", limits.maxAccounts, true);
  const priorRaw = list("priorBills", limits.maxPriorBills, false);

  const vendors = new Map<string, Vendor>();
  vendorsRaw.forEach((v, i) => {
    const vendor = vendorOf(v, `vendors[${i}]`, issues);
    if (vendor && vendors.has(vendor.id)) issues.push(`vendors[${i}]: vendor ${vendor.id} appears twice`);
    else if (vendor) vendors.set(vendor.id, vendor);
  });
  const accounts = new Map<string, Account>();
  accountsRaw.forEach((a, i) => {
    const account = accountOf(a, `accounts[${i}]`, issues);
    if (account && accounts.has(account.id)) issues.push(`accounts[${i}]: account ${account.id} appears twice`);
    else if (account) accounts.set(account.id, account);
  });
  const priorBills = priorRaw.map((p, i) => priorOf(p, `priorBills[${i}]`, issues)).filter((p): p is PriorBill => p !== null);

  const keys = new Map<string, number>();
  bills.forEach((b, i) => {
    const key = billKey(b);
    if (keys.has(key)) issues.push(`bills[${i}]: bill key ${key} also used by bills[${keys.get(key)}]`);
    keys.set(key, i);
  });

  if (issues.length) throw new BillSetError(issues);
  return { vendors, accounts, priorBills, bills };
}
