/**
 * #1656: a person without the module's Approve permission is answered 403, raised before any
 * write (ApprovePermissionError, core/approvePermission.ts). A route calls this in its catch
 * ahead of its blanket 4xx.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';

export function respondIfApprovePermissionRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ApprovePermissionError)) return false;
  apiResponse.forbidden(res, err.message);
  return true;
}
