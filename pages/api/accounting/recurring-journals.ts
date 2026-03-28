/**
 * Recurring Journals API
 * GET  — list recurring journals
 * POST — create recurring journal
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  getRecurringJournals,
  createRecurringJournal,
} from '@/modules/accounting/services/recurringJournalService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Recurring journal create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'PUT') {
    const { id, templateName, frequency, nextRunDate, description } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      await sql`
        UPDATE recurring_journals SET
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
      log.error('Recurring journal update failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Update failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
