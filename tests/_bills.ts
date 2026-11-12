/**
 * Ledger-compatible fixtures: vendors (Ledger contacts of kind vendor), accounts and bills, with
 * integer minor-unit amounts, plus the contract's currency, tax, documents and approval state.
 */
type Json = Record<string, unknown>;

export function bill(b: { id: string; vendorId: string; billNumber?: string; billDate: string; dueDate: string; currency?: string; status?: string; lines: Array<{ description?: string; accountId: string; amountMinor: unknown; taxMinor?: number }>; subtotalMinor?: number; taxMinor?: number; totalMinor?: unknown; documents?: Json[]; extra?: Json }): Json {
  const lines = b.lines.map((l) => ({ description: l.description ?? "Goods", accountId: l.accountId, amountMinor: l.amountMinor, ...(l.taxMinor !== undefined ? { taxMinor: l.taxMinor } : {}) }));
  const sum = lines.reduce((t, l) => t + (typeof l.amountMinor === "number" ? l.amountMinor : 0) + ((l as { taxMinor?: number }).taxMinor ?? 0), 0);
  return {
    id: b.id,
    vendorId: b.vendorId,
    ...(b.billNumber !== undefined ? { billNumber: b.billNumber } : {}),
    billDate: b.billDate,
    dueDate: b.dueDate,
    currency: b.currency ?? "USD",
    status: b.status ?? "draft",
    lines,
    ...(b.subtotalMinor !== undefined ? { subtotalMinor: b.subtotalMinor } : {}),
    ...(b.taxMinor !== undefined ? { taxMinor: b.taxMinor } : {}),
    totalMinor: b.totalMinor ?? sum,
    ...(b.documents ? { documents: b.documents } : {}),
    // Members Ledger stores that this format ignores:
    journalEntryId: "je_1",
    createdAt: 1_762_000_000_000,
    ...b.extra,
  };
}

export const vendors = [
  { id: "V1", kind: "vendor", name: "Acme Supplies", active: true, paymentTermsDays: 30, defaultAccountId: "6000" },
  { id: "V2", kind: "vendor", name: "Old Co", active: false },
  { id: "V3", kind: "vendor", name: "Euro GmbH", active: true },
];

export const accounts = [
  { id: "6000", number: "6000", name: "Office supplies", type: "expense", active: true },
  { id: "6100", number: "6100", name: "Software", type: "expense", active: true },
  { id: "6900", number: "6900", name: "Legacy", type: "expense", active: false },
];

const doc = (ref: string) => [{ ref, kind: "invoice", sha256: "a".repeat(64) }];

/**
 * Eleven bills, one or more per outcome. Review date 2026-11-10 (Tuesday), home currency USD.
 *   1 ready · 2 needs information · 3 arithmetic · 4 policy · 5 foreign currency
 *   6/7 duplicate in set · 8 duplicate of a prior bill · 9 malformed · 10 blocked (unknown vendor)
 *   11 ready and overdue
 */
export function billSet() {
  return {
    vendors,
    accounts,
    priorBills: [{ vendorId: "V1", billNumber: "A-050", billDate: "2026-09-01", totalMinor: 1000 }],
    bills: [
      bill({ id: "B1", vendorId: "V1", billNumber: "A-100", billDate: "2026-11-02", dueDate: "2026-12-02", lines: [{ description: "Paper", accountId: "6000", amountMinor: 4000, taxMinor: 320 }], subtotalMinor: 4000, taxMinor: 320 }),
      bill({ id: "B2", vendorId: "V1", billNumber: "A-101", billDate: "2026-11-03", dueDate: "2026-12-03", lines: [{ accountId: "6100", amountMinor: 12000 }] }),
      bill({ id: "B3", vendorId: "V1", billNumber: "A-102", billDate: "2026-11-03", dueDate: "2026-12-03", lines: [{ accountId: "6000", amountMinor: 5000 }, { accountId: "6000", amountMinor: 2500 }], totalMinor: 7600, documents: doc("inv/A-102.pdf") }),
      bill({ id: "B4", vendorId: "V2", billNumber: "OC-7", billDate: "2026-11-04", dueDate: "2026-11-20", lines: [{ accountId: "6900", amountMinor: 2000 }] }),
      bill({ id: "B5", vendorId: "V3", billNumber: "E-55", billDate: "2026-11-05", dueDate: "2026-12-05", currency: "EUR", lines: [{ accountId: "6100", amountMinor: 90000 }], documents: doc("inv/E-55.pdf") }),
      bill({ id: "B6", vendorId: "V1", billNumber: "A-200", billDate: "2026-11-01", dueDate: "2026-12-01", lines: [{ accountId: "6000", amountMinor: 3000 }] }),
      bill({ id: "B7", vendorId: "V1", billNumber: " a-200 ", billDate: "2026-11-06", dueDate: "2026-12-06", lines: [{ accountId: "6000", amountMinor: 3100 }] }),
      bill({ id: "B8", vendorId: "V1", billNumber: "A-050", billDate: "2026-11-07", dueDate: "2026-12-07", lines: [{ accountId: "6000", amountMinor: 1000 }] }),
      bill({ id: "B9", vendorId: "V1", billDate: "2026-11-08", dueDate: "2026-12-08", lines: [{ accountId: "6000", amountMinor: 12.5 }], totalMinor: 12.5 }),
      bill({ id: "B10", vendorId: "V9", billNumber: "X-1", billDate: "2026-11-08", dueDate: "2026-12-08", lines: [{ accountId: "6000", amountMinor: 500 }] }),
      bill({ id: "B11", vendorId: "V1", billNumber: "A-090", billDate: "2026-10-01", dueDate: "2026-10-31", lines: [{ accountId: "6000", amountMinor: 2500 }] }),
    ],
  };
}

export const SCOPE = { homeCurrency: "USD", timeZone: "America/New_York", asOfDate: "2026-11-10", policy: { documentRequiredOverMinor: 7500, dueSoonBusinessDays: 5 } };
