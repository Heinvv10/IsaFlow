/**
 * Practice Time Entries Bulk Create API
 * POST /api/accounting/practice/time-entries/bulk — fill a date range from a saved template
 */

import type { NextApiResponse } from 'next';
import {
  withAuth,
  type CompanyAuthedRequest,
  type AuthenticatedNextApiRequest,
  withWriteAccess,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { isJobFenceRefusal } from '@/modules/accounting/services/practice/practiceClientFence';
import { PracticeEntryRefusal } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';
import { hasNul, isJsonObjectBody, isUuidParam, NUL_MESSAGE } from '@/lib/validation';
import {
  bulkCreateFromTemplate,
  type BulkFromTemplateInput,
} from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  if (!isJsonObjectBody(req.body)) return apiResponse.badRequest(res, 'Request body must be a JSON object');
  const body = req.body as Partial<BulkFromTemplateInput>;

  if (!body.templateId || typeof body.templateId !== 'string') {
    return apiResponse.badRequest(res, 'templateId is required');
  }
  // The template read casts ::UUID with no savepoint: a malformed id would be a 22P02 → 500.
  if (!isUuidParam(body.templateId)) return apiResponse.badRequest(res, 'templateId must be a UUID');
  if (body.weekdays !== undefined && !(Array.isArray(body.weekdays)
    && body.weekdays.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))) {
    return apiResponse.badRequest(res, 'weekdays must be an array of whole numbers from 0 (Sunday) to 6 (Saturday)');
  }
  // Postgres text cannot hold a NUL (22021): refused here, since bulk treats any database error as a fault.
  if (hasNul(body.taskOverride)) return apiResponse.badRequest(res, NUL_MESSAGE);
  if (!body.dateFrom || typeof body.dateFrom !== 'string') {
    return apiResponse.badRequest(res, 'dateFrom is required (YYYY-MM-DD)');
  }
  if (!body.dateTo || typeof body.dateTo !== 'string') {
    return apiResponse.badRequest(res, 'dateTo is required (YYYY-MM-DD)');
  }

  try {
    const result = await bulkCreateFromTemplate(companyId, req.user.id, {
      templateId: body.templateId,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      weekdays: body.weekdays,
      hoursOverride: body.hoursOverride,
      taskOverride: body.taskOverride,
      jobId: body.jobId,
    });
    // 201 even when some failed — the UI shows the partial summary
    return res.status(201).json({ data: result });
  } catch (err) {
    if (isJobFenceRefusal(err) || err instanceof PracticeEntryRefusal) {
      log.warn('Practice bulk create refused', { message: err.message }, 'practice-api');
      return apiResponse.badRequest(res, err.message);
    }
    // A server fault: re-thrown so withErrorHandler answers 500 and withAuth rolls back
    // the dates already written. A 4xx here would COMMIT them.
    log.error('Practice bulk create from template failed', { error: err }, 'practice-api');
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
