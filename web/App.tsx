/**
 * The application shell. Sign-in, verification, invitations and organizations are FeltKit's own
 * (cookie sessions, CSRF); get-it adds no authentication of its own.
 */
import { useState, type ReactNode } from "react";
import { AcceptInvitation, AuthNotices, CreateTenant, SignIn, useAuth, useAuthRedirect, useTenant } from "@feltdb/feltkit/react";
import { contract } from "./contract";
import { Home } from "./Home";
import { RequestPage } from "./RequestPage";
import { Loading, go, useRoute } from "./lib";

export function App() {
  const auth = useAuth();
  const tenant = useTenant();
  const { redirect } = useAuthRedirect();
  // What a visitor typed before signing in: kept in memory for this page only, never stored.
  const [draft, setDraft] = useState("");

  if (auth.loading) return <Frame><Loading label="Opening get-it" /></Frame>;
  if (redirect?.kind === "invitation") return <Frame><AcceptInvitation brand={{ name: "get-it" }} /></Frame>;
  if (!auth.user) return <Landing draft={draft} setDraft={setDraft} />;
  if (!tenant.current) {
    return (
      <Frame>
        <div className="narrow">
          <AuthNotices />
          <CreateTenant title="Name your organization" />
          <p className="hint">Your requests, quotes and deliveries belong to your organization. Colleagues you invite see them too.</p>
        </div>
      </Frame>
    );
  }
  return (
    <Frame header={<Header />}>
      <AuthNotices />
      <Routes key={tenant.current.id} draft={draft} clearDraft={() => setDraft("")} />
    </Frame>
  );
}

function Routes({ draft, clearDraft }: { draft: string; clearDraft(): void }) {
  const [section, id] = useRoute();
  if (section === "requests" && id) return <RequestPage sessionId={id} />;
  return <Home draft={draft} clearDraft={clearDraft} />;
}

function Header() {
  const auth = useAuth();
  const tenant = useTenant();
  return (
    <header className="topbar">
      <a className="brand" href="#/" onClick={() => go("/")}>
        <img src="/favicon.svg" alt="" width="26" height="26" /> get-it
      </a>
      <div className="who">
        <span className="org" data-testid="organization">{tenant.current?.name}</span>
        <span className="email">{auth.account?.email ?? auth.user?.displayName}</span>
        <button className="link" onClick={() => void auth.signOut()}>Sign out</button>
      </div>
    </header>
  );
}

function Frame({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <div className="page">
      {header ?? (
        <header className="topbar">
          <span className="brand"><img src="/favicon.svg" alt="" width="26" height="26" /> get-it</span>
        </header>
      )}
      <main>{children}</main>
      <footer className="footer">
        {contract.title} · contract {contract.id}@{contract.version}
      </footer>
    </div>
  );
}

/** For visitors: what the service is, the question it starts from, and FeltKit's sign-in. */
function Landing({ draft, setDraft }: { draft: string; setDraft(v: string): void }) {
  return (
    <Frame>
      <div className="landing">
        <section className="hero">
          <h1>What do you need done?</h1>
          <label className="sr-only" htmlFor="landing-request">Describe what you need done</label>
          <textarea id="landing-request" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="For example: review the supplier bills waiting for approval before Friday's payment run." />
          <p className="lede">
            Today we deliver one outcome: <strong>{contract.title.toLowerCase()}</strong>. {contract.outcome}
          </p>
          <ul className="promises">
            <li>You provide your bills, vendors and accounts. We tell you exactly what is missing.</li>
            <li>You see the price, scope, assumptions and timing before you commit.</li>
            <li>A person approves every package. Every result cites the input it came from.</li>
            <li>We never change your books: no posting, paying, voiding or sending.</li>
          </ul>
        </section>
        <section className="signin" aria-label="Sign in">
          <p className="hint">{draft.trim() ? "Create an account or sign in to continue with your request." : "Create an account or sign in to start."}</p>
          <SignIn brand={{ name: "get-it" }} initialMode="sign-up" />
        </section>
      </div>
    </Frame>
  );
}
