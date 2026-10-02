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
import { isJobFenceRefusal } from '@/modules/accounting/services/practice/practiceClientFence';
import { isJsonObjectBody, isRealCalendarDate, isUuidParam } from '@/lib/validation';
import { duplicatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  if (!isJsonObjectBody(req.body)) return apiResponse.badRequest(res, 'Request body must be a JSON object');
  const { id, newDate } = req.body as { id?: string; newDate?: string };

  if (!id || !newDate) return apiResponse.badRequest(res, 'id and newDate are required');
  // id reaches a ::UUID cast on a read with no savepoint (22P02 → 500).
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a UUID');
  // newDate reaches a ::DATE cast after reads with no savepoint: refuse an impossible date before any SQL.
  if (typeof newDate !== 'string' || !isRealCalendarDate(newDate)) {
    return apiResponse.badRequest(res, 'newDate must be a real date (YYYY-MM-DD)');
  }

  try {
    const entry = await duplicatePracticeEntry(companyId, id, newDate);
    return apiResponse.created(res, entry);
  } catch (err) {
    if (isJobFenceRefusal(err)) {
      log.warn('Practice time entry duplicate refused', { id, code: err.code, message: err.message }, 'practice-api');
      return apiResponse.badRequest(res, err.message);
    }
    log.error('Practice time entry duplicate failed', { error: err }, 'practice-api');
    return apiResponse.badRequestFromError(res, err, 'Duplicate failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
