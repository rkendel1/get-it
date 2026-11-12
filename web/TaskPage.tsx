/**
 * One task request, as its customer sees it: their own words, unchanged; what it is waiting on; the
 * questions we asked and why; what they have added; and, when one of our services fits and they
 * choose it, that service's own flow (intake, quote, payment, delivery).
 *
 * Everything shown comes from the server. Nothing here claims we can do a task unless a person has
 * said so, or the customer chose a service we actually provide.
 */
import { useState } from "react";
import { RequestPage } from "./RequestPage";
import { api, Card, ErrorNote, Loading, date, day, money, useAction, useLive } from "./lib";
import { TASK_STATUS } from "./status";

const PURPOSE: Record<string, { title: string; note: string }> = {
  quote: { title: "Needed to give you a price", note: "We can't quote until these are answered." },
  execute: { title: "Needed to do the work", note: "Not needed for the price, but before we start." },
  optional: { title: "Optional", note: "These improve the result." },
  resource: { title: "Things you can provide", note: "Upload files or add links below." },
};

type Task = NonNullable<ReturnType<typeof useLive<typeof api.tasks.get>>["data"]>;

export function TaskPage({ requestId }: { requestId: string }) {
  const task = useLive(api.tasks.get, { requestId });
  if (task.isLoading) return <Loading label="Loading your request" />;
  if (task.error) return <Card title="This request could not be loaded"><ErrorNote>{task.error.message}</ErrorNote><p><a href="#/">Back to your requests</a></p></Card>;
  if (!task.data) return <Card title="Request not found"><p>There is no such request in this organization.</p><p><a href="#/">Back to your requests</a></p></Card>;
  const t = task.data;
  const status = TASK_STATUS[t.state.outcome] ?? TASK_STATUS.ready_to_scope!;

  return (
    <div className="stack">
      <p className="crumbs"><a href="#/">Your requests</a></p>
      <Card>
        <p className="eyebrow">Your request · {date(t.requestedAt)}</p>
        <blockquote className="original" data-testid="original-request">{t.text}</blockquote>
        {!t.transaction ? (
          <>
            <p className="status-line">Status: <strong data-testid="task-status">{t.offer ? "We can offer a service for this" : status.label}</strong></p>
            <p className="next">{t.offer ? TASK_STATUS.fulfillment_path_identified!.next : status.next}</p>
          </>
        ) : null}
      </Card>

      {t.transaction ? (
        <RequestPage sessionId={t.transaction.sessionId} embedded />
      ) : (
        <>
          {t.offer ? <Offer requestId={t.id} offer={t.offer} /> : null}
          {t.assessment && t.assessment.reasons.length && t.state.outcome !== "fulfillment_path_identified" ? (
            <Card title="What we found" tone={t.state.outcome === "not_currently_fulfillable" ? "muted" : undefined}>
              <ul>{t.assessment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              {t.assessment.arrangements.length ? (
                <>
                  <h3>What we would arrange</h3>
                  <ul>{t.assessment.arrangements.map((r) => <li key={r}>{r}</li>)}</ul>
                </>
              ) : null}
            </Card>
          ) : null}
          {t.assessment?.questions.length ? <Questions task={t} /> : null}
          <Details task={t} />
          <Resources task={t} />
        </>
      )}
    </div>
  );
}

function Offer({ requestId, offer }: { requestId: string; offer: { title: string; basis: string } }) {
  const respond = useAction(api.tasks.respondToService);
  return (
    <Card title={`Our service: ${offer.title}`} tone="attention" id="offer">
      <p>
        {offer.basis === "assessment"
          ? "Our team reviewed your request and this service fits it."
          : "Your request mentions bills or invoices. If you want us to review supplier bills before you pay them, this is our service for it. If you meant something else, say so and a person will review your request."}
      </p>
      <p className="muted">Continuing asks for the information this service needs and then gives you a fixed quote. Nothing is charged unless you accept the quote.</p>
      <ErrorNote>{respond.error}</ErrorNote>
      <div className="actions">
        <button className="primary" disabled={respond.pending} onClick={() => void respond.call({ requestId, accept: true })}>Yes, continue with this service</button>
        <button className="secondary" disabled={respond.pending} onClick={() => void respond.call({ requestId, accept: false })}>No, that's not what I need</button>
      </div>
    </Card>
  );
}

function Questions({ task }: { task: Task }) {
  const answers = new Map(task.details.filter((d) => d.kind === "answer").map((d) => [d.questionId, d.value as string]));
  const groups = (["quote", "execute", "optional", "resource"] as const).map((p) => [p, task.assessment!.questions.filter((q) => q.purpose === p)] as const).filter(([, qs]) => qs.length);
  return (
    <Card title="Our questions" id="questions">
      {groups.map(([purpose, qs]) => (
        <section key={purpose} className="question-group">
          <h3>{PURPOSE[purpose]!.title}</h3>
          <p className="why">{PURPOSE[purpose]!.note}</p>
          <ul className="inputs">
            {qs.map((q) => <Question key={q.id} requestId={task.id} q={q} answer={answers.get(q.id)} resource={purpose === "resource"} />)}
          </ul>
        </section>
      ))}
    </Card>
  );
}

function Question({ requestId, q, answer, resource }: { requestId: string; q: { id: string; text: string }; answer?: string; resource: boolean }) {
  const save = useAction(api.tasks.addDetail);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  return (
    <li className={`input ${answer ? "bound" : "missing"}`} data-question={q.id}>
      <div className="input-head">
        <span className="input-name">{q.text}</span>
        <span className={`state ${answer ? "bound" : "missing"}`}>{answer ? "Answered" : resource ? "Not provided" : "Needed"}</span>
      </div>
      {answer && !editing ? (
        <div className="answer"><span className="value">{answer}</span><button className="link" onClick={() => setEditing(true)}>Change</button></div>
      ) : (
        <div className="answer-form">
          <label className="sr-only" htmlFor={`q-${q.id}`}>{q.text}</label>
          <input id={`q-${q.id}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={resource ? "Describe what you'll provide, or attach it below" : "Your answer"} />
          <button disabled={!value.trim() || save.pending} onClick={async () => {
            if (await save.call({ requestId, kind: "answer", questionId: q.id, value })) {
              setValue("");
              setEditing(false);
            }
          }}>{save.pending ? "Saving…" : "Save"}</button>
          <ErrorNote>{save.error}</ErrorNote>
        </div>
      )}
    </li>
  );
}

const DETAIL_LABEL: Record<string, string> = { constraint: "Requirement", preference: "Preference", note: "Note", deadline: "Wanted by", budget: "Budget" };

function Details({ task }: { task: Task }) {
  const add = useAction(api.tasks.addDetail);
  const [kind, setKind] = useState<"note" | "constraint" | "preference" | "deadline" | "budget">("note");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const shown = task.details.filter((d) => d.kind !== "answer");
  const submit = async () => {
    let v: unknown = value;
    if (kind === "budget") {
      const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
      v = m ? { amountMinor: Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0), currency } : value;
    }
    if (await add.call({ requestId: task.id, kind, value: v })) setValue("");
  };
  return (
    <Card title="Details you've added" id="details">
      {shown.length ? (
        <ul className="facts" data-testid="details">
          {shown.map((d) => (
            <li key={d.id}><span>{DETAIL_LABEL[d.kind]}</span><strong>{d.kind === "budget" ? money((d.value as { amountMinor: number }).amountMinor, (d.value as { currency: string }).currency) : d.kind === "deadline" ? day(Date.parse(`${String(d.value)}T12:00:00Z`)) : String(d.value)}</strong></li>
          ))}
        </ul>
      ) : (
        <p className="empty">Nothing yet. Add anything that helps: a deadline, a budget, requirements, or preferences.</p>
      )}
      <div className="answer-form detail-form">
        <label className="sr-only" htmlFor="detail-kind">Kind of detail</label>
        <select id="detail-kind" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setValue(""); }}>
          <option value="note">Note</option>
          <option value="constraint">Requirement</option>
          <option value="preference">Preference</option>
          <option value="deadline">Wanted by (date)</option>
          <option value="budget">Budget</option>
        </select>
        <label className="sr-only" htmlFor="detail-value">Detail</label>
        <input id="detail-value" type={kind === "deadline" ? "date" : "text"} inputMode={kind === "budget" ? "decimal" : undefined} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "budget" ? "Amount, e.g. 1500" : kind === "deadline" ? "" : "Add a detail"} />
        {kind === "budget" ? (
          <>
            <label className="sr-only" htmlFor="detail-currency">Currency</label>
            <input id="detail-currency" className="currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </>
        ) : null}
        <button disabled={!value.trim() || add.pending} onClick={() => void submit()}>{add.pending ? "Adding…" : "Add"}</button>
        <ErrorNote>{add.error}</ErrorNote>
      </div>
    </Card>
  );
}

function Resources({ task }: { task: Task }) {
  const attach = useAction(api.tasks.attach);
  const [linkName, setLinkName] = useState("");
  const [url, setUrl] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    if (file.size > 3_000_000) return setReadError(`${file.name} is larger than 3 MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await attach.call({ requestId: task.id, file: { name: file.name, ...(file.type ? { contentType: file.type } : {}), contentBase64: btoa(binary) } });
  };
  return (
    <Card title="Files and links" id="resources">
      {task.resources.length ? (
        <ul className="files" data-testid="resources">
          {task.resources.map((r) => (
            <li key={r.id}>
              <span>{r.kind === "link" ? <a href={r.url ?? "#"} target="_blank" rel="noreferrer noopener">{r.name}</a> : <code>{r.name}</code>} <span className="muted">{r.kind === "file" && r.size !== null ? `${r.size < 1024 ? `${r.size} bytes` : `${(r.size / 1024).toFixed(1)} KB`} · received` : "link"}</span></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No files or links yet.</p>
      )}
      <div className="upload">
        <label className="file">
          <span>Attach a file (up to 3 MB)</span>
          <input type="file" aria-label="Attach a file" disabled={attach.pending} onChange={(e) => void onFile(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
        </label>
        <div className="answer-form">
          <label className="sr-only" htmlFor="link-name">Link name</label>
          <input id="link-name" value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="Link name" />
          <label className="sr-only" htmlFor="link-url">Link address</label>
          <input id="link-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          <button disabled={!linkName.trim() || !url.trim() || attach.pending} onClick={async () => {
            if (await attach.call({ requestId: task.id, link: { name: linkName, url } })) {
              setLinkName("");
              setUrl("");
            }
          }}>Add link</button>
        </div>
        {attach.pending ? <Loading label="Uploading" /> : null}
        <ErrorNote>{readError ?? attach.error}</ErrorNote>
      </div>
    </Card>
  );
}
