/**
 * Intercompany Transactions API
 * GET  — list transactions / reconciliation report
 * POST — create transaction / match transactions
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import {
  listIntercompanyTransactions,
  createIntercompanyTransaction,
  matchIntercompanyTransactions,
  getIntercompanyReconciliation,
} from '@/modules/accounting/services/groupCompanyService';

async function verifyGroupAccess(groupId: string, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM company_group_members cgm
    JOIN company_users cu ON cu.company_id = cgm.company_id
    WHERE cgm.group_id = ${groupId}::UUID AND cu.user_id = ${userId}::UUID
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const action = (req.query.action || req.body?.action) as string | undefined;
  const groupId = req.query.group_id as string;

  if (req.method === 'GET') {
    if (!groupId) return apiResponse.badRequest(res, 'group_id required');
    if (!(await verifyGroupAccess(groupId, userId))) return apiResponse.forbidden(res, 'Access denied to this group');

    if (action === 'reconciliation') {
      const periodStart = req.query.period_start as string;
      const periodEnd = req.query.period_end as string;
      if (!periodStart || !periodEnd) return apiResponse.badRequest(res, 'period_start and period_end required');
      const report = await getIntercompanyReconciliation(groupId, periodStart, periodEnd);
      return apiResponse.success(res, report);
    }

    const filters = {
      dateFrom: req.query.period_start as string | undefined,
      dateTo: req.query.period_end as string | undefined,
      matchStatus: req.query.status as string | undefined,
      sourceCompanyId: req.query.company_id as string | undefined,
    };
    const transactions = await listIntercompanyTransactions(groupId, filters);
    return apiResponse.success(res, { items: transactions });
  }

  if (req.method === 'POST') {
    if (action === 'match') {
      const { sourceId, targetId, groupId: matchGroupId } = req.body;
      if (!sourceId || !targetId) return apiResponse.badRequest(res, 'sourceId and targetId required');
      if (!matchGroupId) return apiResponse.badRequest(res, 'groupId required');
      if (!(await verifyGroupAccess(matchGroupId as string, userId))) return apiResponse.forbidden(res, 'Access denied to this group');
      await matchIntercompanyTransactions(sourceId, targetId);
      return apiResponse.success(res, { matched: true });
    }

    // Create transaction
    const { groupId: gId, sourceCompanyId, targetCompanyId, transactionType, amount, currency, description, transactionDate, sourceJournalEntryId, targetJournalEntryId } = req.body;
    if (!gId || !sourceCompanyId || !targetCompanyId || !transactionType || !amount || !transactionDate) {
      return apiResponse.badRequest(res, 'groupId, sourceCompanyId, targetCompanyId, transactionType, amount, transactionDate required');
    }
    if (!(await verifyGroupAccess(gId as string, userId))) return apiResponse.forbidden(res, 'Access denied to this group');
    const tx = await createIntercompanyTransaction({
      groupId: gId,
      sourceCompanyId,
      targetCompanyId,
      transactionType,
      amount,
      currency,
      description,
      transactionDate,
      sourceJournalEntryId,
      targetJournalEntryId,
    });
    return apiResponse.success(res, tx);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
