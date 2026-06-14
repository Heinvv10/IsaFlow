/**
 * Practice Time Entry by ID API
 * GET    /api/accounting/practice/time-entries/[id] — get single entry
 * PUT    /api/accounting/practice/time-entries/[id] — update entry
 * DELETE /api/accounting/practice/time-entries/[id] — delete entry
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getPracticeEntry,
  updatePracticeEntry,
  deletePracticeEntry,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'id is required');

  if (req.method === 'GET') {
    const entry = await getPracticeEntry(companyId, id);
    if (!entry) return apiResponse.notFound(res, 'Time entry not found');
    return apiResponse.success(res, entry);
  }

  if (req.method === 'PUT') {
    try {
      const entry = await updatePracticeEntry(companyId, id, req.body);
      return apiResponse.success(res, entry);
    } catch (err) {
      log.error('Practice time entry update failed', { error: err, id }, 'practice-api');
      return apiResponse.badRequestFromError(res, err, 'Update failed');
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deletePracticeEntry(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Practice time entry delete failed', { error: err, id }, 'practice-api');
      return apiResponse.badRequestFromError(res, err, 'Delete failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
