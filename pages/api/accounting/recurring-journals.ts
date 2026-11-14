/**
 * Recurring Journals API
 * GET  — list recurring journals
 * POST — create recurring journal. `autoPost` (migration 989) is optional and boolean only: omitted, the template
 *        posts each run as it always has; false generates drafts. Anything else is a 400.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getRecurringJournals,
  createRecurringJournal,
  updateRecurringJournalTemplate,
  RecurringJournalRequestError,
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
    const autoPost: unknown = req.body?.autoPost;
    if (autoPost !== undefined && typeof autoPost !== 'boolean') return apiResponse.badRequest(res, 'autoPost must be true or false');
    try {
      const item = await createRecurringJournal(companyId, { ...req.body, autoPost }, userId);
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
      // R-035 PR6 authorship, and the next-run-date rules (not on or before the last run generated — that would
      // generate it twice — nor after the end date), live in the service: recurringJournalEdits.
      await updateRecurringJournalTemplate(companyId, id, req.user.id, { templateName, frequency, nextRunDate, description });
      log.info('Recurring journal updated', { id });
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      // Refused before the UPDATE wrote anything: the reason, not "Update failed".
      if (err instanceof RecurringJournalRequestError) return apiResponse.badRequest(res, err.message);
      log.error('Recurring journal update failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Update failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
