/**
 * The application shell. Sign-in, verification, invitations and organizations are FeltKit's own
 * (cookie sessions, CSRF); get-it adds no authentication of its own.
 */
import { useState, type ReactNode } from "react";
import { AcceptInvitation, AuthNotices, CreateTenant, SignIn, useAuth, useAuthRedirect, useTenant } from "@feltdb/feltkit/react";
import { Availability, EXAMPLES } from "./copy";
import { Home } from "./Home";
import { RequestPage } from "./RequestPage";
import { TaskPage } from "./TaskPage";
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
  if (section === "tasks" && id) return <TaskPage requestId={id} />;
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
      <footer className="footer">get-it · say what you need done</footer>
    </div>
  );
}

/** For visitors: the question, examples of the kind of things people ask, and FeltKit's sign-in. */
function Landing({ draft, setDraft }: { draft: string; setDraft(v: string): void }) {
  return (
    <Frame>
      <div className="landing">
        <section className="hero">
          <h1>What do you need done?</h1>
          <p className="lede">Describe it in your own words. You don't need to pick a category: we work through the details with you, tell you what we need, and give you a price before anything starts.</p>
          <label className="sr-only" htmlFor="landing-request">Describe what you need done</label>
          <textarea id="landing-request" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="For example: research our five main competitors and summarize their pricing." />
          <p className="hint">People ask us things like:</p>
          <ul className="examples" aria-label="Examples">
            {EXAMPLES.map((e) => <li key={e}>“{e}”</li>)}
          </ul>
          <p className="hint">These are examples of requests, not a list of services.</p>
          <Availability />
        </section>
        <section className="signin" aria-label="Sign in">
          <p className="hint">{draft.trim() ? "Create an account or sign in to send your request." : "Create an account or sign in to start."}</p>
          <SignIn brand={{ name: "get-it" }} initialMode="sign-up" />
        </section>
      </div>
    </Frame>
  );
}
