/**
 * #1656: a person without the module's Approve permission is answered 403, raised before any
 * write (ApprovePermissionError, core/approvePermission.ts). A route calls this in its catch
 * ahead of its blanket 4xx.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import {
  ApprovePermissionError, approveModuleForRequest, approveRefusedMessage, mayApprove, mayApproveInGroup, type ApproveModule,
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

/**
 * Approving an approval request approves its document, so it takes that document's module Approve (APPROVE_MODULE_BY_DOCUMENT,
 * a legacy credit note by its own type). Fails closed: a type with no module is refused. Answers 403 and returns true when refused.
 */
export async function refuseApprovalRequestWithoutApprove(
  res: NextApiResponse, companyId: string, userId: string, request: { document_type: string; document_id: unknown },
): Promise<boolean> {
  const module = await approveModuleForRequest(companyId, request.document_type, String(request.document_id));
  if (module === null) {
    apiResponse.forbidden(res, `An approval request for a ${request.document_type} cannot be approved here.`);
    return true;
  }
  if (module === 'missing') return false;
  return refuseWithoutApprove(res, companyId, userId, module, `${request.document_type.replace(/_/g, ' ')}s`);
}
