/**
 * The HTTP answer to an approval-gate refusal (R-035): 409 with the reason, the
 * role today's rule demands and the request a client can act on. Raised before
 * any write (approveSupplierInvoice runs the gate under its row lock, first),
 * so the COMMIT withAuth issues on a 4xx commits nothing of the refused act.
 * Returns true when it answered, for a route's catch to `return` on.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ApprovalRequiredError } from './approvalGate';
import { ApprovalImportAuthorityError } from './approvalGateExempt';

export function respondIfApprovalRequired(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ApprovalRequiredError)) return false;
  apiResponse.conflict(res, err.message, { reason: err.reason, requiredRole: err.requiredRole, requestId: err.requestId });
  return true;
}

/**
 * A write refused by an approval backstop trigger (migrations 712, 862, 865
 * raise `R035_APPROVAL_REQUIRED: …` as P0001) — a path that moves a document
 * into its population without approving it, e.g. a receipt confirmed against
 * a gated DRAFT invoice (R-035 PR4 review F3). Answered 409 with `message`,
 * the caller's plain words, never the trigger's text. Only for a caller whose
 * failed write rolled back to its own savepoint first (withAuth COMMITs a 4xx).
 */
export function respondIfBackstopRefused(res: NextApiResponse, err: unknown, message: string): boolean {
  if (!(err instanceof Error) || (err as { code?: unknown }).code !== 'P0001'
      || !err.message.startsWith('R035_APPROVAL_REQUIRED')) return false;
  apiResponse.conflict(res, message, { reason: 'APPROVAL_REQUIRED' });
  return true;
}

/**
 * 403 for an import of open bills past enforcement by a role below the
 * strictest rule (review HIGH-2). The importers raise it before their first write.
 */
export function respondIfImportRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ApprovalImportAuthorityError)) return false;
  apiResponse.error(res, ErrorCode.FORBIDDEN, err.message, { reason: err.code });
  return true;
}
