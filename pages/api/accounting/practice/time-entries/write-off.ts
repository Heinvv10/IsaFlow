/**
 * Practice Time Entries Write-Off API
 * POST /api/accounting/practice/time-entries/write-off — bulk write off submitted/approved entries
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { writeOffEntries } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { ids, reason } = req.body as { ids?: unknown; reason?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return apiResponse.badRequest(res, 'ids[] is required and must be non-empty');
  }

  if (typeof reason !== 'string' || !reason.trim()) {
    return apiResponse.badRequest(res, 'reason is required');
  }

  try {
    const count = await writeOffEntries(companyId, ids as string[], req.user.id, reason);
    return apiResponse.success(res, { count });
  } catch (err) {
    log.error('Practice time entries write-off failed', { error: err }, 'practice-api');
    return apiResponse.badRequestFromError(res, err, 'Write-off failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
