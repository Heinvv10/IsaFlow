/**
 * Practice Time Entry Duplicate API
 * POST /api/accounting/practice/time-entries/duplicate — duplicate entry to a new date
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { duplicatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { id, newDate } = req.body as { id?: string; newDate?: string };

  if (!id || !newDate) return apiResponse.badRequest(res, 'id and newDate are required');

  try {
    const entry = await duplicatePracticeEntry(companyId, id, newDate);
    return apiResponse.created(res, entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Duplicate failed';
    log.error('Practice time entry duplicate failed', { error: err }, 'practice-api');
    return apiResponse.badRequest(res, msg);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
