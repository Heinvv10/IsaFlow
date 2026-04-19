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
import {
  bulkCreateFromTemplate,
  type BulkFromTemplateInput,
} from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const body = req.body as Partial<BulkFromTemplateInput>;

  if (!body.templateId || typeof body.templateId !== 'string') {
    return apiResponse.badRequest(res, 'templateId is required');
  }
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
    });
    // 201 even when some failed — the UI shows the partial summary
    return res.status(201).json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Bulk create failed';
    log.error('Practice bulk create from template failed', { error: err }, 'practice-api');
    return apiResponse.badRequest(res, msg);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
