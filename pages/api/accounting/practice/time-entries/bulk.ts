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
import { hasNul, isJsonObjectBody, isRealCalendarDate, isUuidParam, NUL_MESSAGE } from '@/lib/validation';
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
  // A real calendar date, not just a string: '2026-13-45' split to NaN gave an empty range and a quiet 201.
  if (typeof body.dateFrom !== 'string' || !isRealCalendarDate(body.dateFrom)) {
    return apiResponse.badRequest(res, 'dateFrom is required (YYYY-MM-DD)');
  }
  if (typeof body.dateTo !== 'string' || !isRealCalendarDate(body.dateTo)) {
    return apiResponse.badRequest(res, 'dateTo is required (YYYY-MM-DD)');
  }
  // The range is built with Date.UTC, which maps years 0-99 to 1900-1999: '0050-01-05' filled 1950.
  if (Number(body.dateFrom.slice(0, 4)) < 1900 || Number(body.dateTo.slice(0, 4)) < 1900) {
    return apiResponse.badRequest(res, 'dateFrom and dateTo must be in or after 1900');
  }
  // `true` used to be read as 1 hour. The form sends a number.
  if (body.hoursOverride != null && (typeof body.hoursOverride !== 'number' || !Number.isFinite(body.hoursOverride))) {
    return apiResponse.badRequest(res, 'hoursOverride must be a number');
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
