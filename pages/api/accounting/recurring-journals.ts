/**
 * Recurring Journals API
 * GET  — list recurring journals
 * POST — create recurring journal
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  getRecurringJournals,
  createRecurringJournal,
} from '@/modules/accounting/services/gl/recurringJournalService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { status, limit, offset } = req.query;
    const result = await getRecurringJournals(companyId, {
      status: status as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;
    try {
      const item = await createRecurringJournal(companyId, req.body, userId);
      return apiResponse.success(res, item);
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring journal create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  if (req.method === 'PUT') {
    const { id, templateName, frequency, nextRunDate, description } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      // R-035 PR6: the name, description and next run date are what the
      // template's journals carry (their description and date), so an edit
      // that changes any of them — or the frequency, which dates every later
      // run — makes its user an author of every journal the template mints
      // (refused as their approver). Append-only; an edit changing nothing
      // stamps nobody. Its creator is created_by.
      await sql`
        UPDATE recurring_journals SET
          content_authors = CASE
            WHEN (template_name, frequency, next_run_date, description) IS DISTINCT FROM
                 (COALESCE(${templateName || null}, template_name), COALESCE(${frequency || null}, frequency),
                  COALESCE(${nextRunDate || null}::DATE, next_run_date), COALESCE(${description || null}, description))
            THEN approval_add_author(content_authors, ${req.user.id}::UUID) ELSE content_authors END,
          template_name = COALESCE(${templateName || null}, template_name),
          frequency = COALESCE(${frequency || null}, frequency),
          next_run_date = COALESCE(${nextRunDate || null}, next_run_date),
          description = COALESCE(${description || null}, description),
          updated_at = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId} AND status IN ('active', 'paused')
      `;
      log.info('Recurring journal updated', { id });
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      log.error('Recurring journal update failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Update failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
