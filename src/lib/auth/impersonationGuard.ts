/**
 * R-032 L5: no document is approved, posted, processed, signed off or decided
 * from a platform-admin "Login as" session (Hein, 2026-09-26).
 *
 * The session authenticates as the target, so every such act would be recorded
 * under the name of a person who did not take it. `assertNotImpersonating()` is
 * the one guard; it runs as the FIRST statement of each approving service — the
 * choke point every route, bulk loop and job reaches — before any read or write.
 *
 * It refuses `impersonation` only, not `unknown`. Bearer callers (MCP/OAuth,
 * personal access tokens, the extension) reach these same services with claims
 * that carry no `session_id` (bearerPipeline.ts), as do background jobs with no
 * claims at all; refusing `unknown` here would stop every one of them. A cookie
 * request always carries a GoTrue `session_id`, so for the browser paths the
 * two readings coincide. The approval-request decide path keeps its stricter
 * fail-closed reading (approvalAuthority.ts) because only cookie sessions reach it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import type { NextApiRequest } from 'next';
import { currentSessionActor, sessionActorOfToken } from './impersonationSessions';
import { parseCookies, ACCESS_COOKIE } from './cookies';

export class ImpersonationForbiddenError extends Error {
  // A literal, not a const reference: tests/unit/mcp/typedRefusalReachesAgent's
  // census reads `readonly code = '...'` to hold every refusal to a decision.
  readonly code = 'IMPERSONATION_FORBIDDEN';

  constructor() {
    super('This action cannot be taken while impersonating another user. End the impersonation and act as yourself.');
    this.name = 'ImpersonationForbiddenError';
  }
}

export async function assertNotImpersonating(): Promise<void> {
  if (await currentSessionActor() === 'impersonation') throw new ImpersonationForbiddenError();
}

/**
 * 403 with `details.reason` — the shape the approval-request refusal already
 * answers. Nothing precedes the guard in an approving service, so the COMMIT
 * withAuth issues on a 4xx has nothing of the refused act to commit. Returns
 * true when it answered, for a route's catch to `return` on.
 */
export function respondIfImpersonationForbidden(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ImpersonationForbiddenError)) return false;
  apiResponse.error(res, ErrorCode.FORBIDDEN, err.message, { reason: err.code });
  return true;
}

/**
 * R-032 (f): the account-security routes (change email / password, MFA factor
 * enrol / confirm / remove) run outside withAuth, so they classify the cookie's
 * own access token. They refuse a Login-as session AND a token with no session
 * id — they accept only GoTrue cookies, which always carry one. An invalid
 * token is left to the route's own authentication, which rejects it. Call
 * before any read or write; returns true when it answered 403.
 */
export async function refuseImpersonatedSession(req: NextApiRequest, res: NextApiResponse): Promise<boolean> {
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) return false;
  const actor = await sessionActorOfToken(token);
  if (actor !== 'impersonation' && actor !== 'unknown') return false;
  return respondIfImpersonationForbidden(res, new ImpersonationForbiddenError());
}
