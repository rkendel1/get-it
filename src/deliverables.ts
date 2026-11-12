/**
 * The review package: every deliverable file the contract names, rendered deterministically from
 * the review output, and the approval packet that binds them.
 *
 * - Every file is UTF-8 text.
 * - The approval packet lists the sha256 of every other file, plus the contract, snapshot and
 *   output digests.
 * - Approving the packet's digest therefore approves those exact bytes.
 * - Rendering the same output twice gives the same bytes, so a package can be regenerated from the
 *   stored output at any time and checked against its packet.
 */
import { createHash } from "node:crypto";
import { canonicalJson, digest } from "./canonical.js";
import { formatMinor } from "./money.js";
import type { ReviewOutput } from "./review.js";

export const PACKET_FILE = "approval-packet.json";

export interface ApprovalPacket {
  readonly kind: "get-it.approval-packet/1";
  readonly contract: string;
  readonly contractDigest: string;
  readonly snapshotDigest: string;
  readonly outputDigest: string;
  readonly summary: ReviewOutput["summary"];
  readonly files: ReadonlyArray<{ readonly name: string; readonly sha256: string; readonly bytes: number }>;
}

export interface ReviewPackage {
  readonly files: Readonly<Record<string, string>>;
  readonly packet: ApprovalPacket;
  /** The digest an approval binds to. */
  readonly packetDigest: string;
}

export const sha256Hex = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

function csv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>): string {
  const cell = (v: string | number | boolean | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

const json = (v: unknown) => `${canonicalJson(v)}\n`;
const amount = (minor: number | null) => (minor === null ? null : formatMinor(minor));

export function buildPackage(output: ReviewOutput): ReviewPackage {
  const files: Record<string, string> = {
    "bill-review-results.json": json(output.results),
    "bill-review-results.csv": csv(
      ["bill", "vendor", "bill_number", "bill_date", "due_date", "currency", "total_minor", "total", "status", "exceptions", "input_sha256"],
      output.results.map((r) => [r.billKey, r.vendorId, r.billNumber, r.billDate, r.dueDate, r.currency, r.totalMinor, amount(r.totalMinor), r.status, r.exceptionIds.length, r.source.digest]),
    ),
    "payable-recommendation.json": json(output.recommendations),
    "payable-recommendation.csv": csv(
      ["bill", "vendor", "bill_number", "recommendation", "advisory", "currency", "amount_minor", "amount", "pay_by", "priority", "reasons"],
      output.recommendations.map((r) => [r.billKey, r.vendorId, r.billNumber, r.recommendation, r.advisory, r.currency, r.amountMinor, amount(r.amountMinor), r.payBy, r.priority, r.reasons.join(" ")]),
    ),
    "exceptions.json": json(output.exceptions),
    "exceptions.csv": csv(
      ["exception", "bill", "type", "status", "decision", "requires_review", "currency", "amount_minor", "detail"],
      output.exceptions.map((e) => [e.id, e.billKey, e.type, e.status, e.decision, e.requiresReview, e.currency, e.amountMinor, e.detail]),
    ),
    "missing-information-requests.json": json(output.requests),
    "source-document-references.json": json(output.documents),
    "evidence.json": json({
      contract: output.contract,
      contractDigest: output.contractDigest,
      snapshotDigest: output.snapshotDigest,
      asOfDate: output.asOfDate,
      bills: output.results.map((r) => ({ bill: r.billKey, input: r.source, references: r.references, checks: r.checks, status: r.status, exceptions: r.exceptionIds })),
    }),
    "summary.csv": csv(
      ["measure", "value"],
      [
        ["contract", output.contract],
        ["as_of_date", output.asOfDate],
        ["home_currency", output.homeCurrency],
        ["bills", output.summary.bills],
        ...Object.entries(output.summary.byStatus).map(([s, n]) => [`status.${s}`, n] as [string, number]),
        ["exceptions", output.summary.exceptions],
        ["requiring_review", output.summary.requiringReview],
        ["customer_decisions", output.summary.customerDecisions],
        ["blocking_requests", output.summary.blockingRequests],
        ...Object.entries(output.summary.recommendedForApprovalMinor).map(([c, m]) => [`recommended_for_approval_minor.${c}`, m] as [string, number]),
      ],
    ),
  };
  const packet: ApprovalPacket = {
    kind: "get-it.approval-packet/1",
    contract: output.contract,
    contractDigest: output.contractDigest,
    snapshotDigest: output.snapshotDigest,
    outputDigest: digest(output),
    summary: output.summary,
    files: Object.keys(files)
      .sort()
      .map((name) => ({ name, sha256: sha256Hex(files[name]!), bytes: Buffer.byteLength(files[name]!, "utf8") })),
  };
  files[PACKET_FILE] = json(packet);
  return { files, packet, packetDigest: digest(packet) };
}

/** Problems with a set of delivered files against its approval packet. */
export function verifyPackage(files: Readonly<Record<string, string>>): string[] {
  const packetText = files[PACKET_FILE];
  if (packetText === undefined) return [`${PACKET_FILE} is missing`];
  const packet = JSON.parse(packetText) as ApprovalPacket;
  const problems: string[] = [];
  const listed = new Set(packet.files.map((f) => f.name));
  for (const f of packet.files) {
    const content = files[f.name];
    if (content === undefined) problems.push(`${f.name} is missing`);
    else if (sha256Hex(content) !== f.sha256) problems.push(`${f.name} does not match its sha256 in the packet`);
  }
  for (const name of Object.keys(files)) if (name !== PACKET_FILE && !listed.has(name)) problems.push(`${name} is not listed in the packet`);
  return problems;
}
