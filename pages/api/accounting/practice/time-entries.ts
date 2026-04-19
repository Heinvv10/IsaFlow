/**
 * Practice Time Entries API
 * GET  /api/accounting/practice/time-entries — list with filters
 * POST /api/accounting/practice/time-entries — create
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import type { PracticeTimeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';
import {
  listPracticeEntries,
  createPracticeEntry,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { userId, practiceClientId, dateFrom, dateTo, status, jobId } = req.query;
    const result = await listPracticeEntries(companyId, {
      userId: userId as string | undefined,
      practiceClientId: practiceClientId as string | undefined,
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
      status: status as PracticeTimeEntry['status'] | undefined,
      jobId: jobId as string | undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    try {
      const entry = await createPracticeEntry(companyId, req.user.id, req.body);
      return apiResponse.created(res, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Practice time entry create failed', { error: err }, 'practice-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, (req as NextApiRequest).method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
