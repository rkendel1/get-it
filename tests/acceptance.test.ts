/**
 * The review package and the eight acceptance criteria: a correct delivery passes all of them, and
 * each criterion catches the failure it exists for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, publishable, type Delivery } from "../src/acceptance.js";
import { turnaroundDeadline } from "../src/calendar.js";
import { digest } from "../src/canonical.js";
import { loadFrozenContract } from "../src/contract.js";
import { buildPackage, PACKET_FILE, verifyPackage } from "../src/deliverables.js";
import { review } from "../src/review.js";
import { buildSnapshot } from "../src/snapshot.js";
import { billSet, SCOPE } from "./_bills.js";

const contract = loadFrozenContract();
const at = (iso: string) => Date.parse(iso);

function delivery(): Delivery {
  const snapshot = buildSnapshot(SCOPE, billSet(), contract);
  const output = review(snapshot, contract);
  const pkg = buildPackage(output);
  const start = at("2026-11-02T14:00:00Z"); // Monday 09:00 New York
  const { deadline } = turnaroundDeadline({ start, timeZone: "America/New_York", businessDays: 2, blockedLimitBusinessDays: 10, now: start });
  return {
    snapshot,
    output,
    files: pkg.files,
    approvals: [{ packetDigest: pkg.packetDigest, approvedBy: "olga", approverType: "user", requestedBy: "otto" }],
    publishedAt: at("2026-11-04T20:00:00Z"), // Wednesday 15:00; deadline Wednesday 23:59:59.999
    deadline,
  };
}

const failing = (d: Delivery) => Object.entries(evaluate(d, contract)).filter(([k, v]) => k !== "passed" && (v as string[]).length > 0).map(([k]) => k);

test("the package holds every deliverable the contract names, bound by the approval packet", () => {
  const d = delivery();
  assert.deepEqual(Object.keys(d.files).sort(), [...contract.deliverableFiles].sort());
  assert.deepEqual(verifyPackage(d.files), []);
  const packet = JSON.parse(d.files[PACKET_FILE]!);
  assert.equal(packet.files.length, 10);
  assert.equal(buildPackage(d.output).packetDigest, digest(packet), "rendering is deterministic");
  const evidence = JSON.parse(d.files["evidence.json"]!);
  assert.equal(evidence.bills.length, 11);
  assert.ok(evidence.bills.every((b: { input: { digest: string }; checks: unknown[] }) => /^sha256:/.test(b.input.digest) && b.checks.length === 16), "every result links to its input and every check");
  assert.match(d.files["payable-recommendation.csv"]!, /^bill,vendor,bill_number,recommendation,advisory,/);
  assert.match(d.files["payable-recommendation.csv"]!, /B1,V1,A-100,approve_for_payment,true,USD,4320,43\.20,2026-12-02,scheduled,/);
  assert.match(d.files["summary.csv"]!, /status\.ready_for_payable_approval,2/);
  assert.equal(JSON.parse(d.files["source-document-references.json"]!).length, 2);
  // A delivered file that differs from the packet is caught.
  assert.deepEqual(verifyPackage({ ...d.files, "summary.csv": `${d.files["summary.csv"]}extra\n` }), ["summary.csv does not match its sha256 in the packet"]);
  assert.deepEqual(verifyPackage({ ...d.files, "notes.txt": "x" }), ["notes.txt is not listed in the packet"]);
});

test("a correct delivery passes all eight criteria", () => {
  const r = evaluate(delivery(), contract);
  assert.ok(r.passed, JSON.stringify(r, null, 2));
});

test("completeness: a missing or extra result fails", () => {
  const d = delivery();
  assert.ok(failing({ ...d, output: { ...d.output, results: d.output.results.slice(1) } }).includes("completeness"));
  assert.ok(failing({ ...d, output: { ...d.output, results: [...d.output.results, { ...d.output.results[0]!, billKey: "B99" }] } }).includes("completeness"));
});

test("traceability: a citation outside the snapshot fails", () => {
  const d = delivery();
  const [first, ...rest] = d.output.recommendations;
  const forged = { ...first!, sources: [{ ...first!.sources[0]!, digest: `sha256:${"0".repeat(64)}` }] };
  assert.ok(failing({ ...d, output: { ...d.output, recommendations: [forged, ...rest] } }).includes("traceability"));
});

test("recomputation and classification: an altered status fails both", () => {
  const d = delivery();
  const results = d.output.results.map((r) => (r.billKey === "B3" ? { ...r, status: "ready_for_payable_approval" } : r));
  const f = failing({ ...d, output: { ...d.output, results } });
  assert.ok(f.includes("recomputation") && f.includes("classification"));
});

test("no_accounting_mutation: a non-advisory or non-contract recommendation, or a changed input, fails", () => {
  const d = delivery();
  const recs = d.output.recommendations.map((r) => (r.billKey === "B1" ? { ...r, recommendation: "pay_now" as never } : r));
  assert.ok(failing({ ...d, output: { ...d.output, recommendations: recs } }).includes("no_accounting_mutation"));
  const records = d.snapshot.records.map((r) => (r.key === "B1" ? { ...r, record: { ...(r.record as object), status: "posted" } } : r));
  assert.ok(failing({ ...d, snapshot: { ...d.snapshot, records } }).includes("no_accounting_mutation"));
});

test("package_integrity: a delivered file that differs from the packet fails", () => {
  const d = delivery();
  assert.deepEqual(failing({ ...d, files: { ...d.files, "exceptions.csv": "tampered\n" } }), ["package_integrity"]);
});

test("reviewed: only a person other than the requester, approving this exact packet", () => {
  const d = delivery();
  const a = d.approvals[0]!;
  assert.deepEqual(failing({ ...d, approvals: [] }), ["reviewed"]);
  assert.deepEqual(failing({ ...d, approvals: [{ ...a, approvedBy: a.requestedBy }] }), ["reviewed"]);
  assert.deepEqual(failing({ ...d, approvals: [{ ...a, approverType: "agent" }] }), ["reviewed"]);
  assert.deepEqual(failing({ ...d, approvals: [{ ...a, packetDigest: `sha256:${"1".repeat(64)}` }] }), ["reviewed"]);
});

test("on_time: late or paused fails, but lateness alone does not block publication", () => {
  const d = delivery();
  const late = { ...d, publishedAt: d.deadline! + 1 };
  assert.deepEqual(failing(late), ["on_time"]);
  assert.ok(publishable(evaluate(late, contract)), "a late package is still delivered, and recorded as late");
  assert.deepEqual(failing({ ...d, deadline: null }), ["on_time"]);
  assert.ok(!publishable(evaluate({ ...d, approvals: [] }, contract)), "an unapproved package is never delivered");
});
