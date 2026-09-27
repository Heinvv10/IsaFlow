/**
 * The HTTP answer to an approval-gate refusal (R-035): 409 with the reason, the
 * role today's rule demands and the request a client can act on. Raised before
 * any write (approveSupplierInvoice runs the gate under its row lock, first),
 * so the COMMIT withAuth issues on a 4xx commits nothing of the refused act.
 * Returns true when it answered, for a route's catch to `return` on.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { ApprovalRequiredError } from './approvalGate';

export function respondIfApprovalRequired(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ApprovalRequiredError)) return false;
  apiResponse.conflict(res, err.message, { reason: err.reason, requiredRole: err.requiredRole, requestId: err.requestId });
  return true;
}
