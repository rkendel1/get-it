/**
 * QuickBooks Online is operationally read-only: the connector has no mutation method, refuses
 * mutation intents before any request exists, and its transport guard refuses anything but reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRefusal, guardRequest, normalizeBill, pullSource, QboReadOnlyConnector, READ_OPERATIONS, type QboRequest } from "../src/qbo.js";
import { readOnly } from "../src/acceptance.js";
import { qboBill, qboPo } from "./_qbo.js";

function fakeTransport(pages: Record<string, unknown[][]> = {}) {
  const calls: QboRequest[] = [];
  const served = new Map<string, number>();
  const transport = async (r: QboRequest) => {
    calls.push(r);
    const entity = /FROM (\w+)/.exec(r.query?.query ?? "")?.[1] ?? "";
    const i = served.get(entity) ?? 0;
    served.set(entity, i + 1);
    return { QueryResponse: { [entity]: pages[entity]?.[i] ?? [] } };
  };
  return { transport, calls };
}

test("the connector has no mutation method", () => {
  const methods = Object.getOwnPropertyNames(QboReadOnlyConnector.prototype).filter((m) => m !== "constructor");
  assert.deepEqual(methods.sort(), ["invocations", "invoke", "listBills", "listPurchaseOrders"].sort());
  assert.deepEqual([...READ_OPERATIONS], ["bill.list", "bill.get", "purchaseOrder.list", "purchaseOrder.get"]);
});

test("mutation intents are refused before any request is made, and recorded", async () => {
  const { transport, calls } = fakeTransport();
  const c = new QboReadOnlyConnector({ realmId: "9130", transport });
  for (const op of ["bill.create", "bill.update", "bill.delete", "bill.void", "purchaseOrder.update", "billPayment.create", "invoice.send", "bill.sparseUpdate", "batch"]) {
    await assert.rejects(c.invoke(op, {}), (e: unknown) => e instanceof ConnectorRefusal && e.code === "MUTATION_REFUSED", op);
  }
  await assert.rejects(c.invoke("vendor.list", {}), (e: unknown) => e instanceof ConnectorRefusal && e.code === "UNKNOWN_OPERATION");
  assert.equal(calls.length, 0, "no request reached the transport");
  assert.equal(c.invocations.length, 10);
  assert.ok(c.invocations.every((i) => i.effect === "refused" && i.requests === 0));
});

test("the transport guard refuses anything but GET reads of bills and purchase orders", () => {
  const ok = (r: QboRequest) => assert.doesNotThrow(() => guardRequest("9130", r));
  const no = (r: QboRequest) => assert.throws(() => guardRequest("9130", r), (e: unknown) => e instanceof ConnectorRefusal && e.code === "REQUEST_REFUSED", JSON.stringify(r));
  ok({ method: "GET", path: "/v3/company/9130/query", query: { query: "SELECT * FROM Bill WHERE TxnDate >= '2026-10-01' STARTPOSITION 1 MAXRESULTS 1000", minorversion: "75" } });
  ok({ method: "GET", path: "/v3/company/9130/bill/42" });
  ok({ method: "GET", path: "/v3/company/9130/purchaseorder/7" });
  no({ method: "POST", path: "/v3/company/9130/bill" });
  no({ method: "POST", path: "/v3/company/9130/bill", query: { operation: "update" } });
  no({ method: "PUT", path: "/v3/company/9130/bill/42" });
  no({ method: "DELETE", path: "/v3/company/9130/bill/42" });
  no({ method: "GET", path: "/v3/company/9130/bill/42", query: { operation: "delete" } });
  no({ method: "GET", path: "/v3/company/9130/billpayment/1" });
  no({ method: "GET", path: "/v3/company/9130/batch" });
  no({ method: "GET", path: "/v3/company/9999/bill/42" }); // another company
  no({ method: "GET", path: "/v3/company/9130/query", query: { query: "SELECT * FROM Vendor" } });
  no({ method: "GET", path: "/v3/company/9130/query", query: { query: "SELECT * FROM Bill; DELETE FROM Bill" } });
  no({ method: "GET", path: "/v3/company/9130/query", query: { query: "UPDATE Bill SET Memo = 'x'" } });
});

test("reads page through QBO's query endpoint with GET only, and chunk purchase-order ids", async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1) }));
  const { transport, calls } = fakeTransport({ Bill: [page1, [{ Id: "1001" }]] });
  const c = new QboReadOnlyConnector({ realmId: "9130", transport });
  assert.equal((await c.listBills({ from: "2026-10-01", to: "2026-10-31" })).length, 1001);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((r) => r.method === "GET" && r.path === "/v3/company/9130/query"));
  assert.match(calls[1]!.query!.query!, /STARTPOSITION 1001 MAXRESULTS 1000$/);
  await assert.rejects(c.listBills({ from: "2026-10-31", to: "2026-10-01" }), ConnectorRefusal);
  await assert.rejects(c.invoke("bill.list", { from: "2026-10-01' OR '1'='1", to: "2026-10-31" }), ConnectorRefusal);

  const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
  await c.listPurchaseOrders(ids);
  const poQueries = calls.filter((r) => /FROM PurchaseOrder/.test(r.query?.query ?? ""));
  assert.equal(poQueries.length, 2, "150 ids → chunks of 100 and 50");
  assert.ok(c.invocations.every((i) => i.effect === "observation"));
});

test("pullSource normalizes bills and fetches only the purchase orders they link", async () => {
  const bill = qboBill({ id: "1", vendor: "V1", date: "2026-10-03", lines: [{ id: "1", item: "I1", qty: 2, price: 5, po: "100", poLine: "1" }] });
  const po = qboPo({ id: "100", vendor: "V1", lines: [{ id: "1", item: "I1", qty: 2, price: 5 }] });
  const { transport, calls } = fakeTransport({ Bill: [[bill]], PurchaseOrder: [[po]] });
  const c = new QboReadOnlyConnector({ realmId: "9130", transport });
  const source = await pullSource(c, { realmId: "9130", from: "2026-10-01", to: "2026-10-31", vendorIds: [] });
  assert.equal(source.bills[0]!.lines[0]!.unitPriceMicros, 5_000_000);
  assert.equal(source.purchaseOrders[0]!.id, "100");
  assert.match(calls[1]!.query!.query!, /Id IN \('100'\)/);
  assert.deepEqual(readOnly({ invocations: c.invocations } as never), []);
});

test("a refused mutation attempt fails the read_only acceptance criterion", async () => {
  const c = new QboReadOnlyConnector({ realmId: "9130", transport: fakeTransport().transport });
  await c.listBills({ from: "2026-10-01", to: "2026-10-31" });
  await assert.rejects(c.invoke("bill.update", {}));
  assert.deepEqual(readOnly({ invocations: c.invocations } as never), ["bill.update was attempted and refused (MUTATION_REFUSED)"]);
});

test("unrecognised QBO shapes fail the import instead of being skipped", () => {
  assert.throws(() => normalizeBill({ Id: "1", VendorRef: { value: "V" }, TxnDate: "2026-10-01", TotalAmt: 1, Line: [{ Id: "1", Amount: 1, DetailType: "GroupLineDetail" }] }), /unsupported DetailType/);
  assert.throws(() => normalizeBill({ Id: "1", VendorRef: { value: "V" }, TxnDate: "2026-10-01", TotalAmt: 1.005, Line: [{ Id: "1", Amount: 1, DetailType: "AccountBasedExpenseLineDetail" }] }), /more than 2 decimal/);
});
