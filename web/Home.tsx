/**
 * Home: "What do you need done?" and every request of the organization, quoted or not.
 */
import { useEffect, useState } from "react";
import { Availability, EXAMPLES } from "./copy";
import { api, Card, ErrorNote, Loading, day, go, money, useAction, useLive } from "./lib";
import { requestLabel } from "./status";

export function Home({ draft, clearDraft }: { draft: string; clearDraft(): void }) {
  const [text, setText] = useState(draft);
  useEffect(() => {
    if (draft) clearDraft();
  }, [draft, clearDraft]);
  const create = useAction(api.tasks.create);
  const requests = useLive(api.tasks.list, {});

  const send = async () => {
    const r = await create.call({ text });
    if (r) go(`/tasks/${r.requestId}`);
  };

  return (
    <div className="stack">
      <Card>
        <h1>What do you need done?</h1>
        <p className="lede">Describe it in your own words. We'll work through the details with you.</p>
        <label className="sr-only" htmlFor="request">Describe what you need done</label>
        <textarea id="request" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: research these five competitors and summarize their pricing." />
        <details className="examples-toggle">
          <summary>Examples of what people ask</summary>
          <ul className="examples">{EXAMPLES.map((e) => <li key={e}>“{e}”</li>)}</ul>
        </details>
        <ErrorNote>{create.error}</ErrorNote>
        <div className="actions">
          <button className="primary" disabled={!text.trim() || create.pending} onClick={() => void send()}>
            {create.pending ? "Sending…" : "Send my request"}
          </button>
        </div>
        <Availability />
      </Card>

      <Card title="Your requests">
        {requests.isLoading ? <Loading label="Loading your requests" /> : null}
        <ErrorNote>{requests.error?.message}</ErrorNote>
        {requests.data && requests.data.length === 0 ? <p className="empty">No requests yet. Tell us what you need done above.</p> : null}
        {requests.data && requests.data.length > 0 ? (
          <ul className="requests">
            {requests.data.map((r) => (
              <li key={r.id}>
                <a href={`#/tasks/${r.id}`}>
                  <span className="request-text">{r.text}</span>
                  <span className="meta">
                    <span className="badge">{requestLabel(r)}</span>
                    {r.transaction?.quote ? <span>{money(r.transaction.quote.priceMinor, r.transaction.quote.currency)}</span> : null}
                    <span>{day(r.requestedAt)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
