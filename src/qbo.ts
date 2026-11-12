/**
 * QuickBooks Online, operationally read-only.
 *
 * QuickBooks Online has no read-only accounting scope: a `com.intuit.quickbooks.accounting`
 * credential can technically write. get-it's guarantee is therefore in this module, not in the
 * credential:
 *
 *   1. The connector has no mutation method. Its only operations are the four reads below.
 *   2. `invoke()` refuses any other operation, and names a mutation intent as such, before any
 *      request is built. A refusal is recorded, so it shows up as evidence.
 *   3. The transport guard refuses anything but an HTTP GET to the QBO `query` endpoint (a SELECT on
 *      Bill or PurchaseOrder) or to a single Bill or PurchaseOrder read. A refused request never
 *      reaches the transport.
 *
 * The transport is injected, so tests and the in-memory adapter never touch the network. The real
 * transport (OAuth, base URL, retries on 429/5xx) is outside this module and is Phase 1 work.
 *
 * Records are normalized to connector-neutral canonical shapes. Amounts are integer cents, unit
 * prices and quantities integer micros (see money.ts). Anything the normalizer does not understand
 * fails the import (fail closed) instead of being skipped.
 */
import { AmountError, cents, micros } from "./money.js";

// ---- canonical records -------------------------------------------------------------------------

export interface PoLink {
  readonly poId: string;
  readonly poLineId?: string;
}

export interface CanonicalLine {
  readonly lineId: string;
  /** `item`: quantity and unit price from the source. `account`: amount only, compared as 1 × amount. */
  readonly kind: "item" | "account";
  readonly itemId?: string;
  readonly quantityMicros: number;
  readonly unitPriceMicros: number;
  readonly amountCents: number;
  readonly poLink?: PoLink;
}

export interface CanonicalBill {
  readonly id: string;
  readonly docNumber?: string;
  readonly vendorId: string;
  readonly txnDate: string;
  readonly currency: string;
  /** QBO TotalAmt (may include tax). */
  readonly totalCents: number;
  /** Sum of line amounts: the pre-tax basis the contract compares. */
  readonly lineTotalCents: number;
  readonly lines: readonly CanonicalLine[];
}

export interface CanonicalPurchaseOrder {
  readonly id: string;
  readonly docNumber?: string;
  readonly vendorId: string;
  readonly txnDate: string;
  readonly currency: string;
  readonly totalCents: number;
  readonly lines: readonly CanonicalLine[];
}

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

type Json = Record<string, any>;

const ONE = 1_000_000; // one unit, in micros

function str(v: unknown, what: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new NormalizationError(`${what} is missing`);
}

function date(v: unknown, what: string): string {
  const s = str(v, what);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new NormalizationError(`${what} is not an ISO date: ${s}`);
  return s;
}

function money<T>(fn: () => T, where: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AmountError) throw new NormalizationError(`${where}: ${e.message}`);
    throw e;
  }
}

function poLinkOf(line: Json): PoLink | undefined {
  const links: Json[] = Array.isArray(line.LinkedTxn) ? line.LinkedTxn : [];
  const pos = links.filter((l) => l?.TxnType === "PurchaseOrder");
  if (pos.length === 0) return undefined;
  if (pos.length > 1) throw new NormalizationError(`line ${line.Id} links ${pos.length} purchase orders`);
  const l = pos[0]!;
  return { poId: str(l.TxnId, "LinkedTxn.TxnId"), ...(l.TxnLineId !== undefined ? { poLineId: str(l.TxnLineId, "LinkedTxn.TxnLineId") } : {}) };
}

function lineOf(line: Json, where: string, withLinks: boolean): CanonicalLine {
  const lineId = str(line.Id, `${where} Line.Id`);
  const at = `${where} line ${lineId}`;
  const amountCents = money(() => cents(line.Amount, `${at} Amount`), at);
  const link = withLinks ? poLinkOf(line) : undefined;
  if (line.DetailType === "ItemBasedExpenseLineDetail") {
    const d: Json = line.ItemBasedExpenseLineDetail ?? {};
    const itemId = d.ItemRef?.value !== undefined ? str(d.ItemRef.value, `${at} ItemRef`) : undefined;
    if (d.Qty === undefined || d.UnitPrice === undefined) {
      // No quantity or unit price recorded: only the amount can be compared.
      return { lineId, kind: "account", ...(itemId ? { itemId } : {}), quantityMicros: ONE, unitPriceMicros: amountCents * 10_000, amountCents, ...(link ? { poLink: link } : {}) };
    }
    return {
      lineId,
      kind: "item",
      ...(itemId ? { itemId } : {}),
      quantityMicros: money(() => micros(d.Qty, `${at} Qty`), at),
      unitPriceMicros: money(() => micros(d.UnitPrice, `${at} UnitPrice`), at),
      amountCents,
      ...(link ? { poLink: link } : {}),
    };
  }
  if (line.DetailType === "AccountBasedExpenseLineDetail") {
    return { lineId, kind: "account", quantityMicros: ONE, unitPriceMicros: amountCents * 10_000, amountCents, ...(link ? { poLink: link } : {}) };
  }
  throw new NormalizationError(`${at}: unsupported DetailType ${String(line.DetailType)}`);
}

function header(r: Json, kind: string) {
  const id = str(r.Id, `${kind}.Id`);
  const where = `${kind} ${id}`;
  return {
    id,
    where,
    ...(typeof r.DocNumber === "string" && r.DocNumber.trim() ? { docNumber: r.DocNumber.trim() } : {}),
    vendorId: str(r.VendorRef?.value, `${where} VendorRef`),
    txnDate: date(r.TxnDate, `${where} TxnDate`),
    // QBO omits CurrencyRef when multicurrency is off: the company's home currency applies.
    currency: typeof r.CurrencyRef?.value === "string" ? r.CurrencyRef.value : "HOME",
    totalCents: money(() => cents(r.TotalAmt, `${where} TotalAmt`), where),
  };
}

export function normalizeBill(r: Json): CanonicalBill {
  const h = header(r, "Bill");
  const lines = (Array.isArray(r.Line) ? r.Line : []).map((l: Json) => lineOf(l, h.where, true));
  if (lines.length === 0) throw new NormalizationError(`${h.where} has no lines`);
  const { where: _w, ...rest } = h;
  return { ...rest, lines, lineTotalCents: lines.reduce((t: number, l: CanonicalLine) => t + l.amountCents, 0) };
}

export function normalizePurchaseOrder(r: Json): CanonicalPurchaseOrder {
  const h = header(r, "PurchaseOrder");
  const lines = (Array.isArray(r.Line) ? r.Line : []).map((l: Json) => lineOf(l, h.where, false));
  if (lines.length === 0) throw new NormalizationError(`${h.where} has no lines`);
  const { where: _w, ...rest } = h;
  return { ...rest, lines };
}

// ---- the read-only connector -------------------------------------------------------------------

export const READ_OPERATIONS = ["bill.list", "bill.get", "purchaseOrder.list", "purchaseOrder.get"] as const;
export type ReadOperation = (typeof READ_OPERATIONS)[number];

const MUTATION_WORDS = new Set(["create", "insert", "add", "update", "upsert", "patch", "sparse", "replace", "delete", "remove", "void", "send", "email", "pay", "payment", "approve", "post", "write", "batch", "import", "merge"]);

/** Whether an operation name reads as a mutation: any word (split on . : _ - and camelCase) is a mutation verb. */
export function isMutationIntent(operation: string): boolean {
  return operation.split(/[.:_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/).some((w) => MUTATION_WORDS.has(w.toLowerCase()));
}

export class ConnectorRefusal extends Error {
  readonly code: "MUTATION_REFUSED" | "UNKNOWN_OPERATION" | "REQUEST_REFUSED";
  constructor(code: ConnectorRefusal["code"], message: string) {
    super(message);
    this.name = "ConnectorRefusal";
    this.code = code;
  }
}

export interface QboRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
}

export type QboTransport = (request: QboRequest & { method: "GET" }) => Promise<unknown>;

export interface Invocation {
  readonly operation: string;
  readonly effect: "observation" | "refused";
  readonly refusal?: ConnectorRefusal["code"];
  readonly requests: number;
  readonly at: number;
}

const QUERY_STATEMENT = /^SELECT \* FROM (Bill|PurchaseOrder)( WHERE [^;]*)?( STARTPOSITION \d+)?( MAXRESULTS \d+)?$/;
const FORBIDDEN_IN_QUERY = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT)\b|;/i;

/** Refuse anything but the reads this connector needs, before it reaches the transport. */
export function guardRequest(realmId: string, request: QboRequest): QboRequest & { method: "GET" } {
  if (request.method !== "GET") throw new ConnectorRefusal("REQUEST_REFUSED", `${request.method} refused: the connector only reads (GET)`);
  const base = `/v3/company/${realmId}/`;
  if (!request.path.startsWith(base)) throw new ConnectorRefusal("REQUEST_REFUSED", `path outside the company: ${request.path}`);
  const rest = request.path.slice(base.length);
  if (rest === "query") {
    const statement = request.query?.query ?? "";
    if (FORBIDDEN_IN_QUERY.test(statement) || !QUERY_STATEMENT.test(statement)) throw new ConnectorRefusal("REQUEST_REFUSED", `query refused: ${statement}`);
  } else if (!/^(bill|purchaseorder)\/\d+$/.test(rest)) {
    throw new ConnectorRefusal("REQUEST_REFUSED", `path refused: ${request.path}`);
  }
  const extra = Object.keys(request.query ?? {}).filter((k) => k !== "query" && k !== "minorversion");
  if (extra.length) throw new ConnectorRefusal("REQUEST_REFUSED", `query parameters refused: ${extra.join(", ")}`);
  return request as QboRequest & { method: "GET" };
}

const PAGE = 1000;
const ID_CHUNK = 100;

/** Quote a value for a QBO query literal. Ids and dates are validated before they get here. */
function literal(v: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new ConnectorRefusal("REQUEST_REFUSED", `unsafe query value: ${v}`);
  return `'${v}'`;
}

export class QboReadOnlyConnector {
  readonly realmId: string;
  readonly #transport: QboTransport;
  readonly #now: () => number;
  readonly #log: Invocation[] = [];

  constructor(options: { realmId: string; transport: QboTransport; now?: () => number }) {
    if (!/^\d+$/.test(options.realmId)) throw new Error("realmId must be numeric");
    this.realmId = options.realmId;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
  }

  /** Every operation asked of this connector, refused ones included. */
  get invocations(): readonly Invocation[] {
    return this.#log;
  }

  /** The one dispatch point: an operation by name. Anything but the four reads is refused. */
  async invoke(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!(READ_OPERATIONS as readonly string[]).includes(operation)) {
      const code = isMutationIntent(operation) ? "MUTATION_REFUSED" : "UNKNOWN_OPERATION";
      this.#log.push({ operation, effect: "refused", refusal: code, requests: 0, at: this.#now() });
      throw new ConnectorRefusal(code, code === "MUTATION_REFUSED" ? `${operation} refused: QuickBooks Online is read-only for get-it` : `${operation} is not a connector operation`);
    }
    let requests = 0;
    const get = async (path: string, query?: Record<string, string>) => {
      const request = guardRequest(this.realmId, { method: "GET", path: `/v3/company/${this.realmId}/${path}`, query: { ...query, minorversion: "75" } });
      requests++;
      return (await this.#transport(request)) as Json;
    };
    try {
      switch (operation as ReadOperation) {
        case "bill.list":
          return await this.#select(get, "Bill", billWhere(args));
        case "purchaseOrder.list":
          return await this.#selectIds(get, "PurchaseOrder", stringArray(args.ids, "ids"));
        case "bill.get":
          return (await get(`bill/${numericId(args.id)}`)).Bill;
        case "purchaseOrder.get":
          return (await get(`purchaseorder/${numericId(args.id)}`)).PurchaseOrder;
      }
    } finally {
      this.#log.push({ operation, effect: "observation", requests, at: this.#now() });
    }
  }

  listBills(range: { from: string; to: string }): Promise<Json[]> {
    return this.invoke("bill.list", range) as Promise<Json[]>;
  }

  listPurchaseOrders(ids: readonly string[]): Promise<Json[]> {
    return this.invoke("purchaseOrder.list", { ids: [...ids] }) as Promise<Json[]>;
  }

  async #select(get: (p: string, q?: Record<string, string>) => Promise<Json>, entity: "Bill" | "PurchaseOrder", where: string): Promise<Json[]> {
    const out: Json[] = [];
    for (let start = 1; ; start += PAGE) {
      const r = await get("query", { query: `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ""} STARTPOSITION ${start} MAXRESULTS ${PAGE}` });
      const page: Json[] = r.QueryResponse?.[entity] ?? [];
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  async #selectIds(get: (p: string, q?: Record<string, string>) => Promise<Json>, entity: "PurchaseOrder", ids: string[]): Promise<Json[]> {
    const unique = [...new Set(ids)].sort();
    const out: Json[] = [];
    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      const chunk = unique.slice(i, i + ID_CHUNK);
      out.push(...(await this.#select(get, entity, `Id IN (${chunk.map(literal).join(", ")})`)));
    }
    return out;
  }
}

function billWhere(args: Record<string, unknown>): string {
  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new ConnectorRefusal("REQUEST_REFUSED", "bill.list needs an ISO date range from ≤ to");
  return `TxnDate >= ${literal(from)} AND TxnDate <= ${literal(to)}`;
}

function stringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConnectorRefusal("REQUEST_REFUSED", `${what} must be an array of ids`);
  return v as string[];
}

function numericId(v: unknown): string {
  const s = String(v ?? "");
  if (!/^\d+$/.test(s)) throw new ConnectorRefusal("REQUEST_REFUSED", `not a QBO id: ${s}`);
  return s;
}

// ---- snapshot ----------------------------------------------------------------------------------

export interface SourceScope {
  readonly realmId: string;
  readonly from: string;
  readonly to: string;
  /** Empty: all vendors. */
  readonly vendorIds: readonly string[];
}

/**
 * Pull the in-scope bills and the purchase orders they link to, normalized. A purchase order a bill
 * links to that QBO does not return is simply absent (the reconciliation reports po_not_found).
 */
export async function pullSource(connector: QboReadOnlyConnector, scope: SourceScope) {
  const vendors = new Set(scope.vendorIds);
  const bills = (await connector.listBills({ from: scope.from, to: scope.to })).map(normalizeBill).filter((b) => vendors.size === 0 || vendors.has(b.vendorId));
  const poIds = [...new Set(bills.flatMap((b) => b.lines.flatMap((l) => (l.poLink ? [l.poLink.poId] : []))))];
  const purchaseOrders = poIds.length ? (await connector.listPurchaseOrders(poIds)).map(normalizePurchaseOrder) : [];
  return { bills, purchaseOrders };
}
