/**
 * Shared client pieces: the typed API, routing (the URL is the only client state), formatting, and
 * small components for loading, errors and live queries.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryState, type FeltKitClientError } from "@feltdb/feltkit/react";
import type { ArgsOf, FunctionReference, ResultOf } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api";
import { formatMinor } from "../src/money";

export { api };

/** Routes live in the URL hash: #/ and #/requests/<intake session id>. */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
export const go = (path: string) => {
  window.location.hash = path;
};

export const money = (minor: number | null | undefined, currency: string | null | undefined) => (minor === null || minor === undefined ? "—" : `${formatMinor(minor)} ${currency ?? ""}`.trim());
/** A moment, in the given IANA time zone (the order's, for deadlines) or the browser's. */
export function date(ms: number | null | undefined, timeZone?: string): string {
  if (!ms) return "—";
  const at = new Date(ms);
  const text = at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  if (!timeZone) return text;
  // Intl refuses timeZoneName together with dateStyle/timeStyle, so the zone's name is formatted on its own.
  const zone = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
  return zone ? `${text} ${zone}` : text;
}
export const day = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");
export const short = (digest: string | null | undefined) => (digest ? `${digest.slice(7, 19)}…` : "—");

/** A live query with its loading and error state. */
export function useLive<F extends FunctionReference<"query">>(fn: F, args: ArgsOf<F> | "skip") {
  return useQueryState(fn, args) as { data: ResultOf<F> | undefined; error: FeltKitClientError | undefined; isLoading: boolean };
}

/**
 * A mutation guarded against duplicate submission: while one call runs, further calls are ignored,
 * and the error (the server's message) is kept for display.
 */
export function useAction<F extends FunctionReference<"mutation">>(fn: F) {
  const run = useMutation(fn);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (args: ArgsOf<F>): Promise<ResultOf<F> | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      return await run(args);
    } catch (e) {
      setError(messageOf(e));
      return undefined;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { call, pending, error, clearError: () => setError(null) };
}

export function messageOf(e: unknown): string {
  const err = e as { message?: string; code?: string; details?: { issues?: string[] } };
  const issues = err.details?.issues;
  return issues?.length ? `${err.message ?? "Refused."} ${issues.slice(0, 6).join("; ")}` : (err.message ?? "Something went wrong.");
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}…
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null;
}

export function Card({ title, children, tone, id }: { title?: ReactNode; children: ReactNode; tone?: "muted" | "done" | "attention"; id?: string }) {
  return (
    <section className={`card${tone ? ` ${tone}` : ""}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}
