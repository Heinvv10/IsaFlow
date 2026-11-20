/**
 * Consolidated Reports API
 * GET — consolidated trial balance, income statement, balance sheet, dashboard
 * POST — elimination adjustments
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { userBelongsToGroup, userCanWriteGroup } from '@/modules/accounting/services/core/companyAccessService';
import { isUuidParam } from '@/lib/validation';
import { getGroupAccounts } from '@/modules/accounting/services/reports/groupCompanyService';
import { EliminationStateError, EliminationUnbalancedError } from '@/modules/accounting/services/reports/eliminationErrors';
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
} from '@/modules/accounting/services/reports/consolidatedReportingService';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';

/**
 * 400 text for a bad date range, or null — checked before any query, because an unvalidated
 * date reaches a SQL date cast and 500s. `typeof` first inside isLedgerDate: a repeated
 * param is an array. `optional`: a missing date is allowed, a present one must be valid.
 */
function rangeError(
  start: unknown, end: unknown, { optional = false, names = ['period_start', 'period_end'] } = {},
): string | null {
  const [s, e] = names as [string, string];
  if (!optional && (start === undefined || end === undefined || start === '' || end === '')) return `${s} and ${e} required`;
  if (start !== undefined && !isLedgerDate(start)) return `${s} ${LEDGER_DATE_MESSAGE}`;
  if (end !== undefined && !isLedgerDate(end)) return `${e} ${LEDGER_DATE_MESSAGE}`;
  return typeof start === 'string' && typeof end === 'string' && start > end ? `${s} must not be after ${e}` : null;
}

/** 400 text for a create-elimination body, or null. `typeof` on every field before it is used. */
function eliminationBodyError(body: Record<string, unknown>): string | null {
  if (typeof body.adjustmentType !== 'string' || !body.adjustmentType) return 'adjustmentType is required (a string)';
  if (body.description !== undefined && typeof body.description !== 'string') return 'description must be a string';
  if (!Array.isArray(body.lines) || body.lines.length === 0) return 'lines must be a non-empty array';
  for (const line of body.lines as unknown[]) {
    const l = (line ?? {}) as Record<string, unknown>;
    if (!isUuidParam(l.groupAccountId)) return 'each line needs a groupAccountId (a group account UUID)';
    for (const side of ['debit', 'credit'] as const) {
      const v = l[side];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `each line's ${side} must be a non-negative number`;
    }
    if (l.description !== undefined && typeof l.description !== 'string') return "each line's description must be a string";
  }
  return null;
}

/** The elimination journal's expected refusals → 400 / 409 with their message; anything else rethrows (500). */
async function answerRefusals(res: NextApiResponse, write: () => Promise<unknown>): Promise<unknown> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof EliminationUnbalancedError) return apiResponse.badRequest(res, err.message);
    if (err instanceof EliminationStateError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

// Uses withAuth (not withCompany) because consolidated reports aggregate data
// from multiple companies in a group. Security comes from userBelongsToGroup(),
// which ensures the caller belongs to at least one company in the group before
// any read. That guard used to be an inline copy here that compared
// company_users.user_id (text) to a ::UUID cast, so every request 500'd.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const action = (req.query.action || req.body?.action) as string | undefined;
  const groupId = req.query.group_id as string;

  const verifyGroupAccess = (gId: string) => userBelongsToGroup(userId, gId);

  if (req.method === 'GET') {
    if (groupId === undefined) return apiResponse.badRequest(res, 'group_id required');
    if (!isUuidParam(req.query.group_id)) return apiResponse.badRequest(res, 'group_id must be a valid UUID');
    if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');

    if (action === 'trial-balance') {
      const periodStart = req.query.period_start as string;
      const periodEnd = req.query.period_end as string;
      const bad = rangeError(req.query.period_start, req.query.period_end);
      if (bad) return apiResponse.badRequest(res, bad);
      const report = await getConsolidatedTrialBalance(groupId, periodStart, periodEnd);
      return apiResponse.success(res, report);
    }

    if (action === 'income-statement') {
      const periodStart = req.query.period_start as string;
      const periodEnd = req.query.period_end as string;
      const bad = rangeError(req.query.period_start, req.query.period_end);
      if (bad) return apiResponse.badRequest(res, bad);
      const report = await getConsolidatedIncomeStatement(groupId, periodStart, periodEnd);
      return apiResponse.success(res, report);
    }

    if (action === 'balance-sheet') {
      const asAtDate = req.query.as_at_date as string;
      if (!asAtDate) return apiResponse.badRequest(res, 'as_at_date required');
      if (!isLedgerDate(req.query.as_at_date)) return apiResponse.badRequest(res, `as_at_date ${LEDGER_DATE_MESSAGE}`);
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
      const bad = rangeError(req.query.period_start, req.query.period_end, { optional: true });
      if (bad) return apiResponse.badRequest(res, bad);
      const adjustments = await getEliminationAdjustments(groupId, periodStart, periodEnd);
      return apiResponse.success(res, { items: adjustments });
    }

    return apiResponse.badRequest(res, 'action required: trial-balance, income-statement, balance-sheet, dashboard, eliminations');
  }

  if (req.method === 'POST') {
    const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};
    const rawGroupId: unknown = req.query.group_id ?? body.groupId;
    if (rawGroupId === undefined) return apiResponse.badRequest(res, 'groupId required');
    if (!isUuidParam(rawGroupId)) return apiResponse.badRequest(res, 'group_id must be a valid UUID');
    const gId = rawGroupId;
    if (!(await verifyGroupAccess(gId))) return apiResponse.forbidden(res, 'Access denied to this group');
    // Every POST action writes eliminations: membership alone (any role) reads, it does not write.
    if (!(await userCanWriteGroup(userId, gId))) {
      return apiResponse.forbidden(res, 'Your role in this group does not allow changing eliminations.');
    }
    if ((action === 'post-elimination' || action === 'reverse-elimination') && !isUuidParam(body.adjustmentId)) {
      return apiResponse.badRequest(res, 'adjustmentId must be a valid UUID');
    }

    if (action === 'create-elimination') {
      const shape = eliminationBodyError(body);
      if (shape) return apiResponse.badRequest(res, shape);
      // lines is JSONB (no FK): an id from another group, or none at all, would be stored and
      // then silently dropped by the reports, leaving the elimination one-sided. Own, active only.
      const own = new Set((await getGroupAccounts(gId)).map(a => a.id));
      if ((body.lines as Array<{ groupAccountId: string }>).some(l => !own.has(l.groupAccountId))) {
        return apiResponse.badRequest(res, "each line's groupAccountId must be an active account of this group");
      }
      const { adjustmentType, description, periodStart, periodEnd, lines } = req.body;
      const bad = rangeError(periodStart, periodEnd, { optional: true, names: ['periodStart', 'periodEnd'] });
      if (bad) return apiResponse.badRequest(res, bad);
      return answerRefusals(res, async () => apiResponse.success(res, await createEliminationAdjustment(gId, {
        adjustmentType, description, periodStart, periodEnd, lines,
      })));
    }

    if (action === 'post-elimination') {
      return answerRefusals(res, async () => {
        await postEliminationAdjustment(body.adjustmentId as string, gId);
        return apiResponse.success(res, { posted: true });
      });
    }

    if (action === 'reverse-elimination') {
      return answerRefusals(res, async () => {
        await reverseEliminationAdjustment(body.adjustmentId as string, gId);
        return apiResponse.success(res, { reversed: true });
      });
    }

    if (action === 'auto-eliminate') {
      const { periodStart, periodEnd } = req.body;
      const bad = rangeError(periodStart, periodEnd, { names: ['periodStart', 'periodEnd'] });
      if (bad) return apiResponse.badRequest(res, bad);
      const adjustments = await autoGenerateEliminations(gId, periodStart, periodEnd);
      return apiResponse.success(res, { items: adjustments, count: adjustments.length });
    }

    return apiResponse.badRequest(res, 'action required');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));
