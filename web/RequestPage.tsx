/**
 * One request, from information to accepted delivery. Every section renders server state: the
 * intake (with its live completeness report and quote), the order, its clock, and the customer
 * delivery view. Nothing is decided here; buttons call the server, and the page shows what it
 * recorded.
 */
import { useState } from "react";
import { useAuth, useFeltKit } from "@feltdb/feltkit/react";
import { CRITERION_LABEL, FILE_LABEL, INPUTS, LABEL, STATUS_LABEL, WHY, assumptionText, contract, contractMatches, inputOf } from "./contract";
import { api, Card, ErrorNote, Loading, date, day, money, short, useAction, useLive } from "./lib";
import { ORDER_STATUS, orderStatusLabel, stages } from "./status";
import type { CompletenessReport } from "../src/intake";

type Intake = NonNullable<ReturnType<typeof useIntake>["data"]>;
const useIntake = (sessionId: string) => useLive(api.intake.get, { sessionId });
/** The completeness report: live while the intake is open, as recorded once it is complete. */
const reportOf = (data: Intake) => data.completeness.report as CompletenessReport;

export function RequestPage({ sessionId }: { sessionId: string }) {
  const intake = useIntake(sessionId);
  const orderId = intake.data?.quote?.orderId ?? null;
  const order = useLive(api.orders.get, orderId ? { id: orderId } : "skip");

  if (intake.isLoading) return <Loading label="Loading your request" />;
  if (intake.error) return <Card title="This request could not be loaded"><ErrorNote>{intake.error.message}</ErrorNote><p><a href="#/">Back to your requests</a></p></Card>;
  if (!intake.data) return <Card title="Request not found"><p>There is no such request in this organization.</p><p><a href="#/">Back to your requests</a></p></Card>;

  const data = intake.data;
  const complete = data.completeness.status === "complete";
  const status = order.data?.status ?? null;
  const label = orderStatusLabel({ complete, quote: data.quote, orderStatus: status });

  return (
    <div className="stack">
      <p className="crumbs"><a href="#/">Your requests</a></p>
      <Card>
        <p className="eyebrow">Your request</p>
        <h1 className="request-title">{data.request}</h1>
        <p className="status-line">
          Status: <strong data-testid="request-status">{label}</strong>
        </p>
        <ol className="stages" aria-label="Progress">
          {stages({ complete, quoted: Boolean(data.quote), ordered: Boolean(orderId), status }).map((s) => (
            <li key={s.id} className={s.done ? "done" : ""}>{s.label}</li>
          ))}
        </ol>
      </Card>

      {!complete ? <IntakeSection sessionId={sessionId} data={data} /> : <ProvidedSummary data={data} />}
      {complete ? <Proposal data={data} /> : null}
      {orderId ? <OrderSection orderId={orderId} /> : null}
    </div>
  );
}

// ---- A/B. Gather requirements ---------------------------------------------------------------

function IntakeSection({ sessionId, data }: { sessionId: string; data: Intake }) {
  const complete = useAction(api.intake.complete);
  const report = reportOf(data);
  const missing = data.completeness.status === "open" ? data.completeness.missing : [];
  const answered = report.inputs.filter((i) => i.source === "answer");
  const billSet = report.inputs.filter((i) => i.source === "bill set");
  return (
    <Card title="Information we need" id="information">
      <p className="lede">Everything below comes from the service contract. Required items must be provided before we can quote; optional ones have a stated default.</p>
      <div className="progress-note" data-testid="missing">
        {missing.length ? <>Still needed: {missing.map((m) => LABEL[m] ?? m).join(", ")}.</> : <>Everything required has been received. You can finish.</>}
      </div>

      <h3>Your bills and records</h3>
      <BillSetUpload sessionId={sessionId} data={data} />
      <ul className="inputs">
        {billSet.map((i) => (
          <InputRow key={i.id} id={i.id} required={i.required} status={i.status}>
            {i.status === "bound" ? <span className="received">Received{countOf(data, i.id)}</span> : null}
          </InputRow>
        ))}
      </ul>

      <h3>A few details</h3>
      <ul className="inputs">
        {answered.map((i) => (
          <InputRow key={i.id} id={i.id} required={i.required} status={i.status}>
            <AnswerControl sessionId={sessionId} id={i.id} current={data.answers[i.id] as { kind: string; value?: unknown } | undefined} />
          </InputRow>
        ))}
      </ul>

      <ErrorNote>{complete.error}</ErrorNote>
      <div className="actions">
        <button className="primary" disabled={complete.pending} onClick={() => void complete.call({ sessionId })}>
          {complete.pending ? "Finishing…" : "Finish and request a quote"}
        </button>
      </div>
    </Card>
  );
}

function countOf(data: Intake, id: string) {
  const counts = data.billSet as Record<string, number> | null;
  if (!counts) return "";
  const n = counts[id];
  return typeof n === "number" ? ` · ${n}` : "";
}

function InputRow({ id, required, status, children }: { id: string; required: boolean; status: string; children: React.ReactNode }) {
  const state = status === "bound" ? "Received" : status === "assumed" ? "Default applies" : "Needed";
  return (
    <li className={`input ${status}`} data-input={id}>
      <div className="input-head">
        <span className="input-name">{LABEL[id] ?? id}</span>
        <span className={`tag ${required ? "required" : "optional"}`}>{required ? "Required" : "Optional"}</span>
        <span className={`state ${status}`}>{state}</span>
      </div>
      <p className="why">{WHY[id]}</p>
      {children}
    </li>
  );
}

function AnswerControl({ sessionId, id, current }: { sessionId: string; id: string; current?: { kind: string; value?: unknown } }) {
  const spec = inputOf(id)!;
  const save = useAction(api.intake.answer);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const show = current && !editing;

  const parsed = (): unknown => {
    if (spec.kind === "integer") {
      if (id === "policy.documentRequiredOverMinor") {
        const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
        return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : value;
      }
      return /^\s*-?\d+\s*$/.test(value) ? Number(value) : value;
    }
    return spec.kind === "iso-4217" ? value.trim().toUpperCase() : value.trim();
  };
  const submit = async () => {
    const r = await save.call({ sessionId, field: id, value: parsed() });
    if (r) {
      setEditing(false);
      setValue("");
    }
  };
  const decline = async () => {
    if (await save.call({ sessionId, field: id, decline: true })) setEditing(false);
  };

  if (show) {
    const text = current.kind === "decline" ? `Default (${display(id, spec.default)})` : display(id, current.value);
    return (
      <div className="answer">
        <span className="value" data-testid={`value-${id}`}>{text}</span>
        <button className="link" onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }
  const inputId = `in-${id}`;
  return (
    <div className="answer-form">
      <label htmlFor={inputId} className="sr-only">{LABEL[id]}</label>
      {spec.kind === "iana-time-zone" ? (
        <select id={inputId} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose your time zone…</option>
          {timeZones().map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      ) : (
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type={spec.kind === "iso-date" ? "date" : "text"}
          inputMode={spec.kind === "integer" ? "decimal" : undefined}
          placeholder={placeholder(id, spec)}
          maxLength={spec.kind === "iso-4217" ? 3 : undefined}
        />
      )}
      <button disabled={!value.trim() || save.pending} onClick={() => void submit()}>{save.pending ? "Saving…" : "Save"}</button>
      {!spec.required ? <button className="secondary" disabled={save.pending} onClick={() => void decline()}>Use the default ({display(id, spec.default)})</button> : null}
      {editing ? <button className="link" onClick={() => setEditing(false)}>Cancel</button> : null}
      <ErrorNote>{save.error}</ErrorNote>
    </div>
  );
}

function display(id: string, v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (id === "policy.documentRequiredOverMinor" && typeof v === "number") return `${money(v, null)} in your home currency`;
  return String(v);
}

function placeholder(id: string, spec: { kind: string; min?: number; max?: number; default?: unknown }) {
  if (spec.kind === "iso-4217") return `e.g. ${String(spec.default ?? "USD")}`;
  if (id === "policy.documentRequiredOverMinor") return `Amount, e.g. ${money(Number(spec.default), null)}`;
  if (spec.kind === "integer") return `${spec.min ?? ""} to ${spec.max ?? ""}`;
  return "";
}

function timeZones(): string[] {
  const zones = (Intl as unknown as { supportedValuesOf?(k: string): string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  return zones;
}

function BillSetUpload({ sessionId, data }: { sessionId: string; data: Intake }) {
  const upload = useAction(api.intake.uploadBillSet);
  const [readError, setReadError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    setLast(null);
    let billSet: unknown;
    try {
      billSet = JSON.parse(await file.text());
    } catch {
      setReadError(`${file.name} is not a JSON file. Export your bill set as JSON (vendors, accounts and bills, Ledger-compatible).`);
      return;
    }
    const r = await upload.call({ sessionId, billSet });
    if (r) setLast(r.status === "duplicate" ? `${file.name}: identical to the bill set you already provided. Nothing changed.` : `${file.name}: ${r.bills} bills received.`);
  };
  return (
    <div className="upload">
      <label className="file">
        <span>{data.billSet ? "Replace the bill set" : "Upload your bill set (JSON)"}</span>
        <input type="file" accept="application/json,.json" aria-label="Bill set file" disabled={upload.pending} onChange={(e) => void onFile(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
      </label>
      <p className="why">One JSON file with your vendors, your accounts, the bills awaiting approval and, if you have them, bills already processed. Ledger exports work as they are; amounts are in cents.</p>
      {upload.pending ? <Loading label="Checking your bill set" /> : null}
      {last ? <p className="ok" role="status">{last}</p> : null}
      <ErrorNote>{readError ?? upload.error}</ErrorNote>
    </div>
  );
}

function ProvidedSummary({ data }: { data: Intake }) {
  const report = reportOf(data);
  return (
    <Card title="Information received" tone="done">
      <ul className="facts">
        {report.inputs.filter((i) => i.status === "bound").map((i) => (
          <li key={i.id}><span>{LABEL[i.id] ?? i.id}</span><strong>{i.source === "bill set" ? `Received${countOf(data, i.id)}` : display(i.id, i.value)}</strong></li>
        ))}
      </ul>
    </Card>
  );
}

// ---- C/D. The proposed service and its quote --------------------------------------------------

function Proposal({ data }: { data: Intake }) {
  const quoteRef = data.quote;
  const quote = useLive(api.quotes.get, quoteRef ? { id: quoteRef.id } : "skip");
  const report = reportOf(data);
  const assumptions = report.assumptions;
  const bought = Boolean(quoteRef?.orderId);
  const terms = (
    <>
        <div className="four">
          <section>
            <h3>1. What you provide</h3>
            <ul>
              {INPUTS.filter((i) => i.required).map((i) => <li key={i.id}><strong>{LABEL[i.id]}</strong> <span className="tag required">Required</span></li>)}
              {INPUTS.filter((i) => !i.required).map((i) => <li key={i.id}>{LABEL[i.id]} <span className="tag optional">Optional</span></li>)}
            </ul>
          </section>
          <section>
            <h3>2. What Boundry will do</h3>
            <p>{contract.outcome}</p>
            <ul>
              <li>Check each bill for completeness and exact arithmetic, duplicates, foreign currency and your policies.</li>
              <li>Give each bill one status: {Object.values(STATUS_LABEL).join(", ").toLowerCase()}.</li>
              <li>Recommend approve for payment, hold, or reject and resubmit. Advice only.</li>
              <li>Have a second person, not the one who prepared it, approve the exact package before you see it.</li>
            </ul>
          </section>
          <section>
            <h3>3. What you receive</h3>
            <ul>
              {contract.deliverables.map((d) => <li key={d.id}>{FILE_LABEL[d.id] ?? d.id} <span className="muted">({d.files.map((f) => f.split(".").pop()).join(", ")})</span></li>)}
            </ul>
          </section>
          <section>
            <h3>4. How completion and acceptance are determined</h3>
            <ul>
              {contract.acceptanceCriteria.map((c) => <li key={c.id}>{CRITERION_LABEL[c.id] ?? c.test}</li>)}
              <li>Your organization's owner accepts the delivered package, or requests a correction within {contract.service.correctionWindowBusinessDays} business days.</li>
            </ul>
          </section>
        </div>
        <div className="terms">
          <section>
            <h3>Timing</h3>
            <p>{contract.service.turnaroundBusinessDays} business days, counted from when we accept your order for fulfillment (after payment), in your time zone, excluding US federal holidays. Days we wait on you do not count; after {contract.service.blockedLimitBusinessDays} such days the order is cancelled or re-quoted.</p>
          </section>
          <section>
            <h3>Assumptions</h3>
            {assumptions.length ? <ul data-testid="assumptions">{assumptions.map((a) => <li key={a.input} title={a.statement}>{assumptionText(a)}</li>)}</ul> : <p>None: you answered everything.</p>}
          </section>
          <section>
            <h3>Not included</h3>
            <ul>{contract.boundaries.excludedActions.map((x) => <li key={x}>{x[0]!.toUpperCase() + x.slice(1)}</li>)}</ul>
          </section>
        </div>
    </>
  );
  return (
    <>
      <Card title={bought ? "What you bought" : "What you are buying"} id="proposal">
        {bought ? (
          <details>
            <summary>Show the scope, deliverables, acceptance terms, timing and exclusions you accepted</summary>
            {terms}
          </details>
        ) : (
          terms
        )}
      </Card>
      {!quoteRef ? (
        <Card title="Your quote is being prepared" tone="muted" id="quote">
          <p>Your information is complete. A Boundry operator is preparing a quote from the fixed terms above; this page updates when it is ready.</p>
        </Card>
      ) : quote.isLoading ? (
        <Loading label="Loading your quote" />
      ) : quote.data ? (
        <QuoteCard quote={quote.data} orderId={quoteRef.orderId} />
      ) : (
        <ErrorNote>{quote.error?.message ?? "The quote could not be loaded."}</ErrorNote>
      )}
    </>
  );
}

type Quote = NonNullable<ReturnType<typeof useLive<typeof api.quotes.get>>["data"]>;

function QuoteCard({ quote, orderId }: { quote: Quote; orderId: string | null }) {
  const auth = useAuth();
  const accept = useAction(api.quotes.accept);
  const expired = Date.now() > quote.validUntil;
  const matches = contractMatches(quote.contractDigest);
  return (
    <Card title={orderId ? "Your accepted quote" : "Your quote"} tone={orderId ? "done" : "attention"} id="quote">
      <div className="price" data-testid="quote-total">{money(quote.priceMinor, quote.currency)}</div>
      <ul className="facts">
        <li><span>Scope</span><strong>{quote.billCount} bills</strong></li>
        <li><span>Pricing</span><strong>{money(quote.pricing.basePerRunMinor, quote.currency)} including {quote.pricing.includedBills} bills, then {money(quote.pricing.perAdditionalBillMinor, quote.currency)} per additional bill</strong></li>
        <li><span>Delivery</span><strong>{quote.turnaroundBusinessDays} business days after fulfillment starts</strong></li>
        <li><span>Valid until</span><strong>{date(quote.validUntil)}</strong></li>
        <li><span>Contract</span><strong>{quote.contract}</strong></li>
        <li><span>Quote reference</span><code data-testid="quote-reference">{short(quote.digest)}</code></li>
      </ul>
      <p className="commitment">This quote is a fixed commitment made under the frozen contract above. Its price, scope and assumptions are sealed by its reference and cannot change after you accept it.</p>
      {!matches ? <ErrorNote>This page shows contract terms that differ from the ones this quote was made under. Reload the page before accepting.</ErrorNote> : null}
      {orderId ? (
        <p className="ok">Accepted. Your order is open.</p>
      ) : expired ? (
        <ErrorNote>This quote has expired. Ask us for a new one.</ErrorNote>
      ) : auth.can("quotes.accept") ? (
        <>
          <ErrorNote>{accept.error}</ErrorNote>
          <div className="actions">
            <button className="primary" disabled={accept.pending || !matches} onClick={() => void accept.call({ quoteId: quote.id, quoteDigest: quote.digest })}>
              {accept.pending ? "Accepting…" : `Accept quote for ${money(quote.priceMinor, quote.currency)}`}
            </button>
          </div>
        </>
      ) : (
        <p className="hint">Only your organization's owner can accept this quote.</p>
      )}
    </Card>
  );
}

// ---- E/F/G. Purchase, fulfillment and delivery ------------------------------------------------

function OrderSection({ orderId }: { orderId: string }) {
  const order = useLive(api.orders.get, { id: orderId });
  const clock = useLive(api.orders.clock, { id: orderId });
  const view = useLive(api.delivery.view, { orderId });
  if (order.isLoading) return <Loading label="Loading your order" />;
  if (!order.data) return <ErrorNote>{order.error?.message ?? "The order could not be loaded."}</ErrorNote>;
  const status = order.data.status;
  return (
    <>
      <Card title="Payment" tone={status === "awaiting_payment" ? "attention" : "done"} id="payment">
        {status === "awaiting_payment" ? (
          <>
            <p data-testid="payment-state">Awaiting payment of <strong>{money(view.data?.order.priceMinor ?? null, view.data?.order.currency)}</strong>.</p>
            <p className="notice">Development build: no card is charged and no payment provider is connected. A Boundry operator records your payment against your quote. Real-money purchasing is disabled until the settlement of partially accepted deliveries is defined.</p>
          </>
        ) : (
          <p data-testid="payment-state">Payment recorded by Boundry. In this development build this is a recorded payment, not a payment-provider transaction.</p>
        )}
      </Card>
      <Card title="Fulfillment" id="fulfillment">
        <p className="status-line">Order status: <strong data-testid="order-status">{ORDER_STATUS[status] ?? status}</strong></p>
        {order.data.clockStartedAt ? (
          <ul className="facts">
            <li><span>Started</span><strong>{date(order.data.clockStartedAt, order.data.timeZone)}</strong></li>
            <li><span>Due</span><strong data-testid="due">{clock.data?.paused ? "Paused while we wait on you" : clock.data?.deadline ? date(clock.data.deadline, order.data.timeZone) : "—"}</strong></li>
          </ul>
        ) : (
          <p className="muted">The {contract.service.turnaroundBusinessDays}-business-day clock starts when we accept your order for fulfillment, after payment.</p>
        )}
      </Card>
      {view.data?.delivery ? <DeliverySection view={view.data} /> : null}
    </>
  );
}

type View = NonNullable<ReturnType<typeof useLive<typeof api.delivery.view>>["data"]>;

function DeliverySection({ view }: { view: View }) {
  const delivery = view.delivery!;
  const auth = useAuth();
  const client = useFeltKit();
  const accept = useAction(api.delivery.accept);
  const correct = useAction(api.delivery.requestCorrection);
  const [reason, setReason] = useState("");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const open = !delivery.acceptance && !delivery.correction;
  const windowOpen = Date.now() <= delivery.correctionWindowEndsAt;

  const download = async (name: string) => {
    setDownloadError(null);
    try {
      const file = await client.query(api.delivery.download, { deliveryId: delivery.id, name });
      const url = URL.createObjectURL(new Blob([file.content], { type: file.contentType }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadError((e as Error).message);
    }
  };

  const byStatus = delivery.summary.byStatus as Record<string, number>;
  return (
    <Card title="Your delivery" tone={delivery.acceptance ? "done" : "attention"} id="delivery">
      <p>Published {date(delivery.publishedAt)}{delivery.onTime ? ", on time." : ", after the committed deadline."} Package reference <code data-testid="package-reference">{short(delivery.packetDigest)}</code>.</p>

      <h3>The result</h3>
      <ul className="facts" data-testid="result-summary">
        <li><span>Bills reviewed</span><strong>{delivery.summary.bills}</strong></li>
        {Object.entries(byStatus).filter(([, n]) => n > 0).map(([s, n]) => <li key={s}><span>{STATUS_LABEL[s] ?? s}</span><strong>{n}</strong></li>)}
        {Object.entries(delivery.summary.recommendedForApprovalMinor as Record<string, number>).map(([c, m]) => <li key={c}><span>Recommended for payment approval ({c})</span><strong>{money(m, c)}</strong></li>)}
      </ul>

      <h3>How we know it is complete</h3>
      <ul className="criteria">
        {Object.entries(delivery.acceptanceCriteria).map(([id, state]) => <li key={id} className={state}>{state === "passed" ? "✓" : "✗"} {CRITERION_LABEL[id] ?? id}</li>)}
      </ul>

      {view.unresolved.informationRequests.length || view.unresolved.customerDecisions.length ? (
        <>
          <h3>Waiting on you</h3>
          <ul className="unresolved">
            {view.unresolved.informationRequests.map((r) => <li key={r.id}>Bill {r.billKey}: we need {r.ask}{r.blocking ? " (it blocks that bill's review)" : ""}.</li>)}
            {view.unresolved.customerDecisions.length ? <li>{view.unresolved.customerDecisions.length} suspected duplicate(s) need your decision; see the exception list.</li> : null}
          </ul>
        </>
      ) : null}

      <h3>Files</h3>
      <ul className="files">
        {delivery.files.map((f) => (
          <li key={f.name}>
            <span><code>{f.name}</code> <span className="muted">{(f.bytes / 1024).toFixed(1)} KB</span></span>
            <button className="secondary" onClick={() => void download(f.name)} aria-label={`Download ${f.name}`}>Download</button>
          </li>
        ))}
      </ul>
      <ErrorNote>{downloadError}</ErrorNote>
      <p className="muted">Each file's SHA-256 is listed in approval-packet.json; the package reference is the fingerprint of that packet.</p>

      {delivery.acceptance ? (
        <p className="ok" data-testid="accepted">Accepted {date(delivery.acceptance.acceptedAt)}. Charge: {money(delivery.acceptance.chargeMinor, view.order.currency)}.</p>
      ) : delivery.correction ? (
        <p className="notice" data-testid="correction-requested">Correction requested {date(delivery.correction.requestedAt)}: “{delivery.correction.reason}”. We will deliver a corrected package for you to review.</p>
      ) : auth.can("delivery.accept") ? (
        <div className="decide">
          <h3>Accept or request a correction</h3>
          <p>Accepting confirms this exact package (reference {short(delivery.packetDigest)}). You can request a correction until {date(delivery.correctionWindowEndsAt, view.order.timeZone)}.</p>
          <ErrorNote>{accept.error ?? correct.error}</ErrorNote>
          <div className="actions">
            <button className="primary" disabled={!open || accept.pending || correct.pending} onClick={() => void accept.call({ deliveryId: delivery.id, packetDigest: delivery.packetDigest, scope: "full" })}>
              {accept.pending ? "Accepting…" : "Accept this delivery"}
            </button>
          </div>
          {windowOpen ? (
            <div className="correction">
              <label htmlFor="correction-reason">What should be corrected?</label>
              <textarea id="correction-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button disabled={!reason.trim() || correct.pending || accept.pending} onClick={() => void correct.call({ deliveryId: delivery.id, packetDigest: delivery.packetDigest, reason: reason.trim() })}>
                {correct.pending ? "Sending…" : "Request a correction"}
              </button>
            </div>
          ) : (
            <p className="muted">The correction window closed on {day(delivery.correctionWindowEndsAt)}.</p>
          )}
        </div>
      ) : (
        <p className="hint">Only your organization's owner can accept this delivery or request a correction.</p>
      )}
    </Card>
  );
}
