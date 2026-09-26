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
import { currentSessionActor } from './impersonationSessions';

export const IMPERSONATION_FORBIDDEN = 'IMPERSONATION_FORBIDDEN';

export class ImpersonationForbiddenError extends Error {
  readonly code = IMPERSONATION_FORBIDDEN;

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
