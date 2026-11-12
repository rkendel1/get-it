#!/usr/bin/env node
/**
 * Sabotage checks: break one critical guard at a time and require the test suite to fail.
 *
 * Each case replaces exactly one guard in the source, runs the named test files, and passes only if
 * those tests fail AND the failing test is the one expected to reach that guard. The source is
 * always restored, even if this script is interrupted. A guard whose removal no test notices is a
 * guard nobody is checking.
 *
 *   npm run sabotage            every case
 *   npm run sabotage -- 3 7     only cases 3 and 7
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const HTTP = ["tests/http-transaction.test.ts"];
const APP = ["tests/commerce.test.ts", "tests/delivery-view.test.ts", "tests/app.test.ts"];

/** [name, file, the exact source to break, its replacement, test files, a fragment of the test name that must fail] */
const CASES = [
  ["payment must precede fulfillment", "feltkit/orders.ts", "    if (!quote || !payment) fail(", "    if (!quote) fail(", HTTP, "entirely over HTTP"],
  ["payment does not start the clock", "feltkit/payments.ts", `ctx.db.patch(orders, order.id, { status: "paid" })`, `ctx.db.patch(orders, order.id, { status: "paid", clockStartedAt: Date.now() })`, HTTP, "entirely over HTTP"],
  ["one payment per quote", "feltkit/payments.ts", `      fail("CONFLICT", "A payment is already recorded for this quote.", { hint: "ALREADY_PAID" });`, `      return { status: "existing" as const, paymentId: paid.id, orderId: paid.orderId };`, HTTP, "entirely over HTTP"],
  ["fulfillment acceptance is idempotent", "feltkit/orders.ts", `    if (existing) return { status: "existing" as const, acceptanceId: existing.id, acceptedAt: existing.acceptedAt };`, ``, HTTP, "entirely over HTTP"],
  ["quote acceptance is bound to the quote digest", "feltkit/quotes.ts", `    if (a.quoteDigest !== quote.digest) fail(`, `    if (false) fail(`, HTTP, "digests cannot be substituted"],
  ["delivery acceptance and correction are bound to the delivered digest", "feltkit/delivery.ts", `  if (packetDigest !== delivery.packetDigest) fail(`, `  if (false) fail(`, HTTP, "entirely over HTTP"],
  ["downloads are limited to the packet's files", "feltkit/delivery.ts", `    if (!listed && a.name !== PACKET_FILE) fail(`, `    if (false) fail(`, HTTP, "digests cannot be substituted"],
  ["the customer's delivery record hides operator metadata", "feltkit/delivery.ts", `    const { publishedBy: _by, approvalId: _approval, ...delivery } = found; // no internal identities`, `    const delivery = found;`, HTTP, "expose no operator or approval metadata"],
  ["internal records are operator reads", "feltkit/app.ts", `const READ = ["intake.read", "quotes.read", "orders.read", "decisions.read", "delivery.read"];`, `const READ = ["intake.read", "quotes.read", "orders.read", "decisions.read", "delivery.read", "runs.read", "imports.read", "review.read", "integrity.read"];`, HTTP, "expose no operator or approval metadata"],
  ["only the owner accepts a quote", "feltkit/app.ts", `const MEMBER = [...READ, ...ASK, "intake.write", "decisions.record"];`, `const MEMBER = [...READ, ...ASK, "intake.write", "decisions.record", "quotes.accept"];`, HTTP, "entirely over HTTP"],
  ["customers cannot publish", "feltkit/app.ts", `const OWNER = [...READ, ...ASK, "intake.write", "quotes.accept",`, `const OWNER = [...READ, ...ASK, "delivery.publish", "intake.write", "quotes.accept",`, HTTP, "entirely over HTTP"],
  ["the requester cannot approve", "feltkit/review.ts", `    if (person.id === packet.requestedBy) fail(`, `    if (false) fail(`, HTTP, "entirely over HTTP"],
  ["the correction window closes", "feltkit/delivery.ts", `    if (Date.now() > delivery.correctionWindowEndsAt) fail(`, `    if (false) fail(`, APP, "correction"],
  ["quotes are tenant-scoped", "feltkit/app.ts", `  { tenant: true, unique: [["tenantId", "completenessId"]] },`, `  { unique: [["tenantId", "completenessId"]] },`, HTTP, "tenant boundaries and roles hold"],
  ["intake cannot complete with required answers missing", "feltkit/intake.ts", `    if (!c.complete || !binding) fail(`, `    if (!binding) fail(`, APP, "intake cannot complete"],
];

const only = process.argv.slice(2).map(Number).filter(Boolean);
let failures = 0;
for (const [i, [name, file, from, to, tests, expected]] of CASES.entries()) {
  if (only.length && !only.includes(i + 1)) continue;
  const original = readFileSync(file, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    console.log(`✗ ${i + 1}. ${name}: the guard was found ${count} times in ${file}; update this case`);
    failures++;
    continue;
  }
  const restore = () => writeFileSync(file, original);
  process.once("SIGINT", restore);
  try {
    writeFileSync(file, original.replace(from, to));
    const run = spawnSync("npx", ["feltkit", "test", ...tests], { encoding: "utf8" });
    const failed = (run.stdout ?? "").split("\n").filter((l) => l.startsWith("not ok"));
    const caught = failed.some((l) => l.includes(expected));
    console.log(`${caught ? "✓" : "✗"} ${i + 1}. ${name}: ${failed.length ? failed.map((l) => l.replace(/^not ok \d+ - /, "")).join(" | ") : "no test failed"}`);
    if (!caught) failures++;
  } finally {
    restore();
    process.removeListener("SIGINT", restore);
  }
}
console.log(failures ? `${failures} guard(s) not caught` : "every sabotaged guard was caught");
process.exit(failures ? 1 : 0);
