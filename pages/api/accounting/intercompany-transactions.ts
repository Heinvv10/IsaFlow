/**
 * Intercompany Transactions API
 * GET  — list transactions / reconciliation report
 * POST — create transaction / match transactions
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import {
  listIntercompanyTransactions,
  createIntercompanyTransaction,
  matchIntercompanyTransactions,
  getIntercompanyReconciliation,
} from '@/modules/accounting/services/groupCompanyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = (req.query.action || req.body?.action) as string | undefined;
  const groupId = req.query.group_id as string;

  if (req.method === 'GET') {
    if (!groupId) return apiResponse.badRequest(res, 'group_id required');

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
      const { sourceId, targetId } = req.body;
      if (!sourceId || !targetId) return apiResponse.badRequest(res, 'sourceId and targetId required');
      await matchIntercompanyTransactions(sourceId, targetId);
      return apiResponse.success(res, { matched: true });
    }

    // Create transaction
    const { groupId: gId, sourceCompanyId, targetCompanyId, transactionType, amount, currency, description, transactionDate, sourceJournalEntryId, targetJournalEntryId } = req.body;
    if (!gId || !sourceCompanyId || !targetCompanyId || !transactionType || !amount || !transactionDate) {
      return apiResponse.badRequest(res, 'groupId, sourceCompanyId, targetCompanyId, transactionType, amount, transactionDate required');
    }
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
export default withAuth(withErrorHandler(handler as any));
