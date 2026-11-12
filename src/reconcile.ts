/**
 * Two-way reconciliation of supplier bills against purchase orders, exactly as the frozen contract
 * states it. Deterministic: the same snapshot and contract always give the same output, byte for
 * byte (verified by the `arithmetic` acceptance criterion and by the integrity check). No model,
 * no clock, no randomness.
 */
import { digest } from "./canonical.js";
import type { FrozenContract } from "./contract.js";
import { absDiff, extendCents } from "./money.js";
import type { CanonicalBill, CanonicalLine, CanonicalPurchaseOrder } from "./qbo.js";
import type { ManifestEntry, Snapshot } from "./snapshot.js";
import { quantityWithin, totalWithin, unitPriceWithin } from "./tolerance.js";

export type RecordStatus = "matched" | "matched_within_tolerance" | "discrepancy" | "unmatched";
export type ExceptionType =
  | "no_po_reference"
  | "po_not_found"
  | "po_line_ambiguous"
  | "supplier_mismatch"
  | "currency_mismatch"
  | "price_variance"
  | "quantity_variance"
  | "total_variance"
  | "po_overbilled"
  | "duplicate_invoice";

const UNMATCHED: ReadonlySet<ExceptionType> = new Set(["no_po_reference", "po_not_found"]);

export interface LineResult {
  readonly lineId: string;
  readonly poId: string | null;
  readonly poLineId: string | null;
  readonly billQuantityMicros: number;
  readonly billUnitPriceMicros: number;
  readonly poQuantityMicros: number | null;
  readonly poUnitPriceMicros: number | null;
  readonly unitPriceDeltaMicros: number | null;
  readonly quantityDeltaMicros: number | null;
  readonly unitPriceWithin: boolean | null;
  readonly quantityExact: boolean | null;
  /** bill quantity × PO unit price, in cents; null when the line has no resolved PO line. */
  readonly expectedCents: number | null;
}

export interface ReconciledRecord {
  readonly billId: string;
  readonly docNumber: string | null;
  readonly vendorId: string;
  readonly txnDate: string;
  readonly currency: string;
  readonly status: RecordStatus;
  readonly poIds: readonly string[];
  readonly lines: readonly LineResult[];
  readonly lineTotalCents: number;
  readonly taxCents: number;
  readonly expectedTotalCents: number | null;
  readonly totalDeltaCents: number | null;
  readonly totalWithin: boolean | null;
  readonly exceptionIds: readonly string[];
  readonly sources: readonly ManifestEntry[];
}

export interface ReconciliationException {
  readonly id: string;
  readonly billId: string;
  readonly lineId: string | null;
  readonly type: ExceptionType;
  readonly currency: string;
  readonly amountAtStakeCents: number;
  readonly requiresReview: boolean;
  readonly decision: "operator" | "customer";
  readonly detail: Readonly<Record<string, string | number | null>>;
  readonly sources: readonly ManifestEntry[];
}

export interface ReconciliationOutput {
  readonly contract: string;
  readonly contractDigest: string;
  readonly snapshotDigest: string;
  readonly records: readonly ReconciledRecord[];
  readonly exceptions: readonly ReconciliationException[];
  readonly summary: Readonly<Record<RecordStatus, number>> & { readonly exceptions: number; readonly requiringReview: number; readonly customerDecisions: number };
}

const byTxn = (a: CanonicalBill, b: CanonicalBill) => (a.txnDate !== b.txnDate ? (a.txnDate < b.txnDate ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function duplicateKey(b: CanonicalBill): string {
  return b.docNumber ? `doc|${b.vendorId}|${b.docNumber.trim().toLowerCase()}` : `nodoc|${b.vendorId}|${b.txnDate}|${b.totalCents}`;
}

/** Resolve a bill line's PO line: by TxnLineId, else the single PO line with the same item. */
function resolvePoLine(line: CanonicalLine, po: CanonicalPurchaseOrder): CanonicalLine | "ambiguous" {
  if (line.poLink?.poLineId !== undefined) return po.lines.find((l) => l.lineId === line.poLink!.poLineId) ?? "ambiguous";
  if (!line.itemId) return po.lines.length === 1 ? po.lines[0]! : "ambiguous";
  const candidates = po.lines.filter((l) => l.itemId === line.itemId);
  return candidates.length === 1 ? candidates[0]! : "ambiguous";
}

export function reconcile(snapshot: Snapshot, contract: FrozenContract): ReconciliationOutput {
  const t = contract.tolerances;
  const manifest = new Map(snapshot.manifest.map((m) => [`${m.kind}:${m.id}`, m]));
  const src = (kind: "bill" | "purchaseOrder", id: string) => {
    const m = manifest.get(`${kind}:${id}`);
    if (!m) throw new Error(`reconcile: ${kind} ${id} is not in the snapshot manifest`);
    return m;
  };
  const pos = new Map(snapshot.purchaseOrders.map((p) => [p.id, p]));
  const home = snapshot.scope.homeCurrency;
  const isHome = (c: string) => c === "HOME" || c === home;

  const dupGroups = new Map<string, string[]>();
  for (const b of snapshot.bills) dupGroups.set(duplicateKey(b), [...(dupGroups.get(duplicateKey(b)) ?? []), b.id]);

  /** Cumulative billed quantity per PO line, across bills in (TxnDate, Id) order. */
  const billedPerPoLine = new Map<string, number>();

  const records: ReconciledRecord[] = [];
  const exceptions: ReconciliationException[] = [];

  for (const bill of [...snapshot.bills].sort(byTxn)) {
    const billSrc = src("bill", bill.id);
    const found: ReconciliationException[] = [];
    const add = (type: ExceptionType, lineId: string | null, stake: number, detail: Record<string, string | number | null>, extra: ManifestEntry[] = []) => {
      const id = `${bill.id}:${type}:${lineId ?? "-"}`;
      if (found.some((e) => e.id === id)) return;
      const decision = contract.customerDecisionTypes.has(type) ? "customer" : "operator";
      found.push({
        id,
        billId: bill.id,
        lineId,
        type,
        currency: bill.currency === "HOME" ? home : bill.currency,
        amountAtStakeCents: stake,
        requiresReview: stake > contract.reviewOverCents || (contract.reviewForeignCurrency && !isHome(bill.currency)),
        decision,
        detail,
        sources: [billSrc, ...extra],
      });
    };

    const linked = bill.lines.some((l) => l.poLink);
    const poIds = [...new Set(bill.lines.flatMap((l) => (l.poLink ? [l.poLink.poId] : [])))].sort();
    if (!linked) add("no_po_reference", null, bill.lineTotalCents, { docNumber: bill.docNumber ?? null });

    const lineResults: LineResult[] = [];
    let allResolved = linked;
    let expectedTotal = 0;
    let anyNonZeroVariance = false;

    for (const line of bill.lines) {
      const base = { lineId: line.lineId, billQuantityMicros: line.quantityMicros, billUnitPriceMicros: line.unitPriceMicros };
      const empty = { poQuantityMicros: null, poUnitPriceMicros: null, unitPriceDeltaMicros: null, quantityDeltaMicros: null, unitPriceWithin: null, quantityExact: null, expectedCents: null };
      if (!line.poLink) {
        if (linked) add("no_po_reference", line.lineId, line.amountCents, { amountCents: line.amountCents });
        allResolved = false;
        lineResults.push({ ...base, poId: null, poLineId: null, ...empty });
        continue;
      }
      const po = pos.get(line.poLink.poId);
      if (!po) {
        add("po_not_found", line.lineId, line.amountCents, { poId: line.poLink.poId });
        allResolved = false;
        lineResults.push({ ...base, poId: line.poLink.poId, poLineId: line.poLink.poLineId ?? null, ...empty });
        continue;
      }
      const poSrc = src("purchaseOrder", po.id);
      if (po.vendorId !== bill.vendorId) add("supplier_mismatch", null, bill.lineTotalCents, { billVendorId: bill.vendorId, poVendorId: po.vendorId, poId: po.id }, [poSrc]);
      if (po.currency !== bill.currency) add("currency_mismatch", null, bill.lineTotalCents, { billCurrency: bill.currency, poCurrency: po.currency, poId: po.id }, [poSrc]);
      const poLine = resolvePoLine(line, po);
      if (poLine === "ambiguous") {
        add("po_line_ambiguous", line.lineId, line.amountCents, { poId: po.id, poLineId: line.poLink.poLineId ?? null, itemId: line.itemId ?? null }, [poSrc]);
        allResolved = false;
        lineResults.push({ ...base, poId: po.id, poLineId: line.poLink.poLineId ?? null, ...empty });
        continue;
      }

      const priceDelta = line.unitPriceMicros - poLine.unitPriceMicros;
      const qtyDelta = line.quantityMicros - poLine.quantityMicros;
      const priceOk = unitPriceWithin(line.unitPriceMicros, poLine.unitPriceMicros, t);
      const qtyOk = quantityWithin(line.quantityMicros, poLine.quantityMicros, t);
      const expected = extendCents(line.quantityMicros, poLine.unitPriceMicros);
      expectedTotal += expected;
      if (priceDelta !== 0) anyNonZeroVariance = true;

      if (!priceOk) add("price_variance", line.lineId, extendCents(line.quantityMicros, absDiff(line.unitPriceMicros, poLine.unitPriceMicros)), { poId: po.id, poLineId: poLine.lineId, billUnitPriceMicros: line.unitPriceMicros, poUnitPriceMicros: poLine.unitPriceMicros }, [poSrc]);
      if (!qtyOk) add("quantity_variance", line.lineId, extendCents(absDiff(line.quantityMicros, poLine.quantityMicros), poLine.unitPriceMicros), { poId: po.id, poLineId: poLine.lineId, billQuantityMicros: line.quantityMicros, poQuantityMicros: poLine.quantityMicros, cumulativeBilledQuantityMicros: (billedPerPoLine.get(`${po.id}:${poLine.lineId}`) ?? 0) + line.quantityMicros }, [poSrc]);

      const key = `${po.id}:${poLine.lineId}`;
      const before = billedPerPoLine.get(key) ?? 0;
      const after = before + line.quantityMicros;
      billedPerPoLine.set(key, after);
      if (after > poLine.quantityMicros) {
        const excess = Math.min(line.quantityMicros, after - Math.max(before, poLine.quantityMicros));
        add("po_overbilled", line.lineId, extendCents(excess, poLine.unitPriceMicros), { poId: po.id, poLineId: poLine.lineId, poQuantityMicros: poLine.quantityMicros, cumulativeBilledQuantityMicros: after }, [poSrc]);
      }

      lineResults.push({
        ...base,
        poId: po.id,
        poLineId: poLine.lineId,
        poQuantityMicros: poLine.quantityMicros,
        poUnitPriceMicros: poLine.unitPriceMicros,
        unitPriceDeltaMicros: priceDelta,
        quantityDeltaMicros: qtyDelta,
        unitPriceWithin: priceOk,
        quantityExact: qtyOk,
        expectedCents: expected,
      });
    }

    let totalDelta: number | null = null;
    let totalOk: boolean | null = null;
    if (allResolved) {
      totalDelta = bill.lineTotalCents - expectedTotal;
      totalOk = totalWithin(bill.lineTotalCents, expectedTotal, t);
      if (totalDelta !== 0) anyNonZeroVariance = true;
      if (!totalOk) add("total_variance", null, Math.abs(totalDelta), { lineTotalCents: bill.lineTotalCents, expectedTotalCents: expectedTotal });
    }

    const group = dupGroups.get(duplicateKey(bill))!;
    if (group.length > 1) add("duplicate_invoice", null, bill.lineTotalCents, { duplicateOf: group.filter((id) => id !== bill.id).sort().join(",") });

    found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const status: RecordStatus = found.some((e) => UNMATCHED.has(e.type)) ? "unmatched" : found.length ? "discrepancy" : anyNonZeroVariance ? "matched_within_tolerance" : "matched";
    const sources = [billSrc, ...poIds.flatMap((id) => (pos.has(id) ? [src("purchaseOrder", id)] : []))];
    records.push({
      billId: bill.id,
      docNumber: bill.docNumber ?? null,
      vendorId: bill.vendorId,
      txnDate: bill.txnDate,
      currency: bill.currency === "HOME" ? home : bill.currency,
      status,
      poIds,
      lines: lineResults,
      lineTotalCents: bill.lineTotalCents,
      taxCents: bill.totalCents - bill.lineTotalCents,
      expectedTotalCents: allResolved ? expectedTotal : null,
      totalDeltaCents: totalDelta,
      totalWithin: totalOk,
      exceptionIds: found.map((e) => e.id),
      sources,
    });
    exceptions.push(...found);
  }

  records.sort((a, b) => (a.billId < b.billId ? -1 : a.billId > b.billId ? 1 : 0));
  exceptions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const count = (s: RecordStatus) => records.filter((r) => r.status === s).length;
  return {
    contract: contract.key,
    contractDigest: contract.digest,
    snapshotDigest: snapshot.digest,
    records,
    exceptions,
    summary: {
      matched: count("matched"),
      matched_within_tolerance: count("matched_within_tolerance"),
      discrepancy: count("discrepancy"),
      unmatched: count("unmatched"),
      exceptions: exceptions.length,
      requiringReview: exceptions.filter((e) => e.requiresReview).length,
      customerDecisions: exceptions.filter((e) => e.decision === "customer").length,
    },
  };
}

/** The digest an approval binds to: the contract, the exact source and the exact output. */
export function packetDigest(output: ReconciliationOutput): string {
  return digest({ kind: "get-it.delivery-packet/1", contract: output.contract, contractDigest: output.contractDigest, snapshotDigest: output.snapshotDigest, output: digest(output) });
}
