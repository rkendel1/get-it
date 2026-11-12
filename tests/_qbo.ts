/**
 * Fixtures in QuickBooks Online's own JSON shape (Bill, PurchaseOrder), as the connector returns them.
 * Amounts are written as QBO sends them: JSON numbers.
 */
export type Line =
  | { id: string; item: string; qty: number; price: number; amount?: number; po?: string; poLine?: string }
  | { id: string; account: true; amount: number; po?: string; poLine?: string };

function qboLine(l: Line, withLinks: boolean) {
  const linked = withLinks && l.po ? { LinkedTxn: [{ TxnId: l.po, TxnType: "PurchaseOrder", ...(l.poLine ? { TxnLineId: l.poLine } : {}) }] } : {};
  if ("account" in l) return { Id: l.id, Amount: l.amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } }, ...linked };
  const amount = l.amount ?? Math.round(l.qty * l.price * 100) / 100;
  return { Id: l.id, Amount: amount, DetailType: "ItemBasedExpenseLineDetail", ItemBasedExpenseLineDetail: { ItemRef: { value: l.item }, Qty: l.qty, UnitPrice: l.price }, ...linked };
}

export function qboBill(b: { id: string; vendor: string; date: string; doc?: string; currency?: string; tax?: number; lines: Line[] }) {
  const lines = b.lines.map((l) => qboLine(l, true));
  const lineTotal = lines.reduce((t, l) => t + Math.round(l.Amount * 100), 0);
  return {
    Id: b.id,
    SyncToken: "0",
    ...(b.doc !== undefined ? { DocNumber: b.doc } : {}),
    VendorRef: { value: b.vendor },
    TxnDate: b.date,
    ...(b.currency ? { CurrencyRef: { value: b.currency } } : {}),
    TotalAmt: (lineTotal + Math.round((b.tax ?? 0) * 100)) / 100,
    Line: lines,
  };
}

export function qboPo(p: { id: string; vendor: string; date?: string; doc?: string; currency?: string; lines: Line[] }) {
  const lines = p.lines.map((l) => qboLine(l, false));
  return {
    Id: p.id,
    SyncToken: "0",
    ...(p.doc !== undefined ? { DocNumber: p.doc } : {}),
    VendorRef: { value: p.vendor },
    TxnDate: p.date ?? "2026-10-01",
    ...(p.currency ? { CurrencyRef: { value: p.currency } } : {}),
    TotalAmt: lines.reduce((t, l) => t + Math.round(l.Amount * 100), 0) / 100,
    POStatus: "Open",
    Line: lines,
  };
}

/**
 * A month of bills exercising every outcome:
 *   B1 matched · B2 within tolerance · B3 price + total variance · B4 no PO ($800, review)
 *   B5/B6 duplicates (customer decision) · B7 partial billing of PO 400 · B8 completes PO 400
 */
export function scenario() {
  const purchaseOrders = [
    qboPo({ id: "100", vendor: "V1", lines: [{ id: "1", item: "I1", qty: 10, price: 25 }, { id: "2", item: "I2", qty: 5, price: 100 }] }),
    qboPo({ id: "200", vendor: "V2", lines: [{ id: "1", account: true, amount: 1000 }] }),
    qboPo({ id: "300", vendor: "V1", lines: [{ id: "1", item: "I3", qty: 100, price: 12.5 }] }),
    qboPo({ id: "400", vendor: "V4", lines: [{ id: "1", item: "I4", qty: 20, price: 30 }] }),
  ];
  const bills = [
    qboBill({ id: "1", vendor: "V1", date: "2026-10-03", doc: "INV-1", tax: 60, lines: [{ id: "1", item: "I1", qty: 10, price: 25, po: "100", poLine: "1" }, { id: "2", item: "I2", qty: 5, price: 100, po: "100", poLine: "2" }] }),
    qboBill({ id: "2", vendor: "V2", date: "2026-10-04", doc: "A-77", lines: [{ id: "1", account: true, amount: 1004, po: "200", poLine: "1" }] }),
    qboBill({ id: "3", vendor: "V1", date: "2026-10-05", doc: "INV-2", lines: [{ id: "1", item: "I3", qty: 100, price: 14, po: "300", poLine: "1" }] }),
    qboBill({ id: "4", vendor: "V3", date: "2026-10-06", doc: "S-1", lines: [{ id: "1", account: true, amount: 800 }] }),
    qboBill({ id: "5", vendor: "V5", date: "2026-10-07", doc: "D-9", lines: [{ id: "1", account: true, amount: 40 }] }),
    qboBill({ id: "6", vendor: "V5", date: "2026-10-08", doc: " d-9 ", lines: [{ id: "1", account: true, amount: 40 }] }),
    qboBill({ id: "7", vendor: "V4", date: "2026-10-09", doc: "P-1", lines: [{ id: "1", item: "I4", qty: 12, price: 30, po: "400", poLine: "1" }] }),
    qboBill({ id: "8", vendor: "V4", date: "2026-10-20", doc: "P-2", lines: [{ id: "1", item: "I4", qty: 8, price: 30, po: "400", poLine: "1" }] }),
  ];
  return { bills, purchaseOrders };
}
