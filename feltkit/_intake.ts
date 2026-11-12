/**
 * Starting a bill-review intake. (A helper module, not functions.) `intake.create` and a task request
 * whose customer chose the bill-review service (tasks.respondToPath) start an intake the same way.
 */
import type { MutationCtx } from "@feltdb/feltkit";
import { audit, intakeSessions, outcomeRequests } from "./app.js";
import { CONTRACT } from "./_guards.js";

export async function startIntake(ctx: MutationCtx, tenantId: string, request: string): Promise<{ sessionId: string; outcomeRequestId: string }> {
  const by = ctx.auth.requirePrincipal().id;
  const now = Date.now();
  const outcomeRequestId = await ctx.db.insert(outcomeRequests, { tenantId, text: request, contract: CONTRACT.key, requestedBy: by, requestedAt: now });
  const sessionId = await ctx.db.insert(intakeSessions, { tenantId, outcomeRequestId, contract: CONTRACT.key, contractDigest: CONTRACT.digest, createdBy: by, createdAt: now });
  await audit.record(ctx, { subject: "intake", id: sessionId, type: "intake.created", data: { contract: CONTRACT.key } });
  return { sessionId, outcomeRequestId };
}
