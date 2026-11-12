/**
 * Home: "What do you need done?" and the organization's requests. The description becomes an
 * outcome request (intake.create); the request page gathers the rest.
 */
import { useEffect, useState } from "react";
import { contract } from "./contract";
import { api, Card, ErrorNote, Loading, day, go, money, useAction, useLive } from "./lib";
import { orderStatusLabel } from "./status";

export function Home({ draft, clearDraft }: { draft: string; clearDraft(): void }) {
  const [text, setText] = useState(draft);
  useEffect(() => {
    if (draft) clearDraft();
  }, [draft, clearDraft]);
  const create = useAction(api.intake.create);
  const requests = useLive(api.intake.list, {});

  const start = async () => {
    const r = await create.call({ request: text.trim() });
    if (r) go(`/requests/${r.sessionId}`);
  };

  return (
    <div className="stack">
      <Card>
        <h1>What do you need done?</h1>
        <p className="lede">Describe it in your own words. We will ask only for what {contract.title.toLowerCase()} needs.</p>
        <label className="sr-only" htmlFor="request">Describe what you need done</label>
        <textarea id="request" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: review the supplier bills waiting for approval before Friday's payment run." />
        <ErrorNote>{create.error}</ErrorNote>
        <div className="actions">
          <button className="primary" disabled={!text.trim() || create.pending} onClick={() => void start()}>
            {create.pending ? "Starting…" : "Start my request"}
          </button>
        </div>
      </Card>

      <Card title="Your requests">
        {requests.isLoading ? <Loading label="Loading your requests" /> : null}
        <ErrorNote>{requests.error?.message}</ErrorNote>
        {requests.data && requests.data.length === 0 ? <p className="empty">No requests yet. Describe what you need done above to start one.</p> : null}
        {requests.data && requests.data.length > 0 ? (
          <ul className="requests">
            {requests.data.map((r) => (
              <li key={r.sessionId}>
                <a href={`#/requests/${r.sessionId}`}>
                  <span className="request-text">{r.request}</span>
                  <span className="meta">
                    <span className="badge">{orderStatusLabel(r)}</span>
                    {r.quote ? <span>{money(r.quote.priceMinor, r.quote.currency)}</span> : null}
                    <span>{day(r.createdAt)}</span>
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
