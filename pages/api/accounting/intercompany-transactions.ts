/**
 * Intercompany Transactions API
 * GET  — list transactions / reconciliation report
 * POST — create transaction / match transactions
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import {
  listIntercompanyTransactions,
  createIntercompanyTransaction,
  matchIntercompanyTransactions,
  getIntercompanyReconciliation,
} from '@/modules/accounting/services/reports/groupCompanyService';

// Uses withAuth (not withAuth) because intercompany transactions cross company
// boundaries. Security is provided by verifyGroupAccess() which ensures the user
// belongs to at least one company in the group before any read or write.
async function verifyGroupAccess(groupId: string, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM company_group_members cgm
    JOIN company_users cu ON cu.company_id = cgm.company_id
    WHERE cgm.group_id = ${groupId}::UUID AND cu.user_id = ${userId}::UUID
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

// verifyGroupAccess only proves the caller belongs to SOME company in the group.
// It does NOT prove that a body-supplied source/target companyId is itself in the
// group — without this, a group member can POST an arbitrary company UUID and forge
// an intercompany_transactions row that leaks that tenant's name via later JOINs
// (pentest MEDIUM — cross-tenant record forgery). Gate every body-supplied companyId
// on active group membership (left_date IS NULL) before it reaches the INSERT.
async function verifyCompanyInGroup(groupId: string, companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM company_group_members
    WHERE group_id = ${groupId}::UUID AND company_id = ${companyId}::UUID AND left_date IS NULL
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

// A journal-entry id is a company-scoped resource; scope the existence check by the
// (already group-verified) owning company so a caller cannot bind an unrelated
// tenant's journal entry into the intercompany row.
async function journalEntryBelongsToCompany(journalEntryId: string, companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_journal_entries
    WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID
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
      await matchIntercompanyTransactions(sourceId, targetId, matchGroupId as string);
      return apiResponse.success(res, { matched: true });
    }

    // Create transaction
    const { groupId: gId, sourceCompanyId, targetCompanyId, transactionType, amount, currency, description, transactionDate, sourceJournalEntryId, targetJournalEntryId } = req.body;
    if (!gId || !sourceCompanyId || !targetCompanyId || !transactionType || !amount || !transactionDate) {
      return apiResponse.badRequest(res, 'groupId, sourceCompanyId, targetCompanyId, transactionType, amount, transactionDate required');
    }
    if (!(await verifyGroupAccess(gId as string, userId))) return apiResponse.forbidden(res, 'Access denied to this group');

    // Both source and target companies must be active members of the group — reject
    // forged/foreign companyIds before they reach the INSERT (cross-tenant forgery).
    if (!(await verifyCompanyInGroup(gId as string, sourceCompanyId as string))) {
      return apiResponse.forbidden(res, 'sourceCompanyId is not a member of this group');
    }
    if (!(await verifyCompanyInGroup(gId as string, targetCompanyId as string))) {
      return apiResponse.forbidden(res, 'targetCompanyId is not a member of this group');
    }

    // Optional journal-entry links must belong to their respective (verified) company.
    if (sourceJournalEntryId && !(await journalEntryBelongsToCompany(sourceJournalEntryId as string, sourceCompanyId as string))) {
      return apiResponse.forbidden(res, 'sourceJournalEntryId does not belong to sourceCompanyId');
    }
    if (targetJournalEntryId && !(await journalEntryBelongsToCompany(targetJournalEntryId as string, targetCompanyId as string))) {
      return apiResponse.forbidden(res, 'targetJournalEntryId does not belong to targetCompanyId');
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

 
export default withAuth(withErrorHandler(withCsrf(handler)));
