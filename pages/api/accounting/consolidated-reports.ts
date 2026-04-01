/**
 * Consolidated Reports API
 * GET — consolidated trial balance, income statement, balance sheet, dashboard
 * POST — elimination adjustments
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  getConsolidatedTrialBalance,
  getConsolidatedIncomeStatement,
  getConsolidatedBalanceSheet,
  getGroupDashboardStats,
  getEliminationAdjustments,
  createEliminationAdjustment,
  postEliminationAdjustment,
  reverseEliminationAdjustment,
  autoGenerateEliminations,
} from '@/modules/accounting/services/consolidatedReportingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const action = (req.query.action || req.body?.action) as string | undefined;
  const groupId = req.query.group_id as string;

  if (req.method === 'GET') {
    if (!groupId) return apiResponse.badRequest(res, 'group_id required');

    if (action === 'trial-balance') {
      const periodStart = req.query.period_start as string;
      const periodEnd = req.query.period_end as string;
      if (!periodStart || !periodEnd) return apiResponse.badRequest(res, 'period_start and period_end required');
      const report = await getConsolidatedTrialBalance(groupId, periodStart, periodEnd);
      return apiResponse.success(res, report);
    }

    if (action === 'income-statement') {
      const periodStart = req.query.period_start as string;
      const periodEnd = req.query.period_end as string;
      if (!periodStart || !periodEnd) return apiResponse.badRequest(res, 'period_start and period_end required');
      const report = await getConsolidatedIncomeStatement(groupId, periodStart, periodEnd);
      return apiResponse.success(res, report);
    }

    if (action === 'balance-sheet') {
      const asAtDate = req.query.as_at_date as string;
      if (!asAtDate) return apiResponse.badRequest(res, 'as_at_date required');
      const report = await getConsolidatedBalanceSheet(groupId, asAtDate);
      return apiResponse.success(res, report);
    }

    if (action === 'dashboard') {
      const stats = await getGroupDashboardStats(groupId);
      return apiResponse.success(res, stats);
    }

    if (action === 'eliminations') {
      const periodStart = req.query.period_start as string | undefined;
      const periodEnd = req.query.period_end as string | undefined;
      const adjustments = await getEliminationAdjustments(groupId, periodStart, periodEnd);
      return apiResponse.success(res, { items: adjustments });
    }

    return apiResponse.badRequest(res, 'action required: trial-balance, income-statement, balance-sheet, dashboard, eliminations');
  }

  if (req.method === 'POST') {
    if (!groupId && !req.body.groupId) return apiResponse.badRequest(res, 'groupId required');
    const gId = groupId || req.body.groupId;

    if (action === 'create-elimination') {
      const { adjustmentType, description, periodStart, periodEnd, lines } = req.body;
      if (!adjustmentType || !lines?.length) {
        return apiResponse.badRequest(res, 'adjustmentType and lines required');
      }
      const adj = await createEliminationAdjustment(gId, {
        adjustmentType, description, periodStart, periodEnd, lines,
      });
      return apiResponse.success(res, adj);
    }

    if (action === 'post-elimination') {
      const { adjustmentId } = req.body;
      if (!adjustmentId) return apiResponse.badRequest(res, 'adjustmentId required');
      await postEliminationAdjustment(adjustmentId);
      return apiResponse.success(res, { posted: true });
    }

    if (action === 'reverse-elimination') {
      const { adjustmentId } = req.body;
      if (!adjustmentId) return apiResponse.badRequest(res, 'adjustmentId required');
      await reverseEliminationAdjustment(adjustmentId);
      return apiResponse.success(res, { reversed: true });
    }

    if (action === 'auto-eliminate') {
      const { periodStart, periodEnd } = req.body;
      if (!periodStart || !periodEnd) return apiResponse.badRequest(res, 'periodStart and periodEnd required');
      const adjustments = await autoGenerateEliminations(gId, periodStart, periodEnd);
      return apiResponse.success(res, { items: adjustments, count: adjustments.length });
    }

    return apiResponse.badRequest(res, 'action required');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
