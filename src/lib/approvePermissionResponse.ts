/**
 * #1656: a person without the module's Approve permission is answered 403, raised before any
 * write (ApprovePermissionError, core/approvePermission.ts). A route calls this in its catch
 * ahead of its blanket 4xx.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import {
  ApprovePermissionError, approveRefusedMessage, mayApprove, mayApproveInGroup, type ApproveModule,
} from '@/modules/accounting/services/core/approvePermission';

export function respondIfApprovePermissionRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ApprovePermissionError)) return false;
  apiResponse.forbidden(res, err.message);
  return true;
}

/**
 * Answers 403 (and returns true) when the person may not approve on `module`; the route returns at
 * once. Called before the document is read or locked.
 */
export async function refuseWithoutApprove(
  res: NextApiResponse, companyId: string, userId: string, module: ApproveModule, what: string,
): Promise<boolean> {
  if (await mayApprove(companyId, userId, module)) return false;
  apiResponse.forbidden(res, approveRefusedMessage(module, what));
  return true;
}

/** As refuseWithoutApprove, for an action on a group: Approve is asked in the group's member companies (mayApproveInGroup). */
export async function refuseWithoutGroupApprove(
  res: NextApiResponse, groupId: string, userId: string, module: ApproveModule, what: string,
): Promise<boolean> {
  if (await mayApproveInGroup(userId, groupId, module)) return false;
  apiResponse.forbidden(res, approveRefusedMessage(module, what));
  return true;
}
