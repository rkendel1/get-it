/**
 * HTTP harness: get-it's real FeltKit server on a real port, driven only through HTTP.
 *
 * - The runtime is FeltKit's test runtime (a fresh FeltDB in a temporary directory). The server is
 *   FeltKit's own `startServer`, the one `feltkit dev` and `feltkit start` run.
 * - Identities are real accounts: password sign-up, e-mail verification through the e-mailed link,
 *   then organizations created and joined through FeltKit's tenancy endpoints (invitation links).
 *   Every session is a bearer token the server issued, and switching or joining rotates it, as in
 *   production.
 *
 * Tests read storage directly only to inspect economic effects (how many payments, orders, …),
 * never to perform a step.
 */
import assert from "node:assert/strict";
import { startServer } from "@feltdb/feltkit/server";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";

export interface Reply {
  status: number;
  body: any;
}

export interface Http {
  url: string;
  t: TestApp;
  request(method: string, path: string, body?: unknown, token?: string): Promise<Reply>;
}

/** A signed-in person: an account with a verified address and a server-issued session. */
export class Person {
  constructor(
    readonly http: Http,
    readonly email: string,
    public id: string,
    public token: string,
  ) {}

  /** Call a get-it function over HTTP. Resolves with the value, rejects with the error body (code, hint, status). */
  async call(kind: "query" | "mutation", name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.http.request("POST", `/api/${kind}/${name}`, { args }, this.token);
    if (r.status === 200 && r.body.ok) return r.body.value;
    throw Object.assign(new Error(`${name}: ${r.status} ${JSON.stringify(r.body.error ?? r.body)}`), { status: r.status, code: r.body.error?.code, hint: r.body.error?.hint, details: r.body.error?.details, body: r.body });
  }
  query(name: string, args?: Record<string, unknown>) {
    return this.call("query", name, args);
  }
  mutation(name: string, args?: Record<string, unknown>) {
    return this.call("mutation", name, args);
  }

  /** Raw call, for asserting on the HTTP response itself. */
  raw(kind: "query" | "mutation", name: string, args: Record<string, unknown> = {}) {
    return this.http.request("POST", `/api/${kind}/${name}`, { args }, this.token);
  }

  /** Work in another of your organizations (the session rotates). */
  async switchTo(tenantId: string) {
    const r = await this.http.request("POST", "/api/tenants/switch", { tenantId }, this.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    this.token = r.body.token;
  }
}

export async function withServer(fn: (http: Http) => Promise<void>) {
  const t = await createTestApp();
  const server = await startServer({ runtime: t.runtime, projectDir: process.cwd(), host: "127.0.0.1", port: 0, dashboard: { enabled: false, adminToken: "", dir: null } });
  try {
    await fn(httpFor(server.url, t));
  } finally {
    await server.close();
    await t.close();
  }
}

/** An HTTP client for a running server (bearer sessions). */
export function httpFor(url: string, t: TestApp): Http {
  return {
    url,
    t,
    async request(method, path, body, token) {
      const r = await fetch(`${url}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
  };
}

const PASSWORD = "correct horse battery staple";

/** Sign up with a password and verify the address through the e-mailed link, all over HTTP. */
export async function signUp(http: Http, email: string, name: string): Promise<Person> {
  const r = await http.request("POST", "/api/auth/signup", { email, password: PASSWORD, name });
  assert.equal(r.status, 201, `sign-up ${email}: ${JSON.stringify(r.body)}`);
  const v = await http.request("POST", "/api/auth/verify/request", { email });
  assert.equal(v.status, 202, `verify request ${email}: ${JSON.stringify(v.body)}`);
  const mail = [...(http.t.runtime.mail?.inbox ?? [])].reverse().find((m) => m.to === email && m.text.includes("#feltkit-verify="));
  assert.ok(mail, `a verification e-mail to ${email}`);
  const token = /#feltkit-verify=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  const done = await http.request("POST", "/api/auth/verify", { token });
  assert.equal(done.status, 200, `verify ${email}: ${JSON.stringify(done.body)}`);
  return new Person(http, email, r.body.principal.id, r.body.token);
}

/** The owner creates an organization over HTTP; their session now works in it. */
export async function createOrganization(owner: Person, name: string): Promise<string> {
  const r = await owner.http.request("POST", "/api/tenants", { name }, owner.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  owner.token = r.body.token;
  return r.body.tenant.id as string;
}

/** The owner invites someone with a role; they accept the invitation link with their own session. */
export async function join(owner: Person, who: Person, role: "member" | "operator"): Promise<void> {
  const r = await owner.http.request("POST", "/api/tenants/current/invitations", { email: who.email, role, send: false }, owner.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = /#feltkit-invitation=(fki_[A-Za-z0-9_-]+)/.exec(r.body.link)![1]!;
  const a = await who.http.request("POST", "/api/invitations/accept", { token }, who.token);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  who.token = a.body.token;
}

export async function refused(p: Promise<unknown>, code: string, hint?: string) {
  await assert.rejects(p, (e: any) => {
    assert.equal(e.code, code, e.message);
    if (hint) assert.equal(e.hint ?? e.details?.hint, hint, e.message);
    return true;
  });
}

/** Storage, read beneath the tenant scope, only to count economic effects. */
export const stored = (http: Http, name: string) => http.t.runtime.instance.handle("test.inspect").collection<Record<string, any>>(name).find({});

/** Sign an existing account in over HTTP (a separate bearer session) and work in an organization. */
export async function signIn(http: Http, email: string, tenantId?: string): Promise<Person> {
  const r = await http.request("POST", "/api/auth/signin", { email, password: PASSWORD });
  assert.equal(r.status, 200, `sign-in ${email}: ${JSON.stringify(r.body)}`);
  const person = new Person(http, email, r.body.principal.id, r.body.token);
  if (tenantId) await person.switchTo(tenantId);
  return person;
}

export { PASSWORD };
