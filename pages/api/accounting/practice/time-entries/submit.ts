/**
 * Practice Time Entries Submit API
 * POST /api/accounting/practice/time-entries/submit — bulk submit draft entries
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { submitPracticeEntries } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { ids } = req.body as { ids?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return apiResponse.badRequest(res, 'ids[] is required and must be non-empty');
  }

  try {
    const count = await submitPracticeEntries(companyId, ids as string[]);
    return apiResponse.success(res, { count });
  } catch (err) {
    log.error('Practice time entries submit failed', { error: err }, 'practice-api');
    return apiResponse.badRequestFromError(res, err, 'Submit failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
