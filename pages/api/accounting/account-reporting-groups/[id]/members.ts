/**
 * Account Reporting Group Members API
 * GET  /api/accounting/account-reporting-groups/[id]/members — list members
 * POST /api/accounting/account-reporting-groups/[id]/members — replace all members
 *   body: { gl_account_ids: string[] }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getAccountReportingGroup,
  replaceGroupMembers,
} from '@/modules/accounting/services/reports/accountReportingGroupsService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const groupId = req.query.id as string;

  if (!groupId) {
    return apiResponse.badRequest(res, 'Group ID is required');
  }

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const group = await getAccountReportingGroup(companyId, groupId);
    if (!group) return apiResponse.notFound(res, 'Group not found');
    return apiResponse.success(res, { items: group.members, count: group.members.length });
  }

  // ── POST (replace) ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { gl_account_ids } = req.body as Record<string, unknown>;

    if (!Array.isArray(gl_account_ids)) {
      return apiResponse.badRequest(res, 'gl_account_ids must be an array');
    }

    const invalidIds = gl_account_ids.filter(id => typeof id !== 'string' || !id.trim());
    if (invalidIds.length > 0) {
      return apiResponse.badRequest(res, 'All gl_account_ids must be non-empty strings');
    }

    try {
      const members = await replaceGroupMembers(companyId, groupId, gl_account_ids as string[]);
      return apiResponse.success(res, { items: members, count: members.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update members';
      log.error('Failed to replace group members', { error: err, companyId, groupId }, 'accounting-api');
      if (msg.includes('not found') || msg.includes('access denied')) {
        return apiResponse.notFound(res, msg);
      }
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(handler));
