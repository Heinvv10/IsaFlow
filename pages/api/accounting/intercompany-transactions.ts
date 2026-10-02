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
import { userBelongsToGroup, userCanWriteGroup } from '@/modules/accounting/services/core/companyAccessService';
import { isUuidParam } from '@/lib/validation';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import {
  INTERCOMPANY_TRANSACTION_TYPES, IntercompanyNotFoundError,
} from '@/modules/accounting/services/reports/intercompanyService';

/**
 * 400 text for a create body's values, or null — typeof first; each reached SQL unchecked and a
 * bad one 500'd (blind review of 5446d243c). Ids are checked separately (badUuid).
 */
function intercompanyValueError(body: Record<string, unknown>): string | null {
  if (typeof body.transactionType !== 'string' || !(INTERCOMPANY_TRANSACTION_TYPES as readonly string[]).includes(body.transactionType)) {
    return `transactionType must be one of ${INTERCOMPANY_TRANSACTION_TYPES.join(', ')}`;
  }
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) return 'amount must be a positive number';
  if (!isLedgerDate(body.transactionDate)) return `transactionDate ${LEDGER_DATE_MESSAGE}`;
  if (body.currency !== undefined && typeof body.currency !== 'string') return 'currency must be a string';
  if (body.description !== undefined && typeof body.description !== 'string') return 'description must be a string';
  return null;
}

/** First of `fields` (in `body`) that is present-or-required and not a UUID string, or null. typeof first. */
function badUuid(body: Record<string, unknown>, required: string[], optional: string[] = []): string | null {
  for (const f of required) if (!isUuidParam(body[f])) return f;
  for (const f of optional) if (body[f] !== undefined && body[f] !== null && body[f] !== '' && !isUuidParam(body[f])) return f;
  return null;
}

// Uses withAuth (not withCompany) because intercompany transactions cross company
// boundaries. Security is provided by verifyGroupAccess() which ensures the user
// belongs to at least one company in the group before any read or write.
// Delegates to companyAccessService — this was an inline copy that compared
// company_users.user_id (text) to a ::UUID cast, so every request 500'd.
async function verifyGroupAccess(groupId: string, userId: string): Promise<boolean> {
  return userBelongsToGroup(userId, groupId);
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

// Both POST branches WRITE: a matched transaction becomes an elimination on the next
// auto-eliminate, so membership (any role) reads and a group write role writes.
const WRITE_REFUSED = 'Your role in this group does not allow this change.';

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
      // Each reaches a ::UUID cast: a malformed or repeated value used to 500 (D4 round 9).
      const badMatch = badUuid(req.body, ['sourceId', 'targetId', 'groupId']);
      if (badMatch) return apiResponse.badRequest(res, `${badMatch} must be a valid UUID`);
      if (!(await verifyGroupAccess(matchGroupId as string, userId))) return apiResponse.forbidden(res, 'Access denied to this group');
      if (!(await userCanWriteGroup(userId, matchGroupId as string))) return apiResponse.forbidden(res, WRITE_REFUSED);
      try {
        await matchIntercompanyTransactions(sourceId, targetId, matchGroupId as string);
      } catch (err) {
        if (err instanceof IntercompanyNotFoundError) return apiResponse.notFound(res, 'Intercompany transaction', err.missing.join(', '));
        throw err;
      }
      return apiResponse.success(res, { matched: true });
    }

    // Create transaction
    const { groupId: gId, sourceCompanyId, targetCompanyId, transactionType, amount, currency, description, transactionDate, sourceJournalEntryId, targetJournalEntryId } = req.body;
    if (!gId || !sourceCompanyId || !targetCompanyId || !transactionType || !amount || !transactionDate) {
      return apiResponse.badRequest(res, 'groupId, sourceCompanyId, targetCompanyId, transactionType, amount, transactionDate required');
    }
    const badCreate = badUuid(req.body, ['groupId', 'sourceCompanyId', 'targetCompanyId'], ['sourceJournalEntryId', 'targetJournalEntryId']);
    if (badCreate) return apiResponse.badRequest(res, `${badCreate} must be a valid UUID`);
    const badValue = intercompanyValueError(req.body);
    if (badValue) return apiResponse.badRequest(res, badValue);
    if (!(await verifyGroupAccess(gId as string, userId))) return apiResponse.forbidden(res, 'Access denied to this group');
    if (!(await userCanWriteGroup(userId, gId as string))) return apiResponse.forbidden(res, WRITE_REFUSED);

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
